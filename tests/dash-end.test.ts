import assert from 'node:assert/strict'
import test from 'node:test'
import { champions, GAME_DASH_FREE_TICKS, getAbilityDef, Simulator, type CastOrder, type Vector2 } from '../packages/shared/src/index.ts'

// The end of a dash is not time spent waiting: a champion can act (cast, start an attack) in the last `GAME_DASH_FREE_TICKS` ticks of its own dash while it is carried
// the rest of the way, and a dash that is held back (shoving someone along) is over when it would have been unheld, wherever it has got to.

const AT: Vector2 = { x: 700, y: 700 }

function cast(seq: number, tick: number, abilityId: string, target: CastOrder['target'], origin: Vector2): CastOrder {
  return { id: `player-1:${seq}`, seq, tick, type: 'cast', abilityId, target, origin }
}

// The Cloak and an enemy in reach of Cut Through, with Cut Through cast on it on the first tick.
function cutThrough(): Simulator {
  const cloak = champions.get('cloak')
  const enemy = champions.get('swordsman')
  assert.ok(cloak && enemy)
  const reach = getAbilityDef('cutthrough')?.range
  assert.ok(reach)
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', AT, cloak)
  simulator.addPlayer(2, 'player-2', 'Player 2', { x: AT.x + reach / 2, y: AT.y }, enemy)
  simulator.addOrder(1, cast(1, 1, 'cutthrough', { mode: 'unit', unitId: 2 }, AT))
  return simulator
}

// The tick a character's dash is over (the first it is not dashing on), from `from`.
function dashOver(simulator: Simulator, from: number, id = 1): number {
  for (let tick = from; tick < from + 600; tick += 1) {
    if (!simulator.at(tick).get(id)?.isDashing()) return tick
  }
  throw new Error('the dash never ended')
}

test('a champion can cast again in the last few ticks of its own dash, and not before', () => {
  assert.ok(GAME_DASH_FREE_TICKS > 0, 'the end of a dash can be acted in')
  const over = dashOver(cutThrough(), 2)
  const free = over - GAME_DASH_FREE_TICKS
  assert.ok(free > 2, 'the dash is longer than its free end')
  const knives = getAbilityDef('knives')
  assert.ok(knives)
  // Knives ordered on a tick of the dash: cast if it goes on cooldown that tick.
  const castOn = (tick: number): boolean => {
    const simulator = cutThrough()
    const from = simulator.at(tick).get(1)?.getPosition()
    assert.ok(from)
    simulator.addOrder(1, cast(2, tick, 'knives', { mode: 'direction', dir: { x: 1, y: 0 } }, from))
    const state = simulator.at(tick).get(1)
    assert.equal(state?.isDashing(), true, `still dashing on tick ${tick}`)
    return state?.getAbilityCooldown('knives').ready === false || state?.getAction()?.kind === 'cast'
  }
  assert.equal(castOn(free - 1), false, 'refused the tick before')
  assert.equal(castOn(free), true, 'cast from the first free tick, while it is carried on')
})

test('what the page holds a cast back for is the same: held until the free end of the dash, and not in it', () => {
  const over = dashOver(cutThrough(), 2)
  const free = over - GAME_DASH_FREE_TICKS
  for (const [tick, held] of [[free - 1, true], [free, false]] as const) {
    const state = cutThrough().at(tick).get(1)
    assert.ok(state)
    assert.equal(state.isDashing(), true)
    assert.equal(state.dashHolds(tick), held, `tick ${tick}`)
  }
})

test('a dash that shoves someone along is over when it would have been unheld, and does not go on pushing', () => {
  const chain = champions.get('chain')
  const enemy = champions.get('swordsman')
  const lunge = getAbilityDef('lunge')
  assert.ok(chain && enemy && lunge)
  const lungeAt = (blocker: boolean): number => {
    const simulator = new Simulator()
    simulator.addPlayer(1, 'player-1', 'Player 1', AT, chain)
    // Right in the way, or well out of it.
    simulator.addPlayer(2, 'player-2', 'Player 2', blocker ? { x: AT.x + lunge.range / 3, y: AT.y } : { x: AT.x, y: AT.y + 1000 }, enemy)
    simulator.addOrder(1, cast(1, 1, 'lunge', { mode: 'point', point: { x: AT.x + lunge.range, y: AT.y } }, AT))
    return dashOver(simulator, 2)
  }
  const unheld = lungeAt(false)
  assert.ok(lungeAt(true) <= unheld, `over by tick ${unheld}, as it would be with no one in the way`)
})

test('a jump is not acted out of before it comes down', () => {
  const hammer = champions.get('hammer')
  const drop = getAbilityDef('hammerdrop')
  assert.ok(hammer && drop)
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', AT, hammer)
  simulator.addOrder(1, cast(1, 1, 'hammerdrop', { mode: 'point', point: { x: AT.x + drop.range / 2, y: AT.y } }, AT))
  // Read in order, as the frames are kept only a little while.
  let airborne = 0
  for (let tick = 1; tick < 300; tick += 1) {
    const state = simulator.at(tick).get(1)
    if (!state?.isDashing()) {
      if (airborne > 0) break
      continue
    }
    airborne += 1
    assert.equal(state.dashHolds(tick), true, `held on tick ${tick}`)
  }
  assert.ok(airborne > GAME_DASH_FREE_TICKS, 'it jumps, for longer than a dash\'s free end')
})
