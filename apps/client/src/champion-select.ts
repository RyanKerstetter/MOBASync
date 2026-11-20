import {
  abilityDefs,
  abilityIconName,
  abilityName,
  champions,
  GAME_TPS,
  getTeam,
  walkingSpeed,
  type Champion,
} from '../../../packages/shared/src/index.ts'
import { loadSettings } from './game-settings.ts'
import { abilityKeyCodes, keyLabel } from './movement-keys.ts'
import { ChampionStage, drawChampionPortraits } from './render3d/champion-stage.ts'
import { championLook } from './render3d/models/looks.ts'
import { createAbilityIcon, type AbilityIconUrl } from './ui/ability-icon.ts'
import { element, requireElement } from './ui/dom.ts'

export type SelectPlayer = { id: string; name: string; team?: number }
export type SelectionEntry = { playerId: string; championId: string; locked: boolean }
export type ChampionSelectState = {
  localPlayerId: string
  players: SelectPlayer[]
  selections: SelectionEntry[]
}

export type TeamGroup<P extends SelectPlayer = SelectPlayer> = { team: number | undefined; players: P[] }

// The players grouped by team, the teams in team order and the players of each in the order given. A
// player with no team (a lobby from before teams) is put last, in a group of their own.
export function groupPlayersByTeam<P extends SelectPlayer>(players: readonly P[]): Array<TeamGroup<P>> {
  const groups = new Map<number | undefined, P[]>()
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

type Role = 'all' | 'melee' | 'ranged'

// How big a portrait in the grid is drawn, in pixels (it is shown smaller, so it stays sharp on a dense screen).
const PORTRAIT_SIZE = 192

function requiredElement<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  return requireElement<T>(root, selector, 'champion select')
}

// A champion that fights from range is one whose attacks are shots.
function roleOf(champion: Champion): Exclude<Role, 'all'> {
  return champion.attackProjectile ? 'ranged' : 'melee'
}

// The stats shown as bars, each against the lowest and highest of every champion's, so a bar says where a champion stands.
const STATS: Array<{ label: string; value: (champion: Champion) => number; format?: (value: number) => string }> = [
  { label: 'Health', value: (champion) => champion.maxHp },
  { label: 'Attack damage', value: (champion) => champion.attackDamage },
  { label: 'Attack speed', value: (champion) => champion.attackSpeed, format: (value) => value.toFixed(2) },
  { label: 'Attack range', value: (champion) => champion.attackRange },
  { label: 'Move speed', value: (champion) => Math.round(walkingSpeed(champion.moveSpeed)) },
]

function statSpans(): Array<{ low: number; high: number }> {
  const all = [...champions.values()]
  return STATS.map((stat) => {
    const values = all.map(stat.value)
    return { low: Math.min(...values), high: Math.max(...values) }
  })
}

function seconds(ticks: number): string {
  return `${Number((ticks / GAME_TPS).toFixed(1))}s`
}

// What an ability is, in a line under its name: how it is aimed, how far, how often.
function abilityFacts(abilityId: string): string {
  const def = abilityDefs.get(abilityId)
  if (!def) return ''
  const parts = [`${seconds(def.cooldownTicks)} cooldown`]
  if (def.range > 0 && def.targeting !== 'none') parts.push(`range ${def.range}`)
  return parts.join(' · ')
}

// A picture of a champion that fills its box: its portrait once it is drawn, its initial on its own colour until then (or for good
// where there is no WebGL).
function portraitBox(className: string, champion: Champion | undefined, url: string | undefined): HTMLElement {
  const box = element('span', className)
  box.setAttribute('aria-hidden', 'true')
  if (!champion) return box
  box.style.setProperty('--accent', championLook(champion).accent)
  if (url) {
    const image = element('img')
    image.alt = ''
    image.draggable = false
    image.src = url
    box.append(image)
  } else {
    box.append(element('span', 'portrait-initial', champion.name.slice(0, 1)))
  }
  return box
}

export function createChampionSelect({ root, abilityIconUrl, onPick, onLock, onBack }: ChampionSelectOptions) {
  const grid = requiredElement<HTMLUListElement>(root, '#champion-grid')
  const details = requiredElement<HTMLElement>(root, '#champion-details')
  const ownTeam = requiredElement<HTMLElement>(root, '#select-own-team')
  const otherTeams = requiredElement<HTMLElement>(root, '#select-other-teams')
  const progress = requiredElement<HTMLElement>(root, '#select-progress')
  const search = requiredElement<HTMLInputElement>(root, '#select-search')
  const roleBar = requiredElement<HTMLElement>(root, '#select-roles')
  const message = requiredElement<HTMLParagraphElement>(root, '#select-message')
  const lockButton = requiredElement<HTMLButtonElement>(root, '#lock-button')
  const backButton = requiredElement<HTMLButtonElement>(root, '#select-back-button')

  // The pick the player just clicked, shown until the server's state catches up.
  let optimisticChampionId: string | undefined
  let shownDetailsId: string | undefined
  let localLocked = false
  let lastState: ChampionSelectState = { localPlayerId: '', players: [], selections: [] }
  let role: Role = 'all'
  const portraits = new Map<string, string>()
  const cards = new Map<string, { item: HTMLLIElement; button: HTMLButtonElement; picks: HTMLElement; portrait: HTMLElement }>()
  const spans = statSpans()

  // The picked champion on its pedestal, and the details beside it.
  const stageCanvas = element('canvas', 'stage-canvas')
  stageCanvas.setAttribute('aria-hidden', 'true')
  let stage: ChampionStage | undefined
  try {
    stage = new ChampionStage(stageCanvas, loadSettings().graphics)
  } catch {
    stage = undefined
  }
  const stageBox = element('div', 'details-stage', stageCanvas)
  if (stage) stageBox.append(element('p', 'stage-hint', 'Drag to turn'))
  const info = element('div', 'details-info', element('p', 'details-empty', 'Pick a champion to see what it can do.'))
  details.replaceChildren(stageBox, info)

  for (const champion of champions.values()) {
    const picks = element('span', 'champion-picks')
    const portrait = portraitBox('card-portrait', champion, undefined)
    const button = element('button', 'champion-card', portrait, element('span', 'card-name', champion.name), picks)
    button.type = 'button'
    button.title = champion.description
    button.addEventListener('click', () => {
      if (localLocked) return
      optimisticChampionId = champion.id
      render(lastState)
      onPick(champion.id)
    })
    const item = element('li', '', button)
    item.dataset.role = roleOf(champion)
    grid.append(item)
    cards.set(champion.id, { item, button, picks, portrait })
  }

  // The portraits come in one a frame; each takes the place of its initial in the grid, and the teams pick it up as they redraw.
  drawChampionPortraits([...champions.values()], PORTRAIT_SIZE, (championId, url) => {
    portraits.set(championId, url)
    const card = cards.get(championId)
    const champion = champions.get(championId)
    if (card && champion) {
      const fresh = portraitBox('card-portrait', champion, url)
      card.portrait.replaceWith(fresh)
      card.portrait = fresh
    }
    renderTeams(lastState)
  })

  // Melee or ranged, and a name to search for: the champions that are neither are put away, not greyed out.
  const roleButtons = (['all', 'melee', 'ranged'] as const).map((value) => {
    const button = element('button', 'role-tab', value === 'all' ? 'All' : value === 'melee' ? 'Melee' : 'Ranged')
    button.type = 'button'
    button.setAttribute('aria-pressed', String(value === role))
    button.addEventListener('click', () => {
      role = value
      for (const [index, other] of roleButtons.entries()) other.setAttribute('aria-pressed', String(['all', 'melee', 'ranged'][index] === role))
      filter()
    })
    return button
  })
  roleBar.replaceChildren(...roleButtons)
  search.addEventListener('input', filter)

  function filter(): void {
    const text = search.value.trim().toLowerCase()
    for (const [championId, card] of cards) {
      const champion = champions.get(championId)
      const fits = champion !== undefined
        && (role === 'all' || roleOf(champion) === role)
        && (text === '' || champion.name.toLowerCase().includes(text))
      card.item.hidden = !fits
    }
  }

  lockButton.addEventListener('click', () => {
    if (!localLocked) onLock()
  })
  backButton.addEventListener('click', onBack)

  function renderDetails(champion: Champion): void {
    stage?.show(champion)
    // The keys the player casts with, which are not the usual ones when W, A, S and D steer.
    const abilityKeys = abilityKeyCodes(loadSettings().movementKeys).map(keyLabel)
    type Entry = { key: string; name: string; text: string; facts: string; icon: HTMLElement }
    const entries: Entry[] = []
    if (champion.passive) {
      const glyph = element('span', 'ability-icon passive-icon', 'P')
      glyph.style.setProperty('--accent', championLook(champion).accent)
      entries.push({ key: 'Passive', name: 'Passive', text: champion.passive, facts: '', icon: glyph })
    }
    champion.abilities.forEach((abilityId, slot) => {
      entries.push({
        key: abilityKeys[slot] ?? String(slot + 1),
        name: abilityName({ id: abilityId, ...abilityDefs.get(abilityId) }),
        text: abilityDefs.get(abilityId)?.description ?? '',
        facts: abilityFacts(abilityId),
        icon: createAbilityIcon(abilityIconName(abilityId), abilityIconUrl),
      })
    })

    const about = element('div', 'ability-detail')
    about.setAttribute('aria-live', 'polite')
    const tabs = entries.map((entry, index) => {
      const button = element('button', 'ability-tab', entry.icon, element('span', 'ability-key', entry.key === 'Passive' ? 'P' : entry.key))
      button.type = 'button'
      button.setAttribute('aria-label', `${entry.key === 'Passive' ? 'Passive' : entry.key}: ${entry.name}`)
      const choose = (): void => showAbility(index)
      button.addEventListener('mouseenter', choose)
      button.addEventListener('focus', choose)
      button.addEventListener('click', choose)
      return button
    })
    function showAbility(index: number): void {
      const entry = entries[index]
      if (!entry) return
      for (const [other, tab] of tabs.entries()) tab.classList.toggle('is-active', other === index)
      const head = element('p', 'ability-detail-head', element('strong', '', entry.name), ...(entry.key === 'Passive' ? [] : [element('span', 'ability-detail-key', entry.key)]))
      about.replaceChildren(head, element('p', 'ability-detail-text', entry.text), ...(entry.facts ? [element('p', 'ability-detail-facts', entry.facts)] : []))
    }
    showAbility(0)

    const stats = element('dl', 'details-stats', ...STATS.flatMap((stat, index) => {
      const value = stat.value(champion)
      const { low, high } = spans[index] ?? { low: 0, high: 1 }
      // The lowest is a short bar, not an empty one.
      const share = high > low ? 0.18 + 0.82 * (value - low) / (high - low) : 1
      const fill = element('span', 'stat-fill')
      fill.style.width = `${Math.round(share * 100)}%`
      return [element('dt', '', stat.label), element('dd', '', element('span', 'stat-bar', fill), element('span', 'stat-value', stat.format ? stat.format(value) : String(value)))]
    }))

    info.replaceChildren(
      element('p', 'details-role', roleOf(champion) === 'ranged' ? 'Ranged' : 'Melee'),
      element('h3', 'details-name', champion.name),
      element('p', 'details-blurb', champion.description),
      stats,
      element('div', 'ability-tabs', ...tabs),
      about,
    )
    info.style.setProperty('--accent', championLook(champion).accent)
  }

  // Who is picking what: the player's own team down the left, every other team down the right, a slot for each player with the
  // portrait of what they have picked.
  function renderTeams(state: ChampionSelectState): void {
    const entries = new Map(state.selections.map((entry) => [entry.playerId, entry]))
    const ownTeamId = state.players.find((player) => player.id === state.localPlayerId)?.team
    const groups = groupPlayersByTeam(state.players)
    const teamBlock = (group: TeamGroup, title?: string): HTMLElement => {
      const block = element('section', 'team-block')
      const team = group.team === undefined ? undefined : getTeam(group.team)
      if (team) block.style.setProperty('--team', team.color)
      block.append(element('h3', 'team-banner', title ?? (team ? `${team.name} team` : 'Players')))
      block.append(element('ul', 'team-slots', ...group.players.map((player) => {
        const entry = entries.get(player.id)
        const isYou = player.id === state.localPlayerId
        const pickedId = isYou ? optimisticChampionId ?? entry?.championId : entry?.championId
        const champion = pickedId === undefined ? undefined : champions.get(pickedId)
        const slot = element('li', 'slot')
        slot.classList.toggle('is-you', isYou)
        slot.classList.toggle('is-locked', Boolean(entry?.locked))
        slot.classList.toggle('is-picking', !entry?.locked)
        const name = element('strong', 'slot-player', player.name)
        if (isYou) name.append(element('span', 'slot-you', 'You'))
        slot.append(
          portraitBox('slot-portrait', champion, champion ? portraits.get(champion.id) : undefined),
          element('span', 'slot-text', name, element('span', 'slot-champion', champion ? champion.name : 'Picking…')),
        )
        if (entry?.locked) slot.append(element('span', 'slot-state', 'Locked'))
        return slot
      })))
      return block
    }
    const own = groups.filter((group) => group.team === ownTeamId)
    const others = groups.filter((group) => group.team !== ownTeamId)
    ownTeam.replaceChildren(...own.map((group) => teamBlock(group, 'Your team')))
    otherTeams.replaceChildren(...(others.length > 0 ? others.map((group) => teamBlock(group)) : [element('p', 'team-none', 'No other teams')]))
    const locked = state.players.filter((player) => entries.get(player.id)?.locked).length
    progress.textContent = `${locked} of ${state.players.length} locked in`
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
      card.picks.textContent = pickedBy.join(', ')
      card.picks.hidden = pickedBy.length === 0
      card.button.classList.toggle('is-taken', pickedBy.length > 0)
      card.button.title = pickedBy.length > 0 ? `${champions.get(championId)?.description ?? ''}\nPicked by ${pickedBy.join(', ')}` : champions.get(championId)?.description ?? ''
      const isSelected = championId === selectedId
      card.button.classList.toggle('is-selected', isSelected)
      card.button.setAttribute('aria-pressed', String(isSelected))
      card.button.disabled = localLocked
    }
    root.classList.toggle('is-locked', localLocked)

    const champion = selectedId === undefined ? undefined : champions.get(selectedId)
    if (champion && champion.id !== shownDetailsId) {
      renderDetails(champion)
      shownDetailsId = champion.id
    }
    renderTeams(state)
    stage?.start()

    lockButton.disabled = localLocked || selectedId === undefined
    lockButton.textContent = localLocked ? 'Locked in' : 'Lock in'
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
