import {
  getItem,
  ITEM_SLOT_NAMES,
  ITEM_SLOTS,
  type Inventory,
  type ItemSlot,
} from '../../../../packages/shared/src/index.ts'
import { createAbilityIcon } from './ability-icon.ts'
import { abilityIconUrl } from './ability-icon-urls.ts'
import { generalIconUrl } from './general-icon-urls.ts'
import { itemIconUrl } from './item-icon-urls.ts'
import type { ItemTooltipController } from './item-tooltip.ts'
import { emptySlotTooltip, ownedTooltip, type ShopFilter } from './shop.ts'
import {
  healthReadout,
  HUD_ITEM_COLUMNS,
  HUD_ITEM_ROWS,
  progressReadout,
  OUT_TEXT,
  respawnText,
  statRows,
  type AbilitySlotView,
  type PlayerStats,
} from './hud.ts'

export type HudInput = {
  dead: boolean
  // The controlled champion's health. Left out, the bar keeps what it last showed.
  health?: { hp: number; maxHp: number; shield: number }
  // Its level, experience, gold and shards (see `LocalProgress`). Left out, they keep what they last showed.
  progress?: Parameters<typeof progressReadout>[0]
  // The numbers it is made of, for the stats panel. Left out, the panel keeps what it last showed.
  stats?: PlayerStats
  // What it carries, by slot. Left out, the slots keep what they last showed.
  inventory?: Inventory
  // Whether it is in a shop, where it can sell (see shops.ts). Left out, it keeps what it last was.
  inShop?: boolean
  // Whether the game has an economy (levels, gold, items: see `modeHasEconomy`). Without, the two side panels, of the level and stats and of the items and
  // shops, are not shown, and the abilities and health stand alone. Left out, it is as it last was (with, to start).
  economy?: boolean
  // How long until the controlled champion is back, while it is dead.
  respawnSeconds?: number
  // The controlled champion is dead and will not come back (see `GameState.isLocalOutOfTheGame`).
  out?: boolean
  abilities: readonly AbilitySlotView[]
}

// What the HUD does when it is clicked: the item slots and the gold open the shop (on that kind of item, or on all of them), and a right click on an item
// sells it. `tooltip` is the box that says what is in a slot when it is pointed at.
export type HudHandlers = {
  tooltip: ItemTooltipController
  // Opens the shop on this kind of item, or with none said on the kind it was last on.
  onShop(filter?: ShopFilter): void
  onSell(slot: ItemSlot): void
}

type HudSlot = {
  root: HTMLElement
  // The picture of the ability on the key, swapped when the key's ability changes (a recast). It is
  // drawn twice: grey and dim underneath, and in full colour over it, cropped to how far the
  // cooldown has run, so the colour rises from the bottom as the ability comes back.
  icons: HTMLElement
  iconAbilityId?: string
  key: HTMLElement
  name: HTMLElement
  time: HTMLElement
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: Node[]): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  made.className = className
  made.append(...children)
  return made
}

// A little picture from res/general (the gold, the shard), drawn with hard edges. With no file for it there is no picture.
function currencyIcon(name: string): HTMLImageElement {
  const icon = element('img', 'hud-currency-icon')
  icon.alt = ''
  const url = generalIconUrl(name)
  if (url) icon.src = url
  else icon.hidden = true
  return icon
}

// A button of the shop panel: what it opens, and under that what you have to spend there. The keyboard does not stop on it, so a key pressed for the
// game is never taken by a button that was clicked.
function shopButton(label: string, currency: string): { root: HTMLButtonElement; amount: HTMLElement } {
  const amount = element('span', 'hud-shop-amount')
  const root = element('button', 'hud-shop-button', element('span', 'hud-shop-label'), element('span', 'hud-shop-have', currencyIcon(currency), amount))
  root.type = 'button'
  root.tabIndex = -1
  root.querySelector('.hud-shop-label')!.textContent = label
  return { root, amount }
}

// The bottom of the screen, three panels standing on its bottom edge. On the left, the level and the experience bar (which fills
// upward from the level) and the champion's stats. In the middle, a slot for each ability, whose icon is grey when it is cast
// and fills up with colour from the bottom as the cooldown runs, and under them the exact health with its shield. On the right,
// the grid of items and the two shops, with the gold and shards to spend in them. Plain elements over the canvas, hidden until
// the first update. The grid of items is a slot for each kind of item: clicking one opens the shop on that kind, and a right click on one with an
// item in it sells it. The gold opens the shop on everything. The shard shop is a mock-up still.
export function createHudView(container: HTMLElement, handlers?: HudHandlers) {
  const root = element('div', 'game-hud')
  root.setAttribute('aria-label', 'Your health and abilities, and in some modes your level, stats and items')
  root.hidden = true

  const xpFill = element('div', 'hud-xp-fill')
  const level = element('div', 'hud-level')
  level.setAttribute('aria-label', 'Level')
  const stats = element('dl', 'hud-stats')
  const statsPanel = element('section', 'hud-panel hud-side hud-stats-panel', element('div', 'hud-xp-column', element('div', 'hud-xp', xpFill), level), stats)
  statsPanel.setAttribute('aria-label', 'Level and stats')

  const healthFill = element('div', 'hud-health-fill')
  const healthShield = element('div', 'hud-health-shield')
  const healthText = element('div', 'hud-health-text')
  const health = element('div', 'hud-health', healthFill, healthShield, healthText)
  const abilities = element('div', 'hud-abilities')
  // The abilities are over the health.
  const mainPanel = element('section', 'hud-panel hud-main', abilities, health)

  const gold = shopButton('Shop', 'gold')
  gold.root.setAttribute('aria-label', 'Shop')
  const shards = shopButton('Shards', 'shard')
  shards.root.setAttribute('aria-label', 'Shard shop')
  gold.root.addEventListener('click', () => {
    handlers?.onShop()
    gold.root.blur()
  })
  // A slot for each kind of item, in the order of the grid. What is in each is what the last update said.
  let carried: Inventory = {}
  let shownCarried = ''
  let inShop = true
  const itemSlots = ITEM_SLOTS.map((slot) => {
    const button = element('button', 'hud-item')
    button.type = 'button'
    button.tabIndex = -1
    button.dataset.slot = slot
    button.addEventListener('click', () => {
      handlers?.onShop(slot)
      button.blur()
    })
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      if (carried[slot] !== undefined) handlers?.onSell(slot)
      handlers?.tooltip.hide()
    })
    handlers?.tooltip.bind(button, () => {
      const item = carried[slot] === undefined ? undefined : getItem(carried[slot] as string)
      return item ? ownedTooltip(item, inShop) : emptySlotTooltip(slot)
    })
    return { slot, button }
  })
  // What the grid has room for beyond the slots there are is empty cells, for slots to come.
  const spare = Array.from({ length: Math.max(0, HUD_ITEM_COLUMNS * HUD_ITEM_ROWS - ITEM_SLOTS.length) }, () => {
    const cell = element('div', 'hud-item is-spare')
    cell.setAttribute('aria-hidden', 'true')
    return cell
  })
  const items = element('div', 'hud-items', ...itemSlots.map((each) => each.button), ...spare)
  items.setAttribute('aria-label', 'Items')
  const shopPanel = element('section', 'hud-panel hud-side hud-shop-panel', items, element('div', 'hud-shop-buttons', gold.root, shards.root))
  shopPanel.setAttribute('aria-label', 'Items and shops')
  // The stylesheet sizes the panel and the grid from this, so the number of columns is said in one place.
  shopPanel.style.setProperty('--hud-columns', String(HUD_ITEM_COLUMNS))

  root.append(statsPanel, mainPanel, shopPanel)
  container.appendChild(root)
  const slots: HudSlot[] = []
  const statCells: Array<{ label: HTMLElement; value: HTMLElement }> = []

  return {
    update(input: HudInput): void {
      root.hidden = false
      root.classList.toggle('is-dead', input.dead)
      if (input.economy !== undefined) {
        statsPanel.hidden = !input.economy
        shopPanel.hidden = !input.economy
      }
      if (input.progress) {
        const readout = progressReadout(input.progress)
        level.textContent = readout.level
        // The bar fills upward from the level at its foot.
        xpFill.style.height = `${readout.xpPercent}%`
        gold.amount.textContent = readout.gold
        shards.amount.textContent = readout.shards
      }
      if (input.inShop !== undefined && input.inShop !== inShop) {
        inShop = input.inShop
        handlers?.tooltip.refresh()
      }
      if (input.inventory) {
        const key = JSON.stringify(input.inventory)
        if (key !== shownCarried) {
          shownCarried = key
          carried = input.inventory
          for (const { slot, button } of itemSlots) {
            const item = carried[slot] === undefined ? undefined : getItem(carried[slot] as string)
            button.classList.toggle('is-filled', item !== undefined)
            button.setAttribute('aria-label', item ? `${ITEM_SLOT_NAMES[slot]}: ${item.name}. Right-click to sell.` : `${ITEM_SLOT_NAMES[slot]}: empty. Click to shop.`)
            if (item) {
              button.replaceChildren(element('span', 'hud-item-icon', createAbilityIcon(item.icon, itemIconUrl)))
            } else {
              const label = element('span', 'hud-item-empty')
              label.textContent = ITEM_SLOT_NAMES[slot]
              button.replaceChildren(label)
            }
          }
          handlers?.tooltip.refresh()
        }
      }
      if (input.stats) {
        const rows = statRows(input.stats)
        while (statCells.length < rows.length) {
          const cell = { label: element('dt', 'hud-stat-label'), value: element('dd', 'hud-stat-value') }
          stats.append(element('div', 'hud-stat', cell.label, cell.value))
          statCells.push(cell)
        }
        rows.forEach((row, index) => {
          statCells[index].label.textContent = row.label
          statCells[index].value.textContent = row.value
        })
      }
      if (input.health) {
        const readout = healthReadout(input.health)
        healthFill.style.width = `${readout.healthPercent}%`
        healthShield.style.left = `${readout.healthPercent}%`
        healthShield.style.width = `${readout.shieldPercent}%`
        healthText.textContent = readout.shield ? `${readout.health}  ${readout.shield}` : readout.health
      }
      if (input.dead && input.out) healthText.textContent = OUT_TEXT
      else if (input.dead && input.respawnSeconds !== undefined) healthText.textContent = respawnText(input.respawnSeconds)
      while (slots.length < input.abilities.length) {
        const slot: HudSlot = {
          root: element('div', 'hud-slot'),
          icons: element('span', 'hud-slot-icons'),
          key: element('span', 'hud-slot-key'),
          name: element('span', 'hud-slot-name'),
          time: element('span', 'hud-slot-time'),
        }
        slot.root.append(slot.icons, slot.key, slot.name, slot.time)
        abilities.append(slot.root)
        slots.push(slot)
      }
      slots.forEach((slot, index) => {
        const view = input.abilities[index]
        slot.root.hidden = view === undefined
        if (!view) return
        if (slot.iconAbilityId !== view.abilityId) {
          const grey = createAbilityIcon(view.abilityId, abilityIconUrl)
          grey.classList.add('is-grey')
          const colour = createAbilityIcon(view.abilityId, abilityIconUrl)
          colour.classList.add('is-colour')
          slot.icons.replaceChildren(grey, colour)
          slot.iconAbilityId = view.abilityId
        }
        slot.root.classList.toggle('is-ready', view.ready)
        // 0 just cast to 1 ready; the stylesheet turns it into how much of the icon is in colour.
        slot.root.style.setProperty('--filled', String(view.filled))
        slot.key.textContent = view.key
        slot.name.textContent = view.abilityId
        slot.time.textContent = view.secondsLeft
      })
    },
    destroy(): void {
      root.remove()
    },
  }
}
