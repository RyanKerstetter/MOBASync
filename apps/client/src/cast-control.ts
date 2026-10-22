// How an ability key casts, as in League of Legends.
// - 'quick': the ability casts at the cursor the moment its key goes down.
// - 'quick-with-indicator': while the key is held the ability's indicator follows the cursor, and
//   it casts where the cursor is when the key is let go.
export type CastMode = 'quick' | 'quick-with-indicator'

export const DEFAULT_CAST_MODE: CastMode = 'quick-with-indicator'

export type CastAction =
  | { type: 'cast'; slot: number }
  | { type: 'aim'; slot: number }
  | { type: 'nothing' }

// Turns ability key presses and releases into casts under a cast mode. With the indicator, one
// ability is aimed at a time: pressing another key moves the aim to it, and only letting go of
// the key being aimed casts. An ability with nothing to aim (a self-cast) casts on the press in
// either mode, since there is no indicator to show.
export class CastControl {
  private aimedSlot: number | undefined
  private currentMode: CastMode

  constructor(mode: CastMode = DEFAULT_CAST_MODE) {
    this.currentMode = mode
  }

  get mode(): CastMode {
    return this.currentMode
  }

  // Changes how the keys cast, from the next press. Whatever was being aimed is dropped, since the
  // key's release would be read under the other mode.
  setMode(mode: CastMode): void {
    this.currentMode = mode
    this.aimedSlot = undefined
  }

  // The slot whose indicator is showing, if any.
  get aiming(): number | undefined {
    return this.aimedSlot
  }

  press(slot: number, needsAim: boolean): CastAction {
    if (this.currentMode === 'quick' || !needsAim) return { type: 'cast', slot }
    this.aimedSlot = slot
    return { type: 'aim', slot }
  }

  release(slot: number): CastAction {
    if (this.aimedSlot !== slot) return { type: 'nothing' }
    this.aimedSlot = undefined
    return { type: 'cast', slot }
  }

  // Drops the aim without casting, such as on Escape or when the window loses focus and the
  // key's release would never arrive.
  cancel(): void {
    this.aimedSlot = undefined
  }
}
