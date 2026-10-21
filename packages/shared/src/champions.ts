import {
  abilityDefs,
  CURSE_DURATION_TICKS,
  CURSE_KEY,
  CURSE_MAX_STACKS,
  EMPOWER_BONUS_DAMAGE,
  EMPOWER_DURATION_TICKS,
  EMPOWER_KEY,
  SWORD_DAMAGE_PER_STACK,
  SWORD_DURATION_TICKS,
  SWORD_KEY,
  SWORD_MAX_STACKS,
} from './abilities.js'
import { GAME_TPS } from './constants.js'
import {
  attackDamage,
  damage,
  linear,
  mark,
  popMarkers,
  reduceCooldown,
  self,
  stacks,
  subject,
  subjectWithin,
  when,
  type Effect,
  type SimContext,
} from './effects.js'

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
  // Ability IDs in slot order (Q, W, E, R).
  abilities: readonly string[]
  // Runs against the attack target when an auto-attack lands.
  onAttackHit?: readonly Effect[]
  // Runs for the caster whenever one of its abilities launches, after the ability's own effects.
  onCast?: readonly Effect[]
}

type StatusBonus = { kind: string; amount: number }

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
  readonly abilities: readonly string[]
  readonly onAttackHit: readonly Effect[]
  readonly onCast: readonly Effect[]

  constructor(def: ChampionDef) {
    for (const abilityId of def.abilities) {
      if (!abilityDefs.has(abilityId)) {
        throw new Error(`Champion "${def.id}" references unknown ability "${abilityId}".`)
      }
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
    this.abilities = [...def.abilities]
    this.onAttackHit = def.onAttackHit ?? [damage(attackDamage())]
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

  hasAbility(abilityId: string): boolean {
    return this.abilities.includes(abilityId)
  }

  abilityInSlot(slot: number): string | undefined {
    return this.abilities[slot]
  }
}

// Soldier's passive: a target this close (centre to centre) is hit with a melee strike that does more.
const SOLDIER_MELEE_RANGE = 60
const SOLDIER_MELEE_BONUS = 0.6

export const DEFAULT_CHAMPION_ID = 'cursebearer'

export const champions: ReadonlyMap<string, Champion> = new Map([
  new Champion({
    id: DEFAULT_CHAMPION_ID,
    name: 'Cursebearer',
    description: 'A ranged hexer that stacks curses on its prey, then cashes them in.',
    passive: `Auto attacks apply a curse stack to the target, up to ${CURSE_MAX_STACKS}. Each stack lasts ${CURSE_DURATION_TICKS / GAME_TPS} seconds.`,
    maxHp: 800,
    moveSpeed: 140,
    radius: 16,
    attackDamage: 80,
    attackSpeed: 1.2,
    attackRange: 250,
    attackWindupTicks: 4,
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
    radius: 15,
    attackDamage: 65,
    attackSpeed: 1.2,
    attackRange: 240,
    attackWindupTicks: 4,
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
    radius: 18,
    attackDamage: 90,
    attackSpeed: 1.1,
    attackRange: 90,
    attackWindupTicks: 3,
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
    radius: 17,
    attackDamage: 40,
    attackSpeed: 1.0,
    attackRange: 250,
    attackWindupTicks: 4,
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
    moveSpeed: 140,
    radius: 17,
    attackDamage: 50,
    attackSpeed: 1.3,
    attackRange: 220,
    attackWindupTicks: 2,
    abilities: ['stim', 'bolt', 'medic'],
    onAttackHit: [
      when<SimContext>(
        subjectWithin(SOLDIER_MELEE_RANGE),
        [damage(linear(attackDamage(), SOLDIER_MELEE_BONUS, attackDamage()))],
        [damage(attackDamage())],
      ),
    ],
  }),
].map((champion) => [champion.id, champion]))

export function getChampion(id: string): Champion {
  const champion = champions.get(id)
  if (!champion) throw new RangeError(`Unknown champion "${id}".`)
  return champion
}
