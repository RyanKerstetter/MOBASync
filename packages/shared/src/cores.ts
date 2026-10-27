import { Champion, champions } from './champions.js'
import { DEFAULT_CORE_REWARD, type Resources } from './progression.js'

// Cores: the structure at the heart of a team's base, which decides who wins in Core Destruction (see modes.ts). Break the enemy's, and
// its team can no longer respawn: take down every one of its players and the game is won. A core is a champion that cannot move or
// attack (health, a size: the simulator treats it as one, so enemies can target it and kill it), plus the rules every structure has
// (structures.ts): it is hurt by attacks only, never by an ability, cannot be stunned or given a status, does not move for anyone, and
// never comes back once it is destroyed.
//
// Everything that makes it what it is, to be tuned, is `CORE` below. It is protected until the turrets that guard it are down:
// `guardedByTier` is the highest tier of its team's turrets that must be broken first, so with the default of 1 the core can be hurt once
// the tier 1 turrets are down, whatever the tiers above them (structures.ts).
//
// A map puts one in for each of the first two slots of spawn points, with a `core` point (see map-layout.ts). It is in the game only
// when the mode is Core Destruction.

export interface CoreDef {
  // Its health, and its resistance (`x / (100 + x)` off every hit it takes, see stats.ts), which it can leave out for none.
  maxHp: number
  resistance?: number
  // How big it is, to hit and to walk into: it is solid, and does not move for anyone.
  radius: number
  // The highest tier of turret of its team that has to be down before it can be hurt: 0 for none (it is never protected), 1 for the tier
  // 1 turrets, 2 for those and the tier 2 turrets as well, and so on.
  guardedByTier: number
  // What the player who breaks it is paid (see progression.ts). Whatever it leaves out is `DEFAULT_CORE_REWARD`.
  reward?: Partial<Resources>
}

export class Core {
  // The id of its body, which is what a snapshot says it is.
  readonly id: string
  // What it is called where something has to say what it is (the killfeed). None is drawn over it.
  readonly name = 'Core'
  // The body of it: what the simulator makes the character from.
  readonly champion: Champion
  readonly guardedByTier: number
  // What breaking it pays, with the defaults put in.
  readonly reward: Readonly<Resources>

  constructor(id: string, def: CoreDef) {
    const fail = (problem: string): never => {
      throw new Error(`Core "${id}" ${problem}.`)
    }
    if (champions.has(id)) fail('has the id of a champion')
    if (!(Number.isFinite(def.maxHp) && def.maxHp > 0)) fail('needs a health that is more than 0')
    if (!(Number.isFinite(def.radius) && def.radius > 0)) fail('needs a radius that is more than 0')
    if (!(Number.isInteger(def.guardedByTier) && def.guardedByTier >= 0)) fail('needs a guardedByTier that is a whole number, 0 or more')
    this.id = id
    this.guardedByTier = def.guardedByTier
    this.champion = new Champion({
      id,
      name: this.name,
      // It never attacks: it has no damage to do, and nothing gives it a target.
      base: { maxHp: def.maxHp, attackDamage: 0, attackSpeed: 1, resistance: def.resistance ?? 0 },
      moveSpeed: 0,
      radius: def.radius,
      attackRange: 0,
      attackWindupTicks: 0,
      abilities: [],
    })
    this.reward = {
      gold: def.reward?.gold ?? DEFAULT_CORE_REWARD.gold,
      xp: def.reward?.xp ?? DEFAULT_CORE_REWARD.xp,
      shards: def.reward?.shards ?? DEFAULT_CORE_REWARD.shards,
    }
    for (const [what, amount] of Object.entries(this.reward)) {
      if (!(Number.isInteger(amount) && amount >= 0)) fail(`needs a reward of ${what} that is a whole number, 0 or more`)
    }
  }
}

// The id of the core the game plays with.
export const CORE_ID = 'core'

// The core every map's `core` points are. Distances are in world units (a champion is about 40 across).
export const CORE: CoreDef = {
  // The health of the whole base: more than a tier 2 turret.
  maxHp: 6000,
  // Takes about a fifth off every attack.
  resistance: 25,
  radius: 60,
  // Protected until its team's tier 1 turrets are down.
  guardedByTier: 2,
}

// The cores in the game, by the id of their body. Like the turrets they are in a registry of their own, not `champions`, so no one can pick one.
export const cores: ReadonlyMap<string, Core> = new Map([[CORE_ID, new Core(CORE_ID, CORE)]])

export function getCore(id: string = CORE_ID): Core {
  const core = cores.get(id)
  if (!core) throw new RangeError(`Unknown core "${id}".`)
  return core
}
