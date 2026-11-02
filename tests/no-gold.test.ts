import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  applyRulesChange,
  createModeSetup,
  defaultRules,
  GAME_STARTING_GOLD,
  GameSnapshotSchema,
  levelForXp,
  modeRules,
  PLAYER_KILL_REWARD,
  readRulesChange,
  Simulator,
  Terrain,
  type ModeSetup,
} from '../packages/shared/src/index.ts'
import { brawler, defineChampion, defineItem, defineMonster, ECONOMY_MODE, killAt } from './fixtures.ts'

// A game of core destruction can be played with no gold (`LobbyRules.gold`): the levels and the experience are as they were, and a kill pays that and nothing else, nobody starts with
// any, and there is no shop to spend it in. Nothing here is tuned: what a kill pays comes from the rewards the test gives its own monster, and from `PLAYER_KILL_REWARD`.

const CORES = { flags: [], cores: [{ x: 100, y: 100 }, { x: 900, y: 100 }] }
const NO_GOLD_MODE: ModeSetup = { kind: 'core', teams: [1, 2], noGold: true }

const cheap = defineItem({ id: 't-ng-cheap', name: 'Cheap Boots', slot: 'boots', cost: 1, stats: { moveSpeed: 50 } })
const bounty = defineMonster({
  id: 't-ng-bounty',
  name: 'Bounty',
  base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 0,
  radius: 20,
  attackRange: 10,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300 },
  reward: { gold: 700, xp: 700, shards: 5 },
})
const champion = defineChampion({
  id: 't-ng-champion',
  name: 'Fighter',
  base: { maxHp: 1000, attackDamage: 50, attackSpeed: 1 },
  growth: { maxHp: 100, attackDamage: 10, arcane: 5 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 100,
  attackWindup: 0,
  abilities: [],
})

// A victim (1), and a monster (2); the executioner (1001 and 1002) kills them in turn.
function game(setup: ModeSetup): Simulator {
  const simulator = new Simulator(undefined, setup)
  simulator.addPlayer(1, 'p1', 'One', { x: 600, y: 700 }, champion, 1)
  simulator.addMonster(2, bounty, { x: 700, y: 700 })
  return simulator
}

function slay(simulator: Simulator): void {
  killAt(simulator, 1, 3)
  killAt(simulator, 2, 10)
  simulator.advanceTo(60)
  simulator.setCommitTick(60)
}

const held = (simulator: Simulator, id: number) => {
  const state = simulator.at(60).get(id)
  return { xp: state?.getXp(), gold: state?.getGold(), level: state?.getLevel() }
}

// ---------------------------------------------------------------------------- the rule

test('gold is on by default, and is a rule that is on or off', () => {
  assert.equal(defaultRules().gold, true)
  assert.deepEqual(readRulesChange({ gold: false }), { change: { gold: false } })
  assert.deepEqual(readRulesChange({ gold: true }), { change: { gold: true } }, 'on is a change like off')
  for (const bad of ['no', 0, 1, null]) {
    const read = readRulesChange({ gold: bad })
    assert.ok('problem' in read, `${String(bad)} was refused`)
    assert.match('problem' in read ? read.problem : '', /must be on or off/)
  }
  const off = applyRulesChange(defaultRules(), { gold: false })
  assert.equal(off.gold, false)
  assert.equal(applyRulesChange(off, { respawnSeconds: 9 }).gold, false, 'a change to something else leaves it as it was')
  assert.equal(applyRulesChange(off, { gold: true }).gold, true)
  assert.equal(defaultRules().gold, true, 'and the defaults are not changed by it')
})

test('a game of core destruction is told it has no gold when the rule is off, and no other game is, nor one with it on', () => {
  const off = applyRulesChange(defaultRules(), { gold: false })
  assert.equal(modeRules(off, 'core').noGold, true)
  for (const mode of ['deathmatch', 'koth', 'ctf'] as const) assert.equal('noGold' in modeRules(off, mode), false, `not for ${mode}`)
  assert.equal('noGold' in modeRules(defaultRules(), 'core'), false, 'on is not there, so what a game is by default is as it was')
  // Rules that were made without a word of gold, such as a lobby from before there was the rule, are a game with gold.
  const { gold: _gold, ...old } = defaultRules()
  assert.equal('noGold' in modeRules(old as ReturnType<typeof defaultRules>, 'core'), false)

  assert.equal((createModeSetup('core', [1, 2], CORES, modeRules(off, 'core')) as { noGold?: true }).noGold, true)
  assert.equal('noGold' in createModeSetup('core', [1, 2], CORES, modeRules(defaultRules(), 'core')), false)
})

test('the rule is in the snapshot of a game that has it, and a page that joins the game gets it with it', () => {
  const setup = createModeSetup('core', [1, 2], CORES, modeRules(applyRulesChange(defaultRules(), { gold: false }), 'core'))
  const server = new Simulator(Terrain.plain(), setup)
  assert.equal(server.hasGold, false)
  const read = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(server.snapshot())))
  const restored = new Simulator()
  restored.replaceFromSnapshot(read)
  assert.equal(restored.hasGold, false, 'the page has no gold either')
  assert.equal(restored.hasEconomy, true, 'and still has its levels')
  assert.equal(new Simulator(Terrain.plain(), createModeSetup('core', [1, 2], CORES)).hasGold, true, 'where a game with no word of it has gold')
})

// ---------------------------------------------------------------------------- playing without it

test('without gold a kill pays experience and nothing else, and the levels go on', () => {
  const simulator = game(NO_GOLD_MODE)
  slay(simulator)
  assert.equal(simulator.hasEconomy, true)
  assert.equal(simulator.hasGold, false)
  assert.deepEqual(held(simulator, 1001), { xp: PLAYER_KILL_REWARD.xp, gold: 0, level: levelForXp(PLAYER_KILL_REWARD.xp) }, 'a player pays experience')
  assert.deepEqual(held(simulator, 1002), { xp: bounty.reward.xp, gold: 0, level: levelForXp(bounty.reward.xp) }, 'a monster, whatever gold its entry says, does too')
  assert.ok(levelForXp(bounty.reward.xp) > 1, 'it is enough to level, and the stats at the level are the champion\'s')
  assert.ok((simulator.at(60).get(1002)?.getHealthState()?.maxHp ?? 0) > champion.maxHp, 'which is more health')
})

test('with gold the same kills pay as before: the control for the games without', () => {
  const simulator = game(ECONOMY_MODE)
  slay(simulator)
  assert.equal(simulator.hasGold, true)
  assert.deepEqual(held(simulator, 1001), { xp: PLAYER_KILL_REWARD.xp, gold: GAME_STARTING_GOLD + PLAYER_KILL_REWARD.gold, level: levelForXp(PLAYER_KILL_REWARD.xp) })
  assert.equal(held(simulator, 1002).gold, GAME_STARTING_GOLD + bounty.reward.gold)
})

test('without gold nobody starts with any, and the death that paid is told as experience only', () => {
  const simulator = game(NO_GOLD_MODE)
  simulator.advanceTo(5)
  assert.equal(simulator.at(5).get(1)?.getGold(), 0, 'not the gold a player starts with')
  assert.equal('gold' in (simulator.at(5).toData().characters.find((each) => each.characterId === 1) ?? {}), false, 'the frame has no gold in it')

  killAt(simulator, 2, 10)
  simulator.advanceTo(12)
  const paid = simulator.paidFor({ tick: 10, victimId: 2, killerId: 1002 }, simulator.at(10))
  assert.deepEqual(paid, { gold: 0, xp: bounty.reward.xp }, 'what the page shows over the body')
})

test('without gold an order to buy is nothing, and there is no shop, where in a game with gold the same one buys', () => {
  const buy = (setup: ModeSetup): Simulator => {
    const simulator = game(setup)
    simulator.addOrder(1, { id: 'b', seq: 1, tick: 2, type: 'buy', itemId: cheap.id })
    simulator.advanceTo(8)
    return simulator
  }
  const gold = buy(ECONOMY_MODE)
  assert.deepEqual(gold.at(8).get(1)?.getItems(), { boots: cheap.id }, 'with gold, a cheap item is bought')
  assert.equal(gold.canShop(1, gold.at(8)), true, 'and there is a shop (a game with none is a shop anywhere)')
  const without = buy(NO_GOLD_MODE)
  assert.deepEqual(without.at(8).get(1)?.getItems(), {}, 'without, it is not')
  assert.equal(without.canShop(1, without.at(8)), false, 'there is no shop')
})

// ---------------------------------------------------------------------------- the page

test('the page of a game without gold has its levels and no shop, and says so', () => {
  const state = new ClientGameState()
  state.simulator.reset(undefined, NO_GOLD_MODE)
  state.simulator.addPlayer(1, 'p1', 'One', { x: 600, y: 700 }, brawler, 1)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  assert.equal(state.hasEconomy, true, 'it has levels')
  assert.equal(state.hasGold, false, 'and no gold')
  assert.deepEqual(state.createBuyOrder(cheap.id, 0), { ok: false, reason: 'This game has no gold or shop.' })
  assert.deepEqual(state.createSellOrder('boots', 0), { ok: false, reason: 'This game has no gold or shop.' })
  assert.equal(state.getLocalProgress(0)?.gold, 0)
  assert.equal(state.getLocalProgress(0)?.level, 1)

  const control = new ClientGameState()
  control.simulator.reset(undefined, ECONOMY_MODE)
  assert.equal(control.hasGold, true)
})
