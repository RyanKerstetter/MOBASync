import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { menuTabs, RENDERER_LABELS, type MenuItem } from '../apps/client/src/game-menu.ts'
import { DEFAULT_SETTINGS, loadSettings } from '../apps/client/src/game-settings.ts'
import { DEFAULT_RENDERER, RENDERER_KINDS, rendererFromSearch, type RendererKind } from '../apps/client/src/render/renderer-kind.ts'
import { CAMERA_FOCUS_DROP, CAMERA_PITCH_DEGREES, mobaCameraPose, rayHitsCylinder, rayToGround } from '../apps/client/src/render3d/moba-camera.ts'
import { pathTilesOf } from '../apps/client/src/render3d/map-paths.ts'
import { GAME_ART_SCALE, GAME_VIEW_HEIGHT, GAME_VIEW_WIDTH, mapWorldScale, parseTiledMap, readMapLayout } from '../packages/shared/src/index.ts'

const VIEW = { width: GAME_VIEW_WIDTH, height: GAME_VIEW_HEIGHT }

// ---------------------------------------------------------------------------- which renderer

test('the world is drawn in 3D unless the player or the address asks for 2D', () => {
  assert.equal(DEFAULT_SETTINGS.renderer, DEFAULT_RENDERER)
  assert.equal(DEFAULT_RENDERER, '3d')
  assert.deepEqual([...RENDERER_KINDS].sort(), ['2d', '3d'])
  assert.equal(rendererFromSearch('?renderer=2d'), '2d')
  assert.equal(rendererFromSearch('?vision=off&renderer=3D'), '3d', 'in any case, among other settings')
  assert.equal(rendererFromSearch('?renderer=4d'), undefined, 'one there is not is no answer')
  assert.equal(rendererFromSearch(''), undefined)
  // A stored renderer that is not one of them is the default.
  const stored = (value: unknown) => ({ getItem: () => JSON.stringify({ renderer: value }), setItem: () => undefined })
  for (const kind of RENDERER_KINDS) assert.equal(loadSettings(stored(kind)).renderer, kind)
  assert.equal(loadSettings(stored('sideways')).renderer, DEFAULT_RENDERER)
  assert.equal(loadSettings(stored(3)).renderer, DEFAULT_RENDERER)
})

test('the Graphics tab offers the renderer first, when the game can change it, and changing it calls through', () => {
  const noop = (): void => undefined
  const base = {
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
  const without = menuTabs(base).find((tab) => tab.id === 'graphics')
  assert.ok(without?.sections.every((section) => section.title !== 'View'), 'no choice it cannot make')

  let current: RendererKind = DEFAULT_RENDERER
  const graphics = menuTabs({ ...base, getRenderer: () => current, setRenderer: (kind) => { current = kind } }).find((tab) => tab.id === 'graphics')
  const [view] = graphics?.sections ?? []
  assert.equal(view?.title, 'View')
  const choice = view?.items[0] as Extract<MenuItem, { kind: 'choice' }>
  assert.equal(choice.kind, 'choice')
  assert.deepEqual(choice.options.map((option) => option.value), [...RENDERER_KINDS])
  assert.deepEqual(choice.options.map((option) => option.label), RENDERER_KINDS.map((kind) => RENDERER_LABELS[kind]))
  assert.equal(choice.get(), DEFAULT_RENDERER)
  const other = RENDERER_KINDS.find((kind) => kind !== DEFAULT_RENDERER) as RendererKind
  choice.set(other)
  assert.equal(current, other)
  assert.equal(choice.get(), other, 'and the menu shows it')
})

// ---------------------------------------------------------------------------- the camera

test('the 3D camera looks down on the champion from the south at its pitch, with the champion a little below the middle', () => {
  const screen = { width: 1920, height: 1080 }
  const center = { x: 1000, y: 700 }
  const pose = mobaCameraPose(screen, VIEW, center)
  const pitch = Math.atan2(pose.position.y - pose.target.y, pose.position.z - pose.target.z) * 180 / Math.PI
  assert.ok(Math.abs(pitch - CAMERA_PITCH_DEGREES) < 1e-9, `pitched at ${pitch}`)
  assert.equal(pose.position.x, center.x, 'straight up the screen, not turned')
  assert.ok(pose.position.z > center.y, 'from the south, the bottom of the screen')
  assert.equal(pose.target.y, 0, 'at the ground')
  // The point looked at is up the map from the champion by the share of the screen it is dropped by.
  const scale = Math.min(screen.width / VIEW.width, screen.height / VIEW.height)
  const lead = screen.height / scale * CAMERA_FOCUS_DROP / Math.sin(CAMERA_PITCH_DEGREES * Math.PI / 180)
  assert.ok(Math.abs(center.y - pose.target.z - lead) < 1e-9)
  // A ray down the middle of the view lands on the point looked at.
  const direction = { x: pose.target.x - pose.position.x, y: pose.target.y - pose.position.y, z: pose.target.z - pose.position.z }
  const landed = rayToGround(pose.position, direction)
  assert.ok(landed && Math.abs(landed.x - pose.target.x) < 1e-6 && Math.abs(landed.y - pose.target.z) < 1e-6)
})

test('the 3D view shows as much of the world up the screen as the 2D view, at the point looked at, and more across a wider screen', () => {
  for (const screen of [{ width: 1920, height: 1080 }, { width: 2560, height: 1080 }, { width: 1280, height: 1024 }]) {
    const pose = mobaCameraPose(screen, VIEW, { x: 0, y: 0 })
    const scale = Math.min(screen.width / VIEW.width, screen.height / VIEW.height)
    const shown = 2 * pose.distance * Math.tan(pose.fov / 2 * Math.PI / 180)
    assert.ok(Math.abs(shown - screen.height / scale) < 1e-6, `${screen.width}x${screen.height}`)
  }
})

test('a ray finds the ground under it, and a body it passes through, and misses what it does not', () => {
  const eye = { x: 0, y: 100, z: 100 }
  assert.deepEqual(rayToGround(eye, { x: 0, y: -1, z: -1 }), { x: 0, y: 0 })
  assert.equal(rayToGround(eye, { x: 0, y: 1, z: -1 }), undefined, 'one going up never lands')
  assert.equal(rayToGround(eye, { x: 1, y: 0, z: 0 }), undefined, 'nor one going along it')
  // A body standing where the ray lands, and one off to the side.
  const down = { x: 0, y: -1, z: -1 }
  const hit = rayHitsCylinder(eye, down, { x: 0, y: 10 }, 20, 60)
  assert.ok(hit !== undefined && hit > 0)
  assert.equal(rayHitsCylinder(eye, down, { x: 200, y: 0 }, 20, 60), undefined)
  // Straight down onto its top.
  assert.ok(rayHitsCylinder({ x: 5, y: 500, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0 }, 20, 60) !== undefined)
  // Over a short body, and past it.
  assert.equal(rayHitsCylinder(eye, { x: 0, y: -0.1, z: -1 }, { x: 0, y: 0 }, 20, 10), undefined)
})

// ---------------------------------------------------------------------------- the map

test('the 3D ground lays its paths where the maps draw their path layers, in world units', () => {
  for (const id of ['competetive', '4-player-competetive']) {
    const map = parseTiledMap(JSON.parse(readFileSync(new URL(`../res/maps/${id}.tmj`, import.meta.url), 'utf-8')))
    const { arenaRect, terrain } = readMapLayout(map)
    const scale = mapWorldScale(map, GAME_ART_SCALE)
    const tiles = pathTilesOf(map, arenaRect, scale)
    assert.ok(tiles.length > 0, `${id} has paths`)
    for (const tile of tiles) {
      assert.equal(tile.width, map.tilewidth * scale)
      assert.equal(tile.height, map.tileheight * scale)
    }
    // Most of the path is on the arena.
    const onArena = tiles.filter((tile) => tile.x + tile.width > 0 && tile.y + tile.height > 0 && tile.x < terrain.width && tile.y < terrain.height)
    assert.ok(onArena.length > tiles.length / 2, `${id}: ${onArena.length} of ${tiles.length} on the arena`)
  }
})
