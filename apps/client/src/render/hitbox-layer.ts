import { Graphics } from 'pixi.js'
import type { RenderedCharacter, RenderedEntity } from '../game-state.ts'
import { hitboxShapes } from './hitboxes.ts'

const PATH_COLOR = 0xffd166

// The hitbox debug view: the outline of every body that can touch something, over everything else.
// It draws nothing while it is off.
export class HitboxLayer {
  readonly view = new Graphics()

  constructor() {
    this.view.visible = false
  }

  get enabled(): boolean {
    return this.view.visible
  }

  set enabled(enabled: boolean) {
    this.view.visible = enabled
    if (!enabled) this.view.clear()
  }

  update(
    characters: readonly RenderedCharacter[],
    entities: readonly RenderedEntity[],
    localCharacterId: number | undefined,
    path?: readonly { x: number; y: number }[],
  ): void {
    if (!this.enabled) return
    this.view.clear()
    // The way the controlled champion is walking round the walls: a line through each point.
    if (path && path.length > 1) {
      this.view.moveTo(path[0].x, path[0].y)
      for (const point of path.slice(1)) this.view.lineTo(point.x, point.y)
      this.view.stroke({ color: PATH_COLOR, width: 2, alpha: 0.9 })
      for (const point of path.slice(1)) this.view.circle(point.x, point.y, 5).fill({ color: PATH_COLOR, alpha: 0.9 })
    }
    for (const shape of hitboxShapes(characters, entities, localCharacterId)) {
      if (shape.kind === 'circle') this.view.circle(shape.x, shape.y, shape.radius)
      else this.view.poly(shape.points)
      // A range is only an outline, so a big one does not tint everything inside it.
      if (shape.kind === 'circle' && shape.outline) this.view.stroke({ color: shape.color, width: 1.5, alpha: 0.7 })
      else this.view.fill({ color: shape.color, alpha: 0.12 }).stroke({ color: shape.color, width: 1.5, alpha: 0.9 })
    }
  }
}
