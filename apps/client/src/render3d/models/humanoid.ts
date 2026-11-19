import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  IcosahedronGeometry,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  DoubleSide,
  type BufferGeometry,
  type ColorRepresentation,
  type Material,
  type Mesh,
  type MeshStandardMaterialParameters,
  type MeshBasicMaterial,
  type MeshStandardMaterial,
  type Object3D,
} from 'three'
import { reportOnce } from '../../guard.ts'
import { colour, lerp } from '../space.ts'
import { jitter } from '../terrain-mesh.ts'
import type { VisionShading } from '../vision-shading.ts'
import { DETAILS } from './detail/index.ts'
import type { DetailFrame, Hold } from './detail/kit.ts'
import type { Look, Style } from './looks.ts'
import { approach, ease, easeOut, joint, Model, type FxContext, type PoseInput } from './model.ts'

// A champion: one figure, dressed and armed as its look says (see looks.ts), and posed each frame for what it is doing. It is all
// in the champion's own colours: which side it is on is for its name tag, and for the red edge an enemy is drawn with (see
// `Model.setOutline`).

// A champion's figure: in full detail if its look has one, or, if that cannot be built, the plain figure, so the champion is still
// there to see and play (see guard.ts).
export function championFigure(vision: VisionShading, radius: number, look: Look, championId: string): HumanoidModel {
  if (!look.detail) return new HumanoidModel(vision, radius, look, championId)
  try {
    return new HumanoidModel(vision, radius, look, championId)
  } catch (error) {
    reportOnce(`The detailed model of ${championId}`, error)
    const { detail: _detail, ...plain } = look
    return new HumanoidModel(vision, radius, plain, championId)
  }
}

// The figure is built about 1.78 units high and half a unit across, and scaled to the champion.
const BUILT_RADIUS = 0.5
const HEIGHT = 1.78

type Arm = { shoulder: Group; elbow: Group; hand: Group }
type Leg = { hip: Group; knee: Group }
// How a held thing keeps its angle as the arm moves: fixed in the hand (a blade swings with it), kept upright (a staff), kept
// level and pointing ahead (a gun), or a bow's (`BOW_SWING`).

// A bow turns with the arm holding it most of the way, so it swings round the shoulder as it is raised to shoot and lowered after,
// and the wrist does the rest: it is upright with the arm raised as it is at full draw (`BOW_DRAWN_ARM`, the shoulder and the elbow
// of the 'bow' style's pose), and carried canted forward, at the ready, with the arm lower.
const BOW_SWING = 0.7
const BOW_DRAWN_ARM = -1.6

// The angles of the joints in a pose, in radians: each shoulder forward (negative) or back, and out from the side; each elbow
// bent; the legs; the body leaning forward and turned; the head nodding.
type Pose = {
  shoulderL: { x: number; z: number }
  shoulderR: { x: number; z: number }
  elbowL: number
  elbowR: number
  hipL: number
  hipR: number
  kneeL: number
  kneeR: number
  pitch: number
  yaw: number
  head: number
}

type Materials = ReturnType<HumanoidModel['materials']>

export class HumanoidModel extends Model {
  readonly height: number
  readonly accent: string
  readonly look: Look
  private readonly scale: number
  private readonly fall: Group
  private readonly body: Group
  private readonly hips: Group
  private readonly torso: Group
  private readonly head: Group
  private readonly armL: Arm
  private readonly armR: Arm
  private readonly legL: Leg
  private readonly legR: Leg
  private readonly mainHand: Group
  private readonly offHand?: Group
  private readonly mainHold: Hold
  private readonly offHold: Hold
  // Where what it does comes from: the stone of a staff, a gun's muzzle, a bow, a blade's point, a fist.
  private readonly tip: Object3D
  private readonly glows: MeshStandardMaterial[] = []
  private readonly flareGlow: MeshBasicMaterial
  private readonly flare: Mesh
  private readonly swayers: Array<{ part: Group; amount: number }> = []
  private skirt: Mesh | undefined
  // Whether its legs are under a robe that reaches the ankles, which they must stay inside.
  private robed = false
  // A gun held in both hands: it is gripped in the right hand and points at the left, so the hands are always on it, whatever the
  // arms do. Carried across the chest, it is brought up to the shoulder to fire.
  private carried: Group | undefined
  // How strongly the next blow is empowered (a readied ability, Flurry, Capricorn's passive), from 0 to 1, and the glows that show it
  // on what it strikes with.
  private empower = 0
  private readonly empowerGlows: Array<{ mesh: Mesh; material: MeshBasicMaterial }> = []
  // A champion built in full detail (see `Look.detail`) moves its own loose parts (a cape, a plume) once it has been posed.
  // (Should it go wrong, they are left still from then on: see `pose`.)
  private animateDetail: ((frame: DetailFrame) => void) | undefined
  private walkWeight = 0
  private actionWeight = 0
  private phase = 0
  private lastStyle: Style = 'blade'

  constructor(vision: VisionShading, radius: number, look: Look, readonly championId: string) {
    super(vision)
    this.look = look
    this.accent = look.accent
    this.scale = radius / BUILT_RADIUS * 1.02 * look.tall
    this.height = HEIGHT * this.scale
    this.root.scale.setScalar(this.scale)
    const b = look.bulk
    const m = this.materials(look)
    // Built in detail: only the skeleton here, and what hangs on it is the detailed model's.
    const builder = look.detail ? DETAILS[look.detail] : undefined
    const detailed = builder !== undefined

    this.fall = joint(this.root)
    this.body = joint(this.fall)
    this.hips = joint(this.body, 0, 0.92, 0)
    if (!detailed) this.part(this.hips, new CylinderGeometry(0.17 * b, 0.16 * b, 0.16, 10), m.pants, 0, 0, 0)

    const leg = (side: number): Leg => {
      const hip = joint(this.hips, side * 0.1 * b, -0.02, 0)
      if (detailed) return { hip, knee: joint(hip, 0, -0.42, 0) }
      const thick = look.armor === 'bark' ? 1.4 : look.armor === 'heavyplate' ? 1.2 : 1
      this.part(hip, new CapsuleGeometry(0.075 * thick, 0.3, 4, 8), m.legs, 0, -0.2, 0)
      const knee = joint(hip, 0, -0.42, 0)
      this.part(knee, new CapsuleGeometry(0.065 * thick, 0.3, 4, 8), m.legs, 0, -0.2, 0)
      if (look.armor === 'bark') {
        // Roots for feet.
        for (const turn of [-0.5, 0, 0.5]) {
          const root = this.part(knee, new ConeGeometry(0.04, 0.22, 5), m.skin, Math.sin(turn) * 0.08, -0.43, Math.cos(turn) * 0.08)
          root.rotation.set(Math.PI / 2 - 0.3, turn, 0)
        }
      } else {
        this.part(knee, new BoxGeometry(0.13, 0.08, 0.24), m.boots, 0, -0.44, 0.05)
      }
      return { hip, knee }
    }
    this.legL = leg(-1)
    this.legR = leg(1)

    this.torso = joint(this.hips, 0, 0.06, 0)
    if (!detailed) this.buildTorso(look, m, b)
    this.head = joint(this.torso, 0, 0.56, 0)
    if (!detailed) {
      this.buildHead(look, m)
      this.buildBack(look, m, b)
    }

    const arm = (side: number): Arm => {
      const shoulder = joint(this.torso, side * 0.27 * b, 0.47, 0)
      if (detailed) {
        const elbow = joint(shoulder, 0, -0.3, 0)
        return { shoulder, elbow, hand: joint(elbow, 0, -0.3, 0) }
      }
      const thick = look.armor === 'bark' ? 1.45 : look.armor === 'heavyplate' ? 1.25 : 1
      this.part(shoulder, new CapsuleGeometry(0.06 * thick, 0.22, 4, 8), m.upperArm, 0, -0.14, 0)
      const elbow = joint(shoulder, 0, -0.3, 0)
      this.part(elbow, new CapsuleGeometry(0.055 * thick, 0.2, 4, 8), m.forearm, 0, -0.13, 0)
      const hand = joint(elbow, 0, -0.3, 0)
      if (look.armor === 'bark') {
        // Twigs for fingers.
        for (const turn of [-0.6, 0, 0.6]) {
          const twig = this.part(hand, new ConeGeometry(0.025, 0.16, 4), m.skin, Math.sin(turn) * 0.04, -0.06, 0.02)
          twig.rotation.set(Math.PI, 0, turn * 0.6)
        }
        this.part(hand, new SphereGeometry(0.07, 8, 6), m.skin, 0, 0, 0)
      } else {
        this.part(hand, new SphereGeometry(look.weapon === 'fists' ? 0.075 : 0.055, 8, 6), look.weapon === 'fists' ? m.trim : m.skin, 0, 0, 0)
      }
      return { shoulder, elbow, hand }
    }
    this.armL = arm(-1)
    this.armR = arm(1)
    if (!detailed) this.buildShoulders(look, m, b)

    let held: ReturnType<HumanoidModel['buildWeapon']>
    if (builder) {
      const kit = {
        part: (parent: Object3D, geometry: BufferGeometry, material: Material, x?: number, y?: number, z?: number, shadow?: boolean) => this.part(parent, geometry, material, x, y, z, shadow),
        surface: (color: ColorRepresentation, params?: MeshStandardMaterialParameters) => this.surface(color, params),
        glowing: (material: MeshStandardMaterial, base: number) => {
          material.userData.baseGlow = base
          this.glows.push(material)
        },
      }
      const rig = {
        root: this.root,
        hips: this.hips,
        torso: this.torso,
        head: this.head,
        legs: [{ side: -1, ...this.legL }, { side: 1, ...this.legR }],
        arms: [{ side: -1, ...this.armL }, { side: 1, ...this.armR }],
      }
      const detail = builder(kit, rig, look, b)
      this.animateDetail = detail.animate
      if (detail.robed) this.robed = true
      if (detail.carried) this.carried = detail.carried
      held = {
        main: detail.main,
        mainHold: detail.mainHold ?? 'free',
        tip: detail.tip,
        ...(detail.off ? { off: detail.off, offHold: detail.offHold ?? 'free' } : {}),
        ...(detail.strike ? { strike: detail.strike } : {}),
        ...(detail.offStrike ? { offStrike: detail.offStrike } : {}),
        ...(detail.strikeShape ? { strikeShape: detail.strikeShape } : {}),
      }
    } else {
      held = this.buildWeapon(look, m)
    }
    this.mainHand = held.main
    this.mainHold = held.mainHold
    this.offHold = held.offHold ?? 'free'
    if (held.off) this.offHand = held.off
    this.tip = held.tip
    if (look.shield) this.buildShield(m)
    // A glow gathering at the tip as a spell or a blow winds up.
    this.flareGlow = this.glow(look.accent, 0)
    this.flare = this.part(this.tip, new SphereGeometry(0.16, 12, 8), this.flareGlow, 0, 0, 0, false)
    // The glow of an empowered blow: round what it strikes with, in both hands for one that strikes with both.
    const strikers = [held.strike ?? this.tip, ...(held.offStrike ? [held.offStrike] : [])]
    for (const striker of strikers) {
      const material = this.glow(look.accent, 0)
      const mesh = this.part(striker, new SphereGeometry(0.2, 12, 8), material, 0, 0, 0, false)
      mesh.scale.set(held.strikeShape?.x ?? 1, held.strikeShape?.y ?? 1, held.strikeShape?.z ?? 1)
      mesh.visible = false
      this.empowerGlows.push({ mesh, material })
    }
  }

  // Shows the next blow empowered (0 not at all, 1 fully), in this colour: what it strikes with glows, and its blade or stone burns
  // brighter.
  setEmpower(level: number, css: string): void {
    this.empower = level
    if (level > 0) for (const { material } of this.empowerGlows) material.color.set(css)
  }

  // Where what it strikes with is: the blade, the fists, the claws.
  strikePoints(): Vector3[] {
    return this.empowerGlows.map(({ mesh }) => mesh.localToWorld(new Vector3()))
  }

  // Where what it does is seen to come from: the stone of its staff, the muzzle of its gun, its bow, its blade, its fist.
  focus(): Vector3 {
    return this.tip.localToWorld(new Vector3())
  }

  // Where a hand is in the world.
  handPoint(side: 'left' | 'right'): Vector3 {
    return (side === 'left' ? this.armL : this.armR).hand.localToWorld(new Vector3())
  }

  pose(input: PoseInput): void {
    const { t, dt } = input
    this.walkWeight = approach(this.walkWeight, input.moving && !input.dead ? 1 : 0, 10, dt)
    const acting = input.action !== undefined || input.release !== undefined
    this.actionWeight = approach(this.actionWeight, acting ? 1 : 0, acting ? 22 : 8, dt)
    const kind = input.action?.kind ?? input.release?.kind
    if (kind) this.lastStyle = kind === 'attack' ? this.look.attack : this.look.cast
    const stride = 1.15 * this.scale
    this.phase += dt * Math.max(input.speed, 60) / stride * Math.PI * this.walkWeight

    const breathe = Math.sin(t * 2.1)
    const pose = this.stance()
    pose.pitch += 0.02 * breathe
    pose.head -= 0.02 * breathe
    pose.shoulderL.z -= 0.03 * breathe
    pose.shoulderR.z += 0.03 * breathe

    // Walking: the legs swing and the knees bend, the body bobs and leans in, the free arms swing against the legs.
    const w = this.walkWeight
    let bob = 0
    if (w > 0.001) {
      const s = Math.sin(this.phase)
      const c = Math.cos(this.phase)
      // Under a robe the stride is short and the knees bend little, so the legs stay inside it.
      const reach = this.robed ? 0.28 : 0.62
      const bend = this.robed ? 0.45 : 1
      pose.hipL = lerp(pose.hipL, -s * reach, w)
      pose.hipR = lerp(pose.hipR, s * reach, w)
      pose.kneeL = lerp(pose.kneeL, (Math.max(0, c) + 0.1) * bend, w)
      pose.kneeR = lerp(pose.kneeR, (Math.max(0, -c) + 0.1) * bend, w)
      bob = Math.abs(c) * 0.045 * w
      pose.pitch += 0.1 * w
      pose.yaw += s * 0.08 * w
      const free = this.look.weapon === 'fists' || this.look.weapon === 'branches' ? 0.5 : 0.25
      if (!this.carried) {
        pose.shoulderL.x += s * (this.offHand ? 0.2 : 0.55) * w
        pose.shoulderR.x -= s * free * w
      }
    }

    // An attack or a spell: wound up as it gathers, let go as it goes off, and back to rest.
    const a = this.actionWeight
    if (a > 0.001) {
      const windup = input.action ? ease(input.action.progress) : 1
      const through = input.release ? input.release.t : 0
      const swing = easeOut(Math.min(1, through * 2.6))
      const settle = ease((through - 0.45) / 0.55)
      const k = a * (1 - settle)
      blendPose(pose, styledPose(this.lastStyle, pose, windup, swing), k)
      // Standing fast for it: the legs set apart.
      const brace = k * (1 - w)
      pose.hipL = lerp(pose.hipL, -0.25, brace)
      pose.hipR = lerp(pose.hipR, 0.18, brace)
      pose.kneeL = lerp(pose.kneeL, 0.2, brace)
      pose.kneeR = lerp(pose.kneeR, 0.3, brace)
    }

    // What glows flares as anything gathers and goes off.
    const gathering = input.action ? input.action.progress : 0
    const burst = input.release ? 1 - input.release.t : 0
    this.flareGlow.opacity = kind === 'cast' ? Math.max(gathering * 0.75, burst * 0.6) : burst * 0.35
    this.flare.scale.setScalar(0.6 + gathering * 0.8 + burst * 0.6)
    for (const material of this.glows) {
      material.emissiveIntensity = (material.userData.baseGlow as number) * (1 + Math.sin(t * 3) * 0.12) + gathering * 1.4 + burst * 2.2 + this.empower * 2.5
    }
    for (const { mesh, material } of this.empowerGlows) {
      material.opacity = this.empower * (0.4 + Math.sin(t * 9) * 0.12)
      mesh.visible = this.empower > 0
    }

    if (input.stunned && !input.dead) {
      pose.head += Math.sin(t * 7) * 0.12
      pose.yaw += Math.sin(t * 5) * 0.08
    }

    this.legL.hip.rotation.x = pose.hipL
    this.legR.hip.rotation.x = pose.hipR
    this.legL.knee.rotation.x = pose.kneeL
    this.legR.knee.rotation.x = pose.kneeR
    this.armL.shoulder.rotation.set(pose.shoulderL.x, 0, pose.shoulderL.z)
    this.armR.shoulder.rotation.set(pose.shoulderR.x, 0, pose.shoulderR.z)
    this.armL.elbow.rotation.x = pose.elbowL
    this.armR.elbow.rotation.x = pose.elbowR
    this.torso.rotation.set(pose.pitch, pose.yaw, 0)
    this.head.rotation.x = pose.head
    this.body.position.y = bob
    holdAngle(this.mainHand, this.mainHold, pose.shoulderR.x + pose.elbowR)
    if (this.carried) {
      // Gripped in the right hand, pointing through the left.
      this.root.updateMatrixWorld(true)
      const grip = this.root.worldToLocal(this.armR.hand.getWorldPosition(new Vector3()))
      const hold = this.root.worldToLocal(this.armL.hand.getWorldPosition(new Vector3()))
      this.carried.position.copy(grip)
      const along = hold.sub(grip)
      if (along.lengthSq() > 1e-6) this.carried.quaternion.setFromUnitVectors(UP, along.normalize())
    }
    if (this.offHand) holdAngle(this.offHand, this.offHold, pose.shoulderL.x + pose.elbowL)
    for (const { part, amount } of this.swayers) part.rotation.x = amount * (0.15 + 0.35 * w) + Math.sin(t * 2.5 + amount) * 0.04
    if (this.skirt) this.skirt.rotation.set(Math.cos(this.phase * 2) * 0.03 * w + 0.04 * w, 0, Math.sin(this.phase) * 0.05 * w)
    if (this.animateDetail) {
      try {
        this.animateDetail({ t, dt, walk: w, phase: this.phase, hipL: pose.hipL, hipR: pose.hipR, dead: input.dead, gathering, burst })
      } catch (error) {
        reportOnce(`The moving parts of ${this.championId}`, error)
        this.animateDetail = undefined
      }
    }

    // Dead: it falls back and lies there.
    if (input.dead) {
      const fall = easeOut(input.deadFor / 0.7)
      this.fall.rotation.x = -Math.PI / 2 * fall
      this.fall.position.y = 0.12 * fall
      this.fall.position.z = -0.25 * fall
    } else {
      this.fall.rotation.x = 0
      this.fall.position.set(0, 0, 0)
    }
  }

  override release(kind: 'attack' | 'cast', fx: FxContext): void {
    const style = kind === 'attack' ? this.look.attack : this.look.cast
    const at = this.focus()
    if (style === 'gun') {
      // A muzzle flash, and a puff of smoke.
      const ahead = this.tip.localToWorld(new Vector3(0, 1, 0)).sub(at).normalize()
      for (let index = 0; index < 14; index += 1) {
        const speed = 80 + Math.random() * 140
        fx.glow.emit({ x: at.x, y: at.y, z: at.z, vx: ahead.x * speed + (Math.random() - 0.5) * 40, vy: ahead.y * speed + (Math.random() - 0.5) * 40, vz: ahead.z * speed + (Math.random() - 0.5) * 40, life: 0.12, size: 12, sizeEnd: 2, color: colour('#fff1b0'), colorEnd: colour('#ff8a2a'), alpha: 1 })
      }
      fx.puff.emit({ x: at.x, y: at.y, z: at.z, vy: 20, life: 0.6, size: 10, sizeEnd: 26, color: colour('#bdb7ad'), alpha: 0.4 })
      return
    }
    const tint = colour(this.accent)
    const count = style === 'unarmed' || style === 'heavy' ? 16 : 10
    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const speed = 30 + Math.random() * 70
      fx.glow.emit({ x: at.x, y: at.y, z: at.z, vx: Math.cos(angle) * speed, vy: (Math.random() - 0.3) * 50, vz: Math.sin(angle) * speed, life: 0.25 + Math.random() * 0.2, size: 7, sizeEnd: 1, color: tint, alpha: 0.9, drag: 3 })
    }
  }

  // ------------------------------------------------------------------------------------------------ poses

  // How it stands with what it holds.
  private stance(): Pose {
    const pose: Pose = {
      shoulderL: { x: 0.05, z: -0.14 },
      shoulderR: { x: -0.3, z: 0.12 },
      elbowL: -0.25,
      elbowR: -0.6,
      hipL: 0,
      hipR: 0,
      kneeL: 0.04,
      kneeR: 0.04,
      pitch: 0,
      yaw: 0,
      head: 0,
    }
    switch (this.look.weapon) {
      case 'warhammer':
        Object.assign(pose, { shoulderR: { x: -0.55, z: 0.15 }, elbowR: -1.15, shoulderL: { x: -0.65, z: -0.05 }, elbowL: -1.2 })
        break
      case 'daggers':
        Object.assign(pose, { shoulderR: { x: -0.35, z: 0.2 }, elbowR: -0.8, shoulderL: { x: -0.35, z: -0.2 }, elbowL: -0.8, pitch: 0.08 })
        break
      case 'bow':
        Object.assign(pose, { shoulderL: { x: -0.35, z: -0.2 }, elbowL: -0.35, shoulderR: { x: 0.05, z: 0.15 }, elbowR: -0.3 })
        break
      case 'rifle':
      case 'launcher':
        // Holding it across the chest: the right hand low at the hip on the grip, the left high in front of the left shoulder on the
        // barrel, so it lies slanting up across the body.
        Object.assign(pose, { shoulderR: { x: 0.3, z: -0.4 }, elbowR: -1.5, shoulderL: { x: -0.25, z: 0.75 }, elbowL: -1.85 })
        break
      case 'claws':
        Object.assign(pose, { shoulderR: { x: -0.35, z: 0.3 }, elbowR: -0.9, shoulderL: { x: -0.35, z: -0.3 }, elbowL: -0.9, pitch: 0.12 })
        break
      case 'fists':
      case 'branches':
        Object.assign(pose, { shoulderR: { x: -0.45, z: 0.2 }, elbowR: -1.7, shoulderL: { x: -0.55, z: -0.2 }, elbowL: -1.8 })
        break
      case 'skullStaff':
      case 'waterStaff':
      case 'fireStaff':
      case 'leafStaff':
        Object.assign(pose, { shoulderR: { x: -0.32, z: 0.12 }, elbowR: -0.75 })
        break
      case 'sickleChain':
        Object.assign(pose, { shoulderL: { x: -0.4, z: -0.25 }, elbowL: -0.9 })
        break
      default:
        if (this.look.shield) Object.assign(pose, { shoulderL: { x: -0.35, z: -0.14 }, elbowL: -1.1 })
    }
    return { ...pose, shoulderL: { ...pose.shoulderL }, shoulderR: { ...pose.shoulderR } }
  }

  // ------------------------------------------------------------------------------------------------ building

  private materials(look: Look) {
    const steel = this.surface(look.armor === 'heavyplate' ? '#7d8590' : '#aeb7c2', { roughness: 0.32, metalness: 0.75 })
    const cloth = this.surface(look.cloth, { roughness: 0.75 })
    const trim = this.surface(look.trim, { roughness: 0.6 })
    const leather = this.surface('#6b4a2e', { roughness: 0.85 })
    const dark = this.surface('#2a2420', { roughness: 0.9 })
    const skin = this.surface(look.skin, { roughness: look.armor === 'bark' ? 0.95 : 0.6, flatShading: look.armor === 'bark' })
    // What used to be in the team's colour (a cape, a sash, a plume) is in the champion's trim.
    const teamColour = this.surface(look.trim, { roughness: 0.55 })
    const accent = this.surface(look.accent, { roughness: 0.35, emissive: colour(look.accent), emissiveIntensity: 0.6 })
    accent.userData.baseGlow = 0.6
    this.glows.push(accent)
    const moss = this.surface('#4f7d34', { roughness: 0.9, flatShading: true })
    const armored = look.armor === 'plate' || look.armor === 'heavyplate'
    const pants = look.armor === 'bark' ? skin : armored ? steel : look.armor === 'fatigues' || look.armor === 'berserker' ? cloth : dark
    const bare = look.armor === 'berserker'
    return {
      steel,
      cloth,
      trim,
      leather,
      dark,
      skin,
      team: teamColour,
      accent,
      moss,
      pants,
      legs: pants,
      boots: armored ? steel : look.armor === 'gi' ? trim : leather,
      upperArm: armored ? steel : look.armor === 'bark' || bare ? skin : cloth,
      forearm: armored || bare ? leather : look.covered ? cloth : look.armor === 'bark' || look.armor === 'gi' ? skin : look.armor === 'leather' ? leather : cloth,
    }
  }

  private buildTorso(look: Look, m: Materials, b: number): void {
    const t = this.torso
    switch (look.armor) {
      case 'plate':
      case 'heavyplate':
        this.part(t, new CylinderGeometry(0.22 * b, 0.17 * b, 0.5, 10), m.steel, 0, 0.27, 0)
        this.part(t, new BoxGeometry(0.2 * b, 0.42, 0.04), m.cloth, 0, 0.2, 0.17 * b)
        this.part(t, new BoxGeometry(0.06 * b, 0.42, 0.045), m.team, 0, 0.2, 0.175 * b)
        this.part(t, new CylinderGeometry(0.18 * b, 0.18 * b, 0.06, 10), m.leather, 0, 0.02, 0)
        if (look.armor === 'heavyplate') this.part(t, new BoxGeometry(0.3 * b, 0.12, 0.3 * b), m.trim, 0, 0.42, 0)
        break
      case 'leather':
        this.part(t, new CylinderGeometry(0.2 * b, 0.16 * b, 0.5, 10), m.cloth, 0, 0.27, 0)
        this.part(t, new BoxGeometry(0.05, 0.6, 0.04), m.leather, 0, 0.28, 0.17 * b).rotation.z = 0.6
        this.part(t, new CylinderGeometry(0.17 * b, 0.17 * b, 0.06, 10), m.team, 0, 0.03, 0)
        break
      case 'fatigues':
        this.part(t, new CylinderGeometry(0.2 * b, 0.17 * b, 0.5, 10), m.cloth, 0, 0.27, 0)
        this.part(t, new BoxGeometry(0.36 * b, 0.32, 0.3 * b), m.trim, 0, 0.3, 0)
        for (const side of [-1, 1]) this.part(t, new BoxGeometry(0.08, 0.08, 0.05), m.leather, side * 0.08, 0.22, 0.16 * b)
        this.part(t, new CylinderGeometry(0.18 * b, 0.18 * b, 0.06, 10), m.team, 0, 0.03, 0)
        break
      case 'robe':
        this.part(t, new CylinderGeometry(0.19 * b, 0.16 * b, 0.5, 10), m.cloth, 0, 0.27, 0)
        this.part(t, new TorusGeometry(0.175 * b, 0.035, 6, 14), m.team, 0, 0.04, 0).rotation.x = Math.PI / 2
        this.part(t, new BoxGeometry(0.06, 0.45, 0.02), m.trim, 0, 0.24, 0.18 * b)
        // The robe from the waist to the ankles, wider at the hem.
        this.hangSkirt(m.cloth, b, 0.34, 0.84)
        this.robed = true
        this.part(this.hips, new TorusGeometry(0.34 * b, 0.018, 6, 20), m.trim, 0, -0.8, 0).rotation.x = Math.PI / 2
        break
      case 'gi':
        this.part(t, new CylinderGeometry(0.2 * b, 0.16 * b, 0.5, 10), m.cloth, 0, 0.27, 0)
        for (const side of [-1, 1]) this.part(t, new BoxGeometry(0.04, 0.3, 0.02), m.trim, side * 0.05, 0.33, 0.18 * b).rotation.z = side * 0.45
        if (look.covered) {
          // Only a thin cord of the team's colour.
          this.part(t, new TorusGeometry(0.168 * b, 0.014, 6, 14), m.team, 0, 0.04, 0).rotation.x = Math.PI / 2
        } else {
          this.part(t, new TorusGeometry(0.17 * b, 0.04, 6, 14), m.team, 0, 0.04, 0).rotation.x = Math.PI / 2
          this.part(t, new BoxGeometry(0.05, 0.22, 0.03), m.team, 0.09, -0.08, 0.15 * b)
        }
        break
      case 'berserker': {
        // Bare and broad, painted for war: a slab of a chest, stripes of red across it, a wide belt and a kilt of fur.
        this.part(t, new CylinderGeometry(0.23 * b, 0.17 * b, 0.5, 12), m.skin, 0, 0.27, 0)
        for (const side of [-1, 1]) this.part(t, new SphereGeometry(0.13 * b, 10, 8), m.skin, side * 0.08 * b, 0.36, 0.1 * b).scale.set(1, 0.7, 0.6)
        for (const [y, tilt] of [[0.4, 0.35], [0.28, -0.3]]) this.part(t, new BoxGeometry(0.36 * b, 0.035, 0.02), m.accent, 0, y, 0.215 * b).rotation.z = tilt
        this.part(t, new CylinderGeometry(0.19 * b, 0.19 * b, 0.09, 12), m.leather, 0, 0.02, 0)
        this.part(t, new BoxGeometry(0.1, 0.07, 0.03), this.surface('#c9b27a', { metalness: 0.7, roughness: 0.4 }), 0, 0.02, 0.19 * b)
        this.part(t, new TorusGeometry(0.19 * b, 0.02, 6, 16), m.team, 0, 0.07, 0).rotation.x = Math.PI / 2
        const fur = this.surface('#6b4a30', { roughness: 1, flatShading: true, side: DoubleSide })
        this.part(this.hips, jitter(new CylinderGeometry(0.19 * b, 0.27 * b, 0.36, 12, 2, true), 0.08, 31), fur, 0, -0.2, 0)
        break
      }
      case 'vampire':
        // A long coat, close and dark, open at the front on a vest of blood red, with the coat's tails to the knee.
        this.part(t, new CylinderGeometry(0.19 * b, 0.16 * b, 0.5, 12), m.cloth, 0, 0.27, 0)
        this.part(t, new BoxGeometry(0.13 * b, 0.4, 0.04), m.trim, 0, 0.24, 0.165 * b)
        for (let index = 0; index < 3; index += 1) this.part(t, new SphereGeometry(0.014, 6, 4), this.surface('#c9b27a', { metalness: 0.8, roughness: 0.3 }), 0, 0.12 + index * 0.1, 0.19 * b)
        this.part(t, new CylinderGeometry(0.17 * b, 0.17 * b, 0.05, 12), m.dark, 0, 0.03, 0)
        this.hangSkirt(m.cloth, b, 0.27, 0.55, 0, 0.17)
        break
      case 'cloak':
        this.part(t, new CylinderGeometry(0.18 * b, 0.15 * b, 0.5, 10), m.dark, 0, 0.27, 0)
        // The cloak hangs from the shoulders to the knees, wider at the bottom.
        this.hangSkirt(m.cloth, b, 0.38, 0.95, 0.55, 0.22)
        this.robed = true
        this.part(t, new TorusGeometry(0.16 * b, 0.03, 6, 14), m.team, 0, 0.5, 0).rotation.x = Math.PI / 2
        break
      case 'bark': {
        const chest = this.part(t, jitter(new DodecahedronGeometry(0.26 * b, 1), 0.12, 3), m.skin, 0, 0.3, 0)
        chest.scale.set(1, 1.15, 0.85)
        this.part(t, jitter(new DodecahedronGeometry(0.18 * b, 0), 0.15, 4), m.skin, 0, 0.02, 0)
        for (const [x, y, z, size] of [[0.12, 0.45, 0.12, 0.09], [-0.15, 0.2, 0.14, 0.07], [0.05, 0.1, -0.18, 0.08]]) {
          this.part(t, new IcosahedronGeometry(size * b, 0), m.moss, x * b, y, z * b)
        }
        this.part(t, new TorusGeometry(0.2 * b, 0.025, 6, 14), m.team, 0, 0.05, 0).rotation.x = Math.PI / 2
        break
      }
    }
  }

  // A robe, a coat's tails or a cloak hanging down from the waist (or from `top` above it, on the body): as wide as the body where
  // it starts (`neck`), and `radius` wide at the hem.
  private hangSkirt(material: Material, b: number, radius: number, length: number, top = 0, neck = 0.17): void {
    const anchor = top > 0 ? this.torso : this.hips
    const skirt = this.part(anchor, new CylinderGeometry(neck * b, radius * b, length, 14, 2, true), material, 0, top > 0 ? top - length / 2 : 0.04 - length / 2, 0)
    ;(skirt.material as MeshStandardMaterial).side = DoubleSide
    this.skirt = skirt
  }

  private buildShoulders(look: Look, m: Materials, b: number): void {
    for (const [side, arm] of [[-1, this.armL], [1, this.armR]] as const) {
      if (look.armor === 'plate') {
        this.part(arm.shoulder, new SphereGeometry(0.11 * b, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), m.steel, side * 0.02, 0.02, 0)
      } else if (look.armor === 'heavyplate') {
        this.part(arm.shoulder, new SphereGeometry(0.16 * b, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), m.steel, side * 0.03, 0.03, 0)
        this.part(arm.shoulder, new ConeGeometry(0.04, 0.16, 6), m.trim, side * 0.08, 0.14, 0).rotation.z = -side * 0.5
      } else if (look.armor === 'bark') {
        this.part(arm.shoulder, new IcosahedronGeometry(0.11 * b, 0), m.moss, side * 0.02, 0.06, 0)
      } else if (look.armor === 'berserker') {
        // Leather bracers.
        this.part(arm.elbow, new CylinderGeometry(0.075 * b, 0.065 * b, 0.16, 8), m.leather, 0, -0.18, 0)
      } else if (look.armor === 'fatigues' || look.armor === 'leather') {
        this.part(arm.shoulder, new SphereGeometry(0.075 * b, 8, 6), m.trim, side * 0.01, 0, 0)
      }
    }
  }

  private buildHead(look: Look, m: Materials): void {
    const h = this.head
    const face = look.armor === 'bark' ? jitter(new DodecahedronGeometry(0.14, 1), 0.12, 9) : new SphereGeometry(0.13, 14, 10)
    this.part(h, face, m.skin, 0, 0.12, 0.01)
    // Eyes: dark, or glowing out of the shadow of a hood.
    if (look.covered) {
      // Covered: only a slit for the eyes, and the eyes in it.
      this.part(h, new BoxGeometry(0.12, 0.03, 0.02), this.surface('#3a3a48', { roughness: 0.6 }), 0, 0.14, 0.125)
      for (const side of [-1, 1]) this.part(h, new SphereGeometry(0.012, 6, 4), this.surface('#d8d8e8', { roughness: 0.3 }), side * 0.035, 0.14, 0.135, false)
    } else if (look.eyes) {
      const glowing = this.surface(look.eyes, { emissive: colour(look.eyes), emissiveIntensity: 2.2 })
      glowing.userData.baseGlow = 2.2
      this.glows.push(glowing)
      for (const side of [-1, 1]) this.part(h, new SphereGeometry(0.022, 6, 4), glowing, side * 0.045, 0.14, 0.125, false)
    } else {
      this.part(h, new BoxGeometry(0.1, 0.025, 0.02), m.dark, 0, 0.13, 0.13)
    }
    switch (look.head) {
      case 'knightHelm':
        this.part(h, new SphereGeometry(0.15, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), m.steel, 0, 0.13, 0)
        this.part(h, new BoxGeometry(0.035, 0.12, 0.26), m.team, 0, 0.29, -0.02)
        this.part(h, new ConeGeometry(0.035, 0.18, 6), m.team, 0, 0.33, -0.12).rotation.x = -1.1
        break
      case 'hornedHelm': {
        this.part(h, new SphereGeometry(0.16, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), m.steel, 0, 0.12, 0)
        this.part(h, new BoxGeometry(0.03, 0.12, 0.05), m.steel, 0, 0.1, 0.14)
        const bone = this.surface('#e9e1cf', { roughness: 0.5 })
        for (const side of [-1, 1]) this.part(h, new ConeGeometry(0.04, 0.24, 8), bone, side * 0.17, 0.25, 0).rotation.z = -side * 0.9
        this.part(h, new TorusGeometry(0.155, 0.02, 6, 16), m.team, 0, 0.13, 0).rotation.x = Math.PI / 2
        break
      }
      case 'hood':
        this.part(h, new SphereGeometry(0.165, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), m.cloth, 0, 0.12, -0.02)
        break
      case 'cowl':
        // A deep hood that hides the face, pointed at the back.
        this.part(h, new SphereGeometry(0.18, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.7), m.cloth, 0, 0.12, -0.03)
        this.part(h, new ConeGeometry(0.09, 0.2, 8), m.cloth, 0, 0.22, -0.13).rotation.x = -1.2
        this.part(h, new SphereGeometry(0.12, 10, 8), m.dark, 0, 0.11, 0.05, false).scale.set(1, 1, 0.6)
        break
      case 'wizardHat': {
        const hat = joint(h, 0, 0.2, -0.01)
        this.part(hat, new CylinderGeometry(0.24, 0.24, 0.025, 16), m.cloth, 0, 0, 0)
        this.part(hat, new ConeGeometry(0.14, 0.42, 12), m.cloth, 0, 0.2, -0.04).rotation.x = -0.25
        this.part(hat, new TorusGeometry(0.14, 0.025, 6, 14), m.accent, 0, 0.03, 0).rotation.x = Math.PI / 2
        break
      }
      case 'goatHorns': {
        this.part(h, new SphereGeometry(0.165, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), m.cloth, 0, 0.12, -0.02)
        const horn = this.surface('#e9e1cf', { roughness: 0.5 })
        for (const side of [-1, 1]) {
          const curl = this.part(h, new TorusGeometry(0.075, 0.025, 6, 12, Math.PI * 1.4), horn, side * 0.12, 0.25, -0.02)
          curl.rotation.set(0, side * Math.PI / 2, side > 0 ? 0.6 : 2.5)
        }
        break
      }
      case 'featherCap':
        this.part(h, new SphereGeometry(0.15, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), m.cloth, 0, 0.14, 0)
        this.part(h, new CylinderGeometry(0.2, 0.2, 0.015, 14, 1, false, 0, Math.PI), m.cloth, 0, 0.16, 0.01).rotation.y = -Math.PI / 2
        this.part(h, new ConeGeometry(0.03, 0.3, 5), m.team, 0.1, 0.3, -0.05).rotation.set(-0.6, 0, -0.4)
        break
      case 'combatHelmet':
        this.part(h, new SphereGeometry(0.155, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), m.trim, 0, 0.13, 0)
        this.part(h, new TorusGeometry(0.15, 0.015, 6, 18), m.team, 0, 0.15, 0).rotation.x = Math.PI / 2
        this.part(h, new BoxGeometry(0.12, 0.04, 0.05), m.dark, 0, 0.26, 0.08)
        break
      case 'goggles': {
        this.part(h, new SphereGeometry(0.14, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.45), m.leather, 0, 0.13, 0)
        this.part(h, new TorusGeometry(0.135, 0.018, 6, 18), m.team, 0, 0.15, 0).rotation.x = Math.PI / 2 - 0.15
        const lens = this.surface('#9fe0ff', { roughness: 0.05, metalness: 0.6, emissive: colour('#3a8fbf'), emissiveIntensity: 0.4 })
        for (const side of [-1, 1]) {
          this.part(h, new CylinderGeometry(0.04, 0.04, 0.04, 12), m.steel, side * 0.05, 0.16, 0.12).rotation.x = Math.PI / 2
          this.part(h, new CylinderGeometry(0.03, 0.03, 0.045, 12), lens, side * 0.05, 0.16, 0.125).rotation.x = Math.PI / 2
        }
        break
      }
      case 'jesterHat': {
        this.part(h, new SphereGeometry(0.15, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), m.cloth, 0, 0.14, 0)
        const bell = this.surface('#f2c14e', { metalness: 0.7, roughness: 0.3 })
        for (const [side, material] of [[-1, m.cloth], [1, m.trim]] as const) {
          this.part(h, new ConeGeometry(0.06, 0.3, 8), material, side * 0.16, 0.26, 0).rotation.z = -side * 1.1
          this.part(h, new SphereGeometry(0.035, 8, 6), bell, side * 0.3, 0.33, 0)
        }
        break
      }
      case 'ninjaMask':
        this.part(h, new SphereGeometry(0.14, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.45), m.cloth, 0, 0.12, 0)
        this.part(h, new SphereGeometry(0.135, 14, 10, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), m.cloth, 0, 0.12, 0.005)
        this.part(h, new TorusGeometry(0.14, 0.018, 6, 18), m.trim, 0, 0.18, 0).rotation.x = Math.PI / 2
        for (const side of [-1, 1]) {
          const tail = joint(h, side * 0.03, 0.18, -0.14)
          this.part(tail, new BoxGeometry(0.035, 0.22, 0.01), m.trim, 0, -0.11, 0)
          tail.rotation.set(0.6, 0, side * 0.3)
          this.swayers.push({ part: tail, amount: 1.4 })
        }
        break
      case 'chainMask':
        this.part(h, new SphereGeometry(0.14, 14, 10, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5), m.steel, 0, 0.12, 0.01)
        this.part(h, new SphereGeometry(0.15, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.45), m.cloth, 0, 0.13, 0)
        break
      case 'leafCrown': {
        const twig = this.surface('#8a6a3a', { roughness: 0.8 })
        this.part(h, new SphereGeometry(0.15, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.4), twig, 0, 0.14, -0.02)
        this.part(h, new TorusGeometry(0.14, 0.02, 6, 18), twig, 0, 0.2, 0).rotation.x = Math.PI / 2
        const leaf = this.surface('#5fbf5a', { roughness: 0.6, flatShading: true })
        for (let index = 0; index < 8; index += 1) {
          const turn = index * Math.PI / 4
          this.part(h, new ConeGeometry(0.03, 0.12, 4), leaf, Math.sin(turn) * 0.14, 0.24, Math.cos(turn) * 0.14).rotation.set(Math.cos(turn) * 0.4, 0, -Math.sin(turn) * 0.4)
        }
        break
      }
      case 'topknot':
        this.part(h, new SphereGeometry(0.05, 8, 6), m.dark, 0, 0.27, -0.03)
        this.part(h, new TorusGeometry(0.03, 0.012, 6, 10), m.team, 0, 0.27, -0.03)
        break
      case 'bloodCrown':
        this.part(h, new SphereGeometry(0.15, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), m.trim, 0, 0.13, 0)
        for (let index = 0; index < 5; index += 1) {
          const turn = (index - 2) * 0.45
          this.part(h, new ConeGeometry(0.025, 0.14, 5), m.accent, Math.sin(turn) * 0.14, 0.29, Math.cos(turn) * 0.1).rotation.set(Math.cos(turn) * 0.2, 0, -Math.sin(turn) * 0.3)
        }
        break
      case 'wildHair': {
        // A wild mane swept back, a great beard, and a stripe of war paint across the eyes.
        const hair = this.surface('#5a3418', { roughness: 0.95, flatShading: true })
        this.part(h, new SphereGeometry(0.145, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), hair, 0, 0.14, -0.02)
        for (let index = 0; index < 7; index += 1) {
          const turn = (index - 3) * 0.35
          this.part(h, new ConeGeometry(0.045, 0.22, 5), hair, Math.sin(turn) * 0.11, 0.2, -0.1 + Math.abs(turn) * 0.04).rotation.set(-1.9, 0, -turn * 0.6)
        }
        this.part(h, new ConeGeometry(0.1, 0.24, 7), hair, 0, -0.01, 0.07).rotation.x = Math.PI + 0.35
        this.part(h, new BoxGeometry(0.2, 0.035, 0.02), m.accent, 0, 0.14, 0.12)
        break
      }
      case 'vampire': {
        // Slick black hair to a point on the brow, and a high collar standing up behind the head, red within.
        const hair = this.surface('#0e0b0e', { roughness: 0.35, metalness: 0.2 })
        this.part(h, new SphereGeometry(0.138, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), hair, 0, 0.13, -0.01)
        this.part(h, new ConeGeometry(0.03, 0.08, 4), hair, 0, 0.2, 0.11).rotation.x = Math.PI - 0.5
        const collarOut = this.surface(look.cloth, { roughness: 0.6, side: DoubleSide })
        const collarIn = this.surface(look.trim, { roughness: 0.5, side: DoubleSide })
        this.part(h, new CylinderGeometry(0.24, 0.15, 0.3, 16, 1, true, Math.PI * 0.55, Math.PI * 0.9), collarOut, 0, 0.08, -0.02)
        this.part(h, new CylinderGeometry(0.23, 0.14, 0.29, 16, 1, true, Math.PI * 0.55, Math.PI * 0.9), collarIn, 0, 0.08, -0.02)
        break
      }
      case 'antlers': {
        const wood = this.surface('#5c3f27', { roughness: 0.95, flatShading: true })
        for (const side of [-1, 1]) {
          const beam = joint(h, side * 0.08, 0.22, -0.02)
          beam.rotation.z = -side * 0.5
          this.part(beam, new CylinderGeometry(0.018, 0.03, 0.3, 5), wood, 0, 0.15, 0)
          for (const [y, turn] of [[0.12, 1], [0.22, -1]]) {
            const tine = this.part(beam, new CylinderGeometry(0.012, 0.02, 0.14, 4), wood, turn * side * 0.04, y, 0)
            tine.rotation.z = turn * side * 0.8
          }
        }
        const leaves = this.surface('#6fbf4a', { roughness: 0.7, flatShading: true })
        for (const [x, y, z, size] of [[0, 0.24, -0.04, 0.1], [0.09, 0.2, 0.02, 0.07], [-0.1, 0.21, 0, 0.07]]) {
          this.part(h, new IcosahedronGeometry(size, 0), leaves, x, y, z)
        }
        break
      }
    }
  }

  private buildBack(look: Look, m: Materials, b: number): void {
    const t = this.torso
    switch (look.back) {
      case 'cape':
      case 'longCape': {
        const cape = joint(t, 0, 0.5, -0.16 * b)
        const length = look.back === 'longCape' ? 0.95 : 0.62
        this.part(cape, new BoxGeometry(0.38 * b, length, 0.025), m.team, 0, -length / 2, 0)
        this.swayers.push({ part: cape, amount: 0.9 })
        break
      }
      case 'tatters':
        for (let index = 0; index < 5; index += 1) {
          const strip = joint(t, (index - 2) * 0.07 * b, 0.48, -0.16 * b)
          this.part(strip, new BoxGeometry(0.06, 0.5 + (index % 2) * 0.15, 0.015), index % 2 ? m.cloth : m.trim, 0, -0.28, 0)
          this.swayers.push({ part: strip, amount: 0.7 + index * 0.1 })
        }
        break
      case 'quiver': {
        const quiver = joint(t, 0.08, 0.32, -0.19 * b)
        quiver.rotation.z = -0.35
        this.part(quiver, new CylinderGeometry(0.06, 0.05, 0.42, 8), m.leather, 0, 0, 0)
        for (let index = 0; index < 4; index += 1) {
          this.part(quiver, new CylinderGeometry(0.006, 0.006, 0.2, 4), m.dark, (index - 1.5) * 0.02, 0.28, 0)
          this.part(quiver, new BoxGeometry(0.025, 0.06, 0.005), m.team, (index - 1.5) * 0.02, 0.36, 0)
        }
        break
      }
      case 'backpack':
        this.part(t, new BoxGeometry(0.3 * b, 0.34, 0.14), m.trim, 0, 0.3, -0.22 * b)
        this.part(t, new CylinderGeometry(0.05, 0.05, 0.3 * b, 8), m.cloth, 0, 0.48, -0.22 * b).rotation.z = Math.PI / 2
        break
      case 'satchel': {
        this.part(t, new BoxGeometry(0.035, 0.62, 0.035), m.leather, 0, 0.28, 0.17 * b).rotation.z = -0.65
        this.part(t, new BoxGeometry(0.18, 0.14, 0.09), m.leather, -0.2 * b, 0.02, 0.06).rotation.y = 0.3
        // What is in it: grenades for the Grenadier, trinkets for the Trinketmaster.
        for (let index = 0; index < 3; index += 1) {
          this.part(t, new SphereGeometry(0.035, 8, 6), m.accent, (-0.25 + index * 0.05) * b, 0.12, 0.08 + index * 0.01)
        }
        break
      }
      case 'beads':
        for (let index = 0; index < 14; index += 1) {
          const turn = index / 14 * Math.PI * 2
          this.part(t, new SphereGeometry(index === 0 ? 0.035 : 0.022, 6, 4), index === 0 ? m.accent : m.trim, Math.sin(turn) * 0.17 * b, 0.48 - Math.max(0, Math.cos(turn)) * 0.14, Math.cos(turn) * 0.15 * b)
        }
        break
      case 'pelt': {
        // A collar of shaggy fur round the neck and over the tops of the shoulders.
        const fur = this.surface('#6e675e', { roughness: 1, flatShading: true })
        const collar = this.part(t, jitter(new TorusGeometry(0.17 * b, 0.07, 6, 14), 0.18, 51), fur, 0, 0.5, -0.01)
        collar.rotation.x = Math.PI / 2
        collar.scale.set(1.15, 0.9, 1)
        break
      }
      case 'none':
        break
    }
  }

  private buildShield(m: Materials): void {
    const shield = joint(this.armL.elbow, -0.07, -0.16, 0.02)
    this.part(shield, new CylinderGeometry(0.22, 0.22, 0.04, 16), m.team, 0, 0, 0).rotation.z = Math.PI / 2
    this.part(shield, new TorusGeometry(0.22, 0.022, 6, 20), m.steel, 0, 0, 0).rotation.y = Math.PI / 2
    this.part(shield, new SphereGeometry(0.06, 8, 6), m.steel, -0.03, 0, 0)
  }

  // What the champion holds, in which hand, and how it keeps its angle.
  private buildWeapon(look: Look, m: Materials): {
    main: Group
    mainHold: Hold
    off?: Group
    offHold?: Hold
    tip: Object3D
    // What it strikes with, where an empowered blow glows: the blade (and the other one), the fists, the claws; the tip, if not
    // given. `strikeShape` stretches the glow to fit it.
    strike?: Object3D
    offStrike?: Object3D
    strikeShape?: { x: number; y: number; z: number }
  } {
    const main = joint(this.armR.hand)
    const blade = this.surface('#dfe6ee', { roughness: 0.2, metalness: 0.9, emissive: colour(look.accent), emissiveIntensity: 0.05 })
    blade.userData.baseGlow = 0.05
    this.glows.push(blade)
    const wood = this.surface('#7a5634', { roughness: 0.9 })
    const point = (parent: Group, y: number): Object3D => joint(parent, 0, y, 0)
    // A blade held out ahead of the hand: built along +Y, turned to point ahead.
    const forward = (hand: Group): Group => {
      const group = joint(hand)
      group.rotation.x = Math.PI / 2
      return group
    }
    switch (look.weapon) {
      case 'longsword': {
        const sword = forward(main)
        this.part(sword, new CylinderGeometry(0.025, 0.025, 0.18, 6), m.leather, 0, 0, 0)
        this.part(sword, new BoxGeometry(0.26, 0.035, 0.05), m.accent, 0, 0.1, 0)
        this.part(sword, new BoxGeometry(0.075, 0.85, 0.018), blade, 0, 0.53, 0)
        this.part(sword, new ConeGeometry(0.053, 0.1, 4), blade, 0, 1.0, 0).rotation.y = Math.PI / 4
        return { main, mainHold: 'free', tip: point(sword, 0.95), strike: point(sword, 0.55), strikeShape: { x: 0.7, y: 2.6, z: 0.5 } }
      }
      case 'katana': {
        const sword = forward(main)
        this.part(sword, new CylinderGeometry(0.022, 0.022, 0.24, 6), m.trim, 0, 0, 0)
        this.part(sword, new CylinderGeometry(0.06, 0.06, 0.02, 10), m.accent, 0, 0.13, 0)
        this.part(sword, new BoxGeometry(0.04, 0.8, 0.012), blade, 0.01, 0.54, 0).rotation.z = -0.04
        return { main, mainHold: 'free', tip: point(sword, 0.92), strike: point(sword, 0.54), strikeShape: { x: 0.5, y: 2.4, z: 0.4 } }
      }
      case 'cleaver': {
        const sword = forward(main)
        this.part(sword, new CylinderGeometry(0.028, 0.028, 0.22, 6), m.leather, 0, 0, 0)
        this.part(sword, new BoxGeometry(0.2, 0.05, 0.06), m.trim, 0, 0.12, 0)
        this.part(sword, new BoxGeometry(0.16, 0.8, 0.02), blade, 0.04, 0.55, 0).rotation.z = -0.06
        this.part(sword, new BoxGeometry(0.03, 0.8, 0.022), m.accent, 0.12, 0.55, 0).rotation.z = -0.06
        return { main, mainHold: 'free', tip: point(sword, 0.9) }
      }
      case 'warhammer': {
        const hammer = forward(main)
        this.part(hammer, new CylinderGeometry(0.03, 0.03, 1.1, 8), wood, 0, 0.25, 0)
        this.part(hammer, new BoxGeometry(0.36, 0.22, 0.22), m.steel, 0, 0.82, 0)
        this.part(hammer, new BoxGeometry(0.38, 0.06, 0.24), m.accent, 0, 0.82, 0)
        this.part(hammer, new ConeGeometry(0.06, 0.18, 6), m.steel, 0, 1.01, 0)
        return { main, mainHold: 'free', tip: point(hammer, 0.82), strikeShape: { x: 1.4, y: 1, z: 1 } }
      }
      case 'daggers': {
        const off = joint(this.armL.hand)
        for (const hand of [main, off]) {
          const knife = forward(hand)
          this.part(knife, new CylinderGeometry(0.02, 0.02, 0.12, 6), m.trim, 0, 0, 0)
          this.part(knife, new BoxGeometry(0.12, 0.025, 0.03), m.accent, 0, 0.07, 0)
          this.part(knife, new ConeGeometry(0.04, 0.38, 4), blade, 0, 0.27, 0).rotation.y = Math.PI / 4
        }
        return { main, mainHold: 'free', off, offHold: 'free', tip: main, strike: main, offStrike: off }
      }
      case 'sickleChain': {
        const sickle = forward(main)
        this.part(sickle, new CylinderGeometry(0.025, 0.025, 0.3, 6), wood, 0, 0.05, 0)
        this.part(sickle, new TorusGeometry(0.15, 0.018, 4, 12, Math.PI * 1.1), blade, 0.12, 0.22, 0).rotation.z = Math.PI * 0.2
        // A length of chain hanging from the other hand, with a weight on its end.
        const off = joint(this.armL.hand)
        const chain = joint(off)
        for (let index = 0; index < 8; index += 1) {
          const link = this.part(chain, new TorusGeometry(0.03, 0.009, 4, 8), m.steel, 0, -index * 0.05, 0, false)
          link.rotation.y = index % 2 ? Math.PI / 2 : 0
        }
        this.part(chain, new OctahedronGeometry(0.05, 0), m.accent, 0, -0.42, 0)
        this.swayers.push({ part: chain, amount: 0.6 })
        return { main, mainHold: 'free', off, offHold: 'up', tip: point(sickle, 0.3), strike: point(sickle, 0.22) }
      }
      case 'stick': {
        const stick = forward(main)
        this.part(stick, new CylinderGeometry(0.025, 0.03, 1.1, 6), wood, 0, 0.3, 0)
        for (let index = 0; index < 4; index += 1) {
          const charm = this.part(stick, new OctahedronGeometry(0.035, 0), index % 2 ? m.accent : m.team, (index - 1.5) * 0.04, 0.82 - (index % 2) * 0.05, 0.03)
          charm.rotation.y = index
        }
        this.part(stick, new TorusGeometry(0.04, 0.012, 6, 10), m.trim, 0, 0.78, 0)
        return { main, mainHold: 'free', tip: point(stick, 0.85), strike: point(stick, 0.5), strikeShape: { x: 0.6, y: 3, z: 0.6 } }
      }
      case 'skullStaff':
      case 'waterStaff':
      case 'fireStaff':
      case 'leafStaff': {
        const staff = joint(main)
        this.part(staff, new CylinderGeometry(0.022, 0.028, 1.5, 6), look.weapon === 'leafStaff' ? this.surface('#8a6a3a', { roughness: 0.9 }) : wood, 0, 0.35, 0)
        const head = joint(staff, 0, 1.18, 0)
        // The Cursebearer's skull smoulders, dim; the others' stones shine.
        const shine = look.weapon === 'skullStaff' ? 0.55 : 1.4
        const orb = this.surface(look.accent, { roughness: 0.15, emissive: colour(look.accent), emissiveIntensity: shine })
        orb.userData.baseGlow = shine
        this.glows.push(orb)
        if (look.weapon === 'skullStaff') {
          const bone = this.surface('#e9e4d4', { roughness: 0.6 })
          this.part(head, new SphereGeometry(0.075, 10, 8), bone, 0, -0.03, 0)
          for (const side of [-1, 1]) this.part(head, new SphereGeometry(0.018, 6, 4), orb, side * 0.028, -0.02, 0.06, false)
          this.part(head, new BoxGeometry(0.07, 0.03, 0.06), bone, 0, -0.09, 0.01)
          this.part(head, new ConeGeometry(0.05, 0.16, 8), orb, 0, 0.1, 0)
        } else if (look.weapon === 'waterStaff') {
          this.part(head, new TorusGeometry(0.085, 0.018, 6, 12), m.trim, 0, 0, 0)
          this.part(head, new IcosahedronGeometry(0.08, 2), orb, 0, 0.02, 0)
        } else if (look.weapon === 'fireStaff') {
          this.part(head, new TorusGeometry(0.1, 0.018, 6, 12, Math.PI * 1.3), m.trim, 0, 0, 0).rotation.z = -0.65
          this.part(head, new IcosahedronGeometry(0.075, 1), orb, 0, 0.02, 0)
        } else {
          const leaf = this.surface('#5fbf5a', { roughness: 0.6, flatShading: true })
          for (let index = 0; index < 5; index += 1) {
            const turn = index / 5 * Math.PI * 2
            this.part(head, new ConeGeometry(0.035, 0.14, 4), leaf, Math.cos(turn) * 0.06, -0.02, Math.sin(turn) * 0.06).rotation.set(Math.sin(turn) * 0.9, 0, -Math.cos(turn) * 0.9)
          }
          this.part(head, new SphereGeometry(0.055, 10, 8), orb, 0, 0.03, 0)
        }
        this.part(head, new SphereGeometry(0.17, 12, 8), this.glow(look.accent, look.weapon === 'skullStaff' ? 0.1 : 0.3), 0, 0.02, 0, false)
        return { main, mainHold: 'up', tip: head }
      }
      case 'bow': {
        const off = joint(this.armL.hand)
        const bow = joint(off)
        bow.rotation.y = Math.PI / 2
        // Its belly bowed out ahead of the hand and its string behind, toward the archer.
        // (The bow's own +X points back: the arc's middle is at the hand, its tips and the string behind it.)
        this.part(bow, new TorusGeometry(0.55, 0.022, 5, 20, Math.PI * 0.8), wood, 0.55, 0, 0).rotation.z = Math.PI * 0.6
        this.part(bow, new CylinderGeometry(0.004, 0.004, 0.9, 3), this.surface('#e9e4d4', { roughness: 0.5 }), 0.38, 0, 0)
        this.part(bow, new BoxGeometry(0.04, 0.12, 0.04), m.team, 0, 0, 0)
        return { main, mainHold: 'free', off, offHold: 'bow', tip: bow, strike: bow, strikeShape: { x: 0.8, y: 2.6, z: 0.8 } }
      }
      case 'rifle': {
        const gun = joint(this.root)
        this.carried = gun
        this.part(gun, new BoxGeometry(0.06, 0.32, 0.09), m.dark, 0, -0.05, 0)
        this.part(gun, new CylinderGeometry(0.018, 0.018, 0.55, 8), m.steel, 0, 0.35, 0.02)
        this.part(gun, new CylinderGeometry(0.025, 0.025, 0.12, 8), m.steel, 0, 0.08, 0.07)
        this.part(gun, new BoxGeometry(0.04, 0.08, 0.06), m.team, 0, 0.12, -0.03)
        this.part(gun, new BoxGeometry(0.012, 0.5, 0.012), m.leather, 0.03, 0.12, -0.05)
        return { main, mainHold: 'free', tip: point(gun, 0.64), strike: point(gun, 0.3), strikeShape: { x: 0.5, y: 2.4, z: 0.5 } }
      }
      case 'launcher': {
        const gun = joint(this.root)
        this.carried = gun
        this.part(gun, new BoxGeometry(0.07, 0.26, 0.1), m.leather, 0, -0.08, 0)
        this.part(gun, new CylinderGeometry(0.075, 0.075, 0.16, 10), m.steel, 0, 0.1, 0)
        this.part(gun, new CylinderGeometry(0.06, 0.07, 0.36, 10), m.dark, 0, 0.35, 0)
        this.part(gun, new TorusGeometry(0.065, 0.015, 6, 12), m.accent, 0, 0.52, 0).rotation.x = Math.PI / 2
        this.part(gun, new BoxGeometry(0.012, 0.5, 0.012), m.leather, 0.06, 0.1, -0.05)
        return { main, mainHold: 'free', tip: point(gun, 0.55), strike: point(gun, 0.3), strikeShape: { x: 0.7, y: 2, z: 0.7 } }
      }
      case 'fists':
        // Wrapped hands.
        for (const hand of [this.armR.hand, this.armL.hand]) this.part(hand, new TorusGeometry(0.06, 0.02, 6, 10), m.accent, 0, 0.04, 0).rotation.x = Math.PI / 2
        return { main, mainHold: 'free', tip: this.armR.hand, offStrike: this.armL.hand, strikeShape: { x: 0.7, y: 0.7, z: 0.7 } }
      case 'branches':
        return { main, mainHold: 'free', tip: this.armR.hand, offStrike: this.armL.hand, strikeShape: { x: 0.8, y: 0.8, z: 0.8 } }
      case 'claws': {
        // Three long claws from each hand, dark, their points red.
        const off = joint(this.armL.hand)
        const nail = this.surface('#2a2228', { roughness: 0.3, metalness: 0.4 })
        for (const hand of [main, off]) {
          // Built along +Y, turned to run on down from the hand, the way the fingers go.
          const claws = joint(hand)
          claws.rotation.x = Math.PI - 0.25
          for (let index = 0; index < 3; index += 1) {
            const claw = joint(claws, (index - 1) * 0.035, 0.02, 0)
            claw.rotation.z = (index - 1) * -0.12
            this.part(claw, new ConeGeometry(0.014, 0.24, 4), nail, 0, 0.12, 0)
            this.part(claw, new ConeGeometry(0.009, 0.06, 4), m.accent, 0, 0.24, 0)
          }
        }
        return { main, mainHold: 'free', off, offHold: 'free', tip: main, strike: main, offStrike: off, strikeShape: { x: 0.9, y: 1.2, z: 0.9 } }
      }
    }
  }
}

const UP = new Vector3(0, 1, 0)

// The angle of what a hand holds, given how far the arm holding it is turned: kept upright, kept level, or left as the hand has it.
function holdAngle(held: Group, hold: Hold, armPitch: number): void {
  if (hold === 'up') held.rotation.x = -armPitch
  else if (hold === 'aim') held.rotation.x = -armPitch + Math.PI / 2
  // Of the arm's turn, the bow takes BOW_SWING, and is upright at full draw.
  else if (hold === 'bow') held.rotation.x = -armPitch + BOW_SWING * (armPitch - BOW_DRAWN_ARM)
}

function blendPose(pose: Pose, target: Pose, k: number): void {
  pose.shoulderL.x = lerp(pose.shoulderL.x, target.shoulderL.x, k)
  pose.shoulderL.z = lerp(pose.shoulderL.z, target.shoulderL.z, k)
  pose.shoulderR.x = lerp(pose.shoulderR.x, target.shoulderR.x, k)
  pose.shoulderR.z = lerp(pose.shoulderR.z, target.shoulderR.z, k)
  pose.elbowL = lerp(pose.elbowL, target.elbowL, k)
  pose.elbowR = lerp(pose.elbowR, target.elbowR, k)
  pose.pitch = lerp(pose.pitch, target.pitch, k)
  pose.yaw = lerp(pose.yaw, target.yaw, k)
  pose.head = lerp(pose.head, target.head, k)
}

// The pose of a style as it winds up (`windup`, 0 to 1) and as it goes off (`swing`, 0 to 1), from the pose it starts from.
function styledPose(style: Style, from: Pose, windup: number, swing: number): Pose {
  const pose: Pose = { ...from, shoulderL: { ...from.shoulderL }, shoulderR: { ...from.shoulderR } }
  // From where it starts, to the top of the windup, to the end of the blow.
  const arc = (start: number, top: number, end: number): number => lerp(lerp(start, top, windup), end, swing)
  switch (style) {
    case 'blade':
      // Raised back over the shoulder, then brought down and across.
      pose.shoulderR.x = arc(from.shoulderR.x, -2.7, -0.55)
      pose.shoulderR.z = lerp(from.shoulderR.z, 0.35, windup * (1 - swing))
      pose.elbowR = arc(from.elbowR, -1.3, -0.15)
      pose.yaw = arc(from.yaw, -0.45, 0.55)
      pose.pitch = arc(from.pitch, -0.1, 0.28)
      pose.shoulderL.x = lerp(from.shoulderL.x, -0.9, windup * (1 - swing * 0.5))
      break
    case 'heavy':
      // Both hands raise it high overhead, and bring it down in front.
      pose.shoulderR.x = arc(from.shoulderR.x, -2.9, -0.95)
      pose.shoulderL.x = arc(from.shoulderL.x, -2.8, -0.9)
      pose.shoulderR.z = 0.1
      pose.shoulderL.z = -0.1
      pose.elbowR = arc(from.elbowR, -0.9, -0.1)
      pose.elbowL = arc(from.elbowL, -0.9, -0.15)
      pose.pitch = arc(from.pitch, -0.25, 0.5)
      pose.head = lerp(0, -0.2, windup * (1 - swing))
      break
    case 'dual':
      // Both blades drawn back, then thrust out one after the other.
      pose.shoulderR.x = arc(from.shoulderR.x, 0.45, -1.55)
      pose.shoulderL.x = arc(from.shoulderL.x, 0.4, lerp(-0.4, -1.4, Math.min(1, swing * 1.5)))
      pose.elbowR = arc(from.elbowR, -1.6, -0.05)
      pose.elbowL = arc(from.elbowL, -1.6, -0.2)
      pose.yaw = arc(from.yaw, -0.25, 0.3)
      pose.pitch = arc(from.pitch, 0.05, 0.25)
      break
    case 'unarmed':
      // The fist drawn back, the other up to guard, and a straight punch.
      pose.shoulderR.x = arc(from.shoulderR.x, 0.5, -1.6)
      pose.elbowR = arc(from.elbowR, -1.9, -0.05)
      pose.shoulderL.x = lerp(from.shoulderL.x, -1.2, windup)
      pose.elbowL = lerp(from.elbowL, -1.7, windup)
      pose.yaw = arc(from.yaw, -0.45, 0.45)
      pose.pitch = arc(from.pitch, 0, 0.18)
      break
    case 'staff':
      // The staff drawn back, then thrust at the target, its stone first.
      pose.shoulderR.x = arc(from.shoulderR.x, -1.1, -1.7)
      pose.elbowR = arc(from.elbowR, -1.4, -0.1)
      pose.shoulderL.x = lerp(from.shoulderL.x, -0.6, windup * (1 - swing))
      pose.yaw = arc(from.yaw, -0.35, 0.25)
      pose.pitch = arc(from.pitch, -0.12, 0.2)
      break
    case 'spell':
      // Both arms raised as it gathers in the hands, then flung forward.
      pose.shoulderR.x = arc(from.shoulderR.x, -2.3, -1.5)
      pose.shoulderL.x = arc(from.shoulderL.x, -2.4, -1.6)
      pose.shoulderL.z = lerp(from.shoulderL.z, -0.45, windup * (1 - swing))
      pose.shoulderR.z = lerp(from.shoulderR.z, 0.4, windup * (1 - swing))
      pose.elbowL = lerp(from.elbowL, -0.15, windup)
      pose.elbowR = lerp(from.elbowR, -0.3, windup)
      pose.pitch = arc(from.pitch, -0.16, 0.22)
      pose.head = lerp(0, -0.25, windup * (1 - swing))
      break
    case 'bow':
      // The bow arm straight out ahead, the string drawn back to the cheek, and loosed.
      pose.shoulderL.x = lerp(from.shoulderL.x, -1.55, Math.max(windup, swing))
      pose.shoulderL.z = -0.05
      pose.elbowL = lerp(from.elbowL, -0.05, Math.max(windup, swing))
      pose.shoulderR.x = arc(from.shoulderR.x, -1.45, -1.3)
      pose.shoulderR.z = arc(from.shoulderR.z, 0.5, 0.3)
      pose.elbowR = arc(from.elbowR, -2.3, -0.9)
      pose.yaw = arc(from.yaw, -0.55, -0.35)
      break
    case 'gun':
      // Brought up to the shoulder and aimed, the right hand at the shoulder and the left reaching out along the barrel, and it kicks
      // as it fires.
      pose.shoulderR.x = arc(from.shoulderR.x, 0, -0.08)
      pose.shoulderR.z = lerp(from.shoulderR.z, -0.8, windup)
      pose.elbowR = arc(from.elbowR, -2.0, -1.9)
      pose.shoulderL.x = arc(from.shoulderL.x, -1.26, -1.3)
      pose.shoulderL.z = lerp(from.shoulderL.z, 0.85, windup)
      pose.elbowL = lerp(from.elbowL, -0.05, windup)
      pose.pitch = lerp(lerp(from.pitch, 0.04, windup), -0.18, Math.sin(Math.min(1, swing) * Math.PI))
      pose.head = lerp(0, 0.1, windup)
      break
    case 'claw':
      // Both arms flung up and out, claws spread, then raked in across each other.
      pose.shoulderR.x = arc(from.shoulderR.x, -1.9, -1.3)
      pose.shoulderL.x = arc(from.shoulderL.x, -1.8, -1.35)
      pose.shoulderR.z = arc(from.shoulderR.z, 0.95, -0.35)
      pose.shoulderL.z = arc(from.shoulderL.z, -0.95, 0.35)
      pose.elbowR = arc(from.elbowR, -1.1, -0.2)
      pose.elbowL = arc(from.elbowL, -1.1, -0.2)
      pose.pitch = arc(from.pitch, -0.2, 0.35)
      pose.head = lerp(0, -0.2, windup * (1 - swing))
      break
    case 'throw':
      // The arm wound back high, the other pointing ahead, and an overhand throw.
      pose.shoulderR.x = arc(from.shoulderR.x, -2.7, -0.7)
      pose.shoulderR.z = lerp(from.shoulderR.z, 0.3, windup * (1 - swing))
      pose.elbowR = arc(from.elbowR, -1.6, -0.1)
      pose.shoulderL.x = lerp(from.shoulderL.x, -1.1, windup * (1 - swing * 0.6))
      pose.yaw = arc(from.yaw, -0.55, 0.5)
      pose.pitch = arc(from.pitch, -0.12, 0.3)
      break
  }
  return pose
}
