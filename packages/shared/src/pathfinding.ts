import type { Vector2 } from './index.js'
import type { Rect } from './terrain.js'

// How a body finds its way around walls. This is the one thing about getting from here to there that
// can be swapped for another method (a navigation mesh, a grid) without the simulator knowing: it only
// asks a `Terrain`, which asks the `Pathfinder` it was built with. Every peer must be built with the
// same one, because the path a champion walks is part of the simulation.
//
// What a pathfinder is built from: the ground, and the walls on it, in world units.
export interface PathWorld {
  readonly width: number
  readonly height: number
  readonly walls: readonly Rect[]
}

export interface Pathfinder {
  // The points a body of this radius walks through, in order, to get from `from` to `to`, and
  // where it ends up: `to` if it can stand there, or the nearest place it can. Straight lines between
  // the points never touch a wall, so the first is where to head now. It is empty when the body is
  // already where it would end up, and `undefined` when there is no way there.
  //
  // It is asked every tick of every walking champion, and again when a late order makes the simulator
  // recompute ticks, so it must be quick, and a pure function of its arguments and the world it was
  // built from: no clock, no randomness, nothing that depends on what was asked before. Only
  // arithmetic that every machine does the same (+, -, *, / and square roots), no trigonometry.
  path(from: Vector2, to: Vector2, radius: number): Vector2[] | undefined
}

// Builds a pathfinder for a piece of ground. It is called once for each `Terrain`, so it can do its
// heavy work up front, or the first time a radius is asked about.
export type PathfinderFactory = (world: PathWorld) => Pathfinder
