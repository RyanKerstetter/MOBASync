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
//   idle     at home, waiting. It goes after the nearest player within its aggro range, or whoever hurt it
//            (if it is that kind of monster), and walks home if something has pushed it away.
//   chase    after someone. The simulator's own attack lock does the chasing and the auto attacks (an `attack` order
//            makes the monster walk up to its target and strike it again and again, as it does for a player), and
//            this adds the abilities. It keeps the same target for as long as it can: it gives it up if they die, if
//            they get further than its deaggro range, or if the monster itself is further from home than its leash,
//            and then it takes the nearest player in its aggro range instead, if there is one, and goes home if
//            not (a monster past its leash goes home whoever is close).
//   return   walking home. It pays no attention to anyone on the way, so it cannot be kited back and forth. On
//            getting home it is healed to full (if it is that kind of monster) and is idle again.

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

export function think(monster: Monster, body: AiBody, state: AiState, others: readonly AiOther[]): AiDecision {
  const profile = monster.ai
  const enemies = others
    .filter((other) => other.alive && other.team !== body.team && other.id !== body.id)
    .sort((left, right) => left.id - right.id)
  const fromHome = distance(body.position, body.home)
  const atHome = fromHome <= profile.homeRadius

  // The nearest of the enemies within `range` of the monster, the lowest ID if two are as near.
  const nearest = (range: number): AiOther | undefined => {
    let found: AiOther | undefined
    let best = Infinity
    for (const enemy of enemies) {
      const away = distance(body.position, enemy.position)
      if (away <= range && away < best) {
        found = enemy
        best = away
      }
    }
    return found
  }
  // Gives up and goes home, or is home already and so is done.
  const giveUp = (): AiDecision => atHome
    ? { state: { mode: 'idle' }, orders: [], reset: profile.resetOnReturn }
    : { state: { mode: 'return' }, orders: [{ type: 'move', target: { ...body.home } }], reset: false }

  if (state.mode === 'return') {
    if (atHome) return { state: { mode: 'idle' }, orders: [], reset: profile.resetOnReturn }
    // Kept walking, in case something stopped it on the way.
    const orders: AiOrder[] = !body.moving && !body.busy ? [{ type: 'move', target: { ...body.home } }] : []
    return { state: { mode: 'return' }, orders, reset: false }
  }

  let target: AiOther | undefined
  if (state.mode === 'idle') {
    // Whoever hurt it, if they are still within reach of its attention, or else whoever is nearest.
    const provoker = profile.aggroOnHit ? enemies.find((enemy) => enemy.id === state.provokedBy) : undefined
    target = provoker && distance(body.position, provoker.position) <= profile.deaggroRange
      ? provoker
      : nearest(profile.aggroRange)
    if (!target) {
      // Something pushed it off its post.
      return atHome ? { state: { mode: 'idle' }, orders: [], reset: false } : giveUp()
    }
    if (fromHome > profile.leashRange) return giveUp()
  } else {
    if (fromHome > profile.leashRange) return giveUp()
    // The same target for as long as it is there and in reach of the monster's attention.
    const current = enemies.find((enemy) => enemy.id === state.targetId)
    target = current && distance(body.position, current.position) <= profile.deaggroRange
      ? current
      : nearest(profile.aggroRange)
    if (!target) return giveUp()
  }

  const orders: AiOrder[] = []
  if (!body.busy) {
    const cast = chooseCast(monster, body, target)
    if (cast) orders.push(cast)
    else if (body.attacking !== target.id) orders.push({ type: 'attack', targetId: target.id })
  }
  return { state: { mode: 'chase', targetId: target.id }, orders, reset: false }
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
