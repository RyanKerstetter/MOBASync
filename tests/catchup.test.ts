import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  assistXp,
  catchupMultiplier,
  catchupXp,
  GAME_CATCHUP_XP_PER_LEVEL,
  GAME_MAX_LEVEL,
  PLAYER_KILL_REWARD,
  PLAYER_KILL_XP_PER_LEVEL,
  playerKillXpAt,
  Simulator,
  xpToReachLevel,
  type Champion,
  type CharacterOrder,
  type DeathRecord,
  type GameTickSnapshot,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineChampion, defineMonster, economyClient, economySimulator } from './fixtures.ts'

// Catch-up: experience paid to a player who is behind the best player in the game is multiplied, by `GAME_CATCHUP_XP_PER_LEVEL` more for each level behind; and killing a player pays more
// experience the higher its level (`PLAYER_KILL_XP_PER_LEVEL` more for each level above the first). The champions and the monsters here are the tests' own, and what is paid comes from the
// exported constants and functions, so retuning the rates changes nothing here; what they check is who is paid what, and that the page is told what was paid.

// ---------------------------------------------------------------------------- the rules, on their own

test('a player is paid more for each level it is behind the best player, and the best is paid as it is, never less', () => {
  assert.ok(GAME_CATCHUP_XP_PER_LEVEL > 0, 'there is a catch-up')
  assert.equal(catchupMultiplier(5, 5), 1, 'level with the best')
  assert.equal(catchupMultiplier(6, 5), 1, 'ahead of the best is not a thing, and is not a penalty either')
  assert.equal(catchupMultiplier(18, 1), 1)
  for (const behind of [1, 2, 4, 9]) {
    assert.equal(catchupMultiplier(3, 3 + behind), 1 + GAME_CATCHUP_XP_PER_LEVEL * behind, `${behind} levels behind`)
  }
  const multipliers = Array.from({ length: GAME_MAX_LEVEL }, (_, index) => catchupMultiplier(index + 1, GAME_MAX_LEVEL))
  assert.deepEqual([...multipliers].sort((left, right) => right - left), multipliers, 'the further behind, the more')
  assert.equal(multipliers.at(-1), 1, 'and the best is level')
  for (const odd of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(catchupMultiplier(odd, 3), 1, `${odd} is not a level`)
    assert.equal(catchupMultiplier(3, odd), 1, `${odd} is not a level`)
  }
})

test('catch-up pays whole points of experience, and nothing for nothing', () => {
  assert.equal(catchupXp(0, 1, 9), 0)
  assert.equal(catchupXp(-5, 1, 9), 0, 'never a debt')
  for (const xp of [1, 7, 25, 44, 80, 301]) {
    const paid = catchupXp(xp, 2, 6)
    assert.ok(Number.isInteger(paid), `whole points for ${xp}`)
    assert.ok(Math.abs(paid - xp * catchupMultiplier(2, 6)) <= 0.5, `${paid} is ${xp} with the multiplier`)
    assert.ok(paid >= xp, 'and not less than it was')
  }
  assert.equal(catchupXp(80, 4, 4), 80, 'level with the best, as it is')
})

test('killing a player pays more the higher its level, from the reward as it is at the first', () => {
  assert.ok(PLAYER_KILL_XP_PER_LEVEL > 0, 'a higher level pays more')
  assert.equal(playerKillXpAt(PLAYER_KILL_REWARD.xp, 1), PLAYER_KILL_REWARD.xp, 'level 1 pays the reward as it is')
  for (const level of [2, 3, 6, GAME_MAX_LEVEL]) {
    const paid = playerKillXpAt(PLAYER_KILL_REWARD.xp, level)
    assert.ok(Number.isInteger(paid), 'whole points')
    assert.ok(Math.abs(paid - PLAYER_KILL_REWARD.xp * (1 + PLAYER_KILL_XP_PER_LEVEL * (level - 1))) <= 0.5, `level ${level}: ${paid}`)
  }
  const paid = Array.from({ length: GAME_MAX_LEVEL }, (_, index) => playerKillXpAt(PLAYER_KILL_REWARD.xp, index + 1))
  assert.deepEqual([...paid].sort((left, right) => left - right), paid, 'each level pays no less than the one before')
  assert.ok((paid.at(-1) ?? 0) > paid[0], 'and the top level more than the first')
  assert.equal(playerKillXpAt(PLAYER_KILL_REWARD.xp, 0), PLAYER_KILL_REWARD.xp, 'there is no level below the first')
  assert.equal(playerKillXpAt(PLAYER_KILL_REWARD.xp, Number.NaN), PLAYER_KILL_REWARD.xp)
  assert.equal(playerKillXpAt(PLAYER_KILL_REWARD.xp, 3.9), playerKillXpAt(PLAYER_KILL_REWARD.xp, 3), 'a part of a level is not one')
})

// ---------------------------------------------------------------------------- the game

// A body that kills in one blow, from a way off, and lasts through what is done to it.
const slayer = defineChampion({
  id: 't-cu-slayer',
  name: 'Catch-up Slayer',
  base: { maxHp: 1000, attackDamage: 5000, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 300,
  attackWindup: 0,
  abilities: [],
})
// A body that hits for a part of what a victim has, so that two of them are needed.
const jabber = defineChampion({
  id: 't-cu-jabber',
  name: 'Catch-up Jabber',
  base: { maxHp: 1000, attackDamage: 60, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 300,
  attackWindup: 0,
  abilities: [],
})
// A victim with little health, which one blow of a slayer is enough for, or two of a jabber's.
const glass = defineChampion({
  id: 't-cu-glass',
  name: 'Catch-up Glass',
  base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 50,
  attackWindup: 0,
  abilities: [],
})
let made = 0
// A monster that dies to one blow and is worth this much experience, however high a level it gets, and no gold.
const feed = (xp: number, respawnTicks = 4000) => defineMonster({
  id: `t-cu-feed-${(made += 1)}`,
  name: 'Catch-up Feed',
  base: { maxHp: 1, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300, respawnTicks },
  reward: { gold: 0, xp },
  xpGrowth: 0,
})

let sequence = 0
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })

type Player = { id: number; team: number; at: Vector2; who?: Champion }
const ONE: Player = { id: 1, team: 1, at: { x: 600, y: 700 } }
const TWO: Player = { id: 2, team: 2, at: { x: 900, y: 700 } }
const LEVEL = 5

function game(players: readonly Player[], simulator: Simulator = economySimulator()): Simulator {
  for (const player of players) simulator.addPlayer(player.id, `p${player.id}`, `Player ${player.id}`, player.at, player.who ?? slayer, player.team)
  return simulator
}
// Brings the player to this level on this tick, by killing a monster that is worth that much experience, standing within its reach. (Nobody is above the first level yet when it is done.)
function levelledTo(simulator: Simulator, player: Player, level: number, tick: number, monsterId: number): void {
  const reach = Math.min(70, (player.who ?? slayer).attackRange - 10)
  simulator.addMonster(monsterId, feed(xpToReachLevel(level)), { x: player.at.x, y: player.at.y + reach })
  simulator.addOrder(player.id, attack(tick, monsterId))
}

const xpOf = (frame: GameTickSnapshot, id: number): number => frame.get(id)?.getXp() ?? 0
const levelOf = (frame: GameTickSnapshot, id: number): number => frame.get(id)?.getLevel() ?? 1
// The death of this one, and the frame it happened on, looking from this tick on.
function deathOf(simulator: Simulator, victimId: number, first: number, last = first + 400): { death: DeathRecord; frame: GameTickSnapshot } {
  for (let tick = first; tick <= last; tick += 1) {
    const frame = simulator.at(tick)
    const death = frame.deaths.find((record) => record.victimId === victimId)
    if (death) return { death, frame }
  }
  return assert.fail(`${victimId} did not die`)
}
// What a player was paid on the tick of a death: what its experience went up by.
const paidOn = (simulator: Simulator, found: { death: DeathRecord; frame: GameTickSnapshot }, id: number): number =>
  xpOf(found.frame, id) - xpOf(simulator.at(found.death.tick - 1), id)

test('a player behind the best is paid more for what it kills, by the levels it is behind, and the best player is paid as it is', () => {
  // Player 2 (on the other team) is brought to LEVEL, and then each of the two kills a monster worth XP: player 1, who is behind, and player 2, who is the best.
  const XP = 20
  const simulator = game([ONE, TWO])
  levelledTo(simulator, TWO, LEVEL, 2, 10)
  simulator.addMonster(11, feed(XP), { x: ONE.at.x, y: ONE.at.y + 70 })
  simulator.addMonster(12, feed(XP), { x: TWO.at.x, y: TWO.at.y + 70 })
  simulator.addOrder(1, attack(20, 11))
  simulator.addOrder(2, attack(20, 12))

  assert.equal(levelOf(simulator.at(3), 2), LEVEL, 'player 2 is the best')
  assert.equal(xpOf(simulator.at(3), 2), xpToReachLevel(LEVEL), 'and was paid in full for getting there: nobody was ahead')
  assert.equal(levelOf(simulator.at(3), 1), 1)
  const first = deathOf(simulator, 11, 4)
  assert.equal(paidOn(simulator, first, 1), catchupXp(XP, 1, LEVEL), 'player 1 is paid the multiplier for four levels behind')
  assert.ok(catchupXp(XP, 1, LEVEL) > XP, 'which is more than it was worth')
  assert.equal(paidOn(simulator, first, 2), 0, 'and player 2 is paid nothing for it')
  assert.deepEqual(simulator.paidFor(first.death, first.frame), { gold: 0, xp: catchupXp(XP, 1, LEVEL) }, 'the page is told what was paid')
})

test('the best player is paid exactly what a kill is worth', () => {
  const XP = 20
  const simulator = game([ONE, TWO])
  levelledTo(simulator, TWO, LEVEL, 2, 10)
  simulator.addMonster(12, feed(XP), { x: TWO.at.x, y: TWO.at.y + 70 })
  simulator.addOrder(2, attack(20, 12))
  simulator.at(3)
  const found = deathOf(simulator, 12, 4)
  assert.equal(paidOn(simulator, found, 2), XP, 'player 2, the best, is paid as it is')
  assert.equal(simulator.paidFor(found.death, found.frame)?.xp, XP)
})

test('the best player is the best on any team: a player behind a teammate is paid more, and so is one behind a player of the other team', () => {
  const XP = 20
  const mate: Player = { id: 3, team: 1, at: { x: 1300, y: 700 } }
  const world = (): Simulator => {
    const simulator = game([ONE, TWO, mate])
    levelledTo(simulator, mate, LEVEL, 2, 10)
    simulator.addMonster(11, feed(XP), { x: ONE.at.x, y: ONE.at.y + 70 })
    simulator.addMonster(12, feed(XP), { x: TWO.at.x, y: TWO.at.y + 70 })
    simulator.addOrder(1, attack(20, 11))
    simulator.addOrder(2, attack(20, 12))
    return simulator
  }
  const teammate = world()
  teammate.at(3)
  assert.equal(paidOn(teammate, deathOf(teammate, 11, 4), 1), catchupXp(XP, 1, LEVEL), 'behind a teammate it is paid the multiplier')
  const rival = world()
  rival.at(3)
  assert.equal(paidOn(rival, deathOf(rival, 12, 4), 2), catchupXp(XP, 1, LEVEL), 'behind a player of the other team it is paid the multiplier too')
})

test('a best player who is dead still counts as the best', () => {
  const XP = 20
  const best: Player = { id: 2, team: 2, at: { x: 800, y: 700 } }
  const simulator = game([ONE, best])
  levelledTo(simulator, best, LEVEL, 2, 10)
  simulator.addOrder(1, attack(8, 2))
  simulator.addMonster(11, feed(XP), { x: ONE.at.x, y: ONE.at.y + 70 })
  simulator.addOrder(1, attack(40, 11))

  const killed = deathOf(simulator, 2, 3, 30)
  assert.equal(killed.death.killerId, 1, 'player 2 is killed by player 1')
  const level = levelOf(simulator.at(39), 1)
  assert.ok(level < LEVEL, 'player 1 is still behind')
  const found = deathOf(simulator, 11, 40, 80)
  assert.equal(simulator.at(found.death.tick).get(2)?.isDead(), true, 'the best player is dead when the other is paid')
  assert.equal(paidOn(simulator, found, 1), catchupXp(XP, level, LEVEL), 'and still counts: player 1 is paid for being behind it')
})

test('a monster that has levelled up past every player does not make a player behind: only players count', () => {
  // The prey comes back a level higher each time it is killed (in a game with an economy), and pays the same experience however high it is.
  const XP = 5
  const kills = 5
  const spacing = 60
  const simulator = game([ONE])
  simulator.addMonster(10, feed(XP, 30), { x: ONE.at.x, y: ONE.at.y + 70 })
  for (let index = 0; index < kills; index += 1) simulator.addOrder(1, attack(2 + index * spacing, 10))

  const paid: number[] = []
  let before = 0
  let preyLevel = 1
  let playerLevel = 1
  for (let tick = 2; tick <= 2 + (kills - 1) * spacing + 10; tick += 1) {
    const frame = simulator.at(tick)
    const now = xpOf(frame, 1)
    if (now !== before) paid.push(now - before)
    before = now
    preyLevel = Math.max(preyLevel, levelOf(frame, 10))
    playerLevel = levelOf(frame, 1)
  }
  assert.ok(preyLevel > playerLevel, `the prey got to level ${preyLevel}, above the only player (level ${playerLevel})`)
  assert.deepEqual(paid, Array.from({ length: kills }, () => XP), 'and every kill was paid as it was worth: the prey is no player')
})

test('killing a player pays more the higher its level, and a killer who is the best in the game is paid just that', () => {
  // The killer is the best (level 7), and kills a player of level 5 on tick 20.
  const victim: Player = { ...TWO, who: glass }
  const simulator = game([ONE, victim])
  levelledTo(simulator, ONE, 7, 2, 10)
  levelledTo(simulator, victim, LEVEL, 2, 11)
  simulator.addOrder(1, attack(20, 2))

  assert.deepEqual([levelOf(simulator.at(3), 1), levelOf(simulator.at(3), 2)], [7, LEVEL], 'they are the levels they should be')
  const found = deathOf(simulator, 2, 4)
  assert.equal(found.death.killerId, 1)
  assert.equal(paidOn(simulator, found, 1), playerKillXpAt(PLAYER_KILL_REWARD.xp, LEVEL), 'the kill pays what a player of level 5 is worth')
  assert.ok(playerKillXpAt(PLAYER_KILL_REWARD.xp, LEVEL) > PLAYER_KILL_REWARD.xp, 'which is more than a player of the first level')
  assert.deepEqual(simulator.paidFor(found.death, found.frame), { gold: PLAYER_KILL_REWARD.gold, xp: playerKillXpAt(PLAYER_KILL_REWARD.xp, LEVEL) }, 'the gold is the same whatever the level')
})

test('killing a player of the first level pays the reward as it is', () => {
  const simulator = game([ONE, { ...TWO, who: glass }])
  simulator.addOrder(1, attack(2, 2))
  const found = deathOf(simulator, 2, 2)
  assert.equal(paidOn(simulator, found, 1), PLAYER_KILL_REWARD.xp)
  assert.deepEqual(simulator.paidFor(found.death, found.frame), { gold: PLAYER_KILL_REWARD.gold, xp: PLAYER_KILL_REWARD.xp })
})

test('the two add up: a killer behind the best, killing the best, is paid for the level of the player killed and then for how far behind it is', () => {
  // Player 2 is the best (level 5), and a glass body; player 1 is at level 1 and kills it.
  const victim: Player = { ...TWO, who: glass }
  const simulator = game([ONE, victim])
  levelledTo(simulator, victim, LEVEL, 2, 10)
  simulator.addOrder(1, attack(20, 2))
  simulator.at(3)
  const found = deathOf(simulator, 2, 4)
  const worth = playerKillXpAt(PLAYER_KILL_REWARD.xp, LEVEL)
  assert.equal(paidOn(simulator, found, 1), catchupXp(worth, 1, LEVEL), 'the kill is worth its level, and then the killer is four levels behind the one it killed')
  assert.ok(catchupXp(worth, 1, LEVEL) > worth && worth > PLAYER_KILL_REWARD.xp)
  assert.equal(simulator.paidFor(found.death, found.frame)?.xp, catchupXp(worth, 1, LEVEL))
})

// Players 1 (behind) and 3 (the best, at LEVEL) are on one team, and the glass body (2) on the other is wounded by one and finished by the other.
const LOW: Player = { id: 1, team: 1, at: { x: 700, y: 700 }, who: jabber }
const TOP: Player = { id: 3, team: 1, at: { x: 1100, y: 700 }, who: jabber }
const PREY: Player = { id: 2, team: 2, at: { x: 900, y: 700 }, who: glass }
function assisting(woundedBy: number, finishedBy: number, simulator: Simulator = economySimulator()): Simulator {
  game([LOW, PREY, TOP], simulator)
  levelledTo(simulator, TOP, LEVEL, 2, 10)
  // Player 3\'s attack that levelled it is on its cooldown until tick 62, so the blows come after that: the wound first, and the kill thirty ticks later.
  simulator.addOrder(woundedBy, attack(70, 2))
  simulator.addOrder(finishedBy, attack(100, 2))
  return simulator
}

test('an assist is paid a share of what the kill is worth, and then its own catch-up', () => {
  const simulator = assisting(1, 3)
  simulator.at(3)
  const found = deathOf(simulator, 2, 4)
  assert.deepEqual([found.death.killerId, found.death.assistId], [3, 1], 'player 3 killed it, with player 1 wounding it first')
  assert.equal(paidOn(simulator, found, 3), PLAYER_KILL_REWARD.xp, 'the best player is paid the kill as it is worth')
  const share = assistXp(PLAYER_KILL_REWARD.xp)
  assert.equal(paidOn(simulator, found, 1), catchupXp(share, 1, LEVEL), 'the assist is a share of the kill, with the assister\'s own catch-up')
  assert.ok(catchupXp(share, 1, LEVEL) > share)
  assert.equal(simulator.assistPaidFor(found.death, found.frame), catchupXp(share, 1, LEVEL), 'and the page is told that')
})

test('the assist is a share of what the kill is worth, not of what the killer was paid: a killer who is behind makes it no larger', () => {
  // Now it is the one behind who lands the last blow and the best who wounded it.
  const simulator = assisting(3, 1)
  simulator.at(3)
  const found = deathOf(simulator, 2, 4)
  assert.deepEqual([found.death.killerId, found.death.assistId], [1, 3])
  assert.equal(paidOn(simulator, found, 1), catchupXp(PLAYER_KILL_REWARD.xp, 1, LEVEL), 'the killer, who is behind, is paid its catch-up')
  assert.equal(paidOn(simulator, found, 3), assistXp(PLAYER_KILL_REWARD.xp), 'and the assist, who is the best, is paid the share of the kill, without the killer\'s extra')
})

test('what is paid does not depend on who is paid first: two players levelled by kills on the same tick are both paid as they were worth', () => {
  // Both are level 1 when the tick begins, so neither is behind anyone: whichever is paid first, the other is not paid as if it were behind.
  const LOW_LEVEL = 5
  const HIGH_LEVEL = 9
  const simulator = game([ONE, TWO])
  levelledTo(simulator, ONE, LOW_LEVEL, 2, 10)
  levelledTo(simulator, TWO, HIGH_LEVEL, 2, 11)
  const frame = simulator.at(3)
  assert.deepEqual([levelOf(frame, 1), levelOf(frame, 2)], [LOW_LEVEL, HIGH_LEVEL])
  assert.deepEqual([xpOf(frame, 1), xpOf(frame, 2)], [xpToReachLevel(LOW_LEVEL), xpToReachLevel(HIGH_LEVEL)], 'each is paid what its monster was worth')
})

test('without an economy there is no experience, so there is nothing to catch up on', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', ONE.at, slayer, 1)
  simulator.addPlayer(2, 'p2', 'Two', TWO.at, glass, 2)
  simulator.addOrder(1, attack(2, 2))
  const found = deathOf(simulator, 2, 2)
  assert.equal(xpOf(found.frame, 1), 0)
  assert.equal(simulator.paidFor(found.death, found.frame), undefined)
})

// ---------------------------------------------------------------------------- the page

// A page that plays a game, told each tick as it goes and with kills confirmed a little after, as a page is. What it showed over the bodies, for the local player.
function playedPage(local: number, build: (simulator: Simulator) => void, last: number): Array<{ gold: number; xp: number }> {
  const state: ClientGameState = economyClient()
  build(state.simulator)
  state.setLocalCharacterId(local)
  const told: Array<{ gold: number; xp: number }> = []
  for (let tick = 1; tick <= last; tick += 1) {
    state.simulator.advanceTo(tick)
    if (tick > 12) state.simulator.setCommitTick(tick - 12)
    state.setServerTick(tick, 0)
    told.push(...state.getKillRewards(0).map(({ gold, xp }) => ({ gold, xp })))
  }
  return told
}

test('the page tells a player what its kill really paid, with the level of the one killed and with catch-up', () => {
  const victim: Player = { ...TWO, who: glass }
  const build = (simulator: Simulator): void => {
    game([ONE, victim], simulator)
    levelledTo(simulator, victim, LEVEL, 2, 10)
    simulator.addOrder(1, attack(20, 2))
  }
  const expected = catchupXp(playerKillXpAt(PLAYER_KILL_REWARD.xp, LEVEL), 1, LEVEL)
  assert.deepEqual(playedPage(1, build, 40), [{ gold: PLAYER_KILL_REWARD.gold, xp: expected }], 'the number over the body is what was paid')
  assert.ok(expected > PLAYER_KILL_REWARD.xp)
})

test('the page tells a player what a monster\'s kill paid, behind the best or the best itself', () => {
  const XP = 20
  const feeding = (simulator: Simulator): void => {
    game([ONE, TWO], simulator)
    levelledTo(simulator, TWO, LEVEL, 2, 10)
    simulator.addMonster(11, feed(XP), { x: ONE.at.x, y: ONE.at.y + 70 })
    simulator.addOrder(1, attack(20, 11))
  }
  assert.deepEqual(playedPage(1, feeding, 40), [{ gold: 0, xp: catchupXp(XP, 1, LEVEL) }], 'behind the best')
  assert.deepEqual(playedPage(2, feeding, 40), [{ gold: 0, xp: xpToReachLevel(LEVEL) }], 'and the best player is told what its own kill paid, as it was worth')
})

test('the page tells an assist what it was paid, with its own catch-up', () => {
  const build = (simulator: Simulator): void => void assisting(1, 3, simulator)
  assert.deepEqual(playedPage(1, build, 130), [{ gold: 0, xp: catchupXp(assistXp(PLAYER_KILL_REWARD.xp), 1, LEVEL) }])
})
