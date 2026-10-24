import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mapDisplayName,
  mapRoomText,
  modeSupportProblem,
  spawnPointsNeeded,
  startProblem,
  summarizeMap,
  supportedModes,
  teamSetupProblem,
  unplayableMap,
  type MapCapabilities,
  type MapLayout,
} from '../packages/shared/src/index.ts'
import { Terrain } from '../packages/shared/src/index.ts'

// What a lobby can tell about a map, and whether the teams in it fit: not every map takes every team setup, so
// a lobby is told what is wrong, in words, before the game can start.

// Two teams of three and one of two: Red 3, Blue 3, Green 2.
const THREE_THREE_TWO = [1, 1, 1, 2, 2, 2, 3, 3]

const arenaMap = (spawns: number[], extra: Partial<MapCapabilities> = {}): MapCapabilities =>
  ({ name: 'The Pit', spawns, hill: true, flags: true, ...extra })

test('a map names itself, or is named after its file', () => {
  assert.equal(mapDisplayName('ffa_arena'), 'Ffa Arena')
  assert.equal(mapDisplayName('duel-1v1'), 'Duel 1v1')
  assert.equal(mapDisplayName('__'), '__')
})

test('a map is summed up for the lobby: its size, what it holds, and what it has for the modes', () => {
  const layout = {
    title: 'The Pit',
    description: 'A tight fight.',
    terrain: new Terrain({ width: 1800, height: 900 }),
    spawns: [[{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], [{ x: 4, y: 4 }, { x: 5, y: 5 }], [{ x: 6, y: 6 }]],
    hill: { x: 0, y: 0, width: 10, height: 10, ellipse: true },
    flags: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
    monsters: [{ monster: 'wolf', at: { x: 5, y: 5 } }, { monster: 'wolf', at: { x: 9, y: 9 } }],
  } as unknown as MapLayout
  assert.deepEqual(summarizeMap('pit', layout), {
    id: 'pit',
    name: 'The Pit',
    description: 'A tight fight.',
    width: 1800,
    height: 900,
    spawns: [3, 2, 1],
    hill: true,
    flags: true,
    monsters: 2,
  })
  // Without a title it is named for its file, and a map with one flag has no flags for capture the flag.
  const bare = summarizeMap('duel_arena', { ...layout, title: undefined, description: undefined, hill: undefined, flags: [{ x: 1, y: 1 }] } as unknown as MapLayout)
  assert.deepEqual([bare.name, bare.description, bare.hill, bare.flags], ['Duel Arena', undefined, false, false])
  assert.deepEqual(unplayableMap('broken', 'It has no arena.'), {
    id: 'broken', name: 'Broken', width: 0, height: 0, spawns: [], hill: false, flags: false, monsters: 0, problem: 'It has no arena.',
  })
})

test('a mode is on a map only if the map has what it needs, and a map that cannot be played on has none', () => {
  assert.deepEqual(supportedModes(arenaMap([4, 4])), ['deathmatch', 'koth', 'ctf'])
  assert.deepEqual(supportedModes(arenaMap([4, 4], { hill: false })), ['deathmatch', 'ctf'])
  assert.deepEqual(supportedModes(arenaMap([4, 4], { flags: false })), ['deathmatch', 'koth'])
  assert.deepEqual(supportedModes(arenaMap([4, 4], { hill: false, flags: false })), ['deathmatch'])
  assert.deepEqual(supportedModes(arenaMap([4, 4], { problem: 'broken' })), [])
  assert.equal(modeSupportProblem('koth', arenaMap([4], { hill: false })), 'The Pit has no hill, so King of the Hill cannot be played on it.')
  assert.equal(
    modeSupportProblem('ctf', arenaMap([4], { flags: false })),
    'The Pit has no flag for each of the first two teams, so Capture the Flag cannot be played on it.',
  )
  assert.equal(modeSupportProblem('deathmatch', arenaMap([4], { hill: false, flags: false })), undefined)
  assert.match(modeSupportProblem('koth', { hill: false, flags: false }) ?? '', /^This map has no hill/, 'and an unnamed map is this map')
})

test('teams that fit a map are fine, however they are split', () => {
  assert.equal(teamSetupProblem(THREE_THREE_TWO, [4, 4, 2], 'The Pit'), undefined, 'two of three and one of two on a map that holds 4, 4 and 2')
  assert.equal(teamSetupProblem(THREE_THREE_TWO, [3, 3, 2], 'The Pit'), undefined, 'exactly')
  assert.equal(teamSetupProblem([1, 2], [1, 1], 'Duel'), undefined, 'a duel')
  assert.equal(teamSetupProblem([], [4], 'The Pit'), undefined, 'no players')
  // The biggest team takes the first slot whatever its colour is, so what is on which slot is by size.
  assert.equal(teamSetupProblem([5, 2, 2, 2, 5, 5, 5], [4, 3], 'The Pit'), undefined)
  assert.match(teamSetupProblem([5, 2, 2, 2, 5, 5, 5], [3, 4], 'The Pit') ?? '', /Purple is the biggest team, with 4 players/)
})

test('too many teams for a map is said, with how many it has places for', () => {
  const problem = teamSetupProblem(THREE_THREE_TWO, [4, 4], 'Duel Arena')
  assert.match(problem ?? '', /^Duel Arena has starting places for 2 teams, and there are 3\./)
  assert.match(problem ?? '', /Move players between teams, or pick another map\.$/)
  assert.match(teamSetupProblem([1, 2], [4], 'Solo') ?? '', /^Solo has starting places for 1 team, and there are 2\./)
})

test('a team too big for the place its size gives it is said, by team and by rank', () => {
  // Red and Blue have three each, and Green two, on a map that only has room for 3, 2 and 1 players on its teams.
  const problem = teamSetupProblem(THREE_THREE_TWO, [3, 2, 1], 'The Pit')
  assert.match(problem ?? '', /Blue, the 2nd biggest team, has 3 players, but The Pit only has room for 2 on its 2nd biggest team\./)
  assert.match(problem ?? '', /Green, the 3rd biggest team, has 2 players, but The Pit only has room for 1 on its 3rd biggest team\./)
  assert.doesNotMatch(problem ?? '', /Red/, 'the first team fits')

  const biggest = teamSetupProblem([1, 1, 1, 1, 2], [3, 3], 'The Pit')
  assert.match(biggest ?? '', /^Red is the biggest team, with 4 players, but The Pit only has room for 3 on the biggest team\./)
  assert.match(teamSetupProblem([1, 1, 2], [1, 1], 'The Pit') ?? '', /Red is the biggest team, with 2 players, but The Pit only has room for 1/)
})

test('a lone player and a lone team are said in the singular', () => {
  assert.match(teamSetupProblem([1, 2, 3], [1, 1], 'Duel') ?? '', /and there are 3\./)
  assert.match(teamSetupProblem([1, 1], [1], 'Duel') ?? '', /with 2 players, but Duel only has room for 1 on the biggest team/)
})

test('starting a game checks the map, then the mode, then the number of teams, then how they are split', () => {
  const full = arenaMap([4, 4, 2, 2, 1, 1, 1, 1])
  assert.equal(startProblem('deathmatch', THREE_THREE_TWO, full), undefined)
  assert.equal(startProblem('koth', THREE_THREE_TWO, full), undefined)

  assert.match(startProblem('deathmatch', [1, 2], arenaMap([4, 4], { problem: 'It has no arena.' })) ?? '', /^The Pit cannot be played on: It has no arena\./)
  assert.match(startProblem('koth', [1, 2], arenaMap([4, 4], { hill: false })) ?? '', /no hill/)
  assert.match(startProblem('ctf', THREE_THREE_TWO, full) ?? '', /Capture the Flag needs exactly 2 teams, and there are 3/)
  assert.match(startProblem('deathmatch', THREE_THREE_TWO, arenaMap([4, 4])) ?? '', /starting places for 2 teams/)
  // Capture the flag with two teams that do not fit says so too.
  assert.match(startProblem('ctf', [1, 1, 1, 1, 2], arenaMap([3, 3])) ?? '', /Red is the biggest team, with 4 players/)
  assert.equal(startProblem('ctf', [1, 1, 1, 2, 2, 2], arenaMap([3, 3])), undefined)
  // What the mode needs is told before the teams are, since changing the map may be all that is needed.
  assert.match(startProblem('koth', THREE_THREE_TWO, arenaMap([4, 4], { hill: false })) ?? '', /no hill/)
})

test('the room a map has is described: any team setup, or how many teams and how big', () => {
  assert.equal(mapRoomText([4, 4, 2, 2, 1, 1, 1, 1]), 'Any team setup.')
  assert.equal(mapRoomText([5, 5, 3, 2, 2, 1, 1, 1, 1]), 'Any team setup.', 'more than it needs')
  assert.equal(mapRoomText([4, 4]), 'Up to 2 teams, with at most 4 and 4 players on the biggest and 2nd biggest teams.')
  assert.equal(mapRoomText([3, 3, 2]), 'Up to 3 teams, with at most 3, 3 and 2 players on the biggest, 2nd biggest and 3rd biggest teams.')
  assert.equal(mapRoomText([1]), 'Up to 1 team, with at most 1 player on the biggest team.')
  assert.equal(mapRoomText([4, 4, 2, 2, 1, 1, 1]), 'Up to 7 teams, with at most 4, 4, 2, 2, 1, 1 and 1 players on the biggest, 2nd biggest, 3rd biggest, 4th biggest, 5th biggest, 6th biggest and 7th biggest teams.')
  assert.equal(mapRoomText([]), 'No room for any team.')
  assert.ok(spawnPointsNeeded(1) > 0)
})
