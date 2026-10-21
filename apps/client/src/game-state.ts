import {
  GAME_REMOTE_CATCHUP_EASE_TICKS,
  GAME_REMOTE_CATCHUP_MAX_SPEED_MULTIPLIER,
  GAME_REMOTE_RENDER_BUFFER_TICKS,
  GAME_SNAPSHOT_HISTORY_TICKS,
  GAME_TPS,
  FINALIZE_LAG,
  getAbilityDef,
  getProjectileDef,
  projectilePosAt,
  quantizeDirection,
  Simulator,
  type CastOrder,
  type CastTarget,
  type Champion,
  type EntityOrder,
  type GameAttackOrder,
  type GameBroadcastOrder,
  type GameDeath,
  type GameEntitySnapshot,
  type GameHealthStats,
  type GameTickSnapshot,
  type GameOrder,
  type GameOrderAck,
  type GameSnapshot,
  type MoveOrder,
  type SimProjectile,
  type Vector2,
} from '../../../packages/shared/src/index.ts'

export type TrackedOrder = {
  order: GameOrder
  sentAt: number
}

export type RenderedEntity =
  Pick<GameEntitySnapshot, 'id' | 'player'>
  & {
    champion: Champion
    health?: GameHealthStats
    // Base shield plus active shield statuses.
    totalShield: number
    position: Vector2
    // Set only by a death the server has confirmed; 0 health alone does not kill.
    dead: boolean
  }
export type RenderedProjectile = SimProjectile & { position: Vector2; radius: number }
export type AbilityCooldown = {
  slot: number
  abilityId: string
  ticksRemaining: number
  cooldownTicks: number
}
export type CastAttempt =
  | { ok: true; order: CastOrder }
  | { ok: false; reason: string }

// A remote champion that appears farther than this from where it was drawn has teleported
// (a respawn), so it is placed there directly instead of chased.
const REMOTE_SNAP_DISTANCE = 150

type RenderedRemotePosition = {
  position: Vector2
  updatedAt: number
}

export class ClientGameState {
  readonly simulator = new Simulator()
  private localEntityId: number | undefined
  private serverSnapshot: GameSnapshot | undefined
  private readonly localOrders = new Map<number, TrackedOrder>()
  private readonly renderedRemotePositions = new Map<number, RenderedRemotePosition>()
  private serverTick = 0
  private serverTickReceivedAt = performance.now()
  private nextOrderSequence = 1
  private lastIssuedTick = 0
  private rttSampleCount = 0
  private averageRttMs = 0
  private lastRttMs: number | undefined
  private lastServerUpdateAt = performance.now()

  setLocalEntityId(entityId: number): void {
    this.localEntityId = entityId
  }

  setNextOrderSequence(sequence: number): void {
    this.nextOrderSequence = sequence
  }

  setServerTick(
    tick: number,
    receivedAt = performance.now(),
    roundTripTimeMs = this.averageRttMs,
  ): void {
    if (tick <= this.serverTick) return
    this.serverTick = tick
    this.serverTickReceivedAt = receivedAt - roundTripTimeMs / 2
    this.lastServerUpdateAt = receivedAt
  }

  // Unlike setServerTick, this re-anchors even when the tick is not newer. Before
  // the game runs the server tick is frozen while the local estimate keeps
  // advancing, so the estimate must be reset when the game actually starts.
  resetServerTickAnchor(tick: number, receivedAt = performance.now()): void {
    this.serverTick = tick
    this.serverTickReceivedAt = receivedAt - this.averageRttMs / 2
    this.lastServerUpdateAt = receivedAt
    this.lastIssuedTick = 0
  }

  recordPong(clientTime: number, serverTick: number, receivedAt = performance.now()): void {
    const sample = receivedAt - clientTime
    if (!Number.isFinite(sample) || sample < 0) return
    this.lastRttMs = sample
    this.rttSampleCount += 1
    this.averageRttMs = this.rttSampleCount === 1
      ? sample
      : this.averageRttMs + (sample - this.averageRttMs) * 0.2
    this.setServerTick(serverTick, receivedAt, sample)
    const authoritativeTick = Math.max(this.simulator.tick, serverTick)
    this.simulator.advanceTo(authoritativeTick)
    this.simulator.setCommitTick(Math.max(
      this.simulator.commitTick,
      Math.min(authoritativeTick, serverTick - FINALIZE_LAG),
    ))
  }

  getAverageRttMs(): number {
    return this.averageRttMs
  }

  getDebugInfo(now = performance.now()): {
    estimatedTick: number
    serverTick: number
    tickAnchorAgeMs: number
    lastRttMs: number | undefined
    averageRttMs: number
    rttSampleCount: number
    pendingOrderCount: number
    oldestPendingOrderAgeMs: number | undefined
    localPosition: Vector2 | undefined
  } {
    const localEntity = this.localEntityId === undefined
      ? undefined
      : this.simulator.entities.get(this.localEntityId)
    const oldestPendingOrder = [...this.localOrders.values()]
      .reduce<TrackedOrder | undefined>(
        (oldest, current) => !oldest || current.sentAt < oldest.sentAt ? current : oldest,
        undefined,
      )
    return {
      estimatedTick: this.estimateTick(now),
      serverTick: this.serverTick,
      tickAnchorAgeMs: Math.max(0, now - this.lastServerUpdateAt),
      lastRttMs: this.lastRttMs,
      averageRttMs: this.averageRttMs,
      rttSampleCount: this.rttSampleCount,
      pendingOrderCount: this.localOrders.size,
      oldestPendingOrderAgeMs: oldestPendingOrder
        ? Math.max(0, now - oldestPendingOrder.sentAt)
        : undefined,
      localPosition: localEntity
        ? this.getSnapshotAtEstimatedTick(now).get(localEntity.id)?.getPosition()
        : undefined,
    }
  }

  applySnapshot(
    snapshot: GameSnapshot,
    receivedAt = performance.now(),
  ): { applied: boolean; confirmedOrders: GameOrder[] } {
    if (this.serverSnapshot && snapshot.tick < this.serverSnapshot.tick) {
      return { applied: false, confirmedOrders: [] }
    }

    this.serverSnapshot = snapshot
    this.simulator.replaceFromSnapshot(snapshot)
    this.setServerTick(snapshot.tick, receivedAt)

    const localEntity = this.localEntityId === undefined
      ? undefined
      : this.simulator.entities.get(this.localEntityId)
    const replicatedOrders = new Set(
      localEntity?.orders.map((order) => order.seq) ?? [],
    )
    const confirmedOrders: GameOrder[] = []
    for (const [sequence, tracked] of this.localOrders) {
      if (replicatedOrders.has(sequence)) {
        confirmedOrders.push(tracked.order)
        this.localOrders.delete(sequence)
      } else if (
        this.localEntityId !== undefined
        && tracked.order.tick > snapshot.commitTick
      ) {
        this.simulator.addOrder(this.localEntityId, tracked.order)
      }
    }
    return { applied: true, confirmedOrders }
  }

  createMoveOrder(target: Vector2, now = performance.now()): MoveOrder | undefined {
    if (this.localEntityId === undefined || !this.simulator.entities.has(this.localEntityId)) {
      return undefined
    }
    const entity = this.simulator.entities.get(this.localEntityId)
    if (!entity) return undefined
    const seq = this.nextOrderSequence
    const order: MoveOrder = {
      id: `${entity.player?.playerId ?? this.localEntityId}:${seq}`,
      seq,
      tick: this.nextOrderTick(now),
      type: 'move',
      target: { ...target },
    }
    this.nextOrderSequence += 1
    if (!this.simulator.addOrder(this.localEntityId, order)) return undefined
    this.trackOrder(order, now)
    return order
  }

  createAttackOrder(
    targetId: number,
    playerId: string,
    now = performance.now(),
  ): GameAttackOrder | undefined {
    if (
      this.localEntityId === undefined
      || !this.simulator.entities.has(this.localEntityId)
      || !this.simulator.entities.has(targetId)
    ) return undefined

    const seq = this.nextOrderSequence
    const order: GameAttackOrder = {
      id: `${playerId}:${seq}`,
      seq,
      tick: this.nextOrderTick(now),
      targetId,
      type: 'attack',
    }
    this.nextOrderSequence += 1
    if (!this.simulator.addOrder(this.localEntityId, order)) return undefined
    this.trackOrder(order, now)
    return order
  }

  // Aim is in arena coordinates. The ability is resolved from the slot now, so
  // the order names what was cast rather than which key was pressed.
  createCastOrder(
    slot: number,
    aim: Vector2,
    playerId: string,
    now = performance.now(),
  ): CastAttempt {
    const localEntityId = this.localEntityId
    const entity = localEntityId === undefined ? undefined : this.simulator.entities.get(localEntityId)
    if (localEntityId === undefined || !entity) return { ok: false, reason: 'Your champion is not available.' }
    const abilityId = entity.champion.abilityInSlot(slot)
    const def = abilityId === undefined ? undefined : getAbilityDef(abilityId)
    if (!def) return { ok: false, reason: 'No ability is bound to that key.' }

    const tick = this.nextOrderTick(now)
    const state = this.simulator.at(tick).get(localEntityId)
    if (!state) return { ok: false, reason: 'Your champion is not available.' }
    if (!state.getAbilityCooldown(def.id).ready) return { ok: false, reason: `${def.id} is on cooldown.` }
    const origin = state.getPosition()

    let target: CastTarget
    if (def.targeting === 'none') {
      target = { mode: 'none' }
    } else if (def.targeting === 'point') {
      const dx = aim.x - origin.x
      const dy = aim.y - origin.y
      const distance = Math.hypot(dx, dy)
      const scale = distance > def.range ? def.range / distance : 1
      target = { mode: 'point', point: { x: origin.x + dx * scale, y: origin.y + dy * scale } }
    } else if (def.targeting === 'direction') {
      const dir = quantizeDirection({ x: aim.x - origin.x, y: aim.y - origin.y })
      if (!dir) return { ok: false, reason: 'Aim away from your champion.' }
      target = { mode: 'direction', dir }
    } else {
      const unit = this.getEnemyNear(aim, now)
      if (!unit) return { ok: false, reason: `Aim ${def.id} at an enemy.` }
      target = { mode: 'unit', unitId: unit.id }
    }

    const seq = this.nextOrderSequence
    const order: CastOrder = {
      id: `${playerId}:${seq}`,
      seq,
      tick,
      type: 'cast',
      abilityId: def.id,
      target,
      origin,
    }
    this.nextOrderSequence += 1
    if (!this.simulator.addOrder(localEntityId, order)) {
      return { ok: false, reason: 'The cast could not be scheduled.' }
    }
    this.trackOrder(order, now)
    return { ok: true, order }
  }

  getAbilityCooldowns(now = performance.now()): AbilityCooldown[] {
    const localEntityId = this.localEntityId
    const entity = localEntityId === undefined ? undefined : this.simulator.entities.get(localEntityId)
    if (localEntityId === undefined || !entity) return []
    const snapshot = this.getSnapshotAtEstimatedTick(now)
    const state = snapshot.get(localEntityId)
    return entity.champion.abilities.flatMap((abilityId, slot) => {
      const def = getAbilityDef(abilityId)
      if (!def) return []
      return [{
        slot,
        abilityId,
        ticksRemaining: this.fractionalTicksRemaining(
          snapshot.tick,
          state?.getAbilityCooldown(abilityId).ticksRemaining ?? 0,
          now,
        ),
        cooldownTicks: def.cooldownTicks,
      }]
    })
  }

  getEnemyNear(point: Vector2, now = performance.now()): RenderedEntity | undefined {
    return this.getEntities(now)
      .filter((entity) => entity.id !== this.localEntityId && entity.player && !entity.dead)
      .map((entity) => ({
        entity,
        distance: Math.hypot(entity.position.x - point.x, entity.position.y - point.y),
      }))
      .filter(({ entity, distance }) => distance <= entity.champion.radius + 6)
      .sort((left, right) => left.distance - right.distance)[0]?.entity
  }

  getClosestEnemyInRange(now = performance.now()): RenderedEntity | undefined {
    if (this.localEntityId === undefined) return undefined
    const entities = this.getEntities(now)
    const local = entities.find((entity) => entity.id === this.localEntityId)
    if (!local) return undefined
    let closest: RenderedEntity | undefined
    let closestDistance = local.champion.attackRange
    for (const entity of entities) {
      if (!entity.player || entity.dead || entity.player.playerId === local.player?.playerId) continue
      const distance = Math.hypot(
        entity.position.x - local.position.x,
        entity.position.y - local.position.y,
      )
      if (distance <= closestDistance) {
        closest = entity
        closestDistance = distance
      }
    }
    return closest
  }

  getLocalEntityId(): number | undefined {
    return this.localEntityId
  }

  getLocalAttackRange(): number | undefined {
    return this.localEntityId === undefined
      ? undefined
      : this.simulator.entities.get(this.localEntityId)?.champion.attackRange
  }

  getAttackCooldownProgress(now = performance.now()): number {
    const localEntityId = this.localEntityId
    const champion = localEntityId === undefined
      ? undefined
      : this.simulator.entities.get(localEntityId)?.champion
    if (localEntityId === undefined || !champion) return 1
    const snapshot = this.getSnapshotAtEstimatedTick(now)
    const cooldown = snapshot.get(localEntityId)?.getCooldown()
    if (!cooldown) return 1
    const ticksRemaining = this.fractionalTicksRemaining(snapshot.tick, cooldown.ticksRemaining, now)
    return Math.max(0, Math.min(1, 1 - ticksRemaining / champion.attackCooldownTicks))
  }

  applyOrder(order: GameBroadcastOrder): boolean {
    const applied = this.applySimulationOrder(order.entityId, order)
    return applied
  }

  // Returns false when the death is too old to schedule, so the caller should resync.
  applyDeath(death: GameDeath): boolean {
    const entity = this.simulator.entities.get(death.entityId)
    if (!entity) return false
    if (entity.deaths.some(({ tick, respawnTick }) =>
      tick === death.tick && respawnTick === death.respawnTick)) return true
    return this.simulator.addDeath(death.entityId, {
      tick: death.tick,
      respawnTick: death.respawnTick,
    })
  }

  isLocalDead(now = performance.now()): boolean {
    if (this.localEntityId === undefined) return false
    return this.getSnapshotAtEstimatedTick(now).get(this.localEntityId)?.isDead() ?? false
  }

  applyOrderAck(ack: GameOrderAck, receivedAt = performance.now()): boolean {
    const tracked = this.localOrders.get(ack.seq)
    this.setServerTick(ack.serverTick, receivedAt)
    if (!tracked || tracked.order.id !== ack.id) return false

    if (ack.status === 'accepted') {
      this.localOrders.delete(ack.seq)
      return false
    } else {
      this.localOrders.delete(ack.seq)
      if (this.localEntityId === undefined) return true
      return !this.simulator.removeOrder(this.localEntityId, ack.seq)
    }
  }

  getEntities(now = performance.now()): RenderedEntity[] {
    const snapshot = this.getSnapshotAtEstimatedTick(now)
    const entities: RenderedEntity[] = []
    const activeEntityIds = new Set<number>()
    for (const entity of this.simulator.entities.values()) {
      activeEntityIds.add(entity.id)
      const state = snapshot.get(entity.id)
      const health = state?.getHealthState()
      entities.push({
        id: entity.id,
        ...(entity.player ? { player: { ...entity.player } } : {}),
        champion: entity.champion,
        ...(health ? { health } : {}),
        totalShield: state?.getShield() ?? 0,
        ...this.getRenderedEntityView(entity.id, now, snapshot),
      })
    }
    for (const entityId of this.renderedRemotePositions.keys()) {
      if (!activeEntityIds.has(entityId)) this.renderedRemotePositions.delete(entityId)
    }
    return entities
  }

  getProjectiles(now = performance.now()): RenderedProjectile[] {
    const snapshot = this.getSnapshotAtEstimatedTick(now)
    const renderTick = Math.max(snapshot.tick, this.estimateTick(now))
    return snapshot.getProjectiles().flatMap((projectile) => {
      const def = getProjectileDef(projectile.defId)
      return def
        ? [{ ...projectile, position: projectilePosAt(projectile, renderTick), radius: def.radius }]
        : []
    })
  }

  // Frames hold whole ticks, so reading a cooldown from one steps in 1/60 s
  // increments. Derive the ready tick, then measure it against the continuous estimate.
  private fractionalTicksRemaining(snapshotTick: number, ticksRemaining: number, now: number): number {
    if (ticksRemaining <= 0) return 0
    return Math.max(0, snapshotTick + ticksRemaining - this.estimateTick(now))
  }

  private estimateTick(now: number): number {
    return this.serverTick + Math.max(0, now - this.serverTickReceivedAt) * GAME_TPS / 1000
  }

  private getSnapshotAtEstimatedTick(now: number): GameTickSnapshot {
    return this.simulator.at(Math.max(
      this.simulator.latestSnapshotTick,
      Math.floor(this.estimateTick(now)),
    ))
  }

  private nextOrderTick(now: number): number {
    this.lastIssuedTick = Math.max(
      this.lastIssuedTick,
      this.simulator.commitTick + 1,
      this.simulator.latestSnapshotTick + 1,
      Math.floor(this.estimateTick(now)),
    )
    return this.lastIssuedTick
  }

  // Remote orders reach this client about one round trip after they were stamped, so a
  // remote champion drawn at the current tick gets corrected on every order. Drawing it
  // that far in the past means the orders that shape its path are already known.
  private getDelayedRemoteView(
    entityId: number,
    now: number,
    current: GameTickSnapshot,
  ): { position: Vector2; dead: boolean } {
    const fallback = {
      position: current.get(entityId)?.getPosition()
        ?? this.simulator.entities.get(entityId)?.initialPosition
        ?? { x: 0, y: 0 },
      dead: current.get(entityId)?.isDead() ?? false,
    }
    const delayTicks = Math.min(
      GAME_SNAPSHOT_HISTORY_TICKS - 2,
      this.averageRttMs * GAME_TPS / 1000 + GAME_REMOTE_RENDER_BUFFER_TICKS,
    )
    const oldestTick = Math.max(this.simulator.commitTick, current.tick - (GAME_SNAPSHOT_HISTORY_TICKS - 2))
    const renderTick = Math.max(oldestTick, Math.min(current.tick, this.estimateTick(now) - delayTicks))
    const lowerTick = Math.floor(renderTick)
    const fraction = renderTick - lowerTick
    try {
      const fromState = this.simulator.at(lowerTick).get(entityId)
      const from = fromState?.getPosition()
      if (!fromState || !from) return fallback
      const dead = fromState.isDead()
      if (fraction === 0 || lowerTick >= current.tick) return { position: from, dead }
      const to = this.simulator.at(lowerTick + 1).get(entityId)?.getPosition() ?? from
      // Interpolating across a respawn would slide the champion across the arena.
      if (Math.hypot(to.x - from.x, to.y - from.y) > REMOTE_SNAP_DISTANCE) return { position: from, dead }
      return {
        position: {
          x: from.x + (to.x - from.x) * fraction,
          y: from.y + (to.y - from.y) * fraction,
        },
        dead,
      }
    } catch (error) {
      if (error instanceof RangeError) return fallback
      throw error
    }
  }

  private getRenderedEntityView(
    entityId: number,
    now: number,
    snapshot: GameTickSnapshot,
  ): { position: Vector2; dead: boolean } {
    const entity = this.simulator.entities.get(entityId)
    if (!entity) return { position: { x: 0, y: 0 }, dead: false }
    if (entityId === this.localEntityId) {
      const state = snapshot.get(entityId)
      return { position: state?.getPosition() ?? entity.initialPosition, dead: state?.isDead() ?? false }
    }
    const { position: target, dead } = this.getDelayedRemoteView(entityId, now, snapshot)

    const rendered = this.renderedRemotePositions.get(entityId)
    if (!rendered) {
      this.renderedRemotePositions.set(entityId, {
        position: target,
        updatedAt: now,
      })
      return { position: target, dead }
    }

    const elapsedSeconds = Math.max(0, now - rendered.updatedAt) / 1000
    const dx = target.x - rendered.position.x
    const dy = target.y - rendered.position.y
    const distance = Math.hypot(dx, dy)
    if (distance > REMOTE_SNAP_DISTANCE) {
      rendered.position = target
      rendered.updatedAt = now
      return { position: target, dead }
    }
    if (distance === 0 || elapsedSeconds === 0) {
      rendered.updatedAt = now
      return { position: rendered.position, dead }
    }

    const moveSpeed = entity.champion.moveSpeed
    const distancePerTick = moveSpeed / GAME_TPS
    const positionErrorInTicks = distance / distancePerTick
    const catchupSpeedMultiplier = 1
      + (GAME_REMOTE_CATCHUP_MAX_SPEED_MULTIPLIER - 1)
      * (1 - Math.exp(-positionErrorInTicks / GAME_REMOTE_CATCHUP_EASE_TICKS))
    const catchupSpeed = moveSpeed * catchupSpeedMultiplier
    const step = Math.min(distance, catchupSpeed * elapsedSeconds)
    rendered.position = {
      x: rendered.position.x + dx / distance * step,
      y: rendered.position.y + dy / distance * step,
    }
    rendered.updatedAt = now
    return { position: rendered.position, dead }
  }

  private applySimulationOrder(entityId: number, order: EntityOrder): boolean {
    const entity = this.simulator.entities.get(entityId)
    if (!entity) return false
    return this.simulator.addOrder(entityId, order)
  }

  private trackOrder(order: GameOrder, now: number): void {
    const tracked: TrackedOrder = {
      order,
      sentAt: now,
    }
    this.localOrders.set(order.seq, tracked)
  }
}
