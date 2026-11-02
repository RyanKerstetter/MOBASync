import { GAME_ARENA_HEIGHT, GAME_ARENA_WIDTH } from './constants.js'
import { nearestFree } from './exits.js'
import { clamp, distanceBetween } from './geometry.js'
import type { Vector2 } from './index.js'
import type { Pathfinder, PathfinderFactory } from './pathfinding.js'
import { createVisibilityGraph } from './visibility-graph.js'

// A rectangle in world units: x and y are its top left corner.
export type Rect = { x: number; y: number; width: number; height: number }

// A terrain as it travels in a snapshot: the arena's size, and each wall as [x, y, width, height].
export type TerrainData = {
  width: number
  height: number
  walls: Array<[number, number, number, number]>
  // The bushes, in the same form. Left out when the ground has none, which keeps a snapshot of a map without any as it was.
  bushes?: Array<[number, number, number, number]>
}

// How far a body may sit inside a wall before it is pushed out, so one pushed out to exactly its
// radius from the wall, give or take rounding, is not pushed again.
const PENETRATION_TOLERANCE = 1e-6
// A body in a corner between walls, or a wall and the arena's edge, can be pushed out of one into
// another. It settles in a pass or two; this stops it for good if there is no room for it at all.
const MAX_PASSES = 4

// The ground a game is played on: the arena, which holds everything inside it, and the walls in it,
// which hold champions out. Walls are baked into the map, so they never change in a game, and they
// are not part of the simulation's frames. They stop champions walking (and pathfinding plans
// around them) but nothing else: attacks, abilities, dashes, blinks and knockbacks go over them.
//
// The bushes are on the ground too. They stop nothing, and no rule of the game reads them: they are
// for what the page shows, which is that a team cannot see into one unless it has someone in it (see
// `bushAt`, and `TeamVision` in the client).
//
// Positions and sizes are world units, from the arena's top left corner. A snapshot carries the
// terrain (`toData`), so a client plays on exactly the ground the server does.
export class Terrain {
  private static plainTerrain: Terrain | undefined

  readonly width: number
  readonly height: number
  // In a fixed order, so every peer visits them in the same order whatever order the map listed them.
  readonly walls: readonly Rect[]
  // In a fixed order too.
  readonly bushes: readonly Rect[]
  // For each bush, the patch it is in: the lowest index of the bushes that it overlaps or touches, through others that do. A patch drawn as
  // several rectangles is one bush to stand in.
  private readonly patches: readonly number[]
  private readonly pathfinder: Pathfinder

  constructor(
    arena: { width: number; height: number },
    walls: readonly Rect[] = [],
    // How champions find a way around the walls. Every peer of a game must use the same one.
    createPathfinder: PathfinderFactory = createVisibilityGraph,
    bushes: readonly Rect[] = [],
  ) {
    this.width = arena.width
    this.height = arena.height
    this.walls = walls.map((wall) => ({ ...wall })).sort(compareRects)
    this.bushes = bushes.map((bush) => ({ ...bush })).sort(compareRects)
    this.patches = patchesOf(this.bushes)
    this.pathfinder = createPathfinder({ width: this.width, height: this.height, walls: this.walls })
  }

  // The plain arena (`GAME_ARENA_WIDTH` by `GAME_ARENA_HEIGHT`) with no walls: where a game is played
  // when it has no map.
  static plain(): Terrain {
    Terrain.plainTerrain ??= new Terrain({ width: GAME_ARENA_WIDTH, height: GAME_ARENA_HEIGHT })
    return Terrain.plainTerrain
  }

  static fromData(data: TerrainData, createPathfinder?: PathfinderFactory): Terrain {
    return new Terrain(
      data,
      data.walls.map(rectOf),
      createPathfinder,
      (data.bushes ?? []).map(rectOf),
    )
  }

  toData(): TerrainData {
    return {
      width: this.width,
      height: this.height,
      walls: this.walls.map(tupleOf),
      ...(this.bushes.length > 0 ? { bushes: this.bushes.map(tupleOf) } : {}),
    }
  }

  // Whether this is the terrain that `data` describes.
  sameAs(data: TerrainData): boolean {
    return data.width === this.width
      && data.height === this.height
      && sameRects(this.walls, data.walls)
      && sameRects(this.bushes, data.bushes ?? [])
  }

  // The bush a point is in, if it is in one, as a number that is the same for every point of the same bush and different for another: bushes that
  // overlap or touch are one. The edge is in. Two points are in the same bush when this gives the same number for both.
  bushAt(point: Vector2): number | undefined {
    const index = this.bushes.findIndex((bush) =>
      point.x >= bush.x && point.x <= bush.x + bush.width && point.y >= bush.y && point.y <= bush.y + bush.height)
    return index < 0 ? undefined : this.patches[index]
  }

  // The point held inside the arena for a body of this radius. It is all that holds a dash, a shot
  // or a following entity, which pass over walls.
  clamp(position: Vector2, radius: number): Vector2 {
    return {
      x: clamp(position.x, radius, this.width - radius),
      y: clamp(position.y, radius, this.height - radius),
    }
  }

  // The nearest place a body of this radius can stand, to a point it is going to be put at: held
  // inside the arena, and pushed out of any wall it would be in.
  resolve(position: Vector2, radius: number): Vector2 {
    return this.keepOutOfWalls(this.clamp(position, radius), radius)
  }

  // Pushes a body of this radius out of every wall it overlaps, by the shortest way, and back inside
  // the arena if that took it out. It gives back the very same point if nothing overlapped, so it
  // costs nothing where there are no walls. A body walking into a wall is pushed straight back out
  // each tick, so the part of its step along the wall is kept: it slides.
  keepOutOfWalls(position: Vector2, radius: number): Vector2 {
    if (this.walls.length === 0) return position
    let { x, y } = position
    let moved = false
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      let pushed = false
      for (let index = 0; index < this.walls.length; index += 1) {
        const out = pushOut(x, y, radius, this, index)
        if (!out) continue
        x = out.x
        y = out.y
        pushed = true
      }
      if (!pushed) break
      moved = true
      const held = this.clamp({ x, y }, radius)
      x = held.x
      y = held.y
    }
    return moved ? { x, y } : position
  }

  // The points a body of this radius walks through to get from `from` to `to`; see `Pathfinder`.
  path(from: Vector2, to: Vector2, radius: number): Vector2[] | undefined {
    if (this.walls.length === 0) return [{ ...to }]
    return this.pathfinder.path(from, to, radius)
  }

  // How far a body of this radius has to walk from `from` to `to`: the length of `path`, which is the straight line if nothing
  // is in the way (so about a microsecond), and the way round the walls if there is. Infinity if there is no way. Square roots
  // and sums only, so every peer gets the same answer.
  walkDistance(from: Vector2, to: Vector2, radius: number): number {
    const route = this.path(from, to, radius)
    if (!route) return Infinity
    let total = 0
    let last = from
    for (const point of route) {
      total += distanceBetween(last, point)
      last = point
    }
    return total
  }
}

function compareRects(left: Rect, right: Rect): number {
  return left.y - right.y || left.x - right.x || left.height - right.height || left.width - right.width
}

const rectOf = ([x, y, width, height]: [number, number, number, number]): Rect => ({ x, y, width, height })
const tupleOf = (rect: Rect): [number, number, number, number] => [rect.x, rect.y, rect.width, rect.height]

function sameRects(rects: readonly Rect[], tuples: ReadonlyArray<readonly [number, number, number, number]>): boolean {
  return rects.length === tuples.length
    && rects.every((rect, index) => {
      const [x, y, width, height] = tuples[index]
      return rect.x === x && rect.y === y && rect.width === width && rect.height === height
    })
}

// Which patch each rectangle is in (see `Terrain.patches`): the lowest index among those it is joined to.
function patchesOf(rects: readonly Rect[]): number[] {
  const patch = rects.map((_, index) => index)
  const root = (index: number): number => {
    let at = index
    while (patch[at] !== at) at = patch[at]
    return at
  }
  for (let first = 0; first < rects.length; first += 1) {
    for (let second = first + 1; second < rects.length; second += 1) {
      const one = rects[first]
      const other = rects[second]
      const joined = one.x <= other.x + other.width && other.x <= one.x + one.width
        && one.y <= other.y + other.height && other.y <= one.y + one.height
      if (!joined) continue
      const low = Math.min(root(first), root(second))
      patch[Math.max(root(first), root(second))] = low
    }
  }
  return rects.map((_, index) => root(index))
}

// Whether a circle with its centre at (x, y) overlaps the wall, by more than the tolerance.
function overlaps(x: number, y: number, radius: number, wall: Rect): boolean {
  const reach = radius - PENETRATION_TOLERANCE
  if (reach <= 0) return false
  const dx = x - clamp(x, wall.x, wall.x + wall.width)
  const dy = y - clamp(y, wall.y, wall.y + wall.height)
  return dx * dx + dy * dy < reach * reach
}

// Whether a body of this radius can stand with its centre at the point: inside the arena and clear of every wall.
function clearOf(terrain: Terrain, point: Vector2, radius: number): boolean {
  return point.x >= radius && point.x <= terrain.width - radius && point.y >= radius && point.y <= terrain.height - radius
    && !terrain.walls.some((wall) => overlaps(point.x, point.y, radius, wall))
}

// Where a circle with its centre at (x, y) is put to stop overlapping the wall at this index: along the line from
// the wall's nearest point to its centre, so it goes round a corner as a curve. A centre inside the
// wall leaves by the nearest side that is not out of the arena (the left, right, top, bottom in that
// order, on a tie), since a wall against the arena's edge cannot be left by that side. That side can be into
// the wall next to it, where two meet (a body put on the seam, by a dash, goes from one to the other
// and never out), and then it leaves by the nearest way that is clear of every wall (see `nearestFree`). Nothing if it is
// not overlapping. Only additions, multiplications and one square root, so every peer gets the same
// answer.
function pushOut(x: number, y: number, radius: number, terrain: Terrain, index: number): Vector2 | undefined {
  const wall = terrain.walls[index]
  const right = wall.x + wall.width
  const bottom = wall.y + wall.height
  const nearestX = clamp(x, wall.x, right)
  const nearestY = clamp(y, wall.y, bottom)
  const dx = x - nearestX
  const dy = y - nearestY
  const distanceSquared = dx * dx + dy * dy
  const reach = radius - PENETRATION_TOLERANCE
  if (reach <= 0 || distanceSquared >= reach * reach) return undefined
  if (distanceSquared > 0) {
    const scale = radius / Math.sqrt(distanceSquared)
    return { x: nearestX + dx * scale, y: nearestY + dy * scale }
  }
  const exits: Array<{ cost: number; to: Vector2 }> = [
    { cost: x - wall.x, to: { x: wall.x - radius, y } },
    { cost: right - x, to: { x: right + radius, y } },
    { cost: y - wall.y, to: { x, y: wall.y - radius } },
    { cost: bottom - y, to: { x, y: bottom + radius } },
  ]
  const inside = exits.filter(({ to }) => to.x >= radius && to.x <= terrain.width - radius && to.y >= radius && to.y <= terrain.height - radius)
  let best = (inside.length > 0 ? inside : exits)[0]
  for (const exit of inside.length > 0 ? inside : exits) if (exit.cost < best.cost) best = exit
  if (clearOf(terrain, best.to, radius)) return best.to
  const grown = terrain.walls.map((other) => ({
    left: other.x - radius,
    top: other.y - radius,
    right: other.x + other.width + radius,
    bottom: other.y + other.height + radius,
  }))
  const inner = { left: radius, top: radius, right: terrain.width - radius, bottom: terrain.height - radius }
  // With nowhere clear at all (walls fill the arena) it is the nearest side after all, which at least stays put.
  return nearestFree({ x, y }, grown, index, inner, (point) => clearOf(terrain, point, radius)) ?? best.to
}
