import { TURRET_TIERS, turretId } from '../../../packages/shared/src/index.ts'
import type { AnimationClip, AnimationKey, Direction, Facing } from './animation.ts'

// A clip's frames, side by side in a row of a sheet image, left to right: one row, or for art drawn facing four
// ways, a row for each way.
export type SpriteClip = AnimationClip & {
  url: string
  // The size of this clip's frames, in the art's own pixels, when they are not the set's (a collapse whose rubble spreads wider than the
  // building stood). The set's anchor is a fraction of its frame, so the figure stays where it was only if it is in the same place in these
  // frames: centred across, and on the same line down.
  frameWidth?: number
  frameHeight?: number
}

// How a champion (or a monster) is drawn from sprite sheets instead of as a plain circle. Everything about the art
// is here as data: adding an animation is adding a clip, and drawing another champion is adding a set.
export type SpriteSet = {
  // Every frame in the set's sheets is this size, in the art's own pixels, unless a clip says another (see `SpriteClip`).
  frameWidth: number
  frameHeight: number
  // The point in a frame, in its pixels, that is put on the champion's position: the middle of the
  // figure, which is where the body sits in the game.
  anchor: { x: number; y: number }
  // A building, which is drawn as it is whichever way it turns to shoot: it is never flipped, as a figure drawn facing one way is.
  fixed?: true
  // The two colours the art uses for whatever is to show the team it belongs to (a flag: its cloth and its shade), as `#rrggbb`, and uses for nothing else.
  // Whoever is drawn from the set has every pixel of exactly those colours repainted in the colour of its team (`teamVariant` in character-sprite.ts, and
  // team-paint.ts), so the same art is a red team's and a blue team's. Left out, the art is drawn as it is.
  teamPaint?: { primary: string; shade: string }
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

// How big one frame of a clip is: its own size if it says, and else the set's.
export function clipFrameSize(set: SpriteSet, clip: SpriteClip): { width: number; height: number } {
  return { width: clip.frameWidth ?? set.frameWidth, height: clip.frameHeight ?? set.frameHeight }
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
    idle: { url: new URL('../../../res/champion/swordsman/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    attack: { url: new URL('../../../res/champion/swordsman/Attack_1.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 3 },
    cast: { url: new URL('../../../res/champion/swordsman/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/champion/swordsman/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
    walk: { url: new URL('../../../res/champion/swordsman/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
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
    idle: { url: new URL('../../../res/champion/archer/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/champion/archer/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/champion/archer/Attack.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 2 },
    cast: { url: new URL('../../../res/champion/archer/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/champion/archer/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
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
    idle: { url: new URL('../../../res/champion/cursebearer/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/champion/cursebearer/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/champion/cursebearer/Attack_1.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 2 },
    cast: { url: new URL('../../../res/champion/cursebearer/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/champion/cursebearer/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
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
    idle: { url: new URL('../../../res/champion/ninja/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/champion/ninja/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/champion/ninja/Attack_1.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 3 },
    cast: { url: new URL('../../../res/champion/ninja/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    // Sits on the first frame for 0.2 s, then falls and stays down.
    dead: { url: new URL('../../../res/champion/ninja/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
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
    idle: { url: new URL('../../../res/champion/trinketmaster/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/champion/trinketmaster/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/champion/trinketmaster/Attack_2.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 3 },
    cast: { url: new URL('../../../res/champion/trinketmaster/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    // Sits on the first frame for 0.4 s, then falls and stays down.
    dead: { url: new URL('../../../res/champion/trinketmaster/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
  },
}

// The hammer and the chain: placeholders too, the Swordsman's sheets and the Trinketmaster's copied into their own folders, with the same frame size, place in
// the frame and timings as the champions they were copied from, until they have art of their own.
const hammer: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 14, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/champion/hammer/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/champion/hammer/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/champion/hammer/Attack_1.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 3 },
    cast: { url: new URL('../../../res/champion/hammer/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/champion/hammer/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
  },
}

const chain: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 14, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/champion/chain/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/champion/chain/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/champion/chain/Attack_2.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 3 },
    cast: { url: new URL('../../../res/champion/chain/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/champion/chain/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
  },
}

const capricorn: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 16, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/champion/capricorn/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/champion/capricorn/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/champion/capricorn/Attack.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 2 },
    cast: { url: new URL('../../../res/champion/capricorn/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/champion/capricorn/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
  },
}

const soldier: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 16, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/champion/soldier/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/champion/soldier/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/champion/soldier/Attack.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 2 },
    cast: { url: new URL('../../../res/champion/soldier/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/champion/soldier/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
  },
}

const grenadier: SpriteSet = {
  frameWidth: 32,
  frameHeight: 32,
  anchor: { x: 16, y: 24 },
  scale: 3,
  facing: 1,
  clips: {
    idle: { url: new URL('../../../res/champion/grenadier/Idle.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    walk: { url: new URL('../../../res/champion/grenadier/Walk.png', import.meta.url).href, frames: 4, fps: 8, loop: true },
    attack: { url: new URL('../../../res/champion/grenadier/Attack.png', import.meta.url).href, frames: 4, fps: 12, loop: false, syncToAction: true, syncFrames: 2 },
    cast: { url: new URL('../../../res/champion/grenadier/Cast.png', import.meta.url).href, frames: 3, fps: 10, loop: false, syncToAction: true },
    dead: { url: new URL('../../../res/champion/grenadier/Dead.png', import.meta.url).href, frames: 2, fps: 5, loop: false, frameMs: [200, 1000] },
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

// The buildings (the stone tower and the core's keep) are drawn at 3 world units to a pixel, on the foot of 80 px frames. What a building stands on
// is the ground its body holds, the disc `radius` round its position, so the art is put with that disc just inside the foot of it: the middle
// of the disc is `radius` above the bottom of the frame, and the building's own middle (`middle`, from the left of the frame) is what is put
// across it: not the middle of what is drawn, which a flag or a turret to one side pulls off. The art starts a pixel down its frame, so that is
// how far above the ground it reaches. It is the same in every frame of a set, as each stands on the foot of its own.
const STRUCTURE_SCALE = 3
const STRUCTURE_FRAME_HEIGHT = 80
function standingOnItsGround(radius: number, middle: number): Pick<SpriteSet, 'anchor' | 'top'> {
  const ground = STRUCTURE_FRAME_HEIGHT - radius / STRUCTURE_SCALE
  return { anchor: { x: middle, y: ground }, top: ground - 1 }
}

// The colours of the flag on the stone tower and the keep, which are repainted in the colour of the team they stand for: the cloth, and the shade of it.
// They are in the art for the flag alone (the rest of the tower is stone and moss).
export const STRUCTURE_FLAG = { primary: '#ff0044', shade: '#a22633' } as const

// The stone tower, which every tier of turret is drawn as: a figure 33 px across and 80 tall, standing on the foot of each 48 x 80 frame, with a
// flag on top that flaps as it idles. It is a building, so it is the same whichever way it shoots, and it has no attack of its own to play: the
// shot is seen leaving it. It is destroyed by crumbling in on itself, down to rubble and then to nothing (the last of its eight frames is empty,
// as what is destroyed leaves nothing lying there). At 3 world units a pixel it is about 100 across and 240 tall. The tower itself is 24 px
// across the middle of its frame, with the flag out to the right of it, so it is the frame's middle that is put on the position.
const stoneTower = (radius: number): SpriteSet => ({
  frameWidth: 48,
  frameHeight: STRUCTURE_FRAME_HEIGHT,
  ...standingOnItsGround(radius, 24),
  scale: STRUCTURE_SCALE,
  facing: 1,
  fixed: true,
  teamPaint: STRUCTURE_FLAG,
  clips: {
    idle: { url: new URL('../../../res/turret/stone-tower.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    dead: { url: new URL('../../../res/turret/stone-tower-destroyed.png', import.meta.url).href, frames: 8, fps: 6, loop: false },
  },
})

// The core, which is the turret of the core tier: a keep 46 px across and 80 tall, placed and drawn as the tower is. Its idle is 48 px frames, and its collapse
// 64 px ones, as the rubble spreads wider than the keep stood, with the keep centred in both.
const coreKeep = (radius: number): SpriteSet => ({
  frameWidth: 48,
  frameHeight: STRUCTURE_FRAME_HEIGHT,
  ...standingOnItsGround(radius, 24),
  scale: STRUCTURE_SCALE,
  facing: 1,
  fixed: true,
  teamPaint: STRUCTURE_FLAG,
  clips: {
    idle: { url: new URL('../../../res/turret/core.png', import.meta.url).href, frames: 4, fps: 6, loop: true },
    dead: { url: new URL('../../../res/turret/core-destroyed.png', import.meta.url).href, frames: 8, fps: 6, loop: false, frameWidth: 64 },
  },
})

// By champion, monster or turret (`turret-<tier>`, the core of a base too) ID. One with no set here is drawn as a circle, or for a structure as shapes in its team's colour.
export const championSprites: Readonly<Record<string, SpriteSet>> = {
  // Every tier the game has is the stone tower, until a tier has art of its own, and the core's tier is the keep.
  ...Object.fromEntries(Object.entries(TURRET_TIERS).map(([tier, def]) => [turretId(Number(tier)), def.core ? coreKeep(def.radius) : stoneTower(def.radius)])),
  swordsman: swordAndShield,
  archer: crossbow,
  cursebearer,
  ninja,
  trinketmaster,
  hammer,
  chain,
  capricorn,
  soldier,
  grenadier,
  slime,
  golem,
}
