import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  DodecahedronGeometry,
  Group,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import { jitter } from '../terrain-mesh.ts'
import { colour, lerp } from '../space.ts'
import type { VisionShading } from '../vision-shading.ts'
import { approach, ease, easeOut, joint, Model, type FxContext, type PoseInput } from './model.ts'

// The Hellhound: a great hound of hell, black and scorched, with cracks of fire glowing through its hide, a mane of spines down its neck and back burning at their
// tips, horns swept back off its skull, burning eyes, a jaw full of teeth, and long claws. It lopes on four legs with its head low, crouches as it winds up, and
// lunges, raking with a forepaw and snapping; as it casts it rears and throws its head back with its jaws wide. Embers rise off its back, and fire drips from its jaws.
// When it dies it falls on its side and its fires go out.
export class HoundModel extends Model {
  readonly height: number
  private readonly scale: number
  private readonly fall: Group
  private readonly body: Group
  private readonly neck: Group
  private readonly head: Group
  private readonly jaw: Group
  private readonly tail: Group[] = []
  // Each leg: the joint at the shoulder or hip, and the one at the knee.
  private readonly legs: Array<{ upper: Group; lower: Group; front: boolean; side: number }> = []
  private readonly spines: Group[] = []
  private walkWeight = 0
  private actionWeight = 0
  private phase = 0
  private dead = false

  constructor(vision: VisionShading, radius: number) {
    super(vision)
    // Bigger than a wolf: a champion, standing about as tall as the others' shoulders.
    this.scale = radius / 0.5 * 1.2
    this.height = 1.05 * this.scale
    this.root.scale.setScalar(this.scale)
    const hide = this.surface('#2a0e0c', { roughness: 0.9, flatShading: true })
    const scorched = this.surface('#4a1a12', { roughness: 0.85, flatShading: true })
    const bone = this.surface('#3a2c26', { roughness: 0.5, flatShading: true })
    const claw = this.surface('#141010', { roughness: 0.3, metalness: 0.4 })
    const fire = this.surface('#ff6a1a', { emissive: colour('#ff4a0a'), emissiveIntensity: 2.2, roughness: 0.6 })
    const eyes = this.surface('#ffd86a', { emissive: colour('#ff7a1a'), emissiveIntensity: 3 })
    const teeth = this.surface('#e8dcc4', { roughness: 0.4 })

    this.fall = joint(this.root)
    this.body = joint(this.fall, 0, 0.62, 0)
    // The trunk: a deep chest, a narrow waist, haunches.
    const chest = this.part(this.body, jitter(new DodecahedronGeometry(0.3, 1), 0.07, 31), hide, 0, 0.02, 0.2)
    chest.scale.set(0.95, 1.05, 1.15)
    const waist = this.part(this.body, jitter(new DodecahedronGeometry(0.22, 1), 0.08, 32), scorched, 0, 0.0, -0.18)
    waist.scale.set(0.85, 0.8, 1.2)
    const haunch = this.part(this.body, jitter(new DodecahedronGeometry(0.24, 1), 0.07, 33), hide, 0, 0.02, -0.42)
    haunch.scale.set(1, 0.95, 1)
    // Cracks of fire in its flanks.
    for (const side of [-1, 1]) {
      for (let index = 0; index < 3; index += 1) {
        const crack = this.part(this.body, new BoxGeometry(0.012, 0.16 - index * 0.03, 0.03), fire, side * (0.27 - index * 0.02), 0.03 - index * 0.04, 0.22 - index * 0.2, false)
        crack.rotation.set(0.4 * side, 0, 0.3 * side)
      }
    }
    // The spines down its back, each burning at its tip.
    for (let index = 0; index < 7; index += 1) {
      const z = 0.36 - index * 0.13
      const spine = joint(this.body, 0, 0.26 - Math.abs(index - 2) * 0.012, z)
      const length = 0.2 - index * 0.016
      this.part(spine, new ConeGeometry(0.035, length, 4), bone, 0, length / 2, 0).rotation.x = -0.5
      this.part(spine, new ConeGeometry(0.02, 0.06, 4), fire, 0, length * 0.95, -length * 0.45, false).rotation.x = -0.5
      this.spines.push(spine)
    }

    // The neck and head, carried low and forward.
    this.neck = joint(this.body, 0, 0.12, 0.42)
    const neckMeat = this.part(this.neck, jitter(new DodecahedronGeometry(0.17, 1), 0.08, 34), hide, 0, 0.04, 0.08)
    neckMeat.scale.set(0.9, 1, 1.2)
    for (let index = 0; index < 5; index += 1) {
      const turn = (index - 2) * 0.35
      this.part(this.neck, new ConeGeometry(0.03, 0.22, 4), bone, Math.sin(turn) * 0.1, 0.17, 0.02 - Math.abs(index - 2) * 0.02).rotation.set(-0.9, 0, -turn)
    }
    this.head = joint(this.neck, 0, 0.08, 0.26)
    const skull = this.part(this.head, jitter(new DodecahedronGeometry(0.14, 1), 0.07, 35), hide, 0, 0.03, 0)
    skull.scale.set(1, 0.85, 1.1)
    const muzzle = this.part(this.head, new BoxGeometry(0.15, 0.1, 0.24), scorched, 0, -0.01, 0.17)
    muzzle.rotation.x = 0.08
    this.part(this.head, new SphereGeometry(0.03, 6, 4), claw, 0, 0.02, 0.29)
    for (const side of [-1, 1]) {
      // Horns swept back.
      const horn = joint(this.head, side * 0.08, 0.1, -0.02)
      horn.rotation.set(-0.9, 0, -side * 0.35)
      this.part(horn, new ConeGeometry(0.035, 0.28, 5), bone, 0, 0.14, 0)
      this.part(horn, new TorusGeometry(0.035, 0.01, 4, 8), bone, 0, 0.04, 0).rotation.x = Math.PI / 2
      // Burning eyes under a heavy brow.
      this.part(this.head, new SphereGeometry(0.026, 8, 6), eyes, side * 0.065, 0.05, 0.1, false)
      this.part(this.head, new BoxGeometry(0.07, 0.025, 0.05), hide, side * 0.06, 0.085, 0.1).rotation.z = side * 0.3
      // Upper teeth.
      for (let index = 0; index < 3; index += 1) this.part(this.head, new ConeGeometry(0.012, 0.05, 4), teeth, side * 0.055, -0.07, 0.12 + index * 0.06, false).rotation.x = Math.PI
    }
    this.part(this.head, new SphereGeometry(0.06, 8, 6), this.glow('#ff5a1a', 0.35), 0, -0.04, 0.2, false)
    this.jaw = joint(this.head, 0, -0.06, 0.04)
    const lower = this.part(this.jaw, new BoxGeometry(0.12, 0.05, 0.24), scorched, 0, -0.02, 0.12)
    lower.rotation.x = -0.05
    for (const side of [-1, 1]) {
      for (let index = 0; index < 3; index += 1) this.part(this.jaw, new ConeGeometry(0.011, 0.045, 4), teeth, side * 0.045, 0.02, 0.08 + index * 0.06, false)
    }
    this.part(this.jaw, new BoxGeometry(0.08, 0.01, 0.18), fire, 0, 0.004, 0.12, false)

    // The legs: thick upper legs, long lower ones, great clawed paws. The front are set under the chest, the hind under the haunches with a backward knee.
    for (const [x, z, front] of [[-0.17, 0.3, true], [0.17, 0.3, true], [-0.17, -0.42, false], [0.17, -0.42, false]] as const) {
      const upper = joint(this.body, x, -0.08, z)
      this.part(upper, new CapsuleGeometry(0.075, 0.18, 4, 8), hide, 0, -0.12, front ? 0.02 : -0.03).rotation.x = front ? -0.15 : 0.35
      const lower = joint(upper, 0, -0.24, front ? 0.03 : -0.06)
      this.part(lower, new CapsuleGeometry(0.05, 0.2, 4, 6), scorched, 0, -0.13, 0).rotation.x = front ? 0.1 : -0.35
      const paw = this.part(lower, new BoxGeometry(0.12, 0.05, 0.14), hide, 0, -0.27, 0.04)
      paw.rotation.x = 0.05
      for (let index = 0; index < 3; index += 1) {
        this.part(lower, new ConeGeometry(0.014, 0.08, 4), claw, (index - 1) * 0.04, -0.29, 0.13, false).rotation.x = Math.PI / 2 + 0.3
      }
      this.legs.push({ upper, lower, front, side: Math.sign(x) })
    }

    // The tail: three joints, its end a tuft of fire.
    let at = joint(this.body, 0, 0.08, -0.6)
    for (let index = 0; index < 3; index += 1) {
      this.tail.push(at)
      this.part(at, new ConeGeometry(0.05 - index * 0.012, 0.2, 5), index === 2 ? scorched : hide, 0, 0, -0.09).rotation.x = -Math.PI / 2
      at = joint(at, 0, 0, -0.17)
    }
    this.part(at, new ConeGeometry(0.04, 0.12, 5), fire, 0, 0, -0.02, false).rotation.x = -Math.PI / 2
    this.mergeStillOnEveryJoint()
  }

  pose(input: PoseInput): void {
    const { t, dt } = input
    this.dead = input.dead
    this.walkWeight = approach(this.walkWeight, input.moving && !input.dead ? 1 : 0, 8, dt)
    const acting = input.action !== undefined || input.release !== undefined
    this.actionWeight = approach(this.actionWeight, acting ? 1 : 0, acting ? 20 : 7, dt)
    // A loping gallop: the legs swing in pairs, the body rocking.
    this.phase += dt * Math.max(70, input.speed) / (1.1 * this.scale) * Math.PI * this.walkWeight
    const w = this.walkWeight
    const s = Math.sin(this.phase)
    const c = Math.cos(this.phase)
    for (const { upper, lower, front, side } of this.legs) {
      const offset = front ? 0 : Math.PI * 0.85
      const swing = Math.sin(this.phase + offset + (side > 0 ? 0.35 : 0))
      upper.rotation.x = swing * 0.65 * w
      lower.rotation.x = (front ? Math.max(0, -swing) * 0.9 : -Math.max(0, swing) * 0.7) * w
    }
    let bodyPitch = Math.sin(this.phase * 2) * 0.05 * w + Math.sin(t * 1.8) * 0.02
    let bodyLift = Math.abs(c) * 0.04 * w + Math.sin(t * 2.2) * 0.008
    let lunge = 0
    let neckPitch = 0.25 + s * 0.06 * w
    let headPitch = -0.15
    let bite = 0.08 + Math.sin(t * 3) * 0.04
    let rake = 0
    if (this.actionWeight > 0.001) {
      const gather = input.action ? ease(input.action.progress) : 1
      const spring = input.release ? Math.sin(Math.min(1, input.release.t * 1.4) * Math.PI) : 0
      const casting = (input.action?.kind ?? input.release?.kind) === 'cast'
      if (casting) {
        // Rears up, throws its head back, and opens its jaws wide.
        bodyPitch = lerp(bodyPitch, -0.35 * (input.release ? 1 - input.release.t * 0.5 : gather), this.actionWeight)
        bodyLift = lerp(bodyLift, 0.1 * gather, this.actionWeight)
        neckPitch = lerp(neckPitch, -0.6 * gather, this.actionWeight)
        headPitch = lerp(headPitch, -0.4 * gather, this.actionWeight)
        bite = lerp(bite, 0.9 * (input.release ? 1 : gather), this.actionWeight)
      } else {
        // Crouches, then lunges, raking with a forepaw and snapping.
        bodyPitch = lerp(bodyPitch, input.release ? -0.15 * spring : 0.15 * gather, this.actionWeight)
        bodyLift = lerp(bodyLift, input.release ? 0.04 * spring : -0.08 * gather, this.actionWeight)
        lunge = spring * 0.35
        bite = lerp(bite, input.release ? 0.8 * spring : 0.4 * gather, this.actionWeight)
        rake = input.release ? spring : gather * 0.4
      }
    }
    this.body.position.set(0, 0.62 + bodyLift, lunge)
    this.body.rotation.x = bodyPitch
    this.neck.rotation.x = neckPitch
    this.head.rotation.x = headPitch
    this.jaw.rotation.x = bite * 0.7 + (input.stunned ? Math.sin(t * 10) * 0.1 : 0)
    // The right forepaw rakes: raised and swept down across.
    if (rake > 0) {
      const right = this.legs[1]
      right.upper.rotation.x = lerp(right.upper.rotation.x, -1.3 + rake * 0.4, Math.min(1, rake * 2))
      right.lower.rotation.x = lerp(right.lower.rotation.x, -0.6 * rake, Math.min(1, rake * 2))
      right.upper.rotation.z = rake * 0.4
    } else {
      this.legs[1].upper.rotation.z = 0
    }
    this.tail.forEach((part, index) => {
      part.rotation.y = Math.sin(t * (2 + w * 5) - index * 0.6) * (0.25 + 0.2 * w)
      part.rotation.x = -0.2 + index * 0.08
    })
    this.spines.forEach((spine, index) => {
      spine.rotation.x = Math.sin(t * 4 + index * 0.7) * 0.06
    })
    if (input.dead) {
      const fall = easeOut(input.deadFor / 0.6)
      this.fall.rotation.z = Math.PI / 2 * fall
      this.fall.position.y = 0.12 * fall
    } else {
      this.fall.rotation.z = 0
      this.fall.position.y = 0
    }
  }

  // Its fires: embers lifting off the spines down its back, and fire dripping from its jaws.
  override ambient(fx: FxContext, dt: number): void {
    if (this.dead || !this.root.visible) return
    if (Math.random() < dt * 14) {
      const spine = this.spines[Math.floor(Math.random() * this.spines.length)]
      const at = spine.localToWorld(new Vector3(0, 0.16, -0.06))
      fx.glow.emit({ x: at.x, y: at.y, z: at.z, vx: (Math.random() - 0.5) * 20, vy: 40 + Math.random() * 30, vz: (Math.random() - 0.5) * 20, life: 0.7, size: 4, sizeEnd: 1, color: colour('#ffb03a'), colorEnd: colour('#c4302b'), alpha: 0.9 })
    }
    if (Math.random() < dt * 6) {
      const at = this.jaw.localToWorld(new Vector3(0, 0, 0.18))
      fx.glow.emit({ x: at.x, y: at.y, z: at.z, vy: -30, life: 0.4, size: 5, sizeEnd: 1, color: colour('#ff7a1a'), alpha: 0.9, gravity: -200 })
    }
  }

  // A blow going off: sparks off its claws.
  override release(kind: 'attack' | 'cast', fx: FxContext): void {
    if (kind !== 'attack') return
    const at = this.legs[1].lower.localToWorld(new Vector3(0, -0.28, 0.12))
    for (let index = 0; index < 10; index += 1) {
      const angle = Math.random() * Math.PI * 2
      fx.glow.emit({ x: at.x, y: at.y, z: at.z, vx: Math.cos(angle) * 90, vy: Math.random() * 60, vz: Math.sin(angle) * 90, life: 0.3, size: 4, sizeEnd: 1, color: colour('#ffb03a'), alpha: 0.9, drag: 2 })
    }
  }
}
