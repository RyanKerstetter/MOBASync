import assert from 'node:assert/strict'
import test from 'node:test'
import { Terrain, type PathfinderFactory, type Rect, type Vector2 } from '../packages/shared/src/index.ts'

// What every pathfinder must do, whichever way it works (see `Pathfinder`). Run it against a new one
// with `pathfinderContract('name', factory)` and it must pass as it is.

const ARENA = { width: 1000, height: 600 }
const PILLAR: Rect = { x: 400, y: 200, width: 200, height: 200 }

const distance = (from: Vector2, to: Vector2): number => Math.hypot(to.x - from.x, to.y - from.y)

// How far a point is from a wall, and 0 inside it.
function distanceToWall(point: Vector2, wall: Rect): number {
  const dx = Math.max(wall.x - point.x, 0, point.x - (wall.x + wall.width))
  const dy = Math.max(wall.y - point.y, 0, point.y - (wall.y + wall.height))
  return Math.hypot(dx, dy)
}

const lengthOf = (from: Vector2, route: readonly Vector2[]): number =>
  route.reduce((total, point, index) => total + distance(index === 0 ? from : route[index - 1], point), 0)

// Whether a body of this radius can walk the straight line between two points without touching a
// wall, found by looking at points along it, so it does not depend on how a pathfinder works it out.
function walkable(walls: readonly Rect[], from: Vector2, to: Vector2, radius: number, tolerance = 0.5): boolean {
  const steps = Math.max(2, Math.ceil(distance(from, to) / 2))
  for (let step = 0; step <= steps; step += 1) {
    const point = { x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps }
    if (walls.some((wall) => distanceToWall(point, wall) < radius - tolerance)) return false
  }
  return true
}

function assertWalkable(walls: readonly Rect[], from: Vector2, route: readonly Vector2[], radius: number, label: string): void {
  route.forEach((point, index) => {
    const origin = index === 0 ? from : route[index - 1]
    assert.ok(walkable(walls, origin, point, radius), `${label}: the line from (${origin.x}, ${origin.y}) to (${point.x}, ${point.y}) goes through a wall`)
  })
}

// A small seeded generator, so the random scenes are the same every time.
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function pathfinderContract(name: string, factory: PathfinderFactory): void {
  const terrainOf = (walls: Rect[], arena = ARENA): Terrain => new Terrain(arena, walls, factory)

  test(`${name}: a clear way is one straight line to the target`, () => {
    const terrain = terrainOf([PILLAR])
    const to = { x: 900, y: 100 }
    const route = terrain.path({ x: 100, y: 100 }, to, 20)
    assert.deepEqual(route, [to])
    assert.notEqual(route?.[0], to, 'a copy, not the very point that was asked for')
  })

  test(`${name}: round a pillar it goes by the corners, on the shorter side, close to the shortest way`, () => {
    const terrain = terrainOf([PILLAR])
    const radius = 20
    // Dead level: the same either way round, so only that it is about as short as the corners allow.
    const level = terrain.path({ x: 100, y: 300 }, { x: 900, y: 300 }, radius)
    assert.ok(level && level.length >= 3)
    const ideal = 2 * Math.hypot(280, 120) + 240
    assert.ok(Math.abs(lengthOf({ x: 100, y: 300 }, level) - ideal) < 6, `${lengthOf({ x: 100, y: 300 }, level)} against ${ideal}`)
    assertWalkable([PILLAR], { x: 100, y: 300 }, level, radius, 'level')
    assert.deepEqual(level.at(-1), { x: 900, y: 300 })

    // Nearer the top, it goes over the top; nearer the bottom, under.
    const high = terrain.path({ x: 100, y: 250 }, { x: 900, y: 250 }, radius)
    const low = terrain.path({ x: 100, y: 350 }, { x: 900, y: 350 }, radius)
    assert.ok(high && high.slice(0, -1).every((point) => point.y < PILLAR.y), 'over the top')
    assert.ok(low && low.slice(0, -1).every((point) => point.y > PILLAR.y + PILLAR.height), 'under the bottom')
  })

  test(`${name}: the same question always gets the same answer, from any pathfinder built the same way`, () => {
    const first = terrainOf([PILLAR])
    const second = terrainOf([PILLAR])
    for (const [from, to] of [
      [{ x: 100, y: 300 }, { x: 900, y: 300 }],
      [{ x: 500, y: 100 }, { x: 500, y: 500 }],
      [{ x: 123.456, y: 78.9 }, { x: 876.5, y: 432.1 }],
    ] as const) {
      const answer = first.path(from, to, 20)
      assert.deepEqual(first.path(from, to, 20), answer)
      assert.deepEqual(second.path(from, to, 20), answer)
    }
  })

  test(`${name}: a gap is a way through for a body that fits it and none for one that does not`, () => {
    // A barrier from top to bottom with a 50 wide gap in the middle.
    const terrain = terrainOf([
      { x: 300, y: 0, width: 100, height: 275 },
      { x: 300, y: 325, width: 100, height: 275 },
    ])
    const from = { x: 100, y: 300 }
    const to = { x: 700, y: 300 }
    assert.deepEqual(terrain.path(from, to, 20), [to], 'a thin body goes straight through')
    assert.equal(terrain.path(from, to, 30), undefined, 'a fat one cannot')
    assert.equal(terrain.path(to, from, 30), undefined, 'either way')
  })

  test(`${name}: nowhere to go when walls shut the target in or out`, () => {
    const pocket: Rect[] = [
      { x: 400, y: 200, width: 200, height: 20 },
      { x: 400, y: 380, width: 200, height: 20 },
      { x: 400, y: 200, width: 20, height: 200 },
      { x: 580, y: 200, width: 20, height: 200 },
    ]
    const terrain = terrainOf(pocket)
    const inside = { x: 500, y: 300 }
    const outside = { x: 100, y: 100 }
    assert.equal(terrain.path(outside, inside, 20), undefined)
    assert.equal(terrain.path(inside, outside, 20), undefined)
    assert.deepEqual(terrain.path(inside, { x: 520, y: 320 }, 20), [{ x: 520, y: 320 }], 'but it can move about in there')
  })

  test(`${name}: a target in a wall is reached at the nearest place a body can stand`, () => {
    const terrain = terrainOf([PILLAR])
    const radius = 20
    const from = { x: 100, y: 300 }
    for (const to of [{ x: 500, y: 300 }, { x: 410, y: 210 }, { x: 595, y: 395 }, { x: 399, y: 300 }]) {
      const route = terrain.path(from, to, radius)
      assert.ok(route && route.length > 0, `a way to (${to.x}, ${to.y})`)
      const end = route.at(-1) as Vector2
      assert.ok(distanceToWall(end, PILLAR) >= radius - 0.5, 'it ends outside the wall')
      assert.ok(distance(end, to) < 150, 'and near where it was sent')
      assertWalkable([PILLAR], from, route, radius, 'into the wall')
    }
  })

  test(`${name}: a body pushed against a corner by the walls still finds its way`, () => {
    const terrain = terrainOf([PILLAR])
    const radius = 20
    // Exactly its radius from the pillar's top left corner, as walking round it leaves a body.
    const from = { x: 400 - 20 * Math.SQRT1_2, y: 200 - 20 * Math.SQRT1_2 }
    for (const to of [{ x: 700, y: 100 }, { x: 900, y: 300 }, { x: 100, y: 500 }, { x: 500, y: 500 }]) {
      const route = terrain.path(from, to, radius)
      assert.ok(route, `a way to (${to.x}, ${to.y})`)
      assertWalkable([PILLAR], from, route, radius, 'from the corner')
    }
  })

  test(`${name}: a body that is already where it is going has nowhere to walk`, () => {
    const terrain = terrainOf([PILLAR])
    assert.deepEqual(terrain.path({ x: 100, y: 100 }, { x: 100, y: 100 }, 20), [])
  })

  test(`${name}: in a scene of random walls every way found is clear, and no longer than a detour round the corners`, () => {
    const next = seeded(7)
    const arena = { width: 1200, height: 800 }
    let asked = 0
    let routed = 0
    let compared = 0
    for (let scene = 0; scene < 25; scene += 1) {
      const walls: Rect[] = Array.from({ length: 3 + Math.floor(next() * 5) }, () => {
        const width = 40 + Math.floor(next() * 160)
        const height = 40 + Math.floor(next() * 160)
        return { x: Math.floor(next() * (arena.width - width)), y: Math.floor(next() * (arena.height - height)), width, height }
      })
      const terrain = terrainOf(walls, arena)
      const radius = 18 + Math.floor(next() * 5)
      // Only places a body can stand: a pocket between a wall and the arena's edge that is too narrow
      // for it has no one in it, and nowhere to start from.
      const standable = (at: Vector2): boolean => walls.every((wall) => distanceToWall(at, wall) >= radius - 1e-6)
      const point = (): Vector2 => terrain.resolve({ x: next() * arena.width, y: next() * arena.height }, radius)
      for (let query = 0; query < 20; query += 1) {
        const from = point()
        const to = point()
        if (!standable(from) || !standable(to)) continue
        asked += 1
        const label = `scene ${scene}, from (${from.x.toFixed(1)}, ${from.y.toFixed(1)}) to (${to.x.toFixed(1)}, ${to.y.toFixed(1)})`
        const route = terrain.path(from, to, radius)
        const back = terrain.path(to, from, radius)
        assert.equal(route === undefined, back === undefined, `${label}: a way there is a way back`)
        if (!route) continue
        routed += 1
        assertWalkable(walls, from, route, radius, label)
        const end = route.at(-1) ?? from
        assert.ok(distance(end, to) < radius, `${label}: it ends where it was sent`)

        // A detour by one or two corners, a little further out than the pathfinder's own, found by
        // looking: if one is clear, the way found is no longer than it (give or take a little).
        const corners = walls.flatMap((wall) => [
          { x: wall.x - radius - 2, y: wall.y - radius - 2 },
          { x: wall.x + wall.width + radius + 2, y: wall.y - radius - 2 },
          { x: wall.x - radius - 2, y: wall.y + wall.height + radius + 2 },
          { x: wall.x + wall.width + radius + 2, y: wall.y + wall.height + radius + 2 },
        ]).filter((corner) => corner.x >= radius && corner.y >= radius
          && corner.x <= arena.width - radius && corner.y <= arena.height - radius
          && walls.every((wall) => distanceToWall(corner, wall) >= radius + 1))
        const candidates: Vector2[][] = [[to], ...corners.map((corner) => [corner, to])]
        for (const first of corners) for (const second of corners) candidates.push([first, second, to])
        const ownLength = lengthOf(from, route)
        for (const candidate of candidates) {
          const clear = candidate.every((p, index) => walkable(walls, index === 0 ? from : candidate[index - 1], p, radius, -1))
          if (!clear) continue
          compared += 1
          assert.ok(ownLength <= lengthOf(from, candidate) + 4 + 0.02 * ownLength, `${label}: ${ownLength} against a clear detour of ${lengthOf(from, candidate)}`)
        }
      }
    }
    // The scenes are not all empty of questions, ways, or detours to compare with.
    assert.ok(asked > 150 && routed > 100 && compared > 300, `${asked} asked, ${routed} routed, ${compared} compared`)
  })
}
