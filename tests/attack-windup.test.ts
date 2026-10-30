import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Champion,
  champions,
  GAME_TPS,
  monsters,
  Simulator,
  statBuff,
  turrets,
  type ChampionDef,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineAbility } from './fixtures.ts'

// The windup of an auto attack is a share of the whole attack (from the start of one swing to the start of the next), not a number of
// ticks, so it gets shorter as the attack speed rises, and the hit always lands the same way through the attack. The champions in these
// are the tests' own, with every number spelled out; the game's own are only read.

const SHARE = 0.2
const DAMAGE = 10
const A: Vector2 = { x: 100, y: 100 }
const B: Vector2 = { x: 200, y: 100 }

const swinger = (attackSpeed: number, extra: Partial<ChampionDef> = {}): Champion => new Champion({
  id: `t-aw-swinger-${attackSpeed}`,
  name: 'Swinger',
  base: { maxHp: 1000, attackDamage: DAMAGE, attackSpeed },
  moveSpeed: 100,
  radius: 20,
  attackRange: 150,
  attackWindup: SHARE,
  abilities: [],
  ...extra,
})
const dummy = new Champion({
  id: 't-aw-dummy',
  name: 'Dummy',
  base: { maxHp: 100_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 100,
  attackWindup: 0,
  abilities: [],
})
// Adds a full attack speed to whoever casts it, for as long as the tests last.
const quicken = defineAbility({ id: 't-aw-quicken', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 1200, apply: [statBuff('attackSpeed', 1, 1200)] })

// The swinger (1) attacks the dummy (2) from tick 1, and keeps on.
function duel(champion: Champion): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', A, champion, 1)
  simulator.addPlayer(2, 'p2', 'Two', B, dummy, 2)
  simulator.addOrder(1, { id: 'a1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  return simulator
}
// The ticks the dummy lost health on, over ticks 1 to `last`, in one pass forward.
function hitTicks(simulator: Simulator, last: number): number[] {
  const found: number[] = []
  let before = simulator.at(0).get(2)?.getHealth() ?? 0
  for (let tick = 1; tick <= last; tick += 1) {
    const now = simulator.at(tick).get(2)?.getHealth() ?? 0
    if (now < before) found.push(tick)
    before = now
  }
  return found
}

test('a windup is a share of the whole attack, so the faster the attack the shorter the windup', () => {
  // An attack a second takes `GAME_TPS` ticks, two a second half of that and four a second a quarter, and the windup is the same share of each.
  const windups: number[] = []
  for (const speed of [1, 2, 4]) {
    const whole = Math.ceil(GAME_TPS / speed)
    const champion = swinger(speed)
    assert.equal(champion.attackCooldownTicks, whole, `an attack at ${speed} a second`)
    assert.equal(champion.attackWindupTicks, Math.round(SHARE * whole), `its windup at ${speed} a second`)
    windups.push(champion.attackWindupTicks)
  }
  assert.ok(windups[0] > windups[1] && windups[1] > windups[2], `each is shorter than the last: ${windups}`)
  assert.equal(swinger(1).attackWindup, SHARE, 'what it is made with is the share')
})

test('the hit lands a share of the way through the attack, and the next swing starts a whole attack after the last began', () => {
  for (const speed of [1, 2, 4]) {
    const champion = swinger(speed)
    const first = 1 + champion.attackWindupTicks
    const whole = champion.attackCooldownTicks
    assert.deepEqual(hitTicks(duel(champion), first + 2 * whole), [first, first + whole, first + 2 * whole], `at ${speed} a second`)
  }
  const [slow, fast] = [1, 4].map((speed) => hitTicks(duel(swinger(speed)), swinger(1).attackCooldownTicks)[0])
  assert.ok(fast < slow, `the first hit of a faster attack comes sooner (${fast} against ${slow})`)
})

test('a windup follows the attack speed of the moment, whatever raises it: a buff, an item, a level', () => {
  const plain = swinger(1)
  assert.equal(plain.attackWindupTicksWith([]), plain.attackWindupTicks)
  assert.equal(plain.attackWindupTicksWith([{ kind: 'stat', stat: 'attackSpeed', amount: 1 }]), swinger(2).attackWindupTicks, 'a buff')
  assert.equal(plain.attackWindupTicksWith([], 1, 1), swinger(2).attackWindupTicks, 'an item')
  const growing = swinger(1, { growth: { attackSpeed: 1 } })
  assert.equal(growing.attackWindupTicksWith([], 2), swinger(2).attackWindupTicks, 'a level')
  assert.equal(growing.attackWindupTicksWith([], 1), plain.attackWindupTicks, 'and not before it')
  // Something that slows the attack lengthens it.
  assert.ok(plain.attackWindupTicksWith([{ kind: 'stat', stat: 'attackSpeed', amount: -0.5 }]) > plain.attackWindupTicks)
})

test('a swing that begins after a buff uses the buffed windup, and the one before it is as it was', () => {
  const champion = swinger(1)
  const horizon = 3 * champion.attackCooldownTicks
  const unbuffed = hitTicks(duel(champion), horizon)

  // The attack order comes at tick 3, when the buff is already on.
  const late = new Simulator()
  late.addPlayer(1, 'p1', 'One', A, swinger(1, { abilities: [quicken.id] }), 1)
  late.addPlayer(2, 'p2', 'Two', B, dummy, 2)
  late.addOrder(1, { id: 'q', seq: 1, tick: 1, type: 'cast', abilityId: quicken.id, target: { mode: 'none' }, origin: A })
  late.addOrder(1, { id: 'a', seq: 2, tick: 3, type: 'attack', targetId: 2 })
  assert.equal(hitTicks(late, 3 + swinger(2).attackCooldownTicks)[0], 3 + swinger(2).attackWindupTicks, 'it winds up as the buffed champion does')

  const before = new Simulator()
  before.addPlayer(1, 'p1', 'One', A, swinger(1, { abilities: [quicken.id] }), 1)
  before.addPlayer(2, 'p2', 'Two', B, dummy, 2)
  before.addOrder(1, { id: 'a', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  // Cast between the first hit and the next swing (a cast waits for a windup to end).
  const castAt = unbuffed[0] + 5
  assert.ok(castAt < 1 + champion.attackCooldownTicks, 'it is cast before the next swing begins')
  before.addOrder(1, { id: 'q', seq: 2, tick: castAt, type: 'cast', abilityId: quicken.id, target: { mode: 'none' }, origin: A })
  const hits = hitTicks(before, horizon)
  assert.equal(hits[0], unbuffed[0], 'the swing before it lands when it was going to')
  assert.equal(hits[1], 1 + champion.attackCooldownTicks + swinger(2).attackWindupTicks, 'and the next begins on time and winds up as fast as the buffed champion does')
  assert.ok(hits[1] < unbuffed[1])
})

test('a share of nothing is an attack that lands as it starts, a whole one lands as the next could start, and no other is accepted', () => {
  const instant = swinger(1, { attackWindup: 0 })
  const every = instant.attackCooldownTicks
  assert.deepEqual(hitTicks(duel(instant), 2 * every + 10).slice(0, 3), [1, 1 + every, 1 + 2 * every], 'it lands on the tick it starts')
  const whole = swinger(1, { attackWindup: 1 })
  assert.equal(whole.attackWindupTicks, whole.attackCooldownTicks)
  assert.deepEqual(hitTicks(duel(whole), 3 * whole.attackCooldownTicks).slice(0, 2), [1 + whole.attackCooldownTicks, 1 + 2 * whole.attackCooldownTicks])
  for (const attackWindup of [-0.01, 1.01, 12, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => swinger(1, { attackWindup }), /Champion "t-aw-swinger-1" has an attack windup that needs to be a share of the attack, from 0 to 1/, String(attackWindup))
  }
})

test('everything in the game that attacks has a windup that is a share, and a faster attack never has a longer one', () => {
  const bodies: Champion[] = [
    ...champions.values(),
    ...[...monsters.values()].map((monster) => monster.champion),
    ...[...turrets.values()].map((turret) => turret.champion),
  ]
  assert.ok(bodies.length > 0)
  for (const body of bodies) {
    assert.ok(body.attackWindup >= 0 && body.attackWindup <= 1, `${body.id}: ${body.attackWindup}`)
    assert.ok(body.attackWindupTicks <= body.attackCooldownTicks, `${body.id} lands within its attack`)
    const faster = [{ kind: 'stat', stat: 'attackSpeed', amount: 1 }]
    assert.ok(body.attackWindupTicksWith(faster) <= body.attackWindupTicks, `${body.id} winds up no slower for being quicker`)
  }
})
