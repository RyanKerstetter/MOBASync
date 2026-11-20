import assert from 'node:assert/strict'
import test from 'node:test'
import { LEAP_BONUS_SCALING, readyKey } from '../packages/shared/src/abilities.ts'
import { champions, Simulator, type CharacterOrder, type Vector2 } from '../packages/shared/src/index.ts'
import { brawler } from './fixtures.ts'

// The Archer's Leap: the cast resets her auto timer, so the next auto can go at once, and that auto deals half her attack damage again on top of its own.

const ARCHER_AT: Vector2 = { x: 300, y: 300 }
const ENEMY_AT: Vector2 = { x: 500, y: 300 }

function order(seq: number, tick: number, rest: Record<string, unknown>): CharacterOrder {
  return { id: `player-1:${seq}`, seq, tick, ...rest } as CharacterOrder
}

test('leap resets the auto timer, and the next auto deals 150% of a plain one, once', () => {
  const archer = champions.get('archer')
  assert.ok(archer)
  assert.equal(LEAP_BONUS_SCALING.attackDamage, 0.5, 'half the attack damage again')
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', ARCHER_AT, archer)
  simulator.addPlayer(2, 'player-2', 'Player 2', ENEMY_AT, brawler)
  simulator.addOrder(1, order(1, 1, { type: 'attack', targetId: 2 }))

  // The hits on the enemy, as the drops in its health, tick by tick, read in order.
  const hits: Array<{ tick: number; damage: number; readied: boolean }> = []
  let health = simulator.at(1).get(2)?.getHealth() ?? 0
  const read = (until: number, from: number): void => {
    for (let tick = from; tick <= until; tick += 1) {
      const now = simulator.at(tick).get(2)?.getHealth() ?? 0
      const readied = simulator.at(tick).get(1)?.getMarkers().some((marker) => marker.key === readyKey('leap')) ?? false
      if (now < health) hits.push({ tick, damage: health - now, readied })
      health = now
    }
  }
  // A plain auto first.
  let tick = 1
  while (hits.length === 0 && tick < 300) read(tick, tick++)
  assert.equal(hits.length, 1, 'a plain auto lands')
  const plain = hits[0].damage

  // Leap, toward the enemy (she stays in reach), two ticks after it.
  const castTick = hits[0].tick + 2
  read(castTick - 1, tick)
  const before = simulator.at(castTick - 1).get(1)
  const naturalNext = before?.getNextAttackTick()
  assert.ok(naturalNext !== undefined && naturalNext > castTick, 'the next auto would have had to wait')
  const from = before?.getPosition()
  assert.ok(from)
  simulator.addOrder(1, order(2, castTick, { type: 'cast', abilityId: 'leap', target: { mode: 'point', point: { x: from.x + 100, y: from.y } }, origin: from }))
  const cast = simulator.at(castTick).get(1)
  assert.equal(cast?.getNextAttackTick(), castTick, 'the auto timer was reset')
  assert.equal(cast?.getMarkers().filter((marker) => marker.key === readyKey('leap')).length, 1, 'and the next auto readied')

  // The next two autos: the leap's, and a plain one after it.
  tick = castTick
  while (hits.length < 3 && tick < castTick + 400) read(tick, tick++)
  assert.equal(hits.length, 3)
  const [, empowered, after] = hits
  assert.ok(empowered.tick < naturalNext + 20, `the leap's auto came early: on tick ${empowered.tick}, the plain one would have gone from ${naturalNext}`)
  assert.ok(Math.abs(empowered.damage / plain - 1.5) < 0.02, `${empowered.damage} against ${plain}: 150%`)
  assert.ok(Math.abs(after.damage - plain) < 0.5, 'and the auto after it is plain again')
  assert.equal(empowered.readied, false, 'it is spent by the auto that carries it')
})
