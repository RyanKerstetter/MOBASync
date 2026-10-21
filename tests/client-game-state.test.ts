import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  Champion,
  GAME_TPS,
  getAbilityDef,
  getChampion,
  type ChampionDef,
} from '../packages/shared/src/index.ts'
import { brawler, spouter } from './fixtures.ts'

function championDef(champion: Champion): ChampionDef {
  return { ...champion, abilities: [...champion.abilities] }
}

test('rendering clamps an outdated estimate to the latest computed snapshot', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 })
  gameState.setLocalCharacterId(1)
  for (let tick = 1; tick <= 20; tick += 1) gameState.simulator.at(tick)

  const characters = gameState.getCharacters(0)

  assert.equal(characters.length, 1)
  assert.deepEqual(characters[0].position, { x: 100, y: 100 })
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
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 }, brawler)

  assert.equal(gameState.simulator.addOrder(1, {
    id: 'player-1:1',
    seq: 1,
    tick: 1,
    type: 'attack',
    targetId: 2,
  }), true)

  const target = gameState.simulator.at(1).get(2)
  assert.equal(target?.getHealth(), 900)
})

test('resetting the tick anchor at game start keeps order ticks inside the server window', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 })
  gameState.setLocalCharacterId(1)
  // The server tick stays at 0 while lobbies load, but the local estimate keeps advancing.
  gameState.setServerTick(0, 0)

  gameState.resetServerTickAnchor(0, 5000)
  const order = gameState.createMoveOrder({ x: 300, y: 100 }, 5000)

  assert.ok(order)
  assert.ok(order.tick <= 1)
})

test('ability cooldowns count down continuously between whole ticks', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler)
  gameState.setLocalCharacterId(1)
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
    ...championDef(brawler),
    attackSpeed: GAME_TPS,
  }))
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 }, brawler)
  gameState.setLocalCharacterId(2)
  for (let index = 0; index < 12; index += 1) {
    gameState.simulator.addOrder(1, {
      id: `attack-${index + 1}`, seq: index + 1, tick: index + 1, type: 'attack', targetId: 2,
    })
  }
  gameState.simulator.at(12)

  const predicted = gameState.getCharacters(0).find((character) => character.id === 2)
  assert.equal(predicted?.health?.hp, 0)
  assert.equal(predicted?.dead, false)
  assert.equal(gameState.isLocalDead(0), false)

  const death = { characterId: 2, tick: 14, respawnTick: 44 }
  assert.equal(gameState.applyDeath(death), true)
  gameState.simulator.at(14)
  assert.equal(gameState.applyDeath(death), true, 'a repeated message is not an error')
  assert.equal(gameState.getCharacters(0).find((character) => character.id === 2)?.dead, true)
  assert.equal(gameState.isLocalDead(0), true)

  gameState.simulator.at(44)
  assert.equal(gameState.applyDeath({ characterId: 2, tick: 5, respawnTick: 9 }), false)
  assert.equal(gameState.isLocalDead(0), false)
})

function createArcherClient(): ClientGameState {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, getChampion('t-archer'))
  // Just past the archer's own range, inside the extra reach focus gives.
  const gap = getChampion('t-archer').attackRange + 60
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 100 + gap, y: 100 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  return gameState
}

test('the attack range ring and enemy search include the focus range bonus', () => {
  const gameState = createArcherClient()
  const archer = getChampion('t-archer')
  gameState.simulator.at(3)
  assert.equal(gameState.getLocalAttackRange(0), archer.attackRange)
  assert.equal(gameState.getClosestEnemyInRange(0), undefined, 'the enemy is just out of range')

  gameState.simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 4, type: 'cast', abilityId: 't-focus', target: { mode: 'none' }, origin: { x: 100, y: 100 },
  })
  gameState.simulator.at(6)
  assert.equal(gameState.getLocalAttackRange(0), archer.attackRange + 120)
  assert.equal(gameState.getClosestEnemyInRange(0)?.id, 2)
})

test('the local character is drawn between ticks while dashing, and does not overshoot its target', () => {
  const step = 600 / GAME_TPS
  const reach = Math.round(120 * 0.8)
  const gameState = createArcherClient()
  gameState.simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-leap',
    target: { mode: 'point', point: { x: 100 + reach, y: 100 } }, origin: { x: 100, y: 100 },
  })
  const atTick = (tick: number): number => tick * 1000 / GAME_TPS
  const positionAt = (now: number): number =>
    gameState.getCharacters(now).find((character) => character.id === 1)?.position.x ?? 0

  // Tick 5 is four whole steps along; half a tick later it is half a step further.
  assert.ok(Math.abs(positionAt(atTick(5)) - (100 + step * 4)) < 1e-6)
  assert.ok(Math.abs(positionAt(atTick(5.5)) - (100 + step * 4.5)) < 1e-6)
  // Once it has arrived there is nothing left to extrapolate.
  const landing = 1 + Math.ceil(reach / step)
  assert.equal(positionAt(atTick(landing + 0.5)), 100 + reach)
})

test('the later bubbles of a volley are not drawn until their turn', () => {
  const capricorn = getChampion('t-capricorn')
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, capricorn)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 700, y: 400 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  gameState.simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-bubbles',
    target: { mode: 'direction', dir: { x: 1, y: 0 } }, origin: { x: 100, y: 100 },
  })
  const bubbles = getAbilityDef('t-bubbles')
  assert.ok(bubbles)
  const launch = 1 + bubbles.windUpTicks
  const drawn = (tick: number): number => gameState.getEntities(tick * 1000 / GAME_TPS).length

  assert.equal(drawn(launch), 1, 'only the first bubble is out at launch')
  assert.equal(drawn(launch + 5), 2)
  assert.equal(drawn(launch + 2 * 5), 3)
})

test('a rectangular entity reaches the renderer with its shape and heading', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, getChampion('t-capricorn'))
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 700, y: 400 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  gameState.simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-tsunami',
    target: { mode: 'direction', dir: { x: 0, y: 1 } }, origin: { x: 100, y: 100 },
  })
  const tsunami = getAbilityDef('t-tsunami')
  assert.ok(tsunami)

  const wave = gameState.getEntities((1 + tsunami.windUpTicks + 1) * 1000 / GAME_TPS)[0]
  assert.deepEqual(wave?.box, { halfLength: 40 / 2, halfWidth: 150 / 2 })
  assert.deepEqual(wave?.facing, { x: 0, y: 1 })
})

test('a telegraph reports how far its warning has run, so the client can fill it in', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 225 }, spouter)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 700, y: 400 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  gameState.simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-spout',
    target: { mode: 'point', point: { x: 400, y: 225 } }, origin: { x: 100, y: 225 },
  })
  const spout = getAbilityDef('t-spout')
  assert.ok(spout)
  const launch = 1 + spout.windUpTicks
  const warningAt = (tick: number) => gameState.getEntities(tick * 1000 / GAME_TPS)[0]

  assert.equal(warningAt(launch)?.visual, 'telegraph')
  assert.ok(Math.abs((warningAt(launch)?.progress ?? 1) - 0) < 1e-9, 'it starts empty')
  // The warning lasts 42 ticks and goes off on the one after, so 43 ticks fill it.
  assert.ok(Math.abs((warningAt(launch + 21)?.progress ?? 0) - 21 / 43) < 1e-9, 'half way along')
  assert.ok((warningAt(launch + 42)?.progress ?? 0) > 0.97, 'nearly full just before it goes off')
})
