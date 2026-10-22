import type { AnimationClip, AnimationKey, Facing } from './animation.ts'

// A clip's frames, side by side in one row of a sheet image, left to right.
export type SpriteClip = AnimationClip & {
  url: string
}

// How a champion is drawn from sprite sheets instead of as a plain circle. Everything about the art
// is here as data: adding an animation is adding a clip, and drawing another champion is adding a set.
export type SpriteSet = {
  // Every frame in the set's sheets is this size, in the art's own pixels.
  frameWidth: number
  frameHeight: number
  // The point in a frame, in its pixels, that is put on the champion's position: the middle of the
  // figure, which is where the body sits in the game.
  anchor: { x: number; y: number }
  // How big one of the art's pixels is drawn, in world units.
  scale: number
  // The way the art faces. It is flipped to face the other way.
  facing: Facing
  clips: Partial<Record<AnimationKey, SpriteClip>>
}

// The art lives in res/ at the top of the repository. `new URL(..., import.meta.url)` with a fixed
// path is how Vite finds an asset relative to this file and serves it (or bundles it in a build).

// The knight with a sword and shield: a figure 16 px across and 16 tall in the lower middle of each
// 32 px frame, facing right. Drawn at 3 world units a pixel it is 48 across, a little bigger than the
// Swordsman's 36 wide body.
const swordAndShield: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 14, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/Character_SwordShield/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    attack: { url: new URL('../../../res/Character_SwordShield/Attack_1.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 3 },
    cast: { url: new URL('../../../res/Character_SwordShield/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    // Sits on the first frame for 0.4 s, then falls and stays down.
    dead: { url: new URL('../../../res/Character_SwordShield/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
    walk: { url: new URL('../../../res/Character_SwordShield/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
  },
}

// The crossbowman: the same art scale and the same 16 px figure in the lower middle of the frame as
// the knight, a little left of centre. Its attack shows the bolt leaving the crossbow, so the first
// two frames are spread over the windup and the two with the bolt play as it is loosed.
const crossbow: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 16, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/Character_Crossbow/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/Character_Crossbow/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/Character_Crossbow/Attack.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 2 },
    cast: { url: new URL('../../../res/Character_Crossbow/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    // Sits on the first frame for 0.4 s, then falls and stays down.
    dead: { url: new URL('../../../res/Character_Crossbow/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [400, 1000] },
  },
}

// The cursebearer: a pale robed figure with a staff, the same size and place in the frame as the
// knight. Its attack is a swing: the staff is drawn back for the windup, and the swing that lets the
// curse fly plays as it is loosed. (Its walk sheet is a dark hooded figure, as the art came.)
const cursebearer: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 14, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/Character_Cursebearer/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/Character_Cursebearer/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/Character_Cursebearer/Attack_1.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 1 },
    cast: { url: new URL('../../../res/Character_Cursebearer/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    // Sits on the first frame for 0.4 s, then falls and stays down.
    dead: { url: new URL('../../../res/Character_Cursebearer/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [400, 1000] },
  },
}

// By champion ID. A champion with no set here is drawn as a circle.
export const championSprites: Readonly<Record<string, SpriteSet>> = {
  swordsman: swordAndShield,
  archer: crossbow,
  cursebearer,
}
