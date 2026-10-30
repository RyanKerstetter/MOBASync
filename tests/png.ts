import { inflateSync } from 'node:zlib'

// Reads a PNG into RGBA bytes, for tests that look at what is in the game's art. It reads what the art is saved as, 8 bits for each of red, green, blue and
// alpha and not interlaced, and says so for anything else, which is no reason to guess.

export type DecodedImage = { width: number; height: number; data: Uint8Array }

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function decodePng(bytes: Uint8Array): DecodedImage {
  if (SIGNATURE.some((byte, index) => bytes[index] !== byte)) throw new Error('Not a PNG.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0
  let height = 0
  const parts: Uint8Array[] = []
  for (let at = SIGNATURE.length; at + 8 <= bytes.length;) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]]
      if (depth !== 8 || colour !== 6 || interlace !== 0) throw new Error(`Only 8-bit RGBA PNGs that are not interlaced are read (this one is ${depth}-bit, colour type ${colour}, interlace ${interlace}).`)
    } else if (type === 'IDAT') {
      parts.push(body)
    } else if (type === 'IEND') {
      break
    }
    at += 12 + length
  }
  const packed = inflateSync(Buffer.concat(parts))
  const stride = width * 4
  const data = new Uint8Array(stride * height)
  for (let row = 0; row < height; row += 1) {
    const filter = packed[row * (stride + 1)]
    const line = packed.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1))
    for (let index = 0; index < stride; index += 1) {
      const left = index >= 4 ? data[row * stride + index - 4] : 0
      const up = row > 0 ? data[(row - 1) * stride + index] : 0
      const upLeft = row > 0 && index >= 4 ? data[(row - 1) * stride + index - 4] : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) {
        const estimate = left + up - upLeft
        const toLeft = Math.abs(estimate - left)
        const toUp = Math.abs(estimate - up)
        const toUpLeft = Math.abs(estimate - upLeft)
        predicted = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft
      } else if (filter !== 0) {
        throw new Error(`Unknown PNG filter ${filter}.`)
      }
      data[row * stride + index] = (line[index] + predicted) & 0xff
    }
  }
  return { width, height, data }
}
