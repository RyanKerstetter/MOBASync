import assert from 'node:assert/strict'
import test from 'node:test'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  Champion,
  FINALIZE_LAG,
  GAME_MAX_PLAYERS,
  Terrain,
  GAME_TPS,
  type GameMode,
} from '../packages/shared/src/index.ts'
import { brawler, cursebearer, trinketmaster } from './fixtures.ts'
import { teamSizeArrangements, teamsOf, testSpawns } from './test-spawns.ts'

// Starts a game in which every player picked the same test champion, so these tests do not
// depend on what the real roster or its default happens to be.
function startGame(game: ServerGameState, players: Array<{ id: string; name: string }>, championId: string): void {
  game.beginSelection(players)
  for (const player of players) {
    game.pickChampion(player.id, championId)
    game.lockChampion(player.id)
  }
  game.begin(players)
}

test('server derives attack damage through the shared simulator without health results', () => {
  const game = new ServerGameState(testSpawns)
  startGame(game, [{ id: 'player-1', name: 'Player 1' }, { id: 'player-2', name: 'Player 2' }], brawler.id)
  const attackerId = game.getCharacterId('player-1')
  const targetId = game.getCharacterId('player-2')
  assert.ok(attackerId)
  assert.ok(targetId)
  const champion = brawler
  const attackerStart = game.simulator.at(0).get(attackerId)?.getPosition()
  const targetStart = game.simulator.at(0).get(targetId)?.getPosition()
  assert.ok(attackerStart && targetStart)

  // Players start apart, so the attacker walks up to within reach of the target first.
  const meeting = { x: targetStart.x - champion.attackRange / 2, y: targetStart.y }
  const walk = game.acceptOrder('player-1', { id: 'player-1:1', seq: 1, tick: 1, type: 'move', target: meeting })
  assert.equal(walk.ack.status, 'accepted')
  const walkTicks = Math.ceil((meeting.x - attackerStart.x) / (champion.moveSpeed / GAME_TPS)) + 2
  for (let tick = 1; tick <= walkTicks; tick += 1) game.advanceTick()

  const attackTick = game.simulator.tick + 1
  const verdict = game.acceptOrder('player-1', {
    id: 'player-1:2',
    seq: 2,
    tick: attackTick,
    type: 'attack',
    targetId,
  })
  assert.equal(verdict.ack.status, 'accepted')

  // The auto lands after its windup, so the server does not announce any health result.
  const landing = attackTick + champion.attackWindupTicks
  while (game.simulator.tick < landing) game.advanceTick()

  const target = game.simulator.at(landing).get(targetId)
  assert.equal(target?.getHealth(), champion.maxHp - champion.attackDamage)
})

// Starts a game with a player on each of these teams and gives back where each began.
function startTeams(teams: number[]): { game: ServerGameState; ids: number[]; at: Array<{ x: number; y: number }> } {
  const game = new ServerGameState(testSpawns)
  const players = teams.map((team, index) => ({ id: `player-${index + 1}`, name: `P${index + 1}`, team }))
  startGame(game, players, brawler.id)
  const ids = players.map((player) => game.getCharacterId(player.id) as number)
  const at = ids.map((id) => game.simulator.at(0).get(id)?.getPosition() as { x: number; y: number })
  return { game, ids, at }
}

test('the biggest team starts at the first slot of spawn points, the next biggest at the second, and so on', () => {
  // Team 2 has three players and team 1 two, so team 2 takes the first slot and team 1 the second, each
  // player at the next point of their slot in the order they are listed.
  const { at } = startTeams([1, 2, 1, 2, 2])
  assert.deepEqual([at[1], at[3], at[4]], testSpawns[0].slice(0, 3))
  assert.deepEqual([at[0], at[2]], testSpawns[1].slice(0, 2))

  // Teams of one are one to a slot, in order of their number.
  const solo = startTeams([5, 3, 4]).at
  assert.deepEqual(solo, [testSpawns[2][0], testSpawns[0][0], testSpawns[1][0]])
})

test('a tie in size goes to the lower team number, and where the players of other teams are listed changes nothing', () => {
  const [first, second] = startTeams([2, 1]).at
  assert.deepEqual([first, second], [testSpawns[1][0], testSpawns[0][0]], 'team 1 has the first slot, as the smaller number')

  const grouped = startTeams([1, 1, 2, 2]).at
  const mixed = startTeams([1, 2, 1, 2]).at
  assert.deepEqual([mixed[0], mixed[2], mixed[1], mixed[3]], grouped)
})

test('a game starts for every way the players can be split into teams of the most a team holds', () => {
  for (const sizes of teamSizeArrangements()) {
    const { at } = startTeams(teamsOf(sizes))
    assert.equal(new Set(at.map(({ x, y }) => `${x},${y}`)).size, at.length, `${sizes.join('+')}: nobody shares a spot`)
  }
})

test('a game is played on the map it was started with, and the next on the map as it is then', () => {
  const players = [{ id: 'player-1', name: 'One', team: 1 }, { id: 'player-2', name: 'Two', team: 2 }]
  const first = { spawns: testSpawns, terrain: new Terrain({ width: 1000, height: 600 }, [{ x: 800, y: 200, width: 100, height: 100 }]) }
  const moved = testSpawns.map((slot) => slot.map((point) => ({ x: point.x + 10, y: point.y + 20 })))
  const second = { spawns: moved, terrain: new Terrain({ width: 1300, height: 700 }, [{ x: 900, y: 300, width: 50, height: 50 }]) }
  const game = new ServerGameState(testSpawns)
  const playOn = (map?: typeof first): void => {
    game.beginSelection(players, map)
    for (const player of players) {
      game.pickChampion(player.id, brawler.id)
      game.lockChampion(player.id)
    }
    game.begin(players)
  }

  playOn(first)
  assert.deepEqual(game.snapshot().terrain, first.terrain.toData())
  assert.deepEqual(game.snapshot().characters.map((character) => character.initialPosition), [testSpawns[0][0], testSpawns[1][0]])

  game.cancelStart()
  playOn(second)
  assert.deepEqual(game.snapshot().terrain, second.terrain.toData())
  assert.deepEqual(game.snapshot().characters.map((character) => character.initialPosition), [moved[0][0], moved[1][0]])

  // A game started with no new map is played on the one before, not on the plain arena.
  game.cancelStart()
  playOn()
  assert.deepEqual(game.snapshot().terrain, second.terrain.toData())
})

test('a game that is already under way keeps its map when another is offered, since it was not started', () => {
  const game = new ServerGameState(testSpawns, new Terrain({ width: 1000, height: 600 }, [{ x: 800, y: 200, width: 100, height: 100 }]))
  const players = [{ id: 'player-1', name: 'One' }]
  assert.equal(game.beginSelection(players), true)
  const other = { spawns: testSpawns, terrain: new Terrain({ width: 1300, height: 700 }) }
  assert.equal(game.beginSelection(players, other), false)
  for (const player of players) game.lockChampion(player.id)
  game.begin(players)
  assert.equal(game.snapshot().terrain?.width, 1000)
})

test('a game on a map with too few spawn points for its teams does not start, and nothing has changed', () => {
  const game = new ServerGameState([[{ x: 300, y: 300 }]])
  const players = [{ id: 'player-1', name: 'One', team: 1 }, { id: 'player-2', name: 'Two', team: 1 }]
  game.beginSelection(players)
  for (const player of players) game.lockChampion(player.id)
  assert.throws(() => game.begin(players), /Red is the biggest team, with 2 players, but This map only has room for 1 on the biggest team/)
  assert.equal(game.status, 'selecting')
  assert.equal(game.simulator.characters.size, 0)
})

test('the server keeps each player\'s team on their character and in the snapshot, and a player with none is alone', () => {
  const { game, ids } = startTeams([2, 2, 5])
  assert.deepEqual(ids.map((id) => game.simulator.characters.get(id)?.team), [2, 2, 5])
  assert.deepEqual(game.snapshot().characters.map((character) => character.team), [2, 2, 5])

  // With no team given, each player is on a team of their own, so everyone is an enemy.
  const alone = new ServerGameState(testSpawns)
  startGame(alone, [{ id: 'player-1', name: 'One' }, { id: 'player-2', name: 'Two' }], brawler.id)
  const teams = [1, 2].map((id) => alone.simulator.characters.get(id)?.team)
  assert.equal(new Set(teams).size, 2)
})

test('a full lobby picks, loads and starts together, with every character in its own spot', () => {
  const game = new ServerGameState(testSpawns)
  const players = Array.from({ length: GAME_MAX_PLAYERS }, (_, index) => ({ id: `player-${index + 1}`, name: `P${index + 1}` }))
  startGame(game, players, brawler.id)

  const characterIds = players.map((player) => game.getCharacterId(player.id))
  assert.equal(new Set(characterIds).size, GAME_MAX_PLAYERS, 'each player has a character of their own')
  for (const player of players.slice(0, -1)) {
    assert.equal(game.markReady(player.id), true)
    assert.equal(game.startIfReady(), undefined, 'the game waits for the last player')
  }
  assert.equal(game.markReady(players[players.length - 1].id), true)
  const snapshot = game.startIfReady()

  assert.equal(game.status, 'running')
  assert.equal(snapshot?.characters.length, GAME_MAX_PLAYERS)
  const spots = new Set(snapshot?.characters.map(({ initialPosition }) => `${initialPosition.x},${initialPosition.y}`))
  assert.equal(spots.size, GAME_MAX_PLAYERS, 'nobody starts on top of anybody')
})

test('the server counts a kill once the lethal tick is committed, and has no death to announce', () => {
  const game = new ServerGameState(testSpawns)
  startGame(game, [{ id: 'player-1', name: 'Player 1' }], brawler.id)
  const targetId = game.getCharacterId('player-1')
  assert.ok(targetId)
  const target = brawler
  const targetAt = game.simulator.at(0).get(targetId)?.getPosition()
  assert.ok(targetAt)
  game.simulator.addPlayer(99, 'attacker', 'Attacker', { x: targetAt.x + 40, y: targetAt.y }, new Champion({
    ...brawler,
    abilities: [...brawler.abilities],
    base: { ...brawler.base, attackSpeed: GAME_TPS },
  }))
  const hitsToKill = Math.ceil(target.maxHp / brawler.attackDamage)
  for (let index = 0; index < hitsToKill + 4; index += 1) {
    game.simulator.addOrder(99, {
      id: `attack-${index + 1}`, seq: index + 1, tick: index + 1, type: 'attack', targetId,
    })
  }

  let creditedAt: number | undefined
  for (let tick = 1; tick <= 30; tick += 1) {
    game.advanceTick()
    if (creditedAt === undefined && game.simulator.characters.get(99)?.kills === 1) creditedAt = tick
  }

  // The target dies on the lethal hit, which can still be undone by a late order until that tick is
  // committed FINALIZE_LAG later. Only then is the kill the attacker's, and nothing is sent to anyone.
  const deathTick = game.simulator.at(30).get(targetId)?.getDeathTick()
  assert.ok(deathTick !== undefined && deathTick <= hitsToKill + 1)
  assert.equal(creditedAt, deathTick + FINALIZE_LAG)
  assert.equal(game.simulator.at(30).get(targetId)?.isDead(), true)
  assert.deepEqual(
    game.snapshot().characters.map(({ id, kills }) => [id, kills]).sort(([left], [right]) => left - right),
    [[targetId, 0], [99, 1]],
  )
})

test('the server accepts the recast of an ability the champion has, and still refuses ones it does not', () => {
  const game = new ServerGameState(testSpawns)
  startGame(game, [{ id: 'player-1', name: 'Player 1' }, { id: 'player-2', name: 'Player 2' }], trinketmaster.id)
  const characterId = game.getCharacterId('player-1')
  assert.ok(characterId)
  const origin = game.simulator.at(0).get(characterId)?.getPosition()
  assert.ok(origin)
  const cast = (abilityId: string, seq: number) => game.acceptOrder('player-1', {
    id: `player-1:${seq}`, seq, tick: seq, type: 'cast', abilityId, target: { mode: 'none' }, origin,
  }).ack

  // The recall is on no key, but it is the trinketmaster's.
  assert.equal(cast('t-recall', 1).status, 'accepted')
  const refused = cast('t-meteor', 2)
  assert.deepEqual([refused.status, refused.reason], ['rejected', 'unknown_ability'])
})

test('champion select starts the game with each player\'s locked pick', () => {
  const game = new ServerGameState(testSpawns)
  const players = [{ id: 'player-1', name: 'Player 1' }, { id: 'player-2', name: 'Player 2' }]

  assert.equal(game.beginSelection(players), true)
  assert.equal(game.status, 'selecting')
  assert.equal(game.beginSelection(players), false, 'select cannot restart while it is open')
  assert.equal(game.pickChampion('player-1', 'nobody'), false, 'unknown champions are refused')
  assert.equal(game.pickChampion('stranger', cursebearer.id), false)
  assert.equal(game.pickChampion('player-1', cursebearer.id), true)
  assert.equal(game.pickChampion('player-2', brawler.id), true)

  assert.equal(game.lockChampion('player-1'), true)
  assert.equal(game.allChampionsLocked(), false)
  assert.equal(game.pickChampion('player-1', brawler.id), false, 'a locked pick cannot change')
  assert.equal(game.lockChampion('player-2'), true)
  assert.equal(game.allChampionsLocked(), true)

  game.begin(players)
  assert.equal(game.status, 'starting')
  const championIds = game.snapshot().characters.map((character) => character.championId)
  assert.deepEqual(championIds, [cursebearer.id, brawler.id])
  assert.equal(game.selections.size, 0)
})

test('champion select ends when a player leaves or the selection is cancelled', () => {
  const game = new ServerGameState(testSpawns)
  game.beginSelection([{ id: 'player-1', name: 'Player 1' }, { id: 'player-2', name: 'Player 2' }])
  game.lockChampion('player-1')
  assert.equal(game.allChampionsLocked(), false)

  game.removePlayer('player-2')
  assert.equal(game.allChampionsLocked(), true, 'the remaining player is the only one left to lock')

  game.cancelStart()
  assert.equal(game.status, 'idle')
  assert.equal(game.selections.size, 0)
  assert.equal(game.pickChampion('player-1', cursebearer.id), false)
})

// ---------------------------------------------------------------------------- game modes

const modeMap = {
  spawns: testSpawns,
  terrain: new Terrain({ width: 2400, height: 1000 }),
  hill: { x: 800, y: 400, width: 300, height: 300, ellipse: true },
  flags: [{ x: 300, y: 500 }, { x: 2000, y: 500 }],
}

// Opens champion select for these players in a mode, on the map above, and has everyone lock in.
function startMode(game: ServerGameState, mode: GameMode, teams: number[]): void {
  const players = teams.map((team, index) => ({ id: `player-${index + 1}`, name: `P${index + 1}`, team }))
  assert.equal(game.beginSelection(players, modeMap, mode), true)
  for (const player of players) game.lockChampion(player.id)
  game.begin(players)
}

test('a game of capture the flag gives each team the flag of the slot it starts at, in the snapshot', () => {
  const game = new ServerGameState(testSpawns)
  // Team 4 has two players, so it starts at the first slot and has the first flag; team 2 has the second.
  startMode(game, 'ctf', [2, 4, 4])
  const snapshot = game.snapshot()
  assert.deepEqual(snapshot.mode, {
    kind: 'ctf',
    flags: [{ team: 4, home: { x: 300, y: 500 } }, { team: 2, home: { x: 2000, y: 500 } }],
  })
  assert.deepEqual(snapshot.checkpoint.objective, {
    kind: 'ctf',
    flags: [{ team: 4, position: { x: 300, y: 500 } }, { team: 2, position: { x: 2000, y: 500 } }],
    scores: {},
  })
})

test('a game of king of the hill is played on the map\'s hill, with the bar empty', () => {
  const game = new ServerGameState(testSpawns)
  startMode(game, 'koth', [1, 2, 3])
  const snapshot = game.snapshot()
  assert.deepEqual(snapshot.mode, { kind: 'koth', hill: modeMap.hill })
  assert.deepEqual(snapshot.checkpoint.objective, { kind: 'koth', progress: 0, scores: {} })
})

test('a game of team deathmatch has no mode in its snapshot, and the one after a game of another mode is not played in it', () => {
  const game = new ServerGameState(testSpawns)
  startMode(game, 'deathmatch', [1, 2])
  assert.equal(game.snapshot().mode, undefined)
  assert.equal(game.snapshot().checkpoint.objective, undefined)

  game.cancelStart()
  startMode(game, 'ctf', [1, 2])
  assert.equal(game.snapshot().mode?.kind, 'ctf')
  game.cancelStart()
  startMode(game, 'deathmatch', [1, 2])
  assert.equal(game.snapshot().mode, undefined, 'back to deathmatch')
  assert.equal(game.simulator.at(0).getObjective(), undefined)
})

test('capture the flag with other than two teams, or a mode the map has nothing for, does not start, and nothing has changed', () => {
  const game = new ServerGameState(testSpawns)
  const three = [{ id: 'a', name: 'A', team: 1 }, { id: 'b', name: 'B', team: 2 }, { id: 'c', name: 'C', team: 3 }]
  assert.match(game.modeProblem(three, 'ctf', modeMap) ?? '', /exactly 2 teams, and there are 3/)
  assert.equal(game.modeProblem(three, 'koth', modeMap), undefined)
  assert.match(game.modeProblem(three, 'koth', { flags: [] }) ?? '', /no hill/)

  assert.equal(game.beginSelection(three, modeMap, 'ctf'), true)
  for (const player of three) game.lockChampion(player.id)
  assert.throws(() => game.begin(three), /exactly 2 teams/)
  assert.equal(game.status, 'selecting')
  assert.equal(game.simulator.characters.size, 0)

  // The same lobby with one of them gone is two teams, and the game starts.
  game.removePlayer('c')
  assert.equal(game.modeProblem(three.slice(0, 2)), undefined)
  game.begin(three.slice(0, 2))
  assert.equal(game.status, 'starting')
})

test('players who leave champion select can leave the mode without the teams it needs, which the game can tell', () => {
  const game = new ServerGameState(testSpawns)
  const players = [{ id: 'a', name: 'A', team: 1 }, { id: 'b', name: 'B', team: 2 }]
  game.beginSelection(players, modeMap, 'ctf')
  assert.equal(game.modeProblem(players), undefined)
  assert.match(game.modeProblem(players.slice(0, 1)) ?? '', /exactly 2 teams, and there is 1/)
})
