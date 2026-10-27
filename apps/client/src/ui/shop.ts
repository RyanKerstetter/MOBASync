import {
  buyProblem,
  ITEM_SLOT_NAMES,
  ITEM_SLOTS,
  ITEM_STAT_KEYS,
  itemsForSlot,
  NOT_IN_SHOP,
  sellValue,
  type Inventory,
  type Item,
  type ItemSlot,
  type ItemStat,
} from '../../../../packages/shared/src/index.ts'

// What the shop and the item slots show, as plain data: which items are listed, which of them can be bought, and the words of an item's tooltip. The
// screens (`shop-view.ts`, the item slots in `hud-view.ts`) draw it, and the rules it asks are the simulator's (`buyProblem`), so what a screen says
// can be bought is what the game will let be bought.

// What the shop lists: the items of one kind. The shop is sorted by kind, with a tab for each, in the order of the slots; there is no tab with everything.
export type ShopFilter = ItemSlot
export const SHOP_FILTERS: readonly ShopFilter[] = ITEM_SLOTS

export function shopFilterName(filter: ShopFilter): string {
  return ITEM_SLOT_NAMES[filter]
}

// What the player has to spend and carries, and whether it is in a shop (it can look at the shop from anywhere, but only buy and sell in one: see
// shops.ts), which is what the shop is drawn from. Left out, it is in one.
export type Loadout = { gold: number; items: Inventory; inShop?: boolean }

// How an item stands for whoever is looking at it: it can be bought (`available`), it costs more than they have (`unaffordable`), another item is
// in its slot and has to be sold first (`blocked`), or it is the item they carry (`owned`).
export type ShopStatus = 'available' | 'unaffordable' | 'blocked' | 'owned'
export type ShopEntry = { item: Item; status: ShopStatus; problem?: string }

// The items to list, with how each stands: the items of one kind, cheapest first.
export function shopEntries(filter: ShopFilter, loadout: Loadout): ShopEntry[] {
  return itemsForSlot(filter).map((item): ShopEntry => {
    if (loadout.items[item.slot] === item.id) return { item, status: 'owned' }
    const problem = buyProblem(item, loadout.gold, loadout.items)
    if (problem === undefined) return { item, status: 'available' }
    return { item, status: loadout.items[item.slot] !== undefined ? 'blocked' : 'unaffordable', problem }
  })
}

// An item that cannot be bought now is drawn grey, though it can still be pointed at to read.
export const isGreyedOut = (status: ShopStatus): boolean => status === 'unaffordable' || status === 'blocked'

// ---------------------------------------------------------------------------- the words

const STAT_LABELS: Readonly<Record<ItemStat, string>> = {
  maxHp: 'Health',
  attackDamage: 'Attack damage',
  attackSpeed: 'Attack speed',
  resistance: 'Resistance',
  haste: 'Haste',
  arcane: 'Arcane',
  attackRange: 'Attack range',
  moveSpeed: 'Move speed',
}

// "+300", "+0.15", "-5": the amount with its sign, whole when it is whole and to two places at most when it is not.
export function signedAmount(amount: number): string {
  const rounded = Math.round(Math.abs(amount) * 100) / 100
  return `${amount < 0 && rounded !== 0 ? '-' : '+'}${rounded}`
}

export type StatLine = { label: string; value: string }

// What an item adds, a line for each stat, in the order the stats are listed in everywhere else.
export function itemStatLines(item: Pick<Item, 'stats'>): StatLine[] {
  return ITEM_STAT_KEYS.flatMap((stat) => {
    const amount = item.stats[stat]
    return amount === undefined || amount === 0 ? [] : [{ label: STAT_LABELS[stat], value: signedAmount(amount) }]
  })
}

// What a tooltip says: the item's name and the slot it goes in, what it costs (or, for one you carry, nothing: it is yours), what it adds, a line about
// what it is, and a note about what clicking it does or why it cannot be bought.
export type ItemTooltip = {
  name: string
  slot: string
  cost?: number
  stats: StatLine[]
  note?: string
  tone?: 'good' | 'bad' | 'muted'
}

// An item in the shop: its name, cost and stats, and whether clicking it buys it (it does not away from a shop).
export function shopTooltip(entry: ShopEntry, inShop = true): ItemTooltip {
  const { item, status, problem } = entry
  const base = { name: item.name, slot: ITEM_SLOT_NAMES[item.slot], cost: item.cost, stats: itemStatLines(item) }
  switch (status) {
    case 'available':
      return inShop ? { ...base, note: 'Click to buy.', tone: 'good' } : { ...base, note: NOT_IN_SHOP, tone: 'bad' }
    case 'owned':
      return { ...base, note: 'You have this item. Right-click it in your slots to sell it.', tone: 'muted' }
    default:
      return { ...base, ...(problem ? { note: problem } : {}), tone: 'bad' }
  }
}

// An item in one of your slots: what it adds, and what selling it pays (in a shop: away from one it says so).
export function ownedTooltip(item: Item, inShop = true): ItemTooltip {
  return {
    name: item.name,
    slot: ITEM_SLOT_NAMES[item.slot],
    stats: itemStatLines(item),
    note: inShop
      ? `Right-click to sell for ${sellValue(item)} gold (it cost ${item.cost}).`
      : `In your shop you can sell it for ${sellValue(item)} gold (it cost ${item.cost}).`,
    tone: 'muted',
  }
}

// A slot with nothing in it.
export function emptySlotTooltip(slot: ItemSlot): ItemTooltip {
  return {
    name: `${ITEM_SLOT_NAMES[slot]} slot`,
    slot: ITEM_SLOT_NAMES[slot],
    stats: [],
    note: `Empty. Click to shop for ${ITEM_SLOT_NAMES[slot].toLowerCase()}.`,
    tone: 'muted',
  }
}

// How much gold is written: a whole number, never below nothing.
export function goldText(gold: number): string {
  return String(Math.max(0, Math.floor(Number.isFinite(gold) ? gold : 0)))
}
