import {
  abilityDefs,
  champions,
  GAME_TPS,
  getTeam,
  type Champion,
} from '../../../packages/shared/src/index.ts'
import { createAbilityIcon, type AbilityIconUrl } from './ui/ability-icon.ts'

export type SelectPlayer = { id: string; name: string; team?: number }
export type SelectionEntry = { playerId: string; championId: string; locked: boolean }
export type ChampionSelectState = {
  localPlayerId: string
  players: SelectPlayer[]
  selections: SelectionEntry[]
}

export type TeamGroup = { team: number | undefined; players: SelectPlayer[] }

// The players grouped by team, the teams in team order and the players of each in the order given. A
// player with no team (a lobby from before teams) is put last, in a group of their own.
export function groupPlayersByTeam(players: readonly SelectPlayer[]): TeamGroup[] {
  const groups = new Map<number | undefined, SelectPlayer[]>()
  for (const player of players) {
    const members = groups.get(player.team)
    if (members) members.push(player)
    else groups.set(player.team, [player])
  }
  return [...groups]
    .sort(([left], [right]) => (left ?? Infinity) - (right ?? Infinity))
    .map(([team, members]) => ({ team, players: members }))
}

type ChampionSelectOptions = {
  root: HTMLElement
  // Where an ability's icon is served from. Passed in because finding the files needs Vite.
  abilityIconUrl: AbilityIconUrl
  onPick: (championId: string) => void
  onLock: () => void
  onBack: () => void
}

const abilityKeys = ['Q', 'W', 'E', 'R']

function requiredElement<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`The champion select page is missing the required element: ${selector}`)
  return element
}

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

function statRows(champion: Champion): Array<[string, string]> {
  return [
    ['Health', String(champion.maxHp)],
    ['Move speed', String(champion.moveSpeed)],
    ['Attack damage', String(champion.attackDamage)],
    ['Attack range', String(champion.attackRange)],
    ['Attacks per second', String(champion.attackSpeed)],
  ]
}

function abilityDescription(abilityId: string): string {
  const def = abilityDefs.get(abilityId)
  if (!def) return ''
  const parts = [def.targeting === 'none' ? 'no target' : `${def.targeting} target`]
  if (def.range > 0) parts.push(`range ${def.range}`)
  parts.push(`${(def.cooldownTicks / GAME_TPS).toFixed(0)}s cooldown`)
  const summary = parts.join(', ')
  return def.description ? `${def.description} (${summary})` : summary
}

export function createChampionSelect({ root, abilityIconUrl, onPick, onLock, onBack }: ChampionSelectOptions) {
  const grid = requiredElement<HTMLUListElement>(root, '#champion-grid')
  const details = requiredElement<HTMLElement>(root, '#champion-details')
  const playerList = requiredElement<HTMLUListElement>(root, '#select-players')
  const message = requiredElement<HTMLParagraphElement>(root, '#select-message')
  const lockButton = requiredElement<HTMLButtonElement>(root, '#lock-button')
  const backButton = requiredElement<HTMLButtonElement>(root, '#select-back-button')

  // The pick the player just clicked, shown until the server's state catches up.
  let optimisticChampionId: string | undefined
  let shownDetailsId: string | undefined
  let localLocked = false
  let lastState: ChampionSelectState = { localPlayerId: '', players: [], selections: [] }
  const cards = new Map<string, { button: HTMLButtonElement; picks: HTMLElement }>()

  for (const champion of champions.values()) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'champion-card'
    const name = document.createElement('strong')
    name.textContent = champion.name
    const summary = document.createElement('span')
    summary.textContent = champion.description
    const picks = document.createElement('span')
    picks.className = 'champion-picks'
    button.append(name, summary, picks)
    button.addEventListener('click', () => {
      if (localLocked) return
      optimisticChampionId = champion.id
      render(lastState)
      onPick(champion.id)
    })
    item.append(button)
    grid.append(item)
    cards.set(champion.id, { button, picks })
  }

  lockButton.addEventListener('click', () => {
    if (!localLocked) onLock()
  })
  backButton.addEventListener('click', onBack)

  function renderDetails(champion: Champion): void {
    details.replaceChildren()
    const heading = document.createElement('h3')
    heading.textContent = champion.name
    const blurb = document.createElement('p')
    blurb.textContent = champion.description

    const stats = document.createElement('dl')
    for (const [label, value] of statRows(champion)) {
      const term = document.createElement('dt')
      term.textContent = label
      const definition = document.createElement('dd')
      definition.textContent = value
      stats.append(term, definition)
    }

    const abilityHeading = document.createElement('h4')
    abilityHeading.textContent = 'Abilities'
    const abilities = document.createElement('ul')
    if (champion.passive) {
      const item = document.createElement('li')
      const name = document.createElement('strong')
      name.textContent = 'P · Passive'
      const detail = document.createElement('span')
      detail.textContent = champion.passive
      item.append(name, detail)
      abilities.append(item)
    }
    champion.abilities.forEach((abilityId, slot) => {
      const item = document.createElement('li')
      const name = document.createElement('strong')
      name.className = 'ability-title'
      name.append(
        createAbilityIcon(abilityId, abilityIconUrl),
        document.createTextNode(`${abilityKeys[slot] ?? slot + 1} · ${titleCase(abilityId)}`),
      )
      const detail = document.createElement('span')
      detail.textContent = abilityDescription(abilityId)
      item.append(name, detail)
      abilities.append(item)
    })
    details.append(heading, blurb, stats, abilityHeading, abilities)
  }

  function render(state: ChampionSelectState): void {
    lastState = state
    const entries = new Map(state.selections.map((entry) => [entry.playerId, entry]))
    const local = entries.get(state.localPlayerId)
    if (optimisticChampionId !== undefined && local?.championId === optimisticChampionId) {
      optimisticChampionId = undefined
    }
    localLocked = local?.locked ?? false
    const selectedId = optimisticChampionId ?? local?.championId

    for (const [championId, card] of cards) {
      const pickedBy = state.players
        .filter((player) => player.id !== state.localPlayerId
          && entries.get(player.id)?.championId === championId)
        .map((player) => player.name)
      card.picks.textContent = pickedBy.length > 0 ? `Picked by ${pickedBy.join(', ')}` : ''
      const isSelected = championId === selectedId
      card.button.classList.toggle('is-selected', isSelected)
      card.button.setAttribute('aria-pressed', String(isSelected))
      card.button.disabled = localLocked
    }

    const champion = selectedId === undefined ? undefined : champions.get(selectedId)
    if (champion && champion.id !== shownDetailsId) {
      renderDetails(champion)
      shownDetailsId = champion.id
    }

    // Who is picking what, a group for each team under a heading with its colour and name.
    playerList.replaceChildren()
    for (const group of groupPlayersByTeam(state.players)) {
      const section = document.createElement('li')
      section.className = 'team-group'
      const members = document.createElement('ul')
      if (group.team !== undefined) {
        const team = getTeam(group.team)
        const heading = document.createElement('span')
        heading.className = 'team-heading'
        const swatch = document.createElement('span')
        swatch.className = 'team-swatch'
        swatch.style.background = team.color
        swatch.setAttribute('aria-hidden', 'true')
        heading.append(swatch, document.createTextNode(`${team.name} team`))
        section.append(heading)
      }
      for (const player of group.players) {
        const entry = entries.get(player.id)
        const championName = entry ? champions.get(entry.championId)?.name ?? entry.championId : 'Choosing'
        const item = document.createElement('li')
        item.textContent = `${player.name}${player.id === state.localPlayerId ? ' (you)' : ''} — ${championName}, ${entry?.locked ? 'locked in' : 'choosing'}`
        item.classList.toggle('is-locked', Boolean(entry?.locked))
        members.append(item)
      }
      section.append(members)
      playerList.append(section)
    }

    lockButton.disabled = localLocked || selectedId === undefined
    lockButton.textContent = localLocked ? 'Locked in — waiting for the others' : 'Lock in'
  }

  return {
    render,
    setMessage(text: string, isError = false): void {
      message.textContent = text
      message.classList.toggle('is-error', isError)
    },
    // The server refused the pick, so fall back to what it has on record.
    discardPendingPick(): void {
      optimisticChampionId = undefined
      render(lastState)
    },
  }
}
