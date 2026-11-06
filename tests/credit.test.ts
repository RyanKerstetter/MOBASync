import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  addDamage,
  ASSIST_XP_SHARE,
  assistXp,
  creditKill,
  GAME_CREDIT_WINDOW_TICKS,
  GAME_STARTING_GOLD,
  GameSnapshotSchema,
  liveDamage,
  PLAYER_KILL_REWARD,
  rankDamage,
  Simulator,
  type CharacterOrder,
  type DamageShare,
  type DeathRecord,
  type GameTickSnapshot,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineChampion, defineMonster, defineTurret, economyClient, economySimulator } from './fixtures.ts'

// Who a death is credited to. The player who landed the last blow is the killer (if it was a turret or a monster that did, the player who did the most damage to the victim is);
// the players who hurt it are listed after them by the damage they did, and the one second in that list is the assist if they are on the killer's team, and nobody else is
// credited. The killer is paid as always, and the assist is paid a share of the experience (`assistXp`) and none of the gold. The champions, the monsters and the turrets here are the tests' own, with every number spelled out; what a kill and an assist
// pay is read from the game (`PLAYER_KILL_REWARD`, `assistXp`), so retuning them changes nothing here.

// ---------------------------------------------------------------------------- the rules, on their own

const shares = (...damage: Array<[number, number]>): DamageShare[] => damage.map(([id, amount]) => ({ id, damage: amount }))
const teams: Record<number, number> = { 1: 1, 2: 1, 3: 3, 4: 1 }
const teamOf = (id: number): number | undefined => teams[id]

test('the players are ranked by the damage they did, and the one who started hurting it first wins a tie', () => {
  assert.deepEqual(rankDamage(shares([1, 100], [2, 300], [3, 200])).map((share) => share.id), [2, 3, 1])
  assert.deepEqual(rankDamage(shares([1, 250], [2, 250], [3, 250])).map((share) => share.id), [1, 2, 3], 'equal damage keeps the order they began in')
  assert.deepEqual(rankDamage([]), [])
})

test('the last hit is the kill, whoever did the most damage is the assist if they are the killer\'s teammate, and no one else is credited', () => {
  assert.deepEqual(creditKill([], teamOf, 1), {}, 'no player hurt it: no one is credited')
  assert.deepEqual(creditKill(shares([1, 100]), teamOf, 1), { killerId: 1 }, 'alone, there is no assist')
  assert.deepEqual(creditKill(shares([1, 100], [2, 400]), teamOf, 1), { killerId: 1, assistId: 2 }, 'the last hit is the killer, though the other did more')
  assert.deepEqual(creditKill(shares([1, 100], [2, 400]), teamOf, 2), { killerId: 2, assistId: 1 }, 'and when it was the one who did more, the other is the assist')
  assert.deepEqual(creditKill(shares([1, 400], [3, 300]), teamOf, 4), { killerId: 1 }, 'a last hit that is in no tally is not one: the one who did the most is the killer')
  assert.deepEqual(creditKill(shares([1, 400], [3, 300]), teamOf), { killerId: 1 }, 'and so is no last hit at all')
  assert.deepEqual(creditKill(shares([1, 100], [3, 300]), teamOf, 1), { killerId: 1 }, 'the one second in the list is no assist when they are not on the killer\'s team')
  assert.deepEqual(creditKill(shares([2, 100], [3, 300], [1, 200]), teamOf, 2), { killerId: 2 }, 'and a teammate behind them is not one either')
  assert.deepEqual(creditKill(shares([4, 100], [1, 400], [2, 300]), teamOf, 4), { killerId: 4, assistId: 1 }, 'and the third in the list gets nothing, though they are on the team')
  assert.deepEqual(creditKill(shares([4, 100], [1, 250], [2, 250]), teamOf, 4), { killerId: 4, assistId: 1 }, 'equal damage goes to whoever started first')
})

test('an assist pays a share of the kill\'s experience, in whole points', () => {
  assert.equal(assistXp(0), 0)
  assert.equal(assistXp(-5), 0)
  for (const xp of [1, 25, 44, 80, 301]) {
    const paid = assistXp(xp)
    assert.ok(Number.isInteger(paid), `whole points for ${xp}`)
    assert.ok(Math.abs(paid - xp * ASSIST_XP_SHARE) <= 0.5, `${paid} is the share of ${xp}`)
  }
  assert.ok(ASSIST_XP_SHARE > 0 && ASSIST_XP_SHARE < 1, 'less than the kill pays')
})

test('the damage a victim has taken is a tally that runs out once nobody has hurt it for the credit window', () => {
  const first = addDamage(undefined, 1, 40, 100)
  assert.deepEqual(first, { tick: 100, by: [{ id: 1, damage: 40 }] })
  const second = addDamage(first, 2, 15, 130)
  assert.deepEqual(second, { tick: 130, by: [{ id: 1, damage: 40 }, { id: 2, damage: 15 }] }, 'in the order they began')
  assert.deepEqual(addDamage(second, 1, 5, 140).by, [{ id: 1, damage: 45 }, { id: 2, damage: 15 }], 'a player\'s damage adds up')
  assert.deepEqual(first, { tick: 100, by: [{ id: 1, damage: 40 }] }, 'and the tally before is not changed')

  assert.deepEqual(liveDamage(second, 130 + GAME_CREDIT_WINDOW_TICKS).map((share) => share.id), [1, 2], 'still counting on the last tick of the window')
  assert.deepEqual(liveDamage(second, 130 + GAME_CREDIT_WINDOW_TICKS + 1), [], 'and not after')
  assert.deepEqual(liveDamage(undefined, 5), [])
  // Hurt again after it ran out, it begins again: the old damage is not in it.
  assert.deepEqual(addDamage(second, 3, 9, 130 + GAME_CREDIT_WINDOW_TICKS + 1).by, [{ id: 3, damage: 9 }])
  // Each blow keeps the whole tally going, so a long fight is not cut short.
  let tally = addDamage(undefined, 1, 10, 0)
  for (let tick = GAME_CREDIT_WINDOW_TICKS - 1; tick <= GAME_CREDIT_WINDOW_TICKS * 5; tick += GAME_CREDIT_WINDOW_TICKS - 1) tally = addDamage(tally, 2, 10, tick)
  assert.equal(tally.by.find((share) => share.id === 1)?.damage, 10, 'the first player\'s damage is still there')
})

// ---------------------------------------------------------------------------- a fight

let made = 0
// A body that hits once for `damage`, from a long way off, and has plenty of health to live through whatever it is hit by.
const hitter = (damage: number) => defineChampion({
  id: `t-cr-hitter-${(made += 1)}`,
  name: 'Hitter',
  base: { maxHp: 5000, attackDamage: damage, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 500,
  attackWindup: 0,
  abilities: [],
})
// A body with this much health, and no way to hurt anyone.
const bag = (maxHp: number) => defineChampion({
  id: `t-cr-bag-${(made += 1)}`,
  name: 'Bag',
  base: { maxHp, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 50,
  attackWindup: 0,
  abilities: [],
})

let sequence = 0
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })

const VICTIM = 9
const VICTIM_AT: Vector2 = { x: 800, y: 700 }
type Hit = { team: number; damage: number; tick: number }

// The hitters are players 1, 2, 3 ... in the order given, each beside the victim at a place of its own, who hit it once on their tick (and are told to stand still on the next, or
// they would hit it again). The victim is player 9, on team 2 (the hitters are on 1, and 3 for an enemy of both), with this much health.
function fight(victimHp: number, hits: readonly Hit[], simulator: Simulator = economySimulator()): Simulator {
  simulator.addPlayer(VICTIM, 'victim', 'Victim', VICTIM_AT, bag(victimHp), 2)
  hits.forEach((hit, index) => {
    const id = index + 1
    const at: Vector2 = { x: VICTIM_AT.x - 150, y: VICTIM_AT.y + (index - 1) * 60 }
    simulator.addPlayer(id, `p${id}`, `Hitter ${id}`, at, hitter(hit.damage), hit.team)
    simulator.addOrder(id, attack(hit.tick, VICTIM))
    simulator.addOrder(id, move(hit.tick + 1, at))
  })
  return simulator
}

// The record of the victim's death, and the frame it happened on.
function deathOf(simulator: Simulator, victimId = VICTIM, last = 500, first = 1): { death: DeathRecord; frame: GameTickSnapshot } {
  for (let tick = first; tick <= last; tick += 1) {
    const frame = simulator.at(tick)
    const death = frame.deaths.find((record) => record.victimId === victimId)
    if (death) return { death, frame }
  }
  return assert.fail(`${victimId} did not die`)
}
const xpOf = (frame: GameTickSnapshot, id: number): number => frame.get(id)?.getXp() ?? 0
const goldOf = (frame: GameTickSnapshot, id: number): number => frame.get(id)?.getGold() ?? 0

test('the player who landed the last blow gets the kill, even when someone else did more damage, and that one gets the assist', () => {
  const [FIRST, SECOND] = [600, 450]
  const simulator = fight(FIRST + SECOND - 50, [{ team: 1, damage: FIRST, tick: 2 }, { team: 1, damage: SECOND, tick: 40 }])
  assert.equal(simulator.at(3).get(VICTIM)?.getHealth(), FIRST + SECOND - 50 - FIRST, 'the first blow did what the champion hits for')
  const { death, frame } = deathOf(simulator)
  assert.equal(death.tick, 40, 'the second blow was the last')
  assert.deepEqual([death.killerId, death.assistId], [2, 1], 'the second landed it, and the first did more')

  assert.equal(xpOf(frame, 2), PLAYER_KILL_REWARD.xp, 'the killer is paid what a kill pays')
  assert.equal(goldOf(frame, 2), GAME_STARTING_GOLD + PLAYER_KILL_REWARD.gold)
  assert.equal(xpOf(frame, 1), assistXp(PLAYER_KILL_REWARD.xp), 'the assist is paid a share of the experience')
  assert.equal(goldOf(frame, 1), GAME_STARTING_GOLD, 'and none of the gold')
  assert.equal(simulator.assistPaidFor(death, frame), assistXp(PLAYER_KILL_REWARD.xp), 'which is what the simulator says an assist paid')
})

test('an assist is not a kill: it is not counted as one, and the killer is paid the whole of it, not what is left', () => {
  const simulator = fight(1000, [{ team: 1, damage: 600, tick: 2 }, { team: 1, damage: 450, tick: 40 }])
  const { death } = deathOf(simulator)
  simulator.advanceTo(death.tick + 1)
  simulator.setCommitTick(death.tick + 1)
  assert.deepEqual([simulator.characters.get(1)?.kills, simulator.characters.get(2)?.kills], [0, 1])
  assert.equal(xpOf(simulator.at(death.tick + 1), 2), PLAYER_KILL_REWARD.xp, 'the assist took nothing from the killer')
})

test('the kill is the last hit, and after it the players are listed by damage: only the one second in the list is an assist, the third and the rest are paid nothing', () => {
  const simulator = fight(850, [{ team: 1, damage: 500, tick: 2 }, { team: 1, damage: 300, tick: 10 }, { team: 1, damage: 100, tick: 20 }])
  const { death, frame } = deathOf(simulator)
  assert.deepEqual([death.killerId, death.assistId], [3, 1], 'the last hit, and then whoever did the most')
  assert.deepEqual([xpOf(frame, 3), xpOf(frame, 1)], [PLAYER_KILL_REWARD.xp, assistXp(PLAYER_KILL_REWARD.xp)])
  assert.deepEqual([xpOf(frame, 2), goldOf(frame, 2)], [0, GAME_STARTING_GOLD], 'the one who did the second most damage, but is third in the list, gets nothing')
})

test('the one second in the list is no assist when they are not on the killer\'s team, and the teammate behind them is not one either', () => {
  const apart = fight(1000, [{ team: 1, damage: 600, tick: 2 }, { team: 3, damage: 450, tick: 40 }])
  const first = deathOf(apart)
  assert.deepEqual([first.death.killerId, first.death.assistId], [2, undefined], 'the one who did more is an enemy of the killer')
  assert.deepEqual([xpOf(first.frame, 1), goldOf(first.frame, 1)], [0, GAME_STARTING_GOLD], 'and is paid nothing')

  const between = fight(1000, [{ team: 1, damage: 300, tick: 2 }, { team: 3, damage: 500, tick: 10 }, { team: 1, damage: 200, tick: 20 }])
  const second = deathOf(between)
  assert.deepEqual([second.death.killerId, second.death.assistId], [3, undefined])
  assert.equal(xpOf(second.frame, 1), 0, 'a teammate who did less than that enemy gets nothing')
})

test('equal damage goes to whoever started first', () => {
  const simulator = fight(1100, [{ team: 1, damage: 500, tick: 2 }, { team: 1, damage: 500, tick: 10 }, { team: 1, damage: 100, tick: 20 }])
  const { death } = deathOf(simulator)
  assert.deepEqual([death.killerId, death.assistId], [3, 1])
})

test('damage that was done long ago is not credited: once nobody has hurt the victim for the credit window, the fight begins again', () => {
  const late = 2 + GAME_CREDIT_WINDOW_TICKS + 10
  const simulator = fight(1000, [{ team: 1, damage: 600, tick: 2 }, { team: 1, damage: 450, tick: late }])
  const { death, frame } = deathOf(simulator, VICTIM, late + 20)
  assert.equal(death.tick, late, 'the second blow killed it')
  assert.deepEqual([death.killerId, death.assistId], [2, undefined], 'the first player is no assist, though they did more')
  assert.equal(xpOf(frame, 1), 0)
  assert.equal(xpOf(frame, 2), PLAYER_KILL_REWARD.xp)
})

test('in a game with no economy the credit is the same, and pays no one', () => {
  const simulator = fight(1000, [{ team: 1, damage: 600, tick: 2 }, { team: 1, damage: 450, tick: 40 }], new Simulator())
  const { death, frame } = deathOf(simulator)
  assert.deepEqual([death.killerId, death.assistId], [2, 1], 'it is still who is shown on the feed')
  assert.deepEqual([xpOf(frame, 1), xpOf(frame, 2)], [0, 0])
  assert.equal(simulator.assistPaidFor(death, frame), 0)
})

// ---------------------------------------------------------------------------- a turret or a monster takes the last of its health

// A turret that kills a player in one shot at any range it reaches, on team 1; and a monster that does the same up close.
const gun = defineTurret(98, { base: { maxHp: 1_000_000, attackDamage: 5000, attackSpeed: 1 }, radius: 30, attackRange: 400, attackWindup: 0 })
const brute = defineMonster({
  id: 't-cr-brute',
  name: 'Credit Brute',
  base: { maxHp: 600, attackDamage: 5000, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 300, deaggroRange: 500, respawnTicks: 3000 },
})
const NPC_AT: Vector2 = { x: 1300, y: 700 }
const VICTIM_FROM: Vector2 = { x: 700, y: 700 }

// The victim (9, on team 2) starts away from the NPC and walks up to it on tick 10, after `hits` have hurt it (by players 1 and 2, on team 1, from the west, out of the NPC's reach).
function ambush(npc: 'turret' | 'monster', hits: readonly Hit[]): Simulator {
  const simulator = economySimulator()
  if (npc === 'turret') simulator.addTurret(20, gun, NPC_AT, 1)
  else simulator.addMonster(20, brute, NPC_AT)
  simulator.addPlayer(VICTIM, 'victim', 'Victim', VICTIM_FROM, bag(1000), 2)
  hits.forEach((hit, index) => {
    const id = index + 1
    const at: Vector2 = { x: 450, y: 640 + index * 60 }
    simulator.addPlayer(id, `p${id}`, `Hitter ${id}`, at, hitter(hit.damage), hit.team)
    simulator.addOrder(id, attack(hit.tick, VICTIM))
    simulator.addOrder(id, move(hit.tick + 1, at))
  })
  simulator.addOrder(VICTIM, move(10, { x: NPC_AT.x - 200, y: NPC_AT.y }))
  return simulator
}

for (const npc of ['turret', 'monster'] as const) {
  test(`a player killed by a ${npc} after other players hurt it is a kill for the one who did the most damage, as the last blow was no player's, and an assist for the next`, () => {
    const simulator = ambush(npc, [{ team: 1, damage: 300, tick: 3 }, { team: 1, damage: 200, tick: 6 }])
    const { death, frame } = deathOf(simulator, VICTIM, 400)
    assert.ok(death.tick > 10, 'it was killed once it had walked up to the NPC')
    assert.equal(simulator.at(death.tick - 1).get(20)?.getHealth() !== undefined, true)
    assert.deepEqual([death.killerId, death.assistId], [1, 2], `not the ${npc}, though it took the last of the health`)
    assert.equal(xpOf(frame, 1), PLAYER_KILL_REWARD.xp)
    assert.equal(xpOf(frame, 2), assistXp(PLAYER_KILL_REWARD.xp))
  })

  test(`a player killed by a ${npc} that no player hurt is the ${npc}'s kill, and pays no one`, () => {
    const simulator = ambush(npc, [])
    const { death, frame } = deathOf(simulator, VICTIM, 400)
    assert.deepEqual([death.killerId, death.assistId], [20, undefined])
    assert.equal(simulator.paidFor(death, frame), undefined)
  })
}

// ---------------------------------------------------------------------------- a monster or a turret falls

test('a monster that falls pays the one who landed the last blow, and the one who did more damage is paid a share of its experience', () => {
  const prize = defineMonster({
    id: 't-cr-prize',
    name: 'Credit Prize',
    base: { maxHp: 1000, attackDamage: 1, attackSpeed: 1 },
    moveSpeed: 200,
    radius: 20,
    attackRange: 60,
    attackWindup: 0,
    abilities: [],
    ai: { aggroRange: 0, deaggroRange: 300, respawnTicks: 3000 },
    reward: { gold: 33, xp: 44 },
  })
  const simulator = economySimulator()
  simulator.addMonster(VICTIM, prize, VICTIM_AT)
  const [A, B]: Vector2[] = [{ x: 650, y: 700 }, { x: 650, y: 760 }]
  simulator.addPlayer(1, 'p1', 'Ann', A, hitter(600), 1)
  simulator.addPlayer(2, 'p2', 'Bea', B, hitter(450), 1)
  simulator.addOrder(1, attack(2, VICTIM))
  simulator.addOrder(1, move(3, A))
  simulator.addOrder(2, attack(40, VICTIM))
  const { death, frame } = deathOf(simulator)
  assert.deepEqual([death.killerId, death.assistId], [2, 1], 'Bea landed the last blow, and Ann did the most')
  assert.deepEqual([xpOf(frame, 2), goldOf(frame, 2)], [44, GAME_STARTING_GOLD + 33])
  assert.deepEqual([xpOf(frame, 1), goldOf(frame, 1)], [assistXp(44), GAME_STARTING_GOLD])
})

test('a turret that falls is credited the same way', () => {
  const post = defineTurret(99, { base: { maxHp: 1000, attackDamage: 1, attackSpeed: 1 }, radius: 30, attackRange: 1, attackWindup: 0, reward: { gold: 70, xp: 30 } })
  const simulator = economySimulator()
  simulator.addTurret(VICTIM, post, VICTIM_AT, 2)
  const [A, B]: Vector2[] = [{ x: 650, y: 700 }, { x: 650, y: 760 }]
  simulator.addPlayer(1, 'p1', 'Ann', A, hitter(600), 1)
  simulator.addPlayer(2, 'p2', 'Bea', B, hitter(450), 1)
  simulator.addOrder(1, attack(2, VICTIM))
  simulator.addOrder(1, move(3, A))
  simulator.addOrder(2, attack(40, VICTIM))
  const { death, frame } = deathOf(simulator)
  assert.deepEqual([death.killerId, death.assistId], [2, 1])
  assert.deepEqual([xpOf(frame, 2), goldOf(frame, 2)], [30, GAME_STARTING_GOLD + 70])
  assert.deepEqual([xpOf(frame, 1), goldOf(frame, 1)], [assistXp(30), GAME_STARTING_GOLD])
})

// ---------------------------------------------------------------------------- the same on every peer

const frameText = (simulator: Simulator, tick: number): unknown => JSON.parse(JSON.stringify(simulator.at(tick).toData()))
const BYSTANDER = 20
const withBystander = (simulator: Simulator): Simulator => {
  simulator.addPlayer(BYSTANDER, 'by', 'Bystander', { x: 300, y: 300 }, bag(500), 7)
  return simulator
}

test('the tally is in the frame: a fight that a late order works out again comes out the same, with the same credit', () => {
  const hits: Hit[] = [{ team: 1, damage: 600, tick: 2 }, { team: 1, damage: 450, tick: 8 }]
  const late = move(3, { x: 320, y: 300 })
  const straight = withBystander(fight(1000, hits))
  straight.addOrder(BYSTANDER, late)
  const rolledBack = withBystander(fight(1000, hits))
  rolledBack.advanceTo(12)
  assert.deepEqual(deathOf(rolledBack).death.assistId, 1)
  assert.equal(rolledBack.addOrder(BYSTANDER, late), true, 'the late order is taken')
  for (const tick of [3, 5, 12]) assert.deepEqual(frameText(rolledBack, tick), frameText(straight, tick), `tick ${tick}`)
  const mid = frameText(straight, 5) as { characters: Array<{ characterId: number; credit?: unknown }> }
  assert.deepEqual(mid.characters.find((character) => character.characterId === VICTIM)?.credit, { tick: 2, by: [{ id: 1, damage: 600 }] }, 'the tally is what the first blow did')
  const after = frameText(straight, 12) as { characters: Array<{ characterId: number; credit?: unknown }> }
  assert.equal(after.characters.find((character) => character.characterId === VICTIM)?.credit, undefined, 'and is gone with the victim')
})

test('a peer that restores the game from a snapshot in the middle of a fight credits the death the same', () => {
  const server = fight(1000, [{ team: 1, damage: 600, tick: 2 }, { team: 1, damage: 450, tick: 40 }])
  server.advanceTo(30)
  server.setCommitTick(20)
  const client = new Simulator(undefined, { kind: 'core', teams: [1, 2] })
  client.replaceFromSnapshot(GameSnapshotSchema.parse(JSON.parse(JSON.stringify(server.snapshot()))))
  assert.deepEqual(frameText(client, 20), frameText(server, 20), 'the checkpoint, with the tally in it')
  assert.deepEqual(frameText(client, 45), frameText(server, 45), 'and what comes of it')
  const { death } = deathOf(client, VICTIM, 60, 40)
  assert.deepEqual([death.killerId, death.assistId], [2, 1])
})

// ---------------------------------------------------------------------------- the page

// A page that plays a fight, told each tick as it goes and with kills confirmed a little after, as a page is.
function page(local: number, build: (simulator: Simulator) => void): ClientGameState {
  const state = economyClient()
  build(state.simulator)
  state.setLocalCharacterId(local)
  return state
}
function play(state: ClientGameState, last: number): Array<{ gold: number; xp: number }> {
  const told: Array<{ gold: number; xp: number }> = []
  for (let tick = 1; tick <= last; tick += 1) {
    state.simulator.advanceTo(tick)
    if (tick > 12) state.simulator.setCommitTick(tick - 12)
    state.setServerTick(tick, 0)
    told.push(...state.getKillRewards(0))
  }
  return told
}
// The last blow is the second player's, and the first did more damage; the third hits a victim who is already dead.
const stealFight = (simulator: Simulator): void => void fight(1000, [{ team: 1, damage: 600, tick: 2 }, { team: 1, damage: 450, tick: 40 }, { team: 1, damage: 1, tick: 41 }], simulator)

test('the kill feed says who killed whom, and who assisted', () => {
  const state = page(1, stealFight)
  play(state, 80)
  const [line, ...rest] = state.getKillFeed(performance.now())
  assert.deepEqual(rest, [], 'one death, one line')
  assert.deepEqual([line?.killer?.name, line?.assist?.name, line?.victim.name], ['Hitter 2', 'Hitter 1', 'Victim'])
  assert.deepEqual([line?.killer?.team, line?.assist?.team, line?.victim.team], [1, 1, 2])
})

test('the kill feed has no line for a monster that dies, and does for the player that does', () => {
  const state = page(1, (simulator) => {
    const prize = defineMonster({
      id: 't-cr-feed-prize',
      name: 'Feed Prize',
      base: { maxHp: 500, attackDamage: 1, attackSpeed: 1 },
      moveSpeed: 200,
      radius: 20,
      attackRange: 60,
      attackWindup: 0,
      abilities: [],
      ai: { aggroRange: 0, deaggroRange: 300, respawnTicks: 3000 },
    })
    simulator.addMonster(VICTIM, prize, VICTIM_AT)
    simulator.addPlayer(1, 'p1', 'Ann', { x: 650, y: 700 }, hitter(600), 1)
    simulator.addOrder(1, attack(2, VICTIM))
  })
  play(state, 80)
  assert.equal(state.simulator.at(80).get(VICTIM)?.isDead(), true, 'the monster died')
  assert.deepEqual(state.getKillFeed(performance.now()), [], 'and is not news')
})

test('the page tells the assist of what it was paid: a share of the experience and no gold, and the killer of the whole', () => {
  const paid = (told: Array<{ gold: number; xp: number }>) => told.map(({ gold, xp }) => ({ gold, xp }))
  assert.deepEqual(paid(play(page(1, stealFight), 80)), [{ gold: 0, xp: assistXp(PLAYER_KILL_REWARD.xp) }], 'the assist is told its share')
  assert.deepEqual(paid(play(page(2, stealFight), 80)), [{ gold: PLAYER_KILL_REWARD.gold, xp: PLAYER_KILL_REWARD.xp }], 'and the killer all of it')
  assert.deepEqual(play(page(3, stealFight), 80), [], 'and the third, who hit it once it was dead, is told nothing')
})
