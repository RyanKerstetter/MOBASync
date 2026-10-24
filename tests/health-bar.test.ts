import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutHealthBar } from '../apps/client/src/render/health-bar.ts'

const ticks = { every: 100, major: 1000 }

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not close to ${expected}`)
}

test('the shield is laid on the end of the health, and the missing health is left after it', () => {
  const layout = layoutHealthBar({ hp: 600, maxHp: 1000, shield: 200 }, 100, ticks)

  assertClose(layout.healthWidth, 60)
  assertClose(layout.shieldWidth, 20)
  // 60 + 20 of 100 filled; the last 20 is the health still missing.
  assert.ok(layout.healthWidth + layout.shieldWidth < 100)
})

test('a shield that carries the total past the maximum shrinks the health to make room', () => {
  const layout = layoutHealthBar({ hp: 900, maxHp: 1000, shield: 300 }, 100, ticks)

  // The bar now stands for 1200, so 900 of it is 75% and the shield the last 25%.
  assertClose(layout.healthWidth, 75)
  assertClose(layout.shieldWidth, 25)
  assertClose(layout.healthWidth + layout.shieldWidth, 100)
})

test('a tick marks every 100 health across the bar, but not its two ends', () => {
  const layout = layoutHealthBar({ hp: 500, maxHp: 500, shield: 0 }, 100, ticks)

  assert.deepEqual(layout.ticks.map((tick) => tick.x), [20, 40, 60, 80])
  assert.equal(layout.ticks.every((tick) => !tick.major), true)
})

test('a tick for every thousand is marked as the bigger one, wherever the bar puts it', () => {
  const layout = layoutHealthBar({ hp: 1500, maxHp: 1500, shield: 0 }, 150, ticks)

  assert.equal(layout.ticks.length, 14)
  const major = layout.ticks.filter((tick) => tick.major)
  assert.equal(major.length, 1)
  assertClose(major[0].x, 100)
  // The tick at 100 and at 1100 are small.
  assertClose(layout.ticks[0].x, 10)
  assert.equal(layout.ticks[0].major, false)
  assert.equal(layout.ticks[10].major, false)
})

test('ticks follow the bar when a shield stretches it', () => {
  const plain = layoutHealthBar({ hp: 1000, maxHp: 1000, shield: 0 }, 100, ticks)
  const shielded = layoutHealthBar({ hp: 1000, maxHp: 1000, shield: 500 }, 100, ticks)

  assert.equal(plain.ticks.some((tick) => tick.major), false, 'a thousand is the edge of the plain bar')
  const major = shielded.ticks.filter((tick) => tick.major)
  assert.equal(major.length, 1, 'and it is inside the stretched one')
  assertClose(major[0].x, 100 * 1000 / 1500)
  assert.equal(shielded.ticks.length, 14)
})

test('the tick spacing is whatever it is asked for', () => {
  const layout = layoutHealthBar({ hp: 400, maxHp: 400, shield: 0 }, 80, { every: 50, major: 200 })

  assert.deepEqual(layout.ticks.map((tick) => tick.x), [10, 20, 30, 40, 50, 60, 70])
  assert.deepEqual(layout.ticks.filter((tick) => tick.major).map((tick) => tick.x), [40])
  assert.deepEqual(layoutHealthBar({ hp: 400, maxHp: 400, shield: 0 }, 80, { every: 0, major: 0 }).ticks, [])
})

test('an empty or odd bar never produces negative or invalid widths', () => {
  const empty = layoutHealthBar({ hp: 0, maxHp: 800, shield: 0 }, 100, ticks)
  assert.equal(empty.healthWidth, 0)
  assert.equal(empty.shieldWidth, 0)

  const odd = layoutHealthBar({ hp: -5, maxHp: 0, shield: -3 }, 100, ticks)
  assert.equal(odd.healthWidth, 0)
  assert.equal(odd.shieldWidth, 0)
  assert.deepEqual(odd.ticks, [])

  const onlyShield = layoutHealthBar({ hp: 0, maxHp: 800, shield: 200 }, 100, ticks)
  assert.equal(onlyShield.healthWidth, 0)
  assertClose(onlyShield.shieldWidth, 25)
})
