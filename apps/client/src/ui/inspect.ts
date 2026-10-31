import { ITEM_SLOT_NAMES, ITEM_SLOTS, type ItemSlot } from '../../../../packages/shared/src/index.ts'
import type { Inspection } from '../game-state.ts'
import { healthReadout, MAX_HEALTH_LABEL, statRows, type HealthReadout, type StatRow } from './hud.ts'

// What the panel over a champion that has been clicked on says (see `getInspection`), as plain data: the screen (`inspect-view.ts`) draws it.

const RELATION_NAMES: Readonly<Record<Inspection['relation'], string>> = { you: 'You', ally: 'Ally', enemy: 'Enemy' }

// One of the slots of what a player carries: what is in it, if anything.
export type InspectItemCell = { slot: ItemSlot; slotName: string; itemId?: string }

export type InspectView = {
  name: string
  // Who it is to the local champion, and for a player the champion it is: "Swordsman · Enemy".
  subtitle: string
  relation: Inspection['relation']
  // "Lv 6", for one that has a level.
  level?: string
  health: HealthReadout
  // Its stats at its level, with what its items add to them, in the order of the stats panel. The health is not among them: it is `health`.
  stats: StatRow[]
  // What a player carries, a cell for each slot, in the order of the shop. Left out for what carries nothing, which has no slots to show.
  items?: InspectItemCell[]
}

export function inspectView(inspection: Inspection): InspectView {
  return {
    name: inspection.name,
    subtitle: [inspection.championName, RELATION_NAMES[inspection.relation]].filter((part) => part !== undefined).join(' · '),
    relation: inspection.relation,
    ...(inspection.level !== undefined ? { level: `Lv ${inspection.level}` } : {}),
    health: healthReadout(inspection.health),
    stats: statRows(inspection.stats).filter((row) => row.label !== MAX_HEALTH_LABEL),
    ...(inspection.items
      ? {
        items: ITEM_SLOTS.map((slot): InspectItemCell => ({
          slot,
          slotName: ITEM_SLOT_NAMES[slot],
          ...(inspection.items?.[slot] !== undefined ? { itemId: inspection.items[slot] as string } : {}),
        })),
      }
      : {}),
  }
}
