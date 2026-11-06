import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_ATTACK_MARKER_SIZE, MIN_ATTACK_MARKER_SIZE } from '../apps/client/src/game-settings.ts'
import { ATTACK_MARKER_STYLE, attackMarkerLook, chooseAttackMarkers, layoutAttackMarker, type AttackMarkerShape } from '../apps/client/src/render/attack-marker.ts'

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

test('the lock can be drawn bigger: its gap, its ticks and its line all grow by the scale, and the hover stays its own size', () => {
  const radius = 18
  // The biggest the graphics menu allows, which is in percent of the marker's own size.
  const scale = MAX_ATTACK_MARKER_SIZE / MIN_ATTACK_MARKER_SIZE
  assert.ok(scale > 1)
  const gap = (shape: AttackMarkerShape): number => Math.hypot(shape.ticks[0].to.x, shape.ticks[0].to.y) - radius
  const length = (shape: AttackMarkerShape): number => Math.hypot(shape.ticks[0].from.x, shape.ticks[0].from.y) - Math.hypot(shape.ticks[0].to.x, shape.ticks[0].to.y)
  const near = (actual: number, expected: number, what: string): void => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} against ${expected}`)

  const plain = attackMarkerLook('locked', radius)
  assert.deepEqual(plain, { shape: layoutAttackMarker(radius), stroke: ATTACK_MARKER_STYLE.locked }, 'at its own size it is as it always was')
  const big = attackMarkerLook('locked', radius, scale)
  assert.equal(big.shape.ticks.length, plain.shape.ticks.length)
  near(gap(big.shape), gap(plain.shape) * scale, 'the gap to the body')
  near(length(big.shape), length(plain.shape) * scale, 'the ticks')
  near(big.stroke.width, ATTACK_MARKER_STYLE.locked.width * scale, 'the line')
  assert.equal(big.stroke.color, ATTACK_MARKER_STYLE.locked.color, 'in the same colour')
  assert.deepEqual(attackMarkerLook('hover', radius, scale), { shape: layoutAttackMarker(radius), stroke: ATTACK_MARKER_STYLE.hover }, 'and the hover is left as it is')
})
