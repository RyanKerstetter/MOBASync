import assert from 'node:assert/strict'
import type { Voice } from '../apps/client/src/audio/sound-engine.ts'

// A stand-in for the browser's audio, for building a sound recipe in a test: it makes nothing that sounds, but checks what a recipe
// asks of it as a browser would (an exponential ramp to 0 or below throws there), and notes when each part of the sound would stop.
export function fakeAudio(): { voice: Voice; stops: number[] } {
  const stops: number[] = []
  const param = (): Record<string, unknown> => ({
    value: 0,
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined,
    setTargetAtTime: () => undefined,
    exponentialRampToValueAtTime: (value: number) => {
      assert.ok(value > 0, 'an exponential ramp has to end above 0')
    },
  })
  const node = (): Record<string, unknown> => ({
    gain: param(),
    frequency: param(),
    Q: param(),
    pan: param(),
    buffer: null,
    type: '',
    connect: (next: unknown) => next,
    disconnect: () => undefined,
    start: () => undefined,
    stop: (at: number) => stops.push(at),
  })
  const ctx = { currentTime: 0, createGain: node, createBiquadFilter: node, createOscillator: node, createBufferSource: node }
  return {
    voice: { ctx: ctx as unknown as BaseAudioContext, out: node() as unknown as AudioNode, t: 0, vary: 1, noiseBuffer: { duration: 2 } as AudioBuffer },
    stops,
  }
}
