export type StackPip = {
  // Where the pip's centre is, relative to the champion's centre.
  x: number
  y: number
  color: string
  // A round pip is a stack the champion built up itself; a diamond is a mark someone else put on it.
  shape: 'circle' | 'diamond'
}

// Stacks are markers, counted by key. Two kinds are told apart on the champion that carries them,
// by shape, colour and row, so that two with similar colours (a Swordsman's gold sword stacks, a
// Grenadier's mark on that same Swordsman) never share a spot.
//
// Its own stacks, built up by the champion itself and spent by it:
const OWN_STACKS: Array<[key: string, color: string]> = [
  ['sword', '#f2c14e'],
  ['empowered', '#7fd6ff'],
  ['shadow', '#ff9f43'],
]
// Marks other champions place on it, read by them:
const MARKS: Array<[key: string, color: string]> = [
  ['curse', '#b36df2'],
  ['gale', '#bfe6ff'],
  ['sighted', '#ff5a5f'],
  ['trick', '#3fc8c0'],
]

const PIP_SPACING = 9
// The first row sits this far below the body's edge, and each further row this far below that.
const FIRST_ROW_GAP = 10
const ROW_SPACING = 11

// One pip per stack, in rows under a body of radius `bodyRadius`: its own stacks first, round,
// and the marks on it below them, as diamonds. Each row is centred on the champion, a row with
// nothing in it takes no room, and a champion with only one kind has it in the first row.
export function layoutStackPips(counts: Readonly<Record<string, number>>, bodyRadius: number): StackPip[] {
  const pips: StackPip[] = []
  let y = bodyRadius + FIRST_ROW_GAP
  for (const { stacks, shape } of [
    { stacks: OWN_STACKS, shape: 'circle' as const },
    { stacks: MARKS, shape: 'diamond' as const },
  ]) {
    const row = stacks.flatMap(([key, color]) => Array.from({ length: counts[key] ?? 0 }, () => color))
    row.forEach((color, index) => {
      pips.push({ x: (index - (row.length - 1) / 2) * PIP_SPACING, y, color, shape })
    })
    if (row.length > 0) y += ROW_SPACING
  }
  return pips
}
