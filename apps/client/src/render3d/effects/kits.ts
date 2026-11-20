import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  DoubleSide,
  Euler,
  Matrix4,
  Quaternion,
  TubeGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  RingGeometry,
  Shape,
  ExtrudeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2 as ThreeVector2,
  Vector3,
  type Color,
  type ShaderMaterial,
  type Texture,
} from 'three'
import type { RenderedEntity } from '../../game-state.ts'
import { HumanoidModel } from '../models/humanoid.ts'
import { ease, easeOut } from '../models/model.ts'
import { colour, lerp, seededRandom, yawToward } from '../space.ts'
import { jitter } from '../terrain-mesh.ts'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { fireMaterial } from './fx-materials.ts'
import { glowMaterial, ShotHeight, Visual, type EffectContext } from './visual.ts'

// Every other champion's abilities and shots, each with a look of its own. Each is drawn from what its entity is (its id), the
// same as the Fire Mage's and Capricorn's (elemental.ts).

// ---------------------------------------------------------------------------------------------- helpers

export type Point3 = { x: number; y: number; z: number }

// Light let out in every direction from a point.
export function burst(ctx: EffectContext, at: Point3, options: { count: number; speed: number; color: Color; colorEnd?: Color; size: number; life: number; up?: number; gravity?: number; puff?: boolean; alpha?: number; spread?: number }): void {
  const system = options.puff ? ctx.fx.puff : ctx.fx.glow
  for (let index = 0; index < options.count; index += 1) {
    const angle = Math.random() * Math.PI * 2
    const speed = options.speed * (0.4 + Math.random() * 0.6)
    const up = (options.up ?? 0.4) * (Math.random() * 2 - 0.3)
    const spread = options.spread ?? 0
    system.emit({
      x: at.x + (Math.random() - 0.5) * spread,
      y: at.y + (Math.random() - 0.5) * spread * 0.5,
      z: at.z + (Math.random() - 0.5) * spread,
      vx: Math.cos(angle) * speed,
      vy: up * speed,
      vz: Math.sin(angle) * speed,
      life: options.life * (0.7 + Math.random() * 0.5),
      size: options.size,
      sizeEnd: options.size * 0.2,
      color: options.color,
      ...(options.colorEnd ? { colorEnd: options.colorEnd } : {}),
      alpha: options.alpha ?? 0.9,
      gravity: options.gravity ?? 0,
      drag: 2,
    })
  }
}

// How high a lobbed shot is: up in an arc over its flight, highest half way.
export function lobHeight(entity: RenderedEntity, peak: number): number {
  if (entity.lifetimeTicks === undefined) return 30
  return 14 + Math.sin(Math.PI * entity.progress) * peak
}

// The way it is flying, as a turn about the vertical.
export function headingOf(entity: RenderedEntity): number {
  const v = entity.velocity
  if (Math.hypot(v.x, v.y) > 1e-6) return yawToward(v.x, v.y)
  const f = entity.facing ?? { x: 1, y: 0 }
  return yawToward(f.x, f.y)
}

export const lit = (css: string, params: Partial<{ emissive: string; emissiveIntensity: number; metalness: number; roughness: number }> = {}): MeshStandardMaterial =>
  new MeshStandardMaterial({ color: css, roughness: params.roughness ?? 0.6, metalness: params.metalness ?? 0, ...(params.emissive ? { emissive: params.emissive, emissiveIntensity: params.emissiveIntensity ?? 1 } : {}) })

// A shot: a model that flies where its entity is, at shot height or in a lob, turned the way it goes, with a trail.
export abstract class ShotVisual extends Visual {
  protected readonly height: ShotHeight | undefined
  protected readonly body = new Group()
  protected last?: Point3

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, private readonly lob = 0) {
    super(parent)
    this.height = lob > 0 ? undefined : new ShotHeight(entity, ctx)
    this.group.add(this.body)
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) {
      if (this.last) this.ended(this.last, ctx)
      return false
    }
    const y = this.height ? this.height.at(entity, ctx) : lobHeight(entity, this.lob)
    this.group.position.set(entity.position.x, y, entity.position.y)
    this.group.rotation.y = headingOf(entity)
    this.last = { x: entity.position.x, y, z: entity.position.y }
    this.fly(entity, this.last, ctx)
    return true
  }

  // Each frame of its flight: its spin, its trail.
  protected abstract fly(entity: RenderedEntity, at: Point3, ctx: EffectContext): void
  // Where it ended (it hit, or landed).
  protected ended(_at: Point3, _ctx: EffectContext): void {}
}

// ---------------------------------------------------------------------------------------------- auto attacks

// An arrow: a shaft, a head and fletching of the team's colour, pointing the way it flies, with a faint streak behind it.
export class ArrowVisual extends ShotVisual {
  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, private readonly tint: string) {
    super(parent, entity, ctx)
    const shaft = this.mesh(new Mesh(new CylinderGeometry(0.8, 0.8, 34, 5), lit('#8a6a3a')), this.body)
    shaft.rotation.x = Math.PI / 2
    const head = this.mesh(new Mesh(new ConeGeometry(2.4, 7, 4), lit('#cfd6de', { metalness: 0.8, roughness: 0.3 })), this.body)
    head.rotation.x = Math.PI / 2
    head.position.z = 20
    for (const turn of [0, Math.PI / 2]) {
      const fin = this.mesh(new Mesh(new BoxGeometry(5, 0.4, 7), lit(tint)), this.body)
      fin.position.z = -15
      fin.rotation.z = turn
    }
  }

  protected fly(entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    if (Math.random() < ctx.dt * 60) ctx.fx.glow.emit({ ...at, life: 0.18, size: 6, sizeEnd: 1, color: colour(this.tint), alpha: 0.6 })
    void entity
  }
}

// A bullet: a hot streak, long and thin.
export class TracerVisual extends ShotVisual {
  protected fly(entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    if (this.body.children.length === 0) {
      const streak = this.mesh(new Mesh(new CylinderGeometry(1.2, 0.4, 40, 5), glowMaterial('#fff1b0', 0.95)), this.body)
      streak.rotation.x = Math.PI / 2
      streak.position.z = -14
      this.mesh(new Mesh(new SphereGeometry(4, 8, 6), glowMaterial(entity.color ?? '#ffb347', 0.7)), this.body)
    }
    ctx.lights.light(at.x, at.y, at.z, entity.color ?? '#ffb347', 0.4, 100)
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 8, speed: 120, color: colour('#ffe08a'), size: 4, life: 0.2 })
  }
}

// An orb of magic with sparks or smoke behind it, for a caster's auto: the Cursebearer's is a dark curse, the Sage's a seed of
// light shedding leaves.
export class OrbVisual extends ShotVisual {
  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, private readonly tint: string, private readonly kind: 'curse' | 'seed' | 'plain') {
    super(parent, entity, ctx)
    const r = Math.max(5, entity.radius)
    this.mesh(new Mesh(new IcosahedronGeometry(r * 0.8, 1), new MeshBasicMaterial({ color: kind === 'curse' ? '#24102f' : '#f3fff0' })), this.body)
    this.mesh(new Mesh(new SphereGeometry(r * 2.2, 12, 8), glowMaterial(tint, kind === 'curse' ? 0.5 : 0.45)), this.body)
  }

  protected fly(entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    const r = Math.max(5, entity.radius)
    this.body.rotation.set(ctx.t * 6, ctx.t * 4, 0)
    for (let index = 0, count = Math.ceil(ctx.dt * 70); index < count; index += 1) {
      if (this.kind === 'curse') {
        ctx.fx.puff.emit({ x: at.x, y: at.y, z: at.z, vy: 10, vx: (Math.random() - 0.5) * 20, vz: (Math.random() - 0.5) * 20, life: 0.5, size: r * 1.6, sizeEnd: r * 3, color: colour('#2a1238'), alpha: 0.45 })
      }
      ctx.fx.glow.emit({ x: at.x + (Math.random() - 0.5) * r, y: at.y + (Math.random() - 0.5) * r, z: at.z + (Math.random() - 0.5) * r, life: 0.3, size: r * 1.5, sizeEnd: 1, color: colour(this.tint), alpha: 0.7 })
    }
    if (this.kind === 'seed' && Math.random() < ctx.dt * 12) {
      ctx.fx.puff.emit({ ...at, vx: (Math.random() - 0.5) * 30, vy: 10, vz: (Math.random() - 0.5) * 30, life: 0.8, size: 4, color: colour('#7bd88f'), alpha: 0.9, gravity: -60 })
    }
    ctx.lights.light(at.x, at.y, at.z, this.tint, 0.5, 120)
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 12, speed: 90, color: colour(this.tint), size: 6, life: 0.3 })
  }
}

// A grenadier's shell: a stubby round tumbling through the air, smoking.
export class ShellVisual extends ShotVisual {
  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent, entity, ctx)
    this.mesh(new Mesh(new CapsuleLike(4, 7), lit('#6b6a4a', { metalness: 0.6, roughness: 0.4 })), this.body).rotation.x = Math.PI / 2
    this.mesh(new Mesh(new SphereGeometry(6, 8, 6), glowMaterial(entity.color ?? '#d4b13a', 0.4)), this.body)
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    this.body.rotation.x = ctx.t * 14
    if (Math.random() < ctx.dt * 40) ctx.fx.puff.emit({ ...at, vy: 12, life: 0.5, size: 5, sizeEnd: 12, color: colour('#9a948a'), alpha: 0.4 })
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 10, speed: 110, color: colour('#ffd36a'), colorEnd: colour('#d1300c'), size: 7, life: 0.25 })
  }
}

// A tower's shot: an orb of its team's colour, crackling.
export class TowerBoltVisual extends ShotVisual {
  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, private readonly tint: string) {
    super(parent, entity, ctx)
    this.mesh(new Mesh(new SphereGeometry(6, 12, 8), new MeshBasicMaterial({ color: '#ffffff' })), this.body)
    this.mesh(new Mesh(new SphereGeometry(14, 12, 8), glowMaterial(tint, 0.6)), this.body)
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    for (let index = 0, count = Math.ceil(ctx.dt * 80); index < count; index += 1) {
      ctx.fx.glow.emit({ x: at.x + (Math.random() - 0.5) * 8, y: at.y + (Math.random() - 0.5) * 8, z: at.z + (Math.random() - 0.5) * 8, vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 60, vz: (Math.random() - 0.5) * 60, life: 0.2, size: 5, sizeEnd: 1, color: colour(this.tint), alpha: 0.9 })
    }
    ctx.lights.light(at.x, at.y, at.z, this.tint, 1, 160)
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 16, speed: 140, color: colour(this.tint), size: 8, life: 0.3 })
  }
}

// ---------------------------------------------------------------------------------------------- the Cursebearer

// Hex: a curse sigil, a ring with a star in it, spinning as it flies, trailing violet smoke.
export class HexVisual extends ShotVisual {
  private readonly sigil = new Group()

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent, entity, ctx)
    const r = entity.radius
    this.body.add(this.sigil)
    this.mesh(new Mesh(new TorusGeometry(r * 1.2, 1.6, 6, 24), glowMaterial('#8a62bf', 0.8)), this.sigil)
    this.mesh(new Mesh(starGeometry(r * 1.1, r * 0.45, 5, 1.2), glowMaterial('#6a3d9a', 0.75)), this.sigil)
    this.mesh(new Mesh(new SphereGeometry(r * 0.5, 10, 8), new MeshBasicMaterial({ color: '#1a0b24' })), this.body)
    this.mesh(new Mesh(new SphereGeometry(r * 2.2, 12, 8), glowMaterial('#6a2fb0', 0.35)), this.body)
  }

  protected fly(entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    this.sigil.rotation.z = ctx.t * 9
    for (let index = 0, count = Math.ceil(ctx.dt * 90); index < count; index += 1) {
      ctx.fx.puff.emit({ ...at, vx: -entity.velocity.x * 0.05 + (Math.random() - 0.5) * 20, vy: 8, vz: -entity.velocity.y * 0.05 + (Math.random() - 0.5) * 20, life: 0.6, size: 10, sizeEnd: 22, color: colour('#2e1240'), alpha: 0.5 })
      ctx.fx.glow.emit({ x: at.x + (Math.random() - 0.5) * 12, y: at.y + (Math.random() - 0.5) * 12, z: at.z + (Math.random() - 0.5) * 12, life: 0.35, size: 6, sizeEnd: 1, color: colour('#8a62bf'), alpha: 0.7 })
    }
    ctx.lights.light(at.x, at.y, at.z, '#6a3d9a', 0.9, 180)
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 26, speed: 170, color: colour('#d6b8ff'), colorEnd: colour('#6a2fb0'), size: 9, life: 0.4 })
    burst(ctx, at, { count: 10, speed: 50, color: colour('#24102f'), size: 18, life: 0.7, puff: true, alpha: 0.5 })
  }
}

// Miasma: a creeping fog of curse, violet and green, over a darkened circle with runes turning at its edge, with wisps rising.
export class MiasmaVisual extends Visual {
  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    if (gone > 0.6) return false
    const fade = Math.min(1, this.age(ctx) / 0.3) * (1 - gone / 0.6)
    if (entity) this.group.position.set(entity.position.x, 0, entity.position.y)
    const { x, z } = this.group.position
    const r = entity?.radius ?? 150
    // A pall over the ground with no edge to it: dark at the heart, fading out to nothing.
    ctx.decals.softDisc(x, z, r * 1.08, '#24102f', 0.5 * fade, 0.55)
    ctx.glowDecals.softDisc(x, z, r * 0.8, '#3a1f52', 0.18 * fade, 0.7)
    for (let index = 0, count = Math.ceil(ctx.dt * 110 * fade); index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.sqrt(Math.random()) * r * 1.05
      const green = Math.random() < 0.35
      ctx.fx.puff.emit({ x: x + Math.cos(angle) * distance, y: 4, z: z + Math.sin(angle) * distance, vx: Math.cos(angle + 1.6) * 20, vy: 10 + Math.random() * 18, vz: Math.sin(angle + 1.6) * 20, life: 1.6, size: 22, sizeEnd: 52, color: colour(green ? '#5a8a3a' : '#5a2a7a'), alpha: 0.5, fadeIn: 0.3 })
    }
    if (Math.random() < ctx.dt * 14 * fade) {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.random() * r
      ctx.fx.glow.emit({ x: x + Math.cos(angle) * distance, y: 6, z: z + Math.sin(angle) * distance, vy: 30, life: 1.1, size: 6, sizeEnd: 1, color: colour('#c99bff'), alpha: 0.9, fadeIn: 0.2 })
    }
    return true
  }
}

// ---------------------------------------------------------------------------------------------- the Archer

// Snare's canister, lobbed, tumbling and trailing green.
export class CanisterVisual extends ShotVisual {
  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, private readonly tint: string, private readonly kind: 'snare' | 'flash') {
    super(parent, entity, ctx, 90)
    this.mesh(new Mesh(new CylinderGeometry(5, 5, 12, 10), lit(kind === 'flash' ? '#d9d6c6' : '#3d5a32', { metalness: 0.5, roughness: 0.4 })), this.body)
    this.mesh(new Mesh(new CylinderGeometry(5.4, 5.4, 2, 10), lit(tint, { emissive: tint, emissiveIntensity: 1 })), this.body)
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    this.body.rotation.set(ctx.t * 11, 0, ctx.t * 7)
    if (Math.random() < ctx.dt * 50) ctx.fx.glow.emit({ ...at, life: 0.3, size: 5, sizeEnd: 1, color: colour(this.tint), alpha: 0.8 })
    if (this.kind === 'flash' && Math.random() < ctx.dt * 25) ctx.fx.glow.emit({ ...at, vx: (Math.random() - 0.5) * 80, vy: 40, vz: (Math.random() - 0.5) * 80, life: 0.3, size: 3, color: colour('#ffffff'), alpha: 1, gravity: -200 })
  }
}

// Snare's trap: a steel trap of jaws open on the ground in a ring of thorny vines, glowing green while it waits.
export class TrapVisual extends Visual {
  private readonly jaws: Group[] = []
  private readonly radius: number

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.radius = entity.radius
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const steel = lit('#9aa3ad', { metalness: 0.85, roughness: 0.35 })
    this.mesh(new Mesh(new TorusGeometry(16, 2.2, 6, 20), steel)).rotation.x = Math.PI / 2
    for (const side of [-1, 1]) {
      const jaw = new Group()
      this.group.add(jaw)
      jaw.position.z = side * 2
      const teeth = this.mesh(new Mesh(new TorusGeometry(15, 1.6, 4, 16, Math.PI), steel), jaw)
      teeth.rotation.y = side > 0 ? 0 : Math.PI
      for (let index = 0; index < 6; index += 1) {
        const turn = (index + 0.5) / 6 * Math.PI
        const tooth = this.mesh(new Mesh(new ConeGeometry(1.4, 5, 4), steel), jaw)
        tooth.position.set(Math.cos(turn) * 15, 2.5, side * Math.sin(turn) * 15)
      }
      this.jaws.push(jaw)
    }
    const vine = lit('#3d7a2a', { roughness: 0.8 })
    for (let index = 0; index < 10; index += 1) {
      const turn = index / 10 * Math.PI * 2
      const thorn = this.mesh(new Mesh(new ConeGeometry(2.5, 12, 4), vine))
      thorn.position.set(Math.cos(turn) * this.radius * 0.85, 4, Math.sin(turn) * this.radius * 0.85)
      thorn.rotation.set(Math.sin(turn) * 0.6, 0, -Math.cos(turn) * 0.6)
    }
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    if (gone > 0.35) return false
    const open = 1 - ease(gone / 0.25)
    this.jaws.forEach((jaw, index) => {
      jaw.rotation.x = (index ? 1 : -1) * (0.15 + 1.2 * open)
    })
    this.group.scale.setScalar(Math.min(1, this.age(ctx) / 0.15))
    const { x, z } = this.group.position
    const pulse = 0.5 + Math.sin(ctx.t * 5) * 0.2
    ctx.decals.disc(x, z, this.radius, '#1f3b18', 0.3 * open)
    ctx.glowDecals.circle(x, z, this.radius, 2.5, '#6dd39b', pulse * open)
    if (!entity && gone < ctx.dt * 1.5) burst(ctx, { x, y: 8, z }, { count: 18, speed: 120, color: colour('#cfe8d0'), size: 4, life: 0.3 })
    return true
  }
}

// ---------------------------------------------------------------------------------------------- the Swordsman

// Slash: a golden blade of light that sweeps out along the line, then leaves a trail of embers on the ground, shimmering, that
// slows enemies and speeds allies while it lasts.
export class SlashTrailVisual extends Visual {
  private readonly wave: Mesh<BoxGeometry, MeshBasicMaterial>
  private readonly halfLength: number
  private readonly halfWidth: number

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.halfLength = entity.box?.halfLength ?? 175
    this.halfWidth = entity.box?.halfWidth ?? 30
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const facing = entity.facing ?? { x: 1, y: 0 }
    this.group.rotation.y = yawToward(facing.x, facing.y)
    this.wave = this.mesh(new Mesh(new BoxGeometry(this.halfWidth * 2.2, 46, 8), glowMaterial('#ffe08a', 0.9)))
    this.wave.position.y = 23
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    if (gone > 0.5) return false
    const age = this.age(ctx)
    const sweep = easeOut(age / 0.18)
    this.wave.position.z = lerp(-this.halfLength, this.halfLength, sweep)
    this.wave.material.opacity = 0.9 * (1 - ease((age - 0.12) / 0.15))
    this.wave.visible = age < 0.3
    const fade = (1 - ease(((entity?.progress ?? 1) - 0.8) / 0.2)) * (1 - gone / 0.5)
    const { x, z } = this.group.position
    const yaw = this.group.rotation.y
    const ahead = { x: Math.sin(yaw), y: Math.cos(yaw) }
    const reached = (sweep * 2 - 1) * this.halfLength
    const middle = { x: x + ahead.x * (reached - this.halfLength) / 2, y: z + ahead.y * (reached - this.halfLength) / 2 }
    const length = (reached + this.halfLength) / 2
    ctx.decals.box(middle, ahead, length, this.halfWidth, '#3a1a06', 0.3 * fade)
    ctx.glowDecals.box(middle, ahead, length, this.halfWidth * 0.75, '#ff8a3d', (0.25 + Math.sin(ctx.t * 9) * 0.06) * fade)
    if (Math.random() < ctx.dt * 50 * fade) {
      const along = (Math.random() * 2 - 1) * this.halfLength * sweep
      const across = (Math.random() * 2 - 1) * this.halfWidth * 0.8
      ctx.fx.glow.emit({ x: x + ahead.x * along + ahead.y * across, y: 3, z: z + ahead.y * along - ahead.x * across, vy: 30 + Math.random() * 30, life: 0.7, size: 6, sizeEnd: 1, color: colour('#ffd36a'), colorEnd: colour('#ff5a14'), alpha: 0.9 })
    }
    if (age < 0.2) ctx.lights.light(x + ahead.x * this.wave.position.z, 30, z + ahead.y * this.wave.position.z, '#ffd36a', 3, 260)
    return true
  }
}

// Radiance: a nova of holy light: a pillar of light, a golden ring rolling out to the edge, and sparks thrown up.
export class NovaVisual extends Visual {
  private readonly pillar: Mesh<CylinderGeometry, MeshBasicMaterial>
  private readonly ring: Mesh<RingGeometry, MeshBasicMaterial>
  private readonly radius: number
  private readonly tint: string

  constructor(parent: Group, entity: RenderedEntity, tint: string, private readonly leaves = false) {
    super(parent)
    this.radius = entity.radius
    this.tint = tint
    this.group.position.set(entity.position.x, 0, entity.position.y)
    this.pillar = this.mesh(new Mesh(new CylinderGeometry(30, 42, 260, 20, 1, true), glowMaterial(tint, 0.5)))
    this.pillar.position.y = 130
    this.ring = this.mesh(new Mesh(new RingGeometry(0.85, 1, 64), glowMaterial(tint, 0.9)))
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 3
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    const { x, z } = this.group.position
    if (age < ctx.dt * 1.5) {
      burst(ctx, { x, y: 30, z }, { count: 50, speed: this.radius * 1.6, color: colour('#ffffff'), colorEnd: colour(this.tint), size: 8, life: 0.6, up: 0.5 })
      if (this.leaves) {
        for (let index = 0; index < 30; index += 1) {
          const angle = Math.random() * Math.PI * 2
          ctx.fx.puff.emit({ x, y: 20, z, vx: Math.cos(angle) * this.radius * 1.4, vy: 60 + Math.random() * 60, vz: Math.sin(angle) * this.radius * 1.4, life: 1, size: 5, color: colour(Math.random() < 0.5 ? '#7bd88f' : '#c8f0a0'), alpha: 0.95, gravity: -120, drag: 2 })
        }
      }
    }
    const roll = easeOut(age / 0.35)
    this.ring.scale.setScalar(Math.max(1, this.radius * roll))
    this.ring.material.opacity = 0.9 * (1 - roll)
    this.pillar.scale.set(1 - roll * 0.5, 1, 1 - roll * 0.5)
    this.pillar.material.opacity = 0.5 * (1 - ease(age / 0.5))
    ctx.glowDecals.disc(x, z, this.radius, this.tint, 0.3 * (1 - ease(age / 0.5)))
    if (age < 0.5) ctx.lights.light(x, 60, z, this.tint, 6 * (1 - age / 0.5), 420)
    return age < 0.8
  }
}

// ---------------------------------------------------------------------------------------------- the Soldier

// Bolt: a slug of energy, long and orange, crackling with sparks.
export class EnergySlugVisual extends ShotVisual {
  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent, entity, ctx)
    const core = this.mesh(new Mesh(new CylinderGeometry(4, 4, 26, 8), new MeshBasicMaterial({ color: '#fff2c8' })), this.body)
    core.rotation.x = Math.PI / 2
    const halo = this.mesh(new Mesh(new CylinderGeometry(10, 6, 44, 10), glowMaterial('#ffb347', 0.55)), this.body)
    halo.rotation.x = Math.PI / 2
    halo.position.z = -6
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    for (let index = 0, count = Math.ceil(ctx.dt * 90); index < count; index += 1) {
      ctx.fx.glow.emit({ ...at, vx: (Math.random() - 0.5) * 140, vy: (Math.random() - 0.5) * 140, vz: (Math.random() - 0.5) * 140, life: 0.12, size: 3, color: colour('#ffe08a'), alpha: 1 })
      ctx.fx.glow.emit({ ...at, life: 0.25, size: 12, sizeEnd: 3, color: colour('#ff8a2a'), alpha: 0.6 })
    }
    ctx.lights.light(at.x, at.y, at.z, '#ffb347', 1.5, 200)
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 20, speed: 160, color: colour('#ffe08a'), colorEnd: colour('#ff6a1f'), size: 6, life: 0.3 })
  }
}

// The medic bot: a little drone hovering by the Soldier, its rotor spinning and a red cross on it, sending a beam of green
// healing to its owner with each pulse.
export class MedicBotVisual extends Visual {
  private readonly rotor = new Group()
  private readonly drone = new Group()
  private lastPulse = 0

  constructor(parent: Group) {
    super(parent)
    this.group.add(this.drone)
    this.mesh(new Mesh(new SphereGeometry(9, 14, 10), lit('#e8eef2', { metalness: 0.4, roughness: 0.3 })), this.drone)
    this.mesh(new Mesh(new BoxGeometry(10, 3, 3), lit('#e5534b', { emissive: '#e5534b', emissiveIntensity: 0.6 })), this.drone).position.set(0, 2, 8.5)
    this.mesh(new Mesh(new BoxGeometry(3, 10, 3), lit('#e5534b', { emissive: '#e5534b', emissiveIntensity: 0.6 })), this.drone).position.set(0, 2, 8.6)
    this.mesh(new Mesh(new SphereGeometry(3, 8, 6), lit('#7be0c3', { emissive: '#7be0c3', emissiveIntensity: 2 })), this.drone).position.set(0, -8, 0)
    this.drone.add(this.rotor)
    this.rotor.position.y = 11
    this.mesh(new Mesh(new CylinderGeometry(1, 1, 4, 6), lit('#3a3f47')), this.rotor)
    for (const turn of [0, Math.PI / 2]) {
      const blade = this.mesh(new Mesh(new BoxGeometry(26, 0.8, 3), lit('#3a3f47')), this.rotor)
      blade.position.y = 2
      blade.rotation.y = turn
    }
    this.mesh(new Mesh(new SphereGeometry(16, 12, 8), glowMaterial('#7be0c3', 0.15)), this.drone)
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) {
      burst(ctx, this.drone.getWorldPosition(new Vector3()), { count: 20, speed: 90, color: colour('#7be0c3'), size: 5, life: 0.4 })
      return false
    }
    this.group.position.set(entity.position.x, 64 + Math.sin(ctx.t * 3) * 4, entity.position.y)
    this.rotor.rotation.y += ctx.dt * 40
    this.drone.rotation.z = Math.sin(ctx.t * 2.3) * 0.12
    const owner = ctx.characters.get(entity.ownerId)
    if (owner && ctx.t - this.lastPulse > 0.5) {
      this.lastPulse = ctx.t
      const from = this.group.position
      const to = { x: owner.position.x, y: 36, z: owner.position.y }
      for (let index = 0; index < 10; index += 1) {
        const k = index / 10
        ctx.fx.glow.emit({ x: lerp(from.x, to.x, k), y: lerp(from.y - 8, to.y, k), z: lerp(from.z, to.z, k), life: 0.35, size: 6, sizeEnd: 2, color: colour('#7be0c3'), alpha: 0.9 })
      }
      burst(ctx, to, { count: 6, speed: 40, color: colour('#a8ffd8'), size: 4, life: 0.4, up: 1.2 })
    }
    ctx.lights.light(this.group.position.x, this.group.position.y, this.group.position.z, '#7be0c3', 0.4, 120)
    return true
  }
}

// ---------------------------------------------------------------------------------------------- the Grenadier

// A grenade: round, with a pin and a lever, lobbed high and tumbling, smoking.
export class GrenadeVisual extends ShotVisual {
  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent, entity, ctx, 110)
    this.mesh(new Mesh(jitter(new DodecahedronGeometry(7, 1), 0.06, 41), lit('#5e6b3a', { roughness: 0.5, metalness: 0.4 })), this.body)
    this.mesh(new Mesh(new CylinderGeometry(2.5, 2.5, 4, 8), lit('#9aa3ad', { metalness: 0.8 })), this.body).position.y = 7
    this.mesh(new Mesh(new TorusGeometry(2.4, 0.6, 4, 10), lit('#c9b27a', { metalness: 0.8 })), this.body).position.set(3, 9, 0)
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    this.body.rotation.set(ctx.t * 9, ctx.t * 5, 0)
    if (Math.random() < ctx.dt * 30) ctx.fx.puff.emit({ ...at, vy: 8, life: 0.6, size: 5, sizeEnd: 12, color: colour('#8a857a'), alpha: 0.4 })
    if (Math.random() < ctx.dt * 20) ctx.fx.glow.emit({ ...at, life: 0.15, size: 4, color: colour('#ffd36a'), alpha: 1 })
  }
}

// The grenade's blast: a burst of fire and dirt, a shock ring, smoke, and a scorch on the ground.
export class ExplosionVisual extends Visual {
  private readonly ball: Mesh<SphereGeometry, MeshBasicMaterial>
  private readonly ring: Mesh<RingGeometry, MeshBasicMaterial>
  private readonly at: { x: number; y: number }
  private readonly radius: number

  constructor(parent: Group, entity: RenderedEntity, private readonly kind: 'grenade' | 'flash' | 'impact') {
    super(parent)
    this.at = { ...entity.position }
    this.radius = entity.radius
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const tint = kind === 'flash' ? '#ffffff' : kind === 'impact' ? '#d9a35c' : '#ffa040'
    this.ball = this.mesh(new Mesh(new SphereGeometry(1, 20, 14), glowMaterial(tint, 0.9)))
    this.ring = this.mesh(new Mesh(new RingGeometry(0.8, 1, 64), glowMaterial(kind === 'flash' ? '#ffffff' : '#ffd08a', 0.9)))
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 3
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    const { x, y } = this.at
    const r = this.radius
    if (age < ctx.dt * 1.5) {
      if (this.kind === 'flash') {
        burst(ctx, { x, y: 25, z: y }, { count: 50, speed: 260, color: colour('#ffffff'), colorEnd: colour('#fff6c8'), size: 8, life: 0.35, up: 0.5 })
        burst(ctx, { x, y: 15, z: y }, { count: 14, speed: 60, color: colour('#e8e4da'), size: 22, life: 1, puff: true, alpha: 0.35 })
      } else {
        const fire = this.kind === 'grenade'
        if (fire) burst(ctx, { x, y: 20, z: y }, { count: 45, speed: 220, color: colour('#ffe08a'), colorEnd: colour('#c42a08'), size: 18, life: 0.45, up: 0.6 })
        burst(ctx, { x, y: 10, z: y }, { count: 26, speed: 200, color: colour('#6b5a44'), size: 5, life: 0.9, up: 1.6, gravity: -600, puff: true, alpha: 1 })
        burst(ctx, { x, y: 15, z: y }, { count: 18, speed: 70, color: colour(fire ? '#3a3330' : '#b9a88c'), size: 26, life: 1.3, puff: true, alpha: 0.45 })
      }
    }
    const swell = easeOut(age / 0.18)
    const fade = Math.max(0, 1 - age / (this.kind === 'flash' ? 0.3 : 0.45))
    this.ball.scale.setScalar(r * (this.kind === 'flash' ? 1.3 : 0.85) * swell + 1)
    this.ball.position.y = r * 0.3
    this.ball.material.opacity = 0.9 * fade * fade
    this.ring.scale.setScalar(r * 1.5 * easeOut(age / 0.4) + 1)
    this.ring.material.opacity = 0.85 * Math.max(0, 1 - age / 0.4)
    this.ball.visible = this.ring.visible = age < 0.6
    const cool = Math.max(0, 1 - age / 2.5)
    if (this.kind !== 'flash') ctx.decals.disc(x, y, r * 0.95, this.kind === 'impact' ? '#2a1f14' : '#160d08', 0.5 * cool)
    if (age < 0.5) ctx.lights.light(x, 50, y, this.kind === 'flash' ? '#ffffff' : '#ff9a4a', (this.kind === 'flash' ? 16 : 7) * (1 - age / 0.5) ** 2, 420)
    return age < 2.5
  }
}

// The molotov: a bottle with a burning rag, lobbed end over end, dripping fire.
export class MolotovVisual extends ShotVisual {
  private rag: Group | undefined

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent, entity, ctx, 100)
    const glass = new MeshStandardMaterial({ color: '#4f8a5a', roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.8 })
    this.mesh(new Mesh(new CylinderGeometry(5, 5, 12, 10), glass), this.body)
    this.mesh(new Mesh(new CylinderGeometry(2, 4.5, 6, 10), glass), this.body).position.y = 9
    const rag = new Group()
    rag.position.y = 14
    this.body.add(rag)
    this.mesh(new Mesh(new ConeGeometry(2.5, 6, 6), lit('#c9b27a')), rag)
    this.rag = rag
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    this.body.rotation.set(ctx.t * 10, 0, 0)
    const flame = this.rag?.getWorldPosition(new Vector3()) ?? at
    for (let index = 0, count = Math.ceil(ctx.dt * 90); index < count; index += 1) {
      ctx.fx.glow.emit({ x: flame.x, y: flame.y, z: flame.z, vy: 30, life: 0.3, size: 10, sizeEnd: 2, color: colour('#ffd36a'), colorEnd: colour('#d1300c'), alpha: 0.9 })
    }
    if (Math.random() < ctx.dt * 20) ctx.fx.puff.emit({ ...flame, vy: 20, life: 0.6, size: 6, sizeEnd: 14, color: colour('#3a3330'), alpha: 0.35 })
    ctx.lights.light(at.x, at.y, at.z, '#ff7a2f', 1, 150)
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 16, speed: 140, color: colour('#cfe8d8'), size: 3, life: 0.4, up: 1, gravity: -500, puff: true })
  }
}

// The molotov's fire: a pool of flame on the ground, its tongues licking up, glass glinting in it, and black smoke rising.
export class FirePoolVisual extends Visual {
  private readonly glowDisc: Mesh<CircleGeometry, MeshBasicMaterial>
  private readonly sheets: Array<Mesh<LatheGeometry, ShaderMaterial>> = []
  private readonly radius: number

  constructor(parent: Group, entity: RenderedEntity, embers: Texture) {
    super(parent)
    this.radius = entity.radius
    this.group.position.set(entity.position.x, 1.2, entity.position.y)
    const material = glowMaterial('#ff6a1f', 0.8)
    material.map = embers
    this.glowDisc = this.mesh(new Mesh(new CircleGeometry(this.radius * 1.1, 32), material))
    this.glowDisc.rotation.x = -Math.PI / 2
    // A ring of fire round the edge, and a lower one inside.
    for (const [share, height] of [[0.95, 46], [0.55, 34]]) {
      const profile = [new ThreeVector2(this.radius * share, 0), new ThreeVector2(this.radius * share * 0.97, height)]
      this.sheets.push(this.mesh(new Mesh(new LatheGeometry(profile, 40), fireMaterial({ repeat: 14, speed: 2.6 }))))
    }
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    if (gone > 0.5) return false
    const fade = Math.min(1, this.age(ctx) / 0.2) * (1 - ease(((entity?.progress ?? 1) - 0.85) / 0.15)) * (1 - gone / 0.5)
    this.glowDisc.material.opacity = (0.6 + Math.sin(ctx.t * 11) * 0.1) * fade
    for (const sheet of this.sheets) {
      sheet.material.uniforms.uTime.value = ctx.t
      sheet.material.uniforms.uAlpha.value = fade
    }
    const { x, z } = this.group.position
    ctx.decals.disc(x, z, this.radius, '#140b07', 0.55 * fade)
    for (let index = 0, count = Math.ceil(ctx.dt * 40 * fade); index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.sqrt(Math.random()) * this.radius * 0.9
      ctx.fx.glow.emit({ x: x + Math.cos(angle) * distance, y: 3, z: z + Math.sin(angle) * distance, vy: 60 + Math.random() * 40, life: 0.5, size: 18, sizeEnd: 4, color: colour('#ffc35a'), colorEnd: colour('#d1300c'), alpha: 0.8 })
    }
    if (Math.random() < ctx.dt * 8 * fade) ctx.fx.puff.emit({ x, y: 30, z, vy: 40, vx: (Math.random() - 0.5) * 20, vz: (Math.random() - 0.5) * 20, life: 2, size: 26, sizeEnd: 70, color: colour('#221d1b'), alpha: 0.35, fadeIn: 0.2 })
    ctx.lights.light(x, 30, z, '#ff6a20', 2.6 * fade, 320)
    return true
  }
}

// ---------------------------------------------------------------------------------------------- the Trinketmaster

// The stick, thrown, spinning end over end with trinkets clattering, or called back to its owner, trailing teal.
export class StickVisual extends ShotVisual {
  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent, entity, ctx)
    this.body.add(stickModel(this.meshFn()))
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    this.body.rotation.x = ctx.t * 18
    for (let index = 0, count = Math.ceil(ctx.dt * 60); index < count; index += 1) {
      ctx.fx.glow.emit({ x: at.x + (Math.random() - 0.5) * 30, y: at.y, z: at.z + (Math.random() - 0.5) * 30, life: 0.3, size: 7, sizeEnd: 1, color: colour('#3fc8c0'), alpha: 0.7 })
    }
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 12, speed: 100, color: colour('#7fe0d0'), size: 5, life: 0.3 })
  }

  private meshFn(): (mesh: Mesh) => Mesh {
    return (mesh) => this.mesh(mesh, this.body)
  }
}

// The stick, stuck in the ground where it landed, its trinkets swinging, with a ring of teal pulsing round it until it is picked up.
export class PlantedStickVisual extends Visual {
  private readonly stick: Group

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.group.position.set(entity.position.x, 0, entity.position.y)
    this.stick = stickModel((mesh) => this.mesh(mesh, this.group))
    this.stick.rotation.set(0.25, Math.random() * Math.PI * 2, 0.15)
    this.stick.position.y = 26
    this.stick.rotation.order = 'YXZ'
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) {
      burst(ctx, { x: this.group.position.x, y: 20, z: this.group.position.z }, { count: 14, speed: 90, color: colour('#7fe0d0'), size: 5, life: 0.3 })
      return false
    }
    const { x, z } = this.group.position
    const pulse = (ctx.t * 0.8) % 1
    ctx.glowDecals.circle(x, z, 14 + pulse * 26, 2.5, '#3fc8c0', 0.7 * (1 - pulse))
    ctx.decals.disc(x, z, 12, '#2a1f14', 0.4)
    if (Math.random() < ctx.dt * 4) ctx.fx.glow.emit({ x, y: 50, z, vy: 16, life: 1, size: 4, sizeEnd: 1, color: colour('#3fc8c0'), alpha: 0.8 })
    return true
  }
}

function stickModel(add: (mesh: Mesh) => Mesh): Group {
  const group = new Group()
  const holder = add(new Mesh(new CylinderGeometry(1.4, 1.8, 56, 6), lit('#7a5634', { roughness: 0.9 })))
  group.add(holder)
  for (let index = 0; index < 4; index += 1) {
    const charm = add(new Mesh(new OctahedronGeometry(2.2, 0), lit(index % 2 ? '#3fc8c0' : '#c94a6b', { emissive: index % 2 ? '#3fc8c0' : '#c94a6b', emissiveIntensity: 0.6 })))
    charm.position.set((index - 1.5) * 2.2, 20 - (index % 2) * 3, 2)
    group.add(charm)
  }
  return group
}

// Warp: a column of teal light where the Trinketmaster leaves and where it arrives, with motes swirling up it.
export class WarpVisual extends Visual {
  private readonly column: Mesh<CylinderGeometry, MeshBasicMaterial>
  private readonly radius: number

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.radius = entity.radius
    this.group.position.set(entity.position.x, 0, entity.position.y)
    this.column = this.mesh(new Mesh(new CylinderGeometry(this.radius * 0.7, this.radius, 160, 20, 1, true), glowMaterial('#7fe0d0', 0.6)))
    this.column.position.y = 80
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    const { x, z } = this.group.position
    if (age < ctx.dt * 1.5) {
      for (let index = 0; index < 40; index += 1) {
        const angle = Math.random() * Math.PI * 2
        ctx.fx.glow.emit({ x: x + Math.cos(angle) * this.radius, y: Math.random() * 30, z: z + Math.sin(angle) * this.radius, vx: Math.cos(angle + 1.6) * 80, vy: 80 + Math.random() * 120, vz: Math.sin(angle + 1.6) * 80, life: 0.7, size: 6, sizeEnd: 1, color: colour('#bff6ee'), alpha: 0.9 })
      }
    }
    const fade = 1 - ease(age / 0.5)
    this.column.material.opacity = 0.6 * fade
    this.column.scale.set(1 - age, 1, 1 - age)
    ctx.glowDecals.disc(x, z, this.radius * 1.3, '#3fc8c0', 0.5 * fade)
    if (age < 0.4) ctx.lights.light(x, 40, z, '#7fe0d0', 4 * fade, 260)
    return age < 0.55
  }
}

// ---------------------------------------------------------------------------------------------- the Ninja

// Shuriken: a four-pointed star spinning flat as it flies, silver, or glowing pink when a shadow stack sharpens it.
export class ShurikenVisual extends ShotVisual {
  private readonly star = new Group()

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, private readonly enhanced: boolean) {
    super(parent, entity, ctx)
    this.body.add(this.star)
    const material = enhanced ? lit('#ff6bd6', { emissive: '#ff6bd6', emissiveIntensity: 1.2, metalness: 0.6 }) : lit('#c9ccd6', { metalness: 0.9, roughness: 0.25 })
    const star = this.mesh(new Mesh(starGeometry(entity.radius * 1.3, entity.radius * 0.35, 4, 2), material), this.star)
    star.rotation.x = -Math.PI / 2
    if (enhanced) this.mesh(new Mesh(new SphereGeometry(entity.radius * 2, 12, 8), glowMaterial('#ff6bd6', 0.4)), this.star)
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    this.star.rotation.y = ctx.t * 30
    const tint = this.enhanced ? '#ff6bd6' : '#c9c9ff'
    for (let index = 0, count = Math.ceil(ctx.dt * 60); index < count; index += 1) ctx.fx.glow.emit({ ...at, life: 0.18, size: 8, sizeEnd: 1, color: colour(tint), alpha: 0.6 })
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 10, speed: 120, color: colour(this.enhanced ? '#ff6bd6' : '#e8e8ff'), size: 4, life: 0.25 })
  }
}

// The Ninja's shadow: a dark copy of a figure, see-through, standing where the dash left it, smoke curling off it, and a violet
// ring under it, until it is dashed back to.
export class ShadowVisual extends Visual {
  private readonly figure = new Group()
  private readonly materials: MeshBasicMaterial[] = []

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.group.position.set(entity.position.x, 0, entity.position.y)
    this.group.add(this.figure)
    const material = (): MeshBasicMaterial => {
      const made = new MeshBasicMaterial({ color: '#2a1a4a', transparent: true, opacity: 0.55, depthWrite: false })
      this.materials.push(made)
      return made
    }
    this.mesh(new Mesh(new CylinderGeometry(9, 7, 30, 10), material()), this.figure).position.y = 44
    this.mesh(new Mesh(new SphereGeometry(7, 10, 8), material()), this.figure).position.y = 66
    for (const side of [-1, 1]) {
      this.mesh(new Mesh(new CylinderGeometry(3, 2.5, 30, 6), material()), this.figure).position.set(side * 4, 15, 0)
      this.mesh(new Mesh(new CylinderGeometry(2.5, 2, 26, 6), material()), this.figure).position.set(side * 12, 44, 0)
    }
    for (const side of [-1, 1]) this.mesh(new Mesh(new SphereGeometry(1.4, 6, 4), new MeshBasicMaterial({ color: '#c9b8ff' })), this.figure).position.set(side * 2.6, 67, 6)
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    if (gone > 0.3) return false
    const fade = Math.min(1, this.age(ctx) / 0.2) * (1 - gone / 0.3)
    for (const material of this.materials) material.opacity = (0.45 + Math.sin(ctx.t * 6) * 0.08) * fade
    this.figure.position.y = Math.sin(ctx.t * 2) * 1.5
    const owner = entity ? ctx.characters.get(entity.ownerId) : undefined
    if (owner) this.figure.rotation.y = yawToward(owner.position.x - this.group.position.x, owner.position.y - this.group.position.z) + Math.PI
    const { x, z } = this.group.position
    ctx.glowDecals.circle(x, z, 18, 2.5, '#7a5cff', 0.7 * fade)
    ctx.decals.disc(x, z, 18, '#140c24', 0.4 * fade)
    if (Math.random() < ctx.dt * 30 * fade) ctx.fx.puff.emit({ x: x + (Math.random() - 0.5) * 16, y: Math.random() * 60, z: z + (Math.random() - 0.5) * 16, vy: 18, life: 0.9, size: 9, sizeEnd: 20, color: colour('#1e1430'), alpha: 0.4 })
    return true
  }
}

// ---------------------------------------------------------------------------------------------- the Hammer

// Slam: the ground split along the line, rocks bursting up out of the crack and dust rolling off it, the crack left behind
// for a moment.
export class GroundCrackVisual extends Visual {
  private readonly halfLength: number
  private readonly halfWidth: number
  private readonly seed = Math.random() * 1000

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.halfLength = entity.box?.halfLength ?? 100
    this.halfWidth = entity.box?.halfWidth ?? 40
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const facing = entity.facing ?? { x: 1, y: 0 }
    this.group.rotation.y = yawToward(facing.x, facing.y)
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    const { x, z } = this.group.position
    const yaw = this.group.rotation.y
    const ahead = { x: Math.sin(yaw), y: Math.cos(yaw) }
    const across = { x: ahead.y, y: -ahead.x }
    const run = easeOut(age / 0.25)
    if (age < 0.25) {
      for (let index = 0, count = Math.ceil(ctx.dt * 260); index < count; index += 1) {
        const along = (Math.random() * run * 2 - 1) * this.halfLength
        const side = (Math.random() * 2 - 1) * this.halfWidth * 0.6
        const at = { x: x + ahead.x * along + across.x * side, y: 4, z: z + ahead.y * along + across.y * side }
        ctx.fx.puff.emit({ ...at, vx: across.x * side * 3, vy: 150 + Math.random() * 200, vz: across.y * side * 3, life: 0.9, size: 5 + Math.random() * 5, color: colour('#6b5a44'), alpha: 1, gravity: -700 })
        if (Math.random() < 0.3) ctx.fx.puff.emit({ ...at, vy: 30, life: 1.2, size: 22, sizeEnd: 50, color: colour('#b9a88c'), alpha: 0.35, drag: 2 })
      }
    }
    // The crack: a jagged dark line along the middle, and a glow of the Hammer's colour in it at first.
    const cool = Math.max(0, 1 - age / 2.2)
    let previous = { x: x - ahead.x * this.halfLength, y: z - ahead.y * this.halfLength }
    const steps = 14
    for (let index = 1; index <= steps; index += 1) {
      const along = -this.halfLength + (index / steps) * this.halfLength * 2 * run
      const wobble = Math.sin(index * 2.3 + this.seed) * this.halfWidth * 0.25
      const next = { x: x + ahead.x * along + across.x * wobble, y: z + ahead.y * along + across.y * wobble }
      ctx.decals.line(previous, next, 8, '#1a120a', 0.7 * cool)
      ctx.glowDecals.line(previous, next, 4, '#ff8a3c', 0.6 * Math.max(0, 1 - age / 0.6))
      previous = next
    }
    ctx.decals.box({ x, y: z }, ahead, this.halfLength * run, this.halfWidth, '#3a2a1a', 0.25 * cool)
    return age < 2.2
  }
}

// Hammer Drop: a target on the ground where the Hammer will land, red and closing in, while it leaps there in an arc.
export class LeapTargetVisual extends Visual {
  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) return false
    const { x, y } = entity.position
    const r = entity.radius
    const p = entity.progress
    ctx.decals.disc(x, y, r, '#3a0d08', 0.25)
    ctx.glowDecals.circle(x, y, r, 4, '#ff6b4a', 0.85)
    ctx.glowDecals.disc(x, y, r * ease(p), '#ff4a2a', 0.25)
    // Four arrows closing in.
    for (let index = 0; index < 4; index += 1) {
      const turn = index * Math.PI / 2 + Math.PI / 4
      const out = r * (1.35 - p * 0.35)
      const tip = { x: x + Math.cos(turn) * out * 0.8, y: y + Math.sin(turn) * out * 0.8 }
      const left = { x: x + Math.cos(turn - 0.12) * out, y: y + Math.sin(turn - 0.12) * out }
      const right = { x: x + Math.cos(turn + 0.12) * out, y: y + Math.sin(turn + 0.12) * out }
      ctx.glowDecals.quad(tip, left, right, tip, '#ffb347', 0.85)
    }
    // The Hammer, up in the air over the arc of its leap.
    const model = ctx.models.modelOf(entity.ownerId)
    if (model) {
      model.root.position.y += Math.sin(Math.PI * p) * 170
      if (Math.random() < ctx.dt * 30) ctx.fx.puff.emit({ x: model.root.position.x, y: model.root.position.y + 20, z: model.root.position.z, vy: -20, life: 0.5, size: 10, sizeEnd: 22, color: colour('#b9a88c'), alpha: 0.35 })
    }
    return true
  }
}

// ---------------------------------------------------------------------------------------------- Chain

// The hook: a barbed hook flying out, and the chain it drags behind it from Chain's hand, link by link.
export class HookVisual extends ShotVisual {
  private readonly links = new Group()
  private readonly linkMeshes: Mesh[] = []

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent, entity, ctx)
    const steel = lit('#b8c4d4', { metalness: 0.9, roughness: 0.3 })
    this.mesh(new Mesh(new ConeGeometry(4, 14, 6), steel), this.body).rotation.x = Math.PI / 2
    const barb = this.mesh(new Mesh(new TorusGeometry(8, 1.6, 4, 10, Math.PI), steel), this.body)
    barb.rotation.set(0, Math.PI / 2, Math.PI / 2)
    barb.position.z = -4
    this.group.parent?.add(this.links)
    const linkGeometry = new TorusGeometry(3, 0.9, 4, 8)
    const linkMaterial = lit('#8f99a6', { metalness: 0.9, roughness: 0.35 })
    for (let index = 0; index < 28; index += 1) {
      const link = new Mesh(linkGeometry, linkMaterial)
      this.links.add(link)
      this.linkMeshes.push(link)
    }
    // Kept, hidden, so the links' shape and paint are let go with the rest when the hook is.
    this.mesh(new Mesh(linkGeometry, linkMaterial), this.body).visible = false
  }

  protected fly(entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    const owner = ctx.models.modelOf(entity.ownerId)
    const from = owner instanceof HumanoidModel ? owner.handPoint('left') : { x: entity.origin.x, y: 40, z: entity.origin.y }
    this.linkMeshes.forEach((link, index) => {
      const k = index / (this.linkMeshes.length - 1)
      link.position.set(lerp(from.x, at.x, k), lerp(from.y, at.y, k) - Math.sin(k * Math.PI) * 6, lerp(from.z, at.z, k))
      link.rotation.set(index % 2 ? Math.PI / 2 : 0, this.group.rotation.y, 0)
    })
    if (Math.random() < ctx.dt * 30) ctx.fx.glow.emit({ ...at, life: 0.15, size: 4, color: colour('#e8f0ff'), alpha: 0.9 })
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 14, speed: 140, color: colour('#fff1c9'), size: 4, life: 0.25 })
  }

  override dispose(): void {
    this.links.removeFromParent()
    super.dispose()
  }
}

// Whirl's charge: Chain's chains spinning round it, faster as it charges, a ring of steel at the edge it will lash to, and the
// inner circle that is too close for the sweet spot.
export class WhirlVisual extends Visual {
  private readonly spinner = new Group()
  private readonly core: boolean

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.core = entity.defId === 'whirl-core-warning'
    this.group.add(this.spinner)
    if (!this.core) {
      const steel = lit('#b8c4d4', { metalness: 0.9, roughness: 0.3 })
      const linkGeometry = new TorusGeometry(3.2, 1, 4, 8)
      for (const arm of [0, Math.PI]) {
        for (let index = 0; index < 14; index += 1) {
          const link = this.mesh(new Mesh(linkGeometry.clone(), steel), this.spinner)
          const out = 20 + index * (entity.radius - 22) / 14
          link.position.set(Math.cos(arm) * out, 32, Math.sin(arm) * out)
          link.rotation.set(index % 2 ? Math.PI / 2 : 0, -arm, 0)
        }
        const weight = this.mesh(new Mesh(new OctahedronGeometry(7, 0), lit('#ff6b4a', { emissive: '#ff6b4a', emissiveIntensity: 0.8 })), this.spinner)
        weight.position.set(Math.cos(arm) * entity.radius, 32, Math.sin(arm) * entity.radius)
      }
      linkGeometry.dispose()
    }
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) return false
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const p = entity.progress
    this.spinner.rotation.y += ctx.dt * (6 + p * 16)
    const { x, y } = entity.position
    if (this.core) {
      ctx.decals.circle(x, y, entity.radius, 2, '#c9b27a', 0.5)
    } else {
      ctx.glowDecals.circle(x, y, entity.radius, 3, '#ff6b4a', 0.4 + p * 0.5)
      ctx.decals.ring(x, y, entity.radius * 0.6, entity.radius, '#3a1a14', 0.15 + p * 0.15)
      const blur = this.spinner.rotation.y
      ctx.glowDecals.ring(x, y, entity.radius - 6, entity.radius, '#e8f0ff', 0.25, blur, blur + 0.8)
      ctx.glowDecals.ring(x, y, entity.radius - 6, entity.radius, '#e8f0ff', 0.25, blur + Math.PI, blur + Math.PI + 0.8)
      if (Math.random() < ctx.dt * 20 * p) {
        const angle = Math.random() * Math.PI * 2
        ctx.fx.glow.emit({ x: x + Math.cos(angle) * entity.radius, y: 30, z: y + Math.sin(angle) * entity.radius, vx: -Math.sin(angle) * 200, vy: 40, vz: Math.cos(angle) * 200, life: 0.3, size: 4, color: colour('#fff1c9'), alpha: 1, gravity: -300 })
      }
    }
    return true
  }
}

// Whirl going off: a ring of sparks and steel lashing out to the edge, brightest at the sweet spot.
export class LashVisual extends Visual {
  private readonly radius: number
  private readonly core: boolean

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.radius = entity.radius
    this.core = entity.defId === 'whirl-core-burst'
    this.group.position.set(entity.position.x, 0, entity.position.y)
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    const { x, z } = this.group.position
    if (age < ctx.dt * 1.5 && !this.core) {
      for (let index = 0; index < 60; index += 1) {
        const angle = Math.random() * Math.PI * 2
        ctx.fx.glow.emit({ x: x + Math.cos(angle) * this.radius, y: 25, z: z + Math.sin(angle) * this.radius, vx: Math.cos(angle) * 120 - Math.sin(angle) * 160, vy: 60 + Math.random() * 80, vz: Math.sin(angle) * 120 + Math.cos(angle) * 160, life: 0.4, size: 5, color: colour('#fff1c9'), colorEnd: colour('#ff6b4a'), alpha: 1, gravity: -400 })
      }
    }
    const fade = 1 - ease(age / 0.35)
    if (this.core) ctx.glowDecals.disc(x, z, this.radius, '#fff1c9', 0.3 * fade)
    else ctx.glowDecals.ring(x, z, this.radius * 0.7, this.radius, '#ff6b4a', 0.6 * fade)
    return age < 0.4
  }
}

// ---------------------------------------------------------------------------------------------- the Cloak

// A thrown knife, spinning, trailing violet.
export class KnifeVisual extends ShotVisual {
  private readonly blade = new Group()

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent, entity, ctx)
    this.body.add(this.blade)
    this.mesh(new Mesh(new ConeGeometry(2.2, 18, 4), lit('#d8dde6', { metalness: 0.9, roughness: 0.25 })), this.blade).position.y = 6
    this.mesh(new Mesh(new BoxGeometry(6, 1.5, 2), lit('#8e6bd9')), this.blade).position.y = -3
    this.mesh(new Mesh(new CylinderGeometry(1, 1, 6, 5), lit('#2a2238')), this.blade).position.y = -7
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    this.blade.rotation.x = ctx.t * 26
    for (let index = 0, count = Math.ceil(ctx.dt * 50); index < count; index += 1) ctx.fx.glow.emit({ ...at, life: 0.2, size: 6, sizeEnd: 1, color: colour('#8e6bd9'), alpha: 0.7 })
  }
}

// ---------------------------------------------------------------------------------------------- the Sage

// Vine Bolt: a knot of thorny vine twisting as it flies, shedding leaves, with a green glow.
export class VineVisual extends ShotVisual {
  private readonly knot = new Group()

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent, entity, ctx)
    this.body.add(this.knot)
    const vine = lit('#4f9a3a', { roughness: 0.7, emissive: '#2a5a1e', emissiveIntensity: 0.4 })
    for (const turn of [0, Math.PI / 3, -Math.PI / 3]) {
      const coil = this.mesh(new Mesh(new TorusGeometry(entity.radius, 2, 6, 16), vine), this.knot)
      coil.rotation.set(turn, turn * 0.5, 0)
    }
    for (let index = 0; index < 8; index += 1) {
      const thorn = this.mesh(new Mesh(new ConeGeometry(1.5, 7, 4), lit('#c8d88a')), this.knot)
      const turn = index / 8 * Math.PI * 2
      thorn.position.set(Math.cos(turn) * entity.radius, Math.sin(turn) * entity.radius, 0)
      thorn.rotation.z = turn - Math.PI / 2
    }
    this.mesh(new Mesh(new SphereGeometry(entity.radius * 1.8, 12, 8), glowMaterial('#7bd88f', 0.35)), this.body)
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    this.knot.rotation.z = ctx.t * 10
    if (Math.random() < ctx.dt * 40) ctx.fx.puff.emit({ ...at, vx: (Math.random() - 0.5) * 40, vy: 15, vz: (Math.random() - 0.5) * 40, life: 1, size: 5, color: colour(Math.random() < 0.5 ? '#5fbf5a' : '#a8e08a'), alpha: 0.95, gravity: -80 })
    for (let index = 0, count = Math.ceil(ctx.dt * 40); index < count; index += 1) ctx.fx.glow.emit({ ...at, life: 0.3, size: 9, sizeEnd: 2, color: colour('#7bd88f'), alpha: 0.6 })
    ctx.lights.light(at.x, at.y, at.z, '#7bd88f', 0.8, 140)
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 18, speed: 100, color: colour('#7bd88f'), size: 6, life: 0.4 })
  }
}

// ---------------------------------------------------------------------------------------------- the Ent

// The warnings of Root Burst and Grove: the circle darkening, its edge glowing, and roots snaking across it.
export class SproutingVisual extends Visual {
  private readonly roots: Array<{ mesh: Mesh<TubeGeometry, MeshStandardMaterial>; delay: number }> = []
  private readonly radius: number
  private readonly tint: string

  constructor(parent: Group, entity: RenderedEntity, private readonly grove: boolean) {
    super(parent)
    this.radius = entity.radius
    this.tint = grove ? '#6fcf6f' : '#a3c45a'
    this.group.position.set(entity.position.x, 0, entity.position.y)
    // Roots snaking in from the edge of the circle toward its middle, surfacing and sinking as they go: more of each shows as the
    // warning runs out, and they meet in the middle as it goes off.
    const bark = lit('#5a3f27', { roughness: 0.95, emissive: grove ? '#1f4a1a' : '#2a3a10', emissiveIntensity: 0.4 })
    const count = grove ? 9 : 7
    for (let index = 0; index < count; index += 1) {
      const start = index / count * Math.PI * 2 + Math.random() * 0.4
      const points: Vector3[] = []
      const steps = 9
      for (let step = 0; step <= steps; step += 1) {
        const k = step / steps
        const out = this.radius * (1 - k * 0.92)
        const angle = start + Math.sin(k * Math.PI * 2.2 + index) * 0.35 + k * 0.6
        points.push(new Vector3(Math.cos(angle) * out, 1 + Math.abs(Math.sin(k * Math.PI * 3 + index)) * 5, Math.sin(angle) * out))
      }
      const geometry = new TubeGeometry(new CatmullRomCurve3(points), 48, grove ? 3.2 : 2.6, 5, false)
      const mesh = this.mesh(new Mesh(geometry, bark.clone()))
      mesh.castShadow = true
      this.roots.push({ mesh, delay: Math.random() * 0.15 })
    }
    bark.dispose()
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) return false
    const { x, y } = entity.position
    const r = entity.radius
    const p = entity.progress
    ctx.decals.softDisc(x, y, r * 1.05, '#24180e', 0.25 + p * 0.25, 0.3)
    ctx.glowDecals.circle(x, y, r, 3, this.tint, 0.55 + p * 0.3)
    ctx.glowDecals.softDisc(x, y, r * ease(p), this.tint, 0.18, 0.5)
    for (const root of this.roots) {
      const grown = ease((p - root.delay) / (1 - root.delay))
      const count = root.mesh.geometry.index?.count ?? 0
      root.mesh.geometry.setDrawRange(0, Math.floor(count * grown / 6) * 6)
    }
    if (Math.random() < ctx.dt * (20 + p * 50)) {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.sqrt(Math.random()) * r
      if (this.grove) ctx.fx.puff.emit({ x: x + Math.cos(angle) * distance, y: 60 + Math.random() * 40, z: y + Math.sin(angle) * distance, vx: (Math.random() - 0.5) * 30, vy: -20, vz: (Math.random() - 0.5) * 30, life: 1.4, size: 5, color: colour(Math.random() < 0.5 ? '#6fbf4a' : '#c8e08a'), alpha: 0.95, gravity: -20 })
      else ctx.fx.puff.emit({ x: x + Math.cos(angle) * distance, y: 3, z: y + Math.sin(angle) * distance, vy: 40 + Math.random() * 40, life: 0.6, size: 4, color: colour('#5a4430'), alpha: 1, gravity: -300 })
      ctx.fx.glow.emit({ x: x + Math.cos(angle) * distance, y: 2, z: y + Math.sin(angle) * distance, vy: 40, life: 0.6, size: 6, sizeEnd: 1, color: colour(this.tint), alpha: 0.8 })
    }
    return true
  }
}

// Root Burst: roots bursting up out of the ground all over the circle, sharp and twisting, throwing dirt, and sinking back.
export class RootsVisual extends Visual {
  private readonly spikes: Array<{ mesh: Mesh; delay: number; height: number }> = []
  private readonly radius: number

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.radius = entity.radius
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const bark = lit('#6b4a2e', { roughness: 0.95 })
    const geometry = jitter(new ConeGeometry(1, 1, 5, 3), 0.15, 61).translate(0, 0.5, 0)
    for (let index = 0; index < 16; index += 1) {
      const angle = index / 16 * Math.PI * 2 + Math.random() * 0.4
      const distance = (index % 3 === 0 ? 0.25 : 0.7) * this.radius * (0.7 + Math.random() * 0.4)
      const spike = this.mesh(new Mesh(geometry.clone(), bark))
      spike.position.set(Math.cos(angle) * distance, 0, Math.sin(angle) * distance)
      spike.rotation.set((Math.random() - 0.5) * 0.7, Math.random() * Math.PI, (Math.random() - 0.5) * 0.7)
      spike.castShadow = true
      this.spikes.push({ mesh: spike, delay: Math.random() * 0.08, height: 30 + Math.random() * 30 })
    }
    geometry.dispose()
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    const { x, z } = this.group.position
    if (age < ctx.dt * 1.5) {
      burst(ctx, { x, y: 5, z }, { count: 40, speed: this.radius * 2, color: colour('#5a4430'), size: 5, life: 0.9, up: 2, gravity: -600, puff: true, alpha: 1, spread: this.radius })
      burst(ctx, { x, y: 5, z }, { count: 20, speed: 60, color: colour('#a3c45a'), size: 6, life: 0.5 })
    }
    for (const spike of this.spikes) {
      const t = age - spike.delay
      const grow = easeOut(t / 0.15) * (1 - ease((age - 0.7) / 0.3))
      spike.mesh.scale.set(5 * grow + 0.01, spike.height * grow + 0.01, 5 * grow + 0.01)
    }
    ctx.decals.softDisc(x, z, this.radius, '#2a1f14', 0.4 * (1 - ease(age / 1)), 0.3)
    return age < 1.05
  }
}

// Grove: young trees springing up over the circle, gnarled and bent, their branches hung with leaves, roots spreading at their feet;
// leaves falling and green motes of healing rising; then sinking back into the ground.
export class GroveVisual extends Visual {
  private readonly trees: Array<{ group: Group; delay: number; size: number; sway: number }> = []
  private readonly radius: number

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.radius = entity.radius
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const wood = lit('#4f3a26', { roughness: 0.95 })
    for (let index = 0; index < 8; index += 1) {
      const angle = index / 8 * Math.PI * 2 + Math.random() * 0.5
      const distance = (index === 0 ? 0.1 : 0.4 + Math.random() * 0.45) * this.radius
      const group = new Group()
      group.position.set(Math.cos(angle) * distance, 0, Math.sin(angle) * distance)
      group.rotation.y = Math.random() * Math.PI * 2
      this.group.add(group)
      const tree = saplingGeometry(index * 977 + 13)
      const leaves = new MeshStandardMaterial({ color: ['#3f7f35', '#4f9a3e', '#5aa848', '#3a6e2e'][index % 4], roughness: 0.8, side: DoubleSide, flatShading: true })
      this.mesh(new Mesh(tree.wood, wood), group).castShadow = true
      this.mesh(new Mesh(tree.leaves, leaves), group).castShadow = true
      this.trees.push({ group, delay: Math.random() * 0.15, size: 55 + Math.random() * 30, sway: Math.random() * 10 })
    }
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    if (gone > 0.6) return false
    const age = this.age(ctx)
    const sink = 1 - ease(gone / 0.6)
    for (const tree of this.trees) {
      const grow = easeOut((age - tree.delay) / 0.35)
      // Up first, then out: a shoot that thickens and spreads.
      tree.group.scale.set(tree.size * Math.min(1, grow * 1.3) * sink + 0.01, tree.size * grow * sink + 0.01, tree.size * Math.min(1, grow * 1.3) * sink + 0.01)
      tree.group.rotation.z = Math.sin(ctx.t * 1.6 + tree.sway) * 0.03
    }
    const { x, z } = this.group.position
    ctx.glowDecals.softDisc(x, z, this.radius, '#3e8e41', 0.22 * sink, 0.45)
    ctx.decals.softDisc(x, z, this.radius * 1.05, '#1f3a18', 0.35 * sink, 0.35)
    if (age < ctx.dt * 1.5) burst(ctx, { x, y: 8, z }, { count: 40, speed: this.radius * 1.2, color: colour('#4a3a26'), size: 5, life: 0.8, up: 1.4, gravity: -500, puff: true, alpha: 1, spread: this.radius })
    if (entity && Math.random() < ctx.dt * 50) {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.sqrt(Math.random()) * this.radius
      ctx.fx.glow.emit({ x: x + Math.cos(angle) * distance, y: 4, z: z + Math.sin(angle) * distance, vy: 50, life: 1, size: 6, sizeEnd: 1, color: colour('#8effa0'), alpha: 0.9 })
      ctx.fx.puff.emit({ x: x + Math.cos(angle) * distance, y: 70, z: z + Math.sin(angle) * distance, vx: (Math.random() - 0.5) * 20, vy: -25, vz: (Math.random() - 0.5) * 20, life: 1.6, size: 4, color: colour(Math.random() < 0.5 ? '#5aa848' : '#a8c86a'), alpha: 0.95 })
    }
    return true
  }
}

// A young tree, about a unit tall: a trunk bending as it rises in tapering pieces, a few branches off it, and a cluster of separate
// leaves at the end of each, turned every way. The wood and the leaves are a shape each.
function saplingGeometry(seed: number): { wood: BufferGeometry; leaves: BufferGeometry } {
  const random = seededRandom(seed)
  const wood: BufferGeometry[] = []
  const leaves: BufferGeometry[] = []
  const up = new Vector3(0, 1, 0)
  const matrix = new Matrix4()
  const turn = new Quaternion()
  // A limb from `from` going `direction`, in `pieces`, each `length` long, thinning from `radius`; leaves on its end.
  const limb = (from: Vector3, direction: Vector3, pieces: number, length: number, radius: number, branches: number): void => {
    let at = from.clone()
    let heading = direction.clone().normalize()
    for (let piece = 0; piece < pieces; piece += 1) {
      const top = radius * (1 - (piece + 1) / (pieces + 1))
      const bottom = radius * (1 - piece / (pieces + 1))
      const segment = new CylinderGeometry(Math.max(0.006, top), bottom, length, 6).translate(0, length / 2, 0)
      turn.setFromUnitVectors(up, heading)
      segment.applyMatrix4(matrix.compose(at, turn, new Vector3(1, 1, 1)))
      wood.push(segment)
      at = at.clone().addScaledVector(heading, length)
      heading = heading.add(new Vector3((random() - 0.5) * 0.5, 0.05, (random() - 0.5) * 0.5)).normalize()
      if (branches > 0 && piece >= 1 && random() < 0.6) {
        const out = new Vector3(random() - 0.5, 0.35 + random() * 0.3, random() - 0.5).normalize()
        limb(at, out, 2, length * 0.75, top * 0.7, branches - 1)
      }
    }
    // A cluster of leaves on its end.
    for (let index = 0; index < 16; index += 1) {
      const leaf = new PlaneGeometry(0.07, 0.12).translate(0, 0.06, 0)
      turn.setFromEuler(new Euler(random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2))
      const spot = at.clone().add(new Vector3((random() - 0.5) * 0.22, (random() - 0.3) * 0.2, (random() - 0.5) * 0.22))
      leaf.applyMatrix4(matrix.compose(spot, turn, new Vector3(1, 1, 1)))
      leaves.push(leaf)
    }
  }
  limb(new Vector3(0, 0, 0), new Vector3((random() - 0.5) * 0.3, 1, (random() - 0.5) * 0.3), 4, 0.2, 0.05, 2)
  // Roots splayed out at its foot.
  for (let index = 0; index < 4; index += 1) {
    const angle = index / 4 * Math.PI * 2 + random()
    const root = new CylinderGeometry(0.005, 0.025, 0.2, 5).translate(0, 0.1, 0)
    turn.setFromUnitVectors(up, new Vector3(Math.cos(angle), 0.25, Math.sin(angle)).normalize())
    root.applyMatrix4(matrix.compose(new Vector3(0, 0.02, 0), turn, new Vector3(1, 1, 1)))
    wood.push(root)
  }
  const merged = { wood: mergeGeometries(wood.map((piece) => piece.toNonIndexed())), leaves: mergeGeometries(leaves.map((piece) => piece.toNonIndexed())) }
  for (const piece of [...wood, ...leaves]) piece.dispose()
  merged.wood.computeVertexNormals()
  merged.leaves.computeVertexNormals()
  return merged
}

// ---------------------------------------------------------------------------------------------- shapes

// A star of `points` points, flat in its own XY, `depth` thick.
export function starGeometry(outer: number, inner: number, points: number, depth: number): BufferGeometry {
  const shape = new Shape()
  for (let index = 0; index <= points * 2; index += 1) {
    const turn = index / (points * 2) * Math.PI * 2 - Math.PI / 2
    const r = index % 2 === 0 ? outer : inner
    if (index === 0) shape.moveTo(Math.cos(turn) * r, Math.sin(turn) * r)
    else shape.lineTo(Math.cos(turn) * r, Math.sin(turn) * r)
  }
  return new ExtrudeGeometry(shape, { depth, bevelEnabled: false }).translate(0, 0, -depth / 2)
}

// A short capsule standing along Y: a cylinder with rounded ends, for a shell.
class CapsuleLike extends LatheGeometry {
  constructor(radius: number, length: number) {
    const points: ThreeVector2[] = []
    for (let index = 0; index <= 6; index += 1) {
      const turn = index / 6 * Math.PI / 2
      points.push(new ThreeVector2(Math.sin(turn) * radius, -length / 2 - Math.cos(turn) * radius))
    }
    for (let index = 0; index <= 6; index += 1) {
      const turn = index / 6 * Math.PI / 2
      points.push(new ThreeVector2(Math.cos(turn) * radius, length / 2 + Math.sin(turn) * radius))
    }
    super(points, 10)
  }
}

