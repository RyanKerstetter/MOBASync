import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState, type RenderedCharacter } from '../apps/client/src/game-state.ts'
import type { Graphics } from 'pixi.js'
import {
  layoutTurretRings,
  TURRET_RING_EDGE_ALPHA,
  TURRET_RING_EDGE_WIDTH,
  TurretRangeLayer,
} from '../apps/client/src/render/turret-range.ts'
import { getTeam, GAME_MONSTER_TEAM } from '../packages/shared/src/index.ts'
import { brawler, defineChampion, defineTurret } from './fixtures.ts'

// How the page shows turrets: what a turret is to the page, the transparent circle that marks the end of its range, and what it lets the
// player aim at and read off the boards. (What it does in the game is in tests/turrets.test.ts, and what it does to what the team sees is
// in tests/team-vision.test.ts.)

const post = defineTurret(81, {
  base: { maxHp: 2000, attackDamage: 50, attackSpeed: 1 },
  radius: 30,
  attackRange: 400,
  visionRange: 450,
  attackWindupTicks: 0,
})
const soft = defineTurret(82, {
  base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 },
  radius: 30,
  attackRange: 400,
  attackWindupTicks: 0,
})
const slayer = defineChampion({ ...brawler, id: 't-tr-slayer', base: { ...brawler.base, attackDamage: 5000 }, abilities: [] })

const AT = { x: 1000, y: 700 }

// The turret of team 1 is 10, Ann (team 1) is 1 and Bob (team 2) is 2, far from it.
function game(): ClientGameState {
  const state = new ClientGameState()
  state.simulator.addTurret(10, post, AT, 1)
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 200, y: 200 }, brawler, 1)
  state.simulator.addPlayer(2, 'p2', 'Bob', { x: 1900, y: 1200 }, brawler, 2)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  return state
}

// ---------------------------------------------------------------------------- what a turret is to the page

test('a turret has its tier, how far it sees and its reach, and is neither a player nor a monster', () => {
  const characters = game().getCharacters(0)
  const turret = characters.find((character) => character.id === 10)
  assert.equal(turret?.name, 'Tier 81 Turret', 'it is called by its tier, for the killfeed')
  assert.deepEqual(turret?.turret, { tier: 81, visionRange: 450 })
  assert.equal(turret?.player, undefined)
  assert.equal(turret?.monster, undefined)
  assert.equal(turret?.attackRange, 400)
  assert.equal(turret?.team, 1)
  assert.equal(turret?.dead, false)
  assert.deepEqual(turret?.position, AT)
  for (const id of [1, 2]) assert.equal(characters.find((character) => character.id === id)?.turret, undefined, 'a player is no turret')
})

test('a turret of the other team can be clicked on and attacked, and one of your own cannot', () => {
  const state = game()
  // Ann is on the turret's team: it is no enemy of hers.
  assert.equal(state.getEnemyNear(AT, 0), undefined)
  assert.equal(state.getClosestEnemy(AT, 0)?.id, 2, 'Space picks Bob, who is the only enemy she has')
  // Bob is not: it is under the pointer, and the nearest enemy to it.
  state.setLocalCharacterId(2)
  assert.equal(state.getEnemyNear(AT, 0)?.id, 10)
  assert.equal(state.getEnemyNear({ x: AT.x + 35, y: AT.y }, 0)?.id, 10, 'anywhere over its body, which is 30 across from its middle')
  assert.equal(state.getEnemyNear({ x: AT.x + 60, y: AT.y }, 0), undefined)
  assert.equal(state.getClosestEnemy({ x: 1000, y: 650 }, 0)?.id, 10)
  assert.ok(state.createAttackOrder(10, 0), 'and an attack order can be given on it')
})

test('turrets are not on the leaderboard or the team scores, and one is in the killfeed when it is destroyed', () => {
  const state = game()
  state.simulator.addTurret(11, post, { x: 1000, y: 1000 }, GAME_MONSTER_TEAM - 1)
  assert.deepEqual(state.getLeaderboard().map((row) => row.name), ['Ann', 'Bob'])
  assert.deepEqual(state.getModeView(0).scores.map((score) => score.team).sort(), [1, 2], 'two teams, and not the turret\'s')

  const fight = new ClientGameState()
  fight.simulator.addTurret(10, soft, AT, 1)
  fight.simulator.addPlayer(1, 'p1', 'Ann', { x: 1150, y: 700 }, slayer, 2)
  fight.setLocalCharacterId(1)
  fight.simulator.addOrder(1, { id: '1:1', seq: 1, tick: 2, type: 'attack', targetId: 10 })
  for (let tick = 1; tick <= 40; tick += 1) {
    fight.simulator.advanceTo(tick)
    if (tick > 12) fight.simulator.setCommitTick(tick - 12)
  }
  const [line] = fight.getKillFeed(performance.now())
  assert.deepEqual([line?.killer?.name, line?.victim.name, line?.victim.team], ['Ann', 'Tier 82 Turret', 1])
})

// ---------------------------------------------------------------------------- the circle round it

test('a standing turret has a ring round it that reaches out to its range, in its team\'s colour', () => {
  const characters = game().getCharacters(0)
  assert.deepEqual(layoutTurretRings(characters), [{ x: AT.x, y: AT.y, radius: 400, color: getTeam(1).color }], 'one, for the turret and no one else')
  // It is the range the turret has now: with more reach it is wider.
  const turret = characters.find((character) => character.id === 10) as RenderedCharacter
  assert.equal(layoutTurretRings([{ ...turret, attackRange: 450 }])[0].radius, 450)
  // It is round the turret wherever the turret is drawn, and the colour is its team's.
  const moved = layoutTurretRings([{ ...turret, position: { x: 5, y: 6 }, team: 2 }])[0]
  assert.deepEqual([moved.x, moved.y, moved.color], [5, 6, getTeam(2).color])
})

test('a turret that is destroyed has no ring, and neither has anything that is not a turret', () => {
  const characters = game().getCharacters(0)
  const turret = characters.find((character) => character.id === 10) as RenderedCharacter
  assert.deepEqual(layoutTurretRings([{ ...turret, dead: true }]), [])
  assert.deepEqual(layoutTurretRings(characters.filter((character) => !character.turret)), [], 'players have none')
  assert.deepEqual(layoutTurretRings([]), [])
  assert.deepEqual(layoutTurretRings([{ ...turret, attackRange: 0 }]), [], 'and one that reaches nowhere has no circle')
})

test('only the ring on the outside is drawn, with nothing filled in, and it is faint', () => {
  const layer = new TurretRangeLayer()
  layer.update(game().getCharacters(0))
  const drawn = (layer.view.children[0] as Graphics).context.instructions.map((instruction) => instruction.action)
  assert.deepEqual(drawn, ['stroke'], 'one circle, as a line, and not filled')
  // Two turrets are two lines, and still no fill.
  const two = game()
  two.simulator.addTurret(11, post, { x: 1500, y: 900 }, 1)
  two.simulator.advanceTo(4)
  layer.update(two.getCharacters(0))
  assert.deepEqual((layer.view.children[0] as Graphics).context.instructions.map((instruction) => instruction.action), ['stroke', 'stroke'])
  layer.update([])
  assert.deepEqual((layer.view.children[0] as Graphics).context.instructions, [], 'and none when there is no turret')
  assert.ok(TURRET_RING_EDGE_ALPHA > 0 && TURRET_RING_EDGE_ALPHA <= 0.3, 'the line is faint, and fainter than it was (0.5)')
  assert.ok(TURRET_RING_EDGE_WIDTH > 0 && TURRET_RING_EDGE_WIDTH <= 3, 'and thin')
})
