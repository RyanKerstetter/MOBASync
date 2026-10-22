import {
  abilityDefs,
  CURSE_DURATION_TICKS,
  CURSE_KEY,
  CURSE_MAX_STACKS,
  EMPOWER_BONUS_DAMAGE,
  EMPOWER_DURATION_TICKS,
  EMPOWER_KEY,
  SHADOW_AUTO_BONUS_DAMAGE,
  SHADOW_KEY,
  SHADOW_MAX_STACKS,
  SHADOW_STACK_TICKS,
  SIGHTED_AUTOS,
  SIGHTED_HASTE,
  SIGHTED_HASTE_TICKS,
  SIGHTED_KEY,
  SIGHTED_WINDOW_TICKS,
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
} from './abilities.js'
import { GAME_TPS } from './constants.js'
import {
  attackDamage,
  damage,
  haste,
  linear,
  mark,
  popMarkers,
  reduceCooldown,
  runEffects,
  self,
  spawnEntity,
  stacks,
  subject,
  subjectWithin,
  when,
  type Effect,
  type EffectSource,
  type EntityDef,
  type SimContext,
  type SimReader,
} from './effects.js'

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

export interface ChampionDef {
  id: string
  name: string
  // One line shown on the champion select screen.
  description?: string
  // The always-on ability, described for the select screen. Its effects live in onAttackHit.
  passive?: string
  maxHp: number
  moveSpeed: number
  radius: number
  attackDamage: number
  // Attacks per second.
  attackSpeed: number
  attackRange: number
  attackWindupTicks: number
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
}

type StatusBonus = { kind: string; amount: number }

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

// Whether the unit an auto is aimed at is dodging it.
const subjectDodging = (sim: SimReader, src: EffectSource): boolean =>
  src.subject !== null && sim.statusesOn(src.subject).some((status) => status.kind === 'dodge')

function sumBonus(statuses: readonly StatusBonus[], kind: string): number {
  return statuses.reduce((total, status) => status.kind === kind ? total + status.amount : total, 0)
}

export class Champion {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly passive: string
  readonly maxHp: number
  readonly moveSpeed: number
  readonly radius: number
  readonly attackDamage: number
  readonly attackSpeed: number
  readonly attackRange: number
  readonly attackWindupTicks: number
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
    const projectile = def.attackProjectile
    if (projectile && !(projectile.speed > 0 && projectile.radius > 0
      && Number.isFinite(projectile.speed) && Number.isFinite(projectile.radius))) {
      throw new Error(`Champion "${def.id}" has an attack projectile that needs a positive speed and radius.`)
    }
    this.id = def.id
    this.name = def.name
    this.description = def.description ?? ''
    this.passive = def.passive ?? ''
    this.maxHp = def.maxHp
    this.moveSpeed = def.moveSpeed
    this.radius = def.radius
    this.attackDamage = def.attackDamage
    this.attackSpeed = def.attackSpeed
    this.attackRange = def.attackRange
    this.attackWindupTicks = def.attackWindupTicks
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
    // whose readiness is used up all the same.
    this.attackEffects = [when<SimContext>(
      subjectDodging,
      readyKeys.map((key) => popMarkers(key, self())),
      [...this.onAttackHit, ...readied],
    )]
    this.onAttackLaunch = this.attackProjectile ? [launchAutoShot(this.attackProjectile)] : this.attackEffects
    this.onCast = def.onCast ?? []
  }

  get attackCooldownTicks(): number {
    return this.attackCooldownTicksWith([])
  }

  // Attack range and cooldown with the owner's active attack-range and attack-speed statuses.
  attackRangeWith(statuses: readonly StatusBonus[]): number {
    return this.attackRange + sumBonus(statuses, 'attackrange')
  }

  attackCooldownTicksWith(statuses: readonly StatusBonus[]): number {
    const speed = this.attackSpeed * (1 + sumBonus(statuses, 'attackspeed'))
    return Math.max(1, Math.ceil(GAME_TPS / speed))
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

// Soldier's passive: a target this close (centre to centre) is hit with a melee strike that does more.
const SOLDIER_MELEE_RANGE = 60
const SOLDIER_MELEE_BONUS = 0.6

// Grenadier's passive, read when an auto lands: how many autos the target has taken so far.
const sightedOnTarget = stacks(SIGHTED_KEY, subject())

// Ninja's passive, read when an auto lands: whether it has a shadow stack to spend (one at most is
// spent by each auto).
const shadowStacksOnSelf = stacks(SHADOW_KEY, self())
const hasShadowStack = (sim: SimReader, src: EffectSource): number => Math.min(1, shadowStacksOnSelf(sim, src))

export const DEFAULT_CHAMPION_ID = 'cursebearer'

export const champions: ReadonlyMap<string, Champion> = new Map([
  new Champion({
    id: DEFAULT_CHAMPION_ID,
    name: 'Cursebearer',
    description: 'A ranged hexer that stacks curses on its prey, then cashes them in.',
    passive: `Auto attacks apply a curse stack to the target, up to ${CURSE_MAX_STACKS}. Each stack lasts ${CURSE_DURATION_TICKS / GAME_TPS} seconds.`,
    maxHp: 800,
    moveSpeed: 140,
    radius: 20,
    attackDamage: 40,
    attackSpeed: 1.0,
    attackRange: 210,
    attackWindupTicks: 18,
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
    maxHp: 700,
    moveSpeed: 150,
    radius: 19,
    attackDamage: 65,
    attackSpeed: 1.3,
    attackRange: 240,
    attackWindupTicks: 14,
    attackProjectile: { speed: 900, radius: 5, color: '#6dd39b' },
    abilities: ['leap', 'focus', 'snare'],
    onAttackHit: [damage(attackDamage()), reduceCooldown('leap', GAME_TPS)],
  }),
  new Champion({
    id: 'swordsman',
    name: 'Swordsman',
    description: 'A melee duelist that builds sword stacks with every blow and spends them on bursts, roots and stuns.',
    passive: `Auto attacks give you a sword stack, up to ${SWORD_MAX_STACKS}, lasting ${SWORD_DURATION_TICKS / GAME_TPS} seconds. Each stack adds ${SWORD_DAMAGE_PER_STACK} damage to your autos and to Slash.`,
    maxHp: 1000,
    moveSpeed: 145,
    radius: 22,
    attackDamage: 80,
    attackSpeed: 1.1,
    attackRange: 90,
    attackWindupTicks: 13,
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
    maxHp: 850,
    moveSpeed: 145,
    radius: 21,
    attackDamage: 40,
    attackSpeed: 1.0,
    attackRange: 250,
    attackWindupTicks: 16,
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
    description: 'Shoots from range, but is deadliest up close. Trades health for speed and brings a medic.',
    passive: `Against a target within ${SOLDIER_MELEE_RANGE} of you, your attack becomes a melee strike that deals ${SOLDIER_MELEE_BONUS * 100}% more damage.`,
    maxHp: 900,
    moveSpeed: 150,
    radius: 21,
    attackDamage: 50,
    attackSpeed: 1.3,
    attackRange: 220,
    attackWindupTicks: 12,
    attackProjectile: { speed: 800, radius: 5, color: '#ffb347' },
    abilities: ['stim', 'bolt', 'medic'],
    onAttackHit: [
      when<SimContext>(
        subjectWithin(SOLDIER_MELEE_RANGE),
        [damage(linear(attackDamage(), SOLDIER_MELEE_BONUS, attackDamage()))],
        [damage(attackDamage())],
      ),
    ],
  }),
  new Champion({
    id: 'grenadier',
    name: 'Grenadier',
    description: 'A ranged bomber that bounces off its own grenades, burns the ground, and stuns or blinds with flashbangs.',
    passive: `After ${SIGHTED_AUTOS} auto attacks on the same enemy within ${SIGHTED_WINDOW_TICKS / GAME_TPS} seconds, gain ${SIGHTED_HASTE * 100}% move speed that fades away over ${SIGHTED_HASTE_TICKS / GAME_TPS} seconds.`,
    maxHp: 750,
    moveSpeed: 145,
    radius: 20,
    attackDamage: 55,
    attackSpeed: 1.1,
    attackRange: 230,
    attackWindupTicks: 16,
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
    maxHp: 900,
    moveSpeed: 155,
    radius: 21,
    attackDamage: 80,
    attackSpeed: 1.1,
    attackRange: 90,
    attackWindupTicks: 12,
    // Q is the stick, and becomes the recall while the stick is out.
    abilities: ['stick', 'hush', 'warp'],
  }),
  new Champion({
    id: 'ninja',
    name: 'Ninja',
    description: 'A melee skirmisher that dashes through enemies, leaves shadows to dash back to, and dodges autos.',
    passive: `Dashing through an enemy with Shadow Step gives you a shadow stack, up to ${SHADOW_MAX_STACKS} for ${SHADOW_STACK_TICKS / GAME_TPS} seconds. Each auto attack spends one for ${SHADOW_AUTO_BONUS_DAMAGE} bonus damage, and so does Kunai, which then roots.`,
    maxHp: 800,
    moveSpeed: 160,
    radius: 20,
    attackDamage: 70,
    attackSpeed: 1.2,
    attackRange: 85,
    attackWindupTicks: 10,
    // Q dashes, then dashes back to the shadow it left; W is the kunai; E dodges.
    abilities: ['shadowstep', 'kunai', 'dodge'],
    // The auto reads the stacks before it spends one.
    onAttackHit: [
      damage(linear(attackDamage(), SHADOW_AUTO_BONUS_DAMAGE, hasShadowStack)),
      popMarkers(SHADOW_KEY, self(), { count: 1 }),
    ],
  }),
].map((champion) => [champion.id, champion]))

export function getChampion(id: string): Champion {
  const champion = champions.get(id)
  if (!champion) throw new RangeError(`Unknown champion "${id}".`)
  return champion
}
