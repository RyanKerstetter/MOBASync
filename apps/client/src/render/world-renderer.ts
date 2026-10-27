import { Container, RenderLayer } from 'pixi.js'
import type { AttackMarker } from './attack-marker.ts'
import type { Camera } from '../camera.ts'
import type { LoadedSpriteSet } from '../character-sprite.ts'
import type { CastPreview, RenderedCharacter, RenderedEntity } from '../game-state.ts'
import { CharacterLayer } from './character-layer.ts'
import { EntityLayer } from './entity-layer.ts'
import { FogLayer } from './fog-layer.ts'
import { FloatingDamageLayer } from './floating-damage-layer.ts'
import { HitboxLayer } from './hitbox-layer.ts'
import { IndicatorLayer } from './indicator-layer.ts'
import type { MapView } from './map-view.ts'
import { ObjectiveLayer } from './objective-layer.ts'
import { TurretRangeLayer } from './turret-range.ts'
import type { ModeView } from '../ui/mode-hud.ts'
import type { VisionMask } from '../../../../packages/shared/src/index.ts'

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
  // What the controlled champion's team sees, which the rest is darkened for. Absent when everything is shown.
  fog?: VisionMask
  // The characters in the game that are not in `characters` because the team cannot see them. They are not drawn,
  // but their bodies are kept up to date, so what they are doing (a death, say) carries on out of sight and is not
  // started again when they are seen.
  unseen?: readonly RenderedCharacter[]
}

export type WorldRendererOptions = {
  // The ground, under everything else.
  map: MapView
  // The sprite sets champions are drawn from, by champion ID. A champion with none is a circle.
  spriteSets: ReadonlyMap<string, LoadedSpriteSet>
}

// The world, drawn as layers in a fixed order, bottom to top:
//
//   map            the ground (`MapView`), except what stands up out of it (below)
//   objectives     the hill, and the flags' bases and flags on the ground (`ObjectiveLayer`)
//   ground         telegraphs and fields, under the champions so they never hide them
//   turret ranges  the faint circle round each turret, out to the end of its reach (`TurretRangeLayer`)
//   indicators     the attack range ring, the aimed ability's indicator, attack reticles
//   depth          the champions' bodies and what stands up out of the map (the faces of walls: `MapView.sorted`),
//                  in order of how far down the map each stands, so a champion walks behind a wall and in front
//                  of another (see depth.ts). It is a `RenderLayer`: they stay in the scene where they are for
//                  where they are drawn, and this says when.
//   carried flags  the flag a champion carries, over it
//   air            shots and bolts, which fly over the champions
//   fog            the darkness over what the team cannot see (`FogLayer`): over everything drawn above, which is
//                  why what stands in it is left out of the frame and not just darkened
//   names          the champions' names and bars, over the fog and the walls, so they are never lost behind either
//   floating text  damage numbers
//   debug          hitboxes, while the debug view is on
//
// `scene` holds them all in world coordinates; the camera moves and scales it.
export class WorldRenderer {
  readonly scene = new Container()
  private readonly map: MapView
  private readonly depth = new RenderLayer({ sortableChildren: true })
  private readonly characters: CharacterLayer
  private readonly entities = new EntityLayer()
  private readonly objectives = new ObjectiveLayer()
  private readonly turretRanges = new TurretRangeLayer()
  private readonly indicators = new IndicatorLayer()
  private readonly fog = new FogLayer()
  private readonly floatingDamage = new FloatingDamageLayer()
  private readonly hitboxes = new HitboxLayer()

  constructor(options: WorldRendererOptions) {
    this.map = options.map
    this.characters = new CharacterLayer(options.spriteSets, this.depth)
    this.scene.addChild(
      this.map.view,
      this.objectives.ground,
      this.entities.ground,
      this.turretRanges.view,
      this.indicators.view,
      this.characters.view,
      this.depth,
      this.objectives.above,
      this.entities.air,
      this.fog.view,
      this.characters.overlay,
      this.floatingDamage.view,
      this.hitboxes.view,
    )
    // The map's strips first, so one level with a champion is drawn under it.
    this.depth.attach(...(this.map.sorted ?? []))
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
    this.characters.update(characters, localCharacterId, frame.localAttackCooldown, now, frame.unseen)
    this.entities.update(entities)
    this.turretRanges.update(characters)
    this.objectives.update(frame.mode, characters, now)
    this.fog.update(frame.fog)
    this.hitboxes.update(characters, entities, localCharacterId, frame.debugPath)
    this.indicators.update({
      characters,
      ...(local && !local.dead ? { local: { position: local.position, attackRange: local.attackRange } } : {}),
      ...(frame.castPreview ? { castPreview: frame.castPreview } : {}),
      attackMarkers: frame.attackMarkers,
    })
  }
}
