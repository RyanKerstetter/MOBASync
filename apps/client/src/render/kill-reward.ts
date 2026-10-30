import type { Vector2 } from '../../../../packages/shared/src/index.ts'

// The effect over a body when a kill pays the controlled champion: the gold and the experience it gained, as words that pop up over where the
// victim fell, rise, and fade. It is shown for the champion you control only (what you gain is yours: a teammate's kill pays them), for any kill
// that pays, whether a player, a monster or a structure, and it shows what the kill really paid (see `Simulator.paidFor`), so it is never a
// guess. This is the layout and the timing of it, with no drawing, so it can be read and tested apart; the drawing is `KillRewardLayer`.

// What one kill paid, and where: the middle of the victim's body where it fell, and how big the body is, so the words are put over it.
export type KillRewardView = {
  // Which death it is for (its tick and victim), so a kill is shown once.
  id: string
  position: Vector2
  radius: number
  gold: number
  xp: number
}

// One line of the words: what it says and the colour it is in.
export type RewardLine = { text: string; color: string }

export const KILL_REWARD_GOLD_COLOR = '#ffd34d'
export const KILL_REWARD_XP_COLOR = '#b99cff'

// How long the words stay up, in milliseconds, and how fast they rise in world units a millisecond. They hold at full strength for the first
// part of it (`KILL_REWARD_HOLD`, a share of the whole) and then fade out. They start a little bigger and settle (`KILL_REWARD_POP_MS`).
export const KILL_REWARD_MS = 1600
export const KILL_REWARD_RISE = 1 / 30
export const KILL_REWARD_HOLD = 0.4
export const KILL_REWARD_POP_MS = 160
export const KILL_REWARD_POP_SCALE = 0.35

// How far apart the lines are, in world units, and how far over the top of the body the lowest starts.
export const KILL_REWARD_LINE_HEIGHT = 20
export const KILL_REWARD_LIFT = 28

// The lines to say, gold first and then experience, and none for what the kill did not pay.
export function rewardLines(reward: Pick<KillRewardView, 'gold' | 'xp'>): RewardLine[] {
  const lines: RewardLine[] = []
  if (reward.gold > 0) lines.push({ text: `+${reward.gold} gold`, color: KILL_REWARD_GOLD_COLOR })
  if (reward.xp > 0) lines.push({ text: `+${reward.xp} xp`, color: KILL_REWARD_XP_COLOR })
  return lines
}

export type RewardPose = {
  // How see-through it is: 1 until it starts to fade, and 0 when its time is up.
  alpha: number
  // How far it has risen, in world units.
  rise: number
  // How big it is, as a multiple of its size: more than 1 as it pops up, then 1.
  scale: number
}

// How the words look this long (in milliseconds) after the kill. Past their time they are gone: nothing is left of them, and `done` says so.
export function rewardPose(elapsedMs: number): RewardPose & { done: boolean } {
  const elapsed = Math.max(0, elapsedMs)
  const fadeStart = KILL_REWARD_MS * KILL_REWARD_HOLD
  const alpha = elapsed <= fadeStart ? 1 : Math.max(0, 1 - (elapsed - fadeStart) / (KILL_REWARD_MS - fadeStart))
  return {
    alpha,
    rise: elapsed * KILL_REWARD_RISE,
    scale: 1 + KILL_REWARD_POP_SCALE * Math.max(0, 1 - elapsed / KILL_REWARD_POP_MS),
    done: elapsed >= KILL_REWARD_MS,
  }
}
