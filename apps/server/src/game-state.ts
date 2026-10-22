import {
  champions,
  DEFAULT_CHAMPION_ID,
  FINALIZE_LAG,
  GAME_DEATH_LEAD_TICKS,
  GAME_ORDER_VERDICT_RETENTION_MS,
  GAME_RESPAWN_TICKS,
  GameStatusSchema,
  getChampion,
  Simulator,
  teamSpawnPositions,
  type GameBroadcastOrder,
  type GameDeath,
  type GameOrder,
  type GameOrderAck,
  type GameSnapshot,
  type GameStatus,
} from '../../../packages/shared/src/index.js'

// `team` is the team the player picked in the lobby; leave it out for a team of their own.
type LobbyPlayer = { id: string; name: string; team?: number }
type CachedOrderAck = { ack: GameOrderAck; expiresAt: number }
type OrderVerdict = { ack: GameOrderAck; broadcast?: GameBroadcastOrder }
export type ChampionSelection = { championId: string; locked: boolean }
export class ServerGameState {
  status: GameStatus = GameStatusSchema.enum.idle
  readonly simulator = new Simulator()
  // Champion select: one pick per player until the game begins.
  readonly selections = new Map<string, ChampionSelection>()
  private readonly readyPlayers = new Set<string>()
  private readonly characterIdsByPlayerId = new Map<string, number>()
  private readonly orderAcksByPlayerId = new Map<string, Map<string, CachedOrderAck>>()
  private nextCharacterId = 1

  get readyPlayerIds(): string[] {
    return [...this.readyPlayers]
  }

  beginSelection(players: Iterable<LobbyPlayer>): boolean {
    if (this.status !== GameStatusSchema.enum.idle) return false
    this.status = GameStatusSchema.enum.selecting
    this.selections.clear()
    for (const player of players) {
      this.selections.set(player.id, { championId: DEFAULT_CHAMPION_ID, locked: false })
    }
    return true
  }

  pickChampion(playerId: string, championId: string): boolean {
    const selection = this.selections.get(playerId)
    if (
      this.status !== GameStatusSchema.enum.selecting
      || !selection
      || selection.locked
      || !champions.has(championId)
    ) return false
    selection.championId = championId
    return true
  }

  lockChampion(playerId: string): boolean {
    const selection = this.selections.get(playerId)
    if (this.status !== GameStatusSchema.enum.selecting || !selection) return false
    selection.locked = true
    return true
  }

  allChampionsLocked(): boolean {
    return this.status === GameStatusSchema.enum.selecting
      && this.selections.size > 0
      && [...this.selections.values()].every(({ locked }) => locked)
  }

  begin(players: Iterable<LobbyPlayer>): void {
    this.status = GameStatusSchema.enum.starting
    this.readyPlayers.clear()
    this.simulator.reset()
    this.characterIdsByPlayerId.clear()
    this.orderAcksByPlayerId.clear()
    this.nextCharacterId = 1

    const roster = [...players]
    // A player with no team of their own is on one by themselves.
    const teams = roster.map((player, index) => player.team ?? index + 1)
    // Each team starts in its own slice of a circle round the middle of the map, side by side.
    const positions = teamSpawnPositions(teams)
    roster.forEach((player, index) => {
      const characterId = this.nextCharacterId
      this.nextCharacterId += 1
      this.characterIdsByPlayerId.set(player.id, characterId)
      this.simulator.addPlayer(
        characterId,
        player.id,
        player.name,
        positions[index],
        getChampion(this.selections.get(player.id)?.championId ?? DEFAULT_CHAMPION_ID),
        teams[index],
      )
    })
    this.selections.clear()
  }

  // Leaves champion select or the loading screen and goes back to the lobby.
  cancelStart(): void {
    if (
      this.status !== GameStatusSchema.enum.starting
      && this.status !== GameStatusSchema.enum.selecting
    ) return
    this.status = GameStatusSchema.enum.idle
    this.selections.clear()
    this.readyPlayers.clear()
    this.simulator.reset()
    this.characterIdsByPlayerId.clear()
    this.orderAcksByPlayerId.clear()
  }

  markReady(playerId: string): boolean {
    if (this.status !== GameStatusSchema.enum.starting || !this.characterIdsByPlayerId.has(playerId)) {
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
      || this.characterIdsByPlayerId.size === 0
      || this.readyPlayers.size !== this.characterIdsByPlayerId.size
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

  // A character at 0 health on a committed tick can no longer be saved by a late order, so
  // its death is definitive. It takes effect a few ticks ahead so every client can still
  // receive the message before the tick it names.
  private confirmDeaths(): GameDeath[] {
    const commitTick = this.simulator.commitTick
    const committed = this.simulator.at(commitTick)
    const deaths: GameDeath[] = []
    for (const character of this.simulator.characters.values()) {
      const health = committed.get(character.id)?.getHealthState()
      if (!health || health.hp > 0 || health.deathTick !== undefined) continue
      if (character.deaths.some((death) => death.respawnTick > commitTick)) continue
      const tick = this.simulator.tick + GAME_DEATH_LEAD_TICKS
      const timing = { tick, respawnTick: tick + GAME_RESPAWN_TICKS }
      if (this.simulator.addDeath(character.id, timing)) deaths.push({ characterId: character.id, ...timing })
    }
    return deaths
  }

  getCharacterId(playerId: string): number | undefined {
    return this.characterIdsByPlayerId.get(playerId)
  }

  getNextOrderSequence(playerId: string): number {
    const characterId = this.characterIdsByPlayerId.get(playerId)
    const character = characterId === undefined ? undefined : this.simulator.characters.get(characterId)
    return (character?.highestOrderSequence ?? 0) + 1
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

    const characterId = this.characterIdsByPlayerId.get(playerId)
    const attacker = characterId === undefined ? undefined : this.simulator.characters.get(characterId)
    const serverTick = this.simulator.tick
    let reason: string | undefined

    if (characterId === undefined || !attacker) {
      reason = order.type === 'move' ? 'The player character is not available.' : 'dead'
    } else if (
      order.tick <= this.simulator.commitTick
      || order.tick < Math.max(0, serverTick - FINALIZE_LAG)
      || order.tick > serverTick + FINALIZE_LAG
    ) {
      reason = 'stale'
    } else if (order.type === 'attack' && !this.simulator.characters.has(order.targetId)) {
      reason = 'target_unavailable'
    } else if (order.type === 'cast' && !attacker.champion.hasAbility(order.abilityId)) {
      reason = 'unknown_ability'
    } else if (!this.simulator.addOrder(characterId, order)) {
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
      ...(reason || !attacker || characterId === undefined
        ? {}
        : {
          broadcast: {
            ...order,
            characterId,
            playerId,
            playerName: attacker.player?.name ?? 'Player',
          },
        }),
    }
    this.cacheOrderAck(playerId, verdict.ack)
    return verdict
  }

  removePlayer(playerId: string): void {
    this.selections.delete(playerId)
    const characterId = this.characterIdsByPlayerId.get(playerId)
    if (characterId !== undefined) this.simulator.remove(characterId)
    this.characterIdsByPlayerId.delete(playerId)
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
