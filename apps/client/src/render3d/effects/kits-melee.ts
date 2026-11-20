import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import { BEAM_HALF_WIDTH, BEAM_LENGTH, HOWL_HALF_ANGLE } from '../../../../../packages/shared/src/index.ts'
import type { RenderedEntity } from '../../game-state.ts'
import { HumanoidModel } from '../models/humanoid.ts'
import { ease, easeOut } from '../models/model.ts'
import { colour, lerp, seededRandom, hashString, yawToward } from '../space.ts'
import { jitter } from '../terrain-mesh.ts'
import { burst, headingOf, lit, ShotVisual, type Point3 } from './kits.ts'
import { glowMaterial, Visual, type EffectContext } from './visual.ts'

// The effects of the melee champions that came later: the Hellhound, Stone, the Vulture, Blade and Sorin. Each is drawn from what its entity is (its id), as the
// others are (kits.ts).

// ---------------------------------------------------------------------------------------------- helpers

// Where an entity's owner stands, and the way from it to a point (east when it is right on it, or gone).
function fromOwner(entity: RenderedEntity, ctx: EffectContext): { x: number; y: number } {
  const owner = ctx.characters.get(entity.ownerId)
  if (!owner) return entity.facing ?? { x: 1, y: 0 }
  const dx = entity.position.x - owner.position.x
  const dy = entity.position.y - owner.position.y
  const length = Math.hypot(dx, dy)
  return length < 1e-3 ? entity.facing ?? { x: 1, y: 0 } : { x: dx / length, y: dy / length }
}

// Blood thrown out of a wound: dark drops that arc and fall, and a fine red mist.
export function bloodSpray(ctx: EffectContext, at: Point3, amount: number, toward?: { x: number; y: number }): void {
  for (let index = 0; index < amount; index += 1) {
    const angle = toward ? Math.atan2(toward.y, toward.x) + (Math.random() - 0.5) * 1.6 : Math.random() * Math.PI * 2
    const speed = 60 + Math.random() * 150
    ctx.fx.puff.emit({
      x: at.x, y: at.y, z: at.z,
      vx: Math.cos(angle) * speed, vy: 40 + Math.random() * 120, vz: Math.sin(angle) * speed,
      life: 0.5 + Math.random() * 0.4, size: 2.5 + Math.random() * 3.5, sizeEnd: 1.5,
      color: colour(Math.random() < 0.5 ? '#8a0a14' : '#b3121f'), colorEnd: colour('#3a0408'), alpha: 1, gravity: -620, drag: 0.6,
    })
  }
  for (let index = 0; index < amount / 3; index += 1) {
    ctx.fx.puff.emit({ x: at.x + (Math.random() - 0.5) * 10, y: at.y, z: at.z + (Math.random() - 0.5) * 10, vx: (Math.random() - 0.5) * 50, vy: 10, vz: (Math.random() - 0.5) * 50, life: 0.5, size: 10, sizeEnd: 22, color: colour('#7a0a12'), alpha: 0.35 })
  }
}

// Splashes of blood on the ground round a point, the same each frame for the same seed.
function bloodSplats(ctx: EffectContext, x: number, z: number, seed: number, count: number, spread: number, size: number, alpha: number): void {
  const random = seededRandom(seed)
  for (let index = 0; index < count; index += 1) {
    const angle = random() * Math.PI * 2
    const out = Math.sqrt(random()) * spread
    const r = size * (0.4 + random() * 0.8)
    ctx.decals.softDisc(x + Math.cos(angle) * out, z + Math.sin(angle) * out, r, index % 3 ? '#5a060c' : '#7a0a12', alpha, 0.35)
  }
}

// ---------------------------------------------------------------------------------------------- the Hellhound

export type ClawKind = 'plain' | 'bleed' | 'final'

// What a slash of Rake leaves on what it struck: glowing claw marks torn across it (three, or five for the last), a spray of blood, and blood on the ground. A slash into
// a wound already bleeding is darker and wetter, and throws far more blood; the third, which roots, burns: its marks are of fire, with a shock ring and embers.
export class ClawMarkVisual extends Visual {
  private readonly streaks: Array<{ mesh: Mesh<PlaneGeometry, MeshBasicMaterial>; core: Mesh<PlaneGeometry, MeshBasicMaterial>; delay: number }> = []
  private readonly dir: { x: number; y: number }
  private readonly seed: number

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, private readonly kind: ClawKind) {
    super(parent)
    this.dir = fromOwner(entity, ctx)
    this.seed = hashString(entity.id)
    this.group.position.set(entity.position.x, 0, entity.position.y)
    this.group.rotation.y = yawToward(this.dir.x, this.dir.y)
    const count = kind === 'final' ? 5 : 3
    const length = kind === 'final' ? 80 : 58
    const tint = kind === 'final' ? '#ffb03a' : kind === 'bleed' ? '#ff2438' : '#ff7a4a'
    for (let index = 0; index < count; index += 1) {
      const across = (index - (count - 1) / 2) * (kind === 'final' ? 9 : 10)
      const holder = new Group()
      this.group.add(holder)
      // Laid across the way the slash went, tilted up toward the camera, each a little further on.
      holder.position.set(across * 0.3, 34 + across * 0.5, across)
      holder.rotation.set(-1.0, 0, 0.7)
      const mesh = this.mesh(new Mesh(new PlaneGeometry(length, kind === 'final' ? 9 : 6), glowMaterial(tint, 0.95)), holder)
      mesh.material.side = DoubleSide
      const core = this.mesh(new Mesh(new PlaneGeometry(length, 2.2), glowMaterial('#fff2e0', 1)), holder)
      core.material.side = DoubleSide
      core.position.z = 0.2
      this.streaks.push({ mesh, core, delay: index * 0.025 })
    }
    const at = { x: entity.position.x, y: 34, z: entity.position.y }
    if (kind === 'plain') {
      bloodSpray(ctx, at, 14, this.dir)
      burst(ctx, at, { count: 10, speed: 120, color: colour('#ffd0a0'), colorEnd: colour('#ff5a1a'), size: 4, life: 0.25 })
    } else if (kind === 'bleed') {
      bloodSpray(ctx, at, 40, this.dir)
      bloodSpray(ctx, at, 14)
    } else {
      bloodSpray(ctx, at, 30, this.dir)
      burst(ctx, at, { count: 40, speed: 220, color: colour('#ffe08a'), colorEnd: colour('#d1300c'), size: 7, life: 0.5, up: 0.8 })
      burst(ctx, { ...at, y: 6 }, { count: 18, speed: 90, color: colour('#3a2a24'), size: 18, life: 0.8, puff: true, alpha: 0.45, up: 0.2 })
    }
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    const life = this.kind === 'final' ? 0.75 : 0.55
    if (age > life + 0.6) return false
    for (const { mesh, core, delay } of this.streaks) {
      const k = (age - delay) / 0.09
      const grow = Math.max(0.01, easeOut(Math.min(1, Math.max(0, k))))
      mesh.scale.x = grow
      core.scale.x = grow
      // The slash wipes across: it grows from one end.
      mesh.position.x = (1 - grow) * -20
      core.position.x = mesh.position.x
      const fade = 1 - ease((age - 0.12) / (life - 0.12))
      mesh.material.opacity = 0.95 * fade
      core.material.opacity = fade
      mesh.visible = core.visible = age < life
    }
    const { x, z } = this.group.position
    const ground = 1 - ease((age - 0.4) / 0.7)
    // Blood on the ground: dark splashes, more for a bleeding wound, and the claw's rake on the earth.
    bloodSplats(ctx, x, z, this.seed, this.kind === 'plain' ? 4 : 9, this.kind === 'plain' ? 18 : 30, this.kind === 'plain' ? 6 : 9, 0.7 * ground)
    const side = { x: -this.dir.y, y: this.dir.x }
    for (let index = -1; index <= 1; index += 1) {
      const off = index * 9
      const from = { x: x + side.x * 26 + this.dir.x * off, y: z + side.y * 26 + this.dir.y * off }
      const to = { x: x - side.x * 26 + this.dir.x * (off + 10), y: z - side.y * 26 + this.dir.y * (off + 10) }
      ctx.decals.line(from, to, 3, this.kind === 'final' ? '#2a0a04' : '#4a050a', 0.55 * ground)
    }
    if (this.kind === 'final') {
      const ring = easeOut(age / 0.4)
      ctx.glowDecals.ring(x, z, 20 + ring * 80, 26 + ring * 84, '#ff8a2a', 0.8 * (1 - ring))
      if (age < 0.4) ctx.lights.light(x, 40, z, '#ff6a1a', 4 * (1 - age / 0.4), 260)
      if (Math.random() < ctx.dt * 40 * ground) ctx.fx.glow.emit({ x: x + (Math.random() - 0.5) * 40, y: 4, z: z + (Math.random() - 0.5) * 40, vy: 50, life: 0.6, size: 6, sizeEnd: 1, color: colour('#ffb03a'), colorEnd: colour('#d1300c'), alpha: 0.9 })
    } else if (age < 0.2) {
      ctx.lights.light(x, 36, z, this.kind === 'bleed' ? '#ff2438' : '#ff7a4a', 2 * (1 - age / 0.2), 160)
    }
    return true
  }
}

// A slash of Rake flying out: three claws of hellfire raking forward in a curve, shedding embers.
export class RakeSlashVisual extends Visual {
  private readonly claws: Mesh<TorusGeometry, MeshBasicMaterial>[] = []
  private last?: Point3

  constructor(parent: Group, entity: RenderedEntity, again: boolean) {
    super(parent)
    const half = entity.box?.halfWidth ?? 30
    for (let index = 0; index < 3; index += 1) {
      const claw = this.mesh(new Mesh(new TorusGeometry(half * (0.8 + index * 0.18), 2.2 - index * 0.4, 4, 24, Math.PI * 0.75), glowMaterial(index === 0 ? '#fff0d0' : again ? '#ff3a24' : '#ff7a3a', 0.9 - index * 0.15)))
      // Laid flat, its bow forward.
      claw.rotation.set(Math.PI / 2, 0, Math.PI / 2 - Math.PI * 0.375)
      claw.position.set(0, 30 - index * 2, -index * 7)
      this.claws.push(claw)
    }
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) {
      if (this.last) burst(ctx, this.last, { count: 10, speed: 70, color: colour('#ff7a3a'), size: 4, life: 0.25 })
      return false
    }
    this.group.position.set(entity.position.x, 0, entity.position.y)
    this.group.rotation.y = headingOf(entity)
    const flicker = 0.85 + Math.sin(ctx.t * 50) * 0.15
    this.claws.forEach((claw, index) => {
      claw.material.opacity = (0.9 - index * 0.15) * flicker
    })
    this.last = { x: entity.position.x, y: 30, z: entity.position.y }
    for (let index = 0, count = Math.ceil(ctx.dt * 90); index < count; index += 1) {
      const across = (Math.random() - 0.5) * (entity.box?.halfWidth ?? 30) * 1.6
      const yaw = this.group.rotation.y
      ctx.fx.glow.emit({ x: entity.position.x + Math.cos(yaw) * across, y: 26 + Math.random() * 8, z: entity.position.y - Math.sin(yaw) * across, vy: 30, life: 0.3, size: 6, sizeEnd: 1, color: colour('#ffb03a'), colorEnd: colour('#c4302b'), alpha: 0.9 })
    }
    ctx.lights.light(entity.position.x, 30, entity.position.y, '#ff5a1a', 1.2, 150)
    return true
  }
}

// Howl: the cry rolling out over the cone: shock fronts of dark fire one after another, the ground scorched under them, embers and ash blown forward, and a glow at
// the Hellhound's jaws.
export class HowlVisual extends Visual {
  private readonly apex: { x: number; y: number }
  private readonly facing: { x: number; y: number }
  private readonly range: number

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.facing = entity.facing ?? { x: 1, y: 0 }
    this.range = (entity.box?.halfLength ?? 130) * 2
    this.apex = { x: entity.position.x - this.facing.x * this.range / 2, y: entity.position.y - this.facing.y * this.range / 2 }
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    if (age > 1.1) return false
    const { x, y } = this.apex
    const heading = Math.atan2(this.facing.y, this.facing.x)
    const from = heading - HOWL_HALF_ANGLE
    const to = heading + HOWL_HALF_ANGLE
    const fade = 1 - ease((age - 0.3) / 0.8)
    ctx.decals.wedge(x, y, this.range, from, to, '#1a0604', 0.35 * fade)
    // Three fronts, each a little after the last, rolling out to the edge.
    for (let index = 0; index < 3; index += 1) {
      const k = (age - index * 0.1) / 0.45
      if (k <= 0 || k >= 1) continue
      const reach = easeOut(k) * this.range
      ctx.glowDecals.ring(x, y, Math.max(0, reach - 14), reach, index === 0 ? '#ff7a2a' : '#c4302b', 0.85 * (1 - k), from, to)
      ctx.decals.ring(x, y, Math.max(0, reach - 24), Math.max(0, reach - 8), '#2a0804', 0.35 * (1 - k), from, to)
    }
    if (age < 0.45) {
      for (let index = 0, count = Math.ceil(ctx.dt * 260); index < count; index += 1) {
        const angle = heading + (Math.random() * 2 - 1) * HOWL_HALF_ANGLE
        const speed = this.range * (1.4 + Math.random() * 1.2)
        const ember = Math.random() < 0.6
        const system = ember ? ctx.fx.glow : ctx.fx.puff
        system.emit({
          x: x + Math.cos(angle) * 20, y: 20 + Math.random() * 20, z: y + Math.sin(angle) * 20,
          vx: Math.cos(angle) * speed, vy: 10 + Math.random() * 30, vz: Math.sin(angle) * speed,
          life: 0.5, size: ember ? 6 : 16, sizeEnd: ember ? 1 : 30,
          color: colour(ember ? '#ffb03a' : '#2a1410'), colorEnd: colour(ember ? '#c4302b' : '#1a0a08'), alpha: ember ? 0.95 : 0.4, drag: 1.6,
        })
      }
      ctx.lights.light(x + this.facing.x * 40, 40, y + this.facing.y * 40, '#ff5a1a', 3 * (1 - age / 0.45), 300)
    }
    return true
  }
}

// The blood a bleeding enemy leaves where it is struck: splashes on the ground that dry and fade, and a few drops still falling.
export class BloodTrailVisual extends Visual {
  private readonly seed: number

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.seed = hashString(entity.id)
    this.group.position.set(entity.position.x, 0, entity.position.y)
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    if (gone > 0.5) return false
    const { x, z } = this.group.position
    const fade = (1 - ease(((entity?.progress ?? 1) - 0.6) / 0.4)) * (1 - gone / 0.5)
    bloodSplats(ctx, x, z, this.seed, 6, entity?.radius ?? 16, 7, 0.75 * fade)
    if (this.age(ctx) < 0.6 && Math.random() < ctx.dt * 14) ctx.fx.puff.emit({ x: x + (Math.random() - 0.5) * 14, y: 30, z: z + (Math.random() - 0.5) * 14, vy: -20, life: 0.4, size: 3, color: colour('#8a0a14'), alpha: 1, gravity: -500 })
    return true
  }
}

// ---------------------------------------------------------------------------------------------- Stone

// Tether: a stone weight on a rope, whirled out from Stone's hand, the rope trailing back to him.
export class TetherVisual extends ShotVisual {
  private readonly rope: Mesh<CylinderGeometry, MeshBasicMaterial>

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent, entity, ctx)
    this.mesh(new Mesh(jitter(new DodecahedronGeometry(8, 0), 0.12, 61), lit('#8a8270', { roughness: 0.9 })), this.body)
    this.mesh(new Mesh(new TorusGeometry(5, 1.4, 4, 10), lit('#4a4236', { roughness: 0.8 })), this.body).position.z = -8
    this.rope = new Mesh(new CylinderGeometry(1.1, 1.1, 1, 5).translate(0, 0.5, 0).rotateX(Math.PI / 2), new MeshBasicMaterial({ color: '#b9a88c' }))
    this.mesh(this.rope, parent)
  }

  protected fly(entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    this.body.rotation.set(ctx.t * 12, ctx.t * 7, 0)
    const model = ctx.models.modelOf(entity.ownerId)
    const hand = model instanceof HumanoidModel ? model.handPoint('right') : { x: entity.origin.x, y: 36, z: entity.origin.y }
    const span = new Vector3(at.x - hand.x, at.y - hand.y, at.z - hand.z)
    this.rope.position.set(hand.x, hand.y, hand.z)
    this.rope.scale.set(1, 1, Math.max(1, span.length()))
    this.rope.lookAt(at.x, at.y, at.z)
    if (Math.random() < ctx.dt * 30) ctx.fx.puff.emit({ ...at, life: 0.4, size: 5, sizeEnd: 10, color: colour('#b9a88c'), alpha: 0.4 })
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    this.rope.visible = false
    burst(ctx, at, { count: 14, speed: 110, color: colour('#b9a88c'), size: 10, life: 0.5, puff: true, alpha: 0.5 })
    burst(ctx, at, { count: 8, speed: 120, color: colour('#8a8270'), size: 4, life: 0.4, puff: true, gravity: -400, up: 1 })
  }

  override dispose(): void {
    this.rope.removeFromParent()
    super.dispose()
  }
}

// ---------------------------------------------------------------------------------------------- the Vulture

// The Spider Mine: a squat round mine with a carapace of plates, its legs folded under it and a green eye winking on top. It is set down in plain sight, and after a
// moment burrows into the ground in a puff of dirt; then only its eye and a faint ring show, to its own team (the rest no longer see it at all). When an enemy steps on
// it, the earth bursts as the spider springs out (`mine-spider`).
export class SpiderMineVisual extends Visual {
  private readonly mine = new Group()
  private readonly eye: Mesh<SphereGeometry, MeshBasicMaterial>
  private readonly legs: Group[] = []
  private readonly shown: number
  private burrowed = false

  constructor(parent: Group, entity: RenderedEntity, shownSeconds: number) {
    super(parent)
    this.shown = shownSeconds
    this.group.position.set(entity.position.x, 0, entity.position.y)
    this.group.add(this.mine)
    const shell = lit('#3a3a2a', { roughness: 0.4, metalness: 0.6 })
    const plate = lit('#5f6b3a', { roughness: 0.5, metalness: 0.4 })
    const dark = lit('#1e1e16', { roughness: 0.8 })
    this.mesh(new Mesh(new CylinderGeometry(13, 15, 6, 12), shell), this.mine).position.y = 3
    this.mesh(new Mesh(new SphereGeometry(12, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), plate), this.mine).position.y = 6
    for (let index = 0; index < 6; index += 1) {
      const turn = index / 6 * Math.PI * 2
      const spike = this.mesh(new Mesh(new ConeGeometry(1.6, 6, 4), dark), this.mine)
      spike.position.set(Math.cos(turn) * 9, 13, Math.sin(turn) * 9)
      spike.rotation.set(Math.sin(turn) * 0.5, 0, -Math.cos(turn) * 0.5)
    }
    for (let index = 0; index < 8; index += 1) {
      const turn = (index + 0.5) / 8 * Math.PI * 2
      const leg = new Group()
      leg.position.set(Math.cos(turn) * 12, 3, Math.sin(turn) * 12)
      leg.rotation.y = -turn
      this.mine.add(leg)
      this.mesh(new Mesh(new CylinderGeometry(0.9, 0.6, 12, 4).translate(0, 6, 0).rotateZ(-Math.PI / 2 + 0.5), dark), leg)
      this.legs.push(leg)
    }
    this.eye = this.mesh(new Mesh(new SphereGeometry(2.6, 8, 6), new MeshBasicMaterial({ color: '#a6ff4d' })), this.mine)
    this.eye.position.y = 13
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const { x, z } = this.group.position
    if (!entity) {
      // Set off: the earth bursts open.
      burst(ctx, { x, y: 4, z }, { count: 22, speed: 140, color: colour('#5a4a36'), size: 12, life: 0.6, puff: true, alpha: 0.6, up: 0.9 })
      burst(ctx, { x, y: 6, z }, { count: 14, speed: 120, color: colour('#3a2e22'), size: 4, life: 0.6, puff: true, gravity: -500, up: 1.2 })
      burst(ctx, { x, y: 8, z }, { count: 12, speed: 90, color: colour('#c8ff6a'), size: 5, life: 0.35 })
      return false
    }
    const age = this.age(ctx)
    // Set down: it drops into place and its legs fold.
    const set = easeOut(Math.min(1, age / 0.2))
    const sink = ease(Math.min(1, Math.max(0, (age - this.shown + 0.25) / 0.35)))
    this.mine.position.y = (1 - set) * 14 - sink * 13
    this.legs.forEach((leg, index) => {
      leg.rotation.z = Math.sin(age * 30 + index) * 0.15 * (1 - set) + sink * 0.6
    })
    if (!this.burrowed && sink > 0.3) {
      this.burrowed = true
      burst(ctx, { x, y: 4, z }, { count: 16, speed: 70, color: colour('#6a5a44'), size: 10, life: 0.6, puff: true, alpha: 0.55, up: 0.4 })
    }
    const blink = Math.sin(ctx.t * (sink >= 1 ? 3 : 8)) > 0.6 ? 1 : 0.25
    this.eye.material.color.set(blink > 0.5 ? '#c8ff6a' : '#3a5a1a')
    // The ring it goes off in, and while it is buried the dirt it is under.
    const radius = entity.radius
    ctx.glowDecals.circle(x, z, radius, 2, '#a6ff4d', (sink >= 1 ? 0.25 : 0.5) * (0.6 + 0.4 * blink))
    if (sink > 0) ctx.decals.softDisc(x, z, 20, '#3a2e22', 0.55 * sink, 0.5)
    if (blink > 0.5) ctx.lights.light(x, 10, z, '#a6ff4d', 0.4, 60)
    return true
  }
}

// The spider out of the mine, running its prey down: a black body and a green-marked back on eight legs that skitter, low to the ground, kicking up dust, its eyes
// glowing. It bites as it reaches it (`mine-bite`).
export class SpiderVisual extends Visual {
  private readonly body = new Group()
  private readonly legs: Group[] = []
  private last?: Point3

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.group.add(this.body)
    const black = lit('#1a1814', { roughness: 0.5, metalness: 0.2 })
    const mark = lit('#5f8f2e', { emissive: '#a6ff4d', emissiveIntensity: 0.6 })
    this.mesh(new Mesh(new SphereGeometry(7, 10, 8), black), this.body).scale.set(1, 0.7, 1.3)
    this.mesh(new Mesh(new SphereGeometry(4.5, 8, 6), black), this.body).position.set(0, 0, 9)
    this.mesh(new Mesh(new SphereGeometry(3, 8, 6), mark), this.body).position.set(0, 4.5, -2)
    for (const side of [-1, 1]) this.mesh(new Mesh(new SphereGeometry(1.1, 6, 4), new MeshBasicMaterial({ color: '#c8ff6a' })), this.body).position.set(side * 1.8, 1.5, 12.5)
    for (let index = 0; index < 8; index += 1) {
      const side = index < 4 ? -1 : 1
      const row = index % 4
      const leg = new Group()
      leg.position.set(side * 4, 0, 4 - row * 3.5)
      leg.rotation.y = side * (Math.PI / 2 - 0.5 + row * 0.35)
      this.body.add(leg)
      this.mesh(new Mesh(new CylinderGeometry(0.8, 0.5, 12, 4).translate(0, 6, 0).rotateZ(-Math.PI / 2 + 0.7), black), leg)
      this.legs.push(leg)
    }
    this.group.position.set(entity.position.x, 0, entity.position.y)
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) {
      if (this.last) burst(ctx, this.last, { count: 10, speed: 80, color: colour('#a6ff4d'), size: 4, life: 0.3 })
      return false
    }
    const age = this.age(ctx)
    // It springs up out of the ground, then runs low.
    const spring = age < 0.3 ? Math.sin(age / 0.3 * Math.PI) * 30 : 0
    this.group.position.set(entity.position.x, 6 + spring, entity.position.y)
    this.group.rotation.y = headingOf(entity)
    this.legs.forEach((leg, index) => {
      leg.rotation.x = Math.sin(ctx.t * 40 + index * 1.7) * 0.4
    })
    this.body.rotation.z = Math.sin(ctx.t * 30) * 0.06
    this.last = { x: entity.position.x, y: 10, z: entity.position.y }
    if (Math.random() < ctx.dt * 30) ctx.fx.puff.emit({ x: entity.position.x, y: 3, z: entity.position.y, vy: 10, life: 0.4, size: 6, sizeEnd: 14, color: colour('#8a7a5e'), alpha: 0.35 })
    ctx.decals.softDisc(entity.position.x, entity.position.y, 12, '#000000', 0.3, 0.5)
    return true
  }
}

// The spider's bite: green venom spattering, and a ring of carrion green.
export class VenomBiteVisual extends Visual {
  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent)
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const at = { x: entity.position.x, y: 30, z: entity.position.y }
    burst(ctx, at, { count: 26, speed: 140, color: colour('#c8ff6a'), colorEnd: colour('#3a6a14'), size: 5, life: 0.45, up: 0.8 })
    burst(ctx, at, { count: 12, speed: 90, color: colour('#5f8f2e'), size: 4, life: 0.6, puff: true, gravity: -400, up: 1 })
    burst(ctx, at, { count: 8, speed: 40, color: colour('#3a4a1a'), size: 16, life: 0.9, puff: true, alpha: 0.4, up: 0.8 })
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    if (age > 0.6) return false
    const { x, z } = this.group.position
    const k = easeOut(age / 0.5)
    ctx.glowDecals.ring(x, z, 10 + k * 50, 14 + k * 54, '#a6ff4d', 0.8 * (1 - k))
    if (age < 0.2) ctx.lights.light(x, 30, z, '#a6ff4d', 2, 140)
    return true
  }
}

// ---------------------------------------------------------------------------------------------- Blade

// One of Blade's knives: a long steel blade and a wrapped grip. Thrown, it spins end over end with a silver streak behind it; called back, it flies point first.
export class BladeKnifeVisual extends ShotVisual {
  private readonly blade = new Group()

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext, private readonly spin: boolean) {
    super(parent, entity, ctx)
    this.body.add(this.blade)
    const steel = lit('#e0e6ee', { metalness: 0.95, roughness: 0.18 })
    const edge = this.mesh(new Mesh(new ConeGeometry(2.6, 22, 4), steel), this.blade)
    edge.position.y = 8
    edge.scale.z = 0.35
    this.mesh(new Mesh(new BoxGeometry(8, 1.6, 2), lit('#5a5e66', { metalness: 0.7 })), this.blade).position.y = -3.5
    this.mesh(new Mesh(new CylinderGeometry(1.2, 1.2, 7, 6), lit('#2b2f36')), this.blade).position.y = -8
    if (!spin) this.blade.rotation.x = Math.PI / 2
  }

  protected fly(_entity: RenderedEntity, at: Point3, ctx: EffectContext): void {
    if (this.spin) this.blade.rotation.x = ctx.t * 28
    for (let index = 0, count = Math.ceil(ctx.dt * 60); index < count; index += 1) ctx.fx.glow.emit({ ...at, life: 0.22, size: 7, sizeEnd: 1, color: colour('#e8f0ff'), alpha: 0.6 })
  }

  protected override ended(at: Point3, ctx: EffectContext): void {
    burst(ctx, at, { count: 8, speed: 120, color: colour('#ffffff'), size: 3, life: 0.2 })
  }
}

// A knife lying where it landed: stuck point first in the ground, leaning, glinting now and then, with a faint ring round it so Blade can find it.
export class GroundKnifeVisual extends Visual {
  private readonly knife = new Group()
  private readonly phase: number

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent)
    this.phase = (hashString(entity.id) % 100) / 100 * Math.PI * 2
    this.group.position.set(entity.position.x, 0, entity.position.y)
    this.group.add(this.knife)
    const steel = lit('#e0e6ee', { metalness: 0.95, roughness: 0.18 })
    const edge = this.mesh(new Mesh(new ConeGeometry(2.6, 22, 4), steel), this.knife)
    edge.position.y = 4
    edge.rotation.x = Math.PI
    edge.scale.z = 0.35
    this.mesh(new Mesh(new BoxGeometry(8, 1.6, 2), lit('#5a5e66', { metalness: 0.7 })), this.knife).position.y = 15
    this.mesh(new Mesh(new CylinderGeometry(1.2, 1.2, 7, 6), lit('#2b2f36')), this.knife).position.y = 19.5
    this.knife.rotation.set(0.35, this.phase, 0.25)
    burst(ctx, { x: entity.position.x, y: 3, z: entity.position.y }, { count: 8, speed: 60, color: colour('#9a8a6a'), size: 6, life: 0.4, puff: true, alpha: 0.4 })
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) return false
    const { x, z } = this.group.position
    this.knife.scale.setScalar(Math.min(1, this.age(ctx) / 0.08))
    const glint = Math.max(0, Math.sin(ctx.t * 1.7 + this.phase)) ** 30
    ctx.glowDecals.circle(x, z, 14, 1.5, '#e0e6ee', 0.25 + glint * 0.5)
    if (glint > 0.5) ctx.fx.glow.emit({ x, y: 18, z, life: 0.15, size: 10, sizeEnd: 2, color: colour('#ffffff'), alpha: 0.9 })
    return true
  }
}

// Blade Dash landing: a whirl of cuts round where he lands, silver arcs flashing all round the circle, and sparks.
export class BladeBurstVisual extends Visual {
  private readonly arcs: Array<{ mesh: Mesh<RingGeometry, MeshBasicMaterial>; delay: number }> = []
  private readonly radius: number

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent)
    this.radius = entity.radius
    this.group.position.set(entity.position.x, 0, entity.position.y)
    for (let index = 0; index < 6; index += 1) {
      const start = index / 6 * Math.PI * 2
      const arc = this.mesh(new Mesh(new RingGeometry(this.radius * (0.55 + (index % 3) * 0.15), this.radius * (0.62 + (index % 3) * 0.15), 24, 1, start, Math.PI * 0.7), glowMaterial(index % 2 ? '#e0e6ee' : '#ffffff', 0.9)))
      arc.rotation.x = -Math.PI / 2
      arc.position.y = 20 + (index % 3) * 8
      arc.material.side = DoubleSide
      this.arcs.push({ mesh: arc, delay: index * 0.025 })
    }
    burst(ctx, { x: entity.position.x, y: 24, z: entity.position.y }, { count: 30, speed: this.radius * 2.2, color: colour('#ffffff'), colorEnd: colour('#9aa3ad'), size: 4, life: 0.3, up: 0.3 })
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    if (age > 0.5) return false
    for (const { mesh, delay } of this.arcs) {
      const k = Math.max(0, (age - delay) / 0.3)
      mesh.visible = k > 0 && k < 1
      mesh.rotation.z = k * 2.4
      mesh.material.opacity = 0.9 * (1 - k)
    }
    const { x, z } = this.group.position
    ctx.decals.disc(x, z, this.radius, '#1a1c20', 0.2 * (1 - age / 0.5))
    ctx.glowDecals.circle(x, z, this.radius, 2.5, '#e0e6ee', 0.7 * (1 - age / 0.5))
    if (age < 0.15) ctx.lights.light(x, 30, z, '#e8f0ff', 2, 180)
    return true
  }
}

// ---------------------------------------------------------------------------------------------- Sorin

// Dawn Beam: dawn breaking down the line: a blinding column of light from Sorin to the end of its reach, white at the core and gold round it, that flares, holds a
// moment and thins away; the ground burned gold under it, a sun flaring at his hand, motes of light rising all along it, and the light it throws.
export class DawnBeamVisual extends Visual {
  private readonly core: Mesh<CylinderGeometry, MeshBasicMaterial>
  private readonly halo: Mesh<CylinderGeometry, MeshBasicMaterial>
  private readonly outer: Mesh<CylinderGeometry, MeshBasicMaterial>
  private readonly sun: Mesh<SphereGeometry, MeshBasicMaterial>
  private readonly start: { x: number; y: number }
  private readonly dir: { x: number; y: number }

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent)
    const v = entity.velocity
    const speed = Math.hypot(v.x, v.y)
    this.dir = speed > 1e-6 ? { x: v.x / speed, y: v.y / speed } : entity.facing ?? { x: 1, y: 0 }
    this.start = { ...entity.origin }
    this.group.position.set(this.start.x, 36, this.start.y)
    this.group.rotation.y = yawToward(this.dir.x, this.dir.y)
    const along = (geometry: CylinderGeometry): CylinderGeometry => geometry.translate(0, 0.5, 0).rotateX(Math.PI / 2)
    this.core = this.mesh(new Mesh(along(new CylinderGeometry(1, 1, 1, 12, 1, true)), glowMaterial('#ffffff', 1)))
    this.halo = this.mesh(new Mesh(along(new CylinderGeometry(1, 1, 1, 16, 1, true)), glowMaterial('#ffe08a', 0.6)))
    this.outer = this.mesh(new Mesh(along(new CylinderGeometry(1, 1, 1, 16, 1, true)), glowMaterial('#ffb43a', 0.25)))
    for (const mesh of [this.core, this.halo, this.outer]) mesh.scale.z = BEAM_LENGTH
    this.sun = this.mesh(new Mesh(new SphereGeometry(1, 16, 12), glowMaterial('#fff2c0', 0.9)))
    const at = { x: this.start.x, y: 36, z: this.start.y }
    burst(ctx, at, { count: 50, speed: 260, color: colour('#ffffff'), colorEnd: colour('#ffb43a'), size: 8, life: 0.5, up: 0.6 })
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    if (age > 1.2) return false
    const flare = easeOut(Math.min(1, age / 0.08))
    const thin = 1 - ease((age - 0.25) / 0.55)
    const width = BEAM_HALF_WIDTH * (0.4 + flare * 0.9) * Math.max(0.05, thin)
    this.core.scale.set(width * 0.45, width * 0.45, BEAM_LENGTH)
    this.halo.scale.set(width, width, BEAM_LENGTH)
    this.outer.scale.set(width * 1.8, width * 1.8, BEAM_LENGTH)
    this.core.material.opacity = Math.max(0, thin)
    this.halo.material.opacity = 0.6 * Math.max(0, thin) * (0.85 + Math.sin(ctx.t * 40) * 0.15)
    this.outer.material.opacity = 0.25 * Math.max(0, thin)
    this.sun.scale.setScalar(Math.max(0.01, 40 * flare * Math.max(0, thin)))
    this.sun.material.opacity = 0.9 * Math.max(0, thin)
    const end = { x: this.start.x + this.dir.x * BEAM_LENGTH, y: this.start.y + this.dir.y * BEAM_LENGTH }
    const middle = { x: (this.start.x + end.x) / 2, y: (this.start.y + end.y) / 2 }
    const scorch = 1 - ease((age - 0.3) / 0.9)
    ctx.decals.box(middle, this.dir, BEAM_LENGTH / 2, BEAM_HALF_WIDTH * 1.1, '#3a2a08', 0.3 * scorch)
    ctx.glowDecals.box(middle, this.dir, BEAM_LENGTH / 2, BEAM_HALF_WIDTH * (0.6 + 0.6 * Math.max(0, thin)), '#ffd36a', 0.45 * scorch)
    if (thin > 0) {
      for (let index = 0, count = Math.ceil(ctx.dt * 220 * thin); index < count; index += 1) {
        const k = Math.random()
        const across = (Math.random() - 0.5) * BEAM_HALF_WIDTH * 2
        ctx.fx.glow.emit({
          x: lerp(this.start.x, end.x, k) - this.dir.y * across, y: 10 + Math.random() * 50, z: lerp(this.start.y, end.y, k) + this.dir.x * across,
          vx: this.dir.x * 120, vy: 40 + Math.random() * 80, vz: this.dir.y * 120,
          life: 0.6, size: 7, sizeEnd: 1, color: colour(Math.random() < 0.4 ? '#ffffff' : '#ffd36a'), alpha: 0.95,
        })
      }
      for (let index = 0; index <= 4; index += 1) {
        const k = index / 4
        ctx.lights.light(lerp(this.start.x, end.x, k), 50, lerp(this.start.y, end.y, k), '#ffe08a', 4 * thin, 260)
      }
    }
    return true
  }
}

// Dawnstep's landing: a shaft of light coming down on where he lands, a gold ring breaking out over the ground, feathers of light drifting down, and sparks.
export class DawnstepVisual extends Visual {
  private readonly shaft: Mesh<CylinderGeometry, MeshBasicMaterial>
  private readonly radius: number

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent)
    this.radius = entity.radius
    this.group.position.set(entity.position.x, 0, entity.position.y)
    this.shaft = this.mesh(new Mesh(new CylinderGeometry(this.radius * 0.5, this.radius * 0.8, 320, 18, 1, true).translate(0, 160, 0), glowMaterial('#ffe08a', 0.7)))
    const at = { x: entity.position.x, y: 20, z: entity.position.y }
    burst(ctx, at, { count: 36, speed: this.radius * 2.6, color: colour('#ffffff'), colorEnd: colour('#ffd36a'), size: 7, life: 0.45, up: 0.4 })
    burst(ctx, { ...at, y: 4 }, { count: 14, speed: 80, color: colour('#d8c8a0'), size: 14, life: 0.6, puff: true, alpha: 0.35, up: 0.2 })
    for (let index = 0; index < 10; index += 1) {
      const angle = Math.random() * Math.PI * 2
      ctx.fx.glow.emit({ x: at.x + Math.cos(angle) * this.radius * 0.6, y: 90 + Math.random() * 60, z: at.z + Math.sin(angle) * this.radius * 0.6, vx: Math.cos(angle) * 20, vy: -40, vz: Math.sin(angle) * 20, life: 1.2, size: 8, sizeEnd: 3, color: colour('#fff2c0'), alpha: 0.9, drag: 1 })
    }
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    if (age > 0.8) return false
    const { x, z } = this.group.position
    const k = easeOut(age / 0.45)
    this.shaft.material.opacity = 0.7 * (1 - ease(age / 0.4))
    this.shaft.scale.set(1 - k * 0.6, 1, 1 - k * 0.6)
    ctx.glowDecals.disc(x, z, this.radius, '#ffd36a', 0.4 * (1 - k))
    ctx.glowDecals.ring(x, z, this.radius * k, this.radius * k + 6, '#fff2c0', 0.9 * (1 - k))
    if (age < 0.3) ctx.lights.light(x, 60, z, '#ffe08a', 5 * (1 - age / 0.3), 260)
    return true
  }
}

// A smiting blow: a hammer of light comes down on what it strikes, and bursts on it in a ring of gold. The last, which stuns, is greater: a great hammer, a pillar of
// light, a gold ring rolling out far, and a crown of light turning over the stunned one's head.
export class SmiteVisual extends Visual {
  private readonly hammer = new Group()
  private readonly materials: MeshBasicMaterial[] = []
  private readonly pillar?: Mesh<CylinderGeometry, MeshBasicMaterial>
  private readonly crown?: Mesh<TorusGeometry, MeshBasicMaterial>
  private struck = false

  constructor(parent: Group, entity: RenderedEntity, private readonly final: boolean) {
    super(parent)
    this.group.position.set(entity.position.x, 0, entity.position.y)
    this.group.add(this.hammer)
    const size = final ? 1.7 : 1
    const head = this.mesh(new Mesh(new BoxGeometry(30 * size, 14 * size, 14 * size), glowMaterial('#fff2c0', 0.9)), this.hammer)
    head.position.y = 26 * size
    const haft = this.mesh(new Mesh(new CylinderGeometry(2 * size, 2 * size, 30 * size, 6), glowMaterial('#ffd36a', 0.85)), this.hammer)
    haft.position.y = 46 * size
    this.materials.push(head.material, haft.material)
    if (final) {
      this.pillar = this.mesh(new Mesh(new CylinderGeometry(26, 34, 260, 18, 1, true).translate(0, 130, 0), glowMaterial('#ffe08a', 0.6)))
      this.crown = this.mesh(new Mesh(new TorusGeometry(14, 2, 6, 24), glowMaterial('#fff2c0', 0.9)))
      this.crown.rotation.x = Math.PI / 2
    }
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    const life = this.final ? 1.3 : 0.6
    if (age > life) return false
    const { x, z } = this.group.position
    const fall = ease(Math.min(1, age / 0.12))
    this.hammer.position.y = (1 - fall) * 80 + 10
    this.hammer.rotation.z = (1 - fall) * -0.9
    const fade = 1 - ease((age - 0.15) / 0.35)
    for (const material of this.materials) material.opacity = 0.9 * fade
    this.hammer.visible = fade > 0
    if (!this.struck && fall >= 1) {
      this.struck = true
      const at = { x, y: 30, z }
      burst(ctx, at, { count: this.final ? 70 : 28, speed: this.final ? 260 : 150, color: colour('#ffffff'), colorEnd: colour('#ffb43a'), size: this.final ? 9 : 6, life: 0.5, up: 0.7 })
      if (this.final) burst(ctx, { ...at, y: 6 }, { count: 20, speed: 120, color: colour('#d8c8a0'), size: 18, life: 0.8, puff: true, alpha: 0.4, up: 0.2 })
    }
    const k = easeOut(Math.max(0, age - 0.1) / (this.final ? 0.6 : 0.35))
    const reach = this.final ? 150 : 60
    if (this.struck) {
      ctx.glowDecals.ring(x, z, reach * k, reach * k + (this.final ? 10 : 5), '#ffd36a', 0.9 * (1 - k))
      ctx.glowDecals.disc(x, z, this.final ? 60 : 30, '#ffe08a', 0.3 * (1 - k))
      if (age < 0.35) ctx.lights.light(x, 50, z, '#ffe08a', (this.final ? 7 : 3) * (1 - age / 0.35), this.final ? 340 : 200)
    }
    if (this.pillar) {
      this.pillar.material.opacity = 0.6 * (1 - ease((age - 0.1) / 0.6)) * (this.struck ? 1 : 0)
      this.pillar.scale.set(1 - k * 0.5, 1, 1 - k * 0.5)
    }
    if (this.crown) {
      const top = (ctx.models.topOf(this.nearestUnit(ctx)) ?? 70) + 16
      this.crown.position.y = top + Math.sin(ctx.t * 5) * 3
      this.crown.rotation.z = ctx.t * 4
      this.crown.material.opacity = 0.9 * (1 - ease((age - 0.8) / 0.5)) * (this.struck ? 1 : 0)
      if (this.struck && Math.random() < ctx.dt * 20) {
        const angle = ctx.t * 4 + Math.random()
        ctx.fx.glow.emit({ x: x + Math.cos(angle) * 14, y: top, z: z + Math.sin(angle) * 14, life: 0.4, size: 5, sizeEnd: 1, color: colour('#fff2c0'), alpha: 0.9 })
      }
    }
    return true
  }

  // Whoever is standing where it struck (it was laid on them).
  private nearestUnit(ctx: EffectContext): number {
    const { x, z } = this.group.position
    let best = -1
    let bestGap = Infinity
    for (const character of ctx.characters.values()) {
      const gap = Math.hypot(character.position.x - x, character.position.y - z)
      if (gap < bestGap) {
        bestGap = gap
        best = character.id
      }
    }
    return best
  }
}
