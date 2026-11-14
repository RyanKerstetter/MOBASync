import assert from 'node:assert/strict'
import test from 'node:test'
import {
  alliesInRadius,
  damage,
  dash,
  enemiesInBox,
  enemiesInCone,
  enemiesInLine,
  enemiesInRadius,
  getHealingZone,
  loseHealth,
  self,
  Simulator,
  spawnEntity,
  touchesStructures,
  type CastTarget,
  type CharacterOrder,
  type DashDef,
  type EffectSource,
  type ModeSetup,
  type SimContext,
  type Turret,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { ATTACK_SOURCE_PREFIX } from '../packages/shared/src/effects.ts'
import { defineAbility, defineChampion, defineTurret } from './fixtures.ts'

// An ability goes through the structures of the map (a turret, a healing zone, a core): its shot is not stopped by one, its blast, line, cone or box does not take one in,
// and a dash does not count one as hit. Nothing an ability does ever lands on a structure (see `SimCharacter.structure`), so what these watch is what a structure would do
// to the ability: stop a shot that has other enemies behind it, or count as the hit that a dash or a selector looks for. An auto attack is the one thing that touches a
// structure, and still does. The champions, the abilities and the turret here are the tests' own.

const HIT = 120
const MAX_HP = 1000
const CONNECT_COST = 3
const MISS_COST = 7

// Harmless, and too big to break: only what is in its way matters.
const pillar = defineTurret(97, { base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 }, radius: 40, attackRange: 1, attackWindup: 0 })
const ZONE = getHealingZone(1)

// A shot that stops at the first thing it hits.
defineAbility({
  id: 't-ats-shot',
  targeting: 'direction',
  range: 1200,
  windUpTicks: 0,
  cooldownTicks: 600,
  apply: [spawnEntity({ id: 't-ats-shot', speed: 600, radius: 8, lifetimeTicks: 120, onHit: [damage(HIT)] })],
})
// A dash that does one thing to its caster when it touches an enemy, and another when it touches no one.
const leapDash: DashDef = { id: 't-ats-leap-dash', onConnect: [loseHealth(CONNECT_COST)], onMiss: [loseHealth(MISS_COST)] }
defineAbility({
  id: 't-ats-leap',
  targeting: 'point',
  range: 400,
  windUpTicks: 0,
  cooldownTicks: 600,
  movement: true,
  apply: [dash(600, 400, self(), { on: leapDash })],
})
const body = { base: { maxHp: MAX_HP, attackDamage: 10, attackSpeed: 1 }, moveSpeed: 200, radius: 18, attackWindup: 0 } as const
const caster = defineChampion({ ...body, id: 't-ats-caster', name: 'Caster', attackRange: 100, abilities: ['t-ats-shot', 't-ats-leap'] })
const bystander = defineChampion({ ...body, id: 't-ats-bystander', name: 'Bystander', attackRange: 100, abilities: [] })
// Shoots its autos, which arrive after a moment.
const archer = defineChampion({
  ...body,
  id: 't-ats-archer',
  name: 'Archer',
  base: { maxHp: MAX_HP, attackDamage: 50, attackSpeed: 1 },
  attackRange: 400,
  attackProjectile: { speed: 600, radius: 6 },
  abilities: [],
})

const CASTER = 1
const STRUCTURE = 10
const BEHIND = 3
const FRONT: Vector2 = { x: 1000, y: 700 }
const MIDDLE: Vector2 = { x: 1150, y: 700 }
const BACK: Vector2 = { x: 1300, y: 700 }
const ZONES: ModeSetup = { kind: 'deathmatch', healingZones: true }

let sequence = 0
const cast = (tick: number, abilityId: string, target: CastTarget, origin: Vector2): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target, origin: { ...origin } })
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const health = (simulator: Simulator, tick: number, id: number): number | undefined => simulator.at(tick).get(id)?.getHealth()

// The caster (team 1) in front, then whatever stands in the middle, then a bystander of a third team behind: all the caster's enemies, and none of them the structure's
// team, so a healing zone does not top the bystander up.
function lineUp(middle: Turret | 'player' | undefined, mode?: ModeSetup): Simulator {
  const simulator = new Simulator(undefined, mode)
  simulator.addPlayer(CASTER, 'c', 'Caster', FRONT, caster, 1)
  if (middle === 'player') simulator.addPlayer(STRUCTURE, 'm', 'Middle', MIDDLE, bystander, 2)
  else if (middle) simulator.addTurret(STRUCTURE, middle, MIDDLE, 2)
  simulator.addPlayer(BEHIND, 'b', 'Behind', BACK, bystander, 3)
  simulator.addOrder(CASTER, cast(2, 't-ats-shot', { mode: 'direction', dir: { x: 1, y: 0 } }, FRONT))
  return simulator
}

// ---------------------------------------------------------------------------- a shot

test('a shot flies on past a turret and hits the enemy behind it, and the turret is untouched', () => {
  const simulator = lineUp(pillar)
  assert.equal(health(simulator, 60, BEHIND), MAX_HP - HIT, 'the enemy behind it was hit')
  assert.equal(health(simulator, 60, STRUCTURE), pillar.champion.maxHp, 'and the turret took nothing')
})

test('a shot flies on past a healing zone as well', () => {
  const simulator = lineUp(ZONE, ZONES)
  assert.equal(health(simulator, 60, BEHIND), MAX_HP - HIT)
  assert.equal(health(simulator, 60, STRUCTURE), ZONE.champion.maxHp)
})

test('a shot that has nothing in its way hits the same, and one that has another player in its way is stopped by them', () => {
  const clear = lineUp(undefined)
  assert.equal(health(clear, 60, BEHIND), MAX_HP - HIT, 'the same as it is with a turret in the way')

  const blocked = lineUp('player')
  assert.equal(health(blocked, 60, STRUCTURE), MAX_HP - HIT, 'the first enemy it meets is hit')
  assert.equal(health(blocked, 60, BEHIND), MAX_HP, 'and it goes no further: only a structure is gone through')
})

test('a shot that is fired through a turret still hits an enemy standing against it', () => {
  const simulator = new Simulator()
  simulator.addTurret(STRUCTURE, pillar, MIDDLE, 2)
  simulator.addPlayer(CASTER, 'c', 'Caster', FRONT, caster, 1)
  const beside: Vector2 = { x: MIDDLE.x + pillar.champion.radius + bystander.radius, y: MIDDLE.y }
  simulator.addPlayer(BEHIND, 'b', 'Behind', beside, bystander, 3)
  simulator.addOrder(CASTER, cast(2, 't-ats-shot', { mode: 'direction', dir: { x: 1, y: 0 } }, FRONT))
  assert.equal(health(simulator, 60, BEHIND), MAX_HP - HIT)
})

// ---------------------------------------------------------------------------- an auto attack

test('an auto attack is the one thing that still touches a structure: the shot of a ranged champion lands on a turret', () => {
  const tower = defineTurret(98, { base: { maxHp: 10_000, attackDamage: 1, attackSpeed: 1 }, radius: 40, attackRange: 1, attackWindup: 0 })
  const simulator = new Simulator()
  simulator.addTurret(STRUCTURE, tower, MIDDLE, 2)
  simulator.addPlayer(CASTER, 'c', 'Caster', FRONT, archer, 1)
  simulator.addOrder(CASTER, attack(1, STRUCTURE))
  assert.ok((health(simulator, 80, STRUCTURE) ?? tower.champion.maxHp) < tower.champion.maxHp, 'the turret was hurt by it')
})

// ---------------------------------------------------------------------------- a dash

// A dasher (team 1) that leaps at `at` from the west of it, the middle of what stands there.
function leap(middle: Turret | 'player'): Simulator {
  const simulator = new Simulator()
  const from: Vector2 = { x: MIDDLE.x - 140, y: MIDDLE.y }
  if (middle === 'player') simulator.addPlayer(STRUCTURE, 'm', 'Middle', MIDDLE, bystander, 2)
  else simulator.addTurret(STRUCTURE, middle, MIDDLE, 2)
  simulator.addPlayer(CASTER, 'c', 'Caster', from, caster, 1)
  simulator.addOrder(CASTER, cast(5, 't-ats-leap', { mode: 'point', point: MIDDLE }, from))
  return simulator
}

test('a dash that only touches a turret has touched no one: it misses, and does not connect', () => {
  const simulator = leap(pillar)
  assert.equal(health(simulator, 120, CASTER), MAX_HP - MISS_COST)
})

test('a dash that only touches a healing zone misses as well', () => {
  const simulator = leap(ZONE)
  assert.equal(health(simulator, 120, CASTER), MAX_HP - MISS_COST)
})

test('a dash that touches another player connects, as it always did', () => {
  const simulator = leap('player')
  assert.equal(health(simulator, 120, CASTER), MAX_HP - CONNECT_COST)
})

// ---------------------------------------------------------------------------- what a selector picks up

// The caster (1, team 1) at the origin, aimed east, with a player of each side east of it and a structure of each side among them.
type Unit = { x: number; y: number; team: number; structure: boolean }
const UNITS: Record<number, Unit> = {
  2: { x: 100, y: 0, team: 2, structure: false },
  3: { x: 150, y: 0, team: 2, structure: true },
  4: { x: 120, y: 10, team: 1, structure: true },
  5: { x: 80, y: 0, team: 1, structure: false },
}
const ENEMY_PLAYER = 2
const ENEMY_STRUCTURE = 3
const ALLY_STRUCTURE = 4
const ALLY_PLAYER = 5
const crowd = {
  tick: 100,
  character: (id: number) => (id === 1 ? { team: 1, structure: false, champion: { radius: 20 } } : UNITS[id] && { team: UNITS[id].team, structure: UNITS[id].structure, champion: { radius: 20 } }),
  posAt: (id: number) => (id === 1 ? { x: 0, y: 0 } : UNITS[id] && { x: UNITS[id].x, y: UNITS[id].y }),
  unitsInRadius: (center: Vector2, reach: number) =>
    Object.keys(UNITS).map(Number).filter((id) => Math.hypot(UNITS[id].x - center.x, UNITS[id].y - center.y) <= reach + 20),
} as unknown as SimContext
const SIXTY = { cos: 0.8660254037844387, sin: 0.5 }
const sourceOf = (id: string): EffectSource => ({
  id,
  rootId: id,
  ownerId: 1,
  tick: 100,
  at: { x: 0, y: 0 },
  aim: { mode: 'direction', dir: { x: 1, y: 0 } },
  subject: null,
})
const ABILITY = sourceOf('c:1:1')
const AUTO = sourceOf(`${ATTACK_SOURCE_PREFIX}1:1:t100`)

test('a blast, a line, a cone and a box pick up the enemy players of an ability and not its structures, and an auto attack\'s pick them up too', () => {
  const selectors: Array<[string, (src: EffectSource) => number[]]> = [
    ['radius', (src) => enemiesInRadius(300)(crowd, src)],
    ['line', (src) => enemiesInLine(300, 30)(crowd, src)],
    ['cone', (src) => enemiesInCone(300, SIXTY)(crowd, src)],
    ['box', (src) => enemiesInBox(200, 30)(crowd, src)],
  ]
  for (const [name, select] of selectors) {
    assert.deepEqual(select(ABILITY), [ENEMY_PLAYER], `${name}: an ability goes through the structure`)
    assert.deepEqual(select(AUTO), [ENEMY_PLAYER, ENEMY_STRUCTURE], `${name}: an auto attack does not`)
  }
})

test('the allies an ability picks up are not structures either', () => {
  assert.deepEqual(alliesInRadius(300)(crowd, ABILITY), [ALLY_PLAYER])
  assert.deepEqual(alliesInRadius(300)(crowd, AUTO), [ALLY_STRUCTURE, ALLY_PLAYER])
})

test('it is the id of the source that says whether it is an auto attack\'s, and what an attack leaves behind is made from it', () => {
  const attackId = `${ATTACK_SOURCE_PREFIX}1:4:t120`
  assert.equal(touchesStructures(attackId), true)
  assert.equal(touchesStructures(`${attackId}:auto-shot:600:6:u2:t130`), true, 'a shot in the air')
  assert.equal(touchesStructures('c:1:4'), false)
  assert.equal(touchesStructures('c:1:4:t-ats-shot:u2:t120'), false, 'what an ability leaves behind')
  assert.equal(touchesStructures('i:poison:1'), false)
})
