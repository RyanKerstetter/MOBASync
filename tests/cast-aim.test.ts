import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { getAbilityDef } from '../packages/shared/src/index.ts'
import { brawler } from './fixtures.ts'

// Abilities are aimed, not snapped to an enemy: one aimed at a point or in a direction goes where the ground is pointed at, even with the
// pointer over an enemy's body (in 3D a body stands up off the ground, so the pointer can be over it while pointing at the ground behind
// it). Only an ability cast on a unit picks the one the pointer is over.

const ME = { x: 100, y: 100 }
const ENEMY = { x: 250, y: 100 }
const [, LASH, BOLT, METEOR] = [0, 1, 2, 3]

function client(): ClientGameState {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', ME, brawler, 1)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', ENEMY, brawler, 2)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  return gameState
}

// The pointer over the enemy's body, and the ground it points at, beside the enemy and short of the meteor's reach.
function aimBesideEnemy(): { ground: { x: number; y: number }; unit: { x: number; y: number } } {
  const meteor = getAbilityDef(brawler.abilityInSlot(METEOR)!)!
  assert.equal(meteor.targeting, 'point')
  const ground = { x: ME.x + meteor.range / 2, y: ME.y + meteor.range / 3 }
  assert.ok(Math.hypot(ground.x - ENEMY.x, ground.y - ENEMY.y) > brawler.radius * 2, 'the ground pointed at is well off the enemy')
  return { ground, unit: { ...ENEMY } }
}

test('an ability aimed at a point goes to the ground pointed at, not under the enemy the pointer is over', () => {
  const gameState = client()
  const aim = aimBesideEnemy()
  const cast = gameState.createCastOrder(METEOR, aim, 0)
  assert.ok(cast.ok)
  assert.deepEqual(cast.order.target, { mode: 'point', point: aim.ground })
  assert.deepEqual(gameState.getCastPreview(METEOR, aim, 0)?.target, { mode: 'point', point: aim.ground }, 'and the indicator shows it there')
})

test('an ability aimed in a direction goes toward the ground pointed at, not toward the enemy the pointer is over', () => {
  const gameState = client()
  const aim = aimBesideEnemy()
  const toGround = gameState.createCastOrder(BOLT, aim, 0)
  const toEnemy = gameState.createCastOrder(BOLT, aim.unit, 0)
  assert.ok(toGround.ok && toEnemy.ok)
  assert.equal(toGround.order.target.mode, 'direction')
  assert.notDeepEqual(toGround.order.target, toEnemy.order.target)
})

test('an ability cast on a unit still picks the enemy the pointer is over', () => {
  const gameState = client()
  const cast = gameState.createCastOrder(LASH, aimBesideEnemy(), 0)
  assert.ok(cast.ok)
  assert.deepEqual(cast.order.target, { mode: 'unit', unitId: 2 })
})
