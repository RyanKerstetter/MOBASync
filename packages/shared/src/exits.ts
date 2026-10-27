import type { Vector2 } from './index.js'

// A box in world units, by its edges.
export type Box = { left: number; top: number; right: number; bottom: number }

// The stretches of a line from `low` to `high` that are not inside any of the open intervals `blocked` (an interval's ends are
// not inside it, so a stretch can be as short as a point where two of them meet), from the low end up.
function freeStretches(low: number, high: number, blocked: Array<[number, number]>): Array<[number, number]> {
  const stretches: Array<[number, number]> = []
  if (low > high) return stretches
  let from = low
  for (const [start, end] of [...blocked].sort((left, right) => left[0] - right[0] || left[1] - right[1])) {
    // Behind where the free part now starts, or past where the line stops: nothing for it to take.
    if (end <= from) continue
    if (start >= high) break
    // It takes the line from `start` on, so the free part before it, if any, ends there.
    if (start >= from) stretches.push([from, start])
    from = Math.max(from, end)
  }
  if (from <= high) stretches.push([from, high])
  return stretches
}

// The nearest place to a point that is free to stand in, found along the edges of the boxes: the point nearest to it on every part
// of an edge that is not inside another box. `boxes` are the walls grown by the body's radius, so a point on their edge is clear of
// the wall it is the edge of, and `inner` is where a body's middle can be at all (inside the arena, by its radius).
//
// It is the parts of an edge, and not a single point on each side at the point's own x or y, that are looked at, because the
// nearest side of a wall can have another wall against it (where two meet, there is a seam): the point straight out of the side can
// be inside the other wall, and the free part next to it, a step along the edge, is then the way out. Taking only the points
// straight out would pass over it for one on the far side of the wall, and a body would be sent all the way round. The nearest
// point on a free part is the point's own x (or y) held between the ends of the part, so a part that stops short of it is
// reached by its end.
//
// `free` has the last word on a place, for a caller whose idea of free is not the boxes' (a round body against a rounded corner).
// The boxes round `first` are tried first, and each box's left, right, top and bottom in that order, so of two places as near, the
// one a body in that wall would have left by is the one. Nothing if there is nowhere (the boxes fill the arena).
//
// Only comparisons, additions and multiplications, in a fixed order, so every peer finds the same place.
export function nearestFree(
  from: Vector2,
  boxes: readonly Box[],
  first: number,
  inner: Box,
  free: (point: Vector2) => boolean,
): Vector2 | undefined {
  let best: Vector2 | undefined
  let bestCost = Infinity
  const consider = (x: number, y: number): void => {
    const dx = x - from.x
    const dy = y - from.y
    const cost = dx * dx + dy * dy
    if (cost < bestCost && free({ x, y })) {
      best = { x, y }
      bestCost = cost
    }
  }
  const along = (index: number): void => {
    const box = boxes[index]
    const others = boxes.filter((_, other) => other !== index)
    // The left and right edges are lines of x, from the box's top to its bottom, held in the arena. Another box takes the part of
    // one that is inside its width, and it is the same turned on its side for the top and bottom.
    for (const x of [box.left, box.right]) {
      if (x < inner.left || x > inner.right) continue
      const blocked = others.filter((other) => other.left < x && x < other.right).map((other): [number, number] => [other.top, other.bottom])
      for (const [low, high] of freeStretches(Math.max(box.top, inner.top), Math.min(box.bottom, inner.bottom), blocked)) {
        consider(x, Math.max(low, Math.min(high, from.y)))
      }
    }
    for (const y of [box.top, box.bottom]) {
      if (y < inner.top || y > inner.bottom) continue
      const blocked = others.filter((other) => other.top < y && y < other.bottom).map((other): [number, number] => [other.left, other.right])
      for (const [low, high] of freeStretches(Math.max(box.left, inner.left), Math.min(box.right, inner.right), blocked)) {
        consider(Math.max(low, Math.min(high, from.x)), y)
      }
    }
  }
  if (first >= 0 && first < boxes.length) along(first)
  boxes.forEach((_, index) => {
    if (index !== first) along(index)
  })
  return best
}
