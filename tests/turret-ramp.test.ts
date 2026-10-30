import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutStackPips } from '../apps/client/src/render/stack-pips.ts'
import {
  GAME_TPS,
  GameSnapshotSchema,
  getCore,
  getTurret,
  rampMultiplier,
  rampStacks,
  Simulator,
  Turret,
  TURRET_RAMP,
  TURRET_RAMP_GRACE_TICKS,
  TURRET_RAMP_KEY,
  TURRET_TIERS,
  turretTiers,
  type TurretRamp,
  type TurretTierDef,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineChampion, defineTurret } from './fixtures.ts'

// A turret's ramp (see turret-ramp.ts): every shot at the same target does `step` more of the first one's damage, up to `max` times it. It is a stack of
// markers on the target, so it is forgotten once the target has been out of reach for a while, a new target starts from the first shot, and each turret ramps
// on its own. The turrets and the champions in these are the tests' own, with every number spelled out; the ramp and the damage of the ones the game plays
// with are only read.

const RAMP: TurretRamp = { step: 0.25, max: 2 }
const GUN = 40
const AT = { x: 1000, y: 700 }
const TURRET = 10
const TARGET = 2
const OTHER = 3

const body = { base: { maxHp: 5000, attackDamage: GUN, attackSpeed: 1 }, radius: 30, attackRange: 400, attackWindup: 0 }
const flat = defineTurret(80, body)
const ramping = defineTurret(81, { ...body, ramp: RAMP })
// Hits four times as hard, so which turret did a thing can be told by what it did.
const heavy = defineTurret(82, { ...body, base: { ...body.base, attackDamage: 4 * GUN }, ramp: RAMP })
const prey = defineChampion({
  id: 't-tr-prey', name: 'Prey', base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 }, moveSpeed: 300, radius: 20, attackRange: 50, attackWindup: 0, abilities: [],
})

const SHOT = ramping.champion.attackCooldownTicks
const STACKS = rampStacks(RAMP)
const first = (amount: number, n: number): number => Math.round(amount * rampMultiplier(RAMP, n))

function world(turret: Turret = ramping, at: Vector2 = { x: AT.x + 200, y: AT.y }): Simulator {
  const simulator = new Simulator()
  simulator.addTurret(TURRET, turret, AT, 1)
  simulator.addPlayer(TARGET, 'p2', 'Prey', at, prey, 2)
  return simulator
}
const walk = (id: number, tick: number, to: Vector2) => ({ id: `walk${id}:${tick}`, seq: tick, tick, type: 'move' as const, target: to })

type Hit = { tick: number; amount: number }
// When the character lost health, and by how much, over ticks 1 to `last`, in one pass forward (the simulator keeps only the last few frames). `look` is
// called with each tick while its frame is held.
function hitsOn(simulator: Simulator, id: number, last: number, look: (tick: number) => void = () => undefined): Hit[] {
  const found: Hit[] = []
  let before = simulator.at(0).get(id)?.getHealth() ?? 0
  for (let tick = 1; tick <= last; tick += 1) {
    simulator.advanceTo(tick)
    const now = simulator.at(tick).get(id)?.getHealth() ?? 0
    if (now < before) found.push({ tick, amount: before - now })
    before = now
    look(tick)
  }
  return found
}
const stacksOn = (simulator: Simulator, tick: number, id: number, owner: number): number =>
  simulator.at(tick).get(id)?.getMarkers().filter((marker) => marker.key === TURRET_RAMP_KEY && marker.ownerId === owner).length ?? 0

// ---------------------------------------------------------------------------- the ramp

test('a shot does its damage times 1 when no shot came before it, and each shot before it adds a step, up to the most', () => {
  assert.equal(rampMultiplier(RAMP, 0), 1, 'the first shot is its plain damage')
  assert.equal(rampMultiplier(RAMP, 1), 1 + RAMP.step)
  assert.equal(rampMultiplier(RAMP, 2), 1 + 2 * RAMP.step)
  assert.equal(rampMultiplier(RAMP, 1000), RAMP.max, 'and no more than the most')
  assert.equal(rampMultiplier(RAMP, -3), 1, 'nothing before the first')
  // A most that is not a whole number of steps is reached by the last, which does not go over.
  const uneven: TurretRamp = { step: 0.3, max: 2 }
  assert.equal(rampStacks(uneven), 4)
  assert.equal(rampMultiplier(uneven, 4), uneven.max)
  assert.equal(rampStacks(RAMP), (RAMP.max - 1) / RAMP.step, 'a stack as big as the steps to the most')
  assert.equal(rampStacks({ step: 0.5, max: 1 }), 0, 'a most of 1 is no ramp')
})

test('the ramp the turrets of the game have starts at 1x, goes up by its step each shot, and ends at its most', () => {
  assert.equal(rampMultiplier(TURRET_RAMP, 0), 1)
  const size = rampStacks(TURRET_RAMP)
  assert.ok(size >= 1, 'there is a ramp')
  for (let shots = 1; shots <= size; shots += 1) {
    assert.ok(rampMultiplier(TURRET_RAMP, shots) > rampMultiplier(TURRET_RAMP, shots - 1), `shot ${shots + 1} does more than shot ${shots}`)
  }
  assert.equal(rampMultiplier(TURRET_RAMP, size), TURRET_RAMP.max, 'it reaches its most on the last')
  assert.equal(rampMultiplier(TURRET_RAMP, size + 5), TURRET_RAMP.max, 'and stays there')
})

test('a ramp that cannot work is refused, and says which part', () => {
  const tier = (ramp: TurretRamp): TurretTierDef => ({ ...body, ramp })
  for (const step of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new Turret(98, tier({ step, max: 2 })), /Turret tier 98 needs a ramp with a step that is more than 0/, String(step))
  }
  for (const max of [0.5, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new Turret(98, tier({ step: 0.5, max })), /Turret tier 98 needs a ramp with a most that is 1 or more/, String(max))
  }
  assert.doesNotThrow(() => new Turret(98, tier({ step: 0.5, max: 1 })), 'a most of 1 is fine: it is only no ramp')
  assert.throws(() => new Turret(98, { ...tier({ step: 0, max: 2 }), core: true }), /Turret tier 98 needs a ramp with a step that is more than 0/, 'and a core\'s is read the same')
  assert.equal(flat.ramp, undefined)
  assert.deepEqual({ ...(ramping.ramp ?? {}) }, RAMP)
})

// ---------------------------------------------------------------------------- shooting

test('a turret that ramps hits the same target harder with each shot, by the ramp, until the most, and then at the most every time', () => {
  const simulator = world()
  const shots = STACKS + 3
  // The first shot is on the first tick, so this many fit in one interval fewer than their number, and a little over.
  const found = hitsOn(simulator, TARGET, (shots - 1) * SHOT + 10)
  assert.equal(found.length, shots, 'one shot a cooldown')
  assert.deepEqual(found.map((hit) => hit.amount), Array.from({ length: shots }, (_, index) => first(GUN, index)))
  assert.equal(found[0].amount, GUN, 'the first is its damage')
  assert.equal(found[found.length - 1].amount, Math.round(GUN * RAMP.max), 'and the last is at the most')
  assert.deepEqual(found.slice(1).map((hit, index) => hit.tick - found[index].tick), found.slice(1).map(() => SHOT), 'at the same rate as ever')
})

test('a turret that does not ramp hits for the same each time', () => {
  const found = hitsOn(world(flat), TARGET, 4 * SHOT + 10)
  assert.equal(found.length, 5)
  assert.ok(found.every((hit) => hit.amount === GUN), `${found.map((hit) => hit.amount)}`)
})

test('the target carries a stack of the ramp for each shot, as the turret\'s marks, up to the most, and no more', () => {
  const simulator = world()
  const counts: number[] = []
  let health = prey.maxHp
  const last = (STACKS + 2) * SHOT + 10
  hitsOn(simulator, TARGET, last, (tick) => {
    const now = simulator.at(tick).get(TARGET)?.getHealth() ?? 0
    // The stacks as they stand on the tick of each shot.
    if (now < health) counts.push(stacksOn(simulator, tick, TARGET, TURRET))
    health = now
  })
  assert.equal(counts.length, STACKS + 3)
  assert.deepEqual(counts.slice(0, STACKS), Array.from({ length: STACKS }, (_, index) => index + 1), 'a stack for each shot at first')
  assert.ok(counts.slice(STACKS).every((count) => count === STACKS), 'it fills, and no more')
  assert.equal(stacksOn(simulator, last, TARGET, TURRET + 1), 0, 'and they are the turret\'s own: none are another\'s')
})

// ---------------------------------------------------------------------------- who it remembers

// The target walks out of reach after its third shot, and back after `away` ticks, and the first shot after it is back is the one to look at.
function afterReturn(away: number, outTo: number): { before: number; after: number } {
  const shotsBefore = 3
  const simulator = world()
  const leaveAt = 1 + (shotsBefore - 1) * SHOT + 5
  simulator.addOrder(TARGET, walk(TARGET, leaveAt, { x: outTo, y: AT.y }))
  simulator.addOrder(TARGET, walk(TARGET, leaveAt + away, { x: AT.x + 200, y: AT.y }))
  const found = hitsOn(simulator, TARGET, leaveAt + away + 2 * SHOT + 400)
  const last = found.filter((hit) => hit.tick < leaveAt)
  assert.equal(last.length, shotsBefore, 'it was shot three times before it went')
  const back = found.find((hit) => hit.tick > leaveAt + away)
  assert.ok(back, 'and was shot again when it was back')
  return { before: last[last.length - 1].amount, after: (back as Hit).amount }
}

test('a target that steps out of reach for a moment and comes back keeps the ramp it had', () => {
  const { before, after } = afterReturn(60, AT.x + 450)
  assert.equal(before, first(GUN, 2))
  assert.equal(after, first(GUN, 3), 'the next shot goes on from where it was')
})

test('a target that is gone for longer than the turret remembers it is started again from the first shot', () => {
  // Out of reach for far longer than a shot's interval and the grace after it.
  const { before, after } = afterReturn(SHOT + TURRET_RAMP_GRACE_TICKS + 400, 2300)
  assert.equal(before, first(GUN, 2))
  assert.equal(after, GUN, 'back to its plain damage')
})

test('when it turns to a new target the new one is hit from the first shot, whatever the old one had', () => {
  const simulator = new Simulator()
  simulator.addTurret(TURRET, ramping, AT, 1)
  // The nearer is shot first. The other is in reach too, on the other side of the turret.
  simulator.addPlayer(TARGET, 'p2', 'Near', { x: AT.x + 150, y: AT.y }, prey, 2)
  simulator.addPlayer(OTHER, 'p3', 'Far', { x: AT.x - 300, y: AT.y }, prey, 3)
  const leaveAt = 1 + 2 * SHOT + 5
  simulator.addOrder(TARGET, walk(TARGET, leaveAt, { x: 2300, y: AT.y }))
  const nearHits: Hit[] = []
  const farHits: Hit[] = []
  const healths = new Map<number, number>([[TARGET, prey.maxHp], [OTHER, prey.maxHp]])
  for (let tick = 1; tick <= leaveAt + 4 * SHOT; tick += 1) {
    simulator.advanceTo(tick)
    for (const [id, list] of [[TARGET, nearHits], [OTHER, farHits]] as const) {
      const now = simulator.at(tick).get(id)?.getHealth() ?? 0
      if (now < (healths.get(id) as number)) list.push({ tick, amount: (healths.get(id) as number) - now })
      healths.set(id, now)
    }
  }
  assert.deepEqual(nearHits.map((hit) => hit.amount), [first(GUN, 0), first(GUN, 1), first(GUN, 2)], 'the near one had three, and was left')
  assert.ok(farHits.length >= 2, 'then the other was shot')
  assert.equal(farHits[0].amount, GUN, 'from the first shot, whatever the near one had')
  assert.equal(farHits[1].amount, first(GUN, 1), 'and ramps on its own')
  assert.ok(farHits[0].tick > nearHits[nearHits.length - 1].tick)
})

test('each turret has its own ramp on a target: one that joins in begins at its first shot while the other goes on', () => {
  const simulator = new Simulator()
  // The one at AT reaches the target from the start. The other reaches it only once it has walked closer to it.
  simulator.addTurret(TURRET, ramping, AT, 1)
  simulator.addTurret(11, heavy, { x: AT.x + 700, y: AT.y }, 1)
  simulator.addPlayer(TARGET, 'p2', 'Prey', { x: AT.x + 250, y: AT.y }, prey, 2)
  const walkAt = 1 + 3 * SHOT
  simulator.addOrder(TARGET, walk(TARGET, walkAt, { x: AT.x + 350, y: AT.y }))
  const heavyAdds: number[] = []
  let previous = 0
  const firstSeen: Array<{ tick: number; mine: number; heavy: number }> = []
  hitsOn(simulator, TARGET, walkAt + 3 * SHOT, (tick) => {
    const mine = stacksOn(simulator, tick, TARGET, TURRET)
    const theirs = stacksOn(simulator, tick, TARGET, 11)
    if (theirs > previous) heavyAdds.push(tick)
    previous = theirs
    if (theirs === 1 && firstSeen.length === 0) firstSeen.push({ tick, mine, heavy: theirs })
  })
  assert.ok(heavyAdds.length >= 1, 'the second turret began to shoot')
  assert.ok(firstSeen[0].tick > walkAt, 'once the target had come closer')
  assert.ok(firstSeen[0].mine >= 3, `the first turret was already at ${firstSeen[0].mine} stacks`)
  assert.equal(firstSeen[0].heavy, 1, 'while the second had just one, its first shot')
})

// ---------------------------------------------------------------------------- the game's own

test('every turret tier of the game and its core ramp, and hit by it: each shot is its damage times the multiplier of the shots before it', () => {
  const shooters: Array<{ name: string; ramp: TurretRamp | undefined; damage: number; interval: number; add: (simulator: Simulator) => void }> = [
    ...turretTiers().filter((tier) => tier in TURRET_TIERS).map((tier) => {
      const turret = getTurret(tier)
      return { name: turret.name, ramp: turret.ramp, damage: turret.champion.attackDamage, interval: turret.champion.attackCooldownTicks, add: (simulator: Simulator) => { simulator.addTurret(TURRET, turret, AT, 1) } }
    }),
    (() => {
      const core = getCore()
      return { name: 'the core', ramp: core.ramp, damage: core.champion.attackDamage, interval: core.champion.attackCooldownTicks, add: (simulator: Simulator) => { simulator.addTurret(TURRET, core, AT, 1) } }
    })(),
  ]
  assert.ok(shooters.length >= 2, 'a turret and a core')
  for (const shooter of shooters) {
    assert.ok(shooter.ramp, `${shooter.name} ramps`)
    const ramp = shooter.ramp as TurretRamp
    const simulator = new Simulator()
    shooter.add(simulator)
    // Close enough to be in reach whatever its range is.
    simulator.addPlayer(TARGET, 'p2', 'Prey', { x: AT.x + 150, y: AT.y }, prey, 2)
    const shots = rampStacks(ramp) + 3
    // A shot takes a while to arrive, if it flies, and each lands one interval after the one before.
    const found = hitsOn(simulator, TARGET, (shots + 2) * shooter.interval + 200)
    assert.ok(found.length >= shots, `${shooter.name} shot ${found.length} times`)
    assert.deepEqual(
      found.slice(0, shots).map((hit) => hit.amount),
      Array.from({ length: shots }, (_, index) => Math.round(shooter.damage * rampMultiplier(ramp, index))),
      shooter.name,
    )
  }
})

// ---------------------------------------------------------------------------- the same on every peer

test('a late order that is worked out again, and a snapshot taken in the middle of a ramp, give the same frames as a game that was straight', () => {
  const frameAt = (simulator: Simulator, tick: number): unknown => JSON.parse(JSON.stringify(simulator.at(tick).toData()))
  const leaveAt = 1 + 2 * SHOT + 5
  const goes = walk(TARGET, leaveAt, { x: AT.x + 450, y: AT.y })
  const comes = walk(TARGET, leaveAt + 60, { x: AT.x + 200, y: AT.y })
  const check = leaveAt + 4 * SHOT
  const straight = world()
  straight.addOrder(TARGET, goes)
  straight.addOrder(TARGET, comes)
  straight.advanceTo(check)
  const expected = frameAt(straight, check)

  const redone = world()
  redone.addOrder(TARGET, goes)
  redone.advanceTo(leaveAt + 70)
  assert.equal(redone.addOrder(TARGET, comes), true, 'an order for a tick already worked out')
  redone.advanceTo(check)
  assert.deepEqual(frameAt(redone, check), expected)

  const original = world()
  original.addOrder(TARGET, goes)
  original.addOrder(TARGET, comes)
  original.advanceTo(leaveAt - 3)
  original.setCommitTick(leaveAt - 13)
  const snapshot = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(original.snapshot())))
  assert.ok(snapshot.checkpoint.characters.some((character) => character.markers.some((marker) => marker.key === TURRET_RAMP_KEY)), 'the ramp is in the checkpoint')
  const joined = new Simulator()
  joined.replaceFromSnapshot(snapshot)
  joined.advanceTo(check)
  assert.deepEqual(frameAt(joined, check), expected)
})

// ---------------------------------------------------------------------------- on the page

test('the stacks of the ramp are shown under whoever carries them as marks, in a colour of their own', () => {
  const radius = 20
  const pips = layoutStackPips({ [TURRET_RAMP_KEY]: 4 }, radius)
  assert.equal(pips.length, 4)
  assert.ok(pips.every((pip) => pip.shape === 'diamond'), 'a mark someone else put on them')
  const color = pips[0].color
  assert.ok(pips.every((pip) => pip.color === color))
  for (const other of ['curse', 'gale', 'sighted', 'trick', 'sword', 'empowered', 'shadow']) {
    assert.notEqual(layoutStackPips({ [other]: 1 }, radius)[0].color, color, `not the colour of ${other}`)
  }
})

test('the game\'s ticks are what the ramp\'s memory is made of: a shot\'s interval and a grace', () => {
  assert.ok(Number.isInteger(TURRET_RAMP_GRACE_TICKS) && TURRET_RAMP_GRACE_TICKS > 0)
  assert.equal(SHOT, Math.ceil(GAME_TPS / ramping.champion.attackSpeed), 'the interval a turret remembers is its own')
})
