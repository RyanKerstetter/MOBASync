import {
  abilityDefs,
  CURSE_DURATION_TICKS,
  CURSE_KEY,
  CURSE_MAX_STACKS,
  EMPOWER_BONUS_DAMAGE,
  EMPOWER_DURATION_TICKS,
  EMPOWER_KEY,
  FEAR_BONUS,
  FLURRY_KEY,
  FLURRY_SLOW,
  FLURRY_SLOW_TICKS,
  FEAR_RADIUS,
  FIRST_STRIKE_COOLDOWN_TICKS,
  LINK_BREAK_EFFECTS,
  LINK_KEY,
  LINK_SHARE,
  MONK_AUTO_REFUND_TICKS,
  MONK_DAMAGE_REDUCTION,
  PLATING_KEY,
  PLATING_MAX_STACKS,
  PLATING_RESISTANCE_PER_STACK,
  PLATING_SCALING_PER_LEVEL,
  PLATING_TICKS,
  RAGE_AUTO_TICKS,
  RAGE_KEY,
  RAGE_MAX_TICKS,
  SAGE_HASTE,
  SAGE_HASTE_NAME,
  SAGE_HASTE_TICKS,
  SAGE_HEAL,
  SAGE_HEAL_SCALING,
  SAGE_KEY,
  SAGE_MARK_TICKS,
  SHADOW_KEY,
  SHADOW_MAX_STACKS,
  SHADOW_STACK_TICKS,
  SIGHTED_AUTOS,
  SIGHTED_HASTE,
  SIGHTED_HASTE_TICKS,
  SIGHTED_KEY,
  SIGHTED_WINDOW_TICKS,
  terrify,
  TRICK_BONUS_DAMAGE,
  TRICK_HASTE,
  TRICK_HASTE_TICKS,
  TRICK_HITS,
  TRICK_WINDOW_TICKS,
  readyKey,
  SWORD_DAMAGE_PER_STACK,
  SWORD_DURATION_TICKS,
  SWORD_KEY,
  SWORD_MAX_STACKS,
  SHADOW_AUTO_BONUS,
  firstStrike,
} from './abilities.js'
import { GAME_TPS } from './constants.js'
import {
  areEnemies,
  arcane,
  attackDamage,
  damage,
  endNamed,
  haste,
  heal,
  linear,
  mark,
  popMarkers,
  prolong,
  reduceCooldown,
  runEffects,
  scaled,
  self,
  slow,
  spawnEntity,
  stacks,
  statBuff,
  subject,
  when,
  type Effect,
  type EffectSource,
  type EntityDef,
  type Selector,
  type SimContext,
  type SimReader,
} from './effects.js'
import type { Status } from './index.js'
import { STRUCTURE_ARCANE_DAMAGE } from './structures.js'
import { BASE_STAT_DEFAULTS, NO_GROWTH, StatBlock, type BaseStatsDef, type ChampionStats, type StatValues } from './stats.js'

// A shot an auto attack fires instead of landing at once. It flies straight at its target, turning
// with it, until it touches, and `onAttackHit` runs then. It has no timer of its own: it ends on
// the hit, or when its target dies or leaves the game.
export interface AttackProjectileDef {
  // Distance per second. Faster than the target can run, or it never lands.
  speed: number
  // How big the shot is, drawn and for touching: it lands once it is within this plus the radius
  // of its target.
  radius: number
  // Client-only fill colour, for example '#6dd39b'.
  color?: string
}

// A bar the page draws over a champion that shows how long one of its statuses has left, running down as it does: a rage that is spent. It reads the
// statuses the champion has under the name `status` (see `prolong`), and is full when `ticks` of them are left.
export interface ChampionMeterDef {
  status: string
  ticks: number
  // Client-only fill colour, for example '#e5534b'.
  color: string
}

export interface ChampionDef {
  id: string
  name: string
  // One line shown on the champion select screen.
  description?: string
  // The always-on ability, described for the select screen. Its effects live in onAttackHit.
  passive?: string
  // What it is at level 1 (see stats.ts): its health, its attack damage and its attack speed (attacks a second), which it has to say, and
  // its resistance, haste and arcane (ability power), which it can leave out for none of each.
  base: BaseStatsDef
  // What each level after the first adds to each of the same six. A stat it leaves out (or all of them, by leaving this out) does not grow.
  growth?: Partial<StatValues>
  moveSpeed: number
  radius: number
  attackRange: number
  // How much of the time one attack takes, from the start of one to the start of the next, goes before the hit lands (or the shot leaves):
  // 0 for an attack that lands the moment it starts, 0.25 for one that lands a quarter of the way through, and 1 at most. It is a share
  // of the attack and not a number of ticks, so it shortens as the attack speed rises, with the rest of the attack (see
  // `attackWindupTicksWith`).
  attackWindup: number
  // Leave it out for an instant attack, which lands the moment its windup finishes, however far
  // away the target is. Set it for a ranged attack that fires a shot and lands on arrival.
  attackProjectile?: AttackProjectileDef
  // Ability IDs in slot order (Q, W, E, R).
  abilities: readonly string[]
  // Runs against the attack target when an auto-attack lands: when the windup finishes, or for an
  // attack with a projectile, when the shot arrives.
  onAttackHit?: readonly Effect[]
  // Runs for the caster whenever one of its abilities launches, after the ability's own effects.
  onCast?: readonly Effect[]
  // A bar over the champion that shows how long one of its statuses has left. Nothing is drawn while it has none.
  meter?: ChampionMeterDef
  // Every hit it does (an auto or an ability) does this much more, as a share of itself (0.3 is 30% more), to a unit that has a status of this kind that the
  // champion itself put on it, such as a fear.
  bonusAgainst?: { status: Status['kind']; fraction: number }
  // Killing a champion (a player, not a monster) makes every ability it has ready again, on the tick of the kill.
  resetsCooldownsOnKill?: boolean
  // Runs for the champion whenever it stops being invisible, whether the time ran out or it attacked or cast and was seen: after what it did, if it did something.
  // It is run at the champion's position, and does not run for one that dies invisible.
  onLeaveInvisibility?: readonly Effect[]
  // How far what `onLeaveInvisibility` does reaches from the champion, if it reaches round it: the page draws a ring this big round the champion you control while it is
  // invisible, so you can see who would be caught when you are seen. A body counts as caught when any of it is in the ring.
  leaveInvisibilityRadius?: number
  // Every hit it takes does this much less, as a share (0.2 is 20% less), whatever the source (an auto, an ability, a burn): on top of its resistance, and before its shields.
  damageReduction?: number
  // A unit with a marker of this `key` that this champion put on it (a link) hands the champion `share` of every hit it takes, and takes that much less of it (0.4 is 40%): the champion
  // takes its share as it would any hit, from its own resistance and shields on, and it is credited to whoever struck the unit. Nothing passes while the champion is dead.
  // A share that would kill the champion is not taken: the link breaks instead, its markers come off the unit, and the whole of the hit is the unit's. `onBreak` is run for the
  // champion as that happens, before the markers are taken off so that it can still find who was linked (what the link gives back on ending, say).
  damageLink?: { key: string; share: number; onBreak?: readonly Effect[] }
}

type StatusBonus = { kind: string; stat?: string; amount: number }

// One shot definition per distinct shot, shared by every champion that fires it. The definition
// names no champion: its hit runs the shooter's own `onAttackHit`. So a copy of a champion with
// other effects reuses the shot instead of registering a clashing one, and the client and server
// agree on its ID because it comes only from the numbers.
const autoShots = new Map<string, EntityDef>()

function launchAutoShot(projectile: AttackProjectileDef): Effect {
  const id = `auto-shot:${projectile.speed}:${projectile.radius}:${projectile.color ?? ''}`
  let shot = autoShots.get(id)
  if (!shot) {
    shot = {
      id,
      speed: projectile.speed,
      radius: projectile.radius,
      homing: true,
      ...(projectile.color ? { color: projectile.color } : {}),
      onHit: [(sim, src) => runEffects(sim.character(src.ownerId)?.champion.attackEffects ?? [], sim, src)],
    }
    autoShots.set(id, shot)
  }
  return spawnEntity(shot)
}

// What an auto attack on a structure (a turret or a core) does on top of its damage: a point for each point of its attacker's arcane (see
// `STRUCTURE_ARCANE_DAMAGE`). It is one extra hit for the whole attack, so the effects an attack adds (an ability readied for it, a champion's own)
// do not each add it again, and an attack with no arcane behind it, or on anything else, adds nothing.
const ownArcane = arcane()
const arcaneOnStructure: Effect<SimContext> = when<SimContext>(
  (sim, src) => STRUCTURE_ARCANE_DAMAGE > 0 && src.subject !== null && sim.character(src.subject)?.structure === true && ownArcane(sim, src) > 0,
  [damage(scaled(0, { arcane: STRUCTURE_ARCANE_DAMAGE }))],
)

// Monk's Flurry gives whoever he gives it to (himself, or the teammate he has linked, a champion of any kind) charges to carry, so what an auto does with them is part of every
// champion's autos. Each is spent by an auto, and the auto that spends one slows what it hits; the last one also ends the attack speed that came with them (it is the one status of the
// name `FLURRY_KEY`, see `statBuff`).
const flurryCharges = stacks(FLURRY_KEY, self())
const spendFlurry: Effect<SimContext> = (sim, src) => {
  const left = flurryCharges(sim, src)
  if (left <= 0) return
  runEffects([popMarkers(FLURRY_KEY, self(), { count: 1 }), ...(left === 1 ? [endNamed(FLURRY_KEY)] : [])], sim, src)
}
const flurryHit: Effect<SimContext> = when<SimContext>(
  (sim, src) => flurryCharges(sim, src) > 0,
  [slow(FLURRY_SLOW, FLURRY_SLOW_TICKS), spendFlurry],
)

// Sage's mend is poppable by anyone on her side: an auto of any of her team (herself, or a champion of any kind) on an enemy she has mended uses the mend up, to heal whoever made the
// auto and give them move speed, so what an auto does with it is part of every champion's autos. It is Sage's passive that does it, so it runs as her: what the heal is worth is
// worked out from her arcane and not from the arcane of whoever hit, and it is her mend that comes off. Each mender's mend is its own: two Sages' mends on an enemy are two, and one
// auto uses up both. A mend that a Sage left behind when she died is still there to be used until it runs out. An enemy of hers uses none, and one that is not hers is left alone.
const mendHeal = scaled(SAGE_HEAL, SAGE_HEAL_SCALING)
const popMends: Effect<SimContext> = (sim, src) => {
  if (src.subject === null) return
  const attacker = sim.character(src.ownerId)
  if (!attacker) return
  const menders = [...new Set(sim.markersOn(src.subject, SAGE_KEY).map((marker) => marker.ownerId))].sort((left, right) => left - right)
  for (const menderId of menders) {
    const mender = sim.character(menderId)
    if (!mender || areEnemies(attacker, mender)) continue
    const attacking: Selector = () => [src.ownerId]
    runEffects(
      [
        heal(mendHeal, attacking),
        haste(SAGE_HASTE, SAGE_HASTE_TICKS, attacking, { named: SAGE_HASTE_NAME }),
        popMarkers(SAGE_KEY),
      ],
      sim,
      { ...src, id: `${src.id}:mend:u${menderId}`, ownerId: menderId },
    )
  }
}

// Whether the unit an auto is aimed at is dodging it.
const subjectDodging = (sim: SimReader, src: EffectSource): boolean =>
  src.subject !== null && sim.statusesOn(src.subject).some((status) => status.kind === 'dodge')

function sumStatBuffs(statuses: readonly StatusBonus[], stat: string): number {
  return statuses.reduce((total, status) => status.kind === 'stat' && status.stat === stat ? total + status.amount : total, 0)
}

function sumBonus(statuses: readonly StatusBonus[], kind: string): number {
  return statuses.reduce((total, status) => status.kind === kind ? total + status.amount : total, 0)
}

export class Champion {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly passive: string
  // What it is at level 1, and what each level after that adds: two blocks of the same six stats.
  readonly base: StatBlock
  readonly growth: StatBlock
  readonly moveSpeed: number
  readonly radius: number
  readonly attackRange: number
  // The share of an attack that is its windup (see `ChampionDef`).
  readonly attackWindup: number
  readonly attackProjectile: AttackProjectileDef | undefined
  readonly abilities: readonly string[]
  readonly onAttackHit: readonly Effect[]
  // Everything that happens when an auto lands: this champion's own `onAttackHit`, then the effects
  // of each ability that has readied the attack (`empowerAttack`), which spends its readiness. Against
  // a target that is dodging none of the effects happen, and only the readiness is spent. It is
  // worked out from the abilities, not given, so a copy of a champion made with other effects gets
  // its own.
  readonly attackEffects: readonly Effect[]
  // What the simulator runs when an auto's windup finishes: the attack effects themselves for an
  // instant attack, or the launch of the shot that carries them.
  readonly onAttackLaunch: readonly Effect[]
  readonly onCast: readonly Effect[]
  readonly meter: ChampionMeterDef | undefined
  readonly bonusAgainst: { status: Status['kind']; fraction: number } | undefined
  readonly resetsCooldownsOnKill: boolean
  readonly onLeaveInvisibility: readonly Effect[]
  readonly leaveInvisibilityRadius: number | undefined
  // The share of every hit it takes less of, from 0 for none (see `ChampionDef`).
  readonly damageReduction: number
  readonly damageLink: { key: string; share: number; onBreak?: readonly Effect[] } | undefined

  constructor(def: ChampionDef) {
    for (const abilityId of def.abilities) {
      if (!abilityDefs.has(abilityId)) {
        throw new Error(`Champion "${def.id}" references unknown ability "${abilityId}".`)
      }
      const recast = abilityDefs.get(abilityId)?.recast
      if (recast !== undefined && !abilityDefs.has(recast)) {
        throw new Error(`Champion "${def.id}" has ability "${abilityId}", whose recast "${recast}" is unknown.`)
      }
    }
    if (!(Number.isFinite(def.attackWindup) && def.attackWindup >= 0 && def.attackWindup <= 1)) {
      throw new Error(`Champion "${def.id}" has an attack windup that needs to be a share of the attack, from 0 to 1.`)
    }
    const projectile = def.attackProjectile
    if (projectile && !(projectile.speed > 0 && projectile.radius > 0
      && Number.isFinite(projectile.speed) && Number.isFinite(projectile.radius))) {
      throw new Error(`Champion "${def.id}" has an attack projectile that needs a positive speed and radius.`)
    }
    if (def.meter && !(def.meter.status.length > 0 && def.meter.ticks > 0 && Number.isFinite(def.meter.ticks))) {
      throw new Error(`Champion "${def.id}" has a meter that needs the name of a status and a number of ticks above 0.`)
    }
    // The stats moved into `base` and `growth`, so one left out on its own is refused, and not quietly ignored.
    for (const stat of ['maxHp', 'attackDamage', 'attackSpeed', 'resistance', 'haste', 'arcane']) {
      if (stat in def) throw new Error(`Champion "${def.id}" has ${stat} on its own: it goes in its base stats (and growth).`)
    }
    const block = (what: string, values: StatValues): StatBlock => {
      try {
        return new StatBlock(values)
      } catch (error) {
        throw new Error(`Champion "${def.id}" has ${what} stats that are wrong: it ${(error as Error).message}.`)
      }
    }
    // Left out of the growth, a stat adds nothing; left out of the base, the resistance, the haste and the arcane are none.
    // The health, the attack damage and the attack speed of a base are not left out (`undefined` is refused as not a number).
    const base = block('base', { ...BASE_STAT_DEFAULTS, ...def.base } as StatValues)
    const growth = block('growth', { ...NO_GROWTH, ...def.growth })
    this.id = def.id
    this.name = def.name
    this.description = def.description ?? ''
    this.passive = def.passive ?? ''
    this.base = base
    this.growth = growth
    this.moveSpeed = def.moveSpeed
    this.radius = def.radius
    this.attackRange = def.attackRange
    this.attackWindup = def.attackWindup
    this.attackProjectile = projectile ? { ...projectile } : undefined
    this.abilities = [...def.abilities]
    this.onAttackHit = def.onAttackHit ?? [damage(attackDamage())]
    // An ability applied through an auto leaves a marker on the champion when it is cast. The auto
    // that lands while the marker is there carries the ability's effects to its target and spends it.
    const readyKeys = this.abilities.flatMap((abilityId) =>
      abilityDefs.get(abilityId)?.empowerAttack ? [readyKey(abilityId)] : [])
    const readied = this.abilities.flatMap((abilityId) => {
      const empower = abilityDefs.get(abilityId)?.empowerAttack
      if (!empower) return []
      const key = readyKey(abilityId)
      return [when<SimContext>(
        (sim, src) => stacks(key, self())(sim, src) > 0,
        [...empower.effects, popMarkers(key, self())],
      )]
    })
    // An auto at a dodging target is spent and none of its effects land, whether it was a swing or a
    // shot: not the damage, not the champion's own on-hit effects, and not an ability readied for it,
    // whose readiness is used up all the same (and so is a Flurry charge).
    this.attackEffects = [when<SimContext>(
      subjectDodging,
      [...readyKeys.map((key) => popMarkers(key, self())), spendFlurry],
      [...this.onAttackHit, ...readied, flurryHit, popMends, arcaneOnStructure],
    )]
    this.onAttackLaunch = this.attackProjectile ? [launchAutoShot(this.attackProjectile)] : this.attackEffects
    this.onCast = def.onCast ?? []
    this.meter = def.meter ? { ...def.meter } : undefined
    if (def.bonusAgainst && !(def.bonusAgainst.fraction > 0 && Number.isFinite(def.bonusAgainst.fraction))) {
      throw new Error(`Champion "${def.id}" has a bonus against a status that needs to be a share above 0.`)
    }
    this.bonusAgainst = def.bonusAgainst ? { ...def.bonusAgainst } : undefined
    this.resetsCooldownsOnKill = def.resetsCooldownsOnKill === true
    this.onLeaveInvisibility = def.onLeaveInvisibility ?? []
    if (def.leaveInvisibilityRadius !== undefined && !(def.leaveInvisibilityRadius > 0 && Number.isFinite(def.leaveInvisibilityRadius))) {
      throw new Error(`Champion "${def.id}" has a radius for what it does on leaving invisibility that needs to be above 0.`)
    }
    this.leaveInvisibilityRadius = def.leaveInvisibilityRadius
    if (def.damageReduction !== undefined && !(def.damageReduction >= 0 && def.damageReduction < 1)) {
      throw new Error(`Champion "${def.id}" has a damage reduction that needs to be a share from 0 up to (but not including) 1.`)
    }
    this.damageReduction = def.damageReduction ?? 0
    if (def.damageLink && !(def.damageLink.key.length > 0 && def.damageLink.share > 0 && def.damageLink.share <= 1)) {
      throw new Error(`Champion "${def.id}" has a damage link that needs the key of a marker and a share above 0 and at most 1.`)
    }
    this.damageLink = def.damageLink ? { ...def.damageLink } : undefined
  }

  // Every ability it can cast: the ones on its keys, and the recasts that take their place.
  castableAbilities(): string[] {
    return this.abilities.flatMap((abilityId) => {
      const recast = abilityDefs.get(abilityId)?.recast
      return recast === undefined ? [abilityId] : [abilityId, recast]
    })
  }

  // Its stats at this level: the ones it is made with at level 1, and each level after that adds its growth. The health is a whole
  // number, as health is; the rest are as they come out. What does not grow (the range, the speed) is the same at every level.
  statsAt(level: number): ChampionStats {
    const gained = Number.isFinite(level) ? Math.max(0, Math.floor(level) - 1) : 0
    const grown = this.base.grownBy(this.growth, gained)
    return { ...grown, maxHp: Math.round(grown.maxHp), attackRange: this.attackRange, moveSpeed: this.moveSpeed }
  }

  // Its base stats, read on their own: what it is at level 1.
  get maxHp(): number {
    return this.base.maxHp
  }

  get attackDamage(): number {
    return this.base.attackDamage
  }

  get attackSpeed(): number {
    return this.base.attackSpeed
  }

  get resistance(): number {
    return this.base.resistance
  }

  get haste(): number {
    return this.base.haste
  }

  get arcane(): number {
    return this.base.arcane
  }

  // At level 1.
  get attackCooldownTicks(): number {
    return this.attackCooldownTicksWith([])
  }

  // Attack range and cooldown with the owner's active attack-range and attack-speed (stat buff) statuses, and for the cooldown the attack speed
  // of the owner's level.
  // `itemRange` and `itemSpeed` are what the champion's items add to its attack range and its attacks a second (see items.ts), and `itemSpeedBonus` is the
  // share more attack speed they give (0.15 is 15% more, of the attack speed with what they add, and before a buff is added: see `itemAttackSpeedBonus`).
  attackRangeWith(statuses: readonly StatusBonus[], itemRange = 0): number {
    return this.attackRange + itemRange + sumBonus(statuses, 'attackrange')
  }

  attackCooldownTicksWith(statuses: readonly StatusBonus[], level = 1, itemSpeed = 0, itemSpeedBonus = 0): number {
    const speed = (this.statsAt(level).attackSpeed + itemSpeed) * (1 + itemSpeedBonus) + sumStatBuffs(statuses, 'attackSpeed')
    return Math.max(1, Math.ceil(GAME_TPS / speed))
  }

  // At level 1.
  get attackWindupTicks(): number {
    return this.attackWindupTicksWith([])
  }

  // How long an attack takes to land once it starts: its windup's share of the whole attack, at the attack speed it has now. The more
  // attack speed it has the shorter the whole attack is, and so the shorter its windup is, in the same share.
  attackWindupTicksWith(statuses: readonly StatusBonus[], level = 1, itemSpeed = 0, itemSpeedBonus = 0): number {
    return Math.round(this.attackWindup * this.attackCooldownTicksWith(statuses, level, itemSpeed, itemSpeedBonus))
  }

  // An ability on one of its keys, or the recast that takes the place of one while it can be cast.
  hasAbility(abilityId: string): boolean {
    return this.abilities.includes(abilityId)
      || this.abilities.some((id) => abilityDefs.get(id)?.recast === abilityId)
  }

  abilityInSlot(slot: number): string | undefined {
    return this.abilities[slot]
  }
}

// Grenadier's passive, read when an auto lands: how many autos the target has taken so far.
const sightedOnTarget = stacks(SIGHTED_KEY, subject())

// Ninja's passive, read when an auto lands: whether it has a shadow stack to spend (one at most is
// spent by each auto).
const shadowStacksOnSelf = stacks(SHADOW_KEY, self())
const hasShadowStack = (sim: SimReader, src: EffectSource): number => Math.min(1, shadowStacksOnSelf(sim, src))

// What Ninja's auto deals: its attack damage, times 1 + SHADOW_AUTO_BONUS if it has a shadow stack to spend on it (a stack is spent by the
// auto, so the damage is read before it goes), and plain attack damage with none.
const ownAttackDamage = attackDamage()
const shadowAutoDamage = (sim: SimReader, src: EffectSource): number =>
  ownAttackDamage(sim, src) * (1 + SHADOW_AUTO_BONUS * hasShadowStack(sim, src))

// Hammer's passive, read when an auto lands: the stacks of plating he has before this auto adds its own, and what the resistance comes to with it. A stack is
// worth its base plus a number of points for each level he is (like any amount that grows with the level: see `scaled`). The stacks end together, and every auto
// renews the stacks and the buff that is made from them, so a level he gains is in the resistance from his next auto.
const platingStacksOnSelf = stacks(PLATING_KEY, self())
const platingPerStack = scaled(PLATING_RESISTANCE_PER_STACK, { level: PLATING_SCALING_PER_LEVEL })
const platingResistance = (sim: SimReader, src: EffectSource): number =>
  Math.min(PLATING_MAX_STACKS, platingStacksOnSelf(sim, src) + 1) * platingPerStack(sim, src)

export const DEFAULT_CHAMPION_ID = 'cursebearer'

export const champions: ReadonlyMap<string, Champion> = new Map([
  new Champion({
    id: DEFAULT_CHAMPION_ID,
    name: 'Cursebearer',
    description: 'A ranged hexer that stacks curses on its prey, then cashes them in.',
    passive: `Auto attacks apply a curse stack to the target, up to ${CURSE_MAX_STACKS}. Each stack lasts ${CURSE_DURATION_TICKS / GAME_TPS} seconds.`,
    base: { maxHp: 800, attackDamage: 40, attackSpeed: 1, resistance: 0, haste: 0, arcane: 30 },
    growth: { maxHp: 65, attackDamage: 6, attackSpeed: 0.03, resistance: 3, haste: 8, arcane: 18 },
    moveSpeed: 140,
    radius: 20,
    attackRange: 190,
    attackWindup: 0.2,
    attackProjectile: { speed: 550, radius: 6, color: '#b07cf2' },
    abilities: ['feast', 'miasma', 'hex'],
    onAttackHit: [
      damage(attackDamage()),
      mark(CURSE_KEY, CURSE_DURATION_TICKS, subject(), { cap: CURSE_MAX_STACKS }),
    ],
  }),
  new Champion({
    id: 'archer',
    name: 'Archer',
    description: 'A mobile marksman that leaps in and out of fights and kites with a long reach.',
    passive: 'Every auto attack reduces the cooldown of Leap by 1 second.',
    base: { maxHp: 700, attackDamage: 75, attackSpeed: 1, resistance: 0, haste: 0, arcane: 15 },
    growth: { maxHp: 50, attackDamage: 14, attackSpeed: 0.05, resistance: 3, haste: 2, arcane: 4 },
    moveSpeed: 150,
    radius: 19,
    attackRange: 240,
    attackWindup: 0.23,
    attackProjectile: { speed: 900, radius: 5, color: '#6dd39b' },
    abilities: ['leap', 'focus', 'snare'],
    onAttackHit: [damage(attackDamage()), reduceCooldown('leap', GAME_TPS)],
  }),
  new Champion({
    id: 'swordsman',
    name: 'Swordsman',
    description: 'A melee duelist that builds sword stacks with every blow and spends them on bursts, roots and stuns.',
    passive: `Auto attacks give you a sword stack, up to ${SWORD_MAX_STACKS}, lasting ${SWORD_DURATION_TICKS / GAME_TPS} seconds. Each stack adds ${SWORD_DAMAGE_PER_STACK} damage to your autos and to Slash.`,
    base: { maxHp: 1000, attackDamage: 80, attackSpeed: .9, resistance: 0, haste: 0, arcane: 20 },
    growth: { maxHp: 75, attackDamage: 16, attackSpeed: 0.01, resistance: 8, haste: 6, arcane: 7 },
    moveSpeed: 145,
    radius: 22,
    attackRange: 90,
    attackWindup: 0.19,
    abilities: ['slash', 'radiance', 'shackle'],
    // The auto reads the stacks before this hit adds one.
    onAttackHit: [
      damage(linear(attackDamage(), SWORD_DAMAGE_PER_STACK, stacks(SWORD_KEY, self()))),
      mark(SWORD_KEY, SWORD_DURATION_TICKS, self(), { cap: SWORD_MAX_STACKS }),
    ],
  }),
  new Champion({
    id: 'capricorn',
    name: 'Capricorn',
    description: 'A water mage that weaves its spells into empowered attacks.',
    passive: `Your next auto attack after casting a spell deals ${EMPOWER_BONUS_DAMAGE} bonus damage.`,
    base: { maxHp: 850, attackDamage: 40, attackSpeed: .8, resistance: 0, haste: 0, arcane: 30 },
    growth: { maxHp: 30, attackDamage: 2, attackSpeed: 0.01, resistance: 2, haste: 9, arcane: 22 },
    moveSpeed: 145,
    radius: 21,
    attackRange: 250,
    attackWindup: 0.21,
    attackProjectile: { speed: 500, radius: 7, color: '#a8e0ff' },
    abilities: ['tsunami', 'bubbles', 'spout'],
    // Any spell empowers the next auto (casting twice does not stack it); the auto spends it.
    onCast: [mark(EMPOWER_KEY, EMPOWER_DURATION_TICKS, self(), { cap: 1 })],
    onAttackHit: [
      damage(linear(attackDamage(), EMPOWER_BONUS_DAMAGE, stacks(EMPOWER_KEY, self()))),
      popMarkers(EMPOWER_KEY, self()),
    ],
  }),
  new Champion({
    id: 'soldier',
    name: 'Soldier',
    description: 'Shoots from range. Trades health for speed and brings a medic.',
    base: { maxHp: 750, attackDamage: 55, attackSpeed: 1, resistance: 0, haste: 0, arcane: 10 },
    growth: { maxHp: 60, attackDamage: 12, attackSpeed: 0.04, resistance: 5, haste: 4, arcane: 4 },
    moveSpeed: 150,
    radius: 21,
    attackRange: 220,
    attackWindup: 0.2,
    attackProjectile: { speed: 800, radius: 5, color: '#ffb347' },
    abilities: ['stim', 'bolt', 'medic'],
  }),
  new Champion({
    id: 'grenadier',
    name: 'Grenadier',
    description: 'A ranged bomber that bounces off its own grenades, burns the ground, and stuns or blinds with flashbangs.',
    passive: `After ${SIGHTED_AUTOS} auto attacks on the same enemy within ${SIGHTED_WINDOW_TICKS / GAME_TPS} seconds, gain ${SIGHTED_HASTE * 100}% move speed that fades away over ${SIGHTED_HASTE_TICKS / GAME_TPS} seconds.`,
    base: { maxHp: 800, attackDamage: 60, attackSpeed: .9, resistance: 0, haste: 0, arcane: 20 },
    growth: { maxHp: 50, attackDamage: 9, attackSpeed: 0.03, resistance: 3, haste: 7, arcane: 12 },
    moveSpeed: 145,
    radius: 20,
    attackRange: 220,
    attackWindup: 0.22,
    attackProjectile: { speed: 650, radius: 6, color: '#d4b13a' },
    abilities: ['grenade', 'molotov', 'flashbang'],
    // Each auto marks its target; the third pops the marks for the speed instead of adding one.
    onAttackHit: [
      damage(attackDamage()),
      when<SimContext>(
        (sim, src) => sightedOnTarget(sim, src) >= SIGHTED_AUTOS - 1,
        [
          popMarkers(SIGHTED_KEY),
          haste(SIGHTED_HASTE, SIGHTED_HASTE_TICKS, self(), { fades: true }),
        ],
        [mark(SIGHTED_KEY, SIGHTED_WINDOW_TICKS, subject(), { cap: SIGHTED_AUTOS - 1 })],
      ),
    ],
  }),
  new Champion({
    id: 'trinketmaster',
    name: 'Trinketmaster',
    description: 'A melee trickster that throws a stick, calls it back through enemies, and warps to it.',
    passive: `After ${TRICK_HITS - 1} ability hits on the same enemy within ${TRICK_WINDOW_TICKS / GAME_TPS} seconds of each other, the next one deals ${TRICK_BONUS_DAMAGE} bonus damage and gives you ${TRICK_HASTE * 100}% move speed for ${TRICK_HASTE_TICKS / GAME_TPS} seconds. Your stick, going out and coming back, and the auto that Hush readies are ability hits; your plain autos are not.`,
    base: { maxHp: 900, attackDamage: 65, attackSpeed: .9, resistance: 0, haste: 0, arcane: 25 },
    growth: { maxHp: 30, attackDamage: 2, attackSpeed: 0.01, resistance: 2, haste: 10, arcane: 20 },
    moveSpeed: 150,
    radius: 21,
    attackRange: 90,
    attackWindup: 0.18,
    // Q is the stick, and becomes the recall while the stick is out.
    abilities: ['stick', 'hush', 'warp'],
  }),
  new Champion({
    id: 'ninja',
    name: 'Ninja',
    description: 'A melee skirmisher that dashes through enemies, leaves shadows to dash back to, and dodges autos.',
    passive: `Dashing through an enemy with Shadow Step gives you a shadow stack, up to ${SHADOW_MAX_STACKS} for ${SHADOW_STACK_TICKS / GAME_TPS} seconds. Each auto attack spends one for ${SHADOW_AUTO_BONUS * 100}% bonus damage, and so does Shuriken, which then roots.`,
    base: { maxHp: 800, attackDamage: 80, attackSpeed: 1, resistance: 0, haste: 0, arcane: 10 },
    growth: { maxHp: 60, attackDamage: 14, attackSpeed: 0.03, resistance: 3, haste: 8, arcane: 4 },
    moveSpeed: 155,
    radius: 20,
    attackRange: 85,
    attackWindup: 0.17,
    // Q dashes, then dashes back to the shadow it left; W is the kunai; E dodges.
    abilities: ['shadowstep', 'shuriken', 'dodge'],
    // The auto reads the stacks before it spends one.
    onAttackHit: [
      damage(shadowAutoDamage),
      popMarkers(SHADOW_KEY, self(), { count: 1 }),
    ],
  }),
  new Champion({
    id: 'hammer',
    name: 'Hammer',
    description: 'A hulking bruiser that toughens with every blow, leaps onto its prey and flies into a rage.',
    passive: `Auto attacks give a stack of resistance, up to ${PLATING_MAX_STACKS}. Stacks last ${PLATING_TICKS / GAME_TPS} seconds and every auto renews them.`,
    base: { maxHp: 1100, attackDamage: 70, attackSpeed: .9, resistance: 0, haste: 0, arcane: 10 },
    growth: { maxHp: 90, attackDamage: 10, attackSpeed: 0.02, resistance: 8, haste: 6, arcane: 3 },
    moveSpeed: 145,
    radius: 24,
    attackRange: 100,
    attackWindup: 0.25,
    // Q slams the ground in front, W jumps to a marked spot, E is the rage.
    abilities: ['slam', 'hammerdrop', 'rage'],
    // The auto reads the stacks before it adds its own. It also makes a rage that is running last longer, and does nothing if there is none.
    onAttackHit: [
      damage(attackDamage()),
      mark(PLATING_KEY, PLATING_TICKS, self(), { cap: PLATING_MAX_STACKS }),
      statBuff('resistance', platingResistance, PLATING_TICKS, self(), { named: PLATING_KEY }),
      prolong(RAGE_KEY, RAGE_AUTO_TICKS, RAGE_MAX_TICKS),
    ],
    meter: { status: RAGE_KEY, ticks: RAGE_MAX_TICKS, color: '#e5534b' },
  }),
  new Champion({
    id: 'chain',
    name: 'Chain',
    description: 'A melee skirmisher that hooks enemies in, whirls its chains around it and dashes through fights.',
    passive: `The first auto on an enemy, or first hit on it with the edge of Whirl, deals bonus damage and heals you. Each enemy has its own ${FIRST_STRIKE_COOLDOWN_TICKS / GAME_TPS} second cooldown.`,
    base: { maxHp: 900, attackDamage: 70, attackSpeed: 1, resistance: 0, haste: 0, arcane: 10 },
    growth: { maxHp: 65, attackDamage: 16, attackSpeed: 0.02, resistance: 5, haste: 8, arcane: 3 },
    moveSpeed: 150,
    radius: 21,
    attackRange: 110,
    attackWindup: 0.2,
    // Q hooks, W charges for a second (he can walk but not attack while it does) and then lashes out round him, E dashes and can be used while W charges.
    abilities: ['hook', 'whirl', 'lunge'],
    onAttackHit: [damage(attackDamage()), firstStrike],
  }),
  new Champion({
    id: 'cloak',
    name: 'Cloak',
    description: 'A melee assassin that vanishes, scares off what is near when it appears, and finishes the feared with knives and a dash.',
    passive: `Leaving invisibility fears nearby enemies. You deal ${FEAR_BONUS * 100}% more damage to enemies you have feared, and killing a champion resets your cooldowns.`,
    base: { maxHp: 750, attackDamage: 60, attackSpeed: 1, resistance: 0, haste: 0, arcane: 10 },
    growth: { maxHp: 40, attackDamage: 16, attackSpeed: 0.01, resistance: 1, haste: 9, arcane: 3 },
    moveSpeed: 155,
    radius: 20,
    attackRange: 90,
    attackWindup: 0.17,
    // Q makes him invisible, W is a fan of knives, E is a dash through an enemy.
    abilities: ['ghost', 'knives', 'cutthrough'],
    // His hits do more to what he has feared (a fear is a status of his own), every kill of a champion makes his abilities ready, and ceasing to be invisible is what fears.
    bonusAgainst: { status: 'fear', fraction: FEAR_BONUS },
    resetsCooldownsOnKill: true,
    onLeaveInvisibility: terrify,
    leaveInvisibilityRadius: FEAR_RADIUS,
  }),
  new Champion({
    id: 'sage',
    name: 'Sage',
    description: 'A ranged healer that mends allies, roots and shoves back enemies, and feeds on the foes it has marked.',
    passive: `Heal Pulse and Vine Bolt mend the enemies they hit for ${SAGE_MARK_TICKS / GAME_TPS} seconds. An auto attack from you or an ally on a mended enemy uses up the mend to heal whoever hit it and give them ${SAGE_HASTE * 100}% move speed.`,
    base: { maxHp: 750, attackDamage: 50, attackSpeed: .9, resistance: 0, haste: 0, arcane: 30 },
    growth: { maxHp: 55, attackDamage: 7, attackSpeed: 0.02, resistance: 3, haste: 6, arcane: 16 },
    moveSpeed: 145,
    radius: 20,
    attackRange: 230,
    attackWindup: 0.22,
    attackProjectile: { speed: 600, radius: 6, color: '#8ee6a0' },
    // Q pulses out from her, W is a piercing bolt, E heals a teammate (or herself).
    abilities: ['pulse', 'vinebolt', 'rejuvenate'],
    // Her passive is in every champion's autos (see `popMends`), since her team uses her mends too: her own autos are plain.
  }),
  new Champion({
    id: 'monk',
    name: 'Monk',
    description: 'A melee guardian that links to a teammate to share their damage, and speeds up, shields and heals the pair.',
    passive: `Takes ${MONK_DAMAGE_REDUCTION * 100}% less damage. Auto attacks take ${MONK_AUTO_REFUND_TICKS / GAME_TPS} second off the cooldown of all your abilities.`,
    base: { maxHp: 1000, attackDamage: 60, attackSpeed: .9, resistance: 0, haste: 0, arcane: 10 },
    growth: { maxHp: 75, attackDamage: 4, attackSpeed: 0.01, resistance: 5, haste: 9, arcane: 12 },
    moveSpeed: 160,
    radius: 22,
    attackRange: 95,
    attackWindup: 0.2,
    // Q links to a teammate, or heals himself (and, with the link up, heals the teammate and ends the link), W quickens the next autos, E shields.
    abilities: ['link', 'flurry', 'guard'],
    damageReduction: MONK_DAMAGE_REDUCTION,
    damageLink: { key: LINK_KEY, share: LINK_SHARE, onBreak: LINK_BREAK_EFFECTS },
    // Every ability he can cast has its cooldown hurried along by his autos, Link Heal (the recast on Q) too.
    onAttackHit: [
      damage(attackDamage()),
      reduceCooldown('link', MONK_AUTO_REFUND_TICKS),
      reduceCooldown('linkheal', MONK_AUTO_REFUND_TICKS),
      reduceCooldown('flurry', MONK_AUTO_REFUND_TICKS),
      reduceCooldown('guard', MONK_AUTO_REFUND_TICKS),
    ],
  }),
].map((champion) => [champion.id, champion]))

export function getChampion(id: string): Champion {
  const champion = champions.get(id)
  if (!champion) throw new RangeError(`Unknown champion "${id}".`)
  return champion
}
