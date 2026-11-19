import { CanvasTexture, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, type Texture } from 'three'
import { seededRandom, valueNoise } from './space.ts'

// The detail textures the ground is painted with, drawn once on canvases when the 3D view is made. Each tiles: what is drawn
// over an edge is drawn again over the opposite one. The ground's shader mixes them by where it is (see terrain-mesh.ts).

const SIZE = 512

type Painter = (context: CanvasRenderingContext2D, random: () => number) => void

function makeTexture(seed: number, paint: Painter, colour = true): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('A canvas cannot be drawn on in this browser.')
  paint(context, seededRandom(seed))
  const texture = new CanvasTexture(canvas)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.minFilter = LinearMipmapLinearFilter
  texture.anisotropy = 8
  if (colour) texture.colorSpace = SRGBColorSpace
  return texture
}

// Draws `draw` at (x, y) and again wherever it would cross an edge, so the picture tiles.
function wrapped(x: number, y: number, reach: number, draw: (x: number, y: number) => void): void {
  for (const dx of [-SIZE, 0, SIZE]) {
    for (const dy of [-SIZE, 0, SIZE]) {
      const px = x + dx
      const py = y + dy
      if (px + reach < 0 || py + reach < 0 || px - reach > SIZE || py - reach > SIZE) continue
      draw(px, py)
    }
  }
}

// A base of noise, per pixel, from `low` to `high` colours (as [r, g, b]), with the noise tiling.
function noiseBase(context: CanvasRenderingContext2D, seed: number, low: number[], high: number[], scale: number, contrast = 1): void {
  const image = context.createImageData(SIZE, SIZE)
  const coarse = valueNoise(seed)
  const fine = valueNoise(seed + 101)
  const period = SIZE / scale
  // Tiling noise: blended from the four ways round the torus.
  const tiled = (noise: (x: number, y: number) => number, x: number, y: number, p: number): number => {
    const u = x / SIZE
    const v = y / SIZE
    const a = noise(x / p, y / p)
    const b = noise((x - SIZE) / p, y / p)
    const c = noise(x / p, (y - SIZE) / p)
    const d = noise((x - SIZE) / p, (y - SIZE) / p)
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
  }
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const n = Math.min(1, Math.max(0, (tiled(coarse, x, y, period) * 0.65 + tiled(fine, x, y, period / 4) * 0.35 - 0.5) * contrast + 0.5))
      const at = (y * SIZE + x) * 4
      image.data[at] = low[0] + (high[0] - low[0]) * n
      image.data[at + 1] = low[1] + (high[1] - low[1]) * n
      image.data[at + 2] = low[2] + (high[2] - low[2]) * n
      image.data[at + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)
}

// Grass: a mottled green, thick with short blades in lighter and darker greens, and a flower here and there.
export function grassTexture(): Texture {
  return makeTexture(11, (context, random) => {
    noiseBase(context, 11, [52, 92, 40], [86, 130, 52], 6, 1.4)
    const greens = ['#3f7a2e', '#4f8f36', '#62a642', '#78b94e', '#355f27', '#8cc25a', '#2f5a24']
    context.lineCap = 'round'
    for (let blade = 0; blade < 9000; blade += 1) {
      const x = random() * SIZE
      const y = random() * SIZE
      const length = 3 + random() * 7
      const lean = (random() - 0.5) * 1.2
      context.strokeStyle = greens[Math.floor(random() * greens.length)]
      context.globalAlpha = 0.45 + random() * 0.5
      context.lineWidth = 0.8 + random() * 1.2
      wrapped(x, y, 12, (px, py) => {
        context.beginPath()
        context.moveTo(px, py)
        context.lineTo(px + Math.sin(lean) * length, py - Math.cos(lean) * length)
        context.stroke()
      })
    }
    const flowers = ['#f4e27a', '#ffffff', '#e9a3d0', '#b9c8ff']
    for (let flower = 0; flower < 70; flower += 1) {
      const x = random() * SIZE
      const y = random() * SIZE
      context.fillStyle = flowers[Math.floor(random() * flowers.length)]
      context.globalAlpha = 0.85
      const radius = 1.3 + random() * 1.1
      wrapped(x, y, 4, (px, py) => {
        context.beginPath()
        context.arc(px, py, radius, 0, Math.PI * 2)
        context.fill()
      })
    }
    context.globalAlpha = 1
  })
}

// A path of packed dirt: a warm brown with darker ruts, pebbles with a lit top, and cracks.
export function dirtTexture(): Texture {
  return makeTexture(23, (context, random) => {
    noiseBase(context, 23, [104, 80, 56], [156, 126, 90], 5, 1.5)
    // Worn patches, lighter and darker.
    for (let patch = 0; patch < 90; patch += 1) {
      const x = random() * SIZE
      const y = random() * SIZE
      const radius = 10 + random() * 40
      context.fillStyle = random() < 0.5 ? 'rgba(70, 50, 34, 0.12)' : 'rgba(190, 160, 120, 0.1)'
      const squash = 0.4 + random() * 0.6
      const turn = random() * Math.PI
      wrapped(x, y, radius, (px, py) => {
        context.beginPath()
        context.ellipse(px, py, radius, radius * squash, turn, 0, Math.PI * 2)
        context.fill()
      })
    }
    // Cracks.
    context.lineWidth = 1
    for (let crack = 0; crack < 40; crack += 1) {
      let x = random() * SIZE
      let y = random() * SIZE
      context.strokeStyle = 'rgba(55, 38, 24, 0.45)'
      for (let step = 0; step < 6; step += 1) {
        const nx = x + (random() - 0.5) * 22
        const ny = y + (random() - 0.5) * 22
        wrapped(x, y, 30, (px, py) => {
          context.beginPath()
          context.moveTo(px, py)
          context.lineTo(px + nx - x, py + ny - y)
          context.stroke()
        })
        x = nx
        y = ny
      }
    }
    // Pebbles: a shadow, the stone, and a lit edge on top.
    for (let pebble = 0; pebble < 520; pebble += 1) {
      const x = random() * SIZE
      const y = random() * SIZE
      const rx = 1.5 + random() * 4.5
      const ry = rx * (0.6 + random() * 0.35)
      const shade = 110 + Math.floor(random() * 80)
      const angle = random() * Math.PI
      wrapped(x, y, 8, (px, py) => {
        context.fillStyle = 'rgba(40, 28, 18, 0.45)'
        context.beginPath()
        context.ellipse(px + 1, py + 1.2, rx, ry, angle, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = `rgb(${shade}, ${shade - 8}, ${shade - 20})`
        context.beginPath()
        context.ellipse(px, py, rx, ry, angle, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = 'rgba(255, 245, 225, 0.25)'
        context.beginPath()
        context.ellipse(px - rx * 0.25, py - ry * 0.3, rx * 0.5, ry * 0.4, angle, 0, Math.PI * 2)
        context.fill()
      })
    }
  })
}

// Rock: grey stone in blocks and strata, with dark cracks and patches of moss.
export function rockTexture(): Texture {
  return makeTexture(37, (context, random) => {
    noiseBase(context, 37, [78, 76, 74], [140, 136, 128], 4, 1.7)
    // Strata: faint horizontal bands, broken.
    for (let band = 0; band < 26; band += 1) {
      const y = random() * SIZE
      context.fillStyle = random() < 0.5 ? 'rgba(40, 38, 36, 0.18)' : 'rgba(200, 196, 186, 0.12)'
      const height = 2 + random() * 6
      const x = random() * SIZE
      const width = 80 + random() * 300
      wrapped(x, y, width, (px, py) => context.fillRect(px, py, width, height))
    }
    // Cracks between blocks.
    context.lineCap = 'round'
    for (let crack = 0; crack < 70; crack += 1) {
      let x = random() * SIZE
      let y = random() * SIZE
      context.lineWidth = 1 + random() * 1.8
      context.strokeStyle = 'rgba(28, 26, 26, 0.55)'
      for (let step = 0; step < 5; step += 1) {
        const nx = x + (random() - 0.5) * 50
        const ny = y + (random() - 0.5) * 30
        wrapped(x, y, 60, (px, py) => {
          context.beginPath()
          context.moveTo(px, py)
          context.lineTo(px + nx - x, py + ny - y)
          context.stroke()
        })
        x = nx
        y = ny
      }
    }
    // Moss.
    for (let moss = 0; moss < 160; moss += 1) {
      const x = random() * SIZE
      const y = random() * SIZE
      const radius = 3 + random() * 14
      context.fillStyle = `rgba(${60 + random() * 30}, ${100 + random() * 40}, ${40 + random() * 20}, ${0.25 + random() * 0.3})`
      wrapped(x, y, radius, (px, py) => {
        context.beginPath()
        context.arc(px, py, radius, 0, Math.PI * 2)
        context.fill()
      })
    }
  })
}

// Noise for breaking up the tiling: three different noises in red, green and blue, each from 0 to 1, tiling.
export function noiseTexture(): Texture {
  return makeTexture(53, (context) => {
    const image = context.createImageData(SIZE, SIZE)
    const channels = [valueNoise(53), valueNoise(59), valueNoise(61)]
    const periods = [SIZE / 4, SIZE / 8, SIZE / 16]
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const u = x / SIZE
        const v = y / SIZE
        const at = (y * SIZE + x) * 4
        channels.forEach((noise, channel) => {
          const p = periods[channel]
          const a = noise(x / p, y / p)
          const b = noise((x - SIZE) / p, y / p)
          const c = noise(x / p, (y - SIZE) / p)
          const d = noise((x - SIZE) / p, (y - SIZE) / p)
          image.data[at + channel] = 255 * ((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v)
        })
        image.data[at + 3] = 255
      }
    }
    context.putImageData(image, 0, 0)
  }, false)
}
