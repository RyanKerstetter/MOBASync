import assert from 'node:assert/strict'
import test from 'node:test'
import { championSprites } from '../apps/client/src/champion-sprites.ts'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { layoutStackPips } from '../apps/client/src/render/stack-pips.ts'
import {
  abilityDefs,
  Champion,
  GAME_MAX_CHAMPION_RADIUS,
  GAME_TPS,
  getChampion,
  getEntityDef,
  namedStatusTicksLeft,
  Simulator,
  statMultiplier,
  xpToReachLevel,
  type CastTarget,
  type CharacterOrder,
  type GameTickSnapshot,
  type Vector2,
} from '../packages/shared/src/index.ts'
import {
  DROP_MAX_TICKS,
  DROP_MIN_TICKS,
  DROP_STUN_TICKS,
  PLATING_KEY,
  PLATING_MAX_STACKS,
  PLATING_RESISTANCE_PER_STACK,
  PLATING_SCALING_PER_LEVEL,
  PLATING_TICKS,
  RAGE_ATTACK_SPEED,
  RAGE_AUTO_TICKS,
  RAGE_HASTE,
  RAGE_KEY,
  RAGE_MAX_TICKS,
  RAGE_TICKS,
} from '../packages/shared/src/abilities.ts'
import { defineMonster, economySimulator } from './fixtures.ts'

// Hammer's kit, played out in the simulator. The numbers come from the exported constants and the definitions, so retuning the kit does not break these; what they
// check is how it is meant to play.

const HOME: Vector2 = { x: 400, y: 600 }
const R = GAME_MAX_CHAMPION_RADIUS
const hammer = getChampion('hammer')
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
const within = { x: HOME.x + hammer.attackRange - 10, y: HOME.y }

let sequence = 0
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })
const cast = (tick: number, abilityId: string, target: CastTarget, origin: Vector2 = HOME): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target, origin: { ...origin } })

// Hammer is character 1, and each of the others is on a team of its own, so an enemy.
function scene(others: readonly Vector2[], other: Champion = bag): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, hammer)
  others.forEach((position, index) => simulator.addPlayer(index + 2, `p${index + 2}`, `Other ${index + 2}`, position, other))
  return simulator
}

const stacksOf = (frame: GameTickSnapshot): number => frame.get(1)?.getMarkers().filter((marker) => marker.key === PLATING_KEY).length ?? 0
const resistanceBuffs = (frame: GameTickSnapshot) =>
  frame.get(1)?.getStatuses().filter((status) => status.kind === 'stat' && status.stat === 'resistance') ?? []
const hp = (frame: GameTickSnapshot, id: number): number => frame.get(id)?.getHealth() ?? 0
const distance = (left: Vector2, right: Vector2): number => Math.hypot(left.x - right.x, left.y - right.y)
// What one stack of plating is worth to a Hammer of this level: its base, and so much more for each level (the level counts from 1).
const perStack = (level: number): number => PLATING_RESISTANCE_PER_STACK + PLATING_SCALING_PER_LEVEL * level

// ---------------------------------------------------------------------------- passive

test('each auto Hammer lands gives a stack of plating, up to the most, and every stack is the same resistance', () => {
  const simulator = scene([within])
  simulator.addOrder(1, attack(1, 2))
  const autos = PLATING_MAX_STACKS + 2
  const last = 1 + (autos - 1) * hammer.attackCooldownTicks + hammer.attackWindupTicks

  let held = 0
  for (let tick = 1; tick <= last; tick += 1) {
    const frame = simulator.at(tick)
    const now = stacksOf(frame)
    assert.ok(now === held || now === held + 1, `a stack at a time, not ${held} then ${now}`)
    assert.ok(now <= PLATING_MAX_STACKS, 'never past the most')
    const buffs = resistanceBuffs(frame)
    assert.equal(buffs.length, now > 0 ? 1 : 0, 'one buff that every auto renews, and not one for each auto')
    if (now > 0) assert.equal(buffs[0].amount, now * perStack(1), `${now} stacks`)
    held = now
  }
  assert.equal(held, PLATING_MAX_STACKS, 'the stacks reach the most, and the autos after that keep them there')
  assert.ok(hp(simulator.at(last), 2) > 0, 'and the fight was still on')
})

test('plating takes its share off the hits Hammer takes, by the resistance the stacks add', () => {
  const attacker = getChampion('hammer')
  // Another Hammer hits this one, with no plating of his own yet, or after he has hit something enough times to have the most.
  const taken = (stacked: boolean): number => {
    const simulator = new Simulator()
    simulator.addPlayer(1, 'p1', 'One', HOME, hammer)
    simulator.addPlayer(2, 'p2', 'Two', within, bag)
    simulator.addPlayer(3, 'p3', 'Three', { x: HOME.x, y: HOME.y + attacker.attackRange - 10 }, attacker)
    let hitAt = 1
    if (stacked) {
      simulator.addOrder(1, attack(1, 2))
      // The tick the last stack is on, and the stop after it, so the stacks have time left when the hit comes.
      hitAt = 1 + (PLATING_MAX_STACKS - 1) * hammer.attackCooldownTicks + hammer.attackWindupTicks
      simulator.addOrder(1, move(hitAt + 1, HOME))
      assert.ok(PLATING_TICKS > attacker.attackWindupTicks + 5, 'they are still there')
    }
    simulator.addOrder(3, attack(hitAt + 1, 1))
    const landing = hitAt + 1 + attacker.attackWindupTicks
    if (stacked) assert.equal(stacksOf(simulator.at(landing - 1)), PLATING_MAX_STACKS, 'the most stacks are on when it lands')
    return hammer.maxHp - hp(simulator.at(landing), 1)
  }

  const plain = taken(false)
  assert.equal(plain, Math.round(attacker.attackDamage * statMultiplier(hammer.statsAt(1).resistance)), 'a hit with no plating')
  const resistance = hammer.statsAt(1).resistance + PLATING_MAX_STACKS * perStack(1)
  assert.equal(taken(true), Math.round(attacker.attackDamage * statMultiplier(resistance)), 'and with the most')
  assert.ok(taken(true) < plain)
})

test('what a stack of plating is worth grows with Hammer\'s level, from the first auto he lands after he gains it', () => {
  const level = 5
  // A monster worth enough to take him to that level, that dies to one auto and stands next to him.
  const feed = defineMonster({
    id: 't-hm-feed',
    name: 'Feed',
    base: { maxHp: 1, attackDamage: 1, attackSpeed: 1 },
    moveSpeed: 100,
    radius: 20,
    attackRange: 60,
    attackWindup: 0,
    abilities: [],
    ai: { aggroRange: 0, deaggroRange: 300 },
    reward: { gold: 0, xp: xpToReachLevel(level), shards: 0 },
  })
  const simulator = economySimulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, hammer, 1)
  simulator.addPlayer(2, 'p2', 'Two', within, bag, 2)
  simulator.addMonster(10, feed, { x: HOME.x, y: HOME.y + 60 })
  simulator.addOrder(1, attack(1, 10))
  const killed = 1 + hammer.attackWindupTicks
  simulator.addOrder(1, attack(killed + 1, 2))

  const amounts: Array<{ stacks: number; level: number; amount: number }> = []
  for (let tick = 1; tick <= killed + 1 + 4 * hammer.attackCooldownTicks; tick += 1) {
    const frame = simulator.at(tick)
    const stacks = stacksOf(frame)
    if (stacks > 0) amounts.push({ stacks, level: frame.get(1)?.getLevel() ?? 1, amount: resistanceBuffs(frame)[0]?.amount ?? 0 })
  }

  assert.equal(simulator.at(simulator.latestSnapshotTick).get(1)?.getLevel(), level, 'the kill took him to that level')
  // The kill pays the level on the tick the stack goes on, so the frame already reads the new level, but the stack was worked out before it.
  assert.deepEqual([amounts[0].stacks, amounts[0].amount], [1, perStack(1)], 'the first stack was worth what it was at the level he was')
  const grown = amounts.filter(({ stacks }) => stacks >= 2)
  assert.ok(grown.length > 0, 'and he has more stacks after')
  assert.ok(grown.every((each) => each.level === level && each.amount === each.stacks * perStack(level)), `each stack is worth ${perStack(level)} at level ${level}: ${JSON.stringify(grown[0])}`)
  assert.ok(perStack(level) > perStack(1), 'a higher level is worth more')
})

test('plating ends all at once, the time it lasts after the last auto, and an auto in between renews it', () => {
  const simulator = scene([within])
  simulator.addOrder(1, attack(1, 2))
  const second = 1 + hammer.attackCooldownTicks + hammer.attackWindupTicks
  // The third auto starts after this, so it never comes.
  simulator.addOrder(1, move(second + 1, HOME))

  assert.equal(stacksOf(simulator.at(second)), 2)
  const end = second + PLATING_TICKS
  assert.equal(stacksOf(simulator.at(end - 1)), 2, 'still there the tick before')
  assert.equal(resistanceBuffs(simulator.at(end - 1)).length, 1)
  assert.equal(stacksOf(simulator.at(end)), 0, 'gone on the tick it runs out')
  assert.equal(resistanceBuffs(simulator.at(end)).length, 0, 'the resistance goes with it')
})

// ---------------------------------------------------------------------------- Rage

test('rage gives move speed and attack speed for as long as it lasts, and then all of it ends together', () => {
  const simulator = scene([])
  simulator.addOrder(1, cast(1, 'rage', { mode: 'none' }))
  const frame = simulator.at(1)
  const statuses = frame.get(1)?.getStatuses() ?? []

  assert.equal(statuses.find((status) => status.kind === 'haste')?.amount, RAGE_HASTE)
  assert.equal(statuses.find((status) => status.kind === 'stat' && status.stat === 'attackSpeed')?.amount, RAGE_ATTACK_SPEED)
  assert.equal(namedStatusTicksLeft(statuses, 1, RAGE_KEY, 1), RAGE_TICKS)
  assert.ok(hammer.attackCooldownTicksWith(statuses) < hammer.attackCooldownTicks, 'it attacks faster')

  const end = 1 + RAGE_TICKS
  assert.equal(simulator.at(end - 1).get(1)?.getStatuses().length, statuses.length, 'all of it is there the tick before')
  assert.deepEqual(simulator.at(end).get(1)?.getStatuses(), [], 'and ends on the same tick')
})

test('a raging Hammer walks faster, by the move speed rage gives', () => {
  const walked = (raging: boolean): number => {
    const simulator = scene([])
    if (raging) simulator.addOrder(1, cast(1, 'rage', { mode: 'none' }))
    simulator.addOrder(1, move(2, { x: HOME.x + 1000, y: HOME.y }))
    return distance(simulator.at(2 + GAME_TPS).get(1)?.getPosition() ?? HOME, HOME)
  }
  assert.ok(Math.abs(walked(true) / walked(false) - (1 + RAGE_HASTE)) < 0.02)
})

test('each auto Hammer lands makes a rage last longer, up to the most it can have left, and an auto with no rage starts none', () => {
  const simulator = scene([within])
  simulator.addOrder(1, cast(1, 'rage', { mode: 'none' }))
  simulator.addOrder(1, attack(2, 2))
  const left = (tick: number): number => namedStatusTicksLeft(simulator.at(tick).get(1)?.getStatuses() ?? [], 1, RAGE_KEY, tick)

  // The tick of the first auto is the first on which the end of the rage moves. Its windup is shorter than usual: the rage is quickening it.
  let landed = 2
  while (left(landed) + landed === 1 + RAGE_TICKS) landed += 1
  const windup = hammer.attackWindupTicksWith(simulator.at(2).get(1)?.getStatuses() ?? [])
  assert.equal(landed, 2 + windup, 'the auto that lands is the one that moves it')
  assert.equal(left(landed) + landed, Math.min(1 + RAGE_TICKS + RAGE_AUTO_TICKS, landed + RAGE_MAX_TICKS))
  const statuses = simulator.at(landed).get(1)?.getStatuses() ?? []
  const ends = statuses.filter((status) => status.kind === 'haste' || status.kind === 'resist' || (status.kind === 'stat' && status.stat === 'attackSpeed'))
  assert.equal(new Set(ends.map((status) => status.endTick)).size, 1, 'and all of it is made longer together')
  assert.ok(ends.length >= 2, 'the move speed and the attack speed')

  const plain = scene([within])
  plain.addOrder(1, attack(1, 2))
  for (let tick = 1; tick <= 1 + hammer.attackCooldownTicks * 3; tick += 1) {
    assert.equal(namedStatusTicksLeft(plain.at(tick).get(1)?.getStatuses() ?? [], 1, RAGE_KEY, tick), 0, 'no rage to feed')
  }
})

test('Hammer\'s rage bar shows what is left of the rage as a share of the most, and runs down to nothing', () => {
  const state = new ClientGameState()
  state.simulator.addPlayer(1, 'p1', 'One', HOME, hammer)
  state.setLocalCharacterId(1)
  state.resetServerTickAnchor(0, 0)
  state.simulator.addOrder(1, cast(1, 'rage', { mode: 'none' }))
  const meterAt = (tick: number) => {
    state.simulator.advanceTo(tick)
    return state.getCharacters(tick * 1000 / GAME_TPS).find((character) => character.id === 1)?.meter
  }

  assert.equal(meterAt(0), undefined, 'no bar before there is a rage')
  const fractions = [2, 3, 20, 100, RAGE_TICKS].map((tick) => {
    const meter = meterAt(tick)
    assert.ok(meter, `a bar at ${tick}`)
    assert.equal(meter.color, hammer.meter?.color)
    assert.ok(Math.abs(meter.fraction - (1 + RAGE_TICKS - tick) / RAGE_MAX_TICKS) < 1e-9, `${tick}: ${meter.fraction}`)
    return meter.fraction
  })
  assert.deepEqual([...fractions].sort((left, right) => right - left), fractions, 'it only runs down')
  assert.equal(meterAt(1 + RAGE_TICKS), undefined, 'and is gone when the rage is')

  const other = new ClientGameState()
  other.simulator.addPlayer(1, 'p1', 'One', HOME, getChampion('cursebearer'))
  other.simulator.advanceTo(5)
  assert.equal(other.getCharacters(5 * 1000 / GAME_TPS)[0].meter, undefined, 'a champion with no meter has no bar')
})

// ---------------------------------------------------------------------------- Slam

test('slam hurts and slows the enemies in front of Hammer, along its length and width, and nobody else', () => {
  const def = abilityDefs.get('slam')
  assert.ok(def?.indicator?.width)
  const halfWidth = def.indicator.width / 2
  const front = { x: HOME.x + def.range / 2, y: HOME.y }
  const behind = { x: HOME.x - (2 * R + 10), y: HOME.y }
  const beside = { x: front.x, y: HOME.y + halfWidth + 2 * R + 10 }
  const beyond = { x: HOME.x + def.range + 2 * R + 10, y: HOME.y }
  const simulator = scene([front, behind, beside, beyond])
  simulator.addOrder(1, cast(1, 'slam', { mode: 'direction', dir: { x: 1, y: 0 } }))

  const frame = simulator.at(1 + def.windUpTicks + 1)
  assert.ok(hp(frame, 2) < bag.maxHp, 'the one in front is hurt')
  assert.ok(frame.get(2)?.getStatuses().some((status) => status.kind === 'slow'), 'and slowed')
  for (const [id, where] of [[3, 'behind'], [4, 'beside'], [5, 'beyond']] as const) {
    assert.equal(hp(frame, id), bag.maxHp, `the one ${where} is not hurt`)
    assert.deepEqual(frame.get(id)?.getStatuses(), [], `or slowed`)
  }
})

// ---------------------------------------------------------------------------- Hammer Drop

const drop = abilityDefs.get('hammerdrop')
const warning = getEntityDef('hammerdrop-warning')

// A jump to a point this far away: how long its warning lasts, and how many ticks the jump takes from the one its windup finishes on, to the one Hammer is back
// on the ground.
function dropTo(reach: number): { warning: number; air: number; target: Vector2 } {
  assert.ok(drop)
  const target = { x: HOME.x + reach, y: HOME.y }
  const simulator = scene([])
  simulator.addOrder(1, cast(1, 'hammerdrop', { mode: 'point', point: target }))
  const launched = 1 + drop.windUpTicks
  const out = simulator.at(launched).getEntities().find((entity) => entity.defId === 'hammerdrop-warning')
  assert.ok(out?.lifetimeTicks, 'the warning is up as the jump starts')
  assert.deepEqual(out.origin, target, 'on the point that was aimed at')
  assert.equal(simulator.at(launched).get(1)?.isDashing(), true, 'and he is in the air as soon as it launches')
  let tick = launched
  while (simulator.at(tick).get(1)?.isDashing()) tick += 1
  return { warning: out.lifetimeTicks, air: tick - launched, target }
}

test('hammer drop is a jump with a warning on the spot it lands, and the jump takes as long as the warning', () => {
  assert.ok(drop?.indicator?.radius && warning)
  assert.equal(warning.visual, 'telegraph')
  for (const share of [0.1, 0.5, 1]) {
    const { warning: shown, air } = dropTo(drop.range * share)
    assert.ok(Math.abs(air - shown) <= 2, `a jump of ${share} of the way takes ${air} ticks, and its warning lasts ${shown}`)
  }
})

test('the nearer hammer drop is aimed, the less time the jump takes, from the shortest at his feet to the longest at the farthest he can aim', () => {
  assert.ok(drop && DROP_MIN_TICKS < DROP_MAX_TICKS)
  const shares = [0.02, 0.25, 0.5, 0.75, 1]
  const warnings = shares.map((share) => dropTo(drop.range * share).warning)
  const jumps = shares.map((share) => dropTo(drop.range * share).air)
  assert.ok(warnings.every((ticks, index) => index === 0 || ticks >= warnings[index - 1]), `farther is never quicker: ${warnings}`)
  assert.ok(jumps.every((ticks, index) => index === 0 || ticks >= jumps[index - 1]), `and so for the jump: ${jumps}`)
  assert.ok(warnings[warnings.length - 1] > warnings[0] && jumps[jumps.length - 1] > jumps[0], 'a near drop is quicker than a far one')
  assert.equal(warnings[warnings.length - 1], DROP_MAX_TICKS, 'the farthest takes the longest')
  assert.ok(warnings[0] >= DROP_MIN_TICKS && warnings[0] <= DROP_MIN_TICKS + 1, `and one at his feet takes the shortest: ${warnings[0]}`)
})

test('hammer drop lands on the aimed point, and stuns and hurts whoever is on it, and spares who is outside it', () => {
  assert.ok(drop?.indicator?.radius)
  const radius = drop.indicator.radius
  const target = { x: HOME.x + drop.range, y: HOME.y }
  // Inside it, and clear of the body that comes down on the middle.
  const inside = { x: target.x + Math.max(radius / 2, 2 * R + 5), y: target.y }
  const outside = { x: target.x, y: target.y + radius + 2 * R + 10 }
  const simulator = scene([inside, outside])
  simulator.addOrder(1, cast(1, 'hammerdrop', { mode: 'point', point: target }))
  const launched = 1 + drop.windUpTicks
  let landed = launched
  while (simulator.at(landed).get(1)?.isDashing()) landed += 1

  assert.ok(distance(simulator.at(landed).get(1)?.getPosition() ?? HOME, target) < 1, 'he comes down on the point')
  assert.equal(hp(simulator.at(landed), 2), bag.maxHp, 'nothing is hurt before the warning runs out')
  const after = simulator.at(landed + 3)
  assert.ok(hp(after, 2) < bag.maxHp, 'whoever is inside is hurt')
  const stun = after.get(2)?.getStatuses().find((status) => status.kind === 'stun')
  assert.equal(stun && stun.endTick - stun.startTick, DROP_STUN_TICKS, 'and stunned')
  assert.equal(hp(after, 3), bag.maxHp, 'whoever is outside is not')
  assert.deepEqual(after.get(3)?.getStatuses(), [])
})

test('an enemy who walks out of the warning before it goes off is not hit', () => {
  assert.ok(drop?.indicator?.radius && warning?.lifetimeTicks)
  const radius = drop.indicator.radius
  assert.ok(bag.moveSpeed * warning.lifetimeTicks / GAME_TPS > bag.radius, 'there is time to walk out of it')
  const target = { x: HOME.x + drop.range, y: HOME.y }
  // On the edge of it, walking away.
  const edge = { x: target.x + radius, y: target.y }
  const simulator = scene([edge])
  simulator.addOrder(1, cast(1, 'hammerdrop', { mode: 'point', point: target }))
  simulator.addOrder(2, move(2, { x: edge.x + 1000, y: edge.y }))
  const after = simulator.at(1 + drop.windUpTicks + warning.lifetimeTicks + 5)

  assert.equal(hp(after, 2), bag.maxHp)
  assert.equal(after.get(2)?.getStatuses().some((status) => status.kind === 'stun'), false)
})

// ---------------------------------------------------------------------------- the rest

test('hammer\'s passive stacks are drawn as its own round pips', () => {
  const pips = layoutStackPips({ [PLATING_KEY]: PLATING_MAX_STACKS }, hammer.radius)
  assert.equal(pips.length, PLATING_MAX_STACKS)
  assert.ok(pips.every((pip) => pip.shape === 'circle'))
})

test('hammer is drawn from a sprite set of its own, with the clips a champion needs', () => {
  const set = championSprites.hammer
  assert.ok(set)
  for (const clip of ['idle', 'walk', 'attack', 'cast', 'dead'] as const) assert.ok(set.clips[clip], `a ${clip}`)
})
