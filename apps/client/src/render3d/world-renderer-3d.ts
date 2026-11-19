import { Container, type Application } from 'pixi.js'
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  HemisphereLight,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2 as ThreeVector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { GAME_VIEW_HEIGHT, GAME_VIEW_WIDTH, type Vector2 } from '../../../../packages/shared/src/index.ts'
import type { RenderedCharacter } from '../game-state.ts'
import { guarded } from '../guard.ts'
import { CharacterLayer } from '../render/character-layer.ts'
import { DEFAULT_EFFECTS, type EffectSettings } from '../render/effect-settings.ts'
import { FloatingNumberLayer } from '../render/floating-number-layer.ts'
import type { GameRenderer } from '../render/game-renderer.ts'
import { KillRewardLayer } from '../render/kill-reward-layer.ts'
import type { OverlayAnchor } from '../render/overlay-anchor.ts'
import type { WorldFrame } from '../render/world-renderer.ts'
import { CharacterFx } from './character-fx.ts'
import { CharacterModels3D } from './character-models.ts'
import { DecalBatch } from './decal-batch.ts'
import { EntityEffects3D } from './effects/entity-effects.ts'
import { LightPool } from './effects/fx-materials.ts'
import { GroundOverlays } from './ground-overlays.ts'
import { mobaCameraPose, rayHitsCylinder, rayToGround } from './moba-camera.ts'
import { ParticleSystem } from './particles.ts'
import { Terrain3D, type MapGround } from './terrain-mesh.ts'
import { VisionShading } from './vision-shading.ts'

const NO_CHARACTERS: readonly RenderedCharacter[] = []
// The direction the sun shines from: high, from the upper left of the screen, so shadows fall down and to the right.
const SUN_DIRECTION = new Vector3(-0.55, 1, -0.4).normalize()
// How far round the camera's target the sun's shadows are worked out, which is more than the screen shows.
const SHADOW_REACH = 1300

export type WorldRenderer3DOptions = {
  // What the game is drawn in: its canvas is put under the page's 2D canvas, which goes on drawing the names and bars over it.
  container: HTMLElement
  app: Application
  ground: MapGround
}

// The world in 3D, drawn with three.js from the same `WorldFrame` the 2D renderer is given: the map stood up (walls are cliffs
// and the land is wooded), every character a model that walks, attacks and casts, every ability an effect in the world, what
// is painted on the ground painted on the 3D ground, and the darkness of what the team cannot see shaded into all of it. It
// draws on a canvas of its own under the page's Pixi canvas, where the names, the bars and the numbers over the characters are
// still drawn as in 2D, each put over where its character's model is on screen. The camera looks down from the south at a slant,
// as other MOBAs do.
export class WorldRenderer3D implements GameRenderer {
  readonly kind = '3d'
  effects: Readonly<EffectSettings> = { ...DEFAULT_EFFECTS }
  debug = false
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(34, 1, 10, 9000)
  private readonly sun: DirectionalLight
  private readonly vision = new VisionShading()
  private readonly terrain: Terrain3D
  private readonly characters: CharacterModels3D
  private readonly effectsLayer = new EntityEffects3D()
  private readonly characterFx = new CharacterFx()
  private readonly overlays: GroundOverlays
  private readonly paint: DecalBatch
  private readonly light: DecalBatch
  private readonly effectPaint: DecalBatch
  private readonly effectLight: DecalBatch
  private readonly glow = new ParticleSystem(7000, 'add')
  private readonly puff = new ParticleSystem(5000, 'normal')
  private readonly lights = new LightPool(6)
  private readonly raycaster = new Raycaster()
  private readonly overlayRoot = new Container()
  private readonly nameplates = new CharacterLayer(new Map())
  private readonly numbers = new FloatingNumberLayer()
  private readonly rewards = new KillRewardLayer()
  private readonly app: Application
  private readonly ground: MapGround
  private center: Vector2 = { x: 0, y: 0 }
  private size = { width: 0, height: 0, ratio: 0 }
  private lastNow: number | undefined
  // The bodies a click can land on, from the last frame drawn.
  private pickable: readonly RenderedCharacter[] = NO_CHARACTERS
  private localId: number | undefined
  private readonly projected = new Vector3()
  // Where the camera looks instead of at the champion, while developing.
  private devFocus: Vector2 | undefined
  private devZoom = 1

  constructor(options: WorldRenderer3DOptions) {
    this.app = options.app
    this.ground = options.ground
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFSoftShadowMap
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.08
    const canvas = this.renderer.domElement
    canvas.className = 'game-world-3d'
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' })
    options.container.insertBefore(canvas, options.app.canvas)
    // The 2D canvas is over this one, clear where nothing is drawn on it.
    options.app.canvas.style.position = 'relative'

    this.scene.background = new Color('#0b1220')
    this.scene.add(new HemisphereLight('#d6e8ff', '#5a4630', 1.35))
    this.sun = new DirectionalLight('#fff0d2', 2.6)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.camera.left = -SHADOW_REACH
    this.sun.shadow.camera.right = SHADOW_REACH
    this.sun.shadow.camera.top = SHADOW_REACH
    this.sun.shadow.camera.bottom = -SHADOW_REACH
    this.sun.shadow.camera.near = 10
    this.sun.shadow.camera.far = 4000
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 1.2
    this.scene.add(this.sun, this.sun.target)

    this.terrain = new Terrain3D(options.ground, this.vision)
    this.characters = new CharacterModels3D(this.vision)
    this.overlays = new GroundOverlays(this.vision)
    this.paint = new DecalBatch(this.vision, { height: 0.9, renderOrder: 2 })
    this.light = new DecalBatch(this.vision, { blending: 'add', height: 1.0, renderOrder: 3 })
    this.effectPaint = new DecalBatch(this.vision, { height: 0.7, renderOrder: 1 })
    this.effectLight = new DecalBatch(this.vision, { blending: 'add', height: 1.1, renderOrder: 4 })
    this.scene.add(
      this.terrain.group,
      this.effectPaint.mesh,
      this.paint.mesh,
      this.light.mesh,
      this.effectLight.mesh,
      this.overlays.group,
      this.characters.group,
      this.effectsLayer.group,
      this.characterFx.group,
      this.lights.group,
      this.glow.points,
      this.puff.points,
    )

    // What is drawn over the characters, in the page's 2D canvas, placed over their models.
    const anchor: OverlayAnchor = (position, radius, id) => this.anchorOf(position, radius, id)
    this.nameplates.anchor = anchor
    this.numbers.anchor = anchor
    this.rewards.anchor = anchor
    this.overlayRoot.addChild(this.nameplates.overlay, this.numbers.view, this.rewards.view)
    options.app.stage.addChild(this.overlayRoot)
    // For looking into the scene from the console while developing: the scene, the models and where they are on screen, and a
    // camera that can be pointed somewhere else (`focus = { x, y }`, or undefined to follow the champion again) and brought closer
    // (`zoom = 3`).
    if (import.meta.env.DEV) {
      const renderer = this
      ;(window as unknown as { world3d?: unknown }).world3d = {
        scene: this.scene,
        camera: this.camera,
        renderer: this.renderer,
        models: () => this.characters.describe().map((model) => ({ ...model, screen: this.toScreen(model.position, 0) })),
        set focus(at: Vector2 | undefined) {
          renderer.devFocus = at
        },
        set zoom(times: number) {
          renderer.devZoom = times
        },
      }
    }
  }

  setSpriteSets(): void {
    // The 3D view draws models, not sprites.
  }

  follow(followed: Vector2): void {
    const center = this.devFocus ?? followed
    this.center = { x: center.x, y: center.y }
    this.resize()
    const pose = mobaCameraPose(this.size, { width: GAME_VIEW_WIDTH / this.devZoom, height: GAME_VIEW_HEIGHT / this.devZoom }, center)
    this.camera.fov = pose.fov
    this.camera.position.set(pose.position.x, pose.position.y, pose.position.z)
    this.camera.lookAt(pose.target.x, pose.target.y, pose.target.z)
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
    // The sun's shadows are worked out round where the camera looks.
    this.sun.target.position.set(pose.target.x, 0, pose.target.z)
    this.sun.position.set(pose.target.x + SUN_DIRECTION.x * 2000, SUN_DIRECTION.y * 2000, pose.target.z + SUN_DIRECTION.z * 2000)
    this.sun.target.updateMatrixWorld()
    // The overlay is sized as the 2D world would be, so names and bars are the size they are in 2D.
    this.overlayRoot.scale.set(this.overlayScale())
  }

  // The point of the world under a point of the screen: the middle of a body the pointer is over (not the controlled
  // champion's), or else the ground there.
  screenToWorld(point: Vector2): Vector2 {
    const { width, height } = this.size
    if (width === 0 || height === 0) return { ...this.center }
    this.raycaster.setFromCamera(new ThreeVector2(point.x / width * 2 - 1, -(point.y / height) * 2 + 1), this.camera)
    const { origin, direction } = this.raycaster.ray
    let best: { t: number; at: Vector2 } | undefined
    for (const character of this.pickable) {
      if (character.dead || character.id === this.localId) continue
      const top = this.characters.topOf(character.id) ?? character.champion.radius * 3
      const t = rayHitsCylinder(origin, direction, character.position, character.champion.radius * 0.9, top)
      if (t !== undefined && (!best || t < best.t)) best = { t, at: { ...character.position } }
    }
    return best?.at ?? rayToGround(origin, direction) ?? { ...this.center }
  }

  update(frame: WorldFrame): void {
    const { now, characters, entities } = frame
    const dt = this.lastNow === undefined ? 1 / 60 : Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000))
    this.lastNow = now
    this.resize()
    const unseen = frame.unseen ?? NO_CHARACTERS
    this.pickable = characters
    this.localId = frame.localCharacterId
    this.vision.update(frame.fog)
    const fx = { glow: this.glow, puff: this.puff }
    const everyone = new Map<number, RenderedCharacter>()
    for (const character of characters) everyone.set(character.id, character)
    for (const character of unseen) everyone.set(character.id, character)

    const localTeam = everyone.get(frame.localCharacterId ?? -1)?.team
    // Each layer on its own, so one that goes wrong leaves the others drawn (see guard.ts); a batch that was begun is always ended.
    guarded('The 3D characters', () => this.characters.update(characters, unseen, now, dt, fx, {
      // A monster that is after someone faces them while it stands.
      targetOf: (character) => {
        const target = character.monster?.targetId === undefined ? undefined : everyone.get(character.monster.targetId)
        return target?.position
      },
    }, localTeam))

    this.lights.begin()
    this.effectPaint.begin()
    this.effectLight.begin()
    const effectContext = {
      t: now / 1000,
      dt,
      fx,
      lights: this.lights,
      decals: this.effectPaint,
      glowDecals: this.effectLight,
      characters: everyone,
      models: this.characters,
    }
    guarded('The 3D effects', () => this.effectsLayer.update(entities, effectContext))
    guarded('The 3D character effects', () => this.characterFx.update(characters, this.characters.takeReleases(), effectContext))
    this.effectPaint.end()
    this.effectLight.end()
    this.lights.end()

    this.paint.begin()
    this.light.begin()
    guarded('The 3D overlays', () => this.overlays.update({
      now,
      characters,
      unseen,
      entities,
      localCharacterId: frame.localCharacterId,
      ...(frame.castPreview ? { castPreview: frame.castPreview } : {}),
      attackMarkers: frame.attackMarkers,
      ...(frame.lockMarkerScale !== undefined ? { lockMarkerScale: frame.lockMarkerScale } : {}),
      ...(frame.selectedId !== undefined ? { selectedId: frame.selectedId } : {}),
      ...(frame.mode ? { mode: frame.mode } : {}),
      shops: frame.shops ?? [],
      effects: this.effects,
      debug: this.debug,
      ...(frame.debugPath ? { debugPath: frame.debugPath } : {}),
      walls: this.ground.walls,
    }, this.paint, this.light))
    this.paint.end()
    this.light.end()

    guarded('The 3D particles', () => {
      this.glow.update(dt)
      this.puff.update(dt)
    })
    guarded('Rendering the 3D world', () => this.renderer.render(this.scene, this.camera))

    // The names, bars and numbers, over where the models now are on screen.
    guarded('The nameplates', () => this.nameplates.update(characters, frame.localCharacterId, frame.localAttackCooldown, now, unseen))
    guarded('The damage numbers', () => this.numbers.update(characters, now))
    guarded('The kill rewards', () => this.rewards.update(frame.rewards ?? [], now))
  }

  destroy(): void {
    this.overlayRoot.removeFromParent()
    this.overlayRoot.destroy({ children: true })
    this.app.canvas.style.position = ''
    this.terrain.dispose()
    this.characters.dispose()
    this.effectsLayer.dispose()
    this.characterFx.dispose()
    this.overlays.dispose()
    for (const batch of [this.paint, this.light, this.effectPaint, this.effectLight]) batch.dispose()
    this.glow.dispose()
    this.puff.dispose()
    this.vision.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }

  // The scale the 2D view would draw the world at on this screen.
  private overlayScale(): number {
    return Math.min(this.size.width / GAME_VIEW_WIDTH, this.size.height / GAME_VIEW_HEIGHT) || 1
  }

  // Where the overlay puts what is over a character: over the top of its model on screen, moved down by its radius, since the
  // 2D layers go up by that from a character's position before they go up past its body.
  private anchorOf(position: Vector2, radius: number, id?: number): Vector2 {
    const top = id === undefined ? undefined : this.characters.topOf(id)
    this.projected.set(position.x, top ?? radius * 3, position.y).project(this.camera)
    const scale = this.overlayScale()
    return {
      x: (this.projected.x + 1) / 2 * this.size.width / scale,
      y: (1 - this.projected.y) / 2 * this.size.height / scale + radius + 6,
    }
  }

  // Where a point of the world, this high, is on the screen, in the screen's pixels.
  private toScreen(point: Vector2, height: number): Vector2 {
    this.projected.set(point.x, height, point.y).project(this.camera)
    return { x: (this.projected.x + 1) / 2 * this.size.width, y: (1 - this.projected.y) / 2 * this.size.height }
  }

  // Matches the 3D canvas to the size of the page's canvas, and the camera and particles to it.
  private resize(): void {
    const width = this.app.screen.width
    const height = this.app.screen.height
    const ratio = this.renderer.getPixelRatio()
    if (width === this.size.width && height === this.size.height && ratio === this.size.ratio) return
    this.size = { width, height, ratio }
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / Math.max(1, height)
    this.camera.updateProjectionMatrix()
    const pixels = height * ratio / (2 * Math.tan(this.camera.fov / 2 * Math.PI / 180))
    this.glow.setScale(pixels)
    this.puff.setScale(pixels)
  }
}
