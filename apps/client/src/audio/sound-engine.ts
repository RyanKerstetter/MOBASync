// The game's sounds are made as they are played, with the browser's Web Audio: noise and tones shaped by filters and envelopes, so
// there are no sound files to ship. A sound is a `Recipe`, a function that builds what it needs from the pieces here (`noise`, `tone`,
// `crackle`) into the voice it is given, starting at the voice's time.
//
// The engine has one master volume (the sound menu's), a limiter after it so many sounds at once do not clip, and a cap on how many
// play at once. It does nothing until the browser lets the page make sound, which it does once the player has clicked or pressed a
// key on the page (it has, to get into a game).

// What a recipe builds into: the context, where its sound goes, when it starts, and a random factor near 1 for variety.
export type Voice = {
  ctx: BaseAudioContext
  out: AudioNode
  t: number
  // From about 0.92 to 1.08: a recipe scales its pitches by it, so the same sound twice is not quite the same.
  vary: number
  noiseBuffer: AudioBuffer
}

export type Recipe = (voice: Voice) => void

// How many sounds can play at once, and how long a sound is taken to last when counting them.
const MAX_VOICES = 28
const VOICE_SECONDS = 0.6
// How much the recipes are lifted at full volume. They are made quiet enough that several at once stay clean; the limiter after the
// master catches what a pile of them would push past that.
const OUTPUT_GAIN = 2.2

const SILENT = 0.0001

// A gain that rises to `peak` over `attack` seconds from `t`, then falls away over `decay`, into `out`.
function envelope(voice: Voice, t: number, peak: number, attack: number, decay: number): GainNode {
  const gain = voice.ctx.createGain()
  gain.gain.setValueAtTime(SILENT, t)
  gain.gain.linearRampToValueAtTime(Math.max(peak, SILENT), t + Math.max(attack, 0.001))
  gain.gain.exponentialRampToValueAtTime(SILENT, t + Math.max(attack, 0.001) + Math.max(decay, 0.01))
  gain.connect(voice.out)
  return gain
}

export type NoiseOptions = {
  dur: number
  gain: number
  filter: BiquadFilterType
  freq: number
  // The filter sweeps from `freq` to this over the sound.
  freqEnd?: number
  q?: number
  attack?: number
  delay?: number
}

// A burst of noise through a filter: a whoosh (a band that sweeps), a hiss (high), a thud's body or a rumble (low).
export function noise(voice: Voice, options: NoiseOptions): void {
  const { ctx } = voice
  const t = voice.t + (options.delay ?? 0)
  const attack = options.attack ?? 0.004
  const source = ctx.createBufferSource()
  source.buffer = voice.noiseBuffer
  const filter = ctx.createBiquadFilter()
  filter.type = options.filter
  filter.Q.value = options.q ?? 0.8
  filter.frequency.setValueAtTime(options.freq * voice.vary, t)
  if (options.freqEnd !== undefined) filter.frequency.exponentialRampToValueAtTime(options.freqEnd * voice.vary, t + options.dur)
  source.connect(filter).connect(envelope(voice, t, options.gain, attack, options.dur - attack))
  // From somewhere in the buffer, so two bursts of the same noise are not the same.
  const offset = Math.random() * Math.max(0, voice.noiseBuffer.duration - options.dur - 0.1)
  source.start(t, offset)
  source.stop(t + options.dur + 0.05)
}

export type ToneOptions = {
  type: OscillatorType
  freq: number
  // The pitch slides from `freq` to this over the sound.
  freqEnd?: number
  dur: number
  gain: number
  attack?: number
  delay?: number
  // A low-pass filter over it, for a darker tone.
  lowpass?: number
  // A wobble in pitch: how fast, and how far, in hertz.
  vibrato?: { rate: number; depth: number }
}

// A tone with a slide in pitch: a thud (a low sine falling), a ring, a twang, a bloop.
export function tone(voice: Voice, options: ToneOptions): void {
  const { ctx } = voice
  const t = voice.t + (options.delay ?? 0)
  const attack = options.attack ?? 0.003
  const oscillator = ctx.createOscillator()
  oscillator.type = options.type
  oscillator.frequency.setValueAtTime(options.freq * voice.vary, t)
  if (options.freqEnd !== undefined) oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, options.freqEnd * voice.vary), t + options.dur)
  let last: AudioNode = oscillator
  if (options.lowpass !== undefined) {
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = options.lowpass
    last = last.connect(filter)
  }
  last.connect(envelope(voice, t, options.gain, attack, options.dur - attack))
  if (options.vibrato) {
    const wobble = ctx.createOscillator()
    wobble.frequency.value = options.vibrato.rate
    const depth = ctx.createGain()
    depth.gain.value = options.vibrato.depth
    wobble.connect(depth).connect(oscillator.frequency)
    wobble.start(t)
    wobble.stop(t + options.dur + 0.05)
  }
  oscillator.start(t)
  oscillator.stop(t + options.dur + 0.05)
}

// Many tiny clicks scattered over `dur`: fire crackling, gravel, a chain's links, debris.
export function crackle(voice: Voice, options: { count: number; dur: number; gain: number; freq: number; delay?: number }): void {
  for (let index = 0; index < options.count; index += 1) {
    noise(voice, {
      dur: 0.012 + Math.random() * 0.02,
      gain: options.gain * (0.5 + Math.random() * 0.5),
      filter: 'bandpass',
      freq: options.freq * (0.7 + Math.random() * 0.6),
      q: 2.5,
      attack: 0.001,
      delay: (options.delay ?? 0) + Math.random() * options.dur,
    })
  }
}

// A swish of air past a moving blade or arm: a band of noise that rises in pitch as it swells and fades.
export function swish(voice: Voice, options: { low: number; high: number; dur: number; gain: number; delay?: number }): void {
  noise(voice, { dur: options.dur, gain: options.gain, filter: 'bandpass', freq: options.low, freqEnd: options.high, q: 1.4, attack: options.dur * 0.4, ...(options.delay === undefined ? {} : { delay: options.delay }) })
}

// Where a sound is heard from: how loud (0 to 1, after distance) and where between the left and right ear (-1 to 1).
export type Placement = { gain: number; pan: number }

export class SoundEngine {
  private ctx: AudioContext | undefined
  private master: GainNode | undefined
  private noiseBuffer: AudioBuffer | undefined
  private volume = 0
  // When each sound playing was started, oldest first, to count them.
  private playing: number[] = []
  private readonly unlock = (): void => {
    void this.ctx?.resume()
  }

  // 0 is silent, 1 is full. The ear hears loudness roughly as the square, so the slider's middle sounds like the middle.
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume * this.volume * OUTPUT_GAIN, this.ctx.currentTime, 0.02)
  }

  get audible(): boolean {
    return this.volume > 0
  }

  // Plays a recipe from where it is heard, `delay` seconds from now. Nothing when the volume is off, the page cannot make sound, the
  // tab is hidden, or too many sounds are already playing.
  play(recipe: Recipe, placement: Placement, delay = 0): void {
    if (!this.audible || placement.gain <= 0.01) return
    if (typeof document !== 'undefined' && document.hidden) return
    const ctx = this.context()
    if (!ctx || !this.master || !this.noiseBuffer || ctx.state !== 'running') return
    const now = ctx.currentTime
    this.playing = this.playing.filter((started) => now - started < VOICE_SECONDS)
    if (this.playing.length >= MAX_VOICES) return
    this.playing.push(now)
    const level = ctx.createGain()
    level.gain.value = placement.gain
    const panner = ctx.createStereoPanner()
    panner.pan.value = Math.max(-1, Math.min(1, placement.pan))
    level.connect(panner).connect(this.master)
    recipe({ ctx, out: level, t: now + 0.005 + delay, vary: 0.92 + Math.random() * 0.16, noiseBuffer: this.noiseBuffer })
    // Let go of the nodes once the sound is over.
    window.setTimeout(() => {
      level.disconnect()
      panner.disconnect()
    }, (delay + VOICE_SECONDS * 2) * 1000)
  }

  // The context, made the first time it is needed. Browsers start one suspended until the page is interacted with, so it is woken
  // on the next click or key as well.
  private context(): AudioContext | undefined {
    if (this.ctx) return this.ctx
    const Context = typeof window === 'undefined' ? undefined : window.AudioContext
    if (!Context) return undefined
    const ctx = new Context()
    const master = ctx.createGain()
    master.gain.value = this.volume * this.volume * OUTPUT_GAIN
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -10
    limiter.knee.value = 6
    limiter.ratio.value = 12
    limiter.attack.value = 0.002
    limiter.release.value = 0.2
    master.connect(limiter).connect(ctx.destination)
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const samples = buffer.getChannelData(0)
    for (let index = 0; index < samples.length; index += 1) samples[index] = Math.random() * 2 - 1
    this.ctx = ctx
    this.master = master
    this.noiseBuffer = buffer
    if (ctx.state !== 'running') {
      void ctx.resume()
      window.addEventListener('pointerdown', this.unlock)
      window.addEventListener('keydown', this.unlock)
    }
    return ctx
  }

  close(): void {
    window.removeEventListener('pointerdown', this.unlock)
    window.removeEventListener('keydown', this.unlock)
    void this.ctx?.close()
    this.ctx = undefined
    this.master = undefined
  }
}
