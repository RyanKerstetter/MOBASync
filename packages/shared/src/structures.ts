// What the turrets have in common, the core of a base included, which is one: they are structures. A structure stands where it was put, is solid, belongs to a team, and
// is hurt by **attacks only**: an ability does nothing to it (no damage, no health lost, no heal, no status, no marker, no push or pull),
// so it cannot be stunned, slowed, burnt or shoved, and what an ability would pass to it is ignored. (Each is a `Champion` underneath, so
// the same combat code plays it; see turrets.ts. The rule is the simulator's, in `applyWrites`.)
//
// A structure can also be **protected**, which is a stronger thing than being hurt by attacks only: it takes no damage at all, from
// anything, until what guards it is down. It can still shoot, and still be targeted by the page (which shows it as protected), but
// nothing it is hit by does anything. There is one rule, and it is the same for a turret and for the core, which is only the highest tier:
// a structure is protected while a turret of its own team of a lower tier is still standing. Tier 2 can take no damage until the tier 1
// turrets are down, and the core (which is above them all, see `CORE_TIER` in turrets.ts) none until every turret is. (Tiers are
// chained, so with tiers 1, 2 and 3, the third has to wait for the second, which waits for the first; and with a tier missing from a map
// the next one up still waits for every one below it.) A core guards nothing: it is the end of the chain, and a core of a lower tier than a
// turret, as a test may make, does not protect that turret.
//
// "Down" is a structure with no health left, which stays down for the rest of the game: nothing that is destroyed comes back, so a
// structure is only ever protected for a while, and then not.
//
// Because only attacks hurt a structure, a champion whose strength is its arcane would do nothing to one. So an attack on a structure also
// deals damage for each point of its attacker's arcane (`STRUCTURE_ARCANE_DAMAGE`), on top of the attack's own damage.

// How much damage an attack on a structure does for each point of its attacker's arcane: 1 is a point of damage for each point of arcane.
// It is added to the attack's damage once for the whole attack, whatever else the attack does, and is hurt by the structure's resistance like
// the rest of it. Set it to 0 for an arcane that does nothing to structures.
export const STRUCTURE_ARCANE_DAMAGE = 1

export type StructureRef = {
  id: number
  team: number
  // Its tier: it is protected while a turret of its team of a lower tier stands.
  tier: number
  // Whether it is a core, which guards nothing.
  core: boolean
}

// The ids of the structures that are protected, given every structure in the game and which of them are still standing (one that is down is
// protected from nothing, so it is not in the set). It is a function of those alone, so the server and every client work out the same set
// from a frame.
export function shieldedStructures(
  structures: readonly StructureRef[],
  isStanding: (id: number) => boolean,
): Set<number> {
  const protectedIds = new Set<number>()
  // Only a turret guards: the core is the end of the chain.
  const guards = structures.filter((structure) => !structure.core && isStanding(structure.id))
  for (const structure of structures) {
    if (!isStanding(structure.id)) continue
    if (guards.some((guard) => guard.team === structure.team && guard.id !== structure.id && guard.tier < structure.tier)) protectedIds.add(structure.id)
  }
  return protectedIds
}
