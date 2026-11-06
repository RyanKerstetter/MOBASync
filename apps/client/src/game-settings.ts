import { DEFAULT_CAST_MODE, type CastMode } from './cast-control.ts'
import { DEFAULT_EFFECTS, readEffects, type EffectSettings } from './render/effect-settings.ts'

// What a player chooses for themselves, kept in the browser so it is there next time. Every setting
// has a default and is checked on the way in, so a missing or odd stored value is just the default.
export type GameSettings = {
  castMode: CastMode
  // Which of the effects drawn over the ground are on (the graphics menu).
  effects: EffectSettings
  // How far past the edge of an enemy a click still picks it, in world pixels, for attacks and for abilities aimed at a unit (the controls menu).
  clickRadius: number
  // Whether an order to walk lets an auto attack that is winding up land first, and walks after it, instead of cancelling it (the controls menu).
  walkKeepsAuto: boolean
  // The same for an ability that is winding up. (Back is always ended by a walk.)
  walkKeepsCast: boolean
  // Whether W, A, S and D steer the champion, with its abilities on Q, E and R instead of Q, W and E (the controls menu; see movement-keys.ts).
  movementKeys: boolean
  // Whether casting an ability with a windup while attacking an enemy goes back to attacking it once the cast is done, instead of ending the attack (the controls menu).
  castKeepsAttack: boolean
  // How big the marker on the enemy being attacked is drawn, in percent of its own size (the graphics menu; see attack-marker.ts).
  attackMarkerSize: number
  // Whether the frame rate and network diagnostics are shown at the top left (the dev menu).
  diagnostics: boolean
  // The most frames a second the page draws (the graphics menu): one of `FRAME_RATE_OPTIONS`, and `UNCAPPED_FPS` for no limit. It is only how often the world is drawn: the game itself
  // runs at `GAME_TPS` ticks a second whatever this is.
  maxFps: number
}

// No limit on the frame rate: the page draws a frame each time the browser asks for one, which is as often as the display refreshes (a browser cannot draw faster than that).
export const UNCAPPED_FPS = 0
// The frame rates the graphics menu offers to hold the page to, highest first after "uncapped". A number is a ceiling, not a target: a display that refreshes slower than it
// cannot reach it, and one whose refresh is not a whole multiple of it draws a little unevenly to average out at it.
export const FRAME_RATE_OPTIONS: readonly number[] = [UNCAPPED_FPS, 240, 180, 165, 144, 120, 90, 75, 60, 45, 30]
export const DEFAULT_MAX_FPS = UNCAPPED_FPS

// What was stored for the frame rate, held to what the menu offers: one of the options is kept, and anything else (missing, text, a number the menu does not have) is the default.
export function readMaxFps(stored: unknown): number {
  return FRAME_RATE_OPTIONS.find((option) => option === stored) ?? DEFAULT_MAX_FPS
}

// The extra click radius is whole pixels from none to this many; the menu's slider moves in steps of CLICK_RADIUS_STEP.
export const MAX_CLICK_RADIUS = 40
export const CLICK_RADIUS_STEP = 2
export const DEFAULT_CLICK_RADIUS = 10

// The attack marker is drawn from its own size up to this many percent of it; the menu's slider moves in steps of ATTACK_MARKER_SIZE_STEP.
export const MIN_ATTACK_MARKER_SIZE = 100
export const MAX_ATTACK_MARKER_SIZE = 300
export const ATTACK_MARKER_SIZE_STEP = 25
export const DEFAULT_ATTACK_MARKER_SIZE = MIN_ATTACK_MARKER_SIZE

export const DEFAULT_SETTINGS: GameSettings = {
  castMode: DEFAULT_CAST_MODE,
  effects: { ...DEFAULT_EFFECTS },
  clickRadius: DEFAULT_CLICK_RADIUS,
  walkKeepsAuto: false,
  walkKeepsCast: true,
  movementKeys: false,
  castKeepsAttack: true,
  attackMarkerSize: DEFAULT_ATTACK_MARKER_SIZE,
  diagnostics: true,
  maxFps: DEFAULT_MAX_FPS,
}

// What was stored for the click radius, held to the range the menu offers: a number is rounded and kept between none and the most, and
// anything else (missing, text, not a number) is the default.
export function readClickRadius(stored: unknown): number {
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return DEFAULT_CLICK_RADIUS
  return Math.min(MAX_CLICK_RADIUS, Math.max(0, Math.round(stored)))
}

// The same for the attack marker's size: a number is rounded and kept between the least and the most, and anything else is the default.
export function readAttackMarkerSize(stored: unknown): number {
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return DEFAULT_ATTACK_MARKER_SIZE
  return Math.min(MAX_ATTACK_MARKER_SIZE, Math.max(MIN_ATTACK_MARKER_SIZE, Math.round(stored)))
}

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
      clickRadius: readClickRadius(fields.clickRadius),
      walkKeepsAuto: typeof fields.walkKeepsAuto === 'boolean' ? fields.walkKeepsAuto : DEFAULT_SETTINGS.walkKeepsAuto,
      walkKeepsCast: typeof fields.walkKeepsCast === 'boolean' ? fields.walkKeepsCast : DEFAULT_SETTINGS.walkKeepsCast,
      movementKeys: typeof fields.movementKeys === 'boolean' ? fields.movementKeys : DEFAULT_SETTINGS.movementKeys,
      castKeepsAttack: typeof fields.castKeepsAttack === 'boolean' ? fields.castKeepsAttack : DEFAULT_SETTINGS.castKeepsAttack,
      attackMarkerSize: readAttackMarkerSize(fields.attackMarkerSize),
      diagnostics: typeof fields.diagnostics === 'boolean' ? fields.diagnostics : DEFAULT_SETTINGS.diagnostics,
      maxFps: readMaxFps(fields.maxFps),
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
