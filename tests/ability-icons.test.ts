import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { abilityDefs, abilityIconName } from '../packages/shared/src/index.ts'

// An ability's picture is a file in res/icons named for it (see ui/ability-icon-urls.ts): its own ID, or the `icon` it says when the file has another name.

const ICONS = fileURLToPath(new URL('../res/icons/', import.meta.url))
const iconFile = (name: string): string => `${ICONS}${name}.png`

test('an ability\'s picture is named for the ability, unless it says another, and one that is not an ability is named for itself', () => {
  for (const def of abilityDefs.values()) {
    assert.equal(abilityIconName(def.id), def.icon ?? def.id, def.id)
  }
  assert.equal(abilityIconName('not-an-ability'), 'not-an-ability')
  const renamed = [...abilityDefs.values()].find((def) => def.icon !== undefined)
  assert.ok(renamed, 'at least one ability has a picture that is not named for it')
  assert.notEqual(abilityIconName(renamed.id), renamed.id)
})

test('every picture an ability says it has is a file that is there', () => {
  for (const def of abilityDefs.values()) {
    if (def.icon === undefined) continue
    assert.ok(existsSync(iconFile(def.icon)), `${def.id} says its picture is res/icons/${def.icon}.png`)
  }
})
