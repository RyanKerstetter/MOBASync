import { Container, Graphics } from 'pixi.js'
import { getTeam } from '../../../../packages/shared/src/index.ts'
import type { RenderedCharacter } from '../game-state.ts'

// A healing zone (see healing-zones.ts) is drawn on the ground as the area it heals in: a see-through disc in its team's colour out to its reach, with a firmer line at
// the edge, which is where a champion's middle has to be to be healed and shielded, and a ring that swells slowly out from the body to the edge and fades, so it reads
// as a place that gives something and not as a turret's range. It is under the champions, so whoever stands in it shows. It is drawn for every zone that is standing
// and in sight, the enemy's too, and not for one that is destroyed.
export const ZONE_FILL_ALPHA = 0.08
export const ZONE_EDGE_ALPHA = 0.5
export const ZONE_EDGE_WIDTH = 3
export const ZONE_PULSE_ALPHA = 0.35
export const ZONE_PULSE_WIDTH = 2
// How long one swell of the ring takes, from the body to the edge.
export const ZONE_PULSE_MS = 2400

export type HealingZoneArea = {
  x: number
  y: number
  // Where the body ends, which the ring swells out from, and where the zone does.
  inner: number
  reach: number
  color: string
}

// The area of every standing zone that is drawn.
export function layoutHealingZones(characters: readonly RenderedCharacter[]): HealingZoneArea[] {
  return characters.flatMap((character) => {
    const zone = character.turret?.zone
    if (!zone || character.dead) return []
    return [{ x: character.position.x, y: character.position.y, inner: character.champion.radius, reach: zone.reach, color: getTeam(character.team).color }]
  })
}

// How far out the swelling ring is at `now`, from the body (0) to the edge (1).
export function zonePulse(now: number): number {
  return ((now % ZONE_PULSE_MS) + ZONE_PULSE_MS) % ZONE_PULSE_MS / ZONE_PULSE_MS
}

export class HealingZoneLayer {
  readonly view = new Container()
  private readonly areas = new Graphics()

  constructor() {
    this.view.addChild(this.areas)
  }

  update(characters: readonly RenderedCharacter[], now: number): void {
    this.areas.clear()
    const pulse = zonePulse(now)
    for (const area of layoutHealingZones(characters)) {
      this.areas
        .circle(area.x, area.y, area.reach)
        .fill({ color: area.color, alpha: ZONE_FILL_ALPHA })
        .stroke({ color: area.color, width: ZONE_EDGE_WIDTH, alpha: ZONE_EDGE_ALPHA })
        .circle(area.x, area.y, area.inner + (area.reach - area.inner) * pulse)
        .stroke({ color: area.color, width: ZONE_PULSE_WIDTH, alpha: ZONE_PULSE_ALPHA * (1 - pulse) })
    }
  }
}
