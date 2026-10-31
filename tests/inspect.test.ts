import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState, type RenderedCharacter } from '../apps/client/src/game-state.ts'
import { inspectView } from '../apps/client/src/ui/inspect.ts'
import { MAX_HEALTH_LABEL, statRows } from '../apps/client/src/ui/hud.ts'
import { carriedTooltip } from '../apps/client/src/ui/shop.ts'
import {
  getItem,
  ITEM_SLOT_NAMES,
  ITEM_SLOTS,
  withItems,
  withStatBuffs,
  type Simulator,
} from '../packages/shared/src/index.ts'
import { defineChampion, defineItem, defineMonster, defineTurret, economyClient } from './fixtures.ts'

// Looking at a champion: a left click picks the living, seen character under it, whichever team it is on (`getCharacterNear`), and what is said of it is its
// name, level and stats with what its items add, and for a player what it carries (`getInspection`, and `inspectView` for the words). The items are the tests' own
// ("t-in-"), so retuning the shop's changes nothing here.

const hero = defineChampion({
  id: 't-in-hero',
  name: 'Inspect Hero',
  base: { maxHp: 1000, attackDamage: 100, attackSpeed: 1, arcane: 7 },
  growth: { maxHp: 50, attackDamage: 5 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: [],
})
const boots = defineItem({ id: 't-in-boots', name: 'Inspect Boots', slot: 'boots', cost: 10, stats: { moveSpeed: 40 } })
const robe = defineItem({ id: 't-in-robe', name: 'Inspect Robe', slot: 'chest', cost: 20, stats: { maxHp: 100, arcane: 30 } })
const charm = defineItem({
  id: 't-in-charm',
  name: 'Inspect Charm',
  slot: 'pet',
  cost: 10,
  stats: { attackDamage: 8 },
  effects: [{ kind: 'attackDamage', bonus: 0.25 }],
})
const wolf = defineMonster({
  id: 't-in-wolf',
  name: 'Inspect Wolf',
  base: { maxHp: 600, attackDamage: 30, attackSpeed: 1 },
  moveSpeed: 0,
  radius: 20,
  attackRange: 10,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300, respawnTicks: 20 },
  reward: { gold: 40, xp: 70, shards: 3 },
})
const tower = defineTurret(91, { base: { maxHp: 800, attackDamage: 50, attackSpeed: 1 }, radius: 30, attackRange: 300, attackWindup: 0 })

const buy = (tick: number, itemId: string) => ({ id: `b${tick}:${itemId}`, seq: tick, tick, type: 'buy' as const, itemId })

// Player 1 (Ann, the local champion, team 1), 2 (Bob, team 2, far to the right) and 3 (Cy, team 1, beside Ann). Bob has boots, a robe and a charm. A wolf (7) and a
// turret of Bob's team (8) stand between.
function game(): ClientGameState {
  const state = economyClient()
  const simulator: Simulator = state.simulator
  simulator.addPlayer(1, 'p1', 'Ann', { x: 600, y: 700 }, hero, 1)
  simulator.addPlayer(2, 'p2', 'Bob', { x: 1400, y: 700 }, hero, 2)
  simulator.addPlayer(3, 'p3', 'Cy', { x: 700, y: 700 }, hero, 1)
  simulator.addMonster(7, wolf, { x: 1000, y: 700 })
  simulator.addTurret(8, tower, { x: 1200, y: 900 }, 2)
  state.setLocalCharacterId(1)
  ;[boots, robe, charm].forEach((item, index) => simulator.addOrder(2, buy(1 + index, item.id)))
  simulator.advanceTo(10)
  return state
}
const named = (state: ClientGameState, name: string): RenderedCharacter => {
  const found = state.getCharacters(0).find((character) => character.name === name)
  assert.ok(found, `${name} is in the game`)
  return found
}
const inspectionOf = (state: ClientGameState, name: string) => {
  const inspection = state.getInspection(named(state, name), 0)
  assert.ok(inspection, `${name} can be looked at`)
  return inspection
}

// ---------------------------------------------------------------------------- what a click picks

test('a left click picks the character under it, on whichever team, with a hair of room round its body', () => {
  const state = game()
  const at = (x: number, y: number) => state.getCharacterNear({ x, y }, 0)?.name
  assert.equal(at(1400, 700), 'Bob', 'an enemy')
  assert.equal(at(700, 700), 'Cy', 'a teammate')
  assert.equal(at(600, 700), 'Ann', 'and the local champion itself')
  assert.equal(at(1000, 700), 'Inspect Wolf', 'a monster')
  assert.ok(at(1200, 900), 'and a turret')
  const radius = hero.radius
  assert.equal(at(1400 + radius + 5, 700), 'Bob', 'just outside its body is still it')
  assert.equal(at(1400 + radius + 30, 700), undefined, 'but not far outside')
  assert.equal(at(300, 300), undefined, 'and nothing on the ground')
})

test('the right click still picks enemies only: left looks, right attacks', () => {
  const state = game()
  assert.equal(state.getEnemyNear({ x: 700, y: 700 }, 0), undefined, 'a teammate is not attacked')
  assert.equal(state.getEnemyNear({ x: 600, y: 700 }, 0), undefined, 'nor oneself')
  assert.equal(state.getEnemyNear({ x: 1400, y: 700 }, 0)?.name, 'Bob')
})

test('the nearest one is picked when two overlap, and the dead and the unseen cannot be', () => {
  const state = game()
  const characters = state.getCharacters(0)
  // Bodies are pushed apart in the game, so two that overlap are made here: Cy is put 10 from Ann, and a point between them is the nearer one's.
  const overlapping = characters.map((character) => (character.name === 'Cy' ? { ...character, position: { x: 610, y: 700 } } : character))
  assert.equal(state.getCharacterNear({ x: 607, y: 700 }, 0, overlapping)?.name, 'Cy', '3 from Cy and 7 from Ann')
  assert.equal(state.getCharacterNear({ x: 603, y: 700 }, 0, overlapping)?.name, 'Ann', '3 from Ann and 7 from Cy')
  const bobDead = characters.map((character) => (character.name === 'Bob' ? { ...character, dead: true } : character))
  assert.equal(state.getCharacterNear({ x: 1400, y: 700 }, 0, bobDead), undefined, 'a dead one is gone')
  state.setSight((character) => character.name !== 'Bob')
  assert.equal(state.getCharacterNear({ x: 1400, y: 700 }, 0), undefined, 'one that is not seen is not there to be picked')
  assert.equal(state.getCharacterNear({ x: 700, y: 700 }, 0)?.name, 'Cy', 'and the rest still are')
})

// ---------------------------------------------------------------------------- what is said of it

test('a player is told by its name and champion, its level and how it stands to the local champion', () => {
  const state = game()
  const bob = inspectionOf(state, 'Bob')
  assert.deepEqual([bob.name, bob.championName, bob.relation], ['Bob', hero.name, 'enemy'])
  assert.equal(inspectionOf(state, 'Cy').relation, 'ally')
  assert.equal(inspectionOf(state, 'Ann').relation, 'you')
  // There are levels in a game with an economy, which is this one: a player starts on the first.
  assert.equal(bob.level, 1)
  assert.deepEqual(bob.health, { hp: 1000 + (robe.stats.maxHp ?? 0), maxHp: 1000 + (robe.stats.maxHp ?? 0), shield: 0 })
})

test('its stats are those of its level with what its items add, and what carries it is what it has bought', () => {
  const state = game()
  const bob = inspectionOf(state, 'Bob')
  const sim = state.simulator.characters.get(2)
  assert.ok(sim)
  const expected = withItems(sim.champion.statsAt(1), { boots: boots.id, chest: robe.id, pet: charm.id })
  assert.deepEqual(bob.stats, expected)
  assert.equal(bob.stats.moveSpeed, hero.moveSpeed + (boots.stats.moveSpeed ?? 0), 'what the boots add')
  assert.equal(bob.stats.arcane, 7 + (robe.stats.arcane ?? 0), 'on what it started with')
  assert.deepEqual(bob.items, { boots: boots.id, chest: robe.id, pet: charm.id })
  // One that has bought nothing is the champion as it was made.
  const ann = inspectionOf(state, 'Ann')
  assert.deepEqual(ann.stats, withStatBuffs(withItems(hero.statsAt(1), {}), []))
  assert.deepEqual(ann.items, {})
})

test('a monster has a level and no items, and a turret has neither', () => {
  const state = game()
  const wolfView = inspectionOf(state, 'Inspect Wolf')
  assert.equal(wolfView.level, 1, 'a monster grows by what it kills, so it always says')
  assert.equal(wolfView.items, undefined)
  assert.equal(wolfView.championName, undefined, 'it is not a champion a player chose')
  assert.equal(wolfView.relation, 'enemy', 'a monster is against everyone')
  const turret = state.getCharacters(0).find((character) => character.turret)
  assert.ok(turret)
  const turretView = state.getInspection(turret, 0)
  assert.ok(turretView)
  assert.equal(turretView.level, undefined)
  assert.equal(turretView.items, undefined)
  assert.equal(turretView.relation, 'enemy')
  assert.equal(turretView.health.maxHp, 800)
})

test('in a game with no items a player is told by its stats alone', () => {
  const state = new ClientGameState()
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 600, y: 700 }, hero, 1)
  state.simulator.addPlayer(2, 'p2', 'Bob', { x: 700, y: 700 }, hero, 2)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  const bob = state.getInspection(state.getCharacters(0).find((character) => character.name === 'Bob') as RenderedCharacter, 0)
  assert.ok(bob)
  assert.equal(bob.items, undefined, 'there is nothing to buy')
  assert.equal(bob.level, undefined, 'and nobody levels')
})

// ---------------------------------------------------------------------------- the words

test('the panel says the name, the level, who it is, the health and the stats but for the health, and each slot of what a player carries', () => {
  const state = game()
  const view = inspectView(inspectionOf(state, 'Bob'))
  assert.equal(view.name, 'Bob')
  assert.equal(view.subtitle, `${hero.name} · Enemy`)
  assert.equal(view.level, 'Lv 1')
  assert.equal(view.health.health, `${1000 + (robe.stats.maxHp ?? 0)} / ${1000 + (robe.stats.maxHp ?? 0)}`)
  assert.deepEqual(view.stats.map((row) => row.label), statRows(inspectionOf(state, 'Bob').stats).map((row) => row.label).filter((label) => label !== MAX_HEALTH_LABEL))
  assert.equal(view.stats.some((row) => row.label === MAX_HEALTH_LABEL), false, 'the health is the bar')
  assert.deepEqual(view.items?.map((cell) => cell.slot), [...ITEM_SLOTS], 'a cell for each slot, in the order of the shop')
  assert.deepEqual(view.items?.map((cell) => cell.slotName), ITEM_SLOTS.map((slot) => ITEM_SLOT_NAMES[slot]))
  assert.deepEqual(view.items?.filter((cell) => cell.itemId !== undefined).map((cell) => [cell.slot, cell.itemId]), [
    ['boots', boots.id],
    ['chest', robe.id],
    ['pet', charm.id],
  ])
})

test('what a monster or a turret is told by has no slots, no level for a turret, and says who it is against', () => {
  const state = game()
  const wolfView = inspectView(inspectionOf(state, 'Inspect Wolf'))
  assert.equal(wolfView.subtitle, 'Enemy', 'with no champion in front of it')
  assert.equal(wolfView.level, 'Lv 1')
  assert.equal(wolfView.items, undefined)
  const turret = state.getCharacters(0).find((character) => character.turret) as RenderedCharacter
  const turretView = inspectView(state.getInspection(turret, 0) as NonNullable<ReturnType<ClientGameState['getInspection']>>)
  assert.equal(turretView.level, undefined)
  assert.equal(inspectView(inspectionOf(state, 'Cy')).subtitle, `${hero.name} · Ally`)
  assert.equal(inspectView(inspectionOf(state, 'Ann')).subtitle, `${hero.name} · You`)
})

test('the box over an item that someone carries says what it is and does, and nothing about selling it', () => {
  const tip = carriedTooltip(charm)
  assert.deepEqual([tip.name, tip.slot], [charm.name, ITEM_SLOT_NAMES.pet])
  assert.equal(tip.about, charm.description, 'what its effect does')
  assert.ok(tip.about && tip.about.length > 0)
  assert.deepEqual(tip.stats, [{ label: 'Attack damage', value: '+8' }])
  assert.equal(tip.note, undefined, 'no "right-click to sell", which is for your own')
  assert.equal(tip.cost, undefined)
  assert.equal(carriedTooltip(boots).about, undefined, 'and an item with no effect has no line for one')
  assert.equal(getItem(charm.id), charm)
})
