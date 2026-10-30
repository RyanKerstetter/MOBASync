import assert from 'node:assert/strict'
import test from 'node:test'
import { Sprite, Texture, type Container, type Graphics } from 'pixi.js'
import { championSprites, type SpriteSet } from '../apps/client/src/champion-sprites.ts'
import { CharacterSprite, type LoadedSpriteSet } from '../apps/client/src/character-sprite.ts'
import { ClientGameState, type RenderedCharacter } from '../apps/client/src/game-state.ts'
import { CharacterLayer } from '../apps/client/src/render/character-layer.ts'
import { CORPSE_SECONDS, layoutCorpse } from '../apps/client/src/render/corpse.ts'
import { CORE_TIER, turretId } from '../packages/shared/src/index.ts'
import { brawler, defineTurret, economyClient } from './fixtures.ts'

// How a destroyed turret or core looks on the page: it plays the collapse of its sprite where it stood, loses its bars at once, and is gone for
// good a couple of seconds after it fell. A turret or core drawn from a sprite stands on nothing of its own (no disc in its team's colour). A building is the same whichever way it turns to shoot. The turret and the core in
// these are the tests', drawn from the game's own stone tower and keep (the sheets are not loaded, so every frame is a blank texture of its own).

const post = defineTurret(77, { base: { maxHp: 2000, attackDamage: 50, attackSpeed: 1 }, radius: 30, attackRange: 400, attackWindup: 0 })
const keep = defineTurret(76, { base: { maxHp: 2000, attackDamage: 50, attackSpeed: 1 }, radius: 40, attackRange: 400, attackWindup: 0, core: true })
const AT = { x: 1000, y: 700 }

// A loaded set with a different blank texture for every frame of every clip, so which frame is up can be told.
function loaded(set: SpriteSet): LoadedSpriteSet {
  const frames: LoadedSpriteSet['frames'] = {}
  for (const [key, clip] of Object.entries(set.clips) as Array<[keyof SpriteSet['clips'], NonNullable<SpriteSet['clips'][keyof SpriteSet['clips']]>]>) {
    frames[key] = [Array.from({ length: clip.frames }, () => new Texture())]
  }
  return { set, frames }
}

// Ann (1, team 1) is far from a turret (10) and a core (11) of team 2, the first two characters drawn after her.
function characters(): { ann: RenderedCharacter; turret: RenderedCharacter; core: RenderedCharacter } {
  const state = economyClient()
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 200, y: 200 }, brawler, 1)
  state.simulator.addTurret(10, post, AT, 2)
  state.simulator.addTurret(11, keep, { x: 1500, y: 900 }, 2)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  const all = state.getCharacters(0)
  const find = (id: number): RenderedCharacter => all.find((character) => character.id === id) as RenderedCharacter
  return { ann: find(1), turret: find(10), core: find(11) }
}
const fell = (character: RenderedCharacter, seconds: number): RenderedCharacter => ({ ...character, dead: true, deadForSeconds: seconds })

// What is drawn of the one structure the layer holds: its body, its bars, and how many shapes are drawn under its sprite (none, for a sprite).
function look(layer: CharacterLayer, structure: RenderedCharacter, ann: RenderedCharacter): { body: boolean; bars: boolean; underneath: number; texture: Texture } {
  layer.update([structure, ann], 1, undefined, 0)
  const node = layer.view.children[0] as Container
  return {
    body: node.visible,
    bars: layer.overlay.children[0].visible,
    underneath: (node.children[0] as Graphics).context.instructions.length,
    texture: (node.children.find((child) => child instanceof Sprite) as Sprite | undefined)?.texture as Texture,
  }
}

test('a destroyed structure has no bars, and is a corpse for a couple of seconds like a monster, and then gone for good', () => {
  const { turret, core } = characters()
  for (const structure of [turret, core]) {
    assert.deepEqual(layoutCorpse({ ...structure, dead: false }), { body: true, nameplate: true }, 'standing, it has both')
    assert.deepEqual(layoutCorpse(fell(structure, 0)), { body: true, nameplate: false }, 'the moment it falls the bars are gone and the body is there')
    assert.deepEqual(layoutCorpse(fell(structure, CORPSE_SECONDS - 0.01)), { body: true, nameplate: false })
    assert.deepEqual(layoutCorpse(fell(structure, CORPSE_SECONDS)), { body: false, nameplate: false }, 'and then it is gone')
    assert.deepEqual(layoutCorpse(fell(structure, 600)), { body: false, nameplate: false }, 'for good')
  }
})

test('a turret drawn from a sprite plays its collapse where it stood, loses its bars at once, and is gone after the corpse time', () => {
  const { ann, turret } = characters()
  const set = championSprites[turretId(1)]
  const tower = loaded(set)
  const layer = new CharacterLayer(new Map([[post.champion.id, tower]]))

  const alive = look(layer, turret, ann)
  assert.deepEqual([alive.body, alive.bars, alive.underneath], [true, true, 0], 'standing: its sprite and its bars, and nothing drawn under the sprite')
  assert.ok(tower.frames.idle?.[0].includes(alive.texture), 'it shows its idle')

  const falling = look(layer, fell(turret, 0.2), ann)
  assert.deepEqual([falling.body, falling.bars, falling.underneath], [true, false, 0], 'fallen: the body is still there, to collapse; the bars are not')
  assert.ok(tower.frames.dead?.[0].includes(falling.texture), 'and it shows its collapse')

  assert.equal(look(layer, fell(turret, CORPSE_SECONDS - 0.01), ann).body, true, 'it lies there until its time is up')
  const gone = look(layer, fell(turret, CORPSE_SECONDS), ann)
  assert.deepEqual([gone.body, gone.bars], [false, false], 'and then there is nothing')
  assert.equal(look(layer, fell(turret, 600), ann).body, false, 'for good')
})

test('a core is the same: its keep collapses where it stood and is then gone', () => {
  const { ann, core } = characters()
  const keepSprites = loaded(championSprites[turretId(CORE_TIER)])
  const layer = new CharacterLayer(new Map([[keep.champion.id, keepSprites]]))
  const standing = look(layer, core, ann)
  assert.deepEqual([standing.body, standing.bars, standing.underneath], [true, true, 0])
  const falling = look(layer, fell(core, 0.5), ann)
  assert.deepEqual([falling.body, falling.bars, falling.underneath], [true, false, 0])
  assert.ok(keepSprites.frames.dead?.[0].includes(falling.texture))
  assert.equal(look(layer, fell(core, CORPSE_SECONDS), ann).body, false)
})

test('a structure with no sprite to collapse is gone as it falls', () => {
  const { ann, turret, core } = characters()
  for (const structure of [turret, core]) {
    const layer = new CharacterLayer(new Map())
    const shapes = look(layer, structure, ann)
    assert.equal(shapes.body, true, 'standing, it is drawn as shapes')
    assert.ok(shapes.underneath > 0, 'which are what it is drawn from, in its team colour')
    const fallen = look(layer, fell(structure, 0), ann)
    assert.deepEqual([fallen.body, fallen.bars], [false, false], 'and it is gone the moment it falls')
  }
})

test('a dead champion is as it was: it keeps its body and its name, whatever a structure does when it falls', () => {
  const { ann } = characters()
  const layer = new CharacterLayer(new Map())
  layer.update([fell(ann, 600)], 1, undefined, 0)
  assert.deepEqual([layer.view.children[0].visible, layer.overlay.children[0].visible], [true, true], 'a dead champion keeps its body and name')
})

test('a building is drawn as it is whichever way it turns to shoot, where a figure drawn facing one way is flipped to face the other', () => {
  const set = championSprites[turretId(1)]
  const aimedLeft = { position: AT, dead: false, action: { kind: 'attack' as const, progress: 0.5, aimAt: { x: AT.x - 400, y: AT.y } }, now: 0 }
  const building = new CharacterSprite(loaded(set))
  building.update(aimedLeft)
  assert.ok(building.view.scale.x > 0, 'the tower is not mirrored')
  // The same sheets in a set that is not fixed are flipped, so the difference is the set's say and not the animator's.
  const { fixed: _fixed, ...figureSet } = set
  const figure = new CharacterSprite(loaded(figureSet as SpriteSet))
  figure.update(aimedLeft)
  assert.ok(figure.view.scale.x < 0, 'a figure is flipped to face what it shoots')
})
