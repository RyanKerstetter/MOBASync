import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Champion,
  GameSnapshotSchema,
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_TPS,
  Simulator,
  type ChampionDef,
  type CharacterOrder,
} from '../packages/shared/src/index.js'
import { brawler } from './fixtures.js'

// Tests derive travel distances from the champion so rebalancing move speed does not break them.
const SPEED = brawler.moveSpeed

function championDef(champion: Champion): ChampionDef {
  return { ...champion, abilities: [...champion.abilities] }
}

function assertPositionClose(
  actual: { x: number; y: number } | undefined,
  expected: { x: number; y: number },
): void {
  assert.ok(actual)
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9, `x ${actual.x} != ${expected.x}`)
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9, `y ${actual.y} != ${expected.y}`)
}

function createSimulator(orders: CharacterOrder[]): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 }, brawler)
  for (const order of orders) simulator.addOrder(1, order)
  return simulator
}

test('orders resolve identically regardless of arrival order', () => {
  const orders: CharacterOrder[] = [
    { id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 500, y: 100 } },
    { id: 'attack-2', seq: 2, tick: 3, type: 'attack', targetId: 2 },
    { id: 'move-3', seq: 3, tick: 2, type: 'move', target: { x: 700, y: 100 } },
  ]
  const chronological = createSimulator(orders)
  const reversed = createSimulator([...orders].reverse())

  assert.deepEqual(
    reversed.at(10).get(1)?.getPosition(),
    chronological.at(10).get(1)?.getPosition(),
  )
  assert.deepEqual(
    reversed.characters.get(1)?.orders.map(({ id }) => id),
    ['move-1', 'move-3', 'attack-2'],
  )
})

test('an attack stops movement at its derived position', () => {
  const simulator = createSimulator([
    { id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 500, y: 100 } },
    { id: 'attack-2', seq: 2, tick: 3, type: 'attack', targetId: 2 },
  ])

  const attackFrame = simulator.at(3)
  assertPositionClose(attackFrame.get(1)?.getPosition(), { x: 100 + SPEED * 2 / 60, y: 100 })
  assert.deepEqual(attackFrame.get(1)?.getCooldown(), {
    ready: false,
    ticksRemaining: GAME_TPS,
  })
  assert.deepEqual(simulator.at(20).get(1)?.getPosition(), attackFrame.get(1)?.getPosition())
})

test('an out-of-range attack does not stop movement or start cooldown', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 400, y: 100 }, brawler)
  simulator.addOrder(1, {
    id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 700, y: 100 },
  })
  simulator.addOrder(1, {
    id: 'attack-2', seq: 2, tick: 3, type: 'attack', targetId: 2,
  })

  const state = simulator.at(20).get(1)
  assertPositionClose(state?.getPosition(), { x: 100 + SPEED * 19 / 60, y: 100 })
  assert.equal(state?.getNextAttackTick(), 0)
  assert.equal(simulator.at(20).get(2)?.getHealth(), 1000)
})

test('an invalid cooldown attack does not stop a later movement order', () => {
  const simulator = createSimulator([
    { id: 'attack-1', seq: 1, tick: 1, type: 'attack', targetId: 2 },
    { id: 'move-2', seq: 2, tick: 2, type: 'move', target: { x: 700, y: 100 } },
    { id: 'attack-3', seq: 3, tick: 2, type: 'attack', targetId: 2 },
  ])

  assert.equal(simulator.at(1).get(1)?.getCooldown().ready, false)
  assert.equal(simulator.at(2).get(1)?.getCooldown().ticksRemaining, 59)
  const state = simulator.at(20).get(1)
  assertPositionClose(state?.getPosition(), { x: 100 + SPEED * 18 / 60, y: 100 })
  assert.equal(state?.getNextAttackTick(), 61)
})

test('a late order invalidates and recomputes cached snapshots after its tick', () => {
  const simulator = createSimulator([
    { id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 700, y: 100 } },
  ])
  const before = simulator.at(10)
  assertPositionClose(before.get(1)?.getPosition(), { x: 100 + SPEED * 9 / 60, y: 100 })

  assert.equal(simulator.addOrder(1, {
    id: 'move-2', seq: 2, tick: 5, type: 'move', target: { x: 300, y: 100 },
  }), true)

  const after = simulator.at(10)
  assert.notEqual(after, before)
  assertPositionClose(after.get(1)?.getPosition(), { x: 100 + SPEED * 9 / 60, y: 100 })
})

test('snapshots restore from the committed checkpoint and replay newer orders', () => {
  const original = createSimulator([
    { id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 700, y: 100 } },
    { id: 'move-2', seq: 2, tick: 7, type: 'move', target: { x: 400, y: 100 } },
  ])
  original.advanceTo(10)
  original.setCommitTick(5)
  const expectedPosition = original.at(10).get(1)?.getPosition()
  const expectedNextPosition = original.at(11).get(1)?.getPosition()
  const snapshot = original.snapshot()
  assert.equal(snapshot.checkpoint.tick, 5)
  assert.deepEqual(snapshot.characters[0]?.orders.map((order) => order.id), ['move-2'])
  assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)
  const restored = new Simulator()
  restored.replaceFromSnapshot(snapshot)

  assert.deepEqual(restored.at(10).get(1)?.getPosition(), expectedPosition)
  assertPositionClose(restored.at(5).get(1)?.getPosition(), { x: 100 + SPEED * 4 / 60, y: 100 })
  assert.deepEqual(restored.at(11).get(1)?.getPosition(), expectedNextPosition)
})

test('shared simulation derives health damage from valid attack orders', () => {
  const orders: CharacterOrder[] = [
    { id: 'attack-1', seq: 1, tick: 1, type: 'attack', targetId: 2 },
    { id: 'attack-2', seq: 2, tick: 61, type: 'attack', targetId: 2 },
  ]
  const firstPeer = createSimulator(orders)
  const secondPeer = createSimulator(orders)

  const firstHit = firstPeer.at(1).get(2)?.getHealthState()
  assert.equal(firstHit?.hp, 900)

  const secondHit = firstPeer.at(61).get(2)?.getHealthState()
  assert.equal(secondHit?.hp, 800)
  assert.deepEqual(
    secondPeer.at(61).get(2)?.getHealthState(),
    secondHit,
  )
})

test('valid attacks apply damage and enforce cooldown in simulator snapshots', () => {
  const simulator = createSimulator([
    { id: 'attack-1', seq: 1, tick: 1, type: 'attack', targetId: 2 },
    { id: 'attack-2', seq: 2, tick: 61, type: 'attack', targetId: 2 },
  ])

  const beforeAttack = simulator.at(0)
  assert.equal(beforeAttack.get(1)?.getCooldown().ready, true)
  assert.equal(beforeAttack.get(2)?.getHealth(), 1000)

  const firstAttack = simulator.at(1)
  assert.deepEqual(firstAttack.get(1)?.getCooldown(), {
    ready: false,
    ticksRemaining: GAME_TPS,
  })
  assert.equal(firstAttack.get(2)?.getHealth(), 900)

  assert.deepEqual(simulator.at(60).get(1)?.getCooldown(), {
    ready: false,
    ticksRemaining: 1,
  })

  const secondAttack = simulator.at(61)
  assert.deepEqual(secondAttack.get(1)?.getCooldown(), {
    ready: false,
    ticksRemaining: GAME_TPS,
  })
  assert.equal(secondAttack.get(2)?.getHealth(), 800)
})

test('a late attack recomputes derived health in later snapshots', () => {
  const simulator = createSimulator([])
  assert.equal(simulator.at(10).get(2)?.getHealth(), 1000)

  assert.equal(simulator.addOrder(1, {
    id: 'late-attack',
    seq: 1,
    tick: 4,
    type: 'attack',
    targetId: 2,
  }), true)

  assert.equal(simulator.at(10).get(2)?.getHealth(), 900)
})

function createKillSimulator(): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, new Champion({
    ...championDef(brawler),
    attackSpeed: GAME_TPS,
  }))
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 }, brawler)
  for (let index = 0; index < 12; index += 1) {
    simulator.addOrder(1, {
      id: `attack-${index + 1}`,
      seq: index + 1,
      tick: index + 1,
      type: 'attack',
      targetId: 2,
    })
  }
  return simulator
}

test('reaching 0 health does not kill; only a confirmed death does', () => {
  const simulator = createKillSimulator()

  assert.equal(simulator.at(11).get(2)?.getHealth(), 0)
  assert.equal(simulator.at(11).get(2)?.getDeathTick(), undefined)
  assert.equal(simulator.at(14).get(2)?.isDead(), false)
})

test('a confirmed death stops the character and a later attack on it is rejected', () => {
  const simulator = createKillSimulator()
  simulator.at(12)
  assert.equal(simulator.addDeath(2, { tick: 14, respawnTick: 14 + 30 }), true)
  simulator.addOrder(2, { id: 'move-1', seq: 1, tick: 13, type: 'move', target: { x: 700, y: 100 } })
  simulator.addOrder(1, { id: 'attack-late', seq: 13, tick: 16, type: 'attack', targetId: 2 })

  const dead = simulator.at(20).get(2)
  assert.equal(dead?.getDeathTick(), 14)
  assert.equal(dead?.isDead(), true)
  assert.equal(dead?.getHealth(), 0)
  assert.ok((dead?.getPosition().x ?? 0) > 140, 'it moved until it died')
  assert.deepEqual(simulator.at(30).get(2)?.getPosition(), dead?.getPosition())
  assert.equal(simulator.at(20).get(1)?.getNextAttackTick(), 13)
})

test('a dead character respawns at its start with full health', () => {
  const simulator = createKillSimulator()
  simulator.at(12)
  simulator.addDeath(2, { tick: 14, respawnTick: 44 })
  simulator.addOrder(2, { id: 'move-1', seq: 1, tick: 13, type: 'move', target: { x: 700, y: 100 } })

  const respawned = simulator.at(44).get(2)
  assert.equal(respawned?.isDead(), false)
  assert.equal(respawned?.getHealth(), 1000)
  assert.deepEqual(respawned?.getPosition(), { x: 140, y: 100 })
  assert.deepEqual(simulator.at(46).get(2)?.getPosition(), { x: 140, y: 100 })
})

test('a death is rejected when it overlaps another or is too old to schedule', () => {
  const simulator = createKillSimulator()
  for (let tick = 1; tick <= 30; tick += 1) simulator.at(tick)

  assert.equal(simulator.addDeath(2, { tick: 5, respawnTick: 40 }), false)
  assert.equal(simulator.addDeath(2, { tick: 32, respawnTick: 32 }), false)
  assert.equal(simulator.addDeath(2, { tick: 32, respawnTick: 60 }), true)
  assert.equal(simulator.addDeath(2, { tick: 40, respawnTick: 70 }), false)
})

test('snapshots carry pending deaths so a resync cannot lose one', () => {
  const original = createKillSimulator()
  original.advanceTo(12)
  original.addDeath(2, { tick: 20, respawnTick: 80 })
  original.advanceTo(15)
  original.setCommitTick(3)
  const snapshot = original.snapshot()
  assert.deepEqual(snapshot.characters.find(({ id }) => id === 2)?.deaths, [{ tick: 20, respawnTick: 80 }])
  assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)

  const restored = new Simulator()
  restored.replaceFromSnapshot(snapshot)

  assert.equal(restored.at(20).get(2)?.isDead(), true)
  assert.equal(restored.at(80).get(2)?.isDead(), false)
  assert.deepEqual(restored.at(80).get(2)?.getPosition(), { x: 140, y: 100 })
})

test('ring buffer rejects corrections older than retained state', () => {
  const simulator = createSimulator([])
  for (let tick = 1; tick <= 20; tick += 1) simulator.at(tick)

  assert.throws(() => simulator.at(5), /no longer in the ring buffer/)
  assert.equal(simulator.addOrder(1, {
    id: 'too-old', seq: 1, tick: 5, type: 'move', target: { x: 700, y: 100 },
  }), false)
})

test('advancing to an already-computed tick does not query an evicted frame', () => {
  const simulator = createSimulator([])
  for (let tick = 1; tick <= 20; tick += 1) simulator.at(tick)

  simulator.advanceTo(5)

  assert.equal(simulator.tick, 20)
  assert.equal(simulator.latestSnapshotTick, 20)
})

test('committing advances the state baseline and prunes old order events', () => {
  const simulator = createSimulator([
    { id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 700, y: 100 } },
    { id: 'move-2', seq: 2, tick: 8, type: 'move', target: { x: 300, y: 100 } },
  ])
  simulator.advanceTo(20)
  simulator.setCommitTick(8)

  const character = simulator.characters.get(1)
  assert.deepEqual(character?.orders.map(({ id }) => id), ['move-2'])
  assert.equal(character?.highestOrderSequence, 2)
  const position = simulator.at(21).get(1)?.getPosition()
  assert.ok(position)
  assert.ok(Math.abs(position.x - (100 + SPEED * 20 / 60)) < 1e-9)
  assert.equal(position.y, 100)
})

test('the map is far bigger than one screen, and its edge stops a champion at its radius', () => {
  const simulator = createSimulator([
    // Ordered well past the far corner; the target is clamped to the map.
    { id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: GAME_ARENA_WIDTH + 3000, y: GAME_ARENA_HEIGHT + 3000 } },
  ])
  const corner = { x: GAME_ARENA_WIDTH - brawler.radius, y: GAME_ARENA_HEIGHT - brawler.radius }
  const travel = Math.hypot(corner.x - 100, corner.y - 100)

  // Long after the old 800-wide arena would have ended it is still walking.
  const midway = simulator.at(Math.floor(travel / brawler.moveSpeed * GAME_TPS * 0.85)).get(1)?.getPosition()
  assert.ok(midway && midway.x > 800 && midway.y > 450, 'past what used to be the whole arena')
  assert.ok(midway.x < corner.x && midway.y < corner.y, 'and not there yet')

  const arrival = Math.ceil(travel / brawler.moveSpeed * GAME_TPS) + 3
  assert.deepEqual(simulator.at(arrival).get(1)?.getPosition(), corner)
  assert.deepEqual(simulator.at(arrival + 120).get(1)?.getPosition(), corner, 'it stays at the edge')
})
