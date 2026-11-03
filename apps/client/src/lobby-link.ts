// The address of the page is the link to a lobby: while a player is in one it says so (`?lobby=ABC123`), so the address can be copied from the bar and sent, and whoever opens it joins.
export const LOBBY_PARAM = 'lobby'

// The code a page's address asks to join, as the server writes them, or nothing when it asks for none.
export function lobbyCodeFromSearch(search: string): string {
  return new URLSearchParams(search).get(LOBBY_PARAM)?.trim().toUpperCase() ?? ''
}

// The address's query with a lobby in it, for as long as the player is in that lobby, so that the address can be copied from the bar and sent: whoever opens it
// joins. Whatever else it holds stays, and the code takes the place of one that is already there.
export function searchWithLobby(search: string, code: string): string {
  const params = new URLSearchParams(search)
  params.set(LOBBY_PARAM, code)
  return `?${params.toString()}`
}

// The address's query without the lobby in it, once the player is not in one, so that the address does not go on
// naming a lobby they have left. Whatever else it holds stays.
export function searchWithoutLobby(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(LOBBY_PARAM)
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}
