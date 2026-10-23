// One row of the leaderboard: a champion's player, what team they are on, and how many kills they have.
export type LeaderboardRow = {
  characterId: number
  name: string
  team: number
  kills: number
  isLocal: boolean
}

// The leaderboard: most kills first. Players with the same number keep the order they joined in, so
// the list does not shuffle when they tie.
export function leaderboardRows(
  characters: ReadonlyArray<{ id: number; name: string; team: number; kills: number }>,
  localCharacterId: number | undefined,
): LeaderboardRow[] {
  return characters
    .map((character) => ({
      characterId: character.id,
      name: character.name,
      team: character.team,
      kills: character.kills,
      isLocal: character.id === localCharacterId,
    }))
    .sort((left, right) => right.kills - left.kills || left.characterId - right.characterId)
}

// Who a line of the killfeed is about, as it was when it happened: they may have left since.
export type KillFeedPerson = { name: string; team: number }

// One line of the killfeed. A death with no killer (a champion that took its own last health) has
// only its victim.
export type KillFeedEntry = {
  // Tells one death from another, so it is only added once however often it is told of.
  id: string
  victim: KillFeedPerson
  killer?: KillFeedPerson
  // The clock reading, in milliseconds, when it was added.
  at: number
}

// How long a line stays up, and how many lines can be up at once (the newest stay).
export const KILL_FEED_LIFETIME_MS = 6000
export const KILL_FEED_MAX_LINES = 5

// The lines to show now, oldest first.
export function visibleKillFeed(entries: readonly KillFeedEntry[], now: number): KillFeedEntry[] {
  return entries.filter((entry) => now - entry.at < KILL_FEED_LIFETIME_MS).slice(-KILL_FEED_MAX_LINES)
}
