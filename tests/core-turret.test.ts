import assert from 'node:assert/strict'
import test from 'node:test'
import { championSprites } from '../apps/client/src/champion-sprites.ts'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { layoutTurretRings } from '../apps/client/src/render/turret-range.ts'
import {
  CORE_TIER,
  DEFAULT_CORE_REWARD,
  DEFAULT_TURRET_REWARD,
  getCharacterChampion,
  getCore,
  getTeam,
  getTurret,
  Simulator,
  Turret,
  TURRET_TIERS,
  turretId,
  turrets,
  turretTiers,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { brawler, defineMonster, defineTurret, ECONOMY_MODE, economySimulator } from './fixtures.ts'

// The core is a turret (see turrets.ts): the last of a base, the highest tier there is, with one flag on its entry, `core`. It is the same class, in the same registry, put
// in the game the same way and played by the same code, so what is true of turrets is true of it (tests/turrets.test.ts, tests/turret-ramp.test.ts, tests/structures.test.ts).
// These are what is its own: that it is the highest tier, what its flag does, how the page and a map treat it. The turrets in them are the tests' own, with every number
// spelled out, except for the core the game plays with, which is only read.

const body = { base: { maxHp: 2000, attackDamage: 50, attackSpeed: 1 }, radius: 40, attackRange: 400, attackWindup: 0 }
const gun = defineTurret(85, { ...body, core: true })
const ordinary = defineTurret(84, body)
// Breaks in a few hits of a hundred, while it is shooting back.
const brittle = defineTurret(86, { ...body, base: { ...body.base, maxHp: 250 }, core: true })
const grunt = defineMonster({
  id: 't-ct-grunt',
  name: 'Core Grunt',
  base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300, respawnTicks: 300 },
})

const CORE_BODY = 1
const ENEMY = 2
const ALLY = 3
const AT = { x: 1000, y: 700 }
const INSIDE = { x: AT.x + body.attackRange - 50, y: AT.y }

function world(core: Turret = gun): Simulator {
  const simulator = economySimulator()
  simulator.addTurret(CORE_BODY, core, AT, 1)
  return simulator
}
const player = (simulator: Simulator, id: number, at: Vector2, team: number): void => {
  simulator.addPlayer(id, `p${id}`, `Player ${id}`, at, brawler, team)
}
type Drop = { tick: number; amount: number }
// When each of these characters' health went down, and by how much, over ticks 1 to `last`, in one pass forward (the simulator keeps only the last few frames).
function watch(simulator: Simulator, ids: readonly number[], last: number): Map<number, Drop[]> {
  const found = new Map(ids.map((id): [number, Drop[]] => [id, []]))
  const before = new Map(ids.map((id): [number, number] => [id, simulator.at(0).get(id)?.getHealth() ?? 0]))
  for (let tick = 1; tick <= last; tick += 1) {
    const frame = simulator.at(tick)
    for (const id of ids) {
      const now = frame.get(id)?.getHealth() ?? 0
      const was = before.get(id) ?? 0
      if (now < was) found.get(id)?.push({ tick, amount: was - now })
      before.set(id, now)
    }
  }
  return found
}

// ---------------------------------------------------------------------------- what it is

test('the core the game plays with is a turret: of the highest tier, in the same registry, found and put in the game the same way, and called the Core', () => {
  const core = getCore()
  assert.ok(core instanceof Turret)
  assert.equal(core.core, true)
  assert.equal(core.tier, CORE_TIER)
  assert.equal(core.id, turretId(CORE_TIER))
  assert.equal(turrets.get(core.id), core, 'in the registry the turrets are in')
  assert.equal(getTurret(CORE_TIER), core)
  assert.equal(getCharacterChampion(core.id), core.champion, 'its body is found by its id, as a turret\'s is')
  assert.equal(core.name, 'Core')
  assert.equal(core.champion.moveSpeed, 0, 'it stands where it is put')
  assert.ok(core.champion.attackDamage > 0 && core.champion.attackRange > core.champion.radius, 'and it shoots, as a turret does')
  for (const tier of Object.keys(TURRET_TIERS).map(Number).filter((each) => each !== CORE_TIER)) {
    assert.ok(tier < CORE_TIER, `it is above tier ${tier}, so it waits for it`)
  }
})

test('the core is the only turret of the game that is one, and a map\'s turret points can name every other tier and not the core\'s', () => {
  const cores = Object.entries(TURRET_TIERS).filter(([, tier]) => tier.core)
  assert.deepEqual(cores.map(([tier]) => Number(tier)), [CORE_TIER])
  for (const tier of turretTiers()) assert.equal(getTurret(tier).core, false, `tier ${tier} is an ordinary turret`)
  assert.equal(turretTiers().includes(CORE_TIER), false)
  // (The tiers this file defines for itself are in the list too, so it is the game's own that are compared.)
  assert.deepEqual(
    turretTiers().filter((tier) => tier in TURRET_TIERS),
    Object.keys(TURRET_TIERS).map(Number).filter((tier) => tier !== CORE_TIER).sort((left, right) => left - right),
  )
})

test('a core pays what a core pays when its entry says nothing, which is nothing, and a turret what a turret pays', () => {
  assert.deepEqual({ ...gun.reward }, { ...DEFAULT_CORE_REWARD })
  assert.deepEqual({ ...ordinary.reward }, { ...DEFAULT_TURRET_REWARD })
  const says = defineTurret(87, { ...body, core: true, reward: { gold: 5 } })
  assert.deepEqual({ ...says.reward }, { gold: 5, xp: DEFAULT_CORE_REWARD.xp, shards: DEFAULT_CORE_REWARD.shards }, 'what it does say is what it pays, and the rest is a core\'s')
  assert.deepEqual({ ...getCore().reward }, { ...DEFAULT_CORE_REWARD }, 'and so does the one the game plays with')
})

test('to the simulator a core is a structure like any turret, and the one that decides the game', () => {
  const simulator = world()
  simulator.addTurret(4, ordinary, { x: 1500, y: 700 }, 1)
  const core = simulator.characters.get(CORE_BODY)
  const turret = simulator.characters.get(4)
  assert.equal(core?.turret, gun, 'a turret: there is no other kind of thing a core is')
  assert.deepEqual([core?.structure, core?.isNpc, core?.isCore], [true, true, true])
  assert.deepEqual([turret?.structure, turret?.isNpc, turret?.isCore], [true, true, false])
  assert.deepEqual(core?.asStructure(), { id: CORE_BODY, team: 1, tier: gun.tier, core: true })
  assert.deepEqual(turret?.asStructure(), { id: 4, team: 1, tier: ordinary.tier, core: false })
})

test('the core is drawn from the keep, and every other tier from the tower: the art is chosen by the flag, and not by a tier number', () => {
  const keep = championSprites[turretId(CORE_TIER)]
  assert.ok(keep, 'the core has a set')
  const towers = turretTiers().filter((tier) => tier in TURRET_TIERS).map((tier) => championSprites[turretId(tier)])
  assert.ok(towers.length >= 2 && towers.every((set) => set !== undefined), 'and so has every other tier')
  for (const tower of towers) {
    assert.notEqual(tower.clips.idle?.url, keep.clips.idle?.url, 'a tower is not drawn from the keep')
    assert.notEqual(tower.clips.dead?.url, keep.clips.dead?.url)
  }
  assert.equal(new Set(towers.map((set) => set.clips.idle?.url)).size, 1, 'and the towers are drawn from one set of sheets, until a tier has art of its own')
})

// ---------------------------------------------------------------------------- what it does, as a turret

test('a core shoots as a turret does: the enemy player in its range, for its damage, every time its attack is ready, and not a teammate or a monster', () => {
  const simulator = world()
  simulator.addPlayer(ENEMY, 'p2', 'Enemy', INSIDE, brawler, 2)
  player(simulator, ALLY, { x: INSIDE.x, y: INSIDE.y + 100 }, 1)
  simulator.addMonster(20, grunt, { x: AT.x, y: AT.y + 200 })
  const every = gun.champion.attackCooldownTicks
  const seen = watch(simulator, [ENEMY, ALLY, 20], every * 2 + 10)
  const hits = seen.get(ENEMY) ?? []
  assert.ok(hits.length >= 3, `it shot three times or more: ${JSON.stringify(hits)}`)
  for (const hit of hits) assert.equal(hit.amount, gun.champion.attackDamage)
  assert.deepEqual(hits.slice(1).map((hit, index) => hit.tick - hits[index].tick), hits.slice(1).map(() => every), 'one every time its attack is ready')
  assert.deepEqual(seen.get(ALLY), [], 'a teammate is safe')
  assert.deepEqual(seen.get(20), [], 'and a monster is not its to shoot')
})

test('a core that has been broken shoots no more', () => {
  const simulator = world(brittle)
  simulator.addPlayer(ENEMY, 'p2', 'Enemy', { x: AT.x + brittle.champion.radius + 30, y: AT.y }, brawler, 2)
  simulator.addOrder(ENEMY, { id: 'a', seq: 1, tick: 1, type: 'attack', targetId: CORE_BODY })
  const last = brittle.champion.attackCooldownTicks * 6
  const shots = watch(simulator, [ENEMY], last).get(ENEMY) ?? []
  const fell = simulator.at(last).get(CORE_BODY)?.getDeathTick()
  assert.ok(fell !== undefined, 'the core is down')
  assert.ok(shots.some((hit) => hit.tick < (fell as number)), 'it shot while it stood')
  assert.deepEqual(shots.filter((hit) => hit.tick > (fell as number)), [], 'and nothing is shot after it fell')
})

// ---------------------------------------------------------------------------- on the page

test('the page is told a core is the core, and draws a range ring round it as round any turret, in its team\'s colour', () => {
  const state = new ClientGameState()
  state.simulator.reset(undefined, ECONOMY_MODE)
  state.simulator.addTurret(10, gun, AT, 1)
  state.simulator.addTurret(11, ordinary, { x: 1500, y: 700 }, 2)
  state.simulator.advanceTo(3)
  const characters = state.getCharacters(0)
  const core = characters.find((character) => character.id === 10)
  const turret = characters.find((character) => character.id === 11)
  assert.deepEqual(core?.turret, { tier: gun.tier, core: true, visionRange: gun.visionRange })
  assert.deepEqual(turret?.turret, { tier: ordinary.tier, core: false, visionRange: ordinary.visionRange })
  assert.equal(core?.name, 'Core')
  assert.deepEqual(layoutTurretRings(characters), [
    { x: AT.x, y: AT.y, radius: body.attackRange, color: getTeam(1).color },
    { x: 1500, y: 700, radius: body.attackRange, color: getTeam(2).color },
  ])
})
