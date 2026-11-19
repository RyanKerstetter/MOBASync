import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  Vector2 as ThreeVector2,
  type ShaderMaterial,
  type Texture,
} from 'three'
import type { RenderedEntity } from '../../game-state.ts'
import { ease, easeOut } from '../models/model.ts'
import { colour, lerp, yawToward } from '../space.ts'
import { bubbleMaterial, fireMaterial, waterMaterial } from './fx-materials.ts'
import { glowMaterial, ShotHeight, Visual, type EffectContext } from './visual.ts'

// The Fire Mage's and Capricorn's abilities: fire and water.

// -------------------------------------------------------------------------------------------------- the Fire Mage

// Fireball: a ball of fire, turning, wrapped in flame, with a long trail of fire and smoke behind it, lighting the ground it
// flies over.
export class FireballVisual extends Visual {
  private readonly height: ShotHeight
  private readonly core: Mesh
  private readonly shell: Mesh<IcosahedronGeometry, ShaderMaterial>

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent)
    this.height = new ShotHeight(entity, ctx)
    const r = entity.radius
    this.core = this.mesh(new Mesh(new IcosahedronGeometry(r * 0.75, 1), new MeshBasicMaterial({ color: '#fff3b8' })))
    this.mesh(new Mesh(new SphereGeometry(r * 1.5, 16, 12), glowMaterial('#ffb040', 0.6)))
    this.mesh(new Mesh(new SphereGeometry(r * 2.8, 16, 12), glowMaterial('#ff4a10', 0.28)))
    this.shell = this.mesh(new Mesh(new IcosahedronGeometry(r * 1.25, 2), fireMaterial({ repeat: 4, speed: 3.5 })))
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) return false
    const y = this.height.at(entity, ctx)
    const r = entity.radius
    this.group.position.set(entity.position.x, y, entity.position.y)
    this.core.rotation.set(ctx.t * 7, ctx.t * 5, 0)
    this.shell.rotation.set(0, ctx.t * 4, Math.sin(ctx.t * 9) * 0.3)
    this.shell.material.uniforms.uTime.value = ctx.t
    this.group.scale.setScalar(1 + Math.sin(ctx.t * 26) * 0.06)
    const { glow, puff } = ctx.fx
    const back = { x: -entity.velocity.x * 0.02, z: -entity.velocity.y * 0.02 }
    for (let index = 0, count = Math.ceil(ctx.dt * 150); index < count; index += 1) {
      glow.emit({
        x: entity.position.x + (Math.random() - 0.5) * r,
        y: y + (Math.random() - 0.5) * r,
        z: entity.position.y + (Math.random() - 0.5) * r,
        vx: back.x * 6 + (Math.random() - 0.5) * 30,
        vy: 25 + Math.random() * 25,
        vz: back.z * 6 + (Math.random() - 0.5) * 30,
        life: 0.3 + Math.random() * 0.2,
        size: r * 2.1,
        sizeEnd: r * 0.4,
        color: colour('#ffb23a'),
        colorEnd: colour('#a8200a'),
        alpha: 0.7,
        drag: 1.5,
      })
    }
    for (let index = 0, count = Math.ceil(ctx.dt * 30); index < count; index += 1) {
      puff.emit({ x: entity.position.x, y, z: entity.position.y, vy: 30, vx: (Math.random() - 0.5) * 20, vz: (Math.random() - 0.5) * 20, life: 0.9, size: r * 1.4, sizeEnd: r * 3.5, color: colour('#3a3330'), alpha: 0.35, fadeIn: 0.15 })
    }
    if (Math.random() < ctx.dt * 30) {
      glow.emit({ x: entity.position.x, y, z: entity.position.y, vx: (Math.random() - 0.5) * 140, vy: 60 + Math.random() * 80, vz: (Math.random() - 0.5) * 140, life: 0.6, size: 3, color: colour('#ffe9a0'), alpha: 1, gravity: -200 })
    }
    ctx.lights.light(entity.position.x, y, entity.position.y, '#ff7a2f', 2.4, 260)
    return true
  }
}

// The fireball's blast: a ball of fire that swells and fades, a ring of fire rolling out across the ground, sparks and burning
// bits thrown out, a column of smoke, a flash of light, and a scorch mark on the ground that cools and fades.
export class FireBlastVisual extends Visual {
  private readonly ball: Mesh<SphereGeometry, MeshBasicMaterial>
  private readonly inner: Mesh<SphereGeometry, MeshBasicMaterial>
  private readonly wave: Mesh<RingGeometry, MeshBasicMaterial>
  private readonly at: { x: number; y: number }
  private readonly radius: number
  private burst = false

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.at = { ...entity.position }
    this.radius = entity.radius
    this.group.position.set(entity.position.x, 0, entity.position.y)
    this.ball = this.mesh(new Mesh(new SphereGeometry(1, 20, 14), glowMaterial('#ff8a2a', 0.9)))
    this.inner = this.mesh(new Mesh(new SphereGeometry(1, 16, 12), glowMaterial('#fff0b0', 1)))
    this.wave = this.mesh(new Mesh(new RingGeometry(0.82, 1, 64), glowMaterial('#ffa040', 0.9)))
    this.wave.rotation.x = -Math.PI / 2
    this.wave.position.y = 2
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    const { x, y } = this.at
    const r = this.radius
    if (!this.burst) {
      this.burst = true
      const { glow, puff } = ctx.fx
      for (let index = 0; index < 90; index += 1) {
        const angle = Math.random() * Math.PI * 2
        const lift = Math.random() * 0.9
        const speed = 120 + Math.random() * 260
        glow.emit({ x, y: 30, z: y, vx: Math.cos(angle) * speed * (1 - lift * 0.5), vy: speed * lift, vz: Math.sin(angle) * speed * (1 - lift * 0.5), life: 0.45 + Math.random() * 0.3, size: 26, sizeEnd: 6, color: colour('#ffe08a'), colorEnd: colour('#b8240a'), alpha: 1, drag: 4 })
      }
      for (let index = 0; index < 30; index += 1) {
        const angle = Math.random() * Math.PI * 2
        glow.emit({ x, y: 25, z: y, vx: Math.cos(angle) * (150 + Math.random() * 200), vy: 150 + Math.random() * 250, vz: Math.sin(angle) * (150 + Math.random() * 200), life: 0.9 + Math.random() * 0.5, size: 4, color: colour('#ffe9a0'), colorEnd: colour('#ff5a10'), alpha: 1, gravity: -500, drag: 0.8 })
      }
      for (let index = 0; index < 26; index += 1) {
        const angle = Math.random() * Math.PI * 2
        const distance = Math.random() * r * 0.6
        puff.emit({ x: x + Math.cos(angle) * distance, y: 20 + Math.random() * 30, z: y + Math.sin(angle) * distance, vx: Math.cos(angle) * 40, vy: 50 + Math.random() * 60, vz: Math.sin(angle) * 40, life: 1.4 + Math.random() * 0.8, size: 30, sizeEnd: 80, color: colour('#2f2826'), alpha: 0.5, drag: 1.2, fadeIn: 0.12 })
      }
    }
    const swell = easeOut(age / 0.22)
    const fade = Math.max(0, 1 - age / 0.5)
    this.ball.scale.setScalar(r * 0.95 * swell)
    this.ball.position.y = r * 0.35
    this.ball.material.opacity = 0.85 * fade * fade
    this.inner.scale.setScalar(r * 0.55 * swell)
    this.inner.position.y = r * 0.35
    this.inner.material.opacity = Math.max(0, 1 - age / 0.25)
    const roll = easeOut(age / 0.45)
    this.wave.scale.setScalar(r * 1.5 * roll + 1)
    this.wave.material.opacity = 0.9 * Math.max(0, 1 - age / 0.45)
    this.ball.visible = this.inner.visible = this.wave.visible = age < 0.6
    // The scorch mark, and the embers in it, cooling.
    const cool = Math.max(0, 1 - age / 3)
    ctx.decals.disc(x, y, r * 0.9, '#160d08', 0.55 * cool)
    ctx.glowDecals.disc(x, y, r * 0.7, '#ff5a14', 0.28 * Math.max(0, 1 - age / 1.4))
    if (age < 0.7) ctx.lights.light(x, 50, y, '#ff8a3a', 9 * (1 - age / 0.7) ** 2, 420)
    return age < 3
  }
}

// Fire Tornado's warning: a circle of fire runes on the ground, turning, with the ground in it glowing hotter as it fills, and
// embers drawn in toward the middle where the tornado will burst out.
export class FireRuneVisual extends Visual {
  constructor(parent: Group) {
    super(parent)
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) return false
    const { x, y } = entity.position
    const r = entity.radius
    const p = entity.progress
    const pulse = 0.75 + Math.sin(ctx.t * 14) * 0.25
    ctx.decals.disc(x, y, r, '#2a0e04', 0.22 + p * 0.2)
    ctx.glowDecals.circle(x, y, r, 4, '#ff7a2f', 0.9 * pulse)
    ctx.glowDecals.disc(x, y, r * ease(p), '#ff4a14', 0.22)
    // A turning ring of runes: short arcs, and a second ring turning the other way.
    for (let index = 0; index < 10; index += 1) {
      const start = ctx.t * 1.8 + index * Math.PI * 2 / 10
      ctx.glowDecals.ring(x, y, r * 0.74, r * 0.8, '#ffb347', 0.75, start, start + 0.32)
      const back = -ctx.t * 2.6 + index * Math.PI * 2 / 10
      ctx.glowDecals.ring(x, y, r * 0.5, r * 0.54, '#ff8a3c', 0.5 * p, back, back + 0.2)
    }
    for (let index = 0, count = Math.ceil(ctx.dt * 80); index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const spin = angle + Math.PI / 2
      ctx.fx.glow.emit({
        x: x + Math.cos(angle) * r,
        y: 3,
        z: y + Math.sin(angle) * r,
        vx: -Math.cos(angle) * r * 1.4 + Math.cos(spin) * 60,
        vy: 12 + p * 50,
        vz: -Math.sin(angle) * r * 1.4 + Math.sin(spin) * 60,
        life: 0.6,
        size: 7,
        sizeEnd: 2,
        color: colour('#ffd36a'),
        colorEnd: colour('#ff3a10'),
        alpha: 0.95,
        drag: 1,
      })
    }
    if (Math.random() < ctx.dt * (10 + p * 40)) {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.random() * r * 0.7
      ctx.fx.glow.emit({ x: x + Math.cos(angle) * distance, y: 2, z: y + Math.sin(angle) * distance, vy: 60, life: 0.4, size: 16, sizeEnd: 4, color: colour('#ffc35a'), colorEnd: colour('#d1300c'), alpha: 0.8 })
    }
    ctx.lights.light(x, 25, y, '#ff6a20', 0.6 + p * 2.2, 260)
    return true
  }
}

// The Fire Tornado: a funnel of fire twisting up out of the ground, a second turning the other way inside it, embers whirled up
// round it and dust thrown off its foot. It grows up out of the ground, and when it ends it shrinks and dies away.
export class FireTornadoVisual extends Visual {
  private readonly outer: Mesh<LatheGeometry, ShaderMaterial>
  private readonly inner: Mesh<LatheGeometry, ShaderMaterial>
  private readonly radius: number

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    const r = entity.radius
    this.radius = r
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const profile = [[0.18, 0], [0.28, 0.12], [0.42, 0.35], [0.7, 0.7], [1.0, 0.92], [1.1, 1]].map(([w, h]) => new ThreeVector2(w * r, h * 230))
    this.outer = this.mesh(new Mesh(new LatheGeometry(profile, 32), fireMaterial({ repeat: 5, twist: 2.5, speed: 3.2 })))
    this.inner = this.mesh(new Mesh(new LatheGeometry(profile.map((point) => new ThreeVector2(point.x * 0.62, point.y * 0.92)), 28), fireMaterial({ hot: '#fff6c8', cool: '#ff6a1a', repeat: 4, twist: -3, speed: 4 })))
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    const end = 0.45
    if (gone > end) return false
    if (entity) this.group.position.set(entity.position.x, 0, entity.position.y)
    const { x, z } = this.group.position
    const r = this.radius
    const grow = easeOut(this.age(ctx) / 0.18)
    const die = 1 - ease(gone / end)
    this.group.scale.set(lerp(0.4, 1, grow) * lerp(0.6, 1, die), grow * die, lerp(0.4, 1, grow) * lerp(0.6, 1, die))
    this.outer.rotation.y += ctx.dt * 9
    this.inner.rotation.y -= ctx.dt * 13
    for (const funnel of [this.outer, this.inner]) {
      funnel.material.uniforms.uTime.value = ctx.t
      funnel.material.uniforms.uAlpha.value = die
    }
    const { glow, puff } = ctx.fx
    for (let index = 0, count = Math.ceil(ctx.dt * 220 * die); index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const height = Math.random() * 220
      const across = r * (0.25 + height / 230 * 0.9)
      const spin = angle + Math.PI / 2
      glow.emit({
        x: x + Math.cos(angle) * across,
        y: height * grow,
        z: z + Math.sin(angle) * across,
        vx: Math.cos(spin) * 200 + Math.cos(angle) * 40,
        vy: 120 + Math.random() * 100,
        vz: Math.sin(spin) * 200 + Math.sin(angle) * 40,
        life: 0.4 + Math.random() * 0.3,
        size: 8 + Math.random() * 10,
        sizeEnd: 2,
        color: colour('#ffd36a'),
        colorEnd: colour('#c42a08'),
        alpha: 0.95,
        drag: 2,
      })
    }
    for (let index = 0, count = Math.ceil(ctx.dt * 30 * die); index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2
      puff.emit({ x: x + Math.cos(angle) * r * 0.4, y: 6, z: z + Math.sin(angle) * r * 0.4, vx: Math.cos(angle) * 140, vy: 20 + Math.random() * 30, vz: Math.sin(angle) * 140, life: 0.8, size: 18, sizeEnd: 44, color: colour('#4a3a30'), alpha: 0.4, drag: 2.5 })
    }
    ctx.decals.disc(x, z, r * 1.05, '#1f0a03', 0.35 * die)
    ctx.glowDecals.disc(x, z, r * 0.9, '#ff5a14', 0.2 * die)
    ctx.lights.light(x, 90, z, '#ff7a2f', 5 * die * grow, 480)
    return true
  }
}

// Scorch: a wall of flame as wide as the wave, running out along the ground, throwing flames and sparks.
export class FlameWallVisual extends Visual {
  private readonly sheets: Array<Mesh<PlaneGeometry, ShaderMaterial>> = []
  private readonly halfWidth: number

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.halfWidth = entity.box?.halfWidth ?? entity.radius
    const width = this.halfWidth * 2.3
    for (const [height, back, hot] of [[80, 0, '#ffe08a'], [56, -12, '#fff3c8']] as const) {
      const geometry = new PlaneGeometry(width, height, 1, 1).translate(0, height / 2, back)
      this.sheets.push(this.mesh(new Mesh(geometry, fireMaterial({ hot, cool: '#e8380c', repeat: 4, speed: 3.4 }))))
    }
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    if (gone > 0.25) return false
    const fade = 1 - gone / 0.25
    if (entity) {
      this.group.position.set(entity.position.x, 0, entity.position.y)
      const facing = entity.facing ?? { x: 1, y: 0 }
      this.group.rotation.y = yawToward(facing.x, facing.y)
    }
    for (const sheet of this.sheets) {
      sheet.material.uniforms.uTime.value = ctx.t
      sheet.material.uniforms.uAlpha.value = fade * Math.min(1, this.age(ctx) / 0.06)
    }
    const { x, z } = this.group.position
    const yaw = this.group.rotation.y
    const across = { x: Math.cos(yaw), z: -Math.sin(yaw) }
    const ahead = { x: Math.sin(yaw), z: Math.cos(yaw) }
    for (let index = 0, count = Math.ceil(ctx.dt * 260 * fade); index < count; index += 1) {
      const along = (Math.random() * 2 - 1) * this.halfWidth
      ctx.fx.glow.emit({
        x: x + across.x * along,
        y: 4 + Math.random() * 20,
        z: z + across.z * along,
        vx: ahead.x * 140 + (Math.random() - 0.5) * 40,
        vy: 80 + Math.random() * 90,
        vz: ahead.z * 140 + (Math.random() - 0.5) * 40,
        life: 0.35 + Math.random() * 0.25,
        size: 16 + Math.random() * 12,
        sizeEnd: 3,
        color: colour('#ffd36a'),
        colorEnd: colour('#c42a08'),
        alpha: 0.9,
        drag: 3,
      })
    }
    if (Math.random() < ctx.dt * 40) {
      ctx.fx.glow.emit({ x, y: 20, z, vx: ahead.x * 300 + (Math.random() - 0.5) * 150, vy: 120 + Math.random() * 120, vz: ahead.z * 300 + (Math.random() - 0.5) * 150, life: 0.7, size: 3.5, color: colour('#fff0b0'), colorEnd: colour('#ff5a10'), alpha: 1, gravity: -500 })
    }
    ctx.glowDecals.box({ x, y: z }, { x: ahead.x, y: ahead.z }, 18, this.halfWidth * 1.1, '#ff6a1f', 0.3 * fade)
    ctx.lights.light(x, 40, z, '#ff6a20', 3 * fade, 300)
    return true
  }
}

// Scorch's burning ground: a patch charred black, glowing with embers that flicker, with small flames licking up off it and a
// little smoke. Many lie together along the wave's path, and run into one strip.
export class BurningGroundVisual extends Visual {
  private readonly glow: Mesh<CircleGeometry, MeshBasicMaterial>
  private readonly seed = Math.random() * 100

  constructor(parent: Group, entity: RenderedEntity, embers: Texture) {
    super(parent)
    this.group.position.set(entity.position.x, 1.2, entity.position.y)
    const material = glowMaterial('#ff6a1f', 0.7)
    material.map = embers
    this.glow = this.mesh(new Mesh(new CircleGeometry(entity.radius * 1.25, 24), material))
    this.glow.rotation.x = -Math.PI / 2
    this.glow.rotation.z = Math.random() * Math.PI * 2
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    if (gone > 0.4) return false
    const p = entity?.progress ?? 1
    const fade = Math.min(1, this.age(ctx) / 0.12) * (1 - ease((p - 0.8) / 0.2)) * (1 - gone / 0.4)
    const flicker = 0.7 + Math.sin(ctx.t * 13 + this.seed) * 0.15 + Math.sin(ctx.t * 29 + this.seed * 2) * 0.1
    this.glow.material.opacity = 0.75 * fade * flicker
    const { x, z } = this.group.position
    const r = entity?.radius ?? 30
    ctx.decals.disc(x, z, r * 1.05, '#140b07', 0.5 * fade)
    if (Math.random() < ctx.dt * 9 * fade) {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.random() * r * 0.8
      ctx.fx.glow.emit({ x: x + Math.cos(angle) * distance, y: 3, z: z + Math.sin(angle) * distance, vy: 50 + Math.random() * 30, life: 0.5, size: 14 + Math.random() * 8, sizeEnd: 3, color: colour('#ffc35a'), colorEnd: colour('#d1300c'), alpha: 0.85 })
    }
    if (Math.random() < ctx.dt * 3 * fade) {
      ctx.fx.puff.emit({ x, y: 10, z, vy: 35, vx: (Math.random() - 0.5) * 12, vz: (Math.random() - 0.5) * 12, life: 1.4, size: 16, sizeEnd: 40, color: colour('#3a3330'), alpha: 0.28, fadeIn: 0.2 })
    }
    return true
  }
}

// -------------------------------------------------------------------------------------------------- Capricorn

// Tsunami: a curling wave of water as wide as the ability, rolling forward with its crest breaking into spray and foam, and
// when it ends it falls in a splash.
export class WaveVisual extends Visual {
  private readonly wave: Mesh<BufferGeometry, ShaderMaterial>
  private readonly halfWidth: number
  private splashed = false

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.halfWidth = (entity.box?.halfWidth ?? entity.radius) * 1.15
    this.wave = this.mesh(new Mesh(waveGeometry(this.halfWidth, 62), waterMaterial({ deep: '#0f5bb5', light: '#a6ecff', foamSpeed: 2.2 })))
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const gone = this.sinceGone(ctx)
    const end = 0.4
    if (gone > end) return false
    if (entity) {
      this.group.position.set(entity.position.x, 0, entity.position.y)
      const facing = entity.facing ?? { x: 1, y: 0 }
      this.group.rotation.y = yawToward(facing.x, facing.y)
    }
    const { x, z } = this.group.position
    const yaw = this.group.rotation.y
    const across = { x: Math.cos(yaw), z: -Math.sin(yaw) }
    const ahead = { x: Math.sin(yaw), z: Math.cos(yaw) }
    if (!entity && !this.splashed) {
      this.splashed = true
      for (let index = 0; index < 70; index += 1) {
        const along = (Math.random() * 2 - 1) * this.halfWidth
        ctx.fx.puff.emit({ x: x + across.x * along, y: 30 + Math.random() * 25, z: z + across.z * along, vx: ahead.x * (60 + Math.random() * 120) + (Math.random() - 0.5) * 60, vy: 80 + Math.random() * 160, vz: ahead.z * (60 + Math.random() * 120) + (Math.random() - 0.5) * 60, life: 0.8 + Math.random() * 0.4, size: 6 + Math.random() * 6, color: colour(Math.random() < 0.5 ? '#ffffff' : '#8fd6ff'), alpha: 0.9, gravity: -700 })
      }
    }
    const rise = easeOut(this.age(ctx) / 0.14)
    const fall = 1 - ease(gone / end)
    this.wave.scale.set(1, Math.max(0.05, rise * fall), lerp(0.7, 1, rise))
    this.wave.material.uniforms.uTime.value = ctx.t
    this.wave.material.uniforms.uAlpha.value = fall
    if (entity) {
      // Spray off the breaking crest, and water churning at its foot.
      for (let index = 0, count = Math.ceil(ctx.dt * 160); index < count; index += 1) {
        const along = (Math.random() * 2 - 1) * this.halfWidth * 0.95
        const crest = 50 * rise * (1 - (along / this.halfWidth) ** 4 * 0.6)
        ctx.fx.puff.emit({ x: x + across.x * along + ahead.x * 10, y: crest, z: z + across.z * along + ahead.z * 10, vx: ahead.x * (100 + Math.random() * 120) + (Math.random() - 0.5) * 40, vy: 40 + Math.random() * 90, vz: ahead.z * (100 + Math.random() * 120) + (Math.random() - 0.5) * 40, life: 0.5 + Math.random() * 0.3, size: 4 + Math.random() * 5, color: colour(Math.random() < 0.6 ? '#ffffff' : '#bfeaff'), alpha: 0.9, gravity: -600 })
      }
      for (let index = 0, count = Math.ceil(ctx.dt * 50); index < count; index += 1) {
        const along = (Math.random() * 2 - 1) * this.halfWidth
        ctx.fx.puff.emit({ x: x + across.x * along - ahead.x * 20, y: 4, z: z + across.z * along - ahead.z * 20, vy: 20, life: 0.7, size: 14, sizeEnd: 30, color: colour('#e8f8ff'), alpha: 0.4, drag: 2 })
      }
      // The ground behind it is left wet for a moment.
      ctx.decals.box({ x: x - ahead.x * 30, y: z - ahead.z * 30 }, { x: ahead.x, y: ahead.z }, 40, this.halfWidth, '#1d4f80', 0.25)
    }
    ctx.lights.light(x, 40, z, '#4fa8ff', 1.4 * fall, 260)
    return true
  }
}

// A wave's shape: a sheet across the wave's width, curved in the way it goes like a wave about to break (rising from behind,
// curling over at the crest), lower toward its ends.
function waveGeometry(halfWidth: number, height: number): BufferGeometry {
  // The wave's cross section, from the back of its foot, up over the crest, to the tip of the curl (along, up).
  const profile: Array<[number, number]> = [[-46, 0], [-34, 6], [-22, 18], [-10, 34], [0, 50], [8, 60], [16, 62], [22, 56], [24, 46], [20, 38]]
  const columns = 24
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  for (let i = 0; i <= columns; i += 1) {
    const u = i / columns
    const x = (u * 2 - 1) * halfWidth
    const taper = 1 - Math.abs(u * 2 - 1) ** 3 * 0.65
    profile.forEach(([along, up], j) => {
      positions.push(x, up / 62 * height * taper, along * (0.7 + taper * 0.3))
      uvs.push(u, j / (profile.length - 1))
    })
  }
  const rows = profile.length
  for (let i = 0; i < columns; i += 1) {
    for (let j = 0; j < rows - 1; j += 1) {
      const a = i * rows + j
      const b = (i + 1) * rows + j
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

// Bubbles: a soap bubble shining in rainbow colours, wobbling as it flies, trailing tiny bubbles. It pops in a spray of drops.
export class BubbleVisual extends Visual {
  private readonly height: ShotHeight
  private readonly bubble: Mesh<SphereGeometry, ShaderMaterial>
  private last?: { x: number; y: number; z: number }
  private readonly seed = Math.random() * 10

  constructor(parent: Group, entity: RenderedEntity, ctx: EffectContext) {
    super(parent)
    this.height = new ShotHeight(entity, ctx)
    this.bubble = this.mesh(new Mesh(new SphereGeometry(entity.radius * 1.1, 24, 16), bubbleMaterial()))
    this.bubble.renderOrder = 25
  }

  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) {
      this.pop(ctx)
      return false
    }
    const y = this.height.at(entity, ctx) + Math.sin(ctx.t * 9 + this.seed) * 4
    this.group.position.set(entity.position.x, y, entity.position.y)
    const wobble = Math.sin(ctx.t * 16 + this.seed) * 0.09
    this.bubble.scale.set(1 + wobble, 1 - wobble, 1 + wobble * 0.5)
    this.bubble.material.uniforms.uTime.value = ctx.t + this.seed
    if (Math.random() < ctx.dt * 40) {
      ctx.fx.puff.emit({ x: entity.position.x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 10, z: entity.position.y + (Math.random() - 0.5) * 10, vy: 15, life: 0.6, size: 3 + Math.random() * 2, color: colour('#dff6ff'), alpha: 0.6 })
    }
    if (Math.random() < ctx.dt * 20) {
      ctx.fx.glow.emit({ x: entity.position.x, y, z: entity.position.y, life: 0.3, size: 7, sizeEnd: 1, color: colour('#9fe0ff'), alpha: 0.6 })
    }
    this.last = { x: entity.position.x, y, z: entity.position.y }
    return true
  }

  private pop(ctx: EffectContext): void {
    const at = this.last
    if (!at) return
    for (let index = 0; index < 18; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const up = Math.random() * 2 - 1
      const speed = 80 + Math.random() * 80
      ctx.fx.puff.emit({ x: at.x, y: at.y, z: at.z, vx: Math.cos(angle) * speed, vy: up * speed + 40, vz: Math.sin(angle) * speed, life: 0.45, size: 3.5, color: colour('#d8f6ff'), alpha: 0.95, gravity: -500, drag: 1 })
    }
    ctx.fx.glow.emit({ x: at.x, y: at.y, z: at.z, life: 0.18, size: 50, sizeEnd: 70, color: colour('#bfeaff'), alpha: 0.7 })
  }
}

// Spout's warning: the water under the ground welling up: rings of ripples spreading out over a darkening pool, bubbles
// breaking its surface, and a rim of warning round it.
export class WellVisual extends Visual {
  protected draw(entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    if (!entity) return false
    const { x, y } = entity.position
    const r = entity.radius
    const p = entity.progress
    ctx.decals.disc(x, y, r, '#164a7a', 0.25 + p * 0.25)
    ctx.decals.circle(x, y, r, 3, entity.color ?? '#ff6b4a', 0.75)
    ctx.glowDecals.disc(x, y, r * ease(p), '#2f8fe0', 0.35)
    for (let ring = 0; ring < 3; ring += 1) {
      const phase = (ctx.t * 1.8 + ring / 3) % 1
      ctx.glowDecals.circle(x, y, r * phase, 2.5, '#bfeaff', 0.65 * (1 - phase))
    }
    for (let index = 0, count = Math.ceil(ctx.dt * (30 + p * 90)); index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.sqrt(Math.random()) * r * 0.9
      ctx.fx.puff.emit({ x: x + Math.cos(angle) * distance, y: 2, z: y + Math.sin(angle) * distance, vy: 30 + p * 120 * Math.random(), life: 0.4, size: 3 + Math.random() * 3, color: colour('#cfefff'), alpha: 0.8, gravity: -300 })
    }
    ctx.lights.light(x, 20, y, '#3f9bff', 0.4 + p * 1.2, 220)
    return true
  }
}

// Spout's eruption: a geyser bursting out of the ground, a column of water shooting up and falling back in a rain of drops,
// a ring of splash spreading over the ground, and mist.
export class GeyserVisual extends Visual {
  private readonly column: Mesh<CylinderGeometryLike, ShaderMaterial>
  private readonly core: Mesh<CylinderGeometryLike, ShaderMaterial>
  private readonly at: { x: number; y: number }
  private readonly radius: number
  private burst = false

  constructor(parent: Group, entity: RenderedEntity) {
    super(parent)
    this.at = { ...entity.position }
    this.radius = entity.radius
    this.group.position.set(entity.position.x, 0, entity.position.y)
    const r = entity.radius
    this.column = this.mesh(new Mesh(geyserGeometry(r * 0.62, r * 0.9), waterMaterial({ deep: '#1a6fd0', light: '#c8f2ff', foamSpeed: 5 })))
    this.core = this.mesh(new Mesh(geyserGeometry(r * 0.32, r * 0.5), waterMaterial({ deep: '#7fd0ff', light: '#ffffff', foamSpeed: 7 })))
  }

  protected draw(_entity: RenderedEntity | undefined, ctx: EffectContext): boolean {
    const age = this.age(ctx)
    const { x, y } = this.at
    const r = this.radius
    if (!this.burst) {
      this.burst = true
      for (let index = 0; index < 110; index += 1) {
        const angle = Math.random() * Math.PI * 2
        const out = 40 + Math.random() * 160
        ctx.fx.puff.emit({ x: x + Math.cos(angle) * r * 0.3, y: 10, z: y + Math.sin(angle) * r * 0.3, vx: Math.cos(angle) * out, vy: 350 + Math.random() * 380, vz: Math.sin(angle) * out, life: 1 + Math.random() * 0.5, size: 6 + Math.random() * 6, color: colour(Math.random() < 0.5 ? '#ffffff' : '#8fd6ff'), alpha: 0.95, gravity: -950 })
      }
      for (let index = 0; index < 24; index += 1) {
        const angle = Math.random() * Math.PI * 2
        ctx.fx.puff.emit({ x: x + Math.cos(angle) * r * 0.6, y: 10, z: y + Math.sin(angle) * r * 0.6, vx: Math.cos(angle) * 90, vy: 30 + Math.random() * 40, vz: Math.sin(angle) * 90, life: 1.2, size: 30, sizeEnd: 70, color: colour('#eaf8ff'), alpha: 0.35, drag: 2 })
      }
    }
    // Up fast, held a moment, and down.
    const up = easeOut(age / 0.14)
    const down = ease((age - 0.4) / 0.5)
    const height = 240 * up * (1 - down)
    for (const [mesh, scale] of [[this.column, 1], [this.core, 1.12]] as const) {
      mesh.scale.set(1 - down * 0.3, Math.max(0.01, height * scale), 1 - down * 0.3)
      mesh.material.uniforms.uTime.value = ctx.t
      mesh.material.uniforms.uAlpha.value = 1 - down
      mesh.visible = height > 1
    }
    if (height > 20) {
      for (let index = 0, count = Math.ceil(ctx.dt * 160); index < count; index += 1) {
        const angle = Math.random() * Math.PI * 2
        ctx.fx.puff.emit({ x: x + Math.cos(angle) * r * 0.4, y: height, z: y + Math.sin(angle) * r * 0.4, vx: Math.cos(angle) * 120, vy: 60 + Math.random() * 100, vz: Math.sin(angle) * 120, life: 0.8, size: 6, color: colour('#dff6ff'), alpha: 0.9, gravity: -800 })
      }
    }
    const spread = easeOut(age / 0.6)
    ctx.glowDecals.circle(x, y, r * (0.5 + spread * 1.1), 5, '#bfeaff', 0.8 * (1 - spread))
    ctx.decals.disc(x, y, r * 1.1, '#1d4f80', 0.4 * Math.max(0, 1 - age / 2))
    if (age < 0.6) ctx.lights.light(x, 80, y, '#6cc4ff', 4 * (1 - age / 0.6), 360)
    return age < 2
  }
}

type CylinderGeometryLike = BufferGeometry

// A column one unit high, open, from `bottom` across at its foot to `top` across at its top, with its uvs running up it.
function geyserGeometry(top: number, bottom: number): BufferGeometry {
  const profile = [[bottom, 0], [top * 1.1, 0.15], [top, 0.6], [top * 1.25, 0.92], [top * 0.4, 1]].map(([w, h]) => new ThreeVector2(w, h))
  return new LatheGeometry(profile, 28)
}
