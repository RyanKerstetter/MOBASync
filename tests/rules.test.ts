import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceObjective,
  applyRulesChange,
  CAPTURE_SECONDS,
  Champion,
  createModeSetup,
  defaultRules,
  GAME_MODES,
  GAME_RESPAWN_TICKS,
  GAME_TPS,
  GameSnapshotSchema,
  initialObjective,
  leadingTeam,
  modeRules,
  NO_OBJECTIVES,
  readRulesChange,
  RESPAWN_SECONDS,
  Simulator,
  Terrain,
  winningTeam,
  type GameMode,
  type HillArea,
  type ModeSetup,
  type ObjectiveState,
} from '../packages/shared/src/index.ts'
import { brawler } from './fixtures.ts'

// What the lobby leader sets besides the mode: how long a champion stays dead, and the score each mode is won
// at. The game ends when a team reaches the limit and is ahead.

const killer = new Champion({ ...brawler, abilities: [...brawler.abilities], base: { ...brawler.base, attackDamage: 5000 } })
const move = (id: string, seq: number, tick: number, x: number, y: number) =>
  ({ id, seq, tick, type: 'move' as const, target: { x, y } })

// Runs the game a tick at a time, as the server does, up to `last`, and gives the objective after each tick it ran.
function playOut(simulator: Simulator, last: number): Array<ObjectiveState | undefined> {
  const states: Array<ObjectiveState | undefined> = []
  for (let tick = simulator.tick + 1; tick <= last; tick += 1) {
    simulator.advanceTo(tick)
    states.push(simulator.at(tick).getObjective())
  }
  return states
}

type Dm = Extract<ObjectiveState, { kind: 'deathmatch' }>
const deathmatch: ModeSetup = { kind: 'deathmatch', scoreLimit: 3 }
// A mode as the game has it, for the limit it starts with and the most the leader can set it to.
const modeDef = (id: GameMode): (typeof GAME_MODES)[number] => GAME_MODES.find((each) => each.id === id) as (typeof GAME_MODES)[number]
const HILL_BOX: HillArea = { x: 0, y: 0, width: 10, height: 10, ellipse: false }

test('every mode names its score, and has a label, a default and a most for the limit the leader sets', () => {
  assert.deepEqual(GAME_MODES.map((mode) => [mode.id, mode.scoreName, mode.limitLabel]), [
    ['deathmatch', 'kills', 'Kills to win'],
    ['koth', 'points', 'Points to win'],
    ['ctf', 'captures', 'Captures to win'],
    ['core', 'cores', 'No limit'],
  ])
  // Core destruction ends when a team is out, so it has no limit to set (a most of 0); each of the others has one.
  for (const mode of GAME_MODES.filter((each) => each.id !== 'core')) assert.ok(mode.defaultLimit > 0 && mode.defaultLimit <= mode.maxLimit, mode.id)
  const core = GAME_MODES.find((mode) => mode.id === 'core')
  assert.deepEqual([core?.defaultLimit, core?.maxLimit], [0, 0])
})

test('the default rules are the old respawn time, and each mode\'s default limit', () => {
  const rules = defaultRules()
  assert.equal(rules.respawnSeconds, GAME_RESPAWN_TICKS / GAME_TPS)
  assert.deepEqual(rules.scoreLimits, Object.fromEntries(GAME_MODES.map((mode) => [mode.id, mode.defaultLimit])))
})

test('a change to the rules is read, and whatever is wrong with it is said', () => {
  assert.deepEqual(readRulesChange({ respawnSeconds: 10, scoreLimits: { ctf: 5, koth: 0 }, sessionId: 'x' }), {
    change: { respawnSeconds: 10, scoreLimits: { ctf: 5, koth: 0 } },
  })
  assert.deepEqual(readRulesChange({ sessionId: 'x' }), { change: {} })
  const problem = (raw: unknown): string => {
    const read = readRulesChange(raw)
    assert.ok('problem' in read, 'it was refused')
    return 'problem' in read ? read.problem : ''
  }
  for (const bad of [RESPAWN_SECONDS.min - 1, RESPAWN_SECONDS.max + 1, 2.5, '3', null, NaN]) {
    assert.match(problem({ respawnSeconds: bad }), new RegExp(`Respawn time must be a whole number of seconds from ${RESPAWN_SECONDS.min} to ${RESPAWN_SECONDS.max}`))
  }
  assert.match(problem({ scoreLimits: { ctf: modeDef('ctf').maxLimit + 1 } }), new RegExp(`Captures to win must be a whole number from 0 \\(no limit\\) to ${modeDef('ctf').maxLimit}`))
  assert.match(problem({ scoreLimits: { deathmatch: -1 } }), /Kills to win/)
  assert.match(problem({ scoreLimits: { deathmatch: 1.5 } }), /Kills to win/)
  assert.match(problem({ scoreLimits: { chess: 3 } }), /"chess" is not a game mode/)
  assert.match(problem({ scoreLimits: 'lots' }), /must say which mode/)
})

test('a change sets only what it names, and the limit of each mode is kept as it was left', () => {
  const rules = applyRulesChange(defaultRules(), { scoreLimits: { ctf: 7 } })
  assert.notEqual(modeDef('ctf').defaultLimit, 7, 'the limit it was changed to is not the one it had')
  assert.deepEqual(rules.scoreLimits, { ...defaultRules().scoreLimits, ctf: 7 })
  assert.equal(rules.respawnSeconds, RESPAWN_SECONDS.default)
  const next = applyRulesChange(rules, { respawnSeconds: 12 })
  assert.deepEqual([next.respawnSeconds, next.scoreLimits.ctf], [12, 7])
  assert.equal(defaultRules().scoreLimits.ctf, modeDef('ctf').defaultLimit, 'the defaults are not changed by it')
})

test('a game is given its mode\'s limit, with 0 meaning there is none, and the respawn time in ticks', () => {
  const rules = applyRulesChange(defaultRules(), { respawnSeconds: 8, scoreLimits: { koth: 0 } })
  assert.deepEqual(modeRules(rules, 'deathmatch'), { respawnTicks: 8 * GAME_TPS, scoreLimit: modeDef('deathmatch').defaultLimit })
  assert.deepEqual(modeRules(rules, 'koth'), { respawnTicks: 8 * GAME_TPS, captureTicks: CAPTURE_SECONDS.default * GAME_TPS })
  const flags = [{ x: 100, y: 100 }, { x: 900, y: 100 }]
  assert.deepEqual(createModeSetup('ctf', [1, 2], { flags }, modeRules(rules, 'ctf')), {
    kind: 'ctf',
    flags: [{ team: 1, home: flags[0] }, { team: 2, home: flags[1] }],
    respawnTicks: 8 * GAME_TPS,
    scoreLimit: modeDef('ctf').defaultLimit,
  })
  assert.deepEqual(createModeSetup('deathmatch', [1, 2], NO_OBJECTIVES), { kind: 'deathmatch' }, 'with no rules, none are set')
})

// ---------------------------------------------------------------------------- kills, and winning

test('a team scores for each kill its players make, and has no state until there is one', () => {
  assert.equal(initialObjective(deathmatch), undefined)
  assert.equal(advanceObjective(undefined, deathmatch, [], 1, []), undefined)
  const one = advanceObjective(undefined, deathmatch, [], 2, [2]) as Dm
  assert.deepEqual(one, { kind: 'deathmatch', scores: { 2: 1 } })
  assert.equal(advanceObjective(one, deathmatch, [], 3, []), one, 'nothing killed, nothing changes')
  assert.deepEqual(advanceObjective(one, deathmatch, [], 4, [2, 1, 2]), { kind: 'deathmatch', scores: { 1: 1, 2: 3 } })
  assert.deepEqual(one.scores, { 2: 1 }, 'and a step leaves the state it was given alone')
})

test('a team has won when it has reached the limit and is ahead, and a tie at the limit plays on', () => {
  const at = (scores: Record<string, number>, setup: ModeSetup = deathmatch) =>
    winningTeam(setup, { kind: 'deathmatch', scores })
  assert.equal(at({ 1: 2, 2: 1 }), undefined, 'ahead, but not at the limit')
  assert.equal(at({ 1: 3, 2: 1 }), 1)
  assert.equal(at({ 1: 4, 2: 3 }), 1, 'ahead when the other is at the limit too')
  assert.equal(at({ 1: 3, 2: 3 }), undefined, 'level at the limit: it goes on until one is ahead')
  assert.equal(at({ 1: 4, 2: 4, 3: 1 }), undefined)
  assert.equal(at({ 1: 5, 2: 4, 3: 4 }), 1)
  assert.equal(at({ 1: 9 }, { kind: 'deathmatch' }), undefined, 'with no limit no one wins')
  assert.equal(winningTeam(deathmatch, undefined), undefined, 'and with nothing scored')
  assert.equal(winningTeam({ kind: 'ctf', flags: [], scoreLimit: 2 }, { kind: 'ctf', flags: [], scores: { 2: 2 } }), 2)
  assert.equal(winningTeam({ kind: 'koth', hill: HILL_BOX, scoreLimit: 10 }, { kind: 'koth', progress: 0, scores: { 1: 10 } }), 1)
})

test('the team that is ahead is the one with more than every other, and a team that has not scored is not ahead', () => {
  assert.equal(leadingTeam({ 1: 4, 2: 1 }), 1)
  assert.equal(leadingTeam({ 1: 2, 2: 2 }), undefined)
  assert.equal(leadingTeam({ 1: 0 }), undefined)
  assert.equal(leadingTeam({}), undefined)
})

test('in the simulator a kill scores for the killer\'s team, and stays when the killer has gone', () => {
  const simulator = new Simulator(Terrain.plain(), { kind: 'deathmatch', scoreLimit: 5 })
  simulator.addPlayer(1, 'a', 'A', { x: 300, y: 300 }, brawler, 1)
  simulator.addPlayer(2, 'b', 'B', { x: 360, y: 300 }, killer, 2)
  simulator.addOrder(2, { id: '2:1', seq: 1, tick: 5, type: 'attack', targetId: 1 })

  const states = playOut(simulator, 8)
  assert.equal(states[3], undefined, 'nothing is scored before the kill')
  assert.deepEqual(states[4], { kind: 'deathmatch', scores: { 2: 1 } }, 'it scores on the tick of the kill, not once it is committed')
  assert.deepEqual(states[7], { kind: 'deathmatch', scores: { 2: 1 } })

  // The killer leaves: the character, and its kills, are gone, and the team's score is not.
  simulator.remove(2)
  const after = playOut(simulator, 20)
  assert.deepEqual(after.at(-1), { kind: 'deathmatch', scores: { 2: 1 } })
})

test('an order taken back after the kill it made takes the point back, like everything else in a frame', () => {
  const build = (attack: boolean): Simulator => {
    const simulator = new Simulator(Terrain.plain(), { kind: 'deathmatch' })
    simulator.addPlayer(1, 'a', 'A', { x: 300, y: 300 }, brawler, 1)
    simulator.addPlayer(2, 'b', 'B', { x: 360, y: 300 }, killer, 2)
    if (attack) simulator.addOrder(2, { id: '2:1', seq: 1, tick: 10, type: 'attack', targetId: 1 })
    return simulator
  }
  // The server turns the attack down, which the client finds out after it has played the kill.
  const refused = build(true)
  const neverGiven = build(false)

  playOut(refused, 14)
  assert.deepEqual(refused.at(14).getObjective(), { kind: 'deathmatch', scores: { 2: 1 } }, 'killed, as far as it knows')
  assert.equal(refused.removeOrder(2, 1), true)
  playOut(neverGiven, 14)
  assert.equal(refused.at(14).getObjective(), undefined, 'the point went with it')
  assert.deepEqual(refused.at(14).getObjective(), neverGiven.at(14).getObjective())
  assert.equal(refused.at(14).get(1)?.isDead(), false)
})

// ---------------------------------------------------------------------------- the respawn time

test('a champion comes back after the respawn time the game was given, and the default if it was given none', () => {
  const backAfter = (setup: ModeSetup | undefined): number => {
    const simulator = setup ? new Simulator(Terrain.plain(), setup) : new Simulator()
    simulator.addPlayer(1, 'a', 'A', { x: 300, y: 300 }, brawler, 1)
    simulator.addPlayer(2, 'b', 'B', { x: 360, y: 300 }, killer, 2)
    simulator.addOrder(2, { id: '2:1', seq: 1, tick: 5, type: 'attack', targetId: 1 })
    let backAt = -1
    for (let tick = 1; tick <= 500 && backAt < 0; tick += 1) {
      simulator.advanceTo(tick)
      const state = simulator.at(tick).get(1)
      if (tick > 5 && state && !state.isDead()) backAt = tick
    }
    return backAt - 5
  }
  assert.equal(backAfter(undefined), GAME_RESPAWN_TICKS)
  assert.equal(backAfter({ kind: 'deathmatch', respawnTicks: 90 }), 90)
  assert.equal(backAfter({ kind: 'deathmatch', respawnTicks: 6 * GAME_TPS }), 360)
})

test('the rules travel with the snapshot, so a client that restores it respawns champions on the server\'s clock', () => {
  const setup: ModeSetup = { kind: 'deathmatch', respawnTicks: 100, scoreLimit: 7 }
  const simulator = new Simulator(Terrain.plain(), setup)
  simulator.addPlayer(1, 'a', 'A', { x: 300, y: 300 }, brawler, 1)
  simulator.advanceTo(5)
  const parsed = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(simulator.snapshot())))
  assert.deepEqual(parsed.mode, setup, 'a deathmatch with rules is not left out')
  const restored = new Simulator()
  restored.replaceFromSnapshot(parsed)
  assert.deepEqual(restored.mode, setup)
  assert.equal(restored.respawnTicks, 100)
  assert.equal(new Simulator().respawnTicks, GAME_RESPAWN_TICKS)
})
