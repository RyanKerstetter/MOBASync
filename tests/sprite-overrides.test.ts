import assert from 'node:assert/strict'
import test from 'node:test'
import { championSprites } from '../apps/client/src/champion-sprites.ts'
import { spriteFileKey, spriteOverridesFrom } from '../apps/client/src/sprite-overrides.ts'

test('a sheet has the same key wherever it is served or picked from', () => {
  assert.equal(spriteFileKey('http://localhost:5173/res/champion/swordsman/Idle.png?t=123'), 'swordsman/idle.png')
  assert.equal(spriteFileKey('my-art/champion/swordsman/Idle.png'), 'swordsman/idle.png')
  assert.equal(spriteFileKey('C:\\art\\champion\\swordsman\\Idle.png'), 'swordsman/idle.png')
  assert.equal(spriteFileKey('Swordsman/Idle.png'), 'swordsman/idle.png', 'a character folder picked on its own, whatever case it is in')
  assert.equal(spriteFileKey('/res/champion/swordsman/Shield%2BAttack.png'), 'swordsman/shield+attack.png')
})

test('a picked folder gives its pngs by key, and nothing else', () => {
  const overrides = spriteOverridesFrom([
    { name: 'Idle.png', webkitRelativePath: 'res2/champion/archer/Idle.png' },
    { name: 'Walk.png', webkitRelativePath: 'res2/champion/archer/Walk.png' },
    { name: 'notes.txt', webkitRelativePath: 'res2/champion/archer/notes.txt' },
  ])
  assert.deepEqual([...overrides.keys()].sort(), ['archer/idle.png', 'archer/walk.png'])
})

test('the keys of the game\'s own sheets are found in a copy of res/', () => {
  const keys = Object.values(championSprites).flatMap((set) => Object.values(set.clips).map((clip) => spriteFileKey(clip.url)))
  assert.ok(keys.length > 0)
  // A champion's folder (archer/idle.png), a monster's (slime/slime1_idle_with_shadow.png), or the turrets' (turret/stone-tower.png).
  assert.ok(keys.every((key) => /^\w+\/[\w+-]+\.png$/.test(key)), keys.join(', '))
  const overrides = spriteOverridesFrom(keys.map((key) => ({ name: key.split('/')[1]!, webkitRelativePath: `res/${key}` })))
  assert.deepEqual([...overrides.keys()].sort(), [...new Set(keys)].sort())
})
