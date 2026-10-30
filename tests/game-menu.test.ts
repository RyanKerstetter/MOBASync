import assert from 'node:assert/strict'
import test from 'node:test'
import { CastControl, DEFAULT_CAST_MODE } from '../apps/client/src/cast-control.ts'
import { CAST_MODE_LABELS, EFFECT_LABELS, menuFooter, menuTabs, type MenuItem, type MenuTab } from '../apps/client/src/game-menu.ts'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type GameSettings } from '../apps/client/src/game-settings.ts'
import { DEFAULT_EFFECTS, EFFECT_KEYS, readEffects } from '../apps/client/src/render/effect-settings.ts'

function fakeStorage(initial?: string) {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set('moba-settings', initial)
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
}

// A menu made over a state the tests can see: what the game would hold, and what the menu has been asked to do to it.
function harness(extra: { sprites?: { pickFolder: () => void; reset: () => void } } = {}) {
  const state = { castMode: DEFAULT_CAST_MODE, effects: { ...DEFAULT_EFFECTS }, debugView: false, diagnostics: true }
  const tabs = menuTabs({
    getCastMode: () => state.castMode,
    setCastMode: (mode) => { state.castMode = mode },
    getEffect: (effect) => state.effects[effect],
    setEffect: (effect, on) => { state.effects[effect] = on },
    getDebugView: () => state.debugView,
    setDebugView: (on) => { state.debugView = on },
    getDiagnostics: () => state.diagnostics,
    setDiagnostics: (on) => { state.diagnostics = on },
    ...extra,
  })
  return { state, tabs }
}
const tabOf = (tabs: readonly MenuTab[], id: string): MenuTab => tabs.find((tab) => tab.id === id) as MenuTab
const itemsOf = (tab: MenuTab): MenuItem[] => tab.sections.flatMap((section) => section.items)
type Toggle = Extract<MenuItem, { kind: 'toggle' }>
const toggles = (tab: MenuTab): Toggle[] => itemsOf(tab).filter((item): item is Toggle => item.kind === 'toggle')

// ---------------------------------------------------------------------------- the tabs

test('the menu has a Graphics, a Controls and a Dev tab, in that order, each with something in it', () => {
  const { tabs } = harness()
  assert.deepEqual(tabs.map((tab) => [tab.id, tab.label]), [['graphics', 'Graphics'], ['controls', 'Controls'], ['dev', 'Dev']])
  for (const tab of tabs) assert.ok(itemsOf(tab).length > 0, `${tab.label} has rows`)
})

test('Leave game is under the tabs, whichever is open, and runs what it was given', () => {
  let left = 0
  const footer = menuFooter({ leaveGame: () => { left += 1 } })
  assert.equal(footer.length, 1)
  const [leave] = footer
  assert.deepEqual([leave.kind, leave.label, leave.kind === 'action' && leave.danger], ['action', 'Leave game', true])
  if (leave.kind === 'action') leave.run()
  assert.equal(left, 1)
  assert.ok(harness().tabs.every((tab) => itemsOf(tab).every((item) => !(item.kind === 'action' && item.danger))), 'and it is on no tab')
})

// ---------------------------------------------------------------------------- graphics

test('the Graphics tab has an Effects section with a switch for every effect there is, each named and with a line on what it shows', () => {
  const { tabs } = harness()
  const graphics = tabOf(tabs, 'graphics')
  assert.deepEqual(graphics.sections.map((section) => section.title), ['Effects'])
  const switches = toggles(graphics)
  assert.equal(switches.length, itemsOf(graphics).length, 'every row is a switch')
  assert.deepEqual(switches.map((item) => item.label), EFFECT_KEYS.map((effect) => EFFECT_LABELS[effect].label), 'one for each, in the order of the effects')
  assert.equal(new Set(switches.map((item) => item.label)).size, switches.length, 'no two are called the same')
  for (const item of switches) assert.ok((item.description ?? '').length > 0, `${item.label} says what it does`)
  assert.deepEqual(Object.keys(EFFECT_LABELS).sort(), [...EFFECT_KEYS].sort(), 'and the names cover exactly the effects there are')
})

test('a switch shows whether its effect is on, and turning it sets that effect alone', () => {
  const { state, tabs } = harness()
  const switches = toggles(tabOf(tabs, 'graphics'))
  EFFECT_KEYS.forEach((effect, index) => {
    const item = switches[index]
    assert.equal(item.get(), DEFAULT_EFFECTS[effect], `${effect} starts as the default`)
    item.set(!DEFAULT_EFFECTS[effect])
    assert.equal(state.effects[effect], !DEFAULT_EFFECTS[effect], `${effect} was set`)
    assert.equal(item.get(), !DEFAULT_EFFECTS[effect], 'and the menu shows it')
    for (const other of EFFECT_KEYS.filter((each) => each !== effect)) {
      assert.equal(state.effects[other], DEFAULT_EFFECTS[other], `${other} was left as it was`)
    }
    item.set(DEFAULT_EFFECTS[effect])
    assert.equal(state.effects[effect], DEFAULT_EFFECTS[effect], 'and it can be turned back')
  })
})

// ---------------------------------------------------------------------------- controls

test('the cast mode is on the Controls tab as a choice of every mode, with the current one selected', () => {
  const { tabs } = harness()
  const [castMode, ...rest] = itemsOf(tabOf(tabs, 'controls'))
  assert.equal(rest.length, 0, 'it is the only control so far')
  assert.equal(castMode.kind, 'choice')
  assert.equal(castMode.kind === 'choice' && castMode.label, 'Cast mode')
  assert.deepEqual(
    castMode.kind === 'choice' ? castMode.options.map((option) => option.value) : [],
    Object.keys(CAST_MODE_LABELS),
    'one option for every cast mode there is',
  )
  assert.equal(castMode.kind === 'choice' && castMode.get(), DEFAULT_CAST_MODE)
})

test('choosing a cast mode in the menu sets it', () => {
  const { state, tabs } = harness()
  const [castMode] = itemsOf(tabOf(tabs, 'controls'))
  if (castMode.kind === 'choice') castMode.set('quick')
  assert.equal(state.castMode, 'quick')
  assert.equal(castMode.kind === 'choice' && castMode.get(), 'quick', 'and the menu shows it')
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

// ---------------------------------------------------------------------------- dev

test('the Dev tab has the debug view and the diagnostics as switches, and the sprite tools only when it is given them', () => {
  const { state, tabs } = harness()
  const dev = tabOf(tabs, 'dev')
  assert.deepEqual(dev.sections.map((section) => section.title), ['Debug'], 'no sprite tools without them')
  const [debug, diagnostics] = toggles(dev)
  assert.equal(debug.label, 'Debug view (P)', 'it says which key does it too')
  assert.equal(diagnostics.label, 'Diagnostics')
  assert.deepEqual([debug.get(), diagnostics.get()], [false, true])
  debug.set(true)
  diagnostics.set(false)
  assert.deepEqual([state.debugView, state.diagnostics], [true, false])
  assert.deepEqual([debug.get(), diagnostics.get()], [true, false], 'and the menu shows them')

  const calls: string[] = []
  const withTools = harness({ sprites: { pickFolder: () => calls.push('pick'), reset: () => calls.push('reset') } })
  const tools = withTools.tabs.find((tab) => tab.id === 'dev')?.sections.find((section) => section.title === 'Sprites')
  assert.ok(tools, 'a Sprites section')
  assert.deepEqual(tools?.items.map((item) => item.label), ['Load sprites from folder…', 'Reset sprites'])
  for (const item of tools?.items ?? []) if (item.kind === 'action') item.run()
  assert.deepEqual(calls, ['pick', 'reset'])
})

// ---------------------------------------------------------------------------- what is kept

test('settings are kept, and a missing, damaged or odd stored value is the default', () => {
  const storage = fakeStorage()
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS, 'nothing stored')

  const chosen: GameSettings = { castMode: 'quick', effects: { turretRanges: false, selfAttackRange: true, shopGlow: false }, diagnostics: false }
  saveSettings(chosen, storage)
  assert.deepEqual(loadSettings(storage), chosen, 'what was saved comes back')

  assert.deepEqual(loadSettings(fakeStorage('{not json')), DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(fakeStorage('{"castMode":"sideways"}')), DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(fakeStorage('[1,2]')), DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(fakeStorage('null')), DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(undefined), DEFAULT_SETTINGS, 'and with no storage at all')
})

test('every effect is on by default, and each stored value is read alone: a damaged one costs only itself', () => {
  for (const effect of EFFECT_KEYS) assert.equal(DEFAULT_EFFECTS[effect], true, `${effect} is on until it is turned off`)
  assert.deepEqual(readEffects(undefined), DEFAULT_EFFECTS)
  assert.deepEqual(readEffects('on'), DEFAULT_EFFECTS)
  assert.deepEqual(readEffects(null), DEFAULT_EFFECTS)
  assert.deepEqual(readEffects([true, false]), DEFAULT_EFFECTS)
  // One effect stored, as a settings file from before the others were added would have it.
  const [first, ...others] = EFFECT_KEYS
  const only = readEffects({ [first]: !DEFAULT_EFFECTS[first] })
  assert.equal(only[first], !DEFAULT_EFFECTS[first])
  for (const effect of others) assert.equal(only[effect], DEFAULT_EFFECTS[effect], `${effect} is its default`)
  // A value that is not true or false is the default, whatever else is stored beside it.
  const odd = readEffects(Object.fromEntries(EFFECT_KEYS.map((effect, index) => [effect, index === 0 ? 'yes' : !DEFAULT_EFFECTS[effect]])))
  assert.equal(odd[first], DEFAULT_EFFECTS[first], 'a string is not an answer')
  for (const effect of others) assert.equal(odd[effect], !DEFAULT_EFFECTS[effect])
  // An effect that is not one of ours is not kept.
  assert.deepEqual(Object.keys(readEffects({ sparkles: true })).sort(), [...EFFECT_KEYS].sort())
})

test('the settings that come back are the player\'s own copy: changing them never changes the defaults', () => {
  const loaded = loadSettings(fakeStorage())
  loaded.effects[EFFECT_KEYS[0]] = !DEFAULT_EFFECTS[EFFECT_KEYS[0]]
  assert.equal(DEFAULT_SETTINGS.effects[EFFECT_KEYS[0]], DEFAULT_EFFECTS[EFFECT_KEYS[0]])
  assert.equal(loadSettings(fakeStorage()).effects[EFFECT_KEYS[0]], DEFAULT_EFFECTS[EFFECT_KEYS[0]])
  const broken = loadSettings(fakeStorage('{not json'))
  broken.effects[EFFECT_KEYS[0]] = !DEFAULT_EFFECTS[EFFECT_KEYS[0]]
  assert.equal(DEFAULT_SETTINGS.effects[EFFECT_KEYS[0]], DEFAULT_EFFECTS[EFFECT_KEYS[0]], 'even when the stored value was damaged')
})

test('a settings file from before the effects were added keeps its cast mode and has every effect on', () => {
  const older = loadSettings(fakeStorage('{"castMode":"quick"}'))
  assert.deepEqual(older, { ...DEFAULT_SETTINGS, castMode: 'quick' })
})

test('storage that refuses to save does not stop the game', () => {
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.doesNotThrow(() => saveSettings({ ...DEFAULT_SETTINGS, castMode: 'quick' }, broken))
  assert.deepEqual(loadSettings(broken), DEFAULT_SETTINGS)
})
