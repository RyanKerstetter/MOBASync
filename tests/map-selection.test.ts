import assert from 'node:assert/strict'
import test from 'node:test'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import { GameSnapshotSchema, Terrain } from '../packages/shared/src/index.ts'
import { testSpawns } from './test-spawns.ts'

// A game is played on the map its lobby picked: what the map has decides which modes can be played on it, and
// its start places which teams can.

const terrain = new Terrain({ width: 2400, height: 1000 })
const HILL = { x: 800, y: 400, width: 300, height: 300, ellipse: true }
const FLAGS = [{ x: 300, y: 500 }, { x: 2000, y: 500 }]

// A map with this many start places in each slot, and what it has for the modes.
const mapOf = (id: string, sizes: number[], extra: { hill?: boolean; flags?: boolean } = {}) => ({
  id,
  name: id.toUpperCase(),
  spawns: sizes.map((size, slot) => testSpawns[slot].slice(0, size)),
  terrain,
  ...(extra.hill ? { hill: HILL } : {}),
  flags: extra.flags ? FLAGS : [],
})

const playersOf = (teams: number[]) => teams.map((team, index) => ({ id: `p${index + 1}`, name: `P${index + 1}`, team }))
// Two teams of three and one of two.
const THREE_THREE_TWO = playersOf([1, 1, 1, 2, 2, 2, 3, 3])

test('teams that fit a map\'s start places can start on it, and ones that do not are told why', () => {
  const game = new ServerGameState([])
  const roomy = mapOf('pit', [4, 4, 2], { hill: true, flags: true })
  assert.equal(game.modeProblem(THREE_THREE_TWO, 'deathmatch', roomy), undefined, '3, 3 and 2 fit 4, 4 and 2')
  assert.equal(game.modeProblem(THREE_THREE_TWO, 'koth', roomy), undefined)

  const snug = mapOf('snug', [3, 3, 1])
  assert.match(game.modeProblem(THREE_THREE_TWO, 'deathmatch', snug) ?? '', /Green, the 3rd biggest team, has 2 players, but SNUG only has room for 1 on its 3rd biggest team/)
  assert.match(game.modeProblem(THREE_THREE_TWO, 'deathmatch', mapOf('duel', [4, 4])) ?? '', /DUEL has starting places for 2 teams, and there are 3/)
  assert.match(game.modeProblem(playersOf([1, 1, 1, 1, 2]), 'deathmatch', mapOf('tight', [3, 3])) ?? '', /Red is the biggest team, with 4 players, but TIGHT only has room for 3 on the biggest team/)
})

test('a mode is refused on a map that has nothing for it, saying what the map lacks', () => {
  const game = new ServerGameState([])
  const bare = mapOf('bare', [4, 4])
  const two = playersOf([1, 2])
  assert.equal(game.modeProblem(two, 'deathmatch', bare), undefined)
  assert.equal(game.modeProblem(two, 'koth', bare), 'BARE has no hill, so King of the Hill cannot be played on it.')
  assert.equal(game.modeProblem(two, 'ctf', bare), 'BARE has no flag for each of the first two teams, so Capture the Flag cannot be played on it.')
  assert.equal(game.modeProblem(two, 'koth', mapOf('hilly', [4, 4], { hill: true })), undefined)
  assert.equal(game.modeProblem(two, 'ctf', mapOf('flaggy', [4, 4], { flags: true })), undefined)
  // A map with a flag for the first team alone has no flags for capture the flag.
  assert.match(game.modeProblem(two, 'ctf', { ...bare, flags: [FLAGS[0]] }) ?? '', /no flag for each of the first two teams/)
})

test('a game that is played on the map it opened champion select on, and whose snapshot says which', () => {
  const game = new ServerGameState([])
  const players = playersOf([1, 2])
  const first = mapOf('pit', [4, 4], { hill: true })
  assert.equal(game.beginSelection(players, first, 'koth'), true)
  assert.match(game.modeProblem(playersOf([1, 2, 3])) ?? '', /PIT has starting places for 2 teams/, 'with no map given it is the map it is on')
  for (const player of players) game.lockChampion(player.id)
  game.begin(players)
  assert.equal(game.snapshot().map, 'pit')
  assert.ok(GameSnapshotSchema.safeParse(JSON.parse(JSON.stringify(game.snapshot()))).success)
  assert.deepEqual(game.snapshot().mode?.kind === 'koth' && game.snapshot().mode, { kind: 'koth', hill: HILL })

  // The next game is on another map, which has no hill and holds more.
  game.cancelStart()
  const second = mapOf('field', [4, 4, 2, 2])
  assert.equal(game.beginSelection(players, second, 'deathmatch'), true)
  assert.match(game.modeProblem(players, 'koth') ?? '', /FIELD has no hill/)
  assert.equal(game.modeProblem(playersOf([1, 2, 3, 4])), undefined)
  for (const player of players) game.lockChampion(player.id)
  game.begin(players)
  assert.equal(game.snapshot().map, 'field')
})

test('a game of teams that do not fit does not start, and says why in words, leaving everything as it was', () => {
  const game = new ServerGameState([])
  assert.equal(game.beginSelection(THREE_THREE_TWO, mapOf('snug', [3, 3, 1]), 'deathmatch'), true)
  for (const player of THREE_THREE_TWO) game.lockChampion(player.id)
  assert.throws(
    () => game.begin(THREE_THREE_TWO),
    /Green, the 3rd biggest team, has 2 players, but SNUG only has room for 1 on its 3rd biggest team\. Move players between teams, or pick another map\./,
  )
  assert.equal(game.status, 'selecting')
  assert.equal(game.simulator.characters.size, 0)
})

test('a game without a map in its snapshot is how it was: it carries no map name', () => {
  const game = new ServerGameState(testSpawns)
  const players = playersOf([1, 2])
  game.beginSelection(players)
  for (const player of players) game.lockChampion(player.id)
  game.begin(players)
  assert.equal('map' in game.snapshot(), false)
})
