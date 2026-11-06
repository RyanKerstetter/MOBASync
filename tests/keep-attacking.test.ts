import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  abilityDefs,
  BACK_ABILITY_ID,
  GAME_TPS,
  GameOrderSchema,
  Simulator,
  Terrain,
  type CharacterOrder,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineAbility, defineChampion } from './fixtures.ts'

// Keeping an attack through a cast (the controls menu): a cast with a windup made while attacking an enemy ends the attack, unless the order says to keep it, and then
// the caster goes back to attacking the enemy once the cast is done. The champions and the ability here are the tests' own.

// A cast that does nothing but take a second.
const ponder = defineAbility({ id: 't-ka-ponder', targeting: 'none', range: 0, windUpTicks: GAME_TPS, cooldownTicks: 600, apply: [] })
const attacker = defineChampion({
  id: 't-ka-attacker',
  name: 'Keep Attacker',
  base: { maxHp: 1000, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 300,
  radius: 20,
  attackRange: 150,
  attackWindup: 0.3,
  abilities: [ponder.id],
})
const dummy = defineChampion({
  id: 't-ka-dummy',
  name: 'Keep Dummy',
  base: { maxHp: 100_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 100,
  attackWindup: 0,
  abilities: [],
})

const ARENA = { width: 3000, height: 2000 }
const START: Vector2 = { x: 1000, y: 1000 }
// In the attacker's reach, so it attacks from where it stands.
const FOE_AT: Vector2 = { x: START.x + 100, y: START.y }
const ME = 1
const FOE = 2

let sequence = 0
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const cast = (tick: number, abilityId: string, origin: Vector2, extra: { keepAttacking?: boolean } = {}): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target: { mode: 'none' }, origin: { ...origin }, ...extra })

function scene(orders: CharacterOrder[]): Simulator {
  const simulator = new Simulator(new Terrain(ARENA, []))
  simulator.addPlayer(ME, 'p1', 'One', START, attacker, 1)
  simulator.addPlayer(FOE, 'p2', 'Two', FOE_AT, dummy, 2)
  for (const order of orders) simulator.addOrder(ME, order)
  return simulator
}
// The ticks the dummy was hit on, and whom the attacker was after and what it was doing on each tick up to `last`, read in one pass forward (the simulator keeps
// only so many frames back).
function run(simulator: Simulator, last: number) {
  const hits: number[] = []
  const targets: Array<number | undefined> = []
  const actions: Array<string | undefined> = []
  let before = simulator.at(0).get(FOE)?.getHealth() ?? 0
  for (let tick = 1; tick <= last; tick += 1) {
    const frame = simulator.at(tick)
    const health = frame.get(FOE)?.getHealth() ?? 0
    if (health < before) hits.push(tick)
    before = health
    targets[tick] = frame.get(ME)?.getAttackTarget()
    actions[tick] = frame.get(ME)?.getAction()?.kind
  }
  return { hits, target: (tick: number) => targets[tick], action: (tick: number) => actions[tick] }
}

// The attacker attacks from tick 1, and casts just after its first hit.
const HIT_AT = 1 + attacker.attackWindupTicks
const CAST_AT = HIT_AT + 1
const LAUNCH = CAST_AT + ponder.windUpTicks

test('a cast with a windup ends the attack it is made during, unless the order keeps it, and then the attack goes on the tick the cast is done', () => {
  assert.ok(LAUNCH > 1 + attacker.attackCooldownTicks, 'the cast is still going when the next swing would have begun')
  const fight = (extra: { keepAttacking?: boolean }) => run(scene([attack(1, FOE), cast(CAST_AT, ponder.id, START, extra)]), LAUNCH + 3 * attacker.attackCooldownTicks)

  const ended = fight({})
  assert.equal(ended.action(CAST_AT), 'cast', 'the cast was made')
  assert.equal(ended.target(CAST_AT), undefined, 'and the attack ended with it')
  assert.deepEqual(ended.hits, [HIT_AT], 'one hit, and none after the cast')

  const kept = fight({ keepAttacking: true })
  assert.equal(kept.action(CAST_AT), 'cast', 'the cast was made')
  assert.equal(kept.target(LAUNCH - 1), FOE, 'still after the enemy all through it')
  assert.equal(kept.hits[0], HIT_AT)
  assert.equal(kept.hits[1], LAUNCH + attacker.attackWindupTicks, 'no swing while casting, and the next one begun as the cast went off')
  assert.ok(kept.hits.length > 2, 'and it goes on attacking')
})

test('Back ends the attack even when the order says to keep it', () => {
  assert.ok(abilityDefs.get(BACK_ABILITY_ID))
  const { target, action } = run(scene([attack(1, FOE), cast(CAST_AT, BACK_ABILITY_ID, START, { keepAttacking: true })]), CAST_AT)
  assert.equal(action(CAST_AT), 'cast', 'Back was begun')
  assert.equal(target(CAST_AT), undefined)
})

test('the cast order carries it, and the client puts it on the casts it makes when it is given', () => {
  const order = cast(1, ponder.id, START, { keepAttacking: true })
  assert.equal(GameOrderSchema.safeParse(order).success, true)
  assert.equal(GameOrderSchema.safeParse({ ...order, keepAttacking: 'yes' }).success, false, 'and it is true or false')

  const castFrom = (attack?: { keepAttacking?: boolean }) => {
    const gameState = new ClientGameState()
    gameState.simulator.addPlayer(ME, 'p1', 'One', { x: 100, y: 100 }, attacker, 1)
    gameState.setLocalCharacterId(ME)
    const attempt = gameState.createCastOrder(attacker.abilities.indexOf(ponder.id), { x: 100, y: 100 }, 0, false, attack)
    assert.ok(attempt.ok, attempt.ok ? '' : attempt.reason)
    return attempt.order
  }
  assert.equal(castFrom({ keepAttacking: true }).keepAttacking, true)
  assert.equal(castFrom({ keepAttacking: false }).keepAttacking, false)
  assert.equal(castFrom().keepAttacking, undefined, 'and left out when it is not')
})
