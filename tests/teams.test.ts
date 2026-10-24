import assert from 'node:assert/strict'
import test from 'node:test'
import {
  balancedTeam,
  GAME_MAX_PLAYERS,
  GAME_MAX_TEAM_SIZE,
  GAME_TEAMS,
  getTeam,
  isTeamId,
  teamHasRoom,
} from '../packages/shared/src/index.ts'

test('there is a team, with a name and a colour of its own, for every player a lobby can hold', () => {
  assert.ok(GAME_TEAMS.length >= GAME_MAX_PLAYERS, 'so a lobby can be a free for all')
  assert.deepEqual(GAME_TEAMS.map((team) => team.id), GAME_TEAMS.map((_, index) => index + 1))
  assert.equal(new Set(GAME_TEAMS.map((team) => team.name)).size, GAME_TEAMS.length)
  assert.equal(new Set(GAME_TEAMS.map((team) => team.color)).size, GAME_TEAMS.length)
  for (const team of GAME_TEAMS) assert.match(team.color, /^#[0-9a-f]{6}$/, `${team.name} has a colour to draw`)
})

test('only one of the teams can be picked', () => {
  assert.equal(isTeamId(1), true)
  assert.equal(isTeamId(GAME_TEAMS.length), true)
  for (const bad of [0, -1, GAME_TEAMS.length + 1, 1.5, NaN, '1', null, undefined, {}]) {
    assert.equal(isTeamId(bad), false, `${String(bad)} is not a team`)
  }
})

test('a team\'s colour is found by its number, and a number past the last still has one', () => {
  assert.equal(getTeam(1).name, 'Red')
  assert.equal(getTeam(2).color, GAME_TEAMS[1].color)
  // The team after the last a player can be on is the monsters', and the numbers past that wrap round.
  assert.equal(getTeam(GAME_TEAMS.length + 1).name, 'Monsters')
  assert.notEqual(getTeam(GAME_TEAMS.length + 1).color, getTeam(1).color, 'in a colour no player has')
  assert.equal(getTeam(GAME_TEAMS.length + 2).color, getTeam(2).color, 'it wraps round')
  assert.equal(getTeam(0).color, getTeam(GAME_TEAMS.length).color)
})

test('a new player joins the smaller of the first two teams, and the first when they are level', () => {
  assert.equal(balancedTeam([]), 1)
  assert.equal(balancedTeam([1]), 2)
  assert.equal(balancedTeam([1, 2]), 1)
  assert.equal(balancedTeam([1, 1, 2]), 2)
  assert.equal(balancedTeam([2, 2]), 1)
  // Players who picked other teams do not count toward the first two.
  assert.equal(balancedTeam([3, 4, 5]), 1)
  assert.equal(balancedTeam([1, 1, 3, 4, 5]), 2)
})

test('a team has room for a player until it holds the most a team can', () => {
  assert.equal(GAME_MAX_TEAM_SIZE, 4)
  assert.equal(teamHasRoom([], 1), true)
  assert.equal(teamHasRoom([1, 1, 1], 1), true, 'three others leave room for a fourth')
  assert.equal(teamHasRoom([1, 1, 1, 1], 1), false, 'four others leave none')
  assert.equal(teamHasRoom([1, 1, 1, 1], 2), true, 'but another team is empty')
  assert.equal(teamHasRoom([2, 2, 2, 2, 1, 1, 1], 1), true, 'only the team in question counts')
})
