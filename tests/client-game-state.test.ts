import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import {
  Champion,
  GAME_TPS,
  getAbilityDef,
  getChampion,
  type CastTarget,
  type ChampionDef,
  type Vector2,
} from '../packages/shared/src/index.ts'
import { brawler, grenadier, gunner, ninja, spouter, trinketmaster } from './fixtures.ts'

function championDef(champion: Champion): ChampionDef {
  return { ...champion, abilities: [...champion.abilities] }
}

test('rendering clamps an outdated estimate to the latest computed snapshot', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 })
  gameState.setLocalCharacterId(1)
  for (let tick = 1; tick <= 20; tick += 1) gameState.simulator.at(tick)

  const characters = gameState.getCharacters(0)

  assert.equal(characters.length, 1)
  assert.deepEqual(characters[0].position, { x: 100, y: 100 })
  assert.equal(gameState.getAttackCooldownProgress(0), 1)
  assert.deepEqual(gameState.getDebugInfo(0).localPosition, { x: 100, y: 100 })
})

test('a pong behind computed snapshots does not request an evicted frame', () => {
  const gameState = new ClientGameState()
  for (let tick = 1; tick <= 20; tick += 1) gameState.simulator.at(tick)

  gameState.recordPong(1000, 10, 1000)

  assert.equal(gameState.simulator.tick, 20)
})

test('client derives health changes from its local attack order', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 }, brawler)

  assert.equal(gameState.simulator.addOrder(1, {
    id: 'player-1:1',
    seq: 1,
    tick: 1,
    type: 'attack',
    targetId: 2,
  }), true)

  const target = gameState.simulator.at(1).get(2)
  assert.equal(target?.getHealth(), 900)
})

test('resetting the tick anchor at game start keeps order ticks inside the server window', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 })
  gameState.setLocalCharacterId(1)
  // The server tick stays at 0 while lobbies load, but the local estimate keeps advancing.
  gameState.setServerTick(0, 0)

  gameState.resetServerTickAnchor(0, 5000)
  const order = gameState.createMoveOrder({ x: 300, y: 100 }, 5000)

  assert.ok(order)
  assert.ok(order.tick <= 1)
})

test('ability cooldowns count down continuously between whole ticks', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  const order = gameState.createCastOrder(0, { x: 100, y: 100 }, 0)
  assert.ok(order.ok)
  gameState.simulator.advanceTo(20)

  const remaining = [1000, 1004, 1008, 1012].map((now) => {
    gameState.resetServerTickAnchor(0, 1000 - 20 * 1000 / 60)
    return gameState.getAbilityCooldowns(now)[0].ticksRemaining
  })
  const steps = remaining.slice(1).map((value, index) => remaining[index] - value)

  assert.ok(steps.every((step) => step > 0 && step < 0.5), `steps ${steps}`)
})

test('the client shows a death as soon as it predicts it, but counts the kill only once it is committed', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, new Champion({
    ...championDef(brawler),
    attackSpeed: GAME_TPS,
  }))
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 140, y: 100 }, brawler)
  gameState.setLocalCharacterId(2)
  for (let index = 0; index < 12; index += 1) {
    gameState.simulator.addOrder(1, {
      id: `attack-${index + 1}`, seq: index + 1, tick: index + 1, type: 'attack', targetId: 2,
    })
  }
  gameState.simulator.advanceTo(12)

  // It fell on screen at once: the server has not been asked.
  const predicted = gameState.getCharacters(0).find((character) => character.id === 2)
  assert.equal(predicted?.health?.hp, 0)
  assert.equal(predicted?.dead, true)
  assert.equal(gameState.isLocalDead(0), true)
  // But the kill is not taken as certain yet: a late order could still undo it.
  assert.deepEqual(gameState.getLeaderboard().map(({ characterId, kills }) => [characterId, kills]), [[1, 0], [2, 0]])
  assert.deepEqual(gameState.getKillFeed(0), [])

  gameState.simulator.setCommitTick(12)
  const [first, second] = gameState.getLeaderboard()
  assert.deepEqual([first.name, first.kills, first.team], ['Player 1', 1, 1], 'the killer leads')
  assert.deepEqual([second.name, second.kills, second.isLocal], ['Player 2', 0, true])
  const feed = gameState.getKillFeed(performance.now())
  assert.equal(feed.length, 1)
  assert.deepEqual([feed[0].killer?.name, feed[0].victim.name], ['Player 1', 'Player 2'])

  // A death told of again (a checkpoint can take the commit tick back) is not a second line.
  const snapshot = gameState.simulator.snapshot()
  gameState.applySnapshot(snapshot)
  gameState.simulator.advanceTo(14)
  gameState.simulator.setCommitTick(14)
  assert.equal(gameState.getKillFeed(performance.now()).length, 1)
  assert.equal(gameState.getLeaderboard()[0].kills, 1)
})

function createArcherClient(): ClientGameState {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, getChampion('t-archer'))
  // Just past the archer's own range, inside the extra reach focus gives.
  const gap = getChampion('t-archer').attackRange + 60
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 100 + gap, y: 100 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  return gameState
}

test('the attack range ring and enemy search include the focus range bonus', () => {
  const gameState = createArcherClient()
  const archer = getChampion('t-archer')
  gameState.simulator.at(3)
  assert.equal(gameState.getLocalAttackRange(0), archer.attackRange)
  assert.equal(gameState.getClosestEnemyInRange(0), undefined, 'the enemy is just out of range')

  gameState.simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 4, type: 'cast', abilityId: 't-focus', target: { mode: 'none' }, origin: { x: 100, y: 100 },
  })
  gameState.simulator.at(6)
  assert.equal(gameState.getLocalAttackRange(0), archer.attackRange + 120)
  assert.equal(gameState.getClosestEnemyInRange(0)?.id, 2)
})

test('the local character is drawn between ticks while dashing, and does not overshoot its target', () => {
  const step = 600 / GAME_TPS
  const reach = Math.round(120 * 0.8)
  const gameState = createArcherClient()
  gameState.simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-leap',
    target: { mode: 'point', point: { x: 100 + reach, y: 100 } }, origin: { x: 100, y: 100 },
  })
  const atTick = (tick: number): number => tick * 1000 / GAME_TPS
  const positionAt = (now: number): number =>
    gameState.getCharacters(now).find((character) => character.id === 1)?.position.x ?? 0

  // Tick 5 is four whole steps along; half a tick later it is half a step further.
  assert.ok(Math.abs(positionAt(atTick(5)) - (100 + step * 4)) < 1e-6)
  assert.ok(Math.abs(positionAt(atTick(5.5)) - (100 + step * 4.5)) < 1e-6)
  // Once it has arrived there is nothing left to extrapolate.
  const landing = 1 + Math.ceil(reach / step)
  assert.equal(positionAt(atTick(landing + 0.5)), 100 + reach)
})

test('the later bubbles of a volley are not drawn until their turn', () => {
  const capricorn = getChampion('t-capricorn')
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, capricorn)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 700, y: 400 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  gameState.simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-bubbles',
    target: { mode: 'direction', dir: { x: 1, y: 0 } }, origin: { x: 100, y: 100 },
  })
  const bubbles = getAbilityDef('t-bubbles')
  assert.ok(bubbles)
  const launch = 1 + bubbles.windUpTicks
  const drawn = (tick: number): number => gameState.getEntities(tick * 1000 / GAME_TPS).length

  assert.equal(drawn(launch), 1, 'only the first bubble is out at launch')
  assert.equal(drawn(launch + 5), 2)
  assert.equal(drawn(launch + 2 * 5), 3)
})

test('a rectangular entity reaches the renderer with its shape and heading', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, getChampion('t-capricorn'))
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 700, y: 400 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  gameState.simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-tsunami',
    target: { mode: 'direction', dir: { x: 0, y: 1 } }, origin: { x: 100, y: 100 },
  })
  const tsunami = getAbilityDef('t-tsunami')
  assert.ok(tsunami)

  const wave = gameState.getEntities((1 + tsunami.windUpTicks + 1) * 1000 / GAME_TPS)[0]
  assert.deepEqual(wave?.box, { halfLength: 40 / 2, halfWidth: 150 / 2 })
  assert.deepEqual(wave?.facing, { x: 0, y: 1 })
})

test('a shot in flight is drawn between ticks, gliding along its heading', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, gunner)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 350, y: 100 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  gameState.simulator.addOrder(1, { id: 'player-1:1', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  const launch = 1 + gunner.attackWindupTicks
  const step = 600 / GAME_TPS
  const shotAt = (tick: number): number | undefined =>
    gameState.getEntities(tick * 1000 / GAME_TPS)[0]?.position.x

  // Six ticks after launch the shot is six steps out, and half a tick later half a step further.
  assert.ok(Math.abs((shotAt(launch + 6) ?? NaN) - (100 + step * 6)) < 1e-6)
  assert.ok(Math.abs((shotAt(launch + 6.5) ?? NaN) - (100 + step * 6.5)) < 1e-6)
  assert.ok(Math.abs((shotAt(launch + 7) ?? NaN) - (100 + step * 7)) < 1e-6, 'and it joins up with the next tick')
})

test('burning and blinded characters are reported to the renderer, so their status can be shown', () => {
  const flagsOf = (abilityId: string, target: CastTarget, enemyAt: Vector2, tick: number) => {
    const gameState = new ClientGameState()
    gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 300 }, grenadier)
    gameState.simulator.addPlayer(2, 'player-2', 'Player 2', enemyAt, brawler)
    gameState.setLocalCharacterId(1)
    gameState.resetServerTickAnchor(0, 0)
    gameState.simulator.addOrder(1, {
      id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId, target, origin: { x: 100, y: 300 },
    })
    const enemy = gameState.getCharacters(tick * 1000 / GAME_TPS).find((character) => character.id === 2)
    return { burning: enemy?.burning, blinded: enemy?.blinded }
  }

  assert.deepEqual(
    flagsOf('t-ignite', { mode: 'unit', unitId: 2 }, { x: 250, y: 300 }, 10),
    { burning: true, blinded: false },
  )
  // The flashbang is lobbed 120 px and goes off at (220, 300), 80 above the enemy: at the edge of
  // the flash, so it is blinded and not stunned.
  assert.deepEqual(
    flagsOf('t-flashbang', { mode: 'point', point: { x: 220, y: 300 } }, { x: 220, y: 380 }, 20),
    { burning: false, blinded: true },
  )
})

test('a telegraph reports how far its warning has run, so the client can fill it in', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 225 }, spouter)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 700, y: 400 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  gameState.simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-spout',
    target: { mode: 'point', point: { x: 400, y: 225 } }, origin: { x: 100, y: 225 },
  })
  const spout = getAbilityDef('t-spout')
  assert.ok(spout)
  const launch = 1 + spout.windUpTicks
  const warningAt = (tick: number) => gameState.getEntities(tick * 1000 / GAME_TPS)[0]

  assert.equal(warningAt(launch)?.visual, 'telegraph')
  assert.ok(Math.abs((warningAt(launch)?.progress ?? 1) - 0) < 1e-9, 'it starts empty')
  // The warning lasts 42 ticks and goes off on the one after, so 43 ticks fill it.
  assert.ok(Math.abs((warningAt(launch + 21)?.progress ?? 0) - 21 / 43) < 1e-9, 'half way along')
  assert.ok((warningAt(launch + 42)?.progress ?? 0) > 0.97, 'nearly full just before it goes off')
})

function createStickClient(enemy: Champion = trinketmaster): ClientGameState {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 300, y: 300 }, trinketmaster)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 400, y: 300 }, enemy)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  return gameState
}
const atTick = (tick: number): number => tick * 1000 / GAME_TPS

test('the stick key throws it while none is out, then calls it back, and shows that instead', () => {
  const gameState = createStickClient()
  // Thrown by the key itself on tick 1 at the point aimed at, which is 300 px along: the farthest it
  // goes. In the air until tick 36, then lying on the ground there.
  const thrown = gameState.createCastOrder(0, { x: 600, y: 300 }, atTick(0))
  assert.ok(thrown.ok)
  assert.equal(thrown.order.abilityId, 't-stick')
  assert.deepEqual(thrown.order.target, { mode: 'point', point: { x: 600, y: 300 } })

  assert.equal(gameState.abilityNeedsAim(0, atTick(20)), true, 'the throw is aimed')
  // Aimed, it is drawn as a band as wide as the stick from the thrower to where it will land.
  const aimed = gameState.getCastPreview(0, { x: 450, y: 300 }, atTick(20))
  assert.equal(aimed?.abilityId, 't-stick')
  assert.equal(aimed?.targeting, 'point')
  assert.deepEqual(aimed?.target, { mode: 'point', point: { x: 450, y: 300 } }, 'where the player aims is where it goes')
  assert.deepEqual(aimed?.indicator, { line: true, width: 16 })
  assert.equal(aimed?.indicator?.radius, undefined)
  assert.equal(aimed?.minRange, 150)
  assert.equal(gameState.getAbilityCooldowns(atTick(20))[0].abilityId, 't-stick')

  // The player chooses how far, but not nearer than 150 or farther than 300: past either, the point is
  // held to it along the same heading, and the order carries the point that was shown.
  const near = gameState.getCastPreview(0, { x: 340, y: 300 }, atTick(20))
  assert.deepEqual(near?.target, { mode: 'point', point: { x: 450, y: 300 } }, 'pushed out to 150')
  const far = gameState.getCastPreview(0, { x: 900, y: 300 }, atTick(20))
  assert.deepEqual(far?.target, { mode: 'point', point: { x: 600, y: 300 } }, 'held to 300')
  // (A fresh game for the casts, since the first throw above has the stick out and on cooldown.)
  const fresh = createStickClient()
  const diagonal = fresh.createCastOrder(0, { x: 310, y: 310 }, atTick(0))
  assert.ok(diagonal.ok)
  const point = diagonal.order.target.mode === 'point' ? diagonal.order.target.point : undefined
  assert.ok(point)
  assert.ok(Math.abs(Math.hypot(point.x - 300, point.y - 300) - 150) < 1e-9, 'a short throw along a diagonal is 150 long')
  assert.ok(Math.abs(point.x - point.y) < 1e-9, 'and keeps its heading')
  // Right on top of the thrower there is no heading to push out along.
  const onSelf = createStickClient().createCastOrder(0, { x: 300, y: 300 }, atTick(0))
  assert.deepEqual(onSelf, { ok: false, reason: 'Aim away from your champion.' })

  // With the stick down, the same key calls it back: nothing to aim, and its own cooldown.
  assert.equal(gameState.abilityNeedsAim(0, atTick(40)), false, 'the recall is not aimed')
  const preview = gameState.getCastPreview(0, { x: 700, y: 300 }, atTick(40))
  assert.deepEqual([preview?.abilityId, preview?.targeting], ['t-recall', 'none'])
  const shown = gameState.getAbilityCooldowns(atTick(40))[0]
  assert.deepEqual([shown.slot, shown.abilityId, shown.ticksRemaining], [0, 't-recall', 0])
  assert.equal(gameState.getCastBlocker(0, atTick(40)), undefined)

  const attempt = gameState.createCastOrder(0, { x: 700, y: 300 }, atTick(40))
  assert.ok(attempt.ok)
  assert.equal(attempt.order.abilityId, 't-recall')
  assert.deepEqual(attempt.order.target, { mode: 'none' })
})

test('an ability that cannot be cast says why, instead of sending an order the simulator would drop', () => {
  const gameState = createStickClient()

  // Warp is the third key and needs a stick on the ground, or the throw on cooldown with no stick anywhere.
  const reason = 't-warp needs your t-stick out, or your t-stick on cooldown with none in play.'
  assert.equal(gameState.getCastBlocker(2, atTick(5)), reason)
  const refused = gameState.createCastOrder(2, { x: 0, y: 0 }, atTick(5))
  assert.deepEqual(refused, { ok: false, reason })

  // Silenced by the enemy's hush: readied on tick 1, it rides the auto the enemy walks up and lands.
  gameState.simulator.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-hush',
    target: { mode: 'none' }, origin: { x: 400, y: 300 },
  })
  gameState.simulator.addOrder(2, { id: 'player-2:2', seq: 2, tick: 2, type: 'attack', targetId: 1 })
  assert.equal(gameState.getCastBlocker(1, atTick(10)), 'You cannot cast while silenced.')
  assert.equal(gameState.getCharacters(atTick(10)).find((character) => character.id === 1)?.silenced, true)
  assert.equal(gameState.getCharacters(atTick(10)).find((character) => character.id === 2)?.silenced, false)
})

test('warp can be cast with no stick in play once the throw is on cooldown, and not while the stick is in the air', () => {
  const gameState = createStickClient()
  // The stick is thrown on tick 1 to 300 px along (leaves on tick 5, down on tick 36), called back on
  // tick 60, and home by about tick 90, with the throw's 8 s still running.
  const thrown = gameState.createCastOrder(0, { x: 600, y: 300 }, atTick(0))
  assert.ok(thrown.ok)
  gameState.simulator.addOrder(1, {
    id: 'player-1:90', seq: 90, tick: 60, type: 'cast', abilityId: 't-recall', target: { mode: 'none' }, origin: { x: 300, y: 300 },
  })

  assert.equal(gameState.getCastBlocker(2, atTick(20)) !== undefined, true, 'not while the stick is in the air')
  assert.equal(gameState.getCastBlocker(2, atTick(40)), undefined, 'but a stick on the ground can be warped to')
  assert.equal(gameState.getCastBlocker(2, atTick(75)) !== undefined, true, 'not while the stick is coming back')
  assert.equal(gameState.getCastBlocker(2, atTick(150)), undefined, 'and with it home and the throw still on cooldown, it can')
  const warp = gameState.createCastOrder(2, { x: 0, y: 0 }, atTick(150))
  assert.ok(warp.ok)
  assert.equal(warp.order.abilityId, 't-warp')
})

test('clicking, auto-targeting and aiming skip teammates, and every character reports its team', () => {
  const gameState = new ClientGameState()
  // The teammate is closer than the enemy, and both are within the local champion's attack range.
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler, 1)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 150, y: 100 }, brawler, 1)
  gameState.simulator.addPlayer(3, 'player-3', 'Player 3', { x: 200, y: 100 }, brawler, 2)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)

  assert.deepEqual(gameState.getCharacters(0).map((character) => [character.id, character.team]), [[1, 1], [2, 1], [3, 2]])
  assert.equal(gameState.getEnemyNear({ x: 150, y: 100 }, 0), undefined, 'a click on a teammate is not a target')
  assert.equal(gameState.getEnemyNear({ x: 200, y: 100 }, 0)?.id, 3, 'a click on an enemy is')
  assert.equal(gameState.getClosestEnemyInRange(0)?.id, 3, 'and the nearest enemy is the enemy, not the nearer teammate')

  // A unit ability (the second key, a lash) aimed at the teammate has nothing to target, and aimed at
  // the enemy it is cast.
  const atTeammate = gameState.createCastOrder(1, { x: 150, y: 100 }, 0)
  assert.equal(atTeammate.ok, false)
  assert.match(atTeammate.ok ? '' : atTeammate.reason, /at an enemy/)
  const atEnemy = gameState.createCastOrder(1, { x: 200, y: 100 }, 0)
  assert.ok(atEnemy.ok)
  assert.deepEqual(atEnemy.order.target, { mode: 'unit', unitId: 3 })
})

test('an attack order locks the local champion onto its target, and walking away lets it go', () => {
  const gameState = new ClientGameState()
  // The enemy is well out of reach, so the champion has to walk up to it.
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 600, y: 100 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)

  assert.equal(gameState.getLocalAttackTarget(atTick(5)), undefined, 'nothing yet')
  const order = gameState.createAttackOrder(2, atTick(0))
  assert.ok(order)
  assert.match(order.id, /^1:[0-9]+$/, 'orders are named by the character that gave them and a number, which is short')
  const lockedAt = order.tick + 1
  assert.equal(gameState.getLocalAttackTarget(atTick(lockedAt)), 2, 'locked on from the order')
  assert.equal(gameState.getLocalAttackTarget(atTick(lockedAt + 40)), 2, 'and still, while it walks up')
  const walking = gameState.getCharacters(atTick(lockedAt + 40)).find((character) => character.id === 1)
  assert.ok((walking?.position.x ?? 0) > 100, 'it set off after the target')

  const move = gameState.createMoveOrder({ x: 100, y: 100 }, atTick(lockedAt + 45))
  assert.ok(move)
  assert.equal(gameState.getLocalAttackTarget(atTick(move.tick + 1)), undefined, 'a move order lets it go')
})

test('only an enemy a click would attack can be hovered: not a teammate, not oneself, not the dead', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler, 1)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 200, y: 100 }, brawler, 1)
  gameState.simulator.addPlayer(3, 'player-3', 'Player 3', { x: 300, y: 100 }, brawler, 2)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)

  assert.equal(gameState.getEnemyNear({ x: 100, y: 100 }, 0), undefined, 'not oneself')
  assert.equal(gameState.getEnemyNear({ x: 200, y: 100 }, 0), undefined, 'not a teammate')
  assert.equal(gameState.getEnemyNear({ x: 300, y: 100 }, 0)?.id, 3, 'an enemy')
  assert.equal(gameState.getEnemyNear({ x: 300 + brawler.radius + 5, y: 100 }, 0)?.id, 3, 'a little off its edge still is')
  assert.equal(gameState.getEnemyNear({ x: 300 + brawler.radius + 30, y: 100 }, 0), undefined, 'but not far from it')
})

test('the ninja Q key aims a dash until a shadow is out and then dashes back to it without aiming', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 300, y: 300 }, ninja)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 400, y: 300 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)

  assert.equal(gameState.abilityNeedsAim(0, atTick(0)), true, 'the forward dash is aimed')
  // Aimed, a dash is drawn as a line to the point as well as the point, and the point is held to its range.
  const aimed = gameState.getCastPreview(0, { x: 900, y: 300 }, atTick(0))
  assert.deepEqual(aimed?.indicator, { line: true })
  assert.deepEqual(aimed?.target, { mode: 'point', point: { x: 600, y: 300 } })
  const forward = gameState.createCastOrder(0, { x: 600, y: 300 }, atTick(0))
  assert.ok(forward.ok)
  assert.equal(forward.order.abilityId, 't-shadowstep')
  assert.deepEqual(forward.order.target, { mode: 'point', point: { x: 600, y: 300 } })

  // The dash through the brawler leaves a shadow, and the dash is over by tick 20.
  gameState.simulator.addOrder(1, forward.order)
  assert.equal(gameState.abilityNeedsAim(0, atTick(70)), false, 'the dash back is not aimed')
  const preview = gameState.getCastPreview(0, { x: 0, y: 0 }, atTick(70))
  assert.deepEqual([preview?.abilityId, preview?.targeting], ['t-shadowreturn', 'none'])
  const back = gameState.createCastOrder(0, { x: 0, y: 0 }, atTick(70))
  assert.ok(back.ok)
  assert.equal(back.order.abilityId, 't-shadowreturn')
  assert.deepEqual(back.order.target, { mode: 'none' })
})

test('a dodging champion is reported to the renderer, and the foe is not', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 300, y: 300 }, ninja)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 400, y: 300 }, brawler)
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  gameState.simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-dodge', target: { mode: 'none' }, origin: { x: 300, y: 300 },
  })

  const dodging = (tick: number, id: number): boolean | undefined =>
    gameState.getCharacters(atTick(tick)).find((character) => character.id === id)?.dodging
  assert.equal(dodging(10, 1), true)
  assert.equal(dodging(10, 2), false)
  assert.equal(dodging(100, 1), false, 'and it wears off')
})

test('a champion in the windup of an ability is shown casting, and one using an ability with no windup is not', () => {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', { x: 100, y: 100 }, brawler)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 400, y: 300 }, getChampion('t-archer'))
  gameState.setLocalCharacterId(1)
  gameState.resetServerTickAnchor(0, 0)
  // The brawler's shockwave has a windup of 6 ticks and a backswing of 6; the archer's focus has neither.
  gameState.simulator.addOrder(1, {
    id: 'player-1:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-shockwave', target: { mode: 'none' }, origin: { x: 100, y: 100 },
  })
  gameState.simulator.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-focus', target: { mode: 'none' }, origin: { x: 400, y: 300 },
  })
  const view = (tick: number, id: number) => gameState.getCharacters(atTick(tick)).find((character) => character.id === id)?.action

  assert.equal(view(1, 1)?.kind, 'cast')
  assert.ok(Math.abs((view(7, 1)?.progress ?? 0) - 0.5) < 1e-9, 'half way through its windup and backswing')
  assert.equal(view(13, 1), undefined, 'and done')
  assert.equal(view(1, 2), undefined, 'a focus is not a cast to show')
  assert.equal(view(2, 2), undefined)
})

test('a stunned champion is told so', () => {
  // The grenadier's flashbang is lobbed 100 px at the trinketmaster and goes off on tick 16, with the
  // trinketmaster right in the middle of it.
  const gameState = createStickClient(grenadier)
  gameState.simulator.addOrder(2, {
    id: 'player-2:1', seq: 1, tick: 1, type: 'cast', abilityId: 't-flashbang',
    target: { mode: 'point', point: { x: 300, y: 300 } }, origin: { x: 400, y: 300 },
  })

  assert.equal(gameState.getCastBlocker(1, atTick(20)), 'You cannot cast while stunned.')
})
