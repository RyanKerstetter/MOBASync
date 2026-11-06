// How a champion going back is drawn (Back, which channels before it takes the champion to its spawn: see `BACK_ABILITY_ID`), so that everyone who can see it knows it is going and
// how long it has left. A ring lies round its feet, and its bright arc goes round from the top as the channel runs, closing as it is done, over a glow on the ground that grows as it
// nears the end; and motes of light rise from its feet past its head, turning round it, brighter as it nears the end. All of it is worked out from how far through the channel it is
// and the time alone, with nothing kept from one frame to the next.

export type BackLook = {
  // The ring round the body, from its middle, in world units, and how far round its bright arc has gone, in radians clockwise from the top: none as the channel starts, and a whole
  // turn when it is done.
  ringRadius: number
  sweep: number
  // How strongly the ground inside the ring glows, from 0 to 1.
  glowAlpha: number
  // Where each mote is, from the body's middle, how big it is and how much of it shows.
  motes: Array<{ x: number; y: number; size: number; alpha: number }>
}

// How many motes there are, how long each takes to rise, in milliseconds, and how fast they turn round the body, in turns a second.
export const BACK_MOTES = 6
export const BACK_MOTE_MS = 1100
export const BACK_MOTE_TURNS_PER_SECOND = 0.35
// The colours: the ring and the glow, and the bright arc and the motes.
export const BACK_COLOR = '#6cc7ff'
export const BACK_BRIGHT = '#e8f8ff'

// The share of `value` past the last whole number, from 0 up to (not including) 1, for a time before 0 too.
const wrap = (value: number): number => value - Math.floor(value)

// The look of a body of radius `radius` that is `progress` of the way through going back (0 as it starts, 1 as it is taken home), at `timeMs`.
export function layoutBack(progress: number, timeMs: number, radius: number): BackLook {
  const done = Math.min(1, Math.max(0, progress))
  const motes: BackLook['motes'] = []
  for (let index = 0; index < BACK_MOTES; index += 1) {
    const rise = wrap(timeMs / BACK_MOTE_MS + index / BACK_MOTES)
    const angle = 2 * Math.PI * (index / BACK_MOTES + timeMs / 1000 * BACK_MOTE_TURNS_PER_SECOND)
    motes.push({
      x: Math.cos(angle) * radius * 0.85,
      // From its feet up past its head.
      y: radius * 0.8 - rise * radius * 2.6,
      size: 2 + done * 1.5,
      // Fading in as it leaves the ground and out as it goes up.
      alpha: Math.sin(Math.PI * rise) * (0.35 + 0.65 * done),
    })
  }
  return { ringRadius: radius + 10, sweep: done * 2 * Math.PI, glowAlpha: 0.08 + 0.22 * done, motes }
}
