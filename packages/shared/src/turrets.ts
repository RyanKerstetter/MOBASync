import { Champion, champions, type AttackProjectileDef, type ChampionDef } from './champions.js'
import { GAME_VISION_RANGE } from './constants.js'
import { DEFAULT_TURRET_REWARD, type Resources } from './progression.js'
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

// What one tier of turret is made of. The stats are the champion's (see stats.ts); a turret never levels, so there is no growth.
export interface TurretTierDef {
  // Its health, attack damage and attack speed (attacks a second), which a tier has to say, and its resistance (`x / (100 + x)` off every
  // hit it takes, see stats.ts), which it can leave out for none.
  base: ChampionDef['base']
  // How big it is, to hit and to walk into: it is solid, and does not move for anyone.
  radius: number
  // How far it reaches, from its middle to the middle of whoever it shoots, and so how big the circle drawn round it is.
  attackRange: number
  // How far its team sees from it, from its middle, round any walls: whoever is within it is seen, whether or not a champion of the team
  // is near. Left out, it sees as far as a champion does (`GAME_VISION_RANGE`).
  visionRange?: number
  // How long after it starts to shoot until the shot leaves.
  attackWindupTicks: number
  // The shot it fires. Left out, the hit lands as the windup ends, wherever the target is in its range.
  attackProjectile?: AttackProjectileDef
  // What the player who destroys it is paid (see progression.ts). Whatever it leaves out is `DEFAULT_TURRET_REWARD`.
  reward?: Partial<Resources>
}

export class Turret {
  readonly tier: number
  // The id of its body, which is what a snapshot says it is: `turret-1` for tier 1.
  readonly id: string
  // What it is called where something has to say what it is (the killfeed, a map that has no room for it): `Tier 1 Turret`. It has no
  // name of its own to set, and none is drawn over it.
  readonly name: string
  // The body of it: what the simulator makes the character from.
  readonly champion: Champion
  // What destroying it pays, with the defaults put in.
  readonly reward: Readonly<Resources>
  // How far its team sees from it, with the default put in.
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
    if (!(Number.isInteger(def.attackWindupTicks) && def.attackWindupTicks >= 0)) fail('needs a windup that is a whole number of ticks, 0 or more')
    this.tier = tier
    this.id = turretId(tier)
    if (champions.has(this.id)) fail('has the id of a champion')
    this.name = `Tier ${tier} Turret`
    this.visionRange = def.visionRange ?? GAME_VISION_RANGE
    this.champion = new Champion({
      id: this.id,
      name: this.name,
      base: def.base,
      // It stands where it is put.
      moveSpeed: 0,
      radius: def.radius,
      attackRange: def.attackRange,
      attackWindupTicks: def.attackWindupTicks,
      ...(def.attackProjectile ? { attackProjectile: def.attackProjectile } : {}),
      abilities: [],
    })
    this.reward = {
      gold: def.reward?.gold ?? DEFAULT_TURRET_REWARD.gold,
      xp: def.reward?.xp ?? DEFAULT_TURRET_REWARD.xp,
      shards: def.reward?.shards ?? DEFAULT_TURRET_REWARD.shards,
    }
    for (const [what, amount] of Object.entries(this.reward)) {
      if (!(Number.isInteger(amount) && amount >= 0)) fail(`needs a reward of ${what} that is a whole number, 0 or more`)
    }
  }
}

// The id of the body of a tier of turret.
export const turretId = (tier: number): string => `turret-${tier}`

// The tiers there are. Distances are in world units (a champion is about 40 across, and sees 500), and times are in ticks (60 a second).
// A map says which of these a turret is, by the tier on its point; a tier the map has and this table has not is left out of the game,
// with a warning, so a map can keep places for tiers still to come. To add a tier, add an entry; the stats are all here to tune.
export const TURRET_TIERS: Readonly<Record<number, TurretTierDef>> = {
  1: {
    base: { maxHp: 4500, attackDamage: 50, attackSpeed: 0.6, resistance: 25 },
    radius: 44,
    attackRange: 300,
    visionRange: 600,
    attackWindupTicks: 12,
    attackProjectile: { speed: 750, radius: 10, color: '#ff7a59' },
    reward: { gold: 150, xp: 600 },
  },
  2: {
    base: { maxHp: 3000, attackDamage: 60, attackSpeed: 1, resistance: 40 },
    radius: 36,
    attackRange: 400,
    visionRange: 600,
    attackWindupTicks: 12,
    attackProjectile: { speed: 700, radius: 8, color: '#ffd166' },
    reward: { gold: 300, xp: 900 },
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

// The tiers the game has, lowest first, for saying which a map can use.
export function turretTiers(): number[] {
  return [...turrets.values()].map((turret) => turret.tier).sort((left, right) => left - right)
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
