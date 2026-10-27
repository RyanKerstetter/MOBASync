import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  canSeeBody,
  createShadowcastVision,
  createVision,
  DEFAULT_VISION_SYSTEM,
  GAME_VIEW_HEIGHT,
  GAME_VISION_RANGE,
  parseTiledMap,
  readMapLayout,
  SHADOWCAST_CELL,
  visionSystems,
  type Rect,
  type Vector2,
  type VisionFactory,
  type VisionGround,
} from '../packages/shared/src/index.ts'
import { visionContract } from './vision-contract.ts'

// The systems the game has, and what makes shadowcasting right on the map it is for.

visionContract('shadowcast', (ground) => createShadowcastVision(ground), { blocksSight: true })
visionContract('shadowcast on a grid twice as fine', (ground) => createShadowcastVision(ground, { cell: SHADOWCAST_CELL / 2 }), { blocksSight: true })
visionContract('range', visionSystems.get('range') as VisionFactory, { blocksSight: false })

// ---------------------------------------------------------------------------- what the game has

test('a champion sees 500, which is a little less than half the screen\'s height, so the edge of it shows on every side', () => {
  assert.equal(GAME_VISION_RANGE, 500)
  assert.ok(GAME_VISION_RANGE < GAME_VIEW_HEIGHT / 2)
  assert.equal(SHADOWCAST_CELL, 24, "on a grid of 8 pixels of the art, which is where the competitive map is laid out")
})

test('the systems are found by name, the default is shadowcasting, and one that is not there says which are', () => {
  assert.equal(DEFAULT_VISION_SYSTEM, 'shadowcast')
  assert.deepEqual([...visionSystems.keys()], ['shadowcast', 'range'])
  const ground: VisionGround = { width: 600, height: 400, walls: [{ x: 250, y: 100, width: 100, height: 200 }] }
  assert.equal(createVision(ground).name, 'shadowcast')
  assert.equal(createVision(ground, 'range').name, 'range')
  const viewers = [{ position: { x: 100, y: 200 }, range: 400 }]
  assert.ok(!createVision(ground).see(viewers).canSee({ x: 450, y: 200 }), 'shadowcasting stops at the wall')
  assert.ok(createVision(ground, 'range').see(viewers).canSee({ x: 450, y: 200 }), 'range alone does not')
  assert.throws(() => createVision(ground, 'x-ray'), /Unknown vision system "x-ray" \(there are shadowcast, range\)/)
})

test('a system is swapped for another with nothing else changed: anything with the shape of one will do', () => {
  // A system that sees everything, written from nothing but the types: what the page is given by a factory.
  const everything: VisionFactory = (ground) => {
    const data = new Uint8Array(ground.width * ground.height).fill(1)
    const mask = { kind: 'cells' as const, cell: 1, cols: ground.width, rows: ground.height, data, revision: 0 }
    return { name: 'everything', see: () => ({ canSee: (point) => point.x >= 0 && point.y >= 0 && point.x < ground.width && point.y < ground.height, mask }) }
  }
  const system = everything({ width: 30, height: 20, walls: [] })
  assert.equal(system.name, 'everything')
  assert.ok(system.see([]).canSee({ x: 5, y: 5 }))
})

test('a body is seen if its middle or any furthest point of it is', () => {
  const lit = (rect: Rect) => ({ canSee: (point: Vector2) => point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height })
  const view = lit({ x: 0, y: 0, width: 100, height: 100 })
  assert.ok(canSeeBody(view, { x: 50, y: 50 }, 20), 'its middle is')
  assert.ok(canSeeBody(view, { x: 110, y: 50 }, 20), 'only its near edge is: it is round the corner')
  assert.ok(canSeeBody(view, { x: 50, y: -15 }, 20) && canSeeBody(view, { x: 50, y: 115 }, 20) && canSeeBody(view, { x: -15, y: 50 }, 20))
  assert.ok(!canSeeBody(view, { x: 130, y: 50 }, 20), 'none of it is')
})

// ---------------------------------------------------------------------------- the grid

test('a cell is 8 pixels of the art, and a grid that is not made of positive cells is refused', () => {
  const ground: VisionGround = { width: 1000, height: 500, walls: [] }
  const { mask } = createShadowcastVision(ground).see([])
  assert.deepEqual([mask.cell, mask.cols, mask.rows], [24, 42, 21])
  for (const cell of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createShadowcastVision(ground, { cell }), RangeError)
  }
})

test('viewers that stay in the same cells are the same picture, and one that crosses into another cell is a new one', () => {
  const system = createShadowcastVision({ width: 1000, height: 500, walls: [] })
  const at = (x: number, y: number) => [{ position: { x, y }, range: 200 }]
  const first = system.see(at(301, 301)).mask.revision
  assert.equal(system.see(at(305, 309)).mask.revision, first, 'the same cell, which is 24 across')
  assert.equal(system.see(at(311, 301)).mask.revision, first, 'and the cell is [288, 312)')
  assert.equal(system.see(at(313, 301)).mask.revision, first + 1, 'a step into the next')
  assert.equal(system.see([{ position: { x: 313, y: 301 }, range: 201 }]).mask.revision, first + 2, 'a range that has changed')
})

test('a viewer in the middle of a thick wall, far from any way out, is no trouble and sees little', () => {
  const wall: Rect = { x: 300, y: 100, width: 400, height: 300 }
  const view = createShadowcastVision({ width: 1000, height: 500, walls: [wall] }).see([{ position: { x: 500, y: 250 }, range: 300 }])
  let seen = 0
  for (const cell of view.mask.data) seen += cell
  assert.ok(seen < 40, `it sees a few cells of the wall (${seen}), not the arena`)
  assert.ok(!view.canSee({ x: 100, y: 250 }))
})

test('a viewer that moves cell to cell round a wall is never shown what is behind it', () => {
  const wall: Rect = { x: 480, y: 150, width: 40, height: 200 }
  const system = createShadowcastVision({ width: 1000, height: 500, walls: [wall] })
  for (let y = 20; y <= 480; y += 7) {
    const view = system.see([{ position: { x: 400, y }, range: 500 }])
    const behind = y >= 190 && y <= 310 // looking at the middle of it, from the front
    if (behind) assert.ok(!view.canSee({ x: 700, y: 250 }), `from y ${y}, (700, 250) is behind the wall`)
  }
})

// ---------------------------------------------------------------------------- the competitive map

const MAP = readMapLayout(parseTiledMap(JSON.parse(readFileSync(new URL('../res/maps/competetive.tmj', import.meta.url), 'utf-8'))))
const GROUND = MAP.terrain
const SYSTEM = createShadowcastVision(GROUND)
// What a viewer at this point sees: the view is used before the next call, as it has to be.
const see = (from: Vector2, range = GAME_VISION_RANGE) => SYSTEM.see([{ position: from, range }])

test('on the competitive map a golem is not seen through the wall of its notch, but is from the open side of it', () => {
  const golem = MAP.monsters.find((camp) => camp.monster === 'golem')
  assert.ok(golem, 'the map has one')
  const home = golem.at
  // West of the wall the notch has on that side, which is 312 away: close enough, but behind a wall.
  assert.ok(!see({ x: home.x - 312, y: home.y }).canSee(home), 'from the lane to the west, through the wall')
  // East of it, where the notch is open, 348 away.
  assert.ok(see({ x: home.x + 348, y: home.y }).canSee(home), 'from the east, where it opens')
  assert.ok(!see({ x: home.x + 348, y: home.y }, 300).canSee(home), 'and not from beyond the range')
})

// Whether the straight line between two points goes through the inside of a rectangle, by its edges moved in by `inset`, so
// it is a line that goes well through and not one that only touches.
function lineGoesThrough(a: Vector2, b: Vector2, wall: Rect, inset: number): boolean {
  const left = wall.x + inset
  const right = wall.x + wall.width - inset
  const top = wall.y + inset
  const bottom = wall.y + wall.height - inset
  if (right <= left || bottom <= top) return false
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t } else { if (t < t0) return false; if (t < t1) t1 = t }
    return true
  }
  return clip(-dx, a.x - left) && clip(dx, right - a.x) && clip(-dy, a.y - top) && clip(dy, bottom - a.y)
}

// How close a straight line comes to a rectangle, by looking along it.
function nearestApproach(a: Vector2, b: Vector2, wall: Rect): number {
  let nearest = Infinity
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2))
  for (let step = 0; step <= steps; step += 1) {
    const x = a.x + (b.x - a.x) * step / steps
    const y = a.y + (b.y - a.y) * step / steps
    const dx = Math.max(wall.x - x, 0, x - (wall.x + wall.width))
    const dy = Math.max(wall.y - y, 0, y - (wall.y + wall.height))
    nearest = Math.min(nearest, Math.hypot(dx, dy))
  }
  return nearest
}

function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

// Somewhere a champion could stand: in the arena and well clear of every wall.
function openPoint(random: () => number): Vector2 {
  for (;;) {
    const point = { x: random() * GROUND.width, y: random() * GROUND.height }
    if (GROUND.walls.every((wall) => nearestApproach(point, point, wall) > 30)) return point
  }
}

test('on the competitive map it agrees with a straight line drawn between two points, except where the line only just clears or just clips a wall', () => {
  // Rounding the walls to the grid moves each edge up to 12 units, so a line that goes through a wall by less than the
  // grid's cell, or past it by less than that, is not asked: the rest it has to get right, of 8,000 pairs.
  const random = seeded(2024)
  const MARGIN = SHADOWCAST_CELL
  let clear = 0
  let blocked = 0
  for (let pair = 0; pair < 8000; pair += 1) {
    const a = openPoint(random)
    const angle = random() * Math.PI * 2
    const distance = 40 + random() * 400
    const b = { x: a.x + Math.cos(angle) * distance, y: a.y + Math.sin(angle) * distance }
    if (b.x < 0 || b.y < 0 || b.x >= GROUND.width || b.y >= GROUND.height) continue
    if (GROUND.walls.some((wall) => nearestApproach(b, b, wall) <= 30)) continue
    const seen = see(a).canSee(b)
    if (GROUND.walls.some((wall) => lineGoesThrough(a, b, wall, MARGIN))) {
      blocked += 1
      assert.ok(!seen, `(${a.x.toFixed(0)}, ${a.y.toFixed(0)}) to (${b.x.toFixed(0)}, ${b.y.toFixed(0)}) goes through a wall`)
    } else if (GROUND.walls.every((wall) => nearestApproach(a, b, wall) > MARGIN)) {
      clear += 1
      assert.ok(seen, `(${a.x.toFixed(0)}, ${a.y.toFixed(0)}) to (${b.x.toFixed(0)}, ${b.y.toFixed(0)}) is clear`)
    }
  }
  assert.ok(clear > 300 && blocked > 100, `enough of both were asked (${clear} clear, ${blocked} blocked)`)
})

test('on the competitive map, if A sees B then B sees A (the grid\'s symmetry), for 1,500 pairs', () => {
  const random = seeded(7)
  let seen = 0
  for (let pair = 0; pair < 1500; pair += 1) {
    const a = openPoint(random)
    const angle = random() * Math.PI * 2
    const distance = random() * 520
    const b = { x: a.x + Math.cos(angle) * distance, y: a.y + Math.sin(angle) * distance }
    if (b.x < 0 || b.y < 0 || b.x >= GROUND.width || b.y >= GROUND.height) continue
    if (GROUND.walls.some((wall) => nearestApproach(b, b, wall) <= 30)) continue
    const forward = see(a).canSee(b)
    const back = see(b).canSee(a)
    assert.equal(forward, back, `(${a.x.toFixed(0)}, ${a.y.toFixed(0)}) and (${b.x.toFixed(0)}, ${b.y.toFixed(0)}) disagree`)
    if (forward) seen += 1
  }
  assert.ok(seen > 300, `many of them see each other (${seen})`)
})

test('a full team moving every frame on the competitive map costs next to nothing', () => {
  const random = seeded(99)
  const system = createShadowcastVision(GROUND)
  const team = Array.from({ length: 8 }, () => openPoint(random))
  const start = performance.now()
  for (let frame = 0; frame < 100; frame += 1) {
    system.see(team.map((position) => ({ position: { x: position.x + frame * 13, y: position.y + frame * 5 }, range: GAME_VISION_RANGE })))
  }
  const each = (performance.now() - start) / 100
  // About 0.2 ms here: the bound is 100 times that, to catch a slip into something quadratic and not to time the machine.
  assert.ok(each < 20, `a frame of eight viewers took ${each.toFixed(2)} ms`)
})
