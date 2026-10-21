import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  Champion,
  DEFAULT_CHAMPION_ID,
  GAME_TPS,
  getChampion,
  type ChampionDef,
} from '../packages/shared/src/index.ts'

function championDef(champion: Champion): ChampionDef {
  return { ...champion, abilities: [...champion.abilities] }
}

test('rendering clamps an outdated estimate to the latest computed snapshot', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 })
  gameState.setLocalEntityId(1)
  for (let tick = 1; tick <= 20; tick += 1) gameState.simulator.at(tick)

  const entities = gameState.getEntities(0)

  assert.equal(entities.length, 1)
  assert.deepEqual(entities[0].position, { x: 100, y: 100 })
  assert.equal(gameState.getAttackCooldownProgress(0), 1)
  assert.deepEqual(gameState.getDebugInfo(0).localPosition, { x: 100, y: 100 })
})

test('a pong behind computed snapshots does not request an evicted frame', () => {
  const gameState = new ClientGameState()
  for (let tick = 1; tick <= 20; tick += 1) gameState.simulator.at(tick)

  gameState.recordPong(1000, 10, 1000)

  assert.equal(gameState.simulator.tick, 20)
})

test('client derives health changes from its local attack order', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 })
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 })

  assert.equal(gameState.simulator.addOrder(1, {
    id: 'player-1:1',
    seq: 1,
    tick: 1,
    type: 'attack',
    targetId: 2,
  }), true)

  const target = gameState.simulator.at(1).get(2)
  assert.equal(target?.getShield(), 0)
  assert.equal(target?.getHealth(), 10)
})

test('resetting the tick anchor at game start keeps order ticks inside the server window', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 })
  gameState.setLocalEntityId(1)
  // The server tick stays at 0 while lobbies load, but the local estimate keeps advancing.
  gameState.setServerTick(0, 0)

  gameState.resetServerTickAnchor(0, 5000)
  const order = gameState.createMoveOrder({ x: 300, y: 100 }, 5000)

  assert.ok(order)
  assert.ok(order.tick <= 1)
})

test('ability cooldowns count down continuously between whole ticks', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 })
  gameState.setLocalEntityId(1)
  gameState.resetServerTickAnchor(0, 0)
  const order = gameState.createCastOrder(0, { x: 100, y: 100 }, 'player-1', 0)
  assert.ok(order.ok)
  gameState.simulator.advanceTo(20)

  const remaining = [1000, 1004, 1008, 1012].map((now) => {
    gameState.resetServerTickAnchor(0, 1000 - 20 * 1000 / 60)
    return gameState.getAbilityCooldowns(now)[0].ticksRemaining
  })
  const steps = remaining.slice(1).map((value, index) => remaining[index] - value)

  assert.ok(steps.every((step) => step > 0 && step < 0.5), `steps ${steps}`)
})

test('client only shows a death once the server confirms it', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, new Champion({
    ...championDef(getChampion(DEFAULT_CHAMPION_ID)),
    attackSpeed: GAME_TPS,
  }))
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 })
  gameState.setLocalEntityId(2)
  for (let index = 0; index < 12; index += 1) {
    gameState.simulator.addOrder(1, {
      id: `attack-${index + 1}`, seq: index + 1, tick: index + 1, type: 'attack', targetId: 2,
    })
  }
  gameState.simulator.at(12)

  const predicted = gameState.getEntities(0).find((entity) => entity.id === 2)
  assert.equal(predicted?.health?.hp, 0)
  assert.equal(predicted?.dead, false)
  assert.equal(gameState.isLocalDead(0), false)

  const death = { entityId: 2, tick: 14, respawnTick: 44 }
  assert.equal(gameState.applyDeath(death), true)
  gameState.simulator.at(14)
  assert.equal(gameState.applyDeath(death), true, 'a repeated message is not an error')
  assert.equal(gameState.getEntities(0).find((entity) => entity.id === 2)?.dead, true)
  assert.equal(gameState.isLocalDead(0), true)

  gameState.simulator.at(44)
  assert.equal(gameState.applyDeath({ entityId: 2, tick: 5, respawnTick: 9 }), false)
  assert.equal(gameState.isLocalDead(0), false)
})
