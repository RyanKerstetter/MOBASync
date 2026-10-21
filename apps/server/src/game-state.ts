import {
  DEFAULT_CHAMPION_ID,
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  FINALIZE_LAG,
  GAME_DEATH_LEAD_TICKS,
  GAME_ORDER_VERDICT_RETENTION_MS,
  GAME_RESPAWN_TICKS,
  GameStatusSchema,
  getChampion,
  Simulator,
  type GameBroadcastOrder,
  type GameDeath,
  type GameOrder,
  type GameOrderAck,
  type GameSnapshot,
  type GameStatus,
} from '../../../packages/shared/src/index.js'

type LobbyPlayer = { id: string; name: string }
type CachedOrderAck = { ack: GameOrderAck; expiresAt: number }
type OrderVerdict = { ack: GameOrderAck; broadcast?: GameBroadcastOrder }
export class ServerGameState {
  status: GameStatus = GameStatusSchema.enum.idle
  readonly simulator = new Simulator()
  private readonly readyPlayers = new Set<string>()
  private readonly entityIdsByPlayerId = new Map<string, number>()
  private readonly orderAcksByPlayerId = new Map<string, Map<string, CachedOrderAck>>()
  private nextEntityId = 1

  get readyPlayerIds(): string[] {
    return [...this.readyPlayers]
  }

  begin(players: Iterable<LobbyPlayer>): void {
    this.status = GameStatusSchema.enum.starting
    this.readyPlayers.clear()
    this.simulator.reset()
    this.entityIdsByPlayerId.clear()
    this.orderAcksByPlayerId.clear()
    this.nextEntityId = 1

    const roster = [...players]
    roster.forEach((player, index) => {
      const entityId = this.nextEntityId
      this.nextEntityId += 1
      this.entityIdsByPlayerId.set(player.id, entityId)
      this.simulator.addPlayer(
        entityId,
        player.id,
        player.name,
        {
          x: GAME_ARENA_WIDTH * (index + 1) / (roster.length + 1),
          y: GAME_ARENA_HEIGHT / 2,
        },
        getChampion(DEFAULT_CHAMPION_ID),
      )
    })
  }

  cancelStart(): void {
    if (this.status !== GameStatusSchema.enum.starting) return
    this.status = GameStatusSchema.enum.idle
    this.readyPlayers.clear()
    this.simulator.reset()
    this.entityIdsByPlayerId.clear()
    this.orderAcksByPlayerId.clear()
  }

  markReady(playerId: string): boolean {
    if (this.status !== GameStatusSchema.enum.starting || !this.entityIdsByPlayerId.has(playerId)) {
      return false
    }
    this.readyPlayers.add(playerId)
    return true
  }

  unmarkReady(playerId: string): void {
    this.readyPlayers.delete(playerId)
  }

  startIfReady(): GameSnapshot | undefined {
    if (
      this.status !== GameStatusSchema.enum.starting
      || this.entityIdsByPlayerId.size === 0
      || this.readyPlayers.size !== this.entityIdsByPlayerId.size
    ) {
      return undefined
    }
    this.status = GameStatusSchema.enum.running
    return this.snapshot()
  }

  snapshot(): GameSnapshot {
    return this.simulator.snapshot()
  }

  // Returns the deaths confirmed this tick; the caller announces them to the players.
  advanceTick(): GameDeath[] {
    this.simulator.advanceTo(this.simulator.tick + 1)
    const commitTick = Math.max(0, this.simulator.tick - FINALIZE_LAG)
    if (commitTick > this.simulator.commitTick) {
      this.simulator.setCommitTick(commitTick)
    }
    return this.confirmDeaths()
  }

  // An entity at 0 health on a committed tick can no longer be saved by a late order, so
  // its death is definitive. It takes effect a few ticks ahead so every client can still
  // receive the message before the tick it names.
  private confirmDeaths(): GameDeath[] {
    const commitTick = this.simulator.commitTick
    const committed = this.simulator.at(commitTick)
    const deaths: GameDeath[] = []
    for (const entity of this.simulator.entities.values()) {
      const health = committed.get(entity.id)?.getHealthState()
      if (!health || health.hp > 0 || health.deathTick !== undefined) continue
      if (entity.deaths.some((death) => death.respawnTick > commitTick)) continue
      const tick = this.simulator.tick + GAME_DEATH_LEAD_TICKS
      const timing = { tick, respawnTick: tick + GAME_RESPAWN_TICKS }
      if (this.simulator.addDeath(entity.id, timing)) deaths.push({ entityId: entity.id, ...timing })
    }
    return deaths
  }

  getEntityId(playerId: string): number | undefined {
    return this.entityIdsByPlayerId.get(playerId)
  }

  getNextOrderSequence(playerId: string): number {
    const entityId = this.entityIdsByPlayerId.get(playerId)
    const entity = entityId === undefined ? undefined : this.simulator.entities.get(entityId)
    return (entity?.highestOrderSequence ?? 0) + 1
  }

  private getCachedOrderAck(playerId: string, orderId: string, now = Date.now()): GameOrderAck | undefined {
    const orderAcks = this.orderAcksByPlayerId.get(playerId)
    if (!orderAcks) return undefined
    for (const [id, cached] of orderAcks) {
      if (cached.expiresAt <= now) orderAcks.delete(id)
    }
    if (orderAcks.size === 0) this.orderAcksByPlayerId.delete(playerId)
    return this.orderAcksByPlayerId.get(playerId)?.get(orderId)?.ack
  }

  acceptOrder(playerId: string, order: GameOrder): OrderVerdict {
    const cachedAck = this.getCachedOrderAck(playerId, order.id)
    if (cachedAck) return { ack: cachedAck }

    const entityId = this.entityIdsByPlayerId.get(playerId)
    const attacker = entityId === undefined ? undefined : this.simulator.entities.get(entityId)
    const serverTick = this.simulator.tick
    let reason: string | undefined

    if (entityId === undefined || !attacker) {
      reason = order.type === 'move' ? 'The player entity is not available.' : 'dead'
    } else if (
      order.tick <= this.simulator.commitTick
      || order.tick < Math.max(0, serverTick - FINALIZE_LAG)
      || order.tick > serverTick + FINALIZE_LAG
    ) {
      reason = 'stale'
    } else if (order.type === 'attack' && !this.simulator.entities.has(order.targetId)) {
      reason = 'target_unavailable'
    } else if (order.type === 'cast' && !attacker.champion.hasAbility(order.abilityId)) {
      reason = 'unknown_ability'
    } else if (!this.simulator.addOrder(entityId, order)) {
      reason = 'duplicate'
    }

    const verdict: OrderVerdict = {
      ack: {
        id: order.id,
        seq: order.seq,
        status: reason ? 'rejected' : 'accepted',
        serverTick,
        ...(reason ? { reason } : {}),
      },
      ...(reason || !attacker || entityId === undefined
        ? {}
        : {
          broadcast: {
            ...order,
            entityId,
            playerId,
            playerName: attacker.player?.name ?? 'Player',
          },
        }),
    }
    this.cacheOrderAck(playerId, verdict.ack)
    return verdict
  }

  removePlayer(playerId: string): void {
    const entityId = this.entityIdsByPlayerId.get(playerId)
    if (entityId !== undefined) this.simulator.remove(entityId)
    this.entityIdsByPlayerId.delete(playerId)
    this.readyPlayers.delete(playerId)
    this.orderAcksByPlayerId.delete(playerId)
  }

  private cacheOrderAck(playerId: string, ack: GameOrderAck, now = Date.now()): void {
    const orderAcks = this.orderAcksByPlayerId.get(playerId) ?? new Map<string, CachedOrderAck>()
    const cached = orderAcks.get(ack.id)
    if (cached && cached.expiresAt > now) return
    for (const [id, entry] of orderAcks) {
      if (entry.expiresAt <= now) orderAcks.delete(id)
    }
    orderAcks.set(ack.id, { ack, expiresAt: now + GAME_ORDER_VERDICT_RETENTION_MS })
    this.orderAcksByPlayerId.set(playerId, orderAcks)
  }

}
