import type {
  CastTarget,
  CharacterOrder,
  Marker,
  SimEntity,
  Status,
  Vector2,
} from './index.js'
import { GAME_TPS } from './constants.js'
import { boxTouchesCircle, type BoxShape } from './geometry.js'
import type { SimCharacter } from './simulator.js'

// 1. Capabilities: effects read through SimReader and write through SimWriter.
// Writes are buffered by the simulator and applied at the end of the tick, so
// every effect in a tick reads the same pre-write state.
export interface SimReader {
  readonly tick: number
  character(id: number): SimCharacter | undefined
  posAt(id: number, tick: number): Vector2 | undefined
  // Living units whose bodies overlap the circle, sorted by ID.
  unitsInRadius(center: Vector2, r: number, tick: number): number[]
  // A unit's markers with this key (optionally from one owner), as they stand before this
  // tick's writes. Stacks are one marker each.
  markersOn(unitId: number, key: string, ownerId?: number): Marker[]
  // A unit's health and its statuses, as they stand before this tick's writes.
  healthOf(unitId: number): { hp: number; maxHp: number } | undefined
  statusesOn(unitId: number): Status[]
}

export interface SimWriter {
  addStatus(unitId: number, s: Status): void
  addOrder(unitId: number, o: CharacterOrder): void
  addMarker(unitId: number, m: Marker): void
  // Removes every marker with this key that the owner placed on the unit (a pop).
  removeMarkers(unitId: number, key: string, ownerId: number): void
  // Starts a dash toward `target` at `speed` (distance per second) from the next tick.
  startDash(unitId: number, target: Vector2, speed: number): void
  addEntity(p: SimEntity): void
  emitEvent(e: GameEvent): void
}

export interface SimContext extends SimReader, SimWriter {}

export type GameEvent =
  | { type: 'damage'; id: string; rootId: string; ownerId: number; targetId: number; amount: number }
  | { type: 'reset-attack-timer'; id: string; rootId: string; ownerId: number; unitId: number }
  // Takes health straight off, ignoring shields and resistance, and never the last point.
  | { type: 'lose-health'; id: string; rootId: string; ownerId: number; unitId: number; amount: number }
  // Restores health up to the maximum. A unit already at 0 health is past saving.
  | { type: 'heal'; id: string; rootId: string; ownerId: number; unitId: number; amount: number }
  // Cancels a windup that has not launched yet. Nothing is spent and no stun is left behind.
  | { type: 'interrupt'; id: string; rootId: string; ownerId: number; unitId: number }
  // Takes `fraction` of the ability's full cooldown plus `ticks` off what remains.
  | { type: 'refund-cooldown'; id: string; rootId: string; ownerId: number; unitId: number; abilityId: string; fraction: number; ticks: number }

// 2. Provenance: plain data, built by whoever runs the effects.
export interface EffectSource {
  // Scopes record IDs: 'c:p1:4', 'c:p1:4:bolt:u2:t120'.
  id: string
  // The order that ultimately caused this (cancel by source, kill credit).
  rootId: string
  // Unit credited.
  ownerId: number
  tick: number
  // Where it's happening (cast origin, or entity position at hit).
  at: Vector2
  // Present for casts, and for auto attacks as a unit target; null for entity runs.
  aim: CastTarget | null
  // The unit hit, for on-hit runs.
  subject: number | null
  // For effects a moving entity runs: the point where its travel ends, such as how far a wave
  // would have gone.
  travelEnd?: Vector2
}

export type Effect<C = SimContext> = (sim: C, src: EffectSource) => void
export type Selector = (sim: SimReader, src: EffectSource) => number[]
export type Anchor = (sim: SimReader, src: EffectSource) => Vector2 | undefined
export type Amount = number | ((sim: SimReader, src: EffectSource) => number)

interface EntityDefBase {
  id: string
  // Distance per second. 0 makes a stationary entity such as a field.
  speed: number
  // A fixed timer. Leave it out when `landAtAim` is set, or when `stayWhile` is what ends it.
  lifetimeTicks?: number
  // Flies to the aimed point at `speed` and ends there on arrival, so its lifetime is the
  // travel time and grows with distance. Needs a point aim; use `lifetimeTicks` for a set timer.
  landAtAim?: boolean
  // Pierce hits every enemy once; otherwise the entity ends on its first hit.
  pierce?: boolean
  // Runs once for each enemy the entity touches. Without it the entity never collides.
  onHit?: readonly Effect[]
  // Runs every tick the entity exists, at its position, with a stable source ID so
  // statuses it applies are refreshed rather than stacked.
  onTick?: readonly Effect[]
  // Runs every `pulseEveryTicks` ticks after the first, at its position. Each pulse has its own
  // source ID, so markers and damage from different pulses are separate.
  onPulse?: readonly Effect[]
  pulseEveryTicks?: number
  // Runs once when the lifetime runs out, at the point it ended. Spawn a follow-up entity here.
  onExpire?: readonly Effect[]
  // Checked every tick; the entity ends the moment this is false (its onExpire does not run).
  // A summon can use it to end when the shield it came with is broken. An entity with neither
  // `lifetimeTicks` nor `landAtAim` has no timer, so this is the only thing that ends it.
  stayWhile?: (sim: SimReader, src: EffectSource) => boolean
  // The entity hangs on its owner by a spring instead of flying a straight line. It is pulled
  // toward a rest point (the owner's position plus `offset`) with an acceleration of `stiffness`
  // times its distance from the rest point, minus `damping` times its velocity, in px/s. A
  // damping below 2 * sqrt(stiffness) lets it swing past the rest point and back. Its own `speed`
  // must be 0; its velocity is the spring's, and it is stored on the entity with its position.
  follow?: { stiffness: number; damping: number; offset?: Vector2 }
  // How the client draws it: a small bolt (default), a large translucent field, or a warning
  // circle that fills in as the entity runs out its lifetime (a telegraph).
  visual?: 'bolt' | 'field' | 'telegraph'
  // Client-only fill colour for the drawing, for example '#6dd39b'.
  color?: string
}

// An entity has one shape: a circle (`radius`) or a rectangle (`box`), never both. A rectangle
// points the way it was aimed (or travels) and hits what it touches. Only entity hits use the
// shape; field selectors such as enemiesInRadius still read as circles.
export type EntityDef = EntityDefBase & (
  | { radius: number; box?: undefined }
  | { box: BoxShape; radius?: undefined }
)

const entityDefs = new Map<string, EntityDef>()

export function getEntityDef(id: string): EntityDef | undefined {
  return entityDefs.get(id)
}

export function runEffects<C>(effects: readonly Effect<C>[], sim: C, src: EffectSource): void {
  for (const effect of effects) effect(sim, src)
}

export function areEnemies(left: SimCharacter, right: SimCharacter): boolean {
  return left.player?.playerId !== right.player?.playerId
}

// Selectors

export const self = (): Selector => (_sim, src) => [src.ownerId]

export const subject = (): Selector => (_sim, src) =>
  src.subject === null ? [] : [src.subject]

export const targetUnit = (): Selector => (_sim, src) =>
  src.aim?.mode === 'unit' ? [src.aim.unitId] : []

export const castOrigin = (): Anchor => (_sim, src) => ({ ...src.at })

// The point `distance` along the aimed direction from the cast origin, such as the middle of a
// rectangle laid out in front of the caster.
export const alongAim = (distance: number): Anchor => (sim, src) => {
  const dir = aimDirection(sim, src)
  const facing = dir && normalized(dir)
  return facing
    ? { x: src.at.x + facing.x * distance, y: src.at.y + facing.y * distance }
    : undefined
}

export const aimPoint = (): Anchor => (_sim, src) =>
  src.aim?.mode === 'point' ? { ...src.aim.point } : undefined

export const alliesInRadius = (r: number, center: Anchor = castOrigin()): Selector => (sim, src) => {
  const at = center(sim, src)
  const owner = sim.character(src.ownerId)
  if (!at || !owner) return []
  return sim.unitsInRadius(at, r, src.tick).filter((unitId) => {
    const unit = sim.character(unitId)
    return Boolean(unit && !areEnemies(owner, unit))
  })
}

export const enemiesInRadius = (r: number, center: Anchor = castOrigin()): Selector => (sim, src) => {
  const at = center(sim, src)
  const owner = sim.character(src.ownerId)
  if (!at || !owner) return []
  return sim.unitsInRadius(at, r, src.tick).filter((unitId) => {
    const unit = sim.character(unitId)
    return Boolean(unit && areEnemies(owner, unit))
  })
}

// A unit vector along `dir`, or undefined for no direction.
function normalized(dir: Vector2): Vector2 | undefined {
  const length = Math.sqrt(dir.x * dir.x + dir.y * dir.y)
  return length === 0 ? undefined : { x: dir.x / length, y: dir.y / length }
}

// Units whose bodies touch a rectangle, split into enemies or allies of the caster.
function unitsTouchingBox(
  sim: SimReader,
  src: EffectSource,
  center: Vector2,
  facing: Vector2,
  box: BoxShape,
  wanted: 'enemies' | 'allies',
): number[] {
  const owner = sim.character(src.ownerId)
  if (!owner) return []
  const reach = Math.sqrt(box.halfLength * box.halfLength + box.halfWidth * box.halfWidth)
  return sim.unitsInRadius(center, reach, src.tick).filter((unitId) => {
    const unit = sim.character(unitId)
    const position = sim.posAt(unitId, src.tick)
    if (!unit || !position) return false
    if (areEnemies(owner, unit) !== (wanted === 'enemies')) return false
    return boxTouchesCircle(center, facing, box, position, unit.champion.radius)
  })
}

// Enemies whose bodies touch a rectangle laid from the cast origin along the aim: `length` long
// and `halfWidth` to either side, with square ends.
export const enemiesInLine = (length: number, halfWidth: number): Selector => (sim, src) => {
  const dir = aimDirection(sim, src)
  const facing = dir && normalized(dir)
  if (!facing) return []
  const center = { x: src.at.x + facing.x * length / 2, y: src.at.y + facing.y * length / 2 }
  return unitsTouchingBox(sim, src, center, facing, { halfLength: length / 2, halfWidth }, 'enemies')
}

// For effects an entity runs on itself: the units touching its own rectangle, centred on the
// entity and pointing the way it faces. They take the same half-extents as the entity's `box`.
export const enemiesInBox = (halfLength: number, halfWidth: number): Selector => (sim, src) => {
  const facing = src.aim?.mode === 'direction' ? normalized(src.aim.dir) : undefined
  return unitsTouchingBox(sim, src, src.at, facing ?? { x: 1, y: 0 }, { halfLength, halfWidth }, 'enemies')
}

export const alliesInBox = (halfLength: number, halfWidth: number): Selector => (sim, src) => {
  const facing = src.aim?.mode === 'direction' ? normalized(src.aim.dir) : undefined
  return unitsTouchingBox(sim, src, src.at, facing ?? { x: 1, y: 0 }, { halfLength, halfWidth }, 'allies')
}

// Effects

export const damage = (
  amount: Amount,
  to: Selector = subject(),
): Effect<SimReader & Pick<SimWriter, 'emitEvent'>> => (sim, src) => {
  for (const targetId of to(sim, src)) {
    // An amount that depends on the target (stacks on it) is read for each target in turn.
    const value = resolveAmount(amount, sim, { ...src, subject: targetId })
    sim.emitEvent({
      type: 'damage',
      id: `${src.id}:damage:u${targetId}`,
      rootId: src.rootId,
      ownerId: src.ownerId,
      targetId,
      amount: value,
    })
  }
}

export const slow = (
  fraction: Amount,
  durationTicks: number,
  to: Selector = subject(),
): Effect<SimReader & Pick<SimWriter, 'addStatus'>> => (sim, src) => {
  const amount = Math.max(0, Math.min(1, resolveAmount(fraction, sim, src)))
  for (const unitId of to(sim, src)) {
    sim.addStatus(unitId, {
      id: `${src.id}:slow`,
      kind: 'slow',
      rootId: src.rootId,
      ownerId: src.ownerId,
      startTick: src.tick,
      endTick: src.tick + durationTicks,
      amount,
    })
  }
}

// `shared` names the shield for its owner: `${ownerId}:shield:${shared}`. Effects can look it up
// by that ID, such as a summon that lives only as long as the shield does, and casting it again
// refreshes the shield instead of adding a second one. A duration of `Infinity` makes a shield
// that lasts until damage breaks it or its owner dies.
export const shield = (
  amount: Amount,
  durationTicks: number,
  to: Selector = self(),
  options: { shared?: string } = {},
): Effect<SimReader & Pick<SimWriter, 'addStatus'>> => (sim, src) => {
  const value = Math.max(0, Math.round(resolveAmount(amount, sim, src)))
  for (const unitId of to(sim, src)) {
    sim.addStatus(unitId, {
      id: options.shared === undefined ? `${src.id}:shield` : `${src.ownerId}:shield:${options.shared}`,
      kind: 'shield',
      rootId: src.rootId,
      ownerId: src.ownerId,
      startTick: src.tick,
      endTick: Number.isFinite(durationTicks) ? src.tick + durationTicks : Number.MAX_SAFE_INTEGER,
      amount: value,
    })
  }
}

// Places `count` markers (one per stack). A `cap` makes them a stack: only the newest that
// many of this key and owner stay on the unit, and applying more refreshes all of their timers.
export const mark = (
  key: string,
  durationTicks: number,
  to: Selector = subject(),
  options: { count?: number; cap?: number } = {},
): Effect<SimReader & Pick<SimWriter, 'addMarker'>> => (sim, src) => {
  const count = options.count ?? 1
  for (const unitId of to(sim, src)) {
    for (let index = 0; index < count; index += 1) {
      sim.addMarker(unitId, {
        id: `${src.id}:mark:${key}:${index}`,
        key,
        rootId: src.rootId,
        ownerId: src.ownerId,
        startTick: src.tick,
        endTick: src.tick + durationTicks,
        ...(options.cap === undefined ? {} : { cap: options.cap }),
      })
    }
  }
}

export const resetAutoTimer = (
  to: Selector = self(),
): Effect<SimReader & Pick<SimWriter, 'emitEvent'>> => (sim, src) => {
  for (const unitId of to(sim, src)) {
    sim.emitEvent({
      type: 'reset-attack-timer',
      id: `${src.id}:reset-attack-timer:u${unitId}`,
      rootId: src.rootId,
      ownerId: src.ownerId,
      unitId,
    })
  }
}

// The owner's attack damage stat, so an auto's damage is written once on the champion.
export const attackDamage = (): ((sim: SimReader, src: EffectSource) => number) => (sim, src) =>
  sim.character(src.ownerId)?.champion.attackDamage ?? 0

// Counts the owner's markers with this key on the first selected unit.
export const stacks = (
  key: string,
  on: Selector = subject(),
): ((sim: SimReader, src: EffectSource) => number) => (sim, src) => {
  const [unitId] = on(sim, src)
  return unitId === undefined ? 0 : sim.markersOn(unitId, key, src.ownerId).length
}

// base + each * of: scales an effect by another amount, such as a stack count.
export const linear = (
  base: Amount,
  each: number,
  of: Amount,
): ((sim: SimReader, src: EffectSource) => number) => (sim, src) =>
  resolveAmount(base, sim, src) + each * resolveAmount(of, sim, src)

export const when = <C extends SimReader>(
  condition: (sim: C, src: EffectSource) => boolean,
  then: readonly Effect<C>[],
  otherwise: readonly Effect<C>[] = [],
): Effect<C> => (sim, src) => {
  runEffects(condition(sim, src) ? then : otherwise, sim, src)
}

// `shared` makes every haste of that name from the same cast one status per unit, so several
// overlapping sources of one cast (the segments of a trail) refresh it instead of adding up.
export const haste = (
  fraction: Amount,
  durationTicks: number,
  to: Selector = self(),
  options: { shared?: string } = {},
): Effect<SimReader & Pick<SimWriter, 'addStatus'>> => (sim, src) => {
  const amount = Math.max(0, resolveAmount(fraction, sim, src))
  if (amount === 0) return
  for (const unitId of to(sim, src)) {
    sim.addStatus(unitId, {
      id: options.shared === undefined ? `${src.id}:haste` : `${src.rootId}:haste:${options.shared}`,
      kind: 'haste',
      rootId: src.rootId,
      ownerId: src.ownerId,
      startTick: src.tick,
      endTick: src.tick + durationTicks,
      amount,
    })
  }
}

// Damage resistance as a fraction (0.3 = takes 30% less). Resistances add, up to 90%.
export const resist = (
  fraction: Amount,
  durationTicks: number,
  to: Selector = self(),
): Effect<SimReader & Pick<SimWriter, 'addStatus'>> => (sim, src) => {
  const amount = Math.max(0, Math.min(1, resolveAmount(fraction, sim, src)))
  if (amount === 0) return
  for (const unitId of to(sim, src)) {
    sim.addStatus(unitId, {
      id: `${src.id}:resist`,
      kind: 'resist',
      rootId: src.rootId,
      ownerId: src.ownerId,
      startTick: src.tick,
      endTick: src.tick + durationTicks,
      amount,
    })
  }
}

// A health cost: it ignores shields and resistance and can bring a unit down to 1, never to 0.
export const loseHealth = (
  amount: Amount,
  to: Selector = self(),
): Effect<SimReader & Pick<SimWriter, 'emitEvent'>> => (sim, src) => {
  for (const unitId of to(sim, src)) {
    const value = Math.max(0, Math.round(resolveAmount(amount, sim, { ...src, subject: unitId })))
    if (value === 0) continue
    sim.emitEvent({
      type: 'lose-health',
      id: `${src.id}:lose-health:u${unitId}`,
      rootId: src.rootId,
      ownerId: src.ownerId,
      unitId,
      amount: value,
    })
  }
}

export const heal = (
  amount: Amount,
  to: Selector = self(),
): Effect<SimReader & Pick<SimWriter, 'emitEvent'>> => (sim, src) => {
  for (const unitId of to(sim, src)) {
    const value = Math.max(0, Math.round(resolveAmount(amount, sim, { ...src, subject: unitId })))
    if (value === 0) continue
    sim.emitEvent({
      type: 'heal',
      id: `${src.id}:heal:u${unitId}`,
      rootId: src.rootId,
      ownerId: src.ownerId,
      unitId,
      amount: value,
    })
  }
}

// How much health the first selected unit is missing, for damage that grows as a target weakens.
export const missingHealth = (
  on: Selector = subject(),
): ((sim: SimReader, src: EffectSource) => number) => (sim, src) => {
  const [unitId] = on(sim, src)
  const health = unitId === undefined ? undefined : sim.healthOf(unitId)
  return health ? health.maxHp - health.hp : 0
}

// Whether the hit unit is within `range` of the one dealing the damage, for effects that change
// with distance such as an attack that hits harder up close.
export const subjectWithin = (range: number) => (sim: SimReader, src: EffectSource): boolean => {
  if (src.subject === null) return false
  const from = sim.posAt(src.ownerId, src.tick)
  const to = sim.posAt(src.subject, src.tick)
  if (!from || !to) return false
  const dx = to.x - from.x
  const dy = to.y - from.y
  return Math.sqrt(dx * dx + dy * dy) <= range
}

// Crowd control. A root stops walking but not attacks or casts; a stun also stops those
// and interrupts a windup. Neither stops a dash that is already under way.
const crowdControl = (kind: 'root' | 'stun') => (
  durationTicks: number,
  to: Selector = subject(),
): Effect<SimReader & Pick<SimWriter, 'addStatus'>> => (sim, src) => {
  for (const unitId of to(sim, src)) {
    sim.addStatus(unitId, {
      id: `${src.id}:${kind}`,
      kind,
      rootId: src.rootId,
      ownerId: src.ownerId,
      startTick: src.tick,
      endTick: src.tick + durationTicks,
      amount: 1,
    })
  }
}

export const root = crowdControl('root')
export const stun = crowdControl('stun')

// Pushes units `distance` along the aim (a wave's travel direction), or away from the source
// when there is no direction. It is the same forced movement as a dash, so the target cannot
// attack or cast until it lands and a root does not hold it.
//
// With `pastEnd`, a push from a moving entity goes no farther than the end of that entity's
// travel plus this much, so something caught right at the end of a wave is not thrown as far as
// something caught early in it. The push is still never more than `distance`.
export const knockback = (
  distance: number,
  speed: number,
  to: Selector = subject(),
  options: { pastEnd?: number } = {},
): Effect<SimReader & Pick<SimWriter, 'startDash'>> => (sim, src) => {
  for (const unitId of to(sim, src)) {
    const from = sim.posAt(unitId, src.tick)
    if (!from) continue
    let dx = src.aim?.mode === 'direction' ? src.aim.dir.x : from.x - src.at.x
    let dy = src.aim?.mode === 'direction' ? src.aim.dir.y : from.y - src.at.y
    const length = Math.sqrt(dx * dx + dy * dy)
    if (length === 0) continue
    dx /= length
    dy /= length
    let push = distance
    if (options.pastEnd !== undefined && src.travelEnd) {
      // How much of the way to the end of the travel lies along the push; none if already past it.
      const toEnd = (src.travelEnd.x - from.x) * dx + (src.travelEnd.y - from.y) * dy
      push = Math.min(push, Math.max(0, toEnd) + options.pastEnd)
    }
    if (push <= 0) continue
    sim.startDash(unitId, { x: from.x + dx * push, y: from.y + dy * push }, speed)
  }
}

export const interrupt = (
  to: Selector = subject(),
): Effect<SimReader & Pick<SimWriter, 'emitEvent'>> => (sim, src) => {
  for (const unitId of to(sim, src)) {
    sim.emitEvent({
      type: 'interrupt',
      id: `${src.id}:interrupt:u${unitId}`,
      rootId: src.rootId,
      ownerId: src.ownerId,
      unitId,
    })
  }
}

// Attack speed bonus as a fraction (0.4 = 40% faster autos).
export const attackSpeedBonus = (
  fraction: Amount,
  durationTicks: number,
  to: Selector = self(),
): Effect<SimReader & Pick<SimWriter, 'addStatus'>> => (sim, src) => {
  const amount = Math.max(0, resolveAmount(fraction, sim, src))
  if (amount === 0) return
  for (const unitId of to(sim, src)) {
    sim.addStatus(unitId, {
      id: `${src.id}:attackspeed`,
      kind: 'attackspeed',
      rootId: src.rootId,
      ownerId: src.ownerId,
      startTick: src.tick,
      endTick: src.tick + durationTicks,
      amount,
    })
  }
}

// Extra auto attack range, in the same units as the champion's attackRange.
export const attackRangeBonus = (
  range: Amount,
  durationTicks: number,
  to: Selector = self(),
): Effect<SimReader & Pick<SimWriter, 'addStatus'>> => (sim, src) => {
  const amount = Math.max(0, resolveAmount(range, sim, src))
  if (amount === 0) return
  for (const unitId of to(sim, src)) {
    sim.addStatus(unitId, {
      id: `${src.id}:attackrange`,
      kind: 'attackrange',
      rootId: src.rootId,
      ownerId: src.ownerId,
      startTick: src.tick,
      endTick: src.tick + durationTicks,
      amount,
    })
  }
}

// Dashes toward the aim (a point, a direction, or a unit), at most `maxDistance` from where the
// unit stands when the effect runs. The dash itself runs in the simulator at a fixed speed.
export const dash = (
  speed: number,
  maxDistance: number,
  to: Selector = self(),
): Effect<SimReader & Pick<SimWriter, 'startDash'>> => (sim, src) => {
  for (const unitId of to(sim, src)) {
    const from = sim.posAt(unitId, src.tick)
    const aim = src.aim
    if (!from || !aim) continue
    const toward = aim.mode === 'point'
      ? aim.point
      : aim.mode === 'direction'
        ? { x: from.x + aim.dir.x * maxDistance, y: from.y + aim.dir.y * maxDistance }
        : aim.mode === 'unit'
          ? sim.posAt(aim.unitId, src.tick)
          : undefined
    if (!toward) continue
    const dx = toward.x - from.x
    const dy = toward.y - from.y
    const distance = Math.sqrt(dx * dx + dy * dy)
    if (distance === 0) continue
    const length = Math.min(distance, maxDistance)
    sim.startDash(unitId, { x: from.x + dx / distance * length, y: from.y + dy / distance * length }, speed)
  }
}

export const popMarkers = (
  key: string,
  to: Selector = subject(),
): Effect<SimReader & Pick<SimWriter, 'removeMarkers'>> => (sim, src) => {
  for (const unitId of to(sim, src)) sim.removeMarkers(unitId, key, src.ownerId)
}

export const refundCooldown = (
  abilityId: string,
  fraction: Amount,
  to: Selector = self(),
): Effect<SimReader & Pick<SimWriter, 'emitEvent'>> => (sim, src) => {
  const value = Math.max(0, Math.min(1, resolveAmount(fraction, sim, src)))
  if (value === 0) return
  for (const unitId of to(sim, src)) {
    sim.emitEvent({
      type: 'refund-cooldown',
      id: `${src.id}:refund-cooldown:${abilityId}:u${unitId}`,
      rootId: src.rootId,
      ownerId: src.ownerId,
      unitId,
      abilityId,
      fraction: value,
      ticks: 0,
    })
  }
}

// Takes a fixed number of ticks off what remains of an ability's cooldown.
export const reduceCooldown = (
  abilityId: string,
  ticks: Amount,
  to: Selector = self(),
): Effect<SimReader & Pick<SimWriter, 'emitEvent'>> => (sim, src) => {
  const value = Math.max(0, Math.round(resolveAmount(ticks, sim, src)))
  if (value === 0) return
  for (const unitId of to(sim, src)) {
    sim.emitEvent({
      type: 'refund-cooldown',
      id: `${src.id}:reduce-cooldown:${abilityId}:u${unitId}`,
      rootId: src.rootId,
      ownerId: src.ownerId,
      unitId,
      abilityId,
      fraction: 0,
      ticks: value,
    })
  }
}

// Registers the definition so frames can refer to it by ID. Each definition
// fires at most one entity per source, since its ID is scoped by src.id. With `onePerOwner`, the
// ID is scoped by the owner instead, so spawning again replaces the one already out. With `line`, a
// stationary definition is laid as `count` copies along the aim, such as the segments of a
// trail, starting at the cast origin.
export const spawnEntity = (
  def: EntityDef,
  options: {
    line?: { length: number; count: number }
    // `count` copies from the same spot, each starting `intervalTicks` after the last, such as
    // a stream of bubbles. They wait at the origin, unseen and untouchable, until their turn.
    volley?: { count: number; intervalTicks: number }
    // Where to spawn instead of the cast origin, for example `aimPoint()`.
    at?: Anchor
    onePerOwner?: boolean
  } = {},
): Effect<SimReader & Pick<SimWriter, 'addEntity'>> => {
  const registered = entityDefs.get(def.id)
  if (registered && registered !== def) {
    throw new Error(`Entity definition "${def.id}" is already registered.`)
  }
  if (def.lifetimeTicks === undefined && !def.landAtAim && !def.stayWhile) {
    throw new Error(`Entity definition "${def.id}" needs lifetimeTicks, landAtAim or stayWhile.`)
  }
  if ((def.radius === undefined) === (def.box === undefined)) {
    throw new Error(`Entity definition "${def.id}" needs either a radius or a box.`)
  }
  if (def.onPulse && !(def.pulseEveryTicks && def.pulseEveryTicks > 0)) {
    throw new Error(`Entity definition "${def.id}" has onPulse but no pulseEveryTicks.`)
  }
  if (def.follow && (def.speed !== 0 || def.landAtAim)) {
    throw new Error(`Entity definition "${def.id}" follows its owner, so it needs a speed of 0.`)
  }
  if (options.line && (def.speed !== 0 || def.landAtAim)) {
    throw new Error(`Entity definition "${def.id}" must be stationary to be laid along a line.`)
  }
  entityDefs.set(def.id, def)
  return (sim, src) => {
    const origin = options.at ? options.at(sim, src) : { ...src.at }
    if (!origin) return
    // A rectangle needs a heading: the aimed direction, or east when there is none.
    let facing: Vector2 | undefined
    if (def.box) {
      const aimed = aimDirection(sim, src) ?? { x: 1, y: 0 }
      const length = Math.sqrt(aimed.x * aimed.x + aimed.y * aimed.y)
      facing = length === 0 ? { x: 1, y: 0 } : { x: aimed.x / length, y: aimed.y / length }
    }
    const places: Array<{ at: Vector2; suffix: string; delay: number }> = []
    if (options.line) {
      const dir = aimDirection(sim, src)
      if (!dir) return
      const { length, count } = options.line
      for (let index = 0; index < count; index += 1) {
        const offset = (index + 0.5) * length / count
        places.push({
          at: { x: origin.x + dir.x * offset, y: origin.y + dir.y * offset },
          suffix: `:${index}`,
          delay: 0,
        })
      }
    } else if (options.volley) {
      for (let index = 0; index < options.volley.count; index += 1) {
        places.push({ at: { ...origin }, suffix: `:${index}`, delay: index * options.volley.intervalTicks })
      }
    } else {
      places.push({ at: origin, suffix: '', delay: 0 })
    }

    for (const place of places) {
      let velocity: Vector2
      let lifetimeTicks: number | undefined
      if (def.landAtAim) {
        if (src.aim?.mode !== 'point') return
        const dx = src.aim.point.x - place.at.x
        const dy = src.aim.point.y - place.at.y
        const distance = Math.sqrt(dx * dx + dy * dy)
        // Travel time follows the distance. The velocity is fitted to the whole ticks so the
        // entity ends exactly on the aimed point instead of overshooting by part of a tick.
        lifetimeTicks = Math.max(1, Math.round(distance / def.speed * GAME_TPS))
        velocity = { x: dx * GAME_TPS / lifetimeTicks, y: dy * GAME_TPS / lifetimeTicks }
      } else {
        const dir = def.speed === 0 ? { x: 0, y: 0 } : aimDirection(sim, src)
        if (!dir) return
        lifetimeTicks = def.lifetimeTicks
        velocity = { x: dir.x * def.speed, y: dir.y * def.speed }
      }
      sim.addEntity({
        id: `${options.onePerOwner ? src.ownerId : src.id}:${def.id}${place.suffix}`,
        defId: def.id,
        rootId: src.rootId,
        ownerId: src.ownerId,
        origin: place.at,
        velocity,
        startTick: src.tick + place.delay,
        ...(lifetimeTicks !== undefined ? { lifetimeTicks } : {}),
        hitIds: [],
        ...(facing ? { facing: { ...facing } } : {}),
      })
    }
  }
}

function resolveAmount(amount: Amount, sim: SimReader, src: EffectSource): number {
  return typeof amount === 'number' ? amount : amount(sim, src)
}

function aimDirection(sim: SimReader, src: EffectSource): Vector2 | undefined {
  const aim = src.aim
  if (aim?.mode === 'direction') return { ...aim.dir }
  const toward = aim?.mode === 'point'
    ? aim.point
    : aim?.mode === 'unit'
      ? sim.posAt(aim.unitId, src.tick)
      : undefined
  if (!toward) return undefined
  const dx = toward.x - src.at.x
  const dy = toward.y - src.at.y
  const length = Math.sqrt(dx * dx + dy * dy)
  return length === 0 ? undefined : { x: dx / length, y: dy / length }
}
