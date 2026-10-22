import assert from 'node:assert/strict'
import test from 'node:test'
import { CastControl, DEFAULT_CAST_MODE } from '../apps/client/src/cast-control.ts'
import { CAST_MODE_LABELS, menuItems } from '../apps/client/src/game-menu.ts'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../apps/client/src/game-settings.ts'

function fakeStorage(initial?: string) {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set('moba-settings', initial)
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
}

test('the menu offers the cast mode as a choice of every mode, with the current one selected, and leaving the lobby', () => {
  let mode = DEFAULT_CAST_MODE
  const items = menuItems({ getCastMode: () => mode, setCastMode: (next) => { mode = next }, leaveLobby: () => undefined })

  const [castMode, leave] = items
  assert.equal(castMode.kind, 'choice')
  assert.equal(castMode.kind === 'choice' && castMode.label, 'Cast mode')
  assert.deepEqual(
    castMode.kind === 'choice' ? castMode.options.map((option) => option.value) : [],
    Object.keys(CAST_MODE_LABELS),
    'one option for every cast mode there is',
  )
  assert.equal(castMode.kind === 'choice' && castMode.get(), DEFAULT_CAST_MODE)
  assert.deepEqual([leave.kind, leave.label, leave.kind === 'action' && leave.danger], ['action', 'Leave lobby', true])
})

test('choosing a cast mode in the menu sets it, and leaving runs what it was given', () => {
  let mode = DEFAULT_CAST_MODE
  let left = 0
  const [castMode, leave] = menuItems({
    getCastMode: () => mode,
    setCastMode: (next) => { mode = next },
    leaveLobby: () => { left += 1 },
  })

  if (castMode.kind === 'choice') castMode.set('quick')
  assert.equal(mode, 'quick')
  assert.equal(castMode.kind === 'choice' && castMode.get(), 'quick', 'and the menu shows it')
  if (leave.kind === 'action') leave.run()
  assert.equal(left, 1)
})

test('changing the cast mode takes effect from the next key press and drops an aim in progress', () => {
  const control = new CastControl('quick-with-indicator')
  assert.deepEqual(control.press(1, true), { type: 'aim', slot: 1 })
  assert.equal(control.aiming, 1)

  control.setMode('quick')
  assert.equal(control.mode, 'quick')
  assert.equal(control.aiming, undefined, 'the aim is dropped, since its release would be read the other way')
  assert.deepEqual(control.press(1, true), { type: 'cast', slot: 1 }, 'and now it casts on the press')

  control.setMode('quick-with-indicator')
  assert.deepEqual(control.press(1, true), { type: 'aim', slot: 1 })
})

test('settings are kept, and a missing, damaged or odd stored value is the default', () => {
  const storage = fakeStorage()
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS, 'nothing stored')

  saveSettings({ castMode: 'quick' }, storage)
  assert.deepEqual(loadSettings(storage), { castMode: 'quick' }, 'what was saved comes back')

  assert.deepEqual(loadSettings(fakeStorage('{not json')), DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(fakeStorage('{"castMode":"sideways"}')), DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(fakeStorage('[1,2]')), DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(fakeStorage('null')), DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(undefined), DEFAULT_SETTINGS, 'and with no storage at all')
})

test('storage that refuses to save does not stop the game', () => {
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.doesNotThrow(() => saveSettings({ castMode: 'quick' }, broken))
  assert.deepEqual(loadSettings(broken), DEFAULT_SETTINGS)
})
