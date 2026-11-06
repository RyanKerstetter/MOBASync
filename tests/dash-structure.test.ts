import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aimPoint,
  blink,
  dash,
  distanceBetween,
  self,
  Simulator,
  type CastTarget,
  type CharacterOrder,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineAbility, defineChampion, defineTurret } from './fixtures.ts'

// A turret does not give way as a champion does (see `pushCharactersApart`), so a dash cannot shove it along. A dash that is not a dash through used to run into one and be
// shoved back every tick, never reaching the end of its way, and the champion was left dashing for good: it could be given no order. Now it stops where it meets the structure,
// and a dash through, or a blink, does not end in one. The turret, the champion and the abilities here are the tests' own.

const tower = defineTurret(96, { base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 }, radius: 40, attackRange: 1, attackWindup: 0 })
const TOWER_AT: Vector2 = { x: 700, y: 700 }
const TOWER_ID = 10
const ME = 1

defineAbility({ id: 't-ds-leap', targeting: 'point', range: 400, windUpTicks: 0, cooldownTicks: 600, movement: true, apply: [dash(600, 400)] })
defineAbility({ id: 't-ds-slip', targeting: 'point', range: 400, windUpTicks: 0, cooldownTicks: 600, movement: true, apply: [dash(600, 400, self(), { through: true })] })
defineAbility({ id: 't-ds-blink', targeting: 'point', range: 400, windUpTicks: 0, cooldownTicks: 600, apply: [blink(aimPoint())] })
const dasher = defineChampion({
  id: 't-ds-dasher',
  name: 'Dasher',
  base: { maxHp: 1000, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 18,
  attackRange: 100,
  attackWindup: 0,
  abilities: ['t-ds-leap', 't-ds-slip', 't-ds-blink'],
})
// How close the middle of the dasher can get to the middle of the tower: their bodies touching.
const REACH = dasher.radius + tower.champion.radius

let sequence = 0
const cast = (tick: number, abilityId: string, target: CastTarget, origin: Vector2): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target, origin: { ...origin } })
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })

// The dasher at `from`, a tower of `towerTeam` (its own team is 1) in front of it, and the dasher told to use `abilityId` toward `aim` on tick 5.
function world(abilityId: string, from: Vector2, aim: Vector2, towerTeam = 2): Simulator {
  const simulator = new Simulator()
  simulator.addTurret(TOWER_ID, tower, TOWER_AT, towerTeam)
  simulator.addPlayer(ME, 'p1', 'One', from, dasher, 1)
  simulator.addOrder(ME, cast(5, abilityId, { mode: 'point', point: aim }, from))
  return simulator
}
const WEST: Vector2 = { x: TOWER_AT.x - 140, y: TOWER_AT.y }
const where = (simulator: Simulator, tick: number): Vector2 => simulator.at(tick).get(ME)?.getPosition() as Vector2
const dashing = (simulator: Simulator, tick: number): boolean => simulator.at(tick).get(ME)?.isDashing() === true

test('a dash into a turret stops where their bodies touch, and is over: the dasher is not left dashing against it', () => {
  // Aimed at the middle of the tower, from the west.
  const simulator = world('t-ds-leap', WEST, TOWER_AT)
  assert.equal(dashing(simulator, 6), true, 'it is dashing')
  const after = 5 + 60
  assert.equal(dashing(simulator, after), false, 'and is not for good')
  const stopped = where(simulator, after)
  assert.ok(Math.abs(distanceBetween(stopped, TOWER_AT) - REACH) < 1e-6, `touching the tower, not in it (${distanceBetween(stopped, TOWER_AT)} from its middle, not ${REACH})`)
  assert.equal(stopped.y, TOWER_AT.y)
  assert.ok(stopped.x < TOWER_AT.x, 'on the side it came from')
  assert.deepEqual(where(simulator, after + 120), stopped, 'and stays where it stopped')
})

test('the dasher can be given orders after it stops against a turret, and walks away from it', () => {
  const simulator = world('t-ds-leap', WEST, TOWER_AT)
  const home: Vector2 = { x: 300, y: TOWER_AT.y }
  simulator.addOrder(ME, move(100, home))
  assert.deepEqual(where(simulator, 100 + 600), home, 'it walks all the way back')
})

test('a dash that goes past a turret to a point behind it stops at the turret, whichever team the turret is on', () => {
  for (const team of [1, 2]) {
    const simulator = world('t-ds-leap', WEST, { x: TOWER_AT.x + 200, y: TOWER_AT.y }, team)
    const stopped = where(simulator, 5 + 120)
    assert.equal(dashing(simulator, 5 + 120), false, `team ${team}: over`)
    assert.ok(Math.abs(distanceBetween(stopped, TOWER_AT) - REACH) < 1e-6, `team ${team}: touching it`)
  }
})

test('a dash that does not meet the turret goes all the way, and one that begins against it and goes away is not stopped', () => {
  const clear = world('t-ds-leap', WEST, { x: WEST.x, y: WEST.y - 120 })
  assert.deepEqual(where(clear, 5 + 120), { x: WEST.x, y: WEST.y - 120 }, 'a dash beside the turret reaches its end')
  assert.equal(dashing(clear, 5 + 120), false)

  const touching: Vector2 = { x: TOWER_AT.x - REACH, y: TOWER_AT.y }
  const away = world('t-ds-leap', touching, { x: touching.x - 150, y: touching.y })
  assert.deepEqual(where(away, 5 + 120), { x: touching.x - 150, y: touching.y }, 'a dash leaving the turret behind reaches its end')
})

test('a dash through can pass a turret, and does not end inside it: it lands at the edge, on the side it came from', () => {
  const simulator = world('t-ds-slip', WEST, TOWER_AT)
  const landed = where(simulator, 5 + 120)
  assert.equal(dashing(simulator, 5 + 120), false)
  assert.ok(Math.abs(distanceBetween(landed, TOWER_AT) - REACH) < 1e-6, `at the edge of the tower (${distanceBetween(landed, TOWER_AT)} from its middle)`)
  simulator.addOrder(ME, move(200, { x: 300, y: TOWER_AT.y }))
  assert.deepEqual(where(simulator, 200 + 600), { x: 300, y: TOWER_AT.y }, 'and it walks away')
})

test('a blink does not land inside a turret either', () => {
  const simulator = world('t-ds-blink', WEST, { x: TOWER_AT.x + 10, y: TOWER_AT.y })
  const landed = where(simulator, 8)
  assert.ok(distanceBetween(landed, TOWER_AT) >= REACH - 1e-6, `out of the tower (${distanceBetween(landed, TOWER_AT)} from its middle, and it takes ${REACH})`)
  assert.ok(distanceBetween(landed, TOWER_AT) < REACH + 1, 'at its edge, the nearest place there is')
  // Blinking to open ground is as it was.
  const open = world('t-ds-blink', WEST, { x: WEST.x, y: WEST.y + 200 })
  assert.deepEqual(where(open, 8), { x: WEST.x, y: WEST.y + 200 })
})
