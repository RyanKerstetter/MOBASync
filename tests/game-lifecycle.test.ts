import assert from 'node:assert/strict'
import test from 'node:test'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import { type GameResult, type ModeRules } from '../packages/shared/src/index.ts'
import { brawler, defineChampion } from './fixtures.ts'
import { testSpawns } from './test-spawns.ts'

// How a game lives and dies on the server: it runs until a team reaches the score limit or the leader ends it,
// players can go back to the lobby while it runs, and when no one is left in it, it shuts down.

const oneShot = defineChampion({
  id: 't-one-shot',
  name: 'Test One Shot',
  base: { maxHp: 1000, attackDamage: 5000, attackSpeed: 1 },
  moveSpeed: 220,
  radius: 18,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: [...brawler.abilities],
})

// Ann (team 1, one hit kills) against Bob and Cy (team 2). Team 2 is the bigger, so it starts at the first slot.
const players = [
  { id: 'ann', name: 'Ann', team: 1 },
  { id: 'bob', name: 'Bob', team: 2 },
  { id: 'cy', name: 'Cy', team: 2 },
]

function runningGame(rules: ModeRules = {}): { game: ServerGameState; ids: Record<string, number> } {
  const game = new ServerGameState(testSpawns)
  assert.equal(game.beginSelection(players, undefined, 'deathmatch', rules), true)
  game.pickChampion('ann', oneShot.id)
  for (const player of players) game.lockChampion(player.id)
  game.begin(players)
  for (const player of players) game.markReady(player.id)
  assert.ok(game.startIfReady())
  assert.equal(game.status, 'running')
  const ids = Object.fromEntries(players.map((player) => [player.id, game.getCharacterId(player.id) as number]))
  return { game, ids }
}

// Ann kills Bob, and then Cy a little later.
function annKills(game: ServerGameState, ids: Record<string, number>, victims: Array<'bob' | 'cy'>): void {
  victims.forEach((victim, index) => {
    game.simulator.addOrder(ids.ann, {
      id: `ann:${index + 1}`, seq: index + 1, tick: 1 + index * 60, type: 'attack', targetId: ids[victim],
    })
  })
}

// Runs the game until a tick ends it, which it gives, for at most this many ticks.
function runUntilResult(game: ServerGameState, ticks = 400): GameResult | undefined {
  for (let tick = 0; tick < ticks; tick += 1) {
    const result = game.advanceTick()
    if (result) return result
  }
  return undefined
}

test('the game is given the rules it is played by, and they are in its snapshot', () => {
  const { game } = runningGame({ respawnTicks: 300, scoreLimit: 2 })
  assert.deepEqual(game.snapshot().mode, { kind: 'deathmatch', respawnTicks: 300, scoreLimit: 2 })
  assert.equal(game.simulator.respawnTicks, 300)
})

test('a game ends when a team reaches the score limit, and says who won and how everyone did', () => {
  const { game, ids } = runningGame({ scoreLimit: 2 })
  annKills(game, ids, ['bob', 'cy'])

  const result = runUntilResult(game)
  assert.ok(result, 'it ended')
  assert.equal(game.status, 'finished')
  assert.equal(game.result, result)
  assert.deepEqual(
    { mode: result.mode, reason: result.reason, winner: result.winner, scoreLimit: result.scoreLimit },
    { mode: 'deathmatch', reason: 'limit', winner: 1, scoreLimit: 2 },
  )
  assert.deepEqual(result.teams, [{ team: 1, score: 2 }, { team: 2, score: 0 }], 'every team is on it, the winner first')
  assert.deepEqual(result.players, [
    { name: 'Ann', team: 1, kills: 2 },
    { name: 'Bob', team: 2, kills: 0 },
    { name: 'Cy', team: 2, kills: 0 },
  ])
  assert.equal(game.advanceTick(), undefined, 'a game that is over does not end again')
})

test('a team below the limit has not won, and a game with no limit does not end by itself', () => {
  const limited = runningGame({ scoreLimit: 3 })
  annKills(limited.game, limited.ids, ['bob', 'cy'])
  assert.equal(runUntilResult(limited.game), undefined)
  assert.equal(limited.game.status, 'running')

  const unlimited = runningGame()
  annKills(unlimited.game, unlimited.ids, ['bob', 'cy'])
  assert.equal(runUntilResult(unlimited.game), undefined)
  assert.equal(unlimited.game.status, 'running')
})

test('the leader can end the game early, and the team that is ahead is the winner', () => {
  const { game, ids } = runningGame({ scoreLimit: 10 })
  annKills(game, ids, ['bob'])
  for (let tick = 0; tick < 80; tick += 1) assert.equal(game.advanceTick(), undefined)

  const result = game.end()
  assert.ok(result)
  assert.deepEqual([result.reason, result.winner, result.scoreLimit], ['ended', 1, 10])
  assert.deepEqual(result.teams, [{ team: 1, score: 1 }, { team: 2, score: 0 }])
  assert.equal(game.status, 'finished')
})

test('a game ended with no team ahead has no winner', () => {
  const { game } = runningGame({ scoreLimit: 10 })
  for (let tick = 0; tick < 30; tick += 1) game.advanceTick()
  const result = game.end()
  assert.ok(result)
  assert.deepEqual([result.reason, result.winner], ['ended', undefined])
  assert.deepEqual(result.teams, [{ team: 1, score: 0 }, { team: 2, score: 0 }])
})

test('players going back to the lobby leave the game, and what they did is kept for its results', () => {
  const { game, ids } = runningGame({ scoreLimit: 10 })
  annKills(game, ids, ['bob'])
  for (let tick = 0; tick < 80; tick += 1) game.advanceTick()
  assert.deepEqual(game.playingPlayerIds.sort(), ['ann', 'bob', 'cy'])

  assert.equal(game.leaveGame('ann'), true)
  assert.deepEqual(game.playingPlayerIds.sort(), ['bob', 'cy'])
  assert.equal(game.simulator.characters.has(ids.ann), false, 'the champion is gone from the game')
  assert.equal(game.leaveGame('ann'), false, 'and a player who is not in it cannot leave it')
  assert.equal(game.leaveGame('stranger'), false)
  assert.equal(game.closeIfEmpty(), false, 'the others are still playing')
  assert.equal(game.status, 'running')

  // Ann's kill is still her team's, and she is on the results as having left.
  for (let tick = 0; tick < 30; tick += 1) game.advanceTick()
  const result = game.end()
  assert.deepEqual(result?.teams, [{ team: 1, score: 1 }, { team: 2, score: 0 }])
  assert.deepEqual(result?.players[0], { name: 'Ann', team: 1, kills: 1, left: true })
  assert.equal(result?.winner, 1)
})

test('a game shuts down when the last player has left it, and another can be started', () => {
  const { game } = runningGame({ scoreLimit: 10 })
  for (const id of ['ann', 'bob']) {
    assert.equal(game.leaveGame(id), true)
    assert.equal(game.closeIfEmpty(), false)
  }
  assert.equal(game.leaveGame('cy'), true)
  assert.equal(game.closeIfEmpty(), true)
  assert.equal(game.status, 'idle')
  assert.equal(game.simulator.characters.size, 0)
  assert.deepEqual(game.playingPlayerIds, [])

  assert.equal(game.beginSelection(players, undefined, 'deathmatch', { scoreLimit: 4 }), true, 'a new game can start')
  assert.equal(game.result, undefined, 'and the last one\'s results are not carried into it')
})

test('a game that is over shuts down when everyone has gone back to the lobby, not before', () => {
  const { game, ids } = runningGame({ scoreLimit: 1 })
  annKills(game, ids, ['bob'])
  assert.ok(runUntilResult(game))
  assert.equal(game.status, 'finished')

  game.leaveGame('ann')
  game.leaveGame('bob')
  assert.equal(game.closeIfEmpty(), false)
  assert.equal(game.status, 'finished', 'one is still looking at the results')
  assert.deepEqual(game.result?.players.map((player) => player.name).sort(), ['Ann', 'Bob', 'Cy'], 'and they do not change as players go')
  game.leaveGame('cy')
  assert.equal(game.closeIfEmpty(), true)
  assert.equal(game.status, 'idle')
})

test('the leader ending a game that is already over shuts it down for whoever is still in it', () => {
  const { game, ids } = runningGame({ scoreLimit: 1 })
  annKills(game, ids, ['bob'])
  assert.ok(runUntilResult(game))
  assert.equal(game.end(), undefined)
  assert.equal(game.status, 'idle')
  assert.deepEqual(game.playingPlayerIds, [])
})

test('a game the leader ended is shut down at once, keeping how it ended, so another can be started', () => {
  const { game, ids } = runningGame({ scoreLimit: 10 })
  annKills(game, ids, ['bob'])
  for (let tick = 0; tick < 80; tick += 1) game.advanceTick()

  const result = game.end()
  assert.ok(result)
  game.close()
  assert.equal(game.status, 'idle', 'no one is left looking at results, so the lobby is free at once')
  assert.deepEqual(game.playingPlayerIds, [])
  assert.deepEqual(game.result, result, 'and how it ended is still there for the lobby to show')

  assert.equal(game.beginSelection(players, undefined, 'deathmatch', { scoreLimit: 4 }), true, 'another can start')
  assert.equal(game.result, undefined)
})

test('only a game that has begun can be left, ended or shut down, and ending one that is not running does nothing', () => {
  const game = new ServerGameState(testSpawns)
  assert.equal(game.leaveGame('ann'), false)
  assert.equal(game.end(), undefined)
  assert.equal(game.closeIfEmpty(), false)
  game.beginSelection(players)
  assert.equal(game.closeIfEmpty(), false, 'champion select has no characters yet, and is not a game with no one in it')
  assert.equal(game.status, 'selecting')
  assert.equal(game.end(), undefined)
  assert.equal(game.status, 'selecting')
})
