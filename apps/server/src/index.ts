import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomInt } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import geckos from '@geckos.io/server'
import {
  applyRulesChange,
  balancedTeam,
  champions,
  DEFAULT_GAME_MODE,
  defaultRules,
  GAME_MAX_PLAYERS,
  GAME_MAX_TEAM_SIZE,
  GAME_ORDER_TIMEOUT_MS,
  GAME_TPS,
  GameJoinSchema,
  GameOrderSchema,
  isGameMode,
  isTeamId,
  modeRules,
  modeSupportProblem,
  parseIdentifiedMessage,
  readRulesChange,
  ReliableMessenger,
  teamHasRoom,
  type ChatMessage,
  type GameBroadcastOrder,
  type GameMode,
  type GameResult,
  type LobbyRules,
  type MapSummary,
  type PublicLobby,
  type PublicPlayer,
} from '../../../packages/shared/src/index.js'
import { BandwidthMeter, formatBandwidthReport, type SendOptions } from './bandwidth.js'
import { ServerGameState, type GameMap } from './game-state.js'
import { isMapId, loadMapLayout } from './map.js'
import { MapCatalog } from './maps.js'
import { encodeSnapshot } from './snapshot-codec.js'

const port = readPort('LOBBY_API_PORT', 9208)
const gamePort = readPort('GECKOS_PORT', 9209)
// WebRTC media runs over UDP. Geckos multiplexes every connection onto one port, so
// opening WEBRTC_PORT_MIN (or the whole range up to WEBRTC_PORT_MAX) in the firewall is enough.
const webrtcPortMin = readPort('WEBRTC_PORT_MIN', 10_000)
const webrtcPortMax = readPort('WEBRTC_PORT_MAX', webrtcPortMin)
// A STUN server lets the game server learn its public address when the host sits behind
// NAT (most clouds). Set WEBRTC_ICE_SERVERS to a comma-separated list, or empty to disable.
const iceServers = (process.env.WEBRTC_ICE_SERVERS ?? 'stun:stun.l.google.com:19302')
  .split(',')
  .map((urls) => urls.trim())
  .filter(Boolean)
  .map((urls) => ({ urls }))
const codeCharacters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const lobbyCodeLength = 6
// A player who has not been heard from for this long is dropped from the lobby. Long, because a
// browser throttles a tab that is not showing, so an alt-tab can leave a player quiet for a while.
const playerTimeoutMs = 15 * 60_000
const maxPlayers = Number(process.env.LOBBY_MAX_PLAYERS ?? GAME_MAX_PLAYERS)
const checkpointIntervalMs = Number(process.env.GAME_CHECKPOINT_INTERVAL_MS ?? 1_000)

if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > GAME_MAX_PLAYERS) {
  throw new Error(`LOBBY_MAX_PLAYERS must be a whole number from 1 to ${GAME_MAX_PLAYERS}.`)
}
if (!Number.isInteger(checkpointIntervalMs) || checkpointIntervalMs < 1) {
  throw new Error('GAME_CHECKPOINT_INTERVAL_MS must be a positive integer.')
}
if (webrtcPortMax < webrtcPortMin) {
  throw new Error('WEBRTC_PORT_MAX must not be lower than WEBRTC_PORT_MIN.')
}
// The maps a game can be played on: every one in res/maps, or in the folder GAME_MAPS_DIR names. The leader of a
// lobby picks one, and where teams start, and what the modes can be played on, come from it. It is read again
// from its file when each game starts (see `readGameMap`), and the list of maps is kept up to date as files
// change. A server that has no map it can play on does not start at all.
const mapsDirectory = process.env.GAME_MAPS_DIR ? pathToFileURL(`${resolve(process.env.GAME_MAPS_DIR)}/`) : undefined
const maps = new MapCatalog(mapsDirectory)
if (!maps.defaultMapId()) {
  const found = maps.list({ fresh: true })
  throw new Error(found.length === 0
    ? 'There is no map to play on: put a map made in Tiled (a .tmj file) in res/maps, or in the folder GAME_MAPS_DIR names.'
    : `There is no map that can be played on:\n${found.map((map) => `${map.id}: ${map.problem}`).join('\n')}`)
}

function readPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1025 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1025 to 65535.`)
  }
  return value
}

type Player = PublicPlayer & { lastSeen: number }

type Lobby = {
  code: string
  players: Map<string, Player>
  leaderId: string
  messages: ChatMessage[]
  nextMessageId: number
  // The map the next game is played on, by id, and how it is played, both picked by the leader while the lobby
  // is idle.
  mapId: string
  mode: GameMode
  rules: LobbyRules
  // How the last game ended, kept until the next one starts.
  lastResult?: GameResult
  game: ServerGameState
}

type PlayerRequest = { sessionId: string; name: string }
type GameDeliveryClient = {
  lobbyCode: string
  reliableMessenger: ReliableMessenger<GameBroadcastOrder>
}

const lobbies = new Map<string, Lobby>()
const gameServer = geckos({ portRange: { min: webrtcPortMin, max: webrtcPortMax }, iceServers })
const gameDeliveryClients = new Map<string, GameDeliveryClient>()

// What the server sends, counted by kind of message and logged every GAME_BANDWIDTH_LOG_MS (5 s by
// default, 0 to turn it off), so it can be seen where the bandwidth goes. Only while something is sent.
const bandwidthLogMs = Number(process.env.GAME_BANDWIDTH_LOG_MS ?? 5_000)
if (!Number.isInteger(bandwidthLogMs) || bandwidthLogMs < 0) {
  throw new Error('GAME_BANDWIDTH_LOG_MS must be zero or a positive whole number of milliseconds.')
}
const bandwidth = bandwidthLogMs > 0 ? new BandwidthMeter() : undefined
// What Geckos calls a raw (binary) message. The only ones sent are gzipped snapshots, so they are counted
// as that.
const RAW_MESSAGE_EVENT = 'rawMessage'
function countSent(event: string, data: unknown, options?: SendOptions, recipients = 1): void {
  if (!bandwidth) return
  if (event === RAW_MESSAGE_EVENT) {
    bandwidth.record('game:snapshot', (data as Buffer).byteLength, options, recipients)
  } else {
    bandwidth.record(event, Buffer.byteLength(JSON.stringify(data ?? null)), options, recipients)
  }
}
// A message to everyone in a lobby's game. Geckos sends it by calling emit on each player's channel, which
// is where it is counted (see onConnection), so it is counted once for each of them.
function emitToRoom(lobbyCode: string, event: string, data: unknown, options?: SendOptions): void {
  gameServer.room(lobbyCode).emit(event, data as never, options)
}
// The game state to everyone in a lobby's game: gzipped once, however many players there are.
function emitSnapshotToRoom(lobby: Lobby): void {
  gameServer.raw.room(lobby.code).emit(encodeSnapshot(lobby.game.snapshot()))
}
if (bandwidth) {
  let lastFlushAt = performance.now()
  const bandwidthTimer = setInterval(() => {
    const now = performance.now()
    const report = bandwidth.flush(now - lastFlushAt)
    lastFlushAt = now
    if (report) console.log(formatBandwidthReport(report))
  }, bandwidthLogMs)
  bandwidthTimer.unref()
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
  const body = JSON.stringify(data)
  bandwidth?.record('http', Buffer.byteLength(body))
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16_384) {
      throw new HttpError(413, 'Request body is too large.')
    }
    chunks.push(buffer)
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, 'Request body must be a JSON object.')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'Request body must contain valid JSON.')
  }
}

function getPlayerRequest(body: Record<string, unknown>): PlayerRequest {
  const sessionId = requireBodySessionId(body)
  if (body.name !== undefined && typeof body.name !== 'string') {
    throw new HttpError(400, 'Username must be text.')
  }
  return {
    sessionId,
    name: normalizeName(typeof body.name === 'string' ? body.name : ''),
  }
}

function normalizeName(name: string): string {
  return name.trim().slice(0, 24) || 'Player'
}

function createCode(): string {
  let code = ''
  for (let index = 0; index < lobbyCodeLength; index += 1) {
    code += codeCharacters[randomInt(codeCharacters.length)]
  }
  return code
}

function createLobbyCode(): string {
  let code = createCode()
  while (lobbies.has(code)) code = createCode()
  return code
}

function getUniqueName(lobby: Lobby, sessionId: string, requestedName: string): string {
  const baseName = normalizeName(requestedName)
  const usedNames = new Set(
    [...lobby.players.values()]
      .filter((player) => player.id !== sessionId)
      .map((player) => player.name.toLocaleLowerCase()),
  )

  if (!usedNames.has(baseName.toLocaleLowerCase())) return baseName
  for (let suffix = 1; ; suffix += 1) {
    const suffixText = String(suffix)
    const candidate = `${baseName.slice(0, 24 - suffixText.length)}${suffixText}`
    if (!usedNames.has(candidate.toLocaleLowerCase())) return candidate
  }
}

function toPublicLobby(lobby: Lobby): PublicLobby {
  return {
    code: lobby.code,
    players: [...lobby.players.values()].map(({ id, name, team }) => ({ id, name, team })),
    leaderId: lobby.leaderId,
    messages: lobby.messages,
    maxPlayers,
    map: lobby.mapId,
    maps: maps.list(),
    mode: lobby.mode,
    rules: lobby.rules,
    ...(lobby.lastResult ? { lastResult: lobby.lastResult } : {}),
    game: {
      status: lobby.game.status,
      readyPlayerIds: lobby.game.readyPlayerIds,
      playingPlayerIds: lobby.game.playingPlayerIds,
      selections: [...lobby.game.selections].map(([playerId, selection]) => ({ playerId, ...selection })),
    },
  }
}

// The map for a game that is about to start, read from its file again, so one that was changed in
// Tiled since the server started is the one played on. One that is gone, or cannot be played on, is told to
// whoever started the game, with everything that is wrong with it, and the lobby stays as it was.
function readGameMap(id: string): GameMap {
  const summary = maps.get(id, { fresh: true })
  if (!summary) throw new HttpError(409, `The map "${id}" is not on the server any more. Pick another.`)
  try {
    const layout = loadMapLayout(id, mapsDirectory)
    console.log(`Map ${id}: ${layout.terrain.width} by ${layout.terrain.height}, ${layout.terrain.walls.length} walls`)
    return { ...layout, id, name: summary.name }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    throw new HttpError(409, `${summary.name} cannot be played on: ${message}`)
  }
}

// A game that is over: its results are kept on the lobby, for players back in it, and sent to everyone still
// in the game to be shown.
function announceResult(lobby: Lobby, result: GameResult): void {
  lobby.lastResult = result
  emitToRoom(lobby.code, 'game:ended', result, { reliable: true })
}

function sendReadyProgress(lobby: Lobby): void {
  if (lobby.game.status !== 'starting') return
  emitToRoom(lobby.code, 'game:ready-progress', {
    readyCount: lobby.game.readyPlayerIds.length,
    totalPlayers: lobby.players.size,
  }, { reliable: true })
}

// Champion select ends as soon as every remaining player has locked in. Players can leave while champions
// are picked, which can leave a mode without the teams it needs (capture the flag with one team left, say),
// and then the game is called off and the lobby is back to being a lobby.
function beginGameWhenAllLocked(lobby: Lobby): void {
  if (!lobby.game.allChampionsLocked()) return
  if (lobby.game.modeProblem(lobby.players.values())) {
    lobby.game.cancelStart()
    return
  }
  lobby.game.begin(lobby.players.values())
}

function startGameWhenReady(lobby: Lobby): void {
  const snapshot = lobby.game.startIfReady()
  if (snapshot) emitToRoom(lobby.code, 'game:started', snapshot, { reliable: true })
}

// Takes a player out of a lobby and its game.
function dropPlayer(lobby: Lobby, sessionId: string): boolean {
  const removed = lobby.players.delete(sessionId)
  lobby.game.removePlayer(sessionId)
  return removed
}

// A game that is waiting on its players goes as far as it can after the players change: champion
// select ends if everyone left has locked in, and the game starts if everyone left is ready.
function advanceGameStart(lobby: Lobby): void {
  beginGameWhenAllLocked(lobby)
  sendReadyProgress(lobby)
  startGameWhenReady(lobby)
  // A game no one is in any more (all went back to the lobby, or left it) is shut down.
  lobby.game.closeIfEmpty()
}

function sendReliableOrder(lobbyCode: string, order: GameBroadcastOrder): void {
  for (const client of gameDeliveryClients.values()) {
    if (client.lobbyCode !== lobbyCode) continue
    client.reliableMessenger.send(order)
  }
}

function promoteOldestPlayer(lobby: Lobby): void {
  if (lobby.players.has(lobby.leaderId)) return
  const oldestPlayer = lobby.players.keys().next()
  if (oldestPlayer.done) {
    lobbies.delete(lobby.code)
  } else {
    lobby.leaderId = oldestPlayer.value
  }
}

function requireLobby(code: string): Lobby {
  const lobby = lobbies.get(code.toUpperCase())
  if (!lobby) throw new HttpError(404, 'Lobby not found. Check the code and try again.')
  return lobby
}

function upsertPlayer(lobby: Lobby, sessionId: string, name: string): PublicPlayer {
  const player: Player = {
    id: sessionId,
    name: getUniqueName(lobby, sessionId, name),
    // Someone renaming themselves keeps their team; someone joining is put on the smaller side.
    team: lobby.players.get(sessionId)?.team
      ?? balancedTeam([...lobby.players.values()].map((existing) => existing.team)),
    lastSeen: Date.now(),
  }
  lobby.players.set(sessionId, player)
  return { id: player.id, name: player.name, team: player.team }
}

function requireMember(lobby: Lobby, sessionId: string): Player {
  const player = lobby.players.get(sessionId)
  if (!player) throw new HttpError(404, 'You are no longer in this lobby.')
  return player
}

function requireSessionId(url: URL): string {
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId) throw new HttpError(400, 'A session ID is required.')
  return sessionId
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS_HEADERS)
    response.end()
    return
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const pathParts = url.pathname.split('/').filter(Boolean)

  if (request.method === 'POST' && url.pathname === '/api/lobbies') {
    const playerRequest = getPlayerRequest(await readJson(request))
    const lobby: Lobby = {
      code: createLobbyCode(),
      players: new Map(),
      leaderId: playerRequest.sessionId,
      messages: [],
      nextMessageId: 1,
      mapId: maps.defaultMapId() ?? '',
      mode: DEFAULT_GAME_MODE,
      rules: defaultRules(),
      // Where teams start comes from the map picked, when the game opens champion select (see `beginSelection`).
      game: new ServerGameState([]),
    }
    const player = upsertPlayer(lobby, playerRequest.sessionId, playerRequest.name)
    lobbies.set(lobby.code, lobby)
    sendJson(response, 201, { lobby: toPublicLobby(lobby), player })
    return
  }

  if (pathParts[0] !== 'api' || pathParts[1] !== 'lobbies' || !pathParts[2]) {
    throw new HttpError(404, 'Route not found.')
  }

  const lobby = requireLobby(pathParts[2])
  const isAction = (name: string): boolean => request.method === 'POST' && pathParts.length === 4 && pathParts[3] === name
  if (isAction('join')) {
    const playerRequest = getPlayerRequest(await readJson(request))
    if (lobby.game.status !== 'idle') {
      throw new HttpError(409, 'This lobby has already started a game.')
    }
    if (!lobby.players.has(playerRequest.sessionId) && lobby.players.size >= maxPlayers) {
      throw new HttpError(409, `Lobby is full. The maximum is ${maxPlayers} players.`)
    }
    const player = upsertPlayer(lobby, playerRequest.sessionId, playerRequest.name)
    sendJson(response, 200, { lobby: toPublicLobby(lobby), player })
    return
  }

  // A player picks the team they will play on, until the game starts.
  if (isAction('team')) {
    const body = await readJson(request)
    const player = requireMember(lobby, requireBodySessionId(body))
    if (lobby.game.status !== 'idle') {
      throw new HttpError(409, 'Teams cannot be changed once the game is starting.')
    }
    if (!isTeamId(body.team)) throw new HttpError(400, 'Pick a team from the list.')
    const others = [...lobby.players.values()].filter((other) => other.id !== player.id)
    if (!teamHasRoom(others.map((other) => other.team), body.team)) {
      throw new HttpError(409, `That team is full. A team holds at most ${GAME_MAX_TEAM_SIZE} players.`)
    }
    player.team = body.team
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  // The leader picks the map the next game is played on, until the game starts. A mode the map has nothing for
  // is dropped for the default one, since it could not be played.
  if (isAction('map')) {
    const body = await readJson(request)
    requireLeader(lobby, requireBodySessionId(body))
    if (lobby.game.status !== 'idle') {
      throw new HttpError(409, 'The map cannot be changed once the game is starting.')
    }
    const map = isMapId(body.map) ? maps.get(body.map, { fresh: true }) : undefined
    if (!map) throw new HttpError(400, 'Pick a map from the list.')
    if (map.problem) throw new HttpError(409, `${map.name} cannot be played on: ${map.problem}`)
    lobby.mapId = map.id
    if (modeSupportProblem(lobby.mode, map)) lobby.mode = DEFAULT_GAME_MODE
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  // The leader picks how the next game is played, until the game starts. The mode has to be one the map can be
  // played in.
  if (isAction('mode')) {
    const body = await readJson(request)
    requireLeader(lobby, requireBodySessionId(body))
    if (lobby.game.status !== 'idle') {
      throw new HttpError(409, 'The game mode cannot be changed once the game is starting.')
    }
    if (!isGameMode(body.mode)) throw new HttpError(400, 'Pick a game mode from the list.')
    const map = maps.get(lobby.mapId)
    const problem = map ? modeSupportProblem(body.mode, map) : undefined
    if (problem) throw new HttpError(409, problem)
    lobby.mode = body.mode
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  // The leader sets the rules of the next game, until the game starts: how long a champion stays dead, and
  // the score a team wins at in each mode.
  if (isAction('rules')) {
    const body = await readJson(request)
    requireLeader(lobby, requireBodySessionId(body))
    if (lobby.game.status !== 'idle') {
      throw new HttpError(409, 'The rules cannot be changed once the game is starting.')
    }
    const read = readRulesChange(body)
    if ('problem' in read) throw new HttpError(400, read.problem)
    lobby.rules = applyRulesChange(lobby.rules, read.change)
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  // A player goes back to the lobby from the game, leaving the others to play on. Nothing happens for one who
  // is not in a game, so a page that has not caught up with the lobby can ask again.
  if (isAction('leave-game')) {
    const player = requireMember(lobby, requireBodySessionId(await readJson(request)))
    lobby.game.leaveGame(player.id)
    lobby.game.closeIfEmpty()
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  // The leader ends the game for everyone, with the score as it stands (the team ahead wins), or, if it is
  // already over, shuts it down so players still looking at its results are sent back to the lobby.
  if (isAction('end')) {
    requireLeader(lobby, requireBodySessionId(await readJson(request)))
    const { status } = lobby.game
    if (status !== 'running' && status !== 'finished') throw new HttpError(409, 'There is no game running to end.')
    const result = lobby.game.end()
    if (result) announceResult(lobby, result)
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (isAction('start')) {
    const body = await readJson(request)
    const sessionId = requireBodySessionId(body)
    requireLeader(lobby, sessionId)
    if (lobby.game.status !== 'idle') throw new HttpError(409, 'A game is already starting or running.')
    // The map is read again for every game, so what it has, and where teams start, is asked of the map as it is now.
    const map = readGameMap(lobby.mapId)
    const problem = lobby.game.modeProblem(lobby.players.values(), lobby.mode, map)
    if (problem) throw new HttpError(409, problem)
    if (!lobby.game.beginSelection(lobby.players.values(), map, lobby.mode, modeRules(lobby.rules, lobby.mode))) {
      throw new HttpError(409, 'A game is already starting or running.')
    }
    lobby.lastResult = undefined
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (isAction('pick')) {
    const body = await readJson(request)
    const sessionId = requireMember(lobby, requireBodySessionId(body)).id
    if (typeof body.championId !== 'string' || !champions.has(body.championId)) {
      throw new HttpError(400, 'Pick a champion from the list.')
    }
    if (!lobby.game.pickChampion(sessionId, body.championId)) {
      throw new HttpError(409, 'Your champion is locked in or champion select is not open.')
    }
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (isAction('lock')) {
    const body = await readJson(request)
    const sessionId = requireMember(lobby, requireBodySessionId(body)).id
    if (!lobby.game.lockChampion(sessionId)) {
      throw new HttpError(409, 'Champion select is not open.')
    }
    beginGameWhenAllLocked(lobby)
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (isAction('cancel-start')) {
    requireMember(lobby, requireBodySessionId(await readJson(request)))
    const wasStarting = lobby.game.status === 'starting'
    if (wasStarting || lobby.game.status === 'selecting') lobby.game.cancelStart()
    // Players already loading into the game are told it is off.
    if (wasStarting) {
      emitToRoom(lobby.code, 'game:cancelled', { message: 'A player cancelled game start.' }, { reliable: true })
    }
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (isAction('messages')) {
    const body = await readJson(request)
    const sessionId = requireBodySessionId(body)
    if (typeof body.text !== 'string') {
      throw new HttpError(400, 'Message must be text.')
    }
    const text = body.text.trim()
    if (!text) throw new HttpError(400, 'Message cannot be empty.')
    if (text.length > 500) throw new HttpError(400, 'Message must be 500 characters or fewer.')

    const player = requireMember(lobby, sessionId)
    player.lastSeen = Date.now()
    lobby.messages.push({
      id: lobby.nextMessageId,
      playerId: player.id,
      name: player.name,
      text,
    })
    lobby.nextMessageId += 1
    if (lobby.messages.length > 100) lobby.messages.shift()
    sendJson(response, 201, { lobby: toPublicLobby(lobby) })
    return
  }

  if (isAction('leader')) {
    const body = await readJson(request)
    const sessionId = requireBodySessionId(body)
    const targetSessionId = requireTargetSessionId(body)
    requireLeader(lobby, sessionId)
    if (!lobby.players.has(targetSessionId)) throw new HttpError(404, 'Player is no longer in this lobby.')
    lobby.leaderId = targetSessionId
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (request.method === 'POST' && pathParts.length === 5 && pathParts[3] === 'players' && pathParts[4] === 'kick') {
    const body = await readJson(request)
    const sessionId = requireBodySessionId(body)
    const targetSessionId = requireTargetSessionId(body)
    requireLeader(lobby, sessionId)
    if (targetSessionId === lobby.leaderId) throw new HttpError(400, 'The lobby leader cannot be kicked.')
    if (!dropPlayer(lobby, targetSessionId)) throw new HttpError(404, 'Player is no longer in this lobby.')
    advanceGameStart(lobby)
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (request.method === 'GET' && pathParts.length === 3) {
    requireMember(lobby, requireSessionId(url)).lastSeen = Date.now()
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (pathParts.length === 4 && pathParts[3] === 'player') {
    if (request.method === 'PATCH') {
      const playerRequest = getPlayerRequest(await readJson(request))
      requireMember(lobby, playerRequest.sessionId)
      const player = upsertPlayer(lobby, playerRequest.sessionId, playerRequest.name)
      sendJson(response, 200, { lobby: toPublicLobby(lobby), player })
      return
    }

    if (request.method === 'DELETE') {
      const playerRequest = getPlayerRequest(await readJson(request))
      dropPlayer(lobby, playerRequest.sessionId)
      promoteOldestPlayer(lobby)
      advanceGameStart(lobby)
      sendJson(response, 200, { success: true })
      return
    }
  }

  throw new HttpError(404, 'Route not found.')
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined)
      return
    }
    if (error instanceof HttpError) {
      sendJson(response, error.status, { error: error.message })
      return
    }
    console.error('Lobby request failed:', error)
    sendJson(response, 500, { error: 'The lobby server encountered an unexpected error.' })
  })
})

function requireSessionField(body: Record<string, unknown>, field: string, message: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 100) {
    throw new HttpError(400, message)
  }
  return value
}

function requireBodySessionId(body: Record<string, unknown>): string {
  return requireSessionField(body, 'sessionId', 'A valid session ID is required.')
}

function requireTargetSessionId(body: Record<string, unknown>): string {
  return requireSessionField(body, 'targetSessionId', 'A valid target player is required.')
}

function requireLeader(lobby: Lobby, sessionId: string): void {
  if (sessionId !== lobby.leaderId || !lobby.players.has(sessionId)) {
    throw new HttpError(403, 'Only the lobby leader can manage players.')
  }
}

const cleanupTimer = setInterval(() => {
  const expiredBefore = Date.now() - playerTimeoutMs
  for (const lobby of lobbies.values()) {
    for (const [sessionId, player] of lobby.players) {
      if (player.lastSeen < expiredBefore) dropPlayer(lobby, sessionId)
    }
    promoteOldestPlayer(lobby)
    advanceGameStart(lobby)
  }
}, 15_000)
cleanupTimer.unref()

let nextGameTick = performance.now() + 1000 / GAME_TPS
let nextCheckpointAt = performance.now() + checkpointIntervalMs
function runGameTick(): void {
  const now = performance.now()
  for (const lobby of lobbies.values()) {
    if (lobby.game.status === 'running') {
      const result = lobby.game.advanceTick()
      if (result) announceResult(lobby, result)
    }
  }

  // Sent once, not with Geckos' reliable option (which repeats a message ten times): the next one is
  // a second away, so a lost one costs nothing. A client that falls behind asks for one (game:resync).
  if (now >= nextCheckpointAt) {
    for (const lobby of lobbies.values()) {
      if (lobby.game.status === 'running') {
        emitSnapshotToRoom(lobby)
      }
    }
    nextCheckpointAt = now + checkpointIntervalMs
  }

  nextGameTick += 1000 / GAME_TPS
  if (nextGameTick < now) nextGameTick = now + 1000 / GAME_TPS
  const timer = setTimeout(runGameTick, Math.max(0, nextGameTick - performance.now()))
  timer.unref()
}
runGameTick()

server.listen(port, () => {
  console.log(`Lobby server listening on port ${port}`)
})

gameServer.onConnection((channel) => {
  // Everything sent to this player directly is counted too, including what the reliable messenger sends.
  const emitUncounted = channel.emit.bind(channel)
  channel.emit = ((event: string, data?: unknown, options?: SendOptions) => {
    countSent(event, data, options)
    emitUncounted(event, data as never, options)
  }) as typeof channel.emit
  let lobby: Lobby | undefined
  let playerId: string | undefined
  let deliveryClient: GameDeliveryClient | undefined
  let deliveryChannelId: string | undefined

  channel.on('game:join', (data) => {
    const parsed = GameJoinSchema.safeParse(data)
    if (!parsed.success) {
      channel.emit('game:error', { message: 'A valid lobby code and session ID are required.' }, { reliable: true })
      return
    }

    const joinedLobby = lobbies.get(parsed.data.lobbyCode.toUpperCase())
    const player = joinedLobby?.players.get(parsed.data.sessionId)
    if (!joinedLobby || !player) {
      channel.emit('game:error', { message: 'You are no longer in this lobby.' }, { reliable: true })
      return
    }
    if (joinedLobby.game.status === 'idle') {
      channel.emit('game:error', { message: 'The lobby leader has not started a game yet.' }, { reliable: true })
      return
    }

    lobby = joinedLobby
    playerId = player.id
    player.lastSeen = Date.now()
    channel.join(joinedLobby.code)
    deliveryChannelId = channel.id
    if (!deliveryChannelId) {
      channel.emit('game:error', { message: 'The game connection is not available.' }, { reliable: true })
      return
    }
    deliveryClient = {
      lobbyCode: joinedLobby.code,
      reliableMessenger: new ReliableMessenger<GameBroadcastOrder>({
        channel,
        messageEvent: 'game:order',
        acknowledgementEvent: 'game:order-delivery-ack',
        timeoutMs: GAME_ORDER_TIMEOUT_MS,
        parseAcknowledgement: parseIdentifiedMessage,
        onTimeout: () => {
          channel.raw.emit(encodeSnapshot(joinedLobby.game.snapshot()))
        },
        onAcknowledged: () => {
          const activePlayer = lobby?.players.get(player.id)
          if (activePlayer) activePlayer.lastSeen = Date.now()
        },
      }),
    }
    gameDeliveryClients.set(deliveryChannelId, deliveryClient)
    const characterId = joinedLobby.game.getCharacterId(player.id)
    if (characterId === undefined) {
      channel.emit('game:error', { message: 'Your game character is not available.' }, { reliable: true })
      return
    }
    channel.emit('game:joined', {
      playerId: player.id,
      characterId,
      nextOrderSeq: joinedLobby.game.getNextOrderSequence(player.id),
      serverTick: joinedLobby.game.simulator.tick,
    }, { reliable: true })
    if (joinedLobby.game.status === 'running') {
      channel.emit('game:started', joinedLobby.game.snapshot(), { reliable: true })
    } else if (joinedLobby.game.status === 'finished' && joinedLobby.lastResult) {
      channel.emit('game:ended', joinedLobby.lastResult, { reliable: true })
    } else {
      sendReadyProgress(joinedLobby)
    }
  })

  channel.on('playerReady', () => {
    if (!lobby || !playerId || !lobby.game.markReady(playerId)) return
    sendReadyProgress(lobby)
    startGameWhenReady(lobby)
  })

  channel.on('game:ping', (data) => {
    if (!lobby || lobby.game.status !== 'running') return
    if (
      typeof data !== 'object'
      || data === null
      || !('clientTime' in data)
      || typeof data.clientTime !== 'number'
      || !Number.isFinite(data.clientTime)
    ) return
    const player = playerId ? lobby.players.get(playerId) : undefined
    if (player) player.lastSeen = Date.now()
    channel.emit('game:pong', {
      clientTime: data.clientTime,
      serverTick: lobby.game.simulator.tick,
    })
  })

  channel.on('game:order', (data) => {
    if (!lobby || !playerId || lobby.game.status !== 'running') {
      channel.emit('game:error', { message: 'Orders are accepted only after the game starts.' }, { reliable: true })
      return
    }
    const activeLobby = lobby
    const activePlayerId = playerId
    if (!activeLobby.players.has(activePlayerId)) {
      channel.emit('game:error', { message: 'You are no longer in this lobby.' }, { reliable: true })
      return
    }
    const parsed = GameOrderSchema.safeParse(data)
    if (!parsed.success) {
      channel.emit('game:error', { message: 'Order must be a valid move, attack, or cast order.' }, { reliable: true })
      return
    }

    const player = activeLobby.players.get(activePlayerId)
    if (player) player.lastSeen = Date.now()
    const verdict = activeLobby.game.acceptOrder(activePlayerId, parsed.data)
    channel.emit('game:order-ack', verdict.ack)
    if (verdict.broadcast) {
      sendReliableOrder(activeLobby.code, verdict.broadcast)
    }
  })

  channel.on('game:resync', () => {
    if (!lobby || !playerId || lobby.game.status !== 'running') return
    if (!lobby.players.has(playerId)) return
    channel.raw.emit(encodeSnapshot(lobby.game.snapshot()))
  })

  channel.onDisconnect(() => {
    deliveryClient?.reliableMessenger.close()
    if (
      deliveryChannelId
      && deliveryClient
      && gameDeliveryClients.get(deliveryChannelId) === deliveryClient
    ) {
      gameDeliveryClients.delete(deliveryChannelId)
    }
    if (!lobby || !playerId || lobby.game.status !== 'starting') return
    lobby.game.unmarkReady(playerId)
    sendReadyProgress(lobby)
    startGameWhenReady(lobby)
  })
})
gameServer.listen(gamePort)
console.log(`Game server listening on port ${gamePort} (WebRTC UDP ${webrtcPortMin}-${webrtcPortMax})`)
