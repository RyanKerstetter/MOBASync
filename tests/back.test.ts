import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  abilityDefs,
  BACK_ABILITY_ID,
  BACK_TICKS,
  champions,
  damage,
  distanceBetween,
  GAME_CAST_ORIGIN_TOLERANCE,
  GAME_TPS,
  haste,
  silence,
  Simulator,
  stun,
  targetUnit,
  type CastTarget,
  type CharacterOrder,
  type ModeSetup,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineAbility, defineChampion, defineTurret } from './fixtures.ts'
import { testSpawns } from './test-spawns.ts'

// Back (B): every champion has it. It channels for `BACK_TICKS`, and then takes the champion to its spawn. Moving, going after someone, casting something else, being stunned
// and taking damage all end it; a silence does not stop it; and a champion carrying a flag cannot start it. The champions and the abilities here are the tests' own.

defineAbility({ id: 't-bk-nudge', targeting: 'none', range: 0, windUpTicks: 0, cooldownTicks: 600, apply: [haste(0.1, 30)] })
defineAbility({ id: 't-bk-jolt', targeting: 'unit', range: 600, windUpTicks: 0, cooldownTicks: 600, apply: [stun(120, targetUnit())] })
defineAbility({ id: 't-bk-hush', targeting: 'unit', range: 600, windUpTicks: 0, cooldownTicks: 600, apply: [silence(6000, targetUnit())] })
defineAbility({ id: 't-bk-prick', targeting: 'unit', range: 600, windUpTicks: 0, cooldownTicks: 600, apply: [damage(10, targetUnit())] })
const hero = defineChampion({
  id: 't-bk-hero',
  name: 'Back Hero',
  base: { maxHp: 1000, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 400,
  radius: 20,
  attackRange: 150,
  attackWindup: 0,
  abilities: ['t-bk-nudge'],
})
const foe = defineChampion({
  id: 't-bk-foe',
  name: 'Back Foe',
  base: { maxHp: 1000, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 400,
  attackWindup: 0,
  abilities: ['t-bk-jolt', 't-bk-hush', 't-bk-prick'],
})

const SPAWN: Vector2 = { x: 500, y: 700 }
const AWAY: Vector2 = { x: 900, y: 700 }
const FOE_AT: Vector2 = { x: 1000, y: 760 }
// The hero has walked to AWAY by this tick (400 units at 400 a second takes 60 ticks).
const ARRIVED = 90
const BACK_AT = 100
const ME = 1
const FOE = 2

let sequence = 0
const cast = (tick: number, abilityId: string, target: CastTarget, origin: Vector2): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target, origin: { ...origin } })
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const none: CastTarget = { mode: 'none' }
const unit = (unitId: number): CastTarget => ({ mode: 'unit', unitId })

// The hero (1) starts at SPAWN, walks to AWAY, and starts Back on BACK_AT; a foe (2) of the other team is near.
function scene(): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(ME, 'p1', 'One', SPAWN, hero, 1)
  simulator.addPlayer(FOE, 'p2', 'Two', FOE_AT, foe, 2)
  simulator.addOrder(ME, move(1, AWAY))
  simulator.addOrder(ME, cast(BACK_AT, BACK_ABILITY_ID, none, AWAY))
  return simulator
}
const at = (simulator: Simulator, tick: number): Vector2 => simulator.at(tick).get(ME)?.getPosition() as Vector2
const GONE = BACK_AT + BACK_TICKS
// Whether the hero is at its spawn after the channel would have gone off.
const home = (simulator: Simulator): boolean => distanceBetween(at(simulator, GONE + 5), SPAWN) < 1

// ---------------------------------------------------------------------------- who has it

test('every champion has Back, and it is no one\'s ability: it is not in a list or on a key', () => {
  const def = abilityDefs.get(BACK_ABILITY_ID)
  assert.ok(def, 'there is such an ability')
  assert.equal(def.universal, true)
  assert.equal(def.windUpTicks, BACK_TICKS, 'a channel of its own, and not a standard windup')
  for (const champion of champions.values()) {
    assert.equal(champion.hasAbility(BACK_ABILITY_ID), true, `${champion.id} has it`)
    assert.equal(champion.abilities.includes(BACK_ABILITY_ID), false, `but not on a key`)
    assert.equal(champion.castableAbilities().includes(BACK_ABILITY_ID), false, 'and it is not one of what it resets or counts')
  }
  assert.equal(hero.hasAbility(BACK_ABILITY_ID), true)
})

test('the server takes Back from any champion', () => {
  for (const champion of champions.values()) {
    const game = new ServerGameState(testSpawns)
    const players = [{ id: 'player-1', name: 'One' }, { id: 'player-2', name: 'Two' }]
    game.beginSelection(players)
    assert.equal(game.pickChampion('player-1', champion.id), true)
    game.lockChampion('player-1')
    game.lockChampion('player-2')
    game.begin(players)
    const characterId = game.getCharacterId('player-1')
    assert.ok(characterId)
    const origin = game.simulator.at(0).get(characterId)?.getPosition()
    assert.ok(origin)
    const verdict = game.acceptOrder('player-1', { id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: BACK_ABILITY_ID, target: none, origin })
    assert.equal(verdict.ack.status, 'accepted', `${champion.id}: ${verdict.ack.reason ?? ''}`)
    const other = game.acceptOrder('player-1', { id: 'player-1:2', seq: 2, tick: 1, type: 'cast', abilityId: 'no-such-ability', target: none, origin })
    assert.equal(other.ack.status, 'rejected', 'an ability that is not theirs is refused as ever')
  }
})

// ---------------------------------------------------------------------------- the channel

test('Back takes the champion to its spawn when the channel is over, and not before', () => {
  const simulator = scene()
  assert.ok(distanceBetween(at(simulator, BACK_AT - 1), AWAY) < 1, 'it had walked away from the spawn')
  assert.equal(simulator.at(BACK_AT + 1).get(ME)?.getAction()?.kind, 'cast', 'and is channelling')
  assert.ok(distanceBetween(at(simulator, GONE - 1), AWAY) < 1, 'on the last tick of the channel it is where it was')
  assert.ok(distanceBetween(at(simulator, GONE), SPAWN) < 1, 'and when it is over, it is at its spawn')
  assert.ok(distanceBetween(at(simulator, GONE + 60), SPAWN) < 1, 'and stays there')
  assert.equal(simulator.at(GONE + 60).get(ME)?.getAction(), undefined, 'with the channel over')
})

test('walking, or going after someone, ends Back: the champion is where it walked to, not at its spawn', () => {
  const walked = scene()
  const elsewhere: Vector2 = { x: 900, y: 900 }
  walked.addOrder(ME, move(BACK_AT + 60, elsewhere))
  // It is never at its spawn: walking ended the channel. (Were the walk kept for after the channel, as one is for an ability's windup, it would go off, take the champion to
  // its spawn, and walk on from there to where it was sent, which would look like this at the end and not before.)
  for (let tick = BACK_AT + 61; tick <= GONE + 5; tick += 1) {
    assert.ok(distanceBetween(at(walked, tick), SPAWN) > 100, `tick ${tick}: it is away from its spawn`)
  }
  assert.equal(home(walked), false)
  assert.ok(distanceBetween(at(walked, GONE + 120), elsewhere) < 1, 'it went where it was told')

  const fought = scene()
  fought.addOrder(ME, attack(BACK_AT + 60, FOE))
  assert.equal(home(fought), false, 'an attack order ends it too')
  assert.ok(fought.at(GONE + 5).get(ME)?.getAction()?.kind !== 'cast' || at(fought, GONE + 5).x !== SPAWN.x)
})

test('casting something else ends Back, and the other ability is cast', () => {
  const simulator = scene()
  simulator.addOrder(ME, cast(BACK_AT + 60, 't-bk-nudge', none, AWAY))
  assert.equal(simulator.at(BACK_AT + 61).get(ME)?.getStatuses().some((status) => status.kind === 'haste'), true, 'the other ability went off')
  assert.equal(home(simulator), false)
})

test('taking damage ends Back, whoever does it: a champion, or a turret', () => {
  const struck = scene()
  struck.addOrder(FOE, cast(BACK_AT + 60, 't-bk-prick', unit(ME), FOE_AT))
  assert.ok((struck.at(BACK_AT + 70).get(ME)?.getHealth() ?? 1000) < hero.maxHp, 'it was hurt')
  assert.equal(home(struck), false)

  const shot = defineTurret(97, { base: { maxHp: 1_000_000, attackDamage: 10, attackSpeed: 1 }, radius: 30, attackRange: 100, attackWindup: 0 })
  const turret = new Simulator()
  turret.addPlayer(ME, 'p1', 'One', SPAWN, hero, 1)
  turret.addTurret(10, shot, { x: AWAY.x + 60, y: AWAY.y }, 2)
  turret.addOrder(ME, move(1, AWAY))
  turret.addOrder(ME, cast(BACK_AT, BACK_ABILITY_ID, none, AWAY))
  assert.equal(home(turret), false, 'a turret that hits it ends it too')
})

test('a stun ends Back', () => {
  const simulator = scene()
  simulator.addOrder(FOE, cast(BACK_AT + 60, 't-bk-jolt', unit(ME), FOE_AT))
  assert.equal(home(simulator), false)
})

test('Back that was ended can be started again at once: it has no cooldown to wait for', () => {
  const simulator = scene()
  simulator.addOrder(FOE, cast(BACK_AT + 60, 't-bk-prick', unit(ME), FOE_AT))
  simulator.addOrder(ME, cast(BACK_AT + 70, BACK_ABILITY_ID, none, AWAY))
  assert.ok(distanceBetween(at(simulator, BACK_AT + 70 + BACK_TICKS + 5), SPAWN) < 1)
})

test('a silence does not stop Back', () => {
  const simulator = scene()
  simulator.addOrder(FOE, cast(ARRIVED, 't-bk-hush', unit(ME), FOE_AT))
  assert.equal(simulator.at(BACK_AT - 1).get(ME)?.getStatuses().some((status) => status.kind === 'silence'), true, 'it is silenced')
  assert.equal(home(simulator), true, 'and goes back')
  // The same silence does stop an ability that is its own.
  simulator.addOrder(ME, cast(GONE + 20, 't-bk-nudge', none, SPAWN))
  assert.equal(simulator.at(GONE + 22).get(ME)?.getStatuses().some((status) => status.kind === 'haste'), false)
})

// ---------------------------------------------------------------------------- a flag

test('a champion that carries a flag cannot go back with it, and one that does not can', () => {
  const FLAG_1: Vector2 = { x: 200, y: 300 }
  const FLAG_2: Vector2 = { x: 1800, y: 300 }
  const ctf: ModeSetup = { kind: 'ctf', flags: [{ team: 1, home: FLAG_1 }, { team: 2, home: FLAG_2 }] }
  const world = (): Simulator => {
    const simulator = new Simulator(undefined, ctf)
    simulator.addPlayer(ME, 'p1', 'Carrier', FLAG_1, hero, 1)
    simulator.addPlayer(3, 'p3', 'Walker', { x: 300, y: 400 }, hero, 1)
    simulator.addOrder(ME, move(1, FLAG_2))
    simulator.addOrder(3, move(1, { x: 1000, y: 400 }))
    return simulator
  }
  const simulator = world()
  const carrying = simulator.at(300).getObjective()
  assert.ok(carrying?.kind === 'ctf' && carrying.flags.some((flag) => flag.carrierId === ME), 'the flag is on it')
  const carrierAt = simulator.at(300).get(ME)?.getPosition() as Vector2
  const walkerAt = simulator.at(300).get(3)?.getPosition() as Vector2
  simulator.addOrder(ME, cast(301, BACK_ABILITY_ID, none, carrierAt))
  simulator.addOrder(3, cast(301, BACK_ABILITY_ID, none, walkerAt))
  assert.ok(distanceBetween(simulator.at(301 + BACK_TICKS + 5).get(ME)?.getPosition() as Vector2, FLAG_2) < GAME_CAST_ORIGIN_TOLERANCE * 10, 'the carrier is still there')
  assert.ok(distanceBetween(simulator.at(301 + BACK_TICKS + 5).get(3)?.getPosition() as Vector2, { x: 300, y: 400 }) < 1, 'and the other went back')
})

// ---------------------------------------------------------------------------- on the page

test('the page tells how far through going back a champion is, for drawing it, and nothing when it is not', () => {
  const state = new ClientGameState()
  state.simulator.addPlayer(ME, 'p1', 'One', SPAWN, hero, 1)
  state.simulator.addPlayer(FOE, 'p2', 'Two', FOE_AT, foe, 2)
  state.setLocalCharacterId(ME)
  state.resetServerTickAnchor(0, 0)
  const backing = (tick: number) => {
    state.simulator.advanceTo(tick)
    return state.getCharacters(tick * 1000 / GAME_TPS).find((character) => character.id === ME)?.backing
  }
  assert.equal(backing(1), undefined, 'not going back')
  const from = 5
  state.simulator.addOrder(ME, cast(from, BACK_ABILITY_ID, { mode: 'none' }, SPAWN))
  assert.equal(backing(from), 0, 'just started')
  assert.ok(Math.abs((backing(from + BACK_TICKS / 2) ?? NaN) - 0.5) < 1e-9, 'half way')
  assert.equal(backing(from + BACK_TICKS + 1), undefined, 'and nothing once it is home')
  assert.equal(state.getCharacters((from + BACK_TICKS + 1) * 1000 / GAME_TPS).find((character) => character.id === FOE)?.backing, undefined, 'nor for anyone else')
})

test('the page gives the order for Back, and says why when it cannot', () => {
  const state = new ClientGameState()
  state.simulator.addPlayer(ME, 'p1', 'One', SPAWN, hero, 1)
  state.simulator.addPlayer(FOE, 'p2', 'Two', FOE_AT, foe, 2)
  state.setLocalCharacterId(ME)
  state.resetServerTickAnchor(0, 0)
  state.simulator.advanceTo(3)
  const attempt = state.createBackOrder(0)
  assert.ok(attempt.ok, 'Back is ordered')
  assert.ok(attempt.ok && attempt.order.type === 'cast' && attempt.order.abilityId === BACK_ABILITY_ID && attempt.order.target.mode === 'none')

  // Stunned, it cannot.
  state.simulator.addOrder(FOE, cast(10, 't-bk-jolt', unit(ME), FOE_AT))
  state.simulator.advanceTo(16)
  state.resetServerTickAnchor(16, 0)
  const blocked = state.createBackOrder(0)
  assert.equal(blocked.ok, false)
  assert.match(blocked.ok ? '' : blocked.reason, /stunned/)
})
