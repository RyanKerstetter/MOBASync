import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  alliesInRadius,
  attackDamage,
  burn,
  damage,
  enemiesInRadius,
  GAME_STARTING_GOLD,
  heal,
  knockback,
  loseHealth,
  mark,
  root,
  shieldedStructures,
  Simulator,
  slow,
  statMultiplier,
  STRUCTURE_ARCANE_DAMAGE,
  stun,
  type StructureRef,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { brawler, defineAbility, defineChampion, defineMonster, defineTurret, economySimulator } from './fixtures.ts'

// What turrets and cores have in common (see structures.ts), which is everything, as a core is the highest tier of turret: they are hurt by attacks only and take no
// status, and while what guards them is standing they take no damage at all. The tiers and cores here are the tests' own (numbers the game does not use), so retuning the real
// ones changes nothing.

const post = { base: { maxHp: 400, attackDamage: 10, attackSpeed: 1 }, radius: 30, attackRange: 300, attackWindup: 0 }
const front = defineTurret(610, post)
const back = defineTurret(620, post)
const last = defineTurret(630, post)
// Goes down in one hit (100 health), and a sturdy one behind it that a splash can be seen to hurt or not.
const weak = defineTurret(64, { ...post, base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 }, attackRange: 200 })
const sturdy = defineTurret(65, { ...post, base: { maxHp: 400, attackDamage: 1, attackSpeed: 1 }, attackRange: 200 })
const plain = defineTurret(66, { ...post, base: { maxHp: 1000, attackDamage: 1, attackSpeed: 1 }, attackRange: 400 })

// A core is protected by the turrets of its team of lower tiers than its own: one is above the front turret and below the back one (so it waits for the front one
// alone), one is above them both, and one is below them both, and so waits for nothing. They reach no one (a range of 1), so there is only the breaking of them.
const coreBody = { base: { maxHp: 300, attackDamage: 1, attackSpeed: 1 }, radius: 40, attackRange: 1, attackWindup: 0, core: true } as const
const coreAfterFront = defineTurret(615, coreBody)
const coreAfterBoth = defineTurret(625, coreBody)
const coreOpen = defineTurret(605, { ...coreBody, reward: { gold: 40, xp: 30, shards: 1 } })

const slayer = defineChampion({ ...brawler, id: 't-ss-slayer', base: { ...brawler.base, attackDamage: 5000 }, abilities: [] })
// An auto that splashes everyone of another team for 150 as well, so what a hit does to a structure that is not its target can be seen.
const splasher = defineChampion({
  ...brawler,
  id: 't-ss-splasher',
  base: { ...brawler.base, attackDamage: 10 },
  abilities: [],
  onAttackHit: [damage(attackDamage()), damage(150, enemiesInRadius(3000))],
})
// An auto that is a shot, which takes time to arrive.
const archer = defineChampion({
  ...brawler,
  id: 't-ss-archer',
  base: { ...brawler.base, attackDamage: 100 },
  abilities: [],
  attackProjectile: { speed: 600, radius: 6 },
})

const cast = (seq: number, tick: number, abilityId: string, origin: Vector2) =>
  ({ id: `c${seq}`, seq, tick, type: 'cast' as const, abilityId, target: { mode: 'none' as const }, origin })
const attack = (id: number, tick: number, targetId: number) => ({ id: `a${id}:${tick}`, seq: tick, tick, type: 'attack' as const, targetId })
const walk = (id: number, tick: number, target: Vector2) => ({ id: `w${id}:${tick}`, seq: tick, tick, type: 'move' as const, target })
const player = (simulator: Simulator, id: number, at: Vector2, team: number, champion = brawler): void => {
  simulator.addPlayer(id, `p${id}`, `Player ${id}`, at, champion, team)
}
const health = (simulator: Simulator, tick: number, id: number): number | undefined => simulator.at(tick).get(id)?.getHealth()
const dead = (simulator: Simulator, tick: number, id: number): boolean => simulator.at(tick).get(id)?.isDead() === true

// ---------------------------------------------------------------------------- who is protected

const turret = (id: number, team: number, tier: number): StructureRef => ({ id, team, tier, core: false })
const core = (id: number, team: number, tier: number): StructureRef => ({ id, team, tier, core: true })
const standingExcept = (...down: number[]) => (id: number): boolean => !down.includes(id)
const sorted = (set: ReadonlySet<number>): number[] => [...set].sort((left, right) => left - right)

test('a turret is protected while a turret of its team of a lower tier stands, so they fall in order of tier', () => {
  const all = [turret(1, 1, 1), turret(2, 1, 2), turret(3, 1, 3)]
  assert.deepEqual(sorted(shieldedStructures(all, standingExcept())), [2, 3], 'only the first is open')
  assert.deepEqual(sorted(shieldedStructures(all, standingExcept(1))), [3], 'with the first down the second is open, and the third waits for it')
  assert.deepEqual(sorted(shieldedStructures(all, standingExcept(1, 2))), [], 'and then all that is left')
  assert.deepEqual(sorted(shieldedStructures(all, standingExcept(2))), [3], 'the first stands, so the third waits (and the one that is down is protected from nothing)')
  assert.deepEqual(sorted(shieldedStructures([], standingExcept())), [])
})

test('a turret waits for every turret below it, even when a tier is missing, and tiers of the same level do not guard each other', () => {
  const gap = [turret(1, 1, 1), turret(2, 1, 3)]
  assert.deepEqual(sorted(shieldedStructures(gap, standingExcept())), [2], 'tier 3 waits for tier 1 when there is no tier 2')
  assert.deepEqual(sorted(shieldedStructures(gap, standingExcept(1))), [])
  const twins = [turret(1, 1, 1), turret(2, 1, 1), turret(3, 1, 2)]
  assert.deepEqual(sorted(shieldedStructures(twins, standingExcept())), [3], 'two of tier 1 are both open')
  assert.deepEqual(sorted(shieldedStructures(twins, standingExcept(1))), [3], 'and tier 2 waits for both')
  assert.deepEqual(sorted(shieldedStructures(twins, standingExcept(1, 2))), [])
})

test('only a turret of its own team guards a structure', () => {
  const both = [turret(1, 1, 1), turret(2, 2, 1), turret(3, 1, 2), turret(4, 2, 2)]
  assert.deepEqual(sorted(shieldedStructures(both, standingExcept())), [3, 4])
  assert.deepEqual(sorted(shieldedStructures(both, standingExcept(1))), [4], 'team 1\'s tier 1 falling opens team 1\'s tier 2 and not team 2\'s')
})

test('a core is protected while a turret of its team up to its guarding tier stands, and no other', () => {
  // A core of tier 2 waits for the turrets below it (tier 1), one of tier 3 for tiers 1 and 2, and one of tier 1 has none below it.
  const structures = [turret(1, 1, 1), turret(2, 1, 2), core(10, 1, 2), core(11, 1, 3), core(12, 1, 1)]
  assert.deepEqual(sorted(shieldedStructures(structures, standingExcept())), [2, 10, 11], 'a core with no turret of a lower tier is never protected')
  assert.deepEqual(sorted(shieldedStructures(structures, standingExcept(1))), [11], 'tier 1 down opens the core guarded by tier 1, and not the one that waits for tier 2')
  assert.deepEqual(sorted(shieldedStructures(structures, standingExcept(1, 2))), [])
  assert.deepEqual(sorted(shieldedStructures(structures, standingExcept(2))), [10, 11], 'tier 2 down does not open the core that tier 1 guards')
  const other = [turret(1, 2, 1), core(10, 1, 2)]
  assert.deepEqual(sorted(shieldedStructures(other, standingExcept())), [], 'a turret of another team guards nothing')
  assert.deepEqual(sorted(shieldedStructures([core(10, 1, 2)], standingExcept())), [], 'and a core with no turrets is open')
  // A core is the end of the chain: it guards nothing, even a turret of a higher tier than its own.
  assert.deepEqual(sorted(shieldedStructures([core(10, 1, 1), turret(1, 1, 2)], standingExcept())), [], 'a core protects no turret')
  assert.deepEqual(sorted(shieldedStructures([core(10, 1, 1), core(11, 1, 2)], standingExcept())), [], 'and no other core')
})

// ---------------------------------------------------------------------------- being protected, in a game

// Three turrets of team 1 in a column, 400 apart, each with an enemy champion that kills it in one hit standing 120 away.
function column(): Simulator {
  const simulator = economySimulator()
  simulator.addTurret(1, front, { x: 2000, y: 700 }, 1)
  simulator.addTurret(2, back, { x: 2000, y: 1100 }, 1)
  simulator.addTurret(3, last, { x: 2000, y: 1500 }, 1)
  player(simulator, 11, { x: 1880, y: 700 }, 2, slayer)
  player(simulator, 12, { x: 1880, y: 1100 }, 2, slayer)
  player(simulator, 13, { x: 1880, y: 1500 }, 2, slayer)
  return simulator
}

test('a protected turret cannot be attacked, so each falls only after the one below it, whoever is waiting at it', () => {
  const simulator = column()
  // All three are told to attack at once. Only the first can be attacked: the others are refused, and take nothing.
  simulator.addOrder(11, attack(11, 1, 1))
  simulator.addOrder(12, attack(12, 1, 2))
  simulator.addOrder(13, attack(13, 1, 3))
  for (let tick = 1; tick <= 30; tick += 1) simulator.at(tick)
  assert.equal(dead(simulator, 30, 1), true, 'the first is down')
  assert.deepEqual([health(simulator, 30, 2), health(simulator, 30, 3)], [400, 400], 'and the others are as they were')
  assert.equal(simulator.at(30).get(12)?.getAttackTarget(), undefined, 'the one told to attack the second has no one to attack')
  assert.equal(simulator.at(30).get(13)?.getAttackTarget(), undefined)

  // With the first down the second can be attacked, and the third, which is guarded by it, still cannot.
  simulator.addOrder(12, attack(12, 31, 2))
  simulator.addOrder(13, attack(13, 31, 3))
  for (let tick = 31; tick <= 60; tick += 1) simulator.at(tick)
  assert.equal(dead(simulator, 60, 2), true, 'the second is down')
  assert.equal(health(simulator, 60, 3), 400, 'the third is not')

  simulator.addOrder(13, attack(13, 61, 3))
  for (let tick = 61; tick <= 90; tick += 1) simulator.at(tick)
  assert.equal(dead(simulator, 90, 3), true, 'the third falls last')
  const fell = [1, 2, 3].map((id) => simulator.at(90).get(id)?.getDeathTick() as number)
  assert.ok(fell[0] < fell[1] && fell[1] < fell[2], `in order: ${fell.join(', ')}`)
})

test('a protected turret can still shoot', () => {
  const simulator = economySimulator()
  simulator.addTurret(1, front, { x: 2000, y: 700 }, 1)
  simulator.addTurret(2, back, { x: 2000, y: 1100 }, 1)
  player(simulator, 11, { x: 2150, y: 1100 }, 2)
  let hurt = false
  for (let tick = 1; tick <= 100; tick += 1) hurt ||= (health(simulator, tick, 11) ?? brawler.maxHp) < brawler.maxHp
  assert.ok(hurt, 'the second turret, protected by the first, shot the champion in its range')
  assert.equal(simulator.at(100).get(2)?.getAttackTarget(), 11)
  assert.equal(health(simulator, 100, 2), 400)
})

test('an order to attack what is protected changes nothing, so a walk goes on and no one stops to hit it', () => {
  const simulator = economySimulator()
  simulator.addTurret(1, front, { x: 2000, y: 700 }, 1)
  simulator.addTurret(2, back, { x: 2000, y: 1100 }, 1)
  player(simulator, 11, { x: 1000, y: 1100 }, 2, slayer)
  simulator.addOrder(11, walk(11, 1, { x: 1500, y: 1100 }))
  simulator.addOrder(11, attack(11, 5, 2))
  const frame = (tick: number) => simulator.at(tick).get(11)
  for (let tick = 1; tick <= 10; tick += 1) simulator.at(tick)
  assert.equal(frame(10)?.getAttackTarget(), undefined)
  assert.deepEqual(frame(10)?.getMoveTarget(), { x: 1500, y: 1100 }, 'still walking where it was sent')
})

test('nothing that is not an attack hurts a protected turret, and what an attack does to it is nothing as well', () => {
  const simulator = economySimulator()
  simulator.addTurret(1, weak, { x: 2000, y: 700 }, 1)
  simulator.addTurret(2, sturdy, { x: 2000, y: 900 }, 1)
  // The splasher hits the first turret, and with it everyone of another team within reach of it: the second too.
  player(simulator, 11, { x: 1880, y: 800 }, 2, splasher)
  simulator.addOrder(11, attack(11, 1, 1))
  for (let tick = 1; tick <= 30; tick += 1) simulator.at(tick)
  assert.equal(dead(simulator, 30, 1), true, 'the first turret fell to the hit, 160 against its 100')
  assert.equal(health(simulator, 30, 2), 400, 'the second was in the splash and took nothing while the first stood')
  // Now it is open: the same hit on it costs it 160.
  simulator.addOrder(11, attack(11, 31, 2))
  for (let tick = 31; tick <= 90; tick += 1) simulator.at(tick)
  assert.equal(health(simulator, 90, 2), 240, 'a hit that splashes it does take, 10 of its own and 150 of the splash')
})

// ---------------------------------------------------------------------------- only attacks

const REACH = 600
const blast = defineAbility({ id: 'ts-blast', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [damage(300, enemiesInRadius(REACH))] })
const drain = defineAbility({ id: 'ts-drain', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [loseHealth(200, enemiesInRadius(REACH))] })
const chill = defineAbility({ id: 'ts-chill', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [slow(0.5, 300, enemiesInRadius(REACH))] })
const freeze = defineAbility({ id: 'ts-freeze', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [stun(60, enemiesInRadius(REACH))] })
const pin = defineAbility({ id: 'ts-pin', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [root(300, enemiesInRadius(REACH))] })
const scorch = defineAbility({ id: 'ts-scorch', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [burn(40, 300, enemiesInRadius(REACH))] })
const brand = defineAbility({ id: 'ts-brand', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [mark('ts-brand', 300, enemiesInRadius(REACH))] })
const shove = defineAbility({ id: 'ts-shove', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [knockback(200, 900, enemiesInRadius(REACH))] })
const ABILITIES = [blast, drain, chill, freeze, pin, scorch, brand, shove].map((ability) => ability.id)
const caster = defineChampion({ ...brawler, id: 't-ss-caster', abilities: ABILITIES })
const dummy = defineChampion({ ...brawler, id: 't-ss-dummy', base: { ...brawler.base, maxHp: 3000 }, abilities: [] })

test('no ability does anything to a turret, though each does it to a champion standing beside it', () => {
  const simulator = economySimulator()
  simulator.addTurret(1, plain, { x: 1000, y: 700 }, 1)
  // The champion is 300 below the turret and the caster 400 to the side of it, so both are in reach of everything, and a shove sends the
  // champion west into the clear.
  player(simulator, 2, { x: 1000, y: 1000 }, 1, dummy)
  player(simulator, 3, { x: 1400, y: 1000 }, 2, caster)
  ABILITIES.forEach((abilityId, index) => simulator.addOrder(3, cast(index + 1, 2 + index * 2, abilityId, { x: 1400, y: 1000 })))
  const turretStatuses: string[] = []
  const turretMarkers: string[] = []
  let moved = false
  let dashed = false
  let dummyStatuses = new Set<string>()
  let dummyMarkers = new Set<string>()
  let dummyMoved = false
  let lowest = Infinity
  for (let tick = 1; tick <= 60; tick += 1) {
    const frame = simulator.at(tick)
    const turretFrame = frame.get(1)
    turretStatuses.push(...(turretFrame?.getStatuses() ?? []).map((status) => status.kind))
    turretMarkers.push(...(turretFrame?.getMarkers() ?? []).map((marker) => marker.key))
    moved ||= turretFrame?.getPosition().x !== 1000 || turretFrame?.getPosition().y !== 700
    dashed ||= turretFrame?.isDashing() === true
    dummyStatuses = new Set([...dummyStatuses, ...(frame.get(2)?.getStatuses() ?? []).map((status) => status.kind)])
    dummyMarkers = new Set([...dummyMarkers, ...(frame.get(2)?.getMarkers() ?? []).map((marker) => marker.key)])
    dummyMoved ||= (frame.get(2)?.getPosition().x ?? 1000) < 900
    lowest = Math.min(lowest, frame.get(2)?.getHealth() ?? Infinity)
  }
  // The champion had all of it done to it, so the casts were all made and each does what it says...
  assert.ok(lowest <= dummy.maxHp - 500, `the champion took the damage and the health cost: ${lowest}`)
  assert.deepEqual([...dummyStatuses].sort(), ['burn', 'root', 'slow', 'stun'])
  assert.deepEqual([...dummyMarkers], ['ts-brand'])
  assert.equal(dummyMoved, true, 'and was shoved')
  // ...and the turret none of it.
  assert.equal(health(simulator, 60, 1), plain.champion.maxHp, 'no health lost, from damage or from a cost')
  assert.deepEqual(turretStatuses, [], 'no slow, stun, root or burn')
  assert.deepEqual(turretMarkers, [], 'and no mark')
  assert.equal(moved, false, 'it was not shoved')
  assert.equal(dashed, false)
})

test('a turret that an attack has hurt is not healed by an ability, though a champion beside it is', () => {
  const bloodheal = defineAbility({
    id: 'ts-bloodheal',
    targeting: 'none',
    range: 0,
    windUpTicks: 0,
    backswingTicks: 0,
    cooldownTicks: 600,
    apply: [loseHealth(300), heal(200, alliesInRadius(REACH))],
  })
  const healer = defineChampion({ ...brawler, id: 't-ss-healer', abilities: [bloodheal.id] })
  const hitter = defineChampion({ ...brawler, id: 't-ss-hitter', base: { ...brawler.base, attackDamage: 100 }, abilities: [] })
  const simulator = economySimulator()
  simulator.addTurret(1, plain, { x: 1000, y: 700 }, 1)
  player(simulator, 2, { x: 1120, y: 700 }, 1, healer)
  player(simulator, 3, { x: 1100, y: 780 }, 2, hitter)
  simulator.addOrder(3, attack(3, 1, 1))
  simulator.addOrder(3, walk(3, 20, { x: 1100, y: 780 }))
  for (let tick = 1; tick <= 25; tick += 1) simulator.at(tick)
  const hurt = health(simulator, 25, 1) as number
  assert.ok(hurt < plain.champion.maxHp, 'the attack hurt it')
  simulator.addOrder(2, cast(1, 26, bloodheal.id, { x: 1120, y: 700 }))
  for (let tick = 26; tick <= 40; tick += 1) simulator.at(tick)
  assert.equal(health(simulator, 40, 2), brawler.maxHp - 300 + 200, 'the champion paid 300 and was healed 200')
  assert.equal(health(simulator, 40, 1), hurt, 'the turret was not healed')
})

test('an auto attack that is a shot hurts a turret when it lands, and a turret\'s resistance takes its share off', () => {
  const simulator = economySimulator()
  const tough = defineTurret(67, { ...post, base: { maxHp: 1000, attackDamage: 1, attackSpeed: 1, resistance: 100 }, attackRange: 100 })
  simulator.addTurret(1, tough, { x: 1000, y: 700 }, 1)
  player(simulator, 2, { x: 1150, y: 700 }, 2, archer)
  simulator.addOrder(2, attack(2, 1, 1))
  let flew = false
  for (let tick = 1; tick <= 30; tick += 1) {
    flew ||= simulator.at(tick).getEntities().length > 0
  }
  assert.ok(flew, 'a shot was in the air')
  assert.equal(health(simulator, 30, 1), 1000 - 50, '100 against a resistance of 100 is 50')
})

// ---------------------------------------------------------------------------- cores

function base(coreType = coreAfterFront): Simulator {
  const simulator = economySimulator()
  simulator.addTurret(1, front, { x: 1800, y: 700 }, 1)
  simulator.addTurret(2, back, { x: 1800, y: 1100 }, 1)
  simulator.addTurret(3, coreType, { x: 2200, y: 900 }, 1)
  player(simulator, 11, { x: 2000, y: 900 }, 2, slayer)
  return simulator
}

// Runs the ticks from `from` to `to`, in order, which is how a game plays and the only way an order can be given at a tick in the middle.
function run(simulator: Simulator, from: number, to: number): void {
  for (let tick = from; tick <= to; tick += 1) simulator.at(tick)
}

test('a core is protected until the turrets that guard it are down, and is then hurt by attacks and nothing else', () => {
  const simulator = base()
  simulator.addOrder(11, attack(11, 1, 3))
  run(simulator, 1, 60)
  assert.equal(health(simulator, 60, 3), coreAfterFront.champion.maxHp, 'the core takes nothing while the first turret stands')
  assert.equal(simulator.at(60).get(11)?.getAttackTarget(), undefined)

  // The first turret falls, and the core, which only that one guards, is open, though the second turret is still up.
  simulator.addOrder(11, attack(11, 61, 1))
  run(simulator, 61, 160)
  assert.equal(dead(simulator, 160, 1), true)
  assert.equal(dead(simulator, 160, 2), false)
  simulator.addOrder(11, attack(11, 161, 3))
  run(simulator, 161, 260)
  assert.equal(dead(simulator, 260, 3), true, 'the core is down')
})

test('a core of a higher tier waits for every turret below it, and one with none below it is never protected', () => {
  const both = base(coreAfterBoth)
  both.addOrder(11, attack(11, 1, 1))
  run(both, 1, 100)
  assert.equal(dead(both, 100, 1), true)
  both.addOrder(11, attack(11, 101, 3))
  run(both, 101, 200)
  assert.equal(health(both, 200, 3), coreAfterBoth.champion.maxHp, 'still protected, as the second turret stands')
  both.addOrder(11, attack(11, 201, 2))
  run(both, 201, 330)
  assert.equal(dead(both, 330, 2), true)
  both.addOrder(11, attack(11, 331, 3))
  run(both, 331, 450)
  assert.equal(dead(both, 450, 3), true, 'and open when both are down')

  const open = base(coreOpen)
  open.addOrder(11, attack(11, 1, 3))
  run(open, 1, 60)
  assert.equal(dead(open, 60, 3), true, 'a core guarded by no turret is hurt at once')
})

test('a core does not move, reaches no one when it has no reach, never comes back, is solid until it is broken, and pays its reward to the player who breaks it', () => {
  const simulator = base(coreOpen)
  const at = { x: 2200, y: 900 }
  // Solid: a player walking into it is held off, and it stays put.
  player(simulator, 12, { x: 2340, y: 900 }, 1, dummy)
  simulator.addOrder(12, walk(12, 1, at))
  for (let tick = 1; tick <= 120; tick += 1) simulator.at(tick)
  const walker = simulator.at(120).get(12)?.getPosition() as Vector2
  assert.ok(Math.hypot(walker.x - at.x, walker.y - at.y) >= coreOpen.champion.radius + dummy.radius - 3, 'held off by its body')
  assert.deepEqual(simulator.at(120).get(3)?.getPosition(), at)
  assert.equal(simulator.at(120).get(3)?.getAttackTarget(), undefined, 'it attacks no one')
  assert.equal(health(simulator, 120, 12), dummy.maxHp, 'and nothing of its team\'s hurt a teammate')

  // Broken: it stays broken for far longer than any respawn, and is no longer in the way.
  simulator.addOrder(11, attack(11, 121, 3))
  run(simulator, 121, 200)
  const fell = simulator.at(200).get(3)?.getDeathTick()
  assert.ok(fell !== undefined)
  simulator.advanceTo(1200)
  assert.equal(simulator.at(1200).get(3)?.getDeathTick(), fell, 'it never comes back')
  simulator.setCommitTick(1200)
  const breaker = simulator.characters.get(11)
  assert.deepEqual([simulator.at(1200).get(11)?.getGold(), breaker?.shards, breaker?.kills], [GAME_STARTING_GOLD + 40, 1, 0], 'its reward in gold and shards, and not a kill')
  assert.equal(simulator.at(1200).get(11)?.getXp(), 30, 'and its experience')
})

test('no monster goes after a core, or a turret, whatever is in its range', () => {
  const watcher = defineMonster({
    id: 't-ss-watcher',
    name: 'Watcher',
    base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
    moveSpeed: 200,
    radius: 20,
    attackRange: 60,
    attackWindup: 0,
    abilities: [],
    ai: { aggroRange: 900 },
  })
  const simulator = economySimulator()
  simulator.addTurret(1, coreOpen, { x: 1000, y: 700 }, 1)
  simulator.addTurret(2, plain, { x: 1100, y: 800 }, 1)
  simulator.addMonster(3, watcher, { x: 1300, y: 700 })
  for (let tick = 1; tick <= 200; tick += 1) simulator.at(tick)
  assert.deepEqual(simulator.at(200).get(3)?.getAi(), { mode: 'idle' })
  assert.deepEqual(simulator.at(200).get(3)?.getPosition(), { x: 1300, y: 700 })
  assert.deepEqual([health(simulator, 200, 1), health(simulator, 200, 2)], [coreOpen.champion.maxHp, plain.champion.maxHp])
})

// ---------------------------------------------------------------------------- what the page makes of it

test('the page marks a protected structure, and does not offer it as something to attack, until it is open', () => {
  const state = new ClientGameState()
  state.simulator.addTurret(10, front, { x: 1000, y: 700 }, 1)
  state.simulator.addTurret(11, back, { x: 1000, y: 1100 }, 1)
  player(state.simulator, 1, { x: 1150, y: 800 }, 2, slayer)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  const flagged = (): Array<[number, boolean]> => state.getCharacters(0)
    .filter((character) => character.turret)
    .map((character): [number, boolean] => [character.id, character.invulnerable === true])
  assert.deepEqual(flagged(), [[10, false], [11, true]], 'the second is protected by the first')
  assert.equal(state.getEnemyNear({ x: 1000, y: 1100 }, 0), undefined, 'so it cannot be clicked on')
  assert.equal(state.getEnemyNear({ x: 1000, y: 700 }, 0)?.id, 10, 'though the first can')
  assert.equal(state.getClosestEnemy({ x: 1000, y: 1090 }, 0)?.id, 10, 'and Space picks the first, though the mouse is on the second')

  // Once the first is down, the second is open.
  state.simulator.addOrder(1, { id: '1:1', seq: 1, tick: 4, type: 'attack', targetId: 10 })
  for (let tick = 4; tick <= 60; tick += 1) state.simulator.advanceTo(tick)
  assert.deepEqual(state.getCharacters(0).filter((character) => character.turret).map((character) => [character.id, character.dead, character.invulnerable === true]), [
    [10, true, false],
    [11, false, false],
  ])
  assert.equal(state.getEnemyNear({ x: 1000, y: 1100 }, 0)?.id, 11, 'and it can be clicked on')
})

// ---------------------------------------------------------------------------- arcane against structures

// An attack on a structure deals damage for each point of the attacker's arcane on top of its own (`STRUCTURE_ARCANE_DAMAGE`), once for the
// whole attack. The champions and structures in these are the tests' own, with every number spelled out; the only thing read from the game is
// how much damage a point of arcane does to a structure.
const ARCANE = 40
const ATTACK = 50
const noArcane = { skip: STRUCTURE_ARCANE_DAMAGE <= 0 && 'arcane does nothing to structures' }
const bareHanded = defineChampion({ ...brawler, id: 't-ss-bare', base: { ...brawler.base, attackDamage: ATTACK, arcane: 0 }, abilities: [] })
const mage = defineChampion({ ...brawler, id: 't-ss-mage', base: { ...brawler.base, attackDamage: ATTACK, arcane: ARCANE }, abilities: [] })
// Two hits in one attack, which still adds the arcane once.
const twoHits = defineChampion({
  ...brawler,
  id: 't-ss-two-hits',
  base: { ...brawler.base, attackDamage: ATTACK, arcane: ARCANE },
  abilities: [],
  onAttackHit: [damage(attackDamage()), damage(25)],
})
const bulky = defineTurret(68, { base: { maxHp: 100_000, attackDamage: 1, attackSpeed: 1 }, radius: 30, attackRange: 200, attackWindup: 0 })
const bulkyCore = defineTurret(660, { base: { maxHp: 100_000, attackDamage: 1, attackSpeed: 1 }, radius: 40, attackRange: 1, attackWindup: 0, core: true })
const armoured = defineTurret(69, { base: { maxHp: 100_000, attackDamage: 1, attackSpeed: 1, resistance: 100 }, radius: 30, attackRange: 200, attackWindup: 0 })

// What the first attack of `champion` on a structure (a turret or a core) at the same spot takes off its health.
function firstHitOn(champion: typeof mage, structure: 'turret' | 'core' | 'armoured'): number {
  const simulator = economySimulator()
  const target = structure === 'turret' ? bulky : structure === 'armoured' ? armoured : bulkyCore
  if (structure === 'core') simulator.addTurret(1, bulkyCore, { x: 1000, y: 700 }, 1)
  else simulator.addTurret(1, target as typeof bulky, { x: 1000, y: 700 }, 1)
  player(simulator, 2, { x: 1080, y: 700 }, 2, champion)
  simulator.addOrder(2, attack(2, 1, 1))
  const landing = 1 + champion.attackWindupTicks
  return target.champion.maxHp - (health(simulator, landing, 1) as number)
}

test('an attack on a turret or a core deals a point of damage for each point of arcane behind it, on top of its own', noArcane, () => {
  for (const structure of ['turret', 'core'] as const) {
    assert.equal(firstHitOn(bareHanded, structure), ATTACK, `with no arcane it is just the attack, on a ${structure}`)
    assert.equal(firstHitOn(mage, structure), ATTACK + ARCANE * STRUCTURE_ARCANE_DAMAGE, `and with ${ARCANE} arcane it is more, on a ${structure}`)
  }
})

test('the arcane is added once for the whole attack, however many hits the attack has', noArcane, () => {
  assert.equal(firstHitOn(twoHits, 'turret'), ATTACK + 25 + ARCANE * STRUCTURE_ARCANE_DAMAGE)
})

test("a structure's resistance takes its share off the arcane as it does off the rest of the attack", noArcane, () => {
  const resistance = armoured.champion.statsAt(1).resistance
  assert.equal(firstHitOn(mage, 'armoured'), Math.round((ATTACK + ARCANE * STRUCTURE_ARCANE_DAMAGE) * statMultiplier(resistance)))
  assert.ok(firstHitOn(mage, 'armoured') > firstHitOn(bareHanded, 'armoured'), 'and it is still more than none')
})

test('arcane adds nothing to an attack on a champion, or on a structure that is protected', () => {
  const duelFor = (champion: typeof mage): number => {
    const simulator = economySimulator()
    player(simulator, 1, { x: 1000, y: 700 }, 1, brawler)
    player(simulator, 2, { x: 1060, y: 700 }, 2, champion)
    simulator.addOrder(2, attack(2, 1, 1))
    return brawler.maxHp - (health(simulator, 1 + champion.attackWindupTicks, 1) as number)
  }
  assert.equal(duelFor(mage), duelFor(bareHanded), 'a champion takes the attack and no more, whatever arcane it comes from')
  assert.equal(duelFor(mage), ATTACK)

  // The second of two turrets waits for the first, so an attack on it does nothing, with arcane or without.
  const simulator = economySimulator()
  simulator.addTurret(1, front, { x: 1000, y: 700 }, 1)
  simulator.addTurret(2, back, { x: 1000, y: 1100 }, 1)
  player(simulator, 3, { x: 1080, y: 1100 }, 2, mage)
  simulator.addOrder(3, attack(3, 1, 2))
  assert.equal(health(simulator, 60, 2), back.champion.maxHp, 'a protected turret is not hurt')
})
