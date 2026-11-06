import assert from 'node:assert/strict'
import test from 'node:test'
import { itemStatLines } from '../apps/client/src/ui/shop.ts'
import {
  Champion,
  GAME_MOVE_SPEED_MULTIPLIER,
  GAME_TPS,
  haste,
  Item,
  items,
  self,
  Simulator,
  slow,
  walkingSpeed,
  withItems,
  type CharacterOrder,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineAbility, economyClient, economySimulator, registerChampion } from './fixtures.ts'

// How fast everything walks is the game's move speed multiplier (`GAME_MOVE_SPEED_MULTIPLIER`) times the speed it is written with, worked out in one place (`walkingSpeed`) that the
// simulator, the page's stats and the items' tooltips all ask. The bodies and items here are made by hand and not with the fixtures' `define...`, which cancel the multiplier out
// so that the other tests can place a scene by how far a second takes a body; these keep it. What they are written with is the tests' own, and the multiplier is the game's, so
// nothing here depends on what it is set to.

// Plus half for two seconds, and a tenth less on top for as long (a slow is of the speed with the haste in it).
defineAbility({ id: 't-ms-sprint', targeting: 'none', range: 0, windUpTicks: 0, cooldownTicks: 600, apply: [haste(0.5, 120, self())] })
defineAbility({ id: 't-ms-bog', targeting: 'none', range: 0, windUpTicks: 0, cooldownTicks: 600, apply: [slow(0.1, 120, self())] })
const WRITTEN = 200
const walker = registerChampion(new Champion({
  id: 't-ms-walker',
  name: 'Speed Walker',
  base: { maxHp: 1000, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: WRITTEN,
  radius: 20,
  attackRange: 100,
  attackWindup: 0,
  abilities: ['t-ms-sprint', 't-ms-bog'],
}))

const BOOTS = 40
const boots = new Item({ id: 't-ms-boots', name: 'Speed Boots', slot: 'boots', cost: 1, stats: { moveSpeed: BOOTS } })
;(items as unknown as Map<string, Item>).set(boots.id, boots)

let sequence = 0
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })
const START: Vector2 = { x: 300, y: 700 }
const FAR: Vector2 = { x: 2200, y: 700 }
const step = (simulator: Simulator, tick: number): number => {
  const before = simulator.at(tick - 1).get(1)?.getPosition()
  const after = simulator.at(tick).get(1)?.getPosition()
  assert.ok(before && after)
  return Math.hypot(after.x - before.x, after.y - before.y)
}
const closeTo = (actual: number, expected: number, message?: string): void =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} is not ${expected}`.trim())

test('a walking speed is what it is written with and what its items add, times the multiplier', () => {
  assert.ok(Number.isFinite(GAME_MOVE_SPEED_MULTIPLIER) && GAME_MOVE_SPEED_MULTIPLIER > 0, 'a multiplier that is a number above 0')
  assert.equal(walkingSpeed(WRITTEN), WRITTEN * GAME_MOVE_SPEED_MULTIPLIER)
  assert.equal(walkingSpeed(WRITTEN, BOOTS), (WRITTEN + BOOTS) * GAME_MOVE_SPEED_MULTIPLIER)
  assert.equal(walkingSpeed(0, BOOTS), BOOTS * GAME_MOVE_SPEED_MULTIPLIER, 'with no base it is what an item really adds')
  assert.equal(walkingSpeed(0), 0, 'and nothing is nothing')
})

test('a champion walks at the multiplied speed', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', START, walker, 1)
  simulator.addOrder(1, move(1, FAR))
  closeTo(step(simulator, 10), walkingSpeed(WRITTEN) / GAME_TPS, 'a step')
  closeTo(step(simulator, 50), walkingSpeed(WRITTEN) / GAME_TPS, 'and a step later on')
})

test('a haste and a slow are of the multiplied speed: they are shares of it', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', START, walker, 1)
  simulator.addOrder(1, move(1, FAR))
  // A cast is from where the caster is, which is a little way on by the time of the second.
  const cast = (tick: number, abilityId: string): CharacterOrder => {
    const origin = simulator.at(tick - 1).get(1)?.getPosition() ?? START
    return { id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target: { mode: 'none' }, origin: { ...origin } }
  }
  simulator.addOrder(1, cast(5, 't-ms-sprint'))
  closeTo(step(simulator, 20), walkingSpeed(WRITTEN) * 1.5 / GAME_TPS, 'hasted')
  simulator.addOrder(1, cast(30, 't-ms-bog'))
  closeTo(step(simulator, 50), walkingSpeed(WRITTEN) * 1.5 * 0.9 / GAME_TPS, 'hasted and slowed')
})

test('what items add to the speed is multiplied too, so they are as strong against the written speeds as they were written to be', () => {
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p1', 'One', START, walker, 1)
  simulator.addOrder(1, { id: 'buy', seq: 1, tick: 1, type: 'buy', itemId: boots.id })
  simulator.addOrder(1, move(2, FAR))
  closeTo(step(simulator, 20), walkingSpeed(WRITTEN, BOOTS) / GAME_TPS, 'with the boots')
  const bare = walkingSpeed(WRITTEN) / GAME_TPS
  closeTo(step(simulator, 20) - bare, walkingSpeed(0, BOOTS) / GAME_TPS, 'and the difference is what the boots really add')
})

test('the stats the page shows are what the champion walks at, with and without items', () => {
  assert.equal(walker.statsAt(1).moveSpeed, walkingSpeed(WRITTEN))
  assert.equal(walker.statsAt(7).moveSpeed, walkingSpeed(WRITTEN), 'at every level')
  assert.equal(withItems(walker.statsAt(1), undefined).moveSpeed, walker.statsAt(1).moveSpeed, 'items that add nothing add nothing')
  assert.equal(withItems(walker.statsAt(1), { boots: boots.id }).moveSpeed, walkingSpeed(WRITTEN) + walkingSpeed(0, BOOTS))

  const state = economyClient()
  state.simulator.addPlayer(1, 'p1', 'One', START, walker, 1)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  const bought = state.createBuyOrder(boots.id, 0)
  assert.ok(bought.ok)
  state.simulator.advanceTo(state.simulator.tick + 30)
  const shown = state.getLocalStats(0)?.moveSpeed
  assert.ok(shown !== undefined)
  closeTo(shown, walkingSpeed(WRITTEN, BOOTS), 'the HUD')
  // And it is the speed the simulator really walks at: what the stats panel says is how far a second takes it.
  state.simulator.addOrder(1, move(state.simulator.tick + 1, FAR))
  const from = state.simulator.tick + 10
  closeTo(step(state.simulator, from), shown / GAME_TPS, 'the panel and the walk agree')
})

test('an item\'s tooltip says what it really adds to the speed, in whole points, which is what the stats panel gains', () => {
  const lines = itemStatLines(boots)
  assert.deepEqual(lines.map((line) => line.label), ['Move speed'])
  const gained = Math.round(walkingSpeed(0, BOOTS))
  assert.equal(lines[0].value, `+${gained}`)
  assert.ok(Math.abs(gained - (withItems(walker.statsAt(1), { boots: boots.id }).moveSpeed - walker.statsAt(1).moveSpeed)) <= 0.5, 'within the rounding of the stats panel')
})
