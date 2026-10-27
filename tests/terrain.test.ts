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

// Two walls that meet along x = 400. The nearest side of one is the inside of the other, so a body put on the seam used to be pushed
// from one into the other and stay in them.
const SEAM: Rect[] = [{ x: 300, y: 200, width: 100, height: 200 }, { x: 400, y: 200, width: 100, height: 200 }]

test('a body put on the seam between two walls leaves by the nearest way clear of both, and not from one into the other', () => {
  const terrain = new Terrain(ARENA, SEAM)
  for (const point of [{ x: 400, y: 300 }, { x: 401, y: 300 }, { x: 399, y: 250 }, { x: 380, y: 300 }, { x: 420, y: 350 }, { x: 400, y: 201 }]) {
    const out = terrain.resolve(point, 20)
    for (const wall of terrain.walls) assert.ok(distanceToWall(out, wall) >= 20 - 1e-6, `${JSON.stringify(point)} -> ${JSON.stringify(out)} is in a wall`)
  }
  // The nearest way out of the middle of the seam is a wall's face away, and the left wins a tie like it does for one wall.
  assert.deepEqual(terrain.resolve({ x: 400, y: 300 }, 20), { x: 280, y: 300 })
  // And one that was clear is not moved.
  const clear = { x: 100, y: 300 }
  assert.equal(terrain.keepOutOfWalls(clear, 20), clear)
})

test('a seam against the arena edge, and in a stack of walls, is left the same way', () => {
  const terrain = new Terrain(ARENA, [
    // Against the left edge, so its left side is not a way out.
    { x: 0, y: 200, width: 100, height: 200 },
    { x: 100, y: 200, width: 100, height: 200 },
    // Stacked, so the seam is across it.
    { x: 600, y: 100, width: 100, height: 100 },
    { x: 600, y: 200, width: 100, height: 100 },
    { x: 700, y: 150, width: 100, height: 100 },
  ])
  for (const point of [{ x: 100, y: 300 }, { x: 50, y: 300 }, { x: 650, y: 200 }, { x: 700, y: 200 }, { x: 699, y: 190 }]) {
    const out = terrain.resolve(point, 20)
    assert.ok(out.x >= 20 && out.x <= 980 && out.y >= 20 && out.y <= 580, `${JSON.stringify(point)} stays in the arena`)
    for (const wall of terrain.walls) assert.ok(distanceToWall(out, wall) >= 20 - 1e-6, `${JSON.stringify(point)} -> ${JSON.stringify(out)} is in a wall`)
  }
})

test('every place in the arena resolves to somewhere clear, with walls that meet in seams, and settling twice changes nothing', () => {
  const walls: Rect[] = [
    ...SEAM,
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 100, y: 0, width: 100, height: 100 },
    { x: 0, y: 100, width: 100, height: 100 },
    { x: 600, y: 100, width: 100, height: 100 },
    { x: 600, y: 200, width: 100, height: 100 },
    { x: 700, y: 150, width: 100, height: 100 },
    { x: 900, y: 500, width: 100, height: 100 },
  ]
  const terrain = new Terrain(ARENA, walls)
  for (const radius of [18, 20, 22]) {
    for (let x = -10; x <= ARENA.width + 10; x += 7) {
      for (let y = -10; y <= ARENA.height + 10; y += 7) {
        const out = terrain.resolve({ x, y }, radius)
        const where = `radius ${radius}, (${x}, ${y}) -> ${JSON.stringify(out)}`
        assert.ok(out.x >= radius && out.x <= ARENA.width - radius && out.y >= radius && out.y <= ARENA.height - radius, `${where} is out of the arena`)
        for (const wall of terrain.walls) assert.ok(distanceToWall(out, wall) >= radius - 1e-6, `${where} is in a wall`)
        assert.deepEqual(terrain.resolve(out, radius), out, `${where} is not settled`)
      }
    }
  }
})

test('a way out is found from a point on a seam, and to one', () => {
  const terrain = new Terrain(ARENA, SEAM)
  const from = terrain.path({ x: 400, y: 300 }, { x: 800, y: 300 }, 20)
  assert.ok(from && from.length > 0, 'from it')
  assert.deepEqual(from[from.length - 1], { x: 800, y: 300 })
  const to = terrain.path({ x: 100, y: 300 }, { x: 400, y: 300 }, 20)
  assert.ok(to && to.length > 0, 'to it')
  const end = to[to.length - 1]
  for (const wall of terrain.walls) assert.ok(distanceToWall(end, wall) >= 20 - 0.1, `it ends at ${JSON.stringify(end)}, in a wall`)
})

// A wide wall (A) with a narrow one hanging from its south face (B), and a tall one against A's west end (W), so the way out of A to the
// west is shut. A body stands in the inner corner at (340, 220), against A's south face and B's west face (radius 20).
const HANGING: Rect[] = [
  { x: 0, y: 0, width: 200, height: 420 },
  { x: 200, y: 0, width: 400, height: 200 },
  { x: 360, y: 200, width: 80, height: 160 },
]

test('a click in a wall whose south face has another wall against it goes to the nearest free place along that face, and not round to the far side', () => {
  const terrain = new Terrain(ARENA, HANGING)
  const corner = { x: 340, y: 220 }
  // Straight down from the click is inside B's clearance (x 344 is 16 from B), and the free place is a step along the face.
  for (const x of [344, 350, 380]) {
    assert.deepEqual(terrain.resolve({ x, y: 120 }, 20), corner, `a click at (${x}, 120)`)
  }
  assert.ok(terrain.walkDistance(corner, terrain.resolve({ x: 344, y: 120 }, 20), 20) < 5, 'which is where the body is, not a walk round B')
  // Over the middle of B the two ends are as near, and the west, the left, wins as it does for one wall.
  assert.deepEqual(terrain.resolve({ x: 400, y: 120 }, 20), corner)
  // Past the other end, straight down is clear, and that is where it goes.
  assert.deepEqual(terrain.resolve({ x: 470, y: 120 }, 20), { x: 470, y: 220 })
  // Nearer B's east end, the free place is the east end of the stretch B covers (beside B), and not round the end of the wall.
  assert.deepEqual(terrain.resolve({ x: 440, y: 190 }, 20), { x: 460, y: 220 })
})

test('the same, turned on its side: a click in a wall whose east face has another wall against it goes along that face', () => {
  // The walls of the last test with x and y swapped, so the face is the east one and the body is in the corner at (220, 340).
  const terrain = new Terrain(ARENA, HANGING.map(({ x, y, width, height }) => ({ x: y, y: x, width: height, height: width })))
  const corner = { x: 220, y: 340 }
  for (const y of [344, 350, 380]) {
    assert.deepEqual(terrain.resolve({ x: 120, y }, 20), corner, `a click at (120, ${y})`)
  }
  assert.deepEqual(terrain.resolve({ x: 120, y: 400 }, 20), corner, 'and the nearer end on a tie')
  assert.deepEqual(terrain.resolve({ x: 120, y: 470 }, 20), { x: 220, y: 470 }, 'past the other end, straight out is clear')
})

test('wherever it is put, a body ends clear of every wall, however the walls hang from each other', () => {
  const terrain = new Terrain(ARENA, HANGING)
  for (const radius of [18, 20, 22, 48]) {
    for (let x = -10; x <= ARENA.width + 10; x += 9) {
      for (let y = -10; y <= ARENA.height + 10; y += 9) {
        const out = terrain.resolve({ x, y }, radius)
        const where = `radius ${radius}, (${x}, ${y}) -> ${JSON.stringify(out)}`
        assert.ok(out.x >= radius && out.x <= ARENA.width - radius && out.y >= radius && out.y <= ARENA.height - radius, `${where} is out of the arena`)
        for (const wall of terrain.walls) assert.ok(distanceToWall(out, wall) >= radius - 1e-6, `${where} is in a wall`)
      }
    }
  }
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

// ---------------------------------------------------------------------------- how far it is to walk

const length = (from: Vector2, route: readonly Vector2[]): number => {
  let total = 0
  let last = from
  for (const point of route) {
    // A square root and a sum, as the terrain does it: Math.hypot is not promised to give the same last digit everywhere.
    total += Math.sqrt((point.x - last.x) ** 2 + (point.y - last.y) ** 2)
    last = point
  }
  return total
}

test('the walk to somewhere in plain sight is the straight line, with walls in the arena or not', () => {
  const open = new Terrain(ARENA)
  assert.equal(open.walkDistance({ x: 100, y: 100 }, { x: 400, y: 500 }, 20), 500, 'a 3, 4, 5 triangle of 100s')
  const walled = new Terrain(ARENA, [PILLAR])
  assert.equal(walled.walkDistance({ x: 100, y: 100 }, { x: 100, y: 500 }, 20), 400, 'the pillar is not in the way')
  assert.equal(walled.walkDistance({ x: 100, y: 100 }, { x: 100, y: 100 }, 20), 0, 'there already')
})

test('the walk round a wall is the way round it, which is further than the line, and is the length of the path', () => {
  const terrain = new Terrain(ARENA, [PILLAR])
  const from = { x: 200, y: 300 }
  const to = { x: 800, y: 300 }
  const line = 600
  const route = terrain.path(from, to, 20)
  assert.ok(route && route.length >= 2, 'there is a way, with a bend')
  const walk = terrain.walkDistance(from, to, 20)
  assert.equal(walk, length(from, route), 'the length of that way')
  assert.ok(walk > line + 50, `further than the line (${walk.toFixed(1)})`)
  // The way round the pillar is out to a corner of it (a body of 20 is a node 21 from it: 379, 179), along its top to the other
  // (621, 179) and down again, so 2 * hypot(179, 121) + 242, and no more.
  assert.ok(Math.abs(walk - (2 * Math.sqrt(179 * 179 + 121 * 121) + 242)) < 1e-6, `the shortest way round (${walk.toFixed(3)})`)
  assert.ok(Math.abs(terrain.walkDistance(to, from, 20) - walk) < 1e-6, 'the same there and back')
  // A fatter body goes round wider, so it walks further.
  assert.ok(terrain.walkDistance(from, to, 40) > walk, 'a body of radius 40 walks further than one of 20')
})

test('there is no walk to a place that has no way to it, and the same inputs always give the same answer', () => {
  // A room with no door: the target is inside four walls.
  const room: Rect[] = [
    { x: 600, y: 100, width: 20, height: 300 },
    { x: 800, y: 100, width: 20, height: 300 },
    { x: 600, y: 100, width: 220, height: 20 },
    { x: 600, y: 380, width: 220, height: 20 },
  ]
  const shut = new Terrain(ARENA, room)
  assert.equal(shut.walkDistance({ x: 100, y: 300 }, { x: 710, y: 250 }, 20), Infinity)
  const terrain = new Terrain(ARENA, [PILLAR])
  const first = terrain.walkDistance({ x: 123.4, y: 301.7 }, { x: 876.5, y: 298.2 }, 21)
  for (let index = 0; index < 5; index += 1) assert.equal(terrain.walkDistance({ x: 123.4, y: 301.7 }, { x: 876.5, y: 298.2 }, 21), first)
  assert.equal(new Terrain(ARENA, [PILLAR]).walkDistance({ x: 123.4, y: 301.7 }, { x: 876.5, y: 298.2 }, 21), first, 'a terrain of its own agrees')
})
