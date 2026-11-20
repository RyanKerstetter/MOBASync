import assert from 'node:assert/strict'
import test from 'node:test'
import { Group } from 'three'
import { getChampion } from '../packages/shared/src/index.ts'
import { ENTITY_VISUALS } from '../apps/client/src/render3d/effects/entity-effects.ts'
import { HoundModel } from '../apps/client/src/render3d/models/hound.ts'
import { VisionShading } from '../apps/client/src/render3d/vision-shading.ts'
import { CharacterFx } from '../apps/client/src/render3d/character-fx.ts'

// The effects of the newer champions, and the Hellhound's model, made and played out with nothing to draw on: none of them throws, which would stop the whole world being
// drawn, and each one that outlives its entity comes to an end.

const noop = new Proxy({}, { get: () => () => noop }) as never
const emitter = { emit: () => {} }

function ctxAt(t: number, characters: Map<number, unknown>): never {
  return { t, dt: 1 / 60, fx: { glow: emitter, puff: emitter }, lights: { light: () => {} }, decals: noop, glowDecals: noop, characters, models: { modelOf: () => undefined, topOf: () => 70 } } as never
}

function character(id: number, championId: string, x: number, stacks: Record<string, number> = {}): unknown {
  return { id, champion: getChampion(championId), team: id, position: { x, y: 0 }, stacks, dead: false, totalShield: 0, statusKinds: [], casts: [] }
}

test('every new champion effect is made, plays out and ends', () => {
  const ids = ['rake-shot', 'rake-again-shot', 'rake-hit', 'rake-hit-bleed', 'rake-final-hit', 'howl-wave', 'blood-trail', 'tether-shot', 'spider-mine', 'mine-spider', 'mine-bite',
    'thrown-knife', 'recalled-knife', 'ground-knife', 'bladedash-burst', 'blood-shot', 'blood-pact', 'coagulate', 'blood-shards', 'volley-arrow', 'disengage-arrow', 'arrow-rain',
    'arrow-rain-impact', 'crystal-bolt', 'shard-burst', 'shatter-burst', 'dawn-beam', 'dawnstep-flash', 'smite-hit', 'smite-final', 'scan', 'steady-shot-1', 'steady-shot-10']
  const characters = new Map<number, unknown>([[1, character(1, 'sanguine', 0)], [2, character(2, 'swordsman', 200, { 'blood-pact': 1 })]])
  for (const id of ids) {
    const factory = ENTITY_VISUALS[id]
    assert.ok(factory, id)
    const parent = new Group()
    const entity = { id: `e:${id}`, defId: id, rootId: 'r', ownerId: 1, origin: { x: 0, y: 0 }, velocity: { x: 300, y: 0 }, startTick: 0, lifetimeTicks: 30, hitIds: [], position: { x: 100, y: 0 }, radius: 60, visual: 'flash', progress: 0, facing: { x: 1, y: 0 }, ...(id.includes('rake-') && id.endsWith('shot') ? { box: { halfLength: 12, halfWidth: 30 } } : {}), ...(id === 'howl-wave' ? { box: { halfLength: 130, halfWidth: 140 } } : {}) } as never
    const visual = factory(parent, entity, ctxAt(0, characters), undefined as never)
    for (let frame = 0; frame < 30; frame += 1) visual.step({ ...(entity as object), progress: frame / 30, position: { x: 100 + frame * 5, y: 0 } } as never, ctxAt(frame / 60, characters))
    let frames = 0
    while (visual.step(undefined, ctxAt(0.5 + frames / 60, characters)) && frames < 600) frames += 1
    assert.ok(frames < 600, `${id} ends`)
    visual.dispose()
  }
})

test('the Hellhound is built and posed in every way', () => {
  const hound = new HoundModel(new VisionShading(), getChampion('hellhound').radius)
  for (const pose of [{}, { moving: true, speed: 150 }, { action: { kind: 'attack' as const, progress: 0.5 } }, { release: { kind: 'cast' as const, t: 0.3 } }, { dead: true, deadFor: 1 }]) {
    hound.pose({ t: 1, dt: 1 / 60, moving: false, speed: 0, dead: false, deadFor: 0, stunned: false, ...pose })
  }
  hound.ambient({ glow: emitter, puff: emitter } as never, 1)
  hound.release('attack', { glow: emitter, puff: emitter } as never)
  assert.ok(hound.height > 0)
})

test('the marks of the new champions, and a bleed stack going on, are drawn', () => {
  const fx = new CharacterFx()
  const marked = character(2, 'swordsman', 0, { 'hound-bleed': 1, carrion: 1, cracked: 1, shred: 2 }) as Record<string, unknown>
  const sniper = character(1, 'sniper', 100, { 'steady-aim': 1 })
  const blade = character(3, 'blade', 200, { knife: 3 }) as Record<string, unknown>
  const model = { root: Object.assign(new Group(), { visible: true }), height: 70 }
  const ctx = { ...(ctxAt(0, new Map()) as object), models: { modelOf: () => model, topOf: () => 70 } } as never
  for (let frame = 0; frame < 10; frame += 1) fx.update([{ ...marked, stacks: frame < 5 ? {} : marked.stacks }, sniper, { ...blade, stacks: { knife: 2 + (frame % 3) } }] as never, [], ctx)
  fx.update([marked, { ...blade, stacks: {} }] as never, [{ id: 2, kind: 'attack' }] as never, ctx)
  fx.dispose()
})
