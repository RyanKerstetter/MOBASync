import { getProperty, type Rect, type TileLayer } from '../../../../packages/shared/src/index.ts'

// Which of two things is in front, when one stands behind the other on screen. The world is seen from above and a bit
// to the south, so whatever stands further down the map is nearer, and is drawn over what stands above it: a champion
// walking behind a wall is covered by it, and one in front of the wall covers it. Everything that takes part has a depth
// (a number, as a `zIndex`) and is drawn from the smallest up, which is all a depth buffer would do for pixel art that
// is flat, and cheaper: `WorldRenderer` puts the champions and the walls' art into one `RenderLayer` that sorts them.
//
// A champion's depth is where it stands. A wall's is its base: the bottom edge of its collision rectangle, which is where
// it meets the ground and where a champion stops when it walks up to it from the south. All of a wall's art has that one
// depth, however tall it is drawn and however many pieces it is made of (the wall itself, and bits that stick off it), since
// all of it rises from the one place. A champion whose middle is above the base is behind the wall and the wall's art is
// drawn over it wherever they overlap on screen, and one whose middle is below is in front and covers it.
//
// Art that no wall has (a tile that is not over a collision rectangle, nor touching art that is) is ordered by the row of
// tiles it is in, by that row's bottom edge: the rule for anything that is only drawn.

// The layers of a map that are drawn in depth order with the champions, not under them: tile layers with this
// custom property (a boolean) set. Where it is not set, a layer is if it is the map's walls, which is a layer whose name
// starts with "wall" (so "Wall Layer" is, as Tiled's default for it).
export const DEPTH_PROPERTY = 'y-sort'

export function isDepthSorted(layer: Pick<TileLayer, 'name' | 'properties'>): boolean {
  const chosen = getProperty(layer.properties, DEPTH_PROPERTY)
  return typeof chosen === 'boolean' ? chosen : /^wall/i.test(layer.name.trim())
}

// How far from a wall's own art the art that is attached to it goes, in tiles. A wall's own art is the tiles over its collision
// rectangle (and the ends of it). Bits that stick off a wall (spikes on its top, say) are tiles of their own that do not
// overlap the rectangle, so they are the wall's by touching its art: a tile that touches (by an edge or a corner) a tile that is
// the wall's is too, and so on, this many times. The bits are then drawn over a champion behind the wall, as the wall is.
// More than that (art that touches those bits, and so on) is ordered by its own row. The number is what stops the art of a
// wall that has a great deal of it from reaching a long way: depth is all or nothing where things overlap on screen and has no
// sense of distance, so the further the bits stick up the more of a champion behind the wall they cover. A layer can say its
// own in its custom property `y-sort-attach` (a whole number of tiles; 0 is the wall's own art alone).
export const WALL_ATTACH_TILES = 1
export const ATTACH_PROPERTY = 'y-sort-attach'
// How far to the side of a wall's rectangle, in tiles, a tile is still the wall's own (the bits that stick out of its ends).
export const WALL_SIDE_TILES = 1

export function attachTiles(layer: Pick<TileLayer, 'properties'>): number {
  const chosen = getProperty(layer.properties, ATTACH_PROPERTY)
  return typeof chosen === 'number' && Number.isInteger(chosen) && chosen >= 0 ? chosen : WALL_ATTACH_TILES
}

// Where a layer's cells are in the world: the size of a tile, and the layer's own offset, both in the map's pixels, the
// arena's top left corner in the map's pixels (which is the world's origin), and the world units to a pixel of the art.
export type TileGrid = {
  tileWidth: number
  tileHeight: number
  offsetX: number
  offsetY: number
  arenaX: number
  arenaY: number
  scale: number
}

// Some of a layer's cells that share a depth: all of them are in front of a champion, or all behind it. `wall` is the
// index of the wall (in the list given) that they are the art of, or none for cells ordered by their row.
export type DepthGroup<T> = { depth: number; wall: number | undefined; cells: T[] }

// The depth of a row of tiles: where its bottom edge is in the world, in world units from the arena's top left corner.
export function rowDepth(row: number, tileHeight: number, offsetY: number, arenaTop: number, scale: number): number {
  return ((row + 1) * tileHeight + offsetY - arenaTop) * scale
}

// The cells of a layer in groups of one depth each, from the back to the front. A cell is the art of a wall, and has the
// wall's base as its depth, if it is one of the wall's own, or is attached to them:
//
//   - A wall's own cell overlaps the wall's collision rectangle (`walls`, in world units) in height, and is over it or at
//     most `sideTiles` to a side (the bits that stick out of its ends). A cell that starts at or below a wall's base is in
//     front of that wall, and is not its own. This takes in the lip of the wall's art that hangs below the rectangle where an
//     edge of it is not on a line of the tiles.
//   - An attached cell touches, by an edge or a corner, a cell that is the wall's, and is not in front of the wall. That is done
//     `attachTiles` times, each time from the cells the last time added: the bits that stick off the wall, which do not overlap
//     its rectangle, are the wall's through the wall's art that they stand on.
//
// Where a cell could be several walls' own, it is the one whose columns it is over before one it is only beside (the lip of a wall's
// art, beside the side of a wall that hangs from it, is the first wall's, and not given the lower base of the second, which would
// draw it over a champion standing in front of the first); then the one whose height its middle is in, before one it only reaches
// the edge of; and after that the one with the highest base on the page (the smallest number). An attached cell is the one of the
// walls that reach it first, and then the same. A cell that is no wall's takes the bottom edge of its row.
export function groupByDepth<T extends { col: number; row: number }>(
  cells: readonly T[],
  grid: TileGrid,
  walls: readonly Rect[],
  options: { attachTiles?: number; sideTiles?: number } = {},
): DepthGroup<T>[] {
  const tileWidth = grid.tileWidth * grid.scale
  const tileHeight = grid.tileHeight * grid.scale
  const attach = Math.floor(options.attachTiles ?? WALL_ATTACH_TILES)
  const side = (options.sideTiles ?? WALL_SIDE_TILES) * tileWidth
  const baseOf = (wall: number): number => walls[wall].y + walls[wall].height

  // Where each cell is in the world, and the wall it is (-1 for none yet).
  const places = cells.map((cell) => {
    const left = (cell.col * grid.tileWidth + grid.offsetX - grid.arenaX) * grid.scale
    const top = (cell.row * grid.tileHeight + grid.offsetY - grid.arenaY) * grid.scale
    return { left, top, right: left + tileWidth, bottom: top + tileHeight }
  })
  const owner = cells.map(() => -1)

  // The wall's own.
  places.forEach((place, index) => {
    const middle = (place.top + place.bottom) / 2
    let foundRank = Infinity
    walls.forEach((wall, candidate) => {
      const base = baseOf(candidate)
      if (!(place.top < base && place.bottom > wall.y)) return
      const over = place.left < wall.x + wall.width && place.right > wall.x
      if (!over && !(place.left - side < wall.x + wall.width && place.right + side > wall.x)) return
      const rank = (over ? 0 : 1) * 2 + (middle >= wall.y && middle < base ? 0 : 1)
      if (rank < foundRank || (rank === foundRank && base < baseOf(owner[index]))) {
        owner[index] = candidate
        foundRank = rank
      }
    })
  })

  // What is attached to them, a step at a time.
  const at = new Map<string, number>()
  cells.forEach((cell, index) => at.set(`${cell.col},${cell.row}`, index))
  let frontier = owner.flatMap((wall, index) => (wall >= 0 ? [index] : []))
  for (let step = 0; step < attach && frontier.length > 0; step += 1) {
    const claimed = new Map<number, number>()
    for (const index of frontier) {
      const wall = owner[index]
      for (let dRow = -1; dRow <= 1; dRow += 1) {
        for (let dCol = -1; dCol <= 1; dCol += 1) {
          const next = at.get(`${cells[index].col + dCol},${cells[index].row + dRow}`)
          if (next === undefined || owner[next] >= 0 || !(places[next].top < baseOf(wall))) continue
          const prior = claimed.get(next)
          if (prior === undefined || baseOf(wall) < baseOf(prior)) claimed.set(next, wall)
        }
      }
    }
    frontier = []
    for (const [index, wall] of claimed) {
      owner[index] = wall
      frontier.push(index)
    }
  }

  const groups = new Map<string, DepthGroup<T>>()
  cells.forEach((cell, index) => {
    const wall = owner[index]
    const key = wall >= 0 ? `wall ${wall}` : `row ${cell.row}`
    let group = groups.get(key)
    if (!group) {
      const depth = wall >= 0 ? baseOf(wall) : rowDepth(cell.row, grid.tileHeight, grid.offsetY, grid.arenaY, grid.scale)
      group = { depth, wall: wall >= 0 ? wall : undefined, cells: [] }
      groups.set(key, group)
    }
    group.cells.push(cell)
  })
  return [...groups.values()].sort((a, b) => a.depth - b.depth)
}

// The depth of a champion: where it stands.
export function characterDepth(position: { y: number }): number {
  return position.y
}
