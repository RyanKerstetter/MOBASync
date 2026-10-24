import assert from 'node:assert/strict'
import test from 'node:test'
import { statusLabels, type StatusFlags } from '../apps/client/src/render/status-labels.ts'

const none: StatusFlags & { dead: boolean } = {
  stunned: false,
  rooted: false,
  silenced: false,
  blinded: false,
  burning: false,
  slowed: false,
  hasted: false,
  dodging: false,
  dead: false,
}

test('a champion with nothing on it has no labels', () => {
  assert.deepEqual(statusLabels(none), [])
})

test('each status is named in words', () => {
  assert.deepEqual(statusLabels({ ...none, slowed: true }), ['slowed'])
  assert.deepEqual(statusLabels({ ...none, rooted: true }), ['rooted'])
  assert.deepEqual(statusLabels({ ...none, hasted: true }), ['hasted'])
  assert.deepEqual(statusLabels({ ...none, stunned: true }), ['stunned'])
  assert.deepEqual(statusLabels({ ...none, silenced: true }), ['silenced'])
  assert.deepEqual(statusLabels({ ...none, blinded: true }), ['blinded'])
  assert.deepEqual(statusLabels({ ...none, burning: true }), ['burning'])
  assert.deepEqual(statusLabels({ ...none, dodging: true }), ['dodging'])
})

test('several at once are all shown, the most disabling first', () => {
  assert.deepEqual(
    statusLabels({ ...none, hasted: true, slowed: true, silenced: true, stunned: true }),
    ['stunned', 'silenced', 'slowed', 'hasted'],
  )
})

test('a dead champion shows none', () => {
  assert.deepEqual(statusLabels({ ...none, slowed: true, dead: true }), [])
})
