import { getGameMode, getTeam, type GameResult } from '../../../../packages/shared/src/index.ts'
import { resultHeadline } from './results.ts'

type ResultsOptions = {
  // The player chose to go back to the lobby.
  onReturn: () => void
}

// The screen over the game when it is over: the result in big words, how each team scored, how each player
// did, and the way back to the lobby. The game behind it stops taking orders (see `game.ts`).
export function createResultsView(container: HTMLElement, { onReturn }: ResultsOptions) {
  const root = document.createElement('div')
  root.className = 'game-results'
  root.hidden = true
  const panel = document.createElement('div')
  panel.className = 'results-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Game results')
  const title = document.createElement('h2')
  title.className = 'results-title'
  const subtitle = document.createElement('p')
  subtitle.className = 'results-subtitle'
  const teams = document.createElement('ol')
  teams.className = 'results-teams'
  teams.setAttribute('aria-label', 'Team scores')
  const players = document.createElement('table')
  players.className = 'results-players'
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'results-return'
  back.textContent = 'Return to lobby'
  back.addEventListener('click', onReturn)
  panel.append(title, subtitle, teams, players, back)
  root.append(panel)
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
        const item = document.createElement('li')
        item.classList.toggle('is-winner', team === result.winner)
        item.classList.toggle('is-local', team === localTeam)
        item.style.setProperty('--team-color', getTeam(team).color)
        const swatch = document.createElement('span')
        swatch.className = 'results-swatch'
        swatch.setAttribute('aria-hidden', 'true')
        const name = document.createElement('span')
        name.className = 'results-team'
        name.textContent = getTeam(team).name
        const points = document.createElement('span')
        points.className = 'results-score'
        points.textContent = String(score)
        points.title = scoreName
        item.append(swatch, name, points)
        return item
      }))
      const head = document.createElement('thead')
      const headRow = document.createElement('tr')
      for (const text of ['Player', 'Kills']) {
        const cell = document.createElement('th')
        cell.textContent = text
        headRow.append(cell)
      }
      head.append(headRow)
      const body = document.createElement('tbody')
      for (const player of result.players) {
        const row = document.createElement('tr')
        row.classList.toggle('has-left', player.left === true)
        const name = document.createElement('td')
        name.textContent = player.left ? `${player.name} (left)` : player.name
        name.style.color = getTeam(player.team).color
        const kills = document.createElement('td')
        kills.textContent = String(player.kills)
        row.append(name, kills)
        body.append(row)
      }
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
