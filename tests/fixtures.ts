import {
  abilityDefs,
  aimPoint,
  alliesInBox,
  alliesInRadius,
  alongAim,
  attackDamage,
  attackRangeBonus,
  attackSpeedBonus,
  Champion,
  champions,
  damage,
  dash,
  enemiesInBox,
  enemiesInLine,
  enemiesInRadius,
  haste,
  heal,
  interrupt,
  knockback,
  linear,
  loseHealth,
  mark,
  missingHealth,
  popMarkers,
  reduceCooldown,
  refundCooldown,
  resetAutoTimer,
  resist,
  root,
  self,
  shield,
  slow,
  spawnEntity,
  stacks,
  stun,
  subject,
  subjectWithin,
  targetUnit,
  when,
  type AbilityDef,
  type ChampionDef,
  type EntityDef,
  type SimContext,
} from '../packages/shared/src/index.js'

// The tests own their content. Everything here is a copy of how a kit behaved when it was
// written, under its own "t-" ids, with every number spelled out. Retuning the real game never
// changes what these do, and the tests state exactly what they expect of them.

const seconds = (value: number): number => Math.round(value * 60)

// The registries are readonly to the game, but a test has to be able to add its own content.
// Snapshots restore characters and casts look abilities up by id, so both must be registered.
export function defineAbility(def: AbilityDef): AbilityDef {
  ;(abilityDefs as unknown as Map<string, AbilityDef>).set(def.id, def)
  return def
}

export function defineChampion(def: ChampionDef): Champion {
  const champion = new Champion(def)
  ;(champions as unknown as Map<string, Champion>).set(champion.id, champion)
  return champion
}

// ---------------------------------------------------------------------------- a plain fighter

// Every targeting mode and a shield, which no real champion has: none, unit, direction, point.
defineAbility({
  id: 't-shockwave',
  targeting: 'none',
  range: 0,
  windUpTicks: 6,
  backswingTicks: 6,
  cooldownTicks: seconds(8),
  apply: [
    damage(200, enemiesInRadius(120)),
    slow(0.3, seconds(1), enemiesInRadius(120)),
    shield(200, seconds(1.5), self()),
    resetAutoTimer(),
  ],
})
defineAbility({
  id: 't-lash',
  targeting: 'unit',
  range: 200,
  windUpTicks: 9,
  backswingTicks: 6,
  cooldownTicks: seconds(5),
  apply: [damage(300, targetUnit()), slow(0.5, seconds(0.75), targetUnit())],
})
defineAbility({
  id: 't-bolt',
  targeting: 'direction',
  range: 450,
  indicator: { width: 16 },
  windUpTicks: 9,
  backswingTicks: 3,
  cooldownTicks: seconds(4),
  apply: [
    spawnEntity({ id: 't-bolt', speed: 600, radius: 8, lifetimeTicks: seconds(0.75), onHit: [damage(300)] }),
  ],
})
defineAbility({
  id: 't-meteor',
  targeting: 'point',
  range: 300,
  indicator: { radius: 90 },
  windUpTicks: 30,
  backswingTicks: 6,
  cooldownTicks: seconds(12),
  apply: [damage(400, enemiesInRadius(90, aimPoint()))],
})

export const brawler = defineChampion({
  id: 't-brawler',
  name: 'Test Brawler',
  maxHp: 1000,
  moveSpeed: 220,
  radius: 18,
  attackDamage: 100,
  attackSpeed: 1,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: ['t-shockwave', 't-lash', 't-bolt', 't-meteor'],
})

// ---------------------------------------------------------------------------- curse kit
// Stacks on enemies (max 5, 10 s, refreshed together) that are read, popped and refunded.

const curseStacksOnTarget = stacks('curse', targetUnit())
const curseStacksOnHit = stacks('curse', subject())

defineAbility({
  id: 't-feast',
  targeting: 'unit',
  range: 320,
  windUpTicks: 6,
  backswingTicks: 6,
  cooldownTicks: seconds(10),
  apply: [
    damage(linear(150, 100, curseStacksOnTarget), targetUnit()),
    haste(linear(0, 0.15, curseStacksOnTarget), seconds(2.5), self()),
    refundCooldown('t-feast', linear(0, 1 / 5, curseStacksOnTarget), self()),
    popMarkers('curse', targetUnit()),
  ],
})
defineAbility({
  id: 't-miasma',
  targeting: 'none',
  range: 0,
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(14),
  apply: [
    spawnEntity({
      id: 't-miasma',
      speed: 0,
      radius: 150,
      lifetimeTicks: seconds(4),
      visual: 'field',
      onTick: [haste(0.25, 2, alliesInRadius(150)), slow(0.25, 2, enemiesInRadius(150))],
    }),
  ],
})
defineAbility({
  id: 't-hex',
  targeting: 'direction',
  range: 520,
  windUpTicks: 8,
  backswingTicks: 4,
  cooldownTicks: seconds(8),
  apply: [
    spawnEntity({
      id: 't-hex',
      speed: 700,
      radius: 10,
      lifetimeTicks: seconds(0.75),
      onHit: [
        slow(0.3, seconds(1)),
        when<SimContext>(
          (sim, src) => curseStacksOnHit(sim, src) >= 5,
          [damage(500), haste(0.75, seconds(2.5), self()), popMarkers('curse')],
          [mark('curse', seconds(10), subject(), { count: 2, cap: 5 })],
        ),
      ],
    }),
  ],
})

export const cursebearer = defineChampion({
  id: 't-cursebearer',
  name: 'Test Cursebearer',
  maxHp: 800,
  moveSpeed: 140,
  radius: 16,
  attackDamage: 80,
  attackSpeed: 1.2,
  attackRange: 190,
  attackWindupTicks: 4,
  abilities: ['t-feast', 't-miasma', 't-hex'],
  onAttackHit: [damage(attackDamage()), mark('curse', seconds(10), subject(), { cap: 5 })],
})

// ---------------------------------------------------------------------------- archer kit
// A dash, attack speed and range bonuses, and a lob that spawns a second entity where it lands.

defineAbility({
  id: 't-leap',
  targeting: 'point',
  range: 280,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(8),
  movement: true,
  apply: [dash(600, 120)],
})
defineAbility({
  id: 't-focus',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(12),
  apply: [attackSpeedBonus(0.4, seconds(4)), attackRangeBonus(120, seconds(4))],
})

const snareField: EntityDef = {
  id: 't-snare-field',
  speed: 0,
  radius: 120,
  lifetimeTicks: seconds(4),
  visual: 'field',
  onTick: [slow(0.4, 2, enemiesInRadius(120))],
}
defineAbility({
  id: 't-snare',
  targeting: 'point',
  range: 450,
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(14),
  apply: [
    spawnEntity({
      id: 't-snare-shot',
      speed: 600,
      radius: 6,
      landAtAim: true,
      onExpire: [spawnEntity(snareField)],
    }),
  ],
})

export const archer = defineChampion({
  id: 't-archer',
  name: 'Test Archer',
  maxHp: 700,
  moveSpeed: 150,
  radius: 15,
  attackDamage: 65,
  attackSpeed: 1,
  attackRange: 220,
  attackWindupTicks: 3,
  abilities: ['t-leap', 't-focus', 't-snare'],
  onAttackHit: [damage(attackDamage()), reduceCooldown('t-leap', 60)],
})

// ---------------------------------------------------------------------------- swordsman kit
// Stacks on the owner (max 3, 8 s) that add damage; a line hit with a trail; root and stun.

const swordStacks = stacks('sword', self())

const slashTrail: EntityDef = {
  id: 't-slash-trail',
  speed: 0,
  radius: 40,
  lifetimeTicks: seconds(3),
  visual: 'field',
  onTick: [
    slow(0.3, 2, enemiesInRadius(40)),
    haste(0.25, 2, alliesInRadius(40), { shared: 't-slash-trail' }),
  ],
}
const lightBurst: EntityDef = {
  id: 't-light-burst',
  speed: 0,
  radius: 170,
  lifetimeTicks: 12,
  visual: 'field',
}

defineAbility({
  id: 't-slash',
  targeting: 'direction',
  range: 300,
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(7),
  apply: [
    damage(linear(120, 25, swordStacks), enemiesInLine(300, 30)),
    spawnEntity(slashTrail, { line: { length: 300, count: 6 } }),
  ],
})
defineAbility({
  id: 't-radiance',
  targeting: 'none',
  range: 0,
  windUpTicks: 3,
  backswingTicks: 4,
  cooldownTicks: seconds(12),
  apply: [
    damage(linear(150, 100, swordStacks), enemiesInRadius(170)),
    haste(linear(0, 0.12, swordStacks), seconds(2.5), self()),
    popMarkers('sword', self()),
    spawnEntity(lightBurst),
  ],
})
defineAbility({
  id: 't-shackle',
  targeting: 'unit',
  range: 170,
  windUpTicks: 3,
  backswingTicks: 3,
  cooldownTicks: seconds(10),
  apply: [
    when<SimContext>(
      (sim, src) => swordStacks(sim, src) >= 3,
      [stun(seconds(1), targetUnit())],
      [root(seconds(1.5), targetUnit())],
    ),
    popMarkers('sword', self()),
    resetAutoTimer(),
  ],
})

export const swordsman = defineChampion({
  id: 't-swordsman',
  name: 'Test Swordsman',
  maxHp: 1000,
  moveSpeed: 145,
  radius: 18,
  attackDamage: 90,
  attackSpeed: 1.1,
  attackRange: 90,
  attackWindupTicks: 3,
  abilities: ['t-slash', 't-radiance', 't-shackle'],
  onAttackHit: [
    damage(linear(attackDamage(), 25, stacks('sword', self()))),
    mark('sword', seconds(8), self(), { cap: 3 }),
  ],
})

// ---------------------------------------------------------------------------- capricorn kit
// An on-cast passive; a piercing rectangular wave that shoves and interrupts; a volley whose
// later hits do less; a field whose pulses ramp up the longer a target stays.

defineAbility({
  id: 't-tsunami',
  targeting: 'direction',
  range: 380,
  windUpTicks: 5,
  backswingTicks: 4,
  cooldownTicks: seconds(9),
  apply: [
    spawnEntity({
      id: 't-tsunami-wave',
      speed: 480,
      // 150 wide across its path and 40 deep along it.
      box: { halfLength: 20, halfWidth: 75 },
      lifetimeTicks: seconds(0.8),
      pierce: true,
      // The push is at most 140, and no farther than 50 past where the wave stops.
      onHit: [damage(130), knockback(140, 700, subject(), { pastEnd: 50 }), interrupt()],
    }),
  ],
})

const bubble: EntityDef = {
  id: 't-bubble',
  speed: 650,
  radius: 14,
  lifetimeTicks: seconds(0.7),
  onHit: [
    when<SimContext>(
      (sim, src) => stacks('bubbled', subject())(sim, src) > 0,
      [damage(70)],
      [damage(140), mark('bubbled', seconds(1.5), subject(), { cap: 1 })],
    ),
  ],
}
defineAbility({
  id: 't-bubbles',
  targeting: 'direction',
  range: 450,
  windUpTicks: 4,
  backswingTicks: 3,
  cooldownTicks: seconds(8),
  apply: [spawnEntity(bubble, { volley: { count: 5, intervalTicks: 5 } })],
})

const galeField: EntityDef = {
  id: 't-gale-field',
  speed: 0,
  radius: 130,
  lifetimeTicks: seconds(4),
  visual: 'field',
  pulseEveryTicks: 20,
  onPulse: [
    damage(linear(15, 15, stacks('gale', subject())), enemiesInRadius(130)),
    mark('gale', 60, enemiesInRadius(130), { cap: 5 }),
  ],
}
defineAbility({
  id: 't-gale',
  targeting: 'point',
  range: 400,
  windUpTicks: 5,
  backswingTicks: 4,
  cooldownTicks: seconds(12),
  apply: [spawnEntity(galeField, { at: aimPoint() })],
})

export const capricorn = defineChampion({
  id: 't-capricorn',
  name: 'Test Capricorn',
  maxHp: 850,
  moveSpeed: 145,
  radius: 17,
  attackDamage: 70,
  attackSpeed: 1,
  attackRange: 200,
  attackWindupTicks: 4,
  abilities: ['t-tsunami', 't-bubbles', 't-gale'],
  onCast: [mark('empowered', seconds(6), self(), { cap: 1 })],
  onAttackHit: [
    damage(linear(attackDamage(), 70, stacks('empowered', self()))),
    popMarkers('empowered', self()),
  ],
})

// ---------------------------------------------------------------------------- rectangular trail
// A cut along the aim that leaves one rectangle of fire where it landed (300 long, 60 wide).

const cutTrail: EntityDef = {
  id: 't-cut-trail',
  speed: 0,
  box: { halfLength: 150, halfWidth: 30 },
  lifetimeTicks: seconds(3),
  visual: 'field',
  onTick: [slow(0.5, 2, enemiesInBox(150, 30)), haste(0.4, 2, alliesInBox(150, 30))],
}
defineAbility({
  id: 't-cut',
  targeting: 'direction',
  range: 300,
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(7),
  apply: [
    damage(120, enemiesInLine(300, 30)),
    spawnEntity(cutTrail, { at: alongAim(150) }),
  ],
})

export const cutter = defineChampion({
  id: 't-cutter',
  name: 'Test Cutter',
  maxHp: 1000,
  moveSpeed: 145,
  radius: 18,
  attackDamage: 90,
  attackSpeed: 1.1,
  attackRange: 90,
  attackWindupTicks: 3,
  abilities: ['t-cut'],
})

// ---------------------------------------------------------------------------- spout
// A circle marked at the aimed point (65 radius) that erupts after a 0.7 s warning, hurting for
// 220 and slowing 40% for 1.5 s whoever is still inside. A short flash marks the eruption.

const spoutBurst: EntityDef = {
  id: 't-spout-burst',
  speed: 0,
  radius: 65,
  lifetimeTicks: 8,
  visual: 'field',
}
const spoutWarning: EntityDef = {
  id: 't-spout-warning',
  speed: 0,
  radius: 65,
  lifetimeTicks: seconds(0.7),
  visual: 'telegraph',
  onExpire: [
    damage(220, enemiesInRadius(65)),
    slow(0.4, seconds(1.5), enemiesInRadius(65)),
    spawnEntity(spoutBurst),
  ],
}
defineAbility({
  id: 't-spout',
  targeting: 'point',
  range: 450,
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(9),
  apply: [spawnEntity(spoutWarning, { at: aimPoint() })],
})

export const spouter = defineChampion({
  id: 't-spouter',
  name: 'Test Spouter',
  maxHp: 1000,
  moveSpeed: 145,
  radius: 18,
  attackDamage: 70,
  attackSpeed: 1,
  attackRange: 200,
  attackWindupTicks: 4,
  abilities: ['t-spout'],
})

// ---------------------------------------------------------------------------- soldier kit
// A melee strike up close, a health-for-power trade, a piercing bolt that scales with the
// target's missing health, and a bot whose shield and regeneration last as long as it stands.

defineAbility({
  id: 't-stim',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(18),
  apply: [
    loseHealth(150),
    attackSpeedBonus(0.5, seconds(5)),
    haste(0.3, seconds(5)),
    resist(0.3, seconds(5)),
  ],
})
defineAbility({
  id: 't-rail',
  targeting: 'direction',
  range: 650,
  windUpTicks: 5,
  backswingTicks: 3,
  cooldownTicks: seconds(7),
  apply: [
    spawnEntity({
      id: 't-rail-bolt',
      speed: 720,
      radius: 12,
      lifetimeTicks: seconds(0.9),
      pierce: true,
      onHit: [damage(linear(80, 0.2, missingHealth())), slow(0.3, seconds(1.5))],
    }),
  ],
})

const medicBot: EntityDef = {
  id: 't-medic-bot',
  speed: 0,
  follow: { stiffness: 24, damping: 3.5, offset: { x: 0, y: -36 } },
  radius: 9,
  stayWhile: (sim, src) => sim.statusesOn(src.ownerId).some(
    (status) => status.id === `${src.ownerId}:shield:t-medic` && status.amount > 0,
  ),
  pulseEveryTicks: 30,
  onPulse: [heal(12, self())],
}
defineAbility({
  id: 't-medic',
  targeting: 'none',
  range: 0,
  windUpTicks: 3,
  backswingTicks: 3,
  cooldownTicks: seconds(24),
  apply: [
    shield(250, Infinity, self(), { shared: 't-medic' }),
    spawnEntity(medicBot, { onePerOwner: true }),
  ],
})

export const soldier = defineChampion({
  id: 't-soldier',
  name: 'Test Soldier',
  maxHp: 900,
  moveSpeed: 140,
  radius: 17,
  attackDamage: 60,
  attackSpeed: 1.3,
  attackRange: 260,
  attackWindupTicks: 3,
  abilities: ['t-stim', 't-rail', 't-medic'],
  onAttackHit: [
    when<SimContext>(
      subjectWithin(120),
      [damage(linear(attackDamage(), 0.6, attackDamage()))],
      [damage(attackDamage())],
    ),
  ],
})

// Odds and ends for pinning one behaviour at a time.
defineAbility({
  id: 't-guard',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(10),
  apply: [resist(0.8, seconds(5))],
})
defineAbility({
  id: 't-first-aid',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(10),
  apply: [heal(100)],
})
// Hits hard enough to break a medic's shield in a single attack.
export const bigHitter = defineChampion({
  id: 't-big-hitter',
  name: 'Test Big Hitter',
  maxHp: 1000,
  moveSpeed: 220,
  radius: 18,
  attackDamage: 400,
  attackSpeed: 1,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: [],
})
