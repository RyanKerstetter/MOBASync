import {
  GAME_ATTACK_RANGE,
  GAME_PLAYER_SPEED,
  GAME_REMOTE_CATCHUP_EASE_TICKS,
  GAME_REMOTE_CATCHUP_MAX_SPEED_MULTIPLIER,
  GAME_ORDER_TIMEOUT_MS,
  GAME_TPS,
  getAttackCooldownTicks,
  ReliableMessageQueue,
  Simulator,
  type EntityOrder,
  type GameAttackOrder,
  type GameBroadcastOrder,
  type GameHealthResult,
  type GameEntitySnapshot,
  type GameOrder,
  type GameOrderAck,
  type GameProjectileSnapshot,
  type GameSnapshot,
  type MoveOrder,
  type Vector2,
} from '../../../packages/shared/src/index.ts'

export type TrackedOrder = {
  order: GameOrder
  status: 'pending' | 'accepted' | 'rejected' | 'timed-out'
  sentAt: number
}

export type PendingOrderUpdate = {
  retryOrders: GameOrder[]
  timedOutOrderSequences: number[]
}

export type RenderedEntity = GameEntitySnapshot & { position: Vector2 }
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
  private readonly orderStatuses = new Map<number, TrackedOrder>()
  private readonly outgoingOrders: ReliableMessageQueue<GameOrder>
  private readonly confirmedOrdersByEntity = new Map<number, Map<number, EntityOrder>>()
  private readonly renderedRemotePositions = new Map<number, RenderedRemotePosition>()
  private serverTick = 0
  private serverTickReceivedAt = performance.now()
  private nextOrderSequence = 1
  private rttSampleCount = 0
  private averageRttMs = 0
  private lastRttMs: number | undefined
  private lastServerUpdateAt = performance.now()

  constructor(orderTimeoutMs = GAME_ORDER_TIMEOUT_MS) {
    this.outgoingOrders = new ReliableMessageQueue(orderTimeoutMs)
  }

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
    if (tick < this.serverTick) return
    this.serverTick = tick
    this.serverTickReceivedAt = receivedAt - roundTripTimeMs / 2
    this.lastServerUpdateAt = receivedAt
  }

  recordPong(clientTime: number, serverTick: number, receivedAt = performance.now()): void {
    const sample = receivedAt - clientTime
    if (!Number.isFinite(sample) || sample < 0) return
    this.lastRttMs = sample
    this.rttSampleCount += 1
    this.averageRttMs += (sample - this.averageRttMs) / this.rttSampleCount
    this.setServerTick(serverTick, receivedAt)
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
      localPosition: localEntity?.posAt(this.estimateTick(now)),
    }
  }

  applySnapshot(snapshot: GameSnapshot, receivedAt = performance.now()): boolean {
    if (this.serverSnapshot && snapshot.tick <= this.serverSnapshot.tick) return false

    this.serverSnapshot = snapshot
    this.simulator.replaceFromSnapshot(snapshot)
    this.renderedRemotePositions.clear()
    this.setServerTick(snapshot.tick, receivedAt)
    this.confirmedOrdersByEntity.clear()
    for (const [entityId, entity] of this.simulator.entities) {
      if (entity.orders.length > 0) {
        this.confirmedOrdersByEntity.set(
          entityId,
          new Map(entity.orders.map((order) => [order.seq, order])),
        )
      }
    }

    const localEntity = this.localEntityId === undefined
      ? undefined
      : this.simulator.entities.get(this.localEntityId)
    const replicatedOrderSequences = new Set(
      localEntity?.orders.map((order) => order.seq) ?? [],
    )
    for (const [sequence, tracked] of this.localOrders) {
      if (replicatedOrderSequences.has(sequence)) {
        tracked.status = 'accepted'
        this.localOrders.delete(sequence)
        this.outgoingOrders.acknowledge(tracked.order.id, sequence)
      } else if (
        this.localEntityId !== undefined
        && tracked.order.type === 'move'
      ) {
        this.simulator.addOrder(this.localEntityId, tracked.order)
      }
    }
    return true
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
      clientTick: Math.floor(this.estimateTick(now)),
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
      clickTick: Math.floor(this.estimateTick(now)),
      targetId,
      type: 'attack',
    }
    this.nextOrderSequence += 1
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
    const attackStats = this.localEntityId === undefined
      ? undefined
      : this.simulator.entities.get(this.localEntityId)?.attackStats
    if (!attackStats) return 1
    const estimatedTick = this.estimateTick(now)
    const cooldownTicks = getAttackCooldownTicks(attackStats.attackSpeed)
    const cooldownStartTick = attackStats.nextAttackTick - cooldownTicks
    return Math.max(0, Math.min(
      1,
      (estimatedTick - cooldownStartTick) / cooldownTicks,
    ))
  }

  applyHealthResult(result: GameHealthResult): boolean {
    const entity = this.simulator.entities.get(result.targetId)
    const health = entity?.health
    if (!health || result.hpSeq <= health.hpSeq) return false
    health.hp = result.hpAfter
    health.shield = result.shieldAfter
    health.hpSeq = result.hpSeq
    return true
  }

  updatePendingOrders(
    now = performance.now(),
  ): PendingOrderUpdate {
    const update = this.outgoingOrders.update(now)
    const timedOutOrderSequences = update.timedOutMessages.map((order) => order.seq)
    for (const order of update.timedOutMessages) {
      const tracked = this.localOrders.get(order.seq)
      if (tracked?.order.id === order.id) {
        tracked.status = 'timed-out'
        this.localOrders.delete(order.seq)
      }
    }
    if (timedOutOrderSequences.length > 0) this.rebuildPredictedState()
    return {
      retryOrders: update.retryMessages.map(cloneGameOrder),
      timedOutOrderSequences,
    }
  }

  applyOrder(order: GameBroadcastOrder, receivedAt = performance.now()): boolean {
    const entityOrder: EntityOrder = order.type === 'move'
      ? order
      : {
        type: 'attack',
        tick: order.actionTick,
        seq: order.seq,
        stamp: order.stamp,
        position: order.position,
      }
    const applied = this.applySimulationOrder(order.entityId, entityOrder)
    this.setServerTick(order.serverTick, receivedAt)
    return applied
  }

  applyOrderAck(ack: GameOrderAck, receivedAt = performance.now()): void {
    const tracked = this.localOrders.get(ack.seq)
    this.setServerTick(ack.serverTick, receivedAt)
    if (!tracked || tracked.order.id !== ack.id) return

    if (ack.status === 'accepted') {
      tracked.status = 'accepted'
      this.localOrders.delete(ack.seq)
      this.outgoingOrders.acknowledge(ack.id, ack.seq)
      if (this.localEntityId !== undefined) {
        const entity = this.simulator.entities.get(this.localEntityId)
        if (tracked.order.type === 'move') {
          this.applySimulationOrder(this.localEntityId, tracked.order)
        } else if (entity) {
          const actionTick = ack.actionTick ?? ack.serverTick
          this.applySimulationOrder(this.localEntityId, {
            type: 'attack',
            tick: actionTick,
            seq: ack.seq,
            stamp: ack.stamp ?? actionTick,
            position: ack.position ?? entity.posAt(actionTick),
          })
        }
      }
    } else {
      tracked.status = 'rejected'
      this.localOrders.delete(ack.seq)
      this.outgoingOrders.acknowledge(ack.id, ack.seq)
      this.rebuildPredictedState()
    }
  }

  getOrderStatuses(): TrackedOrder[] {
    return [...this.orderStatuses.values()].map((tracked) => ({
      order: tracked.order.type === 'move'
        ? { ...tracked.order, target: { ...tracked.order.target } }
        : { ...tracked.order },
      status: tracked.status,
      sentAt: tracked.sentAt,
    }))
  }

  getEntities(now = performance.now()): RenderedEntity[] {
    const tick = this.estimateTick(now)
    const entities: RenderedEntity[] = []
    const activeEntityIds = new Set<number>()
    for (const entity of this.simulator.entities.values()) {
      activeEntityIds.add(entity.id)
      entities.push({
        ...entity.snapshot(),
        position: this.getRenderedEntityPosition(entity.id, tick, now),
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

  private getRenderedEntityPosition(entityId: number, tick: number, now: number): Vector2 {
    const entity = this.simulator.entities.get(entityId)
    if (!entity) return { x: 0, y: 0 }
    const target = entity.posAt(tick)
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

  private rebuildPredictedState(): void {
    if (!this.serverSnapshot) return
    this.simulator.replaceFromSnapshot(this.serverSnapshot)
    for (const [entityId, orders] of this.confirmedOrdersByEntity) {
      for (const order of orders.values()) this.simulator.addOrder(entityId, order)
    }
    if (this.localEntityId === undefined) return
    for (const tracked of this.localOrders.values()) {
      if (tracked.order.type === 'move') {
        this.simulator.addOrder(this.localEntityId, tracked.order)
      }
    }
  }

  private applySimulationOrder(entityId: number, order: EntityOrder): boolean {
    const entity = this.simulator.entities.get(entityId)
    if (!entity) return false
    const inserted = this.simulator.addOrder(entityId, order)
    const confirmedOrders = this.confirmedOrdersByEntity.get(entityId) ?? new Map()
    confirmedOrders.set(order.seq, order)
    this.confirmedOrdersByEntity.set(entityId, confirmedOrders)
    if (inserted && order.type === 'attack') {
      entity.attackStats?.recordAttackAt(order.stamp)
    }
    return true
  }

  private trackOrder(order: GameOrder, now: number): void {
    const tracked: TrackedOrder = {
      order,
      status: 'pending',
      sentAt: now,
    }
    this.outgoingOrders.track(order, now)
    this.localOrders.set(order.seq, tracked)
    this.orderStatuses.set(order.seq, tracked)
  }
}

function cloneGameOrder(order: GameOrder): GameOrder {
  return order.type === 'move'
    ? { ...order, target: { ...order.target } }
    : { ...order }
}
