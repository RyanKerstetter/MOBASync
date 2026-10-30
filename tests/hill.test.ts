import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceObjective,
  applyRulesChange,
  CAPTURE_SECONDS,
  createModeSetup,
  defaultRules,
  GAME_HILL_CAPTURE_TICKS,
  GAME_HILL_POINT_TICKS,
  GAME_MODES,
  GAME_RESPAWN_TICKS,
  GAME_TPS,
  hillCaptureTicks,
  hillMovement,
  hillOwner,
  initialObjective,
  modeRules,
  readRulesChange,
  Simulator,
  Terrain,
  type HillArea,
  type ModeSetup,
  type ObjectiveState,
  type ObjectiveUnit,
} from '../packages/shared/src/index.ts'
import { brawler } from './fixtures.ts'

// How the hill's bar moves when teams contest it, and how long it takes to fill. A team holds the hill while its bar is
// full; the bar goes down whenever another team has more players on the hill than the bar's team has.

type Koth = Extract<ObjectiveState, { kind: 'koth' }>
const HILL: HillArea = { x: 500, y: 300, width: 400, height: 200, ellipse: true }
const koth: ModeSetup = { kind: 'koth', hill: HILL }
const ON = { x: 700, y: 400 }
const OFF = { x: 2000, y: 1000 }

const unit = (id: number, team: number, at: { x: number; y: number }, alive = true): ObjectiveUnit =>
  ({ id, team, position: at, radius: 18, alive })

// The units of a few teams on the hill, `[team, how many]`; whoever is not named is somewhere else.
function crowd(...teams: Array<[team: number, count: number]>): ObjectiveUnit[] {
  let id = 0
  return teams.flatMap(([team, count]) => Array.from({ length: count }, () => unit((id += 1), team, { x: ON.x + id, y: ON.y })))
}

function run(state: Koth | undefined, units: readonly ObjectiveUnit[], ticks: number, from = 1, setup: ModeSetup = koth): Koth {
  let current = state ?? (initialObjective(setup) as Koth)
  for (let tick = from; tick < from + ticks; tick += 1) current = advanceObjective(current, setup, units, tick) as Koth
  return current
}

const held = (team: number): Koth => ({ kind: 'koth', capturer: team, progress: GAME_HILL_CAPTURE_TICKS, scores: {} })

test('the bar goes up for the team that leads on the hill, and down when it is another team\'s and it is outnumbered', () => {
  const presence = (...teams: Array<[number, number]>) => new Map(teams)
  assert.deepEqual(hillMovement({ progress: 0 }, presence()), { direction: 'none' }, 'no one on it')
  assert.deepEqual(hillMovement({ progress: 0 }, presence([2, 1])), { direction: 'up', leader: 2 }, 'an empty bar')
  assert.deepEqual(hillMovement({ capturer: 2, progress: 50 }, presence([2, 1])), { direction: 'up', leader: 2 }, 'its own')
  assert.deepEqual(hillMovement({ capturer: 1, progress: 50 }, presence([2, 1])), { direction: 'down', leader: 2 }, 'another\'s')
  assert.deepEqual(hillMovement({ capturer: 1, progress: 50 }, presence([1, 1], [2, 1])), { direction: 'none' }, 'level with the other')
  assert.deepEqual(hillMovement({ capturer: 1, progress: 50 }, presence([1, 2], [2, 1])), { direction: 'up', leader: 1 })
})

test('two teams level with each other on a hill another team holds take it down, though neither leads', () => {
  // Team 1 holds the hill, and has left. Teams 2 and 3 are on it, one each.
  const state = run(held(1), crowd([2, 1], [3, 1]), 100, GAME_HILL_CAPTURE_TICKS + 1)
  assert.deepEqual([state.capturer, state.progress], [1, GAME_HILL_CAPTURE_TICKS - 100], 'the bar drains')
  assert.equal(hillOwner(state), undefined, 'and team 1 no longer holds the hill')
  assert.deepEqual(hillMovement(state, new Map([[2, 1], [3, 1]])), { direction: 'down' })

  // It goes all the way down to nothing, and stays there while they are level: it is no one's.
  const empty = run(held(1), crowd([2, 1], [3, 1]), GAME_HILL_CAPTURE_TICKS + 500, GAME_HILL_CAPTURE_TICKS + 1)
  assert.deepEqual([empty.capturer, empty.progress], [undefined, 0])
})

test('it fills again only once one of them takes the lead, and then for that team', () => {
  const empty: Koth = { kind: 'koth', progress: 0, scores: {} }
  assert.deepEqual(run(empty, crowd([2, 1], [3, 1]), 300).progress, 0, 'level, so it stays empty')

  const taken = run(empty, crowd([2, 1], [3, 2]), 100)
  assert.deepEqual([taken.capturer, taken.progress], [3, 100], 'team 3 has more than team 2, so the bar fills for it')
})

test('a team that is outnumbered by two rivals level with each other loses the hill, though it is on it', () => {
  // Team 1 has one player on it, and teams 2 and 3 have two each: they are level, but both more than it.
  const state = run(held(1), crowd([1, 1], [2, 2], [3, 2]), 60, GAME_HILL_CAPTURE_TICKS + 1)
  assert.equal(state.progress, GAME_HILL_CAPTURE_TICKS - 60)
})

test('a team holds the hill against rivals that are not more than it, whoever is on it with it', () => {
  const stays = (units: ObjectiveUnit[]): number => run(held(1), units, 120, GAME_HILL_CAPTURE_TICKS + 1).progress
  assert.equal(stays(crowd([1, 1], [2, 1], [3, 1])), GAME_HILL_CAPTURE_TICKS, 'one each')
  assert.equal(stays(crowd([1, 2], [2, 2])), GAME_HILL_CAPTURE_TICKS, 'level with the other')
  assert.equal(stays(crowd([1, 2], [2, 1], [3, 1])), GAME_HILL_CAPTURE_TICKS, 'more than either')
  assert.equal(stays(crowd([1, 1])), GAME_HILL_CAPTURE_TICKS, 'alone on it')
  assert.equal(stays([]), GAME_HILL_CAPTURE_TICKS, 'no one on it: it stays held, as it was')
  assert.equal(stays(crowd([1, 1]).map((entry) => ({ ...entry, alive: false }))), GAME_HILL_CAPTURE_TICKS, 'the dead are not on it')
})

test('a partly filled bar is lost to rivals who are level with each other too, and stays when no one is on the hill', () => {
  const part: Koth = { kind: 'koth', capturer: 1, progress: 200, scores: {} }
  assert.equal(run(part, crowd([2, 1], [3, 1]), 50).progress, 150)
  assert.equal(run(part, [], 50).progress, 200)
  assert.equal(run(part, crowd([1, 1], [2, 1]), 50).progress, 200, 'level with a rival')
  assert.equal(run(part, crowd([1, 1], [2, 1], [3, 1]), 50).progress, 200, 'level with both')
})

test('a team that has lost the hill to a level crowd stops scoring at once', () => {
  const start = run(undefined, crowd([1, 1]), GAME_HILL_CAPTURE_TICKS)
  assert.deepEqual(start.scores, { 1: 1 })
  const later = run(start, crowd([2, 1], [3, 1]), GAME_HILL_POINT_TICKS * 3, GAME_HILL_CAPTURE_TICKS + 1)
  assert.deepEqual(later.scores, { 1: 1 }, 'not another point')
})

// ---------------------------------------------------------------------------- how long it takes

test('the time to capture is the leader\'s to set, and a game without one takes the default', () => {
  const quick: ModeSetup = { kind: 'koth', hill: HILL, captureTicks: 2 * GAME_TPS }
  const alone = crowd([2, 1])
  const state = run(undefined, alone, 2 * GAME_TPS, 1, quick)
  assert.deepEqual([state.capturer, state.progress, hillOwner(state, hillCaptureTicks(quick))], [2, 120, 2], 'two seconds is enough')
  assert.equal(run(undefined, alone, 2 * GAME_TPS - 1, 1, quick).progress, 119)
  assert.equal(run(state, alone, 50, 121, quick).progress, 120, 'and the bar stops at full')
  assert.equal(hillOwner(run(undefined, alone, 2 * GAME_TPS), undefined), undefined, 'the default is not that quick')
  assert.equal(hillCaptureTicks(koth), GAME_HILL_CAPTURE_TICKS)

  const slow: ModeSetup = { kind: 'koth', hill: HILL, captureTicks: 30 * GAME_TPS }
  assert.equal(hillOwner(run(undefined, alone, 29 * GAME_TPS, 1, slow), 30 * GAME_TPS), undefined)
  assert.equal(hillOwner(run(undefined, alone, 30 * GAME_TPS, 1, slow), 30 * GAME_TPS), 2)
})

test('a hill held after the time it was given scores, and draining takes as long as filling did', () => {
  // The bar is full after two of the intervals a point is scored at, so it is held on a tick that a point is scored on.
  const held = 2 * GAME_HILL_POINT_TICKS
  const quick: ModeSetup = { kind: 'koth', hill: HILL, captureTicks: held }
  const state = run(undefined, crowd([1, 1]), held, 1, quick)
  assert.deepEqual(state.scores, { 1: 1 }, 'the tick it is held on is one a point is scored on')
  const drained = run(state, crowd([2, 1]), held, held + 1, quick)
  assert.deepEqual([drained.capturer, drained.progress], [undefined, 0])
})

test('the capture time is a rule of the lobby, in whole seconds, and only a game on the hill is given it', () => {
  assert.equal(defaultRules().captureSeconds, GAME_HILL_CAPTURE_TICKS / GAME_TPS)
  assert.ok(CAPTURE_SECONDS.default >= CAPTURE_SECONDS.min && CAPTURE_SECONDS.default <= CAPTURE_SECONDS.max, 'a default the leader could have set')
  const kothLimit = (GAME_MODES.find((mode) => mode.id === 'koth') as (typeof GAME_MODES)[number]).defaultLimit
  const rules = applyRulesChange(defaultRules(), { captureSeconds: 2 })
  assert.equal(rules.captureSeconds, 2)
  assert.deepEqual(modeRules(rules, 'koth'), { respawnTicks: GAME_RESPAWN_TICKS, scoreLimit: kothLimit, captureTicks: 2 * GAME_TPS })
  assert.equal('captureTicks' in modeRules(rules, 'ctf'), false)
  assert.equal('captureTicks' in modeRules(rules, 'deathmatch'), false)
  const setup = createModeSetup('koth', [1, 2], { hill: HILL, flags: [] }, modeRules(rules, 'koth'))
  assert.deepEqual(setup, { kind: 'koth', hill: HILL, captureTicks: 2 * GAME_TPS, respawnTicks: GAME_RESPAWN_TICKS, scoreLimit: kothLimit })

  assert.deepEqual(readRulesChange({ captureSeconds: 2 }), { change: { captureSeconds: 2 } })
  for (const bad of [CAPTURE_SECONDS.min - 1, CAPTURE_SECONDS.max + 1, 1.5, '10', null]) {
    const read = readRulesChange({ captureSeconds: bad })
    assert.ok('problem' in read && new RegExp(`Capture time must be a whole number of seconds from ${CAPTURE_SECONDS.min} to ${CAPTURE_SECONDS.max}`).test(read.problem), String(bad))
  }
})

test('in the simulator the time to capture comes with the game, so every peer fills the bar at the same pace', () => {
  const build = (captureTicks: number | undefined): Simulator => {
    const simulator = new Simulator(Terrain.plain(), { kind: 'koth', hill: HILL, ...(captureTicks ? { captureTicks } : {}) })
    simulator.addPlayer(1, 'a', 'A', ON, brawler, 1)
    simulator.addPlayer(2, 'b', 'B', OFF, brawler, 2)
    return simulator
  }
  const quick = build(90)
  quick.advanceTo(90)
  const state = quick.at(90).getObjective() as Koth
  assert.deepEqual([state.capturer, state.progress, state.scores], [1, 90, {}], 'full at tick 90, which is not yet a point')
  assert.equal(hillOwner(state, 90), 1)

  quick.setCommitTick(quick.tick - 12)
  const parsed = JSON.parse(JSON.stringify(quick.snapshot())) as { mode?: { captureTicks?: number } }
  assert.equal(parsed.mode?.captureTicks, 90)
  const restored = new Simulator()
  restored.replaceFromSnapshot(quick.snapshot())
  assert.equal(restored.mode.kind === 'koth' && restored.mode.captureTicks, 90)
})
