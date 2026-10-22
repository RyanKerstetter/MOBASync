import { DEFAULT_CAST_MODE, type CastMode } from './cast-control.ts'

// What a player chooses for themselves, kept in the browser so it is there next time. Every setting
// has a default and is checked on the way in, so a missing or odd stored value is just the default.
export type GameSettings = {
  castMode: CastMode
}

export const DEFAULT_SETTINGS: GameSettings = { castMode: DEFAULT_CAST_MODE }

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

export function loadSettings(storage: SettingsStorage | undefined = defaultStorage()): GameSettings {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')
    const castMode = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>).castMode : undefined
    return {
      castMode: CAST_MODES.find((mode) => mode === castMode) ?? DEFAULT_SETTINGS.castMode,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: GameSettings, storage: SettingsStorage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Not being able to remember a setting is no reason to stop the game.
  }
}
