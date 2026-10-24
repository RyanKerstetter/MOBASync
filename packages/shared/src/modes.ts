import {
  GAME_FLAG_RADIUS,
  GAME_HILL_CAPTURE_TICKS,
  GAME_HILL_POINT_TICKS,
  GAME_RESPAWN_TICKS,
  GAME_TPS,
} from './constants.js'
import { rankTeams } from './spawns.js'
import type { GameMode, HillArea, ModeSetup, ObjectiveState, Vector2 } from './index.js'

// The ways a lobby can play, picked by its leader before the game starts.
//
// - team deathmatch: the game as it has always been. Every kill scores for the killer's team, which is
//   the sum of its players' kills, so a game of it has no state of its own.
// - king of the hill: one hill, an area of the map. The team with more players on it than every other
//   team fills the hill's bar for itself, in the time the leader sets (ten seconds, by default); a full bar
//   is the hill held, and a held hill scores a point every second. When the bar is another team's and a
//   team has more players on the hill than it, even if the teams outnumbering it are level with each other,
//   the bar empties, and it is filled for a team only once that team is ahead of every other on the hill.
// - capture the flag: two teams, each with a flag at its base. Walk up to the other team's flag to pick
//   it up, and carry it to your own flag's base to score a point, as long as your flag is at home. A
//   carrier that dies drops the flag where it fell, and it stays there until a champion of the flag's
//   own team walks over it, which sends it back to its base, or an enemy picks it up again.
//
// How long a champion stays dead, and the score a team wins at, are the lobby leader's to set (`LobbyRules`).
// They are part of what the game is played for (`ModeSetup`), so every peer respawns champions on the same
// tick, and the server ends the game when a team reaches the limit (`winningTeam`).
//
// What a game of a mode needs from the map, and how the teams in the lobby fit it, is worked out when
// the game starts (see `createModeSetup`); how it plays out, tick by tick, is `advanceObjective`, which
// the simulator runs on every frame, so every peer works out the same hill and flags and a late order
// that changes who was where changes them with it.

export const GAME_MODE_IDS = ['deathmatch', 'koth', 'ctf'] as const

export const DEFAULT_GAME_MODE: GameMode = 'deathmatch'

// What a mode's score counts, which the lobby and the screen name it by.
export type ScoreName = 'kills' | 'points' | 'captures'

export interface GameModeDef {
  id: GameMode
  name: string
  // One line for the lobby, under the list of modes.
  summary: string
  scoreName: ScoreName
  // The lobby's label for the score a team wins at, its default, and the most the leader can set. A limit
  // of 0 is no limit: the game goes on until the leader ends it.
  limitLabel: string
  defaultLimit: number
  maxLimit: number
}

export const GAME_MODES: readonly GameModeDef[] = [
  {
    id: 'deathmatch',
    name: 'Team Deathmatch',
    summary: 'Every kill scores for your team.',
    scoreName: 'kills',
    limitLabel: 'Kills to win',
    defaultLimit: 25,
    maxLimit: 999,
  },
  {
    id: 'koth',
    name: 'King of the Hill',
    summary: 'Have more players on the hill than any other team to capture it. Hold it to score.',
    scoreName: 'points',
    limitLabel: 'Points to win',
    defaultLimit: 100,
    maxLimit: 999,
  },
  {
    id: 'ctf',
    name: 'Capture the Flag',
    summary: 'Bring the enemy flag to your base while your own flag is home. Needs exactly two teams.',
    scoreName: 'captures',
    limitLabel: 'Captures to win',
    defaultLimit: 3,
    maxLimit: 99,
  },
]

export function isGameMode(value: unknown): value is GameMode {
  return GAME_MODES.some((mode) => mode.id === value)
}

export function getGameMode(id: GameMode): GameModeDef {
  return GAME_MODES.find((mode) => mode.id === id) ?? GAME_MODES[0]
}

// ---------------------------------------------------------------------------- the lobby's rules

// What the lobby leader sets besides the mode, while the lobby is idle: how long a champion stays dead, in
// whole seconds, and for each mode the score a team wins at (0 is no limit). A limit is kept for every mode, so
// switching from one to another and back remembers what was set for each.
export type LobbyRules = {
  respawnSeconds: number
  // Only king of the hill has a use for it.
  captureSeconds: number
  scoreLimits: Record<GameMode, number>
}

export const RESPAWN_SECONDS = { min: 1, max: 60, default: GAME_RESPAWN_TICKS / GAME_TPS }
// How long a team with more players on the hill than any other takes to fill its bar, for king of the hill.
export const CAPTURE_SECONDS = { min: 1, max: 120, default: GAME_HILL_CAPTURE_TICKS / GAME_TPS }

export function defaultRules(): LobbyRules {
  return {
    respawnSeconds: RESPAWN_SECONDS.default,
    captureSeconds: CAPTURE_SECONDS.default,
    scoreLimits: Object.fromEntries(GAME_MODES.map((mode) => [mode.id, mode.defaultLimit])) as Record<GameMode, number>,
  }
}

// A change the leader asks for: any of the rules, the limits of any of the modes.
export type RulesChange = {
  respawnSeconds?: number
  captureSeconds?: number
  scoreLimits?: Partial<Record<GameMode, number>>
}

const isWhole = (value: unknown, least: number, most: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= least && value <= most

// What a request to change the rules asks for, or what is wrong with it (the first thing). Anything it
// names that is not a rule is refused, rather than ignored, so a typo does not look like it worked.
export function readRulesChange(raw: unknown): { change: RulesChange } | { problem: string } {
  const body = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const change: RulesChange = {}
  if (body.respawnSeconds !== undefined) {
    if (!isWhole(body.respawnSeconds, RESPAWN_SECONDS.min, RESPAWN_SECONDS.max)) {
      return { problem: `Respawn time must be a whole number of seconds from ${RESPAWN_SECONDS.min} to ${RESPAWN_SECONDS.max}.` }
    }
    change.respawnSeconds = body.respawnSeconds
  }
  if (body.captureSeconds !== undefined) {
    if (!isWhole(body.captureSeconds, CAPTURE_SECONDS.min, CAPTURE_SECONDS.max)) {
      return { problem: `Capture time must be a whole number of seconds from ${CAPTURE_SECONDS.min} to ${CAPTURE_SECONDS.max}.` }
    }
    change.captureSeconds = body.captureSeconds
  }
  if (body.scoreLimits !== undefined) {
    const limits = typeof body.scoreLimits === 'object' && body.scoreLimits !== null ? body.scoreLimits as Record<string, unknown> : undefined
    if (!limits) return { problem: 'The score limits must say which mode each is for.' }
    change.scoreLimits = {}
    for (const [id, value] of Object.entries(limits)) {
      if (!isGameMode(id)) return { problem: `"${id}" is not a game mode.` }
      const mode = getGameMode(id)
      if (!isWhole(value, 0, mode.maxLimit)) {
        return { problem: `${mode.limitLabel} must be a whole number from 0 (no limit) to ${mode.maxLimit}.` }
      }
      change.scoreLimits[id] = value
    }
  }
  return { change }
}

export function applyRulesChange(rules: LobbyRules, change: RulesChange): LobbyRules {
  return {
    respawnSeconds: change.respawnSeconds ?? rules.respawnSeconds,
    captureSeconds: change.captureSeconds ?? rules.captureSeconds,
    scoreLimits: { ...rules.scoreLimits, ...change.scoreLimits },
  }
}

// What the simulator is given of the rules for a game of this mode: how many ticks a champion stays dead, the
// score to win at if there is one, and for king of the hill how many ticks it takes to fill the bar.
export type ModeRules = { respawnTicks?: number; scoreLimit?: number; captureTicks?: number }

export function modeRules(rules: LobbyRules, mode: GameMode): ModeRules {
  const limit = rules.scoreLimits[mode]
  return {
    respawnTicks: rules.respawnSeconds * GAME_TPS,
    ...(limit > 0 ? { scoreLimit: limit } : {}),
    ...(mode === 'koth' ? { captureTicks: rules.captureSeconds * GAME_TPS } : {}),
  }
}

// ---------------------------------------------------------------------------- starting a game

// What a map has for the modes besides spawn points: a hill, and a base for the flag of each slot of
// spawn points (index 0 is slot 1).
export type MapObjectives = {
  hill?: HillArea
  flags: readonly (Vector2 | undefined)[]
}

export const NO_OBJECTIVES: MapObjectives = { flags: [] }

// Why a mode cannot be played by this many teams, if it cannot. The lobby asks this to say so before
// anyone presses Start, as the server does when they do.
export function teamCountProblem(mode: GameMode, teamCount: number): string | undefined {
  if (mode === 'ctf' && teamCount !== 2) {
    return `Capture the Flag needs exactly 2 teams, and there ${teamCount === 1 ? 'is 1' : `are ${teamCount}`}.`
  }
  return undefined
}

// Why a mode cannot be played on a map, if it cannot: king of the hill needs a hill, and capture the flag a
// flag for each of the first two teams. `name` is what the map is called, where it is known.
export function modeSupportProblem(
  mode: GameMode,
  map: { name?: string; hill: boolean; flags: boolean },
): string | undefined {
  const has = map.name ? `${map.name} has` : 'This map has'
  if (mode === 'koth' && !map.hill) return `${has} no hill, so King of the Hill cannot be played on it.`
  if (mode === 'ctf' && !map.flags) {
    return `${has} no flag for each of the first two teams, so Capture the Flag cannot be played on it.`
  }
  return undefined
}

// Why a game of this mode cannot start with these teams (the team of each player) on a map with these
// objects, if it cannot.
export function modeStartProblem(mode: GameMode, teams: readonly number[], map: MapObjectives): string | undefined {
  return modeSupportProblem(mode, { hill: map.hill !== undefined, flags: Boolean(map.flags[0] && map.flags[1]) })
    ?? teamCountProblem(mode, new Set(teams).size)
}

// What a game of this mode on this map is, for the teams in it. Each team's flag is at the base of the
// slot it starts at, so the biggest team has the first flag, and the next biggest the second (the same
// ranking `assignSpawns` starts them by). It throws what `modeStartProblem` would say. The rules, when given,
// are part of it: with none a game has the default respawn time and no score limit.
export function createModeSetup(
  mode: GameMode,
  teams: readonly number[],
  map: MapObjectives,
  rules: ModeRules = {},
): ModeSetup {
  const problem = modeStartProblem(mode, teams, map)
  if (problem) throw new RangeError(problem)
  const withRules = {
    ...(rules.respawnTicks !== undefined ? { respawnTicks: rules.respawnTicks } : {}),
    ...(rules.scoreLimit !== undefined ? { scoreLimit: rules.scoreLimit } : {}),
  }
  if (mode === 'koth') {
    return {
      kind: 'koth',
      hill: { ...(map.hill as HillArea) },
      ...(rules.captureTicks !== undefined ? { captureTicks: rules.captureTicks } : {}),
      ...withRules,
    }
  }
  if (mode === 'ctf') {
    return {
      kind: 'ctf',
      flags: rankTeams(teams).map((team, slot) => ({ team, home: { ...(map.flags[slot] as Vector2) } })),
      ...withRules,
    }
  }
  return { kind: 'deathmatch', ...withRules }
}

// A game of team deathmatch has none until the first kill (see `advanceObjective`), so a game with no kills is
// the same as it was before deathmatch had one.
export function initialObjective(setup: ModeSetup): ObjectiveState | undefined {
  if (setup.kind === 'koth') return { kind: 'koth', progress: 0, scores: {} }
  if (setup.kind === 'ctf') {
    return {
      kind: 'ctf',
      flags: setup.flags.map((flag) => ({ team: flag.team, position: { ...flag.home } })),
      scores: {},
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------- the tick

// Who the objective looks at on a tick: every character, where the tick left it.
export type ObjectiveUnit = {
  id: number
  team: number
  position: Vector2
  radius: number
  alive: boolean
}

export function hillContains(hill: HillArea, point: Vector2): boolean {
  if (!hill.ellipse) {
    return point.x >= hill.x && point.x <= hill.x + hill.width && point.y >= hill.y && point.y <= hill.y + hill.height
  }
  const radiusX = hill.width / 2
  const radiusY = hill.height / 2
  const dx = (point.x - (hill.x + radiusX)) / radiusX
  const dy = (point.y - (hill.y + radiusY)) / radiusY
  return dx * dx + dy * dy <= 1
}

// How many living characters of each team are on the hill (a character is on it when its middle is).
export function hillPresence(hill: HillArea, units: readonly ObjectiveUnit[]): Map<number, number> {
  const counts = new Map<number, number>()
  for (const unit of units) {
    if (unit.alive && hillContains(hill, unit.position)) counts.set(unit.team, (counts.get(unit.team) ?? 0) + 1)
  }
  return counts
}

// The team with more players on the hill than any other, or nothing if none is on it or the most are tied.
export function hillLeader(presence: ReadonlyMap<number, number>): number | undefined {
  let leader: number | undefined
  let most = 0
  let tied = false
  for (const [team, count] of [...presence].sort(([left], [right]) => left - right)) {
    if (count > most) {
      leader = team
      most = count
      tied = false
    } else if (count === most) {
      tied = true
    }
  }
  return tied ? undefined : leader
}

// How many ticks the hill's bar takes to fill in a game: what the leader set, or the default.
export function hillCaptureTicks(setup: Extract<ModeSetup, { kind: 'koth' }>): number {
  return setup.captureTicks ?? GAME_HILL_CAPTURE_TICKS
}

// The team that holds the hill: the one whose bar is full.
export function hillOwner(
  state: Extract<ObjectiveState, { kind: 'koth' }>,
  captureTicks: number = GAME_HILL_CAPTURE_TICKS,
): number | undefined {
  return state.progress >= captureTicks ? state.capturer : undefined
}

// Which way the hill's bar goes on a tick, with these teams on the hill (and the team with more than the rest,
// if there is one):
// - up, for the team with more players on it than any other, whether the bar is empty, that team's own, or
//   (already full) the team that holds the hill;
// - down, when the bar is another team's and some team has more players on the hill than it does. It does not
//   matter if the teams that outnumber the bar's team are level with each other, so that no team leads: a
//   team that has left its hill to others, or is outnumbered by a crowd of rivals, loses it, and the bar is
//   filled for a team only once that team has taken the lead;
// - nowhere, when no one is on the hill, or the bar's team has as many players on it as any other.
export type HillMovement = { direction: 'up' | 'down' | 'none'; leader?: number }

export function hillMovement(
  bar: { capturer?: number; progress: number },
  presence: ReadonlyMap<number, number>,
): HillMovement {
  const leader = hillLeader(presence)
  const hasBar = bar.capturer !== undefined && bar.progress > 0
  if (leader !== undefined) {
    return { direction: !hasBar || bar.capturer === leader ? 'up' : 'down', leader }
  }
  if (hasBar) {
    const own = presence.get(bar.capturer as number) ?? 0
    if (Math.max(0, ...presence.values()) > own) return { direction: 'down' }
  }
  return { direction: 'none' }
}

// One tick of the game's objective, from the state the last tick left: a new state, with the old one
// untouched. It is plain arithmetic on whole numbers, so every simulator gets the same answer. `killerTeams`
// is the team of whoever made each kill this tick, which is what a team scores in team deathmatch.
export function advanceObjective(
  state: ObjectiveState | undefined,
  setup: ModeSetup,
  units: readonly ObjectiveUnit[],
  tick: number,
  killerTeams: readonly number[] = [],
): ObjectiveState | undefined {
  if (setup.kind === 'koth') {
    return stepHill(
      state?.kind === 'koth' ? state : initialObjective(setup) as Extract<ObjectiveState, { kind: 'koth' }>,
      setup.hill,
      units,
      tick,
      hillCaptureTicks(setup),
    )
  }
  if (setup.kind === 'ctf') {
    return stepFlags(state?.kind === 'ctf' ? state : initialObjective(setup) as Extract<ObjectiveState, { kind: 'ctf' }>, setup.flags, units)
  }
  const kept = state?.kind === 'deathmatch' ? state : undefined
  if (killerTeams.length === 0) return kept
  const scores = { ...kept?.scores }
  for (const team of killerTeams) addPoint(scores, team)
  return { kind: 'deathmatch', scores }
}

// ---------------------------------------------------------------------------- winning

// Each team's score, keyed by the team's number: the kills, the points held, or the flags captured.
export function objectiveScores(objective: ObjectiveState | undefined): Record<string, number> {
  return objective ? { ...objective.scores } : {}
}

// The team ahead, if one is strictly ahead of every other and has scored at all.
export function leadingTeam(scores: Record<string, number>): number | undefined {
  const ranked = Object.entries(scores).sort(([, left], [, right]) => right - left)
  const [top, next] = ranked
  return top && top[1] > 0 && (!next || top[1] > next[1]) ? Number(top[0]) : undefined
}

// The team that has won: the one ahead of the rest once a team has reached the score limit. Two teams that
// reach it together, level, have not decided it: the game goes on until one is ahead. With no limit no one wins.
export function winningTeam(setup: ModeSetup, objective: ObjectiveState | undefined): number | undefined {
  const limit = setup.scoreLimit
  if (limit === undefined) return undefined
  const scores = objectiveScores(objective)
  const ahead = leadingTeam(scores)
  return ahead !== undefined && scores[String(ahead)] >= limit ? ahead : undefined
}

type HillState = Extract<ObjectiveState, { kind: 'koth' }>
type FlagsState = Extract<ObjectiveState, { kind: 'ctf' }>

// The bar moves a tick's worth a tick, the way `hillMovement` says: up for the team that leads on the hill, down
// when the bar is another team's and it is outnumbered, and it stays as it is with no one on the hill or the
// bar's team as many as any other. An empty bar is no one's, and a team that has the bar full scores a point
// every GAME_HILL_POINT_TICKS.
function stepHill(
  state: HillState,
  hill: HillArea,
  units: readonly ObjectiveUnit[],
  tick: number,
  captureTicks: number,
): HillState {
  const next: HillState = { ...state, scores: { ...state.scores } }
  const { direction, leader } = hillMovement(next, hillPresence(hill, units))
  if (direction === 'up' && leader !== undefined) {
    next.capturer = leader
    next.progress = Math.min(captureTicks, next.progress + 1)
  } else if (direction === 'down') {
    next.progress = Math.max(0, next.progress - 1)
  }
  if (next.progress === 0) delete next.capturer
  const owner = hillOwner(next, captureTicks)
  if (owner !== undefined && tick % GAME_HILL_POINT_TICKS === 0) addPoint(next.scores, owner)
  return next
}

// In order, on a tick:
//   1. a flag whose carrier died or left the game drops where the carrier was;
//   2. a dropped flag is returned to its base by a living champion of its own team touching it;
//   3. a flag that is at its base or dropped is picked up by a living champion of another team touching
//      it (the one with the lowest ID, if several do);
//   4. a carrier touching its own team's flag's base turns the flag it carries in, if its own flag is at
//      its base: the team scores a point and the flag it carried goes home. If not, nothing happens, and
//      it keeps carrying.
function stepFlags(state: FlagsState, setups: readonly { team: number; home: Vector2 }[], units: readonly ObjectiveUnit[]): FlagsState {
  const next: FlagsState = {
    ...state,
    flags: state.flags.map((flag) => ({ ...flag, position: { ...flag.position } })),
    scores: { ...state.scores },
  }
  const homeOf = (team: number): Vector2 | undefined => setups.find((setup) => setup.team === team)?.home
  const isHome = (flag: FlagsState['flags'][number]): boolean => {
    const home = homeOf(flag.team)
    return flag.carrierId === undefined && home !== undefined && flag.position.x === home.x && flag.position.y === home.y
  }
  const touches = (unit: ObjectiveUnit, at: Vector2): boolean =>
    Math.hypot(unit.position.x - at.x, unit.position.y - at.y) <= GAME_FLAG_RADIUS + unit.radius
  const ordered = [...units].sort((left, right) => left.id - right.id)
  const living = ordered.filter((unit) => unit.alive)

  for (const flag of next.flags) {
    if (flag.carrierId === undefined) continue
    const carrier = ordered.find((unit) => unit.id === flag.carrierId)
    if (carrier) flag.position = { ...carrier.position }
    if (!carrier?.alive) delete flag.carrierId
  }
  for (const flag of next.flags) {
    if (flag.carrierId !== undefined || isHome(flag)) continue
    if (living.some((unit) => unit.team === flag.team && touches(unit, flag.position))) {
      flag.position = { ...(homeOf(flag.team) as Vector2) }
    }
  }
  for (const flag of next.flags) {
    if (flag.carrierId !== undefined) continue
    const taker = living.find((unit) =>
      unit.team !== flag.team
      && touches(unit, flag.position)
      && !next.flags.some((other) => other.carrierId === unit.id))
    if (taker) {
      flag.carrierId = taker.id
      flag.position = { ...taker.position }
    }
  }
  for (const flag of next.flags) {
    const carrier = flag.carrierId === undefined ? undefined : living.find((unit) => unit.id === flag.carrierId)
    if (!carrier) continue
    const own = next.flags.find((other) => other.team === carrier.team)
    const base = homeOf(carrier.team)
    if (!own || !base || !isHome(own) || !touches(carrier, base)) continue
    addPoint(next.scores, carrier.team)
    delete flag.carrierId
    flag.position = { ...(homeOf(flag.team) as Vector2) }
  }
  return next
}

function addPoint(scores: Record<string, number>, team: number): void {
  scores[String(team)] = (scores[String(team)] ?? 0) + 1
}
