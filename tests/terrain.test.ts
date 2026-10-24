import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  Terrain,
  TerrainSchema,
  type Rect,
  type Vector2,
} from '../packages/shared/src/index.ts'

const ARENA = { width: 1000, height: 600 }
const PILLAR: Rect = { x: 400, y: 200, width: 200, height: 200 }

const distanceToWall = (point: Vector2, wall: Rect): number =>
  Math.hypot(
    Math.max(wall.x - point.x, 0, point.x - (wall.x + wall.width)),
    Math.max(wall.y - point.y, 0, point.y - (wall.y + wall.height)),
  )

test('the plain terrain is the plain arena with no walls, and is always the same one', () => {
  const plain = Terrain.plain()
  assert.equal(plain.width, GAME_ARENA_WIDTH)
  assert.equal(plain.height, GAME_ARENA_HEIGHT)
  assert.deepEqual(plain.walls, [])
  assert.equal(Terrain.plain(), plain)
})

test('the arena holds a body inside it by its radius, and walls do not come into it', () => {
  const terrain = new Terrain(ARENA, [PILLAR])
  assert.deepEqual(terrain.clamp({ x: -50, y: 9000 }, 20), { x: 20, y: 580 })
  assert.deepEqual(terrain.clamp({ x: 500, y: 300 }, 20), { x: 500, y: 300 }, 'inside a wall is still inside the arena')
})

test('a body overlapping a wall is pushed straight out of its face, and keeps its place along it', () => {
  const terrain = new Terrain(ARENA, [PILLAR])
  assert.deepEqual(terrain.keepOutOfWalls({ x: 390, y: 250 }, 20), { x: 380, y: 250 })
  assert.deepEqual(terrain.keepOutOfWalls({ x: 590, y: 250 }, 20), { x: 620, y: 250 })
  assert.deepEqual(terrain.keepOutOfWalls({ x: 450, y: 195 }, 20), { x: 450, y: 180 })
  assert.deepEqual(terrain.keepOutOfWalls({ x: 450, y: 405 }, 20), { x: 450, y: 420 })
})

test('a body is pushed round a corner along a curve, so it ends exactly its radius from the corner', () => {
  const terrain = new Terrain(ARENA, [PILLAR])
  const out = terrain.keepOutOfWalls({ x: 390, y: 190 }, 20)
  const away = 20 * Math.SQRT1_2
  assert.ok(Math.abs(out.x - (400 - away)) < 1e-9 && Math.abs(out.y - (200 - away)) < 1e-9)
  assert.ok(Math.abs(Math.hypot(out.x - 400, out.y - 200) - 20) < 1e-9)
})

test('a body in the middle of a wall leaves by the nearest side, the left first on a tie', () => {
  const terrain = new Terrain(ARENA, [PILLAR])
  assert.deepEqual(terrain.keepOutOfWalls({ x: 500, y: 300 }, 20), { x: 380, y: 300 }, 'a tie goes left')
  assert.deepEqual(terrain.keepOutOfWalls({ x: 580, y: 300 }, 20), { x: 620, y: 300 }, 'the nearest is the right')
  assert.deepEqual(terrain.keepOutOfWalls({ x: 500, y: 210 }, 20), { x: 500, y: 180 }, 'the nearest is the top')
  assert.deepEqual(terrain.keepOutOfWalls({ x: 500, y: 390 }, 20), { x: 500, y: 420 }, 'the nearest is the bottom')
  assert.deepEqual(terrain.keepOutOfWalls({ x: 400, y: 300 }, 20), { x: 380, y: 300 }, 'on the edge, it goes out')
})

test('a body that is not overlapping a wall is left exactly as it is, and costs nothing with no walls', () => {
  const terrain = new Terrain(ARENA, [PILLAR])
  const clear = { x: 100, y: 100 }
  assert.equal(terrain.keepOutOfWalls(clear, 20), clear)
  const touching = { x: 380, y: 300 }
  assert.equal(terrain.keepOutOfWalls(touching, 20), touching, 'touching is not overlapping')
  const nothing = new Terrain(ARENA)
  const anywhere = { x: -5, y: 5000 }
  assert.equal(nothing.keepOutOfWalls(anywhere, 20), anywhere, 'and it does not clamp either')
})

test('resolving a point holds it in the arena and out of the walls, and settling twice changes nothing', () => {
  const terrain = new Terrain(ARENA, [PILLAR, { x: 0, y: 450, width: 150, height: 150 }])
  const points: Vector2[] = [
    { x: 500, y: 300 }, { x: -20, y: -20 }, { x: 1100, y: 700 }, { x: 160, y: 440 }, { x: 10, y: 440 }, { x: 300, y: 590 },
  ]
  for (const point of points) {
    const once = terrain.resolve(point, 20)
    assert.ok(once.x >= 20 && once.x <= 980 && once.y >= 20 && once.y <= 580, 'inside the arena')
    for (const wall of terrain.walls) assert.ok(distanceToWall(once, wall) >= 20 - 1e-6, 'and out of every wall')
    assert.deepEqual(terrain.resolve(once, 20), once)
  }
})

test('a body pushed out of a wall into the arena edge, or another wall, ends where neither holds it', () => {
  // A wall against the edge: leaving by the side nearest the edge would be into it.
  const terrain = new Terrain(ARENA, [
    { x: 0, y: 200, width: 100, height: 200 },
    { x: 180, y: 200, width: 100, height: 200 },
  ])
  const squeezed = terrain.resolve({ x: 50, y: 300 }, 20)
  for (const wall of terrain.walls) assert.ok(distanceToWall(squeezed, wall) >= 20 - 1e-6)
  assert.ok(squeezed.x >= 20)
  // Between walls with room for it, it ends in the gap: 80 across fits a body of 20.
  const gap = terrain.resolve({ x: 140, y: 300 }, 20)
  assert.deepEqual(gap, { x: 140, y: 300 })
  // With no room at all it still ends, and stays inside the arena.
  const crowded = new Terrain(ARENA, [{ x: 0, y: 0, width: 1000, height: 600 }])
  const stuck = crowded.resolve({ x: 500, y: 300 }, 20)
  assert.ok(Number.isFinite(stuck.x) && Number.isFinite(stuck.y))
  assert.ok(stuck.x >= 20 && stuck.x <= 980 && stuck.y >= 20 && stuck.y <= 580)
})

test('the walls are kept in a fixed order, whatever order they were given in', () => {
  const walls: Rect[] = [PILLAR, { x: 100, y: 50, width: 80, height: 80 }, { x: 700, y: 50, width: 60, height: 120 }]
  assert.deepEqual(new Terrain(ARENA, walls).walls, new Terrain(ARENA, [...walls].reverse()).walls)
  assert.deepEqual(new Terrain(ARENA, walls).walls.map((wall) => wall.y), [50, 50, 200])
  // The terrain has its own copies, so changing what it was made from does not change it.
  const mutable: Rect[] = [{ ...PILLAR }]
  const terrain = new Terrain(ARENA, mutable)
  mutable[0].x = 0
  assert.equal(terrain.walls[0].x, 400)
})

test('a terrain travels as data and arrives the same, and knows whether data is its own', () => {
  const terrain = new Terrain(ARENA, [PILLAR, { x: 100, y: 50, width: 80, height: 80 }])
  const data = terrain.toData()
  assert.equal(TerrainSchema.safeParse(JSON.parse(JSON.stringify(data))).success, true)
  const copy = Terrain.fromData(JSON.parse(JSON.stringify(data)))
  assert.deepEqual(copy.toData(), data)
  assert.equal(terrain.sameAs(data), true)
  assert.equal(copy.sameAs(data), true)
  assert.equal(terrain.sameAs({ ...data, width: 1001 }), false)
  assert.equal(terrain.sameAs({ ...data, walls: data.walls.slice(1) }), false)
  assert.equal(terrain.sameAs({ ...data, walls: [data.walls[0], [100, 50, 80, 81]] }), false)
  assert.equal(new Terrain(ARENA).sameAs(Terrain.plain().toData()), false)
  assert.equal(Terrain.plain().sameAs(Terrain.plain().toData()), true)
})

test('the schema refuses a terrain that is not one', () => {
  assert.equal(TerrainSchema.safeParse({ width: 100, height: 100, walls: [[1, 2, 3, 4]] }).success, true)
  assert.equal(TerrainSchema.safeParse({ width: 100, height: 100, walls: [[1, 2, 0, 4]] }).success, false)
  assert.equal(TerrainSchema.safeParse({ width: 100, height: 100, walls: [[1, 2, 3]] }).success, false)
  assert.equal(TerrainSchema.safeParse({ width: 0, height: 100, walls: [] }).success, false)
})
