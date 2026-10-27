import { GAME_ARENA_HEIGHT, GAME_ARENA_WIDTH } from './constants.js'
import { nearestFree } from './exits.js'
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
// Positions and sizes are world units, from the arena's top left corner. A snapshot carries the
// terrain (`toData`), so a client plays on exactly the ground the server does.
export class Terrain {
  private static plainTerrain: Terrain | undefined

  readonly width: number
  readonly height: number
  // In a fixed order, so every peer visits them in the same order whatever order the map listed them.
  readonly walls: readonly Rect[]
  private readonly pathfinder: Pathfinder

  constructor(
    arena: { width: number; height: number },
    walls: readonly Rect[] = [],
    // How champions find a way around the walls. Every peer of a game must use the same one.
    createPathfinder: PathfinderFactory = createVisibilityGraph,
  ) {
    this.width = arena.width
    this.height = arena.height
    this.walls = walls.map((wall) => ({ ...wall })).sort(compareWalls)
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
      data.walls.map(([x, y, width, height]) => ({ x, y, width, height })),
      createPathfinder,
    )
  }

  toData(): TerrainData {
    return {
      width: this.width,
      height: this.height,
      walls: this.walls.map((wall): [number, number, number, number] => [wall.x, wall.y, wall.width, wall.height]),
    }
  }

  // Whether this is the terrain that `data` describes.
  sameAs(data: TerrainData): boolean {
    return data.width === this.width
      && data.height === this.height
      && data.walls.length === this.walls.length
      && this.walls.every((wall, index) => {
        const [x, y, width, height] = data.walls[index]
        return wall.x === x && wall.y === y && wall.width === width && wall.height === height
      })
  }

  // The point held inside the arena for a body of this radius. It is all that holds a dash, a shot
  // or a following entity, which pass over walls.
  clamp(position: Vector2, radius: number): Vector2 {
    return {
      x: Math.max(radius, Math.min(this.width - radius, position.x)),
      y: Math.max(radius, Math.min(this.height - radius, position.y)),
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
      const dx = point.x - last.x
      const dy = point.y - last.y
      total += Math.sqrt(dx * dx + dy * dy)
      last = point
    }
    return total
  }
}

function compareWalls(left: Rect, right: Rect): number {
  return left.y - right.y || left.x - right.x || left.height - right.height || left.width - right.width
}

// Whether a circle with its centre at (x, y) overlaps the wall, by more than the tolerance.
function overlaps(x: number, y: number, radius: number, wall: Rect): boolean {
  const reach = radius - PENETRATION_TOLERANCE
  if (reach <= 0) return false
  const dx = x - Math.max(wall.x, Math.min(wall.x + wall.width, x))
  const dy = y - Math.max(wall.y, Math.min(wall.y + wall.height, y))
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
  const nearestX = Math.max(wall.x, Math.min(right, x))
  const nearestY = Math.max(wall.y, Math.min(bottom, y))
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
