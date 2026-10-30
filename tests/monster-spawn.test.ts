import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { GameSnapshotSchema, Monster, monsters, Simulator, type MonsterDef } from '../packages/shared/src/index.ts'
import { defineChampion, defineMonster } from './fixtures.ts'

// A monster's spawn offset (see `AiProfileDef.spawnOffsetTicks`): how long after the game starts it first appears. Until then it is not in the game at
// all, so no frame has it, and nothing sees it, hits it, aims at it or pushes it; on its tick it is at its home with full health. It is only for the
// first time: after it dies it comes back by its respawn time. The monsters in these are the tests' own, with every number spelled out; the ones
// the game plays with are only read.

const HOME = { x: 600, y: 700 }
const LATE = 90
const RESPAWN = 200
const MONSTER = 10
const PLAYER = 1

const baseMonster = {
  name: 'Spawner',
  base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: [],
} as const
// It notices no one, and goes after whoever hurts it.
const late = defineMonster({ ...baseMonster, id: 't-ms-late', ai: { aggroRange: 0, deaggroRange: 300, spawnOffsetTicks: LATE, respawnTicks: RESPAWN } })
const prompt = defineMonster({ ...baseMonster, id: 't-ms-prompt', ai: { aggroRange: 0, deaggroRange: 300, respawnTicks: RESPAWN } })
const hitter = defineChampion({
  id: 't-ms-hitter', name: 'Hitter', base: { maxHp: 1000, attackDamage: 50, attackSpeed: 1 }, moveSpeed: 100, radius: 20, attackRange: 150, attackWindup: 0, abilities: [],
})
const slayer = defineChampion({
  id: 't-ms-slayer', name: 'Slayer', base: { maxHp: 1000, attackDamage: 5000, attackSpeed: 1 }, moveSpeed: 100, radius: 20, attackRange: 150, attackWindup: 0, abilities: [],
})

function world(monster: Monster = late, champion = hitter, at = { x: HOME.x + 100, y: HOME.y }): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(PLAYER, 'p1', 'One', at, champion, 1)
  simulator.addMonster(MONSTER, monster, HOME)
  return simulator
}
const attack = (tick: number, id = 'hit') => ({ id: `${id}${tick}`, seq: tick, tick, type: 'attack' as const, targetId: MONSTER })

// Plays the game a tick at a time, calling `look` with each frame while it is still held (the simulator keeps only the last few).
function play(simulator: Simulator, last: number, look: (tick: number) => void): void {
  for (let tick = simulator.tick + 1; tick <= last; tick += 1) {
    simulator.advanceTo(tick)
    look(tick)
  }
}
const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y)

// ---------------------------------------------------------------------------- the setting

test('a spawn offset is a whole number of ticks, 0 or more, and a monster that says none is there from the start', () => {
  const def = (spawnOffsetTicks: number): MonsterDef => ({ ...baseMonster, id: 't-ms-bad', ai: { aggroRange: 0, deaggroRange: 300, spawnOffsetTicks } })
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new Monster(def(bad)), /Monster "t-ms-bad" needs a spawn offset that is a whole number of ticks, 0 or more/, String(bad))
  }
  assert.equal(new Monster(def(0)).ai.spawnOffsetTicks, 0, '0 is allowed: there from the start')
  assert.equal(new Monster(def(LATE)).ai.spawnOffsetTicks, LATE)
  assert.equal(prompt.ai.spawnOffsetTicks, 0, 'with none given, none')
  assert.equal(late.ai.spawnOffsetTicks, LATE)
})

test('a character\'s spawn tick is its monster\'s offset, and 0 for everything else', () => {
  const simulator = world()
  assert.equal(simulator.characters.get(MONSTER)?.spawnTick, LATE)
  assert.equal(simulator.characters.get(PLAYER)?.spawnTick, 0, 'a player is there from the start')
  const other = world(prompt)
  assert.equal(other.characters.get(MONSTER)?.spawnTick, 0)
})

// ---------------------------------------------------------------------------- appearing

test('until its offset is up a monster is in no frame, and on its tick it is at home with full health, alive and with nothing on its mind', () => {
  const simulator = world()
  assert.equal(simulator.at(0).get(MONSTER), undefined, 'not in the first frame')
  assert.ok(simulator.at(0).get(PLAYER), 'though the player is')
  const seen: number[] = []
  play(simulator, LATE + 20, (tick) => {
    const state = simulator.at(tick).get(MONSTER)
    if (tick < LATE) {
      assert.equal(state, undefined, `tick ${tick}: not there yet`)
      assert.equal(simulator.at(tick).getCharacterIds().includes(MONSTER), false)
      return
    }
    assert.ok(state, `tick ${tick}: there`)
    seen.push(tick)
    if (tick === LATE) {
      assert.deepEqual(state.getPosition(), HOME, 'at its home')
      assert.equal(state.getHealth(), late.champion.maxHp, 'with all its health')
      assert.equal(state.isDead(), false)
      assert.deepEqual(state.getAi(), { mode: 'idle' })
    }
  })
  assert.equal(seen[0], LATE, 'it appeared on its tick and not before')
  assert.equal(seen.length, 21, 'and stayed')
})

test('a monster with no offset is in the very first frame, as monsters were', () => {
  const simulator = world(prompt)
  const state = simulator.at(0).get(MONSTER)
  assert.ok(state, 'there from tick 0')
  assert.deepEqual(state.getPosition(), HOME)
  assert.equal(state.getHealth(), prompt.champion.maxHp)
})

test('the monsters of the game appear when their own offsets are up, and a monster with none is there at the start', () => {
  assert.ok(monsters.size > 0)
  for (const monster of monsters.values()) {
    if (monster.id.startsWith('t-')) continue
    const offset = monster.ai.spawnOffsetTicks
    assert.ok(Number.isInteger(offset) && offset >= 0, `${monster.name} has an offset that is a whole number of ticks`)
    const simulator = new Simulator()
    simulator.addMonster(MONSTER, monster, HOME)
    assert.equal(simulator.at(0).get(MONSTER) !== undefined, offset === 0, `${monster.name} at the start`)
    if (offset > 0) {
      simulator.advanceTo(offset - 1)
      assert.equal(simulator.at(offset - 1).get(MONSTER), undefined, `${monster.name} the tick before its offset`)
    }
    simulator.advanceTo(Math.max(1, offset))
    assert.equal(simulator.at(Math.max(1, offset)).get(MONSTER)?.getHealth(), monster.champion.maxHp, `${monster.name} on its tick, with all its health`)
  }
})

// ---------------------------------------------------------------------------- nothing touches it before then

test('a player cannot attack a monster before it appears, and the attack that was ordered does nothing; one ordered after it appeared does', () => {
  const simulator = world()
  simulator.addOrder(PLAYER, attack(5, 'early'))
  simulator.addOrder(PLAYER, attack(LATE + 10, 'after'))
  play(simulator, LATE + 20, (tick) => {
    if (tick < LATE) assert.equal(simulator.at(tick).get(PLAYER)?.getAttackTarget(), undefined, `tick ${tick}: nothing to go after`)
    if (tick >= LATE && tick < LATE + 10) {
      assert.equal(simulator.at(tick).get(MONSTER)?.getHealth(), late.champion.maxHp, `tick ${tick}: the early order did nothing`)
    }
    if (tick === LATE + 10) assert.equal(simulator.at(tick).get(MONSTER)?.getHealth(), late.champion.maxHp - hitter.attackDamage, 'the order after it appeared is a hit')
  })
})

test('it does not push anyone aside before it appears, and does once it has', () => {
  // The player stands exactly where the monster will appear.
  const simulator = world(late, hitter, HOME)
  let pushedAt: number | undefined
  play(simulator, LATE + 20, (tick) => {
    const player = simulator.at(tick).get(PLAYER)?.getPosition()
    assert.ok(player)
    if (tick < LATE) {
      assert.deepEqual(player, HOME, `tick ${tick}: nothing moved the player`)
      return
    }
    const monster = simulator.at(tick).get(MONSTER)?.getPosition()
    if (pushedAt === undefined && monster && distance(monster, player) > 0) pushedAt = tick
  })
  assert.ok(pushedAt !== undefined && pushedAt >= LATE, `once it was there they were pushed apart (${pushedAt})`)
})

// ---------------------------------------------------------------------------- after it has died

test('a monster that is killed comes back after its respawn time, which is not the offset', () => {
  const simulator = world(late, slayer)
  simulator.addOrder(PLAYER, attack(LATE + 5))
  let died: number | undefined
  let back: number | undefined
  play(simulator, LATE + 5 + RESPAWN + 20, (tick) => {
    const state = simulator.at(tick).get(MONSTER)
    if (died === undefined && state?.isDead()) died = tick
    if (died !== undefined && back === undefined && state?.isDead() === false) back = tick
  })
  assert.ok(died !== undefined && died >= LATE + 5, `it was killed (${died})`)
  assert.equal(back, (died as number) + RESPAWN, 'and came back a respawn time later')
  assert.notEqual(RESPAWN, LATE, 'which is not the offset, or this would not tell them apart')
})

// ---------------------------------------------------------------------------- the same on every peer

test('a late order that is worked out across the tick it appears on gives the same frames as one that was there in time, and a snapshot from before or after plays on the same', () => {
  const orders = [attack(LATE + 10), { id: 'walk', seq: 99, tick: LATE - 5, type: 'move' as const, target: { x: HOME.x + 300, y: HOME.y } }]
  const straight = world()
  for (const order of orders) straight.addOrder(PLAYER, order)
  straight.advanceTo(LATE + 60)
  // Compared as data and not as text: a frame read back from a snapshot can list the same fields in another order than one worked out.
  const expected = JSON.parse(JSON.stringify(straight.at(LATE + 60).toData())) as unknown
  const frameOf = (simulator: Simulator): unknown => JSON.parse(JSON.stringify(simulator.at(LATE + 60).toData()))

  // The walk order arrives after the game has gone past the tick the monster appears on, so it is all worked out again from before it.
  const redone = world()
  redone.addOrder(PLAYER, orders[0])
  redone.advanceTo(LATE + 3)
  assert.equal(redone.addOrder(PLAYER, orders[1]), true, 'an order for a tick already worked out')
  redone.advanceTo(LATE + 60)
  assert.deepEqual(frameOf(redone), expected)

  // A page that joins before the monster has appeared, and one that joins after, are given a snapshot, and play on from it.
  for (const joinedAt of [LATE - 20, LATE + 25]) {
    const original = world()
    for (const order of orders) original.addOrder(PLAYER, order)
    original.advanceTo(joinedAt)
    original.setCommitTick(joinedAt - 10)
    const snapshot = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(original.snapshot())))
    assert.ok(snapshot.characters.some((character) => character.id === MONSTER), `the monster is in the game's characters at tick ${joinedAt}, whether or not it has appeared`)
    assert.equal(snapshot.checkpoint.characters.some((character) => character.characterId === MONSTER), joinedAt - 10 >= LATE, 'and in the frame only once it has')
    const joined = new Simulator()
    joined.replaceFromSnapshot(snapshot)
    joined.advanceTo(LATE + 60)
    assert.deepEqual(frameOf(joined), expected, `joined at ${joinedAt}`)
  }
})

// ---------------------------------------------------------------------------- on the page

test('the page does not draw or list a monster that has not appeared, and does when it has', () => {
  const state = new ClientGameState()
  state.simulator.addPlayer(PLAYER, 'p1', 'One', { x: HOME.x + 100, y: HOME.y }, hitter, 1)
  state.simulator.addMonster(MONSTER, late, HOME)
  state.setLocalCharacterId(PLAYER)
  state.simulator.advanceTo(LATE - 1)
  const before = state.getCharacters(0)
  assert.deepEqual(before.map((character) => character.id), [PLAYER], 'only the player')
  assert.equal(state.getEnemyNear(HOME, 0, before), undefined, 'and nothing to click on where it will be')

  state.simulator.advanceTo(LATE)
  const after = state.getCharacters(0)
  const monster = after.find((character) => character.id === MONSTER)
  assert.ok(monster, 'it is there on its tick')
  assert.equal(monster.health?.hp, late.champion.maxHp)
  assert.equal(monster.dead, false)
  assert.deepEqual(monster.position, HOME)
})
