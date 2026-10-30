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
  base: { maxHp: 400, attackDamage: 20, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: ['t-shockwave', 't-lash', 't-bolt', 't-meteor'],
  ai: { aggroRange: 300, deaggroRange: 450, abilities: [], ...ai },
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

test('an idle monster goes after whoever hurt it, from however far, if there is a way to them', () => {
  const far = player(7, 400)
  assert.deepEqual(think(wolf(), body(), { mode: 'idle', provokedBy: 7 }, [far]).state, { mode: 'chase', targetId: 7 })
  assert.equal(think(wolf(), body(), idle, [far]).state.mode, 'idle', 'it would not have noticed them')
  for (const dx of [451, 2000, 9000]) {
    assert.deepEqual(think(wolf(), body(), { mode: 'idle', provokedBy: 7 }, [player(7, dx)]).state, { mode: 'chase', targetId: 7 }, `hit from ${dx} away, beyond its deaggro range: still provoked`)
  }
  assert.equal(think(wolf(), body(), { mode: 'idle', provokedBy: 7 }, [far], () => Infinity).state.mode, 'idle', 'but with no way to them there is nowhere to go')
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
  // Giving up is still ordered, since it stops what it is doing: the bar is a tick from full, and it is out of its range of home.
  const decision = think(wolf({ deaggroTicks: 10 }), body({ busy: true, position: at(500) }), { mode: 'chase', targetId: 1, deaggro: 9 }, [player(1, 1300)])
  assert.deepEqual(decision.state, { mode: 'return', deaggro: 10 })
  assert.deepEqual(decision.orders, [{ type: 'move', target: HOME }])
})

test('a monster does not lose interest while it is within its range of home, however far away the one it is after is', () => {
  const state = chasing(1)
  for (const dx of [100, 300, 450, 451, 2000, 9000]) {
    const decision = think(wolf(), body(), state, [player(1, dx)])
    assert.deepEqual(decision.state, state, `${dx} away, with the monster at home: nothing in the bar`)
    assert.deepEqual(decision.orders, [{ type: 'attack', targetId: 1 }])
  }
  // The range is the monster's from home, and not the target's from it: at 450 exactly it is still in.
  assert.deepEqual(think(wolf(), body({ position: at(450) }), state, [player(1, 500)]).state, state)
  assert.deepEqual(think(wolf(), body({ position: at(-450) }), state, [player(1, 500)]).state, state, 'whichever way it has gone')
})

test('once the monster is out of its range of home, its deaggro bar fills a tick at a time, wherever the one it is after is, and it goes on after them', () => {
  const out = body({ position: at(451) })
  const first = think(wolf(), out, chasing(1), [player(1, 460)])
  assert.deepEqual(first.state, { mode: 'chase', targetId: 1, deaggro: 1 }, 'a tick of the bar, and still on them')
  assert.deepEqual(first.orders, [{ type: 'attack', targetId: 1 }], 'still sent after them')
  assert.equal(first.reset, false)
  let state: AiState = first.state
  for (let tick = 2; tick <= 50; tick += 1) {
    // Right beside it, and a long way off: the same.
    state = think(wolf(), out, state, [player(1, tick % 2 ? 455 : 3000)]).state
    assert.deepEqual(state, { mode: 'chase', targetId: 1, deaggro: tick })
  }
  assert.deepEqual(think(wolf({ deaggroTicks: 5 }), out, { mode: 'chase', targetId: 1, deaggro: 3 }, [player(1, 460)]).state, { mode: 'chase', targetId: 1, deaggro: 4 })
  // It is the same to the north, since the range is a circle round its home.
  assert.deepEqual(think(wolf(), body({ position: at(0, 451) }), chasing(1), [player(1, 100)]).state, { mode: 'chase', targetId: 1, deaggro: 1 })
  assert.deepEqual(think(wolf(), body({ position: at(300, 340) }), chasing(1), [player(1, 100)]).state, { mode: 'chase', targetId: 1, deaggro: 1 }, '300 across and 340 up is 453 away')
  assert.deepEqual(think(wolf(), body({ position: at(300, 330) }), chasing(1), [player(1, 100)]).state, { mode: 'chase', targetId: 1 }, 'and 300 across and 330 up is 446')
})

test('when the bar is full it gives up on everyone and walks home, with the bar full, and settles down when it is there', () => {
  const full = wolf({ deaggroTicks: 5 })
  const state: AiState = { mode: 'chase', targetId: 1, deaggro: 4 }
  // The tick that fills it, away from home: it turns back.
  const gave = think(full, body({ position: at(500) }), state, [player(1, 900), player(2, 700)])
  assert.deepEqual(gave.state, { mode: 'return', deaggro: 5 })
  assert.deepEqual(gave.orders, [{ type: 'move', target: HOME }])
  assert.equal(gave.reset, false)
  // Close enough to home to count as being there, but out of a range as small as that: it has only to settle down, and is healed.
  const tiny = wolf({ aggroRange: 0, deaggroRange: 10, deaggroTicks: 5 })
  const home = think(tiny, body({ position: at(20) }), state, [player(1, 900)])
  assert.deepEqual(home, { state: { mode: 'idle' }, orders: [], reset: true })
  // Walking home it pays no attention to anyone, nearer or hurting it, and keeps the bar full till it is there.
  const walking = think(full, body({ position: at(300), moving: true }), gave.state, [player(2, 320), player(1, 301)])
  assert.deepEqual(walking, { state: { mode: 'return', deaggro: 5 }, orders: [], reset: false })
  assert.deepEqual(think(full, body({ position: at(300) }), gave.state, [player(2, 320)]).orders, [{ type: 'move', target: HOME }], 'and is told to walk again if it was stopped')
  assert.deepEqual(think(full, body({ position: at(30) }), gave.state, [player(2, 50)]), { state: { mode: 'idle' }, orders: [], reset: true }, 'home: the bar is empty again')
})

test('back within its range of home, the bar empties as fast as the profile says (a tick of it by default), and is gone at none', () => {
  const state: AiState = { mode: 'chase', targetId: 1, deaggro: 3 }
  assert.deepEqual(think(wolf(), body({ position: at(300) }), state, [player(1, 300)]).state, { mode: 'chase', targetId: 1, deaggro: 2 })
  assert.deepEqual(think(wolf({ deaggroRecovery: 2 }), body(), state, [player(1, 300)]).state, { mode: 'chase', targetId: 1, deaggro: 1 })
  assert.deepEqual(think(wolf({ deaggroRecovery: 5 }), body(), state, [player(1, 300)]).state, { mode: 'chase', targetId: 1 }, 'empty, and so not in the state at all')
  assert.deepEqual(think(wolf(), body(), { mode: 'chase', targetId: 1, deaggro: 1 }, [player(1, 300)]).state, { mode: 'chase', targetId: 1 })
  // Going out and in: the bar goes up and down, and does not give up while it is in.
  let now: AiState = chasing(1)
  const dxs = [500, 500, 500, 300, 300, 500, 500, 300]
  const bars = dxs.map((dx) => {
    now = think(wolf(), body({ position: at(dx) }), now, [player(1, 100)]).state
    return now.deaggro ?? 0
  })
  assert.deepEqual(bars, [1, 2, 3, 2, 1, 2, 3, 2])
})

test('a monster keeps the one it is after however many come near, in range of home or out of it, and the bar is the same', () => {
  const state: AiState = { mode: 'chase', targetId: 1, deaggro: 3 }
  // At home, with someone nearer in its aggro range: still after the one it was, with the bar emptying.
  const home = think(wolf(), body(), state, [player(1, 800), player(2, 100)])
  assert.deepEqual(home.state, { mode: 'chase', targetId: 1, deaggro: 2 })
  assert.deepEqual(home.orders, [{ type: 'attack', targetId: 1 }])
  // Out of its range of home, the same, with the bar filling.
  assert.deepEqual(think(wolf(), body({ position: at(500) }), state, [player(1, 900), player(2, 400)]).state, { mode: 'chase', targetId: 1, deaggro: 4 })
})

test('the bar does not matter when the one it is after dies or goes: it takes someone in its aggro range or goes home at once', () => {
  const half: AiState = { mode: 'chase', targetId: 1, deaggro: 100 }
  assert.deepEqual(think(wolf(), body({ position: at(200) }), half, [player(1, 100, 0, { alive: false })]).state, { mode: 'return' }, 'dead, and no one else: home, with an empty bar')
  assert.deepEqual(think(wolf(), body(), half, [player(2, 100)]).state, { mode: 'chase', targetId: 2, deaggro: 99 }, 'gone, and another is near')
})

// ---------------------------------------------------------------------------- walking, not the straight line

// A way round a wall: three times as far as the line, for everyone.
const roundAbout = (from: { x: number; y: number }, to: { x: number; y: number }): number => 3 * Math.hypot(to.x - from.x, to.y - from.y)

test('what it notices is the walk to someone and not the line to them: one behind a wall can be near and not noticed', () => {
  // Not noticed by an idle monster whose aggro range is 300 and who is 150 away to walk 450.
  assert.equal(think(wolf(), body(), idle, [player(1, 150)], roundAbout).state.mode, 'idle')
  assert.equal(think(wolf(), body(), idle, [player(1, 100)], roundAbout).state.mode, 'chase', 'and noticed at 100, which is 300 to walk')
  // One who hurt it from across a wall is gone after, round it, however long the walk is.
  assert.equal(think(wolf(), body(), { mode: 'idle', provokedBy: 7 }, [player(7, 200)], roundAbout).state.mode, 'chase')
  assert.equal(think(wolf(), body(), { mode: 'idle', provokedBy: 7 }, [player(7, 140)], roundAbout).state.mode, 'chase')
  // The nearest is the nearest to walk to, not in a line.
  const detour = (from: { x: number; y: number }, to: { x: number; y: number }): number => (to.x < from.x ? 2 : 1) * Math.hypot(to.x - from.x, to.y - from.y)
  assert.equal(think(wolf(), body(), idle, [player(1, -100), player(2, 150)], detour).state.targetId, 2, 'the one to the left is 200 to walk and the other 150, though 100 is nearer in a line')
  // And how long the walk to the one it is after is does not matter to its bar, which is about where the monster is.
  assert.deepEqual(think(wolf(), body(), chasing(1), [player(1, 200)], roundAbout).state, { mode: 'chase', targetId: 1 })
})

test('its range of home is the walk home and not the line: a wall between it and home can make it a long way out, near as it is', () => {
  // 200 from home in a line, and 600 to walk: out of the deaggro range of 450, so the bar fills.
  assert.deepEqual(think(wolf(), body({ position: at(200) }), chasing(1), [player(1, 100)], roundAbout).state, { mode: 'chase', targetId: 1, deaggro: 1 })
  // 140 away is 420 to walk: in range.
  assert.deepEqual(think(wolf(), body({ position: at(140) }), chasing(1), [player(1, 100)], roundAbout).state, { mode: 'chase', targetId: 1 })
  assert.deepEqual(think(wolf(), body({ position: at(140) }), { mode: 'chase', targetId: 1, deaggro: 5 }, [player(1, 100)], roundAbout).state, { mode: 'chase', targetId: 1, deaggro: 4 }, 'and the bar empties')
  // Far in a line is far on foot too.
  assert.deepEqual(think(wolf(), body({ position: at(451) }), chasing(1), [player(1, 100)]).state, { mode: 'chase', targetId: 1, deaggro: 1 })
  // And with no way home at all it is out of range, however near it is.
  const noWayHome = (from: { x: number; y: number }, to: { x: number; y: number }): number => (to.x === HOME.x && to.y === HOME.y ? Infinity : Math.hypot(to.x - from.x, to.y - from.y))
  assert.deepEqual(think(wolf(), body({ position: at(10) }), chasing(1), [player(1, 100)], noWayHome).state, { mode: 'chase', targetId: 1, deaggro: 1 })
})

test('there is no way to them: the chase is going nowhere, and the bar fills, however near', () => {
  const walled = () => Infinity
  assert.deepEqual(think(wolf(), body(), chasing(1), [player(1, 10)], walled).state, { mode: 'chase', targetId: 1, deaggro: 1 })
  assert.equal(think(wolf({ deaggroTicks: 3 }), body({ position: at(100) }), { mode: 'chase', targetId: 1, deaggro: 2 }, [player(1, 10)], walled).state.mode, 'return', 'and when it is full it goes home')
  assert.equal(think(wolf(), body(), idle, [player(1, 10)], walled).state.mode, 'idle', 'and not noticed')
})

test('the walk is only worked out for those that are asked about, and once for each', () => {
  const asked: number[] = []
  const counting = (from: { x: number; y: number }, to: { x: number; y: number }): number => {
    asked.push(to.x - HOME.x)
    return Math.hypot(to.x - from.x, to.y - from.y)
  }
  // The way home (0 is where home is), for the range it keeps from there, and the one it is after, whether there is a way to them,
  // and once: not when looking for someone, as it keeps them.
  think(wolf(), body(), chasing(1), [player(1, 200), player(2, 100), player(3, 900)], counting)
  assert.deepEqual(asked, [0, 200], 'the others are not asked about')
  asked.length = 0
  // Out of its range in a line, it is out of it on foot, and the bar fills whatever else is so: nothing is asked about.
  think(wolf(), body({ position: at(500) }), chasing(1), [player(1, 200)], counting)
  assert.deepEqual(asked, [] as number[])
  asked.length = 0
  // Without them it looks for someone: those within a line of the aggro range are asked about once each, and not the ones beyond it.
  think(wolf(), body(), chasing(9), [player(2, 100), player(3, 250), player(4, 301), player(5, 500)], counting)
  assert.deepEqual(asked.sort((a, b) => a - b), [0, 100, 250], 'each once, and not 301 or 500, which cannot be within 300, and the way home')
  asked.length = 0
  // The one who hurt it is asked about, to see that there is a way to them, and then is the one it goes after: once.
  think(wolf(), body(), { mode: 'idle', provokedBy: 4 }, [player(2, 100), player(4, 301)], counting)
  assert.deepEqual(asked, [301], 'and no one else')
  asked.length = 0
  // An idle monster that notices no one asks about no one; a passive one (aggro range 0) about no one but whoever hurt it.
  think(wolf({ aggroRange: 0, deaggroRange: 450 }), body(), idle, [player(1, 5), player(2, 100)], counting)
  assert.deepEqual([...asked], [] as number[], 'a monster that notices no one does not look')
  think(wolf({ aggroRange: 0, deaggroRange: 450 }), body(), { mode: 'idle', provokedBy: 2 }, [player(1, 5), player(2, 100)], counting)
  assert.deepEqual(asked, [100], 'it asks about the one who hurt it, and only that one')
})

test('a monster\'s deaggro bar has a time to fill and a rate to empty, with defaults, and they are checked', () => {
  const profile = wolf().ai
  assert.deepEqual([profile.deaggroTicks, profile.deaggroRecovery], [180, 1], 'three seconds, and as fast as it fills')
  assert.deepEqual([wolf({ deaggroTicks: 90, deaggroRecovery: 3 }).ai.deaggroTicks, wolf({ deaggroTicks: 90, deaggroRecovery: 3 }).ai.deaggroRecovery], [90, 3])
  const bad = (ai: Partial<MonsterDef['ai']>): void => assert.throws(() => new Monster(def(ai, { id: 't-bad-bar' })), /Monster "t-bad-bar"/)
  bad({ deaggroTicks: 0 })
  bad({ deaggroTicks: 1.5 })
  bad({ deaggroTicks: -60 })
  bad({ deaggroRecovery: 0 })
  bad({ deaggroRecovery: 0.5 })
})

test('a monster far from home with a bar full gives up, though its target is on top of it, and takes no one new on the way', () => {
  const out = body({ position: at(500) })
  const state: AiState = { mode: 'chase', targetId: 1, deaggro: 179 }
  // The tick that fills a bar of 180: the one it is after is right beside it, and someone else is in its aggro range, and it goes home.
  const full = think(wolf(), out, state, [player(1, 505), player(2, 520)])
  assert.deepEqual(full.state, { mode: 'return', deaggro: 180 })
  assert.deepEqual(full.orders, [{ type: 'move', target: HOME }])
  // And on the way home, neither is noticed.
  assert.deepEqual(think(wolf(), out, full.state, [player(1, 505), player(2, 520)]).state, { mode: 'return', deaggro: 180 })
})

test('there is no leash: however far from home it is drawn, a monster is after the one it was till its bar is full, and the bar is all that ends it', () => {
  for (const dx of [451, 1000, 5000]) {
    assert.deepEqual(think(wolf(), body({ position: at(dx) }), chasing(1), [player(1, dx + 10)]).state, { mode: 'chase', targetId: 1, deaggro: 1 }, `${dx} from home`)
  }
  // An idle monster that is out there, with someone to go after, goes after them: where it is does not give it up.
  assert.equal(think(wolf(), body({ position: at(601) }), idle, [player(1, 650)]).state.mode, 'chase')
})

test('when its target dies or goes it takes the nearest player in its aggro range, and goes home if there is none', () => {
  const state = chasing(1)
  const dead = player(1, 100, 0, { alive: false })
  assert.deepEqual(think(wolf(), body(), state, [dead, player(2, 250), player(3, 150)]).state, { mode: 'chase', targetId: 3 })
  assert.deepEqual(think(wolf(), body(), state, [player(2, 250), player(3, 150)]).orders, [{ type: 'attack', targetId: 3 }], 'a player that is gone')
  assert.deepEqual(think(wolf(), body(), state, [dead, player(2, 320)]).state, { mode: 'idle' }, 'the other is out of its aggro range')
  // Out of its range of home, and the one it is after alive and well: the bar fills, and the monster does not look for anyone else,
  // till the bar is full.
  const away = body({ position: at(500) })
  assert.deepEqual(think(wolf(), away, state, [player(1, 800), player(2, 700)]).state, { mode: 'chase', targetId: 1, deaggro: 1 })
  assert.equal(think(wolf({ deaggroTicks: 4 }), away, { mode: 'chase', targetId: 1, deaggro: 3 }, [player(1, 800), player(2, 700)]).state.mode, 'return')
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
  assert.equal(new Monster(def({ aggroRange: 0, deaggroRange: 300 }, { id: 't-passive' })).ai.aggroRange, 0, 'one that notices no one, and only fights back, is fine')
  bad({ aggroRange: -1 })
  bad({ deaggroRange: -1 })
  bad({ deaggroRange: 0 })
  bad({ aggroRange: 0, deaggroRange: undefined })
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
