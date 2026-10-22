import type { RenderedCharacter, RenderedEntity } from './game-state.ts'

// One outline to draw for the hitbox debug view, in world coordinates.
export type HitboxShape =
  | { kind: 'circle'; x: number; y: number; radius: number; color: string }
  | { kind: 'polygon'; points: number[]; color: string }

export const HITBOX_COLORS = {
  local: '#4cff8a',
  character: '#ff5a5f',
  entity: '#ffb347',
} as const

// Every body that can touch something, as the simulator sees it, whatever it is drawn as: living
// champions by their body circle and entities by their circle or rectangle. It reads the same
// positions and sizes the game draws and judges hits by, so it stays right when everything is a sprite.
export function hitboxShapes(
  characters: readonly RenderedCharacter[],
  entities: readonly RenderedEntity[],
  localCharacterId: number | undefined,
): HitboxShape[] {
  const shapes: HitboxShape[] = []
  for (const character of characters) {
    // The dead are ghosts: nothing touches them.
    if (character.dead) continue
    shapes.push({
      kind: 'circle',
      x: character.position.x,
      y: character.position.y,
      radius: character.champion.radius,
      color: character.id === localCharacterId ? HITBOX_COLORS.local : HITBOX_COLORS.character,
    })
  }
  for (const entity of entities) {
    if (entity.box) {
      // A rectangle points the way it faces, `halfLength` along that and `halfWidth` across.
      const facing = entity.facing ?? { x: 1, y: 0 }
      const { halfLength, halfWidth } = entity.box
      const corner = (along: number, across: number): [number, number] => [
        entity.position.x + facing.x * along - facing.y * across,
        entity.position.y + facing.y * along + facing.x * across,
      ]
      shapes.push({
        kind: 'polygon',
        points: [corner(-halfLength, -halfWidth), corner(halfLength, -halfWidth), corner(halfLength, halfWidth), corner(-halfLength, halfWidth)].flat(),
        color: HITBOX_COLORS.entity,
      })
    } else {
      shapes.push({ kind: 'circle', x: entity.position.x, y: entity.position.y, radius: entity.radius, color: HITBOX_COLORS.entity })
    }
  }
  return shapes
}
