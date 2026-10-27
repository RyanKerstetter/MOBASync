// The bar under a monster that shows it losing interest: it fills while the monster is further from its home than its deaggro range,
// and when it is full the monster gives up on everyone and walks home. It is only there when there is something in it, so a monster
// that is minding its own business, or is within its range of home, has none.
export type DeaggroBar = {
  // How full it is, from 0 (not quite) to 1.
  fraction: number
  color: string
}

// Amber while it fills, and red when it is full, which is the monster giving up.
export const DEAGGRO_COLOR = '#f28b3d'
export const DEAGGRO_FULL_COLOR = '#e5534b'

// What to draw for a monster whose deaggro bar is this full (from 0 to 1), or nothing if it is empty.
export function layoutDeaggroBar(fraction: number): DeaggroBar | undefined {
  if (!(fraction > 0)) return undefined
  const filled = Math.min(1, fraction)
  return { fraction: filled, color: filled >= 1 ? DEAGGRO_FULL_COLOR : DEAGGRO_COLOR }
}
