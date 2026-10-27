import { generalIconUrl } from './general-icon-urls.ts'
import type { ItemTooltip } from './shop.ts'

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: Node[]): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  made.className = className
  made.append(...children)
  return made
}

// The box that follows the pointer over an item, in the shop or in a slot, saying what it is (see `ItemTooltip`): its name, its slot, what it costs,
// what it adds, and a note. One box serves every item: `bind` ties an element to what to say when it is pointed at, and the box is
// moved to the pointer, kept inside the game, and written again when what it says changes while it is up (the gold running out under it, say).
// It takes no clicks, so it is never in the way of what it is over.
export function createItemTooltip(container: HTMLElement) {
  const name = element('span', 'item-tooltip-name')
  const slot = element('span', 'item-tooltip-slot')
  const costAmount = element('span', 'item-tooltip-cost-amount')
  const goldIcon = element('img', 'item-tooltip-gold')
  goldIcon.alt = ''
  const goldUrl = generalIconUrl('gold')
  if (goldUrl) goldIcon.src = goldUrl
  else goldIcon.hidden = true
  const cost = element('div', 'item-tooltip-cost', goldIcon, costAmount)
  const stats = element('ul', 'item-tooltip-stats')
  const note = element('p', 'item-tooltip-note')
  const root = element('div', 'item-tooltip', element('div', 'item-tooltip-head', name, slot), cost, stats, note)
  root.hidden = true
  root.setAttribute('role', 'tooltip')
  container.appendChild(root)

  let hovered: { getTip: () => ItemTooltip | undefined; x: number; y: number } | undefined
  let shown = ''

  const render = (tip: ItemTooltip): void => {
    name.textContent = tip.name
    slot.textContent = tip.slot
    cost.hidden = tip.cost === undefined
    costAmount.textContent = tip.cost === undefined ? '' : String(tip.cost)
    stats.replaceChildren(...tip.stats.map((line) => {
      const value = element('span', 'item-tooltip-stat-value')
      value.textContent = line.value
      const label = element('span', 'item-tooltip-stat-label')
      label.textContent = line.label
      return element('li', 'item-tooltip-stat', value, label)
    }))
    stats.hidden = tip.stats.length === 0
    note.textContent = tip.note ?? ''
    note.hidden = tip.note === undefined
    note.dataset.tone = tip.tone ?? 'muted'
  }

  // Beside the pointer, and if that would put it over the game's edge, on the other side of it.
  const place = (): void => {
    if (!hovered) return
    const bounds = container.getBoundingClientRect()
    const margin = 8
    const gap = 14
    let left = hovered.x - bounds.left + gap
    let top = hovered.y - bounds.top + gap
    if (left + root.offsetWidth > bounds.width - margin) left = hovered.x - bounds.left - root.offsetWidth - gap
    if (top + root.offsetHeight > bounds.height - margin) top = bounds.height - root.offsetHeight - margin
    root.style.left = `${Math.max(margin, left)}px`
    root.style.top = `${Math.max(margin, top)}px`
  }

  const hide = (): void => {
    hovered = undefined
    shown = ''
    root.hidden = true
  }

  const show = (): void => {
    if (!hovered) return
    const tip = hovered.getTip()
    if (!tip) {
      root.hidden = true
      return
    }
    const key = JSON.stringify(tip)
    if (key !== shown) {
      shown = key
      render(tip)
    }
    root.hidden = false
    place()
  }

  return {
    // Says what `getTip` gives while the pointer is over `target`. It can give nothing, and then there is no box.
    bind(target: HTMLElement, getTip: () => ItemTooltip | undefined): void {
      target.addEventListener('pointerenter', (event) => {
        hovered = { getTip, x: event.clientX, y: event.clientY }
        show()
      })
      target.addEventListener('pointermove', (event) => {
        if (!hovered || hovered.getTip !== getTip) return
        hovered.x = event.clientX
        hovered.y = event.clientY
        place()
      })
      target.addEventListener('pointerleave', () => {
        if (hovered?.getTip === getTip) hide()
      })
    },
    // Writes the box again from what it is saying now, for when that has changed under the pointer.
    refresh: show,
    hide,
    destroy(): void {
      root.remove()
    },
  }
}

export type ItemTooltipController = ReturnType<typeof createItemTooltip>
