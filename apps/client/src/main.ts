import './style.css'
import { createChampionSelect } from './champion-select.ts'
import { startGame } from './game.ts'
import { lobbyCodeFromSearch, searchWithLobby, searchWithoutLobby } from './lobby-link.ts'
import { abilityIconUrl } from './ui/ability-icon-urls.ts'
import { element, requireElement } from './ui/dom.ts'
import { lobbySummary } from './ui/results.ts'
import {
  GAME_MODES,
  GAME_TEAMS,
  getGameMode,
  getTeam,
  isGameMode,
  CAPTURE_SECONDS,
  mapRoomText,
  modeSupportProblem,
  RESPAWN_SECONDS,
  startProblem,
  supportedModes,
  teamHasRoom,
  type GameMode,
  type MapSummary,
  type PublicLobby as Lobby,
  type PublicPlayer as Player,
  type RulesChange,
} from '../../../packages/shared/src/index.ts'

type LobbyResponse = {
  lobby: Lobby
  player: Player
}

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
const copyStatus = requiredElement<HTMLSpanElement>('#copy-status')
const renameForm = requiredElement<HTMLFormElement>('#rename-form')
const lobbyUsernameInput = requiredElement<HTMLInputElement>('#lobby-username')
const playerCount = requiredElement<HTMLSpanElement>('#player-count')
const playerList = requiredElement<HTMLUListElement>('#player-list')
const teamPicker = requiredElement<HTMLDivElement>('#team-picker')
const mapSelect = requiredElement<HTMLSelectElement>('#map-select')
const mapSummary = requiredElement<HTMLParagraphElement>('#map-summary')
const modeSelect = requiredElement<HTMLSelectElement>('#mode-select')
const modeSummary = requiredElement<HTMLParagraphElement>('#mode-summary')
const modeWarning = requiredElement<HTMLParagraphElement>('#mode-warning')
const respawnInput = requiredElement<HTMLInputElement>('#rule-respawn')
const captureRow = requiredElement<HTMLElement>('#rule-capture-row')
const captureInput = requiredElement<HTMLInputElement>('#rule-capture')
const goldRow = requiredElement<HTMLElement>('#rule-gold-row')
const goldInput = requiredElement<HTMLInputElement>('#rule-gold')
const loseItemsRow = requiredElement<HTMLElement>('#rule-lose-items-row')
const loseItemsInput = requiredElement<HTMLInputElement>('#rule-lose-items')
const limitList = requiredElement<HTMLDivElement>('#rule-limits')
const gameActivity = requiredElement<HTMLParagraphElement>('#game-activity')
const lastResult = requiredElement<HTMLParagraphElement>('#last-result')
const endButton = requiredElement<HTMLButtonElement>('#end-button')
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
// While the leader's pick of mode is on its way to the server, the lobby as it was polled would put the old
// one back in the list.
let modeChangePending = false
let mapChangePending = false
let shownMaps = ''
let rulesChangePending = false

// crypto.randomUUID only exists on HTTPS pages and localhost; a VPS served over plain
// HTTP still has getRandomValues.
function createSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  return requireElement<T>(document, selector, 'lobby')
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  // The dev and preview servers proxy /api to the lobby server, so the page only needs its own origin.
  const response = await fetch(path, {
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

// A request about a lobby the player is in, which always says who is asking. Most answer with the
// lobby as it now is.
function lobbyRequest<T = { lobby: Lobby }>(
  lobby: Lobby,
  action: string,
  method = 'POST',
  body: Record<string, unknown> = {},
): Promise<T> {
  return request<T>(`/api/lobbies/${encodeURIComponent(lobby.code)}/${action}`, method, { sessionId, ...body })
}

// Asks the lobby server to do something in the lobby the player is in, and keeps the lobby it answers with. Nothing if there is no lobby or the server
// turns it down: the reason is shown as a message, or handed to `onError`.
async function lobbyAction(
  action: string,
  body: Record<string, unknown> = {},
  onError: (text: string) => void = (text) => setLobbyMessage(text, true),
): Promise<{ lobby: Lobby } | undefined> {
  if (!currentLobby) return undefined
  try {
    const result = await lobbyRequest(currentLobby, action, 'POST', body)
    currentLobby = result.lobby
    return result
  } catch (error) {
    onError(errorMessage(error))
    return undefined
  }
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
  // Said to everyone, so the players can fix it, and the leader cannot start until it is fixed.
  const map = lobby.maps.find((candidate) => candidate.id === lobby.map)
  const setupProblem = map
    ? startProblem(lobby.mode, lobby.players.map((player) => player.team), map)
    : 'The map this lobby picked is not on the server any more. Pick another.'
  startButton.disabled = !isLeader || lobby.game.status !== 'idle' || setupProblem !== undefined
  startButton.title = isLeader && setupProblem ? setupProblem : ''
  renderMapPicker(lobby, isLeader, map)
  renderModePicker(lobby, isLeader, setupProblem, map)
  renderRules(lobby, isLeader)
  renderGameActivity(lobby, isLeader)
  startButton.textContent = lobby.game.status === 'starting'
    ? 'Waiting for players…'
    : lobby.game.status === 'running'
      ? 'Game in progress'
      : lobby.game.status === 'finished'
        ? 'Game finished'
        : 'Start game'
  for (const player of lobby.players) {
    const leads = player.id === lobby.leaderId
    const team = getTeam(player.team)
    const indicator = element('span', leads ? 'player-icon leader-icon' : 'player-icon', leads ? '♛' : '♟')
    indicator.setAttribute('aria-label', leads ? 'Leader' : 'Player')
    const swatch = element('span', 'team-swatch')
    swatch.style.background = team.color
    swatch.setAttribute('aria-hidden', 'true')
    // The name of the team as well as its colour, so it does not rest on telling colours apart.
    const item = element('li', 'player-row', indicator, swatch, element('span', '', player.name), element('span', 'team-name', team.name))
    // Who is still in the game, for a lobby whose players have gone back to it while it goes on.
    if (lobby.game.playingPlayerIds.includes(player.id) && (lobby.game.status === 'running' || lobby.game.status === 'finished')) {
      item.append(element('span', 'player-status', lobby.game.status === 'finished' ? 'Results' : 'In game'))
    }
    if (!leads && isLeader) {
      item.append(element('span', 'player-actions', playerButton('Promote', 'leader', player), playerButton('Kick', 'players/kick', player)))
    }
    playerList.append(item)
  }
  playerCount.textContent = `${lobby.players.length}/${lobby.maxPlayers}`
  renderTeamPicker(lobby)

  const previousLatestId = chatMessages.lastElementChild?.getAttribute('data-message-id')
  chatMessages.replaceChildren(...lobby.messages.map((chat) => {
    const item = element('li', '', element('strong', '', `${chat.name}: `), chat.text)
    item.dataset.messageId = String(chat.id)
    return item
  }))
  const latestMessage = lobby.messages.at(-1)
  if (latestMessage && String(latestMessage.id) !== previousLatestId) {
    chatMessages.lastElementChild?.scrollIntoView({ block: 'nearest' })
  }
  syncChampionSelect(lobby)
}

// A button on a player's row, for the leader to promote or kick them with.
function playerButton(label: string, action: 'leader' | 'players/kick', player: Player): HTMLButtonElement {
  const button = element('button', '', label)
  button.type = 'button'
  button.addEventListener('click', () => void managePlayer(action, player))
  return button
}

// One button per team in its colour, the player's own ringed. Teams can only be changed in the
// lobby, so the buttons are off once a game is starting, and so are those of teams that are full.
function renderTeamPicker(lobby: Lobby): void {
  const own = lobby.players.find((player) => player.id === sessionId)?.team
  const others = lobby.players.filter((player) => player.id !== sessionId).map((player) => player.team)
  teamPicker.replaceChildren(...GAME_TEAMS.map((team) => {
    const full = !teamHasRoom(others, team.id)
    const button = element('button')
    button.type = 'button'
    button.style.background = team.color
    button.title = full ? `${team.name} (full)` : team.name
    button.setAttribute('aria-label', `${team.name} team${full ? ', full' : ''}`)
    button.setAttribute('aria-pressed', String(team.id === own))
    button.disabled = lobby.game.status !== 'idle' || full
    button.addEventListener('click', () => void chooseTeam(team.id))
    return button
  }))
}

respawnInput.min = String(RESPAWN_SECONDS.min)
respawnInput.max = String(RESPAWN_SECONDS.max)
respawnInput.step = '1'
captureInput.min = String(CAPTURE_SECONDS.min)
captureInput.max = String(CAPTURE_SECONDS.max)
captureInput.step = '1'

// One score limit for each mode, and only the selected mode's is shown: a kill limit means nothing to a game of
// capture the flag. A limit of 0 is no limit.
const limitRows = new Map<GameMode, { row: HTMLElement; input: HTMLInputElement }>()
for (const mode of GAME_MODES) {
  const input = element('input')
  input.type = 'number'
  input.min = '0'
  input.max = String(mode.maxLimit)
  input.step = '1'
  input.addEventListener('change', () => void changeRules({ scoreLimits: { [mode.id]: input.valueAsNumber } }))
  const row = element('label', 'rule-row', element('span', '', `${mode.limitLabel} (0 for no limit)`), input)
  row.hidden = true
  limitList.append(row)
  limitRows.set(mode.id, { row, input })
}
respawnInput.addEventListener('change', () => void changeRules({ respawnSeconds: respawnInput.valueAsNumber }))
captureInput.addEventListener('change', () => void changeRules({ captureSeconds: captureInput.valueAsNumber }))
goldInput.addEventListener('change', () => void changeRules({ gold: goldInput.checked }))
loseItemsInput.addEventListener('change', () => void changeRules({ loseItemsOnDeath: loseItemsInput.checked }))

// A number box shows what the lobby says, unless it is the one being typed in, or its change is on its way.
function showNumber(input: HTMLInputElement, value: number, force: boolean): void {
  if (!force && (rulesChangePending || document.activeElement === input)) return
  if (input.value !== String(value)) input.value = String(value)
}

// The leader's rules: how long a champion stays dead, how long the hill takes to capture (only for a game on
// the hill), whether there is gold and a shop and whether a death costs a champion its items (only for core destruction, the mode that has them: with no gold there are no
// items to lose, so that one is put away), and the
// limit of the mode that is selected. Everyone sees them; only the leader can change them, and only until the game starts.
function renderRules(lobby: Lobby, isLeader: boolean, force = false): void {
  const editable = isLeader && lobby.game.status === 'idle'
  respawnInput.disabled = !editable
  showNumber(respawnInput, lobby.rules.respawnSeconds, force)
  captureRow.hidden = lobby.mode !== 'koth'
  captureInput.disabled = !editable
  showNumber(captureInput, lobby.rules.captureSeconds, force)
  goldRow.hidden = lobby.mode !== 'core'
  goldInput.disabled = !editable
  if (force || !rulesChangePending) goldInput.checked = lobby.rules.gold
  loseItemsRow.hidden = lobby.mode !== 'core' || !lobby.rules.gold
  loseItemsInput.disabled = !editable
  // Like a number box, it keeps what was just clicked while the change is on its way.
  if (force || !rulesChangePending) loseItemsInput.checked = lobby.rules.loseItemsOnDeath
  for (const [id, { row, input }] of limitRows) {
    // A mode with no limit to set (Core Destruction, which ends when a team is out) shows none.
    row.hidden = id !== lobby.mode || getGameMode(id).maxLimit === 0
    input.disabled = !editable
    showNumber(input, lobby.rules.scoreLimits[id], force)
  }
}

async function changeRules(change: RulesChange): Promise<void> {
  if (!currentLobby) return
  rulesChangePending = true
  const result = await lobbyAction('rules', change, (text) => {
    setLobbyMessage(text, true)
    // Whatever was typed was not taken, so the boxes go back to what the lobby has.
    if (currentLobby) renderRules(currentLobby, currentLobby.leaderId === sessionId, true)
  })
  if (result) setLobbyMessage('')
  rulesChangePending = false
  if (currentLobby) renderLobby(currentLobby)
}

// What is happening to the game that has begun, who is in it, how the last one ended, and the leader's way
// to end the one that is on.
function renderGameActivity(lobby: Lobby, isLeader: boolean): void {
  const { status, playingPlayerIds } = lobby.game
  const waiting = playingPlayerIds.length
  gameActivity.hidden = status !== 'running' && status !== 'finished'
  gameActivity.textContent = status === 'finished'
    ? `The game is over. ${waiting} ${waiting === 1 ? 'player is' : 'players are'} still looking at the results.`
    : `A game is in progress: ${waiting} of ${lobby.players.length} players still playing.`
  endButton.hidden = !isLeader || (status !== 'running' && status !== 'finished')
  endButton.textContent = status === 'finished' ? 'Close game' : 'End game'
  lastResult.hidden = !lobby.lastResult
  lastResult.textContent = lobby.lastResult ? lobbySummary(lobby.lastResult) : ''
}

async function endGame(): Promise<void> {
  if (!currentLobby) return
  const finished = currentLobby.game.status === 'finished'
  const question = finished
    ? 'Close the game? Anyone still looking at its results goes back to the lobby.'
    : 'End the game for everyone? They go straight back to the lobby, and the team that is ahead wins.'
  if (!window.confirm(question)) return
  const result = await lobbyAction('end')
  if (result) renderLobby(result.lobby)
}

for (const mode of GAME_MODES) {
  const option = element('option', '', mode.name)
  option.value = mode.id
  modeSelect.append(option)
}

// The list of maps: the leader picks, and everyone else sees what was picked. A map that cannot be played on is
// in the list so it is known to be there, but cannot be picked, and what is wrong with it is shown if it is the
// one that is picked. Under it, what the map is: how big, what team setups it takes, and which modes it has what
// they need for.
function renderMapPicker(lobby: Lobby, isLeader: boolean, map: MapSummary | undefined): void {
  const listKey = JSON.stringify(lobby.maps.map((candidate) => [candidate.id, candidate.name, candidate.problem !== undefined]))
  if (listKey !== shownMaps) {
    shownMaps = listKey
    mapSelect.replaceChildren(...lobby.maps.map((candidate) => {
      const option = element('option', '', candidate.problem ? `${candidate.name} (cannot be played on)` : candidate.name)
      option.value = candidate.id
      option.disabled = candidate.problem !== undefined
      return option
    }))
  }
  if (!mapChangePending && mapSelect.value !== lobby.map) mapSelect.value = lobby.map
  mapSelect.disabled = !isLeader || lobby.game.status !== 'idle'
  mapSummary.textContent = !map
    ? ''
    : map.problem
      ? `Cannot be played on: ${map.problem}`
      : [
        map.description,
        `Size ${map.width} by ${map.height}. ${mapRoomText(map.spawns)}`,
        `Modes: ${supportedModes(map).map((mode) => getGameMode(mode).name).join(', ')}.`,
        map.monsters > 0 ? `${map.monsters} monster${map.monsters === 1 ? '' : 's'}.` : '',
      ].filter(Boolean).join(' ')
}

// The list of game modes: the leader picks, and everyone else sees what was picked. Like the teams, the mode is
// fixed once the game is starting. A mode the map has nothing for is in the list but cannot be picked, with why.
// `problem` is what stops the game from starting as the lobby is (the mode, the teams, the map), if anything.
function renderModePicker(lobby: Lobby, isLeader: boolean, problem: string | undefined, map: MapSummary | undefined): void {
  for (const option of Array.from(modeSelect.options)) {
    const reason = map && isGameMode(option.value) ? modeSupportProblem(option.value, map) : undefined
    const name = getGameMode(option.value as GameMode).name
    option.disabled = reason !== undefined
    option.title = reason ?? ''
    option.textContent = reason ? `${name} (not on this map)` : name
  }
  if (!modeChangePending && modeSelect.value !== lobby.mode) modeSelect.value = lobby.mode
  modeSelect.disabled = !isLeader || lobby.game.status !== 'idle'
  modeSummary.textContent = getGameMode(lobby.mode).summary
  modeWarning.textContent = problem ?? ''
  modeWarning.hidden = problem === undefined
}

async function chooseMap(id: string): Promise<void> {
  if (!currentLobby) return
  const before = currentLobby
  mapChangePending = true
  const result = await lobbyAction('map', { map: id })
  if (result) {
    const chosen = result.lobby.maps.find((candidate) => candidate.id === result.lobby.map)
    // A mode the new map cannot be played in is dropped for the default one, which is worth saying.
    setLobbyMessage(before.mode !== result.lobby.mode && chosen
      ? `${chosen.name} has no ${getGameMode(before.mode).name}, so the mode is now ${getGameMode(result.lobby.mode).name}.`
      : '')
  }
  mapChangePending = false
  if (currentLobby) renderLobby(currentLobby)
}

async function chooseMode(mode: string): Promise<void> {
  if (!currentLobby || !isGameMode(mode)) return
  modeChangePending = true
  if (await lobbyAction('mode', { mode })) setLobbyMessage('')
  modeChangePending = false
  if (currentLobby) renderLobby(currentLobby)
}

async function chooseTeam(team: number): Promise<void> {
  const result = await lobbyAction('team', { team })
  if (result) renderLobby(result.lobby)
}

const championSelect = createChampionSelect({
  root: selectPanel,
  abilityIconUrl,
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
  const result = await lobbyAction(action, body, (text) => {
    championSelect.setMessage(text, true)
    championSelect.discardPendingPick()
  })
  if (!result) return
  renderLobby(result.lobby)
  if (result.lobby.game.status === 'starting') void enterGame(result.lobby)
}

async function managePlayer(action: 'leader' | 'players/kick', player: Player): Promise<void> {
  if (!currentLobby) return
  const confirmation = action === 'leader'
    ? `Promote ${player.name} to lobby leader? You will lose leader permissions.`
    : `Kick ${player.name} from the lobby?`
  if (!window.confirm(confirmation)) return

  const result = await lobbyAction(action, { targetSessionId: player.id })
  if (!result) return
  renderLobby(result.lobby)
  setLobbyMessage(action === 'leader' ? `${player.name} is now the leader.` : `${player.name} was kicked.`)
}

// The address of the page names the lobby the player is in (`?lobby=ABC123`), so it can be copied from the bar and sent to a friend, who joins by opening it.
// With no code it names none. The rest of the address (the page's testing options) stays as it was.
function showLobbyInAddress(code?: string): void {
  const search = code === undefined ? searchWithoutLobby(window.location.search) : searchWithLobby(window.location.search, code)
  try {
    window.history.replaceState(null, '', window.location.pathname + search + window.location.hash)
  } catch {
    // A page that may not change its address (in a frame, say) is as it was, and the lobby works all the same.
  }
}

function showLobby(lobby: Lobby, player: Player): void {
  currentLobby = lobby
  activeCode.textContent = lobby.code
  showLobbyInAddress(lobby.code)
  lobbyUsernameInput.value = player.name
  usernameInput.value = player.name
  renderLobby(lobby)
  entryPanel.hidden = true
  lobbyPanel.hidden = false
  setLobbyMessage('')
  beginPolling()
  if (lobby.game.status === 'starting') void enterGame(lobby)
}

// Makes a lobby or joins one, with the button that asked for it off while that is under way.
async function openLobby(path: string, button: HTMLButtonElement | null, pending: string): Promise<void> {
  if (button) button.disabled = true
  setEntryMessage(pending)
  try {
    const result = await request<LobbyResponse>(path, 'POST', { sessionId, name: usernameInput.value })
    showLobby(result.lobby, result.player)
  } catch (error) {
    setEntryMessage(errorMessage(error), true)
  } finally {
    if (button) button.disabled = false
  }
}

function createLobby(): Promise<void> {
  return openLobby('/api/lobbies', createButton, 'Creating lobby…')
}

async function joinLobby(event: SubmitEvent): Promise<void> {
  event.preventDefault()
  const code = codeInput.value.trim().toUpperCase()
  if (!code) {
    setEntryMessage('Enter a lobby code to join.', true)
    return
  }

  await openLobby(`/api/lobbies/${encodeURIComponent(code)}/join`, joinForm.querySelector<HTMLButtonElement>('button[type="submit"]'), 'Joining lobby…')
}

async function refreshLobby(): Promise<void> {
  if (!currentLobby) return
  try {
    const result = await request<{ lobby: Lobby }>(
      `/api/lobbies/${encodeURIComponent(currentLobby.code)}?sessionId=${encodeURIComponent(sessionId)}`,
    )
    currentLobby = result.lobby
    // The leader closed the game while this player was looking at its results: back to the lobby.
    if (stopGame && gameRunning && result.lobby.game.status !== 'running' && result.lobby.game.status !== 'finished') {
      stopActiveGame()
      gamePanel.hidden = true
      lobbyPanel.hidden = false
      setLobbyMessage('The game was closed.')
    }
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
  const result = await lobbyAction('messages', { text })
  if (result) {
    renderLobby(result.lobby)
    chatInput.value = ''
    setLobbyMessage('')
  }
  if (sendButton) sendButton.disabled = false
  chatInput.focus()
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
    const result = await lobbyRequest<LobbyResponse>(currentLobby, 'player', 'PATCH', { name: lobbyUsernameInput.value })
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
    await lobbyRequest<unknown>(lobby, 'player', 'DELETE')
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
  showLobbyInAddress()
}

// A player goes back to the lobby, and the game goes on without them (if it is not over). They can see who is
// still playing there, and the game shuts down when the last of them has gone.
async function leaveGame(message?: string): Promise<void> {
  const lobby = currentLobby
  stopActiveGame()
  gamePanel.hidden = true
  lobbyPanel.hidden = false
  if (message) setLobbyMessage(message)
  if (lobby) {
    try {
      const result = await lobbyRequest(lobby, 'leave-game')
      currentLobby = result.lobby
    } catch (error) {
      setLobbyMessage(errorMessage(error), true)
    }
  }
  if (currentLobby) renderLobby(currentLobby)
  beginPolling()
}

async function startActiveGame(): Promise<void> {
  if (!currentLobby || stopGame || isEnteringGame || currentLobby.leaderId !== sessionId) return
  startButton.disabled = true
  try {
    const result = await lobbyRequest(currentLobby, 'start')
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
    const picked = lobby.maps.find((candidate) => candidate.id === lobby.map)
    const stop = await startGame({
      container: gameContainer,
      lobbyCode: lobby.code,
      sessionId,
      map: { id: lobby.map, width: picked?.width ?? 0, height: picked?.height ?? 0 },
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
      onLeave: (message) => void leaveGame(message),
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

mapSelect.addEventListener('change', () => void chooseMap(mapSelect.value))
modeSelect.addEventListener('change', () => void chooseMode(modeSelect.value))
endButton.addEventListener('click', () => void endGame())
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
      const result = await lobbyRequest(currentLobby, 'cancel-start')
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
const COPY_SUCCESS_MS = 2000
const COPY_FAILURE_MS = 8000

let copyResetTimer: number | undefined

// Says how copying went on the button itself and right beside it, since that is where the player is
// looking (the lobby's own message is at the bottom of the page). A failure turns the button red and
// stays up longer than a success, and says why.
function showCopyResult(failure?: string): void {
  window.clearTimeout(copyResetTimer)
  copyButton.textContent = failure === undefined ? 'Copied!' : 'Copy failed'
  copyButton.classList.toggle('is-error', failure !== undefined)
  copyStatus.textContent = failure ?? ''
  copyResetTimer = window.setTimeout(() => {
    copyButton.textContent = 'Copy'
    copyButton.classList.remove('is-error')
    copyStatus.textContent = ''
  }, failure === undefined ? COPY_SUCCESS_MS : COPY_FAILURE_MS)
}

// A page that is not on HTTPS has no clipboard to write to, so it copies the code from a selection of it, as pages did before there was
// one. When that fails too, the code is left selected, so copying it by hand is one Ctrl+C away.
function copyFromSelection(reason: string): void {
  window.getSelection()?.selectAllChildren(activeCode)
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    // It is the same as it not copying: the selection is there to be copied by hand.
  }
  showCopyResult(copied ? undefined : `${reason} The code is selected: press Ctrl+C to copy it yourself.`)
}

copyButton.addEventListener('click', () => {
  if (!currentLobby) return
  if (!navigator.clipboard) {
    copyFromSelection('Copying needs HTTPS.')
    return
  }
  void navigator.clipboard.writeText(currentLobby.code)
    .then(() => showCopyResult())
    .catch((error: unknown) => copyFromSelection(`Could not copy (${errorMessage(error)}).`))
})

// A page opened at a link to a lobby (`?lobby=ABC123`, which is what the address says in a lobby) joins it, as it is the whole of what the link is for: they are who the
// name box says, and can rename themselves in the lobby. One that cannot be joined (there is no such lobby, it is full or is in a game) is not left in the address, and its code is left in
// the join box with what went wrong.
const linkedCode = lobbyCodeFromSearch(window.location.search)
if (linkedCode) {
  codeInput.value = linkedCode
  void openLobby(
    `/api/lobbies/${encodeURIComponent(linkedCode)}/join`,
    joinForm.querySelector<HTMLButtonElement>('button[type="submit"]'),
    `Joining lobby ${linkedCode}…`,
  ).then(() => {
    if (!currentLobby) showLobbyInAddress()
  })
}

window.addEventListener('beforeunload', () => {
  if (!currentLobby) return
  void fetch(`/api/lobbies/${encodeURIComponent(currentLobby.code)}/player`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
    keepalive: true,
  })
})
