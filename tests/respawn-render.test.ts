import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState, type RenderedCharacter } from '../apps/client/src/game-state.ts'
import { GAME_TPS, getMonster, type Monster, type Vector2 } from '../packages/shared/src/index.ts'
import { defineChampion, defineMonster, killAt } from './fixtures.ts'

// What is drawn when something comes back to life: it is where it respawns from the first frame it is alive, and does not slide there from where it died. (A character that
// died less than the page's snap distance from where it comes back used to be smoothed along to it, like a walk, so a monster that died a short way from its post was
// seen hopping home as it came back.) The monsters of the game are played as they are, with a monster of the tests' own beside them; every distance is read from them.

const HOME: Vector2 = { x: 600, y: 700 }
const MONSTER = 10
const TICK_MS = 1000 / GAME_TPS
// A screen draws more than a frame in a tick, and the page's smoothing is by the time between frames, so the test draws several in each tick.
const FRAMES_PER_TICK = 4
// How far from its post the monster is pulled to fight: past the post's radius, and well inside the page's snap distance, which is the case this is about.
const PULLED = 70

const gnaw = defineMonster({
  id: 't-rr-gnaw',
  name: 'Gnaw',
  base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 60,
  attackWindup: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300, respawnTicks: 200 },
})
// Stands at a distance and hits what is in front of it, which makes a monster that notices no one come after it.
const poker = defineChampion({
  id: 't-rr-poker', name: 'Poker', base: { maxHp: 1000, attackDamage: 1, attackSpeed: 1 }, moveSpeed: 100, radius: 20, attackRange: 400, attackWindup: 0, abilities: [],
})

const distance = (a: Vector2, b: Vector2): number => Math.hypot(a.x - b.x, a.y - b.y)
let sequence = 0

// A game in which the poker (the local champion) hits the monster from `standoff` away once it has appeared, so that the monster comes after it and fights a short way from
// its post.
function fight(monster: Monster, standoff: number): ClientGameState {
  const state = new ClientGameState()
  state.simulator.addPlayer(1, 'p1', 'Poker', { x: HOME.x + standoff, y: HOME.y }, poker, 1)
  state.simulator.addMonster(MONSTER, monster, HOME)
  state.setLocalCharacterId(1)
  state.simulator.addOrder(1, { id: `a${++sequence}`, seq: sequence, tick: monster.ai.spawnOffsetTicks + 2, type: 'attack', targetId: MONSTER })
  state.resetServerTickAnchor(0, 0)
  return state
}

type Look = { tick: number; frame: number; character: RenderedCharacter }
// Draws the game as a page would: the clock runs on a few frames to every tick and the characters are read each time, so the page's smoothing has what it has in play. `look` is
// called with each frame of the monster.
function draw(state: ClientGameState, from: number, to: number, look: (seen: Look) => void): void {
  for (let tick = from; tick <= to; tick += 1) {
    state.simulator.advanceTo(tick)
    // The server's clock reads this tick at the start of it, and the frames are drawn through it.
    const tickStart = tick * TICK_MS
    state.resetServerTickAnchor(tick, tickStart)
    for (let frame = 0; frame < FRAMES_PER_TICK; frame += 1) {
      const now = tickStart + frame / FRAMES_PER_TICK * TICK_MS
      const character = state.getCharacters(now).find((each) => each.id === MONSTER)
      if (character) look({ tick, frame, character })
    }
  }
}

const roster: Array<[string, Monster]> = [['the test monster', gnaw], ['the slime', getMonster('slime')], ['the golem', getMonster('golem')]]

for (const [name, monster] of roster) {
  test(`${name}, killed a short way from its post, is drawn at the post from the first frame it is alive, not sliding there`, () => {
    const respawn = monster.ai.respawnTicks
    assert.ok(respawn !== undefined, 'it comes back')
    const state = fight(monster, monster.champion.attackRange + PULLED)
    const killedAt = monster.ai.spawnOffsetTicks + 120
    killAt(state.simulator, MONSTER, killedAt)

    // First, where it fights and dies: away from its post.
    let diedAt: Vector2 | undefined
    draw(state, monster.ai.spawnOffsetTicks, killedAt - 1, ({ character }) => { diedAt = { ...character.position } })
    assert.ok(diedAt, 'the monster was drawn')
    const away = distance(diedAt, HOME)
    assert.ok(away > monster.ai.homeRadius, `it was pulled off its post to fight (${away.toFixed(1)} away)`)
    assert.ok(away > 0.5 * PULLED, 'a good way, and so (from its own size) not one that the page would take for a teleport')

    // The page draws a character a little in the past, so the frames just after the kill still have it alive: only those after it has been seen dead count.
    const aliveAgain: Look[] = []
    let deadFrames = 0
    draw(state, killedAt, killedAt + respawn + 60, (seen) => {
      if (seen.character.dead) deadFrames += 1
      else if (deadFrames > 0) aliveAgain.push(seen)
    })
    assert.ok(deadFrames > 0, 'it was drawn dead for a time')
    assert.ok(aliveAgain.length > 0, 'and alive again')
    for (const { tick, frame, character } of aliveAgain) {
      assert.ok(
        distance(character.position, HOME) < 1e-6,
        `tick ${tick} frame ${frame}: alive and ${distance(character.position, HOME).toFixed(1)} from its post, on the way to it`,
      )
    }
  })
}

test('a monster that dies at its post comes back at it, as it always did', () => {
  // Close enough that it is already in reach of the poker and has no need to come after it.
  const state = fight(gnaw, gnaw.champion.attackRange - 20)
  const killedAt = 60
  killAt(state.simulator, MONSTER, killedAt)
  let strayed = 0
  let seen = 0
  draw(state, 1, killedAt + (gnaw.ai.respawnTicks ?? 0) + 30, ({ character }) => {
    seen += 1
    if (distance(character.position, HOME) > gnaw.ai.homeRadius) strayed += 1
  })
  assert.ok(seen > 0)
  assert.equal(strayed, 0, 'it never leaves its post')
})

test('a monster that walks home after giving up is drawn walking smoothly, a frame at a time, at the speed it goes', () => {
  const home = defineMonster({
    id: 't-rr-leash',
    name: 'Leash',
    base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
    moveSpeed: 100,
    radius: 20,
    attackRange: 60,
    attackWindup: 0,
    abilities: [],
    // It gives up quickly, and goes home at twice its pace.
    ai: { aggroRange: 0, deaggroRange: 100, deaggroTicks: 30, returnSpeedMultiplier: 2, respawnTicks: 200 },
  })
  const state = fight(home, home.champion.attackRange + 220)
  // The poker walks off after a while, so the monster has nothing to chase and, being past its deaggro range, goes home.
  state.simulator.addOrder(1, { id: `m${++sequence}`, seq: sequence, tick: 60, type: 'move', target: { x: HOME.x + 900, y: HOME.y } })
  let previous: Vector2 | undefined
  let walkedHome = 0
  let biggestStep = 0
  draw(state, 1, 400, ({ character }) => {
    if (previous) biggestStep = Math.max(biggestStep, distance(character.position, previous))
    previous = { ...character.position }
    if (character.monster?.mode === 'return') walkedHome += 1
  })
  assert.ok(walkedHome > 0, 'it went home')
  // The most it can be seen to move in a frame is the fastest the page's catching up goes, which is three times the pace it walks at.
  assert.ok(biggestStep <= 3 * home.champion.moveSpeed / GAME_TPS / FRAMES_PER_TICK + 1e-6, `no step in a frame bigger than that: ${biggestStep.toFixed(2)}`)
  assert.ok(previous && distance(previous, HOME) < home.ai.homeRadius, 'and it ended at its post')
})
