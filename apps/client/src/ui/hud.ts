import { GAME_TPS } from '../../../../packages/shared/src/index.ts'
import { layoutHealthBar } from '../render/health-bar.ts'

export type AbilitySlotView = {
  // The key to press, as printed on the slot.
  key: string
  abilityId: string
  // How far the cooldown has run, 0 just cast to 1 ready. The slot fills up as it goes.
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

// What the health bar says while the champion is dead: how long until it is back, counted down in whole seconds
// (so it reads 1 until it is back, not 0).
export function respawnText(secondsLeft: number): string {
  return `Respawning in ${Math.max(1, Math.ceil(secondsLeft))}s`
}
