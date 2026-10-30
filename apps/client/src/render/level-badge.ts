// A player's level, shown in a small round badge at the left end of its health bar, where it reads as part of the bar and does not depend on how
// wide the name over it is. The badge is placed from the bar alone, so it is a pure function of where the bar is.

export const LEVEL_BADGE_RADIUS = 10
// The space between the badge and the end of the bar.
export const LEVEL_BADGE_GAP = 3

export type LevelBadge = {
  // The middle of the badge, from the middle of the character across and from the character's position down (up is less).
  x: number
  y: number
  radius: number
  // What it says.
  text: string
}

// The badge for a level, or none for something with no level to show (a monster, a turret, a game with no levels). The bar is `width` across, centred
// on the character, with its top at `top` and `height` tall.
export function layoutLevelBadge(
  level: number | undefined,
  bar: { width: number; top: number; height: number },
): LevelBadge | undefined {
  if (level === undefined || !Number.isFinite(level)) return undefined
  return {
    x: -bar.width / 2 - LEVEL_BADGE_GAP - LEVEL_BADGE_RADIUS,
    y: bar.top + bar.height / 2,
    radius: LEVEL_BADGE_RADIUS,
    text: String(Math.max(1, Math.floor(level))),
  }
}
