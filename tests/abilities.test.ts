import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  Champion,
  damage,
  DEFAULT_CHAMPION_ID,
  enemiesInRadius,
  GameSnapshotSchema,
  getAbilityDef,
  getChampion,
  runEffects,
  SimEntity,
  Simulator,
  type CastOrder,
  type CastTarget,
  type GameEvent,
  type SimReader,
  type SimWriter,
  type Vector2,
} from '../packages/shared/src/index.js'

const ORIGIN = { x: 100, y: 100 }

function createSimulator(enemyPosition: Vector2 = { x: 140, y: 100 }): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN)
  simulator.addPlayer(2, 'player-2', 'Player 2', enemyPosition)
  return simulator
}

function cast(
  seq: number,
  tick: number,
  abilityId: string,
  target: CastTarget,
  origin: Vector2 = ORIGIN,
): CastOrder {
  return { id: `player-1:${seq}`, seq, tick, type: 'cast', abilityId, target, origin }
}

test('a nova cast winds up, then applies damage, slow, shield, and attack reset through effects', () => {
  const simulator = createSimulator()
  const shockwave = getAbilityDef('shockwave')
  assert.ok(shockwave)
  simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  simulator.addOrder(1, cast(2, 2, 'shockwave', { mode: 'none' }))
  const launchTick = 2 + shockwave.windUpTicks

  const windup = simulator.at(launchTick - 1)
  assert.equal(windup.get(1)?.getAction()?.kind, 'cast')
  assert.equal(windup.get(2)?.getHealth(), 10)
  assert.equal(windup.get(1)?.getAbilityCooldown('shockwave').ready, true)

  const launch = simulator.at(launchTick)
  // The auto-attack at tick 1 removed the base shield; shockwave deals 2.
  assert.equal(launch.get(2)?.getHealth(), 8)
  assert.deepEqual(launch.get(2)?.getStatuses().map(({ kind }) => kind), ['slow'])
  assert.equal(launch.get(1)?.getShield(), 1 + 2)
  assert.equal(launch.get(1)?.getNextAttackTick(), launchTick)
  assert.deepEqual(launch.get(1)?.getAbilityCooldown('shockwave'), {
    ready: false,
    ticksRemaining: shockwave.cooldownTicks,
  })
  assert.deepEqual(
    launch.events.map(({ type }) => type),
    ['damage', 'reset-attack-timer'],
  )
  assert.equal(simulator.at(launchTick + shockwave.backswingTicks).get(1)?.getAction(), undefined)
})

test('moving during windup cancels a cast without spending its cooldown', () => {
  const simulator = createSimulator()
  simulator.addOrder(1, cast(1, 1, 'shockwave', { mode: 'none' }))
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 4, type: 'move', target: { x: 300, y: 100 } })

  const later = simulator.at(20)
  assert.equal(later.get(2)?.getHealth(), 10)
  assert.equal(later.get(2)?.getShield(), 1)
  assert.equal(later.get(1)?.getAbilityCooldown('shockwave').ready, true)
  assert.equal(later.get(1)?.getAction(), undefined)
})

test('a slow status rebases movement at the reduced speed until it expires', () => {
  const simulator = createSimulator()
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 1, type: 'move', target: { x: 700, y: 100 } })
  simulator.addOrder(1, cast(1, 1, 'lash', { mode: 'unit', unitId: 2 }))
  const lash = getAbilityDef('lash')
  assert.ok(lash)
  const launchTick = 1 + lash.windUpTicks
  const speed = getChampion(DEFAULT_CHAMPION_ID).moveSpeed

  const hit = simulator.at(launchTick)
  assert.equal(hit.get(2)?.getHealth(), 8)
  const hitX = hit.get(2)?.getPosition().x ?? 0
  const slowedX = simulator.at(launchTick + 10).get(2)?.getPosition().x ?? 0
  assert.ok(Math.abs(slowedX - (hitX + speed * 0.5 * 10 / 60)) < 1e-9)

  const slowEnd = simulator.at(launchTick + 45).get(2)
  assert.deepEqual(slowEnd?.getStatuses(), [])
})

test('unit, point, and origin checks reject invalid casts without starting them', () => {
  const farEnemy = createSimulator({ x: 400, y: 100 })
  farEnemy.addOrder(1, cast(1, 1, 'lash', { mode: 'unit', unitId: 2 }))
  farEnemy.addOrder(1, cast(2, 2, 'meteor', { mode: 'point', point: { x: 500, y: 100 } }))
  farEnemy.addOrder(1, cast(3, 3, 'shockwave', { mode: 'none' }, { x: 300, y: 100 }))
  farEnemy.addOrder(1, cast(4, 4, 'bolt', { mode: 'point', point: { x: 200, y: 100 } }))

  for (let tick = 1; tick <= 4; tick += 1) {
    assert.equal(farEnemy.at(tick).get(1)?.getAction(), undefined)
  }
})

test('a point cast lands at its clamped target after windup', () => {
  const simulator = createSimulator()
  const meteor = getAbilityDef('meteor')
  assert.ok(meteor)
  simulator.addOrder(1, cast(1, 1, 'meteor', { mode: 'point', point: { x: 140, y: 100 } }))

  assert.equal(simulator.at(meteor.windUpTicks).get(2)?.getHealth(), 10)
  assert.equal(simulator.at(1 + meteor.windUpTicks).get(2)?.getHealth(), 7)
})

test('a skillshot projectile travels in the frame and hits on the tick it overlaps', () => {
  const simulator = createSimulator({ x: 400, y: 100 })
  simulator.addOrder(1, cast(1, 1, 'bolt', { mode: 'direction', dir: { x: 1, y: 0 } }))

  // Launch at tick 10, 10 px per tick, contact within 8 + 18 px of x = 400.
  assert.equal(simulator.at(10).getProjectiles().length, 1)
  assert.equal(simulator.at(37).getProjectiles().length, 1)
  assert.equal(simulator.at(37).get(2)?.getHealth(), 10)
  assert.equal(simulator.at(38).getProjectiles().length, 0)
  assert.equal(simulator.at(38).get(2)?.getHealth(), 8)
  assert.equal(simulator.at(38).events[0]?.type, 'damage')
})

test('a late dodge order recomputes the projectile so it misses', () => {
  const simulator = createSimulator({ x: 400, y: 100 })
  simulator.addOrder(1, cast(1, 1, 'bolt', { mode: 'direction', dir: { x: 1, y: 0 } }))
  assert.equal(simulator.at(30).getProjectiles().length, 1)

  assert.equal(simulator.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 20, type: 'move', target: { x: 400, y: 400 },
  }), true)

  assert.equal(simulator.at(60).get(2)?.getHealth(), 10)
  assert.equal(simulator.at(60).getProjectiles().length, 0)
})

test('checkpoints carry windups and projectiles after their orders are pruned', () => {
  const original = createSimulator({ x: 400, y: 100 })
  original.addOrder(1, cast(1, 1, 'bolt', { mode: 'direction', dir: { x: 1, y: 0 } }))
  original.advanceTo(15)
  original.setCommitTick(5)
  const windupSnapshot = original.snapshot()
  assert.equal(windupSnapshot.entities[0]?.orders.length, 0)
  assert.equal(windupSnapshot.checkpoint.entities[0]?.action?.kind, 'cast')
  assert.equal(GameSnapshotSchema.safeParse(windupSnapshot).success, true)

  original.advanceTo(30)
  original.setCommitTick(20)
  const flightSnapshot = original.snapshot()
  assert.equal(flightSnapshot.checkpoint.projectiles.length, 1)

  for (const snapshot of [windupSnapshot, flightSnapshot]) {
    const restored = new Simulator()
    restored.replaceFromSnapshot(snapshot)
    assert.equal(restored.at(38).get(2)?.getHealth(), 8)
  }
})

test('shield statuses absorb damage before the base shield', () => {
  const simulator = createSimulator()
  simulator.addOrder(1, cast(1, 1, 'shockwave', { mode: 'none' }))
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 10, type: 'attack', targetId: 1 })

  const afterHit = simulator.at(10).get(1)
  assert.equal(afterHit?.getHealthState()?.shield, 1)
  assert.equal(afterHit?.getShield(), 1 + 1)
  assert.equal(afterHit?.getHealth(), 10)
})

test('attack windup delays damage and moving cancels it without starting cooldown', () => {
  const slowSwing = new Champion({
    ...getChampion(DEFAULT_CHAMPION_ID),
    id: 'slow-swing',
    attackWindupTicks: 10,
  })
  const createDuel = (): Simulator => {
    const simulator = new Simulator()
    simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, slowSwing)
    simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 })
    simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
    return simulator
  }

  const landed = createDuel()
  assert.equal(landed.at(10).get(2)?.getShield(), 1)
  assert.equal(landed.at(11).get(2)?.getShield(), 0)
  assert.equal(landed.at(11).get(1)?.getNextAttackTick(), 1 + slowSwing.attackCooldownTicks)

  const cancelled = createDuel()
  cancelled.addOrder(1, { id: 'player-1:2', seq: 2, tick: 5, type: 'move', target: { x: 300, y: 100 } })
  assert.equal(cancelled.at(20).get(2)?.getShield(), 1)
  assert.equal(cancelled.at(20).get(1)?.getNextAttackTick(), 0)
})

test('effects write only through the context they are given', () => {
  const champion = getChampion(DEFAULT_CHAMPION_ID)
  const units = new Map([
    [1, new SimEntity(1, ORIGIN, [], champion, { playerId: 'player-1', name: 'One' })],
    [2, new SimEntity(2, { x: 130, y: 100 }, [], champion, { playerId: 'player-2', name: 'Two' })],
    [3, new SimEntity(3, { x: 110, y: 100 }, [], champion, { playerId: 'player-1', name: 'Ally' })],
  ])
  const events: GameEvent[] = []
  const sim: SimReader & Pick<SimWriter, 'emitEvent'> = {
    tick: 7,
    entity: (id) => units.get(id),
    posAt: (id) => units.get(id)?.initialPosition,
    unitsInRadius: () => [1, 2, 3],
    emitEvent: (event) => events.push(event),
  }

  runEffects([damage(3, enemiesInRadius(50))], sim, {
    id: 'c:player-1:1',
    rootId: 'player-1:1',
    ownerId: 1,
    tick: 7,
    at: ORIGIN,
    aim: { mode: 'none' },
    subject: null,
  })

  assert.deepEqual(events, [{
    type: 'damage',
    id: 'c:player-1:1:damage:u2',
    rootId: 'player-1:1',
    ownerId: 1,
    targetId: 2,
    amount: 3,
  }])
})

test('the server accepts kit casts and rejects abilities outside the champion kit', () => {
  const game = new ServerGameState()
  game.begin([{ id: 'player-1', name: 'One' }, { id: 'player-2', name: 'Two' }])
  const entityId = game.getEntityId('player-1')
  assert.ok(entityId)
  const origin = game.simulator.at(0).get(entityId)?.getPosition()
  assert.ok(origin)

  const accepted = game.acceptOrder('player-1', {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 'shockwave', target: { mode: 'none' }, origin,
  })
  assert.equal(accepted.ack.status, 'accepted')
  assert.equal(accepted.broadcast?.type, 'cast')

  const rejected = game.acceptOrder('player-1', {
    id: 'player-1:2', seq: 2, tick: 2, type: 'cast', abilityId: 'fireball', target: { mode: 'none' }, origin,
  })
  assert.equal(rejected.ack.reason, 'unknown_ability')
})

test('the client resolves slots into clamped, quantized cast orders', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 400, y: 100 })
  gameState.setLocalEntityId(1)

  const meteor = gameState.createCastOrder(3, { x: 700, y: 100 }, 'player-1', 0)
  assert.ok(meteor.ok)
  assert.equal(meteor.order.abilityId, 'meteor')
  assert.deepEqual(meteor.order.origin, ORIGIN)
  assert.deepEqual(meteor.order.target, { mode: 'point', point: { x: 400, y: 100 } })

  const bolt = gameState.createCastOrder(2, { x: 100, y: 300 }, 'player-1', 0)
  assert.ok(bolt.ok)
  assert.deepEqual(bolt.order.target, { mode: 'direction', dir: { x: 0, y: 1 } })

  const lash = gameState.createCastOrder(1, { x: 600, y: 300 }, 'player-1', 0)
  assert.deepEqual(lash, { ok: false, reason: 'Aim lash at an enemy.' })
})
