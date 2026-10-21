import { abilityDefs } from './abilities.js'
import { GAME_TPS } from './constants.js'
import { damage, type Effect } from './effects.js'

export interface ChampionDef {
  id: string
  name: string
  maxHp: number
  baseShield: number
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
}

export class Champion {
  readonly id: string
  readonly name: string
  readonly maxHp: number
  readonly baseShield: number
  readonly moveSpeed: number
  readonly radius: number
  readonly attackDamage: number
  readonly attackSpeed: number
  readonly attackRange: number
  readonly attackWindupTicks: number
  readonly abilities: readonly string[]
  readonly onAttackHit: readonly Effect[]

  constructor(def: ChampionDef) {
    for (const abilityId of def.abilities) {
      if (!abilityDefs.has(abilityId)) {
        throw new Error(`Champion "${def.id}" references unknown ability "${abilityId}".`)
      }
    }
    this.id = def.id
    this.name = def.name
    this.maxHp = def.maxHp
    this.baseShield = def.baseShield
    this.moveSpeed = def.moveSpeed
    this.radius = def.radius
    this.attackDamage = def.attackDamage
    this.attackSpeed = def.attackSpeed
    this.attackRange = def.attackRange
    this.attackWindupTicks = def.attackWindupTicks
    this.abilities = [...def.abilities]
    this.onAttackHit = def.onAttackHit ?? [damage(def.attackDamage)]
  }

  get attackCooldownTicks(): number {
    return Math.max(1, Math.ceil(GAME_TPS / this.attackSpeed))
  }

  hasAbility(abilityId: string): boolean {
    return this.abilities.includes(abilityId)
  }

  abilityInSlot(slot: number): string | undefined {
    return this.abilities[slot]
  }
}

export const DEFAULT_CHAMPION_ID = 'vanguard'

export const champions: ReadonlyMap<string, Champion> = new Map([
  new Champion({
    id: DEFAULT_CHAMPION_ID,
    name: 'Vanguard',
    maxHp: 10,
    baseShield: 1,
    moveSpeed: 220,
    radius: 18,
    attackDamage: 1,
    attackSpeed: 1,
    attackRange: 150,
    attackWindupTicks: 0,
    abilities: ['shockwave', 'lash', 'bolt', 'meteor'],
  }),
].map((champion) => [champion.id, champion]))

export function getChampion(id: string): Champion {
  const champion = champions.get(id)
  if (!champion) throw new RangeError(`Unknown champion "${id}".`)
  return champion
}
