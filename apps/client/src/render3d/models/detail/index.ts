import { aurel, ent, hammer, monk } from './brutes.ts'
import { capricorn, cursebearer, firemage, sage } from './casters.ts'
import type { DetailBuilder } from './kit.ts'
import { knight } from './knight.ts'
import { archer, grenadier, soldier } from './rangers.ts'
import { chainFighter, cloak, ninja, trinketmaster } from './rogues.ts'

// Every champion built in detail, by the name its look gives (see `Look.detail`).
export const DETAILS = {
  knight,
  cursebearer,
  capricorn,
  firemage,
  sage,
  archer,
  soldier,
  grenadier,
  ninja,
  cloak,
  chain: chainFighter,
  trinketmaster,
  hammer,
  monk,
  aurel,
  ent,
} satisfies Record<string, DetailBuilder>

export type DetailId = keyof typeof DETAILS
