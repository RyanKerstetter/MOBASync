import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GameSnapshotSchema,
  GAME_TPS,
  Simulator,
  type EntityOrder,
} from '../packages/shared/src/index.js'

function createSimulator(orders: EntityOrder[]): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 })
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 })
  for (const order of orders) simulator.addOrder(1, order)
  return simulator
}

test('orders resolve identically regardless of arrival order', () => {
  const orders: EntityOrder[] = [
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
    reversed.entities.get(1)?.orders.map(({ id }) => id),
    ['move-1', 'move-3', 'attack-2'],
  )
})

test('an attack stops movement at its derived position', () => {
  const simulator = createSimulator([
    { id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 500, y: 100 } },
    { id: 'attack-2', seq: 2, tick: 3, type: 'attack', targetId: 2 },
  ])

  const attackFrame = simulator.at(3)
  assert.deepEqual(attackFrame.get(1)?.getPosition(), { x: 100 + 220 * 2 / 60, y: 100 })
  assert.deepEqual(attackFrame.get(1)?.getCooldown(), {
    ready: false,
    ticksRemaining: GAME_TPS,
  })
  assert.deepEqual(simulator.at(20).get(1)?.getPosition(), attackFrame.get(1)?.getPosition())
})

test('an out-of-range attack does not stop movement or start cooldown', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 })
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 400, y: 100 })
  simulator.addOrder(1, {
    id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 700, y: 100 },
  })
  simulator.addOrder(1, {
    id: 'attack-2', seq: 2, tick: 3, type: 'attack', targetId: 2,
  })

  const state = simulator.at(20).get(1)
  assert.deepEqual(state?.getPosition(), { x: 100 + 220 * 19 / 60, y: 100 })
  assert.equal(state?.getNextAttackTick(), 0)
  assert.equal(simulator.at(20).get(2)?.getHealth(), 10)
  assert.equal(simulator.at(20).get(2)?.getShield(), 1)
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
  assert.deepEqual(state?.getPosition(), { x: 100 + 220 * 18 / 60, y: 100 })
  assert.equal(state?.getNextAttackTick(), 61)
})

test('a late order invalidates and recomputes cached snapshots after its tick', () => {
  const simulator = createSimulator([
    { id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 700, y: 100 } },
  ])
  const before = simulator.at(10)
  assert.deepEqual(before.get(1)?.getPosition(), { x: 100 + 220 * 9 / 60, y: 100 })

  assert.equal(simulator.addOrder(1, {
    id: 'move-2', seq: 2, tick: 5, type: 'move', target: { x: 300, y: 100 },
  }), true)

  const after = simulator.at(10)
  assert.notEqual(after, before)
  assert.deepEqual(after.get(1)?.getPosition(), { x: 100 + 220 * 9 / 60, y: 100 })
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
  assert.deepEqual(snapshot.entities[0]?.orders.map((order) => order.id), ['move-2'])
  assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)
  const restored = new Simulator()
  restored.replaceFromSnapshot(snapshot)

  assert.deepEqual(restored.at(10).get(1)?.getPosition(), expectedPosition)
  assert.equal(restored.at(5).get(1)?.getPosition().x, 100 + 220 * 4 / 60)
  assert.deepEqual(restored.at(11).get(1)?.getPosition(), expectedNextPosition)
})

test('shared simulation derives shield and health damage from valid attack orders', () => {
  const orders: EntityOrder[] = [
    { id: 'attack-1', seq: 1, tick: 1, type: 'attack', targetId: 2 },
    { id: 'attack-2', seq: 2, tick: 61, type: 'attack', targetId: 2 },
  ]
  const firstPeer = createSimulator(orders)
  const secondPeer = createSimulator(orders)

  const firstHit = firstPeer.at(1).get(2)?.getHealthState()
  assert.equal(firstHit?.shield, 0)
  assert.equal(firstHit?.hp, 10)

  const secondHit = firstPeer.at(61).get(2)?.getHealthState()
  assert.equal(secondHit?.shield, 0)
  assert.equal(secondHit?.hp, 9)
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
  assert.equal(beforeAttack.get(2)?.getShield(), 1)
  assert.equal(beforeAttack.get(2)?.getHealth(), 10)

  const firstAttack = simulator.at(1)
  assert.deepEqual(firstAttack.get(1)?.getCooldown(), {
    ready: false,
    ticksRemaining: GAME_TPS,
  })
  assert.equal(firstAttack.get(2)?.getShield(), 0)
  assert.equal(firstAttack.get(2)?.getHealth(), 10)

  assert.deepEqual(simulator.at(60).get(1)?.getCooldown(), {
    ready: false,
    ticksRemaining: 1,
  })

  const secondAttack = simulator.at(61)
  assert.deepEqual(secondAttack.get(1)?.getCooldown(), {
    ready: false,
    ticksRemaining: GAME_TPS,
  })
  assert.equal(secondAttack.get(2)?.getShield(), 0)
  assert.equal(secondAttack.get(2)?.getHealth(), 9)
})

test('a late attack recomputes derived health in later snapshots', () => {
  const simulator = createSimulator([])
  assert.equal(simulator.at(10).get(2)?.getHealth(), 10)

  assert.equal(simulator.addOrder(1, {
    id: 'late-attack',
    seq: 1,
    tick: 4,
    type: 'attack',
    targetId: 2,
  }), true)

  assert.equal(simulator.at(10).get(2)?.getShield(), 0)
  assert.equal(simulator.at(10).get(2)?.getHealth(), 10)
})

test('shared simulation derives death and rejects later attacks against a dead target', () => {
  const simulator = createSimulator(
    Array.from({ length: 12 }, (_, index) => ({
      id: `attack-${index + 1}`,
      seq: index + 1,
      tick: index + 1,
      type: 'attack' as const,
      targetId: 2,
    })),
  )
  const attacker = simulator.entities.get(1)
  assert.ok(attacker?.attackStats)
  attacker.attackStats.attackSpeed = GAME_TPS

  assert.equal(simulator.at(11).get(2)?.getHealth(), 0)
  assert.equal(simulator.at(11).get(2)?.getDeathTick(), 11)
  assert.equal(simulator.at(11).get(1)?.getCooldown().ready, false)
  assert.equal(simulator.at(12).get(1)?.getCooldown().ready, true)
  assert.equal(simulator.at(12).get(2)?.getHealth(), 0)
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

  const entity = simulator.entities.get(1)
  assert.deepEqual(entity?.orders.map(({ id }) => id), ['move-2'])
  assert.equal(entity?.highestOrderSequence, 2)
  const position = simulator.at(21).get(1)?.getPosition()
  assert.ok(position)
  assert.ok(Math.abs(position.x - (100 + 220 * 20 / 60)) < 1e-9)
  assert.equal(position.y, 100)
})
