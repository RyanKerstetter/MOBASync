export type AttackMarkerKind = 'hover' | 'locked'

export type AttackMarker = {
  kind: AttackMarkerKind
  targetId: number
}

export type AttackMarkerShape = {
  // A short tick on each side of the body, pointing in at it, like the corners of a crosshair.
  ticks: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>
}

// Which enemies to mark. The one the attack is locked on is marked for as long as it is. The one
// under the mouse is marked when a click would send an attack at it, so the click that queues one is
// told apart from a click that only walks. Both on the same enemy show only the lock.
export function chooseAttackMarkers(input: {
  hoveredId: number | undefined
  lockedId: number | undefined
}): AttackMarker[] {
  const markers: AttackMarker[] = []
  if (input.lockedId !== undefined) markers.push({ kind: 'locked', targetId: input.lockedId })
  if (input.hoveredId !== undefined && input.hoveredId !== input.lockedId) {
    markers.push({ kind: 'hover', targetId: input.hoveredId })
  }
  return markers
}

// Small and close to the body: a hint, not a second outline.
const GAP = 3
const TICK_LENGTH = 5

export function layoutAttackMarker(bodyRadius: number): AttackMarkerShape {
  const inner = bodyRadius + GAP
  const outer = inner + TICK_LENGTH
  return {
    ticks: [
      { from: { x: 0, y: -outer }, to: { x: 0, y: -inner } },
      { from: { x: outer, y: 0 }, to: { x: inner, y: 0 } },
      { from: { x: 0, y: outer }, to: { x: 0, y: inner } },
      { from: { x: -outer, y: 0 }, to: { x: -inner, y: 0 } },
    ],
  }
}

// The hover mark is a pale, thin hint; the lock is a little heavier and red.
export const ATTACK_MARKER_STYLE: Record<AttackMarkerKind, { color: string; width: number; alpha: number }> = {
  hover: { color: '#ffd27a', width: 1.5, alpha: 0.8 },
  locked: { color: '#ff5a5f', width: 2, alpha: 0.95 },
}
