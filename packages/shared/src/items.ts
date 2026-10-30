import type { ChampionStats } from './stats.js'

// Items: what a player buys with gold to make their champion stronger. A champion has eight slots, one for each kind of item, and carries at most one
// item in each: to buy another of that kind, the one in the slot has to be sold first. What an item does today is give its stats (flat amounts added
// to the champion's own, see `withItems`); an item is a plain record, so what it will do tomorrow (an effect when an attack lands, an ability) is a
// field added to `ItemDef` and read in the one place the rest of the game already asks what a character is carrying (`itemsOf` in the simulator).
//
// What a champion carries is in its frame (`GameFrameCharacter.items`), and so is its gold, because what it carries changes what a frame works out (its
// damage, its health, how fast it walks), so every peer has to have it on the same tick and an order that arrives late has to take it back with the
// rest of the frame. Buying and selling are orders, like moving and casting (`buy` and `sell`): the simulator does them on the tick of the order, with
// the gold and the slots as that frame has them, so the server and every client agree on what was bought, and a purchase that could not be made
// (it cost too much, the slot was full) is nothing on all of them.

export const ITEM_SLOTS = ['boots', 'chest', 'back', 'head', 'weapon', 'accessory', 'pet', 'potion'] as const
export type ItemSlot = (typeof ITEM_SLOTS)[number]

// What each slot is called, for the shop and the HUD.
export const ITEM_SLOT_NAMES: Readonly<Record<ItemSlot, string>> = {
  boots: 'Boots',
  chest: 'Chest',
  back: 'Back',
  head: 'Head',
  weapon: 'Weapon',
  accessory: 'Accessory',
  pet: 'Pet',
  potion: 'Potion',
}

// How much of what an item cost is paid back when it is sold: 0.7 is 70%. This is the one place to change it (the shop and the simulator both
// read it from here). The price is rounded down to a whole number of gold.
export const ITEM_SELL_RATE = 0.7

// What an item can add to a champion, each a flat amount to the stat of the same name (see stats.ts). The health is whole; attack speed is attacks a
// second; resistance and haste are as for a champion's; arcane is ability power, whole points of it
// (20 adds 20 to the amount that the abilities that scale with it are multiplied by their ratios: at a ratio of 0.5, 10 damage).
export const ITEM_STAT_KEYS = ['maxHp', 'attackDamage', 'attackSpeed', 'resistance', 'haste', 'arcane', 'attackRange', 'moveSpeed'] as const
export type ItemStat = (typeof ITEM_STAT_KEYS)[number]
export type ItemStats = Partial<Pick<ChampionStats, ItemStat>>

// What a slot holds: the id of the item in it. A slot that is not there has none.
export type Inventory = Partial<Record<ItemSlot, string>>

export interface ItemDef {
  id: string
  name: string
  slot: ItemSlot
  // What it costs, in whole gold, and what is given back for it is `sellValue`.
  cost: number
  // The picture in res/shop_icons it is drawn with (the file's name, without .png). Without it, the item's id is the file's name.
  icon?: string
  // What it adds to its carrier.
  stats?: ItemStats
}

export class Item {
  readonly id: string
  readonly name: string
  readonly slot: ItemSlot
  readonly cost: number
  readonly icon: string
  readonly stats: Readonly<ItemStats>

  constructor(def: ItemDef) {
    const fail = (problem: string): never => {
      throw new Error(`Item "${def.id}" ${problem}.`)
    }
    if (typeof def.id !== 'string' || def.id.trim() === '' || def.id.length > 64) throw new Error('An item needs an id of 1 to 64 characters.')
    if (typeof def.name !== 'string' || def.name.trim() === '') fail('needs a name')
    if (!ITEM_SLOTS.includes(def.slot)) fail(`needs a slot that is one of ${ITEM_SLOTS.join(', ')}`)
    if (!(Number.isInteger(def.cost) && def.cost > 0)) fail('needs a cost that is a whole number of gold, 1 or more')
    const stats: ItemStats = {}
    for (const [stat, amount] of Object.entries(def.stats ?? {})) {
      if (!(ITEM_STAT_KEYS as readonly string[]).includes(stat)) fail(`has a stat called ${stat}, which is not one of ${ITEM_STAT_KEYS.join(', ')}`)
      if (typeof amount !== 'number' || !Number.isFinite(amount)) fail(`needs a ${stat} that is a number`)
      stats[stat as ItemStat] = amount
    }
    if (stats.maxHp !== undefined && !Number.isInteger(stats.maxHp)) fail('needs a maxHp that is a whole number, as health is')
    this.id = def.id
    this.name = def.name
    this.slot = def.slot
    this.cost = def.cost
    this.icon = def.icon ?? def.id
    this.stats = stats
  }
}

// ---------------------------------------------------------------------------- the rules

// What selling an item pays: its cost times the sell rate, in whole gold, rounded down.
export function sellValue(item: Pick<Item, 'cost'>, rate: number = ITEM_SELL_RATE): number {
  return Math.max(0, Math.floor(item.cost * rate))
}

// Why this item cannot be bought by someone with this much gold and these items, if it cannot: in words, for the shop to say, or nothing if it can.
// It is the rule the simulator buys by, and the shop asks it before it sends an order, so the two agree.
export function buyProblem(item: Item | undefined, gold: number, inventory: Inventory, lookup: (id: string) => Item | undefined = getItem): string | undefined {
  if (!item) return 'There is no such item.'
  const held = inventory[item.slot]
  if (held !== undefined) {
    const name = lookup(held)?.name ?? held
    return `You already have ${name} in your ${ITEM_SLOT_NAMES[item.slot].toLowerCase()} slot: sell it first.`
  }
  if (gold < item.cost) return `You need ${item.cost - Math.max(0, Math.floor(gold))} more gold.`
  return undefined
}

// The stats of everything in an inventory added together. An id that is not an item adds nothing.
export function itemTotals(inventory: Inventory | undefined, lookup: (id: string) => Item | undefined = getItem): ItemStats {
  const totals: ItemStats = {}
  for (const slot of ITEM_SLOTS) {
    const id = inventory?.[slot]
    const item = id === undefined ? undefined : lookup(id)
    if (!item) continue
    for (const stat of ITEM_STAT_KEYS) {
      const amount = item.stats[stat]
      if (amount !== undefined) totals[stat] = (totals[stat] ?? 0) + amount
    }
  }
  return totals
}

// A champion's stats with what its items add to them.
export function withItems(stats: ChampionStats, inventory: Inventory | undefined, lookup?: (id: string) => Item | undefined): ChampionStats {
  const totals = itemTotals(inventory, lookup)
  return {
    ...stats,
    maxHp: Math.round(stats.maxHp + (totals.maxHp ?? 0)),
    attackDamage: stats.attackDamage + (totals.attackDamage ?? 0),
    attackSpeed: stats.attackSpeed + (totals.attackSpeed ?? 0),
    resistance: stats.resistance + (totals.resistance ?? 0),
    haste: stats.haste + (totals.haste ?? 0),
    arcane: stats.arcane + (totals.arcane ?? 0),
    attackRange: stats.attackRange + (totals.attackRange ?? 0),
    moveSpeed: stats.moveSpeed + (totals.moveSpeed ?? 0),
  }
}

// ---------------------------------------------------------------------------- the items in the game

// The items there are, to be tuned: the cost and stats here are filler, to try the shop with. An item is added by adding it to this list, with a
// picture in res/shop_icons (named for its `icon`, or its id). Some in each slot. (A pet and a potion are carried like the rest: what they add is
// their stats, for now.)
const ITEM_DEFS: readonly ItemDef[] = [
  // Boots
  { id: 'worn-boots', name: 'Worn Boots', slot: 'boots', cost: 30, icon: 'boots', stats: { moveSpeed: 8 } },
  { id: 'steel-boots', name: 'Steel Boots', slot: 'boots', cost: 60, stats: { moveSpeed: 12, resistance: 15 } },
  { id: 'rocket-boots', name: 'Rocket Boots', slot: 'boots', cost: 120, stats: { moveSpeed: 16, haste: 20 } },
  // Chest
  { id: 'leather-armor', name: 'Leather Armor', slot: 'chest', cost: 40, stats: { maxHp: 150, resistance: 8 } },
  { id: 'bronze-armor', name: 'Bronze Armor', slot: 'chest', cost: 80, stats: { maxHp: 300, resistance: 16 } },
  { id: 'mage-robe', name: 'Mage Robe', slot: 'chest', cost: 70, stats: { maxHp: 100, arcane: 20 } },
  { id: 'plate-armor', name: 'Plate Armor', slot: 'chest', cost: 140, stats: { maxHp: 400, resistance: 35 } },
  { id: 'ornate-mage-robes', name: 'Ornate Mage Robes', slot: 'chest', cost: 120, stats: { maxHp: 150, arcane: 45 } },
  // Back
  { id: 'cloak', name: 'Traveler\'s Cloak', slot: 'back', cost: 35, stats: { resistance: 12 } },
  { id: 'shield', name: 'Wooden Shield', slot: 'back', cost: 70, stats: { maxHp: 50, resistance: 10 } },
  { id: 'quiver', name: 'Quiver', slot: 'back', cost: 40, stats: { attackSpeed: 0.15, attackRange: 5 } },
  { id: 'wings', name: 'Gilded Wings', slot: 'back', cost: 80, stats: { moveSpeed: 8, haste: 6 } },
  { id: 'gilded-shield', name: 'Gilded Shield', slot: 'back', cost: 100, stats: { maxHp: 120, resistance: 18 } },
  { id: 'jetpack', name: 'Jetpack', slot: 'back', cost: 180, stats: { moveSpeed: 16 } },
  { id: 'reinforced-shield', name: 'Reinforced Shield', slot: 'back', cost: 200, stats: { maxHp: 200, resistance: 25 } },
  // Head
  { id: 'hard-hat', name: 'Hard Hat', slot: 'head', cost: 30, icon: 'hard_hat', stats: { maxHp: 100 } },             // After 5 seconds without taking damage gain a 50 health shield.
  { id: 'bronze-helmet', name: 'Bronze Helmet', slot: 'head', cost: 50, stats: { maxHp: 120, resistance: 8 } },      // 
  { id: 'hood', name: 'Dark Hood', slot: 'head', cost: 60, stats: { attackSpeed: .1, moveSpeed: 4 } },
  { id: 'viking-helm', name: 'Viking Helm', slot: 'head', cost: 60, stats: { maxHp: 250 } },
  { id: 'pirates-cap', name: 'Pirate\'s Cap', slot: 'head', cost: 120, icon: 'pirates_cap', stats: { attackDamage: 6, attackSpeed: .2 } },
  { id: 'mage-hat', name: 'Mage Hat', slot: 'head', cost: 60, stats: { arcane: 25, haste: 8 } },
  { id: 'plague-doctors-cowl', name: 'Plague Doctor\'s Cowl', slot: 'head', cost: 80, stats: { arcane: 20, resistance: 16 } },
  { id: 'plate-helm', name: 'Plate Helm', slot: 'head', cost: 150, stats: { maxHp: 300, resistance: 20 } },
  { id: 'golden-helmet', name: 'Golden Helmet', slot: 'head', cost: 500, stats: { maxHp: 500, resistance: 25 } },
  // Weapon
  { id: 'wand', name: 'Wand', slot: 'weapon', cost: 40, stats: { arcane: 25 } },                              // Abilities do 10% bonus damage
  { id: 'dagger', name: 'Quick Dagger', slot: 'weapon', cost: 40, stats: { attackSpeed: 0.1 } },              // Gain a 15% attack speed bonus
  { id: 'bow', name: 'Short Bow', slot: 'weapon', cost: 40, stats: { attackRange: 20 } },                     // Gain 10 attack range
  { id: 'sword', name: 'Iron Sword', slot: 'weapon', cost: 40, stats: { attackDamage: 5 } },                  // Attacks do 10% bonus damage
  { id: 'tome', name: 'Tome', slot: 'weapon', cost: 45, stats: { arcane: 10, haste:15 } },                    // Every 5 seconds gain a 1x arcane bonus damage applied on the next ability that does damage. 


  { id: 'jambiya', name: 'Jambiya', slot: 'weapon', cost: 80, stats: { attackSpeed: 0.25, attackDamage: 10 } }, // Gain 10% lifesteal on attacks
  { id: 'tonfa', name: 'Tonfa', slot: 'weapon', cost: 80, stats: { attackDamage: 16, haste: 10 } },             // Attacks do 
  { id: 'staff', name: 'Staff', slot: 'weapon', cost: 75, stats: { arcane: 40 } },                              // Attacks give 10% movement speed bonus.
  { id: 'mace', name: 'Mace', slot: 'weapon', cost: 90, stats: { attackDamage: 16, maxHp: 200 } },              // Attacks do 20% bonus damage
  { id: 'poisoned-dagger', name: 'Poisoned Dagger', slot: 'weapon', cost: 70, stats: { attackSpeed: 0.3, attackDamage: 18 } }, // Attacks apply a poison. Poison scales with .1 arcane 

  { id: 'light-staff', name: 'Staff of Light', slot: 'weapon', cost: 155, stats: { arcane: 40, haste: 15 } },     // Abilties do 30% bonus damage
  { id: 'nunchucks', name: 'Nunchucks', slot: 'weapon', cost: 160, stats: { attackDamage: 18, resistance: 16 } }, // Gain 30% attack speed bonus.
  { id: 'scythe', name: 'Scythe', slot: 'weapon', cost: 165, stats: { attackDamage: 36 } },                       // Gain 20% lifesteal on attacks.
  { id: 'crossbow', name: 'Crossbow', slot: 'weapon', cost: 170, stats: { attackRange: 25} },                     // Gain 25 attack range
  
  { id: 'hammer', name: 'War Hammer', slot: 'weapon', cost: 155, stats: { attackDamage: 24, maxHp: 120 } },       // Negate 30% of resists on attacks
  { id: 'battle-axe', name: 'Battle Axe', slot: 'weapon', cost: 160, stats: { attackDamage: 20, haste: 20 } },    // Attacks do 30% bonus damage
  { id: 'life-staff', name: 'Staff of Life', slot: 'weapon', cost: 160, stats: { arcane: 40, maxHp: 200 } },      // Gain 15% lifesteal on abilities.
  { id: 'dark-staff', name: 'Dark Staff', slot: 'weapon', cost: 160, stats: { arcane: 60 } },                     // Attacks gain a .6x arcane multiplier. so with 60ad and 80arcane you would do 60 + 48 = 108 damage on attack.


  { id: 'cursed-scythe', name: 'Cursed Scythe', slot: 'weapon', cost: 280, stats: { attackDamage: 50, arcane: 80 } }, // Gain 30% lifesteal on attacks
  { id: 'cursed-tome', name: 'Cursed Tome', slot: 'weapon', cost: 300, stats: { arcane: 120 } },                      // Gain 30% lifesteal on abilities.
  { id: 'holy-tome', name: 'Holy Tome', slot: 'weapon', cost: 290, stats: { arcane: 60, maxHp: 200 } },               // Abilities do 50% bonus damage
  { id: 'infused-dagger', name: 'Infused Dagger', slot: 'weapon', cost: 300, stats: { attackSpeed: 0.4, attackDamage: 24 } }, // Gain 30% attacks speed bonus and attacks do 6% current hp damage.
  { id: 'poisoned-crossbow', name: 'Poisoned Crossbow', slot: 'weapon', cost: 300, icon: 'poisoned_crossbow', stats: { attackDamage: 18, attackRange: 30, attackSpeed: 0.2 } }, // Gain 30 attack range and Attacks apply a poison. Poison scales with .1 arcane 
  { id: 'machine-gun', name: 'Machine Gun', slot: 'weapon', cost: 300, stats: { attackSpeed: 0.6, attackDamage: 8 } },// Gain 50% attack speed bonus
  { id: 'infused-axe', name: 'Infused Axe', slot: 'weapon', cost: 300, stats: { attackDamage: 38, haste: 38 } },      // Basic attacks do 60% bonus damage
  { id: 'infused-staff', name: 'Infused Staff', slot: 'weapon', cost: 300, stats: { arcane: 70, haste: 36 } },        // Negate 50% of resists on attack.
  { id: 'sniper', name: 'Sniper Rifle', slot: 'weapon', cost: 350, stats: { attackDamage: 24, attackRange: 40 } },    // Gain 40 attack range
  // Accessory
  { id: 'scroll', name: 'Scroll', slot: 'accessory', cost: 35, stats: { arcane: 12, haste: 4 } },
  { id: 'life-amulet', name: 'Life Amulet', slot: 'accessory', cost: 50, stats: { maxHp: 250 } },
  { id: 'haste-ring', name: 'Ring of Haste', slot: 'accessory', cost: 55, stats: { haste: 15 } },
  { id: 'prayer-beads', name: 'Prayer Beads', slot: 'accessory', cost: 55, stats: { maxHp: 150, haste: 5 } },
  { id: 'arcane-amulet', name: 'Arcane Amulet', slot: 'accessory', cost: 60, stats: { arcane: 25 } },
  { id: 'golden-beads', name: 'Golden Beads', slot: 'accessory', cost: 65, stats: { haste: 10, moveSpeed: 8 } },
  { id: 'clock', name: 'Pocket Clock', slot: 'accessory', cost: 70, stats: { haste: 20 } },
  { id: 'gauntlet', name: 'Gauntlet', slot: 'accessory', cost: 75, stats: { attackDamage: 10, resistance: 6 } },
  { id: 'law', name: 'Scales of Law', slot: 'accessory', cost: 100, stats: { resistance: 15, haste: 10 } },
  { id: 'legendary-amulet', name: 'Legendary Amulet', slot: 'accessory', cost: 150, stats: { arcane: 40, maxHp: 250, haste: 8 } },
  // Pet
  { id: 'sheep', name: 'Fluffy Sheep', slot: 'pet', cost: 30, stats: { maxHp: 100, moveSpeed: 8 } },
  { id: 'owl', name: 'Wise Owl', slot: 'pet', cost: 40, stats: { attackSpeed: 0.1, haste: 5 } },
  { id: 'plant', name: 'Snapping Plant', slot: 'pet', cost: 50, stats: { maxHp: 180 } },
  { id: 'imp', name: 'Imp', slot: 'pet', cost: 60, stats: { arcane: 18, moveSpeed: 10 } },
  { id: 'raven', name: 'Black Raven', slot: 'pet', cost: 65, stats: { attackDamage: 8, moveSpeed: 10 } },
  { id: 'golem', name: 'Stone Golem', slot: 'pet', cost: 90, stats: { maxHp: 300, resistance: 8 } },
  { id: 'demon', name: 'Demon', slot: 'pet', cost: 110, stats: { attackDamage: 14, arcane: 15 } },
  // Potion
  { id: 'health-potion', name: 'Health Potion', slot: 'potion', cost: 25, stats: { maxHp: 120 } },
  { id: 'mana-potion', name: 'Mana Potion', slot: 'potion', cost: 35, stats: { arcane: 10, haste: 6 } },
  { id: 'greater-health-potion', name: 'Greater Health Potion', slot: 'potion', cost: 45, stats: { maxHp: 250 } },
  { id: 'arcane-potion', name: 'Arcane Potion', slot: 'potion', cost: 50, stats: { arcane: 15, haste: 4 } },
  { id: 'growth-potion', name: 'Growth Potion', slot: 'potion', cost: 60, icon: 'growth_potion', stats: { attackDamage: 8, maxHp: 100 } },
  { id: 'legendary-potion', name: 'Legendary Potion', slot: 'potion', cost: 90, stats: { arcane: 30, attackDamage: 8, maxHp: 150 } },
]

export const items: ReadonlyMap<string, Item> = new Map(ITEM_DEFS.map((def) => {
  const item = new Item(def)
  return [item.id, item]
}))

export function getItem(id: string): Item | undefined {
  return items.get(id)
}

// Every item for a slot, cheapest first (and by name when they cost the same), or every item with no slot given.
export function itemsForSlot(slot?: ItemSlot): Item[] {
  return [...items.values()]
    .filter((item) => slot === undefined || item.slot === slot)
    .sort((left, right) => left.cost - right.cost || left.name.localeCompare(right.name))
}

export function isItemSlot(value: unknown): value is ItemSlot {
  return ITEM_SLOTS.includes(value as ItemSlot)
}
