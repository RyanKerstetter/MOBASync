import type { RenderedCharacter, RenderedEntity } from '../game-state.ts'

// One outline to draw for the hitbox debug view, in world coordinates.
export type HitboxShape =
  // `outline` is a circle that only marks a range, so it is not filled.
  | { kind: 'circle'; x: number; y: number; radius: number; color: string; outline?: boolean }
  | { kind: 'polygon'; points: number[]; color: string }

export const HITBOX_COLORS = {
  local: '#4cff8a',
  character: '#ff5a5f',
  entity: '#ffb347',
  // The ranges of a monster: how near someone has to be to be noticed (round the monster), and how far from its home it goes
  // before it starts to give up (round its home, which is marked).
  aggro: '#ffd166',
  deaggro: '#f4845f',
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
    const monster = character.monster
    if (monster) {
      const { x, y } = character.position
      shapes.push(
        { kind: 'circle', x, y, radius: monster.aggroRange, color: HITBOX_COLORS.aggro, outline: true },
        { kind: 'circle', x: monster.home.x, y: monster.home.y, radius: monster.deaggroRange, color: HITBOX_COLORS.deaggro, outline: true },
        { kind: 'circle', x: monster.home.x, y: monster.home.y, radius: 6, color: HITBOX_COLORS.deaggro },
      )
    }
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
