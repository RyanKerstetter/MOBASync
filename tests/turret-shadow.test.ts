import assert from 'node:assert/strict'
import test from 'node:test'
import { Color, Container, RenderLayer, type Graphics } from 'pixi.js'
import { ClientGameState, type RenderedCharacter } from '../apps/client/src/game-state.ts'
import {
  layoutTurretShadows,
  SHADOW_COLOR,
  SHADOW_DROP,
  SHADOW_HEIGHT,
  SHADOW_STEPS,
  SHADOW_WIDTH,
  TurretShadowLayer,
} from '../apps/client/src/render/turret-shadow.ts'
import { WorldRenderer } from '../apps/client/src/render/world-renderer.ts'
import { brawler, defineTurret } from './fixtures.ts'

// The shadow under a tower: where it is, how big, that a tower that is gone or out of sight has none, and that it lies on the ground under everything that stands on it.
// It is the page's, and not a rule of the game.

const post = defineTurret(85, {
  base: { maxHp: 2000, attackDamage: 50, attackSpeed: 1 },
  radius: 36,
  attackRange: 400,
  attackWindup: 0,
})
// A bigger body, and the core of a base (a turret as well, which is tier-protected unless a lower one stands).
const keep = defineTurret(86, {
  core: true,
  base: { maxHp: 2000, attackDamage: 50, attackSpeed: 1 },
  radius: 60,
  attackRange: 400,
  attackWindup: 0,
})

const AT = { x: 1000, y: 700 }
const KEEP_AT = { x: 1600, y: 900 }

// A game with a tower (10) and a core (11) of team 1, and Ann (1) of the same team, as the page reads them.
function frame(): RenderedCharacter[] {
  const state = new ClientGameState()
  state.simulator.addTurret(10, post, AT, 1)
  state.simulator.addTurret(11, keep, KEEP_AT, 1)
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 200, y: 200 }, brawler, 1)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  return state.getCharacters(0)
}
const character = (characters: readonly RenderedCharacter[], id: number): RenderedCharacter => characters.find((each) => each.id === id) as RenderedCharacter

// ---------------------------------------------------------------------------- where it is

test('a tower has a shadow on the ground at its foot, as wide as the tower and then some, and a good deal flatter than it is wide', () => {
  const characters = frame()
  const tower = character(characters, 10)
  const [shadow] = layoutTurretShadows([tower])
  const radius = tower.champion.radius
  assert.equal(shadow.x, AT.x, 'under the tower')
  assert.equal(shadow.y, AT.y + radius * SHADOW_DROP, 'and low on its ground, where the foot of the art is')
  assert.equal(shadow.rx, radius * SHADOW_WIDTH)
  assert.equal(shadow.ry, radius * SHADOW_HEIGHT)

  assert.ok(shadow.rx > radius, 'it shows out from under the tower on both sides, which are as wide as its body')
  assert.ok(shadow.y + shadow.ry > AT.y + radius, 'and out below the foot of it, which stands on the near edge of its ground')
  assert.ok(shadow.ry < shadow.rx, 'it lies flat on the ground')
})

test('a shadow is as big as the tower: a bigger body has a bigger one, wherever it is, and the core of a base has one too', () => {
  const characters = frame()
  const [small, big] = layoutTurretShadows([character(characters, 10), character(characters, 11)])
  assert.ok(character(characters, 11).turret?.core, 'the core is a turret of the core tier')
  assert.ok(big.rx > small.rx && big.ry > small.ry, 'the keep has the bigger shadow')
  assert.ok(Math.abs(big.rx / small.rx - keep.champion.radius / post.champion.radius) < 1e-9, 'in proportion to its body')
  assert.deepEqual([big.x, big.y], [KEEP_AT.x, KEEP_AT.y + keep.champion.radius * SHADOW_DROP], 'and under the middle of it')
  const moved = layoutTurretShadows([{ ...character(characters, 10), position: { x: 5, y: 6 } }])[0]
  assert.equal(moved.x, 5, 'wherever the tower is drawn')
})

test('a tower that is destroyed has no shadow, and nor has anything that is not a tower', () => {
  const characters = frame()
  assert.deepEqual(layoutTurretShadows([{ ...character(characters, 10), dead: true }]), [], 'it is not there')
  assert.deepEqual(layoutTurretShadows(characters.filter((each) => !each.turret)), [], 'a champion has none')
  assert.deepEqual(layoutTurretShadows([]), [])
  assert.equal(layoutTurretShadows(characters).length, 2, 'one for each of the two that stand')
})

// ---------------------------------------------------------------------------- how it is drawn

type Instruction = { action: string; data: { style: { color: number; alpha: number } } }
// What is drawn in a layer's graphics, or nothing for a container whose first child is not a drawing (the layer of the champions' bodies, say).
const instructionsOf = (view: Container): Instruction[] => ((view.children[0] as Graphics | undefined)?.context?.instructions ?? []) as unknown as Instruction[]

test('a shadow is soft and see-through: ellipses one inside the other in black, darkest in the middle, with the ground showing through', () => {
  const layer = new TurretShadowLayer()
  layer.update([character(frame(), 10)])
  const drawn = instructionsOf(layer.view)
  assert.deepEqual(drawn.map((each) => each.action), SHADOW_STEPS.map(() => 'fill'), 'one fill for each step, and no outline')
  for (const each of drawn) assert.equal(each.data.style.color, new Color(SHADOW_COLOR).toNumber(), 'black')
  assert.ok(SHADOW_STEPS.length > 1, 'more than one, so the edge fades')
  // How dark the middle is, where they all lie over one another: each lets through what the one over it does not take.
  const middle = 1 - SHADOW_STEPS.reduce((through, step) => through * (1 - step.alpha), 1)
  assert.ok(SHADOW_STEPS.every((step) => step.alpha > 0 && step.alpha < 1), 'each is see-through')
  assert.ok(middle > 0.3, `the middle is a shadow you can see (${middle} of black)`)
  assert.ok(middle < 0.7, `and no darker than ${middle} of black, so what is under it shows`)
  assert.ok(SHADOW_STEPS.every((step, index) => index === 0 || step.scale < SHADOW_STEPS[index - 1].scale), 'each is smaller than the one outside it')
  assert.equal(SHADOW_STEPS[0].scale, 1, 'and the outermost is the whole of the shadow')
})

test('the layer draws a shadow for each tower it is given, and clears when it is given none', () => {
  const layer = new TurretShadowLayer()
  const characters = frame()
  layer.update([character(characters, 10)])
  assert.equal(instructionsOf(layer.view).length, SHADOW_STEPS.length)
  layer.update([character(characters, 10), character(characters, 11)])
  assert.equal(instructionsOf(layer.view).length, SHADOW_STEPS.length * 2)
  layer.update(characters.filter((each) => !each.turret))
  assert.deepEqual(instructionsOf(layer.view), [], 'none for a frame with no tower')
})

// ---------------------------------------------------------------------------- in the world

// The shadow layer's container in the scene: the one whose graphics are filled with the shadow's black.
function shadowLayerOf(world: WorldRenderer): Container | undefined {
  const black = new Color(SHADOW_COLOR).toNumber()
  return world.scene.children.find((child): child is Container =>
    child instanceof Container && instructionsOf(child).some((each) => each.action === 'fill' && each.data.style.color === black))
}

test('the world draws the shadows of the towers in its frame and none for one it cannot see, on the ground under the champions and what they cast', () => {
  const ground = new Container()
  const world = new WorldRenderer({ map: { view: ground }, spriteSets: new Map() })
  const characters = frame()
  const tower = character(characters, 10)
  const base = { now: 0, entities: [], localCharacterId: 1, attackMarkers: [] }

  world.update({ ...base, characters: [] })
  assert.equal(shadowLayerOf(world), undefined, 'nothing to shadow with no tower')

  // A tower out of sight is not in the frame, and is only handed on as unseen: it is not drawn, nor is its shadow. The core is in sight, and has its own.
  world.update({ ...base, characters: characters.filter((each) => each.id !== 10), unseen: [tower] })
  assert.equal(instructionsOf(shadowLayerOf(world) as Container).length, SHADOW_STEPS.length, 'only the one that is in sight')

  world.update({ ...base, characters })
  const layer = shadowLayerOf(world)
  assert.ok(layer, 'a shadow layer once they are in sight')
  assert.equal(instructionsOf(layer).length, SHADOW_STEPS.length * 2, 'a shadow for each of the two')

  const order = world.scene.children
  const depth = order.findIndex((child) => child instanceof RenderLayer)
  assert.ok(depth >= 0 && order.indexOf(layer) < depth, 'under the champions, which are drawn in the depth layer')
  assert.ok(order.indexOf(layer) > order.indexOf(ground), 'and over the ground tiles of the map, which it lies on')
  // It is part of the ground, so what is drawn on the ground is drawn over it and never hidden by it.
  const parts = world as unknown as { entities: { ground: Container }; links: { view: Container }; turretRanges: { view: Container }; indicators: { view: Container } }
  for (const above of [parts.entities.ground, parts.links.view, parts.turretRanges.view, parts.indicators.view]) {
    assert.ok(order.indexOf(above) > order.indexOf(layer), 'under the telegraphs and fields, the link beam, the turret rings and the indicators')
  }

  world.update({ ...base, characters: [{ ...tower, dead: true }] })
  assert.equal(shadowLayerOf(world), undefined, 'and gone when the tower falls')
})
