import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { HITBOX_COLORS, hitboxShapes } from '../apps/client/src/render/hitboxes.ts'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  GAME_MONSTER_TEAM,
  GameSnapshotSchema,
  getMonster,
  parseTiledMap,
  readMapLayout,
  summarizeMap,
  Terrain,
} from '../packages/shared/src/index.ts'
import { brawler, defineChampion, defineMonster } from './fixtures.ts'
import { testSpawns } from './test-spawns.ts'

// A game with monsters in it: the map puts them there, the server starts them with the game, and the page draws them as
// something to fight, but not as a player.

const grunt = defineMonster({
  id: 't-camp-grunt',
  name: 'Camp Grunt',
  maxHp: 600,
  moveSpeed: 200,
  radius: 20,
  attackDamage: 20,
  attackSpeed: 1,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 300, leashRange: 600 },
})
const slayer = defineChampion({
  id: 't-camp-slayer',
  name: 'Slayer',
  maxHp: 1000,
  moveSpeed: 220,
  radius: 18,
  attackDamage: 5000,
  attackSpeed: 1,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: [...brawler.abilities],
})

// ---------------------------------------------------------------------------- the map

// A map of 100 by 100 tiles at 16 pixels, drawn at three, with one arena, spawn points for two teams, and these objects.
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
let nextId = 500
const camp = (kind: unknown, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id: nextId++,
  name: `camp-${String(kind)}`,
  type: 'monster',
  point: true,
  x,
  y,
  properties: kind === undefined ? [] : [{ name: 'monster', type: 'string', value: kind }],
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

test('a map puts monsters where its monster points are, by the monster they name', () => {
  const layout = readMapLayout(mapWith([camp('wolf', 400, 300), camp('wolf', 100.4, 80.6)]))
  // Map pixels from the arena's corner are three world units each, in whole numbers.
  assert.deepEqual(layout.monsters, [{ monster: 'wolf', at: { x: 1200, y: 900 } }, { monster: 'wolf', at: { x: 301, y: 242 } }])
  assert.deepEqual(readMapLayout(mapWith([])).monsters, [], 'a map need not have any')
  assert.equal(summarizeMap('camps', layout).monsters, 2, 'and the lobby is told how many')
})

test('a monster point that is not right says which, and what is wrong', () => {
  assert.match(problemsOf([camp('wolf', 400, 300, { point: false, width: 5, height: 5 })]), /camp-wolf is not a point/)
  assert.match(problemsOf([camp(undefined, 400, 300)]), /camp-undefined needs a monster property that names a monster \(wolf/)
  assert.match(problemsOf([camp('dragon', 400, 300)]), /camp-dragon needs a monster property that names a monster/)
  assert.match(problemsOf([camp(7, 400, 300)]), /needs a monster property/)
  assert.match(problemsOf([camp('wolf', -5, 300)]), /camp-wolf is outside the arena/)
  // The wolf is 22 across from its middle, a third of that in map pixels, so one a pixel from the edge has no room.
  assert.match(problemsOf([camp('wolf', 1, 300)]), /camp-wolf is too close to a wall or the arena's edge: a Wolf would start inside it/)
  assert.deepEqual(readMapLayout(mapWith([camp('wolf', 8, 300)])).monsters.length, 1, 'with room for its size it is fine')
})

// ---------------------------------------------------------------------------- the server

const players = [{ id: 'a', name: 'Ann', team: 1 }, { id: 'b', name: 'Bob', team: 2 }]
const terrain = new Terrain({ width: 2400, height: 1400 })
const withCamps = { id: 'camps', spawns: testSpawns, terrain, flags: [], monsters: [{ monster: grunt.id, at: { x: 1200, y: 700 } }, { monster: grunt.id, at: { x: 1500, y: 800 } }] }

function started(map = withCamps): ServerGameState {
  const game = new ServerGameState([])
  game.beginSelection(players, map, 'deathmatch', { scoreLimit: 3 })
  for (const player of players) game.lockChampion(player.id)
  game.begin(players)
  return game
}

test('the server starts a game with the map\'s monsters, after the players, in their own team', () => {
  const game = started()
  const characters = [...game.simulator.characters.values()]
  assert.deepEqual(characters.map((character) => [character.id, character.monster?.id, character.team]), [
    [1, undefined, 1],
    [2, undefined, 2],
    [3, 't-camp-grunt', GAME_MONSTER_TEAM],
    [4, 't-camp-grunt', GAME_MONSTER_TEAM],
  ])
  assert.deepEqual(game.simulator.characters.get(4)?.initialPosition, { x: 1500, y: 800 })
  assert.deepEqual([game.getCharacterId('a'), game.getCharacterId('b')], [1, 2], 'a player\'s ID is what it always was')
  assert.deepEqual(game.playingPlayerIds.sort(), ['a', 'b'], 'monsters are not players')

  const snapshot = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(game.snapshot())))
  assert.deepEqual(snapshot.characters.map((character) => [character.id, character.championId, character.player?.name]), [
    [1, snapshot.characters[0].championId, 'Ann'],
    [2, snapshot.characters[1].championId, 'Bob'],
    [3, 't-camp-grunt', undefined],
    [4, 't-camp-grunt', undefined],
  ])
})

test('a game on a map with no monsters has none, and the next game is not given the last one\'s', () => {
  const game = started({ ...withCamps, monsters: [] })
  assert.equal([...game.simulator.characters.values()].some((character) => character.monster), false)
  game.cancelStart()
  game.beginSelection(players, withCamps)
  for (const player of players) game.lockChampion(player.id)
  game.begin(players)
  assert.equal([...game.simulator.characters.values()].filter((character) => character.monster).length, 2)
  game.cancelStart()
  game.beginSelection(players, { ...withCamps, monsters: undefined })
  for (const player of players) game.lockChampion(player.id)
  game.begin(players)
  assert.equal([...game.simulator.characters.values()].filter((character) => character.monster).length, 0)
})

test('monsters are not on the results, do not stop a game from shutting down, and scores are the players\'', () => {
  const game = started()
  for (const player of players) game.markReady(player.id)
  assert.ok(game.startIfReady())
  // Ann walks up to the camp.
  game.simulator.addOrder(1, { id: 'x', seq: 1, tick: 1, type: 'move', target: { x: 1200, y: 700 } })
  for (let tick = 0; tick < 40; tick += 1) game.advanceTick()
  const result = game.end()
  assert.deepEqual(result?.players.map((player) => player.name).sort(), ['Ann', 'Bob'], 'two players, and no Camp Grunt')
  assert.deepEqual(result?.teams.map((team) => team.team).sort(), [1, 2], 'two teams, and not the monsters')

  game.leaveGame('a')
  game.leaveGame('b')
  assert.equal(game.closeIfEmpty(), true, 'the monsters do not keep a game with no players in it going')
  assert.equal(game.status, 'idle')
})

// ---------------------------------------------------------------------------- the page

function clientWithMonster(): ClientGameState {
  const state = new ClientGameState()
  state.simulator.addMonster(10, grunt, { x: 600, y: 600 })
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 100, y: 100 }, brawler, 1)
  state.simulator.addPlayer(2, 'p2', 'Bob', { x: 900, y: 900 }, brawler, 2)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  return state
}

test('a monster can be clicked on and attacked, and is the nearest enemy when it is', () => {
  const state = clientWithMonster()
  assert.equal(state.getEnemyNear({ x: 600, y: 600 }, 0)?.id, 10, 'it is under the pointer')
  assert.equal(state.getEnemyNear({ x: 100, y: 100 }, 0), undefined, 'the local champion is not its own enemy')
  assert.equal(state.getClosestEnemy(0)?.id, 10, 'it is the nearest to Ann, at 700, to Bob at 1100')
  assert.ok(state.createAttackOrder(10, 0), 'and an attack order can be given on it')
})

test('monsters are named, and have their ranges and what they are doing, which players do not', () => {
  const state = clientWithMonster()
  const characters = state.getCharacters(0)
  const monster = characters.find((character) => character.id === 10)
  assert.equal(monster?.name, 'Camp Grunt')
  assert.equal(monster?.player, undefined)
  assert.deepEqual(monster?.monster, { aggroRange: 300, deaggroRange: 450, leashRange: 600, home: { x: 600, y: 600 }, mode: 'idle' })
  assert.equal(characters.find((character) => character.id === 1)?.name, 'Ann')
  assert.equal(characters.find((character) => character.id === 1)?.monster, undefined)
})

test('monsters are not on the leaderboard or the team scores, and are in the killfeed when one dies', () => {
  const state = clientWithMonster()
  assert.deepEqual(state.getLeaderboard().map((row) => row.name), ['Ann', 'Bob'])
  const view = state.getModeView(0)
  assert.deepEqual(view.scores.map((score) => score.team).sort(), [1, 2], 'two teams, and not the monsters\'')

  const killer = defineChampion({ ...slayer, id: 't-camp-slayer-2' })
  const fight = new ClientGameState()
  fight.simulator.addMonster(10, grunt, { x: 600, y: 600 })
  fight.simulator.addPlayer(1, 'p1', 'Ann', { x: 700, y: 600 }, killer, 1)
  fight.setLocalCharacterId(1)
  fight.simulator.addOrder(1, { id: '1:1', seq: 1, tick: 2, type: 'attack', targetId: 10 })
  for (let tick = 1; tick <= 30; tick += 1) {
    fight.simulator.advanceTo(tick)
    if (tick > 12) fight.simulator.setCommitTick(tick - 12)
  }
  const [line] = fight.getKillFeed(performance.now())
  assert.deepEqual([line?.killer?.name, line?.victim.name, line?.victim.team], ['Ann', 'Camp Grunt', GAME_MONSTER_TEAM])
})

test('the debug view marks a monster\'s aggro and deaggro ranges round it and its leash round its home, and nothing for a player', () => {
  const state = clientWithMonster()
  const shapes = hitboxShapes(state.getCharacters(0), [], 1)
  const rings = shapes.filter((shape) => shape.kind === 'circle' && shape.outline)
  assert.deepEqual(rings.map((shape) => shape.kind === 'circle' && [shape.color, shape.radius, shape.x, shape.y]), [
    [HITBOX_COLORS.aggro, 300, 600, 600],
    [HITBOX_COLORS.deaggro, 450, 600, 600],
    [HITBOX_COLORS.leash, 600, 600, 600],
  ])
  assert.equal(shapes.length, 3 + 1 + 3, 'three bodies, three rings, and a mark on its home')
  assert.equal(getMonster('wolf').ai.leashRange > getMonster('wolf').ai.aggroRange, true)
})
