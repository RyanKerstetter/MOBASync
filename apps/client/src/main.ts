import './style.css'
import { createChampionSelect } from './champion-select.ts'
import { startGame } from './game.ts'
import type { GameStatus } from '../../../packages/shared/src/index.ts'

type Player = {
  id: string
  name: string
}

type Lobby = {
  code: string
  players: Player[]
  leaderId: string
  messages: ChatMessage[]
  maxPlayers: number
  game: {
    status: GameStatus
    readyPlayerIds: string[]
    selections: Array<{ playerId: string; championId: string; locked: boolean }>
  }
}

type ChatMessage = {
  id: number
  playerId: string
  name: string
  text: string
}

type LobbyResponse = {
  lobby: Lobby
  player: Player
}

// The dev and preview servers proxy /api to the lobby server, so the page only needs its own origin.
const apiUrl = ''
const sessionKey = 'lobby-session-id'
const sessionId = sessionStorage.getItem(sessionKey) ?? createSessionId()
sessionStorage.setItem(sessionKey, sessionId)

const entryPanel = requiredElement<HTMLElement>('#entry-panel')
const lobbyPanel = requiredElement<HTMLElement>('#lobby-panel')
const selectPanel = requiredElement<HTMLElement>('#select-panel')
const usernameInput = requiredElement<HTMLInputElement>('#username')
const createButton = requiredElement<HTMLButtonElement>('#create-button')
const joinForm = requiredElement<HTMLFormElement>('#join-form')
const codeInput = requiredElement<HTMLInputElement>('#lobby-code')
const message = requiredElement<HTMLParagraphElement>('#message')
const activeCode = requiredElement<HTMLParagraphElement>('#active-code')
const copyButton = requiredElement<HTMLButtonElement>('#copy-button')
const renameForm = requiredElement<HTMLFormElement>('#rename-form')
const lobbyUsernameInput = requiredElement<HTMLInputElement>('#lobby-username')
const playerCount = requiredElement<HTMLSpanElement>('#player-count')
const playerList = requiredElement<HTMLUListElement>('#player-list')
const chatMessages = requiredElement<HTMLUListElement>('#chat-messages')
const chatForm = requiredElement<HTMLFormElement>('#chat-form')
const chatInput = requiredElement<HTMLInputElement>('#chat-input')
const leaveButton = requiredElement<HTMLButtonElement>('#leave-button')
const startButton = requiredElement<HTMLButtonElement>('#start-button')
const gamePanel = requiredElement<HTMLElement>('#game-panel')
const gameContainer = requiredElement<HTMLDivElement>('#game-container')
const gameStatus = requiredElement<HTMLParagraphElement>('#game-status')
const gameLoading = requiredElement<HTMLElement>('#game-loading')
const gameLoadingProgress = requiredElement<HTMLParagraphElement>('#game-loading-progress')
const gameToast = requiredElement<HTMLParagraphElement>('#game-toast')
const returnButton = requiredElement<HTMLButtonElement>('#return-button')
const lobbyMessage = requiredElement<HTMLParagraphElement>('#lobby-message')

const TOAST_DURATION_MS = 3500
const LOBBY_POLL_MS = 1500
// Other players' picks arrive by polling, so check more often while choosing.
const SELECT_POLL_MS = 500

let currentLobby: Lobby | null = null
let pollTimer: number | undefined
let toastTimer: number | undefined
let gameRunning = false
let stopGame: (() => void) | undefined
let isEnteringGame = false
let gameGeneration = 0

// crypto.randomUUID only exists on HTTPS pages and localhost; a VPS served over plain
// HTTP still has getRandomValues.
function createSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) {
    throw new Error(`The lobby page is missing the required element: ${selector}`)
  }
  return element
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  // An empty or non-JSON body means the request never reached the lobby server (for example
  // a dev server running without its proxy), so report the status instead of a parse error.
  const text = await response.text()
  let result: ({ error?: string } & T) | undefined
  try {
    result = JSON.parse(text) as { error?: string } & T
  } catch {
    throw new Error(`The lobby server did not answer correctly (HTTP ${response.status}). If you just updated the code, restart npm run dev.`)
  }
  if (!response.ok) {
    throw new Error(result.error ?? `Request failed (${response.status})`)
  }
  return result
}

function setEntryMessage(text: string, isError = false): void {
  message.textContent = text
  message.classList.toggle('is-error', isError)
}

function setLobbyMessage(text: string, isError = false): void {
  lobbyMessage.textContent = text
  lobbyMessage.classList.toggle('is-error', isError)
}

// A running game shows nothing but the arena, so errors surface as a brief toast over it.
function showGameToast(text: string, persistent = false): void {
  window.clearTimeout(toastTimer)
  gameToast.textContent = text
  gameToast.hidden = false
  if (!persistent) toastTimer = window.setTimeout(hideGameToast, TOAST_DURATION_MS)
}

function hideGameToast(): void {
  window.clearTimeout(toastTimer)
  gameToast.hidden = true
}

function renderLobby(lobby: Lobby): void {
  playerList.replaceChildren()
  const isLeader = lobby.leaderId === sessionId
  startButton.disabled = !isLeader || lobby.game.status !== 'idle'
  startButton.textContent = lobby.game.status === 'starting'
    ? 'Waiting for players…'
    : lobby.game.status === 'running'
      ? 'Game in progress'
      : 'Start game'
  for (const player of lobby.players) {
    const item = document.createElement('li')
    item.className = 'player-row'
    const indicator = document.createElement('span')
    indicator.className = player.id === lobby.leaderId ? 'player-icon leader-icon' : 'player-icon'
    indicator.textContent = player.id === lobby.leaderId ? '♛' : '♟'
    indicator.setAttribute('aria-label', player.id === lobby.leaderId ? 'Leader' : 'Player')
    const name = document.createElement('span')
    name.textContent = player.name
    item.append(indicator, name)

    if (player.id !== lobby.leaderId && isLeader) {
      const actions = document.createElement('span')
      actions.className = 'player-actions'

      const promoteButton = document.createElement('button')
      promoteButton.type = 'button'
      promoteButton.textContent = 'Promote'
      promoteButton.addEventListener('click', () => void managePlayer('leader', player))

      const kickButton = document.createElement('button')
      kickButton.type = 'button'
      kickButton.textContent = 'Kick'
      kickButton.addEventListener('click', () => void managePlayer('players/kick', player))

      actions.append(promoteButton, kickButton)
      item.append(actions)
    }
    playerList.append(item)
  }
  playerCount.textContent = `${lobby.players.length}/${lobby.maxPlayers}`

  const previousLatestId = chatMessages.lastElementChild?.getAttribute('data-message-id')
  chatMessages.replaceChildren()
  for (const message of lobby.messages) {
    const item = document.createElement('li')
    item.dataset.messageId = String(message.id)
    const author = document.createElement('strong')
    author.textContent = `${message.name}: `
    item.append(author, document.createTextNode(message.text))
    chatMessages.append(item)
  }
  const latestMessage = lobby.messages.at(-1)
  if (latestMessage && String(latestMessage.id) !== previousLatestId) {
    chatMessages.lastElementChild?.scrollIntoView({ block: 'nearest' })
  }
  syncChampionSelect(lobby)
}

const championSelect = createChampionSelect({
  root: selectPanel,
  onPick: (championId) => void sendSelectionRequest('pick', { championId }),
  onLock: () => void sendSelectionRequest('lock', {}),
  onBack: () => void sendSelectionRequest('cancel-start', {}),
})

// Champion select replaces the lobby for everyone while the lobby is in the 'selecting' state.
function syncChampionSelect(lobby: Lobby): void {
  if (lobby.game.status === 'selecting') {
    const opening = selectPanel.hidden
    lobbyPanel.hidden = true
    selectPanel.hidden = false
    championSelect.render({
      localPlayerId: sessionId,
      players: lobby.players,
      selections: lobby.game.selections,
    })
    if (opening) {
      championSelect.setMessage('')
      beginPolling(SELECT_POLL_MS)
    }
    return
  }
  if (selectPanel.hidden) return
  selectPanel.hidden = true
  beginPolling()
  if (lobby.game.status === 'idle') {
    lobbyPanel.hidden = false
    setLobbyMessage('Champion select was cancelled.')
  }
}

async function sendSelectionRequest(
  action: 'pick' | 'lock' | 'cancel-start',
  body: Record<string, unknown>,
): Promise<void> {
  if (!currentLobby) return
  try {
    const result = await request<{ lobby: Lobby }>(
      `/api/lobbies/${encodeURIComponent(currentLobby.code)}/${action}`,
      'POST',
      { sessionId, ...body },
    )
    currentLobby = result.lobby
    renderLobby(result.lobby)
    if (result.lobby.game.status === 'starting') void enterGame(result.lobby)
  } catch (error) {
    championSelect.setMessage(errorMessage(error), true)
    championSelect.discardPendingPick()
  }
}

async function managePlayer(action: 'leader' | 'players/kick', player: Player): Promise<void> {
  if (!currentLobby) return
  const confirmation = action === 'leader'
    ? `Promote ${player.name} to lobby leader? You will lose leader permissions.`
    : `Kick ${player.name} from the lobby?`
  if (!window.confirm(confirmation)) return

  try {
    const result = await request<{ lobby: Lobby }>(
      `/api/lobbies/${encodeURIComponent(currentLobby.code)}/${action}`,
      'POST',
      { sessionId, targetSessionId: player.id },
    )
    currentLobby = result.lobby
    renderLobby(result.lobby)
    setLobbyMessage(action === 'leader' ? `${player.name} is now the leader.` : `${player.name} was kicked.`)
  } catch (error) {
    setLobbyMessage(errorMessage(error), true)
  }
}

function showLobby(lobby: Lobby, player: Player): void {
  currentLobby = lobby
  activeCode.textContent = lobby.code
  lobbyUsernameInput.value = player.name
  usernameInput.value = player.name
  renderLobby(lobby)
  entryPanel.hidden = true
  lobbyPanel.hidden = false
  setLobbyMessage('')
  beginPolling()
  if (lobby.game.status === 'starting') void enterGame(lobby)
}

async function createLobby(): Promise<void> {
  createButton.disabled = true
  setEntryMessage('Creating lobby…')
  try {
    const result = await request<LobbyResponse>('/api/lobbies', 'POST', {
      sessionId,
      name: usernameInput.value,
    })
    showLobby(result.lobby, result.player)
  } catch (error) {
    setEntryMessage(errorMessage(error), true)
  } finally {
    createButton.disabled = false
  }
}

async function joinLobby(event: SubmitEvent): Promise<void> {
  event.preventDefault()
  const code = codeInput.value.trim().toUpperCase()
  if (!code) {
    setEntryMessage('Enter a lobby code to join.', true)
    return
  }

  const submitButton = joinForm.querySelector<HTMLButtonElement>('button[type="submit"]')
  if (submitButton) submitButton.disabled = true
  setEntryMessage('Joining lobby…')
  try {
    const result = await request<LobbyResponse>(`/api/lobbies/${encodeURIComponent(code)}/join`, 'POST', {
      sessionId,
      name: usernameInput.value,
    })
    showLobby(result.lobby, result.player)
  } catch (error) {
    setEntryMessage(errorMessage(error), true)
  } finally {
    if (submitButton) submitButton.disabled = false
  }
}

async function refreshLobby(): Promise<void> {
  if (!currentLobby) return
  try {
    const result = await request<{ lobby: Lobby }>(
      `/api/lobbies/${encodeURIComponent(currentLobby.code)}?sessionId=${encodeURIComponent(sessionId)}`,
    )
    currentLobby = result.lobby
    renderLobby(result.lobby)
    if (result.lobby.game.status === 'starting') void enterGame(result.lobby)
  } catch (error) {
    if (error instanceof Error && error.message === 'You are no longer in this lobby.') {
      returnToEntry()
      setEntryMessage(error.message, true)
      return
    }
    setLobbyMessage(errorMessage(error), true)
  }
}

async function sendChatMessage(event: SubmitEvent): Promise<void> {
  event.preventDefault()
  if (!currentLobby) return
  const text = chatInput.value.trim()
  if (!text) return

  const sendButton = chatForm.querySelector<HTMLButtonElement>('button[type="submit"]')
  if (sendButton) sendButton.disabled = true
  try {
    const result = await request<{ lobby: Lobby }>(
      `/api/lobbies/${encodeURIComponent(currentLobby.code)}/messages`,
      'POST',
      { sessionId, text },
    )
    currentLobby = result.lobby
    renderLobby(result.lobby)
    chatInput.value = ''
    setLobbyMessage('')
  } catch (error) {
    setLobbyMessage(errorMessage(error), true)
  } finally {
    if (sendButton) sendButton.disabled = false
    chatInput.focus()
  }
}

function beginPolling(intervalMs = LOBBY_POLL_MS): void {
  window.clearInterval(pollTimer)
  pollTimer = window.setInterval(() => {
    void refreshLobby()
  }, intervalMs)
}

async function renamePlayer(event: SubmitEvent): Promise<void> {
  event.preventDefault()
  if (!currentLobby) return
  const saveButton = renameForm.querySelector<HTMLButtonElement>('button[type="submit"]')
  if (saveButton) saveButton.disabled = true
  setLobbyMessage('Saving username…')
  try {
    const result = await request<LobbyResponse>(
      `/api/lobbies/${encodeURIComponent(currentLobby.code)}/player`,
      'PATCH',
      { sessionId, name: lobbyUsernameInput.value },
    )
    currentLobby = result.lobby
    lobbyUsernameInput.value = result.player.name
    usernameInput.value = result.player.name
    renderLobby(result.lobby)
    setLobbyMessage('Username saved.')
  } catch (error) {
    setLobbyMessage(errorMessage(error), true)
  } finally {
    if (saveButton) saveButton.disabled = false
  }
}

async function leaveLobby(): Promise<void> {
  if (!currentLobby) return
  const lobby = currentLobby
  window.clearInterval(pollTimer)
  try {
    await request(`/api/lobbies/${encodeURIComponent(lobby.code)}/player`, 'DELETE', { sessionId })
  } catch (error) {
    setLobbyMessage(errorMessage(error), true)
    beginPolling()
    return
  }
  returnToEntry()
}

function returnToEntry(): void {
  stopActiveGame()
  window.clearInterval(pollTimer)
  currentLobby = null
  gamePanel.hidden = true
  selectPanel.hidden = true
  lobbyPanel.hidden = true
  entryPanel.hidden = false
  setLobbyMessage('')
}

async function startActiveGame(): Promise<void> {
  if (!currentLobby || stopGame || isEnteringGame || currentLobby.leaderId !== sessionId) return
  startButton.disabled = true
  try {
    const result = await request<{ lobby: Lobby }>(
      `/api/lobbies/${encodeURIComponent(currentLobby.code)}/start`,
      'POST',
      { sessionId },
    )
    currentLobby = result.lobby
    renderLobby(result.lobby)
    setLobbyMessage('Starting game. Waiting for every player to be ready…')
    await enterGame(result.lobby)
  } catch (error) {
    setLobbyMessage(errorMessage(error), true)
    if (currentLobby) renderLobby(currentLobby)
  }
}

async function enterGame(lobby: Lobby): Promise<void> {
  if (isEnteringGame || stopGame || lobby.game.status !== 'starting') return
  isEnteringGame = true
  const generation = ++gameGeneration
  lobbyPanel.hidden = true
  gamePanel.hidden = false
  gameLoading.hidden = false
  gameContainer.hidden = false
  gameRunning = false
  hideGameToast()
  gameStatus.textContent = 'Connecting to game server…'
  gameStatus.classList.remove('is-error')
  gameLoadingProgress.textContent = `0/${lobby.players.length} players ready`

  try {
    const stop = await startGame({
      container: gameContainer,
      lobbyCode: lobby.code,
      sessionId,
      playerName: lobbyUsernameInput.value || 'Player',
      onStatus: (text, isError = false) => {
        if (gameRunning) {
          if (isError) showGameToast(text)
          return
        }
        gameStatus.textContent = text
        gameStatus.classList.toggle('is-error', isError)
        if (isError) gameLoadingProgress.textContent = text
      },
      onReadyProgress: (readyCount, totalPlayers) => {
        gameLoadingProgress.textContent = `${readyCount}/${totalPlayers} players ready`
      },
      onStarted: () => {
        gameRunning = true
        gameLoading.hidden = true
      },
      onDisconnected: () => showGameToast('Disconnected from the game server.', true),
      onCancelled: (text) => {
        stopActiveGame()
        gamePanel.hidden = true
        lobbyPanel.hidden = false
        setLobbyMessage(text)
      },
    })
    if (generation !== gameGeneration) {
      stop()
      return
    }
    stopGame = stop
  } catch (error) {
    if (generation !== gameGeneration) return
    setLobbyMessage(errorMessage(error), true)
    gamePanel.hidden = true
    lobbyPanel.hidden = false
  } finally {
    if (generation === gameGeneration) {
      isEnteringGame = false
      if (currentLobby) renderLobby(currentLobby)
    }
  }
}

function stopActiveGame(): void {
  gameGeneration += 1
  isEnteringGame = false
  stopGame?.()
  stopGame = undefined
  gameRunning = false
  hideGameToast()
  gameContainer.hidden = true
  gameLoading.hidden = false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

createButton.addEventListener('click', () => void createLobby())
joinForm.addEventListener('submit', (event) => void joinLobby(event))
renameForm.addEventListener('submit', (event) => void renamePlayer(event))
chatForm.addEventListener('submit', (event) => void sendChatMessage(event))
leaveButton.addEventListener('click', () => void leaveLobby())
startButton.addEventListener('click', () => void startActiveGame())
returnButton.addEventListener('click', () => void returnFromGame())

async function returnFromGame(): Promise<void> {
  if (currentLobby?.game.status === 'starting') {
    try {
      const result = await request<{ lobby: Lobby }>(
        `/api/lobbies/${encodeURIComponent(currentLobby.code)}/cancel-start`,
        'POST',
        { sessionId },
      )
      currentLobby = result.lobby
    } catch (error) {
      gameStatus.textContent = errorMessage(error)
      gameStatus.classList.add('is-error')
      return
    }
  }
  stopActiveGame()
  gamePanel.hidden = true
  lobbyPanel.hidden = false
  if (currentLobby) renderLobby(currentLobby)
  beginPolling()
}
copyButton.addEventListener('click', () => {
  if (!currentLobby) return
  if (!navigator.clipboard) {
    setLobbyMessage('Copying needs HTTPS; select the code and copy it instead.', true)
    return
  }
  void navigator.clipboard.writeText(currentLobby.code)
    .then(() => setLobbyMessage('Lobby code copied.'))
    .catch((error: unknown) => setLobbyMessage(`Could not copy code: ${errorMessage(error)}`, true))
})

window.addEventListener('beforeunload', () => {
  if (!currentLobby) return
  void fetch(`${apiUrl}/api/lobbies/${encodeURIComponent(currentLobby.code)}/player`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
    keepalive: true,
  })
})
