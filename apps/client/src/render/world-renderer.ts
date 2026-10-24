import { Container } from 'pixi.js'
import type { AttackMarker } from './attack-marker.ts'
import type { Camera } from '../camera.ts'
import type { LoadedSpriteSet } from '../character-sprite.ts'
import type { CastPreview, RenderedCharacter, RenderedEntity } from '../game-state.ts'
import { CharacterLayer } from './character-layer.ts'
import { EntityLayer } from './entity-layer.ts'
import { FloatingDamageLayer } from './floating-damage-layer.ts'
import { HitboxLayer } from './hitbox-layer.ts'
import { IndicatorLayer } from './indicator-layer.ts'
import type { MapView } from './map-view.ts'
import { ObjectiveLayer } from './objective-layer.ts'
import type { ModeView } from '../ui/mode-hud.ts'

// Everything the world is drawn from on one frame. It is plain data, worked out by whoever runs the
// game, so the renderer knows nothing of the network or the simulation.
export type WorldFrame = {
  // A clock reading in milliseconds, such as performance.now(), for animations.
  now: number
  characters: readonly RenderedCharacter[]
  entities: readonly RenderedEntity[]
  localCharacterId: number | undefined
  // How far the controlled champion's attack cooldown has run, from 0 to 1. Absent when there is no
  // controlled champion in the game.
  localAttackCooldown?: number
  // What the ability being aimed would do if its key were let go now.
  castPreview?: CastPreview
  attackMarkers: readonly AttackMarker[]
  // The hill or the flags of the game mode, if it has any.
  mode?: ModeView
  // The way the controlled champion is walking, from where it is, for the debug view.
  debugPath?: readonly { x: number; y: number }[]
}

export type WorldRendererOptions = {
  // The ground, under everything else.
  map: MapView
  // The sprite sets champions are drawn from, by champion ID. A champion with none is a circle.
  spriteSets: ReadonlyMap<string, LoadedSpriteSet>
}

// The world, drawn as layers in a fixed order, bottom to top:
//
//   map            the ground (`MapView`)
//   objectives     the hill, and the flags' bases and flags on the ground (`ObjectiveLayer`)
//   ground         telegraphs and fields, under the champions so they never hide them
//   indicators     the attack range ring, the aimed ability's indicator, attack reticles
//   characters     the champions, with their names and bars
//   carried flags  the flag a champion carries, over it
//   air            shots and bolts, which fly over the champions
//   floating text  damage numbers
//   debug          hitboxes, while the debug view is on
//
// `scene` holds them all in world coordinates; the camera moves and scales it.
export class WorldRenderer {
  readonly scene = new Container()
  private readonly map: MapView
  private readonly characters: CharacterLayer
  private readonly entities = new EntityLayer()
  private readonly objectives = new ObjectiveLayer()
  private readonly indicators = new IndicatorLayer()
  private readonly floatingDamage = new FloatingDamageLayer()
  private readonly hitboxes = new HitboxLayer()

  constructor(options: WorldRendererOptions) {
    this.map = options.map
    this.characters = new CharacterLayer(options.spriteSets)
    this.scene.addChild(
      this.map.view,
      this.objectives.ground,
      this.entities.ground,
      this.indicators.view,
      this.characters.view,
      this.objectives.above,
      this.entities.air,
      this.floatingDamage.view,
      this.hitboxes.view,
    )
  }

  get debug(): boolean {
    return this.hitboxes.enabled
  }

  // The debug view: the hitboxes, and whatever the map shows for debugging.
  set debug(enabled: boolean) {
    this.hitboxes.enabled = enabled
    this.map.setDebug?.(enabled)
  }

  setCamera(camera: Camera): void {
    this.scene.scale.set(camera.scale)
    this.scene.position.set(camera.x, camera.y)
  }

  setSpriteSets(sets: ReadonlyMap<string, LoadedSpriteSet>): void {
    this.characters.setSpriteSets(sets)
  }

  update(frame: WorldFrame): void {
    const { characters, entities, localCharacterId, now } = frame
    const local = characters.find((character) => character.id === localCharacterId)
    this.floatingDamage.update(characters, now)
    this.characters.update(characters, localCharacterId, frame.localAttackCooldown, now)
    this.entities.update(entities)
    this.objectives.update(frame.mode, characters, now)
    this.hitboxes.update(characters, entities, localCharacterId, frame.debugPath)
    this.indicators.update({
      characters,
      ...(local && !local.dead ? { local: { position: local.position, attackRange: local.attackRange } } : {}),
      ...(frame.castPreview ? { castPreview: frame.castPreview } : {}),
      attackMarkers: frame.attackMarkers,
    })
  }
}
