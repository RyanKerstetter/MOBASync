import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomInt } from 'node:crypto'
import geckos from '@geckos.io/server'
import {
  champions,
  GAME_ORDER_TIMEOUT_MS,
  GAME_TPS,
  GameJoinSchema,
  GameOrderSchema,
  parseIdentifiedMessage,
  ReliableMessenger,
  type GameBroadcastOrder,
  type GameSnapshot,
} from '../../../packages/shared/src/index.js'
import { ServerGameState } from './game-state.js'

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
const playerTimeoutMs = 45_000
const maxPlayers = Number(process.env.LOBBY_MAX_PLAYERS ?? 2)
const checkpointIntervalMs = Number(process.env.GAME_CHECKPOINT_INTERVAL_MS ?? 1_000)

if (!Number.isInteger(maxPlayers) || maxPlayers < 1) {
  throw new Error('LOBBY_MAX_PLAYERS must be a positive integer.')
}
if (!Number.isInteger(checkpointIntervalMs) || checkpointIntervalMs < 1) {
  throw new Error('GAME_CHECKPOINT_INTERVAL_MS must be a positive integer.')
}
if (webrtcPortMax < webrtcPortMin) {
  throw new Error('WEBRTC_PORT_MAX must not be lower than WEBRTC_PORT_MIN.')
}

function readPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1025 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1025 to 65535.`)
  }
  return value
}

type Player = {
  id: string
  name: string
  lastSeen: number
}

type ChatMessage = {
  id: number
  playerId: string
  name: string
  text: string
}

type Lobby = {
  code: string
  players: Map<string, Player>
  leaderId: string
  messages: ChatMessage[]
  nextMessageId: number
  game: ServerGameState
}

type PublicPlayer = Pick<Player, 'id' | 'name'>
type PublicLobby = {
  code: string
  players: PublicPlayer[]
  leaderId: string
  messages: ChatMessage[]
  maxPlayers: number
  game: {
    status: Lobby['game']['status']
    readyPlayerIds: string[]
    selections: Array<{ playerId: string; championId: string; locked: boolean }>
  }
}
type PlayerRequest = { sessionId: string; name: string }
type GameDeliveryClient = {
  lobbyCode: string
  reliableMessenger: ReliableMessenger<GameBroadcastOrder>
}

const lobbies = new Map<string, Lobby>()
const gameServer = geckos({ portRange: { min: webrtcPortMin, max: webrtcPortMax }, iceServers })
const gameDeliveryClients = new Map<string, GameDeliveryClient>()

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(data))
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
  if (typeof body.sessionId !== 'string' || body.sessionId.trim().length === 0 || body.sessionId.length > 100) {
    throw new HttpError(400, 'A valid session ID is required.')
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    throw new HttpError(400, 'Username must be text.')
  }
  return {
    sessionId: body.sessionId,
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
    players: [...lobby.players.values()].map(({ id, name }) => ({ id, name })),
    leaderId: lobby.leaderId,
    messages: lobby.messages,
    maxPlayers,
    game: {
      status: lobby.game.status,
      readyPlayerIds: lobby.game.readyPlayerIds,
      selections: [...lobby.game.selections].map(([playerId, selection]) => ({ playerId, ...selection })),
    },
  }
}

function getGameSnapshot(lobby: Lobby): GameSnapshot {
  return lobby.game.snapshot()
}

function sendReadyProgress(lobby: Lobby): void {
  if (lobby.game.status !== 'starting') return
  gameServer.room(lobby.code).emit('game:ready-progress', {
    readyCount: lobby.game.readyPlayerIds.length,
    totalPlayers: lobby.players.size,
  }, { reliable: true })
}

// Champion select ends as soon as every remaining player has locked in.
function beginGameWhenAllLocked(lobby: Lobby): void {
  if (lobby.game.allChampionsLocked()) lobby.game.begin(lobby.players.values())
}

function startGameWhenReady(lobby: Lobby): void {
  const snapshot = lobby.game.startIfReady()
  if (snapshot) gameServer.room(lobby.code).emit('game:started', snapshot, { reliable: true })
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
    lastSeen: Date.now(),
  }
  lobby.players.set(sessionId, player)
  return { id: player.id, name: player.name }
}

function requireSessionId(url: URL): string {
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId) throw new HttpError(400, 'A session ID is required.')
  return sessionId
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
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
      game: new ServerGameState(),
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
  if (request.method === 'POST' && pathParts.length === 4 && pathParts[3] === 'join') {
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

  if (request.method === 'POST' && pathParts.length === 4 && pathParts[3] === 'start') {
    const body = await readJson(request)
    const sessionId = requireBodySessionId(body)
    requireLeader(lobby, sessionId)
    if (!lobby.game.beginSelection(lobby.players.values())) {
      throw new HttpError(409, 'A game is already starting or running.')
    }
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (request.method === 'POST' && pathParts.length === 4 && pathParts[3] === 'pick') {
    const body = await readJson(request)
    const sessionId = requireBodySessionId(body)
    if (!lobby.players.has(sessionId)) throw new HttpError(404, 'You are no longer in this lobby.')
    if (typeof body.championId !== 'string' || !champions.has(body.championId)) {
      throw new HttpError(400, 'Pick a champion from the list.')
    }
    if (!lobby.game.pickChampion(sessionId, body.championId)) {
      throw new HttpError(409, 'Your champion is locked in or champion select is not open.')
    }
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (request.method === 'POST' && pathParts.length === 4 && pathParts[3] === 'lock') {
    const body = await readJson(request)
    const sessionId = requireBodySessionId(body)
    if (!lobby.players.has(sessionId)) throw new HttpError(404, 'You are no longer in this lobby.')
    if (!lobby.game.lockChampion(sessionId)) {
      throw new HttpError(409, 'Champion select is not open.')
    }
    beginGameWhenAllLocked(lobby)
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (request.method === 'POST' && pathParts.length === 4 && pathParts[3] === 'cancel-start') {
    const body = await readJson(request)
    const sessionId = requireBodySessionId(body)
    if (!lobby.players.has(sessionId)) throw new HttpError(404, 'You are no longer in this lobby.')
    if (lobby.game.status === 'selecting') {
      lobby.game.cancelStart()
    } else if (lobby.game.status === 'starting') {
      lobby.game.cancelStart()
      gameServer.room(lobby.code).emit('game:cancelled', { message: 'A player cancelled game start.' }, { reliable: true })
    }
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (request.method === 'POST' && pathParts.length === 4 && pathParts[3] === 'messages') {
    const body = await readJson(request)
    if (typeof body.sessionId !== 'string' || body.sessionId.trim().length === 0) {
      throw new HttpError(400, 'A valid session ID is required.')
    }
    if (typeof body.text !== 'string') {
      throw new HttpError(400, 'Message must be text.')
    }
    const text = body.text.trim()
    if (!text) throw new HttpError(400, 'Message cannot be empty.')
    if (text.length > 500) throw new HttpError(400, 'Message must be 500 characters or fewer.')

    const player = lobby.players.get(body.sessionId)
    if (!player) throw new HttpError(404, 'You are no longer in this lobby.')
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

  if (request.method === 'POST' && pathParts.length === 4 && pathParts[3] === 'leader') {
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
    if (!lobby.players.delete(targetSessionId)) throw new HttpError(404, 'Player is no longer in this lobby.')
    lobby.game.removePlayer(targetSessionId)
    beginGameWhenAllLocked(lobby)
    sendReadyProgress(lobby)
    startGameWhenReady(lobby)
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (request.method === 'GET' && pathParts.length === 3) {
    const sessionId = requireSessionId(url)
    const player = lobby.players.get(sessionId)
    if (!player) throw new HttpError(404, 'You are no longer in this lobby.')
    player.lastSeen = Date.now()
    sendJson(response, 200, { lobby: toPublicLobby(lobby) })
    return
  }

  if (pathParts.length === 4 && pathParts[3] === 'player') {
    if (request.method === 'PATCH') {
      const playerRequest = getPlayerRequest(await readJson(request))
      if (!lobby.players.has(playerRequest.sessionId)) {
        throw new HttpError(404, 'You are no longer in this lobby.')
      }
      const player = upsertPlayer(lobby, playerRequest.sessionId, playerRequest.name)
      sendJson(response, 200, { lobby: toPublicLobby(lobby), player })
      return
    }

    if (request.method === 'DELETE') {
      const body = await readJson(request)
      const playerRequest = getPlayerRequest(body)
      lobby.players.delete(playerRequest.sessionId)
      lobby.game.removePlayer(playerRequest.sessionId)
      promoteOldestPlayer(lobby)
      beginGameWhenAllLocked(lobby)
      sendReadyProgress(lobby)
      startGameWhenReady(lobby)
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

function requireBodySessionId(body: Record<string, unknown>): string {
  if (typeof body.sessionId !== 'string' || body.sessionId.trim().length === 0 || body.sessionId.length > 100) {
    throw new HttpError(400, 'A valid session ID is required.')
  }
  return body.sessionId
}

function requireTargetSessionId(body: Record<string, unknown>): string {
  if (typeof body.targetSessionId !== 'string' || body.targetSessionId.trim().length === 0 || body.targetSessionId.length > 100) {
    throw new HttpError(400, 'A valid target player is required.')
  }
  return body.targetSessionId
}

function requireLeader(lobby: Lobby, sessionId: string): void {
  if (sessionId !== lobby.leaderId || !lobby.players.has(sessionId)) {
    throw new HttpError(403, 'Only the lobby leader can manage players.')
  }
}

const cleanupTimer = setInterval(() => {
  const expiredBefore = Date.now() - playerTimeoutMs
  for (const [code, lobby] of lobbies) {
    for (const [sessionId, player] of lobby.players) {
      if (player.lastSeen < expiredBefore) {
        lobby.players.delete(sessionId)
        lobby.game.removePlayer(sessionId)
      }
    }
    promoteOldestPlayer(lobby)
    beginGameWhenAllLocked(lobby)
    sendReadyProgress(lobby)
    startGameWhenReady(lobby)
  }
}, 15_000)
cleanupTimer.unref()

let nextGameTick = performance.now() + 1000 / GAME_TPS
let nextCheckpointAt = performance.now() + checkpointIntervalMs
function runGameTick(): void {
  const now = performance.now()
  for (const lobby of lobbies.values()) {
    if (lobby.game.status === 'running') {
      for (const death of lobby.game.advanceTick()) {
        gameServer.room(lobby.code).emit('game:death', death, { reliable: true })
      }
    }
  }

  if (now >= nextCheckpointAt) {
    for (const lobby of lobbies.values()) {
      if (lobby.game.status === 'running') {
        gameServer.room(lobby.code).emit('game:snapshot', getGameSnapshot(lobby), { reliable: true })
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
          channel.emit('game:snapshot', getGameSnapshot(joinedLobby), { reliable: true })
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
      channel.emit('game:started', getGameSnapshot(joinedLobby), { reliable: true })
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
    channel.emit('game:order-ack', verdict.ack, { reliable: true })
    if (verdict.broadcast) {
      sendReliableOrder(activeLobby.code, verdict.broadcast)
    }
  })

  channel.on('game:resync', () => {
    if (!lobby || !playerId || lobby.game.status !== 'running') return
    if (!lobby.players.has(playerId)) return
    channel.emit('game:snapshot', getGameSnapshot(lobby), { reliable: true })
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
