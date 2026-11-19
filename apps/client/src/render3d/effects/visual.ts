import {
  AdditiveBlending,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  type Material,
} from 'three'
import type { RenderedCharacter, RenderedEntity } from '../../game-state.ts'
import type { CharacterModels3D } from '../character-models.ts'
import type { DecalBatch } from '../decal-batch.ts'
import { HumanoidModel } from '../models/humanoid.ts'
import { ease, type FxContext } from '../models/model.ts'
import { TurretModel } from '../models/structures.ts'
import { colour, lerp, yawToward } from '../space.ts'
import type { LightPool } from './fx-materials.ts'

// What every effect is drawn with, each frame.
export type EffectContext = {
  // A clock in seconds, and the seconds since the last frame.
  t: number
  dt: number
  fx: FxContext
  lights: LightPool
  // Shapes painted on the ground this frame: as paint, and as light.
  decals: DecalBatch
  glowDecals: DecalBatch
  characters: ReadonlyMap<number, RenderedCharacter>
  models: CharacterModels3D
}

// One thing an ability or an auto put in the world, drawn in 3D. It is told each frame what its entity is now, or that it is
// gone (`undefined`), and says whether it is still to be drawn: an explosion, say, plays on after the moment its entity lasts.
export abstract class Visual {
  protected readonly group = new Group()
  private readonly owned: Array<{ dispose(): void }> = []
  protected bornAt = -1
  protected goneAt = -1

  constructor(parent: Group) {
    parent.add(this.group)
  }

  // Draws this frame; false when it has finished.
  step(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (this.bornAt < 0) this.bornAt = ctx.t
    if (!entity && this.goneAt < 0) this.goneAt = ctx.t
    return this.draw(entity, ctx)
  }

  protected abstract draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean

  // How long it has been since it went, in seconds (0 while it is here).
  protected sinceGone(ctx: EffectContext): number {
    return this.goneAt < 0 ? 0 : ctx.t - this.goneAt
  }

  protected age(ctx: EffectContext): number {
    return ctx.t - this.bornAt
  }

  protected mesh<T extends Mesh>(mesh: T, parent: Group = this.group): T {
    parent.add(mesh)
    this.owned.push(mesh.geometry, mesh.material as Material)
    return mesh
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const item of this.owned) item.dispose()
  }
}

export const glowMaterial = (css: string, opacity: number): MeshBasicMaterial =>
  new MeshBasicMaterial({ color: css, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false })

// How high a shot flies: from where its owner lets it go (a staff's stone, a tower's crystal) down to the middle of what it is
// after, or level at chest height for one that is aimed at the ground.
export class ShotHeight {
  private readonly start: number
  constructor(entity: RenderedEntity, ctx: EffectContext) {
    const model = ctx.models.modelOf(entity.ownerId)
    if (model instanceof TurretModel) this.start = model.muzzle().y
    else if (model instanceof HumanoidModel) this.start = model.focus().y
    else this.start = model ? model.height * 0.55 : 38
  }

  at(entity: RenderedEntity, ctx: EffectContext): number {
    const target = entity.targetId === undefined ? undefined : ctx.characters.get(entity.targetId)
    if (target) {
      const gone = Math.hypot(entity.position.x - entity.origin.x, entity.position.y - entity.origin.y)
      const left = Math.hypot(target.position.x - entity.position.x, target.position.y - entity.position.y)
      const end = (ctx.models.topOf(target.id) ?? 60) * 0.55
      return lerp(this.start, end, gone / Math.max(1, gone + left))
    }
    return lerp(this.start, 36, ease(entity.progress * 5))
  }
}

// -------------------------------------------------------------------------------------------------- shots

export type BoltStyle = 'fire' | 'water' | 'plain'

// An auto attack's shot, or any other: a bright core with a glow round it and a trail behind it. The Fire Mage's are little
// fireballs, Capricorn's are orbs of water that drip as they fly.
export class BoltVisual extends Visual {
  private readonly height: ShotHeight
  private readonly core: Mesh
  private readonly halo: Mesh
  private last?: { x: number; y: number; z: number }

  // `empowered`: a shot made stronger by an ability (Capricorn's after a spell), which is bigger and brighter, with a swirl round it.
  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, private readonly style: BoltStyle, private readonly empowered = false) {
    super(parent)
    this.height = new ShotHeight(entity, ctx)
    const r = Math.max(4, entity.radius) * (empowered ? 1.7 : 1)
    const tint = entity.color ?? '#f2b66d'
    this.core = this.mesh(new Mesh(new SphereGeometry(r * (style === 'water' ? 1.1 : 0.8), 12, 8), new MeshBasicMaterial({ color: style === 'fire' ? '#fff0b0' : style === 'water' ? '#d8f6ff' : '#ffffff' })))
    this.halo = this.mesh(new Mesh(new SphereGeometry(r * 2.4, 12, 8), glowMaterial(style === 'water' ? '#3f9bff' : tint, 0.55)))
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) {
      // Gone: it has hit. A puff where it was.
      if (this.last) this.impact(ctx)
      return false
    }
    const y = this.height.at(entity, ctx)
    const r = Math.max(4, entity.radius) * (this.empowered ? 1.7 : 1)
    this.group.position.set(entity.position.x, y, entity.position.y)
    if (this.empowered) {
      // A ring of water spinning round it.
      for (let index = 0, count = Math.ceil(ctx.dt * 120); index < count; index += 1) {
        const turn = ctx.t * 14 + index * 2.1
        ctx.fx.glow.emit({ x: entity.position.x + Math.cos(turn) * r * 1.6, y: y + Math.sin(turn * 0.5) * r * 0.6, z: entity.position.y + Math.sin(turn) * r * 1.6, life: 0.3, size: r * 0.9, sizeEnd: 1, color: colour('#bfeeff'), alpha: 0.9 })
      }
    }
    const wobble = this.style === 'water' ? 1 + Math.sin(ctx.t * 22) * 0.12 : 1
    this.core.scale.set(wobble, 2 - wobble, wobble)
    this.halo.scale.setScalar(1 + Math.sin(ctx.t * 30) * 0.08)
    const { glow, puff } = ctx.fx
    const tint = colour(entity.color ?? '#f2b66d')
    const count = Math.ceil(ctx.dt * (this.style === 'plain' ? 50 : 110))
    for (let index = 0; index < count; index += 1) {
      const jitter = (): number => (Math.random() - 0.5) * r
      if (this.style === 'fire') {
        glow.emit({ x: entity.position.x + jitter(), y: y + jitter(), z: entity.position.y + jitter(), vy: 20, life: 0.28, size: r * 2.8, sizeEnd: r * 0.6, color: colour('#ffd36a'), colorEnd: colour('#d1300c'), alpha: 0.9 })
      } else if (this.style === 'water') {
        if (Math.random() < 0.5) puff.emit({ x: entity.position.x + jitter(), y: y + jitter(), z: entity.position.y + jitter(), vx: (Math.random() - 0.5) * 20, vz: (Math.random() - 0.5) * 20, life: 0.5, size: r * 0.7, color: colour('#9fe0ff'), alpha: 0.85, gravity: -400 })
        else glow.emit({ x: entity.position.x + jitter(), y: y + jitter(), z: entity.position.y + jitter(), life: 0.25, size: r * 2, sizeEnd: r * 0.5, color: colour('#3f9bff'), alpha: 0.7 })
      } else {
        glow.emit({ x: entity.position.x + jitter() * 0.5, y, z: entity.position.y + jitter() * 0.5, life: 0.18, size: r * 2, sizeEnd: r * 0.4, color: tint, alpha: 0.7 })
      }
    }
    if (this.style === 'fire') ctx.lights.light(entity.position.x, y, entity.position.y, '#ff8a3a', 0.9, 160)
    else if (this.style === 'water') ctx.lights.light(entity.position.x, y, entity.position.y, '#5fb8ff', 0.6, 140)
    this.last = { x: entity.position.x, y, z: entity.position.y }
    return true
  }

  private impact(ctx: EffectContext): void {
    const at = this.last
    if (!at) return
    const tint = this.style === 'fire' ? colour('#ff9a3c') : this.style === 'water' ? colour('#bfeaff') : colour('#ffffff')
    for (let index = 0, count = this.empowered ? 30 : 12; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const speed = 40 + Math.random() * 90
      const spec = { x: at.x, y: at.y, z: at.z, vx: Math.cos(angle) * speed, vy: Math.random() * 80, vz: Math.sin(angle) * speed, life: 0.3, size: 5, sizeEnd: 1, color: tint, alpha: 0.9, drag: 3 }
      if (this.style === 'water') ctx.fx.puff.emit({ ...spec, gravity: -500, life: 0.45 })
      else ctx.fx.glow.emit(spec)
    }
  }
}

// -------------------------------------------------------------------------------------------------- everything else

// What the other champions' abilities put out, drawn simply in 3D, as in 2D: a telegraph is a circle with a disc filling it, a
// field lies faintly on the ground, a flash flares and fades, a box that flies is a glowing slab, and a shot is a glowing bolt.
export class GroundShapeVisual extends Visual {
  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) return false
    const { x, y } = entity.position
    const css = entity.color ?? (entity.visual === 'telegraph' ? '#ff6b4a' : entity.visual === 'field' ? '#9b6df2' : '#ffffff')
    const facing = entity.facing ?? { x: 1, y: 0 }
    if (entity.visual === 'telegraph') {
      if (entity.box) {
        ctx.decals.box(entity.position, facing, entity.box.halfLength, entity.box.halfWidth, css, 0.12)
        ctx.glowDecals.box(entity.position, facing, entity.box.halfLength * entity.progress, entity.box.halfWidth, css, 0.3)
      } else {
        ctx.decals.disc(x, y, entity.radius, css, 0.1)
        ctx.glowDecals.circle(x, y, entity.radius, 3, css, 0.8)
        ctx.glowDecals.disc(x, y, entity.radius * entity.progress, css, 0.3)
      }
    } else if (entity.visual === 'flash') {
      const fade = (1 - entity.progress) ** 2
      if (entity.box) {
        ctx.glowDecals.box(entity.position, facing, entity.box.halfLength, entity.box.halfWidth, css, 0.7 * fade)
      } else {
        ctx.glowDecals.disc(x, y, entity.radius, css, 0.55 * fade)
        ctx.glowDecals.circle(x, y, entity.radius, 5, css, fade)
      }
    } else if (entity.box) {
      ctx.decals.box(entity.position, facing, entity.box.halfLength, entity.box.halfWidth, css, 0.16)
      ctx.glowDecals.box(entity.position, facing, entity.box.halfLength, entity.box.halfWidth, css, 0.12)
    } else {
      ctx.decals.disc(x, y, entity.radius, css, 0.16)
      ctx.glowDecals.circle(x, y, entity.radius, 2.5, css, 0.55)
    }
    return true
  }
}

export class SlabVisual extends Visual {
  private readonly slab: Mesh<BoxGeometry, MeshBasicMaterial>

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    const box = entity.box ?? { halfLength: entity.radius, halfWidth: entity.radius }
    this.slab = this.mesh(new Mesh(new BoxGeometry(box.halfWidth * 2, 28, box.halfLength * 2), glowMaterial(entity.color ?? '#f2b66d', 0.6)))
    this.slab.position.y = 18
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) return false
    const facing = entity.facing ?? { x: 1, y: 0 }
    this.group.position.set(entity.position.x, 0, entity.position.y)
    this.group.rotation.y = yawToward(facing.x, facing.y)
    this.slab.material.opacity = 0.45 + Math.sin(ctx.t * 20) * 0.1
    if (entity.box) ctx.glowDecals.box(entity.position, facing, entity.box.halfLength, entity.box.halfWidth, entity.color ?? '#f2b66d', 0.35)
    return true
  }
}
