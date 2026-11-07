import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Color, Container, RenderLayer, type Graphics } from 'pixi.js'
import { ClientGameState, type RenderedCharacter, type RenderedEntity } from '../apps/client/src/game-state.ts'
import { BUSH_COLOR, BUSH_EDGE_ALPHA, BUSH_FILL_ALPHA, BushAreaLayer } from '../apps/client/src/render/bush-area.ts'
import { SHOP_AREA_FILL_ALPHA } from '../apps/client/src/render/shop-area.ts'
import { WorldRenderer } from '../apps/client/src/render/world-renderer.ts'
import { createTeamVision, TeamVision } from '../apps/client/src/team-vision.ts'
import {
  createShadowcastVision,
  flattenLayers,
  GAME_MONSTER_TEAM,
  GAME_VISION_RANGE,
  GameSnapshotSchema,
  parseTiledMap,
  readMapLayout,
  Simulator,
  Terrain,
  type Rect,
  type VisionMask,
  type VisionSystem,
} from '../packages/shared/src/index.ts'
import { brawler, defineMonster } from './fixtures.ts'

// Bushes: ground that hides whoever stands in it from every team with no one in the same bush. The ground (`Terrain.bushAt`, and that it
// travels in a snapshot), then what the page does with it (`TeamVision`, which decides what is drawn, and so what a click can pick), then the
// map the game plays on. No rule of the game reads a bush, so there is nothing here about the simulation but that it carries them.

const ARENA = { width: 2400, height: 1400 }
const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

// ---------------------------------------------------------------------------- the ground

test('a point is in a bush when it is in the rectangle, edges included, and not when it is out', () => {
  const terrain = new Terrain(ARENA, [], undefined, [rect(100, 200, 50, 40)])
  assert.notEqual(terrain.bushAt({ x: 125, y: 220 }), undefined, 'in the middle')
  for (const corner of [{ x: 100, y: 200 }, { x: 150, y: 200 }, { x: 100, y: 240 }, { x: 150, y: 240 }]) {
    assert.notEqual(terrain.bushAt(corner), undefined, `the corner (${corner.x}, ${corner.y})`)
  }
  for (const out of [{ x: 99.9, y: 220 }, { x: 150.1, y: 220 }, { x: 125, y: 199.9 }, { x: 125, y: 240.1 }, { x: 0, y: 0 }]) {
    assert.equal(terrain.bushAt(out), undefined, `(${out.x}, ${out.y})`)
  }
  assert.equal(Terrain.plain().bushAt({ x: 125, y: 220 }), undefined, 'the plain arena has none')
})

test('separate bushes are different bushes, and bushes that overlap or touch, even through others, are one', () => {
  // `a` and `b` overlap, `b` touches `c` along an edge and `a` does not reach `c`; `far` is alone.
  const a = rect(100, 100, 60, 60)
  const b = rect(140, 140, 60, 60)
  const c = rect(200, 140, 60, 60)
  const far = rect(600, 600, 60, 60)
  const terrain = new Terrain(ARENA, [], undefined, [far, c, a, b])
  const inA = terrain.bushAt({ x: 110, y: 110 })
  const inB = terrain.bushAt({ x: 190, y: 190 })
  const inC = terrain.bushAt({ x: 250, y: 150 })
  const inFar = terrain.bushAt({ x: 630, y: 630 })
  assert.ok(inA !== undefined && inB !== undefined && inC !== undefined && inFar !== undefined)
  assert.equal(inA, inB, 'overlapping')
  assert.equal(inB, inC, 'touching, and so a and c, which do not touch, are one through b')
  assert.notEqual(inFar, inA, 'and the one on its own is another')
})

test('a bush that bridges two bushes which are apart makes the three one, even when it is the last of them', () => {
  // `left` and `right` are apart; `bridge` is lower than both, so it comes last, and overlaps each of them.
  const left = rect(100, 100, 60, 60)
  const right = rect(260, 100, 60, 60)
  const bridge = rect(140, 140, 140, 40)
  const terrain = new Terrain(ARENA, [], undefined, [left, right, bridge])
  const inLeft = terrain.bushAt({ x: 110, y: 110 })
  assert.notEqual(inLeft, undefined)
  assert.equal(terrain.bushAt({ x: 310, y: 110 }), inLeft, 'the right one')
  assert.equal(terrain.bushAt({ x: 200, y: 170 }), inLeft, 'and the bridge')
})

test('which bush is which does not depend on the order the map listed them in', () => {
  const list = [rect(100, 100, 60, 60), rect(140, 140, 60, 60), rect(600, 600, 60, 60), rect(900, 100, 60, 60)]
  const points = [{ x: 110, y: 110 }, { x: 190, y: 190 }, { x: 630, y: 630 }, { x: 930, y: 130 }]
  const forwards = new Terrain(ARENA, [], undefined, list)
  const backwards = new Terrain(ARENA, [], undefined, [...list].reverse())
  assert.deepEqual(forwards.toData(), backwards.toData())
  assert.deepEqual(points.map((point) => forwards.bushAt(point)), points.map((point) => backwards.bushAt(point)))
})

test('a bush stops nothing: a champion walks and stands in it, and its place is not a wall', () => {
  const terrain = new Terrain(ARENA, [], undefined, [rect(500, 500, 200, 200)])
  const inside = { x: 600, y: 600 }
  assert.deepEqual(terrain.resolve(inside, 20), inside)
  assert.deepEqual(terrain.path({ x: 400, y: 600 }, { x: 800, y: 600 }, 20), [{ x: 800, y: 600 }])
  assert.equal(terrain.walls.length, 0)
})

test('the ground sent in a snapshot has its bushes, and one without any is sent as it was', () => {
  const bushes = [rect(100, 100, 60, 60), rect(600, 600, 80, 40)]
  const terrain = new Terrain(ARENA, [rect(900, 0, 40, 300)], undefined, bushes)
  const data = terrain.toData()
  assert.deepEqual(data.bushes, bushes.map((bush) => [bush.x, bush.y, bush.width, bush.height]))
  const copy = Terrain.fromData(data)
  assert.deepEqual(copy.bushes, terrain.bushes)
  assert.equal(copy.bushAt({ x: 130, y: 130 }), terrain.bushAt({ x: 130, y: 130 }))
  assert.equal(copy.sameAs(data), true)
  assert.equal('bushes' in new Terrain(ARENA, [rect(900, 0, 40, 300)]).toData(), false, 'no bushes, no key')
})

test('terrain is the same only if its bushes are', () => {
  const terrain = new Terrain(ARENA, [], undefined, [rect(100, 100, 60, 60)])
  const data = terrain.toData()
  const changed = (bushes: Array<[number, number, number, number]> | undefined): boolean => terrain.sameAs({ ...data, bushes })
  assert.equal(changed([[100, 100, 60, 60]]), true)
  assert.equal(changed([[101, 100, 60, 60]]), false, 'moved')
  assert.equal(changed([[100, 100, 60, 61]]), false, 'resized')
  assert.equal(changed(undefined), false, 'taken away')
  assert.equal(changed([[100, 100, 60, 60], [300, 300, 10, 10]]), false, 'added to')
  assert.equal(new Terrain(ARENA).sameAs({ ...data, bushes: [[100, 100, 60, 60]] }), false, 'and one with none is not one with some')
  assert.equal(new Terrain(ARENA).sameAs({ width: ARENA.width, height: ARENA.height, walls: [] }), true, 'a snapshot from before there were bushes is a ground with none')
})

test('a snapshot brings the bushes to a client, which a snapshot can be checked for', () => {
  const server = new Simulator(new Terrain(ARENA, [], undefined, [rect(100, 100, 60, 60)]))
  server.addPlayer(1, 'player-1', 'One', { x: 500, y: 500 }, brawler)
  server.advanceTo(10)
  const snapshot = JSON.parse(JSON.stringify(server.snapshot()))
  assert.equal(GameSnapshotSchema.safeParse(snapshot).success, true, 'it is a snapshot the page accepts')
  const client = new Simulator()
  client.replaceFromSnapshot(snapshot)
  assert.deepEqual(client.terrain.toData(), server.terrain.toData())
  assert.notEqual(client.terrain.bushAt({ x: 130, y: 130 }), undefined)
  assert.equal(GameSnapshotSchema.safeParse({ ...snapshot, terrain: { ...snapshot.terrain, bushes: [[1, 2, 0, 5]] } }).success, false, 'but not a bush with no size')
})

// ---------------------------------------------------------------------------- what the page shows

// The page's light is a square here, as in tests/team-vision.test.ts, so these are about bushes and not about how a system works out what is seen.
const LIT = rect(0, 0, 800, 800)
const mask: VisionMask = { kind: 'cells', cell: 10, cols: 2, rows: 2, data: new Uint8Array([1, 0, 0, 1]), revision: 1 }
const square: VisionSystem = {
  name: 'square',
  see: () => ({
    mask,
    canSee: (point) => point.x >= LIT.x && point.y >= LIT.y && point.x < LIT.x + LIT.width && point.y < LIT.y + LIT.height,
  }),
}

// Two bushes well inside the light: `HERE` (two rectangles that overlap, so it is one bush), and `THERE`, which is apart from it.
const HERE = [rect(200, 200, 100, 100), rect(280, 260, 100, 100)]
const THERE = rect(500, 200, 100, 100)
const ground = new Terrain(ARENA, [], undefined, [...HERE, THERE])
const IN_HERE = { x: 250, y: 250 }
const IN_HERE_TOO = { x: 350, y: 340 }
const IN_THERE = { x: 550, y: 250 }
const OPEN = { x: 100, y: 500 }

let nextId = 1
function character(team: number, at: { x: number; y: number }, extra: Partial<RenderedCharacter> = {}): RenderedCharacter {
  return { id: nextId++, team, position: { ...at }, dead: false, invisible: false, champion: { radius: 20 }, ...extra } as unknown as RenderedCharacter
}
const ids = (list: ReadonlyArray<{ id: number }>): number[] => list.map((item) => item.id)

// The page's team vision, for team 1, looking at these characters.
function looking(...characters: RenderedCharacter[]): TeamVision {
  const vision = new TeamVision(square, ground)
  vision.update(characters, 1)
  return vision
}

test('an enemy in a bush is not seen, though it is in the light, and one beside it is', () => {
  const me = character(1, OPEN)
  const hidden = character(2, IN_HERE)
  // Its body is over the bush's edge (its radius is 20) and its middle is out of it.
  const beside = character(2, { x: HERE[0].x - 5, y: 250 })
  const vision = looking(me, hidden, beside)
  assert.equal(vision.isVisible(hidden), false)
  assert.equal(vision.isVisible(beside), true, 'it is the middle that is in a bush or not')
  assert.deepEqual(ids(vision.visibleCharacters([me, hidden, beside])), [me.id, beside.id])
  assert.deepEqual(ids(vision.hiddenCharacters([me, hidden, beside])), [hidden.id], 'it is handed on to be kept, as what is in the dark is')
})

test('what is in a bush is seen by the team once one of its champions is in the same bush, and not before or after', () => {
  const me = character(1, OPEN)
  const enemy = character(2, IN_HERE)
  const vision = looking(me, enemy)
  assert.equal(vision.isVisible(enemy), false)

  me.position = { ...IN_HERE_TOO }
  vision.update([me, enemy], 1)
  assert.equal(vision.isVisible(enemy), true, 'it is in the same bush (the other rectangle of it)')

  me.position = { ...OPEN }
  vision.update([me, enemy], 1)
  assert.equal(vision.isVisible(enemy), false, 'and hidden again when the champion has left')
})

test('a champion in another bush does not show what is in this one, and nor does one that is dead, an enemy, or a monster', () => {
  const enemy = character(2, IN_HERE)
  const ally = (at: { x: number; y: number }, extra: Partial<RenderedCharacter> = {}) => character(1, at, extra)
  const cases: Array<[string, RenderedCharacter[]]> = [
    ['an ally in the other bush', [ally(IN_THERE), ally(OPEN)]],
    ['a dead ally in this one', [ally(IN_HERE_TOO, { dead: true }), ally(OPEN)]],
    ['another enemy in this one', [character(3, IN_HERE_TOO), ally(OPEN)]],
    ['a monster in this one', [character(GAME_MONSTER_TEAM, IN_HERE_TOO, { monster: {} as RenderedCharacter['monster'] }), ally(OPEN)]],
  ]
  for (const [name, others] of cases) {
    const vision = looking(...others, enemy)
    assert.equal(vision.isVisible(enemy), false, name)
  }
})

test('a bush is entered by the middle of a champion, and the team\'s own are always drawn', () => {
  const enemy = character(2, IN_HERE)
  // A champion whose body is in the bush and whose middle is not does not see into it.
  const edge = character(1, { x: HERE[0].x - 5, y: 250 })
  assert.equal(looking(edge, enemy).isVisible(enemy), false)
  const inside = character(1, { x: HERE[0].x, y: 250 })
  assert.equal(looking(inside, enemy).isVisible(enemy), true, 'the edge of the bush is in it')
  const alone = character(1, IN_THERE)
  assert.equal(looking(alone).isVisible(alone), true, 'and one in a bush by itself is drawn')
})

test('a monster in a bush is not seen either, and is seen from inside it', () => {
  const monster = character(GAME_MONSTER_TEAM, IN_THERE, { monster: {} as RenderedCharacter['monster'] })
  assert.equal(looking(character(1, OPEN), monster).isVisible(monster), false)
  assert.equal(looking(character(1, { x: 520, y: 220 }), monster).isVisible(monster), true)
})

test('a turret or a core is not hidden by a bush, as it is where it always is', () => {
  const turret = character(2, IN_HERE, { turret: { tier: 1, visionRange: 640 } as RenderedCharacter['turret'] })
  assert.equal(looking(character(1, OPEN), turret).isVisible(turret), true)
})

test('what is invisible stays unseen even from inside the bush it is in', () => {
  const ghost = character(2, IN_HERE, { invisible: true })
  assert.equal(looking(character(1, IN_HERE_TOO), ghost).isVisible(ghost), false)
})

test('a bush hides bodies and not shots: an enemy\'s shot over one is drawn as it is anywhere in the light', () => {
  const enemy = character(2, OPEN)
  const vision = looking(character(1, { x: 100, y: 100 }), enemy)
  const shot = { ownerId: enemy.id, position: { ...IN_HERE }, radius: 10 } as unknown as RenderedEntity
  assert.deepEqual(vision.visibleEntities([shot]), [shot])
})

test('everything is shown, bushes or not, when the page shows everything', () => {
  const me = character(1, OPEN)
  const enemy = character(2, IN_HERE)
  const vision = new TeamVision(square, ground)
  vision.update([me, enemy], 1, { reveal: true })
  assert.equal(vision.isVisible(enemy), true, 'in the debug view')
  vision.update([character(1, OPEN, { dead: true }), enemy], 1)
  assert.equal(vision.isVisible(enemy), true, 'while the whole team is dead')
  vision.update([me, enemy], undefined)
  assert.equal(vision.isVisible(enemy), true, 'before there is a team')
  const off = new TeamVision(undefined, ground)
  off.update([me, enemy], 1)
  assert.equal(off.isVisible(enemy), true, 'and with no vision at all')
})

test('a team\'s vision is made with the ground\'s bushes when it has some, and none when it has not', () => {
  const state = new ClientGameState()
  state.simulator.reset(ground)
  const me = character(1, OPEN)
  const enemy = character(2, IN_HERE)
  assert.ok(Math.hypot(IN_HERE.x - OPEN.x, IN_HERE.y - OPEN.y) < GAME_VISION_RANGE, 'the enemy is in sight of the champion, so only a bush can hide it')
  const withBushes = createTeamVision(state.getTerrain())
  withBushes.update([me, enemy], 1)
  assert.equal(withBushes.isVisible(enemy), false)
  // The size and walls alone, as the tests of the vision systems give, is a ground with no bushes.
  const plain = createTeamVision({ width: ARENA.width, height: ARENA.height, walls: [] })
  plain.update([me, enemy], 1)
  assert.equal(plain.isVisible(enemy), true)
})

// ---------------------------------------------------------------------------- with a real game

const grunt = defineMonster({
  id: 't-bush-grunt',
  name: 'Bush Grunt',
  base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300 },
})

// A scene laid out in the game's own vision range, so it means the same whatever that is set to. One bush, `R` across a little under half of it. Ann (team 1)
// stands outside it, well within a range of its middle where Bob (team 2) and a grunt stand; Cat, Ann's teammate, comes to stand in it.
const R = GAME_VISION_RANGE
const BUSH = rect(1000, 600, 0.4 * R, 0.4 * R)
const IN = { x: BUSH.x + BUSH.width / 2, y: BUSH.y + BUSH.height / 2 }
const BOB_AT = { x: IN.x - 0.05 * R, y: IN.y }
const GRUNT_AT = { x: IN.x + 0.05 * R, y: IN.y }
const ANN_AT = { x: BUSH.x - 0.4 * R, y: IN.y }
const CAT_AT = { x: BUSH.x + 0.05 * R, y: BUSH.y + 0.05 * R }

function game(): ClientGameState {
  const state = new ClientGameState()
  state.simulator.reset(new Terrain(ARENA, [], undefined, [BUSH]))
  state.simulator.addMonster(10, grunt, GRUNT_AT)
  state.simulator.addPlayer(1, 'p1', 'Ann', ANN_AT, brawler, 1)
  state.simulator.addPlayer(2, 'p2', 'Bob', BOB_AT, brawler, 2)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  return state
}

test('what is in a bush cannot be clicked on, aimed at or picked by Space, until a teammate is in it', () => {
  const state = game()
  const vision = createTeamVision(state.getTerrain())
  state.setSight((each) => vision.isVisible(each))
  const look = (): void => vision.update(state.getCharacters(0), state.getLocalTeam())

  look()
  const distanceToBob = Math.hypot(BOB_AT.x - ANN_AT.x, BOB_AT.y - ANN_AT.y)
  assert.ok(distanceToBob < R, 'Bob is within Ann\'s sight, so only the bush hides him')
  assert.deepEqual(ids(vision.visibleCharacters(state.getCharacters(0))), [1], 'Ann sees herself, and neither of them')
  assert.equal(state.getEnemyNear(BOB_AT, 0), undefined, 'a click on Bob')
  assert.equal(state.getEnemyNear(GRUNT_AT, 0), undefined, 'and on the monster')
  assert.equal(state.getCharacterNear(BOB_AT, 0), undefined, 'inspecting him')
  assert.equal(state.getClosestEnemy(BOB_AT, 0), undefined, 'and Space')

  // Cat joins her in the light, in the bush.
  state.simulator.addPlayer(3, 'p3', 'Cat', CAT_AT, brawler, 1)
  state.simulator.advanceTo(4)
  look()
  assert.deepEqual(ids(vision.visibleCharacters(state.getCharacters(0))).sort(), [1, 2, 3, 10].sort(), 'the team is in the bush, so it sees what is')
  assert.equal(state.getEnemyNear(BOB_AT, 0)?.id, 2)
  assert.equal(state.getEnemyNear(GRUNT_AT, 0)?.id, 10)
  assert.equal(state.getClosestEnemy(BOB_AT, 0)?.id, 2)
})

test('an enemy beside the bush, with the same light, can be picked: it is the bush that hides', () => {
  const state = game()
  state.simulator.addPlayer(4, 'p4', 'Dee', { x: BUSH.x - 0.1 * R, y: IN.y }, brawler, 2)
  state.simulator.advanceTo(4)
  const vision = createTeamVision(state.getTerrain())
  state.setSight((each) => vision.isVisible(each))
  vision.update(state.getCharacters(0), state.getLocalTeam())
  assert.equal(state.getEnemyNear({ x: BUSH.x - 0.1 * R, y: IN.y }, 0)?.id, 4)
})

// ---------------------------------------------------------------------------- how a bush is drawn

type Instruction = { action: string; data: { style: { color: number; alpha: number } } }
const instructionsOf = (view: Container): Instruction[] =>
  ((view.children[0] as Graphics | undefined)?.context.instructions ?? []) as unknown as Instruction[]
const actions = (layer: BushAreaLayer): string[] => instructionsOf(layer.view).map((instruction) => instruction.action)

test('a bush is marked with a green box you can see through, stronger than a shop\'s tint, with a line round its edge', () => {
  const [red, green, blue] = [1, 3, 5].map((start) => parseInt(BUSH_COLOR.slice(start, start + 2), 16))
  assert.ok(green > red && green > blue, `${BUSH_COLOR} is green`)
  assert.ok(BUSH_FILL_ALPHA > 0 && BUSH_FILL_ALPHA < 1, 'see-through, so the ground and what stands in it show')
  assert.ok(BUSH_FILL_ALPHA > SHOP_AREA_FILL_ALPHA, 'and not a faint tint like a shop\'s, which is a healing area')
  assert.ok(BUSH_EDGE_ALPHA > BUSH_FILL_ALPHA)
  const layer = new BushAreaLayer()
  layer.update([rect(10, 20, 30, 40)])
  const [fill, stroke] = instructionsOf(layer.view)
  assert.deepEqual([fill.action, stroke.action], ['fill', 'stroke'])
  assert.equal(fill.data.style.color, new Color(BUSH_COLOR).toNumber())
  assert.equal(fill.data.style.alpha, BUSH_FILL_ALPHA)
  assert.equal(stroke.data.style.color, new Color(BUSH_COLOR).toNumber())
  assert.equal(stroke.data.style.alpha, BUSH_EDGE_ALPHA)
})

test('the layer fills and edges each bush, draws nothing for none, and draws again only when it is given others', () => {
  const layer = new BushAreaLayer()
  const bushes = [rect(0, 0, 10, 10), rect(50, 50, 10, 10)]
  layer.update(bushes)
  assert.deepEqual(actions(layer), ['fill', 'stroke', 'fill', 'stroke'])
  bushes.push(rect(100, 100, 10, 10))
  layer.update(bushes)
  assert.equal(actions(layer).length, 4, 'the same array again is not drawn again')
  layer.update([rect(0, 0, 10, 10)])
  assert.deepEqual(actions(layer), ['fill', 'stroke'])
  layer.update([])
  assert.deepEqual(actions(layer), [])
})

test('the world draws the bushes it is given over the champions\' layer, and none when it is given none', () => {
  const world = new WorldRenderer({ map: { view: new Container() }, spriteSets: new Map() })
  const frame = { now: 0, characters: [], entities: [], localCharacterId: undefined, attackMarkers: [] }
  const boxes = (): Container[] => world.scene.children.filter((child): child is Container =>
    child instanceof Container && instructionsOf(child).some((each) => each.action === 'stroke' && each.data.style.color === new Color(BUSH_COLOR).toNumber()))
  world.update(frame)
  assert.equal(boxes().length, 0, 'none to begin with')
  world.update({ ...frame, bushes: ground.bushes })
  const [box] = boxes()
  assert.ok(box, 'a layer with the bushes in it')
  assert.equal(instructionsOf(box).filter((each) => each.action === 'fill').length, ground.bushes.length, 'a box for each')
  const order = world.scene.children
  const depth = order.findIndex((child) => child instanceof RenderLayer)
  assert.ok(depth >= 0 && order.indexOf(box) > depth, 'over the champions, which are drawn in the depth layer')
  world.update({ ...frame, bushes: [] })
  assert.equal(instructionsOf(box).length, 0, 'and taken away with them')
})

// ---------------------------------------------------------------------------- the competitive map

const FILE = JSON.parse(readFileSync(new URL('../res/maps/competetive.tmj', import.meta.url), 'utf-8'))
const MAP = parseTiledMap(FILE)
const LAYOUT = readMapLayout(MAP)

test('the competitive map\'s bushes are the ones its file has in the arena, read as rectangles of the ground', () => {
  const objects = flattenLayers(MAP.layers).flatMap(({ layer }) => (layer.type === 'objectgroup' ? layer.objects : []))
  const arena = objects.find((object) => (object.class ?? object.type) === 'arena')
  assert.ok(arena, 'it has an arena')
  const inArena = objects
    .filter((object) => (object.class ?? object.type) === 'bush')
    .filter((object) =>
      object.x < arena.x + (arena.width ?? 0) && object.x + (object.width ?? 0) > arena.x
      && object.y < arena.y + (arena.height ?? 0) && object.y + (object.height ?? 0) > arena.y)
  // However many the map has (its Bushes layer can be empty while it is laid out), the game reads that many.
  assert.equal(LAYOUT.terrain.bushes.length, inArena.length)
  for (const bush of LAYOUT.terrain.bushes) {
    assert.ok(bush.width > 0 && bush.height > 0)
    assert.notEqual(LAYOUT.terrain.bushAt({ x: bush.x + bush.width / 2, y: bush.y + bush.height / 2 }), undefined)
  }
})

test('on the competitive map a champion in a bush is hidden from the open, with the game\'s own light, and seen from inside it', (t) => {
  const terrain = LAYOUT.terrain
  // Bushes on ground made for the test are above; this is the map's own, so there is nothing to see until it has some.
  if (terrain.bushes.length === 0) {
    t.skip('the competitive map has no bushes yet')
    return
  }
  const system = createShadowcastVision(terrain)
  const tried: Rect[] = []
  for (const bush of terrain.bushes) {
    const middle = { x: bush.x + bush.width / 2, y: bush.y + bush.height / 2 }
    const enemy = character(2, middle)
    // A place beside the bush, in the open and in the light of the middle of it: it is not every bush that has one on each side.
    const watcher = [
      { x: middle.x, y: bush.y - 40 },
      { x: middle.x, y: bush.y + bush.height + 40 },
      { x: bush.x - 40, y: middle.y },
      { x: bush.x + bush.width + 40, y: middle.y },
    ].find((place) => {
      if (terrain.bushAt(place) !== undefined || terrain.resolve(place, 20).x !== place.x || terrain.resolve(place, 20).y !== place.y) return false
      const open = new TeamVision(system)
      open.update([character(1, place), enemy], 1)
      return open.isVisible(enemy)
    })
    if (!watcher) continue
    tried.push(bush)
    const ally = character(1, watcher)
    const vision = new TeamVision(system, terrain)
    vision.update([ally, enemy], 1)
    assert.equal(vision.isVisible(enemy), false, `the bush at (${bush.x}, ${bush.y}) hides it, though without bushes it is seen`)
    ally.position = { x: middle.x + 1, y: middle.y }
    vision.update([ally, enemy], 1)
    assert.equal(vision.isVisible(enemy), true, 'and it is seen from inside')
  }
  assert.ok(tried.length > 0, 'at least one of the map\'s bushes has open ground beside it to look from')
})
