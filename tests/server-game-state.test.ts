import assert from 'node:assert/strict'
import test from 'node:test'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  Champion,
  FINALIZE_LAG,
  GAME_DEATH_LEAD_TICKS,
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_MAX_PLAYERS,
  GAME_RESPAWN_TICKS,
  GAME_SPAWN_MARGIN,
  GAME_SPAWN_RADIUS,
  GAME_SPAWN_TEAMMATE_SPACING,
  GAME_TPS,
  type GameDeath,
} from '../packages/shared/src/index.ts'
import { brawler, cursebearer, trinketmaster } from './fixtures.ts'

// Starts a game in which every player picked the same test champion, so these tests do not
// depend on what the real roster or its default happens to be.
function startGame(game: ServerGameState, players: Array<{ id: string; name: string }>, championId: string): void {
  game.beginSelection(players)
  for (const player of players) {
    game.pickChampion(player.id, championId)
    game.lockChampion(player.id)
  }
  game.begin(players)
}

test('server derives attack damage through the shared simulator without health results', () => {
  const game = new ServerGameState()
  startGame(game, [{ id: 'player-1', name: 'Player 1' }, { id: 'player-2', name: 'Player 2' }], brawler.id)
  const attackerId = game.getCharacterId('player-1')
  const targetId = game.getCharacterId('player-2')
  assert.ok(attackerId)
  assert.ok(targetId)
  const champion = brawler
  const attackerStart = game.simulator.at(0).get(attackerId)?.getPosition()
  const targetStart = game.simulator.at(0).get(targetId)?.getPosition()
  assert.ok(attackerStart && targetStart)

  // Players start apart, so the attacker walks up to within reach of the target first.
  const meeting = { x: targetStart.x - champion.attackRange / 2, y: targetStart.y }
  const walk = game.acceptOrder('player-1', { id: 'player-1:1', seq: 1, tick: 1, type: 'move', target: meeting })
  assert.equal(walk.ack.status, 'accepted')
  const walkTicks = Math.ceil((meeting.x - attackerStart.x) / (champion.moveSpeed / GAME_TPS)) + 2
  for (let tick = 1; tick <= walkTicks; tick += 1) game.advanceTick()

  const attackTick = game.simulator.tick + 1
  const verdict = game.acceptOrder('player-1', {
    id: 'player-1:2',
    seq: 2,
    tick: attackTick,
    type: 'attack',
    targetId,
  })
  assert.equal(verdict.ack.status, 'accepted')

  // The auto lands after its windup, so the server does not announce any health result.
  const landing = attackTick + champion.attackWindupTicks
  while (game.simulator.tick < landing) game.advanceTick()

  const target = game.simulator.at(landing).get(targetId)
  assert.equal(target?.getHealth(), champion.maxHp - champion.attackDamage)
})

// Starts a game with a player on each of these teams and gives back where each began.
function startTeams(teams: number[]): { game: ServerGameState; ids: number[]; at: Array<{ x: number; y: number }> } {
  const game = new ServerGameState()
  const players = teams.map((team, index) => ({ id: `player-${index + 1}`, name: `P${index + 1}`, team }))
  startGame(game, players, brawler.id)
  const ids = players.map((player) => game.getCharacterId(player.id) as number)
  const at = ids.map((id) => game.simulator.at(0).get(id)?.getPosition() as { x: number; y: number })
  return { game, ids, at }
}

const MIDDLE = { x: GAME_ARENA_WIDTH / 2, y: GAME_ARENA_HEIGHT / 2 }
const apart = (left: { x: number; y: number }, right: { x: number; y: number }): number =>
  Math.hypot(left.x - right.x, left.y - right.y)

test('teams start spread round the middle of the map, and teammates start next to each other', () => {
  const layouts = [
    [1, 1, 2, 2],
    [1, 2, 1, 2],
    [1, 1, 1, 1, 2, 2, 2, 2],
    [1, 1, 1, 2],
    [1, 1, 2, 2, 3, 3],
    [1, 2, 3, 4, 5, 6, 7, 8],
    [3, 3, 1, 1, 2],
  ]
  for (const teams of layouts) {
    const { at } = startTeams(teams)
    const label = teams.join('')

    // Everyone stands on the circle round the middle, well in from the edge of the map.
    at.forEach((position) => {
      assert.ok(Math.abs(apart(position, MIDDLE) - GAME_SPAWN_RADIUS) < 1, `${label}: on the circle`)
      assert.ok(position.x >= GAME_SPAWN_MARGIN - 1 && position.x <= GAME_ARENA_WIDTH - GAME_SPAWN_MARGIN + 1)
      assert.ok(position.y >= GAME_SPAWN_MARGIN - 1 && position.y <= GAME_ARENA_HEIGHT - GAME_SPAWN_MARGIN + 1)
    })
    // Nobody starts on top of anybody.
    at.forEach((position, index) => at.slice(index + 1).forEach((other) => {
      assert.ok(apart(position, other) > 2 * brawler.radius, `${label}: nobody overlaps`)
    }))
    // A player's nearest neighbour is a teammate, and teammates stand a set distance apart.
    teams.forEach((team, index) => {
      const mates = teams.flatMap((other, position) => (other === team && position !== index ? [position] : []))
      const strangers = teams.flatMap((other, position) => (other !== team ? [position] : []))
      if (mates.length === 0) return
      const nearestMate = Math.min(...mates.map((position) => apart(at[index], at[position])))
      const nearestStranger = Math.min(...strangers.map((position) => apart(at[index], at[position])))
      assert.ok(nearestMate < nearestStranger, `${label}: player ${index + 1} starts next to a teammate`)
      assert.ok(Math.abs(nearestMate - GAME_SPAWN_TEAMMATE_SPACING) < 3, `${label}: and a set distance from them`)
    })
  }
})

test('each team gets an equal slice of the circle, in order, and a team is the same wherever its players are listed', () => {
  // Two teams face each other across the middle, one on each side: the first to the west.
  const two = startTeams([1, 1, 2, 2]).at
  const meanX = (positions: Array<{ x: number }>) => positions.reduce((sum, position) => sum + position.x, 0) / positions.length
  assert.ok(meanX(two.slice(0, 2)) < MIDDLE.x && meanX(two.slice(2)) > MIDDLE.x)
  assert.ok(Math.abs(meanX(two.slice(0, 2)) + meanX(two.slice(2)) - 2 * MIDDLE.x) < 2, 'and they are opposite')

  // Four teams of one are a quarter of the way round from each other.
  const four = startTeams([1, 2, 3, 4]).at
  const angle = (position: { x: number; y: number }) => Math.atan2(position.y - MIDDLE.y, position.x - MIDDLE.x)
  for (let index = 0; index < 4; index += 1) {
    const turn = (angle(four[(index + 1) % 4]) - angle(four[index]) + 4 * Math.PI) % (2 * Math.PI)
    assert.ok(Math.abs(turn - Math.PI / 2) < 0.01, `team ${index + 1} to the next is a quarter turn`)
  }

  // Listing the players in a different order puts each team in the same place.
  const grouped = startTeams([1, 1, 2, 2]).at
  const mixed = startTeams([1, 2, 1, 2]).at
  assert.ok(apart(grouped[0], mixed[0]) < 1.5 && apart(grouped[1], mixed[2]) < 1.5, 'team 1 is where it was')
  assert.ok(apart(grouped[2], mixed[1]) < 1.5 && apart(grouped[3], mixed[3]) < 1.5, 'and so is team 2')
})

test('the server keeps each player\'s team on their character and in the snapshot, and a player with none is alone', () => {
  const { game, ids } = startTeams([2, 2, 5])
  assert.deepEqual(ids.map((id) => game.simulator.characters.get(id)?.team), [2, 2, 5])
  assert.deepEqual(game.snapshot().characters.map((character) => character.team), [2, 2, 5])

  // With no team given, each player is on a team of their own, so everyone is an enemy.
  const alone = new ServerGameState()
  startGame(alone, [{ id: 'player-1', name: 'One' }, { id: 'player-2', name: 'Two' }], brawler.id)
  const teams = [1, 2].map((id) => alone.simulator.characters.get(id)?.team)
  assert.equal(new Set(teams).size, 2)
})

test('a full lobby picks, loads and starts together, with every character in its own spot', () => {
  const game = new ServerGameState()
  const players = Array.from({ length: GAME_MAX_PLAYERS }, (_, index) => ({ id: `player-${index + 1}`, name: `P${index + 1}` }))
  startGame(game, players, brawler.id)

  const characterIds = players.map((player) => game.getCharacterId(player.id))
  assert.equal(new Set(characterIds).size, GAME_MAX_PLAYERS, 'each player has a character of their own')
  for (const player of players.slice(0, -1)) {
    assert.equal(game.markReady(player.id), true)
    assert.equal(game.startIfReady(), undefined, 'the game waits for the last player')
  }
  assert.equal(game.markReady(players[players.length - 1].id), true)
  const snapshot = game.startIfReady()

  assert.equal(game.status, 'running')
  assert.equal(snapshot?.characters.length, GAME_MAX_PLAYERS)
  const spots = new Set(snapshot?.characters.map(({ initialPosition }) => `${initialPosition.x},${initialPosition.y}`))
  assert.equal(spots.size, GAME_MAX_PLAYERS, 'nobody starts on top of anybody')
})

test('server announces a death once, only after the lethal tick is committed', () => {
  const game = new ServerGameState()
  startGame(game, [{ id: 'player-1', name: 'Player 1' }], brawler.id)
  const targetId = game.getCharacterId('player-1')
  assert.ok(targetId)
  const target = brawler
  const targetAt = game.simulator.at(0).get(targetId)?.getPosition()
  assert.ok(targetAt)
  game.simulator.addPlayer(99, 'attacker', 'Attacker', { x: targetAt.x + 40, y: targetAt.y }, new Champion({
    ...brawler,
    abilities: [...brawler.abilities],
    attackSpeed: GAME_TPS,
  }))
  const hitsToKill = Math.ceil(target.maxHp / brawler.attackDamage)
  for (let index = 0; index < hitsToKill + 4; index += 1) {
    game.simulator.addOrder(99, {
      id: `attack-${index + 1}`, seq: index + 1, tick: index + 1, type: 'attack', targetId,
    })
  }

  const announced: Array<{ at: number; death: GameDeath }> = []
  let healthAtLethalTick: number | undefined
  for (let tick = 1; tick <= 30; tick += 1) {
    for (const death of game.advanceTick()) announced.push({ at: tick, death })
    if (tick === hitsToKill + 1) healthAtLethalTick = game.simulator.at(hitsToKill).get(targetId)?.getHealth()
  }

  // The target reaches 0 health on the last hit and that tick is committed FINALIZE_LAG later.
  assert.equal(healthAtLethalTick, 0)
  assert.equal(announced.length, 1)
  const { at, death } = announced[0]
  assert.equal(at, hitsToKill + FINALIZE_LAG)
  assert.deepEqual(death, {
    characterId: targetId,
    tick: at + GAME_DEATH_LEAD_TICKS,
    respawnTick: at + GAME_DEATH_LEAD_TICKS + GAME_RESPAWN_TICKS,
  })
  assert.equal(game.simulator.at(death.tick).get(targetId)?.isDead(), true)
})

test('the server accepts the recast of an ability the champion has, and still refuses ones it does not', () => {
  const game = new ServerGameState()
  startGame(game, [{ id: 'player-1', name: 'Player 1' }, { id: 'player-2', name: 'Player 2' }], trinketmaster.id)
  const characterId = game.getCharacterId('player-1')
  assert.ok(characterId)
  const origin = game.simulator.at(0).get(characterId)?.getPosition()
  assert.ok(origin)
  const cast = (abilityId: string, seq: number) => game.acceptOrder('player-1', {
    id: `player-1:${seq}`, seq, tick: seq, type: 'cast', abilityId, target: { mode: 'none' }, origin,
  }).ack

  // The recall is on no key, but it is the trinketmaster's.
  assert.equal(cast('t-recall', 1).status, 'accepted')
  const refused = cast('t-meteor', 2)
  assert.deepEqual([refused.status, refused.reason], ['rejected', 'unknown_ability'])
})

test('champion select starts the game with each player\'s locked pick', () => {
  const game = new ServerGameState()
  const players = [{ id: 'player-1', name: 'Player 1' }, { id: 'player-2', name: 'Player 2' }]

  assert.equal(game.beginSelection(players), true)
  assert.equal(game.status, 'selecting')
  assert.equal(game.beginSelection(players), false, 'select cannot restart while it is open')
  assert.equal(game.pickChampion('player-1', 'nobody'), false, 'unknown champions are refused')
  assert.equal(game.pickChampion('stranger', cursebearer.id), false)
  assert.equal(game.pickChampion('player-1', cursebearer.id), true)
  assert.equal(game.pickChampion('player-2', brawler.id), true)

  assert.equal(game.lockChampion('player-1'), true)
  assert.equal(game.allChampionsLocked(), false)
  assert.equal(game.pickChampion('player-1', brawler.id), false, 'a locked pick cannot change')
  assert.equal(game.lockChampion('player-2'), true)
  assert.equal(game.allChampionsLocked(), true)

  game.begin(players)
  assert.equal(game.status, 'starting')
  const championIds = game.snapshot().characters.map((character) => character.championId)
  assert.deepEqual(championIds, [cursebearer.id, brawler.id])
  assert.equal(game.selections.size, 0)
})

test('champion select ends when a player leaves or the selection is cancelled', () => {
  const game = new ServerGameState()
  game.beginSelection([{ id: 'player-1', name: 'Player 1' }, { id: 'player-2', name: 'Player 2' }])
  game.lockChampion('player-1')
  assert.equal(game.allChampionsLocked(), false)

  game.removePlayer('player-2')
  assert.equal(game.allChampionsLocked(), true, 'the remaining player is the only one left to lock')

  game.cancelStart()
  assert.equal(game.status, 'idle')
  assert.equal(game.selections.size, 0)
  assert.equal(game.pickChampion('player-1', cursebearer.id), false)
})
