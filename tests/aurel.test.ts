import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { layoutHealthBar } from '../apps/client/src/render/health-bar.ts'
import { statusLabels } from '../apps/client/src/render/status-labels.ts'
import { abilityTooltip } from '../apps/client/src/ui/ability-tooltip.ts'
import {
  abilityDefs,
  bleed,
  Champion,
  GAME_BURN_PULSE_TICKS,
  GAME_MAX_CHAMPION_RADIUS,
  GAME_TPS,
  GameSnapshotSchema,
  getChampion,
  silence,
  Simulator,
  slow,
  stun,
  targetUnit,
  type CastTarget,
  type CharacterOrder,
  type GameEvent,
  type GameTickSnapshot,
  type Vector2,
} from '../packages/shared/src/index.ts'
import {
  BLEED_DPS,
  BLEED_SCALING,
  BLEED_TICKS,
  BLOODRUSH_BLEEDING_RANGE,
  BLOODRUSH_RANGE,
  BLOODRUSH_SLOW,
  LOW_HEALTH_BONUS,
  REND_BLEEDING_HASTE,
  REND_DAMAGE,
  REND_HASTE,
  REND_HASTE_TICKS,
  REND_HEAL,
  REND_HEAL_SCALING,
  REND_MISSING_HEAL,
  REND_RANGE,
  REND_SCALING,
  TRANSFUSION_SHARE,
  TRANSFUSION_WINDOW_TICKS,
} from '../packages/shared/src/abilities.ts'
import { defineAbility, registerChampion } from './fixtures.ts'

// Aurel's kit, played out in the simulator: autos that hit harder the less health he has, speed toward a bleeding enemy, Rend's harder auto that heals and bleeds (and heals more against
// a bleeding enemy), Transfusion's cleanse and heal of what he just lost, and Bloodrush's dash that reaches farther to a bleeding enemy. The numbers come from the exported constants and
// his own stats, so retuning the kit does not break these; what they check is how it is meant to play. The bodies he is played against are the test's own.

const HOME: Vector2 = { x: 400, y: 600 }
const R = GAME_MAX_CHAMPION_RADIUS
const aurel = getChampion('aurel')
const stats = aurel.statsAt(1)

// A body that takes whatever it is given and stays where it is put.
const bag = new Champion({
  id: 't-aurel-bag',
  name: 'Test Bag',
  base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 140,
  radius: R,
  attackRange: 50,
  attackWindup: 0,
  abilities: [],
})

// Hits whoever it is told to once, hard, and then so slowly that it never does again: how Aurel is hurt. It is registered, so that a game with it in can be restored from a snapshot.
const BRUTE_DAMAGE = Math.round(stats.maxHp / 2)
const brute = registerChampion(new Champion({
  id: 't-aurel-brute',
  name: 'Test Brute',
  base: { maxHp: 1_000_000, attackDamage: BRUTE_DAMAGE, attackSpeed: 0.01 },
  moveSpeed: 140,
  radius: 20,
  attackRange: 400,
  attackWindup: 0,
  abilities: [],
}))

// Stuns, slows and silences an enemy at once, for a long while: crowd control for Transfusion to take off.
const HOLD_TICKS = 6 * GAME_TPS
defineAbility({
  id: 't-aurel-hold',
  targeting: 'unit',
  range: 600,
  windUpTicks: 0,
  cooldownTicks: 6000,
  apply: [stun(HOLD_TICKS, targetUnit()), slow(0.5, HOLD_TICKS, targetUnit()), silence(HOLD_TICKS, targetUnit())],
})
const holder = new Champion({
  id: 't-aurel-holder',
  name: 'Test Holder',
  base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 140,
  radius: 20,
  attackRange: 50,
  attackWindup: 0,
  abilities: ['t-aurel-hold'],
})

// A teammate of Aurel's that makes an enemy bleed for a long while, for a little: so that an enemy can be bleeding without Aurel having been near it.
defineAbility({
  id: 't-aurel-bleed',
  targeting: 'unit',
  range: 2000,
  windUpTicks: 0,
  cooldownTicks: 6000,
  apply: [bleed(1, 6000, targetUnit())],
})
const bleeder = new Champion({
  id: 't-aurel-bleeder',
  name: 'Test Bleeder',
  base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 140,
  radius: 20,
  attackRange: 50,
  attackWindup: 0,
  abilities: ['t-aurel-bleed'],
})

let sequence = 0
const cast = (tick: number, abilityId: string, target: CastTarget, origin: Vector2 = HOME): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target, origin: { ...origin } })
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const move = (tick: number, target: Vector2): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'move', target })
const none: CastTarget = { mode: 'none' }
const at = (unitId: number): CastTarget => ({ mode: 'unit', unitId })
const ahead = (reach: number, across = 0): Vector2 => ({ x: HOME.x + reach, y: HOME.y + across })
// How far in front of Aurel a bag stands to be in reach of his autos: just clear of his body.
const TOUCHING = aurel.radius + R + 2
const distance = (left: Vector2 | undefined, right: Vector2 | undefined): number =>
  left && right ? Math.hypot(left.x - right.x, left.y - right.y) : NaN
const close = (actual: number, expected: number, within = 1e-9): boolean => Math.abs(actual - expected) < within
// The tick a cast ordered on `tick` goes off, and its cooldown starts.
const goesOff = (abilityId: string, tick: number): number => tick + (abilityDefs.get(abilityId)?.windUpTicks ?? 0)

// A game played forward a tick at a time, which keeps every event it has seen: the simulator keeps only the last few frames, so what happened earlier is read from here. Orders are
// only ever added for ticks it has not reached, so nothing it has seen is played again.
class Game {
  readonly simulator = new Simulator()
  private readonly log: Array<{ tick: number; event: GameEvent }> = []
  private reached = 0

  // Aurel is character 1, on team 1. Each of the others is on its own team (an enemy) unless it says.
  constructor(others: ReadonlyArray<{ at: Vector2; who?: Champion; team?: number }>) {
    this.simulator.addPlayer(1, 'p1', 'One', HOME, aurel, 1)
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

const hp = (frame: GameTickSnapshot, id: number): number => frame.get(id)?.getHealth() ?? 0
const where = (frame: GameTickSnapshot, id: number): Vector2 | undefined => frame.get(id)?.getPosition()
const statusesOf = (frame: GameTickSnapshot, id: number, kind: string) => frame.get(id)?.getStatuses().filter((status) => status.kind === kind) ?? []
// Aurel's hits on a unit, and his heals on himself.
const hitsOn = (game: Game, id: number, to: number) => game.events('damage', to, (event) => event.ownerId === 1 && event.targetId === id && !event.overTime)
const healsOf = (game: Game, to: number) => game.events('heal', to, (event) => event.ownerId === 1 && event.unitId === 1)
const rendHeal = REND_HEAL + (REND_HEAL_SCALING.level ?? 0) * 1

// ---------------------------------------------------------------------------- Passive

test('Aurel\'s autos hit for his attack damage at full health, and more by the share of his health he is missing', () => {
  const full = new Game([{ at: ahead(TOUCHING) }])
  full.order(1, attack(1, 2))
  const [first] = hitsOn(full, 2, 1 + aurel.attackWindupTicks + 2)
  assert.ok(first, 'the auto lands')
  assert.ok(close(first.event.amount, stats.attackDamage), `${first.event.amount}`)

  // Hurt first, then the same auto.
  const hurt = new Game([{ at: ahead(TOUCHING) }, { at: ahead(-200), who: brute }])
  hurt.order(3, attack(1, 1))
  hurt.order(1, attack(2, 2))
  const [hit] = hitsOn(hurt, 2, 2 + aurel.attackWindupTicks + 2)
  assert.ok(hit, 'the auto lands')
  const missing = (stats.maxHp - hp(hurt.at(hit.tick - 1), 1)) / stats.maxHp
  assert.ok(missing > 0, 'he was hurt')
  assert.ok(close(hit.event.amount, stats.attackDamage * (1 + LOW_HEALTH_BONUS * missing)), `${hit.event.amount}`)
})

// ---------------------------------------------------------------------------- Rend

// An auto of Aurel's, and not an ability of his: its source is the attack's (see `ATTACK_SOURCE_PREFIX`).
const isAuto = (event: { id: string }): boolean => event.id.startsWith('a:')
const autosOn = (game: Game, id: number, to: number) => hitsOn(game, id, to).filter(({ event }) => isAuto(event))
const rendsOn = (game: Game, id: number, to: number) => hitsOn(game, id, to).filter(({ event }) => !isAuto(event))
const hasteOf = (frame: GameTickSnapshot) => statusesOf(frame, 1, 'haste').find((status) => status.ownerId === 1)

test('Rend strikes a nearby enemy, makes it bleed, heals Aurel, speeds him up and resets his auto; against a bleeding one it heals and speeds him up more', () => {
  const rend = abilityDefs.get('rend')
  assert.ok(rend)
  assert.equal(rend.targeting, 'unit', 'it is aimed at an enemy')
  assert.ok(TOUCHING <= REND_RANGE, 'which can stand close enough')
  assert.ok(REND_BLEEDING_HASTE > REND_HASTE)
  // The auto that comes after Rend comes early only for the reset: without it, the next would come a whole attack after the last, which is longer than Rend and a windup take.
  assert.ok(aurel.attackCooldownTicks > aurel.attackWindupTicks + rend.windUpTicks + 2, 'the reset is what makes the next auto come early')

  // Hurt first, so there is health to heal; then autos, and Rend the tick after one lands, between it and the next. He goes on attacking through Rend's windup, as the player's
  // controls can have it (`keepAttacking`).
  const game = new Game([{ at: ahead(TOUCHING) }, { at: ahead(-200), who: brute }, { at: ahead(0, 300), who: bleeder, team: 1 }])
  game.order(3, attack(1, 1))
  game.order(1, attack(2, 2))
  const auto = game.firstTick(2, 2 + aurel.attackCooldownTicks, (frame) => autosOn(game, 2, frame.tick).length > 0)
  assert.ok(auto, 'an auto lands')
  const cast_ = auto + 1
  game.order(1, { ...cast(cast_, 'rend', at(2)), keepAttacking: true } as CharacterOrder)
  const struck = goesOff('rend', cast_)
  const frame = game.at(struck)
  const [hit] = rendsOn(game, 2, struck)
  assert.ok(hit, 'it strikes')
  assert.equal(hit.tick, struck, 'once its windup is over')
  assert.ok(close(hit.event.amount, REND_DAMAGE + (REND_SCALING.attackDamage ?? 0) * stats.attackDamage), `${hit.event.amount}`)
  assert.equal(healsOf(game, struck)[0]?.event.amount, Math.round(rendHeal), 'a set heal, as it was not bleeding')
  const speed = hasteOf(frame)
  assert.ok(speed && speed.amount === REND_HASTE && speed.endTick - speed.startTick === REND_HASTE_TICKS, 'and move speed')
  const bleeding = statusesOf(frame, 2, 'bleed')[0]
  assert.ok(bleeding, 'it bleeds')
  assert.equal(bleeding.ownerId, 1)
  assert.equal(bleeding.endTick - bleeding.startTick, BLEED_TICKS)
  assert.equal(bleeding.amount, Math.round((BLEED_DPS + (BLEED_SCALING.attackDamage ?? 0) * stats.attackDamage) * GAME_BURN_PULSE_TICKS / GAME_TPS))

  // The auto is reset: the next one comes as soon as it can wind up after Rend, and not a whole attack after the last.
  const next = game.firstTick(struck + 1, struck + aurel.attackCooldownTicks, (each) => autosOn(game, 2, each.tick).length > 1)
  assert.ok(next, 'the next auto lands')
  assert.ok(next - auto < aurel.attackCooldownTicks, `${next - auto} ticks after the last, short of ${aurel.attackCooldownTicks}`)

  // It bleeds a pulse at a time, as damage from Aurel.
  const pulses = game.events('damage', struck + GAME_BURN_PULSE_TICKS, (event) => event.ownerId === 1 && event.targetId === 2 && event.overTime === true)
  assert.ok(pulses.length > 0 && pulses.every(({ event }) => event.amount === bleeding.amount), 'it bleeds')

  // The next Rend, as soon as it is back (the tick after an auto lands, so not in the middle of one), at an enemy bleeding (from his teammate, whatever is left of his own bleed).
  const ready = struck + rend.cooldownTicks
  const between = game.firstTick(ready, ready + aurel.attackCooldownTicks, (each) => autosOn(game, 2, each.tick).some(({ tick }) => tick === each.tick))
  assert.ok(between)
  const missing = stats.maxHp - hp(game.at(between), 1)
  assert.ok(missing > 0)
  game.order(4, cast(between + 1, 't-aurel-bleed', at(2), ahead(0, 300)))
  const again = between + 2
  game.order(1, { ...cast(again, 'rend', at(2)), keepAttacking: true } as CharacterOrder)
  const struckAgain = goesOff('rend', again)
  assert.ok(statusesOf(game.at(struckAgain - 1), 2, 'bleed').length > 0, 'it is bleeding')
  assert.equal(rendsOn(game, 2, struckAgain).length, 2, 'it strikes again')
  assert.equal(healsOf(game, struckAgain)[1]?.event.amount, Math.round(rendHeal + REND_MISSING_HEAL * missing), 'and heals a share of his missing health')
  assert.equal(hasteOf(game.at(struckAgain))?.amount, REND_BLEEDING_HASTE, 'and speeds him up more')
})

test('Rend is for an enemy close by: aimed at one farther off, Aurel walks up to it and strikes once it is in reach', () => {
  const game = new Game([{ at: ahead(REND_RANGE * 2) }])
  game.order(1, cast(1, 'rend', at(2)))
  assert.equal(game.at(2).get(1)?.getAbilityCooldown('rend').ready, true, 'not at once')
  assert.ok((where(game.at(10), 1)?.x ?? 0) > HOME.x, 'he walks toward it')
  const struck = game.firstTick(2, 5 * GAME_TPS, (frame) => frame.get(1)?.getAbilityCooldown('rend').ready === false)
  assert.ok(struck, 'and strikes')
  assert.ok(distance(where(game.at(struck), 1), where(game.at(struck), 2)) <= REND_RANGE + 5, 'from within its reach')
  assert.equal(rendsOn(game, 2, struck).length, 1)
})

// ---------------------------------------------------------------------------- Transfusion

test('Transfusion heals a share of the health Aurel lost in the last few seconds, and nothing for what he lost before that', () => {
  const soon = new Game([{ at: ahead(-200), who: brute }])
  soon.order(2, attack(1, 1))
  const lost = stats.maxHp - hp(soon.at(2), 1)
  assert.ok(lost > 0, 'he is hurt')
  assert.equal(soon.at(2).get(1)?.getHealthLostSince(0), lost, 'and remembers it')
  soon.order(1, cast(GAME_TPS, 'transfusion', none))
  const heals = healsOf(soon, GAME_TPS + 1)
  assert.equal(heals.length, 1)
  assert.equal(heals[0].event.amount, Math.round(TRANSFUSION_SHARE * lost))

  const late = new Game([{ at: ahead(-200), who: brute }])
  late.order(2, attack(1, 1))
  const after = 1 + TRANSFUSION_WINDOW_TICKS + 1
  assert.equal(late.at(after - 1).get(1)?.getHealthLostSince(0), 0, 'forgotten once it is older than that')
  assert.equal(late.simulator.at(after - 1).getCharacterState(1)?.wounds, undefined, 'and gone from the frame')
  late.order(1, cast(after, 'transfusion', none))
  assert.equal(healsOf(late, after + 1).length, 0, 'nothing to heal')
  assert.equal(late.at(after + 1).get(1)?.getAbilityCooldown('transfusion').ready, false, 'though it was cast')
})

test('what Aurel remembers losing comes through a snapshot, and a late order that undoes it takes it back', () => {
  const frameText = (simulator: Simulator, tick: number): unknown => JSON.parse(JSON.stringify(simulator.at(tick).toData()))
  const hurt = (): Simulator => {
    const simulator = new Simulator()
    simulator.addPlayer(1, 'p1', 'One', HOME, aurel, 1)
    simulator.addPlayer(2, 'p2', 'Two', ahead(-200), brute, 2)
    simulator.addOrder(2, attack(2, 1))
    return simulator
  }
  const server = hurt()
  server.advanceTo(30)
  server.setCommitTick(20)
  assert.ok(server.at(20).getCharacterState(1)?.wounds, 'the checkpoint has it')
  const client = new Simulator()
  client.replaceFromSnapshot(GameSnapshotSchema.parse(JSON.parse(JSON.stringify(server.snapshot()))))
  assert.deepEqual(client.at(20).getCharacterState(1)?.wounds, server.at(20).getCharacterState(1)?.wounds, 'what he lost comes through')
  assert.deepEqual(frameText(client, 20), frameText(server, 20), 'the checkpoint')
  assert.deepEqual(frameText(client, 45), frameText(server, 45), 'and what comes of it')

  // The brute is told, late, to walk away on the tick it struck, after it was told to strike: it never does, and nothing was lost.
  const rolledBack = hurt()
  rolledBack.advanceTo(10)
  assert.ok(rolledBack.at(10).getCharacterState(1)?.wounds)
  assert.equal(rolledBack.addOrder(2, move(2, ahead(-600))), true, 'the late order is taken')
  assert.equal(rolledBack.at(10).getCharacterState(1)?.wounds, undefined, 'taken back')
  assert.equal(rolledBack.at(10).get(1)?.getHealth(), stats.maxHp)
})

test('only a champion that remembers what it loses keeps it in its frame', () => {
  const game = new Game([{ at: ahead(TOUCHING) }])
  game.order(1, attack(1, 2))
  const done = 1 + aurel.attackCooldownTicks * 2
  assert.ok(hitsOn(game, 2, done).length > 0, 'Aurel hurts it')
  assert.equal(game.simulator.at(done).getCharacterState(2)?.wounds, undefined)
})

test('Transfusion is cast through a stun and a silence, and takes them off along with a slow; other abilities are not', () => {
  // The holder stands within Rend's reach, so the only thing that can stop Rend is what it does to him.
  const game = new Game([{ at: ahead(TOUCHING), who: holder }])
  game.order(2, cast(1, 't-aurel-hold', at(1), ahead(TOUCHING)))
  game.order(1, cast(5, 'rend', at(2)))
  game.order(1, cast(10, 'transfusion', none))
  const held = game.at(4)
  for (const kind of ['stun', 'slow', 'silence']) assert.equal(statusesOf(held, 1, kind).length, 1, `${kind}ned`)
  assert.equal(game.at(goesOff('transfusion', 10) + 1).get(1)?.getAbilityCooldown('transfusion').ready, false, 'Transfusion was cast')
  const free = game.at(goesOff('transfusion', 10) + 2)
  for (const kind of ['stun', 'slow', 'silence']) assert.equal(statusesOf(free, 1, kind).length, 0, `no longer ${kind}ned`)
  // Had the Rend ordered while he was held been cast, it would have gone off by now.
  const dropped = Math.max(goesOff('rend', 5), goesOff('transfusion', 10) + 2) + 1
  assert.equal(game.at(dropped).get(1)?.getAbilityCooldown('rend').ready, true, 'Rend could not be cast while he was held')
  game.order(1, cast(dropped + 1, 'rend', at(2)))
  assert.equal(game.at(goesOff('rend', dropped + 1) + 1).get(1)?.getAbilityCooldown('rend').ready, false, 'and can be once he is free')
})

test('Transfusion shows on Aurel\'s health bar what it would heal while it is ready, and nothing when there is nothing to heal or it is on cooldown', () => {
  const state = new ClientGameState()
  state.simulator.addPlayer(1, 'p1', 'One', HOME, aurel, 1)
  state.simulator.addPlayer(2, 'p2', 'Two', ahead(-200), brute, 2)
  state.setLocalCharacterId(1)
  state.resetServerTickAnchor(0, 0)
  const seen = (tick: number) => {
    state.simulator.advanceTo(tick)
    const me = state.getCharacters(tick * 1000 / GAME_TPS).find((character) => character.id === 1)
    assert.ok(me)
    return me
  }
  assert.equal(seen(1).healPreview, undefined, 'nothing lost, nothing to show')
  state.simulator.addOrder(2, attack(2, 1))
  const lost = stats.maxHp - (seen(10).health?.hp ?? stats.maxHp)
  assert.ok(lost > 0)
  assert.equal(seen(10).healPreview, Math.round(TRANSFUSION_SHARE * lost))
  state.simulator.addOrder(1, cast(20, 'transfusion', none))
  assert.equal(seen(30).healPreview, undefined, 'on cooldown')

  // The bar lays the heal after the health, and fills no more than is missing.
  const layout = layoutHealthBar({ hp: 500, maxHp: 1000, shield: 0, heal: 200 }, 100, { every: 0, major: 0 })
  assert.equal(layout.healthWidth, 50)
  assert.equal(layout.healWidth, 20)
  assert.equal(layoutHealthBar({ hp: 900, maxHp: 1000, shield: 0, heal: 300 }, 100, { every: 0, major: 0 }).healWidth, 10)
})

test('Transfusion\'s tooltip tells the share of health lost it heals', () => {
  const tooltip = abilityTooltip('transfusion', { key: 'W', cooldownTicks: abilityDefs.get('transfusion')?.cooldownTicks ?? 0, stats, level: 1, health: stats.maxHp })
  const line = tooltip?.stats.find((stat) => stat.label === 'Heal')
  assert.ok(line?.detail?.includes('of health lost in the last'), line?.detail)
  assert.ok(line?.detail?.includes(`${TRANSFUSION_WINDOW_TICKS / GAME_TPS}s`), line?.detail)
})

// ---------------------------------------------------------------------------- Bloodrush

test('Bloodrush reaches farther to a bleeding enemy, lands beside it and slows it; out of reach, Aurel walks up first', () => {
  assert.ok(BLOODRUSH_BLEEDING_RANGE > BLOODRUSH_RANGE)
  const gap = (BLOODRUSH_RANGE + BLOODRUSH_BLEEDING_RANGE) / 2
  const others = [{ at: ahead(gap) }, { at: ahead(0, 300), who: bleeder, team: 1 }]

  const plain = new Game(others)
  plain.order(1, cast(1, 'bloodrush', at(2)))
  assert.equal(plain.at(2).get(1)?.isDashing(), false, 'out of reach of one that is not bleeding: he walks')
  const started = plain.firstTick(2, 2 * GAME_TPS, (frame) => frame.get(1)?.isDashing() === true)
  assert.ok(started, 'and dashes once in reach')
  assert.ok(distance(where(plain.at(started - 1), 1), where(plain.at(started - 1), 2)) <= BLOODRUSH_RANGE + 5)

  const game = new Game(others)
  game.order(3, cast(1, 't-aurel-bleed', at(2), ahead(0, 300)))
  game.order(1, cast(2, 'bloodrush', at(2)))
  assert.equal(game.at(2).get(1)?.isDashing(), true, 'in reach of one that is bleeding: he dashes at once')
  const landed = game.firstTick(3, 3 * GAME_TPS, (frame) => frame.get(1)?.isDashing() === false)
  assert.ok(landed)
  assert.ok(close(distance(where(game.at(landed), 1), where(game.at(landed), 2)), aurel.radius + R, 2), 'beside it')
  assert.ok(statusesOf(game.at(landed), 2, 'slow').some((each) => each.ownerId === 1 && each.amount === BLOODRUSH_SLOW), 'and it is slowed')
})

test('the page draws Bloodrush as reaching farther to a bleeding enemy, and tells that it bleeds', () => {
  const state = new ClientGameState()
  const enemyAt = ahead((BLOODRUSH_RANGE + BLOODRUSH_BLEEDING_RANGE) / 2)
  state.simulator.addPlayer(1, 'p1', 'One', HOME, aurel, 1)
  state.simulator.addPlayer(2, 'p2', 'Two', enemyAt, bag, 2)
  state.simulator.addPlayer(3, 'p3', 'Three', ahead(0, 300), bleeder, 1)
  state.setLocalCharacterId(1)
  state.resetServerTickAnchor(0, 0)
  const slot = aurel.abilities.indexOf('bloodrush')
  const preview = (tick: number) => {
    state.simulator.advanceTo(tick)
    return state.getCastPreview(slot, enemyAt, tick * 1000 / GAME_TPS)
  }
  const before = preview(1)
  assert.equal(before?.range, BLOODRUSH_RANGE)
  assert.equal(before?.outOfRange, true)
  state.simulator.addOrder(3, cast(2, 't-aurel-bleed', at(2), ahead(0, 300)))
  const after = preview(5)
  assert.equal(after?.range, BLOODRUSH_BLEEDING_RANGE)
  assert.equal(after?.outOfRange, undefined)
  const enemy = state.getCharacters(5 * 1000 / GAME_TPS).find((character) => character.id === 2)
  assert.ok(enemy?.bleeding)
  assert.ok(enemy && statusLabels(enemy).includes('bleeding'))
})
