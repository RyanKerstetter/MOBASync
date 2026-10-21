import assert from 'node:assert/strict'
import test from 'node:test'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  Champion,
  FINALIZE_LAG,
  GAME_DEATH_LEAD_TICKS,
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_RESPAWN_TICKS,
  GAME_SPAWN_SPACING,
  GAME_TPS,
  type GameDeath,
} from '../packages/shared/src/index.ts'
import { brawler, cursebearer } from './fixtures.ts'

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

test('players start in a row across the middle of the map, evenly spaced', () => {
  for (const count of [1, 2, 3, 5]) {
    const game = new ServerGameState()
    const players = Array.from({ length: count }, (_, index) => ({ id: `player-${index + 1}`, name: `P${index + 1}` }))
    startGame(game, players, brawler.id)
    const xs = players.map((player) => {
      const id = game.getCharacterId(player.id)
      assert.ok(id)
      const position = game.simulator.at(0).get(id)?.getPosition()
      assert.ok(position)
      assert.equal(position.y, GAME_ARENA_HEIGHT / 2)
      return position.x
    })

    const middle = xs.reduce((sum, x) => sum + x, 0) / count
    assert.equal(middle, GAME_ARENA_WIDTH / 2, `${count} players are centred on the map`)
    xs.slice(1).forEach((x, index) => assert.equal(x - xs[index], GAME_SPAWN_SPACING, 'evenly spaced'))
    assert.ok(xs[0] > 0 && xs[count - 1] < GAME_ARENA_WIDTH, 'all inside the map')
  }
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
