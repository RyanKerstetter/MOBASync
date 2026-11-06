import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Champion,
  getChampion,
  Simulator,
  xpToReachLevel,
  type CharacterOrder,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { SWORD_DAMAGE_PER_STACK, SWORD_MAX_STACKS, SWORD_SCALING_PER_LEVEL } from '../packages/shared/src/abilities.ts'
import { defineMonster, economySimulator } from './fixtures.ts'

// The Swordsman's passive, played out in the simulator: each auto adds a sword stack, and each stack he has when an auto lands adds damage to it, which is the base for a stack and
// so much more for each level he is (like a stack of Hammer's plating). The numbers come from the exported constants and the definitions, so retuning the kit does not break these.

const HOME: Vector2 = { x: 400, y: 600 }
const swordsman = getChampion('swordsman')
const bag = new Champion({
  id: 't-sw-bag',
  name: 'Test Bag',
  base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 140,
  radius: 24,
  attackRange: 50,
  attackWindup: 0,
  abilities: [],
})
const within: Vector2 = { x: HOME.x + swordsman.attackRange - 10, y: HOME.y }

let sequence = 0
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })

// What a stack adds to an auto of a Swordsman of this level (the level counts from 1), and what an auto comes to with this many stacks.
const perStack = (level: number): number => SWORD_DAMAGE_PER_STACK + SWORD_SCALING_PER_LEVEL * level
const autoDamage = (level: number, stacks: number): number => Math.round(swordsman.statsAt(level).attackDamage + stacks * perStack(level))

// What the bag lost to each auto the Swordsman landed on it, in order, from tick 1 on.
function blows(simulator: Simulator, count: number): number[] {
  const found: number[] = []
  const last = 1 + (count + 1) * swordsman.attackCooldownTicks
  for (let tick = 2; tick <= last && found.length < count; tick += 1) {
    const lost = (simulator.at(tick - 1).get(2)?.getHealth() ?? 0) - (simulator.at(tick).get(2)?.getHealth() ?? 0)
    if (lost > 0) found.push(lost)
  }
  return found
}

test('each stack of sword is worth its base and so much more for each level, and the stacks grow by an auto at a time, up to the most', () => {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, swordsman, 1)
  simulator.addPlayer(2, 'p2', 'Two', within, bag, 2)
  simulator.addOrder(1, attack(1, 2))
  const expected = Array.from({ length: SWORD_MAX_STACKS + 2 }, (_, index) => autoDamage(1, Math.min(index, SWORD_MAX_STACKS)))
  assert.deepEqual(blows(simulator, expected.length), expected, 'each auto reads the stacks before it adds its own, and no more than the most count')
  assert.ok(perStack(1) > SWORD_DAMAGE_PER_STACK, 'and a stack is worth more than its base, as the level counts from 1')
})

test('what a stack is worth grows with his level, from the first auto he lands after he gains it', () => {
  const level = 6
  // A monster worth enough to take him to that level, that dies to one auto and stands next to him.
  const feed = defineMonster({
    id: 't-sw-feed',
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
  simulator.addPlayer(1, 'p1', 'One', HOME, swordsman, 1)
  simulator.addPlayer(2, 'p2', 'Two', within, bag, 2)
  simulator.addMonster(10, feed, { x: HOME.x, y: HOME.y + 60 })
  simulator.addOrder(1, attack(1, 10))
  const killed = 1 + swordsman.attackWindupTicks
  simulator.addOrder(1, attack(killed + 1, 2))

  const hits: Array<{ lost: number }> = []
  for (let tick = 2; tick <= killed + 1 + 4 * swordsman.attackCooldownTicks; tick += 1) {
    const lost = (simulator.at(tick - 1).get(2)?.getHealth() ?? 0) - (simulator.at(tick).get(2)?.getHealth() ?? 0)
    if (lost > 0) hits.push({ lost })
  }
  assert.equal(simulator.at(simulator.latestSnapshotTick).get(1)?.getLevel(), level, 'the kill took him to that level')
  assert.ok(hits.length >= 3, `he landed a few autos on the bag (${hits.length})`)
  // The kill left him one stack, and each auto on the bag then had the stacks before it: 1, 2, and then the most.
  const stacksBefore = [1, 2, SWORD_MAX_STACKS, SWORD_MAX_STACKS]
  hits.forEach(({ lost }, index) => {
    assert.equal(lost, autoDamage(level, stacksBefore[index]), `auto ${index + 1} on the bag, at level ${level} with ${stacksBefore[index]} stacks`)
  })
  assert.ok(autoDamage(level, 1) - swordsman.statsAt(level).attackDamage > autoDamage(1, 1) - swordsman.statsAt(1).attackDamage, 'a stack adds more at a higher level')
})

test('his passive says it', () => {
  assert.match(swordsman.passive, /more as you level/)
})
