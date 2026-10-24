import type { GameMode, GameResult, GameStatus } from './index.js'
import type { MapSummary } from './maps.js'
import type { LobbyRules } from './modes.js'

// What the lobby server tells a page about a lobby, and what the page reads. They are one type here
// so the two cannot drift apart.

export type ChatMessage = {
  id: number
  playerId: string
  name: string
  text: string
}

export type PublicPlayer = {
  id: string
  name: string
  // The team they play on, picked in the lobby.
  team: number
}

export type PublicLobby = {
  code: string
  players: PublicPlayer[]
  leaderId: string
  messages: ChatMessage[]
  maxPlayers: number
  // The map the next game is played on, by its id, and every map the server has, which the leader picks from.
  map: string
  maps: MapSummary[]
  // How the next game is played, picked by the leader in the lobby.
  mode: GameMode
  // The rest of what the leader sets: how long a champion stays dead, and the score each mode is won at.
  rules: LobbyRules
  // How the last game ended, kept until the next one starts, so players back in the lobby can see it.
  lastResult?: GameResult
  game: {
    status: GameStatus
    readyPlayerIds: string[]
    // Who is in the game that is loading, running or finished. A player who went back to the lobby is not,
    // and the game shuts down when no one is.
    playingPlayerIds: string[]
    selections: Array<{ playerId: string; championId: string; locked: boolean }>
  }
}
