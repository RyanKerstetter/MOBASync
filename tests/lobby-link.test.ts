import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { LOBBY_PARAM, lobbyCodeFromSearch, searchWithLobby, searchWithoutLobby } from '../apps/client/src/lobby-link.ts'

// The address of the page is the link to a lobby: it names the lobby while the player is in it, so it can be copied from the bar and
// sent to a friend, and the page opened at it joins. What the address says and how it is read is here; joining from it is the page's
// own, which is tried in a browser and not here.

const CODE = 'K7P2QX'

// ---------------------------------------------------------------------------- the code in an address

test('a code is read the way the join form reads one: without spaces, in capitals', () => {
  assert.equal(lobbyCodeFromSearch(`?${LOBBY_PARAM}=k7p2qx`), CODE)
  assert.equal(lobbyCodeFromSearch(`?${LOBBY_PARAM}=%20${CODE}%20`), CODE)
})

test('an address that names no lobby gives no code', () => {
  assert.equal(lobbyCodeFromSearch(''), '')
  assert.equal(lobbyCodeFromSearch('?vision=range'), '')
  assert.equal(lobbyCodeFromSearch(`?${LOBBY_PARAM}=`), '')
  assert.equal(lobbyCodeFromSearch(`?${LOBBY_PARAM}=%20`), '')
})

test('the code is found among other options in the address', () => {
  assert.equal(lobbyCodeFromSearch(`?vision=off&${LOBBY_PARAM}=${CODE}&lag=300`), CODE)
})

// ---------------------------------------------------------------------------- the address of a lobby

test('the address of a lobby has its code in it and keeps the rest of the address, and a code already there is replaced', () => {
  assert.equal(searchWithLobby('', CODE), `?${LOBBY_PARAM}=${CODE}`)
  assert.equal(searchWithLobby('?vision=off', CODE), `?vision=off&${LOBBY_PARAM}=${CODE}`)
  assert.equal(searchWithLobby(`?${LOBBY_PARAM}=AAAAAA&vision=off`, CODE), `?${LOBBY_PARAM}=${CODE}&vision=off`, 'in place of the other lobby')
  assert.equal(lobbyCodeFromSearch(searchWithLobby('?vision=off', CODE)), CODE, 'and a friend opening it is given the code')
})

test('putting the lobby in an address and taking it out again leaves the address as it was', () => {
  for (const search of ['', '?vision=off', '?vision=off&lag=300']) {
    assert.equal(searchWithoutLobby(searchWithLobby(search, CODE)), search, search || 'no query')
  }
})

test('taking the lobby out of an address leaves the rest of it as it was', () => {
  assert.equal(searchWithoutLobby(`?vision=off&${LOBBY_PARAM}=${CODE}&lag=300`), '?vision=off&lag=300')
  assert.equal(searchWithoutLobby(`?${LOBBY_PARAM}=${CODE}&vision=off`), '?vision=off')
})

test('taking the lobby out of an address that is only the lobby leaves no query, and one without it is unchanged', () => {
  assert.equal(searchWithoutLobby(`?${LOBBY_PARAM}=${CODE}`), '')
  assert.equal(searchWithoutLobby(''), '')
  assert.equal(searchWithoutLobby('?vision=off'), '?vision=off')
})

// ---------------------------------------------------------------------------- the page

// There is no page to open in these tests, so this is what stands in for opening it: the page asks for each of its elements
// by id when it loads and stops there if one is missing, which is the whole of the lobby with it.
test('every element the lobby page asks for by id is in the page', () => {
  const html = readFileSync(new URL('../apps/client/index.html', import.meta.url), 'utf8')
  const script = readFileSync(new URL('../apps/client/src/main.ts', import.meta.url), 'utf8')
  const asked = [...script.matchAll(/requiredElement<[^>]+>\('#([\w-]+)'\)/g)].map((found) => found[1])
  assert.ok(asked.length > 40, 'the page asks for its elements the way this reads them')

  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((found) => found[1])
  assert.deepEqual(asked.filter((id) => !ids.includes(id)), [], 'ids the page asks for that it does not have')
  assert.equal(new Set(ids).size, ids.length, 'and no id is in it twice')
})
