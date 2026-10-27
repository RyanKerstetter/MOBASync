import assert from 'node:assert/strict'
import test from 'node:test'
import { championSprites } from '../apps/client/src/champion-sprites.ts'
import { spriteFileKey, spriteOverridesFrom } from '../apps/client/src/sprite-overrides.ts'

test('a sheet has the same key wherever it is served or picked from', () => {
  assert.equal(spriteFileKey('http://localhost:5173/res/Champion_Swordsman/Idle.png?t=123'), 'champion_swordsman/idle.png')
  assert.equal(spriteFileKey('my-art/Champion_Swordsman/Idle.png'), 'champion_swordsman/idle.png')
  assert.equal(spriteFileKey('C:\\art\\Champion_Swordsman\\Idle.png'), 'champion_swordsman/idle.png')
  assert.equal(spriteFileKey('Champion_Swordsman/Idle.png'), 'champion_swordsman/idle.png', 'a character folder picked on its own')
  assert.equal(spriteFileKey('/res/Champion_Swordsman/Shield%2BAttack.png'), 'champion_swordsman/shield+attack.png')
})

test('a picked folder gives its pngs by key, and nothing else', () => {
  const overrides = spriteOverridesFrom([
    { name: 'Idle.png', webkitRelativePath: 'res2/Champion_Archer/Idle.png' },
    { name: 'Walk.png', webkitRelativePath: 'res2/Champion_Archer/Walk.png' },
    { name: 'notes.txt', webkitRelativePath: 'res2/Champion_Archer/notes.txt' },
  ])
  assert.deepEqual([...overrides.keys()].sort(), ['champion_archer/idle.png', 'champion_archer/walk.png'])
})

test('the keys of the game\'s own sheets are found in a copy of res/', () => {
  const keys = Object.values(championSprites).flatMap((set) => Object.values(set.clips).map((clip) => spriteFileKey(clip.url)))
  assert.ok(keys.length > 0)
  // A champion's folder (champion_archer/idle.png), or a monster's (slime/slime1_idle_with_shadow.png).
  assert.ok(keys.every((key) => /^\w+\/[\w+]+\.png$/.test(key)), keys.join(', '))
  const overrides = spriteOverridesFrom(keys.map((key) => ({ name: key.split('/')[1]!, webkitRelativePath: `res/${key}` })))
  assert.deepEqual([...overrides.keys()].sort(), [...new Set(keys)].sort())
})
