import type { Vector2 } from './index.js'

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
