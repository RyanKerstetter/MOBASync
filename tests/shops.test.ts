import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { HUD_ITEM_COLUMNS, HUD_ITEM_ROWS } from '../apps/client/src/ui/hud.ts'
import { ownedTooltip, shopEntries, shopTooltip } from '../apps/client/src/ui/shop.ts'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  flattenLayers,
  GAME_MAX_PLAYERS,
  GAME_STARTING_GOLD,
  GameSnapshotSchema,
  getProperty,
  ITEM_SLOTS,
  mayShop,
  NOT_IN_SHOP,
  parseTiledMap,
  readMapLayout,
  sellValue,
  shopZoneContains,
  Simulator,
  Terrain,
  type ShopZone,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineChampion, defineItem, ECONOMY_MODE, economySimulator } from './fixtures.ts'
import { testSpawns } from './test-spawns.ts'

// Where items can be bought and sold (see shops.ts): in a shop of your own team, which the map draws as rectangles. The shop can be looked at from
// anywhere. Items here are the tests' own ("t-sz-").

// What these cost is a share of the gold a player starts with (the game's number, which is tuned), so both can be afforded, and what is expected is worked
// out from the items and from it, and not written out.
const GOLD = GAME_STARTING_GOLD
const part = (share: number): number => Math.max(1, Math.floor(GOLD * share))
const plate = defineItem({ id: 't-sz-plate', name: 'Zone Plate', slot: 'chest', cost: part(0.8), stats: { maxHp: 300 } })
const ward = defineItem({ id: 't-sz-ward', name: 'Zone Ward', slot: 'back', cost: part(0.2), stats: { resistance: 10 } })
const hero = defineChampion({
  id: 't-sz-hero',
  name: 'Zone Hero',
  base: { maxHp: 1000, attackDamage: 100, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: [],
})
const glass = defineChampion({ ...hero, id: 't-sz-glass', base: { ...hero.base, maxHp: 100 } })

// Team 1's shop is the west of the arena, to x = 700, and team 2's is a small box far to the east.
const WEST: ShopZone = { team: 1, x: 0, y: 0, width: 700, height: 1440 }
const EAST: ShopZone = { team: 2, x: 2000, y: 600, width: 300, height: 300 }

const buy = (tick: number, itemId: string) => ({ id: `b${tick}`, seq: tick, tick, type: 'buy' as const, itemId })
const sell = (tick: number, slot: (typeof ITEM_SLOTS)[number]) => ({ id: `s${tick}`, seq: tick, tick, type: 'sell' as const, slot })
const walk = (tick: number, target: Vector2) => ({ id: `w${tick}`, seq: tick, tick, type: 'move' as const, target })
const attack = (tick: number, targetId: number) => ({ id: `a${tick}`, seq: tick, tick, type: 'attack' as const, targetId })
const run = (simulator: Simulator, from: number, to: number): void => {
  for (let tick = from; tick <= to; tick += 1) simulator.at(tick)
}
const gold = (simulator: Simulator, tick: number, id = 1): number | undefined => simulator.at(tick).get(id)?.getGold()
const carried = (simulator: Simulator, tick: number, id = 1) => simulator.at(tick).get(id)?.getItems()
const zoned = (zones: ShopZone[]): Simulator => new Simulator(Terrain.plain(), ECONOMY_MODE, zones)

// ---------------------------------------------------------------------------- the rule

test('a shop is a rectangle that belongs to a team, and a champion is in it when its middle is, edges included', () => {
  assert.equal(shopZoneContains(WEST, { x: 0, y: 0 }), true, 'the corner')
  assert.equal(shopZoneContains(WEST, { x: 700, y: 1440 }), true, 'the far corner')
  assert.equal(shopZoneContains(WEST, { x: 700.5, y: 700 }), false)
  assert.equal(shopZoneContains(WEST, { x: 350, y: -1 }), false)
  assert.equal(shopZoneContains(EAST, { x: 2150, y: 750 }), true)
})

test('a team can shop in its own shop, in none of another team\'s, and anywhere if the game has no shops', () => {
  const zones = [WEST, EAST]
  assert.equal(mayShop(zones, 1, { x: 600, y: 700 }), true, 'team 1 in its own')
  assert.equal(mayShop(zones, 1, { x: 2150, y: 750 }), false, 'team 1 in the other team\'s')
  assert.equal(mayShop(zones, 2, { x: 600, y: 700 }), false, 'and the other way')
  assert.equal(mayShop(zones, 2, { x: 2150, y: 750 }), true)
  assert.equal(mayShop(zones, 1, { x: 1200, y: 700 }), false, 'between them, in neither')
  assert.equal(mayShop(zones, 3, { x: 600, y: 700 }), false, 'a team with no shop has nowhere')
  assert.equal(mayShop([], 1, { x: 1200, y: 700 }), true, 'no shops at all: anywhere')
})

// ---------------------------------------------------------------------------- in a game

test('items are bought and sold in the shop and not outside it, and walking back in lets the same orders work', () => {
  const simulator = zoned([WEST, EAST])
  simulator.addPlayer(1, 'p1', 'One', { x: 600, y: 700 }, hero, 1)
  simulator.addOrder(1, buy(2, plate.id))
  simulator.addOrder(1, walk(3, { x: 1500, y: 700 }))
  run(simulator, 1, 4)
  assert.deepEqual([gold(simulator, 4), carried(simulator, 4)], [GOLD - plate.cost, { chest: plate.id }], 'bought, standing in the shop')
  run(simulator, 5, 60)
  const x = simulator.at(60).get(1)?.getPosition().x as number
  assert.ok(x > 700, `now outside it: ${x}`)
  assert.equal(simulator.canShop(1, simulator.at(60)), false)

  // Outside, an order to buy or to sell is nothing: not the gold, not the item, not the slot.
  simulator.addOrder(1, buy(61, ward.id))
  simulator.addOrder(1, sell(62, 'chest'))
  simulator.addOrder(1, walk(63, { x: 600, y: 700 }))
  run(simulator, 61, 70)
  assert.deepEqual([gold(simulator, 70), carried(simulator, 70)], [GOLD - plate.cost, { chest: plate.id }], 'nothing was bought or sold away from the shop')

  // Back in, the same orders do what they say.
  run(simulator, 71, 150)
  assert.equal(simulator.canShop(1, simulator.at(150)), true)
  simulator.addOrder(1, buy(151, ward.id))
  simulator.addOrder(1, sell(152, 'chest'))
  run(simulator, 151, 155)
  assert.deepEqual([gold(simulator, 155), carried(simulator, 155)], [GOLD - plate.cost - ward.cost + sellValue(plate), { back: ward.id }], 'the ward bought, and the plate sold for the sell rate')
})

test('a team shops in its own shop only: another team\'s does not do, and a team with no shop in a game that has them cannot shop', () => {
  const simulator = zoned([WEST, EAST])
  simulator.addPlayer(1, 'p1', 'One', { x: 2100, y: 750 }, hero, 1)
  simulator.addPlayer(2, 'p2', 'Two', { x: 2150, y: 750 }, hero, 2)
  simulator.addPlayer(3, 'p3', 'Three', { x: 600, y: 700 }, hero, 3)
  for (const id of [1, 2, 3]) simulator.addOrder(id, buy(2, ward.id))
  run(simulator, 1, 4)
  assert.deepEqual([carried(simulator, 4, 1), carried(simulator, 4, 2), carried(simulator, 4, 3)], [{}, { back: ward.id }, {}], 'team 1 is in team 2\'s shop, and team 3 has none')
})

test('a champion that is dead can shop, wherever it fell, as it comes back in its base', () => {
  const simulator = zoned([WEST, EAST])
  simulator.addPlayer(1, 'p1', 'One', { x: 1200, y: 700 }, glass, 1)
  simulator.addPlayer(2, 'p2', 'Two', { x: 1300, y: 700 }, hero, 2)
  simulator.addOrder(1, buy(1, ward.id))
  simulator.addOrder(2, attack(2, 1))
  simulator.addOrder(1, buy(10, ward.id))
  run(simulator, 1, 4)
  assert.deepEqual(carried(simulator, 4), {}, 'alive, and away from the shop: refused')
  run(simulator, 5, 12)
  assert.equal(simulator.at(12).get(1)?.isDead(), true)
  assert.equal(simulator.canShop(1, simulator.at(12)), true)
  assert.deepEqual(carried(simulator, 12), { back: ward.id }, 'dead, it can buy')
})

test('a game with no shops can be shopped in from anywhere', () => {
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p1', 'One', { x: 1200, y: 700 }, hero, 1)
  simulator.addOrder(1, buy(2, ward.id))
  run(simulator, 1, 4)
  assert.deepEqual(carried(simulator, 4), { back: ward.id })
  assert.deepEqual(simulator.shopZones, [])
})

test('the shops are in a snapshot, and a simulator that restores one keeps to them, and one that is reset has them as it is told', () => {
  const server = zoned([WEST, EAST])
  server.addPlayer(1, 'p1', 'One', { x: 1200, y: 700 }, hero, 1)
  server.advanceTo(20)
  server.setCommitTick(10)
  const snapshot = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(server.snapshot())))
  assert.deepEqual(snapshot.shops, [WEST, EAST])
  const client = new Simulator()
  assert.deepEqual(client.shopZones, [])
  client.replaceFromSnapshot(snapshot)
  assert.deepEqual(client.shopZones, [WEST, EAST])
  client.addOrder(1, buy(25, ward.id))
  client.advanceTo(30)
  assert.deepEqual(carried(client, 30), {}, 'away from the shop, on the client as on the server')
  // A game with none has no field for them, and a snapshot of it restores to none.
  assert.equal('shops' in new Simulator().snapshot(), false)
  client.replaceFromSnapshot(GameSnapshotSchema.parse(JSON.parse(JSON.stringify(new Simulator().snapshot()))))
  assert.deepEqual(client.shopZones, [])
  client.reset(undefined, undefined, [EAST])
  assert.deepEqual(client.shopZones, [EAST])
  client.reset()
  assert.deepEqual(client.shopZones, [], 'a reset with none given leaves none')
})

// ---------------------------------------------------------------------------- the map

function mapWith(objects: unknown[]): ReturnType<typeof parseTiledMap> {
  const spawns = [1, 2].flatMap((slot) => [1, 2, 3, 4].map((number) => ({
    id: 100 + slot * 10 + number,
    name: `spawn-${slot}-${number}`,
    type: 'spawn',
    point: true,
    x: 100 + slot * 100,
    y: 100 + number * 40,
    properties: [{ name: 'team-name', type: 'int', value: slot }, { name: 'spawn-number', type: 'int', value: number }],
  })))
  return parseTiledMap({
    orientation: 'orthogonal',
    width: 100,
    height: 100,
    tilewidth: 16,
    tileheight: 16,
    layers: [{
      type: 'objectgroup',
      name: 'Objects',
      objects: [{ id: 1, name: 'arena', type: 'arena', x: 0, y: 0, width: 800, height: 500 }, ...spawns, ...objects],
    }],
    tilesets: [],
  })
}
let nextId = 3000
const shopObject = (slot: unknown, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}) => ({
  id: nextId++,
  name: `shop-${String(slot)}`,
  type: 'shop',
  x,
  y,
  width,
  height,
  properties: slot === undefined ? [] : [{ name: 'team-name', type: 'int', value: slot }],
  ...extra,
})
const problemsOf = (objects: unknown[]): string => {
  try {
    readMapLayout(mapWith(objects))
  } catch (error) {
    return (error as Error).message
  }
  return assert.fail('the map was accepted')
}

test('a map has shops where its shop rectangles are, for the slot they name, in whole world units', () => {
  const layout = readMapLayout(mapWith([shopObject(1, 150, 100, 150, 200), shopObject(2, 250, 100, 100.4, 200)]))
  // Map pixels from the arena's corner are three world units each.
  assert.deepEqual(layout.shops, [
    { slot: 1, x: 450, y: 300, width: 450, height: 600 },
    { slot: 2, x: 750, y: 300, width: 301, height: 600 },
  ])
  assert.deepEqual(readMapLayout(mapWith([])).shops, [], 'a map need not have any: then the whole map is a shop')
  assert.equal(readMapLayout(mapWith([shopObject(1, 150, 100, 150, 200), shopObject(2, 250, 100, 100, 200), shopObject(5, 600, 400, 100, 50)])).shops.length, 3, 'a shop for a slot with no spawn points is fine')
  assert.equal(readMapLayout(mapWith([shopObject(1, 150, 100, 150, 200), shopObject(1, 600, 400, 100, 50), shopObject(2, 250, 100, 100, 200)])).shops.length, 3, 'as are two for one team')
})

test('a map with shops needs one for every slot that has spawn points, or a team could never buy, and says which', () => {
  assert.match(problemsOf([shopObject(1, 150, 100, 150, 200)]), /Slot 2 has spawn points but no shop, so its team could never buy: give a shop the team-name 2\./)
  assert.match(problemsOf([shopObject(2, 150, 100, 150, 200)]), /Slot 1 has spawn points but no shop/)
  assert.match(problemsOf([shopObject(1, 150, 100, 150, 200), shopObject(1, 250, 100, 100, 200)]), /Slot 2 has spawn points but no shop/, 'two for slot 1 is no help to slot 2')
  assert.doesNotMatch(problemsOf([shopObject(5, 150, 100, 150, 200)]), /Slot 3/, 'only the slots that are in use')
})

test('a shop that is not right says which, and what is wrong', () => {
  const two = [shopObject(1, 150, 100, 150, 200), shopObject(2, 250, 100, 100, 200)]
  assert.match(problemsOf([shopObject(1, 150, 100, 150, 200, { ellipse: true }), two[1]]), /shop-1 is not a plain rectangle/)
  assert.match(problemsOf([shopObject(1, 150, 100, 150, 200, { rotation: 20 }), two[1]]), /shop-1 is not a plain rectangle/)
  assert.match(problemsOf([shopObject(undefined, 150, 100, 150, 200), two[1]]), new RegExp(`shop-undefined needs a team-name from 1 to ${GAME_MAX_PLAYERS}: the slot of spawn points whose team shops there`))
  for (const slot of [0, GAME_MAX_PLAYERS + 1, 1.5, 'one']) assert.match(problemsOf([shopObject(slot, 150, 100, 150, 200), two[1]]), /needs a team-name from 1/, String(slot))
  assert.match(problemsOf([shopObject(1, 5000, 100, 150, 200), two[1]]), /shop-1 is outside the arena/)
  assert.match(problemsOf([shopObject(1, -300, 100, 150, 200), two[1]]), /shop-1 is outside the arena/)
})

test('the competitive map has a shop for each team, and each team starts in its own', () => {
  const map = parseTiledMap(JSON.parse(readFileSync(new URL('../res/maps/competetive.tmj', import.meta.url), 'utf-8')))
  const layout = readMapLayout(map)
  const slots = new Set(layout.shops.map((shop) => shop.slot))
  assert.deepEqual([...slots].sort(), [1, 2], 'a shop for each of the two slots of spawn points')
  const objects = flattenLayers(map.layers).flatMap(({ layer }) => layer.type === 'objectgroup' ? layer.objects : [])
  assert.equal(layout.shops.length, objects.filter((object) => (object.class ?? object.type) === 'shop').length, 'and every shop on the map is read')
  assert.ok(objects.some((object) => (object.class ?? object.type) === 'shop' && getProperty(object.properties, 'team-name') === 2))
  // Players start where they can shop.
  layout.spawns.forEach((points, index) => {
    for (const point of points) {
      assert.ok(layout.shops.some((shop) => shop.slot === index + 1 && shopZoneContains({ team: index + 1, ...shop }, point)), `a spawn point of slot ${index + 1} is in its shop`)
    }
  })
})

// ---------------------------------------------------------------------------- the server

const terrain = new Terrain({ width: 2400, height: 1400 })
const shops = [
  { slot: 1, x: 100, y: 100, width: 600, height: 600 },
  { slot: 2, x: 1500, y: 100, width: 600, height: 600 },
  { slot: 4, x: 1000, y: 1000, width: 100, height: 100 },
]

test('the server makes each shop the shop of the team that starts at its slot, and leaves out the shops of slots nobody starts at', () => {
  const players = [{ id: 'a', name: 'Ann', team: 2 }, { id: 'b', name: 'Bob', team: 2 }, { id: 'c', name: 'Cat', team: 1 }]
  const state = new ServerGameState([])
  assert.equal(state.beginSelection(players, { id: 'shops', spawns: testSpawns, terrain, flags: [], shops }), true)
  for (const player of players) state.lockChampion(player.id)
  state.begin(players)
  // Team 2 is the bigger team, so it starts at slot 1 and shops there; Cat's team 1 is the second, at slot 2. Slot 4 has no team.
  assert.deepEqual(state.simulator.shopZones, [
    { team: 2, x: 100, y: 100, width: 600, height: 600 },
    { team: 1, x: 1500, y: 100, width: 600, height: 600 },
  ])
  assert.deepEqual(GameSnapshotSchema.parse(JSON.parse(JSON.stringify(state.snapshot()))).shops?.map((zone) => zone.team), [2, 1], 'and they are in the snapshot')
  // A game on a map with none is shopped in from anywhere, and the next game is not given the last one's.
  state.cancelStart()
  state.beginSelection(players, { id: 'plain', spawns: testSpawns, terrain, flags: [] })
  for (const player of players) state.lockChampion(player.id)
  state.begin(players)
  assert.deepEqual(state.simulator.shopZones, [])
})

// ---------------------------------------------------------------------------- the page

function clientGame(inside: boolean): ClientGameState {
  const state = new ClientGameState()
  state.simulator.reset(undefined, ECONOMY_MODE, [WEST])
  state.simulator.addPlayer(1, 'p1', 'Ann', inside ? { x: 600, y: 700 } : { x: 1500, y: 700 }, hero, 1)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  return state
}

test('the page buys and sells in the shop, and says why not away from it, without sending an order', () => {
  const away = clientGame(false)
  assert.equal(away.getLocalLoadout(0)?.inShop, false)
  assert.deepEqual(away.createBuyOrder(ward.id, 0), { ok: false, reason: NOT_IN_SHOP })
  assert.deepEqual(away.createSellOrder('back', 0), { ok: false, reason: NOT_IN_SHOP }, 'the shop is checked first, before it looks for what is to sell')
  assert.equal(away.simulator.characters.get(1)?.orders.length, 0, 'no order was given')

  const inside = clientGame(true)
  assert.equal(inside.getLocalLoadout(0)?.inShop, true)
  assert.equal(inside.createBuyOrder(ward.id, 0).ok, true)
  inside.simulator.advanceTo(40)
  assert.deepEqual(inside.getLocalLoadout(0)?.items, { back: ward.id })
  assert.equal(inside.createSellOrder('back', 0).ok, true)
  assert.equal(NOT_IN_SHOP, 'You can only buy and sell in your own shop.')
})

test('the shop and the slots say so when you are away from your shop: an item you could buy cannot be, and one you carry is sold there', () => {
  const [available] = shopEntries('back', { gold: GOLD * 10, items: {} }).filter((entry) => entry.item.id === ward.id)
  assert.deepEqual([shopTooltip(available).note, shopTooltip(available).tone], ['Click to buy.', 'good'], 'in a shop, or with nothing said')
  assert.deepEqual([shopTooltip(available, true).note, shopTooltip(available, false).note, shopTooltip(available, false).tone], ['Click to buy.', NOT_IN_SHOP, 'bad'])
  const [poor] = shopEntries('chest', { gold: plate.cost - 1, items: {} }).filter((entry) => entry.item.id === plate.id)
  assert.equal(shopTooltip(poor, false).note, 'You need 1 more gold.', 'what is wrong with an item is still what is said of it')
  assert.match(ownedTooltip(plate).note ?? '', new RegExp(`^Right-click to sell for ${sellValue(plate)} gold`))
  assert.equal(ownedTooltip(plate, false).note, `In your shop you can sell it for ${sellValue(plate)} gold (it cost ${plate.cost}).`)
})

// ---------------------------------------------------------------------------- the grid on the HUD

test('the item slots are a grid of four across and two down, and every kind of item has a cell in it', () => {
  assert.deepEqual([HUD_ITEM_COLUMNS, HUD_ITEM_ROWS], [4, 2])
  // Eight kinds fill it. A ninth needs HUD_ITEM_ROWS (or the columns) to grow, and this says so before the HUD runs out of room.
  assert.ok(ITEM_SLOTS.length <= HUD_ITEM_COLUMNS * HUD_ITEM_ROWS, 'a new kind of item has a cell, or this grid has to grow')
  assert.deepEqual([ITEM_SLOTS.length, ITEM_SLOTS.slice(-2)], [8, ['pet', 'potion']])
})
