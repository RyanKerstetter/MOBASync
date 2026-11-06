import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  flagHint,
  flagReadout,
  formatGameClock,
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

// ---------------------------------------------------------------------------- the game clock

test('the clock counts up in minutes and seconds, and in hours once there are some', () => {
  const clock = (seconds: number): string => formatGameClock(seconds)
  assert.deepEqual(
    [0, 1, 9, 59, 60, 61, 125, 599, 600, 3599].map(clock),
    ['0:00', '0:01', '0:09', '0:59', '1:00', '1:01', '2:05', '9:59', '10:00', '59:59'],
  )
  assert.deepEqual([3600, 3601, 3661, 36_000, 45_296].map(clock), ['1:00:00', '1:00:01', '1:01:01', '10:00:00', '12:34:56'])
})

test('the clock reads whole seconds, rounded down, so it never runs ahead of the game', () => {
  assert.equal(formatGameClock(0.999), '0:00')
  assert.equal(formatGameClock(59.999), '0:59')
  assert.equal(formatGameClock(60), '1:00')
  assert.equal(formatGameClock(125.9), '2:05')
})

test('a time before the start, or that is not a time, reads as the start', () => {
  for (const seconds of [-1, -0.5, -3600, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
    assert.equal(formatGameClock(seconds), '0:00', String(seconds))
  }
})

test('the clock only ever goes forward as the game does, a second at a time', () => {
  const read: string[] = []
  for (let second = 0; second <= 130; second += 1) read.push(formatGameClock(second))
  assert.equal(new Set(read).size, read.length, 'each second reads differently')
  const total = (text: string): number => text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
  read.forEach((text, second) => assert.equal(total(text), second))
})

test('the game\'s own clock is the server\'s tick, estimated forward to now, in seconds', () => {
  const state = new ClientGameState()
  // The game begins on tick 0, and the page is told the tick it is on when it joins.
  state.resetServerTickAnchor(0, 1000)
  assert.equal(state.getGameSeconds(1000), 0, 'at the start it is nothing')
  assert.equal(state.getGameSeconds(1000 + 2500), 2.5, 'and a second of real time is a second of game')

  state.resetServerTickAnchor(125 * GAME_TPS, 5000)
  assert.equal(state.getGameSeconds(5000), 125)
  assert.equal(formatGameClock(state.getGameSeconds(5000)), '2:05', 'two minutes five in')
  assert.equal(formatGameClock(state.getGameSeconds(5000 + 999)), '2:05', 'until a whole second more has gone by')
  assert.equal(formatGameClock(state.getGameSeconds(5000 + 1000)), '2:06')

  // A newer tick from the server moves it on to what the server says; an older one does not take it back.
  state.setServerTick(130 * GAME_TPS, 6000, 0)
  assert.equal(state.getGameSeconds(6000), 130)
  state.setServerTick(100 * GAME_TPS, 7000, 0)
  assert.equal(state.getGameSeconds(6000), 130, 'a tick that is older than what it knows changes nothing')
})

test('the game\'s clock is never negative, whatever moment it is asked for', () => {
  const state = new ClientGameState()
  state.resetServerTickAnchor(0, 5000)
  assert.equal(state.getGameSeconds(1000), 0, 'a moment before the page was told')
})

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
  const killer = new Champion({ ...brawler, abilities: [...brawler.abilities], base: { ...brawler.base, attackDamage: 5000 } })
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
  const killer = new Champion({ ...brawler, abilities: [...brawler.abilities], base: { ...brawler.base, attackDamage: 5000 } })
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
