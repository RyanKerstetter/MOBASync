import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Mesh,
  type MeshBasicMaterial,
  type MeshStandardMaterial,
} from 'three'
import { colour } from '../space.ts'
import type { VisionShading } from '../vision-shading.ts'
import { ease, joint, Model, type FxContext, type PoseInput } from './model.ts'

// What every structure has: a barrier while it cannot be hurt, and a collapse when it is destroyed (it sinks and tips, and
// throws up dust as it goes).
export abstract class StructureModel extends Model {
  override readonly turns = false
  protected readonly standing: Group
  private readonly barrier: Group
  private readonly barrierMaterial: MeshBasicMaterial
  private collapsed = false
  protected readonly radius: number

  constructor(vision: VisionShading, radius: number, protected readonly team: string) {
    super(vision)
    this.radius = radius
    this.standing = joint(this.root)
    this.barrier = joint(this.root)
    this.barrierMaterial = this.glow('#cfe6ff', 0.12)
    const dome = this.part(this.barrier, new SphereGeometry(radius * 1.35, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), this.barrierMaterial, 0, 0, 0, false)
    dome.scale.y = 1.6
    const ring = this.part(this.barrier, new TorusGeometry(radius * 1.35, 1.6, 6, 40), this.glow('#e8f4ff', 0.5), 0, 2, 0, false)
    ring.rotation.x = Math.PI / 2
    this.barrier.visible = false
  }

  // Shows the barrier, while what guards it stands.
  setProtected(on: boolean, t: number): void {
    this.barrier.visible = on
    if (on) {
      this.barrierMaterial.opacity = 0.1 + Math.sin(t * 2.4) * 0.03
      this.barrier.rotation.y = t * 0.3
    }
  }

  protected collapse(input: PoseInput): void {
    if (!input.dead) {
      this.standing.position.y = 0
      this.standing.rotation.set(0, 0, 0)
      this.collapsed = false
      return
    }
    const fall = ease(input.deadFor / 1.6)
    this.standing.position.y = -this.height * 0.75 * fall
    this.standing.rotation.set(0.25 * fall, 0, -0.18 * fall)
  }

  override ambient(fx: FxContext, _dt = 0): void {
    if (!this.standing.visible) return
    if (this.standing.position.y < -1 && !this.collapsed) {
      this.collapsed = true
      // The dust of it coming down.
      const base = this.root.position
      const dust = colour('#a09684')
      for (let index = 0; index < 60; index += 1) {
        const angle = Math.random() * Math.PI * 2
        const distance = this.radius * (0.4 + Math.random())
        fx.puff.emit({
          x: base.x + Math.cos(angle) * distance,
          y: 6 + Math.random() * this.radius,
          z: base.z + Math.sin(angle) * distance,
          vx: Math.cos(angle) * 40,
          vy: 20 + Math.random() * 50,
          vz: Math.sin(angle) * 40,
          life: 1.2 + Math.random() * 0.8,
          size: 30,
          sizeEnd: 70,
          color: dust,
          alpha: 0.5,
          drag: 1.5,
        })
      }
    }
  }
}

// A turret: a tapering tower of stone on an eight-sided footing, bound with bands of its team's colour, with a crown of
// battlements and a crystal of its team's colour turning over the top, which flares as it shoots.
export class TurretModel extends StructureModel {
  readonly height: number
  private readonly crystal: Group
  private readonly crystalMaterial: MeshStandardMaterial
  private readonly halo: Mesh
  private readonly shards: Group
  private charge = 0

  constructor(vision: VisionShading, radius: number, team: string) {
    super(vision, radius, team)
    const r = radius
    const stone = this.surface('#8e8a82', { roughness: 0.9, flatShading: true })
    const darkStone = this.surface('#5d5a55', { roughness: 0.95, flatShading: true })
    const teamGlow = this.surface(team, { emissive: colour(team), emissiveIntensity: 0.6, roughness: 0.4 })
    const metal = this.surface('#c9b27a', { roughness: 0.35, metalness: 0.8 })
    const s = this.standing
    this.part(s, new CylinderGeometry(r * 1.05, r * 1.18, r * 0.36, 8), darkStone, 0, r * 0.18, 0)
    this.part(s, new CylinderGeometry(r * 0.66, r * 0.84, r * 2.5, 8), stone, 0, r * 0.36 + r * 1.25, 0)
    for (const at of [0.9, 2.2]) {
      this.part(s, new CylinderGeometry(r * (0.84 - at * 0.072) + 1.5, r * (0.84 - at * 0.072) + 1.5, r * 0.12, 8), teamGlow, 0, r * 0.36 + r * at, 0)
    }
    // Arrow slits.
    for (let side = 0; side < 4; side += 1) {
      const slit = this.part(s, new BoxGeometry(r * 0.1, r * 0.4, r * 0.1), this.surface('#1b1a19', { roughness: 1 }), 0, r * 1.75, 0)
      const angle = side * Math.PI / 2 + Math.PI / 4
      slit.position.x = Math.sin(angle) * r * 0.72
      slit.position.z = Math.cos(angle) * r * 0.72
      slit.rotation.y = angle
    }
    const top = r * 0.36 + r * 2.5
    this.part(s, new CylinderGeometry(r * 0.95, r * 0.75, r * 0.3, 8), darkStone, 0, top + r * 0.15, 0)
    for (let index = 0; index < 8; index += 1) {
      const angle = index * Math.PI / 4
      const merlon = this.part(s, new BoxGeometry(r * 0.28, r * 0.3, r * 0.2), stone, Math.sin(angle) * r * 0.82, top + r * 0.45, Math.cos(angle) * r * 0.82)
      merlon.rotation.y = angle
    }
    this.part(s, new CylinderGeometry(r * 0.1, r * 0.16, r * 0.5, 6), metal, 0, top + r * 0.5, 0)
    this.crystal = joint(s, 0, top + r * 1.05, 0)
    this.crystalMaterial = this.surface(team, { emissive: colour(team), emissiveIntensity: 1.2, roughness: 0.15, metalness: 0.1, flatShading: true })
    const gem = this.part(this.crystal, new OctahedronGeometry(r * 0.36, 0), this.crystalMaterial, 0, 0, 0)
    gem.scale.set(1, 1.6, 1)
    this.halo = this.part(this.crystal, new SphereGeometry(r * 0.7, 16, 10), this.glow(team, 0.22), 0, 0, 0, false)
    this.shards = joint(this.crystal)
    for (let index = 0; index < 3; index += 1) {
      const angle = index * Math.PI * 2 / 3
      this.part(this.shards, new OctahedronGeometry(r * 0.09, 0), this.crystalMaterial, Math.cos(angle) * r * 0.62, 0, Math.sin(angle) * r * 0.62)
    }
    this.height = top + r * 1.6
  }

  // Where its shots start: the crystal.
  muzzle(): Vector3 {
    return this.crystal.localToWorld(new Vector3())
  }

  pose(input: PoseInput): void {
    const { t, dt } = input
    this.collapse(input)
    const charging = input.action?.kind === 'attack' ? input.action.progress : 0
    const flash = input.release ? 1 - input.release.t : 0
    this.charge += (Math.max(charging, flash) - this.charge) * Math.min(1, dt * 12)
    this.crystal.rotation.y += dt * (0.8 + this.charge * 6)
    this.crystal.position.y = this.height - this.radius * 0.55 + Math.sin(t * 1.6) * this.radius * 0.06
    this.shards.rotation.y = -t * 1.3
    this.crystalMaterial.emissiveIntensity = input.dead ? 0.1 : 1.1 + this.charge * 2.5 + Math.sin(t * 2) * 0.15
    this.halo.scale.setScalar(1 + this.charge * 0.6)
    this.halo.visible = !input.dead
  }

  override ambient(fx: FxContext, dt: number): void {
    super.ambient(fx, dt)
    if (this.standing.position.y < -1) return
    // Motes drifting up off the crystal.
    if (Math.random() < dt * 6) {
      const at = this.muzzle()
      fx.glow.emit({
        x: at.x + (Math.random() - 0.5) * this.radius,
        y: at.y - this.radius * 0.3,
        z: at.z + (Math.random() - 0.5) * this.radius,
        vy: 18 + Math.random() * 14,
        life: 1.2,
        size: 5,
        sizeEnd: 1,
        color: colour(this.team),
        alpha: 0.8,
        fadeIn: 0.2,
      })
    }
  }
}

// A core: the heart of a base. A great crystal of its team's colour hangs turning over a stepped pedestal, ringed by two bands of
// light that turn against each other, with four obelisks round it.
export class CoreModel extends StructureModel {
  readonly height: number
  private readonly crystal: Group
  private readonly crystalMaterial: MeshStandardMaterial
  private readonly rings: Group[] = []

  constructor(vision: VisionShading, radius: number, team: string) {
    super(vision, radius, team)
    const r = radius
    const stone = this.surface('#9a958c', { roughness: 0.85, flatShading: true })
    const darkStone = this.surface('#5d5a55', { roughness: 0.95, flatShading: true })
    const teamGlow = this.surface(team, { emissive: colour(team), emissiveIntensity: 0.8, roughness: 0.4 })
    const s = this.standing
    this.part(s, new CylinderGeometry(r * 1.2, r * 1.3, r * 0.22, 6), darkStone, 0, r * 0.11, 0)
    this.part(s, new CylinderGeometry(r * 0.95, r * 1.05, r * 0.2, 6), stone, 0, r * 0.32, 0)
    this.part(s, new CylinderGeometry(r * 0.7, r * 0.8, r * 0.18, 6), darkStone, 0, r * 0.51, 0)
    this.part(s, new TorusGeometry(r * 0.75, r * 0.04, 6, 6), teamGlow, 0, r * 0.6, 0).rotation.x = Math.PI / 2
    for (let index = 0; index < 4; index += 1) {
      const angle = index * Math.PI / 2 + Math.PI / 4
      const x = Math.sin(angle) * r * 1.1
      const z = Math.cos(angle) * r * 1.1
      this.part(s, new CylinderGeometry(r * 0.08, r * 0.13, r * 1.3, 4), stone, x, r * 0.65 + r * 0.22, z)
      this.part(s, new OctahedronGeometry(r * 0.1, 0), teamGlow, x, r * 1.62, z)
    }
    this.crystal = joint(s, 0, r * 1.5, 0)
    this.crystalMaterial = this.surface(team, { emissive: colour(team), emissiveIntensity: 1.3, roughness: 0.1, flatShading: true, transparent: true, opacity: 0.92 })
    const gem = this.part(this.crystal, new OctahedronGeometry(r * 0.55, 0), this.crystalMaterial, 0, 0, 0)
    gem.scale.set(1, 1.9, 1)
    this.part(this.crystal, new SphereGeometry(r * 0.95, 16, 10), this.glow(team, 0.2), 0, 0, 0, false)
    for (let index = 0; index < 2; index += 1) {
      const ring = joint(this.crystal)
      this.part(ring, new TorusGeometry(r * (0.95 + index * 0.18), r * 0.03, 6, 40), this.glow(team, 0.7), 0, 0, 0, false)
      ring.rotation.x = Math.PI / 2 + (index ? 0.5 : -0.4)
      this.rings.push(ring)
    }
    this.height = r * 2.7
  }

  pose(input: PoseInput): void {
    const { t, dt } = input
    this.collapse(input)
    const struck = input.release ? 1 - input.release.t : 0
    this.crystal.rotation.y += dt * 0.5
    this.crystal.position.y = this.radius * 1.55 + Math.sin(t * 1.2) * this.radius * 0.08
    this.rings[0].rotation.z += dt * 0.9
    this.rings[1].rotation.z -= dt * 0.7
    this.crystalMaterial.emissiveIntensity = input.dead ? 0.1 : 1.2 + Math.sin(t * 2.2) * 0.2 + struck * 2 + (input.action ? input.action.progress * 1.5 : 0)
  }

  override ambient(fx: FxContext, dt: number): void {
    super.ambient(fx, dt)
    if (this.standing.position.y < -1) return
    if (Math.random() < dt * 10) {
      const at = this.crystal.localToWorld(new Vector3())
      const angle = Math.random() * Math.PI * 2
      fx.glow.emit({
        x: at.x + Math.cos(angle) * this.radius,
        y: at.y - this.radius,
        z: at.z + Math.sin(angle) * this.radius,
        vx: -Math.cos(angle) * 12,
        vy: 26,
        vz: -Math.sin(angle) * 12,
        life: 1.6,
        size: 6,
        sizeEnd: 1,
        color: colour(this.team),
        alpha: 0.8,
        fadeIn: 0.2,
      })
    }
  }
}

// A healing zone: a round fountain of carved stone, its rim banded in its team's colour, brimming with glowing green water, with
// a pillar in the middle that holds up a turning cross of green light. Sparkles of green rise off the water all the time, so
// it reads from across the map as a place that heals. The core's is bigger, on a diamond step, as the core is the heart of a base.
export class HealingZoneModel extends StructureModel {
  readonly height: number
  private readonly cross: Group
  private readonly water: Mesh
  private readonly waterMaterial: MeshStandardMaterial
  private readonly crossMaterial: MeshStandardMaterial

  constructor(vision: VisionShading, radius: number, team: string, core: boolean) {
    super(vision, radius, team)
    const r = radius
    const stone = this.surface('#c9c2b3', { roughness: 0.75, flatShading: true })
    const darkStone = this.surface('#6d685f', { roughness: 0.9, flatShading: true })
    const teamGlow = this.surface(team, { emissive: colour(team), emissiveIntensity: 0.6, roughness: 0.4 })
    const s = this.standing
    if (core) {
      const step = this.part(s, new CylinderGeometry(r * 1.4, r * 1.5, r * 0.18, 4), darkStone, 0, r * 0.09, 0)
      step.rotation.y = Math.PI / 4
    }
    const base = core ? r * 0.18 : 0
    // The basin: an outer wall, a rim on it, and the floor.
    this.part(s, new CylinderGeometry(r * 1.0, r * 1.1, r * 0.4, 20, 1, true), stone, 0, base + r * 0.2, 0)
    this.part(s, new TorusGeometry(r * 1.0, r * 0.1, 8, 28), stone, 0, base + r * 0.42, 0).rotation.x = Math.PI / 2
    this.part(s, new TorusGeometry(r * 1.06, r * 0.045, 6, 28), teamGlow, 0, base + r * 0.3, 0).rotation.x = Math.PI / 2
    this.part(s, new CylinderGeometry(r * 0.98, r * 0.98, r * 0.06, 20), darkStone, 0, base + r * 0.05, 0)
    this.waterMaterial = this.surface('#7dffb0', { emissive: colour('#3cff8a'), emissiveIntensity: 0.55, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.75 })
    this.water = this.part(s, new CylinderGeometry(r * 0.94, r * 0.94, r * 0.04, 24), this.waterMaterial, 0, base + r * 0.32, 0, false)
    // The pillar, and the cross it holds up.
    this.part(s, new CylinderGeometry(r * 0.16, r * 0.24, r * 0.9, 8), stone, 0, base + r * 0.6, 0)
    this.part(s, new CylinderGeometry(r * 0.3, r * 0.2, r * 0.12, 8), stone, 0, base + r * 1.08, 0)
    this.cross = joint(s, 0, base + r * 1.6, 0)
    this.crossMaterial = this.surface('#c8ffd8', { emissive: colour('#4dff8f'), emissiveIntensity: 1.6, roughness: 0.2 })
    this.part(this.cross, new BoxGeometry(r * 0.18, r * 0.62, r * 0.18), this.crossMaterial, 0, 0, 0)
    this.part(this.cross, new BoxGeometry(r * 0.62, r * 0.18, r * 0.18), this.crossMaterial, 0, 0, 0)
    this.part(this.cross, new IcosahedronGeometry(r * 0.55, 1), this.glow('#5dff9a', 0.22), 0, 0, 0, false)
    this.height = base + r * 2.1
  }

  pose(input: PoseInput): void {
    const { t, dt } = input
    this.collapse(input)
    this.cross.rotation.y += dt * 1.1
    this.cross.position.y = this.height - this.radius * 0.5 + Math.sin(t * 1.8) * this.radius * 0.07
    this.waterMaterial.emissiveIntensity = input.dead ? 0 : 0.5 + Math.sin(t * 2.6) * 0.12
    this.crossMaterial.emissiveIntensity = input.dead ? 0.1 : 1.5 + Math.sin(t * 3) * 0.3
  }

  override ambient(fx: FxContext, dt: number): void {
    super.ambient(fx, dt)
    if (this.standing.position.y < -1) return
    // Green sparkles rising off the water, and the odd one from the cross.
    const green = colour('#6dff9e')
    const at = this.water.localToWorld(new Vector3())
    if (Math.random() < dt * 14) {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.random() * this.radius * 0.9
      fx.glow.emit({
        x: at.x + Math.cos(angle) * distance,
        y: at.y + 2,
        z: at.z + Math.sin(angle) * distance,
        vy: 22 + Math.random() * 22,
        vx: (Math.random() - 0.5) * 6,
        vz: (Math.random() - 0.5) * 6,
        life: 1.4 + Math.random() * 0.6,
        size: 5,
        sizeEnd: 1.5,
        color: green,
        alpha: 0.9,
        fadeIn: 0.15,
      })
    }
    if (Math.random() < dt * 3) {
      const top = this.cross.localToWorld(new Vector3())
      fx.glow.emit({ x: top.x, y: top.y, z: top.z, vy: 14, life: 1, size: 12, sizeEnd: 2, color: green, alpha: 0.6 })
    }
  }
}

