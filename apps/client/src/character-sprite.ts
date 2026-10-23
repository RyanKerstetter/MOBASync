import { Assets, Rectangle, Sprite, Texture } from 'pixi.js'
import { CharacterAnimator, type AnimationKey, type AnimatorInput } from './animation.ts'
import type { SpriteSet } from './champion-sprites.ts'
import { spriteFileKey } from './sprite-overrides.ts'

// A sprite set with its sheets loaded and cut into frames, ready to draw from.
export type LoadedSpriteSet = {
  set: SpriteSet
  frames: Partial<Record<AnimationKey, Texture[]>>
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
    const frames: Partial<Record<AnimationKey, Texture[]>> = {}
    for (const [key, clip] of Object.entries(set.clips) as Array<[AnimationKey, NonNullable<SpriteSet['clips'][AnimationKey]>]>) {
      const override = overrides.get(spriteFileKey(clip.url))
      const sheet = override
        ? Texture.from(await createImageBitmap(override))
        : await Assets.load<Texture>(clip.url)
      sheet.source.scaleMode = 'nearest'
      frames[key] = Array.from({ length: clip.frames }, (_, index) => new Texture({
        source: sheet.source,
        frame: new Rectangle(index * set.frameWidth, 0, set.frameWidth, set.frameHeight),
      }))
    }
    loaded.set(championId, { set, frames })
  }
  return loaded
}

// One champion drawn from its sprite set. Each frame it asks its animator what to show and puts that
// frame up, flipped when the champion faces the other way from the art.
export class CharacterSprite {
  readonly view: Sprite
  private readonly animator: CharacterAnimator

  constructor(private readonly loaded: LoadedSpriteSet) {
    const { set, frames } = loaded
    const first = frames.idle?.[0] ?? Object.values(frames).find((clip) => clip && clip.length > 0)?.[0]
    this.view = new Sprite(first ?? Texture.EMPTY)
    this.view.anchor.set(set.anchor.x / set.frameWidth, set.anchor.y / set.frameHeight)
    this.view.scale.set(set.scale)
    this.animator = new CharacterAnimator(set.facing)
  }

  update(input: AnimatorInput): void {
    const { set, frames } = this.loaded
    const shown = this.animator.update(input, set.clips)
    if (!shown) return
    const texture = frames[shown.key]?.[shown.frame]
    if (texture) this.view.texture = texture
    this.view.scale.set(set.scale * (shown.facing === set.facing ? 1 : -1), set.scale)
  }
}
