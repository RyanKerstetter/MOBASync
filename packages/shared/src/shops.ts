import type { Vector2 } from './index.js'

// Where a team can shop: a rectangle on the map (a `shop` object, see map-layout.ts) that belongs to a team. A champion can buy and sell items (see
// items.ts) only while it stands in a shop of its own team, which is when its middle is in the rectangle (the edges count). The shop can be opened
// from anywhere, to look at; it is the buying and the selling that need the place, and that is the simulator's rule (`Simulator.canShop`), so the
// server and every client agree on what was bought.
//
// A game whose map has no shops at all can be shopped in from anywhere, so a map made without them (the free-for-all one) is not left with items
// that cannot be bought. A map that has some has one for every team that starts on it (the map is refused if not), so a team is never left with
// nowhere. A champion that is dead can shop: it comes back in its base, which is where its shop is, though its body lies where it fell.

export type ShopZone = {
  // The team whose shop it is, as the game has it: the map says the slot of spawn points, which the server turns into the team that starts there.
  team: number
  x: number
  y: number
  width: number
  height: number
}

export const NOT_IN_SHOP = 'You can only buy and sell in your own shop.'

export function shopZoneContains(zone: ShopZone, point: Vector2): boolean {
  return point.x >= zone.x && point.x <= zone.x + zone.width && point.y >= zone.y && point.y <= zone.y + zone.height
}

// Whether a living champion of this team standing here can shop: in a shop of its team, or anywhere if the game has no shops.
export function mayShop(zones: readonly ShopZone[], team: number, position: Vector2): boolean {
  return zones.length === 0 || zones.some((zone) => zone.team === team && shopZoneContains(zone, position))
}
