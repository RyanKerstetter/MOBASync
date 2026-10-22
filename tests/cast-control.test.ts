import assert from 'node:assert/strict'
import test from 'node:test'
import { CastControl } from '../apps/client/src/cast-control.ts'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { withinCastRange } from '../packages/shared/src/index.ts'
import { brawler, grenadier } from './fixtures.ts'

test('quick cast with indicator is the default', () => {
  assert.equal(new CastControl().mode, 'quick-with-indicator')
})

test('quick cast casts the moment a key goes down, and letting go does nothing', () => {
  const control = new CastControl('quick')

  assert.deepEqual(control.press(2, true), { type: 'cast', slot: 2 })
  assert.equal(control.aiming, undefined, 'nothing is ever aimed')
  assert.deepEqual(control.release(2), { type: 'nothing' })
  assert.deepEqual(control.press(0, false), { type: 'cast', slot: 0 })
})

test('with the indicator, holding a key aims and letting it go casts, once', () => {
  const control = new CastControl('quick-with-indicator')

  assert.deepEqual(control.press(2, true), { type: 'aim', slot: 2 })
  assert.equal(control.aiming, 2)
  assert.deepEqual(control.release(2), { type: 'cast', slot: 2 })
  assert.equal(control.aiming, undefined)
  assert.deepEqual(control.release(2), { type: 'nothing' }, 'a second release casts nothing')
})

test('with the indicator, a self-cast still casts on the press, and leaves any aim alone', () => {
  const control = new CastControl('quick-with-indicator')
  control.press(1, true)

  assert.deepEqual(control.press(0, false), { type: 'cast', slot: 0 })
  assert.equal(control.aiming, 1)
  assert.deepEqual(control.release(0), { type: 'nothing' })
})

test('with the indicator, pressing another key moves the aim to it and only that key casts', () => {
  const control = new CastControl('quick-with-indicator')
  control.press(1, true)

  assert.deepEqual(control.press(3, true), { type: 'aim', slot: 3 })
  assert.deepEqual(control.release(1), { type: 'nothing' }, 'the first key no longer casts')
  assert.equal(control.aiming, 3)
  assert.deepEqual(control.release(3), { type: 'cast', slot: 3 })
})

test('cancelling drops the aim, so letting go afterwards casts nothing', () => {
  const control = new CastControl('quick-with-indicator')
  control.press(2, true)

  control.cancel()
  assert.equal(control.aiming, undefined)
  assert.deepEqual(control.release(2), { type: 'nothing' })
})

// The test brawler's kit: a self-cast, then unit (range 200), direction (450) and point (300).
function createClient(enemyGap = 40): ClientGameState {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 100 + enemyGap, y: 100 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  return gameState
}

test('an ability that gives two circles hands both to the renderer, held to range like any ground target', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, grenadier)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  // The flashbang is the third slot (the grenade, the molotov, then the flashbang).
  const preview = gameState.getCastPreview(2, { x: 900, y: 100 }, 0)

  assert.equal(preview?.abilityId, 't-flashbang')
  assert.deepEqual(preview?.indicator, { radius: 120, innerRadius: 50 })
  assert.deepEqual(preview?.target, { mode: 'point', point: { x: 500, y: 100 } })
  // An ability with one circle is untouched.
  assert.deepEqual(gameState.getCastPreview(0, { x: 200, y: 100 }, 0)?.indicator, undefined)
})

test('only abilities with something to aim are held for an indicator', () => {
  const gameState = createClient()

  assert.deepEqual([0, 1, 2, 3].map((slot) => gameState.abilityNeedsAim(slot)), [false, true, true, true])
  assert.equal(gameState.abilityNeedsAim(7), false, 'an empty slot')
})

test('the indicator shows exactly where letting go would cast', () => {
  const gameState = createClient()

  const point = gameState.getCastPreview(3, { x: 700, y: 100 }, 0)
  assert.deepEqual(point, {
    abilityId: 't-meteor',
    targeting: 'point',
    range: 300,
    indicator: { radius: 90 },
    target: { mode: 'point', point: { x: 400, y: 100 } },
  }, 'a ground target is held to the range')

  const direction = gameState.getCastPreview(2, { x: 100, y: 300 }, 0)
  assert.deepEqual(direction?.target, { mode: 'direction', dir: { x: 0, y: 1 } })
  assert.equal(direction?.range, 450)
  assert.deepEqual(direction?.indicator, { width: 16 }, 'drawn as wide as the ability says')

  assert.deepEqual(gameState.getCastPreview(1, { x: 142, y: 103 }, 0)?.target, { mode: 'unit', unitId: 2 })

  // And the cast itself agrees.
  const cast = gameState.createCastOrder(3, { x: 700, y: 100 }, 0)
  assert.ok(cast.ok)
  assert.deepEqual(cast.order.target, point?.target)
})

test('an aim that would not cast still shows the range, with nothing to target', () => {
  const gameState = createClient()

  const overGround = gameState.getCastPreview(1, { x: 300, y: 300 }, 0)
  assert.deepEqual(overGround, { abilityId: 't-lash', targeting: 'unit', range: 200 })
  const onSelf = gameState.getCastPreview(2, { x: 100, y: 100 }, 0)
  assert.deepEqual(onSelf, { abilityId: 't-bolt', targeting: 'direction', range: 450, indicator: { width: 16 } })
  assert.equal(gameState.getCastPreview(7, { x: 300, y: 300 }, 0), undefined, 'an empty slot has no indicator')
})

test('showing an indicator issues nothing: the next order is the same with or without one', () => {
  // Both draw frames as the game does; only one also shows an indicator on every frame.
  const plain = createClient()
  const previewed = createClient()
  for (let now = 0; now <= 200; now += 10) {
    plain.getCharacters(now)
    previewed.getCharacters(now)
    previewed.getCastPreview(3, { x: 300, y: 300 }, now)
    previewed.getCastBlocker(3, now)
  }

  const first = plain.createCastOrder(3, { x: 300, y: 300 }, 200)
  const second = previewed.createCastOrder(3, { x: 300, y: 300 }, 200)
  assert.ok(first.ok && second.ok)
  assert.deepEqual(second.order, first.order)
})

test('an ability that cannot be cast whatever the aim says why before it is aimed', () => {
  const gameState = createClient()

  assert.equal(gameState.getCastBlocker(3, 0), undefined)
  assert.equal(gameState.getCastBlocker(7, 0), 'No ability is bound to that key.')
  const cast = gameState.createCastOrder(3, { x: 300, y: 100 }, 0)
  assert.ok(cast.ok)
  // A second later the windup has long launched and the cooldown is running.
  assert.equal(gameState.getCastBlocker(3, 1000), 't-meteor is on cooldown.')
  assert.equal(gameState.getCastBlocker(2, 1000), undefined, 'the other abilities are unaffected')
})

test('a cast reaches exactly as far as its range, centre to centre', () => {
  const origin = { x: 100, y: 100 }

  assert.equal(withinCastRange(origin, { x: 300, y: 100 }, 200), true, 'on the edge')
  assert.equal(withinCastRange(origin, { x: 301, y: 100 }, 200), false)
  assert.equal(withinCastRange(origin, { x: 220, y: 260 }, 200), true, 'a 120 by 160 gap is 200 away')
  assert.equal(withinCastRange(origin, { x: 221, y: 260 }, 200), false)
})

test('a unit ability aimed at an enemy beyond its range is refused with a reason, and issues nothing', () => {
  // The test lash reaches 200; this enemy is 300 away and is drawn right under the cursor.
  const far = createClient(300)
  const near = createClient(200)

  const refused = far.createCastOrder(1, { x: 400, y: 100 }, 0)
  assert.equal(refused.ok, false)
  assert.match(refused.ok ? '' : refused.reason, /out of range/)
  // Right on its reach it casts.
  assert.equal(near.createCastOrder(1, { x: 300, y: 100 }, 0).ok, true)
  // The refused cast used up no order number or tick: the next order is the first.
  const move = far.createMoveOrder({ x: 200, y: 100 }, 0)
  assert.equal(move?.seq, 1)
})

test('the indicator shows an out of range target, marked so it can be drawn as one that will not cast', () => {
  const far = createClient(300)
  const near = createClient(150)

  assert.deepEqual(far.getCastPreview(1, { x: 400, y: 100 }, 0), {
    abilityId: 't-lash',
    targeting: 'unit',
    range: 200,
    target: { mode: 'unit', unitId: 2 },
    outOfRange: true,
  })
  const inReach = near.getCastPreview(1, { x: 250, y: 100 }, 0)
  assert.deepEqual(inReach?.target, { mode: 'unit', unitId: 2 })
  assert.equal(inReach?.outOfRange, undefined)
})

test('reach is judged where the simulator will judge it, not where the enemy is drawn', () => {
  // A remote champion is drawn a little in the past, so its drawn spot can be inside the range
  // while the real one, which is what the simulator measures, is not.
  // Walking away at 220 a second: by tick 8 the real enemy is 205.7 from the caster and the drawn
  // one, two ticks behind, is 198.3.
  const gameState = createClient(180)
  gameState.simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 1, type: 'move', target: { x: 600, y: 100 } })
  gameState.resetServerTickAnchor(8, 0)
  const now = 0

  const drawn = gameState.getCharacters(now).find((character) => character.id === 2)
  const real = gameState.simulator.at(8).get(2)?.getPosition()
  assert.ok(drawn && real)
  assert.ok(drawn.position.x < real.x, 'drawn behind where the enemy really is')
  const origin = gameState.simulator.at(8).get(1)?.getPosition() ?? { x: 0, y: 0 }
  assert.equal(withinCastRange(origin, drawn.position, 200), true)
  assert.equal(withinCastRange(origin, real, 200), false)

  const preview = gameState.getCastPreview(1, drawn.position, now)
  assert.equal(preview?.outOfRange, true, 'so the ring is red')
})
