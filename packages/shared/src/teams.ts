import { GAME_MAX_TEAM_SIZE, GAME_MONSTER_TEAM } from './constants.js'

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

// What the monsters are drawn and named as: a team no player is on.
export const MONSTER_TEAM: TeamDef = { id: GAME_MONSTER_TEAM, name: 'Monsters', color: '#9aa5b4' }

export function isMonsterTeam(team: number): boolean {
  return team === GAME_MONSTER_TEAM
}

// A team's colour and name. A number past the last team wraps round, so a game built outside the
// lobby, where a character's team can be anything, still draws. The monsters' team is its own.
export function getTeam(id: number): TeamDef {
  if (id === GAME_MONSTER_TEAM) return MONSTER_TEAM
  return GAME_TEAMS[(((id - 1) % GAME_TEAMS.length) + GAME_TEAMS.length) % GAME_TEAMS.length]
}

// The team a player who has not picked one joins: whichever of the first two has fewer players,
// the first on a tie. So a lobby fills up as two even teams, and anyone can pick another.
export function balancedTeam(teams: readonly number[]): number {
  const first = teams.filter((team) => team === 1).length
  const second = teams.filter((team) => team === 2).length
  return second < first ? 2 : 1
}

// Whether a player can join this team, given the teams everyone else is on: a team holds at most
// GAME_MAX_TEAM_SIZE players.
export function teamHasRoom(otherPlayersTeams: readonly number[], team: number): boolean {
  return otherPlayersTeams.filter((other) => other === team).length < GAME_MAX_TEAM_SIZE
}
