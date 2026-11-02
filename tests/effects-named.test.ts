import assert from 'node:assert/strict'
import test from 'node:test'
import {
  besideOwner,
  dash,
  disarm,
  enemiesInCone,
  fear,
  GAME_TPS,
  haste,
  invisible,
  namedStatusTicksLeft,
  prolong,
  resist,
  runEffects,
  self,
  spawnEntity,
  statBuff,
  towardTarget,
  type SimContext,
  type Vector2,
} from '../packages/shared/src/index.ts'
import type { EffectSource } from '../packages/shared/src/effects.ts'
import type { Status } from '../packages/shared/src/index.ts'

// The small things added for Hammer and Chain, on their own: a status with a name that is renewed however it is given, a way to make it last longer, the point just
// beside the caster that something is dragged to, and a dash that takes a set time. Each is run against a stand-in for the simulator that only records what it is asked.

const source = (over: Partial<EffectSource> = {}): EffectSource =>
  ({ id: 'c:one', rootId: 'one', ownerId: 1, tick: 100, at: { x: 0, y: 0 }, aim: null, subject: null, ...over })

const status = (id: string, over: Partial<Status> = {}): Status =>
  ({ id, kind: 'haste', rootId: 'x', ownerId: 1, startTick: 90, endTick: 150, amount: 0.3, ...over })

function recorder(statuses: readonly Status[] = []) {
  const written: Array<{ unitId: number; status: Status }> = []
  const sim = {
    tick: 100,
    statusesOn: () => statuses.map((each) => ({ ...each })),
    addStatus: (unitId: number, written_: Status) => written.push({ unitId, status: written_ }),
  } as unknown as SimContext
  return { sim, written }
}

// ---------------------------------------------------------------------------- named statuses

test('a status with a name is the owner\'s, whichever cast or attack gives it, so giving it again renews it', () => {
  const effects = [
    haste(0.3, 30, self(), { named: 'rage' }),
    resist(0.2, 30, self(), { named: 'rage' }),
    statBuff('attackSpeed', 0.5, 30, self(), { named: 'rage' }),
  ]
  const first = recorder()
  const second = recorder()
  runEffects(effects, first.sim, source({ id: 'c:one' }))
  runEffects(effects, second.sim, source({ id: 'a:two:t9', rootId: 'two' }))

  const ids = (written: typeof first.written): string[] => written.map(({ status: each }) => each.id)
  assert.deepEqual(ids(first.written), ids(second.written), 'the same statuses, so the second replaces the first')
  assert.equal(new Set(ids(first.written)).size, 3, 'and the three are three')
  assert.ok(ids(first.written).every((id) => id.startsWith('1:rage:')), 'each is the owner\'s, under the name')
})

test('a status without a name is the cast\'s or the attack\'s own, so another one does not renew it', () => {
  const first = recorder()
  const second = recorder()
  runEffects([resist(0.2, 30), statBuff('attackSpeed', 0.5, 30)], first.sim, source({ id: 'c:one' }))
  runEffects([resist(0.2, 30), statBuff('attackSpeed', 0.5, 30)], second.sim, source({ id: 'c:two' }))
  const ids = [...first.written, ...second.written].map(({ status: each }) => each.id)
  assert.equal(new Set(ids).size, 4)
})

test('two owners\' statuses of one name are different statuses, and one name does not stand for another that starts with it', () => {
  const left = recorder()
  const right = recorder()
  runEffects([haste(0.3, 30, self(), { named: 'rage' })], left.sim, source({ ownerId: 1 }))
  runEffects([haste(0.3, 30, self(), { named: 'rage' })], right.sim, source({ ownerId: 11 }))
  assert.notEqual(left.written[0].status.id, right.written[0].status.id)

  const statuses = [status('1:rage:haste'), status('1:rageful:haste', { endTick: 400 }), status('11:rage:haste', { endTick: 500 })]
  assert.equal(namedStatusTicksLeft(statuses, 1, 'rage', 100), 50, 'only the owner\'s, under the name')
})

// ---------------------------------------------------------------------------- how long they have left

test('what is left of a name is the longest of its statuses, and none for none, or when they have run out', () => {
  const statuses = [status('1:rage:haste', { endTick: 150 }), status('1:rage:resist', { endTick: 180 })]
  assert.equal(namedStatusTicksLeft(statuses, 1, 'rage', 100), 80)
  assert.equal(namedStatusTicksLeft(statuses, 1, 'rage', 175), 5)
  assert.equal(namedStatusTicksLeft(statuses, 1, 'rage', 180), 0)
  assert.equal(namedStatusTicksLeft(statuses, 1, 'plating', 100), 0)
  assert.equal(namedStatusTicksLeft([], 1, 'rage', 100), 0)
})

// ---------------------------------------------------------------------------- prolong

test('prolong makes the statuses of a name last longer, all of them, and no other', () => {
  const { sim, written } = recorder([
    status('1:rage:haste', { endTick: 150 }),
    status('1:rage:resist', { kind: 'resist', endTick: 150 }),
    status('1:rageful:haste', { endTick: 150 }),
    status('2:rage:haste', { endTick: 150 }),
    status('c:one:haste', { endTick: 150 }),
  ])
  runEffects([prolong('rage', 30, 1000)], sim, source())

  assert.deepEqual(written.map(({ status: each }) => [each.id, each.endTick]), [['1:rage:haste', 180], ['1:rage:resist', 180]])
  assert.equal(written[1].status.kind, 'resist', 'the rest of each is as it was')
  assert.equal(written[0].status.amount, 0.3)
})

test('prolong never leaves more than the most there is to be left, and one already at the most is left alone', () => {
  const near = recorder([status('1:rage:haste', { endTick: 150 })])
  runEffects([prolong('rage', 500, 80)], near.sim, source())
  assert.deepEqual(near.written.map(({ status: each }) => each.endTick), [180], '80 ticks from now, which is tick 100')

  const full = recorder([status('1:rage:haste', { endTick: 180 }), status('1:rage:resist', { kind: 'resist', endTick: 200 })])
  runEffects([prolong('rage', 30, 80)], full.sim, source())
  assert.deepEqual(full.written, [], 'at the most, or past it, nothing is written')
})

test('prolong does nothing for a unit with no such status, so an auto does not start a rage', () => {
  const { sim, written } = recorder([status('c:one:haste')])
  runEffects([prolong('rage', 30, 80)], sim, source())
  assert.deepEqual(written, [])
})

// ---------------------------------------------------------------------------- besideOwner

function bodies(positions: Record<number, Vector2>, radii: Record<number, number>): SimContext {
  return {
    character: (id: number) => (radii[id] === undefined ? undefined : { champion: { radius: radii[id] } }),
    posAt: (id: number) => positions[id],
  } as unknown as SimContext
}

test('the point beside the owner is just short of him on the line to the unit hit, touching him', () => {
  const sim = bodies({ 1: { x: 100, y: 100 }, 2: { x: 100, y: 500 } }, { 1: 20, 2: 30 })
  const point = besideOwner()(sim, source({ subject: 2 }))
  assert.ok(point)
  assert.ok(Math.abs(point.x - 100) < 1e-9 && Math.abs(point.y - (100 + 20 + 30)) < 1e-9, JSON.stringify(point))

  const gap = besideOwner(5)(sim, source({ subject: 2 }))
  assert.ok(gap && Math.abs(gap.y - (100 + 20 + 30 + 5)) < 1e-9, 'with room to spare, when it is given some')
})

test('there is no point beside the owner for a unit already touching him, or for no unit', () => {
  const sim = bodies({ 1: { x: 100, y: 100 }, 2: { x: 140, y: 100 } }, { 1: 20, 2: 30 })
  assert.equal(besideOwner()(sim, source({ subject: 2 })), undefined, '40 apart is already inside 20 + 30')
  assert.equal(besideOwner()(sim, source({ subject: null })), undefined)
  assert.equal(besideOwner()(sim, source({ subject: 9 })), undefined, 'or one that is not there')
})

// ---------------------------------------------------------------------------- disarm, and an entity held on its owner

test('a disarm is a status of its own kind that lasts as long as it is given', () => {
  const { sim, written } = recorder()
  runEffects([disarm(30, self())], sim, source({ tick: 100 }))
  assert.equal(written.length, 1)
  assert.equal(written[0].unitId, 1)
  assert.equal(written[0].status.kind, 'disarm')
  assert.equal(written[0].status.endTick - written[0].status.startTick, 30)
})

test('an entity held on its owner is refused if it is also to move, land at an aim, home or follow', () => {
  const held = { id: 't-held', speed: 0, radius: 20, lifetimeTicks: 10, attached: true }
  assert.doesNotThrow(() => spawnEntity(held))
  for (const [what, def] of [
    ['move', { ...held, id: 't-held-moving', speed: 5 }],
    ['land at an aim', { ...held, id: 't-held-lobbed', landAtAim: true }],
    ['follow', { ...held, id: 't-held-following', follow: { stiffness: 10, damping: 5 } }],
  ] as const) {
    assert.throws(() => spawnEntity(def), /held on its owner/, `it cannot ${what}`)
  }
})

// ---------------------------------------------------------------------------- fear and invisibility

test('a fear and an invisibility are statuses of their own kinds, the fearer\'s own, that last as long as they are given', () => {
  for (const [effect, kind] of [[fear(30, self()), 'fear'], [invisible(30, self()), 'invisible']] as const) {
    const { sim, written } = recorder()
    runEffects([effect], sim, source({ ownerId: 7, tick: 100 }))
    assert.equal(written.length, 1)
    assert.equal(written[0].status.kind, kind)
    assert.equal(written[0].status.ownerId, 7, 'it is the one who gave it that it is held by')
    assert.equal(written[0].status.endTick - written[0].status.startTick, 30)
  }
})

// ---------------------------------------------------------------------------- a cone

// Standing at the origin and aimed east, a cone 200 long that opens by 60 degrees. The bodies are circles, and a body is in the cone when any of it is.
const SIXTY = { cos: 0.8660254037844387, sin: 0.5 }
function coneOf(units: Record<number, { x: number; y: number; radius: number; team: number }>): SimContext {
  const place = (id: number): { x: number; y: number } => (id === 1 ? { x: 0, y: 0 } : units[id])
  return {
    tick: 100,
    character: (id: number) => (id === 1 ? { team: 1, champion: { radius: 20 } } : units[id] ? { team: units[id].team, champion: { radius: units[id].radius } } : undefined),
    posAt: (id: number) => place(id),
    unitsInRadius: (center: Vector2, reach: number) => Object.keys(units).map(Number).filter((id) => Math.hypot(units[id].x - center.x, units[id].y - center.y) <= reach + units[id].radius),
  } as unknown as SimContext
}

test('a cone holds the enemies any part of whose body is in it, once each, and not allies, nor what is behind it or past its end', () => {
  const units = {
    2: { x: 100, y: 0, radius: 20, team: 2 },
    3: { x: 100, y: 100, radius: 20, team: 2 },
    4: { x: 100, y: 55, radius: 20, team: 2 },
    5: { x: -10, y: 0, radius: 20, team: 2 },
    6: { x: -30, y: 0, radius: 20, team: 2 },
    7: { x: 100, y: 0, radius: 20, team: 1 },
    8: { x: 230, y: 0, radius: 20, team: 2 },
    9: { x: 215, y: 0, radius: 20, team: 2 },
    10: { x: 100, y: -48, radius: 20, team: 2 },
  }
  const found = enemiesInCone(200, SIXTY)(coneOf(units), source({ aim: { mode: 'direction', dir: { x: 1, y: 0 } } }))
  assert.deepEqual(found, [2, 4, 5, 9, 10], 'in the middle, inside an edge, on the point, at the end, and just inside the lower edge')
  assert.deepEqual(enemiesInCone(200, SIXTY)(coneOf(units), source({ aim: null })), [], 'with no aim there is no cone')
  // The same cone turned to face north has the enemy that was off its side.
  const north = enemiesInCone(200, SIXTY)(coneOf({ 2: { x: 0, y: 100, radius: 20, team: 2 }, 3: { x: 100, y: 0, radius: 20, team: 2 } }), source({ aim: { mode: 'direction', dir: { x: 0, y: 1 } } }))
  assert.deepEqual(north, [2])
})

// ---------------------------------------------------------------------------- a fan

test('an entity spread in a fan is one copy for each turn, each turned from the aim by it, with a name of its own, and its heading turned as well if it is a rectangle', () => {
  const turns = [{ x: 0.8660254037844387, y: -0.5 }, { x: 1, y: 0 }, { x: 0.8660254037844387, y: 0.5 }]
  const fired: Array<{ id: string; velocity: Vector2; facing?: Vector2 }> = []
  const sim = { addEntity: (entity: { id: string; velocity: Vector2; facing?: Vector2 }) => fired.push(entity) } as unknown as SimContext
  const aim = { aim: { mode: 'direction', dir: { x: 0, y: 1 } } } as const

  spawnEntity({ id: 't-fan-bolt', speed: 100, radius: 5, lifetimeTicks: 10 }, { spread: turns })(sim, source(aim))
  assert.equal(fired.length, turns.length)
  assert.equal(new Set(fired.map((entity) => entity.id)).size, turns.length, 'each is its own')
  fired.forEach((entity, index) => {
    // Aimed south (0, 1), turned by (cos, sin): (-sin, cos).
    assert.ok(Math.abs(entity.velocity.x + turns[index].y * 100) < 1e-9 && Math.abs(entity.velocity.y - turns[index].x * 100) < 1e-9, `copy ${index}`)
  })

  fired.length = 0
  spawnEntity({ id: 't-fan-blade', speed: 0, box: { halfLength: 20, halfWidth: 3 }, lifetimeTicks: 10 }, { spread: turns })(sim, source(aim))
  fired.forEach((entity, index) => {
    assert.ok(entity.facing && Math.abs(entity.facing.x + turns[index].y) < 1e-9 && Math.abs(entity.facing.y - turns[index].x) < 1e-9, `a rectangle turns with it: ${index}`)
  })
})

test('a fan needs a turn, and cannot also land at its aim, or be laid in a line or a volley', () => {
  const bolt = { id: 't-fan-bad', speed: 100, radius: 5, lifetimeTicks: 10 }
  assert.throws(() => spawnEntity(bolt, { spread: [] }), /fan/)
  assert.throws(() => spawnEntity({ ...bolt, id: 't-fan-lob', landAtAim: true }, { spread: [{ x: 1, y: 0 }] }), /fan/)
  assert.throws(() => spawnEntity({ ...bolt, id: 't-fan-volley' }, { spread: [{ x: 1, y: 0 }], volley: { count: 2, intervalTicks: 3 } }), /fan/)
})

// ---------------------------------------------------------------------------- toward a target

test('the point toward a target is always the same distance from the caster, on the line to it: past a nearer one, on top of one that far, and short of one that is further', () => {
  // The caster (1) stands at (10, 20); the others are 100 away along the line, on the caster, and at (30, 40) from it, which is 50 out.
  const places: Record<number, Vector2> = { 1: { x: 10, y: 20 }, 2: { x: 110, y: 20 }, 3: { x: 10, y: 20 }, 4: { x: 40, y: 60 } }
  const sim = { posAt: (id: number) => places[id] } as unknown as SimContext
  const toward = (distance: number, unitId: number) => towardTarget(distance)(sim, source({ ownerId: 1, aim: { mode: 'unit', unitId } }))
  assert.deepEqual(toward(200, 2), { x: 210, y: 20 }, 'a nearer enemy is overshot, by the difference')
  assert.deepEqual(toward(100, 2), { x: 110, y: 20 }, 'one exactly that far is ended up on top of')
  assert.deepEqual(toward(40, 2), { x: 50, y: 20 }, 'and one further than that is not reached')
  const diagonal = toward(100, 4)
  assert.ok(diagonal && Math.abs(diagonal.x - 70) < 1e-9 && Math.abs(diagonal.y - 100) < 1e-9, 'along the line, whichever way it goes: (30, 40) from the caster is 50 out, and 100 is (60, 80) from it')
  assert.equal(toward(100, 3), undefined, 'one on the caster has no direction')
  assert.equal(towardTarget(100)(sim, source({ ownerId: 1, aim: { mode: 'point', point: { x: 5, y: 5 } } })), undefined, 'only a unit aim has one')
  assert.equal(toward(100, 99), undefined, 'and one that is there')
})

// ---------------------------------------------------------------------------- a dash that takes a set time

function dashed(effect: ReturnType<typeof dash>, to: Vector2): Array<{ unitId: number; target: Vector2; speed: number }> {
  const started: Array<{ unitId: number; target: Vector2; speed: number }> = []
  const sim = {
    posAt: () => ({ x: 0, y: 0 }),
    startDash: (unitId: number, target: Vector2, speed: number) => started.push({ unitId, target, speed }),
  } as unknown as SimContext
  effect(sim, source({ aim: { mode: 'point', point: to } }))
  return started
}

test('a dash over a set time goes at the speed that gets it there in that time, however far that is', () => {
  const over = 30
  for (const reach of [60, 300, 900]) {
    const [started] = dashed(dash(1, Infinity, self(), { over }), { x: reach, y: 0 })
    assert.equal(started.speed / GAME_TPS * over, reach, `${reach} away`)
    assert.deepEqual(started.target, { x: reach, y: 0 })
  }
  // A dash that is held to a distance takes the set time for that distance, not the one aimed at.
  const [held] = dashed(dash(1, 100, self(), { over }), { x: 900, y: 0 })
  assert.equal(held.speed / GAME_TPS * over, 100)
})

test('a dash with no set time goes at its speed, and one over no time at all is refused', () => {
  const [plain] = dashed(dash(700, Infinity), { x: 300, y: 0 })
  assert.equal(plain.speed, 700)
  assert.throws(() => dash(700, 100, self(), { over: 0 }), /ticks above 0/)
  assert.throws(() => dash(700, 100, self(), { over: Number.NaN }), /ticks above 0/)
})
