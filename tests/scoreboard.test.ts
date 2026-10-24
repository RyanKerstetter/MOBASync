import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KILL_FEED_LIFETIME_MS,
  KILL_FEED_MAX_LINES,
  leaderboardRows,
  visibleKillFeed,
  type KillFeedEntry,
} from '../apps/client/src/ui/scoreboard.ts'

test('the leaderboard puts the most kills first, keeps ties in join order, and marks the local player', () => {
  const rows = leaderboardRows([
    { id: 1, name: 'Ann', team: 1, kills: 2 },
    { id: 2, name: 'Bo', team: 2, kills: 5 },
    { id: 3, name: 'Cy', team: 3, kills: 2 },
    { id: 4, name: 'Di', team: 4, kills: 0 },
  ], 3)

  assert.deepEqual(rows.map(({ name }) => name), ['Bo', 'Ann', 'Cy', 'Di'])
  assert.deepEqual(rows.map(({ isLocal }) => isLocal), [false, false, true, false])
  assert.deepEqual(leaderboardRows([], undefined), [])
})

function entry(id: string, at: number): KillFeedEntry {
  return { id, at, victim: { name: 'Victim', team: 1 }, killer: { name: 'Killer', team: 2 } }
}

test('the killfeed shows the lines that are still fresh, oldest first, and no more than fit', () => {
  const now = 100_000
  const entries = [
    entry('stale', now - KILL_FEED_LIFETIME_MS),
    ...Array.from({ length: KILL_FEED_MAX_LINES + 2 }, (_, index) => entry(`fresh-${index}`, now - 1000 + index)),
  ]

  const shown = visibleKillFeed(entries, now)
  assert.equal(shown.length, KILL_FEED_MAX_LINES)
  assert.equal(shown.some(({ id }) => id === 'stale'), false, 'a line is gone once its time is up')
  assert.deepEqual(shown.map(({ id }) => id), entries.slice(-KILL_FEED_MAX_LINES).map(({ id }) => id), 'the newest stay')
})
