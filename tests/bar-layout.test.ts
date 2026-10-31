import assert from 'node:assert/strict'
import test from 'node:test'
import { ATTACK_BAR_HEIGHT, attackBarTop, BAR_GAP, meterBarTop, METER_BAR_HEIGHT } from '../apps/client/src/render/bar-layout.ts'

// A body of this radius, and a figure that reaches this far up: the same as the body (a champion drawn as a plain circle, or a sprite that is no taller than it),
// a little taller, or a lot taller.
const FIGURES: Array<[radius: number, above: number]> = [[24, 24], [20, 20], [21, 26], [24, 30], [20, 60], [24, 120]]

const overlap = (top: number, height: number, otherTop: number, otherHeight: number): boolean =>
  top < otherTop + otherHeight && otherTop < top + height

test('the attack bar and a meter never overlap, whatever the figure\'s height', () => {
  for (const [radius, above] of FIGURES) {
    const meter = meterBarTop(above)
    const attack = attackBarTop(radius, above, true)
    assert.equal(overlap(attack, ATTACK_BAR_HEIGHT, meter, METER_BAR_HEIGHT), false, `radius ${radius}, figure ${above} up: attack bar at ${attack}, meter at ${meter}`)
  }
})

test('the attack bar goes just below a meter that it would have been drawn over, and no further than it has to', () => {
  const [radius, above] = [24, 24]
  assert.equal(overlap(-radius - 8, ATTACK_BAR_HEIGHT, meterBarTop(above), METER_BAR_HEIGHT), true, 'in its usual place it would be over the meter')
  const attack = attackBarTop(radius, above, true)
  const gap = attack - (meterBarTop(above) + METER_BAR_HEIGHT)
  assert.ok(gap >= 0, `it is under the meter, clear of it (${gap})`)
  assert.ok(gap <= BAR_GAP, `and right under it (${gap})`)
})

test('the attack bar is where it always was when there is no meter, and when the figure is tall enough that the meter is clear of it', () => {
  for (const [radius, above] of FIGURES) assert.equal(attackBarTop(radius, above, false), -radius - 8, `no meter: radius ${radius}`)
  // A tall figure has the meter well above where the attack bar is, so it does not move.
  assert.equal(attackBarTop(20, 60, true), -20 - 8)
  assert.equal(attackBarTop(24, 120, true), -24 - 8)
})

test('the meter is just under the health bar, which is over the top of the figure', () => {
  for (const [, above] of FIGURES) assert.ok(meterBarTop(above) < -above, `${above}`)
})
