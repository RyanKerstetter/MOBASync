import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  SphereGeometry,
} from 'three'
import { GAME_TPS } from '../../../../../packages/shared/src/index.ts'
import type { RenderedEntity } from '../../game-state.ts'
import { ease, easeOut } from '../models/model.ts'
import { colour, hashString, lerp, seededRandom } from '../space.ts'
import { jitter } from '../terrain-mesh.ts'
import { bloodSpray } from './kits-melee.ts'
import { burst, headingOf, lit, ShotVisual, type Point3 } from './kits.ts'
import { glowMaterial, ShotHeight, Visual, type EffectContext } from './visual.ts'

// The effects of the ranged champions that came later: Sanguine, the Hunter, Crystal and the Sniper, and the Crossbowman's bolts. Each is drawn from what its
// entity is (its id), as the others are (kits.ts).

// The height a body's chest is at, for something between two bodies.
function chestHeight(ctx: EffectContext, unitId: number): number {
  return (ctx.models.topOf(unitId) ?? 60) * 0.55
}

// ---------------------------------------------------------------------------------------------- Sanguine

// A shot of blood: a glob of thick, clotting blood, dark and glossy, quivering as it flies, with clots dragged along beside it and drops falling from it. It is
// blood, not light: it shines only as anything wet does. Where it strikes it bursts in a spray, and leaves a splash on the ground.
export class BloodGlobVisual extends Visual {
  private readonly height: ShotHeight
  private readonly glob: Mesh
  private readonly clots: Mesh[] = []
  private readonly size: number
  private last?: Point3
  private splash?: { x: number; z: number; seed: number }

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent)
    this.height = new ShotHeight(entity, ctx)
    this.size = Math.max(5, entity.radius * 0.75)
    const blood = new MeshStandardMaterial({ color: '#5a0610', roughness: 0.12, metalness: 0.25, emissive: '#1a0003', emissiveIntensity: 1 })
    const clot = new MeshStandardMaterial({ color: '#3a0408', roughness: 0.35, metalness: 0.15 })
    this.glob = this.mesh(new Mesh(jitter(new IcosahedronGeometry(this.size, 2), 0.18, hashString(entity.id) % 97), blood))
    for (let index = 0; index < 4; index += 1) {
      this.clots.push(this.mesh(new Mesh(jitter(new IcosahedronGeometry(this.size * (0.25 + index * 0.06), 1), 0.25, index + 3), clot)))
    }
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) {
      if (this.last && !this.splash) {
        bloodSpray(ctx, this.last, 22)
        this.glob.visible = false
        for (const clot of this.clots) clot.visible = false
        this.splash = { x: this.last.x, z: this.last.z, seed: Math.floor(Math.random() * 1000) }
      }
      const gone = this.sinceGone(ctx)
      if (!this.splash || gone > 0.9) return false
      const random = seededRandom(this.splash.seed)
      for (let index = 0; index < 5; index += 1) {
        const angle = random() * Math.PI * 2
        const out = random() * this.size * 2.5
        ctx.decals.softDisc(this.splash.x + Math.cos(angle) * out, this.splash.z + Math.sin(angle) * out, this.size * (0.6 + random()), '#4a050a', 0.7 * (1 - gone / 0.9), 0.35)
      }
      return true
    }
    const y = this.height.at(entity, ctx)
    const heading = headingOf(entity)
    this.group.position.set(entity.position.x, y, entity.position.y)
    this.group.rotation.y = heading
    // It quivers, stretched out along its flight.
    const wobble = Math.sin(ctx.t * 26) * 0.12
    this.glob.scale.set(1 - wobble, 1 + wobble * 0.5, 1.35 + wobble)
    this.glob.rotation.z = ctx.t * 3
    this.clots.forEach((clot, index) => {
      const turn = ctx.t * (7 + index) + index * 1.7
      clot.position.set(Math.cos(turn) * this.size * 0.9, Math.sin(turn * 1.3) * this.size * 0.6, -this.size * (1 + index * 0.55))
    })
    for (let index = 0, count = Math.ceil(ctx.dt * 70); index < count; index += 1) {
      ctx.fx.puff.emit({
        x: entity.position.x + (Math.random() - 0.5) * this.size, y: y + (Math.random() - 0.5) * this.size, z: entity.position.y + (Math.random() - 0.5) * this.size,
        vx: (Math.random() - 0.5) * 20, vy: 0, vz: (Math.random() - 0.5) * 20,
        life: 0.5, size: 2 + Math.random() * 2.5, sizeEnd: 1, color: colour(Math.random() < 0.5 ? '#6a0812' : '#3a0408'), alpha: 1, gravity: -500,
      })
    }
    if (Math.random() < ctx.dt * 20) ctx.fx.puff.emit({ x: entity.position.x, y, z: entity.position.y, life: 0.4, size: this.size * 1.6, sizeEnd: this.size * 2.4, color: colour('#4a0610'), alpha: 0.25 })
    this.last = { x: entity.position.x, y, z: entity.position.y }
    return true
  }
}

// Blood Pact: a cord of blood drawn tight from Sanguine to whoever she has bound, dark and wet, with a red heart running down its middle; blood flows along it from
// them to her, and with each pulse of the pact the cord throbs. Under the bound one, a ring of blood fills round like a clock, so both can see how long until it bursts.
// Held to the end, it bursts on them in a gout of blood; broken, it snaps, and what was in it falls.
export class BloodPactVisual extends Visual {
  private readonly cord: Mesh<CylinderGeometry, MeshStandardMaterial>
  private readonly core: Mesh<CylinderGeometry, MeshBasicMaterial>
  private boundId?: number
  private lastProgress = 0
  private lastEnds?: { from: Point3; to: Point3 }

  constructor(parent: Group) {
    super(parent)
    const along = (): CylinderGeometry => new CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2)
    this.cord = this.mesh(new Mesh(along(), new MeshStandardMaterial({ color: '#4a0610', roughness: 0.2, metalness: 0.2, emissive: '#2a0006', emissiveIntensity: 1, transparent: true, opacity: 0.85 })))
    this.core = this.mesh(new Mesh(along(), glowMaterial('#ff2a3a', 0.7)))
    this.cord.visible = this.core.visible = false
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) {
      const ends = this.lastEnds
      if (ends && this.sinceGone(ctx) < ctx.dt * 1.5) {
        if (this.lastProgress > 0.93) {
          bloodSpray(ctx, ends.to, 60)
          burst(ctx, ends.to, { count: 30, speed: 160, color: colour('#ff4a5a'), colorEnd: colour('#5a0610'), size: 8, life: 0.5, up: 0.8 })
          burst(ctx, { ...ends.to, y: 6 }, { count: 12, speed: 70, color: colour('#4a0610'), size: 22, life: 0.9, puff: true, alpha: 0.4 })
        } else {
          for (let index = 0; index <= 10; index += 1) {
            const k = index / 10
            bloodSpray(ctx, { x: lerp(ends.from.x, ends.to.x, k), y: lerp(ends.from.y, ends.to.y, k), z: lerp(ends.from.z, ends.to.z, k) }, 2)
          }
        }
      }
      this.cord.visible = this.core.visible = false
      return false
    }
    const owner = ctx.characters.get(entity.ownerId)
    this.lastProgress = entity.progress
    // Whoever carries the pact's mark: the nearest such to her, should there be two.
    if (owner && (this.boundId === undefined || !(ctx.characters.get(this.boundId)?.stacks['blood-pact']))) {
      let best: number | undefined
      let bestGap = Infinity
      for (const character of ctx.characters.values()) {
        if (!(character.stacks['blood-pact'] > 0)) continue
        const gap = Math.hypot(character.position.x - owner.position.x, character.position.y - owner.position.y)
        if (gap < bestGap) {
          bestGap = gap
          best = character.id
        }
      }
      this.boundId = best
    }
    const bound = this.boundId === undefined ? undefined : ctx.characters.get(this.boundId)
    if (!owner || !bound) {
      this.cord.visible = this.core.visible = false
      return true
    }
    const from = { x: owner.position.x, y: chestHeight(ctx, owner.id), z: owner.position.y }
    const to = { x: bound.position.x, y: chestHeight(ctx, bound.id), z: bound.position.y }
    this.lastEnds = { from, to }
    const length = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z))
    // A throb with each pulse of the pact (two a second), easing off between.
    const throb = Math.exp(-(((entity.progress * 6) % 1) ** 2) * 30)
    for (const [mesh, width] of [[this.cord, 3.2 + throb * 1.6], [this.core, 1.1 + throb * 1.4]] as const) {
      mesh.visible = true
      mesh.position.set(from.x, from.y, from.z)
      mesh.scale.set(width, width, length)
      mesh.lookAt(to.x, to.y, to.z)
    }
    this.core.material.opacity = 0.45 + throb * 0.5
    // Blood running along it, from them to her.
    for (let index = 0, count = Math.ceil(ctx.dt * 40); index < count; index += 1) {
      const life = 0.45
      ctx.fx.glow.emit({ x: to.x, y: to.y, z: to.z, vx: (from.x - to.x) / life, vy: (from.y - to.y) / life, vz: (from.z - to.z) / life, life, size: 4.5, sizeEnd: 2.5, color: colour('#ff3a4a'), colorEnd: colour('#8a0a16'), alpha: 0.9 })
    }
    if (Math.random() < ctx.dt * 8) {
      const k = Math.random()
      ctx.fx.puff.emit({ x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k), z: lerp(from.z, to.z, k), life: 0.5, size: 2.5, color: colour('#6a0812'), alpha: 1, gravity: -500 })
    }
    // The clock under the bound one: a faint ring, filling round from the top as the pact holds, brighter at each pulse.
    const r = bound.champion.radius + 12
    const start = -Math.PI / 2
    ctx.decals.softDisc(to.x, to.z, r + 6, '#3a0408', 0.35, 0.5)
    ctx.glowDecals.ring(to.x, to.z, r - 2, r + 2, '#8a0a16', 0.35)
    ctx.glowDecals.ring(to.x, to.z, r - 4, r + 4, '#ff2a3a', 0.6 + throb * 0.35, start, start + Math.PI * 2 * Math.min(1, entity.progress))
    ctx.decals.circle(from.x, from.z, owner.champion.radius + 6, 3, '#8a0a16', 0.5)
    return true
  }
}

// Coagulate's shield: plates of clotted blood turning round her, quivering, dripping.
export class CoagulateVisual extends Visual {
  private readonly plates: Mesh[] = []

  constructor(parent: Group) {
    super(parent)
    const blood = new MeshStandardMaterial({ color: '#5a0610', roughness: 0.2, metalness: 0.2, emissive: '#200004', emissiveIntensity: 1, transparent: true, opacity: 0.9 })
    for (let index = 0; index < 7; index += 1) {
      const plate = this.mesh(new Mesh(jitter(new IcosahedronGeometry(6 + (index % 3), 1), 0.3, index * 7 + 2), index === 0 ? blood : blood.clone()))
      plate.scale.set(1.2, 0.8, 0.5)
      this.plates.push(plate)
    }
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    if (gone > 0.2) return false
    const owner = entity ? ctx.characters.get(entity.ownerId) : undefined
    if (entity && owner) this.group.position.set(owner.position.x, 0, owner.position.y)
    const grow = Math.min(1, this.age(ctx) / 0.25) * (1 - gone / 0.2)
    const height = entity ? chestHeight(ctx, entity.ownerId) : 34
    this.plates.forEach((plate, index) => {
      const turn = ctx.t * 1.6 + index / this.plates.length * Math.PI * 2
      const radius = 26 + Math.sin(ctx.t * 3 + index) * 3
      plate.position.set(Math.cos(turn) * radius, height + Math.sin(ctx.t * 2 + index * 1.3) * 14, Math.sin(turn) * radius)
      plate.rotation.set(ctx.t * 2 + index, -turn, 0.3)
      plate.scale.set(1.2 * grow, 0.8 * grow, 0.5 * grow)
    })
    if (Math.random() < ctx.dt * 10) {
      const plate = this.plates[Math.floor(Math.random() * this.plates.length)]
      const { x, z } = this.group.position
      ctx.fx.puff.emit({ x: x + plate.position.x, y: plate.position.y, z: z + plate.position.z, life: 0.5, size: 2.5, color: colour('#6a0812'), alpha: 1, gravity: -400 })
    }
    return true
  }
}

// The shield bursting: shards of hardened blood flung out over the ring, glinting dark red, and blood sprayed and splashed over the ground.
export class BloodShardsVisual extends Visual {
  private readonly shards: Array<{ mesh: Mesh; angle: number; speed: number; lift: number }> = []
  private readonly radius: number
  private readonly seed: number

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent)
    this.radius = entity.radius
    this.seed = hashString(entity.id)
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const material = new MeshStandardMaterial({ color: '#6a0812', roughness: 0.1, metalness: 0.4, emissive: '#3a0006', emissiveIntensity: 1 })
    for (let index = 0; index < 16; index += 1) {
      const mesh = this.mesh(new Mesh(new OctahedronGeometry(4, 0), index === 0 ? material : material.clone()))
      mesh.scale.set(0.6, 2.2, 0.6)
      this.shards.push({ mesh, angle: index / 16 * Math.PI * 2 + Math.random() * 0.3, speed: 0.8 + Math.random() * 0.4, lift: 20 + Math.random() * 30 })
    }
    const at = { x: entity.position.x, y: 34, z: entity.position.y }
    bloodSpray(ctx, at, 50)
    burst(ctx, at, { count: 30, speed: this.radius * 1.8, color: colour('#ff4a5a'), colorEnd: colour('#5a0610'), size: 6, life: 0.35, up: 0.4 })
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    if (age > 0.9) return false
    const k = easeOut(Math.min(1, age / 0.3))
    for (const shard of this.shards) {
      const out = this.radius * k * shard.speed
      shard.mesh.position.set(Math.cos(shard.angle) * out, 30 + shard.lift * Math.sin(Math.min(1, age / 0.5) * Math.PI) - age * age * 60, Math.sin(shard.angle) * out)
      shard.mesh.rotation.set(Math.PI / 2, 0, -shard.angle + Math.PI / 2)
      shard.mesh.visible = age < 0.6
    }
    const { x, z } = this.group.position
    const fade = 1 - ease((age - 0.3) / 0.6)
    ctx.decals.ring(x, z, this.radius * k * 0.9, this.radius * k, '#4a050a', 0.5 * fade)
    const random = seededRandom(this.seed)
    for (let index = 0; index < 10; index += 1) {
      const angle = random() * Math.PI * 2
      const out = this.radius * (0.3 + random() * 0.7) * k
      ctx.decals.softDisc(x + Math.cos(angle) * out, z + Math.sin(angle) * out, 6 + random() * 8, '#4a050a', 0.6 * fade, 0.35)
    }
    if (age < 0.2) ctx.lights.light(x, 30, z, '#d23a48', 2, 220)
    return true
  }
}

// ---------------------------------------------------------------------------------------------- arrows and bolts

export type ArrowEnd = 'spark' | 'vines' | 'leaves'

// An arrow: a shaft, a steel head and fletching, pointing the way it flies, with a streak of its colour behind it. `size` makes it bigger (Disengage's); its end is
// what it does where it lands: sparks, vines bursting up to root, or a scatter of leaves.
export class FletchedArrowVisual extends ShotVisual {
  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, private readonly tint: string, private readonly size = 1, private readonly end: ArrowEnd = 'spark') {
    super(parent, entity, ctx)
    this.body.scale.setScalar(size)
    const shaft = this.mesh(new Mesh(new CylinderGeometry(0.8, 0.8, 34, 5), lit('#7a5a32')), this.body)
    shaft.rotation.x = Math.PI / 2
    const head = this.mesh(new Mesh(new ConeGeometry(2.4, 8, 4), lit('#d8dee6', { metalness: 0.85, roughness: 0.25 })), this.body)
    head.rotation.x = Math.PI / 2
    head.position.z = 20
    for (const turn of [0, Math.PI / 2]) {
      const fin = this.mesh(new Mesh(new BoxGeometry(5, 0.4, 8), lit(tint)), this.body)
      fin.position.z = -15
      fin.rotation.z = turn
    }
    const glow = this.mesh(new Mesh(new SphereGeometry(4, 8, 6), glowMaterial(tint, 0.45)), this.body)
    glow.position.z = 18
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    for (let index = 0, count = Math.ceil(ctx.dt * 70 * this.size); index < count; index += 1) {
      ctx.fx.glow.emit({ ...at, life: 0.22, size: 6 * this.size, sizeEnd: 1, color: colour(this.tint), alpha: 0.7 })
    }
    if (this.end === 'vines' && Math.random() < ctx.dt * 20) ctx.fx.puff.emit({ ...at, vy: -20, life: 0.6, size: 4, color: colour('#4f8f2e'), alpha: 0.9, gravity: -150 })
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    if (this.end === 'vines') {
      burst(ctx, at, { count: 24, speed: 120, color: colour('#7bd88f'), colorEnd: colour('#2f6a1a'), size: 6, life: 0.5, up: 1 })
      burst(ctx, { ...at, y: 4 }, { count: 16, speed: 60, color: colour('#3d7a2a'), size: 5, life: 0.9, puff: true, up: 1.6, gravity: -120 })
    } else if (this.end === 'leaves') {
      burst(ctx, at, { count: 12, speed: 90, color: colour(this.tint), size: 4, life: 0.3 })
      burst(ctx, at, { count: 6, speed: 60, color: colour('#7bd88f'), size: 4, life: 0.8, puff: true, gravity: -150, up: 1 })
    } else {
      burst(ctx, at, { count: 10, speed: 110, color: colour(this.tint), size: 4, life: 0.25 })
    }
  }
}

// The Crossbowman's bolt: short and heavy, a thick shaft, a broad steel head and stiff vanes, flying flat and fast with a faint streak.
export class CrossbowBoltVisual extends ShotVisual {
  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, tint: string) {
    super(parent, entity, ctx)
    const shaft = this.mesh(new Mesh(new CylinderGeometry(1.3, 1.3, 22, 6), lit('#6a4a2a')), this.body)
    shaft.rotation.x = Math.PI / 2
    const head = this.mesh(new Mesh(new ConeGeometry(3.2, 9, 4), lit('#c8d0d8', { metalness: 0.9, roughness: 0.25 })), this.body)
    head.rotation.x = Math.PI / 2
    head.position.z = 15
    for (const turn of [0, Math.PI / 2]) {
      const vane = this.mesh(new Mesh(new BoxGeometry(5, 0.6, 6), lit(tint)), this.body)
      vane.position.z = -9
      vane.rotation.z = turn
    }
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    if (Math.random() < ctx.dt * 70) ctx.fx.glow.emit({ ...at, life: 0.14, size: 5, sizeEnd: 1, color: colour('#f2f2e0'), alpha: 0.6 })
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 10, speed: 120, color: colour('#fff1c9'), size: 4, life: 0.2 })
    burst(ctx, at, { count: 5, speed: 60, color: colour('#8a7a5e'), size: 3, life: 0.5, puff: true, gravity: -300, up: 1 })
  }
}

// ---------------------------------------------------------------------------------------------- the Hunter

// A steeply falling arrow, for Arrow Rain.
function fallingArrow(visual: { add: (mesh: Mesh, parent: Group) => Mesh }, parent: Group, tint: string): Group {
  const arrow = new Group()
  parent.add(arrow)
  visual.add(new Mesh(new CylinderGeometry(0.8, 0.8, 30, 4), lit('#7a5a32')), arrow)
  const head = visual.add(new Mesh(new ConeGeometry(2.2, 7, 4), lit('#d8dee6', { metalness: 0.85, roughness: 0.25 })), arrow)
  head.position.y = -18
  head.rotation.x = Math.PI
  const fin = visual.add(new Mesh(new BoxGeometry(4.5, 7, 0.4), lit(tint)), arrow)
  fin.position.y = 13
  return arrow
}

// Arrow Rain coming: a ring marked on the ground where it will land, filling, and a shower of arrows falling out of the sky into it, landing as it goes off.
export class ArrowRainVisual extends Visual {
  private readonly arrows: Array<{ arrow: Group; x: number; z: number; delay: number }> = []
  private readonly radius: number
  private readonly falls: number

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.radius = entity.radius
    this.falls = (entity.lifetimeTicks ?? 30) / GAME_TPS
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const random = seededRandom(hashString(entity.id))
    const add = (mesh: Mesh, holder: Group): Mesh => this.mesh(mesh, holder)
    for (let index = 0; index < 18; index += 1) {
      const angle = random() * Math.PI * 2
      const out = Math.sqrt(random()) * this.radius * 0.9
      const arrow = fallingArrow({ add }, this.group, '#9bd36d')
      arrow.rotation.set(0.25 * (random() - 0.5), 0, 0.25 * (random() - 0.5))
      this.arrows.push({ arrow, x: Math.cos(angle) * out, z: Math.sin(angle) * out, delay: random() * 0.25 })
    }
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) return false
    const age = this.age(ctx)
    const { x, z } = this.group.position
    for (const { arrow, x: ax, z: az, delay } of this.arrows) {
      // Each falls from high above, timed to land as the rain goes off.
      const fall = Math.max(0, Math.min(1, (age - delay * this.falls * 0.6) / (this.falls * (1 - delay * 0.6))))
      arrow.visible = fall > 0
      arrow.position.set(ax + (1 - fall) * 40, 20 + (1 - fall) * 420, az)
    }
    const fill = entity.progress
    ctx.decals.disc(x, z, this.radius, '#1f3b18', 0.18)
    ctx.glowDecals.circle(x, z, this.radius, 3, '#9bd36d', 0.8)
    ctx.glowDecals.disc(x, z, this.radius * fill, '#9bd36d', 0.2)
    for (let index = 0; index < 8; index += 1) {
      const turn = index / 8 * Math.PI * 2 + ctx.t * 0.6
      ctx.glowDecals.ring(x, z, this.radius + 6, this.radius + 10, '#c8f0a0', 0.6, turn, turn + 0.4)
    }
    return true
  }
}

// Arrow Rain landing: arrows driven into the ground all over the circle, dust thrown up where each strikes, and a shock ring; the arrows stand a while and fade.
export class ArrowRainImpactVisual extends Visual {
  private readonly arrows: Group[] = []
  private readonly radius: number

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent)
    this.radius = entity.radius
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const random = seededRandom(hashString(entity.id) + 5)
    const add = (mesh: Mesh, holder: Group): Mesh => this.mesh(mesh, holder)
    for (let index = 0; index < 16; index += 1) {
      const angle = random() * Math.PI * 2
      const out = Math.sqrt(random()) * this.radius * 0.9
      const arrow = fallingArrow({ add }, this.group, '#9bd36d')
      arrow.position.set(Math.cos(angle) * out, 16, Math.sin(angle) * out)
      arrow.rotation.set(0.35 * (random() - 0.5), random() * Math.PI, 0.35 * (random() - 0.5))
      this.arrows.push(arrow)
      burst(ctx, { x: entity.position.x + arrow.position.x, y: 3, z: entity.position.y + arrow.position.z }, { count: 3, speed: 50, color: colour('#9a8a6a'), size: 10, life: 0.6, puff: true, alpha: 0.4, up: 0.6 })
    }
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    if (gone > 0.3) return false
    const age = this.age(ctx)
    const { x, z } = this.group.position
    const k = easeOut(Math.min(1, age / 0.35))
    ctx.glowDecals.ring(x, z, this.radius * k, this.radius * k + 6, '#c8f0a0', 0.8 * (1 - k))
    ctx.decals.disc(x, z, this.radius, '#2a2416', 0.25 * (1 - ease(age / 1.2)))
    const sink = (entity?.progress ?? 1) > 0.75 ? ((entity?.progress ?? 1) - 0.75) / 0.25 : 0
    for (const arrow of this.arrows) {
      arrow.position.y = 16 - sink * 30 - gone * 60
    }
    return true
  }
}

// ---------------------------------------------------------------------------------------------- Crystal

// A crystal arrow: a shaft of pale glass with a long crystal head that glows, sparkling as it flies. Crystal Bolt is a bigger one, with shards turning round it.
export class CrystalArrowVisual extends ShotVisual {
  private readonly shards: Mesh[] = []

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, private readonly big: boolean) {
    super(parent, entity, ctx)
    const size = big ? 1.7 : 1
    this.body.scale.setScalar(size)
    const glass = new MeshStandardMaterial({ color: '#d6f6ff', roughness: 0.05, metalness: 0.3, emissive: '#5fd0ff', emissiveIntensity: 0.8, transparent: true, opacity: 0.9 })
    const shaft = this.mesh(new Mesh(new CylinderGeometry(0.8, 0.8, 30, 5), glass), this.body)
    shaft.rotation.x = Math.PI / 2
    const head = this.mesh(new Mesh(new OctahedronGeometry(3.5, 0), new MeshBasicMaterial({ color: '#e8fcff' })), this.body)
    head.scale.set(0.8, 0.8, 2.6)
    head.position.z = 19
    this.mesh(new Mesh(new SphereGeometry(6, 10, 8), glowMaterial('#9fe7ff', 0.4)), this.body).position.z = 18
    for (const turn of [0, Math.PI / 2]) {
      const fin = this.mesh(new Mesh(new OctahedronGeometry(2.5, 0), glass.clone()), this.body)
      fin.scale.set(turn ? 0.3 : 1.6, turn ? 1.6 : 0.3, 2)
      fin.position.z = -13
    }
    if (big) {
      for (let index = 0; index < 3; index += 1) {
        const shard = this.mesh(new Mesh(new OctahedronGeometry(2.4, 0), new MeshBasicMaterial({ color: '#bff4ff' })), this.body)
        shard.scale.set(0.6, 0.6, 1.8)
        this.shards.push(shard)
      }
    }
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    this.shards.forEach((shard, index) => {
      const turn = ctx.t * 12 + index / this.shards.length * Math.PI * 2
      shard.position.set(Math.cos(turn) * 7, Math.sin(turn) * 7, 6)
    })
    const rate = this.big ? 110 : 60
    for (let index = 0, count = Math.ceil(ctx.dt * rate); index < count; index += 1) {
      const spread = this.big ? 14 : 6
      ctx.fx.glow.emit({ x: at.x + (Math.random() - 0.5) * spread, y: at.y + (Math.random() - 0.5) * spread, z: at.z + (Math.random() - 0.5) * spread, life: 0.35, size: this.big ? 6 : 4, sizeEnd: 1, color: colour(Math.random() < 0.3 ? '#ffffff' : '#9fe7ff'), alpha: 0.9 })
    }
    ctx.lights.light(at.x, at.y, at.z, '#9fe7ff', this.big ? 1.4 : 0.5, this.big ? 180 : 110)
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: this.big ? 30 : 12, speed: this.big ? 170 : 110, color: colour('#ffffff'), colorEnd: colour('#5fd0ff'), size: this.big ? 6 : 4, life: 0.35 })
  }
}

// Crystals bursting on what they struck: shards of crystal flung out and falling, glinting, a ring of cold light, and sparkles. Shatter's are bigger than a shard
// arrow's.
export class CrystalBurstVisual extends Visual {
  private readonly shards: Array<{ mesh: Mesh; vx: number; vy: number; vz: number; spin: number }> = []
  private readonly radius: number

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, private readonly big: boolean) {
    super(parent)
    this.radius = entity.radius
    const height = 34
    this.group.position.set(entity.position.x, height, entity.position.y)
    const glass = new MeshStandardMaterial({ color: '#d6f6ff', roughness: 0.05, metalness: 0.4, emissive: '#5fd0ff', emissiveIntensity: 1.2, transparent: true, opacity: 0.95 })
    const count = big ? 16 : 10
    for (let index = 0; index < count; index += 1) {
      const angle = index / count * Math.PI * 2 + Math.random() * 0.4
      const speed = this.radius * (big ? 2.4 : 2) * (0.6 + Math.random() * 0.5)
      const mesh = this.mesh(new Mesh(new OctahedronGeometry(big ? 4.5 : 3.2, 0), index === 0 ? glass : glass.clone()))
      mesh.scale.set(0.7, 1.8, 0.7)
      this.shards.push({ mesh, vx: Math.cos(angle) * speed, vy: 80 + Math.random() * 120, vz: Math.sin(angle) * speed, spin: (Math.random() - 0.5) * 20 })
    }
    burst(ctx, { x: entity.position.x, y: height, z: entity.position.y }, { count: big ? 40 : 20, speed: this.radius * 2.4, color: colour('#ffffff'), colorEnd: colour('#5fd0ff'), size: big ? 6 : 4, life: 0.4, up: 0.6 })
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    if (age > 0.8) return false
    for (const shard of this.shards) {
      shard.mesh.position.set(shard.vx * age, Math.max(-30, shard.vy * age - 260 * age * age), shard.vz * age)
      shard.mesh.rotation.set(shard.spin * age, shard.spin * age * 0.7, 0)
      shard.mesh.visible = age < 0.65
    }
    const { x, z } = this.group.position
    const k = easeOut(age / 0.4)
    ctx.glowDecals.ring(x, z, this.radius * k, this.radius * k + 4, '#bff4ff', 0.9 * (1 - k))
    ctx.glowDecals.disc(x, z, this.radius * 0.8, '#5fd0ff', 0.25 * (1 - k))
    if (age < 0.2) ctx.lights.light(x, 40, z, '#9fe7ff', this.big ? 3 : 1.5, 200)
    return true
  }
}

// ---------------------------------------------------------------------------------------------- the Sniper

// Steady Aim's shot: a long streak of hot gold, longer and thicker the longer the bead was held, a flash at the muzzle with a ring of smoke, a trail of smoke behind
// it, and sparks where it strikes.
export class SniperShotVisual extends ShotVisual {
  private readonly power: number

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent, entity, ctx)
    const band = Number(entity.defId.replace('steady-shot-', '')) || 1
    this.power = Math.min(1, (band - 1) / 9)
    const thick = 1 + this.power * 1.6
    const streak = this.mesh(new Mesh(new CylinderGeometry(1.4 * thick, 0.3, 60 + this.power * 90, 6), glowMaterial('#fff4c8', 0.95)), this.body)
    streak.rotation.x = Math.PI / 2
    streak.position.z = -(30 + this.power * 45)
    this.mesh(new Mesh(new SphereGeometry(4 * thick, 10, 8), glowMaterial('#ffd36a', 0.8)), this.body)
    const model = ctx.models.modelOf(entity.ownerId)
    const muzzle = { x: entity.origin.x, y: model ? model.height * 0.6 : 40, z: entity.origin.y }
    burst(ctx, muzzle, { count: 14 + Math.round(this.power * 30), speed: 140 + this.power * 140, color: colour('#ffffff'), colorEnd: colour('#ff9a2e'), size: 6 + this.power * 6, life: 0.2 })
    burst(ctx, muzzle, { count: 6 + Math.round(this.power * 10), speed: 50, color: colour('#a8a090'), size: 14, life: 0.9, puff: true, alpha: 0.35, up: 0.4 })
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    if (this.age(ctx) < 0.06) ctx.lights.light(at.x, at.y, at.z, '#ffd36a', 3 + this.power * 4, 220)
    for (let index = 0, count = Math.ceil(ctx.dt * (40 + this.power * 60)); index < count; index += 1) {
      ctx.fx.puff.emit({ ...at, vy: 6, life: 0.6 + this.power * 0.5, size: 4 + this.power * 4, sizeEnd: 12 + this.power * 10, color: colour('#bdb6a8'), alpha: 0.25 })
    }
    ctx.lights.light(at.x, at.y, at.z, '#ffd36a', 0.6 + this.power, 140)
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 16 + Math.round(this.power * 30), speed: 160 + this.power * 120, color: colour('#fff4c8'), colorEnd: colour('#ff6a1f'), size: 5 + this.power * 4, life: 0.3 })
  }
}

// Scan: a sweep of the ground: a ring of amber light, a beam turning round it like a lighthouse's, the ground scored in a grid, and a ping going out from the middle
// every second.
export class ScanVisual extends Visual {
  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    if (gone > 0.4) return false
    if (entity) this.group.position.set(entity.position.x, 0, entity.position.y)
    const { x, z } = this.group.position
    const r = entity?.radius ?? 200
    const age = this.age(ctx)
    const fade = Math.min(1, age / 0.25) * (1 - gone / 0.4)
    const css = '#ffd36a'
    ctx.decals.disc(x, z, r, '#1a1406', 0.15 * fade)
    ctx.glowDecals.circle(x, z, r, 2.5, css, 0.7 * fade)
    const sweep = age * 2.8
    for (let index = 0; index < 6; index += 1) {
      const from = sweep - (index + 1) * 0.12
      ctx.glowDecals.wedge(x, z, r, from, from + 0.12, css, (0.32 - index * 0.05) * fade)
    }
    ctx.glowDecals.line({ x, y: z }, { x: x + Math.cos(sweep) * r, y: z + Math.sin(sweep) * r }, 2.5, '#fff4c8', 0.9 * fade)
    for (let index = 1; index < 4; index += 1) ctx.glowDecals.circle(x, z, r * index / 4, 1, css, 0.18 * fade)
    for (const turn of [0, Math.PI / 2]) {
      ctx.glowDecals.line({ x: x - Math.cos(turn) * r, y: z - Math.sin(turn) * r }, { x: x + Math.cos(turn) * r, y: z + Math.sin(turn) * r }, 1, css, 0.2 * fade)
    }
    const ping = age % 1
    ctx.glowDecals.ring(x, z, r * ping, r * ping + 4, '#fff4c8', 0.6 * (1 - ping) * fade)
    return true
  }
}
