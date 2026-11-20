import assert from 'node:assert/strict'
import test from 'node:test'
import { getAbilityDef, STICK_RESET_TICKS } from '../packages/shared/src/abilities.ts'
import { champions, entityPosAt, Simulator, type CharacterOrder, type Vector2 } from '../packages/shared/src/index.ts'

// Warp goes to the Trinketmaster's stick while it is still in the air, as it does to one on the ground: he blinks to where it is, catches it, and the throw is
// ready again as soon as it would be had he walked over it.

const AT: Vector2 = { x: 600, y: 600 }

function order(seq: number, tick: number, rest: Record<string, unknown>): CharacterOrder {
  return { id: `player-1:${seq}`, seq, tick, ...rest } as CharacterOrder
}

test('warp blinks to a stick still in the air, catches it, and readies the throw', () => {
  const trinketmaster = champions.get('trinketmaster')
  const stick = getAbilityDef('stick')
  const warp = getAbilityDef('warp')
  assert.ok(trinketmaster && stick && warp)
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', AT, trinketmaster)
  // As far as it goes, so it is in the air longest.
  simulator.addOrder(1, order(1, 1, { type: 'cast', abilityId: 'stick', target: { mode: 'point', point: { x: AT.x + stick.range, y: AT.y } }, origin: AT }))
  let thrown: number | undefined
  for (let tick = 1; tick < 120 && thrown === undefined; tick += 1) {
    if (simulator.at(tick).getEntities().some((entity) => entity.defId === 'stick-shot')) thrown = tick
  }
  assert.ok(thrown !== undefined, 'the stick is thrown')
  simulator.addOrder(1, order(2, thrown + 1, { type: 'cast', abilityId: 'warp', target: { mode: 'none' }, origin: AT }))
  const launch = thrown + 1 + warp.windUpTicks

  // Just before the warp goes off, the stick is still in the air (or the test says nothing of one in the air).
  const before = simulator.at(launch - 1)
  const flying = before.getEntities().find((entity) => entity.defId === 'stick-shot')
  assert.ok(flying, 'the stick is still in the air when the warp goes off')
  const at = entityPosAt(flying, launch)

  const after = simulator.at(launch + 1)
  const position = after.get(1)?.getPosition()
  assert.ok(position)
  assert.ok(Math.hypot(position.x - at.x, position.y - at.y) < 30, `he is where the stick was: ${JSON.stringify(position)} by ${JSON.stringify(at)}`)
  assert.ok(position.x > AT.x + 50, 'well along the throw from where he stood')
  assert.equal(after.getEntities().some((entity) => entity.defId === 'stick-shot' || entity.defId === 'stick'), false, 'he has caught it')
  const left = after.get(1)?.getAbilityCooldown('stick').ticksRemaining ?? Infinity
  assert.ok(left <= STICK_RESET_TICKS, `the throw is all but ready again: ${left} ticks`)
  assert.equal(after.get(1)?.getAbilityCooldown('warp').ready, false, 'and the warp is on its cooldown')
})
