import {
  GAME_REMOTE_CATCHUP_EASE_TICKS,
  GAME_REMOTE_CATCHUP_MAX_SPEED_MULTIPLIER,
  GAME_REMOTE_RENDER_BUFFER_TICKS,
  GAME_SNAPSHOT_HISTORY_TICKS,
  GAME_TPS,
  FINALIZE_LAG,
  getAbilityDef,
  getEntityDef,
  entityPosAt,
  quantizeDirection,
  Simulator,
  withinCastRange,
  type AbilityDef,
  type CastOrder,
  type CastTarget,
  type BoxShape,
  type Champion,
  type CharacterOrder,
  type GameAttackOrder,
  type GameBroadcastOrder,
  type GameDeath,
  type GameCharacterSnapshot,
  type GameHealthStats,
  type GameTickSnapshot,
  type GameOrder,
  type GameOrderAck,
  type GameSnapshot,
  type Marker,
  type MoveOrder,
  type SimEntity,
  type Vector2,
} from '../../../packages/shared/src/index.ts'

export type TrackedOrder = {
  order: GameOrder
  sentAt: number
}

export type RenderedCharacter =
  Pick<GameCharacterSnapshot, 'id' | 'player'>
  & {
    champion: Champion
    health?: GameHealthStats
    // Active shield statuses.
    totalShield: number
    position: Vector2
    // Set only by a death the server has confirmed; 0 health alone does not kill.
    dead: boolean
    // Markers on this character by key, such as 'curse' stacks.
    stacks: Record<string, number>
    hasted: boolean
    slowed: boolean
    rooted: boolean
    stunned: boolean
    // Range and cooldown include active attack-range and attack-speed bonuses.
    attackRange: number
    attackCooldownTicks: number
  }
export type RenderedEntity = SimEntity & {
  position: Vector2
  // The circle's radius, or for a box the radius that encloses it. Only circles are drawn from it.
  radius: number
  visual: 'bolt' | 'field' | 'telegraph'
  color?: string
  box?: BoxShape
  // How far through its lifetime it is, from 0 to 1. A telegraph fills in as this grows.
  progress: number
}
export type AbilityCooldown = {
  slot: number
  abilityId: string
  ticksRemaining: number
  cooldownTicks: number
}
export type CastAttempt =
  | { ok: true; order: CastOrder }
  | { ok: false; reason: string }

// What letting go of an ability key would cast right now, for drawing its indicator.
export type CastPreview = {
  abilityId: string
  targeting: CastTarget['mode']
  range: number
  // The ability's own indicator size, when it has one.
  indicator?: { radius?: number; width?: number }
  // Absent while the aim would not cast, such as a unit ability over empty ground.
  target?: CastTarget
  // A unit ability aimed at an enemy beyond its range: the target is shown, but it would not cast.
  outOfRange?: boolean
}

function countMarkers(markers: readonly Marker[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const marker of markers) counts[marker.key] = (counts[marker.key] ?? 0) + 1
  return counts
}

// A remote champion that appears farther than this from where it was drawn has teleported
// (a respawn), so it is placed there directly instead of chased.
const REMOTE_SNAP_DISTANCE = 150

// Largest per-tick movement the local character's smoothing will continue (a dash is 15).
const LOCAL_EXTRAPOLATION_MAX_STEP = 60

type RenderedRemotePosition = {
  position: Vector2
  updatedAt: number
}

export class ClientGameState {
  readonly simulator = new Simulator()
  private localCharacterId: number | undefined
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

  setLocalCharacterId(characterId: number): void {
    this.localCharacterId = characterId
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
    const localCharacter = this.localCharacterId === undefined
      ? undefined
      : this.simulator.characters.get(this.localCharacterId)
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
      localPosition: localCharacter
        ? this.getSnapshotAtEstimatedTick(now).get(localCharacter.id)?.getPosition()
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

    const localCharacter = this.localCharacterId === undefined
      ? undefined
      : this.simulator.characters.get(this.localCharacterId)
    const replicatedOrders = new Set(
      localCharacter?.orders.map((order) => order.seq) ?? [],
    )
    const confirmedOrders: GameOrder[] = []
    for (const [sequence, tracked] of this.localOrders) {
      if (replicatedOrders.has(sequence)) {
        confirmedOrders.push(tracked.order)
        this.localOrders.delete(sequence)
      } else if (
        this.localCharacterId !== undefined
        && tracked.order.tick > snapshot.commitTick
      ) {
        this.simulator.addOrder(this.localCharacterId, tracked.order)
      }
    }
    return { applied: true, confirmedOrders }
  }

  createMoveOrder(target: Vector2, now = performance.now()): MoveOrder | undefined {
    if (this.localCharacterId === undefined || !this.simulator.characters.has(this.localCharacterId)) {
      return undefined
    }
    const character = this.simulator.characters.get(this.localCharacterId)
    if (!character) return undefined
    const seq = this.nextOrderSequence
    const order: MoveOrder = {
      id: `${character.player?.playerId ?? this.localCharacterId}:${seq}`,
      seq,
      tick: this.nextOrderTick(now),
      type: 'move',
      target: { ...target },
    }
    this.nextOrderSequence += 1
    if (!this.simulator.addOrder(this.localCharacterId, order)) return undefined
    this.trackOrder(order, now)
    return order
  }

  createAttackOrder(
    targetId: number,
    playerId: string,
    now = performance.now(),
  ): GameAttackOrder | undefined {
    if (
      this.localCharacterId === undefined
      || !this.simulator.characters.has(this.localCharacterId)
      || !this.simulator.characters.has(targetId)
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
    if (!this.simulator.addOrder(this.localCharacterId, order)) return undefined
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
    const ability = this.abilityInSlot(slot)
    if (!ability.ok) return ability
    const { localCharacterId, def } = ability

    const tick = this.nextOrderTick(now)
    const state = this.simulator.at(tick).get(localCharacterId)
    if (!state) return { ok: false, reason: 'Your champion is not available.' }
    if (!state.getAbilityCooldown(def.id).ready) return { ok: false, reason: `${def.id} is on cooldown.` }
    const origin = state.getPosition()
    const aimed = this.castTarget(def, origin, aim, now, this.simulator.at(tick))
    if (!aimed.ok) return { ok: false, reason: aimed.reason }
    const { target } = aimed

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
    if (!this.simulator.addOrder(localCharacterId, order)) {
      return { ok: false, reason: 'The cast could not be scheduled.' }
    }
    this.trackOrder(order, now)
    return { ok: true, order }
  }

  // Whether the ability in a slot has something to aim; a self-cast does not.
  abilityNeedsAim(slot: number): boolean {
    const ability = this.abilityInSlot(slot)
    return ability.ok && ability.def.targeting !== 'none'
  }

  // Why the ability in a slot could not be cast now whatever the aim, such as a cooldown. Like the
  // preview it reads the frame being drawn; the cast itself checks again when it is issued.
  getCastBlocker(slot: number, now = performance.now()): string | undefined {
    const ability = this.abilityInSlot(slot)
    if (!ability.ok) return ability.reason
    const state = this.getSnapshotAtEstimatedTick(now).get(ability.localCharacterId)
    if (!state) return 'Your champion is not available.'
    if (!state.getAbilityCooldown(ability.def.id).ready) return `${ability.def.id} is on cooldown.`
    return undefined
  }

  // Resolves the cast as createCastOrder would, without issuing anything. It is called every
  // frame, so it reads the frame being drawn rather than the next order's tick: reading ahead
  // would advance the simulation a tick per frame and stamp later orders in the future.
  getCastPreview(slot: number, aim: Vector2, now = performance.now()): CastPreview | undefined {
    const ability = this.abilityInSlot(slot)
    if (!ability.ok) return undefined
    const { localCharacterId, def } = ability
    const frame = this.getSnapshotAtEstimatedTick(now)
    const origin = frame.get(localCharacterId)?.getPosition()
    if (!origin) return undefined
    const aimed = this.castTarget(def, origin, aim, now, frame)
    const shown = aimed.ok ? aimed.target : aimed.outOfRange
    return {
      abilityId: def.id,
      targeting: def.targeting,
      range: def.range,
      ...(def.indicator ? { indicator: { ...def.indicator } } : {}),
      ...(shown ? { target: shown } : {}),
      ...(!aimed.ok && aimed.outOfRange ? { outOfRange: true } : {}),
    }
  }

  private abilityInSlot(slot: number):
    | { ok: true; localCharacterId: number; def: AbilityDef }
    | { ok: false; reason: string } {
    const localCharacterId = this.localCharacterId
    const character = localCharacterId === undefined ? undefined : this.simulator.characters.get(localCharacterId)
    if (localCharacterId === undefined || !character) return { ok: false, reason: 'Your champion is not available.' }
    const abilityId = character.champion.abilityInSlot(slot)
    const def = abilityId === undefined ? undefined : getAbilityDef(abilityId)
    if (!def) return { ok: false, reason: 'No ability is bound to that key.' }
    return { ok: true, localCharacterId, def }
  }

  // `frame` is where the simulator will measure a unit's reach from: its position there is what
  // counts, not where it is drawn, since remote champions are drawn a little in the past.
  private castTarget(
    def: AbilityDef,
    origin: Vector2,
    aim: Vector2,
    now: number,
    frame: GameTickSnapshot,
  ): { ok: true; target: CastTarget } | { ok: false; reason: string; outOfRange?: CastTarget } {
    if (def.targeting === 'none') return { ok: true, target: { mode: 'none' } }
    if (def.targeting === 'point') {
      const dx = aim.x - origin.x
      const dy = aim.y - origin.y
      const distance = Math.hypot(dx, dy)
      const scale = distance > def.range ? def.range / distance : 1
      return { ok: true, target: { mode: 'point', point: { x: origin.x + dx * scale, y: origin.y + dy * scale } } }
    }
    if (def.targeting === 'direction') {
      const dir = quantizeDirection({ x: aim.x - origin.x, y: aim.y - origin.y })
      if (!dir) return { ok: false, reason: 'Aim away from your champion.' }
      return { ok: true, target: { mode: 'direction', dir } }
    }
    const unit = this.getEnemyNear(aim, now)
    if (!unit) return { ok: false, reason: `Aim ${def.id} at an enemy.` }
    const target: CastTarget = { mode: 'unit', unitId: unit.id }
    const unitAt = frame.get(unit.id)?.getPosition()
    if (!unitAt || !withinCastRange(origin, unitAt, def.range)) {
      return { ok: false, reason: `${def.id} is out of range of that target.`, outOfRange: target }
    }
    return { ok: true, target }
  }

  getAbilityCooldowns(now = performance.now()): AbilityCooldown[] {
    const localCharacterId = this.localCharacterId
    const character = localCharacterId === undefined ? undefined : this.simulator.characters.get(localCharacterId)
    if (localCharacterId === undefined || !character) return []
    const snapshot = this.getSnapshotAtEstimatedTick(now)
    const state = snapshot.get(localCharacterId)
    return character.champion.abilities.flatMap((abilityId, slot) => {
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

  getEnemyNear(point: Vector2, now = performance.now()): RenderedCharacter | undefined {
    return this.getCharacters(now)
      .filter((character) => character.id !== this.localCharacterId && character.player && !character.dead)
      .map((character) => ({
        character,
        distance: Math.hypot(character.position.x - point.x, character.position.y - point.y),
      }))
      .filter(({ character, distance }) => distance <= character.champion.radius + 6)
      .sort((left, right) => left.distance - right.distance)[0]?.character
  }

  getClosestEnemyInRange(now = performance.now()): RenderedCharacter | undefined {
    if (this.localCharacterId === undefined) return undefined
    const characters = this.getCharacters(now)
    const local = characters.find((character) => character.id === this.localCharacterId)
    if (!local) return undefined
    let closest: RenderedCharacter | undefined
    let closestDistance = local.attackRange
    for (const character of characters) {
      if (!character.player || character.dead || character.player.playerId === local.player?.playerId) continue
      const distance = Math.hypot(
        character.position.x - local.position.x,
        character.position.y - local.position.y,
      )
      if (distance <= closestDistance) {
        closest = character
        closestDistance = distance
      }
    }
    return closest
  }

  getLocalCharacterId(): number | undefined {
    return this.localCharacterId
  }

  getLocalAttackRange(now = performance.now()): number | undefined {
    const champion = this.localCharacterId === undefined
      ? undefined
      : this.simulator.characters.get(this.localCharacterId)?.champion
    if (this.localCharacterId === undefined || !champion) return undefined
    const statuses = this.getSnapshotAtEstimatedTick(now).get(this.localCharacterId)?.getStatuses() ?? []
    return champion.attackRangeWith(statuses)
  }

  getAttackCooldownProgress(now = performance.now()): number {
    const localCharacterId = this.localCharacterId
    const champion = localCharacterId === undefined
      ? undefined
      : this.simulator.characters.get(localCharacterId)?.champion
    if (localCharacterId === undefined || !champion) return 1
    const snapshot = this.getSnapshotAtEstimatedTick(now)
    const cooldown = snapshot.get(localCharacterId)?.getCooldown()
    if (!cooldown) return 1
    const ticksRemaining = this.fractionalTicksRemaining(snapshot.tick, cooldown.ticksRemaining, now)
    const total = champion.attackCooldownTicksWith(snapshot.get(localCharacterId)?.getStatuses() ?? [])
    return Math.max(0, Math.min(1, 1 - ticksRemaining / total))
  }

  applyOrder(order: GameBroadcastOrder): boolean {
    const applied = this.applySimulationOrder(order.characterId, order)
    return applied
  }

  // Returns false when the death is too old to schedule, so the caller should resync.
  applyDeath(death: GameDeath): boolean {
    const character = this.simulator.characters.get(death.characterId)
    if (!character) return false
    if (character.deaths.some(({ tick, respawnTick }) =>
      tick === death.tick && respawnTick === death.respawnTick)) return true
    return this.simulator.addDeath(death.characterId, {
      tick: death.tick,
      respawnTick: death.respawnTick,
    })
  }

  isLocalDead(now = performance.now()): boolean {
    if (this.localCharacterId === undefined) return false
    return this.getSnapshotAtEstimatedTick(now).get(this.localCharacterId)?.isDead() ?? false
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
      if (this.localCharacterId === undefined) return true
      return !this.simulator.removeOrder(this.localCharacterId, ack.seq)
    }
  }

  getCharacters(now = performance.now()): RenderedCharacter[] {
    const snapshot = this.getSnapshotAtEstimatedTick(now)
    const characters: RenderedCharacter[] = []
    const activeCharacterIds = new Set<number>()
    for (const character of this.simulator.characters.values()) {
      activeCharacterIds.add(character.id)
      const state = snapshot.get(character.id)
      const health = state?.getHealthState()
      characters.push({
        id: character.id,
        ...(character.player ? { player: { ...character.player } } : {}),
        champion: character.champion,
        ...(health ? { health } : {}),
        totalShield: state?.getShield() ?? 0,
        stacks: countMarkers(state?.getMarkers() ?? []),
        hasted: state?.getStatuses().some((status) => status.kind === 'haste') ?? false,
        slowed: state?.getStatuses().some((status) => status.kind === 'slow') ?? false,
        rooted: state?.getStatuses().some((status) => status.kind === 'root') ?? false,
        stunned: state?.getStatuses().some((status) => status.kind === 'stun') ?? false,
        attackRange: character.champion.attackRangeWith(state?.getStatuses() ?? []),
        attackCooldownTicks: character.champion.attackCooldownTicksWith(state?.getStatuses() ?? []),
        ...this.getRenderedCharacterView(character.id, now, snapshot),
      })
    }
    for (const characterId of this.renderedRemotePositions.keys()) {
      if (!activeCharacterIds.has(characterId)) this.renderedRemotePositions.delete(characterId)
    }
    return characters
  }

  getEntities(now = performance.now()): RenderedEntity[] {
    const snapshot = this.getSnapshotAtEstimatedTick(now)
    const renderTick = Math.max(snapshot.tick, this.estimateTick(now))
    return snapshot.getEntities().flatMap((entity) => {
      const def = getEntityDef(entity.defId)
      // The later copies of a volley wait at their origin until their turn.
      if (entity.startTick > Math.floor(renderTick)) return []
      return def
        ? [{
          ...entity,
          position: entityPosAt(entity, renderTick),
          radius: def.box ? Math.hypot(def.box.halfLength, def.box.halfWidth) : def.radius,
          visual: def.visual ?? 'bolt',
          // It runs one more tick than its lifetime, which is when its expiry effects fire.
          progress: entity.lifetimeTicks === undefined
            ? 0
            : Math.min(1, Math.max(0, (renderTick - entity.startTick) / (entity.lifetimeTicks + 1))),
          ...(def.color ? { color: def.color } : {}),
          ...(def.box ? { box: def.box } : {}),
        }]
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
    characterId: number,
    now: number,
    current: GameTickSnapshot,
  ): { position: Vector2; dead: boolean; dashing: boolean } {
    const fallback = {
      position: current.get(characterId)?.getPosition()
        ?? this.simulator.characters.get(characterId)?.initialPosition
        ?? { x: 0, y: 0 },
      dead: current.get(characterId)?.isDead() ?? false,
      dashing: false,
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
      const fromState = this.simulator.at(lowerTick).get(characterId)
      const from = fromState?.getPosition()
      if (!fromState || !from) return fallback
      const dead = fromState.isDead()
      const dashing = fromState.isDashing()
      if (fraction === 0 || lowerTick >= current.tick) return { position: from, dead, dashing }
      const to = this.simulator.at(lowerTick + 1).get(characterId)?.getPosition() ?? from
      // Interpolating across a respawn would slide the champion across the arena.
      if (Math.hypot(to.x - from.x, to.y - from.y) > REMOTE_SNAP_DISTANCE) return { position: from, dead, dashing }
      return {
        position: {
          x: from.x + (to.x - from.x) * fraction,
          y: from.y + (to.y - from.y) * fraction,
        },
        dead,
        dashing,
      }
    } catch (error) {
      if (error instanceof RangeError) return fallback
      throw error
    }
  }

  // Frames are whole ticks, which is fine at walking pace but steps visibly during a 15 px/tick
  // dash. Continue the last tick's step for the fraction of a tick that has passed, without
  // running past where the character is heading.
  private extrapolateLocalPosition(
    characterId: number,
    snapshot: GameTickSnapshot,
    now: number,
  ): Vector2 {
    const state = snapshot.get(characterId)
    const position = state?.getPosition() ?? { x: 0, y: 0 }
    const target = state?.getMoveTarget()
    const fraction = this.estimateTick(now) - snapshot.tick
    if (!target || fraction <= 0 || fraction >= 1) return position

    let previous: Vector2 | undefined
    try {
      previous = this.simulator.at(snapshot.tick - 1).get(characterId)?.getPosition()
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
    }
    if (!previous) return position
    const stepX = position.x - previous.x
    const stepY = position.y - previous.y
    const step = Math.hypot(stepX, stepY)
    // A jump this large is a respawn, not movement.
    if (step === 0 || step > LOCAL_EXTRAPOLATION_MAX_STEP) return position

    const advance = Math.min(step * fraction, Math.hypot(target.x - position.x, target.y - position.y))
    return { x: position.x + stepX / step * advance, y: position.y + stepY / step * advance }
  }

  private getRenderedCharacterView(
    characterId: number,
    now: number,
    snapshot: GameTickSnapshot,
  ): { position: Vector2; dead: boolean } {
    const character = this.simulator.characters.get(characterId)
    if (!character) return { position: { x: 0, y: 0 }, dead: false }
    if (characterId === this.localCharacterId) {
      const state = snapshot.get(characterId)
      return {
        position: state ? this.extrapolateLocalPosition(characterId, snapshot, now) : character.initialPosition,
        dead: state?.isDead() ?? false,
      }
    }
    const { position: target, dead, dashing } = this.getDelayedRemoteView(characterId, now, snapshot)

    const rendered = this.renderedRemotePositions.get(characterId)
    if (!rendered) {
      this.renderedRemotePositions.set(characterId, {
        position: target,
        updatedAt: now,
      })
      return { position: target, dead }
    }

    // A dash already moves smoothly between ticks, and chasing it at walking pace would lag.
    if (dashing) {
      rendered.position = target
      rendered.updatedAt = now
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

    const moveSpeed = character.champion.moveSpeed
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

  private applySimulationOrder(characterId: number, order: CharacterOrder): boolean {
    const character = this.simulator.characters.get(characterId)
    if (!character) return false
    return this.simulator.addOrder(characterId, order)
  }

  private trackOrder(order: GameOrder, now: number): void {
    const tracked: TrackedOrder = {
      order,
      sentAt: now,
    }
    this.localOrders.set(order.seq, tracked)
  }
}
