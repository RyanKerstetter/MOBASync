import type { Vector2 } from './index.js'

// How far a point is from the nearest point of a line segment. Only additions, multiplications and
// one square root, so every peer gets the same answer.
export function distanceToSegment(point: Vector2, from: Vector2, to: Vector2): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  const along = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
  const gapX = point.x - (from.x + dx * along)
  const gapY = point.y - (from.y + dy * along)
  return Math.sqrt(gapX * gapX + gapY * gapY)
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
  const nearestAlong = Math.max(-box.halfLength, Math.min(box.halfLength, along))
  const nearestAcross = Math.max(-box.halfWidth, Math.min(box.halfWidth, across))
  const gapAlong = along - nearestAlong
  const gapAcross = across - nearestAcross
  return gapAlong * gapAlong + gapAcross * gapAcross <= radius * radius
}
