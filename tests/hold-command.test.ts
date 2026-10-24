import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  HOLD_ARRIVED_DISTANCE,
  HOLD_COMMAND_INTERVAL_MS,
  HOLD_MOVE_MIN_DISTANCE,
  HoldCommand,
  type HeldCommand,
  type HoldLook,
} from '../apps/client/src/hold-command.ts'
import { brawler } from './fixtures.ts'

// Holding the right button goes on giving the command, but a few times a second, and only when it would change something.

const START = 10_000
const at = (x: number, y = 0) => ({ x, y })
const look = (extra: Partial<HoldLook> = {}): HoldLook => ({ cursor: at(500), position: at(0), moving: false, ...extra })
const ground = (x: number, y = 0): HeldCommand => ({ type: 'move', target: at(x, y) })

// A command that has been pressed on `given` at START, and is looked at by calling `next` at some time with what is true.
function held(given: HeldCommand = ground(500)): HoldCommand {
  const hold = new HoldCommand()
  hold.press(START, given)
  return hold
}

test('nothing is given when the button is not held, and what is looked at is not even asked', () => {
  const hold = new HoldCommand()
  assert.equal(hold.held, false)
  let asked = 0
  assert.equal(hold.next(START + 10_000, () => (asked += 1, look())), undefined)
  assert.equal(asked, 0)
})

test('the first repeat is one interval after the press, and what is looked at is not asked before then', () => {
  const hold = held()
  let asked = 0
  const ask = () => (asked += 1, look({ cursor: at(900) }))
  assert.equal(hold.held, true)
  assert.equal(hold.next(START, ask), undefined)
  assert.equal(hold.next(START + HOLD_COMMAND_INTERVAL_MS - 1, ask), undefined)
  assert.equal(asked, 0, 'the game is not read until the interval is up')
  assert.deepEqual(hold.next(START + HOLD_COMMAND_INTERVAL_MS, ask), { type: 'move', target: at(900) })
  assert.equal(asked, 1)
})

test('a walk follows the cursor, given again as often as the interval allows and no oftener', () => {
  const hold = held()
  const given: HeldCommand[] = []
  // A minute of frames at 60 a second would be 3600 looks; the mouse moves all the time.
  let sent = 0
  for (let frame = 1; frame <= 60; frame += 1) {
    const now = START + Math.round(frame * 1000 / 60)
    const command = hold.next(now, () => look({ cursor: at(500 + frame * 40) }))
    if (command) given.push(command)
    sent += command ? 1 : 0
  }
  assert.equal(sent, given.length)
  assert.ok(given.length >= 6 && given.length <= 7, `${given.length} a second`)
  assert.ok(given.every((command) => command.type === 'move'))
  // Each walks to where the cursor was when it was looked at, one after another further on.
  const xs = given.map((command) => command.type === 'move' ? command.target.x : 0)
  assert.deepEqual([...xs].sort((a, b) => a - b), xs)
})

test('a walk to a place no further than a few units from the last is not given again', () => {
  const hold = held(ground(500))
  let now = START
  const step = (cursor: { x: number; y: number }) => hold.next(now += HOLD_COMMAND_INTERVAL_MS, () => look({ cursor }))
  assert.equal(step(at(500)), undefined, 'the same place')
  assert.equal(step(at(500 + HOLD_MOVE_MIN_DISTANCE - 1)), undefined, 'a hair away')
  assert.deepEqual(step(at(500 + HOLD_MOVE_MIN_DISTANCE)), { type: 'move', target: at(500 + HOLD_MOVE_MIN_DISTANCE) }, 'far enough')
  assert.equal(step(at(500 + HOLD_MOVE_MIN_DISTANCE + 5)), undefined, 'and measured from the last that was given, not the press')
  assert.deepEqual(step(at(0, 300)), { type: 'move', target: at(0, 300) })
})

test('holding on an enemy attacks them once, and keeps quiet while the champion is on them', () => {
  const hold = held({ type: 'attack', targetId: 7 })
  let now = START
  const step = (extra: Partial<HoldLook>) => hold.next(now += HOLD_COMMAND_INTERVAL_MS, () => look(extra))
  assert.equal(step({ enemyId: 7, attackingId: 7 }), undefined, 'already going after them: the attack goes on by itself')
  assert.equal(step({ enemyId: 7, attackingId: 7 }), undefined)
  // The attack was cut short (a cast with a windup lets go of the target), so it is given again.
  assert.deepEqual(step({ enemyId: 7 }), { type: 'attack', targetId: 7 })
  // The mouse moves onto another enemy, then onto the ground.
  assert.deepEqual(step({ enemyId: 8, attackingId: 7 }), { type: 'attack', targetId: 8 })
  assert.deepEqual(step({ cursor: at(300), attackingId: 8 }), { type: 'move', target: at(300) })
  // And back onto an enemy, which is a walk that is over.
  assert.deepEqual(step({ enemyId: 8 }), { type: 'attack', targetId: 8 })
  assert.deepEqual(step({ cursor: at(300) }), { type: 'move', target: at(300) }, 'a walk is given when it was an attack before, though the place is the same')
})

test('a walk that is cut short is given again, and one that arrived, or could never start, is not', () => {
  const walking = held(ground(500))
  let now = START
  const step = (hold: HoldCommand, extra: Partial<HoldLook>) => hold.next(now += HOLD_COMMAND_INTERVAL_MS, () => look(extra))
  assert.equal(step(walking, { moving: true, position: at(100) }), undefined, 'on its way')
  assert.equal(step(walking, { moving: true, position: at(200) }), undefined)
  // A cast with a windup stops it dead, short of the place.
  assert.deepEqual(step(walking, { moving: false, position: at(250) }), { type: 'move', target: at(500) }, 'cut short: on again')
  assert.equal(step(walking, { moving: false, position: at(250) }), undefined, 'and not again, if it does not start')

  const arriving = held(ground(500))
  assert.equal(step(arriving, { moving: true, position: at(400) }), undefined)
  assert.equal(step(arriving, { moving: false, position: at(500 - HOLD_ARRIVED_DISTANCE) }), undefined, 'it arrived')
  assert.equal(step(arriving, { moving: false, position: at(500) }), undefined)

  // A place that cannot be got to never has the champion walking: the same walk is not given every interval.
  const blocked = held(ground(500))
  for (let repeat = 0; repeat < 5; repeat += 1) assert.equal(step(blocked, { moving: false, position: at(0) }), undefined)
})

test('letting go ends it, and a new press starts it over', () => {
  const hold = held()
  hold.release()
  assert.equal(hold.held, false)
  assert.equal(hold.next(START + 5000, () => look({ cursor: at(900) })), undefined)

  hold.press(START + 6000, ground(900))
  assert.equal(hold.held, true)
  assert.equal(hold.next(START + 6000 + HOLD_COMMAND_INTERVAL_MS - 1, () => look({ cursor: at(1500) })), undefined, 'an interval from the press, again')
  assert.deepEqual(hold.next(START + 6000 + HOLD_COMMAND_INTERVAL_MS, () => look({ cursor: at(1500) })), { type: 'move', target: at(1500) })
})

test('what it gives is its own, and not what it was shown', () => {
  const hold = held()
  const cursor = at(900, 40)
  const command = hold.next(START + HOLD_COMMAND_INTERVAL_MS, () => look({ cursor }))
  assert.ok(command?.type === 'move')
  cursor.x = -1
  assert.deepEqual(command.target, at(900, 40))
})

test('the interval is a few orders a second, not dozens', () => {
  assert.ok(1000 / HOLD_COMMAND_INTERVAL_MS <= 10)
  assert.ok(1000 / HOLD_COMMAND_INTERVAL_MS >= 4)
})

// ---------------------------------------------------------------------------- the game's side

test('the game says where the controlled champion is and whether it is walking', () => {
  const state = new ClientGameState()
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 100, y: 100 }, brawler, 1)
  state.setLocalCharacterId(1)
  state.resetServerTickAnchor(0, 0)
  state.simulator.at(3)
  assert.deepEqual(state.getLocalMotion(0), { position: { x: 100, y: 100 }, moving: false })
  state.simulator.addOrder(1, { id: '1:1', seq: 1, tick: 4, type: 'move', target: { x: 600, y: 100 } })
  state.simulator.at(10)
  const motion = state.getLocalMotion(10 * 1000 / 60)
  assert.equal(motion?.moving, true)
  assert.ok((motion?.position.x ?? 0) > 100)
  assert.equal(new ClientGameState().getLocalMotion(0), undefined, 'and nothing without a champion')
})
