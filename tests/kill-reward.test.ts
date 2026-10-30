import assert from 'node:assert/strict'
import test from 'node:test'
import type { Container, Text } from 'pixi.js'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { KillRewardLayer } from '../apps/client/src/render/kill-reward-layer.ts'
import {
  KILL_REWARD_GOLD_COLOR,
  KILL_REWARD_HOLD,
  KILL_REWARD_LIFT,
  KILL_REWARD_MS,
  KILL_REWARD_POP_MS,
  KILL_REWARD_XP_COLOR,
  rewardLines,
  rewardPose,
  type KillRewardView,
} from '../apps/client/src/render/kill-reward.ts'
import {
  DEFAULT_CORE_REWARD,
  PLAYER_KILL_REWARD,
  Simulator,
  type DeathRecord,
  type GameTickSnapshot,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { brawler, defineChampion, defineMonster, defineTurret, economyClient, economySimulator } from './fixtures.ts'

// The effect over a body when a kill pays the champion you control: the gold and experience it gained, popping up and rising over where the
// victim fell. What it shows is what the kill really paid (`Simulator.paidFor`), and it is shown for your kills only, once. The monsters,
// turrets and rewards in these are the tests' own, with every number spelled out.

const grunt = defineMonster({
  id: 't-kr-grunt',
  name: 'Reward Grunt',
  base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300, respawnTicks: 3000 },
  reward: { gold: 33, xp: 44 },
})
const post = defineTurret(74, { base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 }, radius: 30, attackRange: 200, attackWindup: 0, reward: { gold: 70, xp: 30, shards: 2 } })
// One shot takes a player down, at any range it reaches.
const executioner = defineTurret(75, { base: { maxHp: 100, attackDamage: 5000, attackSpeed: 1 }, radius: 30, attackRange: 400, attackWindup: 0 })
// A core, which is a turret like the rest: one that reaches no one (a range of 1), so it is only something to break.
const keep = defineTurret(73, { base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 }, radius: 40, attackRange: 1, attackWindup: 0, core: true })
const slayer = defineChampion({ ...brawler, id: 't-kr-slayer', base: { ...brawler.base, attackDamage: 5000 }, abilities: [] })
const glass = defineChampion({ ...brawler, id: 't-kr-glass', base: { ...brawler.base, maxHp: 100 }, abilities: [] })

const VICTIM = 10
const AT = { x: 600, y: 600 }
const BESIDE = { x: 650, y: 600 }
const attack = (id: number, tick: number, targetId: number) => ({ id: `a${id}:${tick}`, seq: tick, tick, type: 'attack' as const, targetId })

// ---------------------------------------------------------------------------- the words

test('the words are gold over experience, each in its own colour, and only for what the kill paid', () => {
  assert.deepEqual(rewardLines({ gold: 25, xp: 60 }), [
    { text: '+25 gold', color: KILL_REWARD_GOLD_COLOR },
    { text: '+60 xp', color: KILL_REWARD_XP_COLOR },
  ])
  assert.deepEqual(rewardLines({ gold: 25, xp: 0 }), [{ text: '+25 gold', color: KILL_REWARD_GOLD_COLOR }])
  assert.deepEqual(rewardLines({ gold: 0, xp: 60 }), [{ text: '+60 xp', color: KILL_REWARD_XP_COLOR }])
  assert.deepEqual(rewardLines({ gold: 0, xp: 0 }), [], 'a kill that paid nothing says nothing')
  assert.notEqual(KILL_REWARD_GOLD_COLOR, KILL_REWARD_XP_COLOR, 'so the two read apart')
})

test('the words pop up a little big and settle, rise all the while, hold at full strength and then fade out until their time is up', () => {
  const start = rewardPose(0)
  assert.deepEqual([start.alpha, start.rise, start.done], [1, 0, false])
  assert.ok(start.scale > 1, 'a little big as they pop up')
  assert.equal(rewardPose(KILL_REWARD_POP_MS).scale, 1, 'and settled')
  assert.equal(rewardPose(KILL_REWARD_POP_MS * 10).scale, 1)
  const holdEnds = KILL_REWARD_MS * KILL_REWARD_HOLD
  assert.equal(rewardPose(holdEnds).alpha, 1, 'full strength for the first part')
  const fading = rewardPose((holdEnds + KILL_REWARD_MS) / 2)
  assert.ok(fading.alpha > 0 && fading.alpha < 1, `half way through the fade: ${fading.alpha}`)
  const end = rewardPose(KILL_REWARD_MS)
  assert.deepEqual([end.alpha, end.done], [0, true], 'gone when their time is up')
  assert.equal(rewardPose(KILL_REWARD_MS - 1).done, false)
  assert.ok(rewardPose(1000).rise > rewardPose(500).rise && rewardPose(500).rise > 0, 'they rise')
  assert.deepEqual(rewardPose(-100), { ...start }, 'a clock before the start is the start')
})

test('the layer puts the words over the body, rises and fades them, and takes them away when their time is up', () => {
  const layer = new KillRewardLayer()
  const reward: KillRewardView = { id: '5:10', position: { x: 300, y: 400 }, radius: 25, gold: 25, xp: 60 }
  layer.update([reward], 1000)
  assert.equal(layer.view.children.length, 1)
  const words = layer.view.children[0] as Container
  assert.deepEqual(words.children.map((line) => (line as Text).text), ['+25 gold', '+60 xp'], 'a line each, gold over experience')
  const startY = reward.position.y - reward.radius - KILL_REWARD_LIFT
  assert.deepEqual([words.x, words.y], [reward.position.x, startY], 'over the middle of the body, and over the top of it')

  layer.update([], 1000 + KILL_REWARD_MS * 0.7)
  assert.ok(words.y < startY, 'higher')
  assert.ok(words.alpha > 0 && words.alpha < 1, 'and fading')
  layer.update([], 1000 + KILL_REWARD_MS)
  assert.equal(layer.view.children.length, 0, 'and gone')
})

test('a kill that paid nothing, and a second kill beside the first, are shown as they should be', () => {
  const layer = new KillRewardLayer()
  layer.update([{ id: 'a', position: { x: 0, y: 0 }, radius: 10, gold: 0, xp: 0 }], 0)
  assert.equal(layer.view.children.length, 0, 'no words for nothing')
  layer.update([
    { id: 'b', position: { x: 0, y: 0 }, radius: 10, gold: 5, xp: 0 },
    { id: 'c', position: { x: 90, y: 0 }, radius: 10, gold: 0, xp: 7 },
  ], 0)
  assert.deepEqual(layer.view.children.map((words) => (words.children[0] as Text).text), ['+5 gold', '+7 xp'])
})

// ---------------------------------------------------------------------------- what a kill paid

// Ticks 1 to `last`, forward, looking for the death of `victimId`: the record, the frame it was on, and what the killer had a tick before.
function watchDeath(simulator: Simulator, killerId: number, victimId: number, last: number): {
  death: DeathRecord
  frame: GameTickSnapshot
  before: { gold: number; xp: number }
} | undefined {
  let before = { gold: simulator.at(0).get(killerId)?.getGold() ?? 0, xp: simulator.at(0).get(killerId)?.getXp() ?? 0 }
  for (let tick = 1; tick <= last; tick += 1) {
    const frame = simulator.at(tick)
    const death = frame.deaths.find((record) => record.victimId === victimId)
    if (death) return { death, frame, before }
    const killer = frame.get(killerId)
    before = { gold: killer?.getGold() ?? 0, xp: killer?.getXp() ?? 0 }
  }
  return undefined
}

test('a player is paid for what it kills, and what it is told it was paid is what its frame was paid', () => {
  const cases: Array<[string, (simulator: Simulator) => void, { gold: number; xp: number }]> = [
    ['a monster', (simulator) => simulator.addMonster(VICTIM, grunt, AT), { gold: 33, xp: 44 }],
    ['a player', (simulator) => simulator.addPlayer(VICTIM, 'p10', 'Victim', AT, glass, 2), { gold: PLAYER_KILL_REWARD.gold, xp: PLAYER_KILL_REWARD.xp }],
    ['a turret', (simulator) => simulator.addTurret(VICTIM, post, AT, 2), { gold: 70, xp: 30 }],
    ['a core', (simulator) => simulator.addTurret(VICTIM, keep, AT, 2), { gold: DEFAULT_CORE_REWARD.gold, xp: DEFAULT_CORE_REWARD.xp }],
  ]
  for (const [what, add, paid] of cases) {
    const simulator = economySimulator()
    simulator.addPlayer(1, 'p1', 'Ann', BESIDE, slayer, 1)
    add(simulator)
    simulator.addOrder(1, attack(1, 2, VICTIM))
    const found = watchDeath(simulator, 1, VICTIM, 40)
    assert.ok(found, `${what} died`)
    assert.deepEqual(simulator.paidFor(found.death, found.frame), paid, `killing ${what}`)
    // It is what the killer's frame gained on that tick.
    assert.equal((found.frame.get(1)?.getGold() ?? 0) - found.before.gold, paid.gold, `${what}: the gold the frame was paid`)
    assert.equal((found.frame.get(1)?.getXp() ?? 0) - found.before.xp, paid.xp, `${what}: and the experience`)
  }
})

test('a death pays no one when there is no killer, no economy, or the killer is a turret', () => {
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p1', 'Ann', BESIDE, slayer, 1)
  simulator.addPlayer(VICTIM, 'p10', 'Victim', AT, glass, 2)
  simulator.addOrder(1, attack(1, 2, VICTIM))
  const found = watchDeath(simulator, 1, VICTIM, 40)
  assert.ok(found)
  const { killerId: _killer, ...nobody } = found.death
  assert.equal(simulator.paidFor(nobody, found.frame), undefined, 'a champion that took its own last health has no killer')

  // The same kill in a game with no economy pays nothing.
  const plain = new Simulator()
  plain.addPlayer(1, 'p1', 'Ann', BESIDE, slayer, 1)
  plain.addPlayer(VICTIM, 'p10', 'Victim', AT, glass, 2)
  plain.addOrder(1, attack(1, 2, VICTIM))
  const plainKill = watchDeath(plain, 1, VICTIM, 40)
  assert.ok(plainKill)
  assert.equal(plain.paidFor(plainKill.death, plainKill.frame), undefined)

  // A turret that kills a player is paid nothing.
  const guarded = economySimulator()
  guarded.addTurret(20, executioner, AT, 2)
  guarded.addPlayer(2, 'p2', 'Bob', BESIDE, glass, 1)
  const shot = watchDeath(guarded, 20, 2, 40)
  assert.ok(shot, 'the turret killed the player')
  assert.equal(shot.death.killerId, 20)
  assert.equal(guarded.paidFor(shot.death, shot.frame), undefined)
})

// ---------------------------------------------------------------------------- the page

type Game = { state: ClientGameState; step: (tick: number) => KillRewardView[] }

// A page whose champion (1, Ann, on team 1) kills the monster (10) on tick 2, and that is told each tick as it goes, as a page is: `step` moves to
// that tick and returns what the page says of the kills it has not told yet.
function game(options: { local?: number; economy?: boolean; add?: (state: ClientGameState) => void } = {}): Game {
  const state = options.economy === false ? new ClientGameState() : economyClient()
  state.simulator.addPlayer(1, 'p1', 'Ann', BESIDE, slayer, 1)
  state.simulator.addPlayer(2, 'p2', 'Bob', { x: 1500, y: 1200 }, glass, 2)
  if (options.add) options.add(state)
  else state.simulator.addMonster(VICTIM, grunt, AT)
  state.setLocalCharacterId(options.local ?? 1)
  state.simulator.addOrder(1, attack(1, 2, VICTIM))
  return {
    state,
    step(tick) {
      state.simulator.advanceTo(tick)
      state.setServerTick(tick, 0)
      return state.getKillRewards(0)
    },
  }
}
const through = (play: Game, from: number, to: number): KillRewardView[] =>
  Array.from({ length: to - from + 1 }, (_, index) => play.step(from + index)).flat()

test('the page tells of the kill the controlled champion makes, with what it paid and where the victim fell, and once', () => {
  const play = game()
  const told = through(play, 1, 60)
  assert.equal(told.length, 1, 'one kill, one effect')
  const [reward] = told
  assert.match(reward.id, new RegExp(`^\\d+:${VICTIM}$`))
  assert.deepEqual(reward.position, AT, 'over where it fell')
  assert.deepEqual([reward.radius, reward.gold, reward.xp], [grunt.champion.radius, 33, 44])
  assert.deepEqual(through(play, 61, 90), [], 'and never again')
})

test('the page tells of a kill it was not asked about for a few ticks, and does not tell of it again when its tick is worked out again', () => {
  const play = game()
  play.step(1)
  const told = play.step(10)
  assert.equal(told.length, 1, 'a page that draws a few ticks at a time still tells of it')
  // A late order from someone else works the ticks from there out again, and the kill comes out the same.
  assert.equal(play.state.simulator.addOrder(2, { id: 'idle', seq: 1, tick: 5, type: 'move', target: { x: 1500, y: 1200 } }), true)
  assert.deepEqual(through(play, 11, 40), [])
})

test('a kill that a late order moves to a later tick is the same kill, and is not told twice', () => {
  const play = game()
  // The page is told of the kill the tick it happens on.
  let tick = 0
  let told: KillRewardView[] = []
  while (told.length === 0 && tick < 40) told = play.step((tick += 1))
  assert.equal(told.length, 1, 'told of it as it happened')
  const fell = Number(told[0].id.split(':')[0])
  assert.equal(fell, tick)
  // A late order from Ann herself takes it back (she walks off as the blow was to land) and gives it a few ticks later: the monster dies
  // again, on a later tick than the page has looked at.
  const later = fell + 4
  assert.equal(play.state.simulator.addOrder(1, { id: 'off', seq: 2, tick: fell, type: 'move', target: { x: 650, y: 700 } }), true)
  assert.equal(play.state.simulator.addOrder(1, { ...attack(1, later, VICTIM), seq: 3, id: 'again' }), true)
  const again = through(play, tick + 1, later + 20)
  const diedAgain = play.state.simulator.at(later + 20).get(VICTIM)?.getDeathTick()
  assert.ok(diedAgain !== undefined && diedAgain > fell, `it was killed again, on a later tick (${diedAgain})`)
  assert.deepEqual(again, [], 'but it is the kill that was told of')
})

test('the page tells of the kills of the champion it controls, and no one else\'s', () => {
  const play = game({ local: 2 })
  assert.deepEqual(through(play, 1, 60), [], 'Ann killed the monster, and Bob is the one this page controls')
  assert.deepEqual(game({ local: undefined as unknown as number }).state.getKillRewards(0), [], 'and with no champion yet, none')
})

test('a player\'s kill, and a kill that paid nothing, and a kill in a game with no economy', () => {
  const player = game({ add: (state) => state.simulator.addPlayer(VICTIM, 'p10', 'Victim', AT, glass, 2) })
  const [reward] = through(player, 1, 60)
  assert.deepEqual([reward?.gold, reward?.xp], [PLAYER_KILL_REWARD.gold, PLAYER_KILL_REWARD.xp], 'a player pays what a player pays')

  const core = game({ add: (state) => state.simulator.addTurret(VICTIM, keep, AT, 2) })
  assert.deepEqual(through(core, 1, 60), [], 'breaking a core that pays nothing says nothing')

  const plain = game({ economy: false })
  assert.deepEqual(through(plain, 1, 60), [], 'a game with no economy pays nothing, so says nothing')
})

test('what the page says of a kill has a position and a size to put it by, for any victim', () => {
  const at = (position: Vector2): Vector2 => position
  const turret = game({ add: (state) => state.simulator.addTurret(VICTIM, post, AT, 2) })
  const [reward] = through(turret, 1, 60)
  assert.deepEqual(at(reward.position), AT)
  assert.equal(reward.radius, post.champion.radius, 'the size of the turret, so the words are over the top of it')
  assert.deepEqual([reward.gold, reward.xp], [70, 30])
})
