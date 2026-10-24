import { GAME_MAX_PLAYERS, GAME_MAX_TEAM_SIZE } from './constants.js'
import type { Vector2 } from './index.js'

// Where a map starts its teams. The map has numbered slots of spawn points, and a slot's points are in
// the order its team's players take them: `slots[0][0]` is the first point of slot 1.
export type SpawnSlots = readonly (readonly Vector2[])[]

// How many spawn points slot 1, 2, 3 ... needs, counting from 1. The biggest team in a game takes
// slot 1, the next biggest slot 2, and so on, so slot k is the kth biggest team. The k biggest teams
// are each at least as big as the kth, so that one has at most GAME_MAX_PLAYERS / k players, and no
// team is bigger than GAME_MAX_TEAM_SIZE. With eight players and teams of up to four that is 4, 4, 2,
// 2, 1, 1, 1, 1: enough for every way eight players can split into teams, and no more than that.
export function spawnPointsNeeded(slot: number): number {
  return Math.min(GAME_MAX_TEAM_SIZE, Math.floor(GAME_MAX_PLAYERS / slot))
}

// The teams in a game in the order they take the map's slots: the biggest team first, the next biggest
// second, and so on, with a tie going to the team with the lower number. Slot k of the map's spawn points
// is where the kth team starts, and it is also whose base the map's kth flag is (see `createModeSetup`).
export function rankTeams(teams: readonly number[]): number[] {
  const sizes = new Map<number, number>()
  for (const team of teams) sizes.set(team, (sizes.get(team) ?? 0) + 1)
  return [...sizes]
    .sort(([leftTeam, left], [rightTeam, right]) => right - left || leftTeam - rightTeam)
    .map(([team]) => team)
}

// Where each player starts, in the order given, for players on these teams. The biggest team takes the
// first slot, the next biggest the second, and so on, with a tie going to the team with the lower
// number. A team's players take their slot's points in the order the players are given. So where a
// team starts depends on how many players each team has, and not on the order of players across teams.
//
// It says what is wrong when a map has too few points for the teams: a lobby never allows more than
// GAME_MAX_TEAM_SIZE on a team, and the map is checked to have enough points for that.
export function assignSpawns(teams: readonly number[], slots: SpawnSlots): Vector2[] {
  const members = new Map<number, number[]>()
  teams.forEach((team, player) => members.set(team, [...(members.get(team) ?? []), player]))

  const positions: Vector2[] = new Array(teams.length)
  rankTeams(teams).forEach((team, slot) => {
    const players = members.get(team) as number[]
    players.forEach((player, place) => {
      const point = slots[slot]?.[place]
      if (!point) {
        throw new RangeError(
          `The map has no spawn point ${place + 1} in slot ${slot + 1}, which team ${team}, with ${players.length} players, needs.`,
        )
      }
      positions[player] = { ...point }
    })
  })
  return positions
}
