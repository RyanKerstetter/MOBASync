import { abilityDefs, withinCastRange, type AbilityDef } from './abilities.js'
import { boxTouchesCircle } from './geometry.js'
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
  getEntityDef,
  runEffects,
  type GameEvent,
  type SimContext,
} from './effects.js'
import type {
  CastOrder,
  CastTarget,
  CharacterOrder,
  GameAttackOrder,
  GameDeathTiming,
  GameCharacterSnapshot,
  GameFrame,
  GameFrameAction,
  GameFrameCharacter,
  GameHealthStats,
  GameSnapshot,
  Marker,
  SimEntity,
  Status,
  Vector2,
} from './index.js'

const DIRECTION_LENGTH_TOLERANCE = 0.01

export class SimCharacter {
  readonly orders: CharacterOrder[]
  // Server-confirmed deaths; each one also names the tick the character respawns.
  readonly deaths: GameDeathTiming[]
  private lastOrderSequence: number

  constructor(
    readonly id: number,
    readonly initialPosition: Vector2,
    orders: CharacterOrder[],
    readonly champion: Champion,
    readonly player?: GameCharacterSnapshot['player'],
    highestOrderSequence = 0,
    deaths: GameDeathTiming[] = [],
  ) {
    this.orders = orders.map(cloneOrder).sort(compareCharacterOrders)
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

  snapshot(): GameCharacterSnapshot {
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

export class CharacterTickSnapshot {
  constructor(
    private readonly state: GameFrameCharacter,
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

  // Every active shield status; characters have no shield of their own.
  getShield(): number | undefined {
    if (!this.state.health) return undefined
    return this.state.statuses.reduce(
      (total, status) => status.kind === 'shield' ? total + status.amount : total,
      0,
    )
  }

  getDeathTick(): number | undefined {
    return this.state.health?.deathTick
  }

  isDead(): boolean {
    return this.state.health?.deathTick !== undefined
  }

  isDashing(): boolean {
    return this.state.dash !== undefined
  }

  // Where the character is currently heading, whether walking or dashing.
  getMoveTarget(): Vector2 | undefined {
    const target = this.state.dash?.target ?? this.state.movement?.target
    return target ? { ...target } : undefined
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
  private readonly characters: Map<number, CharacterTickSnapshot>
  private readonly characterStates: Map<number, GameFrameCharacter>
  private readonly entities: SimEntity[]

  constructor(
    readonly tick: number,
    frame: GameFrame,
    // Events emitted while computing this tick; empty for restored checkpoints.
    readonly events: readonly GameEvent[] = [],
  ) {
    this.characterStates = new Map(frame.characters.map((character) => [
      character.characterId,
      cloneFrameCharacter(character),
    ]))
    this.characters = new Map([...this.characterStates.values()].map((character) => [
      character.characterId,
      new CharacterTickSnapshot(character, tick),
    ]))
    this.entities = frame.entities.map(cloneEntity)
  }

  get(characterId: number): CharacterTickSnapshot | undefined {
    return this.characters.get(characterId)
  }

  getCharacterState(characterId: number): GameFrameCharacter | undefined {
    return this.characterStates.get(characterId)
  }

  getEntities(): SimEntity[] {
    return this.entities.map(cloneEntity)
  }

  toData(): GameFrame {
    return {
      tick: this.tick,
      characters: [...this.characterStates.values()]
        .sort((left, right) => left.characterId - right.characterId)
        .map(cloneFrameCharacter),
      entities: this.getEntities(),
    }
  }

  getCharacterIds(): number[] {
    return [...this.characterStates.keys()].sort((left, right) => left - right)
  }
}

export function entityPosAt(entity: SimEntity, tick: number): Vector2 {
  // An entity that follows its owner keeps its latest position instead of a straight path.
  if (entity.position) return { ...entity.position }
  const elapsedTicks = Math.max(0, Math.min(
    entity.lifetimeTicks ?? Infinity,
    tick - entity.startTick,
  ))
  return {
    x: entity.origin.x + entity.velocity.x * elapsedTicks / GAME_TPS,
    y: entity.origin.y + entity.velocity.y * elapsedTicks / GAME_TPS,
  }
}

// The SimContext handed to effects while one tick is computed. Reads see the
// tick's state before any effect writes; writes are applied by the simulator
// in emission order once every action and entity has resolved.
class TickContext implements SimContext {
  readonly events: GameEvent[] = []
  readonly statusWrites: Array<{ unitId: number; status: Status }> = []
  readonly markerWrites: Array<{ unitId: number; marker: Marker }> = []
  readonly markerRemovals: Array<{ unitId: number; key: string; ownerId: number }> = []
  readonly dashWrites: Array<{ unitId: number; target: Vector2; speed: number }> = []
  readonly orderWrites: Array<{ unitId: number; order: CharacterOrder }> = []
  readonly entityWrites: SimEntity[] = []

  constructor(
    readonly tick: number,
    private readonly characters: ReadonlyMap<number, SimCharacter>,
    private readonly states: ReadonlyMap<number, GameFrameCharacter>,
    private readonly history: (tick: number) => GameTickSnapshot,
  ) {}

  character(id: number): SimCharacter | undefined {
    return this.characters.get(id)
  }

  posAt(id: number, tick: number): Vector2 | undefined {
    return this.statesAt(tick).find((state) => state.characterId === id)?.position
  }

  unitsInRadius(center: Vector2, r: number, tick: number): number[] {
    return this.statesAt(tick)
      .filter((state) => {
        const character = this.characters.get(state.characterId)
        return character
          && isAlive(state)
          && distanceBetween(center, state.position) <= r + character.champion.radius
      })
      .map((state) => state.characterId)
      .sort((left, right) => left - right)
  }

  markersOn(unitId: number, key: string, ownerId?: number): Marker[] {
    return (this.states.get(unitId)?.markers ?? [])
      .filter((marker) => marker.key === key && (ownerId === undefined || marker.ownerId === ownerId))
      .map((marker) => ({ ...marker }))
  }

  healthOf(unitId: number): { hp: number; maxHp: number } | undefined {
    const health = this.states.get(unitId)?.health
    return health ? { hp: health.hp, maxHp: health.maxHp } : undefined
  }

  statusesOn(unitId: number): Status[] {
    return (this.states.get(unitId)?.statuses ?? []).map((status) => ({ ...status }))
  }

  addStatus(unitId: number, s: Status): void {
    this.statusWrites.push({ unitId, status: { ...s } })
  }

  addOrder(unitId: number, o: CharacterOrder): void {
    this.orderWrites.push({ unitId, order: cloneOrder(o) })
  }

  addMarker(unitId: number, m: Marker): void {
    this.markerWrites.push({ unitId, marker: { ...m } })
  }

  removeMarkers(unitId: number, key: string, ownerId: number): void {
    this.markerRemovals.push({ unitId, key, ownerId })
  }

  startDash(unitId: number, target: Vector2, speed: number): void {
    this.dashWrites.push({ unitId, target: { ...target }, speed })
  }

  addEntity(p: SimEntity): void {
    this.entityWrites.push(cloneEntity(p))
  }

  emitEvent(e: GameEvent): void {
    this.events.push({ ...e })
  }

  private statesAt(tick: number): GameFrameCharacter[] {
    if (tick > this.tick) throw new RangeError('Effects cannot read future ticks.')
    if (tick === this.tick) return [...this.states.values()].map(cloneFrameCharacter)
    const frame = this.history(tick)
    return frame.getCharacterIds().flatMap((id) => {
      const state = frame.getCharacterState(id)
      return state ? [cloneFrameCharacter(state)] : []
    })
  }
}

export class Simulator {
  readonly characters = new Map<number, SimCharacter>()
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
  ): SimCharacter {
    const character = new SimCharacter(
      id,
      clampPosition(position, champion.radius),
      [],
      champion,
      { playerId, name },
    )
    this.characters.set(id, character)
    if (this.tick === 0 && this.commitTick === 0) this.resetFrameHistory()
    return character
  }

  addOrder(characterId: number, order: CharacterOrder): boolean {
    const character = this.characters.get(characterId)
    if (!character || order.tick <= this.commitTick) return false
    if (
      order.tick <= this.latestComputedTick
      && !this.getCachedFrame(order.tick - 1)
    ) return false
    if (character.orders.some((existing) => existing.id === order.id)) return false
    character.orders.push(cloneOrder(order))
    character.orders.sort((left, right) => compareCharacterOrders(left, right, character, character))
    character.recordOrderSequence(order.seq)
    this.invalidateFrom(order.tick)
    return true
  }

  // Schedules a server-confirmed death. Nothing else kills a character: reaching 0 health
  // leaves it alive until the server's message arrives.
  addDeath(characterId: number, death: GameDeathTiming): boolean {
    const character = this.characters.get(characterId)
    if (!character || death.tick <= this.commitTick || death.respawnTick <= death.tick) return false
    if (death.tick <= this.latestComputedTick && !this.getCachedFrame(death.tick - 1)) return false
    if (character.deaths.some((existing) =>
      death.tick < existing.respawnTick && existing.tick < death.respawnTick)) return false
    character.deaths.push({ ...death })
    character.deaths.sort((left, right) => left.tick - right.tick)
    this.invalidateFrom(death.tick)
    return true
  }

  removeOrder(characterId: number, seq: number): boolean {
    const character = this.characters.get(characterId)
    if (!character) return false
    const orderIndex = character.orders.findIndex((order) => order.seq === seq)
    if (orderIndex < 0) return false
    const removedOrder = character.orders[orderIndex]
    if (removedOrder.tick <= this.latestComputedTick && !this.getCachedFrame(removedOrder.tick - 1)) {
      return false
    }
    character.orders.splice(orderIndex, 1)
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
    for (const character of this.characters.values()) {
      let index = 0
      while (index < character.orders.length && character.orders[index].tick < tick) {
        index += 1
      }
      character.orders.splice(0, index)
      // The checkpoint frame already holds a finished death; keep one until it respawns.
      while (character.deaths.length > 0 && character.deaths[0].respawnTick < tick) {
        character.deaths.shift()
      }
    }
  }

  reset(): void {
    this.characters.clear()
    this.tick = 0
    this.commitTick = 0
    this.resetFrameHistory()
  }

  remove(characterId: number): void {
    this.characters.delete(characterId)
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
      characters: [...this.characters.values()].map((character) => ({
        ...character.snapshot(),
        orders: character.orders
          .filter((order) => order.tick > this.commitTick)
          .map(cloneOrder),
        deaths: character.deaths
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
    const champions = snapshot.characters.map((character) => getChampion(character.championId))
    this.characters.clear()
    this.commitTick = snapshot.commitTick
    snapshot.characters.forEach((character, index) => {
      this.characters.set(character.id, new SimCharacter(
        character.id,
        character.initialPosition,
        character.orders,
        champions[index],
        character.player,
        character.highestOrderSequence,
        character.deaths,
      ))
    })
    this.frameBuffer.fill(undefined)
    this.latestComputedTick = snapshot.commitTick
    this.storeFrame(new GameTickSnapshot(snapshot.checkpoint.tick, snapshot.checkpoint))
    this.tick = snapshot.commitTick
    this.advanceTo(snapshot.tick)
  }

  private computeFrame(tick: number, previous: GameTickSnapshot): GameTickSnapshot {
    const states = new Map<number, GameFrameCharacter>()
    for (const characterId of previous.getCharacterIds()) {
      const character = this.characters.get(characterId)
      const prior = previous.getCharacterState(characterId)
      if (!character || !prior) continue
      const state = cloneFrameCharacter(prior)
      if (state.dash) {
        // A dash replaces walking for as long as it lasts, at its own speed.
        state.position = stepToward(prior.position, state.dash.target, state.dash.speed / GAME_TPS, character.champion.radius)
        if (state.position.x === state.dash.target.x && state.position.y === state.dash.target.y) {
          state.dash = undefined
        }
      } else if (state.movement && !isImmobilized(prior.statuses)) {
        // Movement over (tick - 1, tick] uses the previous frame's statuses.
        const speed = getMoveSpeed(character, prior.statuses)
        state.position = stepToward(prior.position, state.movement.target, speed / GAME_TPS, character.champion.radius)
        if (state.position.x === state.movement.target.x && state.position.y === state.movement.target.y) {
          state.movement = undefined
        }
      }
      state.statuses = state.statuses.filter((status) => status.endTick > tick)
      state.markers = state.markers.filter((marker) => marker.endTick > tick)
      for (const death of character.deaths) {
        if (death.tick === tick) killCharacter(state, tick)
        if (death.respawnTick === tick) respawnCharacter(character, state, tick)
      }
      states.set(characterId, state)
    }
    for (const character of this.characters.values()) {
      if (states.has(character.id)) continue
      states.set(character.id, this.createInitialCharacterFrame(character))
    }
    const characters = [...this.characters.values()].sort((left, right) => left.id - right.id)
    const context = new TickContext(tick, this.characters, states, (historyTick) => this.at(historyTick))

    // Windups that finish this tick launch before this tick's orders can cancel them.
    for (const character of characters) {
      const state = states.get(character.id)
      if (state?.action?.launchTick === tick) this.launchAction(context, character, state, states, tick)
    }

    const orders = characters.flatMap((character) =>
      character.orders
        .filter((order) => order.tick === tick)
        .map((order) => ({ character, order })),
    )
    orders.sort((left, right) =>
      compareCharacterOrders(left.order, right.order, left.character, right.character),
    )
    for (const character of characters) {
      const state = states.get(character.id)
      if (!state) continue
      for (const order of state.queuedOrders) {
        if (order.tick === tick) orders.push({ character, order })
      }
      state.queuedOrders = state.queuedOrders.filter((order) => order.tick > tick)
    }
    for (const { character, order } of orders) {
      const state = states.get(character.id)
      if (!state || !isAlive(state)) continue
      if (order.type === 'move') {
        state.action = undefined
        state.movement = { target: clampPosition(order.target, character.champion.radius) }
      } else if (order.type === 'attack') {
        this.startAttack(context, character, state, order, states, tick)
      } else {
        this.startCast(context, character, state, order, states, tick)
      }
    }

    const entities = this.advanceEntities(context, previous.getEntities(), states, tick)
    for (const state of states.values()) {
      if (state.action && state.action.endTick <= tick) state.action = undefined
    }
    this.applyWrites(context, states, entities, tick)

    return new GameTickSnapshot(tick, {
      tick,
      characters: [...states.values()].sort((left, right) => left.characterId - right.characterId),
      entities,
    }, context.events)
  }

  private startAttack(
    context: TickContext,
    character: SimCharacter,
    state: GameFrameCharacter,
    order: GameAttackOrder,
    states: ReadonlyMap<number, GameFrameCharacter>,
    tick: number,
  ): void {
    const target = this.characters.get(order.targetId)
    const targetState = target ? states.get(target.id) : undefined
    const valid = Boolean(
      target
      && targetState
      && areEnemies(character, target)
      && isAlive(targetState)
      && isAlive(state)
      && !isWindingUp(state, tick)
      && !state.dash
      && !isStunned(state.statuses)
      && tick >= state.nextAttackTick
      && distanceBetween(state.position, targetState.position) <= character.champion.attackRangeWith(state.statuses),
    )
    if (!valid) return

    state.movement = undefined
    const launchTick = tick + character.champion.attackWindupTicks
    state.action = {
      kind: 'attack',
      orderId: order.id,
      targetId: order.targetId,
      startTick: tick,
      launchTick,
      endTick: launchTick,
    }
    if (launchTick === tick) this.launchAction(context, character, state, states, tick)
  }

  private startCast(
    context: TickContext,
    character: SimCharacter,
    state: GameFrameCharacter,
    order: CastOrder,
    states: ReadonlyMap<number, GameFrameCharacter>,
    tick: number,
  ): void {
    const def = abilityDefs.get(order.abilityId)
    const valid = Boolean(
      def
      && character.champion.hasAbility(def.id)
      && isAlive(state)
      && !isWindingUp(state, tick)
      && !state.dash
      && !isStunned(state.statuses)
      && !(def.movement && isImmobilized(state.statuses))
      && (state.cooldowns[def.id] ?? 0) <= tick
      && distanceBetween(order.origin, state.position) <= GAME_CAST_ORIGIN_TOLERANCE
      && this.isValidCastTarget(character, def, order, states),
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
    if (launchTick === tick) this.launchAction(context, character, state, states, tick)
  }

  private isValidCastTarget(
    character: SimCharacter,
    def: AbilityDef,
    order: CastOrder,
    states: ReadonlyMap<number, GameFrameCharacter>,
  ): boolean {
    const target = order.target
    if (target.mode !== def.targeting) return false
    switch (target.mode) {
      case 'none':
        return true
      case 'point':
        return withinCastRange(order.origin, target.point, def.range)
      case 'direction':
        return Math.abs(target.dir.x * target.dir.x + target.dir.y * target.dir.y - 1)
          <= DIRECTION_LENGTH_TOLERANCE
      case 'unit': {
        const unit = this.characters.get(target.unitId)
        const unitState = states.get(target.unitId)
        return Boolean(
          unit
          && unitState
          && areEnemies(character, unit)
          && isAlive(unitState)
          && withinCastRange(order.origin, unitState.position, def.range),
        )
      }
    }
  }

  private launchAction(
    context: TickContext,
    character: SimCharacter,
    state: GameFrameCharacter,
    states: ReadonlyMap<number, GameFrameCharacter>,
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
      if (!this.characters.has(action.targetId) || !targetState || !isAlive(targetState)) {
        state.action = undefined
        return
      }
      state.nextAttackTick = action.startTick + character.champion.attackCooldownTicksWith(state.statuses)
      runEffects(character.champion.onAttackHit, context, {
        id: `a:${action.orderId}`,
        rootId: action.orderId,
        ownerId: character.id,
        tick,
        at: { ...state.position },
        // Aimed like a unit-targeted cast, so targetUnit() and spawnEntity work in onAttackHit.
        aim: { mode: 'unit', unitId: action.targetId },
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
      ownerId: character.id,
      tick,
      at: { ...action.origin },
      aim: cloneCastTarget(action.target),
      subject: null,
    })
    // The champion's own reaction to any spell it casts (Capricorn's passive).
    runEffects(character.champion.onCast, context, {
      id: `c:${action.orderId}:cast`,
      rootId: action.orderId,
      ownerId: character.id,
      tick,
      at: { ...action.origin },
      aim: cloneCastTarget(action.target),
      subject: null,
    })
  }

  private advanceEntities(
    context: TickContext,
    entities: SimEntity[],
    states: ReadonlyMap<number, GameFrameCharacter>,
    tick: number,
  ): SimEntity[] {
    const remaining: SimEntity[] = []
    for (const entity of entities) {
      const def = getEntityDef(entity.defId)
      if (!def) continue
      // A volley's later copies wait at the origin until their start tick.
      if (tick < entity.startTick) {
        remaining.push(entity)
        continue
      }
      if (entity.lifetimeTicks !== undefined && tick > entity.startTick + entity.lifetimeTicks) {
        if (def.onExpire) {
          // It ends where its final tick left it, so a lob spawns its follow-up on the aimed point.
          runEffects(def.onExpire, context, {
            id: `${entity.id}:expire`,
            rootId: entity.rootId,
            ownerId: entity.ownerId,
            tick,
            at: entityPosAt(entity, tick),
            aim: null,
            subject: null,
          })
        }
        continue
      }
      const owner = this.characters.get(entity.ownerId)
      if (def.follow) {
        // A damped spring toward a rest point by the owner, stepped one tick at a time (velocity
        // first, then position from it). The rest point stays inside the arena.
        const leader = states.get(entity.ownerId)
        if (leader && isAlive(leader)) {
          const { stiffness, damping, offset } = def.follow
          const rest = clampPosition(
            { x: leader.position.x + (offset?.x ?? 0), y: leader.position.y + (offset?.y ?? 0) },
            def.radius ?? 0,
          )
          const from = entityPosAt(entity, tick)
          const dt = 1 / GAME_TPS
          const velocity = {
            x: entity.velocity.x + (stiffness * (rest.x - from.x) - damping * entity.velocity.x) * dt,
            y: entity.velocity.y + (stiffness * (rest.y - from.y) - damping * entity.velocity.y) * dt,
          }
          entity.velocity = velocity
          entity.position = { x: from.x + velocity.x * dt, y: from.y + velocity.y * dt }
        }
      }
      const position = entityPosAt(entity, tick)
      if (def.stayWhile && !def.stayWhile(context, {
        id: `${entity.id}:stay`,
        rootId: entity.rootId,
        ownerId: entity.ownerId,
        tick,
        at: position,
        aim: null,
        subject: null,
      })) continue
      // Where the entity stops, for effects that care how much of its travel is left.
      const travelEnd = entity.lifetimeTicks === undefined
        ? undefined
        : entityPosAt(entity, entity.startTick + entity.lifetimeTicks)
      const onHit = def.onHit ?? []
      const hits = owner && onHit.length > 0
        ? [...states.values()]
          .flatMap((state) => {
            const unit = this.characters.get(state.characterId)
            if (
              !unit
              || !areEnemies(owner, unit)
              || !isAlive(state)
              || entity.hitIds.includes(unit.id)
            ) return []
            const distance = distanceBetween(position, state.position)
            const touching = def.box
              ? boxTouchesCircle(position, entity.facing ?? { x: 1, y: 0 }, def.box, state.position, unit.champion.radius)
              : distance <= def.radius + unit.champion.radius
            return touching ? [{ id: unit.id, distance }] : []
          })
          .sort((left, right) => left.distance - right.distance || left.id - right.id)
        : []
      const struck = def.pierce ? hits : hits.slice(0, 1)
      // The effects an entity runs know which way it points: the way a rectangle faces, else the
      // way it travels. A wave uses it to push what it strikes, a rectangular field to find who
      // is inside it.
      const speed = Math.sqrt(entity.velocity.x * entity.velocity.x + entity.velocity.y * entity.velocity.y)
      const travel: CastTarget | null = entity.facing
        ? { mode: 'direction', dir: { ...entity.facing } }
        : speed > 0
          ? { mode: 'direction', dir: { x: entity.velocity.x / speed, y: entity.velocity.y / speed } }
          : null
      for (const { id } of struck) {
        entity.hitIds.push(id)
        runEffects(onHit, context, {
          id: `${entity.id}:u${id}:t${tick}`,
          rootId: entity.rootId,
          ownerId: entity.ownerId,
          tick,
          at: position,
          aim: travel,
          subject: id,
          travelEnd,
        })
      }
      if (def.onPulse && def.pulseEveryTicks && tick > entity.startTick
        && (tick - entity.startTick) % def.pulseEveryTicks === 0) {
        runEffects(def.onPulse, context, {
          id: `${entity.id}:pulse:t${tick}`,
          rootId: entity.rootId,
          ownerId: entity.ownerId,
          tick,
          at: position,
          aim: travel,
          subject: null,
          travelEnd,
        })
      }
      if (def.onTick) {
        // No tick in the ID: statuses an entity applies each tick refresh instead of stacking.
        runEffects(def.onTick, context, {
          id: `${entity.id}:tick`,
          rootId: entity.rootId,
          ownerId: entity.ownerId,
          tick,
          at: position,
          aim: travel,
          subject: null,
          travelEnd,
        })
      }
      if (struck.length > 0 && !def.pierce) continue
      remaining.push(entity)
    }
    return remaining
  }

  private applyWrites(
    context: TickContext,
    states: ReadonlyMap<number, GameFrameCharacter>,
    entities: SimEntity[],
    tick: number,
  ): void {
    for (const { unitId, status } of context.statusWrites) {
      const state = states.get(unitId)
      if (!state || !isAlive(state)) continue
      // Reapplying the same provenance ID refreshes the status instead of stacking it.
      state.statuses = [...state.statuses.filter((existing) => existing.id !== status.id), status]
      // A stun interrupts a windup that has not launched yet; nothing is spent.
      if (status.kind === 'stun' && state.action && state.action.launchTick > tick) state.action = undefined
    }
    // Pops land before new stacks so one tick can pop a unit and re-apply to it.
    for (const { unitId, key, ownerId } of context.markerRemovals) {
      const state = states.get(unitId)
      if (!state) continue
      state.markers = state.markers.filter((marker) => marker.key !== key || marker.ownerId !== ownerId)
    }
    const markedStates = new Set<GameFrameCharacter>()
    for (const { unitId, marker } of context.markerWrites) {
      const state = states.get(unitId)
      if (!state || !isAlive(state)) continue
      state.markers = [...state.markers.filter((existing) => existing.id !== marker.id), marker]
      markedStates.add(state)
    }
    for (const state of markedStates) state.markers = settleStacks(state.markers)
    for (const { unitId, target, speed } of context.dashWrites) {
      const state = states.get(unitId)
      const character = this.characters.get(unitId)
      if (!state || !character || !isAlive(state)) continue
      state.dash = { target: clampPosition(target, character.champion.radius), speed }
    }
    for (const event of context.events) {
      if (event.type === 'damage') {
        const state = states.get(event.targetId)
        if (state) applyDamage(state, event.amount, tick)
      } else if (event.type === 'lose-health') {
        const health = states.get(event.unitId)?.health
        if (health && health.deathTick === undefined && health.hp > 1) {
          health.hp = Math.max(1, health.hp - event.amount)
          health.hpSeq += 1
          health.finalizedTick = tick
        }
      } else if (event.type === 'heal') {
        const health = states.get(event.unitId)?.health
        if (health && health.deathTick === undefined && health.hp > 0) {
          health.hp = Math.min(health.maxHp, health.hp + event.amount)
        }
      } else if (event.type === 'interrupt') {
        const state = states.get(event.unitId)
        if (state?.action && state.action.launchTick > tick) state.action = undefined
      } else if (event.type === 'refund-cooldown') {
        const state = states.get(event.unitId)
        const def = abilityDefs.get(event.abilityId)
        const readyTick = state?.cooldowns[event.abilityId]
        if (state && def && readyTick !== undefined && readyTick > tick) {
          state.cooldowns[event.abilityId] = Math.max(
            tick,
            readyTick - Math.round(def.cooldownTicks * event.fraction) - event.ticks,
          )
        }
      } else {
        const state = states.get(event.unitId)
        if (state) state.nextAttackTick = Math.min(state.nextAttackTick, tick)
      }
    }
    for (const entity of context.entityWrites) {
      const index = entities.findIndex((existing) => existing.id === entity.id)
      if (index >= 0) entities.splice(index, 1)
      entities.push(entity)
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
      characters: [...this.characters.values()]
        .sort((left, right) => left.id - right.id)
        .map((character) => this.createInitialCharacterFrame(character)),
      entities: [],
    })
  }

  private createInitialCharacterFrame(character: SimCharacter): GameFrameCharacter {
    const champion = character.champion
    return {
      characterId: character.id,
      position: { ...character.initialPosition },
      health: {
        hp: champion.maxHp,
        maxHp: champion.maxHp,
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

function compareCharacterOrders(
  left: CharacterOrder,
  right: CharacterOrder,
  leftCharacter?: SimCharacter,
  rightCharacter?: SimCharacter,
): number {
  if (left.tick !== right.tick) return left.tick - right.tick
  if (left.seq !== right.seq) return left.seq - right.seq
  const leftPlayerId = leftCharacter?.player?.playerId ?? ''
  const rightPlayerId = rightCharacter?.player?.playerId ?? ''
  if (leftPlayerId < rightPlayerId) return -1
  if (leftPlayerId > rightPlayerId) return 1
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  if (leftCharacter && rightCharacter && leftCharacter.id !== rightCharacter.id) {
    return leftCharacter.id - rightCharacter.id
  }
  return 0
}

function applyDamage(state: GameFrameCharacter, amount: number, tick: number): void {
  const health = state.health
  if (!health || health.deathTick !== undefined) return
  // Resistances add up, to at most 90%, and act before shields.
  const resistance = Math.min(0.9, state.statuses.reduce(
    (total, status) => status.kind === 'resist' ? total + status.amount : total,
    0,
  ))
  let remaining = Math.max(0, Math.round(amount * (1 - resistance)))
  if (remaining === 0) return
  // Shield statuses absorb first, soonest-expiring first.
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
  health.hp = Math.max(0, health.hp - remaining)
  health.hpSeq += 1
  health.finalizedTick = tick
}

// Reaching 0 health does not kill: only the server's confirmed death does.
function killCharacter(state: GameFrameCharacter, tick: number): void {
  const health = state.health
  if (!health || health.deathTick !== undefined) return
  health.hp = 0
  health.deathTick = tick
  health.finalizedTick = tick
  clearActivity(state)
}

function respawnCharacter(character: SimCharacter, state: GameFrameCharacter, tick: number): void {
  const health = state.health
  if (!health) return
  state.position = { ...character.initialPosition }
  state.health = {
    hp: character.champion.maxHp,
    maxHp: character.champion.maxHp,
    hpSeq: health.hpSeq + 1,
    finalizedTick: tick,
  }
  state.nextAttackTick = tick
  state.cooldowns = {}
  clearActivity(state)
}

function clearActivity(state: GameFrameCharacter): void {
  state.action = undefined
  state.movement = undefined
  state.dash = undefined
  state.statuses = []
  state.markers = []
  state.queuedOrders = []
}

// A root stops walking; a stun stops that and attacking and casting too.
function isImmobilized(statuses: readonly Status[]): boolean {
  return statuses.some((status) => status.kind === 'root' || status.kind === 'stun')
}

function isStunned(statuses: readonly Status[]): boolean {
  return statuses.some((status) => status.kind === 'stun')
}

// Haste bonuses add together; only the strongest slow applies; the slow scales the hasted speed.
function getMoveSpeed(character: SimCharacter, statuses: readonly Status[]): number {
  let strongestSlow = 0
  let hasteBonus = 0
  for (const status of statuses) {
    if (status.kind === 'slow') strongestSlow = Math.max(strongestSlow, status.amount)
    else if (status.kind === 'haste') hasteBonus += status.amount
  }
  return character.champion.moveSpeed * (1 + hasteBonus) * (1 - Math.min(1, strongestSlow))
}

// Markers with a cap form a stack per key and owner. Applying to a stack refreshes the
// timer of every marker in it, and only the newest `cap` markers stay.
function settleStacks(markers: Marker[]): Marker[] {
  const groups = new Map<string, Marker[]>()
  for (const marker of markers) {
    if (marker.cap === undefined) continue
    const group = groups.get(`${marker.key}:${marker.ownerId}`) ?? []
    group.push(marker)
    groups.set(`${marker.key}:${marker.ownerId}`, group)
  }
  if (groups.size === 0) return markers

  const settled = new Map<string, Marker>()
  for (const group of groups.values()) {
    const cap = Math.min(...group.map((marker) => marker.cap ?? Infinity))
    const endTick = Math.max(...group.map((marker) => marker.endTick))
    group
      .sort((left, right) => right.startTick - left.startTick || compareStrings(right.id, left.id))
      .slice(0, cap)
      .forEach((marker) => settled.set(marker.id, { ...marker, endTick }))
  }
  return markers.flatMap((marker) =>
    marker.cap === undefined ? [marker] : settled.has(marker.id) ? [settled.get(marker.id) as Marker] : [])
}

function isAlive(state: GameFrameCharacter): boolean {
  return Boolean(state.health && state.health.deathTick === undefined)
}

function isWindingUp(state: GameFrameCharacter, tick: number): boolean {
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

function cloneOrder(order: CharacterOrder): CharacterOrder {
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

function cloneEntity(entity: SimEntity): SimEntity {
  return {
    ...entity,
    origin: { ...entity.origin },
    velocity: { ...entity.velocity },
    hitIds: [...entity.hitIds],
    ...(entity.facing ? { facing: { ...entity.facing } } : {}),
    ...(entity.position ? { position: { ...entity.position } } : {}),
  }
}

function cloneFrameCharacter(character: GameFrameCharacter): GameFrameCharacter {
  return {
    ...character,
    position: { ...character.position },
    ...(character.health ? { health: { ...character.health } } : {}),
    ...(character.movement ? {
      movement: {
        target: { ...character.movement.target },
      },
    } : {}),
    ...(character.dash ? { dash: { target: { ...character.dash.target }, speed: character.dash.speed } } : {}),
    ...(character.action ? { action: cloneAction(character.action) } : {}),
    cooldowns: { ...character.cooldowns },
    statuses: character.statuses.map((status) => ({ ...status })),
    markers: character.markers.map((marker) => ({ ...marker })),
    queuedOrders: character.queuedOrders.map(cloneOrder),
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
