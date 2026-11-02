import assert from 'node:assert/strict'
import test from 'node:test'
import { abilityTooltip, amountFormula } from '../apps/client/src/ui/ability-tooltip.ts'
import {
  abilityDefs,
  abilityName,
  abilityNumbers,
  amountValue,
  burn,
  damage,
  dash,
  GAME_TPS,
  getAbilityDef,
  heal,
  linear,
  missingHealth,
  scaled,
  self,
  shield,
  spawnEntity,
  stacks,
  when,
  type AbilityDef,
  type ChampionStats,
  type EntityDef,
  type Scaling,
} from '../packages/shared/src/index.ts'
import {
  GUARD_SCALING,
  GUARD_SHIELD,
  GUARD_SHIELD_ALONE,
  LINK_HEAL,
  LINK_HEAL_SCALING,
  PULSE_HEAL,
  PULSE_HEAL_SCALING,
  REJUVENATE_HEAL,
  REJUVENATE_MISSING,
  REJUVENATE_SCALING,
  SHURIKEN_DAMAGE,
  SHURIKEN_SCALING,
  SPOUT_DAMAGE,
  SPOUT_SCALING,
  TSUNAMI_DAMAGE,
  TSUNAMI_SCALING,
} from '../packages/shared/src/abilities.ts'
import { defineAbility } from './fixtures.ts'

// What the box over an ability says: its numbers are found in the ability itself, worked out for the champion as it is, and told with what they are made of.
// The abilities of the game are checked against the base and ratios they export, so retuning one changes nothing here; the rest are the tests' own ("t-at-"),
// with numbers spelled out.

const RATIO_KEYS = ['arcane', 'attackDamage', 'maxHealth', 'health', 'level'] as const

const ability = (id: string, apply: AbilityDef['apply'], rest: Partial<AbilityDef> = {}): AbilityDef => defineAbility({
  id,
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: 8 * GAME_TPS,
  apply,
  ...rest,
})

const champion = (overrides: Partial<ChampionStats> = {}): ChampionStats => ({
  maxHp: 900,
  attackDamage: 60,
  attackSpeed: 1,
  attackRange: 100,
  moveSpeed: 300,
  resistance: 0,
  haste: 0,
  arcane: 0,
  ...overrides,
})

// ---------------------------------------------------------------------------- finding the numbers

test('the damage of the abilities in the game is found in them, with the base and ratios they are written with', () => {
  const written: Array<[string, number, Scaling]> = [
    ['spout', SPOUT_DAMAGE, SPOUT_SCALING],
    ['shuriken', SHURIKEN_DAMAGE, SHURIKEN_SCALING],
    ['tsunami', TSUNAMI_DAMAGE, TSUNAMI_SCALING],
  ]
  for (const [id, base, scaling] of written) {
    const def = getAbilityDef(id)
    assert.ok(def, `${id} is an ability`)
    const found = abilityNumbers(def).find((number) => number.kind === 'damage' && number.amount.base === base)
    assert.ok(found, `${id} tells its damage`)
    for (const key of RATIO_KEYS) {
      assert.equal(found.amount.ratios[key] ?? 0, scaling[key] ?? 0, `${id} tells its ratio of ${key}`)
    }
  }
})

test('an ability is looked through for its numbers wherever it puts them, in the order they come', () => {
  const [CAST, HIT, TICK, PULSE, EXPIRE, THEN, OTHERWISE, DASH_HIT, DASH_CONNECT, DASH_MISS, EMPOWERED] = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
  const shot = {
    id: 't-at-shot',
    speed: 100,
    radius: 5,
    lifetimeTicks: 30,
    pierce: true,
    pulseEveryTicks: 10,
    onHit: [damage(HIT)],
    onTick: [burn(TICK)],
    onPulse: [damage(PULSE)],
    onExpire: [damage(EXPIRE)],
  }
  const def = ability('t-at-places', [
    damage(CAST),
    spawnEntity(shot),
    when(() => true, [damage(THEN)], [damage(OTHERWISE)]),
    dash(100, 100, self(), { on: { id: 't-at-dash', onHit: [damage(DASH_HIT)], onConnect: [damage(DASH_CONNECT)], onMiss: [damage(DASH_MISS)] } }),
  ], { empowerAttack: { ticks: 60, effects: [damage(EMPOWERED)] } })

  assert.deepEqual(
    abilityNumbers(def).map((number) => [number.kind, number.amount.base]),
    [
      ['damage', CAST], ['damage', HIT], ['burn', TICK], ['damage', PULSE], ['damage', EXPIRE], ['damage', THEN], ['damage', OTHERWISE],
      ['damage', DASH_HIT], ['damage', DASH_CONNECT], ['damage', DASH_MISS], ['damage', EMPOWERED],
    ],
  )
})

test('an amount tells its base, what it adds for a stack or for health missing, and the ratios of the caster', () => {
  const [BASE, PER_STACK, ARCANE, LEVEL] = [40, 7, 0.5, 2]
  const [FLAT, MISSING, ATTACK] = [30, 0.04, 0.3]
  const [DPS, BURN_ARCANE] = [25, 0.2]
  const def = ability('t-at-parts', [
    damage(scaled(linear(BASE, PER_STACK, stacks('t-at-key')), { arcane: ARCANE, level: LEVEL })),
    damage(scaled(linear(FLAT, MISSING, missingHealth()), { attackDamage: ATTACK })),
    burn(scaled(DPS, { arcane: BURN_ARCANE })),
  ])
  const [grows, wounds, burns] = abilityNumbers(def)

  assert.deepEqual(grows.amount, { base: BASE, perStack: PER_STACK, perMissingHealth: 0, ratios: { arcane: ARCANE, level: LEVEL } })
  assert.deepEqual(wounds.amount, { base: FLAT, perStack: 0, perMissingHealth: MISSING, ratios: { attackDamage: ATTACK } })
  assert.deepEqual([burns.kind, burns.amount.base, burns.amount.ratios], ['burn', DPS, { arcane: BURN_ARCANE }])
})

test('ratios on the same stat add, and a plain number added to the base is part of it', () => {
  const [BASE, EXTRA, ONE, TWO] = [20, 5, 0.25, 0.5]
  const def = ability('t-at-sums', [damage(scaled(scaled(linear(BASE, EXTRA, 1), { arcane: ONE }), { arcane: TWO }))])
  const [number] = abilityNumbers(def)

  assert.equal(number.amount.base, BASE + EXTRA)
  assert.equal(number.amount.ratios.arcane, ONE + TWO)
})

test('a number that is not made of anything that can be told is left out, and one met twice is told once', () => {
  const [SAME, OTHER] = [33, 44]
  const worked = ability('t-at-worked', [damage(() => OTHER), damage(linear(OTHER, 1, () => 3))])
  assert.deepEqual(abilityNumbers(worked), [], 'a number worked out by hand, or added to one, says nothing')

  const twice = ability('t-at-twice', [when(() => true, [damage(SAME)], [damage(SAME), damage(OTHER)])])
  assert.deepEqual(abilityNumbers(twice).map((number) => number.amount.base), [SAME, OTHER])
})

test('an ability with nothing to hurt with has no numbers', () => {
  assert.deepEqual(abilityNumbers(ability('t-at-nothing', [])), [])
})

// ---------------------------------------------------------------------------- what they come to

test('an amount comes to its base and the caster\'s stats times its ratios, with a stack or health missing counting as none', () => {
  const [BASE, PER_STACK, MISSING, ARCANE, ATTACK, MAX_HEALTH, HEALTH, LEVEL] = [10, 4, 0.1, 0.5, 0.25, 0.1, 0.2, 3]
  const def = ability('t-at-value', [
    damage(scaled(linear(linear(BASE, MISSING, missingHealth()), PER_STACK, stacks('t-at-key')), {
      arcane: ARCANE, attackDamage: ATTACK, maxHealth: MAX_HEALTH, health: HEALTH, level: LEVEL,
    })),
  ])
  const caster = { arcane: 120, attackDamage: 80, maxHealth: 1500, health: 700, level: 6 }

  assert.equal(
    amountValue(abilityNumbers(def)[0].amount, caster),
    BASE + ARCANE * caster.arcane + ATTACK * caster.attackDamage + MAX_HEALTH * caster.maxHealth + HEALTH * caster.health + LEVEL * caster.level,
  )
})

// ---------------------------------------------------------------------------- what is said

test('the tooltip gives the name and the key, what it does, the damage for the champion as it is, and the cooldown', () => {
  const [BASE, ARCANE, ATTACK] = [60, 0.5, 0.25]
  const def = ability('t-at-tip', [damage(scaled(BASE, { arcane: ARCANE, attackDamage: ATTACK }))], {
    name: 'Tip Test',
    description: 'Hurts things.',
  })
  const stats = champion({ arcane: 80, attackDamage: 90 })
  const tip = abilityTooltip(def.id, { key: 'W', cooldownTicks: def.cooldownTicks, stats, level: 1, health: stats.maxHp })

  assert.deepEqual(tip, {
    name: 'Tip Test',
    slot: 'W',
    about: 'Hurts things.',
    stats: [
      { label: 'Damage', value: String(Math.round(BASE + ARCANE * stats.arcane + ATTACK * stats.attackDamage)), detail: `${BASE} + ${ARCANE * 100}% Arcane + ${ATTACK * 100}% Attack damage` },
      { label: 'Cooldown', value: `${def.cooldownTicks / GAME_TPS}s` },
    ],
  })
})

test('the damage follows the champion: its stats, its level and its health, and the cooldown follows its haste', () => {
  const [BASE, ARCANE, ATTACK, MAX_HEALTH, HEALTH, LEVEL] = [50, 0.4, 0.2, 0.05, 0.1, 3]
  const def = ability('t-at-follow', [damage(scaled(BASE, { arcane: ARCANE, attackDamage: ATTACK, maxHealth: MAX_HEALTH, health: HEALTH, level: LEVEL }))])
  const damageOf = (stats: ChampionStats, level: number, health: number): string | undefined =>
    abilityTooltip(def.id, { key: 'Q', cooldownTicks: def.cooldownTicks, stats, level, health })?.stats[0].value

  const weak = champion({ arcane: 0, attackDamage: 40, maxHp: 800 })
  const strong = champion({ arcane: 200, attackDamage: 150, maxHp: 2000 })
  assert.equal(damageOf(weak, 1, 800), String(Math.round(BASE + ATTACK * 40 + MAX_HEALTH * 800 + HEALTH * 800 + LEVEL * 1)))
  assert.equal(damageOf(strong, 9, 500), String(Math.round(BASE + ARCANE * 200 + ATTACK * 150 + MAX_HEALTH * 2000 + HEALTH * 500 + LEVEL * 9)))

  const hasted = Math.round(def.cooldownTicks * 0.75)
  const tip = abilityTooltip(def.id, { key: 'Q', cooldownTicks: hasted, stats: champion(), level: 1, health: 900 })
  assert.deepEqual(tip?.stats.at(-1), {
    label: 'Cooldown',
    value: `${Number((hasted / GAME_TPS).toFixed(1))}s`,
    detail: `${def.cooldownTicks / GAME_TPS}s without haste`,
  })
})

test('a burn is told a second, one that grows with a stack is told with the stack, and a flat number has nothing under it', () => {
  const [DPS, BURN_ARCANE, FLAT, EVERY_STACK, BASE] = [24, 0.5, 70, 15, 35]
  const def = ability('t-at-kinds', [
    burn(scaled(DPS, { arcane: BURN_ARCANE })),
    damage(FLAT),
    damage(linear(BASE, EVERY_STACK, stacks('t-at-key'))),
  ])
  const stats = champion({ arcane: 100 })
  const [burning, flat, stacking] = abilityTooltip(def.id, { key: 'E', cooldownTicks: def.cooldownTicks, stats, level: 1, health: 900 })?.stats ?? []

  assert.deepEqual(burning, { label: 'Burn', value: `${DPS + BURN_ARCANE * stats.arcane}/s`, detail: `${DPS} + ${BURN_ARCANE * 100}% Arcane` })
  assert.deepEqual(flat, { label: 'Damage', value: String(FLAT) })
  assert.deepEqual(stacking, { label: 'Damage', value: String(BASE), detail: `${BASE} + ${EVERY_STACK} per stack` })
})

test('an ability with no damage has its cooldown and nothing else, and one with no description has no line for it', () => {
  const def = ability('t-at-quiet', [], { cooldownTicks: 5 * GAME_TPS })
  const tip = abilityTooltip(def.id, { key: 'R', cooldownTicks: def.cooldownTicks, stats: champion(), level: 1, health: 900 })

  assert.deepEqual(tip?.stats, [{ label: 'Cooldown', value: '5s' }])
  assert.equal(tip?.about, undefined)
  assert.equal(abilityTooltip('t-at-not-an-ability', { key: 'Q', cooldownTicks: 60, stats: champion(), level: 1, health: 900 }), undefined)
})

test('a formula is told only when there is something besides the number, with the stats named as the stats panel names them', () => {
  const none = { arcane: 0, attackDamage: 0, maxHealth: 0, health: 0, level: 0 }
  assert.equal(amountFormula({ base: 50, perStack: 0, perMissingHealth: 0, ratios: {} }), undefined)
  assert.equal(amountFormula({ base: 0, perStack: 0, perMissingHealth: 0, ratios: none }), undefined)
  assert.equal(amountFormula({ base: 0, perStack: 12, perMissingHealth: 0, ratios: {} }), '12 per stack', 'a base of nothing is left out')
  assert.equal(
    amountFormula({ base: 5, perStack: 0, perMissingHealth: 0.06, ratios: { maxHealth: 0.1, health: 0.2, level: 4 } }),
    '5 + 6% of missing health + 10% Max health + 20% Health + 4 per level',
  )
})

// ---------------------------------------------------------------------------- the game

test('every ability in the game has a name, says what it does and tells its cooldown', () => {
  const real = [...abilityDefs.values()].filter((def) => !def.id.startsWith('t-'))
  assert.ok(real.length > 0)
  for (const def of real) {
    const tip = abilityTooltip(def.id, { key: 'Q', cooldownTicks: def.cooldownTicks, stats: champion(), level: 1, health: 900 })
    assert.ok(tip, `${def.id} has a tooltip`)
    assert.ok(tip.name.length > 0, `${def.id} has a name`)
    assert.ok((def.description ?? '').length > 0, `${def.id} says what it does`)
    assert.equal(tip.about, def.description)
    assert.deepEqual(tip.stats.at(-1), { label: 'Cooldown', value: `${Number((def.cooldownTicks / GAME_TPS).toFixed(1))}s` }, `${def.id} tells its cooldown`)
  }
})

test('an ability is called by its name, or else by its id made into words', () => {
  assert.equal(abilityName({ id: 'shadowstep', name: 'Shadow Step' }), 'Shadow Step')
  assert.equal(abilityName({ id: 'feast' }), 'Feast')
  assert.equal(abilityName({ id: 'monster-slam' }), 'Monster Slam')
})

// ---------------------------------------------------------------------------- heals and shields

test('a heal and a shield are told like damage: the number for the caster, with what it is made of, and the heal tells the share of the health missing', () => {
  const [HEAL, MISSING, HEAL_ARCANE, SHIELD, SHIELD_HEALTH] = [60, 0.2, 0.4, 120, 0.1]
  const def = ability('t-at-mend', [
    heal(linear(scaled(HEAL, { arcane: HEAL_ARCANE }), MISSING, missingHealth()), self()),
    shield(scaled(SHIELD, { maxHealth: SHIELD_HEALTH }), 100, self()),
    damage(40),
  ])
  const stats = champion({ arcane: 50, maxHp: 1200 })
  const tip = abilityTooltip(def.id, { key: 'E', cooldownTicks: def.cooldownTicks, stats, level: 1, health: stats.maxHp })

  assert.deepEqual(tip?.stats.slice(0, 3), [
    { label: 'Heal', value: String(Math.round(HEAL + HEAL_ARCANE * stats.arcane)), detail: `${HEAL} + ${MISSING * 100}% of missing health + ${HEAL_ARCANE * 100}% Arcane` },
    { label: 'Shield', value: String(Math.round(SHIELD + SHIELD_HEALTH * stats.maxHp)), detail: `${SHIELD} + ${SHIELD_HEALTH * 100}% Max health` },
    { label: 'Damage', value: '40' },
  ])
})

test('a flat heal or shield has no formula under it, and one that is not told is left out', () => {
  const def = ability('t-at-flat-mend', [heal(30, self()), shield(90, 100, self()), heal(() => 5, self())])
  assert.deepEqual(abilityNumbers(def).map((number) => [number.kind, number.amount.base]), [['heal', 30], ['shield', 90]])
  const tip = abilityTooltip(def.id, { key: 'W', cooldownTicks: def.cooldownTicks, stats: champion(), level: 1, health: 900 })
  assert.deepEqual(tip?.stats.slice(0, 2), [{ label: 'Heal', value: '30' }, { label: 'Shield', value: '90' }])
})

test('a heal that a pulse repeats is told for a second, and what else a pulse does is told as it always was', () => {
  const [EVERY, HEAL, ARCANE, HIT] = [30, 8, 0.1, 15]
  const bot: EntityDef = {
    id: 't-at-bot',
    speed: 0,
    radius: 8,
    lifetimeTicks: 600,
    pulseEveryTicks: EVERY,
    onPulse: [heal(scaled(HEAL, { arcane: ARCANE }), self()), damage(HIT)],
  }
  const def = ability('t-at-bot-cast', [spawnEntity(bot)])
  const stats = champion({ arcane: 100 })
  const tip = abilityTooltip(def.id, { key: 'E', cooldownTicks: def.cooldownTicks, stats, level: 1, health: 900 })
  const pulses = GAME_TPS / EVERY

  assert.deepEqual(tip?.stats.slice(0, 2), [
    { label: 'Heal', value: `${Math.round((HEAL + ARCANE * stats.arcane) * pulses)}/s`, detail: `${HEAL * pulses} + ${Math.round(ARCANE * pulses * 1000) / 10}% Arcane` },
    { label: 'Damage', value: String(HIT) },
  ])
})

test('the heals and shields of the abilities in the game are found in them, with the numbers they are written with', () => {
  const stats = champion({ arcane: 100, maxHp: 1000 })
  const lines = (id: string) => abilityTooltip(id, { key: 'Q', cooldownTicks: 60, stats, level: 1, health: 600 })?.stats ?? []
  const percent = (ratio: number): string => `${Number((ratio * 100).toFixed(1))}%`

  // Rejuvenate: a set amount, a share of the health missing, and the arcane it grows with. (How much is missing is not known without a target, so it counts as none.)
  assert.deepEqual(lines('rejuvenate')[0], {
    label: 'Heal',
    value: String(Math.round(REJUVENATE_HEAL + (REJUVENATE_SCALING.arcane ?? 0) * stats.arcane)),
    detail: `${REJUVENATE_HEAL} + ${percent(REJUVENATE_MISSING)} of missing health + ${percent(REJUVENATE_SCALING.arcane ?? 0)} Arcane`,
  })
  // Monk's heal and shields grow with his arcane.
  const monkHeal = { label: 'Heal', value: String(Math.round(LINK_HEAL + (LINK_HEAL_SCALING.arcane ?? 0) * stats.arcane)), detail: `${LINK_HEAL} + ${percent(LINK_HEAL_SCALING.arcane ?? 0)} Arcane` }
  assert.deepEqual(lines('link')[0], monkHeal)
  assert.deepEqual(lines('linkheal')[0], monkHeal, 'and Link Heal gives the same')
  assert.deepEqual(lines('guard').slice(0, 2), [
    { label: 'Shield', value: String(Math.round(GUARD_SHIELD + (GUARD_SCALING.arcane ?? 0) * stats.arcane)), detail: `${GUARD_SHIELD} + ${percent(GUARD_SCALING.arcane ?? 0)} Arcane` },
    { label: 'Shield', value: String(Math.round(GUARD_SHIELD_ALONE + (GUARD_SCALING.arcane ?? 0) * stats.arcane)), detail: `${GUARD_SHIELD_ALONE} + ${percent(GUARD_SCALING.arcane ?? 0)} Arcane` },
  ])
  // Sage's pulse tells what it heals and what it hurts.
  const pulse = lines('pulse')
  assert.deepEqual(pulse[0].label, 'Heal')
  assert.equal(pulse[0].value, String(Math.round(PULSE_HEAL + (PULSE_HEAL_SCALING.arcane ?? 0) * stats.arcane)))
  assert.deepEqual(pulse[1].label, 'Damage')
})
