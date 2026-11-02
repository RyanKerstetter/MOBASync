import { Container, Graphics } from 'pixi.js'
import type { Rect } from '../../../../packages/shared/src/index.ts'

// A bush (see `Terrain.bushAt`) has no art of its own yet, so the page marks where each one is: its rectangle from the map, filled with a green you can
// see through and edged with a stronger line. It is drawn over the champions, so one that is standing in a bush is seen through it, and under the fog, so it is
// darkened with the ground. It is a brighter green than a shop's tint, which is a healing area and should not be taken for one.
export const BUSH_COLOR = '#3fa34d'
export const BUSH_FILL_ALPHA = 0.4
export const BUSH_EDGE_ALPHA = 0.85
export const BUSH_EDGE_WIDTH = 2

// A game's bushes do not change, so they are drawn again only when the layer is given others (a new game, or a resync).
export class BushAreaLayer {
  readonly view = new Container()
  private readonly areas = new Graphics()
  private drawn: readonly Rect[] | undefined

  constructor() {
    this.view.addChild(this.areas)
  }

  update(bushes: readonly Rect[]): void {
    if (bushes === this.drawn) return
    this.drawn = bushes
    this.areas.clear()
    for (const bush of bushes) {
      this.areas
        .rect(bush.x, bush.y, bush.width, bush.height)
        .fill({ color: BUSH_COLOR, alpha: BUSH_FILL_ALPHA })
        .stroke({ color: BUSH_COLOR, width: BUSH_EDGE_WIDTH, alpha: BUSH_EDGE_ALPHA })
    }
  }
}
