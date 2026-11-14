import { GAME_TPS } from './constants.js'
import { distanceBetween } from './geometry.js'
import type { Vector2 } from './index.js'

// Healing zones: what the map's turrets and cores are when the lobby turns them on (`LobbyRules.healingZones`), in place of towers that shoot. A zone is still
// a structure (see structures.ts): it stands where the map puts it, belongs to a team, is solid, has health, is hurt by attacks only, is protected by the zones of
// lower tiers of its team as a turret is by the turrets, gives its team sight, and is destroyed for good. It never attacks. Instead, every living player of its
// team whose middle is within its `reach` is:
//
// - **healed** a flat amount, `healPerSecond`, in a pulse every `HEALING_ZONE_PULSE_TICKS` (whatever the champion's maximum health is); and
// - **shielded**: the moment it walks in it gets a shield of `shield` for `shieldTicks`, and its shield timer starts then. While it stays in a zone it gets another
//   every `shieldEveryTicks` after the last, which takes the old one's place (shields from zones do not stack). The timer is the player's own and runs on when it walks
//   out, so stepping out and back in does not give a shield sooner (it is a marker on the player, `HEALING_ZONE_SHIELD_KEY`, in the frame like any marker).
//
// The core of a base is a zone too, the one of the core tier, and it is still the core: when it falls its team cannot respawn, in Core Destruction. With zones on, the
// shops do not heal: the core is what heals a base. A player in more than one zone of its team is healed and shielded by one of them, the one that heals the most.
//
// Every number of a zone is in its tier's entry in `HEALING_ZONE_TIERS` (turrets.ts), beside the turrets, to tune.

export interface HealingZoneDef {
  // How far it reaches from its middle: a player whose middle is this near (or nearer) is in it. The page draws the zone out to here.
  reach: number
  // How much health it gives each player of its team in it in a second, whatever their maximum, in pulses (see `HEALING_ZONE_PULSE_TICKS`).
  healPerSecond: number
  // The shield it gives a player of its team in it, in health.
  shield: number
  // How long after a player's last shield from a zone it can get the next.
  shieldEveryTicks: number
  // How long a shield lasts, if nothing breaks it first.
  shieldTicks: number
}

// How often a zone heals: four times a second, as the shop does.
export const HEALING_ZONE_PULSE_TICKS = GAME_TPS / 4

// The marker a zone's shield leaves on a player, for as long as it has to wait for the next: no zone shields it while it carries one. It is not drawn.
export const HEALING_ZONE_SHIELD_KEY = 'zone-shield'

// How much health one pulse of a zone gives, in whole points: its heal a second, over the pulses in a second.
export function zoneHealPerPulse(zone: Pick<HealingZoneDef, 'healPerSecond'>): number {
  return Math.max(0, Math.round(zone.healPerSecond * HEALING_ZONE_PULSE_TICKS / GAME_TPS))
}

// Whether a zone heals on this tick.
export function zoneHealsOn(tick: number): boolean {
  return tick % HEALING_ZONE_PULSE_TICKS === 0
}

// Whether a point is in a zone that stands at `center`: within its reach, the edge included.
export function zoneReaches(center: Vector2, zone: Pick<HealingZoneDef, 'reach'>, point: Vector2): boolean {
  return distanceBetween(center, point) <= zone.reach
}

// Of the zones a player stands in, the one that heals and shields it: the one that heals the most, then the one that shields the most, then the first (the lowest id).
export function strongestZone<T extends { id: number; zone: HealingZoneDef }>(zones: readonly T[]): T | undefined {
  let best: T | undefined
  for (const each of [...zones].sort((left, right) => left.id - right.id)) {
    if (!best || each.zone.healPerSecond > best.zone.healPerSecond || (each.zone.healPerSecond === best.zone.healPerSecond && each.zone.shield > best.zone.shield)) best = each
  }
  return best
}

// What is wrong with a zone's numbers, if anything, to refuse it with.
export function healingZoneProblem(zone: HealingZoneDef): string | undefined {
  if (!(Number.isFinite(zone.reach) && zone.reach > 0)) return 'needs a reach that is more than 0'
  if (!(Number.isFinite(zone.healPerSecond) && zone.healPerSecond >= 0)) return 'needs a heal a second that is 0 or more'
  if (!(Number.isInteger(zone.shield) && zone.shield >= 0)) return 'needs a shield that is a whole number, 0 or more'
  if (!(Number.isInteger(zone.shieldEveryTicks) && zone.shieldEveryTicks > 0)) return 'needs a time between shields that is a whole number of ticks, more than 0'
  if (!(Number.isInteger(zone.shieldTicks) && zone.shieldTicks > 0)) return 'needs a shield that lasts a whole number of ticks, more than 0'
  return undefined
}
