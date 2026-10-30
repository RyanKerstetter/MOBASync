import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  chooseTurretTarget,
  DEFAULT_TURRET_REWARD,
  enemiesInRadius,
  flattenLayers,
  GAME_ART_SCALE,
  GAME_MAX_PLAYERS,
  GAME_STARTING_GOLD,
  GAME_VISION_RANGE,
  GameSnapshotSchema,
  getCharacterChampion,
  getProperty,
  getTurret,
  knockback,
  objectiveScores,
  parseTiledMap,
  readMapLayout,
  Simulator,
  stun,
  targetUnit,
  Terrain,
  Turret,
  TURRET_TIERS,
  turretId,
  turrets,
  turretTiers,
  champions,
  damage,
  type DeathRecord,
  type TurretPrey,
  type TurretTierDef,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { brawler, defineAbility, defineChampion, defineMonster, defineTurret, economySimulator } from './fixtures.ts'
import { testSpawns } from './test-spawns.ts'

// Turrets: structures the map puts on the ground, each of a tier, for a team. A turret shoots the enemy players in its range, cannot be
// moved, and can be destroyed by the other teams. The tiers the tests use are their own (high numbers, with every number spelled out), so
// retuning the real ones in turrets.ts changes nothing here.

const gun = defineTurret(91, {
  base: { maxHp: 2000, attackDamage: 50, attackSpeed: 1 },
  radius: 30,
  attackRange: 400,
  attackWindup: 0.1,
  reward: { gold: 70, xp: 30, shards: 2 },
})
// Hits for little and hurts a hit by a half: a target that can be hit six times before it is down, and that does not kill a player.
const bag = defineTurret(93, {
  base: { maxHp: 300, attackDamage: 10, attackSpeed: 1, resistance: 100 },
  radius: 30,
  attackRange: 400,
  attackWindup: 0,
})
// Goes down in one hit.
const brittle = defineTurret(94, {
  base: { maxHp: 100, attackDamage: 10, attackSpeed: 1 },
  radius: 30,
  attackRange: 400,
  attackWindup: 0,
  reward: { gold: 70, xp: 30, shards: 2 },
})
// Fires a shot, which takes time to arrive.
const bolter = defineTurret(92, {
  base: { maxHp: 2000, attackDamage: 50, attackSpeed: 1 },
  radius: 30,
  attackRange: 400,
  attackWindup: 0.1,
  attackProjectile: { speed: 300, radius: 8, color: '#ffd166' },
})

defineAbility({ id: 't-tu-shove', targeting: 'unit', range: 500, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 60, apply: [knockback(300, 900, targetUnit())] })
defineAbility({ id: 't-tu-stun', targeting: 'unit', range: 500, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [stun(120, targetUnit())] })
defineAbility({ id: 't-tu-blast', targeting: 'none', range: 0, windUpTicks: 0, backswingTicks: 0, cooldownTicks: 600, apply: [damage(200, enemiesInRadius(400))] })
const shover = defineChampion({ ...brawler, id: 't-tu-shover', abilities: ['t-tu-shove'] })
const stunner = defineChampion({ ...brawler, id: 't-tu-stunner', abilities: ['t-tu-stun'] })
const blaster = defineChampion({ ...brawler, id: 't-tu-blaster', abilities: ['t-tu-blast'] })
// Dies in two shots of the gun.
const glass = defineChampion({ ...brawler, id: 't-tu-glass', base: { ...brawler.base, maxHp: 100 }, abilities: [] })

const TURRET = 1
const ENEMY = 2
const ALLY = 3
const OTHER = 4
const AT = { x: 1000, y: 700 }

function world(tier: Turret = gun, team = 1): Simulator {
  const simulator = economySimulator()
  simulator.addTurret(TURRET, tier, AT, team)
  return simulator
}
const player = (simulator: Simulator, id: number, at: Vector2, team: number, champion = brawler): void => {
  simulator.addPlayer(id, `p${id}`, `Player ${id}`, at, champion, team)
}
const walk = (id: number, tick: number, target: Vector2) => ({ id: `w${id}:${tick}`, seq: tick, tick, type: 'move' as const, target })
const attack = (id: number, tick: number, targetId: number) => ({ id: `a${id}:${tick}`, seq: tick, tick, type: 'attack' as const, targetId })
const health = (simulator: Simulator, tick: number, id: number): number | undefined => simulator.at(tick).get(id)?.getHealth()

// When a character's health went down, and by how much, over ticks 1 to `last`.
function drops(simulator: Simulator, id: number, last: number): Array<{ tick: number; amount: number }> {
  const found: Array<{ tick: number; amount: number }> = []
  let before = health(simulator, 0, id) ?? 0
  for (let tick = 1; tick <= last; tick += 1) {
    const now = health(simulator, tick, id) ?? 0
    if (now < before) found.push({ tick, amount: before - now })
    before = now
  }
  return found
}
const distance = (left: Vector2, right: Vector2): number => Math.hypot(left.x - right.x, left.y - right.y)

// ---------------------------------------------------------------------------- the tiers

test('every tier in the table is a turret of its own: an immobile body that is no champion, with every number it needs', () => {
  const tiers = Object.keys(TURRET_TIERS).map(Number)
  assert.ok(tiers.includes(1) && tiers.includes(2), 'the map\'s tiers are there')
  for (const tier of tiers) {
    const turret = getTurret(tier)
    assert.equal(turret.tier, tier)
    assert.equal(turret.id, turretId(tier))
    assert.equal(turret.id, `turret-${tier}`)
    assert.equal(turrets.get(turret.id), turret)
    const body = turret.champion
    assert.equal(body.id, turret.id)
    assert.equal(body.moveSpeed, 0, 'it stands where it is put')
    assert.deepEqual([...body.abilities], [], 'it casts nothing')
    for (const [what, value] of Object.entries({ health: body.maxHp, damage: body.attackDamage, speed: body.attackSpeed, range: body.attackRange, size: body.radius })) {
      assert.ok(value > 0, `tier ${tier} has ${what}`)
    }
    assert.ok(body.attackRange > body.radius, `tier ${tier} reaches out of its own body`)
    assert.ok(turret.visionRange > 0, `tier ${tier} sees`)
    // A tier has no name or description to set: it is called by its tier (or `Core`, for the core), which is only for the killfeed, and none is drawn over it.
    assert.equal(turret.name, turret.core ? 'Core' : `Tier ${tier} Turret`)
    assert.equal(body.description, '')
    assert.ok(!('name' in TURRET_TIERS[tier]) && !('description' in TURRET_TIERS[tier]), `tier ${tier} has neither in its entry`)
    for (const amount of Object.values(turret.reward)) assert.ok(Number.isInteger(amount) && amount >= 0)
    // Nobody can pick one, and a snapshot finds it by its id.
    assert.equal(champions.has(turret.id), false)
    assert.equal(getCharacterChampion(turret.id), body)
  }
  // The tiers a map's turret points can name are these without the core's, lowest first.
  const mapTiers = tiers.filter((tier) => !TURRET_TIERS[tier].core)
  assert.deepEqual(turretTiers().filter((tier) => tiers.includes(tier)), [...mapTiers].sort((left, right) => left - right), 'lowest first, and not the core\'s')
  assert.throws(() => getTurret(1000), /Unknown turret tier 1000/)
  assert.throws(() => getCharacterChampion('turret-1000'), /Unknown champion, monster or turret "turret-1000"/)
})

test('a tier is tuned by its entry: its health, damage, speed, resistance, range, size, windup and reward are what it says', () => {
  const tuned = defineTurret(95, {
    base: { maxHp: 1234, attackDamage: 77, attackSpeed: 0.5, resistance: 40 },
    radius: 33,
    attackRange: 444,
    visionRange: 480,
    attackWindup: 0.075,
    attackProjectile: { speed: 500, radius: 7, color: '#123456' },
    reward: { gold: 11, xp: 22, shards: 3 },
  })
  assert.equal(tuned.name, 'Tier 95 Turret', 'it is called by its tier')
  assert.equal(tuned.champion.description, '')
  assert.equal(tuned.visionRange, 480)
  assert.deepEqual(tuned.champion.statsAt(1), {
    maxHp: 1234, attackDamage: 77, attackSpeed: 0.5, resistance: 40, haste: 0, arcane: 0, attackRange: 444, moveSpeed: 0,
  })
  assert.equal(tuned.champion.radius, 33)
  assert.equal(tuned.champion.attackWindup, 0.075, 'its windup is a share of the attack')
  assert.equal(tuned.champion.attackWindupTicks, 9, 'and is that share of an attack that takes 120 ticks')
  assert.deepEqual(tuned.champion.attackProjectile, { speed: 500, radius: 7, color: '#123456' })
  assert.equal(tuned.champion.attackCooldownTicks, 120, 'half an attack a second is one every two')
  assert.deepEqual({ ...tuned.reward }, { gold: 11, xp: 22, shards: 3 })
  // A turret never levels, so it has no growth.
  assert.deepEqual(tuned.champion.statsAt(18), tuned.champion.statsAt(1))
  // What a tier leaves out of how far it sees is how far a champion does.
  assert.equal(defineTurret(96, tierOf(tuned)).visionRange, GAME_VISION_RANGE)
  // What a tier leaves out of its reward is the default.
  assert.deepEqual({ ...defineTurret(96, { ...tierOf(tuned), reward: undefined }).reward }, { ...DEFAULT_TURRET_REWARD })
  assert.deepEqual({ ...defineTurret(97, { ...tierOf(tuned), reward: { gold: 5 } }).reward }, { gold: 5, xp: DEFAULT_TURRET_REWARD.xp, shards: DEFAULT_TURRET_REWARD.shards })
})

function tierOf(turret: Turret): TurretTierDef {
  const { champion } = turret
  return {
    base: { maxHp: champion.maxHp, attackDamage: champion.attackDamage, attackSpeed: champion.attackSpeed },
    radius: champion.radius,
    attackRange: champion.attackRange,
    attackWindup: champion.attackWindup,
  }
}

test('a tier that is not right says what is wrong', () => {
  const fine = tierOf(gun)
  assert.throws(() => new Turret(0, fine), /Turret tier 0 needs a tier that is a whole number, 1 or more/)
  assert.throws(() => new Turret(1.5, fine), /needs a tier that is a whole number/)
  assert.throws(() => new Turret(98, { ...fine, radius: 0 }), /Turret tier 98 needs a radius that is more than 0/)
  assert.throws(() => new Turret(98, { ...fine, attackRange: -5 }), /needs a range that is more than 0/)
  for (const visionRange of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new Turret(98, { ...fine, visionRange }), /Turret tier 98 needs a vision range that is more than 0/, String(visionRange))
  }
  for (const attackWindup of [1.5, -0.1, Number.NaN]) {
    assert.throws(() => new Turret(98, { ...fine, attackWindup }), /needs a windup that is a share of the attack, from 0 to 1/, String(attackWindup))
  }
  assert.throws(() => new Turret(98, { ...fine, reward: { gold: -1 } }), /needs a reward of gold that is a whole number, 0 or more/)
  assert.throws(() => new Turret(98, { ...fine, reward: { xp: 2.5 } }), /needs a reward of xp that is a whole number/)
  assert.throws(() => new Turret(98, { ...fine, base: { maxHp: -1, attackDamage: 1, attackSpeed: 1 } }), /Champion "turret-98" has base stats that are wrong: it needs a maxHp that is a number, 0 or more/)
  defineChampion({ ...brawler, id: 'turret-99' })
  assert.throws(() => new Turret(99, fine), /Turret tier 99 has the id of a champion/)
})

// ---------------------------------------------------------------------------- who a turret shoots

const prey = (id: number, team: number, x: number, extra: Partial<TurretPrey> = {}): TurretPrey => ({ id, team, position: { x, y: 0 }, alive: true, ...extra })
const body = (attacking?: number, range = 400) => ({ team: 1, position: { x: 0, y: 0 }, range, attacking })

test('a turret picks the nearest living enemy in its range, and no one else', () => {
  assert.equal(chooseTurretTarget(body(), []), undefined)
  assert.equal(chooseTurretTarget(body(), [prey(5, 2, 300), prey(6, 2, 100), prey(7, 2, 200)]), 6, 'the nearest')
  assert.equal(chooseTurretTarget(body(), [prey(5, 1, 50), prey(6, 2, 300)]), 6, 'never its own team')
  assert.equal(chooseTurretTarget(body(), [prey(5, 2, 50, { alive: false }), prey(6, 2, 300)]), 6, 'never the dead')
  assert.equal(chooseTurretTarget(body(), [prey(5, 2, 450)]), undefined, 'none out of its range')
  assert.equal(chooseTurretTarget(body(), [prey(5, 2, 400)]), 5, 'one just in its range is in it')
  assert.equal(chooseTurretTarget(body(undefined, 399), [prey(5, 2, 400)]), undefined, 'and a little further is out')
  // Two as near as each other: the lower id, whatever order they are given in.
  assert.equal(chooseTurretTarget(body(), [prey(9, 2, -100), prey(4, 2, 100)]), 4)
  assert.equal(chooseTurretTarget(body(), [prey(4, 2, 100), prey(9, 2, -100)]), 4)
  // From where it stands, in any direction.
  assert.equal(chooseTurretTarget({ team: 1, position: { x: 100, y: 100 }, range: 50, attacking: undefined }, [{ id: 5, team: 2, position: { x: 130, y: 140 }, alive: true }]), 5, '50 away on the slant')
})

test('a turret keeps shooting the one it is shooting while they are alive and in its range, even with a nearer one, and then goes to the nearest', () => {
  const others = [prey(5, 2, 300), prey(6, 2, 100)]
  assert.equal(chooseTurretTarget(body(5), others), 5, 'it stays on 5 though 6 is nearer')
  assert.equal(chooseTurretTarget(body(5), [prey(5, 2, 450), prey(6, 2, 100)]), 6, 'until 5 is out of its range')
  assert.equal(chooseTurretTarget(body(5), [prey(5, 2, 300, { alive: false }), prey(6, 2, 100)]), 6, 'or dead')
  assert.equal(chooseTurretTarget(body(5), [prey(5, 1, 300), prey(6, 2, 100)]), 6, 'or no longer an enemy')
  assert.equal(chooseTurretTarget(body(5), []), undefined, 'or gone')
  assert.equal(chooseTurretTarget(body(5), [prey(5, 2, 450)]), undefined, 'and there is no one to go to')
  assert.equal(chooseTurretTarget(body(99), others), 6, 'a target it never saw is nobody')
})

// ---------------------------------------------------------------------------- shooting

test('a turret shoots the enemy player in its range for its damage, once a cooldown, and leaves its own team alone', () => {
  const simulator = world()
  player(simulator, ENEMY, { x: 1300, y: 700 }, 2)
  player(simulator, ALLY, { x: 1000, y: 1000 }, 1)
  const { attackWindupTicks, attackCooldownTicks } = gun.champion
  // It starts the tick it has someone in its range, and the shot leaves when its windup is done.
  const first = 1 + attackWindupTicks
  assert.deepEqual(drops(simulator, ENEMY, 200), [0, 1, 2, 3].map((shot) => ({
    tick: first + shot * attackCooldownTicks,
    amount: gun.champion.attackDamage,
  })))
  assert.equal(attackCooldownTicks, 60)
  assert.equal(health(simulator, 200, ALLY), brawler.maxHp, 'its own team is not shot')
  assert.equal(health(simulator, 200, TURRET), gun.champion.maxHp)
  assert.equal(simulator.at(200).get(TURRET)?.getAttackTarget(), ENEMY)
})

test('a turret reaches out to its range and no further, measured to the middle of whoever it shoots', () => {
  const inside = world()
  player(inside, ENEMY, { x: 1400, y: 700 }, 2)
  assert.ok(drops(inside, ENEMY, 200).length > 0, '400 away is in a range of 400')
  const outside = world()
  player(outside, ENEMY, { x: 1401, y: 700 }, 2)
  assert.deepEqual(drops(outside, ENEMY, 300), [], '401 away is not')
  assert.equal(outside.at(300).get(TURRET)?.getAttackTarget(), undefined)
  // Out of it in any direction.
  const diagonal = world()
  player(diagonal, ENEMY, { x: 1000 + 300, y: 700 + 300 }, 2)
  assert.deepEqual(drops(diagonal, ENEMY, 300), [], '424 away on the slant')
})

test('a turret drops a target that walks out of its range, and stays where it is and does not go after them', () => {
  const simulator = world()
  player(simulator, ENEMY, { x: 1300, y: 700 }, 2)
  simulator.addOrder(ENEMY, walk(ENEMY, 1, { x: 1900, y: 700 }))
  const hits = drops(simulator, ENEMY, 400)
  // It is out of the range after about 27 ticks (100 at 220 a second), and nothing hits it after that.
  assert.ok(hits.length >= 1 && hits.every(({ tick }) => tick <= 40), `hit ${JSON.stringify(hits)}`)
  const turret = simulator.at(400).get(TURRET)
  assert.equal(turret?.getAttackTarget(), undefined, 'it is shooting no one')
  assert.deepEqual(turret?.getPosition(), AT, 'and is where it was put')
  assert.equal(turret?.getMoveTarget(), undefined, 'and is not walking after them')
})

test('a turret stays on the one it is shooting while they are in its range, though another is nearer, and then takes the nearest', () => {
  const simulator = world()
  // The first is 300 away and stands still, and the second walks in from far off to 150 away, directly below.
  player(simulator, ENEMY, { x: 1300, y: 700 }, 2)
  player(simulator, OTHER, { x: 1000, y: 1300 }, 3)
  simulator.addOrder(OTHER, walk(OTHER, 1, { x: 1000, y: 850 }))
  const targets = new Map<number, number | undefined>()
  const healths = new Map<number, { first: number | undefined; second: number | undefined }>()
  const gap = new Map<number, number>()
  for (let tick = 1; tick <= 400; tick += 1) {
    // The first walks out of its range at tick 200.
    if (tick === 200) simulator.addOrder(ENEMY, walk(ENEMY, 200, { x: 2100, y: 700 }))
    const frame = simulator.at(tick)
    targets.set(tick, frame.get(TURRET)?.getAttackTarget())
    healths.set(tick, { first: frame.get(ENEMY)?.getHealth(), second: frame.get(OTHER)?.getHealth() })
    gap.set(tick, distance(frame.get(OTHER)?.getPosition() as Vector2, AT))
  }
  assert.equal(targets.get(10), ENEMY)
  // By tick 130 the second is 150 away, nearer than the first, and has been in range since about tick 55.
  assert.ok((gap.get(130) as number) < 160 && (gap.get(55) as number) < 420)
  assert.equal(targets.get(130), ENEMY, 'it is still on the first')
  assert.equal(targets.get(199), ENEMY)
  assert.equal(healths.get(199)?.second, brawler.maxHp, 'and the second has not been touched')
  assert.ok((healths.get(199)?.first ?? brawler.maxHp) < brawler.maxHp, 'while the first has')
  assert.equal(targets.get(260), OTHER, 'once the first is out of its range it is on the second')
  assert.ok((healths.get(400)?.second ?? brawler.maxHp) < brawler.maxHp)
  assert.equal(healths.get(400)?.first, healths.get(300)?.first, 'and the first is shot no more')
})

test('a turret does not shoot a monster, a monster does not go after a turret, and turrets do not shoot each other', () => {
  const watcher = defineMonster({
    id: 't-tu-watcher',
    name: 'Test Watcher',
    base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
    moveSpeed: 200,
    radius: 20,
    attackRange: 60,
    attackWindup: 0,
    abilities: [],
    ai: { aggroRange: 700 },
  })
  const simulator = world()
  const monster = simulator.addMonster(OTHER, watcher, { x: 1300, y: 700 })
  simulator.addTurret(5, gun, { x: 1500, y: 700 }, 2)
  // Both of the turrets and the monster are within each other's reach, and a player is far from all of it.
  player(simulator, ENEMY, { x: 2300, y: 1400 }, 2)
  assert.equal(monster.monster, watcher)
  for (const id of [TURRET, OTHER, 5]) assert.equal(health(simulator, 400, id), simulator.characters.get(id)?.champion.maxHp, `${id} has all its health`)
  assert.equal(simulator.at(400).get(TURRET)?.getAttackTarget(), undefined)
  assert.equal(simulator.at(400).get(5)?.getAttackTarget(), undefined)
  assert.deepEqual(simulator.at(400).get(OTHER)?.getAi(), { mode: 'idle' }, 'the monster has not been drawn out')
  assert.deepEqual(simulator.at(400).get(OTHER)?.getPosition(), { x: 1300, y: 700 })
})

test('a shot that takes time to arrive is fired from the turret and lands after the windup', () => {
  const simulator = world(bolter)
  player(simulator, ENEMY, { x: 1300, y: 700 }, 2)
  const launch = 1 + bolter.champion.attackWindupTicks
  let hit: number | undefined
  let flew = false
  let before = brawler.maxHp
  for (let tick = 1; tick <= 120 && hit === undefined; tick += 1) {
    const frame = simulator.at(tick)
    flew ||= frame.getEntities().some((entity) => entity.ownerId === TURRET)
    const now = frame.get(ENEMY)?.getHealth() ?? 0
    if (now < before) hit = tick
    before = now
  }
  assert.ok(hit !== undefined && hit > launch, `the first hit is after the shot leaves at ${launch}: ${hit}`)
  assert.equal(brawler.maxHp - before, 50)
  assert.ok(flew, 'and the shot was in the air in between, as the turret\'s')
})

// ---------------------------------------------------------------------------- being destroyed

test('an enemy can attack a turret, its resistance takes its share off each hit, and a teammate cannot attack it', () => {
  const simulator = world(bag)
  player(simulator, ENEMY, { x: 1250, y: 700 }, 2)
  simulator.addOrder(ENEMY, attack(ENEMY, 1, TURRET))
  // 100 damage a hit against a resistance of 100 is 50, and 300 health is six of them.
  const hits = drops(simulator, TURRET, 600)
  assert.equal(hits.length, 6)
  assert.ok(hits.every(({ amount }) => amount === 50), JSON.stringify(hits))
  assert.equal(simulator.at(600).get(TURRET)?.isDead(), true)

  const friendly = world(bag)
  player(friendly, ALLY, { x: 1250, y: 700 }, 1)
  friendly.addOrder(ALLY, attack(ALLY, 1, TURRET))
  assert.equal(friendly.at(300).get(ALLY)?.getAttackTarget(), undefined, 'its own team cannot target it')
  assert.equal(health(friendly, 300, TURRET), bag.champion.maxHp)
})

test('an ability that blasts everyone round it does nothing to a turret: only attacks hurt one (see tests/structures.test.ts)', () => {
  const simulator = world(bag)
  // Team 2's champion stands 180 from it, and blasts everyone of another team within 400 for 200.
  player(simulator, ENEMY, { x: 1100, y: 850 }, 2, blaster)
  simulator.addOrder(ENEMY, {
    id: 'blast', seq: 1, tick: 2, type: 'cast', abilityId: 't-tu-blast', target: { mode: 'none' }, origin: { x: 1100, y: 850 },
  })
  assert.equal(health(simulator, 10, TURRET), bag.champion.maxHp, 'the turret did not take it')
  assert.ok((simulator.at(10).get(ENEMY)?.getAbilityCooldown('t-tu-blast').ticksRemaining ?? 0) > 0, 'though it was cast')
})

test('a turret that is destroyed stays destroyed, stops shooting, can be walked through, and pays the player who did it', () => {
  const deaths: DeathRecord[] = []
  const simulator = world(brittle)
  simulator.onDeathConfirmed = (death) => deaths.push(death)
  player(simulator, ENEMY, { x: 1250, y: 700 }, 2)
  simulator.addOrder(ENEMY, attack(ENEMY, 1, TURRET))
  const fell = drops(simulator, TURRET, 200)
  assert.equal(fell.length, 1, 'one hit of 100 is its 100 health')
  const deathTick = simulator.at(200).get(TURRET)?.getDeathTick()
  assert.equal(deathTick, fell[0].tick)
  // Well past any respawn time (3 seconds for a champion), it is still down.
  simulator.addOrder(ENEMY, walk(ENEMY, 210, AT))
  const hurt = health(simulator, 210, ENEMY)
  simulator.advanceTo(900)
  assert.equal(simulator.at(900).get(TURRET)?.isDead(), true)
  assert.equal(simulator.at(900).get(TURRET)?.getDeathTick(), deathTick)
  assert.equal(health(simulator, 900, ENEMY), hurt, 'and shoots no one')
  assert.ok(distance(simulator.at(900).get(ENEMY)?.getPosition() as Vector2, AT) < 2, 'and a player walks through where it stood')

  // What it paid: the gold and the experience on the tick, in the frame, and the shards once the kill can no longer be undone.
  simulator.setCommitTick(900)
  assert.deepEqual(deaths, [{ tick: deathTick, victimId: TURRET, killerId: ENEMY }])
  const killer = simulator.characters.get(ENEMY)
  assert.deepEqual([simulator.at(900).get(ENEMY)?.getGold(), killer?.shards, killer?.kills], [GAME_STARTING_GOLD + 70, 2, 0], 'its gold and shards, and no kill on the board')
  assert.equal(simulator.at(900).get(ENEMY)?.getXp(), 30)
  assert.equal(objectiveScores(simulator.at(900).getObjective())['2'] ?? 0, 0, 'and no point for the team')
})

test('a turret that kills a player is paid nothing, and does not score for its team', () => {
  const deaths: DeathRecord[] = []
  const simulator = world()
  simulator.onDeathConfirmed = (death) => deaths.push(death)
  player(simulator, ENEMY, { x: 1300, y: 700 }, 2, glass)
  simulator.advanceTo(100)
  simulator.setCommitTick(100)
  assert.deepEqual(deaths.map(({ victimId, killerId }) => [victimId, killerId]), [[ENEMY, TURRET]], 'the turret is credited with it')
  const turret = simulator.characters.get(TURRET)
  assert.deepEqual([turret?.kills, simulator.at(100).get(TURRET)?.getGold(), turret?.shards], [0, 0, 0])
  assert.equal(simulator.at(100).get(TURRET)?.getXp(), 0)
  assert.equal(objectiveScores(simulator.at(100).getObjective())['1'] ?? 0, 0, 'and its team has no point for it')
})

// ---------------------------------------------------------------------------- standing where it was put

test('a turret is solid and does not move for anyone: a player who walks into it is held off, and it stays put', () => {
  const simulator = world()
  player(simulator, ENEMY, { x: 1300, y: 700 }, 2)
  simulator.addOrder(ENEMY, walk(ENEMY, 1, AT))
  simulator.advanceTo(200)
  const walker = simulator.at(200).get(ENEMY)?.getPosition() as Vector2
  // About their two bodies' reach apart: a walker sinks in a pixel or two, and is not inside it.
  assert.ok(distance(walker, AT) >= gun.champion.radius + brawler.radius - 3, `${distance(walker, AT)} apart`)
  assert.deepEqual(simulator.at(200).get(TURRET)?.getPosition(), AT)
})

test('a turret is not moved by what moves others: a knockback leaves it where it was', () => {
  const simulator = world(bag)
  player(simulator, ENEMY, { x: 1300, y: 700 }, 2, shover)
  simulator.addOrder(ENEMY, {
    id: 'shove', seq: 1, tick: 2, type: 'cast', abilityId: 't-tu-shove', target: { mode: 'unit', unitId: TURRET }, origin: { x: 1300, y: 700 },
  })
  let moved = false
  let cast = false
  for (let tick = 1; tick <= 90; tick += 1) {
    const frame = simulator.at(tick)
    const state = frame.get(TURRET)
    moved ||= state?.isDashing() === true || state?.getPosition().x !== AT.x || state?.getPosition().y !== AT.y
    cast ||= (frame.get(ENEMY)?.getAbilityCooldown('t-tu-shove').ticksRemaining ?? 0) > 0
  }
  assert.ok(cast, 'the shove was cast')
  assert.equal(moved, false, 'and it never left')
  assert.ok(simulator.characters.get(ENEMY)?.champion === shover)
})

test('a turret cannot be stunned: it goes on shooting through the stun', () => {
  const simulator = world()
  player(simulator, ENEMY, { x: 1300, y: 700 }, 2, stunner)
  simulator.addOrder(ENEMY, {
    id: 'stun', seq: 1, tick: 2, type: 'cast', abilityId: 't-tu-stun', target: { mode: 'unit', unitId: TURRET }, origin: { x: 1300, y: 700 },
  })
  // Its first shot lands as its windup ends, and the next a cooldown later, with the stun of 120 ticks over them both.
  const hits: number[] = []
  let before = brawler.maxHp
  let stunned = false
  let cast = false
  for (let tick = 1; tick <= 130; tick += 1) {
    const frame = simulator.at(tick)
    const now = frame.get(ENEMY)?.getHealth() ?? 0
    if (now < before) hits.push(tick)
    before = now
    stunned ||= (frame.get(TURRET)?.getStatuses().length ?? 0) > 0
    cast ||= (frame.get(ENEMY)?.getAbilityCooldown('t-tu-stun').ticksRemaining ?? 0) > 0
  }
  const first = 1 + gun.champion.attackWindupTicks
  assert.deepEqual(hits, [first, first + 60, first + 120])
  assert.equal(stunned, false, 'and it never has a stun on it')
  assert.ok(cast, 'though the stun was cast')
})

// ---------------------------------------------------------------------------- the same on every peer

test('a turret plays out the same when a frame is worked out again after a late order, and when it is restored from a snapshot', () => {
  const build = (): Simulator => {
    const simulator = world()
    player(simulator, ENEMY, { x: 1300, y: 700 }, 2)
    player(simulator, ALLY, { x: 700, y: 700 }, 1)
    return simulator
  }
  const late = walk(ENEMY, 10, { x: 1700, y: 900 })
  const straight = build()
  straight.addOrder(ENEMY, late)
  straight.advanceTo(150)

  const redone = build()
  redone.advanceTo(14)
  assert.equal(redone.addOrder(ENEMY, late), true, 'an order that arrives late, for a tick already worked out')
  redone.advanceTo(150)
  assert.equal(JSON.stringify(redone.at(150).toData()), JSON.stringify(straight.at(150).toData()))

  // A page that joins late is sent a snapshot, and plays on from it.
  straight.setCommitTick(140)
  const snapshot = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(straight.snapshot())))
  assert.deepEqual(snapshot.characters.map((character) => [character.id, character.championId, character.team]), [
    [TURRET, 'turret-91', 1], [ENEMY, brawler.id, 2], [ALLY, brawler.id, 1],
  ])
  const joined = economySimulator()
  joined.replaceFromSnapshot(snapshot)
  assert.equal(joined.characters.get(TURRET)?.turret, gun)
  straight.advanceTo(300)
  joined.advanceTo(300)
  assert.equal(JSON.stringify(joined.at(300).toData()), JSON.stringify(straight.at(300).toData()))
})

// ---------------------------------------------------------------------------- the map

// A map of 100 by 100 tiles at 16 pixels, drawn at three, with an arena, spawn points for two teams, and these objects.
function mapWith(objects: unknown[]): ReturnType<typeof parseTiledMap> {
  const spawns = [1, 2].flatMap((slot) => [1, 2, 3, 4].map((number) => ({
    id: 100 + slot * 10 + number,
    name: `spawn-${slot}-${number}`,
    type: 'spawn',
    point: true,
    x: 100 + slot * 100,
    y: 100 + number * 40,
    properties: [{ name: 'team-name', type: 'int', value: slot }, { name: 'spawn-number', type: 'int', value: number }],
  })))
  return parseTiledMap({
    orientation: 'orthogonal',
    width: 100,
    height: 100,
    tilewidth: 16,
    tileheight: 16,
    layers: [{
      type: 'objectgroup',
      name: 'Objects',
      objects: [{ id: 1, name: 'arena', type: 'arena', x: 0, y: 0, width: 800, height: 500 }, ...spawns, ...objects],
    }],
    tilesets: [],
  })
}
let nextId = 700
const post = (tier: unknown, slot: unknown, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id: nextId++,
  name: `post-${String(tier)}`,
  type: 'turret',
  point: true,
  x,
  y,
  properties: [
    ...(slot === undefined ? [] : [{ name: 'team-name', type: 'int', value: slot }]),
    ...(tier === undefined ? [] : [{ name: 'turret-tier', type: 'int', value: tier }]),
  ],
  ...extra,
})
const problemsOf = (objects: unknown[]): string => {
  try {
    readMapLayout(mapWith(objects))
  } catch (error) {
    return (error as Error).message
  }
  return assert.fail('the map was accepted')
}

test('a map puts turrets where its turret points are, with their tier and the slot of the team they are for', () => {
  const layout = readMapLayout(mapWith([post(1, 1, 300, 300), post(2, 2, 500, 300), post(1, 2, 100.4, 80.6)]))
  // Map pixels from the arena's corner are three world units each, in whole numbers.
  assert.deepEqual(layout.turrets, [
    { tier: 1, slot: 1, at: { x: 900, y: 900 } },
    { tier: 2, slot: 2, at: { x: 1500, y: 900 } },
    { tier: 1, slot: 2, at: { x: 301, y: 242 } },
  ])
  assert.deepEqual(layout.warnings, [])
  assert.deepEqual(readMapLayout(mapWith([])).turrets, [], 'a map need not have any')
})

test('a point for a tier the game does not have yet is left out, and the map says so, but can still be played on', () => {
  const layout = readMapLayout(mapWith([post(77, 1, 400, 300), post(1, 1, 200, 300)]))
  assert.deepEqual(layout.turrets, [{ tier: 1, slot: 1, at: { x: 600, y: 900 } }])
  assert.equal(layout.warnings.length, 1)
  assert.match(layout.warnings[0], /post-77 is for a tier 77 turret, which the game does not have \(only tiers 1, 2/)
})

test('a turret point that is not right says which, and what is wrong', () => {
  assert.match(problemsOf([post(1, 1, 300, 300, { point: false, width: 5, height: 5 })]), /post-1 is not a point/)
  assert.match(problemsOf([post(1, undefined, 300, 300)]), new RegExp(`post-1 needs a team-name from 1 to ${GAME_MAX_PLAYERS}: the slot of spawn points whose team it belongs to`))
  for (const slot of [0, GAME_MAX_PLAYERS + 1, 1.5, 'one']) assert.match(problemsOf([post(1, slot, 300, 300)]), /needs a team-name from 1/, String(slot))
  assert.match(problemsOf([post(undefined, 1, 300, 300)]), /post-undefined needs a turret-tier of 1 or more \(the game has tiers 1, 2/)
  for (const tier of [0, -1, 1.5, 'big']) assert.match(problemsOf([post(tier, 1, 300, 300)]), /needs a turret-tier of 1 or more/, String(tier))
  assert.match(problemsOf([post(1, 1, -5, 300)]), /post-1 is outside the arena/)
  // A turret needs its radius clear of the arena's edge, which is `radius / GAME_ART_SCALE` map pixels: a pixel less has no room, and a pixel more has.
  const pixels = getTurret(1).champion.radius / GAME_ART_SCALE
  assert.match(problemsOf([post(1, 1, Math.floor(pixels) - 1, 300)]), /post-1 is too close to a wall or the arena's edge: a Tier 1 Turret would stand in it/)
  // And it says where it would fit: the nearest place with the whole turret inside the arena, in the map's own pixels.
  assert.match(
    problemsOf([post(1, 1, Math.floor(pixels) - 1, 300)]),
    new RegExp(`The nearest place that clears the walls and the edge is about \\(${Math.round(pixels * 10) / 10}, 300\\) in the map's own pixels \\(keep it clear of the spawn points and the turrets too\\)\\.`),
  )
  assert.equal(readMapLayout(mapWith([post(1, 1, Math.ceil(pixels) + 1, 300)])).turrets.length, 1, 'with room for its size it is fine')
})

test('every turret point on the competitive map is a turret in the game, with its tier and slot', () => {
  const map = parseTiledMap(JSON.parse(readFileSync(new URL('../res/maps/competetive.tmj', import.meta.url), 'utf-8')))
  const layout = readMapLayout(map)
  const points = flattenLayers(map.layers).flatMap(({ layer }) => layer.type === 'objectgroup' ? layer.objects : [])
    .filter((object) => (object.class ?? object.type) === 'turret')
    .map((object) => ({ tier: getProperty(object.properties, 'turret-tier'), slot: getProperty(object.properties, 'team-name') }))
  assert.ok(points.length >= 2, 'it has turrets')
  assert.deepEqual(layout.turrets.map(({ tier, slot }) => ({ tier, slot })), points.filter((point) => turrets.has(turretId(Number(point.tier)))))
  assert.deepEqual(layout.warnings.filter((warning) => /turret/i.test(warning)), [], 'and none is left out')
  for (const { at } of layout.turrets) assert.ok(at.x > 0 && at.y > 0 && at.x < layout.terrain.width && at.y < layout.terrain.height)
})

// ---------------------------------------------------------------------------- the server

const players = [{ id: 'a', name: 'Ann', team: 2 }, { id: 'b', name: 'Bob', team: 2 }, { id: 'c', name: 'Cat', team: 1 }]
const terrain = new Terrain({ width: 2400, height: 1400 })
const withPosts = {
  id: 'posts',
  spawns: testSpawns,
  terrain,
  flags: [],
  turrets: [
    { tier: 91, slot: 1, at: { x: 1200, y: 700 } },
    { tier: 94, slot: 2, at: { x: 1500, y: 700 } },
    { tier: 91, slot: 3, at: { x: 1800, y: 700 } },
  ],
}

function started(map = withPosts): ServerGameState {
  const game = new ServerGameState([])
  game.beginSelection(players, map, 'deathmatch')
  for (const player of players) game.lockChampion(player.id)
  game.begin(players)
  return game
}

test('the server starts a game with the map\'s turrets, after the players, each on the team that starts at its slot', () => {
  const game = started()
  const characters = [...game.simulator.characters.values()]
  // Team 2 is the biggest team, so it starts at slot 1 and has the turrets for slot 1. Nobody starts at slot 3, so that turret is not in the game.
  assert.deepEqual(characters.map((character) => [character.id, character.turret?.tier, character.team]), [
    [1, undefined, 2],
    [2, undefined, 2],
    [3, undefined, 1],
    [4, 91, 2],
    [5, 94, 1],
  ])
  assert.deepEqual(game.simulator.characters.get(5)?.initialPosition, { x: 1500, y: 700 })
  assert.deepEqual([game.getCharacterId('a'), game.getCharacterId('b'), game.getCharacterId('c')], [1, 2, 3], 'a player\'s ID is what it always was')
  assert.deepEqual(game.playingPlayerIds.sort(), ['a', 'b', 'c'], 'turrets are not players')

  const snapshot = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(game.snapshot())))
  assert.deepEqual(snapshot.characters.slice(3).map((character) => [character.id, character.championId, character.team, character.player]), [
    [4, 'turret-91', 2, undefined],
    [5, 'turret-94', 1, undefined],
  ])
})

test('a game on a map with no turrets has none, and the next game is not given the last one\'s', () => {
  const count = (game: ServerGameState): number => [...game.simulator.characters.values()].filter((character) => character.turret).length
  assert.equal(count(started({ ...withPosts, turrets: [] })), 0)
  const game = started()
  assert.equal(count(game), 2)
  game.cancelStart()
  game.beginSelection(players, { ...withPosts, turrets: undefined })
  for (const player of players) game.lockChampion(player.id)
  game.begin(players)
  assert.equal(count(game), 0)
})

test('turrets are not on the results, and do not keep a game with no players in it going', () => {
  const game = started()
  for (const player of players) game.markReady(player.id)
  assert.ok(game.startIfReady())
  for (let tick = 0; tick < 40; tick += 1) game.advanceTick()
  const result = game.end()
  assert.deepEqual(result?.players.map((player) => player.name).sort(), ['Ann', 'Bob', 'Cat'], 'three players, and no turret')
  assert.deepEqual(result?.teams.map((team) => team.team).sort(), [1, 2])
  for (const player of players) game.leaveGame(player.id)
  assert.equal(game.closeIfEmpty(), true)
  assert.equal(game.status, 'idle')
})
