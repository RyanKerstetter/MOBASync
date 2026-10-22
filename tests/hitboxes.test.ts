import assert from 'node:assert/strict'
import test from 'node:test'
import { HITBOX_COLORS, hitboxShapes } from '../apps/client/src/hitboxes.ts'
import type { RenderedCharacter, RenderedEntity } from '../apps/client/src/game-state.ts'

const character = (id: number, x: number, dead = false): RenderedCharacter =>
  ({ id, position: { x, y: 50 }, dead, champion: { radius: 18 } }) as unknown as RenderedCharacter
const entity = (extra: Partial<RenderedEntity>): RenderedEntity =>
  ({ position: { x: 100, y: 100 }, radius: 10, ...extra }) as unknown as RenderedEntity

test('every living champion gets its body circle, yours in its own colour, and the dead get none', () => {
  const shapes = hitboxShapes([character(1, 10), character(2, 20), character(3, 30, true)], [], 1)

  assert.deepEqual(shapes, [
    { kind: 'circle', x: 10, y: 50, radius: 18, color: HITBOX_COLORS.local },
    { kind: 'circle', x: 20, y: 50, radius: 18, color: HITBOX_COLORS.character },
  ])
})

test('a round entity is its circle, and a rectangle is its four corners turned the way it faces', () => {
  const [round, flat, turned] = hitboxShapes([], [
    entity({ radius: 12 }),
    entity({ box: { halfLength: 10, halfWidth: 4 } }),
    entity({ box: { halfLength: 10, halfWidth: 4 }, facing: { x: 0, y: 1 } }),
  ], undefined)

  assert.deepEqual(round, { kind: 'circle', x: 100, y: 100, radius: 12, color: HITBOX_COLORS.entity })
  assert.deepEqual(flat.kind === 'polygon' ? flat.points : [], [90, 96, 110, 96, 110, 104, 90, 104])
  // Facing down the screen, its length runs down and its width across.
  assert.deepEqual(turned.kind === 'polygon' ? turned.points : [], [104, 90, 104, 110, 96, 110, 96, 90])
})

test('nothing in the game is no hitboxes', () => {
  assert.deepEqual(hitboxShapes([], [], undefined), [])
})
