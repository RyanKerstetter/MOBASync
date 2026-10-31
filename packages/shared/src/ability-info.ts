import type { AbilityDef } from './abilities.js'
import { describeEffect, SCALING_KEYS, type AmountInfo, type AnyEffect, type Scaling } from './effects.js'

// What an ability puts a number on that a player wants to read, found by looking through its effects (see "Descriptions" in effects.ts): the damage it deals, and
// the damage a second it burns for. It is found in the ability itself, so it is the ability's own number, and retuning the ability retunes this.
export type AbilityNumber = { kind: 'damage' | 'burn'; amount: AmountInfo }

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
  const walk = (effects: readonly AnyEffect[] | undefined): void => {
    for (const effect of effects ?? []) {
      const info = describeEffect(effect)
      if (!info) continue
      switch (info.kind) {
        case 'damage':
        case 'burn': {
          if (!info.amount) break
          const key = JSON.stringify([info.kind, info.amount])
          if (told.has(key)) break
          told.add(key)
          numbers.push({ kind: info.kind, amount: info.amount })
          break
        }
        case 'branch':
          walk(info.then)
          walk(info.otherwise)
          break
        case 'spawn':
          if (visited.has(info.def)) break
          visited.add(info.def)
          walk(info.def.onHit)
          walk(info.def.onTick)
          walk(info.def.onPulse)
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
