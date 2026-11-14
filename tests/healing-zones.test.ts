import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { layoutHealingZones } from '../apps/client/src/render/healing-zone.ts'
import { layoutTurretRings } from '../apps/client/src/render/turret-range.ts'
import { layoutTurretShadows } from '../apps/client/src/render/turret-shadow.ts'
import { coreReadout, type CoreView } from '../apps/client/src/ui/mode-hud.ts'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  applyRulesChange,
  CORE_TIER,
  createModeSetup,
  defaultRules,
  GAME_MODES,
  GameSnapshotSchema,
  getCharacterChampion,
  getCore,
  getCoreZone,
  getHealingZone,
  getStructureBody,
  getTeam,
  getTurret,
  HEALING_ZONE_SHIELD_KEY,
  HEALING_ZONE_TIERS,
  healingZoneId,
  loseHealth,
  modeRules,
  readRulesChange,
  SHOP_HEAL_SECONDS,
  Simulator,
  Terrain,
  Turret,
  turretId,
  turrets,
  turretTiers,
  zoneHealPerPulse,
  zoneHealsOn,
  type GameEvent,
  type ModeSetup,
  type ShopZone,
  type Status,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineAbility, defineChampion } from './fixtures.ts'
import { testSpawns } from './test-spawns.ts'

// Healing zones (healing-zones.ts): what the turrets and the core are when the lobby turns them on. A zone does not shoot; it heals the players of its team in it a flat
// amount on every pulse, and shields one the moment it walks in and then again each time its shield timer has run. The shops do not heal while there are zones. The numbers
// of a zone are read from its tier's entry, so retuning one changes nothing here; the champions are the tests' own.

const ZONE = getHealingZone(1)
const ZONE_DEF = ZONE.zone as NonNullable<Turret['zone']>
const Z: Vector2 = { x: 1000, y: 700 }

defineAbility({ id: 't-hz-wound', targeting: 'none', range: 0, windUpTicks: 0, cooldownTicks: 60_000, apply: [loseHealth(1_000_000)] })
const hero = defineChampion({
  id: 't-hz-hero',
  name: 'Zone Hero',
  base: { maxHp: 1000, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: ['t-hz-wound'],
})
const giant = defineChampion({ ...hero, id: 't-hz-giant', name: 'Zone Giant', base: { ...hero.base, maxHp: 3000 }, abilities: ['t-hz-wound'] })
// Hits a structure hard enough to break it at once, from a little way off.
const breaker = defineChampion({
  id: 't-hz-breaker',
  name: 'Zone Breaker',
  base: { maxHp: 1000, attackDamage: 10_000_000, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 200,
  attackWindup: 0,
  abilities: [],
})

// Where a body of radius 20 stands in the zone, clear of the zone's own body; and where it is out of it.
const INSIDE = ZONE.champion.radius + 20 + 10
assert.ok(INSIDE < ZONE_DEF.reach, 'there is room in the zone to stand')
const inZone = (dx: number, dy = 0): Vector2 => ({ x: Z.x + dx, y: Z.y + dy })
const OUT = ZONE_DEF.reach + 60

let sequence = 0
const wound = (tick: number) => ({ id: `w${++sequence}`, seq: sequence, tick, type: 'cast' as const, abilityId: 't-hz-wound', target: { mode: 'none' as const }, origin: { x: 0, y: 0 } })
const move = (tick: number, target: Vector2) => ({ id: `m${++sequence}`, seq: sequence, tick, type: 'move' as const, target: { ...target } })
const attack = (tick: number, targetId: number) => ({ id: `a${++sequence}`, seq: sequence, tick, type: 'attack' as const, targetId })

const ZONES: ModeSetup = { kind: 'deathmatch', healingZones: true }

// A game played forward a tick at a time, keeping what each tick did that is read here: the simulator keeps only the last few frames.
class Game {
  readonly simulator: Simulator
  readonly events: Array<{ tick: number; event: GameEvent }> = []
  readonly shields = new Map<number, Status[]>()
  readonly positions = new Map<number, Map<number, Vector2>>()
  reached = 0

  constructor(setup: ModeSetup = ZONES, shops: readonly ShopZone[] = []) {
    this.simulator = new Simulator(Terrain.plain(), setup, shops)
  }

  // A player that wounds itself to its last point on tick 1, so every heal it gets shows. Its origin is where it stands.
  woundedPlayer(id: number, at: Vector2, team: number, who = hero): void {
    this.simulator.addPlayer(id, `p${id}`, `Player ${id}`, at, who, team)
    this.simulator.addOrder(id, { ...wound(1), origin: { ...at } })
  }

  run(to: number): void {
    while (this.reached < to) {
      this.reached += 1
      const frame = this.simulator.at(this.reached)
      for (const event of frame.events) this.events.push({ tick: this.reached, event })
      for (const id of this.simulator.characters.keys()) {
        const state = frame.get(id)
        if (!state) continue
        const zoneShields = state.getStatuses().filter((status) => status.kind === 'shield' && this.simulator.characters.get(status.ownerId)?.zone !== undefined)
        if (zoneShields.length > 0) this.shields.set(id, [...(this.shields.get(id) ?? []), ...zoneShields])
        const at = this.positions.get(id) ?? new Map<number, Vector2>()
        at.set(this.reached, state.getPosition())
        this.positions.set(id, at)
      }
    }
  }

  zoneHeals(id: number): Array<{ tick: number; amount: number }> {
    return this.events.flatMap(({ tick, event }) =>
      event.type === 'heal' && event.unitId === id && event.id.startsWith('zone:') ? [{ tick, amount: event.amount }] : [])
  }

  // The ticks a zone's shield was given on, from the shields it carried.
  shieldsGiven(id: number): number[] {
    return [...new Set((this.shields.get(id) ?? []).map((status) => status.startTick))].sort((left, right) => left - right)
  }
}

const distance = (left: Vector2, right: Vector2): number => Math.hypot(left.x - right.x, left.y - right.y)

// ---------------------------------------------------------------------------- what a zone is

test('every tier of turret and the core has a healing zone of its tier, no bigger than its tower, which does not shoot', () => {
  for (const tier of turretTiers()) {
    const zone = getHealingZone(tier)
    assert.ok(zone.zone, `tier ${tier} heals`)
    assert.equal(zone.id, healingZoneId(tier))
    assert.equal(zone.tier, tier)
    assert.equal(zone.core, false)
    assert.equal(zone.name, `Tier ${tier} Healing Zone`)
    // The map is checked for room by the tower's size, so a zone bigger than its tower could stand in a wall.
    assert.ok(zone.champion.radius <= getTurret(tier).champion.radius, `tier ${tier} fits wherever its tower does`)
    assert.equal(zone.champion.attackRange, 0, `tier ${tier} reaches no one to shoot`)
    assert.equal(zone.champion.attackDamage, 0)
  }
  const core = getCoreZone()
  assert.equal(core.core, true, 'the core is a zone too, and still the core')
  assert.equal(core.tier, CORE_TIER)
  assert.equal(core.name, 'Core')
  assert.ok(core.champion.radius <= getCore().champion.radius, 'the core\'s fits wherever the core does')
  assert.ok(core.zone)
  for (const zone of [...turretTiers().map(getHealingZone), core]) {
    assert.equal(turrets.has(zone.id), false, 'a zone is not in the turrets\' registry')
    assert.equal(getStructureBody(zone.id), zone, 'but is a structure body')
    assert.equal(getCharacterChampion(zone.id), zone.champion, 'which a snapshot can name')
  }
  assert.equal(getStructureBody(turretId(1)), getTurret(1))
  assert.ok((core.zone?.healPerSecond ?? 0) > 0 && Object.keys(HEALING_ZONE_TIERS).length === turretTiers().length + 1)
  assert.throws(() => new Turret(42, { ...HEALING_ZONE_TIERS[1], zone: { ...ZONE_DEF, reach: 0 } }), /Healing zone tier 42 needs a reach/)
  assert.throws(() => new Turret(42, { ...HEALING_ZONE_TIERS[1], zone: { ...ZONE_DEF, shieldEveryTicks: 0 } }), /time between shields/)
})

// ---------------------------------------------------------------------------- healing

test('a player of its team in the zone is healed a flat amount on every pulse, whatever its most health, and no one else is', () => {
  const game = new Game()
  game.simulator.addTurret(10, ZONE, Z, 1)
  game.woundedPlayer(1, inZone(INSIDE), 1)
  game.woundedPlayer(2, inZone(-INSIDE), 1, giant)
  game.woundedPlayer(3, inZone(0, INSIDE), 2)
  game.woundedPlayer(4, inZone(OUT), 1)
  game.run(2 * 60)
  const amount = zoneHealPerPulse(ZONE_DEF)
  assert.ok(amount > 0)
  const pulses = Array.from({ length: game.reached - 1 }, (_, index) => index + 2).filter(zoneHealsOn)
  for (const id of [1, 2]) {
    assert.deepEqual(game.zoneHeals(id), pulses.map((tick) => ({ tick, amount })), `player ${id}: the same flat amount on every pulse`)
  }
  assert.equal(game.zoneHeals(3).length, 0, 'not an enemy in it')
  assert.equal(game.zoneHeals(4).length, 0, 'not a teammate out of it')
  assert.equal(game.simulator.at(game.reached).get(1)?.getHealth(), 1 + amount * pulses.length, 'and it lands')
})

test('a zone that is broken heals no one, and it is broken by attacks like a turret, never shooting back', () => {
  const game = new Game()
  game.simulator.addTurret(10, ZONE, Z, 1)
  game.woundedPlayer(1, inZone(INSIDE), 1)
  game.simulator.addPlayer(2, 'p2', 'Breaker', inZone(0, INSIDE + 20), breaker, 2)
  game.run(60)
  assert.deepEqual(game.events.filter(({ event }) => event.type === 'damage' && event.targetId === 2), [], 'an enemy in its reach is not shot')
  assert.equal(game.simulator.at(60).get(10)?.getAttackTarget(), undefined, 'nor is anyone')
  game.simulator.addOrder(2, attack(61, 10))
  game.run(90)
  const broken = game.simulator.at(90).get(10)
  assert.equal(broken?.isDead(), true, 'it falls')
  const fell = broken?.getDeathTick() ?? Infinity
  game.run(fell + 2 * 60)
  assert.equal(game.zoneHeals(1).filter(({ tick }) => tick > fell).length, 0, 'and heals no one after')
  assert.ok(game.zoneHeals(1).some(({ tick }) => tick <= fell), 'as it did before')
})

// ---------------------------------------------------------------------------- shielding

test('walking into a zone gives a shield at once, and the next only once the shield timer has run, however often it walks out and in', () => {
  const game = new Game()
  game.simulator.addTurret(10, ZONE, Z, 1)
  game.simulator.addPlayer(1, 'p1', 'Hero', inZone(OUT), hero, 1)
  game.simulator.addOrder(1, move(1, inZone(ZONE_DEF.reach - 40)))
  game.run(3 * 60)
  const [entered] = game.shieldsGiven(1)
  assert.ok(entered, 'it is shielded')
  const where = game.positions.get(1) as Map<number, Vector2>
  assert.ok(distance(where.get(entered) as Vector2, Z) <= ZONE_DEF.reach, 'once it is in')
  assert.ok(distance(where.get(entered - 1) as Vector2, Z) > ZONE_DEF.reach, 'on the tick it walks in')
  const first = (game.shields.get(1) ?? []).find((status) => status.startTick === entered) as Status
  assert.equal(first.amount, ZONE_DEF.shield)
  assert.equal(first.endTick - first.startTick, ZONE_DEF.shieldTicks)
  assert.ok(game.simulator.at(game.reached).get(1)?.getMarkers().some((marker) => marker.key === HEALING_ZONE_SHIELD_KEY), 'and its timer is running')

  // Out, and back in well before the timer has run.
  game.simulator.addOrder(1, move(game.reached + 1, inZone(OUT)))
  game.simulator.addOrder(1, move(game.reached + 60, inZone(ZONE_DEF.reach - 40)))
  const due = entered + ZONE_DEF.shieldEveryTicks
  game.run(due - 1)
  const left = [...where].some(([tick, at]) => tick > entered && distance(at, Z) > ZONE_DEF.reach)
  assert.ok(left, 'it did walk out')
  assert.ok(distance(where.get(due - 1) as Vector2, Z) <= ZONE_DEF.reach, 'and back in')
  assert.deepEqual(game.shieldsGiven(1), [entered], 'with no new shield for it')
  game.run(due + ZONE_DEF.shieldEveryTicks)
  assert.deepEqual(game.shieldsGiven(1), [entered, due, due + ZONE_DEF.shieldEveryTicks], 'the next comes as the timer runs out, and so on while it stays')
})

test('a shield from a zone takes the last one\'s place, and an enemy in the zone is never shielded', () => {
  const game = new Game()
  game.simulator.addTurret(10, ZONE, Z, 1)
  game.simulator.addPlayer(1, 'p1', 'Hero', inZone(INSIDE), hero, 1)
  game.simulator.addPlayer(2, 'p2', 'Foe', inZone(-INSIDE), hero, 2)
  game.run(ZONE_DEF.shieldEveryTicks * 2 + 2)
  const carried = game.simulator.at(game.reached).get(1)?.getStatuses().filter((status) => status.kind === 'shield') ?? []
  assert.equal(carried.length, 1, 'one shield, not one for each')
  assert.equal(game.shieldsGiven(2).length, 0)
})

// ---------------------------------------------------------------------------- the shops

test('in a game with healing zones the shops do not heal', { skip: !(SHOP_HEAL_SECONDS > 0) && 'the shop heals nothing anyway' }, () => {
  const shop: ShopZone = { team: 1, x: 0, y: 0, width: 600, height: 1440 }
  const healed = (setup: ModeSetup): number => {
    const game = new Game(setup, [shop])
    game.woundedPlayer(1, { x: 300, y: 700 }, 1)
    game.run(2 * 60)
    return game.events.filter(({ event }) => event.type === 'heal' && event.unitId === 1).length
  }
  assert.ok(healed({ kind: 'deathmatch' }) > 0, 'a shop heals in a game without them')
  assert.equal(healed(ZONES), 0, 'and not in one with them')
})

// ---------------------------------------------------------------------------- the lobby's rule

test('healing zones are a rule of the lobby, off by default, for every mode, and the game and its snapshot carry it', () => {
  assert.equal(defaultRules().healingZones, false)
  assert.deepEqual(readRulesChange({ healingZones: true }), { change: { healingZones: true } })
  for (const bad of ['yes', 1, null]) assert.ok('problem' in readRulesChange({ healingZones: bad }), `${String(bad)} is refused`)
  const on = applyRulesChange(defaultRules(), { healingZones: true })
  assert.equal(applyRulesChange(on, { respawnSeconds: 9 }).healingZones, true, 'a change to something else leaves it')
  for (const mode of GAME_MODES.map((each) => each.id)) {
    assert.equal(modeRules(on, mode).healingZones, true, `${mode} is given it`)
    assert.equal('healingZones' in modeRules(defaultRules(), mode), false, `${mode}: off is not there`)
  }
  const setup = createModeSetup('deathmatch', [1, 2], { flags: [] }, modeRules(on, 'deathmatch'))
  assert.equal(setup.healingZones, true)
  const restored = new Simulator()
  restored.replaceFromSnapshot(GameSnapshotSchema.parse(JSON.parse(JSON.stringify(new Simulator(undefined, setup).snapshot()))))
  assert.equal(restored.hasHealingZones, true, 'a page that joins the game knows it')
  assert.equal(new Simulator().hasHealingZones, false)
})

test('with the rule on, the server puts a healing zone where each turret and core of the map is, and the core is still what decides the game', () => {
  const roster = [{ id: 'a', name: 'Ann', team: 1 }, { id: 'b', name: 'Bob', team: 2 }]
  const map = {
    id: 'zones',
    spawns: testSpawns,
    terrain: new Terrain({ width: 2400, height: 1400 }),
    flags: [],
    cores: [{ x: 120, y: 600 }, { x: 2200, y: 600 }],
    turrets: [{ tier: 1, slot: 1, at: { x: 800, y: 1200 } }, { tier: 2, slot: 2, at: { x: 1600, y: 1200 } }],
  }
  const started = (healingZones: boolean): ServerGameState => {
    const state = new ServerGameState([])
    assert.equal(state.beginSelection(roster, map, 'core', { respawnTicks: 60, ...(healingZones ? { healingZones: true as const } : {}) }), true)
    for (const player of roster) state.lockChampion(player.id)
    state.begin(roster)
    return state
  }
  const bodies = (state: ServerGameState) => [...state.simulator.characters.values()].filter((character) => character.structure).map((character) => [character.turret?.id, character.team, character.isCore])
  assert.deepEqual(bodies(started(true)), [
    [healingZoneId(1), 1, false],
    [healingZoneId(2), 2, false],
    [healingZoneId(CORE_TIER), 1, true],
    [healingZoneId(CORE_TIER), 2, true],
  ])
  assert.deepEqual(bodies(started(false)), [
    [turretId(1), 1, false],
    [turretId(2), 2, false],
    [turretId(CORE_TIER), 1, true],
    [turretId(CORE_TIER), 2, true],
  ], 'and turrets with it off')
  const zones = started(true)
  const coreOne = [...zones.simulator.characters.values()].find((character) => character.isCore && character.team === 1)
  assert.ok(coreOne)
  assert.equal(zones.simulator.shieldedIn(zones.simulator.at(1)).has(coreOne.id), true, 'a core zone is protected while a zone of its team below it stands')
})

test('a core zone that is broken stops its team respawning, as a core does', () => {
  const setup: ModeSetup = { kind: 'core', teams: [1, 2], healingZones: true }
  const game = new Game(setup)
  game.simulator.addTurret(10, getCoreZone(), Z, 1)
  game.simulator.addPlayer(2, 'p2', 'Breaker', inZone(0, getCoreZone().champion.radius + 60), breaker, 2)
  game.simulator.addOrder(2, attack(1, 10))
  game.run(30)
  assert.equal(game.simulator.at(30).get(10)?.isDead(), true, 'it falls')
  const objective = game.simulator.at(30).getObjective()
  assert.ok(objective?.kind === 'core' && objective.broken.includes(1), 'and its team\'s core is broken')
})

// ---------------------------------------------------------------------------- on the page

test('the page draws each standing zone as the area it heals in, in its team\'s colour, with no tower\'s ring or shadow', () => {
  const state = new ClientGameState()
  state.simulator.reset(undefined, ZONES)
  state.simulator.addTurret(10, ZONE, Z, 1)
  state.simulator.addTurret(11, getTurret(1), { x: 1800, y: 700 }, 2)
  state.resetServerTickAnchor(0, 0)
  state.simulator.advanceTo(2)
  assert.equal(state.hasHealingZones(), true, 'it knows the shops do not heal')
  const characters = state.getCharacters(2 * 1000 / 60)
  const zone = characters.find((character) => character.id === 10)
  assert.deepEqual(zone?.turret?.zone, { reach: ZONE_DEF.reach })
  assert.deepEqual(layoutHealingZones(characters), [{ x: Z.x, y: Z.y, inner: ZONE.champion.radius, reach: ZONE_DEF.reach, color: getTeam(1).color }])
  assert.deepEqual(layoutTurretRings(characters).length, 1, 'the turret has its ring, and the zone none')
  assert.equal(layoutTurretShadows(characters).length, 1, 'and the same for the shadow')
  assert.deepEqual(layoutHealingZones(characters.map((character) => ({ ...character, dead: true }))), [], 'a broken zone is not drawn')

  const protectedCore: CoreView = { team: 1, hp: 10, maxHp: 10, status: 'protected', playersAlive: 1 }
  assert.equal(coreReadout({ ...protectedCore, zones: true }).text, 'Protected by healing zones')
  assert.equal(coreReadout(protectedCore).text, 'Protected by turrets')
})
