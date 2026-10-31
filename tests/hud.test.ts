import assert from 'node:assert/strict'
import test from 'node:test'
import { abilitySlotViews, healthReadout, HUD_ITEM_COLUMNS, HUD_ITEM_ROWS, progressReadout, respawnText, statRows } from '../apps/client/src/ui/hud.ts'
import { GAME_MAX_LEVEL, xpProgress } from '../packages/shared/src/index.ts'

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

test('a slot tells the whole cooldown its ability runs over, for its tooltip', () => {
  const [first, second] = abilitySlotViews([
    { slot: 0, abilityId: 'a', ticksRemaining: 100, cooldownTicks: 480 },
    { slot: 1, abilityId: 'b', ticksRemaining: 0, cooldownTicks: 900 },
  ], label)

  assert.deepEqual([first.cooldownTicks, second.cooldownTicks], [480, 900])
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

test('a dead champion\'s bar counts down to the respawn in whole seconds, and never says 0', () => {
  assert.equal(respawnText(12.2), 'Respawning in 13s')
  assert.equal(respawnText(3), 'Respawning in 3s')
  assert.equal(respawnText(0.4), 'Respawning in 1s')
  assert.equal(respawnText(0), 'Respawning in 1s')
})

test('the level, the experience bar, the gold and the shards are told as they are, and the shards even when there are none', () => {
  const readout = progressReadout({ ...xpProgress(100 + 75), gold: 245, shards: 0 })

  assert.equal(readout.level, '2')
  assert.equal(readout.xpPercent, 50)
  assert.equal('xpText' in readout, false, 'the bar has no numbers on it, only how full it is')
  assert.equal(readout.gold, '245')
  assert.equal(readout.shards, '0', 'the shard shop button is always there, so it says none')
  assert.equal(progressReadout({ ...xpProgress(100 + 75), gold: 0, shards: 3 }).shards, '3')
})

test('at the highest level the bar is full, and the numbers are never fractions or below zero', () => {
  const top = progressReadout({ ...xpProgress(100000), gold: 12, shards: 0 })
  assert.deepEqual([top.level, top.xpPercent], [String(GAME_MAX_LEVEL), 100])

  const odd = progressReadout({ level: 1, fraction: -0.04, gold: 99.9, shards: -2 })
  assert.deepEqual([odd.xpPercent, odd.gold, odd.shards], [0, '99', '0'])
  assert.equal(progressReadout({ level: 1, fraction: 7, gold: 0, shards: 0 }).xpPercent, 100, 'and the bar is never past full')
})

const STATS = { maxHp: 800, attackDamage: 54.6, attackSpeed: 1.2, attackRange: 190, moveSpeed: 145, resistance: 0, haste: 0, arcane: 0 }

test('the stats panel lists the champion\'s numbers in order, whole except for the rates, which are told to two places', () => {
  const rows = statRows({ ...STATS, resistance: 30, haste: 25, arcane: 46.4 })

  assert.deepEqual(rows, [
    { label: 'Max health', value: '800' },
    { label: 'Attack damage', value: '55' },
    { label: 'Attack speed', value: '1.2' },
    { label: 'Attack range', value: '190' },
    { label: 'Move speed', value: '145' },
    { label: 'Arcane', value: '46' },
    { label: 'Resistance', value: '30 (23%)' },
    { label: 'Haste', value: '25 (20%)' },
  ])
  assert.equal(statRows({ ...STATS, attackSpeed: 1 })[2].value, '1', 'no tail of zeros')
  assert.equal(statRows({ ...STATS, attackSpeed: 0.6666 })[2].value, '0.67', 'two places at most')
  assert.equal(statRows(STATS)[5].value, '0', 'none is told as none')
})

test('the resistance and the haste are told as the stat and what it takes off, by the formula', () => {
  const take = (resistance: number) => statRows({ ...STATS, resistance })[6].value
  assert.equal(take(0), '0 (0%)', 'none takes none off')
  assert.equal(take(100), '100 (50%)', 'a hundred takes half')
  assert.equal(take(300), '300 (75%)')
  assert.equal(statRows({ ...STATS, haste: 100 })[7].value, '100 (50%)', 'and the haste the same')
})

test('odd stats are never shown as less than nothing, or as not a number', () => {
  const rows = statRows({ maxHp: -50, attackDamage: Number.NaN, attackSpeed: Number.POSITIVE_INFINITY, attackRange: -1, moveSpeed: 0, resistance: -20, haste: Number.NaN, arcane: -1 })

  assert.deepEqual(rows.map((row) => row.value), ['0', '0', '0', '0', '0', '0', '0 (0%)', '0 (0%)'])
})

test('the items are a grid four across and two down, which is eight: a cell for each of the eight kinds of item', () => {
  assert.deepEqual([HUD_ITEM_COLUMNS, HUD_ITEM_ROWS, HUD_ITEM_COLUMNS * HUD_ITEM_ROWS], [4, 2, 8])
})
