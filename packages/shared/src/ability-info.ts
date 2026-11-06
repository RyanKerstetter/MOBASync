import type { AbilityDef } from './abilities.js'
import { GAME_TPS } from './constants.js'
import { describeEffect, SCALING_KEYS, type AmountInfo, type AnyEffect, type Scaling } from './effects.js'

// What an ability puts a number on that a player wants to read, found by looking through its effects (see "Descriptions" in effects.ts): the damage it deals, the
// damage a second it burns (or bleeds) for, the health it gives back and the shield it gives. It is found in the ability itself, so it is the ability's own number, and retuning the
// ability retunes this. `perSecond` is a heal that a pulse repeats (a bot that heals every half second), told as what it comes to in a second. A `burnPerStack` is a burn that is
// this much a second for each stack its target carries.
export type AbilityNumber = { kind: 'damage' | 'burn' | 'burnPerStack' | 'bleed' | 'spore' | 'heal' | 'shield'; amount: AmountInfo; perSecond?: true }

// An amount as many times over as there are of it in a second.
function times(amount: AmountInfo, factor: number): AmountInfo {
  const ratios: AmountInfo['ratios'] = {}
  for (const key of SCALING_KEYS) {
    const ratio = amount.ratios[key]
    if (ratio) ratios[key] = ratio * factor
  }
  return {
    base: amount.base * factor,
    perStack: amount.perStack * factor,
    perMissingHealth: amount.perMissingHealth * factor,
    ratios,
    ...(amount.healthLost ? { healthLost: { share: amount.healthLost.share * factor, ticks: amount.healthLost.ticks } } : {}),
  }
}

const found = new WeakMap<AbilityDef, readonly AbilityNumber[]>()

// The numbers in an ability, in the order they are met: what it does itself, then what the things it sends out do when they hit, land or pulse. A branch that
// chooses between two (a full stack against not) gives both. The same number met twice is told once.
export function abilityNumbers(def: AbilityDef): readonly AbilityNumber[] {
  let numbers = found.get(def)
  if (!numbers) {
    numbers = collect(def)
    found.set(def, numbers)
  }
  return numbers
}

function collect(def: AbilityDef): AbilityNumber[] {
  const numbers: AbilityNumber[] = []
  const told = new Set<string>()
  const visited = new Set<object>()
  // `rate` is how many times a second what is walked is run, for what a pulse does, so the health it gives back is told for a second.
  const walk = (effects: readonly AnyEffect[] | undefined, rate?: number): void => {
    for (const effect of effects ?? []) {
      const info = describeEffect(effect)
      if (!info) continue
      switch (info.kind) {
        case 'damage':
        case 'burn':
        case 'burnPerStack':
        case 'bleed':
        case 'spore':
        case 'heal':
        case 'shield': {
          if (!info.amount) break
          // Only a heal is told for a second: a burn is already, a shield does not repeat, and the damage of a pulse is told as it is, for each.
          const repeats = rate !== undefined && info.kind === 'heal'
          const amount = repeats ? times(info.amount, rate) : info.amount
          const key = JSON.stringify([info.kind, amount, repeats])
          if (told.has(key)) break
          told.add(key)
          numbers.push({ kind: info.kind, amount, ...(repeats ? { perSecond: true as const } : {}) })
          break
        }
        case 'branch':
          walk(info.then, rate)
          walk(info.otherwise, rate)
          break
        case 'spawn':
          if (visited.has(info.def)) break
          visited.add(info.def)
          walk(info.def.onHit)
          walk(info.def.onTick)
          walk(info.def.onPulse, info.def.pulseEveryTicks ? GAME_TPS / info.def.pulseEveryTicks : undefined)
          walk(info.def.onExpire)
          walk(info.def.pickup)
          break
        case 'dash':
          if (visited.has(info.def)) break
          visited.add(info.def)
          walk(info.def.onHit)
          walk(info.def.onConnect)
          walk(info.def.onMiss)
          break
      }
    }
  }
  walk(def.apply)
  walk(def.empowerAttack?.effects)
  return numbers
}

// The stats of a caster that an amount can grow with, as plain numbers (see `Scaling`).
export type ScalingStats = Required<Scaling>

// What an amount comes to for a caster with these stats, before the target's resistance. A number that counts stacks or the health a target is missing is told
// as it is with none, since there is no target.
export function amountValue(amount: AmountInfo, stats: ScalingStats): number {
  return SCALING_KEYS.reduce((sum, key) => sum + (amount.ratios[key] ?? 0) * stats[key], amount.base)
}

// What the heals an ability gives (the ones it tells: see `abilityNumbers`) come to for a caster with these stats, cast now on itself: with the share of the health it is
// missing, and of the health it has lost lately (`healthLost`, which is given how many ticks back to look), that they add. It is what the page draws on the health bar of one whose
// ability says so (`AbilityDef.healthBarPreview`). A heal a pulse repeats is left out, as it is not given all at once; a branch that chooses between two heals tells the bigger.
export function healPreview(
  def: AbilityDef,
  stats: ScalingStats,
  caster: { missingHealth: number; healthLost: (withinTicks: number) => number },
): number {
  const heals = abilityNumbers(def)
    .filter((number) => number.kind === 'heal' && !number.perSecond)
    .map(({ amount }) => amountValue(amount, stats)
      + amount.perMissingHealth * caster.missingHealth
      + (amount.healthLost ? amount.healthLost.share * caster.healthLost(amount.healthLost.ticks) : 0))
  return Math.max(0, Math.round(Math.max(0, ...heals)))
}
