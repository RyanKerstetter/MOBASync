import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  attackDamage,
  boxTouchesCircle,
  Champion,
  damage,
  enemiesInRadius,
  entityPosAt,
  GAME_TPS,
  GameSnapshotSchema,
  getAbilityDef,
  getChampion,
  getEntityDef,
  knockback,
  runEffects,
  SimCharacter,
  Simulator,
  spawnEntity,
  subject,
  targetUnit,
  type CastOrder,
  type CastTarget,
  type CharacterOrder,
  type GameEvent,
  type SimReader,
  type SimWriter,
  type Vector2,
} from '../packages/shared/src/index.js'
import { bigHitter, brawler, cutter, soldier, spouter } from './fixtures.js'

const ORIGIN = { x: 100, y: 100 }

function createSimulator(enemyPosition: Vector2 = { x: 140, y: 100 }): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, brawler)
  simulator.addPlayer(2, 'player-2', 'Player 2', enemyPosition, brawler)
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
  const shockwave = getAbilityDef('t-shockwave')
  assert.ok(shockwave)
  simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  simulator.addOrder(1, cast(2, 2, 't-shockwave', { mode: 'none' }))
  const launchTick = 2 + shockwave.windUpTicks

  const windup = simulator.at(launchTick - 1)
  assert.equal(windup.get(1)?.getAction()?.kind, 'cast')
  assert.equal(windup.get(2)?.getHealth(), 900, 'only the auto at tick 1 has landed')
  assert.equal(windup.get(1)?.getAbilityCooldown('t-shockwave').ready, true)

  const launch = simulator.at(launchTick)
  // The auto at tick 1 deals 100 and shockwave deals 200.
  assert.equal(launch.get(2)?.getHealth(), 700)
  assert.deepEqual(launch.get(2)?.getStatuses().map(({ kind }) => kind), ['slow'])
  assert.equal(launch.get(1)?.getShield(), 200)
  assert.equal(launch.get(1)?.getNextAttackTick(), launchTick)
  assert.deepEqual(launch.get(1)?.getAbilityCooldown('t-shockwave'), {
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
  simulator.addOrder(1, cast(1, 1, 't-shockwave', { mode: 'none' }))
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 4, type: 'move', target: { x: 300, y: 100 } })

  const later = simulator.at(20)
  assert.equal(later.get(2)?.getHealth(), 1000)
  assert.equal(later.get(1)?.getAbilityCooldown('t-shockwave').ready, true)
  assert.equal(later.get(1)?.getAction(), undefined)
})

test('a slow status rebases movement at the reduced speed until it expires', () => {
  const simulator = createSimulator()
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 1, type: 'move', target: { x: 700, y: 100 } })
  simulator.addOrder(1, cast(1, 1, 't-lash', { mode: 'unit', unitId: 2 }))
  const lash = getAbilityDef('t-lash')
  assert.ok(lash)
  const launchTick = 1 + lash.windUpTicks
  const speed = brawler.moveSpeed

  const hit = simulator.at(launchTick)
  assert.equal(hit.get(2)?.getHealth(), 700)
  const hitX = hit.get(2)?.getPosition().x ?? 0
  const slowedX = simulator.at(launchTick + 10).get(2)?.getPosition().x ?? 0
  assert.ok(Math.abs(slowedX - (hitX + speed * 0.5 * 10 / 60)) < 1e-9)

  const slowEnd = simulator.at(launchTick + 45).get(2)
  assert.deepEqual(slowEnd?.getStatuses(), [])
})

test('unit, point, and origin checks reject invalid casts without starting them', () => {
  const farEnemy = createSimulator({ x: 400, y: 100 })
  farEnemy.addOrder(1, cast(1, 1, 't-lash', { mode: 'unit', unitId: 2 }))
  farEnemy.addOrder(1, cast(2, 2, 't-meteor', { mode: 'point', point: { x: 500, y: 100 } }))
  farEnemy.addOrder(1, cast(3, 3, 't-shockwave', { mode: 'none' }, { x: 300, y: 100 }))
  farEnemy.addOrder(1, cast(4, 4, 't-bolt', { mode: 'point', point: { x: 200, y: 100 } }))

  for (let tick = 1; tick <= 4; tick += 1) {
    assert.equal(farEnemy.at(tick).get(1)?.getAction(), undefined)
  }
})

test('a point cast lands at its clamped target after windup', () => {
  const simulator = createSimulator()
  const meteor = getAbilityDef('t-meteor')
  assert.ok(meteor)
  simulator.addOrder(1, cast(1, 1, 't-meteor', { mode: 'point', point: { x: 140, y: 100 } }))

  assert.equal(simulator.at(meteor.windUpTicks).get(2)?.getHealth(), 1000)
  assert.equal(simulator.at(1 + meteor.windUpTicks).get(2)?.getHealth(), 600)
})

test('a skillshot entity travels in the frame and hits on the tick it overlaps', () => {
  const simulator = createSimulator({ x: 400, y: 100 })
  simulator.addOrder(1, cast(1, 1, 't-bolt', { mode: 'direction', dir: { x: 1, y: 0 } }))

  // Launch at tick 10, 10 px per tick, contact within 8 + 18 px of x = 400.
  assert.equal(simulator.at(10).getEntities().length, 1)
  assert.equal(simulator.at(37).getEntities().length, 1)
  assert.equal(simulator.at(37).get(2)?.getHealth(), 1000)
  assert.equal(simulator.at(38).getEntities().length, 0)
  assert.equal(simulator.at(38).get(2)?.getHealth(), 700)
  assert.equal(simulator.at(38).events[0]?.type, 'damage')
})

test('a late dodge order recomputes the entity so it misses', () => {
  const simulator = createSimulator({ x: 400, y: 100 })
  simulator.addOrder(1, cast(1, 1, 't-bolt', { mode: 'direction', dir: { x: 1, y: 0 } }))
  assert.equal(simulator.at(30).getEntities().length, 1)

  assert.equal(simulator.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 20, type: 'move', target: { x: 400, y: 400 },
  }), true)

  assert.equal(simulator.at(60).get(2)?.getHealth(), 1000)
  assert.equal(simulator.at(60).getEntities().length, 0)
})

test('checkpoints carry windups and entities after their orders are pruned', () => {
  const original = createSimulator({ x: 400, y: 100 })
  original.addOrder(1, cast(1, 1, 't-bolt', { mode: 'direction', dir: { x: 1, y: 0 } }))
  original.advanceTo(15)
  original.setCommitTick(5)
  const windupSnapshot = original.snapshot()
  assert.equal(windupSnapshot.characters[0]?.orders.length, 0)
  assert.equal(windupSnapshot.checkpoint.characters[0]?.action?.kind, 'cast')
  assert.equal(GameSnapshotSchema.safeParse(windupSnapshot).success, true)

  original.advanceTo(30)
  original.setCommitTick(20)
  const flightSnapshot = original.snapshot()
  assert.equal(flightSnapshot.checkpoint.entities.length, 1)

  for (const snapshot of [windupSnapshot, flightSnapshot]) {
    const restored = new Simulator()
    restored.replaceFromSnapshot(snapshot)
    assert.equal(restored.at(38).get(2)?.getHealth(), 700)
  }
})

test('shield statuses absorb damage before health', () => {
  const simulator = createSimulator()
  simulator.addOrder(1, cast(1, 1, 't-shockwave', { mode: 'none' }))
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 10, type: 'attack', targetId: 1 })

  const afterHit = simulator.at(10).get(1)
  assert.equal(afterHit?.getShield(), 200 - 100)
  assert.equal(afterHit?.getHealth(), 1000)
})

test('attack windup delays damage and moving cancels it without starting cooldown', () => {
  const slowSwing = new Champion({
    ...brawler,
    id: 'slow-swing',
    attackWindupTicks: 10,
  })
  const createDuel = (): Simulator => {
    const simulator = new Simulator()
    simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, slowSwing)
    simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 }, brawler)
    simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
    return simulator
  }

  const landed = createDuel()
  assert.equal(landed.at(10).get(2)?.getHealth(), 1000)
  assert.equal(landed.at(11).get(2)?.getHealth(), 900)
  assert.equal(landed.at(11).get(1)?.getNextAttackTick(), 1 + slowSwing.attackCooldownTicks)

  const cancelled = createDuel()
  cancelled.addOrder(1, { id: 'player-1:2', seq: 2, tick: 5, type: 'move', target: { x: 300, y: 100 } })
  assert.equal(cancelled.at(20).get(2)?.getHealth(), 1000)
  assert.equal(cancelled.at(20).get(1)?.getNextAttackTick(), 0)
})

test('effects write only through the context they are given', () => {
  const champion = brawler
  const units = new Map([
    [1, new SimCharacter(1, ORIGIN, [], champion, { playerId: 'player-1', name: 'One' })],
    [2, new SimCharacter(2, { x: 130, y: 100 }, [], champion, { playerId: 'player-2', name: 'Two' })],
    [3, new SimCharacter(3, { x: 110, y: 100 }, [], champion, { playerId: 'player-1', name: 'Ally' })],
  ])
  const events: GameEvent[] = []
  const sim: SimReader & Pick<SimWriter, 'emitEvent'> = {
    tick: 7,
    character: (id) => units.get(id),
    posAt: (id) => units.get(id)?.initialPosition,
    unitsInRadius: () => [1, 2, 3],
    markersOn: () => [],
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

test('the client resolves slots into clamped, quantized cast orders', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, brawler)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 400, y: 100 }, brawler)
  gameState.setLocalCharacterId(1)

  const meteor = gameState.createCastOrder(3, { x: 700, y: 100 }, 'player-1', 0)
  assert.ok(meteor.ok)
  assert.equal(meteor.order.abilityId, 't-meteor')
  assert.deepEqual(meteor.order.origin, ORIGIN)
  assert.deepEqual(meteor.order.target, { mode: 'point', point: { x: 400, y: 100 } })

  const bolt = gameState.createCastOrder(2, { x: 100, y: 300 }, 'player-1', 0)
  assert.ok(bolt.ok)
  assert.deepEqual(bolt.order.target, { mode: 'direction', dir: { x: 0, y: 1 } })

  const lash = gameState.createCastOrder(1, { x: 600, y: 300 }, 'player-1', 0)
  assert.deepEqual(lash, { ok: false, reason: 'Aim t-lash at an enemy.' })
})

// Cursebearer kit

const AUTO_TICKS = [1, 51, 101, 151, 201, 251]

// Close enough to auto, whatever the champion's range is tuned to.
const CURSE_GAP = getChampion('t-cursebearer').attackRange - 40

function createCurseDuel(enemyPosition: Vector2 = { x: 100 + CURSE_GAP, y: 100 }): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, getChampion('t-cursebearer'))
  simulator.addPlayer(2, 'player-2', 'Player 2', enemyPosition, brawler)
  return simulator
}

function autoAttacks(simulator: Simulator, count: number): void {
  AUTO_TICKS.slice(0, count).forEach((tick, index) => {
    simulator.addOrder(1, { id: `player-1:${index + 1}`, seq: index + 1, tick, type: 'attack', targetId: 2 })
  })
}

function curseStacks(simulator: Simulator, tick: number, unitId = 2): number {
  return simulator.at(tick).get(unitId)?.getMarkers().filter((marker) => marker.key === 'curse').length ?? 0
}

function hasteOn(simulator: Simulator, tick: number, unitId = 1): number {
  return simulator.at(tick).get(unitId)?.getStatuses()
    .filter((status) => status.kind === 'haste')
    .reduce((total, status) => total + status.amount, 0) ?? 0
}

// Feast's haste per stack is tuned in abilities.ts, so measure it with a single stack.
function feastHastePerStack(): number {
  const simulator = createCurseDuel()
  autoAttacks(simulator, 1)
  simulator.addOrder(1, cast(10, 60, 't-feast', { mode: 'unit', unitId: 2 }))
  const feast = getAbilityDef('t-feast')
  assert.ok(feast)
  return hasteOn(simulator, 60 + feast.windUpTicks)
}

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not close to ${expected}`)
}

test('cursebearer autos add one curse stack each, capped at five', () => {
  const simulator = createCurseDuel()
  autoAttacks(simulator, 6)

  // Windup is 4 ticks, so each auto lands 4 ticks after it is ordered.
  assert.equal(curseStacks(simulator, 4), 0)
  assert.equal(curseStacks(simulator, 5), 1)
  assert.equal(curseStacks(simulator, 55), 2)
  assert.equal(curseStacks(simulator, 205), 5)
  assert.equal(curseStacks(simulator, 255), 5, 'the sixth auto replaces the oldest stack')
  assert.equal(simulator.at(255).get(2)?.getHealth(), 1000 - 80 * 6)
})

test('curse stacks expire together, and applying another stack refreshes the whole stack', () => {
  const single = createCurseDuel()
  autoAttacks(single, 1)
  // The auto is ordered on tick 1 and lands after its 4-tick windup.
  assert.equal(curseStacks(single, 5 + 600 - 1), 1)
  assert.equal(curseStacks(single, 5 + 600), 0)

  // A second auto lands 50 ticks later and resets the first stack's timer too.
  const pair = createCurseDuel()
  autoAttacks(pair, 2)
  assert.equal(curseStacks(pair, 5 + 600), 2, 'the first stack would have expired by now')
  assert.equal(curseStacks(pair, 55 + 600 - 1), 2)
  assert.equal(curseStacks(pair, 55 + 600), 0)
})

test('feast pops the stacks for damage, haste and a proportional cooldown refund', () => {
  const simulator = createCurseDuel()
  autoAttacks(simulator, 3)
  simulator.addOrder(1, cast(10, 160, 't-feast', { mode: 'unit', unitId: 2 }))
  const feast = getAbilityDef('t-feast')
  assert.ok(feast)
  const launch = 160 + feast.windUpTicks

  assert.equal(curseStacks(simulator, launch - 1), 3)
  assert.equal(simulator.at(launch - 1).get(2)?.getHealth(), 1000 - 240)
  // 3 stacks: 150 + 3 * 100 damage, 0.1 haste per stack, a fifth of the cooldown per stack.
  assert.equal(simulator.at(launch).get(2)?.getHealth(), 1000 - 240 - 450)
  assert.equal(curseStacks(simulator, launch), 0)
  assertClose(hasteOn(simulator, launch), 3 * feastHastePerStack())
  const refunded = Math.round(feast.cooldownTicks * 0.6)
  assert.equal(
    simulator.at(launch).get(1)?.getAbilityCooldown('t-feast').ticksRemaining,
    feast.cooldownTicks - refunded,
  )
})

test('feast with five stacks refunds its whole cooldown and with none refunds nothing', () => {
  const full = createCurseDuel()
  autoAttacks(full, 5)
  full.addOrder(1, cast(10, 260, 't-feast', { mode: 'unit', unitId: 2 }))
  assert.equal(full.at(266).get(1)?.getAbilityCooldown('t-feast').ready, true)
  assertClose(hasteOn(full, 266), 5 * feastHastePerStack())

  const none = createCurseDuel()
  none.addOrder(1, cast(1, 1, 't-feast', { mode: 'unit', unitId: 2 }))
  const feast = getAbilityDef('t-feast')
  assert.ok(feast)
  assert.equal(none.at(7).get(2)?.getHealth(), 1000 - 150)
  assert.equal(none.at(7).get(1)?.getAbilityCooldown('t-feast').ticksRemaining, feast.cooldownTicks)
  assert.equal(hasteOn(none, 7), 0)
})

test('hex slows and adds two stacks, and tops up to the cap instead of exceeding it', () => {
  const fresh = createCurseDuel()
  fresh.addOrder(1, cast(1, 1, 't-hex', { mode: 'direction', dir: { x: 1, y: 0 } }))
  const hitTick = [...Array(60).keys()].map((index) => index + 9).find((tick) => curseStacks(fresh, tick) > 0)
  assert.ok(hitTick)
  assert.equal(curseStacks(fresh, hitTick), 2)
  assert.equal(fresh.at(hitTick).get(2)?.getHealth(), 1000, 'a plain hit does no damage')
  assertClose(fresh.at(hitTick).get(2)?.getStatuses().find((status) => status.kind === 'slow')?.amount ?? 0, 0.3)

  const topUp = createCurseDuel()
  autoAttacks(topUp, 4)
  topUp.addOrder(1, cast(10, 210, 't-hex', { mode: 'direction', dir: { x: 1, y: 0 } }))
  assert.equal(curseStacks(topUp, 209), 4)
  assert.equal(curseStacks(topUp, 260), 5, 'four plus two stacks is capped at five')
})

test('hex against five stacks pops them for damage and haste instead of adding more', () => {
  const simulator = createCurseDuel()
  autoAttacks(simulator, 5)
  simulator.addOrder(1, cast(10, 260, 't-hex', { mode: 'direction', dir: { x: 1, y: 0 } }))
  const before = simulator.at(268).get(2)?.getHealth()
  assert.equal(curseStacks(simulator, 268), 5)

  const hitTick = [...Array(60).keys()].map((index) => index + 269).find((tick) => curseStacks(simulator, tick) === 0)
  assert.ok(hitTick)
  assert.equal(simulator.at(hitTick).get(2)?.getHealth(), (before ?? 0) - 500)
  assert.ok(hasteOn(simulator, hitTick) > 0, 'the pop hastes the caster')
  assert.equal(curseStacks(simulator, hitTick + 5), 0, 'nothing is re-applied after the pop')
})

test('miasma leaves a stationary field that hastes its owner and slows enemies inside', () => {
  const simulator = createCurseDuel({ x: 140, y: 100 })
  simulator.addOrder(1, cast(1, 1, 't-miasma', { mode: 'none' }))
  const miasma = getAbilityDef('t-miasma')
  assert.ok(miasma)
  const launch = 1 + miasma.windUpTicks

  assert.equal(simulator.at(launch).getEntities().length, 1)
  assertClose(hasteOn(simulator, launch + 2), 0.25)
  assertClose(simulator.at(launch + 2).get(2)?.getStatuses().find((status) => status.kind === 'slow')?.amount ?? 0, 0.25)
  assert.deepEqual(simulator.at(launch + 30).getEntities()[0]?.origin, ORIGIN)

  // The field lasts four seconds and its effects wear off within two ticks.
  assert.equal(simulator.at(launch + 240).getEntities().length, 1)
  assert.equal(simulator.at(launch + 241).getEntities().length, 0)
  assert.equal(hasteOn(simulator, launch + 244), 0)
})

test('miasma does not follow the owner, so leaving it ends the effect', () => {
  const simulator = createCurseDuel({ x: 700, y: 400 })
  simulator.addOrder(1, cast(1, 1, 't-miasma', { mode: 'none' }))
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 20, type: 'move', target: { x: 600, y: 100 } })

  assert.ok(hasteOn(simulator, 15) > 0)
  assert.equal(hasteOn(simulator, 120), 0, 'the owner is well outside the field by now')
  assert.equal(simulator.at(120).getEntities().length, 1, 'the field is still there')
})

test('haste and slow combine as base * (1 + haste) * (1 - slow)', () => {
  // Inside miasma the owner has +25% and the enemy -25% from the same field.
  const simulator = createCurseDuel({ x: 140, y: 100 })
  simulator.addOrder(1, cast(1, 1, 't-miasma', { mode: 'none' }))
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 6, type: 'move', target: { x: 700, y: 100 } })
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 6, type: 'move', target: { x: 700, y: 400 } })

  const step = (id: number, tick: number): number => {
    const before = simulator.at(tick).get(id)?.getPosition()
    const after = simulator.at(tick + 1).get(id)?.getPosition()
    return Math.hypot((after?.x ?? 0) - (before?.x ?? 0), (after?.y ?? 0) - (before?.y ?? 0))
  }
  const owner = getChampion('t-cursebearer').moveSpeed
  const enemy = brawler.moveSpeed
  assertClose(step(1, 12), owner * 1.25 / 60)
  assertClose(step(2, 12), enemy * 0.75 / 60)
})

test('curse stacks, cooldown refunds and fields survive a checkpoint restore', () => {
  const build = (): Simulator => {
    const simulator = createCurseDuel()
    autoAttacks(simulator, 5)
    simulator.addOrder(1, cast(10, 260, 't-feast', { mode: 'unit', unitId: 2 }))
    simulator.addOrder(1, cast(11, 400, 't-miasma', { mode: 'none' }))
    return simulator
  }
  // Reads only move forward because the frame ring buffer forgets old ticks.
  const record = (simulator: Simulator, from: number, to: number): Map<number, string> => {
    const frames = new Map<number, string>()
    for (let tick = from; tick <= to; tick += 1) {
      const frame = simulator.at(tick)
      frames.set(tick, JSON.stringify([
        frame.get(2)?.getHealthState(),
        frame.get(2)?.getMarkers(),
        frame.get(1)?.getStatuses(),
        frame.get(1)?.getAbilityCooldown('t-feast'),
        frame.getEntities().length,
      ]))
    }
    return frames
  }
  const expected = record(build(), 1, 440)

  // One checkpoint after Feast popped the stacks, one while the field is already out.
  const original = build()
  original.advanceTo(310)
  original.setCommitTick(300)
  const afterFeast = original.snapshot()
  original.advanceTo(410)
  original.setCommitTick(405)
  const withField = original.snapshot()

  for (const [snapshot, committed] of [[afterFeast, 300], [withField, 405]] as const) {
    assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)
    const restored = new Simulator()
    restored.replaceFromSnapshot(snapshot)
    const replayed = record(restored, committed + 1, 440)
    for (const [tick, frame] of replayed) assert.equal(frame, expected.get(tick), `tick ${tick}`)
  }
  assert.equal(withField.checkpoint.entities.length, 1, 'the field travels in the checkpoint')
})

const autoBolt = spawnEntity({
  id: 'test-auto-bolt',
  speed: 600,
  radius: 8,
  lifetimeTicks: 30,
  onHit: [damage(50)],
})

test('auto attack effects can target the attacked unit with targetUnit()', () => {
  const caster = new Champion({
    ...brawler,
    onAttackHit: [damage(50, targetUnit())],
  })
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, caster)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 180, y: 100 }, brawler)
  simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })

  assert.equal(simulator.at(1).get(2)?.getHealth(), 950)
})

test('an auto attack can launch a projectile that flies toward its target', () => {
  const caster = new Champion({
    ...brawler,
    onAttackHit: [autoBolt],
  })
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, caster)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 180, y: 100 }, brawler)
  simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })

  const launched = simulator.at(1)
  assert.equal(launched.getEntities().length, 1)
  assert.equal(launched.get(2)?.getHealth(), 1000, 'nothing lands before it flies')
  // Launched on tick 1 at 10 px per tick: 80 px minus 8 + 18 px of reach is first touched on tick 7.
  assert.equal(simulator.at(6).get(2)?.getHealth(), 1000)
  assert.equal(simulator.at(7).get(2)?.getHealth(), 950)
  assert.equal(simulator.at(7).getEntities().length, 0)
})

test('attackDamage() makes an auto deal whatever the champion stat says', () => {
  for (const damageStat of [60, 250]) {
    const caster = new Champion({
      ...brawler,
      attackDamage: damageStat,
      onAttackHit: [damage(attackDamage())],
    })
    const simulator = new Simulator()
    simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, caster)
    simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 }, brawler)
    simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })

    assert.equal(simulator.at(1).get(2)?.getHealth(), 1000 - damageStat)
  }
})

// Archer kit

function createArcherDuel(enemyPosition: Vector2 = { x: 140, y: 100 }): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, getChampion('t-archer'))
  simulator.addPlayer(2, 'player-2', 'Player 2', enemyPosition, brawler)
  return simulator
}

function attack(seq: number, tick: number): CharacterOrder {
  return { id: `player-1:${seq}`, seq, tick, type: 'attack', targetId: 2 }
}

// Leap's speed and reach are tuned in abilities.ts, so these tests derive everything from them.
const LEAP_STEP = 600 / GAME_TPS
// A dash that stays inside its reach, so it ends exactly on the aimed point.
const LEAP_REACH = Math.round(120 * 0.8)
const LEAP_TARGET = { x: 100 + LEAP_REACH, y: 100 }
// The cast has no windup: the dash is written on tick 1, steps from tick 2, and lands on tick
// 1 + LEAP_TICKS.
const LEAP_TICKS = Math.ceil(LEAP_REACH / LEAP_STEP)

test('leap dashes to the aimed point at a fixed speed and then stops', () => {
  const simulator = createArcherDuel()
  simulator.addOrder(1, cast(1, 1, 't-leap', { mode: 'point', point: LEAP_TARGET }))

  assert.equal(simulator.at(1).get(1)?.getPosition().x, 100)
  assert.equal(simulator.at(1).get(1)?.isDashing(), true)
  assertClose(simulator.at(4).get(1)?.getPosition().x ?? 0, 100 + LEAP_STEP * 3)
  assert.equal(simulator.at(LEAP_TICKS).get(1)?.isDashing(), true)
  // The last step is shorter, so it lands exactly on the point.
  assert.deepEqual(simulator.at(1 + LEAP_TICKS).get(1)?.getPosition(), LEAP_TARGET)
  assert.equal(simulator.at(1 + LEAP_TICKS).get(1)?.isDashing(), false)
  assert.deepEqual(simulator.at(LEAP_TICKS + 20).get(1)?.getPosition(), LEAP_TARGET)
})

test('leap never travels farther than its distance, however far the aim is', () => {
  const leap = getAbilityDef('t-leap')
  assert.ok(leap)
  const simulator = createArcherDuel({ x: 100, y: 400 })
  simulator.addOrder(1, cast(1, 1, 't-leap', { mode: 'point', point: { x: 100 + leap.range, y: 100 } }))

  const landing = 1 + Math.ceil(120 / LEAP_STEP)
  assert.deepEqual(simulator.at(landing).get(1)?.getPosition(), { x: 100 + 120, y: 100 })
  assert.deepEqual(simulator.at(landing + 20).get(1)?.getPosition(), { x: 100 + 120, y: 100 })
})

test('a dash ignores slows, and its speed does not depend on haste or slow', () => {
  const simulator = createArcherDuel()
  // Player 2 slows the archer with lash before the leap.
  simulator.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-lash',
    target: { mode: 'unit', unitId: 1 }, origin: { x: 140, y: 100 },
  })
  simulator.addOrder(1, cast(1, 12, 't-leap', { mode: 'point', point: LEAP_TARGET }))

  const before = simulator.at(13).get(1)
  assert.ok(before?.getStatuses().some((status) => status.kind === 'slow'), 'the archer is slowed')
  const x13 = before?.getPosition().x ?? 0
  assertClose((simulator.at(14).get(1)?.getPosition().x ?? 0) - x13, LEAP_STEP)
})

test('attacks and casts are rejected during a dash, and a move order waits for it to end', () => {
  const simulator = createArcherDuel({ x: 200, y: 100 })
  simulator.addOrder(1, cast(1, 1, 't-leap', { mode: 'point', point: LEAP_TARGET }))
  // A cast must name where the caster really is, so the rejection is about the dash alone.
  const midDash = simulator.at(6).get(1)?.getPosition()
  assert.ok(midDash)
  simulator.addOrder(1, attack(2, 5))
  simulator.addOrder(1, cast(3, 6, 't-focus', { mode: 'none' }, midDash))
  simulator.addOrder(1, { id: 'player-1:4', seq: 4, tick: 7, type: 'move', target: { x: LEAP_TARGET.x, y: 400 } })

  const during = simulator.at(8)
  assert.equal(during.get(2)?.getHealth(), 1000, 'the attack never started')
  assert.equal(during.get(1)?.getNextAttackTick(), 0)
  assert.equal(during.get(1)?.getAbilityCooldown('t-focus').ready, true, 'the cast never started')
  assert.equal(during.get(1)?.isDashing(), true)

  // The dash still ends on its target, then the queued walk begins.
  const landing = 1 + LEAP_TICKS
  assert.deepEqual(simulator.at(landing).get(1)?.getPosition(), LEAP_TARGET)
  const walking = simulator.at(landing + 10).get(1)?.getPosition()
  assertClose(walking?.x ?? 0, LEAP_TARGET.x)
  assertClose(walking?.y ?? 0, 100 + getChampion('t-archer').moveSpeed * 10 / GAME_TPS)
})

test('a dash is clamped to the arena and a late order recomputes it', () => {
  const simulator = createArcherDuel({ x: 500, y: 300 })
  simulator.at(40)
  // Added after tick 40 was computed, so every later frame is invalidated and replayed.
  assert.equal(simulator.addOrder(1, cast(1, 30, 't-leap', { mode: 'point', point: { x: 10, y: 100 } })), true)

  const radius = getChampion('t-archer').radius
  assert.deepEqual(simulator.at(60).get(1)?.getPosition(), { x: radius, y: 100 })
})

test('dying ends a dash where the character stood', () => {
  const simulator = createArcherDuel()
  simulator.addOrder(1, cast(1, 1, 't-leap', { mode: 'point', point: LEAP_TARGET }))
  simulator.at(5)
  assert.equal(simulator.addDeath(1, { tick: 8, respawnTick: 200 }), true)

  const dead = simulator.at(9).get(1)
  assert.equal(dead?.isDashing(), false)
  // Steps happen on ticks 2 through 8; the death on tick 8 only stops later ones.
  assertClose(dead?.getPosition().x ?? 0, 100 + LEAP_STEP * 7)
  assert.deepEqual(simulator.at(20).get(1)?.getPosition(), dead?.getPosition())
})

test('a checkpoint taken mid-dash restores the dash', () => {
  const build = (): Simulator => {
    const simulator = createArcherDuel()
    simulator.addOrder(1, cast(1, 1, 't-leap', { mode: 'point', point: LEAP_TARGET }))
    return simulator
  }
  const original = build()
  original.advanceTo(LEAP_TICKS)
  original.setCommitTick(LEAP_TICKS - 4)
  const snapshot = original.snapshot()
  assert.equal(snapshot.checkpoint.characters.find((c) => c.characterId === 1)?.dash?.speed, 600)
  assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)

  const restored = new Simulator()
  restored.replaceFromSnapshot(snapshot)
  const reference = build()
  for (let tick = LEAP_TICKS - 3; tick <= LEAP_TICKS + 12; tick += 1) {
    assert.deepEqual(restored.at(tick).get(1)?.getPosition(), reference.at(tick).get(1)?.getPosition(), `tick ${tick}`)
  }
})

test('each archer auto takes one second off leap\'s cooldown', () => {
  const simulator = createArcherDuel()
  simulator.addOrder(1, cast(1, 1, 't-leap', { mode: 'point', point: { x: 200, y: 100 } }))
  simulator.addOrder(1, attack(2, 20))
  const leap = getAbilityDef('t-leap')
  assert.ok(leap)

  // The auto is ordered on tick 20 and lands after its 3-tick windup.
  assert.equal(simulator.at(22).get(1)?.getAbilityCooldown('t-leap').ticksRemaining, 1 + leap.cooldownTicks - 22)
  assert.equal(simulator.at(23).get(1)?.getAbilityCooldown('t-leap').ticksRemaining, 1 + leap.cooldownTicks - 23 - 60)
})

test('focus adds attack speed and range for its duration only', () => {
  const focus = getAbilityDef('t-focus')
  assert.ok(focus)
  const archer = getChampion('t-archer')
  // Just past the archer's own range, inside the extra reach it has while focused.
  const simulator = createArcherDuel({ x: 100 + archer.attackRange + 60, y: 100 })
  simulator.addOrder(1, cast(1, 1, 't-focus', { mode: 'none' }))
  simulator.addOrder(1, attack(2, 5))
  simulator.addOrder(1, attack(3, 250))

  const status = simulator.at(2).get(1)?.getStatuses() ?? []
  assertClose(status.find((s) => s.kind === 'attackspeed')?.amount ?? 0, 0.4)
  assertClose(status.find((s) => s.kind === 'attackrange')?.amount ?? 0, 120)
  assert.equal(simulator.at(9).get(2)?.getHealth(), 1000 - archer.attackDamage, 'in range only while focused')
  // The cooldown after that auto is shortened: ceil(60 / 1.4) = 43 ticks.
  assert.equal(simulator.at(9).get(1)?.getNextAttackTick(), 5 + 43)

  assert.deepEqual(simulator.at(249).get(1)?.getStatuses(), [], 'focus has worn off')
  assert.equal(simulator.at(260).get(2)?.getHealth(), 1000 - archer.attackDamage, 'the later auto is out of range')
})

test('snare flies to the point and bursts into a field, taking longer the farther it goes', () => {
  const spawnTick = (distance: number): number | undefined => {
    const simulator = createArcherDuel({ x: 100, y: 400 })
    simulator.addOrder(1, cast(1, 1, 't-snare', { mode: 'point', point: { x: 100 + distance, y: 100 } }))
    for (let tick = 1; tick <= 80; tick += 1) {
      if (simulator.at(tick).getEntities().some((entity) => entity.defId === 't-snare-field')) return tick
    }
    return undefined
  }
  // Launch is on tick 5. The lob lives distance / 600 s, and its follow-up appears on the tick after.
  assert.equal(spawnTick(200), 5 + 20 + 1)
  assert.equal(spawnTick(400), 5 + 40 + 1)
})

test('snare lands exactly on the aimed point and the field slows enemies inside it', () => {
  const simulator = createArcherDuel({ x: 500, y: 100 })
  simulator.addOrder(1, cast(1, 1, 't-snare', { mode: 'point', point: { x: 500, y: 100 } }))

  assert.equal(simulator.at(25).getEntities()[0]?.defId, 't-snare-shot')
  const field = simulator.at(46).getEntities()
  assert.deepEqual(field.map((entity) => entity.defId), ['t-snare-field'])
  assert.deepEqual(field[0]?.origin, { x: 500, y: 100 })
  assertClose(simulator.at(48).get(2)?.getStatuses().find((s) => s.kind === 'slow')?.amount ?? 0, 0.4)
})

test('an entity can spawn another after a set timer instead of a distance', () => {
  const follow = spawnEntity({ id: 'test-timer-follow', speed: 0, radius: 5, lifetimeTicks: 30 })
  const timer = spawnEntity({ id: 'test-timer-first', speed: 0, radius: 5, lifetimeTicks: 10, onExpire: [follow] })
  const caster = new Champion({ ...brawler, onAttackHit: [timer] })
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, caster)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 }, brawler)
  simulator.addOrder(1, attack(1, 1))

  assert.deepEqual(simulator.at(5).getEntities().map((entity) => entity.defId), ['test-timer-first'])
  assert.deepEqual(simulator.at(11).getEntities().map((entity) => entity.defId), ['test-timer-first'])
  assert.deepEqual(simulator.at(12).getEntities().map((entity) => entity.defId), ['test-timer-follow'])
  assert.throws(() => spawnEntity({ id: 'test-no-lifetime', speed: 0, radius: 5 }), /needs lifetimeTicks, landAtAim or stayWhile/)
})

// Swordsman kit, against the copy in fixtures.ts. Positions and timings come from that champion.

const sword = getChampion('t-swordsman')
// Close enough to auto in melee, whatever the range is tuned to.
const SWORD_GAP = sword.attackRange - 30
const SWORD_AUTO_SPACING = sword.attackCooldownTicks + 5

function swordAutoTicks(count: number): number[] {
  return Array.from({ length: count }, (_, index) => 1 + index * SWORD_AUTO_SPACING)
}

function createSwordDuel(
  enemyPosition: Vector2 = { x: 100 + SWORD_GAP, y: 100 },
  enemy: Champion = brawler,
): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, sword)
  simulator.addPlayer(2, 'player-2', 'Player 2', enemyPosition, enemy)
  return simulator
}

function swordAutos(simulator: Simulator, count: number): void {
  swordAutoTicks(count).forEach((tick, index) => simulator.addOrder(1, attack(index + 1, tick)))
}

// A tick well after the last of `count` autos has landed (0 autos: the start).
function afterAutos(count: number): number {
  return count === 0 ? 1 : swordAutoTicks(count)[count - 1] + sword.attackWindupTicks + 15
}

function swordStacksOn(simulator: Simulator, tick: number): number {
  return simulator.at(tick).get(1)?.getMarkers().filter((marker) => marker.key === 'sword').length ?? 0
}

function enemyOrder(seq: number, tick: number, order: Record<string, unknown>): CharacterOrder {
  return { id: `player-2:${seq}`, seq, tick, ...order } as CharacterOrder
}

test('swordsman autos stack on the swordsman up to the cap, and each stack adds damage', () => {
  const simulator = createSwordDuel()
  swordAutos(simulator, 3 + 1)

  let expectedHealth = brawler.maxHp
  for (let hit = 1; hit <= 3 + 1; hit += 1) {
    const landing = swordAutoTicks(hit)[hit - 1] + sword.attackWindupTicks
    // The auto reads the stacks as they were before it, then adds one.
    expectedHealth -= sword.attackDamage + 25 * Math.min(hit - 1, 3)
    assert.equal(simulator.at(landing).get(2)?.getHealth(), expectedHealth, `auto ${hit}`)
    assert.equal(swordStacksOn(simulator, landing), Math.min(hit, 3), `stacks after auto ${hit}`)
  }
})

test('sword stacks expire together after their duration', () => {
  const simulator = createSwordDuel()
  swordAutos(simulator, 1)
  const landing = 1 + sword.attackWindupTicks

  assert.equal(swordStacksOn(simulator, landing + 480 - 1), 1)
  assert.equal(swordStacksOn(simulator, landing + 480), 0)
})

test('slash hits enemies on its line, harder with stacks, and misses those beside or behind it', () => {
  const slash = getAbilityDef('t-slash')
  assert.ok(slash)
  const slashDamage = (enemyAt: Vector2, stacks: number): number => {
    const simulator = createSwordDuel(enemyAt)
    swordAutos(simulator, stacks)
    const castTick = afterAutos(stacks)
    simulator.addOrder(1, cast(100, castTick, 't-slash', { mode: 'direction', dir: { x: 1, y: 0 } }))
    const launch = castTick + slash.windUpTicks
    const before = simulator.at(launch - 1).get(2)?.getHealth() ?? 0
    return before - (simulator.at(launch).get(2)?.getHealth() ?? 0)
  }

  const inFront = { x: 100 + SWORD_GAP, y: 100 }
  const base = slashDamage(inFront, 0)
  assert.ok(base > 0, 'it hits what is on the line')
  assert.equal(slashDamage({ x: 100, y: 100 + SWORD_GAP }, 0), 0, 'beside the line')
  assert.equal(slashDamage({ x: 100 - SWORD_GAP, y: 100 }, 0), 0, 'behind the caster')
  assert.equal(slashDamage(inFront, 2) - base, 2 * 25)
})

test('slash leaves a trail that slows enemies, hastes its owner only once, and fades', () => {
  const slash = getAbilityDef('t-slash')
  assert.ok(slash)
  const simulator = createSwordDuel()
  simulator.addOrder(1, cast(1, 1, 't-slash', { mode: 'direction', dir: { x: 1, y: 0 } }))
  const launch = 1 + slash.windUpTicks
  const trail = (tick: number) => simulator.at(tick).getEntities().filter((entity) => entity.defId === 't-slash-trail')

  assert.equal(trail(launch).length, 6)
  const early = simulator.at(launch + 2)
  assert.ok(early.get(2)?.getStatuses().some((status) => status.kind === 'slow'), 'the enemy on the trail is slowed')
  const startHaste = hasteOn(simulator, launch + 2)
  assert.ok(startHaste > 0, 'the owner standing in the trail is hasted')

  // Further along the trail two segments overlap; the haste is the same, not doubled.
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: launch + 3, type: 'move', target: { x: 200, y: 100 } })
  assertClose(hasteOn(simulator, launch + 90), startHaste)

  // The trail lasts three seconds and its effects wear off right after.
  const lifetime = (getEntityDef('t-slash-trail')?.lifetimeTicks ?? 0)
  assert.ok(lifetime > 90)
  assert.equal(trail(launch + lifetime).length, 6)
  assert.equal(trail(launch + lifetime + 1).length, 0)
  assert.equal(hasteOn(simulator, launch + lifetime + 4), 0)
})

test('radiance spends the stacks: damage and haste scale with how many there were', () => {
  const radiance = getAbilityDef('t-radiance')
  assert.ok(radiance)
  const radianceAfter = (stacks: number) => {
    const simulator = createSwordDuel()
    swordAutos(simulator, stacks)
    const castTick = afterAutos(stacks)
    simulator.addOrder(1, cast(100, castTick, 't-radiance', { mode: 'none' }))
    const launch = castTick + radiance.windUpTicks
    const stacksBefore = swordStacksOn(simulator, launch - 1)
    const healthBefore = simulator.at(launch - 1).get(2)?.getHealth() ?? 0
    const after = simulator.at(launch)
    return {
      stacksBefore,
      damage: healthBefore - (after.get(2)?.getHealth() ?? 0),
      haste: hasteOn(simulator, launch),
      stacksAfter: swordStacksOn(simulator, launch),
      flashes: after.getEntities().filter((entity) => entity.defId === 't-light-burst').length,
    }
  }

  const [none, one, two] = [0, 1, 2].map(radianceAfter)
  assert.deepEqual([none.stacksBefore, one.stacksBefore, two.stacksBefore], [0, 1, 2])
  assert.deepEqual([none.stacksAfter, one.stacksAfter, two.stacksAfter], [0, 0, 0], 'every stack is spent')
  assert.ok(none.damage > 0, 'it hurts even with no stacks')
  assert.ok(one.damage > none.damage)
  assert.equal(two.damage - one.damage, one.damage - none.damage, 'damage is linear in stacks')
  assert.equal(none.haste, 0)
  assert.ok(one.haste > 0)
  assertClose(two.haste, 2 * one.haste)
  assert.equal(one.flashes, 1)
})

test('shackle roots with fewer than three stacks, resets the auto, and a rooted enemy can still attack', () => {
  const shackle = getAbilityDef('t-shackle')
  assert.ok(shackle)
  const simulator = createSwordDuel()
  swordAutos(simulator, 1)
  const castTick = afterAutos(1)
  simulator.addOrder(1, cast(100, castTick, 't-shackle', { mode: 'unit', unitId: 2 }))
  const launch = castTick + shackle.windUpTicks
  // A rooted enemy can still attack; a valid attack stops its walk, so it asks to walk afterward.
  simulator.addOrder(2, enemyOrder(1, launch + 4, { type: 'attack', targetId: 1 }))
  simulator.addOrder(2, enemyOrder(2, launch + 8, { type: 'move', target: { x: 700, y: 100 } }))

  assert.equal(swordStacksOn(simulator, launch - 1), 1)
  const frame = simulator.at(launch)
  const root = frame.get(2)?.getStatuses().find((status) => status.kind === 'root')
  assert.ok(root, 'the enemy is rooted')
  assert.equal(frame.get(2)?.getStatuses().some((status) => status.kind === 'stun'), false)
  assert.equal(swordStacksOn(simulator, launch), 0, 'the stack was spent')
  assert.equal(frame.get(1)?.getNextAttackTick(), launch, 'the auto timer was reset')

  assert.equal(
    simulator.at(launch + 4).get(1)?.getHealth(),
    sword.maxHp - brawler.attackDamage,
    'the rooted enemy still attacked',
  )

  // It wants to walk away but cannot until the root runs out.
  const held = simulator.at(launch + 9).get(2)?.getPosition()
  assert.ok(held)
  assert.equal(simulator.at(root.endTick).get(2)?.getPosition().x, held.x)
  assert.ok((simulator.at(root.endTick + 5).get(2)?.getPosition().x ?? 0) > held.x, 'it walks once freed')
})

test('shackle with three stacks stuns instead: no attacks, no casts, and a windup is cancelled', () => {
  const shackle = getAbilityDef('t-shackle')
  const lash = getAbilityDef('t-lash')
  assert.ok(shackle && lash)
  const simulator = createSwordDuel()
  swordAutos(simulator, 3)
  const castTick = afterAutos(3)
  simulator.addOrder(1, cast(100, castTick, 't-shackle', { mode: 'unit', unitId: 2 }))
  const launch = castTick + shackle.windUpTicks
  // The enemy starts a lash just before the stun lands, then tries to act while stunned.
  simulator.addOrder(2, enemyOrder(1, launch - 2, {
    type: 'cast', abilityId: 't-lash', target: { mode: 'unit', unitId: 1 }, origin: { x: 100 + SWORD_GAP, y: 100 },
  }))
  simulator.addOrder(2, enemyOrder(2, launch + 10, { type: 'attack', targetId: 1 }))

  assert.equal(swordStacksOn(simulator, launch - 1), 3)
  assert.equal(simulator.at(launch - 1).get(2)?.getAction()?.kind, 'cast', 'the lash is winding up')
  const frame = simulator.at(launch)
  const stun = frame.get(2)?.getStatuses().find((status) => status.kind === 'stun')
  assert.ok(stun, 'three stacks stun')
  assert.equal(frame.get(2)?.getStatuses().some((status) => status.kind === 'root'), false)
  assert.equal(frame.get(2)?.getAction(), undefined, 'the windup was cancelled')
  assert.equal(swordStacksOn(simulator, launch), 0)

  const hpWhileStunned = simulator.at(stun.endTick - 1).get(1)?.getHealth()
  assert.equal(hpWhileStunned, sword.maxHp, 'neither the lash nor the attack landed')
  assert.equal(simulator.at(stun.endTick - 1).get(2)?.getAbilityCooldown('t-lash').ready, true, 'the lash was not spent')
})

test('a rooted character cannot leap but can still attack', () => {
  const archer = getChampion('t-archer')
  const shackle = getAbilityDef('t-shackle')
  assert.ok(shackle)
  const archerAt = { x: 100 + SWORD_GAP, y: 100 }
  const simulator = createSwordDuel(archerAt, archer)
  simulator.addOrder(1, cast(100, 1, 't-shackle', { mode: 'unit', unitId: 2 }))
  const launch = 1 + shackle.windUpTicks
  simulator.addOrder(2, enemyOrder(1, launch + 5, {
    type: 'cast', abilityId: 't-leap', target: { mode: 'point', point: { x: archerAt.x + 50, y: 100 } }, origin: archerAt,
  }))
  simulator.addOrder(2, enemyOrder(2, launch + 8, { type: 'attack', targetId: 1 }))

  assert.ok(simulator.at(launch).get(2)?.getStatuses().some((status) => status.kind === 'root'))
  const afterLeapTry = simulator.at(launch + 7).get(2)
  assert.equal(afterLeapTry?.isDashing(), false)
  assert.deepEqual(afterLeapTry?.getPosition(), archerAt)
  assert.equal(afterLeapTry?.getAbilityCooldown('t-leap').ready, true, 'the leap was refused, not spent')
  assert.equal(
    simulator.at(launch + 8 + archer.attackWindupTicks).get(1)?.getHealth(),
    sword.maxHp - archer.attackDamage,
    'the rooted archer still attacks',
  )
})

test('stuns, roots, trails and stacks survive checkpoint restores', () => {
  const build = (): Simulator => {
    const simulator = createSwordDuel()
    swordAutos(simulator, 3)
    simulator.addOrder(1, cast(100, 141, 't-shackle', { mode: 'unit', unitId: 2 }))
    simulator.addOrder(1, cast(101, 200, 't-slash', { mode: 'direction', dir: { x: 1, y: 0 } }))
    return simulator
  }
  const frameOf = (simulator: Simulator, tick: number): string => {
    const frame = simulator.at(tick)
    return JSON.stringify([
      frame.get(2)?.getStatuses(),
      frame.get(2)?.getPosition(),
      frame.get(1)?.getMarkers(),
      frame.get(1)?.getStatuses(),
      frame.getEntities().length,
    ])
  }
  const reference = build()
  const expected = new Map<number, string>()
  for (let tick = 1; tick <= 280; tick += 1) expected.set(tick, frameOf(reference, tick))

  // One checkpoint while the stun is active, one after the trail is out.
  const original = build()
  original.advanceTo(150)
  original.setCommitTick(142)
  const duringStun = original.snapshot()
  original.advanceTo(215)
  original.setCommitTick(208)
  const withTrail = original.snapshot()

  for (const [snapshot, committed] of [[duringStun, 142], [withTrail, 208]] as const) {
    assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)
    const restored = new Simulator()
    restored.replaceFromSnapshot(snapshot)
    for (let tick = committed + 1; tick <= 280; tick += 1) {
      assert.equal(frameOf(restored, tick), expected.get(tick), `tick ${tick}`)
    }
  }
})

test('an entity can only be laid along a line if it is stationary', () => {
  assert.throws(
    () => spawnEntity({ id: 'test-moving-line', speed: 100, radius: 5, lifetimeTicks: 5 }, { line: { length: 100, count: 3 } }),
    /must be stationary/,
  )
})

// Capricorn kit. Positions, damage and timings come from the champion and ability data.

const capricorn = getChampion('t-capricorn')
// Close enough to auto, whatever the range is tuned to.
const CAP_GAP = capricorn.attackRange - 40

function createCapricornDuel(
  enemyPosition: Vector2 = { x: 100 + CAP_GAP, y: 100 },
  enemy: Champion = brawler,
): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, capricorn)
  simulator.addPlayer(2, 'player-2', 'Player 2', enemyPosition, enemy)
  return simulator
}

function markerCount(simulator: Simulator, tick: number, key: string, unitId: number): number {
  return simulator.at(tick).get(unitId)?.getMarkers().filter((marker) => marker.key === key).length ?? 0
}

// Casts a harmless spell: a gale far from the enemy, which still counts as casting.
function castHarmlessGale(seq: number, tick: number): CharacterOrder {
  return cast(seq, tick, 't-gale', { mode: 'point', point: { x: 100, y: 300 } })
}

test('the next auto after a spell deals bonus damage once, and casting twice does not stack it', () => {
  const gale = getAbilityDef('t-gale')
  assert.ok(gale)
  const simulator = createCapricornDuel()
  simulator.addOrder(1, castHarmlessGale(1, 1))
  simulator.addOrder(1, attack(2, 20))
  simulator.addOrder(1, attack(3, 100))
  const launch = 1 + gale.windUpTicks
  const firstLanding = 20 + capricorn.attackWindupTicks
  const secondLanding = 100 + capricorn.attackWindupTicks

  assert.equal(markerCount(simulator, launch - 1, 'empowered', 1), 0)
  assert.equal(markerCount(simulator, launch, 'empowered', 1), 1, 'the cast empowers the caster')
  const beforeFirst = simulator.at(firstLanding - 1).get(2)?.getHealth() ?? 0
  const afterFirst = simulator.at(firstLanding).get(2)?.getHealth() ?? 0
  assert.equal(beforeFirst - afterFirst, capricorn.attackDamage + 70)
  assert.equal(markerCount(simulator, firstLanding, 'empowered', 1), 0, 'the auto spent it')

  const beforeSecond = simulator.at(secondLanding - 1).get(2)?.getHealth() ?? 0
  const afterSecond = simulator.at(secondLanding).get(2)?.getHealth() ?? 0
  assert.equal(beforeSecond - afterSecond, capricorn.attackDamage, 'the next auto is plain')
})

test('two spells before an auto still give a single bonus, and the bonus fades if unused', () => {
  const gale = getAbilityDef('t-gale')
  assert.ok(gale)
  const twoSpells = createCapricornDuel()
  twoSpells.addOrder(1, castHarmlessGale(1, 1))
  twoSpells.addOrder(1, cast(2, 20, 't-bubbles', { mode: 'direction', dir: { x: 0, y: 1 } }))
  twoSpells.addOrder(1, attack(3, 40))
  const landing = 40 + capricorn.attackWindupTicks
  assert.equal(markerCount(twoSpells, 24 + 4, 'empowered', 1), 1, 'still a single empowerment')
  const before = twoSpells.at(landing - 1).get(2)?.getHealth() ?? 0
  assert.equal(before - (twoSpells.at(landing).get(2)?.getHealth() ?? 0), capricorn.attackDamage + 70)

  const unused = createCapricornDuel()
  unused.addOrder(1, castHarmlessGale(1, 1))
  const launch = 1 + gale.windUpTicks
  assert.equal(markerCount(unused, launch + 360 - 1, 'empowered', 1), 1)
  assert.equal(markerCount(unused, launch + 360, 'empowered', 1), 0)
})

test('tsunami damages, knocks back along the wave, and cancels a windup, but not for what it misses', () => {
  const tsunami = getAbilityDef('t-tsunami')
  assert.ok(tsunami)
  const east = { mode: 'direction', dir: { x: 1, y: 0 } } as const
  const enemyAt = { x: 100 + CAP_GAP, y: 100 }
  const firstHitTick = (simulator: Simulator, from: number): number | undefined => {
    for (let tick = from; tick < from + 80; tick += 1) {
      if ((simulator.at(tick).get(2)?.getHealth() ?? 0) < brawler.maxHp) return tick
    }
    return undefined
  }

  // Find when the wave arrives, then replay with the enemy winding up a lash just before.
  const probe = createCapricornDuel(enemyAt)
  probe.addOrder(1, cast(1, 1, 't-tsunami', east))
  const hit = firstHitTick(probe, 1 + tsunami.windUpTicks)
  assert.ok(hit, 'the wave reaches the enemy')

  const simulator = createCapricornDuel(enemyAt)
  simulator.addOrder(1, cast(1, 1, 't-tsunami', east))
  simulator.addOrder(2, enemyOrder(1, hit - 3, {
    type: 'cast', abilityId: 't-lash', target: { mode: 'unit', unitId: 1 }, origin: enemyAt,
  }))
  assert.equal(simulator.at(hit - 1).get(2)?.getAction()?.kind, 'cast', 'the lash is winding up')
  const struck = simulator.at(hit).get(2)
  assert.equal(struck?.getHealth(), brawler.maxHp - 130)
  assert.equal(struck?.isDashing(), true, 'it is being shoved')
  assert.equal(struck?.getAction(), undefined, 'the windup was interrupted')

  const shoveTicks = Math.ceil(140 / (700 / GAME_TPS))
  const landed = simulator.at(hit + shoveTicks).get(2)
  assert.equal(landed?.isDashing(), false)
  assertClose(landed?.getPosition().x ?? 0, enemyAt.x + 140)
  assert.equal(landed?.getPosition().y, enemyAt.y, 'pushed along the wave, not sideways')
  assert.equal(simulator.at(hit + shoveTicks).get(1)?.getHealth(), capricorn.maxHp, 'the lash never landed')
  assert.equal(landed?.getAbilityCooldown('t-lash').ready, true, 'the interrupted lash was not spent')

  const beside = createCapricornDuel({ x: enemyAt.x, y: 100 + CAP_GAP })
  beside.addOrder(1, cast(1, 1, 't-tsunami', east))
  assert.equal(firstHitTick(beside, 1 + tsunami.windUpTicks), undefined, 'a target off the path is untouched')
})

test('knockback without a direction pushes away from where it came from', () => {
  const pusher = new Champion({ ...brawler, onAttackHit: [knockback(100, 600)] })
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, pusher)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 }, brawler)
  simulator.addOrder(1, attack(1, 1))

  assert.equal(simulator.at(1).get(2)?.isDashing(), true)
  const landing = simulator.at(1 + Math.ceil(100 / (600 / GAME_TPS))).get(2)
  assertClose(landing?.getPosition().x ?? 0, 240)
  assertClose(landing?.getPosition().y ?? 0, 100)
})

test('bubbles start one after another, first hit full damage and the rest reduced', () => {
  const bubbles = getAbilityDef('t-bubbles')
  assert.ok(bubbles)
  const simulator = createCapricornDuel()
  simulator.addOrder(1, cast(1, 1, 't-bubbles', { mode: 'direction', dir: { x: 1, y: 0 } }))
  const launch = 1 + bubbles.windUpTicks

  const starts = simulator.at(launch).getEntities().map((entity) => entity.startTick)
  assert.deepEqual(starts, Array.from({ length: 5 }, (_, index) => launch + index * 5))

  const hits: number[] = []
  let lastHealth = brawler.maxHp
  for (let tick = launch + 1; tick <= launch + 90; tick += 1) {
    const health = simulator.at(tick).get(2)?.getHealth() ?? 0
    if (health < lastHealth) hits.push(lastHealth - health)
    lastHealth = health
  }
  assert.equal(hits.length, 5, 'every bubble connects')
  assert.equal(hits[0], 140)
  assert.deepEqual(hits.slice(1), Array(5 - 1).fill(140 * 0.5))
  assert.equal(simulator.at(launch + 91).getEntities().length, 0, 'each bubble pops on its hit')
})

test('a second cast of bubbles starts at full damage again', () => {
  const bubbles = getAbilityDef('t-bubbles')
  assert.ok(bubbles)
  const simulator = createCapricornDuel()
  const secondCast = 1 + bubbles.cooldownTicks + 10
  simulator.addOrder(1, cast(1, 1, 't-bubbles', { mode: 'direction', dir: { x: 1, y: 0 } }))
  simulator.addOrder(1, cast(2, secondCast, 't-bubbles', { mode: 'direction', dir: { x: 1, y: 0 } }))
  const launch = secondCast + bubbles.windUpTicks

  let lastHealth = simulator.at(launch).get(2)?.getHealth() ?? 0
  const hits: number[] = []
  for (let tick = launch + 1; tick <= launch + 90; tick += 1) {
    const health = simulator.at(tick).get(2)?.getHealth() ?? 0
    if (health < lastHealth) hits.push(lastHealth - health)
    lastHealth = health
  }
  assert.equal(hits[0], 140)
})

test('gale hurts more with every pulse a target stays in it, up to a cap, and follows the aimed point', () => {
  const gale = getAbilityDef('t-gale')
  assert.ok(gale)
  const center = { x: 100 + CAP_GAP, y: 100 }
  const simulator = createCapricornDuel(center)
  simulator.addOrder(1, cast(1, 1, 't-gale', { mode: 'point', point: center }))
  const launch = 1 + gale.windUpTicks

  assert.deepEqual(simulator.at(launch).getEntities()[0]?.origin, center, 'it appears where it was aimed')
  const pulses: number[] = []
  let lastHealth = brawler.maxHp
  for (let tick = launch + 1; tick <= launch + 240; tick += 1) {
    const health = simulator.at(tick).get(2)?.getHealth() ?? 0
    if (health < lastHealth) pulses.push(lastHealth - health)
    lastHealth = health
  }
  assert.equal(pulses.length, 240 / 20)
  pulses.forEach((damage, pulse) => {
    assert.equal(damage, 15 + 15 * Math.min(pulse, 5), `pulse ${pulse + 1}`)
  })
  assert.equal(simulator.at(launch + 241).getEntities().length, 0)
})

test('gale reads each target\'s own time in the wind, and the stacks fade after it leaves', () => {
  const gale = getAbilityDef('t-gale')
  assert.ok(gale)
  const center = { x: 100 + CAP_GAP, y: 100 }
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, capricorn)
  simulator.addPlayer(2, 'player-2', 'Player 2', center, brawler)
  // The second enemy starts well outside the field and walks in later.
  simulator.addPlayer(3, 'player-3', 'Player 3', { x: center.x + 330, y: 100 }, brawler)
  simulator.addOrder(1, cast(1, 1, 't-gale', { mode: 'point', point: center }))
  const launch = 1 + gale.windUpTicks
  simulator.addOrder(3, { id: 'player-3:1', seq: 1, tick: launch + 10, type: 'move', target: center })

  let health = { 2: brawler.maxHp, 3: brawler.maxHp }
  let compared = false
  for (let tick = launch + 1; tick <= launch + 240 && !compared; tick += 1) {
    const frame = simulator.at(tick)
    const now = { 2: frame.get(2)?.getHealth() ?? 0, 3: frame.get(3)?.getHealth() ?? 0 }
    const lostA = health[2] - now[2]
    const lostB = health[3] - now[3]
    if (lostB > 0) {
      assert.equal(lostB, 15, 'the newcomer starts at the bottom of the ramp')
      assert.ok(lostA > lostB, 'the one who has been there longer takes more in the same pulse')
      compared = true
    }
    health = now
  }
  assert.ok(compared, 'the second enemy did walk into the wind')
})

test('gale stacks fade a moment after a target leaves the wind', () => {
  const gale = getAbilityDef('t-gale')
  assert.ok(gale)
  const center = { x: 100 + CAP_GAP, y: 100 }
  const simulator = createCapricornDuel(center)
  simulator.addOrder(1, cast(1, 1, 't-gale', { mode: 'point', point: center }))
  const launch = 1 + gale.windUpTicks
  simulator.addOrder(2, enemyOrder(1, launch + 3 * 20 + 5, { type: 'move', target: { x: center.x, y: 400 } }))

  assert.ok(markerCount(simulator, launch + 3 * 20 + 2, 'gale', 2) >= 2, 'it built up stacks')
  assert.equal(markerCount(simulator, launch + 3 * 20 + 5 + 160, 'gale', 2), 0, 'and lost them once clear')
})

test('stacks, pending bubbles, shoves and gale survive checkpoint restores', () => {
  const build = (): Simulator => {
    const simulator = createCapricornDuel()
    simulator.addOrder(1, cast(1, 1, 't-bubbles', { mode: 'direction', dir: { x: 1, y: 0 } }))
    simulator.addOrder(1, cast(2, 100, 't-gale', { mode: 'point', point: { x: 100 + CAP_GAP, y: 100 } }))
    simulator.addOrder(1, cast(3, 300, 't-tsunami', { mode: 'direction', dir: { x: 1, y: 0 } }))
    return simulator
  }
  const frameOf = (simulator: Simulator, tick: number): string => {
    const frame = simulator.at(tick)
    return JSON.stringify([
      frame.get(2)?.getHealthState(),
      frame.get(2)?.getMarkers(),
      frame.get(2)?.getPosition(),
      frame.get(2)?.isDashing(),
      frame.get(1)?.getMarkers(),
      frame.getEntities().map((entity) => [entity.id, entity.startTick]),
    ])
  }
  const reference = build()
  const expected = new Map<number, string>()
  for (let tick = 1; tick <= 360; tick += 1) expected.set(tick, frameOf(reference, tick))

  // One checkpoint with bubbles still waiting, one with gale stacks built up, one mid-shove.
  const original = build()
  original.advanceTo(12)
  original.setCommitTick(6)
  const withPendingBubbles = original.snapshot()
  original.advanceTo(180)
  original.setCommitTick(172)
  const withGale = original.snapshot()
  for (let tick = 190; tick <= 360; tick += 1) {
    if (frameOf(original, tick) !== expected.get(tick)) assert.fail(`original diverged at ${tick}`)
  }

  for (const [snapshot, committed] of [[withPendingBubbles, 6], [withGale, 172]] as const) {
    assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)
    const restored = new Simulator()
    restored.replaceFromSnapshot(snapshot)
    for (let tick = committed + 1; tick <= 360; tick += 1) {
      assert.equal(frameOf(restored, tick), expected.get(tick), `tick ${tick}`)
    }
  }
})

test('an entity with pulse effects must say how often they pulse', () => {
  assert.throws(
    () => spawnEntity({ id: 'test-pulse-no-interval', speed: 0, radius: 5, lifetimeTicks: 5, onPulse: [] }),
    /no pulseEveryTicks/,
  )
})

// Rectangular hitboxes

test('a circle touches a box through its sides, ends and rounded corners', () => {
  const box = { halfLength: 20, halfWidth: 75 }
  const east = { x: 1, y: 0 }
  const at = { x: 0, y: 0 }
  const radius = 18

  assert.equal(boxTouchesCircle(at, east, box, { x: 0, y: 0 }, radius), true, 'inside')
  assert.equal(boxTouchesCircle(at, east, box, { x: 0, y: 75 + radius - 1 }, radius), true, 'just inside a long side')
  assert.equal(boxTouchesCircle(at, east, box, { x: 0, y: 75 + radius + 1 }, radius), false, 'just past a long side')
  assert.equal(boxTouchesCircle(at, east, box, { x: 20 + radius - 1, y: 0 }, radius), true, 'just inside an end')
  assert.equal(boxTouchesCircle(at, east, box, { x: 20 + radius + 1, y: 0 }, radius), false, 'just past an end')
  // Near a corner each axis is within reach, but the circle only touches the rounded corner.
  assert.equal(boxTouchesCircle(at, east, box, { x: 20 + 12, y: 75 + 12 }, radius), true, 'touching the corner')
  assert.equal(boxTouchesCircle(at, east, box, { x: 20 + 14, y: 75 + 14 }, radius), false, 'diagonally clear of the corner')
})

test('a box turns with its facing', () => {
  const box = { halfLength: 20, halfWidth: 75 }
  const south = { x: 0, y: 1 }
  const at = { x: 0, y: 0 }
  // Facing south, the long side runs east to west and the short side north to south.
  assert.equal(boxTouchesCircle(at, south, box, { x: 60, y: 0 }, 18), true, 'wide across')
  assert.equal(boxTouchesCircle(at, south, box, { x: 0, y: 37 }, 18), true, 'within reach of the end')
  assert.equal(boxTouchesCircle(at, south, box, { x: 0, y: 60 }, 18), false, 'but thin along its facing')
  const diagonal = { x: Math.SQRT1_2, y: Math.SQRT1_2 }
  assert.equal(boxTouchesCircle(at, diagonal, box, { x: 10, y: 10 }, 18), true)
  assert.equal(boxTouchesCircle(at, diagonal, box, { x: 60, y: 60 }, 18), false, 'far ahead along the diagonal')
  assert.equal(boxTouchesCircle(at, diagonal, box, { x: 40, y: -40 }, 18), true, 'out along the wide side')
})

test('tsunami is as wide as its box: hits a target to either side of the middle, misses beyond', () => {
  const tsunami = getAbilityDef('t-tsunami')
  assert.ok(tsunami)
  const hits = (lateralOffset: number): boolean => {
    // Mid-arena, so the enemy has room on both sides of the wave's path.
    const middle = { x: 100, y: 225 }
    const simulator = new Simulator()
    simulator.addPlayer(1, 'player-1', 'Player 1', middle, capricorn)
    simulator.addPlayer(2, 'player-2', 'Player 2', { x: middle.x + CAP_GAP, y: middle.y + lateralOffset }, brawler)
    simulator.addOrder(1, cast(1, 1, 't-tsunami', { mode: 'direction', dir: { x: 1, y: 0 } }, middle))
    const start = 1 + tsunami.windUpTicks
    for (let tick = start; tick < start + 80; tick += 1) {
      if ((simulator.at(tick).get(2)?.getHealth() ?? 0) < brawler.maxHp) return true
    }
    return false
  }
  const reach = 150 / 2 + brawler.radius

  assert.equal(hits(0), true)
  assert.equal(hits(reach - 3), true, 'just inside one edge')
  assert.equal(hits(-(reach - 3)), true, 'just inside the other')
  assert.equal(hits(reach + 3), false, 'just outside one edge')
  assert.equal(hits(-(reach + 3)), false, 'just outside the other')
})

test('tsunami\'s box carries its heading, so a diagonal wave and a restored checkpoint agree', () => {
  const tsunami = getAbilityDef('t-tsunami')
  assert.ok(tsunami)
  const south = { mode: 'direction', dir: { x: 0, y: 1 } } as const
  const build = (): Simulator => {
    const simulator = createCapricornDuel({ x: 100, y: 100 + CAP_GAP })
    simulator.addOrder(1, cast(1, 1, 't-tsunami', south))
    return simulator
  }
  const launch = 1 + tsunami.windUpTicks
  const healthTrace = (simulator: Simulator, from: number, to: number): number[] => {
    const trace: number[] = []
    for (let tick = from; tick <= to; tick += 1) trace.push(simulator.at(tick).get(2)?.getHealth() ?? -1)
    return trace
  }

  const reference = build()
  assert.deepEqual(reference.at(launch).getEntities()[0]?.facing, { x: 0, y: 1 })
  const expected = healthTrace(reference, launch + 3, launch + 60)
  assert.ok(expected.at(-1)! < brawler.maxHp, 'the wave heading south reaches the enemy below')

  const original = build()
  original.advanceTo(launch + 8)
  original.setCommitTick(launch + 2)
  const snapshot = original.snapshot()
  assert.deepEqual(snapshot.checkpoint.entities[0]?.facing, { x: 0, y: 1 })
  // The client reads snapshots through the schema, which would drop a field it does not list.
  const received = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))
  assert.deepEqual(received.checkpoint.entities[0]?.facing, { x: 0, y: 1 })

  const restored = new Simulator()
  restored.replaceFromSnapshot(received)
  assert.deepEqual(healthTrace(restored, launch + 3, launch + 60), expected)
})

test('a stationary box points the way it was aimed and hits across its width', () => {
  const wall = spawnEntity({
    id: 'test-box-wall',
    speed: 0,
    box: { halfLength: 5, halfWidth: 60 },
    lifetimeTicks: 30,
    pierce: true,
    onHit: [damage(10)],
  })
  const builder = new Champion({ ...brawler, onAttackHit: [wall] })
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, builder)
  // The aim target is straight south, so the wall faces south: thin north to south, wide east to west.
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 100, y: 200 }, brawler)
  simulator.addPlayer(3, 'player-3', 'Player 3', { x: 170, y: 100 }, brawler)
  simulator.addOrder(1, attack(1, 1))

  const facing = simulator.at(1).getEntities()[0]?.facing
  assert.ok(facing)
  assertClose(facing.x, 0)
  assertClose(facing.y, 1)
  assert.equal(simulator.at(3).get(3)?.getHealth(), brawler.maxHp - 10, 'the bystander across the wall is hit')
  assert.equal(simulator.at(3).get(2)?.getHealth(), brawler.maxHp, 'the aimed target is not on the wall')
})

test('an entity definition has a radius or a box, not both and not neither', () => {
  const box = { halfLength: 5, halfWidth: 5 }
  assert.throws(
    () => spawnEntity({ id: 'test-no-shape', speed: 0, lifetimeTicks: 5 } as never),
    /either a radius or a box/,
  )
  assert.throws(
    () => spawnEntity({ id: 'test-both-shapes', speed: 0, lifetimeTicks: 5, radius: 5, box } as never),
    /either a radius or a box/,
  )
})

test('the server accepts casts from the picked champion\'s kit and rejects other abilities', () => {
  const game = new ServerGameState()
  const players = [{ id: 'player-1', name: 'One' }, { id: 'player-2', name: 'Two' }]
  game.beginSelection(players)
  game.pickChampion('player-1', 't-cursebearer')
  game.lockChampion('player-1')
  game.lockChampion('player-2')
  game.begin(players)
  const characterId = game.getCharacterId('player-1')
  assert.ok(characterId)
  const origin = game.simulator.at(0).get(characterId)?.getPosition()
  assert.ok(origin)

  const send = (seq: number, abilityId: string, target: CastTarget) => game.acceptOrder('player-1', {
    id: `player-1:${seq}`, seq, tick: seq, type: 'cast', abilityId, target, origin,
  })
  const accepted = send(1, 't-miasma', { mode: 'none' })
  assert.equal(accepted.ack.status, 'accepted')
  assert.equal(accepted.broadcast?.type, 'cast')
  assert.equal(send(2, 't-feast', { mode: 'unit', unitId: 2 }).ack.status, 'accepted')
  assert.equal(send(3, 't-leap', { mode: 'point', point: origin }).ack.reason, 'unknown_ability', 'another champion\'s ability')
  assert.equal(send(4, 'fireball', { mode: 'none' }).ack.reason, 'unknown_ability', 'an ability that does not exist')
})

// A rectangular field. The test cutter's trail is one box, 300 long and 60 wide, laid from the
// caster along the cast direction, and its effects find who is inside that same box.

const CUT_FROM = { x: 100, y: 100 }

function createCutSim(enemies: Vector2[], casterAt: Vector2 = CUT_FROM): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', casterAt, cutter)
  enemies.forEach((position, index) => {
    simulator.addPlayer(index + 2, `player-${index + 2}`, `Player ${index + 2}`, position, brawler)
  })
  return simulator
}

function castCut(simulator: Simulator, dir: Vector2, from: Vector2 = CUT_FROM): number {
  const cut = getAbilityDef('t-cut')
  assert.ok(cut)
  simulator.addOrder(1, cast(1, 1, 't-cut', { mode: 'direction', dir }, from))
  return 1 + cut.windUpTicks
}

function isSlowed(simulator: Simulator, tick: number, unitId: number): boolean {
  return simulator.at(tick).get(unitId)?.getStatuses().some((status) => status.kind === 'slow') ?? false
}

test('the trail is one rectangle where the cut landed, pointing the way it was aimed', () => {
  const east = createCutSim([{ x: 700, y: 400 }])
  const launchEast = castCut(east, { x: 1, y: 0 })
  const eastTrail = east.at(launchEast).getEntities()
  assert.deepEqual(eastTrail.map((entity) => entity.defId), ['t-cut-trail'], 'a single entity, not a line of circles')
  assert.deepEqual(eastTrail[0]?.origin, { x: 250, y: 100 }, 'centred half the cut ahead of the caster')
  assert.deepEqual(eastTrail[0]?.facing, { x: 1, y: 0 })

  const south = createCutSim([{ x: 700, y: 400 }])
  const launchSouth = castCut(south, { x: 0, y: 1 })
  const southTrail = south.at(launchSouth).getEntities()[0]
  assert.deepEqual(southTrail?.origin, { x: 100, y: 250 })
  assert.deepEqual(southTrail?.facing, { x: 0, y: 1 })
})

test('the trail slows what is inside its rectangle and nothing beside, beyond or behind it', () => {
  // The cut points east from (100, 100): the box spans x 100..400 and y 70..130, grown by a
  // unit's radius of 18 for who it touches.
  const inside = { x: 200, y: 100 }
  const nearEdge = { x: 200, y: 100 + 30 + 18 - 4 }
  const nearEnd = { x: 100 + 300 + 18 - 4, y: 100 }
  const beside = { x: 200, y: 100 + 30 + 18 + 6 }
  const pastEnd = { x: 100 + 300 + 18 + 6, y: 100 }
  const behind = { x: 100 - 40, y: 100 }
  const simulator = createCutSim([inside, nearEdge, nearEnd, beside, pastEnd, behind])
  const launch = castCut(simulator, { x: 1, y: 0 })

  assert.equal(isSlowed(simulator, launch + 2, 2), true, 'inside')
  assert.equal(isSlowed(simulator, launch + 2, 3), true, 'just inside a long side')
  assert.equal(isSlowed(simulator, launch + 2, 4), true, 'just inside the far end')
  assert.equal(isSlowed(simulator, launch + 2, 5), false, 'just beside a long side')
  assert.equal(isSlowed(simulator, launch + 2, 6), false, 'just past the far end')
  assert.equal(isSlowed(simulator, launch + 2, 7), false, 'behind the caster')
})

test('a trail cast south is a south-pointing rectangle: it reaches far south and not sideways', () => {
  // Cast south, the box is centred at (100, 250) and spans y 100..400 and x 70..130. These two
  // are placed so an east-pointing box (x -50..250, y 220..280) would get both of them wrong.
  const farSouth = { x: 100, y: 370 }
  const aside = { x: 200, y: 250 }
  const simulator = createCutSim([farSouth, aside])
  const launch = castCut(simulator, { x: 0, y: 1 })

  assert.equal(isSlowed(simulator, launch + 2, 2), true, 'down the length of the rotated rectangle')
  assert.equal(isSlowed(simulator, launch + 2, 3), false, 'level with its middle but off to the side')
})

test('the trail hastes its owner once while inside it, and the haste ends after leaving', () => {
  const simulator = createCutSim([{ x: 700, y: 400 }])
  const launch = castCut(simulator, { x: 1, y: 0 })
  const hasteBonus = (tick: number): number =>
    simulator.at(tick).get(1)?.getStatuses().filter((s) => s.kind === 'haste').reduce((sum, s) => sum + s.amount, 0) ?? 0

  assertClose(hasteBonus(launch + 2), 0.4)
  // Walk straight out of the side of the rectangle.
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: launch + 3, type: 'move', target: { x: 100, y: 330 } })
  assert.equal(hasteBonus(launch + 70), 0, 'the owner is well clear of the trail now')
})

test('the instant cut is a rectangle with square ends, so a unit off its corner is missed', () => {
  // A unit just behind the caster's start line and beside the cut. A rounded end would reach it;
  // the rectangle's corner is farther than the unit's radius from its centre.
  const offCorner = { x: 100 - 14, y: 100 + 30 + 14 }
  const touchingCorner = { x: 100 - 9, y: 100 + 30 + 8 }
  const missed = createCutSim([offCorner])
  const hit = createCutSim([touchingCorner])
  const launch = castCut(missed, { x: 1, y: 0 })
  castCut(hit, { x: 1, y: 0 })

  assert.equal(missed.at(launch).get(2)?.getHealth(), brawler.maxHp, 'clear of the corner')
  assert.equal(hit.at(launch).get(2)?.getHealth(), brawler.maxHp - 120, 'touching the corner')
})

// Spout. A circle is marked at the aimed point and erupts after a warning, hurting and slowing
// whatever is still standing in it. The test spouter's warning lasts 42 ticks.

const SPOUT_CASTER = { x: 100, y: 225 }
const SPOUT_AT = { x: 400, y: 225 }
const SPOUT_WARNING_TICKS = 42

function createSpoutSim(enemies: Vector2[]): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', SPOUT_CASTER, spouter)
  enemies.forEach((position, index) => {
    simulator.addPlayer(index + 2, `player-${index + 2}`, `Player ${index + 2}`, position, brawler)
  })
  return simulator
}

// Casts spout at a point and returns the tick the warning appears.
function castSpout(simulator: Simulator, at: Vector2 = SPOUT_AT): number {
  const spout = getAbilityDef('t-spout')
  assert.ok(spout)
  simulator.addOrder(1, cast(1, 1, 't-spout', { mode: 'point', point: at }, SPOUT_CASTER))
  return 1 + spout.windUpTicks
}

test('spout marks a warning circle at the aimed point, harmless until it runs out', () => {
  const simulator = createSpoutSim([SPOUT_AT])
  const launch = castSpout(simulator)

  const warning = simulator.at(launch).getEntities()
  assert.deepEqual(warning.map((entity) => entity.defId), ['t-spout-warning'])
  assert.deepEqual(warning[0]?.origin, SPOUT_AT, 'it is marked where it was aimed')
  // The enemy stands in the circle the whole time, and nothing happens to it yet.
  const lastWarningTick = launch + SPOUT_WARNING_TICKS
  const counting = simulator.at(lastWarningTick)
  assert.equal(counting.get(2)?.getHealth(), brawler.maxHp)
  assert.equal(counting.get(2)?.getStatuses().length, 0)
  assert.equal(counting.getEntities().length, 1, 'the warning is still showing')
})

test('spout erupts on the tick the warning ends, damaging and slowing what is inside', () => {
  const simulator = createSpoutSim([SPOUT_AT])
  const launch = castSpout(simulator)
  const eruption = launch + SPOUT_WARNING_TICKS + 1

  assert.equal(simulator.at(eruption - 1).get(2)?.getHealth(), brawler.maxHp)
  const erupted = simulator.at(eruption)
  assert.equal(erupted.get(2)?.getHealth(), brawler.maxHp - 220)
  const slow = erupted.get(2)?.getStatuses().find((status) => status.kind === 'slow')
  assert.ok(slow, 'the target is slowed')
  assertClose(slow.amount, 0.4)
  assert.equal(slow.endTick - eruption, 90, 'for a second and a half')
  assert.deepEqual(erupted.getEntities().map((entity) => entity.defId), ['t-spout-burst'], 'the warning gives way to a flash')

  // The flash is brief and nothing else happens afterwards.
  assert.equal(simulator.at(eruption + 9).getEntities().length, 0)
  assert.equal(simulator.at(eruption + 30).get(2)?.getHealth(), brawler.maxHp - 220, 'it hits once')
})

test('stepping out of the circle before it erupts avoids all of it', () => {
  const simulator = createSpoutSim([SPOUT_AT])
  const launch = castSpout(simulator)
  simulator.addOrder(2, enemyOrder(1, launch + 2, { type: 'move', target: { x: 700, y: 225 } }))
  const eruption = launch + SPOUT_WARNING_TICKS + 1

  const after = simulator.at(eruption + 1).get(2)
  assert.equal(after?.getHealth(), brawler.maxHp, 'it got clear in time')
  assert.equal(after?.getStatuses().some((status) => status.kind === 'slow'), false)
})

test('spout is a small circle: a unit just inside its edge is hit and one just outside is not', () => {
  // The circle has radius 65 and a unit's body adds 18 to the reach.
  const reach = 65 + brawler.radius
  const justInside = { x: SPOUT_AT.x, y: SPOUT_AT.y + reach - 3 }
  const justOutside = { x: SPOUT_AT.x, y: SPOUT_AT.y - reach - 3 }
  const simulator = createSpoutSim([justInside, justOutside])
  const launch = castSpout(simulator)
  const eruption = launch + SPOUT_WARNING_TICKS + 1

  const erupted = simulator.at(eruption)
  assert.equal(erupted.get(2)?.getHealth(), brawler.maxHp - 220, 'just inside')
  assert.equal(erupted.get(3)?.getHealth(), brawler.maxHp, 'just outside')
})

test('tsunami pushes up to its full distance, but no farther than 50 past where the wave stops', () => {
  const tsunami = getAbilityDef('t-tsunami')
  assert.ok(tsunami)
  // The test wave travels 480 px/s for 0.8 s from where it was cast, so it stops 384 px along.
  const waveStops = 100 + 480 * 0.8
  const expectedPush = (alongPath: number): number => Math.min(140, Math.max(0, waveStops - alongPath) + 50)

  // Casts a wave and returns how far the enemy ends up from where it stood, measured along the wave.
  const pushedAlong = (axis: 'x' | 'y', alongPath: number): { push: number; sideways: number } => {
    const dir = axis === 'x' ? { x: 1, y: 0 } : { x: 0, y: 1 }
    const enemyAt = axis === 'x' ? { x: alongPath, y: 100 } : { x: 100, y: alongPath }
    const simulator = createCapricornDuel(enemyAt)
    simulator.addOrder(1, cast(1, 1, 't-tsunami', { mode: 'direction', dir }))
    let hit = false
    for (let tick = 1 + tsunami.windUpTicks; tick < 1 + tsunami.windUpTicks + 160; tick += 1) {
      const enemy = simulator.at(tick).get(2)
      hit = hit || (enemy?.getHealth() ?? brawler.maxHp) < brawler.maxHp
      if (hit && enemy && !enemy.isDashing()) {
        const at = enemy.getPosition()
        return axis === 'x'
          ? { push: at.x - enemyAt.x, sideways: at.y - enemyAt.y }
          : { push: at.y - enemyAt.y, sideways: at.x - enemyAt.x }
      }
    }
    assert.fail(`the wave never reached an enemy ${alongPath} px along its path`)
  }

  for (const axis of ['x', 'y'] as const) {
    for (const alongPath of [260, 400, 440, 474, 500]) {
      const { push, sideways } = pushedAlong(axis, alongPath)
      assertClose(push, expectedPush(alongPath))
      assert.equal(sideways, 0, 'pushed along the wave, not off to one side')
    }
  }
  // Spot-check the ends of the range: early is the full 140, right at the end is much less.
  assertClose(pushedAlong('x', 260).push, 140)
  assertClose(pushedAlong('x', 474).push, 60)
  assertClose(pushedAlong('x', 500).push, 50)
})

test('a knockback with a cap does nothing special when its source does not travel', () => {
  const pusher = new Champion({ ...brawler, onAttackHit: [knockback(100, 600, subject(), { pastEnd: 10 })] })
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, pusher)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 }, brawler)
  simulator.addOrder(1, attack(1, 1))

  // An auto has no end of travel, so only the plain distance applies.
  const landing = simulator.at(1 + Math.ceil(100 / (600 / GAME_TPS))).get(2)
  assertClose(landing?.getPosition().x ?? 0, 240)
})

// Soldier. Up close its attack is a melee strike that does more; it can trade health for speed
// and resistance; its bolt pierces and scales with missing health; its medic bot shields and heals.

function createSoldierDuel(
  enemies: Vector2[],
  enemy: Champion = brawler,
  soldierChampion: Champion = soldier,
): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, soldierChampion)
  enemies.forEach((position, index) => {
    simulator.addPlayer(index + 2, `player-${index + 2}`, `Player ${index + 2}`, position, enemy)
  })
  return simulator
}

function healthOf(simulator: Simulator, tick: number, unitId: number): number {
  return simulator.at(tick).get(unitId)?.getHealth() ?? -1
}

test('the soldier\'s attack becomes a stronger melee strike against a target within 120', () => {
  const landing = 1 + soldier.attackWindupTicks
  const dealtAt = (distance: number): number => {
    const simulator = createSoldierDuel([{ x: 100 + distance, y: 100 }])
    simulator.addOrder(1, attack(1, 1))
    return healthOf(simulator, landing - 1, 2) - healthOf(simulator, landing, 2)
  }

  assert.equal(dealtAt(200), 60, 'at range')
  assert.equal(dealtAt(121), 60, 'just outside melee')
  assert.equal(dealtAt(120), 96, 'at the edge of melee: 60 plus 60% of it')
  assert.equal(dealtAt(40), 96, 'right up close')
})

test('stim costs health and gives attack speed, move speed and resistance for five seconds', () => {
  const simulator = createSoldierDuel([{ x: 700, y: 400 }])
  simulator.addOrder(1, cast(1, 1, 't-stim', { mode: 'none' }))

  const frame = simulator.at(1)
  assert.equal(frame.get(1)?.getHealth(), soldier.maxHp - 150)
  const amounts = Object.fromEntries((frame.get(1)?.getStatuses() ?? []).map((status) => [status.kind, status.amount]))
  assert.deepEqual(amounts, { attackspeed: 0.5, haste: 0.3, resist: 0.3 })
  assert.equal(frame.get(1)?.getStatuses().every((status) => status.endTick === 1 + 300), true)

  assert.equal(simulator.at(300).get(1)?.getStatuses().length, 3, 'still active on the last tick')
  assert.equal(simulator.at(301).get(1)?.getStatuses().length, 0, 'gone after five seconds')
})

test('stim\'s cost never kills: at low health it takes everything but the last point', () => {
  const fragile = new Champion({ ...soldier, maxHp: 100 })
  const simulator = createSoldierDuel([{ x: 700, y: 400 }], brawler, fragile)
  simulator.addOrder(1, cast(1, 1, 't-stim', { mode: 'none' }))

  assert.equal(healthOf(simulator, 1, 1), 1)
  assert.equal(simulator.at(1).get(1)?.isDead(), false)
})

test('resistance cuts damage taken, adds up to a cap of 90%, and acts before a shield', () => {
  const guarded = new Champion({ ...soldier, abilities: ['t-stim', 't-guard', 't-medic'] })
  const damageFromOneHit = (setup: (simulator: Simulator) => void): { hp: number; shield: number } => {
    const simulator = createSoldierDuel([{ x: 160, y: 100 }], brawler, guarded)
    setup(simulator)
    // Before the medic's first pulse (a heal) lands, so only the shield and resistance show.
    simulator.addOrder(2, enemyOrder(1, 20, { type: 'attack', targetId: 1 }))
    const frame = simulator.at(20)
    return { hp: frame.get(1)?.getHealth() ?? -1, shield: frame.get(1)?.getShield() ?? -1 }
  }

  // The brawler's attack deals 100. Stim's cost of 150 is not reduced by its own resistance.
  const stimmed = damageFromOneHit((simulator) => simulator.addOrder(1, cast(1, 1, 't-stim', { mode: 'none' })))
  assert.equal(stimmed.hp, soldier.maxHp - 150 - 70, '30% resistance: 100 becomes 70')

  // Stim's 30% plus a guard's 80% would be 110%, held to 90%: 100 becomes 10.
  const capped = damageFromOneHit((simulator) => {
    simulator.addOrder(1, cast(1, 1, 't-stim', { mode: 'none' }))
    simulator.addOrder(1, cast(2, 2, 't-guard', { mode: 'none' }))
  })
  assert.equal(capped.hp, soldier.maxHp - 150 - 10)

  // With a shield too, the resisted 70 is what the shield soaks.
  const shielded = damageFromOneHit((simulator) => {
    simulator.addOrder(1, cast(1, 1, 't-stim', { mode: 'none' }))
    simulator.addOrder(1, cast(2, 6, 't-medic', { mode: 'none' }))
  })
  assert.equal(shielded.hp, soldier.maxHp - 150, 'the shield took the hit')
  assert.equal(shielded.shield, 250 - 70)
})

test('the soldier\'s bolt pierces everything in its line, slows it, and hurts the weakened more', () => {
  // Two targets in a row. The nearer one is worn down by autos first.
  const nearer = { x: 300, y: 100 }
  const farther = { x: 500, y: 100 }
  const simulator = createSoldierDuel([nearer, farther])
  for (const tick of [1, 51, 101, 151]) simulator.addOrder(1, attack(tick, tick))
  const rail = getAbilityDef('t-rail')
  assert.ok(rail)
  simulator.addOrder(1, cast(100, 220, 't-rail', { mode: 'direction', dir: { x: 1, y: 0 } }))
  const launch = 220 + rail.windUpTicks

  const wornDown = healthOf(simulator, launch - 1, 2)
  const missing = brawler.maxHp - wornDown
  assert.equal(missing, 4 * 60, 'four ranged autos landed first')

  // Walk up the ticks once, noting the first thing the bolt did to each target.
  const hits = new Map<number, { tick: number; drop: number; slowed: boolean }>()
  let boltsAfterFirstHit = -1
  for (let tick = launch + 1; tick < launch + 80; tick += 1) {
    const frame = simulator.at(tick)
    if (hits.has(2) && boltsAfterFirstHit < 0) boltsAfterFirstHit = frame.getEntities().length
    for (const unitId of [2, 3]) {
      const drop = healthOf(simulator, tick - 1, unitId) - healthOf(simulator, tick, unitId)
      if (drop > 0 && !hits.has(unitId)) {
        const slowed = frame.get(unitId)?.getStatuses().some((status) => status.kind === 'slow') ?? false
        hits.set(unitId, { tick, drop, slowed })
      }
    }
  }
  const first = hits.get(2)
  const second = hits.get(3)
  assert.ok(first && second, 'the bolt reached both targets')
  assert.equal(first.drop, 80 + 0.2 * missing, '80 plus a fifth of the health it was missing')
  assert.equal(first.slowed, true)
  assert.equal(boltsAfterFirstHit, 1, 'it carried on through the first target')
  assert.ok(second.tick > first.tick, 'and reached the one behind it later')
  assert.equal(second.drop, 80, 'a target at full health takes the base only')
  assert.equal(second.slowed, true, 'and is slowed too')
})

test('medic shields the soldier and heals it over time, and healing never goes past the maximum', () => {
  const medic = getAbilityDef('t-medic')
  assert.ok(medic)
  const simulator = createSoldierDuel([{ x: 160, y: 100 }])
  // Wounded first, so there is something to heal: the brawler's hit takes 100.
  simulator.addOrder(2, enemyOrder(1, 1, { type: 'attack', targetId: 1 }))
  simulator.addOrder(1, cast(1, 10, 't-medic', { mode: 'none' }))
  const launch = 10 + medic.windUpTicks

  assert.equal(healthOf(simulator, launch - 1, 1), soldier.maxHp - 100)
  const summoned = simulator.at(launch)
  assert.equal(summoned.get(1)?.getShield(), 250, 'a shield comes with the bot')
  assert.deepEqual(summoned.getEntities().map((entity) => entity.defId), ['t-medic-bot'], 'the bot is out')

  // Twelve a pulse, every half second.
  assert.equal(healthOf(simulator, launch + 29, 1), soldier.maxHp - 100)
  assert.equal(healthOf(simulator, launch + 30, 1), soldier.maxHp - 100 + 12)
  assert.equal(healthOf(simulator, launch + 60, 1), soldier.maxHp - 100 + 24)
  // Eight pulses finish the 100 it was missing, and the rest do nothing.
  assert.equal(healthOf(simulator, launch + 270, 1), soldier.maxHp)
  assert.equal(healthOf(simulator, launch + 300, 1), soldier.maxHp)
})

test('the bot and its shield have no timer: they stay out until the shield is broken', () => {
  const simulator = createSoldierDuel([{ x: 160, y: 100 }], bigHitter)
  simulator.addOrder(1, cast(1, 1, 't-medic', { mode: 'none' }))
  // Half a minute on, with nothing having touched the shield.
  simulator.addOrder(2, enemyOrder(1, 1800, { type: 'attack', targetId: 1 }))

  for (const tick of [100, 721, 1000, 1799]) {
    const frame = simulator.at(tick)
    assert.equal(frame.get(1)?.getShield(), 250, `shield on tick ${tick}`)
    assert.equal(frame.getEntities().length, 1, `bot on tick ${tick}`)
  }
  const broken = simulator.at(1800)
  assert.equal(broken.get(1)?.getShield(), 0)
  assert.equal(broken.getEntities().length, 1, 'it ends the tick after the shield breaks')
  assert.equal(simulator.at(1801).getEntities().length, 0)
})

test('casting medic again replaces the bot and refreshes the shield instead of adding to it', () => {
  const medic = getAbilityDef('t-medic')
  assert.ok(medic)
  const simulator = createSoldierDuel([{ x: 160, y: 100 }])
  simulator.addOrder(1, cast(1, 1, 't-medic', { mode: 'none' }))
  simulator.addOrder(2, enemyOrder(1, 200, { type: 'attack', targetId: 1 }))
  simulator.addOrder(1, cast(2, 1500, 't-medic', { mode: 'none' }))
  const second = 1500 + medic.windUpTicks

  const worn = simulator.at(300)
  assert.equal(worn.get(1)?.getShield(), 150, 'the first shield took a hit')
  assert.equal(worn.getEntities().length, 1)
  const before = simulator.at(second - 1).getEntities()
  assert.equal(before.length, 1)
  assert.equal(before[0].startTick, 1 + medic.windUpTicks)

  const after = simulator.at(second)
  assert.equal(after.get(1)?.getShield(), 250, 'back to a full shield, not 400')
  assert.equal(after.getEntities().length, 1, 'one bot, not two')
  assert.equal(after.getEntities()[0].startTick, second, 'and it is the new one')
})

test('a medic whose shield is broken is gone, and heals nothing more', () => {
  const medic = getAbilityDef('t-medic')
  assert.ok(medic)
  const simulator = createSoldierDuel([{ x: 160, y: 100 }], bigHitter)
  simulator.addOrder(1, cast(1, 1, 't-medic', { mode: 'none' }))
  const launch = 1 + medic.windUpTicks
  // One 400 hit: the 250 shield takes 250 of it and the soldier takes the other 150.
  simulator.addOrder(2, enemyOrder(1, 20, { type: 'attack', targetId: 1 }))

  assert.equal(simulator.at(19).get(1)?.getShield(), 250)
  const broken = simulator.at(20)
  assert.equal(broken.get(1)?.getShield(), 0, 'the shield is used up')
  assert.equal(broken.get(1)?.getHealth(), soldier.maxHp - 150)
  assert.equal(simulator.at(21).getEntities().length, 0, 'and the bot goes with it')
  // Past where several pulses would have landed, nothing has healed.
  assert.equal(healthOf(simulator, launch + 200, 1), soldier.maxHp - 150)
})

test('a lighter hit leaves the bot standing, still healing', () => {
  const medic = getAbilityDef('t-medic')
  assert.ok(medic)
  const simulator = createSoldierDuel([{ x: 160, y: 100 }])
  simulator.addOrder(1, cast(1, 1, 't-medic', { mode: 'none' }))
  const launch = 1 + medic.windUpTicks
  simulator.addOrder(2, enemyOrder(1, 10, { type: 'attack', targetId: 1 }))

  const hit = simulator.at(10)
  assert.equal(hit.get(1)?.getShield(), 150, 'the shield soaked the 100')
  assert.equal(hit.get(1)?.getHealth(), soldier.maxHp)
  assert.equal(hit.getEntities().length, 1, 'the bot stands')
  assert.equal(simulator.at(launch + 60).getEntities().length, 1)
})

test('healing cannot revive a unit that is already at zero health', () => {
  const healer = new Champion({ ...soldier, abilities: ['t-first-aid'] })
  const killer = new Champion({ ...bigHitter, attackDamage: 5000 })
  const simulator = createSoldierDuel([{ x: 160, y: 100 }], killer, healer)
  simulator.addOrder(2, enemyOrder(1, 1, { type: 'attack', targetId: 1 }))
  simulator.addOrder(1, cast(1, 10, 't-first-aid', { mode: 'none' }))

  assert.equal(healthOf(simulator, 5, 1), 0, 'it was struck down')
  assert.equal(healthOf(simulator, 12, 1), 0, 'and the heal arrived too late to count')
})

test('medic\'s shield, bot and healing survive a checkpoint restore, and end if the soldier dies', () => {
  const build = (): Simulator => {
    const simulator = createSoldierDuel([{ x: 160, y: 100 }])
    simulator.addOrder(2, enemyOrder(1, 1, { type: 'attack', targetId: 1 }))
    simulator.addOrder(1, cast(1, 10, 't-medic', { mode: 'none' }))
    // Walking away makes the bot follow, so its position is something a checkpoint has to carry.
    simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 20, type: 'move', target: { x: 500, y: 100 } })
    return simulator
  }
  const frameOf = (simulator: Simulator, tick: number): string => {
    const frame = simulator.at(tick)
    return JSON.stringify([
      frame.get(1)?.getHealthState(),
      frame.get(1)?.getStatuses(),
      frame.getEntities().map((entity) => [entity.id, entityPosAt(entity, tick), entity.velocity]),
    ])
  }
  const reference = build()
  const expected = new Map<number, string>()
  for (let tick = 1; tick <= 160; tick += 1) expected.set(tick, frameOf(reference, tick))

  const original = build()
  original.advanceTo(80)
  original.setCommitTick(72)
  // Through the schema and JSON, as it reaches a client, so a field the schema drops would show.
  const snapshot = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(original.snapshot())))
  const bot = snapshot.checkpoint.entities.find((entity) => entity.defId === 't-medic-bot')
  assert.ok(bot?.position, 'the bot has moved, and the checkpoint records where')
  assert.equal(bot.lifetimeTicks, undefined, 'and it has no timer')
  const restored = new Simulator()
  restored.replaceFromSnapshot(snapshot)
  for (let tick = 73; tick <= 160; tick += 1) assert.equal(frameOf(restored, tick), expected.get(tick), `tick ${tick}`)

  // If the soldier dies, the shield is cleared with the rest of its statuses and the bot ends.
  const dying = build()
  dying.at(60)
  assert.equal(dying.addDeath(1, { tick: 70, respawnTick: 400 }), true)
  assert.equal(dying.at(71).getEntities().length, 0)
})

// Where the bot and the soldier are on each tick. Reads only move forward, since the frame
// buffer forgets old ticks.
function trackBot(simulator: Simulator, from: number, to: number): Array<{ tick: number; bot: Vector2; soldier: Vector2 }> {
  const track: Array<{ tick: number; bot: Vector2; soldier: Vector2 }> = []
  for (let tick = from; tick <= to; tick += 1) {
    const frame = simulator.at(tick)
    const bot = frame.getEntities().find((entity) => entity.defId === 't-medic-bot')
    const soldierAt = frame.get(1)?.getPosition()
    if (bot && soldierAt) track.push({ tick, bot: entityPosAt(bot, tick), soldier: soldierAt })
  }
  return track
}

function apart(left: Vector2, right: Vector2): number {
  return Math.hypot(left.x - right.x, left.y - right.y)
}

// The bot's spring is stiffness 24 and damping 3.5, with its rest point 36 above the soldier.
const BOT_REST = { x: 0, y: -36 }
const BOT_STIFFNESS = 24
const BOT_DAMPING = 3.5

test('the medic bot rises out from under the soldier, swings past its rest point, and settles there', () => {
  const simulator = createSoldierDuel([{ x: 2000, y: 1200 }])
  simulator.addOrder(1, cast(1, 1, 't-medic', { mode: 'none' }))
  const track = trackBot(simulator, 4, 700)

  assert.deepEqual(track[0].bot, ORIGIN, 'summoned on the soldier')
  assert.ok(track[1].bot.y < 100 && track[1].bot.x === 100, 'and straight away drawn up toward its rest point')
  // An underdamped spring goes past the point it is pulled toward before coming back.
  const highest = Math.min(...track.map(({ bot }) => bot.y))
  assert.ok(highest < 100 + BOT_REST.y - 5, `swung past its rest point (reached ${highest})`)
  const last = track[track.length - 1]
  assert.ok(apart(last.bot, { x: 100 + BOT_REST.x, y: 100 + BOT_REST.y }) < 0.5, 'and settled on it')
  assert.deepEqual(last.soldier, ORIGIN)
})

test('the medic bot lags behind a walking soldier by the spring\'s pull, and swings ahead when it stops', () => {
  const simulator = createSoldierDuel([{ x: 2000, y: 1200 }])
  simulator.addOrder(1, cast(1, 1, 't-medic', { mode: 'none' }))
  // A long straight walk, from after the bot has settled, ending at a stop.
  const target = { x: 1100, y: 600 }
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 200, type: 'move', target })
  const track = trackBot(simulator, 4, 900)

  const length = Math.hypot(target.x - 100, target.y - 100)
  const direction = { x: (target.x - 100) / length, y: (target.y - 100) / length }
  const rest = (soldier: Vector2): Vector2 => ({ x: soldier.x + BOT_REST.x, y: soldier.y + BOT_REST.y })
  // How far the bot is ahead of (positive) or behind its rest point, along the way it is walking.
  const ahead = ({ bot, soldier }: { bot: Vector2; soldier: Vector2 }): number =>
    (bot.x - rest(soldier).x) * direction.x + (bot.y - rest(soldier).y) * direction.y

  // At a steady walk the spring settles into a constant lag of damping * speed / stiffness.
  const speed = soldier.moveSpeed
  const expectedLag = BOT_DAMPING * speed / BOT_STIFFNESS
  const cruising = track.filter(({ tick }) => tick >= 450 && tick <= 650)
  for (const entry of cruising) {
    assert.ok(-ahead(entry) > expectedLag * 0.8 && -ahead(entry) < expectedLag * 1.05, `lag ${-ahead(entry)} on tick ${entry.tick}`)
  }
  // It is neither held at a fixed distance nor stuck to its rest point: the gap opens and closes.
  const gaps = track.filter(({ tick }) => tick >= 200).map(({ bot, soldier }) => apart(bot, soldier))
  assert.ok(Math.max(...gaps) - Math.min(...gaps) > 15, 'the distance to the soldier changes as it moves')
  // When the soldier stops, the bot's momentum carries it past the rest point before it settles.
  const stopped = track.filter(({ soldier }) => soldier.x === target.x && soldier.y === target.y)
  assert.ok(stopped.length > 100)
  assert.ok(Math.max(...stopped.map(ahead)) > 3, 'swings ahead of where it settles')
  const last = stopped[stopped.length - 1]
  assert.ok(apart(last.bot, rest(last.soldier)) < 0.5, 'and settles at its rest point')
})

test('the medic bot\'s rest point is kept inside the arena', () => {
  // A soldier hugging the top wall would have its rest point above the arena.
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 20 }, soldier)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 2000, y: 1200 }, brawler)
  simulator.addOrder(1, cast(1, 1, 't-medic', { mode: 'none' }, { x: 100, y: 20 }))
  const track = trackBot(simulator, 4, 700)

  const last = track[track.length - 1]
  // The rest point is the bot's own radius (9) in from the wall.
  assert.ok(Math.abs(last.bot.y - 9) < 0.5, `settled at ${last.bot.y}`)
  assert.ok(track.every(({ bot }) => bot.y > -5), 'and never far outside')
})
