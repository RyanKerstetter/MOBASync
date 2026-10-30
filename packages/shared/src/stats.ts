// What a champion is made of, and how it grows. A champion has two blocks of the stats that grow (`StatBlock`): its `base`, which is what it
// is at level 1, and its `growth`, which is what each level after that adds. The stats a character has at a moment are
// `Champion.statsAt(level)`, and the level is from the experience in its frame (see progression.ts), which is why a stat can change the
// damage, the cooldowns and the health a frame works out.

export type ChampionStats = {
  maxHp: number
  attackDamage: number
  // Attacks a second.
  attackSpeed: number
  attackRange: number
  moveSpeed: number
  // Takes `statReduction(resistance)` off every hit it takes, whatever hits it (`statMultiplier` is what is left): 0 takes all of it.
  resistance: number
  // Takes `statReduction(haste)` off the cooldown of every ability it casts (`hastedCooldownTicks`): 0 takes none off.
  haste: number
  // What its magic damage (the damage of its abilities, and not of its auto attacks) is multiplied by: 1 for as it is written.
  arcane: number
}

// The six stats that a champion has a base of and grows in, as plain numbers.
export type StatValues = {
  maxHp: number
  attackDamage: number
  // Attacks a second.
  attackSpeed: number
  // Takes `statReduction(resistance)` off every hit it takes (see `ChampionStats`).
  resistance: number
  // Takes `statReduction(haste)` off the cooldown of every ability it casts.
  haste: number
  // Its ability power: an amount, 0 for none, that does nothing until an ability says it scales with it (see `arcane` and `scaled` in
  // effects.ts), each by its own ratio. (In a growth it is how much each level adds.)
  arcane: number
}

// What a champion's `base` can say: the health, the attack damage and the attack speed it has to, and the rest, which it can leave out for
// no resistance, no haste and no arcane.
export type BaseStatsDef = Pick<StatValues, 'maxHp' | 'attackDamage' | 'attackSpeed'> & Partial<Pick<StatValues, 'resistance' | 'haste' | 'arcane'>>

// What a stat that is left out of a `base` is.
export const BASE_STAT_DEFAULTS: Readonly<Pick<StatValues, 'resistance' | 'haste' | 'arcane'>> = { resistance: 0, haste: 0, arcane: 0 }

// What a growth that is left out adds: nothing.
export const NO_GROWTH: Readonly<StatValues> = {
  maxHp: 0,
  attackDamage: 0,
  attackSpeed: 0,
  resistance: 0,
  haste: 0,
  arcane: 0,
}

const STAT_KEYS = ['maxHp', 'attackDamage', 'attackSpeed', 'resistance', 'haste', 'arcane'] as const

// The six stats together: what a champion holds twice, as its base and as its growth. Each has to be a number, 0 or more.
export class StatBlock implements StatValues {
  readonly maxHp: number
  readonly attackDamage: number
  readonly attackSpeed: number
  readonly resistance: number
  readonly haste: number
  readonly arcane: number

  constructor(values: StatValues) {
    for (const key of STAT_KEYS) {
      const value = values[key]
      if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
        throw new Error(`needs ${/^[aeiou]/.test(key) ? 'an' : 'a'} ${key} that is a number, 0 or more`)
      }
    }
    this.maxHp = values.maxHp
    this.attackDamage = values.attackDamage
    this.attackSpeed = values.attackSpeed
    this.resistance = values.resistance
    this.haste = values.haste
    this.arcane = values.arcane
  }

  // This block with `levels` of a growth block added to it, each stat as it comes out.
  grownBy(growth: StatValues, levels: number): StatValues {
    return {
      maxHp: this.maxHp + growth.maxHp * levels,
      attackDamage: this.attackDamage + growth.attackDamage * levels,
      attackSpeed: this.attackSpeed + growth.attackSpeed * levels,
      resistance: this.resistance + growth.resistance * levels,
      haste: this.haste + growth.haste * levels,
      arcane: this.arcane + growth.arcane * levels,
    }
  }
}

// The stats a 'stat' status can add to (see `statBuff` in effects.ts).
export type BuffableStat = 'attackDamage' | 'attackSpeed' | 'resistance' | 'haste' | 'arcane'

// These stats with what the 'stat' statuses on a unit add to them.
export function withStatBuffs(
  stats: ChampionStats,
  statuses: readonly { kind: string; stat?: BuffableStat; amount: number }[] | undefined,
): ChampionStats {
  if (!statuses) return stats
  const buffed = { ...stats }
  for (const status of statuses) {
    if (status.kind === 'stat' && status.stat) buffed[status.stat] += status.amount
  }
  return buffed
}

// A stat of `stat` takes this share off, by League's formula: x / (100 + x). 100 takes half, and no amount takes all.
export function statReduction(stat: number): number {
  return stat > 0 ? stat / (100 + stat) : 0
}

// What is left once it has taken its share off, as a multiplier: 100 / (100 + x), and exactly 1 for none.
export function statMultiplier(stat: number): number {
  return stat > 0 ? 100 / (100 + stat) : 1
}

// A cooldown of this many ticks for a character with this much haste, in whole ticks. A cooldown of none is none, and one that is
// anything is at least a tick, however much haste there is. Only multiplications, one division and a rounding, so every peer gets
// the same answer.
export function hastedCooldownTicks(ticks: number, haste: number): number {
  if (!(ticks > 0)) return Math.max(0, ticks)
  if (!(haste > 0)) return ticks
  return Math.max(1, Math.round(ticks * 100 / (100 + haste)))
}
