import {
  GAME_HILL_CAPTURE_TICKS,
  getGameMode,
  getTeam,
  type GameMode,
  type HillArea,
  type Vector2,
} from '../../../../packages/shared/src/index.ts'

// What the game mode shows over the screen, as plain data: the score of each team, and for the hill and
// the flags how they stand. `ClientGameState.getModeView` makes it from the simulation, the HUD
// (mode-hud-view.ts) and the world (render/objective-layer.ts) draw it, and the words are all made here.

export type TeamScore = { team: number; score: number }

export type FlagView = {
  // The team the flag belongs to.
  team: number
  status: 'home' | 'carried' | 'dropped'
  // Where its base is, and where it is: with the carrier, on the ground where it was dropped, or at the base.
  home: Vector2
  position: Vector2
  carrier?: { id: number; name: string; team: number }
}

export type HillView = {
  hill: HillArea
  // The team whose colour the bar is, while it has anything in it, how full it is from 0 to 1, and the team
  // that holds the hill (the bar is full).
  capturer?: number
  fraction: number
  owner?: number
  // The team with more players on the hill than any other right now, whether two or more teams are on it
  // level with each other, and which way that sends the bar (see `hillMovement`).
  leader?: number
  contested: boolean
  direction: 'up' | 'down' | 'none'
}

// What every mode has: each team's score, and the score a team wins at, if the game has a limit.
type ScoreView = { scores: TeamScore[]; limit?: number }

export type ModeView =
  | ({ kind: 'deathmatch' } & ScoreView)
  | ({ kind: 'koth' } & ScoreView & HillView)
  | ({ kind: 'ctf'; flags: FlagView[] } & ScoreView)

// The heading of the mode's panel: its name, and what a team has to reach to win when the game has a limit.
export function modeTitle(view: { kind: GameMode; limit?: number }): string {
  const mode = getGameMode(view.kind)
  return view.limit === undefined ? mode.name : `${mode.name} · first to ${view.limit} ${mode.scoreName}`
}

// The teams with their scores, the highest first. A tie keeps the lower team number first, so the order
// does not shuffle as the score changes hands.
export function rankScores(teams: readonly number[], scoreOf: (team: number) => number): TeamScore[] {
  return teams
    .map((team) => ({ team, score: scoreOf(team) }))
    .sort((left, right) => right.score - left.score || left.team - right.team)
}

// How full the bar is, from 0 to 1, for a game where it takes `captureTicks` to fill.
export function hillFraction(progress: number, captureTicks: number = GAME_HILL_CAPTURE_TICKS): number {
  return Math.max(0, Math.min(1, progress / captureTicks))
}

const teamName = (team: number): string => getTeam(team).name

// The bar for the hill: how full it is, whose colour, and what is going on in words.
export function hillReadout(view: HillView): { fraction: number; team?: number; text: string } {
  const percent = `${Math.floor(view.fraction * 100)}%`
  const team = view.capturer
  if (view.owner !== undefined) {
    return {
      fraction: 1,
      team: view.owner,
      text: view.direction === 'down'
        ? view.leader !== undefined
          ? `${teamName(view.leader)} taking the hill from ${teamName(view.owner)}`
          : `${teamName(view.owner)} losing the hill, contested`
        : `Held by ${teamName(view.owner)}`,
    }
  }
  if (team === undefined) {
    return {
      fraction: 0,
      text: view.direction === 'up' && view.leader !== undefined
        ? `${teamName(view.leader)} capturing`
        : view.contested ? 'Contested' : 'Nobody holds the hill',
    }
  }
  let note = ''
  if (view.direction === 'up') note = ' · capturing'
  else if (view.direction === 'down') {
    note = view.leader !== undefined ? ` · ${teamName(view.leader)} taking it` : ' · contested, draining'
  } else if (view.contested) note = ' · contested'
  return { fraction: view.fraction, team, text: `${teamName(team)} ${percent}${note}` }
}

export function flagReadout(flag: FlagView): string {
  if (flag.status === 'carried') return `Carried by ${flag.carrier?.name ?? 'someone'}`
  return flag.status === 'dropped' ? 'Dropped' : 'At base'
}

// One line to tell the local player what to do about the flags, if there is anything: they carry one, their
// own is out of its base (which stops them scoring), or it is on the ground waiting to be returned.
export function flagHint(flags: readonly FlagView[], local: { id: number; team: number } | undefined): string | undefined {
  if (!local) return undefined
  const own = flags.find((flag) => flag.team === local.team)
  const carried = flags.find((flag) => flag.carrier?.id === local.id)
  if (carried) {
    return own && own.status !== 'home'
      ? `You have the ${teamName(carried.team)} flag. Your own flag is out: get it back to score.`
      : `You have the ${teamName(carried.team)} flag. Bring it to your base!`
  }
  if (own?.status === 'dropped') return 'Your flag was dropped. Walk over it to return it.'
  if (own?.status === 'carried') return `Your flag is with ${own.carrier?.name ?? 'an enemy'}. Take it down.`
  return undefined
}
