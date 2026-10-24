import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assignSpawns,
  GAME_MAX_PLAYERS,
  GAME_MAX_TEAM_SIZE,
  spawnPointsNeeded,
} from '../packages/shared/src/index.ts'
import { teamSizeArrangements, teamsOf, testSpawns } from './test-spawns.ts'

test('the slots of spawn points need 4, 4, 2, 2, 1, 1, 1, 1 for eight players in teams of up to four', () => {
  assert.equal(GAME_MAX_PLAYERS, 8)
  assert.equal(GAME_MAX_TEAM_SIZE, 4)
  assert.deepEqual(Array.from({ length: 8 }, (_, slot) => spawnPointsNeeded(slot + 1)), [4, 4, 2, 2, 1, 1, 1, 1])
})

test('those are enough for every way the players can split into teams, and none could be one fewer', () => {
  const widest = new Array<number>(GAME_MAX_PLAYERS).fill(0)
  for (const sizes of teamSizeArrangements()) {
    // `sizes` is biggest first, so the team in slot k is sizes[k - 1].
    sizes.forEach((size, index) => {
      assert.ok(size <= spawnPointsNeeded(index + 1), `${sizes.join('+')}: slot ${index + 1} holds ${size}`)
      widest[index] = Math.max(widest[index], size)
    })
  }
  assert.deepEqual(widest, widest.map((_, index) => spawnPointsNeeded(index + 1)), 'each slot is the most any game needs of it')
})

test('every way the players can split into teams gets a spot each, whatever the teams are numbered and in whatever order', () => {
  for (const sizes of teamSizeArrangements()) {
    const teams = teamsOf(sizes)
    const renumbered = teams.map((team) => GAME_MAX_PLAYERS + 1 - team)
    const reversed = [...teams].reverse()
    for (const roster of [teams, renumbered, reversed]) {
      const spots = assignSpawns(roster, testSpawns)
      assert.equal(spots.length, roster.length)
      assert.equal(new Set(spots.map(({ x, y }) => `${x},${y}`)).size, roster.length, `${sizes.join('+')}: nobody shares a spot`)
    }
  }
})

test('the biggest team takes the first slot, the next biggest the second, and a tie goes to the lower team number', () => {
  // Team 3 has three players, team 1 two and team 2 one.
  const spots = assignSpawns([1, 3, 2, 3, 1, 3], testSpawns)
  assert.deepEqual([spots[1], spots[3], spots[5]], testSpawns[0].slice(0, 3))
  assert.deepEqual([spots[0], spots[4]], testSpawns[1].slice(0, 2))
  assert.deepEqual(spots[2], testSpawns[2][0])

  // Teams 5 and 2 are both a single player, so team 2 comes first.
  assert.deepEqual(assignSpawns([5, 2], testSpawns), [testSpawns[1][0], testSpawns[0][0]])
})

test('a team\'s players take its slot\'s points in the order they are listed, and where others are listed does not matter', () => {
  const together = assignSpawns([1, 1, 1, 2, 2], testSpawns)
  assert.deepEqual(together.slice(0, 3), testSpawns[0].slice(0, 3))
  assert.deepEqual(together.slice(3), testSpawns[1].slice(0, 2))
  const mixed = assignSpawns([2, 1, 1, 2, 1], testSpawns)
  assert.deepEqual([mixed[1], mixed[2], mixed[4]], testSpawns[0].slice(0, 3))
  assert.deepEqual([mixed[0], mixed[3]], testSpawns[1].slice(0, 2))
})

test('nobody is started at nowhere, and the spots given back are copies', () => {
  assert.deepEqual(assignSpawns([], testSpawns), [])
  const [spot] = assignSpawns([1], testSpawns)
  spot.x = -1
  assert.notEqual(testSpawns[0][0].x, -1)
})

test('a map with too few points says which player of which team it could not place', () => {
  assert.throws(() => assignSpawns([1, 1, 1], [[{ x: 1, y: 1 }, { x: 2, y: 2 }]]), /no spawn point 3 in slot 1.*team 1, with 3 players/)
  assert.throws(() => assignSpawns([1, 2], [[{ x: 1, y: 1 }]]), /no spawn point 1 in slot 2/)
})
