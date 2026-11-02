import { getTeam } from '../../../../packages/shared/src/index.ts'
import { element } from './dom.ts'
import type { KillFeedEntry, LeaderboardRow } from './scoreboard.ts'

// A player's name in their team's colour.
function nameTag(person: { name: string; team: number }): HTMLElement {
  const name = element('span', 'scoreboard-name', person.name)
  name.style.color = getTeam(person.team).color
  return name
}

// The top right: who has how many kills, and under it the latest kills as they are confirmed. Plain
// elements over the canvas, hidden until the first update, and rebuilt only when what they show
// changes.
export function createScoreboardView(container: HTMLElement) {
  const leaderboard = element('ol', 'leaderboard')
  leaderboard.setAttribute('aria-label', 'Kills')
  const killFeed = element('ul', 'kill-feed')
  killFeed.setAttribute('aria-label', 'Kill feed')
  const root = element('div', 'game-scoreboard', leaderboard, killFeed)
  root.hidden = true
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
          const item = element('li', '', nameTag(row), element('span', 'scoreboard-kills', String(row.kills)))
          item.classList.toggle('is-local', row.isLocal)
          return item
        }))
      }
      const killFeedKey = feed.map((entry) => entry.id).join(',')
      if (killFeedKey !== shownKillFeed) {
        shownKillFeed = killFeedKey
        killFeed.replaceChildren(...feed.map((entry) => {
          const verb = element('span', 'kill-feed-verb', entry.killer ? 'defeated' : 'was defeated')
          return element('li', '', ...(entry.killer ? [nameTag(entry.killer), verb, nameTag(entry.victim)] : [nameTag(entry.victim), verb]))
        }))
      }
    },
    destroy(): void {
      root.remove()
    },
  }
}
