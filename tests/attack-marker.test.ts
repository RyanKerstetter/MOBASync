import assert from 'node:assert/strict'
import test from 'node:test'
import { ATTACK_MARKER_STYLE, chooseAttackMarkers, layoutAttackMarker } from '../apps/client/src/attack-marker.ts'

test('an enemy under the mouse is marked as one a click would attack', () => {
  assert.deepEqual(
    chooseAttackMarkers({ hoveredId: 3, lockedId: undefined }),
    [{ kind: 'hover', targetId: 3 }],
  )
})

test('the enemy the attack is locked on is marked for as long as it is, mouse or no mouse', () => {
  assert.deepEqual(
    chooseAttackMarkers({ hoveredId: undefined, lockedId: 2 }),
    [{ kind: 'locked', targetId: 2 }],
  )
})

test('an enemy that is both locked and hovered shows only the lock, and a second hovered one shows both', () => {
  assert.deepEqual(chooseAttackMarkers({ hoveredId: 2, lockedId: 2 }), [{ kind: 'locked', targetId: 2 }])
  assert.deepEqual(chooseAttackMarkers({ hoveredId: 3, lockedId: 2 }), [
    { kind: 'locked', targetId: 2 },
    { kind: 'hover', targetId: 3 },
  ])
})

test('nothing hovered and nothing locked marks nothing', () => {
  assert.deepEqual(chooseAttackMarkers({ hoveredId: undefined, lockedId: undefined }), [])
})

test('the marker is four short ticks close around the body, one on each side, pointing in at it', () => {
  const radius = 18
  const shape = layoutAttackMarker(radius)

  assert.equal(shape.ticks.length, 4)
  for (const tick of shape.ticks) {
    const outer = Math.hypot(tick.from.x, tick.from.y)
    const inner = Math.hypot(tick.to.x, tick.to.y)
    assert.ok(inner > radius, 'it stops short of the body')
    assert.ok(outer > inner, 'and points in')
    assert.ok(outer - radius <= 10, 'staying within a few pixels of it')
  }
  const sides = shape.ticks.map((tick) => `${Math.sign(tick.from.x)},${Math.sign(tick.from.y)}`).sort()
  assert.deepEqual(sides, ['-1,0', '0,-1', '0,1', '1,0'])
})

test('the marker keeps its distance from the body whatever the body\'s size', () => {
  const reach = (radius: number): number => Math.hypot(layoutAttackMarker(radius).ticks[0].from.x, layoutAttackMarker(radius).ticks[0].from.y) - radius
  assert.equal(reach(30), reach(15))
})

test('a lock reads as stronger than a hover: thicker, and a different colour', () => {
  assert.ok(ATTACK_MARKER_STYLE.locked.width > ATTACK_MARKER_STYLE.hover.width)
  assert.notEqual(ATTACK_MARKER_STYLE.locked.color, ATTACK_MARKER_STYLE.hover.color)
})
