export type StatusFlags = {
  stunned: boolean
  feared: boolean
  rooted: boolean
  silenced: boolean
  disarmed: boolean
  blinded: boolean
  burning: boolean
  poisoned: boolean
  slowed: boolean
  hasted: boolean
  dodging: boolean
  invisible: boolean
}

// What is affecting a champion, as words, the most disabling first: stun, then fear, root, silence,
// disarm, blind, burn, poison, slow, haste, dodge and invisible. A dead champion shows none.
const LABELS: Array<[flag: keyof StatusFlags, text: string]> = [
  ['stunned', 'stunned'],
  ['feared', 'feared'],
  ['rooted', 'rooted'],
  ['silenced', 'silenced'],
  ['disarmed', 'disarmed'],
  ['blinded', 'blinded'],
  ['burning', 'burning'],
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
