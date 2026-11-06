import assert from 'node:assert/strict'
import test from 'node:test'
import { createGameMenu, frameRateLabel, menuFooter, menuTabs } from '../apps/client/src/game-menu.ts'
import { DEFAULT_ATTACK_MARKER_SIZE, DEFAULT_MAX_FPS, FRAME_RATE_OPTIONS, UNCAPPED_FPS } from '../apps/client/src/game-settings.ts'
import { DEFAULT_CAST_MODE } from '../apps/client/src/cast-control.ts'
import { DEFAULT_EFFECTS } from '../apps/client/src/render/effect-settings.ts'

// The escape menu as the page builds it, drawn into a stand-in for the browser's document: just enough of one to make the elements, nest them, and press the buttons. It shows
// what the menu is made of and that it works (the tabs down the left, Leave game under them, the page beside them); how it looks is the stylesheet's.

class FakeElement {
  readonly tagName: string
  className = ''
  children: Array<FakeElement | string> = []
  parent: FakeElement | undefined
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  hidden = false
  type = ''
  min = ''
  max = ''
  step = ''
  value = ''
  private readonly listeners = new Map<string, Array<() => void>>()

  constructor(tagName: string) {
    this.tagName = tagName
  }

  readonly classList = {
    toggle: (name: string, force?: boolean): boolean => {
      const names = this.className.split(/\s+/).filter(Boolean)
      const has = names.includes(name)
      const want = force ?? !has
      this.className = (want ? (has ? names : [...names, name]) : names.filter((each) => each !== name)).join(' ')
      return want
    },
    contains: (name: string): boolean => this.className.split(/\s+/).includes(name),
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node !== 'string') node.parent = this
      this.children.push(node)
    }
  }

  replaceChildren(...nodes: Array<FakeElement | string>): void {
    this.children = []
    this.append(...nodes)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name)
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  click(): void {
    this.fire('click')
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }

  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
  }

  contains(node: FakeElement): boolean {
    return node === this || this.elements().includes(node)
  }

  focus(): void {
    ;(globalThis as { document: { activeElement: FakeElement | null } }).document.activeElement = this
  }

  querySelectorAll(selector: string): FakeElement[] {
    assert.equal(selector, '[data-menu-key]', 'the only thing the menu looks for')
    return this.elements().filter((each) => each.dataset.menuKey !== undefined)
  }

  // Every element under this one, in the order they are drawn.
  elements(): FakeElement[] {
    return this.children.flatMap((child) => (typeof child === 'string' ? [] : [child, ...child.elements()]))
  }

  get textContent(): string {
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('')
  }
}

const fakeDocument = {
  activeElement: null as FakeElement | null,
  createElement: (tag: string): FakeElement => new FakeElement(tag),
}
Object.assign(globalThis, { document: fakeDocument, HTMLElement: FakeElement })

const named = (root: FakeElement, className: string): FakeElement[] => root.elements().filter((each) => each.classList.contains(className))
const only = (root: FakeElement, className: string): FakeElement => {
  const found = named(root, className)
  assert.equal(found.length, 1, `one ${className}`)
  return found[0]
}
const labelled = (root: FakeElement, text: string): FakeElement => {
  const found = root.elements().filter((each) => each.tagName === 'button' && each.textContent === text)
  assert.ok(found.length >= 1, `a button called ${text}`)
  return found[0]
}

// A menu over the same kind of state the data tests use, and what it has been asked to do.
function openMenu() {
  const state = { castMode: DEFAULT_CAST_MODE, clickRadius: 10, walkKeepsAuto: false, walkKeepsCast: true, movementKeys: false, castKeepsAttack: true, attackMarkerSize: DEFAULT_ATTACK_MARKER_SIZE, effects: { ...DEFAULT_EFFECTS }, maxFps: DEFAULT_MAX_FPS, debugView: false, diagnostics: true, left: 0 }
  const container = new FakeElement('div')
  const menu = createGameMenu({
    container: container as unknown as HTMLElement,
    tabs: () => menuTabs({
      getCastMode: () => state.castMode,
      setCastMode: (mode) => { state.castMode = mode },
      getClickRadius: () => state.clickRadius,
      setClickRadius: (radius) => { state.clickRadius = radius },
      getWalkKeepsAuto: () => state.walkKeepsAuto,
      setWalkKeepsAuto: (on) => { state.walkKeepsAuto = on },
      getWalkKeepsCast: () => state.walkKeepsCast,
      setWalkKeepsCast: (on) => { state.walkKeepsCast = on },
      getMovementKeys: () => state.movementKeys,
      setMovementKeys: (on) => { state.movementKeys = on },
      getCastKeepsAttack: () => state.castKeepsAttack,
      setCastKeepsAttack: (on) => { state.castKeepsAttack = on },
      getAttackMarkerSize: () => state.attackMarkerSize,
      setAttackMarkerSize: (size) => { state.attackMarkerSize = size },
      getEffect: (effect) => state.effects[effect],
      setEffect: (effect, on) => { state.effects[effect] = on },
      getMaxFps: () => state.maxFps,
      setMaxFps: (fps) => { state.maxFps = fps },
      getDebugView: () => state.debugView,
      setDebugView: (on) => { state.debugView = on },
      getDiagnostics: () => state.diagnostics,
      setDiagnostics: (on) => { state.diagnostics = on },
    }),
    footer: () => menuFooter({ leaveGame: () => { state.left += 1 } }),
  })
  menu.open()
  const overlay = container.children[0] as FakeElement
  const panel = only(overlay, 'game-menu-panel')
  return { state, menu, panel, container }
}

test('the tabs are a column down the left of the menu, with Leave game under them, and the page is beside them', () => {
  const { panel } = openMenu()
  const layout = only(panel, 'game-menu-layout')
  assert.deepEqual((layout.children as FakeElement[]).map((child) => child.className), ['game-menu-side', 'game-menu-page'], 'the side first (the left), and then the page')
  const side = only(panel, 'game-menu-side')
  assert.deepEqual((side.children as FakeElement[]).map((child) => child.className), ['game-menu-tabs', 'game-menu-footer'], 'the tabs, and Leave game right under them')

  const tabs = only(side, 'game-menu-tabs')
  assert.equal(tabs.getAttribute('role'), 'tablist')
  assert.equal(tabs.getAttribute('aria-orientation'), 'vertical', 'a vertical list, to a screen reader as well')
  const buttons = tabs.children as FakeElement[]
  assert.deepEqual(buttons.map((tab) => tab.textContent), ['Graphics', 'Controls', 'Dev'])
  assert.ok(buttons.every((tab) => tab.getAttribute('role') === 'tab'))
  assert.deepEqual(buttons.map((tab) => tab.getAttribute('aria-selected')), ['true', 'false', 'false'], 'the first is open')

  const footer = only(side, 'game-menu-footer')
  assert.equal(footer.textContent, 'Leave game')
  assert.equal(only(layout, 'game-menu-page').getAttribute('role'), 'tabpanel')
  assert.equal(panel.elements().filter((each) => each.className === 'game-menu-tabs').length, 1, 'and the tabs are not also along the top')
  assert.equal(panel.children.length, 3, 'a heading, the layout and the hint, and nothing else under it')
})

test('pressing a tab opens its page beside the tabs, which stay where they are with Leave game under them', () => {
  const { panel } = openMenu()
  const sideBefore = only(panel, 'game-menu-side')
  assert.equal(only(panel, 'game-menu-page').textContent.includes('Frame rate'), true, 'the graphics page to begin with')

  labelled(panel, 'Controls').click()
  const layout = only(panel, 'game-menu-layout')
  assert.deepEqual((layout.children as FakeElement[]).map((child) => child.className), ['game-menu-side', 'game-menu-page'], 'the same two columns')
  const page = only(panel, 'game-menu-page').textContent
  assert.ok(page.includes('Cast mode') && page.includes('Click radius'), 'the controls are the page')
  assert.equal(page.includes('Frame rate'), false, 'and the graphics are not')
  assert.deepEqual((only(panel, 'game-menu-tabs').children as FakeElement[]).map((tab) => tab.getAttribute('aria-selected')), ['false', 'true', 'false'], 'Controls is lit')
  assert.equal(only(panel, 'game-menu-footer').textContent, 'Leave game', 'Leave game is still under the tabs')
  assert.notEqual(only(panel, 'game-menu-side'), sideBefore, 'the menu is drawn again')

  labelled(panel, 'Dev').click()
  assert.ok(only(panel, 'game-menu-page').textContent.includes('Diagnostics'))
  assert.equal(only(panel, 'game-menu-footer').textContent, 'Leave game')
})

test('Leave game runs what it was given from whichever tab is open', () => {
  const { panel, state } = openMenu()
  labelled(panel, 'Leave game').click()
  labelled(panel, 'Dev').click()
  labelled(panel, 'Leave game').click()
  assert.equal(state.left, 2)
})

const dropdownOf = (panel: FakeElement): FakeElement => {
  const found = only(panel, 'game-menu-page').elements().filter((each) => each.tagName === 'select')
  assert.equal(found.length, 1, 'one dropdown on the page')
  return found[0]
}

test('the frame rate is a dropdown on the Graphics page with an option for every rate, uncapped selected to begin with, and says what it does', () => {
  const { panel } = openMenu()
  const page = only(panel, 'game-menu-page')
  const select = dropdownOf(panel)
  const options = select.children as FakeElement[]
  assert.deepEqual(options.map((option) => option.textContent), FRAME_RATE_OPTIONS.map(frameRateLabel))
  assert.deepEqual(options.map((option) => option.value), FRAME_RATE_OPTIONS.map(String), 'with the rate as the value of each')
  assert.equal(select.value, String(UNCAPPED_FPS), 'uncapped is selected')
  assert.equal(select.getAttribute('aria-label'), 'Frame rate limit')
  assert.equal(page.elements().some((each) => each.tagName === 'button' && each.textContent === '144 fps'), false, 'and the rates are not a row of buttons that takes the room of them all')
  assert.ok(page.textContent.includes('How often the world is drawn'), 'with a line under it on what it does')
})

test('choosing a frame rate from the dropdown sets it, and the menu shows that one', () => {
  const { panel, state } = openMenu()
  for (const fps of [144, 30, UNCAPPED_FPS]) {
    const select = dropdownOf(panel)
    select.value = String(fps)
    select.fire('change')
    assert.equal(state.maxFps, fps)
    assert.equal(dropdownOf(panel).value, String(fps), 'the menu is drawn again with it selected')
  }
})

test('the dropdown keeps the keyboard when the menu is drawn again by choosing from it', () => {
  const { panel } = openMenu()
  const select = dropdownOf(panel)
  select.focus()
  select.value = '90'
  select.fire('change')
  assert.equal(fakeDocument.activeElement, dropdownOf(panel), 'the same dropdown, in the menu as it is now')
  assert.equal(dropdownOf(panel).value, '90')
})

test('the menu starts closed, opens and closes, and a menu that is destroyed is gone', () => {
  const container = new FakeElement('div')
  const menu = createGameMenu({ container: container as unknown as HTMLElement, tabs: () => [{ id: 'one', label: 'One', sections: [] }], footer: () => [] })
  const overlay = container.children[0] as FakeElement
  assert.equal(menu.isOpen, false)
  menu.open()
  assert.equal(menu.isOpen, true)
  assert.equal(only(overlay, 'game-menu-side').children.length, 1, 'with nothing to go under the tabs there is no footer')
  menu.toggle()
  assert.equal(menu.isOpen, false)
  menu.destroy()
  assert.equal(container.children.length, 0)
})
