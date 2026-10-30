import { DEFAULT_CAST_MODE, type CastMode } from './cast-control.ts'
import { DEFAULT_EFFECTS, readEffects, type EffectSettings } from './render/effect-settings.ts'

// What a player chooses for themselves, kept in the browser so it is there next time. Every setting
// has a default and is checked on the way in, so a missing or odd stored value is just the default.
export type GameSettings = {
  castMode: CastMode
  // Which of the effects drawn over the ground are on (the graphics menu).
  effects: EffectSettings
  // Whether the frame rate and network diagnostics are shown at the top left (the dev menu).
  diagnostics: boolean
}

export const DEFAULT_SETTINGS: GameSettings = { castMode: DEFAULT_CAST_MODE, effects: { ...DEFAULT_EFFECTS }, diagnostics: true }

const STORAGE_KEY = 'moba-settings'
const CAST_MODES: readonly CastMode[] = ['quick', 'quick-with-indicator']

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): SettingsStorage | undefined {
  try {
    return window.localStorage
  } catch {
    // Storage can be blocked, such as in a private window.
    return undefined
  }
}

// The settings that were stored, with the default for each one that is missing or odd. What comes back is a copy: changing it never changes the defaults.
export function loadSettings(storage: SettingsStorage | undefined = defaultStorage()): GameSettings {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')
    const fields = typeof stored === 'object' && stored !== null ? stored as Record<string, unknown> : {}
    return {
      castMode: CAST_MODES.find((mode) => mode === fields.castMode) ?? DEFAULT_SETTINGS.castMode,
      effects: readEffects(fields.effects),
      diagnostics: typeof fields.diagnostics === 'boolean' ? fields.diagnostics : DEFAULT_SETTINGS.diagnostics,
    }
  } catch {
    return { ...DEFAULT_SETTINGS, effects: { ...DEFAULT_SETTINGS.effects } }
  }
}

export function saveSettings(settings: GameSettings, storage: SettingsStorage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Not being able to remember a setting is no reason to stop the game.
  }
}
