import {
  abilityDefs,
  champions,
  GAME_TPS,
  type Champion,
} from '../../../packages/shared/src/index.ts'

export type SelectPlayer = { id: string; name: string }
export type SelectionEntry = { playerId: string; championId: string; locked: boolean }
export type ChampionSelectState = {
  localPlayerId: string
  players: SelectPlayer[]
  selections: SelectionEntry[]
}

type ChampionSelectOptions = {
  root: HTMLElement
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

export function createChampionSelect({ root, onPick, onLock, onBack }: ChampionSelectOptions) {
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
      name.textContent = 'P � Passive'
      const detail = document.createElement('span')
      detail.textContent = champion.passive
      item.append(name, detail)
      abilities.append(item)
    }
    champion.abilities.forEach((abilityId, slot) => {
      const item = document.createElement('li')
      const name = document.createElement('strong')
      name.textContent = `${abilityKeys[slot] ?? slot + 1} · ${titleCase(abilityId)}`
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

    playerList.replaceChildren()
    for (const player of state.players) {
      const entry = entries.get(player.id)
      const championName = entry ? champions.get(entry.championId)?.name ?? entry.championId : 'Choosing'
      const item = document.createElement('li')
      item.textContent = `${player.name}${player.id === state.localPlayerId ? ' (you)' : ''} — ${championName}, ${entry?.locked ? 'locked in' : 'choosing'}`
      item.classList.toggle('is-locked', Boolean(entry?.locked))
      playerList.append(item)
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
