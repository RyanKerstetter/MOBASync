import type { Vector2 } from '../../../packages/shared/src/index.ts'

// Holding the right button keeps giving the command it gave when it went down: attack the enemy under the cursor, or
// walk to the cursor, which follows the mouse as it moves and as the champion does. It is not given every frame:
// that would be an order, sent to the server and to every other player, sixty times a second. It is looked at
// once in a while (`HOLD_COMMAND_INTERVAL_MS`), and then only given if it would change anything.
export const HOLD_COMMAND_INTERVAL_MS = 150
// A walk to a place this near the last one given is the same walk, so it is not given again.
export const HOLD_MOVE_MIN_DISTANCE = 16
// A champion this near the place it was sent has got there, so it stopped because it arrived and not because it was
// interrupted.
export const HOLD_ARRIVED_DISTANCE = 24

export type HeldCommand =
  | { type: 'attack'; targetId: number }
  | { type: 'move'; target: Vector2 }

// What is true of the game when the command is looked at.
export type HoldLook = {
  // Where the mouse is, in the world, and the enemy under it, if there is one.
  cursor: Vector2
  enemyId?: number
  // Who the champion is locked on to attacking, where it is, and whether it is walking somewhere.
  attackingId?: number
  position: Vector2
  moving: boolean
}

const distance = (left: Vector2, right: Vector2): number => Math.sqrt((left.x - right.x) ** 2 + (left.y - right.y) ** 2)

export class HoldCommand {
  private isHeld = false
  private lastLookAt = 0
  // Where the last walk it knows of was sent, and whether the champion was walking when it last looked, so a walk
  // that stopped short can be told from one that was never needed.
  private lastMove: Vector2 | undefined
  private wasMoving = false

  get held(): boolean {
    return this.isHeld
  }

  // The button went down, and `given` is what that press did (it is given by the press itself, so the first
  // repeat is one interval later).
  press(now: number, given: HeldCommand): void {
    this.isHeld = true
    this.lastLookAt = now
    this.lastMove = given.type === 'move' ? { ...given.target } : undefined
    this.wasMoving = false
  }

  release(): void {
    this.isHeld = false
    this.lastMove = undefined
    this.wasMoving = false
  }

  // What to give now, if anything, with the button held. Nothing before the interval is up (and `look`, which
  // is not free, is not asked). After it:
  // - on an enemy: attack them, unless the champion is already going after them (the attack goes on by itself);
  // - elsewhere: walk to the cursor, unless that is where the last walk was sent, to within a few units. A walk that
  //   has been cut short is given again though, such as by a cast with a windup, which stops the champion, so it
  //   goes on when the cast is over.
  next(now: number, look: () => HoldLook): HeldCommand | undefined {
    if (!this.isHeld || now - this.lastLookAt < HOLD_COMMAND_INTERVAL_MS) return undefined
    this.lastLookAt = now
    const seen = look()
    const wasMoving = this.wasMoving
    this.wasMoving = seen.moving

    if (seen.enemyId !== undefined) {
      this.lastMove = undefined
      return seen.attackingId === seen.enemyId ? undefined : { type: 'attack', targetId: seen.enemyId }
    }
    if (this.lastMove) {
      const cutShort = wasMoving && !seen.moving && distance(seen.position, this.lastMove) > HOLD_ARRIVED_DISTANCE
      if (!cutShort && distance(this.lastMove, seen.cursor) < HOLD_MOVE_MIN_DISTANCE) return undefined
    }
    this.lastMove = { ...seen.cursor }
    return { type: 'move', target: { ...seen.cursor } }
  }
}
