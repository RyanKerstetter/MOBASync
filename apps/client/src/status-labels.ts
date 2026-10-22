export type StatusFlags = {
  stunned: boolean
  rooted: boolean
  silenced: boolean
  blinded: boolean
  burning: boolean
  slowed: boolean
  hasted: boolean
  dodging: boolean
}

// What is affecting a champion, as words, the most disabling first: stun, then root, then silence,
// blind, burn, slow, haste and dodge. A dead champion shows none.
const LABELS: Array<[flag: keyof StatusFlags, text: string]> = [
  ['stunned', 'stunned'],
  ['rooted', 'rooted'],
  ['silenced', 'silenced'],
  ['blinded', 'blinded'],
  ['burning', 'burning'],
  ['slowed', 'slowed'],
  ['hasted', 'hasted'],
  ['dodging', 'dodging'],
]

export function statusLabels(character: StatusFlags & { dead: boolean }): string[] {
  if (character.dead) return []
  return LABELS.filter(([flag]) => character[flag]).map(([, text]) => text)
}
