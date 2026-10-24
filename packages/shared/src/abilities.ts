import { GAME_TPS } from './constants.js'
import {
  aimPoint,
  alliesInBox,
  alliesInRadius,
  alongAim,
  attackRangeBonus,
  attackSpeedBonus,
  blind,
  blink,
  burn,
  capCooldown,
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
  targetUnit,
  when,
  type DashDef,
  type Effect,
  type EntityDef,
  type Selector,
  type SimContext,
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
  // Shown on the champion select screen.
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

// Shared with champions.ts, where each champion's passive uses the same keys and durations.
// They are not part of the package's public exports.

// Cursebearer's curse: stacks placed on enemies, up to five. Applying a stack refreshes them all.
export const CURSE_KEY = 'curse'
export const CURSE_MAX_STACKS = 5
export const CURSE_DURATION_TICKS = seconds(10)
// Swordsman's sword stacks sit on the Swordsman. Autos add them, they last until they expire,
// and each one adds damage to autos and Slash until Radiance or Shackle spends them.
export const SWORD_KEY = 'sword'
export const SWORD_MAX_STACKS = 3
export const SWORD_DURATION_TICKS = seconds(8)
export const SWORD_DAMAGE_PER_STACK = 15
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
    slow(linear(0.4, .15 ,swordStacks), 2, enemiesInBox(SLASH_LENGTH / 2, SLASH_HALF_WIDTH)),
    haste(linear(0.6,.1,swordStacks), 2, alliesInBox(SLASH_LENGTH / 2, SLASH_HALF_WIDTH)),
  ],
} satisfies EntityDef

// Radiance's explosion is only a flash; its damage is dealt by the ability itself.
const lightBurst: EntityDef = {
  id: 'light-burst',
  speed: 0,
  radius: 170,
  lifetimeTicks: 12,
  visual: 'field',
  color: '#ffe27a',
}

// Capricorn's passive: casting any spell empowers the next auto attack.
export const EMPOWER_KEY = 'empowered'
export const EMPOWER_DURATION_TICKS = seconds(6)
export const EMPOWER_BONUS_DAMAGE = 30

// Capricorn's Bubbles: a stream of bubbles. For each target the first to hit does full damage
// and the rest do half. A short marker on the target remembers who was hit.
const BUBBLE_KEY = 'bubbled'
const BUBBLE_DAMAGE = 80
const BUBBLE_MARK_TICKS = seconds(1.5)
const bubbleStacksOnHit = stacks(BUBBLE_KEY, subject())

// Capricorn's Spout: a marked circle that erupts after a short warning. Whatever is still standing
// in it when it goes is hurt and slowed, so the warning is the whole chance to step out.
const SPOUT_RADIUS = 65

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
    damage(120, enemiesInRadius(SPOUT_RADIUS)),
    slow(0.4, seconds(.6), enemiesInRadius(SPOUT_RADIUS)),
    spawnEntity(spoutBurst),
  ],
}

const bubble = {
  id: 'bubble',
  speed: 600,
  radius: 14,
  lifetimeTicks: seconds(0.7),
  color: '#a8e0ff',
  onHit: [
    when<SimContext>(
      (sim, src) => bubbleStacksOnHit(sim, src) > 0,
      [damage(BUBBLE_DAMAGE / 2)],
      [damage(BUBBLE_DAMAGE), mark(BUBBLE_KEY, BUBBLE_MARK_TICKS, subject(), { cap: 1 })],
    ),
  ],
} satisfies EntityDef

// Soldier's Medic: a bot that shields its owner and heals them over time. It has no timer: it
// stays out until its shield is broken, which is how it is killed. It hangs just above its owner
// on a loose spring, so it lags behind when they move and drifts back in when they stop.
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
  onPulse: [heal(12, self())],
}

// Archer's Snare: a lob that flies to the aimed point, then leaves this trap where it lands. It
// stays for a second and roots each enemy once, for a set time, the moment its body touches it:
// whoever it lands on, and whoever walks in while it is out. Piercing is what keeps it on the
// ground after the first catch, and it never hits the same unit twice.
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

// Grenadier's passive: an enemy hit by an auto carries a `sighted` marker for a while. The auto
// that would be the third in a row on the same enemy pops them instead and gives the Grenadier
// move speed that fades away. Markers sit on each enemy separately, so the count is per enemy.
export const SIGHTED_KEY = 'sighted'
export const SIGHTED_AUTOS = 3
export const SIGHTED_WINDOW_TICKS = seconds(5)
export const SIGHTED_HASTE = 0.5
export const SIGHTED_HASTE_TICKS = seconds(3)

// Trinketmaster's passive: an enemy hit by one of his abilities carries a `trick` marker for a while.
// The ability hit that would be the third in a row on the same enemy pops them instead, for bonus
// damage on top of its own, and gives him move speed for a short while. Markers sit on each enemy
// separately, so the count is per enemy, and each hit refreshes them, so the three have to be within
// the window of one another. The hits are the stick on the way out, the stick on the way back and the
// auto that Hush readies, which is Hush landing. His plain autos do not count.
export const TRICK_KEY = 'trick'
export const TRICK_HITS = 3
export const TRICK_WINDOW_TICKS = seconds(5)
export const TRICK_BONUS_DAMAGE = 50
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

// Grenadier's Grenade: a lob that goes off where it lands. Everything caught in the blast is
// thrown straight away from its centre: enemies are hurt and bounced, and the Grenadier is bounced
// too if it is standing in it. A blast that catches an enemy hands back half of the cooldown.
const GRENADE_RADIUS = 45
const GRENADE_REFUND = 0.5
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
  speed: 550,
  radius: 8,
  landAtAim: true,
  color: '#9fb85a',
  onExpire: [
    damage(70, enemiesInRadius(GRENADE_RADIUS)),
    knockback(90, 300, enemiesInRadius(GRENADE_RADIUS)),
    knockback(70, 300, selfInRadius(GRENADE_RADIUS)),
    when<SimContext>(
      (sim, src) => enemiesInRadius(GRENADE_RADIUS)(sim, src).length > 0,
      [refundCooldown('grenade', GRENADE_REFUND)],
    ),
    spawnEntity(grenadeBurst),
  ],
} satisfies EntityDef

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
    burn(30, seconds(3), enemiesInRadius(MOLOTOV_RADIUS)),
  ],
} satisfies EntityDef

// Grenadier's Flashbang: a lob that goes off where it lands. An enemy it lands right on, in the
// core of the flash, is stunned. One that only gets the edge of it, in the ring around the core,
// is blinded for a short while instead, so a near miss still costs them.
const FLASH_CORE_RADIUS = 35
const FLASH_RADIUS = 70
// Who is caught by the flash but not by its core: they get the blind and not the stun.
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

// Trinketmaster's stick. Q throws it in a straight line, hurting each enemy it passes through, and
// it lands in the ground where its flight ends (against the wall, if it meets one) and stays there.
// Walking over it picks it up and leaves Q no more than a second to wait. Calling it back with Q
// again does not: the stick hurts and slows what it passes on the way home, and Q carries on as it
// was. Warp blinks onto the stick, which is walking over it as far as the stick can tell, so the
// pickup that follows does refund Q.
const STICK_DAMAGE = 80
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

// The stick on its way out: a shot that flies to the point it was thrown at, at 540 px a second, hurts
// every enemy it passes through once and comes down there. The player chooses how far, from the
// least to the most. The point is held inside the arena's wall, so it never lands where its owner
// could not walk to it.
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
  onHit: [damage(STICK_DAMAGE), ...trickEffects],
  onExpire: [spawnEntity(stick, { onePerOwner: true })],
} satisfies EntityDef

// The stick called back: it flies home from where it lay, turning to follow its owner, and slows and
// hurts each enemy it passes through once. It ends on arrival, and that is all: its pickup has no
// effects, so unlike walking over the stick on the ground it does nothing for Q's cooldown.
const stickRecall = {
  id: 'stick-recall',
  speed: 800,
  radius: 15,
  homing: 'owner',
  pierce: true,
  color: '#a9794a',
  onHit: [damage(STICK_DAMAGE), slow(0.75, seconds(1.5)), ...trickEffects],
  pickup: [],
} satisfies EntityDef

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

// Ninja's shadow stacks sit on the Ninja, and each is an enhanced auto ready. Only Shadow Step (and
// Shadow Return) adds one, when its dash passes through an enemy, up to two; they last six seconds,
// refreshed together. An auto or a Kunai spends one.
export const SHADOW_KEY = 'shadow'
export const SHADOW_MAX_STACKS = 2
export const SHADOW_STACK_TICKS = seconds(6)
export const SHADOW_AUTO_BONUS_DAMAGE = 60
const shadowStacks = stacks(SHADOW_KEY, self())
const spendShadowStack = popMarkers(SHADOW_KEY, self(), { count: 1 })

// Shadow Step: a dash that hurts and slows each enemy it passes through, as it passes it. The first
// one it passes also gives the Ninja a shadow stack (an enhanced auto), hands back most of the
// cooldown, and leaves a shadow behind at the spot it was cast from. With a shadow out, the key dashes
// back to it instead, from any distance, and does the same.
// A shadow lasts 8 seconds, as long as Shadow Step's whole cooldown. The first enemy hands most of that
// cooldown back, so Shadow Step is ready long before the shadow goes, and the key (Shadow Return while
// the shadow is out) turns back into it the moment the shadow fades. One that is dashed back to
// without passing through an enemy ends when the dash finishes, and Shadow Step starts its whole
// cooldown over, so the time that ran while the shadow was out is no help to a miss. It also goes when
// its owner dies.
const SHADOW_STEP_COOLDOWN_TICKS = seconds(8)
const SHADOW_STEP_RANGE = 300
const SHADOW_STEP_SPEED = 1200
const SHADOW_STEP_REFUND = 0.75
const SHADOW_STEP_DAMAGE = 60
const shadow = {
  id: 'shadow',
  speed: 0,
  radius: 14,
  visual: 'field',
  color: '#7a5cff',
  lifetimeTicks: SHADOW_STEP_COOLDOWN_TICKS,
  stayWhile: (sim, src) => sim.isAlive(src.ownerId),
} satisfies EntityDef

// What each enemy the dash passes through takes, as the Ninja's body reaches it.
const shadowDashHit: readonly Effect[] = [
  damage(SHADOW_STEP_DAMAGE),
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

// Ninja's Kunai: a line shot. It hurts and slows what it passes through, or, if the Ninja has a
// shadow stack, which it spends, it hurts more and roots instead.
const kunai = {
  id: 'kunai',
  speed: 750,
  radius: 10,
  lifetimeTicks: seconds(0.2),
  pierce: true,
  color: '#c9c9ff',
  onHit: [damage(60), slow(0.4, seconds(1.5))],
} satisfies EntityDef
const kunaiEnhanced = {
  id: 'kunai-enhanced',
  speed: 640,
  radius: 10,
  lifetimeTicks: seconds(0.2),
  pierce: true,
  color: '#ff6bd6',
  onHit: [damage(110), root(seconds(1))],
} satisfies EntityDef

const curseStacksOnTarget = stacks(CURSE_KEY, targetUnit())
const curseStacksOnHit = stacks(CURSE_KEY, subject())

// Cursebearer's Hex: a line shot that slows and adds two stacks, or pops a full stack.
const hexShot = {
  id: 'hex',
  speed: 700,
  radius: 10,
  lifetimeTicks: seconds(0.75),
  onHit: [
    slow(0.3, seconds(1)),
    damage(50),
    when<SimContext>(
      (sim, src) => curseStacksOnHit(sim, src) >= CURSE_MAX_STACKS,
      [
        damage(200),
        haste(0.75, seconds(2.5), self()),
        popMarkers(CURSE_KEY),
      ],
      [mark(CURSE_KEY, CURSE_DURATION_TICKS, subject(), { count: 2, cap: CURSE_MAX_STACKS })],
    ),
  ],
} satisfies EntityDef

// Capricorn's Tsunami: the wave is a rectangle, 70 wide across its path and 20 deep along it.
const tsunamiWave = {
  id: 'tsunami-wave',
  speed: 400,
  box: { halfLength: 10, halfWidth: 45 },
  lifetimeTicks: seconds(0.8),
  pierce: true,
  color: '#4fa8ff',
  // The push is at most 140, and no farther than 50 past where the wave stops.
  onHit: [damage(100), knockback(140, 700, subject(), { pastEnd: 50 }), interrupt()],
} satisfies EntityDef

// Soldier's Bolt: pierces everything in its line.
const soldierBolt = {
  id: 'bolt',
  speed: 720,
  radius: 12,
  lifetimeTicks: seconds(0.9),
  pierce: true,
  color: '#ffb347',
  onHit: [
    // 80 plus a fifth of the health the target is missing.
    damage(linear(80, 0.1, missingHealth())),
    slow(0.4, seconds(1.5)),
  ],
} satisfies EntityDef

const abilityList: AbilityDef[] = [
  {
    id: 'feast',
    description: 'Pops the curse stacks on the target. Each stack adds damage and haste, and refunds a fifth of this cooldown.',
    targeting: 'unit',
    range: 320,
    windUpTicks: 6,
    backswingTicks: 4,
    cooldownTicks: seconds(10),
    // Every amount below reads the stacks as they were before this cast pops them.
    apply: [
      damage(linear(75, 25, curseStacksOnTarget), targetUnit()),
      haste(linear(0, .15, curseStacksOnTarget), seconds(2.5), self()),
      refundCooldown('feast', linear(0, .8 / CURSE_MAX_STACKS, curseStacksOnTarget), self()),
      popMarkers(CURSE_KEY, targetUnit()),
    ],
  },
  {
    id: 'miasma',
    description: 'Leaves a field where you stand. Inside it you and your teammates move faster and enemies move slower.',
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
  },
  {
    id: 'hex',
    description: 'A line shot that slows and adds two curse stacks. Against a target already at five stacks it pops them for damage and haste.',
    targeting: 'direction',
    range: 520,
    windUpTicks: 12,
    backswingTicks: 4,
    cooldownTicks: seconds(8),
    indicator: { width: hexShot.radius * 2 },
    apply: [spawnEntity(hexShot)],
  },
  {
    id: 'leap',
    description: 'Dashes to the target point. While dashing you cannot attack or cast.',
    targeting: 'point',
    range: 120,
    windUpTicks: 0,
    backswingTicks: 0,
    cooldownTicks: seconds(8),
    movement: true,
    indicator: { line: true },
    apply: [dash(600, 120)],
  },
  {
    id: 'focus',
    description: 'For a few seconds your auto attacks are faster and reach farther.',
    targeting: 'none',
    range: 0,
    windUpTicks: 0,
    backswingTicks: 0,
    cooldownTicks: seconds(12),
    apply: [
      attackSpeedBonus(0.4, seconds(4)),
      attackRangeBonus(80, seconds(4)),
    ],
  },
  {
    id: 'snare',
    description: 'Lobs a canister to the target point. It takes longer the farther it goes, then leaves a small trap for a second that roots every enemy it lands on or that walks into it.',
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
  },
  {
    id: 'tsunami',
    description: 'Sends a wave of water forward. It damages enemies, knocks them back and interrupts what they were casting.',
    targeting: 'direction',
    range: 320,
    windUpTicks: 5,
    backswingTicks: 4,
    cooldownTicks: seconds(9),
    indicator: { width: tsunamiWave.box.halfWidth * 2 },
    apply: [spawnEntity(tsunamiWave)],
  },
  {
    id: 'bubbles',
    description: 'Fires a stream of three bubbles. On each target the first bubble to hit does full damage and the rest do half.',
    targeting: 'direction',
    range: 420,
    windUpTicks: 4,
    backswingTicks: 3,
    cooldownTicks: seconds(8),
    indicator: { width: bubble.radius * 2 },
    apply: [
      spawnEntity(bubble, { volley: { count: 3, intervalTicks: 8 } }),
    ],
  },
  {
    id: 'spout',
    description: 'Marks a small circle at the target point. After a brief warning it erupts, damaging and slowing enemies still standing in it.',
    targeting: 'point',
    range: 290,
    windUpTicks: 4,
    backswingTicks: 4,
    cooldownTicks: seconds(9),
    indicator: { radius: SPOUT_RADIUS },
    apply: [spawnEntity(spoutWarning, { at: aimPoint() })],
  },
  {
    id: 'stim',
    description: 'Costs you a chunk of health. For a few seconds you attack faster, move faster, and take less damage.',
    targeting: 'none',
    range: 0,
    windUpTicks: 0,
    backswingTicks: 0,
    cooldownTicks: seconds(18),
    apply: [
      loseHealth(100),
      attackSpeedBonus(0.5, seconds(5)),
      haste(0.3, seconds(5)),
      resist(0.3, seconds(5)),
    ],
  },
  {
    id: 'bolt',
    description: 'A bolt that pierces every enemy in a line and slows them. It hurts more the less health they have left.',
    targeting: 'direction',
    range: 650,
    windUpTicks: 5,
    backswingTicks: 3,
    cooldownTicks: seconds(7),
    indicator: { width: soldierBolt.radius * 2 },
    apply: [spawnEntity(soldierBolt)],
  },
  {
    id: 'medic',
    description: 'Summons a medical bot that hovers by you. Its shield lasts until it is broken, and the bot heals you over time until then. Casting again replaces it.',
    targeting: 'none',
    range: 0,
    windUpTicks: 3,
    backswingTicks: 3,
    cooldownTicks: seconds(24),
    apply: [
      shield(200, Infinity, self(), { shared: 'medic' }),
      spawnEntity(medicBot, { onePerOwner: true }),
    ],
  },
  {
    id: 'slash',
    description: 'Cuts a line in front of you, then leaves a fiery trail that slows enemies and speeds up you and your teammates. Each sword stack adds damage.',
    targeting: 'direction',
    range: SLASH_LENGTH,
    windUpTicks: 10,
    backswingTicks: 4,
    cooldownTicks: seconds(7),
    indicator: { width: slashTrail.box.halfWidth * 2 },
    apply: [
      damage(linear(60, 50, swordStacks), enemiesInLine(SLASH_LENGTH, SLASH_HALF_WIDTH)),
      // The trail's middle is half the cut's length ahead of the caster, pointing the same way.
      spawnEntity(slashTrail, { at: alongAim(SLASH_LENGTH / 2) }),
      popMarkers(SWORD_KEY, self()),
    ],
  },
  {
    id: 'radiance',
    description: 'Spends your sword stacks in an explosion of light around you. Each stack adds damage and move speed.',
    targeting: 'none',
    range: 0,
    windUpTicks: 8,
    backswingTicks: 2,
    cooldownTicks: seconds(12),
    apply: [
      damage(linear(75, 50, swordStacks), enemiesInRadius(170)),
      haste(linear(0, 0.15, swordStacks), seconds(2.5), self()),
      popMarkers(SWORD_KEY, self()),
      spawnEntity(lightBurst),
    ],
  },
  {
    id: 'shackle',
    description: 'Readies your next auto attack to spend your sword stacks on its target: it roots them, or stuns them if you had all three. Resets your auto attack, and can be used between autos.',
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
          [stun(seconds(1)),popMarkers(SWORD_KEY, self()),damage(linear(0, 50, swordStacks))],
          [root(seconds(1)),],
        ),
        
      ],
    },
    apply: [resetAutoTimer()],
  },
  {
    id: 'grenade',
    description: 'Lobs a grenade to the target point. It takes longer the farther it goes, then explodes, hurting enemies and bouncing them away from the middle of the blast. It bounces you away too if you are in it, and catching an enemy hands back half of this cooldown.',
    targeting: 'point',
    range: 300,
    windUpTicks: 4,
    backswingTicks: 4,
    cooldownTicks: seconds(9),
    indicator: { radius: GRENADE_RADIUS },
    apply: [spawnEntity(grenade)],
  },
  {
    id: 'molotov',
    description: 'Throws a molotov to the target point. It coats the ground in fire for a few seconds, slowing enemies in it and setting them alight.',
    targeting: 'point',
    range: 320,
    windUpTicks: 4,
    backswingTicks: 4,
    cooldownTicks: seconds(12),
    indicator: { radius: molotovFire.radius },
    apply: [
      spawnEntity({
        id: 'molotov-shot',
        speed: 500,
        radius: 7,
        landAtAim: true,
        color: '#ff7a2f',
        onExpire: [spawnEntity(molotovFire)],
      }),
    ],
  },
  {
    id: 'flashbang',
    description: 'Lobs a flashbang to the target point. It takes longer the farther it goes, then goes off: an enemy right under it is stunned, and one caught by the edge of the flash is briefly blinded, so their auto attacks miss.',
    targeting: 'point',
    range: 300,
    windUpTicks: 4,
    backswingTicks: 3,
    cooldownTicks: seconds(14),
    // Two circles: the whole flash, and the core inside it that stuns.
    indicator: { radius: FLASH_RADIUS, innerRadius: FLASH_CORE_RADIUS },
    apply: [spawnEntity(flashbang)],
  },
  {
    id: 'stick',
    description: 'Throws a stick to the point you aim at, anywhere from 150 to 360 away. It hurts enemies it passes through, then lands in the ground there, or against a wall, and stays. Walk over it to pick it up, which leaves this no more than a second to wait, or press this again to call it back, which hurts and slows enemies it passes on the way.',
    targeting: 'point',
    range: STICK_RANGE,
    minRange: STICK_MIN_RANGE,
    windUpTicks: 4,
    backswingTicks: 4,
    cooldownTicks: seconds(10),
    // Only one stick at a time. While it is out, this key calls it back instead.
    requires: { entity: 'stick', out: false },
    recast: 'recall',
    // A band as wide as the stick, from the thrower to where it will land.
    indicator: { line: true, width: stickShot.radius * 2 },
    apply: [spawnEntity(stickShot)],
  },
  {
    id: 'recall',
    description: 'Calls the stick back to you. It hurts and slows each enemy it passes through on the way. Calling it back does not refund the throw: only walking over the stick does.',
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
  },
  {
    id: 'hush',
    description: 'Readies your next auto attack to silence its target, so they cannot cast. That auto counts as an ability hit for your passive. Resets your auto attack, and can be used between autos.',
    targeting: 'none',
    range: 0,
    windUpTicks: 0,
    backswingTicks: 0,
    cooldownTicks: seconds(8),
    empowerAttack: { ticks: seconds(5), effects: [silence(seconds(1.5)), ...trickEffects] },
    apply: [resetAutoTimer()],
  },
  {
    id: 'warp',
    description: 'Blinks you to your stick, wherever it is, which picks it up and leaves your throw no more than a second to wait. With no stick on the ground, out or flying, but your throw on cooldown, it gives you the throw back instead.',
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
  },
  {
    id: 'shadowstep',
    description: 'Dashes to the target point. Each enemy you pass through is hurt and slowed as you pass, and the first also gives you a shadow stack (up to two) for an enhanced auto, gets most of this cooldown back and leaves a shadow where you cast it, which fades after 8 seconds. With a shadow out, this key dashes back to it instead.',
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
  },
  {
    id: 'shadowreturn',
    description: 'Dashes back to your shadow from any distance. Passing through an enemy does the same as Shadow Step and leaves a new shadow where you cast this; passing through none loses the shadow and puts Shadow Step on its whole cooldown. The shadow fades after 8 seconds, and then the key is Shadow Step again.',
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
  },
  {
    id: 'kunai',
    description: 'Throws a kunai in a line. It hurts and slows every enemy it passes through. With a shadow stack it spends one to hurt more and root instead.',
    targeting: 'direction',
    range: 150,
    windUpTicks: 4,
    backswingTicks: 3,
    cooldownTicks: seconds(7),
    indicator: { width: kunai.radius * 2 },
    apply: [
      when<SimContext>(
        (sim, src) => shadowStacks(sim, src) > 0,
        [spendShadowStack, spawnEntity(kunaiEnhanced)],
        [spawnEntity(kunai)],
      ),
    ],
  },
  {
    id: 'dodge',
    description: 'For a short time you move faster and dodge every auto attack aimed at you.',
    targeting: 'none',
    range: 0,
    windUpTicks: 0,
    backswingTicks: 0,
    cooldownTicks: seconds(12),
    apply: [haste(0.4, seconds(1.5)), dodge(seconds(1.5))],
  },
  // Monsters' abilities. A monster is a champion as far as the simulator goes, so its abilities are defined here like
  // any other, and listed on its monster (see monsters.ts); no player champion has them.
  {
    id: 'monster-slam',
    description: 'A placeholder monster ability: a heavy blow to everything round the caster.',
    targeting: 'none',
    range: 0,
    windUpTicks: 14,
    backswingTicks: 10,
    cooldownTicks: seconds(6),
    apply: [damage(60, enemiesInRadius(130))],
  },
]

export const abilityDefs: ReadonlyMap<string, AbilityDef> = new Map(
  abilityList.map((def) => [def.id, def]),
)

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
