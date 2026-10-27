import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  DEFAULT_MONSTER_REWARD,
  GAME_MAX_LEVEL,
  GAME_STARTING_GOLD,
  GAME_XP_FIRST_LEVEL,
  GAME_XP_STEP,
  GameSnapshotSchema,
  getMonster,
  levelForXp,
  monsterLevelAfterKill,
  monsterXpAt,
  Monster,
  monsters,
  PLAYER_KILL_REWARD,
  Simulator,
  xpProgress,
  xpToNextLevel,
  xpToReachLevel,
  type MonsterDef,
} from '../packages/shared/src/index.ts'
import { brawler, defineChampion, defineMonster, economyClient, economySimulator } from './fixtures.ts'

// What a kill pays: gold, experience, and shards, to the player who makes it, flat. The level is what the experience makes, and
// is only shown. Everything here uses its own content, so retuning the game's numbers does not change what these expect, except
// where a test is about what the game ships with.

const slayer = defineChampion({
  id: 't-prog-slayer',
  name: 'Slayer',
  base: { maxHp: 1000, attackDamage: 5000, attackSpeed: 1 },
  moveSpeed: 220,
  radius: 18,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: [...brawler.abilities],
})
const fragile = defineChampion({
  id: 't-prog-fragile',
  name: 'Fragile',
  base: { maxHp: 50, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 18,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: [...brawler.abilities],
})
// Dies to one blow, and pays what it is told to.
const bounty = defineMonster({
  id: 't-prog-bounty',
  name: 'Bounty',
  base: { maxHp: 100, attackDamage: 5, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300 },
  reward: { gold: 7, xp: 11, shards: 2 },
})
// The same, and says nothing about what it pays.
const unpriced = defineMonster({
  id: 't-prog-unpriced',
  name: 'Unpriced',
  base: { maxHp: 100, attackDamage: 5, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300 },
})
// Worth the experience of two levels (the first two take it all), and nothing else.
const big = defineMonster({
  id: 't-prog-big',
  name: 'Big',
  base: { maxHp: 100, attackDamage: 5, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300 },
  reward: { gold: 0, xp: xpToReachLevel(3), shards: 0 },
})
// Hits hard enough to kill the fragile one, and comes for whoever is near.
const grunt = defineMonster({
  id: 't-prog-grunt',
  name: 'Grunt',
  base: { maxHp: 600, attackDamage: 40, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 300 },
  reward: { gold: 99, xp: 99, shards: 9 },
})

const HOME = { x: 600, y: 700 }
const at = (dx: number, dy = 0) => ({ x: HOME.x + dx, y: HOME.y + dy })
// What a character has earned: the shards are its own, and the gold (less what a player starts with) and the experience are in its frame (on the
// latest tick, unless it is told another).
const held = (simulator: Simulator, id: number, tick = simulator.tick) => {
  const character = simulator.characters.get(id)
  const state = simulator.at(tick).get(id)
  return { gold: (state?.getGold() ?? 0) - (character?.player ? GAME_STARTING_GOLD : 0), xp: state?.getXp(), shards: character?.shards }
}
// Plays on a tick at a time, the way the server does, with the commit tick twelve behind.
function play(simulator: Simulator, last: number): void {
  for (let tick = simulator.tick + 1; tick <= last; tick += 1) {
    simulator.advanceTo(tick)
    if (tick > 12) simulator.setCommitTick(tick - 12)
  }
}
const attack = (simulator: Simulator, tick: number, seq: number, targetId: number) =>
  simulator.addOrder(1, { id: `a${seq}`, seq, tick, type: 'attack', targetId })

// ---------------------------------------------------------------------------- the level

test('each level takes a fixed amount more experience than the one before, in a straight line', () => {
  assert.deepEqual([GAME_XP_FIRST_LEVEL, GAME_XP_STEP], [100, 50])
  assert.deepEqual([1, 2, 3, 4, 5].map(xpToNextLevel), [100, 150, 200, 250, 300])
  for (let level = 1; level < 30; level += 1) assert.equal(xpToNextLevel(level + 1) - xpToNextLevel(level), GAME_XP_STEP, `level ${level} to the next`)
  assert.equal(xpToNextLevel(0), 100, 'nothing below the first level')
  // What it takes to get to a level is all the levels before it: 100, then 100 + 150, then 100 + 150 + 200.
  assert.deepEqual([1, 2, 3, 4, 5].map(xpToReachLevel), [0, 100, 250, 450, 700])
})

test('the level is 1 to start with, one more each time the experience covers what the level takes, and stops at the highest', () => {
  assert.equal(GAME_MAX_LEVEL > 1, true)
  assert.equal(levelForXp(0), 1)
  assert.equal(levelForXp(99), 1, 'a point short of the first')
  assert.equal(levelForXp(100), 2, 'and it is there')
  assert.equal(levelForXp(249), 2, 'the second level takes 150, so 100 and 149 is still level 2')
  assert.equal(levelForXp(250), 3)
  assert.equal(levelForXp(449), 3)
  assert.equal(levelForXp(450), 4)
  assert.equal(levelForXp(xpToReachLevel(GAME_MAX_LEVEL)), GAME_MAX_LEVEL, 'the highest, when it takes it')
  assert.equal(levelForXp(xpToReachLevel(GAME_MAX_LEVEL) - 1), GAME_MAX_LEVEL - 1, 'and not a point sooner')
  assert.equal(levelForXp(1e9), GAME_MAX_LEVEL, 'and no higher however much')
  for (const odd of [-5, Number.NaN]) assert.equal(levelForXp(odd), 1, `${odd} is nothing`)
  // Every level starts exactly at what the levels before it take.
  for (let level = 1; level <= GAME_MAX_LEVEL; level += 1) assert.equal(levelForXp(xpToReachLevel(level)), level)
})

test('how far it is to the next level is how much of this one is done, and the highest has no next', () => {
  assert.deepEqual(xpProgress(0), { level: 1, into: 0, needed: 100, fraction: 0, maxed: false })
  const half = xpProgress(100 + 75)
  assert.deepEqual([half.level, half.into, half.needed, half.fraction], [2, 75, 150, 0.5], 'half of the 150 that level 2 takes')
  assert.equal(xpProgress(249).fraction < 1, true, 'a point short is not full')
  assert.deepEqual(xpProgress(xpToReachLevel(GAME_MAX_LEVEL) + 500), { level: GAME_MAX_LEVEL, into: 0, needed: 0, fraction: 1, maxed: true })
  assert.deepEqual(xpProgress(-3), xpProgress(0))
})

// ---------------------------------------------------------------------------- what a monster is worth

test('what a monster pays is set on it, whatever it leaves out is the default, and a monster that says nothing pays that', () => {
  assert.deepEqual({ ...bounty.reward }, { gold: 7, xp: 11, shards: 2 })
  assert.deepEqual({ ...unpriced.reward }, { ...DEFAULT_MONSTER_REWARD }, 'nothing said')
  const part = new Monster({ ...bounty.champion, id: 't-prog-part', name: 'Part', ai: { aggroRange: 0, deaggroRange: 300 }, reward: { gold: 3 } })
  assert.deepEqual({ ...part.reward }, { gold: 3, xp: DEFAULT_MONSTER_REWARD.xp, shards: DEFAULT_MONSTER_REWARD.shards }, 'only the gold was said')
  const free = new Monster({ ...bounty.champion, id: 't-prog-free', name: 'Free', ai: { aggroRange: 0, deaggroRange: 300 }, reward: { gold: 0, xp: 0 } })
  assert.deepEqual([free.reward.gold, free.reward.xp], [0, 0], 'a reward of nothing is a choice, and not the default')
})

test('what a monster pays has to be whole and not negative', () => {
  const def = (reward: MonsterDef['reward']): MonsterDef => ({
    ...bounty.champion,
    id: 't-prog-bad',
    name: 'Bad',
    ai: { aggroRange: 0, deaggroRange: 300 },
    reward,
  })
  for (const bad of [{ gold: -1 }, { xp: 1.5 }, { shards: -2 }, { gold: Number.NaN }, { xp: Number.POSITIVE_INFINITY }]) {
    assert.throws(() => new Monster(def(bad)), /Monster "t-prog-bad" needs a reward of/, JSON.stringify(bad))
  }
  assert.doesNotThrow(() => new Monster(def({ gold: 0, xp: 0, shards: 0 })))
})

test('every monster in the game pays gold and experience, and the golem alone pays shards, and more than a slime', () => {
  for (const monster of monsters.values()) {
    if (monster.id.startsWith('t-')) continue
    assert.ok(monster.reward.gold > 0 && monster.reward.xp > 0, `${monster.name} pays gold and experience`)
  }
  const slime = getMonster('slime').reward
  const golem = getMonster('golem').reward
  assert.ok(golem.shards > 0, 'the golem pays shards')
  assert.equal(slime.shards + getMonster('wolf').reward.shards, 0, 'and nothing else does')
  assert.ok(golem.gold > slime.gold && golem.xp > slime.xp, 'and a good deal more of the rest')
})

// ---------------------------------------------------------------------------- paying

function huntBounty(): Simulator {
  const simulator = economySimulator()
  simulator.addMonster(10, bounty, HOME)
  simulator.addPlayer(1, 'p', 'P', at(140), slayer, 1)
  // The blow lands on tick 5, so there is a commit tick before it.
  attack(simulator, 5, 1, 10)
  return simulator
}

test('killing a monster pays the player what it is worth: the experience and the gold at once, in the frame, and the shards once the kill can no longer be undone', () => {
  const simulator = huntBounty()
  simulator.advanceTo(40)
  simulator.setCommitTick(1)
  assert.equal(simulator.at(40).get(10)?.isDead(), true, 'it is dead as far as anyone can tell')
  assert.deepEqual(held(simulator, 1), { gold: 7, xp: 11, shards: 0 }, 'the experience and the gold are in the frame, as predicted as the kill is; a late order could still save them, so the shards wait')
  simulator.setCommitTick(40)
  assert.deepEqual(held(simulator, 1), { gold: 7, xp: 11, shards: 2 })
  assert.equal(simulator.characters.get(1)?.kills, 0, 'a monster is not a player\'s kill')
  simulator.advanceTo(60)
  simulator.setCommitTick(60)
  assert.deepEqual(held(simulator, 1), { gold: 7, xp: 11, shards: 2 }, 'paid once, however far the commit tick goes on')
})

test('a monster that says nothing pays the flat default', () => {
  const simulator = economySimulator()
  simulator.addMonster(10, unpriced, HOME)
  simulator.addPlayer(1, 'p', 'P', at(140), slayer, 1)
  attack(simulator, 1, 1, 10)
  play(simulator, 60)
  assert.deepEqual(held(simulator, 1), { ...DEFAULT_MONSTER_REWARD })
})

test('killing a player pays a flat amount, and counts as a kill, and killing them again pays the same', () => {
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p', 'P', at(0), slayer, 1)
  simulator.addPlayer(2, 'q', 'Q', at(60), fragile, 2)
  attack(simulator, 1, 1, 2)
  play(simulator, 60)
  assert.deepEqual(held(simulator, 1), { ...PLAYER_KILL_REWARD })
  assert.equal(simulator.characters.get(1)?.kills, 1)
  assert.deepEqual(held(simulator, 2), { gold: 0, xp: 0, shards: 0 }, 'the one killed is paid nothing')
  // They come back, and are killed again: the same again, whatever level or kills either has.
  attack(simulator, 220, 2, 2)
  play(simulator, 300)
  assert.equal(simulator.characters.get(1)?.kills, 2)
  assert.deepEqual(held(simulator, 1), {
    gold: PLAYER_KILL_REWARD.gold * 2,
    xp: PLAYER_KILL_REWARD.xp * 2,
    shards: PLAYER_KILL_REWARD.shards * 2,
  })
})

test('every kill pays, so two monsters pay twice, and a player and a monster pay each their own', () => {
  const simulator = economySimulator()
  simulator.addMonster(10, bounty, HOME)
  simulator.addMonster(11, bounty, at(0, 200))
  simulator.addPlayer(1, 'p', 'P', at(140), slayer, 1)
  attack(simulator, 1, 1, 10)
  play(simulator, 40)
  attack(simulator, 41, 2, 11)
  play(simulator, 120)
  assert.deepEqual(held(simulator, 1), { gold: 14, xp: 22, shards: 4 })
})

test('a monster that kills a player is paid nothing, and neither is the player it killed', () => {
  const simulator = economySimulator()
  simulator.addMonster(10, grunt, HOME)
  simulator.addPlayer(1, 'p', 'P', at(200), fragile, 1)
  play(simulator, 200)
  assert.equal(simulator.at(200).get(1)?.isDead(), true, 'the grunt killed them')
  assert.deepEqual(held(simulator, 10), { gold: 0, xp: 0, shards: 0 })
  assert.deepEqual(held(simulator, 1), { gold: 0, xp: 0, shards: 0 })
})

test('a death that a late order undoes pays nothing, experience and gold included', () => {
  const simulator = huntBounty()
  assert.equal(simulator.at(12).get(10)?.isDead(), true, 'it looks dead for now')
  assert.equal(simulator.at(12).get(1)?.getXp(), 11, 'and has paid the experience, as far as anyone can tell')
  assert.equal(simulator.at(12).get(1)?.getGold(), GAME_STARTING_GOLD + 7, 'and the gold')
  assert.equal(simulator.removeOrder(1, 1), true, 'the order that attacked it turns out never to have been given')
  simulator.advanceTo(40)
  simulator.setCommitTick(40)
  assert.equal(simulator.at(40).get(10)?.isDead(), false)
  assert.deepEqual(held(simulator, 1), { gold: 0, xp: 0, shards: 0 }, 'the frame is worked out again from the orders, so the experience and the gold are gone with the kill')
})

test('what a player has collected is kept when they die', () => {
  const simulator = economySimulator()
  simulator.addMonster(10, bounty, at(0, -300))
  simulator.addPlayer(1, 'p', 'P', at(0, -160), slayer, 1)
  simulator.addPlayer(2, 'q', 'Q', at(0, 200), slayer, 2)
  attack(simulator, 1, 1, 10)
  play(simulator, 100)
  const before = held(simulator, 1)
  assert.deepEqual(before, { gold: 7, xp: 11, shards: 2 }, 'the first player killed the monster')
  // The other player kills them, and they are back before the end.
  simulator.addOrder(2, { id: 'b1', seq: 1, tick: 101, type: 'attack', targetId: 1 })
  play(simulator, 400)
  assert.equal(simulator.characters.get(2)?.kills, 1, 'they were killed')
  assert.equal(simulator.at(400).get(1)?.isDead(), false, 'and have come back')
  assert.deepEqual(held(simulator, 1), before, 'and what they had is as it was')
})

// ---------------------------------------------------------------------------- carried

test('the shards travel in a snapshot and the experience and gold in its frame, and none is paid again by a simulator that restores one', () => {
  const server = huntBounty()
  play(server, 60)
  const snapshot = JSON.parse(JSON.stringify(server.snapshot()))
  assert.deepEqual(snapshot.characters.map((character: { id: number; shards: number }) => [character.id, character.shards]), [[10, 0], [1, 2]])
  assert.equal(snapshot.characters.some((character: object) => 'xp' in character || 'gold' in character), false, 'the experience and the gold are not a character\'s tally')
  const frame = snapshot.checkpoint.characters.find((each: { characterId: number }) => each.characterId === 1)
  assert.deepEqual([frame.xp, frame.gold], [11, GAME_STARTING_GOLD + 7], 'they are in the frame')
  assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)
  const parsed = GameSnapshotSchema.parse(snapshot)

  // A client that has predicted the death but has not heard the commit tick reach it yet: it has the experience and the gold, which are in its
  // frames, and not the shards.
  const client = huntBounty()
  client.advanceTo(60)
  assert.deepEqual(held(client, 1), { gold: 7, xp: 11, shards: 0 })
  client.replaceFromSnapshot(parsed)
  assert.deepEqual(held(client, 1), { gold: 7, xp: 11, shards: 2 }, 'the snapshot has them')
  client.advanceTo(90)
  client.setCommitTick(90)
  assert.deepEqual(held(client, 1), { gold: 7, xp: 11, shards: 2 }, 'and they are not paid twice')
})

test('a snapshot from before there were any tallies has none, and is still one', () => {
  const server = huntBounty()
  play(server, 60)
  const old = JSON.parse(JSON.stringify(server.snapshot()))
  for (const character of old.characters) delete character.shards
  for (const frame of old.checkpoint.characters) {
    delete frame.xp
    delete frame.gold
  }
  const parsed = GameSnapshotSchema.parse(old)
  assert.deepEqual(parsed.characters.map(({ shards }) => shards), [0, 0])
  const client = economySimulator()
  client.replaceFromSnapshot(parsed)
  assert.equal(client.at(client.tick).get(1)?.getXp(), 0, 'a frame with none has none')
  assert.equal(client.at(client.tick).get(1)?.getGold(), 0, 'and no gold')
  assert.equal(client.at(client.tick).get(1)?.getLevel(), 1)
})

// ---------------------------------------------------------------------------- what the page shows

test('the page shows the level, and how far it is to the next, and the gold and shards, of the champion it controls', () => {
  const state = economyClient()
  assert.equal(state.getLocalProgress(0), undefined, 'nothing before there is a champion')
  state.simulator.addMonster(10, bounty, HOME)
  state.simulator.addMonster(11, big, at(0, 280))
  state.simulator.addPlayer(1, 'p', 'P', at(140), slayer, 1)
  state.setLocalCharacterId(1)
  assert.deepEqual(state.getLocalProgress(0), { level: 1, into: 0, needed: 100, fraction: 0, maxed: false, gold: GAME_STARTING_GOLD, shards: 0 })
  state.simulator.addOrder(1, { id: 'k', seq: 1, tick: 1, type: 'attack', targetId: 10 })
  state.simulator.advanceTo(60)
  state.simulator.setCommitTick(60)
  assert.deepEqual(state.getLocalProgress(0), { level: 1, into: 11, needed: 100, fraction: 11 / 100, maxed: false, gold: GAME_STARTING_GOLD + 7, shards: 2 })
  // Enough for two levels more: the level is from the experience in the frame.
  state.simulator.addOrder(1, { id: 'k2', seq: 2, tick: 70, type: 'attack', targetId: 11 })
  state.simulator.advanceTo(200)
  state.simulator.setCommitTick(200)
  const progress = state.getLocalProgress(0)
  assert.deepEqual([progress?.level, progress?.into], [3, 11], '11 and 250 is 261: two levels, and 11 into the third')
  assert.equal(state.simulator.at(200).get(1)?.getLevel(), 3)
})
