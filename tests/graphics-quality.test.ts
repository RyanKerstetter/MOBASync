import assert from 'node:assert/strict'
import test from 'node:test'
import { Color } from 'three'
import { GRAPHICS_PRESET_LABELS, GRAPHICS_ROWS, menuTabs, type MenuItem } from '../apps/client/src/game-menu.ts'
import { DEFAULT_SETTINGS, loadSettings } from '../apps/client/src/game-settings.ts'
import {
  DEFAULT_GRAPHICS,
  DEFAULT_GRAPHICS_PRESET,
  GRAPHICS_CHOICES,
  GRAPHICS_KEYS,
  GRAPHICS_PRESET_NAMES,
  GRAPHICS_PRESETS,
  presetOf,
  readGraphics,
  sameGraphics,
  type GraphicsOptions,
} from '../apps/client/src/render/graphics-quality.ts'
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, readZoom, zoomAfterWheel, ZOOM_PER_NOTCH } from '../apps/client/src/render/zoom.ts'
import { ParticleSystem } from '../apps/client/src/render3d/particles.ts'

// ---------------------------------------------------------------------------- the graphics settings

test('the presets are High, Medium and Low, each sets every setting to one of its values, and each is told apart from the others', () => {
  assert.deepEqual([...GRAPHICS_PRESET_NAMES], ['high', 'medium', 'low'], 'the high end first, as every setting has it')
  for (const name of GRAPHICS_PRESET_NAMES) {
    const preset = GRAPHICS_PRESETS[name]
    assert.deepEqual(Object.keys(preset).sort(), [...GRAPHICS_KEYS].sort(), `${name} sets every setting`)
    for (const key of GRAPHICS_KEYS) assert.ok((GRAPHICS_CHOICES[key] as readonly unknown[]).includes(preset[key]), `${name}: ${key}`)
    assert.equal(presetOf(preset), name)
  }
})

test('a setting changed from a preset leaves it, whichever setting and whichever value', () => {
  for (const name of GRAPHICS_PRESET_NAMES) {
    for (const key of GRAPHICS_KEYS) {
      for (const value of GRAPHICS_CHOICES[key] as readonly unknown[]) {
        if (value === GRAPHICS_PRESETS[name][key]) continue
        const changed = { ...GRAPHICS_PRESETS[name], [key]: value } as GraphicsOptions
        assert.notEqual(presetOf(changed), name, `${name} with ${key} ${String(value)}`)
        assert.equal(sameGraphics(changed, GRAPHICS_PRESETS[name]), false)
      }
    }
  }
})

test('a browser that has stored nothing begins on the default preset, which is Medium', () => {
  assert.equal(DEFAULT_GRAPHICS_PRESET, 'medium')
  assert.deepEqual(DEFAULT_GRAPHICS, GRAPHICS_PRESETS[DEFAULT_GRAPHICS_PRESET])
  assert.deepEqual(DEFAULT_SETTINGS.graphics, DEFAULT_GRAPHICS)
  assert.deepEqual(loadSettings({ getItem: () => null, setItem: () => undefined }).graphics, DEFAULT_GRAPHICS)
})

test('the settings are kept each on its own: one stored odd or missing is the default\'s, and costs only itself', () => {
  const stored = (value: unknown) => ({ getItem: () => JSON.stringify({ graphics: value }), setItem: () => undefined })
  for (const name of GRAPHICS_PRESET_NAMES) assert.deepEqual(loadSettings(stored(GRAPHICS_PRESETS[name])).graphics, GRAPHICS_PRESETS[name])
  const [first, ...rest] = GRAPHICS_KEYS
  const other = (GRAPHICS_CHOICES[first] as readonly unknown[]).find((value) => value !== DEFAULT_GRAPHICS[first])
  const damaged = readGraphics({ ...Object.fromEntries(rest.map((key) => [key, 'sideways'])), [first]: other })
  assert.equal(damaged[first], other, 'the good one kept')
  for (const key of rest) assert.equal(damaged[key], DEFAULT_GRAPHICS[key], `${key} damaged, so the default's`)
  for (const odd of [null, undefined, 3, [1, 2], 'ultra', 'auto']) assert.deepEqual(readGraphics(odd), DEFAULT_GRAPHICS, String(odd))
  // A preset stored by its name, as Low and High once were, is that preset.
  for (const name of GRAPHICS_PRESET_NAMES) assert.deepEqual(readGraphics(name), GRAPHICS_PRESETS[name])
})

// The rest of what the menu is given, which these tests do not look at.
function menuActions() {
  const noop = (): void => undefined
  return {
    getCastMode: () => 'quick' as const,
    setCastMode: noop,
    getClickRadius: () => 0,
    setClickRadius: noop,
    getWalkKeepsAuto: () => false,
    setWalkKeepsAuto: noop,
    getWalkKeepsCast: () => false,
    setWalkKeepsCast: noop,
    getMovementKeys: () => false,
    setMovementKeys: noop,
    getCastKeepsAttack: () => false,
    setCastKeepsAttack: noop,
    getAttackMarkerSize: () => 100,
    setAttackMarkerSize: noop,
    getEffect: () => false,
    setEffect: noop,
    getMaxFps: () => 0,
    setMaxFps: noop,
    getDebugView: () => false,
    setDebugView: noop,
    getDiagnostics: () => false,
    setDiagnostics: noop,
  }
}

// The settings in the order the menu has them: those with values of their own together, then the switches together.
const isSwitch = (key: keyof GraphicsOptions): boolean => typeof GRAPHICS_CHOICES[key][0] === 'boolean'
const MENU_ORDER = [...GRAPHICS_KEYS.filter((key) => !isSwitch(key)), ...GRAPHICS_KEYS.filter(isSwitch)]

function qualitySection(get: () => GraphicsOptions, set: (graphics: GraphicsOptions) => void) {
  const tabs = menuTabs({ ...menuActions(), getRenderer: () => '3d', setRenderer: () => undefined, getGraphics: get, setGraphics: set })
  const graphics = tabs.find((tab) => tab.id === 'graphics')
  return { titles: graphics?.sections.map((section) => section.title), quality: graphics?.sections.find((section) => section.title === 'Quality') }
}

test('the Graphics tab has a Quality section under the View: the preset, then every setting on its own, the choices together and the switches together', () => {
  let current: GraphicsOptions = { ...DEFAULT_GRAPHICS }
  const { titles, quality } = qualitySection(() => current, (graphics) => {
    current = graphics
  })
  assert.deepEqual(titles?.slice(0, 2), ['View', 'Quality'])
  assert.deepEqual(quality?.items.map((item) => item.label), ['Preset', ...MENU_ORDER.map((key) => GRAPHICS_ROWS[key].label)])
  const preset = quality?.items[0] as Extract<MenuItem, { kind: 'choice' }>
  assert.deepEqual(preset.options.map((option) => option.value), [...GRAPHICS_PRESET_NAMES])
  assert.deepEqual(preset.options.map((option) => option.label), GRAPHICS_PRESET_NAMES.map((name) => GRAPHICS_PRESET_LABELS[name]))
  assert.equal(preset.get(), DEFAULT_GRAPHICS_PRESET)
  // A setting that is on or off is a switch; one with values of its own is a choice of them all.
  MENU_ORDER.forEach((key, index) => {
    const item = quality?.items[index + 1]
    const values = GRAPHICS_CHOICES[key] as readonly unknown[]
    if (typeof values[0] === 'boolean') assert.equal(item?.kind, 'toggle', key)
    else assert.deepEqual(item?.kind === 'choice' ? item.options.map((option) => option.value) : [], values.map(String), key)
  })
})

test('choosing a preset sets every setting, and changing one setting changes only it and lights no preset', () => {
  let current: GraphicsOptions = { ...DEFAULT_GRAPHICS }
  const section = () => qualitySection(() => current, (graphics) => {
    current = graphics
  }).quality
  for (const name of GRAPHICS_PRESET_NAMES) {
    const preset = section()?.items[0] as Extract<MenuItem, { kind: 'choice' }>
    preset.set(name)
    assert.deepEqual(current, GRAPHICS_PRESETS[name], `${name} sets them all`)
    assert.equal((section()?.items[0] as Extract<MenuItem, { kind: 'choice' }>).get(), name)
  }
  // High has grass; turning it off is Custom, with everything else as it was.
  const before = { ...current }
  const index = MENU_ORDER.indexOf('grass') + 1
  const grass = section()?.items[index] as Extract<MenuItem, { kind: 'toggle' }>
  grass.set(!before.grass)
  assert.deepEqual(current, { ...before, grass: !before.grass })
  const preset = section()?.items[0] as Extract<MenuItem, { kind: 'choice' }>
  assert.equal(preset.get(), '', 'no preset is lit')
  assert.match(preset.description ?? '', /Custom/)
  // And a choice sets its value.
  const shadows = section()?.items[MENU_ORDER.indexOf('shadows') + 1] as Extract<MenuItem, { kind: 'choice' }>
  shadows.set('off')
  assert.equal(current.shadows, 'off')
  assert.equal(shadows.get(), 'off')
})

test('without the graphics settings to change, there is no Quality section', () => {
  const graphics = menuTabs(menuActions()).find((tab) => tab.id === 'graphics')
  assert.ok(graphics?.sections.every((section) => section.title !== 'Quality'))
})

// ---------------------------------------------------------------------------- zoom

test('the zoom is kept between the closest and the furthest, and anything that is not a number is the usual view', () => {
  assert.ok(MIN_ZOOM <= DEFAULT_ZOOM && DEFAULT_ZOOM <= MAX_ZOOM, 'the usual view is a zoom that is allowed')
  assert.equal(DEFAULT_SETTINGS.zoom, DEFAULT_ZOOM)
  assert.equal(readZoom(MAX_ZOOM * 2), MAX_ZOOM)
  assert.equal(readZoom(MIN_ZOOM / 2), MIN_ZOOM)
  const between = (MIN_ZOOM + MAX_ZOOM) / 2
  assert.equal(readZoom(between), between)
  for (const odd of ['close', Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) assert.equal(readZoom(odd), DEFAULT_ZOOM)
  const stored = (value: unknown) => ({ getItem: () => JSON.stringify({ zoom: value }), setItem: () => undefined })
  assert.equal(loadSettings(stored(between)).zoom, between)
  assert.equal(loadSettings(stored(MAX_ZOOM * 3)).zoom, MAX_ZOOM)
})

test('the wheel turned toward the screen zooms in, away zooms out, a notch at a time, and never past either end', () => {
  const notch = 100
  assert.ok(Math.abs(zoomAfterWheel(DEFAULT_ZOOM, -notch) - Math.min(MAX_ZOOM, DEFAULT_ZOOM * ZOOM_PER_NOTCH)) < 1e-9, 'in a notch')
  assert.ok(Math.abs(zoomAfterWheel(DEFAULT_ZOOM, notch) - Math.max(MIN_ZOOM, DEFAULT_ZOOM / ZOOM_PER_NOTCH)) < 1e-9, 'out a notch')
  // A touchpad's many small turns come to the same as the notch.
  let small = DEFAULT_ZOOM
  for (let step = 0; step < 10; step += 1) small = zoomAfterWheel(small, -notch / 10)
  assert.ok(Math.abs(small - zoomAfterWheel(DEFAULT_ZOOM, -notch)) < 1e-9)
  let zoom = DEFAULT_ZOOM
  for (let step = 0; step < 100; step += 1) zoom = zoomAfterWheel(zoom, -notch)
  assert.equal(zoom, MAX_ZOOM)
  for (let step = 0; step < 100; step += 1) zoom = zoomAfterWheel(zoom, notch)
  assert.equal(zoom, MIN_ZOOM)
})

// ---------------------------------------------------------------------------- particles

const SPARK = { x: 0, y: 0, z: 0, life: 0.5, size: 4, color: new Color('#ffffff') }

test('only the living particles are kept, drawn and sent: those whose life is over are dropped, and the rest go on', () => {
  const system = new ParticleSystem(100, 'add')
  for (let index = 0; index < 10; index += 1) system.emit({ ...SPARK, life: index < 4 ? 0.1 : 1 })
  assert.equal(system.count, 10)
  system.update(0.05)
  assert.equal(system.count, 10, 'none has lived out its life yet')
  system.update(0.06)
  assert.equal(system.count, 6, 'the four short-lived ones are gone')
  assert.equal(system.points.geometry.drawRange.count, 6, 'and only the living are drawn')
  // (A frame moves them on a tenth of a second at most.)
  for (let frame = 0; frame < 10; frame += 1) system.update(0.1)
  assert.equal(system.count, 0)
  assert.equal(system.points.visible, false, 'with none alive, nothing is drawn at all')
  system.dispose()
})

test('a full pool takes the oldest slot for a new particle, and never holds more than it has room for', () => {
  const room = 8
  const system = new ParticleSystem(room, 'normal')
  for (let index = 0; index < room * 3; index += 1) system.emit(SPARK)
  assert.equal(system.count, room)
  system.update(0.01)
  assert.equal(system.count, room)
  system.dispose()
})

test('a pool that keeps only a share of what is let go (Low quality) makes about that share', () => {
  const keep = 0.35
  const system = new ParticleSystem(10_000, 'add', { keep })
  const sent = 4000
  for (let index = 0; index < sent; index += 1) system.emit(SPARK)
  const share = system.count / sent
  assert.ok(Math.abs(share - keep) < 0.05, `${share} of them made`)
  system.dispose()
})
