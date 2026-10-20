import {
  GAME_ATTACK_RANGE,
  GAME_PLAYER_SPEED,
  GAME_REMOTE_CATCHUP_EASE_TICKS,
  GAME_REMOTE_CATCHUP_MAX_SPEED_MULTIPLIER,
  GAME_TPS,
  FINALIZE_LAG,
  getAttackCooldownTicks,
  Simulator,
  type EntityOrder,
  type GameAttackOrder,
  type GameBroadcastOrder,
  type GameEntitySnapshot,
  type GameTickSnapshot,
  type GameOrder,
  type GameOrderAck,
  type GameProjectileSnapshot,
  type GameSnapshot,
  type MoveOrder,
  type Vector2,
} from '../../../packages/shared/src/index.ts'

export type TrackedOrder = {
  order: GameOrder
  sentAt: number
}

export type RenderedEntity =
  Pick<GameEntitySnapshot, 'id' | 'player' | 'health' | 'attackStats'>
  & { position: Vector2 }
export type RenderedProjectile = GameProjectileSnapshot & { position: Vector2 }

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
    this.renderedRemotePositions.clear()
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

  getClosestEnemyInRange(now = performance.now()): RenderedEntity | undefined {
    if (this.localEntityId === undefined) return undefined
    const entities = this.getEntities(now)
    const local = entities.find((entity) => entity.id === this.localEntityId)
    if (!local) return undefined
    let closest: RenderedEntity | undefined
    let closestDistance = local.attackStats?.attackRange ?? GAME_ATTACK_RANGE
    for (const entity of entities) {
      if (!entity.player || entity.player.playerId === local.player?.playerId) continue
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

  getLocalAttackRange(): number {
    return this.localEntityId === undefined
      ? GAME_ATTACK_RANGE
      : this.simulator.entities.get(this.localEntityId)?.attackStats?.attackRange ?? GAME_ATTACK_RANGE
  }

  getAttackCooldownProgress(now = performance.now()): number {
    const localEntityId = this.localEntityId
    const attackStats = localEntityId === undefined
      ? undefined
      : this.simulator.entities.get(localEntityId)?.attackStats
    if (localEntityId === undefined || !attackStats) return 1
    const state = this.getSnapshotAtEstimatedTick(now).get(localEntityId)
    const cooldown = state?.getCooldown()
    if (!cooldown) return 1
    const cooldownTicks = getAttackCooldownTicks(attackStats.attackSpeed)
    return Math.max(0, Math.min(1, 1 - cooldown.ticksRemaining / cooldownTicks))
  }

  applyOrder(order: GameBroadcastOrder): boolean {
    const applied = this.applySimulationOrder(order.entityId, order)
    return applied
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
      const health = snapshot.get(entity.id)?.getHealthState()
      entities.push({
        id: entity.id,
        ...(entity.player ? { player: { ...entity.player } } : {}),
        ...(entity.attackStats ? { attackStats: entity.attackStats.snapshot() } : {}),
        ...(health ? { health } : {}),
        position: this.getRenderedEntityPosition(entity.id, now, snapshot),
      })
    }
    for (const entityId of this.renderedRemotePositions.keys()) {
      if (!activeEntityIds.has(entityId)) this.renderedRemotePositions.delete(entityId)
    }
    return entities
  }

  getProjectiles(now = performance.now()): RenderedProjectile[] {
    const renderTick = this.estimateTick(now)
    return [...this.simulator.projectiles.values()]
      .filter((projectile) => renderTick < projectile.initialTick + projectile.lifetimeTicks)
      .map((projectile) => ({
        ...projectile.snapshot(),
        position: projectile.posAt(renderTick),
      }))
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

  private getRenderedEntityPosition(
    entityId: number,
    now: number,
    snapshot: GameTickSnapshot,
  ): Vector2 {
    const entity = this.simulator.entities.get(entityId)
    if (!entity) return { x: 0, y: 0 }
    const target = snapshot.get(entityId)?.getPosition()
      ?? entity.initialPosition
    if (entityId === this.localEntityId) return target

    const rendered = this.renderedRemotePositions.get(entityId)
    if (!rendered) {
      this.renderedRemotePositions.set(entityId, {
        position: target,
        updatedAt: now,
      })
      return target
    }

    const elapsedSeconds = Math.max(0, now - rendered.updatedAt) / 1000
    const dx = target.x - rendered.position.x
    const dy = target.y - rendered.position.y
    const distance = Math.hypot(dx, dy)
    if (distance === 0 || elapsedSeconds === 0) {
      rendered.updatedAt = now
      return rendered.position
    }

    const distancePerTick = GAME_PLAYER_SPEED / GAME_TPS
    const positionErrorInTicks = distance / distancePerTick
    const catchupSpeedMultiplier = 1
      + (GAME_REMOTE_CATCHUP_MAX_SPEED_MULTIPLIER - 1)
      * (1 - Math.exp(-positionErrorInTicks / GAME_REMOTE_CATCHUP_EASE_TICKS))
    const catchupSpeed = GAME_PLAYER_SPEED * catchupSpeedMultiplier
    const step = Math.min(distance, catchupSpeed * elapsedSeconds)
    rendered.position = {
      x: rendered.position.x + dx / distance * step,
      y: rendered.position.y + dy / distance * step,
    }
    rendered.updatedAt = now
    return rendered.position
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
