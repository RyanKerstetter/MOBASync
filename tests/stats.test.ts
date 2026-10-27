import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  burn,
  Champion,
  champions,
  damage,
  enemiesInRadius,
  xpToReachLevel,
  GameSnapshotSchema,
  hastedCooldownTicks,
  loseHealth,
  NO_GROWTH,
  refundCooldown,
  resist,
  scaled,
  Simulator,
  startCooldown,
  statMultiplier,
  StatBlock,
  statReduction,
  type ChampionDef,
  type StatValues,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineAbility, defineChampion, defineMonster, economyClient, economySimulator } from './fixtures.ts'

// A champion's stats (see stats.ts): arcane, the ability power that the abilities which scale with it add to their damage; resistance, which takes a share off every hit it
// takes; and haste, which takes a share off its cooldowns, both by League's x / (100 + x); and the growth of each stat with its level.
// The tests own their content, with numbers made big so what each does is plain.

let made = 0
const unique = (prefix: string): string => `${prefix}-${(made += 1)}`

defineAbility({ id: 't-st-blast', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [damage(100, enemiesInRadius(200))] })
defineAbility({ id: 't-st-flame', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [burn(20, 600, enemiesInRadius(200))] })
// Each of these deals 10 and a tenth of one thing the caster has (a tenth, so the sum is plain); the last one deals all of them at once.
defineAbility({ id: 't-st-from-arcane', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [damage(scaled(10, { arcane: 0.1 }), enemiesInRadius(200))] })
defineAbility({ id: 't-st-from-damage', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [damage(scaled(10, { attackDamage: 0.1 }), enemiesInRadius(200))] })
defineAbility({ id: 't-st-from-max-health', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [damage(scaled(10, { maxHealth: 0.1 }), enemiesInRadius(200))] })
defineAbility({ id: 't-st-from-health', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [damage(scaled(10, { health: 0.1 }), enemiesInRadius(200))] })
defineAbility({ id: 't-st-from-level', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [damage(scaled(10, { level: 10 }), enemiesInRadius(200))] })
defineAbility({ id: 't-st-from-all', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [damage(scaled(10, { arcane: 0.1, attackDamage: 0.1, maxHealth: 0.01, health: 0.01, level: 1 }), enemiesInRadius(200))] })
defineAbility({ id: 't-st-burn-from-arcane', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [burn(scaled(20, { arcane: 0.5 }), 600, enemiesInRadius(200))] })
defineAbility({ id: 't-st-sting', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 60, apply: [loseHealth(300)] })
defineAbility({ id: 't-st-drain', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 60, apply: [loseHealth(100, enemiesInRadius(200))] })
defineAbility({ id: 't-st-guard', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [resist(0.5, 600)] })
defineAbility({ id: 't-st-mend', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 60, apply: [refundCooldown('t-st-blast', 0.5)] })
defineAbility({ id: 't-st-reset', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 60, apply: [startCooldown('t-st-blast')] })
const ABILITIES = [
  't-st-blast', 't-st-flame', 't-st-sting', 't-st-drain', 't-st-guard', 't-st-mend', 't-st-reset',
  't-st-from-arcane', 't-st-from-damage', 't-st-from-max-health', 't-st-from-health', 't-st-from-level', 't-st-from-all', 't-st-burn-from-arcane',
]

// What a test changes about the champion: the stats of its base and of its growth, each only in what it names.
type Tweak = { base?: Partial<StatValues>; growth?: Partial<StatValues> }

function champion(tweak: Tweak = {}, extra: Partial<ChampionDef> = {}): Champion {
  return defineChampion({
    id: unique('t-st-champion'),
    name: 'Stat Tester',
    base: { maxHp: 1000, attackDamage: 50, attackSpeed: 1, ...tweak.base },
    growth: tweak.growth,
    moveSpeed: 100,
    radius: 20,
    attackRange: 150,
    attackWindupTicks: 0,
    abilities: ABILITIES,
    ...extra,
  })
}

const A = { x: 600, y: 700 }
const B = { x: 700, y: 700 }
const cast = (seq: number, tick: number, abilityId: string, origin: Vector2) =>
  ({ id: `s${seq}`, seq, tick, type: 'cast' as const, abilityId, target: { mode: 'none' as const }, origin })
const attack = (seq: number, tick: number, targetId: number) => ({ id: `s${seq}`, seq, tick, type: 'attack' as const, targetId })

// Two players 100 apart, who are enemies: the caster (1), and a victim (2) with plenty of health to take it.
function duel(caster: Tweak = {}, victim: Tweak = {}): Simulator {
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p1', 'One', A, champion(caster), 1)
  simulator.addPlayer(2, 'p2', 'Two', B, champion({ base: { maxHp: 5000, ...victim.base }, growth: victim.growth }), 2)
  return simulator
}
const hp = (simulator: Simulator, tick: number, id = 2): number | undefined => simulator.at(tick).get(id)?.getHealth()

// ---------------------------------------------------------------------------- the formulas

test('a stat takes x / (100 + x) off, by League\'s formula: nothing for none, half for a hundred, and never all', () => {
  assert.equal(statReduction(0), 0)
  assert.equal(statReduction(100), 0.5)
  assert.equal(statReduction(300), 0.75)
  assert.ok(Math.abs(statReduction(25) - 0.2) < 1e-12)
  assert.ok(statReduction(1e9) < 1, 'however much there is')
  for (const odd of [-10, Number.NaN]) assert.equal(statReduction(odd), 0, `${odd} takes nothing off`)
  // What is left is the rest: 100 / (100 + x), and exactly 1 for none, so no resistance is no change to the damage.
  assert.equal(statMultiplier(0), 1)
  assert.equal(statMultiplier(100), 0.5)
  assert.ok(Math.abs(statMultiplier(300) - (1 - statReduction(300))) < 1e-12)
  assert.equal(statMultiplier(-5), 1)
})

test('a cooldown with haste is shortened by the same share, in whole ticks, and is never nothing unless it was', () => {
  assert.equal(hastedCooldownTicks(600, 0), 600)
  assert.equal(hastedCooldownTicks(600, 100), 300)
  assert.equal(hastedCooldownTicks(600, 25), 480)
  assert.equal(hastedCooldownTicks(100, 50), 67, '100 over 150 is 66.67 ticks, to the nearest')
  assert.equal(hastedCooldownTicks(1, 100000), 1, 'at least a tick, however much haste')
  assert.equal(hastedCooldownTicks(0, 100), 0, 'no cooldown stays none')
  assert.equal(hastedCooldownTicks(600, -50), 600, 'no negative haste')
})

// ---------------------------------------------------------------------------- what a champion is made of

test('a champion with nothing said in its growth has none, and no resistance, no haste and no arcane in its base, so it is the same at every level', () => {
  const plain = champion()
  assert.deepEqual([plain.resistance, plain.haste, plain.arcane], [0, 0, 0])
  assert.deepEqual({ ...plain.base }, { maxHp: 1000, attackDamage: 50, attackSpeed: 1, resistance: 0, haste: 0, arcane: 0 })
  assert.deepEqual({ ...plain.growth }, { ...NO_GROWTH })
  const first = plain.statsAt(1)
  assert.deepEqual(first, {
    maxHp: 1000, attackDamage: 50, attackSpeed: 1, attackRange: 150, moveSpeed: 100, resistance: 0, haste: 0, arcane: 0,
  })
  assert.deepEqual(plain.statsAt(18), first)
})

test('a champion holds its stats twice, as a base and as a growth, each a block of all six', () => {
  const grower = champion({ base: { resistance: 10 }, growth: { maxHp: 60, arcane: 0.04 } })
  assert.ok(grower.base instanceof StatBlock)
  assert.ok(grower.growth instanceof StatBlock)
  assert.notEqual(grower.base, grower.growth)
  assert.deepEqual({ ...grower.base }, { maxHp: 1000, attackDamage: 50, attackSpeed: 1, resistance: 10, haste: 0, arcane: 0 })
  assert.deepEqual({ ...grower.growth }, { maxHp: 60, attackDamage: 0, attackSpeed: 0, resistance: 0, haste: 0, arcane: 0.04 })
  // The plain reads of a stat are the base's.
  assert.deepEqual(
    [grower.maxHp, grower.attackDamage, grower.attackSpeed, grower.resistance, grower.haste, grower.arcane],
    [1000, 50, 1, 10, 0, 0],
  )
  // Two champions do not share a growth: what one is given is not the other's.
  const other = champion({ growth: { maxHp: 5 } })
  assert.equal(grower.growth.maxHp, 60)
  assert.equal(other.growth.maxHp, 5)
})

test('a block grows by a growth block, a level at a time, in every stat', () => {
  const base = new StatBlock({ maxHp: 1000, attackDamage: 50, attackSpeed: 1, resistance: 10, haste: 5, arcane: 1.1 })
  const growth = new StatBlock({ maxHp: 60, attackDamage: 3, attackSpeed: 0.5, resistance: 2, haste: 1, arcane: 0.1 })
  assert.deepEqual(base.grownBy(growth, 0), { ...base })
  const four = base.grownBy(growth, 4)
  assert.deepEqual(
    [four.maxHp, four.attackDamage, four.attackSpeed, four.resistance, four.haste],
    [1240, 62, 3, 18, 9],
  )
  assert.ok(Math.abs(four.arcane - 1.5) < 1e-12)
  assert.deepEqual({ ...base }, { maxHp: 1000, attackDamage: 50, attackSpeed: 1, resistance: 10, haste: 5, arcane: 1.1 }, 'and the block it grew from is as it was')
})

test('each level after the first adds the growth, to the stats that grow, and the range and the speed do not', () => {
  const grower = champion({
    base: { resistance: 10, haste: 5, arcane: 1.1 },
    growth: { maxHp: 60, attackDamage: 3, attackSpeed: 0.05, resistance: 2, haste: 1.5, arcane: 0.04 },
  })
  assert.deepEqual(grower.statsAt(1), {
    maxHp: 1000, attackDamage: 50, attackSpeed: 1, attackRange: 150, moveSpeed: 100, resistance: 10, haste: 5, arcane: 1.1,
  })
  const fifth = grower.statsAt(5) // four levels more
  assert.equal(fifth.maxHp, 1240)
  assert.equal(fifth.attackDamage, 62)
  assert.ok(Math.abs(fifth.attackSpeed - 1.2) < 1e-12)
  assert.equal(fifth.resistance, 18)
  assert.equal(fifth.haste, 11)
  assert.ok(Math.abs(fifth.arcane - 1.26) < 1e-12)
  assert.deepEqual([fifth.attackRange, fifth.moveSpeed], [150, 100])
  // Levels that are not levels: below the first, a part of one, and not a number.
  assert.deepEqual(grower.statsAt(0), grower.statsAt(1))
  assert.deepEqual(grower.statsAt(-3), grower.statsAt(1))
  assert.deepEqual(grower.statsAt(Number.NaN), grower.statsAt(1))
  assert.deepEqual(grower.statsAt(5.9), fifth, 'a part of a level is not one more')
  // The health stays a whole number, whatever the growth is.
  assert.equal(champion({ growth: { maxHp: 33.4 } }).statsAt(4).maxHp, 1100)
})

test('growth that is left out does not grow, and what grows is the champion\'s attack speed in its cooldown', () => {
  const onlyHealth = champion({ growth: { maxHp: 100 } })
  assert.equal(onlyHealth.statsAt(3).maxHp, 1200)
  assert.equal(onlyHealth.statsAt(3).attackDamage, 50)
  const quickening = champion({ base: { attackSpeed: 1 }, growth: { attackSpeed: 1 } })
  assert.equal(quickening.attackCooldownTicks, 60, 'a swing a second at level 1')
  assert.equal(quickening.attackCooldownTicksWith([], 1), 60)
  assert.equal(quickening.attackCooldownTicksWith([], 2), 30, 'twice a second at level 2')
  assert.equal(quickening.attackCooldownTicksWith([{ kind: 'attackspeed', amount: 0.5 }], 2), 20, 'and a bonus on top of it')
})

test('what a champion is made of has to be a number, 0 or more, in its base and in its growth', () => {
  const bad: Tweak[] = [
    { base: { resistance: -1 } }, { base: { haste: -1 } }, { base: { arcane: -0.5 } },
    { base: { resistance: Number.NaN } }, { base: { haste: Number.POSITIVE_INFINITY } },
    { base: { maxHp: -5 } }, { base: { attackSpeed: -1 } },
    { growth: { maxHp: -5 } }, { growth: { arcane: Number.NaN } },
  ]
  for (const tweak of bad) {
    const where = tweak.base ? 'base' : 'growth'
    assert.throws(
      () => champion(tweak),
      new RegExp(`has ${where} stats that are wrong: it needs an? \\w+ that is a number, 0 or more`),
      JSON.stringify(tweak),
    )
  }
  assert.throws(() => champion({ base: { arcane: -1 } }), /needs an arcane that is/, 'an arcane, and not a arcane')
  assert.throws(() => champion({ base: { haste: -1 } }), /needs a haste that is/)
  assert.doesNotThrow(() => champion({ base: { resistance: 0, haste: 0, arcane: 0 }, growth: { maxHp: 0 } }))
  // The base has to say its health, its attack damage and its attack speed: they are not left to a default.
  for (const left of ['maxHp', 'attackDamage', 'attackSpeed']) {
    const base = { maxHp: 1000, attackDamage: 50, attackSpeed: 1 } as Record<string, number | undefined>
    delete base[left]
    assert.throws(() => defineChampion({
      id: unique('t-st-champion'),
      name: `No ${left}`,
      base: base as ChampionDef['base'],
      moveSpeed: 100,
      radius: 20,
      attackRange: 150,
      attackWindupTicks: 0,
      abilities: [],
    }), new RegExp(`needs an? ${left} that is a number`), left)
  }
})

test('a stat declared on the champion itself, and not in its base or growth, is refused and not quietly ignored', () => {
  for (const stat of ['maxHp', 'attackDamage', 'attackSpeed', 'resistance', 'haste', 'arcane']) {
    assert.throws(
      () => champion({}, { [stat]: 5 } as Partial<ChampionDef>),
      new RegExp(`has ${stat} on its own: it goes in its base stats \\(and growth\\)`),
      stat,
    )
  }
})

test('every champion in the game declares its own base and growth, and it grows in each stat, from no resistance, haste or arcane', () => {
  const roster = [...champions.values()].filter((each) => !each.id.startsWith('t-'))
  assert.ok(roster.length >= 8)
  for (const each of roster) {
    assert.ok(each.base instanceof StatBlock && each.growth instanceof StatBlock, `${each.name} has a base and a growth`)
    assert.deepEqual([each.resistance, each.haste, each.arcane], [0, 0, 0], `${each.name} starts plain`)
    const first = each.statsAt(1)
    const last = each.statsAt(18)
    for (const key of ['maxHp', 'attackDamage', 'attackSpeed', 'resistance', 'haste', 'arcane'] as const) {
      assert.ok(each.growth[key] > 0, `${each.name} declares a growth in ${key}`)
      assert.ok(last[key] > first[key], `${each.name} grows in ${key}`)
    }
    assert.deepEqual([last.attackRange, last.moveSpeed], [first.attackRange, first.moveSpeed], `${each.name} does not grow in range or speed`)
  }
  // Each one has a growth of its own, to change without changing another's.
  const growths = roster.map((each) => each.growth)
  assert.equal(new Set(growths).size, growths.length, 'no two share a growth block')
})

// ---------------------------------------------------------------------------- arcane

test('arcane is an amount, and multiplies nothing: damage written flat is the same at any arcane', () => {
  for (const arcane of [0, 1, 200]) {
    const simulator = duel({ base: { arcane } })
    simulator.addOrder(1, cast(1, 1, 't-st-blast', A))
    assert.equal(hp(simulator, 3), 5000 - 100, `a blast of 100 at an arcane of ${arcane}`)
    const flame = duel({ base: { arcane } })
    flame.addOrder(1, cast(1, 1, 't-st-flame', A))
    assert.equal(flame.at(3).get(2)?.getStatuses().find((status) => status.kind === 'burn')?.amount, 10, `a burn of 20 a second at an arcane of ${arcane}`)
  }
  // An auto: 50 a hit, whatever the arcane. One lands in the first second.
  const auto = duel({ base: { arcane: 300 } })
  auto.addOrder(1, attack(1, 1, 2))
  assert.equal(hp(auto, 10), 5000 - 50)
})

test('an ability that scales with arcane adds its ratio of it to its damage, and the more arcane the harder it hits', () => {
  for (const arcane of [0, 40, 100, 250]) {
    const simulator = duel({ base: { arcane } })
    simulator.addOrder(1, cast(1, 1, 't-st-from-arcane', A))
    assert.equal(hp(simulator, 3), 5000 - (10 + arcane * 0.1), `10 and a tenth of an arcane of ${arcane}`)
  }
})

// What a cast at this tick takes off the victim (2) of a game, by two ticks after.
function dealt(simulator: Simulator, tick: number, abilityId: string): number {
  simulator.addOrder(1, cast(100 + tick, tick, abilityId, A))
  return 5000 - (hp(simulator, tick + 2) ?? 0)
}

test('an ability can scale with attack damage, with the most health, with the health it has, and with its level', () => {
  assert.equal(dealt(duel({ base: { attackDamage: 50 } }), 1, 't-st-from-damage'), 10 + 5, 'a tenth of 50 attack damage')
  assert.equal(dealt(duel({ base: { attackDamage: 200 } }), 1, 't-st-from-damage'), 10 + 20)
  assert.equal(dealt(duel({ base: { maxHp: 1000 } }), 1, 't-st-from-max-health'), 10 + 100, 'a tenth of 1000 health')
  assert.equal(dealt(duel({ base: { maxHp: 3000 } }), 1, 't-st-from-max-health'), 10 + 300)
  // The health it has: a tenth of 1000, and then of 700 once stung for 300 (the sting first, the cast after it).
  assert.equal(dealt(duel(), 1, 't-st-from-health'), 10 + 100)
  const stung = duel()
  stung.addOrder(1, cast(1, 1, 't-st-sting', A))
  assert.equal(dealt(stung, 10, 't-st-from-health'), 10 + 70, 'a tenth of the 700 it has left, not of the 1000 it can have')
  // The level: 10 a level, so 20 at level 2, with the champion that levels by killing the feed.
  assert.equal(dealt(grown({ leveled: false }), 70, 't-st-from-level'), 10 + 10)
  assert.equal(dealt(grown({ leveled: true }), 70, 't-st-from-level'), 10 + 20)
})

test('the stats an ability scales with are the owner\'s, and not the target\'s', () => {
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p1', 'One', A, champion({ base: { arcane: 100, attackDamage: 50, maxHp: 1000 } }), 1)
  simulator.addPlayer(2, 'p2', 'Two', B, champion({ base: { maxHp: 5000, arcane: 900, attackDamage: 900 } }), 2)
  simulator.addOrder(1, cast(1, 1, 't-st-from-all', A))
  // 10, a tenth of 100 arcane and of 50 attack damage, a hundredth of 1000 health and of the 1000 it has, and a level.
  assert.equal(hp(simulator, 3), 5000 - (10 + 10 + 5 + 10 + 10 + 1))
})

test('scaled adds only what it has ratios for, and with no ratios is its base', () => {
  const stats = champion({ base: { arcane: 100, attackDamage: 80 } }).statsAt(1)
  const reader = {
    statsOf: () => stats,
    levelOf: () => 1,
    healthOf: () => ({ hp: 500, maxHp: 1000 }),
    markersOn: () => [],
  } as never
  const src = { ownerId: 1 } as never
  assert.equal(scaled(40, {})(reader, src), 40)
  assert.equal(scaled(40, { arcane: 0 })(reader, src), 40, 'a ratio of nothing')
  assert.equal(scaled(40, { arcane: 0.5 })(reader, src), 90)
  assert.equal(scaled(40, { attackDamage: 0.5 })(reader, src), 80)
  assert.equal(scaled(40, { health: 0.5, maxHealth: 0.25, level: 3 })(reader, src), 40 + 250 + 250 + 3)
  assert.equal(scaled(() => 7, { arcane: 1 })(reader, src), 107, 'the base can be an amount of its own')
})

test('a burn that scales with arcane is set as it is lit, from the arcane then', () => {
  for (const [arcane, perPulse] of [[0, 10], [20, 10 + 5], [100, 35]] as const) {
    const simulator = duel({ base: { arcane } })
    simulator.addOrder(1, cast(1, 1, 't-st-burn-from-arcane', A))
    const lit = simulator.at(3).get(2)?.getStatuses().find((status) => status.kind === 'burn')
    assert.equal(lit?.amount, perPulse, `20 a second and half an arcane of ${arcane}, in a pulse`)
  }
})

// ---------------------------------------------------------------------------- resistance

test('resistance takes x / (100 + x) off every hit: an ability\'s and an auto\'s', () => {
  const blasted = duel({}, { base: { resistance: 100 } })
  blasted.addOrder(1, cast(1, 1, 't-st-blast', A))
  assert.equal(hp(blasted, 3), 5000 - 50, 'a hundred takes half of 100')
  const struck = duel({}, { base: { resistance: 100 } })
  struck.addOrder(1, attack(1, 1, 2))
  assert.equal(hp(struck, 10), 5000 - 25, 'and half of an auto\'s 50')
  const plain = duel()
  plain.addOrder(1, cast(1, 1, 't-st-blast', A))
  assert.equal(hp(plain, 3), 5000 - 100, 'and none takes none off')
  const heavy = duel({}, { base: { resistance: 300 } })
  heavy.addOrder(1, cast(1, 1, 't-st-blast', A))
  assert.equal(hp(heavy, 3), 5000 - 25, 'three hundred takes three quarters')
})

test('resistance and a resist status both apply, one after the other, and a health cost is not damage', () => {
  // A resist status that takes half off, on a unit that has a resistance of 100 as well: a quarter of the damage is taken.
  const both = duel({}, { base: { resistance: 100 } })
  both.addOrder(2, cast(1, 1, 't-st-guard', B))
  both.addOrder(1, cast(1, 3, 't-st-blast', A))
  assert.equal(hp(both, 5), 5000 - 25)
  // A health cost ignores resistance, as it always has.
  const drained = duel({}, { base: { resistance: 100 } })
  drained.addOrder(1, cast(1, 1, 't-st-drain', A))
  assert.equal(hp(drained, 3), 5000 - 100)
})

// ---------------------------------------------------------------------------- haste

test('haste shortens the cooldown an ability starts with, by the formula', () => {
  for (const [haste, cooldown] of [[0, 600], [100, 300], [25, 480]] as const) {
    const simulator = duel({ base: { haste } })
    simulator.addOrder(1, cast(1, 1, 't-st-blast', A))
    assert.equal(simulator.at(1).get(1)?.getAbilityCooldown('t-st-blast').ticksRemaining, cooldown, `at a haste of ${haste}`)
  }
})

test('haste shortens a cooldown that is put back on its whole, and what a refund takes off is a share of the shortened one', () => {
  const reset = duel({ base: { haste: 100 } })
  reset.addOrder(1, cast(1, 1, 't-st-reset', A))
  assert.equal(reset.at(1).get(1)?.getAbilityCooldown('t-st-blast').ticksRemaining, 300, 'on its whole cooldown, which is half of 600')
  // Cast it at tick 1; at tick 5 take half of its cooldown off.
  for (const [haste, remaining] of [[0, 295], [100, 145]] as const) {
    const simulator = duel({ base: { haste } })
    simulator.addOrder(1, cast(1, 1, 't-st-blast', A))
    simulator.addOrder(1, cast(2, 5, 't-st-mend', A))
    assert.equal(simulator.at(6).get(1)?.getAbilityCooldown('t-st-blast').ticksRemaining, remaining, `at a haste of ${haste}`)
  }
})

// ---------------------------------------------------------------------------- levels

// A champion that grows by a lot in each stat, so what a level does is plain: at level 2 it has 1100 health, 60 attack damage, twice the
// attack speed, 100 resistance, 100 haste and an arcane of 100.
const grower = champion({
  growth: { maxHp: 100, attackDamage: 10, attackSpeed: 1, resistance: 100, haste: 100, arcane: 100 },
})
// A monster worth a level, that dies to one auto.
const feed = defineMonster({
  id: unique('t-st-feed'),
  name: 'Feed',
  base: { maxHp: 40, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300 },
  reward: { gold: 0, xp: xpToReachLevel(2), shards: 0 },
})

// The grower (1), a victim with plenty of health (2), and someone to hurt the grower (3). With `leveled` the grower first kills the feed (10), by tick
// 3, and is at level 2; without it, it is at level 1. `hurt` stings the grower for 300 first.
function grown(options: { leveled: boolean; hurt?: boolean }): Simulator {
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p1', 'One', A, grower, 1)
  simulator.addPlayer(2, 'p2', 'Two', B, champion({ base: { maxHp: 5000 } }), 2)
  simulator.addPlayer(3, 'p3', 'Three', { x: 500, y: 700 }, champion({ base: { maxHp: 5000 } }), 3)
  if (options.hurt) simulator.addOrder(1, cast(1, 1, 't-st-sting', A))
  if (options.leveled) {
    simulator.addMonster(10, feed, { x: 640, y: 700 })
    simulator.addOrder(1, attack(2, 3, 10))
  }
  return simulator
}

test('a kill that is enough for a level raises it on the tick of the kill, with the health the level gives', () => {
  const simulator = grown({ leveled: true })
  const before = simulator.at(2).get(1)
  assert.deepEqual([before?.getLevel(), before?.getHealthState()?.maxHp, before?.getHealth()], [1, 1000, 1000])
  const after = simulator.at(10).get(1)
  assert.deepEqual([after?.getLevel(), after?.getXp()], [2, xpToReachLevel(2)])
  assert.deepEqual([after?.getHealthState()?.maxHp, after?.getHealth()], [1100, 1100], 'a level more health, and the health with it')
  assert.equal(simulator.at(10).get(10)?.isDead(), true, 'it was the feed that died')
})

test('the health a level adds is added to the health it has, and not made up', () => {
  const simulator = grown({ leveled: true, hurt: true })
  const hurt = simulator.at(2).get(1)
  assert.deepEqual([hurt?.getHealth(), hurt?.getHealthState()?.maxHp], [700, 1000], 'stung for 300')
  const leveled = simulator.at(10).get(1)
  assert.deepEqual([leveled?.getHealth(), leveled?.getHealthState()?.maxHp], [800, 1100], 'still 300 short')
})

test('the attack damage and attack speed of a level are in its autos', () => {
  for (const [leveled, dealt, next] of [[false, 50, 130], [true, 60, 100]] as const) {
    const simulator = grown({ leveled })
    simulator.addOrder(1, attack(3, 70, 2))
    assert.equal(5000 - (hp(simulator, 72) ?? 0), dealt, `level ${leveled ? 2 : 1}: the damage of an auto`)
    assert.equal(simulator.at(72).get(1)?.getNextAttackTick(), next, `level ${leveled ? 2 : 1}: when the next one is ready`)
  }
})

test('the haste and arcane of a level are in its abilities', () => {
  for (const [leveled, cooldown, scaledDamage] of [[false, 600, 10], [true, 300, 20]] as const) {
    const simulator = grown({ leveled })
    simulator.addOrder(1, cast(3, 70, 't-st-blast', A))
    assert.equal(simulator.at(70).get(1)?.getAbilityCooldown('t-st-blast').ticksRemaining, cooldown, `level ${leveled ? 2 : 1}: the cooldown`)
    assert.equal(5000 - (hp(simulator, 72) ?? 0), 100, `level ${leveled ? 2 : 1}: a blast written flat is as it is written`)
    // 10 and a tenth of the arcane: none at level 1, 100 at level 2.
    assert.equal(dealt(grown({ leveled }), 70, 't-st-from-arcane'), scaledDamage, `level ${leveled ? 2 : 1}: the damage of one that scales`)
  }
})

test('the resistance of a level takes off what hits it', () => {
  for (const [leveled, taken] of [[false, 100], [true, 50]] as const) {
    const simulator = grown({ leveled })
    simulator.addOrder(3, cast(1, 70, 't-st-blast', { x: 500, y: 700 }))
    const grownHealth = simulator.at(72).get(1)
    assert.equal((leveled ? 1100 : 1000) - (grownHealth?.getHealth() ?? 0), taken, `level ${leveled ? 2 : 1}`)
  }
})

test('a monster has stats too, and is at level 1 since it earns nothing', () => {
  const tough = defineMonster({
    id: unique('t-st-tough'),
    name: 'Tough',
    base: { maxHp: 5000, attackDamage: 1, attackSpeed: 1, resistance: 100 },
    moveSpeed: 100,
    radius: 20,
    attackRange: 60,
    attackWindupTicks: 0,
    abilities: [],
    ai: { aggroRange: 0, deaggroRange: 300 },
  })
  const simulator = economySimulator()
  simulator.addMonster(10, tough, B)
  simulator.addPlayer(1, 'p1', 'One', A, champion(), 1)
  simulator.addOrder(1, cast(1, 1, 't-st-blast', A))
  assert.equal(simulator.at(3).get(10)?.getHealth(), 5000 - 50, 'a monster\'s resistance takes half off')
  assert.equal(simulator.at(3).get(10)?.getLevel(), 1)
})

test('the level is kept through a death and a respawn, and a respawn is at the health of that level', () => {
  // The grower levels up on the feed, and then someone who hits for 5000 kills it; it is back after its respawn time.
  const killer = champion({ base: { attackDamage: 5000 } })
  const slain = economySimulator()
  slain.addPlayer(1, 'p1', 'One', A, grower, 1)
  slain.addPlayer(3, 'p3', 'Three', { x: 500, y: 700 }, killer, 3)
  slain.addMonster(10, feed, { x: 640, y: 700 })
  slain.addOrder(1, attack(2, 3, 10))
  slain.addOrder(3, { id: 'k', seq: 1, tick: 20, type: 'attack', targetId: 1 })
  assert.equal(slain.at(30).get(1)?.isDead(), true, 'it was killed')
  assert.equal(slain.at(30).get(1)?.getLevel(), 2, 'and keeps its level')
  const back = slain.at(20 + 180 + 1).get(1)
  assert.deepEqual([back?.isDead(), back?.getLevel(), back?.getHealthState()?.maxHp, back?.getHealth()], [false, 2, 1100, 1100])
})

// ---------------------------------------------------------------------------- the same on every peer

test('a frame that is worked out again after a late order is the same as one worked out straight through, and pays the experience once', () => {
  const orders = (simulator: Simulator, withLate: boolean): void => {
    if (withLate) simulator.addOrder(3, { id: 'late', seq: 1, tick: 2, type: 'move', target: { x: 520, y: 700 } })
  }
  const straight = grown({ leveled: true })
  orders(straight, true)
  const frame = (simulator: Simulator) => JSON.parse(JSON.stringify(simulator.at(12).toData()))

  // Worked out first without the late order, and then with it, which changes tick 2 and so everything after, the kill and the level-up included.
  const rolledBack = grown({ leveled: true })
  rolledBack.advanceTo(12)
  assert.equal(rolledBack.at(12).get(1)?.getXp(), xpToReachLevel(2))
  orders(rolledBack, true)
  assert.equal(rolledBack.at(12).get(1)?.getXp(), xpToReachLevel(2), 'once, not twice')
  assert.deepEqual(frame(rolledBack), frame(straight))
})

test('the experience and the level it makes are in a snapshot, and a simulator that restores one has them', () => {
  const server = grown({ leveled: true })
  server.advanceTo(40)
  server.setCommitTick(40)
  const snapshot = JSON.parse(JSON.stringify(server.snapshot()))
  assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)
  const client = economySimulator()
  client.replaceFromSnapshot(GameSnapshotSchema.parse(snapshot))
  const restored = client.at(client.tick).get(1)
  assert.deepEqual([restored?.getXp(), restored?.getLevel(), restored?.getHealthState()?.maxHp], [xpToReachLevel(2), 2, 1100])
})

// ---------------------------------------------------------------------------- what the page shows

test('the page lists the stats of the champion\'s level, and the cooldowns it shows are the shortened ones', () => {
  const state = economyClient()
  state.simulator.addPlayer(1, 'p1', 'One', A, grower, 1)
  state.simulator.addMonster(10, feed, { x: 640, y: 700 })
  state.setLocalCharacterId(1)
  const blastCooldown = (): number | undefined => state.getAbilityCooldowns(0).find((slot) => slot.abilityId === 't-st-blast')?.cooldownTicks
  assert.deepEqual([state.getLocalStats(0)?.maxHp, state.getLocalStats(0)?.attackDamage, state.getLocalStats(0)?.arcane], [1000, 50, 0])
  assert.equal(blastCooldown(), 600)
  state.simulator.addOrder(1, attack(1, 3, 10))
  state.simulator.advanceTo(20)
  state.simulator.setCommitTick(20)
  const stats = state.getLocalStats(0)
  assert.deepEqual([stats?.maxHp, stats?.attackDamage, stats?.attackSpeed, stats?.resistance, stats?.haste, stats?.arcane], [1100, 60, 2, 100, 100, 100])
  assert.equal(blastCooldown(), 300, 'a hundred haste halves the cooldown, so the icon fills over that long')
})

// ---------------------------------------------------------------------------- the abilities in the game

test('the abilities in the game scale with what they say: Spout with arcane, Kunai with attack damage, Tsunami with health and arcane', () => {
  // The caster of a real ability, with the stats named and an enemy 100 away with plenty of health, that the ability is cast at. Returns what it took.
  const hit = (abilityId: string, stats: Partial<StatValues>, target: object): number => {
    const caster = defineChampion({
      id: unique('t-st-real'), name: 'Real', base: { maxHp: 1000, attackDamage: 50, attackSpeed: 1, ...stats }, moveSpeed: 100, radius: 20,
      attackRange: 150, attackWindupTicks: 0, abilities: [abilityId],
    })
    const simulator = economySimulator()
    simulator.addPlayer(1, 'p1', 'One', A, caster, 1)
    simulator.addPlayer(2, 'p2', 'Two', B, champion({ base: { maxHp: 50000 } }), 2)
    simulator.addOrder(1, { id: 's1', seq: 1, tick: 1, type: 'cast', abilityId, target: target as never, origin: A })
    simulator.advanceTo(120)
    return 50000 - (simulator.at(120).get(2)?.getHealth() ?? 0)
  }
  const spout = (arcane: number) => hit('spout', { arcane }, { mode: 'point', point: B })
  assert.equal(spout(100) - spout(0), 70, 'Spout adds 0.7 of the arcane')
  assert.ok(spout(0) > 0, 'and hits with none')
  const kunai = (attackDamage: number) => hit('shuriken', { attackDamage }, { mode: 'direction', dir: { x: 1, y: 0 } })
  assert.equal(kunai(150) - kunai(50), 30, 'Kunai adds 0.3 of the attack damage')
  assert.equal(hit('shuriken', { arcane: 500 }, { mode: 'direction', dir: { x: 1, y: 0 } }), kunai(50), 'and none of the arcane')
  const tsunami = (stats: Partial<StatValues>) => hit('tsunami', stats, { mode: 'direction', dir: { x: 1, y: 0 } })
  assert.equal(tsunami({ maxHp: 2000 }) - tsunami({ maxHp: 1000 }), 80, 'Tsunami adds 8% of the most health')
  assert.equal(tsunami({ arcane: 100 }) - tsunami({}), 30, 'and 0.3 of the arcane')
})
