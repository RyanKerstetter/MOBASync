import assert from 'node:assert/strict'
import test from 'node:test'
import { BLEED_DROP_MS, BLEED_DROPS, BLEED_PULSE_MS, BLEED_TINT, bleedTint, layoutBleedDrops } from '../apps/client/src/render/bleed-look.ts'
import { GAME_MAX_CHAMPION_RADIUS } from '../packages/shared/src/index.ts'

// How a bleeding body is drawn: drops that fall from it to its feet, and a red flush on the figure. The numbers are read from the module, so retuning the look does not break these.

const R = GAME_MAX_CHAMPION_RADIUS
const channels = (tint: number) => ({ r: (tint >> 16) & 0xff, g: (tint >> 8) & 0xff, b: tint & 0xff })

test('a bleeding body sheds a set number of drops, each on the body and above its feet, and all of them showing or fading', () => {
  for (const time of [0, 123, BLEED_DROP_MS * 3.7, 98765]) {
    const drops = layoutBleedDrops(7, time, R)
    assert.equal(drops.length, BLEED_DROPS)
    for (const drop of drops) {
      assert.ok(Math.abs(drop.x) <= R, `across the body: ${drop.x}`)
      assert.ok(drop.y >= -R && drop.y <= R, `from the body down to its feet: ${drop.y}`)
      assert.ok(drop.alpha >= 0 && drop.alpha <= 1)
      assert.ok(drop.size > 0)
    }
  }
})

test('a drop falls as time goes on, and starts again from somewhere else once it has landed', () => {
  // The first drop starts its fall on a whole number of falls, and is near the end of it just before the next.
  const start = BLEED_DROP_MS * 10
  const early = layoutBleedDrops(3, start + BLEED_DROP_MS * 0.1, R)[0]
  const later = layoutBleedDrops(3, start + BLEED_DROP_MS * 0.5, R)[0]
  assert.ok(later.y > early.y, 'it falls')
  assert.equal(later.x, early.x, 'straight down')
  assert.equal(early.alpha, 1, 'and shows as it falls')
  assert.ok(layoutBleedDrops(3, start + BLEED_DROP_MS * 0.99, R)[0].alpha < 0.1, 'it fades as it lands')
  const next = [1, 2, 3, 4].map((fall) => layoutBleedDrops(3, start + BLEED_DROP_MS * (fall + 0.1), R)[0].x)
  assert.ok(new Set([early.x, ...next]).size > 1, 'and the next falls start from other places')
})

test('two bodies that bleed at the same time do not drip in step', () => {
  const time = BLEED_DROP_MS * 4.2
  assert.notDeepEqual(layoutBleedDrops(1, time, R), layoutBleedDrops(2, time, R))
  assert.deepEqual(layoutBleedDrops(1, time, R), layoutBleedDrops(1, time, R), 'though one body at one time is always drawn the same')
})

test('a bleeding figure flushes red and pales again, never redder than the bleed tint', () => {
  const at = (time: number) => channels(bleedTint(time))
  assert.deepEqual(at(0), { r: 255, g: 255, b: 255 }, 'as it is, at the palest')
  assert.deepEqual(at(BLEED_PULSE_MS / 2), BLEED_TINT, 'the bleed tint, at the reddest')
  assert.deepEqual(at(BLEED_PULSE_MS), at(0), 'and back')
  for (let time = 0; time < BLEED_PULSE_MS; time += BLEED_PULSE_MS / 17) {
    const { r, g, b } = at(time)
    assert.equal(r, 255)
    assert.ok(g >= BLEED_TINT.g && g <= 255 && b >= BLEED_TINT.b && b <= 255)
  }
})
