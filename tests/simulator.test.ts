import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Champion,
  GameSnapshotSchema,
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_COLLISION_STIFFNESS,
  GAME_MAX_PLAYERS,
  GAME_RESPAWN_TICKS,
  GAME_TPS,
  Simulator,
  type ChampionDef,
  type CharacterOrder,
  type DeathRecord,
} from '../packages/shared/src/index.js'
import { brawler, killAt } from './fixtures.js'

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
  // Beside the line player 1 walks along (y = 100), not on it: characters are solid, so one in the
  // way would stop the walker and push the tests' free-movement arithmetic off.
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 160 }, brawler)
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

test('a full lobby of eight fighting at once resolves identically in any arrival order', () => {
  const ids = Array.from({ length: GAME_MAX_PLAYERS }, (_, index) => index + 1)
  // A ring close enough that everyone reaches everyone; each attacks the next, then the previous.
  const build = (arrival: number[]): Simulator => {
    const simulator = new Simulator()
    for (const id of ids) {
      const angle = id / ids.length * Math.PI * 2
      simulator.addPlayer(id, `player-${id}`, `Player ${id}`, {
        x: 400 + Math.cos(angle) * 60,
        y: 300 + Math.sin(angle) * 60,
      }, brawler)
    }
    for (const id of arrival) {
      const next = id % ids.length + 1
      const previous = (id + ids.length - 2) % ids.length + 1
      simulator.addOrder(id, { id: `p${id}:1`, seq: 1, tick: 1, type: 'attack', targetId: next })
      // One full cooldown later, so the second attack is valid.
      simulator.addOrder(id, { id: `p${id}:2`, seq: 2, tick: 1 + GAME_TPS, type: 'attack', targetId: previous })
    }
    return simulator
  }
  const record = (simulator: Simulator, tick: number): string => {
    const frame = simulator.at(tick)
    return JSON.stringify(ids.map((id) => [frame.get(id)?.getHealthState(), frame.get(id)?.getCooldown()]))
  }
  const forward = build(ids)
  const reversed = build([...ids].reverse())

  const hurt = (hits: number): number => brawler.maxHp - hits * brawler.attackDamage
  for (const [tick, hits] of [[1, 1], [GAME_TPS, 1], [1 + GAME_TPS, 2]] as const) {
    assert.equal(record(reversed, tick), record(forward, tick), `tick ${tick}`)
    ids.forEach((id) => assert.equal(forward.at(tick).get(id)?.getHealth(), hurt(hits), `player ${id} on tick ${tick}`))
  }
})

// Characters are solid. Brawlers are 18 across (radius), so two touch at 36 apart.

const REACH = brawler.radius * 2
const SPRING = GAME_COLLISION_STIFFNESS

function createPair(first: [number, number], second: [number, number]): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: first[0], y: first[1] }, brawler)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: second[0], y: second[1] }, brawler)
  return simulator
}

function gapAt(simulator: Simulator, tick: number): number {
  const frame = simulator.at(tick)
  const first = frame.get(1)?.getPosition()
  const second = frame.get(2)?.getPosition()
  assert.ok(first && second)
  return Math.hypot(second.x - first.x, second.y - first.y)
}

test('overlapping characters are pushed apart like a spring and settle just touching', () => {
  // 20 apart, so 16 deep. Each tick the overlap shrinks by the same share, the pair slides apart
  // symmetrically about where they met, and they never get pushed farther than touching.
  const simulator = createPair([500, 300], [520, 300])

  for (let tick = 1; tick <= 5; tick += 1) {
    const overlap = 16 * (1 - SPRING) ** tick
    const frame = simulator.at(tick)
    assertPositionClose(frame.get(1)?.getPosition(), { x: 510 - (REACH - overlap) / 2, y: 300 })
    assertPositionClose(frame.get(2)?.getPosition(), { x: 510 + (REACH - overlap) / 2, y: 300 })
  }
  for (let tick = 6; tick <= 60; tick += 1) assert.ok(gapAt(simulator, tick) <= REACH + 1e-9, `tick ${tick}`)
  assert.ok(Math.abs(gapAt(simulator, 60) - REACH) < 1e-9, 'and they come to rest touching')
})

test('the push runs along the line between the two bodies, equally on each', () => {
  const simulator = createPair([500, 300], [510, 310])
  const before = [simulator.at(0).get(1)?.getPosition(), simulator.at(0).get(2)?.getPosition()]
  const after = [simulator.at(1).get(1)?.getPosition(), simulator.at(1).get(2)?.getPosition()]
  assert.ok(before[0] && before[1] && after[0] && after[1])

  const moved = after.map((position, index) => ({
    x: position!.x - before[index]!.x,
    y: position!.y - before[index]!.y,
  }))
  assert.ok(moved[0].x < 0 && moved[0].y < 0, 'the first is pushed away from the second')
  assert.ok(Math.abs(moved[0].x - moved[0].y) < 1e-9, 'straight along the diagonal between them')
  assert.ok(Math.abs(moved[0].x + moved[1].x) < 1e-9 && Math.abs(moved[0].y + moved[1].y) < 1e-9, 'and equally')
})

test('two characters on exactly the same spot are separated, the lower ID toward the left', () => {
  const simulator = createPair([800, 300], [800, 300])

  const frame = simulator.at(1)
  assertPositionClose(frame.get(1)?.getPosition(), { x: 800 - REACH * SPRING / 2, y: 300 })
  assertPositionClose(frame.get(2)?.getPosition(), { x: 800 + REACH * SPRING / 2, y: 300 })
  assert.ok(Math.abs(gapAt(simulator, 60) - REACH) < 1e-9)
})

test('a walker is stopped by a character in its way and carries it along, never passing through', () => {
  const simulator = createPair([100, 300], [300, 300])
  simulator.addOrder(1, { id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 700, y: 300 } })

  // The walker keeps pressing, so it sinks in a little, but never more than one of its own steps.
  for (let tick = 1; tick <= 200; tick += 1) {
    assert.ok(gapAt(simulator, tick) > REACH - SPEED / GAME_TPS, `tick ${tick}`)
    const frame = simulator.at(tick)
    assert.ok((frame.get(1)?.getPosition().x ?? 0) < (frame.get(2)?.getPosition().x ?? 0), 'it never gets past')
  }
  const end = simulator.at(200)
  assert.ok((end.get(2)?.getPosition().x ?? 0) > 400, 'the one in the way was shoved ahead of it')
  assert.equal(end.get(2)?.getPosition().y, 300)
  assert.ok((end.get(1)?.getPosition().x ?? 700) < 700, 'and the walker has not got through')
})

test('a walker aimed a little off-centre slides around a character in its way and arrives', () => {
  const simulator = createPair([100, 300], [300, 300])
  simulator.addOrder(1, { id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 700, y: 320 } })

  for (let tick = 1; tick <= 400; tick += 1) {
    assert.ok(gapAt(simulator, tick) > REACH - SPEED / GAME_TPS, `tick ${tick}`)
  }
  assert.deepEqual(simulator.at(400).get(1)?.getPosition(), { x: 700, y: 320 })
  assert.equal(simulator.at(400).get(1)?.getMoveTarget(), undefined, 'it finished the walk')
})

test('the edge of the map holds a character that is pushed against it', () => {
  const radius = brawler.radius
  const simulator = createPair([radius, 300], [radius + 12, 300])

  const end = simulator.at(60)
  assert.equal(end.get(1)?.getPosition().x, radius, 'the wall is not pushed through')
  assert.ok(Math.abs((end.get(2)?.getPosition().x ?? 0) - (radius + REACH)) < 1e-6, 'so the other takes all of the room')
})

test('a dead character is a ghost others walk through, and a respawn on top of someone is pushed off', () => {
  const simulator = createPair([100, 300], [400, 300])
  simulator.addOrder(1, { id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 400, y: 300 } })
  killAt(simulator, 2, 5)
  const respawn = 5 + GAME_RESPAWN_TICKS

  // The walker goes straight through the body and stops exactly on the spot it died on.
  assert.equal(simulator.at(90).get(2)?.isDead(), true)
  assert.deepEqual(simulator.at(90).get(1)?.getPosition(), { x: 400, y: 300 })
  assert.deepEqual(simulator.at(respawn - 1).get(1)?.getPosition(), { x: 400, y: 300 })
  // It respawns exactly where the walker is standing; the pair slide apart from there.
  const respawned = simulator.at(respawn)
  assert.equal(respawned.get(2)?.isDead(), false)
  assertPositionClose(respawned.get(1)?.getPosition(), { x: 400 - REACH * SPRING / 2, y: 300 })
  assertPositionClose(respawned.get(2)?.getPosition(), { x: 400 + REACH * SPRING / 2, y: 300 })
  assert.ok(Math.abs(gapAt(simulator, respawn + 40) - REACH) < 1e-9)
})

test('a crowd squeezing together resolves the same in any arrival order and after a checkpoint restore', () => {
  const ids = Array.from({ length: GAME_MAX_PLAYERS }, (_, index) => index + 1)
  // Eight characters ringed around a point, all sent to the middle of it.
  const build = (arrival: number[]): Simulator => {
    const simulator = new Simulator()
    for (const id of ids) {
      const angle = id / ids.length * Math.PI * 2
      simulator.addPlayer(id, `player-${id}`, `Player ${id}`, {
        x: 600 + Math.cos(angle) * 150,
        y: 400 + Math.sin(angle) * 150,
      }, brawler)
    }
    for (const id of arrival) {
      simulator.addOrder(id, { id: `p${id}:1`, seq: 1, tick: 1, type: 'move', target: { x: 600, y: 400 } })
    }
    return simulator
  }
  const record = (simulator: Simulator, from: number, to: number): Map<number, string> => {
    const frames = new Map<number, string>()
    for (let tick = from; tick <= to; tick += 1) {
      const frame = simulator.at(tick)
      frames.set(tick, JSON.stringify(ids.map((id) => frame.get(id)?.getPosition())))
    }
    return frames
  }
  const expected = record(build(ids), 1, 200)

  for (const [tick, frame] of record(build([...ids].reverse()), 1, 200)) {
    assert.equal(frame, expected.get(tick), `arrival order, tick ${tick}`)
  }
  const original = build(ids)
  original.advanceTo(100)
  original.setCommitTick(90)
  const restored = new Simulator()
  restored.replaceFromSnapshot(original.snapshot())
  for (const [tick, frame] of record(restored, 91, 200)) {
    assert.equal(frame, expected.get(tick), `restored, tick ${tick}`)
  }

  // Squeezed by everyone at once they sink into each other, but only part of the way.
  const last = original.at(200)
  for (const first of ids) {
    for (const second of ids.filter((id) => id > first)) {
      const a = last.get(first)?.getPosition()
      const b = last.get(second)?.getPosition()
      assert.ok(a && b)
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > REACH / 2, `${first} and ${second} are not on top of each other`)
    }
  }
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

test('an attack on a target out of reach walks up to it and swings as soon as it is in reach', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 500, y: 100 }, brawler)
  simulator.addOrder(1, { id: 'attack-1', seq: 1, tick: 1, type: 'attack', targetId: 2 })

  // 400 apart and a reach of 150: 250 px to walk at 3.67 a tick is 69 steps, so the swing is on
  // tick 70, and an attack with no windup lands in the same tick.
  const steps = Math.ceil((400 - brawler.attackRange) / (SPEED / GAME_TPS))
  const swing = 1 + steps
  assert.equal(simulator.at(swing - 1).get(2)?.getHealth(), 1000, 'not in reach yet')
  assert.ok((simulator.at(swing - 1).get(1)?.getPosition().x ?? 0) > 100, 'but it is on its way')
  assert.equal(simulator.at(swing - 1).get(1)?.getAttackTarget(), 2)
  assert.equal(simulator.at(swing).get(2)?.getHealth(), 900)
  // It stops where it is in reach, instead of walking on to the target.
  const stoodAt = simulator.at(swing).get(1)?.getPosition()
  assert.deepEqual(simulator.at(swing + 30).get(1)?.getPosition(), stoodAt)
  assert.ok(Math.hypot(500 - (stoodAt?.x ?? 0), 0) <= brawler.attackRange)
})

test('an attack goes on swinging, each time its cooldown is up, until the character is told to do something else', () => {
  const simulator = createSimulator([
    { id: 'attack-1', seq: 1, tick: 1, type: 'attack', targetId: 2 },
    { id: 'move-2', seq: 2, tick: 150, type: 'move', target: { x: 100, y: 100 } },
  ])

  // 100 a swing every 60 ticks from tick 1, with no further orders.
  assert.equal(simulator.at(1).get(2)?.getHealth(), 900)
  assert.equal(simulator.at(60).get(2)?.getHealth(), 900)
  assert.equal(simulator.at(61).get(2)?.getHealth(), 800)
  assert.equal(simulator.at(121).get(2)?.getHealth(), 700)
  assert.equal(simulator.at(149).get(1)?.getAttackTarget(), 2)
  // A move order ends it, and nothing swings again.
  assert.equal(simulator.at(151).get(1)?.getAttackTarget(), undefined)
  assert.equal(simulator.at(400).get(2)?.getHealth(), 700)
})

test('an attacker follows a target that walks away from it, and keeps swinging at the speed of its attack', () => {
  // The target runs off along the line at 3 px a tick; the attacker is quicker, at 5.
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 300 }, new Champion({ ...championDef(brawler), moveSpeed: 300 }))
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 300, y: 300 }, new Champion({ ...championDef(brawler), moveSpeed: 180 }))
  simulator.addOrder(1, { id: 'attack-1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  simulator.addOrder(2, { id: 'run-1', seq: 1, tick: 1, type: 'move', target: { x: 2000, y: 300 } })

  const hits: number[] = []
  let previous = 1000
  for (let tick = 1; tick <= 400; tick += 1) {
    const health = simulator.at(tick).get(2)?.getHealth() ?? 0
    if (health < previous) hits.push(tick)
    previous = health
  }
  assert.ok(hits.length >= 5, `it caught it and kept hitting it: ${hits}`)
  // Each swing comes as soon as the last one's cooldown is up and the target is in reach, which
  // is a tick or two late at most for a target that never stops running.
  hits.slice(1).forEach((tick, index) => {
    const gap = tick - hits[index]
    assert.ok(gap >= 60 && gap <= 64, `swings ${hits[index]} and ${tick} are ${gap} apart`)
  })
  assert.ok((simulator.at(400).get(1)?.getPosition().x ?? 0) > 800, 'it followed the target a long way')
})

test('a new attack order changes the target, and an order that cannot be carried out changes nothing', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler, 1)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 150, y: 100 }, brawler, 2)
  simulator.addPlayer(3, 'player-3', 'Player 3', { x: 100, y: 160 }, brawler, 3)
  simulator.addPlayer(4, 'player-4', 'Player 4', { x: 40, y: 100 }, brawler, 1)
  simulator.addOrder(1, { id: 'attack-1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  simulator.addOrder(1, { id: 'attack-2', seq: 2, tick: 70, type: 'attack', targetId: 3 })
  // A teammate, a character that does not exist, and the attacker itself cannot be attacked.
  simulator.addOrder(1, { id: 'attack-3', seq: 3, tick: 80, type: 'attack', targetId: 4 })
  simulator.addOrder(1, { id: 'attack-4', seq: 4, tick: 81, type: 'attack', targetId: 99 })
  simulator.addOrder(1, { id: 'attack-5', seq: 5, tick: 82, type: 'attack', targetId: 1 })

  assert.equal(simulator.at(1).get(2)?.getHealth(), 900)
  assert.equal(simulator.at(69).get(1)?.getAttackTarget(), 2)
  assert.equal(simulator.at(70).get(1)?.getAttackTarget(), 3, 'the new order took over')
  // The orders for what it cannot attack, on ticks 80 to 82, left the new target alone.
  for (const tick of [81, 82, 83]) assert.equal(simulator.at(tick).get(1)?.getAttackTarget(), 3, `tick ${tick}`)
  // It swung at the first target on tick 61, so its attack is not ready again until tick 121.
  assert.equal(simulator.at(120).get(3)?.getHealth(), 1000)
  assert.equal(simulator.at(121).get(3)?.getHealth(), 900, 'and then it swung at the new target')
  assert.equal(simulator.at(121).get(2)?.getHealth(), 800, 'not at the old one again')
  assert.equal(simulator.at(121).get(4)?.getHealth(), 1000, 'the teammate was left alone')
})

test('an attack order for an unreachable target does not interrupt a walk', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler, 1)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 150, y: 200 }, brawler, 1)
  simulator.addOrder(1, { id: 'move-1', seq: 1, tick: 1, type: 'move', target: { x: 700, y: 100 } })
  simulator.addOrder(1, { id: 'attack-2', seq: 2, tick: 3, type: 'attack', targetId: 2 })

  // The target is a teammate, so the order does nothing and the walk goes on.
  assertPositionClose(simulator.at(20).get(1)?.getPosition(), { x: 100 + SPEED * 19 / 60, y: 100 })
  assert.equal(simulator.at(20).get(1)?.getAttackTarget(), undefined)
})

test('an attack ordered while the last one is still on cooldown waits for it instead of walking off', () => {
  const simulator = createSimulator([
    { id: 'attack-1', seq: 1, tick: 1, type: 'attack', targetId: 2 },
    { id: 'attack-3', seq: 2, tick: 2, type: 'attack', targetId: 2 },
  ])

  assert.equal(simulator.at(1).get(1)?.getCooldown().ready, false)
  assert.equal(simulator.at(2).get(1)?.getCooldown().ticksRemaining, 59)
  // It stays put and swings the moment it is ready, rather than dropping the second order.
  assertPositionClose(simulator.at(40).get(1)?.getPosition(), { x: 100, y: 100 })
  assert.equal(simulator.at(40).get(2)?.getHealth(), 900)
  assert.equal(simulator.at(61).get(2)?.getHealth(), 800)
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
    base: { ...brawler.base, attackSpeed: GAME_TPS },
  }))
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 }, brawler)
  // One order: it attacks every tick (the attack speed is a swing a tick) until the target is dead.
  simulator.addOrder(1, { id: 'attack-1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  return simulator
}

test('a character left with no health dies on that tick, and the damage is credited to who did it', () => {
  const simulator = createKillSimulator()

  assert.equal(simulator.at(9).get(2)?.isDead(), false)
  const dead = simulator.at(10).get(2)
  assert.equal(dead?.getHealth(), 0)
  assert.equal(dead?.getDeathTick(), 10)
  assert.equal(dead?.isDead(), true)
  assert.deepEqual(simulator.at(10).deaths, [{ tick: 10, victimId: 2, killerId: 1 }])
  assert.deepEqual(simulator.at(11).deaths, [], 'and only once')
})

test('a dead character stops where it died, and orders for it or against it change nothing', () => {
  const simulator = createKillSimulator()
  simulator.addOrder(2, { id: 'move-late', seq: 1, tick: 13, type: 'move', target: { x: 700, y: 100 } })
  simulator.addOrder(1, { id: 'attack-late', seq: 13, tick: 16, type: 'attack', targetId: 2 })

  const dead = simulator.at(20).get(2)
  assert.equal(dead?.getDeathTick(), 10)
  assert.equal(dead?.isDead(), true)
  assert.equal(dead?.getHealth(), 0)
  assert.deepEqual(simulator.at(30).get(2)?.getPosition(), dead?.getPosition(), 'the move order for a ghost does nothing')
  // It swung every tick up to the lethal one, on tick 10, and then had no one left to attack: the late
  // order for a dead character changed nothing.
  assert.equal(simulator.at(20).get(1)?.getNextAttackTick(), 11)
  assert.equal(simulator.at(20).get(1)?.getAttackTarget(), undefined)
})

test('an attacker that dies stops going after its target, and does not go back to it when it respawns', () => {
  const simulator = createSimulator([{ id: 'attack-1', seq: 1, tick: 1, type: 'attack', targetId: 2 }])
  killAt(simulator, 1, 20)
  const respawn = 20 + GAME_RESPAWN_TICKS

  assert.equal(simulator.at(19).get(1)?.getAttackTarget(), 2)
  const hurtAtDeath = simulator.at(19).get(2)?.getHealth()
  assert.ok((hurtAtDeath ?? 1000) < 1000, 'it had been hitting its target')
  assert.equal(simulator.at(20).get(1)?.getAttackTarget(), undefined)
  assert.equal(simulator.at(respawn - 1).get(2)?.getHealth(), hurtAtDeath, 'nothing lands while it is dead')
  assert.equal(simulator.at(respawn).get(1)?.isDead(), false)
  assert.equal(simulator.at(respawn).get(1)?.getAttackTarget(), undefined)
  assert.equal(simulator.at(respawn + 120).get(2)?.getHealth(), hurtAtDeath, 'and it never swings again')
})

test('a dead character respawns at its start with full health when the respawn time is up', () => {
  const simulator = createKillSimulator()
  simulator.addOrder(2, { id: 'move-1', seq: 1, tick: 13, type: 'move', target: { x: 700, y: 100 } })
  const respawn = 10 + GAME_RESPAWN_TICKS

  assert.equal(simulator.at(respawn - 1).get(2)?.isDead(), true)
  const respawned = simulator.at(respawn).get(2)
  assert.equal(respawned?.isDead(), false)
  assert.equal(respawned?.getHealth(), 1000)
  assert.deepEqual(respawned?.getPosition(), { x: 140, y: 100 })
  assert.deepEqual(simulator.at(respawn + 2).get(2)?.getPosition(), { x: 140, y: 100 })
})

test('a death is confirmed, and its kill counted, only once the commit tick passes it', () => {
  const simulator = createKillSimulator()
  const confirmed: DeathRecord[] = []
  simulator.onDeathConfirmed = (death) => confirmed.push(death)
  simulator.advanceTo(15)

  simulator.setCommitTick(9)
  assert.deepEqual(confirmed, [], 'a late order could still save it')
  assert.equal(simulator.characters.get(1)?.kills, 0)

  simulator.setCommitTick(10)
  assert.deepEqual(confirmed, [{ tick: 10, victimId: 2, killerId: 1 }])
  assert.equal(simulator.characters.get(1)?.kills, 1)
  simulator.setCommitTick(15)
  assert.equal(confirmed.length, 1, 'told of once')
  assert.equal(simulator.characters.get(1)?.kills, 1)
  assert.equal(simulator.characters.get(2)?.kills, 0)
})

test('a death that a late order undoes is never confirmed', () => {
  const simulator = createKillSimulator()
  const confirmed: DeathRecord[] = []
  simulator.onDeathConfirmed = (death) => confirmed.push(death)
  assert.equal(simulator.at(12).get(2)?.isDead(), true, 'it looks dead for now')

  assert.equal(simulator.removeOrder(1, 1), true, 'the order that attacked it turns out never to have been given')
  simulator.advanceTo(30)
  simulator.setCommitTick(30)

  assert.equal(simulator.at(30).get(2)?.isDead(), false)
  assert.deepEqual(confirmed, [])
  assert.equal(simulator.characters.get(1)?.kills, 0)
})

test('snapshots carry the kills that can no longer be undone, and a checkpoint confirms the deaths up to it', () => {
  const server = createKillSimulator()
  server.advanceTo(15)
  server.setCommitTick(15)
  const snapshot = server.snapshot()
  assert.deepEqual(snapshot.characters.map(({ id, kills }) => [id, kills]), [[1, 1], [2, 0]])
  assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)

  // A client that has predicted the death but has not heard the commit tick reach it yet.
  const client = createKillSimulator()
  const confirmed: DeathRecord[] = []
  client.onDeathConfirmed = (death) => confirmed.push(death)
  client.advanceTo(15)
  assert.deepEqual(confirmed, [])

  client.replaceFromSnapshot(snapshot)
  assert.deepEqual(confirmed, [{ tick: 10, victimId: 2, killerId: 1 }])
  assert.equal(client.characters.get(1)?.kills, 1, 'the snapshot has the count, so it is not counted twice')
  assert.equal(client.at(15).get(2)?.isDead(), true, 'and the checkpoint holds the death')

  client.advanceTo(20)
  client.setCommitTick(20)
  assert.equal(confirmed.length, 1)
  assert.equal(client.characters.get(1)?.kills, 1)
  assert.equal(client.at(20).get(2)?.isDead(), true)
  assert.equal(client.at(10 + GAME_RESPAWN_TICKS).get(2)?.isDead(), false, 'it still respawns on time')
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

test('by default every character is on a team of its own, so everyone is an enemy of everyone', () => {
  const simulator = createSimulator([])
  const teams = [1, 2].map((id) => simulator.characters.get(id)?.team)

  assert.deepEqual(teams, [1, 2])
  assert.equal(simulator.characters.get(1)?.snapshot().team, 1)
})

test('teammates are as solid as anyone: the push that keeps characters apart does not care who is on whose side', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', { x: 500, y: 300 }, brawler, 1)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: 510, y: 300 }, brawler, 1)

  const gap = (tick: number): number => {
    const first = simulator.at(tick).get(1)?.getPosition()
    const second = simulator.at(tick).get(2)?.getPosition()
    return Math.hypot((second?.x ?? 0) - (first?.x ?? 0), (second?.y ?? 0) - (first?.y ?? 0))
  }
  // 10 apart is 26 deep, and the overlap shrinks by the same share each tick as for anyone.
  assert.ok(Math.abs(gap(1) - (REACH - (REACH - 10) * (1 - GAME_COLLISION_STIFFNESS))) < 1e-9)
  assert.ok(Math.abs(gap(60) - REACH) < 1e-9, 'and they settle just touching')
})

test('teams travel in a snapshot, so a client that joins late knows who is on whose side', () => {
  const original = new Simulator()
  original.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler, 3)
  original.addPlayer(2, 'player-2', 'Player 2', { x: 400, y: 100 }, brawler, 3)
  original.addPlayer(3, 'player-3', 'Player 3', { x: 700, y: 100 }, brawler, 5)
  original.advanceTo(10)
  original.setCommitTick(5)
  const snapshot = original.snapshot()

  assert.deepEqual(snapshot.characters.map((character) => character.team), [3, 3, 5])
  assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)
  const restored = new Simulator()
  restored.replaceFromSnapshot(snapshot)
  assert.deepEqual([1, 2, 3].map((id) => restored.characters.get(id)?.team), [3, 3, 5])

  // A snapshot that leaves a character's team out is not one a client should take.
  const withoutTeams = {
    ...snapshot,
    characters: snapshot.characters.map(({ team: _team, ...character }) => character),
  }
  assert.equal(GameSnapshotSchema.safeParse(withoutTeams).success, false)
})
