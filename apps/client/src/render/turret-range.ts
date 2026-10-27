import { Container, Graphics } from 'pixi.js'
import { getTeam } from '../../../../packages/shared/src/index.ts'
import type { RenderedCharacter } from '../game-state.ts'

// The circle round a turret that shows how far it reaches: only a thin line in its team's colour along the edge, which is the end of its
// range, and nothing inside it. Anyone whose middle is inside it can be shot. The line is see-through, so the ground under it shows.
export const TURRET_RING_EDGE_ALPHA = 0.22
export const TURRET_RING_EDGE_WIDTH = 2

export type TurretRing = {
  x: number
  y: number
  // The turret's reach, from its middle: the same distance the simulation shoots by.
  radius: number
  color: string
}

// The ring of every turret that is standing: its middle, its reach as it is now, and its team's colour. A destroyed turret has none.
export function layoutTurretRings(characters: readonly RenderedCharacter[]): TurretRing[] {
  return characters
    .filter((character) => character.turret !== undefined && !character.dead && character.attackRange > 0)
    .map((character) => ({
      x: character.position.x,
      y: character.position.y,
      radius: character.attackRange,
      color: getTeam(character.team).color,
    }))
}

// The rings on the ground, under the champions and the ring that shows the controlled champion's own reach. They are made from the
// characters that are drawn, so a turret the team cannot see has none.
export class TurretRangeLayer {
  readonly view = new Container()
  private readonly rings = new Graphics()

  constructor() {
    this.view.addChild(this.rings)
  }

  update(characters: readonly RenderedCharacter[]): void {
    this.rings.clear()
    for (const ring of layoutTurretRings(characters)) {
      this.rings
        .circle(ring.x, ring.y, ring.radius)
        .stroke({ color: ring.color, width: TURRET_RING_EDGE_WIDTH, alpha: TURRET_RING_EDGE_ALPHA })
    }
  }
}
