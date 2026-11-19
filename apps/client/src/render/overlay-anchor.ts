import type { Vector2 } from '../../../../packages/shared/src/index.ts'

// Where what is drawn over a character (its name and bars, the numbers of what it takes, what its kill paid) is placed from,
// for a renderer that does not draw the world flat: the point the 2D layers would use, `position` with a body of `radius`
// (and the character's `id`, when there is one), as it is in the layer's own coordinates. The layers then add the same offsets
// as in 2D, up from it. In 2D there is none: the point is the character's position, as the world and the layers share their
// coordinates.
export type OverlayAnchor = (position: Vector2, radius: number, id?: number) => Vector2
