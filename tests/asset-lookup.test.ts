import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssetLookup } from '../apps/client/src/render/asset-lookup.ts'

const PREFIX = '../../res/maps/'
const files = {
  [`${PREFIX}arena.tmj`]: '/assets/arena-1.tmj',
  [`${PREFIX}Ground_rocks.png`]: '/assets/ground-1.png',
  [`${PREFIX}terrain/grass.png`]: '/assets/grass-1.png',
  [`${PREFIX}a/tiles.png`]: '/assets/tiles-a.png',
  [`${PREFIX}b/tiles.png`]: '/assets/tiles-b.png',
}
const find = createAssetLookup(files, PREFIX)

test('a file is found by the path it is at', () => {
  assert.equal(find('arena.tmj'), '/assets/arena-1.tmj')
  assert.equal(find('terrain/grass.png'), '/assets/grass-1.png')
  assert.equal(find('a/tiles.png'), '/assets/tiles-a.png', 'two files with the same name are told apart by their paths')
})

test('a path that leads somewhere else is found by the file\'s name when only one file has it', () => {
  assert.equal(find('Downloads/craftpix/Tiled_files/Ground_rocks.png'), '/assets/ground-1.png')
  assert.equal(find('grass.png'), '/assets/grass-1.png')
})

test('a file that is not there, or whose name is ambiguous, is not found', () => {
  assert.equal(find('missing.png'), undefined)
  assert.equal(find('elsewhere/tiles.png'), undefined, 'there are two tiles.png, and no way to say which')
  assert.equal(createAssetLookup({}, PREFIX)('arena.tmj'), undefined, 'no maps at all')
})
