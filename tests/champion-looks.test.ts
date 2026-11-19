import assert from 'node:assert/strict'
import test from 'node:test'
import { ENTITY_VISUALS } from '../apps/client/src/render3d/effects/entity-effects.ts'
import { CHAMPION_LOOKS } from '../apps/client/src/render3d/models/looks.ts'
import { champions, getAbilityDef, getEntityDef } from '../packages/shared/src/index.ts'

test('every champion has a look of its own in 3D, and every look is a champion', () => {
  for (const id of champions.keys()) assert.ok(CHAMPION_LOOKS[id], `${id} has a look`)
  for (const id of Object.keys(CHAMPION_LOOKS)) assert.ok(champions.has(id), `the look "${id}" is for a champion the game has`)
})

test('every entity with an effect of its own is one the game has, so renaming one cannot quietly lose its effect', () => {
  for (const id of Object.keys(ENTITY_VISUALS)) assert.ok(getEntityDef(id), `"${id}" is an entity of the game`)
})

test('every ability of every champion is one the game has, so its look in 3D has something to look like', () => {
  for (const champion of champions.values()) {
    for (const abilityId of champion.castableAbilities()) assert.ok(getAbilityDef(abilityId), `${champion.id}: ${abilityId}`)
  }
})
