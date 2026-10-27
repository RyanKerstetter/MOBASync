import assert from 'node:assert/strict'
import test from 'node:test'
import { FOG_ALPHA, FOG_BLUR_PASSES, FOG_COLOR, FOG_SCALE, FogPicture } from '../apps/client/src/render/fog.ts'
import type { VisionMask } from '../packages/shared/src/index.ts'

// How the darkness is painted from a mask: exact where nothing changes, rounded where the mask goes in steps.

const ALPHA = Math.round(FOG_ALPHA * 255)
const DARK = [
  Math.round(((FOG_COLOR >> 16) & 255) * ALPHA / 255),
  Math.round(((FOG_COLOR >> 8) & 255) * ALPHA / 255),
  Math.round((FOG_COLOR & 255) * ALPHA / 255),
  ALPHA,
]

function maskOf(cols: number, rows: number, seen: (col: number, row: number) => boolean): VisionMask {
  const data = new Uint8Array(cols * rows)
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) data[row * cols + col] = seen(col, row) ? 1 : 0
  return { kind: 'cells', cell: 24, cols, rows, data, revision: 1 }
}

const painted = (mask: VisionMask, scale?: number): FogPicture => {
  const picture = new FogPicture(mask.cols, mask.rows, scale)
  picture.paint(mask)
  return picture
}
const alphaAt = (picture: FogPicture, x: number, y: number): number => picture.pixels[(y * picture.width + x) * 4 + 3]
const pixelAt = (picture: FogPicture, x: number, y: number): number[] => [...picture.pixels.slice((y * picture.width + x) * 4, (y * picture.width + x) * 4 + 4)]

test('a picture has a number of pixels to each cell, and the buffer to go with it', () => {
  const picture = new FogPicture(6, 4)
  assert.equal(FOG_SCALE, 2)
  assert.deepEqual([picture.width, picture.height, picture.pixels.length], [6 * FOG_SCALE, 4 * FOG_SCALE, 6 * 4 * FOG_SCALE * FOG_SCALE * 4])
  const bigger = new FogPicture(6, 4, 5)
  assert.deepEqual([bigger.width, bigger.height], [30, 20])
  for (const [cols, rows, scale] of [[0, 4, 2], [6, 0, 2], [6, 4, 0], [1.5, 4, 2], [6, 4, 0.5]]) {
    assert.throws(() => new FogPicture(cols, rows, scale), RangeError, `${cols} by ${rows} at ${scale}`)
  }
})

test('a picture is painted from a mask of the shape it was made for, and no other', () => {
  const picture = new FogPicture(6, 4)
  assert.throws(() => picture.paint(maskOf(5, 4, () => true)), /cannot be painted from a mask of 5 by 4/)
  assert.throws(() => picture.paint(maskOf(6, 5, () => true)), RangeError)
})

test('where nothing is seen it is all dark, and where all is seen it is all clear, exactly', () => {
  const dark = painted(maskOf(12, 9, () => false))
  for (let y = 0; y < dark.height; y += 1) for (let x = 0; x < dark.width; x += 1) assert.deepEqual(pixelAt(dark, x, y), DARK)
  assert.deepEqual(DARK, [6, 10, 20, 158], 'a deep blue-black, a little over half dark')
  const clear = painted(maskOf(12, 9, () => true))
  assert.ok(clear.pixels.every((byte) => byte === 0), 'nothing over it at all')
})

test('every pixel is premultiplied: no colour is brighter than its alpha, and nothing is darker than the darkness', () => {
  const picture = painted(maskOf(40, 40, (col, row) => Math.hypot(col - 20, row - 20) < 12))
  for (let at = 0; at < picture.pixels.length; at += 4) {
    const alpha = picture.pixels[at + 3]
    assert.ok(alpha <= ALPHA, 'no more than the darkness')
    for (let channel = 0; channel < 3; channel += 1) assert.ok(picture.pixels[at + channel] <= alpha, 'premultiplied')
  }
})

// ---------------------------------------------------------------------------- the edge

test('a straight edge is a soft one, a cell or so wide, half dark exactly where the cells change', () => {
  const picture = painted(maskOf(16, 4, (col) => col < 8))
  const row = 2 * FOG_SCALE
  const alphas = Array.from({ length: picture.width }, (_, x) => alphaAt(picture, x, row))
  assert.equal(alphas[0], 0, 'clear at the far left')
  assert.equal(alphas[alphas.length - 1], ALPHA, 'dark at the far right')
  for (let x = 1; x < alphas.length; x += 1) assert.ok(alphas[x] >= alphas[x - 1], `it only gets darker going out (${alphas.join(' ')})`)
  const boundary = 8 * FOG_SCALE
  const half = alphas.findIndex((alpha) => alpha >= ALPHA / 2)
  assert.ok(Math.abs(half - boundary) <= 1, `half dark at the pixel ${half}, which is within one of where the cells change (${boundary})`)
  const soft = alphas.filter((alpha) => alpha > 0.1 * ALPHA && alpha < 0.9 * ALPHA).length
  assert.ok(soft >= 1 && soft <= 2 * FOG_SCALE, `from nearly clear to nearly dark in ${soft} pixels, within 2 cells (${2 * FOG_SCALE})`)
})

test('the edge of the grid is no edge: what is seen up to it is clear to it', () => {
  const left = painted(maskOf(16, 8, (col) => col < 8))
  for (let y = 0; y < left.height; y += 1) assert.equal(alphaAt(left, 0, y), 0, 'the left side, from the top row to the bottom')
  const corner = painted(maskOf(16, 8, (col, row) => col >= 10 && row >= 4))
  assert.equal(alphaAt(corner, corner.width - 1, corner.height - 1), 0, 'the bottom right corner')
  assert.equal(alphaAt(corner, 0, 0), ALPHA, 'and the top left is dark')
})

test('thin slivers of light are dimmed, and a few cells wide shows: that is the price of rounding the edge', () => {
  const strip = (width: number) => painted(maskOf(24, 12, (col) => col >= 12 && col < 12 + width))
  const middle = 6 * FOG_SCALE
  const through = (width: number): number => {
    const picture = strip(width)
    let lowest = ALPHA
    for (let x = 12 * FOG_SCALE; x < (12 + width) * FOG_SCALE; x += 1) lowest = Math.min(lowest, alphaAt(picture, x, middle))
    return lowest
  }
  assert.ok(through(1) > 0.85 * ALPHA, `one cell of light is too thin to show (it is ${through(1)} of ${ALPHA} dark)`)
  assert.ok(through(2) < ALPHA / 2, 'two cells show, though not all the way clear')
  assert.equal(through(3), 0, 'and three are clear in the middle')
})

test('the edge of a circle is rounder than the cells it is made from, and in the same place', () => {
  const size = 64
  const radius = 20
  const mask = maskOf(size, size, (col, row) => Math.hypot(col + 0.5 - size / 2, row + 0.5 - size / 2) <= radius)
  const picture = painted(mask)
  // The alpha as the graphics card gives it between pixels (the middle of a pixel is half way into it).
  const alpha = (x: number, y: number): number => {
    const u = x - 0.5
    const v = y - 0.5
    const i = Math.floor(u)
    const j = Math.floor(v)
    const along = u - i
    const down = v - j
    const at = (a: number, b: number) => alphaAt(picture, Math.min(picture.width - 1, Math.max(0, a)), Math.min(picture.height - 1, Math.max(0, b)))
    return (at(i, j) * (1 - along) + at(i + 1, j) * along) * (1 - down) + (at(i, j + 1) * (1 - along) + at(i + 1, j + 1) * along) * down
  }
  const centre = size * FOG_SCALE / 2
  const smooth: number[] = []
  const stepped: number[] = []
  for (let degrees = 0; degrees < 360; degrees += 2) {
    const angle = degrees * Math.PI / 180
    // Where the picture falls through half dark, working in from outside.
    let last = alpha(centre + Math.cos(angle) * (radius + 4) * FOG_SCALE, centre + Math.sin(angle) * (radius + 4) * FOG_SCALE)
    for (let at = radius + 3.98; at > radius - 4; at -= 0.02) {
      const now = alpha(centre + Math.cos(angle) * at * FOG_SCALE, centre + Math.sin(angle) * at * FOG_SCALE)
      if (now <= ALPHA / 2) {
        smooth.push(at + 0.02 * (ALPHA / 2 - now) / (last - now || 1))
        break
      }
      last = now
    }
    // And where the cells themselves end: the outside of the last cell that is seen.
    for (let at = 0; at < size / 2; at += 0.02) {
      if (!mask.data[Math.floor(size / 2 + Math.sin(angle) * at) * size + Math.floor(size / 2 + Math.cos(angle) * at)]) {
        stepped.push(at)
        break
      }
    }
  }
  const spread = (values: number[]): number => Math.max(...values) - Math.min(...values)
  const mean = (values: number[]): number => values.reduce((total, value) => total + value, 0) / values.length
  assert.equal(smooth.length, 180, 'every ray found an edge')
  assert.ok(spread(stepped) > 0.7, `the cells alone are out by ${spread(stepped).toFixed(2)} cells round the circle`)
  assert.ok(spread(smooth) < 0.45, `the picture is out by ${spread(smooth).toFixed(2)}, which is less than half`)
  assert.ok(Math.abs(mean(smooth) - mean(stepped)) < 0.1, `and it is in the same place (${mean(smooth).toFixed(2)} and ${mean(stepped).toFixed(2)})`)
  assert.equal(FOG_BLUR_PASSES, 2)
})

test('it shows as much as the mask says: the clear area is the area of the cells that are seen', () => {
  const mask = maskOf(64, 64, (col, row) => Math.hypot(col + 0.5 - 28, row + 0.5 - 30) <= 17 || (col > 44 && col < 58 && row > 10 && row < 40))
  const picture = painted(mask)
  let clear = 0
  for (let at = 3; at < picture.pixels.length; at += 4) clear += 1 - picture.pixels[at] / ALPHA
  let seen = 0
  for (const cell of mask.data) seen += cell
  const shown = clear / (FOG_SCALE * FOG_SCALE)
  assert.ok(Math.abs(shown - seen) / seen < 0.02, `${shown.toFixed(0)} cells' worth is clear, and ${seen} are seen`)
})

// ---------------------------------------------------------------------------- painting again

test('painting again leaves nothing of the last picture, and the same mask gives the same picture', () => {
  const picture = new FogPicture(30, 20)
  const disc = maskOf(30, 20, (col, row) => Math.hypot(col - 14, row - 9) < 8)
  picture.paint(disc)
  const first = Uint8Array.from(picture.pixels)
  picture.paint(maskOf(30, 20, () => false))
  for (let at = 0; at < picture.pixels.length; at += 4) assert.deepEqual([...picture.pixels.slice(at, at + 4)], DARK, 'all dark again')
  picture.paint(maskOf(30, 20, () => true))
  assert.ok(picture.pixels.every((byte) => byte === 0), 'and all clear')
  picture.paint(disc)
  assert.deepEqual(picture.pixels, first, 'the same mask, the same bytes')
})

test('a picture the size of the competitive map is painted in a few milliseconds', () => {
  const mask = maskOf(162, 66, (col, row) => Math.hypot(col - 40, row - 30) < 21 || Math.hypot(col - 90, row - 35) < 21 || Math.hypot(col - 130, row - 20) < 21)
  const picture = new FogPicture(162, 66)
  for (let index = 0; index < 10; index += 1) picture.paint(mask)
  const start = performance.now()
  for (let index = 0; index < 50; index += 1) picture.paint(mask)
  const each = (performance.now() - start) / 50
  // About half a millisecond here: the bound is 40 times that, to catch a slip into doing every pixel the slow way.
  assert.ok(each < 20, `a paint took ${each.toFixed(2)} ms`)
})
