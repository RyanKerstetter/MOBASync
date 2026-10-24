import { getTeam } from '../../../../packages/shared/src/index.ts'
import { flagHint, flagReadout, hillReadout, modeTitle, type FlagView, type ModeView, type TeamScore } from './mode-hud.ts'

const NEUTRAL_COLOR = '#c9d6e4'

// What each kind of score is called, for the screen reader.
const SCORE_NAME = { deathmatch: 'kills', koth: 'points', ctf: 'captures' } as const

function scoreChip(row: TeamScore, localTeam: number | undefined): HTMLElement {
  const team = getTeam(row.team)
  const item = document.createElement('li')
  item.classList.toggle('is-local', row.team === localTeam)
  item.style.setProperty('--team-color', team.color)
  const swatch = document.createElement('span')
  swatch.className = 'mode-swatch'
  swatch.setAttribute('aria-hidden', 'true')
  // The name as well as the colour, so it does not rest on telling colours apart.
  const name = document.createElement('span')
  name.className = 'mode-team'
  name.textContent = team.name
  const score = document.createElement('span')
  score.className = 'mode-score'
  score.textContent = String(row.score)
  item.append(swatch, name, score)
  return item
}

function flagItem(flag: FlagView): HTMLElement {
  const team = getTeam(flag.team)
  const item = document.createElement('li')
  item.className = `mode-flag is-${flag.status}`
  item.style.setProperty('--team-color', team.color)
  const icon = document.createElement('span')
  icon.className = 'mode-flag-icon'
  icon.textContent = '⚑'
  icon.setAttribute('aria-hidden', 'true')
  const name = document.createElement('span')
  name.className = 'mode-flag-name'
  name.textContent = `${team.name} flag`
  const state = document.createElement('span')
  state.className = 'mode-flag-state'
  state.textContent = flagReadout(flag)
  if (flag.carrier) state.style.setProperty('--carrier-color', getTeam(flag.carrier.team).color)
  item.append(icon, name, state)
  return item
}

// The top middle: the mode, each team's score and, for the hill, its bar and, for the flags, where each
// one is and who has it. Plain elements over the canvas, hidden until the first update, and rebuilt
// only when what they say changes (the hill's bar moves every frame).
export function createModeHudView(container: HTMLElement) {
  const root = document.createElement('div')
  root.className = 'game-mode-hud'
  root.hidden = true
  const title = document.createElement('div')
  title.className = 'mode-title'
  const scores = document.createElement('ul')
  scores.className = 'mode-scores'
  const hill = document.createElement('div')
  hill.className = 'mode-hill'
  hill.setAttribute('role', 'progressbar')
  hill.setAttribute('aria-label', 'Hill capture')
  hill.setAttribute('aria-valuemin', '0')
  hill.setAttribute('aria-valuemax', '100')
  const hillBar = document.createElement('div')
  hillBar.className = 'mode-hill-bar'
  const hillFill = document.createElement('div')
  hillFill.className = 'mode-hill-fill'
  hillBar.append(hillFill)
  const hillText = document.createElement('div')
  hillText.className = 'mode-hill-text'
  hill.append(hillBar, hillText)
  const flags = document.createElement('ul')
  flags.className = 'mode-flags'
  const hint = document.createElement('p')
  hint.className = 'mode-hint'
  root.append(title, scores, hill, flags, hint)
  container.appendChild(root)
  let shownScores = ''
  let shownFlags = ''

  return {
    // `local` is the controlled champion, whose team is marked in the scores and who the hint is for.
    update(view: ModeView, local?: { id: number; team: number }): void {
      root.hidden = false
      root.dataset.mode = view.kind
      title.textContent = modeTitle(view)
      scores.setAttribute('aria-label', `Team ${SCORE_NAME[view.kind]}`)

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

      const text = view.kind === 'ctf' ? flagHint(view.flags, local) : undefined
      hint.hidden = text === undefined
      hint.textContent = text ?? ''
    },
    destroy(): void {
      root.remove()
    },
  }
}
