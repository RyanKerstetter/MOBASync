import {
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_SPAWN_RADIUS,
  GAME_SPAWN_TEAMMATE_SPACING,
} from './constants.js'
import type { Vector2 } from './index.js'

export interface TeamDef {
  // Teams are numbered from 1. A character's team is this number.
  id: number
  name: string
  // How the team's players are drawn, for example '#e5535b'.
  color: string
}

// A colour for each of the most players a lobby can hold, so every player can have a team to
// themselves: a lobby where everyone picks a different team is a free for all.
export const GAME_TEAMS: readonly TeamDef[] = [
  { id: 1, name: 'Red', color: '#e5535b' },
  { id: 2, name: 'Blue', color: '#4f9cf5' },
  { id: 3, name: 'Green', color: '#4fc778' },
  { id: 4, name: 'Gold', color: '#e8b93c' },
  { id: 5, name: 'Purple', color: '#a875e8' },
  { id: 6, name: 'Orange', color: '#f28b3c' },
  { id: 7, name: 'Teal', color: '#3fc8c0' },
  { id: 8, name: 'Pink', color: '#ee7fb8' },
]

// Whether this is one of the teams a player can pick.
export function isTeamId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= GAME_TEAMS.length
}

// A team's colour and name. A number past the last team wraps round, so a game built outside the
// lobby, where a character's team can be anything, still draws.
export function getTeam(id: number): TeamDef {
  return GAME_TEAMS[(((id - 1) % GAME_TEAMS.length) + GAME_TEAMS.length) % GAME_TEAMS.length]
}

// The team a player who has not picked one joins: whichever of the first two has fewer players,
// the first on a tie. So a lobby fills up as two even teams, and anyone can pick another.
export function balancedTeam(teams: readonly number[]): number {
  const first = teams.filter((team) => team === 1).length
  const second = teams.filter((team) => team === 2).length
  return second < first ? 2 : 1
}

// Where each player starts, in the order given, for players on these teams. Each team has an equal
// slice of the circle around the middle of the map, the teams in order of their number starting from
// the west and going round clockwise, and a team's players stand side by side at the middle of
// its slice, in the order given. Nothing here depends on the order of the players across teams.
//
// The positions are whole numbers, worked out once by the server and sent to every client as the
// players' starting places, so no peer needs to agree on trigonometry.
export function teamSpawnPositions(teams: readonly number[]): Vector2[] {
  const order = [...new Set(teams)].sort((left, right) => left - right)
  const around = (2 * Math.PI) / order.length
  const step = GAME_SPAWN_TEAMMATE_SPACING / GAME_SPAWN_RADIUS
  return teams.map((team, index) => {
    const mates = teams.flatMap((other, position) => (other === team ? [position] : []))
    const slot = Math.PI + order.indexOf(team) * around
    const angle = slot + (mates.indexOf(index) - (mates.length - 1) / 2) * step
    return {
      x: Math.round(GAME_ARENA_WIDTH / 2 + Math.cos(angle) * GAME_SPAWN_RADIUS),
      y: Math.round(GAME_ARENA_HEIGHT / 2 + Math.sin(angle) * GAME_SPAWN_RADIUS),
    }
  })
}
