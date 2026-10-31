import { getItem, ITEM_SLOTS, type ItemSlot } from '../../../../packages/shared/src/index.ts'
import { createAbilityIcon } from './ability-icon.ts'
import { itemIconUrl } from './item-icon-urls.ts'
import type { InspectView } from './inspect.ts'
import type { ItemTooltipController } from './item-tooltip.ts'
import { carriedTooltip } from './shop.ts'

export type InspectHandlers = {
  // The box that says what an item is when it is pointed at (the shop and the HUD's slots use the same one).
  tooltip: ItemTooltipController
  // The panel's own close button was pressed.
  onClose(): void
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: Node[]): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  made.className = className
  made.append(...children)
  return made
}

// The panel on the left that says who a left click picked (see `inspectView`): the name and level, how it stands, the stats that matter, and for a
// player what it carries, with the same box over an item as in the shop. A plain element over the canvas, hidden until there is someone to say; it
// takes the mouse, but only over itself, so the map under the rest of the screen is still clicked on.
export function createInspectView(container: HTMLElement, handlers: InspectHandlers) {
  const name = element('strong', 'inspect-name')
  const level = element('span', 'inspect-level')
  const close = element('button', 'inspect-close')
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', 'Stop looking at this one')
  close.addEventListener('click', () => {
    close.blur()
    handlers.onClose()
  })
  const subtitle = element('p', 'inspect-subtitle')
  const healthFill = element('div', 'inspect-health-fill')
  const healthShield = element('div', 'inspect-health-shield')
  const healthText = element('div', 'inspect-health-text')
  const health = element('div', 'inspect-health', healthFill, healthShield, healthText)
  const stats = element('dl', 'inspect-stats')

  // A cell for each slot, made once. What is in each is what the last update said, which the box over it asks for when it is pointed at.
  const carried: Partial<Record<ItemSlot, string>> = {}
  const cells = new Map<ItemSlot, HTMLElement>()
  for (const slot of ITEM_SLOTS) {
    const cell = element('div', 'inspect-item')
    handlers.tooltip.bind(cell, () => {
      const id = carried[slot]
      const item = id === undefined ? undefined : getItem(id)
      return item ? carriedTooltip(item) : undefined
    })
    cells.set(slot, cell)
  }
  const items = element('div', 'inspect-items', ...cells.values())
  items.setAttribute('aria-label', 'Items')

  const root = element('section', 'game-inspect', element('div', 'inspect-head', name, level, close), subtitle, health, stats, items)
  root.setAttribute('aria-label', 'The champion you are looking at')
  root.hidden = true
  container.appendChild(root)

  let shown = ''
  return {
    // Says who it is, or with none puts the panel away.
    update(view: InspectView | undefined): void {
      if (!view) {
        if (!root.hidden) {
          root.hidden = true
          shown = ''
          handlers.tooltip.hide()
        }
        return
      }
      root.hidden = false
      // Each frame says it again, so nothing is written unless it is different.
      const key = JSON.stringify(view)
      if (key === shown) return
      shown = key
      root.dataset.relation = view.relation
      name.textContent = view.name
      level.textContent = view.level ?? ''
      level.hidden = view.level === undefined
      subtitle.textContent = view.subtitle
      healthFill.style.width = `${view.health.healthPercent}%`
      healthShield.style.left = `${view.health.healthPercent}%`
      healthShield.style.width = `${view.health.shieldPercent}%`
      healthText.textContent = view.health.shield ? `${view.health.health}  ${view.health.shield}` : view.health.health
      stats.replaceChildren(...view.stats.map((row) => {
        const label = element('dt', 'inspect-stat-label')
        label.textContent = row.label
        const value = element('dd', 'inspect-stat-value')
        value.textContent = row.value
        return element('div', 'inspect-stat', label, value)
      }))
      items.hidden = view.items === undefined
      for (const cell of view.items ?? []) {
        const slotCell = cells.get(cell.slot)
        if (!slotCell) continue
        const item = cell.itemId === undefined ? undefined : getItem(cell.itemId)
        if (cell.itemId === undefined) delete carried[cell.slot]
        else carried[cell.slot] = cell.itemId
        slotCell.classList.toggle('is-filled', item !== undefined)
        slotCell.setAttribute('aria-label', item ? `${cell.slotName}: ${item.name}` : `${cell.slotName}: empty`)
        if (item) {
          slotCell.replaceChildren(element('span', 'inspect-item-icon', createAbilityIcon(item.icon, itemIconUrl)))
        } else {
          const empty = element('span', 'inspect-item-empty')
          empty.textContent = cell.slotName
          slotCell.replaceChildren(empty)
        }
      }
      // What a box that is up over an item says may have changed with it.
      handlers.tooltip.refresh()
    },
    destroy(): void {
      root.remove()
    },
  }
}
