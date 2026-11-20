import { Container, type Application } from 'pixi.js'
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Frustum,
  HemisphereLight,
  Matrix4,
  PCFShadowMap,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Sphere,
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
import { UNCAPPED_FPS } from '../game-settings.ts'
import { GRAPHICS_PRESETS, type GraphicsOptions } from '../render/graphics-quality.ts'

const NO_CHARACTERS: readonly RenderedCharacter[] = []
// The direction the sun shines from: high, from the upper left of the screen, so shadows fall down and to the right.
const SUN_DIRECTION = new Vector3(-0.55, 1, -0.4).normalize()
// How far round the camera's target the sun's shadows are worked out, which is more than the screen shows.
const SHADOW_REACH = 1300
// How far off the screen a character is still posed, in world units: far enough that its shadow, falling onto the screen, moves.
const VIEW_MARGIN = 250
// The most pixels the world is drawn with for each of the page's (see the constructor), by the resolution setting (graphics-quality.ts).
const MAX_PIXEL_RATIO = { high: 1.5, standard: 1 } as const
// The sun's shadows by the shadows setting: how many pixels across the map they are worked out on, and how their edges are softened.
const SHADOW_MAP = { high: { size: 2048, type: PCFSoftShadowMap }, low: { size: 1024, type: PCFShadowMap } } as const
// With dynamic resolution, the picture is drawn smaller (and stretched to the screen) while the frame rate is short of what it should be,
// and sharper again when there is time to spare (see `adaptResolution`): no smaller than this share of the screen's pixels across, in steps
// of this much, judged over this many seconds of frames each time.
const LEAST_RESOLUTION = 0.5
const RESOLUTION_STEP = 0.1
const RESOLUTION_WINDOW = 2
// The frame rate it aims for with dynamic resolution: the page's limit, if it has one lower, and otherwise this.
const TARGET_FPS = 60
// By the particles setting: how many there are room for at once, what share of those let go are made, and how much bigger each is so an
// effect still reads.
const PARTICLES = {
  full: { glow: 7000, puff: 5000, keep: 1, grow: 1 },
  reduced: { glow: 3500, puff: 2500, keep: 0.6, grow: 1.15 },
  minimal: { glow: 1200, puff: 800, keep: 0.35, grow: 1.3 },
} as const
// The lights an effect can light the ground with (a fireball's glow), at once, with spell lights on. Each one costs every lit pixel on the
// screen, every frame, whether it is lit or not.
const EFFECT_LIGHTS = 6

export type WorldRenderer3DOptions = {
  // What the game is drawn in: its canvas is put under the page's 2D canvas, which goes on drawing the names and bars over it.
  container: HTMLElement
  app: Application
  ground: MapGround
  // How much it draws (see graphics-quality.ts). As High if not given.
  graphics?: Readonly<GraphicsOptions>
  // The most frames a second the page draws, which dynamic resolution is judged against (`UNCAPPED_FPS` for none). None if not given.
  maxFps?: number
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
  // How far the camera is zoomed (see zoom.ts).
  zoom = 1
  // The most frames a second the page draws (`UNCAPPED_FPS` for none), for dynamic resolution.
  maxFps: number
  readonly graphics: Readonly<GraphicsOptions>
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(34, 1, 10, 9000)
  // What the camera sees this frame, for leaving unposed the characters far off the screen (see `CharacterModels3D.update`).
  private readonly view = new Frustum()
  private readonly viewMatrix = new Matrix4()
  private readonly viewSphere = new Sphere()
  private readonly viewPoint = new Vector3()
  private readonly sun: DirectionalLight
  private readonly vision: VisionShading
  private readonly terrain: Terrain3D
  private readonly characters: CharacterModels3D
  private readonly effectsLayer = new EntityEffects3D()
  private readonly characterFx = new CharacterFx()
  private readonly overlays: GroundOverlays
  private readonly paint: DecalBatch
  private readonly light: DecalBatch
  private readonly effectPaint: DecalBatch
  private readonly effectLight: DecalBatch
  private readonly glow: ParticleSystem
  private readonly puff: ParticleSystem
  private readonly lights: LightPool
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
  // With dynamic resolution: the share of the screen's pixels across the picture is drawn with now, and the frames since that was last judged.
  private resolution = 1
  private frames = { count: 0, since: 0 }

  constructor(options: WorldRenderer3DOptions) {
    this.app = options.app
    this.ground = options.ground
    const graphics = options.graphics ?? GRAPHICS_PRESETS.high
    this.graphics = graphics
    this.maxFps = options.maxFps ?? UNCAPPED_FPS
    this.vision = new VisionShading(graphics)
    const particles = PARTICLES[graphics.particles]
    this.glow = new ParticleSystem(particles.glow, 'add', particles)
    this.puff = new ParticleSystem(particles.puff, 'normal', particles)
    this.lights = new LightPool(graphics.spellLights ? EFFECT_LIGHTS : 0)
    // Smoothed edges and shadows cost weak graphics far more than they show, so each can be turned off.
    this.renderer = new WebGLRenderer({ antialias: graphics.smoothEdges, powerPreference: 'high-performance' })
    // Sharper than this on a high-density screen costs far more to draw (twice the density is four times the pixels, each lit and
    // shadowed) than it shows, with the edges smoothed as they are.
    this.renderer.setPixelRatio(this.pixelRatio())
    const shadows = graphics.shadows === 'off' ? undefined : SHADOW_MAP[graphics.shadows]
    this.renderer.shadowMap.enabled = shadows !== undefined
    this.renderer.shadowMap.type = shadows?.type ?? PCFSoftShadowMap
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
    this.sun.castShadow = shadows !== undefined
    this.sun.shadow.mapSize.set(shadows?.size ?? 512, shadows?.size ?? 512)
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
        get resolution() {
          return renderer.resolution
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
    const zoom = this.zoom * this.devZoom
    const pose = mobaCameraPose(this.size, { width: GAME_VIEW_WIDTH / zoom, height: GAME_VIEW_HEIGHT / zoom }, center)
    this.camera.fov = pose.fov
    this.camera.position.set(pose.position.x, pose.position.y, pose.position.z)
    this.camera.lookAt(pose.target.x, pose.target.y, pose.target.z)
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
    // The sun's shadows are worked out round where the camera looks.
    this.sun.target.position.set(pose.target.x, 0, pose.target.z)
    this.sun.position.set(pose.target.x + SUN_DIRECTION.x * 2000, SUN_DIRECTION.y * 2000, pose.target.z + SUN_DIRECTION.z * 2000)
    this.sun.target.updateMatrixWorld()
    // Zoomed out, the shadows are worked out further round, to the edge of what is seen.
    const reach = SHADOW_REACH / Math.min(1, this.zoom)
    const shadow = this.sun.shadow.camera
    if (shadow.right !== reach) {
      shadow.left = -reach
      shadow.right = reach
      shadow.top = reach
      shadow.bottom = -reach
      shadow.updateProjectionMatrix()
    }
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

  // The ground under a point of the screen, whatever body stands in front of it.
  screenToGround(point: Vector2): Vector2 {
    const { width, height } = this.size
    if (width === 0 || height === 0) return { ...this.center }
    this.raycaster.setFromCamera(new ThreeVector2(point.x / width * 2 - 1, -(point.y / height) * 2 + 1), this.camera)
    return rayToGround(this.raycaster.ray.origin, this.raycaster.ray.direction) ?? { ...this.center }
  }

  update(frame: WorldFrame): void {
    const { now, characters, entities } = frame
    const dt = this.lastNow === undefined ? 1 / 60 : Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000))
    if (this.lastNow !== undefined) this.adaptResolution((now - this.lastNow) / 1000)
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
    this.view.setFromProjectionMatrix(this.viewMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse))
    guarded('The 3D characters', () => this.characters.update(characters, unseen, now, dt, fx, {
      inView: (position, height) => this.view.intersectsSphere(this.viewSphere.set(this.viewPoint.set(position.x, height / 2, position.y), height + VIEW_MARGIN)),
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

  // The pixels the picture is drawn with for each of the page's: the screen's own density, as far as the resolution setting allows, and with
  // dynamic resolution, as much of that as the frame rate allows.
  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO[this.graphics.resolution]) * this.resolution
  }

  // With dynamic resolution, every few seconds: the picture is drawn smaller while frames come slower than they should (the page's limit, or
  // `TARGET_FPS`), and sharper again while they come as fast as they should. A frame that took very long (the tab was hidden, the page
  // was busy) is not counted.
  private adaptResolution(seconds: number): void {
    if (!this.graphics.dynamicResolution || seconds > 0.25) return
    this.frames.count += 1
    this.frames.since += seconds
    if (this.frames.since < RESOLUTION_WINDOW) return
    const fps = this.frames.count / this.frames.since
    this.frames = { count: 0, since: 0 }
    const target = this.maxFps === UNCAPPED_FPS ? TARGET_FPS : Math.min(TARGET_FPS, this.maxFps)
    let next = this.resolution
    if (fps < target * 0.85) next = Math.max(LEAST_RESOLUTION, this.resolution - RESOLUTION_STEP)
    else if (fps > target * 0.95) next = Math.min(1, this.resolution + RESOLUTION_STEP / 2)
    if (Math.abs(next - this.resolution) < 1e-6) return
    this.resolution = next
    this.renderer.setPixelRatio(this.pixelRatio())
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
