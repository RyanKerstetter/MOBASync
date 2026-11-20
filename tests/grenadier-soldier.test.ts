import assert from 'node:assert/strict'
import test from 'node:test'
import { castRangeFor, getAbilityDef, PRIMED_KEY, PRIMED_QUIET_TICKS, PRIMED_QUIET_TICKS_PER_LEVEL, PRIMED_RANGE } from '../packages/shared/src/abilities.ts'
import { SOLDIER_LOW_HEALTH_SPEED, SOLDIER_LOW_HEALTH_SPEED_PER_LEVEL } from '../packages/shared/src/champions.ts'
import { champions, Simulator, type CharacterOrder, type Vector2 } from '../packages/shared/src/index.ts'
import { brawler } from './fixtures.ts'

// The Grenadier's passive: gone quiet long enough (no damage dealt or taken, no cast started), his next ability is primed, and stays primed, fight or no fight,
// until an ability spends it: it reaches farther, bursts wider, hurts more and throws farther. And the Soldier's: more attack speed the lower his health is.

const AT: Vector2 = { x: 600, y: 600 }

function order(seq: number, tick: number, rest: Record<string, unknown>): CharacterOrder {
  return { id: `player-1:${seq}`, seq, tick, ...rest } as CharacterOrder
}

function grenadierGame(enemyAt: Vector2 = { x: AT.x + 2000, y: AT.y }): Simulator {
  const grenadier = champions.get('grenadier')
  assert.ok(grenadier)
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', AT, grenadier)
  simulator.addPlayer(2, 'player-2', 'Player 2', enemyAt, brawler)
  return simulator
}

const primedAt = (simulator: Simulator, tick: number): boolean =>
  simulator.at(tick).get(1)?.getMarkers().some((marker) => marker.key === PRIMED_KEY) ?? false

// The first tick, from `from` on, read in order, that he is primed.
function primedFrom(simulator: Simulator, from: number, until = from + PRIMED_QUIET_TICKS * 2): number | undefined {
  for (let tick = from; tick <= until; tick += 1) if (primedAt(simulator, tick)) return tick
  return undefined
}

test('the Grenadier is primed once he has gone quiet long enough, and a cast starts the wait again', () => {
  assert.equal(primedFrom(grenadierGame(), 1), PRIMED_QUIET_TICKS, 'from the start of the game, at level 1')
  // A cast part way through: the wait starts again from it.
  const simulator = grenadierGame()
  const castTick = Math.floor(PRIMED_QUIET_TICKS / 2)
  simulator.addOrder(1, order(1, castTick, { type: 'cast', abilityId: 'molotov', target: { mode: 'point', point: { x: AT.x + 100, y: AT.y } }, origin: AT }))
  assert.equal(primedFrom(simulator, 1), castTick + PRIMED_QUIET_TICKS)
  assert.ok(PRIMED_QUIET_TICKS_PER_LEVEL > 0, 'and it is shorter each level')
})

test('a fight does not take the priming away: being hurt leaves it until an ability spends it', () => {
  const simulator = grenadierGame({ x: AT.x + 60, y: AT.y })
  // The enemy starts on him the moment he is primed.
  const primed = primedFrom(simulator, 1, PRIMED_QUIET_TICKS)
  assert.equal(primed, PRIMED_QUIET_TICKS)
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: primed + 1, type: 'attack', targetId: 1 } as CharacterOrder)
  let hurtAt: number | undefined
  const full = simulator.at(primed).get(1)?.getHealth() ?? 0
  for (let tick = primed + 1; tick < primed + 200 && hurtAt === undefined; tick += 1) {
    if ((simulator.at(tick).get(1)?.getHealth() ?? full) < full) hurtAt = tick
  }
  assert.ok(hurtAt !== undefined, 'he is hurt')
  assert.equal(primedAt(simulator, hurtAt), true, 'and still primed')
})

test('a primed throw reaches farther, is the primed one, spends the priming, and the next is plain', () => {
  const grenade = getAbilityDef('grenade')
  assert.ok(grenade)
  const far = { x: AT.x + (grenade.range + castRangeFor(grenade, () => true)) / 2, y: AT.y }
  assert.equal(castRangeFor(grenade, () => true), Math.round(grenade.range * PRIMED_RANGE))

  // Not primed: thrown that far, it is refused (the cooldown never starts).
  const plain = grenadierGame()
  plain.addOrder(1, order(1, 5, { type: 'cast', abilityId: 'grenade', target: { mode: 'point', point: far }, origin: AT }))
  assert.equal(plain.at(30).get(1)?.getAbilityCooldown('grenade').ready, true, 'out of a plain grenade\'s reach')

  // Primed: it goes, as the primed grenade, and the priming is spent.
  const simulator = grenadierGame()
  const castTick = PRIMED_QUIET_TICKS + 1
  simulator.addOrder(1, order(1, castTick, { type: 'cast', abilityId: 'grenade', target: { mode: 'point', point: far }, origin: AT }))
  let thrown: string | undefined
  for (let tick = 1; tick < castTick + 60 && thrown === undefined; tick += 1) {
    thrown = simulator.at(tick).getEntities().find((entity) => entity.defId.startsWith('grenade-shot'))?.defId
  }
  assert.equal(thrown, 'grenade-shot-primed')
  assert.equal(primedAt(simulator, castTick + 60), false, 'spent')
})

test('a primed grenade hurts more and throws what it catches farther than a plain one', () => {
  const grenade = getAbilityDef('grenade')
  assert.ok(grenade)
  const enemyAt = { x: AT.x + grenade.range / 2, y: AT.y }
  // The same throw at the same enemy, primed (after the quiet) or plain (just before it).
  const outcome = (primed: boolean): { damage: number; pushed: number } => {
    const simulator = grenadierGame(enemyAt)
    const castTick = primed ? PRIMED_QUIET_TICKS + 1 : PRIMED_QUIET_TICKS - 40
    // Just in front of it, so the blast has a way to throw it (from right on its middle, there is none).
    simulator.addOrder(1, order(1, castTick, { type: 'cast', abilityId: 'grenade', target: { mode: 'point', point: { x: enemyAt.x - 30, y: enemyAt.y } }, origin: AT }))
    let last = { hp: 0, x: 0 }
    for (let tick = 1; tick <= castTick + 120; tick += 1) {
      const enemy = simulator.at(tick).get(2)
      last = { hp: enemy?.getHealth() ?? 0, x: enemy?.getPosition().x ?? 0 }
    }
    return { damage: brawler.maxHp - last.hp, pushed: Math.abs(last.x - enemyAt.x) }
  }
  const plain = outcome(false)
  const primed = outcome(true)
  assert.ok(plain.damage > 0 && plain.pushed > 0, 'the plain one hits')
  assert.ok(primed.damage > plain.damage, `${primed.damage} damage primed, ${plain.damage} plain`)
  assert.ok(primed.pushed > plain.pushed, `thrown ${primed.pushed} primed, ${plain.pushed} plain`)
})

test('the Soldier attacks faster the lower his health is, up to his passive\'s most at none', () => {
  const soldier = champions.get('soldier')
  assert.ok(soldier)
  const maxHp = 1000
  for (const level of [1, 10]) {
    const most = SOLDIER_LOW_HEALTH_SPEED + SOLDIER_LOW_HEALTH_SPEED_PER_LEVEL * level
    assert.equal(soldier.lowHealthSpeedBonus(level, { hp: maxHp, maxHp }), 0, 'none at full health')
    assert.ok(Math.abs(soldier.lowHealthSpeedBonus(level, { hp: maxHp / 2, maxHp }) - most / 2) < 1e-9, 'half at half')
    assert.ok(Math.abs(soldier.lowHealthSpeedBonus(level, { hp: 0, maxHp }) - most) < 1e-9, 'all of it at none')
    assert.ok(
      soldier.attackCooldownTicksWith([], level, 0, 0, { hp: maxHp * 0.1, maxHp }) < soldier.attackCooldownTicksWith([], level, 0, 0, { hp: maxHp, maxHp }),
      'his attacks come quicker low',
    )
  }
  const grenadier = champions.get('grenadier')
  assert.equal(grenadier?.lowHealthSpeedBonus(1, { hp: 0, maxHp }), 0, 'and it is his alone')
})
