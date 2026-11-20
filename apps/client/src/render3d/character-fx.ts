import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  ConeGeometry,
  MeshStandardMaterial,
  OctahedronGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type Material,
} from 'three'
import {
  BURN_MAX_STACKS,
  BURN_STACK_KEY,
  CARRION_KEY,
  CHARGE_FULL_TICKS,
  CHARGE_KEY,
  CRACK_KEY,
  GAME_TPS,
  HOUND_BLEED_KEY,
  KNIFE_KEY,
  KNIFE_MAX,
  SHRED_KEY,
  CURSE_KEY,
  CURSE_MAX_STACKS,
  FEAR_KEY,
  getAbilityDef,
  SAGE_KEY,
  SIGHTED_AUTOS,
  SIGHTED_KEY,
  TRICK_HITS,
  TRICK_KEY,
} from '../../../../packages/shared/src/index.ts'
import type { RenderedCharacter } from '../game-state.ts'
import type { Release } from './character-models.ts'
import { burst } from './effects/kits.ts'
import { bloodSpray } from './effects/kits-melee.ts'
import type { EffectContext } from './effects/visual.ts'
import { HumanoidModel } from './models/humanoid.ts'
import { ease, easeOut } from './models/model.ts'
import { colour, lerp } from './space.ts'

type Point3 = { x: number; y: number; z: number }

// A shape that plays for a moment and goes: a swing's arc, a shock ring, a beam. The arcs and rings are painted (so a red ring is
// red on green grass); beams and orbs are light, added.
type Transient = { mesh: Mesh; material: MeshBasicMaterial; born: number; life: number; play: (t: number, mesh: Mesh, material: MeshBasicMaterial) => void }

// The abilities that start another's cooldown, or come back as another, so their cooldown starting is not a cast of their own
// (or is drawn by something else: a dash by its trail, a stick by its entity).
const NOT_CASTS = new Set(['detonate', 'shadowstep', 'shadowreturn', 'recall', 'link', 'stick', 'warp', 'whirl'])
// The abilities that move their caster, whose dash is drawn with the champion's own trail.
const MOVEMENT = new Set(['leap', 'shadowstep', 'shadowreturn', 'lunge', 'cutthrough', 'bloodrush', 'hammerdrop', 'pounce', 'swoop', 'rampart', 'tether', 'bladedash', 'dawnstep', 'glide', 'tumble', 'disengage'])
// Each champion's dash trail: its colour, and whether it is smoke (dark) or light.
const DASH_TRAILS: Readonly<Record<string, { color: string; smoke?: true }>> = {
  archer: { color: '#6dd39b' },
  ninja: { color: '#2a1a4a', smoke: true },
  chain: { color: '#e8f0ff' },
  cloak: { color: '#8e6bd9' },
  aurel: { color: '#d23a48' },
  hammer: { color: '#b9a88c', smoke: true },
  hellhound: { color: '#ff5a1a' },
  stone: { color: '#b9a88c', smoke: true },
  vulture: { color: '#2a241c', smoke: true },
  blade: { color: '#e0e6ee' },
  sorin: { color: '#ffe08a' },
  hunter: { color: '#9bd36d' },
  crystal: { color: '#9fe7ff' },
  sniper: { color: '#8a8270', smoke: true },
}
// The colour of a champion's shield bubble.
const SHIELD_COLOURS: Readonly<Record<string, string>> = { monk: '#ffd36a', soldier: '#7be0c3' }

// The stacks that empower a champion's next blows, and the colour each makes what it strikes with glow: Capricorn's passive, the
// Monk's Flurry (on whoever it is linked to as well), the Swordsman's sword stacks, the Ninja's shadow stacks. The 3D view shows
// these as the glow and not as pips (see `EMPOWERING_STACKS` in character-models.ts). How strong the glow is goes with how many there
// are, out of `full`.
export const EMPOWERING: Readonly<Record<string, { color: string; full: number }>> = {
  empowered: { color: '#7fd6ff', full: 1 },
  flurry: { color: '#ff9a3c', full: 3 },
  sword: { color: '#f2c14e', full: 3 },
  shadow: { color: '#9b7cff', full: 3 },
  // The Grenadier primed (his passive): his launcher burns ember orange until the next ability spends it.
  primed: { color: '#ff9a2e', full: 1 },
  // Sorin's Smite: his sword burns with dawn for the blows it has left.
  smite: { color: '#ffe08a', full: 3 },
  // Crystal's Shardstorm: her bow glitters for the shard arrows left.
  shardstorm: { color: '#9fe7ff', full: 3 },
  // The Hunter's Volley: his bow glows green for the volleys left.
  volley: { color: '#9bd36d', full: 3 },
}

// The marks a champion puts on an enemy that the 3D view shows on the ground under it, each its own way, and not as pips (see
// `CharacterFx.marks`).
export const GROUND_MARKS: ReadonlySet<string> = new Set([CURSE_KEY, TRICK_KEY, SIGHTED_KEY, BURN_STACK_KEY, SAGE_KEY, FEAR_KEY, HOUND_BLEED_KEY, CARRION_KEY, CRACK_KEY, SHRED_KEY])

// How empowered a champion's next blow is, from 0 to 1, and in what colour: by its empowering stacks, or fully, in its own colour,
// for an ability that readies its next auto (Shackle, Hush and the like: `ready:` markers).
export function empowerOf(character: Pick<RenderedCharacter, 'stacks'>, accent: string): { level: number; color: string } {
  let best = { level: 0, color: accent }
  for (const [key, count] of Object.entries(character.stacks)) {
    const empowering = EMPOWERING[key]
    const level = empowering ? Math.min(1, count / empowering.full) : key.startsWith('ready:') && count > 0 ? 1 : 0
    if (level > best.level) best = { level, color: empowering?.color ?? accent }
  }
  return best
}

type Memory = {
  // When each ability was last seen cast, in seconds.
  castAt: Map<string, number>
  invisible: boolean
  lastPosition?: Point3
  // Whether it was bleeding from the Hellhound last frame, to see it start.
  houndBleed: number
  // Since when it has been seen drawing a bead (the Sniper's Steady Aim), in seconds, while it is.
  chargingSince?: number
}

// What is seen on and around the characters that is not an entity of the game: each ability that is only a buff, a dash or a
// blow (Leap's gust, Stim's rush, Rage's roar, Transfusion's swirl of blood, Rend's slash...), what the windup of an ability
// aimed at someone lands on them (Feast, Rejuvenate, Rend, Spore), the arc of every melee swing, dash trails, shields, the
// glow of an empowered next blow, the Monk's tether, and how each status looks (roots, slows, fear, blindness).
export class CharacterFx {
  readonly group = new Group()
  private readonly memory = new Map<number, Memory>()
  private readonly transients: Transient[] = []
  private readonly shields = new Map<number, { mesh: Mesh; material: MeshBasicMaterial }>()
  private readonly tethers = new Map<number, { mesh: Mesh; material: MeshBasicMaterial }>()
  // The mark that floats over the head of an enemy the Cloak has feared lately, by character.
  private readonly markers = new Map<number, Group>()
  // Blade's knives, floating in a ring high over him, one for each he has, by character; and how many he had last frame, to see one come or go.
  private readonly knives = new Map<number, { ring: Group; knives: Group[]; had: number }>()
  private readonly knifeBlade = new ConeGeometry(2.4, 20, 4).scale(1, 1, 0.35)
  private readonly knifeGuard = new BoxGeometry(7, 1.5, 2)
  private readonly knifeGrip = new CylinderGeometry(1.1, 1.1, 6, 6)
  private readonly knifeSteel = new MeshStandardMaterial({ color: '#e0e6ee', metalness: 0.95, roughness: 0.18, emissive: '#5a6a80', emissiveIntensity: 0.6 })
  private readonly knifeDark = new MeshStandardMaterial({ color: '#2b2f36', roughness: 0.6, metalness: 0.3 })
  // The carrion mark over the head of an enemy the Vulture has marked, by character.
  private readonly carrion = new Map<number, Group>()
  private readonly carrionMaterial = new MeshBasicMaterial({ color: '#a6ff4d', transparent: true, opacity: 0.95, depthWrite: false })
  private readonly markerGeometry = new OctahedronGeometry(1, 0)
  private readonly markerMaterial = new MeshBasicMaterial({ color: '#c06bff', transparent: true, opacity: 0.95, depthWrite: false })
  private readonly sphere = new SphereGeometry(1, 20, 14)
  private readonly beam = new CylinderGeometry(1, 1, 1, 8, 1, true).rotateX(Math.PI / 2)
  private readonly arc = new RingGeometry(0.7, 1, 32, 1, -Math.PI * 0.65, Math.PI * 1.3)
  private readonly rake = new RingGeometry(0.93, 1, 24, 1, -Math.PI * 0.35, Math.PI * 0.7)
  private readonly ring = new RingGeometry(0.85, 1, 48)
  private readonly disc = new CircleGeometry(1, 40)
  private readonly column = new CylinderGeometry(1, 1, 1, 20, 1, true).translate(0, 0.5, 0)

  update(characters: readonly RenderedCharacter[], releases: readonly Release[], ctx: EffectContext): void {
    const byId = new Map(characters.map((character) => [character.id, character]))
    for (const release of releases) {
      const character = byId.get(release.id)
      if (character) this.released(character, release, byId, ctx)
    }
    const present = new Set<number>()
    for (const character of characters) {
      present.add(character.id)
      const memory = this.memoryOf(character.id)
      if (!character.dead) {
        this.casts(character, memory, byId, ctx)
        this.statuses(character, memory, ctx)
        this.marks(character, ctx)
      } else {
        this.markers.get(character.id)?.removeFromParent()
        this.carrion.get(character.id)?.removeFromParent()
      }
      this.shield(character, ctx)
      this.tether(character, byId, ctx)
      this.floatingKnives(character, ctx)
      const model = ctx.models.modelOf(character.id)
      if (model) memory.lastPosition = { x: model.root.position.x, y: model.root.position.y, z: model.root.position.z }
    }
    for (const id of [...this.memory.keys()]) if (!present.has(id)) this.memory.delete(id)
    for (const [id, shield] of this.shields) if (!present.has(id)) this.dropMesh(this.shields, id, shield)
    for (const [id, tether] of this.tethers) if (!present.has(id)) this.dropMesh(this.tethers, id, tether)
    for (const [id, marker] of this.markers) {
      if (present.has(id)) continue
      marker.removeFromParent()
      this.markers.delete(id)
    }
    for (const [id, marker] of this.carrion) {
      if (present.has(id)) continue
      marker.removeFromParent()
      this.carrion.delete(id)
    }
    for (const [id, knives] of this.knives) {
      if (present.has(id)) continue
      knives.ring.removeFromParent()
      this.knives.delete(id)
    }
    for (let index = this.transients.length - 1; index >= 0; index -= 1) {
      const item = this.transients[index]
      const t = (ctx.t - item.born) / item.life
      if (t >= 1) {
        item.mesh.removeFromParent()
        item.material.dispose()
        this.transients.splice(index, 1)
        continue
      }
      item.play(t, item.mesh, item.material)
    }
  }

  dispose(): void {
    for (const item of this.transients) item.material.dispose()
    for (const shield of this.shields.values()) shield.material.dispose()
    for (const tether of this.tethers.values()) tether.material.dispose()
    this.sphere.dispose()
    this.markerGeometry.dispose()
    this.markerMaterial.dispose()
    this.carrionMaterial.dispose()
    for (const knives of this.knives.values()) knives.ring.removeFromParent()
    this.knifeBlade.dispose()
    this.knifeGuard.dispose()
    this.knifeGrip.dispose()
    this.knifeSteel.dispose()
    this.knifeDark.dispose()
    this.beam.dispose()
    this.arc.dispose()
    this.rake.dispose()
    this.ring.dispose()
    this.disc.dispose()
    this.column.dispose()
  }

  // ---------------------------------------------------------------------------------------------- what goes off

  // An attack or a cast that wound up has just gone off.
  private released(character: RenderedCharacter, release: Release, byId: ReadonlyMap<number, RenderedCharacter>, ctx: EffectContext): void {
    const model = ctx.models.modelOf(character.id)
    if (!model) return
    const target = release.targetId === undefined ? undefined : byId.get(release.targetId)
    const targetAt = target ? this.chestOf(target, ctx) : undefined
    if (release.kind === 'attack') {
      if (!(model instanceof HumanoidModel)) {
        if (character.monster && targetAt) burst(ctx, targetAt, { count: 8, speed: 80, color: colour('#ffffff'), size: 4, life: 0.2 })
        // The Hellhound's forepaw raking across, burning, and blood out of what it tears.
        if (character.champion.id === 'hellhound') {
          const yaw = model.root.rotation.y
          const ahead = { x: model.root.position.x + Math.sin(yaw) * model.height * 0.6, y: model.root.position.y + model.height * 0.55, z: model.root.position.z + Math.cos(yaw) * model.height * 0.6 }
          this.rakeAt(ahead, character, '#ff5a1a', ctx, yaw)
          if (targetAt) bloodSpray(ctx, targetAt, 14)
        }
        return
      }
      const style = model.look.attack
      if (style === 'claw') {
        const yaw = model.root.rotation.y
        const ahead = { x: model.root.position.x + Math.sin(yaw) * model.height * 0.3, y: model.root.position.y + model.height * 0.55, z: model.root.position.z + Math.cos(yaw) * model.height * 0.3 }
        this.rakeAt(ahead, character, model.accent, ctx, yaw)
        if (targetAt) burst(ctx, targetAt, { count: 12, speed: 110, color: colour('#b3121f'), size: 4, life: 0.5, up: 1, gravity: -500, puff: true, alpha: 1 })
      } else if (style === 'blade' || style === 'heavy' || style === 'dual' || style === 'unarmed') {
        this.swingArc(model, style, ctx)
        if (targetAt) burst(ctx, targetAt, { count: style === 'heavy' ? 18 : 10, speed: 120, color: colour('#fff6d8'), colorEnd: colour(model.accent), size: 5, life: 0.22 })
      }
      return
    }
    const from = model instanceof HumanoidModel ? model.focus() : model.root.position.clone().setY(model.height * 0.6)
    switch (release.abilityId) {
      case 'feast':
        // The curse eaten: a violet maw closing on the target, and its curse drawn back into the Cursebearer.
        if (targetAt) {
          this.shockRing(targetAt, 50, '#b07cf2', 0.35, ctx, true)
          burst(ctx, targetAt, { count: 24, speed: 120, color: colour('#d6b8ff'), colorEnd: colour('#4a1a6a'), size: 9, life: 0.4 })
          this.stream(targetAt, from, '#c99bff', 22, 0.45, ctx)
        }
        break
      case 'rejuvenate':
        // A beam of green light from the staff to the one it heals; a column of light rising round them, leaves spiralling up it,
        // flowers springing up in a ring at their feet, and sparkles of healing.
        if (target && targetAt) {
          this.beamBetween(from, targetAt, '#5fbf5a', 6, 0.5, ctx)
          this.beamBetween(from, targetAt, '#d8ffdc', 2, 0.4, ctx)
          const feet = { x: targetAt.x, y: 3, z: targetAt.z }
          const radius = target.champion.radius * 1.5
          this.lightColumn(feet, radius, 140, '#3fa84a', 0.9, ctx, false)
          this.shockRing(feet, radius * 2.4, '#5fbf5a', 0.6, ctx)
          for (let index = 0; index < 40; index += 1) {
            const angle = index / 40 * Math.PI * 2
            const spin = angle + Math.PI / 2
            ctx.fx.puff.emit({ x: feet.x + Math.cos(angle) * radius, y: 6 + Math.random() * 20, z: feet.z + Math.sin(angle) * radius, vx: Math.cos(spin) * 70, vy: 70 + Math.random() * 70, vz: Math.sin(spin) * 70, life: 1.1, size: 5, color: colour(index % 3 ? '#5fbf5a' : '#c8f0a0'), alpha: 0.95, drag: 1.5 })
          }
          for (let index = 0; index < 14; index += 1) {
            const angle = Math.random() * Math.PI * 2
            const out = radius * (0.8 + Math.random() * 0.8)
            ctx.fx.glow.emit({ x: feet.x + Math.cos(angle) * out, y: 3, z: feet.z + Math.sin(angle) * out, vy: 4, life: 1.3, size: 6, sizeEnd: 3, color: colour(['#ffd6f0', '#fff6a8', '#ffffff'][index % 3]), alpha: 0.9, fadeIn: 0.3 })
          }
          burst(ctx, targetAt, { count: 24, speed: 70, color: colour('#b8ffc4'), colorEnd: colour('#2f8f3a'), size: 6, life: 1, up: 1.6 })
          ctx.lights.light(feet.x, 60, feet.z, '#7bd88f', 2, 260)
        }
        break
      case 'rend':
        // A crimson slash across the target, its blood sprayed out, and some of it drawn back to Aurel.
        if (targetAt) {
          this.rakeAt(targetAt, character, '#d23a48', ctx)
          burst(ctx, targetAt, { count: 18, speed: 130, color: colour('#b3121f'), size: 4, life: 0.6, up: 1, gravity: -500, puff: true, alpha: 1 })
          this.stream(targetAt, from, '#ff4a5a', 12, 0.4, ctx)
        }
        break
      case 'spore':
        // A spore pod flung at the target, bursting into a cloud of spores on it.
        if (targetAt) this.lob(from, targetAt, '#c8d86a', 0.25, ctx, () => {
          burst(ctx, targetAt, { count: 22, speed: 70, color: colour('#c8d86a'), size: 10, life: 1.1, puff: true, alpha: 0.6 })
          burst(ctx, targetAt, { count: 12, speed: 90, color: colour('#e8ff9a'), size: 5, life: 0.4 })
        })
        break
      case 'link':
        if (targetAt) {
          this.beamBetween(from, targetAt, '#e8c15a', 4, 0.3, ctx)
          burst(ctx, targetAt, { count: 16, speed: 70, color: colour('#ffe08a'), size: 6, life: 0.5 })
        }
        break
      case 'medic':
        burst(ctx, from, { count: 18, speed: 70, color: colour('#7be0c3'), size: 6, life: 0.5, up: 1 })
        break
      case 'howl': {
        // Jaws thrown open: a gout of fire and ash at the mouth.
        const yaw = model.root.rotation.y
        const mouth = { x: model.root.position.x + Math.sin(yaw) * model.height * 0.45, y: model.root.position.y + model.height * 0.75, z: model.root.position.z + Math.cos(yaw) * model.height * 0.45 }
        burst(ctx, mouth, { count: 30, speed: 140, color: colour('#ffb03a'), colorEnd: colour('#c4302b'), size: 8, life: 0.45 })
        burst(ctx, mouth, { count: 12, speed: 60, color: colour('#2a1410'), size: 18, life: 0.9, puff: true, alpha: 0.45, up: 0.8 })
        break
      }
      case 'dawnbeam':
        // The light gathered at his sword before it goes.
        burst(ctx, from, { count: 30, speed: 90, color: colour('#ffffff'), colorEnd: colour('#ffd36a'), size: 8, life: 0.4 })
        this.shockRing({ x: model.root.position.x, y: 4, z: model.root.position.z }, 80, '#ffe08a', 0.4, ctx)
        break
      case 'spidermine': {
        // Set down: a puff of dirt at his feet.
        const at = model.root.position
        burst(ctx, { x: at.x, y: 4, z: at.z }, { count: 12, speed: 60, color: colour('#6a5a44'), size: 10, life: 0.5, puff: true, alpha: 0.4 })
        break
      }
      case 'bloodpact':
        // A lash of blood from her hand to the one she binds.
        if (targetAt) {
          this.beamBetween(from, targetAt, '#8a0a16', 5, 0.35, ctx)
          this.stream(targetAt, from, '#ff3a4a', 16, 0.45, ctx)
          bloodSpray(ctx, targetAt, 20)
        }
        break
      case 'crystalbolt':
        burst(ctx, from, { count: 18, speed: 80, color: colour('#ffffff'), colorEnd: colour('#5fd0ff'), size: 5, life: 0.35 })
        break
      case 'arrowrain':
        // Arrows loosed high, up into the sky.
        for (let index = 0; index < 14; index += 1) {
          ctx.fx.glow.emit({ x: from.x + (Math.random() - 0.5) * 10, y: from.y, z: from.z + (Math.random() - 0.5) * 10, vx: (Math.random() - 0.5) * 60, vy: 500 + Math.random() * 200, vz: (Math.random() - 0.5) * 60, life: 0.5, size: 5, sizeEnd: 2, color: colour('#c8f0a0'), alpha: 0.9 })
        }
        break
      case 'tether':
        burst(ctx, from, { count: 10, speed: 70, color: colour('#b9a88c'), size: 8, life: 0.4, puff: true, alpha: 0.4 })
        break
      case 'monster-slam': {
        const at = model.root.position
        this.shockRing({ x: at.x, y: 3, z: at.z }, 130, '#b9a88c', 0.45, ctx)
        burst(ctx, { x: at.x, y: 6, z: at.z }, { count: 30, speed: 160, color: colour('#b9a88c'), size: 18, life: 0.9, puff: true, alpha: 0.4, up: 0.3 })
        break
      }
      default:
        break
    }
  }

  // Abilities seen cast from their cooldowns starting: the ones that go off at once, with nothing winding up and often no entity,
  // each get a flourish of their own.
  private casts(character: RenderedCharacter, memory: Memory, byId: ReadonlyMap<number, RenderedCharacter>, ctx: EffectContext): void {
    for (const cast of character.casts ?? []) {
      const at = ctx.t - cast.ageMs / 1000
      const before = memory.castAt.get(cast.abilityId)
      if (before !== undefined && at - before < 0.25) continue
      memory.castAt.set(cast.abilityId, at)
      if (cast.ageMs > 400 || NOT_CASTS.has(cast.abilityId)) continue
      if ((getAbilityDef(cast.abilityId)?.windUpTicks ?? 0) > 0) continue
      this.instant(character, cast.abilityId, byId, ctx)
    }
  }

  private instant(character: RenderedCharacter, abilityId: string, byId: ReadonlyMap<number, RenderedCharacter>, ctx: EffectContext): void {
    const model = ctx.models.modelOf(character.id)
    if (!model) return
    const base = model.root.position
    const feet = { x: base.x, y: base.y + 4, z: base.z }
    const chest = { x: base.x, y: base.y + model.height * 0.55, z: base.z }
    const hand = model instanceof HumanoidModel ? model.focus() : chest
    switch (abilityId) {
      case 'leap':
        burst(ctx, feet, { count: 22, speed: 140, color: colour('#cfeedd'), size: 14, life: 0.5, puff: true, alpha: 0.4, up: 0.2 })
        burst(ctx, feet, { count: 12, speed: 120, color: colour('#6dd39b'), size: 4, life: 0.8, puff: true, gravity: -150, up: 1 })
        break
      case 'focus':
        this.shockRing(feet, 60, '#6dd39b', 0.4, ctx)
        burst(ctx, hand, { count: 20, speed: 90, color: colour('#b8ffd6'), colorEnd: colour('#2f8f5a'), size: 6, life: 0.5 })
        break
      case 'stim':
        // A rush of adrenaline: a red flash, steam off the body, and the health it costs.
        this.shockRing(feet, 55, '#ff4a2a', 0.35, ctx)
        burst(ctx, chest, { count: 24, speed: 100, color: colour('#ff6a4a'), colorEnd: colour('#7a1010'), size: 8, life: 0.5 })
        burst(ctx, chest, { count: 10, speed: 80, color: colour('#b3121f'), size: 4, life: 0.6, up: 1, gravity: -400, puff: true, alpha: 1 })
        break
      case 'shackle':
        burst(ctx, hand, { count: 28, speed: 110, color: colour('#ffe08a'), colorEnd: colour('#c9902a'), size: 6, life: 0.45 })
        this.shockRing(feet, 45, '#f2c14e', 0.3, ctx)
        break
      case 'hush':
        // A hush: a ring of silence going out, teal and violet.
        this.shockRing(chest, 50, '#3fc8c0', 0.4, ctx, true)
        burst(ctx, hand, { count: 18, speed: 70, color: colour('#bff6ee'), colorEnd: colour('#8e6bd9'), size: 6, life: 0.5 })
        break
      case 'dodge':
        burst(ctx, chest, { count: 16, speed: 80, color: colour('#2a1a4a'), size: 18, life: 0.6, puff: true, alpha: 0.5 })
        burst(ctx, chest, { count: 12, speed: 100, color: colour('#c9c9ff'), size: 5, life: 0.35 })
        break
      case 'rage':
        // A roar: a red shock ring out from it, and steam.
        this.shockRing(feet, 110, '#e5534b', 0.45, ctx)
        this.shockRing({ ...chest }, 70, '#ff8a6a', 0.3, ctx, true)
        burst(ctx, chest, { count: 20, speed: 60, color: colour('#d8d0c8'), size: 16, life: 1, puff: true, alpha: 0.35, up: 1 })
        break
      case 'lunge':
        burst(ctx, feet, { count: 20, speed: 150, color: colour('#fff1c9'), size: 4, life: 0.3, up: 0.6 })
        break
      case 'ghost':
        // A cloud of dark smoke it vanishes into.
        burst(ctx, chest, { count: 30, speed: 70, color: colour('#1e1430'), size: 26, life: 1.1, puff: true, alpha: 0.55, spread: 20 })
        burst(ctx, chest, { count: 16, speed: 80, color: colour('#b89cff'), size: 5, life: 0.6 })
        break
      case 'cutthrough':
        burst(ctx, chest, { count: 18, speed: 140, color: colour('#d6c4ff'), colorEnd: colour('#8e6bd9'), size: 6, life: 0.3 })
        break
      case 'linkheal': {
        // The link let go in a flash of gold, healing both ends of it.
        burst(ctx, chest, { count: 26, speed: 80, color: colour('#ffe08a'), size: 7, life: 0.7, up: 1.2 })
        const linked = [...byId.values()].find((other) => other.linkedBy === character.id)
        if (linked) {
          const there = this.chestOf(linked, ctx)
          burst(ctx, there, { count: 26, speed: 80, color: colour('#ffe08a'), size: 7, life: 0.7, up: 1.2 })
          this.beamBetween(chest, there, '#ffe08a', 6, 0.3, ctx)
        }
        break
      }
      case 'flurry':
        if (model instanceof HumanoidModel) {
          for (const side of ['left', 'right'] as const) burst(ctx, model.handPoint(side), { count: 16, speed: 70, color: colour('#ffd36a'), colorEnd: colour('#ff5a14'), size: 8, life: 0.4 })
        }
        break
      case 'guard':
        this.shockRing(chest, 45, '#ffd36a', 0.45, ctx, true)
        burst(ctx, chest, { count: 24, speed: 60, color: colour('#fff1b0'), size: 6, life: 0.6 })
        break
      case 'transfusion':
        this.transfusion(base, chest, model.height, ctx)
        break
      case 'bloodrush':
        burst(ctx, chest, { count: 18, speed: 120, color: colour('#ff4a5a'), colorEnd: colour('#5a1018'), size: 6, life: 0.35 })
        break
      case 'pounce':
        burst(ctx, feet, { count: 20, speed: 150, color: colour('#3a2a24'), size: 14, life: 0.5, puff: true, alpha: 0.45, up: 0.2 })
        burst(ctx, chest, { count: 18, speed: 120, color: colour('#ffb03a'), colorEnd: colour('#c4302b'), size: 6, life: 0.4 })
        break
      case 'shove':
        burst(ctx, hand, { count: 16, speed: 80, color: colour('#c9b27a'), size: 6, life: 0.4 })
        burst(ctx, feet, { count: 10, speed: 70, color: colour('#8a8270'), size: 12, life: 0.6, puff: true, alpha: 0.4 })
        break
      case 'rampart':
        // Planted like a wall: a ring of stone dust and gold.
        this.shockRing(feet, 110, '#c9b27a', 0.5, ctx)
        burst(ctx, feet, { count: 26, speed: 160, color: colour('#8a8270'), size: 16, life: 0.8, puff: true, alpha: 0.45, up: 0.3 })
        burst(ctx, chest, { count: 16, speed: 70, color: colour('#ffe08a'), size: 6, life: 0.5 })
        break
      case 'carrionstrike':
        // A dark green glow on his claws, and a croak of carrion birds' feathers.
        burst(ctx, hand, { count: 18, speed: 80, color: colour('#c8ff6a'), colorEnd: colour('#2a4a12'), size: 6, life: 0.45 })
        burst(ctx, chest, { count: 8, speed: 70, color: colour('#1a1814'), size: 6, life: 1, puff: true, gravity: -60, up: 1 })
        break
      case 'swoop':
        burst(ctx, chest, { count: 14, speed: 120, color: colour('#1a1814'), size: 7, life: 0.9, puff: true, gravity: -80, up: 0.8 })
        break
      case 'bladedash':
        burst(ctx, chest, { count: 16, speed: 140, color: colour('#ffffff'), colorEnd: colour('#9aa3ad'), size: 5, life: 0.3 })
        break
      case 'frenzy':
        // Steel flashing in both hands, and a pulse of red.
        this.shockRing(feet, 60, '#e0e6ee', 0.35, ctx)
        if (model instanceof HumanoidModel) {
          for (const side of ['left', 'right'] as const) burst(ctx, model.handPoint(side), { count: 14, speed: 80, color: colour('#ffffff'), colorEnd: colour('#c4302b'), size: 5, life: 0.4 })
        }
        break
      case 'bloodshot':
      case 'bloodshotagain':
        bloodSpray(ctx, hand, 8)
        break
      case 'coagulate':
        burst(ctx, chest, { count: 20, speed: 60, color: colour('#6a0812'), size: 5, life: 0.6, puff: true, up: 0.6 })
        this.shockRing(feet, 50, '#8a0a16', 0.4, ctx)
        break
      case 'volley':
        this.shockRing(feet, 55, '#9bd36d', 0.4, ctx)
        burst(ctx, hand, { count: 20, speed: 80, color: colour('#e0ffd0'), colorEnd: colour('#4f8f2e'), size: 6, life: 0.5 })
        break
      case 'disengage':
        burst(ctx, feet, { count: 16, speed: 120, color: colour('#cfeedd'), size: 12, life: 0.5, puff: true, alpha: 0.4, up: 0.2 })
        break
      case 'glide':
        burst(ctx, chest, { count: 20, speed: 100, color: colour('#ffffff'), colorEnd: colour('#5fd0ff'), size: 5, life: 0.4 })
        break
      case 'shardstorm':
        // Crystals grow out of her bow.
        this.shockRing(feet, 60, '#9fe7ff', 0.4, ctx)
        burst(ctx, hand, { count: 26, speed: 70, color: colour('#ffffff'), colorEnd: colour('#5fd0ff'), size: 6, life: 0.6, up: 0.6 })
        break
      case 'smite':
        // His sword takes the dawn: a column of light down on him.
        this.lightColumn(feet, 26, 160, '#ffe08a', 0.45, ctx)
        burst(ctx, hand, { count: 24, speed: 90, color: colour('#ffffff'), colorEnd: colour('#ffd36a'), size: 7, life: 0.5 })
        break
      case 'dawnstep':
        burst(ctx, chest, { count: 18, speed: 120, color: colour('#fff2c0'), colorEnd: colour('#ffb43a'), size: 6, life: 0.35 })
        break
      case 'tumble':
        burst(ctx, feet, { count: 14, speed: 90, color: colour('#8a8270'), size: 12, life: 0.5, puff: true, alpha: 0.4, up: 0.2 })
        break
      case 'steadyaim':
        burst(ctx, hand, { count: 10, speed: 40, color: colour('#ffd36a'), size: 4, life: 0.4 })
        break
      default:
        burst(ctx, hand, { count: 12, speed: 70, color: colour(model instanceof HumanoidModel ? model.accent : '#ffffff'), size: 6, life: 0.4 })
    }
  }

  // ---------------------------------------------------------------------------------------------- what lasts

  // How its statuses and its buffs look on it, frame by frame.
  private statuses(character: RenderedCharacter, memory: Memory, ctx: EffectContext): void {
    const model = ctx.models.modelOf(character.id)
    if (!model || !model.root.visible) return
    const base = model.root.position
    const r = character.champion.radius
    const top = base.y + model.height
    const kinds = new Set(character.statusKinds ?? [])
    const chance = (perSecond: number): boolean => Math.random() < ctx.dt * perSecond
    const around = (height: number, spread = r): Point3 => {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.random() * spread
      return { x: base.x + Math.cos(angle) * distance, y: height, z: base.z + Math.sin(angle) * distance }
    }

    // A dash: the champion's own trail when it dashed itself, dust when something else threw it.
    if (character.dashing && memory.lastPosition) {
      const own = (character.casts ?? []).some((cast) => MOVEMENT.has(cast.abilityId) && cast.ageMs < 1500)
      const look = own ? DASH_TRAILS[character.champion.id] : undefined
      const from = memory.lastPosition
      for (let index = 0; index < 6; index += 1) {
        const k = index / 6
        const at = { x: lerp(from.x, base.x, k), y: base.y + model.height * (0.3 + Math.random() * 0.4), z: lerp(from.z, base.z, k) }
        if (!look) ctx.fx.puff.emit({ ...at, y: base.y + 6, life: 0.6, size: 12, sizeEnd: 26, color: colour('#b9a88c'), alpha: 0.3 })
        else if (look.smoke) ctx.fx.puff.emit({ ...at, life: 0.5, size: 16, sizeEnd: 28, color: colour(look.color), alpha: 0.45 })
        else ctx.fx.glow.emit({ ...at, life: 0.3, size: 12, sizeEnd: 2, color: colour(look.color), alpha: 0.7 })
      }
    }

    // A champion that is invisible to its foes but seen by its team leaves wisps; when it is seen again, its fear goes out in a ring.
    if (character.invisible && chance(14)) ctx.fx.puff.emit({ ...around(base.y + Math.random() * model.height), vy: 10, life: 0.8, size: 10, sizeEnd: 18, color: colour('#1e1430'), alpha: 0.3 })
    if (memory.invisible && !character.invisible && character.champion.leaveInvisibilityRadius) {
      this.shockRing({ x: base.x, y: base.y + 4, z: base.z }, character.champion.leaveInvisibilityRadius, '#8e6bd9', 0.5, ctx)
      burst(ctx, { x: base.x, y: base.y + model.height * 0.6, z: base.z }, { count: 30, speed: 160, color: colour('#b89cff'), colorEnd: colour('#2a1a4a'), size: 9, life: 0.5 })
    }
    memory.invisible = character.invisible

    const hand = model instanceof HumanoidModel ? model.focus() : { x: base.x, y: top * 0.6, z: base.z }
    // Buffs from abilities: the Archer's longer reach, the Soldier's stim, the Hammer's rage, the Monk's flurry, a blow readied.
    if (kinds.has('attackrange') && chance(30)) {
      const angle = Math.random() * Math.PI * 2
      ctx.fx.glow.emit({ x: hand.x + Math.cos(angle) * 12, y: hand.y, z: hand.z + Math.sin(angle) * 12, vx: -Math.sin(angle) * 40, vy: 10, vz: Math.cos(angle) * 40, life: 0.5, size: 5, sizeEnd: 1, color: colour('#8effc0'), alpha: 0.9 })
    }
    if (character.champion.id === 'soldier' && kinds.has('stat') && kinds.has('haste') && chance(26)) {
      ctx.fx.glow.emit({ ...around(base.y + Math.random() * model.height * 0.8), vy: 50, life: 0.5, size: 8, sizeEnd: 2, color: colour('#ff5a3a'), alpha: 0.7 })
    }
    if (character.meter && character.champion.meter && chance(40)) {
      ctx.fx.glow.emit({ ...around(base.y + Math.random() * model.height), vy: 70, life: 0.45, size: 12, sizeEnd: 3, color: colour('#ff6a4a'), colorEnd: colour('#7a1010'), alpha: 0.85 })
    }
    // An empowered next blow: what it strikes with glows (see `empowerOf`), and sparks of that colour come off it.
    if (model instanceof HumanoidModel) {
      const empowered = empowerOf(character, model.accent)
      model.setEmpower(empowered.level, empowered.color)
      if (empowered.level > 0 && chance(36 * empowered.level)) {
        for (const at of model.strikePoints()) {
          ctx.fx.glow.emit({ x: at.x + (Math.random() - 0.5) * 10, y: at.y + (Math.random() - 0.5) * 10, z: at.z + (Math.random() - 0.5) * 10, vy: 24, life: 0.4, size: 7, sizeEnd: 1, color: colour(empowered.color), alpha: 0.95 })
        }
      }
    }
    // The Hellhound's bleed starting: a gout of blood out of it, a red flash, and blood thrown on the ground.
    const bleed = character.stacks[HOUND_BLEED_KEY] ?? 0
    if (bleed > memory.houndBleed) {
      const chestAt = { x: base.x, y: base.y + model.height * 0.55, z: base.z }
      bloodSpray(ctx, chestAt, 40)
      this.shockRing({ x: base.x, y: base.y + 3, z: base.z }, r * 2, '#d01020', 0.4, ctx)
      burst(ctx, chestAt, { count: 14, speed: 90, color: colour('#ff4a4a'), colorEnd: colour('#5a0610'), size: 7, life: 0.35 })
      ctx.lights.light(base.x, base.y + 40, base.z, '#ff2020', 2.5, 160)
    }
    memory.houndBleed = bleed
    // Drawing a bead (the Sniper's Steady Aim): light gathers at the muzzle, drawn in from round him, brighter the longer he holds, and a ring tightens at his feet;
    // once it is at its fullest, it burns gold and throbs.
    if ((character.stacks[CHARGE_KEY] ?? 0) > 0) {
      memory.chargingSince ??= ctx.t
      const held = Math.min(1, (ctx.t - memory.chargingSince) / (CHARGE_FULL_TICKS / GAME_TPS))
      const full = held >= 1
      const css = full ? '#ffd36a' : '#fff4c8'
      for (let index = 0, count = Math.ceil(ctx.dt * (30 + held * 80)); index < count; index += 1) {
        const angle = Math.random() * Math.PI * 2
        const out = 30 + Math.random() * 30
        const life = 0.3
        ctx.fx.glow.emit({ x: hand.x + Math.cos(angle) * out, y: hand.y + (Math.random() - 0.5) * out, z: hand.z + Math.sin(angle) * out, vx: -Math.cos(angle) * out / life, vy: 0, vz: -Math.sin(angle) * out / life, life, size: 4 + held * 3, sizeEnd: 1, color: colour(css), alpha: 0.9 })
      }
      if (chance(full ? 20 : 8)) ctx.fx.glow.emit({ ...hand, life: 0.25, size: 10 + held * 16, sizeEnd: 4, color: colour(css), alpha: full ? 0.9 : 0.6 })
      const ring = r * (2.6 - held * 1.3)
      ctx.glowDecals.circle(base.x, base.z, ring, 2.5, css, (0.4 + held * 0.4) * (full ? 0.7 + 0.3 * Math.sin(ctx.t * 14) : 1))
      ctx.lights.light(hand.x, hand.y, hand.z, '#ffd36a', 0.5 + held * 2, 120)
    } else {
      memory.chargingSince = undefined
    }
    if (character.dodging && chance(20)) ctx.fx.puff.emit({ ...around(base.y + Math.random() * model.height, r * 1.2), vy: 6, life: 0.4, size: 12, sizeEnd: 4, color: colour('#3a2a5a'), alpha: 0.35 })

    // Crowd control and ailments.
    if (character.rooted) {
      ctx.decals.circle(base.x, base.z, r * 0.9, 4, '#3d7a2a', 0.8)
      if (chance(10)) ctx.fx.glow.emit({ ...around(base.y + 3, r * 0.8), vy: 14, life: 0.6, size: 4, color: colour('#8fd06a'), alpha: 0.9 })
    }
    if (character.slowed && chance(10)) ctx.fx.glow.emit({ ...around(base.y + 4), vy: 8, life: 0.6, size: 4, color: colour('#9fd6ff'), alpha: 0.7 })
    if (character.hasted && character.statusKinds && chance(16) && memory.lastPosition) {
      const moved = Math.hypot(base.x - memory.lastPosition.x, base.z - memory.lastPosition.z)
      if (moved > 0.5) ctx.fx.glow.emit({ ...around(base.y + Math.random() * model.height * 0.8, r * 0.6), life: 0.25, size: 7, sizeEnd: 1, color: colour('#e8f4ff'), alpha: 0.5 })
    }
    if (character.silenced && chance(8)) ctx.fx.glow.emit({ x: base.x + (Math.random() - 0.5) * 16, y: top + 10, z: base.z, vy: 10, life: 0.6, size: 5, color: colour('#b07cf2'), alpha: 0.9 })
    if (character.blinded && chance(14)) ctx.fx.puff.emit({ x: base.x + (Math.random() - 0.5) * 20, y: top - 6, z: base.z + (Math.random() - 0.5) * 20, vy: 4, life: 0.7, size: 14, sizeEnd: 20, color: colour('#22201e'), alpha: 0.5 })
    if (character.feared && chance(14)) ctx.fx.puff.emit({ x: base.x + (Math.random() - 0.5) * 24, y: top + 4, z: base.z + (Math.random() - 0.5) * 24, vy: 20, life: 0.8, size: 10, sizeEnd: 16, color: colour('#5a3a8a'), alpha: 0.45 })
  }

  // The marks on a character, each drawn on the ground under it so they can be told apart and counted at a glance:
  //   curse (the Cursebearer's)  a dark pool, shifting at its edges, that spreads wider and darker with every stack, and throbs when full
  //   trick (the Trinketmaster's) a ring in as many pieces as the hits it takes, a piece lit for each, the last one pulsing when one
  //                               more pays out
  //   sighted (the Grenadier's)   a crosshair round it, closing in with every auto and turning red when the next one pays out
  //   ember (the Fire Mage's)     a ring of flame in as many pieces as there can be stacks, a piece burning for each
  //   mended (the Sage's)         a ring of leaves
  //   feared (the Cloak's)        a violet sigil on the ground and a mark over its head, so the Cloak can see whom it can cut through
  private marks(character: RenderedCharacter, ctx: EffectContext): void {
    const model = ctx.models.modelOf(character.id)
    const marker = this.markers.get(character.id)
    if (!model || !model.root.visible) {
      marker?.removeFromParent()
      return
    }
    const { x, z } = model.root.position
    const r = character.champion.radius
    const t = ctx.t
    const stacks = character.stacks
    const curse = stacks[CURSE_KEY] ?? 0
    if (curse > 0) {
      const share = curse / CURSE_MAX_STACKS
      // Wider than the body, so it shows round even a big one.
      const size = Math.max(r * 1.6, (ctx.models.modelOf(character.id)?.height ?? r * 2) * 0.6) * (1 + share * 1.1)
      const full = curse >= CURSE_MAX_STACKS
      const throb = full ? 0.5 + 0.5 * Math.sin(t * 9) : 0
      // Several dark pools drifting round each other, so the edge shifts.
      for (let index = 0; index < 4; index += 1) {
        const turn = t * (0.7 + index * 0.25) + index * 1.7
        const drift = size * 0.18
        ctx.decals.softDisc(x + Math.cos(turn) * drift, z + Math.sin(turn * 1.3) * drift, size * (0.75 + 0.1 * Math.sin(t * 2 + index)), '#0a0410', (0.24 + share * 0.24) * (1 + throb * 0.3), 0.6)
      }
      if (full) ctx.glowDecals.softDisc(x, z, size * 0.9, '#5a2a8a', 0.18 * throb, 0.5)
      if (Math.random() < ctx.dt * (6 + curse * 6)) {
        const angle = Math.random() * Math.PI * 2
        const out = Math.random() * size
        ctx.fx.puff.emit({ x: x + Math.cos(angle) * out, y: 2, z: z + Math.sin(angle) * out, vy: 14 + Math.random() * 16, life: 1.1, size: 10, sizeEnd: 22, color: colour('#1a0d26'), alpha: 0.4, fadeIn: 0.25 })
      }
    }
    const trick = stacks[TRICK_KEY] ?? 0
    if (trick > 0) this.segments(x, z, r * 1.5, TRICK_HITS, trick, '#3fc8c0', ctx, 0.8)
    const sighted = stacks[SIGHTED_KEY] ?? 0
    if (sighted > 0) {
      const ready = sighted >= SIGHTED_AUTOS - 1
      const css = ready ? '#ff4a3a' : '#e8c95a'
      const pulse = ready ? 0.75 + 0.25 * Math.sin(t * 12) : 0.85
      const gap = r * (2.1 - sighted / (SIGHTED_AUTOS - 1) * 0.8)
      ctx.decals.circle(x, z, gap, 2.5, css, 0.6 * pulse)
      for (let index = 0; index < 4; index += 1) {
        const turn = index * Math.PI / 2 + Math.PI / 4
        const from = { x: x + Math.cos(turn) * (gap + 14), y: z + Math.sin(turn) * (gap + 14) }
        const to = { x: x + Math.cos(turn) * (gap - 4), y: z + Math.sin(turn) * (gap - 4) }
        ctx.decals.line(from, to, 4, css, pulse)
      }
    }
    const ember = stacks[BURN_STACK_KEY] ?? 0
    if (ember > 0) {
      this.segments(x, z, r * 1.25, BURN_MAX_STACKS, ember, '#ff6a1f', ctx, 0.9)
      if (Math.random() < ctx.dt * ember * 8) {
        const angle = Math.random() * Math.PI * 2 * (ember / BURN_MAX_STACKS) - Math.PI / 2
        ctx.fx.glow.emit({ x: x + Math.cos(angle) * r * 1.25, y: 3, z: z + Math.sin(angle) * r * 1.25, vy: 40, life: 0.45, size: 9, sizeEnd: 2, color: colour('#ffc35a'), colorEnd: colour('#d1300c'), alpha: 0.9 })
      }
    }
    if ((stacks[SAGE_KEY] ?? 0) > 0) {
      ctx.decals.circle(x, z, r * 1.35, 3, '#5fbf5a', 0.75)
      for (let index = 0; index < 6; index += 1) {
        const turn = t * 0.8 + index * Math.PI / 3
        ctx.decals.ellipse(x + Math.cos(turn) * r * 1.35, z + Math.sin(turn) * r * 1.35, 6, 3.5, '#8ee6a0', 0.9)
      }
    }
    // Bleeding from the Hellhound: a pool of blood under it, a throbbing red ring, and blood dripping from it.
    if ((stacks[HOUND_BLEED_KEY] ?? 0) > 0) {
      const throb = 0.75 + 0.25 * Math.sin(t * 7)
      ctx.decals.softDisc(x, z, r * 1.7, '#4a050a', 0.6, 0.45)
      ctx.decals.circle(x, z, r * 1.55, 4, '#d01020', 0.9 * throb)
      if (Math.random() < ctx.dt * 22) ctx.fx.puff.emit({ x: x + (Math.random() - 0.5) * r, y: model.root.position.y + model.height * (0.3 + Math.random() * 0.4), z: z + (Math.random() - 0.5) * r, vy: -10, life: 0.6, size: 3, color: colour('#8a0a14'), alpha: 1, gravity: -500 })
    }
    // Shredded by Blade's knives: a ring of silver in three pieces, one lit for each shred, with cuts across the ground.
    const shreds = stacks[SHRED_KEY] ?? 0
    if (shreds > 0) {
      this.segments(x, z, r * 1.3, 3, shreds, '#e0e6ee', ctx, 0.85)
      for (let index = 0; index < shreds; index += 1) {
        const turn = index * 2.1 + 0.4
        ctx.decals.line({ x: x + Math.cos(turn) * r * 1.6, y: z + Math.sin(turn) * r * 1.6 }, { x: x + Math.cos(turn + 0.5) * r * 0.9, y: z + Math.sin(turn + 0.5) * r * 0.9 }, 2.5, '#1a1c20', 0.6)
      }
    }
    // Cracked by Crystal's bolt: shards of crystal standing out of the ground round it, a cold ring, and glints rising off it.
    if ((stacks[CRACK_KEY] ?? 0) > 0) {
      const pulse = 0.7 + 0.3 * Math.sin(t * 8)
      ctx.glowDecals.circle(x, z, r * 1.4, 3, '#9fe7ff', 0.8 * pulse)
      for (let index = 0; index < 6; index += 1) {
        const turn = index / 6 * Math.PI * 2 + 0.3
        const from = { x: x + Math.cos(turn) * r * 1.4, y: z + Math.sin(turn) * r * 1.4 }
        const to = { x: x + Math.cos(turn) * r * 2.1, y: z + Math.sin(turn) * r * 2.1 }
        ctx.glowDecals.line(from, to, 4, '#bff4ff', 0.75 * pulse)
      }
      if (Math.random() < ctx.dt * 16) ctx.fx.glow.emit({ x: x + (Math.random() - 0.5) * r * 2, y: model.root.position.y + Math.random() * model.height, z: z + (Math.random() - 0.5) * r * 2, vy: 30, life: 0.6, size: 5, sizeEnd: 1, color: colour('#bff4ff'), alpha: 0.9 })
    }
    // Carrion (the Vulture's mark): dark wings wheeling over it as shadows on the ground, a sickly green ring, and a green mark over its head, so it is plain who
    // is marked from across a fight.
    const carrion = this.carrion.get(character.id)
    if ((stacks[CARRION_KEY] ?? 0) > 0) {
      const pulse = 0.7 + 0.3 * Math.sin(t * 5)
      ctx.decals.softDisc(x, z, r * 2, '#1a2a0a', 0.35, 0.5)
      ctx.glowDecals.circle(x, z, r * 1.7, 3.5, '#a6ff4d', 0.75 * pulse)
      for (let index = 0; index < 3; index += 1) {
        const turn = t * 1.2 + index * Math.PI * 2 / 3
        const at = { x: x + Math.cos(turn) * r * 2.4, y: z + Math.sin(turn) * r * 2.4 }
        const wing = { x: -Math.sin(turn) * 12, y: Math.cos(turn) * 12 }
        const side = { x: Math.cos(turn) * 4, y: Math.sin(turn) * 4 }
        ctx.decals.quad({ x: at.x - wing.x * 0.2 - side.x, y: at.y - wing.y * 0.2 - side.y }, { x: at.x + wing.x, y: at.y + wing.y }, { x: at.x - wing.x * 0.2 + side.x, y: at.y - wing.y * 0.2 + side.y }, { x: at.x - wing.x, y: at.y - wing.y }, '#0a0a06', 0.55)
      }
      let mark = carrion
      if (!mark) {
        mark = new Group()
        const gem = new Mesh(this.markerGeometry, this.carrionMaterial)
        gem.scale.set(7, 11, 7)
        mark.add(gem)
        const halo = new Mesh(this.sphere, new MeshBasicMaterial({ color: '#5f8f2e', transparent: true, opacity: 0.4, blending: AdditiveBlending, depthWrite: false }))
        halo.scale.setScalar(14)
        mark.add(halo)
        this.carrion.set(character.id, mark)
      }
      if (!mark.parent) this.group.add(mark)
      mark.position.set(x, model.root.position.y + model.height + 30 + Math.sin(t * 4) * 3, z)
      mark.rotation.y = t * 2
      if (Math.random() < ctx.dt * 10) ctx.fx.glow.emit({ x: x + (Math.random() - 0.5) * r * 2, y: model.root.position.y + 4, z: z + (Math.random() - 0.5) * r * 2, vy: 40, life: 0.8, size: 5, sizeEnd: 1, color: colour('#a6ff4d'), alpha: 0.8 })
    } else {
      carrion?.removeFromParent()
    }
    const feared = (stacks[FEAR_KEY] ?? 0) > 0
    if (feared) {
      // On the ground: a violet sigil turning under it. Over its head: a mark that bobs, so it can be picked out in a crowd.
      const pulse = 0.7 + 0.3 * Math.sin(t * 6)
      ctx.decals.softDisc(x, z, r * 1.9, '#2a0f40', 0.4, 0.5)
      ctx.glowDecals.circle(x, z, r * 1.6, 4, '#c06bff', 0.8 * pulse)
      for (let index = 0; index < 3; index += 1) {
        const start = t * 1.5 + index * Math.PI * 2 / 3
        ctx.glowDecals.ring(x, z, r * 1.8, r * 2.05, '#c06bff', 0.7 * pulse, start, start + 0.9)
      }
      let mark = marker
      if (!mark) {
        mark = new Group()
        const gem = new Mesh(this.markerGeometry, this.markerMaterial)
        gem.scale.set(6, 10, 6)
        mark.add(gem)
        const halo = new Mesh(this.sphere, new MeshBasicMaterial({ color: '#8e3bd9', transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false }))
        halo.scale.setScalar(13)
        mark.add(halo)
        this.markers.set(character.id, mark)
      }
      if (!mark.parent) this.group.add(mark)
      mark.position.set(x, model.root.position.y + model.height + 34 + Math.sin(t * 4) * 3, z)
      mark.rotation.y = t * 2.5
    } else {
      marker?.removeFromParent()
    }
  }

  // A ring in `pieces` pieces round a point, `lit` of them bright and the rest faint; the next to light pulses when only one is left.
  private segments(x: number, z: number, radius: number, pieces: number, lit: number, css: string, ctx: EffectContext, strength: number): void {
    const gap = 0.18
    const span = Math.PI * 2 / pieces
    for (let index = 0; index < pieces; index += 1) {
      const from = -Math.PI / 2 + index * span + gap / 2
      const on = index < lit
      const next = index === lit && lit === pieces - 1
      const alpha = on ? strength : next ? strength * (0.35 + 0.35 * Math.sin(ctx.t * 10)) : 0.18
      ctx.decals.ring(x, z, radius - 3, radius + 3, css, alpha, from, from + span - gap)
    }
  }

  // Blade's knives: one for each he has, floating point down in a ring high over his head, turning slowly and bobbing, glinting. One that comes flashes in; one he
  // spends is gone. Everyone who sees him sees how many he has.
  private floatingKnives(character: RenderedCharacter, ctx: EffectContext): void {
    const count = Math.min(KNIFE_MAX, character.stacks[KNIFE_KEY] ?? 0)
    const model = ctx.models.modelOf(character.id)
    let knives = this.knives.get(character.id)
    if (count === 0 && !knives) return
    if (!knives) {
      const ring = new Group()
      const each = Array.from({ length: KNIFE_MAX }, () => {
        const knife = new Group()
        const blade = new Mesh(this.knifeBlade, this.knifeSteel)
        blade.rotation.x = Math.PI
        knife.add(blade)
        const guard = new Mesh(this.knifeGuard, this.knifeDark)
        guard.position.y = 11
        knife.add(guard)
        const grip = new Mesh(this.knifeGrip, this.knifeDark)
        grip.position.y = 15
        knife.add(grip)
        ring.add(knife)
        return knife
      })
      knives = { ring, knives: each, had: count }
      this.knives.set(character.id, knives)
    }
    const shown = count > 0 && !character.dead && model !== undefined && model.root.visible
    if (!shown) {
      knives.ring.removeFromParent()
      knives.had = count
      return
    }
    if (!knives.ring.parent) this.group.add(knives.ring)
    const base = model.root.position
    const height = base.y + model.height + 26
    knives.ring.position.set(base.x, height, base.z)
    knives.ring.rotation.y = ctx.t * 0.9
    const radius = 14 + count * 3
    knives.knives.forEach((knife, index) => {
      knife.visible = index < count
      if (!knife.visible) return
      const turn = index / count * Math.PI * 2
      knife.position.set(Math.cos(turn) * radius, Math.sin(ctx.t * 3 + index * 1.3) * 3, Math.sin(turn) * radius)
      // Point down and a little out, the edge turned outward.
      knife.rotation.set(0, -turn, 0.25)
    })
    if (count > knives.had) {
      const turn = (count - 1) / count * Math.PI * 2 + knives.ring.rotation.y
      burst(ctx, { x: base.x + Math.cos(turn) * radius, y: height, z: base.z - Math.sin(turn) * radius }, { count: 10, speed: 50, color: colour('#ffffff'), colorEnd: colour('#9aa3ad'), size: 4, life: 0.35 })
    }
    knives.had = count
    if (Math.random() < ctx.dt * count * 1.5) {
      const angle = Math.random() * Math.PI * 2
      ctx.fx.glow.emit({ x: base.x + Math.cos(angle) * radius, y: height + 6, z: base.z + Math.sin(angle) * radius, life: 0.2, size: 8, sizeEnd: 2, color: colour('#ffffff'), alpha: 0.9 })
    }
  }

  // A bubble round a character that has a shield, in its champion's colour, breathing.
  private shield(character: RenderedCharacter, ctx: EffectContext): void {
    const model = ctx.models.modelOf(character.id)
    const up = character.totalShield > 0 && !character.dead && model !== undefined && model.root.visible && !character.turret
    let shield = this.shields.get(character.id)
    if (!up) {
      if (shield) shield.mesh.visible = false
      return
    }
    if (!shield) {
      const material = new MeshBasicMaterial({ color: SHIELD_COLOURS[character.champion.id] ?? '#cfe6ff', transparent: true, opacity: 0.18, blending: AdditiveBlending, depthWrite: false, side: DoubleSide })
      const mesh = new Mesh(this.sphere, material)
      this.group.add(mesh)
      shield = { mesh, material }
      this.shields.set(character.id, shield)
    }
    const r = character.champion.radius * 1.5
    shield.mesh.visible = true
    shield.mesh.position.set(model.root.position.x, model.root.position.y + model.height * 0.5, model.root.position.z)
    shield.mesh.scale.set(r, model.height * 0.65, r)
    shield.material.opacity = 0.14 + Math.sin(ctx.t * 4 + character.id) * 0.04
  }

  // The Monk's link: a tether of golden light from the Monk's chest to the one it is linked to, with light running along it.
  private tether(character: RenderedCharacter, byId: ReadonlyMap<number, RenderedCharacter>, ctx: EffectContext): void {
    const holder = character.linkedBy === undefined ? undefined : byId.get(character.linkedBy)
    let tether = this.tethers.get(character.id)
    if (!holder || holder.dead || character.dead) {
      if (tether) tether.mesh.visible = false
      return
    }
    if (!tether) {
      const material = new MeshBasicMaterial({ color: '#ffd36a', transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false })
      const mesh = new Mesh(this.beam, material)
      this.group.add(mesh)
      tether = { mesh, material }
      this.tethers.set(character.id, tether)
    }
    const from = this.chestOf(holder, ctx)
    const to = this.chestOf(character, ctx)
    this.placeBeam(tether.mesh, from, to, 2.5 + Math.sin(ctx.t * 6) * 0.6)
    tether.mesh.visible = true
    if (Math.random() < ctx.dt * 30) {
      const k = Math.random()
      ctx.fx.glow.emit({ x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k), z: lerp(from.z, to.z, k), vx: (to.x - from.x) * 0.8, vy: (to.y - from.y) * 0.8, vz: (to.z - from.z) * 0.8, life: 0.3, size: 7, sizeEnd: 1, color: colour('#fff1b0'), alpha: 0.9 })
    }
  }

  // Transfusion: a pool of blood spreading under Aurel, a swirl of blood drawn in to him from all round, and, as it closes, a burst of
  // red light as what was lost comes back.
  private transfusion(base: Point3, chest: Point3, height: number, ctx: EffectContext): void {
    const feet = { x: base.x, y: base.y + 2, z: base.z }
    this.bloodPool(feet, 42, ctx)
    this.shockRing(feet, 65, '#b3121f', 0.35, ctx)
    for (let index = 0; index < 40; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const out = 50 + Math.random() * 40
      const spin = angle + Math.PI / 2
      const life = 0.5 + Math.random() * 0.35
      const start = { x: base.x + Math.cos(angle) * out, y: base.y + 4 + Math.random() * height * 0.9, z: base.z + Math.sin(angle) * out }
      const inward = { x: (base.x - start.x) / life, z: (base.z - start.z) / life }
      const spec = { ...start, vx: inward.x + Math.cos(spin) * 90, vy: (chest.y - start.y) / life, vz: inward.z + Math.sin(spin) * 90, life, drag: 0.6 }
      if (index % 3 === 0) ctx.fx.puff.emit({ ...spec, size: 5, color: colour('#8a0a16'), alpha: 1 })
      else ctx.fx.glow.emit({ ...spec, size: 9, sizeEnd: 3, color: colour('#ff3a4a'), colorEnd: colour('#7a0a14'), alpha: 0.95 })
    }
    this.later(0.55, ctx, () => {
      burst(ctx, chest, { count: 18, speed: 110, color: colour('#ffd0d4'), colorEnd: colour('#d23a48'), size: 7, life: 0.5, up: 0.8 })
    })
    ctx.lights.light(base.x, 50, base.z, '#d23a48', 2, 220)
  }

  // ---------------------------------------------------------------------------------------------- shapes that come and go

  // The arc of a melee swing: a crescent of light in front of it, in the champion's colour, sweeping round and fading.
  private swingArc(model: HumanoidModel, style: string, ctx: EffectContext): void {
    const material = new MeshBasicMaterial({ color: model.accent, transparent: true, opacity: 0.8, depthWrite: false, side: DoubleSide })
    const mesh = new Mesh(this.arc, material)
    const yaw = model.root.rotation.y
    const reach = model.height * (style === 'heavy' ? 0.55 : 0.5)
    mesh.position.set(model.root.position.x + Math.sin(yaw) * reach * 0.35, model.root.position.y + model.height * (style === 'heavy' ? 0.45 : 0.55), model.root.position.z + Math.cos(yaw) * reach * 0.35)
    // A swing goes across, flat; a heavy blow comes down, upright; a punch or a stab is a small ring straight ahead.
    if (style === 'heavy') mesh.rotation.set(0, yaw + Math.PI / 2, 0)
    else mesh.rotation.set(-Math.PI / 2, 0, -yaw + Math.PI / 2)
    this.group.add(mesh)
    const size = reach * (style === 'unarmed' || style === 'dual' ? 0.6 : 1)
    this.transients.push({
      mesh,
      material,
      born: ctx.t,
      life: 0.22,
      play: (t, shape, paint) => {
        shape.scale.setScalar(size * (0.7 + easeOut(t) * 0.4))
        if (style !== 'heavy') shape.rotation.z = -yaw + Math.PI / 2 + (t - 0.5) * 1.2
        paint.opacity = 0.8 * (1 - t)
      },
    })
    if (style === 'heavy') {
      const at = { x: model.root.position.x + Math.sin(yaw) * reach, y: 4, z: model.root.position.z + Math.cos(yaw) * reach }
      burst(ctx, at, { count: 16, speed: 120, color: colour('#b9a88c'), size: 16, life: 0.7, puff: true, alpha: 0.35, up: 0.3 })
    }
  }

  // Three claw marks raked across a point, side by side, in a colour, turned across the line from the attacker (or by `yaw`).
  private rakeAt(at: Point3, from: RenderedCharacter, css: string, ctx: EffectContext, yaw = Math.atan2(at.x - from.position.x, at.z - from.position.y)): void {
    for (let index = 0; index < 3; index += 1) {
      const material = new MeshBasicMaterial({ color: css, transparent: true, opacity: 0.95, depthWrite: false, side: DoubleSide })
      const mesh = new Mesh(this.rake, material)
      const side = (index - 1) * 9
      mesh.position.set(at.x + Math.cos(yaw) * side, at.y + (index - 1) * 4, at.z - Math.sin(yaw) * side)
      mesh.rotation.order = 'YXZ'
      mesh.rotation.set(0, yaw, 0.9)
      this.group.add(mesh)
      const delay = index * 0.03
      this.transients.push({ mesh, material, born: ctx.t, life: 0.3, play: (t, shape, paint) => {
        const k = Math.max(0, (t * 0.3 - delay) / 0.27)
        shape.scale.setScalar(26 + easeOut(k) * 10)
        shape.rotation.z = 0.9 - easeOut(k) * 0.9
        paint.opacity = 0.95 * (1 - t)
      } })
    }
  }

  // A column of light standing up out of the ground and fading, as wide as `radius`.
  private lightColumn(at: Point3, radius: number, height: number, css: string, life: number, ctx: EffectContext, added = true): void {
    const material = new MeshBasicMaterial({ color: css, transparent: true, opacity: 0.6, depthWrite: false, side: DoubleSide, ...(added ? { blending: AdditiveBlending } : {}) })
    const mesh = new Mesh(this.column, material)
    mesh.position.set(at.x, at.y, at.z)
    this.group.add(mesh)
    this.transients.push({ mesh, material, born: ctx.t, life, play: (t, shape, paint) => {
      shape.scale.set(radius * (1 - t * 0.4), height * easeOut(t * 3), radius * (1 - t * 0.4))
      paint.opacity = (added ? 0.55 : 0.35) * (1 - ease(t))
    } })
  }

  // A pool of blood spreading on the ground and drying away.
  private bloodPool(at: Point3, radius: number, ctx: EffectContext): void {
    const material = new MeshBasicMaterial({ color: '#5a0a12', transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
    const mesh = new Mesh(this.disc, material)
    mesh.position.set(at.x, at.y, at.z)
    mesh.rotation.x = -Math.PI / 2
    this.group.add(mesh)
    this.transients.push({ mesh, material, born: ctx.t, life: 1.6, play: (t, shape, paint) => {
      shape.scale.setScalar(Math.max(1, radius * easeOut(t * 3)))
      paint.opacity = 0.55 * (1 - ease((t - 0.4) / 0.6))
    } })
  }

  // Something to happen a little later.
  private later(seconds: number, ctx: EffectContext, then: () => void): void {
    const material = new MeshBasicMaterial({ visible: false })
    const mesh = new Mesh(this.disc, material)
    let done = false
    this.transients.push({ mesh, material, born: ctx.t, life: seconds + 0.05, play: (t) => {
      if (!done && t * (seconds + 0.05) >= seconds) {
        done = true
        then()
      }
    } })
  }

  // A ring that rolls out from a point and fades: flat on the ground, or upright facing the camera when `upright`.
  private shockRing(at: Point3, radius: number, css: string, life: number, ctx: EffectContext, upright = false): void {
    const material = new MeshBasicMaterial({ color: css, transparent: true, opacity: 0.9, depthWrite: false, side: DoubleSide })
    const mesh = new Mesh(this.ring, material)
    mesh.position.set(at.x, at.y, at.z)
    if (upright) mesh.rotation.x = -0.6
    else mesh.rotation.x = -Math.PI / 2
    this.group.add(mesh)
    this.transients.push({ mesh, material, born: ctx.t, life, play: (t, shape, paint) => {
      shape.scale.setScalar(Math.max(1, radius * easeOut(t)))
      paint.opacity = 0.9 * (1 - ease(t))
    } })
  }

  // A beam of light from one point to another, for a moment.
  private beamBetween(from: Point3, to: Point3, css: string, width: number, life: number, ctx: EffectContext): void {
    const material = new MeshBasicMaterial({ color: css, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false })
    const mesh = new Mesh(this.beam, material)
    this.group.add(mesh)
    this.placeBeam(mesh, from, to, width)
    this.transients.push({ mesh, material, born: ctx.t, life, play: (t, shape, paint) => {
      paint.opacity = 0.85 * (1 - t)
      this.placeBeam(shape, from, to, width * (1 - t * 0.6))
    } })
  }

  // Motes of light streaming from one point to another.
  private stream(from: Point3, to: Point3, css: string, count: number, life: number, ctx: EffectContext): void {
    for (let index = 0; index < count; index += 1) {
      const delay = Math.random() * 0.4
      const start = { x: from.x + (Math.random() - 0.5) * 20, y: from.y + (Math.random() - 0.5) * 20, z: from.z + (Math.random() - 0.5) * 20 }
      ctx.fx.glow.emit({ ...start, vx: (to.x - start.x) / life, vy: (to.y - start.y) / life, vz: (to.z - start.z) / life, life: life * (1 - delay * 0.5), size: 6, sizeEnd: 2, color: colour(css), alpha: 0.9 })
    }
  }

  // Something thrown from one point to another in an arc, over `life` seconds, and what happens when it lands.
  private lob(from: Point3, to: Point3, css: string, life: number, ctx: EffectContext, landed: () => void): void {
    const material = new MeshBasicMaterial({ color: css, transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false })
    const mesh = new Mesh(this.sphere, material)
    mesh.scale.setScalar(7)
    this.group.add(mesh)
    let done = false
    this.transients.push({ mesh, material, born: ctx.t, life, play: (t, shape) => {
      shape.position.set(lerp(from.x, to.x, t), lerp(from.y, to.y, t) + Math.sin(Math.PI * t) * 40, lerp(from.z, to.z, t))
      ctx.fx.glow.emit({ x: shape.position.x, y: shape.position.y, z: shape.position.z, life: 0.25, size: 8, sizeEnd: 2, color: colour(css), alpha: 0.7 })
      if (t > 0.92 && !done) {
        done = true
        landed()
      }
    } })
  }

  // ---------------------------------------------------------------------------------------------- helpers

  private chestOf(character: RenderedCharacter, ctx: EffectContext): Point3 {
    const model = ctx.models.modelOf(character.id)
    if (model) return { x: model.root.position.x, y: model.root.position.y + model.height * 0.55, z: model.root.position.z }
    return { x: character.position.x, y: character.champion.radius * 1.6, z: character.position.y }
  }

  private placeBeam(mesh: Mesh, from: Point3, to: Point3, width: number): void {
    const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
    mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2)
    mesh.lookAt(new Vector3(to.x, to.y, to.z))
    mesh.scale.set(width, width, Math.max(1, length))
  }

  private memoryOf(id: number): Memory {
    let memory = this.memory.get(id)
    if (!memory) {
      memory = { castAt: new Map(), invisible: false, houndBleed: 0 }
      this.memory.set(id, memory)
    }
    return memory
  }

  private dropMesh(map: Map<number, { mesh: Mesh; material: Material }>, id: number, item: { mesh: Mesh; material: Material }): void {
    item.mesh.removeFromParent()
    item.material.dispose()
    map.delete(id)
  }
}
