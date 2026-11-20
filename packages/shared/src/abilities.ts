import { GAME_TPS } from './constants.js'
import {
  aimPoint,
  alliesInBox,
  alliesInRadius,
  alongAim,
  attackRangeBonus,
  besideOwner,
  besideTarget,
  bleed,
  blind,
  blink,
  burn,
  capCooldown,
  cleanse,
  damage,
  dash,
  describedAs,
  disarm,
  dodge,
  enemiesInBox,
  enemiesInCone,
  enemiesInLine,
  enemiesInRadius,
  fear,
  haste,
  heal,
  healthLost,
  invisible,
  knockback,
  knockUp,
  lifesteal,
  linear,
  loseHealth,
  mark,
  markedUnits,
  missingHealth,
  onEach,
  ownEntity,
  popMarkers,
  prolong,
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
  spore,
  stacks,
  startCooldown,
  stun,
  subject,
  targetUnit,
  towardTarget,
  when,
  attackDamage,
  fromEachOwnEntity,
  resolveAmount,
  gainResource,
  resource,
  spendResource,
  invulnerable,
  REVEAL_KEY,
  type Amount,
  type Anchor,
  type DashDef,
  type Effect,
  type EffectSource,
  type EntityDef,
  type Scaling,
  type Selector,
  type SimContext,
  type SimReader,
  type SimWriter,
} from './effects.js'
import { distanceBetween } from './geometry.js'
import type { CastTarget, Marker, Status, Vector2 } from './index.js'

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
  // For a cone, such as a spread of knives: half the angle it opens by, in radians, which the page draws as a wedge from the caster out to the ability's range. The
  // ability itself aims with numbers written out (see `enemiesInCone`), so a test checks that the two agree.
  coneHalfAngle?: number
}

// How long abilities wind up for, by kind: the list to set to change how an ability feels to cast, with a name for each kind of windup the game has. An ability says which it has with
// `windUpTicks: WINDUP_TICKS.default`; one with no windup says `windUpTicks: 0`. To give some abilities a windup of their own, add a kind here (`heavy: 30`) and use it where they are
// written. These are in ticks (60 to a second).
export const WINDUP_TICKS = {
  default: 15,
  // Something set down with care, which takes a while and can be seen coming (the Vulture's mine).
  placing: 36,
} as const satisfies Readonly<Record<string, number>>

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
  // For a unit-targeted ability: it is aimed at a teammate, or at the caster itself, and not at an enemy. Its target does not need to be seen to be aimed at.
  targetsAllies?: true
  // For one that is for allies: the page casts it on the unit the caster has linked to itself (`ChampionDef.damageLink`), wherever the cursor is, and never on the caster (the
  // self-cast key does not make it so). So it needs no one under the cursor, and a teammate does not have to be pointed at. What the cast does with whoever it is on
  // is the ability's own (Link Heal heals the linked unit, and the caster, and ends the link).
  targetsLinked?: true
  range: number
  // A point-targeted ability cannot be aimed nearer the caster than this. The client pushes the aim out
  // to it, and a cast aimed nearer is dropped like one aimed out of range.
  minRange?: number
  // How many ticks it winds up for before it is cast: the caster is held to it (walking on is kept for after, an auto attack is not made), and the ability does what it does when it
  // is over, and not before. A windup is given by name from `WINDUP_TICKS`, so that how long the abilities of a kind wind up for is told in one place. Nothing comes after it: the caster
  // is free to act the moment the ability is cast. 0 is an ability with no windup, which is cast the moment it is used.
  windUpTicks: number
  cooldownTicks: number
  // The ability needs the caster to be able to move, so a root or stun stops it from starting.
  movement?: boolean
  // Casting it does not make an invisible caster seen. Every other ability does, and so does an auto attack: whoever is invisible and strikes is no longer.
  keepsInvisibility?: true
  // It is cast through crowd control: a stun, a knock-up, a fear or a silence, which stop any other ability from starting, do not stop this one (a root still stops one that needs
  // to move), and once it is winding up, none of them or an interrupt cancels it: it goes off. For a cleanse, which is for getting out of them, and for a cast that cannot be stopped.
  unstoppable?: true
  // For one aimed at a unit: it reaches farther to a unit that has a status of this kind on it (whoever put it there), this range in place of `range`. The simulator and the
  // page both read it with `castRangeAgainst`.
  // (Or against one that carries a marker of `marker`, such as the Vulture's carrion.)
  rangeAgainst?: { status?: Status['kind']; marker?: string; range: number }
  // The page draws on the caster's health bar how much the heals this gives the caster would come to now, while it is ready to cast (see `healPreview` in ability-info.ts).
  healthBarPreview?: true
  // How big its indicator is drawn while it is aimed. Without it the indicator only marks the aim.
  indicator?: AbilityIndicator
  // The ability can only be cast while the caster has (`out: true`) or has not (`out: false`) an
  // entity of this definition out in the world, such as a stick on the ground. Cast at any other
  // time it is dropped like an invalid order: nothing happens and no cooldown starts.
  // With `orEntities` (and `out`), any of those being out does as well (Warp goes to the stick on the ground or in the air).
  requires?: { entity: string; out: boolean; orEntities?: readonly string[] }
  // The ability can only be cast while the caster has at least `count` of its own markers of `key` on itself, such as the Hunter's full focus. Cast with fewer, it
  // is dropped as one whose `requires` does not hold.
  needsStacks?: { key: string; count: number }
  // Another way to be castable when `requires` is not met: when none of these entities are out (an
  // entity of each definition, such as a stick on the ground and in the air) and the ability of this
  // id is on cooldown. For an ability that does something else when there is nothing for it to act on.
  orWhen?: { none: readonly string[]; onCooldown: string }
  // The ability that takes this one's place on its key while that one can be cast, so one key does
  // two things: throw a stick, then call it back. It is an ability in full, with its own cooldown,
  // and it belongs to any champion that has this one.
  recast?: string
  // Held: the key casts this as it goes down, and its `recast` as it comes up, aimed where the pointer is then (the Sniper's Steady Aim). Nothing is aimed while it is
  // held, a click does not end it, and the champion is free to move. The page lets it go by itself after `ticks`, if the key is held that long. While it is held the page
  // draws how far the recast would reach (`reach`, by the ticks it has been held), growing until `full`.
  held?: { ticks: number; full: number; reach: (heldTicks: number) => number }
  // Every champion has it, whatever its abilities are, and it is not on a key (see `BACK_ABILITY_ID`). A silence does not stop it either.
  universal?: true
  // Applied through an auto attack. Casting this readies the caster's next auto instead of striking
  // anything itself: for `ticks` after the cast, the next auto that lands also runs `effects` on its
  // target (as their subject) and spends the readiness. Casting again refreshes it. The cast's own
  // `apply` still runs at once, for anything that should not wait for the auto, such as resetting
  // the auto timer. With no windup it can be used between autos without interrupting them.
  empowerAttack?: { ticks: number; effects: readonly Effect[] }
  // A longer reach while the caster carries a marker of `key` (the Grenadier's primed throw: see `castRangeFor`).
  rangeWhenMarked?: { key: string; range: number }
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

// How far an ability reaches for a caster: its `range`, or its longer one while the caster carries the marker that gives it (`rangeWhenMarked`). `marked` says
// whether the caster carries a marker of a key.
export function castRangeFor(def: Pick<AbilityDef, 'range' | 'rangeWhenMarked'>, marked: (key: string) => boolean): number {
  return def.rangeWhenMarked && marked(def.rangeWhenMarked.key) ? def.rangeWhenMarked.range : def.range
}

// The marker on a champion that says this ability's effects are ready for its next auto.
export const readyKey = (abilityId: string): string => `ready:${abilityId}`

const seconds = (value: number): number => Math.round(value * GAME_TPS)

// Whether `to` is within an ability's range of `from` (centre to centre), with a hair of slack for
// rounding. The simulator checks casts with this, and the client uses the same test to refuse a
// cast that would be dropped and to show whether an aim is in reach.
const RANGE_EPSILON = 1e-6
export const withinCastRange = (from: Vector2, to: Vector2, range: number): boolean =>
  distanceBetween(from, to) <= range + RANGE_EPSILON
// Whether `to` is at least `minRange` from `from`, with the same slack.
export const beyondMinCastRange = (from: Vector2, to: Vector2, minRange = 0): boolean =>
  distanceBetween(from, to) >= minRange - RANGE_EPSILON

// How far an ability aimed at a unit reaches to one with these statuses on it: farther, as its `rangeAgainst` says, to one with a status of that kind, and its own range otherwise.
export const castRangeAgainst = (
  def: Pick<AbilityDef, 'range' | 'rangeAgainst'>,
  statuses: readonly Pick<Status, 'kind'>[],
  markers: readonly { key: string }[] = [],
): number => {
  const against = def.rangeAgainst
  if (!against) return def.range
  const found = (against.status !== undefined && statuses.some((status) => status.kind === against.status))
    || (against.marker !== undefined && markers.some((marker) => marker.key === against.marker))
  return found ? against.range : def.range
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
  || (def.requires.out && (def.requires.orEntities ?? []).some(entityOut))
  || (def.orWhen !== undefined
    && def.orWhen.none.every((defId) => !entityOut(defId))
    && onCooldown(def.orWhen.onCooldown))

// Whether the caster has the stacks an ability `needsStacks`, from the markers on it.
export const hasNeededStacks = (def: AbilityDef, markers: readonly Marker[], casterId: number, tick: number): boolean =>
  def.needsStacks === undefined
  || markers.filter((marker) => marker.key === def.needsStacks?.key && marker.ownerId === casterId && marker.endTick > tick).length >= def.needsStacks.count

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
  windUpTicks: WINDUP_TICKS.default,
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
  windUpTicks: WINDUP_TICKS.default,
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

// How far a shot flies before it runs out: the range of an ability aimed in a direction that fires it, so its indicator shows
// where the shot goes. For a direction the range is only what is drawn; the shot itself goes by its speed and lifetime.
const flightOf = (shot: { speed: number; lifetimeTicks: number }): number => Math.round(shot.speed * shot.lifetimeTicks / GAME_TPS)

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
  range: flightOf(hexShot),
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(5),
  indicator: { width: hexShot.radius * 2 },
  apply: [spawnEntity(hexShot)],
})

// ---------------------------------------------------------------------------- Archer

// Archer's Leap: a dash that readies the next auto, which comes at once (the auto timer is reset) and deals `LEAP_BONUS_SCALING` of her attack damage on top of the
// auto's own, so 150% in all. It waits `LEAP_EMPOWER_TICKS` for that auto.
export const LEAP_BONUS_SCALING = { attackDamage: 0.5 } satisfies Scaling
const LEAP_EMPOWER_TICKS = seconds(5)
// The least distance Leap can be aimed at.
export const LEAP_MIN_RANGE = 80
ability({
  id: 'leap',
  description: 'Dashes to the target point. Your next auto is ready at once and deals 50% more damage.',
  targeting: 'point',
  range: 150,
  // It has to go somewhere: aimed at her feet it would be a reset and an empowered auto for nothing. Aimed nearer, it goes this far.
  minRange: LEAP_MIN_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(8),
  movement: true,
  indicator: { line: true },
  empowerAttack: { ticks: LEAP_EMPOWER_TICKS, effects: [damage(scaled(0, LEAP_BONUS_SCALING))] },
  apply: [dash(600, 120), resetAutoTimer()],
})
ability({
  id: 'focus',
  description: 'Your auto attacks are faster and reach farther for a few seconds.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
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
  windUpTicks: WINDUP_TICKS.default,
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
export const EMPOWER_BONUS_SCALING = { arcane: .3} satisfies Scaling
const TSUNAMI_STUN_TICKS = seconds(0.6)
// What the wave does to each enemy it passes through: the base damage, plus the caster's stats times these ratios (`scaled`).
export const TSUNAMI_DAMAGE = 100
export const TSUNAMI_SCALING = { arcane: 0.8 } satisfies Scaling
const tsunamiWave = {
  id: 'tsunami-wave',
  speed: 500,
  box: { halfLength: 10, halfWidth: 45 },
  lifetimeTicks: seconds(0.8),
  pierce: true,
  color: '#4fa8ff',
  // The push is at most 140, and no farther than 50 past where the wave stops.
  onHit: [damage(scaled(TSUNAMI_DAMAGE, TSUNAMI_SCALING)), knockback(120, 700, subject(), { pastEnd: 50 }), stun(TSUNAMI_STUN_TICKS)],
} satisfies EntityDef
ability({
  id: 'tsunami',
  description: 'A wave that damages, knocks back and stuns enemies.',
  targeting: 'direction',
  range: flightOf(tsunamiWave),
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(14),
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
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(10),
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
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(11),
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
  cooldownTicks: seconds(18),
  apply: [
    loseHealth(100),
    statBuff('attackSpeed', 0.5, seconds(6)),
    haste(0.5, seconds(6)),
    statBuff('resistance', 40, seconds(6)),
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
  range: flightOf(soldierBolt),
  windUpTicks: WINDUP_TICKS.default,
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
  windUpTicks: WINDUP_TICKS.default,
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
// What a stack adds to an auto grows with his level: `SWORD_DAMAGE_PER_STACK`, and this many more for each level he is (the level counts from 1, as it does for every `scaled`
// amount, so at level 1 a stack is the two added together). Slash reads the stacks with numbers of its own.
export const SWORD_SCALING_PER_LEVEL = 1
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
  windUpTicks: WINDUP_TICKS.default,
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
  windUpTicks: WINDUP_TICKS.default,
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

// Grenadier's passive: once he has gone `PRIMED_QUIET_TICKS` (less `PRIMED_QUIET_TICKS_PER_LEVEL` for each level past the first) without dealing or taking
// damage or starting a cast, his next ability is primed (a `PRIMED_KEY` marker on him: see `ChampionDef.primesWhenQuiet`). A fight does not take it away once
// he has it; the next ability he throws spends it, and is the primed one: it reaches farther (`PRIMED_RANGE`), bursts wider (`PRIMED_SIZE`), hurts more
// (`PRIMED_DAMAGE`), holds what it stuns, blinds, slows or burns for longer (`PRIMED_CC`), and a grenade throws what it catches farther (`PRIMED_LAUNCH`).
export const PRIMED_KEY = 'primed'
export const PRIMED_QUIET_TICKS = seconds(12)
export const PRIMED_QUIET_TICKS_PER_LEVEL = seconds(0.25)
export const PRIMED_RANGE = 1.4
export const PRIMED_SIZE = 1.5
export const PRIMED_DAMAGE = 1.5
export const PRIMED_CC = 1.5
export const PRIMED_LAUNCH = 1.6
const isPrimed = (sim: SimContext, src: EffectSource): boolean => stacks(PRIMED_KEY, self())(sim, src) > 0
// An ability's throw: the primed one, spending the priming, if he is primed, and the plain one if not.
const thrown = (plain: EntityDef, primed: EntityDef): Effect<SimContext> =>
  when<SimContext>(isPrimed, [spawnEntity(primed), popMarkers(PRIMED_KEY, self())], [spawnEntity(plain)])
// How far a primed throw reaches, for an ability that reaches `range` plain.
const primedReach = (range: number): AbilityDef['rangeWhenMarked'] => ({ key: PRIMED_KEY, range: Math.round(range * PRIMED_RANGE) })

// The `sighted` marks were the Grenadier's passive before this one (three autos on one enemy for move speed). The game no longer has them; the tests' own
// champions still use them, to test marks of their kind.
export const SIGHTED_KEY = 'sighted'
export const SIGHTED_AUTOS = 3
export const SIGHTED_WINDOW_TICKS = seconds(5)
export const SIGHTED_HASTE = 0.5
export const SIGHTED_HASTE_TICKS = seconds(3)

// Grenadier's Grenade: a lob that goes off where it lands. Everything caught in the blast is
// thrown straight away from its centre: enemies are hurt and bounced, and the Grenadier is bounced
// too if it is standing in it. A blast that catches an enemy hands back half of the cooldown.
const GRENADE_RADIUS = 60
const GRENADE_RANGE = 350
const grenadeOf = (primed: boolean): EntityDef => {
  const size = primed ? PRIMED_SIZE : 1
  const power = primed ? PRIMED_DAMAGE : 1
  const launch = primed ? PRIMED_LAUNCH : 1
  const radius = Math.round(GRENADE_RADIUS * size)
  const suffix = primed ? '-primed' : ''
  return {
    id: `grenade-shot${suffix}`,
    speed: 750,
    radius: 8,
    landAtAim: true,
    color: '#9fb85a',
    onExpire: [
      damage(scaled(50 * power, { arcane: 0.8 * power }), enemiesInRadius(radius)),
      knockback(Math.round(150 * launch), 400 * launch, enemiesInRadius(radius)),
      knockback(Math.round(110 * launch), 400 * launch, selfInRadius(radius)),
      when<SimContext>(
        (sim, src) => enemiesInRadius(radius)(sim, src).length > 0,
        [refundCooldown('grenade', .3)],
      ),
      spawnEntity({ id: `grenade-burst${suffix}`, speed: 0, radius, lifetimeTicks: 8, visual: 'field', color: '#9fb85a' }),
    ],
  }
}
ability({
  id: 'grenade',
  description: 'Lobs a grenade that hurts and knocks enemies back. Hitting one refunds some cooldown.',
  targeting: 'point',
  range: GRENADE_RANGE,
  rangeWhenMarked: primedReach(GRENADE_RANGE),
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(6),
  indicator: { radius: GRENADE_RADIUS },
  apply: [thrown(grenadeOf(false), grenadeOf(true))],
})

// Grenadier's Molotov: the lob bursts into fire. Enemies standing in it are slowed and set alight,
// and keep burning for a few seconds after they leave it. Primed, the fire is wider, burns hotter, and lasts longer, and so does what it leaves burning.
const MOLOTOV_RADIUS = 80
const MOLOTOV_RANGE = 350
const molotovOf = (primed: boolean): EntityDef => {
  const radius = Math.round(MOLOTOV_RADIUS * (primed ? PRIMED_SIZE : 1))
  const power = primed ? PRIMED_DAMAGE : 1
  const hold = primed ? PRIMED_CC : 1
  const suffix = primed ? '-primed' : ''
  const fire = {
    id: `molotov-fire${suffix}`,
    speed: 0,
    radius,
    lifetimeTicks: Math.round(seconds(4) * hold),
    visual: 'field',
    color: '#ff7a2f',
    // Refreshed every tick, so both wear off only after the enemy has been out of the fire a while.
    onTick: [
      slow(0.3, 2, enemiesInRadius(radius)),
      burn(scaled(30 * power, { arcane: 0.3 * power }), Math.round(seconds(3) * hold), enemiesInRadius(radius)),
    ],
  } satisfies EntityDef
  return {
    id: `molotov-shot${suffix}`,
    speed: 600,
    radius: 7,
    landAtAim: true,
    color: '#ff7a2f',
    onExpire: [spawnEntity(fire)],
  }
}
ability({
  id: 'molotov',
  description: 'Lobs a molotov that burns and slows enemies standing in the fire.',
  targeting: 'point',
  range: MOLOTOV_RANGE,
  rangeWhenMarked: primedReach(MOLOTOV_RANGE),
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(10),
  indicator: { radius: MOLOTOV_RADIUS },
  apply: [thrown(molotovOf(false), molotovOf(true))],
})

// Grenadier's Flashbang: enemies in the middle are stunned, those at the edge blinded. Primed, both rings are wider and both last longer.
const FLASH_CORE_RADIUS = 35
const FLASH_RADIUS = 70
const FLASH_RANGE = 320
const flashbangOf = (primed: boolean): EntityDef => {
  const size = primed ? PRIMED_SIZE : 1
  const hold = primed ? PRIMED_CC : 1
  const core = Math.round(FLASH_CORE_RADIUS * size)
  const outer = Math.round(FLASH_RADIUS * size)
  const suffix = primed ? '-primed' : ''
  const inRing: Selector = (sim, src) => {
    const middle = new Set(enemiesInRadius(core)(sim, src))
    return enemiesInRadius(outer)(sim, src).filter((unitId) => !middle.has(unitId))
  }
  return {
    id: `flashbang-shot${suffix}`,
    speed: 550,
    radius: 7,
    landAtAim: true,
    color: '#f4f1d0',
    onExpire: [
      stun(Math.round(seconds(1) * hold), enemiesInRadius(core)),
      blind(Math.round(seconds(1.5) * hold), inRing),
      spawnEntity({ id: `flash-burst${suffix}`, speed: 0, radius: outer, lifetimeTicks: 8, visual: 'field', color: '#ffffff' }),
    ],
  }
}
ability({
  id: 'flashbang',
  description: 'Lobs a flashbang. Enemies in the middle are stunned, those at the edge are blinded.',
  targeting: 'point',
  range: FLASH_RANGE,
  rangeWhenMarked: primedReach(FLASH_RANGE),
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(12),
  // Two circles: the whole flash, and the core inside it that stuns.
  indicator: { radius: FLASH_RADIUS, innerRadius: FLASH_CORE_RADIUS },
  apply: [thrown(flashbangOf(false), flashbangOf(true))],
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
export const STICK_RESET_TICKS = seconds(.5)
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
  windUpTicks: WINDUP_TICKS.default,
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
  description: 'Blinks you to your stick, even in the air, and refreshes the throw. With no stick out, it gives you the throw back instead.',
  targeting: 'none',
  range: 0,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(10),
  // A stick to go to, on the ground or still in the air, or else no stick anywhere and a throw to give back.
  requires: { entity: 'stick', out: true, orEntities: ['stick-shot'] },
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
      [
        when<SimContext>(
          (sim, src) => sim.entitiesOf(src.ownerId, 'stick-shot').length > 0,
          // A stick still in the air: to where it is now, catching it, so the throw is ready again as soon as it would be had he walked over it.
          [
            spawnEntity(warpFlashOut),
            blink(ownEntity('stick-shot')),
            spawnEntity(warpFlashIn, { at: ownEntity('stick-shot') }),
            removeEntities('stick-shot'),
            capCooldown('stick', STICK_RESET_TICKS),
          ],
          // Nothing to go to: the throw is ready again, all of it.
          [spawnEntity(warpFlashOut), refundCooldown('stick', 1)],
        ),
      ],
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
  windUpTicks: WINDUP_TICKS.default,
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
export const PLATING_SCALING_PER_LEVEL = .5

// Hammer's Slam: the hammer comes down on the ground in front of him, on a rectangle `SLAM_LENGTH` long from where he stands and as wide as the
// indicator. It leaves a mark on the ground for an instant, in the same rectangle.
const SLAM_LENGTH = 180
const SLAM_HALF_WIDTH = 30
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
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(7),
  indicator: { width: SLAM_HALF_WIDTH * 2 },
  apply: [
    damage(scaled(SLAM_DAMAGE, SLAM_SCALING), enemiesInLine(SLAM_LENGTH, SLAM_HALF_WIDTH)),
    slow(0.7, seconds(1), enemiesInLine(SLAM_LENGTH, SLAM_HALF_WIDTH)),
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
  const share = Math.min(1, distanceBetween(src.at, src.aim.point) / DROP_RANGE)
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
  windUpTicks: WINDUP_TICKS.default,
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

// Hammer's Rage: move speed, attack speed and lifesteal for `RAGE_TICKS`. Each of its effects is the one status of the name `RAGE_KEY` (see `haste`),
// and each auto he lands makes them last `RAGE_AUTO_TICKS` longer (`prolong`, in champions.ts), up to `RAGE_MAX_TICKS` left. The page draws what is left of it as
// a bar over him, full at `RAGE_MAX_TICKS` (the champion's `meter`). The lifesteal is the share of the damage he deals (autos and abilities) that comes back to him as health.
export const RAGE_KEY = 'rage'
export const RAGE_TICKS = seconds(5)
export const RAGE_AUTO_TICKS = seconds(0.4)
export const RAGE_MAX_TICKS = seconds(6)
export const RAGE_HASTE = 0.3
export const RAGE_ATTACK_SPEED = 0.5
export const RAGE_LIFESTEAL = 0.2
ability({
  id: 'rage',
  description: 'Move and attack faster and heal from the damage you deal. Your autos make it last longer.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(16),
  apply: [
    haste(RAGE_HASTE, RAGE_TICKS, self(), { named: RAGE_KEY }),
    statBuff('attackSpeed', RAGE_ATTACK_SPEED, RAGE_TICKS, self(), { named: RAGE_KEY }),
    lifesteal(RAGE_LIFESTEAL, RAGE_TICKS, self(), { named: RAGE_KEY }),
  ],
})

// ---------------------------------------------------------------------------- Chain

// Chain's first strike: the first auto he lands on an enemy, or the first hit the edge of Whirl makes on it, does bonus damage and heals him. The enemy then
// carries a `FIRST_STRIKE_KEY` marker, his own, for `FIRST_STRIKE_COOLDOWN_TICKS`, and he has no first strike on it until the marker is gone: so each enemy
// has a cooldown of its own, and another Chain's is separate (a marker is counted by its owner). A structure takes no markers, so it is never first-struck.
export const FIRST_STRIKE_KEY = 'chained'
export const FIRST_STRIKE_COOLDOWN_TICKS = seconds(10)
export const FIRST_STRIKE_DAMAGE = 30
export const FIRST_STRIKE_SCALING = { attackDamage: 0.5 } satisfies Scaling
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
const HOOK_RANGE = 230
const HOOK_SPEED = 820
export const HOOK_DAMAGE = 60
export const HOOK_SCALING = { attackDamage: 0.6 } satisfies Scaling
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
    stun(seconds(.3), subject()),
  ],
} satisfies EntityDef
ability({
  id: 'hook',
  description: 'Throws out a chain that drags the first enemy it hits to you.',
  targeting: 'direction',
  range: HOOK_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(12),
  indicator: { width: hook.radius * 2 },
  apply: [spawnEntity(hook)],
})

// Chain's Whirl: a charge-up and then one blow. For `WHIRL_CHARGE_TICKS` two circles, the core and the whole, are outlined round him (they do not fill in); when the
// charge is full the blow lands, with a flash, on whoever is inside them then, and not whoever was when it was started, so an enemy can get out. Whoever is wholly inside the
// core takes the plain hit; whoever reaches the ring outside it, the sweet spot, even by touching it, takes the bigger one and is slowed, and that is a first strike.
// The cast has no windup, so he can walk and cast while it charges, but he is disarmed for it and cannot attack. The circles are held exactly on him
// (`attached`), so they are centred on him as he walks, and what they hit is what is inside them, so it is where they are drawn. A charge that he does not live to
// finish, or that a stun breaks, does not go off.
const WHIRL_CHARGE_TICKS = seconds(.8)
export const WHIRL_CORE_RADIUS = 70
export const WHIRL_RADIUS = 120
export const WHIRL_DAMAGE = 35
export const WHIRL_SCALING = { attackDamage: 0.6 } satisfies Scaling
export const WHIRL_SWEET_DAMAGE = 70
export const WHIRL_SWEET_SCALING = { attackDamage: 1 } satisfies Scaling
export const WHIRL_SWEET_SLOW = 0.4
const WHIRL_SWEET_SLOW_TICKS = seconds(1.5)
// Whether a body is wholly inside the core, which is the only place the plain hit reaches. A body that reaches out of it at all, into the ring, is on the edge,
// and the edge is the better hit: so one that touches both circles is hit as the edge. (It is the body that counts, wherever its middle is.)
const insideWhirlCore = (sim: SimReader, src: EffectSource, unitId: number): boolean => {
  const unit = sim.character(unitId)
  const position = sim.posAt(unitId, src.tick)
  if (!unit || !position) return false
  return distanceBetween(src.at, position) + unit.champion.radius <= WHIRL_CORE_RADIUS
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
  stayWhile: (sim, src) => sim.isAlive(src.ownerId) && !sim.statusesOn(src.ownerId).some((status) => status.kind === 'stun' || status.kind === 'airborne'),
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
  cooldownTicks: seconds(11),
  apply: [
    // Disarmed through the last tick before the blow lands (a status is over on the tick it ends on, and the blow comes a tick after the charge is full).
    disarm(WHIRL_CHARGE_TICKS + 1, self()),
    spawnEntity(whirlCoreWarning),
    spawnEntity(whirlWarning),
  ],
})

// Chain's Lunge: a short dash to a point, anywhere from where he stands out to its range (it has no minimum), that quickens his attacks and readies his next auto at
// once. It has no windup, so it is cast while Whirl charges.
const LUNGE_RANGE = 120
const LUNGE_SPEED = 450
export const LUNGE_ATTACK_SPEED = 0.4
export const LUNGE_BUFF_TICKS = seconds(3)
ability({
  id: 'lunge',
  description: 'A short dash to the target point that speeds up your attacks and resets your auto. You can use it while Whirl charges.',
  targeting: 'point',
  range: LUNGE_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(9),
  movement: true,
  indicator: { line: true },
  apply: [
    dash(LUNGE_SPEED, LUNGE_RANGE),
    statBuff('attackSpeed', LUNGE_ATTACK_SPEED, LUNGE_BUFF_TICKS),
    resetAutoTimer(),
  ],
})

// ---------------------------------------------------------------------------- Cloak

// Cloak's fear. Stopping being invisible (the time running out, or an attack or an ability that is seen: see `ChampionDef.onLeaveInvisibility`) fears every enemy near
// him, and then, for as long as it lasts, his hits do `FEAR_BONUS` more to them (`ChampionDef.bonusAgainst`). Each enemy he fears also carries a `FEAR_KEY` marker, his own, for
// `FEAR_MEMORY_TICKS` (it is "lately", and outlasts the fear), which Cut Through reads and spends. A structure takes neither.
export const FEAR_KEY = 'feared'
export const FEAR_RADIUS = 80
export const FEAR_TICKS = seconds(1)
export const FEAR_MEMORY_TICKS = seconds(6)
export const FEAR_BONUS = 0.3
const fearableEnemies: Selector = (sim, src) =>
  enemiesInRadius(FEAR_RADIUS)(sim, src).filter((unitId) => sim.character(unitId)?.structure !== true)
export const terrify: readonly Effect[] = [
  fear(FEAR_TICKS, fearableEnemies),
  mark(FEAR_KEY, FEAR_MEMORY_TICKS, fearableEnemies),
]

// Cloak's Ghost: invisible for a couple of seconds, and faster. It is the one ability that does not make him seen: the others do, and so does an auto.
export const GHOST_TICKS = seconds(3)
export const GHOST_HASTE = 0.4
ability({
  id: 'ghost',
  name: 'Ghost',
  description: 'Turns you invisible and faster. When you are seen again, nearby enemies flee in fear.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(16),
  keepsInvisibility: true,
  apply: [
    invisible(GHOST_TICKS, self()),
    haste(GHOST_HASTE, GHOST_TICKS, self()),
  ],
})

// Cloak's Knives: a fan of five thrown a short way, which hurts each enemy in it once, however many of them reach it: the damage is done to everyone in the cone
// (`enemiesInCone`), and the knives are only seen flying out. The cone is `KNIVES_RANGE` long, and opens by twice `KNIVES_HALF_ANGLE`. The cone is aimed with the
// cosine and sine of that angle, and the knives with those of the turns they are fanned by, all written out as numbers so that every peer works from exactly the same.
export const KNIVES_RANGE = 200
export const KNIVES_HALF_ANGLE = Math.PI / 6
export const KNIVES_DAMAGE = 50
export const KNIVES_SCALING = { attackDamage: 0.55 } satisfies Scaling
export const KNIVES_CONE = { cos: 0.8660254037844387, sin: 0.5 }
const KNIVES_SPEED = 900
const KNIFE_TURNS = [
  { x: 0.8660254037844387, y: -0.5 },
  { x: 0.9659258262890683, y: -0.25881904510252074 },
  { x: 1, y: 0 },
  { x: 0.9659258262890683, y: 0.25881904510252074 },
  { x: 0.8660254037844387, y: 0.5 },
]
const knife = {
  id: 'knife',
  speed: KNIVES_SPEED,
  radius: 5,
  lifetimeTicks: Math.round(KNIVES_RANGE / KNIVES_SPEED * GAME_TPS),
  color: '#d8dde6',
} satisfies EntityDef
ability({
  id: 'knives',
  name: 'Knives',
  description: 'Throws a fan of knives a short way, hurting every enemy in it.',
  targeting: 'direction',
  range: KNIVES_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(6),
  indicator: { coneHalfAngle: KNIVES_HALF_ANGLE },
  apply: [
    damage(scaled(KNIVES_DAMAGE, KNIVES_SCALING), enemiesInCone(KNIVES_RANGE, KNIVES_CONE)),
    spawnEntity(knife, { spread: KNIFE_TURNS }),
  ],
})

// Cloak's Cut Through: a dash of a fixed length, `CUT_RANGE`, toward the enemy it is aimed at (which has to be within that range to be aimed at), hurting every enemy it touches
// on the way. It is the same length whichever enemy it is aimed at (see `towardTarget`): one that is nearer is gone through and overshot, by the difference, and one that is
// exactly that far is ended up on top of. Against one he has feared lately (its marker) it gives a share of itself back (`CUT_REFUND`), and spends the marker, so the same enemy
// does not give it back again until he has feared it again. It gives Knives back whenever it is cast.
export const CUT_RANGE = 180
export const CUT_REFUND = 0.9
export const CUT_DAMAGE = 40
export const CUT_SCALING = { attackDamage: 0.3 } satisfies Scaling
const CUT_SPEED = 700
const fearedLately = stacks(FEAR_KEY, subject())
const cutThrough: DashDef = {
  id: 'cutthrough',
  onHit: [
    damage(scaled(CUT_DAMAGE, CUT_SCALING)),
    when<SimContext>((sim, src) => fearedLately(sim, src) > 0, [refundCooldown('cutthrough', CUT_REFUND), popMarkers(FEAR_KEY)]),
  ],
}
ability({
  id: 'cutthrough',
  name: 'Cut Through',
  description: 'Dashes a set distance toward an enemy, hurting all on the way. Refunds itself against one you recently feared, and always refunds Knives.',
  targeting: 'unit',
  range: CUT_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(11),
  movement: true,
  apply: [
    dash(CUT_SPEED, Infinity, self(), { toward: towardTarget(CUT_RANGE), through: true, on: cutThrough }),
    refundCooldown('knives', 1),
  ],
})

// ---------------------------------------------------------------------------- Sage

// Sage's mend: Heal Pulse and Vine Bolt put a mend on each enemy they hit, one at the most on each, which lasts `SAGE_MARK_TICKS` (a hit renews it). An auto on an enemy that has
// one heals Sage and quickens her, and spends it. (The auto is in champions.ts, with the rest of her autos.) A structure takes no markers, so it is never mended.
export const SAGE_KEY = 'mended'
export const SAGE_MARK_TICKS = seconds(5)
export const SAGE_HEAL = 20
export const SAGE_HEAL_SCALING = { arcane: 0.3 } satisfies Scaling
export const SAGE_HASTE = 0.2
export const SAGE_HASTE_TICKS = seconds(1.5)
// The name of the one haste her autos keep renewing (see `haste`), so the autos after the first do not add another.
export const SAGE_HASTE_NAME = 'sage'
const mendEnemy: Effect = mark(SAGE_KEY, SAGE_MARK_TICKS, subject(), { cap: 1 })

// Sage's Heal Pulse: a ring that goes out from her. It heals every ally in it (herself too), and hurts, pushes away and mends every enemy in it.
export const PULSE_RADIUS = 190
export const PULSE_HEAL = 50
export const PULSE_HEAL_SCALING = { arcane: 0.4 } satisfies Scaling
export const PULSE_DAMAGE = 50
export const PULSE_DAMAGE_SCALING = { arcane: 0.5 } satisfies Scaling
const PULSE_KNOCKBACK = 120
const PULSE_KNOCKBACK_SPEED = 500
const pulseBurst: EntityDef = {
  id: 'pulse-burst',
  speed: 0,
  radius: PULSE_RADIUS,
  lifetimeTicks: 10,
  visual: 'flash',
  color: '#8ee6a0',
}
ability({
  id: 'pulse',
  name: 'Heal Pulse',
  description: 'A pulse that heals allies, and hurts and knocks back enemies.',
  targeting: 'none',
  range: 0,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(16),
  apply: [
    heal(scaled(PULSE_HEAL, PULSE_HEAL_SCALING), alliesInRadius(PULSE_RADIUS)),
    damage(scaled(PULSE_DAMAGE, PULSE_DAMAGE_SCALING), enemiesInRadius(PULSE_RADIUS)),
    mark(SAGE_KEY, SAGE_MARK_TICKS, enemiesInRadius(PULSE_RADIUS), { cap: 1 }),
    knockback(PULSE_KNOCKBACK, PULSE_KNOCKBACK_SPEED, enemiesInRadius(PULSE_RADIUS)),
    spawnEntity(pulseBurst),
  ],
})

// Sage's Vine Bolt: a bolt that goes through every enemy on its way, and hurts, roots and mends each.
const VINE_RANGE = 520
const VINE_SPEED = 550
export const VINE_DAMAGE = 50
export const VINE_SCALING = { arcane: 0.5 } satisfies Scaling
export const VINE_ROOT_TICKS = seconds(1)
const vineBolt = {
  id: 'vine-bolt',
  speed: VINE_SPEED,
  radius: 12,
  lifetimeTicks: Math.round(VINE_RANGE / VINE_SPEED * GAME_TPS),
  pierce: true,
  color: '#7bd88f',
  onHit: [damage(scaled(VINE_DAMAGE, VINE_SCALING)), root(VINE_ROOT_TICKS), mendEnemy],
} satisfies EntityDef
ability({
  id: 'vinebolt',
  name: 'Vine Bolt',
  description: 'A bolt that pierces enemies, hurting and rooting each one.',
  targeting: 'direction',
  range: VINE_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(11),
  indicator: { width: vineBolt.radius * 2 },
  apply: [spawnEntity(vineBolt)],
})

// Sage's Rejuvenate: heals a teammate, or herself, by a set amount and a share of the health they are missing.
export const REJUVENATE_HEAL = 60
export const REJUVENATE_SCALING = { arcane: 0.4 } satisfies Scaling
export const REJUVENATE_MISSING = 0.15
ability({
  id: 'rejuvenate',
  name: 'Rejuvenate',
  description: 'Heals a teammate or yourself. It heals more the more health they are missing.',
  targeting: 'unit',
  targetsAllies: true,
  range: 450,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(14),
  apply: [heal(linear(scaled(REJUVENATE_HEAL, REJUVENATE_SCALING), REJUVENATE_MISSING, missingHealth()), targetUnit())],
})

// ---------------------------------------------------------------------------- Monk

// Monk's passive: a share of every hit he takes is not taken (see `ChampionDef.damageReduction`), and each auto he makes takes this many ticks off every ability's cooldown.
export const MONK_DAMAGE_REDUCTION = 0.2
export const MONK_AUTO_REFUND_TICKS = seconds(1)

// Monk's Link: a bond to one teammate. It is a `LINK_KEY` marker on the teammate that is Monk's own, with no end, and a `link` entity on Monk that is only there to show the link is up (it
// puts the Q key on its recast, and is not drawn: the page draws the link as a beam between the two, from the marker). It lasts until it is cut: the cut takes the marker off, the teammate's
// death takes it with the rest of their markers, and Monk's death takes it off whoever has it (see `ChampionDef.damageLink`); the entity has no timer either, and goes with the link. While it is
// up, `LINK_SHARE` of every hit the teammate takes is Monk's to take. It reaches `LINK_BREAK_RANGE` and no farther: the tick the teammate is farther from Monk than that (body's middle to
// middle) the link is cut, as he would cut it himself (the entity sees to it, on its tick, since it is the one thing that is there for as long as the link is).
// It also breaks, and gives the same heal as Link Heal does, when his share of a hit would kill him: he does not take that share, the teammate takes the whole hit, and the link ends in the
// heal (the simulator sees to that, as the hit lands: see `ChampionDef.damageLink`).
//
// The key is cast on a unit while there is no link: on a teammate it links them, and on himself it heals him. With one up the key is Link Heal (`linkheal`, the recast), which heals the
// both of them (him and the linked teammate, each for the whole heal) and ends the link (the heal uses the link up), and starts Link's whole cooldown over. It is for the teammate he has linked and no one else: aimed at anyone else it does
// nothing, and is given back whole. Its own cooldown is Link's, since that is how long it is before the key can be used again.
export const LINK_KEY = 'linked'
export const LINK_COOLDOWN_TICKS = seconds(15)
export const LINK_SHARE = 0.4
// The heal and the shields grow with his arcane (see `scaled`), which is 10 at level 1 and grows by 4 a level: 2 for each point is about 8 more for each level he gains.
export const LINK_HEAL = 100
export const LINK_HEAL_SCALING = { arcane: .8 } satisfies Scaling
// How far apart the two can get before the link breaks. More than Link reaches to be cast (so a link made at the farthest is not broken the moment it is made), and about what two
// champions on one side of a fight are from one another and no more.
export const LINK_BREAK_RANGE = 500
const linkedAlly = markedUnits(LINK_KEY)
// Monk and whoever he has linked, for what he gives both.
const selfAndLinked: Selector = (sim, src) => [src.ownerId, ...linkedAlly(sim, src)]
const isLinked = (sim: SimReader, src: EffectSource): boolean => linkedAlly(sim, src).length > 0
const castOnSelf = (_sim: SimReader, src: EffectSource): boolean => src.aim?.mode === 'unit' && src.aim.unitId === src.ownerId
const linkHeal = scaled(LINK_HEAL, LINK_HEAL_SCALING)
const aimedAtLinked = (sim: SimReader, src: EffectSource): boolean =>
  src.aim?.mode === 'unit' && linkedAlly(sim, src).includes(src.aim.unitId)
// Whether the teammate he has linked is farther from him than the link reaches.
const linkStretched = (sim: SimReader, src: EffectSource): boolean => {
  const [linkedId] = linkedAlly(sim, src)
  if (linkedId === undefined) return false
  const from = sim.posAt(src.ownerId, src.tick)
  const to = sim.posAt(linkedId, src.tick)
  return from !== undefined && to !== undefined && distanceBetween(from, to) > LINK_BREAK_RANGE
}
// What cutting a link does, whether he cuts it or it breaks: the marker comes off, the entity ends, and Link starts its wait now, whatever was left of it while the link was up.
const cutLink: readonly Effect[] = [
  popMarkers(LINK_KEY, linkedAlly),
  removeEntities('link'),
  startCooldown('link'),
]
// How a link ends in a heal: Monk and the teammate are each given the heal (the whole of it, not shared out), then the link is cut. It is what Link Heal does, and it is what the link does
// when a share of a hit would kill Monk (`ChampionDef.damageLink`'s `onBreak`), so the one gives what the other does.
export const LINK_BREAK_EFFECTS: readonly Effect[] = [heal(linkHeal, selfAndLinked), ...cutLink]
const linkBond = {
  id: 'link',
  speed: 0,
  radius: 32,
  attached: true,
  visual: 'hidden',
  stayWhile: (sim, src) => sim.isAlive(src.ownerId) && isLinked(sim, src),
  onTick: [when<SimContext>(linkStretched, cutLink)],
} satisfies EntityDef
ability({
  id: 'link',
  name: 'Link',
  description: 'Links to a teammate and takes some of their damage, until they get too far away or it would kill you. Cast on yourself to heal.',
  targeting: 'unit',
  targetsAllies: true,
  range: 450,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: LINK_COOLDOWN_TICKS,
  // Only one link at a time. While it is up, this key is Link Heal instead.
  requires: { entity: 'link', out: false },
  recast: 'linkheal',
  apply: [
    when<SimContext>(
      castOnSelf,
      [heal(linkHeal, self())],
      [mark(LINK_KEY, Infinity, targetUnit(), { cap: 1 }), spawnEntity(linkBond, { onePerOwner: true })],
    ),
  ],
})
ability({
  id: 'linkheal',
  name: 'Link Heal',
  description: 'Heals you and your linked teammate and ends the link.',
  targeting: 'unit',
  targetsAllies: true,
  targetsLinked: true,
  range: 450,
  windUpTicks: 0,
  cooldownTicks: LINK_COOLDOWN_TICKS,
  requires: { entity: 'link', out: true },
  apply: [
    when<SimContext>(
      aimedAtLinked,
      // The heal goes first, to whoever is linked, and then the link is cut.
      LINK_BREAK_EFFECTS,
      // Anyone else, himself too: nothing to give, so nothing is spent.
      [refundCooldown('linkheal', 1)],
    ),
  ],
})

// Monk's Flurry: the next `FLURRY_AUTOS` autos of Monk, and of the teammate he has linked, are quicker and slow what they hit. The charges are markers that belong to whoever carries them
// (`mark`'s `bearer`), spent by their autos wherever they are made (see champions.ts), so the teammate can be any champion; the attack speed is one status of the one name, ended with the last.
export const FLURRY_KEY = 'flurry'
export const FLURRY_AUTOS = 3
// How long they last if the autos are not made.
export const FLURRY_TICKS = seconds(6)
export const FLURRY_ATTACK_SPEED = 0.5
export const FLURRY_SLOW = 0.3
export const FLURRY_SLOW_TICKS = seconds(1.5)
ability({
  id: 'flurry',
  name: 'Flurry',
  description: 'Resets your auto. Your next few autos are faster and slow their target, and your linked teammate gets them too.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(13),
  apply: [
    statBuff('attackSpeed', FLURRY_ATTACK_SPEED, FLURRY_TICKS, selfAndLinked, { named: FLURRY_KEY }),
    mark(FLURRY_KEY, FLURRY_TICKS, selfAndLinked, { count: FLURRY_AUTOS, cap: FLURRY_AUTOS, bearer: true }),
    // It has no windup, so it can be cast between autos, and the next one is ready at once: Monk's, and not the linked teammate's.
    resetAutoTimer(),
  ],
})

// Monk's Guard: a shield and a burst of speed for Monk and the teammate he has linked, or a bigger shield and a bigger burst for Monk alone if there is none.
export const GUARD_SHIELD = 100
export const GUARD_SHIELD_ALONE = 160
export const GUARD_SCALING = { arcane: 1 } satisfies Scaling
export const GUARD_TICKS = seconds(4)
// The move speed it gives (see `haste`): a share of each one's own, and more for Monk when he has no one to share it with.
export const GUARD_HASTE = 0.30
export const GUARD_HASTE_ALONE = 0.45
export const GUARD_HASTE_TICKS = seconds(2)
ability({
  id: 'guard',
  name: 'Guard',
  description: 'Shields you and your linked teammate and speeds you both up. With no link, you get more of both.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(14),
  apply: [
    when<SimContext>(
      isLinked,
      [
        shield(scaled(GUARD_SHIELD, GUARD_SCALING), GUARD_TICKS, selfAndLinked),
        haste(GUARD_HASTE, GUARD_HASTE_TICKS, selfAndLinked),
      ],
      [
        shield(scaled(GUARD_SHIELD_ALONE, GUARD_SCALING), GUARD_TICKS, self()),
        haste(GUARD_HASTE_ALONE, GUARD_HASTE_TICKS, self()),
      ],
    ),
  ],
})

// ---------------------------------------------------------------------------- Fire Mage

// Fire Mage's burn stacks: each of his abilities that hits an enemy puts stacks on it, up to `BURN_MAX_STACKS`, and lights it. The stacks are markers of his own that end together,
// `BURN_STACK_TICKS` after the last one (a new one renews them all), and the burn is one status of his own on the enemy (named for the stacks), renewed with them and worked out afresh
// each time from how many there will be: `BURN_DPS_PER_STACK` (and its scaling) a second for each. So the more stacks, the more it burns, and the burn ends with the stacks. His autos
// put none on. A structure takes neither.
export const BURN_STACK_KEY = 'ember'
export const BURN_MAX_STACKS = 3
export const BURN_STACK_TICKS = seconds(6)
export const BURN_DPS_PER_STACK = 10
export const BURN_SCALING = { arcane: 0.05 } satisfies Scaling
const burnStacksOnHit = stacks(BURN_STACK_KEY, subject())
// How many stacks the unit hit will carry once `count` more are put on it: the ones on it now are read before this tick's writes, so a hit that comes after another on the same
// tick does not see the other's.
const burnStacksAfter = (count: number) => (sim: SimReader, src: EffectSource): number => Math.min(BURN_MAX_STACKS, burnStacksOnHit(sim, src) + count)
const burnPerStack = scaled(BURN_DPS_PER_STACK, BURN_SCALING)
// Puts `count` stacks on the unit hit and lights it for as many as it will then carry. A tooltip tells it as what one stack burns for.
const ignite = (count: number): Effect => {
  const after = burnStacksAfter(count)
  const effects: readonly Effect[] = [
    mark(BURN_STACK_KEY, BURN_STACK_TICKS, subject(), { count, cap: BURN_MAX_STACKS }),
    burn((sim, src) => burnPerStack(sim, src) * after(sim, src), BURN_STACK_TICKS, subject(), { named: BURN_STACK_KEY }),
  ]
  return describedAs<Effect>((sim, src) => runEffects(effects, sim, src), 'burnPerStack', burnPerStack)
}

// Fire Mage's Fireball: a shot that blows up on the first enemy it hits. That enemy takes the shot's damage and a stack, and then the blast, which goes off where the shot was a moment
// later (its fuse is two ticks, so that the stack the shot put on is there to be counted) and hurts everyone caught in it and puts a stack on each. So the enemy hit straight on takes two
// stacks and one caught only by the blast takes one. While it flies the key is Detonate, which sets the blast off where the shot is and takes the shot away: with no shot before it, the
// blast is one stack for everyone, the enemy it would have hit too. (Not at once: for `FIREBALL_DETONATE_DELAY_TICKS` after the shot leaves the key does nothing, so that pressing it twice in a row does not set the shot off.) Every hit, the shot's and the blast's, slows what it hits, or stuns it instead if that brings it to full stacks. A shot
// that hits nothing and is not set off blows up at the end of its flight, the same way (or where it meets the edge of the arena, if that comes first).
export const FIREBALL_RANGE = 560
export const FIREBALL_SPEED = 750
// How long after the fireball leaves the key stays the fireball's, and Detonate cannot be cast: so that pressing the key twice in a row, or mashing it, does not set the shot off the moment it
// is thrown. It is put on Detonate as the shot goes (see the fireball's `apply`), for exactly this long whatever the Fire Mage's haste, since how fast a finger double-taps does not change with it.
// It is the tuning knob: longer is more room to press twice, and less of the flight in which the shot can be set off (a shot is out for `FIREBALL_RANGE / FIREBALL_SPEED` seconds).
export const FIREBALL_DETONATE_DELAY_TICKS = seconds(0.3)
export const FIREBALL_DAMAGE = 50
export const FIREBALL_SCALING = { arcane: 0.35 } satisfies Scaling
export const FIREBALL_BLAST_RADIUS = 85
export const FIREBALL_BLAST_DAMAGE = 55
export const FIREBALL_BLAST_SCALING = { arcane: 0.55 } satisfies Scaling
export const FIREBALL_SLOW = 0.35
export const FIREBALL_SLOW_TICKS = seconds(1.5)
export const FIREBALL_STUN_TICKS = seconds(1)
// What a hit of the fireball does to the enemy it hits, after its damage: `count` stacks, and a stun if that brings the enemy to full stacks (or it was there already), or else a slow.
const scorchAndStagger = (count: number): readonly Effect[] => [
  ignite(count),
  when<SimContext>(
    (sim, src) => burnStacksAfter(count)(sim, src) >= BURN_MAX_STACKS,
    [stun(FIREBALL_STUN_TICKS)],
    [slow(FIREBALL_SLOW, FIREBALL_SLOW_TICKS)],
  ),
]
// The blast itself is only a flash; its damage is dealt by the fuse as it runs out.
const fireballFlash: EntityDef = {
  id: 'fireball-flash',
  speed: 0,
  radius: FIREBALL_BLAST_RADIUS,
  lifetimeTicks: 12,
  visual: 'flash',
  color: '#ff7a2f',
}
// The blast's fuse, which is not drawn: it goes off as it runs out, on the second tick after it was lit (its lifetime is the shortest there is).
const fireballBlast: EntityDef = {
  id: 'fireball-blast',
  speed: 0,
  radius: FIREBALL_BLAST_RADIUS,
  lifetimeTicks: 1,
  visual: 'hidden',
  onExpire: [
    onEach(enemiesInRadius(FIREBALL_BLAST_RADIUS), [damage(scaled(FIREBALL_BLAST_DAMAGE, FIREBALL_BLAST_SCALING)), ...scorchAndStagger(1)]),
    spawnEntity(fireballFlash),
  ],
}
const fireball = {
  id: 'fireball',
  speed: FIREBALL_SPEED,
  radius: 14,
  lifetimeTicks: Math.round(FIREBALL_RANGE / FIREBALL_SPEED * GAME_TPS),
  stopsAtWalls: true,
  color: '#ff7a2f',
  // A shot that hits ends there, and one that is set off is taken away, so neither of them gets to the end of its flight: only one that does blows up as it ends.
  onHit: [damage(scaled(FIREBALL_DAMAGE, FIREBALL_SCALING)), ...scorchAndStagger(1), spawnEntity(fireballBlast)],
  onExpire: [spawnEntity(fireballBlast)],
} satisfies EntityDef
ability({
  id: 'fireball',
  name: 'Fireball',
  description: 'A fireball that explodes on the first enemy it hits, at the end of its path, or when you press again. Slows, or stuns at full burn stacks.',
  targeting: 'direction',
  range: FIREBALL_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(8),
  indicator: { width: fireball.radius * 2 },
  // While the fireball flies, this key sets it off instead, once `FIREBALL_DETONATE_DELAY_TICKS` have gone: until then the key does nothing, so a second press on the heels of the first
  // is not the shot going off the moment it leaves.
  recast: 'detonate',
  apply: [spawnEntity(fireball), startCooldown('detonate', self(), FIREBALL_DETONATE_DELAY_TICKS)],
})
ability({
  id: 'detonate',
  name: 'Detonate',
  description: 'Explodes your fireball where it is.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(0.25),
  requires: { entity: 'fireball', out: true },
  apply: [
    spawnEntity(fireballBlast, { at: ownEntity('fireball') }),
    removeEntities('fireball'),
  ],
})

// Fire Mage's Fire Tornado: a circle at a point, which a tornado bursts out of after a moment's warning. Every enemy inside then is thrown into the air (`knockUp`), hurt, and given a stack.
// It hits whoever is inside as the warning runs out, and not whoever was when it was laid, so it can be walked out of.
export const TORNADO_RANGE = 450
export const TORNADO_RADIUS = 80
export const TORNADO_DELAY_TICKS = seconds(0.8)
export const TORNADO_DAMAGE = 60
export const TORNADO_SCALING = { arcane: 0.6 } satisfies Scaling
export const TORNADO_KNOCKUP_TICKS = seconds(0.75)
// The tornado itself, for as long as it holds what it caught in the air; its damage is dealt by the warning as it runs out.
const tornadoFunnel: EntityDef = {
  id: 'firetornado-funnel',
  speed: 0,
  radius: TORNADO_RADIUS,
  lifetimeTicks: TORNADO_KNOCKUP_TICKS,
  visual: 'field',
  color: '#ff9a3c',
}
const tornadoWarning: EntityDef = {
  id: 'firetornado-warning',
  speed: 0,
  radius: TORNADO_RADIUS,
  lifetimeTicks: TORNADO_DELAY_TICKS,
  visual: 'telegraph',
  color: '#ff6b4a',
  onExpire: [
    onEach(enemiesInRadius(TORNADO_RADIUS), [damage(scaled(TORNADO_DAMAGE, TORNADO_SCALING)), knockUp(TORNADO_KNOCKUP_TICKS), ignite(1)]),
    spawnEntity(tornadoFunnel),
  ],
}
ability({
  id: 'firetornado',
  name: 'Fire Tornado',
  description: 'Marks a circle that erupts into a tornado after a short delay, knocking enemies up.',
  targeting: 'point',
  range: TORNADO_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(12),
  indicator: { radius: TORNADO_RADIUS },
  apply: [spawnEntity(tornadoWarning, { at: aimPoint() })],
})

// Fire Mage's Scorch: a wave of fire that runs out along the ground from him, through every enemy in its way, hurting each as it reaches it and putting a stack on it (one: the wave
// reaches each enemy once). Behind it the ground burns, a patch at a time as it goes (it lays one every `SCORCH_PATCH_EVERY_TICKS`, close enough that they overlap into one strip, and
// one where it starts). An enemy standing on the burning ground burns while it does and for a little after, with one burn for all the patches (named `SCORCH_BURN_NAME`), so it is not
// burnt twice where they overlap. The ground puts no stacks on.
export const SCORCH_RANGE = 480
const SCORCH_SPEED = 600
export const SCORCH_HALF_WIDTH = 35
export const SCORCH_DAMAGE = 70
export const SCORCH_SCALING = { arcane: 0.5 } satisfies Scaling
export const SCORCH_BURN = 20
export const SCORCH_BURN_SCALING = { arcane: 0.2 } satisfies Scaling
export const SCORCH_GROUND_TICKS = seconds(3)
// How long the ground's burn goes on after an enemy steps off it.
export const SCORCH_BURN_TICKS = seconds(1)
const SCORCH_BURN_NAME = 'scorch'
const SCORCH_PATCH_EVERY_TICKS = 5
const scorchGround: EntityDef = {
  id: 'scorch-ground',
  speed: 0,
  radius: SCORCH_HALF_WIDTH,
  lifetimeTicks: SCORCH_GROUND_TICKS,
  visual: 'field',
  color: '#ff7a2f',
  onTick: [burn(scaled(SCORCH_BURN, SCORCH_BURN_SCALING), SCORCH_BURN_TICKS, enemiesInRadius(SCORCH_HALF_WIDTH), { named: SCORCH_BURN_NAME })],
}
const scorchWave = {
  id: 'scorch-wave',
  speed: SCORCH_SPEED,
  box: { halfLength: 12, halfWidth: SCORCH_HALF_WIDTH },
  lifetimeTicks: Math.round(SCORCH_RANGE / SCORCH_SPEED * GAME_TPS),
  pierce: true,
  color: '#ff4f1f',
  onHit: [damage(scaled(SCORCH_DAMAGE, SCORCH_SCALING)), ignite(1)],
  pulseEveryTicks: SCORCH_PATCH_EVERY_TICKS,
  onPulse: [spawnEntity(scorchGround)],
} satisfies EntityDef
ability({
  id: 'scorch',
  name: 'Scorch',
  description: 'Sends a wave of fire along the ground that hurts the enemies it passes and leaves the ground burning.',
  targeting: 'direction',
  range: SCORCH_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(11),
  indicator: { width: SCORCH_HALF_WIDTH * 2 },
  apply: [spawnEntity(scorchWave), spawnEntity(scorchGround)],
})

// ---------------------------------------------------------------------------- Aurel

// Aurel's bleed: Rend makes what it hits bleed, which is damage over time (`bleed`) as one status of his own (named `BLEED_NAME`) that every Rend renews. A bleeding enemy is what the
// rest of his kit feeds on: Rend heals him more and speeds him up more against one, and Bloodrush reaches farther to one. A bleed counts whoever put it on.
const BLEED_NAME = 'rend'
export const BLEED_DPS = 4
export const BLEED_SCALING = { attackDamage: 0.04 } satisfies Scaling
// A little longer than Rend's cooldown, so the next Rend can find the bleed the last one left.
export const BLEED_TICKS = seconds(4)
// Aurel's autos keep his bleed going: one that lands on an enemy bleeding from him sets the bleed back to the whole of `BLEED_TICKS` from then, as long as Rend first made it last
// (its damage is left as it was). An enemy that is not bleeding from him is not made to: only Rend starts a bleed. (The effect is in his autos, in champions.ts.)
export const refreshBleed: Effect<SimContext> = prolong(BLEED_NAME, BLEED_TICKS, BLEED_TICKS, subject())

// Whether the unit a cast is aimed at is bleeding, as it stood before this tick's writes: so a Rend's own bleed does not count for itself.
const targetBleeding = (sim: SimReader, src: EffectSource): boolean =>
  src.aim?.mode === 'unit' && sim.statusesOn(src.aim.unitId).some((status) => status.kind === 'bleed')

// Aurel's passive (in champions.ts): his autos do up to `LOW_HEALTH_BONUS` more the less health he has (all of it at none, half of it at half his health).
export const LOW_HEALTH_BONUS = 0.4

// Aurel's Rend: a strike at an enemy close by (`REND_RANGE`), which hurts it, makes it bleed, heals him a set amount and gives him move speed for a moment. It does not reset his
// auto: the next one comes when it would have anyway. Against an enemy that was bleeding already it heals him a share of the health he is missing as well, and the
// speed is more (`REND_BLEEDING_HASTE` for `REND_HASTE`). Aimed at one farther off, he walks up to it and strikes once it is in reach, as for any ability aimed at an enemy.
export const REND_RANGE = 100
export const REND_DAMAGE = 50
export const REND_SCALING = { attackDamage: 0.8 } satisfies Scaling
export const REND_HEAL = 40
export const REND_HEAL_SCALING = { level: 6 } satisfies Scaling
export const REND_MISSING_HEAL = 0.12
export const REND_HASTE = 0.2
export const REND_BLEEDING_HASTE = 0.4
export const REND_HASTE_TICKS = seconds(1.5)
const rendHeal = scaled(REND_HEAL, REND_HEAL_SCALING)
ability({
  id: 'rend',
  name: 'Rend',
  description: 'Strikes a nearby enemy and makes it bleed, healing you and speeding you up. Heals and speeds you up more against a bleeding enemy.',
  targeting: 'unit',
  range: REND_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(3.5),
  apply: [
    damage(scaled(REND_DAMAGE, REND_SCALING), targetUnit()),
    when<SimContext>(
      targetBleeding,
      [heal(linear(rendHeal, REND_MISSING_HEAL, missingHealth(self())), self()), haste(REND_BLEEDING_HASTE, REND_HASTE_TICKS, self())],
      [heal(rendHeal, self()), haste(REND_HASTE, REND_HASTE_TICKS, self())],
    ),
    bleed(scaled(BLEED_DPS, BLEED_SCALING), BLEED_TICKS, targetUnit(), { named: BLEED_NAME }),
  ],
})

// Aurel's Transfusion: takes all crowd control off him (`cleanse`), and heals him a share of the health he has lost in the last `TRANSFUSION_WINDOW_TICKS`, which his frame remembers
// for him (`ChampionDef.healthMemoryTicks`). It is cast through crowd control (`unstoppable`), which is what it is for, and while it is ready the page shows on his health bar what it
// would heal.
export const TRANSFUSION_WINDOW_TICKS = seconds(3)
export const TRANSFUSION_SHARE = 0.4
ability({
  id: 'transfusion',
  name: 'Transfusion',
  description: 'Cleanses crowd control and heals you for part of the damage you just took.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(16),
  unstoppable: true,
  healthBarPreview: true,
  apply: [
    cleanse(self()),
    heal(linear(0, TRANSFUSION_SHARE, healthLost(TRANSFUSION_WINDOW_TICKS)), self()),
  ],
})

// Aurel's Bloodrush: a dash onto an enemy, which ends beside it, and hurts and slows it. It reaches farther to an enemy that is bleeding (`rangeAgainst`). Aimed at one out of reach, he
// walks up to it and dashes once it is in reach, as for any ability aimed at an enemy. The hit and the slow land on the enemy as he goes (so the slow is still on when he gets there), and
// on that enemy alone: not on whoever he passes on the way.
export const BLOODRUSH_RANGE = 240
export const BLOODRUSH_BLEEDING_RANGE = 400
const BLOODRUSH_SPEED = 1100
export const BLOODRUSH_DAMAGE = 60
export const BLOODRUSH_SCALING = { attackDamage: 0.6 } satisfies Scaling
export const BLOODRUSH_SLOW = 0.35
export const BLOODRUSH_SLOW_TICKS = seconds(2)
ability({
  id: 'bloodrush',
  name: 'Bloodrush',
  description: 'Dashes to an enemy, hurting and slowing it. Reaches farther to a bleeding enemy.',
  targeting: 'unit',
  range: BLOODRUSH_RANGE,
  rangeAgainst: { status: 'bleed', range: BLOODRUSH_BLEEDING_RANGE },
  windUpTicks: 0,
  cooldownTicks: seconds(11),
  movement: true,
  apply: [
    dash(BLOODRUSH_SPEED, Infinity, self(), { toward: besideTarget(), through: true }),
    damage(scaled(BLOODRUSH_DAMAGE, BLOODRUSH_SCALING), targetUnit()),
    slow(BLOODRUSH_SLOW, BLOODRUSH_SLOW_TICKS, targetUnit()),
  ],
})

// ---------------------------------------------------------------------------- Ent

// The Ent's passive: the first auto he lands on an enemy roots it. The enemy then carries an `ENT_ROOT_KEY` marker of his own for `ENT_ROOT_COOLDOWN_TICKS`, and his autos do not root
// it again until the marker is gone: so each enemy has a cooldown of its own (as each has for Chain's first strike), and another Ent's is separate. A structure takes no markers and no
// roots, so it is passed over. (The effect is in his autos, in champions.ts.)
export const ENT_ROOT_KEY = 'entangled'
export const ENT_ROOT_TICKS = seconds(1)
export const ENT_ROOT_COOLDOWN_TICKS = seconds(12)
const entangledLately = stacks(ENT_ROOT_KEY, subject())
export const entangle: Effect<SimContext> = when<SimContext>(
  (sim, src) => src.subject !== null && sim.character(src.subject)?.structure !== true && entangledLately(sim, src) === 0,
  [root(ENT_ROOT_TICKS), mark(ENT_ROOT_KEY, ENT_ROOT_COOLDOWN_TICKS, subject())],
)

// The Ent's spore: Spore plants it on the enemy it strikes, a damage over time (`spore`) that is one status of his on that enemy (named `SPORE_NAME`), so a new one takes the old one's place,
// for `SPORE_TICKS`. While it lasts it heals him a little on every pulse (`SPORE_HEAL_PER_SECOND`, small next to a burst). When one of his abilities (Root Burst, Grove or Spore) hits an
// enemy that carries his spore, the spore **bursts**: the enemy takes bonus damage, he is healed a good deal, and the spore is gone (from the next tick). Spore plants a fresh one after it
// bursts the old, so it is ready to burst again. It also bursts if the enemy carrying it dies (he is healed as by a burst, worked out when it was planted), unless it was planted or burst
// on that same tick. A spore that runs out of time does not burst: it is just gone.
const SPORE_NAME = 'spore'
export const SPORE_TICKS = seconds(5)
export const SPORE_DPS = 10
export const SPORE_DPS_SCALING = { arcane: 0.10 } satisfies Scaling
export const SPORE_HEAL_PER_SECOND = 4
export const SPORE_HEAL_PER_SECOND_SCALING = { arcane: 0.04 } satisfies Scaling
export const SPORE_POP_DAMAGE = 70
export const SPORE_POP_SCALING = { arcane: 0.5 } satisfies Scaling
export const SPORE_POP_HEAL = 70
export const SPORE_POP_HEAL_SCALING = { arcane: 0.4, maxHealth: 0.02 } satisfies Scaling
// The spore of his on the unit hit, if it carries one, as it stood before this tick's writes.
const sporeOnSubject = (sim: SimReader, src: EffectSource) =>
  src.subject === null ? undefined : sim.statusesOn(src.subject).find((status) => status.kind === 'spore' && status.ownerId === src.ownerId)
// Takes his spore off the unit hit: it is over from the next tick. It has burst, so it has nothing left to burst with if the unit dies on this tick.
const endSpore: Effect<SimContext> = (sim, src) => {
  const planted = sporeOnSubject(sim, src)
  if (!planted || src.subject === null) return
  const { deathHeal: _spent, ...burst } = planted
  sim.addStatus(src.subject, { ...burst, endTick: Math.min(planted.endTick, src.tick + 1) })
}
// Run for each enemy one of his abilities hits, as the subject.
const burstSpore: Effect<SimContext> = when<SimContext>(
  (sim, src) => sporeOnSubject(sim, src) !== undefined,
  [damage(scaled(SPORE_POP_DAMAGE, SPORE_POP_SCALING)), heal(scaled(SPORE_POP_HEAL, SPORE_POP_HEAL_SCALING), self()), endSpore],
)

// The Ent's Root Burst: a small circle at a point, out of which roots burst up after a moment's warning, hurting and greatly slowing every enemy in it then (and bursting its spore).
// It hits whoever is inside as the warning runs out, so it can be stepped out of, but the warning is short.
export const ROOTBURST_RANGE = 450
export const ROOTBURST_RADIUS = 50
export const ROOTBURST_DELAY_TICKS = seconds(0.35)
export const ROOTBURST_DAMAGE = 70
export const ROOTBURST_SCALING = { arcane: 0.6 } satisfies Scaling
export const ROOTBURST_SLOW = 0.6
export const ROOTBURST_SLOW_TICKS = seconds(1.5)
const rootburstRoots: EntityDef = {
  id: 'rootburst-roots',
  speed: 0,
  radius: ROOTBURST_RADIUS,
  lifetimeTicks: 18,
  visual: 'flash',
  color: '#8b5a2b',
}
const rootburstWarning: EntityDef = {
  id: 'rootburst-warning',
  speed: 0,
  radius: ROOTBURST_RADIUS,
  lifetimeTicks: ROOTBURST_DELAY_TICKS,
  visual: 'telegraph',
  color: '#a3c45a',
  onExpire: [
    onEach(enemiesInRadius(ROOTBURST_RADIUS), [
      damage(scaled(ROOTBURST_DAMAGE, ROOTBURST_SCALING)),
      slow(ROOTBURST_SLOW, ROOTBURST_SLOW_TICKS),
      burstSpore,
    ]),
    spawnEntity(rootburstRoots),
  ],
}
ability({
  id: 'rootburst',
  name: 'Root Burst',
  description: 'Roots burst up from a small circle after a moment, hurting enemies and slowing them a lot.',
  targeting: 'point',
  range: ROOTBURST_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(7),
  indicator: { radius: ROOTBURST_RADIUS },
  apply: [spawnEntity(rootburstWarning, { at: aimPoint() })],
})

// The Ent's Grove: a large circle at a point, which a grove grows out of after a long warning. Every ally in it then (him too) is healed, and every enemy in it is hurt and rooted (and has
// its spore burst). Like Root Burst it hits whoever is inside as the warning runs out, and the warning is long, so it is for where a fight will be and not for where an enemy is.
export const GROVE_RANGE = 500
export const GROVE_RADIUS = 120
export const GROVE_DELAY_TICKS = seconds(2.0)
export const GROVE_HEAL = 60
export const GROVE_HEAL_SCALING = { arcane: 0.5 } satisfies Scaling
export const GROVE_DAMAGE = 80
export const GROVE_SCALING = { arcane: 0.6 } satisfies Scaling
export const GROVE_ROOT_TICKS = seconds(1.25)
// The grove itself, for a moment once it has grown; what it does is done by the warning as it runs out.
const grove: EntityDef = {
  id: 'grove',
  speed: 0,
  radius: GROVE_RADIUS,
  lifetimeTicks: seconds(1),
  visual: 'field',
  color: '#3e8e41',
}
const groveWarning: EntityDef = {
  id: 'grove-warning',
  speed: 0,
  radius: GROVE_RADIUS,
  lifetimeTicks: GROVE_DELAY_TICKS,
  visual: 'telegraph',
  color: '#6fcf6f',
  onExpire: [
    heal(scaled(GROVE_HEAL, GROVE_HEAL_SCALING), alliesInRadius(GROVE_RADIUS)),
    onEach(enemiesInRadius(GROVE_RADIUS), [
      damage(scaled(GROVE_DAMAGE, GROVE_SCALING)),
      root(GROVE_ROOT_TICKS),
      burstSpore,
    ]),
    spawnEntity(grove),
  ],
}
ability({
  id: 'grove',
  name: 'Grove',
  description: 'Marks a large circle that grows into a grove after a delay, healing allies and hurting and rooting enemies.',
  targeting: 'point',
  range: GROVE_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(15),
  indicator: { radius: GROVE_RADIUS },
  apply: [spawnEntity(groveWarning, { at: aimPoint() })],
})

// The Ent's Spore: a strike at an enemy close by (`SPORE_RANGE`), which hurts it, bursts the spore it carries if it has one, and plants a fresh one. Aimed at one farther off, he walks up
// to it and strikes once it is in reach, as for any ability aimed at an enemy.
export const SPORE_RANGE = 110
export const SPORE_DAMAGE = 50
export const SPORE_SCALING = { arcane: 0.5 } satisfies Scaling
ability({
  id: 'spore',
  name: 'Spore',
  description: 'Strikes a nearby enemy and plants a spore that drains it to heal you. Hitting it with an ability, or the enemy dying, bursts it for a big heal.',
  targeting: 'unit',
  range: SPORE_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  // A little shorter than a spore lasts, so the next Spore can burst the one the last planted.
  cooldownTicks: seconds(4.5),
  apply: [
    damage(scaled(SPORE_DAMAGE, SPORE_SCALING), targetUnit()),
    // The old spore bursts before the new one is planted: both are the same status, and the new one, written after, is the one that stays.
    onEach(targetUnit(), [burstSpore]),
    spore(scaled(SPORE_DPS, SPORE_DPS_SCALING), SPORE_TICKS, targetUnit(), {
      named: SPORE_NAME,
      ownerHealPerSecond: scaled(SPORE_HEAL_PER_SECOND, SPORE_HEAL_PER_SECOND_SCALING),
      ownerHealOnDeath: scaled(SPORE_POP_HEAL, SPORE_POP_HEAL_SCALING),
    }),
  ],
})

// ---------------------------------------------------------------------------- Hellhound

// The Hellhound's passive: each auto makes what it hits bleed (one bleed of his, named `HOUND_BLEED_NAME`, for `HOUND_BLEED_TICKS`, renewed by every hit), and marks it
// as bleeding (a `HOUND_BLEED_KEY` marker of his, one at most, as long). It is bleeding or it is not: there are no stacks. His autos hit a bleeding enemy harder
// (`HOUND_BLEEDING_BONUS` of his attack damage more), and each hit on one speeds him after it for a moment (`HOUND_HASTE`). A bleeding enemy leaves a trail of blood
// where it is hit. Pounce makes it bleed as an auto does. (The autos are in champions.ts.)
export const HOUND_BLEED_KEY = 'hound-bleed'
const HOUND_BLEED_NAME = 'hound-bleed'
export const HOUND_BLEED_TICKS = seconds(4)
export const HOUND_BLEED_DPS = 14
export const HOUND_BLEEDING_BONUS = 0.2
export const HOUND_HASTE = 0.18
const HOUND_HASTE_TICKS = seconds(1)
// Whether the subject carries his bleeding mark, as it stood before this tick's writes.
const houndBleedingOn = (sim: SimReader, src: EffectSource): boolean => stacks(HOUND_BLEED_KEY, subject())(sim, src) > 0
// Where the subject stands, for something laid on it (a mark of a hit, which is only to be seen and heard).
const atSubject: Anchor = (sim, src) => (src.subject === null ? undefined : sim.posAt(src.subject, src.tick))
// Runs `effects` with an id of their own for the subject, so what they spawn on one unit is not taken for what they spawn on another (a bolt through a crowd).
const perSubject = (effects: readonly Effect<SimContext>[]): Effect<SimContext> => (sim, src) => {
  if (src.subject === null) return
  runEffects(effects, sim, { ...src, id: `${src.id}:s${src.subject}` })
}
// Runs `effects` aimed at the subject, as an ability aimed at it would be (for a homing shot that is to chase it).
const aimedAt = (effects: readonly Effect<SimContext>[]): Effect<SimContext> => (sim, src) => {
  if (src.subject !== null) runEffects(effects, sim, { ...src, aim: { mode: 'unit', unitId: src.subject } })
}
// A mark that something struck, laid where the subject stands: only to be seen and heard (each has a look and a sound of its own on the page).
const hitMark = (id: string, radius: number, color: string, ticks = 14): Effect<SimContext> =>
  perSubject([spawnEntity({ id, speed: 0, radius, lifetimeTicks: ticks, visual: 'flash', color }, { at: atSubject })])
const bloodTrail: EntityDef = { id: 'blood-trail', speed: 0, radius: 16, lifetimeTicks: seconds(2), visual: 'field', color: '#7a0f1c' }
// The passive on the subject: it bleeds (or bleeds on), is marked as bleeding, he runs after it if it was bleeding already, and it leaves blood.
export const houndBleedStack: readonly Effect<SimContext>[] = [
  when<SimContext>(houndBleedingOn, [haste(HOUND_HASTE, HOUND_HASTE_TICKS, self(), { named: 'hound-chase' })]),
  mark(HOUND_BLEED_KEY, HOUND_BLEED_TICKS, subject(), { cap: 1 }),
  bleed(HOUND_BLEED_DPS, HOUND_BLEED_TICKS, subject(), { named: HOUND_BLEED_NAME }),
  spawnEntity(bloodTrail, { at: (sim, src) => (src.subject === null ? undefined : sim.posAt(src.subject, src.tick)) }),
]
// His auto's damage: his attack damage, and more against one that is bleeding.
export const houndAutoDamage = (sim: SimReader, src: EffectSource): number =>
  attackDamage()(sim, src) * (houndBleedingOn(sim, src) ? 1 + HOUND_BLEEDING_BONUS : 1)

// Whether the subject is bleeding (from anyone), as it stood before this tick's writes.
const subjectBleeding = (sim: SimReader, src: EffectSource): boolean =>
  src.subject !== null && sim.statusesOn(src.subject).some((status) => status.kind === 'bleed')

// The Hellhound's Rake: three slashes of his claws, one cast at a time. The first goes the way it is aimed and stops on the first enemy it reaches. Against one that was not
// bleeding it makes it bleed and gives him one more slash; against one that was bleeding already, two more. Each further slash is a recast of the key, which has to be used
// within `RAKE_WINDOW_TICKS`, and has to hit to give the next: a miss ends the string. The third, which only comes of hitting with the first two, hurts more and roots.
export const RAKE_RANGE = 260
export const RAKE_DAMAGE = 35
export const RAKE_SCALING = { attackDamage: 0.5 } satisfies Scaling
export const RAKE_FINAL_DAMAGE = 60
export const RAKE_FINAL_SCALING = { attackDamage: 0.6 } satisfies Scaling
export const RAKE_ROOT_TICKS = seconds(1)
export const RAKE_WINDOW_TICKS = seconds(3)
// How long after one slash the next can be begun.
export const RAKE_GAP_TICKS = seconds(1)
const RAKE_SPEED = 950
const RAKE_LEFT_KEY = 'rake-left'
const RAKE_FINAL_KEY = 'rake-final'
const rakeWindow: EntityDef = { id: 'rake-window', speed: 0, radius: 1, attached: true, visual: 'hidden', lifetimeTicks: RAKE_WINDOW_TICKS }
const openRakeWindow = spawnEntity(rakeWindow, { onePerOwner: true })
const rakeLeft = stacks(RAKE_LEFT_KEY, self())
// What each slash leaves on what it strikes, to be seen and heard: a plain slash, a slash into a bleeding wound, and the third, which roots.
const rakeHit = hitMark('rake-hit', 34, '#e05a3a')
const rakeHitBleeding = hitMark('rake-hit-bleed', 38, '#b3121f')
const rakeHitFinal = hitMark('rake-final-hit', 48, '#ff3a1a', 20)
const rakeMark = when<SimContext>(subjectBleeding, [rakeHitBleeding], [rakeHit])
const rakeShot = (id: string, onHit: readonly Effect<SimContext>[]): EntityDef => ({
  id,
  speed: RAKE_SPEED,
  box: { halfLength: 12, halfWidth: 30 },
  lifetimeTicks: Math.round(RAKE_RANGE / RAKE_SPEED * GAME_TPS),
  color: '#c4302b',
  onHit,
})
ability({
  id: 'rake',
  name: 'Rake',
  icon: 'rend',
  description: 'Slashes in a direction. A hit gives another slash, or two against a bleeding enemy. The third hurts more and roots.',
  targeting: 'direction',
  range: RAKE_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(9),
  indicator: { width: 60 },
  recast: 'rakeagain',
  apply: [
    startCooldown('rakeagain', self(), RAKE_GAP_TICKS),
    popMarkers(RAKE_LEFT_KEY, self()),
    popMarkers(RAKE_FINAL_KEY, self()),
    spawnEntity(rakeShot('rake-shot', [
      rakeMark,
      damage(scaled(RAKE_DAMAGE, RAKE_SCALING)),
      openRakeWindow,
      when<SimContext>(
        subjectBleeding,
        [mark(RAKE_LEFT_KEY, RAKE_WINDOW_TICKS, self(), { count: 2, cap: 2 })],
        [mark(RAKE_LEFT_KEY, RAKE_WINDOW_TICKS, self(), { count: 1, cap: 2 }), ...houndBleedStack],
      ),
    ])),
  ],
})
ability({
  id: 'rakeagain',
  name: 'Rake',
  icon: 'rend',
  description: 'The next slash of Rake.',
  targeting: 'direction',
  range: RAKE_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: RAKE_GAP_TICKS,
  indicator: { width: 60 },
  requires: { entity: 'rake-window', out: true },
  apply: [
    removeEntities('rake-window'),
    spawnEntity(rakeShot('rake-again-shot', [
      when<SimContext>(
        (sim, src) => stacks(RAKE_FINAL_KEY, self())(sim, src) > 0,
        // The third, after two hits: harder, and it roots.
        [
          rakeHitFinal,
          damage(linear(scaled(RAKE_DAMAGE, RAKE_SCALING), 1, scaled(RAKE_FINAL_DAMAGE, RAKE_FINAL_SCALING))),
          root(RAKE_ROOT_TICKS),
          popMarkers(RAKE_FINAL_KEY, self()),
          popMarkers(RAKE_LEFT_KEY, self()),
        ],
        [
          rakeMark,
          damage(scaled(RAKE_DAMAGE, RAKE_SCALING)),
          // Two slashes were to come: this was the second, and the third is now the last.
          when<SimContext>(
            (sim, src) => rakeLeft(sim, src) >= 2,
            [popMarkers(RAKE_LEFT_KEY, self(), { count: 1 }), mark(RAKE_FINAL_KEY, RAKE_WINDOW_TICKS, self(), { cap: 1 }), openRakeWindow],
            [popMarkers(RAKE_LEFT_KEY, self())],
          ),
        ],
      ),
    ])),
  ],
})

// The Hellhound's Howl: a cone ahead of him that silences and slows every enemy in it.
export const HOWL_RANGE = 260
// Half the angle it opens by, and its cosine and sine, written out (see `enemiesInCone`).
export const HOWL_HALF_ANGLE = 0.6
const HOWL_CONE = { cos: 0.8253356149096783, sin: 0.5646424733950354 }
export const HOWL_SILENCE_TICKS = seconds(1.25)
export const HOWL_SLOW = 0.4
export const HOWL_SLOW_TICKS = seconds(1.5)
ability({
  id: 'howl',
  name: 'Howl',
  icon: 'rage',
  description: 'Howls in a cone, silencing and slowing enemies.',
  targeting: 'direction',
  range: HOWL_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(13),
  indicator: { coneHalfAngle: HOWL_HALF_ANGLE },
  apply: [
    // Only to be seen: the howl rolling out over the cone, from its middle, pointing the way it goes.
    spawnEntity({ id: 'howl-wave', speed: 0, box: { halfLength: HOWL_RANGE / 2, halfWidth: HOWL_RANGE * HOWL_CONE.sin }, lifetimeTicks: 24, visual: 'hidden', color: '#ff5a1a' }, { at: alongAim(HOWL_RANGE / 2) }),
    silence(HOWL_SILENCE_TICKS, enemiesInCone(HOWL_RANGE, HOWL_CONE)),
    slow(HOWL_SLOW, HOWL_SLOW_TICKS, enemiesInCone(HOWL_RANGE, HOWL_CONE)),
  ],
})

// The Hellhound's Pounce: a leap to a point, through whoever is in the way, and each enemy he lands on as he goes is hurt, slowed and made to bleed.
export const POUNCE_RANGE = 280
const POUNCE_SPEED = 1000
export const POUNCE_DAMAGE = 45
export const POUNCE_SCALING = { attackDamage: 0.5 } satisfies Scaling
export const POUNCE_SLOW = 0.35
export const POUNCE_SLOW_TICKS = seconds(1.5)
const pounceDash: DashDef = {
  id: 'pounce',
  onHit: [damage(scaled(POUNCE_DAMAGE, POUNCE_SCALING)), slow(POUNCE_SLOW, POUNCE_SLOW_TICKS), ...houndBleedStack],
}
ability({
  id: 'pounce',
  name: 'Pounce',
  icon: 'leap',
  description: 'Leaps to a point, hurting, slowing and making bleed the enemies you land on.',
  targeting: 'point',
  range: POUNCE_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(10),
  movement: true,
  indicator: { line: true },
  apply: [dash(POUNCE_SPEED, POUNCE_RANGE, self(), { through: true, on: pounceDash })],
})

// ---------------------------------------------------------------------------- Stone

// Stone's passive: whenever he puts crowd control on an enemy (a knock back, a slow, a root), he gains a small shield (`STONE_SHIELD`, more each level), once for each
// ability that does it. It is in each of his abilities below.
export const STONE_SHIELD = 30
export const STONE_SHIELD_SCALING = { level: 8 } satisfies Scaling
export const STONE_SHIELD_TICKS = seconds(2.5)
const stoneGuard = shield(scaled(STONE_SHIELD, STONE_SHIELD_SCALING), STONE_SHIELD_TICKS, self(), { shared: 'stone-guard' })

// Stone's Shove: resets his auto, and readies the next one to knock its target away from him and hurt it more.
export const SHOVE_DAMAGE = 35
export const SHOVE_SCALING = { attackDamage: 0.6 } satisfies Scaling
export const SHOVE_DISTANCE = 170
ability({
  id: 'shove',
  name: 'Shove',
  icon: 'slam',
  description: 'Your next auto comes at once, hurts more and knocks the enemy away.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(7),
  empowerAttack: { ticks: seconds(5), effects: [damage(scaled(SHOVE_DAMAGE, SHOVE_SCALING)), knockback(SHOVE_DISTANCE, 700), stoneGuard] },
  apply: [resetAutoTimer()],
})

// Stone's Rampart: a dash to a teammate, and everyone near them is slowed and the two of them are shielded. Cast on himself (Alt), it is the slow round him and his own shield.
export const RAMPART_RANGE = 420
const RAMPART_SPEED = 1100
export const RAMPART_RADIUS = 200
export const RAMPART_SLOW = 0.35
export const RAMPART_SLOW_TICKS = seconds(1.5)
export const RAMPART_SHIELD = 70
export const RAMPART_SHIELD_SCALING = { level: 10 } satisfies Scaling
export const RAMPART_SHIELD_TICKS = seconds(3)
const castOnHimself = (_sim: SimReader, src: EffectSource): boolean => src.aim?.mode === 'unit' && src.aim.unitId === src.ownerId
// Where the teammate it is aimed at stands.
const atTarget: Anchor = (sim, src) => (src.aim?.mode === 'unit' ? sim.posAt(src.aim.unitId, src.tick) : undefined)
const enemiesRoundTarget = enemiesInRadius(RAMPART_RADIUS, (sim, src) => atTarget(sim, src) ?? { ...src.at })
ability({
  id: 'rampart',
  name: 'Rampart',
  icon: 'guard',
  description: 'Dashes to a teammate, slowing enemies near them and shielding you both. Cast on yourself for the slow and the shield.',
  targeting: 'unit',
  targetsAllies: true,
  range: RAMPART_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(13),
  movement: true,
  apply: [
    when<SimContext>(castOnHimself, [], [dash(RAMPART_SPEED, Infinity, self(), { toward: besideTarget(), through: true })]),
    slow(RAMPART_SLOW, RAMPART_SLOW_TICKS, enemiesRoundTarget),
    shield(scaled(RAMPART_SHIELD, RAMPART_SHIELD_SCALING), RAMPART_SHIELD_TICKS, self()),
    when<SimContext>(castOnHimself, [], [shield(scaled(RAMPART_SHIELD, RAMPART_SHIELD_SCALING), RAMPART_SHIELD_TICKS, targetUnit())]),
    when<SimContext>((sim, src) => enemiesRoundTarget(sim, src).length > 0, [stoneGuard]),
  ],
})

// Stone's Tether: a line thrown straight ahead that stops on the first enemy it reaches, roots it for a moment, and pulls him through to stand just behind it.
export const TETHER_RANGE = 460
const TETHER_SPEED = 1300
export const TETHER_DAMAGE = 30
export const TETHER_SCALING = { attackDamage: 0.4 } satisfies Scaling
export const TETHER_ROOT_TICKS = seconds(0.75)
const TETHER_DASH_SPEED = 1500
// The point just behind the subject, on the far side from him, with room for both bodies.
const behindSubject = (gap: number): Anchor => (sim, src) => {
  if (src.subject === null) return undefined
  const from = sim.posAt(src.ownerId, src.tick)
  const at = sim.posAt(src.subject, src.tick)
  if (!from || !at) return undefined
  const dx = at.x - from.x
  const dy = at.y - from.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return { ...at }
  const reach = (sim.character(src.ownerId)?.champion.radius ?? 0) + (sim.character(src.subject)?.champion.radius ?? 0) + gap
  return { x: at.x + dx / length * reach, y: at.y + dy / length * reach }
}
ability({
  id: 'tether',
  name: 'Tether',
  icon: 'hook',
  description: 'Throws a line ahead. The first enemy it hits is rooted, and you dash to just behind it.',
  targeting: 'direction',
  range: TETHER_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(12),
  indicator: { width: 24 },
  apply: [
    spawnEntity({
      id: 'tether-shot',
      speed: TETHER_SPEED,
      radius: 12,
      lifetimeTicks: Math.round(TETHER_RANGE / TETHER_SPEED * GAME_TPS),
      color: '#9a8f7a',
      onHit: [
        damage(scaled(TETHER_DAMAGE, TETHER_SCALING)),
        root(TETHER_ROOT_TICKS),
        dash(TETHER_DASH_SPEED, Infinity, self(), { toward: behindSubject(8), through: true }),
        stoneGuard,
      ],
    }),
  ],
})

// ---------------------------------------------------------------------------- Vulture

// The Vulture's passive: Spider Mine and Carrion Strike mark what they hit with carrion (a `CARRION_KEY` marker of his, one at most, for `CARRION_TICKS`), and each of
// his abilities does more to a marked enemy, spending the mark: a mine stuns, a strike roots, and a swoop reaches farther and slows.
export const CARRION_KEY = 'carrion'
export const CARRION_TICKS = seconds(8)
const carrionOn = (sim: SimReader, src: EffectSource): boolean => stacks(CARRION_KEY, subject())(sim, src) > 0
const markCarrion = mark(CARRION_KEY, CARRION_TICKS, subject(), { cap: 1 })
const spendCarrion = popMarkers(CARRION_KEY, subject())

// The Vulture's Spider Mine: laid at a point near him, after a long windup (`WINDUP_TICKS.placing`), which gives an enemy where it is aimed the time to step away. For `MINE_SHOWN_TICKS` it can be seen by
// everyone; then it burrows, and only his own team sees it, until an enemy walks onto it (or `MINE_TICKS` pass). Then the spider in it springs out and runs the enemy down,
// for `MINE_CHASE_TICKS` at most: on reaching it, it hurts it, and stuns it if it carried carrion (which is spent), or else slows and marks it. Whatever it reaches is
// revealed to his team for `MINE_REVEAL_TICKS`, and they see round it as long.
export const MINE_RANGE = 170
export const MINE_TICKS = seconds(40)
export const MINE_SHOWN_TICKS = seconds(1)
export const MINE_TRIGGER_RADIUS = 60
export const MINE_CHASE_SPEED = 520
export const MINE_CHASE_TICKS = seconds(2.5)
export const MINE_REVEAL_TICKS = seconds(3)
export const MINE_SIGHT = 260
export const MINE_DAMAGE = 55
export const MINE_SCALING = { attackDamage: 0.5 } satisfies Scaling
export const MINE_STUN_TICKS = seconds(1.2)
export const MINE_SLOW = 0.4
export const MINE_SLOW_TICKS = seconds(2)
const mineSight: EntityDef = { id: 'mine-sight', speed: 0, radius: 1, lifetimeTicks: MINE_REVEAL_TICKS, visual: 'hidden', sight: MINE_SIGHT }
const mineSpider: EntityDef = {
  id: 'mine-spider',
  speed: MINE_CHASE_SPEED,
  radius: 8,
  homing: true,
  lifetimeTicks: MINE_CHASE_TICKS,
  color: '#a6ff4d',
  onHit: [
    damage(scaled(MINE_DAMAGE, MINE_SCALING)),
    when<SimContext>(carrionOn, [stun(MINE_STUN_TICKS), spendCarrion], [slow(MINE_SLOW, MINE_SLOW_TICKS), markCarrion]),
    mark(REVEAL_KEY, MINE_REVEAL_TICKS, subject(), { cap: 1 }),
    spawnEntity(mineSight, { at: atSubject }),
    hitMark('mine-bite', 40, '#a6ff4d', 16),
  ],
}
ability({
  id: 'spidermine',
  name: 'Spider Mine',
  icon: 'snare',
  description: 'Lays a mine that hides after a moment. When an enemy steps on it, a spider jumps out and chases them. It stuns a marked enemy, or slows and marks one.',
  targeting: 'point',
  range: MINE_RANGE,
  windUpTicks: WINDUP_TICKS.placing,
  cooldownTicks: seconds(9),
  indicator: { radius: MINE_TRIGGER_RADIUS },
  apply: [
    spawnEntity({
      id: 'spider-mine',
      speed: 0,
      radius: MINE_TRIGGER_RADIUS,
      lifetimeTicks: MINE_TICKS,
      visual: 'field',
      color: '#5f8f2e',
      ownTeamOnly: { afterTicks: MINE_SHOWN_TICKS },
      // The spider goes for the first enemy to step on it.
      onHit: [perSubject([aimedAt([spawnEntity(mineSpider)])])],
    }, { at: aimPoint() }),
  ],
})

// The Vulture's Carrion Strike: resets his auto and readies the next one. On an enemy with carrion it spends it and roots; on one without, it hurts more, slows and marks.
export const STRIKE_DAMAGE = 40
export const STRIKE_SCALING = { attackDamage: 0.6 } satisfies Scaling
export const STRIKE_ROOT_TICKS = seconds(1.25)
export const STRIKE_SLOW = 0.3
export const STRIKE_SLOW_TICKS = seconds(1.5)
ability({
  id: 'carrionstrike',
  name: 'Carrion Strike',
  icon: 'shackle',
  description: 'Your next auto comes at once. On a marked enemy it roots, spending the mark; otherwise it hurts more, slows and marks.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(8),
  empowerAttack: {
    ticks: seconds(5),
    effects: [
      when<SimContext>(
        carrionOn,
        [spendCarrion, root(STRIKE_ROOT_TICKS)],
        [damage(scaled(STRIKE_DAMAGE, STRIKE_SCALING)), slow(STRIKE_SLOW, STRIKE_SLOW_TICKS), markCarrion],
      ),
    ],
  },
  apply: [resetAutoTimer()],
})

// The Vulture's Swoop: a dash onto an enemy, ending beside it. It reaches farther to one with carrion (`rangeAgainst`), and slows that one, spending the mark.
export const SWOOP_RANGE = 240
export const SWOOP_MARKED_RANGE = 420
const SWOOP_SPEED = 1150
export const SWOOP_DAMAGE = 40
export const SWOOP_SCALING = { attackDamage: 0.4 } satisfies Scaling
export const SWOOP_SLOW = 0.4
export const SWOOP_SLOW_TICKS = seconds(1.5)
const targetCarrion = (sim: SimReader, src: EffectSource): boolean =>
  src.aim?.mode === 'unit' && sim.markersOn(src.aim.unitId, CARRION_KEY, src.ownerId).length > 0
ability({
  id: 'swoop',
  name: 'Swoop',
  icon: 'bloodrush',
  description: 'Dashes onto an enemy. Reaches farther to a marked one, and slows it, spending the mark.',
  targeting: 'unit',
  range: SWOOP_RANGE,
  rangeAgainst: { marker: CARRION_KEY, range: SWOOP_MARKED_RANGE },
  windUpTicks: 0,
  cooldownTicks: seconds(11),
  movement: true,
  apply: [
    dash(SWOOP_SPEED, Infinity, self(), { toward: besideTarget(), through: true }),
    damage(scaled(SWOOP_DAMAGE, SWOOP_SCALING), targetUnit()),
    when<SimContext>(targetCarrion, [slow(SWOOP_SLOW, SWOOP_SLOW_TICKS, targetUnit()), popMarkers(CARRION_KEY, targetUnit())]),
  ],
})

// ---------------------------------------------------------------------------- Blade

// Blade's knives: he gains one (a `KNIFE_KEY` marker on himself) every `KNIFE_EVERY_TICKS`, up to `KNIFE_MAX`, and each makes his autos hit harder (`KNIFE_AUTO_BONUS`
// of his attack damage each). Throw Knife spends one. A knife that hits an enemy shreds it (a `SHRED_KEY` marker of his, up to three, for `SHRED_TICKS`): his autos and
// abilities do more to a shredded enemy, by `SHRED_BONUS` for the number of shreds. A thrown knife lies where it stops for `GROUND_KNIFE_TICKS`, until Blade Dash calls
// it back. (The knives and his autos are in champions.ts.)
export const KNIFE_KEY = 'knife'
export const KNIFE_MAX = 5
export const KNIFE_EVERY_TICKS = seconds(4)
export const KNIFE_AUTO_BONUS = 0.06
export const SHRED_KEY = 'shred'
export const SHRED_TICKS = seconds(5)
export const SHRED_BONUS = [0, 0.1, 0.2, 0.35] as const
export const GROUND_KNIFE_TICKS = seconds(10)
const shredsOn = stacks(SHRED_KEY, subject())
// An amount of Blade's damage, the more for the shreds on the subject.
export const shredded = (amount: Amount) => (sim: SimReader, src: EffectSource): number =>
  resolveAmount(amount, sim, src) * (1 + SHRED_BONUS[Math.min(SHRED_BONUS.length - 1, shredsOn(sim, src))])
const shred = mark(SHRED_KEY, SHRED_TICKS, subject(), { cap: SHRED_BONUS.length - 1 })
export const bladeAutoDamage = (sim: SimReader, src: EffectSource): number =>
  shredded((s: SimReader, e: EffectSource) => attackDamage()(s, e) * (1 + KNIFE_AUTO_BONUS * stacks(KNIFE_KEY, self())(s, e)))(sim, src)

// Blade's Throw Knife: a knife thrown at a point (as far as he aims it, up to `THROW_RANGE`), through every enemy in its way, hurting, slowing and shredding each. It needs
// a knife, and spends it.
export const THROW_RANGE = 340
const THROW_SPEED = 1000
export const THROW_DAMAGE = 20
export const THROW_SCALING = { attackDamage: 0.3 } satisfies Scaling
export const THROW_SLOW = 0.2
export const THROW_SLOW_TICKS = seconds(1)
const groundKnife: EntityDef = { id: 'ground-knife', speed: 0, radius: 10, lifetimeTicks: GROUND_KNIFE_TICKS, color: '#c0c8d0' }
ability({
  id: 'throwknife',
  name: 'Throw Knife',
  icon: 'knives',
  description: 'Throws a knife to a point, hurting, slowing and shredding every enemy it passes. It lies where it lands.',
  targeting: 'point',
  range: THROW_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(0.6),
  needsStacks: { key: KNIFE_KEY, count: 1 },
  indicator: { line: true, width: 18 },
  apply: [
    popMarkers(KNIFE_KEY, self(), { count: 1 }),
    spawnEntity({
      id: 'thrown-knife',
      speed: THROW_SPEED,
      radius: 9,
      landAtAim: true,
      pierce: true,
      stopsAtWalls: true,
      color: '#c0c8d0',
      onHit: [damage(shredded(scaled(THROW_DAMAGE, THROW_SCALING))), slow(THROW_SLOW, THROW_SLOW_TICKS), shred],
      onExpire: [spawnEntity(groundKnife)],
    }),
  ],
})

// Blade's Blade Dash: a dash to a point that cuts every enemy round where he lands (`BLADE_DASH_RADIUS`), and calls every knife he has lying back to him, through whoever is
// in their way. A knife hurts and shreds; the more of them that hit the same enemy, the harder it is slowed (`RECALL_SLOW` by count), and the fourth roots it. Two knives on one
// enemy give the dash back.
export const BLADE_DASH_RANGE = 220
const BLADE_DASH_SPEED = 900
export const BLADE_DASH_RADIUS = 90
export const BLADE_DASH_DAMAGE = 40
export const BLADE_DASH_SCALING = { attackDamage: 0.5 } satisfies Scaling
export const RECALL_DAMAGE = 25
export const RECALL_SCALING = { attackDamage: 0.35 } satisfies Scaling
export const RECALL_SLOW = [0.25, 0.5, 0.75] as const
export const RECALL_ROOT_TICKS = seconds(1)
const RECALL_SLOW_TICKS = seconds(1.5)
const RECALL_HIT_KEY = 'recalled-knife'
const recalledHits = stacks(RECALL_HIT_KEY, subject())
const recalledKnife: EntityDef = {
  id: 'recalled-knife',
  speed: 1100,
  radius: 12,
  homing: 'owner',
  pierce: true,
  color: '#c0c8d0',
  pickup: [],
  onHit: [
    damage(shredded(scaled(RECALL_DAMAGE, RECALL_SCALING))),
    shred,
    // This knife and those that hit before it: a slow for the count, or at the fourth a root.
    when<SimContext>(
      (sim, src) => recalledHits(sim, src) >= RECALL_SLOW.length,
      [root(RECALL_ROOT_TICKS)],
      [slow((sim, src) => RECALL_SLOW[Math.min(RECALL_SLOW.length - 1, recalledHits(sim, src))], RECALL_SLOW_TICKS)],
    ),
    when<SimContext>((sim, src) => recalledHits(sim, src) >= 1, [refundCooldown('bladedash', 1)]),
    mark(RECALL_HIT_KEY, seconds(1.5), subject(), { cap: RECALL_SLOW.length + 1 }),
  ],
}
ability({
  id: 'bladedash',
  name: 'Blade Dash',
  icon: 'cutthrough',
  description: 'Dashes to a point, cutting enemies round where you land, and calls back every knife you have lying. Two knives on one enemy refund this.',
  targeting: 'point',
  range: BLADE_DASH_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(11),
  movement: true,
  indicator: { line: true, radius: BLADE_DASH_RADIUS },
  apply: [
    dash(BLADE_DASH_SPEED, BLADE_DASH_RANGE, self(), { through: true }),
    // It lands with him: it goes the way he does, as fast, and cuts round where he stops.
    spawnEntity({
      id: 'bladedash-landing',
      speed: BLADE_DASH_SPEED,
      radius: 4,
      landAtAim: true,
      visual: 'hidden',
      onExpire: [
        onEach<SimContext>(enemiesInRadius(BLADE_DASH_RADIUS), [damage(shredded(scaled(BLADE_DASH_DAMAGE, BLADE_DASH_SCALING))), shred]),
        spawnEntity({ id: 'bladedash-burst', speed: 0, radius: BLADE_DASH_RADIUS, lifetimeTicks: 14, visual: 'flash', color: '#e0e6ee' }),
      ],
    }),
    fromEachOwnEntity<SimContext>('ground-knife', [spawnEntity(recalledKnife)]),
    removeEntities('ground-knife'),
  ],
})

// Blade's Frenzy: two knives back at once (up to his most), and move speed and attack speed for a while.
export const FRENZY_KNIVES = 3
export const FRENZY_HASTE = 0.3
export const FRENZY_ATTACK_SPEED = 0.4
export const FRENZY_TICKS = seconds(3)
ability({
  id: 'frenzy',
  name: 'Frenzy',
  icon: 'flurry',
  description: 'Regain two knives, and gain move speed and attack speed for a while.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(14),
  apply: [
    mark(KNIFE_KEY, Infinity, self(), { count: FRENZY_KNIVES, cap: KNIFE_MAX }),
    haste(FRENZY_HASTE, FRENZY_TICKS, self()),
    statBuff('attackSpeed', FRENZY_ATTACK_SPEED, FRENZY_TICKS, self()),
  ],
})

// ---------------------------------------------------------------------------- Sanguine

// Sanguine's passive: every hit of her abilities heals her (`SANGUINE_HEAL`, more with her arcane). It is in each of her abilities below.
export const SANGUINE_HEAL = 12
export const SANGUINE_HEAL_SCALING = { arcane: 0.15 } satisfies Scaling
const sanguineHeal = heal(scaled(SANGUINE_HEAL, SANGUINE_HEAL_SCALING), self())

// Sanguine's Blood Shot: a bolt of hardened blood shot in a line, through every enemy in it, which gives her a little move speed when it hits. One cast gives two more (a recast
// of the key, within `BLOODSHOT_WINDOW_TICKS`), hit or miss, each as strong as the first.
export const BLOODSHOT_RANGE = 280
const BLOODSHOT_SPEED = 900
export const BLOODSHOT_DAMAGE = 50
export const BLOODSHOT_SCALING = { arcane: 0.3 } satisfies Scaling
export const BLOODSHOT_WINDOW_TICKS = seconds(4)
export const BLOODSHOT_HASTE = 0.15
export const BLOODSHOT_RADIUS = 16
// How long after one shot the next can be shot.
export const BLOODSHOT_GAP_TICKS = seconds(0.65)
const BLOODSHOT_LEFT_KEY = 'bloodshot-left'
const bloodshotWindow: EntityDef = { id: 'bloodshot-window', speed: 0, radius: 1, attached: true, visual: 'hidden', lifetimeTicks: BLOODSHOT_WINDOW_TICKS }
const bloodshotShot: EntityDef = {
  id: 'blood-shot',
  speed: BLOODSHOT_SPEED,
  radius: BLOODSHOT_RADIUS,
  lifetimeTicks: Math.round(BLOODSHOT_RANGE / BLOODSHOT_SPEED * GAME_TPS),
  pierce: true,
  color: '#a0101c',
  onHit: [
    damage(scaled(BLOODSHOT_DAMAGE, BLOODSHOT_SCALING)),
    sanguineHeal,
    haste(BLOODSHOT_HASTE, seconds(1), self(), { named: 'blood-shot' }),
  ],
}
ability({
  id: 'bloodshot',
  name: 'Blood Shot',
  icon: 'transfusion',
  description: 'Shoots blood in a line, through enemies. Gives two more shots.',
  targeting: 'direction',
  range: BLOODSHOT_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(9),
  indicator: { width: BLOODSHOT_RADIUS * 2 },
  recast: 'bloodshotagain',
  apply: [
    spawnEntity(bloodshotShot),
    popMarkers(BLOODSHOT_LEFT_KEY, self()),
    mark(BLOODSHOT_LEFT_KEY, BLOODSHOT_WINDOW_TICKS, self(), { count: 2, cap: 2 }),
    spawnEntity(bloodshotWindow, { onePerOwner: true }),
    // The next shot is a moment away, as it is after each.
    startCooldown('bloodshotagain', self(), BLOODSHOT_GAP_TICKS),
  ],
})
ability({
  id: 'bloodshotagain',
  name: 'Blood Shot',
  icon: 'transfusion',
  description: 'Another shot of Blood Shot.',
  targeting: 'direction',
  range: BLOODSHOT_RANGE,
  windUpTicks: 0,
  cooldownTicks: BLOODSHOT_GAP_TICKS,
  indicator: { width: BLOODSHOT_RADIUS * 2 },
  requires: { entity: 'bloodshot-window', out: true },
  apply: [
    spawnEntity(bloodshotShot),
    removeEntities('bloodshot-window'),
    // With two shots to come, this is the first of them, and the last is still to come.
    when<SimContext>((sim, src) => stacks(BLOODSHOT_LEFT_KEY, self())(sim, src) >= 2, [spawnEntity(bloodshotWindow, { onePerOwner: true })]),
    popMarkers(BLOODSHOT_LEFT_KEY, self(), { count: 1 }),
  ],
})

// Sanguine's Blood Pact: ties an enemy to her. It hurts it at once, and again every `PACT_PULSE_TICKS` while it holds. It breaks if the two are ever farther apart than
// `PACT_RANGE`; if it holds for all of `PACT_TICKS`, it ends in a burst that hurts a great deal and roots.
export const PACT_CAST_RANGE = 280
export const PACT_RANGE = 420
export const PACT_TICKS = seconds(3)
export const PACT_PULSE_TICKS = seconds(0.5)
export const PACT_DAMAGE = 40
export const PACT_PULSE_DAMAGE = 10
export const PACT_BURST_DAMAGE = 120
export const PACT_SCALING = { arcane: 0.2 } satisfies Scaling
export const PACT_PULSE_SCALING = { arcane: 0.08 } satisfies Scaling
export const PACT_BURST_SCALING = { arcane: 0.75 } satisfies Scaling
export const PACT_ROOT_TICKS = seconds(1.25)
const PACT_KEY = 'blood-pact'
const pactBound = markedUnits(PACT_KEY)
const pactHolds = (sim: SimReader, src: EffectSource): boolean => {
  const [bound] = pactBound(sim, src)
  const from = sim.posAt(src.ownerId, src.tick)
  const at = bound === undefined ? undefined : sim.posAt(bound, src.tick)
  return sim.isAlive(src.ownerId) && from !== undefined && at !== undefined && distanceBetween(from, at) <= PACT_RANGE
}
ability({
  id: 'bloodpact',
  name: 'Blood Pact',
  icon: 'link',
  description: 'Ties an enemy to you, hurting it over time. If it does not break free in time, it bursts for big damage and roots.',
  targeting: 'unit',
  range: PACT_CAST_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(14),
  apply: [
    damage(scaled(PACT_DAMAGE, PACT_SCALING), targetUnit()),
    sanguineHeal,
    mark(PACT_KEY, PACT_TICKS + 2, targetUnit(), { cap: 1 }),
    spawnEntity({
      id: 'blood-pact',
      speed: 0,
      radius: 10,
      attached: true,
      visual: 'hidden',
      lifetimeTicks: PACT_TICKS,
      stayWhile: pactHolds,
      pulseEveryTicks: PACT_PULSE_TICKS,
      onPulse: [damage(scaled(PACT_PULSE_DAMAGE, PACT_PULSE_SCALING), pactBound), sanguineHeal],
      onExpire: [
        damage(scaled(PACT_BURST_DAMAGE, PACT_BURST_SCALING), pactBound),
        root(PACT_ROOT_TICKS, pactBound),
        sanguineHeal,
        popMarkers(PACT_KEY, pactBound),
      ],
      onStayEnd: [popMarkers(PACT_KEY, pactBound)],
    }, { onePerOwner: true }),
  ],
})

// Sanguine's Coagulate: a shield of blood on her for `COAGULATE_TICKS`. When it is broken (by damage, or by her recasting the key, which breaks it at once), it bursts into
// shards that hurt every enemy round her. One that simply runs out of time does not burst.
export const COAGULATE_SHIELD = 90
export const COAGULATE_SHIELD_SCALING = { arcane: 0.5, level: 8 } satisfies Scaling
export const COAGULATE_TICKS = seconds(4)
export const SHARDS_RADIUS = 180
export const SHARDS_DAMAGE = 60
export const SHARDS_SCALING = { arcane: 0.5 } satisfies Scaling
const COAGULATE_SHIELD_NAME = 'coagulate'
const coagulateShieldId = (ownerId: number): string => `${ownerId}:shield:${COAGULATE_SHIELD_NAME}`
const shardsBurst: EntityDef = { id: 'blood-shards', speed: 0, radius: SHARDS_RADIUS, lifetimeTicks: 8, visual: 'flash', color: '#a0101c' }
// Ends her Coagulate shield at once.
const breakCoagulate: Effect<SimReader & Pick<SimWriter, 'addStatus'>> = (sim, src) => {
  for (const status of sim.statusesOn(src.ownerId)) {
    if (status.id === coagulateShieldId(src.ownerId)) sim.addStatus(src.ownerId, { ...status, endTick: Math.min(status.endTick, src.tick + 1) })
  }
}
ability({
  id: 'coagulate',
  name: 'Coagulate',
  icon: 'guard',
  description: 'Gain a shield of blood. When it breaks it bursts, hurting enemies around you. Recast to break it early.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(14),
  recast: 'coagulateburst',
  apply: [
    shield(scaled(COAGULATE_SHIELD, COAGULATE_SHIELD_SCALING), COAGULATE_TICKS, self(), { shared: COAGULATE_SHIELD_NAME }),
    spawnEntity({
      id: 'coagulate',
      speed: 0,
      radius: 1,
      attached: true,
      visual: 'hidden',
      // A tick short of the shield, so one that runs out of time is gone before the shield is, and does not burst.
      lifetimeTicks: COAGULATE_TICKS - 1,
      stayWhile: (sim, src) => sim.statusesOn(src.ownerId).some((status) => status.id === coagulateShieldId(src.ownerId) && status.amount > 0),
      onStayEnd: [
        damage(scaled(SHARDS_DAMAGE, SHARDS_SCALING), enemiesInRadius(SHARDS_RADIUS)),
        when<SimContext>((sim, src) => enemiesInRadius(SHARDS_RADIUS)(sim, src).length > 0, [sanguineHeal]),
        spawnEntity(shardsBurst),
      ],
    }, { onePerOwner: true }),
  ],
})
ability({
  id: 'coagulateburst',
  name: 'Coagulate',
  icon: 'guard',
  description: 'Break your blood shield now, bursting it.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(0.3),
  requires: { entity: 'coagulate', out: true },
  apply: [breakCoagulate],
})

// ---------------------------------------------------------------------------- Hunter

// The Hunter's passive: each auto gives him a focus stack (a `FOCUS_KEY` marker on himself, up to `FOCUS_MAX`, for `FOCUS_TICKS`, every auto renewing them), each worth
// `FOCUS_ATTACK_SPEED` more attack speed, and at the most `FOCUS_RANGE` more reach. Volley can only be cast at the most. (The autos are in champions.ts.)
export const FOCUS_KEY = 'focus-stack'
export const FOCUS_MAX = 4
export const FOCUS_TICKS = seconds(4)
export const FOCUS_ATTACK_SPEED = 0.05
export const FOCUS_RANGE = 20
const focusStacks = stacks(FOCUS_KEY, self())
// The attack speed his stacks come to, after this auto's: a share of his own at his level.
const focusSpeed = (sim: SimReader, src: EffectSource): number => {
  const base = sim.character(src.ownerId)?.champion.statsAt(sim.levelOf(src.ownerId) ?? 1).attackSpeed ?? 0
  return base * FOCUS_ATTACK_SPEED * Math.min(FOCUS_MAX, focusStacks(sim, src) + 1)
}
// What a hit of the Hunter's adds to his focus: a stack, the attack speed of the stacks, and at the most his longer reach.
export const hunterFocus: readonly Effect<SimContext>[] = [
  mark(FOCUS_KEY, FOCUS_TICKS, self(), { cap: FOCUS_MAX }),
  statBuff('attackSpeed', focusSpeed, FOCUS_TICKS, self(), { named: 'hunter-focus' }),
  when<SimContext>((sim, src) => focusStacks(sim, src) + 1 >= FOCUS_MAX, [attackRangeBonus(FOCUS_RANGE, FOCUS_TICKS, self(), { named: 'hunter-focus' })]),
]

// The Hunter's Volley: cast only at his most focus stacks (otherwise it is given back). It resets his auto, and readies his next `VOLLEY_SHOTS` autos within `VOLLEY_TICKS`:
// each, as it lands, looses `VOLLEY_EXTRA` more arrows from him at the enemies nearest the one it hit, among those within his reach of him or within `VOLLEY_NEAR` of that
// enemy, each doing `VOLLEY_SHARE` of his auto's damage.
export const VOLLEY_KEY = 'volley'
export const VOLLEY_SHOTS = 3
export const VOLLEY_TICKS = seconds(5)
export const VOLLEY_EXTRA = 2
export const VOLLEY_NEAR = 100
export const VOLLEY_SHARE = 0.7
const volleyArrow: EntityDef = {
  id: 'volley-arrow',
  speed: 950,
  radius: 5,
  homing: true,
  color: '#9bd36d',
  onHit: [damage(scaled(0, { attackDamage: VOLLEY_SHARE }))],
}
// The enemies an empowered auto's extra arrows go to: near the one it hit (or in his reach of him), nearest that one first, at most `VOLLEY_EXTRA`.
const volleyTargets: Selector = (sim, src) => {
  if (src.subject === null) return []
  const at = sim.posAt(src.subject, src.tick)
  const from = sim.posAt(src.ownerId, src.tick)
  if (!at || !from) return []
  const reach = sim.statsOf(src.ownerId)?.attackRange ?? 0
  const near = new Set([...enemiesInRadius(VOLLEY_NEAR, () => at)(sim, src), ...enemiesInRadius(reach, () => from)(sim, src)])
  near.delete(src.subject)
  return [...near]
    .map((unitId) => ({ unitId, gap: distanceBetween(sim.posAt(unitId, src.tick) ?? at, at) }))
    .sort((a, b) => a.gap - b.gap || a.unitId - b.unitId)
    .slice(0, VOLLEY_EXTRA)
    .map(({ unitId }) => unitId)
}
// Runs `effects` aimed at the subject, as an ability aimed at it would be (for a homing shot that is to chase it).
const aimedAtSubject = (effects: readonly Effect<SimContext>[]): Effect<SimContext> => (sim, src) => {
  if (src.subject === null) return
  // Its own id for each unit, so a shot at one is not taken for the shot at another.
  runEffects(effects, sim, { ...src, id: `${src.id}:u${src.subject}`, aim: { mode: 'unit', unitId: src.subject } })
}
export const volleyOnHit: Effect<SimContext> = when<SimContext>(
  (sim, src) => stacks(VOLLEY_KEY, self())(sim, src) > 0,
  [
    onEach(volleyTargets, [aimedAtSubject([spawnEntity(volleyArrow, { at: (sim, src) => sim.posAt(src.ownerId, src.tick) })])]),
    popMarkers(VOLLEY_KEY, self(), { count: 1 }),
  ],
)
ability({
  id: 'volley',
  name: 'Volley',
  icon: 'focus',
  description: `At full focus: your auto comes at once, and your next ${VOLLEY_SHOTS} autos each loose ${VOLLEY_EXTRA} more arrows at enemies near the one hit.`,
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(10),
  needsStacks: { key: FOCUS_KEY, count: FOCUS_MAX },
  apply: [resetAutoTimer(), popMarkers(VOLLEY_KEY, self()), mark(VOLLEY_KEY, VOLLEY_TICKS, self(), { count: VOLLEY_SHOTS, cap: VOLLEY_SHOTS })],
})

// The Hunter's Disengage: an arrow loosed the way he aims, which roots the first enemy it hits, as he leaps the other way.
export const DISENGAGE_RANGE = 120
export const DISENGAGE_LEAP = 120
const DISENGAGE_SPEED = 800
export const DISENGAGE_DAMAGE = 35
export const DISENGAGE_SCALING = { attackDamage: 0.5 } satisfies Scaling
export const DISENGAGE_ROOT_TICKS = seconds(1)
// The point `distance` behind him, away from where he aims.
const backFromAim = (distance: number): Anchor => (_sim, src) => {
  const facing = src.aim?.mode === 'direction' ? src.aim.dir : undefined
  return facing && { x: src.at.x - facing.x * distance, y: src.at.y - facing.y * distance }
}
ability({
  id: 'disengage',
  name: 'Disengage',
  icon: 'snare',
  description: 'Shoots an arrow that roots the first enemy it hits, as you leap back the other way.',
  targeting: 'direction',
  range: DISENGAGE_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(12),
  movement: true,
  indicator: { width: 16 },
  apply: [
    spawnEntity({
      id: 'disengage-arrow',
      speed: DISENGAGE_SPEED,
      radius: 8,
      lifetimeTicks: Math.round(DISENGAGE_RANGE / DISENGAGE_SPEED * GAME_TPS),
      color: '#9bd36d',
      onHit: [damage(scaled(DISENGAGE_DAMAGE, DISENGAGE_SCALING)), root(DISENGAGE_ROOT_TICKS)],
    }),
    dash(800, DISENGAGE_LEAP, self(), { toward: backFromAim(DISENGAGE_LEAP), through: true }),
  ],
})

// The Hunter's Arrow Rain: arrows that come down over a circle a moment after the cast, hurting and slowing every enemy under them.
export const RAIN_RANGE = 350
export const RAIN_RADIUS = 110
export const RAIN_DELAY_TICKS = seconds(0.5)
export const RAIN_DAMAGE = 70
export const RAIN_SCALING = { attackDamage: 0.6 } satisfies Scaling
export const RAIN_SLOW = 0.4
export const RAIN_SLOW_TICKS = seconds(2)
ability({
  id: 'arrowrain',
  name: 'Arrow Rain',
  icon: 'snare',
  description: 'Rains arrows over a circle, hurting and slowing enemies.',
  targeting: 'point',
  range: RAIN_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(11),
  indicator: { radius: RAIN_RADIUS },
  apply: [
    spawnEntity({
      id: 'arrow-rain',
      speed: 0,
      radius: RAIN_RADIUS,
      lifetimeTicks: RAIN_DELAY_TICKS,
      visual: 'telegraph',
      color: '#9bd36d',
      onExpire: [
        damage(scaled(RAIN_DAMAGE, RAIN_SCALING), enemiesInRadius(RAIN_RADIUS)),
        slow(RAIN_SLOW, RAIN_SLOW_TICKS, enemiesInRadius(RAIN_RADIUS)),
        // Only to be seen and heard: the arrows landing, and standing in the ground a while.
        spawnEntity({ id: 'arrow-rain-impact', speed: 0, radius: RAIN_RADIUS, lifetimeTicks: seconds(1.2), visual: 'flash', color: '#9bd36d' }),
      ],
    }, { at: aimPoint() }),
  ],
})

// ---------------------------------------------------------------------------- Crystal

// Crystal's passive: every ability she casts resets her auto (her `onCast`, in champions.ts).

// Crystal's Crystal Bolt: a bolt shot in a direction that stops on the first enemy it hits, cracking it (a `CRACK_KEY` marker of hers). A hit gives her a recast within
// `SHATTER_WINDOW_TICKS`: Shatter, which hurts every enemy she has cracked by a share of the health it is missing, and spends the cracks.
export const CRYSTAL_BOLT_RANGE = 440
const CRYSTAL_BOLT_SPEED = 1150
export const CRYSTAL_BOLT_DAMAGE = 60
export const CRYSTAL_BOLT_SCALING = { arcane: 0.6 } satisfies Scaling
export const SHATTER_WINDOW_TICKS = seconds(3)
export const SHATTER_DAMAGE = 30
export const SHATTER_MISSING = 0.15
export const CRACK_KEY = 'cracked'
const shatterWindow: EntityDef = { id: 'shatter-window', speed: 0, radius: 1, attached: true, visual: 'hidden', lifetimeTicks: SHATTER_WINDOW_TICKS }
ability({
  id: 'crystalbolt',
  name: 'Crystal Bolt',
  icon: 'bolt',
  description: 'Shoots a bolt. If it hits, recast to shatter it, hurting the enemy more the more health it is missing.',
  targeting: 'direction',
  range: CRYSTAL_BOLT_RANGE,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(8),
  indicator: { width: 20 },
  recast: 'shatter',
  apply: [
    spawnEntity({
      id: 'crystal-bolt',
      speed: CRYSTAL_BOLT_SPEED,
      radius: 10,
      lifetimeTicks: Math.round(CRYSTAL_BOLT_RANGE / CRYSTAL_BOLT_SPEED * GAME_TPS),
      color: '#9fe7ff',
      onHit: [
        damage(scaled(CRYSTAL_BOLT_DAMAGE, CRYSTAL_BOLT_SCALING)),
        mark(CRACK_KEY, SHATTER_WINDOW_TICKS, subject()),
        spawnEntity(shatterWindow, { onePerOwner: true }),
      ],
    }),
  ],
})
ability({
  id: 'shatter',
  name: 'Shatter',
  icon: 'bolt',
  description: 'Shatters the crystal in every enemy your bolt hit, hurting it more the more health it is missing.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(0.3),
  requires: { entity: 'shatter-window', out: true },
  apply: [
    onEach<SimContext>(markedUnits(CRACK_KEY), [hitMark('shatter-burst', 44, '#9fe7ff', 18), damage(linear(SHATTER_DAMAGE, SHATTER_MISSING, missingHealth(subject())))]),
    popMarkers(CRACK_KEY, markedUnits(CRACK_KEY)),
    removeEntities('shatter-window'),
  ],
})

// Crystal's Glide: a short dash to a point.
export const GLIDE_RANGE = 200
ability({
  id: 'glide',
  name: 'Glide',
  icon: 'leap',
  description: 'A short dash.',
  targeting: 'point',
  range: GLIDE_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(9),
  movement: true,
  indicator: { line: true },
  apply: [dash(1000, GLIDE_RANGE)],
})

// Crystal's Shardstorm: readies her next `SHARD_SHOTS` autos within `SHARD_TICKS`. Each does `SHARD_BONUS` more to what it hits, and bursts into shards that do `SHARD_SPLASH`
// of her attack damage to every other enemy within `SHARD_RADIUS` of it.
export const SHARD_KEY = 'shardstorm'
export const SHARD_SHOTS = 3
export const SHARD_TICKS = seconds(6)
export const SHARD_BONUS = 0.2
export const SHARD_SPLASH = 0.8
export const SHARD_RADIUS = 75
const shardBurst: EntityDef = { id: 'shard-burst', speed: 0, radius: SHARD_RADIUS, lifetimeTicks: 8, visual: 'flash', color: '#9fe7ff' }
// The enemies round the subject, but not the subject.
const othersRoundSubject: Selector = (sim, src) => {
  if (src.subject === null) return []
  const at = sim.posAt(src.subject, src.tick)
  return at ? enemiesInRadius(SHARD_RADIUS, () => at)(sim, src).filter((unitId) => unitId !== src.subject) : []
}
export const shardOnHit: Effect<SimContext> = when<SimContext>(
  (sim, src) => stacks(SHARD_KEY, self())(sim, src) > 0,
  [
    damage(scaled(0, { attackDamage: SHARD_BONUS })),
    damage(scaled(0, { attackDamage: SHARD_SPLASH }), othersRoundSubject),
    spawnEntity(shardBurst, { at: (sim, src) => (src.subject === null ? undefined : sim.posAt(src.subject, src.tick)) }),
    popMarkers(SHARD_KEY, self(), { count: 1 }),
  ],
)
ability({
  id: 'shardstorm',
  name: 'Shardstorm',
  icon: 'firetornado',
  description: `Your next ${SHARD_SHOTS} autos hit harder and burst into shards that hurt enemies around the one hit.`,
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(12),
  apply: [popMarkers(SHARD_KEY, self()), mark(SHARD_KEY, SHARD_TICKS, self(), { count: SHARD_SHOTS, cap: SHARD_SHOTS })],
})

// ---------------------------------------------------------------------------- Sorin

// Sorin's passive: light (his resource, in champions.ts), from none to `LIGHT_MAX` points, each a percent of the bar. It does not fill by itself: it comes `LIGHT_PER_AUTO`
// with each auto (more with Smite) and `LIGHT_PER_KILL` with each champion he kills, and what would overfill it heals him (`LIGHT_OVERFLOW_HEAL` of his health a point).
export const LIGHT_MAX = 100
export const LIGHT_PER_AUTO = 5
export const LIGHT_PER_KILL = 50
export const LIGHT_OVERFLOW_HEAL = 0.02 / 5

// Sorin's Dawn Beam: cast through anything, and nothing stops it once begun. With at least `BEAM_COST` light he spends it on a beam down a long line, which hurts and slows
// every enemy in it and gives back `BEAM_REFUND` light for each, and on a shield of `BEAM_SHIELD`. With less he only gains the smaller `BEAM_SMALL_SHIELD`.
export const BEAM_COST = 50
export const BEAM_REFUND = 15
export const BEAM_LENGTH = 520
export const BEAM_HALF_WIDTH = 28
export const BEAM_DAMAGE = 110
export const BEAM_SCALING = { attackDamage: 0.9 } satisfies Scaling
export const BEAM_SLOW = 0.4
export const BEAM_SLOW_TICKS = seconds(1.5)
export const BEAM_SHIELD = scaled(60, { level: 12 })
export const BEAM_SMALL_SHIELD = scaled(25, { level: 5 })
export const BEAM_SHIELD_TICKS = seconds(3)
const BEAM_SPEED = 4000
const hasLight = (points: number) => (sim: SimReader, src: EffectSource): boolean => resource()(sim, src) >= points
ability({
  id: 'dawnbeam',
  name: 'Dawn Beam',
  icon: 'bolt',
  description: `Spends ${BEAM_COST}% light on a beam that hurts and slows, and a shield. Without the light, only a small shield.`,
  targeting: 'direction',
  range: BEAM_LENGTH,
  windUpTicks: WINDUP_TICKS.default,
  cooldownTicks: seconds(9),
  unstoppable: true,
  indicator: { width: BEAM_HALF_WIDTH * 2 },
  apply: [
    when<SimContext>(
      hasLight(BEAM_COST),
      [
        spendResource(BEAM_COST),
        shield(BEAM_SHIELD, BEAM_SHIELD_TICKS, self(), { shared: 'dawn-shield' }),
        onEach<SimContext>(enemiesInLine(BEAM_LENGTH, BEAM_HALF_WIDTH), [
          damage(scaled(BEAM_DAMAGE, BEAM_SCALING)),
          slow(BEAM_SLOW, BEAM_SLOW_TICKS),
          gainResource(BEAM_REFUND, self()),
        ]),
        // Only to be seen: the beam's light going down the line.
        spawnEntity({ id: 'dawn-beam', speed: BEAM_SPEED, radius: BEAM_HALF_WIDTH, lifetimeTicks: Math.max(1, Math.round(BEAM_LENGTH / BEAM_SPEED * GAME_TPS)), color: '#ffe08a' }),
      ],
      [shield(BEAM_SMALL_SHIELD, BEAM_SHIELD_TICKS, self(), { shared: 'dawn-shield' })],
    ),
  ],
})

// Sorin's Smite: resets his auto, and readies the next `SMITE_SHOTS` within `SMITE_TICKS`. Each does `SMITE_DAMAGE` more and gives `SMITE_LIGHT` more light, and the last
// of them stuns.
export const SMITE_KEY = 'smite'
export const SMITE_SHOTS = 3
export const SMITE_TICKS = seconds(5)
export const SMITE_DAMAGE = 25
export const SMITE_SCALING = { attackDamage: 0.3 } satisfies Scaling
export const SMITE_LIGHT = 15
export const SMITE_STUN_TICKS = seconds(0.75)
// What each smiting blow leaves on what it strikes, to be seen and heard: a hammer of light, and for the last, which stuns, a greater one.
const smiteHit = hitMark('smite-hit', 40, '#ffe08a', 18)
const smiteFinal = hitMark('smite-final', 70, '#fff2b0', 30)
export const smiteOnHit: Effect<SimContext> = when<SimContext>(
  (sim, src) => stacks(SMITE_KEY, self())(sim, src) > 0,
  [
    damage(scaled(SMITE_DAMAGE, SMITE_SCALING)),
    gainResource(SMITE_LIGHT, self()),
    when<SimContext>((sim, src) => stacks(SMITE_KEY, self())(sim, src) === 1, [stun(SMITE_STUN_TICKS), smiteFinal], [smiteHit]),
    popMarkers(SMITE_KEY, self(), { count: 1 }),
  ],
)
ability({
  id: 'smite',
  name: 'Smite',
  icon: 'slam',
  description: `Your auto comes at once, and your next ${SMITE_SHOTS} hit harder and give more light. The last one stuns.`,
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(10),
  apply: [resetAutoTimer(), popMarkers(SMITE_KEY, self()), mark(SMITE_KEY, SMITE_TICKS, self(), { count: SMITE_SHOTS, cap: SMITE_SHOTS })],
})

// Sorin's Dawnstep: a dash to a point that hurts every enemy round where he lands. With at least `DAWNSTEP_COST` light he spends it, and gets back `DAWNSTEP_REFUND` of
// the cooldown.
export const DAWNSTEP_RANGE = 190
const DAWNSTEP_SPEED = 1100
export const DAWNSTEP_COST = 25
export const DAWNSTEP_REFUND = 0.9
export const DAWNSTEP_RADIUS = 70
export const DAWNSTEP_DAMAGE = 60
export const DAWNSTEP_SCALING = { attackDamage: 0.5 } satisfies Scaling
ability({
  id: 'dawnstep',
  name: 'Dawnstep',
  icon: 'leap',
  description: `Dashes to a point, hurting enemies where you land. Spends ${DAWNSTEP_COST}% light, if you have it, to have it back almost at once.`,
  targeting: 'point',
  range: DAWNSTEP_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(12),
  movement: true,
  indicator: { line: true, radius: DAWNSTEP_RADIUS },
  apply: [
    dash(DAWNSTEP_SPEED, DAWNSTEP_RANGE, self(), { through: true }),
    // It lands with him: it goes the way he does, as fast, and goes off where he stops.
    spawnEntity({
      id: 'dawnstep-landing',
      speed: DAWNSTEP_SPEED,
      radius: 4,
      landAtAim: true,
      visual: 'hidden',
      onExpire: [
        damage(scaled(DAWNSTEP_DAMAGE, DAWNSTEP_SCALING), enemiesInRadius(DAWNSTEP_RADIUS)),
        spawnEntity({ id: 'dawnstep-flash', speed: 0, radius: DAWNSTEP_RADIUS, lifetimeTicks: 10, visual: 'flash', color: '#ffe08a' }),
      ],
    }),
    when<SimContext>(hasLight(DAWNSTEP_COST), [spendResource(DAWNSTEP_COST), refundCooldown('dawnstep', DAWNSTEP_REFUND)]),
  ],
})

// ---------------------------------------------------------------------------- Sniper

// The Sniper's passive: he sees `SNIPER_VISION_BONUS` farther than any other champion (his `visionRange`, in champions.ts).
export const SNIPER_VISION_BONUS = 200

// The Sniper's Steady Aim: held. As the key goes down he starts drawing a bead (a `CHARGE_KEY` marker on himself, from the tick he starts), free to move as he does; as it
// comes up he fires (`steadyfire`, the recast, which the page casts on letting go, aimed where the pointer is). The longer he held, the farther the shot flies and the
// harder it hits, from the least to the most over `CHARGE_FULL_TICKS` (`CHARGE_BANDS`, a step at a time), and it slows what it hits. Held past `CHARGE_HOLD_TICKS`, the page
// lets it go for him.
export const CHARGE_KEY = 'steady-aim'
export const CHARGE_HOLD_TICKS = seconds(4)
export const CHARGE_FULL_TICKS = seconds(1.5)
const CHARGE_STEPS = 20
const CHARGE_SPEED = 1700
export const CHARGE_SLOW = 0.3
export const CHARGE_SLOW_TICKS = seconds(1.5)
const CHARGE_LEAST = { range: 420, damage: 50, attackDamage: 0.6 }
const CHARGE_MOST = { range: 950, damage: 200, attackDamage: 1.8 }
export const CHARGE_BANDS: readonly { after: number; range: number; damage: number; scaling: Scaling }[] = Array.from({ length: CHARGE_STEPS }, (_, index) => {
  const k = index / (CHARGE_STEPS - 1)
  const between = (from: number, to: number): number => from + (to - from) * k
  return {
    after: Math.round(CHARGE_FULL_TICKS * k),
    range: Math.round(between(CHARGE_LEAST.range, CHARGE_MOST.range)),
    damage: Math.round(between(CHARGE_LEAST.damage, CHARGE_MOST.damage)),
    scaling: { attackDamage: Math.round(between(CHARGE_LEAST.attackDamage, CHARGE_MOST.attackDamage) * 100) / 100 },
  }
})
// The time the key is held for, from when the bead was started (one the page can let go of), up to the most.
const chargeWindow: EntityDef = { id: 'steady-aim-window', speed: 0, radius: 1, attached: true, visual: 'hidden', lifetimeTicks: CHARGE_HOLD_TICKS + seconds(0.5) }
const chargeShots: readonly Effect<SimContext>[][] = CHARGE_BANDS.map((band, index) => [spawnEntity({
  id: `steady-shot-${index + 1}`,
  speed: CHARGE_SPEED,
  radius: 9 + Math.round(index * 0.6),
  lifetimeTicks: Math.round(band.range / CHARGE_SPEED * GAME_TPS),
  color: '#ffd36a',
  onHit: [damage(scaled(band.damage, band.scaling)), slow(CHARGE_SLOW, CHARGE_SLOW_TICKS)],
})])
// Which band a bead held this long is in: the last whose `after` it has reached.
export const chargeBand = (heldTicks: number): number => {
  let band = 0
  CHARGE_BANDS.forEach((each, index) => { if (heldTicks >= each.after) band = index })
  return band
}
// How far a shot of a bead held this long would fly.
export const chargeRange = (heldTicks: number): number => CHARGE_BANDS[chargeBand(heldTicks)].range
// Fires the shot of the band the bead has reached, from when it was started.
const fireCharged: Effect<SimContext> = (sim, src) => {
  const [bead] = sim.markersOn(src.ownerId, CHARGE_KEY, src.ownerId)
  if (!bead) return
  runEffects(chargeShots[chargeBand(src.tick - bead.startTick)], sim, src)
}
ability({
  id: 'steadyaim',
  name: 'Steady Aim',
  icon: 'bolt',
  description: 'Hold to draw a bead, and let go to fire. The longer you hold, the farther and harder it hits. It slows.',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: seconds(9),
  recast: 'steadyfire',
  held: { ticks: CHARGE_HOLD_TICKS, full: CHARGE_FULL_TICKS, reach: chargeRange },
  apply: [popMarkers(CHARGE_KEY, self()), mark(CHARGE_KEY, CHARGE_HOLD_TICKS + seconds(0.5), self(), { cap: 1 }), spawnEntity(chargeWindow, { onePerOwner: true })],
})
ability({
  id: 'steadyfire',
  name: 'Steady Aim',
  icon: 'bolt',
  description: 'Let go to fire. The longer you held, the farther and harder it hits.',
  targeting: 'direction',
  range: CHARGE_BANDS[CHARGE_BANDS.length - 1].range,
  windUpTicks: 0,
  cooldownTicks: seconds(0.3),
  indicator: { width: 22 },
  requires: { entity: 'steady-aim-window', out: true },
  apply: [fireCharged, popMarkers(CHARGE_KEY, self()), removeEntities('steady-aim-window')],
})

// The Sniper's Tumble: a roll to a point, untouchable while he rolls.
export const TUMBLE_RANGE = 200
const TUMBLE_SPEED = 900
export const TUMBLE_TICKS = Math.ceil(TUMBLE_RANGE / TUMBLE_SPEED * GAME_TPS) + 1
ability({
  id: 'tumble',
  name: 'Tumble',
  icon: 'leap',
  description: 'Rolls to a point. Nothing can touch you while you roll.',
  targeting: 'point',
  range: TUMBLE_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(11),
  movement: true,
  indicator: { line: true },
  apply: [invulnerable(TUMBLE_TICKS), dash(TUMBLE_SPEED, TUMBLE_RANGE, self(), { through: true })],
})

// The Sniper's Scan: a sweep of an area that his team sees into for `SCAN_TICKS`, and every enemy in it is revealed, invisible or not, until `SCAN_LINGER_TICKS` after
// it leaves the area or the scan ends. He holds up to `SCAN_CHARGES` of them, one more every `SCAN_RECHARGE_TICKS` (his `gainsOverTime`, in champions.ts).
export const SCAN_KEY = 'scan-charge'
export const SCAN_CHARGES = 2
export const SCAN_RECHARGE_TICKS = seconds(20)
export const SCAN_RANGE = 800
export const SCAN_RADIUS = 220
export const SCAN_TICKS = seconds(4)
export const SCAN_LINGER_TICKS = seconds(1)
ability({
  id: 'scan',
  name: 'Scan',
  icon: 'focus',
  description: `Sweeps an area: your team sees it, and the enemies in it, even invisible ones. Holds ${SCAN_CHARGES} charges.`,
  targeting: 'point',
  range: SCAN_RANGE,
  windUpTicks: 0,
  cooldownTicks: seconds(1),
  needsStacks: { key: SCAN_KEY, count: 1 },
  indicator: { radius: SCAN_RADIUS },
  apply: [
    popMarkers(SCAN_KEY, self(), { count: 1 }),
    spawnEntity({
      id: 'scan',
      speed: 0,
      radius: SCAN_RADIUS,
      lifetimeTicks: SCAN_TICKS,
      visual: 'field',
      color: '#ffd36a',
      sight: SCAN_RADIUS,
      onTick: [mark(REVEAL_KEY, SCAN_LINGER_TICKS, enemiesInRadius(SCAN_RADIUS), { cap: 1 })],
    }, { at: aimPoint() }),
  ],
})

// ---------------------------------------------------------------------------- Back

// Back, which every champion has: it channels for `BACK_TICKS`, and then takes the champion to its spawn, where its shop is. It is not one of its abilities and not on a
// key (the page gives it B). Walking, going after someone, casting something else, a stun or a fear, and taking damage all end it, and it does nothing then. A champion
// that carries a flag cannot start it, or it would take the flag home for free (see `Simulator.carriesFlag`).
export const BACK_ABILITY_ID = 'back'
export const BACK_TICKS = seconds(3)
// Where the caster starts the game, and comes back to when it respawns.
const ownSpawn: Anchor = (sim, src) => {
  const at = sim.character(src.ownerId)?.initialPosition
  return at && { ...at }
}
ability({
  id: BACK_ABILITY_ID,
  name: 'Back',
  description: 'Channels, then takes you back to your spawn. Moving, casting or taking damage cancels it.',
  targeting: 'none',
  range: 0,
  windUpTicks: BACK_TICKS,
  cooldownTicks: 0,
  universal: true,
  apply: [blink(ownSpawn)],
})

// ---------------------------------------------------------------------------- Monsters

  // Monsters' abilities. A monster is a champion as far as the simulator goes, so its abilities are defined here like
  // any other, and listed on its monster (see monsters.ts); no player champion has them.

ability({
  id: 'monster-slam',
  description: 'A heavy blow to everything around the caster.',
  targeting: 'none',
  range: 0,
  windUpTicks: WINDUP_TICKS.default,
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
