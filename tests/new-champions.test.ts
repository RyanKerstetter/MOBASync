import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BEAM_COST,
  CARRION_KEY,
  KNIFE_KEY,
  KNIFE_MAX,
  SHARDS_RADIUS,
  BEAM_LENGTH,
  CHARGE_BANDS,
  CHARGE_KEY,
  MINE_RANGE,
  RAKE_GAP_TICKS,
  WINDUP_TICKS,
  MINE_SHOWN_TICKS,
  THROW_RANGE,
  CRACK_KEY,
  FOCUS_KEY,
  FOCUS_MAX,
  SCAN_CHARGES,
  SCAN_KEY,
  TUMBLE_RANGE,
  VOLLEY_EXTRA,
  VOLLEY_KEY,
} from '../packages/shared/src/abilities.ts'
import { champions, GAME_TPS, getEntityDef, REVEAL_KEY, Simulator, type CastTarget, type CharacterOrder, type Vector2 } from '../packages/shared/src/index.ts'
import { brawler } from './fixtures.ts'

// The Hunter, Crystal, Sorin and the Sniper: what each one's kit does that no other champion's does.

const AT: Vector2 = { x: 600, y: 600 }

function game(championId: string, enemies: readonly Vector2[]): Simulator {
  const champion = champions.get(championId)
  assert.ok(champion, championId)
  const simulator = new Simulator()
  simulator.addPlayer(1, 'player-1', 'Player 1', AT, champion)
  enemies.forEach((at, index) => simulator.addPlayer(2 + index, `player-${2 + index}`, `Player ${2 + index}`, at, brawler))
  return simulator
}

// Cast from where he started: none of these casts is made after he has moved.
function cast(simulator: Simulator, seq: number, tick: number, abilityId: string, target: CastTarget = { mode: 'none' }, origin: Vector2 = AT): void {
  simulator.addOrder(1, { id: `player-1:${seq}`, seq, tick, type: 'cast', abilityId, target, origin } as CharacterOrder)
}

function attack(simulator: Simulator, seq: number, tick: number, targetId: number): void {
  simulator.addOrder(1, { id: `player-1:${seq}`, seq, tick, type: 'attack', targetId } as CharacterOrder)
}

const markerCount = (simulator: Simulator, tick: number, unitId: number, key: string): number =>
  simulator.at(tick).get(unitId)?.getMarkers().filter((marker) => marker.key === key).length ?? 0

const EAST: CastTarget = { mode: 'direction', dir: { x: 1, y: 0 } }

test('the Hunter builds focus with his autos, no more than the most, and cannot cast Volley until it is full', () => {
  const simulator = game('hunter', [{ x: AT.x + 150, y: AT.y }])
  // Too soon: he has no focus, and the cast is dropped with nothing spent.
  cast(simulator, 1, 2, 'volley')
  assert.equal(simulator.at(10).get(1)?.getAbilityCooldown('volley').ready, true, 'refused without full focus')
  attack(simulator, 2, 11, 2)
  let full: number | undefined
  let most = 0
  for (let tick = 11; tick < 11 + GAME_TPS * 12; tick += 1) {
    const stacks = markerCount(simulator, tick, 1, FOCUS_KEY)
    most = Math.max(most, stacks)
    if (full === undefined && stacks === FOCUS_MAX) full = tick
  }
  assert.ok(full !== undefined, 'his autos fill his focus')
  assert.equal(most, FOCUS_MAX, 'and never past the most')
})

test('at full focus Volley readies his autos, and each looses its extra arrows at the enemies near the one it hits', () => {
  const simulator = game('hunter', [{ x: AT.x + 150, y: AT.y }, { x: AT.x + 190, y: AT.y + 40 }, { x: AT.x + 190, y: AT.y - 40 }])
  attack(simulator, 1, 1, 2)
  let full: number | undefined
  for (let tick = 1; full === undefined && tick < GAME_TPS * 12; tick += 1) {
    if (markerCount(simulator, tick, 1, FOCUS_KEY) === FOCUS_MAX) full = tick
  }
  assert.ok(full !== undefined)
  cast(simulator, 2, full + 1, 'volley')
  attack(simulator, 3, full + 2, 2)
  let readied = false
  let extra = 0
  for (let tick = full + 1; tick < full + GAME_TPS * 3; tick += 1) {
    readied ||= markerCount(simulator, tick, 1, VOLLEY_KEY) > 0
    extra = Math.max(extra, simulator.at(tick).getEntities().filter((entity) => entity.defId === 'volley-arrow').length)
  }
  assert.ok(readied, 'Volley is cast and readies his autos')
  assert.equal(extra, VOLLEY_EXTRA, 'an empowered auto looses its extra arrows')
})

test('every ability Crystal casts readies her auto', () => {
  const simulator = game('crystal', [{ x: AT.x + 150, y: AT.y }])
  attack(simulator, 1, 1, 2)
  // Once she has attacked, her next auto is a wait away; the cast takes the wait off.
  let attacked: number | undefined
  for (let tick = 1; attacked === undefined && tick < GAME_TPS * 3; tick += 1) {
    if ((simulator.at(tick).get(1)?.getNextAttackTick() ?? 0) > tick + 5) attacked = tick
  }
  assert.ok(attacked !== undefined, 'she has attacked')
  cast(simulator, 2, attacked + 1, 'shardstorm')
  assert.ok((simulator.at(attacked + 2).get(1)?.getNextAttackTick() ?? Infinity) <= attacked + 2, 'the cast readies her auto')
})

test('Crystal can shatter her bolt only once it has hit, and the shatter hurts and spends the crack', () => {
  const missed = game('crystal', [{ x: AT.x, y: AT.y + 400 }])
  cast(missed, 1, 1, 'crystalbolt', EAST)
  cast(missed, 2, 60, 'shatter')
  assert.equal(missed.at(70).get(1)?.getAbilityCooldown('shatter').ready, true, 'no recast after a miss')

  const simulator = game('crystal', [{ x: AT.x + 200, y: AT.y }])
  cast(simulator, 1, 1, 'crystalbolt', EAST)
  let cracked: number | undefined
  for (let tick = 1; cracked === undefined && tick < GAME_TPS * 2; tick += 1) {
    if (markerCount(simulator, tick, 2, CRACK_KEY) > 0) cracked = tick
  }
  assert.ok(cracked !== undefined, 'the bolt cracks the enemy it hits')
  const before = simulator.at(cracked).get(2)?.getHealth() ?? 0
  cast(simulator, 2, cracked + 1, 'shatter')
  const after = simulator.at(cracked + 3).get(2)?.getHealth() ?? 0
  assert.ok(after < before, 'the shatter hurts it')
  assert.equal(markerCount(simulator, cracked + 3, 2, CRACK_KEY), 0, 'and spends the crack')
})

// Sorin's light comes only of fighting: he smites a dummy beside him (on the far side from where he will beam) until he has enough for a beam. The tick he has it on.
const DUMMY_ID = 9
function gatherLight(simulator: Simulator, sorinAt: Vector2): number {
  simulator.addOrder(1, { id: 'player-1:90', seq: 90, tick: 1, type: 'cast', abilityId: 'smite', target: { mode: 'none' }, origin: sorinAt } as CharacterOrder)
  simulator.addOrder(1, { id: 'player-1:91', seq: 91, tick: 2, type: 'attack', targetId: DUMMY_ID } as CharacterOrder)
  for (let tick = 1; tick < GAME_TPS * 10; tick += 1) {
    if ((simulator.at(tick).get(1)?.getResource() ?? 0) >= BEAM_COST) return tick
  }
  assert.fail('he gathers enough light for a beam by fighting')
}
const withDummy = (simulator: Simulator, sorinAt: Vector2): Simulator => {
  simulator.addPlayer(DUMMY_ID, 'player-9', 'Dummy', { x: sorinAt.x - 70, y: sorinAt.y }, brawler)
  return simulator
}

test('Sorin gathers light only by fighting, and his beam spends it, hurting what is in the line; without it, he only gains a shield', () => {
  const enemyAt = { x: AT.x + BEAM_LENGTH / 2, y: AT.y }
  // Straight away he has none, and standing about he gathers none: a shield and no beam.
  const early = game('sorin', [enemyAt])
  for (let tick = 1; tick <= GAME_TPS * 5; tick += 1) early.at(tick)
  assert.equal(early.at(GAME_TPS * 5).get(1)?.getResource() ?? 0, 0, 'no light by itself')
  cast(early, 1, GAME_TPS * 5 + 1, 'dawnbeam', EAST)
  const enemyFull = early.at(GAME_TPS * 5).get(2)?.getHealth() ?? 0
  assert.ok((early.at(GAME_TPS * 5 + 40).get(1)?.getShield() ?? 0) > 0, 'a shield')
  assert.equal(early.at(GAME_TPS * 5 + 40).get(2)?.getHealth(), enemyFull, 'and no beam')

  const simulator = withDummy(game('sorin', [enemyAt]), AT)
  const enough = gatherLight(simulator, AT)
  const light = simulator.at(enough).get(1)?.getResource() ?? 0
  const from = simulator.at(enough).get(1)?.getPosition() ?? AT
  cast(simulator, 1, enough + 1, 'dawnbeam', EAST, from)
  const hurt = simulator.at(enough + 40).get(2)?.getHealth() ?? 0
  assert.ok(hurt < enemyFull, 'the beam hurts the enemy in the line')
  assert.ok((simulator.at(enough + 40).get(1)?.getResource() ?? 0) < light, 'and spends his light')
})

test('the Sniper\'s shot reaches farther the longer he holds his aim', () => {
  const shotOf = (held: number): string | undefined => {
    const simulator = game('sniper', [{ x: AT.x, y: AT.y + 2000 }])
    // Held from the press (it is aimed at nothing) to the letting go (the recast, aimed).
    cast(simulator, 1, 1, 'steadyaim')
    cast(simulator, 2, 2 + held, 'steadyfire', EAST)
    for (let tick = 1; tick < held + 30; tick += 1) {
      if (tick === 2) assert.ok(markerCount(simulator, tick, 1, CHARGE_KEY) > 0, 'the bead is drawn')
      const shot = simulator.at(tick).getEntities().find((entity) => entity.defId.startsWith('steady-shot-'))?.defId
      if (shot) return shot
    }
    return undefined
  }
  assert.equal(shotOf(1), 'steady-shot-1', 'fired at once, the shortest')
  assert.equal(shotOf(CHARGE_BANDS[CHARGE_BANDS.length - 1].after + 2), `steady-shot-${CHARGE_BANDS.length}`, 'held long enough, the longest')
})

test('nothing touches the Sniper while he tumbles', () => {
  const sorinAt = { x: AT.x - 120, y: AT.y }
  const sorin = champions.get('sorin')
  const sniper = champions.get('sniper')
  assert.ok(sorin && sniper)
  // Sorin, with light enough, beams down the line the Sniper rolls along, as he rolls.
  const run = (tumbles: boolean): { hp: number; full: number } => {
    const simulator = new Simulator()
    simulator.addPlayer(1, 'player-1', 'Player 1', sorinAt, sorin)
    simulator.addPlayer(2, 'player-2', 'Player 2', AT, sniper)
    withDummy(simulator, sorinAt)
    const enough = gatherLight(simulator, sorinAt)
    const from = simulator.at(enough).get(1)?.getPosition() ?? sorinAt
    simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: enough + 1, type: 'cast', abilityId: 'dawnbeam', target: EAST, origin: from } as CharacterOrder)
    const launch = enough + 1 + (champions.get('sorin') ? 15 : 0)
    if (tumbles) {
      simulator.addOrder(2, {
        id: 'player-2:1', seq: 1, tick: launch - 2, type: 'cast', abilityId: 'tumble',
        target: { mode: 'point', point: { x: AT.x + TUMBLE_RANGE / 2, y: AT.y } }, origin: AT,
      } as CharacterOrder)
    }
    const full = simulator.at(enough).get(2)?.getHealth() ?? 0
    return { hp: simulator.at(launch + 30).get(2)?.getHealth() ?? 0, full }
  }
  const standing = run(false)
  assert.ok(standing.hp < standing.full, 'standing, the beam hurts him')
  const rolling = run(true)
  assert.equal(rolling.hp, rolling.full, 'rolling, it does not')
})

test('Scan reveals the enemies in it, and the Sniper holds only so many', () => {
  const enemyAt = { x: AT.x + 500, y: AT.y }
  const simulator = game('sniper', [enemyAt])
  assert.equal(markerCount(simulator, 1, 1, SCAN_KEY), SCAN_CHARGES, 'he starts with every charge')
  for (let index = 0; index <= SCAN_CHARGES; index += 1) {
    cast(simulator, index + 1, 2 + index * 70, 'scan', { mode: 'point', point: enemyAt })
  }
  assert.ok(markerCount(simulator, 10, 2, REVEAL_KEY) > 0, 'the enemy in it is revealed')
  const scans = simulator.at(2 + SCAN_CHARGES * 70 + 5).getEntities().filter((entity) => entity.defId === 'scan').length
  assert.equal(scans, SCAN_CHARGES, 'one cast for each charge, and the one after is refused')
})

// ---- The Hellhound, Stone, Blade, the Vulture and Sanguine

test('the Hellhound\'s Rake gives a further slash only on a hit, and a first hit makes the enemy bleed', () => {
  const missed = game('hellhound', [{ x: AT.x, y: AT.y + 400 }])
  cast(missed, 1, 1, 'rake', EAST)
  cast(missed, 2, RAKE_GAP_TICKS + 2, 'rakeagain', EAST)
  let again = false
  for (let tick = 1; tick < RAKE_GAP_TICKS + 60; tick += 1) again ||= missed.at(tick).getEntities().some((entity) => entity.defId === 'rake-again-shot')
  assert.equal(again, false, 'a miss ends the string')

  const simulator = game('hellhound', [{ x: AT.x + 120, y: AT.y }])
  cast(simulator, 1, 1, 'rake', EAST)
  let window = false
  let bleeding = false
  for (let tick = 1; tick < 50; tick += 1) {
    const frame = simulator.at(tick)
    window ||= frame.getEntities().some((entity) => entity.ownerId === 1 && entity.defId === 'rake-window')
    bleeding ||= frame.get(2)?.getStatuses().some((status) => status.kind === 'bleed') ?? false
  }
  assert.ok(window, 'a hit opens the next slash')
  assert.ok(bleeding, 'and makes the enemy bleed')
  // The next slash cannot be begun until a while after the first goes off, and it winds up.
  const firstOff = 1 + WINDUP_TICKS.default
  const slashedAgain = (at: number): number | undefined => {
    const string = game('hellhound', [{ x: AT.x + 120, y: AT.y }])
    cast(string, 1, 1, 'rake', EAST)
    cast(string, 2, at, 'rakeagain', EAST)
    for (let tick = at; tick < at + 60; tick += 1) {
      if (string.at(tick).getEntities().some((entity) => entity.defId === 'rake-again-shot')) return tick
    }
    return undefined
  }
  assert.equal(slashedAgain(firstOff + RAKE_GAP_TICKS - 5), undefined, 'too soon, and it is refused')
  const slashed = slashedAgain(firstOff + RAKE_GAP_TICKS + 2)
  assert.ok(slashed !== undefined && slashed > firstOff + RAKE_GAP_TICKS + 2, 'after the gap it goes, once it has wound up')
})

test('Blade\'s thrown knife spends a knife and lies where it stops, and Blade Dash calls it back', () => {
  const simulator = game('blade', [{ x: AT.x, y: AT.y + 400 }])
  const start = markerCount(simulator, 1, 1, KNIFE_KEY)
  assert.equal(start, KNIFE_MAX, 'he starts with every knife')
  // Thrown short of its reach: it goes as far as it is aimed.
  const aimed = { x: AT.x + THROW_RANGE / 2, y: AT.y }
  cast(simulator, 1, 2, 'throwknife', { mode: 'point', point: aimed })
  let lying: number | undefined
  for (let tick = 2; lying === undefined && tick < 120; tick += 1) {
    if (simulator.at(tick).getEntities().some((entity) => entity.defId === 'ground-knife')) lying = tick
  }
  assert.ok(lying !== undefined, 'the knife lies where it stops')
  const knife = simulator.at(lying).getEntities().find((entity) => entity.defId === 'ground-knife')
  assert.ok(knife && Math.hypot(knife.origin.x - aimed.x, knife.origin.y - aimed.y) < 2, 'where it was aimed')
  assert.equal(markerCount(simulator, lying, 1, KNIFE_KEY), KNIFE_MAX - 1, 'and one knife is spent')
  cast(simulator, 2, lying + 1, 'bladedash', { mode: 'point', point: { x: AT.x - 100, y: AT.y } })
  let recalled = false
  for (let tick = lying + 1; tick < lying + 30; tick += 1) {
    recalled ||= simulator.at(tick).getEntities().some((entity) => entity.defId === 'recalled-knife')
  }
  assert.ok(recalled, 'the dash calls the knife back')
})

test('the Vulture\'s mine hides after a moment, and its spider runs down the enemy that steps on it, marking and revealing it', () => {
  const minePoint = { x: AT.x + MINE_RANGE, y: AT.y }
  assert.deepEqual(getEntityDef('spider-mine')?.ownTeamOnly, { afterTicks: MINE_SHOWN_TICKS }, 'everyone sees it at first, and then only the Vulture\'s team')
  const simulator = game('vulture', [{ x: minePoint.x, y: AT.y + 300 }])
  cast(simulator, 1, 1, 'spidermine', { mode: 'point', point: minePoint })
  simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 120, type: 'move', target: { x: minePoint.x, y: minePoint.y - 100 } } as CharacterOrder)
  let laid = false
  let chased = false
  let marked = false
  let slowed = false
  let revealed = false
  for (let tick = 1; tick < 600; tick += 1) {
    const frame = simulator.at(tick)
    laid ||= frame.getEntities().some((entity) => entity.defId === 'spider-mine')
    chased ||= frame.getEntities().some((entity) => entity.defId === 'mine-spider')
    marked ||= markerCount(simulator, tick, 2, CARRION_KEY) > 0
    revealed ||= markerCount(simulator, tick, 2, REVEAL_KEY) > 0
    slowed ||= frame.get(2)?.getStatuses().some((status) => status.kind === 'slow') ?? false
  }
  assert.ok(laid, 'the mine is laid')
  assert.ok(chased, 'stepped on, its spider comes out')
  assert.ok(slowed, 'and reaches the enemy, slowing it')
  assert.ok(marked, 'marking it')
  assert.ok(revealed, 'and showing it to the Vulture\'s team')
})

test('the Vulture\'s mine can be laid on an enemy, which has its windup to step away', () => {
  const enemyAt = { x: AT.x + MINE_RANGE, y: AT.y }
  const run = (stepsAway: boolean): boolean => {
    const simulator = game('vulture', [enemyAt])
    cast(simulator, 1, 1, 'spidermine', { mode: 'point', point: enemyAt })
    if (stepsAway) simulator.addOrder(2, { id: 'player-2:1', seq: 1, tick: 2, type: 'move', target: { x: enemyAt.x, y: enemyAt.y + 300 } } as CharacterOrder)
    let chased = false
    for (let tick = 1; tick < 200; tick += 1) chased ||= simulator.at(tick).getEntities().some((entity) => entity.defId === 'mine-spider')
    return chased
  }
  assert.equal(run(false), true, 'one that stands on it is caught as it is laid')
  assert.equal(run(true), false, 'one that steps away in time is not')
})

test('Sanguine\'s Coagulate bursts when she breaks it early, hurting the enemies round her', () => {
  const simulator = game('sanguine', [{ x: AT.x + SHARDS_RADIUS / 2, y: AT.y }])
  cast(simulator, 1, 1, 'coagulate')
  const full = simulator.at(1).get(2)?.getHealth() ?? 0
  assert.ok((simulator.at(5).get(1)?.getShield() ?? 0) > 0, 'she is shielded')
  cast(simulator, 2, 10, 'coagulateburst')
  assert.ok((simulator.at(20).get(2)?.getHealth() ?? full) < full, 'the burst hurts the enemy round her')
  assert.equal(simulator.at(20).get(1)?.getShield() ?? 0, 0, 'and the shield is gone')
})

test('Stone\'s Rampart can be cast on himself, slowing the enemies round him and shielding him', () => {
  const simulator = game('stone', [{ x: AT.x + 80, y: AT.y }])
  cast(simulator, 1, 1, 'rampart', { mode: 'unit', unitId: 1 })
  let shielded = false
  let slowed = false
  for (let tick = 1; tick < 40; tick += 1) {
    shielded ||= (simulator.at(tick).get(1)?.getShield() ?? 0) > 0
    slowed ||= simulator.at(tick).get(2)?.getStatuses().some((status) => status.kind === 'slow') ?? false
  }
  assert.ok(shielded, 'he is shielded')
  assert.ok(slowed, 'and the enemy near him slowed')
})
