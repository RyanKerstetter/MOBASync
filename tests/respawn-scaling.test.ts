import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  applyRulesChange,
  createModeSetup,
  defaultRules,
  GAME_MODES,
  GAME_RESPAWN_TICKS,
  GAME_RESPAWN_TICKS_PER_LEVEL,
  GAME_TPS,
  GameSnapshotSchema,
  modeRules,
  readRulesChange,
  RESPAWN_PER_LEVEL_SECONDS,
  respawnTicksAt,
  Simulator,
  xpToReachLevel,
  type ModeSetup,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { defineChampion, defineMonster } from './fixtures.ts'

// How long a champion stays dead: the respawn time of the game, and the time per level more for each level it has above the first (`respawnTicksAt`; the lobby sets it, and
// `GAME_RESPAWN_TICKS_PER_LEVEL` is what a game that is not told waits). The lobby's respawn time is what a level 1 champion waits. A monster comes back by its own profile. The champions and the monster here are the tests' own; the respawn time of the game
// is one the tests give it, so retuning the real one changes nothing here.

const BASE = 100
const economy: ModeSetup = { kind: 'core', teams: [1, 2], respawnTicks: BASE }

test('a champion waits the respawn time of the game at the first level, and the same again for each level it has gained', () => {
  assert.equal(respawnTicksAt(BASE, 1), BASE)
  for (const level of [2, 3, 7, 18]) {
    assert.equal(respawnTicksAt(BASE, level), BASE + GAME_RESPAWN_TICKS_PER_LEVEL * (level - 1), `level ${level}`)
  }
  assert.ok(GAME_RESPAWN_TICKS_PER_LEVEL > 0, 'a higher level waits longer')
  assert.equal(respawnTicksAt(BASE, 0), BASE, 'there is no level below the first')
  assert.equal(respawnTicksAt(BASE, 2.9), respawnTicksAt(BASE, 2), 'and a part of a level is not one')
  assert.ok(respawnTicksAt(GAME_RESPAWN_TICKS, 1) === GAME_RESPAWN_TICKS, 'a game that has no levels waits the time it is set to')
})

// ---------------------------------------------------------------------------- in the game

// A hero who kills a monster that is worth `xpToReachLevel(level)` on tick 2 (which makes it that level), and is killed on tick 20 by a foe who hits harder than it can take.
const hero = defineChampion({
  id: 't-rs-hero',
  name: 'Respawn Hero',
  base: { maxHp: 1000, attackDamage: 5000, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 300,
  attackWindup: 0,
  abilities: [],
})
const slayer = defineChampion({
  id: 't-rs-slayer',
  name: 'Respawn Slayer',
  base: { maxHp: 1000, attackDamage: 5000, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 300,
  attackWindup: 0,
  abilities: [],
})
let made = 0
const feed = (xp: number) => defineMonster({
  id: `t-rs-feed-${(made += 1)}`,
  name: 'Respawn Feed',
  base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300, respawnTicks: 4000 },
  reward: { gold: 0, xp },
})
const HERO_AT: Vector2 = { x: 600, y: 700 }
const SLAIN = 20
let sequence = 0
const attack = (tick: number, targetId: number) => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack' as const, targetId })

function death(level: number, setup: ModeSetup = economy, simulator = new Simulator(undefined, setup)): Simulator {
  simulator.addPlayer(1, 'p1', 'Hero', HERO_AT, hero, 1)
  simulator.addPlayer(2, 'p2', 'Slayer', { x: 800, y: 700 }, slayer, 2)
  if (level > 1) {
    simulator.addMonster(10, feed(xpToReachLevel(level)), { x: 600, y: 760 })
    simulator.addOrder(1, attack(2, 10))
  }
  simulator.addOrder(2, attack(SLAIN, 1))
  return simulator
}

test('a champion of a higher level is dead for longer, by the time per level, and is back at the tick that comes to', () => {
  for (const level of [1, 2, 5]) {
    const simulator = death(level)
    assert.equal(simulator.at(SLAIN - 1).get(1)?.getLevel(), level, `it is level ${level} when it dies`)
    const diedOn = simulator.at(SLAIN).get(1)?.getDeathTick()
    assert.equal(diedOn, SLAIN, 'and dies on the tick it is hit')
    const wait = respawnTicksAt(BASE, level)
    assert.equal(simulator.at(SLAIN + wait - 1).get(1)?.isDead(), true, `level ${level}: still dead the tick before`)
    assert.equal(simulator.at(SLAIN + wait).get(1)?.isDead(), false, `level ${level}: back after ${wait} ticks`)
    assert.deepEqual(simulator.at(SLAIN + wait).get(1)?.getPosition(), HERO_AT, 'at its spawn')
  }
})

test('a game with no experience has no levels, so every champion waits the respawn time it is set to', () => {
  const simulator = death(1, { kind: 'deathmatch', respawnTicks: BASE })
  assert.equal(simulator.at(SLAIN + BASE - 1).get(1)?.isDead(), true)
  assert.equal(simulator.at(SLAIN + BASE).get(1)?.isDead(), false)
})

test('a monster comes back by its own profile, and not by its level', () => {
  const simulator = new Simulator(undefined, economy)
  const prey = defineMonster({
    id: 't-rs-prey',
    name: 'Respawn Prey',
    base: { maxHp: 100, attackDamage: 1, attackSpeed: 1 },
    moveSpeed: 200,
    radius: 20,
    attackRange: 60,
    attackWindup: 0,
    abilities: [],
    ai: { aggroRange: 0, deaggroRange: 300, respawnTicks: 150 },
  })
  simulator.addPlayer(1, 'p1', 'Hero', HERO_AT, hero, 1)
  simulator.addMonster(10, prey, { x: 600, y: 760 })
  simulator.addOrder(1, attack(2, 10))
  assert.equal(simulator.at(2 + 150 - 1).get(10)?.isDead(), true)
  assert.equal(simulator.at(2 + 150).get(10)?.isDead(), false)
})

// ---------------------------------------------------------------------------- on the page

test('the page counts down the champion\'s own wait: more for a higher level', () => {
  const secondsLeft = (level: number): number => {
    const state = new ClientGameState()
    state.simulator.reset(undefined, economy)
    death(level, economy, state.simulator)
    state.setLocalCharacterId(1)
    state.resetServerTickAnchor(0, 0)
    state.simulator.advanceTo(SLAIN + 10)
    state.resetServerTickAnchor(SLAIN + 10, 0)
    return state.getRespawnSecondsLeft(0) ?? Number.NaN
  }
  for (const level of [1, 3]) {
    const expected = (SLAIN + respawnTicksAt(BASE, level) - (SLAIN + 10)) / GAME_TPS
    assert.ok(Math.abs(secondsLeft(level) - expected) < 0.05, `level ${level}: ${secondsLeft(level)} seconds left, and ${expected} to wait`)
  }
  assert.ok(secondsLeft(3) > secondsLeft(1), 'a higher level waits longer')
})

// ---------------------------------------------------------------------------- the time per level is a rule too

test('the time per level is the lobby\'s to set, in whole seconds from 0, and a game with levels is given it in ticks', () => {
  assert.equal(defaultRules().respawnPerLevelSeconds, RESPAWN_PER_LEVEL_SECONDS.default)
  assert.equal(RESPAWN_PER_LEVEL_SECONDS.default * GAME_TPS, GAME_RESPAWN_TICKS_PER_LEVEL, 'by default it waits what it always did')
  assert.equal(RESPAWN_PER_LEVEL_SECONDS.min, 0, 'and it can be none')
  assert.deepEqual(readRulesChange({ respawnPerLevelSeconds: 0 }), { change: { respawnPerLevelSeconds: 0 } })
  for (const bad of [RESPAWN_PER_LEVEL_SECONDS.max + 1, -1, 1.5, '3', null]) {
    const read = readRulesChange({ respawnPerLevelSeconds: bad })
    assert.ok('problem' in read && /per level/.test(read.problem), `${String(bad)} is refused, and says so`)
  }
  const rules = applyRulesChange(defaultRules(), { respawnSeconds: 7, respawnPerLevelSeconds: 4 })
  assert.equal(applyRulesChange(rules, { respawnSeconds: 9 }).respawnPerLevelSeconds, 4, 'a change to the base leaves it')
  const economyModes = GAME_MODES.filter((mode) => mode.economy).map((mode) => mode.id)
  assert.ok(economyModes.length > 0)
  for (const mode of GAME_MODES.map((each) => each.id)) {
    const given = modeRules(rules, mode)
    assert.equal(given.respawnTicks, 7 * GAME_TPS, `${mode}: the base`)
    assert.equal(given.respawnTicksPerLevel, economyModes.includes(mode) ? 4 * GAME_TPS : undefined, `${mode}: the time per level, only where there are levels`)
  }
})

test('a champion waits the base and the time per level the game was set to, and with none per level the same at every level', () => {
  for (const perLevel of [0, 3 * GAME_TPS]) {
    for (const level of [1, 4]) {
      const simulator = death(level, { ...economy, respawnTicksPerLevel: perLevel })
      const wait = BASE + perLevel * (level - 1)
      assert.equal(respawnTicksAt(BASE, level, perLevel), wait)
      assert.equal(simulator.respawnTicksFor(1, simulator.at(SLAIN)), wait, `${perLevel} a level, level ${level}: the page is told the same wait`)
      assert.equal(simulator.at(SLAIN + wait - 1).get(1)?.isDead(), true, `${perLevel} a level, level ${level}: still dead the tick before`)
      assert.equal(simulator.at(SLAIN + wait).get(1)?.isDead(), false, `${perLevel} a level, level ${level}: back after ${wait} ticks`)
    }
  }
})

test('the time per level travels with the snapshot', () => {
  const setup = createModeSetup('core', [1, 2], { flags: [], cores: [{ x: 100, y: 100 }, { x: 900, y: 100 }] }, { respawnTicks: BASE, respawnTicksPerLevel: 5 * GAME_TPS })
  const read = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(new Simulator(undefined, setup).snapshot())))
  const restored = new Simulator()
  restored.replaceFromSnapshot(read)
  assert.equal(restored.respawnTicksPerLevel, 5 * GAME_TPS)
  assert.equal(new Simulator(undefined, economy).respawnTicksPerLevel, GAME_RESPAWN_TICKS_PER_LEVEL, 'and a game not told waits what it always did')
})
