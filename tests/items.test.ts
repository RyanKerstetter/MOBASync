import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  buyProblem,
  damage,
  enemiesInRadius,
  GAME_STARTING_GOLD,
  GameSnapshotSchema,
  getItem,
  Item,
  ITEM_SELL_RATE,
  ITEM_SLOT_NAMES,
  ITEM_SLOTS,
  ITEM_STAT_KEYS,
  itemsForSlot,
  items,
  itemTotals,
  PLAYER_KILL_REWARD,
  sellValue,
  scaled,
  Simulator,
  Terrain,
  withItems,
  type ChampionStats,
  type Inventory,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineAbility, defineChampion, defineItem, defineMonster, economySimulator } from './fixtures.ts'
import { testSpawns } from './test-spawns.ts'

// Items (see items.ts): eight slots with one item in each, bought and sold with gold by orders, adding their stats to the champion that carries them.
// The items in these are the tests' own ("t-"), with numbers made big, so retuning the shop's filler changes nothing here, except where a test is
// about the items the game ships with.

// What the test items cost is a share of the gold a player starts with (the game's number, which is tuned), so they can always be afforded, a couple at a time,
// and the one that is dear is more than there is. What the gold is after a purchase is worked out from the items, and never written out.
const GOLD = GAME_STARTING_GOLD
const part = (share: number): number => Math.max(1, Math.floor(GOLD * share))
const plate = defineItem({ id: 't-plate', name: 'Test Plate', slot: 'chest', cost: part(0.8), stats: { maxHp: 300 } })
const plate2 = defineItem({ id: 't-plate-2', name: 'Test Plate Two', slot: 'chest', cost: part(0.4), stats: { maxHp: 50 } })
const blade = defineItem({ id: 't-blade', name: 'Test Blade', slot: 'weapon', cost: part(0.6), stats: { attackDamage: 50 } })
const pricey = defineItem({ id: 't-pricey', name: 'Test Pricey', slot: 'head', cost: GOLD * 1000, stats: { maxHp: 10 } })
const ward = defineItem({ id: 't-ward', name: 'Test Ward', slot: 'back', cost: part(0.2), stats: { resistance: 100 } })
const sparkle = defineItem({ id: 't-sparkle', name: 'Test Sparkle', slot: 'head', cost: part(0.2), stats: { arcane: 100 } })
const hurry = defineItem({ id: 't-hurry', name: 'Test Hurry', slot: 'accessory', cost: part(0.2), stats: { haste: 100 } })
const quick = defineItem({ id: 't-quick', name: 'Test Quick', slot: 'weapon', cost: part(0.2), stats: { attackSpeed: 1 } })
const treads = defineItem({ id: 't-treads', name: 'Test Treads', slot: 'boots', cost: part(0.2), stats: { moveSpeed: 100 } })
const scope = defineItem({ id: 't-scope', name: 'Test Scope', slot: 'accessory', cost: part(0.2), stats: { attackRange: 100 } })

defineAbility({ id: 't-it-blast', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [damage(100, enemiesInRadius(400))] })
// Deals 100 and half of the caster's arcane.
defineAbility({ id: 't-it-spell', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [damage(scaled(100, { arcane: 0.5 }), enemiesInRadius(400))] })
const fighter = defineChampion({
  id: 't-it-fighter',
  name: 'Item Fighter',
  base: { maxHp: 1000, attackDamage: 100, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: ['t-it-blast', 't-it-spell'],
})
// Takes a lot of hits, and hits for nothing.
const dummy = defineChampion({
  id: 't-it-dummy',
  name: 'Item Dummy',
  base: { maxHp: 5000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: [],
})
// Goes down in one hit.
const glass = defineChampion({
  id: 't-it-glass',
  name: 'Item Glass',
  base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: [],
})

const buy = (tick: number, itemId: string, seq = tick) => ({ id: `b${seq}:${itemId}`, seq, tick, type: 'buy' as const, itemId })
const sell = (tick: number, slot: (typeof ITEM_SLOTS)[number], seq = tick) => ({ id: `s${seq}:${slot}`, seq, tick, type: 'sell' as const, slot })
const attack = (tick: number, targetId: number, seq = tick) => ({ id: `a${seq}`, seq, tick, type: 'attack' as const, targetId })
const walk = (tick: number, target: Vector2, seq = tick) => ({ id: `w${seq}`, seq, tick, type: 'move' as const, target })

// One player (1) with a champion, and optionally another of the other team (2).
function game(champion = fighter, other?: typeof dummy): Simulator {
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p1', 'One', { x: 600, y: 700 }, champion, 1)
  if (other) simulator.addPlayer(2, 'p2', 'Two', { x: 700, y: 700 }, other, 2)
  return simulator
}
const gold = (simulator: Simulator, tick: number, id = 1): number | undefined => simulator.at(tick).get(id)?.getGold()
const carried = (simulator: Simulator, tick: number, id = 1): Inventory | undefined => simulator.at(tick).get(id)?.getItems()
const hp = (simulator: Simulator, tick: number, id = 1): number | undefined => simulator.at(tick).get(id)?.getHealth()
const maxHp = (simulator: Simulator, tick: number, id = 1): number | undefined => simulator.at(tick).get(id)?.getHealthState()?.maxHp
const run = (simulator: Simulator, from: number, to: number): void => {
  for (let tick = from; tick <= to; tick += 1) simulator.at(tick)
}

// ---------------------------------------------------------------------------- what an item is

test('an item has a slot, a cost and stats, its icon is its id unless it says, and what is not right is refused', () => {
  const item = new Item({ id: 'x', name: 'X', slot: 'boots', cost: 10 })
  assert.deepEqual([item.id, item.name, item.slot, item.cost, item.icon, { ...item.stats }], ['x', 'X', 'boots', 10, 'x', {}])
  assert.equal(new Item({ id: 'y', name: 'Y', slot: 'head', cost: 1, icon: 'hat', stats: { arcane: 10 } }).icon, 'hat')
  const fine = { id: 'z', name: 'Z', slot: 'back' as const, cost: 5 }
  assert.throws(() => new Item({ ...fine, id: '' }), /needs an id/)
  assert.throws(() => new Item({ ...fine, name: ' ' }), /Item "z" needs a name/)
  assert.throws(() => new Item({ ...fine, slot: 'feet' as never }), /needs a slot that is one of boots, chest, back, head, weapon, accessory/)
  for (const cost of [0, -5, 2.5, Number.NaN]) assert.throws(() => new Item({ ...fine, cost }), /needs a cost that is a whole number of gold, 1 or more/, String(cost))
  assert.throws(() => new Item({ ...fine, stats: { luck: 3 } as never }), /has a stat called luck/)
  assert.throws(() => new Item({ ...fine, stats: { haste: Number.NaN } }), /needs a haste that is a number/)
  assert.throws(() => new Item({ ...fine, stats: { maxHp: 10.5 } }), /needs a maxHp that is a whole number/)
})

test('the eight slots are in the order of the grid, and each has a name', () => {
  assert.deepEqual([...ITEM_SLOTS], ['boots', 'chest', 'back', 'head', 'weapon', 'accessory', 'pet', 'potion'])
  assert.deepEqual(ITEM_SLOTS.map((slot) => ITEM_SLOT_NAMES[slot]), ['Boots', 'Chest', 'Back', 'Head', 'Weapon', 'Accessory', 'Pet', 'Potion'])
  assert.deepEqual([...ITEM_STAT_KEYS], ['maxHp', 'attackDamage', 'attackSpeed', 'resistance', 'haste', 'arcane', 'attackRange', 'moveSpeed'])
})

test('the items the game ships with: a couple in every slot, each with its own picture in res/shop_icons', () => {
  const shipped = [...items.values()].filter((item) => !item.id.startsWith('t-'))
  for (const slot of ITEM_SLOTS) assert.ok(shipped.filter((item) => item.slot === slot).length >= 2, `a couple of ${slot}`)
  for (const item of shipped) {
    assert.equal(getItem(item.id), item)
    assert.ok(item.cost > 0 && Object.keys(item.stats).length > 0, `${item.name} costs something and does something`)
    assert.ok(existsSync(new URL(`../res/shop_icons/${item.icon}.png`, import.meta.url)), `${item.name} has a picture: res/shop_icons/${item.icon}.png`)
  }
  assert.equal(new Set(shipped.map((item) => item.id)).size, shipped.length, 'no two share an id')
})

test('the items of a slot come cheapest first, and then by name', () => {
  const chest = itemsForSlot('chest').filter((item) => item.id.startsWith('t-'))
  assert.deepEqual(chest.map((item) => item.id), ['t-plate-2', 't-plate'], '200 before 400')
  const everything = itemsForSlot()
  assert.ok(everything.length >= 12)
  assert.deepEqual(everything.map((item) => item.cost), [...everything.map((item) => item.cost)].sort((left, right) => left - right))
})

// ---------------------------------------------------------------------------- the rules

test('a sold item pays back the sell rate of its cost, rounded down, and the rate is one number that can be changed', () => {
  assert.equal(ITEM_SELL_RATE > 0 && ITEM_SELL_RATE <= 1, true)
  assert.equal(sellValue(plate), Math.floor(plate.cost * ITEM_SELL_RATE), 'the rate the game has')
  assert.equal(sellValue({ cost: 105 }, 0.7), 73, 'rounded down: 73.5')
  assert.equal(sellValue({ cost: 1 }, 0.7), 0)
  assert.equal(sellValue({ cost: 400 }, 0.5), 200, 'and another rate is just another number')
  assert.equal(sellValue({ cost: 400 }, 1), 400)
})

test('an item can be bought with enough gold and a free slot, and the reason it cannot is said', () => {
  assert.equal(buyProblem(plate, plate.cost, {}), undefined, 'exactly enough')
  assert.match(buyProblem(plate, plate.cost - 1, {}) ?? '', /You need 1 more gold\./)
  assert.match(buyProblem(pricey, 30, {}) ?? '', new RegExp(`You need ${pricey.cost - 30} more gold\.`))
  assert.match(buyProblem(undefined, 1000, {}) ?? '', /There is no such item\./)
  assert.equal(buyProblem(plate, 10000, { chest: plate2.id }), 'You already have Test Plate Two in your chest slot: sell it first.')
  assert.match(buyProblem(plate, 0, { chest: plate2.id }) ?? '', /already have/, 'the full slot comes before the gold')
  assert.equal(buyProblem(plate, plate.cost, { weapon: blade.id }), undefined, 'another slot being full does not matter')
  assert.match(buyProblem(plate, plate.cost, { chest: 'gone' }) ?? '', /You already have gone in your chest slot/, 'an item no longer in the game still fills its slot')
})

test('what a champion carries adds up, and an id that is not an item adds nothing', () => {
  assert.deepEqual(itemTotals(undefined), {})
  assert.deepEqual(itemTotals({}), {})
  assert.deepEqual(itemTotals({ chest: plate.id, weapon: blade.id }), { maxHp: 300, attackDamage: 50 })
  assert.deepEqual(itemTotals({ chest: plate.id, head: 'nonsense' }), { maxHp: 300 })
  const stats: ChampionStats = { maxHp: 1000, attackDamage: 50, attackSpeed: 1, resistance: 10, haste: 5, arcane: 11, attackRange: 150, moveSpeed: 200 }
  const everything = defineItem({ id: 't-everything', name: 'All', slot: 'accessory', cost: 1, stats: { maxHp: 10, attackDamage: 1, attackSpeed: 0.5, resistance: 2, haste: 3, arcane: 4, attackRange: 25, moveSpeed: 15 } })
  const total = withItems(stats, { accessory: everything.id })
  assert.deepEqual(
    [total.maxHp, total.attackDamage, total.attackSpeed, total.resistance, total.haste, total.attackRange, total.moveSpeed],
    [1010, 51, 1.5, 12, 8, 175, 215],
  )
  assert.equal(total.arcane, 15)
  assert.equal(stats.maxHp, 1000, 'and the stats it was given are as they were')
  assert.deepEqual(withItems(stats, undefined), stats)
})

// ---------------------------------------------------------------------------- buying and selling in a game

test('a player starts with gold to spend and nothing in their slots, and a monster or a structure has none', () => {
  const simulator = game()
  simulator.addMonster(10, defineMonster({
    id: 't-it-grub', name: 'Grub', base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 }, moveSpeed: 100, radius: 20, attackRange: 50, attackWindupTicks: 0, abilities: [], ai: { aggroRange: 0, deaggroRange: 100 },
  }), { x: 1500, y: 700 })
  assert.deepEqual([gold(simulator, 0), carried(simulator, 0)], [GOLD, {}])
  assert.equal(gold(simulator, 0, 10), 0)
})

test('an order to buy spends the gold and fills the slot on its tick, and not before', () => {
  const simulator = game()
  simulator.addOrder(1, buy(5, plate.id))
  run(simulator, 1, 10)
  assert.deepEqual([gold(simulator, 4), carried(simulator, 4)], [GOLD, {}], 'the tick before')
  assert.deepEqual([gold(simulator, 5), carried(simulator, 5)], [GOLD - plate.cost, { chest: plate.id }])
  assert.deepEqual([gold(simulator, 10), carried(simulator, 10)], [GOLD - plate.cost, { chest: plate.id }], 'and it stays')
})

test('a purchase that cannot be made is nothing: too dear, a full slot, an item that does not exist', () => {
  const simulator = game()
  simulator.addOrder(1, buy(2, pricey.id))
  simulator.addOrder(1, buy(3, 'no-such-item'))
  simulator.addOrder(1, buy(4, plate.id))
  simulator.addOrder(1, buy(5, plate2.id))
  run(simulator, 1, 8)
  assert.deepEqual([gold(simulator, 8), carried(simulator, 8)], [GOLD - plate.cost, { chest: plate.id }], 'the plate, and not a second chest item')
  simulator.addOrder(1, buy(9, blade.id))
  run(simulator, 9, 12)
  assert.deepEqual([gold(simulator, 12), carried(simulator, 12)], [GOLD - plate.cost, { chest: plate.id }], 'the blade is more than what is left')
  assert.equal(blade.cost > GOLD - plate.cost, true)
})

test('selling pays 70% of the cost and empties the slot, and a slot with nothing in it sells nothing', () => {
  const simulator = game()
  simulator.addOrder(1, buy(2, plate.id))
  simulator.addOrder(1, sell(4, 'chest'))
  simulator.addOrder(1, sell(6, 'chest'))
  simulator.addOrder(1, sell(7, 'boots'))
  run(simulator, 1, 10)
  assert.deepEqual([gold(simulator, 3), carried(simulator, 3)], [GOLD - plate.cost, { chest: plate.id }])
  assert.deepEqual([gold(simulator, 4), carried(simulator, 4)], [GOLD - plate.cost + sellValue(plate), {}], '70% of what it cost is paid back')
  assert.equal(sellValue(plate), Math.floor(plate.cost * ITEM_SELL_RATE))
  assert.equal(gold(simulator, 10), GOLD - plate.cost + sellValue(plate), 'nothing more for selling an empty slot')
})

test('a slot full of one item is freed by selling it, and then another can be bought, in the same tick if the orders come in that order', () => {
  const simulator = game()
  simulator.addOrder(1, buy(2, plate.id))
  // Sell, then buy, in one tick: the sale comes first, so the second is bought with the gold from the first.
  simulator.addOrder(1, sell(5, 'chest', 10))
  simulator.addOrder(1, buy(5, plate2.id, 11))
  run(simulator, 1, 6)
  assert.deepEqual([gold(simulator, 6), carried(simulator, 6)], [GOLD - plate.cost + sellValue(plate) - plate2.cost, { chest: plate2.id }])

  // Buy, then sell, in one tick: the buy finds the slot full, and does nothing, and then the sale empties it.
  const other = game()
  other.addOrder(1, buy(2, plate.id))
  other.addOrder(1, buy(5, plate2.id, 10))
  other.addOrder(1, sell(5, 'chest', 11))
  run(other, 1, 6)
  assert.deepEqual([gold(other, 6), carried(other, 6)], [GOLD - plate.cost + sellValue(plate), {}])
})

test('gold from kills can be spent at once, and what is bought is kept when its owner dies', () => {
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p1', 'One', { x: 600, y: 700 }, fighter, 1)
  simulator.addPlayer(2, 'p2', 'Two', { x: 700, y: 700 }, glass, 2)
  simulator.addOrder(2, buy(1, treads.id))
  simulator.addOrder(1, attack(2, 2))
  run(simulator, 1, 10)
  assert.equal(simulator.at(10).get(2)?.isDead(), true, 'the glass player is dead')
  assert.deepEqual([carried(simulator, 10, 2), gold(simulator, 10, 2)], [{ boots: treads.id }, GOLD - treads.cost], 'and still has what they bought, and what they had left')
  assert.equal(gold(simulator, 10), GAME_STARTING_GOLD + PLAYER_KILL_REWARD.gold, 'while the one who killed them has what that paid, to spend at once')
  // The dead can shop: it is there when they are back.
  simulator.addOrder(2, buy(11, plate.id))
  run(simulator, 11, 14)
  assert.deepEqual([carried(simulator, 14, 2), gold(simulator, 14, 2)], [{ boots: treads.id, chest: plate.id }, GOLD - treads.cost - plate.cost])
  assert.equal(maxHp(simulator, 14, 2), 100 + 300, 'the most health it can have is more, though it has none yet')
  assert.equal(hp(simulator, 14, 2), 0)
})

// ---------------------------------------------------------------------------- what they do

test('an item with health adds it to the most a champion can have, and to the health it has, and takes it off again when sold', () => {
  const simulator = game(fighter, dummy)
  simulator.addOrder(2, attack(2, 1))
  // Hit for 1 a second by the dummy: 999 of 1000 to start with.
  simulator.addOrder(1, buy(3, plate.id))
  run(simulator, 1, 4)
  assert.deepEqual([maxHp(simulator, 3), hp(simulator, 3)], [1300, 1299], 'more of both, by the same amount: 999 and 300 more')
  simulator.addOrder(1, sell(5, 'chest'))
  run(simulator, 5, 6)
  assert.deepEqual([maxHp(simulator, 5), hp(simulator, 5)], [1000, 999], 'and back to what it was: nothing gained by the round trip')
})

test('buying health for a champion that has lost some leaves it as hurt as it was, and selling it never takes the last of its health', () => {
  // A champion of 100 health that buys 300 more is at 400, is hit for 100, and is at 300 of 400. Selling the item takes the 300 off both: the most it
  // can have is 100 again, and the health it has would be nothing, so it has 1: alive, as selling is not a way to kill someone.
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p1', 'One', { x: 600, y: 700 }, glass, 1)
  simulator.addPlayer(2, 'p2', 'Two', { x: 700, y: 700 }, fighter, 2)
  const frail = defineItem({ id: 't-frail', name: 'Frail', slot: 'head', cost: part(0.2), stats: { maxHp: 300 } })
  simulator.addOrder(1, buy(2, frail.id))
  simulator.addOrder(2, attack(3, 1))
  run(simulator, 1, 5)
  assert.deepEqual([maxHp(simulator, 5), hp(simulator, 5)], [400, 300], 'hit for 100 of its 400')
  simulator.addOrder(1, sell(6, 'head'))
  run(simulator, 6, 8)
  assert.deepEqual([maxHp(simulator, 6), hp(simulator, 6)], [100, 1])
  assert.equal(simulator.at(8).get(1)?.isDead(), false)
})

test('attack damage adds to every auto: a hit of 100 is a hit of 150', () => {
  const plain = game(fighter, dummy)
  plain.addOrder(1, attack(2, 2))
  run(plain, 1, 6)
  const armed = game(fighter, dummy)
  armed.addOrder(1, buy(1, blade.id))
  armed.addOrder(1, attack(2, 2))
  run(armed, 1, 6)
  assert.equal(hp(plain, 6, 2), 5000 - 100)
  assert.equal(hp(armed, 6, 2), 5000 - 150)
})

test('resistance takes its share off what hits the carrier, as it does for a champion that is made with it', () => {
  const plain = game(fighter, dummy)
  plain.addOrder(1, attack(2, 2))
  run(plain, 1, 6)
  const warded = game(fighter, dummy)
  warded.addOrder(2, buy(1, ward.id))
  warded.addOrder(1, attack(2, 2))
  run(warded, 1, 6)
  assert.equal(hp(plain, 6, 2), 4900)
  assert.equal(hp(warded, 6, 2), 5000 - 50, 'a resistance of 100 takes half off a hit of 100')
})

test('arcane makes an ability that scales with it hit harder, and haste makes any come back sooner', () => {
  const blast = (items: string[], abilityId = 't-it-blast'): Simulator => {
    const simulator = game(fighter, dummy)
    items.forEach((id, index) => simulator.addOrder(1, buy(1 + index, id)))
    simulator.addOrder(1, { id: 'c', seq: 50, tick: 6, type: 'cast', abilityId, target: { mode: 'none' }, origin: { x: 600, y: 700 } })
    run(simulator, 1, 8)
    return simulator
  }
  const plain = blast([])
  const flatMagic = blast([sparkle.id])
  const spell = blast([], 't-it-spell')
  const magic = blast([sparkle.id], 't-it-spell')
  const fast = blast([hurry.id])
  assert.equal(hp(plain, 8, 2), 5000 - 100)
  assert.equal(hp(flatMagic, 8, 2), 5000 - 100, 'an ability written flat does not care how much arcane there is')
  assert.equal(hp(spell, 8, 2), 5000 - 100, 'one that scales with it has none to add before the item')
  assert.equal(hp(magic, 8, 2), 5000 - 150, 'and 100 arcane at a ratio of a half adds 50')
  const cooldown = (simulator: Simulator): number | undefined => simulator.at(8).get(1)?.getAbilityCooldown('t-it-blast').ticksRemaining
  assert.equal(cooldown(plain), 600 - 2)
  assert.equal(cooldown(fast), 300 - 2, 'a haste of 100 takes half off the cooldown')
})

test('attack speed shortens the time between autos, and attack range lets one hit from further away', () => {
  const swing = (items: string[]): Simulator => {
    const simulator = game(fighter, dummy)
    items.forEach((id, index) => simulator.addOrder(1, buy(1 + index, id)))
    simulator.addOrder(1, attack(4, 2))
    run(simulator, 1, 6)
    return simulator
  }
  assert.equal(swing([]).at(6).get(1)?.getCooldown().ticksRemaining, 60 - 2, 'an attack a second is every 60 ticks')
  assert.equal(swing([quick.id]).at(6).get(1)?.getCooldown().ticksRemaining, 30 - 2, 'two a second is every 30')

  // The dummy is 230 away: out of reach (150), until the scope adds 100.
  const far = (items: string[]): Simulator => {
    const simulator = economySimulator()
    simulator.addPlayer(1, 'p1', 'One', { x: 600, y: 700 }, fighter, 1)
    simulator.addPlayer(2, 'p2', 'Two', { x: 830, y: 700 }, dummy, 2)
    items.forEach((id, index) => simulator.addOrder(1, buy(1 + index, id)))
    simulator.addOrder(1, attack(4, 2))
    run(simulator, 1, 6)
    return simulator
  }
  assert.equal(hp(far([]), 6, 2), 5000, 'out of reach, so it walks up instead of hitting')
  assert.deepEqual(far([]).at(6).get(1)?.getMoveTarget(), { x: 830, y: 700 })
  assert.equal(hp(far([scope.id]), 6, 2), 5000 - 100, 'in reach with the scope')
  assert.deepEqual(far([scope.id]).at(6).get(1)?.getPosition(), { x: 600, y: 700 }, 'without taking a step')
})

test('move speed adds to how fast a champion walks', () => {
  const walked = (items: string[]): number => {
    const simulator = game()
    items.forEach((id, index) => simulator.addOrder(1, buy(1, id, 1 + index)))
    simulator.addOrder(1, walk(1, { x: 1900, y: 700 }, 10))
    run(simulator, 1, 61)
    return (simulator.at(61).get(1)?.getPosition().x ?? 0) - 600
  }
  assert.ok(Math.abs(walked([]) - 200) < 1e-6, 'a second at 200 is 200')
  assert.ok(Math.abs(walked([treads.id]) - 300) < 1e-6, 'and at 300 is 300')
})

test('what a champion has comes back with it when it respawns, and the health is the most it can have', () => {
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p1', 'One', { x: 600, y: 700 }, fighter, 1)
  simulator.addPlayer(2, 'p2', 'Two', { x: 700, y: 700 }, glass, 2)
  simulator.addOrder(1, attack(2, 2))
  simulator.addOrder(2, buy(11, plate.id))
  run(simulator, 1, 10)
  const died = simulator.at(10).get(2)?.getDeathTick() as number
  assert.ok(died !== undefined, 'killed')
  run(simulator, 11, died + 190)
  assert.equal(simulator.at(died + 190).get(2)?.isDead(), false, 'back')
  assert.deepEqual([maxHp(simulator, died + 190, 2), hp(simulator, died + 190, 2)], [400, 400])
  assert.deepEqual(carried(simulator, died + 190, 2), { chest: plate.id })
})

// ---------------------------------------------------------------------------- the same on every peer

test('a purchase whose order arrives late changes the frames after it, and they are the same as if it had been there all along', () => {
  const build = (): Simulator => {
    const simulator = game(fighter, dummy)
    simulator.addOrder(1, attack(4, 2))
    return simulator
  }
  const straight = build()
  straight.addOrder(1, buy(2, blade.id))
  straight.advanceTo(80)

  const late = build()
  late.advanceTo(10)
  assert.equal(hp(late, 10, 2), 5000 - 100, 'one hit of 100 so far, without the blade')
  assert.equal(late.addOrder(1, buy(2, blade.id)), true, 'an order for a tick that has been worked out already')
  late.advanceTo(80)
  assert.equal(JSON.stringify(late.at(80).toData()), JSON.stringify(straight.at(80).toData()))
  assert.equal(hp(late, 80, 2), 5000 - 150 - 150, 'both hits are of 150, the one that was worked out without the blade too')
})

test('a copy of a frame is its own: changing what it says the champion carries changes nothing in the game', () => {
  const simulator = game()
  simulator.addOrder(1, buy(2, ward.id))
  run(simulator, 1, 6)
  const copy = simulator.at(6).toData()
  const items = copy.characters.find((character) => character.characterId === 1)?.items
  assert.deepEqual(items, { back: ward.id })
  if (items) items.back = 'tampered'
  assert.deepEqual(carried(simulator, 6), { back: ward.id }, 'the frame it was copied from is as it was')
  assert.deepEqual(simulator.at(6).toData().characters.find((character) => character.characterId === 1)?.items, { back: ward.id })
  const got = simulator.at(6).get(1)?.getItems()
  if (got) got.back = 'tampered too'
  assert.deepEqual(carried(simulator, 6), { back: ward.id }, 'and so is what a character is asked it carries')
})

test('a purchase that is taken back leaves no trace of it', () => {
  const simulator = game()
  simulator.addOrder(1, buy(3, plate.id, 7))
  run(simulator, 1, 6)
  assert.deepEqual([gold(simulator, 6), carried(simulator, 6)], [GOLD - plate.cost, { chest: plate.id }])
  assert.equal(simulator.removeOrder(1, 7), true)
  run(simulator, 3, 8)
  assert.deepEqual([gold(simulator, 8), carried(simulator, 8), maxHp(simulator, 8)], [GOLD, {}, 1000])
})

test('gold and items travel in a snapshot\'s frame, and a simulator that restores one plays on the same', () => {
  const server = game(fighter, dummy)
  server.addOrder(1, buy(2, plate.id))
  server.addOrder(1, buy(3, ward.id))
  server.addOrder(1, sell(30, 'chest'))
  server.advanceTo(40)
  server.setCommitTick(32)
  const snapshot = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(server.snapshot())))
  const frame = snapshot.checkpoint.characters.find((each) => each.characterId === 1)
  assert.deepEqual([frame?.gold, frame?.items], [GOLD - plate.cost - ward.cost + sellValue(plate), { back: ward.id }], 'what it started with less the plate and the ward, and 70% of the plate back')
  const client = economySimulator()
  client.replaceFromSnapshot(snapshot)
  assert.deepEqual([gold(client, 32), carried(client, 32), maxHp(client, 32)], [GOLD - plate.cost - ward.cost + sellValue(plate), { back: ward.id }, 1000])
  server.advanceTo(90)
  client.advanceTo(90)
  assert.equal(JSON.stringify(client.at(90).toData()), JSON.stringify(server.at(90).toData()))
})

// ---------------------------------------------------------------------------- the server

test('the server takes orders to buy and sell, and turns one for an item that is not in the game away', () => {
  // Items are for the mode that has an economy: a game of core destruction.
  const state = new ServerGameState([])
  const players = [{ id: 'a', name: 'Ann', team: 1 }, { id: 'b', name: 'Bob', team: 2 }]
  const hearts = { id: 'hearts', spawns: testSpawns, terrain: new Terrain({ width: 2400, height: 1400 }), flags: [], cores: [{ x: 120, y: 600 }, { x: 430, y: 480 }] }
  state.beginSelection(players, hearts, 'core')
  for (const player of players) {
    state.pickChampion(player.id, fighter.id)
    state.lockChampion(player.id)
  }
  state.begin(players)
  const id = state.getCharacterId('a') as number
  const bought = state.acceptOrder('a', { id: 'a:1', seq: 1, tick: 1, type: 'buy', itemId: plate.id })
  assert.equal(bought.ack.status, 'accepted')
  assert.deepEqual(bought.broadcast, { id: 'a:1', seq: 1, tick: 1, type: 'buy', itemId: plate.id, characterId: id })
  const unknown = state.acceptOrder('a', { id: 'a:2', seq: 2, tick: 1, type: 'buy', itemId: 'no-such-item' })
  assert.deepEqual([unknown.ack.status, unknown.ack.reason, unknown.broadcast], ['rejected', 'unknown_item', undefined])
  const sold = state.acceptOrder('a', { id: 'a:3', seq: 3, tick: 3, type: 'sell', slot: 'chest' })
  assert.equal(sold.ack.status, 'accepted')
  for (let tick = 1; tick <= 5; tick += 1) state.advanceTick()
  assert.deepEqual(state.simulator.at(2).get(id)?.getItems(), { chest: plate.id }, 'bought on its tick')
  assert.deepEqual([state.simulator.at(5).get(id)?.getItems(), state.simulator.at(5).get(id)?.getGold()], [{}, GOLD - plate.cost + sellValue(plate)])
})
