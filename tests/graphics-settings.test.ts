import assert from 'node:assert/strict'
import test from 'node:test'
import { Container, Graphics, Text } from 'pixi.js'
import { ClientGameState, type RenderedCharacter } from '../apps/client/src/game-state.ts'
import { CharacterLayer, HEALTH_BAR_HEIGHT, HEALTH_BAR_WIDTH } from '../apps/client/src/render/character-layer.ts'
import { DEFAULT_EFFECTS, EFFECT_KEYS, type EffectKey } from '../apps/client/src/render/effect-settings.ts'
import { IndicatorLayer } from '../apps/client/src/render/indicator-layer.ts'
import { LEVEL_BADGE_GAP, LEVEL_BADGE_RADIUS, layoutLevelBadge } from '../apps/client/src/render/level-badge.ts'
import { ShopAreaLayer } from '../apps/client/src/render/shop-area.ts'
import { TurretRangeLayer } from '../apps/client/src/render/turret-range.ts'
import { WorldRenderer } from '../apps/client/src/render/world-renderer.ts'
import { levelForXp, type ShopZone } from '../packages/shared/src/index.ts'
import { brawler, defineMonster, defineTurret, economyClient, killAt } from './fixtures.ts'

// What a player can turn off in the graphics menu (the effects over the ground), and the level shown next to each player. The turret, the monster and the
// players in these are the tests' own; how far a turret shoots and what a kill pays are read from them.

const post = defineTurret(78, { base: { maxHp: 2000, attackDamage: 50, attackSpeed: 1 }, radius: 30, attackRange: 400, attackWindup: 0 })
const bounty = defineMonster({
  id: 't-gs-bounty',
  name: 'Bounty',
  base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 0,
  radius: 20,
  attackRange: 10,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300 },
  reward: { gold: 10, xp: 1000, shards: 0 },
})
const SHOP: ShopZone = { team: 1, x: 0, y: 0, width: 300, height: 300 }

// Ann (1, team 1) stands where she is put, with a turret (10, team 2) in the same game, as a page would be given them.
function characters(): RenderedCharacter[] {
  const state = economyClient()
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 600, y: 700 }, brawler, 1)
  state.simulator.addTurret(10, post, { x: 1200, y: 700 }, 2)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  return state.getCharacters(0)
}
const find = (list: readonly RenderedCharacter[], id: number): RenderedCharacter => list.find((character) => character.id === id) as RenderedCharacter
const drawn = (graphics: unknown): number => (graphics as Graphics).context.instructions.length

// ---------------------------------------------------------------------------- the level badge

test('a level badge sits at the left end of the health bar, a gap off its end and in line with its middle, and says the level as a whole number', () => {
  const bar = { width: 84, top: -60, height: 9 }
  const badge = layoutLevelBadge(5, bar)
  assert.ok(badge)
  assert.equal(badge.x + badge.radius + LEVEL_BADGE_GAP, -bar.width / 2, 'the gap between the badge and the bar')
  assert.equal(badge.y, bar.top + bar.height / 2, 'in line with the middle of the bar')
  assert.equal(badge.radius, LEVEL_BADGE_RADIUS)
  assert.equal(badge.text, '5')
  assert.equal(layoutLevelBadge(7.9, bar)?.text, '7')
  assert.equal(layoutLevelBadge(0, bar)?.text, '1', 'no one is below the first level')
  assert.equal(layoutLevelBadge(undefined, bar), undefined, 'nothing that has no level has a badge')
  assert.equal(layoutLevelBadge(Number.NaN, bar), undefined)
})

test('in a game with levels each player has theirs, at the level the experience makes; a monster and a turret have none', () => {
  const state = economyClient()
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 600, y: 700 }, brawler, 1)
  state.simulator.addMonster(2, bounty, { x: 700, y: 700 })
  state.simulator.addTurret(10, post, { x: 1200, y: 700 }, 2)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  const start = state.getCharacters(0)
  assert.equal(find(start, 1).level, 1, 'everyone starts at the first level')
  assert.equal(find(start, 2).level, undefined, 'a monster has no level to show')
  assert.equal(find(start, 10).level, undefined, 'and a turret has none')

  // Killing the monster pays experience, so the player who did it gains the level that experience makes.
  killAt(state.simulator, 2, 5)
  state.simulator.advanceTo(30)
  const after = state.getCharacters(0)
  assert.equal(find(after, 1002).level, levelForXp(bounty.reward.xp), 'the killer is the level its experience makes')
  assert.ok((find(after, 1002).level ?? 0) > 1, 'which is more than the first, so this is not just the starting level')
  assert.equal(find(after, 1).level, 1, 'and Ann, who did nothing, is as she was')
})

test('in a game with no levels there is none to show', () => {
  const state = new ClientGameState()
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 600, y: 700 }, brawler, 1)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  assert.equal(state.hasEconomy, false)
  assert.equal(find(state.getCharacters(0), 1).level, undefined)
})

// What the layer draws of one character's level badge: whether it is shown, what it says, and where it is.
function badgeOf(layer: CharacterLayer): { visible: boolean; text: string; x: number; y: number } {
  const overlay = layer.overlay.children[0] as Container
  const badge = overlay.children.find((child) => child.constructor === Container) as Container
  const text = badge.children.find((child) => child instanceof Text) as Text
  return { visible: badge.visible, text: text.text, x: badge.position.x, y: badge.position.y }
}

test('the layer shows a player\'s level on a badge at the end of its health bar, and changes it with the level', () => {
  const everyone = characters()
  const ann = find(everyone, 1)
  const layer = new CharacterLayer(new Map())
  layer.update([ann], 1, undefined, 0)
  const shown = badgeOf(layer)
  assert.equal(shown.visible, true)
  assert.equal(shown.text, String(ann.level))
  const expected = layoutLevelBadge(ann.level, { width: HEALTH_BAR_WIDTH, top: shown.y - HEALTH_BAR_HEIGHT / 2, height: HEALTH_BAR_HEIGHT })
  assert.deepEqual([shown.x, shown.y], [expected?.x, expected?.y], 'where the layout says, from the bar')
  assert.ok(shown.x < -HEALTH_BAR_WIDTH / 2, 'to the left of the bar, and not over it')

  layer.update([{ ...ann, level: 9 }], 1, undefined, 1)
  assert.equal(badgeOf(layer).text, '9', 'it follows the level')
})

test('there is no badge on a champion that has no level, nor on a dead one, whose health bar is gone too', () => {
  const everyone = characters()
  const ann = find(everyone, 1)
  const without = new CharacterLayer(new Map())
  without.update([{ ...ann, level: undefined }], 1, undefined, 0)
  assert.equal(badgeOf(without).visible, false, 'no level, no badge')

  const dead = new CharacterLayer(new Map())
  dead.update([{ ...ann, dead: true, deadForSeconds: 0 }], 1, undefined, 0)
  assert.equal(badgeOf(dead).visible, false, 'a dead player has no bar, and so no badge on it')
  dead.update([ann], 1, undefined, 1)
  assert.equal(badgeOf(dead).visible, true, 'and has it again when it is back')

  const turret = new CharacterLayer(new Map())
  turret.update([find(everyone, 10)], 1, undefined, 0)
  assert.equal(badgeOf(turret).visible, false, 'a turret has none')
})

// ---------------------------------------------------------------------------- the effects, one layer at a time

test('the shop tint is drawn when it is given shops, and turning it off hides it without losing it', () => {
  const layer = new ShopAreaLayer()
  const zones = [SHOP]
  layer.update(zones)
  assert.equal(layer.view.visible, true, 'on unless it is turned off')
  assert.ok(drawn(layer.view.children[0]) > 0, 'a tint for the shop')
  layer.update(zones, false)
  assert.equal(layer.view.visible, false, 'turned off')
  layer.update(zones, true)
  assert.equal(layer.view.visible, true, 'and back on')
  assert.ok(drawn(layer.view.children[0]) > 0, 'with nothing to draw again')
  const off = new ShopAreaLayer()
  off.update([SHOP], false)
  assert.equal(off.view.visible, false, 'one that is off from the start is hidden from the start')
})

test('the turret rings are drawn for each turret that stands, and turning them off hides them, and they are drawn again when it is back', () => {
  const everyone = characters()
  const layer = new TurretRangeLayer()
  layer.update(everyone)
  assert.equal(layer.view.visible, true)
  assert.ok(drawn(layer.view.children[0]) > 0, 'a ring for the turret')
  layer.update(everyone, false)
  assert.equal(layer.view.visible, false, 'turned off')
  layer.update(everyone, true)
  assert.deepEqual([layer.view.visible, drawn(layer.view.children[0]) > 0], [true, true], 'and back')

  const off = new TurretRangeLayer()
  off.update(everyone, false)
  assert.equal(drawn(off.view.children[0]), 0, 'nothing is drawn while it is off')
  assert.equal(off.view.visible, false)
})

test('the ring round your own champion is drawn unless turned off, and is not drawn at all with no champion to put it round', () => {
  const ann = find(characters(), 1)
  const ring = (layer: IndicatorLayer): Graphics => layer.view.children[0] as Graphics
  const local = { position: ann.position, attackRange: ann.attackRange }
  const layer = new IndicatorLayer()
  layer.update({ characters: [ann], local, attackMarkers: [] })
  assert.equal(ring(layer).visible, true, 'on unless it is turned off')
  layer.update({ characters: [ann], local, showAttackRange: true, attackMarkers: [] })
  assert.equal(ring(layer).visible, true)
  layer.update({ characters: [ann], local, showAttackRange: false, attackMarkers: [] })
  assert.equal(ring(layer).visible, false, 'turned off')
  layer.update({ characters: [ann], local, showAttackRange: true, attackMarkers: [] })
  assert.equal(ring(layer).visible, true, 'and back')
  layer.update({ characters: [ann], showAttackRange: true, attackMarkers: [] })
  assert.equal(ring(layer).visible, false, 'with no champion of yours there is nothing to put it round')
})

// ---------------------------------------------------------------------------- through the renderer

// Whether each thing in the scene is shown, so that what a change hides can be told from what it leaves.
function visibility(root: Container): Map<Container, boolean> {
  const found = new Map<Container, boolean>()
  const walk = (node: Container): void => {
    found.set(node, node.visible)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return found
}
const changedBetween = (before: Map<Container, boolean>, after: Map<Container, boolean>): Container[] =>
  [...after].filter(([node, shown]) => before.get(node) !== shown).map(([node]) => node)

test('each effect is on until the renderer is told otherwise, and turning one off hides one thing, a different thing for each, and nothing else', () => {
  const everyone = characters()
  const world = new WorldRenderer({ map: { view: new Container() }, spriteSets: new Map() })
  assert.deepEqual(world.effects, DEFAULT_EFFECTS, 'all on to begin with')
  const frame = (now: number) => ({
    now,
    characters: everyone,
    entities: [],
    localCharacterId: 1,
    attackMarkers: [],
    shops: [SHOP],
  })
  world.update(frame(0))
  const allOn = visibility(world.scene)
  const hidden = new Map<EffectKey, Container>()
  for (const effect of EFFECT_KEYS) {
    world.effects = { ...DEFAULT_EFFECTS, [effect]: false }
    world.update(frame(1))
    const changed = changedBetween(allOn, visibility(world.scene))
    assert.equal(changed.length, 1, `turning off ${effect} hides one thing, and not the rest: ${changed.length}`)
    assert.equal(changed[0].visible, false)
    hidden.set(effect, changed[0])
    // And back on, as it was.
    world.effects = { ...DEFAULT_EFFECTS }
    world.update(frame(2))
    assert.deepEqual(changedBetween(allOn, visibility(world.scene)), [], `${effect} is back`)
  }
  assert.equal(new Set(hidden.values()).size, EFFECT_KEYS.length, 'each effect hides its own')

  // All of them off at once hides all of them.
  world.effects = Object.fromEntries(EFFECT_KEYS.map((effect) => [effect, false])) as typeof DEFAULT_EFFECTS
  world.update(frame(3))
  assert.equal(changedBetween(allOn, visibility(world.scene)).length, EFFECT_KEYS.length)
})
