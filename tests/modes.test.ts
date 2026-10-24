import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceObjective,
  Champion,
  createModeSetup,
  GAME_FLAG_RADIUS,
  GAME_HILL_CAPTURE_TICKS,
  GAME_HILL_POINT_TICKS,
  GAME_MODES,
  GameSnapshotSchema,
  hillContains,
  hillLeader,
  hillOwner,
  hillPresence,
  initialObjective,
  isGameMode,
  modeStartProblem,
  NO_OBJECTIVES,
  Simulator,
  teamCountProblem,
  Terrain,
  type HillArea,
  type ModeSetup,
  type ObjectiveState,
  type ObjectiveUnit,
} from '../packages/shared/src/index.ts'
import { brawler } from './fixtures.ts'

const RADIUS = 18

const unit = (id: number, team: number, x: number, y: number, alive = true): ObjectiveUnit =>
  ({ id, team, position: { x, y }, radius: RADIUS, alive })

type Koth = Extract<ObjectiveState, { kind: 'koth' }>
type Ctf = Extract<ObjectiveState, { kind: 'ctf' }>

// ---------------------------------------------------------------------------- choosing a mode

test('the modes a lobby can pick are team deathmatch, king of the hill and capture the flag', () => {
  assert.deepEqual(GAME_MODES.map((mode) => mode.id), ['deathmatch', 'koth', 'ctf'])
  assert.deepEqual(GAME_MODES.map((mode) => mode.name), ['Team Deathmatch', 'King of the Hill', 'Capture the Flag'])
  assert.equal(isGameMode('koth'), true)
  assert.equal(isGameMode('battle-royale'), false)
  assert.equal(isGameMode(undefined), false)
})

test('capture the flag needs exactly two teams, and the other modes do not mind how many', () => {
  assert.equal(teamCountProblem('ctf', 2), undefined)
  assert.match(teamCountProblem('ctf', 3) ?? '', /exactly 2 teams, and there are 3/)
  assert.match(teamCountProblem('ctf', 1) ?? '', /exactly 2 teams, and there is 1/)
  for (const count of [1, 2, 3, 8]) {
    assert.equal(teamCountProblem('deathmatch', count), undefined)
    assert.equal(teamCountProblem('koth', count), undefined)
  }
})

test('a mode needs what it plays with in the map, and says what is missing', () => {
  const hill: HillArea = { x: 0, y: 0, width: 100, height: 100, ellipse: true }
  const flags = [{ x: 100, y: 100 }, { x: 900, y: 100 }]
  assert.equal(modeStartProblem('deathmatch', [1, 2, 3], NO_OBJECTIVES), undefined)
  assert.match(modeStartProblem('koth', [1, 2], NO_OBJECTIVES) ?? '', /no hill/)
  assert.equal(modeStartProblem('koth', [1, 2, 3], { hill, flags: [] }), undefined)
  assert.match(modeStartProblem('ctf', [1, 2], NO_OBJECTIVES) ?? '', /no flag for each of the first two teams/)
  assert.match(modeStartProblem('ctf', [1, 2], { flags: [flags[0]] }) ?? '', /no flag/)
  assert.match(modeStartProblem('ctf', [1, 2, 3], { flags }) ?? '', /exactly 2 teams/)
  assert.equal(modeStartProblem('ctf', [4, 4, 7], { flags }), undefined)
})

test('a flag belongs to the team that starts at its slot: the biggest team has the first, and a tie goes to the lower number', () => {
  const flags = [{ x: 100, y: 100 }, { x: 900, y: 100 }]
  // Team 5 has two players and team 3 one, so team 5 starts at slot 1.
  assert.deepEqual(createModeSetup('ctf', [3, 5, 5], { flags }), {
    kind: 'ctf',
    flags: [{ team: 5, home: { x: 100, y: 100 } }, { team: 3, home: { x: 900, y: 100 } }],
  })
  assert.deepEqual((createModeSetup('ctf', [2, 1], { flags }) as Extract<ModeSetup, { kind: 'ctf' }>).flags.map((flag) => flag.team), [1, 2])
  assert.deepEqual(createModeSetup('deathmatch', [1, 2, 3], NO_OBJECTIVES), { kind: 'deathmatch' })
  assert.throws(() => createModeSetup('ctf', [1, 2, 3], { flags }), /exactly 2 teams/)
})

// ---------------------------------------------------------------------------- the hill

const ELLIPSE: HillArea = { x: 500, y: 300, width: 400, height: 200, ellipse: true }
const BOX: HillArea = { ...ELLIPSE, ellipse: false }
const koth: ModeSetup = { kind: 'koth', hill: ELLIPSE }

test('a champion is on an elliptical hill when its middle is in the ellipse, and on a square one when it is in the box', () => {
  assert.equal(hillContains(ELLIPSE, { x: 700, y: 400 }), true, 'the middle')
  assert.equal(hillContains(ELLIPSE, { x: 899, y: 400 }), true, 'near the end of the long side')
  assert.equal(hillContains(ELLIPSE, { x: 520, y: 310 }), false, 'the corner of the box is outside the ellipse')
  assert.equal(hillContains(BOX, { x: 520, y: 310 }), true, 'but inside the box')
  assert.equal(hillContains(BOX, { x: 901, y: 400 }), false)
  assert.equal(hillContains(BOX, { x: 700, y: 299 }), false)
})

test('only the living on the hill are counted, and the leader is the team with more than every other', () => {
  const units = [unit(1, 1, 700, 400), unit(2, 1, 650, 380), unit(3, 2, 750, 400), unit(4, 2, 100, 100), unit(5, 3, 700, 420, false)]
  const presence = hillPresence(ELLIPSE, units)
  assert.deepEqual([...presence].sort(), [[1, 2], [2, 1]])
  assert.equal(hillLeader(presence), 1)
  assert.equal(hillLeader(hillPresence(ELLIPSE, units.slice(1))), undefined, 'one each is a tie')
  assert.equal(hillLeader(hillPresence(ELLIPSE, [unit(1, 1, 0, 0)])), undefined, 'no one is on it')
  assert.equal(hillLeader(new Map([[1, 3], [2, 3], [3, 1]])), undefined, 'a tie for the most, with a smaller team behind')
  assert.equal(hillLeader(new Map([[1, 2], [2, 2], [3, 3]])), 3)
})

// Steps the hill through `ticks` ticks with the same units on it, from `state`, as the simulator does.
function stepHill(state: Koth | undefined, units: readonly ObjectiveUnit[], ticks: number, from = 1): Koth {
  let current = state ?? initialObjective(koth)
  for (let tick = from; tick < from + ticks; tick += 1) current = advanceObjective(current, koth, units, tick)
  return current as Koth
}

test('a team alone on the hill fills its bar by a tick every tick, and has it when the bar is full', () => {
  const alone = [unit(1, 2, 700, 400)]
  const part = stepHill(undefined, alone, 100)
  assert.deepEqual([part.capturer, part.progress, hillOwner(part)], [2, 100, undefined])
  const full = stepHill(undefined, alone, GAME_HILL_CAPTURE_TICKS)
  assert.deepEqual([full.capturer, full.progress, hillOwner(full)], [2, GAME_HILL_CAPTURE_TICKS, 2])
  // The bar stops at full.
  assert.equal(stepHill(full, alone, 50, GAME_HILL_CAPTURE_TICKS + 1).progress, GAME_HILL_CAPTURE_TICKS)
})

test('having more players on the hill than the other team is all that counts, and not how many more', () => {
  const crowd = [unit(1, 1, 700, 400), unit(2, 1, 710, 400), unit(3, 1, 720, 400), unit(4, 2, 690, 400)]
  const alone = [unit(1, 1, 700, 400), unit(2, 2, 2000, 1000)]
  assert.equal(stepHill(undefined, crowd, 60).progress, 60)
  assert.equal(stepHill(undefined, alone, 60).progress, 60)
})

test('an equal number of each team, or no one, leaves the bar as it is', () => {
  const started = stepHill(undefined, [unit(1, 1, 700, 400)], 200)
  const tied = stepHill(started, [unit(1, 1, 700, 400), unit(2, 2, 720, 400)], 100, 201)
  assert.deepEqual([tied.capturer, tied.progress], [1, 200])
  const empty = stepHill(started, [unit(1, 1, 0, 0)], 100, 201)
  assert.deepEqual([empty.capturer, empty.progress], [1, 200])
  // The dead do not count for either side.
  const ghosts = stepHill(started, [unit(1, 1, 700, 400, false), unit(2, 2, 720, 400, false)], 100, 201)
  assert.equal(ghosts.progress, 200)
})

test('a team with more players than the one whose bar it is takes the bar down, and then fills it for itself', () => {
  const held = stepHill(undefined, [unit(1, 1, 700, 400)], GAME_HILL_CAPTURE_TICKS)
  assert.equal(hillOwner(held), 1)
  const enemy = [unit(2, 2, 700, 400), unit(3, 2, 710, 400), unit(1, 1, 690, 400)]

  const draining = stepHill(held, enemy, 100, GAME_HILL_CAPTURE_TICKS + 1)
  assert.deepEqual([draining.capturer, draining.progress, hillOwner(draining)], [1, GAME_HILL_CAPTURE_TICKS - 100, undefined])

  const empty = stepHill(held, enemy, GAME_HILL_CAPTURE_TICKS, GAME_HILL_CAPTURE_TICKS + 1)
  assert.deepEqual([empty.capturer, empty.progress], [undefined, 0], 'an empty bar is no one\'s')

  const taken = stepHill(held, enemy, GAME_HILL_CAPTURE_TICKS * 2, GAME_HILL_CAPTURE_TICKS + 1)
  assert.deepEqual([taken.capturer, taken.progress, hillOwner(taken)], [2, GAME_HILL_CAPTURE_TICKS, 2])
})

test('a held hill scores a point a second for its team, and a hill that is not held scores nothing', () => {
  const alone = [unit(1, 1, 700, 400)]
  // Ticks 1 to GAME_HILL_CAPTURE_TICKS fill the bar, so it is held from the last of them.
  const held = stepHill(undefined, alone, GAME_HILL_CAPTURE_TICKS)
  assert.deepEqual(held.scores, { 1: 1 }, 'the tick it fills is a whole second, and scores')
  const later = stepHill(held, alone, GAME_HILL_POINT_TICKS * 3, GAME_HILL_CAPTURE_TICKS + 1)
  assert.deepEqual(later.scores, { 1: 4 })
  // Draining it by one stops the points even though the team still has most of the bar.
  const drained = stepHill(held, [unit(2, 2, 700, 400)], GAME_HILL_POINT_TICKS * 3, GAME_HILL_CAPTURE_TICKS + 1)
  assert.deepEqual(drained.scores, { 1: 1 })
  // And a tie keeps it held and scoring.
  const tied = stepHill(held, [unit(1, 1, 700, 400), unit(2, 2, 700, 400)], GAME_HILL_POINT_TICKS * 3, GAME_HILL_CAPTURE_TICKS + 1)
  assert.deepEqual(tied.scores, { 1: 4 })
  assert.deepEqual(stepHill(undefined, alone, GAME_HILL_CAPTURE_TICKS - 1).scores, {})
})

test('a step makes a new state and leaves the one it was given alone', () => {
  const before = initialObjective(koth) as Koth
  const copy = structuredClone(before)
  advanceObjective(before, koth, [unit(1, 1, 700, 400)], GAME_HILL_POINT_TICKS)
  assert.deepEqual(before, copy)
})

// ---------------------------------------------------------------------------- the flags

const HOME_1 = { x: 200, y: 300 }
const HOME_2 = { x: 1800, y: 300 }
const ctf: ModeSetup = { kind: 'ctf', flags: [{ team: 1, home: HOME_1 }, { team: 2, home: HOME_2 }] }

function flagsAfter(state: ObjectiveState | undefined, units: readonly ObjectiveUnit[], tick = 1): Ctf {
  return advanceObjective(state ?? initialObjective(ctf), ctf, units, tick) as Ctf
}
const flagOf = (state: Ctf, team: number) => state.flags.find((flag) => flag.team === team) as Ctf['flags'][number]
const touchingReach = GAME_FLAG_RADIUS + RADIUS

test('both flags start at their bases, and nothing happens while no enemy is at one', () => {
  const state = initialObjective(ctf) as Ctf
  assert.deepEqual(state.flags, [{ team: 1, position: HOME_1 }, { team: 2, position: HOME_2 }])
  const next = flagsAfter(state, [unit(1, 1, HOME_1.x + 5, HOME_1.y), unit(2, 2, 1000, 1000)])
  assert.deepEqual(next, state, 'a team at its own flag leaves it be')
})

test('an enemy walking up to a flag picks it up, and it goes with them', () => {
  const near = flagsAfter(undefined, [unit(7, 1, HOME_2.x - touchingReach, HOME_2.y)])
  assert.equal(flagOf(near, 2).carrierId, 7)
  assert.deepEqual(flagOf(near, 2).position, { x: HOME_2.x - touchingReach, y: HOME_2.y })
  assert.equal(flagOf(near, 1).carrierId, undefined)

  const far = flagsAfter(undefined, [unit(7, 1, HOME_2.x - touchingReach - 1, HOME_2.y)])
  assert.equal(flagOf(far, 2).carrierId, undefined, 'just out of reach')

  // It goes where the carrier goes.
  const moved = flagsAfter(near, [unit(7, 1, 1500, 700)], 2)
  assert.deepEqual(flagOf(moved, 2).position, { x: 1500, y: 700 })
  assert.equal(flagOf(moved, 2).carrierId, 7)
})

test('the dead pick up nothing, and of two enemies reaching a flag together the lower ID gets it', () => {
  assert.equal(flagOf(flagsAfter(undefined, [unit(7, 1, HOME_2.x, HOME_2.y, false)]), 2).carrierId, undefined)
  const both = flagsAfter(undefined, [unit(9, 1, HOME_2.x, HOME_2.y), unit(4, 1, HOME_2.x + 10, HOME_2.y)])
  assert.equal(flagOf(both, 2).carrierId, 4)
})

test('a carrier that dies drops the flag where it died, and it stays there', () => {
  const carried = flagsAfter(undefined, [unit(7, 1, HOME_2.x - 30, HOME_2.y)])
  const dropped = flagsAfter(carried, [unit(7, 1, 1500, 700, false)], 2)
  assert.deepEqual(flagOf(dropped, 2), { team: 2, position: { x: 1500, y: 700 } })
  // Ticks later, with no one near, it is where it fell.
  assert.deepEqual(flagOf(flagsAfter(dropped, [unit(7, 1, 1500, 700, false)], 300), 2).position, { x: 1500, y: 700 })
  // A carrier that left the game drops it where it last was.
  const left = flagsAfter(carried, [], 2)
  assert.deepEqual(flagOf(left, 2), { team: 2, position: { x: HOME_2.x - 30, y: HOME_2.y } })
})

test('a dropped flag goes home when a living champion of its own team touches it, and not for anyone else', () => {
  const carried = flagsAfter(undefined, [unit(7, 1, HOME_2.x - 30, HOME_2.y)])
  const dropped = flagsAfter(carried, [unit(7, 1, 1500, 700, false)], 2)

  // A teammate of the one who dropped it, even a living one, does not return it; it picks it up.
  const taken = flagsAfter(dropped, [unit(8, 1, 1500, 700 + touchingReach)], 3)
  assert.equal(flagOf(taken, 2).carrierId, 8)
  // A dead champion of its team does not return it.
  assert.equal(flagOf(flagsAfter(dropped, [unit(3, 2, 1500, 700, false)], 3), 2).position.x, 1500)
  // A living one does, from anywhere in reach, and it is at home again.
  const returned = flagsAfter(dropped, [unit(3, 2, 1500 - touchingReach, 700)], 3)
  assert.deepEqual(flagOf(returned, 2), { team: 2, position: HOME_2 })
  // Out of reach does not.
  assert.deepEqual(flagOf(flagsAfter(dropped, [unit(3, 2, 1500 - touchingReach - 1, 700)], 3), 2).position, { x: 1500, y: 700 })
  // When both teams reach it on the same tick, its own team's return comes first.
  const both = flagsAfter(dropped, [unit(3, 2, 1500, 710), unit(8, 1, 1500, 690)], 3)
  assert.deepEqual(flagOf(both, 2), { team: 2, position: HOME_2 })
})

test('a team scores by carrying the enemy flag to its own base, when its own flag is there', () => {
  const carried = flagsAfter(undefined, [unit(7, 1, HOME_2.x - 30, HOME_2.y)])
  const arrived = flagsAfter(carried, [unit(7, 1, HOME_1.x + touchingReach, HOME_1.y)], 2)
  assert.deepEqual(arrived.scores, { 1: 1 })
  assert.deepEqual(flagOf(arrived, 2), { team: 2, position: HOME_2 }, 'the flag it carried goes back to its base')
  assert.equal(flagOf(arrived, 1).carrierId, undefined)

  // Not before it gets there.
  assert.deepEqual(flagsAfter(carried, [unit(7, 1, HOME_1.x + touchingReach + 1, HOME_1.y)], 2).scores, {})
  // And a carrier at the other team's base scores nothing.
  assert.deepEqual(flagsAfter(carried, [unit(7, 1, HOME_2.x, HOME_2.y)], 2).scores, {})
})

test('a flag that is out does not let its team score until it is back', () => {
  // Team 1 has team 2's flag; team 2 has team 1's flag.
  let state: Ctf = flagsAfter(undefined, [unit(7, 1, HOME_2.x, HOME_2.y), unit(8, 2, HOME_1.x, HOME_1.y)])
  assert.deepEqual([flagOf(state, 1).carrierId, flagOf(state, 2).carrierId], [8, 7])

  // 7 reaches its base, but team 1's own flag is out with 8, so nothing is turned in and it keeps carrying.
  state = flagsAfter(state, [unit(7, 1, HOME_1.x, HOME_1.y), unit(8, 2, 1000, 600)], 2)
  assert.deepEqual(state.scores, {})
  assert.equal(flagOf(state, 2).carrierId, 7)

  // 8 is killed, so team 1's flag is dropped where it fell, and it stays out until a champion of team 1
  // walks over it. 7 is on team 1 but standing at its base, far from it: still nothing.
  state = flagsAfter(state, [unit(7, 1, HOME_1.x, HOME_1.y), unit(8, 2, 1000, 600, false)], 3)
  assert.deepEqual(state.scores, {})
  assert.deepEqual(flagOf(state, 1).position, { x: 1000, y: 600 })
  assert.equal(flagOf(state, 2).carrierId, 7)

  // 7 walks to its dropped flag, which returns it, and then home with the other: now it scores.
  state = flagsAfter(state, [unit(7, 1, 1000, 600), unit(8, 2, 1000, 600, false)], 4)
  assert.deepEqual(flagOf(state, 1), { team: 1, position: HOME_1 })
  assert.deepEqual(state.scores, {}, 'returning it is not scoring')
  state = flagsAfter(state, [unit(7, 1, HOME_1.x, HOME_1.y)], 5)
  assert.deepEqual(state.scores, { 1: 1 })
})

test('a carrier cannot take a second flag, and a state of the other mode starts over', () => {
  // Capture the flag is only played with two teams, but two flags in reach of one champion is still one flag.
  const crowded: ModeSetup = { kind: 'ctf', flags: [{ team: 1, home: HOME_1 }, { team: 2, home: { x: 1000, y: 900 } }, { team: 3, home: { x: 1000, y: 900 } }] }
  const state = advanceObjective(undefined, crowded, [unit(7, 1, 1000, 900)], 1) as Ctf
  assert.deepEqual([flagOf(state, 2).carrierId, flagOf(state, 3).carrierId], [7, undefined])
  // A koth state handed to a capture the flag game is not used.
  assert.deepEqual(advanceObjective({ kind: 'koth', progress: 5, scores: {} }, ctf, [], 1), initialObjective(ctf))
  assert.equal(advanceObjective(undefined, { kind: 'deathmatch' }, [unit(1, 1, 0, 0)], 1), undefined)
})

// ---------------------------------------------------------------------------- in the simulator

const killer = new Champion({ ...brawler, abilities: [...brawler.abilities], attackDamage: 5000 })
const move = (id: string, seq: number, tick: number, x: number, y: number) =>
  ({ id, seq, tick, type: 'move' as const, target: { x, y } })

// Runs the game a tick at a time, as the server does, up to `last`, and gives the objective after each
// tick it ran, from the one after where the game was.
function playOut(simulator: Simulator, last: number): Array<ObjectiveState | undefined> {
  const states: Array<ObjectiveState | undefined> = []
  for (let tick = simulator.tick + 1; tick <= last; tick += 1) {
    simulator.advanceTo(tick)
    states.push(simulator.at(tick).getObjective())
  }
  return states
}

test('a game of team deathmatch has no objective', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'a', 'A', { x: 300, y: 300 }, brawler, 1)
  simulator.advanceTo(5)
  assert.equal(simulator.at(5).getObjective(), undefined)
  assert.equal(simulator.snapshot().mode, undefined, 'and its snapshot says nothing of a mode')
})

test('a team standing on the hill captures it and then scores, in the simulator that plays the game', () => {
  const simulator = new Simulator(Terrain.plain(), koth)
  simulator.addPlayer(1, 'a', 'A', { x: 700, y: 400 }, brawler, 1)
  simulator.addPlayer(2, 'b', 'B', { x: 2000, y: 1000 }, brawler, 2)
  const states = playOut(simulator, GAME_HILL_CAPTURE_TICKS + GAME_HILL_POINT_TICKS * 2)
  assert.deepEqual(states[0], { kind: 'koth', capturer: 1, progress: 1, scores: {} })
  const filled = states[GAME_HILL_CAPTURE_TICKS - 1] as Koth
  assert.deepEqual([filled.capturer, filled.progress, hillOwner(filled), filled.scores], [1, GAME_HILL_CAPTURE_TICKS, 1, { 1: 1 }])
  assert.deepEqual((states.at(-1) as Koth).scores, { 1: 3 })
})

test('a champion who dies on the hill stops counting for its team there', () => {
  const simulator = new Simulator(Terrain.plain(), koth)
  simulator.addPlayer(1, 'a', 'A', { x: 700, y: 400 }, brawler, 1)
  simulator.addPlayer(2, 'b', 'B', { x: 760, y: 400 }, killer, 2)
  // Both are on the hill, so it is tied and nothing fills until B kills A.
  simulator.addOrder(2, { id: '2:1', seq: 1, tick: 10, type: 'attack', targetId: 1 })
  const states = playOut(simulator, 30)
  assert.equal(simulator.at(30).get(1)?.isDead(), true)
  assert.equal((states[8] as Koth).progress, 0, 'tied before it')
  assert.deepEqual([(states[29] as Koth).capturer, (states[29] as Koth).progress > 0], [2, true])
})

test('a late order that moves a champion off the hill changes the hill from then on, as if it had always been there', () => {
  const orderedFromTheStart = new Simulator(Terrain.plain(), koth)
  const orderedLate = new Simulator(Terrain.plain(), koth)
  for (const simulator of [orderedFromTheStart, orderedLate]) {
    // A is just inside the east end of the hill, and B is off it.
    simulator.addPlayer(1, 'a', 'A', { x: 880, y: 400 }, brawler, 1)
    simulator.addPlayer(2, 'b', 'B', { x: 1000, y: 600 }, brawler, 2)
  }
  const leave = move('1:1', 1, 90, 1500, 400)
  orderedFromTheStart.addOrder(1, leave)

  playOut(orderedLate, 100)
  assert.equal(orderedLate.addOrder(1, leave), true, 'the order is still in time')
  playOut(orderedFromTheStart, 100)

  const rewritten = orderedLate.at(100).getObjective() as Koth
  assert.deepEqual(rewritten, orderedFromTheStart.at(100).getObjective())
  assert.equal(rewritten.progress < 100, true, 'the hill stopped filling when it walked off, not at the end')
})

test('a snapshot brings the mode and the objective, through JSON, to a simulator that did not play the game', () => {
  const simulator = new Simulator(Terrain.plain(), ctf)
  simulator.addPlayer(1, 'a', 'A', { x: HOME_2.x - 30, y: HOME_2.y }, brawler, 1)
  simulator.addPlayer(2, 'b', 'B', { x: HOME_1.x + 30, y: HOME_1.y }, brawler, 2)
  playOut(simulator, 20)
  simulator.setCommitTick(simulator.tick - 2)

  const snapshot = JSON.parse(JSON.stringify(simulator.snapshot())) as unknown
  const parsed = GameSnapshotSchema.safeParse(snapshot)
  assert.equal(parsed.success, true)
  if (!parsed.success) return
  assert.deepEqual(parsed.data.mode, ctf)

  const restored = new Simulator()
  restored.replaceFromSnapshot(parsed.data)
  assert.deepEqual(restored.mode, ctf)
  assert.deepEqual(restored.at(restored.tick).getObjective(), simulator.at(simulator.tick).getObjective())
  const flags = (restored.at(restored.tick).getObjective() as Ctf).flags
  assert.deepEqual(flags.map((flag) => flag.carrierId), [2, 1], 'each team\'s flag is with the other team\'s champion')
  // And it carries on the same.
  restored.advanceTo(restored.tick + 10)
  simulator.advanceTo(simulator.tick + 10)
  assert.deepEqual(restored.at(restored.tick).getObjective(), simulator.at(simulator.tick).getObjective())
})

test('a champion walks the enemy flag home across the map, and its team scores', () => {
  const simulator = new Simulator(Terrain.plain(), ctf)
  simulator.addPlayer(1, 'a', 'A', { x: 900, y: 300 }, brawler, 1)
  simulator.addPlayer(2, 'b', 'B', { x: 900, y: 1300 }, brawler, 2)
  // Out to the enemy flag, and back with it once it has been picked up.
  simulator.addOrder(1, move('1:1', 1, 1, HOME_2.x, HOME_2.y))
  simulator.addOrder(1, move('1:2', 2, 400, HOME_1.x, HOME_1.y))

  const states = playOut(simulator, 900) as Ctf[]
  const pickedUp = states.findIndex((state) => flagOf(state, 2).carrierId === 1)
  assert.ok(pickedUp > 0 && pickedUp < 399, `picked up on the way out (tick ${pickedUp + 1})`)
  const scoredAt = states.findIndex((state) => state.scores[1] === 1)
  assert.ok(scoredAt > 400, `scored on the way back (tick ${scoredAt + 1})`)
  const after = states[scoredAt]
  assert.deepEqual(flagOf(after, 2), { team: 2, position: HOME_2 }, 'and the flag is back at its base')
  assert.deepEqual(flagOf(after, 1), { team: 1, position: HOME_1 })
})

test('a carrier who is killed drops the flag, and the flag\'s own team walking over it sends it home', () => {
  const simulator = new Simulator(Terrain.plain(), ctf)
  // Team 1 starts on top of team 2's flag, and team 2's champion is in range of it, but not near the flag.
  simulator.addPlayer(1, 'a', 'A', { x: HOME_2.x - 20, y: HOME_2.y }, brawler, 1)
  simulator.addPlayer(2, 'b', 'B', { x: HOME_2.x + 80, y: HOME_2.y }, killer, 2)
  simulator.addOrder(2, { id: '2:1', seq: 1, tick: 5, type: 'attack', targetId: 1 })

  const states = playOut(simulator, 5) as Ctf[]
  assert.equal(flagOf(states[0], 2).carrierId, 1, 'carried from the first tick')
  assert.equal(simulator.at(5).get(1)?.isDead(), true, 'killed in one hit')
  const dropped = flagOf(states[4], 2)
  assert.equal(dropped.carrierId, undefined)
  assert.deepEqual(dropped.position, simulator.at(5).get(1)?.getPosition())
  assert.notDeepEqual(dropped.position, HOME_2, 'it is on the ground, not at home')

  // B is attacking, which keeps it where it is; walking over the flag is what returns it.
  simulator.addOrder(2, move('2:2', 2, 6, dropped.position.x, dropped.position.y))
  const after = playOut(simulator, 30) as Ctf[]
  const home = after.findIndex((state) => flagOf(state, 2).position.x === HOME_2.x && flagOf(state, 2).position.y === HOME_2.y)
  assert.ok(home >= 0, 'it went home')
  assert.equal(flagOf(after[home], 2).carrierId, undefined)
})
