import { Assets, Rectangle, Sprite, Texture } from 'pixi.js'
import { CharacterAnimator, type AnimationKey, type AnimatorInput } from './animation.ts'
import { spriteRows, type SpriteSet } from './champion-sprites.ts'
import { spriteFileKey } from './sprite-overrides.ts'

// A sprite set with its sheets loaded and cut into frames, ready to draw from: each clip's frames, a list of them
// for each row of its sheet (one, or one for each way art drawn facing four ways faces).
export type LoadedSpriteSet = {
  set: SpriteSet
  frames: Partial<Record<AnimationKey, Texture[][]>>
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
    // A set with a sheet that cannot be loaded is left out, so that champion is drawn as a circle, and
    // the others keep their art.
    try {
      for (const [key, clip] of Object.entries(set.clips) as Array<[AnimationKey, NonNullable<SpriteSet['clips'][AnimationKey]>]>) {
        const override = overrides.get(spriteFileKey(clip.url))
        const sheet = override
          ? Texture.from(await createImageBitmap(override))
          : await Assets.load<Texture>(clip.url)
        sheet.source.scaleMode = 'nearest'
        frames[key] = Array.from({ length: spriteRows(set) }, (_, row) =>
          Array.from({ length: clip.frames }, (_, index) => new Texture({
            source: sheet.source,
            frame: new Rectangle(index * set.frameWidth, row * set.frameHeight, set.frameWidth, set.frameHeight),
          })))
      }
    } catch (error) {
      console.warn(`Could not load the sprites of "${championId}", so it is drawn as a circle.`, error)
      continue
    }
    loaded.set(championId, { set, frames })
  }
  return loaded
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
    const flipped = !set.directions && shown.facing !== set.facing
    this.view.scale.set(set.scale * (flipped ? -1 : 1), set.scale)
  }
}
