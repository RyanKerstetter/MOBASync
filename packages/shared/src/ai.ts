import { beyondMinCastRange, getAbilityDef, withinCastRange, type AbilityDef } from './abilities.js'
import type { AiState, CastTarget, Vector2 } from './index.js'
import type { Monster } from './monsters.js'

// What a monster decides to do on a tick (see monsters.ts for what a monster is). `think` is a pure function:
// it reads what the monster can see, as plain numbers, and says what it does, as the same kinds of orders a player
// gives (move, attack, cast) and how its mind changes. It touches nothing, so it is tested on its own, and it
// gives the same answer on the server and on every client, which is what lets a monster be played out by the simulator
// instead of being sent over the network. That also means it must stay a function of its arguments: no random numbers, no
// clock, nothing that is not in the frame.
//
// A monster is in one of three modes:
//
//   idle     at home, waiting. It goes after the nearest player within its aggro range (the walk to them, the way round
//            walls: see `WalkDistance`), or whoever hurt it (if it is that kind of monster) from wherever they did, if
//            there is any way to them. It walks home if something has pushed it away.
//   chase    after someone. The simulator's own attack lock does the chasing and the auto attacks (an `attack` order
//            makes the monster walk up to its target and strike it again and again, as it does for a player), and
//            this adds the abilities. It keeps the same target for as long as it can. Its deaggro range is round its
//            home, which does not move, and is the walk home (the way round walls, not the line): while the monster is
//            outside it, its deaggro bar fills a tick at a time (and it does too while there is no way to its target,
//            which is a chase that is going nowhere), and while it is inside, the bar empties. When the bar is full it
//            ignores everyone and goes home. It gives up its target at once if they die, and then it takes the nearest
//            player in its aggro range instead, if there is one, and goes home if not.
//   return   walking home. It pays no attention to anyone on the way, so it cannot be kited back and forth. On
//            getting home it is healed to full (if it is that kind of monster) and is idle again. A monster whose bar
//            filled is shown with it full till it is there.

export type AiBody = {
  id: number
  team: number
  position: Vector2
  // Where it started, and where it goes back to.
  home: Vector2
  hp: number
  maxHp: number
  // It cannot act this tick: it is winding up, dashing or stunned. Orders to start something are held back, though
  // giving up a fight is not.
  busy: boolean
  silenced: boolean
  // Who its attack is locked on to now, if anyone, and whether it is walking somewhere.
  attacking: number | undefined
  moving: boolean
  // Whether an ability is off cooldown.
  ready: (abilityId: string) => boolean
}

// Everyone else the monster can see: where they are, and whether they are alive.
export type AiOther = { id: number; team: number; position: Vector2; alive: boolean }

export type AiOrder =
  | { type: 'move'; target: Vector2 }
  | { type: 'attack'; targetId: number }
  | { type: 'cast'; abilityId: string; target: CastTarget }

export type AiDecision = {
  // What it is doing next tick.
  state: AiState
  // What it does now, in order.
  orders: AiOrder[]
  // It is home after a fight and is healed to full.
  reset: boolean
}

const distance = (left: Vector2, right: Vector2): number => {
  const dx = right.x - left.x
  const dy = right.y - left.y
  return Math.sqrt(dx * dx + dy * dy)
}

// How far a monster has to walk to get from one place to another: the way round the walls, which is what a range means
// to something that has to go there (Infinity if there is no way). It has to be a function of the walls, which never change
// in a game, and nothing else, as the rest of `think` is. The straight line, which is the default, is the same with no walls.
export type WalkDistance = (from: Vector2, to: Vector2) => number

export function think(
  monster: Monster,
  body: AiBody,
  state: AiState,
  others: readonly AiOther[],
  walk: WalkDistance = distance,
): AiDecision {
  const profile = monster.ai
  const enemies = others
    .filter((other) => other.alive && other.team !== body.team && other.id !== body.id)
    .sort((left, right) => left.id - right.id)
  const fromHome = distance(body.position, body.home)
  const atHome = fromHome <= profile.homeRadius

  // How far it has to walk to someone, if that is within `range` (Infinity if it is not, and for a range that is nothing, which
  // notices no one; Infinity is a range of everyone). A walk is never shorter than the straight line, so someone further than
  // the range in a straight line is out of it without working the walk out, which is the work, and it is only worked out once
  // for each.
  const walked = new Map<number, number>()
  const walkTo = (enemy: AiOther, range: number): number => {
    if (!(range > 0) || distance(body.position, enemy.position) > range) return Infinity
    let far = walked.get(enemy.id)
    if (far === undefined) {
      far = walk(body.position, enemy.position)
      walked.set(enemy.id, far)
    }
    return far
  }
  // Whether there is any way to them, however far.
  const reachable = (enemy: AiOther): boolean => walkTo(enemy, Infinity) < Infinity

  // The nearest of the enemies within `range` of the monster, by the walk, the lowest ID if two are as near.
  const nearest = (range: number): AiOther | undefined => {
    let found: AiOther | undefined
    let best = Infinity
    for (const enemy of enemies) {
      const away = walkTo(enemy, range)
      if (away <= range && away < best) {
        found = enemy
        best = away
      }
    }
    return found
  }
  // Gives up and goes home, or is home already and so is done. `deaggro` is the bar it has filled, kept while it walks.
  const giveUp = (deaggro = 0): AiDecision => atHome
    ? { state: { mode: 'idle' }, orders: [], reset: profile.resetOnReturn }
    : {
      state: { mode: 'return', ...(deaggro > 0 ? { deaggro } : {}) },
      orders: [{ type: 'move', target: { ...body.home } }],
      reset: false,
    }

  if (state.mode === 'return') {
    if (atHome) return { state: { mode: 'idle' }, orders: [], reset: profile.resetOnReturn }
    // Kept walking, in case something stopped it on the way.
    const orders: AiOrder[] = !body.moving && !body.busy ? [{ type: 'move', target: { ...body.home } }] : []
    return { state: { mode: 'return', ...(state.deaggro !== undefined ? { deaggro: state.deaggro } : {}) }, orders, reset: false }
  }

  let target: AiOther | undefined
  // The deaggro bar, as it is after this tick.
  let deaggro = 0
  if (state.mode === 'idle') {
    // Whoever hurt it, from wherever they did, if there is a way to them, or else whoever is nearest in its aggro range.
    const provoker = profile.aggroOnHit ? enemies.find((enemy) => enemy.id === state.provokedBy) : undefined
    target = provoker && reachable(provoker) ? provoker : nearest(profile.aggroRange)
    if (!target) {
      // Something pushed it off its post.
      return atHome ? { state: { mode: 'idle' }, orders: [], reset: false } : giveUp()
    }
  } else {
    // The same target for as long as it is there, and if they are dead or gone, whoever is nearest in its aggro range, or home.
    target = enemies.find((enemy) => enemy.id === state.targetId) ?? nearest(profile.aggroRange)
    if (!target) return giveUp()
    // The bar fills a tick at a time while the monster is outside its deaggro range of home, wherever its target is, and while
    // there is no way to them. It empties while it is inside. When it is full the monster gives up on everyone. The range is the
    // walk home, the way round the walls, and not the line: it can be a wall away from home and a long way to walk. The walk is
    // never shorter than the line, so past the range in a line is out of it without working the walk out.
    const outOfRange = fromHome > profile.deaggroRange || walk(body.position, body.home) > profile.deaggroRange
    const losing = outOfRange || !reachable(target)
    deaggro = losing ? (state.deaggro ?? 0) + 1 : Math.max(0, (state.deaggro ?? 0) - profile.deaggroRecovery)
    if (deaggro >= profile.deaggroTicks) return giveUp(profile.deaggroTicks)
  }

  const orders: AiOrder[] = []
  if (!body.busy) {
    const cast = chooseCast(monster, body, target)
    if (cast) orders.push(cast)
    else if (body.attacking !== target.id) orders.push({ type: 'attack', targetId: target.id })
  }
  return { state: { mode: 'chase', targetId: target.id, ...(deaggro > 0 ? { deaggro } : {}) }, orders, reset: false }
}

// The first of the monster's ability rules that can be cast at this target now.
function chooseCast(monster: Monster, body: AiBody, target: AiOther): AiOrder | undefined {
  if (body.silenced) return undefined
  const away = distance(body.position, target.position)
  for (const rule of monster.ai.abilities) {
    const def = getAbilityDef(rule.abilityId)
    if (!def || !body.ready(def.id)) continue
    if (rule.belowHealth !== undefined && !(body.hp / body.maxHp < rule.belowHealth)) continue
    if (away > (rule.withinRange ?? (def.range > 0 ? def.range : monster.champion.attackRange))) continue
    const aim = aimAt(def, body.position, target)
    if (aim) return { type: 'cast', abilityId: def.id, target: aim }
  }
  return undefined
}

// Where an ability is aimed to hit a target, in the form its targeting wants, or nothing if it cannot be aimed there. A
// direction is worked out with a square root and a division alone, so every peer gets the same bits; the
// order a player's page sends is quantised for the same reason.
export function aimAt(def: AbilityDef, from: Vector2, target: AiOther): CastTarget | undefined {
  const away = distance(from, target.position)
  switch (def.targeting) {
    case 'none':
      return { mode: 'none' }
    case 'unit':
      return withinCastRange(from, target.position, def.range) ? { mode: 'unit', unitId: target.id } : undefined
    case 'direction':
      return away === 0
        ? undefined
        : { mode: 'direction', dir: { x: (target.position.x - from.x) / away, y: (target.position.y - from.y) / away } }
    case 'point': {
      // At the target, held between the nearest and the furthest the ability can be aimed.
      const minRange = def.minRange ?? 0
      if (away === 0) return minRange > 0 ? undefined : { mode: 'point', point: { ...target.position } }
      const held = Math.max(minRange, Math.min(def.range, away))
      const scale = held / away
      const point = { x: from.x + (target.position.x - from.x) * scale, y: from.y + (target.position.y - from.y) * scale }
      return beyondMinCastRange(from, point, minRange) && withinCastRange(from, point, def.range)
        ? { mode: 'point', point }
        : undefined
    }
  }
}
