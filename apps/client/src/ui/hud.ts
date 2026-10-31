import { GAME_TPS, statReduction, type ChampionStats } from '../../../../packages/shared/src/index.ts'
import { layoutHealthBar } from '../render/health-bar.ts'

export type AbilitySlotView = {
  // The key to press, as printed on the slot.
  key: string
  abilityId: string
  // The ability's whole cooldown, with the champion's haste taken off: what its tooltip tells.
  cooldownTicks: number
  // How far the cooldown has run, 0 just cast to 1 ready. The icon fills up with colour from the bottom as it goes.
  filled: number
  ready: boolean
  // The time left, such as "3.4" or "12", and nothing when it is ready.
  secondsLeft: string
}

// One slot per ability on a key: what is on the key right now, how full its cooldown is, and how
// long is left. A cooldown that is somehow longer than the ability's own (a refund can never make it
// so, but a clock can be ahead) fills to nothing rather than below it.
export function abilitySlotViews(
  cooldowns: ReadonlyArray<{ slot: number; abilityId: string; ticksRemaining: number; cooldownTicks: number }>,
  keyLabel: (slot: number) => string,
): AbilitySlotView[] {
  return cooldowns.map(({ slot, abilityId, ticksRemaining, cooldownTicks }) => {
    const remaining = Math.max(0, ticksRemaining)
    const ready = remaining === 0
    const seconds = remaining / GAME_TPS
    return {
      key: keyLabel(slot),
      abilityId,
      cooldownTicks,
      filled: ready || cooldownTicks <= 0 ? 1 : Math.max(0, Math.min(1, 1 - remaining / cooldownTicks)),
      ready,
      // Under ten seconds a tenth is worth showing; above, whole seconds are plenty.
      secondsLeft: ready ? '' : seconds < 10 ? seconds.toFixed(1) : String(Math.ceil(seconds)),
    }
  })
}

export type HealthReadout = {
  // How much of the bar is health and how much is shield laid after it, as percentages of its width.
  // A shield that carries the total past the maximum shrinks the health to make room, as in the world.
  healthPercent: number
  shieldPercent: number
  // The exact numbers, such as "640 / 800" and, with a shield, "+120".
  health: string
  shield: string
}

export function healthReadout(health: { hp: number; maxHp: number; shield: number }): HealthReadout {
  const bar = layoutHealthBar(health, 100, { every: 0, major: 0 })
  return {
    healthPercent: bar.healthWidth,
    shieldPercent: bar.shieldWidth,
    health: `${Math.max(0, Math.round(health.hp))} / ${Math.round(health.maxHp)}`,
    shield: health.shield > 0 ? `+${Math.round(health.shield)}` : '',
  }
}

// The grid of item slots in the shop panel: four across and two down. A slot for each kind of item (`ITEM_SLOTS`) fills it from the top left, and what is
// left over is room for kinds still to come: a new slot is a new entry in `ITEM_SLOTS`, and takes the next cell. (There is a test that they fit.)
export const HUD_ITEM_COLUMNS = 4
export const HUD_ITEM_ROWS = 2

export type ProgressReadout = {
  // The level, such as "7".
  level: string
  // How much of the experience bar is full, as a percentage of its width. The bar has no numbers, only this: full at the highest
  // level, where there is no next.
  xpPercent: number
  gold: string
  // The shards, which are shown as a number even when there are none, since the shard shop button is always there.
  shards: string
}

export function progressReadout(progress: {
  level: number
  // How far it is through this level, from 0 to 1 (see `XpProgress`).
  fraction: number
  gold: number
  shards: number
}): ProgressReadout {
  const whole = (amount: number): string => String(Math.max(0, Math.floor(amount)))
  return {
    level: String(progress.level),
    xpPercent: Math.max(0, Math.min(1, progress.fraction)) * 100,
    gold: whole(progress.gold),
    shards: whole(progress.shards),
  }
}

// The numbers a champion is made of, which the stats panel lists: its stats at its level (see stats.ts). Items will change them, and it
// is what the items change that the panel is given.
export type PlayerStats = ChampionStats

export type StatRow = { label: string; value: string }

// The row of the stats that is the health, which a panel that shows the health on a bar of its own (the one over a champion that has been clicked on) leaves out.
export const MAX_HEALTH_LABEL = 'Max health'

// One row of the stats panel for each stat, in the order they are listed: whole numbers (the arcane is a whole amount of ability power), except for the
// attack speed, a rate, which is told to two places without a tail of zeros (1.2, not 1.20; 1, not 1.00). The resistance and the haste are told as the
// stat and, after it, what it takes off a hit or a cooldown (see `statReduction`).
export function statRows(stats: PlayerStats): StatRow[] {
  const finite = (amount: number): number => (Number.isFinite(amount) ? Math.max(0, amount) : 0)
  const whole = (amount: number): string => String(Math.round(finite(amount)))
  const rate = (amount: number): string => String(Number(finite(amount).toFixed(2)))
  const takesOff = (stat: number): string => `${whole(stat)} (${Math.round(statReduction(finite(stat)) * 100)}%)`
  return [
    { label: MAX_HEALTH_LABEL, value: whole(stats.maxHp) },
    { label: 'Attack damage', value: whole(stats.attackDamage) },
    { label: 'Attack speed', value: rate(stats.attackSpeed) },
    { label: 'Attack range', value: whole(stats.attackRange) },
    { label: 'Move speed', value: whole(stats.moveSpeed) },
    { label: 'Arcane', value: whole(stats.arcane) },
    { label: 'Resistance', value: takesOff(stats.resistance) },
    { label: 'Haste', value: takesOff(stats.haste) },
  ]
}

// What the health bar says while the champion is dead: how long until it is back, counted down in whole seconds
// (so it reads 1 until it is back, not 0).
export function respawnText(secondsLeft: number): string {
  return `Respawning in ${Math.max(1, Math.ceil(secondsLeft))}s`
}

// What it says while the champion is dead and will not come back: in Core Destruction, its team's core is broken.
export const OUT_TEXT = 'Out of the game: your core is down'
