import type { CastMode } from './cast-control.ts'
import { CLICK_RADIUS_STEP, MAX_CLICK_RADIUS } from './game-settings.ts'
import { EFFECT_KEYS, type EffectKey } from './render/effect-settings.ts'
import { element } from './ui/dom.ts'

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
  // A number from `min` to `max` in steps, shown as a slider with its value beside the name, and a line under it that says what it does.
  | {
    kind: 'slider'
    label: string
    description?: string
    min: number
    max: number
    step: number
    // What the number is counted in, shown after it.
    unit?: string
    get: () => number
    set: (value: number) => void
  }
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
//   Controls  how the game is played: the cast mode, and how easy enemies are to click on.
//   Dev       tools for whoever is working on the game: the debug view and the diagnostics, and the sprite tools (given only in a development build).
export function menuTabs(actions: {
  getCastMode: () => CastMode
  setCastMode: (mode: CastMode) => void
  // The extra reach round an enemy that a click still picks it from, in pixels.
  getClickRadius: () => number
  setClickRadius: (radius: number) => void
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
      }, {
        title: 'Targeting',
        items: [{
          kind: 'slider',
          label: 'Click radius',
          description: 'Extra reach round an enemy that a click still picks it, for attacks and targeted abilities.',
          min: 0,
          max: MAX_CLICK_RADIUS,
          step: CLICK_RADIUS_STEP,
          unit: 'px',
          get: actions.getClickRadius,
          set: actions.setClickRadius,
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
  const panel = element('div', 'game-menu-panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Game menu')
  const overlay = element('div', 'game-menu', panel)
  overlay.hidden = true
  container.append(overlay)

  let currentTab: string | undefined

  // A button of the menu. Each control carries a key that says which it is, so the one that has the keyboard still has it when the menu is drawn again.
  const button = (key: string, className: string, ...children: Array<Node | string>): HTMLButtonElement => {
    const made = element('button', className, ...children)
    made.type = 'button'
    made.dataset.menuKey = key
    return made
  }

  // A row of the menu.
  const row = (item: MenuItem, key: string, again: () => void): HTMLElement => {
    const made = element('div', 'game-menu-row')
    if (item.kind === 'choice') {
      made.append(element('span', '', item.label), element('div', 'game-menu-choices', ...item.options.map((option) => {
        const choice = button(`${key}/${option.value}`, '', option.label)
        const selected = option.value === item.get()
        choice.classList.toggle('is-selected', selected)
        choice.setAttribute('aria-pressed', String(selected))
        choice.addEventListener('click', () => {
          item.set(option.value)
          again()
        })
        return choice
      })))
    } else if (item.kind === 'toggle') {
      const on = item.get()
      const track = element('span', 'game-menu-switch')
      track.setAttribute('aria-hidden', 'true')
      const toggle = button(
        key,
        'game-menu-toggle',
        element('span', 'game-menu-toggle-text', element('span', '', item.label), ...(item.description ? [element('span', 'game-menu-description', item.description)] : [])),
        track,
      )
      toggle.setAttribute('role', 'switch')
      toggle.setAttribute('aria-checked', String(on))
      toggle.addEventListener('click', () => {
        item.set(!on)
        again()
      })
      made.append(toggle)
    } else if (item.kind === 'slider') {
      const shown = (value: number): string => `${value}${item.unit ? ` ${item.unit}` : ''}`
      const value = element('span', 'game-menu-slider-value', shown(item.get()))
      const input = element('input')
      input.type = 'range'
      input.min = String(item.min)
      input.max = String(item.max)
      input.step = String(item.step)
      input.value = String(item.get())
      input.dataset.menuKey = key
      input.setAttribute('aria-label', item.label)
      // Not drawn again as it moves: that would take the slider from under the hand that is dragging it.
      input.addEventListener('input', () => {
        item.set(Number(input.value))
        value.textContent = shown(item.get())
      })
      made.append(element('div', 'game-menu-slider-head', element('span', '', item.label), value), input)
      if (item.description) made.append(element('span', 'game-menu-description', item.description))
    } else {
      const action = button(key, '', item.label)
      action.classList.toggle('is-danger', item.danger === true)
      action.addEventListener('click', item.run)
      made.append(action)
    }
    return made
  }

  const render = (): void => {
    const active = document.activeElement
    const focused = active instanceof HTMLElement && panel.contains(active) ? active.dataset.menuKey : undefined
    const pages = tabs()
    const tab = pages.find((page) => page.id === currentTab) ?? pages[0]
    currentTab = tab?.id

    const strip = element('div', 'game-menu-tabs', ...pages.map((page) => {
      const tabButton = button(`tab:${page.id}`, '', page.label)
      const selected = page.id === tab?.id
      tabButton.setAttribute('role', 'tab')
      tabButton.classList.toggle('is-selected', selected)
      tabButton.setAttribute('aria-selected', String(selected))
      tabButton.addEventListener('click', () => {
        currentTab = page.id
        render()
      })
      return tabButton
    }))
    strip.setAttribute('role', 'tablist')

    const body = element('div', 'game-menu-page', ...(tab?.sections ?? []).map((section) => element(
      'div',
      'game-menu-section',
      ...(section.title ? [element('h4', '', section.title)] : []),
      ...section.items.map((item) => row(item, `${tab?.id}/${section.title ?? ''}/${item.label}`, render)),
    )))
    body.setAttribute('role', 'tabpanel')

    const bottom = footer().map((item) => row(item, `footer/${item.label}`, render))
    panel.replaceChildren(element('h3', '', 'Menu'), strip, body, ...bottom, element('p', 'game-menu-hint', 'Press Escape to close.'))

    if (focused !== undefined) {
      for (const control of panel.querySelectorAll<HTMLElement>('[data-menu-key]')) {
        if (control.dataset.menuKey === focused) {
          control.focus()
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
