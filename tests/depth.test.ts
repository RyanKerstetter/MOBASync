import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  characterDepth,
  DEPTH_PROPERTY,
  groupByDepth,
  ATTACH_PROPERTY,
  attachTiles,
  isDepthSorted,
  rowDepth,
  WALL_ATTACH_TILES,
  WALL_SIDE_TILES,
  type TileGrid,
} from '../apps/client/src/render/depth.ts'
import { flattenLayers, parseTiledMap, readMapLayout, tileLayerCells, type Rect, type TileLayer } from '../packages/shared/src/index.ts'

const layer = (name: string, value?: unknown): Pick<TileLayer, 'name' | 'properties'> => ({
  name,
  ...(value === undefined ? {} : { properties: [{ name: DEPTH_PROPERTY, type: 'bool', value }] }),
})

test('the map\'s walls are drawn in depth order with the champions, and the ground under them', () => {
  for (const name of ['Wall Layer', 'walls', 'WALL', '  Wall top ']) assert.equal(isDepthSorted(layer(name)), true, name)
  for (const name of ['Floor Layer', 'paths', 'Stonewall', '']) assert.equal(isDepthSorted(layer(name)), false, name)
})

test('a layer says it for itself with the y-sort property, which beats its name, and one that is not a boolean is ignored', () => {
  assert.equal(isDepthSorted(layer('Floor Layer', true)), true, 'a tall layer of trees')
  assert.equal(isDepthSorted(layer('Wall Layer', false)), false, 'walls that are only on the ground')
  assert.equal(isDepthSorted(layer('Wall Layer', 'no')), true)
  assert.equal(isDepthSorted(layer('Floor Layer', 1)), false)
})

test('the maps of the game have their walls sorted and nothing else', () => {
  for (const id of ['competetive', 'ffa_arena', 'map_small_tdm_koth']) {
    const map = parseTiledMap(JSON.parse(readFileSync(new URL(`../res/maps/${id}.tmj`, import.meta.url), 'utf-8')))
    const tileLayers = flattenLayers(map.layers).map(({ layer: placed }) => placed).filter((placed): placed is TileLayer => placed.type === 'tilelayer')
    assert.deepEqual(tileLayers.filter(isDepthSorted).map((sorted) => sorted.name), ['Wall Layer'], id)
    assert.ok(tileLayers.some((ground) => ground.name === 'Floor Layer' && !isDepthSorted(ground)), `${id}'s floor is under everything`)
  }
})

test('how far from a wall\'s own art its attached art goes is a tile, unless the layer says another, which is a whole number', () => {
  const withAttach = (value: unknown): Pick<TileLayer, 'properties'> => ({ properties: [{ name: ATTACH_PROPERTY, type: 'int', value }] })
  assert.equal(WALL_ATTACH_TILES, 1)
  assert.equal(WALL_SIDE_TILES, 1)
  assert.equal(attachTiles({}), 1, 'nothing said')
  assert.equal(attachTiles(withAttach(2)), 2)
  assert.equal(attachTiles(withAttach(0)), 0, 'none at all is a choice')
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', true]) assert.equal(attachTiles(withAttach(bad)), 1, `${String(bad)} is ignored`)
})

// ---------------------------------------------------------------------------- what a wall's art is

// Tiles of 16 pixels drawn at 3 units are 48 across, from the arena's corner, which is the map's (0, 0).
const GRID: TileGrid = { tileWidth: 16, tileHeight: 16, offsetX: 0, offsetY: 0, arenaX: 0, arenaY: 0, scale: 3 }
// A wall 2 tiles by 2 whose top left is at tile (2, 2): from 96 to 192 each way, so its base is 192.
const WALL: Rect = { x: 96, y: 96, width: 96, height: 96 }
const cell = (col: number, row: number) => ({ col, row })
const keys = (cells: ReadonlyArray<{ col: number; row: number }>): string[] => cells.map((c) => `${c.col},${c.row}`).sort()

test('all of a wall\'s art has the depth of its base: what is on it, what sticks up from it, and what sticks out of its sides', () => {
  // On it (2,2 and 3,2, 3,3), a tile to either side (1,2 and 4,3), and above it (2,1, 3,1), which touches the tiles that are on it.
  const art = [cell(2, 2), cell(3, 2), cell(3, 3), cell(1, 2), cell(4, 3), cell(2, 1), cell(3, 1)]
  const groups = groupByDepth(art, GRID, [WALL])
  assert.equal(groups.length, 1, 'one wall, one group')
  assert.equal(groups[0].depth, 192, 'the bottom of its rectangle')
  assert.equal(groups[0].wall, 0)
  assert.deepEqual(keys(groups[0].cells), keys(art))
})

test('art that sticks off a wall without overlapping its rectangle is the wall\'s through the art it touches, and is drawn over a champion behind the wall as it is', () => {
  // The wall\'s rectangle is from 120 down to 192, and the bits are a whole row (48 units) above its first row of art, so
  // that their top is 72 above the rectangle\'s top: nothing of them is over the rectangle, or close to it.
  const wall: Rect = { x: 96, y: 120, width: 96, height: 72 }
  const art = [cell(2, 2), cell(2, 3), cell(2, 1), cell(1, 1), cell(3, 1)] // the bits: (2,1) on top of it and (1,1), (3,1) at its corners
  const groups = groupByDepth(art, GRID, [wall])
  assert.deepEqual(groups.map((group) => [group.depth, group.wall, keys(group.cells)]), [[192, 0, keys(art)]], 'all of it has the base')
  // So a champion against the north of the wall, whose middle is 20 above its top, is behind the wall and behind the bits.
  assert.ok(characterDepth({ y: 120 - 20 }) < groups[0].depth)
  // With none attached, the bits are ordered by their row, which ends at 96, and a champion up there was over them.
  const alone = groupByDepth(art, GRID, [wall], { attachTiles: 0 })
  assert.deepEqual(alone.map((group) => [group.depth, group.wall, keys(group.cells)]), [
    [96, undefined, ['1,1', '2,1', '3,1']],
    [192, 0, ['2,2', '2,3']],
  ])
  assert.ok(characterDepth({ y: 120 - 20 }) > alone[0].depth, 'which is the champion over the spikes and behind the rest, that was seen')
})

test('what is in front of a wall, far to a side of it, or not touching its art is not its art, and goes by its own row', () => {
  const groups = groupByDepth([cell(2, 2), cell(2, 4), cell(5, 2), cell(2, 0), cell(3, 4)], GRID, [WALL])
  assert.deepEqual(groups.map((group) => [group.depth, group.wall, keys(group.cells)]), [
    [48, undefined, ['2,0']], // a tile between it and the wall\'s art: not touching it
    [144, undefined, ['5,2']], // two tiles to the side
    [192, 0, ['2,2']],
    [240, undefined, ['2,4', '3,4']], // starts at its base: in front of it, in the row that ends at 240
  ])
  for (const group of groups.filter((g) => g.wall === undefined)) {
    const row = group.cells[0].row
    assert.equal(group.depth, rowDepth(row, 16, 0, 0, 3), 'a row ends at its own bottom edge')
  }
})

test('art touching the wall\'s art is attached to it, and art touching that is only attached if the layer says it goes that far', () => {
  const stack = [cell(2, 2), cell(2, 1), cell(2, 0), cell(2, -1)] // the wall\'s own, and three tiles in a column above it
  const where = (tiles: number) => groupByDepth(stack, GRID, [WALL], { attachTiles: tiles }).map((group) => [group.wall, keys(group.cells)])
  assert.deepEqual(where(0), [[undefined, ['2,-1']], [undefined, ['2,0']], [undefined, ['2,1']], [0, ['2,2']]], 'none: only its own')
  assert.deepEqual(where(1), [[undefined, ['2,-1']], [undefined, ['2,0']], [0, ['2,1', '2,2']]], 'the one touching it')
  assert.deepEqual(where(2), [[undefined, ['2,-1']], [0, ['2,0', '2,1', '2,2']]])
  assert.deepEqual(where(1.5), where(1), 'a part of a tile is a whole one fewer')
  assert.deepEqual(where(3), [[0, ['2,-1', '2,0', '2,1', '2,2']]])
})

test('art in front of a wall is not attached to it, and the art of two walls is not taken by one of them', () => {
  // Below the wall: touching the last row of its art, but starting at its base.
  const front = groupByDepth([cell(2, 2), cell(2, 3), cell(2, 4)], GRID, [WALL], { attachTiles: 3 })
  assert.deepEqual(front.map((group) => [group.depth, group.wall, keys(group.cells)]), [[192, 0, ['2,2', '2,3']], [240, undefined, ['2,4']]])
  // Between two walls: (2, 3) is above the lower one, and touches the lower one\'s art only once (2, 4) is, a step later.
  const above: Rect = { x: 96, y: 48, width: 96, height: 96 } // rows 1 and 2, base 144
  const below: Rect = { x: 96, y: 240, width: 96, height: 48 } // row 5, base 288
  const between = groupByDepth([cell(2, 1), cell(2, 2), cell(2, 3), cell(2, 4), cell(2, 5)], GRID, [above, below], { attachTiles: 1 })
  assert.deepEqual(between.map((group) => [group.depth, group.wall, keys(group.cells)]), [
    [144, 0, ['2,1', '2,2']],
    [192, undefined, ['2,3']],
    [288, 1, ['2,4', '2,5']],
  ])
})

test('a wall whose edges are not on the lines of the tiles has the lip of its art, below the base, at its base and not at the line', () => {
  // The base is 168, in the middle of the row of tiles that ends at 192, so that row's art hangs 24 below the rectangle.
  const offset: Rect = { x: 96, y: 96, width: 96, height: 72 }
  const groups = groupByDepth([cell(2, 3), cell(3, 3), cell(2, 4)], GRID, [offset])
  assert.deepEqual(groups.map((group) => [group.depth, group.wall, keys(group.cells)]), [
    [168, 0, ['2,3', '3,3']],
    [240, undefined, ['2,4']],
  ])
  // The way it was, by the row: 192, which is above where a champion stands against the south of the wall (168 and its
  // radius), so the wall was drawn over it.
  const radius = 20
  const flush = characterDepth({ y: 168 + radius })
  assert.ok(flush > groups[0].depth, 'a champion against the south of the wall is in front of all of it, lip and all')
  assert.ok(flush < rowDepth(3, 16, 0, 0, 3), 'and was behind it, by the row')
  assert.ok(characterDepth({ y: 96 - radius }) < groups[0].depth, 'and one against the north of it is behind it')
})

test('a cell is the art of the wall it is over before one it is only beside, and of the one with the higher base when they are alike', () => {
  const beside: Rect = { x: 192, y: 96, width: 96, height: 48 } // next to the wall, with a base of 144
  const over = groupByDepth([cell(3, 2)], GRID, [beside, WALL])
  assert.deepEqual([over[0].wall, over[0].depth], [1, 192], '(3, 2) is over the big wall and only beside the other')
  const inside: Rect = { x: 96, y: 96, width: 96, height: 48 } // in the wall: both are over it
  const both = groupByDepth([cell(2, 2)], GRID, [WALL, inside])
  assert.deepEqual([both[0].wall, both[0].depth], [1, 144], 'the higher base of the two')
})

test('the lip of a wall\'s art beside a wall that hangs from it is the first wall\'s, and is not drawn over a champion standing in front of it', () => {
  // A wide wall (x 96 to 288, base 120), and a narrow one hanging from its middle (x 192 to 240, from 120 down to 240). The row of
  // art from 96 to 144 is the wide wall's lip, since its base is 120, and a tile of it either side of the narrow wall is beside that
  // wall and in its height, but it is the wide wall's art: the narrow one's base of 240 would put it over a champion at the wide wall's south.
  const wide: Rect = { x: 96, y: 48, width: 192, height: 72 }
  const narrow: Rect = { x: 192, y: 120, width: 48, height: 120 }
  const lip = [cell(2, 2), cell(3, 2), cell(4, 2), cell(5, 2), cell(6, 2)] // x 96 to 144, 144 to 192, 192 to 240 (on the narrow wall), 240 to 288, 288 to 336
  const groups = groupByDepth(lip, GRID, [wide, narrow])
  const depthOf = (col: number): number | undefined => groups.find((group) => group.cells.some((c) => c.col === col))?.depth
  assert.equal(depthOf(2), 120, 'over the wide wall')
  assert.equal(depthOf(3), 120, 'beside the narrow one, and not given its base')
  assert.equal(depthOf(4), 240, 'but on the narrow wall, it is its own')
  assert.equal(depthOf(5), 120, 'and the same on its other side')
  // A champion at the south of the wide wall, beside the narrow one, is in front of its lip.
  assert.ok(characterDepth({ y: 120 + 20 }) > (depthOf(3) as number), 'in front of the lip beside the narrow wall')
  assert.ok(characterDepth({ y: 120 + 20 }) < (depthOf(4) as number), 'and behind the narrow wall\'s art, which it is next to')
})

test('with no walls every cell goes by its row, as before', () => {
  const groups = groupByDepth([cell(3, 5), cell(1, 5), cell(2, 2)], GRID, [])
  assert.deepEqual(groups.map((group) => [group.depth, group.wall, keys(group.cells)]), [[144, undefined, ['2,2']], [288, undefined, ['1,5', '3,5']]])
})

test('cells are found in the world from the arena\'s corner and the layer\'s offset, in the map\'s pixels', () => {
  // The arena\'s corner is at pixel (16, 32), so tile (1, 2) is at the world\'s origin, and the layer is moved down 8 pixels.
  const moved: TileGrid = { ...GRID, arenaX: 16, arenaY: 32, offsetY: 8 }
  const there: Rect = { x: 0, y: 24, width: 48, height: 48 } // 24 units is the 8 pixels
  const groups = groupByDepth([cell(1, 2), cell(9, 9)], moved, [there])
  assert.deepEqual(groups.map((group) => [group.depth, group.wall, keys(group.cells)]), [
    [72, 0, ['1,2']],
    [rowDepth(9, 16, 8, 32, 3), undefined, ['9,9']],
  ])
})

test('every cell is in one group, whatever the walls are', () => {
  const art = Array.from({ length: 60 }, (_, index) => cell(index % 10, Math.floor(index / 10)))
  const groups = groupByDepth(art, GRID, [WALL, { x: 0, y: 200, width: 300, height: 40 }, { x: 250, y: 0, width: 40, height: 140 }])
  assert.deepEqual(keys(groups.flatMap((group) => group.cells)), keys(art))
  for (let index = 1; index < groups.length; index += 1) assert.ok(groups[index].depth >= groups[index - 1].depth, 'from the back')
})

// ---------------------------------------------------------------------------- the competitive map

const MAP = parseTiledMap(JSON.parse(readFileSync(new URL('../res/maps/competetive.tmj', import.meta.url), 'utf-8')))
const LAYOUT = readMapLayout(MAP)
const WALL_LAYER = MAP.layers.find((candidate): candidate is TileLayer => candidate.type === 'tilelayer' && candidate.name === 'Wall Layer')
const MAP_GRID: TileGrid = {
  tileWidth: MAP.tilewidth,
  tileHeight: MAP.tileheight,
  offsetX: 0,
  offsetY: 0,
  arenaX: LAYOUT.arenaRect.x,
  arenaY: LAYOUT.arenaRect.y,
  scale: 3,
}

test('on the competitive map each wall\'s art is at the base of its rectangle, and most of the art is some wall\'s', () => {
  assert.ok(WALL_LAYER, 'it has a wall layer')
  const { cells } = tileLayerCells(WALL_LAYER, MAP)
  const walls = LAYOUT.terrain.walls
  const groups = groupByDepth(cells, MAP_GRID, walls)
  assert.deepEqual(keys(groups.flatMap((group) => group.cells)), keys(cells), 'every tile is in one group')
  const ofWalls = groups.filter((group) => group.wall !== undefined)
  assert.ok(ofWalls.length > 10, `many walls have art (${ofWalls.length})`)
  const assigned = ofWalls.reduce((total, group) => total + group.cells.length, 0)
  assert.ok(assigned > cells.length / 2, `most tiles are a wall\'s (${assigned} of ${cells.length})`)
  for (const group of ofWalls) {
    const wall = walls[group.wall as number]
    assert.equal(group.depth, wall.y + wall.height, 'the depth is the base of the rectangle, to the unit')
  }
})

test('on the competitive map no tile is given to a wall it is only beside when it is over the columns of another', () => {
  const { cells } = tileLayerCells(WALL_LAYER as TileLayer, MAP)
  const walls = LAYOUT.terrain.walls
  const owners = new Map<string, number>()
  for (const group of groupByDepth(cells, MAP_GRID, walls)) {
    if (group.wall !== undefined) for (const c of group.cells) owners.set(`${c.col},${c.row}`, group.wall)
  }
  const size = MAP_GRID.tileWidth * MAP_GRID.scale
  let checked = 0
  for (const c of cells) {
    const owner = owners.get(`${c.col},${c.row}`)
    if (owner === undefined) continue
    const left = (c.col * MAP_GRID.tileWidth - MAP_GRID.arenaX) * MAP_GRID.scale
    const top = (c.row * MAP_GRID.tileHeight - MAP_GRID.arenaY) * MAP_GRID.scale
    const over = (wall: Rect): boolean => left < wall.x + wall.width && left + size > wall.x
    // Over another's columns and reaching its height: the cell is art of that one, or of another it is over, and not of one it is beside.
    const reaches = walls.some((wall) => over(wall) && top < wall.y + wall.height && top + size > wall.y)
    if (reaches) {
      assert.ok(over(walls[owner]), `tile ${c.col},${c.row} (x ${left}, y ${top}) is only beside wall ${owner} but over another`)
      checked += 1
    }
  }
  assert.ok(checked > 100, `many tiles checked (${checked})`)
})

test('on the competitive map a champion against the south of any wall is in front of all of its art, and one against the north is behind it', () => {
  const { cells } = tileLayerCells(WALL_LAYER as TileLayer, MAP)
  const walls = LAYOUT.terrain.walls
  const radius = 20
  let checked = 0
  for (const group of groupByDepth(cells, MAP_GRID, walls).filter((candidate) => candidate.wall !== undefined)) {
    const wall = walls[group.wall as number]
    assert.ok(characterDepth({ y: wall.y + wall.height + radius }) > group.depth, `in front of the wall at ${wall.x}, ${wall.y}`)
    assert.ok(characterDepth({ y: wall.y - radius }) < group.depth, `behind the wall at ${wall.x}, ${wall.y}`)
    checked += 1
  }
  assert.ok(checked > 10)
})

test('on the competitive map the art that sticks off the walls is theirs, more of it the further the layer says, and never more than there is', () => {
  const { cells } = tileLayerCells(WALL_LAYER as TileLayer, MAP)
  const walls = LAYOUT.terrain.walls
  const count = (tiles: number): number => groupByDepth(cells, MAP_GRID, walls, { attachTiles: tiles })
    .filter((group) => group.wall !== undefined)
    .reduce((total, group) => total + group.cells.length, 0)
  const steps = [0, 1, 2, 3, 5]
  const taken = steps.map(count)
  for (let index = 1; index < taken.length; index += 1) {
    assert.ok(taken[index] >= taken[index - 1], `attaching ${steps[index]} takes no less than ${steps[index - 1]} (${taken.join(', ')})`)
  }
  assert.ok(taken[1] > taken[0], `a tile of it is more than the walls' own, as bits stick off them (${taken[0]}, then ${taken[1]})`)
  assert.ok(taken[1] > cells.length / 2, `and most of the art is a wall's with that (${taken[1]} of ${cells.length})`)
  assert.ok(Math.max(...taken) <= cells.length)
})

// ---------------------------------------------------------------------------- the order

test('a row\'s depth is where its bottom edge is in the world, from the arena\'s corner', () => {
  // The competitive map: 16 pixel tiles drawn at 3 world units, an arena whose top is at -458 (which is not on a tile line).
  assert.equal(rowDepth(-28, 16, 0, -458, 3), 78, 'row -28 ends at -432, 26 pixels below the arena\'s top')
  assert.equal(rowDepth(-30, 16, 0, -458, 3), -18, 'and one above the arena is above it')
  assert.equal(rowDepth(-28, 16, 8, -458, 3), 78 + 24, 'a layer moved down 8 pixels is 24 units deeper')
  assert.equal(rowDepth(-28, 16, 0, -458, 1.5), 39, 'and the scale is the map\'s')
  assert.equal(rowDepth(0, 16, 0, 0, 3), 48, 'a map from the top left: row 0 ends one tile down')
})

test('a champion is behind what is deeper than where it stands and in front of what is not, so one can pass behind a wall or in front', () => {
  const champion = (name: string, y: number) => ({ name, depth: characterDepth({ y }) })
  const wall = { name: 'wall', depth: 192 }
  const row = { name: 'a row of art that is nobody\'s', depth: 48 }
  // Drawn from the smallest depth up, as the render layer does: the art first, which is also the order it is attached in,
  // so a champion level with something is drawn over it.
  const drawn = (...things: Array<{ name: string; depth: number }>) => [...things].sort((a, b) => a.depth - b.depth).map((thing) => thing.name)
  assert.deepEqual(drawn(wall, row, champion('behind the wall', 150)), ['a row of art that is nobody\'s', 'behind the wall', 'wall'])
  assert.deepEqual(drawn(wall, row, champion('in front of it', 230)), ['a row of art that is nobody\'s', 'wall', 'in front of it'])
  assert.deepEqual(drawn(wall, row, champion('level', 192)), ['a row of art that is nobody\'s', 'wall', 'level'], 'level, it is in front')
  assert.deepEqual(drawn(wall, row, champion('well behind', 10))[0], 'well behind', 'and one far behind is under all of it')
  assert.equal(characterDepth({ y: 321.5 }), 321.5, 'a champion\'s depth is where it stands')
})
