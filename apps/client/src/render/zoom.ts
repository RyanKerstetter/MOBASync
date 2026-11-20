// How far the camera can be zoomed with the mouse wheel, as a multiple of the usual view (1): more than 1 is closer in, and less than
// 1 is further out, showing more of the map. These are the numbers to change to let players zoom further either way.
export const MIN_ZOOM = 0.8
export const MAX_ZOOM = 1.5
export const DEFAULT_ZOOM = 1
// How much one notch of the wheel zooms, as a multiple: in by this much, or out by its inverse.
export const ZOOM_PER_NOTCH = 1.1

// A zoom held to what is allowed: a number is kept between the least and the most, and anything else is the usual view.
export function readZoom(stored: unknown): number {
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return DEFAULT_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, stored))
}

// The zoom after the wheel turns: `deltaY` as a wheel event gives it (negative is toward the screen, which zooms in). A notch is 100 or
// so; a touchpad gives many small turns, which come to the same.
export function zoomAfterWheel(zoom: number, deltaY: number): number {
  return readZoom(zoom * ZOOM_PER_NOTCH ** (-deltaY / 100))
}
