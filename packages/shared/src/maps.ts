import { GAME_MAX_PLAYERS } from './constants.js'
import type { GameMode } from './index.js'
import type { MapLayout } from './map-layout.js'
import { GAME_MODES, modeSupportProblem, teamCountProblem } from './modes.js'
import { rankTeams, spawnPointsNeeded } from './spawns.js'
import { getTeam } from './teams.js'

// What a lobby needs to know of a map to offer it: what it is called, how big it is, and what it can be played
// for. It is made by the server from the map file (`summarizeMap`) and sent with the lobby, and the lobby and
// the server work out from it, with the same code, whether the lobby's mode and teams can be played on it.
export type MapSummary = {
  // The name of the file in res/maps, without its extension. It is what a lobby picks the map by.
  id: string
  name: string
  description?: string
  // The size of the ground in world units.
  width: number
  height: number
  // How many players each slot of start places holds: the biggest team starts at the first slot, the next
  // biggest at the second, and so on, so this is what is the most each team, biggest first, can have, and
  // how many teams there can be.
  spawns: number[]
  // Whether it has a hill (for king of the hill), and a flag for each of the first two teams (for capture
  // the flag).
  hill: boolean
  flags: boolean
  // How many monsters it starts with.
  monsters: number
  // Why the map cannot be played on, if it cannot (what is wrong with its file). It is listed so the leader
  // can see it is there, but cannot be picked.
  problem?: string
}

// Just what the checks below need of a map, which is less than a summary.
export type MapCapabilities = Pick<MapSummary, 'name' | 'spawns' | 'hill' | 'flags' | 'problem'>

// "Duel arena" for "duel_arena": a name for a map that does not give itself a title.
export function mapDisplayName(id: string): string {
  const spaced = id.replace(/[_-]+/g, ' ').trim()
  return spaced ? spaced.replace(/\b\w/g, (letter) => letter.toUpperCase()) : id
}

export function summarizeMap(id: string, layout: MapLayout): MapSummary {
  return {
    id,
    name: layout.title ?? mapDisplayName(id),
    ...(layout.description ? { description: layout.description } : {}),
    width: layout.terrain.width,
    height: layout.terrain.height,
    spawns: layout.spawns.map((points) => points.length),
    hill: layout.hill !== undefined,
    flags: Boolean(layout.flags[0] && layout.flags[1]),
    monsters: layout.monsters.length,
  }
}

// A map whose file has something wrong with it: all of what is wrong, as `readMapLayout` says it.
export function unplayableMap(id: string, problem: string): MapSummary {
  return { id, name: mapDisplayName(id), width: 0, height: 0, spawns: [], hill: false, flags: false, monsters: 0, problem }
}

// The modes the map can be played in, which is every mode it has what it needs for.
export function supportedModes(map: MapCapabilities): GameMode[] {
  return map.problem ? [] : GAME_MODES.filter((mode) => modeSupportProblem(mode.id, map) === undefined).map((mode) => mode.id)
}

const ORDINALS = ['1st', '2nd', '3rd']
const ordinal = (n: number): string => ORDINALS[n - 1] ?? `${n}th`
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

// Whether the teams (the team of each player) fit the map's start places, and if not, what does not. The biggest
// team starts at the map's first slot, the next biggest at the second (a tie going to the lower team number), so
// the map needs a slot for each team, and each slot must hold the team that takes it. It says all that is
// wrong, and how to put it right.
export function teamSetupProblem(teams: readonly number[], spawns: readonly number[], mapName: string): string | undefined {
  const ranked = rankTeams(teams).map((team) => ({ team, size: teams.filter((other) => other === team).length }))
  const problems: string[] = []
  if (ranked.length > spawns.length) {
    problems.push(`${mapName} has starting places for ${plural(spawns.length, 'team')}, and there ${ranked.length === 1 ? 'is' : 'are'} ${ranked.length}.`)
  }
  ranked.slice(0, spawns.length).forEach(({ team, size }, index) => {
    if (size <= spawns[index]) return
    const name = getTeam(team).name
    problems.push(index === 0
      ? `${name} is the biggest team, with ${plural(size, 'player')}, but ${mapName} only has room for ${spawns[index]} on the biggest team.`
      : `${name}, the ${ordinal(index + 1)} biggest team, has ${plural(size, 'player')}, but ${mapName} only has room for ${spawns[index]} on its ${ordinal(index + 1)} biggest team.`)
  })
  return problems.length > 0 ? `${problems.join(' ')} Move players between teams, or pick another map.` : undefined
}

// Why a game of this mode cannot start with these teams on this map, if it cannot: the map cannot be played
// on, it has nothing for the mode, the mode needs another number of teams, or the teams do not fit its start
// places. The first of those, since the rest may not matter then.
export function startProblem(mode: GameMode, teams: readonly number[], map: MapCapabilities): string | undefined {
  if (map.problem) return `${map.name} cannot be played on: ${map.problem}`
  return modeSupportProblem(mode, map)
    ?? teamCountProblem(mode, new Set(teams).size)
    ?? teamSetupProblem(teams, map.spawns, map.name)
}

const listed = (items: readonly string[]): string =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

// A line on what team setups the map takes, for the lobby: every way eight players can split into teams of up to
// four, or how many teams and how many players on each.
export function mapRoomText(spawns: readonly number[]): string {
  if (spawns.length === 0) return 'No room for any team.'
  const takesAll = spawns.length >= GAME_MAX_PLAYERS
    && Array.from({ length: GAME_MAX_PLAYERS }, (_, index) => spawns[index] >= spawnPointsNeeded(index + 1)).every(Boolean)
  if (takesAll) return 'Any team setup.'
  const ranks = spawns.map((_, index) => (index === 0 ? 'biggest' : `${ordinal(index + 1)} biggest`))
  const players = spawns.length === 1 && spawns[0] === 1 ? 'player' : 'players'
  return `Up to ${plural(spawns.length, 'team')}, with at most ${listed(spawns.map(String))} ${players} on the ${listed(ranks)} team${spawns.length === 1 ? '' : 's'}.`
}
