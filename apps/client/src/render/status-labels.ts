export type StatusFlags = {
  stunned: boolean
  // Knocked up: held as a stun holds it, and drawn in the air.
  airborne: boolean
  feared: boolean
  rooted: boolean
  silenced: boolean
  disarmed: boolean
  blinded: boolean
  burning: boolean
  bleeding: boolean
  // Carrying an Ent's spore (see `spore`).
  spored: boolean
  poisoned: boolean
  slowed: boolean
  hasted: boolean
  dodging: boolean
  invisible: boolean
}

// What is affecting a champion, as words, the most disabling first: stun, then knock-up, fear, root, silence,
// disarm, blind, burn, bleed, spore, poison, slow, haste, dodge and invisible. A dead champion shows none.
const LABELS: Array<[flag: keyof StatusFlags, text: string]> = [
  ['stunned', 'stunned'],
  ['airborne', 'airborne'],
  ['feared', 'feared'],
  ['rooted', 'rooted'],
  ['silenced', 'silenced'],
  ['disarmed', 'disarmed'],
  ['blinded', 'blinded'],
  ['burning', 'burning'],
  ['bleeding', 'bleeding'],
  ['spored', 'spored'],
  ['poisoned', 'poisoned'],
  ['slowed', 'slowed'],
  ['hasted', 'hasted'],
  ['dodging', 'dodging'],
  ['invisible', 'invisible'],
]

export function statusLabels(character: StatusFlags & { dead: boolean }): string[] {
  if (character.dead) return []
  return LABELS.filter(([flag]) => character[flag]).map(([, text]) => text)
}
