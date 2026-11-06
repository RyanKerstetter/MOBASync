import assert from 'node:assert/strict'
import test from 'node:test'
import {
  damage,
  enemiesInRadius,
  GAME_TPS,
  Simulator,
  walkingSpeed,
  type CharacterOrder,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { abilityDefs } from '../packages/shared/src/abilities.ts'
import { defineAbility, defineChampion } from './fixtures.ts'

// A windup is how long an ability takes to cast. Walking during one does not cancel it (an order to walk is kept, and the walk begins on the tick after the cast), which it still does
// to an auto attack's; and nothing follows a cast: the caster can act the tick after it goes off. The champions and abilities here are the tests' own, with every number spelled out.

const SPELL_WINDUP = 10
const SPELL_DAMAGE = 100
defineAbility({ id: 't-wu-spell', targeting: 'none', range: 0, windUpTicks: SPELL_WINDUP, cooldownTicks: 600, apply: [damage(SPELL_DAMAGE, enemiesInRadius(200))] })
defineAbility({ id: 't-wu-quick', targeting: 'none', range: 0, windUpTicks: 0, cooldownTicks: 600, apply: [damage(1, enemiesInRadius(200))] })
const caster = defineChampion({
  id: 't-wu-caster',
  name: 'Windup Caster',
  base: { maxHp: 5000, attackDamage: 50, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: ['t-wu-spell', 't-wu-quick'],
})
// An attack that takes a whole second, half of it the windup.
const slowSwinger = defineChampion({
  id: 't-wu-swinger',
  name: 'Slow Swinger',
  base: { maxHp: 5000, attackDamage: 50, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0.5,
  abilities: [],
})
const dummy = defineChampion({
  id: 't-wu-dummy',
  name: 'Windup Dummy',
  base: { maxHp: 5000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 50,
  attackWindup: 0,
  abilities: [],
})

const HOME: Vector2 = { x: 600, y: 700 }
const FOE: Vector2 = { x: 700, y: 700 }
const DOWN: Vector2 = { x: 600, y: 1100 }
const STEP = walkingSpeed(caster.moveSpeed) / GAME_TPS

let sequence = 0
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const cast = (tick: number, abilityId: string): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target: { mode: 'none' }, origin: { ...HOME } })

function scene(who = caster): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, who, 1)
  simulator.addPlayer(2, 'p2', 'Two', FOE, dummy, 2)
  return simulator
}
const where = (simulator: Simulator, tick: number): Vector2 => simulator.at(tick).get(1)?.getPosition() as Vector2
const foeHp = (simulator: Simulator, tick: number): number => simulator.at(tick).get(2)?.getHealth() ?? 0
const near = (actual: Vector2, expected: Vector2): void =>
  assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-9, `${actual.x}, ${actual.y} is not ${expected.x}, ${expected.y}`)

const CAST_AT = 5
const LAUNCH = CAST_AT + SPELL_WINDUP

// ---------------------------------------------------------------------------- walking during the windup of an ability

test('an order to walk at any time in an ability\'s windup is kept, and the walk begins on the tick after the ability goes off', () => {
  // The first tick of the windup that can have an order, the last before the cast, and the tick it goes off on (after it has).
  for (const orderedAt of [CAST_AT + 1, LAUNCH - 1, LAUNCH]) {
    const simulator = scene()
    simulator.addOrder(1, cast(CAST_AT, 't-wu-spell'))
    simulator.addOrder(1, move(orderedAt, DOWN))
    near(where(simulator, LAUNCH), HOME)
    assert.equal(foeHp(simulator, LAUNCH), 5000 - SPELL_DAMAGE, `ordered on ${orderedAt}: the spell went off`)
    assert.equal(simulator.at(LAUNCH).get(1)?.getAbilityCooldown('t-wu-spell').ready, false, 'and was spent')
    near(where(simulator, LAUNCH + 1), { x: HOME.x, y: HOME.y + STEP })
    near(where(simulator, LAUNCH + 300), DOWN)
  }
})

test('he does not move at all while it winds up, and the cast is not cut short for the walk', () => {
  const simulator = scene()
  simulator.addOrder(1, cast(CAST_AT, 't-wu-spell'))
  simulator.addOrder(1, move(CAST_AT + 2, DOWN))
  for (let tick = CAST_AT; tick < LAUNCH; tick += 1) {
    assert.equal(simulator.at(tick).get(1)?.getAction()?.kind, 'cast', `tick ${tick}: still casting`)
    near(where(simulator, tick), HOME)
  }
})

test('of several orders to walk in the windup the last is the one kept', () => {
  const simulator = scene()
  const east: Vector2 = { x: 1100, y: 700 }
  simulator.addOrder(1, cast(CAST_AT, 't-wu-spell'))
  simulator.addOrder(1, move(CAST_AT + 1, east))
  simulator.addOrder(1, move(CAST_AT + 3, DOWN))
  near(where(simulator, LAUNCH + 300), DOWN)
})

test('an order to attack in the windup is kept as well, and he goes after the target when it has gone off', () => {
  const simulator = scene()
  simulator.addOrder(1, cast(CAST_AT, 't-wu-spell'))
  simulator.addOrder(1, attack(CAST_AT + 2, 2))
  assert.equal(foeHp(simulator, LAUNCH - 1), 5000, 'nothing lands in the windup')
  // His attack has no windup, so it lands the moment he is free to make it, which is the tick the spell goes off.
  assert.equal(foeHp(simulator, LAUNCH), 5000 - SPELL_DAMAGE - caster.attackDamage, 'the spell went off, and then he attacked')
})

test('a walk after the ability has gone off is not held up', () => {
  const simulator = scene()
  simulator.addOrder(1, cast(CAST_AT, 't-wu-spell'))
  simulator.addOrder(1, move(LAUNCH + 1, DOWN))
  near(where(simulator, LAUNCH + 1), HOME)
  near(where(simulator, LAUNCH + 2), { x: HOME.x, y: HOME.y + STEP })
})

// ---------------------------------------------------------------------------- an auto attack's windup is still cancelled by walking

test('walking cancels an auto attack that is winding up, and it lands no blow', () => {
  const simulator = scene(slowSwinger)
  simulator.addOrder(1, attack(1, 2))
  // The attack begins on tick 1 and lands on tick 31; he walks off on tick 10.
  assert.equal(simulator.at(5).get(1)?.getAction()?.kind, 'attack', 'it is winding up')
  simulator.addOrder(1, move(10, DOWN))
  assert.equal(simulator.at(11).get(1)?.getAction(), undefined, 'walking cancelled it')
  near(where(simulator, 11), { x: HOME.x, y: HOME.y + STEP })
  assert.equal(foeHp(simulator, 60), 5000, 'and no blow landed')
})

// ---------------------------------------------------------------------------- nothing follows a cast

test('he can act on the tick after an ability goes off: there is no backswing', () => {
  const simulator = scene()
  simulator.addOrder(1, cast(CAST_AT, 't-wu-spell'))
  // Another ability, on the next tick, is cast at once (it has no windup of its own, so its cooldown starts on the tick it is ordered).
  simulator.addOrder(1, cast(LAUNCH + 1, 't-wu-quick'))
  assert.equal(simulator.at(LAUNCH).get(1)?.getAction(), undefined, 'nothing is left of the first cast')
  assert.equal(simulator.at(LAUNCH + 1).get(1)?.getAbilityCooldown('t-wu-quick').ready, false, 'the second goes off the tick after the first')
  assert.equal(foeHp(simulator, LAUNCH + 1), 5000 - SPELL_DAMAGE - 1)

  const attacking = scene()
  attacking.addOrder(1, cast(CAST_AT, 't-wu-spell'))
  attacking.addOrder(1, attack(LAUNCH + 1, 2))
  assert.equal(foeHp(attacking, LAUNCH), 5000 - SPELL_DAMAGE)
  assert.equal(foeHp(attacking, LAUNCH + 1), 5000 - SPELL_DAMAGE - caster.attackDamage, 'and so is an attack, which lands the moment it begins')
})

test('an ability cannot be started in the windup of another, which is not kept', () => {
  const simulator = scene()
  simulator.addOrder(1, cast(CAST_AT, 't-wu-spell'))
  simulator.addOrder(1, cast(CAST_AT + 2, 't-wu-quick'))
  assert.equal(simulator.at(LAUNCH + 10).get(1)?.getAbilityCooldown('t-wu-quick').ready, true, 'it was dropped')
})

// ---------------------------------------------------------------------------- the list of windups

test('every ability in the game winds up for no time, for a kind of windup in the list, or is Back', async () => {
  const { BACK_ABILITY_ID, BACK_TICKS } = await import('../packages/shared/src/index.ts')
  const { WINDUP_TICKS } = await import('../packages/shared/src/abilities.ts')
  const kinds = Object.values(WINDUP_TICKS) as number[]
  assert.ok(kinds.length > 0 && kinds.every((ticks) => Number.isInteger(ticks) && ticks > 0), 'each kind is a number of ticks')
  for (const def of abilityDefs.values()) {
    if (def.id.startsWith('t-')) continue
    const ok = def.windUpTicks === 0 || kinds.includes(def.windUpTicks) || (def.id === BACK_ABILITY_ID && def.windUpTicks === BACK_TICKS)
    assert.ok(ok, `${def.id} winds up for ${def.windUpTicks} ticks, which is not a kind`)
  }
  assert.ok('default' in WINDUP_TICKS, 'there is a default kind')
})
