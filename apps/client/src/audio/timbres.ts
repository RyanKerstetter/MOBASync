import { crackle, noise, tone, type Voice } from './sound-engine.ts'

// Sounds of materials, shared by the attacks and the abilities. Each is built the way the real thing sounds rather than from pure
// tones, which ring like a pipe or a bell:
//   - metal: a click, then narrow bands of noise at inharmonic pitches dying away (a struck blade, a clink);
//   - wood: a hard crack, then the short hollow knock of the wood's body, splinters, and a thump under it for something big;
//   - water: a slap, the body of a splash and its spray, with droplets as soft ticks of noise, not bloops;
//   - straining wood: a narrow squeal sliding in pitch, with the crackle of fibres giving;
//   - curses: a breath of whispering noise, and a low thrum felt more than heard.

// The pitches a struck piece of steel rings at, against its lowest: inharmonic, so it reads as metal and not as a note.
const STEEL = [1, 1.47, 2.03, 2.69] as const

// Struck metal. `pitch` is its lowest ring (a blade about 2600, a chain link higher, a heavy plate lower); `ring` how long it rings.
export function metalHit(v: Voice, o: { gain: number; pitch?: number; ring?: number; delay?: number }): void {
  const pitch = o.pitch ?? 2600
  const ring = o.ring ?? 0.25
  const delay = o.delay ?? 0
  noise(v, { dur: 0.012, gain: o.gain * 1.4, filter: 'highpass', freq: 3500, attack: 0.0005, delay })
  STEEL.forEach((ratio, index) => noise(v, {
    dur: ring * (1 - index * 0.17),
    gain: o.gain * (index === 0 ? 1.6 : 1.1) / (1 + index * 0.4),
    filter: 'bandpass',
    freq: pitch * ratio,
    q: 28,
    attack: 0.001,
    delay,
  }))
}

// Struck wood. `size` is how big the wood is: 1 a stick, 0.6 a branch, 0.4 a trunk (lower and longer); `gain` how hard.
export function woodHit(v: Voice, o: { gain: number; size?: number; splinters?: boolean; delay?: number }): void {
  const size = o.size ?? 1
  const delay = o.delay ?? 0
  // The crack.
  noise(v, { dur: 0.018, gain: o.gain * 1.3, filter: 'highpass', freq: 1800, attack: 0.0005, delay })
  // The wood's hollow knock: a few resonant bands, short.
  for (const [ratio, length] of [[1, 0.13], [2.3, 0.08], [4.1, 0.05]] as const) {
    noise(v, { dur: length / Math.sqrt(size), gain: o.gain * 1.2 / ratio ** 0.5, filter: 'bandpass', freq: 520 * size * ratio, q: 9, attack: 0.0008, delay })
  }
  tone(v, { type: 'triangle', freq: 900 * size, freqEnd: 760 * size, dur: 0.04, gain: o.gain * 0.25, delay })
  // Something heavy lands with weight.
  if (size < 0.8) tone(v, { type: 'sine', freq: 150 * size + 40, freqEnd: 45, dur: 0.18, gain: o.gain * (0.9 - size * 0.5), delay })
  if (o.splinters) crackle(v, { count: 8, dur: 0.14, gain: o.gain * 0.22, freq: 2200, delay: delay + 0.01 })
}

// A splash of water: the slap of it, the body of the splash, the spray, and droplets pattering.
export function waterSplash(v: Voice, o: { gain: number; size?: number; delay?: number }): void {
  const size = o.size ?? 1
  const delay = o.delay ?? 0
  noise(v, { dur: 0.05, gain: o.gain * 0.8, filter: 'lowpass', freq: 900 / size, attack: 0.001, delay })
  noise(v, { dur: 0.28 * size, gain: o.gain, filter: 'bandpass', freq: 1100 / size, freqEnd: 420 / size, q: 0.7, attack: 0.008, delay })
  noise(v, { dur: 0.36 * size, gain: o.gain * 0.45, filter: 'highpass', freq: 3500, attack: 0.03, delay })
  crackle(v, { count: Math.round(7 * size), dur: 0.3 * size, gain: o.gain * 0.12, freq: 2600, delay: delay + 0.06 })
}

// Wood straining: a narrow squeal sliding up, and fibres crackling as they give. `dur` is how long it strains.
export function woodStrain(v: Voice, o: { gain: number; dur: number; delay?: number }): void {
  const delay = o.delay ?? 0
  noise(v, { dur: o.dur, gain: o.gain * 0.9, filter: 'bandpass', freq: 380, freqEnd: 560, q: 16, attack: o.dur * 0.3, delay })
  noise(v, { dur: o.dur * 0.8, gain: o.gain * 0.4, filter: 'bandpass', freq: 900, freqEnd: 1250, q: 14, attack: o.dur * 0.3, delay })
  crackle(v, { count: Math.round(o.dur * 30), dur: o.dur, gain: o.gain * 0.3, freq: 1100, delay })
}

// A ghostly breath: a band of noise drifting from one pitch to another. Narrow (`q` high) it whistles like wind; wide it hisses.
export function whisper(v: Voice, o: { from: number; to: number; dur: number; gain: number; q?: number; delay?: number }): void {
  noise(v, { dur: o.dur, gain: o.gain, filter: 'bandpass', freq: o.from, freqEnd: o.to, q: o.q ?? 5, attack: o.dur * 0.35, ...(o.delay === undefined ? {} : { delay: o.delay }) })
}

// A low thrum of dark power, swelling and fading: a sub-bass note with a soft, darker octave over it.
export function thrum(v: Voice, o: { freq: number; dur: number; gain: number; delay?: number }): void {
  const delay = o.delay ?? 0
  tone(v, { type: 'sine', freq: o.freq, freqEnd: o.freq * 0.85, dur: o.dur, gain: o.gain, attack: o.dur * 0.3, delay })
  tone(v, { type: 'triangle', freq: o.freq * 2, freqEnd: o.freq * 1.7, dur: o.dur * 0.8, gain: o.gain * 0.3, lowpass: 500, attack: o.dur * 0.3, delay })
}

// A hiss like something burning cold, falling.
export const sizzle = (v: Voice, o: { dur: number; gain: number; delay?: number }): void =>
  noise(v, { dur: o.dur, gain: o.gain, filter: 'highpass', freq: 6000, freqEnd: 2200, attack: 0.004, ...(o.delay === undefined ? {} : { delay: o.delay }) })
