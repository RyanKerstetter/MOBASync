import assert from 'node:assert/strict'
import test from 'node:test'
import { championSprites } from '../apps/client/src/champion-sprites.ts'
import {
  abilityDefs,
  Champion,
  entityPosAt,
  GAME_MAX_CHAMPION_RADIUS,
  GAME_TPS,
  getChampion,
  getEntityDef,
  Simulator,
  STRUCTURE_ARCANE_DAMAGE,
  type CastTarget,
  type CharacterOrder,
  type GameEvent,
  type GameTickSnapshot,
  type Vector2,
} from '../packages/shared/src/index.ts'
import {
  FIRST_STRIKE_COOLDOWN_TICKS,
  FIRST_STRIKE_DAMAGE,
  FIRST_STRIKE_HEAL,
  FIRST_STRIKE_HEAL_SCALING,
  FIRST_STRIKE_SCALING,
  LUNGE_ATTACK_SPEED,
  LUNGE_BUFF_TICKS,
  WHIRL_CORE_RADIUS,
  WHIRL_DAMAGE,
  WHIRL_RADIUS,
  WHIRL_SCALING,
  WHIRL_SWEET_DAMAGE,
  WHIRL_SWEET_SCALING,
  WHIRL_SWEET_SLOW,
} from '../packages/shared/src/abilities.ts'
import { ATTACK_SOURCE_PREFIX } from '../packages/shared/src/effects.ts'
import { defineTurret } from './fixtures.ts'

// Chain's kit, played out in the simulator. The numbers come from the exported constants and the definitions, so retuning the kit does not break these; what they
// check is how it is meant to play.

const HOME: Vector2 = { x: 400, y: 600 }
const R = GAME_MAX_CHAMPION_RADIUS
const chain = getChampion('chain')
// Something to hit that stands there and takes it however long the fight goes: a body of the widest size, with health to spare, and no abilities. It is the test's
// own, and is not in the roster.
const bag = new Champion({
  id: 't-bag',
  name: 'Test Bag',
  base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 140,
  radius: GAME_MAX_CHAMPION_RADIUS,
  attackRange: 50,
  attackWindup: 0,
  abilities: [],
})
const within = { x: HOME.x + chain.attackRange - 10, y: HOME.y }

let sequence = 0
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })
const cast = (tick: number, abilityId: string, target: CastTarget, origin: Vector2 = HOME): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target, origin: { ...origin } })
const east: CastTarget = { mode: 'direction', dir: { x: 1, y: 0 } }
const none: CastTarget = { mode: 'none' }

// Chain is character 1, and each of the others is on a team of its own, so an enemy.
function scene(others: readonly Vector2[]): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, chain)
  others.forEach((position, index) => simulator.addPlayer(index + 2, `p${index + 2}`, `Other ${index + 2}`, position, bag))
  return simulator
}

const hp = (frame: GameTickSnapshot, id: number): number => frame.get(id)?.getHealth() ?? 0
const distance = (left: Vector2, right: Vector2): number => Math.hypot(left.x - right.x, left.y - right.y)
const close = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 1e-6

type Damage = Extract<GameEvent, { type: 'damage' }>
type Heal = Extract<GameEvent, { type: 'heal' }>
const damageBy = (frame: GameTickSnapshot, ownerId: number, targetId?: number): Damage[] =>
  frame.events.filter((event): event is Damage => event.type === 'damage' && event.ownerId === ownerId && (targetId === undefined || event.targetId === targetId))
const healsOf = (frame: GameTickSnapshot, ownerId: number): Heal[] =>
  frame.events.filter((event): event is Heal => event.type === 'heal' && event.ownerId === ownerId)

const struck = FIRST_STRIKE_DAMAGE + (FIRST_STRIKE_SCALING.attackDamage ?? 0) * chain.attackDamage
// What a first strike heals him: a flat amount and a share of his most health (heals are whole numbers).
const struckHeal = Math.round(FIRST_STRIKE_HEAL + (FIRST_STRIKE_HEAL_SCALING.maxHealth ?? 0) * chain.statsAt(1).maxHp)

// ---------------------------------------------------------------------------- passive

test('the first auto on an enemy deals bonus damage and heals, and the ones after it do not, until the cooldown has passed', () => {
  const simulator = scene([within])
  simulator.addOrder(1, attack(1, 2))
  const heals: Array<{ tick: number; amount: number }> = []
  // An auto is a hit of its attack damage, and a first strike adds a hit of its own to the same tick (so they are told apart by being two, and not by their amounts).
  const hits = new Map<number, number[]>()
  for (let tick = 1; heals.length < 2; tick += 1) {
    assert.ok(tick < FIRST_STRIKE_COOLDOWN_TICKS + 3 * chain.attackCooldownTicks, 'the second strike comes')
    const frame = simulator.at(tick)
    heals.push(...healsOf(frame, 1).map((heal) => ({ tick, amount: heal.amount })))
    const dealt = damageBy(frame, 1, 2).map((event) => event.amount)
    if (dealt.length > 0) hits.set(tick, dealt)
  }

  assert.deepEqual(heals.map((heal) => heal.amount), [struckHeal, struckHeal])
  assert.equal(heals[0].tick, 1 + chain.attackWindupTicks, 'on the first auto')
  const strikes = [...hits].filter(([, dealt]) => dealt.length === 2)
  const plain = [...hits].filter(([, dealt]) => dealt.length === 1)
  assert.deepEqual(strikes.map(([tick]) => tick), heals.map((heal) => heal.tick), 'the bonus damage and the heal come together')
  assert.ok(strikes.every(([, dealt]) => dealt[0] === chain.attackDamage && close(dealt[1], struck)), 'the auto, and the bonus as a hit of the damage it says')
  const wait = heals[1].tick - heals[0].tick
  assert.ok(wait >= FIRST_STRIKE_COOLDOWN_TICKS, `the next strike waited ${wait}`)
  assert.ok(wait < FIRST_STRIKE_COOLDOWN_TICKS + chain.attackCooldownTicks, 'and came with the first auto after that')
  assert.ok(plain.length >= 2 && plain.every(([, dealt]) => dealt[0] === chain.attackDamage), 'and the autos in between were plain')
  assert.ok(hp(simulator.at(heals[1].tick), 2) > 0, 'the fight went on throughout')
})

test('every enemy has a first strike cooldown of its own, and so does every Chain', () => {
  const second = { x: HOME.x, y: HOME.y - (chain.attackRange - 10) }
  const other = { x: within.x, y: within.y + (chain.attackRange - 10) }
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, chain)
  simulator.addPlayer(2, 'p2', 'Two', within, bag)
  simulator.addPlayer(3, 'p3', 'Three', second, bag)
  simulator.addPlayer(4, 'p4', 'Four', other, chain)
  // The first Chain goes from one enemy to the other, and back, all inside the cooldown; the second joins on the first.
  const back = 200
  const end = Math.min(FIRST_STRIKE_COOLDOWN_TICKS - 10, back + 150)
  assert.ok(end > back + chain.attackCooldownTicks, 'there is time for an auto after going back')
  simulator.addOrder(1, attack(1, 2))
  simulator.addOrder(1, attack(100, 3))
  simulator.addOrder(1, attack(back, 2))
  simulator.addOrder(4, attack(1, 2))

  const heals = new Map<number, number>()
  for (let tick = 1; tick <= end; tick += 1) {
    const frame = simulator.at(tick)
    for (const owner of [1, 4]) heals.set(owner, (heals.get(owner) ?? 0) + healsOf(frame, owner).length)
  }
  assert.equal(heals.get(1), 2, 'one strike on each of the two enemies, and none for going back to the first')
  assert.equal(heals.get(4), 1, 'the other Chain has its strike on the first, though the first Chain has had its')
})

test('an auto on a structure is never a first strike', () => {
  const tower = defineTurret(90, { base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 }, radius: 40, attackRange: 1, attackWindup: 0 })
  const simulator = scene([])
  simulator.addTurret(10, tower, within, 2)
  simulator.addOrder(1, attack(1, 10))
  const autos = 4
  const last = 1 + (autos - 1) * chain.attackCooldownTicks + chain.attackWindupTicks
  const amounts: number[] = []
  let heals = 0
  for (let tick = 1; tick <= last; tick += 1) {
    const frame = simulator.at(tick)
    heals += healsOf(frame, 1).length
    amounts.push(...damageBy(frame, 1, 10).map((event) => event.amount))
  }
  // An auto on a structure also hits for its attacker's arcane (see `STRUCTURE_ARCANE_DAMAGE`), which is a hit of its own and not the first strike's.
  const arcaneHit = STRUCTURE_ARCANE_DAMAGE > 0 && chain.arcane > 0 ? 1 : 0
  assert.equal(amounts.length, autos * (1 + arcaneHit), 'each auto lands, and with no hit of the first strike\'s')
  assert.equal(amounts.filter((amount) => amount === chain.attackDamage).length, autos)
  assert.equal(heals, 0)
})

// ---------------------------------------------------------------------------- Hook

const hook = abilityDefs.get('hook')

test('hook drags the first enemy it hits to Chain and drops it touching him, hurt, and leaves the ones behind it and beside it', () => {
  assert.ok(hook?.indicator?.width)
  const halfWidth = hook.indicator.width / 2
  const first = { x: HOME.x + hook.range / 2, y: HOME.y }
  const behind = { x: first.x + 3 * R, y: HOME.y }
  const beside = { x: first.x, y: HOME.y + halfWidth + 2 * R + 10 }
  const simulator = scene([first, behind, beside])
  simulator.addOrder(1, cast(1, 'hook', east))

  let pulled = false
  let tick = 1 + hook.windUpTicks
  for (; tick < 1 + hook.windUpTicks + 200; tick += 1) {
    const dragged = simulator.at(tick).get(2)?.isDashing() === true
    pulled = pulled || dragged
    if (pulled && !dragged) break
  }
  const frame = simulator.at(tick)
  assert.ok(pulled, 'it was dragged')
  assert.ok(hp(frame, 2) < bag.maxHp, 'and hurt')
  const where = frame.get(2)?.getPosition() ?? first
  assert.ok(close(distance(where, HOME), chain.radius + bag.radius), `it comes to rest touching him, ${distance(where, HOME)} away`)
  assert.ok(close(where.y, HOME.y), 'on the line it was dragged along')
  for (const id of [3, 4]) {
    assert.equal(hp(frame, id), bag.maxHp, `the enemy ${id === 3 ? 'behind' : 'beside'} is not hurt`)
    assert.equal(frame.get(id)?.isDashing(), false, 'and not dragged')
  }
  assert.deepEqual(frame.get(3)?.getPosition(), behind)
  assert.deepEqual(frame.get(4)?.getPosition(), beside)
})

test('a hook that reaches nobody drags nobody', () => {
  assert.ok(hook)
  const simulator = scene([{ x: HOME.x + hook.range + 3 * R, y: HOME.y }])
  simulator.addOrder(1, cast(1, 'hook', east))
  for (let tick = 1; tick < 1 + hook.windUpTicks + 100; tick += 1) {
    assert.equal(simulator.at(tick).get(2)?.isDashing(), false)
  }
  assert.equal(hp(simulator.at(1 + hook.windUpTicks + 100), 2), bag.maxHp)
})

// ---------------------------------------------------------------------------- Whirl

const whirl = getEntityDef('whirl-warning')
const whirlCore = getEntityDef('whirl-core-warning')
const warnings = (frame: GameTickSnapshot): string[] =>
  frame.getEntities().filter((entity) => entity.defId === 'whirl-warning' || entity.defId === 'whirl-core-warning').map((entity) => entity.defId).sort()
const flashes = (frame: GameTickSnapshot): string[] =>
  frame.getEntities().filter((entity) => entity.defId === 'whirl-burst' || entity.defId === 'whirl-core-burst').map((entity) => entity.defId).sort()

test('whirl charges with its circles outlined round Chain, and when it is full flashes and hits everyone in them once: the ring at the edge harder, slowing, and as a first strike', () => {
  assert.ok(whirl?.lifetimeTicks && whirlCore)
  // The circles do not fill in as it charges (that is what a telegraph does): the blow is what is seen, as a flash.
  assert.notEqual(whirl.visual, 'telegraph')
  assert.notEqual(whirlCore.visual, 'telegraph')
  for (const id of ['whirl-burst', 'whirl-core-burst']) assert.equal(getEntityDef(id)?.visual, 'flash', `${id} is a flash`)
  // A body wholly inside the core, as far out as it can be.
  assert.ok(WHIRL_CORE_RADIUS - bag.radius >= chain.radius + bag.radius, 'a body fits wholly inside the core, beside Chain')
  const inCore = { x: HOME.x + WHIRL_CORE_RADIUS - bag.radius, y: HOME.y }
  const inRing = { x: HOME.x, y: HOME.y - ((WHIRL_CORE_RADIUS + WHIRL_RADIUS) / 2 + bag.radius) }
  const outside = { x: HOME.x - (WHIRL_RADIUS + bag.radius + 15), y: HOME.y }
  const simulator = scene([inCore, inRing, outside])
  simulator.addOrder(1, cast(1, 'whirl', none))

  const dealt = new Map<number, number[]>()
  let firstHit: number | undefined
  let heals = 0
  let coreSlowed = false
  let ringSlow: number | undefined
  let firstFlash: number | undefined
  for (let tick = 1; tick <= 1 + whirl.lifetimeTicks + 4; tick += 1) {
    const frame = simulator.at(tick)
    heals += healsOf(frame, 1).length
    for (const id of [2, 3, 4]) {
      const amounts = damageBy(frame, 1, id).map((event) => event.amount)
      dealt.set(id, [...(dealt.get(id) ?? []), ...amounts])
      if (amounts.length > 0) firstHit ??= tick
    }
    if (flashes(frame).length > 0) {
      firstFlash ??= tick
      assert.deepEqual(flashes(frame), ['whirl-burst', 'whirl-core-burst'], 'the edge flashes, and the core')
    }
    if (tick === 2) assert.deepEqual(warnings(frame), ['whirl-core-warning', 'whirl-warning'], 'both circles are up while it charges')
    coreSlowed = coreSlowed || frame.get(2)?.getStatuses().some((status) => status.kind === 'slow') === true
    ringSlow ??= frame.get(3)?.getStatuses().find((status) => status.kind === 'slow')?.amount
  }

  assert.ok(firstHit !== undefined && firstHit >= 1 + whirl.lifetimeTicks && firstHit <= 1 + whirl.lifetimeTicks + 2, `nothing is hit until the charge is full, and then it goes off (${firstHit})`)
  assert.equal(firstFlash, firstHit, 'and it flashes on the tick it hits, and not before')
  const plain = WHIRL_DAMAGE + (WHIRL_SCALING.attackDamage ?? 0) * chain.attackDamage
  const sweet = WHIRL_SWEET_DAMAGE + (WHIRL_SWEET_SCALING.attackDamage ?? 0) * chain.attackDamage
  assert.equal(dealt.get(2)?.length, 1, 'the core is hit once')
  assert.ok(close(dealt.get(2)?.[0] ?? 0, plain), 'for the plain hit')
  assert.equal(dealt.get(3)?.length, 2, 'the ring is hit once, and the first strike is a hit of its own')
  assert.ok(close((dealt.get(3) ?? []).reduce((total, amount) => total + amount, 0), sweet + struck), 'the sweet spot, and the strike')
  assert.ok(sweet > plain, 'the edge is the worse place to be hit')
  assert.equal(coreSlowed, false, 'the core does not slow')
  assert.equal(ringSlow, WHIRL_SWEET_SLOW, 'and the ring does')
  assert.equal(heals, 1, 'the strike on the ring is the only one')
  assert.equal(dealt.get(4)?.length, 0, 'nothing outside the circles is hit')
  assert.deepEqual(warnings(simulator.at(1 + whirl.lifetimeTicks + 4)), [], 'and the circles are gone')
})

test('an enemy that touches both circles is hit as the edge: only one wholly inside the core is hit plain', () => {
  assert.ok(whirl?.lifetimeTicks)
  // The farthest a body\'s middle can be and still have all of it in the core.
  const room = WHIRL_CORE_RADIUS - bag.radius
  assert.ok(room >= chain.radius + bag.radius, 'a body fits wholly inside the core, beside Chain')
  const inside = { x: HOME.x + room, y: HOME.y }
  const reaching = { x: HOME.x, y: HOME.y - (room + 1) }
  const straddling = { x: HOME.x, y: HOME.y + WHIRL_CORE_RADIUS }
  const simulator = scene([inside, reaching, straddling])
  simulator.addOrder(1, cast(1, 'whirl', none))

  const dealt = new Map<number, number[]>()
  const slowed = new Set<number>()
  let heals = 0
  for (let tick = 1; tick <= 1 + whirl.lifetimeTicks + 4; tick += 1) {
    const frame = simulator.at(tick)
    heals += healsOf(frame, 1).length
    for (const id of [2, 3, 4]) {
      dealt.set(id, [...(dealt.get(id) ?? []), ...damageBy(frame, 1, id).map((event) => event.amount)])
      if (frame.get(id)?.getStatuses().some((status) => status.kind === 'slow')) slowed.add(id)
    }
  }

  const plain = WHIRL_DAMAGE + (WHIRL_SCALING.attackDamage ?? 0) * chain.attackDamage
  const sweet = WHIRL_SWEET_DAMAGE + (WHIRL_SWEET_SCALING.attackDamage ?? 0) * chain.attackDamage
  assert.deepEqual(dealt.get(2)?.map((amount) => close(amount, plain)), [true], 'wholly inside the core: the plain hit')
  assert.equal(slowed.has(2), false, 'and no slow')
  for (const [id, where] of [[3, 'a unit out of the core'], [4, 'half in the core and half out of it']] as const) {
    const amounts = dealt.get(id) ?? []
    assert.equal(amounts.length, 2, `${where}: the sweet spot, and the first strike`)
    assert.ok(close(amounts.reduce((total, amount) => total + amount, 0), sweet + struck), `${where}: the edge hit and not the plain one`)
    assert.equal(slowed.has(id), true, `${where}: slowed`)
  }
  assert.equal(heals, 2, 'a first strike on each of the two on the edge')
})

test('chain can walk while whirl charges, the circles are centred exactly on him all the way, and it hits where he is when it goes off, not where he cast it', () => {
  assert.ok(whirl?.lifetimeTicks)
  const walkTo = { x: HOME.x + 600, y: HOME.y }
  const end = 1 + whirl.lifetimeTicks + 1
  const midway = Math.floor(whirl.lifetimeTicks / 2)

  // Where he gets to by the time it goes off, and that the circles go with him on the way.
  const alone = scene([])
  alone.addOrder(1, cast(1, 'whirl', none))
  alone.addOrder(1, move(2, walkTo))
  const mid = alone.at(midway)
  const halfway = mid.get(1)?.getPosition() ?? HOME
  assert.ok(distance(halfway, HOME) > R, `he has walked, ${distance(halfway, HOME)}`)
  const circles = mid.getEntities().filter((entity) => entity.defId === 'whirl-warning' || entity.defId === 'whirl-core-warning')
  assert.equal(circles.length, 2)
  for (const circle of circles) assert.ok(close(distance(entityPosAt(circle, midway), halfway), 0), `each is exactly on him, not ${distance(entityPosAt(circle, midway), halfway)} off`)
  const there = alone.at(end).get(1)?.getPosition() ?? HOME

  // An enemy that is in the ring from where he ends up, and is out of reach of where he started.
  const ahead = { x: there.x + (WHIRL_CORE_RADIUS + WHIRL_RADIUS) / 2 + bag.radius, y: there.y }
  assert.ok(distance(ahead, HOME) > WHIRL_RADIUS + bag.radius, 'it is out of reach of where he cast it')
  const walking = scene([ahead])
  walking.addOrder(1, cast(1, 'whirl', none))
  walking.addOrder(1, move(2, walkTo))
  assert.ok(hp(walking.at(end + 2), 2) < bag.maxHp, 'it is hit, where he is')
  const standing = scene([ahead])
  standing.addOrder(1, cast(1, 'whirl', none))
  assert.equal(hp(standing.at(end + 2), 2), bag.maxHp, 'and not if he stays where he cast it')
})

// The ticks, up to `last`, on which an auto of Chain's lands on the target.
function autosOn(simulator: Simulator, targetId: number, last: number): number[] {
  const landed: number[] = []
  for (let tick = 1; tick <= last; tick += 1) {
    if (damageBy(simulator.at(tick), 1, targetId).some((event) => event.id.startsWith(ATTACK_SOURCE_PREFIX))) landed.push(tick)
  }
  return landed
}

test('chain cannot attack while whirl charges, and swings at his target once it is over', () => {
  assert.ok(whirl?.lifetimeTicks)
  const charged = 1 + whirl.lifetimeTicks + 1
  // One he is next to, told to attack as it starts.
  const beside = scene([{ x: HOME.x, y: HOME.y + chain.attackRange - 10 }])
  beside.addOrder(1, cast(1, 'whirl', none))
  beside.addOrder(1, attack(2, 2))
  const autos = autosOn(beside, 2, charged + 2 * chain.attackCooldownTicks)
  assert.ok(autos.length > 0, 'he attacks, after')
  assert.ok(autos[0] > charged, `and not while it charges: the first lands on ${autos[0]}, the charge is full on ${charged}`)

  // One he has to walk to: he goes after it all the same, and is in reach to swing the moment he can.
  const apart = { x: HOME.x + chain.attackRange + 80, y: HOME.y }
  const chase = (): Simulator => {
    const simulator = scene([apart])
    simulator.addOrder(1, cast(1, 'whirl', none))
    simulator.addOrder(1, attack(2, 2))
    return simulator
  }
  assert.ok(distance(chase().at(Math.floor(whirl.lifetimeTicks / 2)).get(1)?.getPosition() ?? HOME, HOME) > R, 'he walks toward it while he is disarmed')
  const later = autosOn(chase(), 2, charged + 2 * chain.attackCooldownTicks)
  assert.ok(later.length > 0 && later[0] > charged, 'and swings only when it is over')

  // Without a whirl he would have swung at once.
  const plain = scene([{ x: HOME.x, y: HOME.y + chain.attackRange - 10 }])
  plain.addOrder(1, attack(2, 2))
  assert.ok(autosOn(plain, 2, charged)[0] < charged, 'the same attack lands inside the time, if he is not whirling')
})

test('an enemy who gets out of the circles before they are full is not hit', () => {
  assert.ok(whirl?.lifetimeTicks)
  const inRing = { x: HOME.x, y: HOME.y - ((WHIRL_CORE_RADIUS + WHIRL_RADIUS) / 2 + bag.radius) }
  assert.ok(bag.moveSpeed * whirl.lifetimeTicks / GAME_TPS > WHIRL_RADIUS - WHIRL_CORE_RADIUS, 'there is time to walk out of it')
  const simulator = scene([inRing])
  simulator.addOrder(1, cast(1, 'whirl', none))
  simulator.addOrder(2, move(2, { x: inRing.x, y: inRing.y - 2000 }))
  const after = simulator.at(1 + whirl.lifetimeTicks + 4)
  assert.equal(hp(after, 2), bag.maxHp)
})

test('a stun breaks the charge of whirl, and it does not go off', () => {
  assert.ok(whirl?.lifetimeTicks)
  const drop = abilityDefs.get('hammerdrop')
  const dropWarning = getEntityDef('hammerdrop-warning')
  assert.ok(drop && dropWarning?.lifetimeTicks)
  assert.ok(drop.windUpTicks + dropWarning.lifetimeTicks + 3 < whirl.lifetimeTicks, 'the stun comes while it is still charging')
  // The other champion jumps onto him as it charges, and stuns him where he stands: right in the middle of it.
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, chain)
  const caster = { x: HOME.x + 300, y: HOME.y }
  simulator.addPlayer(2, 'p2', 'Two', caster, getChampion('hammer'))
  simulator.addOrder(1, cast(1, 'whirl', none))
  simulator.addOrder(2, cast(1, 'hammerdrop', { mode: 'point', point: HOME }, caster))

  let stunned = 0
  while (simulator.at(stunned).get(1)?.getStatuses().some((status) => status.kind === 'stun') !== true) {
    stunned += 1
    assert.ok(stunned < whirl.lifetimeTicks, 'he is stunned before it is full')
  }
  assert.deepEqual(warnings(simulator.at(stunned - 2)), ['whirl-core-warning', 'whirl-warning'], 'it was charging')
  assert.deepEqual(warnings(simulator.at(stunned + 2)), [], 'and it stops')
  const after = simulator.at(1 + whirl.lifetimeTicks + 4)
  assert.ok(distance(after.get(2)?.getPosition() ?? caster, after.get(1)?.getPosition() ?? HOME) < WHIRL_CORE_RADIUS, 'the other champion is in the middle of it')
  assert.equal(hp(after, 2), getChampion('hammer').maxHp, 'and is not hit')
})

// ---------------------------------------------------------------------------- Lunge

const lunge = abilityDefs.get('lunge')

test('lunge dashes the way it is aimed, as far as it says, with no target', () => {
  assert.ok(lunge && lunge.targeting === 'direction')
  const simulator = scene([])
  simulator.addOrder(1, cast(1, 'lunge', east))
  assert.equal(simulator.at(1).get(1)?.isDashing(), true)
  let tick = 1
  while (simulator.at(tick).get(1)?.isDashing()) tick += 1
  assert.ok(close(distance(simulator.at(tick).get(1)?.getPosition() ?? HOME, { x: HOME.x + lunge.range, y: HOME.y }), 0))
})

test('lunge quickens the attacks for a while and readies the next auto at once', () => {
  assert.ok(lunge)
  const simulator = scene([within])
  simulator.addOrder(1, attack(1, 2))
  const swung = 1 + chain.attackWindupTicks
  const at = swung + 5
  assert.ok(at < 1 + chain.attackCooldownTicks, 'it is cast between two autos')
  simulator.addOrder(1, cast(at, 'lunge', { mode: 'direction', dir: { x: 0, y: -1 } }))

  assert.ok(simulator.at(at - 1).get(1)?.getNextAttackTick() ?? 0 > at, 'the next auto was still some way off')
  const frame = simulator.at(at)
  assert.ok((frame.get(1)?.getNextAttackTick() ?? Infinity) <= at, 'and now it is ready')
  const statuses = frame.get(1)?.getStatuses() ?? []
  const buff = statuses.find((status) => status.kind === 'stat' && status.stat === 'attackSpeed')
  assert.equal(buff?.amount, LUNGE_ATTACK_SPEED)
  assert.equal(buff && buff.endTick - buff.startTick, LUNGE_BUFF_TICKS)
  assert.ok(chain.attackCooldownTicksWith(statuses) < chain.attackCooldownTicks, 'and he attacks faster')
})

test('lunge can be cast while whirl charges, and the charge goes on', () => {
  assert.ok(lunge && whirl?.lifetimeTicks)
  const simulator = scene([])
  simulator.addOrder(1, cast(1, 'whirl', none))
  const at = 5
  simulator.addOrder(1, cast(at, 'lunge', east))

  const frame = simulator.at(at)
  assert.equal(frame.get(1)?.getAbilityCooldown('lunge').ready, false, 'the lunge was cast')
  assert.equal(frame.get(1)?.isDashing(), true)
  // The circles are on him through the dash itself, and do not trail behind it.
  const dashing = simulator.at(at + 3)
  assert.equal(dashing.get(1)?.isDashing(), true, 'he is still dashing')
  const circles = dashing.getEntities().filter((entity) => entity.defId === 'whirl-warning' || entity.defId === 'whirl-core-warning')
  assert.equal(circles.length, 2)
  for (const circle of circles) assert.ok(close(distance(entityPosAt(circle, at + 3), dashing.get(1)?.getPosition() ?? HOME), 0), 'each is exactly on him')
  const later = at + Math.ceil(lunge.range / 100) + 20
  assert.ok(later < 1 + whirl.lifetimeTicks)
  const spinning = simulator.at(later)
  assert.deepEqual(warnings(spinning), ['whirl-core-warning', 'whirl-warning'], 'and the whirl is still charging')
  assert.ok(distance(spinning.get(1)?.getPosition() ?? HOME, HOME) > lunge.range / 2, 'after the lunge took him on')
})

// ---------------------------------------------------------------------------- the rest

test('chain is drawn from a sprite set of its own, with the clips a champion needs', () => {
  const set = championSprites.chain
  assert.ok(set)
  for (const clip of ['idle', 'walk', 'attack', 'cast', 'dead'] as const) assert.ok(set.clips[clip], `a ${clip}`)
})
