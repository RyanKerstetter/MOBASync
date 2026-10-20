import assert from 'node:assert/strict'
import test from 'node:test'
import { ServerGameState } from '../apps/server/src/game-state.ts'

test('server derives attack damage through the shared simulator without health results', () => {
  const game = new ServerGameState()
  game.begin(Array.from({ length: 5 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
  })))
  const attackerId = game.getEntityId('player-1')
  const targetId = game.getEntityId('player-2')
  assert.ok(attackerId)
  assert.ok(targetId)

  const verdict = game.acceptOrder('player-1', {
    id: 'player-1:1',
    seq: 1,
    tick: 1,
    type: 'attack',
    targetId,
  })
  assert.equal(verdict.ack.status, 'accepted')

  game.advanceTick()

  const target = game.simulator.at(1).get(targetId)
  assert.equal(target?.getShield(), 0)
  assert.equal(target?.getHealth(), 10)
})
