import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CharacterAnimator,
  chooseAnimation,
  frameAt,
  MOVING_GRACE_MS,
  TURN_DISTANCE,
  type AnimationClip,
  type AnimationKey,
} from '../apps/client/src/animation.ts'
import { championSprites } from '../apps/client/src/champion-sprites.ts'
import { champions } from '../packages/shared/src/index.ts'

const idle: AnimationClip = { frames: 4, fps: 6, loop: true }
const walk: AnimationClip = { frames: 4, fps: 8, loop: true }
const clips: Partial<Record<AnimationKey, AnimationClip>> = { idle, walk }
const at = { x: 100, y: 100 }

test('a looping clip goes round its frames at its rate, and one that plays once holds the last', () => {
  // 8 a second is a frame every 125 ms.
  assert.deepEqual([0, 124, 125, 375, 499, 500, 625].map((ms) => frameAt(walk, ms)), [0, 0, 1, 3, 3, 0, 1])
  const once: AnimationClip = { frames: 3, fps: 10, loop: false }
  assert.deepEqual([0, 100, 250, 1000].map((ms) => frameAt(once, ms)), [0, 1, 2, 2])
  assert.equal(frameAt(walk, -50), 0, 'a clock that has not reached the start is the first frame')
})

test('the clip shown is the most important thing the champion is doing that its set has a clip for', () => {
  const has = (...keys: AnimationKey[]) => (key: AnimationKey) => keys.includes(key)
  const all = has('idle', 'walk', 'attack', 'cast', 'dead')

  assert.equal(chooseAnimation({ dead: false, moving: false }, all), 'idle')
  assert.equal(chooseAnimation({ dead: false, moving: true }, all), 'walk')
  assert.equal(chooseAnimation({ dead: false, moving: true, action: 'attack' }, all), 'attack', 'an attack beats walking')
  assert.equal(chooseAnimation({ dead: false, moving: false, action: 'cast' }, all), 'cast')
  assert.equal(chooseAnimation({ dead: true, moving: false, action: 'cast' }, all), 'dead', 'and being dead beats everything')

  // A set without a clip shows the next thing along that it has.
  const walkAndIdle = has('idle', 'walk')
  assert.equal(chooseAnimation({ dead: false, moving: true, action: 'attack' }, walkAndIdle), 'walk', 'attacking on the move, with no attack clip, walks')
  assert.equal(chooseAnimation({ dead: false, moving: false, action: 'cast' }, walkAndIdle), 'idle')
  assert.equal(chooseAnimation({ dead: true, moving: false }, walkAndIdle), 'idle')
  assert.equal(chooseAnimation({ dead: false, moving: true }, has('idle')), 'idle')
  assert.equal(chooseAnimation({ dead: false, moving: false }, has('walk')), undefined, 'and with nothing that fits, nothing')
})

test('a champion standing still idles, and walks once it moves', () => {
  const animator = new CharacterAnimator()
  assert.equal(animator.update({ position: at, dead: false, now: 0 }, clips)?.key, 'idle')
  assert.equal(animator.update({ position: at, dead: false, now: 16 }, clips)?.key, 'idle', 'still standing')
  assert.equal(animator.update({ position: { x: 102, y: 100 }, dead: false, now: 32 }, clips)?.key, 'walk')
})

test('a clip starts from its first frame when it changes, and runs on its own clock', () => {
  const animator = new CharacterAnimator()
  animator.update({ position: at, dead: false, now: 0 }, clips)
  // Idle for 400 ms: frame 2 at 6 a second.
  assert.equal(animator.update({ position: at, dead: false, now: 400 }, clips)?.frame, 2)
  // It starts walking at 1190 ms, part way through where the walk would be if it had been running all
  // along: the walk begins at its first frame anyway, then steps every 125 ms.
  const start = 1190
  let x = 100
  const step = (now: number) => {
    x += 2
    return animator.update({ position: { x, y: 100 }, dead: false, now }, clips)
  }
  assert.deepEqual(step(start), { key: 'walk', frame: 0, facing: 1 })
  assert.equal(step(start + 100)?.frame, 0)
  assert.equal(step(start + 130)?.frame, 1)
  assert.equal(step(start + 380)?.frame, 3)
  assert.equal(step(start + 500)?.frame, 0, 'and round again')
})

test('a pause shorter than the grace does not flicker the walk, and a longer one goes back to idle', () => {
  const animator = new CharacterAnimator()
  animator.update({ position: at, dead: false, now: 0 }, clips)
  animator.update({ position: { x: 102, y: 100 }, dead: false, now: 16 }, clips)
  // A frame drawn in the same place, as remote champions sometimes are.
  assert.equal(animator.update({ position: { x: 102, y: 100 }, dead: false, now: 32 }, clips)?.key, 'walk')
  assert.equal(animator.update({ position: { x: 102, y: 100 }, dead: false, now: 16 + MOVING_GRACE_MS - 1 }, clips)?.key, 'walk')
  assert.equal(animator.update({ position: { x: 102, y: 100 }, dead: false, now: 16 + MOVING_GRACE_MS }, clips)?.key, 'idle')
})

test('the champion faces the way it last moved across the screen, and keeps it standing or moving up and down', () => {
  const animator = new CharacterAnimator()
  animator.update({ position: at, dead: false, now: 0 }, clips)
  let x = 100
  let now = 0
  const go = (dx: number, dy = 0) => animator.update({ position: { x: (x += dx), y: 100 + dy }, dead: false, now: (now += 16) }, clips)
  // Walking left: it turns once it has gone TURN_DISTANCE, not on the first step.
  assert.equal(go(-2)?.facing, 1, 'not on the first step')
  assert.equal(go(-TURN_DISTANCE)?.facing, -1, 'left')
  assert.equal(go(0, 4)?.facing, -1, 'still left, going down')
  now += 500
  assert.equal(go(0)?.facing, -1, 'and standing')
  assert.equal(go(TURN_DISTANCE + 1)?.facing, 1, 'then right')

  // A set whose art faces left starts out facing left.
  assert.equal(new CharacterAnimator(-1).update({ position: at, dead: false, now: 0 }, clips)?.facing, -1)
})

test('a wobble backwards while walking does not turn the champion round', () => {
  const animator = new CharacterAnimator()
  let x = 100
  let now = 0
  const go = (dx: number) => animator.update({ position: { x: (x += dx), y: 100 }, dead: false, now: (now += 16) }, clips)
  go(0)
  // Walking right at 2.5 a frame with a step back of a pixel or two every few frames, as the drawn
  // position does when it is corrected or pushed.
  const facings = [2.5, 2.5, -1.5, 2.5, 2.5, -2, 2.5, -1, -1, 2.5, 2.5, 2.5].map((dx) => go(dx)?.facing)
  assert.deepEqual(facings, facings.map(() => 1))
  // But a real turn still turns it.
  assert.equal(go(-2.5)?.facing, 1)
  assert.equal(go(-2.5)?.facing, -1)
})

test('a jump across the map is not a walk, and a dead champion does not walk', () => {
  const animator = new CharacterAnimator()
  animator.update({ position: at, dead: false, now: 0 }, clips)
  // A respawn or a blink: far in one frame.
  const jumped = animator.update({ position: { x: 900, y: 100 }, dead: false, now: 16 }, clips)
  assert.equal(jumped?.key, 'idle')
  assert.equal(jumped?.facing, 1, 'and it does not turn the champion round')

  const dying = new CharacterAnimator()
  dying.update({ position: at, dead: false, now: 0 }, clips)
  assert.equal(dying.update({ position: { x: 102, y: 100 }, dead: true, now: 16 }, clips)?.key, 'idle', 'with no dead clip, it stands')
})

const attack: AnimationClip = { frames: 4, fps: 12, loop: false, syncToAction: true }

test('an attack clip is spread over the attack, so its last frame is the hit however long the windup', () => {
  const animator = new CharacterAnimator()
  const withAttack = { ...clips, attack }
  const frameAtProgress = (progress: number, now: number) =>
    animator.update({ position: at, dead: false, action: { kind: 'attack', progress }, now }, withAttack)

  assert.deepEqual(frameAtProgress(0, 0)?.key, 'attack')
  assert.deepEqual([0, 0.24, 0.25, 0.5, 0.74, 0.75, 0.99, 1].map((p, i) => frameAtProgress(p, 10 + i)?.frame), [0, 0, 1, 2, 2, 3, 3, 3])
  // It does not run on the clock: a slow attack and a quick one both fill the same four frames.
  assert.equal(frameAtProgress(0.3, 100000)?.frame, 1)
  // Done, it is back to standing.
  assert.equal(animator.update({ position: at, dead: false, now: 100001 }, withAttack)?.key, 'idle')
})

test('an attack spreads its first three frames over the windup and plays the last after the hit, until the champion moves on', () => {
  const swing: AnimationClip = { frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 3 }
  const withSwing = { ...clips, attack: swing }
  const animator = new CharacterAnimator()
  const during = (progress: number, now: number) =>
    animator.update({ position: at, dead: false, action: { kind: 'attack', progress }, now }, withSwing)
  const after = (now: number, position = at) => animator.update({ position, dead: false, now }, withSwing)

  // The windup: three frames, the last of them just before the hit.
  assert.deepEqual([0, 0.33, 0.34, 0.66, 0.67, 0.99].map((p, i) => during(p, i)?.frame), [0, 0, 1, 1, 2, 2])
  // The hit: the action is gone, and the fourth frame shows for one frame's time, 1/12 s.
  assert.deepEqual(after(100), { key: 'attack', frame: 3, facing: 1 })
  assert.equal(after(100 + 83)?.frame, 3)
  assert.equal(after(100 + 84)?.key, 'idle', 'and then it is standing')
})

test('the last frame of an attack gives way at once to walking or to the next action', () => {
  const swing: AnimationClip = { frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 3 }
  const withSwing = { ...clips, attack: swing }

  const walker = new CharacterAnimator()
  walker.update({ position: at, dead: false, action: { kind: 'attack', progress: 0.9 }, now: 0 }, withSwing)
  assert.equal(walker.update({ position: { x: 102, y: 100 }, dead: false, now: 16 }, withSwing)?.key, 'walk', 'moving cuts it short')

  const next = new CharacterAnimator()
  next.update({ position: at, dead: false, action: { kind: 'attack', progress: 0.9 }, now: 0 }, withSwing)
  next.update({ position: at, dead: false, now: 16 }, withSwing)
  assert.equal(next.update({ position: at, dead: false, action: { kind: 'attack', progress: 0 }, now: 32 }, withSwing)?.frame, 0, 'so does the next swing')
})

test('a clip with its own frame times holds each for as long as it says, and the last for good', () => {
  const dying: AnimationClip = { frames: 2, fps: 5, loop: false, frameMs: [400, 1000] }
  assert.deepEqual([0, 399, 400, 1399, 1400, 60000].map((ms) => frameAt(dying, ms)), [0, 0, 1, 1, 1, 1])
  const looping: AnimationClip = { frames: 2, fps: 5, loop: true, frameMs: [100, 300] }
  assert.deepEqual([0, 99, 100, 399, 400, 500].map((ms) => frameAt(looping, ms)), [0, 0, 1, 1, 0, 1])
})

test('dying plays from the first frame when the champion dies, and standing up again goes back to idle', () => {
  const animator = new CharacterAnimator()
  const dying: AnimationClip = { frames: 2, fps: 5, loop: false, frameMs: [400, 1000] }
  const withDead = { ...clips, dead: dying }
  const state = (dead: boolean, now: number) => animator.update({ position: at, dead, now }, withDead)
  assert.equal(state(false, 0)?.key, 'idle')
  assert.deepEqual(state(true, 1000), { key: 'dead', frame: 0, facing: 1 })
  assert.equal(state(true, 1399)?.frame, 0, 'it sits on the first frame for 0.4 s')
  assert.equal(state(true, 1400)?.frame, 1, 'then the second')
  assert.equal(state(true, 90000)?.frame, 1, 'and stays on it')
  assert.equal(state(false, 90016)?.key, 'idle', 'a respawn stands it up')
})

test('a clip that is not synced to the action runs at its own rate during it', () => {
  const animator = new CharacterAnimator()
  const casting: AnimationClip = { frames: 4, fps: 8, loop: true }
  const input = (now: number) => animator.update({ position: at, dead: false, action: { kind: 'cast', progress: 0.9 }, now }, { ...clips, cast: casting })
  assert.equal(input(0)?.frame, 0)
  assert.equal(input(130)?.frame, 1)
})

test('while it attacks or casts, the champion turns to face what it is aimed at, at once', () => {
  const animator = new CharacterAnimator()
  const facing = (aimAt: { x: number; y: number }) =>
    animator.update({ position: at, dead: false, action: { kind: 'attack', progress: 0.1, aimAt }, now: 0 }, { ...clips, attack })?.facing
  assert.equal(facing({ x: 200, y: 100 }), 1)
  assert.equal(facing({ x: 50, y: 100 }), -1, 'a target to the left is faced on the first frame')
  assert.equal(facing({ x: 100, y: 300 }), -1, 'one straight above or below keeps the way it faces')
})

// The real sprite sets, checked against their sheets and the roster, without any tuned number.
function pngSize(url: string): { width: number; height: number } {
  const bytes = readFileSync(fileURLToPath(url))
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('every sprite set belongs to a champion, and every clip fits its sheet exactly', () => {
  assert.ok(Object.keys(championSprites).length > 0)
  for (const [championId, set] of Object.entries(championSprites)) {
    assert.ok(champions.has(championId), `${championId} is a champion`)
    assert.ok(set.anchor.x >= 0 && set.anchor.x <= set.frameWidth && set.anchor.y >= 0 && set.anchor.y <= set.frameHeight, `${championId}'s anchor is inside a frame`)
    assert.ok(set.scale > 0)
    assert.ok(set.clips.idle, `${championId} has an idle to fall back on`)
    for (const [key, clip] of Object.entries(set.clips)) {
      assert.ok(clip)
      const sheet = pngSize(clip.url)
      assert.equal(sheet.width, clip.frames * set.frameWidth, `${championId} ${key}: the frames fill the sheet across`)
      assert.equal(sheet.height, set.frameHeight, `${championId} ${key}: and it is one row high`)
      assert.ok(clip.fps > 0)
    }
  }
})
