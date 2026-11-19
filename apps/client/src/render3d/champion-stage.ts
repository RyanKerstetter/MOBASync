import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  CylinderGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three'
import type { Champion } from '../../../../packages/shared/src/index.ts'
import { guarded } from '../guard.ts'
import { cutFinely } from './models/detail/shapes.ts'
import { championFigure, type HumanoidModel } from './models/humanoid.ts'
import { championLook } from './models/looks.ts'
import { RELEASE_SECONDS } from './models/model.ts'
import { VisionShading } from './vision-shading.ts'

// Champion select's 3D: the picked champion standing on a lit pedestal and turning slowly (it can be dragged round), and a portrait of
// every champion for the grid, drawn once. Both use the models of the game itself (`HumanoidModel` dressed by `championLook`), so a
// champion looks the same here as in a game. Neither has any fog: a vision shading with no mask draws everything lit.

// The windup and the moment after it of the cast a champion plays when it is picked, in seconds.
const PICK_WINDUP = 0.35
// How fast it turns by itself, in radians a second, and how far a drag across the whole canvas turns it.
const IDLE_TURN = 0.35
const DRAG_TURN = Math.PI * 1.5

function lights(scene: Scene): void {
  scene.add(new HemisphereLight('#cfe0ff', '#3a2c1c', 1.25))
  const key = new DirectionalLight('#fff0d8', 2.6)
  key.position.set(2, 4, 3.5)
  scene.add(key)
  // A cool light from behind, which picks out its edge against the dark.
  const rim = new DirectionalLight('#8fb8ff', 2.2)
  rim.position.set(-2.5, 2.5, -3)
  scene.add(rim)
}

// A soft round glow, transparent at its edge, to lay on the pedestal.
function glowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const paint = canvas.getContext('2d')
  if (paint) {
    const gradient = paint.createRadialGradient(64, 64, 0, 64, 64, 64)
    gradient.addColorStop(0, 'rgba(255,255,255,0.9)')
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.35)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    paint.fillStyle = gradient
    paint.fillRect(0, 0, 128, 128)
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

function championModel(vision: VisionShading, champion: Champion): HumanoidModel {
  // Seen up close here, so cut finely (see shapes.ts).
  const model = cutFinely(() => championFigure(vision, champion.radius, championLook(champion), champion.id))
  // In a game a champion is about 3.6 times its radius tall; here every one is drawn at about 1.8 (times its look's `tall`), so the
  // camera is the same for all of them, and a broad or a tall champion still shows as broad or tall.
  model.root.scale.multiplyScalar(0.5 / champion.radius)
  return model
}

export class ChampionStage {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(28, 1, 0.1, 50)
  private readonly vision = new VisionShading()
  private readonly ring: Mesh<RingGeometry, MeshBasicMaterial>
  private readonly glow: Mesh<CircleGeometry, MeshBasicMaterial>
  private readonly underLight = new PointLight('#ffffff', 6, 4)
  private model: HumanoidModel | undefined
  private shownId: string | undefined
  private pickedAt = -Infinity
  private yaw = 0
  private frame: number | undefined
  private last = 0
  private clock = 0
  private drag: { x: number; yaw: number } | undefined

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.1
    this.renderer.setClearColor(0x000000, 0)
    lights(this.scene)

    const stone = new MeshStandardMaterial({ color: '#2b241d', roughness: 0.85, metalness: 0.1 })
    const pedestal = new Mesh(new CylinderGeometry(0.95, 1.05, 0.16, 48), stone)
    pedestal.position.y = -0.08
    this.scene.add(pedestal)
    const trim = new Mesh(new CylinderGeometry(1.06, 1.06, 0.03, 48, 1, true), new MeshStandardMaterial({ color: '#a8823f', roughness: 0.45, metalness: 0.8 }))
    trim.position.y = -0.02
    this.scene.add(trim)
    this.glow = new Mesh(new CircleGeometry(1.25, 48), new MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.55 }))
    this.glow.rotation.x = -Math.PI / 2
    this.glow.position.y = 0.005
    this.scene.add(this.glow)
    this.ring = new Mesh(new RingGeometry(0.82, 0.86, 64), new MeshBasicMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.8 }))
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 0.006
    this.scene.add(this.ring)
    this.underLight.position.set(0, 0.25, 0.6)
    this.scene.add(this.underLight)

    this.camera.position.set(0, 1.6, 6.8)
    this.camera.lookAt(0, 0.92, 0)

    canvas.addEventListener('pointerdown', (event) => {
      this.drag = { x: event.clientX, yaw: this.yaw }
      canvas.setPointerCapture(event.pointerId)
    })
    canvas.addEventListener('pointermove', (event) => {
      if (!this.drag) return
      this.yaw = this.drag.yaw + (event.clientX - this.drag.x) / Math.max(1, canvas.clientWidth) * DRAG_TURN
    })
    const endDrag = (): void => { this.drag = undefined }
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)
  }

  // Stands this champion on the pedestal, in its own colour, and has it cast as it steps up. The same one again changes nothing.
  show(champion: Champion): void {
    if (champion.id === this.shownId) return
    this.shownId = champion.id
    this.model?.dispose()
    this.model?.root.removeFromParent()
    this.model = championModel(this.vision, champion)
    this.scene.add(this.model.root)
    const accent = championLook(champion).accent
    this.ring.material.color.set(accent)
    this.glow.material.color.set(accent)
    this.underLight.color.set(accent)
    this.pickedAt = this.clock
    this.yaw = 0
  }

  // Draws every frame while the canvas is shown, and stops by itself once it is not; calling it again goes on.
  start(): void {
    if (this.frame !== undefined) return
    this.last = performance.now()
    const tick = (now: number): void => {
      // Champion select has closed (its panel is hidden): stop until it is shown again.
      if (this.canvas.offsetParent === null) {
        this.frame = undefined
        return
      }
      this.frame = requestAnimationFrame(tick)
      const dt = Math.min(0.1, (now - this.last) / 1000)
      this.last = now
      guarded('The champion select stage', () => this.draw(dt))
    }
    this.frame = requestAnimationFrame(tick)
  }

  stop(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.frame = undefined
  }

  private draw(dt: number): void {
    this.clock += dt
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    if (width === 0 || height === 0) return
    if (this.canvas.width !== Math.round(width * this.renderer.getPixelRatio()) || this.canvas.height !== Math.round(height * this.renderer.getPixelRatio())) {
      this.renderer.setSize(width, height, false)
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
    }
    if (!this.drag) this.yaw += IDLE_TURN * dt * Math.cos(this.clock * 0.25)
    const model = this.model
    if (model) {
      const since = this.clock - this.pickedAt
      const action = since < PICK_WINDUP ? { kind: 'cast' as const, progress: since / PICK_WINDUP } : undefined
      const after = (since - PICK_WINDUP) / RELEASE_SECONDS
      const release = since >= PICK_WINDUP && after < 1 ? { kind: 'cast' as const, t: after } : undefined
      model.pose({ t: this.clock, dt, moving: false, speed: 0, ...(action ? { action } : {}), ...(release ? { release } : {}), dead: false, deadFor: 0, stunned: false })
      model.root.rotation.y = this.yaw
    }
    // The ring breathes, and flares as the champion steps up.
    const flare = Math.max(0, 1 - (this.clock - this.pickedAt) / 0.8)
    this.ring.material.opacity = 0.55 + Math.sin(this.clock * 2.2) * 0.15 + flare * 0.4
    this.glow.material.opacity = 0.4 + flare * 0.5
    this.underLight.intensity = 4 + flare * 10
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.stop()
    this.model?.dispose()
    this.renderer.dispose()
  }
}

// A portrait of each champion, head and shoulders turned a little to one side on a clear background, as a picture's address. They
// are drawn one a frame, so the page does not stall, and handed over as each is done. Nothing is drawn where WebGL is not to be had.
export function drawChampionPortraits(champions: readonly Champion[], size: number, onPortrait: (championId: string, url: string) => void): void {
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  } catch {
    return
  }
  renderer.setPixelRatio(1)
  renderer.setSize(size, size, false)
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.15
  renderer.setClearColor(0x000000, 0)
  const scene = new Scene()
  lights(scene)
  const camera = new PerspectiveCamera(24, 1, 0.1, 50)
  camera.position.set(0.55, 1.62, 3.1)
  camera.lookAt(0, 1.32, 0)
  const vision = new VisionShading()
  const queue = [...champions]
  const next = (): void => {
    const champion = queue.shift()
    if (!champion) {
      renderer.dispose()
      renderer.forceContextLoss()
      return
    }
    // One that cannot be drawn is left without a portrait, and the rest are still drawn.
    guarded(`The portrait of ${champion.id}`, () => {
      const model = championModel(vision, champion)
      try {
        // A tall champion is framed by its face all the same.
        const tall = championLook(champion).tall
        model.root.position.y = (1 - tall) * 1.4
        model.pose({ t: 0.8, dt: 0, moving: false, speed: 0, dead: false, deadFor: 0, stunned: false })
        model.root.rotation.y = 0.32
        scene.add(model.root)
        renderer.render(scene, camera)
        onPortrait(champion.id, renderer.domElement.toDataURL('image/png'))
      } finally {
        model.root.removeFromParent()
        model.dispose()
      }
    })
    requestAnimationFrame(next)
  }
  requestAnimationFrame(next)
}
