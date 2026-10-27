import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState, type RenderedCharacter } from '../apps/client/src/game-state.ts'
import { CharacterLayer } from '../apps/client/src/render/character-layer.ts'
import { CORPSE_SECONDS, layoutCorpse } from '../apps/client/src/render/corpse.ts'
import { brawler, defineChampion, defineMonster } from './fixtures.ts'

// What is left of a monster after it dies: its nameplate goes at once and its body a couple of seconds later, and both are back when it
// respawns. A player's champion is not a corpse: it stays as a ghost until it comes back.

const monster = { aggroRange: 0, deaggroRange: 300, deaggro: 0, home: { x: 0, y: 0 }, mode: 'idle' as const }

test('a dead monster has no nameplate, and its body stays for a couple of seconds from the tick it died on and then goes', () => {
  assert.equal(CORPSE_SECONDS, 2)
  assert.deepEqual(layoutCorpse({ dead: false, monster }), { body: true, nameplate: true }, 'alive, it has both')
  assert.deepEqual(layoutCorpse({ dead: true, monster, deadForSeconds: 0 }), { body: true, nameplate: false }, 'the moment it dies the nameplate is gone')
  assert.deepEqual(layoutCorpse({ dead: true, monster, deadForSeconds: 1.99 }), { body: true, nameplate: false }, 'and the body lies there')
  assert.deepEqual(layoutCorpse({ dead: true, monster, deadForSeconds: 2 }), { body: false, nameplate: false }, 'until the time is up')
  assert.deepEqual(layoutCorpse({ dead: true, monster, deadForSeconds: 600 }), { body: false, nameplate: false }, 'and it stays gone')
  assert.deepEqual(layoutCorpse({ dead: true, monster }), { body: true, nameplate: false }, 'a death with no time yet is just dead')
  // A monster that is alive is whole, whatever it was told of an earlier death.
  assert.deepEqual(layoutCorpse({ dead: false, monster, deadForSeconds: 50 }), { body: true, nameplate: true })
})

test('a player\'s champion is no corpse: dead for as long as you like, it keeps its body and its place', () => {
  assert.deepEqual(layoutCorpse({ dead: true, deadForSeconds: 600 }), { body: true, nameplate: true })
  assert.deepEqual(layoutCorpse({ dead: true, deadForSeconds: 0 }), { body: true, nameplate: true })
  assert.deepEqual(layoutCorpse({ dead: false }), { body: true, nameplate: true })
})

// ---------------------------------------------------------------------------- in a game

const grunt = defineMonster({
  id: 't-cp-grunt',
  name: 'Corpse Grunt',
  base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 0, deaggroRange: 300, respawnTicks: 300 },
})
const slayer = defineChampion({ ...brawler, id: 't-cp-slayer', base: { ...brawler.base, attackDamage: 5000 }, abilities: [] })

// The monster (10) is beside Ann (1), whose first hit kills it, and who is the only other character.
function game(): ClientGameState {
  const state = new ClientGameState()
  state.simulator.addMonster(10, grunt, { x: 600, y: 600 })
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 650, y: 600 }, slayer, 1)
  state.setLocalCharacterId(1)
  state.simulator.addOrder(1, { id: '1:1', seq: 1, tick: 2, type: 'attack', targetId: 10 })
  for (let tick = 1; tick <= 60; tick += 1) state.simulator.advanceTo(tick)
  // Tick 60 is now, as far as the page is told, and `now` in milliseconds from there is a second a 1000.
  state.setServerTick(60, 0)
  return state
}
const find = (characters: RenderedCharacter[], id: number): RenderedCharacter => characters.find((character) => character.id === id) as RenderedCharacter

test('the page says how long a monster has been dead, from the tick it died on, and nothing for what is alive', () => {
  const state = game()
  const now = state.getCharacters(0)
  assert.equal(find(now, 10).dead, true)
  const deathTick = state.simulator.at(60).get(10)?.getDeathTick() as number
  assert.ok(deathTick >= 2 && deathTick <= 3, `it died as the attack landed: ${deathTick}`)
  assert.ok(Math.abs((find(now, 10).deadForSeconds as number) - (60 - deathTick) / 60) < 1e-9)
  assert.equal(find(now, 1).deadForSeconds, undefined, 'Ann is alive')
  // A second later it has been dead a second longer.
  const later = find(state.getCharacters(1000), 10).deadForSeconds as number
  assert.ok(Math.abs(later - ((60 - deathTick) / 60 + 1)) < 1e-9, `${later}`)
})

test('the layer takes a dead monster\'s nameplate away at once and its body after a couple of seconds, and brings both back when it respawns', () => {
  const state = game()
  const layer = new CharacterLayer(new Map())
  // The monster was added first, so its body and its nameplate are the layer's first, and Ann's the second.
  const shown = (now: number): Array<[boolean, boolean]> => {
    layer.update(state.getCharacters(now), 1, undefined, now)
    return [0, 1].map((index): [boolean, boolean] => [layer.view.children[index].visible, layer.overlay.children[index].visible])
  }
  // Just dead: the body is lying there, with no name or bars over it. Ann has both.
  assert.deepEqual(shown(0), [[true, false], [true, true]])
  // A second on, the same.
  assert.deepEqual(shown(1000), [[true, false], [true, true]])
  // Past two seconds from when it died, it is gone entirely.
  assert.deepEqual(shown(1500), [[false, false], [true, true]])
  assert.deepEqual(shown(4000), [[false, false], [true, true]], 'and stays gone')
  // It respawns 300 ticks after it died (5 seconds): it is a monster again, with both.
  assert.deepEqual(shown(5500), [[true, true], [true, true]])
  assert.equal(find(state.getCharacters(5500), 10).dead, false)
  assert.equal(find(state.getCharacters(5500), 10).deadForSeconds, undefined)
})

test('a dead player\'s champion keeps its body and nameplate however long it is dead', () => {
  const state = game()
  const layer = new CharacterLayer(new Map())
  const characters = state.getCharacters(0).map((character) => (character.id === 1 ? { ...character, dead: true, deadForSeconds: 600 } : character))
  layer.update(characters, 1, undefined, 0)
  assert.deepEqual([layer.view.children[1].visible, layer.overlay.children[1].visible], [true, true])
})
