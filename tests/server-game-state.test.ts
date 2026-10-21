import assert from 'node:assert/strict'
import test from 'node:test'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  Champion,
  DEFAULT_CHAMPION_ID,
  FINALIZE_LAG,
  GAME_DEATH_LEAD_TICKS,
  GAME_RESPAWN_TICKS,
  GAME_TPS,
  getChampion,
  type GameDeath,
} from '../packages/shared/src/index.ts'

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

test('server announces a death once, only after the lethal tick is committed', () => {
  const game = new ServerGameState()
  game.begin([{ id: 'player-1', name: 'Player 1' }])
  const targetId = game.getEntityId('player-1')
  assert.ok(targetId)
  const champion = getChampion(DEFAULT_CHAMPION_ID)
  game.simulator.addPlayer(99, 'attacker', 'Attacker', { x: 440, y: 225 }, new Champion({
    ...champion,
    abilities: [...champion.abilities],
    attackSpeed: GAME_TPS,
  }))
  for (let index = 0; index < 12; index += 1) {
    game.simulator.addOrder(99, {
      id: `attack-${index + 1}`, seq: index + 1, tick: index + 1, type: 'attack', targetId,
    })
  }

  const announced: Array<{ at: number; death: GameDeath }> = []
  let healthAtTick11: number | undefined
  for (let tick = 1; tick <= 40; tick += 1) {
    for (const death of game.advanceTick()) announced.push({ at: tick, death })
    if (tick === 12) healthAtTick11 = game.simulator.at(11).get(targetId)?.getHealth()
  }

  // The target reaches 0 health on tick 11 and that tick is committed at tick 11 + FINALIZE_LAG.
  assert.equal(healthAtTick11, 0)
  assert.equal(announced.length, 1)
  const { at, death } = announced[0]
  assert.equal(at, 11 + FINALIZE_LAG)
  assert.deepEqual(death, {
    entityId: targetId,
    tick: at + GAME_DEATH_LEAD_TICKS,
    respawnTick: at + GAME_DEATH_LEAD_TICKS + GAME_RESPAWN_TICKS,
  })
  assert.equal(game.simulator.at(death.tick).get(targetId)?.isDead(), true)
})
