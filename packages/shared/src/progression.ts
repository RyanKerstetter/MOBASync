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

// What killing a player is worth to whoever did it, the same whoever is killed.
export const PLAYER_KILL_REWARD: Readonly<Resources> = { gold: 50, xp: 80, shards: 0 }
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
