import { GAME_TPS } from './constants.js'
import {
  aimPoint,
  alliesInBox,
  alliesInRadius,
  alongAim,
  attackRangeBonus,
  besideOwner,
  blind,
  blink,
  burn,
  capCooldown,
  damage,
  dash,
  disarm,
  dodge,
  enemiesInBox,
  enemiesInLine,
  enemiesInRadius,
  haste,
  heal,
  knockback,
  linear,
  loseHealth,
  mark,
  missingHealth,
  ownEntity,
  popMarkers,
  refundCooldown,
  removeEntities,
  resetAutoTimer,
  runEffects,
  statBuff,
  root,
  scaled,
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
  targetUnit,
  when,
  type DashDef,
  type Effect,
  type EffectSource,
  type EntityDef,
  type Scaling,
  type Selector,
  type SimContext,
  type SimReader,
} from './effects.js'
import type { CastTarget, Vector2 } from './index.js'

// How an ability is drawn while it is aimed.
export interface AbilityIndicator {
  // The radius of the circle at a ground target.
  radius?: number
  // A second, smaller circle inside it, for an ability whose middle does something different from
  // its edge, such as a flash that stuns at the core and only blinds further out.
  innerRadius?: number
  // The width of the band along a skillshot.
  width?: number
  // A line from the caster to the aimed point, for a dash.
  line?: boolean
}

export interface AbilityDef {
  id: string
  // What the player sees it called, where its id (see `abilityName`) would not read well, such as "Shadow Step".
  name?: string
  // The picture for it, as the name of a file in res/icons without its `.png`, where that is not the ability's own ID (which is the name it is looked for under
  // when there is none): see `abilityIconName`.
  icon?: string
  // Shown on the champion select screen and in the tooltip over the ability. One or two plain sentences on what it does: its damage, its ratios and its
  // cooldown are told by the tooltip itself, from the ability, so they are left out of this.
  description?: string
  targeting: CastTarget['mode']
  range: number
  // A point-targeted ability cannot be aimed nearer the caster than this. The client pushes the aim out
  // to it, and a cast aimed nearer is dropped like one aimed out of range.
  minRange?: number
  windUpTicks: number
  backswingTicks: number
  cooldownTicks: number
  // The ability needs the caster to be able to move, so a root or stun stops it from starting.
  movement?: boolean
  // How big its indicator is drawn while it is aimed. Without it the indicator only marks the aim.
  indicator?: AbilityIndicator
  // The ability can only be cast while the caster has (`out: true`) or has not (`out: false`) an
  // entity of this definition out in the world, such as a stick on the ground. Cast at any other
  // time it is dropped like an invalid order: nothing happens and no cooldown starts.
  requires?: { entity: string; out: boolean }
  // Another way to be castable when `requires` is not met: when none of these entities are out (an
  // entity of each definition, such as a stick on the ground and in the air) and the ability of this
  // id is on cooldown. For an ability that does something else when there is nothing for it to act on.
  orWhen?: { none: readonly string[]; onCooldown: string }
  // The ability that takes this one's place on its key while that one can be cast, so one key does
  // two things: throw a stick, then call it back. It is an ability in full, with its own cooldown,
  // and it belongs to any champion that has this one.
  recast?: string
  // Applied through an auto attack. Casting this readies the caster's next auto instead of striking
  // anything itself: for `ticks` after the cast, the next auto that lands also runs `effects` on its
  // target (as their subject) and spends the readiness. Casting again refreshes it. The cast's own
  // `apply` still runs at once, for anything that should not wait for the auto, such as resetting
  // the auto timer. With no windup it can be used between autos without interrupting them.
  empowerAttack?: { ticks: number; effects: readonly Effect[] }
  apply: readonly Effect[]
}

// Every ability in the game, by id. An ability is added to it where it is written, with `ability(...)`, so what it needs (its constants, its entities, its
// passive's markers) is declared just above it, and the abilities of a champion follow one another.
const abilityMap = new Map<string, AbilityDef>()
export const abilityDefs: ReadonlyMap<string, AbilityDef> = abilityMap

function ability(def: AbilityDef): AbilityDef {
  if (abilityMap.has(def.id)) throw new Error(`There are two abilities called "${def.id}".`)
  abilityMap.set(def.id, def)
  return def
}

// What the ability is called to a player: its `name`, or else its id made into words ("monster-slam" is "Monster Slam").
export const abilityName = (def: Pick<AbilityDef, 'id' | 'name'>): string =>
  def.name ?? def.id.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')

// The name of the file in res/icons (without `.png`) that an ability's picture is in: the `icon` it says, or else its own ID. An ID with no ability is its own name.
export const abilityIconName = (abilityId: string): string => abilityMap.get(abilityId)?.icon ?? abilityId

// The marker on a champion that says this ability's effects are ready for its next auto.
export const readyKey = (abilityId: string): string => `ready:${abilityId}`

const seconds = (value: number): number => Math.round(value * GAME_TPS)

// Whether `to` is within an ability's range of `from` (centre to centre), with a hair of slack for
// rounding. The simulator checks casts with this, and the client uses the same test to refuse a
// cast that would be dropped and to show whether an aim is in reach.
const RANGE_EPSILON = 1e-6
export const withinCastRange = (from: Vector2, to: Vector2, range: number): boolean => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return Math.sqrt(dx * dx + dy * dy) <= range + RANGE_EPSILON
}
// Whether `to` is at least `minRange` from `from`, with the same slack.
export const beyondMinCastRange = (from: Vector2, to: Vector2, minRange = 0): boolean => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return Math.sqrt(dx * dx + dy * dy) >= minRange - RANGE_EPSILON
}

// Whether an ability's `requires` holds, given a way to ask whether the caster has an entity of a
// definition out. The simulator asks its frame and the client its own, so both judge alike.
export const meetsRequirement = (
  def: AbilityDef,
  entityOut: (defId: string) => boolean,
  onCooldown: (abilityId: string) => boolean = () => false,
): boolean =>
  def.requires === undefined
  || entityOut(def.requires.entity) === def.requires.out
  || (def.orWhen !== undefined
    && def.orWhen.none.every((defId) => !entityOut(defId))
    && onCooldown(def.orWhen.onCooldown))

// The ability on a key right now: the one's `recast` while that can be cast, otherwise the one itself.
export const abilityOnKey = (def: AbilityDef, entityOut: (defId: string) => boolean): AbilityDef => {
  const recast = def.recast === undefined ? undefined : abilityDefs.get(def.recast)
  return recast && meetsRequirement(recast, entityOut) ? recast : def
}

// What follows is the abilities, a champion at a time (then the monsters'). Each has what it needs written just above it: its constants, its entities and its
// stacks. The constants that are exported are shared with champions.ts, where each champion's passive uses the same keys and durations; they are not part
// of the package's public exports.

// ---------------------------------------------------------------------------- Cursebearer

// Cursebearer's curse: stacks placed on enemies, up to five. Applying a stack refreshes them all.
export const CURSE_KEY = 'curse'
export const CURSE_MAX_STACKS = 5
export const CURSE_DURATION_TICKS = seconds(10)
const curseStacksOnTarget = stacks(CURSE_KEY, targetUnit())
const curseStacksOnHit = stacks(CURSE_KEY, subject())
ability({
  id: 'feast',
  description: 'Pops the target\'s curse stacks. Each stack adds damage, haste and cooldown refund.',
  targeting: 'unit',
  range: 280,
  windUpTicks: 6,
  backswingTicks: 4,
  cooldownTicks: seconds(10),
  apply: [
    damage(scaled(linear(75, 25, curseStacksOnTarget), { arcane: 0.4, level: .1 }), targetUnit()),
    haste(linear(0, .15, curseStacksOnTarget), seconds(2.5), self()),
    refundCooldown('feast', linear(0, .8 / CURSE_MAX_STACKS, curseStacksOnTarget), self()),
    popMarkers(CURSE_KEY, targetUnit()),
  ],
})
ability({
  id: 'miasma',
  description: 'Leaves a field that speeds up allies and slows enemies.',
  targeting: 'none',
  range: 0,
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(14),
  apply: [
    spawnEntity({
      id: 'miasma',
      speed: 0,
      radius: 150,
      lifetimeTicks: seconds(4),
      visual: 'field',
      // Two-tick statuses refreshed every tick wear off as soon as a unit leaves.
      onTick: [
        haste(0.3, 2, alliesInRadius(150)),
        slow(0.4, 2, enemiesInRadius(150)),
      ],
    }),
  ],
})

// Cursebearer's Hex: a line shot that slows and adds two stacks, or pops a full stack.
const hexShot = {
  id: 'hex',
  speed: 900,
  radius: 12,
  lifetimeTicks: seconds(0.75),
  onHit: [
    slow(0.3, seconds(1)),
    damage(scaled(50, { arcane: 0.8 })),
    when<SimContext>(
      (sim, src) => curseStacksOnHit(sim, src) >= CURSE_MAX_STACKS,
      [
        damage(scaled(200, { arcane: 0.6 })),
        haste(0.75, seconds(2.5), self()),
        popMarkers(CURSE_KEY),
      ],
      [mark(CURSE_KEY, CURSE_DURATION_TICKS, subject(), { count: 2, cap: CURSE_MAX_STACKS })],
    ),
    refundCooldown('hex',.4,self()),
  ],
} satisfies EntityDef

ability({
  id: 'hex',
  description: 'A shot that slows and adds curse stacks. At full stacks it pops them for bonus damage and haste.',
  targeting: 'direction',
  range: 520,
  windUpTicks: 8,
  backswingTicks: 4,
  cooldownTicks: seconds(5),
  indicator: { width: hexShot.radius * 2 },
  apply: [spawnEntity(hexShot)],
})

// ---------------------------------------------------------------------------- Archer

ability({
  id: 'leap',
  description: 'Dashes to the target point.',
  targeting: 'point',
  range: 150,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(8),
  movement: true,
  indicator: { line: true },
  apply: [dash(600, 120)],
})
ability({
  id: 'focus',
  description: 'Your auto attacks are faster and reach farther for a few seconds.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(12),
  apply: [
    statBuff('attackSpeed', 0.4, seconds(4)),
    attackRangeBonus(80, seconds(4)),
  ],
})
const SNARE_ROOT_TICKS = seconds(1.5)
const snareField = {
  id: 'snare-field',
  speed: 0,
  radius: 70,
  lifetimeTicks: seconds(3),
  pierce: true,
  visual: 'field',
  color: '#6dd39b',
  onHit: [root(SNARE_ROOT_TICKS)],
} satisfies EntityDef
ability({
  id: 'snare',
  description: 'Lobs a canister that leaves a trap. Enemies it catches are rooted.',
  targeting: 'point',
  range: 450,
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(14),
  // The trap it leaves.
  indicator: { radius: snareField.radius },
  apply: [
    spawnEntity({
      id: 'snare-shot',
      speed: 600,
      radius: 6,
      landAtAim: true,
      color: '#6dd39b',
      onExpire: [spawnEntity(snareField)],
    }),
  ],
})

// ---------------------------------------------------------------------------- Capricorn
// Capricorn's passive: casting any spell empowers the next auto attack.
export const EMPOWER_KEY = 'empowered'
export const EMPOWER_DURATION_TICKS = seconds(6)
export const EMPOWER_BONUS_DAMAGE = 30
const TSUNAMI_STUN_TICKS = seconds(0.6)
// What the wave does to each enemy it passes through: the base damage, plus the caster's stats times these ratios (`scaled`).
export const TSUNAMI_DAMAGE = 100
export const TSUNAMI_SCALING = { arcane: 0.8 } satisfies Scaling
const tsunamiWave = {
  id: 'tsunami-wave',
  speed: 400,
  box: { halfLength: 10, halfWidth: 45 },
  lifetimeTicks: seconds(0.8),
  pierce: true,
  color: '#4fa8ff',
  // The push is at most 140, and no farther than 50 past where the wave stops.
  onHit: [damage(scaled(TSUNAMI_DAMAGE, TSUNAMI_SCALING)), knockback(140, 700, subject(), { pastEnd: 50 }), stun(TSUNAMI_STUN_TICKS)],
} satisfies EntityDef
ability({
  id: 'tsunami',
  description: 'A wave that damages, knocks back and stuns enemies.',
  targeting: 'direction',
  range: 320,
  windUpTicks: 5,
  backswingTicks: 4,
  cooldownTicks: seconds(9),
  indicator: { width: tsunamiWave.box.halfWidth * 2 },
  apply: [spawnEntity(tsunamiWave)],
})
const BUBBLE_KEY = 'bubbled'
const BUBBLE_DAMAGE = 80
const BUBBLE_MARK_TICKS = seconds(1.5)
const bubbleStacksOnHit = stacks(BUBBLE_KEY, subject())
const bubble = {
  id: 'bubble',
  speed: 600,
  radius: 14,
  lifetimeTicks: seconds(0.7),
  color: '#a8e0ff',
  onHit: [
    when<SimContext>(
      (sim, src) => bubbleStacksOnHit(sim, src) > 0,
      [damage(scaled(BUBBLE_DAMAGE / 2, { arcane: 0.3 }))],
      [damage(scaled(BUBBLE_DAMAGE, { arcane: 0.6 })), mark(BUBBLE_KEY, BUBBLE_MARK_TICKS, subject(), { cap: 1 })],
    ),
  ],
} satisfies EntityDef
ability({
  id: 'bubbles',
  description: 'Fires three bubbles. The first to hit a target does full damage, the rest half.',
  targeting: 'direction',
  range: 420,
  windUpTicks: 4,
  backswingTicks: 3,
  cooldownTicks: seconds(8),
  indicator: { width: bubble.radius * 2 },
  apply: [
    spawnEntity(bubble, { volley: { count: 3, intervalTicks: 8 } }),
  ],
})
const SPOUT_RADIUS = 65
// What the eruption does to each enemy standing in it: the base damage, plus the caster's stats times these ratios (`scaled`).
export const SPOUT_DAMAGE = 120
export const SPOUT_SCALING = { arcane: 0.9 } satisfies Scaling
const spoutBurst: EntityDef = {
  id: 'spout-burst',
  speed: 0,
  radius: SPOUT_RADIUS,
  lifetimeTicks: 8,
  visual: 'field',
  color: '#4fa8ff',
}
const spoutWarning: EntityDef = {
  id: 'spout-warning',
  speed: 0,
  radius: SPOUT_RADIUS,
  lifetimeTicks: seconds(0.6),
  visual: 'telegraph',
  color: '#ff6b4a',
  // The eruption: it hits whoever is inside on the tick the warning runs out.
  onExpire: [
    damage(scaled(SPOUT_DAMAGE, SPOUT_SCALING), enemiesInRadius(SPOUT_RADIUS)),
    slow(0.4, seconds(.6), enemiesInRadius(SPOUT_RADIUS)),
    spawnEntity(spoutBurst),
  ],
}
ability({
  id: 'spout',
  description: 'Marks a circle that erupts after a short delay, damaging and slowing enemies in it.',
  targeting: 'point',
  range: 350,
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(9),
  indicator: { radius: SPOUT_RADIUS },
  apply: [spawnEntity(spoutWarning, { at: aimPoint() })],
})
// ---------------------------------------------------------------------------- Soldier
ability({
  id: 'stim',
  description: 'Costs health. For a few seconds you attack faster, move faster and take less damage.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(18),
  apply: [
    loseHealth(100),
    statBuff('attackSpeed', 0.5, seconds(5)),
    haste(0.4, seconds(5)),
    statBuff('resistance', 40, seconds(5)),
  ],
})
const soldierBolt = {
  id: 'bolt',
  speed: 720,
  radius: 12,
  lifetimeTicks: seconds(0.9),
  pierce: true,
  color: '#ffb347',
  onHit: [
    damage(scaled(linear(40, 0.06, missingHealth()), { attackDamage: 0.5 })),
    slow(0.5, seconds(1.5)),
  ],
} satisfies EntityDef
ability({
  id: 'bolt',
  description: 'A piercing bolt that slows. It hits harder the less health the enemy has.',
  targeting: 'direction',
  range: 300,
  windUpTicks: 5,
  backswingTicks: 3,
  cooldownTicks: seconds(7),
  indicator: { width: soldierBolt.radius * 2 },
  apply: [spawnEntity(soldierBolt)],
})
const medicBot: EntityDef = {
  id: 'medic-bot',
  speed: 0,
  follow: { stiffness: 24, damping: 3.5, offset: { x: 0, y: -36 } },
  radius: 9,
  color: '#7be0c3',
  stayWhile: (sim, src) => sim.statusesOn(src.ownerId).some(
    (status) => status.id === `${src.ownerId}:shield:medic` && status.amount > 0,
  ),
  pulseEveryTicks: 30,
  onPulse: [heal(scaled(8, {arcane: .1}), self())],
}
ability({
  id: 'medic',
  description: 'Summons a bot with a shield. It heals you until the shield breaks.',
  targeting: 'none',
  range: 0,
  windUpTicks: 3,
  backswingTicks: 3,
  cooldownTicks: seconds(24),
  apply: [
    shield(200, Infinity, self(), { shared: 'medic' }),
    spawnEntity(medicBot, { onePerOwner: true }),
  ],
})

// ---------------------------------------------------------------------------- Swordsman

// Swordsman's sword stacks sit on the Swordsman. Autos add them, they last until they expire,
// and each one adds damage to autos and Slash until Radiance or Shackle spends them.
export const SWORD_KEY = 'sword'
export const SWORD_MAX_STACKS = 3
export const SWORD_DURATION_TICKS = seconds(8)
export const SWORD_DAMAGE_PER_STACK = 10
const swordStacks = stacks(SWORD_KEY, self())

// Slash's length, in one place: how far it aims, how long the cut is, and how long the trail it
// leaves is, which is the same rectangle the cut landed in.
const SLASH_LENGTH = 350
const SLASH_HALF_WIDTH = 30
// Slash leaves a fiery trail: a rectangle exactly where the cut landed, SLASH_LENGTH long and 60 wide.
// Its effects find who is inside it with the same half-extents as its box.
const slashTrail = {
  id: 'slash-trail',
  speed: 0,
  box: { halfLength: SLASH_LENGTH / 2, halfWidth: SLASH_HALF_WIDTH },
  lifetimeTicks: seconds(3),
  visual: 'field',
  color: '#ff8a3d',
  onTick: [
    slow(linear(0.4, .1 ,swordStacks), 2, enemiesInBox(SLASH_LENGTH / 2, SLASH_HALF_WIDTH)),
    haste(linear(0.6,.1,swordStacks), 2, alliesInBox(SLASH_LENGTH / 2, SLASH_HALF_WIDTH)),
  ],
} satisfies EntityDef

ability({
  id: 'slash',
  description: 'Cuts a line, then leaves a trail that slows enemies and speeds up allies. Sword stacks add damage.',
  targeting: 'direction',
  range: SLASH_LENGTH,
  windUpTicks: 10,
  backswingTicks: 4,
  cooldownTicks: seconds(7),
  indicator: { width: slashTrail.box.halfWidth * 2 },
  apply: [
    damage(scaled(linear(60, 30, swordStacks), { attackDamage: 0.5 }), enemiesInLine(SLASH_LENGTH, SLASH_HALF_WIDTH)),
    // The trail's middle is half the cut's length ahead of the caster, pointing the same way.
    spawnEntity(slashTrail, { at: alongAim(SLASH_LENGTH / 2) }),
    popMarkers(SWORD_KEY, self()),
  ],
})

// Radiance's explosion is only a flash; its damage is dealt by the ability itself.
const lightBurst: EntityDef = {
  id: 'light-burst',
  speed: 0,
  radius: 170,
  lifetimeTicks: 12,
  visual: 'field',
  color: '#ffe27a',
}

ability({
  id: 'radiance',
  description: 'Spends your sword stacks to blast nearby enemies and speed you up.',
  targeting: 'none',
  range: 0,
  windUpTicks: 8,
  backswingTicks: 2,
  cooldownTicks: seconds(12),
  apply: [
    damage(scaled(linear(50, 40, swordStacks), { arcane: 0.4, level: 4 }), enemiesInRadius(170)),
    haste(linear(0, 0.20, swordStacks), seconds(2.5), self()),
    popMarkers(SWORD_KEY, self()),
    spawnEntity(lightBurst),
  ],
})

ability({
  id: 'shackle',
  description: 'Your next auto roots its target, or stuns it with full sword stacks.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(10),
  // The auto reads the stacks as they were before it adds its own, so the stacks it spends are the
  // ones built up, and the one it adds stays.
  empowerAttack: {
    ticks: seconds(5),
    effects: [
      when<SimContext>(
        (sim, src) => swordStacks(sim, src) >= SWORD_MAX_STACKS,
        [stun(seconds(1)),damage(linear(0, 40, swordStacks)),popMarkers(SWORD_KEY, self())],
        [root(seconds(1)),],
      ),
      
    ],
  },
  apply: [resetAutoTimer()],
})

// ---------------------------------------------------------------------------- Grenadier

// Grenadier's passive: an enemy hit by an auto carries a `sighted` marker for a while. The auto
// that would be the third in a row on the same enemy pops them instead and gives the Grenadier
// move speed that fades away. Markers sit on each enemy separately, so the count is per enemy.
export const SIGHTED_KEY = 'sighted'
export const SIGHTED_AUTOS = 3
export const SIGHTED_WINDOW_TICKS = seconds(5)
export const SIGHTED_HASTE = 0.5
export const SIGHTED_HASTE_TICKS = seconds(3)

// Grenadier's Grenade: a lob that goes off where it lands. Everything caught in the blast is
// thrown straight away from its centre: enemies are hurt and bounced, and the Grenadier is bounced
// too if it is standing in it. A blast that catches an enemy hands back half of the cooldown.
const GRENADE_RADIUS = 45
const grenadeBurst: EntityDef = {
  id: 'grenade-burst',
  speed: 0,
  radius: GRENADE_RADIUS,
  lifetimeTicks: 8,
  visual: 'field',
  color: '#9fb85a',
}
const grenade = {
  id: 'grenade-shot',
  speed: 750,
  radius: 8,
  landAtAim: true,
  color: '#9fb85a',
  onExpire: [
    damage(scaled(50, { arcane: 0.8 }), enemiesInRadius(GRENADE_RADIUS)),
    knockback(150, 400, enemiesInRadius(GRENADE_RADIUS)),
    knockback(110, 400, selfInRadius(GRENADE_RADIUS)),
    when<SimContext>(
      (sim, src) => enemiesInRadius(GRENADE_RADIUS)(sim, src).length > 0,
      [refundCooldown('grenade', .3)],
    ),
    spawnEntity(grenadeBurst),
  ],
} satisfies EntityDef

ability({
  id: 'grenade',
  description: 'Lobs a grenade that hurts and knocks enemies back. Hitting one refunds some cooldown.',
  targeting: 'point',
  range: 350,
  windUpTicks: 2,
  backswingTicks: 1,
  cooldownTicks: seconds(6),
  indicator: { radius: GRENADE_RADIUS },
  apply: [spawnEntity(grenade)],
})

// Grenadier's Molotov: the lob bursts into fire. Enemies standing in it are slowed and set alight,
// and keep burning for a few seconds after they leave it.
const MOLOTOV_RADIUS = 80
const molotovFire = {
  id: 'molotov-fire',
  speed: 0,
  radius: MOLOTOV_RADIUS,
  lifetimeTicks: seconds(4),
  visual: 'field',
  color: '#ff7a2f',
  // Refreshed every tick, so both wear off only after the enemy has been out of the fire a while.
  onTick: [
    slow(0.3, 2, enemiesInRadius(MOLOTOV_RADIUS)),
    burn(scaled(30, { arcane: 0.3 }), seconds(3), enemiesInRadius(MOLOTOV_RADIUS)),
  ],
} satisfies EntityDef

ability({
  id: 'molotov',
  description: 'Lobs a molotov that burns and slows enemies standing in the fire.',
  targeting: 'point',
  range: 350,
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(10),
  indicator: { radius: molotovFire.radius },
  apply: [
    spawnEntity({
      id: 'molotov-shot',
      speed: 600,
      radius: 7,
      landAtAim: true,
      color: '#ff7a2f',
      onExpire: [spawnEntity(molotovFire)],
    }),
  ],
})
const FLASH_CORE_RADIUS = 35
const FLASH_RADIUS = 70
const enemiesInFlashRing: Selector = (sim, src) => {
  const core = new Set(enemiesInRadius(FLASH_CORE_RADIUS)(sim, src))
  return enemiesInRadius(FLASH_RADIUS)(sim, src).filter((unitId) => !core.has(unitId))
}
const flashBurst: EntityDef = {
  id: 'flash-burst',
  speed: 0,
  radius: FLASH_RADIUS,
  lifetimeTicks: 8,
  visual: 'field',
  color: '#ffffff',
}
const flashbang = {
  id: 'flashbang-shot',
  speed: 550,
  radius: 7,
  landAtAim: true,
  color: '#f4f1d0',
  onExpire: [
    stun(seconds(1), enemiesInRadius(FLASH_CORE_RADIUS)),
    blind(seconds(1.5), enemiesInFlashRing),
    spawnEntity(flashBurst),
  ],
} satisfies EntityDef
ability({
  id: 'flashbang',
  description: 'Lobs a flashbang. Enemies in the middle are stunned, those at the edge are blinded.',
  targeting: 'point',
  range: 320,
  windUpTicks: 4,
  backswingTicks: 3,
  cooldownTicks: seconds(12),
  // Two circles: the whole flash, and the core inside it that stuns.
  indicator: { radius: FLASH_RADIUS, innerRadius: FLASH_CORE_RADIUS },
  apply: [spawnEntity(flashbang)],
})

// ---------------------------------------------------------------------------- Trinketmaster

// Trinketmaster's passive: an enemy hit by one of his abilities carries a `trick` marker for a while.
// The ability hit that would be the third in a row on the same enemy pops them instead, for bonus
// damage on top of its own, and gives him move speed for a short while. Markers sit on each enemy
// separately, so the count is per enemy, and each hit refreshes them, so the three have to be within
// the window of one another. The hits are the stick on the way out, the stick on the way back and the
// auto that Hush readies, which is Hush landing. His plain autos do not count.
export const TRICK_KEY = 'trick'
export const TRICK_HITS = 3
export const TRICK_WINDOW_TICKS = seconds(5)
export const TRICK_BONUS_DAMAGE = 100
export const TRICK_BONUS_DAMAGE_ARCANE = 0.5
export const TRICK_HASTE = 0.6
export const TRICK_HASTE_TICKS = seconds(1.5)
const tricksOnTarget = stacks(TRICK_KEY, subject())
// Run for each enemy one of his ability hits lands on, after the hit's own damage.
const trickEffects: readonly Effect[] = [
  when<SimContext>(
    (sim, src) => tricksOnTarget(sim, src) >= TRICK_HITS - 1,
    [
      damage(TRICK_BONUS_DAMAGE),
      popMarkers(TRICK_KEY),
      haste(TRICK_HASTE, TRICK_HASTE_TICKS, self()),
    ],
    [mark(TRICK_KEY, TRICK_WINDOW_TICKS, subject(), { cap: TRICK_HITS - 1 })],
  ),
]
const STICK_DAMAGE = 60
const STICK_ARCANE = 0.5
const STICK_RESET_TICKS = seconds(.5)
const stick = {
  id: 'stick',
  speed: 0,
  radius: 12,
  color: '#a9794a',
  // It has no timer, but it does not outlive its owner.
  stayWhile: (sim, src) => sim.isAlive(src.ownerId),
  pickup: [capCooldown('stick', STICK_RESET_TICKS)],
} satisfies EntityDef
const STICK_MIN_RANGE = 150
const STICK_RANGE = 360
const stickShot = {
  id: 'stick-shot',
  speed: 700,
  radius: 14,
  landAtAim: true,
  pierce: true,
  stopsAtWalls: true,
  color: '#a9794a',
  onHit: [damage(scaled(STICK_DAMAGE, { arcane: STICK_ARCANE })), ...trickEffects],
  onExpire: [spawnEntity(stick, { onePerOwner: true })],
} satisfies EntityDef
ability({
  id: 'stick',
  description: 'Throws a stick that stays where it lands. Walk over it to refresh this, or press again to call it back.',
  targeting: 'point',
  range: STICK_RANGE,
  minRange: STICK_MIN_RANGE,
  windUpTicks: 4,
  backswingTicks: 4,
  cooldownTicks: seconds(10),
  // Only one stick at a time. While it is out, this key calls it back instead.
  requires: { entity: 'stick', out: false },
  recast: 'recall',
  indicator: { line: true, width: stickShot.radius * 2 },
  apply: [spawnEntity(stickShot)],
})
const stickRecall = {
  id: 'stick-recall',
  speed: 800,
  radius: 15,
  homing: 'owner',
  pierce: true,
  color: '#a9794a',
  onHit: [damage(scaled(STICK_DAMAGE, { arcane: STICK_ARCANE })), slow(0.75, seconds(1.5)), ...trickEffects],
  pickup: [],
} satisfies EntityDef
ability({
  id: 'recall',
  description: 'Calls the stick back, hurting and slowing enemies on the way.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(0.5),
  requires: { entity: 'stick', out: true },
  apply: [
    spawnEntity(stickRecall, { at: ownEntity('stick') }),
    removeEntities('stick'),
  ],
})
const HUSH_DAMAGE = 40
const HUSH_ARCANE = 0.8
ability({
  id: 'hush',
  description: 'Your next auto silences its target and counts as an ability hit for your passive.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(8),
  empowerAttack: { ticks: seconds(5), effects: [silence(seconds(1.5)),damage(scaled(HUSH_DAMAGE, { arcane: HUSH_ARCANE })), ...trickEffects] },
  apply: [resetAutoTimer()],
})
// Warp's blink is only the two ends of it: a flash where the Trinketmaster leaves and where it lands.
const warpFlashOut: EntityDef = {
  id: 'warp-out',
  speed: 0,
  radius: 36,
  lifetimeTicks: 10,
  visual: 'field',
  color: '#7fe0d0',
}
const warpFlashIn: EntityDef = { ...warpFlashOut, id: 'warp-in' }
ability({
  id: 'warp',
  description: 'Blinks you to your stick. With no stick out, it gives you the throw back instead.',
  targeting: 'none',
  range: 0,
  windUpTicks: 3,
  backswingTicks: 2,
  cooldownTicks: seconds(10),
  // A stick on the ground to go to, or else no stick anywhere and a throw to give back.
  requires: { entity: 'stick', out: true },
  orWhen: { none: ['stick', 'stick-shot', 'stick-recall'], onCooldown: 'stick' },
  apply: [
    when<SimContext>(
      (sim, src) => sim.entitiesOf(src.ownerId, 'stick').length > 0,
      // The stick is picked up on the next tick, because the Trinketmaster is standing on it.
      [
        spawnEntity(warpFlashOut),
        blink(ownEntity('stick')),
        spawnEntity(warpFlashIn, { at: ownEntity('stick') }),
      ],
      // Nothing to go to: the throw is ready again, all of it.
      [spawnEntity(warpFlashOut), refundCooldown('stick', 1)],
    ),
  ],
})
// ---------------------------------------------------------------------------- Ninja

// Ninja's shadow stacks sit on the Ninja, and each is an enhanced auto ready. Only Shadow Step (and
// Shadow Return) adds one, when its dash passes through an enemy, up to two; they last six seconds,
// refreshed together. An auto or a Shuriken spends one.
export const SHADOW_KEY = 'shadow'
export const SHADOW_MAX_STACKS = 2
export const SHADOW_STACK_TICKS = seconds(6)
// How long a shadow stays out if the Ninja does not dash back to it, for Shadow Step and Shadow Return
// alike (both leave the same shadow). Change this one number to retune it.
export const SHADOW_LIFETIME_TICKS = seconds(4)
export const SHADOW_AUTO_BONUS = .5
const shadowStacks = stacks(SHADOW_KEY, self())
const spendShadowStack = popMarkers(SHADOW_KEY, self(), { count: 1 })

// Shadow Step: a dash that hurts and slows each enemy it passes through, as it passes it. The first
// one it passes also gives the Ninja a shadow stack (an enhanced auto), hands back most of the
// cooldown, and leaves a shadow behind at the spot it was cast from. With a shadow out, the key dashes
// back to it instead, from any distance, and does the same.
// A shadow lasts SHADOW_LIFETIME_TICKS (4 seconds), well short of Shadow Step's 8 second cooldown. The
// first enemy hands most of that cooldown back, so Shadow Step is ready before the shadow goes, and the
// key (Shadow Return while the shadow is out) turns back into it the moment the shadow fades. One that
// is dashed back to without passing through an enemy ends when the dash finishes, and Shadow Step
// starts its whole cooldown over, so the time that ran while the shadow was out is no help to a miss.
// It also goes when its owner dies.
const SHADOW_STEP_COOLDOWN_TICKS = seconds(8)
const SHADOW_STEP_RANGE = 300
const SHADOW_STEP_SPEED = 1200
const SHADOW_STEP_REFUND = 0.75
const SHADOW_STEP_DAMAGE = 60
const SHADOW_STEP_ATTACK_DAMAGE = 0.4
const shadow = {
  id: 'shadow',
  speed: 0,
  radius: 14,
  visual: 'field',
  color: '#7a5cff',
  lifetimeTicks: SHADOW_LIFETIME_TICKS,
  stayWhile: (sim, src) => sim.isAlive(src.ownerId),
} satisfies EntityDef

// What each enemy the dash passes through takes, as the Ninja's body reaches it.
const shadowDashHit: readonly Effect[] = [
  damage(scaled(SHADOW_STEP_DAMAGE, { attackDamage: SHADOW_STEP_ATTACK_DAMAGE })),
  slow(0.4, seconds(.75)),
]
// What the first enemy it passes through sets off, once for the dash. The dash back is not ready the
// moment it connects: it has its whole cooldown to wait from there.
const shadowDashConnect: readonly Effect[] = [
  mark(SHADOW_KEY, SHADOW_STACK_TICKS, self(), { cap: SHADOW_MAX_STACKS }),
  refundCooldown('shadowstep', SHADOW_STEP_REFUND),
  startCooldown('shadowreturn'),
  spawnEntity(shadow, { onePerOwner: true }),
]
const shadowStepDash: DashDef = { id: 'shadowstep', onHit: shadowDashHit, onConnect: shadowDashConnect }
// The dash back also loses the shadow if it finishes without passing through anyone.
const shadowReturnDash: DashDef = {
  id: 'shadowreturn',
  onHit: shadowDashHit,
  onConnect: shadowDashConnect,
  onMiss: [removeEntities('shadow'), startCooldown('shadowstep')],
}
ability({
  id: 'shadowstep',
  name: 'Shadow Step',
  description: 'Dashes through enemies, hurting and slowing them. Hitting one gives a shadow stack and leaves a shadow to return to.',
  targeting: 'point',
  range: SHADOW_STEP_RANGE,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: SHADOW_STEP_COOLDOWN_TICKS,
  movement: true,
  indicator: { line: true },
  // Only one shadow at a time. While it is out, this key dashes toward it instead.
  requires: { entity: 'shadow', out: false },
  recast: 'shadowreturn',
  apply: [dash(SHADOW_STEP_SPEED, SHADOW_STEP_RANGE, self(), { through: true, on: shadowStepDash })],
})
ability({
  id: 'shadowreturn',
  name: 'Shadow Return',
  description: 'Dashes back to your shadow, hurting and slowing enemies on the way.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(1.75),
  movement: true,
  requires: { entity: 'shadow', out: true },
  // As far as the shadow is, however far that is.
  apply: [
    dash(SHADOW_STEP_SPEED, Infinity, self(), { toward: ownEntity('shadow'), through: true, on: shadowReturnDash }),
  ],
})

// Ninja's Kunai: a line shot. It hurts and slows what it passes through, or, if the Ninja has a
// shadow stack, which it spends, it hurts more and roots instead.
// What the shuriken does to each enemy it passes through: the base damage, plus the Ninja's stats times these ratios (`scaled`).
export const SHURIKEN_DAMAGE = 60
export const SHURIKEN_SCALING = { attackDamage: 0.5 } satisfies Scaling
const shuriken = {
  id: 'shuriken',
  speed: 750,
  radius: 10,
  lifetimeTicks: seconds(0.2),
  pierce: true,
  color: '#c9c9ff',
  onHit: [damage(scaled(SHURIKEN_DAMAGE, SHURIKEN_SCALING)), slow(0.4, seconds(1.5))],
} satisfies EntityDef
const shurikenEnhanced = {
  id: 'shuriken-enhanced',
  speed: 640,
  radius: 10,
  lifetimeTicks: seconds(0.2),
  pierce: true,
  color: '#ff6bd6',
  onHit: [damage(scaled(110, { attackDamage: 0.7 })), root(seconds(1))],
} satisfies EntityDef
ability({
  id: 'shuriken',
  description: 'A piercing shuriken that slows. With a shadow stack it hurts more and roots instead.',
  targeting: 'direction',
  range: 150,
  windUpTicks: 4,
  backswingTicks: 3,
  cooldownTicks: seconds(7),
  indicator: { width: shuriken.radius * 2 },
  apply: [
    when<SimContext>(
      (sim, src) => shadowStacks(sim, src) > 0,
      [spendShadowStack, spawnEntity(shurikenEnhanced)],
      [spawnEntity(shuriken)],
    ),
  ],
})
ability({
  id: 'dodge',
  description: 'You move faster and dodge every auto attack for a moment.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(12),
  apply: [haste(0.4, seconds(1.5)), dodge(seconds(1.5))],
})

// ---------------------------------------------------------------------------- Hammer

// Hammer's plating: each auto he lands gives him a stack, up to six, and each stack is resistance. All the stacks end together, `PLATING_TICKS` after the last
// auto, which renews them. The resistance is a buff of the one name (see `statBuff`), worked out afresh from the stacks each auto and renewed with them,
// so the stacks and the resistance they give are always in step. (The effects are in champions.ts, with the rest of his autos.)
export const PLATING_KEY = 'plating'
export const PLATING_MAX_STACKS = 6
export const PLATING_TICKS = seconds(6)
// What a stack is worth: this many points of resistance, and this many more for each level he is (the level counts from 1, as it does for every `scaled` amount, so at
// level 1 a stack is the two added together).
export const PLATING_RESISTANCE_PER_STACK = 6
export const PLATING_SCALING_PER_LEVEL = 1

// Hammer's Slam: the hammer comes down on the ground in front of him, on a rectangle `SLAM_LENGTH` long from where he stands and as wide as the
// indicator. It leaves a mark on the ground for an instant, in the same rectangle.
const SLAM_LENGTH = 120
const SLAM_HALF_WIDTH = 25
export const SLAM_DAMAGE = 70
export const SLAM_SCALING = { attackDamage: 0.7 } satisfies Scaling
const slamCrater = {
  id: 'slam-crater',
  speed: 0,
  box: { halfLength: SLAM_LENGTH / 2, halfWidth: SLAM_HALF_WIDTH },
  lifetimeTicks: 10,
  visual: 'field',
  color: '#d9a35c',
} satisfies EntityDef
ability({
  id: 'slam',
  description: 'Smashes the ground in front of you, hurting and slowing enemies.',
  targeting: 'direction',
  range: SLAM_LENGTH,
  windUpTicks: 14,
  backswingTicks: 4,
  cooldownTicks: seconds(7),
  indicator: { width: SLAM_HALF_WIDTH * 2 },
  apply: [
    damage(scaled(SLAM_DAMAGE, SLAM_SCALING), enemiesInLine(SLAM_LENGTH, SLAM_HALF_WIDTH)),
    slow(0.4, seconds(1.5), enemiesInLine(SLAM_LENGTH, SLAM_HALF_WIDTH)),
    // The mark's middle is half the length ahead of him, pointing the way he struck.
    spawnEntity(slamCrater, { at: alongAim(SLAM_LENGTH / 2) }),
  ],
})

// Hammer's Hammer Drop: a jump to the aimed point that lands as its warning fills in. The warning is laid where he will come down, as soon as the
// jump starts, and fills in for as long as the jump takes, so it goes off as he lands. How long that is depends on how far the point is: from `DROP_MIN_TICKS`
// for one at his feet to `DROP_MAX_TICKS` for one at the farthest he can aim, so a near drop is quick. It hits whoever is inside then, and not whoever
// was when it was laid: an enemy can walk out of it. He goes over whatever is between, and a jump he does not live to land ends with him.
const DROP_RANGE = 350
const DROP_RADIUS = 90
export const DROP_MIN_TICKS = seconds(0.2)
export const DROP_MAX_TICKS = seconds(0.45)
// How long the warning lasts for the point this cast is aimed at, in a straight line between the shortest and the longest by how far it is.
const dropTicks = (_sim: SimReader, src: EffectSource): number => {
  if (src.aim?.mode !== 'point') return DROP_MAX_TICKS
  const dx = src.aim.point.x - src.at.x
  const dy = src.aim.point.y - src.at.y
  const share = Math.min(1, Math.sqrt(dx * dx + dy * dy) / DROP_RANGE)
  return Math.round(DROP_MIN_TICKS + (DROP_MAX_TICKS - DROP_MIN_TICKS) * share)
}
export const DROP_DAMAGE = 80
export const DROP_SCALING = { attackDamage: 0.8 } satisfies Scaling
export const DROP_STUN_TICKS = seconds(1)
const dropBurst: EntityDef = {
  id: 'hammerdrop-burst',
  speed: 0,
  radius: DROP_RADIUS,
  lifetimeTicks: 8,
  visual: 'field',
  color: '#d9a35c',
}
const dropWarning: EntityDef = {
  id: 'hammerdrop-warning',
  speed: 0,
  radius: DROP_RADIUS,
  // The longest it lasts; each one lasts as long as its own jump (see `dropTicks`).
  lifetimeTicks: DROP_MAX_TICKS,
  visual: 'telegraph',
  color: '#ff6b4a',
  stayWhile: (sim, src) => sim.isAlive(src.ownerId),
  onExpire: [
    damage(scaled(DROP_DAMAGE, DROP_SCALING), enemiesInRadius(DROP_RADIUS)),
    stun(DROP_STUN_TICKS, enemiesInRadius(DROP_RADIUS)),
    spawnEntity(dropBurst),
  ],
}
ability({
  id: 'hammerdrop',
  name: 'Hammer Drop',
  icon: 'drop',
  description: 'Leaps to a marked spot and slams down, stunning enemies where you land.',
  targeting: 'point',
  range: DROP_RANGE,
  windUpTicks: 3,
  backswingTicks: 3,
  cooldownTicks: seconds(12),
  movement: true,
  indicator: { radius: DROP_RADIUS },
  apply: [
    spawnEntity(dropWarning, { at: aimPoint(), lifetime: dropTicks }),
    // However far the aimed point is, it is in reach (the cast was checked), so the jump goes all the way there. It takes a tick less than the warning,
    // because the last step of a dash can take one more than it is worked out for: he is down before the warning goes off, and not on the tick it does.
    dash(0, Infinity, self(), { through: true, over: (sim, src) => dropTicks(sim, src) - 1 }),
  ],
})

// Hammer's Rage: move speed, attack speed and damage reduction for `RAGE_TICKS`. Each of its effects is the one status of the name `RAGE_KEY` (see `haste`),
// and each auto he lands makes them last `RAGE_AUTO_TICKS` longer (`prolong`, in champions.ts), up to `RAGE_MAX_TICKS` left. The page draws what is left of it as
// a bar over him, full at `RAGE_MAX_TICKS` (the champion's `meter`).
export const RAGE_KEY = 'rage'
export const RAGE_TICKS = seconds(5)
export const RAGE_AUTO_TICKS = seconds(0.6)
export const RAGE_MAX_TICKS = seconds(6)
export const RAGE_HASTE = 0.3
export const RAGE_ATTACK_SPEED = 0.5
ability({
  id: 'rage',
  description: 'Move and attack faster and take less damage. Your autos make it last longer.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(16),
  apply: [
    haste(RAGE_HASTE, RAGE_TICKS, self(), { named: RAGE_KEY }),
    statBuff('attackSpeed', RAGE_ATTACK_SPEED, RAGE_TICKS, self(), { named: RAGE_KEY }),
  ],
})

// ---------------------------------------------------------------------------- Chain

// Chain's first strike: the first auto he lands on an enemy, or the first hit the edge of Whirl makes on it, does bonus damage and heals him. The enemy then
// carries a `FIRST_STRIKE_KEY` marker, his own, for `FIRST_STRIKE_COOLDOWN_TICKS`, and he has no first strike on it until the marker is gone: so each enemy
// has a cooldown of its own, and another Chain's is separate (a marker is counted by its owner). A structure takes no markers, so it is never first-struck.
export const FIRST_STRIKE_KEY = 'chained'
export const FIRST_STRIKE_COOLDOWN_TICKS = seconds(10)
export const FIRST_STRIKE_DAMAGE = 30
export const FIRST_STRIKE_SCALING = { attackDamage: 0.3 } satisfies Scaling
export const FIRST_STRIKE_HEAL = 40
export const FIRST_STRIKE_HEAL_SCALING = { maxHealth: .1}
const firstStruck = stacks(FIRST_STRIKE_KEY, subject())
// Run for the unit hit (the subject), after the hit's own damage.
export const firstStrike: Effect<SimContext> = when<SimContext>(
  (sim, src) => src.subject !== null && sim.character(src.subject)?.structure !== true && firstStruck(sim, src) === 0,
  [
    damage(scaled(FIRST_STRIKE_DAMAGE, FIRST_STRIKE_SCALING)),
    heal(scaled(FIRST_STRIKE_HEAL,FIRST_STRIKE_HEAL_SCALING)),
    mark(FIRST_STRIKE_KEY, FIRST_STRIKE_COOLDOWN_TICKS, subject()),
  ],
)
// The same for each unit a pulse of Whirl selects, one at a time, as the subject.
const firstStrikeOn = (to: Selector): Effect<SimContext> => (sim, src) => {
  for (const unitId of to(sim, src)) runEffects([firstStrike], sim, { ...src, subject: unitId })
}

// Chain's Hook: a shot that drags the first enemy it hits to him, and drops it touching him. The drag is a dash of the enemy's, so it cannot attack or cast
// until it lands, and it goes over whatever is between.
const HOOK_RANGE = 280
const HOOK_SPEED = 720
export const HOOK_DAMAGE = 60
export const HOOK_SCALING = { attackDamage: 0.5 } satisfies Scaling
const HOOK_PULL_SPEED = 1000
const hook = {
  id: 'hook',
  speed: HOOK_SPEED,
  radius: 14,
  lifetimeTicks: Math.round(HOOK_RANGE / HOOK_SPEED * GAME_TPS),
  color: '#b8c4d4',
  onHit: [
    damage(scaled(HOOK_DAMAGE, HOOK_SCALING)),
    dash(HOOK_PULL_SPEED, Infinity, subject(), { toward: besideOwner(), through: true }),
  ],
} satisfies EntityDef
ability({
  id: 'hook',
  description: 'Throws out a chain that drags the first enemy it hits to you.',
  targeting: 'direction',
  range: HOOK_RANGE,
  windUpTicks: 6,
  backswingTicks: 4,
  cooldownTicks: seconds(12),
  indicator: { width: hook.radius * 2 },
  apply: [spawnEntity(hook)],
})

// Chain's Whirl: a charge-up and then one blow. For `WHIRL_CHARGE_TICKS` two circles, the core and the whole, are outlined round him (they do not fill in); when the
// charge is full the blow lands, with a flash, on whoever is inside them then, and not whoever was when it was started, so an enemy can get out. Whoever is wholly inside the
// core takes the plain hit; whoever reaches the ring outside it, the sweet spot, even by touching it, takes the bigger one and is slowed, and that is a first strike.
// The cast has no windup or backswing, so he can walk and cast while it charges, but he is disarmed for it and cannot attack. The circles are held exactly on him
// (`attached`), so they are centred on him as he walks, and what they hit is what is inside them, so it is where they are drawn. A charge that he does not live to
// finish, or that a stun breaks, does not go off.
const WHIRL_CHARGE_TICKS = seconds(.8)
export const WHIRL_CORE_RADIUS = 70
export const WHIRL_RADIUS = 120
export const WHIRL_DAMAGE = 35
export const WHIRL_SCALING = { attackDamage: 0.5 } satisfies Scaling
export const WHIRL_SWEET_DAMAGE = 70
export const WHIRL_SWEET_SCALING = { attackDamage: 0.8 } satisfies Scaling
export const WHIRL_SWEET_SLOW = 0.4
const WHIRL_SWEET_SLOW_TICKS = seconds(1.5)
// Whether a body is wholly inside the core, which is the only place the plain hit reaches. A body that reaches out of it at all, into the ring, is on the edge,
// and the edge is the better hit: so one that touches both circles is hit as the edge. (It is the body that counts, wherever its middle is.)
const insideWhirlCore = (sim: SimReader, src: EffectSource, unitId: number): boolean => {
  const unit = sim.character(unitId)
  const position = sim.posAt(unitId, src.tick)
  if (!unit || !position) return false
  const dx = position.x - src.at.x
  const dy = position.y - src.at.y
  return Math.sqrt(dx * dx + dy * dy) + unit.champion.radius <= WHIRL_CORE_RADIUS
}
const enemiesInWhirlCore: Selector = (sim, src) =>
  enemiesInRadius(WHIRL_CORE_RADIUS)(sim, src).filter((unitId) => insideWhirlCore(sim, src, unitId))
const enemiesOnWhirlEdge: Selector = (sim, src) =>
  enemiesInRadius(WHIRL_RADIUS)(sim, src).filter((unitId) => !insideWhirlCore(sim, src, unitId))
// The blow itself is only a flash, hot at the edge, which is where it is worst, and pale in the core; its damage is dealt by the charge as it ends.
const WHIRL_FLASH_TICKS = 10
const whirlBurst: EntityDef = {
  id: 'whirl-burst',
  speed: 0,
  radius: WHIRL_RADIUS,
  lifetimeTicks: WHIRL_FLASH_TICKS,
  visual: 'flash',
  color: '#ff6b4a',
}
const whirlCoreBurst: EntityDef = {
  id: 'whirl-core-burst',
  speed: 0,
  radius: WHIRL_CORE_RADIUS,
  lifetimeTicks: WHIRL_FLASH_TICKS,
  visual: 'flash',
  color: '#fff1c9',
}
const whirlCharges = {
  lifetimeTicks: WHIRL_CHARGE_TICKS,
  attached: true,
  visual: 'field',
  stayWhile: (sim, src) => sim.isAlive(src.ownerId) && !sim.statusesOn(src.ownerId).some((status) => status.kind === 'stun'),
} satisfies Partial<EntityDef>
// The core is only outlined, in a paler colour than the edge, which is where the blow is worst.
const whirlCoreWarning = {
  ...whirlCharges,
  id: 'whirl-core-warning',
  speed: 0,
  radius: WHIRL_CORE_RADIUS,
  color: '#c9b27a',
} satisfies EntityDef
const whirlWarning = {
  ...whirlCharges,
  id: 'whirl-warning',
  speed: 0,
  radius: WHIRL_RADIUS,
  color: '#ff6b4a',
  onExpire: [
    damage(scaled(WHIRL_DAMAGE, WHIRL_SCALING), enemiesInWhirlCore),
    damage(scaled(WHIRL_SWEET_DAMAGE, WHIRL_SWEET_SCALING), enemiesOnWhirlEdge),
    slow(WHIRL_SWEET_SLOW, WHIRL_SWEET_SLOW_TICKS, enemiesOnWhirlEdge),
    firstStrikeOn(enemiesOnWhirlEdge),
    spawnEntity(whirlBurst),
    spawnEntity(whirlCoreBurst),
  ],
} satisfies EntityDef
ability({
  id: 'whirl',
  description: 'Charges your chains around you, then lashes out. The outer edge hits harder and slows. You can move but not attack while it charges.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(11),
  apply: [
    // Disarmed through the last tick before the blow lands (a status is over on the tick it ends on, and the blow comes a tick after the charge is full).
    disarm(WHIRL_CHARGE_TICKS + 1, self()),
    spawnEntity(whirlCoreWarning),
    spawnEntity(whirlWarning),
  ],
})

// Chain's Lunge: a short dash the way it is aimed, with no target, that quickens his attacks and readies his next auto at once. It has no windup, so it is cast
// while Whirl charges.
const LUNGE_RANGE = 120
const LUNGE_SPEED = 400
export const LUNGE_ATTACK_SPEED = 0.6
export const LUNGE_BUFF_TICKS = seconds(3)
ability({
  id: 'lunge',
  description: 'A short dash that speeds up your attacks and resets your auto. You can use it while Whirl charges.',
  targeting: 'direction',
  range: LUNGE_RANGE,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: seconds(9),
  movement: true,
  apply: [
    dash(LUNGE_SPEED, LUNGE_RANGE),
    statBuff('attackSpeed', LUNGE_ATTACK_SPEED, LUNGE_BUFF_TICKS),
    resetAutoTimer(),
  ],
})

// ---------------------------------------------------------------------------- Monsters

  // Monsters' abilities. A monster is a champion as far as the simulator goes, so its abilities are defined here like
  // any other, and listed on its monster (see monsters.ts); no player champion has them.

ability({
  id: 'monster-slam',
  description: 'A heavy blow to everything around the caster.',
  targeting: 'none',
  range: 0,
  windUpTicks: 14,
  backswingTicks: 10,
  cooldownTicks: seconds(6),
  apply: [damage(60, enemiesInRadius(130))],
})

export function getAbilityDef(id: string): AbilityDef | undefined {
  return abilityDefs.get(id)
}

const DIRECTION_STEPS = 4096
const DIRECTION_PRECISION = 10_000

// Client-side only: the quantized result travels as order data, so peers never
// need bit-identical trigonometry.
export function quantizeDirection(dir: Vector2): Vector2 | undefined {
  if (dir.x === 0 && dir.y === 0) return undefined
  const step = Math.PI * 2 / DIRECTION_STEPS
  const angle = Math.round(Math.atan2(dir.y, dir.x) / step) * step
  return {
    x: Math.round(Math.cos(angle) * DIRECTION_PRECISION) / DIRECTION_PRECISION,
    y: Math.round(Math.sin(angle) * DIRECTION_PRECISION) / DIRECTION_PRECISION,
  }
}
