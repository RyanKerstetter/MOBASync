import assert from 'node:assert/strict'
import test from 'node:test'
import {
  besideOwner,
  dash,
  disarm,
  GAME_TPS,
  haste,
  namedStatusTicksLeft,
  prolong,
  resist,
  runEffects,
  self,
  spawnEntity,
  statBuff,
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
