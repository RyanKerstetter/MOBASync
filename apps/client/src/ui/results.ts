import { getGameMode, getTeam, type GameResult } from '../../../../packages/shared/src/index.ts'

// What a game that is over says for itself, as plain words and rows: the results screen over the game
// (results-view.ts) and the line in the lobby both read it from the `GameResult` the server sends.

export type ResultHeadline = {
  title: string
  subtitle: string
  // Whether the player it is for won, lost, or it is neither (the game was ended by the leader).
  tone: 'win' | 'loss' | 'neutral'
}

const teamName = (team: number): string => getTeam(team).name

// The big words, for a player on `localTeam`: Victory or Defeat when a team won, and that the game was
// ended when the leader called it off.
export function resultHeadline(result: GameResult, localTeam: number | undefined): ResultHeadline {
  const mode = getGameMode(result.mode)
  if (result.reason === 'limit' && result.winner !== undefined) {
    const goal = result.scoreLimit === undefined ? '' : `, first to ${result.scoreLimit} ${mode.scoreName}`
    const subtitle = `${teamName(result.winner)} wins${goal}`
    if (localTeam === undefined) return { title: `${teamName(result.winner)} wins`, subtitle, tone: 'neutral' }
    return localTeam === result.winner
      ? { title: 'Victory', subtitle, tone: 'win' }
      : { title: 'Defeat', subtitle, tone: 'loss' }
  }
  return {
    title: 'Game ended',
    subtitle: result.winner === undefined
      ? 'The leader ended the game. No team was ahead.'
      : `The leader ended the game. ${teamName(result.winner)} was ahead.`,
    tone: 'neutral',
  }
}

// "Red 25 · Blue 19", the teams with the highest score first, as the result has them.
export function scoreLine(result: GameResult): string {
  return result.teams.map(({ team, score }) => `${teamName(team)} ${score}`).join(' · ')
}

// One line about how the last game ended, for the lobby.
export function lobbySummary(result: GameResult): string {
  const how = result.reason === 'limit' && result.winner !== undefined
    ? `${teamName(result.winner)} won`
    : result.winner !== undefined ? `ended early, ${teamName(result.winner)} ahead` : 'ended early'
  return `Last game: ${getGameMode(result.mode).name}, ${how} (${scoreLine(result)})`
}
