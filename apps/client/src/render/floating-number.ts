import type { RenderedCharacter } from '../game-state.ts'

// The numbers that rise over a champion: an orange `-N` for each hit it takes and a green `+N` for health it gets back (the shop's healing area,
// an ability that heals). What is a hit and what is a heal is told from how a champion's health looked the last time the page looked, not from
// anything the game says, so it is the same on every peer, and it shows what the champion's own health did.

export const FLOATING_DAMAGE_COLOR = '#ffd27a'
export const FLOATING_HEAL_COLOR = '#6ef2a0'

// How long a number stays up, fading as it goes, and how fast it rises, in world units a millisecond.
export const FLOATING_NUMBER_MS = 900
export const FLOATING_NUMBER_RISE = 1 / 45

// What a champion's health looked like: its health with its shield (what a hit takes from), its health alone and its most, and the count of
// hits it has taken (`hpSeq`, which only damage, and a death or a respawn, add to; a heal does not).
export type HealthLook = { total: number; hp: number; maxHp: number; hpSeq: number }

export type NumberChange = { kind: 'damage' | 'heal'; amount: number }

export function healthLook(character: Pick<RenderedCharacter, 'health' | 'totalShield'>): HealthLook {
  const hp = character.health?.hp ?? 0
  return { total: hp + character.totalShield, hp, maxHp: character.health?.maxHp ?? 0, hpSeq: character.health?.hpSeq ?? 0 }
}

// What happened to a champion between two looks, if there is a number for it:
// - a hit: its `hpSeq` went up and its health and shield together went down, by that much. A shield running out is not a hit (the health did not
//   go down), and a respawn, which adds to `hpSeq`, brings health up and not down.
// - a heal: its health went up with its `hpSeq` and its most health as they were, by that much (what it got back, not what was healed, so a heal
//   that fills it up is only what it was missing). A level or an item that raises its most health raises its health with it, and is not a heal; nor
//   is a champion that was dead and is back, which is a respawn. Whoever is first seen has no number: there is nothing to tell it from.
export function floatingChange(previous: HealthLook | undefined, now: HealthLook): NumberChange | undefined {
  if (!previous) return undefined
  if (now.hpSeq > previous.hpSeq) {
    return now.total < previous.total ? { kind: 'damage', amount: previous.total - now.total } : undefined
  }
  if (now.hpSeq === previous.hpSeq && now.maxHp === previous.maxHp && previous.hp > 0 && now.hp > previous.hp) {
    return { kind: 'heal', amount: now.hp - previous.hp }
  }
  return undefined
}

// How long a champion's heals are gathered into one number. A healing area heals many times a second, and a number for each would be a pile of
// them one on another, so the first heal shows at once and the ones that come after it are added up and shown together when this is over.
export const HEAL_MERGE_MS = 700

// The heals that are waiting to be shown, by champion.
export class HealMerger {
  private readonly waiting = new Map<number, { shownAt: number; amount: number }>()

  // A champion got this much health back.
  add(id: number, amount: number): void {
    if (!(amount > 0)) return
    const entry = this.waiting.get(id)
    if (entry) entry.amount += amount
    else this.waiting.set(id, { shownAt: Number.NEGATIVE_INFINITY, amount })
  }

  // The numbers that are to be shown now: each champion's heals so far, when it has any and its last number was at least `HEAL_MERGE_MS` ago.
  take(now: number): Array<{ id: number; amount: number }> {
    const due: Array<{ id: number; amount: number }> = []
    for (const [id, entry] of this.waiting) {
      if (entry.amount > 0 && now - entry.shownAt >= HEAL_MERGE_MS) {
        due.push({ id, amount: entry.amount })
        entry.amount = 0
        entry.shownAt = now
      }
    }
    return due
  }

  // A champion that is no longer in the game: what was waiting for it is not shown, and what it was told of is forgotten.
  forget(id: number): void {
    this.waiting.delete(id)
  }
}

// How a number is drawn at an age (in milliseconds): how opaque it is, and how far it has risen from where it began.
export function floatingNumberPose(elapsed: number): { alpha: number; rise: number; done: boolean } {
  const done = elapsed >= FLOATING_NUMBER_MS
  return { alpha: Math.max(0, 1 - elapsed / FLOATING_NUMBER_MS), rise: Math.max(0, elapsed) * FLOATING_NUMBER_RISE, done }
}

export const floatingNumberText = (change: NumberChange): string => `${change.kind === 'damage' ? '-' : '+'}${change.amount}`
