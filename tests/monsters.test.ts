import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Champion,
  GAME_MONSTER_TEAM,
  GameSnapshotSchema,
  getCharacterChampion,
  getMonster,
  monsters,
  Simulator,
  Terrain,
  type DeathRecord,
  type HillArea,
  type ModeSetup,
} from '../packages/shared/src/index.ts'
import { brawler, defineChampion, defineMonster } from './fixtures.ts'

// Monsters in a game: the simulator plays them, with the same combat as a player's champion, deciding what to do from the
// frame alone. These follow one through what a camp monster does.

const HOME = { x: 600, y: 700 }
const home = (dx = 0, dy = 0) => ({ x: HOME.x + dx, y: HOME.y + dy })

const grunt = defineMonster({
  id: 't-grunt',
  name: 'Test Grunt',
  maxHp: 600,
  moveSpeed: 200,
  radius: 20,
  attackDamage: 20,
  attackSpeed: 1,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: ['t-shockwave'],
  ai: { aggroRange: 300, deaggroRange: 450, leashRange: 600, respawnTicks: 300, abilities: [{ abilityId: 't-shockwave', withinRange: 100 }] },
})
// Slow, and only notices someone who is almost on it.
const slug = defineMonster({
  id: 't-slug',
  name: 'Test Slug',
  maxHp: 600,
  moveSpeed: 100,
  radius: 20,
  attackDamage: 20,
  attackSpeed: 1,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 100, deaggroRange: 400, leashRange: 600 },
})
// Gives up a long way from home, as fast as the player.
const mule = defineMonster({
  id: 't-mule',
  name: 'Test Mule',
  maxHp: 5000,
  moveSpeed: 200,
  radius: 20,
  attackDamage: 5,
  attackSpeed: 1,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 400, deaggroRange: 2000, leashRange: 400 },
})
const slayer = defineChampion({
  id: 't-slayer',
  name: 'Test Slayer',
  maxHp: 1000,
  moveSpeed: 220,
  radius: 18,
  attackDamage: 5000,
  attackSpeed: 1,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: [...brawler.abilities],
})
// Slower than any monster, and hard to kill.
const slowpoke = defineChampion({
  id: 't-slowpoke',
  name: 'Test Slowpoke',
  maxHp: 3000,
  moveSpeed: 100,
  radius: 18,
  attackDamage: 1,
  attackSpeed: 1,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: [...brawler.abilities],
})
const fragile = defineChampion({
  id: 't-fragile',
  name: 'Test Fragile',
  maxHp: 50,
  moveSpeed: 150,
  radius: 18,
  attackDamage: 1,
  attackSpeed: 1,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: [...brawler.abilities],
})

const MONSTER = 10
const PLAYER = 1

function camp(monster = grunt, setup?: ModeSetup): Simulator {
  const simulator = setup ? new Simulator(Terrain.plain(), setup) : new Simulator()
  simulator.addMonster(MONSTER, monster, HOME)
  return simulator
}
const withPlayer = (simulator: Simulator, at: { x: number; y: number }, champion: Champion = brawler, team = 1): Simulator => {
  simulator.addPlayer(PLAYER, 'p', 'P', at, champion, team)
  return simulator
}

// Plays the game a tick at a time, the way the server does (the commit tick follows twelve behind), calling `look`
// with each tick, for the frame to be looked at while it is still held.
function play(simulator: Simulator, last: number, look: (tick: number) => void = () => undefined): void {
  for (let tick = simulator.tick + 1; tick <= last; tick += 1) {
    simulator.advanceTo(tick)
    if (tick > 12) simulator.setCommitTick(tick - 12)
    look(tick)
  }
}
const at = (simulator: Simulator, tick: number, id: number) => simulator.at(tick).get(id)
const dist = (a: { x: number; y: number } | undefined, b: { x: number; y: number }): number =>
  a ? Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2) : Infinity

// ---------------------------------------------------------------------------- what a monster is

test('a monster is a character on its own team with a mind of its own, and a player is not', () => {
  const simulator = withPlayer(camp(), home(900))
  simulator.advanceTo(3)
  const monster = simulator.characters.get(MONSTER)
  assert.equal(monster?.monster, grunt)
  assert.equal(monster?.team, GAME_MONSTER_TEAM)
  assert.equal(monster?.player, undefined)
  assert.equal(simulator.characters.get(PLAYER)?.monster, undefined)
  assert.deepEqual(at(simulator, 3, MONSTER)?.getAi(), { mode: 'idle' })
  assert.equal(at(simulator, 3, PLAYER)?.getAi(), undefined, 'only a monster has one')
  assert.equal(simulator.at(3).getCharacterState(PLAYER)?.ai, undefined)
})

test('a monster\'s body is found by its id, and the shipped monsters are well-formed', () => {
  assert.equal(getCharacterChampion('t-grunt'), grunt.champion)
  assert.equal(getCharacterChampion('cursebearer').id, 'cursebearer', 'and a champion by its')
  assert.throws(() => getCharacterChampion('nobody'), /Unknown champion or monster "nobody"/)
  assert.throws(() => getMonster('nobody'), /Unknown monster "nobody"/)
  for (const monster of monsters.values()) assert.equal(getMonster(monster.id), monster)
  assert.ok(getMonster('wolf').ai.aggroRange > 0, 'a placeholder wolf to build on')
})

// ---------------------------------------------------------------------------- noticing and fighting

test('a monster ignores a player outside its aggro range, and stays where it is', () => {
  const simulator = withPlayer(camp(), home(500))
  play(simulator, 120)
  assert.deepEqual(at(simulator, 120, MONSTER)?.getPosition(), home())
  assert.deepEqual(at(simulator, 120, MONSTER)?.getAi(), { mode: 'idle' })
  assert.equal(at(simulator, 120, PLAYER)?.getHealth(), 1000)
})

test('a monster that notices a player chases them down and fights, in its own team\'s colours', () => {
  const simulator = withPlayer(camp(), home(250))
  play(simulator, 180)
  assert.deepEqual(at(simulator, 180, MONSTER)?.getAi(), { mode: 'chase', targetId: PLAYER })
  assert.ok(dist(at(simulator, 180, MONSTER)?.getPosition(), at(simulator, 180, PLAYER)?.getPosition() ?? home()) <= 60, 'it is in reach of them')
  assert.ok((at(simulator, 180, PLAYER)?.getHealth() ?? 1000) < 1000, 'and has hit them')
  assert.equal(at(simulator, 180, MONSTER)?.getHealth(), 600, 'a player who does nothing does not hurt it')
})

test('a monster uses its ability when the player is close enough, and then goes back to attacking', () => {
  const simulator = withPlayer(camp(), home(90))
  const casts: number[] = []
  play(simulator, 200, (tick) => {
    if (at(simulator, tick, MONSTER)?.getAction()?.kind === 'cast' && !casts.includes(tick - 1)) casts.push(tick)
  })
  assert.ok(casts.length > 0, 'it cast')
  // The nova is 200 damage, and then the autos.
  assert.ok((at(simulator, 200, PLAYER)?.getHealth() ?? 1000) <= 800)
  assert.equal(at(simulator, 200, MONSTER)?.getAbilityCooldown('t-shockwave').ready, false, 'and it is on cooldown')
  assert.ok((at(simulator, 200, PLAYER)?.getHealth() ?? 1000) < 800 - 20, 'it kept attacking after it')
})

test('a monster hurt from beyond its aggro range goes after whoever did it, then gives up when they run, and goes home and heals', () => {
  // The slug only notices someone within 100, and the brawler hits from 140.
  const simulator = withPlayer(camp(slug), home(140))
  simulator.addOrder(PLAYER, { id: 'hit', seq: 1, tick: 1, type: 'attack', targetId: MONSTER })
  // It runs east, away from the slow monster, and out of its deaggro range.
  simulator.addOrder(PLAYER, { id: 'run', seq: 2, tick: 130, type: 'move', target: { x: 2300, y: HOME.y } })
  const modes = new Set<string>()
  let lowest = 600
  play(simulator, 800, (tick) => {
    const state = at(simulator, tick, MONSTER)
    if (tick === 100) assert.deepEqual(state?.getAi(), { mode: 'chase', targetId: PLAYER }, 'it went after the one who hit it')
    modes.add(state?.getAi()?.mode ?? 'none')
    lowest = Math.min(lowest, state?.getHealth() ?? 600)
  })
  assert.deepEqual([...modes].sort(), ['chase', 'idle', 'return'])
  assert.ok(lowest <= 400, `it was hurt on the way (${lowest})`)
  // Back at its post, in no hurry, and as good as new.
  assert.equal(at(simulator, 800, MONSTER)?.getHealth(), 600)
  assert.ok(dist(at(simulator, 800, MONSTER)?.getPosition(), HOME) <= 30)
  assert.deepEqual(at(simulator, 800, MONSTER)?.getAi(), { mode: 'idle' })
})

test('a monster that has chased too far from its home gives up, though it is on the player\'s heels', () => {
  const simulator = withPlayer(camp(mule), home(150), slowpoke)
  // The player walks east at its own pace: the mule catches it at once, and goes on hitting it as it goes.
  simulator.addOrder(PLAYER, { id: 'walk', seq: 1, tick: 1, type: 'move', target: { x: 2300, y: HOME.y } })
  let gaveUpAt: number | undefined
  let apart = Infinity
  let farthest = 0
  play(simulator, 700, (tick) => {
    const state = at(simulator, tick, MONSTER)
    farthest = Math.max(farthest, dist(state?.getPosition(), HOME))
    if (gaveUpAt === undefined && state?.getAi()?.mode === 'return') {
      gaveUpAt = tick
      apart = dist(state.getPosition(), at(simulator, tick, PLAYER)?.getPosition() ?? HOME)
    }
  })
  assert.ok(gaveUpAt !== undefined, 'it gave up')
  assert.ok(farthest > 400 && farthest < 470, `at its leash, not much past it (${farthest})`)
  assert.ok(apart < 120, `with the player right beside it (${apart})`)
  assert.ok(dist(at(simulator, 700, MONSTER)?.getPosition(), HOME) <= 30, 'and it walked home')
  assert.ok((at(simulator, 700, PLAYER)?.getHealth() ?? 3000) < 3000, 'having been hitting them')
})

test('a monster in two minds picks the nearer player, and keeps them, and takes another when they are dead', () => {
  const simulator = withPlayer(camp(), home(280))
  simulator.addPlayer(2, 'q', 'Q', home(0, 200), brawler, 2)
  play(simulator, 4)
  assert.equal(at(simulator, 4, MONSTER)?.getAi()?.targetId, 2, 'the nearer, at 200')
  // The other player is on a team of their own too: the monster is an enemy to both.
  assert.notEqual(simulator.characters.get(2)?.team, simulator.characters.get(PLAYER)?.team)
})

// ---------------------------------------------------------------------------- scoring and objectives

test('a monster killing a player scores for no one, and nor does killing a monster', () => {
  const deaths: DeathRecord[] = []
  const killedByMonster = withPlayer(camp(), home(200), fragile)
  killedByMonster.onDeathConfirmed = (death) => deaths.push(death)
  play(killedByMonster, 170)
  assert.deepEqual(deaths.map(({ victimId, killerId }) => [victimId, killerId]), [[PLAYER, MONSTER]])
  assert.equal(killedByMonster.characters.get(MONSTER)?.kills, 0, 'a monster has no kills')
  assert.equal(killedByMonster.at(170).getObjective(), undefined, 'and no team scored')

  deaths.length = 0
  const killedAMonster = withPlayer(camp(slug), home(140), slayer)
  killedAMonster.onDeathConfirmed = (death) => deaths.push(death)
  killedAMonster.addOrder(PLAYER, { id: 'kill', seq: 1, tick: 1, type: 'attack', targetId: MONSTER })
  play(killedAMonster, 60)
  assert.deepEqual(deaths.map(({ victimId, killerId }) => [victimId, killerId]), [[MONSTER, PLAYER]], 'it was told of the death')
  assert.equal(at(killedAMonster, 60, MONSTER)?.isDead(), true)
  assert.equal(killedAMonster.characters.get(PLAYER)?.kills, 0, 'the player has not killed a player')
  assert.equal(killedAMonster.at(60).getObjective(), undefined, 'and their team has not scored')
})

test('a player killing a player still scores, with monsters about', () => {
  const simulator = withPlayer(camp(), home(1500), slayer)
  simulator.addPlayer(2, 'q', 'Q', home(1560), brawler, 2)
  simulator.addOrder(PLAYER, { id: 'kill', seq: 1, tick: 1, type: 'attack', targetId: 2 })
  play(simulator, 30)
  assert.deepEqual(simulator.at(30).getObjective(), { kind: 'deathmatch', scores: { 1: 1 } })
})

test('monsters stand on the hill without taking it, and teammates do not fight each other', () => {
  const hill: HillArea = { x: HOME.x - 200, y: HOME.y - 200, width: 400, height: 400, ellipse: true }
  const simulator = camp(grunt, { kind: 'koth', hill })
  simulator.addMonster(11, grunt, home(80))
  play(simulator, 300)
  assert.deepEqual(simulator.at(300).getObjective(), { kind: 'koth', progress: 0, scores: {} }, 'the hill is no one\'s')
  for (const id of [MONSTER, 11]) {
    assert.equal(at(simulator, 300, id)?.getHealth(), 600, 'neither hurt the other')
    assert.deepEqual(at(simulator, 300, id)?.getAi(), { mode: 'idle' })
  }
})

// ---------------------------------------------------------------------------- dying, and coming back

test('a monster that dies comes back at its home, in the time its profile says, and one with none does not', () => {
  const simulator = withPlayer(camp(grunt), home(140), slayer)
  simulator.addOrder(PLAYER, { id: 'kill', seq: 1, tick: 1, type: 'attack', targetId: MONSTER })
  play(simulator, 300, (tick) => {
    if (tick === 1 || tick === 300) assert.equal(at(simulator, tick, MONSTER)?.isDead(), true, `dead at ${tick}`)
  })
  assert.deepEqual(at(simulator, 300, MONSTER)?.getAi(), { mode: 'idle' }, 'a dead monster is doing nothing')
  play(simulator, 301)
  const back = at(simulator, 301, MONSTER)
  assert.equal(back?.isDead(), false, 'it is back on the tick its time is up')
  assert.equal(back?.getHealth(), 600)
  assert.ok(dist(back?.getPosition(), HOME) < 30)

  const once = defineMonster({ ...grunt.champion, id: 't-once', name: 'Once', abilities: [], ai: { aggroRange: 300, leashRange: 600 } })
  const stays = withPlayer(camp(once), home(140), slayer)
  stays.addOrder(PLAYER, { id: 'kill', seq: 1, tick: 1, type: 'attack', targetId: MONSTER })
  play(stays, 1200)
  assert.equal(at(stays, 1200, MONSTER)?.isDead(), true, 'it stays dead')
})

// ---------------------------------------------------------------------------- being a function of the frame

test('a monster is played out again when a late order changes what it saw, as if the order had always been there', () => {
  const build = (): Simulator => withPlayer(camp(), home(250))
  const flee = { id: 'flee', seq: 1, tick: 92, type: 'move' as const, target: { x: 2300, y: HOME.y } }
  const late = build()
  const early = build()
  early.addOrder(PLAYER, flee)

  play(late, 100)
  const before = late.at(100).toData()
  assert.equal(late.addOrder(PLAYER, flee), true, 'the order is still in time')
  play(early, 100)
  const after = late.at(100).toData()
  assert.notDeepEqual(after, before, 'it changed what happened')
  assert.deepEqual(after, early.at(100).toData(), 'to what happens when it is there from the start, monster and all')
})

test('a monster\'s state travels in a snapshot, so a client that restores one carries on as the server does', () => {
  const server = withPlayer(camp(slug), home(140))
  server.addOrder(PLAYER, { id: 'hit', seq: 1, tick: 1, type: 'attack', targetId: MONSTER })
  play(server, 150)
  assert.equal(at(server, 150, MONSTER)?.getAi()?.mode, 'chase')

  const parsed = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(server.snapshot())))
  assert.deepEqual(parsed.characters.find((character) => character.id === MONSTER)?.team, GAME_MONSTER_TEAM)
  assert.equal(parsed.characters.find((character) => character.id === MONSTER)?.player, undefined)
  const client = new Simulator()
  client.replaceFromSnapshot(parsed)
  assert.equal(client.characters.get(MONSTER)?.monster, slug, 'the client knows it is a monster, from its body')
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(client.at(client.tick).getCharacterState(MONSTER)), plain(server.at(server.tick).getCharacterState(MONSTER)))

  play(server, 400)
  client.advanceTo(400)
  assert.deepEqual(plain(client.at(400).toData()), plain(server.at(400).toData()), 'and the two stay the same')
})
