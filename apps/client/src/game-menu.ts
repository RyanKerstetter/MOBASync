import type { CastMode } from './cast-control.ts'

// One row of the escape menu, as data. The menu is built from a list of these, so adding to it is
// adding an item to `menuItems`, not new drawing code.
export type MenuItem =
  // One of a few options, shown as buttons with the current one lit.
  | {
    kind: 'choice'
    label: string
    options: ReadonlyArray<{ value: string; label: string }>
    get: () => string
    set: (value: string) => void
  }
  // Something that happens when it is pressed.
  | { kind: 'action'; label: string; danger?: boolean; run: () => void }

export const CAST_MODE_LABELS: Readonly<Record<CastMode, string>> = {
  'quick-with-indicator': 'Quick cast with indicator',
  quick: 'Quick cast',
}

// What the escape menu holds, top to bottom. It is given what to do for each item rather than doing
// it, so it knows nothing of the game and can be tested on its own.
export function menuItems(actions: {
  getCastMode: () => CastMode
  setCastMode: (mode: CastMode) => void
  // Goes back to the lobby, leaving the game to the others.
  leaveGame: () => void
  // A dev tool, left out when not given: draw the champions from a folder of art picked from disk, or
  // go back to the art the game came with.
  sprites?: { pickFolder: () => void; reset: () => void }
}): MenuItem[] {
  return [
    {
      kind: 'choice',
      label: 'Cast mode',
      options: (Object.keys(CAST_MODE_LABELS) as CastMode[]).map((mode) => ({ value: mode, label: CAST_MODE_LABELS[mode] })),
      get: actions.getCastMode,
      set: (value) => actions.setCastMode(value as CastMode),
    },
    ...(actions.sprites
      ? [
        { kind: 'action', label: 'Dev: load sprites from folder…', run: actions.sprites.pickFolder } as const,
        { kind: 'action', label: 'Dev: reset sprites', run: actions.sprites.reset } as const,
      ]
      : []),
    { kind: 'action', label: 'Leave game', danger: true, run: actions.leaveGame },
  ]
}

type GameMenuOptions = {
  container: HTMLElement
  items: () => MenuItem[]
}

// The escape menu: a panel over the game that lists its items. It does not stop the game, which goes
// on behind it, so a player in a fight who opens it is still in the fight.
export function createGameMenu({ container, items }: GameMenuOptions) {
  const overlay = document.createElement('div')
  overlay.className = 'game-menu'
  overlay.hidden = true
  const panel = document.createElement('div')
  panel.className = 'game-menu-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Game menu')
  overlay.append(panel)
  container.append(overlay)

  const render = (): void => {
    const heading = document.createElement('h3')
    heading.textContent = 'Menu'
    const rows = items().map((item) => {
      const row = document.createElement('div')
      row.className = 'game-menu-row'
      if (item.kind === 'choice') {
        const label = document.createElement('span')
        label.textContent = item.label
        const group = document.createElement('div')
        group.className = 'game-menu-choices'
        for (const option of item.options) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = option.label
          const selected = option.value === item.get()
          button.classList.toggle('is-selected', selected)
          button.setAttribute('aria-pressed', String(selected))
          button.addEventListener('click', () => {
            item.set(option.value)
            render()
          })
          group.append(button)
        }
        row.append(label, group)
      } else {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = item.label
        button.classList.toggle('is-danger', item.danger === true)
        button.addEventListener('click', item.run)
        row.append(button)
      }
      return row
    })
    const hint = document.createElement('p')
    hint.className = 'game-menu-hint'
    hint.textContent = 'Press Escape to close.'
    panel.replaceChildren(heading, ...rows, hint)
  }

  return {
    get isOpen(): boolean {
      return !overlay.hidden
    },
    open(): void {
      render()
      overlay.hidden = false
    },
    close(): void {
      overlay.hidden = true
    },
    toggle(): void {
      if (overlay.hidden) this.open()
      else this.close()
    },
    destroy(): void {
      overlay.remove()
    },
  }
}
