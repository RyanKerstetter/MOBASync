import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'

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
