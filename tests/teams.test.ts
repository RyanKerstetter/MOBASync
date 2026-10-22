import assert from 'node:assert/strict'
import test from 'node:test'
import {
  balancedTeam,
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_MAX_PLAYERS,
  GAME_SPAWN_RADIUS,
  GAME_SPAWN_TEAMMATE_SPACING,
  GAME_TEAMS,
  getTeam,
  isTeamId,
  teamSpawnPositions,
} from '../packages/shared/src/index.ts'

const MIDDLE = { x: GAME_ARENA_WIDTH / 2, y: GAME_ARENA_HEIGHT / 2 }
const apart = (left: { x: number; y: number }, right: { x: number; y: number }): number =>
  Math.hypot(left.x - right.x, left.y - right.y)

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
  assert.equal(getTeam(GAME_TEAMS.length + 1).color, getTeam(1).color, 'it wraps round')
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

test('a lone team starts at the west of the circle round the middle, and no one at all starts nowhere', () => {
  assert.deepEqual(teamSpawnPositions([]), [])
  const [only] = teamSpawnPositions([1])
  assert.deepEqual(only, { x: MIDDLE.x - GAME_SPAWN_RADIUS, y: MIDDLE.y })
})

test('a team\'s players stand side by side round its slot, in the order given, and every position is a whole number', () => {
  const [first, second, third] = teamSpawnPositions([1, 1, 1])
  // Going round clockwise, which on the west side is up the page: first, then second, then third,
  // each the teammate spacing from the last, with the middle one right at the slot.
  assert.ok(first.y > second.y && second.y > third.y)
  assert.deepEqual(second, { x: MIDDLE.x - GAME_SPAWN_RADIUS, y: MIDDLE.y })
  assert.ok(Math.abs(apart(first, second) - GAME_SPAWN_TEAMMATE_SPACING) < 1)
  assert.ok(Math.abs(apart(second, third) - GAME_SPAWN_TEAMMATE_SPACING) < 1)
  for (const position of teamSpawnPositions([1, 2, 2, 3, 3, 3])) {
    assert.ok(Number.isInteger(position.x) && Number.isInteger(position.y))
  }
})

test('a team goes where its number puts it, whoever else is listed or in what order', () => {
  const [red, blue] = teamSpawnPositions([1, 2])
  const [blueFirst, redSecond] = teamSpawnPositions([2, 1])
  assert.deepEqual(redSecond, red)
  assert.deepEqual(blueFirst, blue)
  // Teams that are not next to each other in number still split the circle between those present.
  const [one, nine] = teamSpawnPositions([1, 8])
  assert.ok(apart(one, nine) > GAME_SPAWN_RADIUS * 1.9, 'two teams are opposite, whatever their numbers')
})

test('every position is on the circle, and teams that share it never overlap', () => {
  for (const teams of [[1], [1, 2], [1, 1, 2, 2], [1, 1, 1, 1, 1, 1, 1, 2], [1, 2, 3, 4, 5, 6, 7, 8]]) {
    const positions = teamSpawnPositions(teams)
    positions.forEach((position, index) => {
      assert.ok(Math.abs(apart(position, MIDDLE) - GAME_SPAWN_RADIUS) < 1, `${teams.join('')}: on the circle`)
      positions.slice(index + 1).forEach((other) => {
        assert.ok(apart(position, other) > 50, `${teams.join('')}: ${position.x},${position.y} is clear of the rest`)
      })
    })
  }
})
