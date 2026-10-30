import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  GAME_MODES,
  GAME_STARTING_GOLD,
  GameSnapshotSchema,
  levelForXp,
  modeHasEconomy,
  PLAYER_KILL_REWARD,
  Simulator,
  type ModeSetup,
} from '../packages/shared/src/index.ts'
import { brawler, defineChampion, defineItem, defineMonster, ECONOMY_MODE, economyClient, killAt } from './fixtures.ts'

// Only core destruction has an economy (`modeHasEconomy`): in team deathmatch, king of the hill and capture the flag a kill is a kill on the scoreboard and
// pays nothing, there is no level to gain, and nothing to buy.

const HILL = { x: 1000, y: 600, width: 200, height: 200, ellipse: false }
const NO_ECONOMY: Array<[string, ModeSetup]> = [
  ['team deathmatch', { kind: 'deathmatch' }],
  ['king of the hill', { kind: 'koth', hill: HILL }],
  ['capture the flag', { kind: 'ctf', flags: [{ team: 1, home: { x: 200, y: 200 } }, { team: 2, home: { x: 2000, y: 1200 } }] }],
]

const boots = defineItem({ id: 't-ne-boots', name: 'Boots', slot: 'boots', cost: 100, stats: { moveSpeed: 50 } })
const bounty = defineMonster({
  id: 't-ne-bounty',
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
  id: 't-ne-champion',
  name: 'Fighter',
  base: { maxHp: 1000, attackDamage: 50, attackSpeed: 1 },
  growth: { maxHp: 100, attackDamage: 10, arcane: 5 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 100,
  attackWindup: 0,
  abilities: [],
})

// A victim (1) at the origin of the test, and a monster (2); the executioner (1001 and 1002) kills them in turn.
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
  return { xp: state?.getXp(), gold: state?.getGold(), level: state?.getLevel(), shards: simulator.characters.get(id)?.shards }
}

test('only core destruction has an economy', () => {
  assert.deepEqual(GAME_MODES.map((mode) => [mode.id, mode.economy]), [
    ['deathmatch', false], ['koth', false], ['ctf', false], ['core', true],
  ])
  assert.equal(modeHasEconomy('core'), true)
  for (const id of ['deathmatch', 'koth', 'ctf'] as const) assert.equal(modeHasEconomy(id), false, id)
  assert.equal(new Simulator().hasEconomy, false, 'and the game that has no mode said is one of them')
  assert.equal(new Simulator(undefined, ECONOMY_MODE).hasEconomy, true)
})

for (const [name, setup] of NO_ECONOMY) {
  test(`in ${name} a kill is a kill on the scoreboard and nothing else: no experience, no gold, no shards`, () => {
    const simulator = game(setup)
    slay(simulator)
    const killer = simulator.characters.get(1001)
    assert.equal(killer?.kills, 1, 'the player is a kill')
    assert.deepEqual(held(simulator, 1001), { xp: 0, gold: 0, level: 1, shards: 0 })
    assert.equal(simulator.characters.get(1002)?.kills, 0, 'and the monster is no kill, and pays nothing either')
    assert.deepEqual(held(simulator, 1002), { xp: 0, gold: 0, level: 1, shards: 0 })
  })

  test(`in ${name} nobody has gold, and every champion is level 1 whatever the frame says`, () => {
    const simulator = game(setup)
    simulator.advanceTo(5)
    const state = simulator.at(5).get(1)
    assert.deepEqual([state?.getGold(), state?.getXp(), state?.getLevel(), state?.getHealthState()?.maxHp], [0, 0, 1, champion.maxHp])
    assert.equal('gold' in (simulator.at(5).toData().characters.find((each) => each.characterId === 1) ?? {}), false, 'the frame has no gold in it')
  })

  test(`in ${name} an order to buy is nothing, and so is one to sell`, () => {
    const simulator = game(setup)
    simulator.addOrder(1, { id: 'b', seq: 1, tick: 2, type: 'buy', itemId: boots.id })
    simulator.addOrder(1, { id: 's', seq: 2, tick: 4, type: 'sell', slot: 'boots' })
    simulator.advanceTo(8)
    assert.deepEqual([simulator.at(8).get(1)?.getItems(), simulator.at(8).get(1)?.getGold()], [{}, 0])
    assert.equal(simulator.canShop(1, simulator.at(8)), false)
  })

  test(`in ${name} the page has no shop: nothing is bought or sold, and it says so`, () => {
    const state = new ClientGameState()
    state.simulator.reset(undefined, setup)
    state.simulator.addPlayer(1, 'p1', 'One', { x: 600, y: 700 }, champion, 1)
    state.setLocalCharacterId(1)
    state.simulator.advanceTo(3)
    assert.equal(state.hasEconomy, false)
    assert.deepEqual(state.createBuyOrder(boots.id, 0), { ok: false, reason: 'This mode has no shop.' })
    assert.deepEqual(state.createSellOrder('boots', 0), { ok: false, reason: 'This mode has no shop.' })
  })
}

test('a client that restores a snapshot of a game with no economy has none, and of one with an economy has one', () => {
  for (const [setup, economy] of [[{ kind: 'deathmatch' }, false], [{ kind: 'koth', hill: HILL }, false], [ECONOMY_MODE, true]] as Array<[ModeSetup, boolean]>) {
    const server = game(setup)
    server.advanceTo(10)
    server.setCommitTick(5)
    const client = new Simulator()
    client.replaceFromSnapshot(GameSnapshotSchema.parse(JSON.parse(JSON.stringify(server.snapshot()))))
    assert.equal(client.hasEconomy, economy, setup.kind)
  }
})

test('core destruction pays as before, so the same kills there do give experience, gold and shards', () => {
  const simulator = game(ECONOMY_MODE)
  slay(simulator)
  assert.equal(simulator.characters.get(1001)?.kills, 1)
  // What a kill of a player pays (`PLAYER_KILL_REWARD`) to the one who killed the player, and what the monster's entry says (the test's own, above) to the one
  // who killed it, each on top of the gold a player starts with, and each at the level its experience makes.
  const paid = (reward: Readonly<{ gold: number; xp: number; shards: number }>) =>
    ({ xp: reward.xp, gold: GAME_STARTING_GOLD + reward.gold, level: levelForXp(reward.xp), shards: reward.shards })
  assert.deepEqual(held(simulator, 1001), paid(PLAYER_KILL_REWARD))
  assert.deepEqual(held(simulator, 1002), paid(bounty.reward))
  assert.ok(held(simulator, 1002).level > 1, 'and the monster paid enough experience for a level or more, so the level comes from the experience')
  assert.equal(held(simulator, 1)?.level, 1, 'the one who was killed was not paid')
  assert.equal(economyClient().hasEconomy, true)
})

test('a brawler in a game with no economy still plays: it fights, and a kill counts', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', { x: 600, y: 700 }, brawler, 1)
  killAt(simulator, 1, 3)
  simulator.advanceTo(30)
  simulator.setCommitTick(30)
  assert.equal(simulator.at(30).get(1)?.isDead(), true)
  assert.equal(simulator.characters.get(1001)?.kills, 1)
})
