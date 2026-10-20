import {
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_ATTACK_DAMAGE,
  GAME_MAX_HP,
  GAME_MAX_SHIELD,
  GAME_ATTACK_RANGE,
  GAME_ATTACK_SPEED,
  GAME_PLAYER_RADIUS,
  GAME_PLAYER_SPEED,
  GAME_SNAPSHOT_HISTORY_TICKS,
  GAME_TPS,
  type EntityOrder,
  type GameAttackStats,
  type GameEntitySnapshot,
  type GameFrame,
  type GameFrameEntity,
  type GameHealthStats,
  type GameSnapshot,
  type GameProjectileSnapshot,
  type Vector2,
} from './index.js'

export class HealthStats implements GameHealthStats {
  readonly initialHp: number
  readonly initialShield: number
  hp: number
  maxHp: number
  shield: number
  hpSeq: number
  finalizedTick: number
  deathTick?: number

  constructor(stats: GameHealthStats) {
    this.initialHp = stats.hp
    this.initialShield = stats.shield
    this.hp = stats.hp
    this.maxHp = stats.maxHp
    this.shield = stats.shield
    this.hpSeq = stats.hpSeq
    this.finalizedTick = stats.finalizedTick
    this.deathTick = stats.deathTick
  }

  snapshot(): GameHealthStats {
    return {
      hp: this.hp,
      maxHp: this.maxHp,
      shield: this.shield,
      hpSeq: this.hpSeq,
      finalizedTick: this.finalizedTick,
      ...(this.deathTick === undefined ? {} : { deathTick: this.deathTick }),
    }
  }
}

export class AttackStats implements GameAttackStats {
  attackSpeed: number
  attackRange: number

  constructor(stats: GameAttackStats) {
    this.attackSpeed = stats.attackSpeed
    this.attackRange = stats.attackRange
  }

  snapshot(): GameAttackStats {
    return {
      attackSpeed: this.attackSpeed,
      attackRange: this.attackRange,
    }
  }

  canAttackAt(tick: number, nextAttackTick: number): boolean {
    return tick >= nextAttackTick
  }

  getCooldownTicks(): number {
    return Math.max(1, Math.ceil(GAME_TPS / this.attackSpeed))
  }
}

export class SimEntity {
  readonly orders: EntityOrder[]
  private lastOrderSequence: number

  constructor(
    readonly id: number,
    readonly initialPosition: Vector2,
    orders: EntityOrder[],
    readonly player?: GameEntitySnapshot['player'],
    readonly health?: HealthStats,
    readonly attackStats?: AttackStats,
    highestOrderSequence = 0,
  ) {
    this.orders = [...orders].sort(compareEntityOrders)
    this.lastOrderSequence = Math.max(
      highestOrderSequence,
      ...this.orders.map((order) => order.seq),
    )
  }

  get highestOrderSequence(): number {
    return this.lastOrderSequence
  }

  recordOrderSequence(seq: number): void {
    this.lastOrderSequence = Math.max(this.lastOrderSequence, seq)
  }

  snapshot(): GameEntitySnapshot {
    return {
      id: this.id,
      initialPosition: { ...this.initialPosition },
      orders: this.orders.map((order) => order.type === 'move'
        ? { ...order, target: { ...order.target } }
        : { ...order }),
      highestOrderSequence: this.highestOrderSequence,
      ...(this.health ? { health: this.health.snapshot() } : {}),
      ...(this.attackStats ? { attackStats: this.attackStats.snapshot() } : {}),
      ...(this.player ? { player: { ...this.player } } : {}),
    }
  }
}

export class EntityTickSnapshot {
  constructor(
    private readonly state: GameFrameEntity,
    private readonly tick: number,
  ) {}

  getPosition(): Vector2 {
    return { ...this.state.position }
  }

  getHealth(): number | undefined {
    return this.state.health?.hp
  }

  getHealthState(): GameHealthStats | undefined {
    return this.state.health ? { ...this.state.health } : undefined
  }

  getMaxHealth(): number | undefined {
    return this.state.health?.maxHp
  }

  getShield(): number | undefined {
    return this.state.health?.shield
  }

  getDeathTick(): number | undefined {
    return this.state.health?.deathTick
  }

  getNextAttackTick(): number {
    return this.state.nextAttackTick
  }

  getCooldown(): { ready: boolean; ticksRemaining: number } {
    return {
      ready: this.tick >= this.state.nextAttackTick,
      ticksRemaining: Math.max(0, this.state.nextAttackTick - this.tick),
    }
  }
}

export class GameTickSnapshot {
  private readonly entities: Map<number, EntityTickSnapshot>
  private readonly entityStates: Map<number, GameFrameEntity>
  private readonly attackValidity: Map<string, boolean>
  private readonly frame: GameFrame

  constructor(readonly tick: number, frame: GameFrame) {
    this.frame = {
      tick,
      entities: frame.entities.map(cloneFrameEntity),
      attackValidity: frame.attackValidity.map((entry) => ({ ...entry })),
    }
    this.entityStates = new Map(this.frame.entities.map((entity) => [
      entity.entityId,
      entity,
    ]))
    this.entities = new Map([...this.entityStates.values()].map((entity) => [
      entity.entityId,
      new EntityTickSnapshot(entity, tick),
    ]))
    this.attackValidity = new Map(this.frame.attackValidity.map((entry) => [
      orderKey(entry.entityId, entry.orderId),
      entry.valid,
    ]))
  }

  get(entityId: number): EntityTickSnapshot | undefined {
    return this.entities.get(entityId)
  }

  getAttackValidity(entityId: number, orderId: string): boolean | undefined {
    return this.attackValidity.get(orderKey(entityId, orderId))
  }

  getAttackValidityEntries(): GameFrame['attackValidity'] {
    return this.frame.attackValidity.map((entry) => ({ ...entry }))
  }

  getEntityState(entityId: number): GameFrameEntity | undefined {
    const entity = this.entityStates.get(entityId)
    return entity ? cloneFrameEntity(entity) : undefined
  }

  toData(): GameFrame {
    return {
      tick: this.frame.tick,
      entities: [...this.entityStates.values()]
        .sort((left, right) => left.entityId - right.entityId)
        .map(cloneFrameEntity),
      attackValidity: this.frame.attackValidity.map((entry) => ({ ...entry })),
    }
  }

  getEntityIds(): number[] {
    return [...this.entityStates.keys()].sort((left, right) => left - right)
  }
}

export class SimProjectile {
  constructor(
    readonly id: number,
    readonly initialPosition: Vector2,
    readonly initialTick: number,
    readonly velocity: Vector2,
    readonly lifetimeTicks: number,
  ) {}

  posAt(tick: number): Vector2 {
    const elapsedTicks = Math.max(0, Math.min(
      this.lifetimeTicks,
      tick - this.initialTick,
    ))
    return {
      x: this.initialPosition.x + this.velocity.x * elapsedTicks / GAME_TPS,
      y: this.initialPosition.y + this.velocity.y * elapsedTicks / GAME_TPS,
    }
  }

  snapshot(): GameProjectileSnapshot {
    return {
      id: this.id,
      initialPosition: { ...this.initialPosition },
      initialTick: this.initialTick,
      velocity: { ...this.velocity },
      lifetimeTicks: this.lifetimeTicks,
    }
  }
}

export class Simulator {
  readonly entities = new Map<number, SimEntity>()
  readonly projectiles = new Map<number, SimProjectile>()
  private readonly frameBuffer: Array<GameTickSnapshot | undefined> =
    new Array(GAME_SNAPSHOT_HISTORY_TICKS)
  private latestComputedTick = 0
  tick = 0
  commitTick = 0

  get latestSnapshotTick(): number {
    return this.latestComputedTick
  }

  constructor() {
    this.storeFrame(this.createInitialFrame())
  }

  addPlayer(
    id: number,
    playerId: string,
    name: string,
    position: Vector2,
  ): SimEntity {
    const entity = new SimEntity(id, clampPosition(position), [], { playerId, name }, new HealthStats({
      hp: GAME_MAX_HP,
      maxHp: GAME_MAX_HP,
      shield: GAME_MAX_SHIELD,
      hpSeq: 0,
      finalizedTick: 0,
    }), new AttackStats({
      attackSpeed: GAME_ATTACK_SPEED,
      attackRange: GAME_ATTACK_RANGE,
    }))
    this.entities.set(id, entity)
    if (this.tick === 0 && this.commitTick === 0) this.resetFrameHistory()
    return entity
  }

  addProjectile(
    id: number,
    position: Vector2,
    velocity: Vector2,
    lifetimeTicks = GAME_TPS * 3,
  ): SimProjectile {
    const projectile = new SimProjectile(
      id,
      { ...position },
      this.tick,
      { ...velocity },
      lifetimeTicks,
    )
    this.projectiles.set(id, projectile)
    return projectile
  }

  addOrder(entityId: number, order: EntityOrder): boolean {
    const entity = this.entities.get(entityId)
    if (!entity || order.tick <= this.commitTick) return false
    if (
      order.tick <= this.latestComputedTick
      && !this.getCachedFrame(order.tick - 1)
    ) return false
    if (entity.orders.some((existing) => existing.id === order.id)) return false
    entity.orders.push(order.type === 'move'
      ? { ...order, target: clampPosition(order.target) }
      : { ...order })
    entity.orders.sort((left, right) => compareEntityOrders(left, right, entity, entity))
    entity.recordOrderSequence(order.seq)
    this.invalidateFrom(order.tick)
    return true
  }

  removeOrder(entityId: number, seq: number): boolean {
    const entity = this.entities.get(entityId)
    if (!entity) return false
    const orderIndex = entity.orders.findIndex((order) => order.seq === seq)
    if (orderIndex < 0) return false
    const removedOrder = entity.orders[orderIndex]
    if (removedOrder.tick <= this.latestComputedTick && !this.getCachedFrame(removedOrder.tick - 1)) {
      return false
    }
    entity.orders.splice(orderIndex, 1)
    this.invalidateFrom(removedOrder.tick)
    return true
  }

  at(tick: number): GameTickSnapshot {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new RangeError('Snapshot tick must be a nonnegative safe integer.')
    }
    const cached = this.getCachedFrame(tick)
    if (cached) return cached
    if (tick <= this.latestComputedTick) {
      throw new RangeError(`Snapshot tick ${tick} is no longer in the ring buffer.`)
    }
    const previous = this.at(tick - 1)
    const frame = this.computeFrame(tick, previous)
    this.storeFrame(frame)
    return frame
  }

  setCommitTick(tick: number): void {
    if (!Number.isSafeInteger(tick) || tick < this.commitTick || tick > this.tick) {
      throw new RangeError('Commit tick must advance monotonically and not exceed the simulator tick.')
    }
    if (tick > this.latestComputedTick) this.at(tick)
    this.commitTick = tick
    for (const entity of this.entities.values()) {
      let index = 0
      while (index < entity.orders.length && entity.orders[index].tick < tick) {
        index += 1
      }
      entity.orders.splice(0, index)
    }
  }

  reset(): void {
    this.entities.clear()
    this.projectiles.clear()
    this.tick = 0
    this.commitTick = 0
    this.resetFrameHistory()
  }

  remove(entityId: number): void {
    this.entities.delete(entityId)
    this.invalidateFrom(Math.max(this.commitTick + 1, this.tick))
  }

  removeProjectile(projectileId: number): void {
    this.projectiles.delete(projectileId)
  }

  advanceTo(tick: number): void {
    if (!Number.isSafeInteger(tick) || tick < this.tick) {
      throw new RangeError('Simulator tick must be a safe integer that does not go backwards.')
    }
    if (tick > this.latestComputedTick) this.at(tick)
    this.tick = Math.max(this.tick, tick, this.latestComputedTick)
    for (const projectile of this.projectiles.values()) {
      if (this.tick >= projectile.initialTick + projectile.lifetimeTicks) {
        this.projectiles.delete(projectile.id)
      }
    }
  }

  snapshot(): GameSnapshot {
    const currentFrame = this.at(this.tick)
    const history: GameFrame[] = []
    const oldestTick = Math.max(0, this.tick - this.frameBuffer.length + 1)
    for (let frameTick = oldestTick; frameTick <= this.tick; frameTick += 1) {
      const frame = this.getCachedFrame(frameTick)
      if (frame) history.push(this.toFrameData(frame))
    }
    return {
      tick: this.tick,
      commitTick: this.commitTick,
      entities: [...this.entities.values()].map((entity) => entity.snapshot()),
      projectiles: [...this.projectiles.values()].map((projectile) => projectile.snapshot()),
      history: history.length > 0 ? history : [this.toFrameData(currentFrame)],
    }
  }

  replaceFromSnapshot(snapshot: GameSnapshot): void {
    this.entities.clear()
    this.projectiles.clear()
    this.tick = snapshot.tick
    this.commitTick = snapshot.commitTick
    for (const entity of snapshot.entities) {
      this.entities.set(entity.id, new SimEntity(
        entity.id,
        entity.initialPosition,
        entity.orders,
        entity.player,
        entity.health ? new HealthStats(entity.health) : undefined,
        entity.attackStats ? new AttackStats(entity.attackStats) : undefined,
        entity.highestOrderSequence,
      ))
    }
    this.frameBuffer.fill(undefined)
    for (const frameData of snapshot.history) {
      this.storeFrame(new GameTickSnapshot(frameData.tick, frameData))
    }
    this.latestComputedTick = snapshot.tick
    if (!this.getCachedFrame(snapshot.tick)) {
      throw new RangeError('Snapshot history must include its current tick.')
    }
    for (const projectile of snapshot.projectiles) {
      this.projectiles.set(projectile.id, new SimProjectile(
        projectile.id,
        projectile.initialPosition,
        projectile.initialTick,
        projectile.velocity,
        projectile.lifetimeTicks,
      ))
    }
  }

  private computeFrame(tick: number, previous: GameTickSnapshot): GameTickSnapshot {
    const states = new Map<number, GameFrameEntity>()
    for (const entityId of previous.getEntityIds()) {
      const entity = this.entities.get(entityId)
      const prior = this.getCachedFrameEntity(previous, entityId)
      if (!entity || !prior) continue
      const movement = prior.movement ? { ...prior.movement } : undefined
      states.set(entityId, {
        ...prior,
        position: movement ? positionAtMove(movement, tick) : prior.position,
        ...(movement ? { movement } : {}),
      })
    }
    for (const entity of this.entities.values()) {
      if (states.has(entity.id)) continue
      states.set(entity.id, this.createInitialEntityFrame(entity))
    }

    const orders = [...this.entities.values()].flatMap((entity) =>
      entity.orders
        .filter((order) => order.tick === tick)
        .map((order) => ({ entity, order })),
    )
    orders.sort((left, right) =>
      compareEntityOrders(left.order, right.order, left.entity, right.entity),
    )
    const attackValidity: GameFrame['attackValidity'] = []
    const validAttacks: number[] = []
    for (const { entity, order } of orders) {
      const state = states.get(entity.id)
      if (!state) continue
      if (order.type === 'move') {
        state.movement = {
          origin: { ...state.position },
          target: clampPosition(order.target),
          startTick: tick,
        }
        continue
      }

      const target = this.entities.get(order.targetId)
      const targetState = target ? states.get(target.id) : undefined
      const attackStats = entity.attackStats
      const dx = targetState ? state.position.x - targetState.position.x : 0
      const dy = targetState ? state.position.y - targetState.position.y : 0
      const valid = Boolean(
        target
        && target.player?.playerId !== entity.player?.playerId
        && targetState?.health
        && targetState.health.hp > 0
        && targetState.health.deathTick === undefined
        && state.health
        && state.health.hp > 0
        && state.health.deathTick === undefined
        && attackStats
        && attackStats.canAttackAt(tick, state.nextAttackTick)
        && Math.sqrt(dx * dx + dy * dy) <= attackStats.attackRange,
      )
      attackValidity.push({ entityId: entity.id, orderId: order.id, valid })
      if (!valid || !target) continue

      state.movement = undefined
      state.nextAttackTick = tick + (attackStats?.getCooldownTicks() ?? 0)
      validAttacks.push(target.id)
    }
    for (const targetId of validAttacks) {
      const targetState = states.get(targetId)
      const health = targetState?.health
      if (!health || health.deathTick !== undefined) continue
      const shieldDamage = Math.min(health.shield, GAME_ATTACK_DAMAGE)
      health.shield -= shieldDamage
      health.hp = Math.max(0, health.hp - (GAME_ATTACK_DAMAGE - shieldDamage))
      health.hpSeq += 1
      health.finalizedTick = tick
      if (health.hp === 0) health.deathTick = tick
    }
    return new GameTickSnapshot(tick, {
      tick,
      entities: [...states.values()].sort((left, right) => left.entityId - right.entityId),
      attackValidity,
    })
  }

  private createInitialFrame(): GameTickSnapshot {
    return new GameTickSnapshot(0, {
      tick: 0,
      entities: [...this.entities.values()]
        .sort((left, right) => left.id - right.id)
        .map((entity) => this.createInitialEntityFrame(entity)),
      attackValidity: [],
    })
  }

  private createInitialEntityFrame(entity: SimEntity): GameFrameEntity {
    const health = entity.health
    return {
      entityId: entity.id,
      position: { ...entity.initialPosition },
      ...(health ? { health: {
        ...health.snapshot(),
        hp: health.initialHp,
        shield: health.initialShield,
        hpSeq: 0,
        finalizedTick: 0,
      } } : {}),
      nextAttackTick: 0,
    }
  }

  private getCachedFrameEntity(
    frame: GameTickSnapshot,
    entityId: number,
  ): GameFrameEntity | undefined {
    return frame.getEntityState(entityId)
  }

  private toFrameData(frame: GameTickSnapshot): GameFrame {
    return frame.toData()
  }

  private storeFrame(frame: GameTickSnapshot): void {
    this.frameBuffer[frame.tick % this.frameBuffer.length] = frame
    this.latestComputedTick = Math.max(this.latestComputedTick, frame.tick)
  }

  private getCachedFrame(tick: number): GameTickSnapshot | undefined {
    const frame = this.frameBuffer[tick % this.frameBuffer.length]
    return frame?.tick === tick ? frame : undefined
  }

  private invalidateFrom(tick: number): void {
    if (tick > this.latestComputedTick) return
    if (tick === 0) {
      this.resetFrameHistory()
      return
    }
    for (let frameTick = tick; frameTick <= this.latestComputedTick; frameTick += 1) {
      const slot = frameTick % this.frameBuffer.length
      if (this.frameBuffer[slot]?.tick === frameTick) this.frameBuffer[slot] = undefined
    }
    this.latestComputedTick = tick - 1
  }

  private resetFrameHistory(): void {
    this.frameBuffer.fill(undefined)
    this.latestComputedTick = 0
    this.storeFrame(this.createInitialFrame())
  }
}

function compareEntityOrders(
  left: EntityOrder,
  right: EntityOrder,
  leftEntity?: SimEntity,
  rightEntity?: SimEntity,
): number {
  if (left.tick !== right.tick) return left.tick - right.tick
  if (left.seq !== right.seq) return left.seq - right.seq
  const leftPlayerId = leftEntity?.player?.playerId ?? ''
  const rightPlayerId = rightEntity?.player?.playerId ?? ''
  if (leftPlayerId < rightPlayerId) return -1
  if (leftPlayerId > rightPlayerId) return 1
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  if (leftEntity && rightEntity && leftEntity.id !== rightEntity.id) {
    return leftEntity.id - rightEntity.id
  }
  return 0
}

function orderKey(entityId: number, orderId: string): string {
  return `${entityId}/${orderId}`
}

function cloneFrameEntity(entity: GameFrameEntity): GameFrameEntity {
  return {
    ...entity,
    position: { ...entity.position },
    ...(entity.health ? { health: { ...entity.health } } : {}),
    ...(entity.movement ? {
      movement: {
        origin: { ...entity.movement.origin },
        target: { ...entity.movement.target },
        startTick: entity.movement.startTick,
      },
    } : {}),
  }
}

function positionAtMove(
  movement: { origin: Vector2; target: Vector2; startTick: number },
  tick: number,
): Vector2 {
  const dx = movement.target.x - movement.origin.x
  const dy = movement.target.y - movement.origin.y
  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance === 0) return { ...movement.target }

  const progress = Math.min(1, Math.max(0, (tick - movement.startTick) * GAME_PLAYER_SPEED / GAME_TPS / distance))
  return clampPosition({
    x: movement.origin.x + dx * progress,
    y: movement.origin.y + dy * progress,
  })
}

function clampPosition(position: Vector2): Vector2 {
  return {
    x: Math.max(GAME_PLAYER_RADIUS, Math.min(GAME_ARENA_WIDTH - GAME_PLAYER_RADIUS, position.x)),
    y: Math.max(GAME_PLAYER_RADIUS, Math.min(GAME_ARENA_HEIGHT - GAME_PLAYER_RADIUS, position.y)),
  }
}
