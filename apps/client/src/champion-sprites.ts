import type { AnimationClip, AnimationKey, Direction, Facing } from './animation.ts'

// A clip's frames, side by side in a row of a sheet image, left to right: one row, or for art drawn facing four
// ways, a row for each way.
export type SpriteClip = AnimationClip & {
  url: string
}

// How a champion (or a monster) is drawn from sprite sheets instead of as a plain circle. Everything about the art
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
  // How far above the anchor the top of the figure reaches, in the art's pixels, for a figure that stands taller than
  // its body is wide: the name and health bar are put over it, not over the body's radius, which would be on the
  // figure. Without it they are over the radius.
  top?: number
  clips: Partial<Record<AnimationKey, SpriteClip>>
} & (
  // Art drawn facing one way, a sheet one row high: the way it faces. It is flipped to face the other way.
  | { facing: Facing; directions?: undefined }
  // Art drawn facing four ways, every sheet a row for each: which row (from 0 at the top) is which way. It turns
  // to the way the character is going, and is never flipped.
  | { directions: Readonly<Record<Direction, number>>; facing?: undefined }
)

// How many rows each of a set's sheets has.
export function spriteRows(set: SpriteSet): number {
  return set.directions ? Math.max(...Object.values(set.directions)) + 1 : 1
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
    idle: { url: new URL('../../../res/Champion_Swordsman/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    attack: { url: new URL('../../../res/Champion_Swordsman/Attack_1.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 3 },
    cast: { url: new URL('../../../res/Champion_Swordsman/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/Champion_Swordsman/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
    walk: { url: new URL('../../../res/Champion_Swordsman/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
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
    idle: { url: new URL('../../../res/Champion_Archer/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/Champion_Archer/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/Champion_Archer/Attack.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 2 },
    cast: { url: new URL('../../../res/Champion_Archer/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/Champion_Archer/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
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
    idle: { url: new URL('../../../res/Champion_Cursebearer/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/Champion_Cursebearer/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/Champion_Cursebearer/Attack_1.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 2 },
    cast: { url: new URL('../../../res/Champion_Cursebearer/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/Champion_Cursebearer/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
  },
}

// The ninja: a placeholder, the Swordsman's sheets copied into its own folder, with the same frame
// size, place in the frame and timings, until it has art of its own.
const ninja: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 14, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/Champion_Ninja/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/Champion_Ninja/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/Champion_Ninja/Attack_1.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 3 },
    cast: { url: new URL('../../../res/Champion_Ninja/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    // Sits on the first frame for 0.2 s, then falls and stays down.
    dead: { url: new URL('../../../res/Champion_Ninja/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
  },
}

// Placeholders: the art of the Swordsman (for a melee champion) or the Archer (for a ranged one), copied
// into the champion's own folder, with the same frame size, place in the frame and timings, until it has
// art of its own.

const trinketmaster: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 14, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/Champion_Trinketmaster/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/Champion_Trinketmaster/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/Champion_Trinketmaster/Attack_1.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 3 },
    cast: { url: new URL('../../../res/Champion_Trinketmaster/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    // Sits on the first frame for 0.4 s, then falls and stays down.
    dead: { url: new URL('../../../res/Champion_Trinketmaster/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
  },
}

const capricorn: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 16, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/Champion_Capricorn/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/Champion_Capricorn/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/Champion_Capricorn/Attack.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 2 },
    cast: { url: new URL('../../../res/Champion_Capricorn/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/Champion_Capricorn/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
  },
}

const soldier: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 16, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/Champion_Soldier/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/Champion_Soldier/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/Champion_Soldier/Attack.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 2 },
    cast: { url: new URL('../../../res/Champion_Soldier/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/Champion_Soldier/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
  },
}

const grenadier: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 16, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/Champion_Grenadier/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/Champion_Grenadier/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/Champion_Grenadier/Attack.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 2 },
    cast: { url: new URL('../../../res/Champion_Grenadier/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/Champion_Grenadier/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
  },
}

// The slime: a blob about 17 px across in the middle of each 64 px frame, drawn facing four ways, a row of each sheet
// for each (toward the player, away, left, right). At the champions' 3 world units a pixel it is about as big as
// one. It sways while it waits, and squashes and stretches as it hops along. Its bump rises up on the windup and
// splashes as it lands, and it dies by fading to a puddle, which stays until it comes back.
const slime: SpriteSet = {
  frameWidth: 64,
  frameHeight: 64,
  anchor: { x: 32, y: 33 },
  scale: 3,
  directions: { down: 0, up: 1, left: 2, right: 3 },
  clips: {
    idle: { url: new URL('../../../res/monsters/slime/Slime1_Idle_with_shadow.png', import.meta.url).href, frames: 6, fps: 8, loop: true },
    walk: { url: new URL('../../../res/monsters/slime/Slime1_Walk_with_shadow.png', import.meta.url).href, frames: 8, fps: 12, loop: true },
    attack: { url: new URL('../../../res/monsters/slime/Slime1_Attack_with_shadow.png', import.meta.url).href, frames: 10, fps: 14, loop: false, syncToAction: true, syncFrames: 5 },
    dead: { url: new URL('../../../res/monsters/slime/Slime1_Death_with_shadow.png', import.meta.url).href, frames: 10, fps: 12, loop: false },
  },
}

// The golem: a lump of rock about 50 px across and 40 tall in the middle of each 128 px frame, drawn facing four ways
// like the slime, a row of each sheet for each. At 3 world units a pixel it is some 150 across, three champions wide.
// It rises up and leaps in its windup and comes down in a burst of pale shards as the blow lands, and it dies by going
// red and crumbling into a heap of rocks, which stays until it comes back.
const golem: SpriteSet = {
  frameWidth: 128,
  frameHeight: 128,
  anchor: { x: 64, y: 72 },
  scale: 3,
  top: 32,
  directions: { down: 0, up: 1, left: 2, right: 3 },
  clips: {
    idle: { url: new URL('../../../res/monsters/golem/Golem1_Idle_full.png', import.meta.url).href, frames: 4, fps: 5, loop: true },
    walk: { url: new URL('../../../res/monsters/golem/Golem1_Walk_full.png', import.meta.url).href, frames: 8, fps: 8, loop: true },
    // Its first five frames are the rise and the leap, spread over the windup so the shards frames after them are the blow.
    attack: { url: new URL('../../../res/monsters/golem/Golem1_Attack_full.png', import.meta.url).href, frames: 9, fps: 12, loop: false, syncToAction: true, syncFrames: 5 },
    dead: { url: new URL('../../../res/monsters/golem/Golem1_Death_full.png', import.meta.url).href, frames: 8, fps: 8, loop: false },
  },
}

// By champion or monster ID. One with no set here is drawn as a circle.
export const championSprites: Readonly<Record<string, SpriteSet>> = {
  swordsman: swordAndShield,
  archer: crossbow,
  cursebearer,
  ninja,
  trinketmaster,
  capricorn,
  soldier,
  grenadier,
  slime,
  golem,
}
