import assert from 'node:assert/strict'
import test from 'node:test'
import { groupPlayersByTeam } from '../apps/client/src/champion-select.ts'

const names = (groups: ReturnType<typeof groupPlayersByTeam>): Array<[number | undefined, string[]]> =>
  groups.map((group) => [group.team, group.players.map((player) => player.name)])

test('players are grouped by team, in team order, however they joined', () => {
  const groups = groupPlayersByTeam([
    { id: 'a', name: 'Ann', team: 2 },
    { id: 'b', name: 'Bo', team: 1 },
    { id: 'c', name: 'Cy', team: 2 },
    { id: 'd', name: 'Di', team: 1 },
  ])

  assert.deepEqual(names(groups), [[1, ['Bo', 'Di']], [2, ['Ann', 'Cy']]])
})

test('a team with one player is a group of one, and the join order is kept inside a team', () => {
  const groups = groupPlayersByTeam([
    { id: 'a', name: 'Ann', team: 3 },
    { id: 'b', name: 'Bo', team: 1 },
    { id: 'c', name: 'Cy', team: 3 },
  ])

  assert.deepEqual(names(groups), [[1, ['Bo']], [3, ['Ann', 'Cy']]])
})

test('a player with no team is listed last, on their own', () => {
  const groups = groupPlayersByTeam([
    { id: 'a', name: 'Ann' },
    { id: 'b', name: 'Bo', team: 2 },
  ])

  assert.deepEqual(names(groups), [[2, ['Bo']], [undefined, ['Ann']]])
})

test('no players make no groups', () => {
  assert.deepEqual(groupPlayersByTeam([]), [])
})
