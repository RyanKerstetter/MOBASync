import assert from 'node:assert/strict'
import test from 'node:test'
import type { Container, Graphics } from 'pixi.js'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { BACK_MOTE_MS, BACK_MOTES, layoutBack } from '../apps/client/src/render/back-look.ts'
import { BLEED_PULSE_MS } from '../apps/client/src/render/bleed-look.ts'
import { CharacterLayer } from '../apps/client/src/render/character-layer.ts'
import { GAME_MAX_CHAMPION_RADIUS, getChampion } from '../packages/shared/src/index.ts'

// How a champion going back is drawn: a ring at its feet whose bright arc closes as the channel runs, a glow that grows, and motes that rise round it. The numbers are read from
// the module, so retuning the look does not break these.

const R = GAME_MAX_CHAMPION_RADIUS

test('the ring round a champion going back closes as the channel runs, from none to a whole turn, and the glow grows', () => {
  const start = layoutBack(0, 0, R)
  const half = layoutBack(0.5, 0, R)
  const end = layoutBack(1, 0, R)
  assert.equal(start.sweep, 0)
  assert.ok(Math.abs(half.sweep - Math.PI) < 1e-9)
  assert.ok(Math.abs(end.sweep - 2 * Math.PI) < 1e-9)
  assert.ok(start.glowAlpha < half.glowAlpha && half.glowAlpha < end.glowAlpha)
  assert.ok(start.ringRadius > R, 'the ring is round the body, outside it')
  assert.deepEqual(layoutBack(2, 0, R), end, 'and holds at a whole turn')
  assert.deepEqual(layoutBack(-1, 0, R), start, 'and at none')
})

test('motes rise round a champion going back, and are brighter as it nears the end', () => {
  const time = BACK_MOTE_MS * 5
  const now = layoutBack(0.5, time, R).motes
  assert.equal(now.length, BACK_MOTES)
  const soon = layoutBack(0.5, time + BACK_MOTE_MS * 0.25, R).motes
  assert.ok(soon[0].y < now[0].y, 'a mote rises')
  for (const mote of now) {
    assert.ok(Math.abs(mote.x) <= R && mote.alpha >= 0 && mote.alpha <= 1)
  }
  const brightest = (progress: number) => Math.max(...layoutBack(progress, time, R).motes.map((mote) => mote.alpha))
  assert.ok(brightest(1) > brightest(0))
})

test('the layer draws a ring and motes round a champion going back, and blood and a red flush on one that bleeds, and nothing of either otherwise', () => {
  const state = new ClientGameState()
  const aurel = getChampion('aurel')
  state.simulator.addPlayer(1, 'p1', 'One', { x: 400, y: 400 }, aurel, 1)
  state.simulator.advanceTo(1)
  const [plain] = state.getCharacters(0)
  assert.ok(plain)
  // No sprite sets, so the body is drawn as a shape: what is under it comes first in its node, and what is over it after.
  const layer = new CharacterLayer(new Map())
  const node = (): Container => layer.view.children[0] as Container
  const ground = (): Graphics => node().children[0] as Graphics
  const body = (): Graphics => node().children[1] as Graphics
  const over = (): Graphics => node().children[2] as Graphics
  const width = (graphics: Graphics): number => graphics.getLocalBounds().width

  // At the reddest of the flush.
  const now = BLEED_PULSE_MS / 2
  layer.update([{ ...plain, backing: 0.5, bleeding: true }], 1, undefined, now)
  assert.ok(width(ground()) > 2 * aurel.radius, 'a ring round the body')
  assert.ok(width(over()) > 0, 'drops and motes over it')
  assert.notEqual(body().tint, 0xffffff, 'and it flushes red')

  layer.update([plain], 1, undefined, now)
  assert.equal(width(ground()), 0)
  assert.equal(width(over()), 0)
  assert.equal(body().tint, 0xffffff, 'and is drawn as it is')

  layer.update([{ ...plain, backing: 0.5, bleeding: true, dead: true }], 1, undefined, now)
  assert.equal(width(ground()) + width(over()), 0, 'a dead body shows neither')
})
