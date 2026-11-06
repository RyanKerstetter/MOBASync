import { scatter } from './bleed-look.ts'

// How a body carrying an Ent's spore is drawn (see `spore` in effects.ts): spores puff off it, a few at a time, each drifting away from the body and up from somewhere round it, growing
// as it goes and fading in and out, and then starting again from another place. It is worked out from the time alone (and the character, so two that are spored side by side do not puff
// in step), with nothing kept from one frame to the next.

export type SporeMote = {
  // Where the spore is, from the body's middle, in world units, how big it is, and how much of it shows.
  x: number
  y: number
  size: number
  alpha: number
}

// How many spores are out at a time, and how long each drifts for, in milliseconds. Each starts a share of that after the one before it.
export const SPORE_MOTES = 5
export const SPORE_DRIFT_MS = 1400
// The colours: a pale yellow-green, edged darker.
export const SPORE_COLOR = '#c8e66a'
export const SPORE_EDGE = '#5e7a1f'

// The spores on a body of radius `radius` that carries a spore, at `timeMs`. `seed` tells one body's spores from another's (its character's id).
export function layoutSpores(seed: number, timeMs: number, radius: number): SporeMote[] {
  const motes: SporeMote[] = []
  for (let index = 0; index < SPORE_MOTES; index += 1) {
    const run = timeMs / SPORE_DRIFT_MS + index / SPORE_MOTES
    const drift = Math.floor(run)
    const through = run - drift
    // Each drift sets off from the body's edge, in a way of its own, and goes out from it and up.
    const angle = 2 * Math.PI * scatter(seed, index, drift)
    const out = radius * (0.5 + 0.6 * through)
    motes.push({
      x: Math.cos(angle) * out,
      y: Math.sin(angle) * out * 0.6 - through * radius * 0.7,
      size: 1.5 + through * 2,
      alpha: Math.sin(Math.PI * through) * 0.9,
    })
  }
  return motes
}
