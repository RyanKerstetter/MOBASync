import type { CastMode } from './cast-control.ts'
import { EFFECT_KEYS, type EffectKey } from './render/effect-settings.ts'

// One row of the escape menu, as data. The menu is built from lists of these, so adding to it is
// adding an item to `menuTabs`, not new drawing code.
export type MenuItem =
  // One of a few options, shown as buttons with the current one lit.
  | {
    kind: 'choice'
    label: string
    options: ReadonlyArray<{ value: string; label: string }>
    get: () => string
    set: (value: string) => void
  }
  // On or off, shown as a switch, with a line under it that says what it does.
  | { kind: 'toggle'; label: string; description?: string; get: () => boolean; set: (on: boolean) => void }
  // Something that happens when it is pressed.
  | { kind: 'action'; label: string; danger?: boolean; run: () => void }

// A group of rows under a heading of its own, and a tab is a page of them.
export type MenuSection = { title?: string; items: MenuItem[] }
export type MenuTab = { id: string; label: string; sections: MenuSection[] }

export const CAST_MODE_LABELS: Readonly<Record<CastMode, string>> = {
  'quick-with-indicator': 'Quick cast with indicator',
  quick: 'Quick cast',
}

// What each effect is called in the graphics menu, and what it shows.
export const EFFECT_LABELS: Readonly<Record<EffectKey, { label: string; description: string }>> = {
  turretRanges: { label: 'Turret attack range', description: 'A ring round each turret and core that shows how far it shoots.' },
  selfAttackRange: { label: 'Your attack range', description: 'A ring round your champion that shows how far its attacks reach.' },
  shopGlow: { label: 'Shop glow', description: 'The green tint over each shop, where champions heal.' },
}

// What the tabs of the escape menu hold, left to right, and the rows in each. It is given what to do for each item rather than doing
// it, so it knows nothing of the game and can be tested on its own.
//   Graphics  what is drawn: the effects, each of which can be turned off on its own.
//   Controls  how the game is played: the cast mode.
//   Dev       tools for whoever is working on the game: the debug view and the diagnostics, and the sprite tools (given only in a development build).
export function menuTabs(actions: {
  getCastMode: () => CastMode
  setCastMode: (mode: CastMode) => void
  getEffect: (effect: EffectKey) => boolean
  setEffect: (effect: EffectKey, on: boolean) => void
  // The debug view (hitboxes, and everything seen), which the P key turns on and off as well.
  getDebugView: () => boolean
  setDebugView: (on: boolean) => void
  // The frame rate and network diagnostics at the top left.
  getDiagnostics: () => boolean
  setDiagnostics: (on: boolean) => void
  // Left out when not given: draw the champions from a folder of art picked from disk, or go back to the art the game came with.
  sprites?: { pickFolder: () => void; reset: () => void }
}): MenuTab[] {
  return [
    {
      id: 'graphics',
      label: 'Graphics',
      sections: [{
        title: 'Effects',
        items: EFFECT_KEYS.map((effect): MenuItem => ({
          kind: 'toggle',
          label: EFFECT_LABELS[effect].label,
          description: EFFECT_LABELS[effect].description,
          get: () => actions.getEffect(effect),
          set: (on) => actions.setEffect(effect, on),
        })),
      }],
    },
    {
      id: 'controls',
      label: 'Controls',
      sections: [{
        title: 'Casting',
        items: [{
          kind: 'choice',
          label: 'Cast mode',
          options: (Object.keys(CAST_MODE_LABELS) as CastMode[]).map((mode) => ({ value: mode, label: CAST_MODE_LABELS[mode] })),
          get: actions.getCastMode,
          set: (value) => actions.setCastMode(value as CastMode),
        }],
      }],
    },
    {
      id: 'dev',
      label: 'Dev',
      sections: [
        {
          title: 'Debug',
          items: [
            { kind: 'toggle', label: 'Debug view (P)', description: 'Outlines every hitbox and shows everything, fog included.', get: actions.getDebugView, set: actions.setDebugView },
            { kind: 'toggle', label: 'Diagnostics', description: 'The frame rate, ping and simulation clock at the top left.', get: actions.getDiagnostics, set: actions.setDiagnostics },
          ],
        },
        ...(actions.sprites
          ? [{
            title: 'Sprites',
            items: [
              { kind: 'action', label: 'Load sprites from folder…', run: actions.sprites.pickFolder } as const,
              { kind: 'action', label: 'Reset sprites', run: actions.sprites.reset } as const,
            ],
          }]
          : []),
      ],
    },
  ]
}

// What is under the tabs whichever one is open.
export function menuFooter(actions: {
  // Goes back to the lobby, leaving the game to the others.
  leaveGame: () => void
}): MenuItem[] {
  return [{ kind: 'action', label: 'Leave game', danger: true, run: actions.leaveGame }]
}

type GameMenuOptions = {
  container: HTMLElement
  tabs: () => MenuTab[]
  footer: () => MenuItem[]
}

// The escape menu: a panel over the game with a tab for each page of settings. It does not stop the game, which goes
// on behind it, so a player in a fight who opens it is still in the fight. It remembers the tab it was left on while the page is open.
export function createGameMenu({ container, tabs, footer }: GameMenuOptions) {
  const overlay = document.createElement('div')
  overlay.className = 'game-menu'
  overlay.hidden = true
  const panel = document.createElement('div')
  panel.className = 'game-menu-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Game menu')
  overlay.append(panel)
  container.append(overlay)

  let currentTab: string | undefined

  // A row of the menu. Each control carries a key that says which it is, so the one that has the keyboard still has it when the menu is drawn again.
  const row = (item: MenuItem, key: string, again: () => void): HTMLElement => {
    const element = document.createElement('div')
    element.className = 'game-menu-row'
    if (item.kind === 'choice') {
      const label = document.createElement('span')
      label.textContent = item.label
      const group = document.createElement('div')
      group.className = 'game-menu-choices'
      for (const option of item.options) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = option.label
        button.dataset.menuKey = `${key}/${option.value}`
        const selected = option.value === item.get()
        button.classList.toggle('is-selected', selected)
        button.setAttribute('aria-pressed', String(selected))
        button.addEventListener('click', () => {
          item.set(option.value)
          again()
        })
        group.append(button)
      }
      element.append(label, group)
    } else if (item.kind === 'toggle') {
      const on = item.get()
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'game-menu-toggle'
      button.dataset.menuKey = key
      button.setAttribute('role', 'switch')
      button.setAttribute('aria-checked', String(on))
      const text = document.createElement('span')
      text.className = 'game-menu-toggle-text'
      const label = document.createElement('span')
      label.textContent = item.label
      text.append(label)
      if (item.description) {
        const description = document.createElement('span')
        description.className = 'game-menu-description'
        description.textContent = item.description
        text.append(description)
      }
      const track = document.createElement('span')
      track.className = 'game-menu-switch'
      track.setAttribute('aria-hidden', 'true')
      button.append(text, track)
      button.addEventListener('click', () => {
        item.set(!on)
        again()
      })
      element.append(button)
    } else {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = item.label
      button.dataset.menuKey = key
      button.classList.toggle('is-danger', item.danger === true)
      button.addEventListener('click', item.run)
      element.append(button)
    }
    return element
  }

  const render = (): void => {
    const active = document.activeElement
    const focused = active instanceof HTMLElement && panel.contains(active) ? active.dataset.menuKey : undefined
    const pages = tabs()
    const tab = pages.find((page) => page.id === currentTab) ?? pages[0]
    currentTab = tab?.id

    const heading = document.createElement('h3')
    heading.textContent = 'Menu'

    const strip = document.createElement('div')
    strip.className = 'game-menu-tabs'
    strip.setAttribute('role', 'tablist')
    for (const page of pages) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = page.label
      button.dataset.menuKey = `tab:${page.id}`
      button.setAttribute('role', 'tab')
      const selected = page.id === tab?.id
      button.classList.toggle('is-selected', selected)
      button.setAttribute('aria-selected', String(selected))
      button.addEventListener('click', () => {
        currentTab = page.id
        render()
      })
      strip.append(button)
    }

    const body = document.createElement('div')
    body.className = 'game-menu-page'
    body.setAttribute('role', 'tabpanel')
    for (const section of tab?.sections ?? []) {
      const group = document.createElement('div')
      group.className = 'game-menu-section'
      if (section.title) {
        const title = document.createElement('h4')
        title.textContent = section.title
        group.append(title)
      }
      for (const item of section.items) group.append(row(item, `${tab?.id}/${section.title ?? ''}/${item.label}`, render))
      body.append(group)
    }

    const bottom = footer().map((item) => row(item, `footer/${item.label}`, render))
    const hint = document.createElement('p')
    hint.className = 'game-menu-hint'
    hint.textContent = 'Press Escape to close.'
    panel.replaceChildren(heading, strip, body, ...bottom, hint)

    if (focused !== undefined) {
      for (const element of panel.querySelectorAll<HTMLElement>('[data-menu-key]')) {
        if (element.dataset.menuKey === focused) {
          element.focus()
          break
        }
      }
    }
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
