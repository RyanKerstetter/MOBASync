import { GAME_TPS } from './constants.js'

// What an item does besides adding its stats (see `ItemDef.effects`). An effect is plain data: its numbers are read where it is used (the simulator, for the
// damage and the healing; `withItems`, for the attack speed) and where it is described (`describeItemEffects`, which is what a tooltip says), so retuning
// one is changing it here and nowhere else. The fractions are shares as they are written: 0.1 is 10%.
export type ItemEffect =
  // Its abilities do this much more damage.
  | { kind: 'abilityDamage'; bonus: number }
  // Its auto attacks do this much more damage.
  | { kind: 'attackDamage'; bonus: number }
  // It has this much more attack speed: its attack speed with what its items add to it, times 1 plus this.
  | { kind: 'attackSpeed'; bonus: number }
  // It heals for this share of the damage its auto attacks (`attacks`) or its abilities do, after the target's resistance.
  | { kind: 'lifesteal'; on: 'attacks' | 'abilities'; fraction: number }
  // Each auto attack that lands gives it this much move speed for this long. Another one that lands renews it.
  | { kind: 'attackMoveSpeed'; fraction: number; ticks: number }
  // Its auto attacks do not meet this share of the target's resistance.
  | { kind: 'resistancePierce'; fraction: number }
  // Its auto attacks do extra damage: this many times its arcane.
  | { kind: 'attackArcane'; ratio: number }
  // Its auto attacks do extra damage: this share of the target's health when they land.
  | { kind: 'currentHealthDamage'; fraction: number }
  // Its auto attacks poison the target, who takes `damagePerSecond` plus `arcane` times the carrier's arcane every second, for this long. Another one that
  // lands renews it.
  | { kind: 'poison'; damagePerSecond: number; arcane: number; ticks: number }
  // Once in `cooldownTicks`, its next auto attack does extra damage: `attackDamage` times its own attack damage, and heals it for `healMissingHealth` of the
  // health it is missing.
  | { kind: 'openingAttack'; attackDamage: number; healMissingHealth?: number; cooldownTicks: number }
  // Once in `cooldownTicks`, the next damage its abilities do is more: `arcane` times its arcane more.
  | { kind: 'chargedAbility'; arcane: number; cooldownTicks: number }

export type ItemEffectKind = ItemEffect['kind']

// An effect an inventory has, and the item it comes from, which the effects that have a cooldown keep it by.
export type CarriedEffect<E extends ItemEffect = ItemEffect> = { itemId: string; effect: E }

// The effects of this kind among these.
export function effectsOfKind<K extends ItemEffectKind>(
  carried: readonly CarriedEffect[],
  kind: K,
): Array<CarriedEffect<Extract<ItemEffect, { kind: K }>>> {
  return carried.filter((each): each is CarriedEffect<Extract<ItemEffect, { kind: K }>> => each.effect.kind === kind)
}

// What each kind needs to be, number by number: a plain amount is a number that is 0 or more (a share can be over 1), a count of ticks is a whole number of them, 1 or more.
const AMOUNTS: Readonly<{ [K in ItemEffectKind]: ReadonlyArray<Exclude<keyof Extract<ItemEffect, { kind: K }>, 'kind'>> }> = {
  abilityDamage: ['bonus'],
  attackDamage: ['bonus'],
  attackSpeed: ['bonus'],
  lifesteal: ['fraction'],
  attackMoveSpeed: ['fraction', 'ticks'],
  resistancePierce: ['fraction'],
  attackArcane: ['ratio'],
  currentHealthDamage: ['fraction'],
  poison: ['damagePerSecond', 'arcane', 'ticks'],
  openingAttack: ['attackDamage', 'cooldownTicks'],
  chargedAbility: ['arcane', 'cooldownTicks'],
}

const TICK_FIELDS: readonly string[] = ['ticks', 'cooldownTicks']

// Why an effect cannot be used, in words, or nothing if it can.
export function itemEffectProblem(effect: ItemEffect): string | undefined {
  const fields = AMOUNTS[effect.kind as ItemEffectKind] as readonly string[] | undefined
  if (!fields) return `has an effect called ${String((effect as { kind?: unknown }).kind)}, which is not one there is`
  const values = effect as unknown as Record<string, unknown>
  for (const field of fields) {
    const amount = values[field]
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return `has an effect (${effect.kind}) that needs a ${field} that is a number, 0 or more`
    if (TICK_FIELDS.includes(field) && !(Number.isInteger(amount) && amount >= 1)) return `has an effect (${effect.kind}) that needs a ${field} that is a whole number of ticks, 1 or more`
  }
  if (effect.kind === 'lifesteal' && effect.on !== 'attacks' && effect.on !== 'abilities') return 'has an effect (lifesteal) that needs to be on attacks or on abilities'
  if (effect.kind === 'openingAttack' && effect.healMissingHealth !== undefined
    && !(Number.isFinite(effect.healMissingHealth) && effect.healMissingHealth >= 0)) {
    return 'has an effect (openingAttack) that needs a healMissingHealth that is a number, 0 or more'
  }
  return undefined
}

// ---------------------------------------------------------------------------- the words

// 0.1 is "10%", and 0.025 is "2.5%".
const percent = (share: number): string => `${Number((share * 100).toFixed(1))}%`
const secondsText = (ticks: number): string => {
  const seconds = Number((ticks / GAME_TPS).toFixed(1))
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
}
const amountText = (amount: number): string => String(Number(amount.toFixed(2)))

// What one effect does and what it scales with, as a sentence, with its numbers as they are written in the effect.
export function describeItemEffect(effect: ItemEffect): string {
  switch (effect.kind) {
    case 'abilityDamage':
      return `Abilities do ${percent(effect.bonus)} bonus damage.`
    case 'attackDamage':
      return `Attacks do ${percent(effect.bonus)} bonus damage.`
    case 'attackSpeed':
      return `Gain ${percent(effect.bonus)} bonus attack speed.`
    case 'lifesteal':
      return `Gain ${percent(effect.fraction)} lifesteal on ${effect.on}.`
    case 'attackMoveSpeed':
      return `Attacks give ${percent(effect.fraction)} move speed for ${secondsText(effect.ticks)}.`
    case 'resistancePierce':
      return `Attacks ignore ${percent(effect.fraction)} of the target's resistance.`
    case 'attackArcane':
      return `Attacks do bonus damage equal to ${percent(effect.ratio)} of your Arcane.`
    case 'currentHealthDamage':
      return `Attacks do bonus damage equal to ${percent(effect.fraction)} of the target's current health.`
    case 'poison': {
      const scales = effect.arcane > 0 ? ` + ${percent(effect.arcane)} of your Arcane` : ''
      return `Attacks poison the target for ${amountText(effect.damagePerSecond)}${scales} damage per second for ${secondsText(effect.ticks)}.`
    }
    case 'openingAttack': {
      const heals = effect.healMissingHealth ? ` and heals you for ${percent(effect.healMissingHealth)} of your missing health` : ''
      return `Every ${secondsText(effect.cooldownTicks)}, your next attack does bonus damage equal to ${percent(effect.attackDamage)} of your Attack damage${heals}.`
    }
    case 'chargedAbility':
      return `Every ${secondsText(effect.cooldownTicks)}, your next ability that does damage does bonus damage equal to ${percent(effect.arcane)} of your Arcane.`
  }
}

// What a list of effects says, a sentence for each, or nothing for an item that only adds its stats.
export function describeItemEffects(effects: readonly ItemEffect[]): string {
  return effects.map(describeItemEffect).join(' ')
}
