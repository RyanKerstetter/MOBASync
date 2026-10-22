import assert from 'node:assert/strict'
import test from 'node:test'
import { abilitySlotViews, healthReadout } from '../apps/client/src/hud.ts'

const label = (slot: number): string => 'QWER'[slot] ?? String(slot + 1)

test('a slot fills as its cooldown runs, empty when just cast and full when ready', () => {
  const [justCast, halfway, almost, ready] = abilitySlotViews([
    { slot: 0, abilityId: 'a', ticksRemaining: 480, cooldownTicks: 480 },
    { slot: 1, abilityId: 'b', ticksRemaining: 240, cooldownTicks: 480 },
    { slot: 2, abilityId: 'c', ticksRemaining: 48, cooldownTicks: 480 },
    { slot: 3, abilityId: 'd', ticksRemaining: 0, cooldownTicks: 480 },
  ], label)

  assert.equal(justCast.filled, 0)
  assert.equal(halfway.filled, 0.5)
  assert.equal(almost.filled, 0.9)
  assert.equal(ready.filled, 1)
  assert.deepEqual([justCast.ready, halfway.ready, almost.ready, ready.ready], [false, false, false, true])
})

test('a slot is told by the key and the ability on it, and the key can change what is on it', () => {
  const [first, second] = abilitySlotViews([
    { slot: 0, abilityId: 'recall', ticksRemaining: 0, cooldownTicks: 30 },
    { slot: 1, abilityId: 'hush', ticksRemaining: 100, cooldownTicks: 480 },
  ], label)

  assert.deepEqual([first.key, first.abilityId], ['Q', 'recall'])
  assert.deepEqual([second.key, second.abilityId], ['W', 'hush'])
})

test('the time left is in tenths under ten seconds and whole seconds above, and nothing when ready', () => {
  const [short, long, ready, exact] = abilitySlotViews([
    { slot: 0, abilityId: 'a', ticksRemaining: 204, cooldownTicks: 480 },
    { slot: 1, abilityId: 'b', ticksRemaining: 11.5 * 60, cooldownTicks: 900 },
    { slot: 2, abilityId: 'c', ticksRemaining: 0, cooldownTicks: 480 },
    { slot: 3, abilityId: 'd', ticksRemaining: 600, cooldownTicks: 900 },
  ], label)

  assert.equal(short.secondsLeft, '3.4')
  assert.equal(long.secondsLeft, '12', 'rounded up, so it never shows ready early')
  assert.equal(ready.secondsLeft, '')
  assert.equal(exact.secondsLeft, '10')
})

test('odd cooldowns are held between empty and full', () => {
  const [over, negative, instant] = abilitySlotViews([
    { slot: 0, abilityId: 'a', ticksRemaining: 900, cooldownTicks: 480 },
    { slot: 1, abilityId: 'b', ticksRemaining: -5, cooldownTicks: 480 },
    { slot: 2, abilityId: 'c', ticksRemaining: 10, cooldownTicks: 0 },
  ], label)

  assert.equal(over.filled, 0)
  assert.equal(negative.filled, 1)
  assert.equal(negative.ready, true)
  assert.equal(instant.filled, 1)
})

test('no abilities make no slots', () => {
  assert.deepEqual(abilitySlotViews([], label), [])
})

test('the health readout gives the exact numbers and how much of the bar each part takes', () => {
  const readout = healthReadout({ hp: 600, maxHp: 800, shield: 0 })

  assert.equal(readout.health, '600 / 800')
  assert.equal(readout.shield, '')
  assert.equal(readout.healthPercent, 75)
  assert.equal(readout.shieldPercent, 0)
})

test('a shield is shown as a number and as the end of the bar', () => {
  const readout = healthReadout({ hp: 400, maxHp: 800, shield: 200 })

  assert.equal(readout.health, '400 / 800')
  assert.equal(readout.shield, '+200')
  assert.equal(readout.healthPercent, 50)
  assert.equal(readout.shieldPercent, 25)
})

test('a shield that carries the total past the maximum shrinks the health to make room', () => {
  const readout = healthReadout({ hp: 800, maxHp: 800, shield: 400 })

  assert.ok(Math.abs(readout.healthPercent - 100 * 800 / 1200) < 1e-9)
  assert.ok(Math.abs(readout.shieldPercent - 100 * 400 / 1200) < 1e-9)
  assert.ok(Math.abs(readout.healthPercent + readout.shieldPercent - 100) < 1e-9)
})

test('health is never shown below zero or as a fraction', () => {
  assert.equal(healthReadout({ hp: -3, maxHp: 800, shield: 0 }).health, '0 / 800')
  assert.equal(healthReadout({ hp: 0, maxHp: 800, shield: 0 }).healthPercent, 0)
  assert.equal(healthReadout({ hp: 599.6, maxHp: 800, shield: 0 }).health, '600 / 800')
})
