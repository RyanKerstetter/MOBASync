import { crackle, noise, swish, tone, type Recipe, type Voice } from './sound-engine.ts'
import { metalHit, sizzle, thrum, waterSplash, whisper, woodHit, woodStrain } from './timbres.ts'

// The sound of each ability as it goes off (`ABILITY_SOUNDS`, by ability id), of what some of them leave in the world when it comes to
// something later (`ENTITY_SOUNDS`, by entity definition id: a grenade bursting where it lands, a geyser erupting after its warning, a
// shuriken striking), and of going back home (`BACK_SOUNDS`). An entity that comes at the moment its ability goes off (Radiance's
// burst, Slam's crater) has no sound of its own: the ability's is it.

// ---------------------------------------------------------------------------------------------- pieces

// A boom: a low tone falling away under a roar of low noise.
function boom(v: Voice, o: { gain: number; low?: number; dur?: number; delay?: number }): void {
  const low = o.low ?? 90
  const dur = o.dur ?? 0.4
  const delay = o.delay ?? 0
  tone(v, { type: 'sine', freq: low, freqEnd: low * 0.38, dur, gain: o.gain, delay })
  noise(v, { dur: dur * 0.9, gain: o.gain * 0.7, filter: 'lowpass', freq: 1200, freqEnd: 120, attack: 0.003, delay })
}

// An explosion: a boom, a crack and debris falling.
function explosion(v: Voice, o: { gain: number; dur?: number; delay?: number }): void {
  const dur = o.dur ?? 0.55
  const delay = o.delay ?? 0
  boom(v, { gain: o.gain, low: 75, dur, delay })
  noise(v, { dur: dur * 0.6, gain: o.gain * 0.9, filter: 'lowpass', freq: 3500, freqEnd: 200, attack: 0.002, delay })
  crackle(v, { count: 10, dur: dur * 0.8, gain: o.gain * 0.18, freq: 2400, delay: delay + 0.04 })
}

// Notes sounded together, or one after another when `stagger` is given.
function chord(v: Voice, o: { freqs: readonly number[]; dur: number; gain: number; stagger?: number; type?: OscillatorType; attack?: number; delay?: number }): void {
  o.freqs.forEach((freq, index) => tone(v, {
    type: o.type ?? 'sine',
    freq,
    dur: o.dur,
    gain: o.gain / Math.sqrt(o.freqs.length),
    attack: o.attack ?? 0.01,
    delay: (o.delay ?? 0) + index * (o.stagger ?? 0),
  }))
}

// Glints of light: short high notes scattered over `dur`.
function sparkle(v: Voice, o: { count: number; dur: number; gain: number; delay?: number }): void {
  for (let index = 0; index < o.count; index += 1) {
    tone(v, { type: 'sine', freq: 2500 + Math.random() * 3500, dur: 0.07, gain: o.gain, delay: (o.delay ?? 0) + Math.random() * o.dur })
  }
}

// A body dashing: a rush of air rising past, with a low push under it.
function dash(v: Voice, o: { gain: number; dark?: boolean; delay?: number }): void {
  const delay = o.delay ?? 0
  swish(v, { low: o.dark ? 220 : 320, high: o.dark ? 1600 : 2800, dur: 0.24, gain: o.gain, delay })
  tone(v, { type: 'sine', freq: 140, freqEnd: 70, dur: 0.16, gain: o.gain * 0.35, delay })
}

// Something thrown or lobbed: an arm's swish.
const throwing = (v: Voice, gain = 0.4, delay = 0): void => swish(v, { low: 500, high: 1600, dur: 0.17, gain, delay })

// A small bright clink of metal or glass.
const clink = (v: Voice, o: { freq: number; gain: number; delay?: number }): void =>
  metalHit(v, { gain: o.gain * 0.5, pitch: o.freq, ring: 0.12, ...(o.delay === undefined ? {} : { delay: o.delay }) })

// A swell of two close notes, a hum of power.
function hum(v: Voice, o: { freq: number; dur: number; gain: number; delay?: number }): void {
  tone(v, { type: 'sine', freq: o.freq, dur: o.dur, gain: o.gain, attack: o.dur * 0.35, delay: o.delay ?? 0 })
  tone(v, { type: 'sine', freq: o.freq * 1.5 + 2, dur: o.dur, gain: o.gain * 0.5, attack: o.dur * 0.35, delay: o.delay ?? 0 })
}

// Two beats of a heart.
function heartbeat(v: Voice, gain: number, delay = 0): void {
  tone(v, { type: 'sine', freq: 70, freqEnd: 45, dur: 0.12, gain, delay })
  tone(v, { type: 'sine', freq: 65, freqEnd: 42, dur: 0.14, gain: gain * 0.8, delay: delay + 0.18 })
}

// Water: a splash.
const splash = (v: Voice, gain: number, delay = 0): void => waterSplash(v, { gain, delay })

// Fire taking hold: a roar that swells, crackling.
function fireRoar(v: Voice, o: { gain: number; dur: number; delay?: number }): void {
  noise(v, { dur: o.dur, gain: o.gain, filter: 'lowpass', freq: 300, freqEnd: 1700, attack: o.dur * 0.3, delay: o.delay ?? 0 })
  crackle(v, { count: Math.round(o.dur * 26), dur: o.dur, gain: o.gain * 0.2, freq: 2800, delay: o.delay ?? 0 })
}

// A chain's links rattling.
const rattle = (v: Voice, o: { dur: number; gain: number; delay?: number }): void => crackle(v, { count: Math.round(o.dur * 45), dur: o.dur, gain: o.gain, freq: 4300, ...(o.delay === undefined ? {} : { delay: o.delay }) })

// Wood straining and cracking, as roots and branches move.
const creak = (v: Voice, o: { gain: number; dur: number; delay?: number }): void => woodStrain(v, o)

// Leaves rustling.
const rustle = (v: Voice, o: { gain: number; dur: number; delay?: number }): void => noise(v, { dur: o.dur, gain: o.gain, filter: 'highpass', freq: 4500, attack: o.dur * 0.3, ...(o.delay === undefined ? {} : { delay: o.delay }) })

// A blade biting: a slice, and a thump under it.
function slice(v: Voice, gain: number, delay = 0): void {
  noise(v, { dur: 0.07, gain, filter: 'highpass', freq: 2400, freqEnd: 1600, delay })
  tone(v, { type: 'sine', freq: 190, freqEnd: 80, dur: 0.08, gain: gain * 0.7, delay })
}

// A sharp bang with a ring left in the ears.
function bang(v: Voice, gain: number): void {
  noise(v, { dur: 0.09, gain, filter: 'highpass', freq: 1500, attack: 0.001 })
  boom(v, { gain: gain * 0.6, low: 110, dur: 0.25 })
  tone(v, { type: 'sine', freq: 3600, dur: 0.7, gain: gain * 0.08, attack: 0.02 })
}

// ---------------------------------------------------------------------------------------------- abilities

export const ABILITY_SOUNDS: Readonly<Record<string, Recipe>> = {
  // ---- Cursebearer
  // Feast: the curses drawn out of the target on a rising breath, and swallowed with a dull blow.
  feast: (v) => {
    whisper(v, { from: 300, to: 1300, dur: 0.3, gain: 0.35 })
    thrum(v, { freq: 70, dur: 0.4, gain: 0.14 })
    tone(v, { type: 'sine', freq: 140, freqEnd: 55, dur: 0.14, gain: 0.28, delay: 0.24 })
    sizzle(v, { dur: 0.18, gain: 0.1, delay: 0.24 })
  },
  // Miasma: a foul cloud breathing out, hissing, over a low thrum.
  miasma: (v) => {
    whisper(v, { from: 700, to: 420, dur: 0.75, gain: 0.32, q: 1.5 })
    whisper(v, { from: 1800, to: 1200, dur: 0.6, gain: 0.08, q: 8, delay: 0.1 })
    thrum(v, { freq: 62, dur: 0.75, gain: 0.11 })
  },
  // Hex: a curse hurled on a sharp breath, with a cold hiss.
  hex: (v) => {
    whisper(v, { from: 420, to: 1500, dur: 0.24, gain: 0.38 })
    thrum(v, { freq: 98, dur: 0.28, gain: 0.12 })
    sizzle(v, { dur: 0.16, gain: 0.08, delay: 0.06 })
  },

  // ---- Archer
  // Leap: a light spring away.
  leap: (v) => dash(v, { gain: 0.5 }),
  // Focus: the bowstring drawn taut, and a rising note of concentration.
  focus: (v) => {
    tone(v, { type: 'triangle', freq: 210, freqEnd: 250, dur: 0.35, gain: 0.18, vibrato: { rate: 9, depth: 4 } })
    tone(v, { type: 'sine', freq: 660, freqEnd: 990, dur: 0.35, gain: 0.08, attack: 0.1 })
  },
  // Snare: a canister lobbed with a pop.
  snare: (v) => {
    throwing(v, 0.5)
    tone(v, { type: 'sine', freq: 420, freqEnd: 200, dur: 0.06, gain: 0.4 })
  },

  // ---- Swordsman
  // Slash: a great cut through the air, its edge ringing.
  slash: (v) => {
    swish(v, { low: 300, high: 3200, dur: 0.3, gain: 0.75 })
    noise(v, { dur: 0.22, gain: 0.08, filter: 'highpass', freq: 6000, attack: 0.08, delay: 0.05 })
  },
  // Radiance: a burst of holy light, a bright chord over a thump, glittering.
  radiance: (v) => {
    chord(v, { freqs: [523, 659, 784, 1046], dur: 0.7, gain: 0.28, attack: 0.015 })
    boom(v, { gain: 0.5, low: 120, dur: 0.3 })
    sparkle(v, { count: 8, dur: 0.5, gain: 0.05 })
  },
  // Shackle: chains readied, and a blade's ring.
  shackle: (v) => {
    rattle(v, { dur: 0.18, gain: 0.28 })
    metalHit(v, { gain: 0.2, pitch: 2300, ring: 0.3, delay: 0.06 })
  },

  // ---- Capricorn
  // Tsunami: a wave rising and rolling out, roaring.
  tsunami: (v) => {
    noise(v, { dur: 0.7, gain: 0.55, filter: 'lowpass', freq: 300, freqEnd: 1600, attack: 0.25 })
    splash(v, 0.4, 0.3)
  },
  // Bubbles: three bubbles blown out, one after another.
  bubbles: (v) => {
    for (const delay of [0, 0.07, 0.14]) tone(v, { type: 'sine', freq: 300, freqEnd: 820, dur: 0.07, gain: 0.25, delay })
  },
  // Spout: water gurgling up under the ground (it erupts later: see `spout-burst`).
  spout: (v) => {
    for (const delay of [0, 0.08, 0.16, 0.24]) tone(v, { type: 'sine', freq: 180 + Math.random() * 80, freqEnd: 420, dur: 0.09, gain: 0.16, delay })
  },

  // ---- Soldier
  // Stim: a needle's hiss, the heart pounding, and the rush coming on.
  stim: (v) => {
    noise(v, { dur: 0.15, gain: 0.25, filter: 'highpass', freq: 5000 })
    heartbeat(v, 0.32, 0.08)
    tone(v, { type: 'sawtooth', freq: 220, freqEnd: 660, dur: 0.4, gain: 0.07, lowpass: 2000, delay: 0.05 })
  },
  // Bolt: a heavy energy shot, whining down, crackling.
  bolt: (v) => {
    tone(v, { type: 'sawtooth', freq: 900, freqEnd: 180, dur: 0.25, gain: 0.35, lowpass: 3000 })
    noise(v, { dur: 0.1, gain: 0.7, filter: 'lowpass', freq: 5000, freqEnd: 800, attack: 0.001 })
    crackle(v, { count: 6, dur: 0.2, gain: 0.1, freq: 3500 })
  },
  // Medic: a little bot whirring awake, beeping, its shield humming.
  medic: (v) => {
    for (const [index, freq] of [880, 1320, 1760].entries()) tone(v, { type: 'square', freq, dur: 0.06, gain: 0.06, lowpass: 3000, delay: index * 0.08 })
    hum(v, { freq: 220, dur: 0.5, gain: 0.12, delay: 0.1 })
  },

  // ---- Grenadier
  // Grenade: the pin pulled and the grenade lobbed (it bursts where it lands: see `grenade-burst`).
  grenade: (v) => {
    clink(v, { freq: 2400, gain: 0.2 })
    throwing(v, 0.45, 0.05)
  },
  // Molotov: a bottle lobbed, sloshing.
  molotov: (v) => {
    throwing(v, 0.55)
    noise(v, { dur: 0.2, gain: 0.2, filter: 'bandpass', freq: 700, q: 2, delay: 0.04 })
  },
  // Flashbang: the pin pulled and a canister lobbed.
  flashbang: (v) => {
    clink(v, { freq: 2800, gain: 0.2 })
    throwing(v, 0.45, 0.05)
  },

  // ---- Trinketmaster
  // Stick: a stick thrown spinning, its trinkets jingling.
  stick: (v) => {
    throwing(v, 0.45)
    for (let index = 0; index < 4; index += 1) clink(v, { freq: 3000 + Math.random() * 1800, gain: 0.07, delay: Math.random() * 0.15 })
  },
  // Recall: a whistle calling the stick back.
  recall: (v) => tone(v, { type: 'sine', freq: 1400, freqEnd: 2200, dur: 0.22, gain: 0.25, vibrato: { rate: 12, depth: 30 } }),
  // Hush: a "shh".
  hush: (v) => noise(v, { dur: 0.45, gain: 0.35, filter: 'bandpass', freq: 3800, q: 1.4, attack: 0.12 }),
  // Warp: a blink from one place to another, a sweep and a glint.
  warp: (v) => {
    tone(v, { type: 'sine', freq: 300, freqEnd: 1600, dur: 0.18, gain: 0.2 })
    tone(v, { type: 'sine', freq: 1600, freqEnd: 400, dur: 0.18, gain: 0.16, delay: 0.16 })
    sparkle(v, { count: 5, dur: 0.3, gain: 0.05 })
  },

  // ---- Ninja
  // Shadow Step: a dark rush through the enemy, cutting.
  shadowstep: (v) => {
    dash(v, { gain: 0.4, dark: true })
    slice(v, 0.28, 0.1)
  },
  // Shadow Return: the rush back, the sweep falling.
  shadowreturn: (v) => swish(v, { low: 2600, high: 300, dur: 0.25, gain: 0.45 }),
  // Shuriken: a star thrown whirring.
  shuriken: (v) => {
    for (const delay of [0, 0.045, 0.09, 0.135]) swish(v, { low: 2200, high: 4200, dur: 0.05, gain: 0.32, delay })
  },
  // Dodge: a nimble twist out of the way, with a shimmer.
  dodge: (v) => {
    swish(v, { low: 900, high: 3000, dur: 0.14, gain: 0.5 })
    sparkle(v, { count: 3, dur: 0.15, gain: 0.06, delay: 0.05 })
  },

  // ---- Hammer
  // Slam: the hammer smashing the ground, rock cracking.
  slam: (v) => {
    boom(v, { gain: 0.95, low: 100, dur: 0.45 })
    crackle(v, { count: 12, dur: 0.35, gain: 0.16, freq: 1300, delay: 0.03 })
  },
  // Hammer Drop: a leap up into the air (the landing is `hammerdrop-burst`).
  hammerdrop: (v) => {
    swish(v, { low: 200, high: 1200, dur: 0.35, gain: 0.55 })
    tone(v, { type: 'sine', freq: 120, freqEnd: 60, dur: 0.15, gain: 0.4 })
  },
  // Rage: a berserker's roar.
  rage: (v) => {
    tone(v, { type: 'sawtooth', freq: 115, freqEnd: 92, dur: 0.6, gain: 0.32, lowpass: 950, vibrato: { rate: 24, depth: 8 }, attack: 0.04 })
    noise(v, { dur: 0.55, gain: 0.2, filter: 'bandpass', freq: 600, q: 1.5, attack: 0.06 })
  },

  // ---- Chain
  // Hook: a chain flung out, rattling.
  hook: (v) => {
    rattle(v, { dur: 0.25, gain: 0.28 })
    swish(v, { low: 600, high: 2600, dur: 0.2, gain: 0.5 })
  },
  // Whirl: the chains spinning up round him, faster and faster.
  whirl: (v) => {
    for (let index = 0; index < 6; index += 1) swish(v, { low: 500 + index * 120, high: 1600 + index * 300, dur: 0.11, gain: 0.18 + index * 0.04, delay: index * 0.1 })
    rattle(v, { dur: 0.6, gain: 0.12 })
  },
  // Lunge: a short dash forward.
  lunge: (v) => dash(v, { gain: 0.42 }),

  // ---- Cloak
  // Ghost: fading from sight, the air drawing in, low.
  ghost: (v) => {
    swish(v, { low: 2400, high: 400, dur: 0.45, gain: 0.4 })
    tone(v, { type: 'sine', freq: 180, freqEnd: 90, dur: 0.45, gain: 0.18, attack: 0.1 })
  },
  // Knives: a fan of knives thrown at once.
  knives: (v) => {
    for (const delay of [0, 0.03, 0.06]) swish(v, { low: 1600, high: 4200, dur: 0.08, gain: 0.32, delay })
  },
  // Cut Through: a dash through the enemy, cutting.
  cutthrough: (v) => {
    dash(v, { gain: 0.38, dark: true })
    slice(v, 0.3, 0.08)
  },

  // ---- Sage
  // Heal Pulse: a warm swell rolling out.
  pulse: (v) => {
    chord(v, { freqs: [392, 494, 587], dur: 0.6, gain: 0.25, attack: 0.08 })
    swish(v, { low: 300, high: 1500, dur: 0.4, gain: 0.3 })
  },
  // Vine Bolt: a vine whipped out, creaking.
  vinebolt: (v) => {
    swish(v, { low: 400, high: 2000, dur: 0.2, gain: 0.4 })
    creak(v, { gain: 0.55, dur: 0.25 })
  },
  // Rejuvenate: a rising run of healing notes, glittering.
  rejuvenate: (v) => {
    chord(v, { freqs: [523, 659, 784, 1046], dur: 0.45, gain: 0.3, stagger: 0.07 })
    sparkle(v, { count: 6, dur: 0.5, gain: 0.04, delay: 0.15 })
    rustle(v, { gain: 0.06, dur: 0.4 })
  },

  // ---- Monk
  // Link: a bond of light between two, humming.
  link: (v) => {
    hum(v, { freq: 330, dur: 0.6, gain: 0.12 })
    tone(v, { type: 'sine', freq: 1320, dur: 0.4, gain: 0.05, delay: 0.1 })
  },
  // Link heal: a soft chime.
  linkheal: (v) => chord(v, { freqs: [660, 880], dur: 0.4, gain: 0.18, stagger: 0.06 }),
  // Flurry: hands blurring, and a hum of inner power.
  flurry: (v) => {
    for (const delay of [0, 0.05, 0.1]) swish(v, { low: 700, high: 2200, dur: 0.07, gain: 0.3, delay })
    hum(v, { freq: 196, dur: 0.4, gain: 0.12 })
  },
  // Guard: a shield shimmering up, over a low hum.
  guard: (v) => {
    tone(v, { type: 'sine', freq: 1200, freqEnd: 1800, dur: 0.35, gain: 0.08, vibrato: { rate: 18, depth: 40 } })
    hum(v, { freq: 147, dur: 0.5, gain: 0.13 })
  },

  // ---- Fire Mage
  // Fireball: a fireball hurled with a roar (it bursts as `fireball-flash`).
  fireball: (v) => fireRoar(v, { gain: 0.6, dur: 0.35 }),
  // Detonate: the fireball told to burst, a snap of the fingers.
  detonate: (v) => {
    noise(v, { dur: 0.04, gain: 0.6, filter: 'bandpass', freq: 2500, q: 2 })
    tone(v, { type: 'sine', freq: 900, freqEnd: 400, dur: 0.05, gain: 0.2 })
  },
  // Fire Tornado: a spark struck where it will rise (the tornado is `firetornado-funnel`).
  firetornado: (v) => {
    crackle(v, { count: 10, dur: 0.25, gain: 0.4, freq: 3000 })
    noise(v, { dur: 0.25, gain: 0.25, filter: 'lowpass', freq: 500, freqEnd: 1200, attack: 0.08 })
  },
  // Scorch: fire rolling along the ground.
  scorch: (v) => fireRoar(v, { gain: 0.6, dur: 0.6 }),

  // ---- Aurel
  // Rend: claws tearing, and blood.
  rend: (v) => {
    for (const delay of [0, 0.03, 0.06]) noise(v, { dur: 0.07, gain: 0.55, filter: 'bandpass', freq: 2400, freqEnd: 1000, q: 2, delay })
    noise(v, { dur: 0.16, gain: 0.45, filter: 'lowpass', freq: 500, delay: 0.04 })
    tone(v, { type: 'sine', freq: 180, freqEnd: 75, dur: 0.1, gain: 0.35, delay: 0.03 })
  },
  // Transfusion: blood drawn back in, swirling, and a heartbeat.
  transfusion: (v) => {
    swish(v, { low: 2000, high: 400, dur: 0.5, gain: 0.35 })
    heartbeat(v, 0.3, 0.1)
    tone(v, { type: 'sine', freq: 220, dur: 0.6, gain: 0.08, attack: 0.2 })
  },
  // Bloodrush: a rush onto the prey, and a strike.
  bloodrush: (v) => {
    dash(v, { gain: 0.4, dark: true })
    slice(v, 0.28, 0.12)
  },

  // ---- Ent
  // Root Burst: a limb driven into the ground, and the earth cracking (the roots break out as `rootburst-roots`).
  rootburst: (v) => {
    woodHit(v, { gain: 0.45, size: 0.55 })
    crackle(v, { count: 8, dur: 0.25, gain: 0.12, freq: 900, delay: 0.05 })
  },
  // Grove: wood groaning deep as the grove takes root (it grows as `grove`).
  grove: (v) => {
    creak(v, { gain: 0.3, dur: 0.5 })
    woodHit(v, { gain: 0.35, size: 0.45, delay: 0.32 })
  },
  // Spore: a hard strike of wood, and a puff of spores.
  spore: (v) => {
    woodHit(v, { gain: 0.6, size: 0.6 })
    noise(v, { dur: 0.3, gain: 0.25, filter: 'lowpass', freq: 900, attack: 0.04, delay: 0.06 })
  },

  // ---- Monsters
  // A golem's slam.
  'monster-slam': (v) => {
    boom(v, { gain: 1, low: 80, dur: 0.55 })
    crackle(v, { count: 14, dur: 0.45, gain: 0.16, freq: 1100, delay: 0.04 })
  },
}

// Back has its own sounds: a hum as the channel begins, and a rush as the champion is taken home.
export const BACK_SOUNDS: { start: Recipe; arrive: Recipe } = {
  start: (v) => {
    hum(v, { freq: 262, dur: 0.8, gain: 0.12 })
    sparkle(v, { count: 4, dur: 0.6, gain: 0.03, delay: 0.2 })
  },
  arrive: (v) => {
    tone(v, { type: 'sine', freq: 400, freqEnd: 1600, dur: 0.3, gain: 0.18 })
    swish(v, { low: 600, high: 3500, dur: 0.35, gain: 0.3 })
    sparkle(v, { count: 6, dur: 0.4, gain: 0.05, delay: 0.1 })
  },
}

// ---------------------------------------------------------------------------------------------- what abilities leave

// `spawn` plays as the entity appears (only one that appears later than its ability goes off has one), `hit` as it strikes someone.
export const ENTITY_SOUNDS: Readonly<Record<string, { spawn?: Recipe; hit?: Recipe }>> = {
  // A hex sinking into its victim.
  hex: { hit: (v) => {
    tone(v, { type: 'sine', freq: 160, freqEnd: 55, dur: 0.16, gain: 0.5 })
    sizzle(v, { dur: 0.28, gain: 0.2 })
    whisper(v, { from: 900, to: 300, dur: 0.26, gain: 0.25 })
  } },
  // A trap springing shut where the canister lands.
  'snare-field': {
    spawn: (v) => {
      clink(v, { freq: 1500, gain: 0.45 })
      tone(v, { type: 'triangle', freq: 300, freqEnd: 160, dur: 0.25, gain: 0.22, vibrato: { rate: 20, depth: 25 } })
    },
  },
  // A bubble popping on whoever it hits.
  bubble: { hit: (v) => {
    splash(v, 0.55)
  } },
  // The geyser bursting up after its warning.
  'spout-burst': { spawn: (v) => {
    noise(v, { dur: 0.55, gain: 0.6, filter: 'bandpass', freq: 400, freqEnd: 2200, q: 0.7, attack: 0.02 })
    splash(v, 0.45, 0.15)
  } },
  // The Soldier's bolt striking each enemy it passes through.
  bolt: { hit: (v) => {
    noise(v, { dur: 0.05, gain: 0.35, filter: 'bandpass', freq: 2200, q: 1.5 })
    tone(v, { type: 'sine', freq: 220, freqEnd: 80, dur: 0.1, gain: 0.4 })
  } },
  // The grenade bursting where it lands.
  'grenade-burst': { spawn: (v) => explosion(v, { gain: 0.9 }) },
  // The molotov's bottle shattering and the fire going up.
  'molotov-fire': { spawn: (v) => {
    for (let index = 0; index < 5; index += 1) clink(v, { freq: 2500 + Math.random() * 2500, gain: 0.12, delay: Math.random() * 0.06 })
    fireRoar(v, { gain: 0.55, dur: 0.6, delay: 0.03 })
  } },
  // The flashbang going off.
  'flash-burst': { spawn: (v) => bang(v, 0.8) },
  // The stick landing, clattering.
  stick: { spawn: (v) => {
    tone(v, { type: 'triangle', freq: 480, freqEnd: 420, dur: 0.06, gain: 0.3 })
    tone(v, { type: 'triangle', freq: 520, freqEnd: 470, dur: 0.05, gain: 0.2, delay: 0.08 })
    for (let index = 0; index < 3; index += 1) clink(v, { freq: 3200 + Math.random() * 1500, gain: 0.06, delay: Math.random() * 0.12 })
  } },
  // A shuriken thunking home.
  shuriken: { hit: (v) => {
    clink(v, { freq: 2600, gain: 0.25 })
    tone(v, { type: 'sine', freq: 200, freqEnd: 90, dur: 0.07, gain: 0.35 })
  } },
  'shuriken-enhanced': { hit: (v) => {
    clink(v, { freq: 2200, gain: 0.3 })
    tone(v, { type: 'sine', freq: 170, freqEnd: 70, dur: 0.1, gain: 0.45 })
  } },
  // Hammer Drop crashing down.
  'hammerdrop-burst': { spawn: (v) => {
    boom(v, { gain: 1, low: 85, dur: 0.6 })
    crackle(v, { count: 16, dur: 0.5, gain: 0.16, freq: 1200, delay: 0.03 })
  } },
  // The hook catching someone: a clank, and the yank back.
  hook: { hit: (v) => {
    clink(v, { freq: 1700, gain: 0.3 })
    swish(v, { low: 2400, high: 500, dur: 0.22, gain: 0.35, delay: 0.04 })
  } },
  // Whirl lashing out: the chains cracking round him.
  'whirl-burst': { spawn: (v) => {
    noise(v, { dur: 0.08, gain: 0.5, filter: 'highpass', freq: 1800, attack: 0.001 })
    rattle(v, { dur: 0.3, gain: 0.2 })
    swish(v, { low: 400, high: 2600, dur: 0.25, gain: 0.45 })
  } },
  'whirl-core-burst': { spawn: (v) => {
    tone(v, { type: 'sine', freq: 130, freqEnd: 60, dur: 0.2, gain: 0.5 })
    rattle(v, { dur: 0.2, gain: 0.15 })
  } },
  // A knife striking.
  knife: { hit: (v) => slice(v, 0.3) },
  // A vine catching an enemy and rooting it: wood creaking tight, leaves rustling.
  'vine-bolt': { hit: (v) => {
    creak(v, { gain: 0.6, dur: 0.3 })
    rustle(v, { gain: 0.08, dur: 0.25 })
  } },
  // The fireball bursting.
  'fireball-flash': { spawn: (v) => {
    explosion(v, { gain: 0.75, dur: 0.45 })
    crackle(v, { count: 10, dur: 0.5, gain: 0.1, freq: 3000, delay: 0.1 })
  } },
  // The tornado roaring up after its warning.
  'firetornado-funnel': { spawn: (v) => {
    noise(v, { dur: 0.95, gain: 0.55, filter: 'bandpass', freq: 250, freqEnd: 1300, q: 1.1, attack: 0.25 })
    fireRoar(v, { gain: 0.35, dur: 0.9 })
  } },
  // Roots breaking out of the ground: the earth bursting, wood cracking hard, splinters and soil.
  'rootburst-roots': { spawn: (v) => {
    woodHit(v, { gain: 0.8, size: 0.45, splinters: true })
    woodHit(v, { gain: 0.45, size: 0.7, delay: 0.07 })
    noise(v, { dur: 0.3, gain: 0.35, filter: 'lowpass', freq: 700, freqEnd: 150, delay: 0.02 })
    creak(v, { gain: 0.25, dur: 0.3, delay: 0.08 })
  } },
  // The grove growing up out of the ground: a deep swell, wood groaning, leaves, and a soft chime.
  grove: { spawn: (v) => {
    tone(v, { type: 'sine', freq: 65, freqEnd: 90, dur: 0.9, gain: 0.2, attack: 0.3 })
    creak(v, { gain: 0.3, dur: 0.7 })
    for (const delay of [0.05, 0.22, 0.4]) woodHit(v, { gain: 0.28, size: 0.5 + Math.random() * 0.2, splinters: true, delay })
    rustle(v, { gain: 0.12, dur: 0.8, delay: 0.1 })
    chord(v, { freqs: [392, 587], dur: 0.6, gain: 0.1, stagger: 0.12, delay: 0.25 })
  } },
}
