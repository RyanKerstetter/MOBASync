import assert from 'node:assert/strict'
import test from 'node:test'
import { championSprites } from '../apps/client/src/champion-sprites.ts'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { layoutStackPips } from '../apps/client/src/render/stack-pips.ts'
import {
  abilityDefs,
  Champion,
  GAME_MAX_CHAMPION_RADIUS,
  getChampion,
  Simulator,
  type CastTarget,
  type CharacterOrder,
  type GameTickSnapshot,
  type Vector2,
} from '../packages/shared/src/index.ts'
import {
  PULSE_DAMAGE,
  PULSE_DAMAGE_SCALING,
  PULSE_HEAL,
  PULSE_HEAL_SCALING,
  PULSE_RADIUS,
  REJUVENATE_HEAL,
  REJUVENATE_MISSING,
  REJUVENATE_SCALING,
  SAGE_HASTE,
  SAGE_HEAL,
  SAGE_HEAL_SCALING,
  SAGE_KEY,
  VINE_DAMAGE,
  VINE_ROOT_TICKS,
  VINE_SCALING,
} from '../packages/shared/src/abilities.ts'
import { loseHealth } from '../packages/shared/src/effects.ts'
import { defineAbility, killAt } from './fixtures.ts'

// Sage's kit, played out in the simulator: the pulse that heals and shoves, the bolt that goes through and roots, the heal on a teammate (or herself), and the passive that marks enemies for
// her autos to feed on. The numbers come from the exported constants and the definitions, so retuning the kit does not break these; what they check is how it is meant to play. The bodies
// she is played against are the test's own.

const HOME: Vector2 = { x: 400, y: 600 }
const R = GAME_MAX_CHAMPION_RADIUS
const sage = getChampion('sage')

// A body that takes whatever it is given and stays where it is put.
const bag = new Champion({
  id: 't-sage-bag',
  name: 'Test Bag',
  base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 140,
  radius: R,
  attackRange: 50,
  attackWindup: 0,
  abilities: [],
})

// A teammate that can be wounded by its own hand: it loses most of its health the moment it is told to.
const WOUND = 1900
defineAbility({
  id: 't-sage-wound',
  targeting: 'none',
  range: 0,
  windUpTicks: 0,
  cooldownTicks: 6000,
  apply: [loseHealth(WOUND)],
})
const patient = new Champion({
  id: 't-sage-patient',
  name: 'Test Patient',
  base: { maxHp: 2000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 140,
  radius: 20,
  attackRange: 50,
  attackWindup: 0,
  abilities: ['t-sage-wound'],
})

// Hits whoever it is told to once, hard, and then so slowly that it never does again: how Sage is hurt, so there is health to heal.
const BRUTE_DAMAGE = 600
const brute = new Champion({
  id: 't-sage-brute',
  name: 'Test Brute',
  base: { maxHp: 1_000_000, attackDamage: BRUTE_DAMAGE, attackSpeed: 0.01 },
  moveSpeed: 140,
  radius: 20,
  attackRange: 400,
  attackWindup: 0,
  abilities: [],
})

let sequence = 0
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const cast = (tick: number, abilityId: string, target: CastTarget, origin: Vector2 = HOME): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target, origin: { ...origin } })
const none: CastTarget = { mode: 'none' }
const east: CastTarget = { mode: 'direction', dir: { x: 1, y: 0 } }
const at = (unitId: number): CastTarget => ({ mode: 'unit', unitId })
// The tick a cast ordered on `tick` goes off.
const goesOff = (abilityId: string, tick: number): number => tick + (abilityDefs.get(abilityId)?.windUpTicks ?? 0)
// By this tick a Vine Bolt cast on tick 10 has gone off, flown the couple of hundred units to the enemy, and mended it, with time to spare: where the autos begin.
const MENDED = goesOff('vinebolt', 10) + 40

// Sage is character 1, on team 1; each of the others is on a team of its own unless it says, so an enemy.
type Other = { at: Vector2; who?: Champion; team?: number }
function scene(others: readonly Other[]): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, sage, 1)
  others.forEach((other, index) => {
    simulator.addPlayer(index + 2, `p${index + 2}`, `Other ${index + 2}`, other.at, other.who ?? bag, other.team ?? index + 2)
  })
  return simulator
}

const hp = (frame: GameTickSnapshot, id: number): number => frame.get(id)?.getHealth() ?? 0
const status = (frame: GameTickSnapshot, id: number, kind: string) => frame.get(id)?.getStatuses().find((each) => each.kind === kind)
const marks = (frame: GameTickSnapshot, id: number, key: string) => frame.get(id)?.getMarkers().filter((marker) => marker.key === key) ?? []
const where = (frame: GameTickSnapshot, id: number): Vector2 => frame.get(id)?.getPosition() ?? HOME
const distance = (left: Vector2, right: Vector2): number => Math.hypot(left.x - right.x, left.y - right.y)
const east_ = (reach: number, across = 0): Vector2 => ({ x: HOME.x + reach, y: HOME.y + across })

const pulseHeal = Math.round(PULSE_HEAL + (PULSE_HEAL_SCALING.arcane ?? 0) * sage.arcane)
const pulseDamage = Math.round(PULSE_DAMAGE + (PULSE_DAMAGE_SCALING.arcane ?? 0) * sage.arcane)
const vineDamage = Math.round(VINE_DAMAGE + (VINE_SCALING.arcane ?? 0) * sage.arcane)
const passiveHeal = Math.round(SAGE_HEAL + (SAGE_HEAL_SCALING.arcane ?? 0) * sage.arcane)

// ---------------------------------------------------------------------------- Heal Pulse

test('heal pulse heals the allies in it and not the ones outside it', () => {
  const near = east_(PULSE_RADIUS / 2)
  const far = east_(PULSE_RADIUS + patient.radius + 80)
  const simulator = scene([{ at: near, who: patient, team: 1 }, { at: far, who: patient, team: 1 }])
  simulator.addOrder(2, cast(1, 't-sage-wound', none, near))
  simulator.addOrder(3, cast(1, 't-sage-wound', none, far))
  simulator.addOrder(1, cast(10, 'pulse', none))

  const landing = goesOff('pulse', 10)
  const wounded = simulator.at(landing - 1)
  assert.equal(hp(wounded, 2), patient.maxHp - WOUND, 'the one near is wounded')
  const frame = simulator.at(landing)
  assert.equal(hp(frame, 2), patient.maxHp - WOUND + pulseHeal, 'and healed by what the pulse says')
  assert.equal(hp(frame, 3), patient.maxHp - WOUND, 'the one outside is not')
})

test('heal pulse hurts, shoves back and mends the enemies in it, and leaves the ones outside alone', () => {
  const inside = east_(PULSE_RADIUS / 2)
  const outside = east_(PULSE_RADIUS + R + 80, 0)
  const simulator = scene([{ at: inside }, { at: outside }])
  simulator.addOrder(1, cast(10, 'pulse', none))

  const landing = goesOff('pulse', 10)
  const frame = simulator.at(landing)
  assert.equal(hp(frame, 2), bag.maxHp - pulseDamage, 'the one inside is hurt')
  assert.equal(hp(frame, 3), bag.maxHp, 'the one outside is not')
  assert.equal(marks(frame, 2, SAGE_KEY).length, 1, 'the one inside is mended')
  assert.equal(marks(frame, 2, SAGE_KEY)[0]?.ownerId, 1, 'by Sage')
  assert.equal(marks(frame, 3, SAGE_KEY).length, 0, 'the one outside is not')

  // The push takes a moment to play out, and is away from her.
  const settled = simulator.at(landing + 60)
  assert.ok(distance(where(settled, 2), HOME) > distance(inside, HOME), 'the one inside is shoved away from her')
  assert.deepEqual(where(settled, 3), outside, 'and the one outside stays put')
})

// ---------------------------------------------------------------------------- Vine Bolt

test('vine bolt goes through every enemy on its line, hurting, rooting and mending each, and misses the ones off it', () => {
  const simulator = scene([{ at: east_(150) }, { at: east_(300) }, { at: east_(200, 200) }])
  simulator.addOrder(1, cast(10, 'vinebolt', east))

  const frame = simulator.at(goesOff('vinebolt', 10) + 40)
  for (const id of [2, 3]) {
    assert.equal(hp(frame, id), bag.maxHp - vineDamage, `enemy ${id} is hurt, and only once`)
    assert.ok(status(frame, id, 'root'), `enemy ${id} is rooted`)
    assert.equal(marks(frame, id, SAGE_KEY).length, 1, `enemy ${id} is mended`)
  }
  const rooted = status(frame, 2, 'root')
  assert.equal(rooted && rooted.endTick - rooted.startTick, VINE_ROOT_TICKS)
  assert.equal(hp(frame, 4), bag.maxHp, 'the one off the line is not hurt')
  assert.equal(status(frame, 4, 'root'), undefined, 'or rooted')
  assert.equal(marks(frame, 4, SAGE_KEY).length, 0, 'or mended')
})

test('an enemy hit by both the pulse and the bolt carries one mend, not two', () => {
  const simulator = scene([{ at: east_(100) }])
  simulator.addOrder(1, cast(10, 'pulse', none))
  simulator.addOrder(1, cast(40, 'vinebolt', east))

  const frame = simulator.at(goesOff('vinebolt', 40) + 40)
  assert.ok(hp(frame, 2) < bag.maxHp - pulseDamage, 'both landed')
  assert.equal(marks(frame, 2, SAGE_KEY).length, 1)
})

// ---------------------------------------------------------------------------- Rejuvenate

test('rejuvenate heals a teammate for a set amount and a share of what they are missing, from any distance in reach', () => {
  const rejuvenate = abilityDefs.get('rejuvenate')
  assert.ok(rejuvenate?.targetsAllies, 'it is aimed at allies')
  const ally = { x: HOME.x, y: HOME.y + rejuvenate.range - 50 }
  const simulator = scene([{ at: ally, who: patient, team: 1 }])
  simulator.addOrder(2, cast(1, 't-sage-wound', none, ally))
  simulator.addOrder(1, cast(10, 'rejuvenate', at(2)))

  const landing = goesOff('rejuvenate', 10)
  const expected = Math.round(REJUVENATE_HEAL + (REJUVENATE_SCALING.arcane ?? 0) * sage.arcane + REJUVENATE_MISSING * WOUND)
  assert.equal(hp(simulator.at(landing), 2) - hp(simulator.at(landing - 1), 2), expected)
})

test('rejuvenate can be cast on herself, and heals her for what she is missing too', () => {
  const simulator = scene([{ at: east_(250), who: brute }])
  simulator.addOrder(2, attack(1, 1))
  simulator.addOrder(1, cast(10, 'rejuvenate', at(1)))

  const landing = goesOff('rejuvenate', 10)
  const missing = BRUTE_DAMAGE
  assert.equal(hp(simulator.at(landing - 1), 1), sage.maxHp - missing, 'she was hurt')
  const expected = Math.round(REJUVENATE_HEAL + (REJUVENATE_SCALING.arcane ?? 0) * sage.arcane + REJUVENATE_MISSING * missing)
  assert.equal(hp(simulator.at(landing), 1) - hp(simulator.at(landing - 1), 1), expected)
})

test('rejuvenate cannot be cast on an enemy: it is dropped and nothing is spent', () => {
  const simulator = scene([{ at: east_(100), who: brute }])
  simulator.addOrder(2, attack(1, 1))
  simulator.addOrder(1, cast(10, 'rejuvenate', at(2)))

  const frame = simulator.at(goesOff('rejuvenate', 10) + 5)
  assert.equal(hp(frame, 1), sage.maxHp - BRUTE_DAMAGE, 'she is not healed')
  assert.equal(frame.get(1)?.getAbilityCooldown('rejuvenate').ready, true, 'and it was not spent')
})

test('rejuvenate aimed at a teammate out of reach walks her up to them and casts there', () => {
  const rejuvenate = abilityDefs.get('rejuvenate')
  assert.ok(rejuvenate)
  const far = { x: HOME.x, y: HOME.y + rejuvenate.range + 200 }
  const simulator = scene([{ at: far, who: patient, team: 1 }])
  simulator.addOrder(2, cast(1, 't-sage-wound', none, far))
  simulator.addOrder(1, cast(10, 'rejuvenate', at(2)))

  assert.equal(simulator.at(12).get(1)?.getAbilityCooldown('rejuvenate').ready, true, 'not cast yet: out of reach')
  let castAt: number | undefined
  for (let tick = 11; tick <= 200 && castAt === undefined; tick += 1) {
    if (simulator.at(tick).get(1)?.getAbilityCooldown('rejuvenate').ready === false) castAt = tick
  }
  assert.ok(castAt, 'it is cast once she has walked up')
  assert.ok(distance(where(simulator.at(castAt), 1), far) <= rejuvenate.range + 1e-6, 'from within reach')
  assert.ok(hp(simulator.at(castAt + rejuvenate.windUpTicks + 2), 2) > patient.maxHp - WOUND, 'and they are healed')
})

// ---------------------------------------------------------------------------- the passive

test('an auto on a mended enemy heals Sage and quickens her and uses up the mend, so the next one heals nothing; one on an unmended enemy does neither', () => {
  const mended = east_(200)
  const plain = { x: HOME.x - 200, y: HOME.y }
  const simulator = scene([{ at: mended }, { at: plain }, { at: east_(250, 400), who: brute }])
  // She is hurt first, so there is health to give back, and then mends the one to the east with the bolt.
  simulator.addOrder(4, attack(1, 1))
  simulator.addOrder(1, cast(10, 'vinebolt', east))

  // The first tick after `after` that an auto lands on the target, and what it gave Sage back.
  const nextHit = (targetId: number, after: number): { tick: number; heal: number } | undefined => {
    let before = hp(simulator.at(after), targetId)
    for (let tick = after + 1; tick <= after + 200; tick += 1) {
      const frame = simulator.at(tick)
      const now = hp(frame, targetId)
      if (now < before) return { tick, heal: hp(frame, 1) - hp(simulator.at(tick - 1), 1) }
      before = now
    }
    return undefined
  }

  simulator.addOrder(1, attack(MENDED, 2))
  const landed = nextHit(2, MENDED)
  assert.ok(landed, 'the auto on the mended enemy lands')
  assert.equal(landed.heal, passiveHeal, 'and heals her by what the passive says')
  const frame = simulator.at(landed.tick)
  const quickened = status(frame, 1, 'haste')
  assert.equal(quickened?.amount, SAGE_HASTE)
  assert.equal(marks(simulator.at(landed.tick - 1), 2, SAGE_KEY).length, 1, 'the enemy was mended until that auto')
  assert.equal(marks(frame, 2, SAGE_KEY).length, 0, 'and the auto used the mend up')

  // She goes on hitting it, and the next auto finds it unmended.
  const second = nextHit(2, landed.tick)
  assert.ok(second, 'the next auto lands')
  assert.equal(second.heal, 0, 'and heals nothing')
  assert.equal(marks(simulator.at(second.tick), 2, SAGE_KEY).length, 0, 'and there is nothing to use up')

  // The same auto on the one she has not mended heals nothing. She walks over to it first, so no time is lost to the first one's mend.
  const unmended = new Simulator()
  unmended.addPlayer(1, 'p1', 'One', HOME, sage, 1)
  unmended.addPlayer(2, 'p2', 'Two', plain, bag, 2)
  unmended.addPlayer(3, 'p3', 'Three', east_(250, 400), brute, 3)
  unmended.addOrder(3, attack(1, 1))
  unmended.addOrder(1, attack(MENDED, 2))
  let landedAt: number | undefined
  for (let tick = MENDED + 1; tick <= MENDED + 120 && landedAt === undefined; tick += 1) {
    if (hp(unmended.at(tick), 2) < bag.maxHp) landedAt = tick
  }
  assert.ok(landedAt, 'the auto lands')
  assert.equal(hp(unmended.at(landedAt), 1), hp(unmended.at(landedAt - 1), 1), 'and heals nothing')
  assert.equal(status(unmended.at(landedAt), 1, 'haste'), undefined, 'or quickens her')
})

// Anyone on her side can use her mends up: an auto of a teammate on a mended enemy heals and quickens them, by what her passive is worth (her arcane, not theirs), and uses up her mend.

// A ranged teammate with a good deal of arcane, so a heal worked out from the wrong one would show, that can wound itself to have health to be given back.
const ALLY_ARCANE = 400
const striker = new Champion({
  id: 't-sage-striker',
  name: 'Test Striker',
  base: { maxHp: 2000, attackDamage: 10, attackSpeed: 1, arcane: ALLY_ARCANE },
  moveSpeed: 140,
  radius: 20,
  attackRange: 300,
  attackWindup: 0,
  abilities: ['t-sage-wound'],
})
const STRIKER_AT: Vector2 = { x: HOME.x + 40, y: HOME.y + 90 }

// The first tick after `after` that something has taken a hit, and so how much it cost.
const hitAfter = (simulator: Simulator, targetId: number, after: number): number | undefined => {
  const start = hp(simulator.at(after), targetId)
  for (let tick = after + 1; tick <= after + 200; tick += 1) {
    if (hp(simulator.at(tick), targetId) < start) return tick
  }
  return undefined
}
const gained = (simulator: Simulator, id: number, tick: number): number => hp(simulator.at(tick), id) - hp(simulator.at(tick - 1), id)

test('an auto from a teammate of Sage on a mended enemy heals them and quickens them, by what her passive is worth, and uses the mend up; Sage gets nothing', () => {
  const simulator = scene([{ at: east_(200) }, { at: STRIKER_AT, who: striker, team: 1 }, { at: east_(250, 400), who: brute }])
  simulator.addOrder(3, cast(1, 't-sage-wound', none, STRIKER_AT))
  simulator.addOrder(4, attack(1, 1))
  simulator.addOrder(1, cast(10, 'vinebolt', east))
  simulator.addOrder(3, attack(MENDED, 2))

  const landed = hitAfter(simulator, 2, MENDED - 1)
  assert.ok(landed, 'the teammate\'s auto lands')
  assert.equal(marks(simulator.at(landed - 1), 2, SAGE_KEY).length, 1, 'the enemy was mended')
  assert.ok(hp(simulator.at(landed - 1), 3) < striker.maxHp, 'and the teammate was hurt')
  assert.equal(gained(simulator, 3, landed), passiveHeal, 'it heals the teammate by Sage\'s passive, with her arcane and not their own')
  assert.notEqual(passiveHeal, Math.round(SAGE_HEAL + (SAGE_HEAL_SCALING.arcane ?? 0) * ALLY_ARCANE), 'which is not what their own would have made of it')
  assert.equal(status(simulator.at(landed), 3, 'haste')?.amount, SAGE_HASTE, 'and quickens them')
  assert.equal(marks(simulator.at(landed), 2, SAGE_KEY).length, 0, 'the mend is used up')
  assert.equal(gained(simulator, 1, landed), 0, 'Sage, who has not made the auto, is not healed')
  assert.equal(status(simulator.at(landed), 1, 'haste'), undefined, 'or quickened')

  const second = hitAfter(simulator, 2, landed)
  assert.ok(second, 'they go on hitting it')
  assert.equal(gained(simulator, 3, second), 0, 'and the next auto finds nothing to use')
})

test('an auto from someone who is not on Sage\'s side leaves her mend alone, and heals and quickens no one', () => {
  const simulator = scene([{ at: east_(200) }, { at: STRIKER_AT, who: striker, team: 3 }])
  simulator.addOrder(3, cast(1, 't-sage-wound', none, STRIKER_AT))
  simulator.addOrder(1, cast(10, 'vinebolt', east))
  simulator.addOrder(3, attack(MENDED, 2))

  const landed = hitAfter(simulator, 2, MENDED - 1)
  assert.ok(landed, 'the auto lands')
  assert.equal(marks(simulator.at(landed - 1), 2, SAGE_KEY).length, 1, 'the enemy was mended')
  assert.ok(hp(simulator.at(landed - 1), 3) < striker.maxHp, 'and the one who hit it was hurt')
  assert.equal(gained(simulator, 3, landed), 0, 'nothing is healed')
  assert.equal(status(simulator.at(landed), 3, 'haste'), undefined, 'or quickened')
  assert.equal(marks(simulator.at(landed), 2, SAGE_KEY).length, 1, 'and the mend stays for her side')
})

test('each Sage\'s mend is its own, and one auto of a teammate uses up all of them and is healed for each', () => {
  const second = { x: HOME.x - 60, y: HOME.y }
  const simulator = scene([{ at: east_(200) }, { at: STRIKER_AT, who: striker, team: 1 }, { at: second, who: sage, team: 1 }])
  simulator.addOrder(3, cast(1, 't-sage-wound', none, STRIKER_AT))
  simulator.addOrder(1, cast(10, 'vinebolt', east))
  simulator.addOrder(4, cast(10, 'vinebolt', east, second))
  simulator.addOrder(3, attack(MENDED, 2))

  const landed = hitAfter(simulator, 2, MENDED - 1)
  assert.ok(landed, 'the auto lands')
  assert.deepEqual(marks(simulator.at(landed - 1), 2, SAGE_KEY).map((marker) => marker.ownerId).sort(), [1, 4], 'each of them has mended it')
  assert.equal(gained(simulator, 3, landed), passiveHeal * 2, 'it heals for both')
  assert.equal(marks(simulator.at(landed), 2, SAGE_KEY).length, 0, 'and uses both up')
})

test('a mend a Sage left behind when she died can still be used by her team until it runs out', () => {
  const simulator = scene([{ at: east_(200) }, { at: STRIKER_AT, who: striker, team: 1 }])
  simulator.addOrder(3, cast(1, 't-sage-wound', none, STRIKER_AT))
  simulator.addOrder(1, cast(10, 'vinebolt', east))
  killAt(simulator, 1, MENDED - 10)
  simulator.addOrder(3, attack(MENDED, 2))

  assert.equal(simulator.at(MENDED - 5).get(1)?.isDead(), true, 'she is dead')
  const landed = hitAfter(simulator, 2, MENDED - 1)
  assert.ok(landed, 'the auto lands')
  assert.equal(marks(simulator.at(landed - 1), 2, SAGE_KEY).length, 1, 'her mend is still on the enemy')
  assert.equal(gained(simulator, 3, landed), passiveHeal, 'and it is worth what it was')
  assert.equal(marks(simulator.at(landed), 2, SAGE_KEY).length, 0)
})

// ---------------------------------------------------------------------------- on the page

test('rejuvenate is aimed at a teammate, or at Sage herself, and never at an enemy', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, sage, 1)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 200, y: 100 }, patient, 1)
  gameState.simulator.addPlayer(3, 'player-3', 'Player 3', { x: 100, y: 200 }, bag, 2)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  const slot = sage.abilities.indexOf('rejuvenate')

  assert.ok(gameState.abilityNeedsAim(slot), 'it is aimed')
  assert.deepEqual(gameState.getCastPreview(slot, { x: 200, y: 100 }, 0)?.target, at(2), 'at the teammate')
  assert.deepEqual(gameState.getCastPreview(slot, { x: 100, y: 100 }, 0)?.target, at(1), 'or at herself, by pointing at her')
  assert.equal(gameState.getCastPreview(slot, { x: 100, y: 200 }, 0)?.target, undefined, 'and not at the enemy')
  const refused = gameState.createCastOrder(slot, { x: 100, y: 200 }, 0)
  assert.equal(refused.ok, false)
  assert.equal(gameState.getAllyNear({ x: 100, y: 200 }, 0), undefined, 'the enemy is nobody\'s ally')
  assert.equal(gameState.getEnemyNear({ x: 200, y: 100 }, 0), undefined, 'and the teammate is nobody\'s enemy')
  const cast = gameState.createCastOrder(slot, { x: 200, y: 100 }, 0)
  assert.ok(cast.ok)
  assert.deepEqual(cast.order.target, at(2))
})

test('sage is drawn from a sprite set of her own, and a mended enemy shows a pip', () => {
  const set = championSprites.sage
  assert.ok(set)
  for (const clip of ['idle', 'walk', 'attack', 'cast', 'dead'] as const) assert.ok(set.clips[clip], `a ${clip}`)
  const pips = layoutStackPips({ [SAGE_KEY]: 1 }, R)
  assert.equal(pips.length, 1)
  assert.equal(pips[0].shape, 'diamond', 'a mark she put on it')
})
