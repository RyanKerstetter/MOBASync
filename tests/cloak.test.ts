import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState, type RenderedCharacter } from '../apps/client/src/game-state.ts'
import { championSprites } from '../apps/client/src/champion-sprites.ts'
import { CharacterLayer, INVISIBLE_ALPHA } from '../apps/client/src/render/character-layer.ts'
import { Container, type Graphics } from 'pixi.js'
import { IndicatorLayer } from '../apps/client/src/render/indicator-layer.ts'
import { layoutStackPips } from '../apps/client/src/render/stack-pips.ts'
import { WorldRenderer } from '../apps/client/src/render/world-renderer.ts'
import { TeamVision } from '../apps/client/src/team-vision.ts'
import {
  abilityDefs,
  Champion,
  GAME_MAX_CHAMPION_RADIUS,
  GAME_TPS,
  GameSnapshotSchema,
  getChampion,
  getEntityDef,
  haste,
  self,
  Simulator,
  type CastTarget,
  walkingSpeed,
  type CharacterOrder,
  type GameTickSnapshot,
  type VisionMask,
  type VisionSystem,
  type Vector2,
} from '../packages/shared/src/index.ts'
import {
  CUT_DAMAGE,
  CUT_RANGE,
  CUT_REFUND,
  CUT_SCALING,
  FEAR_BONUS,
  FEAR_KEY,
  FEAR_MEMORY_TICKS,
  FEAR_RADIUS,
  FEAR_TICKS,
  GHOST_HASTE,
  GHOST_TICKS,
  KNIVES_CONE,
  KNIVES_DAMAGE,
  KNIVES_HALF_ANGLE,
  KNIVES_RANGE,
  KNIVES_SCALING,
} from '../packages/shared/src/abilities.ts'
import { getDashDef } from '../packages/shared/src/effects.ts'
import { defineAbility, defineMonster, defineTurret } from './fixtures.ts'

// Cloak's kit, played out in the simulator: the invisibility and the fear it ends in, the damage that does more to what he has feared, the cooldowns that kills reset and fears
// and dashes give back, the fan of knives and the dash. The numbers come from the exported constants and the definitions, so retuning the kit does not break these; what they
// check is how it is meant to play.

const HOME: Vector2 = { x: 400, y: 600 }
const R = GAME_MAX_CHAMPION_RADIUS
const cloak = getChampion('cloak')
// Something to hit that stands there and takes it however long the fight goes: a body of the widest size, with health to spare, and no abilities. It is the test's own, and is
// not in the roster.
const bag = new Champion({
  id: 't-cloak-bag',
  name: 'Test Bag',
  base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 140,
  radius: R,
  attackRange: 50,
  attackWindup: 0,
  abilities: [],
})
const within: Vector2 = { x: HOME.x + cloak.attackRange - 10, y: HOME.y }

let sequence = 0
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })
const cast = (tick: number, abilityId: string, target: CastTarget, origin: Vector2 = HOME): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target, origin: { ...origin } })
const none: CastTarget = { mode: 'none' }
const east: CastTarget = { mode: 'direction', dir: { x: 1, y: 0 } }
const west: CastTarget = { mode: 'direction', dir: { x: -1, y: 0 } }
const at = (unitId: number): CastTarget => ({ mode: 'unit', unitId })

// Cloak is character 1, and each of the others is on a team of its own, so an enemy.
type Other = Vector2 | { at: Vector2; who: Champion }
function scene(others: readonly Other[]): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, cloak)
  others.forEach((other, index) => {
    const { at: where, who } = 'who' in other ? other : { at: other, who: bag }
    simulator.addPlayer(index + 2, `p${index + 2}`, `Other ${index + 2}`, where, who)
  })
  return simulator
}

const hp = (frame: GameTickSnapshot, id: number): number => frame.get(id)?.getHealth() ?? 0
const status = (frame: GameTickSnapshot, id: number, kind: string) => frame.get(id)?.getStatuses().find((each) => each.kind === kind)
const marks = (frame: GameTickSnapshot, id: number, key: string) => frame.get(id)?.getMarkers().filter((marker) => marker.key === key) ?? []
const where = (frame: GameTickSnapshot, id: number): Vector2 => frame.get(id)?.getPosition() ?? HOME
const distance = (left: Vector2, right: Vector2): number => Math.hypot(left.x - right.x, left.y - right.y)
const polar = (reach: number, angle: number): Vector2 => ({ x: HOME.x + reach * Math.cos(angle), y: HOME.y + reach * Math.sin(angle) })
const ghost = abilityDefs.get('ghost')
const knives = abilityDefs.get('knives')
const cut = abilityDefs.get('cutthrough')
const knivesDamage = KNIVES_DAMAGE + (KNIVES_SCALING.attackDamage ?? 0) * cloak.attackDamage
const cutDamage = CUT_DAMAGE + (CUT_SCALING.attackDamage ?? 0) * cloak.attackDamage

// ---------------------------------------------------------------------------- Ghost

test('ghost makes cloak invisible and faster for as long as it says, and casting it does not show him', () => {
  assert.ok(ghost)
  const simulator = scene([])
  simulator.addOrder(1, cast(1, 'ghost', none))
  const cast1 = simulator.at(1)
  const hidden = status(cast1, 1, 'invisible')
  assert.equal(hidden && hidden.endTick - hidden.startTick, GHOST_TICKS)
  assert.equal(status(cast1, 1, 'haste')?.amount, GHOST_HASTE)
  assert.ok(status(simulator.at(GHOST_TICKS), 1, 'invisible'), 'still invisible the tick before it ends')
  assert.equal(status(simulator.at(1 + GHOST_TICKS), 1, 'invisible'), undefined, 'and not when it ends')
})

test('an enemy cannot attack or aim at an invisible champion, but what lands on the ground still hits him', () => {
  // An enemy that attacks him: the order is not taken, so he is never hit.
  const hammer = getChampion('hammer')
  const hit = scene([{ at: { x: HOME.x + 60, y: HOME.y }, who: hammer }])
  hit.addOrder(1, cast(1, 'ghost', none))
  hit.addOrder(2, attack(2, 1))
  assert.equal(hit.at(100).get(2)?.getAttackTarget(), undefined, 'it has no one to go after')
  assert.equal(hp(hit.at(110), 1), cloak.maxHp, 'and he is not hurt')

  // One that aims an ability at him is dropped: nothing happens, and nothing is spent. The same cast at him when he is not invisible lands.
  const curse = getChampion('cursebearer')
  const aimed = (invisible: boolean): GameTickSnapshot => {
    const simulator = scene([{ at: { x: HOME.x + 100, y: HOME.y }, who: curse }])
    if (invisible) simulator.addOrder(1, cast(1, 'ghost', none))
    simulator.addOrder(2, cast(3, 'feast', at(1), { x: HOME.x + 100, y: HOME.y }))
    return simulator.at(30)
  }
  assert.ok(hp(aimed(false), 1) < cloak.maxHp, 'it lands on him when he is seen')
  const unseen = aimed(true)
  assert.equal(hp(unseen, 1), cloak.maxHp, 'but not when he is not')
  assert.equal(unseen.get(2)?.getAbilityCooldown('feast').ready, true, 'and the cast was not spent')

  // What is laid on the ground does not need to see him.
  const slammed = scene([{ at: { x: HOME.x + 60, y: HOME.y }, who: hammer }])
  slammed.addOrder(1, cast(1, 'ghost', none))
  slammed.addOrder(2, cast(3, 'slam', west, { x: HOME.x + 60, y: HOME.y }))
  assert.ok(hp(slammed.at(40), 1) < cloak.maxHp, 'a blow on the ground hits him')
})

// ---------------------------------------------------------------------------- the fear

test('when ghost ends, each enemy near is feared and marked, and the ones far are not', () => {
  assert.ok(ghost)
  const near = (side: 1 | -1): Vector2 => ({ x: HOME.x + side * FEAR_RADIUS / 2, y: HOME.y })
  const far = { x: HOME.x, y: HOME.y + FEAR_RADIUS + 2 * R + 40 }
  const simulator = scene([near(1), near(-1), far])
  simulator.addOrder(1, cast(1, 'ghost', none))
  const ends = 1 + GHOST_TICKS
  // The one on the right is told to walk back at him as it is feared.
  simulator.addOrder(2, move(ends + 2, HOME))

  const right: number[] = []
  const left: number[] = []
  let atEnd: GameTickSnapshot | undefined
  for (let tick = ends - 1; tick <= ends + FEAR_TICKS + 6; tick += 1) {
    const frame = simulator.at(tick)
    if (tick === ends) atEnd = frame
    if (tick >= ends) {
      right.push(where(frame, 2).x)
      left.push(where(frame, 3).x)
    }
  }
  assert.ok(atEnd)

  for (const id of [2, 3]) {
    const fear = status(atEnd, id, 'fear')
    assert.equal(fear?.ownerId, 1, `${id} is feared, by him`)
    assert.equal(fear && fear.endTick - fear.startTick, FEAR_TICKS)
    const [mark] = marks(atEnd, id, FEAR_KEY)
    assert.equal(mark?.ownerId, 1, 'and carries his mark')
    assert.equal(mark && mark.endTick - mark.startTick, FEAR_MEMORY_TICKS)
  }
  assert.equal(status(atEnd, 4, 'fear'), undefined, 'one that is far off is not feared')
  assert.deepEqual(marks(atEnd, 4, FEAR_KEY), [])

  // They run from him, straight away, for as long as it lasts, at their own speed, whatever they are told; and then they stop where they are.
  const ran = walkingSpeed(bag.moveSpeed) * FEAR_TICKS / GAME_TPS
  assert.ok(Math.abs(right[FEAR_TICKS] - right[0] - ran) < 1, `the one on the right ran ${right[FEAR_TICKS] - right[0]}, which is ${ran}`)
  assert.ok(Math.abs(left[0] - left[FEAR_TICKS] - ran) < 1, 'and the one on the left ran as far, the other way')
  for (let index = 1; index <= FEAR_TICKS; index += 1) assert.ok(right[index] > right[index - 1], `it kept running (${index})`)
  assert.equal(right[right.length - 1], right[FEAR_TICKS], 'and stops when it is over, though it was told to walk back')
  assert.equal(where(simulator.at(ends + FEAR_TICKS + 6), 4).x, far.x, 'the far one never moved')
})

test('a feared enemy cannot cast, and a cast it has started is stopped, with nothing spent', () => {
  const hammer = getChampion('hammer')
  const slam = abilityDefs.get('slam')
  assert.ok(slam)
  const ends = 1 + GHOST_TICKS
  // It starts its slam so that the fear lands part way through its windup.
  const startsAt = ends - 3
  assert.ok(slam.windUpTicks > 3)
  const run = (ghosted: boolean): GameTickSnapshot => {
    const simulator = scene([{ at: { x: HOME.x + 100, y: HOME.y }, who: hammer }])
    if (ghosted) simulator.addOrder(1, cast(1, 'ghost', none))
    simulator.addOrder(2, cast(startsAt, 'slam', west, { x: HOME.x + 100, y: HOME.y }))
    return simulator.at(startsAt + slam.windUpTicks + 3)
  }
  assert.ok(hp(run(false), 1) < cloak.maxHp, 'the slam hits him if he never frightens it')
  const frightened = run(true)
  assert.equal(hp(frightened, 1), cloak.maxHp, 'but it never lands when he does')
  assert.equal(frightened.get(2)?.getAbilityCooldown('slam').ready, true, 'and the ability was not spent')
})

test('a feared enemy cannot start a cast, nor is it sent after anyone, until the fear is over', () => {
  const hammer = getChampion('hammer')
  const at100 = { x: HOME.x + 100, y: HOME.y }
  const ends = 1 + GHOST_TICKS
  const simulator = scene([{ at: at100, who: hammer }])
  simulator.addOrder(1, cast(1, 'ghost', none))
  // Part way through the fear it is told to slam him (it has run a little from where it was, which is inside what a cast allows), and then to go after him.
  simulator.addOrder(2, cast(ends + 5, 'slam', west, at100))
  simulator.addOrder(2, attack(ends + 8, 1))
  const after = simulator.at(ends + FEAR_TICKS + 150)

  assert.equal(after.get(2)?.getAbilityCooldown('slam').ready, true, 'the slam was never started')
  assert.equal(after.get(2)?.getAttackTarget(), undefined, 'and it is not going after him')
  assert.equal(hp(after, 1), cloak.maxHp, 'so, long after the fear is over, he has not been touched')
})

test('an order to attack an invisible champion is dropped, and does not stop what the one who gave it was doing', () => {
  const hammer = getChampion('hammer')
  const simulator = scene([{ at: { x: HOME.x + 300, y: HOME.y }, who: hammer }])
  simulator.addOrder(1, cast(1, 'ghost', none))
  simulator.addOrder(2, move(2, { x: HOME.x + 1500, y: HOME.y }))
  simulator.addOrder(2, attack(10, 1))
  const walked = where(simulator.at(20), 2).x
  const later = where(simulator.at(50), 2).x
  assert.ok(later - walked > walkingSpeed(hammer.moveSpeed) * 20 / GAME_TPS, `it is still walking: ${walked} then ${later}`)
  assert.equal(simulator.at(50).get(2)?.getAttackTarget(), undefined)
})

test('a turret shoots a champion it can see, and does not spend itself on a nearer one it cannot', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, cloak, 1)
  simulator.addPlayer(2, 'p2', 'Two', { x: HOME.x + 150, y: HOME.y + 150 }, bag, 3)
  simulator.addTurret(11, tower, { x: HOME.x + 100, y: HOME.y }, 2)
  simulator.addOrder(1, cast(1, 'ghost', none))
  assert.ok(hp(simulator.at(Math.floor(GHOST_TICKS * 0.8)), 2) < bag.maxHp, 'the one it can see is shot, though he is nearer')
})

test('the bonus is for what he feared himself: an enemy that someone else has feared is hit as plain', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, cloak, 1)
  const target = { x: HOME.x + FEAR_RADIUS - 20, y: HOME.y }
  simulator.addPlayer(2, 'p2', 'Two', target, bag, 2)
  // A second Cloak, far enough from the first to be out of the fear, and in reach of the one who is feared.
  simulator.addPlayer(3, 'p3', 'Three', { x: target.x + cloak.attackRange - 10, y: HOME.y }, cloak, 3)
  const ends = 1 + GHOST_TICKS
  simulator.addOrder(1, cast(1, 'ghost', none))
  simulator.addOrder(3, attack(ends + 1, 2))
  const lands = ends + 1 + cloak.attackWindupTicks
  const frame = simulator.at(lands)

  assert.equal(status(frame, 2, 'fear')?.ownerId, 1, 'it is feared, by the first one')
  assert.equal(status(frame, 3, 'fear'), undefined, 'and the second is not')
  assert.equal(bag.maxHp - hp(frame, 2), cloak.attackDamage, 'the second one\'s hit on it is the plain one')
})

test('ghost is the one ability of cloak\'s that keeps him invisible: knives and cut through show him', () => {
  assert.equal(ghost?.keepsInvisibility, true)
  assert.equal(knives?.keepsInvisibility, undefined)
  assert.equal(cut?.keepsInvisibility, undefined)
})

test('an ability that keeps invisibility does, and one that does not shows him and does what being seen does', () => {
  const quiet = defineAbility({ id: 't-cloak-quiet', targeting: 'none', range: 0, windUpTicks: 0, cooldownTicks: 60, keepsInvisibility: true, apply: [haste(0.1, 10, self())] })
  const loud = defineAbility({ id: 't-cloak-loud', targeting: 'none', range: 0, windUpTicks: 0, cooldownTicks: 60, apply: [haste(0.1, 10, self())] })
  const copy = new Champion({ ...cloak, abilities: ['ghost', quiet.id, loud.id] })
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, copy, 1)
  simulator.addPlayer(2, 'p2', 'Two', { x: HOME.x + 100, y: HOME.y }, bag, 2)
  simulator.addOrder(1, cast(1, 'ghost', none))
  simulator.addOrder(1, cast(3, quiet.id, none))
  simulator.addOrder(1, cast(6, loud.id, none))

  assert.ok(status(simulator.at(4), 1, 'invisible'), 'invisible after the one that keeps it')
  assert.equal(status(simulator.at(5), 2, 'fear'), undefined, 'and nothing is frightened')
  assert.equal(status(simulator.at(6), 1, 'invisible'), undefined, 'but not after the one that does not')
  assert.equal(status(simulator.at(6), 2, 'fear')?.ownerId, 1, 'which frightens what is near')
})

// ---------------------------------------------------------------------------- showing himself

test('an auto from invisibility shows him, fears what is near, and hits the feared one for more', () => {
  const ambush = scene([within])
  ambush.addOrder(1, cast(1, 'ghost', none))
  ambush.addOrder(1, attack(2, 2))
  const control = scene([within])
  control.addOrder(1, attack(2, 2))
  const lands = 2 + cloak.attackWindupTicks
  assert.ok(lands < 1 + GHOST_TICKS, 'it lands well inside the time')

  assert.ok(status(ambush.at(lands - 1), 1, 'invisible'), 'he is invisible until the blow')
  const frame = ambush.at(lands)
  assert.equal(status(frame, 1, 'invisible'), undefined, 'and seen from it')
  assert.equal(status(frame, 2, 'fear')?.ownerId, 1, 'what he hit is feared')
  assert.equal(bag.maxHp - hp(control.at(lands), 2), cloak.attackDamage, 'an auto on an enemy he has not feared is plain')
  assert.equal(bag.maxHp - hp(frame, 2), Math.round(cloak.attackDamage * (1 + FEAR_BONUS)), 'and on one he has just feared is more')
})

test('casting an ability from invisibility shows him too, and the ability hits the feared for more; casting ghost does not', () => {
  assert.ok(knives)
  const target = { x: HOME.x + KNIVES_RANGE / 2, y: HOME.y }
  const ambush = scene([target])
  ambush.addOrder(1, cast(1, 'ghost', none))
  ambush.addOrder(1, cast(3, 'knives', east))
  const control = scene([target])
  control.addOrder(1, cast(3, 'knives', east))
  const lands = 3 + knives.windUpTicks

  assert.ok(status(ambush.at(lands - 1), 1, 'invisible'), 'invisible while he winds up')
  const frame = ambush.at(lands)
  assert.equal(status(frame, 1, 'invisible'), undefined, 'and seen as the knives go')
  assert.equal(status(frame, 2, 'fear')?.ownerId, 1)
  assert.equal(bag.maxHp - hp(control.at(lands), 2), Math.round(knivesDamage), 'the knives on one he has not feared')
  assert.equal(bag.maxHp - hp(frame, 2), Math.round(knivesDamage * (1 + FEAR_BONUS)), 'and on one he has: more')
})

// ---------------------------------------------------------------------------- Knives

// How much a champion standing here loses to a cast of knives to the east, and how many hits it took.
function knifed(spot: Vector2): { lost: number; hits: number } {
  assert.ok(knives)
  const simulator = scene([spot])
  simulator.addOrder(1, cast(1, 'knives', east))
  let hits = 0
  for (let tick = 1; tick <= 1 + knives.windUpTicks + 2; tick += 1) {
    hits += simulator.at(tick).events.filter((event) => event.type === 'damage' && event.ownerId === 1 && event.targetId === 2).length
  }
  return { lost: bag.maxHp - hp(simulator.at(1 + knives.windUpTicks + 2), 2), hits }
}

test('knives hurt each enemy in the cone once, and no one behind, beyond or outside it, and a body counts when any of it is in', () => {
  const middle = KNIVES_RANGE / 2
  const clearOfTheEdge = Math.asin((R + 8) / middle)
  for (const [name, spot] of [
    ['straight ahead', polar(middle, 0)],
    ['near the top edge', polar(middle, KNIVES_HALF_ANGLE - 0.05)],
    ['near the bottom edge', polar(middle, -(KNIVES_HALF_ANGLE - 0.05))],
    ['with its middle just outside the edge, but its body in', polar(middle, KNIVES_HALF_ANGLE + 0.1)],
    ['at the far end, its body just in', polar(KNIVES_RANGE + R - 2, 0)],
  ] as const) {
    const result = knifed(spot)
    assert.equal(result.hits, 1, `${name}: one hit`)
    assert.equal(result.lost, Math.round(knivesDamage), `${name}: for the damage it says`)
  }
  for (const [name, spot] of [
    ['clear of the edge', polar(middle, KNIVES_HALF_ANGLE + clearOfTheEdge + 0.02)],
    ['clear of the lower edge', polar(middle, -(KNIVES_HALF_ANGLE + clearOfTheEdge + 0.02))],
    ['behind him', polar(middle, Math.PI)],
    ['beyond the end', polar(KNIVES_RANGE + R + 6, 0)],
  ] as const) {
    assert.deepEqual(knifed(spot), { lost: 0, hits: 0 }, name)
  }
})

test('the cone is aimed with the cosine and sine of the angle the indicator draws, and the knives fan out across exactly that angle', () => {
  assert.ok(knives && knives.indicator?.coneHalfAngle === KNIVES_HALF_ANGLE)
  assert.ok(Math.abs(KNIVES_CONE.cos - Math.cos(KNIVES_HALF_ANGLE)) < 1e-12)
  assert.ok(Math.abs(KNIVES_CONE.sin - Math.sin(KNIVES_HALF_ANGLE)) < 1e-12)

  const simulator = scene([])
  simulator.addOrder(1, cast(1, 'knives', east))
  const flying = simulator.at(1 + knives.windUpTicks).getEntities().filter((entity) => entity.defId === 'knife')
  const def = getEntityDef('knife')
  assert.ok(def && flying.length > 1, 'knives are thrown, more than one')
  assert.equal(def.onHit, undefined, 'they are only seen: the damage is the cone\'s')
  const angles = flying.map((entity) => Math.atan2(entity.velocity.y, entity.velocity.x)).sort((left, right) => left - right)
  angles.forEach((angle, index) => assert.ok(Math.abs(angle + angles[angles.length - 1 - index]) < 1e-9, 'the fan is even either side of the aim'))
  assert.ok(Math.abs(angles[angles.length - 1] - KNIVES_HALF_ANGLE) < 1e-9, 'and as wide as the cone')
  for (const entity of flying) assert.ok(Math.abs(Math.hypot(entity.velocity.x, entity.velocity.y) - def.speed) < 1e-9, 'each at the speed it says')
})

// ---------------------------------------------------------------------------- Cut Through

// A place the given share of the way along the dash's range, on the line at this angle from where he stands. All of the positions here are worked out from the range, which is the
// ability's own.
const along = (share: number, angle = 0): Vector2 => polar(CUT_RANGE * share, angle)

// The frame he is first back on the ground in, after the dash that starts on or after this tick. It gives up (and says so) if there is no dash, which is a cast that was dropped.
function afterDash(simulator: Simulator, from: number): GameTickSnapshot {
  const give = from + 600
  let tick = from
  while (simulator.at(tick).get(1)?.isDashing() !== true) {
    tick += 1
    assert.ok(tick < give, `he never dashed after tick ${from}: the cast was dropped`)
  }
  while (simulator.at(tick).get(1)?.isDashing()) {
    tick += 1
    assert.ok(tick < give + 600, 'the dash never ended')
  }
  return simulator.at(tick)
}

// Where a cut through aimed at an enemy standing here is sending him: the point the dash is heading for, as soon as it is cast.
function cutsTo(enemy: Vector2): Vector2 | undefined {
  const simulator = scene([enemy])
  simulator.addOrder(1, cast(1, 'cutthrough', at(2)))
  return simulator.at(1).get(1)?.getMoveTarget()
}

test('cut through is a dash of the same length however near or far the enemy it is aimed at is: past a nearer one, and on top of one at the range', () => {
  assert.ok(cut && cut.range === CUT_RANGE)
  for (const angle of [0, 0.7, -2.1]) {
    for (const share of [0.3, 0.6, 1]) {
      const end = cutsTo(along(share, angle))
      assert.ok(end && distance(end, along(1, angle)) < 1e-6, `an enemy ${share} of the range away, at ${angle}: he is sent to ${JSON.stringify(end)}`)
    }
  }
  // At the range itself that is the enemy's own place: he ends up on top of it.
  const exact = along(1, 0.7)
  assert.ok(distance(cutsTo(exact) as Vector2, exact) < 1e-6)
})

test('cut through hurts every enemy it touches on the way once, and none off it', () => {
  // The first is near enough to be gone through and overshot, the second is further on the same line, and a third is off to one side.
  assert.ok(CUT_RANGE * 0.3 >= 2 * R && CUT_RANGE * 0.35 >= cloak.radius + R, 'there is room on the way for two bodies, apart from each other and from him')
  const first = along(0.35)
  const simulator = scene([first, along(0.65), { x: first.x, y: HOME.y - 3 * R }])
  simulator.addOrder(1, cast(1, 'cutthrough', at(2)))
  const done = afterDash(simulator, 1)

  assert.equal(bag.maxHp - hp(done, 2), Math.round(cutDamage), 'the one he aimed at is hurt once')
  assert.equal(bag.maxHp - hp(done, 3), Math.round(cutDamage), 'and the one further on the way')
  assert.equal(hp(done, 4), bag.maxHp, 'but not the one off to the side')
  assert.equal(done.get(1)?.getAbilityCooldown('cutthrough').ready, false, 'and against enemies he has not feared it gives nothing back')
})

test('cut through gives a share of itself back against an enemy he has feared lately, and spends the mark, and always gives knives back', () => {
  assert.ok(cut)
  // A knives that is on cooldown is ready when it is cast, whomever it hits.
  const plain = scene([along(0.5)])
  assert.ok(knives)
  plain.addOrder(1, cast(1, 'knives', west))
  // The cooldown starts when the knives go off, a windup after the cast, and cut through is cast a few ticks after that.
  const thrown = 1 + knives.windUpTicks
  plain.addOrder(1, cast(thrown + 4, 'cutthrough', at(2)))
  assert.equal(plain.at(thrown + 3).get(1)?.getAbilityCooldown('knives').ready, false, 'knives is on cooldown')
  assert.equal(plain.at(thrown + 5).get(1)?.getAbilityCooldown('knives').ready, true, 'and cut through gives it back')

  // Cast from invisibility, he shows himself and fears what is near, so the enemy he cuts through has been feared by him.
  const simulator = scene([along(0.5)])
  simulator.addOrder(1, cast(1, 'ghost', none))
  simulator.addOrder(1, cast(3, 'cutthrough', at(2)))
  const done = afterDash(simulator, 3)
  const given = Math.round(cut.cooldownTicks * CUT_REFUND)
  assert.ok(given > 0, 'it gives something back')
  assert.equal(done.get(1)?.getAbilityCooldown('cutthrough').ticksRemaining, 3 + cut.cooldownTicks - given - done.tick, 'the share of its cooldown it says')
  assert.equal(bag.maxHp - hp(done, 2), Math.round(cutDamage * (1 + FEAR_BONUS)), 'and the feared one took more')
  assert.deepEqual(marks(done, 2, FEAR_KEY), [], 'the mark is spent: it is not given back for the same enemy again until it is feared again')
})

test('a hit of cut through gives it back only if the enemy carries his mark, and spends the mark; marked again, it does it again', () => {
  const def = getDashDef('cutthrough')
  assert.ok(def?.onHit)
  const events: Array<{ type: string; abilityId?: string; fraction?: number }> = []
  const removed: string[] = []
  const hit = (marked: boolean) => {
    events.length = 0
    removed.length = 0
    const sim = {
      tick: 100,
      markersOn: () => (marked ? [{ id: 'm', key: FEAR_KEY, rootId: 'x', ownerId: 1, startTick: 90, endTick: 190 }] : []),
      statsOf: () => ({ attackDamage: cloak.attackDamage, arcane: 0, maxHp: 1, attackSpeed: 1, attackRange: 1, moveSpeed: 1, resistance: 0, haste: 0 }),
      healthOf: () => ({ hp: 1, maxHp: 1 }),
      levelOf: () => 1,
      emitEvent: (event: { type: string; abilityId?: string; fraction?: number }) => events.push(event),
      removeMarkers: (_unit: number, key: string) => removed.push(key),
    }
    for (const effect of def.onHit ?? []) effect(sim as never, { id: 'c:x', rootId: 'x', ownerId: 1, tick: 100, at: { x: 0, y: 0 }, aim: null, subject: 2 })
    const refunds = events.filter((event) => event.type === 'refund-cooldown')
    return { refunds: refunds.map((event) => [event.abilityId, event.fraction]), removed: [...removed] }
  }
  assert.deepEqual(hit(false), { refunds: [], removed: [] }, 'not marked: nothing given back')
  assert.deepEqual(hit(true), { refunds: [['cutthrough', CUT_REFUND]], removed: [FEAR_KEY] }, 'marked: the share is given back, and the mark spent')
  assert.deepEqual(hit(true), { refunds: [['cutthrough', CUT_REFUND]], removed: [FEAR_KEY] }, 'and marked again: given back again')
})

// ---------------------------------------------------------------------------- the passive: kills

// A champion that dies to one auto of Cloak's, and a monster that does, to stand in for what is not a champion.
const victim = new Champion({
  id: 't-cloak-victim',
  name: 'Test Victim',
  base: { maxHp: 30, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 140,
  radius: R,
  attackRange: 50,
  attackWindup: 0,
  abilities: [],
})
const prey = defineMonster({
  id: 't-cloak-prey',
  name: 'Prey',
  base: { maxHp: 30, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 0,
  radius: R,
  attackRange: 10,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300 },
  reward: { gold: 0, xp: 0, shards: 0 },
})

const ready = (frame: GameTickSnapshot): boolean[] => ['ghost', 'knives', 'cutthrough'].map((id) => frame.get(1)?.getAbilityCooldown(id).ready === true)

// Cloak uses all three of his abilities (Cut Through at a bystander, which he has not feared, since he is seen when he casts it; then Ghost, and Knives to the west, where there is
// no one, which show him and fear what is near, but not the prize), and then goes after a prize that stands out of the reach of that fear, and kills it. What it comes to is
// the abilities as they were on the tick before the kill, and as they are on it.
function killScene(kind: 'champion' | 'monster'): { before: boolean[]; after: boolean[]; dead: boolean } {
  const landed = along(1)
  const prize = { x: landed.x + FEAR_RADIUS + R + 20, y: HOME.y }
  const simulator = scene([along(0.5), ...(kind === 'champion' ? [{ at: prize, who: victim }] : [])])
  if (kind === 'monster') simulator.addMonster(3, prey, prize)
  simulator.addOrder(1, cast(1, 'cutthrough', at(2)))
  simulator.addOrder(1, cast(20, 'ghost', none, landed))
  simulator.addOrder(1, cast(21, 'knives', west, landed))
  simulator.addOrder(1, attack(40, 3))
  let before = ready(simulator.at(1))
  for (let tick = 2; tick <= 600; tick += 1) {
    const frame = simulator.at(tick)
    if (frame.get(3)?.isDead()) return { before, after: ready(frame), dead: true }
    before = ready(frame)
  }
  return { before, after: before, dead: false }
}

test('killing a champion makes all his abilities ready on the tick of the kill', () => {
  const result = killScene('champion')
  assert.equal(result.dead, true, 'he kills it')
  assert.deepEqual(result.before, [false, false, false], 'all three are on cooldown before it')
  assert.deepEqual(result.after, [true, true, true], 'and he has them all again')
})

test('killing a monster does not', () => {
  const result = killScene('monster')
  assert.equal(result.dead, true, 'he kills it')
  assert.deepEqual(result.after, [false, false, false])
})

// ---------------------------------------------------------------------------- what is not a player

const wolf = defineMonster({
  id: 't-cloak-wolf',
  name: 'Wolf',
  base: { maxHp: 1000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 50,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 300, deaggroRange: 450 },
  reward: { gold: 0, xp: 0, shards: 0 },
})
const tower = defineTurret(91, { base: { maxHp: 100_000, attackDamage: 50, attackSpeed: 1 }, radius: 40, attackRange: 400, attackWindup: 0 })

test('a monster does not notice an invisible champion who walks up to it, and a turret does not shoot one', () => {
  // He starts out of its reach and walks toward it, so that he comes into it while he is invisible (or, for the control, while he is not). Cloak is the game's own, so how far he
  // walks in the time is what his speed makes it, whatever the game's move speed multiplier is: it is put that far off, and half its reach more.
  const late = Math.floor(GHOST_TICKS * 0.8)
  const far = walkingSpeed(cloak.moveSpeed) * (late - 2) / GAME_TPS + wolf.ai.aggroRange / 2
  const watched = (invisible: boolean): string | undefined => {
    const simulator = scene([])
    simulator.addMonster(10, wolf, { x: HOME.x + far, y: HOME.y })
    if (invisible) simulator.addOrder(1, cast(1, 'ghost', none))
    simulator.addOrder(1, move(2, { x: HOME.x + far, y: HOME.y }))
    const frame = simulator.at(late)
    assert.ok(distance(where(frame, 1), where(frame, 10)) < wolf.ai.aggroRange, 'he has come into its reach')
    return frame.get(10)?.getAi()?.mode
  }
  assert.equal(watched(false), 'chase', 'it goes after him when it can see him')
  assert.equal(watched(true), 'idle', 'and does not when it cannot')

  // What he loses between a moment after the cast (a turret may have had a shot in the tick it was made) and well on in the time he is invisible.
  const shot = (invisible: boolean): number => {
    const simulator = scene([])
    simulator.addTurret(11, tower, { x: HOME.x + 200, y: HOME.y }, 2)
    if (invisible) simulator.addOrder(1, cast(1, 'ghost', none))
    const early = hp(simulator.at(10), 1)
    return early - hp(simulator.at(Math.floor(GHOST_TICKS * 0.8)), 1)
  }
  assert.ok(shot(false) > 0, 'a turret shoots him when it can see him')
  assert.equal(shot(true), 0, 'and does not when it cannot')
})

test('a monster that is fighting him keeps at it through his invisibility and its fear: it does not go home and heal, and it goes after him again', () => {
  const ends = 1 + GHOST_TICKS
  const simulator = scene([])
  simulator.addMonster(10, wolf, { x: HOME.x + 200, y: HOME.y })
  simulator.addOrder(1, cast(1, 'ghost', none))
  const minds = new Set<string>()
  let feared: number | undefined
  let apart: number | undefined
  const last = ends + FEAR_TICKS + 90
  for (let tick = 1; tick <= last; tick += 1) {
    const frame = simulator.at(tick)
    const mind = frame.get(10)?.getAi()
    minds.add(`${mind?.mode}:${mind?.targetId}`)
    if (tick === ends + FEAR_TICKS - 1) feared = distance(where(frame, 1), where(frame, 10))
    if (tick === last) apart = distance(where(frame, 1), where(frame, 10))
  }

  assert.deepEqual([...minds], ['chase:1'], 'it was after him the whole time, from before he vanished to long after it was frightened')
  assert.ok(feared !== undefined && apart !== undefined && apart < feared, `and it is coming back at him: ${feared} apart at the end of the fear, ${apart} after`)
})

test('a structure is not feared, and is not marked', () => {
  const simulator = scene([])
  simulator.addTurret(11, tower, { x: HOME.x + FEAR_RADIUS / 2, y: HOME.y }, 2)
  simulator.addOrder(1, cast(1, 'ghost', none))
  const ends = 1 + GHOST_TICKS
  const frame = simulator.at(ends)
  assert.deepEqual(marks(frame, 11, FEAR_KEY), [])
  assert.equal(status(frame, 11, 'fear'), undefined)
})

// ---------------------------------------------------------------------------- what is kept, and what is shown

test('a snapshot that has invisible and feared characters in it is one the page can read', () => {
  const simulator = scene([{ x: HOME.x + FEAR_RADIUS / 2, y: HOME.y }])
  simulator.addOrder(1, cast(1, 'ghost', none))
  for (const [tick, kind, id] of [[60, 'invisible', 1], [1 + GHOST_TICKS + 4, 'fear', 2]] as const) {
    simulator.advanceTo(tick)
    simulator.setCommitTick(tick)
    const received = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(simulator.snapshot())))
    assert.ok(received.checkpoint.characters.find((character) => character.characterId === id)?.statuses.some((each) => each.kind === kind), `${kind} is in it`)
  }
})

// A vision system that sees everything, so what is left out is left out by being invisible and not by being dark.
const everything: VisionSystem = {
  name: 'everything',
  see: () => ({ mask: { kind: 'cells', cell: 10, cols: 1, rows: 1, data: new Uint8Array([1]), revision: 1 } satisfies VisionMask, canSee: () => true }),
}
let nextId = 100
function drawn(team: number, extra: Partial<RenderedCharacter> = {}): RenderedCharacter {
  return { id: nextId++, team, position: { x: 100, y: 100 }, dead: false, invisible: false, champion: { radius: 20 }, ...extra } as unknown as RenderedCharacter
}

test('an enemy that is invisible is not seen, even in the light, and one of the team\'s own is', () => {
  const me = drawn(1)
  const mine = drawn(1, { invisible: true })
  const seen = drawn(2)
  const hidden = drawn(2, { invisible: true })
  const vision = new TeamVision(everything)
  vision.update([me, mine, seen, hidden], 1)
  assert.deepEqual(vision.visibleCharacters([me, mine, seen, hidden]).map((each) => each.id), [me.id, mine.id, seen.id])
  assert.deepEqual(vision.hiddenCharacters([me, mine, seen, hidden]).map((each) => each.id), [hidden.id], 'it is kept, as unseen, and not drawn')
  assert.equal(vision.isVisible(hidden), false, 'so it cannot be picked either')

  vision.update([me, mine, seen, hidden], 1, { reveal: true })
  assert.equal(vision.isVisible(hidden), true, 'all is shown when the debug view is on')
})

test('the page tells who is invisible and who is feared, and draws one that is invisible faintly', () => {
  const state = new ClientGameState()
  state.simulator.addPlayer(1, 'p1', 'One', HOME, cloak, 1)
  state.simulator.addPlayer(2, 'p2', 'Two', { x: HOME.x + FEAR_RADIUS / 2, y: HOME.y }, bag, 2)
  state.setLocalCharacterId(1)
  state.resetServerTickAnchor(0, 0)
  state.simulator.addOrder(1, cast(1, 'ghost', none))
  const flags = (tick: number) => {
    state.simulator.advanceTo(tick)
    const characters = state.getCharacters(tick * 1000 / GAME_TPS)
    return { characters, one: characters.find((each) => each.id === 1) as RenderedCharacter, two: characters.find((each) => each.id === 2) as RenderedCharacter }
  }
  const during = flags(20)
  assert.deepEqual([during.one.invisible, during.two.feared], [true, false])
  const after = flags(1 + GHOST_TICKS + 3)
  assert.deepEqual([after.one.invisible, after.two.feared], [false, true])

  const layer = new CharacterLayer(new Map())
  layer.update([during.one], 1, undefined, 0)
  assert.equal(layer.view.children[0].alpha, INVISIBLE_ALPHA, 'faintly')
  layer.update([after.one], 1, undefined, 1)
  assert.equal(layer.view.children[0].alpha, 1, 'and fully when he is seen')
})

test('a ring as big as his fear is drawn round the champion you control while it is invisible, and only then', () => {
  assert.equal(cloak.leaveInvisibilityRadius, FEAR_RADIUS, 'cloak says how far his fear reaches')
  assert.equal(getChampion('hammer').leaveInvisibilityRadius, undefined, 'and a champion with nothing to show has none')

  const state = new ClientGameState()
  state.simulator.addPlayer(1, 'p1', 'One', HOME, cloak, 1)
  state.setLocalCharacterId(1)
  state.resetServerTickAnchor(0, 0)
  state.simulator.addOrder(1, cast(1, 'ghost', none))
  const me = (tick: number): RenderedCharacter => {
    state.simulator.advanceTo(tick)
    return state.getCharacters(tick * 1000 / GAME_TPS)[0]
  }
  const seen = me(0)
  const hidden = me(20)
  assert.equal(seen.invisible, false)
  assert.equal(hidden.invisible, true)

  // The layer: nothing while he is seen, and a ring that is as big as the reach while he is not.
  const ringOf = (layer: IndicatorLayer): Graphics => layer.view.children[layer.view.children.length - 1] as Graphics
  const layer = new IndicatorLayer()
  layer.update({ characters: [seen], local: { position: seen.position, attackRange: seen.attackRange }, attackMarkers: [] })
  assert.equal(ringOf(layer).visible, false, 'no ring when there is nothing to show')
  layer.update({ characters: [hidden], local: { position: hidden.position, attackRange: hidden.attackRange, revealRadius: FEAR_RADIUS }, attackMarkers: [] })
  assert.equal(ringOf(layer).visible, true, 'a ring when he is invisible')
  assert.ok(Math.abs(ringOf(layer).getLocalBounds().width - 2 * FEAR_RADIUS) <= 4, `as big as his fear reaches: ${ringOf(layer).getLocalBounds().width} across, for a radius of ${FEAR_RADIUS}`)
  layer.update({ characters: [seen], local: { position: seen.position, attackRange: seen.attackRange }, attackMarkers: [] })
  assert.equal(ringOf(layer).visible, false, 'and gone when he is seen again')

  // Through the renderer: it is the one thing that appears when he goes invisible, whatever the graphics menu has on, and it goes when he is seen.
  const world = new WorldRenderer({ map: { view: new Container() }, spriteSets: new Map() })
  const frame = (character: RenderedCharacter, now: number) => ({ now, characters: [character], entities: [], localCharacterId: 1, attackMarkers: [] })
  const shown = (root: Container): Container[] => {
    const nodes: Container[] = []
    const walk = (node: Container): void => {
      if (node.visible && (node as Graphics).context?.instructions?.length > 0) nodes.push(node)
      for (const child of node.children) walk(child)
    }
    walk(root)
    return nodes
  }
  world.update(frame(seen, 0))
  const before = new Set(shown(world.scene))
  world.update(frame(hidden, 1))
  const added = shown(world.scene).filter((node) => !before.has(node))
  assert.equal(added.length, 1, 'one more thing is drawn')
  assert.equal(added[0], ringOf((world as unknown as { indicators: IndicatorLayer }).indicators), 'and it is the ring')
  world.update(frame(seen, 2))
  assert.deepEqual(shown(world.scene).filter((node) => !before.has(node)), [], 'which is gone when he is seen')
})

test('the aim of a cone is drawn as a wedge, and the mark of a fear is a pip on the enemy', () => {
  assert.ok(knives)
  const state = new ClientGameState()
  state.simulator.addPlayer(1, 'p1', 'One', HOME, cloak, 1)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  const [me] = state.getCharacters(0)
  const draw = (indicator: { coneHalfAngle?: number }): number => {
    const layer = new IndicatorLayer()
    layer.update({
      characters: [me],
      local: { position: me.position, attackRange: me.attackRange },
      castPreview: { abilityId: 'knives', targeting: 'direction', range: knives.range, indicator, target: east },
      attackMarkers: [],
    })
    return (layer.view.children[1] as unknown as { context: { instructions: unknown[] } }).context.instructions.length
  }
  assert.ok(draw({ coneHalfAngle: KNIVES_HALF_ANGLE }) > draw({}), 'a wedge is drawn on top of the line')

  const pips = layoutStackPips({ [FEAR_KEY]: 1 }, R)
  assert.equal(pips.length, 1)
  assert.equal(pips[0].shape, 'diamond', 'a mark someone else put on it')
})

test('cloak is drawn from a sprite set of its own, with the clips a champion needs', () => {
  const set = championSprites.cloak
  assert.ok(set)
  for (const clip of ['idle', 'walk', 'attack', 'cast', 'dead'] as const) assert.ok(set.clips[clip], `a ${clip}`)
})
