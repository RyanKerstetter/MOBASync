import {
  abilityName,
  abilityNumbers,
  amountValue,
  GAME_TPS,
  getAbilityDef,
  type AmountInfo,
  type ChampionStats,
  type ScalingStats,
} from '../../../../packages/shared/src/index.ts'
import type { ItemTooltip, StatLine } from './shop.ts'

// What the box over an ability on the HUD says, as plain data for the same box the items use (see `ItemTooltip`): its name and its key, a line on what it does,
// the damage it does for the champion as it is now with what that is made of, and its cooldown with the haste taken off. The numbers are read from the
// ability itself (see `abilityNumbers`), so they are always the ability's own.

// What the champion is now. `cooldownTicks` is the ability's whole cooldown with the champion's haste taken off, which the cooldown that is running was started at.
export type AbilityTooltipInput = {
  // The key it is on, as printed on the slot.
  key: string
  cooldownTicks: number
  stats: ChampionStats
  level: number
  health: number
}

const RATIO_NAMES: Readonly<Record<'arcane' | 'attackDamage' | 'maxHealth' | 'health', string>> = {
  arcane: 'Arcane',
  attackDamage: 'Attack damage',
  maxHealth: 'Max health',
  health: 'Health',
}

const KIND_LABELS = { damage: 'Damage', burn: 'Burn' } as const

// 0.8 is "80%" and 0.06 is "6%".
const percent = (ratio: number): string => `${Number((ratio * 100).toFixed(1))}%`
const amountText = (value: number): string => String(Number(value.toFixed(2)))
const secondsText = (ticks: number): string => `${Number((ticks / GAME_TPS).toFixed(1))}s`

// What an amount is made of, such as "60 + 30 per stack + 50% Attack damage", or nothing for one that is only a number (it is the value already).
export function amountFormula(amount: AmountInfo): string | undefined {
  const { base, perStack, perMissingHealth, ratios } = amount
  // What it grows with, after the base.
  const grows: string[] = []
  if (perStack !== 0) grows.push(`${amountText(perStack)} per stack`)
  if (perMissingHealth !== 0) grows.push(`${percent(perMissingHealth)} of missing health`)
  for (const key of ['arcane', 'attackDamage', 'maxHealth', 'health'] as const) {
    const ratio = ratios[key]
    if (ratio) grows.push(`${percent(ratio)} ${RATIO_NAMES[key]}`)
  }
  if (ratios.level) grows.push(`${amountText(ratios.level)} per level`)
  if (grows.length === 0) return undefined
  return [...(base !== 0 ? [amountText(base)] : []), ...grows].join(' + ')
}

// The tooltip for an ability, or none for one there is no definition of.
export function abilityTooltip(abilityId: string, input: AbilityTooltipInput): ItemTooltip | undefined {
  const def = getAbilityDef(abilityId)
  if (!def) return undefined
  const { stats } = input
  const caster: ScalingStats = {
    arcane: stats.arcane,
    attackDamage: stats.attackDamage,
    maxHealth: stats.maxHp,
    health: input.health,
    level: input.level,
  }
  const lines: StatLine[] = abilityNumbers(def).map(({ kind, amount }) => {
    const value = String(Math.round(amountValue(amount, caster)))
    const detail = amountFormula(amount)
    return {
      label: KIND_LABELS[kind],
      value: kind === 'burn' ? `${value}/s` : value,
      ...(detail === undefined ? {} : { detail }),
    }
  })
  if (input.cooldownTicks > 0) {
    lines.push({
      label: 'Cooldown',
      value: secondsText(input.cooldownTicks),
      // With haste, the cooldown it would be without.
      ...(input.cooldownTicks !== def.cooldownTicks ? { detail: `${secondsText(def.cooldownTicks)} without haste` } : {}),
    })
  }
  return {
    name: abilityName(def),
    slot: input.key,
    ...(def.description ? { about: def.description } : {}),
    stats: lines,
  }
}
