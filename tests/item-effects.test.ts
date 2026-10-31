import assert from 'node:assert/strict'
import test from 'node:test'
import {
  burn,
  damage,
  describeItemEffect,
  describeItemEffects,
  enemiesInRadius,
  GAME_BURN_PULSE_TICKS,
  getItem,
  Item,
  itemAttackSpeedBonus,
  itemEffectProblem,
  itemEffects,
  items,
  scaled,
  statMultiplier,
  withItems,
  type CharacterOrder,
  type ChampionStats,
  type ItemDef,
  type ItemEffect,
  type ItemEffectKind,
  type ItemSlot,
  type ItemStats,
  type Simulator,
  type Status,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { shopTooltip, ownedTooltip } from '../apps/client/src/ui/shop.ts'
import { defineAbility, defineChampion, defineItem, economySimulator } from './fixtures.ts'

// What the effects of items do (see item-effects.ts), by what the simulator does with them. The items the mechanics are tried with are the tests' own
// ("t-ie-"), with their numbers spelled out, so retuning the shop's items changes nothing here. What the shipped items have is tried on its own, below, and from
// what the items say they are: a test of one of them works out what it expects from the item, so a number that is retuned is a number that is still right.

let made = 0
const gear = (id: string, slot: ItemSlot, effects: readonly ItemEffect[], stats: ItemStats = {}): ItemDef['id'] => defineItem({
  id: `t-ie-${id}`,
  name: `Effect ${id}`,
  slot,
  cost: 10,
  stats,
  effects,
}).id

// Flat damage, so what an item makes of it can be told from what the item adds to the stats.
defineAbility({ id: 't-ie-blast', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [damage(100, enemiesInRadius(400))] })
// The same, ready again almost at once, to cast again before an effect's cooldown is over.
defineAbility({ id: 't-ie-jab', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 30, apply: [damage(100, enemiesInRadius(400))] })
// A burn, 40 a second: 20 for each pulse.
defineAbility({ id: 't-ie-torch', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [burn(scaled(40, {}), 180, enemiesInRadius(400))] })

const fighter = defineChampion({
  id: 't-ie-fighter',
  name: 'Effect Fighter',
  base: { maxHp: 1000, attackDamage: 100, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: ['t-ie-blast', 't-ie-jab', 't-ie-torch'],
})
// Takes a lot of hits, and hits for nothing.
const dummy = defineChampion({
  id: 't-ie-dummy',
  name: 'Effect Dummy',
  base: { maxHp: 5000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: [],
})
// Takes a lot of hits, and hurts once: it hits for 300, and then not again for a long time.
const brute = defineChampion({
  id: 't-ie-brute',
  name: 'Effect Brute',
  base: { maxHp: 5000, attackDamage: 300, attackSpeed: 0.01 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: [],
})
// A resistance of 100 takes half off what hits it.
const plated = defineChampion({
  id: 't-ie-plated',
  name: 'Effect Plated',
  base: { maxHp: 5000, attackDamage: 300, attackSpeed: 0.01, resistance: 100 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: [],
})

const buy = (tick: number, itemId: string, seq = tick) => ({ id: `b${seq}:${itemId}`, seq, tick, type: 'buy' as const, itemId })
const attack = (tick: number, targetId: number, seq = tick) => ({ id: `a${seq}`, seq, tick, type: 'attack' as const, targetId })
const walk = (tick: number, target: Vector2, seq = tick) => ({ id: `w${seq}`, seq, tick, type: 'move' as const, target })
const cast = (tick: number, abilityId: string, seq = tick) => ({
  id: `c${seq}`,
  seq,
  tick,
  type: 'cast' as const,
  abilityId,
  target: { mode: 'none' as const },
  origin: { x: 600, y: 700 },
})

// Player 1, a fighter with these items (bought on the first ticks), and player 2, who is the dummy or another.
function duel(bought: string[], other = dummy): Simulator {
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p1', 'One', { x: 600, y: 700 }, fighter, 1)
  simulator.addPlayer(2, 'p2', 'Two', { x: 700, y: 700 }, other, 2)
  bought.forEach((id, index) => simulator.addOrder(1, buy(1 + index, id)))
  return simulator
}
// The simulator keeps only the last few ticks, so what a test looks at is written down as it runs forward: both players' health and statuses on each tick, and
// the cooldowns of player 1 that it asks for (an ability's, or an item effect's: see `itemStrike`). Left as it is, `play` carries on from the tick it ends on.
type Seen = { hp: Record<number, number>; statuses: Record<number, Status[]>; cooldown: Record<string, number> }
type Tape = Seen[]
function play(simulator: Simulator, to: number, keys: readonly string[] = [], tape: Tape = [], from = tape.length || 1): Tape {
  for (let tick = from; tick <= to; tick += 1) {
    const frame = simulator.at(tick)
    const statuses = (id: number): Status[] => (frame.get(id)?.getStatuses() ?? []).map((status) => ({ ...status }))
    tape[tick] = {
      hp: { 1: frame.get(1)?.getHealth() ?? Number.NaN, 2: frame.get(2)?.getHealth() ?? Number.NaN },
      statuses: { 1: statuses(1), 2: statuses(2) },
      cooldown: Object.fromEntries(keys.map((key) => [key, frame.get(1)?.getAbilityCooldown(key).ticksRemaining ?? Number.NaN])),
    }
  }
  return tape
}
const hp = (tape: Tape, tick: number, id = 2): number => tape[tick].hp[id]
// The hits the unit took, in order, each as the health it lost in a tick.
function hitsOn(tape: Tape, from: number, to: number, id = 2): number[] {
  const hits: number[] = []
  for (let tick = from; tick <= to; tick += 1) {
    const lost = hp(tape, tick - 1, id) - hp(tape, tick, id)
    if (lost > 0) hits.push(lost)
  }
  return hits
}
const statusOf = (tape: Tape, tick: number, id: number, kind: string): Status[] =>
  tape[tick].statuses[id].filter((status) => status.kind === kind)

// ---------------------------------------------------------------------------- more damage

test('abilities do their bonus more damage, and autos are left alone', () => {
  const amp = gear('amp', 'weapon', [{ kind: 'abilityDamage', bonus: 0.5 }])
  const spell = duel([amp])
  spell.addOrder(1, cast(6, 't-ie-blast'))
  const swing = duel([amp])
  swing.addOrder(1, attack(4, 2))
  assert.deepEqual(hitsOn(play(spell, 12), 2, 12), [150])
  assert.deepEqual(hitsOn(play(swing, 12), 2, 12), [100])
})

test('autos do their bonus more damage, on all they do including what the item adds, and abilities are left alone', () => {
  const edge = gear('edge', 'weapon', [{ kind: 'attackDamage', bonus: 0.5 }], { attackDamage: 20 })
  const swing = duel([edge])
  swing.addOrder(1, attack(4, 2))
  const spell = duel([edge])
  spell.addOrder(1, cast(6, 't-ie-blast'))
  assert.deepEqual(hitsOn(play(swing, 12), 2, 12), [(100 + 20) * 1.5])
  assert.deepEqual(hitsOn(play(spell, 12), 2, 12), [100])
})

test('bonuses of the same kind add up instead of multiplying', () => {
  const twice = [
    gear('add-one', 'weapon', [{ kind: 'attackDamage', bonus: 0.5 }]),
    gear('add-two', 'head', [{ kind: 'attackDamage', bonus: 0.5 }]),
  ]
  const swing = duel(twice)
  swing.addOrder(1, attack(4, 2))
  assert.deepEqual(hitsOn(play(swing, 12), 2, 12), [200], 'plus 50% and plus 50% is 200, not 225')
})

test('an auto that does arcane damage adds its ratio of the arcane the carrier has, with what its items add', () => {
  const dark = gear('dark', 'weapon', [{ kind: 'attackArcane', ratio: 0.6 }], { arcane: 80 })
  const swing = duel([dark])
  swing.addOrder(1, attack(4, 2))
  assert.deepEqual(hitsOn(play(swing, 12), 2, 12), [100 + 0.6 * 80])
})

test('a share of the target\'s current health is added to an auto, and the next one takes the health there is by then', () => {
  const infused = gear('infused', 'weapon', [{ kind: 'currentHealthDamage', fraction: 0.1 }])
  const swing = duel([infused])
  swing.addOrder(1, attack(4, 2))
  const [first, second] = hitsOn(play(swing, 100), 2, 100)
  assert.equal(first, 100 + 0.1 * 5000)
  assert.equal(second, Math.round(100 + 0.1 * (5000 - first)))
})

test('some of the target\'s resistance is not met by an auto, and an ability still meets all of it', () => {
  const pierce = gear('pierce', 'weapon', [{ kind: 'resistancePierce', fraction: 0.5 }])
  const attackOn = (bought: string[]): Simulator => {
    const simulator = duel(bought, plated)
    simulator.addOrder(1, attack(4, 2))
    return simulator
  }
  const spell = duel([pierce], plated)
  spell.addOrder(1, cast(6, 't-ie-blast'))
  assert.deepEqual(hitsOn(play(attackOn([]), 12), 2, 12), [Math.round(100 * statMultiplier(100))], 'a resistance of 100 takes half')
  assert.deepEqual(hitsOn(play(attackOn([pierce]), 12), 2, 12), [Math.round(100 * statMultiplier(100 * 0.5))], 'half of it is not met')
  assert.deepEqual(hitsOn(play(spell, 12), 2, 12), [Math.round(100 * statMultiplier(100))])
})

// ---------------------------------------------------------------------------- attack speed

test('more attack speed is a share of the attack speed with what the items add, and it shortens the swing', () => {
  const quick = gear('quick', 'weapon', [{ kind: 'attackSpeed', bonus: 0.5 }])
  const quicker = gear('quicker', 'head', [{ kind: 'attackSpeed', bonus: 0.5 }], { attackSpeed: 1 })
  const swing = (bought: string[]): number | undefined => {
    const simulator = duel(bought)
    simulator.addOrder(1, attack(4, 2))
    return simulator.at(6).get(1)?.getCooldown().ticksRemaining
  }
  assert.equal(swing([]), 60 - 2, 'an attack a second is every 60 ticks')
  assert.equal(swing([quick]), 40 - 2, '1.5 a second is every 40')
  assert.equal(swing([quicker]), 20 - 2, '(1 + 1) times 1.5 is 3 a second, every 20')
  assert.equal(fighter.attackCooldownTicksWith([], 1, 1, 0.5), 20, 'and the champion says the same')
  const stats = (inventory: Record<string, string>): ChampionStats => withItems(fighter.statsAt(1), inventory)
  assert.equal(stats({ weapon: quick }).attackSpeed, 1.5)
  assert.equal(stats({ weapon: quick, head: quicker }).attackSpeed, (1 + 1) * (1 + 0.5 + 0.5), 'two of them add up')
  assert.equal(itemAttackSpeedBonus({ weapon: quick, head: quicker }), 1)
})

// ---------------------------------------------------------------------------- healing

test('lifesteal heals a share of what an attack or an ability deals, whichever it is on, after the target\'s resistance', () => {
  const heals = (effect: ItemEffect, other: typeof dummy, order: (tick: number) => CharacterOrder): number => {
    made += 1
    const simulator = duel([gear(`steal-${made}`, 'weapon', [effect])], other)
    // The other one hits for 300 first, and only then does the carrier do anything, so there is health to get back.
    simulator.addOrder(2, attack(2, 1))
    simulator.addOrder(1, order(10))
    const tape = play(simulator, 40)
    assert.equal(hp(tape, 8, 1), 1000 - 300, 'hurt first')
    return hp(tape, 40, 1) - hp(tape, 8, 1)
  }
  const hit = (tick: number): CharacterOrder => attack(tick, 2)
  const blast = (tick: number): CharacterOrder => cast(tick, 't-ie-blast')
  const onAttacks: ItemEffect = { kind: 'lifesteal', on: 'attacks', fraction: 0.5 }
  const onAbilities: ItemEffect = { kind: 'lifesteal', on: 'abilities', fraction: 0.5 }
  assert.equal(heals(onAttacks, brute, hit), 50, 'half of an attack of 100')
  assert.equal(heals(onAttacks, brute, blast), 0, 'and none of an ability')
  assert.equal(heals(onAbilities, brute, blast), 50, 'half of an ability of 100')
  assert.equal(heals(onAbilities, brute, hit), 0, 'and none of an attack')
  assert.equal(heals(onAttacks, plated, hit), 25, 'half of what is dealt, which is 50 against a resistance of 100')
})

test('lifesteal stops at the health there is room for', () => {
  const simulator = duel([gear('steal-full', 'weapon', [{ kind: 'lifesteal', on: 'attacks', fraction: 1 }])])
  simulator.addOrder(1, attack(4, 2))
  assert.equal(hp(play(simulator, 12), 12, 1), 1000)
})

// ---------------------------------------------------------------------------- statuses

test('an attack that lands gives move speed for as long as it says, and another that lands renews it instead of adding to it', () => {
  const tonfa = gear('tonfa', 'weapon', [{ kind: 'attackMoveSpeed', fraction: 0.2, ticks: 120 }])
  const simulator = duel([tonfa])
  simulator.addOrder(1, attack(4, 2))
  const tape = play(simulator, 100)
  assert.equal(statusOf(tape, 3, 1, 'haste').length, 0, 'none before it lands')
  const first = statusOf(tape, 12, 1, 'haste')
  assert.equal(first.length, 1)
  assert.equal(first[0].amount, 0.2)
  assert.equal(first[0].endTick - first[0].startTick, 120)
  const later = statusOf(tape, 100, 1, 'haste')
  assert.equal(later.length, 1, 'one, whatever the number of hits')
  assert.ok(later[0].startTick > first[0].startTick, 'renewed by the next hit')
  assert.equal(statusOf(tape, 12, 2, 'haste').length, 0, 'and it is for the carrier')
})

test('a poison does its damage on every pulse for as long as it lasts, scales with the carrier\'s arcane, is renewed by the next hit, and is not an attack', () => {
  const venom = gear('venom', 'weapon', [{ kind: 'poison', damagePerSecond: 10, arcane: 0.1, ticks: 180 }, { kind: 'attackDamage', bonus: 1 }], { arcane: 100 })
  const simulator = duel([venom])
  simulator.addOrder(1, attack(4, 2))
  const tape = play(simulator, 100)
  const [poison] = statusOf(tape, 12, 2, 'poison')
  assert.ok(poison, 'on the target')
  assert.equal(poison.amount, (10 + 0.1 * 100) * GAME_BURN_PULSE_TICKS / 60, '10 and a tenth of 100, a second, in pulses of half of one')
  assert.equal(poison.endTick - poison.startTick, 180)
  assert.equal(statusOf(tape, 12, 1, 'poison').length, 0, 'and not on the carrier')
  assert.equal(statusOf(tape, 100, 2, 'poison').length, 1, 'one, whatever the number of hits')
  assert.ok(statusOf(tape, 100, 2, 'poison')[0].startTick > poison.startTick, 'renewed')
  // The hit was doubled, and a pulse is not a hit: it does what it says.
  const pulseTick = Math.ceil((poison.startTick + 1) / GAME_BURN_PULSE_TICKS) * GAME_BURN_PULSE_TICKS
  assert.equal(hp(tape, pulseTick - 1) - hp(tape, pulseTick), poison.amount)
  assert.equal(hitsOn(tape, 2, pulseTick - 1)[0], 200, 'the hit was doubled')
})

test('the poison of a carrier that has no arcane is its damage a second, and a poison that would do nothing is not put on', () => {
  const plain = gear('venom-plain', 'weapon', [{ kind: 'poison', damagePerSecond: 10, arcane: 0.1, ticks: 180 }])
  const none = gear('venom-none', 'head', [{ kind: 'poison', damagePerSecond: 0, arcane: 0.1, ticks: 180 }])
  const dosed = duel([plain])
  dosed.addOrder(1, attack(4, 2))
  const empty = duel([none])
  empty.addOrder(1, attack(4, 2))
  assert.equal(statusOf(play(dosed, 12), 12, 2, 'poison')[0]?.amount, 10 * GAME_BURN_PULSE_TICKS / 60)
  assert.equal(statusOf(play(empty, 12), 12, 2, 'poison').length, 0)
})

// ---------------------------------------------------------------------------- the effects with a cooldown

test('an opening attack does extra damage and heals once in its cooldown, and the cooldown is kept with the carrier\'s others', () => {
  const opener = gear('opener', 'weapon', [{ kind: 'openingAttack', attackDamage: 1, healMissingHealth: 0.5, cooldownTicks: 300 }])
  const key = `item:${opener}:openingAttack`
  const simulator = duel([opener], brute)
  simulator.addOrder(2, attack(2, 1))
  simulator.addOrder(1, attack(10, 2))
  const tape = play(simulator, 700, [key])
  const hits = hitsOn(tape, 9, 400)
  assert.equal(hits[0], 200, 'the first is 100 and the attack damage of the carrier')
  assert.equal(hits[1], 100, 'and the next are not')
  assert.equal(hits.filter((each) => each === 200).length, 2, 'until the cooldown is over, and then it is again')
  // It counts down from the hit that used it.
  const used = [...tape.keys()].find((tick) => tick >= 10 && hp(tape, tick - 1) - hp(tape, tick) === 200) as number
  assert.equal(tape[used + 50].cooldown[key], 300 - 50, 'running')
  // 300 lost, then half of the 300 missing at the first, and half of the 150 still missing at the second.
  assert.equal(hp(tape, 400, 1), 1000 - 300 + 150 + 75)
})

test('a charged ability adds to the next ability that does damage once in its cooldown, and not to autos or a burn that goes on', () => {
  const charge = gear('charge', 'weapon', [{ kind: 'chargedAbility', arcane: 1, cooldownTicks: 300 }], { arcane: 100 })
  const key = `item:${charge}:chargedAbility`
  const jabs = duel([charge])
  for (const tick of [6, 50, 330]) jabs.addOrder(1, cast(tick, 't-ie-jab'))
  assert.deepEqual(hitsOn(play(jabs, 340), 2, 340), [100 + 100, 100, 100 + 100], 'the charge, none while it is gone, and the charge again')
  const swing = duel([charge])
  swing.addOrder(1, attack(2, 2))
  swing.addOrder(1, cast(20, 't-ie-jab'))
  assert.deepEqual(hitsOn(play(swing, 40), 2, 40), [100, 100 + 100], 'an auto in the way does not use it')
  const burning = duel([charge])
  burning.addOrder(1, cast(6, 't-ie-torch'))
  burning.addOrder(1, cast(100, 't-ie-jab'))
  const tape = play(burning, 105, [key])
  assert.equal(tape[95].cooldown[key], 0, 'the pulses of a burn have not used it')
  assert.ok(hitsOn(tape, 2, 99).length >= 3, 'though there were pulses')
  assert.deepEqual(hitsOn(tape, 100, 100), [200], 'and a cast takes it')
  assert.ok(tape[105].cooldown[key] > 0)
})

test('what an item\'s bonus does to abilities counts a burn too', () => {
  const amp = gear('amp-burn', 'weapon', [{ kind: 'abilityDamage', bonus: 1 }])
  const simulator = duel([amp])
  simulator.addOrder(1, cast(6, 't-ie-torch'))
  assert.equal(hitsOn(play(simulator, 60), 7, 60)[0], 40, 'a pulse of 20 is 40')
})

test('an effect with a cooldown comes back with the rest of the frame when an order arrives late', () => {
  const opener = gear('opener-late', 'weapon', [{ kind: 'openingAttack', attackDamage: 1, cooldownTicks: 300 }])
  const key = `item:${opener}:openingAttack`
  // The opening attack is at tick 14. A harmless order for the other player comes in for tick 12 after both have run to 20, so everything from 12 is done again, and
  // the cooldown the opening attack started on 14 has to be taken back and started again with it, or the second time through there is no extra damage.
  const together = duel([opener])
  together.addOrder(1, attack(14, 2))
  together.addOrder(2, walk(12, { x: 700, y: 760 }))
  const late = duel([opener])
  late.addOrder(1, attack(14, 2))
  const lateTape = play(late, 20, [key])
  late.addOrder(2, walk(12, { x: 700, y: 760 }))
  play(late, 40, [key], lateTape, 21)
  const togetherTape = play(together, 40, [key])
  for (let tick = 21; tick <= 40; tick += 1) {
    assert.equal(hp(lateTape, tick), hp(togetherTape, tick), `health at ${tick}`)
    assert.equal(lateTape[tick].cooldown[key], togetherTape[tick].cooldown[key], `cooldown at ${tick}`)
  }
  assert.equal(hp(lateTape, 40), 5000 - 200, 'with the extra damage once')
  assert.ok(lateTape[40].cooldown[key] > 0)
})

// ---------------------------------------------------------------------------- what is said

test('an effect is described with its numbers as they are written, and a list of them in one text', () => {
  const said = (effect: ItemEffect): string => describeItemEffect(effect)
  assert.equal(said({ kind: 'abilityDamage', bonus: 0.1 }), 'Abilities do 10% bonus damage.')
  assert.equal(said({ kind: 'attackDamage', bonus: 0.25 }), 'Attacks do 25% bonus damage.')
  assert.equal(said({ kind: 'attackSpeed', bonus: 0.15 }), 'Gain 15% bonus attack speed.')
  assert.equal(said({ kind: 'lifesteal', on: 'attacks', fraction: 0.2 }), 'Gain 20% lifesteal on attacks.')
  assert.equal(said({ kind: 'lifesteal', on: 'abilities', fraction: 0.15 }), 'Gain 15% lifesteal on abilities.')
  assert.equal(said({ kind: 'attackMoveSpeed', fraction: 0.1, ticks: 120 }), 'Attacks give 10% move speed for 2 seconds.')
  assert.equal(said({ kind: 'attackMoveSpeed', fraction: 0.1, ticks: 60 }), 'Attacks give 10% move speed for 1 second.')
  assert.equal(said({ kind: 'resistancePierce', fraction: 0.3 }), 'Attacks ignore 30% of the target\'s resistance.')
  assert.equal(said({ kind: 'attackArcane', ratio: 0.6 }), 'Attacks do bonus damage equal to 60% of your Arcane.')
  assert.equal(said({ kind: 'currentHealthDamage', fraction: 0.06 }), 'Attacks do bonus damage equal to 6% of the target\'s current health.')
  assert.equal(said({ kind: 'poison', damagePerSecond: 10, arcane: 0.1, ticks: 180 }), 'Attacks poison the target for 10 + 10% of your Arcane damage per second for 3 seconds.')
  assert.equal(said({ kind: 'poison', damagePerSecond: 10, arcane: 0, ticks: 180 }), 'Attacks poison the target for 10 damage per second for 3 seconds.')
  assert.equal(said({ kind: 'openingAttack', attackDamage: 1, cooldownTicks: 600 }), 'Every 10 seconds, your next attack does bonus damage equal to 100% of your Attack damage.')
  assert.equal(
    said({ kind: 'openingAttack', attackDamage: 2, healMissingHealth: 0.1, cooldownTicks: 600 }),
    'Every 10 seconds, your next attack does bonus damage equal to 200% of your Attack damage and heals you for 10% of your missing health.',
  )
  assert.equal(said({ kind: 'chargedAbility', arcane: 1, cooldownTicks: 300 }), 'Every 5 seconds, your next ability that does damage does bonus damage equal to 100% of your Arcane.')
  assert.equal(describeItemEffects([{ kind: 'attackSpeed', bonus: 0.3 }, { kind: 'currentHealthDamage', fraction: 0.06 }]), 'Gain 30% bonus attack speed. Attacks do bonus damage equal to 6% of the target\'s current health.')
  assert.equal(describeItemEffects([]), '')
})

test('an item is described by its effects, and one with none has nothing to say', () => {
  assert.equal(new Item({ id: 'x', name: 'X', slot: 'boots', cost: 10 }).description, '')
  const wand = new Item({ id: 'y', name: 'Y', slot: 'weapon', cost: 10, effects: [{ kind: 'abilityDamage', bonus: 0.1 }] })
  assert.equal(wand.description, 'Abilities do 10% bonus damage.')
  assert.deepEqual(wand.effects, [{ kind: 'abilityDamage', bonus: 0.1 }])
})

test('an effect that cannot work is refused when the item is made', () => {
  const fine = { id: 'z', name: 'Z', slot: 'weapon' as const, cost: 5 }
  const refused = (effect: unknown, message: RegExp): void => {
    assert.throws(() => new Item({ ...fine, effects: [effect as ItemEffect] }), new RegExp(`Item "z" .*${message.source}`))
    assert.match(itemEffectProblem(effect as ItemEffect) ?? '', message)
  }
  refused({ kind: 'teleport' }, /has an effect called teleport/)
  refused({ kind: 'abilityDamage', bonus: Number.NaN }, /needs a bonus that is a number, 0 or more/)
  refused({ kind: 'attackDamage', bonus: -0.1 }, /needs a bonus that is a number, 0 or more/)
  refused({ kind: 'attackMoveSpeed', fraction: 0.1, ticks: 1.5 }, /needs a ticks that is a whole number of ticks, 1 or more/)
  refused({ kind: 'openingAttack', attackDamage: 1, cooldownTicks: 0 }, /needs a cooldownTicks that is a whole number of ticks/)
  refused({ kind: 'lifesteal', on: 'wounds', fraction: 0.1 }, /\(lifesteal\) that needs to be on attacks or on abilities/)
  assert.equal(itemEffectProblem({ kind: 'abilityDamage', bonus: 2 }), undefined, 'a share can be over 1')
})

test('what an inventory carries is its effects, each with its item, in the order of the slots', () => {
  const left = gear('carry-weapon', 'weapon', [{ kind: 'attackDamage', bonus: 0.1 }, { kind: 'abilityDamage', bonus: 0.2 }])
  const head = gear('carry-head', 'head', [{ kind: 'lifesteal', on: 'attacks', fraction: 0.3 }])
  assert.deepEqual(itemEffects({ weapon: left, head }).map(({ itemId, effect }) => [itemId, effect.kind]), [
    [head, 'lifesteal'],
    [left, 'attackDamage'],
    [left, 'abilityDamage'],
  ])
  assert.deepEqual(itemEffects(undefined), [])
  assert.deepEqual(itemEffects({ weapon: 'no-such-item' }), [])
})

test('the tooltip of an item says what its effects do, and one with none says nothing', () => {
  const sword = getItem('sword')!
  const boots = getItem('worn-boots')!
  assert.ok(sword.description.length > 0)
  assert.equal(shopTooltip({ item: sword, status: 'available' }).about, sword.description)
  assert.equal(ownedTooltip(sword).about, sword.description)
  assert.equal('about' in shopTooltip({ item: boots, status: 'available' }), false)
  assert.equal('about' in ownedTooltip(boots), false)
})

// ---------------------------------------------------------------------------- the items in the game

// What each of the weapons that was given a note has. It is the kind of effect that is checked, and the ones that are for attacks or abilities, and never how much.
// The ones with none are those whose note was only the attack range they already add.
const SHIPPED: Readonly<Record<string, ItemEffectKind[]>> = {
  wand: ['abilityDamage'],
  dagger: ['attackSpeed'],
  bow: [],
  sword: ['attackDamage'],
  tome: ['chargedAbility'],
  jambiya: ['lifesteal'],
  tonfa: ['attackMoveSpeed'],
  staff: ['openingAttack'],
  mace: ['attackDamage'],
  'poisoned-dagger': ['poison'],
  'light-staff': ['abilityDamage'],
  nunchucks: ['attackSpeed'],
  scythe: ['lifesteal'],
  crossbow: [],
  hammer: ['resistancePierce'],
  'battle-axe': ['attackDamage'],
  'life-staff': ['lifesteal'],
  'dark-staff': ['attackArcane'],
  'cursed-scythe': ['lifesteal'],
  'cursed-tome': ['lifesteal'],
  'holy-tome': ['abilityDamage'],
  'infused-dagger': ['attackSpeed', 'currentHealthDamage'],
  'poisoned-crossbow': ['poison'],
  'machine-gun': ['attackSpeed'],
  'infused-axe': ['attackDamage'],
  'infused-staff': ['openingAttack'],
  sniper: [],
}

test('each weapon has the effects it was given a note for, and a description that says them', () => {
  for (const [id, kinds] of Object.entries(SHIPPED)) {
    const item = getItem(id)
    assert.ok(item, `${id} is an item`)
    assert.deepEqual(item.effects.map((effect) => effect.kind), kinds, id)
    assert.equal(item.description, describeItemEffects(item.effects), `${id} says what it does`)
    assert.equal(item.description === '', kinds.length === 0, `${id} has a description if it has an effect`)
  }
  const lifesteal = (id: string): unknown => getItem(id)?.effects.find((effect) => effect.kind === 'lifesteal')
  for (const id of ['jambiya', 'scythe', 'cursed-scythe']) assert.equal((lifesteal(id) as { on: string }).on, 'attacks', id)
  for (const id of ['life-staff', 'cursed-tome']) assert.equal((lifesteal(id) as { on: string }).on, 'abilities', id)
})

test('only the weapons have effects, and every effect says its number in its description', () => {
  for (const item of items.values()) {
    if (item.id.startsWith('t-')) continue
    if (item.slot !== 'weapon') assert.deepEqual(item.effects, [], `${item.id} is not a weapon`)
    for (const effect of item.effects) {
      const shares = Object.entries(effect).filter(([key, value]) => ['bonus', 'fraction', 'ratio', 'arcane', 'attackDamage', 'healMissingHealth'].includes(key) && typeof value === 'number')
      for (const [key, value] of shares) {
        assert.ok(item.description.includes(`${Number(((value as number) * 100).toFixed(1))}%`), `${item.id} says its ${key}`)
      }
    }
  }
})

// A player starts with less gold than the dear items cost, and the price of one is tuned, so these are tried with a copy of the item that costs nothing much: it
// has the shipped item's stats and effects, read from it, and so is worth what the item is.
const copyOf = (id: string): string => {
  const item = getItem(id)
  assert.ok(item, `${id} is an item`)
  return gear(`copy-${id}`, item.slot, item.effects, item.stats)
}

test('the sword makes autos do the bonus its effect says, and the wand makes an ability do its', () => {
  const sword = getItem('sword')!
  const wand = getItem('wand')!
  const swordBonus = (sword.effects[0] as { bonus: number }).bonus
  const wandBonus = (wand.effects[0] as { bonus: number }).bonus
  const swing = duel([copyOf('sword')])
  swing.addOrder(1, attack(4, 2))
  const spell = duel([copyOf('wand')])
  spell.addOrder(1, cast(6, 't-ie-blast'))
  assert.deepEqual(hitsOn(play(swing, 12), 2, 12), [Math.round((100 + (sword.stats.attackDamage ?? 0)) * (1 + swordBonus))])
  assert.deepEqual(hitsOn(play(spell, 12), 2, 12), [Math.round(100 * (1 + wandBonus))])
})

test('the dark staff adds the ratio of its arcane to an auto, as the note works it out', () => {
  const staff = getItem('dark-staff')!
  const ratio = (staff.effects[0] as { ratio: number }).ratio
  const swing = duel([copyOf('dark-staff')])
  swing.addOrder(1, attack(4, 2))
  assert.deepEqual(hitsOn(play(swing, 12), 2, 12), [Math.round(100 + ratio * (staff.stats.arcane ?? 0))])
})
