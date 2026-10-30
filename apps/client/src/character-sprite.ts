import { Assets, Rectangle, Sprite, Texture } from 'pixi.js'
import { CharacterAnimator, type AnimationKey, type AnimatorInput } from './animation.ts'
import { clipFrameSize, spriteRows, type SpriteClip, type SpriteSet } from './champion-sprites.ts'
import { repaint, teamSwaps, type ColourSwap } from './render/team-paint.ts'
import { spriteFileKey } from './sprite-overrides.ts'

// A sprite set with its sheets loaded and cut into frames, ready to draw from: each clip's frames, a list of them
// for each row of its sheet (one, or one for each way art drawn facing four ways faces).
export type LoadedSpriteSet = {
  set: SpriteSet
  frames: Partial<Record<AnimationKey, Texture[][]>>
  // The whole sheet each clip's frames are cut from, which is what a set painted in a team's colour is made from (see `teamVariant`). Left out of one that is
  // not made from sheets.
  sheets?: Partial<Record<AnimationKey, Texture>>
}

// A clip's frames, cut from its sheet: a list of them for each row of it.
function cutFrames(set: SpriteSet, clip: SpriteClip, sheet: Texture): Texture[][] {
  const { width, height } = clipFrameSize(set, clip)
  return Array.from({ length: spriteRows(set) }, (_, row) =>
    Array.from({ length: clip.frames }, (_, index) => new Texture({
      source: sheet.source,
      frame: new Rectangle(index * width, row * height, width, height),
    })))
}

// Loads every sheet of every set and cuts each into its frames. Pixel art is sampled nearest, so it
// stays crisp when scaled up. A sheet that has a file in `overrides` (see `spriteOverridesFrom`) is
// read from that instead of from the set's own url.
export async function loadSpriteSets(
  sets: Readonly<Record<string, SpriteSet>>,
  overrides: ReadonlyMap<string, Blob> = new Map(),
): Promise<Map<string, LoadedSpriteSet>> {
  const loaded = new Map<string, LoadedSpriteSet>()
  for (const [championId, set] of Object.entries(sets)) {
    const frames: Partial<Record<AnimationKey, Texture[][]>> = {}
    const sheets: Partial<Record<AnimationKey, Texture>> = {}
    // A set with a sheet that cannot be loaded is left out, so that champion is drawn as a circle, and
    // the others keep their art.
    try {
      for (const [key, clip] of Object.entries(set.clips) as Array<[AnimationKey, NonNullable<SpriteSet['clips'][AnimationKey]>]>) {
        const override = overrides.get(spriteFileKey(clip.url))
        const sheet = override
          ? Texture.from(await createImageBitmap(override))
          : await Assets.load<Texture>(clip.url)
        sheet.source.scaleMode = 'nearest'
        sheets[key] = sheet
        frames[key] = cutFrames(set, clip, sheet)
      }
    } catch (error) {
      console.warn(`Could not load the sprites of "${championId}", so it is drawn as a circle.`, error)
      continue
    }
    loaded.set(championId, { set, frames, sheets })
  }
  return loaded
}

// Draws a sheet again with these colours swapped, as a new texture. It is given the sheet and does not change it.
export type SheetPainter = (sheet: Texture, swaps: readonly ColourSwap[]) => Texture

// How the page paints a sheet: it is drawn on a canvas, its pixels read, the colours swapped (`repaint`), and the result made a texture, sampled nearest like
// the sheets are.
export const paintWithCanvas: SheetPainter = (sheet, swaps) => {
  const { pixelWidth: width, pixelHeight: height } = sheet.source
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('There is no 2d canvas to repaint a sheet in.')
  context.imageSmoothingEnabled = false
  context.drawImage(sheet.source.resource as CanvasImageSource, 0, 0)
  const image = context.getImageData(0, 0, width, height)
  repaint(image.data, swaps)
  context.putImageData(image, 0, 0)
  const painted = Texture.from(canvas, true)
  painted.source.scaleMode = 'nearest'
  return painted
}

// The sets already painted for a team, by the set they are made from and then by the team's colour, so each is made once and the same one is drawn from
// for every structure of that team. They go when their set does (a new folder of art is a new set, and so new ones).
const teamVariants = new WeakMap<LoadedSpriteSet, Map<string, LoadedSpriteSet>>()

// A set drawn in the colour of a team: the same set, with the two colours its art keeps for the team (`SpriteSet.teamPaint`) repainted in that team's colour
// (see team-paint.ts), in every frame of every clip. It is made the first time a team's is asked for, and is the same one every time after. A set that has no
// colours to paint, or no sheets to paint them in, or a colour that cannot be painted, or a sheet that cannot be, is given back as it is, so the worst that
// can happen is a flag in the colour it was drawn in.
export function teamVariant(loaded: LoadedSpriteSet, teamColor: string, paint: SheetPainter = paintWithCanvas): LoadedSpriteSet {
  const key = loaded.set.teamPaint
  if (!key || !loaded.sheets) return loaded
  const colour = teamColor.trim().toLowerCase()
  const made = teamVariants.get(loaded) ?? new Map<string, LoadedSpriteSet>()
  teamVariants.set(loaded, made)
  const known = made.get(colour)
  if (known) return known
  let variant = loaded
  const swaps = teamSwaps(colour, key)
  if (swaps.length > 0) {
    try {
      const frames: Partial<Record<AnimationKey, Texture[][]>> = {}
      const sheets: Partial<Record<AnimationKey, Texture>> = {}
      for (const [clipKey, clip] of Object.entries(loaded.set.clips) as Array<[AnimationKey, SpriteClip]>) {
        const sheet = loaded.sheets[clipKey]
        if (!sheet) continue
        const painted = paint(sheet, swaps)
        sheets[clipKey] = painted
        frames[clipKey] = cutFrames(loaded.set, clip, painted)
      }
      variant = { set: loaded.set, frames, sheets }
    } catch (error) {
      console.warn(`Could not paint the sprites of a set in the colour ${colour}, so it is drawn in the colours it came in.`, error)
    }
  }
  made.set(colour, variant)
  return variant
}

// One champion drawn from its sprite set. Each frame it asks its animator what to show and puts that
// frame up: from the row for the way it faces, for art drawn facing four ways, or else flipped when the
// champion faces the other way from the art.
export class CharacterSprite {
  readonly view: Sprite
  // How far above its position the figure reaches, in world units, if its set says (see `SpriteSet.top`).
  readonly reach: number
  private readonly animator: CharacterAnimator

  constructor(private readonly loaded: LoadedSpriteSet) {
    const { set, frames } = loaded
    // Standing, toward the player for art drawn facing four ways, until the first update.
    const row = set.directions?.down ?? 0
    const first = [frames.idle, ...Object.values(frames)].find((clip) => clip?.[row]?.length)?.[row]?.[0]
    this.view = new Sprite(first ?? Texture.EMPTY)
    this.view.anchor.set(set.anchor.x / set.frameWidth, set.anchor.y / set.frameHeight)
    this.view.scale.set(set.scale)
    this.reach = (set.top ?? 0) * set.scale
    this.animator = new CharacterAnimator(set.facing)
  }

  update(input: AnimatorInput): void {
    const { set, frames } = this.loaded
    const shown = this.animator.update(input, set.clips)
    if (!shown) return
    const row = set.directions ? set.directions[shown.direction] : 0
    const texture = frames[shown.key]?.[row]?.[shown.frame]
    if (texture) this.view.texture = texture
    // A figure drawn facing one way is flipped to face the other; one drawn facing four ways, and a building, never are.
    const flipped = !set.directions && !set.fixed && shown.facing !== set.facing
    this.view.scale.set(set.scale * (flipped ? -1 : 1), set.scale)
  }
}
