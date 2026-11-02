import assert from 'node:assert/strict'
import test from 'node:test'
import { Color } from 'pixi.js'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { IndicatorLayer, OUT_OF_REACH_COLOR } from '../apps/client/src/render/indicator-layer.ts'
import {
  damage,
  GAME_TPS,
  GameSnapshotSchema,
  silence,
  Simulator,
  stun,
  targetUnit,
  withinCastRange,
  type CharacterOrder,
  type GameFrameAction,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineAbility, defineChampion, killAt } from './fixtures.ts'

// An ability aimed at an enemy out of its reach is not dropped: the caster goes after the enemy as it would to attack it, casts once it is in reach, and
// is done. The abilities and champions here are the tests' own ("t-follow-..."), so retuning the game changes none of this.

const HOME: Vector2 = { x: 400, y: 600 }
const WALKER_SPEED = 240
const DUMMY_SPEED = 120
const MAX_HP = 1_000_000
const ATTACK_DAMAGE = 7
const POKE_DAMAGE = 300
const HEX_DAMAGE = 450
const STEP = WALKER_SPEED / GAME_TPS

// One that casts on the spot, and one that winds up first.
const poke = defineAbility({
  id: 't-follow-poke',
  targeting: 'unit',
  range: 200,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: 5 * GAME_TPS,
  apply: [damage(POKE_DAMAGE, targetUnit())],
})
const hex = defineAbility({
  id: 't-follow-hex',
  targeting: 'unit',
  range: 260,
  windUpTicks: 12,
  backswingTicks: 6,
  cooldownTicks: 5 * GAME_TPS,
  apply: [damage(HEX_DAMAGE, targetUnit())],
})
// What an enemy does to stun the caster from where it stands.
const JOLT_TICKS = 2 * GAME_TPS
const jolt = defineAbility({
  id: 't-follow-jolt',
  targeting: 'unit',
  range: 1000,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: 10 * GAME_TPS,
  apply: [stun(JOLT_TICKS, targetUnit())],
})
// What an enemy does to silence the caster from where it stands.
const gag = defineAbility({
  id: 't-follow-gag',
  targeting: 'unit',
  range: 1000,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: 10 * GAME_TPS,
  apply: [silence(2 * GAME_TPS, targetUnit())],
})
const walker = defineChampion({
  id: 't-follow-walker',
  name: 'Test Walker',
  base: { maxHp: MAX_HP, attackDamage: ATTACK_DAMAGE, attackSpeed: 1 },
  moveSpeed: WALKER_SPEED,
  radius: 18,
  attackRange: 80,
  attackWindup: 0,
  abilities: [poke.id, hex.id],
})
const dummy = defineChampion({
  id: 't-follow-dummy',
  name: 'Test Dummy',
  base: { maxHp: MAX_HP, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: DUMMY_SPEED,
  radius: 18,
  attackRange: 40,
  attackWindup: 0,
  abilities: [],
})
const gagger = defineChampion({
  id: 't-follow-gagger',
  name: 'Test Gagger',
  base: { maxHp: MAX_HP, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: DUMMY_SPEED,
  radius: 18,
  attackRange: 40,
  attackWindup: 0,
  abilities: [gag.id, jolt.id],
})

// The walker is character 1 and the dummy character 2, `gap` to its east. Everyone is on a team of their own unless told.
function scene(gap: number): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'Walker', HOME, walker)
  simulator.addPlayer(2, 'p2', 'Dummy', { x: HOME.x + gap, y: HOME.y }, dummy)
  return simulator
}

let sequence = 0
const castAt = (tick: number, abilityId: string, unitId: number, origin: Vector2 = HOME): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target: { mode: 'unit', unitId }, origin: { ...origin } })
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })

const distance = (left: Vector2, right: Vector2): number => Math.hypot(left.x - right.x, left.y - right.y)

// What the walker and the dummy were doing on a tick. The simulator keeps only the last few frames, so a test plays the game through once and reads this.
type Moment = {
  walker: Vector2
  enemy: Vector2
  enemyHp: number
  lock: number | undefined
  action: GameFrameAction | undefined
  poke: boolean
  hex: boolean
}
type Trace = Map<number, Moment>
// Plays the simulator on from the tick after `from`, one tick at a time, and notes each.
function play(simulator: Simulator, until: number, from = 0): Trace {
  const trace: Trace = new Map()
  for (let tick = from + 1; tick <= until; tick += 1) {
    const frame = simulator.at(tick)
    const walking = frame.get(1)
    trace.set(tick, {
      walker: walking?.getPosition() ?? HOME,
      enemy: frame.get(2)?.getPosition() ?? HOME,
      enemyHp: frame.get(2)?.getHealth() ?? 0,
      lock: walking?.getAttackTarget(),
      action: walking?.getAction(),
      poke: walking?.getAbilityCooldown(poke.id).ready ?? false,
      hex: walking?.getAbilityCooldown(hex.id).ready ?? false,
    })
  }
  return trace
}
const at = (trace: Trace, tick: number): Moment => {
  const moment = trace.get(tick)
  if (!moment) throw new Error(`Tick ${tick} was not played.`)
  return moment
}
// The first tick on which a moment is so, if any.
const firstTick = (trace: Trace, is: (moment: Moment) => boolean): number | undefined =>
  [...trace].find(([, moment]) => is(moment))?.[0]
// The tick the poke was cast on: the first on which it is on cooldown. The hex's windup begins on the first tick it has an action.
const pokeCast = (trace: Trace): number | undefined => firstTick(trace, (moment) => !moment.poke)
const hexBegun = (trace: Trace): number | undefined => firstTick(trace, (moment) => moment.action?.kind === 'cast')

test('the test abilities reach further than the walker\'s attack, so a cast that is made is not an attack', () => {
  assert.ok(poke.range > walker.attackRange)
  assert.ok(hex.range > walker.attackRange)
})

test('an ability aimed at an enemy out of its reach walks the caster up to it and casts on reaching it', () => {
  const simulator = scene(poke.range + 400)
  simulator.addOrder(1, castAt(1, poke.id, 2))
  const trace = play(simulator, 600)

  const fired = pokeCast(trace)
  assert.ok(fired !== undefined && fired > 1, 'it was not cast on the tick it was ordered')
  assert.ok(distance(at(trace, fired - 1).walker, at(trace, fired - 1).enemy) > poke.range, 'the tick before it was still out of reach')
  assert.ok(withinCastRange(at(trace, fired).walker, at(trace, fired).enemy, poke.range), 'and it is cast the moment it is in reach')
  assert.ok(distance(at(trace, fired).walker, at(trace, fired).enemy) > poke.range - 2 * STEP, 'not after walking on past it')
  assert.equal(at(trace, fired).enemyHp, MAX_HP - POKE_DAMAGE, 'it hit')
  assert.equal(at(trace, fired).lock, undefined, 'and that is the end of going after it')

  // Done: it stands where it cast, does not swing at the enemy, and does not cast again until the cooldown is up.
  const later = at(trace, fired + 2 * GAME_TPS)
  assert.deepEqual(later.walker, at(trace, fired).walker, 'it stopped')
  assert.equal(later.enemyHp, MAX_HP - POKE_DAMAGE, 'and did nothing more to it')
})

test('an ability with a windup begins it on reaching the enemy, and stands still through it', () => {
  const simulator = scene(hex.range + 400)
  simulator.addOrder(1, castAt(1, hex.id, 2))
  const trace = play(simulator, 600)

  const begun = hexBegun(trace)
  assert.ok(begun !== undefined && begun > 1)
  assert.ok(withinCastRange(at(trace, begun).walker, at(trace, begun).enemy, hex.range), 'begun in reach')
  assert.ok(distance(at(trace, begun - 1).walker, at(trace, begun - 1).enemy) > hex.range, 'and not before')
  const launch = at(trace, begun).action?.launchTick
  assert.equal(launch, begun + hex.windUpTicks)
  assert.equal(at(trace, (launch as number) - 1).enemyHp, MAX_HP, 'nothing before the windup is out')
  assert.equal(at(trace, launch as number).enemyHp, MAX_HP - HEX_DAMAGE, 'and the hit when it is')
  assert.deepEqual(at(trace, launch as number).walker, at(trace, begun).walker, 'it did not walk on while winding up')
})

test('an enemy in reach already, or exactly on the edge of it, is cast on at once without a step', () => {
  for (const gap of [poke.range - 10, poke.range]) {
    const simulator = scene(gap)
    simulator.addOrder(1, castAt(1, poke.id, 2))
    const trace = play(simulator, 60)
    assert.equal(pokeCast(trace), 1, `a gap of ${gap}: cast on the tick it was ordered`)
    assert.deepEqual(at(trace, 30).walker, HOME, 'and it never moved')
    assert.equal(at(trace, 1).lock, undefined, 'with nothing to go after')
  }
})

test('an enemy a hair out of reach is walked up to the shortest way and cast on', () => {
  const simulator = scene(poke.range + 1)
  simulator.addOrder(1, castAt(1, poke.id, 2))
  const fired = pokeCast(play(simulator, 60))
  assert.ok(fired !== undefined && fired > 1, 'it took a step')
  assert.ok(fired <= 2 + Math.ceil(1 / STEP), 'and no more than the one it needed')
})

test('it goes after an enemy that walks away, and casts when it catches up', () => {
  const start = poke.range + 200
  const simulator = scene(start)
  simulator.addOrder(2, move(1, { x: HOME.x + 3000, y: HOME.y }))
  simulator.addOrder(1, castAt(1, poke.id, 2))
  const trace = play(simulator, 1200)

  const fired = pokeCast(trace)
  assert.ok(fired !== undefined, 'it caught the enemy up')
  assert.ok(at(trace, fired).enemy.x > HOME.x + start + STEP, 'which had moved on in the meantime')
  assert.ok(withinCastRange(at(trace, fired).walker, at(trace, fired).enemy, poke.range))
  assert.equal(at(trace, fired).enemyHp, MAX_HP - POKE_DAMAGE)
})

test('being told to walk anywhere ends it, and the ability is not cast', () => {
  const simulator = scene(poke.range + 600)
  const north: Vector2 = { x: HOME.x, y: HOME.y - 200 }
  simulator.addOrder(1, castAt(1, poke.id, 2))
  simulator.addOrder(1, move(20, north))
  const trace = play(simulator, 900)

  assert.equal(at(trace, 19).lock, 2, 'going after it until then')
  assert.equal(at(trace, 20).lock, undefined)
  assert.equal(pokeCast(trace), undefined, 'never cast')
  assert.equal(at(trace, 900).enemyHp, MAX_HP)
  assert.ok(distance(at(trace, 900).walker, north) < 1, 'it went where it was told')
})

test('being told to attack ends it: it attacks the enemy instead of casting on it', () => {
  const simulator = scene(poke.range + 600)
  simulator.addOrder(1, castAt(1, poke.id, 2))
  simulator.addOrder(1, attack(20, 2))
  const trace = play(simulator, 900)

  assert.equal(pokeCast(trace), undefined, 'the ability was never cast')
  const lost = MAX_HP - at(trace, 900).enemyHp
  assert.ok(lost > 0 && lost % ATTACK_DAMAGE === 0, 'but it was attacked')
})

test('an enemy that dies on the way ends it', () => {
  const simulator = scene(poke.range + 800)
  simulator.addOrder(1, castAt(1, poke.id, 2))
  killAt(simulator, 2, 40)
  const trace = play(simulator, 600)

  assert.equal(at(trace, 30).lock, 2, 'going after it')
  assert.equal(at(trace, 60).lock, undefined, 'and not once it is gone')
  assert.equal(pokeCast(trace), undefined, 'with nothing cast on it')
})

test('a silence on the way calls it off and stops the walk, as the ability cannot be cast', () => {
  const gaggerAt: Vector2 = { x: HOME.x, y: HOME.y + 300 }
  const simulator = scene(poke.range + 1200)
  simulator.addPlayer(3, 'p3', 'Gagger', gaggerAt, gagger)
  simulator.addOrder(1, castAt(1, poke.id, 2))
  simulator.addOrder(3, castAt(30, gag.id, 1, gaggerAt))
  const trace = play(simulator, 600)

  assert.equal(at(trace, 25).lock, 2)
  assert.equal(at(trace, 31).lock, undefined, 'called off the tick after the silence took hold')
  assert.deepEqual(at(trace, 100).walker, at(trace, 32).walker, 'and it stands where it was')
  assert.equal(pokeCast(trace), undefined)
})

test('a stun on the way holds the lock: the walk stops with it and goes on after it, to cast', () => {
  const gaggerAt: Vector2 = { x: HOME.x, y: HOME.y + 300 }
  const stunnedAt = 30
  const gap = poke.range + 1200
  const stunned = scene(gap)
  stunned.addPlayer(3, 'p3', 'Gagger', gaggerAt, gagger)
  stunned.addOrder(1, castAt(1, poke.id, 2))
  stunned.addOrder(3, castAt(stunnedAt, jolt.id, 1, gaggerAt))
  const trace = play(stunned, 900)
  const free = scene(gap)
  free.addOrder(1, castAt(1, poke.id, 2))
  const freeTrace = play(free, 900)

  const stillFrom = stunnedAt + 3
  const stillTo = stunnedAt + JOLT_TICKS - 3
  for (let tick = stillFrom; tick <= stillTo; tick += 1) assert.equal(at(trace, tick).lock, 2, `still going after it at ${tick}`)
  assert.deepEqual(at(trace, stillTo).walker, at(trace, stillFrom).walker, 'but standing where the stun caught it')
  const fired = pokeCast(trace)
  const firedFree = pokeCast(freeTrace)
  assert.ok(fired !== undefined && firedFree !== undefined, 'and it cast in the end')
  assert.ok(fired - firedFree >= JOLT_TICKS - 2, 'the stun cost it its length in time')
})

test('a stun that outlasts the enemy coming into reach holds the cast, and it is made when the stun is over', () => {
  const gaggerAt: Vector2 = { x: HOME.x, y: HOME.y + 300 }
  const stunnedAt = 2
  const simulator = scene(poke.range + 100)
  simulator.addPlayer(3, 'p3', 'Gagger', gaggerAt, gagger)
  simulator.addOrder(1, castAt(1, poke.id, 2))
  simulator.addOrder(3, castAt(stunnedAt, jolt.id, 1, gaggerAt))
  // The enemy walks at the stunned walker, and is in its reach well before the stun is over.
  simulator.addOrder(2, move(1, { x: HOME.x, y: HOME.y }))
  const trace = play(simulator, 400)

  const inReachAt = firstTick(trace, (moment) => withinCastRange(moment.walker, moment.enemy, poke.range))
  assert.ok(inReachAt !== undefined && inReachAt < stunnedAt + JOLT_TICKS - 10, 'in reach while it is still stunned')
  assert.equal(at(trace, inReachAt + 5).lock, 2, 'and the cast is waiting')
  assert.equal(pokeCast(trace) !== undefined && (pokeCast(trace) as number) > stunnedAt + JOLT_TICKS - 5, true, 'made once the stun is over')
  assert.equal(at(trace, 400).enemyHp, MAX_HP - POKE_DAMAGE)
})

test('casting the same ability on something else on the way calls the first off and stops the walk, as it is on cooldown', () => {
  // A second enemy is within the poke's reach of the walker a few steps into the walk, and the walker is cast on it from where it stands then.
  const gap = poke.range + 1200
  const steps = 3
  const nearby: Vector2 = { x: HOME.x + steps * STEP, y: HOME.y + poke.range / 2 }
  const simulator = scene(gap)
  simulator.addPlayer(3, 'p3', 'Nearby', nearby, dummy)
  simulator.addOrder(1, castAt(1, poke.id, 2))
  simulator.addOrder(1, castAt(1 + steps, poke.id, 3))
  const trace = play(simulator, 400)

  assert.equal(at(trace, steps).lock, 2, 'going after the first')
  assert.equal(pokeCast(trace), 1 + steps, 'the second was cast at once')
  assert.equal(at(trace, 2 + steps).lock, undefined, 'and the first is called off on the next tick, with the ability spent')
  assert.deepEqual(at(trace, 400).walker, at(trace, 2 + steps).walker, 'with no more walking after the enemy it was going after')
  assert.equal(at(trace, 400).enemyHp, MAX_HP, 'which was never cast on')
})

test('only an enemy that can be cast on is gone after: a teammate is dropped as it always was', () => {
  const simulator = scene(poke.range + 400)
  // Character 1 is on a team of its own (1), so this one is on it.
  simulator.addPlayer(3, 'p3', 'Friend', { x: HOME.x + poke.range + 400, y: HOME.y + 100 }, dummy, 1)
  simulator.addOrder(1, castAt(1, poke.id, 3))
  const trace = play(simulator, 120)

  assert.equal(at(trace, 5).lock, undefined)
  assert.deepEqual(at(trace, 60).walker, HOME, 'it did not move')
  assert.equal(pokeCast(trace), undefined)
})

test('a character winding up is not given it: the order is dropped, as one that cannot be started always was', () => {
  // The hex is in reach and begins at once; the poke is not (the enemy is past its reach but inside the hex's), and is ordered mid-windup.
  const gap = poke.range + 40
  assert.ok(gap <= hex.range, 'the enemy is in reach of the hex and not of the poke')
  const simulator = scene(gap)
  simulator.addOrder(1, castAt(1, hex.id, 2))
  simulator.addOrder(1, castAt(3, poke.id, 2))
  const trace = play(simulator, 5)

  assert.equal(hexBegun(trace), 1, 'winding up from the first tick')
  assert.ok(3 < 1 + hex.windUpTicks, 'and the poke was ordered during it')
  assert.equal(at(trace, 4).lock, undefined, 'nothing to go after')
  assert.ok(at(trace, 4).poke)
})

test('the lock for a cast is in the frame, so it survives a checkpoint and plays out the same', () => {
  const build = (): Simulator => {
    const simulator = scene(poke.range + 600)
    simulator.addOrder(1, castAt(1, poke.id, 2))
    return simulator
  }
  const reference = play(build(), 400)
  const fired = pokeCast(reference)
  assert.ok(fired !== undefined && fired > 40)

  const original = build()
  original.advanceTo(30)
  original.setCommitTick(20)
  const walking = original.snapshot()
  const lock = walking.checkpoint.characters.find((character) => character.characterId === 1)?.attackTarget
  assert.deepEqual(lock && [lock.targetId, lock.abilityId], [2, poke.id], 'the checkpoint holds the lock and what it is for')
  assert.equal(GameSnapshotSchema.safeParse(walking).success, true)

  // Played on from the checkpoint it casts on the same tick, from the same place, as the game that never left it.
  const restored = new Simulator()
  restored.replaceFromSnapshot(walking)
  const replay = play(restored, 400, 20)
  for (let tick = 21; tick <= 400; tick += 1) assert.equal(JSON.stringify(at(replay, tick)), JSON.stringify(at(reference, tick)), `tick ${tick}`)
})

// ---------------------------------------------------------------------------- what the player sends

// The walker is the local champion, with the dummy `gap` to its east.
function client(gap: number): ClientGameState {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', HOME, walker)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: HOME.x + gap, y: HOME.y }, dummy)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  return gameState
}

test('the client gives the order for an enemy out of reach, and playing it out walks up and casts', () => {
  const gap = poke.range + 400
  const gameState = client(gap)
  const attempt = gameState.createCastOrder(0, { x: HOME.x + gap, y: HOME.y }, 0)
  assert.ok(attempt.ok, 'it is not refused for being out of reach')
  assert.deepEqual(attempt.order.target, { mode: 'unit', unitId: 2 })

  const trace = play(gameState.simulator, 600)
  const fired = pokeCast(trace)
  assert.ok(fired !== undefined && fired > attempt.order.tick, 'it was cast after a walk')
  assert.equal(at(trace, fired).enemyHp, MAX_HP - POKE_DAMAGE)
})

test('the ring on an enemy out of reach is drawn in its own colour, and the one on an enemy in reach is not', () => {
  const ringColour = (gameState: ClientGameState, aim: Vector2): number | undefined => {
    const preview = gameState.getCastPreview(0, aim, 0)
    assert.ok(preview)
    const layer = new IndicatorLayer()
    layer.update({ characters: gameState.getCharacters(0), attackMarkers: [], local: { position: HOME, attackRange: walker.attackRange }, castPreview: preview })
    // The ring round the enemy is the last thing drawn; the ring at the ability's range is first.
    const strokes = (layer.view.children[1] as unknown as { context: { instructions: Array<{ action: string; data: { style: { color: number } } }> } })
      .context.instructions.filter((each) => each.action === 'stroke')
    return strokes[strokes.length - 1]?.data.style.color
  }
  const far = client(poke.range + 400)
  const near = client(poke.range - 50)
  const amber = new Color(OUT_OF_REACH_COLOR).toNumber()
  assert.equal(ringColour(far, { x: HOME.x + poke.range + 400, y: HOME.y }), amber)
  const inReach = ringColour(near, { x: HOME.x + poke.range - 50, y: HOME.y })
  assert.ok(inReach !== undefined && inReach !== amber, 'the ability\'s own colour')
})

test('the preview marks an enemy out of reach as one it will walk up to, and not one in reach', () => {
  const far = client(poke.range + 400)
  const near = client(poke.range - 50)
  assert.equal(far.getCastPreview(0, { x: HOME.x + poke.range + 400, y: HOME.y }, 0)?.outOfRange, true)
  const inReach = near.getCastPreview(0, { x: HOME.x + poke.range - 50, y: HOME.y }, 0)
  assert.deepEqual(inReach?.target, { mode: 'unit', unitId: 2 })
  assert.equal(inReach?.outOfRange, undefined)
})
