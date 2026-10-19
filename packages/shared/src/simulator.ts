import {
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_MAX_HP,
  GAME_MAX_SHIELD,
  GAME_ATTACK_RANGE,
  GAME_ATTACK_SPEED,
  GAME_PLAYER_RADIUS,
  GAME_PLAYER_SPEED,
  GAME_TPS,
  type EntityOrder,
  type GameAttackStats,
  type GameEntitySnapshot,
  type GameHealthStats,
  type GameProjectileSnapshot,
  type GameSnapshot,
  type Vector2,
} from './index.js'

export type PendingHpEffect = {
  id: string
  tick: number
  amount: number
  priority: number
  stamp: number
  seq: number
  attackerId: string
}

export class HealthStats implements GameHealthStats {
  readonly pendingHp: PendingHpEffect[] = []
  hp: number
  maxHp: number
  shield: number
  hpSeq: number
  finalizedTick: number
  deathTick?: number

  constructor(stats: GameHealthStats) {
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
  nextAttackTick: number
  private readonly acceptedAttackTicks: number[] = []

  constructor(stats: GameAttackStats) {
    this.attackSpeed = stats.attackSpeed
    this.attackRange = stats.attackRange
    this.nextAttackTick = stats.nextAttackTick
    const cooldownTicks = Math.max(1, Math.ceil(GAME_TPS / this.attackSpeed))
    if (this.nextAttackTick >= cooldownTicks) {
      this.acceptedAttackTicks.push(this.nextAttackTick - cooldownTicks)
    }
  }

  snapshot(): GameAttackStats {
    return {
      attackSpeed: this.attackSpeed,
      attackRange: this.attackRange,
      nextAttackTick: this.nextAttackTick,
    }
  }

  canAttackAt(stamp: number, nowTick: number, backdateCapTicks: number): boolean {
    const cooldownTicks = Math.max(1, Math.ceil(GAME_TPS / this.attackSpeed))
    const oldestRelevantTick = nowTick - backdateCapTicks - cooldownTicks
    while (
      this.acceptedAttackTicks.length > 0
      && this.acceptedAttackTicks[0] < oldestRelevantTick
    ) {
      this.acceptedAttackTicks.shift()
    }
    return this.acceptedAttackTicks.every(
      (acceptedTick) => Math.abs(stamp - acceptedTick) >= cooldownTicks,
    )
  }

  recordAttackAt(stamp: number): void {
    if (this.acceptedAttackTicks.includes(stamp)) return
    this.acceptedAttackTicks.push(stamp)
    this.acceptedAttackTicks.sort((left, right) => left - right)
    this.nextAttackTick = Math.max(
      this.nextAttackTick,
      stamp + Math.max(1, Math.ceil(GAME_TPS / this.attackSpeed)),
    )
  }
}

export class SimEntity {
  readonly orders: EntityOrder[]

  constructor(
    readonly id: number,
    readonly initialPosition: Vector2,
    orders: EntityOrder[],
    readonly player?: GameEntitySnapshot['player'],
    readonly health?: HealthStats,
    readonly attackStats?: AttackStats,
  ) {
    this.orders = [...orders].sort(compareEntityOrders)
  }

  get highestOrderSequence(): number {
    return this.orders.reduce((highest, order) => Math.max(highest, order.seq), 0)
  }

  get latestOrderTick(): number {
    return this.orders.reduce((latest, order) => Math.max(latest, getEntityOrderTick(order)), 0)
  }

  hasOrderSequence(seq: number): boolean {
    return this.orders.some((order) => order.seq === seq)
  }

  posAt(tick: number): Vector2 {
    let position: Vector2 = { ...this.initialPosition }
    let movement: {
      origin: Vector2
      target: Vector2
      startTick: number
    } | undefined

    for (const order of this.orders) {
      const orderTick = getEntityOrderTick(order)
      if (orderTick > tick) break

      if (order.type === 'attack') {
        position = order.position
        movement = undefined
        continue
      }

      if (movement) position = positionAtMove(movement, orderTick)
      movement = {
        origin: position,
        target: order.target,
        startTick: orderTick,
      }
    }

    return movement ? positionAtMove(movement, tick) : { ...position }
  }

  snapshot(): GameEntitySnapshot {
    return {
      id: this.id,
      initialPosition: { ...this.initialPosition },
      orders: this.orders.map((order) => order.type === 'move'
        ? { ...order, target: { ...order.target } }
        : { ...order, position: { ...order.position } }),
      ...(this.health ? { health: this.health.snapshot() } : {}),
      ...(this.attackStats ? { attackStats: this.attackStats.snapshot() } : {}),
      ...(this.player ? { player: { ...this.player } } : {}),
    }
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
  tick = 0

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
      nextAttackTick: 0,
    }))
    this.entities.set(id, entity)
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
    if (!entity) return false
    if (entity.hasOrderSequence(order.seq)) return false
    if (
      order.type === 'move'
      && entity.orders.some((existing) =>
        existing.type === 'attack'
        && existing.seq > order.seq
        && existing.tick <= order.clientTick,
      )
    ) return false

    if (order.type === 'attack') {
      for (let index = entity.orders.length - 1; index >= 0; index -= 1) {
        const existing = entity.orders[index]
        if (
          existing.type === 'move'
          && existing.seq < order.seq
          && existing.clientTick >= order.tick
        ) entity.orders.splice(index, 1)
      }
    }

    entity.orders.push(order.type === 'move'
      ? { ...order, target: clampPosition(order.target) }
      : { ...order, position: clampPosition(order.position) })
    entity.orders.sort(compareEntityOrders)
    return true
  }

  remove(entityId: number): void {
    this.entities.delete(entityId)
  }

  removeProjectile(projectileId: number): void {
    this.projectiles.delete(projectileId)
  }

  advanceTo(tick: number): void {
    if (!Number.isSafeInteger(tick) || tick < this.tick) {
      throw new RangeError('Simulator tick must be a safe integer that does not go backwards.')
    }
    this.tick = tick
    for (const projectile of this.projectiles.values()) {
      if (tick >= projectile.initialTick + projectile.lifetimeTicks) {
        this.projectiles.delete(projectile.id)
      }
    }
  }

  snapshot(): GameSnapshot {
    return {
      tick: this.tick,
      entities: [...this.entities.values()].map((entity) => entity.snapshot()),
      projectiles: [...this.projectiles.values()].map((projectile) => projectile.snapshot()),
    }
  }

  replaceFromSnapshot(snapshot: GameSnapshot): void {
    this.entities.clear()
    this.projectiles.clear()
    this.tick = snapshot.tick
    for (const entity of snapshot.entities) {
      this.entities.set(entity.id, new SimEntity(
        entity.id,
        entity.initialPosition,
        entity.orders,
        entity.player,
        entity.health ? new HealthStats(entity.health) : undefined,
        entity.attackStats ? new AttackStats(entity.attackStats) : undefined,
      ))
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
}

function compareEntityOrders(left: EntityOrder, right: EntityOrder): number {
  const leftTick = getEntityOrderTick(left)
  const rightTick = getEntityOrderTick(right)
  if (leftTick !== rightTick) return leftTick - rightTick
  const leftSequence = left.seq
  const rightSequence = right.seq
  if (leftSequence !== rightSequence) return leftSequence - rightSequence
  if (left.type === right.type) return 0
  return left.type === 'move' ? -1 : 1
}

function getEntityOrderTick(order: EntityOrder): number {
  return order.type === 'move' ? order.clientTick : order.tick
}

function positionAtMove(
  movement: { origin: Vector2; target: Vector2; startTick: number },
  tick: number,
): Vector2 {
  const dx = movement.target.x - movement.origin.x
  const dy = movement.target.y - movement.origin.y
  const distance = Math.hypot(dx, dy)
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
