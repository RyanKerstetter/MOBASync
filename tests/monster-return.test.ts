import assert from 'node:assert/strict'
import test from 'node:test'
import { GAME_TPS, GameSnapshotSchema, Monster, monsters, Simulator, type MonsterDef, type Vector2 } from '../packages/shared/src/index.ts'
import { defineChampion, defineMonster } from './fixtures.ts'

// A monster going home (it has given up on whoever it was after, or has been pushed off its post) walks faster than it does otherwise, by its
// `returnSpeedMultiplier`, and is not held up on the way: it passes through every body, and none is pushed by it. So pulling a monster away from its
// camp, or standing in its way as it goes back, does not work as well. The monsters and players in these are the tests' own, with every number
// spelled out; the monsters of the game are only read.

const HOME = { x: 600, y: 700 }
const FAST = 3
const MONSTER = 10
const RUNNER = 1
const BYSTANDER = 2

const walker = {
  name: 'Walker',
  base: { maxHp: 100_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: [],
} as const
// It notices no one and goes after whoever hurts it, and gives up quickly once it is 200 from home.
const ai = { aggroRange: 0, deaggroRange: 200, deaggroTicks: 30 }
const plain = defineMonster({ ...walker, id: 't-mr-plain', ai })
const fast = defineMonster({ ...walker, id: 't-mr-fast', ai: { ...ai, returnSpeedMultiplier: FAST } })
const runner = defineChampion({
  id: 't-mr-runner', name: 'Runner', base: { maxHp: 100_000, attackDamage: 1, attackSpeed: 1 }, moveSpeed: 250, radius: 20, attackRange: 150, attackWindup: 0, abilities: [],
})
const bystander = defineChampion({
  id: 't-mr-bystander', name: 'Bystander', base: { maxHp: 100_000, attackDamage: 1, attackSpeed: 1 }, moveSpeed: 300, radius: 20, attackRange: 50, attackWindup: 0, abilities: [],
})

const hit = { id: 'hit', seq: 1, tick: 1, type: 'attack' as const, targetId: MONSTER }
const run = { id: 'run', seq: 2, tick: 20, type: 'move' as const, target: { x: 2300, y: HOME.y } }

function world(monster: Monster, withBystander = false): Simulator {
  const simulator = new Simulator()
  simulator.addMonster(MONSTER, monster, HOME)
  // The runner hits it from 140 away, which is beyond its aggro range, and runs east, so it follows and gives up.
  simulator.addPlayer(RUNNER, 'p1', 'Runner', { x: HOME.x + 140, y: HOME.y }, runner, 1)
  simulator.addOrder(RUNNER, hit)
  simulator.addOrder(RUNNER, run)
  // Well out of the way, for as long as it takes the monster to get far from home.
  if (withBystander) simulator.addPlayer(BYSTANDER, 'p2', 'Bystander', { x: HOME.x + 100, y: HOME.y + 500 }, bystander, 3)
  return simulator
}

type Trace = {
  mode: Array<string | undefined>
  monster: Vector2[]
  bystander: Vector2[]
  // The first tick it was going home on, where it was then, and the first tick it was idle again after.
  returnStart: number
  startedAt: Vector2
  arrived: number
}

// Plays the game a tick at a time and writes down what the monster and the bystander did, indexed by tick (the simulator keeps only the last few frames).
function trace(simulator: Simulator, last = 600, beforeTick?: (tick: number) => void): Trace {
  const found: Trace = { mode: [], monster: [], bystander: [], returnStart: -1, startedAt: HOME, arrived: -1 }
  for (let tick = 1; tick <= last; tick += 1) {
    beforeTick?.(tick)
    simulator.advanceTo(tick)
    const state = simulator.at(tick).get(MONSTER)
    found.mode[tick] = state?.getAi()?.mode
    found.monster[tick] = state?.getPosition() as Vector2
    found.bystander[tick] = simulator.at(tick).get(BYSTANDER)?.getPosition() as Vector2
    if (found.returnStart < 0 && found.mode[tick] === 'return') {
      found.returnStart = tick
      found.startedAt = found.monster[tick]
    }
    if (found.returnStart >= 0 && found.arrived < 0 && found.mode[tick] === 'idle') found.arrived = tick
  }
  assert.ok(found.returnStart > 0, 'it gave up and went home')
  assert.ok(found.arrived > found.returnStart, 'and got there')
  return found
}
const between = (a: Vector2, b: Vector2): number => Math.hypot(a.x - b.x, a.y - b.y)

// How far it went on each tick of its walk home, leaving out the tick it set off on and the last, which stops at its door.
function stepsHome(found: Trace): number[] {
  const steps: number[] = []
  for (let tick = found.returnStart + 1; tick < found.arrived; tick += 1) steps.push(between(found.monster[tick], found.monster[tick - 1]))
  return steps
}

// ---------------------------------------------------------------------------- the setting

test('a return speed is a number more than 0, and a monster that says none walks home no faster than it walks', () => {
  const def = (returnSpeedMultiplier: number): MonsterDef => ({ ...walker, id: 't-mr-bad', ai: { ...ai, returnSpeedMultiplier } })
  for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new Monster(def(bad)), /Monster "t-mr-bad" needs a positive return speed multiplier/, String(bad))
  }
  assert.equal(new Monster(def(FAST)).ai.returnSpeedMultiplier, FAST)
  assert.equal(plain.ai.returnSpeedMultiplier, 1, 'with none given, 1')
})

test('every monster in the game goes home faster than it walks', () => {
  assert.ok(monsters.size > 0)
  for (const monster of monsters.values()) {
    if (monster.id.startsWith('t-')) continue
    assert.ok(monster.ai.returnSpeedMultiplier > 1, `${monster.name} is faster on its way home`)
  }
})

// ---------------------------------------------------------------------------- faster

test('a monster going home walks at its return speed times its own, and walks as before the rest of the time', () => {
  for (const [monster, multiplier] of [[plain, 1], [fast, FAST]] as const) {
    const found = trace(world(monster))
    const homeStep = monster.champion.moveSpeed * multiplier / GAME_TPS
    const steps = stepsHome(found)
    assert.ok(steps.length >= 5, `it took a while to get there (${steps.length} ticks)`)
    for (const step of steps) assert.ok(Math.abs(step - homeStep) < 1e-6, `${monster.name} x${multiplier}: ${step} is not ${homeStep}`)
    // Chasing, it is as slow as ever: it goes no faster than its own speed.
    const chasing = found.monster.slice(30, found.returnStart - 1).map((at, index) => between(at, found.monster[30 + index - 1] ?? at))
    assert.ok(chasing.length > 0 && chasing.every((step) => step <= monster.champion.moveSpeed / GAME_TPS + 1e-6), 'and no faster on the way out')
  }
})

test('it is home sooner for it: the same walk takes that many times fewer ticks', () => {
  const slow = trace(world(plain))
  const quick = trace(world(fast))
  assert.equal(quick.returnStart, slow.returnStart, 'it gave up on the same tick, as only its way home is faster')
  assert.deepEqual(quick.startedAt, slow.startedAt)
  const slowWalk = slow.arrived - slow.returnStart
  const quickWalk = quick.arrived - quick.returnStart
  assert.ok(Math.abs(quickWalk * FAST - slowWalk) <= FAST + 1, `${quickWalk} ticks at ${FAST} times the speed, against ${slowWalk}`)
})

// ---------------------------------------------------------------------------- not held up

test('no one can stand in the way of a monster going home: it passes through them, they are not pushed, and it gets there as soon as it would have anyway', () => {
  for (const monster of [plain, fast]) {
    const clear = trace(world(monster))
    // The bystander walks to the middle of the way home, getting there as it sets off, and stands there.
    const spot = { x: (clear.startedAt.x + HOME.x) / 2, y: (clear.startedAt.y + HOME.y) / 2 }
    const blocked = world(monster, true)
    blocked.addOrder(BYSTANDER, { id: 'stand', seq: 1, tick: Math.max(2, clear.returnStart - 130), type: 'move', target: spot })
    const found = trace(blocked)
    assert.equal(found.returnStart, clear.returnStart, 'nothing changed before it set off')
    assert.deepEqual(found.bystander[found.returnStart], spot, 'the bystander was there before it came')
    // It went right through them, so they were on top of each other for some ticks.
    let closest = Infinity
    for (let tick = found.returnStart; tick <= found.arrived; tick += 1) closest = Math.min(closest, between(found.monster[tick], found.bystander[tick]))
    assert.ok(closest < monster.champion.radius + bystander.radius, `it went through them (${closest.toFixed(1)} apart at the nearest)`)
    // And neither was pushed for it, nor was it held up.
    for (let tick = found.returnStart; tick <= found.arrived; tick += 1) assert.deepEqual(found.bystander[tick], spot, `tick ${tick}: not pushed`)
    assert.equal(found.arrived, clear.arrived, `${monster.name} got home on the same tick as with no one in its way`)
    assert.deepEqual(found.monster.slice(found.returnStart, found.arrived + 1), clear.monster.slice(clear.returnStart, clear.arrived + 1), 'by the same way')
  }
})

test('anyone else still holds it up and is pushed by it: a monster that is not going home is as solid as ever', () => {
  const simulator = new Simulator()
  simulator.addMonster(MONSTER, plain, HOME)
  simulator.addPlayer(BYSTANDER, 'p2', 'Bystander', { x: HOME.x + 10, y: HOME.y }, bystander, 3)
  const before = between(HOME, { x: HOME.x + 10, y: HOME.y })
  simulator.advanceTo(15)
  const monster = simulator.at(15).get(MONSTER)
  assert.equal(monster?.getAi()?.mode, 'idle', 'it is not going anywhere')
  const apart = between(monster?.getPosition() as Vector2, simulator.at(15).get(BYSTANDER)?.getPosition() as Vector2)
  assert.ok(apart > before, `they were pushed apart (${apart.toFixed(1)} from ${before})`)
})

// ---------------------------------------------------------------------------- the same on every peer

test('a late order that is worked out across the walk home, and a snapshot from during it, give the same frames as a game that was straight', () => {
  const frameAt = (simulator: Simulator, tick: number): unknown => JSON.parse(JSON.stringify(simulator.at(tick).toData()))
  const straight = trace(world(fast))
  const check = straight.returnStart + 10
  const expectedWorld = world(fast)
  expectedWorld.advanceTo(check)
  const expected = frameAt(expectedWorld, check)

  // The order to run reaches it late, after the game has moved on.
  const redone = new Simulator()
  redone.addMonster(MONSTER, fast, HOME)
  redone.addPlayer(RUNNER, 'p1', 'Runner', { x: HOME.x + 140, y: HOME.y }, runner, 1)
  redone.addOrder(RUNNER, hit)
  redone.advanceTo(30)
  assert.equal(redone.addOrder(RUNNER, run), true, 'an order for a tick already worked out')
  redone.advanceTo(check)
  assert.deepEqual(frameAt(redone, check), expected)

  // A page that joins while it is walking home plays on from a snapshot.
  const original = world(fast)
  original.advanceTo(straight.returnStart + 5)
  original.setCommitTick(straight.returnStart - 5)
  const joined = new Simulator()
  joined.replaceFromSnapshot(GameSnapshotSchema.parse(JSON.parse(JSON.stringify(original.snapshot()))))
  joined.advanceTo(check)
  assert.deepEqual(frameAt(joined, check), expected)
})
