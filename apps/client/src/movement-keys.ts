import type { Vector2 } from '../../../packages/shared/src/index.ts'

// With the movement keys on (the controls menu), W, A, S and D steer the champion, and its abilities move off W to Q, E and R. The champion is told the direction the
// keys held make, never the keys themselves, and only when that direction changes: holding a key down sends nothing more.
export const MOVEMENT_KEY_DIRECTIONS: Readonly<Record<string, Vector2>> = {
  KeyW: { x: 0, y: -1 },
  KeyA: { x: -1, y: 0 },
  KeyS: { x: 0, y: 1 },
  KeyD: { x: 1, y: 0 },
}

// The keys that cast each ability slot, the first slot first: Q, W, E and R, or with the movement keys on Q, E and R, as W steers.
export function abilityKeyCodes(movementKeys: boolean): readonly string[] {
  return movementKeys ? ['KeyQ', 'KeyE', 'KeyR'] : ['KeyQ', 'KeyW', 'KeyE', 'KeyR']
}

// What a key is called on screen: its letter.
export const keyLabel = (code: string): string => code.replace(/^Key/, '')

// The champion stands though the keys still steer it, and the direction has been given again: how long to wait before giving it once more (see `MovementKeys.resume`).
export const STEER_RESUME_INTERVAL_MS = 150

const STOP: Vector2 = { x: 0, y: 0 }

export function isMovementKey(code: string): boolean {
  return Object.hasOwn(MOVEMENT_KEY_DIRECTIONS, code)
}

export class MovementKeys {
  private readonly held = new Set<string>()
  // The direction the champion was last given, while steering is the last thing it was told to do. None when it has not been, was told to stop, or was told something
  // else since (a right-click, an attack).
  private steering: Vector2 | undefined
  // Whether it has been given a direction since it was last told to stop. Being told something else since does not settle it, as what it was told may not have been
  // done (an attack on someone who cannot be attacked leaves it walking): so the stop is given when the last key is let go, and a stop to one that is not steered does nothing.
  private unstopped = false
  private lastGivenAt = -Infinity

  // The direction the keys held make: one key's way, halfway between two that are at right angles (a unit vector, as the game takes it), and none for two that are
  // opposite or for no key.
  get direction(): Vector2 {
    let x = 0
    let y = 0
    for (const code of this.held) {
      x += MOVEMENT_KEY_DIRECTIONS[code].x
      y += MOVEMENT_KEY_DIRECTIONS[code].y
    }
    if (x !== 0 && y !== 0) return { x: x * Math.SQRT1_2, y: y * Math.SQRT1_2 }
    return { x, y }
  }

  // Whether the keys are steering the champion now.
  get isSteering(): boolean {
    return this.steering !== undefined
  }

  // A movement key went down or came up. What comes back is what to give the champion now, if anything: the new direction, when the keys make one other than the one
  // given; a stop ({0, 0}) when they make none and it has been steered since the last stop; and nothing otherwise (a key that is already down, or one that changes nothing).
  press(code: string, now: number): Vector2 | undefined {
    if (!isMovementKey(code) || this.held.has(code)) return undefined
    this.held.add(code)
    return this.change(now)
  }

  release(code: string, now: number): Vector2 | undefined {
    if (!this.held.delete(code)) return undefined
    return this.change(now)
  }

  // Every key is let go, as when the window loses focus (a key let go then never says so) or the menu opens.
  releaseAll(now: number): Vector2 | undefined {
    this.held.clear()
    return this.change(now)
  }

  // The champion was told something other than to steer: the keys do not steer it again until they change, and it is not given its direction again (`resume`).
  interrupt(): void {
    this.steering = undefined
  }

  // The champion stands about though the keys still steer it, because the game stopped it (a fear that ran out, coming back to life): the direction to give it again,
  // at most once an interval, so that a champion that cannot walk is not told to again and again.
  resume(now: number, idle: boolean): Vector2 | undefined {
    if (!this.steering || !idle || now - this.lastGivenAt < STEER_RESUME_INTERVAL_MS) return undefined
    this.lastGivenAt = now
    return { ...this.steering }
  }

  private change(now: number): Vector2 | undefined {
    const direction = this.direction
    if (direction.x === 0 && direction.y === 0) {
      this.steering = undefined
      if (!this.unstopped) return undefined
      this.unstopped = false
      return { ...STOP }
    }
    if (this.steering && this.steering.x === direction.x && this.steering.y === direction.y) return undefined
    this.steering = direction
    this.unstopped = true
    this.lastGivenAt = now
    return { ...direction }
  }
}
