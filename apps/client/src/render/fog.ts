import type { VisionMask } from '../../../../packages/shared/src/index.ts'

// What the darkness looks like: a deep blue-black, over what is not seen, with this much of the ground still showing
// through it. Dark enough that the edge of what is seen is plain at a glance, and light enough that the map can still be read.
export const FOG_COLOR = 0x0a1020
export const FOG_ALPHA = 0.62
// How many pixels of the picture there are to a side of a cell of the mask (see `FogPicture`).
export const FOG_SCALE = 2
// How many times the mask is blurred (see `FogPicture`). One pass takes the steps out of a circle by about half, two by
// more than half, and three a little more, while the edge gets wider with each, so two is where it stops paying.
export const FOG_BLUR_PASSES = 2
// Where the edge of the darkness is, in the blurred mask (0 where nothing near is seen, 1 where all is): it is dark up to
// the first and clear from the second, with a smooth step between. A straight edge of the mask is 0.5 half way along it, so
// the edge is a soft one, about two thirds of a cell from nearly dark to nearly clear, and not a hard line.
const EDGE_DARK = 0.3
const EDGE_CLEAR = 0.7

// A mask turned into the picture of the darkness, with the steps in its edge rounded off. A mask is a grid of cells that are
// seen or not, and drawn as it is, the edge of what is seen goes in steps a cell wide, which on a big cell (24 units) is plain
// to see: a circle looks like a staircase. So the mask is blurred a little first (each cell becomes a quarter of the one
// either side of it and half of itself, along the rows and then down the columns, `FOG_BLUR_PASSES` times), and the picture is
// made `scale` pixels to the cell by stretching that smoothly and then sharpening it again between `EDGE_DARK` and
// `EDGE_CLEAR`. The edge is where the blurred mask is a half, which is a smooth curve through the middle of the steps and
// not the steps themselves: on a circle of 20 cells, the edge is 0.35 of a cell out of true at the most where it was 0.8.
// What is not changed is where the edge is, on average, so the picture does not show more or less than the mask says.
//
// It is four bytes a pixel, red, green, blue and alpha, with the colour already multiplied by the alpha (which is how the
// renderer blends), clear where it is seen and dark where it is not. The renderer draws it stretched over the world and
// smoothed once more. The pixels are held in the same memory between paints, for the picture to be uploaded from. Most of
// a picture is all one or the other, so only the pixels near an edge are worked out.
export class FogPicture {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
  private readonly across: Float32Array
  private readonly blurred: Float32Array
  // For each place between four cells (one more than there are cells, each way): 1 if all four are not seen at all, 2 if
  // all four are, 0 if it is mixed. A place is a corner of a block of pixels.
  private readonly flat: Uint8Array
  // For each column and row of pixels: the cell on the left of or above its middle, and how far on the way it is to the next.
  private readonly columnCell: Int32Array
  private readonly columnAlong: Float32Array
  private readonly rowCell: Int32Array
  private readonly rowAlong: Float32Array
  // The colour of a pixel for each value of the smoothed mask, from 0 to 255.
  private readonly colours: Uint8Array

  constructor(readonly cols: number, readonly rows: number, readonly scale: number = FOG_SCALE) {
    if (!(Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0 && Number.isInteger(scale) && scale > 0)) {
      throw new RangeError('A fog picture needs a whole number of cells and of pixels to a cell.')
    }
    this.width = cols * scale
    this.height = rows * scale
    this.pixels = new Uint8Array(this.width * this.height * 4)
    this.across = new Float32Array(cols * rows)
    this.blurred = new Float32Array(cols * rows)
    this.flat = new Uint8Array((cols + 1) * (rows + 1))
    this.columnCell = new Int32Array(this.width)
    this.columnAlong = new Float32Array(this.width)
    this.rowCell = new Int32Array(this.height)
    this.rowAlong = new Float32Array(this.height)
    for (let x = 0; x < this.width; x += 1) {
      const at = (x + 0.5) / scale - 0.5
      this.columnCell[x] = Math.floor(at)
      this.columnAlong[x] = at - Math.floor(at)
    }
    for (let y = 0; y < this.height; y += 1) {
      const at = (y + 0.5) / scale - 0.5
      this.rowCell[y] = Math.floor(at)
      this.rowAlong[y] = at - Math.floor(at)
    }
    this.colours = new Uint8Array(256 * 4)
    const alpha255 = FOG_ALPHA * 255
    for (let step = 0; step < 256; step += 1) {
      const t = Math.min(1, Math.max(0, (step / 255 - EDGE_DARK) / (EDGE_CLEAR - EDGE_DARK)))
      const alpha = Math.round(alpha255 * (1 - t * t * (3 - 2 * t)))
      this.colours[step * 4] = Math.round(((FOG_COLOR >> 16) & 0xff) * alpha / 255)
      this.colours[step * 4 + 1] = Math.round(((FOG_COLOR >> 8) & 0xff) * alpha / 255)
      this.colours[step * 4 + 2] = Math.round((FOG_COLOR & 0xff) * alpha / 255)
      this.colours[step * 4 + 3] = alpha
    }
  }

  // Makes `pixels` the picture of this mask, which has to be the shape the picture was made for.
  paint(mask: VisionMask): void {
    const { cols, rows, width, height, pixels, colours } = this
    if (mask.cols !== cols || mask.rows !== rows) {
      throw new RangeError(`A fog picture of ${cols} by ${rows} cells cannot be painted from a mask of ${mask.cols} by ${mask.rows}.`)
    }
    const { data } = mask
    const { across, blurred, flat } = this

    // Blurred along each row, then down each column, with the edge of the grid carried on as it is, and again from the result.
    let from: ArrayLike<number> = data
    for (let pass = 0; pass < FOG_BLUR_PASSES; pass += 1) {
      for (let row = 0; row < rows; row += 1) {
        const base = row * cols
        for (let col = 0; col < cols; col += 1) {
          const left = from[base + (col > 0 ? col - 1 : 0)]
          const right = from[base + (col < cols - 1 ? col + 1 : col)]
          across[base + col] = (left + 2 * from[base + col] + right) / 4
        }
      }
      for (let row = 0; row < rows; row += 1) {
        const above = (row > 0 ? row - 1 : 0) * cols
        const below = (row < rows - 1 ? row + 1 : row) * cols
        const base = row * cols
        for (let col = 0; col < cols; col += 1) blurred[base + col] = (across[above + col] + 2 * across[base + col] + across[below + col]) / 4
      }
      from = blurred
    }

    // Which blocks of pixels are all one thing. The sums are of quarters, so they are exact, and 0 and 1 are really those.
    const stride = cols + 1
    for (let row = -1; row < rows; row += 1) {
      const top = (row < 0 ? 0 : row) * cols
      const bottom = (row + 1 >= rows ? rows - 1 : row + 1) * cols
      for (let col = -1; col < cols; col += 1) {
        const left = col < 0 ? 0 : col
        const right = col + 1 >= cols ? cols - 1 : col + 1
        const a = blurred[top + left]
        const b = blurred[top + right]
        const c = blurred[bottom + left]
        const d = blurred[bottom + right]
        flat[(row + 1) * stride + col + 1] = a === 0 && b === 0 && c === 0 && d === 0 ? 1 : a === 1 && b === 1 && c === 1 && d === 1 ? 2 : 0
      }
    }

    for (let y = 0; y < height; y += 1) {
      const row = this.rowCell[y]
      const along = this.rowAlong[y]
      const top = (row < 0 ? 0 : row) * cols
      const bottom = (row + 1 >= rows ? rows - 1 : row + 1) * cols
      const flatRow = (row + 1) * stride + 1
      let at = y * width * 4
      for (let x = 0; x < width; x += 1) {
        const col = this.columnCell[x]
        const kind = flat[flatRow + col]
        let step: number
        if (kind === 1) {
          step = 0
        } else if (kind === 2) {
          step = 255
        } else {
          const left = col < 0 ? 0 : col
          const right = col + 1 >= cols ? cols - 1 : col + 1
          const across1 = this.columnAlong[x]
          const upper = blurred[top + left] * (1 - across1) + blurred[top + right] * across1
          const lower = blurred[bottom + left] * (1 - across1) + blurred[bottom + right] * across1
          step = Math.round((upper * (1 - along) + lower * along) * 255)
        }
        const colour = step * 4
        pixels[at] = colours[colour]
        pixels[at + 1] = colours[colour + 1]
        pixels[at + 2] = colours[colour + 2]
        pixels[at + 3] = colours[colour + 3]
        at += 4
      }
    }
  }
}
