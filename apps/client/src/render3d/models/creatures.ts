import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  DodecahedronGeometry,
  Group,
  IcosahedronGeometry,
  SphereGeometry,
  Vector3,
  type Mesh,
  type MeshStandardMaterial,
} from 'three'
import { jitter } from '../terrain-mesh.ts'
import { colour, lerp } from '../space.ts'
import type { VisionShading } from '../vision-shading.ts'
import { approach, ease, easeOut, joint, Model, type FxContext, type PoseInput } from './model.ts'

// A slime: a glob of glossy green jelly that sags into a puddle where it meets the ground, its surface forever quivering, with a
// darker nucleus and bubbles drifting up through it. It hops to walk, wobbling as it lands and dripping as it goes, squashes down
// to gather itself for a bite and lunges, and melts away when it dies.
export class SlimeModel extends Model {
  readonly height: number
  private readonly blob: Group
  private readonly hop: Group
  private readonly bodyMaterial: MeshStandardMaterial
  private readonly body: Mesh<SphereGeometry>
  // Where each point of the body is at rest, on a sphere, for the quiver to be worked out from.
  private readonly rest: Float32Array
  private readonly bubbles: Array<{ mesh: Mesh; offset: number; x: number; z: number }> = []
  private readonly nucleus: Mesh
  private hopPhase = 0
  private walkWeight = 0
  private actionWeight = 0
  private readonly scale: number
  private readonly seed = Math.random() * 10

  constructor(vision: VisionShading, radius: number) {
    super(vision)
    this.scale = radius / 0.5
    this.height = 0.78 * this.scale
    this.root.scale.setScalar(this.scale)
    this.hop = joint(this.root)
    this.blob = joint(this.hop)
    this.bodyMaterial = this.surface('#46c454', { roughness: 0.06, metalness: 0, transparent: true, opacity: 0.74, emissive: colour('#145a1c'), emissiveIntensity: 0.45 })
    // A see-through body still gets the edge an enemy has.
    this.bodyMaterial.userData.outline = true
    this.body = this.part(this.blob, new SphereGeometry(0.5, 24, 16), this.bodyMaterial, 0, 0.36, 0) as Mesh<SphereGeometry>
    this.body.castShadow = true
    this.rest = Float32Array.from(this.body.geometry.getAttribute('position').array as ArrayLike<number>)
    this.nucleus = this.part(this.blob, new SphereGeometry(0.16, 16, 12), this.surface('#1f6b26', { roughness: 0.3, emissive: colour('#0c3a10'), emissiveIntensity: 0.4 }), 0.04, 0.3, -0.03, false)
    const bubble = this.surface('#c8ffcf', { roughness: 0.05, transparent: true, opacity: 0.5, emissive: colour('#5fbf5a'), emissiveIntensity: 0.3 })
    for (let index = 0; index < 5; index += 1) {
      const mesh = this.part(this.blob, new SphereGeometry(0.03 + (index % 3) * 0.015, 8, 6), bubble, 0, 0, 0, false)
      this.bubbles.push({ mesh, offset: index / 5, x: (Math.random() - 0.5) * 0.4, z: (Math.random() - 0.5) * 0.4 })
    }
  }

  pose(input: PoseInput): void {
    const { t, dt } = input
    this.walkWeight = approach(this.walkWeight, input.moving && !input.dead ? 1 : 0, 8, dt)
    const acting = input.action !== undefined || input.release !== undefined
    this.actionWeight = approach(this.actionWeight, acting ? 1 : 0, acting ? 20 : 8, dt)
    this.hopPhase += dt * Math.max(60, input.speed) / (0.9 * this.scale) * Math.PI * this.walkWeight
    // Standing, it sags and quivers; walking, it hops, squashed as it lands and stretched as it leaves the ground.
    const hop = Math.abs(Math.sin(this.hopPhase))
    let lift = hop * 0.22 * this.walkWeight
    let squash = 1 + Math.sin(t * 2.6 + this.seed) * 0.04 + (hop - 0.5) * 0.22 * this.walkWeight
    let forward = 0
    // How hard the jelly wobbles: more as it lands, and when it is hit or stunned.
    let jiggle = 0.035 + (1 - hop) * 0.05 * this.walkWeight
    if (this.actionWeight > 0.001) {
      const gather = input.action ? ease(input.action.progress) : 1
      const lunge = input.release ? Math.sin(Math.min(1, input.release.t * 1.6) * Math.PI) : 0
      squash = lerp(squash, input.release ? lerp(0.8, 1.3, lunge) : lerp(1, 0.68, gather), this.actionWeight)
      forward = input.release ? lunge * 0.45 : -gather * 0.08
      lift = Math.max(lift, lunge * 0.12)
      jiggle += gather * 0.04 + lunge * 0.05
    }
    if (input.stunned && !input.dead) jiggle += 0.06
    let melt = 0
    if (input.dead) {
      melt = easeOut(input.deadFor / 0.9)
      squash = lerp(1, 0.15, melt)
      lift = 0
      forward = 0
      this.bodyMaterial.opacity = 0.74 * (1 - melt * 0.9)
    } else {
      this.bodyMaterial.opacity = 0.74
    }
    const spread = Math.min(1.9, 1 / Math.sqrt(Math.max(0.1, squash)))
    this.blob.scale.set(spread, squash, spread)
    this.hop.position.set(0, lift, forward)
    this.quiver(t, jiggle, lift, melt)
    // Bubbles drifting up through it, and starting again at the bottom.
    for (const bubble of this.bubbles) {
      const k = (t * 0.25 + bubble.offset) % 1
      bubble.mesh.position.set(bubble.x * (1 - k * 0.5), 0.08 + k * 0.5, bubble.z * (1 - k * 0.5))
      bubble.mesh.visible = !input.dead
    }
    this.nucleus.position.y = 0.3 + Math.sin(t * 1.7 + this.seed) * 0.03
  }

  // The jelly's surface: each point of the sphere pushed in and out by waves that run over it, and the bottom spread out flat into a
  // puddle on the ground (more so as it melts). In the air (`lift`) it hangs rounder.
  private quiver(t: number, jiggle: number, lift: number, melt: number): void {
    const positions = this.body.geometry.getAttribute('position')
    const rest = this.rest
    const sag = Math.max(0, 1 - lift * 4)
    for (let index = 0; index < positions.count; index += 1) {
      const x = rest[index * 3]
      const y = rest[index * 3 + 1]
      const z = rest[index * 3 + 2]
      const wave = 1 + jiggle * (Math.sin(t * 6.3 + y * 9 + x * 5 + this.seed) + 0.7 * Math.sin(t * 4.1 + z * 8 - y * 4))
      let px = x * wave
      let py = y * wave
      let pz = z * wave
      // The bottom slumps: below the middle it spreads out and flattens, into a puddle at the ground.
      const low = Math.max(0, -y / 0.5)
      const flat = (0.5 + melt * 0.5) * sag
      const out = 1 + low * (0.25 + low * 0.75 + melt) * sag
      px *= out
      pz *= out
      py = py - low * low * 0.5 * flat * 0.5 * (1 + melt)
      // The top bulges a touch.
      if (y > 0) py *= 1 + jiggle * 0.6 * Math.sin(t * 5 + this.seed)
      positions.setXYZ(index, px, py, pz)
    }
    positions.needsUpdate = true
    this.body.geometry.computeVertexNormals()
  }

  override ambient(fx: FxContext, dt: number): void {
    // Drips of jelly as it hops along.
    if (this.walkWeight > 0.3 && Math.random() < dt * 6) {
      const at = this.root.localToWorld(new Vector3((Math.random() - 0.5) * 0.6, 0.15, (Math.random() - 0.5) * 0.6))
      fx.puff.emit({ x: at.x, y: at.y, z: at.z, vy: -10, life: 0.5, size: 4, color: colour('#46c454'), alpha: 0.8, gravity: -300 })
    }
  }

  override release(_kind: 'attack' | 'cast', fx: FxContext): void {
    const at = this.root.localToWorld(new Vector3(0, 0.3, 0.6))
    const tint = colour('#6fe07a')
    for (let index = 0; index < 10; index += 1) {
      fx.puff.emit({
        x: at.x,
        y: at.y,
        z: at.z,
        vx: (Math.random() - 0.5) * 80,
        vy: 30 + Math.random() * 60,
        vz: (Math.random() - 0.5) * 80,
        life: 0.45,
        size: 5,
        sizeEnd: 3,
        color: tint,
        alpha: 0.85,
        gravity: -300,
      })
    }
  }
}

// A wolf: grey, lean and low, with a shaggy ruff, a long muzzle, pointed ears and eyes that glow. It trots on four legs with its
// tail out, crouches to spring, lunges with its jaws open, and lies down on its side when it dies.
export class WolfModel extends Model {
  readonly height: number
  private readonly scale: number
  private readonly fall: Group
  private readonly body: Group
  private readonly head: Group
  private readonly jaw: Group
  private readonly tail: Group
  private readonly legs: Group[] = []
  private walkWeight = 0
  private actionWeight = 0
  private phase = 0

  constructor(vision: VisionShading, radius: number) {
    super(vision)
    this.scale = radius / 0.5 * 0.85
    this.height = 0.95 * this.scale
    this.root.scale.setScalar(this.scale)
    const fur = this.surface('#7d7a74', { roughness: 0.95, flatShading: true })
    const pale = this.surface('#c9c2b3', { roughness: 0.95, flatShading: true })
    const dark = this.surface('#2a2622', { roughness: 0.9 })
    const eyes = this.surface('#ffd86a', { emissive: colour('#ffb02e'), emissiveIntensity: 2 })
    this.fall = joint(this.root)
    this.body = joint(this.fall, 0, 0.52, 0)
    const trunk = this.part(this.body, jitter(new DodecahedronGeometry(0.3, 1), 0.08, 21), fur, 0, 0, -0.05)
    trunk.scale.set(0.8, 0.75, 1.5)
    const ruff = this.part(this.body, jitter(new DodecahedronGeometry(0.24, 1), 0.15, 22), pale, 0, 0.05, 0.3)
    ruff.scale.set(1.05, 1, 0.9)
    this.head = joint(this.body, 0, 0.12, 0.48)
    this.part(this.head, jitter(new DodecahedronGeometry(0.15, 0), 0.1, 23), fur, 0, 0.02, 0)
    const muzzle = this.part(this.head, new ConeGeometry(0.08, 0.26, 6), pale, 0, -0.01, 0.17)
    muzzle.rotation.x = Math.PI / 2
    this.part(this.head, new SphereGeometry(0.025, 6, 4), dark, 0, 0, 0.3)
    for (const side of [-1, 1]) {
      this.part(this.head, new ConeGeometry(0.05, 0.13, 4), fur, side * 0.08, 0.15, -0.02).rotation.z = -side * 0.25
      this.part(this.head, new SphereGeometry(0.022, 6, 4), eyes, side * 0.06, 0.06, 0.11, false)
    }
    this.jaw = joint(this.head, 0, -0.06, 0.05)
    const lower = this.part(this.jaw, new ConeGeometry(0.05, 0.2, 5), pale, 0, 0, 0.1)
    lower.rotation.x = Math.PI / 2
    for (const [x, z] of [[-0.13, 0.25], [0.13, 0.25], [-0.13, -0.3], [0.13, -0.3]]) {
      const leg = joint(this.body, x, -0.1, z)
      this.part(leg, new CapsuleGeometry(0.045, 0.3, 4, 6), fur, 0, -0.2, 0)
      this.part(leg, new BoxGeometry(0.07, 0.04, 0.1), dark, 0, -0.42, 0.02)
      this.legs.push(leg)
    }
    this.tail = joint(this.body, 0, 0.05, -0.45)
    this.part(this.tail, new ConeGeometry(0.07, 0.42, 6), fur, 0, 0, -0.18).rotation.x = -Math.PI / 2 - 0.3
  }

  pose(input: PoseInput): void {
    const { t, dt } = input
    this.walkWeight = approach(this.walkWeight, input.moving && !input.dead ? 1 : 0, 9, dt)
    const acting = input.action !== undefined || input.release !== undefined
    this.actionWeight = approach(this.actionWeight, acting ? 1 : 0, acting ? 20 : 8, dt)
    this.phase += dt * Math.max(60, input.speed) / (0.8 * this.scale) * Math.PI * this.walkWeight
    const w = this.walkWeight
    const s = Math.sin(this.phase)
    // A trot: the legs go in diagonal pairs.
    this.legs[0].rotation.x = s * 0.7 * w
    this.legs[3].rotation.x = s * 0.7 * w
    this.legs[1].rotation.x = -s * 0.7 * w
    this.legs[2].rotation.x = -s * 0.7 * w
    let bodyPitch = Math.sin(t * 2) * 0.02
    let crouch = Math.abs(Math.cos(this.phase)) * 0.03 * w
    let lunge = 0
    let bite = 0
    if (this.actionWeight > 0.001) {
      const gather = input.action ? ease(input.action.progress) : 1
      const spring = input.release ? Math.sin(Math.min(1, input.release.t * 1.5) * Math.PI) : 0
      crouch = lerp(crouch, input.release ? -0.05 : 0.12 * gather, this.actionWeight)
      bodyPitch = lerp(bodyPitch, input.release ? -0.2 * spring : 0.15 * gather, this.actionWeight)
      lunge = spring * 0.35
      bite = input.release ? spring : gather * 0.5
    }
    this.body.position.set(0, 0.52 - crouch, lunge)
    this.body.rotation.x = bodyPitch
    this.jaw.rotation.x = bite * 0.6 + (input.stunned ? Math.sin(t * 10) * 0.1 : 0)
    this.head.rotation.x = -0.1 + Math.sin(t * 1.7) * 0.04
    this.tail.rotation.y = Math.sin(t * (2 + w * 6)) * (0.2 + 0.3 * w)
    if (input.dead) {
      const fall = easeOut(input.deadFor / 0.6)
      this.fall.rotation.z = Math.PI / 2 * fall
      this.fall.position.y = 0.1 * fall
    } else {
      this.fall.rotation.z = 0
      this.fall.position.y = 0
    }
  }
}

// A golem: a hulk of stone with mossy shoulders, a small head sunk between them with glowing eyes, runes that glow on its chest,
// great fists, and short legs. It lumbers, swaying, raises both fists over its head to strike, and brings them down in a slam
// that throws up dust. When it dies, it falls apart.
export class GolemModel extends Model {
  readonly height: number
  private readonly scale: number
  private readonly body: Group
  private readonly torso: Group
  private readonly armL: { shoulder: Group; elbow: Group }
  private readonly armR: { shoulder: Group; elbow: Group }
  private readonly legL: Group
  private readonly legR: Group
  private readonly pieces: Mesh[] = []
  private readonly runes: MeshStandardMaterial
  private walkWeight = 0
  private actionWeight = 0
  private phase = 0
  private readonly scatter: Vector3[] = []

  constructor(vision: VisionShading, radius: number) {
    super(vision)
    this.scale = radius / 0.5 * 0.74
    this.height = 1.45 * this.scale
    this.root.scale.setScalar(this.scale)
    const stone = this.surface('#7d7a74', { roughness: 0.95, flatShading: true })
    const darkStone = this.surface('#5c5953', { roughness: 0.95, flatShading: true })
    const moss = this.surface('#4f7d34', { roughness: 0.9, flatShading: true })
    this.runes = this.surface('#7ef0ff', { emissive: colour('#38d8ff'), emissiveIntensity: 1.6, roughness: 0.3 })
    const rock = (size: number, seed: number) => jitter(new DodecahedronGeometry(size, 0), 0.16, seed)

    this.body = joint(this.root)
    const hips = joint(this.body, 0, 0.55, 0)
    this.torso = joint(hips, 0, 0.05, 0)
    const chest = this.part(this.torso, rock(0.5, 1), stone, 0, 0.42, 0)
    chest.scale.set(1.25, 0.95, 0.9)
    this.pieces.push(chest)
    this.pieces.push(this.part(this.torso, rock(0.3, 2), darkStone, 0, 0.0, 0))
    // The head, sunk forward between the shoulders.
    const head = this.part(this.torso, rock(0.2, 3), stone, 0, 0.88, 0.12)
    this.pieces.push(head)
    for (const side of [-1, 1]) {
      this.part(head, new SphereGeometry(0.04, 8, 6), this.runes, side * 0.08, 0.02, 0.17, false)
    }
    // Runes on the chest.
    this.part(this.torso, new BoxGeometry(0.06, 0.3, 0.03), this.runes, 0, 0.45, 0.45, false)
    this.part(this.torso, new BoxGeometry(0.22, 0.05, 0.03), this.runes, 0, 0.52, 0.44, false)

    const arm = (side: number): { shoulder: Group; elbow: Group } => {
      const shoulder = joint(this.torso, side * 0.68, 0.62, 0)
      const pad = this.part(shoulder, rock(0.27, 4 + side), stone, side * 0.04, 0.05, 0)
      this.pieces.push(pad)
      this.part(shoulder, new IcosahedronGeometry(0.2, 0), moss, side * 0.02, 0.2, -0.02).scale.set(1.2, 0.5, 1.1)
      this.pieces.push(this.part(shoulder, rock(0.18, 6 + side), darkStone, 0, -0.28, 0))
      const elbow = joint(shoulder, 0, -0.5, 0)
      this.pieces.push(this.part(elbow, rock(0.22, 8 + side), stone, 0, -0.12, 0))
      const fist = this.part(elbow, rock(0.27, 10 + side), darkStone, 0, -0.42, 0.03)
      this.pieces.push(fist)
      return { shoulder, elbow }
    }
    this.armL = arm(-1)
    this.armR = arm(1)
    const leg = (side: number): Group => {
      const hip = joint(hips, side * 0.3, 0, 0)
      this.pieces.push(this.part(hip, rock(0.22, 12 + side), darkStone, 0, -0.22, 0))
      const foot = this.part(hip, new BoxGeometry(0.34, 0.16, 0.42), stone, 0, -0.5, 0.06)
      this.pieces.push(foot)
      return hip
    }
    this.legL = leg(-1)
    this.legR = leg(1)
    for (let index = 0; index < this.pieces.length; index += 1) {
      this.scatter.push(new Vector3((Math.random() - 0.5) * 2, Math.random() * 0.6, (Math.random() - 0.5) * 2))
    }
  }

  pose(input: PoseInput): void {
    const { t, dt } = input
    this.walkWeight = approach(this.walkWeight, input.moving && !input.dead ? 1 : 0, 6, dt)
    const acting = input.action !== undefined || input.release !== undefined
    this.actionWeight = approach(this.actionWeight, acting ? 1 : 0, acting ? 16 : 6, dt)
    this.phase += dt * Math.max(40, input.speed) / (1.1 * this.scale) * Math.PI * this.walkWeight
    const w = this.walkWeight
    const s = Math.sin(this.phase)
    const breathe = Math.sin(t * 1.4)
    let shoulderL = -0.15 + s * 0.35 * w
    let shoulderR = -0.15 - s * 0.35 * w
    let elbow = -0.35
    let lean = 0.08 * w + breathe * 0.02
    let sway = s * 0.1 * w
    const bob = Math.abs(Math.cos(this.phase)) * 0.06 * w
    // A slam: both fists raised high over its head, then brought down in front of it.
    if (this.actionWeight > 0.001) {
      const raise = input.action ? ease(input.action.progress) : 1
      const slam = input.release ? easeOut(Math.min(1, input.release.t * 3)) : 0
      const settle = input.release ? ease((input.release.t - 0.5) / 0.5) : 0
      const k = this.actionWeight * (1 - settle)
      const up = lerp(-0.15, -2.9, raise)
      shoulderL = lerp(shoulderL, lerp(up, -1.0, slam), k)
      shoulderR = lerp(shoulderR, lerp(up, -1.0, slam), k)
      elbow = lerp(elbow, lerp(-0.5, -0.05, slam), k)
      lean = lerp(lean, lerp(-0.2 * raise, 0.45, slam), k)
      sway *= 1 - k
    }
    if (input.stunned && !input.dead) sway += Math.sin(t * 6) * 0.06
    this.armL.shoulder.rotation.set(shoulderL, 0, -0.1)
    this.armR.shoulder.rotation.set(shoulderR, 0, 0.1)
    this.armL.elbow.rotation.x = elbow
    this.armR.elbow.rotation.x = elbow
    this.legL.rotation.x = -s * 0.45 * w
    this.legR.rotation.x = s * 0.45 * w
    this.torso.rotation.set(lean, 0, sway)
    this.body.position.y = bob
    this.runes.emissiveIntensity = 1.4 + breathe * 0.3 + (input.action ? input.action.progress * 1.5 : 0)
    // Dead: it falls to pieces, each rolling a little away and sinking, and its light goes out.
    const crumble = input.dead ? easeOut(input.deadFor / 1.2) : 0
    this.pieces.forEach((piece, index) => {
      const away = this.scatter[index]
      piece.userData.home ??= piece.position.clone()
      const home = piece.userData.home as Vector3
      piece.position.set(home.x + away.x * crumble * 0.4, home.y - crumble * (0.4 + away.y), home.z + away.z * crumble * 0.4)
    })
    if (input.dead) this.runes.emissiveIntensity = 1.5 * (1 - crumble)
  }

  override release(kind: 'attack' | 'cast', fx: FxContext): void {
    if (kind !== 'attack') return
    // Dust thrown up in a ring where the fists come down.
    const at = this.root.localToWorld(new Vector3(0, 0.05, 0.75))
    const dust = colour('#b9a88c')
    for (let index = 0; index < 26; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const speed = 50 + Math.random() * 70
      fx.puff.emit({
        x: at.x,
        y: Math.max(2, at.y),
        z: at.z,
        vx: Math.cos(angle) * speed,
        vy: 10 + Math.random() * 30,
        vz: Math.sin(angle) * speed,
        life: 0.7 + Math.random() * 0.4,
        size: 14,
        sizeEnd: 34,
        color: dust,
        alpha: 0.45,
        drag: 2.5,
      })
    }
  }
}
