import assert from 'node:assert/strict'
import test from 'node:test'
import {
  abilityDefs,
  champions,
  entityPosAt,
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  getEntityDef,
  Simulator,
} from '../packages/shared/src/index.js'

const ORIGIN = { x: GAME_ARENA_WIDTH / 2, y: GAME_ARENA_HEIGHT / 2 }
// Long enough for anything an ability fires to run out.
const WATCH_TICKS = 400

// For an ability aimed in a direction the range is only what its indicator draws: what it fires goes by its own speed and lifetime.
// So the line drawn should end where what it fires ends up: somewhere on it at its furthest (a shot flying out, or the far end of
// a slash or a crater thrown ahead).
test('the indicator of every ability aimed in a direction reaches as far as what it fires', () => {
  let checked = 0
  for (const champion of champions.values()) {
    for (const abilityId of champion.abilities) {
      const def = abilityDefs.get(abilityId)
      if (def?.targeting !== 'direction') continue
      const simulator = new Simulator()
      simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, champion)
      simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId, target: { mode: 'direction', dir: { x: 1, y: 0 } }, origin: ORIGIN })
      // The span along the aim of whatever it fired that got furthest.
      let furthest: { near: number; far: number } | undefined
      for (let tick = 1; tick < WATCH_TICKS; tick += 1) {
        for (const entity of simulator.at(tick).getEntities()) {
          if (entity.ownerId !== 1) continue
          const shape = getEntityDef(entity.defId)
          const half = shape?.box?.halfLength ?? shape?.radius ?? 0
          const centre = entityPosAt(entity, tick).x - ORIGIN.x
          if (!furthest || centre + half > furthest.far) furthest = { near: centre - half, far: centre + half }
        }
      }
      if (!furthest) continue
      checked += 1
      assert.ok(
        def.range >= furthest.near && def.range <= furthest.far,
        `${champion.id}'s ${abilityId} shows ${def.range}, but what it fires ends up between ${Math.round(furthest.near)} and ${Math.round(furthest.far)}`,
      )
    }
  }
  assert.ok(checked > 0, 'some champion has an ability aimed in a direction')
})
