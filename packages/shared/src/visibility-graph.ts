import { nearestFree, type Box } from './exits.js'
import type { Vector2 } from './index.js'
import type { PathfinderFactory } from './pathfinding.js'

// A pathfinder that is a graph of the walls' corners. The shortest way round obstacles is a straight
// line that bends only at their corners, like a string pulled tight, so those corners, the start and
// the target are the only places a path needs to go through.
//
// - Each wall is grown by the body's radius, so the body can be treated as a point. A path may touch
//   the edge of a grown wall but not go into it: the walls block, and their edges do not.
// - The graph's nodes are the corners of the grown walls (a little further out, so a body at one is
//   clear of the wall and not just touching it) that are inside the arena and not inside another grown
//   wall. Two nodes are joined when the straight line between them does not go through any wall. All
//   of that is worked out once for each radius, the first time it is asked.
// - A path joins the start and the target to the nodes they can see and takes the shortest way through
//   the graph (Dijkstra). A target in plain sight is one straight line, which is the usual case.
//
// It scales with the square of the number of corners, so it suits a map of a few dozen walls. A bigger
// map wants a navigation mesh, which is another `PathfinderFactory`.

// A grown wall is shrunk by this much when it blocks, so a body that sits right at its edge (pushed
// out of the wall to exactly its radius, give or take rounding) is outside it. The rounded corner of a
// wall is inside the square the grown wall makes, and a body going round it counts as being in it too:
// it steps out first (see `standable`).
const SLACK = 0.05
// How far a corner node is from the wall past the body's radius.
const CORNER_MARGIN = 1
// How much of a line a wall must cross to block it, as a share of the line, so one that only grazes
// a corner does not.
const GRAZE = 1e-9
// The most times a point is moved out of the walls that hold it before it is given up on.
const MAX_ESCAPES = 8

type Edge = { to: number; length: number }
type Graph = {
  // What blocks, and the part of the arena a body's centre can be in.
  blockers: readonly Box[]
  inner: Box
  corners: readonly Vector2[]
  edges: ReadonlyArray<readonly Edge[]>
}

export const createVisibilityGraph: PathfinderFactory = (world) => {
  const graphs = new Map<number, Graph>()
  const build = (radius: number): Graph => {
    const clearance = Math.max(0, radius - SLACK)
    const blockers = world.walls.map((wall) => ({
      left: wall.x - clearance,
      top: wall.y - clearance,
      right: wall.x + wall.width + clearance,
      bottom: wall.y + wall.height + clearance,
    }))
    const inner = { left: radius, top: radius, right: world.width - radius, bottom: world.height - radius }
    const reach = radius + CORNER_MARGIN
    const found = new Map<string, Vector2>()
    for (const wall of world.walls) {
      for (const x of [wall.x - reach, wall.x + wall.width + reach]) {
        for (const y of [wall.y - reach, wall.y + wall.height + reach]) {
          const corner = { x, y }
          if (!within(inner, corner) || blockers.some((blocker) => inside(blocker, corner))) continue
          found.set(`${x},${y}`, corner)
        }
      }
    }
    const corners = [...found.values()].sort((left, right) => left.y - right.y || left.x - right.x)
    const edges: Edge[][] = corners.map(() => [])
    for (let first = 0; first < corners.length; first += 1) {
      for (let second = first + 1; second < corners.length; second += 1) {
        if (!clear(blockers, corners[first], corners[second])) continue
        const length = distance(corners[first], corners[second])
        edges[first].push({ to: second, length })
        edges[second].push({ to: first, length })
      }
    }
    return { blockers, inner, corners, edges }
  }

  return {
    path(from, to, radius) {
      let graph = graphs.get(radius)
      if (!graph) {
        graph = build(radius)
        graphs.set(radius, graph)
      }
      return findPath(graph, from, to)
    },
  }
}

function findPath(graph: Graph, from: Vector2, to: Vector2): Vector2[] | undefined {
  const start = standable(graph, from)
  const end = standable(graph, to)
  if (!start || !end) return undefined
  // A start that was inside a wall's clearance first steps out of it.
  const stepOut = start.x !== from.x || start.y !== from.y ? [start] : []
  if (start.x === end.x && start.y === end.y) return stepOut
  if (clear(graph.blockers, start, end)) return [...stepOut, { ...end }]

  const { corners, edges, blockers } = graph
  const best = new Array<number>(corners.length).fill(Infinity)
  const before = new Array<number>(corners.length).fill(-1)
  const settled = new Array<boolean>(corners.length).fill(false)
  corners.forEach((corner, index) => {
    if (clear(blockers, start, corner)) best[index] = distance(start, corner)
  })
  // The nearest unsettled corner each time, the lowest index on a tie, so every peer takes the same way.
  for (;;) {
    let next = -1
    for (let index = 0; index < corners.length; index += 1) {
      if (!settled[index] && best[index] < Infinity && (next < 0 || best[index] < best[next])) next = index
    }
    if (next < 0) break
    settled[next] = true
    for (const { to: neighbour, length } of edges[next]) {
      if (best[next] + length < best[neighbour]) {
        best[neighbour] = best[next] + length
        before[neighbour] = next
      }
    }
  }

  let last = -1
  let total = Infinity
  corners.forEach((corner, index) => {
    if (best[index] === Infinity || !clear(blockers, corner, end)) return
    const length = best[index] + distance(corner, end)
    if (length < total) {
      total = length
      last = index
    }
  })
  if (last < 0) return undefined
  const route: Vector2[] = [{ ...end }]
  for (let index = last; index >= 0; index = before[index]) route.push({ ...corners[index] })
  return [...stepOut, ...route.reverse()]
}

// Where a body can stand, nearest to a point: that point held inside the arena, and moved out of the
// clearance of any wall it is in, by the nearest side that is still inside the arena and not into another wall's
// clearance (or by the nearest way clear of all of them, where walls meet). Nothing if it is boxed in. A body that is pushing along a wall, or going round a corner, is inside the clearance (the
// clearance is a square round the wall, which a body going round a corner is inside of) and needs to
// step out to see anything.
function standable(graph: Graph, point: Vector2): Vector2 | undefined {
  const { inner } = graph
  let x = Math.max(inner.left, Math.min(inner.right, point.x))
  let y = Math.max(inner.top, Math.min(inner.bottom, point.y))
  for (let attempt = 0; attempt <= MAX_ESCAPES; attempt += 1) {
    const blocker = graph.blockers.find((box) => inside(box, { x, y }))
    if (!blocker) return x === point.x && y === point.y ? point : { x, y }
    const exits = [
      { cost: x - blocker.left, to: { x: blocker.left, y } },
      { cost: blocker.right - x, to: { x: blocker.right, y } },
      { cost: y - blocker.top, to: { x, y: blocker.top } },
      { cost: blocker.bottom - y, to: { x, y: blocker.bottom } },
    ]
    const open = exits.filter(({ to }) => within(inner, to))
    const choices = open.length > 0 ? open : exits
    let best = choices[0]
    for (const exit of choices) if (exit.cost < best.cost) best = exit
    const side = {
      x: Math.max(inner.left, Math.min(inner.right, best.to.x)),
      y: Math.max(inner.top, Math.min(inner.bottom, best.to.y)),
    }
    // That side can be into the next wall, where two meet: leaving one is going into the other, and so on until it gives up, which
    // is a body that cannot be routed anywhere and an order that does nothing. Then it leaves by the nearest way clear of all of them.
    const free = (spot: Vector2): boolean => within(inner, spot) && !graph.blockers.some((box) => inside(box, spot))
    const out = free(side) ? side : nearestFree({ x, y }, graph.blockers, graph.blockers.indexOf(blocker), inner, free) ?? side
    x = out.x
    y = out.y
  }
  return undefined
}

function within(box: Box, point: Vector2): boolean {
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
}

// Strictly inside: on the edge is outside, so a path can run along it.
function inside(box: Box, point: Vector2): boolean {
  return point.x > box.left && point.x < box.right && point.y > box.top && point.y < box.bottom
}

function distance(from: Vector2, to: Vector2): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return Math.sqrt(dx * dx + dy * dy)
}

// Whether the straight line from one point to another gets through without going into any of the boxes.
function clear(blockers: readonly Box[], from: Vector2, to: Vector2): boolean {
  return !blockers.some((box) => crosses(box, from, to))
}

// Whether a line goes through the inside of a box, found by clipping it to the box one axis at a time
// (the share of the line from the first to the last point inside, along each axis). It touching the
// edge, or only a corner, is not crossing.
function crosses(box: Box, from: Vector2, to: Vector2): boolean {
  let enter = 0
  let leave = 1
  for (const [start, change, low, high] of [
    [from.x, to.x - from.x, box.left, box.right],
    [from.y, to.y - from.y, box.top, box.bottom],
  ] as const) {
    if (change === 0) {
      if (start <= low || start >= high) return false
      continue
    }
    const first = (low - start) / change
    const second = (high - start) / change
    enter = Math.max(enter, Math.min(first, second))
    leave = Math.min(leave, Math.max(first, second))
  }
  return leave - enter > GRAZE
}
