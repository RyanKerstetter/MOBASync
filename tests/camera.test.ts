import assert from 'node:assert/strict'
import test from 'node:test'
import { computeCamera, screenToWorld } from '../apps/client/src/camera.ts'

const view = { width: 800, height: 450 }

function worldToScreen(camera: { scale: number; x: number; y: number }, point: { x: number; y: number }) {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y }
}

test('the champion the camera is locked on is always the middle of the screen', () => {
  const screen = { width: 1920, height: 1080 }
  for (const center of [{ x: 1200, y: 675 }, { x: 5, y: 5 }, { x: 2395, y: 1340 }, { x: 733.5, y: 91.25 }]) {
    const camera = computeCamera(screen, view, center)
    const onScreen = worldToScreen(camera, center)
    assert.ok(Math.abs(onScreen.x - 960) < 1e-9 && Math.abs(onScreen.y - 540) < 1e-9, `centre ${center.x},${center.y}`)
  }
})

test('the scale fits the view inside the screen, so any screen shows at least the whole view', () => {
  const center = { x: 1200, y: 675 }
  // The same shape as the view: exactly the view, no more.
  assert.equal(computeCamera({ width: 1920, height: 1080 }, view, center).scale, 2.4)
  // Wider than the view: the height fits, so more of the world is visible to the sides.
  const wide = computeCamera({ width: 2560, height: 1080 }, view, center)
  assert.equal(wide.scale, 2.4)
  assert.ok(2560 / wide.scale > view.width)
  // Taller than the view: the width fits, so more is visible above and below.
  const tall = computeCamera({ width: 1000, height: 1000 }, view, center)
  assert.equal(tall.scale, 1.25)
  assert.ok(1000 / tall.scale > view.height)
  for (const screen of [{ width: 1920, height: 1080 }, { width: 2560, height: 1080 }, { width: 1000, height: 1000 }, { width: 640, height: 480 }]) {
    const camera = computeCamera(screen, view, center)
    assert.ok(screen.width / camera.scale >= view.width - 1e-9, 'the view fits across')
    assert.ok(screen.height / camera.scale >= view.height - 1e-9, 'and down')
  }
})

test('a point on the screen converts back to the world point beneath it', () => {
  const camera = computeCamera({ width: 1600, height: 900 }, view, { x: 900, y: 400 })
  for (const world of [{ x: 900, y: 400 }, { x: 0, y: 0 }, { x: 2400, y: 1350 }, { x: 1234.5, y: 678.9 }]) {
    const back = screenToWorld(camera, worldToScreen(camera, world))
    assert.ok(Math.abs(back.x - world.x) < 1e-9 && Math.abs(back.y - world.y) < 1e-9)
  }
  // The middle of the screen is the champion.
  assert.deepEqual(screenToWorld(camera, { x: 800, y: 450 }), { x: 900, y: 400 })
})

test('a still mouse points at a different world point as the champion walks', () => {
  const screen = { width: 1600, height: 900 }
  const mouse = { x: 1200, y: 300 }
  const before = screenToWorld(computeCamera(screen, view, { x: 1000, y: 600 }), mouse)
  const after = screenToWorld(computeCamera(screen, view, { x: 1080, y: 560 }), mouse)

  // Walking 80 right and 40 up moves the aimed point by the same amount, which is why aiming
  // converts the mouse at the moment it is used instead of remembering a world point.
  assert.deepEqual({ x: after.x - before.x, y: after.y - before.y }, { x: 80, y: -40 })
})
