import { GAME_TPS } from './constants.js'
import {
  aimPoint,
  alliesInBox,
  alliesInRadius,
  alongAim,
  attackRangeBonus,
  attackSpeedBonus,
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
  targetUnit,
  when,
  type Effect,
  type EntityDef,
  type SimContext,
} from './effects.js'
import type { CastTarget, Vector2 } from './index.js'

export interface AbilityDef {
  id: string
  // Shown on the champion select screen.
  description?: string
  targeting: CastTarget['mode']
  range: number
  windUpTicks: number
  backswingTicks: number
  cooldownTicks: number
  // The ability needs the caster to be able to move, so a root or stun stops it from starting.
  movement?: boolean
  // How big its indicator is drawn while it is aimed: the radius of the circle at a ground target,
  // or the width of the band along a skillshot. Without it the indicator only marks the aim.
  indicator?: { radius?: number; width?: number }
  apply: readonly Effect[]
}

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
export const SWORD_DAMAGE_PER_STACK = 25
const swordStacks = stacks(SWORD_KEY, self())

// Slash leaves a fiery trail: a rectangle exactly where the cut landed, 300 long and 60 wide.
// Its effects find who is inside it with the same half-extents as its box.
const slashTrail = {
  id: 'slash-trail',
  speed: 0,
  box: { halfLength: 175, halfWidth: 30 },
  lifetimeTicks: seconds(3),
  visual: 'field',
  color: '#ff8a3d',
  onTick: [
    slow(0.5, 2, enemiesInBox(150, 30)),
    haste(0.4, 2, alliesInBox(150, 30)),
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
export const EMPOWER_BONUS_DAMAGE = 70

// Capricorn's Bubbles: a stream of bubbles. For each target the first to hit does full damage
// and the rest do half. A short marker on the target remembers who was hit.
const BUBBLE_KEY = 'bubbled'
const BUBBLE_DAMAGE = 140
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
    damage(220, enemiesInRadius(SPOUT_RADIUS)),
    slow(0.4, seconds(.6), enemiesInRadius(SPOUT_RADIUS)),
    spawnEntity(spoutBurst),
  ],
}

const bubble = {
  id: 'bubble',
  speed: 550,
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

// Archer's Snare: a lob that flies to the aimed point, then leaves this field where it lands.
const snareField = {
  id: 'snare-field',
  speed: 0,
  radius: 120,
  lifetimeTicks: seconds(4),
  visual: 'field',
  color: '#6dd39b',
  onTick: [slow(0.4, 2, enemiesInRadius(120))],
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
    when<SimContext>(
      (sim, src) => curseStacksOnHit(sim, src) >= CURSE_MAX_STACKS,
      [
        damage(500),
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
  speed: 380,
  box: { halfLength: 10, halfWidth: 35 },
  lifetimeTicks: seconds(0.8),
  pierce: true,
  color: '#4fa8ff',
  // The push is at most 140, and no farther than 50 past where the wave stops.
  onHit: [damage(130), knockback(140, 700, subject(), { pastEnd: 50 }), interrupt()],
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
    damage(linear(80, 0.2, missingHealth())),
    slow(0.3, seconds(1.5)),
  ],
} satisfies EntityDef

const abilityList: AbilityDef[] = [
  {
    id: 'feast',
    description: 'Pops the curse stacks on the target. Each stack adds damage and haste, and refunds a fifth of this cooldown.',
    targeting: 'unit',
    range: 320,
    windUpTicks: 6,
    backswingTicks: 6,
    cooldownTicks: seconds(10),
    // Every amount below reads the stacks as they were before this cast pops them.
    apply: [
      damage(linear(150, 100, curseStacksOnTarget), targetUnit()),
      haste(linear(0, .15, curseStacksOnTarget), seconds(2.5), self()),
      refundCooldown('feast', linear(0, 1 / CURSE_MAX_STACKS, curseStacksOnTarget), self()),
      popMarkers(CURSE_KEY, targetUnit()),
    ],
  },
  {
    id: 'miasma',
    description: 'Leaves a field where you stand. Inside it you move faster and enemies move slower.',
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
          haste(0.25, 2, alliesInRadius(150)),
          slow(0.25, 2, enemiesInRadius(150)),
        ],
      }),
    ],
  },
  {
    id: 'hex',
    description: 'A line shot that slows and adds two curse stacks. Against a target already at five stacks it pops them for damage and haste.',
    targeting: 'direction',
    range: 520,
    windUpTicks: 8,
    backswingTicks: 4,
    cooldownTicks: seconds(8),
    indicator: { width: hexShot.radius * 2 },
    apply: [spawnEntity(hexShot)],
  },
  {
    id: 'leap',
    description: 'Dashes to the target point. While dashing you cannot attack or cast.',
    targeting: 'point',
    range: 280,
    windUpTicks: 0,
    backswingTicks: 0,
    cooldownTicks: seconds(8),
    movement: true,
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
    description: 'Lobs a canister to the target point. It takes longer the farther it goes, then bursts into a field that slows enemies.',
    targeting: 'point',
    range: 450,
    windUpTicks: 4,
    backswingTicks: 4,
    cooldownTicks: seconds(14),
    // The field it bursts into.
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
    range: 300,
    windUpTicks: 5,
    backswingTicks: 4,
    cooldownTicks: seconds(9),
    indicator: { width: tsunamiWave.box.halfWidth * 2 },
    apply: [spawnEntity(tsunamiWave)],
  },
  {
    id: 'bubbles',
    description: 'Fires a stream of five bubbles. On each target the first bubble to hit does full damage and the rest do half.',
    targeting: 'direction',
    range: 350,
    windUpTicks: 4,
    backswingTicks: 3,
    cooldownTicks: seconds(8),
    indicator: { width: bubble.radius * 2 },
    apply: [
      spawnEntity(bubble, { volley: { count: 3, intervalTicks: 5 } }),
    ],
  },
  {
    id: 'spout',
    description: 'Marks a small circle at the target point. After a brief warning it erupts, damaging and slowing enemies still standing in it.',
    targeting: 'point',
    range: 270,
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
      loseHealth(150),
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
      shield(250, Infinity, self(), { shared: 'medic' }),
      spawnEntity(medicBot, { onePerOwner: true }),
    ],
  },
  {
    id: 'slash',
    description: 'Cuts a line in front of you, then leaves a fiery trail that slows enemies and speeds you up. Each sword stack adds damage.',
    targeting: 'direction',
    range: 300,
    windUpTicks: 4,
    backswingTicks: 4,
    cooldownTicks: seconds(7),
    indicator: { width: slashTrail.box.halfWidth * 2 },
    apply: [
      damage(linear(120, SWORD_DAMAGE_PER_STACK, swordStacks), enemiesInLine(300, 30)),
      // The trail's middle is half the cut's length ahead of the caster, pointing the same way.
      spawnEntity(slashTrail, { at: alongAim(150) }),
    ],
  },
  {
    id: 'radiance',
    description: 'Spends your sword stacks in an explosion of light around you. Each stack adds damage and move speed.',
    targeting: 'none',
    range: 0,
    windUpTicks: 3,
    backswingTicks: 4,
    cooldownTicks: seconds(12),
    apply: [
      damage(linear(150, 100, swordStacks), enemiesInRadius(170)),
      haste(linear(0, 0.15, swordStacks), seconds(2.5), self()),
      popMarkers(SWORD_KEY, self()),
      spawnEntity(lightBurst),
    ],
  },
  {
    id: 'shackle',
    description: 'Spends your sword stacks to root an enemy, or stun them if you had all three. Resets your auto attack.',
    targeting: 'unit',
    range: 170,
    windUpTicks: 3, 
    backswingTicks: 3,
    cooldownTicks: seconds(10),
    apply: [
      when<SimContext>(
        (sim, src) => swordStacks(sim, src) >= SWORD_MAX_STACKS,
        [stun(seconds(1), targetUnit())],
        [root(seconds(1.5), targetUnit())],
      ),
      popMarkers(SWORD_KEY, self()),
      resetAutoTimer(),
    ],
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
