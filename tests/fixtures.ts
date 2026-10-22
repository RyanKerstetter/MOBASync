import {
  abilityDefs,
  aimPoint,
  alliesInBox,
  alliesInRadius,
  alongAim,
  attackDamage,
  attackRangeBonus,
  attackSpeedBonus,
  blind,
  blink,
  burn,
  capCooldown,
  Champion,
  champions,
  damage,
  dash,
  dodge,
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
  ownEntity,
  popMarkers,
  reduceCooldown,
  refundCooldown,
  removeEntities,
  resetAutoTimer,
  resist,
  root,
  self,
  selfInRadius,
  shield,
  silence,
  slow,
  spawnEntity,
  stacks,
  startCooldown,
  stun,
  subject,
  subjectWithin,
  targetUnit,
  when,
  type AbilityDef,
  type ChampionDef,
  type CharacterOrder,
  type DashDef,
  type EntityDef,
  type Selector,
  type SimContext,
  type Vector2,
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

// An attack order keeps a character attacking until it is told to do something else, so a test
// that wants a set number of autos has to end it. This tells the character to walk to where it is
// already standing, which ends the attack and nothing else. A move order cancels a windup that is
// under way, but windups launch before the orders of their tick, so giving it on the tick the last
// auto launches (the tick it starts plus the champion's windup) lets that auto land and stops the
// next. An attack with no windup launches as it starts, after that tick's orders, so its stop has
// to come one tick later.
export function stopAttacking(
  simulator: { addOrder(characterId: number, order: CharacterOrder): boolean },
  characterId: number,
  tick: number,
  standingAt: Vector2,
): void {
  simulator.addOrder(characterId, {
    id: `stop:${characterId}:${tick}`,
    seq: 100_000 + tick,
    tick,
    type: 'move',
    target: { ...standingAt },
  })
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
  indicator: { line: true },
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

// A trap left for 1 s that roots each enemy once, for 1.5 s, as its body touches it.
const snareField: EntityDef = {
  id: 't-snare-field',
  speed: 0,
  radius: 70,
  lifetimeTicks: seconds(1),
  pierce: true,
  visual: 'field',
  onHit: [root(seconds(1.5))],
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
// Applied through an auto: with no windup, it resets the auto timer and readies the next auto,
// which (within 5 s) stuns the target for 1 s if it was hit with three sword stacks, or roots it
// for 1.5 s otherwise, and spends the stacks.
defineAbility({
  id: 't-shackle',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(10),
  empowerAttack: {
    ticks: seconds(5),
    effects: [
      when<SimContext>(
        (sim, src) => swordStacks(sim, src) >= 3,
        [stun(seconds(1))],
        [root(seconds(1.5))],
      ),
      popMarkers('sword', self()),
    ],
  },
  apply: [resetAutoTimer()],
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

// ---------------------------------------------------------------------------- grenadier kit
// A grenade lobbed to a point that explodes there, throwing everything within 100 straight away
// from the middle (enemies are hurt for 100, the thrower is thrown too if it is inside) and
// handing back half its cooldown if it caught an enemy; a lob that leaves a fire that slows and
// burns; a flashbang lobbed to a point whose flash stuns whoever is within 50 of the middle and
// blinds whoever is within 120 but not 50; and a passive that pays out move speed that fades on
// the third auto at the same enemy. Its autos are instant, to keep the timing plain. Every lob
// flies 10 px a tick.

const grenadeBurst: EntityDef = {
  id: 't-grenade-burst',
  speed: 0,
  radius: 100,
  lifetimeTicks: 8,
  visual: 'field',
}
defineAbility({
  id: 't-grenade',
  targeting: 'point',
  range: 400,
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(10),
  apply: [
    spawnEntity({
      id: 't-grenade-shot',
      speed: 600,
      radius: 8,
      landAtAim: true,
      onExpire: [
        damage(100, enemiesInRadius(100)),
        knockback(150, 600, enemiesInRadius(100)),
        knockback(100, 600, selfInRadius(100)),
        when<SimContext>(
          (sim, src) => enemiesInRadius(100)(sim, src).length > 0,
          [refundCooldown('t-grenade', 0.5)],
        ),
        spawnEntity(grenadeBurst),
      ],
    }),
  ],
})

// 100 across, 4 s, slowing 30% and burning 40 a second for 3 s after the last tick inside it.
const molotovFire: EntityDef = {
  id: 't-molotov-fire',
  speed: 0,
  radius: 100,
  lifetimeTicks: seconds(4),
  visual: 'field',
  onTick: [
    slow(0.3, 2, enemiesInRadius(100)),
    burn(40, seconds(3), enemiesInRadius(100)),
  ],
}
defineAbility({
  id: 't-molotov',
  targeting: 'point',
  range: 400,
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(12),
  apply: [
    spawnEntity({
      id: 't-molotov-shot',
      speed: 600,
      radius: 6,
      landAtAim: true,
      onExpire: [spawnEntity(molotovFire)],
    }),
  ],
})

const flashBurst: EntityDef = {
  id: 't-flash-burst',
  speed: 0,
  radius: 120,
  lifetimeTicks: 8,
  visual: 'field',
}
// The core of the flash stuns for a second; the ring around it blinds for 1.5 s instead.
const enemiesInFlashRing: Selector = (sim, src) => {
  const core = new Set(enemiesInRadius(50)(sim, src))
  return enemiesInRadius(120)(sim, src).filter((unitId) => !core.has(unitId))
}
defineAbility({
  id: 't-flashbang',
  targeting: 'point',
  range: 400,
  // Drawn as two circles: the whole flash and the core inside it.
  indicator: { radius: 120, innerRadius: 50 },
  windUpTicks: 4,
  backswingTicks: 3,
  cooldownTicks: seconds(14),
  apply: [
    spawnEntity({
      id: 't-flashbang-shot',
      speed: 600,
      radius: 6,
      landAtAim: true,
      onExpire: [
        stun(60, enemiesInRadius(50)),
        blind(90, enemiesInFlashRing),
        spawnEntity(flashBurst),
      ],
    }),
  ],
})

// Sets a unit alight for two seconds at 60 a second (30 on each pulse), with no windup.
defineAbility({
  id: 't-ignite',
  targeting: 'unit',
  range: 300,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(10),
  apply: [burn(60, 120, targetUnit())],
})

export const grenadier = defineChampion({
  id: 't-grenadier',
  name: 'Test Grenadier',
  maxHp: 800,
  moveSpeed: 150,
  radius: 16,
  attackDamage: 60,
  attackSpeed: 1,
  attackRange: 250,
  attackWindupTicks: 3,
  abilities: ['t-grenade', 't-molotov', 't-flashbang', 't-ignite'],
  // Markers on the target count its autos for 5 s; the third pops them for +50% move speed that
  // fades to nothing over 2 s.
  onAttackHit: [
    damage(attackDamage()),
    when<SimContext>(
      (sim, src) => stacks('sighted', subject())(sim, src) >= 2,
      [popMarkers('sighted'), haste(0.5, 120, self(), { fades: true })],
      [mark('sighted', 300, subject(), { cap: 2 })],
    ),
  ],
})

// ---------------------------------------------------------------------------- trinketmaster kit
// A stick thrown in a straight line, 300 px, that hurts every enemy it passes through (60 damage)
// and then lands where its flight ends and stays, with no timer, until its owner walks over it,
// which caps what is left of the throw's cooldown at 1 s, or calls it back, which does not touch
// the cooldown at all. The key does the throw while no stick is out and the recall while one is:
// the recall flies the stick home through enemies (60 damage, 40% slow for 1.5 s) and the stick
// ends on arrival with nothing refunded. A silence that also resets the auto attack, and a blink to
// the stick, whose walked-over pickup then happens by itself because the owner is standing on it.
// The throw and the recall fly 10 px a tick.

const stickEntity: EntityDef = {
  id: 't-stick',
  speed: 0,
  radius: 16,
  stayWhile: (sim, src) => sim.isAlive(src.ownerId),
  pickup: [capCooldown('t-stick', 60)],
}
// The passive, for every ability hit the trinketmaster lands, the stick either way or the auto that hush
// readies, but not a plain auto: the first two on the same enemy, each within 5 s of the last, mark it,
// and the third deals 50 more damage on top of its own, pops the marks, and gives the trinketmaster 30%
// move speed for 2 s.
const trinketTrick = [
  when<SimContext>(
    (sim, src) => stacks('trick', subject())(sim, src) >= 2,
    [damage(50), popMarkers('trick'), haste(0.3, seconds(2), self())],
    [mark('trick', seconds(5), subject(), { cap: 2 })],
  ),
]
const stickRecall: EntityDef = {
  id: 't-stick-recall',
  speed: 600,
  radius: 14,
  homing: 'owner',
  pierce: true,
  onHit: [damage(60), slow(0.4, 90), ...trinketTrick],
  // It ends on arriving home, and gives nothing back.
  pickup: [],
}
defineAbility({
  id: 't-stick',
  targeting: 'direction',
  range: 300,
  indicator: { width: 16 },
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(8),
  requires: { entity: 't-stick', out: false },
  recast: 't-recall',
  apply: [
    spawnEntity({
      id: 't-stick-shot',
      speed: 600,
      radius: 8,
      lifetimeTicks: 30,
      pierce: true,
      stopsAtWalls: true,
      onHit: [damage(60), ...trinketTrick],
      onExpire: [spawnEntity(stickEntity, { onePerOwner: true })],
    }),
  ],
})
defineAbility({
  id: 't-recall',
  targeting: 'none',
  range: 0,
  windUpTicks: 2,
  backswingTicks: 2,
  cooldownTicks: 30,
  requires: { entity: 't-stick', out: true },
  apply: [spawnEntity(stickRecall, { at: ownEntity('t-stick') }), removeEntities('t-stick')],
})
// Applied through an auto: with no windup, it resets the auto timer and readies the next auto,
// which (within 5 s) silences its target for 1.5 s, and counts for the passive.
defineAbility({
  id: 't-hush',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(8),
  empowerAttack: { ticks: seconds(5), effects: [silence(90), ...trinketTrick] },
  apply: [resetAutoTimer()],
})
defineAbility({
  id: 't-warp',
  targeting: 'none',
  range: 0,
  windUpTicks: 3,
  backswingTicks: 2,
  cooldownTicks: seconds(10),
  requires: { entity: 't-stick', out: true },
  apply: [blink(ownEntity('t-stick'))],
})

export const trinketmaster = defineChampion({
  id: 't-trinketmaster',
  name: 'Test Trinketmaster',
  maxHp: 900,
  moveSpeed: 150,
  radius: 17,
  attackDamage: 60,
  attackSpeed: 1,
  attackRange: 90,
  attackWindupTicks: 3,
  abilities: ['t-stick', 't-hush', 't-warp'],
})

// ---------------------------------------------------------------------------- ninja kit
// Q dashes 300 px at 1200 px/s (20 px a tick), through anyone in the way. Each enemy the dash passes
// through takes 60 damage and a 40% slow for 1.5 s as the ninja's body reaches it. The first one it
// passes also gives the ninja a shadow stack (at most two, six seconds, refreshed together) and 75% of
// Q's cooldown back, starts the dash back's 1 s cooldown, and leaves a shadow where the dash was cast
// from. While the shadow is out, the key dashes back to it instead, from any distance, and does the
// same for the enemies it passes; if it finishes having passed none, the shadow is lost and Q starts
// its whole 8 s over, whatever had run down while the shadow was out. A shadow has no timer. Each
// shadow stack is an enhanced auto: an auto spends one for 60 bonus damage. W is a piercing kunai
// (60 damage and a 40% slow for 1.5 s), or, if the ninja has a shadow stack, which it spends one of,
// 110 damage and a 1 s root instead. E is a 40% haste for 1.5 s and a dodge of every auto for 1.2 s.

const shadowEntity: EntityDef = {
  id: 't-shadow',
  speed: 0,
  radius: 14,
  visual: 'field',
  color: '#7a5cff',
  stayWhile: (sim, src) => sim.isAlive(src.ownerId),
}
const ninjaDashHit = [damage(60), slow(0.4, seconds(1.5))]
const ninjaDashConnect = [
  mark('shadow', seconds(6), self(), { cap: 2 }),
  refundCooldown('t-shadowstep', 0.75),
  startCooldown('t-shadowreturn'),
  spawnEntity(shadowEntity, { onePerOwner: true }),
]
const ninjaStepDash: DashDef = { id: 't-shadowstep-dash', onHit: ninjaDashHit, onConnect: ninjaDashConnect }
const ninjaReturnDash: DashDef = {
  id: 't-shadowreturn-dash',
  onHit: ninjaDashHit,
  onConnect: ninjaDashConnect,
  onMiss: [removeEntities('t-shadow'), startCooldown('t-shadowstep')],
}
defineAbility({
  id: 't-shadowstep',
  targeting: 'point',
  range: 300,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(8),
  movement: true,
  indicator: { line: true },
  requires: { entity: 't-shadow', out: false },
  recast: 't-shadowreturn',
  apply: [dash(1200, 300, self(), { through: true, on: ninjaStepDash })],
})
defineAbility({
  id: 't-shadowreturn',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(1),
  movement: true,
  requires: { entity: 't-shadow', out: true },
  apply: [dash(1200, Infinity, self(), { toward: ownEntity('t-shadow'), through: true, on: ninjaReturnDash })],
})
defineAbility({
  id: 't-kunai',
  targeting: 'direction',
  range: 462,
  indicator: { width: 20 },
  windUpTicks: 4,
  backswingTicks: 3,
  cooldownTicks: seconds(7),
  apply: [
    when<SimContext>(
      (sim, src) => stacks('shadow', self())(sim, src) > 0,
      [
        popMarkers('shadow', self(), { count: 1 }),
        spawnEntity({
          id: 't-kunai-enhanced', speed: 840, radius: 10, lifetimeTicks: 33, pierce: true,
          onHit: [damage(110), root(seconds(1))],
        }),
      ],
      [
        spawnEntity({
          id: 't-kunai-shot', speed: 840, radius: 10, lifetimeTicks: 33, pierce: true,
          onHit: [damage(60), slow(0.4, seconds(1.5))],
        }),
      ],
    ),
  ],
})
defineAbility({
  id: 't-dodge',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(12),
  apply: [haste(0.4, seconds(1.5)), dodge(seconds(1.2))],
})

export const ninja = defineChampion({
  id: 't-ninja',
  name: 'Test Ninja',
  maxHp: 800,
  moveSpeed: 160,
  radius: 16,
  attackDamage: 50,
  attackSpeed: 1,
  attackRange: 90,
  attackWindupTicks: 4,
  abilities: ['t-shadowstep', 't-kunai', 't-dodge'],
  // The auto spends one shadow stack, if there is one, for 60 bonus damage.
  onAttackHit: [
    damage(linear(attackDamage(), 60, (sim, src) => Math.min(1, stacks('shadow', self())(sim, src)))),
    popMarkers('shadow', self(), { count: 1 }),
  ],
})

// ---------------------------------------------------------------------------- projectile autos
// A ranged auto that fires a shot instead of landing at once: it chases its target at 600 px/s
// (10 px per tick), is 8 px across, and deals the hit when it arrives. A copy without
// `attackProjectile` hits the same target the moment its windup finishes.

export const gunner = defineChampion({
  id: 't-gunner',
  name: 'Test Gunner',
  maxHp: 1000,
  moveSpeed: 200,
  radius: 18,
  attackDamage: 100,
  attackSpeed: 1,
  attackRange: 300,
  attackWindupTicks: 3,
  attackProjectile: { speed: 600, radius: 8, color: '#ffffff' },
  abilities: [],
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
