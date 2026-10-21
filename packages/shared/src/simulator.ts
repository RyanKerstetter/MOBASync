import { abilityDefs, type AbilityDef } from './abilities.js'
import { DEFAULT_CHAMPION_ID, getChampion, type Champion } from './champions.js'
import {
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_CAST_ORIGIN_TOLERANCE,
  GAME_SNAPSHOT_HISTORY_TICKS,
  GAME_TPS,
} from './constants.js'
import {
  areEnemies,
  getProjectileDef,
  runEffects,
  type GameEvent,
  type SimContext,
} from './effects.js'
import type {
  CastOrder,
  CastTarget,
  EntityOrder,
  GameAttackOrder,
  GameDeathTiming,
  GameEntitySnapshot,
  GameFrame,
  GameFrameAction,
  GameFrameEntity,
  GameHealthStats,
  GameSnapshot,
  Marker,
  SimProjectile,
  Status,
  Vector2,
} from './index.js'

const RANGE_EPSILON = 1e-6
const DIRECTION_LENGTH_TOLERANCE = 0.01

export class SimEntity {
  readonly orders: EntityOrder[]
  // Server-confirmed deaths; each one also names the tick the entity respawns.
  readonly deaths: GameDeathTiming[]
  private lastOrderSequence: number

  constructor(
    readonly id: number,
    readonly initialPosition: Vector2,
    orders: EntityOrder[],
    readonly champion: Champion,
    readonly player?: GameEntitySnapshot['player'],
    highestOrderSequence = 0,
    deaths: GameDeathTiming[] = [],
  ) {
    this.orders = orders.map(cloneOrder).sort(compareEntityOrders)
    this.deaths = deaths.map((death) => ({ ...death })).sort((left, right) => left.tick - right.tick)
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
      orders: this.orders.map(cloneOrder),
      deaths: this.deaths.map((death) => ({ ...death })),
      highestOrderSequence: this.highestOrderSequence,
      championId: this.champion.id,
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

  // Base shield plus every active shield status.
  getShield(): number | undefined {
    if (!this.state.health) return undefined
    return this.state.statuses.reduce(
      (total, status) => status.kind === 'shield' ? total + status.amount : total,
      this.state.health.shield,
    )
  }

  getDeathTick(): number | undefined {
    return this.state.health?.deathTick
  }

  isDead(): boolean {
    return this.state.health?.deathTick !== undefined
  }

  getNextAttackTick(): number {
    return this.state.nextAttackTick
  }

  getCooldown(): { ready: boolean; ticksRemaining: number } {
    return toCooldown(this.tick, this.state.nextAttackTick)
  }

  getAbilityCooldown(abilityId: string): { ready: boolean; ticksRemaining: number } {
    return toCooldown(this.tick, this.state.cooldowns[abilityId] ?? 0)
  }

  getAction(): GameFrameAction | undefined {
    return this.state.action ? cloneAction(this.state.action) : undefined
  }

  getStatuses(): Status[] {
    return this.state.statuses.map((status) => ({ ...status }))
  }

  getMarkers(): Marker[] {
    return this.state.markers.map((marker) => ({ ...marker }))
  }
}

export class GameTickSnapshot {
  private readonly entities: Map<number, EntityTickSnapshot>
  private readonly entityStates: Map<number, GameFrameEntity>
  private readonly projectiles: SimProjectile[]

  constructor(
    readonly tick: number,
    frame: GameFrame,
    // Events emitted while computing this tick; empty for restored checkpoints.
    readonly events: readonly GameEvent[] = [],
  ) {
    this.entityStates = new Map(frame.entities.map((entity) => [
      entity.entityId,
      cloneFrameEntity(entity),
    ]))
    this.entities = new Map([...this.entityStates.values()].map((entity) => [
      entity.entityId,
      new EntityTickSnapshot(entity, tick),
    ]))
    this.projectiles = frame.projectiles.map(cloneProjectile)
  }

  get(entityId: number): EntityTickSnapshot | undefined {
    return this.entities.get(entityId)
  }

  getEntityState(entityId: number): GameFrameEntity | undefined {
    return this.entityStates.get(entityId)
  }

  getProjectiles(): SimProjectile[] {
    return this.projectiles.map(cloneProjectile)
  }

  toData(): GameFrame {
    return {
      tick: this.tick,
      entities: [...this.entityStates.values()]
        .sort((left, right) => left.entityId - right.entityId)
        .map(cloneFrameEntity),
      projectiles: this.getProjectiles(),
    }
  }

  getEntityIds(): number[] {
    return [...this.entityStates.keys()].sort((left, right) => left - right)
  }
}

export function projectilePosAt(projectile: SimProjectile, tick: number): Vector2 {
  const elapsedTicks = Math.max(0, Math.min(
    projectile.lifetimeTicks,
    tick - projectile.startTick,
  ))
  return {
    x: projectile.origin.x + projectile.velocity.x * elapsedTicks / GAME_TPS,
    y: projectile.origin.y + projectile.velocity.y * elapsedTicks / GAME_TPS,
  }
}

// The SimContext handed to effects while one tick is computed. Reads see the
// tick's state before any effect writes; writes are applied by the simulator
// in emission order once every action and projectile has resolved.
class TickContext implements SimContext {
  readonly events: GameEvent[] = []
  readonly statusWrites: Array<{ unitId: number; status: Status }> = []
  readonly markerWrites: Array<{ unitId: number; marker: Marker }> = []
  readonly orderWrites: Array<{ unitId: number; order: EntityOrder }> = []
  readonly projectileWrites: SimProjectile[] = []

  constructor(
    readonly tick: number,
    private readonly entities: ReadonlyMap<number, SimEntity>,
    private readonly states: ReadonlyMap<number, GameFrameEntity>,
    private readonly history: (tick: number) => GameTickSnapshot,
  ) {}

  entity(id: number): SimEntity | undefined {
    return this.entities.get(id)
  }

  posAt(id: number, tick: number): Vector2 | undefined {
    return this.statesAt(tick).find((state) => state.entityId === id)?.position
  }

  unitsInRadius(center: Vector2, r: number, tick: number): number[] {
    return this.statesAt(tick)
      .filter((state) => {
        const entity = this.entities.get(state.entityId)
        return entity
          && isAlive(state)
          && distanceBetween(center, state.position) <= r + entity.champion.radius
      })
      .map((state) => state.entityId)
      .sort((left, right) => left - right)
  }

  addStatus(unitId: number, s: Status): void {
    this.statusWrites.push({ unitId, status: { ...s } })
  }

  addOrder(unitId: number, o: EntityOrder): void {
    this.orderWrites.push({ unitId, order: cloneOrder(o) })
  }

  addMarker(unitId: number, m: Marker): void {
    this.markerWrites.push({ unitId, marker: { ...m } })
  }

  spawnProjectile(p: SimProjectile): void {
    this.projectileWrites.push(cloneProjectile(p))
  }

  emitEvent(e: GameEvent): void {
    this.events.push({ ...e })
  }

  private statesAt(tick: number): GameFrameEntity[] {
    if (tick > this.tick) throw new RangeError('Effects cannot read future ticks.')
    if (tick === this.tick) return [...this.states.values()].map(cloneFrameEntity)
    const frame = this.history(tick)
    return frame.getEntityIds().flatMap((id) => {
      const state = frame.getEntityState(id)
      return state ? [cloneFrameEntity(state)] : []
    })
  }
}

export class Simulator {
  readonly entities = new Map<number, SimEntity>()
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
    champion: Champion = getChampion(DEFAULT_CHAMPION_ID),
  ): SimEntity {
    const entity = new SimEntity(
      id,
      clampPosition(position, champion.radius),
      [],
      champion,
      { playerId, name },
    )
    this.entities.set(id, entity)
    if (this.tick === 0 && this.commitTick === 0) this.resetFrameHistory()
    return entity
  }

  addOrder(entityId: number, order: EntityOrder): boolean {
    const entity = this.entities.get(entityId)
    if (!entity || order.tick <= this.commitTick) return false
    if (
      order.tick <= this.latestComputedTick
      && !this.getCachedFrame(order.tick - 1)
    ) return false
    if (entity.orders.some((existing) => existing.id === order.id)) return false
    entity.orders.push(cloneOrder(order))
    entity.orders.sort((left, right) => compareEntityOrders(left, right, entity, entity))
    entity.recordOrderSequence(order.seq)
    this.invalidateFrom(order.tick)
    return true
  }

  // Schedules a server-confirmed death. Nothing else kills an entity: reaching 0 health
  // leaves it alive until the server's message arrives.
  addDeath(entityId: number, death: GameDeathTiming): boolean {
    const entity = this.entities.get(entityId)
    if (!entity || death.tick <= this.commitTick || death.respawnTick <= death.tick) return false
    if (death.tick <= this.latestComputedTick && !this.getCachedFrame(death.tick - 1)) return false
    if (entity.deaths.some((existing) =>
      death.tick < existing.respawnTick && existing.tick < death.respawnTick)) return false
    entity.deaths.push({ ...death })
    entity.deaths.sort((left, right) => left.tick - right.tick)
    this.invalidateFrom(death.tick)
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
      // The checkpoint frame already holds a finished death; keep one until it respawns.
      while (entity.deaths.length > 0 && entity.deaths[0].respawnTick < tick) {
        entity.deaths.shift()
      }
    }
  }

  reset(): void {
    this.entities.clear()
    this.tick = 0
    this.commitTick = 0
    this.resetFrameHistory()
  }

  remove(entityId: number): void {
    this.entities.delete(entityId)
    this.invalidateFrom(Math.max(this.commitTick + 1, this.tick))
  }

  advanceTo(tick: number): void {
    if (!Number.isSafeInteger(tick) || tick < this.tick) {
      throw new RangeError('Simulator tick must be a safe integer that does not go backwards.')
    }
    if (tick > this.latestComputedTick) this.at(tick)
    this.tick = Math.max(this.tick, tick, this.latestComputedTick)
  }

  snapshot(): GameSnapshot {
    const checkpoint = this.at(this.commitTick)
    return {
      tick: this.tick,
      commitTick: this.commitTick,
      entities: [...this.entities.values()].map((entity) => ({
        ...entity.snapshot(),
        orders: entity.orders
          .filter((order) => order.tick > this.commitTick)
          .map(cloneOrder),
        deaths: entity.deaths
          .filter((death) => death.respawnTick > this.commitTick)
          .map((death) => ({ ...death })),
      })),
      checkpoint: checkpoint.toData(),
    }
  }

  replaceFromSnapshot(snapshot: GameSnapshot): void {
    if (
      snapshot.checkpoint.tick !== snapshot.commitTick
      || snapshot.commitTick > snapshot.tick
    ) {
      throw new RangeError('Snapshot checkpoint must match its commit tick and not exceed its current tick.')
    }
    const champions = snapshot.entities.map((entity) => getChampion(entity.championId))
    this.entities.clear()
    this.commitTick = snapshot.commitTick
    snapshot.entities.forEach((entity, index) => {
      this.entities.set(entity.id, new SimEntity(
        entity.id,
        entity.initialPosition,
        entity.orders,
        champions[index],
        entity.player,
        entity.highestOrderSequence,
        entity.deaths,
      ))
    })
    this.frameBuffer.fill(undefined)
    this.latestComputedTick = snapshot.commitTick
    this.storeFrame(new GameTickSnapshot(snapshot.checkpoint.tick, snapshot.checkpoint))
    this.tick = snapshot.commitTick
    this.advanceTo(snapshot.tick)
  }

  private computeFrame(tick: number, previous: GameTickSnapshot): GameTickSnapshot {
    const states = new Map<number, GameFrameEntity>()
    for (const entityId of previous.getEntityIds()) {
      const entity = this.entities.get(entityId)
      const prior = previous.getEntityState(entityId)
      if (!entity || !prior) continue
      const state = cloneFrameEntity(prior)
      if (state.movement) {
        // Movement over (tick - 1, tick] uses the previous frame's statuses.
        const speed = getMoveSpeed(entity, prior.statuses)
        state.position = stepToward(prior.position, state.movement.target, speed / GAME_TPS, entity.champion.radius)
        if (state.position.x === state.movement.target.x && state.position.y === state.movement.target.y) {
          state.movement = undefined
        }
      }
      state.statuses = state.statuses.filter((status) => status.endTick > tick)
      state.markers = state.markers.filter((marker) => marker.endTick > tick)
      for (const death of entity.deaths) {
        if (death.tick === tick) killEntity(state, tick)
        if (death.respawnTick === tick) respawnEntity(entity, state, tick)
      }
      states.set(entityId, state)
    }
    for (const entity of this.entities.values()) {
      if (states.has(entity.id)) continue
      states.set(entity.id, this.createInitialEntityFrame(entity))
    }
    const entities = [...this.entities.values()].sort((left, right) => left.id - right.id)
    const context = new TickContext(tick, this.entities, states, (historyTick) => this.at(historyTick))

    // Windups that finish this tick launch before this tick's orders can cancel them.
    for (const entity of entities) {
      const state = states.get(entity.id)
      if (state?.action?.launchTick === tick) this.launchAction(context, entity, state, states, tick)
    }

    const orders = entities.flatMap((entity) =>
      entity.orders
        .filter((order) => order.tick === tick)
        .map((order) => ({ entity, order })),
    )
    orders.sort((left, right) =>
      compareEntityOrders(left.order, right.order, left.entity, right.entity),
    )
    for (const entity of entities) {
      const state = states.get(entity.id)
      if (!state) continue
      for (const order of state.queuedOrders) {
        if (order.tick === tick) orders.push({ entity, order })
      }
      state.queuedOrders = state.queuedOrders.filter((order) => order.tick > tick)
    }
    for (const { entity, order } of orders) {
      const state = states.get(entity.id)
      if (!state || !isAlive(state)) continue
      if (order.type === 'move') {
        state.action = undefined
        state.movement = { target: clampPosition(order.target, entity.champion.radius) }
      } else if (order.type === 'attack') {
        this.startAttack(context, entity, state, order, states, tick)
      } else {
        this.startCast(context, entity, state, order, states, tick)
      }
    }

    const projectiles = this.advanceProjectiles(context, previous.getProjectiles(), states, tick)
    for (const state of states.values()) {
      if (state.action && state.action.endTick <= tick) state.action = undefined
    }
    this.applyWrites(context, states, projectiles, tick)

    return new GameTickSnapshot(tick, {
      tick,
      entities: [...states.values()].sort((left, right) => left.entityId - right.entityId),
      projectiles,
    }, context.events)
  }

  private startAttack(
    context: TickContext,
    entity: SimEntity,
    state: GameFrameEntity,
    order: GameAttackOrder,
    states: ReadonlyMap<number, GameFrameEntity>,
    tick: number,
  ): void {
    const target = this.entities.get(order.targetId)
    const targetState = target ? states.get(target.id) : undefined
    const valid = Boolean(
      target
      && targetState
      && areEnemies(entity, target)
      && isAlive(targetState)
      && isAlive(state)
      && !isWindingUp(state, tick)
      && tick >= state.nextAttackTick
      && distanceBetween(state.position, targetState.position) <= entity.champion.attackRange,
    )
    if (!valid) return

    state.movement = undefined
    const launchTick = tick + entity.champion.attackWindupTicks
    state.action = {
      kind: 'attack',
      orderId: order.id,
      targetId: order.targetId,
      startTick: tick,
      launchTick,
      endTick: launchTick,
    }
    if (launchTick === tick) this.launchAction(context, entity, state, states, tick)
  }

  private startCast(
    context: TickContext,
    entity: SimEntity,
    state: GameFrameEntity,
    order: CastOrder,
    states: ReadonlyMap<number, GameFrameEntity>,
    tick: number,
  ): void {
    const def = abilityDefs.get(order.abilityId)
    const valid = Boolean(
      def
      && entity.champion.hasAbility(def.id)
      && isAlive(state)
      && !isWindingUp(state, tick)
      && (state.cooldowns[def.id] ?? 0) <= tick
      && distanceBetween(order.origin, state.position) <= GAME_CAST_ORIGIN_TOLERANCE
      && this.isValidCastTarget(entity, def, order, states),
    )
    if (!valid || !def) return

    state.movement = undefined
    const launchTick = tick + def.windUpTicks
    state.action = {
      kind: 'cast',
      orderId: order.id,
      abilityId: def.id,
      target: cloneCastTarget(order.target),
      origin: { ...order.origin },
      startTick: tick,
      launchTick,
      endTick: launchTick + def.backswingTicks,
    }
    if (launchTick === tick) this.launchAction(context, entity, state, states, tick)
  }

  private isValidCastTarget(
    entity: SimEntity,
    def: AbilityDef,
    order: CastOrder,
    states: ReadonlyMap<number, GameFrameEntity>,
  ): boolean {
    const target = order.target
    if (target.mode !== def.targeting) return false
    switch (target.mode) {
      case 'none':
        return true
      case 'point':
        return distanceBetween(order.origin, target.point) <= def.range + RANGE_EPSILON
      case 'direction':
        return Math.abs(target.dir.x * target.dir.x + target.dir.y * target.dir.y - 1)
          <= DIRECTION_LENGTH_TOLERANCE
      case 'unit': {
        const unit = this.entities.get(target.unitId)
        const unitState = states.get(target.unitId)
        return Boolean(
          unit
          && unitState
          && areEnemies(entity, unit)
          && isAlive(unitState)
          && distanceBetween(order.origin, unitState.position) <= def.range + RANGE_EPSILON,
        )
      }
    }
  }

  private launchAction(
    context: TickContext,
    entity: SimEntity,
    state: GameFrameEntity,
    states: ReadonlyMap<number, GameFrameEntity>,
    tick: number,
  ): void {
    const action = state.action
    if (!action) return
    if (!isAlive(state)) {
      state.action = undefined
      return
    }
    if (action.kind === 'attack') {
      // An attack whose target died or left during windup is cancelled, not spent.
      const targetState = states.get(action.targetId)
      if (!this.entities.has(action.targetId) || !targetState || !isAlive(targetState)) {
        state.action = undefined
        return
      }
      state.nextAttackTick = action.startTick + entity.champion.attackCooldownTicks
      runEffects(entity.champion.onAttackHit, context, {
        id: `a:${action.orderId}`,
        rootId: action.orderId,
        ownerId: entity.id,
        tick,
        at: { ...state.position },
        aim: null,
        subject: action.targetId,
      })
      return
    }

    const def = abilityDefs.get(action.abilityId)
    if (!def) {
      state.action = undefined
      return
    }
    state.cooldowns[def.id] = tick + def.cooldownTicks
    runEffects(def.apply, context, {
      id: `c:${action.orderId}`,
      rootId: action.orderId,
      ownerId: entity.id,
      tick,
      at: { ...action.origin },
      aim: cloneCastTarget(action.target),
      subject: null,
    })
  }

  private advanceProjectiles(
    context: TickContext,
    projectiles: SimProjectile[],
    states: ReadonlyMap<number, GameFrameEntity>,
    tick: number,
  ): SimProjectile[] {
    const remaining: SimProjectile[] = []
    for (const projectile of projectiles) {
      const def = getProjectileDef(projectile.defId)
      if (!def || tick > projectile.startTick + projectile.lifetimeTicks) continue
      const owner = this.entities.get(projectile.ownerId)
      const position = projectilePosAt(projectile, tick)
      const hits = owner
        ? [...states.values()]
          .flatMap((state) => {
            const unit = this.entities.get(state.entityId)
            if (
              !unit
              || !areEnemies(owner, unit)
              || !isAlive(state)
              || projectile.hitIds.includes(unit.id)
            ) return []
            const distance = distanceBetween(position, state.position)
            return distance <= def.radius + unit.champion.radius ? [{ id: unit.id, distance }] : []
          })
          .sort((left, right) => left.distance - right.distance || left.id - right.id)
        : []
      const struck = def.pierce ? hits : hits.slice(0, 1)
      for (const { id } of struck) {
        projectile.hitIds.push(id)
        // Tick is included so a zone re-hitting the same unit stays unique.
        runEffects(def.onHit, context, {
          id: `${projectile.id}:u${id}:t${tick}`,
          rootId: projectile.rootId,
          ownerId: projectile.ownerId,
          tick,
          at: position,
          aim: null,
          subject: id,
        })
      }
      if (struck.length > 0 && !def.pierce) continue
      remaining.push(projectile)
    }
    return remaining
  }

  private applyWrites(
    context: TickContext,
    states: ReadonlyMap<number, GameFrameEntity>,
    projectiles: SimProjectile[],
    tick: number,
  ): void {
    for (const { unitId, status } of context.statusWrites) {
      const state = states.get(unitId)
      if (!state || !isAlive(state)) continue
      // Reapplying the same provenance ID refreshes the status instead of stacking it.
      state.statuses = [...state.statuses.filter((existing) => existing.id !== status.id), status]
    }
    for (const { unitId, marker } of context.markerWrites) {
      const state = states.get(unitId)
      if (!state || !isAlive(state)) continue
      state.markers = [...state.markers.filter((existing) => existing.id !== marker.id), marker]
    }
    for (const event of context.events) {
      if (event.type === 'damage') {
        const state = states.get(event.targetId)
        if (state) applyDamage(state, event.amount, tick)
      } else {
        const state = states.get(event.unitId)
        if (state) state.nextAttackTick = Math.min(state.nextAttackTick, tick)
      }
    }
    for (const projectile of context.projectileWrites) {
      const index = projectiles.findIndex((existing) => existing.id === projectile.id)
      if (index >= 0) projectiles.splice(index, 1)
      projectiles.push(projectile)
    }
    for (const { unitId, order } of context.orderWrites) {
      const state = states.get(unitId)
      if (!state) continue
      state.queuedOrders.push({ ...order, tick: Math.max(order.tick, tick + 1) })
    }
  }

  private createInitialFrame(): GameTickSnapshot {
    return new GameTickSnapshot(0, {
      tick: 0,
      entities: [...this.entities.values()]
        .sort((left, right) => left.id - right.id)
        .map((entity) => this.createInitialEntityFrame(entity)),
      projectiles: [],
    })
  }

  private createInitialEntityFrame(entity: SimEntity): GameFrameEntity {
    const champion = entity.champion
    return {
      entityId: entity.id,
      position: { ...entity.initialPosition },
      health: {
        hp: champion.maxHp,
        maxHp: champion.maxHp,
        shield: champion.baseShield,
        hpSeq: 0,
        finalizedTick: 0,
      },
      nextAttackTick: 0,
      cooldowns: {},
      statuses: [],
      markers: [],
      queuedOrders: [],
    }
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

function applyDamage(state: GameFrameEntity, amount: number, tick: number): void {
  const health = state.health
  if (!health || health.deathTick !== undefined) return
  let remaining = Math.max(0, Math.round(amount))
  if (remaining === 0) return
  // Shield statuses absorb first, soonest-expiring first, then the base shield.
  const shields = state.statuses
    .filter((status) => status.kind === 'shield')
    .sort((left, right) => left.endTick - right.endTick || compareStrings(left.id, right.id))
  for (const status of shields) {
    const absorbed = Math.min(status.amount, remaining)
    status.amount -= absorbed
    remaining -= absorbed
    if (remaining === 0) break
  }
  state.statuses = state.statuses.filter((status) => status.kind !== 'shield' || status.amount > 0)
  const shieldDamage = Math.min(health.shield, remaining)
  health.shield -= shieldDamage
  health.hp = Math.max(0, health.hp - (remaining - shieldDamage))
  health.hpSeq += 1
  health.finalizedTick = tick
}

// Reaching 0 health does not kill: only the server's confirmed death does.
function killEntity(state: GameFrameEntity, tick: number): void {
  const health = state.health
  if (!health || health.deathTick !== undefined) return
  health.hp = 0
  health.shield = 0
  health.deathTick = tick
  health.finalizedTick = tick
  clearActivity(state)
}

function respawnEntity(entity: SimEntity, state: GameFrameEntity, tick: number): void {
  const health = state.health
  if (!health) return
  state.position = { ...entity.initialPosition }
  state.health = {
    hp: entity.champion.maxHp,
    maxHp: entity.champion.maxHp,
    shield: entity.champion.baseShield,
    hpSeq: health.hpSeq + 1,
    finalizedTick: tick,
  }
  state.nextAttackTick = tick
  state.cooldowns = {}
  clearActivity(state)
}

function clearActivity(state: GameFrameEntity): void {
  state.action = undefined
  state.movement = undefined
  state.statuses = []
  state.markers = []
  state.queuedOrders = []
}

function getMoveSpeed(entity: SimEntity, statuses: readonly Status[]): number {
  let strongestSlow = 0
  for (const status of statuses) {
    if (status.kind === 'slow') strongestSlow = Math.max(strongestSlow, status.amount)
  }
  return entity.champion.moveSpeed * (1 - Math.min(1, strongestSlow))
}

function isAlive(state: GameFrameEntity): boolean {
  return Boolean(state.health && state.health.deathTick === undefined)
}

function isWindingUp(state: GameFrameEntity, tick: number): boolean {
  return state.action !== undefined && tick < state.action.launchTick
}

function toCooldown(tick: number, readyTick: number): { ready: boolean; ticksRemaining: number } {
  return {
    ready: tick >= readyTick,
    ticksRemaining: Math.max(0, readyTick - tick),
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

function distanceBetween(left: Vector2, right: Vector2): number {
  const dx = left.x - right.x
  const dy = left.y - right.y
  return Math.sqrt(dx * dx + dy * dy)
}

function cloneCastTarget(target: CastTarget): CastTarget {
  switch (target.mode) {
    case 'none':
      return { mode: 'none' }
    case 'point':
      return { mode: 'point', point: { ...target.point } }
    case 'direction':
      return { mode: 'direction', dir: { ...target.dir } }
    case 'unit':
      return { mode: 'unit', unitId: target.unitId }
  }
}

function cloneOrder(order: EntityOrder): EntityOrder {
  switch (order.type) {
    case 'move':
      return { ...order, target: { ...order.target } }
    case 'attack':
      return { ...order }
    case 'cast':
      return { ...order, origin: { ...order.origin }, target: cloneCastTarget(order.target) }
  }
}

function cloneAction(action: GameFrameAction): GameFrameAction {
  return action.kind === 'attack'
    ? { ...action }
    : { ...action, origin: { ...action.origin }, target: cloneCastTarget(action.target) }
}

function cloneProjectile(projectile: SimProjectile): SimProjectile {
  return {
    ...projectile,
    origin: { ...projectile.origin },
    velocity: { ...projectile.velocity },
    hitIds: [...projectile.hitIds],
  }
}

function cloneFrameEntity(entity: GameFrameEntity): GameFrameEntity {
  return {
    ...entity,
    position: { ...entity.position },
    ...(entity.health ? { health: { ...entity.health } } : {}),
    ...(entity.movement ? {
      movement: {
        target: { ...entity.movement.target },
      },
    } : {}),
    ...(entity.action ? { action: cloneAction(entity.action) } : {}),
    cooldowns: { ...entity.cooldowns },
    statuses: entity.statuses.map((status) => ({ ...status })),
    markers: entity.markers.map((marker) => ({ ...marker })),
    queuedOrders: entity.queuedOrders.map(cloneOrder),
  }
}

function stepToward(position: Vector2, target: Vector2, stepLength: number, radius: number): Vector2 {
  const dx = target.x - position.x
  const dy = target.y - position.y
  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance <= stepLength) return { ...target }

  const progress = stepLength / distance
  return clampPosition({
    x: position.x + dx * progress,
    y: position.y + dy * progress,
  }, radius)
}

function clampPosition(position: Vector2, radius: number): Vector2 {
  return {
    x: Math.max(radius, Math.min(GAME_ARENA_WIDTH - radius, position.x)),
    y: Math.max(radius, Math.min(GAME_ARENA_HEIGHT - radius, position.y)),
  }
}
