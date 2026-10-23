import type { ActionView } from './animation.ts'
import {
  leaderboardRows,
  visibleKillFeed,
  type KillFeedEntry,
  type KillFeedPerson,
  type LeaderboardRow,
} from './scoreboard.ts'
import {
  GAME_REMOTE_CATCHUP_EASE_TICKS,
  GAME_REMOTE_CATCHUP_MAX_SPEED_MULTIPLIER,
  GAME_REMOTE_RENDER_BUFFER_TICKS,
  GAME_SNAPSHOT_HISTORY_TICKS,
  GAME_TPS,
  FINALIZE_LAG,
  abilityOnKey,
  getAbilityDef,
  getEntityDef,
  entityPosAt,
  meetsRequirement,
  quantizeDirection,
  Simulator,
  withinCastRange,
  type AbilityDef,
  type AbilityIndicator,
  type CastOrder,
  type CastTarget,
  type BoxShape,
  type Champion,
  type CharacterOrder,
  type CharacterTickSnapshot,
  type DeathRecord,
  type GameAttackOrder,
  type GameBroadcastOrder,
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
    // Who it is on: the same team is teammates, and it decides the colour it is drawn in.
    team: number
    health?: GameHealthStats
    // Active shield statuses.
    totalShield: number
    position: Vector2
    // Dead as far as this client can tell: it has no health left. A late order from someone else can
    // still undo it until the commit tick passes it.
    dead: boolean
    // Markers on this character by key, such as 'curse' stacks.
    stacks: Record<string, number>
    hasted: boolean
    slowed: boolean
    rooted: boolean
    stunned: boolean
    burning: boolean
    blinded: boolean
    silenced: boolean
    // Dodging every auto attack aimed at it.
    dodging: boolean
    // What it is in the middle of, if anything: an auto attack or an ability, windup or backswing.
    action?: ActionView
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
  // The nearest it can be aimed, for an ability that has one.
  minRange?: number
  // The ability's own indicator size, when it has one.
  indicator?: AbilityIndicator
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
  private killFeed: KillFeedEntry[] = []
  private readonly announcedDeaths = new Set<string>()
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

  constructor() {
    this.simulator.onDeathConfirmed = (death) => this.recordConfirmedDeath(death)
  }

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
      id: `${this.localCharacterId}:${seq}`,
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

  createAttackOrder(targetId: number, now = performance.now()): GameAttackOrder | undefined {
    if (
      this.localCharacterId === undefined
      || !this.simulator.characters.has(this.localCharacterId)
      || !this.simulator.characters.has(targetId)
    ) return undefined

    const seq = this.nextOrderSequence
    const order: GameAttackOrder = {
      id: `${this.localCharacterId}:${seq}`,
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
  createCastOrder(slot: number, aim: Vector2, now = performance.now()): CastAttempt {
    const ability = this.abilityInSlot(slot)
    if (!ability.ok) return ability
    const { localCharacterId } = ability

    const tick = this.nextOrderTick(now)
    const frame = this.simulator.at(tick)
    const state = frame.get(localCharacterId)
    if (!state) return { ok: false, reason: 'Your champion is not available.' }
    // What the key does depends on the game: Q throws the stick, then calls it back.
    const entityOut = this.entityOut(frame, localCharacterId)
    const def = abilityOnKey(ability.def, entityOut)
    const blocker = this.castBlocker(def, state, entityOut)
    if (blocker) return { ok: false, reason: blocker }
    const origin = state.getPosition()
    const aimed = this.castTarget(def, origin, aim, now, frame)
    if (!aimed.ok) return { ok: false, reason: aimed.reason }
    const { target } = aimed

    const seq = this.nextOrderSequence
    const order: CastOrder = {
      id: `${localCharacterId}:${seq}`,
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

  // Whether the ability in a slot has something to aim; a self-cast does not. A key that has
  // turned into its recast is judged as that: calling the stick back needs no aim.
  abilityNeedsAim(slot: number, now = performance.now()): boolean {
    const ability = this.abilityInSlot(slot)
    if (!ability.ok) return false
    const frame = this.getSnapshotAtEstimatedTick(now)
    return abilityOnKey(ability.def, this.entityOut(frame, ability.localCharacterId)).targeting !== 'none'
  }

  // Why the ability in a slot could not be cast now whatever the aim, such as a cooldown. Like the
  // preview it reads the frame being drawn; the cast itself checks again when it is issued.
  getCastBlocker(slot: number, now = performance.now()): string | undefined {
    const ability = this.abilityInSlot(slot)
    if (!ability.ok) return ability.reason
    const frame = this.getSnapshotAtEstimatedTick(now)
    const state = frame.get(ability.localCharacterId)
    if (!state) return 'Your champion is not available.'
    const entityOut = this.entityOut(frame, ability.localCharacterId)
    return this.castBlocker(abilityOnKey(ability.def, entityOut), state, entityOut)
  }

  // Why this ability cannot be started by this character right now, if it cannot: the things the
  // simulator would quietly drop the order for.
  private castBlocker(
    def: AbilityDef,
    state: CharacterTickSnapshot,
    entityOut: (defId: string) => boolean,
  ): string | undefined {
    if (!state.getAbilityCooldown(def.id).ready) return `${def.id} is on cooldown.`
    const statuses = state.getStatuses()
    if (statuses.some((status) => status.kind === 'stun')) return 'You cannot cast while stunned.'
    if (statuses.some((status) => status.kind === 'silence')) return 'You cannot cast while silenced.'
    if (!meetsRequirement(def, entityOut, (abilityId) => !state.getAbilityCooldown(abilityId).ready) && def.requires) {
      const base = def.requires.out
        ? `${def.id} needs your ${def.requires.entity} out`
        : `${def.id} cannot be cast while your ${def.requires.entity} is out`
      return def.orWhen
        ? `${base}, or your ${def.orWhen.onCooldown} on cooldown with none in play.`
        : `${base}.`
    }
    return undefined
  }

  // Whether the local champion has an entity of a definition out in this frame.
  private entityOut(frame: GameTickSnapshot, localCharacterId: number): (defId: string) => boolean {
    const mine = frame.getEntities().filter((entity) => entity.ownerId === localCharacterId)
    return (defId) => mine.some((entity) => entity.defId === defId)
  }

  // Resolves the cast as createCastOrder would, without issuing anything. It is called every
  // frame, so it reads the frame being drawn rather than the next order's tick: reading ahead
  // would advance the simulation a tick per frame and stamp later orders in the future.
  getCastPreview(slot: number, aim: Vector2, now = performance.now()): CastPreview | undefined {
    const ability = this.abilityInSlot(slot)
    if (!ability.ok) return undefined
    const { localCharacterId } = ability
    const frame = this.getSnapshotAtEstimatedTick(now)
    const def = abilityOnKey(ability.def, this.entityOut(frame, localCharacterId))
    const origin = frame.get(localCharacterId)?.getPosition()
    if (!origin) return undefined
    const aimed = this.castTarget(def, origin, aim, now, frame)
    const shown = aimed.ok ? aimed.target : aimed.outOfRange
    return {
      abilityId: def.id,
      targeting: def.targeting,
      range: def.range,
      ...(def.minRange ? { minRange: def.minRange } : {}),
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
      const minRange = def.minRange ?? 0
      // An ability with a least distance has no heading from right on top of the caster.
      if (distance === 0 && minRange > 0) return { ok: false, reason: 'Aim away from your champion.' }
      // Held between the nearest and the farthest it can be aimed.
      const held = Math.max(minRange, Math.min(def.range, distance))
      const scale = distance === 0 ? 1 : held / distance
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
    const entityOut = this.entityOut(snapshot, localCharacterId)
    return character.champion.abilities.flatMap((keyed, slot) => {
      const keyedDef = getAbilityDef(keyed)
      if (!keyedDef) return []
      // A key that has turned into its recast shows that ability and its cooldown instead.
      const def = abilityOnKey(keyedDef, entityOut)
      return [{
        slot,
        abilityId: def.id,
        ticksRemaining: this.fractionalTicksRemaining(
          snapshot.tick,
          state?.getAbilityCooldown(def.id).ticksRemaining ?? 0,
          now,
        ),
        cooldownTicks: def.cooldownTicks,
      }]
    })
  }

  // The enemy under a point: the click that attacks, and the aim of an ability aimed at a unit.
  // Teammates are never one, so clicking on one just walks there.
  getEnemyNear(point: Vector2, now = performance.now()): RenderedCharacter | undefined {
    const localTeam = this.localCharacterId === undefined
      ? undefined
      : this.simulator.characters.get(this.localCharacterId)?.team
    return this.getCharacters(now)
      .filter((character) => character.id !== this.localCharacterId
        && character.player
        && !character.dead
        && character.team !== localTeam)
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
      if (!character.player || character.dead || character.team === local.team) continue
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

  // Who the local champion is going after: set by an attack order, and kept (through walking up to
  // them, and through every swing) until it moves, casts something with a windup, or the target goes.
  getLocalAttackTarget(now = performance.now()): number | undefined {
    if (this.localCharacterId === undefined) return undefined
    return this.getSnapshotAtEstimatedTick(now).get(this.localCharacterId)?.getAttackTarget()
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

  // Everyone's kills, most first. They count only deaths the commit tick has passed, which no late
  // order can undo any more, so a kill that is still a prediction is not on the board yet.
  getLeaderboard(): LeaderboardRow[] {
    return leaderboardRows(
      [...this.simulator.characters.values()].map((character) => ({
        id: character.id,
        name: character.player?.name ?? `Player ${character.id}`,
        team: character.team,
        kills: character.kills,
      })),
      this.localCharacterId,
    )
  }

  // The lines of the killfeed to show now. Like the leaderboard, a line is added once its death can
  // no longer be undone, although the champion itself fell on screen at once.
  getKillFeed(now = performance.now()): KillFeedEntry[] {
    this.killFeed = visibleKillFeed(this.killFeed, now)
    return this.killFeed
  }

  private recordConfirmedDeath(death: DeathRecord): void {
    const id = `${death.tick}:${death.victimId}`
    // A checkpoint can take the commit tick back, so a death may be confirmed a second time.
    if (this.announcedDeaths.has(id)) return
    this.announcedDeaths.add(id)
    if (this.announcedDeaths.size > 64) this.announcedDeaths.delete(this.announcedDeaths.values().next().value as string)
    const person = (characterId: number): KillFeedPerson | undefined => {
      const character = this.simulator.characters.get(characterId)
      return character
        ? { name: character.player?.name ?? `Player ${character.id}`, team: character.team }
        : undefined
    }
    const victim = person(death.victimId)
    if (!victim) return
    const killer = death.killerId === undefined ? undefined : person(death.killerId)
    this.killFeed = [...this.killFeed, {
      id,
      victim,
      ...(killer ? { killer } : {}),
      at: performance.now(),
    }]
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
        team: character.team,
        ...(health ? { health } : {}),
        totalShield: state?.getShield() ?? 0,
        stacks: countMarkers(state?.getMarkers() ?? []),
        hasted: state?.getStatuses().some((status) => status.kind === 'haste') ?? false,
        slowed: state?.getStatuses().some((status) => status.kind === 'slow') ?? false,
        rooted: state?.getStatuses().some((status) => status.kind === 'root') ?? false,
        stunned: state?.getStatuses().some((status) => status.kind === 'stun') ?? false,
        burning: state?.getStatuses().some((status) => status.kind === 'burn') ?? false,
        blinded: state?.getStatuses().some((status) => status.kind === 'blind') ?? false,
        silenced: state?.getStatuses().some((status) => status.kind === 'silence') ?? false,
        dodging: state?.getStatuses().some((status) => status.kind === 'dodge') ?? false,
        ...this.getActionView(snapshot, state, now),
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
      // A chaser's stored position is where it ended the snapshot's tick. Carry it on along its
      // heading for the part of a tick the frame is ahead, so it glides instead of stepping.
      const ahead = def?.homing && entity.position ? Math.max(0, renderTick - snapshot.tick) / GAME_TPS : 0
      const position = entityPosAt(entity, renderTick)
      return def
        ? [{
          ...entity,
          position: { x: position.x + entity.velocity.x * ahead, y: position.y + entity.velocity.y * ahead },
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

  // What the champion is in the middle of for its animation: the action, how far through it, and
  // the point it is aimed at.
  private getActionView(
    snapshot: GameTickSnapshot,
    state: ReturnType<GameTickSnapshot['get']>,
    now: number,
  ): { action?: ActionView } {
    const action = state?.getAction()
    if (!state || !action) return {}
    // An ability with no windup goes off the moment it is cast, so there is no casting to show.
    if (action.kind === 'cast' && (getAbilityDef(action.abilityId)?.windUpTicks ?? 0) <= 0) return {}
    const length = action.endTick - action.startTick
    const progress = length <= 0 ? 1 : Math.min(1, Math.max(0, (this.estimateTick(now) - action.startTick) / length))
    let aimAt: Vector2 | undefined
    if (action.kind === 'attack') aimAt = snapshot.get(action.targetId)?.getPosition()
    else if (action.target.mode === 'point') aimAt = action.target.point
    else if (action.target.mode === 'unit') aimAt = snapshot.get(action.target.unitId)?.getPosition()
    else if (action.target.mode === 'direction') {
      aimAt = { x: action.origin.x + action.target.dir.x * 100, y: action.origin.y + action.target.dir.y * 100 }
    }
    return { action: { kind: action.kind, progress, ...(aimAt ? { aimAt: { ...aimAt } } : {}) } }
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
