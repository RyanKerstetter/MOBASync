import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { layoutStackPips } from '../apps/client/src/render/stack-pips.ts'
import { statusLabels } from '../apps/client/src/render/status-labels.ts'
import { abilityTooltip } from '../apps/client/src/ui/ability-tooltip.ts'
import {
  abilityDefs,
  abilityOnKey,
  Champion,
  GAME_ARENA_WIDTH,
  GAME_BURN_PULSE_TICKS,
  GAME_MAX_CHAMPION_RADIUS,
  GAME_TPS,
  getChampion,
  Simulator,
  type CastTarget,
  type CharacterOrder,
  type GameEvent,
  type GameTickSnapshot,
  type Vector2,
} from '../packages/shared/src/index.ts'
import {
  BURN_DPS_PER_STACK,
  BURN_MAX_STACKS,
  BURN_SCALING,
  BURN_STACK_KEY,
  BURN_STACK_TICKS,
  FIREBALL_BLAST_DAMAGE,
  FIREBALL_BLAST_RADIUS,
  FIREBALL_BLAST_SCALING,
  FIREBALL_DAMAGE,
  FIREBALL_RANGE,
  FIREBALL_SCALING,
  FIREBALL_SLOW,
  FIREBALL_STUN_TICKS,
  SCORCH_BURN,
  SCORCH_BURN_SCALING,
  SCORCH_BURN_TICKS,
  SCORCH_DAMAGE,
  SCORCH_GROUND_TICKS,
  SCORCH_RANGE,
  SCORCH_SCALING,
  TORNADO_DAMAGE,
  TORNADO_DELAY_TICKS,
  TORNADO_KNOCKUP_TICKS,
  TORNADO_RADIUS,
  TORNADO_RANGE,
  TORNADO_SCALING,
} from '../packages/shared/src/abilities.ts'

// The Fire Mage's kit, played out in the simulator: the burn stacks every ability adds (and the burn that grows with them), the fireball that blows up on what it hits or when it is set
// off and stuns at full stacks, the tornado that throws enemies into the air, and the wave that leaves the ground burning. The numbers come from the exported constants and his own
// stats, so retuning the kit does not break these; what they check is how it is meant to play. The bodies he is played against are the test's own.

const HOME: Vector2 = { x: 400, y: 600 }
const R = GAME_MAX_CHAMPION_RADIUS
const mage = getChampion('firemage')
const arcane = mage.statsAt(1).arcane

// A body that takes whatever it is given and stays where it is put.
const bag = new Champion({
  id: 't-fire-bag',
  name: 'Test Bag',
  base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 140,
  radius: R,
  attackRange: 50,
  attackWindup: 0,
  abilities: [],
})

let sequence = 0
const cast = (tick: number, abilityId: string, target: CastTarget, origin: Vector2 = HOME): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target, origin: { ...origin } })
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })
const east: CastTarget = { mode: 'direction', dir: { x: 1, y: 0 } }
const none: CastTarget = { mode: 'none' }
const point = (at: Vector2): CastTarget => ({ mode: 'point', point: { ...at } })
const goesOff = (abilityId: string, tick: number): number => tick + (abilityDefs.get(abilityId)?.windUpTicks ?? 0)

// A game played forward a tick at a time, which keeps every event it has seen: the simulator keeps only the last few frames, so what happened earlier is read from here. Orders are
// only ever added for ticks it has not reached, so nothing it has seen is played again.
class Game {
  readonly simulator = new Simulator()
  private readonly log: Array<{ tick: number; event: GameEvent }> = []
  private reached = 0

  at(tick: number): GameTickSnapshot {
    while (this.reached < tick) {
      this.reached += 1
      for (const event of this.simulator.at(this.reached).events) this.log.push({ tick: this.reached, event })
    }
    return this.simulator.at(tick)
  }

  order(id: number, order: CharacterOrder): void {
    assert.ok(order.tick > this.reached, 'an order for a tick that is still to come')
    this.simulator.addOrder(id, order)
  }

  // Every hit (not a burn's pulse) the Fire Mage has landed on a unit, by its amount, up to tick `to`.
  hitsOn(id: number, to: number): number[] {
    this.at(to)
    return this.log
      .filter(({ tick, event }) => tick <= to && event.type === 'damage' && event.ownerId === 1 && event.targetId === id && !event.overTime)
      .map(({ event }) => (event as Extract<GameEvent, { type: 'damage' }>).amount)
  }

  // The first tick from `from` to `until` on which this holds.
  firstTick(from: number, until: number, holds: (frame: GameTickSnapshot) => boolean): number | undefined {
    for (let tick = from; tick <= until; tick += 1) if (holds(this.at(tick))) return tick
    return undefined
  }
}

// The Fire Mage is character 1, on team 1; each of the others is on a team of its own, so an enemy.
function scene(others: readonly Vector2[]): Game {
  const game = new Game()
  game.simulator.addPlayer(1, 'p1', 'One', HOME, mage, 1)
  others.forEach((at, index) => game.simulator.addPlayer(index + 2, `p${index + 2}`, `Other ${index + 2}`, at, bag, index + 2))
  return game
}

const ahead = (reach: number, across = 0): Vector2 => ({ x: HOME.x + reach, y: HOME.y + across })
const stacksOn = (frame: GameTickSnapshot, id: number): number => frame.get(id)?.getMarkers().filter((marker) => marker.key === BURN_STACK_KEY).length ?? 0
const statusesOf = (frame: GameTickSnapshot, id: number, kind: string) => frame.get(id)?.getStatuses().filter((status) => status.kind === kind) ?? []
const named = (frame: GameTickSnapshot, id: number, name: string, kind: string) =>
  frame.get(id)?.getStatuses().find((status) => status.id === `1:${name}:${kind}`)
const close = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 1e-9
// What a burn of `stacks` stacks takes on each pulse.
const pulseOf = (stacks: number): number => Math.round((BURN_DPS_PER_STACK + (BURN_SCALING.arcane ?? 0) * arcane) * stacks * GAME_BURN_PULSE_TICKS / GAME_TPS)
const fireballHit = FIREBALL_DAMAGE + (FIREBALL_SCALING.arcane ?? 0) * arcane
const blastHit = FIREBALL_BLAST_DAMAGE + (FIREBALL_BLAST_SCALING.arcane ?? 0) * arcane

// Where an enemy stands for a shot or a wave to reach it: half way along the shorter of the two.
const REACH = Math.min(FIREBALL_RANGE, SCORCH_RANGE) / 2
// Long enough for anything a cast leaves behind to have played out.
const WHILE = 5 * GAME_TPS
// Once nothing he sent out is left in the world, and the enemy carries stacks: all of a cast has played out on it.
const settled = (id: number) => (frame: GameTickSnapshot): boolean => frame.getEntities().length === 0 && stacksOn(frame, id) > 0

// ---------------------------------------------------------------------------- Fireball

test('a fireball that hits an enemy straight on gives it two stacks, and one caught only by the blast one, and both are slowed', () => {
  // The first is on the shot's path; the second stands beside it, its body clear of the first's and off the path, but inside the blast.
  const game = scene([ahead(REACH), ahead(REACH, 2 * R + 2)])
  game.order(1, cast(1, 'fireball', east))
  const done = game.firstTick(goesOff('fireball', 1), WHILE, settled(2))
  assert.ok(done, 'it plays out')
  const direct = game.hitsOn(2, done)
  const beside = game.hitsOn(3, done)
  const frame = game.at(done)

  assert.equal(stacksOn(frame, 2), 2, 'two on the enemy hit straight on: the shot and the blast')
  assert.equal(stacksOn(frame, 3), 1, 'one on the enemy the blast caught')
  assert.equal(direct.length, 2, 'the enemy hit straight on takes the shot and the blast')
  assert.ok(close(direct[0], fireballHit) && close(direct[1], blastHit), `${direct}`)
  assert.equal(beside.length, 1, 'the one beside it takes the blast alone')
  assert.ok(close(beside[0], blastHit))
  for (const id of [2, 3]) {
    assert.ok(statusesOf(frame, id, 'slow').some((slow) => slow.amount === FIREBALL_SLOW), `${id} is slowed`)
    assert.equal(statusesOf(frame, id, 'stun').length, 0, `${id} is short of full stacks, so is not stunned`)
  }
  // The burn is worked out from the stacks: as many shares of a stack's burn as there are stacks.
  assert.equal(named(frame, 2, BURN_STACK_KEY, 'burn')?.amount, pulseOf(2))
  assert.equal(named(frame, 3, BURN_STACK_KEY, 'burn')?.amount, pulseOf(1))
})

test('a fireball that brings an enemy to full stacks stuns it instead of slowing it', () => {
  const target = ahead(Math.min(REACH, TORNADO_RANGE))
  const game = scene([target])
  // The fireball straight on puts the last two stacks on: the one before full with its shot (a slow), and the last with its blast (a stun). The wave and then the tornado put
  // on the ones before those, as many as are needed.
  const before = BURN_MAX_STACKS - 2
  assert.ok(before >= 0 && before <= 2, 'the wave and the tornado can put on the stacks before the fireball\'s')
  let next = 1
  let had = 0
  for (const [abilityId, aim] of [['scorch', east], ['firetornado', point(target)]] as const) {
    if (had >= before) break
    game.order(1, cast(next, abilityId, aim))
    const added = game.firstTick(next, next + WHILE, (frame) => stacksOn(frame, 2) > had)
    assert.ok(added, `${abilityId} adds a stack`)
    had = stacksOn(game.at(added), 2)
    next = added + 1
  }
  assert.equal(had, before)
  game.order(1, cast(next, 'fireball', east))
  const hit = game.firstTick(next, next + WHILE, (frame) => stacksOn(frame, 2) === before + 1)
  assert.ok(hit, 'the shot lands')
  assert.equal(statusesOf(game.at(hit), 2, 'stun').length, 0, 'the shot, short of full stacks, does not stun')
  const blown = game.firstTick(hit, hit + WHILE, (frame) => stacksOn(frame, 2) === BURN_MAX_STACKS)
  assert.ok(blown, 'the blast follows it')
  const stun = statusesOf(game.at(blown), 2, 'stun').find((status) => status.ownerId === 1)
  assert.ok(stun, 'the blast, at full stacks, stuns')
  assert.equal(stun.endTick - stun.startTick, FIREBALL_STUN_TICKS)
})

test('while the fireball flies its key is Detonate, which blows it up where it is, one stack for everyone caught, and takes it away', () => {
  // Off the shot's path, its body clear of it, half way along the flight: the shot passes it by, and the blast reaches it from the path.
  const reach = FIREBALL_RANGE / 2
  const game = scene([ahead(reach, Math.max(FIREBALL_BLAST_RADIUS, 2 * R + 2))])
  const def = abilityDefs.get('fireball')
  assert.ok(def)
  game.order(1, cast(1, 'fireball', east))
  const launched = goesOff('fireball', 1)
  const shotX = (frame: GameTickSnapshot): number | undefined => {
    const shot = frame.getEntities().find((entity) => entity.defId === 'fireball' && entity.ownerId === 1)
    return shot && shot.origin.x + shot.velocity.x * (frame.tick - shot.startTick) / GAME_TPS
  }
  // When the shot is level with the enemy.
  const level = game.firstTick(launched, launched + WHILE, (frame) => (shotX(frame) ?? -Infinity) >= HOME.x + reach)
  assert.ok(level, 'the shot gets there')
  const out = (frame: GameTickSnapshot) => (defId: string) => frame.getEntities().some((entity) => entity.defId === defId && entity.ownerId === 1)
  assert.equal(abilityOnKey(def, out(game.at(level))).id, 'detonate', 'the key sets it off while it flies')
  assert.equal(game.hitsOn(2, level).length, 0, 'it has not hit the enemy')

  game.order(1, cast(level + 1, 'detonate', none, game.at(level).get(1)?.getPosition()))
  const done = game.firstTick(level + 1, level + WHILE, settled(2))
  assert.ok(done, 'it plays out')
  const hits = game.hitsOn(2, done)
  const frame = game.at(done)
  assert.equal(stacksOn(frame, 2), 1, 'one stack, from the blast alone')
  assert.equal(hits.length, 1)
  assert.ok(close(hits[0], blastHit))
  assert.equal(frame.getEntities().some((entity) => entity.defId === 'fireball'), false, 'the shot is gone')
  assert.equal(abilityOnKey(def, out(frame)).id, 'fireball', 'and the key is the fireball again')
  assert.equal(frame.get(1)?.getAbilityCooldown('fireball').ready, false, 'still on its cooldown')
})

test('a fireball set off on the tick it would have hit blows up once, and the shot does not hit as well', () => {
  const plain = scene([ahead(REACH)])
  plain.order(1, cast(1, 'fireball', east))
  const hit = plain.firstTick(goesOff('fireball', 1), WHILE, (frame) => stacksOn(frame, 2) > 0)
  assert.ok(hit)

  const game = scene([ahead(REACH)])
  game.order(1, cast(1, 'fireball', east))
  const before = game.at(hit - 1).get(1)?.getPosition()
  game.order(1, cast(hit, 'detonate', none, before))
  const done = game.firstTick(hit, hit + WHILE, settled(2))
  assert.ok(done)
  assert.equal(game.hitsOn(2, done).length, 1, 'one blast, and no shot')
  assert.equal(stacksOn(game.at(done), 2), 1)
})

test('a fireball that hits nothing and is not set off blows up at the end of its flight', () => {
  // Off the path, its body clear of it, at the end of the flight: the shot passes it by, and the blast at the end reaches it.
  const game = scene([ahead(FIREBALL_RANGE, 2 * R + 2)])
  game.order(1, cast(1, 'fireball', east))
  const done = game.firstTick(goesOff('fireball', 1), WHILE, settled(2))
  assert.ok(done, 'it blows up')
  const hits = game.hitsOn(2, done)
  assert.equal(hits.length, 1, 'the blast, and no shot')
  assert.ok(close(hits[0], blastHit))
  assert.equal(stacksOn(game.at(done), 2), 1)
  assert.ok(statusesOf(game.at(done), 2, 'slow').some((slow) => slow.amount === FIREBALL_SLOW), 'slowed')
})

test('a fireball thrown at the edge of the arena blows up at the edge, inside it', () => {
  const from = { x: GAME_ARENA_WIDTH - FIREBALL_RANGE / 2, y: HOME.y }
  const game = new Game()
  game.simulator.addPlayer(1, 'p1', 'One', from, mage, 1)
  game.order(1, cast(1, 'fireball', east, from))
  const blast = game.firstTick(goesOff('fireball', 1), WHILE, (frame) => frame.getEntities().some((entity) => entity.defId === 'fireball-flash'))
  assert.ok(blast, 'it blows up')
  const flash = game.at(blast).getEntities().find((entity) => entity.defId === 'fireball-flash')
  assert.ok(flash && flash.origin.x <= GAME_ARENA_WIDTH && flash.origin.x > from.x, `at the edge: ${flash?.origin.x}`)
})

// ---------------------------------------------------------------------------- Fire Tornado

test('the fire tornado throws the enemies inside it into the air as its warning runs out, and one that walked out is not caught', () => {
  const spot = ahead(TORNADO_RANGE / 2)
  // Both start inside: the first well in, and the second only just, its body touching the edge. The second steps out as soon as it can.
  const edge = spot.x + TORNADO_RADIUS + R - 1
  const game = scene([{ x: spot.x - TORNADO_RADIUS / 2, y: spot.y }, { x: edge, y: spot.y }])
  game.order(3, move(2, { x: edge + 4 * R, y: spot.y }))
  game.order(1, cast(1, 'firetornado', point(spot)))
  const laid = goesOff('firetornado', 1)
  const erupts = game.firstTick(laid, laid + TORNADO_DELAY_TICKS + 5, (frame) => statusesOf(frame, 2, 'airborne').length > 0)
  assert.ok(erupts, 'it erupts')
  assert.ok(erupts >= laid + TORNADO_DELAY_TICKS, 'once the warning has run')
  const hits = game.hitsOn(2, erupts)
  const frame = game.at(erupts)
  const knockUp = statusesOf(frame, 2, 'airborne')[0]
  assert.equal(knockUp.endTick - knockUp.startTick, TORNADO_KNOCKUP_TICKS)
  assert.equal(stacksOn(frame, 2), 1)
  assert.equal(hits.length, 1)
  assert.ok(close(hits[0], TORNADO_DAMAGE + (TORNADO_SCALING.arcane ?? 0) * arcane))
  assert.equal(statusesOf(frame, 3, 'airborne').length, 0, 'the one that walked out is not thrown')
  assert.equal(stacksOn(frame, 3), 0)

  // In the air it goes nowhere, whatever it is told, and walks again once it is down.
  const held = frame.get(2)?.getPosition()
  game.order(2, move(erupts + 1, { x: spot.x - 600, y: spot.y }))
  assert.deepEqual(game.at(knockUp.endTick - 1).get(2)?.getPosition(), held, 'held in the air')
  assert.ok((game.at(knockUp.endTick + 10).get(2)?.getPosition().x ?? Infinity) < (held?.x ?? 0), 'and walks once it is down')
})

// ---------------------------------------------------------------------------- Scorch

test('scorch hurts each enemy it passes once, for one stack, and leaves a strip of burning ground that burns without stacking', () => {
  const game = scene([ahead(REACH)])
  game.order(1, cast(1, 'scorch', east))
  const launched = goesOff('scorch', 1)
  // Once the wave has run its length, and all of the ground is laid.
  const done = game.firstTick(launched + 1, launched + WHILE, (frame) => !frame.getEntities().some((entity) => entity.defId === 'scorch-wave'))
  assert.ok(done, 'the wave runs out')
  const hits = game.hitsOn(2, done)
  const frame = game.at(done)
  assert.equal(hits.length, 1, 'the wave hits it once')
  assert.ok(close(hits[0], SCORCH_DAMAGE + (SCORCH_SCALING.arcane ?? 0) * arcane))
  assert.equal(stacksOn(frame, 2), 1, 'one stack, though it stands on the burning ground')
  assert.equal(named(frame, 2, 'scorch', 'burn')?.amount, Math.round((SCORCH_BURN + (SCORCH_BURN_SCALING.arcane ?? 0) * arcane) * GAME_BURN_PULSE_TICKS / GAME_TPS), 'the ground burns it')

  // The ground is laid out behind the wave as it goes, from where it started.
  const ground = frame.getEntities().filter((entity) => entity.defId === 'scorch-ground').map((entity) => entity.origin.x).sort((left, right) => left - right)
  assert.ok(ground.length >= 3, `a strip of patches: ${ground.length}`)
  assert.equal(ground[0], HOME.x, 'from where it was cast')
  assert.ok(ground.every((x) => x >= HOME.x && x <= HOME.x + SCORCH_RANGE), 'all along its length')

  // Once the ground has gone out, the burn goes on for a little and no longer.
  const out = game.firstTick(done, done + SCORCH_GROUND_TICKS + 1, (each) => !each.getEntities().some((entity) => entity.defId === 'scorch-ground'))
  assert.ok(out, 'the ground goes out')
  assert.equal(named(game.at(out + SCORCH_BURN_TICKS + 1), 2, 'scorch', 'burn'), undefined)
})

// ---------------------------------------------------------------------------- Burn stacks

test('burn stacks stop at the most, and the burn is that many stacks\' worth', () => {
  const target = ahead(Math.min(REACH, TORNADO_RANGE))
  const game = scene([target])
  // One from the wave, two from the fireball, and one more from the tornado, which is at least as many as there can be. Each is cast as soon as the last has gone off.
  game.order(1, cast(1, 'scorch', east))
  game.order(1, cast(goesOff('scorch', 1) + 1, 'fireball', east))
  game.order(1, cast(goesOff('fireball', goesOff('scorch', 1) + 1) + 1, 'firetornado', point(target)))
  const full = game.firstTick(1, WHILE, (frame) => statusesOf(frame, 2, 'airborne').length > 0)
  assert.ok(full, 'the tornado lands')
  const frame = game.at(full)
  assert.equal(stacksOn(frame, 2), BURN_MAX_STACKS)
  assert.equal(named(frame, 2, BURN_STACK_KEY, 'burn')?.amount, pulseOf(BURN_MAX_STACKS))
})

test('the stacks and the burn they make end together, once no ability has added one for a while', () => {
  const game = scene([ahead(REACH)])
  game.order(1, cast(1, 'fireball', east))
  const blown = game.firstTick(1, WHILE, (frame) => stacksOn(frame, 2) === 2)
  assert.ok(blown)
  const burn = named(game.at(blown), 2, BURN_STACK_KEY, 'burn')
  const stack = game.at(blown).get(2)?.getMarkers().find((marker) => marker.key === BURN_STACK_KEY)
  assert.ok(burn && stack)
  assert.equal(burn.endTick, stack.endTick, 'they end on the same tick')
  assert.equal(burn.endTick - blown, BURN_STACK_TICKS)
  const after = game.at(burn.endTick + 1)
  assert.equal(stacksOn(after, 2), 0)
  assert.equal(named(after, 2, BURN_STACK_KEY, 'burn'), undefined)
})

test('the fire mage\'s autos put no burn stacks on', () => {
  const game = scene([ahead(mage.attackRange - R)])
  game.order(1, { id: `o${++sequence}`, seq: sequence, tick: 1, type: 'attack', targetId: 2 })
  const done = 1 + mage.attackCooldownTicks * 3
  assert.ok(game.hitsOn(2, done).length > 0, 'the autos land')
  assert.equal(stacksOn(game.at(done), 2), 0)
})

// ---------------------------------------------------------------------------- On the page

test('burn stacks are drawn as marks on the enemy, and a knock-up is told and drawn in the air', () => {
  const pips = layoutStackPips({ [BURN_STACK_KEY]: BURN_MAX_STACKS }, R)
  assert.equal(pips.length, BURN_MAX_STACKS)
  assert.ok(pips.every((pip) => pip.shape === 'diamond'), 'a mark someone else put on it')

  const state = new ClientGameState()
  const spot = ahead(TORNADO_RANGE / 2)
  state.simulator.addPlayer(1, 'p1', 'One', HOME, mage, 1)
  state.simulator.addPlayer(2, 'p2', 'Two', spot, bag, 2)
  state.setLocalCharacterId(1)
  state.resetServerTickAnchor(0, 0)
  state.simulator.addOrder(1, cast(1, 'firetornado', point(spot)))
  let erupts: number | undefined
  for (let tick = 1; tick <= 200 && erupts === undefined; tick += 1) {
    if (statusesOf(state.simulator.at(tick), 2, 'airborne').length > 0) erupts = tick
  }
  assert.ok(erupts)
  const seen = (tick: number) => {
    state.simulator.advanceTo(tick)
    const enemy = state.getCharacters(tick * 1000 / GAME_TPS).find((character) => character.id === 2)
    assert.ok(enemy)
    return enemy
  }
  const top = seen(erupts + Math.floor(TORNADO_KNOCKUP_TICKS / 2))
  assert.ok(top.airborne)
  assert.ok(statusLabels(top).includes('airborne'))
  assert.ok(top.lift !== undefined && top.lift > 0.9, `near the top of its arc halfway through: ${top.lift}`)
  assert.equal(seen(erupts + TORNADO_KNOCKUP_TICKS + 2).lift, undefined, 'and on the ground after')
})

test('the fireball\'s tooltip tells what a stack burns for', () => {
  const stats = mage.statsAt(1)
  const tooltip = abilityTooltip('fireball', { key: 'Q', cooldownTicks: abilityDefs.get('fireball')?.cooldownTicks ?? 0, stats, level: 1, health: stats.maxHp })
  const line = tooltip?.stats.find((stat) => stat.label === 'Burn per stack')
  assert.ok(line, 'a line for it')
  assert.equal(line.value, `${Math.round(BURN_DPS_PER_STACK + (BURN_SCALING.arcane ?? 0) * arcane)}/s`)
})
