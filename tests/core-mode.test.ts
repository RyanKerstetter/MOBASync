import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ClientGameState, type RenderedCharacter } from '../apps/client/src/game-state.ts'
import { coreHint, coreReadout, type CoreView } from '../apps/client/src/ui/mode-hud.ts'
import { resultHeadline } from '../apps/client/src/ui/results.ts'
import { TeamVision } from '../apps/client/src/team-vision.ts'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  advanceObjective,
  createModeSetup,
  GAME_ART_SCALE,
  GAME_MAX_CHAMPION_RADIUS,
  GAME_MAX_PLAYERS,
  GAME_VISION_RANGE,
  CORE_TIER,
  GameSnapshotSchema,
  getCore,
  getGameMode,
  getTeam,
  getTurret,
  initialObjective,
  modeStartProblem,
  modeSupportProblem,
  NO_OBJECTIVES,
  parseTiledMap,
  readMapLayout,
  Simulator,
  summarizeMap,
  teamCountProblem,
  Terrain,
  turretId,
  winningTeam,
  type GameResult,
  type ModeSetup,
  type ObjectiveCore,
  type ObjectiveState,
  type ObjectiveUnit,
  type SightViewer,
  type VisionMask,
  type VisionSystem,
} from '../packages/shared/src/index.ts'
import { brawler, defineChampion, defineTurret } from './fixtures.ts'
import { testSpawns } from './test-spawns.ts'

// Core destruction (see modes.ts): two teams, each with a core at its base. Break the enemy's, and that team can no longer respawn; take down
// every player left on it and the game is won. The cores and tiers in these are the tests' own.

// A core is a turret, the last of a base: it waits for the turrets of its team of lower tiers. These reach no one (a range of 1), so there is only the breaking of them. One is
// below the outpost, and so waits for nothing; the other is above it, and waits for it.
const coreBody = { base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 }, radius: 40, attackRange: 1, attackWindup: 0, core: true } as const
const frail = defineTurret(70, coreBody)
const guarded = defineTurret(72, coreBody)
const outpost = defineTurret(71, { base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 }, radius: 30, attackRange: 200, attackWindup: 0 })
const slayer = defineChampion({ ...brawler, id: 't-cm-slayer', base: { ...brawler.base, attackDamage: 5000 }, abilities: [] })

const ONE = { x: 600, y: 700 }
const TWO = { x: 1900, y: 700 }
const pair = [ONE, TWO]

// ---------------------------------------------------------------------------- the mode

test('core destruction is a mode of its own, with no score limit to set, for one team or two', () => {
  const mode = getGameMode('core')
  assert.deepEqual([mode.id, mode.name, mode.scoreName], ['core', 'Core Destruction', 'cores'])
  assert.deepEqual([mode.defaultLimit, mode.maxLimit], [0, 0], 'it ends when a team is out')
  assert.equal(teamCountProblem('core', 1), undefined, 'one team plays alone')
  assert.equal(teamCountProblem('core', 2), undefined)
  assert.match(teamCountProblem('core', 3) ?? '', /Core Destruction needs 1 or 2 teams, and there are 3/)
  assert.match(teamCountProblem('core', 0) ?? '', /1 or 2 teams, and there are 0/)
})

test('a map needs a core for each of the first two teams for it, and says which it lacks', () => {
  const map = { name: 'The Pit', hill: true, flags: true, cores: false }
  assert.match(modeSupportProblem('core', map) ?? '', /The Pit has no core for each of the first two teams, so Core Destruction cannot be played on it/)
  assert.equal(modeSupportProblem('core', { ...map, cores: true }), undefined)
  for (const mode of ['deathmatch', 'koth', 'ctf'] as const) assert.equal(modeSupportProblem(mode, map), undefined, `${mode} does not need a core`)
  assert.match(modeStartProblem('core', [1, 2], NO_OBJECTIVES) ?? '', /no core for each of the first two teams/)
  assert.match(modeStartProblem('core', [1, 2], { flags: [], cores: [ONE, undefined] }) ?? '', /no core/, 'one core is not enough')
  assert.match(modeStartProblem('core', [1, 2, 3], { flags: [], cores: pair }) ?? '', /1 or 2 teams/)
  assert.equal(modeStartProblem('core', [1, 2], { flags: [], cores: pair }), undefined)
  assert.equal(modeStartProblem('core', [1], { flags: [], cores: pair }), undefined, 'a lone player is fine on a map that has the cores')
  assert.match(modeStartProblem('core', [1], NO_OBJECTIVES) ?? '', /no core for each of the first two teams/, 'but the map still has to be one for the mode')
})

test('a game is set up with its two teams, the biggest first, and the respawn time it is given, and its objective starts with nothing broken', () => {
  const setup = createModeSetup('core', [2, 1, 1], { flags: [], cores: pair }, { respawnTicks: 120 })
  assert.deepEqual(setup, { kind: 'core', teams: [1, 2], respawnTicks: 120 }, 'team 1 has two players, so it starts at the first slot')
  assert.deepEqual(createModeSetup('core', [1, 2], { flags: [], cores: pair }), { kind: 'core', teams: [1, 2] })
  assert.throws(() => createModeSetup('core', [1, 2], NO_OBJECTIVES), /no core for each of the first two teams/)
  assert.throws(() => createModeSetup('core', [1, 2, 3], { flags: [], cores: pair }), /1 or 2 teams/)
  assert.deepEqual(createModeSetup('core', [2, 2], { flags: [], cores: pair }), { kind: 'core', teams: [2] }, 'a team alone is the only one in the setup')
  assert.deepEqual(initialObjective(setup), { kind: 'core', broken: [], eliminated: [], scores: {} })
})

// ---------------------------------------------------------------------------- the objective

const setup: ModeSetup = { kind: 'core', teams: [1, 2] }
const unit = (id: number, team: number, alive = true): ObjectiveUnit => ({ id, team, position: { x: 0, y: 0 }, radius: 18, alive })
const standing = (one: boolean, two: boolean): ObjectiveCore[] => [{ team: 1, standing: one }, { team: 2, standing: two }]
const step = (state: ObjectiveState | undefined, units: ObjectiveUnit[], cores: ObjectiveCore[], tick = 1) =>
  advanceObjective(state, setup, units, tick, [], cores)

test('a team is out only when its core is broken and every player on it is dead, and its score is the cores of the others it has broken', () => {
  const players = [unit(1, 1), unit(2, 1), unit(3, 2), unit(4, 2)]
  const start = step(undefined, players, standing(true, true))
  assert.deepEqual(start, { kind: 'core', broken: [], eliminated: [], scores: { 1: 0, 2: 0 } })
  assert.equal(winningTeam(setup, start), undefined)

  // Everyone on a team dead is not out while its core stands: they come back.
  const wiped = step(start, [unit(1, 1), unit(2, 1), unit(3, 2, false), unit(4, 2, false)], standing(true, true))
  assert.deepEqual([wiped?.kind === 'core' && wiped.eliminated, winningTeam(setup, wiped)], [[], undefined])

  // Its core broken, with players left: out of respawns, but not out.
  const broken = step(wiped, [unit(1, 1), unit(2, 1), unit(3, 2, false), unit(4, 2)], standing(true, false))
  assert.deepEqual(broken, { kind: 'core', broken: [2], eliminated: [], scores: { 1: 1, 2: 0 } })
  assert.equal(winningTeam(setup, broken), undefined)

  // And the last of them down: out, and the other team has won.
  const out = step(broken, [unit(1, 1), unit(2, 1), unit(3, 2, false), unit(4, 2, false)], standing(true, false))
  assert.deepEqual(out, { kind: 'core', broken: [2], eliminated: [2], scores: { 1: 1, 2: 0 } })
  assert.equal(winningTeam(setup, out), 1)
})

test('a broken core stays broken, a team that is out stays out, and a player who is not in the game is not a player left', () => {
  const players = [unit(1, 1), unit(3, 2, false)]
  const out = step(undefined, players, standing(true, false))
  assert.deepEqual(out?.kind === 'core' && out.eliminated, [2])
  // Whatever a later tick is told, what was broken is broken, and who was out is out.
  const later = step(out, [unit(1, 1), unit(3, 2, true)], standing(true, true), 2)
  assert.deepEqual(later?.kind === 'core' && [later.broken, later.eliminated], [[2], [2]])
  // A team whose players have all left the game, with its core broken, is out.
  assert.deepEqual(step(undefined, [unit(1, 1)], standing(true, false)), { kind: 'core', broken: [2], eliminated: [2], scores: { 1: 1, 2: 0 } })
})

test('when both teams are out at once no one has won, and an objective that is not this mode\'s has no winner', () => {
  const both = step(undefined, [unit(1, 1, false), unit(3, 2, false)], standing(false, false))
  assert.deepEqual(both?.kind === 'core' && both.eliminated, [1, 2])
  assert.equal(winningTeam(setup, both), undefined)
  assert.equal(winningTeam(setup, undefined), undefined)
  assert.equal(winningTeam(setup, { kind: 'deathmatch', scores: { 1: 50 } }), undefined, 'a score does not win it: there is no limit')
  assert.equal(winningTeam({ kind: 'core', teams: [1, 2], scoreLimit: 1 } as ModeSetup, { kind: 'deathmatch', scores: { 1: 50 } }), undefined)
})

// ---------------------------------------------------------------------------- a game

const glass = defineChampion({ ...brawler, id: 't-cm-glass', base: { ...brawler.base, maxHp: 100 }, abilities: [] })
const attack = (id: number, tick: number, targetId: number) => ({ id: `a${id}:${tick}`, seq: tick, tick, type: 'attack' as const, targetId })

function game(respawnTicks = 60): Simulator {
  const mode = createModeSetup('core', [1, 2], { flags: [], cores: pair }, { respawnTicks })
  const simulator = new Simulator(Terrain.plain(), mode)
  // Team 1 is on the west and team 2 on the east, each with a core that one hit breaks.
  simulator.addTurret(10, frail, ONE, 1)
  simulator.addTurret(11, frail, TWO, 2)
  return simulator
}
const run = (simulator: Simulator, from: number, to: number): void => {
  for (let tick = from; tick <= to; tick += 1) simulator.at(tick)
}
const frameOf = (simulator: Simulator, tick: number) => simulator.at(tick)
const objectiveOf = (simulator: Simulator, tick: number): Extract<ObjectiveState, { kind: 'core' }> => {
  const objective = simulator.at(tick).getObjective()
  assert.equal(objective?.kind, 'core')
  return objective as Extract<ObjectiveState, { kind: 'core' }>
}

test('a team respawns until its core is broken, and then does not, and the last team with a player left wins', () => {
  const simulator = game()
  // Team 1's slayer (1) beside team 2's core, a frail player of team 1 (2) and a slayer of team 2 (3) beside each other far away, and
  // a frail player of team 2 (4) beside the first.
  simulator.addPlayer(1, 'p1', 'One', { x: 1800, y: 700 }, slayer, 1)
  simulator.addPlayer(2, 'p2', 'Two', { x: 1300, y: 1200 }, glass, 1)
  simulator.addPlayer(3, 'p3', 'Three', { x: 1400, y: 1200 }, slayer, 2)
  simulator.addPlayer(4, 'p4', 'Four', { x: 1800, y: 900 }, glass, 2)
  // Tick 1: one goes for the core, and three for two.
  simulator.addOrder(1, attack(1, 1, 11))
  simulator.addOrder(3, attack(3, 1, 2))
  run(simulator, 1, 40)
  assert.equal(simulator.at(40).get(11)?.isDead(), true, 'the core of team 2 is down')
  assert.equal(simulator.at(40).get(2)?.isDead(), true, 'and the frail player of team 1 is dead')
  assert.deepEqual(objectiveOf(simulator, 40), { kind: 'core', broken: [2], eliminated: [], scores: { 1: 1, 2: 0 } })

  // Team 1's core stands, so its player comes back, 60 ticks after the death, though the other team's core is down.
  const diedAt = simulator.at(40).get(2)?.getDeathTick() as number
  run(simulator, 41, diedAt + 70)
  assert.equal(simulator.at(diedAt + 70).get(2)?.isDead(), false, 'respawned')
  assert.equal(simulator.at(diedAt + 70).get(2)?.getHealth(), glass.maxHp)
  assert.equal(simulator.canRespawn(2, simulator.at(diedAt + 70)), true)

  // Team 2's player is killed, and with its core down does not come back, however long it waits. The team has one more player (3),
  // so it is not out.
  const now = diedAt + 70
  simulator.addOrder(1, attack(1, now + 1, 4))
  run(simulator, now + 1, now + 150)
  const fell = simulator.at(now + 150).get(4)?.getDeathTick()
  assert.ok(fell !== undefined, 'the player of team 2 is dead')
  assert.equal(simulator.canRespawn(4, simulator.at(now + 150)), false)
  run(simulator, now + 151, (fell as number) + 400)
  assert.equal(simulator.at((fell as number) + 400).get(4)?.getDeathTick(), fell, 'and is still dead long after any respawn')
  assert.deepEqual(objectiveOf(simulator, (fell as number) + 400).eliminated, [], 'the team is not out with a player alive')
  assert.equal(winningTeam(simulator.mode, simulator.at((fell as number) + 400).getObjective()), undefined)

  // The last of team 2 is taken down: it is out, and team 1 has won.
  const last = (fell as number) + 401
  simulator.addOrder(1, attack(1, last, 3))
  run(simulator, last, last + 400)
  assert.equal(simulator.at(last + 400).get(3)?.isDead(), true)
  const after = simulator.at(last + 400).getObjective()
  assert.deepEqual(after, { kind: 'core', broken: [2], eliminated: [2], scores: { 1: 1, 2: 0 } })
  assert.equal(winningTeam(simulator.mode, after), 1)
})

test('a turret falling does not stop its team respawning: a core is a turret, but it is the core being broken that counts', () => {
  const simulator = game()
  // Team 2 has an outpost beside its core. Team 1's slayer (1) takes it down, and then a frail player of team 2 (4).
  simulator.addTurret(12, outpost, { x: 1800, y: 760 }, 2)
  simulator.addPlayer(1, 'p1', 'One', { x: 1800, y: 700 }, slayer, 1)
  simulator.addPlayer(4, 'p4', 'Four', { x: 1800, y: 640 }, glass, 2)
  simulator.addOrder(1, attack(1, 1, 12))
  run(simulator, 1, 20)
  assert.equal(simulator.at(20).get(12)?.isDead(), true, 'the outpost is down')
  assert.equal(simulator.at(20).get(11)?.isDead(), false, 'and the core is not')
  assert.deepEqual(objectiveOf(simulator, 20).broken, [], 'no core is broken, so none is counted')
  simulator.addOrder(1, attack(1, 21, 4))
  run(simulator, 21, 120)
  const diedAt = simulator.at(120).get(4)?.getDeathTick()
  assert.ok(diedAt !== undefined, 'the frail player is dead')
  assert.equal(simulator.canRespawn(4, simulator.at(120)), true, 'and its team can still bring it back')
  run(simulator, 121, (diedAt as number) + 70)
  assert.equal(simulator.at((diedAt as number) + 70).get(4)?.isDead(), false, 'which it does, with its turret down')
})

test('a player who died before the core was broken, and whose time to respawn comes after, stays dead', () => {
  const simulator = game(600)
  simulator.addPlayer(1, 'p1', 'One', { x: 1800, y: 700 }, slayer, 1)
  simulator.addPlayer(4, 'p4', 'Four', { x: 1800, y: 900 }, glass, 2)
  simulator.addPlayer(5, 'p5', 'Five', { x: 2100, y: 900 }, glass, 2)
  simulator.addOrder(1, attack(1, 1, 4))
  run(simulator, 1, 80)
  const died = simulator.at(80).get(4)?.getDeathTick() as number
  assert.ok(died !== undefined, 'dead before the core fell')
  assert.equal(simulator.at(80).get(11)?.isDead(), false, 'and the core is up')
  simulator.addOrder(1, attack(1, 81, 11))
  run(simulator, 81, died + 640)
  assert.equal(simulator.at(died + 640).get(11)?.isDead(), true, 'the core fell in the meantime')
  assert.equal(simulator.at(died + 640).get(4)?.getDeathTick(), died, 'so it did not respawn when its 600 ticks were up')
})

test('in other modes nothing changes: a team respawns whatever is broken', () => {
  const simulator = new Simulator(Terrain.plain(), { kind: 'deathmatch', respawnTicks: 60 })
  simulator.addTurret(11, frail, TWO, 2)
  simulator.addPlayer(1, 'p1', 'One', { x: 1800, y: 700 }, slayer, 1)
  simulator.addPlayer(4, 'p4', 'Four', { x: 1800, y: 900 }, glass, 2)
  simulator.addOrder(1, attack(1, 1, 11))
  run(simulator, 1, 40)
  assert.equal(simulator.at(40).get(11)?.isDead(), true)
  simulator.addOrder(1, attack(1, 41, 4))
  run(simulator, 41, 160)
  assert.equal(simulator.at(160).get(4)?.isDead(), false, 'it died, and came back, as there is no core to say it cannot')
  assert.equal(simulator.canRespawn(4, simulator.at(160)), true)
  assert.notEqual(simulator.at(160).getObjective()?.kind, 'core', 'and there is no core objective to keep')
})

test('a core protected by a turret cannot be broken until it falls, and the game plays out the same when worked out again and from a snapshot', () => {
  const build = (): Simulator => {
    const simulator = new Simulator(Terrain.plain(), createModeSetup('core', [1, 2], { flags: [], cores: pair }, { respawnTicks: 60 }))
    simulator.addTurret(10, guarded, ONE, 1)
    simulator.addTurret(11, guarded, TWO, 2)
    simulator.addTurret(12, outpost, { x: 1900, y: 900 }, 2)
    simulator.addPlayer(1, 'p1', 'One', { x: 1800, y: 800 }, slayer, 1)
    return simulator
  }
  const late = attack(1, 20, 12)
  const straight = build()
  straight.addOrder(1, attack(1, 2, 11))
  straight.addOrder(1, late)
  straight.addOrder(1, attack(1, 60, 11))
  straight.advanceTo(200)
  assert.equal(straight.at(200).get(12)?.isDead(), true, 'the turret fell to the attack at tick 20')
  assert.equal(straight.at(200).get(11)?.isDead(), true, 'and then the core did, at 60')

  // The same game with the order for the turret arriving late, for a tick that has been worked out already.
  const redone = build()
  redone.addOrder(1, attack(1, 2, 11))
  redone.addOrder(1, attack(1, 60, 11))
  redone.advanceTo(30)
  assert.equal(redone.addOrder(1, late), true)
  redone.advanceTo(200)
  assert.equal(JSON.stringify(redone.at(200).toData()), JSON.stringify(straight.at(200).toData()))

  straight.setCommitTick(190)
  const snapshot = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(straight.snapshot())))
  assert.deepEqual(snapshot.mode, { kind: 'core', teams: [1, 2], respawnTicks: 60 })
  assert.equal(snapshot.checkpoint.objective?.kind, 'core')
  const joined = new Simulator()
  joined.replaceFromSnapshot(snapshot)
  assert.equal(joined.characters.get(11)?.turret, guarded)
  straight.advanceTo(260)
  joined.advanceTo(260)
  assert.equal(JSON.stringify(joined.at(260).toData()), JSON.stringify(straight.at(260).toData()))
})

// ---------------------------------------------------------------------------- the map

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
let nextId = 900
const point = (slot: unknown, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id: nextId++,
  name: `heart-${String(slot)}`,
  type: 'core',
  point: true,
  x,
  y,
  properties: slot === undefined ? [] : [{ name: 'team-name', type: 'int', value: slot }],
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

test('a map puts a core where its core point is, for the slot of spawn points it names', () => {
  const layout = readMapLayout(mapWith([point(2, 500, 300), point(1, 100.4, 80.6)]))
  // Map pixels from the arena's corner are three world units each, in whole numbers, and the list is by slot.
  assert.deepEqual(layout.cores, [{ x: 301, y: 242 }, { x: 1500, y: 900 }])
  assert.deepEqual(readMapLayout(mapWith([])).cores, [], 'a map need not have any')
  assert.deepEqual(readMapLayout(mapWith([point(2, 500, 300)])).cores, [undefined, { x: 1500, y: 900 }], 'a slot with none is a gap')
  assert.equal(summarizeMap('hearts', readMapLayout(mapWith([point(1, 100, 80), point(2, 500, 300)]))).cores, true, 'with both, the lobby is told')
  assert.equal(summarizeMap('hearts', readMapLayout(mapWith([point(2, 500, 300)]))).cores, false, 'with one it is not')
  assert.equal(summarizeMap('hearts', readMapLayout(mapWith([]))).cores, false)
})

test('a core point that is not right says which, and what is wrong', () => {
  assert.match(problemsOf([point(1, 100, 100, { point: false, width: 5, height: 5 })]), /heart-1 is not a point/)
  assert.match(problemsOf([point(undefined, 100, 100)]), new RegExp(`heart-undefined needs a team-name from 1 to ${GAME_MAX_PLAYERS}: the slot of spawn points whose base it is the heart of`))
  for (const slot of [0, GAME_MAX_PLAYERS + 1, 1.5, 'one']) assert.match(problemsOf([point(slot, 100, 100)]), /needs a team-name from 1/, String(slot))
  assert.match(problemsOf([point(1, 100, 100), point(1, 300, 100)]), /has the same team-name \(1\) as another core/)
  assert.match(problemsOf([point(1, -5, 100)]), /heart-1 is outside the arena/)
  const pixels = getCore().champion.radius / GAME_ART_SCALE
  assert.match(problemsOf([point(1, Math.floor(pixels) - 1, 100)]), /heart-1 is too close to a wall or the arena's edge: the core would stand in it/)
  // It says where it would fit: the nearest place with its whole size inside the arena, in the map's own pixels.
  const fit = Math.round(pixels * 10) / 10
  assert.match(
    problemsOf([point(1, Math.floor(pixels) - 1, 100)]),
    new RegExp(`the core would stand in it\\. The nearest place that clears the walls and the edge is about \\(${fit}, 100\\) in the map's own pixels \\(keep it clear of the spawn points and the turrets too\\)\\.`),
  )
  assert.match(problemsOf([point(1, Math.floor(pixels / 2), 100), point(2, 790, 100)]), new RegExp(`heart-1 .*about \\(${fit}, 100\\).*\\n.*heart-2 .*about \\([\\d.]+, 100\\)`), 'for each that is wrong, and all at once')
  assert.equal(readMapLayout(mapWith([point(1, Math.ceil(pixels) + 1, 100)])).cores.length, 1, 'with room for its size it is fine')
})

// A turret as the map has it, for the tests of what stands in what.
const tower = (tier: number, slot: number, x: number, y: number) => {
  const id = nextId++
  return {
    id,
    name: `tower-${id}`,
    type: 'turret',
    point: true,
    x,
    y,
    properties: [{ name: 'team-name', type: 'int', value: slot }, { name: 'turret-tier', type: 'int', value: tier }],
  }
}

test('a core has to be clear of the spawn points, by its size and the widest champion\'s, or a champion would start inside it', () => {
  // Spawn 1 of slot 1 is at (200, 140). The core and the widest champion are `radius + GAME_MAX_CHAMPION_RADIUS` across from their middles, which is how far
  // apart they have to be, in the map's own pixels (said to a tenth, rounded up). A whole pixel of that is just clear, and a pixel less is not.
  const need = (getCore().champion.radius + GAME_MAX_CHAMPION_RADIUS) / GAME_ART_SCALE
  const said = Math.ceil(need * 10) / 10
  const clear = 200 + Math.ceil(need)
  const half = Math.floor(need / 2)
  assert.match(problemsOf([point(1, 200, 140)]), new RegExp(`spawn-1-1 is too close to heart-1: they are 0 map pixels apart and need ${said}, or a champion would start inside it\\.`))
  assert.match(problemsOf([point(1, 200 + half, 140)]), new RegExp(`spawn-1-1 is too close to heart-1: they are ${half} map pixels apart and need ${said},`))
  assert.deepEqual(readMapLayout(mapWith([point(1, clear, 140)])).cores, [{ x: clear * GAME_ART_SCALE, y: 140 * GAME_ART_SCALE }], 'a core that is just clear of it is fine')
  assert.match(problemsOf([point(1, clear - 1, 140)]), new RegExp(`spawn-1-1 is too close to heart-1: they are ${Math.ceil(need) - 1} map pixels apart`), 'and a pixel nearer is not')
})

test('a turret point cannot name the core\'s tier: a core is a turret, but a map puts it down with a core point, so a turret point for its tier is left out and said so', () => {
  const layout = readMapLayout(mapWith([tower(CORE_TIER, 1, 400, 300), point(1, 700, 300)]))
  assert.deepEqual(layout.turrets, [], 'no turret was made of it')
  assert.equal(layout.cores.filter(Boolean).length, 1, 'while the core point was')
  assert.ok(layout.warnings.some((warning) => new RegExp(`is for a tier ${CORE_TIER} turret, which the game does not have`).test(warning)), layout.warnings.join(' | '))
  assert.ok(!layout.warnings.some((warning) => warning.includes(`tiers ${CORE_TIER}`)) && layout.warnings.every((warning) => !/only tiers .*\b${CORE_TIER}\b/.test(warning)), 'and the tiers it lists as the game\'s do not include the core\'s')
})

test('a turret or a core cannot stand in another, and a turret has to be clear of the spawn points too', () => {
  const far = readMapLayout(mapWith([tower(1, 1, 400, 300), point(1, 400 + 120, 300)]))
  assert.deepEqual([far.turrets.length, far.cores.filter(Boolean).length], [1, 1], 'a turret and a core with room between them are fine')
  const radii = (getTurret(1).champion.radius + getCore().champion.radius) / GAME_ART_SCALE
  assert.match(
    problemsOf([tower(1, 1, 400, 300), point(1, 410, 300)]),
    new RegExp(`is too close to heart-1: they are 10 map pixels apart and need ${Math.ceil(radii * 10) / 10}, or they would stand in each other\\.`),
  )
  assert.match(problemsOf([tower(1, 1, 400, 300), tower(2, 2, 405, 300)]), /is too close to tower-\d+: they are 5 map pixels apart and need [\d.]+, or they would stand in each other\./)
  assert.match(problemsOf([tower(1, 1, 200, 140)]), /spawn-1-1 is too close to tower-\d+: they are 0 map pixels apart and need [\d.]+, or a champion would start inside it\./)
  // Every spawn point that is too near is said, not only the first.
  const said = problemsOf([point(1, 200, 160)])
  assert.ok(['spawn-1-1', 'spawn-1-2'].every((spawn) => said.includes(`${spawn} is too close to heart-1`)), said)
})

test('a core is read from the competitive map when it has them, and a map with none is still fine', () => {
  const map = parseTiledMap(JSON.parse(readFileSync(new URL('../res/maps/competetive.tmj', import.meta.url), 'utf-8')))
  const layout = readMapLayout(map)
  assert.ok(Array.isArray(layout.cores))
  for (const at of layout.cores) if (at) assert.ok(at.x > 0 && at.y > 0 && at.x < layout.terrain.width && at.y < layout.terrain.height)
})

// ---------------------------------------------------------------------------- the server

const players = [{ id: 'a', name: 'Ann', team: 1 }, { id: 'b', name: 'Bob', team: 2 }]
const terrain = new Terrain({ width: 2400, height: 1400 })
const withCores = {
  id: 'hearts',
  spawns: testSpawns,
  terrain,
  flags: [],
  cores: [{ x: 120, y: 600 }, { x: 430, y: 480 }],
}

function started(mode: 'core' | 'deathmatch', map = withCores, roster = players): ServerGameState {
  const state = new ServerGameState([])
  assert.equal(state.beginSelection(roster, map, mode, { respawnTicks: 60 }), true)
  for (const player of roster) {
    state.pickChampion(player.id, slayer.id)
    state.lockChampion(player.id)
  }
  state.begin(roster)
  return state
}

test('the server puts a core in a game of this mode for each of its two teams, at the base of the slot it starts at, after the others', () => {
  const state = started('core')
  assert.deepEqual([...state.simulator.characters.values()].map((character) => [character.id, character.isCore ? character.turret?.id : undefined, character.team]), [
    [1, undefined, 1],
    [2, undefined, 2],
    [3, turretId(CORE_TIER), 1],
    [4, turretId(CORE_TIER), 2],
  ])
  assert.deepEqual(state.simulator.characters.get(3)?.initialPosition, withCores.cores[0])
  assert.deepEqual(state.simulator.characters.get(4)?.initialPosition, withCores.cores[1])
  assert.equal(state.simulator.mode.kind, 'core')
  assert.deepEqual(state.playingPlayerIds.sort(), ['a', 'b'], 'cores are not players')
  const snapshot = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(state.snapshot())))
  assert.deepEqual(snapshot.characters.slice(2).map((character) => [character.id, character.championId, character.team, character.player]), [
    [3, turretId(CORE_TIER), 1, undefined],
    [4, turretId(CORE_TIER), 2, undefined],
  ])
  // The same map in another mode has no cores: they are what this one is played for.
  const other = started('deathmatch')
  assert.equal([...other.simulator.characters.values()].some((character) => character.isCore), false)
})

test('a game that is not told its mode is team deathmatch, whatever the lobby starts in', () => {
  const state = new ServerGameState([])
  assert.equal(state.mode, 'deathmatch')
  assert.equal(state.beginSelection(players, { ...withCores, cores: [] }), true)
  assert.equal(state.mode, 'deathmatch', 'a map with no cores is played as it always was when no mode is given')
})

test('the server refuses the mode on a map with no cores, and with more than two teams, and says why', () => {
  const state = new ServerGameState([])
  assert.match(state.modeProblem(players, 'core', { ...withCores, cores: [] }) ?? '', /no core for each of the first two teams/)
  assert.match(state.modeProblem(players, 'core', { ...withCores, cores: [withCores.cores[0], undefined] }) ?? '', /no core/)
  assert.equal(state.modeProblem(players, 'core', withCores), undefined)
  const three = [...players, { id: 'c', name: 'Cat', team: 3 }]
  assert.match(state.modeProblem(three, 'core', withCores) ?? '', /1 or 2 teams, and there are 3/)
})

// ---------------------------------------------------------------------------- playing alone

const alone = [players[0]]

test('one team has no one to be the last of, so it never wins, whatever the others do', () => {
  const solo: ModeSetup = { kind: 'core', teams: [1] }
  const lone = advanceObjective(undefined, solo, [unit(1, 1)], 1, [], [{ team: 1, standing: true }])
  assert.deepEqual(lone, { kind: 'core', broken: [], eliminated: [], scores: { 1: 0 } })
  assert.equal(winningTeam(solo, lone), undefined, 'it is the last team standing from the first tick, and has won nothing')
  // Even a team that is out leaves no one to win: the game is for as long as there are players in it.
  const out = advanceObjective(lone, solo, [unit(1, 1, false)], 2, [], [{ team: 1, standing: false }])
  assert.equal(winningTeam(solo, out), undefined)
})

test('the server starts a game of this mode with one team, with only its core, and it goes on until the player leaves', () => {
  const state = started('core', withCores, alone)
  assert.equal(state.modeProblem(alone, 'core', withCores), undefined)
  assert.deepEqual([...state.simulator.characters.values()].map((character) => [character.id, character.isCore ? character.turret?.id : undefined, character.team]), [
    [1, undefined, 1],
    [2, turretId(CORE_TIER), 1],
  ], 'the core of the slot nobody starts at is not put in')
  state.markReady('a')
  assert.ok(state.startIfReady())
  let result: GameResult | undefined
  for (let tick = 0; tick < 900 && !result; tick += 1) result = state.advanceTick()
  assert.equal(result, undefined, 'nothing ends it')
  assert.equal(state.status, 'running')

  assert.equal(state.leaveGame('a'), true)
  assert.equal(state.closeIfEmpty(), true, 'the player leaving is what ends it')
  assert.equal(state.status, 'idle')
})

test('the server ends the game when a team is out, once that can no longer be undone, with the other team as the winner', () => {
  const state = started('core')
  for (const player of players) state.markReady(player.id)
  assert.ok(state.startIfReady())
  // Ann (1), at (250, 300), breaks the core of Bob's team (4, beside her) with two hits, and then goes for Bob (2), who has no respawn.
  state.simulator.addOrder(1, attack(1, 2, 4))
  state.simulator.addOrder(1, attack(1, 400, 2))
  let result: GameResult | undefined
  let ticks = 0
  while (!result && ticks < 900) {
    ticks += 1
    result = state.advanceTick()
  }
  assert.ok(result, 'the game ended')
  assert.equal(result?.reason, 'limit')
  assert.equal(result?.winner, 1)
  assert.equal(result?.mode, 'core')
  assert.equal(result?.scoreLimit, undefined)
  assert.deepEqual(result?.teams, [{ team: 1, score: 1 }, { team: 2, score: 0 }], 'the cores each team has broken')
  assert.deepEqual(result?.players.map((player) => [player.name, player.kills]).sort(), [['Ann', 1], ['Bob', 0]], 'a core is not a kill, and Bob is')
  assert.equal(state.status, 'finished')
  assert.ok(ticks > 400, 'not before Bob was taken down')
})

// ---------------------------------------------------------------------------- the page

function view(cores: CoreView[]): CoreView[] {
  return cores
}
const core = (team: number, status: CoreView['status'], hp = 600, playersAlive = 2, maxHp = 600): CoreView => ({ team, hp, maxHp, status, playersAlive })
const red = getTeam(1).name
const blue = getTeam(2).name

test('a core row says how full its health is, and how it stands in words', () => {
  assert.deepEqual(coreReadout(core(1, 'open', 450)), { fraction: 0.75, text: '450 / 600' })
  assert.deepEqual(coreReadout(core(1, 'open', 449.2)), { fraction: 449.2 / 600, text: '450 / 600' }, 'health is a whole number, rounded up')
  assert.deepEqual(coreReadout(core(1, 'protected', 600)), { fraction: 1, text: 'Protected by turrets' })
  assert.deepEqual(coreReadout(core(1, 'broken', 0, 3)), { fraction: 0, text: 'Core broken · 3 players left' })
  assert.deepEqual(coreReadout(core(1, 'broken', 0, 1)), { fraction: 0, text: 'Core broken · 1 player left' })
  assert.deepEqual(coreReadout(core(1, 'eliminated', 0, 0)), { fraction: 0, text: 'Eliminated' })
  assert.deepEqual(coreReadout(core(1, 'open', -5)), { fraction: 0, text: '-5 / 600' }, 'never a bar below empty')
  assert.equal(coreReadout(core(1, 'open', 5, 1, 0)).fraction, 0, 'or a bar for a core with no health to speak of')
})

test('the local player is told when their own core is down, and when the other team\'s is', () => {
  const local = { id: 1, team: 1 }
  assert.equal(coreHint(view([core(1, 'open'), core(2, 'open')]), local), undefined)
  assert.equal(coreHint(view([core(1, 'protected'), core(2, 'protected')]), local), undefined)
  assert.match(coreHint(view([core(1, 'broken'), core(2, 'open')]), local) ?? '', /Your core is down: you cannot respawn/)
  assert.equal(coreHint(view([core(1, 'open'), core(2, 'broken')]), local), `${blue}'s core is down. Take down every one of their players to win.`)
  assert.equal(coreHint(view([core(1, 'open'), core(2, 'broken')]), undefined), undefined, 'and no one when it is not their game')
  assert.notEqual(red, blue)
})

function clientGame(): ClientGameState {
  const state = new ClientGameState()
  state.simulator.reset(Terrain.plain(), createModeSetup('core', [1, 2], { flags: [], cores: pair }, { respawnTicks: 600 }))
  state.simulator.addTurret(10, guarded, ONE, 1)
  state.simulator.addTurret(11, guarded, TWO, 2)
  state.simulator.addTurret(12, outpost, { x: 1900, y: 900 }, 2)
  state.simulator.addPlayer(1, 'p1', 'One', { x: 1800, y: 800 }, slayer, 1)
  state.simulator.addPlayer(2, 'p2', 'Two', { x: 2100, y: 800 }, glass, 2)
  state.setLocalCharacterId(2)
  state.simulator.advanceTo(3)
  return state
}

test('the page shows each team\'s core, with its health, whether it is protected, and how many players the team has left', () => {
  const state = clientGame()
  const modeView = state.getModeView(0)
  assert.equal(modeView.kind, 'core')
  assert.deepEqual(modeView.kind === 'core' && modeView.cores, [
    { team: 1, hp: 100, maxHp: 100, status: 'open', playersAlive: 1 },
    { team: 2, hp: 100, maxHp: 100, status: 'protected', playersAlive: 1 },
  ], 'team 2\'s core waits for its turret; team 1\'s has none to wait for')
  assert.equal(modeView.limit, undefined)
  assert.deepEqual(modeView.scores, [{ team: 1, score: 0 }, { team: 2, score: 0 }])
  const characters = state.getCharacters(0)
  assert.deepEqual(characters.find((character) => character.id === 11)?.turret, { tier: guarded.tier, core: true, visionRange: guarded.visionRange }, 'the page is told it is the core, and how far its team sees from it')
  assert.equal(characters.find((character) => character.id === 11)?.invulnerable, true)
  assert.equal(characters.find((character) => character.id === 10)?.invulnerable, undefined)
  assert.equal(characters.find((character) => character.id === 11)?.name, 'Core')
  assert.equal(state.getLeaderboard().length, 2, 'cores are not on the leaderboard')
})

test('the page says a dead player is out of the game once their core is down, and counts down their respawn until then', () => {
  const state = clientGame()
  const id = 1
  // Team 1's player kills the turret, then the core, and then team 2's player.
  state.simulator.addOrder(id, { id: '1:1', seq: 1, tick: 4, type: 'attack', targetId: 12 })
  let tick = 3
  const to = (last: number): void => {
    while (tick < last) {
      tick += 1
      state.simulator.advanceTo(tick)
    }
  }
  to(60)
  assert.equal(state.simulator.at(60).get(12)?.isDead(), true, 'the turret is down')
  assert.equal(state.getModeView(0).kind === 'core' && state.getModeView(0).cores[1].status, 'open', 'so the core it guarded is open')
  state.simulator.addOrder(id, { id: '1:2', seq: 2, tick: 61, type: 'attack', targetId: 11 })
  to(140)
  const afterCore = state.getModeView(0)
  assert.deepEqual(afterCore.kind === 'core' && afterCore.cores[1], { team: 2, hp: 0, maxHp: 100, status: 'broken', playersAlive: 1 })
  assert.deepEqual(afterCore.scores, [{ team: 1, score: 1 }, { team: 2, score: 0 }])
  assert.equal(state.isLocalOutOfTheGame(0), false, 'the local player is alive')
  state.simulator.addOrder(id, { id: '1:3', seq: 3, tick: 141, type: 'attack', targetId: 2 })
  to(220)
  assert.equal(state.getCharacters(0).find((character) => character.id === 2)?.dead, true)
  assert.equal(state.isLocalOutOfTheGame(0), true, 'dead, with no core to come back to')
  assert.equal(state.getRespawnSecondsLeft(0), undefined, 'so there is no countdown')
  const done = state.getModeView(0)
  assert.deepEqual(done.kind === 'core' && done.cores[1].status, 'eliminated')
})

test('the countdown is there while the core stands', () => {
  const state = clientGame()
  state.simulator.addOrder(1, { id: '1:1', seq: 1, tick: 4, type: 'attack', targetId: 2 })
  let tick = 3
  while (tick < 80) {
    tick += 1
    state.simulator.advanceTo(tick)
  }
  assert.equal(state.getCharacters(0).find((character) => character.id === 2)?.dead, true)
  assert.equal(state.isLocalOutOfTheGame(0), false)
  assert.ok((state.getRespawnSecondsLeft(0) ?? 0) > 0, 'a countdown, as team 2\'s core stands')
})

// ---------------------------------------------------------------------------- what the team sees, and what the game says

test('a standing core is a place the team sees from, as far as it says, and is no player: a team with only its core and turrets sees the whole game', () => {
  const looks: SightViewer[][] = []
  const mask: VisionMask = { kind: 'cells', cell: 10, cols: 1, rows: 1, data: new Uint8Array([1]), revision: 1 }
  const system: VisionSystem = { name: 'square', see: (viewers) => { looks.push([...viewers]); return { mask, canSee: () => true } } }
  const piece = (id: number, team: number, extra: Partial<RenderedCharacter>): RenderedCharacter =>
    ({ id, team, position: { x: 100 * id, y: 100 }, dead: false, champion: { radius: 20 }, ...extra }) as unknown as RenderedCharacter
  const coreRange = 720
  const vision = new TeamVision(system)
  vision.update([piece(1, 1, {}), piece(2, 1, { turret: { tier: 3, core: true, visionRange: coreRange } }), piece(3, 1, { turret: { tier: 1, core: false, visionRange: 640 } })], 1)
  assert.deepEqual(looks[0].map((viewer) => viewer.range), [GAME_VISION_RANGE, coreRange, 640], 'the champion, the core and the turret all look, each as far as it sees')
  assert.deepEqual(looks[0][1].position, { x: 200, y: 100 }, 'the core from where it stands')

  // A core that is broken sees nothing, and neither does the other team's.
  const broken = new TeamVision(system)
  broken.update([piece(1, 1, {}), piece(2, 1, { turret: { tier: 3, core: true, visionRange: coreRange }, dead: true }), piece(5, 2, { turret: { tier: 3, core: true, visionRange: coreRange } })], 1)
  assert.deepEqual(looks[1].map((viewer) => viewer.range), [GAME_VISION_RANGE])

  const dark = new TeamVision(system)
  dark.update([piece(1, 1, { dead: true }), piece(2, 1, { turret: { tier: 3, core: true, visionRange: coreRange } }), piece(3, 1, { turret: { tier: 1, core: false, visionRange: 640 } }), piece(4, 2, {})], 1)
  assert.equal(dark.mask, undefined, 'no champion to see from, so everything is shown, whatever the core and the turret light')
  assert.equal(dark.visibleCharacters([piece(4, 2, {})]).length, 1)
})

test('the results say who won with no goal to name, as there is no limit', () => {
  const result: GameResult = {
    mode: 'core',
    reason: 'limit',
    winner: 1,
    teams: [{ team: 1, score: 1 }, { team: 2, score: 0 }],
    players: [{ name: 'Ann', team: 1, kills: 1 }, { name: 'Bob', team: 2, kills: 0 }],
  }
  assert.deepEqual(resultHeadline(result, 1), { title: 'Victory', subtitle: `${red} wins`, tone: 'win' })
  assert.deepEqual(resultHeadline(result, 2), { title: 'Defeat', subtitle: `${red} wins`, tone: 'loss' })
})
