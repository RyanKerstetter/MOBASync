import assert from 'node:assert/strict'
import test from 'node:test'
import type { RenderedEntity } from '../apps/client/src/game-state.ts'
import { EntityEffects3D, visualKey } from '../apps/client/src/render3d/effects/entity-effects.ts'
import type { EffectContext } from '../apps/client/src/render3d/effects/visual.ts'
import { champions, entityPosAt, getAbilityDef, GAME_TPS, Simulator, type CastOrder, type SimEntity, type Vector2 } from '../packages/shared/src/index.ts'
import { brawler } from './fixtures.ts'

// The Ninja's shadow, drawn in 3D where the game has it. A Shadow Return that passes through an enemy leaves a new shadow where it was
// cast from, under the same name as the one it dashes back to (a Ninja has only one), and the shadow drawn must be the new one, where it
// is: the next Shadow Return goes there.

// The effects are drawn on canvases the page makes; here there is no page, so a canvas that takes anything and draws nothing stands in.
const anything: unknown = new Proxy(function nothing() {}, {
  get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : anything),
  apply: () => anything,
  set: () => true,
})
;(globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => anything }) }

const NINJA = champions.get('ninja')
const NINJA_AT: Vector2 = { x: 600, y: 600 }

function cast(seq: number, tick: number, abilityId: string, target: CastOrder['target'], origin: Vector2): CastOrder {
  return { id: `player-1:${seq}`, seq, tick, type: 'cast', abilityId, target, origin }
}

const shadowOf = (simulator: Simulator, tick: number): SimEntity | undefined =>
  simulator.at(tick).getEntities().find((entity) => entity.defId === 'shadow')

// The shadow as the page is given it to draw, at a tick.
function rendered(entity: SimEntity, tick: number): RenderedEntity {
  return { ...entity, position: entityPosAt(entity, tick), radius: 14, visual: 'field', progress: 0 }
}

// What the effects are drawn with, painting and lighting nothing, with the Ninja where the game has it.
function context(simulator: Simulator, tick: number): EffectContext {
  const position = simulator.at(tick).get(1)?.getPosition() ?? NINJA_AT
  return {
    t: tick / GAME_TPS,
    dt: 1 / GAME_TPS,
    fx: { glow: anything, puff: anything },
    lights: anything,
    decals: anything,
    glowDecals: anything,
    characters: new Map([[1, { position, champion: NINJA }]]),
    models: anything,
  } as unknown as EffectContext
}

test('the shadow a Shadow Return through an enemy leaves is drawn where it is, not where the old one stood', () => {
  assert.ok(NINJA, 'the game has a Ninja')
  const step = getAbilityDef('shadowstep')
  assert.ok(step)
  // An enemy a third of the way along the dash, so the dash out passes it, and so does the dash back.
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', NINJA_AT, NINJA)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: NINJA_AT.x + step.range / 3, y: NINJA_AT.y }, brawler)
  simulator.addOrder(1, cast(1, 1, 'shadowstep', { mode: 'point', point: { x: NINJA_AT.x + step.range, y: NINJA_AT.y } }, NINJA_AT))

  // The dash back, the moment it is ready, from wherever the dash out left the Ninja.
  let ready: number | undefined
  for (let tick = 2; tick < GAME_TPS * 5 && ready === undefined; tick += 1) {
    const ninja = simulator.at(tick).get(1)
    if (shadowOf(simulator, tick) && !ninja?.isDashing() && ninja?.getAbilityCooldown('shadowreturn').ready) ready = tick
  }
  assert.ok(ready !== undefined, 'the dash back is ready while the shadow is out')
  const old = shadowOf(simulator, ready)
  assert.ok(old)
  const from = simulator.at(ready).get(1)?.getPosition()
  assert.ok(from)
  simulator.addOrder(1, cast(2, ready, 'shadowreturn', { mode: 'none' }, from))

  // The tick the dash back reaches the enemy, and leaves a new shadow where it was cast from.
  let left: number | undefined
  for (let tick = ready; tick < ready + GAME_TPS && left === undefined; tick += 1) {
    const shadow = shadowOf(simulator, tick)
    if (shadow && shadow.startTick !== old.startTick) left = tick
  }
  assert.ok(left !== undefined, 'the dash back leaves a new shadow')
  const fresh = shadowOf(simulator, left)
  assert.ok(fresh)
  assert.equal(fresh.id, old.id, 'under the same name as the old one')
  const freshAt = entityPosAt(fresh, left)
  const oldAt = entityPosAt(old, ready)
  assert.ok(Math.hypot(freshAt.x - oldAt.x, freshAt.y - oldAt.y) > step.range / 2, 'and well away from it')
  assert.notEqual(visualKey(fresh), visualKey(old), 'it is a new thing to draw')

  // The same game again, drawn frame by frame from the start (the first is no longer kept to look back at), through to a little after the
  // old shadow has had time to fade.
  const replay = new Simulator()
  replay.addPlayer(1, 'player-1', 'Player 1', NINJA_AT, NINJA)
  replay.addPlayer(2, 'player-2', 'Player 2', { x: NINJA_AT.x + step.range / 3, y: NINJA_AT.y }, brawler)
  replay.addOrder(1, cast(1, 1, 'shadowstep', { mode: 'point', point: { x: NINJA_AT.x + step.range, y: NINJA_AT.y } }, NINJA_AT))
  replay.addOrder(1, cast(2, ready, 'shadowreturn', { mode: 'none' }, from))
  const effects = new EntityEffects3D()
  const end = left + GAME_TPS
  for (let tick = 1; tick <= end; tick += 1) {
    const shadow = shadowOf(replay, tick)
    effects.update(shadow ? [rendered(shadow, tick)] : [], context(replay, tick))
  }
  const drawn = effects.group.children
  assert.equal(drawn.length, 1, 'one shadow is drawn')
  assert.equal(drawn[0].position.x, freshAt.x, 'where the new shadow is')
  assert.equal(drawn[0].position.z, freshAt.y)
  effects.dispose()
})

test('a moving entity is the same thing to draw for its whole life', () => {
  const entity = { id: '1:shot', startTick: 10 }
  assert.equal(visualKey(entity), visualKey({ ...entity }), 'the same entity, later')
  assert.notEqual(visualKey(entity), visualKey({ ...entity, startTick: 40 }), 'and one spawned again under its name is not')
})
