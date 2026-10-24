import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutStackPips, type StackPip } from '../apps/client/src/render/stack-pips.ts'

const RADIUS = 16

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not close to ${expected}`)
}

const apart = (left: StackPip, right: StackPip): number => Math.hypot(left.x - right.x, left.y - right.y)

test('marks others put on a champion are a row of diamonds under it, centred on it', () => {
  const pips = layoutStackPips({ curse: 3 }, RADIUS)

  assert.equal(pips.length, 3)
  assert.ok(pips.every((pip) => pip.shape === 'diamond'))
  assert.deepEqual(pips.map((pip) => pip.x), [-9, 0, 9])
  pips.forEach((pip) => assertClose(pip.y, RADIUS + 10))
})

test('a champion\'s own stacks are a row of round pips, in the same first row', () => {
  const pips = layoutStackPips({ sword: 2 }, RADIUS)

  assert.deepEqual(pips.map((pip) => pip.shape), ['circle', 'circle'])
  assert.deepEqual(pips.map((pip) => pip.x), [-4.5, 4.5])
  pips.forEach((pip) => assertClose(pip.y, RADIUS + 10))
})

test('a Swordsman carrying a Grenadier\'s marks keeps them in their own row, clear of its sword stacks', () => {
  const pips = layoutStackPips({ sword: 3, sighted: 2 }, RADIUS)
  const sword = pips.filter((pip) => pip.shape === 'circle')
  const sighted = pips.filter((pip) => pip.shape === 'diamond')

  assert.equal(sword.length, 3)
  assert.equal(sighted.length, 2)
  // Own stacks nearest the body, the marks in a row below them.
  assert.ok(sword.every((pip) => pip.y === RADIUS + 10))
  assert.ok(sighted.every((pip) => pip.y > RADIUS + 10 + 9), 'a full pip below, not touching')
  // Each row is centred on the champion on its own.
  assertClose(sword.reduce((sum, pip) => sum + pip.x, 0), 0)
  assertClose(sighted.reduce((sum, pip) => sum + pip.x, 0), 0)
  // No two pips overlap, whatever their rows.
  for (const left of pips) {
    for (const right of pips.filter((other) => other !== left)) {
      assert.ok(apart(left, right) >= 9, `pips at (${left.x}, ${left.y}) and (${right.x}, ${right.y}) are too close`)
    }
  }
})

test('no stack of a champion\'s own looks like a mark that could land on it: not in colour, and not in shape', () => {
  for (const own of ['sword', 'empowered', 'shadow']) {
    for (const mark of ['curse', 'gale', 'sighted', 'trick']) {
      const [ownPip, markPip] = layoutStackPips({ [own]: 1, [mark]: 1 }, RADIUS)
      assert.notEqual(ownPip.color, markPip.color, `${own} and ${mark} are different colours`)
      assert.notEqual(ownPip.shape, markPip.shape, `${own} and ${mark} are different shapes`)
      assert.ok(ownPip.y < markPip.y, `${own} and ${mark} are in different rows`)
    }
  }
})

test('every kind of stack has a colour of its own', () => {
  const kinds = ['sword', 'empowered', 'shadow', 'curse', 'gale', 'sighted', 'trick']
  const colors = kinds.map((kind) => layoutStackPips({ [kind]: 1 }, RADIUS)[0].color)

  assert.equal(new Set(colors).size, kinds.length)
})

test('a kind with nothing on the champion takes no room, and unknown or empty counts draw nothing', () => {
  assert.deepEqual(layoutStackPips({}, RADIUS), [])
  assert.deepEqual(layoutStackPips({ sword: 0, sighted: 0, unheardOf: 4 }, RADIUS), [])
  // With no stacks of its own, the marks take the first row rather than leaving a gap above them.
  assertClose(layoutStackPips({ sighted: 1 }, RADIUS)[0].y, RADIUS + 10)
})

test('the rows sit below a bigger body just as far from its edge', () => {
  const small = layoutStackPips({ sword: 1, sighted: 1 }, 14)
  const big = layoutStackPips({ sword: 1, sighted: 1 }, 20)

  assertClose(big[0].y - small[0].y, 6)
  assertClose(big[1].y - small[1].y, 6)
})
