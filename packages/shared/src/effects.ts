import type {
  CastTarget,
  EntityOrder,
  Marker,
  SimProjectile,
  Status,
  Vector2,
} from './index.js'
import type { SimEntity } from './simulator.js'

// 1. Capabilities: effects read through SimReader and write through SimWriter.
// Writes are buffered by the simulator and applied at the end of the tick, so
// every effect in a tick reads the same pre-write state.
export interface SimReader {
  readonly tick: number
  entity(id: number): SimEntity | undefined
  posAt(id: number, tick: number): Vector2 | undefined
  // Living units whose bodies overlap the circle, sorted by ID.
  unitsInRadius(center: Vector2, r: number, tick: number): number[]
}

export interface SimWriter {
  addStatus(unitId: number, s: Status): void
  addOrder(unitId: number, o: EntityOrder): void
  addMarker(unitId: number, m: Marker): void
  spawnProjectile(p: SimProjectile): void
  emitEvent(e: GameEvent): void
}

export interface SimContext extends SimReader, SimWriter {}

export type GameEvent =
  | { type: 'damage'; id: string; rootId: string; ownerId: number; targetId: number; amount: number }
  | { type: 'reset-attack-timer'; id: string; rootId: string; ownerId: number; unitId: number }

// 2. Provenance: plain data, built by whoever runs the effects.
export interface EffectSource {
  // Scopes record IDs: 'c:p1:4', 'c:p1:4:bolt:u2:t120'.
  id: string
  // The order that ultimately caused this (cancel by source, kill credit).
  rootId: string
  // Unit credited.
  ownerId: number
  tick: number
  // Where it's happening (cast origin, or projectile position at hit).
  at: Vector2
  // Only present for casts.
  aim: CastTarget | null
  // The unit hit, for on-hit runs.
  subject: number | null
}

export type Effect<C = SimContext> = (sim: C, src: EffectSource) => void
export type Selector = (sim: SimReader, src: EffectSource) => number[]
export type Anchor = (sim: SimReader, src: EffectSource) => Vector2 | undefined
export type Amount = number | ((sim: SimReader, src: EffectSource) => number)

export interface ProjectileDef {
  id: string
  // Distance per second.
  speed: number
  radius: number
  lifetimeTicks: number
  // Pierce hits every enemy once; otherwise the projectile ends on its first hit.
  pierce?: boolean
  onHit: readonly Effect[]
}

const projectileDefs = new Map<string, ProjectileDef>()

export function getProjectileDef(id: string): ProjectileDef | undefined {
  return projectileDefs.get(id)
}

export function runEffects<C>(effects: readonly Effect<C>[], sim: C, src: EffectSource): void {
  for (const effect of effects) effect(sim, src)
}

export function areEnemies(left: SimEntity, right: SimEntity): boolean {
  return left.player?.playerId !== right.player?.playerId
}

// Selectors

export const self = (): Selector => (_sim, src) => [src.ownerId]

export const subject = (): Selector => (_sim, src) =>
  src.subject === null ? [] : [src.subject]

export const targetUnit = (): Selector => (_sim, src) =>
  src.aim?.mode === 'unit' ? [src.aim.unitId] : []

export const castOrigin = (): Anchor => (_sim, src) => ({ ...src.at })

export const aimPoint = (): Anchor => (_sim, src) =>
  src.aim?.mode === 'point' ? { ...src.aim.point } : undefined

export const enemiesInRadius = (r: number, center: Anchor = castOrigin()): Selector => (sim, src) => {
  const at = center(sim, src)
  const owner = sim.entity(src.ownerId)
  if (!at || !owner) return []
  return sim.unitsInRadius(at, r, src.tick).filter((unitId) => {
    const unit = sim.entity(unitId)
    return Boolean(unit && areEnemies(owner, unit))
  })
}

// Effects

export const damage = (
  amount: Amount,
  to: Selector = subject(),
): Effect<SimReader & Pick<SimWriter, 'emitEvent'>> => (sim, src) => {
  const value = resolveAmount(amount, sim, src)
  for (const targetId of to(sim, src)) {
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

export const shield = (
  amount: Amount,
  durationTicks: number,
  to: Selector = self(),
): Effect<SimReader & Pick<SimWriter, 'addStatus'>> => (sim, src) => {
  const value = Math.max(0, Math.round(resolveAmount(amount, sim, src)))
  for (const unitId of to(sim, src)) {
    sim.addStatus(unitId, {
      id: `${src.id}:shield`,
      kind: 'shield',
      rootId: src.rootId,
      ownerId: src.ownerId,
      startTick: src.tick,
      endTick: src.tick + durationTicks,
      amount: value,
    })
  }
}

export const mark = (
  key: string,
  durationTicks: number,
  to: Selector = subject(),
): Effect<SimReader & Pick<SimWriter, 'addMarker'>> => (sim, src) => {
  for (const unitId of to(sim, src)) {
    sim.addMarker(unitId, {
      id: `${src.id}:mark:${key}`,
      key,
      rootId: src.rootId,
      ownerId: src.ownerId,
      startTick: src.tick,
      endTick: src.tick + durationTicks,
    })
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

// Registers the definition so frames can refer to it by ID. Each definition
// fires at most one projectile per source, since its ID is scoped by src.id.
export const fireProjectile = (
  def: ProjectileDef,
): Effect<SimReader & Pick<SimWriter, 'spawnProjectile'>> => {
  const registered = projectileDefs.get(def.id)
  if (registered && registered !== def) {
    throw new Error(`Projectile definition "${def.id}" is already registered.`)
  }
  projectileDefs.set(def.id, def)
  return (sim, src) => {
    const dir = aimDirection(sim, src)
    if (!dir) return
    sim.spawnProjectile({
      id: `${src.id}:${def.id}`,
      defId: def.id,
      rootId: src.rootId,
      ownerId: src.ownerId,
      origin: { ...src.at },
      velocity: { x: dir.x * def.speed, y: dir.y * def.speed },
      startTick: src.tick,
      lifetimeTicks: def.lifetimeTicks,
      hitIds: [],
    })
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
