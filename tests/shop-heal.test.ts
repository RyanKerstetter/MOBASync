import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GAME_TPS,
  GameSnapshotSchema,
  inOwnShop,
  loseHealth,
  mayShop,
  SHOP_HEAL_INTERVAL_TICKS,
  SHOP_HEAL_SECONDS,
  SHOP_HEALS_TO_FILL,
  shopHealAmount,
  shopHealsOn,
  Simulator,
  Terrain,
  type ModeSetup,
  type ShopZone,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineAbility, defineChampion, ECONOMY_MODE } from './fixtures.ts'

// A shop is also a healing area (see shops.ts): a living champion standing in a shop of its own team gets a share of its maximum health back every
// `SHOP_HEAL_INTERVAL_TICKS` ticks, enough to fill it from nothing in `SHOP_HEAL_SECONDS`. The champion, the wound and the shops here are the tests' own; how much
// the shop heals is read from the game's settings, so retuning it changes nothing here (and with it set to 0 the tests of healing are skipped: there is no healing to test).

const WOUND = 500
defineAbility({ id: 't-sh-wound', targeting: 'none', range: 0, windUpTicks: 0, cooldownTicks: 6000, apply: [loseHealth(WOUND)] })
const hero = defineChampion({
  id: 't-sh-hero',
  name: 'Heal Hero',
  base: { maxHp: 1000, attackDamage: 100, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: ['t-sh-wound'],
})
const HEALTHY = hero.maxHp
const WOUNDED = HEALTHY - WOUND
// What one heal of the shop gives this hero.
const HEAL = shopHealAmount(HEALTHY)

// A champion with three times the health, and a blow that leaves either of them with one point: the shop's heal is a share of the maximum, so it takes them the same time.
defineAbility({ id: 't-sh-crush', targeting: 'none', range: 0, windUpTicks: 0, cooldownTicks: 6000, apply: [loseHealth(1_000_000)] })
const titan = defineChampion({
  id: 't-sh-titan',
  name: 'Heal Titan',
  base: { maxHp: HEALTHY * 3, attackDamage: 100, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: ['t-sh-crush'],
})
const small = defineChampion({
  id: 't-sh-small',
  name: 'Heal Small',
  base: { maxHp: HEALTHY, attackDamage: 100, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: ['t-sh-crush'],
})

// Team 1's shop is the west of the arena, to x = 700, and team 2's is a small box far to the east.
const WEST: ShopZone = { team: 1, x: 0, y: 0, width: 700, height: 1440 }
const EAST: ShopZone = { team: 2, x: 2000, y: 600, width: 300, height: 300 }
const IN_WEST: Vector2 = { x: 300, y: 700 }
const IN_EAST: Vector2 = { x: 2100, y: 750 }
const BETWEEN: Vector2 = { x: 1200, y: 700 }

const heals = !(SHOP_HEAL_SECONDS > 0) ? { skip: 'the shop is set to heal nothing' } : {}

function world(zones: ShopZone[] = [WEST, EAST], setup: ModeSetup = ECONOMY_MODE): Simulator {
  return new Simulator(Terrain.plain(), setup, zones)
}
// A player that wounds itself on tick 1, standing where it is put.
function wounded(simulator: Simulator, id: number, at: Vector2, team: number): void {
  simulator.addPlayer(id, `p${id}`, `Player ${id}`, at, hero, team)
  simulator.addOrder(id, { id: `wound${id}`, seq: 1, tick: 1, type: 'cast', abilityId: 't-sh-wound', target: { mode: 'none' }, origin: at })
}
// The health of each of these players on every tick from 0 to `last`, in one pass forward (the simulator keeps only the last few frames).
function healthOver(simulator: Simulator, ids: readonly number[], last: number): Map<number, number[]> {
  const found = new Map(ids.map((id): [number, number[]] => [id, []]))
  for (let tick = 0; tick <= last; tick += 1) {
    const frame = simulator.at(tick)
    for (const id of ids) found.get(id)?.push(frame.get(id)?.getHealth() ?? 0)
  }
  return found
}
const ticksToFill = (): number => (Math.ceil(WOUND / Math.max(1, HEAL)) + 2) * SHOP_HEAL_INTERVAL_TICKS

// ---------------------------------------------------------------------------- the settings

test('the shop heals a whole number of health, a whole number of ticks apart, and the heals in its time are as many as it takes to fill a champion', () => {
  assert.ok(Number.isInteger(SHOP_HEAL_INTERVAL_TICKS) && SHOP_HEAL_INTERVAL_TICKS >= 1, 'a whole number of ticks')
  assert.ok(Number.isInteger(SHOP_HEALS_TO_FILL) && SHOP_HEALS_TO_FILL >= 1, 'a whole number of heals')
  assert.equal(SHOP_HEALS_TO_FILL * SHOP_HEAL_INTERVAL_TICKS, SHOP_HEAL_SECONDS * GAME_TPS, 'which take the time it is set to')
  for (const maxHp of [1, 90, HEALTHY, HEALTHY * 3, 12345]) {
    const amount = shopHealAmount(maxHp)
    assert.ok(Number.isInteger(amount) && amount >= 0, `whole numbers of health, for ${maxHp}`)
    assert.ok(amount * SHOP_HEALS_TO_FILL >= maxHp, `and enough heals of it fill ${maxHp}`)
    assert.ok((amount - 1) * SHOP_HEALS_TO_FILL < maxHp, `and no more than that, for ${maxHp}`)
  }
})

test('what the shop heals is a share of the maximum health: more for a champion with more', () => {
  assert.ok(shopHealAmount(HEALTHY * 3) > shopHealAmount(HEALTHY))
  assert.ok(Math.abs(shopHealAmount(HEALTHY * 3) - 3 * shopHealAmount(HEALTHY)) <= 3, 'three times the health, three times the heal, to the point it rounds up')
  assert.equal(shopHealAmount(0), 0, 'and nothing for nothing')
})

test('the shop heals on the ticks that are a multiple of its interval, and never when it heals nothing', () => {
  assert.equal(shopHealsOn(SHOP_HEAL_INTERVAL_TICKS * 3), SHOP_HEAL_SECONDS > 0)
  assert.equal(shopHealsOn(SHOP_HEAL_INTERVAL_TICKS * 3 + 1), false)
  assert.equal(shopHealsOn(SHOP_HEAL_INTERVAL_TICKS * 3 - 1), false)
})

test('a champion is in a shop of its own team when its middle is in it, and a game with no shops has none to be in', () => {
  assert.equal(inOwnShop([WEST, EAST], 1, IN_WEST), true)
  assert.equal(inOwnShop([WEST, EAST], 2, IN_WEST), false, 'the other team\'s shop is not its own')
  assert.equal(inOwnShop([WEST, EAST], 1, BETWEEN), false)
  assert.equal(inOwnShop([WEST, EAST], 2, IN_EAST), true)
  assert.equal(inOwnShop([], 1, IN_WEST), false, 'no shops, no healing area: unlike buying, healing is not allowed from anywhere')
  assert.equal(mayShop([], 1, IN_WEST), true, 'and buying still is')
})

// ---------------------------------------------------------------------------- healing

test('a wounded player in its own shop is healed on each heal tick, by the amount the shop heals, and on no other tick', heals, () => {
  const simulator = world()
  wounded(simulator, 1, IN_WEST, 1)
  const last = SHOP_HEAL_INTERVAL_TICKS * 4 + 3
  const hp = healthOver(simulator, [1], last).get(1) as number[]
  assert.equal(hp[0], HEALTHY)
  assert.equal(hp[1], WOUNDED, 'it hurt itself on tick 1')
  for (let tick = 2; tick <= last; tick += 1) {
    const expected = shopHealsOn(tick) ? Math.min(HEALTHY, hp[tick - 1] + HEAL) : hp[tick - 1]
    assert.equal(hp[tick], expected, `tick ${tick}${shopHealsOn(tick) ? ' is a heal tick' : ''}`)
  }
  assert.ok(hp[last] > WOUNDED, 'and it ends up better than it was')
})

test('a champion down to its last point is full again in the time the shop takes, whatever its maximum health is', heals, () => {
  const fullAt = (who: typeof hero): number => {
    const simulator = world()
    simulator.addPlayer(1, 'p1', 'One', IN_WEST, who, 1)
    simulator.addOrder(1, { id: 'crush', seq: 1, tick: 1, type: 'cast', abilityId: 't-sh-crush', target: { mode: 'none' }, origin: IN_WEST })
    const hp = healthOver(simulator, [1], SHOP_HEAL_SECONDS * GAME_TPS + SHOP_HEAL_INTERVAL_TICKS * 3).get(1) as number[]
    assert.equal(hp[1], 1, 'it was left with one point')
    assert.ok(hp.every((value) => value <= who.maxHp), 'and was never past its maximum')
    // The first tick after the blow that it is whole again (it starts the game whole, so tick 0 is no answer).
    return hp.findIndex((value, tick) => tick > 1 && value === who.maxHp)
  }
  const [smallAt, titanAt] = [fullAt(small), fullAt(titan)]
  for (const at of [smallAt, titanAt]) {
    assert.ok(at > 0, 'it did get full')
    // Hurt on tick 1, it is healed from the first heal tick after, and is full by the time the shop takes.
    assert.ok(at - 1 <= SHOP_HEAL_SECONDS * GAME_TPS, `in no more than ${SHOP_HEAL_SECONDS} seconds (tick ${at})`)
    assert.ok(at - 1 >= SHOP_HEAL_SECONDS * GAME_TPS - 2 * SHOP_HEAL_INTERVAL_TICKS, 'and not much sooner')
  }
  assert.equal(titanAt, smallAt, 'the same for a champion with three times the health')
})

test('it heals up to the maximum and no further, and a player at full health stays there', heals, () => {
  const simulator = world()
  wounded(simulator, 1, IN_WEST, 1)
  simulator.addPlayer(2, 'p2', 'Player 2', { x: IN_WEST.x, y: IN_WEST.y + 200 }, hero, 1)
  const hp = healthOver(simulator, [1, 2], ticksToFill() + SHOP_HEAL_INTERVAL_TICKS * 2)
  const first = hp.get(1) as number[]
  assert.equal(first[first.length - 1], HEALTHY, 'it is whole again')
  assert.ok(first.every((value) => value <= HEALTHY), 'and was never past its maximum')
  assert.ok((hp.get(2) as number[]).every((value) => value === HEALTHY), 'a player who was not hurt is not changed')
})

test('it heals the team that owns the shop only: not an enemy in it, not a player outside it, and not one in the other team\'s shop', heals, () => {
  const simulator = world()
  wounded(simulator, 1, IN_WEST, 1)
  wounded(simulator, 2, IN_WEST, 2)
  wounded(simulator, 3, BETWEEN, 1)
  wounded(simulator, 4, IN_EAST, 1)
  wounded(simulator, 5, IN_EAST, 2)
  const hp = healthOver(simulator, [1, 2, 3, 4, 5], ticksToFill())
  const end = (id: number): number => (hp.get(id) as number[]).at(-1) as number
  assert.equal(end(1), HEALTHY, 'a player of team 1 in the shop of team 1 is healed')
  assert.equal(end(5), HEALTHY, 'and one of team 2 in the shop of team 2')
  for (const [id, why] of [[2, 'an enemy in the shop'], [3, 'a player outside every shop'], [4, 'a player in the other team\'s shop']] as const) {
    assert.equal(end(id), WOUNDED, `${why} is not healed`)
  }
})

test('a game with no shops has no healing area, so no one is healed anywhere', heals, () => {
  const simulator = world([])
  wounded(simulator, 1, IN_WEST, 1)
  const hp = healthOver(simulator, [1], ticksToFill()).get(1) as number[]
  assert.equal(hp.at(-1), WOUNDED)
})

test('a shop heals in every mode that has one, not only the mode with an economy', heals, () => {
  for (const setup of [{ kind: 'deathmatch' }, ECONOMY_MODE] as ModeSetup[]) {
    const simulator = world([WEST, EAST], setup)
    wounded(simulator, 1, IN_WEST, 1)
    const hp = healthOver(simulator, [1], ticksToFill()).get(1) as number[]
    assert.equal(hp.at(-1), HEALTHY, setup.kind)
  }
})

test('a player that stands outside its shop is not healed, and starts to be once it walks in', heals, () => {
  const simulator = world()
  const outside = { x: WEST.x + WEST.width + 300, y: IN_WEST.y }
  wounded(simulator, 1, outside, 1)
  const wait = SHOP_HEAL_INTERVAL_TICKS * 2
  const reach = 60 + Math.ceil((outside.x - IN_WEST.x) / hero.moveSpeed * GAME_TPS)
  simulator.addOrder(1, { id: 'in', seq: 2, tick: wait, type: 'move', target: IN_WEST })
  const last = wait + reach + SHOP_HEAL_INTERVAL_TICKS * 3
  const hp = healthOver(simulator, [1], last).get(1) as number[]
  assert.equal(hp[wait], WOUNDED, 'not healed while it stood outside')
  assert.ok(hp[last] > WOUNDED, 'and healed once it was in')
})

test('every peer heals the same: a client that restores the game from a snapshot has the same health on the same tick', heals, () => {
  const server = world()
  wounded(server, 1, IN_WEST, 1)
  wounded(server, 2, BETWEEN, 1)
  server.advanceTo(30)
  server.setCommitTick(20)
  const client = new Simulator()
  client.replaceFromSnapshot(GameSnapshotSchema.parse(JSON.parse(JSON.stringify(server.snapshot()))))
  assert.deepEqual(client.shopZones, [WEST, EAST], 'the shops came with it')
  const at = SHOP_HEAL_INTERVAL_TICKS * 4
  for (const id of [1, 2]) assert.equal(client.at(at).get(id)?.getHealth(), server.at(at).get(id)?.getHealth(), `player ${id}`)
})
