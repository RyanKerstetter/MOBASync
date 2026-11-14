import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_MONSTER_HEAL_ON_KILL,
  getMonster,
  monsters,
  Monster,
  Simulator,
  type MonsterDef,
} from '../packages/shared/src/index.ts'
import { brawler, defineChampion, defineMonster, economySimulator } from './fixtures.ts'

// Killing a monster heals the player who does it by a share of that player's own maximum health, set on the monster (`MonsterDef.healOnKill`).
// Everything here uses content of its own, so retuning the game's monsters does not change what these expect, except where a test is about
// what the game ships with.

const MAX_HP = 1000
// Hits once for this much, which is how the killer is hurt before it kills, so there is health to heal.
const HURT = 400

const slayerBody = {
  base: { maxHp: MAX_HP, attackDamage: 5000, attackSpeed: 1 },
  moveSpeed: 220,
  radius: 18,
  attackRange: 150,
  attackWindup: 0,
  abilities: [...brawler.abilities],
}
const slayer = defineChampion({ ...slayerBody, id: 't-heal-slayer', name: 'Slayer' })
// An enemy of the slayer that hurts it once, and dies to one blow of the slayer's.
const poker = defineChampion({
  id: 't-heal-poker',
  name: 'Poker',
  base: { maxHp: 50, attackDamage: HURT, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 18,
  attackRange: 150,
  attackWindup: 0,
  abilities: [...brawler.abilities],
})

const body = {
  base: { maxHp: 100, attackDamage: 5, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300 },
} as const
const SHARE = 0.3
// Dies to one blow, and heals by a share it says.
const healer = defineMonster({ ...body, id: 't-heal-healer', name: 'Healer', healOnKill: SHARE })
// The same, and heals the killer completely.
const feast = defineMonster({ ...body, id: 't-heal-feast', name: 'Feast', healOnKill: 1 })
// The same, and heals nobody.
const bitter = defineMonster({ ...body, id: 't-heal-bitter', name: 'Bitter', healOnKill: 0 })
// The same, and says nothing about it.
const silent = defineMonster({ ...body, id: 't-heal-silent', name: 'Silent' })

const HOME = { x: 600, y: 700 }
const at = (dx: number, dy = 0) => ({ x: HOME.x + dx, y: HOME.y + dy })
const MONSTER = 10
const SLAYER = 1
const POKER = 2
const KILL_TICK = 10
const hp = (simulator: Simulator, tick: number, id = SLAYER): number | undefined => simulator.at(tick).get(id)?.getHealth()

// The slayer (1), hurt by the poker (2) on tick 1, and told to attack `victim` on tick 10. When the victim is the poker, the monster is not there.
function hunt(monster: Monster | undefined, simulator: Simulator = economySimulator()): Simulator {
  if (monster) simulator.addMonster(MONSTER, monster, HOME)
  simulator.addPlayer(SLAYER, 'p', 'P', at(140), slayer, 1)
  simulator.addPlayer(POKER, 'q', 'Q', at(140, 100), poker, 2)
  simulator.addOrder(POKER, { id: 'h1', seq: 1, tick: 1, type: 'attack', targetId: SLAYER })
  // It stands still afterwards, or it would hit again.
  simulator.addOrder(POKER, { id: 'h2', seq: 2, tick: 2, type: 'move', target: at(140, 100) })
  simulator.addOrder(SLAYER, { id: 'a1', seq: 1, tick: KILL_TICK, type: 'attack', targetId: monster ? MONSTER : POKER })
  return simulator
}

const healFor = (monster: Monster, maxHp = MAX_HP): number => Math.round(maxHp * monster.healOnKill)

// The slayer's health on each tick from the first to `last`, and the tick the monster died on, worked out a tick at a time (the frames are only kept for a few ticks).
function watch(simulator: Simulator, last: number): { health: Map<number, number | undefined>; diedOn: number | undefined } {
  const health = new Map<number, number | undefined>()
  let diedOn: number | undefined
  for (let tick = 1; tick <= last; tick += 1) {
    simulator.advanceTo(tick)
    const frame = simulator.at(tick)
    health.set(tick, frame.get(SLAYER)?.getHealth())
    if (diedOn === undefined && frame.get(MONSTER)?.isDead()) diedOn = tick
  }
  return { health, diedOn }
}

test('killing a monster heals the killer by the share it says of the killer\'s maximum health', () => {
  const { health, diedOn } = watch(hunt(healer), 40)
  assert.equal(health.get(5), MAX_HP - HURT, 'it was hurt, and nothing has healed it yet')
  assert.notEqual(diedOn, undefined, 'the monster died')
  assert.equal(health.get(40), MAX_HP - HURT + healFor(healer))
  assert.ok(healFor(healer) > 0 && MAX_HP - HURT + healFor(healer) < MAX_HP, 'and it was not the whole of it')
})

test('the heal is paid on the tick of the kill, in the frame, and once however long the game goes on', () => {
  const { health, diedOn } = watch(hunt(healer), 80)
  assert.ok(diedOn !== undefined && diedOn >= KILL_TICK, 'it was killed by the order')
  assert.equal(health.get((diedOn as number) - 1), MAX_HP - HURT, 'a tick before, nothing')
  assert.equal(health.get(diedOn as number), MAX_HP - HURT + healFor(healer), 'and the tick it died on, the heal')
  assert.equal(health.get(80), MAX_HP - HURT + healFor(healer), 'paid once')
})

test('a heal stops at the killer\'s maximum health', () => {
  const simulator = hunt(feast)
  simulator.advanceTo(40)
  assert.equal(hp(simulator, 40), MAX_HP, 'a whole heal only fills what was missing')
  assert.equal(simulator.at(40).get(SLAYER)?.getHealthState()?.maxHp, MAX_HP, 'and the maximum is as it was')
})

test('a monster that heals by nothing heals nobody, and one that says nothing heals by the default', () => {
  const none = hunt(bitter)
  none.advanceTo(40)
  assert.equal(none.at(40).get(MONSTER)?.isDead(), true)
  assert.equal(hp(none, 40), MAX_HP - HURT)

  assert.equal(silent.healOnKill, DEFAULT_MONSTER_HEAL_ON_KILL)
  const plain = hunt(silent)
  plain.advanceTo(40)
  assert.equal(hp(plain, 40), Math.min(MAX_HP, MAX_HP - HURT + healFor(silent)))
})

test('the heal is a share of the killer\'s maximum health, so it is less for a killer with less of it', () => {
  // Half the health, which is still more than the poker takes off it, and a heal that does not fill it.
  const frailHp = MAX_HP / 2
  const frail = defineChampion({ ...slayerBody, id: 't-heal-frail', name: 'Frail', base: { ...slayerBody.base, maxHp: frailHp } })
  const simulator = economySimulator()
  simulator.addMonster(MONSTER, healer, HOME)
  simulator.addPlayer(SLAYER, 'p', 'P', at(140), frail, 1)
  simulator.addPlayer(POKER, 'q', 'Q', at(140, 100), poker, 2)
  simulator.addOrder(POKER, { id: 'h1', seq: 1, tick: 1, type: 'attack', targetId: SLAYER })
  simulator.addOrder(POKER, { id: 'h2', seq: 2, tick: 2, type: 'move', target: at(140, 100) })
  simulator.addOrder(SLAYER, { id: 'a1', seq: 1, tick: KILL_TICK, type: 'attack', targetId: MONSTER })
  simulator.advanceTo(40)
  assert.equal(hp(simulator, 40), frailHp - HURT + healFor(healer, frailHp))
  assert.ok(healFor(healer, frailHp) < healFor(healer))
  assert.ok(frailHp - HURT + healFor(healer, frailHp) < frailHp, 'and it did not reach the maximum')
})

test('it heals in a game with no economy as well, since it is not part of what a kill pays', () => {
  const simulator = hunt(healer, new Simulator())
  simulator.advanceTo(40)
  assert.equal(simulator.at(40).get(MONSTER)?.isDead(), true)
  assert.equal(hp(simulator, 40), MAX_HP - HURT + healFor(healer))
})

test('killing a player heals nobody: only a monster does', () => {
  const simulator = hunt(undefined)
  simulator.advanceTo(40)
  assert.equal(simulator.at(40).get(POKER)?.isDead(), true, 'the poker died')
  assert.equal(hp(simulator, 40), MAX_HP - HURT)
})

test('what a monster heals by is checked: a share from 0 to 1', () => {
  const def = (healOnKill: number): MonsterDef => ({ ...body, id: 't-heal-bad', name: 'Bad', ...{ healOnKill } })
  for (const bad of [-0.1, 1.1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new Monster(def(bad)), /Monster "t-heal-bad" needs a heal on kill from 0 to 1/, String(bad))
  }
  for (const good of [0, 0.25, 1]) assert.equal(new Monster(def(good)).healOnKill, good)
})

test('the slime and the golem in the game heal the killer, and every monster has a share', () => {
  for (const id of ['slime', 'golem']) {
    const share = getMonster(id).healOnKill
    assert.ok(share > 0 && share <= 1, `${id} heals by a share of the killer's health`)
  }
  for (const monster of monsters.values()) {
    assert.ok(monster.healOnKill >= 0 && monster.healOnKill <= 1, `${monster.name} has a share`)
  }
})
