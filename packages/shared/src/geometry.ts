import type { Vector2 } from './index.js'

// How far apart two points are. Only additions, multiplications and one square root (not `Math.hypot`,
// which engines are free to round differently), so every peer gets the same answer.
export function distanceBetween(from: Vector2, to: Vector2): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return Math.sqrt(dx * dx + dy * dy)
}

// The unit vector pointing from one point to another, or nothing when they are the same point and there is no way to point.
export function directionTo(from: Vector2, to: Vector2): Vector2 | undefined {
  const length = distanceBetween(from, to)
  return length === 0 ? undefined : { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
}

// A vector scaled to length 1, or nothing for the zero vector.
export function normalize(vector: Vector2): Vector2 | undefined {
  return directionTo({ x: 0, y: 0 }, vector)
}

// A number held between `low` and `high`.
export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

// How far a point is from the nearest point of a line segment. Only additions, multiplications and
// one square root, so every peer gets the same answer.
export function distanceToSegment(point: Vector2, from: Vector2, to: Vector2): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  const along = lengthSquared === 0
    ? 0
    : clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared, 0, 1)
  return distanceBetween(point, { x: from.x + dx * along, y: from.y + dy * along })
}

// A rectangle's half-extents: `halfLength` along its facing, `halfWidth` across it.
export interface BoxShape {
  halfLength: number
  halfWidth: number
}

// Whether a circle touches an oriented rectangle. The rectangle is centred on `center` with its
// length along `facing`, a unit vector. Only multiplication and addition are involved, so every
// peer gets the same answer.
export function boxTouchesCircle(
  center: Vector2,
  facing: Vector2,
  box: BoxShape,
  point: Vector2,
  radius: number,
): boolean {
  const dx = point.x - center.x
  const dy = point.y - center.y
  // The point in the box's own frame: `along` its facing, `across` it.
  const along = dx * facing.x + dy * facing.y
  const across = -dx * facing.y + dy * facing.x
  const gapAlong = along - clamp(along, -box.halfLength, box.halfLength)
  const gapAcross = across - clamp(across, -box.halfWidth, box.halfWidth)
  return gapAlong * gapAlong + gapAcross * gapAcross <= radius * radius
}
