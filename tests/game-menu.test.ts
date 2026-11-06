import assert from 'node:assert/strict'
import test from 'node:test'
import { CastControl, DEFAULT_CAST_MODE } from '../apps/client/src/cast-control.ts'
import { CAST_MODE_LABELS, EFFECT_LABELS, frameRateLabel, menuFooter, menuTabs, type MenuItem, type MenuTab } from '../apps/client/src/game-menu.ts'
import {
  ATTACK_MARKER_SIZE_STEP,
  CLICK_RADIUS_STEP,
  DEFAULT_ATTACK_MARKER_SIZE,
  DEFAULT_CLICK_RADIUS,
  DEFAULT_MAX_FPS,
  DEFAULT_SETTINGS,
  FRAME_RATE_OPTIONS,
  loadSettings,
  MAX_ATTACK_MARKER_SIZE,
  MAX_CLICK_RADIUS,
  MIN_ATTACK_MARKER_SIZE,
  readAttackMarkerSize,
  readClickRadius,
  readMaxFps,
  saveSettings,
  UNCAPPED_FPS,
  type GameSettings,
} from '../apps/client/src/game-settings.ts'
import { GAME_TPS } from '../packages/shared/src/index.ts'
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
  const state = {
    castMode: DEFAULT_CAST_MODE,
    clickRadius: DEFAULT_CLICK_RADIUS,
    walkKeepsAuto: false,
    walkKeepsCast: true,
    movementKeys: false,
    castKeepsAttack: DEFAULT_SETTINGS.castKeepsAttack,
    attackMarkerSize: DEFAULT_ATTACK_MARKER_SIZE,
    effects: { ...DEFAULT_EFFECTS },
    maxFps: DEFAULT_MAX_FPS,
    debugView: false,
    diagnostics: true,
  }
  const tabs = menuTabs({
    getCastMode: () => state.castMode,
    setCastMode: (mode) => { state.castMode = mode },
    getClickRadius: () => state.clickRadius,
    setClickRadius: (radius) => { state.clickRadius = radius },
    getWalkKeepsAuto: () => state.walkKeepsAuto,
    setWalkKeepsAuto: (on) => { state.walkKeepsAuto = on },
    getWalkKeepsCast: () => state.walkKeepsCast,
    setWalkKeepsCast: (on) => { state.walkKeepsCast = on },
    getMovementKeys: () => state.movementKeys,
    setMovementKeys: (on) => { state.movementKeys = on },
    getCastKeepsAttack: () => state.castKeepsAttack,
    setCastKeepsAttack: (on) => { state.castKeepsAttack = on },
    getAttackMarkerSize: () => state.attackMarkerSize,
    setAttackMarkerSize: (size) => { state.attackMarkerSize = size },
    getEffect: (effect) => state.effects[effect],
    setEffect: (effect, on) => { state.effects[effect] = on },
    getMaxFps: () => state.maxFps,
    setMaxFps: (fps) => { state.maxFps = fps },
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
type Choice = Extract<MenuItem, { kind: 'choice' }>
type Slider = Extract<MenuItem, { kind: 'slider' }>

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

// The Effects section of the Graphics tab, which is the switches: the frame rate is the section before it.
const effectsOf = (tabs: readonly MenuTab[]): MenuTab => ({ ...tabOf(tabs, 'graphics'), sections: tabOf(tabs, 'graphics').sections.filter((section) => section.title === 'Effects') })

test('the Graphics tab has a Frame rate section, an Effects section with a switch for every effect there is, each named and with a line on what it shows, and a Markers section', () => {
  const { tabs } = harness()
  const graphics = tabOf(tabs, 'graphics')
  assert.deepEqual(graphics.sections.map((section) => section.title), ['Frame rate', 'Effects', 'Markers'])
  const switches = toggles(effectsOf(tabs))
  assert.equal(switches.length, itemsOf(effectsOf(tabs)).length, 'every row of the effects is a switch')
  assert.deepEqual(switches.map((item) => item.label), EFFECT_KEYS.map((effect) => EFFECT_LABELS[effect].label), 'one for each, in the order of the effects')
  assert.equal(new Set(switches.map((item) => item.label)).size, switches.length, 'no two are called the same')
  for (const item of switches) assert.ok((item.description ?? '').length > 0, `${item.label} says what it does`)
  assert.deepEqual(Object.keys(EFFECT_LABELS).sort(), [...EFFECT_KEYS].sort(), 'and the names cover exactly the effects there are')
})

test('a switch shows whether its effect is on, and turning it sets that effect alone', () => {
  const { state, tabs } = harness()
  const switches = toggles(effectsOf(tabs))
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

// ---------------------------------------------------------------------------- the attack marker

test('the attack marker size is a slider in the Markers section, from the marker\'s own size to the most, in percent, starting at the default', () => {
  const { state, tabs } = harness()
  const items = tabOf(tabs, 'graphics').sections.find((section) => section.title === 'Markers')?.items ?? []
  assert.equal(items.length, 1, 'one row')
  const size = items[0] as Slider
  assert.equal(size.kind, 'slider')
  assert.equal(size.label, 'Attack marker size')
  assert.deepEqual([size.min, size.max, size.step, size.unit], [MIN_ATTACK_MARKER_SIZE, MAX_ATTACK_MARKER_SIZE, ATTACK_MARKER_SIZE_STEP, '%'])
  assert.ok((size.description ?? '').length > 0 && (size.description ?? '').length < 100, 'a line on what it does')
  assert.equal(size.get(), DEFAULT_ATTACK_MARKER_SIZE)
  assert.equal(DEFAULT_SETTINGS.attackMarkerSize, DEFAULT_ATTACK_MARKER_SIZE)
  assert.ok(DEFAULT_ATTACK_MARKER_SIZE >= size.min && DEFAULT_ATTACK_MARKER_SIZE <= size.max, 'the default is one the slider can show')
  assert.equal((MAX_ATTACK_MARKER_SIZE - MIN_ATTACK_MARKER_SIZE) % ATTACK_MARKER_SIZE_STEP, 0, 'and the most is a step it can land on')
  assert.ok(MAX_ATTACK_MARKER_SIZE > MIN_ATTACK_MARKER_SIZE, 'it can be made bigger')

  size.set(MAX_ATTACK_MARKER_SIZE)
  assert.equal(state.attackMarkerSize, MAX_ATTACK_MARKER_SIZE)
  assert.equal(size.get(), MAX_ATTACK_MARKER_SIZE, 'and the menu shows it')
})

test('the attack marker size is kept whole and between the least and the most, and anything that is not a number is the default', () => {
  assert.equal(readAttackMarkerSize(MIN_ATTACK_MARKER_SIZE), MIN_ATTACK_MARKER_SIZE)
  assert.equal(readAttackMarkerSize(MAX_ATTACK_MARKER_SIZE), MAX_ATTACK_MARKER_SIZE)
  assert.equal(readAttackMarkerSize(MIN_ATTACK_MARKER_SIZE + ATTACK_MARKER_SIZE_STEP + 0.4), MIN_ATTACK_MARKER_SIZE + ATTACK_MARKER_SIZE_STEP, 'rounded to whole percent')
  assert.equal(readAttackMarkerSize(MIN_ATTACK_MARKER_SIZE - 1), MIN_ATTACK_MARKER_SIZE, 'not below the least')
  assert.equal(readAttackMarkerSize(MAX_ATTACK_MARKER_SIZE + 500), MAX_ATTACK_MARKER_SIZE, 'nor above the most')
  for (const odd of [undefined, null, '150', Number.NaN, Number.POSITIVE_INFINITY, [150], { size: 150 }]) {
    assert.equal(readAttackMarkerSize(odd), DEFAULT_ATTACK_MARKER_SIZE, `${JSON.stringify(odd)} is not an answer`)
  }
  // Read alone: a damaged one costs only itself.
  assert.deepEqual(loadSettings(fakeStorage('{"castMode":"quick","attackMarkerSize":"huge"}')), { ...DEFAULT_SETTINGS, castMode: 'quick' })
})

// ---------------------------------------------------------------------------- the frame rate

const frameRateOf = (tabs: readonly MenuTab[]): Choice => {
  const items = tabOf(tabs, 'graphics').sections.find((section) => section.title === 'Frame rate')?.items ?? []
  assert.equal(items.length, 1, 'one row')
  assert.equal(items[0].kind, 'choice')
  return items[0] as Choice
}

test('the frame rate is a choice on the Graphics tab with a button for every rate there is, uncapped first, and a line on what it does', () => {
  const { tabs } = harness()
  const rate = frameRateOf(tabs)
  assert.equal(rate.label, 'Frame rate limit')
  assert.equal(rate.dropdown, true, 'a dropdown, since there are too many for a row of buttons')
  assert.deepEqual(rate.options.map((option) => option.value), FRAME_RATE_OPTIONS.map(String), 'one button for each rate in the list, in its order')
  assert.equal(rate.options[0].value, String(UNCAPPED_FPS), 'uncapped is first')
  assert.equal(rate.options[0].label, 'Uncapped')
  assert.equal(new Set(rate.options.map((option) => option.label)).size, rate.options.length, 'no two are called the same')
  assert.ok((rate.description ?? '').length > 0 && (rate.description ?? '').length < 160, 'a line on what it does')
})

test('the list of frame rates has the usual ones, each a whole number above none, from the highest down, once each', () => {
  for (const wanted of [30, 60, 90, 120, 144, 180]) assert.ok(FRAME_RATE_OPTIONS.includes(wanted), `${wanted} is offered`)
  const capped = FRAME_RATE_OPTIONS.filter((fps) => fps !== UNCAPPED_FPS)
  assert.ok(capped.every((fps) => Number.isInteger(fps) && fps > 0), 'every other is a whole number of frames')
  assert.deepEqual([...capped].sort((left, right) => right - left), capped, 'highest first')
  assert.equal(new Set(FRAME_RATE_OPTIONS).size, FRAME_RATE_OPTIONS.length, 'none twice')
  assert.equal(FRAME_RATE_OPTIONS.filter((fps) => fps === UNCAPPED_FPS).length, 1, 'and one way to have no limit')
  assert.deepEqual(capped.map(frameRateLabel), capped.map((fps) => `${fps} fps`))
  assert.equal(frameRateLabel(UNCAPPED_FPS), 'Uncapped')
})

test('the frame rate starts uncapped, and choosing one sets it, and the menu shows it', () => {
  assert.equal(DEFAULT_MAX_FPS, UNCAPPED_FPS, 'uncapped until a player chooses')
  assert.equal(DEFAULT_SETTINGS.maxFps, UNCAPPED_FPS)
  const { state, tabs } = harness()
  const rate = frameRateOf(tabs)
  assert.equal(rate.get(), String(UNCAPPED_FPS), 'the menu starts on uncapped')
  for (const fps of FRAME_RATE_OPTIONS) {
    rate.set(String(fps))
    assert.equal(state.maxFps, fps, `${fps} was set, as a number and not as the text of one`)
    assert.equal(rate.get(), String(fps), 'and the menu shows it')
    assert.ok(rate.options.some((option) => option.value === rate.get()), 'as one of the buttons')
  }
})

test('setting the frame rate changes nothing else in the menu', () => {
  const { state, tabs } = harness()
  const before = JSON.stringify({ ...state, maxFps: 0 })
  frameRateOf(tabs).set('144')
  assert.equal(JSON.stringify({ ...state, maxFps: 0 }), before)
  assert.equal(state.maxFps, 144)
})

test('the frame rate is only about drawing: rates above the game\'s tick rate are offered, since the world is drawn between ticks', () => {
  // The list is of frames a second drawn; the game ticks `GAME_TPS` a second whatever is chosen, and a rate over that only draws more often between ticks.
  assert.ok(FRAME_RATE_OPTIONS.some((fps) => fps > GAME_TPS), 'a rate above the tick rate is offered')
  assert.ok(FRAME_RATE_OPTIONS.includes(GAME_TPS), 'and so is one the same as it')
  assert.ok(FRAME_RATE_OPTIONS.some((fps) => fps !== UNCAPPED_FPS && fps < GAME_TPS), 'and one below it')
})

// ---------------------------------------------------------------------------- controls

test('the Controls tab has the casting, the moving and the targeting, in sections of their own', () => {
  const { tabs } = harness()
  const controls = tabOf(tabs, 'controls')
  assert.deepEqual(controls.sections.map((section) => section.title), ['Casting', 'Moving', 'Targeting'])
  const sectionOf = (title: string): MenuTab => ({ ...controls, sections: controls.sections.filter((section) => section.title === title) })
  assert.deepEqual(toggles(sectionOf('Casting')).map((toggle) => toggle.label), ['Keep attacking after casting'])
  assert.deepEqual(toggles(sectionOf('Moving')).map((toggle) => toggle.label), ['WASD movement', 'Moving doesn\'t cancel attacks', 'Moving doesn\'t cancel abilities'])
  assert.equal(DEFAULT_SETTINGS.movementKeys, false, 'WASD movement is off until it is turned on')
  assert.equal(DEFAULT_SETTINGS.castKeepsAttack, true, 'and a cast keeps an attack from the start')
  const switches = toggles(controls)
  const before = switches.map((toggle) => toggle.get())
  for (const toggle of switches) toggle.set(!toggle.get())
  assert.deepEqual(switches.map((toggle) => toggle.get()), before.map((on) => !on), 'each switch changes what the game holds')
})

test('the cast mode is on the Controls tab as a choice of every mode, with the current one selected', () => {
  const { tabs } = harness()
  const controls = itemsOf(tabOf(tabs, 'controls'))
  const choices = controls.filter((item): item is Choice => item.kind === 'choice')
  assert.equal(choices.length, 1, 'the only choice')
  const [castMode] = choices
  assert.equal(castMode.label, 'Cast mode')
  assert.deepEqual(castMode.options.map((option) => option.value), Object.keys(CAST_MODE_LABELS), 'one option for every cast mode there is')
  assert.equal(castMode.get(), DEFAULT_CAST_MODE)
})

test('choosing a cast mode in the menu sets it', () => {
  const { state, tabs } = harness()
  const castMode = itemsOf(tabOf(tabs, 'controls')).find((item): item is Choice => item.kind === 'choice') as Choice
  castMode.set('quick')
  assert.equal(state.castMode, 'quick')
  assert.equal(castMode.get(), 'quick', 'and the menu shows it')
})

test('the click radius is a slider on the Controls tab from none to the most, saying what it does and starting at the default', () => {
  const { state, tabs } = harness()
  const sliders = itemsOf(tabOf(tabs, 'controls')).filter((item): item is Slider => item.kind === 'slider')
  assert.equal(sliders.length, 1)
  const [radius] = sliders
  assert.equal(radius.label, 'Click radius')
  assert.deepEqual([radius.min, radius.max, radius.step, radius.unit], [0, MAX_CLICK_RADIUS, CLICK_RADIUS_STEP, 'px'])
  assert.ok((radius.description ?? '').length > 0 && (radius.description ?? '').length < 100, 'a line on what it does')
  assert.equal(radius.get(), state.clickRadius)
  assert.equal(radius.get(), DEFAULT_CLICK_RADIUS)

  radius.set(MAX_CLICK_RADIUS)
  assert.equal(state.clickRadius, MAX_CLICK_RADIUS)
  assert.equal(radius.get(), MAX_CLICK_RADIUS, 'and the menu shows it')
  assert.ok(DEFAULT_CLICK_RADIUS >= radius.min && DEFAULT_CLICK_RADIUS <= radius.max, 'the default is one the slider can show')
  assert.equal((MAX_CLICK_RADIUS - radius.min) % radius.step, 0, 'and the most is a step it can land on')
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

  const chosen: GameSettings = {
    castMode: 'quick',
    effects: { turretRanges: false, selfAttackRange: true, shopGlow: false },
    clickRadius: DEFAULT_CLICK_RADIUS + CLICK_RADIUS_STEP,
    walkKeepsAuto: !DEFAULT_SETTINGS.walkKeepsAuto,
    walkKeepsCast: !DEFAULT_SETTINGS.walkKeepsCast,
    movementKeys: !DEFAULT_SETTINGS.movementKeys,
    castKeepsAttack: !DEFAULT_SETTINGS.castKeepsAttack,
    attackMarkerSize: DEFAULT_ATTACK_MARKER_SIZE + ATTACK_MARKER_SIZE_STEP,
    diagnostics: false,
    maxFps: 144,
  }
  saveSettings(chosen, storage)
  assert.deepEqual(loadSettings(storage), chosen, 'what was saved comes back')

  assert.deepEqual(loadSettings(fakeStorage('{not json')), DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(fakeStorage('{"castMode":"sideways"}')), DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(fakeStorage('[1,2]')), DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(fakeStorage('null')), DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(undefined), DEFAULT_SETTINGS, 'and with no storage at all')
})

test('every effect is off by default, and each stored value is read alone: a damaged one costs only itself', () => {
  for (const effect of EFFECT_KEYS) assert.equal(DEFAULT_EFFECTS[effect], false, `${effect} is off until it is turned on`)
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

test('the click radius is kept whole and between none and the most, and anything that is not a number is the default', () => {
  assert.equal(readClickRadius(0), 0, 'none is a choice')
  assert.equal(readClickRadius(MAX_CLICK_RADIUS), MAX_CLICK_RADIUS)
  assert.equal(readClickRadius(DEFAULT_CLICK_RADIUS + 0.4), DEFAULT_CLICK_RADIUS, 'rounded to whole pixels')
  assert.equal(readClickRadius(-5), 0, 'not below none')
  assert.equal(readClickRadius(MAX_CLICK_RADIUS + 500), MAX_CLICK_RADIUS, 'nor above the most')
  for (const odd of [undefined, null, '12', Number.NaN, Number.POSITIVE_INFINITY, [3], { value: 3 }]) {
    assert.equal(readClickRadius(odd), DEFAULT_CLICK_RADIUS, `${JSON.stringify(odd)} is not an answer`)
  }
  // And it is read alone: a damaged one costs only itself.
  const older = loadSettings(fakeStorage('{"castMode":"quick","clickRadius":"wide"}'))
  assert.deepEqual(older, { ...DEFAULT_SETTINGS, castMode: 'quick' })
  assert.equal(loadSettings(fakeStorage('{"clickRadius":0}')).clickRadius, 0, 'and none, which is falsy, is kept')
})

test('the frame rate is kept as one of the rates the menu has, and anything else is uncapped', () => {
  for (const fps of FRAME_RATE_OPTIONS) assert.equal(readMaxFps(fps), fps, `${fps} is kept`)
  assert.equal(readMaxFps(UNCAPPED_FPS), UNCAPPED_FPS, 'none is a choice, and is falsy')
  // A number the menu does not have is not an answer, nor is anything that is not a number.
  for (const odd of [undefined, null, '60', '144', Number.NaN, Number.POSITIVE_INFINITY, -60, 100, 59.9, 1000, [60], { fps: 60 }, true]) {
    assert.equal(readMaxFps(odd), DEFAULT_MAX_FPS, `${JSON.stringify(odd)} is not an answer`)
  }
  // Read alone: a damaged one costs only itself, and a file from before there was a frame rate has none, so it is uncapped.
  assert.deepEqual(loadSettings(fakeStorage('{"castMode":"quick","maxFps":"fast"}')), { ...DEFAULT_SETTINGS, castMode: 'quick' })
  assert.deepEqual(loadSettings(fakeStorage('{"castMode":"quick"}')), { ...DEFAULT_SETTINGS, castMode: 'quick' })
  assert.equal(loadSettings(fakeStorage('{"maxFps":30}')).maxFps, 30)
  assert.equal(loadSettings(fakeStorage('{"maxFps":100}')).maxFps, UNCAPPED_FPS, 'a rate that is not on the list is uncapped')
  assert.equal(loadSettings(fakeStorage('{"maxFps":0}')).maxFps, UNCAPPED_FPS)
})

test('storage that refuses to save does not stop the game', () => {
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.doesNotThrow(() => saveSettings({ ...DEFAULT_SETTINGS, castMode: 'quick' }, broken))
  assert.deepEqual(loadSettings(broken), DEFAULT_SETTINGS)
})
