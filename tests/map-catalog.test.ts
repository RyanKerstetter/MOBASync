import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { isMapId } from '../apps/server/src/map.ts'
import { MapCatalog } from '../apps/server/src/maps.ts'
import { DEFAULT_MAP_ID } from '../packages/shared/src/index.ts'

// The maps the server has: every map in the folder, with what it can be played for, kept up to date as the files change.

type TiledJson = {
  properties?: Array<{ name: string; type: string; value: unknown }>
  layers: Array<{ objects?: Array<{ type?: string; class?: string; properties?: Array<{ name: string; value: unknown }> }> }>
}
const REAL = JSON.parse(readFileSync(new URL('../res/maps/ffa_arena.tmj', import.meta.url), 'utf-8')) as TiledJson
const classOf = (object: { type?: string; class?: string }): string | undefined => object.class ?? object.type
const clone = (): TiledJson => JSON.parse(JSON.stringify(REAL)) as TiledJson

// A copy of the real map with some of its objects taken out, and a title given.
function variant(keep: (object: TiledJson['layers'][number]['objects'] extends Array<infer O> | undefined ? O : never) => boolean, title?: string): TiledJson {
  const map = clone()
  for (const layer of map.layers) layer.objects = layer.objects?.filter(keep)
  if (title) map.properties = [{ name: 'title', type: 'string', value: title }, { name: 'description', type: 'string', value: `About ${title}.` }]
  return map
}
const slotOf = (object: { properties?: Array<{ name: string; value: unknown }> }): number =>
  Number(object.properties?.find((property) => property.name === 'team-name')?.value)

// The first two teams only, with no hill and no flags.
const duel = (): TiledJson => variant((object) => {
  const kind = classOf(object)
  if (kind === 'hill' || kind === 'ctf-flag') return false
  return kind !== 'spawn' || slotOf(object) <= 2
}, 'Duel')
// Everything the real map has, but the hill.
const noHill = (): TiledJson => variant((object) => classOf(object) !== 'hill', 'Plain Field')

function folder(files: Record<string, unknown>): { directory: URL; path: string; write: (name: string, content: unknown) => void; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'catalog-'))
  const write = (name: string, content: unknown): void => writeFileSync(join(path, name), typeof content === 'string' ? content : JSON.stringify(content))
  for (const [name, content] of Object.entries(files)) write(name, content)
  return { directory: pathToFileURL(`${path}/`), path, write, remove: () => rmSync(path, { recursive: true, force: true }) }
}

test('every map in the folder is listed, with its name, size, room, and what it has for the modes', () => {
  const maps = folder({ 'ffa_arena.tmj': REAL, 'duel.tmj': duel(), 'plain_field.tmj': noHill() })
  try {
    const list = new MapCatalog(maps.directory).list({ fresh: true })
    assert.deepEqual(list.map((map) => map.id), ['duel', 'ffa_arena', 'plain_field'], 'by name')
    const [duelMap, real, plain] = list
    assert.deepEqual([duelMap.name, duelMap.description, duelMap.spawns, duelMap.hill, duelMap.flags], ['Duel', 'About Duel.', [4, 4], false, false])
    assert.deepEqual([real.name, real.spawns, real.hill, real.flags], ['Ffa Arena', [4, 4, 2, 2, 1, 1, 1, 1], true, true])
    assert.ok(real.width > 0 && real.height > 0)
    assert.deepEqual([plain.name, plain.hill, plain.flags], ['Plain Field', false, true])
    for (const map of list) assert.equal(map.problem, undefined)
  } finally {
    maps.remove()
  }
})

test('a map that cannot be played on is listed with what is wrong, and a file that is not a map is not listed', () => {
  const noArena = variant((object) => classOf(object) !== 'arena')
  const maps = folder({
    'ffa_arena.tmj': REAL,
    'broken.tmj': noArena,
    'garbled.tmj': '{ this is not json',
    'tileset.json': { name: 'tiles', tilewidth: 16, tileheight: 16 },
    'notes.txt': 'not a map',
    'with space.tmj': REAL,
  })
  try {
    const list = new MapCatalog(maps.directory).list({ fresh: true })
    assert.deepEqual(list.map((map) => map.id), ['broken', 'ffa_arena', 'garbled'])
    const broken = list.find((map) => map.id === 'broken')
    assert.match(broken?.problem ?? '', /no object of class "arena"/)
    assert.deepEqual([broken?.spawns, broken?.hill, broken?.flags], [[], false, false])
    assert.ok(list.find((map) => map.id === 'garbled')?.problem, 'a file that is not JSON is listed as one that cannot be played on')
    assert.equal(list.find((map) => map.id === 'ffa_arena')?.problem, undefined)
  } finally {
    maps.remove()
  }
})

test('a map saved as .json is a map, and when the same map is both it is read from the .tmj', () => {
  const asJson = duel()
  const maps = folder({ 'only_json.json': asJson, 'both.tmj': REAL, 'both.json': duel() })
  try {
    const list = new MapCatalog(maps.directory).list({ fresh: true })
    assert.deepEqual(list.map((map) => map.id), ['both', 'only_json'])
    assert.deepEqual(list.find((map) => map.id === 'both')?.spawns, [4, 4, 2, 2, 1, 1, 1, 1], 'the .tmj, which is the whole map')
    assert.deepEqual(list.find((map) => map.id === 'only_json')?.spawns, [4, 4])
  } finally {
    maps.remove()
  }
})

test('the map a lobby starts on is the default if it can be played on, or else the first that can', () => {
  const both = folder({ 'ffa_arena.tmj': REAL, 'a_map.tmj': duel() })
  const noDefault = folder({ 'zeta.tmj': duel(), 'alpha.tmj': noHill(), 'broken.tmj': '{' })
  const none = folder({ 'broken.tmj': '{' })
  const brokenDefault = folder({ 'ffa_arena.tmj': '{', 'other.tmj': duel() })
  const empty = folder({})
  try {
    assert.equal(DEFAULT_MAP_ID, 'ffa_arena')
    assert.equal(new MapCatalog(both.directory).defaultMapId(), 'ffa_arena')
    assert.equal(new MapCatalog(noDefault.directory).defaultMapId(), 'zeta', 'the first by name, which here is Duel')
    assert.equal(new MapCatalog(brokenDefault.directory).defaultMapId(), 'other', 'the default is passed over when it is broken')
    assert.equal(new MapCatalog(none.directory).defaultMapId(), undefined)
    assert.equal(new MapCatalog(empty.directory).defaultMapId(), undefined)
    assert.deepEqual(new MapCatalog(new URL('./no-such-folder/', empty.directory)).list(), [], 'a folder that is not there has no maps')
  } finally {
    for (const maps of [both, noDefault, none, brokenDefault, empty]) maps.remove()
  }
})

test('the list follows the files: a map that changes is read again, one that goes is dropped, and one that comes is added', () => {
  const maps = folder({ 'ffa_arena.tmj': REAL })
  try {
    const catalog = new MapCatalog(maps.directory)
    assert.deepEqual(catalog.list({ fresh: true }).map((map) => map.id), ['ffa_arena'])

    maps.write('duel.tmj', duel())
    assert.deepEqual(catalog.list({ fresh: true }).map((map) => map.id), ['duel', 'ffa_arena'])
    assert.deepEqual(catalog.get('duel')?.spawns, [4, 4])

    // Saved again with more room: the same file name, a new size and time.
    const bigger = variant((object) => classOf(object) !== 'hill' && classOf(object) !== 'ctf-flag', 'Duel Plus')
    maps.write('duel.tmj', bigger)
    assert.deepEqual([catalog.get('duel', { fresh: true })?.name, catalog.get('duel')?.spawns.length], ['Duel Plus', 8])

    unlinkSync(join(maps.path, 'duel.tmj'))
    assert.deepEqual(catalog.list({ fresh: true }).map((map) => map.id), ['ffa_arena'])
    assert.equal(catalog.get('duel'), undefined)

    // A map that is saved with a mistake is listed with it, and listed as a map again when it is put right.
    maps.write('duel.tmj', '{')
    assert.ok(catalog.get('duel', { fresh: true })?.problem)
    maps.write('duel.tmj', duel())
    assert.equal(catalog.get('duel', { fresh: true })?.problem, undefined)
  } finally {
    maps.remove()
  }
})

test('the folder is only looked at once in a while, since every player asks for the list every poll', () => {
  const maps = folder({ 'ffa_arena.tmj': REAL })
  try {
    let clock = 1_000_000
    const catalog = new MapCatalog(maps.directory, () => clock)
    assert.equal(catalog.list().length, 1)
    maps.write('duel.tmj', duel())
    clock += 500
    assert.equal(catalog.list().length, 1, 'not looked at again yet')
    clock += 600
    assert.equal(catalog.list().length, 2, 'looked at again')
    maps.write('third.tmj', noHill())
    assert.equal(catalog.list().length, 2)
    assert.equal(catalog.list({ fresh: true }).length, 3, 'unless it is asked for fresh')
  } finally {
    maps.remove()
  }
})

test('a map is picked by an id of letters, digits, underscores and dashes, which cannot be a path', () => {
  for (const good of ['ffa_arena', 'duel-1v1', 'A', 'x'.repeat(100)]) assert.equal(isMapId(good), true, good)
  for (const bad of ['', '..', '../secret', 'a/b', 'a\\b', 'with space', 'dot.ext', 'x'.repeat(101), undefined, 7, null]) {
    assert.equal(isMapId(bad), false, String(bad))
  }
})
