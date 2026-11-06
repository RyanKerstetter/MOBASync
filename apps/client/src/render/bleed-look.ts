// How a bleeding body is drawn (see `bleed` in effects.ts): drops of blood fall from it, a few at a time, each from somewhere on the body to its feet, fading as it lands and then
// starting again from another place, and the figure flushes red and pales again over and over. Both are worked out from the time alone (and the character, so two that bleed side
// by side do not drip in step), with nothing kept from one frame to the next.

export type BleedDrop = {
  // Where the drop is, from the body's middle, in world units.
  x: number
  y: number
  // How big its round end is, in world units, and how much of it shows: all of it as it falls, fading to nothing as it lands.
  size: number
  alpha: number
}

// How many drops fall at a time, and how long each takes to fall, in milliseconds. Each starts a share of that after the one before it.
export const BLEED_DROPS = 4
export const BLEED_DROP_MS = 750
// How long the figure takes to flush red and pale again, in milliseconds, and the red it flushes to at its reddest.
export const BLEED_PULSE_MS = 900
export const BLEED_TINT = { r: 255, g: 120, b: 120 }

// The share of a fall after which a drop has landed, and fades.
const LANDS_AT = 0.7

// A number from 0 up to (not including) 1 that looks random but is the same for the same three whole numbers: where a drop starts, for a character, a drop and one of its falls (and
// where a spore goes: see spore-look.ts).
export function scatter(a: number, b: number, c: number): number {
  let hash = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177)
  hash = Math.imul(hash ^ (hash >>> 13), 1103515245)
  hash ^= hash >>> 16
  return (hash >>> 0) / 4294967296
}

// The drops on a body of radius `radius` that is bleeding, at `timeMs`. `seed` tells one body's drops from another's (its character's id).
export function layoutBleedDrops(seed: number, timeMs: number, radius: number): BleedDrop[] {
  const drops: BleedDrop[] = []
  for (let index = 0; index < BLEED_DROPS; index += 1) {
    const run = timeMs / BLEED_DROP_MS + index / BLEED_DROPS
    const fall = Math.floor(run)
    const through = run - fall
    // Each fall starts from a place of its own on the body: across the middle of it, and from its chest down to its waist.
    const x = (scatter(seed, index, fall) * 2 - 1) * radius * 0.55
    const from = -radius * 0.5 + scatter(seed, index + BLEED_DROPS, fall) * radius * 0.6
    const to = radius * 0.95
    // It falls faster as it goes, as a drop does, and lands at the body's feet.
    const falling = Math.min(1, through / LANDS_AT)
    drops.push({
      x,
      y: from + (to - from) * falling * falling,
      size: Math.max(2, radius * 0.14),
      alpha: through < LANDS_AT ? 1 : (1 - through) / (1 - LANDS_AT),
    })
  }
  return drops
}

// The tint a bleeding figure is drawn with at `timeMs`, as a colour number (0xRRGGBB): white (as it is) at the palest, and `BLEED_TINT` at the reddest.
export function bleedTint(timeMs: number): number {
  const red = 0.5 - 0.5 * Math.cos(2 * Math.PI * timeMs / BLEED_PULSE_MS)
  const channel = (to: number): number => Math.round(255 + (to - 255) * red)
  return (channel(BLEED_TINT.r) << 16) | (channel(BLEED_TINT.g) << 8) | channel(BLEED_TINT.b)
}
