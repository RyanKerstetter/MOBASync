import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aimPoint,
  blink,
  GameSnapshotSchema,
  Simulator,
  Terrain,
  type CharacterOrder,
  type Rect,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { brawler, defineAbility, defineChampion, ninja, killAt } from './fixtures.ts'

// Walls hold champions out while they walk, and nothing else: dashes, blinks and abilities go over them.

const ARENA = { width: 1000, height: 600 }
const PILLAR: Rect = { x: 400, y: 200, width: 200, height: 200 }

const distanceToWall = (point: Vector2, wall: Rect): number =>
  Math.hypot(
    Math.max(wall.x - point.x, 0, point.x - (wall.x + wall.width)),
    Math.max(wall.y - point.y, 0, point.y - (wall.y + wall.height)),
  )
const touchesWall = (point: Vector2, radius: number, wall: Rect = PILLAR): boolean =>
  distanceToWall(point, wall) < radius - 1e-6

const hopper = (() => {
  defineAbility({
    id: 't-hop',
    targeting: 'point',
    range: 500,
    windUpTicks: 0,
    backswingTicks: 0,
    cooldownTicks: 60,
    apply: [blink(aimPoint())],
  })
  return defineChampion({
    id: 't-hopper',
    name: 'Test Hopper',
    base: { maxHp: 500, attackDamage: 10, attackSpeed: 1 },
    moveSpeed: 220,
    radius: 18,
    attackRange: 100,
    attackWindupTicks: 0,
    abilities: ['t-hop'],
  })
})()

function moveTo(seq: number, tick: number, target: Vector2): CharacterOrder {
  return { id: `p:${seq}`, seq, tick, type: 'move', target }
}

function castAt(seq: number, tick: number, abilityId: string, origin: Vector2, point: Vector2): CharacterOrder {
  return { id: `p:${seq}`, seq, tick, type: 'cast', abilityId, target: { mode: 'point', point }, origin }
}

function playOn(walls: Rect[] = [PILLAR]): Simulator {
  return new Simulator(new Terrain(ARENA, walls))
}

test('a champion sent to a point behind a pillar walks round it and arrives, never touching it', () => {
  const simulator = playOn()
  simulator.addPlayer(1, 'player-1', 'One', { x: 150, y: 300 }, brawler)
  const target = { x: 850, y: 300 }
  simulator.addOrder(1, moveTo(1, 1, target))

  let arrived = 0
  for (let tick = 1; tick <= 600 && !arrived; tick += 1) {
    const state = simulator.at(tick).get(1)
    assert.ok(state)
    assert.ok(!touchesWall(state.getPosition(), brawler.radius), `tick ${tick}: ${JSON.stringify(state.getPosition())} is in the pillar`)
    if (tick > 1 && !state.getMoveTarget()) arrived = tick
  }
  assert.ok(arrived, 'it got there')
  assert.deepEqual(simulator.at(arrived).get(1)?.getPosition(), target)
  // 700 straight is 191 ticks at 220 a second; going round the pillar is further, but not much.
  assert.ok(arrived > 191 && arrived < 191 * 1.25, `${arrived} ticks`)
})

test('the way round is the shorter side, and the champion keeps to it', () => {
  const simulator = playOn()
  simulator.addPlayer(1, 'player-1', 'One', { x: 150, y: 250 }, brawler)
  simulator.addPlayer(2, 'player-2', 'Two', { x: 150, y: 350 }, brawler)
  simulator.addOrder(1, moveTo(1, 1, { x: 850, y: 250 }))
  simulator.addOrder(2, moveTo(1, 1, { x: 850, y: 350 }))
  let highest = Infinity
  let lowest = -Infinity
  for (let tick = 1; tick <= 300; tick += 1) {
    highest = Math.min(highest, simulator.at(tick).get(1)?.getPosition().y ?? highest)
    lowest = Math.max(lowest, simulator.at(tick).get(2)?.getPosition().y ?? lowest)
  }
  assert.ok(highest < PILLAR.y, 'the one nearer the top goes over it')
  assert.ok(lowest > PILLAR.y + PILLAR.height, 'the one nearer the bottom goes under')
})

test('a click inside a pillar walks to the nearest place a champion can stand', () => {
  const simulator = playOn()
  simulator.addPlayer(1, 'player-1', 'One', { x: 150, y: 300 }, brawler)
  simulator.addOrder(1, moveTo(1, 1, { x: 500, y: 300 }))
  for (let tick = 1; tick <= 120; tick += 1) {
    assert.ok(!touchesWall(simulator.at(tick).get(1)?.getPosition() ?? PILLAR, brawler.radius))
  }
  assert.deepEqual(simulator.at(120).get(1)?.getPosition(), { x: 400 - brawler.radius, y: 300 })
  assert.equal(simulator.at(120).get(1)?.getMoveTarget(), undefined, 'and it stops there')
})

test('a champion that cannot get to where it was sent stays where it is', () => {
  // A box of walls with the target inside and the champion outside.
  const simulator = playOn([
    { x: 600, y: 200, width: 200, height: 20 },
    { x: 600, y: 380, width: 200, height: 20 },
    { x: 600, y: 200, width: 20, height: 200 },
    { x: 780, y: 200, width: 20, height: 200 },
  ])
  simulator.addPlayer(1, 'player-1', 'One', { x: 150, y: 300 }, brawler)
  simulator.addOrder(1, moveTo(1, 1, { x: 700, y: 300 }))
  assert.deepEqual(simulator.at(60).get(1)?.getPosition(), { x: 150, y: 300 })
  assert.equal(simulator.at(60).get(1)?.getMoveTarget(), undefined)
})

test('a champion chasing someone behind a pillar goes round it and attacks', () => {
  const simulator = playOn()
  simulator.addPlayer(1, 'player-1', 'One', { x: 150, y: 300 }, brawler)
  simulator.addPlayer(2, 'player-2', 'Two', { x: 850, y: 300 }, brawler)
  simulator.addOrder(1, { id: 'p:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  let hurt = 0
  for (let tick = 1; tick <= 500 && !hurt; tick += 1) {
    const frame = simulator.at(tick)
    assert.ok(!touchesWall(frame.get(1)?.getPosition() ?? PILLAR, brawler.radius), `tick ${tick}: in the pillar`)
    if ((frame.get(2)?.getHealth() ?? 1000) < 1000) hurt = tick
  }
  assert.ok(hurt, 'the attack landed')
})

test('over a wall is in range: a champion within reach of its target attacks it without going round', () => {
  // A thin wall, with the two of them 30 from it on each side, so 80 apart across it.
  const simulator = playOn([{ x: 400, y: 100, width: 20, height: 400 }])
  simulator.addPlayer(1, 'player-1', 'One', { x: 370, y: 300 }, brawler)
  simulator.addPlayer(2, 'player-2', 'Two', { x: 450, y: 300 }, brawler)
  simulator.addOrder(1, { id: 'p:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  assert.deepEqual(simulator.at(5).get(1)?.getPosition(), { x: 370, y: 300 }, 'it did not move')
  assert.ok((simulator.at(5).get(2)?.getHealth() ?? 1000) < 1000, 'and it hit')
})

test('a dash goes over a wall and lands past it, and is inside the wall on the way', () => {
  const simulator = playOn()
  simulator.addPlayer(1, 'player-1', 'One', { x: 350, y: 300 }, ninja)
  simulator.addOrder(1, castAt(1, 1, 't-shadowstep', { x: 350, y: 300 }, { x: 650, y: 300 }))
  let inside = false
  for (let tick = 1; tick <= 20; tick += 1) {
    if (touchesWall(simulator.at(tick).get(1)?.getPosition() ?? { x: 0, y: 0 }, ninja.radius)) inside = true
  }
  assert.ok(inside, 'it passed over the pillar, so it was in it for a while')
  assert.equal(simulator.at(20).get(1)?.isDashing(), false)
  assert.deepEqual(simulator.at(20).get(1)?.getPosition(), { x: 650, y: 300 })
})

test('a dash that would end inside a wall ends at the nearest place the champion can stand', () => {
  const simulator = playOn()
  simulator.addPlayer(1, 'player-1', 'One', { x: 300, y: 300 }, ninja)
  // 300 along from x = 300 is x = 600, the pillar's far face, so the champion stands just past it.
  simulator.addOrder(1, castAt(1, 1, 't-shadowstep', { x: 300, y: 300 }, { x: 600, y: 300 }))
  assert.deepEqual(simulator.at(20).get(1)?.getPosition(), { x: 600 + ninja.radius, y: 300 })
  assert.ok(!touchesWall(simulator.at(20).get(1)?.getPosition() ?? PILLAR, ninja.radius))
  // And it stays there.
  assert.deepEqual(simulator.at(40).get(1)?.getPosition(), { x: 600 + ninja.radius, y: 300 })
})

test('a blink goes over a wall, and one aimed into a wall lands outside it', () => {
  const simulator = playOn()
  simulator.addPlayer(1, 'player-1', 'One', { x: 330, y: 300 }, hopper)
  simulator.addOrder(1, castAt(1, 1, 't-hop', { x: 330, y: 300 }, { x: 700, y: 300 }))
  assert.deepEqual(simulator.at(3).get(1)?.getPosition(), { x: 700, y: 300 }, 'over the pillar in one tick')

  const into = playOn()
  into.addPlayer(1, 'player-1', 'One', { x: 330, y: 300 }, hopper)
  into.addOrder(1, castAt(1, 1, 't-hop', { x: 330, y: 300 }, { x: 450, y: 300 }))
  assert.deepEqual(into.at(3).get(1)?.getPosition(), { x: 400 - hopper.radius, y: 300 })
})

// Two walls that meet along x = 400: a seam, which a champion put on it cannot leave one wall for without going into the other.
const SEAM: Rect[] = [{ x: 300, y: 200, width: 100, height: 200 }, { x: 400, y: 200, width: 100, height: 200 }]
const clearOfWalls = (point: Vector2, radius: number, walls: Rect[]): boolean => walls.every((wall) => !touchesWall(point, radius, wall))

test('a dash that ends on a seam between two walls lands clear of both, and the champion can walk away', () => {
  const simulator = playOn(SEAM)
  simulator.addPlayer(1, 'player-1', 'One', { x: 100, y: 300 }, ninja)
  simulator.addOrder(1, castAt(1, 1, 't-shadowstep', { x: 100, y: 300 }, { x: 400, y: 300 }))
  const landed = simulator.at(30).get(1)?.getPosition() ?? SEAM[0]
  assert.equal(simulator.at(30).get(1)?.isDashing(), false)
  assert.ok(clearOfWalls(landed, ninja.radius, SEAM), `landed at ${JSON.stringify(landed)}, in a wall`)
  assert.deepEqual(simulator.at(60).get(1)?.getPosition(), landed, 'and stays there, and is not pushed back and forth')
  // It is not stuck: an order to walk somewhere gets it there.
  simulator.addOrder(1, moveTo(2, 61, { x: 150, y: 500 }))
  assert.deepEqual(simulator.at(400).get(1)?.getPosition(), { x: 150, y: 500 })
})

test('a blink that lands on a seam between two walls lands clear of both', () => {
  const simulator = playOn(SEAM)
  simulator.addPlayer(1, 'player-1', 'One', { x: 150, y: 300 }, hopper)
  simulator.addOrder(1, castAt(1, 1, 't-hop', { x: 150, y: 300 }, { x: 400, y: 300 }))
  const landed = simulator.at(5).get(1)?.getPosition() ?? SEAM[0]
  assert.ok(clearOfWalls(landed, hopper.radius, SEAM), `landed at ${JSON.stringify(landed)}, in a wall`)
  simulator.addOrder(1, moveTo(2, 10, { x: 150, y: 500 }))
  assert.deepEqual(simulator.at(400).get(1)?.getPosition(), { x: 150, y: 500 }, 'and it can walk away')
})

test('a click on a seam between two walls is not lost: the champion walks to the nearest place it can stand', () => {
  for (const from of [{ x: 150, y: 300 }, { x: 700, y: 300 }]) {
    const simulator = playOn(SEAM)
    simulator.addPlayer(1, 'player-1', 'One', from, brawler)
    simulator.addOrder(1, moveTo(1, 1, { x: 400, y: 300 }))
    const there = simulator.at(600).get(1)
    assert.ok(there, 'it is in the game')
    assert.ok(Math.hypot(there.getPosition().x - from.x, there.getPosition().y - from.y) > 100, `it went somewhere from ${JSON.stringify(from)}`)
    assert.ok(clearOfWalls(there.getPosition(), brawler.radius, SEAM), 'clear of both walls')
    assert.equal(there.getMoveTarget(), undefined, 'and it has arrived')
  }
})

test('characters pushed against a wall by each other are held out of it', () => {
  const simulator = playOn()
  // One touching the wall, and one standing on it from the side: they overlap by 6.
  simulator.addPlayer(1, 'player-1', 'One', { x: 400 - brawler.radius, y: 300 }, brawler)
  simulator.addPlayer(2, 'player-2', 'Two', { x: 400 - brawler.radius - 30, y: 300 }, brawler)
  for (let tick = 1; tick <= 20; tick += 1) {
    const frame = simulator.at(tick)
    for (const id of [1, 2]) {
      assert.ok(!touchesWall(frame.get(id)?.getPosition() ?? PILLAR, brawler.radius), `tick ${tick}: ${id} is in the wall`)
    }
  }
  const one = simulator.at(20).get(1)?.getPosition()
  const two = simulator.at(20).get(2)?.getPosition()
  assert.ok(one && two)
  assert.ok(one.x <= 400 - brawler.radius + 1e-6, 'the one at the wall stayed out')
  assert.ok(Math.hypot(one.x - two.x, one.y - two.y) >= 2 * brawler.radius - 1, 'and the other was pushed off it')
})

test('a champion that dies against a wall comes back where it started, and walks round the wall from there', () => {
  const simulator = playOn()
  const start = { x: 400 - brawler.radius, y: 300 }
  simulator.addPlayer(1, 'player-1', 'One', start, brawler)
  assert.deepEqual(simulator.at(0).get(1)?.getPosition(), start, 'touching the wall is a place to stand')
  killAt(simulator, 1, 10)
  simulator.addOrder(1, moveTo(1, 200, { x: 850, y: 300 }))
  assert.deepEqual(simulator.at(190).get(1)?.getPosition(), start)
  for (let tick = 190; tick <= 400; tick += 1) {
    assert.ok(!touchesWall(simulator.at(tick).get(1)?.getPosition() ?? PILLAR, brawler.radius), `tick ${tick}`)
  }
  assert.deepEqual(simulator.at(400).get(1)?.getPosition(), { x: 850, y: 300 })
})

test('a late order recomputes the same frames as one that was there in time', () => {
  const orders = [moveTo(1, 1, { x: 850, y: 300 }), moveTo(2, 45, { x: 850, y: 500 }), moveTo(3, 50, { x: 100, y: 100 })]
  const inTime = playOn()
  inTime.addPlayer(1, 'player-1', 'One', { x: 150, y: 300 }, brawler)
  for (const order of orders) inTime.addOrder(1, order)

  const late = playOn()
  late.addPlayer(1, 'player-1', 'One', { x: 150, y: 300 }, brawler)
  late.addOrder(1, orders[0])
  late.at(55)
  // The second and third orders arrive after the frames after them have been computed.
  assert.equal(late.addOrder(1, orders[2]), true)
  assert.equal(late.addOrder(1, orders[1]), true)

  for (const tick of [55, 70, 120, 200, 300]) {
    assert.deepEqual(late.at(tick).get(1)?.getPosition(), inTime.at(tick).get(1)?.getPosition(), `tick ${tick}`)
  }
})

test('a snapshot brings the terrain with it, so a client walks round the same walls as the server', () => {
  const server = playOn()
  server.addPlayer(1, 'player-1', 'One', { x: 150, y: 300 }, brawler)
  server.addOrder(1, moveTo(1, 1, { x: 850, y: 300 }))
  server.advanceTo(30)
  server.setCommitTick(20)
  const snapshot = JSON.parse(JSON.stringify(server.snapshot()))
  assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true)

  const client = new Simulator()
  assert.equal(client.terrain.walls.length, 0, 'it starts on the plain arena')
  client.replaceFromSnapshot(snapshot)
  assert.deepEqual(client.terrain.toData(), server.terrain.toData())
  for (const tick of [30, 60, 120, 200, 260]) {
    assert.deepEqual(client.at(tick).get(1)?.getPosition(), server.at(tick).get(1)?.getPosition(), `tick ${tick}`)
  }

  // A later snapshot of the same terrain keeps the one it has (and what it worked out for it).
  const kept = client.terrain
  client.replaceFromSnapshot(snapshot)
  assert.equal(client.terrain, kept)
  // And one with no terrain is on the plain arena.
  const { terrain: _terrain, ...plain } = snapshot
  client.replaceFromSnapshot(plain)
  assert.equal(client.terrain, Terrain.plain())
})

test('a wall out of the way changes nothing for anyone who is not near it', () => {
  const walled = new Simulator(new Terrain(ARENA, [{ x: 0, y: 0, width: 1, height: 1 }]))
  const open = new Simulator(new Terrain(ARENA))
  for (const simulator of [walled, open]) {
    simulator.addPlayer(1, 'player-1', 'One', { x: 150, y: 300 }, brawler)
    simulator.addPlayer(2, 'player-2', 'Two', { x: 850, y: 320 }, brawler)
    simulator.addOrder(1, moveTo(1, 1, { x: 800, y: 330 }))
    simulator.addOrder(2, moveTo(1, 1, { x: 100, y: 280 }))
  }
  for (const tick of [10, 60, 120, 200]) {
    assert.deepEqual(walled.at(tick).get(1)?.getPosition(), open.at(tick).get(1)?.getPosition())
    assert.deepEqual(walled.at(tick).get(2)?.getPosition(), open.at(tick).get(2)?.getPosition())
  }
})
