import assert from 'node:assert/strict'
import test from 'node:test'
import type { Container, Graphics } from 'pixi.js'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { CharacterLayer } from '../apps/client/src/render/character-layer.ts'
import { layoutSpores, SPORE_MOTES } from '../apps/client/src/render/spore-look.ts'
import { statusLabels } from '../apps/client/src/render/status-labels.ts'
import { abilityTooltip } from '../apps/client/src/ui/ability-tooltip.ts'
import {
  abilityDefs,
  Champion,
  GAME_BURN_PULSE_TICKS,
  GAME_MAX_CHAMPION_RADIUS,
  GAME_TPS,
  getChampion,
  Simulator,
  type CastTarget,
  type CharacterOrder,
  type GameEvent,
  type GameTickSnapshot,
  type Scaling,
  type Vector2,
} from '../packages/shared/src/index.ts'
import {
  ENT_ROOT_COOLDOWN_TICKS,
  ENT_ROOT_KEY,
  ENT_ROOT_TICKS,
  GROVE_DAMAGE,
  GROVE_DELAY_TICKS,
  GROVE_HEAL,
  GROVE_HEAL_SCALING,
  GROVE_RADIUS,
  GROVE_RANGE,
  GROVE_ROOT_TICKS,
  GROVE_SCALING,
  ROOTBURST_DAMAGE,
  ROOTBURST_DELAY_TICKS,
  ROOTBURST_RANGE,
  ROOTBURST_SCALING,
  ROOTBURST_SLOW,
  ROOTBURST_SLOW_TICKS,
  SPORE_DAMAGE,
  SPORE_DPS,
  SPORE_DPS_SCALING,
  SPORE_POP_DAMAGE,
  SPORE_POP_HEAL,
  SPORE_POP_HEAL_SCALING,
  SPORE_POP_SCALING,
  SPORE_RANGE,
  SPORE_SCALING,
  SPORE_TICKS,
} from '../packages/shared/src/abilities.ts'

// The Ent's kit, played out in the simulator: the root his first auto on an enemy gives (once in a while for each), Root Burst's small circle that hurts and slows, Grove's big one that heals
// allies and hurts and roots enemies, and Spore's strike that plants a spore, which his abilities burst for damage and a heal. The numbers come from the exported constants and his own
// stats, so retuning the kit does not break these; what they check is how it is meant to play. The bodies he is played against are the test's own.

const HOME: Vector2 = { x: 400, y: 600 }
const R = GAME_MAX_CHAMPION_RADIUS
const ent = getChampion('ent')
const stats = ent.statsAt(1)
// What an amount comes to for the Ent at level 1: its base and its ratios of his stats.
const worth = (base: number, ratios: Scaling): number =>
  base + (ratios.arcane ?? 0) * stats.arcane + (ratios.attackDamage ?? 0) * stats.attackDamage + (ratios.maxHealth ?? 0) * stats.maxHp

// A body that takes whatever it is given and stays where it is put.
const bag = new Champion({
  id: 't-ent-bag',
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
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const at = (unitId: number): CastTarget => ({ mode: 'unit', unitId })
const point = (where: Vector2): CastTarget => ({ mode: 'point', point: { ...where } })
const ahead = (reach: number, across = 0): Vector2 => ({ x: HOME.x + reach, y: HOME.y + across })
// How far in front of the Ent a bag stands to be in reach of his autos and of Spore: just clear of his body.
const TOUCHING = ent.radius + R + 2
const close = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 1e-9
const goesOff = (abilityId: string, tick: number): number => tick + (abilityDefs.get(abilityId)?.windUpTicks ?? 0)

// A game played forward a tick at a time, which keeps every event it has seen: the simulator keeps only the last few frames, so what happened earlier is read from here. Orders are
// only ever added for ticks it has not reached, so nothing it has seen is played again.
class Game {
  readonly simulator = new Simulator()
  private readonly log: Array<{ tick: number; event: GameEvent }> = []
  private reached = 0

  // The Ent is character 1, on team 1. Each of the others is on its own team (an enemy) unless it says.
  constructor(others: ReadonlyArray<{ at: Vector2; who?: Champion; team?: number }>) {
    this.simulator.addPlayer(1, 'p1', 'One', HOME, ent, 1)
    others.forEach((other, index) => {
      this.simulator.addPlayer(index + 2, `p${index + 2}`, `Other ${index + 2}`, other.at, other.who ?? bag, other.team ?? index + 2)
    })
  }

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

  // The events up to tick `to` that are of this type and pass `keep`, with the tick each was on.
  events<T extends GameEvent['type']>(type: T, to: number, keep: (event: Extract<GameEvent, { type: T }>) => boolean = () => true): Array<{ tick: number; event: Extract<GameEvent, { type: T }> }> {
    this.at(to)
    return this.log.flatMap(({ tick, event }) =>
      tick <= to && event.type === type && keep(event as Extract<GameEvent, { type: T }>) ? [{ tick, event: event as Extract<GameEvent, { type: T }> }] : [])
  }

  firstTick(from: number, until: number, holds: (frame: GameTickSnapshot) => boolean): number | undefined {
    for (let tick = from; tick <= until; tick += 1) if (holds(this.at(tick))) return tick
    return undefined
  }
}

const statusesOf = (frame: GameTickSnapshot, id: number, kind: string) => frame.get(id)?.getStatuses().filter((status) => status.kind === kind && status.ownerId === 1) ?? []
// The Ent's hits (not a spore's pulses) on a unit, his abilities' alone (not his autos'), and his heals of a unit.
const abilityHitsOn = (game: Game, id: number, to: number) =>
  game.events('damage', to, (event) => event.ownerId === 1 && event.targetId === id && !event.overTime && !event.id.startsWith('a:'))
const healsOf = (game: Game, id: number, to: number) => game.events('heal', to, (event) => event.ownerId === 1 && event.unitId === id)
const burstHit = worth(SPORE_POP_DAMAGE, SPORE_POP_SCALING)
const burstHeal = Math.round(worth(SPORE_POP_HEAL, SPORE_POP_HEAL_SCALING))

// ---------------------------------------------------------------------------- Passive

test('the Ent\'s first auto on an enemy roots it, and his autos on it do not again until its own cooldown has run, while another enemy has its own', () => {
  const game = new Game([{ at: ahead(TOUCHING) }, { at: ahead(-TOUCHING) }])
  game.order(1, attack(1, 2))
  // Every root of his on the first enemy, by the tick it began, over the cooldown and a few autos more, with how long it lasts and whether the enemy was marked for its cooldown then.
  const roots = new Map<number, { lasts: number; marked: boolean }>()
  const until = 1 + ENT_ROOT_COOLDOWN_TICKS + ent.attackCooldownTicks * 3
  for (let tick = 1; tick <= until; tick += 1) {
    const frame = game.at(tick)
    for (const root of statusesOf(frame, 2, 'root')) {
      if (roots.has(root.startTick)) continue
      roots.set(root.startTick, { lasts: root.endTick - root.startTick, marked: frame.get(2)?.getMarkers().some((marker) => marker.key === ENT_ROOT_KEY) === true })
    }
  }
  const [first, second, ...more] = [...roots.keys()].sort((left, right) => left - right)
  assert.ok(first !== undefined && second !== undefined, `rooted twice: ${[...roots.keys()]}`)
  assert.equal(more.length, 0, 'and no more than that')
  assert.ok(second - first >= ENT_ROOT_COOLDOWN_TICKS, 'not again before its cooldown has run')
  assert.ok(second - first < ENT_ROOT_COOLDOWN_TICKS + ent.attackCooldownTicks + 1, 'and on the first auto after it')
  assert.equal(roots.get(first)?.lasts, ENT_ROOT_TICKS)
  assert.equal(roots.get(first)?.marked, true, 'it is marked for its cooldown')

  // The other enemy has not been hit, so its first auto roots it, cooldown or not on the first.
  const switched = until + 1
  game.order(1, attack(switched, 3))
  const rooted = game.firstTick(switched, switched + ent.attackCooldownTicks * 2, (frame) => statusesOf(frame, 3, 'root').length > 0)
  assert.ok(rooted, 'the other enemy is rooted by the first auto on it')
})

// ---------------------------------------------------------------------------- Root Burst

test('Root Burst hurts and slows the enemies in its small circle once its short warning runs out', () => {
  const spot = ahead(ROOTBURST_RANGE / 2)
  const game = new Game([{ at: spot }])
  game.order(1, cast(1, 'rootburst', point(spot)))
  const laid = goesOff('rootburst', 1)
  const burst = game.firstTick(laid, laid + ROOTBURST_DELAY_TICKS + 5, (frame) => statusesOf(frame, 2, 'slow').length > 0)
  assert.ok(burst, 'it bursts')
  assert.ok(burst >= laid + ROOTBURST_DELAY_TICKS, 'once its warning has run')
  const hits = abilityHitsOn(game, 2, burst)
  assert.equal(hits.length, 1)
  assert.ok(close(hits[0].event.amount, worth(ROOTBURST_DAMAGE, ROOTBURST_SCALING)))
  const slow = statusesOf(game.at(burst), 2, 'slow')[0]
  assert.equal(slow.amount, ROOTBURST_SLOW)
  assert.equal(slow.endTick - slow.startTick, ROOTBURST_SLOW_TICKS)
})

// ---------------------------------------------------------------------------- Grove

test('Grove heals the allies in its big circle and hurts and roots the enemies in it, once its long warning runs out', () => {
  const spot = ahead(GROVE_RANGE / 2)
  const game = new Game([{ at: { x: spot.x - GROVE_RADIUS / 2, y: spot.y } }, { at: { x: spot.x + GROVE_RADIUS / 2, y: spot.y }, team: 1 }])
  game.order(1, cast(1, 'grove', point(spot)))
  const laid = goesOff('grove', 1)
  const grown = game.firstTick(laid, laid + GROVE_DELAY_TICKS + 5, (frame) => statusesOf(frame, 2, 'root').length > 0)
  assert.ok(grown, 'it grows')
  assert.ok(grown >= laid + GROVE_DELAY_TICKS, 'once its warning has run')
  const hits = abilityHitsOn(game, 2, grown)
  assert.equal(hits.length, 1)
  assert.ok(close(hits[0].event.amount, worth(GROVE_DAMAGE, GROVE_SCALING)))
  const root = statusesOf(game.at(grown), 2, 'root')[0]
  assert.equal(root.endTick - root.startTick, GROVE_ROOT_TICKS)
  assert.deepEqual(healsOf(game, 3, grown).map(({ event }) => event.amount), [Math.round(worth(GROVE_HEAL, GROVE_HEAL_SCALING))], 'the ally is healed')
  assert.equal(healsOf(game, 2, grown).length, 0, 'and the enemy is not')
  assert.equal(healsOf(game, 1, grown).length, 0, 'nor the Ent, who is not in it')
})

// ---------------------------------------------------------------------------- Spore

test('Spore strikes a nearby enemy and plants a spore that drains its health for a while', () => {
  const game = new Game([{ at: ahead(TOUCHING) }])
  assert.ok(TOUCHING <= SPORE_RANGE)
  game.order(1, cast(1, 'spore', at(2)))
  const struck = goesOff('spore', 1)
  const hits = abilityHitsOn(game, 2, struck)
  assert.equal(hits.length, 1, 'one strike, and no burst, as it carried no spore')
  assert.ok(close(hits[0].event.amount, worth(SPORE_DAMAGE, SPORE_SCALING)))
  assert.equal(healsOf(game, 1, struck).length, 0)
  const planted = statusesOf(game.at(struck), 2, 'spore')[0]
  assert.ok(planted, 'a spore is planted')
  assert.equal(planted.endTick - planted.startTick, SPORE_TICKS)
  assert.equal(planted.amount, Math.round(worth(SPORE_DPS, SPORE_DPS_SCALING) * GAME_BURN_PULSE_TICKS / GAME_TPS))
  const pulses = game.events('damage', struck + SPORE_TICKS, (event) => event.ownerId === 1 && event.targetId === 2 && event.overTime === true)
  assert.ok(pulses.length > 1 && pulses.every(({ event }) => event.amount === planted.amount), 'it drains its health')
  assert.equal(statusesOf(game.at(planted.endTick), 2, 'spore').length, 0, 'and runs out')
})

test('Root Burst, Grove and Spore each burst a spore they hit, for bonus damage and a heal, and Spore plants a fresh one after it', () => {
  const spore = abilityDefs.get('spore')
  assert.ok(spore)
  assert.ok(SPORE_TICKS > spore.cooldownTicks + spore.windUpTicks, 'a spore outlasts the wait for the next Spore to strike')
  const target = ahead(TOUCHING)

  for (const [abilityId, aim] of [['rootburst', point(target)], ['grove', point(target)], ['spore', at(2)]] as const) {
    const game = new Game([{ at: target }])
    game.order(1, cast(1, 'spore', at(2)))
    const planted = goesOff('spore', 1)
    // As soon as Spore has gone off, or for a second Spore, as soon as it is ready again.
    const next = abilityId === 'spore'
      ? (game.firstTick(planted, planted + spore.cooldownTicks + 1, (frame) => frame.get(1)?.getAbilityCooldown('spore').ready === true) ?? Infinity) + 1
      : planted + 1
    assert.ok(statusesOf(game.at(next - 1), 2, 'spore').length > 0, 'it carries a spore')
    game.order(1, cast(next, abilityId, aim))
    const burst = game.firstTick(next, next + 3 * GAME_TPS, (frame) => healsOf(game, 1, frame.tick).length > 0)
    assert.ok(burst, `${abilityId} bursts it`)
    // The Ent stands right by the enemy, so he is in his own grove too, and it heals him as it does any ally: that is the one other heal there is.
    const heals = healsOf(game, 1, burst).map(({ event }) => event.amount).sort((left, right) => left - right)
    const own = abilityId === 'grove' ? [Math.round(worth(GROVE_HEAL, GROVE_HEAL_SCALING))] : []
    assert.deepEqual(heals, [burstHeal, ...own].sort((left, right) => left - right), `${abilityId}: the Ent is healed by the burst, once`)
    assert.ok(abilityHitsOn(game, 2, burst).some(({ tick, event }) => tick === burst && close(event.amount, burstHit)), `${abilityId}: and the enemy takes the bonus damage`)
    const after = statusesOf(game.at(burst + 1), 2, 'spore')
    if (abilityId === 'spore') {
      assert.equal(after.length, 1, 'Spore plants a fresh one')
      assert.equal(after[0].startTick, burst)
    } else {
      assert.equal(after.length, 0, `${abilityId}: the spore is gone`)
    }
  }
})

test('an ability that hits an enemy with no spore bursts nothing', () => {
  const target = ahead(TOUCHING)
  const game = new Game([{ at: target }])
  game.order(1, cast(1, 'rootburst', point(target)))
  const done = goesOff('rootburst', 1) + ROOTBURST_DELAY_TICKS + 5
  assert.equal(abilityHitsOn(game, 2, done).length, 1, 'its own hit, and no burst')
  assert.equal(healsOf(game, 1, done).length, 0)
})

// ---------------------------------------------------------------------------- On the page

test('spores puff off a spored body, a set number at a time, near it, and two bodies do not puff in step', () => {
  for (const time of [0, 777, 123456]) {
    const motes = layoutSpores(5, time, R)
    assert.equal(motes.length, SPORE_MOTES)
    for (const mote of motes) {
      assert.ok(Math.abs(mote.x) <= 1.5 * R && Math.abs(mote.y) <= 1.5 * R, `near the body: ${mote.x}, ${mote.y}`)
      assert.ok(mote.alpha >= 0 && mote.alpha <= 1 && mote.size > 0)
    }
  }
  assert.notDeepEqual(layoutSpores(1, 900, R), layoutSpores(2, 900, R))
  assert.deepEqual(layoutSpores(1, 900, R), layoutSpores(1, 900, R))
})

test('a spored enemy is told as such and has spores drawn on it, and the tooltip tells what a spore drains', () => {
  const state = new ClientGameState()
  state.simulator.addPlayer(1, 'p1', 'One', HOME, ent, 1)
  state.simulator.addPlayer(2, 'p2', 'Two', ahead(TOUCHING), bag, 2)
  state.setLocalCharacterId(1)
  state.resetServerTickAnchor(0, 0)
  state.simulator.addOrder(1, cast(1, 'spore', at(2)))
  const tick = goesOff('spore', 1) + 2
  state.simulator.advanceTo(tick)
  const characters = state.getCharacters(tick * 1000 / GAME_TPS)
  const enemy = characters.find((character) => character.id === 2)
  assert.ok(enemy?.spored)
  assert.ok(statusLabels(enemy).includes('spored'))

  const layer = new CharacterLayer(new Map())
  const width = (index: number): number => ((layer.view.children[index] as Container).children[2] as Graphics).getLocalBounds().width
  layer.update(characters, 1, undefined, 500)
  assert.ok(width(1) > 0, 'spores on the spored enemy')
  assert.equal(width(0), 0, 'and none on the Ent')

  const tooltip = abilityTooltip('spore', { key: 'E', cooldownTicks: abilityDefs.get('spore')?.cooldownTicks ?? 0, stats, level: 1, health: stats.maxHp })
  assert.equal(tooltip?.stats.find((line) => line.label === 'Spore')?.value, `${Math.round(worth(SPORE_DPS, SPORE_DPS_SCALING))}/s`)
})
