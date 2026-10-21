import type { Vector2 } from '../../../packages/shared/src/index.ts'

export type Size = { width: number; height: number }

// Where the world sits on screen: scale it, then move it by (x, y).
export type Camera = { scale: number; x: number; y: number }

// A camera locked on `center`: that world point is always the middle of the screen. The scale
// fits `view` (how much of the world should be visible at least) inside the screen, so a wider
// or taller screen shows more of the world instead of leaving bars.
export function computeCamera(screen: Size, view: Size, center: Vector2): Camera {
  const scale = Math.min(screen.width / view.width, screen.height / view.height)
  return {
    scale,
    x: screen.width / 2 - center.x * scale,
    y: screen.height / 2 - center.y * scale,
  }
}

// The world point under a point on the screen, such as the mouse.
export function screenToWorld(camera: Camera, point: Vector2): Vector2 {
  return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale }
}
