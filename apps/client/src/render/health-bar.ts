export type HealthBarLayout = {
  // How much of the bar's width is current health, and the shield laid after it.
  healthWidth: number
  shieldWidth: number
  // Tick marks across the bar, measured from its left edge. A major one marks a round number.
  ticks: Array<{ x: number; major: boolean }>
}

// Lays out a bar `width` wide in the style of League of Legends: current health from the left, the
// shield on the end of it, and a tick for every `every` points of health, a major one every
// `major`. The bar spans the maximum health, or the health plus shield when that is more, so a big
// shield shrinks the rest of the bar to make room instead of running off the end.
export function layoutHealthBar(
  health: { hp: number; maxHp: number; shield: number },
  width: number,
  ticks: { every: number; major: number },
): HealthBarLayout {
  const hp = Math.max(0, health.hp)
  const shield = Math.max(0, health.shield)
  const span = Math.max(1, health.maxHp, hp + shield)
  const marks: HealthBarLayout['ticks'] = []
  if (ticks.every > 0) {
    // A tick on the very end of the bar would only double up with its edge.
    for (let count = 1; count * ticks.every < span; count += 1) {
      const value = count * ticks.every
      marks.push({ x: width * value / span, major: ticks.major > 0 && value % ticks.major === 0 })
    }
  }
  return {
    healthWidth: width * hp / span,
    shieldWidth: width * shield / span,
    ticks: marks,
  }
}
