import { Champion, champions, type AttackProjectileDef, type ChampionDef } from './champions.js'
import { GAME_VISION_RANGE } from './constants.js'
import { DEFAULT_CORE_REWARD, DEFAULT_TURRET_REWARD, type Resources } from './progression.js'
import { rampedShot, rampProblem, TURRET_RAMP, type TurretRamp } from './turret-ramp.js'
import type { Vector2 } from './index.js'

// Turrets: structures a map puts on the ground, that stand where they are put and shoot the enemy players who come within their range.
// A turret is a champion that cannot move (health, an attack, a size: the simulator treats it as one, so enemies can target it, hit it
// with abilities, and kill it) plus these rules. It belongs to a team, as a player does, and is an enemy of every other team, monsters
// included: it shoots players only, and no monster goes after it.
//
// What a turret is, is its **tier**. Every number that makes one what it is, health, damage, how fast it shoots, resistance, how far it
// reaches, how big it is and what it pays when it is destroyed, is in the `TURRET_TIERS` table below, one entry for each tier, so a
// tier is tuned by changing its entry, and a new one is a new entry. A map says which tier each of its turrets is (see map-layout.ts).
//
// What a turret does on a tick is `thinkTurrets` in the simulator, which runs for every turret on every tick it computes, so the server
// and every client work out the same shots and nothing about a turret has to be sent. It reads only the frame, so it is what
// `chooseTurretTarget` says: no random numbers, no clock.
//
// A standing turret is also a place its team sees from, out to its `visionRange`, as a champion of the team is (see `TeamVision`, which is
// the page's, and not a rule of the game).
//
// **The core is a turret.** It is the last turret of a base, the highest tier there is (`CORE_TIER`), and what makes it a core is one flag on its entry in the
// table, `core`: when it falls its team can no longer respawn, and in Core Destruction that decides who wins (see modes.ts). Everything else it has is a
// turret's, from the same code: it shoots, ramps, is solid, is hurt by attacks only, is protected by the lower tiers of its team until they are down (structures.ts),
// is seen from, and is destroyed for good. It differs only where the flag says: it pays nothing by default (`DEFAULT_CORE_REWARD`), it is called `Core`, a map
// puts it down with a `core` point and not a `turret` point, and it is in the game only when the mode is Core Destruction.

// What one tier of turret is made of. The stats are the champion's (see stats.ts); a turret never levels, so there is no growth.
export interface TurretTierDef {
  base: ChampionDef['base']
  radius: number
  attackRange: number
  visionRange?: number
  attackWindup: number
  attackProjectile?: AttackProjectileDef
  ramp?: TurretRamp
  core?: true
  reward?: Partial<Resources>
}

export class Turret {
  readonly tier: number
  // The id of its body, which is what a snapshot says it is: `turret-1` for tier 1.
  readonly id: string
  // What it is called where something has to say what it is (the killfeed, a map that has no room for it): `Tier 1 Turret`, or `Core`. It has no
  // name of its own to set, and none is drawn over it.
  readonly name: string
  // Whether it is the core of a base: the last turret, whose fall decides Core Destruction.
  readonly core: boolean
  readonly champion: Champion
  // What destroying it pays, with the defaults put in.
  readonly reward: Readonly<Resources>
  // How its shots ramp up, if they do.
  readonly ramp: Readonly<TurretRamp> | undefined
  readonly visionRange: number

  constructor(tier: number, def: TurretTierDef) {
    const fail = (problem: string): never => {
      throw new Error(`Turret tier ${tier} ${problem}.`)
    }
    if (!(Number.isInteger(tier) && tier > 0)) fail('needs a tier that is a whole number, 1 or more')
    const positive = (value: number, what: string): void => {
      if (!(Number.isFinite(value) && value > 0)) fail(`needs a ${what} that is more than 0`)
    }
    positive(def.radius, 'radius')
    positive(def.attackRange, 'range')
    if (def.visionRange !== undefined) positive(def.visionRange, 'vision range')
    if (!(Number.isFinite(def.attackWindup) && def.attackWindup >= 0 && def.attackWindup <= 1)) fail('needs a windup that is a share of the attack, from 0 to 1')
    if (def.ramp) {
      const problem = rampProblem(def.ramp)
      if (problem) fail(problem)
    }
    this.ramp = def.ramp ? { ...def.ramp } : undefined
    this.tier = tier
    this.id = turretId(tier)
    if (champions.has(this.id)) fail('has the id of a champion')
    this.core = def.core === true
    this.name = this.core ? 'Core' : `Tier ${tier} Turret`
    this.visionRange = def.visionRange ?? GAME_VISION_RANGE
    this.champion = new Champion({
      id: this.id,
      name: this.name,
      base: def.base,
      // It stands where it is put.
      moveSpeed: 0,
      radius: def.radius,
      attackRange: def.attackRange,
      attackWindup: def.attackWindup,
      ...(def.attackProjectile ? { attackProjectile: def.attackProjectile } : {}),
      // What a shot does when it lands: its damage, ramped up by the shots at this target before it, if the tier ramps.
      ...(def.ramp ? { onAttackHit: rampedShot(def.ramp, def.base.attackSpeed) } : {}),
      abilities: [],
    })
    const unsaid = this.core ? DEFAULT_CORE_REWARD : DEFAULT_TURRET_REWARD
    this.reward = {
      gold: def.reward?.gold ?? unsaid.gold,
      xp: def.reward?.xp ?? unsaid.xp,
      shards: def.reward?.shards ?? unsaid.shards,
    }
    for (const [what, amount] of Object.entries(this.reward)) {
      if (!(Number.isInteger(amount) && amount >= 0)) fail(`needs a reward of ${what} that is a whole number, 0 or more`)
    }
  }
}

// The id of the body of a tier of turret.
export const turretId = (tier: number): string => `turret-${tier}`

// The tier of the core of the game: above every turret, so it is the last of a base to be hurt.
export const CORE_TIER = 3

// The tiers there are. Distances are in world units (a champion is about 40 across, and sees 500), and times are in ticks (60 a second).
// A map says which of these a turret is, by the tier on its point; a tier the map has and this table has not is left out of the game,
// with a warning, so a map can keep places for tiers still to come. To add a tier, add an entry; the stats are all here to tune.
export const TURRET_TIERS: Readonly<Record<number, TurretTierDef>> = {
  1: {
    base: { maxHp: 4500, attackDamage: 50, attackSpeed: 1, resistance: 25 },
    radius: 36,
    attackRange: 300,
    visionRange: 600,
    attackWindup: 0.12,
    attackProjectile: { speed: 750, radius: 10, color: '#ff7a59' },
    // Every shot at the same target does half of the first one's damage more, up to four times it.
    ramp: TURRET_RAMP,
    reward: { gold: 150, xp: 600 },
  },
  2: {
    base: { maxHp: 6000, attackDamage: 75, attackSpeed: 1, resistance: 50 },
    radius: 36,
    attackRange: 350,
    visionRange: 600,
    attackWindup: 0.12,
    attackProjectile: { speed: 700, radius: 8, color: '#ffd166' },
    ramp: TURRET_RAMP,
    reward: { gold: 300, xp: 900 },
  },
  // The core every map's `core` points are: the heart of a base, and the last gun of it. It is protected until its team's turrets are down, and it shoots
  // whoever comes within its reach, a little harder and further than a tier 2 turret does. It pays nothing: breaking it ends the game for a team.
  [CORE_TIER]: {
    core: true,
    // The health of the whole base.
    base: { maxHp: 8000, attackDamage: 90, attackSpeed: 1, resistance: 75 },
    radius: 60,
    attackRange: 420,
    // As far as a turret sees: the base is lit round the core, whether or not a champion is near.
    visionRange: 600,
    attackWindup: 0.12,
    attackProjectile: { speed: 750, radius: 12, color: '#c77dff' },
    // It ramps as the turrets do: the longer someone stays in its reach, the harder it hits them.
    ramp: TURRET_RAMP,
  },
}

// The turrets in the game, by the id of their body (`turret-1`). Like the monsters they are in a registry of their own, not
// `champions`, so no one can pick one.
export const turrets: ReadonlyMap<string, Turret> = new Map(
  Object.entries(TURRET_TIERS).map(([tier, def]) => {
    const turret = new Turret(Number(tier), def)
    return [turret.id, turret]
  }),
)

export function getTurret(tier: number): Turret {
  const turret = turrets.get(turretId(tier))
  if (!turret) throw new RangeError(`Unknown turret tier ${tier}.`)
  return turret
}

// The core of the game: the turret of the core tier, which every map's `core` points are.
export function getCore(): Turret {
  return getTurret(CORE_TIER)
}

// The tiers of turret the game has, lowest first, for saying which a map's `turret` points can name. The core is not one of them: a map puts it down with
// a `core` point.
export function turretTiers(): number[] {
  return [...turrets.values()].filter((turret) => !turret.core).map((turret) => turret.tier).sort((left, right) => left - right)
}

// Who a turret can see to shoot: where they are, whose they are, and whether they are alive. The simulator gives it the players only.
export type TurretPrey = { id: number; team: number; position: Vector2; alive: boolean }

export type TurretBody = {
  team: number
  position: Vector2
  // How far it reaches now, from its middle to the middle of the target, with anything that changes its range.
  range: number
  // Who it is shooting now, if anyone.
  attacking: number | undefined
}

// Who a turret shoots: the enemy player it is already shooting for as long as they are alive and in its range, and else the nearest
// one in its range (the lowest id if two are as near), or no one. It never goes after anyone out of its range: it cannot move, so a
// target that walked out of it is dropped, not chased.
export function chooseTurretTarget(body: TurretBody, others: readonly TurretPrey[]): number | undefined {
  let current: number | undefined
  let nearest: number | undefined
  let nearestAway = Infinity
  for (const other of [...others].sort((left, right) => left.id - right.id)) {
    if (!other.alive || other.team === body.team) continue
    const dx = other.position.x - body.position.x
    const dy = other.position.y - body.position.y
    const away = Math.sqrt(dx * dx + dy * dy)
    if (away > body.range) continue
    if (other.id === body.attacking) current = other.id
    if (away < nearestAway) {
      nearest = other.id
      nearestAway = away
    }
  }
  return current ?? nearest
}
