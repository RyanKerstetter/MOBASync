import assert from 'node:assert/strict'
import test from 'node:test'
import { championSprites } from '../apps/client/src/champion-sprites.ts'
import { spriteFileKey, spriteOverridesFrom } from '../apps/client/src/sprite-overrides.ts'

test('a sheet has the same key wherever it is served or picked from', () => {
  assert.equal(spriteFileKey('http://localhost:5173/res/Character_SwordShield/Idle.png?t=123'), 'character_swordshield/idle.png')
  assert.equal(spriteFileKey('my-art/Character_SwordShield/Idle.png'), 'character_swordshield/idle.png')
  assert.equal(spriteFileKey('C:\\art\\Character_SwordShield\\Idle.png'), 'character_swordshield/idle.png')
  assert.equal(spriteFileKey('Character_SwordShield/Idle.png'), 'character_swordshield/idle.png', 'a character folder picked on its own')
  assert.equal(spriteFileKey('/res/Character_SwordShield/Shield%2BAttack.png'), 'character_swordshield/shield+attack.png')
})

test('a picked folder gives its pngs by key, and nothing else', () => {
  const overrides = spriteOverridesFrom([
    { name: 'Idle.png', webkitRelativePath: 'res2/Character_Crossbow/Idle.png' },
    { name: 'Walk.png', webkitRelativePath: 'res2/Character_Crossbow/Walk.png' },
    { name: 'notes.txt', webkitRelativePath: 'res2/Character_Crossbow/notes.txt' },
  ])
  assert.deepEqual([...overrides.keys()].sort(), ['character_crossbow/idle.png', 'character_crossbow/walk.png'])
})

test('the keys of the game\'s own sheets are found in a copy of res/', () => {
  const keys = Object.values(championSprites).flatMap((set) => Object.values(set.clips).map((clip) => spriteFileKey(clip.url)))
  assert.ok(keys.length > 0)
  assert.ok(keys.every((key) => /^character_\w+\/[\w+]+\.png$/.test(key)), keys.join(', '))
  const overrides = spriteOverridesFrom(keys.map((key) => ({ name: key.split('/')[1]!, webkitRelativePath: `res/${key}` })))
  assert.deepEqual([...overrides.keys()].sort(), [...new Set(keys)].sort())
})
