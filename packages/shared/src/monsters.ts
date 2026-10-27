import { champions, Champion, type ChampionDef } from './champions.js'
import { GAME_TPS } from './constants.js'
import { DEFAULT_MONSTER_REWARD, DEFAULT_MONSTER_XP_GROWTH, type Resources } from './progression.js'
import { cores } from './cores.js'
import { turrets } from './turrets.js'

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
// Monsters are placed by the map (`monster-spawn` points, see map-layout.ts) and come with the game. They are all on
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
  // A player this near (centre to centre, by the walk, the way round any walls) is noticed by an idle monster, which goes after
  // the nearest one. With none (0) it notices no one, and only goes after whoever hurts it.
  aggroRange: number
  // How far from its home (where it started) a monster will go after someone before it starts to lose interest: how far it
  // would have to walk to get back to its spawn (the way round any walls, and not the straight line through them), which stays
  // where the spawn is. While the monster is outside it, its deaggro bar fills, and when the bar is full it gives up and walks
  // home. Without it, one and a half times the aggro range.
  deaggroRange?: number
  // How long, in ticks, a monster can be outside its deaggro range before it gives up: its deaggro bar fills a tick at a time
  // while it is out, and when it is full it ignores everyone and walks home. Default 3 seconds.
  deaggroTicks?: number
  // How many ticks of the bar a tick of it being back inside the range empties. Default 1: as fast as it fills.
  deaggroRecovery?: number
  // What it casts in a fight, best first.
  abilities?: readonly AiAbilityRule[]
  // How many ticks after dying it comes back at its home, with full health. Without it, it does not.
  respawnTicks?: number
  // Whether it is healed to full when it gets home after giving up. Default yes.
  resetOnReturn?: boolean
  // Whether being hurt by a player makes an idle monster go after them, from however far they hit it, if there is a way to
  // them. Default yes.
  aggroOnHit?: boolean
  // How near home counts as being home. Default 30.
  homeRadius?: number
}

// What a monster does, with the defaults put in.
export type AiProfile = Required<Omit<AiProfileDef, 'respawnTicks'>> & { respawnTicks?: number }

export interface MonsterDef extends ChampionDef {
  ai: AiProfileDef
  // What the player who kills it is paid, each of them whole and not negative (see progression.ts): gold, experience, and shards
  // (which only the biggest of them pay). Whatever it leaves out is the default, `DEFAULT_MONSTER_REWARD`, so a monster that says
  // nothing is worth that much, the same whoever kills it.
  reward?: Partial<Resources>
  // How much more experience it pays for each level it has above the first (it gains one each time it is killed, see `monsterLevelAfterKill`), a whole
  // number, 0 or more. Without it, `DEFAULT_MONSTER_XP_GROWTH`. Its gold and shards are the same at every level, and its stats grow by `growth`, as a champion's.
  xpGrowth?: number
}

export class Monster {
  readonly id: string
  readonly name: string
  // The body of it: what the simulator makes the character from.
  readonly champion: Champion
  readonly ai: AiProfile
  // What killing it pays at level 1, with the defaults put in, and how much more experience it pays for each level after (see `monsterXpAt`).
  readonly reward: Readonly<Resources>
  readonly xpGrowth: number

  constructor(def: MonsterDef) {
    const { ai, reward, xpGrowth, ...body } = def
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
    // No aggro range is a monster that notices no one, and only fights back.
    if (!(Number.isFinite(ai.aggroRange) && ai.aggroRange >= 0)) fail('needs an aggro range of 0 or more')
    positive(ai.deaggroRange, 'deaggro range')
    positive(ai.homeRadius, 'home radius')
    const wholeTicks = (value: number | undefined, what: string): void => {
      if (value !== undefined && !(Number.isInteger(value) && value > 0)) fail(`needs ${what} that is a whole number of ticks`)
    }
    wholeTicks(ai.deaggroTicks, 'a deaggro time')
    wholeTicks(ai.deaggroRecovery, 'a deaggro recovery')
    const deaggroRange = ai.deaggroRange ?? ai.aggroRange * 1.5
    // One that notices no one has nothing to take one and a half times, so it has to say how far from home it goes.
    if (!(deaggroRange > 0)) fail('needs a deaggro range, as it has no aggro range to go by')
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
    this.reward = {
      gold: reward?.gold ?? DEFAULT_MONSTER_REWARD.gold,
      xp: reward?.xp ?? DEFAULT_MONSTER_REWARD.xp,
      shards: reward?.shards ?? DEFAULT_MONSTER_REWARD.shards,
    }
    for (const [what, amount] of Object.entries(this.reward)) {
      if (!(Number.isInteger(amount) && amount >= 0)) fail(`needs a reward of ${what} that is a whole number, 0 or more`)
    }
    this.xpGrowth = xpGrowth ?? DEFAULT_MONSTER_XP_GROWTH
    if (!(Number.isInteger(this.xpGrowth) && this.xpGrowth >= 0)) fail('needs an experience growth that is a whole number, 0 or more')
    this.ai = {
      aggroRange: ai.aggroRange,
      deaggroRange,
      deaggroTicks: ai.deaggroTicks ?? 3 * GAME_TPS,
      deaggroRecovery: ai.deaggroRecovery ?? 1,
      abilities: [...(ai.abilities ?? [])].map((rule) => ({ ...rule })),
      ...(ai.respawnTicks !== undefined ? { respawnTicks: ai.respawnTicks } : {}),
      resetOnReturn: ai.resetOnReturn ?? true,
      aggroOnHit: ai.aggroOnHit ?? true,
      homeRadius: ai.homeRadius ?? 30,
    }
  }
}

const seconds = (value: number): number => Math.round(value * GAME_TPS)

// The attack speed (attacks a second) of an attack that is ready again this many seconds after the last one began, to
// the tick. The wait is worked out back from the speed, rounding up, so a speed of 1 / seconds can come out a hair
// over and a tick long: aiming half a tick short of it lands on the tick it means.
export const attackEvery = (cooldown: number): number => GAME_TPS / (Math.max(1, seconds(cooldown)) - 0.5)

// The monsters in the game. A map has one by putting a `monster-spawn` point with this id on it. Everything that makes
// a monster what it is is here to tune: distances are in world units (a champion is about 40 across), and times are
// written in seconds.
export const monsters: ReadonlyMap<string, Monster> = new Map([
  // The slime: small, slow and soft, kept in pockets about the map. It hops after a player who comes near and bumps
  // them for a little damage, and goes back once they have got away.
  new Monster({
    id: 'slime',
    name: 'Slime',
    description: 'A slow, soft monster that hops after whoever comes near and bumps them for a little damage.',
    // What each bump does, and how long after one starts until it can bump again. It gains a level each time it is killed, and each level adds
    // its growth to the health and the damage (the same amount every time).
    base: { maxHp: 500, attackDamage: 25, attackSpeed: attackEvery(1) },
    growth: { maxHp: 100, attackDamage: 5 },
    // Slower than every champion, so it can be walked away from.
    moveSpeed: 115,
    radius: 20,
    // How near (middle to middle) it has to be to bump someone: a little past touching them.
    attackRange: 60,
    // How long its hop takes before the bump lands.
    attackWindupTicks: seconds(0.35),
    abilities: [],
    ai: {
      // It notices no one, but goes after whoever hurts it.
      aggroRange: 0,
      // Further than this from where it spawned, its deaggro bar fills for this long, and empties as fast while it is back
      // inside. When it is full the monster ignores everyone and goes home, and the bar is shown under it.
      deaggroRange: 300,
      deaggroTicks: seconds(3),
      respawnTicks: seconds(30),
    },
    // What killing it pays the player who does: gold, which is the same every time, and experience, which is more for each level it has gained.
    reward: { gold: 20, xp: 60 },
    xpGrowth: 10,
  }),
  // The golem: a huge, slow lump of rock that holds the middle of the competitive map. It is hard to wear down and hits
  // hard but seldom, so it is a fight to pick, and one to walk away from: it is slower than every champion, and gives up
  // the chase well short of the slimes' pockets.
  new Monster({
    id: 'golem',
    name: 'Golem',
    description: 'A huge, slow rock monster that guards the middle of the map. It hits very hard, but seldom.',
    // What each blow does, and how long after one starts until it can strike again.
    base: { maxHp: 1500, attackDamage: 40, attackSpeed: attackEvery(2.5) },
    growth: { maxHp: 300, attackDamage: 10 },
    moveSpeed: 90,
    radius: 48,
    // How near (middle to middle) it has to be to strike: its arms reach well past its body.
    attackRange: 110,
    // How long it takes to rise up and come down before the blow lands.
    attackWindupTicks: seconds(0.7),
    abilities: [],
    ai: {
      // It notices no one, but goes after whoever hurts it.
      aggroRange: 0,
      // Further than this from where it spawned, its deaggro bar fills for this long, and empties as fast while it is back
      // inside. When it is full the monster ignores everyone and goes home, and the bar is shown under it.
      deaggroRange: 400,
      deaggroTicks: seconds(3),
      respawnTicks: seconds(60),
    },
    // The big prize of the map: much more than a slime, and the only one that pays shards.
    reward: { gold: 50, xp: 100, shards: 1 },
    xpGrowth: 25,
  }),
  // A placeholder to build on, which no map has yet.
  new Monster({
    id: 'wolf',
    name: 'Wolf',
    description: 'A placeholder camp monster: it rushes whoever comes near, and slams everything round it when they are close.',
    base: { maxHp: 500, attackDamage: 30, attackSpeed: 1 },
    growth: { maxHp: 60, attackDamage: 3 },
    moveSpeed: 170,
    radius: 22,
    attackRange: 70,
    attackWindupTicks: 8,
    abilities: ['monster-slam'],
    ai: {
      aggroRange: 380,
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

// The champion a character is: a player's, or the body of a monster, a turret or a core.
export function getCharacterChampion(id: string): Champion {
  const champion = champions.get(id) ?? monsters.get(id)?.champion ?? turrets.get(id)?.champion ?? cores.get(id)?.champion
  if (!champion) throw new RangeError(`Unknown champion, monster, turret or core "${id}".`)
  return champion
}
