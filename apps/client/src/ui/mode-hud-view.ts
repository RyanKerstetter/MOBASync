import { getTeam } from '../../../../packages/shared/src/index.ts'
import { element } from './dom.ts'
import { coreHint, coreReadout, flagHint, flagReadout, hillReadout, modeTitle, type CoreView, type FlagView, type ModeView, type TeamScore } from './mode-hud.ts'

const NEUTRAL_COLOR = '#c9d6e4'

// What each kind of score is called, for the screen reader.
const SCORE_NAME = { deathmatch: 'kills', koth: 'points', ctf: 'captures', core: 'cores' } as const

function scoreChip(row: TeamScore, localTeam: number | undefined): HTMLElement {
  const team = getTeam(row.team)
  const swatch = element('span', 'mode-swatch')
  swatch.setAttribute('aria-hidden', 'true')
  // The name as well as the colour, so it does not rest on telling colours apart.
  const item = element('li', '', swatch, element('span', 'mode-team', team.name), element('span', 'mode-score', String(row.score)))
  item.classList.toggle('is-local', row.team === localTeam)
  item.style.setProperty('--team-color', team.color)
  return item
}

function flagItem(flag: FlagView): HTMLElement {
  const team = getTeam(flag.team)
  const icon = element('span', 'mode-flag-icon', '⚑')
  icon.setAttribute('aria-hidden', 'true')
  const state = element('span', 'mode-flag-state', flagReadout(flag))
  if (flag.carrier) state.style.setProperty('--carrier-color', getTeam(flag.carrier.team).color)
  const item = element('li', `mode-flag is-${flag.status}`, icon, element('span', 'mode-flag-name', `${team.name} flag`), state)
  item.style.setProperty('--team-color', team.color)
  return item
}

function coreItem(core: CoreView): HTMLElement {
  const team = getTeam(core.team)
  const readout = coreReadout(core)
  const fill = element('span', 'mode-core-fill')
  fill.style.width = `${Math.round(readout.fraction * 100)}%`
  const item = element(
    'li',
    `mode-core is-${core.status}`,
    element('span', 'mode-core-name', `${team.name} core`),
    element('span', 'mode-core-bar', fill),
    element('span', 'mode-core-state', readout.text),
  )
  item.style.setProperty('--team-color', team.color)
  return item
}

// The top middle: the mode, each team's score and, for the hill, its bar and, for the flags, where each
// one is and who has it, and for the cores how each stands. Plain elements over the canvas, hidden until the first update, and rebuilt
// only when what they say changes (the hill's bar moves every frame).
export function createModeHudView(container: HTMLElement) {
  const title = element('div', 'mode-title')
  const scores = element('ul', 'mode-scores')
  const hillFill = element('div', 'mode-hill-fill')
  const hillText = element('div', 'mode-hill-text')
  const hill = element('div', 'mode-hill', element('div', 'mode-hill-bar', hillFill), hillText)
  hill.setAttribute('role', 'progressbar')
  hill.setAttribute('aria-label', 'Hill capture')
  hill.setAttribute('aria-valuemin', '0')
  hill.setAttribute('aria-valuemax', '100')
  const flags = element('ul', 'mode-flags')
  const coreRows = element('ul', 'mode-cores')
  const hint = element('p', 'mode-hint')
  const root = element('div', 'game-mode-hud', title, scores, hill, flags, coreRows, hint)
  root.hidden = true
  container.appendChild(root)
  let shownScores = ''
  let shownFlags = ''
  let shownCores = ''

  return {
    // `local` is the controlled champion, whose team is marked in the scores and who the hint is for.
    update(view: ModeView, local?: { id: number; team: number }): void {
      root.hidden = false
      root.dataset.mode = view.kind
      title.textContent = modeTitle(view)
      scores.setAttribute('aria-label', `Team ${SCORE_NAME[view.kind]}`)

      // In Core Destruction the cores say how it stands, and a team's score (how many cores it has broken) is only one or none.
      scores.hidden = view.kind === 'core'
      const scoresKey = JSON.stringify([view.scores, local?.team])
      if (scoresKey !== shownScores) {
        shownScores = scoresKey
        scores.replaceChildren(...view.scores.map((row) => scoreChip(row, local?.team)))
      }

      hill.hidden = view.kind !== 'koth'
      if (view.kind === 'koth') {
        const readout = hillReadout(view)
        hillFill.style.width = `${readout.fraction * 100}%`
        hillFill.style.background = readout.team === undefined ? NEUTRAL_COLOR : getTeam(readout.team).color
        hillText.textContent = readout.text
        hill.classList.toggle('is-held', view.owner !== undefined)
        hill.classList.toggle('is-contested', view.contested)
        hill.setAttribute('aria-valuenow', String(Math.round(readout.fraction * 100)))
        hill.setAttribute('aria-valuetext', readout.text)
      }

      flags.hidden = view.kind !== 'ctf'
      const flagViews = view.kind === 'ctf' ? view.flags : []
      const flagsKey = JSON.stringify(flagViews.map((flag) => [flag.team, flag.status, flag.carrier]))
      if (flagsKey !== shownFlags) {
        shownFlags = flagsKey
        flags.replaceChildren(...flagViews.map(flagItem))
      }

      coreRows.hidden = view.kind !== 'core'
      const coreViews = view.kind === 'core' ? view.cores : []
      const coresKey = JSON.stringify(coreViews)
      if (coresKey !== shownCores) {
        shownCores = coresKey
        coreRows.replaceChildren(...coreViews.map(coreItem))
      }

      const text = view.kind === 'ctf' ? flagHint(view.flags, local) : view.kind === 'core' ? coreHint(view.cores, local) : undefined
      hint.hidden = text === undefined
      hint.textContent = text ?? ''
    },
    destroy(): void {
      root.remove()
    },
  }
}
