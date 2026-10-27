// What the turrets and the cores have in common: they are structures. A structure stands where it was put, is solid, belongs to a team, and
// is hurt by **attacks only**: an ability does nothing to it (no damage, no health lost, no heal, no status, no marker, no push or pull),
// so it cannot be stunned, slowed, burnt or shoved, and what an ability would pass to it is ignored. (Each is a `Champion` underneath, so
// the same combat code plays it; see turrets.ts and cores.ts. The rule is the simulator's, in `applyWrites`.)
//
// A structure can also be **protected**, which is a stronger thing than being hurt by attacks only: it takes no damage at all, from
// anything, until what guards it is down. It can still shoot, and still be targeted by the page (which shows it as protected), but
// nothing it is hit by does anything:
//
// - a turret is protected while a turret of its own team of a lower tier is still standing: tier 2 can take no damage until the tier 1
//   turrets are down. (Tiers are chained, so with tiers 1, 2 and 3, the third has to wait for the second, which waits for the first;
//   and with a tier missing from a map the next one up still waits for every one below it.)
// - a core is protected while a turret of its own team is standing whose tier is no higher than its `guardedByTier` (cores.ts). With
//   the default of 1, that is the tier 1 turrets: the core can be hurt once they are down.
//
// "Down" is a structure with no health left, which stays down for the rest of the game: nothing that is destroyed comes back, so a
// structure is only ever protected for a while, and then not.

export type StructureRef = {
  id: number
  team: number
  // Set for a turret: its tier.
  turretTier?: number
  // Set for a core: the highest tier of turret of its team that has to be down before it can be hurt (0 for none).
  guardedByTier?: number
}

// The ids of the structures that are protected, given every structure in the game and which of them are still standing (one that is down is
// protected from nothing, so it is not in the set). It is a function of those alone, so the server and every client work out the same set
// from a frame.
export function shieldedStructures(
  structures: readonly StructureRef[],
  isStanding: (id: number) => boolean,
): Set<number> {
  const protectedIds = new Set<number>()
  const standingTurrets = structures.filter((structure) => structure.turretTier !== undefined && isStanding(structure.id))
  for (const structure of structures) {
    if (!isStanding(structure.id)) continue
    const sameTeam = standingTurrets.filter((turret) => turret.team === structure.team && turret.id !== structure.id)
    if (structure.turretTier !== undefined) {
      const tier = structure.turretTier
      if (sameTeam.some((turret) => (turret.turretTier as number) < tier)) protectedIds.add(structure.id)
    } else if (structure.guardedByTier !== undefined) {
      const guardedBy = structure.guardedByTier
      if (sameTeam.some((turret) => (turret.turretTier as number) <= guardedBy)) protectedIds.add(structure.id)
    }
  }
  return protectedIds
}
