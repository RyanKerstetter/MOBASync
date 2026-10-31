// Where the thin bars under a champion's health bar go, as the y of the top edge of each from the middle of its body (up is negative), and how thick they are.
// `above` is how far up the top of the figure reaches (its body's radius, or its sprite's top if that is higher): the health bar sits over it.
export const METER_BAR_HEIGHT = 4
export const ATTACK_BAR_HEIGHT = 3
// The space left between two bars that are drawn one under the other.
export const BAR_GAP = 1

// A champion's meter (a rage that runs down), or a monster's deaggro bar: just under the health bar. No champion has both.
export function meterBarTop(above: number): number {
  return -above - 9
}

// The controlled champion's attack bar. It is where it always was, just above the edge of its body, unless a meter is up: a figure no taller than its body has the
// meter in that same place, so the attack bar goes just below the meter then. (A taller figure has the attack bar lower already, and it stays there.)
export function attackBarTop(radius: number, above: number, meterShown: boolean): number {
  const usual = -radius - 8
  return meterShown ? Math.max(usual, meterBarTop(above) + METER_BAR_HEIGHT + BAR_GAP) : usual
}
