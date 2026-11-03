import { Container, Graphics } from 'pixi.js'
import type { RenderedCharacter } from '../game-state.ts'

// The shadow under a tower: a soft dark patch on the ground that it stands on, so the building sits in the map and does not float over it. It is flat, wider than the tower stands and a
// good deal less tall, as a shadow on the ground seen from above and in front is, and made from a few ellipses one inside the other so that it is darkest in the middle and fades out
// at the edge. Its size is the tower's: it is worked out from the `radius` of the body, which is the ground the art stands on (see `standingOnItsGround` in champion-sprites.ts).
export const SHADOW_COLOR = '#000000'
// How wide and how tall the whole of it is, as a share of the tower's radius (1 would be as wide as the body, across the middle). The art is about as wide as its body and a little more at
// the foot, so the shadow is wider than that, to show out from under it on both sides, and reaches below the foot of it.
export const SHADOW_WIDTH = 1.7
export const SHADOW_HEIGHT = 0.7
// How far below the tower's middle it is centred, as a share of its radius: the art stands on the near edge of its ground, so the shadow lies where its foot is.
export const SHADOW_DROP = 0.7
// The ellipses that make it up, from the outside in: how big each is as a share of the whole, and how dark each is, which add up where they overlap. See-through, so the ground shows.
export const SHADOW_STEPS = [
  { scale: 1, alpha: 0.22 },
  { scale: 0.78, alpha: 0.22 },
  { scale: 0.56, alpha: 0.22 },
] as const

export type TurretShadow = {
  // The middle of the shadow, on the ground.
  x: number
  y: number
  // Half of how wide it is, and half of how tall.
  rx: number
  ry: number
}

// The shadow of every tower that is standing, the core of a base too (it is a turret). One that is destroyed has none, as it is not there; one that is not in the list (a turret
// the team cannot see is left out of the frame) has none either.
export function layoutTurretShadows(characters: readonly RenderedCharacter[]): TurretShadow[] {
  return characters
    .filter((character) => character.turret !== undefined && !character.dead)
    .map((character) => {
      const radius = character.champion.radius
      return {
        x: character.position.x,
        y: character.position.y + radius * SHADOW_DROP,
        rx: radius * SHADOW_WIDTH,
        ry: radius * SHADOW_HEIGHT,
      }
    })
}

// The shadows on the ground, under everything that stands on it: the champions, the rings and the telegraphs.
export class TurretShadowLayer {
  readonly view = new Container()
  private readonly shadows = new Graphics()

  constructor() {
    this.view.addChild(this.shadows)
  }

  update(characters: readonly RenderedCharacter[]): void {
    this.shadows.clear()
    for (const shadow of layoutTurretShadows(characters)) {
      for (const step of SHADOW_STEPS) {
        this.shadows
          .ellipse(shadow.x, shadow.y, shadow.rx * step.scale, shadow.ry * step.scale)
          .fill({ color: SHADOW_COLOR, alpha: step.alpha })
      }
    }
  }
}
