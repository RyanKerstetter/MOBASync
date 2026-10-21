import assert from 'node:assert/strict'
import test from 'node:test'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  abilityDefs,
  champions,
  DEFAULT_CHAMPION_ID,
  Simulator,
  type AbilityDef,
  type CastTarget,
  type Vector2,
} from '../packages/shared/src/index.ts'

// These check the real roster is well-formed and that every ability and auto attack actually
// runs. They read nothing tuned (damage, cooldowns, ranges), so rebalancing never breaks them.
// This file does not load the test fixtures, so only the shipped champions are in the registry.

const CASTER_AT: Vector2 = { x: 100, y: 225 }

// An enemy standing in front of the caster, close enough for `reach` whatever it is tuned to.
function enemyWithin(reach: number): Vector2 {
  return { x: CASTER_AT.x + Math.max(10, Math.min(60, reach - 10)), y: CASTER_AT.y }
}

function targetFor(def: AbilityDef, enemyId: number): CastTarget {
  switch (def.targeting) {
    case 'none': return { mode: 'none' }
    case 'direction': return { mode: 'direction', dir: { x: 1, y: 0 } }
    case 'point': return { mode: 'point', point: enemyWithin(def.range) }
    case 'unit': return { mode: 'unit', unitId: enemyId }
  }
}

test('the roster has a default champion and every champion is complete', () => {
  assert.ok(champions.has(DEFAULT_CHAMPION_ID), 'the default champion exists')
  for (const champion of champions.values()) {
    const who = `champion ${champion.id}`
    assert.ok(champion.name.length > 0, `${who} has a name`)
    assert.ok(champion.maxHp > 0 && champion.moveSpeed > 0 && champion.radius > 0, `${who} has body stats`)
    assert.ok(champion.attackDamage > 0 && champion.attackSpeed > 0 && champion.attackRange > 0, `${who} can attack`)
    assert.ok(champion.abilities.length >= 1 && champion.abilities.length <= 4, `${who} fits the Q/W/E/R slots`)
    assert.equal(new Set(champion.abilities).size, champion.abilities.length, `${who} has no repeated ability`)
    for (const abilityId of champion.abilities) {
      assert.ok(abilityDefs.has(abilityId), `${who} uses ${abilityId}, which exists`)
    }
  }
})

test('every ability is well-formed and belongs to a champion', () => {
  const used = new Set([...champions.values()].flatMap((champion) => champion.abilities))
  for (const def of abilityDefs.values()) {
    assert.ok(used.has(def.id), `${def.id} is on a champion`)
    assert.ok(Number.isInteger(def.windUpTicks) && def.windUpTicks >= 0, `${def.id} windup`)
    assert.ok(Number.isInteger(def.backswingTicks) && def.backswingTicks >= 0, `${def.id} backswing`)
    assert.ok(Number.isInteger(def.cooldownTicks) && def.cooldownTicks > 0, `${def.id} cooldown`)
    assert.ok(def.range >= 0, `${def.id} range`)
    assert.ok(def.apply.length > 0, `${def.id} does something`)
  }
})

test('the server accepts every ability of every champion', () => {
  for (const champion of champions.values()) {
    const game = new ServerGameState()
    const players = [{ id: 'player-1', name: 'One' }, { id: 'player-2', name: 'Two' }]
    game.beginSelection(players)
    assert.equal(game.pickChampion('player-1', champion.id), true, `${champion.id} can be picked`)
    game.lockChampion('player-1')
    game.lockChampion('player-2')
    game.begin(players)
    const characterId = game.getCharacterId('player-1')
    const enemyId = game.getCharacterId('player-2')
    assert.ok(characterId && enemyId)
    const origin = game.simulator.at(0).get(characterId)?.getPosition()
    assert.ok(origin)

    champion.abilities.forEach((abilityId, index) => {
      const def = abilityDefs.get(abilityId)
      assert.ok(def)
      const verdict = game.acceptOrder('player-1', {
        id: `player-1:${index + 1}`,
        seq: index + 1,
        tick: index + 1,
        type: 'cast',
        abilityId,
        target: targetFor(def, enemyId),
        origin,
      })
      assert.equal(verdict.ack.status, 'accepted', `${champion.id} ${abilityId}`)
    })
  }
})

test('every ability launches and plays out without errors', () => {
  const [opponent] = champions.values()
  for (const champion of champions.values()) {
    for (const abilityId of champion.abilities) {
      const def = abilityDefs.get(abilityId)
      assert.ok(def)
      const simulator = new Simulator()
      simulator.addPlayer(1, 'player-1', 'Player 1', CASTER_AT, champion)
      simulator.addPlayer(2, 'player-2', 'Player 2', enemyWithin(def.range), opponent)
      simulator.addOrder(1, {
        id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId, target: targetFor(def, 2), origin: CASTER_AT,
      })

      simulator.advanceTo(1 + def.windUpTicks + 2)
      const cooldown = simulator.at(simulator.tick).get(1)?.getAbilityCooldown(abilityId)
      assert.equal(cooldown?.ready, false, `${champion.id} ${abilityId} was cast`)
      // Let every entity, pulse and status it made run its whole life.
      simulator.advanceTo(1 + def.windUpTicks + 600)
      assert.ok(simulator.at(simulator.tick).get(2), `${champion.id} ${abilityId} left the game intact`)
    }
  }
})

test('every champion\'s auto attack lands and deals damage', () => {
  const [opponent] = champions.values()
  for (const champion of champions.values()) {
    const simulator = new Simulator()
    simulator.addPlayer(1, 'player-1', 'Player 1', CASTER_AT, champion)
    simulator.addPlayer(2, 'player-2', 'Player 2', enemyWithin(champion.attackRange), opponent)
    simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })

    const landed = simulator.at(1 + champion.attackWindupTicks + 1).get(2)
    assert.ok((landed?.getHealth() ?? opponent.maxHp) < opponent.maxHp, `${champion.id} hurt its target`)
  }
})
