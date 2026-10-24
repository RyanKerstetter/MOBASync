import assert from 'node:assert/strict'
import test from 'node:test'
import { lobbySummary, resultHeadline, scoreLine } from '../apps/client/src/ui/results.ts'
import { GameResultSchema, type GameResult } from '../packages/shared/src/index.ts'

// What a game that is over says for itself: the headline each player is shown, and the line in the lobby.

const won: GameResult = {
  mode: 'ctf',
  reason: 'limit',
  winner: 2,
  scoreLimit: 3,
  teams: [{ team: 2, score: 3 }, { team: 1, score: 1 }],
  players: [{ name: 'Bo', team: 2, kills: 4 }, { name: 'Ann', team: 1, kills: 2, left: true }],
}
const ended: GameResult = { ...won, reason: 'ended', winner: 1, teams: [{ team: 1, score: 2 }, { team: 2, score: 1 }] }
const tied: GameResult = { ...ended, winner: undefined, teams: [{ team: 1, score: 0 }, { team: 2, score: 0 }] }

test('the winners are told they won and the losers that they lost, and the others who won', () => {
  assert.deepEqual(resultHeadline(won, 2), { title: 'Victory', subtitle: 'Blue wins, first to 3 captures', tone: 'win' })
  assert.deepEqual(resultHeadline(won, 1), { title: 'Defeat', subtitle: 'Blue wins, first to 3 captures', tone: 'loss' })
  assert.deepEqual(resultHeadline(won, undefined), { title: 'Blue wins', subtitle: 'Blue wins, first to 3 captures', tone: 'neutral' })
  assert.equal(resultHeadline({ ...won, mode: 'deathmatch', scoreLimit: 25 }, 2).subtitle, 'Blue wins, first to 25 kills')
  assert.equal(resultHeadline({ ...won, scoreLimit: undefined }, 2).subtitle, 'Blue wins')
})

test('a game the leader ended says so, and which team was ahead if one was', () => {
  assert.deepEqual(resultHeadline(ended, 1), { title: 'Game ended', subtitle: 'The leader ended the game. Red was ahead.', tone: 'neutral' })
  assert.equal(resultHeadline(tied, 1).subtitle, 'The leader ended the game. No team was ahead.')
})

test('the teams\' scores read in the order the result has them, and the lobby has a line for the last game', () => {
  assert.equal(scoreLine(won), 'Blue 3 · Red 1')
  assert.equal(lobbySummary(won), 'Last game: Capture the Flag, Blue won (Blue 3 · Red 1)')
  assert.equal(lobbySummary(ended), 'Last game: Capture the Flag, ended early, Red ahead (Red 2 · Blue 1)')
  assert.equal(lobbySummary(tied), 'Last game: Capture the Flag, ended early (Red 0 · Blue 0)')
})

test('the result is what the schema the pages read it with accepts, and it refuses one that is not', () => {
  assert.deepEqual(GameResultSchema.parse(JSON.parse(JSON.stringify(won))), won)
  assert.equal(GameResultSchema.safeParse({ ...won, mode: 'chess' }).success, false)
  assert.equal(GameResultSchema.safeParse({ ...won, reason: 'quit' }).success, false)
  assert.equal(GameResultSchema.safeParse({ ...won, teams: [{ team: 0, score: 1 }] }).success, false)
  assert.equal(GameResultSchema.safeParse({ ...tied, winner: undefined }).success, true, 'no winner is a result too')
})
