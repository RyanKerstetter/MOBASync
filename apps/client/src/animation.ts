import type { Vector2 } from '../../../packages/shared/src/index.ts'

// Everything a champion can be shown doing. A sprite set gives the clips it has, and a state it has no
// clip for is shown as the next one along that it does have (see `chooseAnimation`), so a set can
// start with a walk and an idle and gain attacks, casts and the rest one clip at a time.
export type AnimationKey = 'idle' | 'walk' | 'attack' | 'cast' | 'hurt' | 'dead'

// How a clip plays: `frames` frames at `fps`, round and round, or once and then holding the last.
export type AnimationClip = {
  frames: number
  fps: number
  loop: boolean
  // For a clip that is an action: its frames are spread over the action, so the last lands as the
  // action does (an attack's hit), however long the windup is, instead of running at `fps`.
  syncToAction?: boolean
  // With `syncToAction`, only the first this many frames are spread over the action, and the rest play
  // at `fps` once it is over, so the last frames show the champion is free again (an attack's
  // follow-through). The default is all of them.
  syncFrames?: number
  // How long each frame shows, in milliseconds, instead of the same time at `fps`: a death that sits
  // on its first frame for a moment before it falls. A clip that does not loop holds its last.
  frameMs?: readonly number[]
}

// Which way a champion is facing on screen: 1 to the right, -1 to the left.
export type Facing = 1 | -1

// An action in progress: what it is, how far through it (0 just started, 1 done), and where it is
// aimed, which is the way the champion turns to face while it does it.
export type ActionView = {
  kind: 'attack' | 'cast'
  progress: number
  aimAt?: Vector2
}

// What a champion is doing this frame, as far as its animation cares.
export type AnimationIntent = {
  dead: boolean
  moving: boolean
  // What it is in the middle of, if anything: an auto attack or an ability.
  action?: 'attack' | 'cast'
}

// What to draw: a clip, a frame of it, and which way.
export type AnimationFrame = {
  key: AnimationKey
  frame: number
  facing: Facing
}

// What the animator is told each frame: where the champion is drawn, and what it is doing.
export type AnimatorInput = {
  position: Vector2
  dead: boolean
  action?: ActionView
  // A clock in milliseconds, such as performance.now().
  now: number
}

// The clip to show, given what the champion is doing and which clips its set has: the most important
// thing it is doing that the set has a clip for. Being dead comes first, then what it is in the middle
// of, then walking, and standing about is what is left. Undefined only for a set with no idle and
// nothing else that fits.
export function chooseAnimation(
  intent: AnimationIntent,
  has: (key: AnimationKey) => boolean,
): AnimationKey | undefined {
  const wanted: AnimationKey[] = []
  if (intent.dead) wanted.push('dead')
  if (intent.action) wanted.push(intent.action)
  if (intent.moving) wanted.push('walk')
  wanted.push('idle')
  return wanted.find(has)
}

// Which frame of a clip is showing this long after it started.
export function frameAt(clip: AnimationClip, elapsedMs: number): number {
  if (clip.frameMs) {
    let left = Math.max(0, elapsedMs)
    if (clip.loop) left %= clip.frameMs.reduce((total, ms) => total + ms, 0)
    for (let frame = 0; frame < clip.frames; frame += 1) {
      left -= clip.frameMs[frame] ?? 1000 / clip.fps
      if (left < 0) return frame
    }
    return clip.frames - 1
  }
  const index = Math.floor(Math.max(0, elapsedMs) * clip.fps / 1000)
  return clip.loop ? index % clip.frames : Math.min(index, clip.frames - 1)
}

// A walk that pauses for less than this still counts as walking, so a frame drawn in the same place
// as the last does not flicker the champion into standing.
export const MOVING_GRACE_MS = 120
// Less than this in a frame is not walking: a champion nudged a hair is standing still.
const MOVE_EPSILON = 0.05
// More than this in one frame is a jump, such as a respawn or a blink, not a step.
const JUMP_DISTANCE = 80
// The champion only turns round once it has gone this far the other way in a straight run. A drawn
// position wobbles a little backwards now and then (a correction from the server, a push from
// someone beside it, the camera and the smoothing catching up), and that must not flip it.
export const TURN_DISTANCE = 4

// Keeps track of one champion's animation from frame to frame. It works out whether the champion is
// walking, and which way it faces, from where it is drawn, so what plays always matches what is on
// screen, remote champions drawn a little in the past included. A clip starts from its first frame
// whenever it changes. It knows nothing of how the frames are drawn.
export class CharacterAnimator {
  private key: AnimationKey | undefined
  private startedAt = 0
  private facing: Facing
  private lastPosition: Vector2 | undefined
  // How far across the screen it has gone in one direction since it last went the other, and which.
  private run = 0
  // The follow-through of a synced clip that has just ended, for as long as it lasts.
  private followThrough: { key: AnimationKey; startedAt: number } | undefined
  // The clip that was showing for an action last frame, to know when the action ends.
  private lastSynced: AnimationKey | undefined
  private lastMovedAt = Number.NEGATIVE_INFINITY

  constructor(facing: Facing = 1) {
    this.facing = facing
  }

  update(input: AnimatorInput, clips: Readonly<Partial<Record<AnimationKey, AnimationClip>>>): AnimationFrame | undefined {
    const { position, now } = input
    if (this.lastPosition) {
      const dx = position.x - this.lastPosition.x
      const dy = position.y - this.lastPosition.y
      const distance = Math.hypot(dx, dy)
      if (distance > MOVE_EPSILON && distance <= JUMP_DISTANCE) {
        this.lastMovedAt = now
        // Straight up or down the screen keeps the way it was facing.
        if (Math.abs(dx) > MOVE_EPSILON) {
          const way: Facing = dx > 0 ? 1 : -1
          // A step the same way as the run adds to it; one the other way starts a new run, so a
          // wobble back followed by more going forward never gets far enough to turn it.
          this.run = Math.sign(this.run) === way ? this.run + dx : dx
          if (way !== this.facing && Math.abs(this.run) >= TURN_DISTANCE) this.facing = way
          else if (way === this.facing) this.run = 0
        }
      }
    }
    this.lastPosition = { x: position.x, y: position.y }

    // Doing something aimed, it turns to face what it is aimed at at once.
    if (input.action?.aimAt && !input.dead) {
      const toward = input.action.aimAt.x - position.x
      if (Math.abs(toward) > MOVE_EPSILON) {
        this.facing = toward > 0 ? 1 : -1
        this.run = 0
      }
    }

    const moving = !input.dead && now - this.lastMovedAt < MOVING_GRACE_MS
    const key = chooseAnimation(
      { dead: input.dead, moving, ...(input.action ? { action: input.action.kind } : {}) },
      (candidate) => clips[candidate] !== undefined,
    )
    // An action that has just ended carries on into the clip's last frames, unless the champion has
    // started to do something else, which is what those frames are telling it it can.
    if (this.lastSynced && !input.action && !input.dead) {
      this.followThrough = { key: this.lastSynced, startedAt: now }
    }
    this.lastSynced = undefined
    if (this.followThrough) {
      const tail = this.followThrough
      const tailClip = clips[tail.key]
      const lead = tailClip?.syncFrames ?? tailClip?.frames ?? 0
      const frame = tailClip ? lead + Math.floor((now - tail.startedAt) * tailClip.fps / 1000) : 0
      if (!tailClip || input.action || input.dead || moving || frame >= tailClip.frames) {
        this.followThrough = undefined
      } else {
        this.key = tail.key
        return { key: tail.key, frame, facing: this.facing }
      }
    }
    const clip = key === undefined ? undefined : clips[key]
    if (key === undefined || !clip) return undefined
    if (key !== this.key) {
      this.key = key
      this.startedAt = now
    }
    const synced = clip.syncToAction && input.action !== undefined && input.action.kind === key
    if (synced) this.lastSynced = key
    const lead = clip.syncFrames ?? clip.frames
    const frame = synced
      ? Math.min(lead - 1, Math.floor(Math.max(0, input.action!.progress) * lead))
      : frameAt(clip, now - this.startedAt)
    return { key, frame, facing: this.facing }
  }
}
