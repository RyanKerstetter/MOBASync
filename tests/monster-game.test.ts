import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { HITBOX_COLORS, hitboxShapes } from '../apps/client/src/render/hitboxes.ts'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  flattenLayers,
  GAME_MONSTER_TEAM,
  GameSnapshotSchema,
  getMonster,
  getProperty,
  monsters,
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
  base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 300 },
})
const slayer = defineChampion({
  id: 't-camp-slayer',
  name: 'Slayer',
  base: { maxHp: 1000, attackDamage: 5000, attackSpeed: 1 },
  moveSpeed: 220,
  radius: 18,
  attackRange: 150,
  attackWindup: 0,
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
const camp = (kind: unknown, x: number, y: number, extra: Record<string, unknown> = {}, property = 'monster-type') => ({
  id: nextId++,
  name: `camp-${String(kind)}`,
  type: 'monster-spawn',
  point: true,
  x,
  y,
  properties: kind === undefined ? [] : [{ name: property, type: 'string', value: kind }],
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
  const layout = readMapLayout(mapWith([camp('wolf', 400, 300), camp('slime', 100.4, 80.6)]))
  // Map pixels from the arena's corner are three world units each, in whole numbers.
  assert.deepEqual(layout.monsters, [{ monster: 'wolf', at: { x: 1200, y: 900 } }, { monster: 'slime', at: { x: 301, y: 242 } }])
  assert.deepEqual(layout.warnings, [])
  assert.deepEqual(readMapLayout(mapWith([])).monsters, [], 'a map need not have any')
  assert.equal(summarizeMap('camps', layout).monsters, 2, 'and the lobby is told how many')
  // The competitive map spells the property `monester-type`, and is read as it is.
  assert.deepEqual(readMapLayout(mapWith([camp('slime', 400, 300, {}, 'monester-type')])).monsters, [{ monster: 'slime', at: { x: 1200, y: 900 } }])
})

test('a point for a monster the game does not have yet is left out, and the map says so, but can still be played on', () => {
  const layout = readMapLayout(mapWith([camp('dragon', 400, 300), camp('slime', 200, 300)]))
  assert.deepEqual(layout.monsters, [{ monster: 'slime', at: { x: 600, y: 900 } }])
  assert.equal(layout.warnings.length, 1)
  assert.match(layout.warnings[0], /camp-dragon is for a monster called "dragon", which the game does not have \(only slime, golem, wolf\b.*\), so it is left out/)
})

test('every monster point on the competitive map is a monster in the game, but those the game does not have yet', () => {
  const map = parseTiledMap(JSON.parse(readFileSync(new URL('../res/maps/competetive.tmj', import.meta.url), 'utf-8')))
  const layout = readMapLayout(map)
  const points = flattenLayers(map.layers).flatMap(({ layer }) => layer.type === 'objectgroup' ? layer.objects : [])
    .filter((object) => (object.class ?? object.type) === 'monster-spawn')
    .map((object) => String(getProperty(object.properties, 'monster-type') ?? getProperty(object.properties, 'monester-type')))
  assert.ok(points.includes('slime') && points.includes('golem'), 'it has slimes and golems')
  for (const kind of ['slime', 'golem']) assert.ok(layout.monsters.some((camp) => camp.monster === kind), `and the game puts the ${kind}s there`)
  assert.deepEqual(layout.monsters.map((camp) => camp.monster), points.filter((kind) => monsters.has(kind)))
  assert.equal(layout.warnings.length, points.filter((kind) => !monsters.has(kind)).length, 'and says which it left out')
})

test('a monster point that is not right says which, and what is wrong', () => {
  assert.match(problemsOf([camp('wolf', 400, 300, { point: false, width: 5, height: 5 })]), /camp-wolf is not a point/)
  assert.match(problemsOf([camp(undefined, 400, 300)]), /camp-undefined needs a monster-type property that names a monster \(slime, golem, wolf/)
  assert.match(problemsOf([camp(7, 400, 300)]), /needs a monster-type property/)
  assert.match(problemsOf([camp(' ', 400, 300)]), /needs a monster-type property/)
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
  assert.equal(state.getClosestEnemy({ x: 100, y: 100 }, 0)?.id, 10, 'with the mouse on Ann it is the nearest to her, at 700, to Bob at 1100')
  assert.equal(state.getClosestEnemy({ x: 880, y: 900 }, 0)?.id, 2, 'and with the mouse over Bob it is Bob')
  assert.ok(state.createAttackOrder(10, 0), 'and an attack order can be given on it')
})

test('monsters are named, and have their ranges and what they are doing, which players do not', () => {
  const state = clientWithMonster()
  const characters = state.getCharacters(0)
  const monster = characters.find((character) => character.id === 10)
  assert.equal(monster?.name, 'Camp Grunt')
  assert.equal(monster?.player, undefined)
  assert.deepEqual(monster?.monster, { aggroRange: 300, deaggroRange: 450, deaggro: 0, home: { x: 600, y: 600 }, mode: 'idle' })
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

test('the debug view marks a monster\'s aggro range round it and its deaggro range round its home, and nothing for a player', () => {
  const state = clientWithMonster()
  // The monster has been drawn off its home, to 200 east of it: its aggro range goes with it, and its deaggro range does not.
  const drawn = state.getCharacters(0).map((character) => (character.monster ? { ...character, position: { x: 800, y: 600 } } : character))
  const shapes = hitboxShapes(drawn, [], 1)
  const rings = shapes.filter((shape) => shape.kind === 'circle' && shape.outline)
  assert.deepEqual(rings.map((shape) => shape.kind === 'circle' && [shape.color, shape.radius, shape.x, shape.y]), [
    [HITBOX_COLORS.aggro, 300, 800, 600],
    [HITBOX_COLORS.deaggro, 450, 600, 600],
  ])
  assert.equal(shapes.length, 3 + 2 + 1, 'three bodies, two rings, and a mark on its home')
})

// ---------------------------------------------------------------------------- the deaggro bar, on the page

// Hits from a long way off, and runs much faster than the monster can.
const sprinter = defineChampion({
  id: 't-bar-sprinter',
  name: 'Sprinter',
  base: { maxHp: 2000, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 400,
  radius: 18,
  attackRange: 500,
  attackWindup: 0,
  abilities: [...brawler.abilities],
})
// Loses interest once it is more than 450 from where it started, and its bar takes a second to fill.
const sulker = defineMonster({
  id: 't-bar-sulker',
  name: 'Sulker',
  base: { maxHp: 800, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 300, deaggroRange: 450, deaggroTicks: 60 },
})

test('a monster that is losing interest is shown with its deaggro bar, as a share of full, full while it walks home, and with none at rest', () => {
  const state = new ClientGameState()
  state.simulator.addMonster(10, sulker, { x: 700, y: 300 })
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 1100, y: 300 }, sprinter, 1)
  state.setLocalCharacterId(1)
  state.simulator.addOrder(1, { id: 'snipe', seq: 1, tick: 1, type: 'attack', targetId: 10 })
  state.simulator.addOrder(1, { id: 'run', seq: 2, tick: 40, type: 'move', target: { x: 2300, y: 300 } })
  const monster = () => state.getCharacters(0).find((character) => character.id === 10)?.monster

  // It is hit from 400 away, and goes after them: it is a long way out already by tick 100, but still within 450 of where it started.
  state.simulator.at(100)
  assert.equal(monster()?.mode, 'chase')
  assert.equal(monster()?.deaggro, 0, 'it is after them, and within its range of home: nothing in the bar')
  // It leaves that range at about tick 134, and the bar fills a tick at a time from there.
  state.simulator.at(170)
  const filling = monster()?.deaggro ?? 0
  assert.ok(filling > 0.5 && filling < 0.65, `about 34 ticks of the 60 (${filling.toFixed(2)})`)
  assert.equal(monster()?.mode, 'chase')
  assert.equal(filling, state.simulator.at(170).getCharacterState(10)?.ai?.deaggro as number / 60, 'the share the frame says')
  state.simulator.at(230)
  assert.deepEqual([monster()?.mode, monster()?.deaggro], ['return', 1], 'full, and walking home')
  state.simulator.at(500)
  assert.deepEqual([monster()?.mode, monster()?.deaggro], ['idle', 0], 'home, and the bar is empty')
})
