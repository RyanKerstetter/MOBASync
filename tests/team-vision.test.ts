import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientGameState, type RenderedCharacter, type RenderedEntity } from '../apps/client/src/game-state.ts'
import { createTeamVision, TeamVision, visionNameFromSearch } from '../apps/client/src/team-vision.ts'
import {
  createShadowcastVision,
  GAME_MONSTER_TEAM,
  GAME_VISION_RANGE,
  type SightViewer,
  type VisionMask,
  type VisionSystem,
} from '../packages/shared/src/index.ts'
import { brawler, defineMonster } from './fixtures.ts'

// What the page does with what a vision system says: who it looks from, what it leaves out of the frame, what a click can
// pick, and how the darkness is made from the mask. The system in these is a stand-in that sees a square, so they are about
// the page and not about how a system works out what is seen (tests/vision.test.ts).

const LIT = { x: 0, y: 0, width: 400, height: 400 }
const mask: VisionMask = { kind: 'cells', cell: 10, cols: 2, rows: 2, data: new Uint8Array([1, 0, 0, 1]), revision: 3 }

function squareSystem(looks: SightViewer[][] = []): VisionSystem {
  return {
    name: 'square',
    see: (viewers) => {
      looks.push([...viewers])
      return {
        mask,
        canSee: (point) => point.x >= LIT.x && point.y >= LIT.y && point.x < LIT.x + LIT.width && point.y < LIT.y + LIT.height,
      }
    },
  }
}

let nextId = 1
function character(team: number, x: number, y: number, extra: Partial<RenderedCharacter> = {}): RenderedCharacter {
  return { id: nextId++, team, position: { x, y }, dead: false, champion: { radius: 20 }, ...extra } as unknown as RenderedCharacter
}
const entity = (ownerId: number, x: number, y: number, radius = 10): RenderedEntity =>
  ({ ownerId, position: { x, y }, radius }) as unknown as RenderedEntity

const ids = (list: ReadonlyArray<{ id: number }>): number[] => list.map((item) => item.id)

// ---------------------------------------------------------------------------- what is shown

test('the team\'s own champions, and an enemy in the light, are drawn, and an enemy or a monster in the dark is not', () => {
  const me = character(1, 100, 100)
  const mate = character(1, 3000, 3000, { dead: true })
  const near = character(2, 300, 300)
  const far = character(2, 2000, 2000)
  const monster = character(GAME_MONSTER_TEAM, 1500, 100, { monster: {} as RenderedCharacter['monster'] })
  const vision = new TeamVision(squareSystem())
  vision.update([me, mate, near, far, monster], 1)
  assert.deepEqual(ids(vision.visibleCharacters([me, mate, near, far, monster])), [me.id, mate.id, near.id], 'a dead teammate in the dark is still the team\'s')
  assert.equal(vision.mask, mask, 'and the darkness is made from the system\'s mask')
})

test('what is left out of the frame is handed on as unseen, so every character is one or the other and none is lost', () => {
  const me = character(1, 100, 100)
  const near = character(2, 300, 300)
  const far = character(2, 2000, 2000)
  const corpse = character(GAME_MONSTER_TEAM, 1500, 100, { dead: true })
  const everyone = [me, near, far, corpse]
  const vision = new TeamVision(squareSystem())
  vision.update(everyone, 1)
  assert.deepEqual(ids(vision.visibleCharacters(everyone)), [me.id, near.id])
  // The body of a corpse out of sight is kept, to go on lying there, and not made again when it is seen.
  assert.deepEqual(ids(vision.hiddenCharacters(everyone)), [far.id, corpse.id])
  assert.deepEqual([...ids(vision.visibleCharacters(everyone)), ...ids(vision.hiddenCharacters(everyone))].sort(), ids(everyone).sort())

  vision.update(everyone, 1, { reveal: true })
  assert.deepEqual(vision.hiddenCharacters(everyone), [], 'when everything is shown none is hidden')
  new TeamVision(undefined).update(everyone, 1)
  assert.deepEqual(new TeamVision(undefined).hiddenCharacters(everyone), [], 'nor with no system')
})

test('a body is seen if only its edge is in the light', () => {
  const vision = new TeamVision(squareSystem())
  const edge = character(2, 410, 200) // its middle is 10 out of the square, and its radius is 20
  const out = character(2, 430, 200)
  vision.update([character(1, 100, 100), edge, out], 1)
  assert.ok(vision.isVisible(edge))
  assert.ok(!vision.isVisible(out))
})

test('shots and fields of the team are drawn wherever they are, and an enemy\'s only where they are seen', () => {
  const me = character(1, 100, 100)
  const enemy = character(2, 1000, 1000)
  const vision = new TeamVision(squareSystem())
  vision.update([me, enemy], 1)
  const mine = entity(me.id, 2000, 2000)
  const theirsFar = entity(enemy.id, 2000, 2000)
  const theirsNear = entity(enemy.id, 200, 200)
  const grazing = entity(enemy.id, 450, 200, 60)
  assert.deepEqual(vision.visibleEntities([mine, theirsFar, theirsNear, grazing]), [mine, theirsNear, grazing])
})

test('it looks from every living champion of the local team, at the game\'s range, and from no one else', () => {
  const looks: SightViewer[][] = []
  const vision = new TeamVision(squareSystem(looks))
  const characters = [character(1, 100, 100), character(1, 300, 120), character(1, 50, 50, { dead: true }), character(2, 200, 200), character(GAME_MONSTER_TEAM, 10, 10)]
  vision.update(characters, 1)
  assert.deepEqual(looks, [[
    { position: { x: 100, y: 100 }, range: GAME_VISION_RANGE },
    { position: { x: 300, y: 120 }, range: GAME_VISION_RANGE },
  ]], 'two of them: not the dead one, not an enemy, not a monster')
  assert.equal(GAME_VISION_RANGE, 500)
})

// ---------------------------------------------------------------------------- when everything is shown

test('everything is shown, and no darkness drawn, when the team has no one alive, when the debug view is on, with no system, and with no team', () => {
  const dead = character(1, 100, 100, { dead: true })
  const enemy = character(2, 2000, 2000)
  const all = [dead, enemy]
  const alive = [character(1, 100, 100), enemy]

  const vision = new TeamVision(squareSystem())
  vision.update(all, 1)
  assert.deepEqual(ids(vision.visibleCharacters(all)), ids(all), 'a dead team sees the whole game until it is back')
  assert.equal(vision.mask, undefined)

  vision.update(alive, 1, { reveal: true })
  assert.deepEqual(ids(vision.visibleCharacters(alive)), ids(alive), 'the debug view shows it all')
  assert.equal(vision.mask, undefined)
  vision.update(alive, 1)
  assert.deepEqual(ids(vision.visibleCharacters(alive)), [alive[0].id], 'and it is back to dark when it is off')

  const off = new TeamVision(undefined)
  off.update(alive, 1)
  assert.deepEqual(ids(off.visibleCharacters(alive)), ids(alive))
  assert.equal(off.mask, undefined)
  assert.equal(off.name, 'off')

  vision.update(alive, undefined)
  assert.deepEqual(ids(vision.visibleCharacters(alive)), ids(alive), 'no one is the local player yet')
  assert.deepEqual(vision.visibleEntities([entity(enemy.id, 2000, 2000)]).length, 1)
})

// ---------------------------------------------------------------------------- what the address asks for

test('the address picks the system by name, and the default is shadowcasting', () => {
  assert.equal(visionNameFromSearch(''), 'shadowcast')
  assert.equal(visionNameFromSearch('?map=1'), 'shadowcast')
  assert.equal(visionNameFromSearch('?vision='), 'shadowcast')
  assert.equal(visionNameFromSearch('?vision=range'), 'range')
  assert.equal(visionNameFromSearch('?x=1&vision=%20Range%20'), 'range')
  assert.equal(visionNameFromSearch('?vision=OFF'), 'off')
})

test('a vision is made with the system asked for, with none for off, and with the default, said so, for a name it does not have', () => {
  const ground = { width: 800, height: 600, walls: [{ x: 300, y: 200, width: 50, height: 200 }] }
  assert.equal(createTeamVision(ground).name, 'shadowcast')
  assert.equal(createTeamVision(ground, '?vision=range').name, 'range')
  assert.equal(createTeamVision(ground, '?vision=off').name, 'off')
  const warned: string[] = []
  const warn = console.warn
  console.warn = (message: string) => { warned.push(message) }
  try {
    assert.equal(createTeamVision(ground, '?vision=x-ray').name, 'shadowcast')
  } finally {
    console.warn = warn
  }
  assert.match(warned[0] ?? '', /no vision system called "x-ray" \(there are shadowcast, range, and off\), so "shadowcast" is used/)
})

// ---------------------------------------------------------------------------- with a real game

const grunt = defineMonster({
  id: 't-sight-grunt',
  name: 'Sight Grunt',
  base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 300 },
})

function game(): ClientGameState {
  const state = new ClientGameState()
  state.simulator.addMonster(10, grunt, { x: 600, y: 600 })
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 100, y: 100 }, brawler, 1)
  state.simulator.addPlayer(2, 'p2', 'Bob', { x: 900, y: 900 }, brawler, 2)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  return state
}

test('what is not seen cannot be clicked on, aimed at, or picked by Space, and what is can', () => {
  const state = game()
  const vision = new TeamVision(createShadowcastVision(state.getTerrain()))
  state.setSight((character) => vision.isVisible(character))
  const look = (): void => vision.update(state.getCharacters(0), state.getLocalTeam())

  look()
  // Ann is at (100, 100): the monster 707 away and Bob 1131 away are both out of her 500.
  assert.deepEqual(ids(vision.visibleCharacters(state.getCharacters(0))), [1])
  assert.equal(state.getEnemyNear({ x: 600, y: 600 }, 0), undefined, 'the monster is under the pointer, in the dark')
  assert.equal(state.getEnemyNear({ x: 900, y: 900 }, 0), undefined)
  assert.equal(state.getClosestEnemy({ x: 600, y: 600 }, 0), undefined, 'and Space has no one to pick')

  // A teammate close to the monster: the team sees it, so Ann can.
  state.simulator.addPlayer(3, 'p3', 'Cat', { x: 500, y: 560 }, brawler, 1)
  state.simulator.advanceTo(4)
  look()
  assert.deepEqual(ids(vision.visibleCharacters(state.getCharacters(0))).sort(), [1, 10, 3].sort(), 'vision is the team\'s: Cat sees the monster, Bob is still in the dark')
  assert.equal(state.getEnemyNear({ x: 600, y: 600 }, 0)?.id, 10, 'so it can be clicked')
  assert.equal(state.getClosestEnemy({ x: 880, y: 900 }, 0)?.id, 10, 'and it is the one Space finds, as Bob is not seen, though the mouse is on him')
})

test('with no sight asked for, as before, every enemy can be picked', () => {
  const state = game()
  assert.equal(state.getEnemyNear({ x: 600, y: 600 }, 0)?.id, 10)
  assert.equal(state.getEnemyNear({ x: 900, y: 900 }, 0)?.id, 2)
  assert.equal(state.getTerrain(), state.simulator.terrain, 'and the page is given the ground the game is played on')
})

// ---------------------------------------------------------------------------- turrets

test('a turret is the team\'s and always drawn, an enemy turret in the dark is not, and a standing turret is a place the team looks from', () => {
  const looks: SightViewer[][] = []
  const vision = new TeamVision(squareSystem(looks))
  const me = character(1, 100, 100)
  const ownTurret = character(1, 3000, 3000, { turret: { tier: 1, visionRange: 640 } })
  const near = character(2, 300, 300, { turret: { tier: 1, visionRange: 640 } })
  const far = character(2, 2000, 2000, { turret: { tier: 1, visionRange: 640 } })
  const everyone = [me, ownTurret, near, far]
  vision.update(everyone, 1)
  assert.deepEqual(looks, [[
    { position: { x: 100, y: 100 }, range: GAME_VISION_RANGE },
    { position: { x: 3000, y: 3000 }, range: 640 },
  ]], 'the champion as far as a champion sees, the team\'s turret as far as it does, and no enemy turret')
  assert.deepEqual(ids(vision.visibleCharacters(everyone)), [me.id, ownTurret.id, near.id], 'the team\'s turret is drawn in the dark, an enemy\'s only in the light')
  assert.deepEqual(ids(vision.hiddenCharacters(everyone)), [far.id])
})

test('a turret that is destroyed sees nothing', () => {
  const looks: SightViewer[][] = []
  const vision = new TeamVision(squareSystem(looks))
  vision.update([character(1, 100, 100), character(1, 50, 50, { dead: true, turret: { tier: 1, visionRange: 640 } })], 1)
  assert.deepEqual(looks, [[{ position: { x: 100, y: 100 }, range: GAME_VISION_RANGE }]])
})

test('a turret shows what is round it, as far as it sees and no further, and not through a wall, though no champion of the team is near', () => {
  const ground = { width: 2400, height: 1400, walls: [] as Array<{ x: number; y: number; width: number; height: number }> }
  const me = character(1, 100, 100)
  const turret = character(1, 1000, 700, { turret: { tier: 1, visionRange: 600 } })
  const inReach = character(2, 1400, 700)
  const beyond = character(2, 1700, 700)
  const seen = (walls = ground.walls): number[] => {
    const vision = new TeamVision(createShadowcastVision({ ...ground, walls }))
    vision.update([me, turret, inReach, beyond], 1)
    return ids(vision.visibleCharacters([inReach, beyond]))
  }
  assert.deepEqual(seen(), [inReach.id], '400 from the turret is in the light, and 700 from it is not')
  assert.deepEqual(seen([{ x: 1150, y: 0, width: 50, height: 1400 }]), [], 'with a wall between them it is dark')
  // Without the turret, no one of the team is near enough to see either.
  const alone = new TeamVision(createShadowcastVision(ground))
  alone.update([me, inReach, beyond], 1)
  assert.deepEqual(ids(alone.visibleCharacters([inReach, beyond])), [])
})

test('a team whose champions are all dead sees the whole game, whatever turrets it has standing', () => {
  const vision = new TeamVision(squareSystem())
  const dead = character(1, 100, 100, { dead: true })
  const ownTurret = character(1, 50, 50, { turret: { tier: 1 } })
  const enemy = character(2, 2000, 2000)
  vision.update([dead, ownTurret, enemy], 1)
  assert.equal(vision.mask, undefined, 'no darkness')
  assert.deepEqual(ids(vision.visibleCharacters([dead, ownTurret, enemy])), ids([dead, ownTurret, enemy]))
})
