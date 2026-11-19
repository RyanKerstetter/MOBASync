import { Color } from 'three'

// The 3D world is the 2D one stood up: a point (x, y) of the game is (x, 0, y) in the scene, so the ground is the XZ plane,
// one world unit is one scene unit, and "down the screen" (y growing) is +Z, toward the camera. Height is +Y.

// A small, fast random number generator with a seed, so the scenery of a map is the same every time it is built.
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A number from a string, for seeding things by name.
export function hashString(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

// Smooth value noise in two dimensions, from 0 to 1, with features about `1` unit apart.
export function valueNoise(seed: number): (x: number, y: number) => number {
  const size = 256
  const random = seededRandom(seed)
  const table = new Float32Array(size * size)
  for (let index = 0; index < table.length; index += 1) table[index] = random()
  const at = (x: number, y: number): number => table[(((y % size) + size) % size) * size + (((x % size) + size) % size)]
  return (x, y) => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx
    const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx
    return top * (1 - sy) + bottom * sy
  }
}

// Several octaves of value noise added together, from 0 to 1.
export function fractalNoise(seed: number, octaves = 4): (x: number, y: number) => number {
  const layers = Array.from({ length: octaves }, (_, index) => valueNoise(seed + index * 7919))
  let total = 0
  for (let index = 0; index < octaves; index += 1) total += 0.5 ** index
  return (x, y) => {
    let sum = 0
    for (let index = 0; index < octaves; index += 1) {
      const scale = 2 ** index
      sum += layers[index](x * scale + index * 17.3, y * scale - index * 9.1) * 0.5 ** index
    }
    return sum / total
  }
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

// The shortest way round from one angle to another, in radians.
export function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

// Which way a model turns (about +Y) to face along (dx, dy) of the ground: its own +Z points that way.
export function yawToward(dx: number, dy: number): number {
  return Math.atan2(dx, dy)
}

// A CSS colour as a three.js colour, shared per string.
const colours = new Map<string, Color>()
export function colour(css: string): Color {
  let made = colours.get(css)
  if (!made) {
    made = new Color(css)
    colours.set(css, made)
  }
  return made
}
