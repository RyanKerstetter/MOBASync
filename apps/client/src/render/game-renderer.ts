import type { Application } from 'pixi.js'
import { GAME_VIEW_HEIGHT, GAME_VIEW_WIDTH, type Vector2 } from '../../../../packages/shared/src/index.ts'
import { computeCamera, screenToWorld, type Camera } from '../camera.ts'
import type { LoadedSpriteSet } from '../character-sprite.ts'
import type { EffectSettings } from './effect-settings.ts'
import type { MapView } from './map-view.ts'
import type { RendererKind } from './renderer-kind.ts'
import { WorldRenderer, type WorldFrame } from './world-renderer.ts'

// What the game asks of whatever draws the world. The game works out what to show (`WorldFrame`) and where the player points,
// and does not care how it is drawn, so one renderer can be put in place of the other while a game runs.
export interface GameRenderer {
  readonly kind: RendererKind
  // Which of the effects drawn over the ground are on (the graphics menu).
  effects: Readonly<EffectSettings>
  // The debug view: hitboxes, and whatever the map shows for debugging.
  debug: boolean
  // How far the camera is zoomed, as a multiple of the usual view (see zoom.ts), from the next `follow`.
  zoom: number
  // Keeps the camera on this point of the world.
  follow(center: Vector2): void
  // The point of the world under a point on the screen (the mouse), in the screen's own pixels.
  screenToWorld(point: Vector2): Vector2
  // The ground under a point on the screen, whatever stands on it: where an ability aimed at the ground goes.
  screenToGround(point: Vector2): Vector2
  update(frame: WorldFrame): void
  // Draws champions from these sprite sets from now on, for a renderer that draws sprites.
  setSpriteSets(sets: ReadonlyMap<string, LoadedSpriteSet>): void
  // Takes everything it drew off the page.
  destroy(): void
}

// The 2D renderer as a `GameRenderer`: the world renderer in the Pixi stage, under a camera that scales and moves it.
export class FlatRenderer implements GameRenderer {
  readonly kind = '2d'
  zoom = 1
  private readonly world: WorldRenderer
  private camera: Camera

  constructor(private readonly app: Application, options: { map: MapView; spriteSets: ReadonlyMap<string, LoadedSpriteSet> }) {
    this.world = new WorldRenderer(options)
    this.camera = computeCamera(app.screen, { width: GAME_VIEW_WIDTH, height: GAME_VIEW_HEIGHT }, { x: 0, y: 0 })
    this.attach()
  }

  // Puts the world back on the stage, under anything else on it, after `destroy` took it off: the 2D world is kept for the
  // whole game, so switching back to it is instant.
  attach(): this {
    this.app.stage.addChildAt(this.world.scene, 0)
    return this
  }

  get effects(): Readonly<EffectSettings> {
    return this.world.effects
  }

  set effects(effects: Readonly<EffectSettings>) {
    this.world.effects = effects
  }

  get debug(): boolean {
    return this.world.debug
  }

  set debug(on: boolean) {
    this.world.debug = on
  }

  follow(center: Vector2): void {
    this.camera = computeCamera(this.app.screen, { width: GAME_VIEW_WIDTH / this.zoom, height: GAME_VIEW_HEIGHT / this.zoom }, center)
    this.world.setCamera(this.camera)
  }

  screenToWorld(point: Vector2): Vector2 {
    return screenToWorld(this.camera, point)
  }

  // From straight above, the ground under the pointer is what it is over.
  screenToGround(point: Vector2): Vector2 {
    return screenToWorld(this.camera, point)
  }

  update(frame: WorldFrame): void {
    this.world.update(frame)
  }

  setSpriteSets(sets: ReadonlyMap<string, LoadedSpriteSet>): void {
    this.world.setSpriteSets(sets)
  }

  destroy(): void {
    // The map's view is the page's for the whole game, so it is kept for the next time the world is drawn in 2D.
    this.world.scene.removeFromParent()
  }
}
