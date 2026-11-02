import { getGameMode, getTeam, type GameResult } from '../../../../packages/shared/src/index.ts'
import { element } from './dom.ts'
import { resultHeadline } from './results.ts'

type ResultsOptions = {
  // The player chose to go back to the lobby.
  onReturn: () => void
}

// The screen over the game when it is over: the result in big words, how each team scored, how each player
// did, and the way back to the lobby. The game behind it stops taking orders (see `game.ts`).
export function createResultsView(container: HTMLElement, { onReturn }: ResultsOptions) {
  const title = element('h2', 'results-title')
  const subtitle = element('p', 'results-subtitle')
  const teams = element('ol', 'results-teams')
  teams.setAttribute('aria-label', 'Team scores')
  const players = element('table', 'results-players')
  const back = element('button', 'results-return', 'Return to lobby')
  back.type = 'button'
  back.addEventListener('click', onReturn)
  const panel = element('div', 'results-panel', title, subtitle, teams, players, back)
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Game results')
  const root = element('div', 'game-results', panel)
  root.hidden = true
  container.appendChild(root)

  return {
    get isShown(): boolean {
      return !root.hidden
    },
    show(result: GameResult, localTeam: number | undefined): void {
      const headline = resultHeadline(result, localTeam)
      panel.dataset.tone = headline.tone
      title.textContent = headline.title
      subtitle.textContent = headline.subtitle
      const scoreName = getGameMode(result.mode).scoreName
      teams.replaceChildren(...result.teams.map(({ team, score }) => {
        const swatch = element('span', 'results-swatch')
        swatch.setAttribute('aria-hidden', 'true')
        const points = element('span', 'results-score', String(score))
        points.title = scoreName
        const item = element('li', '', swatch, element('span', 'results-team', getTeam(team).name), points)
        item.classList.toggle('is-winner', team === result.winner)
        item.classList.toggle('is-local', team === localTeam)
        item.style.setProperty('--team-color', getTeam(team).color)
        return item
      }))
      const head = element('thead', '', element('tr', '', ...['Player', 'Kills'].map((text) => element('th', '', text))))
      const body = element('tbody', '', ...result.players.map((player) => {
        const name = element('td', '', player.left ? `${player.name} (left)` : player.name)
        name.style.color = getTeam(player.team).color
        const row = element('tr', '', name, element('td', '', String(player.kills)))
        row.classList.toggle('has-left', player.left === true)
        return row
      }))
      players.replaceChildren(head, body)
      root.hidden = false
    },
    hide(): void {
      root.hidden = true
    },
    destroy(): void {
      root.remove()
    },
  }
}
