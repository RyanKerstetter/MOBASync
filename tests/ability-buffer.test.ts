import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState } from '../apps/client/src/game-state.ts'
import { DEFAULT_SETTINGS } from '../apps/client/src/game-settings.ts'
import { menuTabs, type MenuItem } from '../apps/client/src/game-menu.ts'
import { GAME_TPS, getAbilityDef } from '../packages/shared/src/index.ts'
import { brawler } from './fixtures.js'

const ORIGIN = { x: 100, y: 100 }
const atTick = (tick: number): number => tick * 1000 / GAME_TPS

function duel(): ClientGameState {
  const gameState = new ClientGameState()
  gameState.simulator.addPlayer(1, 'player-1', 'Player 1', ORIGIN, brawler)
  gameState.simulator.addPlayer(2, 'player-2', 'Player 2', { x: 400, y: 100 }, brawler)
  gameState.setLocalCharacterId(1)
  // The clock starts at tick 0 at time 0, so `atTick` is the time of a tick.
  gameState.resetServerTickAnchor(0, 0)
  return gameState
}

test('an ability pressed while another winds up must wait, and is free to go once that one goes off', () => {
  const gameState = duel()
  // The brawler's fourth slot is a meteor, which winds up; its third a bolt.
  const meteor = gameState.createCastOrder(3, { x: 300, y: 100 }, 0)
  assert.ok(meteor.ok)
  const windUp = getAbilityDef('t-meteor')?.windUpTicks ?? 0
  assert.ok(windUp > 2, 'the meteor winds up')
  assert.match(gameState.castMustWait(2, atTick(1)) ?? '', /winds up/, 'the bolt waits for the meteor')
  assert.equal(gameState.castMustWait(2, atTick(windUp + 2)), undefined, 'and goes once the meteor has gone off')
})

test('an ability on cooldown is not held: it is refused, and says so', () => {
  const gameState = duel()
  const bolt = gameState.createCastOrder(2, { x: 100, y: 300 }, 0)
  assert.ok(bolt.ok)
  // Once the bolt has gone off and its cooldown is running.
  const later = atTick((getAbilityDef('t-bolt')?.windUpTicks ?? 0) + 5)
  assert.equal(gameState.castMustWait(2, later), undefined, 'a cooldown is not something to wait out')
  assert.match(gameState.getCastBlocker(2, later) ?? '', /cooldown/)
})

test('abilities are held by default, and the Controls tab can turn it off', () => {
  assert.equal(DEFAULT_SETTINGS.bufferAbilities, true)
  const noop = (): void => undefined
  let buffering = true
  const tabs = menuTabs({
    getCastMode: () => 'quick',
    setCastMode: noop,
    getClickRadius: () => 0,
    setClickRadius: noop,
    getWalkKeepsAuto: () => false,
    setWalkKeepsAuto: noop,
    getWalkKeepsCast: () => false,
    setWalkKeepsCast: noop,
    getMovementKeys: () => false,
    setMovementKeys: noop,
    getCastKeepsAttack: () => false,
    setCastKeepsAttack: noop,
    getBufferAbilities: () => buffering,
    setBufferAbilities: (on) => { buffering = on },
    getAttackMarkerSize: () => 100,
    setAttackMarkerSize: noop,
    getEffect: () => false,
    setEffect: noop,
    getMaxFps: () => 0,
    setMaxFps: noop,
    getDebugView: () => false,
    setDebugView: noop,
    getDiagnostics: () => false,
    setDiagnostics: noop,
  })
  const items = tabs.find((tab) => tab.id === 'controls')?.sections.flatMap((section) => section.items) ?? []
  const toggle = items.find((item) => item.label === 'Buffer abilities') as Extract<MenuItem, { kind: 'toggle' }> | undefined
  assert.ok(toggle, 'a Buffer abilities switch')
  assert.equal(toggle.get(), true)
  toggle.set(false)
  assert.equal(buffering, false)
})
