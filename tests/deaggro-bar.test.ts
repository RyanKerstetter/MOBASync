import assert from 'node:assert/strict'
import test from 'node:test'
import { DEAGGRO_COLOR, DEAGGRO_FULL_COLOR, layoutDeaggroBar } from '../apps/client/src/render/deaggro-bar.ts'

// The bar over a monster that is losing interest: there when it has something in it, amber while it fills and red when it is full.

test('there is no bar for a monster whose deaggro bar is empty, or that has none', () => {
  assert.equal(layoutDeaggroBar(0), undefined)
  assert.equal(layoutDeaggroBar(-0.2), undefined)
  assert.equal(layoutDeaggroBar(Number.NaN), undefined)
})

test('a bar is as full as the monster\'s, in amber, and red and no fuller when it is full', () => {
  assert.deepEqual(layoutDeaggroBar(1 / 60), { fraction: 1 / 60, color: DEAGGRO_COLOR }, 'a tick of it is shown')
  assert.deepEqual(layoutDeaggroBar(0.5), { fraction: 0.5, color: DEAGGRO_COLOR })
  assert.deepEqual(layoutDeaggroBar(59 / 60), { fraction: 59 / 60, color: DEAGGRO_COLOR }, 'one tick short is not yet red')
  assert.deepEqual(layoutDeaggroBar(1), { fraction: 1, color: DEAGGRO_FULL_COLOR })
  assert.deepEqual(layoutDeaggroBar(1.7), { fraction: 1, color: DEAGGRO_FULL_COLOR }, 'more than full is full')
  assert.notEqual(DEAGGRO_COLOR, DEAGGRO_FULL_COLOR)
})
