import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aimAt,
  getAbilityDef,
  GAME_MONSTER_TEAM,
  getTeam,
  isMonsterTeam,
  Monster,
  think,
  type AiBody,
  type AiOther,
  type AiState,
  type MonsterDef,
} from '../packages/shared/src/index.ts'
import './fixtures.ts'

// How a monster decides what to do: when it notices someone, whom it goes after, when it gives up, which abilities
// it uses, and how it goes home. `think` is a pure function of what the monster can see, so each of these is
// asked of it directly.

const HOME = { x: 1000, y: 1000 }
const TEAM = GAME_MONSTER_TEAM

const def = (ai: Partial<MonsterDef['ai']> = {}, extra: Partial<MonsterDef> = {}): MonsterDef => ({
  id: 't-pure-wolf',
  name: 'Pure Wolf',
  maxHp: 400,
  moveSpeed: 200,
  radius: 20,
  attackDamage: 20,
  attackSpeed: 1,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: ['t-shockwave', 't-lash', 't-bolt', 't-meteor'],
  ai: { aggroRange: 300, deaggroRange: 450, leashRange: 600, abilities: [], ...ai },
  ...extra,
})
const wolf = (ai: Partial<MonsterDef['ai']> = {}): Monster => new Monster(def(ai))

const at = (dx: number, dy = 0) => ({ x: HOME.x + dx, y: HOME.y + dy })
const body = (extra: Partial<AiBody> = {}): AiBody => ({
  id: 99,
  team: TEAM,
  position: { ...HOME },
  home: { ...HOME },
  hp: 400,
  maxHp: 400,
  busy: false,
  silenced: false,
  attacking: undefined,
  moving: false,
  ready: () => true,
  ...extra,
})
const player = (id: number, dx: number, dy = 0, extra: Partial<AiOther> = {}): AiOther => ({ id, team: 1, position: at(dx, dy), alive: true, ...extra })
const idle: AiState = { mode: 'idle' }
const chasing = (targetId: number): AiState => ({ mode: 'chase', targetId })

// ---------------------------------------------------------------------------- noticing

test('an idle monster does nothing with no one near, and goes after the nearest player within its aggro range', () => {
  assert.deepEqual(think(wolf(), body(), idle, []), { state: { mode: 'idle' }, orders: [], reset: false })
  assert.equal(think(wolf(), body(), idle, [player(1, 301)]).state.mode, 'idle', 'just out of range')

  const decision = think(wolf(), body(), idle, [player(1, 250), player(2, -120), player(3, 0, 299)])
  assert.deepEqual(decision.state, { mode: 'chase', targetId: 2 }, 'the nearest')
  assert.deepEqual(decision.orders, [{ type: 'attack', targetId: 2 }], 'and it sets about them the same tick')
  assert.equal(decision.reset, false)
})

test('it does not notice the dead, or its own team, or itself, and the lower ID gets it when two are as near', () => {
  const others: AiOther[] = [
    player(1, 100, 0, { alive: false }),
    player(2, 110, 0, { team: TEAM }),
    { id: 99, team: 1, position: at(0), alive: true },
    player(5, 0, 200),
    player(4, 200, 0),
  ]
  assert.deepEqual(think(wolf(), body(), idle, others).state, { mode: 'chase', targetId: 4 })
})

test('an idle monster goes after whoever hurt it if they are in reach of its attention, even from beyond its aggro range', () => {
  const far = player(7, 400)
  assert.deepEqual(think(wolf(), body(), { mode: 'idle', provokedBy: 7 }, [far]).state, { mode: 'chase', targetId: 7 })
  assert.equal(think(wolf(), body(), idle, [far]).state.mode, 'idle', 'it would not have noticed them')
  assert.equal(think(wolf(), body(), { mode: 'idle', provokedBy: 7 }, [player(7, 451)]).state.mode, 'idle', 'beyond its deaggro range it cannot be provoked')
  // Over the nearest, and over a player who is close.
  assert.equal(think(wolf(), body(), { mode: 'idle', provokedBy: 7 }, [far, player(1, 50)]).state.targetId, 7)
  // A monster that does not mind being hurt does not mind.
  assert.equal(think(wolf({ aggroOnHit: false }), body(), { mode: 'idle', provokedBy: 7 }, [far]).state.mode, 'idle')
  // And who hurt it who is dead or gone is no one.
  assert.equal(think(wolf(), body(), { mode: 'idle', provokedBy: 7 }, [player(7, 300, 0, { alive: false })]).state.mode, 'idle')
})

// ---------------------------------------------------------------------------- chasing

test('a monster keeps going after the same player, though another is nearer, and only gives the order when it has not got one', () => {
  const state = chasing(1)
  const others = [player(1, 250), player(2, 100)]
  assert.deepEqual(think(wolf(), body(), state, others), {
    state,
    orders: [{ type: 'attack', targetId: 1 }],
    reset: false,
  })
  assert.deepEqual(think(wolf(), body({ attacking: 1, moving: true }), state, others).orders, [], 'it is already on them')
  assert.deepEqual(think(wolf(), body({ attacking: 2 }), state, others).orders, [{ type: 'attack', targetId: 1 }], 'put back on their target')
})

test('a monster that cannot act waits, and still gives up when it should', () => {
  assert.deepEqual(think(wolf(), body({ busy: true }), chasing(1), [player(1, 100)]).orders, [])
  // Giving up is still ordered, since it stops what it is doing.
  const decision = think(wolf(), body({ busy: true, position: at(500) }), chasing(1), [player(1, 1300)])
  assert.deepEqual(decision.state, { mode: 'return' })
  assert.deepEqual(decision.orders, [{ type: 'move', target: HOME }])
})

test('a player who gets further than the deaggro range is given up on, though still beyond the aggro range it started at', () => {
  const state = chasing(1)
  assert.equal(think(wolf(), body(), state, [player(1, 450)]).state.mode, 'chase', 'at the deaggro range: still after them')
  assert.equal(think(wolf(), body(), state, [player(1, 400)]).state.mode, 'chase', 'between the aggro and deaggro ranges')
  const lost = think(wolf(), body(), state, [player(1, 451)])
  assert.deepEqual(lost.state, { mode: 'idle' }, 'at home already, so it has only to settle down')
  assert.equal(lost.reset, true)
  // Away from home it walks back.
  const away = think(wolf(), body({ position: at(300) }), state, [player(1, 800)])
  assert.deepEqual(away.state, { mode: 'return' })
  assert.deepEqual(away.orders, [{ type: 'move', target: HOME }])
  assert.equal(away.reset, false)
})

test('a monster too far from home gives up whoever it is after, however close, and goes home', () => {
  const state = chasing(1)
  const near = [player(1, 600, 0)]
  const decision = think(wolf(), body({ position: at(601) }), state, [{ ...near[0], position: at(640) }])
  assert.deepEqual(decision.state, { mode: 'return' })
  assert.deepEqual(decision.orders, [{ type: 'move', target: HOME }])
  assert.equal(think(wolf(), body({ position: at(600) }), state, [{ ...near[0], position: at(640) }]).state.mode, 'chase', 'at the leash range exactly: still on them')
  // An idle monster that is out there has the same.
  assert.equal(think(wolf(), body({ position: at(601) }), idle, [player(1, 650)]).state.mode, 'return')
})

test('when its target dies or goes it takes the nearest player in its aggro range, and goes home if there is none', () => {
  const state = chasing(1)
  const dead = player(1, 100, 0, { alive: false })
  assert.deepEqual(think(wolf(), body(), state, [dead, player(2, 250), player(3, 150)]).state, { mode: 'chase', targetId: 3 })
  assert.deepEqual(think(wolf(), body(), state, [player(2, 250), player(3, 150)]).orders, [{ type: 'attack', targetId: 3 }], 'a player that is gone')
  assert.deepEqual(think(wolf(), body(), state, [dead, player(2, 320)]).state, { mode: 'idle' }, 'the other is out of its aggro range')
  // Beyond reach of its attention, not just gone: someone else further than the aggro range is not taken.
  assert.equal(think(wolf(), body({ position: at(200) }), state, [player(1, 800), player(2, 700)]).state.mode, 'return')
})

// ---------------------------------------------------------------------------- going home

test('a monster going home pays no attention to anyone, keeps walking, and is healed when it gets there', () => {
  const walking = { mode: 'return' } as const
  const nearby = [player(1, 50)]
  const stop = think(wolf(), body({ position: at(300) }), walking, nearby)
  assert.deepEqual(stop.state, { mode: 'return' }, 'nothing makes it turn')
  assert.deepEqual(stop.orders, [{ type: 'move', target: HOME }], 'and it was not walking, so it is told to again')
  assert.deepEqual(think(wolf(), body({ position: at(300), moving: true }), walking, nearby).orders, [], 'walking already')
  assert.deepEqual(think(wolf(), body({ position: at(300), busy: true }), walking, nearby).orders, [], 'stunned: it waits')

  const home = think(wolf(), body({ position: at(30), hp: 90 }), walking, nearby)
  assert.deepEqual(home, { state: { mode: 'idle' }, orders: [], reset: true }, 'home is within the home radius')
  assert.equal(think(wolf(), body({ position: at(31) }), walking, []).state.mode, 'return', 'just outside it')
  assert.equal(think(wolf({ resetOnReturn: false }), body({ position: at(30) }), walking, []).reset, false)
  assert.equal(think(wolf({ homeRadius: 80 }), body({ position: at(79) }), walking, []).state.mode, 'idle')
})

test('a monster that has been pushed off its post while idle walks back to it, without noticing anyone it did not before', () => {
  const pushed = think(wolf(), body({ position: at(200) }), idle, [])
  assert.deepEqual(pushed.state, { mode: 'return' })
  assert.deepEqual(pushed.orders, [{ type: 'move', target: HOME }])
  assert.equal(pushed.reset, false)
  assert.deepEqual(think(wolf(), body({ position: at(30) }), idle, []), { state: { mode: 'idle' }, orders: [], reset: false })
})

// ---------------------------------------------------------------------------- abilities

const slammer = (rule: { abilityId: string; withinRange?: number; belowHealth?: number }[]): Monster => wolf({ abilities: rule })

test('a monster casts an ability instead of attacking when it is ready and the target is in range', () => {
  const brute = slammer([{ abilityId: 't-shockwave', withinRange: 100 }])
  const state = chasing(1)
  const cast = think(brute, body(), state, [player(1, 100)])
  assert.deepEqual(cast.orders, [{ type: 'cast', abilityId: 't-shockwave', target: { mode: 'none' } }])
  assert.deepEqual(cast.state, state)
  assert.deepEqual(think(brute, body(), state, [player(1, 101)]).orders, [{ type: 'attack', targetId: 1 }], 'out of range of it: an attack')
  assert.deepEqual(think(brute, body({ ready: () => false }), state, [player(1, 100)]).orders, [{ type: 'attack', targetId: 1 }], 'on cooldown')
  assert.deepEqual(think(brute, body({ silenced: true }), state, [player(1, 100)]).orders, [{ type: 'attack', targetId: 1 }], 'silenced')
  assert.deepEqual(think(brute, body({ busy: true }), state, [player(1, 100)]).orders, [], 'in the middle of something')
})

test('the first rule that can be cast is the one, and a rule can keep an ability for when the monster is hurt', () => {
  const brute = slammer([
    { abilityId: 't-shockwave', withinRange: 100, belowHealth: 0.5 },
    { abilityId: 't-lash' },
  ])
  const state = chasing(1)
  const lash = { type: 'cast', abilityId: 't-lash', target: { mode: 'unit', unitId: 1 } }
  assert.deepEqual(think(brute, body({ hp: 400 }), state, [player(1, 100)]).orders, [lash], 'at full health the second rule')
  assert.deepEqual(think(brute, body({ hp: 199 }), state, [player(1, 100)]).orders, [{ type: 'cast', abilityId: 't-shockwave', target: { mode: 'none' } }])
  assert.deepEqual(think(brute, body({ hp: 200 }), state, [player(1, 100)]).orders, [lash], 'not below half')
  assert.deepEqual(think(brute, body({ hp: 100, ready: (id) => id !== 't-shockwave' }), state, [player(1, 100)]).orders, [lash], 'the first is on cooldown')
  // Where a rule gives no range it is the ability's own: lash reaches 200, so a target at 201 is for the attack.
  assert.deepEqual(think(slammer([{ abilityId: 't-lash' }]), body(), state, [player(1, 201)]).orders, [{ type: 'attack', targetId: 1 }])
})

test('an ability with no range of its own is used within the monster\'s attack range, unless the rule says', () => {
  const brute = slammer([{ abilityId: 't-shockwave' }])
  assert.equal(think(brute, body(), chasing(1), [player(1, 60)]).orders[0]?.type, 'cast')
  assert.equal(think(brute, body(), chasing(1), [player(1, 61)]).orders[0]?.type, 'attack')
})

test('an ability is aimed at the target as its kind of targeting wants', () => {
  const from = { x: 0, y: 0 }
  const target = (x: number, y: number): AiOther => ({ id: 5, team: 1, position: { x, y }, alive: true })
  const def = (id: string) => getAbilityDef(id) as NonNullable<ReturnType<typeof getAbilityDef>>

  assert.deepEqual(aimAt(def('t-shockwave'), from, target(10, 10)), { mode: 'none' })
  // A unit, if it is within range.
  assert.deepEqual(aimAt(def('t-lash'), from, target(200, 0)), { mode: 'unit', unitId: 5 })
  assert.equal(aimAt(def('t-lash'), from, target(201, 0)), undefined)
  // A direction is a unit vector toward them, which is what the simulator asks of one.
  assert.deepEqual(aimAt(def('t-bolt'), from, target(0, -300)), { mode: 'direction', dir: { x: 0, y: -1 } })
  const slanted = aimAt(def('t-bolt'), from, target(30, 40))
  assert.deepEqual(slanted, { mode: 'direction', dir: { x: 0.6, y: 0.8 } })
  assert.equal(aimAt(def('t-bolt'), from, target(0, 0)), undefined, 'there is no direction to someone at the same point')
  // A point is at the target, or as near as the ability reaches.
  assert.deepEqual(aimAt(def('t-meteor'), from, target(150, 0)), { mode: 'point', point: { x: 150, y: 0 } })
  assert.deepEqual(aimAt(def('t-meteor'), from, target(600, 0)), { mode: 'point', point: { x: 300, y: 0 } })
  assert.deepEqual(aimAt(def('t-meteor'), from, target(0, 0)), { mode: 'point', point: { x: 0, y: 0 } })
})

// ---------------------------------------------------------------------------- what it is

test('a monster\'s choices are a function of what it was given: the same every time, and nothing is changed', () => {
  const others = Object.freeze([Object.freeze(player(1, 100)), Object.freeze(player(2, 200))])
  const frozen = Object.freeze(body({ position: at(40) }))
  const state = Object.freeze(chasing(2))
  const brute = slammer([{ abilityId: 't-shockwave', withinRange: 500 }])
  const first = think(brute, frozen, state, others)
  assert.deepEqual(think(brute, frozen, state, others), first)
  assert.deepEqual(state, { mode: 'chase', targetId: 2 })
})

test('monsters are on a team of their own that no player is on, drawn in its own colour', () => {
  assert.equal(GAME_MONSTER_TEAM, 9)
  assert.equal(isMonsterTeam(9), true)
  assert.equal(isMonsterTeam(8), false)
  assert.deepEqual([getTeam(9).name, getTeam(9).color === getTeam(1).color], ['Monsters', false])
})

test('a monster\'s profile is checked, and filled in with defaults', () => {
  const profile = wolf().ai
  assert.deepEqual([profile.deaggroRange, profile.resetOnReturn, profile.aggroOnHit, profile.homeRadius, profile.respawnTicks], [450, true, true, 30, undefined])
  assert.equal(new Monster(def({ deaggroRange: undefined })).ai.deaggroRange, 450, 'one and a half times the aggro range')
  const bad = (ai: Partial<MonsterDef['ai']>, extra: Partial<MonsterDef> = {}): void =>
    assert.throws(() => new Monster(def(ai, { id: 't-bad-wolf', ...extra })), /Monster "t-bad-wolf"/)
  bad({ aggroRange: 0 })
  bad({ leashRange: -1 })
  bad({ deaggroRange: 200 })
  bad({ homeRadius: 0 })
  bad({ respawnTicks: 1.5 })
  bad({ respawnTicks: 0 })
  bad({ abilities: [{ abilityId: 'not-an-ability' }] })
  bad({ abilities: [{ abilityId: 't-lash', withinRange: 0 }] })
  bad({ abilities: [{ abilityId: 't-lash', belowHealth: 1.2 }] })
  bad({ abilities: [{ abilityId: 't-lash' }] }, { abilities: ['t-shockwave'] })
  assert.throws(() => new Monster(def({}, { id: 'cursebearer' })), /Monster "cursebearer" has the id of a champion/)
})
