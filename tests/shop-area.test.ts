import assert from 'node:assert/strict'
import test from 'node:test'
import type { Graphics } from 'pixi.js'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  layoutShopAreas,
  SHOP_AREA_COLOR,
  SHOP_AREA_EDGE_ALPHA,
  SHOP_AREA_EDGE_WIDTH,
  SHOP_AREA_FILL_ALPHA,
  ShopAreaLayer,
} from '../apps/client/src/render/shop-area.ts'
import { Terrain, type ShopZone } from '../packages/shared/src/index.ts'
import { ECONOMY_MODE } from './fixtures.ts'

// How the page shows the healing area a shop is (see shops.ts): the shop's rectangle on the ground, with a small see-through green tint over it.

const WEST: ShopZone = { team: 1, x: 0, y: 0, width: 700, height: 1440 }
const EAST: ShopZone = { team: 2, x: 2000, y: 600, width: 300, height: 300 }

const actions = (layer: ShopAreaLayer): string[] => (layer.view.children[0] as Graphics).context.instructions.map((instruction) => instruction.action)

test('every shop has an area to tint, where its rectangle is, for whichever team it belongs to', () => {
  assert.deepEqual(layoutShopAreas([WEST, EAST]), [
    { x: WEST.x, y: WEST.y, width: WEST.width, height: WEST.height },
    { x: EAST.x, y: EAST.y, width: EAST.width, height: EAST.height },
  ])
  assert.deepEqual(layoutShopAreas([]), [], 'a game with no shops has none')
})

test('a shop that heals nothing is not tinted as a healing area', () => {
  assert.deepEqual(layoutShopAreas([WEST, EAST], false), [])
  assert.equal(layoutShopAreas([WEST], true).length, 1)
})

test('the tint is a small green: green above the other colours, and see-through, with a fainter line round the edge', () => {
  const [red, green, blue] = [1, 3, 5].map((start) => parseInt(SHOP_AREA_COLOR.slice(start, start + 2), 16))
  assert.ok(green > red && green > blue, `${SHOP_AREA_COLOR} is green`)
  assert.ok(SHOP_AREA_FILL_ALPHA > 0 && SHOP_AREA_FILL_ALPHA <= 0.25, 'a small tint, that the ground shows through')
  assert.ok(SHOP_AREA_EDGE_ALPHA > 0 && SHOP_AREA_EDGE_ALPHA <= 0.5, 'and an edge that is faint')
  assert.ok(SHOP_AREA_EDGE_WIDTH > 0 && SHOP_AREA_EDGE_WIDTH <= 3, 'and thin')
})

test('the layer fills and edges each shop, draws nothing for none, and draws again only when it is given others', () => {
  const layer = new ShopAreaLayer()
  const zones = [WEST, EAST]
  layer.update(zones)
  assert.deepEqual(actions(layer), ['fill', 'stroke', 'fill', 'stroke'], 'a tint and an edge for each of two shops')
  // The same shops again are not drawn again: a zone added to the same array behind its back is not seen.
  zones.push({ ...WEST, team: 3 })
  layer.update(zones)
  assert.equal(actions(layer).length, 4)
  // Others are: one shop, then none.
  layer.update([EAST])
  assert.deepEqual(actions(layer), ['fill', 'stroke'])
  layer.update([])
  assert.deepEqual(actions(layer), [])
})

test('the page asks the game for its shops: those it was given, and none when it has none', () => {
  const state = new ClientGameState()
  assert.deepEqual(state.getShopZones(), [])
  state.simulator.reset(Terrain.plain(), ECONOMY_MODE, [WEST, EAST])
  assert.deepEqual(state.getShopZones(), [WEST, EAST])
  state.simulator.reset(Terrain.plain(), ECONOMY_MODE, [])
  assert.deepEqual(state.getShopZones(), [])
})
