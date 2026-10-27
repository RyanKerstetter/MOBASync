import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_MONSTER_XP_GROWTH,
  GAME_STARTING_GOLD,
  GameSnapshotSchema,
  getMonster,
  monsterLevelAfterKill,
  monsterXpAt,
  Simulator,
  type ModeSetup,
} from '../packages/shared/src/index.ts'
import { brawler, defineMonster, economySimulator, killAt } from './fixtures.ts'

// A monster gains a level each time it is killed: it comes back (it has to have a respawn time) a level higher, with the stats its growth gives, and pays
// more experience and the same gold. The level is in its frame, so it is rolled back and restored with the rest. Only in a game with an economy.

const RESPAWN = 20
const wolf = defineMonster({
  id: 't-ml-wolf',
  name: 'Wolf',
  base: { maxHp: 1000, attackDamage: 30, attackSpeed: 1 },
  growth: { maxHp: 100, attackDamage: 5 },
  moveSpeed: 0,
  radius: 20,
  attackRange: 10,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300, respawnTicks: RESPAWN },
  reward: { gold: 40, xp: 70, shards: 3 },
  xpGrowth: 30,
})
const HOME = { x: 600, y: 700 }
const ID = 7

// A wolf (7), killed at ticks 5, 60 and 120 by its executioner (1007, which `killAt` makes for it).
function hunt(simulator: Simulator = economySimulator()): Simulator {
  simulator.addMonster(ID, wolf, HOME)
  for (const tick of [5, 60, 120]) killAt(simulator, ID, tick)
  return simulator
}

// What the wolf and its executioner had at each tick, from the first to `last`, worked out a tick at a time (the frames are only kept for a few ticks).
type Seen = { level?: number; maxHp?: number; hp?: number; dead?: boolean; xp?: number; gold?: number }
function watch(simulator: Simulator, last: number): Map<number, Seen> {
  const seen = new Map<number, Seen>()
  for (let tick = 1; tick <= last; tick += 1) {
    simulator.advanceTo(tick)
    const wolfState = simulator.at(tick).get(ID)
    const killer = simulator.at(tick).get(1000 + ID)
    seen.set(tick, {
      level: wolfState?.getLevel(),
      maxHp: wolfState?.getHealthState()?.maxHp,
      hp: wolfState?.getHealth(),
      dead: wolfState?.isDead(),
      xp: killer?.getXp(),
      gold: killer?.getGold(),
    })
  }
  return seen
}

// ---------------------------------------------------------------------------- the functions that scale it

test('a kill is one level, and a monster pays its experience at level 1 plus its growth for each level after, in a straight line', () => {
  assert.deepEqual([1, 2, 3, 10].map(monsterLevelAfterKill), [2, 3, 4, 11])
  assert.deepEqual([1, 2, 3, 4, 11].map((level) => monsterXpAt(70, 30, level)), [70, 100, 130, 160, 370])
  assert.equal(monsterXpAt(70, 0, 9), 70, 'a growth of nothing is flat')
  assert.equal(monsterXpAt(70, 30, 0), 70, 'and there is no level under the first')
})

test('what a monster in the game pays more for each level is its own, with a default for one that says nothing', () => {
  assert.equal(getMonster('slime').xpGrowth > 0, true)
  assert.equal(getMonster('golem').xpGrowth > getMonster('slime').xpGrowth, true)
  assert.equal(getMonster('wolf').xpGrowth, DEFAULT_MONSTER_XP_GROWTH, 'the wolf says none, so it has the default')
  for (const id of ['slime', 'golem', 'wolf']) {
    const { champion } = getMonster(id)
    assert.ok(champion.growth.maxHp > 0 && champion.growth.attackDamage > 0, `${id} grows in health and damage`)
    assert.ok(champion.statsAt(3).maxHp > champion.statsAt(2).maxHp && champion.statsAt(2).maxHp > champion.statsAt(1).maxHp, `${id} is stronger a level at a time`)
  }
  assert.throws(() => defineMonster({ ...wolfDef('t-ml-bad-1'), xpGrowth: -1 }), /experience growth that is a whole number/)
  assert.throws(() => defineMonster({ ...wolfDef('t-ml-bad-2'), xpGrowth: 1.5 }), /experience growth that is a whole number/)
})

function wolfDef(id: string) {
  return {
    id, name: 'Bad', base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 }, moveSpeed: 0, radius: 20, attackRange: 10, attackWindupTicks: 0,
    abilities: [], ai: { aggroRange: 0, deaggroRange: 300 },
  }
}

// ---------------------------------------------------------------------------- in a game

test('a monster starts at level 1, and comes back from each kill one level higher, with the health that level gives', () => {
  const seen = watch(hunt(), 200)
  assert.deepEqual([seen.get(4)?.level, seen.get(4)?.maxHp], [1, 1000], 'before it is killed')
  assert.equal(seen.get(8)?.dead, true)
  assert.equal(seen.get(8)?.level, 1, 'it is still level 1 while it lies dead')
  const back = seen.get(5 + RESPAWN + 2)
  assert.deepEqual([back?.dead, back?.level, back?.maxHp, back?.hp], [false, 2, 1100, 1100])
  assert.deepEqual([seen.get(50)?.level, seen.get(50)?.maxHp], [2, 1100], 'and it stays that until it is killed again')
  assert.deepEqual([seen.get(100)?.level, seen.get(100)?.maxHp], [3, 1200], 'level 3 after the second')
  assert.deepEqual([seen.get(190)?.level, seen.get(190)?.maxHp], [4, 1300], 'and 4 after the third')
})

test('it pays more experience each time, a straight line up, and the same gold', () => {
  const seen = watch(hunt(), 200)
  // The wolf pays 70 at level 1, 100 at level 2 and 130 at level 3, to the executioner that kills it each time, so 70, 170 and 300 in all.
  assert.deepEqual([4, 58, 118, 190].map((tick) => seen.get(tick)?.xp), [0, 70, 170, 300])
  const gold = [4, 58, 118, 190].map((tick) => seen.get(tick)?.gold ?? 0)
  assert.deepEqual(gold.map((each, index) => each - (gold[index - 1] ?? GAME_STARTING_GOLD)), [0, 40, 40, 40], 'the same 40 gold every time')
})

test('the shards are the same each time as well', () => {
  const simulator = hunt()
  simulator.advanceTo(200)
  simulator.setCommitTick(200)
  assert.equal(simulator.characters.get(1000 + ID)?.shards, 9, 'three kills of 3')
})

test('a monster with no respawn does not come back, so it does not level', () => {
  const once = defineMonster({ ...wolfDef('t-ml-once'), growth: { maxHp: 100 } })
  const simulator = economySimulator()
  simulator.addMonster(ID, once, HOME)
  killAt(simulator, ID, 5)
  const seen = watch(simulator, 100)
  assert.deepEqual([seen.get(100)?.dead, seen.get(100)?.level], [true, 1])
})

test('a game with no economy has no levels, for a monster either: it comes back as it was and pays nothing', () => {
  for (const setup of [{ kind: 'deathmatch' }, { kind: 'koth', hill: { x: 1000, y: 600, width: 200, height: 200, ellipse: false } }] as ModeSetup[]) {
    const seen = watch(hunt(new Simulator(undefined, setup)), 200)
    assert.deepEqual([seen.get(100)?.level, seen.get(100)?.maxHp, seen.get(190)?.xp], [1, 1000, 0], setup.kind)
    assert.equal(seen.get(100)?.dead, false, 'it did come back')
  }
})

// ---------------------------------------------------------------------------- the frame

test('the level is rolled back with the frame: a late order makes the frames after it be worked out again, with the level, and they come out the same', () => {
  // The order, which is only a move of someone else, comes late to one game (after the wolf has come back) and on time to the other.
  const move = { id: 'late', seq: 1, tick: 22, type: 'move' as const, target: { x: 500, y: 300 } }
  const game = (): Simulator => {
    const simulator = hunt()
    simulator.addPlayer(3, 'p3', 'Three', { x: 300, y: 300 }, brawler, 3)
    return simulator
  }
  const late = game()
  late.advanceTo(30)
  assert.equal(late.at(30).get(ID)?.getLevel(), 2, 'it has come back a level higher by then')
  assert.equal(late.addOrder(3, move), true)
  const onTime = game()
  onTime.addOrder(3, move)
  for (let tick = 30; tick <= 200; tick += 1) {
    late.advanceTo(tick)
    onTime.advanceTo(tick)
    assert.deepEqual(late.at(tick).toData(), onTime.at(tick).toData(), `tick ${tick}`)
  }
  assert.equal(late.at(200).get(ID)?.getLevel(), 4, 'and it was levelled once for each kill (the third was at 120)')
  assert.notDeepEqual(late.at(200).get(3)?.getPosition(), { x: 300, y: 300 }, 'the order was done')
  assert.equal(late.at(200).get(1000 + ID)?.getXp(), 300, 'and paid once')
})

test('the level travels in a snapshot, and a simulator that restores one has it, and plays on to the same frames', () => {
  const server = hunt()
  server.advanceTo(80)
  server.setCommitTick(70)
  const snapshot = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(server.snapshot())))
  const client = new Simulator()
  client.replaceFromSnapshot(snapshot)
  assert.equal(client.hasEconomy, true)
  assert.equal(client.at(70).get(ID)?.getLevel(), 2)
  for (let tick = 81; tick <= 200; tick += 1) {
    server.advanceTo(tick)
    client.advanceTo(tick)
  }
  assert.deepEqual(client.at(200).toData(), server.at(200).toData(), 'the same frame as the one that was never sent')
  assert.equal(client.at(200).get(ID)?.getLevel(), 4)
})
