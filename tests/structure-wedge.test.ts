import assert from 'node:assert/strict'
import test from 'node:test'
import {
  distanceBetween,
  GAME_STRUCTURE_EJECT_DEPTH,
  Simulator,
  Terrain,
  walkingSpeed,
  type CharacterOrder,
  type Rect,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineChampion, defineTurret } from './fixtures.ts'

// A structure does not give way as a champion does (see `pushCharactersApart`), and the pathfinder knows the walls and nothing else. A champion that walks into a structure must
// not stay wedged against it: it can be told to walk away and goes, and one that is somewhere a structure's push cannot get it out of (a wall or the edge of the arena holds it in)
// is put on the nearest place it can stand. The structures, the champion and the ground here are the tests' own.

const ME = 1
const STRUCTURE = 10
const bulwark = defineTurret(700, { base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 }, radius: 60, attackRange: 1, attackWindup: 0 })
const walker = defineChampion({
  id: 't-sw-walker',
  name: 'Walker',
  base: { maxHp: 1000, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 21,
  attackRange: 100,
  attackWindup: 0,
  abilities: [],
})
const REACH = walker.radius + bulwark.champion.radius

let sequence = 0
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })
const where = (simulator: Simulator, tick: number): Vector2 => simulator.at(tick).get(ME)?.getPosition() as Vector2

// ---------------------------------------------------------------------------- walking round a corner that a structure is against

// A passage between two blocks of wall, and a structure standing at its mouth with only a little more than the walker's width between it and the corner of the upper block.
// The pathfinder goes round that corner by a point a body's radius out from it on each side, and that point is inside the structure: the walker used to step onto it, be shoved
// back out, and step onto it again, for good.
const WALLS: Rect[] = [{ x: 480, y: 260, width: 144, height: 144 }, { x: 480, y: 596, width: 144, height: 144 }]
const GROUND = { width: 1400, height: 1000 }
const CORE_AT: Vector2 = { x: 432, y: 500 }
const CORNER: Vector2 = { x: 480, y: 404 }

function passage(): Simulator {
  const simulator = new Simulator(new Terrain(GROUND, WALLS))
  simulator.addTurret(STRUCTURE, bulwark, CORE_AT, 2)
  simulator.addPlayer(ME, 'p1', 'One', { x: 300, y: 430 }, walker, 1)
  return simulator
}

test('the passage is a squeeze the walker fits through, with the way round the corner inside the structure', () => {
  const terrain = new Terrain(GROUND, WALLS)
  const gap = distanceBetween(CORE_AT, CORNER) - bulwark.champion.radius
  assert.ok(gap > walker.radius * 2, `the walker fits between the structure and the corner (${gap} wide for ${walker.radius * 2})`)
  // From the corner of the block, on the near side, the way on is round the corner of it.
  const route = terrain.path({ x: 440, y: 415 }, { x: 800, y: 500 }, walker.radius)
  assert.ok(route && route.length >= 2, 'it has to go round the corner')
  assert.ok(distanceBetween(route[0], CORE_AT) < REACH, 'and the first point of the way is inside the structure')
})

test('a champion walks past a structure that stands in the way round a corner, instead of pressing against it for good', () => {
  const simulator = passage()
  simulator.addOrder(ME, move(2, { x: 800, y: 500 }))
  const arrived = where(simulator, 240)
  assert.ok(distanceBetween(arrived, { x: 800, y: 500 }) < 1, `it got through (it is at ${arrived.x}, ${arrived.y})`)
})

test('and it can be told to walk away from the structure it is against, and goes', () => {
  const simulator = passage()
  // Into the mouth of the passage, where it is pressed against the structure.
  simulator.addOrder(ME, move(2, CORE_AT))
  const against = where(simulator, 120)
  assert.ok(distanceBetween(against, CORE_AT) > REACH - 3, 'it is against the structure, not in it')
  simulator.addOrder(ME, move(121, { x: 800, y: 500 }))
  const away = where(simulator, 360)
  assert.ok(distanceBetween(away, { x: 800, y: 500 }) < 1, `and from there it walks on (it is at ${away.x}, ${away.y})`)
})

// ---------------------------------------------------------------------------- a structure it cannot be pushed out of

// A structure against the edge of the arena, and a champion in the gap between it and the edge: the push from the structure's middle is into the edge, which holds it.
test('a champion between a structure and the edge of the arena is put on the nearest place it can stand', () => {
  const simulator = new Simulator(new Terrain({ width: 1000, height: 800 }))
  simulator.addTurret(STRUCTURE, bulwark, { x: bulwark.champion.radius, y: 400 }, 2)
  simulator.addPlayer(ME, 'p1', 'One', { x: walker.radius, y: 400 }, walker, 1)
  const start = where(simulator, 0)
  assert.ok(distanceBetween(start, { x: bulwark.champion.radius, y: 400 }) < REACH - walker.radius * GAME_STRUCTURE_EJECT_DEPTH, 'it starts deep in the structure')
  const out = where(simulator, 30)
  assert.ok(distanceBetween(out, { x: bulwark.champion.radius, y: 400 }) >= REACH - 1e-6, `it is out of the structure (${distanceBetween(out, { x: bulwark.champion.radius, y: 400 })} from its middle, and ${REACH} to be clear)`)
  assert.ok(out.x >= walker.radius && out.y >= walker.radius && out.y <= 800 - walker.radius, 'and in the arena')
  assert.deepEqual(where(simulator, 120), out, 'where it stays')
})

test('the same against a wall', () => {
  const wall: Rect = { x: 0, y: 0, width: 300, height: 1000 }
  const simulator = new Simulator(new Terrain({ width: 1000, height: 800 }, [wall]))
  const middle: Vector2 = { x: wall.width + bulwark.champion.radius, y: 400 }
  simulator.addTurret(STRUCTURE, bulwark, middle, 2)
  simulator.addPlayer(ME, 'p1', 'One', { x: wall.width + walker.radius, y: 400 }, walker, 1)
  const out = where(simulator, 30)
  assert.ok(distanceBetween(out, middle) >= REACH - 1e-6, `it is out of the structure (${distanceBetween(out, middle)} from its middle, and ${REACH} to be clear)`)
  assert.ok(out.x >= wall.width + walker.radius - 1e-6, 'and not in the wall')
})

test('a champion that walks into a structure in the open is not moved by any of this: it is pressed against it and no further, and pushed out as before', () => {
  const simulator = new Simulator(new Terrain({ width: 1000, height: 800 }))
  const middle: Vector2 = { x: 600, y: 400 }
  simulator.addTurret(STRUCTURE, bulwark, middle, 2)
  simulator.addPlayer(ME, 'p1', 'One', { x: 400, y: 400 }, walker, 1)
  simulator.addOrder(ME, move(2, middle))
  let last = where(simulator, 1)
  const step = walkingSpeed(walker.moveSpeed) / 60
  for (let tick = 2; tick <= 200; tick += 1) {
    const now = where(simulator, tick)
    assert.ok(distanceBetween(now, last) <= step + 1e-6, `tick ${tick}: no jump (${distanceBetween(now, last)} moved, ${step} a step)`)
    last = now
  }
  assert.ok(distanceBetween(last, middle) >= REACH - 3, 'and it is against the structure, not in it')
})
