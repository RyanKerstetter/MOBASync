import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { loadMapLayout } from '../apps/server/src/map.ts'

// The game's own map, as Tiled saved it, which each test changes a copy of.
const REAL = JSON.parse(readFileSync(new URL('../res/maps/ffa_arena.tmj', import.meta.url), 'utf-8')) as {
  layers: Array<{ objects?: Array<{ type?: string; class?: string; width?: number; x: number }> }>
}

const classOf = (object: { type?: string; class?: string }): string | undefined => object.class ?? object.type
const objectsOf = (map: typeof REAL) => map.layers.flatMap((layer) => layer.objects ?? [])

// Puts a map in a folder of its own, and gives back the folder and a way to remove it.
function folderWith(map: unknown, file = 'ffa_arena.tmj'): { directory: URL; path: string; write: (map: unknown) => void; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'maps-'))
  const write = (content: unknown): void => writeFileSync(join(path, file), typeof content === 'string' ? content : JSON.stringify(content))
  write(map)
  return { directory: pathToFileURL(`${path}/`), path, write, remove: () => rmSync(path, { recursive: true, force: true }) }
}

test('the game\'s own map is read from res/maps', () => {
  const layout = loadMapLayout('ffa_arena')
  assert.ok(layout.terrain.walls.length > 0)
  assert.equal(layout.spawns.length, 8)
})

test('the map is read from the file each time it is asked for, so one changed since the last read is the one given', () => {
  const folder = folderWith(REAL)
  try {
    const before = loadMapLayout('ffa_arena', folder.directory)
    assert.deepEqual(before.terrain.toData(), loadMapLayout('ffa_arena').terrain.toData(), 'a copy of the real map is the real map')

    // Widen the first wall by 10 map pixels, as an export from Tiled after moving it would.
    const changed = JSON.parse(JSON.stringify(REAL)) as typeof REAL
    const wall = objectsOf(changed).find((object) => classOf(object) === 'wall')
    assert.ok(wall?.width)
    wall.width += 10
    folder.write(changed)
    const after = loadMapLayout('ffa_arena', folder.directory)
    assert.notDeepEqual(after.terrain.toData(), before.terrain.toData())
    assert.equal(after.terrain.walls.length, before.terrain.walls.length)
    const widths = (layout: typeof after) => layout.terrain.walls.map((each) => each.width).sort((a, b) => a - b)
    assert.deepEqual(widths(after).map((width, index) => width - widths(before)[index]).filter(Boolean), [30])
  } finally {
    folder.remove()
  }
})

test('a map saved as .json is found when there is no .tmj', () => {
  const folder = folderWith(REAL, 'ffa_arena.json')
  try {
    assert.ok(loadMapLayout('ffa_arena', folder.directory).terrain.walls.length > 0)
  } finally {
    folder.remove()
  }
})

test('a map that is missing, is not JSON, or cannot be played on is refused, saying where it is and what is wrong', () => {
  const folder = folderWith(REAL)
  try {
    const file = join(folder.path, 'ffa_arena.tmj')
    folder.write('{ this is not json')
    assert.throws(() => loadMapLayout('ffa_arena', folder.directory), (error: Error) => error.message.includes(file))

    const noArena = JSON.parse(JSON.stringify(REAL)) as typeof REAL
    for (const layer of noArena.layers) layer.objects = layer.objects?.filter((object) => classOf(object) !== 'arena')
    folder.write(noArena)
    assert.throws(
      () => loadMapLayout('ffa_arena', folder.directory),
      (error: Error) => error.message.includes(file) && /no object of class "arena"/.test(error.message),
    )

    rmSync(file)
    assert.throws(() => loadMapLayout('ffa_arena', folder.directory), /There is no map called ffa_arena\.tmj in /)
  } finally {
    folder.remove()
  }
})
