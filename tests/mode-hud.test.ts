import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  flagHint,
  flagReadout,
  hillFraction,
  hillReadout,
  modeTitle,
  rankScores,
  type FlagView,
  type HillView,
} from '../apps/client/src/ui/mode-hud.ts'
import {
  Champion,
  GAME_HILL_CAPTURE_TICKS,
  GAME_TPS,
  Terrain,
  type HillArea,
  type ModeSetup,
} from '../packages/shared/src/index.ts'
import { brawler } from './fixtures.ts'

// Teams 1 and 2 are Red and Blue, and team 3 is Green.
const HILL: HillArea = { x: 500, y: 300, width: 400, height: 200, ellipse: true }

const hillView = (extra: Partial<HillView> = {}): HillView =>
  ({ hill: HILL, fraction: 0, contested: false, direction: 'none', ...extra })

test('teams are listed with the highest score first, and a tie by team number', () => {
  const scores: Record<number, number> = { 1: 2, 2: 5, 3: 2, 4: 0 }
  assert.deepEqual(rankScores([3, 1, 4, 2], (team) => scores[team]), [
    { team: 2, score: 5 },
    { team: 1, score: 2 },
    { team: 3, score: 2 },
    { team: 4, score: 0 },
  ])
  assert.deepEqual(rankScores([], () => 0), [])
})

test('the hill\'s bar is a share of the ticks a capture takes, and never outside the bar', () => {
  assert.equal(hillFraction(0), 0)
  assert.equal(hillFraction(60, 120), 0.5, 'a capture of two seconds fills twice as fast')
  assert.equal(hillFraction(GAME_HILL_CAPTURE_TICKS / 4), 0.25)
  assert.equal(hillFraction(GAME_HILL_CAPTURE_TICKS * 3), 1)
  assert.equal(hillFraction(-5), 0)
})

test('the hill says who holds it, who is taking it, and how far, in the colour of the team whose bar it is', () => {
  assert.deepEqual(hillReadout(hillView()), { fraction: 0, text: 'Nobody holds the hill' })
  assert.deepEqual(hillReadout(hillView({ leader: 2, direction: 'up' })), { fraction: 0, text: 'Blue capturing' })
  assert.deepEqual(hillReadout(hillView({ contested: true })), { fraction: 0, text: 'Contested' })

  const part = { capturer: 1, fraction: 0.456 }
  assert.deepEqual(hillReadout(hillView({ ...part, leader: 1, direction: 'up' })), { fraction: 0.456, team: 1, text: 'Red 45% · capturing' })
  assert.deepEqual(hillReadout(hillView({ ...part, leader: 2, direction: 'down' })), { fraction: 0.456, team: 1, text: 'Red 45% · Blue taking it' })
  assert.deepEqual(hillReadout(hillView({ ...part, contested: true, direction: 'down' })), { fraction: 0.456, team: 1, text: 'Red 45% · contested, draining' })
  assert.deepEqual(hillReadout(hillView({ ...part, contested: true })), { fraction: 0.456, team: 1, text: 'Red 45% · contested' })
  assert.deepEqual(hillReadout(hillView(part)), { fraction: 0.456, team: 1, text: 'Red 45%' })

  const full = { capturer: 3, owner: 3, fraction: 1 }
  assert.deepEqual(hillReadout(hillView(full)), { fraction: 1, team: 3, text: 'Held by Green' })
  assert.deepEqual(hillReadout(hillView({ ...full, leader: 3, direction: 'up' })), { fraction: 1, team: 3, text: 'Held by Green' })
  assert.equal(hillReadout(hillView({ ...full, leader: 1, direction: 'down' })).text, 'Red taking the hill from Green')
  assert.equal(hillReadout(hillView({ ...full, contested: true, direction: 'down' })).text, 'Green losing the hill, contested')
})

const flag = (team: number, extra: Partial<FlagView> = {}): FlagView =>
  ({ team, status: 'home', home: { x: team * 100, y: 0 }, position: { x: team * 100, y: 0 }, ...extra })

test('a flag says whether it is at its base, on the ground, or who has it', () => {
  assert.equal(flagReadout(flag(1)), 'At base')
  assert.equal(flagReadout(flag(1, { status: 'dropped' })), 'Dropped')
  assert.equal(flagReadout(flag(1, { status: 'carried', carrier: { id: 4, name: 'Bo', team: 2 } })), 'Carried by Bo')
})

test('the player is told what to do about the flags: bring one home, get theirs back, or return it', () => {
  const local = { id: 4, team: 2 }
  const carrying = flag(1, { status: 'carried', carrier: { id: 4, name: 'Bo', team: 2 } })
  assert.equal(flagHint([carrying, flag(2)], local), 'You have the Red flag. Bring it to your base!')
  assert.equal(
    flagHint([carrying, flag(2, { status: 'carried', carrier: { id: 9, name: 'Al', team: 1 } })], local),
    'You have the Red flag. Your own flag is out: get it back to score.',
  )
  assert.equal(flagHint([flag(1), flag(2, { status: 'dropped' })], local), 'Your flag was dropped. Walk over it to return it.')
  assert.equal(
    flagHint([flag(1), flag(2, { status: 'carried', carrier: { id: 9, name: 'Al', team: 1 } })], local),
    'Your flag is with Al. Take it down.',
  )
  assert.equal(flagHint([flag(1), flag(2)], local), undefined, 'nothing to do')
  assert.equal(flagHint([carrying, flag(2)], undefined), undefined, 'no champion, no hint')
})

// ---------------------------------------------------------------------------- the view of a game

function game(setup: ModeSetup): ClientGameState {
  const state = new ClientGameState()
  state.simulator.reset(Terrain.plain(), setup)
  return state
}

test('in team deathmatch a team\'s score is the kills its players have made, with the limit it plays to', () => {
  const state = game({ kind: 'deathmatch', scoreLimit: 10 })
  const killer = new Champion({ ...brawler, abilities: [...brawler.abilities], attackDamage: 5000 })
  state.simulator.addPlayer(1, 'p1', 'P1', { x: 300, y: 300 }, killer, 1)
  state.simulator.addPlayer(2, 'p2', 'P2', { x: 360, y: 300 }, brawler, 2)
  state.simulator.addPlayer(3, 'p3', 'P3', { x: 900, y: 900 }, brawler, 3)
  state.simulator.advanceTo(3)
  assert.deepEqual(state.getModeView(0), {
    kind: 'deathmatch',
    scores: [{ team: 1, score: 0 }, { team: 2, score: 0 }, { team: 3, score: 0 }],
    limit: 10,
  })

  state.simulator.addOrder(1, { id: '1:1', seq: 1, tick: 5, type: 'attack', targetId: 2 })
  state.simulator.advanceTo(9)
  assert.deepEqual(state.getModeView(0), {
    kind: 'deathmatch',
    scores: [{ team: 1, score: 1 }, { team: 2, score: 0 }, { team: 3, score: 0 }],
    limit: 10,
  })
  // With no limit set, the view has none.
  const unlimited = game({ kind: 'deathmatch' })
  unlimited.simulator.addPlayer(1, 'p1', 'P1', { x: 300, y: 300 }, brawler, 1)
  assert.equal('limit' in unlimited.getModeView(0), false)
})

test('the panel says what a game is played to, when it has a limit', () => {
  assert.equal(modeTitle({ kind: 'deathmatch' }), 'Team Deathmatch')
  assert.equal(modeTitle({ kind: 'deathmatch', limit: 25 }), 'Team Deathmatch · first to 25 kills')
  assert.equal(modeTitle({ kind: 'koth', limit: 100 }), 'King of the Hill · first to 100 points')
  assert.equal(modeTitle({ kind: 'ctf', limit: 3 }), 'Capture the Flag · first to 3 captures')
})

test('the view carries the limit in every mode, and says how long a dead champion has to wait', () => {
  const home = [{ x: 200, y: 300 }, { x: 1800, y: 300 }]
  const state = game({ kind: 'ctf', flags: [{ team: 1, home: home[0] }, { team: 2, home: home[1] }], scoreLimit: 3, respawnTicks: 10 * GAME_TPS })
  const killer = new Champion({ ...brawler, abilities: [...brawler.abilities], attackDamage: 5000 })
  state.simulator.addPlayer(1, 'a', 'A', { x: 1000, y: 1000 }, brawler, 1)
  state.simulator.addPlayer(2, 'b', 'B', { x: 1060, y: 1000 }, killer, 2)
  state.setLocalCharacterId(1)
  state.resetServerTickAnchor(0, 0)
  state.simulator.advanceTo(2)
  assert.equal(state.getModeView(0).kind === 'ctf' && state.getModeView(0).limit, 3)
  assert.equal(state.getRespawnSecondsLeft(0), undefined, 'alive: nothing to wait for')
  assert.equal(state.getLocalTeam(), 1)

  state.simulator.addOrder(2, { id: '2:1', seq: 1, tick: 4, type: 'attack', targetId: 1 })
  state.simulator.advanceTo(10)
  // It died on tick 4, and the game has 10 seconds to wait: at tick 10 that is 594 ticks away, to the tenth of a second.
  state.resetServerTickAnchor(10, 0)
  assert.equal(Math.round((state.getRespawnSecondsLeft(0) ?? 0) * 10), Math.round((4 + 10 * GAME_TPS - 10) / GAME_TPS * 10))
})

test('on the hill the view has the bar, who leads and who holds it, and the points', () => {
  const state = game({ kind: 'koth', hill: HILL })
  state.simulator.addPlayer(1, 'a', 'A', { x: 700, y: 400 }, brawler, 1)
  state.simulator.addPlayer(2, 'b', 'B', { x: 2000, y: 1000 }, brawler, 2)
  state.simulator.advanceTo(150)

  assert.deepEqual(state.getModeView(0), {
    kind: 'koth',
    scores: [{ team: 1, score: 0 }, { team: 2, score: 0 }],
    hill: HILL,
    capturer: 1,
    fraction: 150 / GAME_HILL_CAPTURE_TICKS,
    leader: 1,
    contested: false,
    direction: 'up',
  })

  // A second team walks onto it: with a level number each, nobody leads and the hill is contested.
  state.simulator.reset()
  state.simulator.addPlayer(1, 'a', 'A', { x: 700, y: 400 }, brawler, 1)
  state.simulator.addPlayer(2, 'b', 'B', { x: 720, y: 400 }, brawler, 2)
  state.simulator.advanceTo(10)
  const contested = state.getModeView(0)
  assert.equal(contested.kind === 'koth' && contested.contested, true)
  assert.equal(contested.kind === 'koth' && contested.leader, undefined)
})

test('with flags the view says where each is and who carries it', () => {
  const home = [{ x: 200, y: 300 }, { x: 1800, y: 300 }]
  const state = game({ kind: 'ctf', flags: [{ team: 1, home: home[0] }, { team: 2, home: home[1] }] })
  state.simulator.addPlayer(1, 'a', 'Ann', { x: 1780, y: 300 }, brawler, 1)
  state.simulator.addPlayer(2, 'b', 'Bo', { x: 1000, y: 1000 }, brawler, 2)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)

  const view = state.getModeView(0)
  assert.equal(view.kind, 'ctf')
  if (view.kind !== 'ctf') return
  assert.deepEqual(view.scores, [{ team: 1, score: 0 }, { team: 2, score: 0 }])
  assert.deepEqual(view.flags.map((entry) => [entry.team, entry.status]), [[1, 'home'], [2, 'carried']])
  assert.deepEqual(view.flags[1].carrier, { id: 1, name: 'Ann', team: 1 })
  assert.deepEqual(view.flags[1].home, home[1])
  assert.deepEqual(view.flags[0].position, home[0])
  assert.equal(flagHint(view.flags, { id: 1, team: 1 }), 'You have the Blue flag. Bring it to your base!')
})
