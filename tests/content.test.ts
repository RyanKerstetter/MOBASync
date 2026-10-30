import assert from 'node:assert/strict'
import test from 'node:test'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import {
  abilityDefs,
  champions,
  monsters,
  DEFAULT_CHAMPION_ID,
  GAME_MAX_CHAMPION_RADIUS,
  GAME_TPS,
  getEntityDef,
  Simulator,
  type AbilityDef,
  type CastTarget,
  type Champion,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { SHADOW_AUTO_BONUS, SHADOW_KEY } from '../packages/shared/src/abilities.ts'
import { testSpawns } from './test-spawns.ts'

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
    case 'point': {
      // Aimed at the enemy, or as near as the ability can be aimed if that is nearer than it allows.
      const at = enemyWithin(def.range)
      return { mode: 'point', point: { x: Math.max(at.x, CASTER_AT.x + (def.minRange ?? 0)), y: at.y } }
    }
    case 'unit': return { mode: 'unit', unitId: enemyId }
  }
}

test('the roster has a default champion and every champion is complete', () => {
  assert.ok(champions.has(DEFAULT_CHAMPION_ID), 'the default champion exists')
  for (const champion of champions.values()) {
    const who = `champion ${champion.id}`
    assert.ok(champion.name.length > 0, `${who} has a name`)
    assert.ok(champion.maxHp > 0 && champion.moveSpeed > 0 && champion.radius > 0, `${who} has body stats`)
    // A map is checked to have room for the widest body, so none may be wider.
    assert.ok(champion.radius <= GAME_MAX_CHAMPION_RADIUS, `${who} is no wider than a map has room for`)
    assert.ok(champion.attackDamage > 0 && champion.attackSpeed > 0 && champion.attackRange > 0, `${who} can attack`)
    assert.ok(champion.abilities.length >= 1 && champion.abilities.length <= 4, `${who} fits the Q/W/E/R slots`)
    assert.equal(new Set(champion.abilities).size, champion.abilities.length, `${who} has no repeated ability`)
    for (const abilityId of champion.abilities) {
      assert.ok(abilityDefs.has(abilityId), `${who} uses ${abilityId}, which exists`)
    }
  }
})

// Everything a champion can cast: the abilities on its keys, and the recasts that take their place.
function castable(champion: Champion): string[] {
  return champion.abilities.flatMap((abilityId) => {
    const recast = abilityDefs.get(abilityId)?.recast
    return recast === undefined ? [abilityId] : [abilityId, recast]
  })
}

test('every ability is well-formed and belongs to a champion or a monster', () => {
  const used = new Set([...champions.values(), ...[...monsters.values()].map((monster) => monster.champion)].flatMap(castable))
  for (const def of abilityDefs.values()) {
    assert.ok(used.has(def.id), `${def.id} is on a champion`)
    if (def.requires) {
      assert.ok(getEntityDef(def.requires.entity), `${def.id} needs ${def.requires.entity}, which exists`)
    }
    if (def.recast !== undefined) {
      const recast = abilityDefs.get(def.recast)
      assert.ok(recast, `${def.id}'s recast exists`)
      assert.equal(recast.targeting === 'none' || recast.targeting === def.targeting, true, `${def.id}'s recast can be aimed`)
    }
    assert.ok(Number.isInteger(def.windUpTicks) && def.windUpTicks >= 0, `${def.id} windup`)
    assert.ok(Number.isInteger(def.backswingTicks) && def.backswingTicks >= 0, `${def.id} backswing`)
    assert.ok(Number.isInteger(def.cooldownTicks) && def.cooldownTicks > 0, `${def.id} cooldown`)
    assert.ok(def.range >= 0, `${def.id} range`)
    assert.ok(def.apply.length > 0, `${def.id} does something`)
    if (def.indicator?.innerRadius !== undefined) {
      const { radius, innerRadius } = def.indicator
      assert.ok(radius !== undefined && innerRadius > 0 && innerRadius < radius, `${def.id}'s inner circle is inside its outer one`)
      assert.equal(def.targeting, 'point', `${def.id} draws its circles at a point`)
    }
  }
})

test('the server accepts every ability of every champion', () => {
  for (const champion of champions.values()) {
    const game = new ServerGameState(testSpawns)
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

// A game with the champion and an enemy, and the champion's cast of an ability at that enemy.
function duelWithCast(champion: Champion, abilityId: string, tick: number, seq: number, simulator?: Simulator): Simulator {
  const def = abilityDefs.get(abilityId)
  assert.ok(def)
  const [opponent] = champions.values()
  const duel = simulator ?? new Simulator()
  if (!simulator) {
    duel.addPlayer(1, 'player-1', 'Player 1', CASTER_AT, champion)
    duel.addPlayer(2, 'player-2', 'Player 2', enemyWithin(def.range), opponent)
  }
  // A cast that follows an earlier one in the same game starts from wherever that left the caster.
  const origin = simulator ? duel.at(tick).get(1)?.getPosition() ?? CASTER_AT : CASTER_AT
  duel.addOrder(1, {
    id: `player-1:${seq}`, seq, tick, type: 'cast', abilityId, target: targetFor(def, 2), origin: { ...origin },
  })
  return duel
}

// The first tick on which one of the champion's other abilities has put one of its entities out,
// and which ability did it: how a champion gets what an ability like Warp needs to be cast.
function putOut(champion: Champion, entityId: string): { abilityId: string; tick: number } | undefined {
  for (const abilityId of champion.abilities) {
    if (abilityDefs.get(abilityId)?.requires?.out === true) continue
    const duel = duelWithCast(champion, abilityId, 1, 1)
    for (let tick = 1; tick <= 300; tick += 1) {
      if (duel.at(tick).getEntities().some((entity) => entity.ownerId === 1 && entity.defId === entityId)) {
        return { abilityId, tick }
      }
    }
  }
  return undefined
}

test('every ability launches and plays out without errors', () => {
  for (const champion of champions.values()) {
    for (const abilityId of castable(champion)) {
      const def = abilityDefs.get(abilityId)
      assert.ok(def)
      let duel: Simulator
      let tick = 1
      if (def.requires?.out === true) {
        // It needs something out first, such as a stick on the ground: the champion has to put it there.
        const setup = putOut(champion, def.requires.entity)
        assert.ok(setup, `${champion.id} can get a ${def.requires.entity} out, for ${abilityId}`)
        duel = duelWithCast(champion, setup.abilityId, 1, 1)
        tick = setup.tick + 1
        // A dash has to finish, and an ability its cooldown, before it can be cast.
        while (duel.at(tick).get(1)?.isDashing() || duel.at(tick).get(1)?.getAbilityCooldown(abilityId).ready === false) tick += 1
        duelWithCast(champion, abilityId, tick, 2, duel)
      } else {
        duel = duelWithCast(champion, abilityId, tick, 1)
      }

      duel.advanceTo(tick + def.windUpTicks + 2)
      const cooldown = duel.at(duel.tick).get(1)?.getAbilityCooldown(abilityId)
      assert.equal(cooldown?.ready, false, `${champion.id} ${abilityId} was cast`)
      // Let every entity, pulse and status it made run its whole life.
      duel.advanceTo(tick + def.windUpTicks + 600)
      assert.ok(duel.at(duel.tick).get(2), `${champion.id} ${abilityId} left the game intact`)
    }
  }
})

// The throw goes as far as the player aims it, between the least and the most the ability allows:
// the stick comes down on the point it was thrown at.
test('the trinketmaster stick comes down on the point it was thrown at, from the nearest to the farthest', () => {
  const trinket = champions.get('trinketmaster')
  const def = abilityDefs.get('stick')
  assert.ok(trinket && def && def.minRange !== undefined)
  for (const distance of [def.minRange, (def.minRange + def.range) / 2, def.range]) {
    const simulator = new Simulator()
    simulator.addPlayer(1, 'player-1', 'Player 1', CASTER_AT, trinket)
    const point = { x: CASTER_AT.x + distance, y: CASTER_AT.y }
    simulator.addOrder(1, {
      id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 'stick', target: { mode: 'point', point }, origin: CASTER_AT,
    })
    let stick: { x: number; y: number } | undefined
    for (let tick = 1; tick <= 200 && !stick; tick += 1) {
      const entity = simulator.at(tick).getEntities().find((candidate) => candidate.defId === 'stick')
      if (entity) stick = entity.origin
    }
    assert.ok(stick, `a stick comes down when thrown ${distance} away`)
    assert.ok(Math.abs(stick.x - point.x) < 1e-6 && Math.abs(stick.y - point.y) < 1e-6, `on the point, ${distance} away`)
  }
})

// With no stick on the ground or in the air and the throw still on cooldown, warp gives the throw back
// instead of blinking, so it can be thrown again.
test('the trinketmaster warp gives the throw back when there is no stick anywhere', () => {
  const trinket = champions.get('trinketmaster')
  const warp = abilityDefs.get('warp')
  assert.ok(trinket && warp)
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', CASTER_AT, trinket)
  // The stick is thrown, called back once it is down, and long home by the time warp is cast.
  simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 'stick',
    target: { mode: 'point', point: { x: CASTER_AT.x + 200, y: CASTER_AT.y } }, origin: CASTER_AT,
  })
  simulator.addOrder(1, {
    id: 'player-1:2', seq: 2, tick: 80, type: 'cast', abilityId: 'recall', target: { mode: 'none' }, origin: CASTER_AT,
  })
  const warpAt = 200
  simulator.addOrder(1, {
    id: 'player-1:3', seq: 3, tick: warpAt, type: 'cast', abilityId: 'warp', target: { mode: 'none' }, origin: CASTER_AT,
  })

  assert.equal(simulator.at(warpAt - 1).getEntities().length, 0, 'nothing is out')
  assert.equal(simulator.at(warpAt - 1).get(1)?.getAbilityCooldown('stick').ready, false, 'and the throw is on cooldown')
  const launched = warpAt + warp.windUpTicks
  const frame = simulator.at(launched)
  assert.equal(frame.get(1)?.getAbilityCooldown('stick').ready, true, 'warp gives it back')
  assert.equal(frame.get(1)?.getAbilityCooldown('warp').ready, false, 'and is spent')
  assert.deepEqual(frame.get(1)?.getPosition(), CASTER_AT, 'without going anywhere')
})

// Not tuned numbers, just what the passive is: it is for abilities, not plain autos.
test('the trinketmaster plain autos never trigger its passive, however many land on the same enemy', () => {
  const trinket = champions.get('trinketmaster')
  assert.ok(trinket)
  const [opponent] = champions.values()
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', CASTER_AT, trinket)
  simulator.addPlayer(2, 'player-2', 'Player 2', enemyWithin(trinket.attackRange), opponent)
  simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  const landing = (index: number): number => 1 + index * trinket.attackCooldownTicks + trinket.attackWindupTicks

  const dealt: number[] = []
  let before = opponent.maxHp
  for (let index = 0; index < 4; index += 1) {
    const frame = simulator.at(landing(index))
    const health = frame.get(2)?.getHealth() ?? before
    dealt.push(before - health)
    before = health
    assert.equal(frame.get(1)?.getStatuses().some((status) => status.kind === 'haste'), false, 'no speed')
  }

  assert.ok(dealt[0] > 0, 'the autos land')
  assert.deepEqual(dealt, [dealt[0], dealt[0], dealt[0], dealt[0]], 'and every one does the same')
})

// The stick going out, the stick coming back and the auto Hush readies are three ability hits on the
// same enemy, and the last of them hits harder than a plain auto does and gives the trinketmaster speed.
test('the trinketmaster stick, recall and hush count for the passive, and the third hits harder and gives speed', () => {
  const trinket = champions.get('trinketmaster')
  assert.ok(trinket)
  const [opponent] = champions.values()
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', CASTER_AT, trinket)
  simulator.addPlayer(2, 'player-2', 'Player 2', enemyWithin(trinket.attackRange), opponent)
  simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 10, type: 'cast', abilityId: 'stick',
    target: { mode: 'point', point: { x: CASTER_AT.x + 200, y: CASTER_AT.y } }, origin: CASTER_AT,
  })
  // By tick 120 the stick has come down, and the recall brings it back through the enemy. Hush is
  // readied on tick 200, and the attack ordered on tick 201 is the auto it readied.
  simulator.addOrder(1, {
    id: 'player-1:2', seq: 2, tick: 120, type: 'cast', abilityId: 'recall', target: { mode: 'none' }, origin: CASTER_AT,
  })
  simulator.addOrder(1, {
    id: 'player-1:3', seq: 3, tick: 200, type: 'cast', abilityId: 'hush', target: { mode: 'none' }, origin: CASTER_AT,
  })
  simulator.addOrder(1, { id: 'player-1:4', seq: 4, tick: 201, type: 'attack', targetId: 2 })

  const dealt: number[] = []
  const hastedWhen: boolean[] = []
  let before = opponent.maxHp
  for (let tick = 1; tick <= 215; tick += 1) {
    const frame = simulator.at(tick)
    const health = frame.get(2)?.getHealth() ?? before
    if (health < before) {
      dealt.push(before - health)
      hastedWhen.push(frame.get(1)?.getStatuses().some((status) => status.kind === 'haste') ?? false)
      before = health
    }
  }

  assert.equal(dealt.length, 3, 'the stick out, the stick back and the hush auto')
  assert.ok(dealt[2] > trinket.attackDamage, 'the third does more than a plain auto')
  assert.deepEqual(hastedWhen, [false, false, true], 'and gives speed')
})

// Not a tuned number, just how the kit is meant to play: a dash that leaves a shadow does not leave
// the dash back ready as soon as it is over, so the two cannot be chained at once.
test('the ninja cannot dash back the moment its dash forward is over', () => {
  const ninja = champions.get('ninja')
  assert.ok(ninja)
  const setup = putOut(ninja, 'shadow')
  assert.ok(setup, 'the ninja can leave a shadow')
  const duel = duelWithCast(ninja, setup.abilityId, 1, 1)
  const [opponent] = champions.values()
  let tick = 1
  // The dash hurts what it passes through as it goes, so by the time it is over it has.
  while (duel.at(tick).get(1)?.isDashing()) tick += 1
  assert.ok((duel.at(tick).get(2)?.getHealth() ?? opponent.maxHp) < opponent.maxHp, 'the dash hurt what it passed through')

  assert.equal(duel.at(tick).get(1)?.getAbilityCooldown('shadowreturn').ready, false)
})

// The bonus is a share of the attack damage, read from its constant and not a number written here: an auto that spends a shadow stack hits for
// its attack damage times one plus the bonus, and one with none is plain, so the two are in that proportion whatever else is tuned.
test('the ninja auto spends a shadow stack for its attack damage times one plus the shadow bonus, and one with none is plain', () => {
  const ninja = champions.get('ninja')
  assert.ok(ninja)
  const duel = duelWithCast(ninja, 'shadowstep', 1, 1)
  let tick = 1
  while (duel.at(tick).get(1)?.isDashing()) tick += 1
  const stacks = duel.at(tick).get(1)?.getMarkers().filter((marker) => marker.key === SHADOW_KEY).length ?? 0
  assert.equal(stacks, 1, 'the dash through the enemy gave one shadow stack')

  // It walks back to the enemy it dashed through and autos it until the end, the first with the stack and the rest with none.
  duel.addOrder(1, { id: 'player-1:2', seq: 2, tick: tick + 1, type: 'attack', targetId: 2 })
  const dealt: number[] = []
  let before = duel.at(tick).get(2)?.getHealth() ?? 0
  for (let at = tick + 1; at <= tick + 1 + 300; at += 1) {
    const health = duel.at(at).get(2)?.getHealth() ?? before
    if (health < before) dealt.push(before - health)
    before = health
  }
  assert.ok(dealt.length >= 2, `it autoed twice or more: ${dealt}`)
  const [spent, plain] = dealt
  assert.ok(plain > 0, 'an auto with no stack deals damage')
  // Health is whole numbers, so each hit is rounded: allow the hit point.
  assert.ok(Math.abs(spent - plain * (1 + SHADOW_AUTO_BONUS)) <= 1, `${spent} is ${plain} and ${SHADOW_AUTO_BONUS * 100}% more`)
  assert.deepEqual(dealt.slice(1).every((amount) => amount === plain), true, 'and every auto after it is plain')
})

test('every champion\'s auto attack lands and deals damage', () => {
  const [opponent] = champions.values()
  for (const champion of champions.values()) {
    const simulator = new Simulator()
    simulator.addPlayer(1, 'player-1', 'Player 1', CASTER_AT, champion)
    simulator.addPlayer(2, 'player-2', 'Player 2', enemyWithin(champion.attackRange), opponent)
    simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })

    // An attack with a projectile lands when the shot arrives, so allow for the time it flies.
    const gap = enemyWithin(champion.attackRange).x - CASTER_AT.x
    const flightTicks = champion.attackProjectile
      ? Math.ceil(gap / champion.attackProjectile.speed * GAME_TPS) + 2
      : 0
    const frame = simulator.at(1 + champion.attackWindupTicks + flightTicks + 1)
    assert.ok((frame.get(2)?.getHealth() ?? opponent.maxHp) < opponent.maxHp, `${champion.id} hurt its target`)
    assert.equal(frame.getEntities().length, 0, `${champion.id}'s shot is spent`)
  }
})
