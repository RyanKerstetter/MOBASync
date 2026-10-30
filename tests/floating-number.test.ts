import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FLOATING_NUMBER_MS,
  floatingChange,
  floatingNumberPose,
  floatingNumberText,
  HEAL_MERGE_MS,
  HealMerger,
  healthLook,
  type HealthLook,
  type NumberChange,
} from '../apps/client/src/render/floating-number.ts'
import {
  GAME_TPS,
  loseHealth,
  SHOP_HEAL_AMOUNT,
  SHOP_HEAL_INTERVAL_TICKS,
  Terrain,
  type ShopZone,
} from '../packages/shared/src/index.ts'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { defineAbility, defineChampion, ECONOMY_MODE } from './fixtures.ts'

// The numbers over a champion: `-N` for a hit and `+N` for health it gets back. They are told from how a champion's health looked the last time
// the page looked (see floating-number.ts). The looks in the first tests are the tests' own; the last ones play the real shop healing area
// through a page's game state, with the amounts read from the game's settings.

const look = (extra: Partial<HealthLook> = {}): HealthLook => ({ total: 600, hp: 600, maxHp: 1000, hpSeq: 3, ...extra })

test('a hit is a number for what the health and shield together lost, when the hit count went up', () => {
  assert.deepEqual(floatingChange(look(), look({ total: 540, hp: 540, hpSeq: 4 })), { kind: 'damage', amount: 60 })
  // A shield that took it: the health is the same, and what is gone is the shield's.
  assert.deepEqual(floatingChange(look({ total: 700 }), look({ total: 650, hpSeq: 4 })), { kind: 'damage', amount: 50 })
  // The hit count went up and nothing was lost (a shield that was refilled in the same breath, a respawn): no number.
  assert.equal(floatingChange(look(), look({ total: 600, hpSeq: 4 })), undefined)
  assert.equal(floatingChange(look({ total: 0, hp: 0 }), look({ total: 1000, hp: 1000, hpSeq: 4 })), undefined, 'a respawn is not a heal')
})

test('a heal is a number for the health got back, when the hit count and the most health are as they were', () => {
  assert.deepEqual(floatingChange(look(), look({ total: 625, hp: 625 })), { kind: 'heal', amount: 25 })
  assert.deepEqual(floatingChange(look({ total: 700 }), look({ total: 730, hp: 630 })), { kind: 'heal', amount: 30 }, 'a shield on top does not make it more')
  // A level or an item that raises the most health raises the health with it.
  assert.equal(floatingChange(look(), look({ total: 680, hp: 680, maxHp: 1080 })), undefined, 'more most health is not a heal')
  assert.equal(floatingChange(look(), look({ total: 520, hp: 520, maxHp: 920 })), undefined, 'nor is less')
  // A rolled back hit takes the count down with it.
  assert.equal(floatingChange(look({ hpSeq: 4, total: 540, hp: 540 }), look()), undefined, 'a hit that was undone is not a heal')
  assert.equal(floatingChange(look({ total: 0, hp: 0 }), look({ total: 5, hp: 5 })), undefined, 'the dead are not healed')
  assert.equal(floatingChange(look(), look()), undefined, 'nothing happened')
  assert.equal(floatingChange(look(), look({ total: 500, hp: 500 })), undefined, 'health lost with no hit is not a hit, as there is nothing to say it was one')
})

test('whoever is first seen has no number, as there is nothing to tell them from', () => {
  assert.equal(floatingChange(undefined, look()), undefined)
})

test('a look is made from a champion\'s health and shield, and a champion with no health has none of it', () => {
  assert.deepEqual(healthLook({ health: { hp: 300, maxHp: 900, hpSeq: 7, finalizedTick: 1 }, totalShield: 40 }), { total: 340, hp: 300, maxHp: 900, hpSeq: 7 })
  assert.deepEqual(healthLook({ totalShield: 0 }), { total: 0, hp: 0, maxHp: 0, hpSeq: 0 })
})

test('a number reads with its sign, and fades as it rises until it is done', () => {
  const [damage, heal]: NumberChange[] = [{ kind: 'damage', amount: 60 }, { kind: 'heal', amount: 25 }]
  assert.equal(floatingNumberText(damage), '-60')
  assert.equal(floatingNumberText(heal), '+25')
  const start = floatingNumberPose(0)
  const middle = floatingNumberPose(FLOATING_NUMBER_MS / 2)
  const end = floatingNumberPose(FLOATING_NUMBER_MS)
  assert.deepEqual([start.alpha, start.rise, start.done], [1, 0, false])
  assert.ok(middle.alpha > 0 && middle.alpha < 1 && middle.rise > 0 && !middle.done)
  assert.deepEqual([end.alpha, end.done], [0, true])
})

// ---------------------------------------------------------------------------- the heals that come together

test('the first heal of a champion is shown at once, and the ones that follow are added up and shown together when the wait is over', () => {
  const merger = new HealMerger()
  merger.add(1, 25)
  assert.deepEqual(merger.take(0), [{ id: 1, amount: 25 }], 'at once')
  assert.deepEqual(merger.take(10), [], 'and not again')
  merger.add(1, 25)
  merger.add(1, 30)
  assert.deepEqual(merger.take(HEAL_MERGE_MS - 1), [], 'the next ones wait for the wait to be over')
  assert.deepEqual(merger.take(HEAL_MERGE_MS), [{ id: 1, amount: 55 }], 'and are shown as one')
  assert.deepEqual(merger.take(HEAL_MERGE_MS * 3), [], 'with nothing waiting there is nothing to show')
})

test('each champion has its own wait, one heal after a long quiet is shown at once, and a champion that left is forgotten', () => {
  const merger = new HealMerger()
  merger.add(1, 10)
  merger.add(2, 20)
  assert.deepEqual(merger.take(0).sort((left, right) => left.id - right.id), [{ id: 1, amount: 10 }, { id: 2, amount: 20 }])
  merger.add(1, 5)
  assert.deepEqual(merger.take(HEAL_MERGE_MS), [{ id: 1, amount: 5 }], 'only the one that has something')
  merger.add(1, 7)
  merger.add(2, 9)
  merger.forget(2)
  assert.deepEqual(merger.take(HEAL_MERGE_MS * 3), [{ id: 1, amount: 7 }], 'and nothing for the one that left')
  merger.add(2, 4)
  assert.deepEqual(merger.take(HEAL_MERGE_MS * 3), [{ id: 2, amount: 4 }], 'it is shown at once when it is back')
  merger.add(3, 0)
  merger.add(3, -5)
  assert.deepEqual(merger.take(HEAL_MERGE_MS * 9), [], 'a heal of nothing is nothing')
})

// ---------------------------------------------------------------------------- the shop healing the page

const WOUND = 500
defineAbility({ id: 't-fn-wound', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 6000, apply: [loseHealth(WOUND)] })
const hero = defineChampion({
  id: 't-fn-hero',
  name: 'Number Hero',
  base: { maxHp: 1000, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: ['t-fn-wound'],
})
const WEST: ShopZone = { team: 1, x: 0, y: 0, width: 700, height: 1440 }
const heals = !(SHOP_HEAL_AMOUNT > 0) ? { skip: 'the shop is set to heal nothing' } : {}

// The numbers a page would show over a champion that wounds itself on tick 1 and stands in its shop, tick by tick as the page looks at it.
function shopNumbers(last: number): { changes: Array<{ tick: number; change: NumberChange }>; hp: number[] } {
  const state = new ClientGameState()
  state.simulator.reset(Terrain.plain(), ECONOMY_MODE, [WEST])
  state.simulator.addPlayer(1, 'p1', 'One', { x: 300, y: 700 }, hero, 1)
  state.simulator.addOrder(1, { id: 'wound', seq: 1, tick: 1, type: 'cast', abilityId: 't-fn-wound', target: { mode: 'none' }, origin: { x: 300, y: 700 } })
  state.setLocalCharacterId(1)
  state.resetServerTickAnchor(0, 0)
  const changes: Array<{ tick: number; change: NumberChange }> = []
  const hp: number[] = []
  let previous: HealthLook | undefined
  for (let tick = 0; tick <= last; tick += 1) {
    state.simulator.advanceTo(tick)
    const character = state.getCharacters((tick + 1e-6) * 1000 / GAME_TPS).find((candidate) => candidate.id === 1)
    assert.ok(character)
    const now = healthLook(character)
    const change = floatingChange(previous, now)
    if (change) changes.push({ tick, change })
    hp.push(now.hp)
    previous = now
  }
  return { changes, hp }
}

test('the healing area makes a heal number for each heal, as much as the champion got back, and the wound a hit number', heals, () => {
  const last = SHOP_HEAL_INTERVAL_TICKS * 6 + 3
  const { changes, hp } = shopNumbers(last)
  assert.deepEqual(changes[0], { tick: 1, change: { kind: 'damage', amount: WOUND } }, 'the wound is a hit')
  const heal = changes.filter(({ change }) => change.kind === 'heal')
  assert.ok(heal.length >= 3, `it was healed more than once: ${JSON.stringify(heal)}`)
  for (const { tick, change } of heal) {
    assert.equal(tick % SHOP_HEAL_INTERVAL_TICKS, 0, 'on a tick the shop heals on')
    assert.equal(change.amount, SHOP_HEAL_AMOUNT, 'by the amount the shop heals')
  }
  assert.equal(heal.reduce((total, { change }) => total + change.amount, 0), hp[last] - hp[1], 'and they add up to all the champion got back')
  assert.equal(changes.length, heal.length + 1, 'and nothing else made a number')
})

test('a champion standing in the healing area is shown a few numbers, not one for each heal, and they add up to the same', heals, () => {
  const last = SHOP_HEAL_INTERVAL_TICKS * 12
  const { changes } = shopNumbers(last)
  const heal = changes.filter(({ change }) => change.kind === 'heal')
  const merger = new HealMerger()
  const shown: Array<{ tick: number; amount: number }> = []
  for (let tick = 0; tick <= last; tick += 1) {
    for (const { change } of heal.filter((entry) => entry.tick === tick)) merger.add(1, change.amount)
    for (const { amount } of merger.take(tick * 1000 / GAME_TPS)) shown.push({ tick, amount })
  }
  const healed = heal.reduce((total, { change }) => total + change.amount, 0)
  assert.equal(shown[0].tick, heal[0].tick, 'the first is shown at once')
  assert.ok(shown.length < heal.length, `${shown.length} numbers for ${heal.length} heals`)
  const waiting = merger.take(Number.POSITIVE_INFINITY).reduce((total, entry) => total + entry.amount, 0)
  assert.equal(shown.reduce((total, entry) => total + entry.amount, 0) + waiting, healed, 'nothing is lost')
  // They are never closer together than the wait, so they do not pile up.
  for (const [index, entry] of shown.slice(1).entries()) {
    assert.ok((entry.tick - shown[index].tick) * 1000 / GAME_TPS >= HEAL_MERGE_MS, 'a number is not shown too soon after the one before')
  }
})
