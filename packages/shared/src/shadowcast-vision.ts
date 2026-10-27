import { GAME_ART_SCALE } from './constants.js'
import type { Vector2 } from './index.js'
import type { SightViewer, VisionGround, VisionMask, VisionSystem, VisionView } from './vision.js'

// Vision on a grid, worked out by symmetric shadowcasting (Albert Ford's version of recursive shadowcasting): from each
// viewer's cell the grid is swept outward a row at a time in each of four quadrants, with a window of slopes that is
// still open; a wall cuts the window, so the cells behind it are never reached. A cell is seen if its middle is in the
// window, which makes it symmetric: if A sees B then B sees A. Slopes are whole-number fractions compared by
// multiplying across, so it is exact and gives the same answer on every machine.
//
// The grid is finer than the map's tiles: `SHADOWCAST_CELL` is 8 pixels of the map's art (24 world units), because the
// walls are not on the tiles' 16 pixel lines but are on 8 pixel ones (the competitive map is laid out on them, from the arena's
// corner, which is on one, so the grid starts at the world's origin and its lines are the map's). A wall is the cells whose
// middle is inside one of its rectangles, so each edge of a wall is rounded to the nearest line of the grid: exact for an
// edge that is on one (83 of the competitive map's 104 are, and the rest are 1 or 2 pixels off, except two at 4), and up to
// 12 units off for one that is not, which is where a map is not laid out on the grid (ffa_arena's four walls are 7 units
// off on average). A viewer's own place is rounded too: it sees from the middle of its cell. A sweep costs a few
// hundred cells, so every viewer of a full team can move every frame for about a tenth of a millisecond.

// 8 pixels of the map's art, in world units.
export const SHADOWCAST_CELL = 8 * GAME_ART_SCALE
// A viewer that is in a wall (a dash can end up in one for a moment) sees from the nearest cell that is not, this many
// cells away at the most.
const NEAREST_OPEN_CELLS = 6

export type ShadowcastOptions = {
  // How big a cell is, in world units. Smaller is more exact and costs more, with the square of it.
  cell?: number
  // Whether walls block sight. Without, a viewer sees all of its range that is in the arena.
  walls?: boolean
  name?: string
}

export function createShadowcastVision(ground: VisionGround, options: ShadowcastOptions = {}): VisionSystem {
  return new ShadowcastVision(ground, options)
}

class ShadowcastVision implements VisionSystem {
  readonly name: string
  private readonly width: number
  private readonly height: number
  private readonly cell: number
  private readonly cols: number
  private readonly rows: number
  // 1 for a cell that is a wall, or is not in the arena: sight does not go through it.
  private readonly blocked: Uint8Array
  // 1 for a cell that some viewer sees. It is the view's mask, written over by each call that has something new.
  private readonly seen: Uint8Array
  private readonly mask: VisionMask
  private readonly view: VisionView
  // Where the viewers were, as cells, the last time: if they are in the same cells, what they see has not changed.
  private lastLook: string | undefined

  constructor(ground: VisionGround, options: ShadowcastOptions) {
    const cell = options.cell ?? SHADOWCAST_CELL
    if (!(Number.isFinite(cell) && cell > 0)) throw new RangeError('A vision cell needs a positive size.')
    this.name = options.name ?? 'shadowcast'
    this.width = ground.width
    this.height = ground.height
    this.cell = cell
    this.cols = Math.ceil(ground.width / cell)
    this.rows = Math.ceil(ground.height / cell)
    this.blocked = new Uint8Array(this.cols * this.rows)
    this.seen = new Uint8Array(this.cols * this.rows)

    // Cells whose middle is past the arena are outside it.
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        if ((col + 0.5) * cell >= ground.width || (row + 0.5) * cell >= ground.height) this.blocked[row * this.cols + col] = 1
      }
    }
    if (options.walls !== false) {
      for (const wall of ground.walls) {
        // The cells whose middle is in the wall.
        const left = Math.max(0, Math.ceil(wall.x / cell - 0.5))
        const right = Math.min(this.cols - 1, Math.ceil((wall.x + wall.width) / cell - 0.5) - 1)
        const top = Math.max(0, Math.ceil(wall.y / cell - 0.5))
        const bottom = Math.min(this.rows - 1, Math.ceil((wall.y + wall.height) / cell - 0.5) - 1)
        for (let row = top; row <= bottom; row += 1) {
          for (let col = left; col <= right; col += 1) this.blocked[row * this.cols + col] = 1
        }
      }
    }

    this.mask = { kind: 'cells', cell, cols: this.cols, rows: this.rows, data: this.seen, revision: 0 }
    this.view = { canSee: (point) => this.canSeePoint(point), mask: this.mask }
  }

  see(viewers: readonly SightViewer[]): VisionView {
    const look = viewers
      .map((viewer) => `${Math.floor(viewer.position.x / this.cell)},${Math.floor(viewer.position.y / this.cell)},${viewer.range}`)
      .join(';')
    if (look === this.lastLook) return this.view
    this.lastLook = look
    this.seen.fill(0)
    for (const viewer of viewers) this.cast(viewer)
    this.mask.revision += 1
    return this.view
  }

  private canSeePoint(point: Vector2): boolean {
    if (!(point.x >= 0 && point.y >= 0 && point.x < this.width && point.y < this.height)) return false
    return this.seen[Math.floor(point.y / this.cell) * this.cols + Math.floor(point.x / this.cell)] === 1
  }

  private isBlocked(col: number, row: number): boolean {
    return col < 0 || row < 0 || col >= this.cols || row >= this.rows || this.blocked[row * this.cols + col] === 1
  }

  // Marks what one viewer sees.
  private cast(viewer: SightViewer): void {
    const reach = viewer.range / this.cell
    if (!(reach > 0 && Number.isFinite(reach) && Number.isFinite(viewer.position.x) && Number.isFinite(viewer.position.y))) return
    const { col, row } = this.originOf(viewer.position)
    this.reveal(col, row, col, row, reach * reach)
    for (let quadrant = 0; quadrant < 4; quadrant += 1) this.scan(quadrant, col, row, 1, -1, 1, 1, 1, reach, reach * reach)
  }

  // The cell a viewer sees from: its own, or if that is a wall, the nearest that is not.
  private originOf(position: Vector2): { col: number; row: number } {
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor(position.x / this.cell)))
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor(position.y / this.cell)))
    if (!this.isBlocked(col, row)) return { col, row }
    let best: { col: number; row: number } | undefined
    let bestDistance = Infinity
    for (let ring = 1; ring <= NEAREST_OPEN_CELLS && !best; ring += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        for (let dx = -ring; dx <= ring; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring || this.isBlocked(col + dx, row + dy)) continue
          const distance = dx * dx + dy * dy
          if (distance < bestDistance) {
            best = { col: col + dx, row: row + dy }
            bestDistance = distance
          }
        }
      }
    }
    return best ?? { col, row }
  }

  private reveal(col: number, row: number, originCol: number, originRow: number, reach2: number): void {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return
    const dx = col - originCol
    const dy = row - originRow
    if (dx * dx + dy * dy <= reach2) this.seen[row * this.cols + col] = 1
  }

  // One row of one quadrant, `depth` cells out from the viewer, between the slopes sn/sd and en/ed (a slope is the
  // column over the depth, so -1 is a corner of the quadrant's square and 1 the other), and on outward from there.
  // A cell's slope is that of its near edge, (2 col - 1) / (2 depth), and a cell is seen if its middle is in the window.
  private scan(
    quadrant: number,
    originCol: number,
    originRow: number,
    depth: number,
    startNumerator: number,
    startDenominator: number,
    endNumerator: number,
    endDenominator: number,
    reach: number,
    reach2: number,
  ): void {
    if (depth > reach) return
    let sn = startNumerator
    let sd = startDenominator
    // The columns whose middle can be in the window, as whole numbers: round(depth * start) to round(depth * end), a half
    // rounded in.
    const first = Math.floor((2 * depth * sn + sd) / (2 * sd))
    const last = Math.ceil((2 * depth * endNumerator - endDenominator) / (2 * endDenominator))
    let wasWall: boolean | undefined
    for (let col = first; col <= last; col += 1) {
      // North, east, south and west of the viewer: the rows go outward, the columns across.
      const x = quadrant === 0 ? originCol + col : quadrant === 1 ? originCol + depth : quadrant === 2 ? originCol + col : originCol - depth
      const y = quadrant === 0 ? originRow - depth : quadrant === 1 ? originRow + col : quadrant === 2 ? originRow + depth : originRow + col
      const wall = this.isBlocked(x, y)
      // A wall is seen if its face is in the light at all; the ground only if its middle is.
      if (wall || (col * sd >= depth * sn && col * endDenominator <= depth * endNumerator)) this.reveal(x, y, originCol, originRow, reach2)
      // Out of a wall: the window starts again where the wall ended.
      if (wasWall === true && !wall) {
        sn = 2 * col - 1
        sd = 2 * depth
      }
      // Into a wall: what is in the window before it goes on, up to the wall; what is after it waits for the wall to end.
      if (wasWall === false && wall) {
        this.scan(quadrant, originCol, originRow, depth + 1, sn, sd, 2 * col - 1, 2 * depth, reach, reach2)
      }
      wasWall = wall
    }
    if (wasWall === false) this.scan(quadrant, originCol, originRow, depth + 1, sn, sd, endNumerator, endDenominator, reach, reach2)
  }
}
