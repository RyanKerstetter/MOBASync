import { GAME_RESPAWN_TICKS_PER_LEVEL, GAME_TPS } from './constants.js'

// What a character collects, and the level that experience makes. Gold and shards are only kept for now (nothing is spent), and the
// experience makes the level, which makes the champion stronger (see stats.ts).
//
// The shards are a tally the simulator keeps (see `SimCharacter`), credited when a kill can no longer be undone, the way kills are, so they
// are the same on the server and on every client and are carried in a snapshot. The experience and the gold are not tallies: they are in the
// character's frame (`GameFrameCharacter.xp` and `.gold`), credited on the tick of the kill, because the level the experience makes and the
// items the gold buys (see items.ts) change what a frame works out, and so every peer has to have them on the same tick, and a kill that a
// late order undoes has to take them back.

export type Resources = {
  gold: number
  // Experience, from which the level is worked out (`levelForXp`).
  xp: number
  shards: number
}

// How much gold a player starts a game with, to spend in the shop (see items.ts). A frame's gold is in the frame, so this is where it starts.
export const GAME_STARTING_GOLD = 50

// The highest level a player can be. Experience past it is still counted, and the level stays here.
export const GAME_MAX_LEVEL = 18
// How the experience a level takes grows (see `xpToNextLevel`): level 1 takes the first number, and every level after it takes this much more than the one
// before, so the levels are 100, 150, 200, 250 ... for a step of 50. A step of 0 is the same experience for every level.
export const GAME_XP_FIRST_LEVEL = 100
export const GAME_XP_STEP = 50

// The experience a player needs to go from this level to the next. This is the one place that says how levelling scales: the level an amount of
// experience makes (`levelForXp`), how far a player is to the next (`xpProgress`) and what it takes to reach a level (`xpToReachLevel`) are all
// worked out from it, so changing it (to something that is not a straight line, say) changes them all.
export function xpToNextLevel(level: number): number {
  return GAME_XP_FIRST_LEVEL + GAME_XP_STEP * (Math.max(1, level) - 1)
}

// The experience all the levels before this one take together: the least a player has at it. Level 1 is 0.
export function xpToReachLevel(level: number): number {
  let total = 0
  for (let each = 1; each < level; each += 1) total += xpToNextLevel(each)
  return total
}

// How long a champion of this level stays dead, when the game's respawn time is `baseTicks` (what a level 1 champion waits): that, and `GAME_RESPAWN_TICKS_PER_LEVEL`
// more for each level above the first. The one place that says how the wait scales with levels.
export function respawnTicksAt(baseTicks: number, level: number): number {
  return baseTicks + GAME_RESPAWN_TICKS_PER_LEVEL * (Math.max(1, Math.floor(level)) - 1)
}

// ---------------------------------------------------------------------------- credit for a kill

// Who is credited with a kill is worked out from the damage that players did to the victim (see `creditKill`): the player who landed the last blow gets the kill, and the
// players who hurt it are listed after them by how much damage they did; the one second in that list gets the assist, if they are on the killer's team. Nobody else is paid.
// Damage counts as it was done to the victim in its current fight, and the tally is wiped when nobody has hurt the victim for this many ticks (and when it dies), so a scrape
// from long ago is not an assist.
export const GAME_CREDIT_WINDOW_TICKS = 10 * GAME_TPS
// The share of a kill's experience an assist pays the assister. The killer is paid all of it as always; this is on top, and is not taken from them. Gold is not shared.
export const ASSIST_XP_SHARE = 0.4

// The experience an assist on a kill that paid this much is worth, in whole points.
export function assistXp(killXp: number): number {
  return Math.round(Math.max(0, killXp) * ASSIST_XP_SHARE)
}

// How much damage one player has done to a victim.
export type DamageShare = { id: number; damage: number }
// The damage players have done to a victim lately, in the order they first did any, and the tick of the last of it. It is in the victim's frame (`GameFrameCharacter.credit`).
export type DamageCredit = { tick: number; by: DamageShare[] }

// What is still counting of a victim's tally at `tick`: all of it, or none once nobody has hurt the victim for `GAME_CREDIT_WINDOW_TICKS`.
export function liveDamage(credit: DamageCredit | undefined, tick: number): readonly DamageShare[] {
  return credit && tick - credit.tick <= GAME_CREDIT_WINDOW_TICKS ? credit.by : []
}

// The tally with this much more damage from this player at `tick`: a new tally if the old one has run out, and in any case a new object (a frame's is never changed in place).
export function addDamage(credit: DamageCredit | undefined, id: number, damage: number, tick: number): DamageCredit {
  const by = liveDamage(credit, tick).map((share) => ({ ...share }))
  const mine = by.find((share) => share.id === id)
  if (mine) mine.damage += damage
  else by.push({ id, damage })
  return { tick, by }
}

// The players who have hurt a victim, the one who did the most damage first. Equal damage goes to whoever started hurting it first.
export function rankDamage(shares: readonly DamageShare[]): DamageShare[] {
  return shares
    .map((share, index) => ({ share, index }))
    .sort((left, right) => right.share.damage - left.share.damage || left.index - right.index)
    .map(({ share }) => share)
}

// Who a death is credited to: the player who landed the last blow (`lastHitId`) is the killer, then come the rest of the players who hurt the victim, the one who did the
// most damage first (`rankDamage`). The one second in that list is the assist if they are on the killer's team (`teamOf`), and nobody else is, whoever they are. When the last
// blow was not a player's (a turret, a monster, the victim itself), the one who did the most damage is the killer, as if they had landed it. Nobody if no player hurt it.
export function creditKill(
  shares: readonly DamageShare[],
  teamOf: (id: number) => number | undefined,
  lastHitId?: number,
): { killerId?: number; assistId?: number } {
  const ranked = rankDamage(shares)
  const killer = ranked.find((share) => share.id === lastHitId) ?? ranked[0]
  if (!killer) return {}
  const assist = ranked.find((share) => share !== killer)
  const assisted = assist !== undefined && teamOf(assist.id) === teamOf(killer.id)
  return { killerId: killer.id, ...(assisted ? { assistId: assist.id } : {}) }
}

// What killing a player is worth to whoever did it, at level 1: the gold, and the experience, which is more for each level the player killed is (`playerKillXpAt`).
export const PLAYER_KILL_REWARD: Readonly<Resources> = { gold: 50, xp: 80, shards: 0 }
// How much more experience killing a player pays for each level it has gained, as a share of `PLAYER_KILL_REWARD`'s: 0.2 is a fifth more for each level above the first (the level
// counts from 1, as it does for a monster's `xpGrowth`, so a level 1 player pays the reward as it is, and a level 6 one twice it). The gold is the same whatever the level.
export const PLAYER_KILL_XP_PER_LEVEL = 0.2

// The experience killing a player of this level pays, when a level 1 player pays `baseXp`: that, and `PLAYER_KILL_XP_PER_LEVEL` of it more for each level above the first, in whole
// points. The one place that says how a kill's experience grows with the level of the player killed.
export function playerKillXpAt(baseXp: number, level: number): number {
  const gained = Math.max(0, Math.floor(Number.isFinite(level) ? level : 1) - 1)
  return Math.round(Math.max(0, baseXp) * (1 + PLAYER_KILL_XP_PER_LEVEL * gained))
}

// Catch-up: a player who is behind is paid more experience, so one who has fallen behind can come back. Whenever experience is paid to a player (for a kill, an assist, a monster or a
// turret), it is multiplied by 1 plus this much for each level the player is below the highest level of any player in the game (on any team, dead or alive; a monster has levels but
// is no player). 0.2 is a fifth more for each level behind. The best player is behind no one, and is paid as it is: it is never paid less.
export const GAME_CATCHUP_XP_PER_LEVEL = 0.2

// What a player of this level is paid for experience, as a multiplier, when the best player in the game is at `topLevel`.
export function catchupMultiplier(level: number, topLevel: number): number {
  const behind = Math.floor(topLevel) - Math.floor(level)
  return Number.isFinite(behind) && behind > 0 ? 1 + GAME_CATCHUP_XP_PER_LEVEL * behind : 1
}

// The experience a player of this level is paid for an award worth `xp`, in whole points. The one place that says how catch-up pays.
export function catchupXp(xp: number, level: number, topLevel: number): number {
  return Math.round(Math.max(0, xp) * catchupMultiplier(level, topLevel))
}
// What killing a monster is worth when its entry in monsters.ts does not say (`MonsterDef.reward`).
export const DEFAULT_MONSTER_REWARD: Readonly<Resources> = { gold: 25, xp: 25, shards: 0 }
// What destroying a turret is worth when its tier in turrets.ts does not say (`TurretTierDef.reward`).
export const DEFAULT_TURRET_REWARD: Readonly<Resources> = { gold: 100, xp: 50, shards: 0 }
// What breaking a core is worth when its entry in turrets.ts does not say (`TurretTierDef.reward`, of a tier that is a `core`): nothing, as it is the end of the game for a team.
export const DEFAULT_CORE_REWARD: Readonly<Resources> = { gold: 0, xp: 0, shards: 0 }

// The level this much experience is: 1 to start with, and one more each time it covers what the level it is at takes (`xpToNextLevel`), up to
// `GAME_MAX_LEVEL`.
export function levelForXp(xp: number): number {
  let level = 1
  let left = xp > 0 ? xp : 0
  while (level < GAME_MAX_LEVEL && left >= xpToNextLevel(level)) {
    left -= xpToNextLevel(level)
    level += 1
  }
  return level
}

export type XpProgress = {
  level: number
  // How much of the way to the next level it is: the experience gained in this level, out of what the level takes.
  into: number
  needed: number
  // `into` over `needed`, from 0 to 1.
  fraction: number
  // At the highest level there is no next one: the bar is full and there is nothing to count.
  maxed: boolean
}

export function xpProgress(xp: number): XpProgress {
  const level = levelForXp(xp)
  if (level >= GAME_MAX_LEVEL) return { level, into: 0, needed: 0, fraction: 1, maxed: true }
  const into = Math.max(0, xp) - xpToReachLevel(level)
  const needed = xpToNextLevel(level)
  return { level, into, needed, fraction: into / needed, maxed: false }
}

// ---------------------------------------------------------------------------- monsters

// A monster levels up each time it is killed: it comes back one level higher, so it is stronger (its stats grow by level, as a champion's do: see
// `MonsterDef.growth`) and pays more experience, and the same gold. This is the level it comes back at, and the one place to change how a kill
// levels it (the level is in its frame: see `GameFrameCharacter.level`).
export function monsterLevelAfterKill(level: number): number {
  return level + 1
}

// How much experience a monster pays more for each level it has above the first, when its entry does not say (`MonsterDef.xpGrowth`).
export const DEFAULT_MONSTER_XP_GROWTH = 10

// The experience a monster at this level pays: what its entry says at level 1, and its growth more for each level after, in a straight line. This is the one
// place that says how a monster's reward scales (its gold and its shards do not: they are the same at every level).
export function monsterXpAt(baseXp: number, xpGrowth: number, level: number): number {
  return baseXp + xpGrowth * (Math.max(1, level) - 1)
}
