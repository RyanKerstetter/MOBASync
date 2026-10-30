// The effects the page draws over the ground that a player can turn off one at a time (the graphics menu, see game-menu.ts). They are about how
// the page looks and nothing else: no rule of the game changes, and every one is on until a player turns it off.
export type EffectSettings = {
  // The ring round each turret and core that shows how far it shoots.
  turretRanges: boolean
  // The ring round the champion you control that shows how far its attacks reach.
  selfAttackRange: boolean
  // The tint over each shop, which is where champions heal.
  shopGlow: boolean
}

export type EffectKey = keyof EffectSettings

// Every effect there is, in the order the menu lists them.
export const EFFECT_KEYS: readonly EffectKey[] = ['turretRanges', 'selfAttackRange', 'shopGlow']

export const DEFAULT_EFFECTS: Readonly<EffectSettings> = { turretRanges: true, selfAttackRange: true, shopGlow: true }

// What was stored for the effects, as settings: each is the stored value when that is true or false, and is the default when it is missing or is
// anything else, so a stored value that is damaged, or from before an effect was added, loses only that one.
export function readEffects(stored: unknown): EffectSettings {
  const given = typeof stored === 'object' && stored !== null ? stored as Record<string, unknown> : {}
  const effects: EffectSettings = { ...DEFAULT_EFFECTS }
  for (const key of EFFECT_KEYS) {
    const value = given[key]
    if (typeof value === 'boolean') effects[key] = value
  }
  return effects
}
