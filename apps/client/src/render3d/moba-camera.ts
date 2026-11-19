import type { Vector2 } from '../../../../packages/shared/src/index.ts'

export type Size = { width: number; height: number }
export type Point3 = { x: number; y: number; z: number }

// The camera of the 3D view: looking down on the champion from the south at a steep angle, as in other MOBAs, so the map
// reads much as it does from straight above while what stands on it has height. The field of view is narrow, so things far
// up the screen are not much smaller than things near the bottom.
export const CAMERA_PITCH_DEGREES = 56
export const CAMERA_FOV_DEGREES = 34
// The champion is put a little below the middle of the screen, as other MOBAs do, since more of what is ahead is up the
// screen. As a share of the screen's height.
export const CAMERA_FOCUS_DROP = 0.04

export type MobaCameraPose = {
  position: Point3
  target: Point3
  fov: number
  // How far the camera is from what it looks at.
  distance: number
}

// Where the camera stands to look at `center` with the screen showing about as much of the world as the 2D view would:
// at the point looked at, the screen's height covers the height of the world the 2D camera fits on the screen
// (`computeCamera`), so a wider screen shows more on its long side here too.
export function mobaCameraPose(screen: Size, view: Size, center: Vector2): MobaCameraPose {
  const scale = Math.min(screen.width / view.width, screen.height / view.height)
  const visibleHeight = screen.height / scale
  const fov = CAMERA_FOV_DEGREES
  const halfFov = (fov / 2) * Math.PI / 180
  const distance = visibleHeight / (2 * Math.tan(halfFov))
  const pitch = CAMERA_PITCH_DEGREES * Math.PI / 180
  // The point looked at is moved up the map a little, so the champion sits a little below the middle of the screen.
  const lead = visibleHeight * CAMERA_FOCUS_DROP / Math.sin(pitch)
  const target = { x: center.x, y: 0, z: center.y - lead }
  return {
    target,
    position: { x: target.x, y: Math.sin(pitch) * distance, z: target.z + Math.cos(pitch) * distance },
    fov,
    distance,
  }
}

// Where a ray from `origin` going `direction` meets the ground plane at `height`, as a point of the world, or nothing if it
// never does (it points up, or along it).
export function rayToGround(origin: Point3, direction: Point3, height = 0): Vector2 | undefined {
  if (direction.y >= -1e-9) return undefined
  const t = (height - origin.y) / direction.y
  if (t < 0) return undefined
  return { x: origin.x + direction.x * t, y: origin.z + direction.z * t }
}

// Whether a ray passes through an upright cylinder standing on the ground at `base` (a body), and how far along it does.
export function rayHitsCylinder(origin: Point3, direction: Point3, base: Vector2, radius: number, height: number): number | undefined {
  // Across the ground, the ray is a line; the cylinder is a circle.
  const ox = origin.x - base.x
  const oz = origin.z - base.y
  const a = direction.x * direction.x + direction.z * direction.z
  // Through its side (a ray straight down has none to go through).
  if (a > 1e-12) {
    const b = 2 * (ox * direction.x + oz * direction.z)
    const c = ox * ox + oz * oz - radius * radius
    const disc = b * b - 4 * a * c
    if (disc < 0) return undefined
    const root = Math.sqrt(disc)
    for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
      if (t < 0) continue
      const y = origin.y + direction.y * t
      if (y >= 0 && y <= height) return t
    }
  }
  // It may come in through the top.
  if (direction.y < 0) {
    const t = (height - origin.y) / direction.y
    const x = origin.x + direction.x * t - base.x
    const z = origin.z + direction.z * t - base.y
    if (t >= 0 && x * x + z * z <= radius * radius) return t
  }
  return undefined
}
