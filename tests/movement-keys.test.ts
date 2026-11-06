import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { abilityKeyCodes, isMovementKey, keyLabel, MOVEMENT_KEY_DIRECTIONS, MovementKeys, STEER_RESUME_INTERVAL_MS } from '../apps/client/src/movement-keys.ts'
import { champions, isValidSteerDirection, type Vector2 } from '../packages/shared/src/index.ts'

// The movement keys: W, A, S and D make a direction, and the champion is given it only when it changes, a stop when the last key is let go, and its direction again
// only when the game has left it standing.

const STOP: Vector2 = { x: 0, y: 0 }
const MOVEMENT_CODES = Object.keys(MOVEMENT_KEY_DIRECTIONS)

test('each key steers its own way, two at right angles steer halfway between at the same speed, and two that are opposite steer nowhere', () => {
  assert.deepEqual(MOVEMENT_CODES.sort(), ['KeyA', 'KeyD', 'KeyS', 'KeyW'])
  for (const code of MOVEMENT_CODES) {
    const keys = new MovementKeys()
    assert.deepEqual(keys.press(code, 0), MOVEMENT_KEY_DIRECTIONS[code], code)
  }
  const slant = new MovementKeys()
  slant.press('KeyW', 0)
  const upRight = slant.press('KeyD', 0)
  assert.ok(upRight && upRight.x > 0 && upRight.y < 0, JSON.stringify(upRight))
  assert.ok(upRight && isValidSteerDirection(upRight), 'a direction the game takes')

  const opposite = new MovementKeys()
  opposite.press('KeyA', 0)
  assert.deepEqual(opposite.press('KeyD', 0), STOP, 'left and right together is a stop')
  assert.deepEqual(opposite.release('KeyA', 0), MOVEMENT_KEY_DIRECTIONS.KeyD, 'and letting go of one steers by the other')
})

test('only a change is given: a key held down, or pressed again, gives nothing more', () => {
  const keys = new MovementKeys()
  assert.ok(keys.press('KeyW', 0))
  assert.equal(keys.press('KeyW', 10), undefined, 'a key that is already down')
  assert.equal(keys.press('KeyQ', 10), undefined, 'a key that is not a movement key')
  assert.equal(keys.release('KeyS', 10), undefined, 'a key that was not down')
  assert.deepEqual(keys.release('KeyW', 20), STOP, 'the last key let go is a stop')
  assert.equal(keys.releaseAll(30), undefined, 'and with nothing down there is nothing more to stop')
})

test('every key let go at once is a stop, if the champion was being steered', () => {
  const keys = new MovementKeys()
  assert.equal(keys.releaseAll(0), undefined)
  keys.press('KeyW', 0)
  keys.press('KeyA', 0)
  assert.deepEqual(keys.releaseAll(10), STOP)
  assert.equal(keys.isSteering, false)
})

test('after another order the keys steer again on their next change, and letting go of them still gives a stop, which does nothing to a champion that is not steered', () => {
  const keys = new MovementKeys()
  keys.press('KeyW', 0)
  keys.press('KeyD', 0)
  keys.interrupt()
  assert.equal(keys.isSteering, false)
  assert.deepEqual(keys.release('KeyD', 10), MOVEMENT_KEY_DIRECTIONS.KeyW, 'the next change steers again')
  keys.interrupt()
  assert.deepEqual(keys.release('KeyW', 20), STOP, 'a stop, in case what was given was not done')
})

test('a champion the keys steer that is standing about is given its direction again, but not more than once an interval', () => {
  const keys = new MovementKeys()
  keys.press('KeyS', 0)
  assert.equal(keys.resume(STEER_RESUME_INTERVAL_MS * 4, false), undefined, 'not while it is walking')
  assert.equal(keys.resume(STEER_RESUME_INTERVAL_MS - 1, true), undefined, 'not straight after it was given')
  const later = STEER_RESUME_INTERVAL_MS * 2
  assert.deepEqual(keys.resume(later, true), MOVEMENT_KEY_DIRECTIONS.KeyS)
  assert.equal(keys.resume(later + STEER_RESUME_INTERVAL_MS - 1, true), undefined, 'and not again too soon')
  assert.deepEqual(keys.resume(later + STEER_RESUME_INTERVAL_MS, true), MOVEMENT_KEY_DIRECTIONS.KeyS)
  keys.interrupt()
  assert.equal(keys.resume(later * 10, true), undefined, 'and never once it was told something else')
})

test('with the movement keys on the abilities are cast with Q, E and R, which no movement key is, and every champion\'s abilities have a key', () => {
  assert.deepEqual(abilityKeyCodes(false).map(keyLabel), ['Q', 'W', 'E', 'R'])
  assert.deepEqual(abilityKeyCodes(true).map(keyLabel), ['Q', 'E', 'R'])
  assert.equal(abilityKeyCodes(true).some(isMovementKey), false)
  for (const champion of champions.values()) {
    assert.ok(champion.abilities.length <= abilityKeyCodes(true).length, `${champion.id} has a key for each ability`)
  }
})

test('the client makes a steer order with the direction given and what it does to a windup', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 })
  gameState.setLocalCharacterId(1)
  const order = gameState.createSteerOrder(MOVEMENT_KEY_DIRECTIONS.KeyD, 0, { keepAuto: true, keepCast: false })
  assert.ok(order)
  assert.equal(order.type, 'steer')
  assert.deepEqual(order.direction, MOVEMENT_KEY_DIRECTIONS.KeyD)
  assert.equal(order.keepAuto, true)
  assert.equal(order.keepCast, false)
  assert.equal(new ClientGameState().createSteerOrder(MOVEMENT_KEY_DIRECTIONS.KeyD, 0), undefined, 'and none with no champion')
})
