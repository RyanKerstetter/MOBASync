import {
  champions,
  createModeSetup,
  DEFAULT_CHAMPION_ID,
  DEFAULT_GAME_MODE,
  FINALIZE_LAG,
  GAME_ORDER_VERDICT_RETENTION_MS,
  GameStatusSchema,
  getChampion,
  getMonster,
  assignSpawns,
  leadingTeam,
  mapDisplayName,
  NO_OBJECTIVES,
  objectiveScores,
  Simulator,
  startProblem,
  teamSetupProblem,
  Terrain,
  winningTeam,
  type GameBroadcastOrder,
  type GameMode,
  type GameOrder,
  type GameOrderAck,
  type GameResult,
  type GameSnapshot,
  type GameStatus,
  type MapMonster,
  type MapObjectives,
  type ModeRules,
  type SpawnSlots,
} from '../../../packages/shared/src/index.js'

// `team` is the team the player picked in the lobby; leave it out for a team of their own.
type LobbyPlayer = { id: string; name: string; team?: number }
// A player with no team of their own is on one by themselves.
const teamsOf = (roster: readonly LobbyPlayer[]): number[] => roster.map((player, index) => player.team ?? index + 1)
type CachedOrderAck = { ack: GameOrderAck; expiresAt: number }
type OrderVerdict = { ack: GameOrderAck; broadcast?: GameBroadcastOrder }
export type ChampionSelection = { championId: string; locked: boolean }
// What a game is played on: the map's spawn points and ground, and its hill and flags if it has them. `id` is what
// the map is called to players (and in the snapshot), and `name` what the messages call it.
export type GameMap = {
  id?: string
  name?: string
  spawns: SpawnSlots
  terrain: Terrain
  // The monsters it starts with.
  monsters?: readonly MapMonster[]
} & Partial<MapObjectives>
export class ServerGameState {
  status: GameStatus = GameStatusSchema.enum.idle
  // How the game that is starting or running is played, set when its champion select opens.
  mode: GameMode = DEFAULT_GAME_MODE
  readonly simulator: Simulator
  // Champion select: one pick per player until the game begins.
  readonly selections = new Map<string, ChampionSelection>()
  private readonly readyPlayers = new Set<string>()
  private readonly characterIdsByPlayerId = new Map<string, number>()
  private readonly orderAcksByPlayerId = new Map<string, Map<string, CachedOrderAck>>()
  private nextCharacterId = 1
  // The map the game is on, by id, and what it is called: set with the map when champion select opens.
  private mapId: string | undefined
  private mapName = 'This map'
  private monsters: readonly MapMonster[] = []
  // How long a champion stays dead and what a team wins at, set with the mode when champion select opens.
  private rules: ModeRules = {}
  // The teams the game began with, and the players who went back to the lobby while it was running (with
  // what they had done), so how it ended can say how everyone did, and no team goes missing from it.
  private startTeams: number[] = []
  private readonly departed = new Map<string, GameResult['players'][number]>()
  // How the game ended, once it has.
  result: GameResult | undefined

  // `spawns` are the map's spawn points, where each team starts (see `assignSpawns`), and `terrain`
  // the ground it is played on: the map's arena and walls, or the plain arena with none. `objectives` are
  // the map's hill and flags, for the modes that use them. Starting a game can give it another map (see
  // `beginSelection`).
  constructor(
    private spawns: SpawnSlots,
    private terrain: Terrain = Terrain.plain(),
    private objectives: MapObjectives = NO_OBJECTIVES,
  ) {
    this.simulator = new Simulator(terrain)
  }

  get readyPlayerIds(): string[] {
    return [...this.readyPlayers]
  }

  // Who is in the game: everyone it began with who has not gone back to the lobby since.
  get playingPlayerIds(): string[] {
    return [...this.characterIdsByPlayerId.keys()]
  }

  // Why the game could not be played in its mode by these players, if it could not: the map has nothing for the
  // mode, the teams are too many or too few for it, or they do not fit the map's start places (see
  // `startProblem`). Asked before a game starts, of the map as it is now, and again when the last player locks
  // in, since players can leave while champions are picked. With no map given, it is the map the game is on.
  modeProblem(players: Iterable<LobbyPlayer>, mode: GameMode = this.mode, map?: Partial<GameMap>): string | undefined {
    const spawns = map?.spawns ?? this.spawns
    const objectives = map ? { hill: map.hill, flags: map.flags ?? [] } : this.objectives
    return startProblem(mode, teamsOf([...players]), {
      name: map?.name ?? (map?.id ? mapDisplayName(map.id) : this.mapName),
      spawns: spawns.map((points) => points.length),
      hill: objectives.hill !== undefined,
      flags: Boolean(objectives.flags[0] && objectives.flags[1]),
    })
  }

  // Opens champion select. With a map, the game is played on it: the server reads the map again for
  // every game, so one changed in Tiled is played on without restarting the server. The game is played
  // in `mode`, by `rules` (see `modeRules`).
  beginSelection(
    players: Iterable<LobbyPlayer>,
    map?: GameMap,
    mode: GameMode = DEFAULT_GAME_MODE,
    rules: ModeRules = {},
  ): boolean {
    if (this.status !== GameStatusSchema.enum.idle) return false
    if (map) {
      this.spawns = map.spawns
      this.terrain = map.terrain
      this.objectives = { flags: map.flags ?? [], ...(map.hill ? { hill: map.hill } : {}) }
      this.mapId = map.id
      this.monsters = map.monsters ?? []
      this.mapName = map.name ?? (map.id ? mapDisplayName(map.id) : 'This map')
    }
    this.mode = mode
    this.rules = rules
    this.result = undefined
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
    const roster = [...players]
    const teams = teamsOf(roster)
    // The biggest team starts at the first of the map's spawn points, the next biggest at the second.
    // Worked out before anything changes, since it throws if the map has too few points for the teams,
    // and so is what the mode is played for, since it throws if the teams or the map do not suit it.
    const fit = teamSetupProblem(teams, this.spawns.map((points) => points.length), this.mapName)
    if (fit) throw new RangeError(fit)
    const positions = assignSpawns(teams, this.spawns)
    const setup = createModeSetup(this.mode, teams, this.objectives, this.rules)

    this.status = GameStatusSchema.enum.starting
    this.readyPlayers.clear()
    this.simulator.reset(this.terrain, setup)
    this.characterIdsByPlayerId.clear()
    this.orderAcksByPlayerId.clear()
    this.departed.clear()
    this.startTeams = [...new Set(teams)]
    this.nextCharacterId = 1
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
    // The map's monsters come with the game, after the players, so every player's character has the ID it always had.
    for (const camp of this.monsters) {
      const id = this.nextCharacterId
      this.nextCharacterId += 1
      this.simulator.addMonster(id, getMonster(camp.monster), camp.at)
    }
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

  // Shuts the game down, whatever it was doing, so the lobby is a lobby again and another can be started.
  // How it ended is kept for whoever asks (see `result`) until the next game opens champion select.
  close(): void {
    this.status = GameStatusSchema.enum.idle
    this.selections.clear()
    this.readyPlayers.clear()
    this.simulator.reset()
    this.characterIdsByPlayerId.clear()
    this.orderAcksByPlayerId.clear()
    this.departed.clear()
  }

  // A game that has begun and has no one left in it is shut down. It is asked whenever players go.
  closeIfEmpty(): boolean {
    const begun = this.status === GameStatusSchema.enum.running || this.status === GameStatusSchema.enum.finished
    if (!begun || this.characterIdsByPlayerId.size > 0) return false
    this.close()
    return true
  }

  // A player goes back to the lobby from a game that is running or over. Their champion leaves the game (a
  // flag it carried is dropped where it stood), and what they had done is kept for the results. Nothing
  // happens for a player who is not in such a game.
  leaveGame(playerId: string): boolean {
    const begun = this.status === GameStatusSchema.enum.running || this.status === GameStatusSchema.enum.finished
    if (!begun || !this.characterIdsByPlayerId.has(playerId)) return false
    this.removePlayer(playerId)
    return true
  }

  // The game is over because the leader said so: the score as it stands is final, and the team that is
  // ahead, if any is, is the winner. Ending a game that is already over shuts it down, sending whoever is
  // still looking at its results back to the lobby.
  end(): GameResult | undefined {
    if (this.status === GameStatusSchema.enum.finished) {
      this.close()
      return undefined
    }
    return this.finish('ended')
  }

  // Ends the game with its results, from the score as the commit tick has it: no late order can still change
  // it, so no one is told of a win that is then taken back.
  private finish(reason: GameResult['reason']): GameResult | undefined {
    if (this.status !== GameStatusSchema.enum.running) return undefined
    const objective = this.simulator.at(this.simulator.commitTick).getObjective()
    const scores = objectiveScores(objective)
    const teams = [...new Set([...this.startTeams, ...Object.keys(scores).map(Number)])]
      .map((team) => ({ team, score: scores[String(team)] ?? 0 }))
      .sort((left, right) => right.score - left.score || left.team - right.team)
    const winner = reason === 'limit' ? winningTeam(this.simulator.mode, objective) : leadingTeam(scores)
    const players = [
      ...[...this.simulator.characters.values()].filter((character) => !character.monster).map((character) => ({
        name: character.player?.name ?? `Player ${character.id}`,
        team: character.team,
        kills: character.kills,
      })),
      ...this.departed.values(),
    ].sort((left, right) => right.kills - left.kills || left.name.localeCompare(right.name))
    this.status = GameStatusSchema.enum.finished
    this.result = {
      mode: this.mode,
      reason,
      ...(winner !== undefined ? { winner } : {}),
      ...(this.simulator.mode.scoreLimit !== undefined ? { scoreLimit: this.simulator.mode.scoreLimit } : {}),
      teams,
      players,
    }
    return this.result
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
    return { ...this.simulator.snapshot(), ...(this.mapId ? { map: this.mapId } : {}) }
  }

  // Runs the game a tick on. It gives how the game ended if that tick made a team the winner, which it is
  // once the score the commit tick has reached the limit: the game is over, and no tick is run after it.
  advanceTick(): GameResult | undefined {
    this.simulator.advanceTo(this.simulator.tick + 1)
    const commitTick = Math.max(0, this.simulator.tick - FINALIZE_LAG)
    if (commitTick > this.simulator.commitTick) {
      this.simulator.setCommitTick(commitTick)
    }
    if (this.status !== GameStatusSchema.enum.running) return undefined
    const objective = this.simulator.at(this.simulator.commitTick).getObjective()
    return winningTeam(this.simulator.mode, objective) === undefined ? undefined : this.finish('limit')
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
          },
        }),
    }
    this.cacheOrderAck(playerId, verdict.ack)
    return verdict
  }

  removePlayer(playerId: string): void {
    this.selections.delete(playerId)
    const characterId = this.characterIdsByPlayerId.get(playerId)
    if (characterId !== undefined) {
      const character = this.simulator.characters.get(characterId)
      if (character && this.status === GameStatusSchema.enum.running) {
        this.departed.set(playerId, {
          name: character.player?.name ?? `Player ${character.id}`,
          team: character.team,
          kills: character.kills,
          left: true,
        })
      }
      this.simulator.remove(characterId)
    }
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
