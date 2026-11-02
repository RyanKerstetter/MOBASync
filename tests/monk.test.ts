import assert from 'node:assert/strict'
import test from 'node:test'
import { championSprites } from '../apps/client/src/champion-sprites.ts'
import { ClientGameState, type RenderedCharacter } from '../apps/client/src/game-state.ts'
import { beamDashes, layoutLinks, LINK_FLOW_SPEED } from '../apps/client/src/render/link-layer.ts'
import { layoutStackPips } from '../apps/client/src/render/stack-pips.ts'
import {
  abilityDefs,
  abilityOnKey,
  Champion,
  GAME_MAX_CHAMPION_RADIUS,
  getChampion,
  Simulator,
  type CastTarget,
  type CharacterOrder,
  type GameTickSnapshot,
  type Vector2,
} from '../packages/shared/src/index.ts'
import {
  FLURRY_ATTACK_SPEED,
  FLURRY_AUTOS,
  FLURRY_KEY,
  FLURRY_SLOW,
  GUARD_SCALING,
  GUARD_SHIELD,
  GUARD_SHIELD_ALONE,
  LINK_BREAK_RANGE,
  LINK_HEAL,
  LINK_HEAL_COOLDOWN_TICKS,
  LINK_HEAL_SCALING,
  LINK_KEY,
  LINK_SHARE,
  MONK_AUTO_REFUND_TICKS,
  MONK_DAMAGE_REDUCTION,
} from '../packages/shared/src/abilities.ts'
import { statMultiplier } from '../packages/shared/src/stats.ts'
import { killAt } from './fixtures.ts'

// Monk's kit, played out in the simulator: the damage he does not take, the cooldowns his autos hurry along, the link to a teammate that takes a share of their hits (which the key then heals
// them through, and cuts when it is cast on himself), the next autos he gives himself and his link, and the shield. The numbers come from the exported constants and the definitions, so retuning the kit does not break these;
// what they check is how it is meant to play. The bodies he is played with are the test's own.

const HOME: Vector2 = { x: 400, y: 600 }
const R = GAME_MAX_CHAMPION_RADIUS
const monk = getChampion('monk')

// A teammate that takes a lot before it falls, and a swinger that is also quick and hits at once, for what is given to the next autos.
const teammate = new Champion({
  id: 't-monk-teammate',
  name: 'Test Teammate',
  base: { maxHp: 20_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 140,
  radius: 20,
  attackRange: 200,
  attackWindup: 0,
  abilities: [],
})
const bag = new Champion({
  id: 't-monk-bag',
  name: 'Test Bag',
  base: { maxHp: 1_000_000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 140,
  radius: R,
  attackRange: 50,
  attackWindup: 0,
  abilities: [],
})
// Hits whoever it is told to at once and then every two seconds: the blows that are shared (or not), one at a time. A blow is half of what Monk has, so that he lives through the one
// he takes alone and through the share of the one his teammate takes.
const BLOW = Math.round(monk.maxHp / 2)
const brute = new Champion({
  id: 't-monk-brute',
  name: 'Test Brute',
  base: { maxHp: 1_000_000, attackDamage: BLOW, attackSpeed: 0.5 },
  moveSpeed: 140,
  radius: 20,
  attackRange: 600,
  attackWindup: 0,
  abilities: [],
})
const BLOW_EVERY = Math.ceil(60 / 0.5)

let sequence = 0
const attack = (tick: number, targetId: number): CharacterOrder => ({ id: `o${++sequence}`, seq: sequence, tick, type: 'attack', targetId })
const cast = (tick: number, abilityId: string, target: CastTarget, origin: Vector2 = HOME): CharacterOrder =>
  ({ id: `o${++sequence}`, seq: sequence, tick, type: 'cast', abilityId, target, origin: { ...origin } })
const none: CastTarget = { mode: 'none' }
const at = (unitId: number): CastTarget => ({ mode: 'unit', unitId })

// Monk is character 1, on team 1; each of the others is on a team of its own unless it says, so an enemy.
type Other = { at: Vector2; who?: Champion; team?: number }
function scene(others: readonly Other[]): Simulator {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, monk, 1)
  others.forEach((other, index) => {
    simulator.addPlayer(index + 2, `p${index + 2}`, `Other ${index + 2}`, other.at, other.who ?? bag, other.team ?? index + 2)
  })
  return simulator
}

const hp = (frame: GameTickSnapshot, id: number): number => frame.get(id)?.getHealth() ?? 0
const status = (frame: GameTickSnapshot, id: number, kind: string) => frame.get(id)?.getStatuses().find((each) => each.kind === kind)
const marks = (frame: GameTickSnapshot, id: number, key: string) => frame.get(id)?.getMarkers().filter((marker) => marker.key === key) ?? []
const entitiesOf = (frame: GameTickSnapshot, ownerId: number, defId: string) => frame.getEntities().filter((entity) => entity.ownerId === ownerId && entity.defId === defId)
const ready = (frame: GameTickSnapshot, id: number, abilityId: string): boolean | undefined => frame.get(id)?.getAbilityCooldown(abilityId).ready
// The tick a cast ordered on `tick` goes off.
const goesOff = (abilityId: string, tick: number): number => tick + (abilityDefs.get(abilityId)?.windUpTicks ?? 0)

// What Monk and his teammate take of a blow of `BLOW` (the health goes down by whole points).
const monkResists = statMultiplier(monk.statsAt(1).resistance)
const teammateResists = statMultiplier(teammate.statsAt(1).resistance)
const monkTakes = (share: number): number => Math.round(BLOW * share * (1 - MONK_DAMAGE_REDUCTION) * monkResists)
const teammateTakes = (share: number): number => Math.round(BLOW * share * teammateResists)
const linkHeal = Math.round(LINK_HEAL + (LINK_HEAL_SCALING.arcane ?? 0) * monk.statsAt(1).arcane)

// A scene with Monk, his teammate (2) and a brute (3) that hits the teammate on tick 20, and then every `BLOW_EVERY` ticks. Monk links to the teammate at tick 5, if `linked`.
function fight(linked: boolean): Simulator {
  const simulator = scene([{ at: { x: HOME.x, y: HOME.y + 120 }, who: teammate, team: 1 }, { at: { x: HOME.x + 300, y: HOME.y + 120 }, who: brute }])
  if (linked) simulator.addOrder(1, cast(5, 'link', at(2)))
  simulator.addOrder(3, attack(20, 2))
  return simulator
}

// ---------------------------------------------------------------------------- the passive

test('monk takes his damage reduction off every hit, and nobody else does', () => {
  const simulator = scene([{ at: { x: HOME.x + 300, y: HOME.y }, who: brute }])
  simulator.addOrder(2, attack(1, 1))
  const frame = simulator.at(2)
  assert.equal(monk.maxHp - hp(frame, 1), monkTakes(1))
  assert.ok(monkTakes(1) < Math.round(BLOW * monkResists), 'which is less than the blow gives a body without the reduction')

  const control = new Simulator()
  control.addPlayer(1, 'p1', 'One', HOME, teammate, 1)
  control.addPlayer(2, 'p2', 'Two', { x: HOME.x + 300, y: HOME.y }, brute, 2)
  control.addOrder(2, attack(1, 1))
  assert.equal(teammate.maxHp - hp(control.at(2), 1), teammateTakes(1), 'a body without it takes the whole blow')
})

test('each auto takes the refund off the cooldown of every ability he has, and not more than is left', () => {
  const simulator = scene([{ at: { x: HOME.x + monk.attackRange - 10, y: HOME.y } }])
  const abilities = ['link', 'flurry', 'guard']
  // Guard and Flurry are cast, which puts them on their cooldown. Link is cast on himself, which does too.
  simulator.addOrder(1, cast(1, 'guard', none))
  simulator.addOrder(1, cast(2, 'flurry', none))
  simulator.addOrder(1, cast(3, 'link', at(1)))
  simulator.addOrder(1, attack(60, 2))

  const readyAt: Record<string, number> = {}
  for (const abilityId of abilities) {
    const left = simulator.at(60).get(1)?.getAbilityCooldown(abilityId).ticksRemaining
    assert.ok(left !== undefined && left > 0, `${abilityId} is on its cooldown`)
    readyAt[abilityId] = 60 + left
  }
  const landings: number[] = []
  let before = bag.maxHp
  for (let tick = 61; tick <= 200; tick += 1) {
    const frame = simulator.at(tick)
    const now = hp(frame, 2)
    if (now < before) landings.push(tick)
    before = now
    for (const abilityId of abilities) {
      const expected = Math.max(0, readyAt[abilityId] - MONK_AUTO_REFUND_TICKS * landings.length - tick)
      assert.equal(frame.get(1)?.getAbilityCooldown(abilityId).ticksRemaining, expected, `${abilityId} on tick ${tick}`)
    }
  }
  assert.ok(landings.length >= 2, 'he autoed more than once')
})

// ---------------------------------------------------------------------------- Link

test('link puts a link on a teammate and turns the key into Link Heal, which is aimed at allies as it is', () => {
  const simulator = fight(true)
  const link = abilityDefs.get('link')
  assert.ok(link?.targetsAllies && link.recast === 'linkheal')
  assert.ok(abilityDefs.get('linkheal')?.targetsAllies, 'the recast is aimed at allies too, so it can be cast on himself')
  const frame = simulator.at(goesOff('link', 5) + 1)
  assert.equal(marks(frame, 2, LINK_KEY).length, 1, 'the teammate carries the link')
  assert.equal(marks(frame, 2, LINK_KEY)[0]?.ownerId, 1, 'and it is Monk\'s')
  assert.equal(entitiesOf(frame, 1, 'link').length, 1, 'and he has the link out')
  const out = (defId: string): boolean => entitiesOf(frame, 1, defId).length > 0
  assert.equal(abilityOnKey(link, out).id, 'linkheal', 'the key is now Link Heal')
  assert.equal(abilityOnKey(link, () => false).id, 'link', 'and it is the link again when there is none')
})

// How far apart two bodies are in a frame.
const between = (frame: GameTickSnapshot, left: number, right: number): number => {
  const from = frame.get(left)?.getPosition() ?? HOME
  const to = frame.get(right)?.getPosition() ?? HOME
  return Math.hypot(from.x - to.x, from.y - to.y)
}

test('the link lasts on its own for as long as it is not cut, however long that is, while they are no farther apart than it reaches', () => {
  const simulator = scene([{ at: { x: HOME.x, y: HOME.y + 120 }, who: teammate, team: 1 }])
  simulator.addOrder(1, cast(5, 'link', at(2)))
  // The teammate walks off to just short of where the link would break, and stays there.
  simulator.addOrder(2, { id: 'walk', seq: 900, tick: 30, type: 'move', target: { x: HOME.x + LINK_BREAK_RANGE - 5, y: HOME.y } })
  const far = simulator.at(2000)
  assert.ok(between(far, 1, 2) > (abilityDefs.get('link')?.range ?? 0), 'they are farther apart than Link reaches to be cast')
  assert.ok(between(far, 1, 2) <= LINK_BREAK_RANGE, 'and no farther than the link does')
  assert.equal(marks(far, 2, LINK_KEY).length, 1)
  assert.equal(entitiesOf(far, 1, 'link').length, 1)
})

test('the link breaks the tick the teammate is farther from Monk than it reaches, and not before: it is cut as he would cut it, and Link waits its whole cooldown', () => {
  const simulator = scene([{ at: { x: HOME.x, y: HOME.y + 120 }, who: teammate, team: 1 }])
  simulator.addOrder(1, cast(5, 'link', at(2)))
  simulator.addOrder(2, { id: 'walk', seq: 900, tick: 30, type: 'move', target: { x: HOME.x + LINK_BREAK_RANGE + 400, y: HOME.y } })
  let past: number | undefined
  for (let tick = 31; tick <= 800 && past === undefined; tick += 1) {
    if (between(simulator.at(tick), 1, 2) > LINK_BREAK_RANGE) past = tick
  }
  assert.ok(past, 'they get that far apart')

  assert.equal(marks(simulator.at(past - 1), 2, LINK_KEY).length, 1, 'the link stands until then')
  assert.equal(entitiesOf(simulator.at(past - 1), 1, 'link').length, 1)
  const broken = simulator.at(past)
  assert.equal(marks(broken, 2, LINK_KEY).length, 0, 'and is off them on that tick')
  assert.equal(entitiesOf(broken, 1, 'link').length, 0, 'the entity is gone with it, so the key is Link again')
  assert.equal(broken.get(1)?.getAbilityCooldown('link').ticksRemaining, abilityDefs.get('link')?.cooldownTicks, 'link starts its whole cooldown now')
  assert.equal(marks(simulator.at(past + 120), 2, LINK_KEY).length, 0, 'and it does not come back when they are close again')
})

test('a teammate who goes out toward the edge of the link and comes back keeps it', () => {
  // Farther than a cast reaches, but not farther than the link does, and back again.
  const back = scene([{ at: { x: HOME.x, y: HOME.y + 120 }, who: teammate, team: 1 }])
  back.addOrder(1, cast(5, 'link', at(2)))
  back.addOrder(2, { id: 'out', seq: 901, tick: 30, type: 'move', target: { x: HOME.x + LINK_BREAK_RANGE - 5, y: HOME.y } })
  back.addOrder(2, { id: 'in', seq: 902, tick: 400, type: 'move', target: { x: HOME.x + 50, y: HOME.y + 120 } })
  assert.equal(marks(back.at(1000), 2, LINK_KEY).length, 1, 'it stood through the going and the coming back')
})

test('a hit on the linked teammate is shared: Monk takes his share of it, and the teammate the rest', () => {
  const frame = fight(true).at(20)
  assert.equal(teammate.maxHp - hp(frame, 2), teammateTakes(1 - LINK_SHARE))
  assert.equal(monk.maxHp - hp(frame, 1), monkTakes(LINK_SHARE))

  const unlinked = fight(false).at(20)
  assert.equal(teammate.maxHp - hp(unlinked, 2), teammateTakes(1), 'and with no link the teammate takes all of it')
  assert.equal(hp(unlinked, 1), monk.maxHp, 'and Monk none')
})

test('link heal on the linked teammate heals them and keeps the link, and the sharing goes on', () => {
  const simulator = fight(true)
  // Hurt by the first blow, the teammate has health to be given back.
  simulator.addOrder(1, cast(60, 'linkheal', at(2)))
  const landing = goesOff('linkheal', 60)
  const before = simulator.at(landing - 1)
  const frame = simulator.at(landing)
  const missing = teammate.maxHp - hp(before, 2)
  assert.ok(missing > 0, 'the teammate was hurt, so there is something to heal')
  assert.equal(hp(frame, 2) - hp(before, 2), Math.min(missing, linkHeal), 'the teammate is healed by what the link says, or what they are missing if that is less')
  assert.equal(marks(frame, 2, LINK_KEY).length, 1, 'the link is still on them')
  assert.equal(entitiesOf(frame, 1, 'link').length, 1, 'and Monk still has it out')
  assert.equal(frame.get(1)?.getAbilityCooldown('linkheal').ticksRemaining, LINK_HEAL_COOLDOWN_TICKS, 'it is on its own cooldown')
  assert.equal(ready(frame, 1, 'link'), false, 'link is on the one it had')

  // The next blow is shared as before.
  const second = 20 + BLOW_EVERY
  assert.equal(hp(simulator.at(second - 1), 2) - hp(simulator.at(second), 2), teammateTakes(1 - LINK_SHARE))
  assert.equal(hp(simulator.at(second - 1), 1) - hp(simulator.at(second), 1), monkTakes(LINK_SHARE))
})

test('link cast on himself while it is up cuts it: no more sharing, nothing healed, and Link starts its whole cooldown over', () => {
  const simulator = fight(true)
  simulator.addOrder(1, cast(60, 'linkheal', at(1)))
  const landing = goesOff('linkheal', 60)
  const before = simulator.at(landing - 1)
  const frame = simulator.at(landing)
  assert.equal(hp(frame, 2), hp(before, 2), 'the teammate is not healed')
  assert.equal(marks(frame, 2, LINK_KEY).length, 0, 'the link is off them')
  assert.equal(entitiesOf(frame, 1, 'link').length, 0, 'and gone with it, so the key is Link again at once')
  assert.equal(ready(frame, 1, 'link'), false, 'link starts its cooldown now')
  assert.equal(frame.get(1)?.getAbilityCooldown('link').ticksRemaining, abilityDefs.get('link')?.cooldownTicks, 'all of it')
  assert.equal(ready(frame, 1, 'linkheal'), true, 'and a cut costs none of Link Heal')

  // The next blow is all the teammate's.
  const second = 20 + BLOW_EVERY
  assert.equal(hp(simulator.at(second - 1), 2) - hp(simulator.at(second), 2), teammateTakes(1))
  assert.equal(hp(simulator.at(second - 1), 1), hp(simulator.at(second), 1), 'and Monk takes none of it')
})

test('link heal on someone he has not linked heals no one and is given back whole', () => {
  const simulator = scene([
    { at: { x: HOME.x, y: HOME.y + 120 }, who: teammate, team: 1 },
    { at: { x: HOME.x, y: HOME.y - 120 }, who: teammate, team: 1 },
    { at: { x: HOME.x + 300, y: HOME.y + 120 }, who: brute },
    { at: { x: HOME.x + 300, y: HOME.y - 120 }, who: brute },
  ])
  simulator.addOrder(1, cast(5, 'link', at(2)))
  // A brute for each of them, so both are hurt and a heal on either would show.
  simulator.addOrder(4, attack(20, 2))
  simulator.addOrder(5, attack(20, 3))
  simulator.addOrder(1, cast(60, 'linkheal', at(3)))
  const landing = goesOff('linkheal', 60)
  const frame = simulator.at(landing)
  assert.ok(hp(frame, 2) < teammate.maxHp && hp(frame, 3) < teammate.maxHp, 'both are hurt')
  assert.equal(hp(frame, 2), hp(simulator.at(landing - 1), 2), 'the linked one is not healed')
  assert.equal(hp(frame, 3), hp(simulator.at(landing - 1), 3), 'nor is the one he aimed at')
  assert.equal(marks(frame, 2, LINK_KEY).length, 1, 'the link stands')
  assert.equal(ready(frame, 1, 'linkheal'), true, 'and it was not spent')
})

test('link heal cannot be cast on an enemy, or with no link up', () => {
  const enemy = scene([{ at: { x: HOME.x + 100, y: HOME.y } }])
  enemy.addOrder(1, cast(5, 'linkheal', at(2)))
  assert.equal(ready(enemy.at(goesOff('linkheal', 5) + 5), 1, 'linkheal'), true, 'not at an enemy')

  const unlinked = scene([{ at: { x: HOME.x, y: HOME.y + 100 }, who: teammate, team: 1 }])
  unlinked.addOrder(1, cast(5, 'linkheal', at(2)))
  assert.equal(ready(unlinked.at(goesOff('linkheal', 5) + 5), 1, 'linkheal'), true, 'and not with nothing linked')
})

test('his autos hurry Link Heal along with the rest', () => {
  const simulator = scene([
    { at: { x: HOME.x, y: HOME.y + 120 }, who: teammate, team: 1 },
    { at: { x: HOME.x + monk.attackRange - 10, y: HOME.y } },
  ])
  simulator.addOrder(1, cast(5, 'link', at(2)))
  simulator.addOrder(1, cast(30, 'linkheal', at(2)))
  simulator.addOrder(1, attack(70, 3))
  const left = simulator.at(70).get(1)?.getAbilityCooldown('linkheal').ticksRemaining
  assert.ok(left !== undefined && left > MONK_AUTO_REFUND_TICKS * 2, 'it is on its cooldown')
  const readyAt = 70 + left
  const landings: number[] = []
  let before = bag.maxHp
  for (let tick = 71; tick <= 200; tick += 1) {
    const frame = simulator.at(tick)
    const now = hp(frame, 3)
    if (now < before) landings.push(tick)
    before = now
    assert.equal(frame.get(1)?.getAbilityCooldown('linkheal').ticksRemaining, Math.max(0, readyAt - MONK_AUTO_REFUND_TICKS * landings.length - tick), `tick ${tick}`)
  }
  assert.ok(landings.length >= 2, 'he autoed more than once')
})

test('the link is over when Monk dies, and when the teammate dies', () => {
  const monkDies = fight(true)
  killAt(monkDies, 1, 50)
  assert.equal(entitiesOf(monkDies.at(49), 1, 'link').length, 1, 'it is there until he dies')
  const afterMonk = monkDies.at(60)
  assert.equal(entitiesOf(afterMonk, 1, 'link').length, 0, 'the link is gone')
  assert.equal(marks(afterMonk, 2, LINK_KEY).length, 0, 'and so is the mark on the teammate')
  const second = 20 + BLOW_EVERY
  assert.equal(hp(monkDies.at(second - 1), 2) - hp(monkDies.at(second), 2), teammateTakes(1), 'a blow is the teammate\'s alone')

  const mateDies = fight(true)
  killAt(mateDies, 2, 50)
  assert.equal(entitiesOf(mateDies.at(60), 1, 'link').length, 0, 'the link is gone when the teammate is')
  assert.equal(abilityOnKey(abilityDefs.get('link') as never, (defId) => entitiesOf(mateDies.at(60), 1, defId).length > 0).id, 'link', 'and the key is the link again')
})

test('link cast on himself heals him and links nobody', () => {
  const simulator = scene([{ at: { x: HOME.x + 300, y: HOME.y }, who: brute }])
  simulator.addOrder(2, attack(1, 1))
  simulator.addOrder(1, cast(10, 'link', at(1)))
  const landing = goesOff('link', 10)
  const hurt = monk.maxHp - monkTakes(1)
  assert.equal(hp(simulator.at(landing - 1), 1), hurt)
  assert.equal(hp(simulator.at(landing), 1), hurt + Math.min(monkTakes(1), linkHeal))
  assert.equal(entitiesOf(simulator.at(landing + 1), 1, 'link').length, 0, 'no link is out')
  assert.equal(marks(simulator.at(landing + 1), 1, LINK_KEY).length, 0, 'and nobody is marked')
  assert.equal(ready(simulator.at(landing + 1), 1, 'link'), false, 'it is spent')
})

test('link cannot be cast on an enemy', () => {
  const simulator = scene([{ at: { x: HOME.x + 100, y: HOME.y } }])
  simulator.addOrder(1, cast(5, 'link', at(2)))
  const frame = simulator.at(goesOff('link', 5) + 5)
  assert.equal(entitiesOf(frame, 1, 'link').length, 0)
  assert.equal(ready(frame, 1, 'link'), true, 'and it was not spent')
})

// ---------------------------------------------------------------------------- Flurry

test('flurry gives Monk and his linked teammate the next autos, quicker and slowing, and the teammate can be any champion', () => {
  const simulator = scene([{ at: { x: HOME.x, y: HOME.y + 100 }, who: teammate, team: 1 }, { at: { x: HOME.x + 120, y: HOME.y } }])
  simulator.addOrder(1, cast(5, 'link', at(2)))
  simulator.addOrder(1, cast(30, 'flurry', none))
  const frame = simulator.at(31)
  for (const id of [1, 2]) {
    const charges = marks(frame, id, FLURRY_KEY)
    assert.equal(charges.length, FLURRY_AUTOS, `${id} has the autos`)
    assert.ok(charges.every((charge) => charge.ownerId === id), `${id} carries them as its own`)
    const quick = frame.get(id)?.getStatuses().find((each) => each.kind === 'stat' && each.stat === 'attackSpeed')
    assert.equal(quick?.amount, FLURRY_ATTACK_SPEED, `${id} attacks faster`)
  }
  const champion = (id: number): Champion => id === 1 ? monk : teammate
  for (const id of [1, 2]) {
    assert.ok(champion(id).attackCooldownTicksWith(frame.get(id)?.getStatuses() ?? []) < champion(id).attackCooldownTicks, `${id} attacks quicker`)
  }
})

test('each of the autos slows what it hits and spends a charge, and the last one ends the attack speed', () => {
  const simulator = scene([{ at: { x: HOME.x, y: HOME.y + 100 }, who: teammate, team: 1 }, { at: { x: HOME.x + 150, y: HOME.y + 100 } }])
  simulator.addOrder(1, cast(5, 'link', at(2)))
  simulator.addOrder(1, cast(30, 'flurry', none))
  simulator.addOrder(2, attack(32, 3))

  const landings: number[] = []
  let before = bag.maxHp
  for (let tick = 33; tick <= 400 && landings.length < FLURRY_AUTOS + 1; tick += 1) {
    const frame = simulator.at(tick)
    const now = hp(frame, 3)
    if (now < before) {
      landings.push(tick)
      const left = Math.max(0, FLURRY_AUTOS - landings.length)
      assert.equal(marks(frame, 2, FLURRY_KEY).length, left, `${left} charges are left after auto ${landings.length}`)
      if (landings.length <= FLURRY_AUTOS) {
        const slow = status(frame, 3, 'slow')
        assert.equal(slow?.amount, FLURRY_SLOW, `auto ${landings.length} slows`)
        assert.equal(slow?.ownerId, 2, 'and is the teammate\'s')
      }
      const quick = frame.get(2)?.getStatuses().find((each) => each.kind === 'stat' && each.stat === 'attackSpeed')
      if (landings.length < FLURRY_AUTOS) assert.ok(quick, 'the attack speed lasts while there are charges')
      else {
        const next = simulator.at(tick + 1).get(2)?.getStatuses().find((each) => each.kind === 'stat' && each.stat === 'attackSpeed')
        assert.equal(next, undefined, 'and is gone with the last')
      }
    }
    before = now
  }
  assert.equal(landings.length, FLURRY_AUTOS + 1, 'he went on hitting after the charges were spent')
  // Monk spent none of his: his own autos have not been made.
  const monkFrame = simulator.at(landings[landings.length - 1] ?? 400)
  assert.equal(marks(monkFrame, 1, FLURRY_KEY).length, FLURRY_AUTOS, 'Monk still has his')
})

test('flurry resets his auto timer, so he can swing the moment it is cast, and it does not reset the teammate he has linked', () => {
  const cooldown = monk.attackCooldownTicks
  const castAt = 1 + Math.floor(cooldown / 2)
  const landings = (cast_: boolean): { nextAtCast: number | undefined; landed: number[] } => {
    const simulator = scene([{ at: { x: HOME.x + monk.attackRange - 10, y: HOME.y } }, { at: { x: HOME.x, y: HOME.y + 100 }, who: teammate, team: 1 }])
    simulator.addOrder(1, attack(1, 2))
    // The first auto is over and the next is a good way off when it is cast: half way between them.
    if (cast_) simulator.addOrder(1, cast(1 + Math.floor(cooldown / 2), 'flurry', none))
    const landed: number[] = []
    let nextAtCast: number | undefined
    let before = bag.maxHp
    for (let tick = 2; tick <= cooldown * 3; tick += 1) {
      const frame = simulator.at(tick)
      if (tick === castAt) nextAtCast = frame.get(1)?.getNextAttackTick()
      const now = hp(frame, 2)
      if (now < before) landed.push(tick)
      before = now
    }
    return { nextAtCast, landed }
  }
  const flurry = landings(true)
  const plain = landings(false)

  assert.ok((plain.nextAtCast ?? 0) > castAt + 5, 'with no cast the next auto is a good way off')
  assert.equal(flurry.nextAtCast, castAt, 'the cast makes it ready at once')
  assert.ok(flurry.landed.length >= 2 && plain.landed.length >= 2, 'he autoed more than once either way')
  assert.ok(flurry.landed[1] < plain.landed[1], 'so the next auto lands sooner than it would have')
  assert.ok(flurry.landed[1] - castAt <= monk.attackWindupTicksWith([], 1) + 2, 'and about as soon as the windup lets it')

  // The teammate he has linked has the autos and not the reset.
  const linked = scene([{ at: { x: HOME.x + monk.attackRange - 10, y: HOME.y } }, { at: { x: HOME.x, y: HOME.y + 100 }, who: teammate, team: 1 }])
  linked.addOrder(1, cast(5, 'link', at(3)))
  linked.addOrder(3, attack(2, 2))
  linked.addOrder(1, cast(30, 'flurry', none))
  const before = linked.at(29).get(3)?.getNextAttackTick() ?? 0
  assert.ok(before > 30, 'the teammate has an auto of their own waiting')
  assert.equal(linked.at(30).get(3)?.getNextAttackTick(), before, 'and the cast leaves it')
  assert.ok(marks(linked.at(30), 3, FLURRY_KEY).length > 0, 'though it gives them the autos')
})

test('flurry cast again renews the charges and does not add to them, and with no link it is Monk\'s alone', () => {
  const simulator = scene([{ at: { x: HOME.x, y: HOME.y + 100 }, who: teammate, team: 1 }])
  simulator.addOrder(1, cast(5, 'flurry', none))
  simulator.addOrder(1, cast(5 + abilityDefs.get('flurry')!.cooldownTicks + 5, 'flurry', none))
  const first = simulator.at(6)
  assert.equal(marks(first, 1, FLURRY_KEY).length, FLURRY_AUTOS)
  assert.equal(marks(first, 2, FLURRY_KEY).length, 0, 'the unlinked teammate has none')
  assert.equal(status(first, 2, 'stat'), undefined, 'and is no quicker')
  assert.equal(marks(simulator.at(5 + abilityDefs.get('flurry')!.cooldownTicks + 6), 1, FLURRY_KEY).length, FLURRY_AUTOS, 'and a second cast is not twice as many')
})

// ---------------------------------------------------------------------------- Guard

test('guard shields Monk and his linked teammate alike, and gives Monk a bigger one when there is no link', () => {
  const linked = scene([{ at: { x: HOME.x, y: HOME.y + 100 }, who: teammate, team: 1 }])
  linked.addOrder(1, cast(5, 'link', at(2)))
  linked.addOrder(1, cast(30, 'guard', none))
  const together = linked.at(31)
  const each = Math.round(GUARD_SHIELD + (GUARD_SCALING.arcane ?? 0) * monk.statsAt(1).arcane)
  assert.equal(together.get(1)?.getShield(), each)
  assert.equal(together.get(2)?.getShield(), each)

  const alone = scene([{ at: { x: HOME.x, y: HOME.y + 100 }, who: teammate, team: 1 }])
  alone.addOrder(1, cast(30, 'guard', none))
  const solo = alone.at(31)
  assert.equal(solo.get(1)?.getShield(), Math.round(GUARD_SHIELD_ALONE + (GUARD_SCALING.arcane ?? 0) * monk.statsAt(1).arcane))
  assert.equal(solo.get(2)?.getShield(), 0, 'the teammate gets none')
  assert.ok((solo.get(1)?.getShield() ?? 0) > (together.get(1)?.getShield() ?? 0), 'and it is the bigger')
})

// ---------------------------------------------------------------------------- what they grow with

// Three bodies with Monk's kit that are alike but for one thing: how much arcane, and how much health. A heal or a shield that grows with arcane is worth more to the first and the same
// to the other two, and one that grew with health would be the other way round.
const kitBody = (id: string, base: { maxHp: number; arcane: number }): Champion => new Champion({
  id,
  name: id,
  base: { attackDamage: 1, attackSpeed: 1, ...base },
  moveSpeed: 140,
  radius: 22,
  attackRange: 95,
  attackWindup: 0,
  abilities: ['link', 'flurry', 'guard'],
})
const PLAIN = { maxHp: 100_000, arcane: 10 }
// Hits once, for more than any heal in the game could give back, so what is healed is never held down by what was lost.
const sledge = new Champion({
  id: 't-monk-sledge',
  name: 'Test Sledge',
  base: { maxHp: 1_000_000, attackDamage: 50_000, attackSpeed: 0.01 },
  moveSpeed: 140,
  radius: 20,
  attackRange: 600,
  attackWindup: 0,
  abilities: [],
})
const plainBody = kitBody('t-monk-plain', PLAIN)
const sharpBody = kitBody('t-monk-sharp', { ...PLAIN, arcane: PLAIN.arcane + 90 })
const stoutBody = kitBody('t-monk-stout', { ...PLAIN, maxHp: PLAIN.maxHp * 5 })

// What the shield of Guard is for one of them with no link, which is the bigger of the two.
function guardShield(body: Champion): number {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, body, 1)
  simulator.addOrder(1, cast(1, 'guard', none))
  return simulator.at(2).get(1)?.getShield() ?? 0
}

// What Link gives one of them who casts it on himself, hurt first by the sledge.
function selfHeal(body: Champion): number {
  const simulator = new Simulator()
  simulator.addPlayer(1, 'p1', 'One', HOME, body, 1)
  simulator.addPlayer(2, 'p2', 'Two', { x: HOME.x + 300, y: HOME.y }, sledge, 2)
  simulator.addOrder(2, attack(1, 1))
  simulator.addOrder(1, cast(10, 'link', at(1)))
  const landing = goesOff('link', 10)
  return hp(simulator.at(landing), 1) - hp(simulator.at(landing - 1), 1)
}

test('the shields of Guard grow with arcane and not with health', () => {
  const ratio = GUARD_SCALING.arcane ?? 0
  assert.ok(ratio > 0, 'they say they grow with arcane')
  assert.equal(guardShield(plainBody), Math.round(GUARD_SHIELD_ALONE + ratio * PLAIN.arcane))
  assert.equal(guardShield(sharpBody), guardShield(plainBody) + Math.round(ratio * 90), 'more arcane is a bigger shield')
  assert.equal(guardShield(stoutBody), guardShield(plainBody), 'more health is the same shield')
})

test('the heal of Link grows with arcane and not with health', () => {
  const ratio = LINK_HEAL_SCALING.arcane ?? 0
  assert.ok(ratio > 0, 'it says it grows with arcane')
  assert.equal(selfHeal(plainBody), Math.round(LINK_HEAL + ratio * PLAIN.arcane))
  assert.equal(selfHeal(sharpBody), selfHeal(plainBody) + Math.round(ratio * 90), 'more arcane is a bigger heal')
  assert.equal(selfHeal(stoutBody), selfHeal(plainBody), 'more health is the same heal')
})

test('the heal and the shields are made of arcane and nothing else that grows: no health, no level', () => {
  for (const scaling of [LINK_HEAL_SCALING, GUARD_SCALING]) {
    assert.deepEqual(Object.keys(scaling), ['arcane'])
  }
})

// ---------------------------------------------------------------------------- on the page

test('link is aimed at a teammate, or at Monk himself, never at an enemy, and a teammate out of reach is still aimed at', () => {
  const link = abilityDefs.get('link')
  assert.ok(link)
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, monk, 1)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 200, y: 100 }, teammate, 1)
  gameState.simulator.addPlayer(3, 'player-3', 'Player 3', { x: 100, y: 200 }, bag, 2)
  gameState.simulator.addPlayer(4, 'player-4', 'Player 4', { x: 100 + link.range + 300, y: 100 }, teammate, 1)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  const slot = monk.abilities.indexOf('link')

  assert.ok(gameState.abilityNeedsAim(slot), 'it is aimed')
  assert.deepEqual(gameState.getCastPreview(slot, { x: 200, y: 100 }, 0)?.target, at(2), 'at the teammate')
  assert.deepEqual(gameState.getCastPreview(slot, { x: 100, y: 100 }, 0)?.target, at(1), 'or at himself, by pointing at him')
  assert.equal(gameState.getCastPreview(slot, { x: 100, y: 200 }, 0)?.target, undefined, 'and not at the enemy')
  assert.equal(gameState.createCastOrder(slot, { x: 100, y: 200 }, 0).ok, false)
  const far = gameState.getCastPreview(slot, { x: 100 + link.range + 300, y: 100 }, 0)
  assert.deepEqual(far?.target, at(4))
  assert.equal(far?.outOfRange, true, 'one out of reach is walked up to, and so is marked')
})

// A page playing Monk (1) with a teammate (2) he has linked, and another (3) he has not, as of a moment well after the link is up.
function linkedClient(): { gameState: ClientGameState; now: number } {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, monk, 1)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 300, y: 100 }, teammate, 1)
  gameState.simulator.addPlayer(3, 'player-3', 'Player 3', { x: 100, y: 300 }, teammate, 1)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  gameState.simulator.addOrder(1, cast(5, 'link', at(2), { x: 100, y: 100 }))
  return { gameState, now: 2000 }
}

test('with the link up the Q key is Link Heal, which goes to the linked teammate wherever the cursor is, and to himself only when it is on him', () => {
  const { gameState, now } = linkedClient()
  const slot = monk.abilities.indexOf('link')
  const target = (aim: Vector2) => gameState.getCastPreview(slot, aim, now)?.target

  assert.ok(abilityDefs.get('linkheal')?.targetsLinked, 'it is the ability that says so')
  assert.equal(gameState.getCastPreview(slot, { x: 300, y: 100 }, now)?.abilityId, 'linkheal', 'the key is Link Heal')
  assert.deepEqual(target({ x: 300, y: 100 }), at(2), 'on the teammate it is on them')
  assert.deepEqual(target({ x: 900, y: 900 }), at(2), 'on nothing at all it is on them too: they do not have to be pointed at')
  assert.deepEqual(target({ x: 100, y: 300 }), at(2), 'and on a teammate who is not linked it is still the linked one')
  assert.deepEqual(target({ x: 100, y: 100 }), at(1), 'only on himself is it on himself')

  const heal = gameState.createCastOrder(slot, { x: 900, y: 900 }, now)
  assert.ok(heal.ok)
  assert.deepEqual([heal.order.abilityId, heal.order.target], ['linkheal', at(2)], 'so the cast is for them with the cursor nowhere near')
  const cut = gameState.createCastOrder(slot, { x: 100, y: 100 }, now)
  assert.ok(cut.ok)
  assert.deepEqual([cut.order.abilityId, cut.order.target], ['linkheal', at(1)], 'and with it on him it cuts the link')
})

test('Link Heal goes to the teammate this Monk has linked, and not to one that another Monk has', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, monk, 1)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 300, y: 100 }, teammate, 1)
  gameState.simulator.addPlayer(3, 'player-3', 'Player 3', { x: 300, y: 300 }, teammate, 1)
  gameState.simulator.addPlayer(4, 'player-4', 'Player 4', { x: 100, y: 300 }, monk, 1)
  gameState.setLocalCharacterId(4)
  gameState.resetServerTickAnchor(0, 0)
  // The other Monk links the first teammate, and this one the second.
  gameState.simulator.addOrder(1, cast(5, 'link', at(2), { x: 100, y: 100 }))
  gameState.simulator.addOrder(4, cast(5, 'link', at(3), { x: 100, y: 300 }))
  const slot = monk.abilities.indexOf('link')

  assert.deepEqual(gameState.getCastPreview(slot, { x: 900, y: 900 }, 2000)?.target, at(3), 'the one he linked')
  assert.deepEqual(gameState.getCastPreview(slot, { x: 300, y: 100 }, 2000)?.target, at(3), 'whoever is pointed at')
})

test('link, with none up, is aimed as it was: at the teammate under the cursor or at himself, and at no one with none there', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, monk, 1)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 300, y: 100 }, teammate, 1)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  const slot = monk.abilities.indexOf('link')
  assert.equal(abilityDefs.get('link')?.targetsLinked, undefined)
  assert.deepEqual(gameState.getCastPreview(slot, { x: 300, y: 100 }, 0)?.target, at(2))
  assert.deepEqual(gameState.getCastPreview(slot, { x: 100, y: 100 }, 0)?.target, at(1))
  assert.equal(gameState.getCastPreview(slot, { x: 900, y: 900 }, 0)?.target, undefined, 'a link is made with someone, and who is for the cursor to say')
})

test('the alt key casts an ability for allies on the champion itself, wherever the cursor is, and leaves the others as they are', () => {
  const { gameState, now } = linkedClient()
  const key = (abilityId: string): number => monk.abilities.indexOf(abilityId)
  const faraway = { x: 3000, y: 3000 }

  assert.equal(gameState.abilitySelfCasts(key('link'), now), true, 'link, with the link up too, is for allies')
  const heal = gameState.createCastOrder(key('link'), faraway, now, true)
  assert.ok(heal.ok)
  assert.deepEqual([heal.order.abilityId, heal.order.target], ['linkheal', at(1)], 'on himself, with the cursor nowhere near')
  const plain = gameState.createCastOrder(key('link'), { x: 300, y: 100 }, now)
  assert.ok(plain.ok)
  assert.deepEqual(plain.order.target, at(2), 'and without it the cursor decides')

  assert.equal(gameState.abilitySelfCasts(key('flurry'), now), false, 'flurry is aimed at no one')
  const flurry = gameState.createCastOrder(key('flurry'), faraway, now, true)
  assert.ok(flurry.ok)
  assert.deepEqual(flurry.order.target, { mode: 'none' }, 'and is cast as it always is')
})

test('alt and link with nothing linked heals him, where the cursor alone has no one to aim at', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, monk, 1)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  const order = gameState.createCastOrder(monk.abilities.indexOf('link'), { x: 900, y: 900 }, 0, true)
  assert.ok(order.ok)
  assert.deepEqual([order.order.abilityId, order.order.target], ['link', at(1)])
  assert.equal(gameState.createCastOrder(monk.abilities.indexOf('link'), { x: 900, y: 900 }, 0).ok, false)
})

// ---------------------------------------------------------------------------- the beam

// A body in a frame, as far as drawing a link reads one.
const body = (id: number, x: number, y: number, extra: Partial<RenderedCharacter> = {}): RenderedCharacter =>
  ({ id, position: { x, y }, dead: false, champion: { radius: 20 }, ...extra }) as unknown as RenderedCharacter

test('a link is a beam from the edge of the teammate body to the edge of the body of the champion that holds it', () => {
  const beams = layoutLinks([body(1, 100, 100), body(2, 300, 100, { linkedBy: 1 })])
  assert.equal(beams.length, 1)
  assert.deepEqual(beams[0], { from: { x: 280, y: 100 }, to: { x: 120, y: 100 } }, 'out of the one and into the other, as far as their bodies reach')
  assert.deepEqual(layoutLinks([body(1, 100, 100), body(2, 100, 300, { linkedBy: 1 })])[0], { from: { x: 100, y: 280 }, to: { x: 100, y: 120 } })
})

test('there is no beam with no link, for a body that is dead or out of the frame, or for two bodies that touch', () => {
  assert.deepEqual(layoutLinks([body(1, 100, 100), body(2, 300, 100)]), [], 'no one is linked')
  assert.deepEqual(layoutLinks([body(2, 300, 100, { linkedBy: 1 })]), [], 'the holder is not in the frame')
  assert.deepEqual(layoutLinks([body(1, 100, 100), body(2, 300, 100, { linkedBy: 1, dead: true })]), [], 'the teammate is dead')
  assert.deepEqual(layoutLinks([body(1, 100, 100, { dead: true }), body(2, 300, 100, { linkedBy: 1 })]), [], 'the holder is')
  assert.deepEqual(layoutLinks([body(1, 100, 100), body(2, 130, 100, { linkedBy: 1 })]), [], 'they touch')
})

test('dashes run along the beam, are cut off at its ends, and move on with the time', () => {
  const beam = { from: { x: 0, y: 0 }, to: { x: 200, y: 0 } }
  const early = beamDashes(beam, 0)
  assert.ok(early.length >= 2, 'more than one along it')
  for (const [from, to] of early) {
    assert.ok(from.x >= 0 && to.x <= 200 && to.x > from.x, 'inside the beam')
    assert.equal(from.y, 0)
  }
  const period = early[1][0].x - early[0][0].x
  assert.ok(early[1][0].x > early[0][1].x, 'with a gap between them')
  assert.notDeepEqual(beamDashes(beam, 500).map(([from]) => from.x), early.map(([from]) => from.x), 'they have moved')
  // Moving at the flow speed, a dash is where the one behind it was after the time it takes to cover a period.
  const [first] = beamDashes(beam, 1000 * period / LINK_FLOW_SPEED)
  assert.deepEqual(first[0], early[0][0], 'and a period on, it is all as it was')
})

test('the teammate carries the link as a beam and not as a pip, and the page tells who holds it', () => {
  const { gameState, now } = linkedClient()
  const characters = gameState.getCharacters(now)
  const linked = characters.find((character) => character.id === 2)
  assert.equal(linked?.linkedBy, 1, 'it knows who holds the link')
  assert.equal(characters.find((character) => character.id === 1)?.linkedBy, undefined, 'and Monk is not linked to anyone')
  assert.equal(linked?.stacks[LINK_KEY], 1, 'the mark is on them')
  assert.deepEqual(layoutStackPips(linked?.stacks ?? {}, R), [], 'but it is drawn as no pip')
  assert.equal(layoutLinks(characters).length, 1, 'and as a beam')
})

test('monk is drawn from a sprite set of his own, and the autos he has left show as pips', () => {
  const set = championSprites.monk
  assert.ok(set)
  for (const clip of ['idle', 'walk', 'attack', 'cast', 'dead'] as const) assert.ok(set.clips[clip], `a ${clip}`)
  const autos = layoutStackPips({ [FLURRY_KEY]: FLURRY_AUTOS }, R)
  assert.equal(autos.length, FLURRY_AUTOS)
  assert.ok(autos.every((pip) => pip.shape === 'circle'), 'and the autos left are the carrier\'s own')
})
