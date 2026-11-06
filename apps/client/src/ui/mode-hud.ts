import {
  clamp,
  GAME_HILL_CAPTURE_TICKS,
  getGameMode,
  getTeam,
  type GameMode,
  type HillArea,
  type Vector2,
} from '../../../../packages/shared/src/index.ts'

// What the game mode shows over the screen, as plain data: the score of each team, and for the hill, the
// flags and the cores how they stand. `ClientGameState.getModeView` makes it from the simulation, the HUD
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

// How a team's core stands in Core Destruction: protected (its turrets are still up, so it takes no damage), open (it can be hurt), broken
// (it is down, so the team cannot respawn, and its players are all it has), or eliminated (broken, and no player left alive).
export type CoreView = {
  team: number
  hp: number
  maxHp: number
  status: 'protected' | 'open' | 'broken' | 'eliminated'
  // How many players of the team are alive.
  playersAlive: number
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

// How a game of arena stands. `rounds` has a box for every round the game can take (`arenaMaxRounds`), in order, with the team that won it once it has been won.
// `current` is the box of the round being fought, or of the one just won while the next waits to begin. `over` is set while it waits: who won the round (no one, if
// the last players fell together, and it is played again), and how long until the next.
export type ArenaView = {
  rounds: Array<{ winner?: number }>
  current: number
  over?: { winner?: number; secondsLeft: number }
}

// What every mode has: each team's score, and the score a team wins at, if the game has a limit.
type ScoreView = { scores: TeamScore[]; limit?: number }

export type ModeView =
  | ({ kind: 'deathmatch' } & ScoreView)
  | ({ kind: 'koth' } & ScoreView & HillView)
  | ({ kind: 'ctf'; flags: FlagView[] } & ScoreView)
  | ({ kind: 'core'; cores: CoreView[] } & ScoreView)
  | ({ kind: 'arena' } & ScoreView & ArenaView)

// The heading of the mode's panel: its name, and what a team has to reach to win when the game has a limit.
export function modeTitle(view: { kind: GameMode; limit?: number }): string {
  const mode = getGameMode(view.kind)
  return view.limit === undefined ? mode.name : `${mode.name} · first to ${view.limit} ${mode.scoreName}`
}

// How far into the game it is, as a clock that counts up: minutes and seconds (`3:07`), and hours once there are some (`1:03:07`). It reads whole seconds, rounded down, so it turns
// over when a second is reached and never runs ahead of the game. Before the start, or from a number that is not one, it is `0:00`.
export function formatGameClock(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const two = (value: number): string => String(value).padStart(2, '0')
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  return hours > 0 ? `${hours}:${two(minutes)}:${two(whole % 60)}` : `${minutes}:${two(whole % 60)}`
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
  return clamp(progress / captureTicks, 0, 1)
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

// What a team's core row says: how full its health is (from 0 to 1) and, in words, how it stands.
export function coreReadout(core: CoreView): { fraction: number; text: string } {
  const fraction = core.maxHp > 0 ? clamp(core.hp / core.maxHp, 0, 1) : 0
  const players = `${core.playersAlive} player${core.playersAlive === 1 ? '' : 's'} left`
  switch (core.status) {
    case 'eliminated':
      return { fraction: 0, text: 'Eliminated' }
    case 'broken':
      return { fraction: 0, text: `Core broken · ${players}` }
    case 'protected':
      return { fraction, text: 'Protected by turrets' }
    default:
      return { fraction, text: `${Math.ceil(core.hp)} / ${core.maxHp}` }
  }
}

// One line to tell the local player where the game stands, if there is anything to say: their own core is down, so they cannot
// respawn, or the enemy's is, so the players of that team are what is left to take down.
export function coreHint(cores: readonly CoreView[], local: { id: number; team: number } | undefined): string | undefined {
  if (!local) return undefined
  const own = cores.find((core) => core.team === local.team)
  if (own?.status === 'broken') return 'Your core is down: you cannot respawn. Keep your team alive.'
  const enemy = cores.find((core) => core.team !== local.team)
  if (enemy?.status === 'broken') return `${teamName(enemy.team)}'s core is down. Take down every one of their players to win.`
  return undefined
}

// What a round's box says to a screen reader, and on hover: who won it, that it is being fought, or that it has not been.
export function roundLabel(round: { winner?: number }, index: number, current: number): string {
  const name = `Round ${index + 1}`
  if (round.winner !== undefined) return `${name}: ${teamName(round.winner)}`
  return index === current ? `${name}: in play` : name
}

// One line about the round in arena, while one is over: who won it and when the next begins, or that no one did and it is played again. (While a round is
// fought, the boxes and the health bar of a player who is out say all there is.)
export function arenaHint(view: ArenaView & { limit?: number; scores: readonly TeamScore[] }): string | undefined {
  const over = view.over
  if (!over) return undefined
  const wait = `${Math.max(1, Math.ceil(over.secondsLeft))}s`
  if (over.winner === undefined) return `No one is left. The round is played again in ${wait}.`
  const won = view.scores.find((row) => row.team === over.winner)?.score ?? 0
  // The round that wins the game has no next.
  if (view.limit !== undefined && won >= view.limit) return `${teamName(over.winner)} wins the round.`
  return `${teamName(over.winner)} wins the round. Next round in ${wait}.`
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
