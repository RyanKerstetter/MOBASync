import { champions, Champion, type ChampionDef } from './champions.js'
import { GAME_TPS } from './constants.js'

// Monsters: characters the game plays itself. A monster is a champion (it has health, an attack, abilities and a
// size, and the simulator treats it as one) plus an `AiProfile` that says how it behaves: when it notices a player,
// how far it chases, when it gives up, which abilities it uses and when, and whether it comes back.
//
// What a monster does on a tick is decided by `think` (ai.ts), a pure function of the frame, which the simulator
// runs for every monster on every tick it computes. So the server and every client work out the same monsters, a
// late order that changes who was where changes what they did and the frames after it, and nothing about a monster
// has to be sent: only the `ai` state in its frame (what it is up to, and whom it is after). Because of that
// a monster's choices may only depend on the frame: no random numbers, no clock, nothing that is not in it.
//
// Monsters are placed by the map (`monster` points, see map-layout.ts) and come with the game. They are all on
// one team (`GAME_MONSTER_TEAM`): enemies of every player, teammates of each other. They have no score and take
// no part in the game mode's objectives.

// One ability a monster uses in a fight. The rules are tried in order on every tick the monster is free to act and has
// a target, and the first that can be cast is.
export interface AiAbilityRule {
  // An ability on the monster's champion.
  abilityId: string
  // Cast it only when the target is this near the monster (centre to centre). Without it, the ability's own range,
  // or for one with none (a blast round the caster) the monster's attack range.
  withinRange?: number
  // Cast it only while the monster's health is below this share of its maximum (0 to 1), for an ability it keeps
  // for when it is hurt.
  belowHealth?: number
}

export interface AiProfileDef {
  // A player this near (centre to centre) is noticed by an idle monster, which goes after the nearest one.
  aggroRange: number
  // A monster that is after someone gives up when they get this far from it (and `aggroRange` or more). Without it,
  // one and a half times the aggro range.
  deaggroRange?: number
  // How far from its home (where it started) a monster will go. Past it, it gives up whoever it is after, and
  // walks back, however close they are.
  leashRange: number
  // What it casts in a fight, best first.
  abilities?: readonly AiAbilityRule[]
  // How many ticks after dying it comes back at its home, with full health. Without it, it does not.
  respawnTicks?: number
  // Whether it is healed to full when it gets home after giving up. Default yes.
  resetOnReturn?: boolean
  // Whether being hurt by a player makes an idle monster go after them, whatever the range. Default yes.
  aggroOnHit?: boolean
  // How near home counts as being home. Default 30.
  homeRadius?: number
}

// What a monster does, with the defaults put in.
export type AiProfile = Required<Omit<AiProfileDef, 'respawnTicks'>> & { respawnTicks?: number }

export interface MonsterDef extends ChampionDef {
  ai: AiProfileDef
}

export class Monster {
  readonly id: string
  readonly name: string
  // The body of it: what the simulator makes the character from.
  readonly champion: Champion
  readonly ai: AiProfile

  constructor(def: MonsterDef) {
    const { ai, ...body } = def
    const fail = (problem: string): never => {
      throw new Error(`Monster "${def.id}" ${problem}.`)
    }
    if (champions.has(def.id)) fail('has the id of a champion')
    this.champion = new Champion(body)
    this.id = def.id
    this.name = def.name
    const positive = (value: number | undefined, what: string): void => {
      if (value !== undefined && !(Number.isFinite(value) && value > 0)) fail(`needs a positive ${what}`)
    }
    positive(ai.aggroRange, 'aggro range')
    positive(ai.leashRange, 'leash range')
    positive(ai.deaggroRange, 'deaggro range')
    positive(ai.homeRadius, 'home radius')
    const deaggroRange = ai.deaggroRange ?? ai.aggroRange * 1.5
    if (deaggroRange < ai.aggroRange) fail('gives up nearer than it notices (deaggro range under aggro range)')
    if (ai.respawnTicks !== undefined && !(Number.isInteger(ai.respawnTicks) && ai.respawnTicks > 0)) {
      fail('needs a respawn time that is a whole number of ticks')
    }
    for (const rule of ai.abilities ?? []) {
      if (!this.champion.hasAbility(rule.abilityId)) fail(`uses ${rule.abilityId}, which is not one of its abilities`)
      positive(rule.withinRange, `range for ${rule.abilityId}`)
      if (rule.belowHealth !== undefined && !(rule.belowHealth > 0 && rule.belowHealth <= 1)) {
        fail(`needs a health share from 0 to 1 for ${rule.abilityId}`)
      }
    }
    this.ai = {
      aggroRange: ai.aggroRange,
      deaggroRange,
      leashRange: ai.leashRange,
      abilities: [...(ai.abilities ?? [])].map((rule) => ({ ...rule })),
      ...(ai.respawnTicks !== undefined ? { respawnTicks: ai.respawnTicks } : {}),
      resetOnReturn: ai.resetOnReturn ?? true,
      aggroOnHit: ai.aggroOnHit ?? true,
      homeRadius: ai.homeRadius ?? 30,
    }
  }
}

const seconds = (value: number): number => Math.round(value * GAME_TPS)

// The monsters in the game. These are placeholders to build on: change them and add to them as the game's monsters
// are worked out. A map has one by putting a `monster` point with this id on it.
export const monsters: ReadonlyMap<string, Monster> = new Map([
  new Monster({
    id: 'wolf',
    name: 'Wolf',
    description: 'A placeholder camp monster: it rushes whoever comes near, and slams everything round it when they are close.',
    maxHp: 500,
    moveSpeed: 170,
    radius: 22,
    attackDamage: 30,
    attackSpeed: 1,
    attackRange: 70,
    attackWindupTicks: 8,
    abilities: ['monster-slam'],
    ai: {
      aggroRange: 380,
      leashRange: 700,
      abilities: [{ abilityId: 'monster-slam', withinRange: 120 }],
      respawnTicks: seconds(30),
    },
  }),
].map((monster) => [monster.id, monster]))

export function getMonster(id: string): Monster {
  const monster = monsters.get(id)
  if (!monster) throw new RangeError(`Unknown monster "${id}".`)
  return monster
}

// The champion a character is: a player's, or a monster's body.
export function getCharacterChampion(id: string): Champion {
  const champion = champions.get(id) ?? monsters.get(id)?.champion
  if (!champion) throw new RangeError(`Unknown champion or monster "${id}".`)
  return champion
}
