import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState, PICK_SLACK } from '../apps/client/src/game-state.ts'
import { MAX_CLICK_RADIUS } from '../apps/client/src/game-settings.ts'
import { brawler } from './fixtures.ts'

// The extra click radius: how far past the edge of an enemy a click still picks it, for attacks (right click, and holding it) and for abilities aimed at a
// unit. It is a setting of the page, and the simulator knows nothing of it. The champions are the tests' own, and the reach is read from their radius.

const ME = { x: 100, y: 100 }
const ENEMY = { x: 250, y: 100 }

// Player 1 is the local champion; 2 is an enemy a little over the test lash's range from it, 3 a teammate beside the enemy.
function client(): ClientGameState {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', ME, brawler, 1)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', ENEMY, brawler, 2)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  return gameState
}
// A point `away` above the enemy's middle, which is where a click that is a little off lands.
const above = (away: number) => ({ x: ENEMY.x, y: ENEMY.y - away })
const EDGE = brawler.radius + PICK_SLACK

test('with no extra radius an enemy is picked from a little off its edge and not from further', () => {
  const gameState = client()
  assert.equal(gameState.getEnemyNear(above(EDGE), 0)?.id, 2, 'right on the slack every click has')
  assert.equal(gameState.getEnemyNear(above(EDGE + 1), 0), undefined, 'and a pixel past it is the ground')
})

test('the extra radius is added to the reach, to the pixel, for attacks and for abilities aimed at a unit', () => {
  const gameState = client()
  gameState.setExtraPickRadius(12)

  assert.equal(gameState.getEnemyNear(above(EDGE + 12), 0)?.id, 2, 'picked from as far out as the radius says')
  assert.equal(gameState.getEnemyNear(above(EDGE + 13), 0), undefined, 'and not a pixel further')

  // The ability aimed at a unit picks its enemy the same way: refused with nothing under the aim, then ordered when the radius reaches it.
  const aim = above(EDGE + 12)
  const lash = 1
  gameState.setExtraPickRadius(0)
  const without = gameState.createCastOrder(lash, aim, 0)
  assert.equal(without.ok, false)
  assert.match(without.ok ? '' : without.reason, /at an enemy/)
  assert.equal(gameState.getCastPreview(lash, aim, 0)?.target, undefined, 'the indicator has nothing to show either')
  gameState.setExtraPickRadius(12)
  const wide = gameState.createCastOrder(lash, aim, 0)
  assert.ok(wide.ok)
  assert.deepEqual(wide.order.target, { mode: 'unit', unitId: 2 })
  assert.deepEqual(gameState.getCastPreview(lash, aim, 0)?.target, { mode: 'unit', unitId: 2 })
})

test('turning it down again narrows the reach again, and it can be set to none', () => {
  const gameState = client()
  gameState.setExtraPickRadius(MAX_CLICK_RADIUS)
  assert.equal(gameState.getEnemyNear(above(EDGE + MAX_CLICK_RADIUS), 0)?.id, 2)
  gameState.setExtraPickRadius(0)
  assert.equal(gameState.getEnemyNear(above(EDGE + MAX_CLICK_RADIUS), 0), undefined)
  assert.equal(gameState.getEnemyNear(above(EDGE), 0)?.id, 2, 'the slack every click has is still there')
})

test('a radius that is not a number or is below none counts as none', () => {
  const gameState = client()
  for (const odd of [-30, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
    gameState.setExtraPickRadius(odd)
    assert.equal(gameState.getEnemyNear(above(EDGE + 1), 0), undefined, `${odd} widens nothing`)
    assert.equal(gameState.getEnemyNear(above(EDGE), 0)?.id, 2, `and takes nothing from the slack: ${odd}`)
  }
})

test('the wider reach picks the enemy and no one else: not oneself, not a teammate, not one who is not there', () => {
  const gameState = client()
  gameState.simulator.addPlayer(3, 'player-3', 'Player 3', { x: ENEMY.x + 60, y: ENEMY.y }, brawler, 1)
  gameState.simulator.addPlayer(4, 'player-4', 'Player 4', { x: ENEMY.x + 400, y: ENEMY.y }, brawler, 2)
  gameState.simulator.advanceTo(3)
  gameState.setExtraPickRadius(MAX_CLICK_RADIUS)

  assert.equal(gameState.getEnemyNear({ x: ME.x, y: ME.y - EDGE }, 0), undefined, 'not oneself, however wide')
  assert.equal(gameState.getEnemyNear({ x: ENEMY.x + 60, y: ENEMY.y }, 0)?.id, 2, 'the teammate under the click is not picked, and the enemy next to it is, in reach of the radius')
  assert.equal(gameState.getEnemyNear({ x: ENEMY.x + 400, y: ENEMY.y }, 0)?.id, 4, 'each is picked where it stands')
  assert.equal(gameState.getEnemyNear({ x: ENEMY.x + 200, y: ENEMY.y + 300 }, 0), undefined, 'and open ground is open ground')
})

test('of two enemies in reach it is the one whose middle is nearer the click', () => {
  const gameState = client()
  const nearby = { x: ENEMY.x + 2 * brawler.radius, y: ENEMY.y }
  gameState.simulator.addPlayer(3, 'player-3', 'Player 3', nearby, brawler, 2)
  gameState.simulator.advanceTo(3)
  gameState.setExtraPickRadius(MAX_CLICK_RADIUS)
  // Between them, nearer the second.
  assert.equal(gameState.getEnemyNear({ x: ENEMY.x + 1.2 * brawler.radius, y: ENEMY.y }, 0)?.id, 3)
  assert.equal(gameState.getEnemyNear({ x: ENEMY.x + 0.8 * brawler.radius, y: ENEMY.y }, 0)?.id, 2)
})

test('clicking to look at someone is not widened: the radius is for attacks and targeted abilities', () => {
  const gameState = client()
  gameState.setExtraPickRadius(MAX_CLICK_RADIUS)
  assert.equal(gameState.getCharacterNear(above(EDGE + 1), 0), undefined)
  assert.equal(gameState.getCharacterNear(above(EDGE), 0)?.id, 2)
})
