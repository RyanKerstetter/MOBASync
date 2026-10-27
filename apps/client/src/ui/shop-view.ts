import { createAbilityIcon } from './ability-icon.ts'
import { generalIconUrl } from './general-icon-urls.ts'
import { itemIconUrl } from './item-icon-urls.ts'
import type { ItemTooltipController } from './item-tooltip.ts'
import {
  goldText,
  isGreyedOut,
  SHOP_FILTERS,
  shopEntries,
  shopFilterName,
  shopTooltip,
  type Loadout,
  type ShopEntry,
  type ShopFilter,
} from './shop.ts'

export type ShopHandlers = {
  // Buys an item. It gives the reason it was not (not enough gold, the slot is full) as words to show, or nothing when the order was sent.
  onBuy(itemId: string): string | undefined
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: Node[]): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  made.className = className
  made.append(...children)
  return made
}

function goldIcon(className: string): HTMLImageElement {
  const icon = element('img', className)
  icon.alt = ''
  const url = generalIconUrl('gold')
  if (url) icon.src = url
  else icon.hidden = true
  return icon
}

// How long a line about what was just bought, or why not, stays up.
const NOTICE_MS = 3000

type Cell = { root: HTMLButtonElement; tag: HTMLElement }

// The shop: a panel over the game, with a tab for each kind of item (and one for all of them), and a grid of the items there, each a picture with its
// price. Pointing at one says what it is (the name, the cost, what it adds); clicking it buys it. One that cannot be bought now is drawn grey, and can
// still be pointed at to read why. It is opened from the item slots and from the gold (`open`), so a slot opens it on that kind of item, and closed with
// its cross or Escape (`close`). The game goes on while it is open.
export function createShopView(container: HTMLElement, tooltip: ItemTooltipController, handlers: ShopHandlers) {
  const title = element('h2', 'shop-title')
  title.textContent = 'Shop'
  const goldAmount = element('span', 'shop-gold-amount')
  const close = element('button', 'shop-close')
  close.type = 'button'
  close.tabIndex = -1
  close.textContent = '×'
  close.setAttribute('aria-label', 'Close the shop')
  const head = element('header', 'shop-head', title, element('div', 'shop-gold', goldIcon('shop-gold-icon'), goldAmount), close)
  const tabs = element('nav', 'shop-tabs')
  tabs.setAttribute('aria-label', 'Kind of item')
  // Said while the player is away from their shop: the shop can be looked at from anywhere, but buying and selling are done in one.
  const away = element('p', 'shop-away')
  away.textContent = 'You are away from your shop. You can look around, but you can only buy and sell in it.'
  away.hidden = true
  const notice = element('p', 'shop-notice')
  notice.setAttribute('role', 'status')
  const grid = element('ul', 'shop-grid')
  grid.setAttribute('aria-label', 'Items for sale')
  const root = element('section', 'shop', head, tabs, away, notice, grid)
  root.hidden = true
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Shop')
  container.appendChild(root)

  // The kind being looked at: the first at the start, and then whichever was looked at last.
  let filter: ShopFilter = SHOP_FILTERS[0]
  let loadout: Loadout = { gold: 0, items: {} }
  let entries: ShopEntry[] = []
  let cells: Cell[] = []
  let noticeUntil = 0

  const tabButtons = new Map<ShopFilter, HTMLButtonElement>()
  for (const each of SHOP_FILTERS) {
    const button = element('button', 'shop-tab')
    button.type = 'button'
    button.tabIndex = -1
    button.textContent = shopFilterName(each)
    button.addEventListener('click', () => {
      setFilter(each)
      button.blur()
    })
    tabButtons.set(each, button)
    tabs.append(button)
  }

  const say = (text: string, tone: 'good' | 'bad' | undefined, now: number): void => {
    notice.textContent = text
    if (tone) notice.dataset.tone = tone
    else delete notice.dataset.tone
    noticeUntil = text === '' ? 0 : now + NOTICE_MS
  }

  // The grid is made again when the tab changes, and only worded again when the gold or the slots do.
  const paint = (): void => {
    entries = shopEntries(filter, loadout)
    entries.forEach((entry, index) => {
      const cell = cells[index]
      cell.root.className = `shop-item is-${entry.status}${isGreyedOut(entry.status) ? ' is-grey' : ''}`
      cell.root.setAttribute('aria-label', `${entry.item.name}, ${entry.item.cost} gold${entry.status === 'owned' ? ', you have it' : ''}`)
      cell.tag.textContent = entry.status === 'owned' ? 'Owned' : ''
      cell.tag.hidden = entry.status !== 'owned'
    })
    goldAmount.textContent = goldText(loadout.gold)
    away.hidden = loadout.inShop !== false
    tooltip.refresh()
  }

  const rebuild = (): void => {
    tooltip.hide()
    entries = shopEntries(filter, loadout)
    cells = entries.map((entry, index): Cell => {
      const price = element('span', 'shop-item-cost')
      price.append(goldIcon('shop-item-gold'), document.createTextNode(String(entry.item.cost)))
      const tag = element('span', 'shop-item-tag')
      const icon = element('span', 'shop-item-icon', createAbilityIcon(entry.item.icon, itemIconUrl))
      const button = element('button', 'shop-item', icon, price, tag)
      button.type = 'button'
      button.tabIndex = -1
      button.addEventListener('click', () => {
        const entryNow = entries[index]
        const problem = handlers.onBuy(entryNow.item.id)
        say(problem ?? `Bought ${entryNow.item.name}.`, problem ? 'bad' : 'good', performance.now())
        button.blur()
      })
      // What it says is worked out from the item as it stands when it is pointed at, so it is right after the gold has changed.
      tooltip.bind(button, () => (entries[index] ? shopTooltip(entries[index], loadout.inShop !== false) : undefined))
      return { root: button, tag }
    })
    grid.replaceChildren(...cells.map((cell) => element('li', 'shop-cell', cell.root)))
    for (const [each, button] of tabButtons) button.setAttribute('aria-pressed', String(each === filter))
    paint()
  }

  function setFilter(next: ShopFilter): void {
    filter = next
    rebuild()
  }

  close.addEventListener('click', () => {
    api.close()
    close.blur()
  })

  const api = {
    get isOpen(): boolean {
      return !root.hidden
    },
    // Opens the shop on this kind of item, or on the kind that was last looked at (the gold button says none).
    open(on: ShopFilter = filter): void {
      root.hidden = false
      setFilter(on)
    },
    // Opens it on this kind of item, or closes it if it is open on that already (or, with none said, if it is open at all): the second press of the
    // same button puts it away.
    toggle(on?: ShopFilter): void {
      if (!root.hidden && (on === undefined || filter === on)) api.close()
      else api.open(on)
    },
    close(): void {
      root.hidden = true
      tooltip.hide()
      say('', undefined, 0)
    },
    // What the player has now, each frame. While the shop is open the items are marked again from it, and a line about a purchase fades after a while.
    update(next: Loadout, now: number): void {
      const changed = JSON.stringify(next) !== JSON.stringify(loadout)
      loadout = next
      if (root.hidden) return
      if (changed) paint()
      if (noticeUntil !== 0 && now > noticeUntil) say('', undefined, now)
    },
    destroy(): void {
      root.remove()
    },
  }
  return api
}

export type ShopView = ReturnType<typeof createShopView>
