import {
  GAME_MAX_PLAYERS,
  GAME_MAX_TEAM_SIZE,
  spawnPointsNeeded,
  type SpawnSlots,
} from '../packages/shared/src/index.ts'

// A map's spawn points for tests, so they do not depend on the art of the real map: just enough points
// in every slot (see `spawnPointsNeeded`), each slot a column of its own, the first on the west. Eight columns
// fit across the plain arena, so the slots after the eighth start a second row of columns below the first.
const COLUMNS = 8
const ROW_SPACING = 800
export const testSpawns: SpawnSlots = Array.from({ length: GAME_MAX_PLAYERS }, (_, slot) =>
  Array.from({ length: spawnPointsNeeded(slot + 1) }, (_, place) => ({
    x: 250 + (slot % COLUMNS) * 250,
    y: 300 + Math.floor(slot / COLUMNS) * ROW_SPACING + place * 150,
  })))

// Every way that from one to GAME_MAX_PLAYERS players can split into teams of at most GAME_MAX_TEAM_SIZE,
// as the sizes of the teams, the biggest first: 4+4, 4+3+1, 2+2+2+2, 1+1+1+1+1+1+1+1 and so on.
export function teamSizeArrangements(): number[][] {
  const found: number[][] = []
  const split = (remaining: number, most: number, sizes: number[]): void => {
    if (remaining === 0) {
      found.push(sizes)
      return
    }
    for (let size = Math.min(most, remaining); size >= 1; size -= 1) split(remaining - size, size, [...sizes, size])
  }
  for (let players = 1; players <= GAME_MAX_PLAYERS; players += 1) split(players, GAME_MAX_TEAM_SIZE, [])
  return found
}

// The team of each player for these team sizes, listed team by team: [2, 1] is teams 1, 1, 2.
export function teamsOf(sizes: readonly number[]): number[] {
  return sizes.flatMap((size, index) => Array<number>(size).fill(index + 1))
}
