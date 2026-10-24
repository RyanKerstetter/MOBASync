import { getTeam } from '../../../../packages/shared/src/index.ts'
import type { KillFeedEntry, LeaderboardRow } from './scoreboard.ts'

// A player's name in their team's colour.
function nameTag(person: { name: string; team: number }): HTMLElement {
  const name = document.createElement('span')
  name.className = 'scoreboard-name'
  name.textContent = person.name
  name.style.color = getTeam(person.team).color
  return name
}

// The top right: who has how many kills, and under it the latest kills as they are confirmed. Plain
// elements over the canvas, hidden until the first update, and rebuilt only when what they show
// changes.
export function createScoreboardView(container: HTMLElement) {
  const root = document.createElement('div')
  root.className = 'game-scoreboard'
  root.hidden = true
  const leaderboard = document.createElement('ol')
  leaderboard.className = 'leaderboard'
  leaderboard.setAttribute('aria-label', 'Kills')
  const killFeed = document.createElement('ul')
  killFeed.className = 'kill-feed'
  killFeed.setAttribute('aria-label', 'Kill feed')
  root.append(leaderboard, killFeed)
  container.appendChild(root)
  let shownLeaderboard = ''
  let shownKillFeed = ''

  return {
    update(rows: readonly LeaderboardRow[], feed: readonly KillFeedEntry[]): void {
      root.hidden = false
      const leaderboardKey = JSON.stringify(rows)
      if (leaderboardKey !== shownLeaderboard) {
        shownLeaderboard = leaderboardKey
        leaderboard.replaceChildren(...rows.map((row) => {
          const item = document.createElement('li')
          item.classList.toggle('is-local', row.isLocal)
          const kills = document.createElement('span')
          kills.className = 'scoreboard-kills'
          kills.textContent = String(row.kills)
          item.append(nameTag(row), kills)
          return item
        }))
      }
      const killFeedKey = feed.map((entry) => entry.id).join(',')
      if (killFeedKey !== shownKillFeed) {
        shownKillFeed = killFeedKey
        killFeed.replaceChildren(...feed.map((entry) => {
          const item = document.createElement('li')
          const verb = document.createElement('span')
          verb.className = 'kill-feed-verb'
          verb.textContent = entry.killer ? 'defeated' : 'was defeated'
          item.append(...(entry.killer ? [nameTag(entry.killer), verb, nameTag(entry.victim)] : [nameTag(entry.victim), verb]))
          return item
        }))
      }
    },
    destroy(): void {
      root.remove()
    },
  }
}
