import { AdditiveBlending, Group, Mesh, MeshBasicMaterial, OctahedronGeometry } from 'three'
import { getTeam, type Vector2 } from '../../../../packages/shared/src/index.ts'
import type { RenderedCharacter } from '../game-state.ts'
import { guarded } from '../guard.ts'
import { AIRBORNE_LIFT, INVISIBLE_ALPHA } from '../render/character-layer.ts'
import { EMPOWERING, GROUND_MARKS } from './character-fx.ts'
import { layoutCorpse } from '../render/corpse.ts'
import { layoutStackPips } from '../render/stack-pips.ts'
import { GolemModel, SlimeModel, WolfModel } from './models/creatures.ts'
import { championModel } from './models/champion-model.ts'
import { HumanoidModel } from './models/humanoid.ts'
import { RELEASE_SECONDS, type FxContext, type Model } from './models/model.ts'
import { CoreModel, HealingZoneModel, StructureModel, TurretModel } from './models/structures.ts'
import { angleDelta, colour, yawToward } from './space.ts'
import type { VisionShading } from './vision-shading.ts'

// Less than this in a frame is not a step; more than this is a jump (a respawn, a blink), not a walk.
const STEP_EPSILON = 0.05
const JUMP_DISTANCE = 80
// A walk that pauses for less than this, in seconds, still counts as walking.
const MOVING_GRACE = 0.12
// How fast a body turns to face its way, in radians a second, at most.
const TURN_RATE = 14

type Actor = {
  model: Model
  // The pips of its stacks: glowing gems circling its middle.
  pips: Group
  // Stars over the head of one that is stunned.
  stars: Group
  lastPosition?: Vector2
  movedAt: number
  speed: number
  // Whether it was dashing last frame, to know when a dash ends.
  dashing?: boolean
  yaw: number
  // The action under way last frame, to know when one goes off, and what it was: which ability, aimed at whom.
  action?: 'attack' | 'cast'
  actionAbility?: string
  actionTarget?: number
  releaseAt?: number
  releaseKind?: 'attack' | 'cast'
  deadSince?: number
}

// An attack or a cast going off this frame: who did it, which ability (for a cast), and at whom, if it was aimed at someone.
export type Release = { id: number; kind: 'attack' | 'cast'; abilityId?: string; targetId?: number }

export type FacingHints = {
  // Where each character's attack is aimed, for those that are attacking someone: they turn to face it.
  targetOf: (character: RenderedCharacter) => Vector2 | undefined
  // Whether something this tall standing here is on the screen, or near enough that its shadow may be. Everything is, if not said.
  inView?: (position: Vector2, height: number) => boolean
}

// Every character, in 3D: a model for each (see models/), stood where it is, turned the way it goes or the way it aims, and
// posed for what it is doing: standing, walking, winding up an attack or a spell and letting it go, stunned, knocked up, dead.
// The same as the 2D layer, a character the team cannot see is kept and updated out of sight, so what it was doing carries on.
export class CharacterModels3D {
  readonly group = new Group()
  private readonly actors = new Map<number, Actor>()
  private readonly pipGeometry = new OctahedronGeometry(1, 0)
  private readonly starGeometry = new OctahedronGeometry(1, 0)
  private readonly pipMaterials = new Map<string, MeshBasicMaterial>()
  private readonly starMaterial = new MeshBasicMaterial({ color: '#ffe680', transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false })
  private releases: Release[] = []

  constructor(private readonly vision: VisionShading) {}

  // How high the top of a character is drawn, in world units, if it is drawn.
  topOf(id: number): number | undefined {
    const actor = this.actors.get(id)
    if (!actor) return undefined
    return actor.model.height + actor.model.root.position.y
  }

  // The model of a character, for effects that come from it (a spell from a staff, a shot from a tower).
  modelOf(id: number): Model | undefined {
    return this.actors.get(id)?.model
  }

  // The attacks and casts that went off since this was last asked.
  takeReleases(): Release[] {
    const taken = this.releases
    this.releases = []
    return taken
  }

  // What each model is and where it stands, for looking into the scene while developing.
  describe(): Array<{ id: number; model: string; position: Vector2; visible: boolean }> {
    return [...this.actors].map(([id, actor]) => ({
      id,
      model: actor.model.constructor.name,
      position: { x: actor.model.root.position.x, y: actor.model.root.position.z },
      visible: actor.model.root.visible,
    }))
  }

  update(
    seen: readonly RenderedCharacter[],
    unseen: readonly RenderedCharacter[],
    now: number,
    dt: number,
    fx: FxContext,
    hints: FacingHints,
    // The team of the champion being played: everything on another team (but a structure) has a red edge.
    localTeam?: number,
  ): void {
    const t = now / 1000
    const everyone = unseen.length > 0 ? [...seen, ...unseen] : seen
    const hidden = new Set(unseen.map((character) => character.id))
    const active = new Set(everyone.map((character) => character.id))
    for (const [id, actor] of this.actors) {
      if (active.has(id)) continue
      this.group.remove(actor.model.root, actor.pips, actor.stars)
      actor.model.dispose()
      this.actors.delete(id)
    }
    // Each on its own: one whose model goes wrong is left as it was, and the rest are still drawn (see guard.ts).
    for (const character of everyone) guarded(`The model of ${character.champion.id}`, () => {
      const actor = this.actors.get(character.id) ?? this.add(character)
      const { model } = actor
      const position = character.position

      // Walking is worked out from where it is drawn, so it always matches what is on screen.
      let moved = 0
      if (actor.lastPosition && !character.dead) {
        moved = Math.hypot(position.x - actor.lastPosition.x, position.y - actor.lastPosition.y)
        if (moved > STEP_EPSILON && moved <= JUMP_DISTANCE) {
          actor.movedAt = t
          actor.speed = actor.speed * 0.7 + (moved / Math.max(dt, 1 / 240)) * 0.3
          if (model.turns && !character.action) {
            actor.yaw = turnToward(actor.yaw, yawToward(position.x - actor.lastPosition.x, position.y - actor.lastPosition.y), dt)
          }
        }
      }
      actor.lastPosition = character.dead ? undefined : { x: position.x, y: position.y }
      // A dash that has just ended leaves no running behind it: the dash's speed is let go at once, and so is the grace that carries a walk over a
      // still frame, unless it walks on from there this frame.
      if (actor.dashing && !character.dashing) {
        actor.speed = 0
        if (!(moved > STEP_EPSILON && moved <= JUMP_DISTANCE)) actor.movedAt = Number.NEGATIVE_INFINITY
      }
      actor.dashing = character.dashing === true
      const moving = !character.dead && t - actor.movedAt < MOVING_GRACE
      if (!moving) actor.speed *= 0.9

      // Aimed: it turns to face what it aims at, quickly. Attacking someone, it faces them between swings too.
      const aim = character.action?.aimAt ?? (!moving ? hints.targetOf(character) : undefined)
      if (model.turns && aim && !character.dead) {
        const dx = aim.x - position.x
        const dy = aim.y - position.y
        if (Math.hypot(dx, dy) > 1) actor.yaw = turnToward(actor.yaw, yawToward(dx, dy), dt, 2.2)
      }

      // An action that ends while it is alive has gone off: the moment after it is played out.
      const kind = character.action?.kind
      if (actor.action && !kind && !character.dead) {
        actor.releaseAt = t
        actor.releaseKind = actor.action
        model.release(actor.action, fx)
        if (!hidden.has(character.id)) {
          this.releases.push({
            id: character.id,
            kind: actor.action,
            ...(actor.actionAbility !== undefined ? { abilityId: actor.actionAbility } : {}),
            ...(actor.actionTarget !== undefined ? { targetId: actor.actionTarget } : {}),
          })
        }
      }
      actor.action = kind
      if (character.action) {
        actor.actionAbility = character.action.abilityId
        actor.actionTarget = character.action.targetId
      }
      if (kind) actor.releaseAt = undefined
      const releasing = actor.releaseAt !== undefined && t - actor.releaseAt < RELEASE_SECONDS
      if (!releasing) actor.releaseAt = undefined

      if (character.dead) actor.deadSince ??= t
      else actor.deadSince = undefined

      // Posed only where it can be seen: not when it is hidden from the team, nor far off the screen (`inView`, which leaves room for
      // a shadow that falls onto it). What it is doing is still kept up above, so it is right the moment it comes into view.
      const seen = !hidden.has(character.id) && (hints.inView?.(position, model.height) ?? true)
      if (seen) model.pose({
        t,
        dt,
        moving,
        speed: actor.speed,
        ...(character.action ? { action: { kind: character.action.kind, progress: character.action.progress } } : {}),
        ...(releasing && actor.releaseKind ? { release: { kind: actor.releaseKind, t: (t - (actor.releaseAt ?? t)) / RELEASE_SECONDS } } : {}),
        dead: character.dead,
        deadFor: actor.deadSince === undefined ? 0 : t - actor.deadSince,
        stunned: character.stunned || character.airborne,
      })
      if (model instanceof StructureModel) model.setProtected(character.invulnerable === true && !character.dead, t)
      else model.setOutline(localTeam !== undefined && character.team !== localTeam && !character.dead)

      // Where it stands: on the ground, or up in the air while knocked up, spinning.
      const lift = (character.lift ?? 0) * AIRBORNE_LIFT * 1.6
      model.root.position.set(position.x, lift, position.y)
      model.root.rotation.y = actor.yaw + (character.airborne ? (character.lift ?? 0) * Math.PI * 2 : 0)

      // Seen or not: a monster or a structure is gone a little after it dies (`layoutCorpse`), as in 2D.
      const corpse = layoutCorpse(character)
      const seenNow = !hidden.has(character.id)
      model.root.visible = seenNow && corpse.body
      model.setOpacity(character.invisible ? INVISIBLE_ALPHA : 1)
      if (model.root.visible && seen) model.ambient(fx, dt)

      this.updatePips(actor, character, t, seenNow && !character.dead)
      this.updateStars(actor, character, t, seenNow && !character.dead && character.stunned)
      if (seenNow && !character.dead) this.statusEffects(actor, character, fx, dt)
    })
  }

  dispose(): void {
    for (const actor of this.actors.values()) actor.model.dispose()
    this.actors.clear()
    this.pipGeometry.dispose()
    this.starGeometry.dispose()
    for (const material of this.pipMaterials.values()) material.dispose()
    this.starMaterial.dispose()
  }

  private add(character: RenderedCharacter): Actor {
    const model = buildModel(character, this.vision)
    const pips = new Group()
    const stars = new Group()
    for (let index = 0; index < 3; index += 1) {
      const star = new Mesh(this.starGeometry, this.starMaterial)
      star.scale.set(3.2, 3.2, 1.2)
      stars.add(star)
    }
    stars.visible = false
    this.group.add(model.root, pips, stars)
    // It faces the player until it first moves, as the sprites do.
    const actor: Actor = {
      model,
      pips,
      stars,
      movedAt: Number.NEGATIVE_INFINITY,
      speed: 0,
      yaw: 0,
    }
    this.actors.set(character.id, actor)
    return actor
  }

  // Its stacks (see `layoutStackPips`, which says how many of which colour) as small gems turning round its middle.
  private updatePips(actor: Actor, character: RenderedCharacter, t: number, shown: boolean): void {
    // A stack that empowers the next blow is shown as the weapon glowing (see `CharacterFx`), not as a pip.
    // So is a mark drawn on the ground under it (see `CharacterFx.marks`).
    const stacks = Object.fromEntries(Object.entries(character.stacks).filter(([key]) => !(key in EMPOWERING) && !GROUND_MARKS.has(key)))
    const pips = shown ? layoutStackPips(stacks, character.champion.radius) : []
    actor.pips.visible = pips.length > 0
    while (actor.pips.children.length < pips.length) actor.pips.add(new Mesh(this.pipGeometry))
    actor.pips.children.forEach((child, index) => {
      const pip = pips[index]
      child.visible = pip !== undefined
      if (!pip) return
      const mesh = child as Mesh
      mesh.material = this.pipMaterial(pip.color)
      const angle = t * 2.2 + index * Math.PI * 2 / pips.length
      const radius = character.champion.radius * 1.15
      mesh.position.set(Math.cos(angle) * radius, actor.model.height * 0.45 + (pip.shape === 'diamond' ? 0 : 8), Math.sin(angle) * radius)
      mesh.scale.set(3.6, 5, 3.6)
      mesh.rotation.y = t * 3
    })
    actor.pips.position.copy(actor.model.root.position)
  }

  private updateStars(actor: Actor, character: RenderedCharacter, t: number, shown: boolean): void {
    actor.stars.visible = shown
    if (!shown) return
    actor.stars.position.set(character.position.x, actor.model.root.position.y + actor.model.height + 6, character.position.y)
    actor.stars.children.forEach((star, index) => {
      const angle = t * 5 + index * Math.PI * 2 / 3
      star.position.set(Math.cos(angle) * 14, Math.sin(t * 8 + index) * 2, Math.sin(angle) * 14)
      star.rotation.y = t * 6
    })
  }

  // What its statuses look like on it: flames off one that is burning, drops of blood off one that is bleeding, puffs of spores
  // or poison, and the motes of going back.
  private statusEffects(actor: Actor, character: RenderedCharacter, fx: FxContext, dt: number): void {
    const base = actor.model.root.position
    const radius = character.champion.radius
    const height = actor.model.height
    const around = (): { x: number; y: number; z: number } => {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.random() * radius * 0.8
      return { x: base.x + Math.cos(angle) * distance, y: base.y + Math.random() * height * 0.8, z: base.z + Math.sin(angle) * distance }
    }
    if (character.burning && Math.random() < dt * 40) {
      const at = around()
      fx.glow.emit({ ...at, vy: 40 + Math.random() * 30, life: 0.45, size: 12, sizeEnd: 3, color: colour('#ffcc55'), colorEnd: colour('#ff3a10'), alpha: 0.9, fadeIn: 0.1 })
    }
    if (character.bleeding && Math.random() < dt * 14) {
      const at = around()
      fx.puff.emit({ ...at, vx: (Math.random() - 0.5) * 20, vy: 10, vz: (Math.random() - 0.5) * 20, life: 0.6, size: 3.5, color: colour('#b3121f'), alpha: 0.95, gravity: -220 })
    }
    if ((character.spored || character.poisoned) && Math.random() < dt * 10) {
      const at = around()
      fx.puff.emit({ ...at, vy: 12, vx: (Math.random() - 0.5) * 16, vz: (Math.random() - 0.5) * 16, life: 1, size: 5, sizeEnd: 9, color: colour(character.spored ? '#c8d86a' : '#7ad15a'), alpha: 0.6 })
    }
    if (character.backing !== undefined && Math.random() < dt * 30) {
      const angle = Math.random() * Math.PI * 2
      fx.glow.emit({
        x: base.x + Math.cos(angle) * radius * 1.4,
        y: 2,
        z: base.z + Math.sin(angle) * radius * 1.4,
        vy: 50 + character.backing * 60,
        life: 0.9,
        size: 6,
        sizeEnd: 1,
        color: colour('#8fd8ff'),
        alpha: 0.9,
      })
    }
    if (character.stacks.empowered && actor.model instanceof HumanoidModel && Math.random() < dt * 24) {
      // Capricorn's empowered auto: water swirling round the staff's stone.
      const at = actor.model.focus()
      const angle = Math.random() * Math.PI * 2
      fx.glow.emit({ x: at.x + Math.cos(angle) * 9, y: at.y, z: at.z + Math.sin(angle) * 9, vx: -Math.sin(angle) * 30, vy: 6, vz: Math.cos(angle) * 30, life: 0.5, size: 5, sizeEnd: 1, color: colour('#7fd6ff'), alpha: 0.9 })
    }
  }

  private pipMaterial(css: string): MeshBasicMaterial {
    let material = this.pipMaterials.get(css)
    if (!material) {
      material = new MeshBasicMaterial({ color: css })
      this.pipMaterials.set(css, material)
    }
    return material
  }
}

function turnToward(current: number, target: number, dt: number, boost = 1): number {
  const delta = angleDelta(current, target)
  const step = TURN_RATE * boost * dt
  return Math.abs(delta) <= step ? target : current + Math.sign(delta) * step
}

// The model for a character: a structure by what it is, a monster by which, and a champion by how it fights.
function buildModel(character: RenderedCharacter, vision: VisionShading): Model {
  const team = getTeam(character.team).color
  const radius = character.champion.radius
  if (character.turret?.zone) return new HealingZoneModel(vision, radius, team, character.turret.core)
  if (character.turret?.core) return new CoreModel(vision, radius, team)
  if (character.turret) return new TurretModel(vision, radius, team)
  const id = character.champion.id
  if (character.monster) {
    if (id === 'golem') return new GolemModel(vision, radius)
    if (id === 'slime') return new SlimeModel(vision, radius)
    if (id === 'wolf') return new WolfModel(vision, radius)
    return radius >= 36 ? new GolemModel(vision, radius) : new WolfModel(vision, radius)
  }
  return championModel(vision, character.champion)
}

