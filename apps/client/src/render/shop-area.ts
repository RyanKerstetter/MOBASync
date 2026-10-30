import { Container, Graphics } from 'pixi.js'
import { SHOP_HEAL_AMOUNT, type ShopZone } from '../../../../packages/shared/src/index.ts'

// A shop is a healing area (see shops.ts), so the page draws it on the ground: the rectangle the map has for it, with a faint green tint
// over the ground and a fainter line round the edge. Every team's shop is drawn, the one that heals you and the one that heals the enemy,
// and what is in the dark is darkened with the rest of the ground. The tint is see-through, so the ground under it shows, and it is a soft sage
// green and not a bright one, so it reads as a place on the ground and does not glow over the map. A player can turn it off (the graphics menu).
export const SHOP_AREA_COLOR = '#7fb896'
export const SHOP_AREA_FILL_ALPHA = 0.07
export const SHOP_AREA_EDGE_ALPHA = 0.18
export const SHOP_AREA_EDGE_WIDTH = 2

export type ShopArea = { x: number; y: number; width: number; height: number }

// The areas to tint: where each shop is. None when the shop heals nothing (`SHOP_HEAL_AMOUNT` is 0): it is not a healing area then, and
// tinting it as one would say it is.
export function layoutShopAreas(zones: readonly ShopZone[], heals = SHOP_HEAL_AMOUNT > 0): ShopArea[] {
  return heals ? zones.map(({ x, y, width, height }) => ({ x, y, width, height })) : []
}

// The tint on the ground, under everything that stands on it. A game's shops do not change, so it is drawn again only when it is given
// others (a new game, or a resync). It is hidden, and not undrawn, when the effect is turned off, so turning it back on costs nothing.
export class ShopAreaLayer {
  readonly view = new Container()
  private readonly areas = new Graphics()
  private drawn: readonly ShopZone[] | undefined

  constructor() {
    this.view.addChild(this.areas)
  }

  update(zones: readonly ShopZone[], visible = true): void {
    this.view.visible = visible
    if (zones === this.drawn) return
    this.drawn = zones
    this.areas.clear()
    for (const area of layoutShopAreas(zones)) {
      this.areas
        .rect(area.x, area.y, area.width, area.height)
        .fill({ color: SHOP_AREA_COLOR, alpha: SHOP_AREA_FILL_ALPHA })
        .stroke({ color: SHOP_AREA_COLOR, width: SHOP_AREA_EDGE_WIDTH, alpha: SHOP_AREA_EDGE_ALPHA })
    }
  }
}
