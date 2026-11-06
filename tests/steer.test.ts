import assert from 'node:assert/strict'
import test from 'node:test'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  abilityDefs,
  BACK_ABILITY_ID,
  DIRECTION_LENGTH_TOLERANCE,
  distanceBetween,
  GAME_TPS,
  GameOrderSchema,
  GameSnapshotSchema,
  isValidSteerDirection,
  Simulator,
  statBuff,
  Terrain,
  walkingSpeed,
  type CharacterOrder,
  type Rect,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineAbility, defineChampion } from './fixtures.ts'
import { testSpawns } from './test-spawns.ts'

// Steering (the movement keys): a steer order walks a champion along a direction until it is told something else, a stop ({0, 0}) ends it, and a direction that is
// not a unit vector is refused by the server and by the simulator. The champions and the abilities here are the tests' own.

const focus = defineAbility({ id: 't-st-focus', targeting: 'none', range: 0, windUpTicks: 12, cooldownTicks: 600, apply: [statBuff('attackSpeed', 1, 30)] })
const walker = defineChampion({
  id: 't-st-walker',
  name: 'Steer Walker',
  base: { maxHp: 1000, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 300,
  radius: 20,
  attackRange: 150,
  attackWindup: 0.3,
  abilities: [focus.id],
})
const dummy = defineChampion({
  id: 't-st-dummy',
  name: 'Steer Dummy',
  base: { maxHp: 100_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 100,
  attackWindup: 0,
  abilities: [],
})

const ARENA = { width: 3000, height: 2000 }
const START: Vector2 = { x: 1000, y: 1000 }
const ME = 1
const FOE = 2
// How far the walker walks in a tick, as the game works it out.
const STEP = walkingSpeed(walker.moveSpeed) / GAME_TPS
const RIGHT: Vector2 = { x: 1, y: 0 }
const STOP: Vector2 = { x: 0, y: 0 }

let sequence = 0
const steer = (tick: number, direction: Vector2, extra: { keepAuto?: boolean; keepCast?: boolean } = {}): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'steer', direction, ...extra })
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const cast = (tick: number, abilityId: string, origin: Vector2): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target: { mode: 'none' }, origin: { ...origin } })

function scene(orders: CharacterOrder[], walls: Rect[] = [], foeAt?: Vector2): Simulator {
  const simulator = new Simulator(new Terrain(ARENA, walls))
  simulator.addPlayer(ME, 'p1', 'One', START, walker, 1)
  if (foeAt) simulator.addPlayer(FOE, 'p2', 'Two', foeAt, dummy, 2)
  for (const order of orders) simulator.addOrder(ME, order)
  return simulator
}
// Where the walker is, and the way it is steered, on each tick up to `last`, read in one pass forward (the simulator keeps only so many frames back).
function run(simulator: Simulator, last: number) {
  const positions: Vector2[] = []
  const steering: Array<Vector2 | undefined> = []
  const actions: Array<string | undefined> = []
  for (let tick = 0; tick <= last; tick += 1) {
    const state = simulator.at(tick).get(ME)
    positions[tick] = state?.getPosition() as Vector2
    steering[tick] = state?.getSteerDirection()
    actions[tick] = state?.getAction()?.kind
  }
  return { at: (tick: number) => positions[tick], steering: (tick: number) => steering[tick], action: (tick: number) => actions[tick] }
}
const near = (actual: number, expected: number, what: string): void => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} against ${expected}`)

// ---------------------------------------------------------------------------- the direction

test('a direction to steer by is a unit vector, to within the tolerance, or none, and nothing else', () => {
  for (const good of [RIGHT, { x: 0, y: -1 }, { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, STOP, { x: 1 + DIRECTION_LENGTH_TOLERANCE / 4, y: 0 }]) {
    assert.equal(isValidSteerDirection(good), true, JSON.stringify(good))
  }
  for (const bad of [{ x: 2, y: 0 }, { x: 0.5, y: 0 }, { x: 1e-6, y: 0 }, { x: 1, y: 1 }, { x: Number.NaN, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 }]) {
    assert.equal(isValidSteerDirection(bad), false, JSON.stringify(bad))
  }
})

test('a steer is an order of its own, which a stop is too, and a snapshot of a steered champion reads back as it was', () => {
  assert.equal(GameOrderSchema.safeParse(steer(1, RIGHT)).success, true)
  assert.equal(GameOrderSchema.safeParse(steer(1, STOP)).success, true)
  const simulator = scene([steer(1, RIGHT)])
  simulator.advanceTo(10)
  simulator.setCommitTick(5)
  const snapshot = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(simulator.snapshot())))
  const client = new Simulator()
  client.replaceFromSnapshot(snapshot)
  assert.deepEqual(client.at(10).get(ME)?.getSteerDirection(), RIGHT)
  assert.deepEqual(client.at(20).get(ME)?.getPosition(), simulator.at(20).get(ME)?.getPosition())
})

// ---------------------------------------------------------------------------- walking it

test('a steered champion walks a tick\'s walk along its direction each tick, and goes on doing it: it is never anywhere it was going', () => {
  const { at, steering } = run(scene([steer(1, RIGHT)]), 120)
  for (const tick of [5, 30, 119]) {
    near(at(tick + 1).x - at(tick).x, STEP, `the step at tick ${tick}`)
    near(at(tick + 1).y, START.y, `straight along at tick ${tick}`)
  }
  assert.deepEqual(steering(120), RIGHT, 'it is still steered')
})

test('steering on a slant is as fast as steering straight, and a direction a little off its length is walked at the champion\'s own speed', () => {
  const slant = run(scene([steer(1, { x: Math.SQRT1_2, y: Math.SQRT1_2 })]), 30)
  near(distanceBetween(slant.at(20), slant.at(21)), STEP, 'on a slant')
  // The tolerance is on the squared length, so a quarter of it on the length is well inside.
  const long = run(scene([steer(1, { x: 1 + DIRECTION_LENGTH_TOLERANCE / 4, y: 0 })]), 30)
  near(long.at(21).x - long.at(20).x, STEP, 'a little long')
  assert.deepEqual(long.steering(30), RIGHT, 'it is kept as a unit vector')
})

test('a stop ends steering where the champion is', () => {
  const { at, steering } = run(scene([steer(1, RIGHT), steer(20, STOP)]), 40)
  assert.equal(steering(20), undefined)
  assert.deepEqual(at(40), at(20), 'it stands where it was stopped')
})

test('a stop does nothing to a champion that is not steered: a walk to a place goes on', () => {
  const goal = { x: START.x + 50 * STEP, y: START.y }
  const simulator = scene([move(1, goal), steer(5, STOP)])
  const { at } = run(simulator, 80)
  assert.deepEqual(at(80), goal, 'it got where it was going')
})

test('a direction that is not one is refused by the simulator too, and changes nothing', () => {
  for (const bad of [{ x: 2, y: 0 }, { x: 0.5, y: 0 }, { x: Number.NaN, y: 0 }]) {
    const { at, steering } = run(scene([steer(1, bad)]), 20)
    assert.deepEqual(at(20), START, JSON.stringify(bad))
    assert.equal(steering(20), undefined)
  }
  // Nor does one stop a steer that is under way.
  const { steering } = run(scene([steer(1, RIGHT), steer(5, { x: 3, y: 0 })]), 10)
  assert.deepEqual(steering(10), RIGHT)
})

test('a champion steered into a wall slides along it, and never into it', () => {
  // A wall to the right, which the champion starts against, and a steer up and into it.
  const wall: Rect = { x: START.x + walker.radius, y: 0, width: 200, height: ARENA.height }
  const { at } = run(scene([steer(1, { x: Math.SQRT1_2, y: -Math.SQRT1_2 })], [wall]), 60)
  for (const tick of [10, 30, 60]) assert.ok(at(tick).x <= wall.x - walker.radius + 1e-6, `it is not in the wall at tick ${tick}: ${at(tick).x}`)
  assert.ok(START.y - at(60).y > 40 * STEP * Math.SQRT1_2, `it went on up along it: ${START.y - at(60).y}`)
})

// ---------------------------------------------------------------------------- what it does to the rest

test('a cast with a windup holds steering up, and the champion walks on after it', () => {
  const castAt = 10
  const launch = castAt + focus.windUpTicks
  const simulator = scene([steer(1, RIGHT), cast(castAt, focus.id, { x: START.x + (castAt - 2) * STEP, y: START.y })])
  const { at, steering, action } = run(simulator, launch + 10)
  assert.equal(action(castAt), 'cast', 'the cast was made')
  assert.deepEqual(at(launch), at(castAt + 1), 'it stood while casting')
  assert.deepEqual(steering(launch), RIGHT, 'still steered')
  near(at(launch + 5).x - at(launch + 4).x, STEP, 'and walks on after it')
})

test('Back ends steering: the champion is taken home and stands there', () => {
  const def = abilityDefs.get(BACK_ABILITY_ID)
  assert.ok(def)
  const backAt = 10
  const simulator = scene([steer(1, RIGHT), cast(backAt, BACK_ABILITY_ID, { x: START.x + (backAt - 2) * STEP, y: START.y })])
  const done = backAt + def.windUpTicks
  const { at, steering } = run(simulator, done + 10)
  assert.equal(steering(backAt), undefined)
  assert.deepEqual(at(done + 10), START, 'home, and standing')
})

test('a walk to a place or an attack takes over from steering', () => {
  const goal = { x: START.x, y: START.y + 20 * STEP }
  const walked = run(scene([steer(1, RIGHT), move(10, goal)]), 60)
  assert.equal(walked.steering(10), undefined)
  assert.deepEqual(walked.at(60), goal)

  const foeAt = { x: START.x - 600, y: START.y }
  const attacked = scene([steer(1, RIGHT), attack(10, FOE)], [], foeAt)
  run(attacked, 10)
  assert.equal(attacked.at(10).get(ME)?.getSteerDirection(), undefined)
  assert.equal(attacked.at(10).get(ME)?.getAttackTarget(), FOE)
})

test('a steer cancels an auto attack winding up unless it keeps it, as a walk does', () => {
  const foeAt = { x: START.x + walker.attackRange / 2, y: START.y }
  const hitAt = 1 + walker.attackWindupTicks
  assert.ok(hitAt > 3, 'there is a windup to steer in the middle of')
  const hits = (keepAuto: boolean): number => {
    const simulator = scene([attack(1, FOE), steer(hitAt - 1, { x: 0, y: 1 }, { keepAuto })], [], foeAt)
    const before = simulator.at(0).get(FOE)?.getHealth() ?? 0
    for (let tick = 1; tick <= hitAt + 2; tick += 1) simulator.at(tick)
    return before - (simulator.at(hitAt + 2).get(FOE)?.getHealth() ?? 0)
  }
  assert.equal(hits(false), 0, 'cancelled')
  assert.ok(hits(true) > 0, 'kept, and it landed')
})

// ---------------------------------------------------------------------------- the server

test('the server takes a steer with a unit direction or a stop, and refuses any other without sending it on', () => {
  const game = new ServerGameState(testSpawns)
  const players = [{ id: 'player-1', name: 'One' }, { id: 'player-2', name: 'Two' }]
  game.beginSelection(players)
  game.lockChampion('player-1')
  game.lockChampion('player-2')
  game.begin(players)
  let seq = 0
  const give = (direction: Vector2) => game.acceptOrder('player-1', { id: `player-1:${++seq}`, seq, tick: 1, type: 'steer', direction })

  for (const good of [RIGHT, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, STOP]) {
    const verdict = give(good)
    assert.equal(verdict.ack.status, 'accepted', JSON.stringify(good))
    assert.ok(verdict.broadcast, 'and it is sent on')
  }
  for (const bad of [{ x: 2, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1e-6, y: 0 }, { x: Number.NaN, y: 0 }]) {
    const verdict = give(bad)
    assert.equal(verdict.ack.status, 'rejected', JSON.stringify(bad))
    assert.equal(verdict.ack.reason, 'bad_direction')
    assert.equal(verdict.broadcast, undefined, 'and it is sent to no one')
  }
})
