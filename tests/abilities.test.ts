import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  abilityOnKey,
  attackDamage,
  blind,
  boxTouchesCircle,
  Champion,
  damage,
  enemiesInRadius,
  entityPosAt,
  GAME_ARENA_WIDTH,
  GAME_RESPAWN_TICKS,
  GAME_TPS,
  GameSnapshotSchema,
  getAbilityDef,
  getChampion,
  GAME_BURN_PULSE_TICKS,
  getEntityDef,
  knockback,
  mark,
  root,
  runEffects,
  self,
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
import {
  bigHitter,
  brawler,
  cursebearer,
  cutter,
  defineAbility,
  grenadier,
  gunner,
  killAt,
  ninja,
  soldier,
  spouter,
  stopAttacking,
  trinketmaster,
} from './fixtures.js'
import { testSpawns } from './test-spawns.ts'

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
    // On the same team as unit 1, so no enemy of it, though it is a different player.
    [3, new SimCharacter(3, { x: 110, y: 100 }, [], champion, { playerId: 'player-3', name: 'Ally' }, 0, [], 1)],
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

  const meteor = gameState.createCastOrder(3, { x: 700, y: 100 }, 0)
  assert.ok(meteor.ok)
  assert.equal(meteor.order.abilityId, 't-meteor')
  assert.deepEqual(meteor.order.origin, ORIGIN)
  assert.deepEqual(meteor.order.target, { mode: 'point', point: { x: 400, y: 100 } })

  const bolt = gameState.createCastOrder(2, { x: 100, y: 300 }, 0)
  assert.ok(bolt.ok)
  assert.deepEqual(bolt.order.target, { mode: 'direction', dir: { x: 0, y: 1 } })

  const lash = gameState.createCastOrder(1, { x: 600, y: 300 }, 0)
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

// One attack order keeps the cursebearer attacking, every 50 ticks (AUTO_TICKS), so this orders it
// once and then stops it when the last of `count` autos has landed.
function autoAttacks(simulator: Simulator, count: number): void {
  simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: AUTO_TICKS[0], type: 'attack', targetId: 2 })
  stopAttacking(simulator, 1, AUTO_TICKS[count - 1] + getChampion('t-cursebearer').attackWindupTicks, ORIGIN)
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

// Projectile autos, against the gunner in fixtures.ts: windup 3, a shot at 10 px per tick that is
// 8 px across, hitting a brawler (18 px across) once the two are within 8 + 18 = 26 px.

const GUNNER_LAUNCH = 1 + gunner.attackWindupTicks

function createGunnerDuel(targetAt: Vector2, shooter: Champion = gunner): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, shooter)
  simulator.addPlayer(2, 'player-2', 'Player 2', targetAt, brawler)
  simulator.addOrder(1, attack(1, 1))
  // One shot: an attack order keeps attacking, so it is stopped on the tick the shot leaves.
  stopAttacking(simulator, 1, GUNNER_LAUNCH, ORIGIN)
  return simulator
}

test('a projectile auto launches when its windup finishes and lands when the shot arrives', () => {
  const simulator = createGunnerDuel({ x: 300, y: 100 })

  const launched = simulator.at(GUNNER_LAUNCH)
  assert.equal(launched.getEntities().length, 1)
  assert.deepEqual(launched.getEntities()[0]?.origin, ORIGIN, 'it starts on the shooter')
  assert.equal(launched.get(2)?.getHealth(), 1000, 'nothing lands at launch')
  // 200 px apart, 10 px per tick, touching inside 26 px: 17 steps leave 30 px, the 18th leaves 20.
  const landing = GUNNER_LAUNCH + 18
  assert.equal(simulator.at(landing - 1).get(2)?.getHealth(), 1000)
  assert.equal(simulator.at(landing - 1).getEntities().length, 1)
  assert.equal(simulator.at(landing).get(2)?.getHealth(), 900)
  assert.equal(simulator.at(landing).getEntities().length, 0, 'the shot is spent')
  assert.equal(simulator.at(landing + 40).get(2)?.getHealth(), 900, 'and it lands only once')
})

test('a target touching the shooter is hit on the shot\'s first step', () => {
  // 36 apart is as close as two 18 px bodies can stand, and the shot's step leaves it within reach.
  const simulator = createGunnerDuel({ x: 136, y: 100 })

  assert.equal(simulator.at(GUNNER_LAUNCH).get(2)?.getHealth(), 1000)
  assert.equal(simulator.at(GUNNER_LAUNCH + 1).get(2)?.getHealth(), 900)
})

test('the shot turns to follow its target and lands later the farther the target runs', () => {
  // The target sets off sideways (3.7 px per tick) once the shot is already in the air.
  const createRunner = (): Simulator => {
    const simulator = createGunnerDuel({ x: 300, y: 100 })
    simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: GUNNER_LAUNCH, type: 'move', target: { x: 300, y: 600 } })
    return simulator
  }
  const landingTick = (simulator: Simulator): number => {
    for (let tick = GUNNER_LAUNCH; tick < GUNNER_LAUNCH + 200; tick += 1) {
      if ((simulator.at(tick).get(2)?.getHealth() ?? 1000) < 1000) return tick
    }
    return -1
  }
  const heading = createRunner()
  const headingAt = (tick: number): number => {
    const velocity = heading.at(tick).getEntities()[0]?.velocity ?? { x: 0, y: 0 }
    return Math.atan2(velocity.y, velocity.x)
  }

  const early = headingAt(GUNNER_LAUNCH + 1)
  const late = headingAt(GUNNER_LAUNCH + 12)
  assert.ok(late > early + 0.05, `the heading swings toward the target: ${early} then ${late}`)
  assert.equal(landingTick(createGunnerDuel({ x: 300, y: 100 })), GUNNER_LAUNCH + 18)
  const runner = createRunner()
  const chased = landingTick(runner)
  assert.ok(chased > GUNNER_LAUNCH + 18 && chased < GUNNER_LAUNCH + 60, `it caught the runner on tick ${chased}`)
  assert.equal(runner.at(chased).get(2)?.getHealth(), 900)
  assert.equal(runner.at(chased).getEntities().length, 0)
})

test('a shot flies through other enemies and hits only the unit it was fired at', () => {
  const simulator = createGunnerDuel({ x: 300, y: 100 })
  simulator.addPlayer(3, 'player-3', 'Player 3', { x: 200, y: 100 }, brawler)

  const landing = GUNNER_LAUNCH + 18
  assert.equal(simulator.at(landing).get(2)?.getHealth(), 900)
  assert.equal(simulator.at(landing).get(3)?.getHealth(), 1000, 'the enemy in its path is untouched')
})

test('a shot has no timer: a slow one keeps chasing and still lands', () => {
  const slow = new Champion({ ...gunner, attackProjectile: { speed: 60, radius: 8 } })
  const simulator = createGunnerDuel({ x: 300, y: 100 }, slow)

  // 1 px per tick, 200 px apart, touching inside 26 px: it lands on the 174th step.
  const landing = GUNNER_LAUNCH + 174
  assert.equal(simulator.at(landing - 1).get(2)?.getHealth(), 1000)
  assert.equal(simulator.at(landing - 1).getEntities().length, 1, 'still chasing nearly three seconds on')
  assert.equal(simulator.at(landing).get(2)?.getHealth(), 900)
})

test('a shot is dropped without damage when its target dies, and does not hit the respawned one', () => {
  const simulator = createGunnerDuel({ x: 300, y: 100 })
  killAt(simulator, 2, 10)

  assert.equal(simulator.at(10).getEntities().length, 1, 'it is still on its way on the tick the target dies')
  assert.equal(simulator.at(10).get(2)?.isDead(), true)
  assert.equal(simulator.at(11).getEntities().length, 0, 'and has nothing left to chase on the next')
  const respawn = 10 + GAME_RESPAWN_TICKS
  assert.equal(simulator.at(respawn).get(2)?.getHealth(), 1000, 'the respawned unit is whole')
  assert.equal(simulator.at(respawn + 30).get(2)?.getHealth(), 1000)
})

test('a ranged champion without a projectile still lands the moment its windup finishes', () => {
  const instant = new Champion({ ...gunner, attackProjectile: undefined })
  const simulator = createGunnerDuel({ x: 300, y: 100 }, instant)

  const launched = simulator.at(GUNNER_LAUNCH)
  assert.equal(launched.get(2)?.getHealth(), 900, '200 px away, hit at once')
  assert.equal(launched.getEntities().length, 0)
})

test('the arriving shot runs its shooter\'s own attack effects, even in a copy of the champion', () => {
  const branding = new Champion({
    ...gunner,
    onAttackHit: [damage(attackDamage()), mark('t-brand', 600, subject(), { cap: 3 })],
  })
  const simulator = createGunnerDuel({ x: 300, y: 100 }, branding)

  const shot = simulator.at(GUNNER_LAUNCH).getEntities()[0]
  assert.equal(getEntityDef(shot?.defId ?? '')?.homing, true, 'the shot is a homing entity')
  const landing = GUNNER_LAUNCH + 18
  assert.deepEqual(simulator.at(landing - 1).get(2)?.getMarkers(), [])
  const landed = simulator.at(landing).get(2)
  assert.equal(landed?.getHealth(), 900)
  assert.deepEqual(landed?.getMarkers().map(({ key }) => key), ['t-brand'])
})

test('a shot in flight survives a checkpoint restore and lands on the same tick', () => {
  const build = (): Simulator => {
    const simulator = createGunnerDuel({ x: 300, y: 100 })
    simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 2, type: 'move', target: { x: 300, y: 600 } })
    return simulator
  }
  const record = (simulator: Simulator, from: number, to: number): Map<number, string> => {
    const frames = new Map<number, string>()
    for (let tick = from; tick <= to; tick += 1) {
      const frame = simulator.at(tick)
      frames.set(tick, JSON.stringify([frame.get(2)?.getHealth(), frame.getEntities()]))
    }
    return frames
  }
  const expected = record(build(), 1, 60)

  const original = build()
  original.advanceTo(12)
  original.setCommitTick(10)
  const snapshot = original.snapshot()
  assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)
  assert.equal(snapshot.checkpoint.entities.length, 1, 'the shot travels in the checkpoint')
  assert.equal(snapshot.checkpoint.entities[0]?.targetId, 2, 'and remembers who it is chasing')

  const restored = new Simulator()
  restored.replaceFromSnapshot(snapshot)
  for (const [tick, frame] of record(restored, 11, 60)) assert.equal(frame, expected.get(tick), `tick ${tick}`)
})

test('a homing entity with a lifetime gives up the chase when it runs out', () => {
  const seeker = spawnEntity({
    id: 'test-seeker',
    speed: 30,
    radius: 5,
    homing: true,
    lifetimeTicks: 20,
    onHit: [damage(50)],
  })
  const caster = new Champion({ ...brawler, onAttackHit: [seeker] })
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, caster)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 180, y: 100 }, brawler)
  simulator.addOrder(1, attack(1, 1))

  assert.equal(simulator.at(10).getEntities().length, 1)
  assert.equal(simulator.at(30).getEntities().length, 0, 'half a pixel a tick never reaches 80 px')
  assert.equal(simulator.at(30).get(2)?.getHealth(), 1000)
})

test('a projectile or a homing entity must be able to fly', () => {
  assert.throws(() => new Champion({ ...gunner, attackProjectile: { speed: 0, radius: 8 } }), /positive speed and radius/)
  assert.throws(() => new Champion({ ...gunner, attackProjectile: { speed: 600, radius: -1 } }), /positive speed and radius/)
  assert.throws(() => spawnEntity({ id: 'test-homing-still', speed: 0, radius: 5, homing: true }), /homing/)
  assert.throws(() => spawnEntity({ id: 'test-homing-pierce', speed: 100, radius: 5, homing: true, pierce: true }), /homing/)
  assert.throws(
    () => spawnEntity({ id: 'test-homing-box', speed: 100, box: { halfLength: 5, halfWidth: 5 }, homing: true }),
    /homing/,
  )
})

// Archer kit

// The enemy stands beside the line the archer leaps along (y = 100), not on it: characters are
// solid, so one in the way would stop the leap short.
const ARCHER_ENEMY_AT: Vector2 = { x: 140, y: 160 }

function createArcherDuel(enemyPosition: Vector2 = ARCHER_ENEMY_AT): Simulator {
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
    target: { mode: 'unit', unitId: 1 }, origin: ARCHER_ENEMY_AT,
  })
  simulator.addOrder(1, cast(1, 12, 't-leap', { mode: 'point', point: LEAP_TARGET }))

  const before = simulator.at(13).get(1)
  assert.ok(before?.getStatuses().some((status) => status.kind === 'slow'), 'the archer is slowed')
  const x13 = before?.getPosition().x ?? 0
  assertClose((simulator.at(14).get(1)?.getPosition().x ?? 0) - x13, LEAP_STEP)
})

test('attacks and casts are rejected during a dash, and a move order waits for it to end', () => {
  // Clear of both the leap along y = 100 and the walk south from where it lands.
  const simulator = createArcherDuel({ x: 120, y: 160 })
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
  killAt(simulator, 1, 8)

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
  // Stopped as the first auto lands, or it would go on attacking for as long as focus lasts.
  stopAttacking(simulator, 1, 5 + archer.attackWindupTicks, ORIGIN)
  simulator.addOrder(1, attack(3, 250))

  const status = simulator.at(2).get(1)?.getStatuses() ?? []
  assertClose(status.find((s) => s.kind === 'attackspeed')?.amount ?? 0, 0.4)
  assertClose(status.find((s) => s.kind === 'attackrange')?.amount ?? 0, 120)
  assert.equal(simulator.at(9).get(2)?.getHealth(), 1000 - archer.attackDamage, 'in range only while focused')
  // The cooldown after that auto is shortened: ceil(60 / 1.4) = 43 ticks.
  assert.equal(simulator.at(9).get(1)?.getNextAttackTick(), 5 + 43)

  assert.deepEqual(simulator.at(249).get(1)?.getStatuses(), [], 'focus has worn off')
  // Without the extra reach the enemy is 60 px out of range, so the attack ordered on tick 250 has
  // to walk up to it first, at 2.5 px a tick, and lands only once it has.
  assert.equal(simulator.at(260).get(2)?.getHealth(), 1000 - archer.attackDamage, 'not in reach yet')
  assert.ok((simulator.at(260).get(1)?.getPosition().x ?? 0) > ORIGIN.x, 'the archer is walking up to it')
  assert.equal(simulator.at(290).get(2)?.getHealth(), 1000 - 2 * archer.attackDamage, 'and the auto lands once it has')
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

// The trap is 70 across and a brawler 18, so a brawler's body touches it from 88 away. The lob to a
// point 400 out lands on tick 45 and the trap is there on tick 46, active from tick 47 and gone
// after tick 106 (it stays one second). It roots for 90 ticks.
const SNARE_POINT: Vector2 = { x: 500, y: 100 }
const SNARE_TOUCH = 70 + brawler.radius
const SNARE_UP = 46
const SNARE_ROOT = 90

function rootOn(simulator: Simulator, tick: number, characterId = 2) {
  return simulator.at(tick).get(characterId)?.getStatuses().find((status) => status.kind === 'root')
}

test('snare lands exactly on the aimed point and roots an enemy it lands on, once', () => {
  const simulator = createArcherDuel({ x: 500, y: 100 })
  simulator.addOrder(1, cast(1, 1, 't-snare', { mode: 'point', point: SNARE_POINT }))

  assert.equal(simulator.at(25).getEntities()[0]?.defId, 't-snare-shot')
  const field = simulator.at(SNARE_UP).getEntities()
  assert.deepEqual(field.map((entity) => entity.defId), ['t-snare-field'])
  assert.deepEqual(field[0]?.origin, SNARE_POINT)
  assert.equal(rootOn(simulator, SNARE_UP), undefined, 'it springs on the tick after it lands')
  const rooted = rootOn(simulator, SNARE_UP + 1)
  assert.equal(rooted?.endTick, SNARE_UP + 1 + SNARE_ROOT)
  // It does not slow, and standing in it does not renew the root: it was caught once.
  assert.equal(simulator.at(SNARE_UP + 1).get(2)?.getStatuses().some((status) => status.kind === 'slow'), false)
  assert.equal(rootOn(simulator, SNARE_UP + 40)?.startTick, SNARE_UP + 1)
  assert.equal(rootOn(simulator, SNARE_UP + 1 + SNARE_ROOT - 1)?.endTick, SNARE_UP + 1 + SNARE_ROOT)
  assert.equal(rootOn(simulator, SNARE_UP + 1 + SNARE_ROOT), undefined, 'and it wears off on schedule')
  assert.deepEqual(simulator.at(SNARE_UP + 1 + SNARE_ROOT).get(2)?.getPosition(), SNARE_POINT)
})

test('snare stays on the ground for a second and roots whoever walks into it, where it touches', () => {
  const simulator = createArcherDuel({ x: 500, y: 260 })
  simulator.addOrder(1, cast(1, 1, 't-snare', { mode: 'point', point: SNARE_POINT }))
  // Walking up the line through the middle of the trap, starting from outside it.
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 50, type: 'move', target: { x: 500, y: 0 } })

  assert.equal(rootOn(simulator, 49), undefined, 'nobody is in it yet')
  let caught = -1
  for (let tick = 50; tick <= SNARE_UP + 60 && caught < 0; tick += 1) {
    if (rootOn(simulator, tick)) caught = tick
  }
  assert.ok(caught > 50, `it caught the walker on tick ${caught}`)
  const stopped = simulator.at(caught).get(2)?.getPosition()
  assert.ok(stopped)
  // It is stopped at the trap's edge, not carried in to the middle.
  assert.ok(Math.hypot(stopped.x - SNARE_POINT.x, stopped.y - SNARE_POINT.y) <= SNARE_TOUCH)
  assert.ok(Math.hypot(stopped.x - SNARE_POINT.x, stopped.y - SNARE_POINT.y) > SNARE_TOUCH - 5)
  assert.equal(rootOn(simulator, caught)?.endTick, caught + SNARE_ROOT)
  // The root holds it for its full length, even though the trap itself is long gone by then.
  assert.equal(simulator.at(SNARE_UP + 61).getEntities().length, 0, 'the trap lasted only a second')
  assert.deepEqual(simulator.at(caught + SNARE_ROOT - 1).get(2)?.getPosition(), stopped)
  assert.notDeepEqual(simulator.at(caught + SNARE_ROOT + 10).get(2)?.getPosition(), stopped, 'then it walks on')
})

test('snare does nothing to someone who walks over the spot after it has gone', () => {
  const simulator = createArcherDuel({ x: 500, y: 260 })
  simulator.addOrder(1, cast(1, 1, 't-snare', { mode: 'point', point: SNARE_POINT }))
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: SNARE_UP + 62, type: 'move', target: { x: 500, y: 0 } })

  assert.equal(simulator.at(SNARE_UP + 61).getEntities().length, 0)
  for (let tick = SNARE_UP + 62; tick <= SNARE_UP + 62 + 80; tick += 1) {
    assert.equal(rootOn(simulator, tick), undefined, `tick ${tick}`)
  }
  assert.ok((simulator.at(SNARE_UP + 62 + 80).get(2)?.getPosition().y ?? 999) < SNARE_POINT.y, 'it walked right across')
})

test('snare roots everyone caught in it, but never the archer who laid it', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, getChampion('t-archer'))
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 200, y: 150 }, brawler)
  simulator.addPlayer(3, 'player-3', 'Player 3', { x: 200, y: 50 }, brawler)
  // Lobbed 100 along, the trap lands between the two enemies and 100 from the archer, who then
  // walks straight into it.
  simulator.addOrder(1, cast(1, 1, 't-snare', { mode: 'point', point: { x: 200, y: 100 } }))
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 12, type: 'move', target: { x: 200, y: 100 } })

  assert.ok(rootOn(simulator, 40, 2), 'one enemy is caught')
  assert.ok(rootOn(simulator, 40, 3), 'and so is the other')
  for (let tick = 41; tick <= 100; tick += 1) assert.equal(rootOn(simulator, tick, 1), undefined, `tick ${tick}`)
  assert.ok((simulator.at(100).get(1)?.getPosition().x ?? 0) > 150, 'the archer walked into the trap')
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
  assert.throws(() => spawnEntity({ id: 'test-no-lifetime', speed: 0, radius: 5 }), /needs lifetimeTicks, landAtAim, stayWhile or homing/)
})

// Swordsman kit, against the copy in fixtures.ts. Positions and timings come from that champion.

const sword = getChampion('t-swordsman')
// Close enough to auto in melee, whatever the range is tuned to.
const SWORD_GAP = sword.attackRange - 30
// A locked attack swings again the moment its cooldown is up.
const SWORD_AUTO_SPACING = sword.attackCooldownTicks

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

// One attack order keeps the swordsman attacking at the speed of its attack, so this orders it
// once and stops it when the last of `count` autos has landed.
function swordAutos(simulator: Simulator, count: number): void {
  simulator.addOrder(1, attack(1, 1))
  stopAttacking(simulator, 1, swordAutoTicks(count)[count - 1] + sword.attackWindupTicks, ORIGIN)
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

test('shackle readies the next auto, which roots its target and spends the stacks, and the cast resets the auto timer', () => {
  const simulator = createSwordDuel()
  swordAutos(simulator, 1)
  const castTick = afterAutos(1)
  // The cast has no windup, so it is up in the same tick, and the auto ordered just after it, which
  // is ready at once because the cast reset the timer, is the one that carries it.
  simulator.addOrder(1, cast(100, castTick, 't-shackle', { mode: 'none' }))
  simulator.addOrder(1, attack(101, castTick + 1))
  const landing = castTick + 1 + sword.attackWindupTicks
  stopAttacking(simulator, 1, landing, ORIGIN)
  // A rooted enemy can still attack; it then asks to walk away, which the root holds it from.
  simulator.addOrder(2, enemyOrder(1, landing + 4, { type: 'attack', targetId: 1 }))
  simulator.addOrder(2, enemyOrder(2, landing + 8, { type: 'move', target: { x: 700, y: 100 } }))

  assert.equal(swordStacksOn(simulator, castTick - 1), 1)
  const cast1 = simulator.at(castTick)
  assert.equal(cast1.get(1)?.getNextAttackTick(), castTick, 'the auto timer was reset')
  assert.equal(markerCount(simulator, castTick, 'ready:t-shackle', 1), 1, 'the next auto is readied')
  assert.equal(cast1.get(2)?.getStatuses().length, 0, 'but nothing has happened to the enemy yet')

  assert.equal(simulator.at(landing - 1).get(2)?.getStatuses().length, 0)
  const frame = simulator.at(landing)
  const root = frame.get(2)?.getStatuses().find((status) => status.kind === 'root')
  assert.ok(root, 'the auto roots the enemy')
  assert.equal(root.endTick, landing + 90)
  assert.equal(frame.get(2)?.getStatuses().some((status) => status.kind === 'stun'), false)
  assert.equal(markerCount(simulator, landing, 'ready:t-shackle', 1), 0, 'and spends the readiness')
  // It read the one stack there was and popped it; the auto still adds its own, which stays.
  const stacks = frame.get(1)?.getMarkers().filter((marker) => marker.key === 'sword') ?? []
  assert.deepEqual(stacks.map((marker) => marker.startTick), [landing])

  assert.equal(
    simulator.at(landing + 4).get(1)?.getHealth(),
    sword.maxHp - brawler.attackDamage,
    'the rooted enemy still attacked',
  )
  const held = simulator.at(landing + 9).get(2)?.getPosition()
  assert.ok(held)
  assert.equal(simulator.at(root.endTick).get(2)?.getPosition().x, held.x)
  assert.ok((simulator.at(root.endTick + 5).get(2)?.getPosition().x ?? 0) > held.x, 'it walks once freed')
})

test('shackle with three stacks stuns instead: no attacks, no casts, and a windup is cancelled', () => {
  const lash = getAbilityDef('t-lash')
  assert.ok(lash)
  const simulator = createSwordDuel()
  swordAutos(simulator, 3)
  const castTick = afterAutos(3)
  simulator.addOrder(1, cast(100, castTick, 't-shackle', { mode: 'none' }))
  simulator.addOrder(1, attack(101, castTick + 1))
  const landing = castTick + 1 + sword.attackWindupTicks
  stopAttacking(simulator, 1, landing, ORIGIN)
  // The enemy starts a lash just before the stun lands, then tries to act while stunned.
  simulator.addOrder(2, enemyOrder(1, landing - 2, {
    type: 'cast', abilityId: 't-lash', target: { mode: 'unit', unitId: 1 }, origin: { x: 100 + SWORD_GAP, y: 100 },
  }))
  simulator.addOrder(2, enemyOrder(2, landing + 10, { type: 'attack', targetId: 1 }))

  assert.equal(swordStacksOn(simulator, landing - 1), 3)
  assert.equal(simulator.at(landing - 1).get(2)?.getAction()?.kind, 'cast', 'the lash is winding up')
  const frame = simulator.at(landing)
  const stun = frame.get(2)?.getStatuses().find((status) => status.kind === 'stun')
  assert.ok(stun, 'three stacks stun')
  assert.equal(stun.endTick, landing + 60)
  assert.equal(frame.get(2)?.getStatuses().some((status) => status.kind === 'root'), false)
  assert.equal(frame.get(2)?.getAction(), undefined, 'the windup was cancelled')
  assert.equal(swordStacksOn(simulator, landing), 1, 'the three were spent, and the auto added one')

  const hpWhileStunned = simulator.at(stun.endTick - 1).get(1)?.getHealth()
  assert.equal(hpWhileStunned, sword.maxHp, 'neither the lash nor the attack landed')
  assert.equal(simulator.at(stun.endTick - 1).get(2)?.getAbilityCooldown('t-lash').ready, true, 'the lash was not spent')
})

test('a rooted character cannot leap but can still attack', () => {
  const archer = getChampion('t-archer')
  const archerAt = { x: 100 + SWORD_GAP, y: 100 }
  const simulator = createSwordDuel(archerAt, archer)
  // The swordsman readies shackle and roots the archer with its auto, which lands on tick 5.
  simulator.addOrder(1, cast(100, 1, 't-shackle', { mode: 'none' }))
  simulator.addOrder(1, attack(101, 2))
  const landing = 2 + sword.attackWindupTicks
  stopAttacking(simulator, 1, landing, ORIGIN)
  simulator.addOrder(2, enemyOrder(1, landing + 5, {
    type: 'cast', abilityId: 't-leap', target: { mode: 'point', point: { x: archerAt.x + 50, y: 100 } }, origin: archerAt,
  }))
  simulator.addOrder(2, enemyOrder(2, landing + 8, { type: 'attack', targetId: 1 }))

  assert.ok(simulator.at(landing).get(2)?.getStatuses().some((status) => status.kind === 'root'))
  const afterLeapTry = simulator.at(landing + 7).get(2)
  assert.equal(afterLeapTry?.isDashing(), false)
  assert.deepEqual(afterLeapTry?.getPosition(), archerAt)
  assert.equal(afterLeapTry?.getAbilityCooldown('t-leap').ready, true, 'the leap was refused, not spent')
  assert.equal(
    simulator.at(landing + 8 + archer.attackWindupTicks).get(1)?.getHealth(),
    sword.maxHp - archer.attackDamage,
    'the rooted archer still attacks',
  )
})

test('stuns, roots, trails and stacks survive checkpoint restores', () => {
  const build = (): Simulator => {
    const simulator = createSwordDuel()
    swordAutos(simulator, 3)
    // Shackle readied on tick 141 and the auto that carries it begun on tick 142, so the checkpoint
    // committed on tick 142 holds the sword mid-swing, locked on its target and with shackle readied.
    simulator.addOrder(1, cast(100, 141, 't-shackle', { mode: 'none' }))
    simulator.addOrder(1, attack(102, 142))
    stopAttacking(simulator, 1, 142 + sword.attackWindupTicks, ORIGIN)
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
  assert.equal(build().at(150).get(2)?.getStatuses().some((status) => status.kind === 'stun'), true, 'the stun happened')

  // One checkpoint while the stun is active, one after the trail is out.
  const original = build()
  original.advanceTo(150)
  original.setCommitTick(142)
  const duringStun = original.snapshot()
  assert.equal(
    duringStun.checkpoint.characters.find((character) => character.characterId === 1)?.attackTarget?.targetId,
    2,
    'the checkpoint holds the attack lock',
  )
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
  const launch = 1 + gale.windUpTicks
  const firstLanding = 20 + capricorn.attackWindupTicks
  const secondLanding = 100 + capricorn.attackWindupTicks
  // One auto on tick 20, then another on tick 100: the first is stopped as it lands, or the lock
  // would swing again before the second is ordered.
  simulator.addOrder(1, attack(2, 20))
  stopAttacking(simulator, 1, firstLanding, ORIGIN)
  simulator.addOrder(1, attack(3, 100))
  stopAttacking(simulator, 1, secondLanding, ORIGIN)

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
  const game = new ServerGameState(testSpawns)
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
  assert.equal(accepted.broadcast?.characterId, characterId)
  assert.equal('playerId' in (accepted.broadcast ?? {}), false, 'the session id is not sent to everyone')
  assert.equal('playerName' in (accepted.broadcast ?? {}), false, 'nor the name')
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
  // One attack order, which keeps attacking every cooldown, stopped as the fourth auto lands.
  simulator.addOrder(1, attack(1, 1))
  stopAttacking(simulator, 1, 1 + 3 * soldier.attackCooldownTicks + soldier.attackWindupTicks, ORIGIN)
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
  // Wounded first, so there is something to heal: the brawler's hit takes 100, and only one.
  simulator.addOrder(2, enemyOrder(1, 1, { type: 'attack', targetId: 1 }))
  stopAttacking(simulator, 2, 2, { x: 160, y: 100 })
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
  stopAttacking(simulator, 2, 201, { x: 160, y: 100 })
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
  stopAttacking(simulator, 2, 21, { x: 160, y: 100 })

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
  killAt(dying, 1, 70)
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

// Grenadier kit, against the copy in fixtures.ts. Shots fly 10 px a tick, a brawler is 18 across
// and the grenadier 16, and every duel is laid out along y = 300 with bystanders off to the side.

function createGrenadierDuel(enemies: Array<[number, number]>, at: [number, number] = [300, 300]): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: at[0], y: at[1] }, grenadier)
  enemies.forEach(([x, y], index) => {
    simulator.addPlayer(index + 2, `player-${index + 2}`, `Player ${index + 2}`, { x, y }, brawler)
  })
  return simulator
}

const GRENADIER_AT: Vector2 = { x: 300, y: 300 }
const statusOf = (simulator: Simulator, tick: number, id: number, kind: string) =>
  simulator.at(tick).get(id)?.getStatuses().find((status) => status.kind === kind)

test('a grenade explodes where it lands, throwing every enemy in the blast straight away from the middle', () => {
  // Lobbed 300 px to (600, 300): it launches on tick 5, flies 30 ticks and goes off on tick 36.
  // East and north of the middle, 50 away each, are caught; 140 south is outside the 100 blast
  // (a brawler's body reaches 18 into it, so 118 is as far as anyone is touched).
  const simulator = createGrenadierDuel([[650, 300], [600, 250], [600, 440]])
  simulator.addOrder(1, cast(1, 1, 't-grenade', { mode: 'point', point: { x: 600, y: 300 } }, GRENADIER_AT))
  const grenade = getAbilityDef('t-grenade')
  assert.ok(grenade)

  const launch = 1 + grenade.windUpTicks
  const blast = launch + 30 + 1
  assert.equal(simulator.at(blast - 1).get(2)?.getHealth(), 1000, 'nothing happens while it flies')
  assert.equal(simulator.at(blast).get(2)?.getHealth(), 900)
  assert.equal(simulator.at(blast).get(3)?.getHealth(), 900)
  assert.equal(simulator.at(blast).get(4)?.getHealth(), 1000, 'out of reach of the blast')
  assert.equal(simulator.at(blast).getEntities().some((entity) => entity.defId === 't-grenade-burst'), true)
  // Half of the cooldown, which began when the grenade left, is handed back for catching someone.
  assert.equal(
    simulator.at(blast).get(1)?.getAbilityCooldown('t-grenade').ticksRemaining,
    launch + grenade.cooldownTicks - grenade.cooldownTicks / 2 - blast,
  )

  // Each goes straight away from the middle of the blast, not along the throw: the one to the east
  // is thrown east and the one to the north is thrown north, 150 px each.
  assert.deepEqual(simulator.at(blast + 60).get(2)?.getPosition(), { x: 800, y: 300 })
  assert.deepEqual(simulator.at(blast + 60).get(3)?.getPosition(), { x: 600, y: 100 })
  assert.deepEqual(simulator.at(blast + 60).get(4)?.getPosition(), { x: 600, y: 440 })
  // The thrower is 300 from the middle, nowhere near it, and stays put.
  assert.deepEqual(simulator.at(blast + 60).get(1)?.getPosition(), GRENADIER_AT)
})

test('a grenadier standing in its own blast is thrown clear too, away from the middle of it', () => {
  // Lobbed 30 px to (330, 300), landing on tick 9: the grenadier at x = 300 is 30 from the middle
  // and the enemy at x = 380 is 50 from it, on the other side.
  const simulator = createGrenadierDuel([[380, 300]])
  simulator.addOrder(1, cast(1, 1, 't-grenade', { mode: 'point', point: { x: 330, y: 300 } }, GRENADIER_AT))
  const blast = 1 + 4 + 3 + 1

  assert.equal(simulator.at(blast - 1).get(1)?.isDashing(), false)
  assert.equal(simulator.at(blast).get(2)?.getHealth(), 900)
  assert.equal(simulator.at(blast + 1).get(1)?.isDashing(), true, 'the thrower is thrown too')
  assert.equal(simulator.at(blast + 1).get(2)?.isDashing(), true)
  assert.deepEqual(simulator.at(blast + 60).get(1)?.getPosition(), { x: 200, y: 300 }, '100 away from the middle')
  assert.deepEqual(simulator.at(blast + 60).get(2)?.getPosition(), { x: 530, y: 300 }, 'and the enemy 150 the other way')
})

test('a grenade that catches no enemy refunds nothing, but still throws a grenadier standing in it', () => {
  const simulator = createGrenadierDuel([[700, 300]])
  simulator.addOrder(1, cast(1, 1, 't-grenade', { mode: 'point', point: { x: 330, y: 300 } }, GRENADIER_AT))
  const grenade = getAbilityDef('t-grenade')
  assert.ok(grenade)
  const blast = 1 + grenade.windUpTicks + 3 + 1

  assert.equal(simulator.at(blast).get(2)?.getHealth(), 1000)
  assert.equal(
    simulator.at(blast).get(1)?.getAbilityCooldown('t-grenade').ticksRemaining,
    1 + grenade.windUpTicks + grenade.cooldownTicks - blast,
    'the whole cooldown is still to run',
  )
  assert.deepEqual(simulator.at(blast + 60).get(1)?.getPosition(), { x: 200, y: 300 })
  assert.deepEqual(simulator.at(blast + 60).get(2)?.getPosition(), { x: 700, y: 300 })
})

test('a flashbang stuns an enemy it lands right on, blinds one at the edge of the flash, and spares the rest', () => {
  // Lobbed 300 px to (600, 300), going off on tick 36. The core of the flash is 50 across and the
  // whole of it 120 (each reaching 18 further into a brawler): the first enemy is 20 from the
  // middle, the second 90 and the third 180.
  const simulator = createGrenadierDuel([[620, 300], [600, 390], [600, 480]])
  simulator.addOrder(1, cast(1, 1, 't-flashbang', { mode: 'point', point: { x: 600, y: 300 } }, GRENADIER_AT))
  const blast = 36

  assert.equal(statusOf(simulator, blast - 1, 2, 'stun'), undefined, 'nothing happens while it flies')
  assert.equal(statusOf(simulator, blast, 2, 'stun')?.endTick, blast + 60)
  assert.equal(statusOf(simulator, blast, 2, 'blind'), undefined, 'a direct hit is stunned, not blinded')
  assert.equal(statusOf(simulator, blast, 3, 'blind')?.endTick, blast + 90)
  assert.equal(statusOf(simulator, blast, 3, 'stun'), undefined, 'the edge of the flash only blinds')
  assert.equal(statusOf(simulator, blast, 4, 'stun'), undefined)
  assert.equal(statusOf(simulator, blast, 4, 'blind'), undefined, 'and the third is too far to be touched')
  assert.equal(simulator.at(blast).getEntities().some((entity) => entity.defId === 't-flash-burst'), true)
  // The stun is a second, the blind a second and a half.
  assert.notEqual(statusOf(simulator, blast + 59, 2, 'stun'), undefined)
  assert.equal(statusOf(simulator, blast + 60, 2, 'stun'), undefined)
  assert.notEqual(statusOf(simulator, blast + 89, 3, 'blind'), undefined)
  assert.equal(statusOf(simulator, blast + 90, 3, 'blind'), undefined)
})

test('a blinded enemy\'s autos miss and still use up its cooldown, while it can walk and cast', () => {
  // Lobbed 120 px to (420, 300), going off on tick 18. The enemy is at (420, 380), 80 below the
  // middle: outside the core, inside the flash, and 144 from the thrower, inside its reach of 150.
  const simulator = createGrenadierDuel([[420, 380]])
  simulator.addOrder(1, cast(1, 1, 't-flashbang', { mode: 'point', point: { x: 420, y: 300 } }, GRENADIER_AT))
  // While blinded, the enemy swings at the thrower, then casts, then swings again once it can see.
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 20, type: 'attack', targetId: 1 })
  simulator.addOrder(2, {
    id: 'player-2:2', seq: 2, tick: 30, type: 'cast', abilityId: 't-lash',
    target: { mode: 'unit', unitId: 1 }, origin: { x: 420, y: 380 },
  })
  simulator.addOrder(2, { id: 'player-2:3', seq: 3, tick: 120, type: 'attack', targetId: 1 })

  const went = 18
  assert.equal(statusOf(simulator, went - 1, 2, 'blind'), undefined)
  assert.equal(statusOf(simulator, went, 2, 'blind')?.endTick, went + 90)
  assert.equal(statusOf(simulator, went, 2, 'stun'), undefined)

  // The swing is spent: the cooldown runs, but the thrower is unhurt.
  assert.equal(simulator.at(21).get(1)?.getHealth(), grenadier.maxHp, 'the blind auto missed')
  assert.equal(simulator.at(21).get(2)?.getNextAttackTick(), 20 + 60)
  // A blind unit can still cast, so its lash (300) lands.
  assert.equal(simulator.at(40).get(1)?.getHealth(), grenadier.maxHp - 300)
  // The blind wears off after a second and a half, and the next auto lands.
  assert.equal(statusOf(simulator, went + 89, 2, 'blind') !== undefined, true)
  assert.equal(statusOf(simulator, went + 90, 2, 'blind'), undefined)
  assert.equal(simulator.at(120).get(1)?.getHealth(), grenadier.maxHp - 300 - brawler.attackDamage)
})

test('a molotov coats the ground in fire that slows, and burns in chunks that outlast the fire', () => {
  const simulator = createGrenadierDuel([[600, 300]])
  simulator.addOrder(1, cast(1, 1, 't-molotov', { mode: 'point', point: { x: 600, y: 300 } }, GRENADIER_AT))

  // Lobbed 300 px at 10 a tick: it launches on tick 5, lands on tick 35 and the fire is out on 36,
  // active from 37 and ending after tick 276 (4 s). The enemy stands in the middle throughout.
  assert.equal(simulator.at(36).getEntities()[0]?.defId, 't-molotov-fire')

  // One pass forward, since frames are only kept for a few ticks behind the newest.
  const losses = new Map<number, number>()
  const seen = new Map<number, { slow?: number; burn?: number }>()
  let previous = 1000
  for (let tick = 37; tick <= 500; tick += 1) {
    const health = simulator.at(tick).get(2)?.getHealth() ?? 0
    if (health < previous) losses.set(tick, previous - health)
    previous = health
    seen.set(tick, { slow: statusOf(simulator, tick, 2, 'slow')?.amount, burn: statusOf(simulator, tick, 2, 'burn')?.amount })
  }
  assertClose(seen.get(100)?.slow ?? 0, 0.3)
  assert.equal(seen.get(100)?.burn, 20, '40 a second, in two chunks a second')
  // The first chunk is on the first pulse tick after it was lit, and every chunk is on a pulse tick.
  assert.equal([...losses.keys()][0], 2 * GAME_BURN_PULSE_TICKS)
  for (const [tick, lost] of losses) {
    assert.equal(tick % GAME_BURN_PULSE_TICKS, 0, `tick ${tick} is a pulse tick`)
    assert.equal(lost, 20)
  }
  // The fire is refreshed every tick it stands in it, until tick 276; the burn then lasts 180 more
  // ticks, so the last pulse is on 450 and none follow. Pulses on 60, 90 ... 450 make 14.
  assert.equal(losses.size, 14)
  assert.equal([...losses.keys()].at(-1), 450)
  assert.equal(seen.get(278)?.slow, undefined, 'the slow is gone with the fire')
  assert.notEqual(seen.get(400)?.burn, undefined, 'but the burn goes on')
  assert.equal(seen.get(456)?.burn, undefined)
  assert.equal(simulator.at(500).get(2)?.getHealth(), 1000 - 14 * 20)
})

test('an enemy that walks out of the fire keeps burning for the burn\'s length, and not for longer', () => {
  const simulator = createGrenadierDuel([[600, 300]])
  simulator.addOrder(1, cast(1, 1, 't-molotov', { mode: 'point', point: { x: 600, y: 300 } }, GRENADIER_AT))
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 100, type: 'move', target: { x: 600, y: 900 } })

  let lastSlowed = -1
  let lastBurning = -1
  for (let tick = 100; tick <= 400; tick += 1) {
    if (statusOf(simulator, tick, 2, 'slow')) lastSlowed = tick
    if (statusOf(simulator, tick, 2, 'burn')) lastBurning = tick
  }
  assert.ok(lastSlowed > 110 && lastSlowed < 250, `it was slowed until it was clear of the fire, on tick ${lastSlowed}`)
  // The 2-tick slow and the 180-tick burn were last renewed on the same tick.
  assert.equal(lastBurning - lastSlowed, 180 - 2)
})

test('a burn deals damage on every pulse, in the owner\'s name, and resistance cuts each chunk', () => {
  const plain = createGrenadierDuel([[400, 300]])
  plain.addOrder(1, cast(1, 1, 't-ignite', { mode: 'unit', unitId: 2 }, GRENADIER_AT))
  // Lit on tick 1 for 120 ticks, so it burns on ticks 30, 60, 90 and 120 and is out by tick 121.
  assert.equal(plain.at(29).get(2)?.getHealth(), 1000)
  assert.equal(plain.at(30).get(2)?.getHealth(), 970)
  const pulse = plain.at(30).events.find((event) => event.type === 'damage')
  assert.deepEqual(
    pulse && 'targetId' in pulse ? [pulse.ownerId, pulse.targetId, pulse.amount] : undefined,
    [1, 2, 30],
    'the chunk is damage credited to whoever lit it',
  )
  assert.equal(plain.at(90).get(2)?.getHealth(), 910)
  assert.equal(plain.at(120).get(2)?.getHealth(), 880)
  assert.equal(statusOf(plain, 121, 2, 'burn'), undefined)
  assert.equal(plain.at(200).get(2)?.getHealth(), 880, 'and nothing more once it has run out')

  // 80% resistance cuts each 30 down to 6.
  const guarded = new Simulator()
  guarded.addPlayer(1, 'player-1', 'Player 1', GRENADIER_AT, grenadier)
  guarded.addPlayer(2, 'player-2', 'Player 2', { x: 400, y: 300 }, new Champion({ ...brawler, abilities: ['t-guard'] }))
  guarded.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-guard', target: { mode: 'none' }, origin: { x: 400, y: 300 },
  })
  guarded.addOrder(1, cast(1, 2, 't-ignite', { mode: 'unit', unitId: 2 }, GRENADIER_AT))
  assert.equal(guarded.at(121).get(2)?.getHealth(), 1000 - 4 * 6)
})

test('three autos on one enemy give move speed that fades to nothing, and others do not count', () => {
  const simulator = createGrenadierDuel([[450, 300], [450, 380]])
  const auto = (seq: number, tick: number, targetId: number): CharacterOrder =>
    ({ id: `player-1:${seq}`, seq, tick, type: 'attack', targetId })
  // Enemy 2, then 3, then 2: the third auto overall, but only the second at enemy 2.
  simulator.addOrder(1, auto(1, 1, 2))
  simulator.addOrder(1, auto(2, 61, 3))
  simulator.addOrder(1, auto(3, 121, 2))
  simulator.addOrder(1, auto(4, 181, 2))

  const markers = (tick: number, id: number) => simulator.at(tick).get(id)?.getMarkers().length
  assert.equal(markers(4, 2), 1, 'each auto marks its target')
  assert.equal(markers(64, 3), 1, 'and the other enemy keeps its own count')
  assert.equal(markers(124, 2), 2)
  assert.equal(statusOf(simulator, 124, 1, 'haste'), undefined, 'three autos in all, but not on one enemy')
  // Autos land 3 ticks after they are ordered: the third at enemy 2 is on tick 184.
  assert.equal(statusOf(simulator, 183, 1, 'haste'), undefined)
  const haste = statusOf(simulator, 184, 1, 'haste')
  assert.deepEqual([haste?.amount, haste?.fades, haste?.endTick], [0.5, true, 184 + 120])
  assert.equal(markers(184, 2), 0, 'the marks are spent')
  assert.equal(markers(184, 3), 1, 'but the other enemy keeps its own')
})

test('the fading speed starts at its full bonus, falls in a straight line and ends at the base speed', () => {
  const simulator = createGrenadierDuel([[450, 300]])
  for (const [seq, tick] of [[1, 1], [2, 61], [3, 121]]) {
    simulator.addOrder(1, { id: `player-1:${seq}`, seq, tick, type: 'attack', targetId: 2 })
  }
  // Heads away along y once the third auto has landed, on tick 124; the haste runs to tick 244.
  simulator.addOrder(1, { id: 'player-1:4', seq: 4, tick: 125, type: 'move', target: { x: 300, y: 1000 } })

  const step = (tick: number): number => {
    const before = simulator.at(tick - 1).get(1)?.getPosition()
    const after = simulator.at(tick).get(1)?.getPosition()
    assert.ok(before && after)
    return Math.hypot(after.x - before.x, after.y - before.y)
  }
  const base = grenadier.moveSpeed / GAME_TPS
  // The step over (t - 1, t] uses the share of the haste still ahead at t - 1.
  const expected = (tick: number): number => base * (1 + 0.5 * Math.max(0, Math.min(1, (244 - (tick - 1)) / 120)))

  const sampled = [126, 150, 186, 220, 243]
  const steps = sampled.map(step)
  sampled.forEach((tick, index) => assertClose(steps[index], expected(tick)))
  assert.ok(steps[0] > base * 1.4, 'it starts near the full 50%')
  assert.ok(steps.every((value, index) => index === 0 || value < steps[index - 1]), 'and only falls')
  assert.ok(steps[steps.length - 1] < base * 1.01, 'to almost nothing')
  assertClose(step(245), base)
  assertClose(step(300), base)
})

test('burn, fading haste and blind survive a checkpoint restore', () => {
  const build = (): Simulator => {
    const simulator = createGrenadierDuel([[450, 300]])
    for (const [seq, tick] of [[1, 1], [2, 61], [3, 121]]) {
      simulator.addOrder(1, { id: `player-1:${seq}`, seq, tick, type: 'attack', targetId: 2 })
    }
    simulator.addOrder(1, cast(4, 130, 't-ignite', { mode: 'unit', unitId: 2 }, GRENADIER_AT))
    simulator.addOrder(1, { id: 'player-1:5', seq: 5, tick: 135, type: 'move', target: { x: 300, y: 1000 } })
    return simulator
  }
  const record = (simulator: Simulator, from: number, to: number): Map<number, string> => {
    const frames = new Map<number, string>()
    for (let tick = from; tick <= to; tick += 1) {
      const frame = simulator.at(tick)
      frames.set(tick, JSON.stringify([frame.get(1)?.getPosition(), frame.get(2)?.getHealthState(), frame.get(1)?.getStatuses()]))
    }
    return frames
  }
  const expected = record(build(), 1, 280)

  const original = build()
  original.advanceTo(160)
  original.setCommitTick(150)
  const snapshot = original.snapshot()
  const parsed = GameSnapshotSchema.safeParse(snapshot)
  assert.equal(parsed.success, true)
  const statuses = (parsed.success ? parsed.data.checkpoint.characters : []).flatMap((character) => character.statuses)
  assert.equal(statuses.some((status) => status.kind === 'burn'), true, 'the burn travels in the checkpoint')
  assert.equal(statuses.some((status) => status.kind === 'haste' && status.fades === true), true, 'and so does the fading')

  const restored = new Simulator()
  restored.replaceFromSnapshot(snapshot)
  for (const [tick, frame] of record(restored, 151, 280)) assert.equal(frame, expected.get(tick), `tick ${tick}`)
})

// Trinketmaster kit, against the copy in fixtures.ts. The trinketmaster is 17 across and a brawler
// 18, the stick and its recall fly 10 px a tick and the stick can be picked up from 16 + 17 away.

const TRINKET_AT: Vector2 = { x: 300, y: 300 }
const STICK_AT: Vector2 = { x: 600, y: 300 }
const EAST: CastTarget = { mode: 'direction', dir: { x: 1, y: 0 } }
// The stick thrown at the point 300 px east of the trinketmaster, the farthest it goes.
const STICK_EAST: CastTarget = { mode: 'point', point: STICK_AT }
// Thrown east on tick 1, the stick leaves on tick 5, flies its 300 px in 30 ticks and is down on tick 36.
const STICK_DOWN = 36
const STICK_PICKUP_REACH = 16 + trinketmaster.radius

function createStickDuel(enemies: Array<[number, number, Champion?]> = []): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', TRINKET_AT, trinketmaster)
  enemies.forEach(([x, y, champion], index) => {
    simulator.addPlayer(index + 2, `player-${index + 2}`, `Player ${index + 2}`, { x, y }, champion ?? brawler)
  })
  return simulator
}

function throwStick(simulator: Simulator): void {
  simulator.addOrder(1, cast(1, 1, 't-stick', STICK_EAST, TRINKET_AT))
}

const sticksOut = (simulator: Simulator, tick: number) =>
  simulator.at(tick).getEntities().filter((entity) => entity.defId === 't-stick')
const throwCooldown = (simulator: Simulator, tick: number) =>
  simulator.at(tick).get(1)?.getAbilityCooldown('t-stick')

defineAbility({
  id: 't-root-test',
  targeting: 'unit',
  range: 300,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: 600,
  apply: [root(300, targetUnit())],
})

test('a stick lands where its flight ends, and stays there with no timer', () => {
  const simulator = createStickDuel()
  throwStick(simulator)

  assert.deepEqual(simulator.at(STICK_DOWN - 1).getEntities().map((entity) => entity.defId), ['t-stick-shot'])
  assert.deepEqual(sticksOut(simulator, STICK_DOWN).map((entity) => entity.origin), [STICK_AT])
  assert.equal(throwCooldown(simulator, STICK_DOWN)?.ticksRemaining, 5 + 480 - STICK_DOWN)
  // Long after the throw could be used again, it is still lying there.
  assert.equal(sticksOut(simulator, 536).length, 1)
  assert.equal(throwCooldown(simulator, 536)?.ready, true)
})

test('walking over the stick picks it up, and the throw then has no more than a second left', () => {
  const simulator = createStickDuel()
  throwStick(simulator)
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 40, type: 'move', target: STICK_AT })

  let pickedUp: { tick: number; remaining: number; distance: number } | undefined
  for (let tick = 40; tick <= 250 && !pickedUp; tick += 1) {
    if (sticksOut(simulator, tick).length > 0) continue
    const position = simulator.at(tick).get(1)?.getPosition() ?? { x: 0, y: 0 }
    pickedUp = {
      tick,
      remaining: throwCooldown(simulator, tick)?.ticksRemaining ?? -1,
      distance: Math.hypot(position.x - STICK_AT.x, position.y - STICK_AT.y),
    }
  }

  assert.ok(pickedUp, 'it was picked up')
  // The moment the two bodies touch, not when the walker reaches the middle of it.
  assert.ok(pickedUp.distance <= STICK_PICKUP_REACH && pickedUp.distance > STICK_PICKUP_REACH - 3, `${pickedUp.distance}`)
  assert.equal(pickedUp.remaining, 60, 'hundreds of ticks were left, now one second')
  assert.equal(throwCooldown(simulator, pickedUp.tick + 59)?.ready, false)
  assert.equal(throwCooldown(simulator, pickedUp.tick + 60)?.ready, true)
})

test('a pickup never lengthens a throw that had less than a second left', () => {
  const simulator = createStickDuel()
  throwStick(simulator)
  // The throw is ready again on tick 485; the walk starts after that, so it is ready on arrival.
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 460, type: 'move', target: STICK_AT })

  let remaining: number | undefined
  for (let tick = 460; tick <= 700 && remaining === undefined; tick += 1) {
    if (sticksOut(simulator, tick).length === 0) remaining = throwCooldown(simulator, tick)?.ticksRemaining
  }
  assert.equal(remaining, 0)
})

test('pressing the key again calls the stick back through enemies, hurting and slowing each once, and refunds nothing', () => {
  // The enemy is 150 px along the line the stick flies, so it is hit on the way out and again on
  // the way back.
  const simulator = createStickDuel([[450, 300]])
  throwStick(simulator)
  simulator.addOrder(1, {
    id: 'player-1:2', seq: 2, tick: 40, type: 'cast', abilityId: 't-recall', target: { mode: 'none' }, origin: TRINKET_AT,
  })

  // Going out, 10 px a tick from x = 300 on tick 5: it touches the enemy at x = 450 (26 apart) after
  // 13 steps, on tick 18. That hurts but does not slow.
  assert.equal(simulator.at(17).get(2)?.getHealth(), 1000)
  assert.equal(simulator.at(18).get(2)?.getHealth(), 940)
  assert.equal(simulator.at(18).get(2)?.getStatuses().some((status) => status.kind === 'slow'), false)

  // Called back, it is launched on tick 42 from where the stick lay, and the stick is no longer on
  // the ground.
  const flying = simulator.at(42).getEntities()
  assert.deepEqual(flying.map((entity) => entity.defId), ['t-stick-recall'])
  assert.deepEqual(flying[0].origin, STICK_AT)
  assert.equal(flying[0].targetId, 1, 'bound for its owner')
  // Coming home from x = 600, it touches the enemy at x = 450 (32 apart) after 12 steps, on tick 54,
  // and this time it hurts and slows.
  assert.equal(simulator.at(53).get(2)?.getHealth(), 940)
  assert.equal(simulator.at(54).get(2)?.getHealth(), 880)
  const slowed = simulator.at(54).get(2)?.getStatuses().find((status) => status.kind === 'slow')
  assert.deepEqual([slowed?.amount, slowed?.endTick], [0.4, 54 + 90])
  // And it touches its owner at x = 300 (31 apart) after 27 steps, on tick 69, and is gone. Unlike
  // walking over the stick, that does nothing for the throw: it is 480 ticks from tick 5 as before.
  assert.equal(simulator.at(68).getEntities().length, 1)
  assert.equal(simulator.at(69).getEntities().length, 0)
  assert.equal(throwCooldown(simulator, 69)?.ticksRemaining, 5 + 480 - 69)
  assert.equal(simulator.at(100).get(2)?.getHealth(), 880, 'hit once each way and no more')
})

test('the stick hurts every enemy in its line on the way out, once each, and none beside it or beyond it', () => {
  // Along y = 300 the stick flies from x = 300 on tick 5 and comes down at x = 600 on tick 36. It
  // touches within 8 + 18 = 26: the first enemy after 8 steps (tick 13), the second after 18 (tick
  // 23). The third is 80 beside its path and the fourth 100 past where it comes down.
  const simulator = createStickDuel([[400, 300], [500, 300], [500, 380], [700, 300]])
  throwStick(simulator)

  assert.equal(simulator.at(12).get(2)?.getHealth(), 1000)
  assert.equal(simulator.at(13).get(2)?.getHealth(), 940)
  assert.equal(simulator.at(22).get(3)?.getHealth(), 1000)
  assert.equal(simulator.at(23).get(3)?.getHealth(), 940, 'it goes on through the first and hits the second')
  assert.equal(sticksOut(simulator, STICK_DOWN).length, 1, 'and then comes down')
  for (const id of [2, 3]) {
    assert.equal(simulator.at(STICK_DOWN + 20).get(id)?.getHealth(), 940, `enemy ${id} was hit once`)
    assert.equal(simulator.at(STICK_DOWN + 20).get(id)?.getStatuses().length, 0, 'and not slowed')
  }
  assert.equal(simulator.at(STICK_DOWN + 20).get(4)?.getHealth(), 1000, 'beside the path is not hit')
  assert.equal(simulator.at(STICK_DOWN + 20).get(5)?.getHealth(), 1000, 'past where it lands is not hit')
})

test('the player chooses how far the stick goes: it comes down on the point it was thrown at, after as long as that is far', () => {
  // The stick leaves on tick 5 and flies 10 px a tick, so it is down on tick 6 plus a tick for every
  // 10 px: 21 for the nearest it can be thrown, 150, and 36 for the farthest, 300.
  for (const [distance, down] of [[150, 21], [200, 26], [250, 31], [300, 36]] as const) {
    const simulator = createStickDuel()
    simulator.addOrder(1, cast(1, 1, 't-stick', { mode: 'point', point: { x: 300 + distance, y: 300 } }, TRINKET_AT))
    assert.equal(sticksOut(simulator, down - 1).length, 0, `not down yet on tick ${down - 1} at ${distance}`)
    assert.deepEqual(sticksOut(simulator, down)[0]?.origin, { x: 300 + distance, y: 300 }, `down on tick ${down}, ${distance} px on`)
  }

  // Any heading, not only along the row: a point 200 px away up and to the left.
  const diagonal = createStickDuel()
  const aimed = { x: 300 - 200 * Math.SQRT1_2, y: 300 - 200 * Math.SQRT1_2 }
  diagonal.addOrder(1, cast(1, 1, 't-stick', { mode: 'point', point: aimed }, TRINKET_AT))
  const down = sticksOut(diagonal, 26)[0]
  assert.ok(down)
  assert.ok(Math.abs(down.origin.x - aimed.x) < 1e-9 && Math.abs(down.origin.y - aimed.y) < 1e-9)
})

test('the stick hurts what it passes on the way to where it was thrown and nothing beyond it', () => {
  // Thrown 200 px east, to x = 500: the enemy at 400 is in its way, and the one at 560 is past where it stops.
  const simulator = createStickDuel([[400, 300], [560, 300]])
  simulator.addOrder(1, cast(1, 1, 't-stick', { mode: 'point', point: { x: 500, y: 300 } }, TRINKET_AT))

  assert.equal(simulator.at(60).get(2)?.getHealth(), brawler.maxHp - 60, 'the one on the way is hurt')
  assert.equal(simulator.at(60).get(3)?.getHealth(), brawler.maxHp, 'and the one beyond is not')
  assert.deepEqual(sticksOut(simulator, 60)[0]?.origin, { x: 500, y: 300 })
})

test('a throw aimed nearer than 150 or farther than 300 is dropped, one at exactly either is thrown', () => {
  const throwAt = (distance: number): Simulator => {
    const simulator = createStickDuel()
    simulator.addOrder(1, cast(1, 1, 't-stick', { mode: 'point', point: { x: 300 + distance, y: 300 } }, TRINKET_AT))
    return simulator
  }
  const thrown = (simulator: Simulator): boolean => throwCooldown(simulator, 40)?.ready === false

  assert.equal(thrown(throwAt(150)), true, 'at the least')
  assert.equal(thrown(throwAt(300)), true, 'and at the most')
  const tooNear = throwAt(149)
  assert.equal(thrown(tooNear), false, 'a throw a pixel too near is not made')
  assert.equal(sticksOut(tooNear, 60).length, 0)
  assert.equal(thrown(throwAt(10)), false, 'nor one nearly on top of the thrower')
  assert.equal(thrown(throwAt(301)), false, 'nor one a pixel too far')
})

test('a stick thrown at a wall comes down against it, inside the map, instead of flying out of it', () => {
  const shotRadius = 8
  // Thrown at the point 300 px east of 2300, which is off the map. The stick comes down where its
  // edge meets the east wall, x = 2392, 92 px on, not at x = 2600.
  const east = new Simulator()
  east.addPlayer(1, 'player-1', 'Player 1', { x: 2300, y: 300 }, trinketmaster)
  east.addOrder(1, cast(1, 1, 't-stick', { mode: 'point', point: { x: 2600, y: 300 } }, { x: 2300, y: 300 }))
  const eastStick = sticksOut(east, 15)[0]
  assert.deepEqual(eastStick?.origin, { x: GAME_ARENA_WIDTH - shotRadius, y: 300 })

  // And the same up the page against the top wall: it comes down at y = 8, 32 px on.
  const north = new Simulator()
  north.addPlayer(1, 'player-1', 'Player 1', { x: 300, y: 40 }, trinketmaster)
  north.addOrder(1, cast(1, 1, 't-stick', { mode: 'point', point: { x: 300, y: -260 } }, { x: 300, y: 40 }))
  const northStick = sticksOut(north, 9)[0]
  assert.deepEqual(northStick?.origin, { x: 300, y: shotRadius })

  // Far from any wall it comes down exactly where it was thrown.
  const open = createStickDuel()
  throwStick(open)
  assert.deepEqual(sticksOut(open, STICK_DOWN)[0]?.origin, STICK_AT)

  // A stick against a wall can still be picked up by walking to it.
  east.addOrder(1, { id: 'player-1:2', seq: 2, tick: 20, type: 'move', target: { x: 2392, y: 300 } })
  let pickedUp = -1
  for (let tick = 20; tick <= 100 && pickedUp < 0; tick += 1) {
    if (sticksOut(east, tick).length === 0) pickedUp = tick
  }
  assert.ok(pickedUp > 0, 'it was picked up')
})

test('the stick called back follows an owner who walks away from it', () => {
  const simulator = createStickDuel()
  throwStick(simulator)
  simulator.addOrder(1, {
    id: 'player-1:2', seq: 2, tick: 40, type: 'cast', abilityId: 't-recall', target: { mode: 'none' }, origin: TRINKET_AT,
  })
  simulator.addOrder(1, { id: 'player-1:3', seq: 3, tick: 43, type: 'move', target: { x: 300, y: 900 } })

  let headingSouth = 0
  let home: { tick: number; y: number } | undefined
  for (let tick = 43; tick <= 250 && !home; tick += 1) {
    const frame = simulator.at(tick)
    const stick = frame.getEntities()[0]
    if (tick === 55) headingSouth = stick?.velocity.y ?? 0
    if (!stick) home = { tick, y: frame.get(1)?.getPosition().y ?? 0 }
  }

  assert.ok(headingSouth > 0, 'it bent toward where its owner had got to')
  assert.ok(home && home.tick > 69 && home.tick < 150, `it caught up on tick ${home?.tick}`)
  assert.ok((home?.y ?? 0) > 300, 'while the owner was still walking')
  assert.equal(throwCooldown(simulator, home?.tick ?? 0)?.ticksRemaining, 5 + 480 - (home?.tick ?? 0), 'and no refund')
})

test('warp blinks to the stick in a single tick, wherever it is, and the pickup follows on the next', () => {
  const simulator = createStickDuel()
  throwStick(simulator)
  simulator.addOrder(1, cast(2, 40, 't-warp', { mode: 'none' }, TRINKET_AT))
  const warp = getAbilityDef('t-warp')
  assert.ok(warp)
  const landed = 40 + warp.windUpTicks

  assert.deepEqual(simulator.at(landed - 1).get(1)?.getPosition(), TRINKET_AT)
  assert.deepEqual(simulator.at(landed).get(1)?.getPosition(), STICK_AT, 'there in a single tick')
  assert.equal(simulator.at(landed).get(1)?.isDashing(), false, 'it is a blink, not a dash')
  assert.equal(sticksOut(simulator, landed).length, 1, 'the stick is still down on the tick it arrives')
  assert.equal(sticksOut(simulator, landed + 1).length, 0, 'and picked up on the next')
  assert.equal(throwCooldown(simulator, landed + 1)?.ticksRemaining, 60)
  assert.equal(
    simulator.at(landed + 1).get(1)?.getAbilityCooldown('t-warp').ticksRemaining,
    landed + warp.cooldownTicks - (landed + 1),
    'warp itself is spent',
  )
})

test('warp with no stick anywhere and the throw on cooldown gives the throw back instead of blinking', () => {
  const warp = getAbilityDef('t-warp')
  assert.ok(warp)
  const simulator = createStickDuel()
  throwStick(simulator)
  // The stick is thrown on tick 1, down on 36, called back on 40 and home by about tick 75, with the
  // throw's 8 s, from tick 5, still running. Warp is cast on tick 120 with nothing out.
  simulator.addOrder(1, cast(2, 40, 't-recall', { mode: 'none' }, TRINKET_AT))
  const warpAt = 120
  simulator.addOrder(1, cast(3, warpAt, 't-warp', { mode: 'none' }, TRINKET_AT))
  const launched = warpAt + warp.windUpTicks

  assert.equal(sticksOut(simulator, warpAt - 1).length, 0, 'there is no stick')
  assert.equal(simulator.at(warpAt - 1).getEntities().length, 0, 'in the air either')
  assert.equal(throwCooldown(simulator, warpAt - 1)?.ready, false, 'and the throw is on cooldown')
  assert.equal(throwCooldown(simulator, launched - 1)?.ready, false, 'it stays there through the windup')
  const frame = simulator.at(launched)
  assert.equal(throwCooldown(simulator, launched)?.ready, true, 'then warp gives it back, all of it')
  assert.equal(frame.get(1)?.getAbilityCooldown('t-warp').ticksRemaining, warp.cooldownTicks, 'at the cost of its own cooldown')
  assert.deepEqual(frame.get(1)?.getPosition(), TRINKET_AT, 'and the trinketmaster has not gone anywhere')

  // The throw can go again at once.
  simulator.addOrder(1, cast(4, launched + warp.backswingTicks + 1, 't-stick', STICK_EAST, TRINKET_AT))
  assert.equal(sticksOut(simulator, launched + warp.backswingTicks + 1 + STICK_DOWN).length, 1, 'and does')
})

test('warp with a stick on the ground still blinks to it, and the throw is not given back', () => {
  const simulator = createStickDuel()
  throwStick(simulator)
  simulator.addOrder(1, cast(2, 40, 't-warp', { mode: 'none' }, TRINKET_AT))
  const warp = getAbilityDef('t-warp')
  assert.ok(warp)
  const landed = 40 + warp.windUpTicks

  assert.deepEqual(simulator.at(landed).get(1)?.getPosition(), STICK_AT, 'it goes to the stick')
  // Walking over the stick, which warping onto it is, leaves the throw a second to wait: not ready.
  assert.equal(throwCooldown(simulator, landed + 1)?.ready, false)
  assert.equal(throwCooldown(simulator, landed + 1)?.ticksRemaining, 60)
})

test('warp is still dropped with the throw ready and nothing out, and while the stick is in the air', () => {
  const warp = getAbilityDef('t-warp')
  assert.ok(warp)
  const wasCast = (simulator: Simulator, tick: number): boolean =>
    simulator.at(tick).get(1)?.getAbilityCooldown('t-warp').ready === false

  // The throw is ready and there is no stick: nothing for it to do.
  const ready = createStickDuel()
  ready.addOrder(1, cast(1, 1, 't-warp', { mode: 'none' }, TRINKET_AT))
  assert.equal(wasCast(ready, 10), false)

  // The stick is on its way out, and the throw is on cooldown, but it is in play.
  const flying = createStickDuel()
  throwStick(flying)
  flying.addOrder(1, cast(2, 10, 't-warp', { mode: 'none' }, TRINKET_AT))
  assert.equal(throwCooldown(flying, 14)?.ready, false)
  assert.equal(wasCast(flying, 14), false)

  // And on its way back.
  const returning = createStickDuel()
  throwStick(returning)
  returning.addOrder(1, cast(2, 40, 't-recall', { mode: 'none' }, TRINKET_AT))
  returning.addOrder(1, cast(3, 50, 't-warp', { mode: 'none' }, TRINKET_AT))
  assert.equal(returning.at(50).getEntities().some((entity) => entity.defId === 't-stick-recall'), true, 'it is in the air')
  assert.equal(wasCast(returning, 55), false)
})

test('a blink is not held by a root, but is stopped by a silence, and needs a stick to blink to', () => {
  // A root holds a walker but not a blink: the root lands on tick 41 and the blink on tick 48.
  const rooted = createStickDuel([[400, 300, new Champion({ ...brawler, abilities: ['t-root-test'] })]])
  throwStick(rooted)
  rooted.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 41, type: 'cast', abilityId: 't-root-test',
    target: { mode: 'unit', unitId: 1 }, origin: { x: 400, y: 300 },
  })
  rooted.addOrder(1, cast(2, 45, 't-warp', { mode: 'none' }, TRINKET_AT))
  assert.equal(rooted.at(47).get(1)?.getStatuses().some((status) => status.kind === 'root'), true)
  assert.deepEqual(rooted.at(48).get(1)?.getPosition(), STICK_AT)

  // The enemy readies a hush on tick 41 and autos on tick 42, so the silence is on from tick 45 and the
  // cast on tick 50 is dropped: no blink, and nothing is spent.
  const silenced = createStickDuel([[380, 300, trinketmaster]])
  throwStick(silenced)
  silenced.addOrder(2, cast(1, 41, 't-hush', { mode: 'none' }, { x: 380, y: 300 }))
  silenced.addOrder(2, { id: 'player-2:2', seq: 2, tick: 42, type: 'attack', targetId: 1 })
  silenced.addOrder(1, cast(2, 50, 't-warp', { mode: 'none' }, TRINKET_AT))
  assert.equal(silenced.at(44).get(1)?.getStatuses().some((status) => status.kind === 'silence'), false)
  assert.equal(silenced.at(46).get(1)?.getStatuses().some((status) => status.kind === 'silence'), true)
  assert.deepEqual(silenced.at(56).get(1)?.getPosition(), TRINKET_AT)
  assert.equal(silenced.at(56).get(1)?.getAbilityCooldown('t-warp').ready, true)

  // With no stick out there is nowhere to blink to, and the cast is dropped the same way.
  const bare = createStickDuel()
  bare.addOrder(1, cast(1, 1, 't-warp', { mode: 'none' }, TRINKET_AT))
  assert.deepEqual(bare.at(10).get(1)?.getPosition(), TRINKET_AT)
  assert.equal(bare.at(10).get(1)?.getAbilityCooldown('t-warp').ready, true, 'the cooldown was not spent')
})

test('the throw needs no stick out and the recall needs one, so a second stick is not thrown and nothing is called back', () => {
  const simulator = createStickDuel()
  throwStick(simulator)
  // The throw is ready again from tick 485, but a stick is still lying there, so this is dropped.
  simulator.addOrder(1, cast(2, 600, 't-stick', STICK_EAST, TRINKET_AT))
  assert.deepEqual(simulator.at(606).getEntities().map((entity) => entity.defId), ['t-stick'])
  assert.equal(throwCooldown(simulator, 606)?.ready, true, 'and no cooldown was spent')

  const bare = createStickDuel()
  bare.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-recall', target: { mode: 'none' }, origin: TRINKET_AT,
  })
  assert.equal(bare.at(10).get(1)?.getAbilityCooldown('t-recall').ready, true)
  assert.equal(bare.at(10).getEntities().length, 0)
})

test('the recall is the trinketmaster\'s to cast though it is on no key, and no one else\'s', () => {
  assert.equal(trinketmaster.hasAbility('t-recall'), true)
  assert.equal(trinketmaster.abilities.includes('t-recall'), false)
  assert.equal(brawler.hasAbility('t-recall'), false)
})

test('a champion cannot have an ability whose recast does not exist', () => {
  defineAbility({
    id: 't-broken-recast',
    targeting: 'none',
    range: 0,
    windUpTicks: 0,
    backswingTicks: 0,
    cooldownTicks: 60,
    recast: 't-does-not-exist',
    apply: [damage(1, enemiesInRadius(10))],
  })

  assert.throws(() => new Champion({ ...brawler, abilities: ['t-broken-recast'] }), /recast "t-does-not-exist" is unknown/)
})

test('a silence stops starting abilities and nothing else: the unit still walks, attacks and finishes a cast', () => {
  // The trinketmaster readies a hush on tick 1 and autos the brawler on tick 2, which lands on tick 5 and
  // silences it; the brawler's lash, begun on tick 1, still lands.
  const simulator = createStickDuel([[380, 300]])
  simulator.addOrder(1, cast(1, 1, 't-hush', { mode: 'none' }, TRINKET_AT))
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 2, type: 'attack', targetId: 2 })
  stopAttacking(simulator, 1, 2 + trinketmaster.attackWindupTicks, TRINKET_AT)
  simulator.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-lash',
    target: { mode: 'unit', unitId: 1 }, origin: { x: 380, y: 300 },
  })
  // Silenced from tick 5 to 95. A shockwave (200 to everyone within 120) cast on tick 20 is dropped;
  // an auto on tick 30 lands; a short walk on tick 40 goes (and ends the attack lock, so there is no
  // second auto); and a shockwave on tick 100, once the silence is over, lands. The shockwave is not
  // on cooldown from the lash, so only the silence can be what stops the first.
  const shockwave = (seq: number, tick: number): CharacterOrder => ({
    id: `player-2:${seq}`, seq, tick, type: 'cast', abilityId: 't-shockwave',
    target: { mode: 'none' }, origin: { x: 380, y: 300 },
  })
  simulator.addOrder(2, shockwave(2, 20))
  simulator.addOrder(2, { id: 'player-2:3', seq: 3, tick: 30, type: 'attack', targetId: 1 })
  simulator.addOrder(2, { id: 'player-2:4', seq: 4, tick: 40, type: 'move', target: { x: 380, y: 340 } })
  simulator.addOrder(2, { ...shockwave(5, 100), origin: { x: 380, y: 340 } })

  const silencedAt = 2 + trinketmaster.attackWindupTicks
  assert.equal(simulator.at(silencedAt - 1).get(2)?.getStatuses().some((status) => status.kind === 'silence'), false)
  assert.equal(simulator.at(silencedAt).get(2)?.getStatuses().find((status) => status.kind === 'silence')?.endTick, silencedAt + 90)
  assert.equal(simulator.at(10).get(1)?.getHealth(), trinketmaster.maxHp - 300, 'the lash already begun landed')
  assert.equal(simulator.at(29).get(1)?.getHealth(), trinketmaster.maxHp - 300, 'the shockwave was dropped')
  assert.equal(simulator.at(29).get(2)?.getAbilityCooldown('t-shockwave').ready, true, 'and not spent')
  assert.equal(simulator.at(31).get(1)?.getHealth(), trinketmaster.maxHp - 300 - brawler.attackDamage, 'the auto landed')
  assert.ok((simulator.at(60).get(2)?.getPosition().y ?? 300) > 300, 'and it walked')
  assert.equal(
    simulator.at(107).get(1)?.getHealth(),
    trinketmaster.maxHp - 300 - brawler.attackDamage - 200,
    'a shockwave cast after the silence is over lands',
  )
})

test('auto, hush, auto: hush resets the auto timer, so the next auto follows at once and carries the silence', () => {
  const simulator = createStickDuel([[360, 300]])
  const windup = trinketmaster.attackWindupTicks
  // One attack order keeps the trinketmaster swinging; the hush has no windup, so it does not interrupt.
  // The hush is cast on tick 5 and the auto it frees begins on the tick after, once the reset is written.
  simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  simulator.addOrder(1, cast(2, 5, 't-hush', { mode: 'none' }, TRINKET_AT))
  stopAttacking(simulator, 1, 6 + windup, TRINKET_AT)

  // The auto at tick 1 puts its next one at tick 61; it has landed plainly, with nothing readied.
  assert.equal(simulator.at(1 + windup).get(1)?.getNextAttackTick(), 61)
  assert.equal(simulator.at(1 + windup).get(2)?.getHealth(), brawler.maxHp - trinketmaster.attackDamage)
  assert.equal(simulator.at(1 + windup).get(2)?.getStatuses().length, 0)

  // The hush brings the timer back to the hush's own tick, and readies the next auto.
  assert.equal(simulator.at(5).get(1)?.getNextAttackTick(), 5)
  assert.equal(markerCount(simulator, 5, 'ready:t-hush', 1), 1)

  // So the auto follows at once, not on tick 61.
  const second = simulator.at(6).get(1)?.getAction()
  assert.equal(second?.kind, 'attack')
  assert.equal(second?.startTick, 6)
  assert.equal(simulator.at(6 + windup - 1).get(2)?.getStatuses().length, 0)

  const frame = simulator.at(6 + windup)
  assert.equal(frame.get(2)?.getHealth(), brawler.maxHp - 2 * trinketmaster.attackDamage, 'the second auto landed')
  assert.equal(frame.get(1)?.getNextAttackTick(), 6 + trinketmaster.attackCooldownTicks)
  assert.equal(frame.get(2)?.getStatuses().find((status) => status.kind === 'silence')?.endTick, 6 + windup + 90)
  assert.equal(markerCount(simulator, 6 + windup, 'ready:t-hush', 1), 0, 'and used the readiness')
})

// Attack locks and readied autos, played through the trinketmaster's hush: an ability with no windup
// that readies the next auto, so it can be used between autos. The enemy is a brawler that never acts,
// 60 px north of the trinketmaster, so the stick thrown east misses it.

const HUSH_ENEMY_AT: Vector2 = { x: 300, y: 240 }

test('a cast with no windup leaves the attack lock alone, and one with a windup ends it', () => {
  const swing = (ability: string, target: CastTarget): Simulator => {
    const simulator = createStickDuel([[HUSH_ENEMY_AT.x, HUSH_ENEMY_AT.y]])
    simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
    simulator.addOrder(1, cast(2, 20, ability, target, TRINKET_AT))
    return simulator
  }
  const damageAt = (simulator: Simulator, tick: number): number =>
    brawler.maxHp - (simulator.at(tick).get(2)?.getHealth() ?? 0)

  // The hush comes between two autos and the swinging goes on: the auto on tick 1, the one the hush
  // frees on tick 21 and the one after it on tick 81. The hush's is the first ability hit for the passive,
  // so none of the three has its bonus.
  const hushed = swing('t-hush', { mode: 'none' })
  assert.equal(hushed.at(30).get(1)?.getAttackTarget(), 2)
  assert.equal(damageAt(hushed, 90), 3 * trinketmaster.attackDamage)

  // The stick takes a windup, so the trinketmaster stops to throw it and goes back to nothing.
  const thrown = swing('t-stick', STICK_EAST)
  assert.equal(thrown.at(19).get(1)?.getAttackTarget(), 2)
  assert.equal(thrown.at(20).get(1)?.getAttackTarget(), undefined)
  assert.equal(damageAt(thrown, 90), trinketmaster.attackDamage)
})

test('a cast with no windup does not interrupt a walk, a dash resumes it, and a cast with a windup stops it', () => {
  const walkTo: Vector2 = { x: 400, y: 100 }
  const archer = getChampion('t-archer')
  const walking = (): Simulator => {
    const simulator = new Simulator()
    simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, archer)
    simulator.addPlayer(2, 'player-2', 'Player 2', { x: 100, y: 700 }, brawler)
    simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'move', target: walkTo })
    return simulator
  }
  // Left alone it gets there 120 ticks after the order, at 2.5 px a tick.
  const arrival = 1 + Math.ceil((walkTo.x - ORIGIN.x) / (archer.moveSpeed / GAME_TPS))
  const castAt = (simulator: Simulator, seq: number, abilityId: string, target: CastTarget): void => {
    const origin = simulator.at(20).get(1)?.getPosition()
    assert.ok(origin)
    simulator.addOrder(1, cast(seq, 20, abilityId, target, origin))
  }

  // Focus has no windup: the archer goes on walking, and gets there on time.
  const focused = walking()
  castAt(focused, 2, 't-focus', { mode: 'none' })
  assert.equal(focused.at(20).get(1)?.getAbilityCooldown('t-focus').ready, false, 'it was cast')
  assert.ok((focused.at(21).get(1)?.getPosition().x ?? 0) > (focused.at(20).get(1)?.getPosition().x ?? 0), 'and it did not stop')
  assert.deepEqual(focused.at(arrival).get(1)?.getPosition(), walkTo)

  // Leap has none either. It dashes, and when the dash is over the walk is still there to go on with.
  const leapt = walking()
  castAt(leapt, 2, 't-leap', { mode: 'point', point: { x: 148, y: 200 } })
  assert.equal(leapt.at(22).get(1)?.isDashing(), true)
  assert.equal(leapt.at(60).get(1)?.isDashing(), false)
  assert.deepEqual(leapt.at(200).get(1)?.getPosition(), walkTo, 'and it walks on to where it was going')

  // Snare has a windup, so the archer stops to throw it and does not set off again.
  const snared = walking()
  castAt(snared, 2, 't-snare', { mode: 'point', point: { x: 300, y: 100 } })
  const stopped = snared.at(30).get(1)?.getPosition()
  assert.ok(stopped && stopped.x < walkTo.x)
  assert.deepEqual(snared.at(arrival + 20).get(1)?.getPosition(), stopped, 'it stays where it threw from')
})

test('a readied auto is kept for its time and then lost, and the hush is spent either way', () => {
  const hush = getAbilityDef('t-hush')
  assert.ok(hush?.empowerAttack)
  const lasts = hush.empowerAttack.ticks
  const attackAfterHush = (attackTick: number): Simulator => {
    const simulator = createStickDuel([[HUSH_ENEMY_AT.x, HUSH_ENEMY_AT.y]])
    simulator.addOrder(1, cast(1, 1, 't-hush', { mode: 'none' }, TRINKET_AT))
    simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: attackTick, type: 'attack', targetId: 2 })
    stopAttacking(simulator, 1, attackTick + trinketmaster.attackWindupTicks, TRINKET_AT)
    return simulator
  }
  const silenced = (simulator: Simulator, tick: number): boolean =>
    simulator.at(tick).get(2)?.getStatuses().some((status) => status.kind === 'silence') ?? false

  const inTime = attackAfterHush(lasts - 10)
  assert.equal(markerCount(inTime, lasts - 11, 'ready:t-hush', 1), 1, 'still readied')
  assert.equal(silenced(inTime, lasts - 10 + trinketmaster.attackWindupTicks), true)
  assert.equal(markerCount(inTime, lasts - 10 + trinketmaster.attackWindupTicks, 'ready:t-hush', 1), 0)

  const late = attackAfterHush(lasts + 10)
  assert.equal(markerCount(late, lasts + 9, 'ready:t-hush', 1), 0, 'it has gone')
  const landed = lasts + 10 + trinketmaster.attackWindupTicks
  assert.equal(late.at(landed).get(2)?.getHealth(), brawler.maxHp - trinketmaster.attackDamage, 'the auto still lands')
  assert.equal(silenced(late, landed), false, 'but plainly')
  assert.equal(late.at(landed).get(1)?.getAbilityCooldown('t-hush').ready, false, 'and the hush was spent')
})

defineAbility({
  id: 't-blind-test',
  targeting: 'unit',
  range: 300,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: 600,
  apply: [blind(120, targetUnit())],
})

test('an auto thrown while blind lands nothing, so it does not use up the readied one', () => {
  const simulator = createStickDuel([[380, 300, new Champion({ ...brawler, abilities: ['t-blind-test'] })]])
  // Blind from tick 1 to 121. The hush is readied on tick 2 and the auto ordered on tick 3 swings
  // on ticks 3 and 63 at nothing, and on tick 123, with the blindness over, lands.
  simulator.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-blind-test',
    target: { mode: 'unit', unitId: 1 }, origin: { x: 380, y: 300 },
  })
  simulator.addOrder(1, cast(1, 2, 't-hush', { mode: 'none' }, TRINKET_AT))
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 3, type: 'attack', targetId: 2 })
  const windup = trinketmaster.attackWindupTicks
  stopAttacking(simulator, 1, 123 + windup, TRINKET_AT)

  assert.equal(simulator.at(2).get(1)?.getStatuses().some((status) => status.kind === 'blind'), true)
  const missed = simulator.at(63 + windup)
  assert.equal(missed.get(2)?.getHealth(), brawler.maxHp, 'neither swing hit')
  assert.equal(missed.get(2)?.getStatuses().length, 0)
  assert.equal(markerCount(simulator, 63 + windup, 'ready:t-hush', 1), 1, 'and the hush is still readied')
  assert.equal(missed.get(1)?.getNextAttackTick(), 123, 'the swings still took their cooldowns')

  const landed = simulator.at(123 + windup)
  assert.equal(landed.get(2)?.getHealth(), brawler.maxHp - trinketmaster.attackDamage)
  assert.equal(landed.get(2)?.getStatuses().find((status) => status.kind === 'silence')?.endTick, 123 + windup + 90)
  assert.equal(markerCount(simulator, 123 + windup, 'ready:t-hush', 1), 0)
})

test('a root holds a chasing attacker where it stands, and it carries on after its target once freed', () => {
  const rooter = new Champion({ ...brawler, abilities: ['t-root-test'] })
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 300 }, brawler)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 350, y: 300 }, rooter)
  simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  // The root lasts 300 ticks, from tick 5, while the attacker is still well out of reach.
  simulator.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 5, type: 'cast', abilityId: 't-root-test',
    target: { mode: 'unit', unitId: 1 }, origin: { x: 350, y: 300 },
  })
  const stopAttacker = 400
  stopAttacking(simulator, 1, stopAttacker, { x: 300, y: 300 })

  const root = simulator.at(6).get(1)?.getStatuses().find((status) => status.kind === 'root')
  assert.ok(root)
  const heldAt = simulator.at(10).get(1)?.getPosition()
  assert.ok(heldAt && heldAt.x > 100 && heldAt.x < 350 - brawler.attackRange, 'it had set off, and was stopped short')
  for (let tick = 11; tick < root.endTick; tick += 1) {
    assert.deepEqual(simulator.at(tick).get(1)?.getPosition(), heldAt, `held on tick ${tick}`)
    assert.equal(simulator.at(tick).get(1)?.getAttackTarget(), 2, `still after it on tick ${tick}`)
  }
  assert.equal(simulator.at(root.endTick - 1).get(2)?.getHealth(), brawler.maxHp, 'and nothing was hit')

  // Freed, it walks the rest of the way and swings.
  let hit = -1
  for (let tick = root.endTick; tick < stopAttacker && hit < 0; tick += 1) {
    if ((simulator.at(tick).get(2)?.getHealth() ?? 0) < brawler.maxHp) hit = tick
  }
  assert.ok(hit > root.endTick, 'it walked up first')
  assert.ok(hit < root.endTick + 60, `and was swinging by tick ${hit}`)
})

test('a blink onto someone is no obstacle, and the two are pushed apart afterwards instead of stacking', () => {
  // The enemy is standing on the stick, so the trinketmaster blinks right onto it.
  const simulator = createStickDuel([[STICK_AT.x, STICK_AT.y]])
  throwStick(simulator)
  simulator.addOrder(1, cast(2, 40, 't-warp', { mode: 'none' }, TRINKET_AT))
  const landed = 43

  assert.deepEqual(simulator.at(landed).get(1)?.getPosition(), STICK_AT)
  assert.deepEqual(simulator.at(landed).get(2)?.getPosition(), STICK_AT, 'for one frame, exactly on top')
  const gap = (tick: number): number => {
    const first = simulator.at(tick).get(1)?.getPosition()
    const second = simulator.at(tick).get(2)?.getPosition()
    return Math.hypot((first?.x ?? 0) - (second?.x ?? 0), (first?.y ?? 0) - (second?.y ?? 0))
  }
  assert.ok(gap(landed + 1) > 0)
  assert.ok(Math.abs(gap(landed + 40) - (trinketmaster.radius + brawler.radius)) < 1e-6, 'and they settle just touching')
})

test('a stick on the ground, a stick coming home and a silence survive a checkpoint restore', () => {
  const build = (): Simulator => {
    const simulator = createStickDuel([[450, 300]])
    throwStick(simulator)
    simulator.addOrder(1, {
      id: 'player-1:2', seq: 2, tick: 40, type: 'cast', abilityId: 't-recall', target: { mode: 'none' }, origin: TRINKET_AT,
    })
    // Hush readied on tick 80, and the auto that carries it walks up to the enemy 150 px away.
    simulator.addOrder(1, cast(3, 80, 't-hush', { mode: 'none' }, TRINKET_AT))
    simulator.addOrder(1, { id: 'player-1:4', seq: 4, tick: 81, type: 'attack', targetId: 2 })
    return simulator
  }
  const record = (simulator: Simulator, from: number, to: number): Map<number, string> => {
    const frames = new Map<number, string>()
    for (let tick = from; tick <= to; tick += 1) {
      const frame = simulator.at(tick)
      frames.set(tick, JSON.stringify([
        frame.getEntities(),
        frame.get(1)?.getAbilityCooldown('t-stick'),
        frame.get(2)?.getHealthState(),
        frame.get(2)?.getStatuses(),
        frame.get(1)?.getPosition(),
        frame.get(1)?.getAttackTarget(),
        frame.get(1)?.getMarkers(),
      ]))
    }
    return frames
  }
  const expected = record(build(), 1, 140)
  assert.equal(
    build().at(140).get(2)?.getStatuses().some((status) => status.kind === 'silence'),
    true,
    'the hush landed',
  )

  // One checkpoint with the stick lying on the ground, one with it on its way home.
  const original = build()
  original.advanceTo(39)
  original.setCommitTick(38)
  const onGround = original.snapshot()
  original.advanceTo(57)
  original.setCommitTick(55)
  const coming = original.snapshot()
  // And one on the way to the enemy, with the attack lock and the readied hush in it.
  original.advanceTo(100)
  original.setCommitTick(95)
  const chasing = original.snapshot()
  const chaser = chasing.checkpoint.characters.find((character) => character.characterId === 1)
  assert.equal(chaser?.attackTarget?.targetId, 2)
  assert.equal(onGround.checkpoint.entities.map((entity) => entity.defId).join(), 't-stick')
  assert.equal(coming.checkpoint.entities[0]?.defId, 't-stick-recall')
  assert.equal(coming.checkpoint.entities[0]?.targetId, 1, 'it remembers who it is bound for')

  for (const [snapshot, committed] of [[onGround, 38], [coming, 55], [chasing, 95]] as const) {
    assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)
    const restored = new Simulator()
    restored.replaceFromSnapshot(snapshot)
    for (const [tick, frame] of record(restored, committed + 1, 140)) assert.equal(frame, expected.get(tick), `tick ${tick}`)
  }
})

// Ninja kit, against the copy in fixtures.ts. The ninja starts at (300, 300) and its target is a
// brawler on the same row. Q dashes 300 px at 20 px a tick, so a dash east from the start ends on
// (600, 300) 15 ticks after it begins, one tick after the cast. Bodies touch when they are 34 apart
// (16 and 18), so a dash passes through an enemy whose centre is within 34 of its path.

const NINJA_AT: Vector2 = { x: 300, y: 300 }
const STEP_RANGE = 300
// The dash moves 20 px a tick from the tick after the cast, so a dash of 300 px cast on tick 1 is over
// on tick 16.
const STEP_TICKS = 15
// What a dash does to an enemy it passes happens when the ninja's body reaches it, not when the dash
// is ordered. An enemy at (400, 300) is touched on tick 5, when the step from x = 360 to 380 gets
// within 34 of it.
const CONTACT = 5
// The dash back is ready a second after the dash that left the shadow reached its enemy.
const RETURN_READY = CONTACT + 60

function createNinjaDuel(enemies: Array<[number, number, Champion?]> = [[400, 300]]): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', NINJA_AT, ninja)
  enemies.forEach(([x, y, champion], index) => {
    simulator.addPlayer(index + 2, `player-${index + 2}`, `Player ${index + 2}`, { x, y }, champion ?? brawler)
  })
  return simulator
}

// Q aimed along the row it stands on, `length` px ahead (east, or west for a negative one).
function stepAlong(seq: number, tick: number, origin: Vector2, length = STEP_RANGE): CastOrder {
  return cast(seq, tick, 't-shadowstep', { mode: 'point', point: { x: origin.x + length, y: origin.y } }, origin)
}

const shadowsOut = (simulator: Simulator, tick: number) =>
  simulator.at(tick).getEntities().filter((entity) => entity.defId === 't-shadow')
const slowedAt = (simulator: Simulator, tick: number, id = 2): boolean =>
  simulator.at(tick).get(id)?.getStatuses().some((status) => status.kind === 'slow') ?? false
const healthAt = (simulator: Simulator, tick: number, id = 2): number | undefined =>
  simulator.at(tick).get(id)?.getHealth()
// The first tick in the range on which the condition holds, reading the frames in order.
function firstTick(from: number, to: number, holds: (tick: number) => boolean): number | undefined {
  for (let tick = from; tick <= to; tick += 1) {
    if (holds(tick)) return tick
  }
  return undefined
}

test('a dash hurts and slows an enemy as the ninja passes it, and the first it passes gives a shadow stack, most of the cooldown back and a shadow where it was cast', () => {
  const simulator = createNinjaDuel()
  simulator.addOrder(1, stepAlong(1, 1, NINJA_AT))

  // Nothing happens when it is ordered, or on the way there.
  for (const tick of [1, 3, CONTACT - 1]) {
    const frame = simulator.at(tick)
    assert.equal(frame.get(2)?.getHealth(), brawler.maxHp, `tick ${tick}: not hurt yet`)
    assert.equal(frame.get(2)?.getStatuses().length, 0)
    assert.equal(markerCount(simulator, tick, 'shadow', 1), 0)
    assert.equal(frame.getEntities().length, 0)
    assert.equal(frame.get(1)?.getAbilityCooldown('t-shadowstep').ticksRemaining, 481 - tick, 'the whole cooldown so far')
  }

  const frame = simulator.at(CONTACT)
  assert.equal(frame.get(2)?.getHealth(), brawler.maxHp - 60, 'hurt')
  const slow = frame.get(2)?.getStatuses().find((status) => status.kind === 'slow')
  assert.equal(slow?.amount, 0.4)
  assert.equal(slow?.endTick, CONTACT + 90, 'for 1.5 s from when it was reached')
  assert.equal(markerCount(simulator, CONTACT, 'shadow', 1), 1, 'a shadow stack on the ninja')
  assert.equal(markerCount(simulator, CONTACT, 'shadow', 2), 0, 'and none on the enemy')
  assert.equal(frame.get(1)?.getAbilityCooldown('t-shadowstep').ticksRemaining, 1 + 480 - 360 - CONTACT, 'three quarters of the 8 s came back')
  assert.equal(frame.get(1)?.getAbilityCooldown('t-shadowreturn').ticksRemaining, 60, 'and the dash back has a second to wait')

  const shadows = shadowsOut(simulator, CONTACT)
  assert.equal(shadows.length, 1, 'a shadow')
  assert.deepEqual(entityPosAt(shadows[0], CONTACT), NINJA_AT, 'where it was cast from, not where the ninja is now')
  assert.ok((frame.get(1)?.getPosition().x ?? 0) > 360, 'which it left behind')

  assert.equal(simulator.at(2 + STEP_TICKS - 2).get(1)?.isDashing(), true)
  assert.equal(simulator.at(2 + STEP_TICKS - 1).get(1)?.isDashing(), false, 'and the dash ends on tick 16')
  assert.ok((simulator.at(2 + STEP_TICKS).get(1)?.getPosition().x ?? 0) > 500, 'well past the enemy')
  assert.deepEqual(simulator.at(2 + STEP_TICKS).get(2)?.getPosition(), { x: 400, y: 300 }, 'and the enemy was not shoved along')
})

test('an enemy is judged where it is when the ninja reaches it: one that walks into the path is hit, and one that walks out of it is not', () => {
  // Both are 40 px off the row at the start, or on it, which is outside the 34 that touches.
  const walksIn = createNinjaDuel([[450, 340]])
  walksIn.addOrder(1, stepAlong(1, 1, NINJA_AT))
  walksIn.addOrder(2, { id: 'player-2:1', seq: 1, tick: 1, type: 'move', target: { x: 450, y: 300 } })
  const walksOut = createNinjaDuel([[450, 310]])
  walksOut.addOrder(1, stepAlong(1, 1, NINJA_AT))
  walksOut.addOrder(2, { id: 'player-2:1', seq: 1, tick: 1, type: 'move', target: { x: 450, y: 600 } })

  assert.equal(healthAt(walksIn, 1), brawler.maxHp, 'it is out of the way when the dash is ordered')
  assert.equal(healthAt(walksIn, 2 + STEP_TICKS + 1), brawler.maxHp - 60, 'and has stepped into it by the time the ninja gets there')
  assert.equal(healthAt(walksOut, 1), brawler.maxHp, 'the other is in the way when the dash is ordered, but nothing happens yet')
  assert.equal(healthAt(walksOut, 2 + STEP_TICKS + 1), brawler.maxHp, 'and has gone by the time the ninja gets there')
  assert.equal(shadowsOut(walksOut, 2 + STEP_TICKS + 1).length, 0, 'so there was nothing to leave a shadow for')
})

test('a dash through passes through a character where an ordinary dash shoves it along', () => {
  // Both dash 120 px east from the start at a character 50 px ahead of it.
  const dashAt = (champion: Champion, abilityId: string, aim: Vector2): Simulator => {
    const simulator = new Simulator()
    simulator.addPlayer(1, 'player-1', 'Player 1', NINJA_AT, champion)
    simulator.addPlayer(2, 'player-2', 'Player 2', { x: 350, y: 300 }, brawler)
    simulator.addOrder(1, cast(1, 1, abilityId, { mode: 'point', point: aim }, NINJA_AT))
    return simulator
  }

  const through = dashAt(ninja, 't-shadowstep', { x: 420, y: 300 })
  assert.ok((through.at(10).get(1)?.getPosition().x ?? 0) > (through.at(10).get(2)?.getPosition().x ?? 0), 'the ninja came out the far side')

  // The leap is an ordinary dash, so the brawler is carried along ahead of the archer and never passed.
  const shoved = dashAt(getChampion('t-archer'), 't-leap', { x: 420, y: 300 })
  assert.ok((shoved.at(10).get(1)?.getPosition().x ?? 0) < (shoved.at(10).get(2)?.getPosition().x ?? 0), 'the archer is still behind')
  assert.ok((shoved.at(10).get(2)?.getPosition().x ?? 0) > 350, 'having pushed it along')
})

test('a dash that passes through nobody changes nothing but where the ninja is', () => {
  const simulator = createNinjaDuel([[400, 400]])
  simulator.addOrder(1, stepAlong(1, 1, NINJA_AT))

  const over = 2 + STEP_TICKS + 2
  const frame = simulator.at(over)
  assert.equal(frame.get(2)?.getHealth(), brawler.maxHp, 'not hurt')
  assert.equal(frame.get(2)?.getStatuses().length, 0)
  assert.equal(markerCount(simulator, over, 'shadow', 1), 0, 'no stack')
  assert.equal(frame.getEntities().length, 0, 'no shadow')
  assert.equal(frame.get(1)?.getAbilityCooldown('t-shadowstep').ticksRemaining, 481 - over, 'and the whole cooldown, running from the cast')
  assert.equal(frame.get(1)?.isDashing(), false, 'though it did dash')
  assert.deepEqual(frame.get(1)?.getPosition(), { x: 600, y: 300 })
})

test('a dash through several enemies hurts and slows each as it reaches it, once, and gives one stack, not one each', () => {
  const simulator = createNinjaDuel([[400, 300], [500, 300 + 20], [450, 300 + 100]])
  simulator.addOrder(1, stepAlong(1, 1, NINJA_AT))

  const hitAt = new Map<number, number>()
  for (let tick = 1; tick <= 2 + STEP_TICKS + 2; tick += 1) {
    for (const id of [2, 3, 4]) {
      if (!hitAt.has(id) && (healthAt(simulator, tick, id) ?? 0) < brawler.maxHp) hitAt.set(id, tick)
    }
  }
  const end = 2 + STEP_TICKS + 2
  assert.equal(hitAt.get(2), CONTACT)
  assert.ok((hitAt.get(3) ?? 0) > CONTACT, 'the second enemy is hurt later, when the ninja gets to it')
  assert.equal(hitAt.has(4), false, 'the one off to the side is not touched')
  assert.equal(healthAt(simulator, end, 2), brawler.maxHp - 60, 'each once')
  assert.equal(healthAt(simulator, end, 3), brawler.maxHp - 60)
  assert.equal(slowedAt(simulator, end, 4), false)
  assert.equal(markerCount(simulator, end, 'shadow', 1), 1)
  // What the first one sets off is set off once: the cooldown is refunded once, not once per enemy.
  assert.equal(simulator.at(end).get(1)?.getAbilityCooldown('t-shadowstep').ticksRemaining, 1 + 480 - 360 - end)
})

test('a dash passes through an enemy exactly when their bodies touch along its path', () => {
  // Each case is a dash aimed `length` px east of the start and an enemy somewhere; 34 is the limit.
  const passes = (enemy: [number, number], length = STEP_RANGE): boolean => {
    const simulator = createNinjaDuel([enemy])
    simulator.addOrder(1, stepAlong(1, 1, NINJA_AT, length))
    return (healthAt(simulator, 2 + Math.ceil(length / 20) + 1) ?? 0) < brawler.maxHp
  }

  assert.equal(passes([450, 300 + 33]), true, 'clipping its edge')
  assert.equal(passes([450, 300 - 33]), true, 'on either side')
  assert.equal(passes([450, 300 + 36]), false, 'just wide of it')
  assert.equal(passes([430, 300], 100), true, 'near the end of a short dash')
  assert.equal(passes([520, 300], 100), false, 'beyond the end of a short dash')
  assert.equal(passes([600, 300 + 20]), true, 'right at the end of a full one')
  assert.equal(passes([250, 300]), false, 'behind it')
})

test('a dash is not past a teammate, only an enemy', () => {
  const simulator = createTeamGame([
    { champion: ninja, x: 300, y: 300, team: 1 },
    { x: 400, y: 300, team: 1 },
  ])
  simulator.addOrder(1, stepAlong(1, 1, NINJA_AT))

  const over = 2 + STEP_TICKS + 2
  assert.equal(slowedAt(simulator, over), false)
  assert.equal(healthAt(simulator, over), brawler.maxHp, 'not hurt')
  assert.equal(markerCount(simulator, over, 'shadow', 1), 0)
  assert.equal(simulator.at(over).getEntities().length, 0)
})

test('the key dashes forward while no shadow is out and back to it while one is, and the other is refused', () => {
  const step = getAbilityDef('t-shadowstep')
  assert.ok(step)
  assert.equal(abilityOnKey(step, () => false).id, 't-shadowstep')
  assert.equal(abilityOnKey(step, () => true).id, 't-shadowreturn')
  assert.equal(ninja.hasAbility('t-shadowreturn'), true, 'the ninja can cast the return though it is on no key')

  // With no shadow out the return is dropped, and with one out the step is.
  const bare = createNinjaDuel()
  bare.addOrder(1, cast(1, 1, 't-shadowreturn', { mode: 'none' }, NINJA_AT))
  assert.equal(bare.at(3).get(1)?.isDashing(), false)
  assert.equal(bare.at(3).get(1)?.getAbilityCooldown('t-shadowreturn').ready, true)

  const held = createNinjaDuel()
  held.addOrder(1, stepAlong(1, 1, NINJA_AT))
  held.addOrder(1, stepAlong(2, 2 + STEP_TICKS + 5, held.at(2 + STEP_TICKS + 5).get(1)?.getPosition() ?? NINJA_AT, -100))
  assert.equal(held.at(2 + STEP_TICKS + 8).get(1)?.isDashing(), false, 'refused while a shadow is out')
})

test('the dash back is not ready the moment the dash forward is over, only a second after it reached its enemy', () => {
  const simulator = createNinjaDuel()
  simulator.addOrder(1, stepAlong(1, 1, NINJA_AT))
  const waitAtContact = simulator.at(CONTACT).get(1)?.getAbilityCooldown('t-shadowreturn').ticksRemaining
  const early = 2 + STEP_TICKS + 3
  const from = simulator.at(early).get(1)?.getPosition()
  assert.ok(from)
  simulator.addOrder(1, cast(2, early, 't-shadowreturn', { mode: 'none' }, from))
  simulator.addOrder(1, cast(3, RETURN_READY, 't-shadowreturn', { mode: 'none' }, from))

  assert.equal(waitAtContact, 60, 'it starts when the dash forward reaches its enemy')
  assert.equal(simulator.at(early - 1).get(1)?.isDashing(), false, 'the dash forward is over')
  assert.equal(simulator.at(early + 2).get(1)?.isDashing(), false, 'but the dash back is refused')
  assert.deepEqual(simulator.at(early + 2).get(1)?.getPosition(), from, 'the ninja has not moved')
  assert.equal(shadowsOut(simulator, early + 2).length, 1, 'and the shadow is still where it was')
  assert.equal(simulator.at(RETURN_READY - 1).get(1)?.getAbilityCooldown('t-shadowreturn').ready, false)
  assert.equal(simulator.at(RETURN_READY).get(1)?.getAbilityCooldown('t-shadowreturn').ticksRemaining, 60, 'it is ready the tick it is wanted, and is cast')
  assert.equal(simulator.at(RETURN_READY + 3).get(1)?.isDashing(), true)
})

test('with a shadow out, a dash back through the enemy hurts it again as the ninja reaches it and leaves a new shadow where it was cast', () => {
  const simulator = createNinjaDuel()
  simulator.addOrder(1, stepAlong(1, 1, NINJA_AT))
  const castTick = RETURN_READY + 5
  const from = simulator.at(castTick).get(1)?.getPosition()
  assert.ok(from)
  simulator.addOrder(1, cast(2, castTick, 't-shadowreturn', { mode: 'none' }, from))

  assert.equal(simulator.at(castTick - 1).get(1)?.getAbilityCooldown('t-shadowreturn').ready, true)
  // Ordering it does nothing to the enemy yet.
  assert.equal(healthAt(simulator, castTick), brawler.maxHp - 60, 'only the first dash has hurt it')
  assert.equal(markerCount(simulator, castTick, 'shadow', 1), 1, 'and there is the one stack')
  assert.deepEqual(entityPosAt(shadowsOut(simulator, castTick)[0], castTick), NINJA_AT, 'and the old shadow')

  const touched = firstTick(castTick + 1, castTick + 40, (tick) => (healthAt(simulator, tick) ?? 0) < brawler.maxHp - 60)
  assert.ok(touched !== undefined && touched > castTick + 5, `it reaches the enemy a few ticks into the dash, on tick ${touched}`)
  const frame = simulator.at(touched)
  assert.equal(frame.get(2)?.getHealth(), brawler.maxHp - 2 * 60, 'hurt again')
  const slows = frame.get(2)?.getStatuses().filter((status) => status.kind === 'slow') ?? []
  assert.deepEqual(slows.map((status) => status.endTick).sort((a, b) => a - b), [CONTACT + 90, touched + 90], 'slowed afresh')
  assert.equal(markerCount(simulator, touched, 'shadow', 1), 2, 'a second stack')
  assert.equal(frame.get(1)?.getAbilityCooldown('t-shadowreturn').ticksRemaining, 60, 'a second before it again')

  const shadows = shadowsOut(simulator, touched)
  assert.equal(shadows.length, 1, 'one shadow at a time')
  assert.deepEqual(entityPosAt(shadows[0], touched), from, 'where it was cast from')
  assert.ok((frame.get(1)?.getPosition().x ?? 0) < from.x, 'the ninja is heading back the way it came')

  assert.equal(simulator.at(castTick + STEP_TICKS + 1).get(1)?.isDashing(), false)
  assert.deepEqual(simulator.at(castTick + STEP_TICKS + 1).get(1)?.getPosition(), NINJA_AT, 'and it ends on the old shadow')
  // The new shadow has 8 s of its own from when it was left, and not what was left of the old one.
  assert.equal(shadowsOut(simulator, CONTACT + 480 + 20).length, 1, 'the old one would have gone by now')
  assert.equal(shadowsOut(simulator, touched + 480).length, 1)
  assert.equal(shadowsOut(simulator, touched + 481).length, 0, 'it goes 8 s after it was left')
})

test('the dash back goes to the shadow from any distance, and reaches the enemy on the way when it gets there', () => {
  const simulator = createNinjaDuel()
  simulator.addOrder(1, stepAlong(1, 1, NINJA_AT))
  // The ninja then walks a thousand pixels from the shadow, far beyond the reach of any dash.
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 30, type: 'move', target: { x: 1300, y: 300 } })
  const castTick = 30 + Math.ceil(700 / (ninja.moveSpeed / GAME_TPS)) + 5
  const from = simulator.at(castTick).get(1)?.getPosition()
  assert.deepEqual(from, { x: 1300, y: 300 })
  simulator.addOrder(1, cast(3, castTick, 't-shadowreturn', { mode: 'none' }, from))

  assert.equal(simulator.at(castTick + 20).get(1)?.isDashing(), true, 'under way')
  assert.equal(healthAt(simulator, castTick + 20), brawler.maxHp - 60, 'and the enemy 900 px away has not been touched')
  const touched = firstTick(castTick + 21, castTick + 70, (tick) => (healthAt(simulator, tick) ?? 0) < brawler.maxHp - 60)
  assert.ok(touched !== undefined && touched >= castTick + 40, `it is touched about forty ticks in, on tick ${touched}`)
  assert.equal(shadowsOut(simulator, touched).length, 1)
  assert.deepEqual(entityPosAt(shadowsOut(simulator, touched)[0], touched), from, 'a new shadow where it was cast from')

  const over = castTick + 52
  assert.equal(simulator.at(over).get(1)?.isDashing(), false)
  assert.deepEqual(simulator.at(over).get(1)?.getPosition(), NINJA_AT, 'it arrives on the old shadow, a thousand pixels on')
})

test('a dash back to the shadow that passes through nobody loses it when it finishes, and the key is the forward dash again', () => {
  const simulator = createNinjaDuel()
  simulator.addOrder(1, stepAlong(1, 1, NINJA_AT))
  // The enemy walks off the row, and the ninja comes back after the first dash's cooldown, which had
  // most of it refunded, is up (on tick 121).
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 5, type: 'move', target: { x: 400, y: 800 } })
  const castTick = 130
  const from = simulator.at(castTick).get(1)?.getPosition()
  assert.ok(from)
  assert.ok((simulator.at(castTick).get(2)?.getPosition().y ?? 0) > 400, 'it is well off the row')
  simulator.addOrder(1, cast(2, castTick, 't-shadowreturn', { mode: 'none' }, from))

  assert.equal(simulator.at(castTick - 1).get(1)?.getAbilityCooldown('t-shadowstep').ready, true, 'it had run out while the shadow was out')
  const done = castTick + STEP_TICKS
  assert.equal(shadowsOut(simulator, done - 1).length, 1, 'the shadow is still there while the dash goes on')
  assert.equal(shadowsOut(simulator, done).length, 0, 'and goes when it finishes having passed through no one')
  assert.equal(simulator.at(done).get(1)?.getAbilityCooldown('t-shadowstep').ticksRemaining, 480, 'and the miss puts all 8 s back')
  assert.equal(markerCount(simulator, done, 'shadow', 1), 1, 'no new stack, and the one there stays')
  assert.equal(healthAt(simulator, done), brawler.maxHp - 60, 'no more damage than the first dash did')
  assert.equal(slowedAt(simulator, done), false, 'and no new slow')

  const step = getAbilityDef('t-shadowstep')
  assert.ok(step)
  assert.equal(abilityOnKey(step, (defId) => shadowsOut(simulator, done).some((entity) => entity.defId === defId)).id, 't-shadowstep')

  // So Q cannot be cast twice in a row: a dash forward is refused straight after the miss.
  const after = done + 20
  const stoppedAt = simulator.at(after).get(1)?.getPosition()
  assert.ok(stoppedAt)
  simulator.addOrder(1, stepAlong(3, after, stoppedAt))
  assert.equal(simulator.at(after + 2).get(1)?.isDashing(), false, 'the second dash is refused')
  assert.equal(shadowsOut(simulator, after + 2).length, 0)
})

test('a shadow lasts 8 seconds, and then the key is Shadow Step again, which has been ready all along', () => {
  const simulator = createNinjaDuel()
  simulator.addOrder(1, stepAlong(1, 1, NINJA_AT))
  const step = getAbilityDef('t-shadowstep')
  assert.ok(step)
  const keyAt = (tick: number): string =>
    abilityOnKey(step, (defId) => shadowsOut(simulator, tick).some((entity) => entity.defId === defId)).id

  // It is left when the dash reaches its enemy, and is there on that tick and for the 8 s (480 ticks) after.
  assert.equal(shadowsOut(simulator, CONTACT).length, 1)
  assert.equal(keyAt(CONTACT), 't-shadowreturn', 'the key is the dash back while it is out')
  const ready = 1 + 480 - 360
  assert.equal(simulator.at(ready).get(1)?.getAbilityCooldown('t-shadowstep').ready, true, 'Shadow Step was ready after two seconds, with three quarters handed back')
  assert.equal(keyAt(ready), 't-shadowreturn', 'but the key stays the dash back while the shadow is out')

  const last = CONTACT + 480
  assert.equal(shadowsOut(simulator, last).length, 1, 'there for the whole 8 s')
  assert.equal(keyAt(last), 't-shadowreturn')
  assert.equal(shadowsOut(simulator, last + 1).length, 0, 'and gone the tick after')
  assert.equal(simulator.at(last + 1).get(1)?.getAbilityCooldown('t-shadowstep').ready, true)
  assert.equal(keyAt(last + 1), 't-shadowstep', 'when the key is Shadow Step again')

  // The forward dash can be cast again, and the dash back, with no shadow, is refused.
  const at = last + 5
  const from = simulator.at(at).get(1)?.getPosition()
  assert.ok(from)
  simulator.addOrder(1, stepAlong(2, at, from, -100))
  simulator.addOrder(1, cast(3, at + 40, 't-shadowreturn', { mode: 'none' }, from))
  assert.equal(simulator.at(at + 2).get(1)?.isDashing(), true, 'Shadow Step can be cast')
  assert.equal(simulator.at(at + 43).get(1)?.isDashing(), false, 'and there is nothing to dash back to')
})

test('a shadow does not outlive the ninja', () => {
  const simulator = createNinjaDuel()
  simulator.addOrder(1, stepAlong(1, 1, NINJA_AT))
  killAt(simulator, 1, 300)

  assert.equal(shadowsOut(simulator, CONTACT).length, 1)
  assert.equal(shadowsOut(simulator, 299).length, 1, 'there while the ninja is alive')
  assert.equal(shadowsOut(simulator, 301).length, 0, 'and gone when it dies, long before its 8 s are up')
  assert.equal(shadowsOut(simulator, 300 + GAME_RESPAWN_TICKS + 5).length, 0, 'not back with the ninja')
})

test('shadow stacks stop at two however many dashes through an enemy there are, and wear off after six seconds', () => {
  const simulator = createNinjaDuel()
  simulator.addOrder(1, stepAlong(1, 1, NINJA_AT))
  const secondAt = RETURN_READY + 5
  const fromSecond = simulator.at(secondAt).get(1)?.getPosition()
  assert.ok(fromSecond)
  simulator.addOrder(1, cast(2, secondAt, 't-shadowreturn', { mode: 'none' }, fromSecond))
  // The return has a second to wait from reaching the enemy, so the third dash is a second later still.
  const secondTouched = firstTick(secondAt + 1, secondAt + 40, (tick) => markerCount(simulator, tick, 'shadow', 1) === 2)
  assert.ok(secondTouched !== undefined)
  const thirdAt = secondTouched + 70
  const fromThird = simulator.at(thirdAt).get(1)?.getPosition()
  assert.ok(fromThird)
  assert.equal(markerCount(simulator, thirdAt - 1, 'shadow', 1), 2)
  simulator.addOrder(1, cast(3, thirdAt, 't-shadowreturn', { mode: 'none' }, fromThird))

  const thirdTouched = firstTick(thirdAt + 1, thirdAt + 40, (tick) =>
    simulator.at(tick).get(2)?.getStatuses().some((status) => status.kind === 'slow' && status.endTick === tick + 90) ?? false)
  assert.ok(thirdTouched !== undefined, 'the third dash went through the enemy too')
  assert.equal(markerCount(simulator, thirdTouched, 'shadow', 1), 2, 'but there are still only two')
  assert.equal(markerCount(simulator, thirdTouched + 359, 'shadow', 1), 2, 'six seconds after the last')
  assert.equal(markerCount(simulator, thirdTouched + 360, 'shadow', 1), 0, 'and then both are gone together')
})

// Two shadow stacks at once for the tests that spend them, from an ability of their own that grants
// three with a cap of two. The ninja is the same in every other way.
defineAbility({
  id: 't-shadow-grant',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  backswingTicks: 0,
  cooldownTicks: 600,
  apply: [mark('shadow', 360, self(), { count: 3, cap: 2 })],
})
const stackedNinja = new Champion({ ...ninja, abilities: [...ninja.abilities, 't-shadow-grant'] })

test('the ninja\'s auto spends one shadow stack for bonus damage, and an auto with none is plain', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', NINJA_AT, stackedNinja)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 360, y: 300 }, brawler)
  simulator.addOrder(1, cast(1, 1, 't-shadow-grant', { mode: 'none' }, NINJA_AT))
  // One order, three autos, ticks 2, 62 and 122, landing four ticks after they start.
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 2, type: 'attack', targetId: 2 })
  const third = 2 + 2 * ninja.attackCooldownTicks + ninja.attackWindupTicks
  stopAttacking(simulator, 1, third, NINJA_AT)
  const first = 2 + ninja.attackWindupTicks
  const second = first + ninja.attackCooldownTicks

  assert.equal(markerCount(simulator, 1, 'shadow', 1), 2, 'three were granted and two stayed')
  assert.equal(simulator.at(first).get(2)?.getHealth(), brawler.maxHp - (ninja.attackDamage + 60), 'the first spends one')
  assert.equal(markerCount(simulator, first, 'shadow', 1), 1, 'and leaves the other')
  assert.ok(
    simulator.at(first).get(1)?.getMarkers().find((marker) => marker.key === 'shadow')?.id.endsWith(':2'),
    'the older of the two went first',
  )
  assert.equal(simulator.at(second).get(2)?.getHealth(), brawler.maxHp - 2 * (ninja.attackDamage + 60), 'the second spends it')
  assert.equal(markerCount(simulator, second, 'shadow', 1), 0)
  assert.equal(simulator.at(third).get(2)?.getHealth(), brawler.maxHp - 2 * (ninja.attackDamage + 60) - ninja.attackDamage, 'the third is plain')
})

test('an auto with no shadow stack is plain', () => {
  const simulator = createNinjaDuel([[360, 300]])
  simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  stopAttacking(simulator, 1, 1 + ninja.attackWindupTicks, NINJA_AT)

  assert.equal(simulator.at(1 + ninja.attackWindupTicks).get(2)?.getHealth(), brawler.maxHp - ninja.attackDamage)
})

test('the kunai hurts and slows every enemy in its line, and gives no shadow stack', () => {
  const simulator = createNinjaDuel([[400, 300], [500, 300]])
  simulator.addOrder(1, cast(1, 1, 't-kunai', EAST, NINJA_AT))

  for (const [id, health] of [[2, 1000 - 60], [3, 1000 - 60]] as const) {
    const frame = simulator.at(40)
    assert.equal(frame.get(id)?.getHealth(), health, `enemy ${id} is hurt`)
    assert.equal(frame.get(id)?.getStatuses().some((status) => status.kind === 'slow'), true, `and slowed`)
    assert.equal(frame.get(id)?.getStatuses().some((status) => status.kind === 'root'), false)
  }
  assert.equal(markerCount(simulator, 40, 'shadow', 1), 0)
})

test('the kunai spends a shadow stack to hurt more and root instead of slow', () => {
  const simulator = createNinjaDuel([[400, 300]])
  simulator.addOrder(1, stepAlong(1, 1, NINJA_AT))
  const castTick = 2 + STEP_TICKS + 5
  const from = simulator.at(castTick).get(1)?.getPosition()
  assert.ok(from)
  const hurtBefore = simulator.at(castTick).get(2)?.getHealth()
  simulator.addOrder(1, cast(2, castTick, 't-kunai', { mode: 'direction', dir: { x: -1, y: 0 } }, from))
  const launch = castTick + 4

  assert.equal(markerCount(simulator, launch - 1, 'shadow', 1), 1, 'still there during the windup')
  assert.equal(markerCount(simulator, launch, 'shadow', 1), 0, 'spent when it launches')

  let rooted = -1
  for (let tick = launch; tick <= launch + 40 && rooted < 0; tick += 1) {
    if (simulator.at(tick).get(2)?.getStatuses().some((status) => status.kind === 'root')) rooted = tick
  }
  assert.ok(rooted > launch, 'the enemy is rooted when it arrives')
  const frame = simulator.at(rooted)
  assert.equal(frame.get(2)?.getStatuses().find((status) => status.kind === 'root')?.endTick, rooted + 60)
  assert.equal(frame.get(2)?.getHealth(), (hurtBefore ?? 0) - 110)
  assert.equal(
    frame.get(2)?.getStatuses().find((status) => status.kind === 'slow')?.endTick,
    CONTACT + 90,
    'and no new slow, only the one from the dash',
  )
})

test('the kunai spends only one of two shadow stacks, and with none left it slows again', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', NINJA_AT, stackedNinja)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 400, y: 300 }, brawler)
  simulator.addOrder(1, cast(1, 1, 't-shadow-grant', { mode: 'none' }, NINJA_AT))
  // The first kunai leaves on tick 9. Its seven seconds are up on tick 429, and by then the stacks,
  // which last six, have worn off.
  simulator.addOrder(1, cast(2, 5, 't-kunai', EAST, NINJA_AT))
  const second = 9 + 7 * GAME_TPS
  simulator.addOrder(1, cast(3, second, 't-kunai', EAST, NINJA_AT))

  assert.equal(markerCount(simulator, 8, 'shadow', 1), 2)
  assert.equal(markerCount(simulator, 9, 'shadow', 1), 1, 'one is spent')
  let rooted = false
  for (let tick = 9; tick <= 40; tick += 1) {
    rooted = rooted || (simulator.at(tick).get(2)?.getStatuses().some((status) => status.kind === 'root') ?? false)
  }
  assert.equal(rooted, true, 'and it rooted the enemy')

  assert.equal(markerCount(simulator, second - 1, 'shadow', 1), 0, 'the other wore off')
  let slowed = false
  let rootedAgain = false
  for (let tick = second + 4; tick <= second + 40; tick += 1) {
    const statuses = simulator.at(tick).get(2)?.getStatuses() ?? []
    slowed = slowed || statuses.some((status) => status.kind === 'slow')
    rootedAgain = rootedAgain || statuses.some((status) => status.kind === 'root')
  }
  assert.equal(slowed, true, 'the second kunai slows')
  assert.equal(rootedAgain, false, 'and does not root')
})

test('a kunai with no shadow stack neither roots nor makes one', () => {
  const simulator = createNinjaDuel([[400, 300]])
  simulator.addOrder(1, cast(1, 1, 't-kunai', EAST, NINJA_AT))

  assert.equal(markerCount(simulator, 10, 'shadow', 1), 0)
  assert.equal(simulator.at(40).get(2)?.getStatuses().some((status) => status.kind === 'root'), false)
})

test('dodge gives move speed and a short window in which every auto aimed at the ninja misses', () => {
  const simulator = createNinjaDuel([[360, 300]])
  simulator.addOrder(1, cast(1, 1, 't-dodge', { mode: 'none' }, NINJA_AT))
  // The brawler swings on tick 10, which is dodged, and again on tick 70, which is dodged too (the
  // window runs to tick 73); the one on tick 130 is not. Its attack never ends.
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 10, type: 'attack', targetId: 1 })

  const frame = simulator.at(1)
  const haste = frame.get(1)?.getStatuses().find((status) => status.kind === 'haste')
  assert.equal(haste?.amount, 0.4)
  assert.equal(haste?.endTick, 1 + 90)
  assert.equal(frame.get(1)?.getStatuses().find((status) => status.kind === 'dodge')?.endTick, 1 + 72)

  assert.equal(simulator.at(12).get(1)?.getHealth(), ninja.maxHp, 'the first swing missed')
  assert.equal(simulator.at(12).get(2)?.getNextAttackTick(), 70, 'though it was spent')
  assert.equal(simulator.at(72).get(1)?.getHealth(), ninja.maxHp, 'and the second')
  assert.equal(simulator.at(72).get(1)?.getStatuses().some((status) => status.kind === 'dodge'), true)
  assert.equal(simulator.at(74).get(1)?.getStatuses().some((status) => status.kind === 'dodge'), false, 'it wears off')
  assert.equal(simulator.at(131).get(1)?.getHealth(), ninja.maxHp - brawler.attackDamage, 'and the third lands')
})

test('a shot at a dodging ninja is spent without landing', () => {
  const simulator = createNinjaDuel([[560, 300, gunner]])
  simulator.addOrder(1, cast(1, 1, 't-dodge', { mode: 'none' }, NINJA_AT))
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 2, type: 'attack', targetId: 1 })
  stopAttacking(simulator, 2, 2 + gunner.attackWindupTicks, { x: 560, y: 300 })

  // It leaves on tick 5 and covers the 260 px in about twenty ticks, well inside the window.
  assert.equal(simulator.at(5 + 4).getEntities().length, 1, 'the shot is on its way')
  assert.equal(simulator.at(5 + 40).getEntities().length, 0, 'and has arrived')
  assert.equal(simulator.at(5 + 40).get(1)?.getHealth(), ninja.maxHp)
})

test('dodge does not stop abilities', () => {
  // The brawler lashes the ninja while it is dodging: that lands.
  const lashed = createNinjaDuel([[360, 300]])
  lashed.addOrder(1, cast(1, 1, 't-dodge', { mode: 'none' }, NINJA_AT))
  lashed.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 5, type: 'cast', abilityId: 't-lash',
    target: { mode: 'unit', unitId: 1 }, origin: { x: 360, y: 300 },
  })
  assert.equal(lashed.at(5 + 9).get(1)?.getHealth(), ninja.maxHp - 300)
})

test('a dodged auto spends the attacker\'s readied hush, so it never lands the silence', () => {
  // A trinketmaster readies its hush and autos a dodging ninja. The swing is dodged, and the hush is
  // spent with it; the next swings, one inside the window and one after it, are plain.
  const simulator = createNinjaDuel([[360, 300, trinketmaster]])
  simulator.addOrder(1, cast(1, 1, 't-dodge', { mode: 'none' }, NINJA_AT))
  simulator.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 2, type: 'cast', abilityId: 't-hush', target: { mode: 'none' }, origin: { x: 360, y: 300 },
  })
  simulator.addOrder(2, { id: 'player-2:2', seq: 2, tick: 3, type: 'attack', targetId: 1 })
  const first = 3 + trinketmaster.attackWindupTicks
  const last = 3 + 2 * trinketmaster.attackCooldownTicks + trinketmaster.attackWindupTicks
  stopAttacking(simulator, 2, last, { x: 360, y: 300 })

  assert.equal(markerCount(simulator, first - 1, 'ready:t-hush', 2), 1, 'readied before the swing')
  assert.equal(simulator.at(first).get(1)?.getHealth(), ninja.maxHp, 'dodged')
  assert.equal(markerCount(simulator, first, 'ready:t-hush', 2), 0, 'and the hush is spent')
  assert.equal(simulator.at(last).get(1)?.getHealth(), ninja.maxHp - trinketmaster.attackDamage, 'the swing after the window lands')
  assert.equal(simulator.at(last).get(1)?.getStatuses().some((status) => status.kind === 'silence'), false, 'with no silence')
})

test('a dodged auto lands none of the attacker\'s effects: not a shackle, not the stack it would add', () => {
  const enemyAt = { x: 300 + SWORD_GAP, y: 300 }
  const simulator = createNinjaDuel([[enemyAt.x, enemyAt.y, sword]])
  simulator.addOrder(1, cast(1, 1, 't-dodge', { mode: 'none' }, NINJA_AT))
  simulator.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 2, type: 'cast', abilityId: 't-shackle', target: { mode: 'none' }, origin: enemyAt,
  })
  simulator.addOrder(2, { id: 'player-2:2', seq: 2, tick: 3, type: 'attack', targetId: 1 })
  const landing = 3 + sword.attackWindupTicks
  stopAttacking(simulator, 2, landing, enemyAt)

  assert.equal(markerCount(simulator, landing - 1, 'ready:t-shackle', 2), 1)
  const frame = simulator.at(landing)
  assert.equal(frame.get(1)?.getHealth(), ninja.maxHp, 'no damage')
  assert.equal(frame.get(1)?.getStatuses().some((status) => status.kind === 'root' || status.kind === 'stun'), false, 'no shackle')
  assert.equal(markerCount(simulator, landing, 'sword', 2), 0, 'no sword stack for the swordsman')
  assert.equal(markerCount(simulator, landing, 'ready:t-shackle', 2), 0, 'and the shackle is used up')
})

test('dodging does not stop the ninja\'s own autos', () => {
  const simulator = createNinjaDuel([[360, 300]])
  simulator.addOrder(1, cast(1, 1, 't-dodge', { mode: 'none' }, NINJA_AT))
  // The ninja itself attacks while dodging.
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 2, type: 'attack', targetId: 2 })
  stopAttacking(simulator, 1, 2 + ninja.attackWindupTicks, NINJA_AT)

  assert.equal(
    simulator.at(2 + ninja.attackWindupTicks).get(2)?.getHealth(),
    brawler.maxHp - ninja.attackDamage,
    'dodging does not stop the ninja\'s own autos',
  )
})

test('a dash with effects of its own, the shadow, the stacks and a dodge survive a checkpoint restore', () => {
  const build = (): Simulator => {
    const simulator = createNinjaDuel()
    // The dodge first, then the step, which leaves a shadow and carries on through the dodge.
    simulator.addOrder(1, cast(1, 1, 't-dodge', { mode: 'none' }, NINJA_AT))
    simulator.addOrder(1, stepAlong(2, 2, NINJA_AT))
    return simulator
  }
  const record = (simulator: Simulator, from: number, to: number): Map<number, string> => {
    const frames = new Map<number, string>()
    for (let tick = from; tick <= to; tick += 1) {
      const frame = simulator.at(tick)
      frames.set(tick, JSON.stringify([
        frame.getEntities(),
        frame.get(1)?.getPosition(),
        frame.get(2)?.getPosition(),
        frame.get(1)?.getStatuses(),
        frame.get(1)?.getMarkers(),
        frame.get(1)?.getAbilityCooldown('t-shadowstep'),
        frame.get(2)?.getStatuses(),
        frame.get(2)?.getMarkers(),
        frame.get(2)?.getHealth(),
      ]))
    }
    return frames
  }
  const expected = record(build(), 1, 160)

  // The step is cast on tick 2 and reaches the enemy on tick 6. One checkpoint is mid-dash before that
  // (the dash carries its effects and has touched no one), one mid-dash after it (it has touched the
  // enemy, and must not touch it again), and one with the dodge on.
  const original = build()
  original.advanceTo(5)
  original.setCommitTick(3)
  const beforeContact = original.snapshot()
  original.advanceTo(12)
  original.setCommitTick(8)
  const afterContact = original.snapshot()
  original.advanceTo(70)
  original.setCommitTick(65)
  const dodging = original.snapshot()
  const dashOf = (snapshot: typeof beforeContact) =>
    snapshot.checkpoint.characters.find((character) => character.characterId === 1)?.dash
  assert.deepEqual(dashOf(beforeContact)?.contact?.hitIds, [])
  assert.deepEqual(dashOf(afterContact)?.contact?.hitIds, [2])
  assert.equal(afterContact.checkpoint.entities.some((entity) => entity.defId === 't-shadow'), true)
  assert.equal(afterContact.checkpoint.characters.find((character) => character.characterId === 1)
    ?.markers.some((marker) => marker.key === 'shadow'), true)
  assert.equal(dodging.checkpoint.characters.find((character) => character.characterId === 1)
    ?.statuses.some((status) => status.kind === 'dodge'), true)

  for (const [snapshot, committed] of [[beforeContact, 3], [afterContact, 8], [dodging, 65]] as const) {
    // Restored from what the schema lets through, as a client receiving it would be.
    const parsed = GameSnapshotSchema.safeParse(snapshot)
    assert.equal(parsed.success, true)
    const restored = new Simulator()
    restored.replaceFromSnapshot(parsed.data as typeof snapshot)
    for (const [tick, frame] of record(restored, committed + 1, 160)) assert.equal(frame, expected.get(tick), `tick ${tick}`)
  }
})

// Trinketmaster's passive, against the copy in fixtures.ts: the third ability hit in a row on the same
// enemy, each within 5 s of the last, deals 50 bonus damage on top of its own and gives 30% move speed
// for 2 s. The hits are the stick going out, the stick coming back and the auto that hush readies. His
// plain autos are not hits for it.

const trickHurt = (simulator: Simulator, tick: number, id = 2): number =>
  brawler.maxHp - (simulator.at(tick).get(id)?.getHealth() ?? 0)
const trickSpeed = (simulator: Simulator, tick: number) =>
  simulator.at(tick).get(1)?.getStatuses().find((status) => status.kind === 'haste')

test('plain autos are not hits for the passive: three in a row on the same enemy are all plain', () => {
  const simulator = createStickDuel([[360, 300]])
  const windup = trinketmaster.attackWindupTicks
  const landing = (index: number): number => 1 + index * trinketmaster.attackCooldownTicks + windup
  simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  stopAttacking(simulator, 1, landing(2), TRINKET_AT)

  for (const index of [0, 1, 2]) {
    assert.equal(trickHurt(simulator, landing(index)), (index + 1) * trinketmaster.attackDamage, `auto ${index + 1} is plain`)
    assert.equal(markerCount(simulator, landing(index), 'trick', 2), 0, 'and leaves no mark')
    assert.equal(trickSpeed(simulator, landing(index)), undefined)
  }
})

test('the stick going out, the stick coming back and the auto hush readies are three ability hits, and the last has the bonus', () => {
  const simulator = createStickDuel([[360, 300]])
  const windup = trinketmaster.attackWindupTicks
  // A plain auto on tick 1 lands on tick 4 and does not count. The stick, thrown east on tick 10 for 60
  // damage, hits the enemy on the way out and comes down about tick 45. The recall, called on tick 60,
  // hits it again on the way back. Hush is readied on tick 100 and the auto on 101 is the hush's.
  simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  simulator.addOrder(1, cast(2, 10, 't-stick', STICK_EAST, TRINKET_AT))
  simulator.addOrder(1, cast(3, 60, 't-recall', { mode: 'none' }, TRINKET_AT))
  simulator.addOrder(1, cast(4, 100, 't-hush', { mode: 'none' }, TRINKET_AT))
  simulator.addOrder(1, { id: 'player-1:5', seq: 5, tick: 101, type: 'attack', targetId: 2 })
  const hushLanding = 101 + windup
  stopAttacking(simulator, 1, hushLanding, TRINKET_AT)

  const auto = 1 + windup
  assert.equal(trickHurt(simulator, auto), 60, 'the auto is plain')
  assert.equal(markerCount(simulator, auto, 'trick', 2), 0, 'and does not count')

  const out = firstTick(auto + 1, 50, (tick) => trickHurt(simulator, tick) > 60)
  assert.ok(out !== undefined, 'the stick hits it going out')
  assert.equal(trickHurt(simulator, out), 120, 'for its own damage: it is the first hit')
  assert.equal(markerCount(simulator, out, 'trick', 2), 1)

  const back = firstTick(61, 99, (tick) => trickHurt(simulator, tick) > 120)
  assert.ok(back !== undefined, 'and the recall hits it coming back')
  assert.equal(trickHurt(simulator, back), 180, 'for its own damage: the second')
  assert.equal(markerCount(simulator, back, 'trick', 2), 2)
  assert.equal(trickSpeed(simulator, back), undefined)

  const frame = simulator.at(hushLanding)
  assert.equal(trickHurt(simulator, hushLanding), 180 + 60 + 50, 'the hush auto is the third, with the 50 more')
  assert.equal(frame.get(2)?.getStatuses().some((status) => status.kind === 'silence'), true, 'and still silences')
  assert.equal(markerCount(simulator, hushLanding, 'trick', 2), 0, 'and pops the marks')
  const speed = trickSpeed(simulator, hushLanding)
  assert.equal(speed?.amount, 0.3)
  assert.equal(speed?.endTick, hushLanding + 120, 'for two seconds')
})

test('hush counts wherever it comes in the count, as the first hit as much as the third', () => {
  const simulator = createStickDuel([[360, 300]])
  const windup = trinketmaster.attackWindupTicks
  // Hush is readied on tick 1 and its auto lands on tick 5. Then the stick, and then the recall.
  simulator.addOrder(1, cast(1, 1, 't-hush', { mode: 'none' }, TRINKET_AT))
  simulator.addOrder(1, { id: 'player-1:2', seq: 2, tick: 2, type: 'attack', targetId: 2 })
  const hushLanding = 2 + windup
  stopAttacking(simulator, 1, hushLanding, TRINKET_AT)
  simulator.addOrder(1, cast(3, 10, 't-stick', STICK_EAST, TRINKET_AT))
  simulator.addOrder(1, cast(4, 70, 't-recall', { mode: 'none' }, TRINKET_AT))

  assert.equal(trickHurt(simulator, hushLanding), 60, 'the hush auto does its own damage')
  assert.equal(markerCount(simulator, hushLanding, 'trick', 2), 1, 'and is the first hit')
  const out = firstTick(hushLanding + 1, 60, (tick) => trickHurt(simulator, tick) > 60)
  assert.ok(out !== undefined)
  assert.equal(trickHurt(simulator, out), 120)
  assert.equal(markerCount(simulator, out, 'trick', 2), 2, 'the stick is the second')
  const back = firstTick(71, 140, (tick) => trickHurt(simulator, tick) > 120)
  assert.ok(back !== undefined)
  assert.equal(trickHurt(simulator, back), 120 + 60 + 50, 'and the recall the third')
  assert.equal(trickSpeed(simulator, back)?.amount, 0.3)
})

test('the passive counts each enemy on its own, so hits split between two never make a third', () => {
  const simulator = createStickDuel([[360, 300], [460, 300]])
  // The stick goes out through the first enemy and then the second, and the recall comes back through
  // the second and then the first: four hits, but only two on either of them.
  simulator.addOrder(1, cast(1, 1, 't-stick', STICK_EAST, TRINKET_AT))
  simulator.addOrder(1, cast(2, 60, 't-recall', { mode: 'none' }, TRINKET_AT))

  const end = 150
  assert.equal(trickHurt(simulator, end, 2), 120, 'two plain hits on the first')
  assert.equal(trickHurt(simulator, end, 3), 120, 'and two on the second')
  assert.equal(markerCount(simulator, end, 'trick', 2), 2)
  assert.equal(markerCount(simulator, end, 'trick', 3), 2)
  assert.equal(trickSpeed(simulator, end), undefined, 'and no speed')
})

test('the passive count is lost if the hits are more than five seconds apart', () => {
  const simulator = createStickDuel([[360, 300]])
  simulator.addOrder(1, cast(1, 1, 't-stick', STICK_EAST, TRINKET_AT))
  // The mark from the stick going out lasts five seconds. The recall, called on tick 400, hits the enemy
  // long after it has gone.
  simulator.addOrder(1, cast(2, 400, 't-recall', { mode: 'none' }, TRINKET_AT))

  const out = firstTick(2, 60, (tick) => trickHurt(simulator, tick) > 0)
  assert.ok(out !== undefined)
  assert.equal(markerCount(simulator, out, 'trick', 2), 1)
  assert.equal(markerCount(simulator, 399, 'trick', 2), 0, 'it has worn off')
  const back = firstTick(401, 480, (tick) => trickHurt(simulator, tick) > 60)
  assert.ok(back !== undefined)
  assert.equal(trickHurt(simulator, back), 120)
  assert.equal(markerCount(simulator, back, 'trick', 2), 1, 'so the recall is the first hit of a new count, not the second')
})

// Teams, against the fixtures. Characters on the same team are teammates and anyone else is an
// enemy: attacks, targeted casts, blasts, lines, shots, statuses and pushes only ever reach enemies,
// while the effects meant for allies reach teammates too. Every game here is laid out along y = 300.

type TeamEntry = { champion?: Champion; x: number; y: number; team: number }

function createTeamGame(entries: TeamEntry[]): Simulator {
  const simulator = new Simulator()
  entries.forEach(({ champion, x, y, team }, index) => {
    simulator.addPlayer(index + 1, `player-${index + 1}`, `Player ${index + 1}`, { x, y }, champion ?? brawler, team)
  })
  return simulator
}

const kindsOn = (simulator: Simulator, tick: number, id: number): string[] =>
  (simulator.at(tick).get(id)?.getStatuses() ?? []).map((status) => status.kind).sort()

test('a character cannot attack a teammate or aim a unit ability at one, but can do both to an enemy', () => {
  const simulator = createTeamGame([
    { x: 300, y: 300, team: 1 },
    { x: 380, y: 300, team: 1 },
    { x: 300, y: 400, team: 2 },
  ])
  const at: Vector2 = { x: 300, y: 300 }
  // At the teammate: an auto on tick 1 and a lash (300) on tick 5. At the enemy: an auto on tick 20
  // and a lash on tick 30, which lands on tick 39.
  simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  simulator.addOrder(1, cast(2, 5, 't-lash', { mode: 'unit', unitId: 2 }, at))
  simulator.addOrder(1, { id: 'player-1:3', seq: 3, tick: 20, type: 'attack', targetId: 3 })
  simulator.addOrder(1, cast(4, 30, 't-lash', { mode: 'unit', unitId: 3 }, at))

  assert.equal(simulator.at(18).get(2)?.getHealth(), 1000, 'the teammate was not hit')
  assert.equal(simulator.at(18).get(1)?.getNextAttackTick(), 0, 'and the auto was never started')
  assert.equal(simulator.at(18).get(1)?.getAbilityCooldown('t-lash').ready, true, 'nor was the lash')
  assert.equal(simulator.at(21).get(3)?.getHealth(), 900, 'the enemy takes the auto')
  assert.equal(simulator.at(40).get(3)?.getHealth(), 600, 'and the lash')
})

test('a blast, a shot and a line hurt enemies and pass teammates by', () => {
  // A nova (200 damage, a slow, to everyone within 120): the teammate 60 away is untouched, the
  // enemy 60 away on the other side is hurt and slowed.
  const nova = createTeamGame([
    { x: 300, y: 300, team: 1 },
    { x: 360, y: 300, team: 1 },
    { x: 240, y: 300, team: 2 },
  ])
  nova.addOrder(1, cast(1, 1, 't-shockwave', { mode: 'none' }, { x: 300, y: 300 }))
  assert.equal(nova.at(7).get(3)?.getHealth(), 800)
  assert.deepEqual(kindsOn(nova, 7, 3), ['slow'])
  assert.equal(nova.at(7).get(2)?.getHealth(), 1000)
  assert.deepEqual(kindsOn(nova, 7, 2), [], 'the teammate is neither hurt nor slowed')
  assert.equal(nova.at(7).get(1)?.getShield(), 200, 'while the caster still shields itself')

  // A bolt that stops at the first thing it hits flies straight through a teammate in its way and
  // stops on the enemy behind: it reaches the teammate on tick 23 and the enemy on tick 38.
  const bolt = createTeamGame([
    { x: 300, y: 300, team: 1 },
    { x: 450, y: 300, team: 1 },
    { x: 600, y: 300, team: 2 },
  ])
  bolt.addOrder(1, cast(1, 1, 't-bolt', EAST, { x: 300, y: 300 }))
  assert.equal(bolt.at(23).get(2)?.getHealth(), 1000)
  assert.equal(bolt.at(23).getEntities().length, 1, 'it did not stop on the teammate')
  assert.equal(bolt.at(38).get(3)?.getHealth(), 700)
  assert.equal(bolt.at(38).getEntities().length, 0)
  assert.equal(bolt.at(40).get(2)?.getHealth(), 1000)

  // A cut along a line damages the enemy in it and not the teammate in front of it. The fire it
  // leaves slows the enemy and speeds the teammate, which is a thing meant for allies.
  const cut = createTeamGame([
    { champion: cutter, x: 300, y: 300, team: 1 },
    { x: 400, y: 300, team: 1 },
    { x: 500, y: 300, team: 2 },
  ])
  cut.addOrder(1, cast(1, 1, 't-cut', EAST, { x: 300, y: 300 }))
  assert.equal(cut.at(8).get(3)?.getHealth(), 880)
  assert.equal(cut.at(8).get(2)?.getHealth(), 1000)
  assert.deepEqual(kindsOn(cut, 8, 3), ['slow'])
  assert.deepEqual(kindsOn(cut, 8, 2), ['haste'])
})

test('a grenade bounces and hurts only enemies, never a teammate beside them, and refunds only for an enemy', () => {
  // Lobbed 300 px to (600, 300), going off on tick 36. A teammate 50 east of the middle and an
  // enemy 50 north of it are both inside the blast.
  const mixed = createTeamGame([
    { champion: grenadier, x: 300, y: 300, team: 1 },
    { x: 650, y: 300, team: 1 },
    { x: 600, y: 250, team: 2 },
  ])
  mixed.addOrder(1, cast(1, 1, 't-grenade', { mode: 'point', point: { x: 600, y: 300 } }, { x: 300, y: 300 }))
  assert.equal(mixed.at(36).get(3)?.getHealth(), 900, 'the enemy is hurt')
  assert.equal(mixed.at(36).get(2)?.getHealth(), 1000, 'and the teammate is not')
  assert.equal(mixed.at(37).get(3)?.isDashing(), true, 'the enemy is bounced')
  assert.equal(mixed.at(37).get(2)?.isDashing(), false, 'and the teammate is not')
  assert.equal(
    mixed.at(37).get(1)?.getAbilityCooldown('t-grenade').ticksRemaining,
    5 + 600 - 300 - 37,
    'catching an enemy hands back half the cooldown',
  )
  assert.deepEqual(mixed.at(96).get(2)?.getPosition(), { x: 650, y: 300 }, 'the teammate has not moved')
  assert.deepEqual(mixed.at(96).get(3)?.getPosition(), { x: 600, y: 100 })

  // With only a teammate in the blast there is nothing to hurt, nothing to bounce, and no refund.
  const mates = createTeamGame([
    { champion: grenadier, x: 300, y: 300, team: 1 },
    { x: 650, y: 300, team: 1 },
  ])
  mates.addOrder(1, cast(1, 1, 't-grenade', { mode: 'point', point: { x: 600, y: 300 } }, { x: 300, y: 300 }))
  assert.equal(mates.at(36).get(2)?.getHealth(), 1000)
  assert.equal(mates.at(37).get(2)?.isDashing(), false)
  assert.equal(
    mates.at(37).get(1)?.getAbilityCooldown('t-grenade').ticksRemaining,
    5 + 600 - 37,
    'a blast that caught no enemy refunds nothing',
  )
  assert.deepEqual(mates.at(96).get(2)?.getPosition(), { x: 650, y: 300 })
})

test('a flash, a fire and a thrown stick affect enemies and spare teammates standing in them', () => {
  // The flash goes off at (600, 300) on tick 36: an enemy in its core is stunned and one at its edge
  // blinded, and a teammate in the core and one at the edge have nothing happen to them.
  const flash = createTeamGame([
    { champion: grenadier, x: 300, y: 300, team: 1 },
    { x: 580, y: 300, team: 1 },
    { x: 640, y: 300, team: 2 },
    { x: 600, y: 390, team: 1 },
    { x: 700, y: 300, team: 2 },
  ])
  flash.addOrder(1, cast(1, 1, 't-flashbang', { mode: 'point', point: { x: 600, y: 300 } }, { x: 300, y: 300 }))
  assert.deepEqual(kindsOn(flash, 36, 3), ['stun'])
  assert.deepEqual(kindsOn(flash, 36, 5), ['blind'])
  assert.deepEqual(kindsOn(flash, 36, 2), [], 'a teammate in the core is not stunned')
  assert.deepEqual(kindsOn(flash, 36, 4), [], 'and one at the edge is not blinded')

  // The fire goes down on tick 36 too and burns and slows an enemy in it, and not a teammate.
  const fire = createTeamGame([
    { champion: grenadier, x: 300, y: 300, team: 1 },
    { x: 570, y: 300, team: 1 },
    { x: 630, y: 300, team: 2 },
  ])
  fire.addOrder(1, cast(1, 1, 't-molotov', { mode: 'point', point: { x: 600, y: 300 } }, { x: 300, y: 300 }))
  assert.deepEqual(kindsOn(fire, 40, 3), ['burn', 'slow'])
  assert.deepEqual(kindsOn(fire, 40, 2), [])
  assert.equal(fire.at(70).get(2)?.getHealth(), 1000, 'and the teammate is never burned')
  assert.ok((fire.at(70).get(3)?.getHealth() ?? 1000) < 1000)

  // A stick thrown east passes through everyone in its line, and hurts only the enemy in it: the
  // teammate 100 along takes nothing and the enemy 200 along takes the 60.
  const stick = createTeamGame([
    { champion: trinketmaster, x: 300, y: 300, team: 1 },
    { x: 400, y: 300, team: 1 },
    { x: 500, y: 300, team: 2 },
  ])
  stick.addOrder(1, cast(1, 1, 't-stick', STICK_EAST, TRINKET_AT))
  assert.equal(stick.at(30).get(3)?.getHealth(), 940)
  assert.equal(stick.at(30).get(2)?.getHealth(), 1000)
})

test('an area speed-up reaches teammates and the caster, not enemies, and it really makes them faster', () => {
  const simulator = createTeamGame([
    { champion: cursebearer, x: 300, y: 300, team: 1 },
    { x: 400, y: 300, team: 1 },
    { x: 300, y: 400, team: 2 },
    { x: 300, y: 700, team: 1 },
  ])
  simulator.addOrder(1, cast(1, 1, 't-miasma', { mode: 'none' }, { x: 300, y: 300 }))
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 10, type: 'move', target: { x: 800, y: 300 } })
  simulator.addOrder(3, { id: 'player-3:1', seq: 1, tick: 10, type: 'move', target: { x: 300, y: 800 } })

  // The field is out by tick 8. The teammate and the caster are in it and sped up; the enemy is in
  // it and slowed; the other teammate is 400 away and untouched.
  assert.deepEqual(kindsOn(simulator, 8, 2), ['haste'])
  assertClose(simulator.at(8).get(2)?.getStatuses()[0]?.amount ?? 0, 0.25)
  assert.deepEqual(kindsOn(simulator, 8, 1), ['haste'])
  assert.deepEqual(kindsOn(simulator, 8, 3), ['slow'])
  assert.deepEqual(kindsOn(simulator, 8, 4), [])

  // And the speed is real: a walker in the field goes 25% faster, an enemy 25% slower.
  const step = (id: number, tick: number): number => {
    const before = simulator.at(tick).get(id)?.getPosition()
    const after = simulator.at(tick + 1).get(id)?.getPosition()
    return Math.hypot((after?.x ?? 0) - (before?.x ?? 0), (after?.y ?? 0) - (before?.y ?? 0))
  }
  assertClose(step(2, 12), brawler.moveSpeed * 1.25 / GAME_TPS)
  assertClose(step(3, 12), brawler.moveSpeed * 0.75 / GAME_TPS)
})
