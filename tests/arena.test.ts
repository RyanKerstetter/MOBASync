import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { arenaHint, modeTitle, roundLabel, type ModeView } from '../apps/client/src/ui/mode-hud.ts'
import {
  arenaMaxRounds,
  arenaResetTick,
  arenaRoundsToWin,
  createModeSetup,
  defaultRules,
  GAME_ARENA_ROUND_PAUSE_TICKS,
  GAME_MODES,
  GameSnapshotSchema,
  getGameMode,
  getTeam,
  limitRange,
  modeHasEconomy,
  modeRules,
  modeSupportProblem,
  NO_OBJECTIVES,
  rankTeams,
  readRulesChange,
  Simulator,
  teamCountProblem,
  Terrain,
  winningTeam,
  type GameTickSnapshot,
  type ModeSetup,
  type ObjectiveState,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineChampion, killAt } from './fixtures.ts'

// Arena: rounds, each won by the last team with a player alive, with nobody coming back until the round is over, and a game won by the first team to win the rounds
// the lobby set. The champion here is the test's own; the executioner (fixtures.ts) kills whoever a test says, when it says.

const fighter = defineChampion({
  id: 't-ar-fighter',
  name: 'Arena Fighter',
  base: { maxHp: 1000, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 100,
  attackWindup: 0,
  abilities: [],
})
const SPAWNS: readonly Vector2[] = [{ x: 300, y: 300 }, { x: 900, y: 300 }, { x: 600, y: 900 }, { x: 900, y: 900 }]
const ARENA = getGameMode('arena')

// A game of arena with a player for each team given, in that order (player 1 is on the first, and so on), each at a spawn of their own.
function arena(teams: readonly number[], roundsToWin = ARENA.defaultLimit): Simulator {
  const simulator = new Simulator(Terrain.plain(), createModeSetup('arena', teams, NO_OBJECTIVES, { scoreLimit: roundsToWin }))
  teams.forEach((team, index) => simulator.addPlayer(index + 1, `p${index + 1}`, `P${index + 1}`, SPAWNS[index], fighter, team))
  return simulator
}
const arenaOf = (frame: GameTickSnapshot): Extract<ObjectiveState, { kind: 'arena' }> => {
  const objective = frame.getObjective()
  assert.equal(objective?.kind, 'arena')
  return objective as Extract<ObjectiveState, { kind: 'arena' }>
}

// ---------------------------------------------------------------------------- the mode

test('arena is a mode of its own, played for rounds with no economy, and its limit is rounds to win, which cannot be none', () => {
  assert.ok(GAME_MODES.some((mode) => mode.id === 'arena'))
  assert.equal(ARENA.name, 'Arena')
  assert.equal(ARENA.scoreName, 'rounds')
  assert.equal(modeHasEconomy('arena'), false)
  const { min, max } = limitRange('arena')
  assert.ok(min >= 1, 'a game of it is always played to a number of rounds')
  assert.ok(ARENA.defaultLimit >= min && ARENA.defaultLimit <= max)
  assert.equal(defaultRules().scoreLimits.arena, ARENA.defaultLimit, 'a new lobby has the default')
  assert.ok('problem' in readRulesChange({ scoreLimits: { arena: 0 } }), 'none is refused')
  assert.ok('problem' in readRulesChange({ scoreLimits: { arena: max + 1 } }))
  for (const rounds of [min, max]) assert.deepEqual(readRulesChange({ scoreLimits: { arena: rounds } }), { change: { scoreLimits: { arena: rounds } } })
  // The other modes are as they were: 0 is no limit.
  assert.equal(limitRange('deathmatch').min, 0)
  assert.deepEqual(readRulesChange({ scoreLimits: { deathmatch: 0 } }), { change: { scoreLimits: { deathmatch: 0 } } })
})

test('arena takes two teams or more, as many as the map has room for, and needs nothing on the map', () => {
  assert.ok(teamCountProblem('arena', 1))
  for (const teams of [2, 3, 4, 8]) assert.equal(teamCountProblem('arena', teams), undefined, `${teams} teams`)
  assert.equal(modeSupportProblem('arena', { hill: false, flags: false, cores: false }), undefined)
})

test('a game of arena is played to the rounds the lobby set, the default with none, by the teams in it, the biggest first', () => {
  const teams = [3, 1, 1, 2, 3, 3]
  const rules = modeRules({ ...defaultRules(), scoreLimits: { ...defaultRules().scoreLimits, arena: ARENA.maxLimit } }, 'arena')
  const setup = createModeSetup('arena', teams, NO_OBJECTIVES, rules)
  assert.deepEqual(setup, { kind: 'arena', teams: rankTeams(teams), respawnTicks: rules.respawnTicks, scoreLimit: ARENA.maxLimit })
  const plain = createModeSetup('arena', teams, NO_OBJECTIVES)
  assert.equal(plain.kind === 'arena' && arenaRoundsToWin(plain), ARENA.defaultLimit)
  assert.equal(GameSnapshotSchema.safeParse(JSON.parse(JSON.stringify(arena([1, 2]).snapshot()))).success, true, 'and it goes in a snapshot')
})

// ---------------------------------------------------------------------------- how many rounds

test('a game of m teams to n rounds takes at most m(n - 1) + 1 rounds, which for two teams is 2n - 1', () => {
  // Worked out the long way: the most rounds that can be played, one winner at a time, before a team has n.
  const longest = (teams: number, toWin: number): number => {
    const memo = new Map<string, number>()
    const from = (wins: number[]): number => {
      if (wins.some((count) => count >= toWin)) return 0
      const key = [...wins].sort((left, right) => left - right).join(',')
      const known = memo.get(key)
      if (known !== undefined) return known
      const most = 1 + Math.max(...wins.map((_, team) => from(wins.map((count, other) => (other === team ? count + 1 : count)))))
      memo.set(key, most)
      return most
    }
    return from(new Array(teams).fill(0))
  }
  for (let teams = 2; teams <= 5; teams += 1) {
    for (let toWin = 1; toWin <= 5; toWin += 1) {
      assert.equal(arenaMaxRounds(teams, toWin), longest(teams, toWin), `${teams} teams, ${toWin} to win`)
    }
  }
  for (let toWin = 1; toWin <= 5; toWin += 1) assert.equal(arenaMaxRounds(2, toWin), 2 * toWin - 1, 'a best of 2n - 1')
  // m·n - 1 is the same only for two teams: three teams to two is four rounds at most, not five.
  assert.equal(arenaMaxRounds(3, 2), 4)
})

// ---------------------------------------------------------------------------- the rounds

test('a round is won by the last team with a player alive, nobody comes back during it, and the next begins with everyone back at their spawn', () => {
  const simulator = arena([1, 2, 3])
  const outFirst = 10
  // Long past the time a champion stays dead in any other mode.
  const outSecond = outFirst + simulator.respawnTicks + 10
  killAt(simulator, 3, outFirst)
  killAt(simulator, 2, outSecond)
  // Player 1 walks away from its spawn, so being put back there can be seen.
  simulator.addOrder(1, { id: 'w', seq: 1, tick: 1, type: 'move', target: { x: SPAWNS[0].x + 200, y: SPAWNS[0].y } })
  const next = outSecond + GAME_ARENA_ROUND_PAUSE_TICKS
  const seen: Record<string, unknown> = {}
  for (let tick = 1; tick <= next; tick += 1) {
    const frame = simulator.at(tick)
    const objective = arenaOf(frame)
    if (tick === outFirst) seen.afterFirst = { over: objective.over, rounds: objective.rounds, threeDead: frame.get(3)?.isDead() }
    if (tick === outFirst + simulator.respawnTicks + 1) seen.threeStillDead = frame.get(3)?.isDead()
    if (tick === outSecond) {
      seen.decided = { over: objective.over, rounds: objective.rounds, scores: objective.scores }
      seen.walked = frame.get(1)?.getPosition()
    }
    if (tick === next - 1) seen.waiting = { over: objective.over !== undefined, dead: [2, 3].map((id) => frame.get(id)?.isDead()) }
    if (tick === next) {
      seen.newRound = {
        over: objective.over,
        rounds: objective.rounds,
        alive: [1, 2, 3].map((id) => frame.get(id)?.isDead() === false),
        full: [1, 2, 3].map((id) => frame.get(id)?.getHealth() === frame.get(id)?.getHealthState()?.maxHp),
        home: [1, 2, 3].map((id) => frame.get(id)?.getPosition()),
      }
    }
  }
  assert.deepEqual(seen.afterFirst, { over: undefined, rounds: [], threeDead: true }, 'one team out, and two left: the round goes on')
  assert.equal(seen.threeStillDead, true, 'and the player out of it stays out')
  assert.deepEqual(seen.decided, { over: { tick: outSecond, winner: 1 }, rounds: [1], scores: { 1: 1 } }, 'the last team standing wins the round')
  assert.notDeepEqual(seen.walked, SPAWNS[0])
  assert.deepEqual(seen.waiting, { over: true, dead: [true, true] }, 'it waits, with nobody back yet')
  assert.deepEqual(seen.newRound, {
    over: undefined,
    rounds: [1],
    alive: [true, true, true],
    full: [true, true, true],
    home: [1, 2, 3].map((id) => simulator.characters.get(id)?.initialPosition),
  }, 'and then everyone is back, at full health, where they started')
})

test('a round in which the last players fall together has no winner, and is played again', () => {
  const simulator = arena([1, 2])
  const together = 10
  killAt(simulator, 1, together)
  killAt(simulator, 2, together)
  const next = together + GAME_ARENA_ROUND_PAUSE_TICKS
  let decided: unknown
  let again: unknown
  for (let tick = 1; tick <= next; tick += 1) {
    const frame = simulator.at(tick)
    if (tick === together) decided = arenaOf(frame)
    if (tick === next) again = { objective: arenaOf(frame), alive: [1, 2].map((id) => frame.get(id)?.isDead() === false) }
  }
  assert.deepEqual(decided, { kind: 'arena', rounds: [], scores: {}, over: { tick: together } })
  assert.deepEqual(again, { objective: { kind: 'arena', rounds: [], scores: {} }, alive: [true, true] })
})

test('the first team to win the rounds it needs wins the game, on the round that does it', () => {
  const toWin = 2
  const simulator = arena([1, 2], toWin)
  const first = 10
  const second = first + GAME_ARENA_ROUND_PAUSE_TICKS + 10
  killAt(simulator, 2, first)
  killAt(simulator, 2, second)
  const winners: Array<number | undefined> = []
  for (let tick = 1; tick <= second; tick += 1) winners[tick] = winningTeam(simulator.mode, simulator.at(tick).getObjective())
  assert.equal(winners[first], undefined, 'one round is not enough')
  assert.equal(winners[second - 1], undefined)
  assert.equal(winners[second], 1)
})

test('the next round begins a pause after the last was decided, and not while one is being fought', () => {
  assert.equal(arenaResetTick({ kind: 'arena', rounds: [], scores: {} }), undefined)
  assert.equal(arenaResetTick({ kind: 'arena', rounds: [2], scores: { 2: 1 }, over: { tick: 50, winner: 2 } }), 50 + GAME_ARENA_ROUND_PAUSE_TICKS)
  assert.equal(arenaResetTick({ kind: 'deathmatch', scores: {} }), undefined)
})

// ---------------------------------------------------------------------------- what the page shows

test('the page shows a box for every round the game can take, with the team that won each filled in, and the round being fought', () => {
  const toWin = 2
  const teams = [1, 2, 3]
  const state = new ClientGameState()
  const setup: ModeSetup = createModeSetup('arena', teams, NO_OBJECTIVES, { scoreLimit: toWin })
  state.simulator.reset(Terrain.plain(), setup)
  teams.forEach((team, index) => state.simulator.addPlayer(index + 1, `p${index + 1}`, `P${index + 1}`, SPAWNS[index], fighter, team))
  const won = 10
  killAt(state.simulator, 1, won)
  killAt(state.simulator, 3, won)
  state.simulator.advanceTo(won - 1)
  const before = state.getModeView(0)
  assert.equal(before.kind, 'arena')
  if (before.kind !== 'arena') return
  assert.equal(before.rounds.length, arenaMaxRounds(teams.length, toWin))
  assert.deepEqual(before.rounds, before.rounds.map(() => ({})), 'none won yet')
  assert.equal(before.current, 0)
  assert.equal(before.limit, toWin)
  assert.equal(before.over, undefined)

  state.simulator.advanceTo(won)
  const after = state.getModeView(0)
  assert.equal(after.kind, 'arena')
  if (after.kind !== 'arena') return
  assert.deepEqual(after.rounds[0], { winner: 2 }, 'the first box is the winner\'s')
  assert.deepEqual(after.rounds.slice(1), after.rounds.slice(1).map(() => ({})))
  assert.equal(after.current, 0, 'and it is still the round shown until the next begins')
  assert.equal(after.over?.winner, 2)
  assert.deepEqual(after.scores[0], { team: 2, score: 1 })
})

test('what the boxes and the line under them say', () => {
  assert.equal(roundLabel({ winner: 2 }, 0, 1), `Round 1: ${getTeam(2).name}`)
  assert.equal(roundLabel({}, 1, 1), 'Round 2: in play')
  assert.equal(roundLabel({}, 2, 1), 'Round 3')
  assert.equal(modeTitle({ kind: 'arena', limit: 3 }), `${ARENA.name} · first to 3 rounds`)

  const view = (over: { winner?: number; secondsLeft: number } | undefined, scores: Array<{ team: number; score: number }>): Extract<ModeView, { kind: 'arena' }> =>
    ({ kind: 'arena', scores, limit: 2, rounds: [{}, {}, {}], current: 0, ...(over ? { over } : {}) })
  assert.equal(arenaHint(view(undefined, [])), undefined, 'nothing while a round is fought')
  assert.equal(arenaHint(view({ winner: 1, secondsLeft: 2.2 }, [{ team: 1, score: 1 }])), `${getTeam(1).name} wins the round. Next round in 3s.`)
  assert.equal(arenaHint(view({ winner: 1, secondsLeft: 2.2 }, [{ team: 1, score: 2 }])), `${getTeam(1).name} wins the round.`, 'the round that wins the game has no next')
  assert.equal(arenaHint(view({ secondsLeft: 0.4 }, [])), 'No one is left. The round is played again in 1s.')
})
