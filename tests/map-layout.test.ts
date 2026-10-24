import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  assignSpawns,
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_ART_SCALE,
  DEFAULT_MAP_ID,
  GAME_MAX_CHAMPION_RADIUS,
  GAME_MAX_PLAYERS,
  modeStartProblem,
  parseTiledMap,
  readMapLayout,
  spawnPointsNeeded,
  summarizeMap,
} from '../packages/shared/src/index.ts'
import { teamSizeArrangements, teamsOf } from './test-spawns.ts'

// A map made of just these objects, as Tiled would save it.
function mapWith(objects: unknown[], options: { properties?: unknown[]; layerOffset?: { x: number; y: number } } = {}): ReturnType<typeof parseTiledMap> {
  return parseTiledMap({
    orientation: 'orthogonal',
    width: 10,
    height: 10,
    tilewidth: 16,
    tileheight: 16,
    infinite: false,
    properties: options.properties,
    layers: [{
      type: 'objectgroup',
      name: 'Objects',
      ...(options.layerOffset ? { offsetx: options.layerOffset.x, offsety: options.layerOffset.y } : {}),
      objects,
    }],
    tilesets: [],
  })
}

const ARENA_AT = { x: 100, y: -200 }
const arena = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'arena',
  type: 'arena',
  ...ARENA_AT,
  width: GAME_ARENA_WIDTH / GAME_ART_SCALE,
  height: GAME_ARENA_HEIGHT / GAME_ART_SCALE,
  ...extra,
})
let nextId = 100
const spawn = (slot: unknown, number: unknown, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id: nextId++,
  name: `spawn-${String(slot)}-${String(number)}`,
  type: 'spawn',
  point: true,
  x,
  y,
  properties: [
    ...(slot === undefined ? [] : [{ name: 'team-name', type: 'int', value: slot }]),
    ...(number === undefined ? [] : [{ name: 'spawn-number', type: 'int', value: number }]),
  ],
  ...extra,
})
// A wall in map pixels from the arena's corner.
const wall = (x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}) => ({
  id: nextId++,
  name: '',
  type: 'wall',
  x: ARENA_AT.x + x,
  y: ARENA_AT.y + y,
  width,
  height,
  ...extra,
})
// Every spawn point a map needs, in the arena at map pixels (slot * 20, number * 20) from its corner.
const allSpawns = () => Array.from({ length: GAME_MAX_PLAYERS }, (_, slot) =>
  Array.from({ length: spawnPointsNeeded(slot + 1) }, (_, place) =>
    spawn(slot + 1, place + 1, ARENA_AT.x + (slot + 1) * 20, ARENA_AT.y + (place + 1) * 20))).flat()

// A hill in map pixels from the arena's corner: an ellipse unless told otherwise.
const hill = (x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}) => ({
  id: nextId++,
  name: 'koth',
  type: 'hill',
  ellipse: true,
  x: ARENA_AT.x + x,
  y: ARENA_AT.y + y,
  width,
  height,
  ...extra,
})
// A flag's base at map pixels from the arena's corner, for the slot of spawn points whose base it is.
const flag = (slot: unknown, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id: nextId++,
  name: `ctf-flag-${String(slot)}`,
  type: 'ctf-flag',
  point: true,
  x: ARENA_AT.x + x,
  y: ARENA_AT.y + y,
  properties: slot === undefined ? [] : [{ name: 'team-name', type: 'int', value: slot }],
  ...extra,
})

const problemsOf = (map: ReturnType<typeof parseTiledMap>): string => {
  try {
    readMapLayout(map)
  } catch (error) {
    return (error as Error).message
  }
  assert.fail('the map was accepted')
}

test('the arena is found, and spawn points are measured from its corner in world units', () => {
  const layout = readMapLayout(mapWith([arena(), ...allSpawns()]))
  assert.deepEqual(layout.arenaRect, { ...ARENA_AT, width: GAME_ARENA_WIDTH / 3, height: GAME_ARENA_HEIGHT / 3 })
  assert.equal(layout.spawns.length, GAME_MAX_PLAYERS)
  assert.deepEqual(layout.spawns.map((points) => points.length), [4, 4, 2, 2, 1, 1, 1, 1])
  assert.deepEqual([layout.terrain.width, layout.terrain.height], [GAME_ARENA_WIDTH, GAME_ARENA_HEIGHT])
  // Slot 3, point 2 is 60 and 40 map pixels from the corner, which is 180 and 120 once drawn at 3.
  assert.deepEqual(layout.spawns[2][1], { x: 180, y: 120 })
})

test('the map\'s world scale sets how far apart world units are, and positions are whole numbers', () => {
  const objects = [arena({ width: GAME_ARENA_WIDTH / 2, height: GAME_ARENA_HEIGHT / 2 }), ...allSpawns().map((point) => ({ ...point, x: point.x + 0.3 }))]
  const layout = readMapLayout(mapWith(objects, { properties: [{ name: 'worldScale', type: 'float', value: 2 }] }))
  // Slot 1, point 1 is 20.3 and 20 map pixels from the corner: 40.6 and 40 once drawn at 2.
  assert.deepEqual(layout.spawns[0][0], { x: 41, y: 40 })
  for (const point of layout.spawns.flat()) assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y))
})

test('the class can be written as the type, and the objects can be in any layer, with its offset', () => {
  const shifted = allSpawns().map((point) => ({ ...point, class: point.type, type: undefined, x: point.x - 50, y: point.y + 30 }))
  const map = parseTiledMap({
    orientation: 'orthogonal', width: 1, height: 1, tilewidth: 16, tileheight: 16,
    layers: [
      { type: 'objectgroup', name: 'Shapes', objects: [{ ...arena(), class: 'arena', type: undefined }] },
      { type: 'group', name: 'Group', layers: [{ type: 'objectgroup', name: 'Spawns', offsetx: 50, offsety: -30, visible: false, objects: shifted }] },
    ],
    tilesets: [],
  })
  const layout = readMapLayout(map)
  assert.deepEqual(layout.spawns[2][1], { x: 180, y: 120 })
})

test('points are taken in the order of their numbers, wherever they are in the file', () => {
  const objects = [arena(), ...allSpawns().reverse()]
  assert.deepEqual(readMapLayout(mapWith(objects)).spawns, readMapLayout(mapWith([arena(), ...allSpawns()])).spawns)
})

test('a map with no arena, or more than one, or a crooked one, is not played on', () => {
  assert.match(problemsOf(mapWith(allSpawns())), /no object of class "arena"/)
  assert.match(problemsOf(mapWith([arena(), arena({ id: 2 }), ...allSpawns()])), /2 objects of class "arena", and needs exactly one/)
  assert.match(problemsOf(mapWith([arena({ rotation: 10 }), ...allSpawns()])), /plain rectangle/)
  assert.match(problemsOf(mapWith([arena({ point: true, width: 0, height: 0 }), ...allSpawns()])), /plain rectangle/)
})

test('an arena can be any size, and the ground is that size', () => {
  const layout = readMapLayout(mapWith([arena({ width: 500, height: 300 }), ...allSpawns()]))
  assert.deepEqual([layout.terrain.width, layout.terrain.height], [1500, 900])
  const scaled = readMapLayout(mapWith([arena({ width: 500, height: 300 }), ...allSpawns()], { properties: [{ name: 'worldScale', type: 'float', value: 2 }] }))
  assert.deepEqual([scaled.terrain.width, scaled.terrain.height], [1000, 600])
})

test('walls are read in world units from the corner of the arena, and shape the ground', () => {
  const layout = readMapLayout(mapWith([arena(), ...allSpawns(), wall(600, 300, 40, 30), wall(100.2, 200.4, 50, 50)]))
  assert.deepEqual(layout.terrain.walls, [
    { x: 301, y: 601, width: 150, height: 150 },
    { x: 1800, y: 900, width: 120, height: 90 },
  ])
  // They are in the terrain: a champion cannot stand in one, and goes round.
  assert.notEqual(layout.terrain.resolve({ x: 1860, y: 945 }, 20).y, 945)
  const route = layout.terrain.path({ x: 1500, y: 945 }, { x: 2200, y: 945 }, 20)
  assert.ok(route && route.length > 1, 'and goes round')
})

test('a wall the arena does not reach is left out, and one that crosses its edge stays', () => {
  const layout = readMapLayout(mapWith([
    arena(), ...allSpawns(),
    wall(900, 100, 50, 50),
    wall(-80, 100, 50, 50),
    wall(750, 300, 100, 50),
  ]))
  assert.deepEqual(layout.terrain.walls, [{ x: 2250, y: 900, width: 300, height: 150 }])
})

test('a wall that is not a plain rectangle is not played on', () => {
  for (const crooked of [
    wall(600, 300, 40, 30, { rotation: 15 }),
    wall(600, 300, 40, 30, { polygon: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 30 }] }),
    wall(600, 300, 40, 30, { ellipse: true }),
    wall(600, 300, 0, 0, { point: true }),
    wall(600, 300, 0, 30),
  ]) {
    assert.match(problemsOf(mapWith([arena(), ...allSpawns(), crooked])), /wall object \d+ is not a plain rectangle/)
  }
})

test('a spawn point that is not right says which one and what is wrong', () => {
  const others = allSpawns().filter((point) => point.name !== 'spawn-4-2')
  const cases: Array<[unknown, RegExp]> = [
    [spawn(4, 2, 100, -200, { point: false, width: 5, height: 5 }), /spawn-4-2 is not a point/],
    [spawn(undefined, 2, 100, -200), /spawn-undefined-2 needs a team-name from 1 to 8/],
    [spawn(9, 2, 100, -200), /spawn-9-2 needs a team-name from 1 to 8/],
    [spawn('four', 2, 100, -200), /needs a team-name from 1 to 8/],
    [spawn(4, undefined, 100, -200), /spawn-4-undefined needs a spawn-number of 1 or more/],
    [spawn(4, 0, 100, -200), /needs a spawn-number of 1 or more/],
    [spawn(4, 1, 140, -140), /spawn-4-1 has the same spawn-number \(1\) as another point in slot 4/],
    [spawn(4, 2, 99, -200), /spawn-4-2 is outside the arena/],
    [spawn(4, 2, 100, -201), /spawn-4-2 is outside the arena/],
    [spawn(4, 2, 100 + GAME_ARENA_WIDTH / 3 + 1, -200), /spawn-4-2 is outside the arena/],
    [spawn(4, 2, 100, -200 + GAME_ARENA_HEIGHT / 3 + 1), /spawn-4-2 is outside the arena/],
    [spawn(4, 2, 100, -200), /spawn-4-2 is too close to a wall or the arena's edge/],
    [spawn(4, 2, 100 + (GAME_MAX_CHAMPION_RADIUS - 1) / 3, -140), /spawn-4-2 is too close to a wall or the arena's edge/],
  ]
  for (const [point, expected] of cases) assert.match(problemsOf(mapWith([arena(), ...others, point])), expected)
  // Room for the widest champion is enough.
  readMapLayout(mapWith([arena(), ...others, spawn(4, 2, 100 + GAME_MAX_CHAMPION_RADIUS / 3, -200 + GAME_MAX_CHAMPION_RADIUS / 3)]))
  readMapLayout(mapWith([arena(), ...others, spawn(4, 2, 100 + GAME_ARENA_WIDTH / 3 - GAME_MAX_CHAMPION_RADIUS / 3, -200 + GAME_ARENA_HEIGHT / 3 - GAME_MAX_CHAMPION_RADIUS / 3)]))
})

test('a map is played on with as many slots, and as many points in each, as it holds, and says what it holds', () => {
  const only = (slots: number) => allSpawns().filter((point) => (point.properties[0].value as number) <= slots)
  const trimmed = (sizes: number[]) =>
    allSpawns().filter((point) => (point.properties[1].value as number) <= (sizes[(point.properties[0].value as number) - 1] ?? 0))
  // Two slots of four: two teams of up to four. The rest are not there, and the map does not pretend they are.
  assert.deepEqual(readMapLayout(mapWith([arena(), ...only(2)])).spawns.map((points) => points.length), [4, 4])
  // Three teams, the smallest of two, or fewer points in any slot.
  assert.deepEqual(readMapLayout(mapWith([arena(), ...trimmed([3, 3, 2])])).spawns.map((points) => points.length), [3, 3, 2])
  assert.deepEqual(readMapLayout(mapWith([arena(), ...trimmed([1])])).spawns.map((points) => points.length), [1])
  // More points than a slot is ever used for are fine.
  readMapLayout(mapWith([arena(), ...allSpawns(), spawn(5, 2, 100 + 300 / 3, -200 + 300 / 3)]))
})

test('a map with no spawn points, or that skips a slot or a number, is not played on', () => {
  const without = (name: string) => allSpawns().filter((point) => point.name !== name)
  assert.match(problemsOf(mapWith([arena()])), /no spawn points: a team has nowhere to start/)
  // Slot 2 is empty but slot 3 is not: the second biggest team would have nowhere to start.
  const skipped = allSpawns().filter((point) => point.properties[0].value !== 2)
  assert.match(problemsOf(mapWith([arena(), ...skipped])), /Slot 2 has no spawn points but slot 8 has: slots are used in order from 1/)
  // Point 3 is missing, so 4 is not reached: three points are counted, and the numbering is wrong.
  assert.match(problemsOf(mapWith([arena(), ...without('spawn-1-3')])), /Slot 1's spawn points must be numbered 1, 2, 3 ... with none missing/)
})

test('everything wrong with a map is reported together', () => {
  const message = problemsOf(mapWith([arena(), spawn(1, 1, 0, 0), spawn(2, 1, 160, -100), spawn(2, 1, 161, -100), spawn(undefined, 1, 160, -100), wall(50, 50, 10, 10, { rotation: 30 })]))
  assert.match(message, /^The map cannot be played on:/)
  for (const expected of [/spawn-1-1 is outside the arena/, /same spawn-number/, /needs a team-name/, /not a plain rectangle/, /Slot 1 has no spawn points but slot 2 has/]) {
    assert.match(message, expected)
  }
})

test('a map can give itself a title and a description, and has none by default', () => {
  const plain = readMapLayout(mapWith([arena(), ...allSpawns()]))
  assert.deepEqual([plain.title, plain.description], [undefined, undefined])
  const named = readMapLayout(mapWith([arena(), ...allSpawns()], { properties: [
    { name: 'title', type: 'string', value: '  The Pit ' },
    { name: 'description', type: 'string', value: 'A tight fight.' },
  ] }))
  assert.deepEqual([named.title, named.description], ['The Pit', 'A tight fight.'])
  const blank = readMapLayout(mapWith([arena(), ...allSpawns()], { properties: [{ name: 'title', type: 'string', value: '   ' }, { name: 'description', type: 'int', value: 4 }] }))
  assert.deepEqual([blank.title, blank.description], [undefined, undefined], 'empty or not text is no title')
})

test('a spawn point in or against a wall is refused, since a champion would start inside it', () => {
  // Slot 3, point 2 is at (60, 40) map pixels. A wall over it, or short of it by less than the widest
  // champion is wide: 8 pixels. The wall is thin and short, so the points round it are clear.
  assert.match(problemsOf(mapWith([arena(), ...allSpawns(), wall(55, 35, 10, 10)])), /spawn-3-2 is too close to a wall/)
  assert.match(problemsOf(mapWith([arena(), ...allSpawns(), wall(60 + GAME_MAX_CHAMPION_RADIUS / 3 - 1, 35, 2, 10)])), /spawn-3-2 is too close to a wall/)
  readMapLayout(mapWith([arena(), ...allSpawns(), wall(60 + GAME_MAX_CHAMPION_RADIUS / 3 + 1, 35, 2, 10)]))
})

test('a spawn point that walls shut in is refused, since a team could start where it can never get out', () => {
  // Slot 8's only point is at (160, 20): a box round it, with room for a champion inside.
  const top = wall(149, 8, 22, 2)
  const bottom = wall(149, 30, 22, 2)
  const left = wall(149, 8, 2, 24)
  const right = wall(169, 8, 2, 24)
  assert.match(problemsOf(mapWith([arena(), ...allSpawns(), top, bottom, left, right])), /spawn-8-1 cannot be reached from spawn-1-1: walls shut it off/)
  // With most of one side open, it can.
  readMapLayout(mapWith([arena(), ...allSpawns(), top, bottom, left, wall(169, 8, 2, 3)]))
})

test('a map with no hill and no flags can still be played on, and says it has neither', () => {
  const layout = readMapLayout(mapWith([arena(), ...allSpawns()]))
  assert.equal(layout.hill, undefined)
  assert.deepEqual(layout.flags, [])
})

test('a hill is read in world units from the corner of the arena, as an ellipse or a rectangle', () => {
  const round = readMapLayout(mapWith([arena(), ...allSpawns(), hill(100, 50, 60, 40)])).hill
  // 100 and 50 map pixels from the corner, 60 by 40 of them across, are 300 and 150, 180 by 120 once drawn at 3.
  assert.deepEqual(round, { x: 300, y: 150, width: 180, height: 120, ellipse: true })
  const square = readMapLayout(mapWith([arena(), ...allSpawns(), hill(100, 50, 60, 40, { ellipse: false })])).hill
  assert.deepEqual(square, { x: 300, y: 150, width: 180, height: 120, ellipse: false })
  // The class can be written as the type or as the class, like the rest of the objects.
  const classed = hill(100, 50, 60, 40, { class: 'hill', type: undefined })
  assert.deepEqual(readMapLayout(mapWith([arena(), ...allSpawns(), classed])).hill, round)
})

test('a hill that is not right says what is wrong', () => {
  const cases: Array<[unknown[], RegExp]> = [
    [[hill(100, 50, 60, 40), hill(200, 50, 60, 40)], /2 objects of class "hill", and needs at most one/],
    [[hill(100, 50, 60, 40, { rotation: 20 })], /koth is not a plain ellipse or rectangle/],
    [[hill(100, 50, 60, 40, { polygon: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 0, y: 40 }] })], /not a plain ellipse or rectangle/],
    [[hill(100, 50, 0, 0, { point: true })], /not a plain ellipse or rectangle/],
    [[hill(-70, 50, 60, 40)], /koth is outside the arena/],
    [[hill(100, GAME_ARENA_HEIGHT / 3, 60, 40)], /koth is outside the arena/],
    [[hill(100, 50, 0.1, 40)], /koth is too small/],
  ]
  for (const [objects, expected] of cases) assert.match(problemsOf(mapWith([arena(), ...allSpawns(), ...objects])), expected)
  // A hill the arena only reaches into is a hill.
  assert.ok(readMapLayout(mapWith([arena(), ...allSpawns(), hill(-30, 50, 60, 40)])).hill)
})

test('a flag is read in whole world units from the corner of the arena, by the slot it belongs to', () => {
  const layout = readMapLayout(mapWith([arena(), ...allSpawns(), flag(3, 300, 100.2), flag(1, 50.3, 50)]))
  // Slot 2 has none.
  assert.deepEqual(layout.flags, [{ x: 151, y: 150 }, undefined, { x: 900, y: 301 }])
  assert.deepEqual(readMapLayout(mapWith([arena(), ...allSpawns(), flag(1, 50, 50), flag(2, 400, 50)])).flags, [{ x: 150, y: 150 }, { x: 1200, y: 150 }])
})

test('a flag that is not right says which one and what is wrong', () => {
  const cases: Array<[unknown, RegExp]> = [
    [flag(1, 50, 50, { point: false, width: 5, height: 5 }), /ctf-flag-1 is not a point/],
    [flag(undefined, 50, 50), /ctf-flag-undefined needs a team-name from 1 to 8/],
    [flag(9, 50, 50), /ctf-flag-9 needs a team-name from 1 to 8/],
    [flag('red', 50, 50), /needs a team-name from 1 to 8/],
    [flag(1, -1, 50), /ctf-flag-1 is outside the arena/],
    [flag(1, 50, GAME_ARENA_HEIGHT / 3 + 1), /ctf-flag-1 is outside the arena/],
    [flag(1, 0, 50), /ctf-flag-1 is too close to a wall or the arena's edge/],
  ]
  for (const [point, expected] of cases) assert.match(problemsOf(mapWith([arena(), ...allSpawns(), point])), expected)
  assert.match(problemsOf(mapWith([arena(), ...allSpawns(), flag(2, 50, 50), flag(2, 80, 50)])), /ctf-flag-2 has the same team-name \(2\) as another flag/)
  // Not in or against a wall.
  assert.match(problemsOf(mapWith([arena(), ...allSpawns(), wall(95, 95, 10, 10), flag(1, 100, 100)])), /ctf-flag-1 is too close to a wall/)
})

test('a flag that walls shut in is refused, since no one could walk up to it', () => {
  const box = [wall(349, 8, 22, 2), wall(349, 30, 22, 2), wall(349, 8, 2, 24), wall(369, 8, 2, 24)]
  assert.match(problemsOf(mapWith([arena(), ...allSpawns(), ...box, flag(2, 360, 20)])), /ctf-flag-2 cannot be reached from spawn-1-1: walls shut it off/)
})

test('the game\'s own map has a hill and a flag for each of two teams, so every mode can be played on it', () => {
  const file = new URL(`../res/maps/${DEFAULT_MAP_ID}.tmj`, import.meta.url)
  const layout = readMapLayout(parseTiledMap(JSON.parse(readFileSync(file, 'utf-8'))))
  assert.ok(layout.hill, 'a hill')
  assert.ok(layout.flags[0] && layout.flags[1], 'a flag for each of the first two slots')
  for (const mode of ['deathmatch', 'koth', 'ctf'] as const) {
    assert.equal(modeStartProblem(mode, [1, 2], layout), undefined, mode)
  }
  assert.deepEqual(summarizeMap(DEFAULT_MAP_ID, layout).spawns.slice(0, 2), [4, 4], 'room for two teams of four')
  // Each flag is at the base of the slot of spawn points it belongs to: nearer to it than to the other's.
  const near = (point: { x: number; y: number }, slot: number) => Math.hypot(point.x - layout.spawns[slot][0].x, point.y - layout.spawns[slot][0].y)
  assert.ok(near(layout.flags[0] as { x: number; y: number }, 0) < near(layout.flags[0] as { x: number; y: number }, 1))
  assert.ok(near(layout.flags[1] as { x: number; y: number }, 1) < near(layout.flags[1] as { x: number; y: number }, 0))
})

test('the game\'s own map can be played on, for every way the players can split into teams', () => {
  const file = new URL(`../res/maps/${DEFAULT_MAP_ID}.tmj`, import.meta.url)
  const layout = readMapLayout(parseTiledMap(JSON.parse(readFileSync(file, 'utf-8'))))
  assert.equal(layout.spawns.length, GAME_MAX_PLAYERS)
  assert.ok(layout.terrain.walls.length > 0, 'it has walls')
  assert.ok(layout.terrain.width > 0 && layout.terrain.height > 0)
  for (const [slot, points] of layout.spawns.entries()) {
    assert.ok(points.length >= spawnPointsNeeded(slot + 1), `slot ${slot + 1} has the points it needs`)
    for (const point of points) {
      assert.ok(point.x >= 0 && point.x <= GAME_ARENA_WIDTH && point.y >= 0 && point.y <= GAME_ARENA_HEIGHT, `slot ${slot + 1} is in the arena`)
    }
  }
  for (const sizes of teamSizeArrangements()) {
    const spots = assignSpawns(teamsOf(sizes), layout.spawns)
    assert.equal(new Set(spots.map(({ x, y }) => `${x},${y}`)).size, spots.length, `${sizes.join('+')}: nobody shares a spot`)
  }
})
