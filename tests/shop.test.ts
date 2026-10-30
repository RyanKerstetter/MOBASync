import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  emptySlotTooltip,
  goldText,
  isGreyedOut,
  itemStatLines,
  ownedTooltip,
  SHOP_FILTERS,
  shopEntries,
  shopFilterName,
  shopTooltip,
  signedAmount,
} from '../apps/client/src/ui/shop.ts'
import { GAME_STARTING_GOLD, ITEM_SLOTS, ITEM_SELL_RATE, itemsForSlot, sellValue, type Inventory } from '../packages/shared/src/index.ts'
import { defineChampion, defineItem, economyClient } from './fixtures.ts'

// What the shop and the item slots show, and what the page does to buy and sell. The items are the tests' own ("t-sh-"), so retuning the shop's
// filler changes nothing here.

// What these cost is a share of the gold a player starts with (the game's number, which is tuned), so a player can afford them, two or three at a time, and
// the amounts the tests expect are worked out from the items and from it, and not written out.
const GOLD = GAME_STARTING_GOLD
const part = (share: number): number => Math.max(1, Math.floor(GOLD * share))
const boots = defineItem({ id: 't-sh-boots', name: 'Shop Boots', slot: 'boots', cost: part(0.2), stats: { moveSpeed: 20 } })
const sandals = defineItem({ id: 't-sh-sandals', name: 'Shop Sandals', slot: 'boots', cost: part(0.1), stats: { moveSpeed: 5 } })
const robe = defineItem({ id: 't-sh-robe', name: 'Shop Robe', slot: 'chest', cost: part(0.6), stats: { maxHp: 100, arcane: 8, resistance: 5 } })
const sword = defineItem({ id: 't-sh-sword', name: 'Shop Sword', slot: 'weapon', cost: part(0.4), stats: { attackDamage: 12, attackSpeed: 0.15 } })
const bow = defineItem({ id: 't-sh-bow', name: 'Shop Bow', slot: 'weapon', cost: part(0.9), stats: { attackRange: 100, haste: 10 } })
const scope = defineItem({ id: 't-sh-scope', name: 'Shop Scope', slot: 'accessory', cost: part(0.2), stats: { attackRange: 100 } })

const shipped = (entries: ReturnType<typeof shopEntries>) => entries.filter((entry) => entry.item.id.startsWith('t-sh-'))

// ---------------------------------------------------------------------------- what is listed

test('the tabs are the kinds of item, with no tab for all of them, and the items of a tab come cheapest first', () => {
  assert.deepEqual([...SHOP_FILTERS], ['boots', 'chest', 'back', 'head', 'weapon', 'accessory', 'pet', 'potion'])
  assert.deepEqual(SHOP_FILTERS.map(shopFilterName), ['Boots', 'Chest', 'Back', 'Head', 'Weapon', 'Accessory', 'Pet', 'Potion'])
  assert.equal(SHOP_FILTERS.includes('all' as never), false)
  const loadout = { gold: 1000, items: {} }
  assert.deepEqual(shipped(shopEntries('boots', loadout)).map((entry) => entry.item.id), ['t-sh-sandals', 't-sh-boots'], '50 before 100')
  assert.deepEqual(shopEntries('weapon', loadout).every((entry) => entry.item.slot === 'weapon'), true, 'only that kind')
  assert.deepEqual(shopEntries('weapon', loadout).map((entry) => entry.item.id), itemsForSlot('weapon').map((item) => item.id))
})

test('every item is in the tab of its kind, cheapest first, and so in exactly one', () => {
  const loadout = { gold: 0, items: {} }
  for (const slot of ITEM_SLOTS) {
    const costs = shopEntries(slot, loadout).map((entry) => entry.item.cost)
    assert.deepEqual(costs, [...costs].sort((left, right) => left - right), `${slot} cheapest first`)
    assert.ok(costs.length >= 2, `a couple of ${slot}`)
  }
  assert.equal(ITEM_SLOTS.flatMap((slot) => shopEntries(slot, loadout)).length, itemsForSlot().length, 'and every one is somewhere')
})

test('an item is available with the gold and a free slot, and says why it is not: too dear, or its slot is full, or you have it', () => {
  const status = (gold: number, items: Inventory) => Object.fromEntries(shipped(ITEM_SLOTS.flatMap((slot) => shopEntries(slot, { gold, items }))).map((entry) => [entry.item.id, entry.status]))
  assert.deepEqual(status(boots.cost, {}), {
    't-sh-sandals': 'available',
    't-sh-boots': 'available',
    't-sh-robe': 'unaffordable',
    't-sh-sword': 'unaffordable',
    't-sh-bow': 'unaffordable',
    't-sh-scope': 'available',
  }, 'the price of the boots buys them and the scope, and the sandals, and not the sword')
  assert.equal(status(boots.cost - 1, {})['t-sh-boots'], 'unaffordable', 'a gold short')
  assert.equal(status(bow.cost, {})['t-sh-bow'], 'available', 'exactly enough')
  // With the boots on, the sandals are blocked (the slot is full), the boots are the ones you have, and other kinds are as they were.
  assert.deepEqual(status(GOLD * 10, { boots: boots.id }), {
    't-sh-sandals': 'blocked',
    't-sh-boots': 'owned',
    't-sh-robe': 'available',
    't-sh-sword': 'available',
    't-sh-bow': 'available',
    't-sh-scope': 'available',
  })
  // A full slot is blocked however much gold there is, or little.
  assert.equal(status(0, { boots: boots.id })['t-sh-sandals'], 'blocked')
  const blocked = shipped(shopEntries('boots', { gold: GOLD * 10, items: { boots: boots.id } }))[0]
  assert.equal(blocked.problem, 'You already have Shop Boots in your boots slot: sell it first.')
  assert.equal(shipped(shopEntries('boots', { gold: boots.cost - 1, items: {} }))[1].problem, 'You need 1 more gold.')
})

test('what cannot be bought now is drawn grey, and what can, or is yours, is not', () => {
  assert.deepEqual((['available', 'unaffordable', 'blocked', 'owned'] as const).map(isGreyedOut), [false, true, true, false])
})

// ---------------------------------------------------------------------------- the words

test('an amount has its sign, whole when it is whole and to two places at most when it is not', () => {
  assert.deepEqual([300, 0.15, 0.08, 12.5, 0.123, 1.999, -5, -0.5].map(signedAmount), ['+300', '+0.15', '+0.08', '+12.5', '+0.12', '+2', '-5', '-0.5'])
  assert.equal(signedAmount(0), '+0')
  assert.equal(signedAmount(-0.001), '+0', 'never a minus on nothing')
})

test('an item lists what it adds, a line for each, in the order stats are listed elsewhere, with none for what it does not add', () => {
  assert.deepEqual(itemStatLines(robe), [
    { label: 'Health', value: '+100' },
    { label: 'Resistance', value: '+5' },
    { label: 'Arcane', value: '+8' },
  ])
  assert.deepEqual(itemStatLines(sword), [{ label: 'Attack damage', value: '+12' }, { label: 'Attack speed', value: '+0.15' }])
  assert.deepEqual(itemStatLines(bow), [{ label: 'Haste', value: '+10' }, { label: 'Attack range', value: '+100' }])
  assert.deepEqual(itemStatLines(boots), [{ label: 'Move speed', value: '+20' }])
  assert.deepEqual(itemStatLines({ stats: {} }), [])
  assert.deepEqual(itemStatLines({ stats: { haste: 0 } }), [], 'a stat of nothing is not a line')
})

test('pointing at an item in the shop says its name, slot, cost and stats, and what clicking it does', () => {
  const [available] = shopEntries('chest', { gold: GOLD * 10, items: {} }).filter((entry) => entry.item.id === robe.id)
  assert.deepEqual(shopTooltip(available), {
    name: 'Shop Robe',
    slot: 'Chest',
    cost: robe.cost,
    stats: itemStatLines(robe),
    note: 'Click to buy.',
    tone: 'good',
  })
  const [poor] = shopEntries('chest', { gold: robe.cost - 1, items: {} }).filter((entry) => entry.item.id === robe.id)
  assert.deepEqual([shopTooltip(poor).note, shopTooltip(poor).tone, shopTooltip(poor).cost], ['You need 1 more gold.', 'bad', robe.cost], 'it can still be read, and says why not')
  const [full] = shopEntries('boots', { gold: GOLD * 10, items: { boots: boots.id } }).filter((entry) => entry.item.id === sandals.id)
  assert.deepEqual([shopTooltip(full).note, shopTooltip(full).tone], ['You already have Shop Boots in your boots slot: sell it first.', 'bad'])
  const [yours] = shopEntries('boots', { gold: 0, items: { boots: boots.id } }).filter((entry) => entry.item.id === boots.id)
  assert.deepEqual([shopTooltip(yours).tone, shopTooltip(yours).note], ['muted', 'You have this item. Right-click it in your slots to sell it.'])
})

test('pointing at an item you carry says what it adds and what selling it pays, which is the sell rate of the cost; an empty slot says so', () => {
  assert.equal(sellValue(robe), Math.floor(robe.cost * ITEM_SELL_RATE))
  assert.deepEqual(ownedTooltip(robe), {
    name: 'Shop Robe',
    slot: 'Chest',
    stats: itemStatLines(robe),
    note: `Right-click to sell for ${sellValue(robe)} gold (it cost ${robe.cost}).`,
    tone: 'muted',
  })
  assert.equal(ownedTooltip(bow).note, `Right-click to sell for ${sellValue(bow)} gold (it cost ${bow.cost}).`)
  assert.deepEqual(emptySlotTooltip('weapon'), { name: 'Weapon slot', slot: 'Weapon', stats: [], note: 'Empty. Click to shop for weapon.', tone: 'muted' })
  assert.equal(emptySlotTooltip('accessory').note, 'Empty. Click to shop for accessory.')
})

test('gold is written as a whole number, and never below nothing', () => {
  assert.deepEqual([500, 12.9, 0, -4, Number.NaN, Number.POSITIVE_INFINITY].map(goldText), ['500', '12', '0', '0', '0', '0'])
})

// ---------------------------------------------------------------------------- buying and selling from the page

const hero = defineChampion({
  id: 't-sh-hero',
  name: 'Shop Hero',
  base: { maxHp: 1000, attackDamage: 100, attackSpeed: 1, haste: 5 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: [],
})

function game(): ClientGameState {
  const state = economyClient()
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 600, y: 700 }, hero, 1)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  return state
}
// Gives time for what was ordered to be done.
const settle = (state: ClientGameState, ticks = 30): void => state.simulator.advanceTo(state.simulator.tick + ticks)

test('the page knows what the local champion has to spend and carries', () => {
  const state = game()
  assert.deepEqual(state.getLocalLoadout(0), { gold: GAME_STARTING_GOLD, items: {}, inShop: true }, 'a game with no shops can be shopped in from anywhere')
  assert.equal(new ClientGameState().getLocalLoadout(0), undefined, 'nothing before there is a champion')
})

test('an order to buy is given when it can be afforded, and is done on its tick, with the gold and the stats', () => {
  const state = game()
  const bought = state.createBuyOrder(robe.id, 0)
  assert.ok(bought.ok)
  assert.equal(bought.ok && bought.order.type, 'buy')
  assert.equal(bought.ok && bought.order.itemId, robe.id)
  settle(state)
  assert.deepEqual(state.getLocalLoadout(0), { gold: GOLD - robe.cost, items: { chest: robe.id }, inShop: true })
  assert.equal(state.getLocalProgress(0)?.gold, GOLD - robe.cost, 'the gold the HUD shows')
  const stats = state.getLocalStats(0)
  assert.deepEqual([stats?.maxHp, stats?.resistance], [1100, 5], 'the stats panel includes what it adds')
  assert.equal(stats?.arcane, 8, 'an arcane of 8 from none')
})

test('an order that could not be bought is not given, and the reason is what the shop says', () => {
  const state = game()
  assert.deepEqual(state.createBuyOrder('no-such-item', 0), { ok: false, reason: 'There is no such item.' })
  const dear = defineItem({ id: 't-sh-dear', name: 'Dear', slot: 'head', cost: GOLD * 1000 })
  assert.deepEqual(state.createBuyOrder(dear.id, 0), { ok: false, reason: `You need ${dear.cost - GOLD} more gold.` })
  state.createBuyOrder(boots.id, 0)
  settle(state)
  assert.deepEqual(state.createBuyOrder(sandals.id, 0), { ok: false, reason: 'You already have Shop Boots in your boots slot: sell it first.' })
  assert.deepEqual(economyClient().createBuyOrder(boots.id, 0), { ok: false, reason: 'Your champion is not in the game.' })
})

test('an order to sell pays the sell rate back and empties the slot, and a slot with nothing in it is not sold', () => {
  const state = game()
  state.createBuyOrder(sword.id, 0)
  settle(state)
  assert.deepEqual(state.createSellOrder('boots', 0), { ok: false, reason: 'You have nothing in your boots slot.' })
  const sold = state.createSellOrder('weapon', 0)
  assert.ok(sold.ok)
  settle(state)
  assert.deepEqual(state.getLocalLoadout(0), { gold: GOLD - sword.cost + sellValue(sword), items: {}, inShop: true }, 'the sell rate of what it cost is paid back')
  assert.deepEqual([state.getLocalStats(0)?.attackDamage], [100], 'and the stats are as they were')
})

test('what a champion carries is in what the page draws of it: its reach, its swing, its cooldowns and its speed', () => {
  const state = game()
  const before = state.getCharacters(0).find((character) => character.id === 1)
  assert.deepEqual([before?.attackRange, before?.attackCooldownTicks], [150, 60])
  state.createBuyOrder(scope.id, 0)
  state.createBuyOrder(sword.id, 0)
  settle(state)
  const after = state.getCharacters(0).find((character) => character.id === 1)
  // The scope adds 100 of range and the sword 0.15 attacks a second, which is 1.15 a second: every 53 ticks, to the tick.
  assert.deepEqual([after?.attackRange, after?.attackCooldownTicks], [250, Math.ceil(60 / 1.15)])
})
