import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attackEvery,
  Champion,
  champions,
  GAME_MAX_CHAMPION_RADIUS,
  GAME_MONSTER_TEAM,
  GAME_TPS,
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
  base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: ['t-shockwave'],
  ai: { aggroRange: 300, deaggroRange: 450, respawnTicks: 300, abilities: [{ abilityId: 't-shockwave', withinRange: 100 }] },
})
// Slow, and only notices someone who is almost on it.
const slug = defineMonster({
  id: 't-slug',
  name: 'Test Slug',
  base: { maxHp: 600, attackDamage: 20, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 20,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 100, deaggroRange: 400 },
})
// Gives up a long way from home, as fast as the player.
const mule = defineMonster({
  id: 't-mule',
  name: 'Test Mule',
  base: { maxHp: 5000, attackDamage: 5, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 400, deaggroRange: 400 },
})
const slayer = defineChampion({
  id: 't-slayer',
  name: 'Test Slayer',
  base: { maxHp: 1000, attackDamage: 5000, attackSpeed: 1 },
  moveSpeed: 220,
  radius: 18,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: [...brawler.abilities],
})
// Slower than any monster, and hard to kill.
const slowpoke = defineChampion({
  id: 't-slowpoke',
  name: 'Test Slowpoke',
  base: { maxHp: 3000, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 100,
  radius: 18,
  attackRange: 150,
  attackWindupTicks: 0,
  abilities: [...brawler.abilities],
})
const fragile = defineChampion({
  id: 't-fragile',
  name: 'Test Fragile',
  base: { maxHp: 50, attackDamage: 1, attackSpeed: 1 },
  moveSpeed: 150,
  radius: 18,
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
  assert.throws(() => getCharacterChampion('nobody'), /Unknown champion, monster, turret or core "nobody"/)
  assert.throws(() => getMonster('nobody'), /Unknown monster "nobody"/)
  for (const monster of monsters.values()) assert.equal(getMonster(monster.id), monster)
  assert.ok(getMonster('wolf').ai.aggroRange > 0, 'a placeholder wolf to build on, which notices someone near')
  // Every one has a range round its home to keep its interest in, and a bar that takes some time to fill, or it would give up the
  // moment it stepped off its spawn.
  for (const monster of monsters.values()) {
    assert.ok(monster.ai.deaggroRange > 0 && monster.ai.deaggroTicks > 0, `${monster.name} has a range round its home`)
    assert.ok(monster.ai.deaggroRange >= monster.ai.aggroRange, `${monster.name} notices no one further than it will go`)
  }
})

test('a golem is bigger, slower, tougher and hits harder and less often than a slime, and both can be walked away from', () => {
  const slime = getMonster('slime').champion
  const golem = getMonster('golem').champion
  assert.ok(golem.radius > slime.radius && golem.maxHp > slime.maxHp && golem.attackDamage > slime.attackDamage)
  assert.ok(golem.moveSpeed < slime.moveSpeed && golem.attackCooldownTicks > slime.attackCooldownTicks)
  // The champions of the game, not the stand-ins tests register (all of which are called "Test ...").
  const roster = [...champions.values()].filter((champion) => !champion.name.startsWith('Test '))
  assert.ok(roster.length >= 8)
  for (const champion of roster) assert.ok(champion.moveSpeed > Math.max(slime.moveSpeed, golem.moveSpeed), `${champion.name} outruns them`)
  // Its blow reaches past its own body and the body of whoever it hits (the widest champion's).
  assert.ok(golem.attackRange > golem.radius + GAME_MAX_CHAMPION_RADIUS)
})

test('an attack every so many seconds comes round again on that very tick, however the seconds divide', () => {
  for (let ticks = 1; ticks <= 600; ticks += 1) {
    const body = new Champion({
      id: 't-timed',
      name: 'Timed',
      base: { maxHp: 100, attackDamage: 1, attackSpeed: attackEvery(ticks / GAME_TPS) },
      moveSpeed: 100,
      radius: 20,
      attackRange: 60,
      attackWindupTicks: 0,
      abilities: [],
    })
    assert.equal(body.attackCooldownTicks, ticks, `every ${ticks} ticks`)
  }
})

for (const id of ['slime', 'golem']) {
  test(`a ${id} lets a player be until it is hurt, and then goes after them and hits them for its damage, once a cooldown`, () => {
    const monster = getMonster(id)
    const { attackDamage, attackCooldownTicks, attackRange } = monster.champion
    // A player right beside it, who does nothing, is not noticed however long they stand there.
    const beside = withPlayer(camp(monster), home(attackRange - 10), slowpoke)
    play(beside, 300)
    assert.deepEqual(at(beside, 300, MONSTER)?.getAi(), { mode: 'idle' })
    assert.deepEqual(at(beside, 300, MONSTER)?.getPosition(), home())
    assert.equal(at(beside, 300, PLAYER)?.getHealth(), slowpoke.maxHp)

    // One who hits it from 140 away, which is within the player's reach and beyond its own, is gone after.
    const hit = withPlayer(camp(monster), home(140), slowpoke)
    hit.addOrder(PLAYER, { id: 'hit', seq: 1, tick: 1, type: 'attack', targetId: MONSTER })
    // Long enough to walk up to them, wind up, and hit them four times.
    const last = Math.ceil(140 / monster.champion.moveSpeed * GAME_TPS) + monster.champion.attackWindupTicks + 4 * attackCooldownTicks + 30
    const hits: number[] = []
    let health = slowpoke.maxHp
    play(hit, last, (tick) => {
      const now = at(hit, tick, PLAYER)?.getHealth() ?? 0
      if (now === health) return
      assert.equal(health - now, attackDamage, `each blow does the ${id}'s damage`)
      hits.push(tick)
      health = now
    })
    assert.deepEqual(at(hit, last, MONSTER)?.getAi(), { mode: 'chase', targetId: PLAYER })
    assert.ok(hits.length >= 3, `it went on hitting them (${hits.length})`)
    assert.deepEqual(hits.slice(1).map((tick, index) => tick - hits[index]), hits.slice(1).map(() => attackCooldownTicks), 'one a cooldown')
  })
}

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
  play(simulator, 1100, (tick) => {
    const state = at(simulator, tick, MONSTER)
    if (tick === 100) assert.deepEqual(state?.getAi(), { mode: 'chase', targetId: PLAYER }, 'it went after the one who hit it')
    modes.add(state?.getAi()?.mode ?? 'none')
    lowest = Math.min(lowest, state?.getHealth() ?? 600)
  })
  assert.deepEqual([...modes].sort(), ['chase', 'idle', 'return'])
  assert.ok(lowest <= 400, `it was hurt on the way (${lowest})`)
  // Back at its post, in no hurry, and as good as new.
  assert.equal(at(simulator, 1100, MONSTER)?.getHealth(), 600)
  assert.ok(dist(at(simulator, 1100, MONSTER)?.getPosition(), HOME) <= 30)
  assert.deepEqual(at(simulator, 1100, MONSTER)?.getAi(), { mode: 'idle' })
})

test('a monster that has chased out of its range of home goes on while its bar fills, then gives up, though it is on the player\'s heels', () => {
  const simulator = withPlayer(camp(mule), home(150), slowpoke)
  // The player walks east at its own pace: the mule catches it at once, and goes on hitting it as it goes.
  simulator.addOrder(PLAYER, { id: 'walk', seq: 1, tick: 1, type: 'move', target: { x: 2300, y: HOME.y } })
  let outAt: number | undefined
  let gaveUpAt: number | undefined
  let apart = Infinity
  let farthest = 0
  const filling: number[] = []
  play(simulator, 900, (tick) => {
    const state = at(simulator, tick, MONSTER)
    const ai = state?.getAi()
    farthest = Math.max(farthest, dist(state?.getPosition(), HOME))
    if (outAt === undefined && dist(state?.getPosition(), HOME) > 400) outAt = tick
    if (outAt !== undefined && ai?.mode === 'chase') filling.push(ai.deaggro ?? 0)
    if (gaveUpAt === undefined && ai?.mode === 'return') {
      gaveUpAt = tick
      apart = dist(state?.getPosition(), at(simulator, tick, PLAYER)?.getPosition() ?? HOME)
      assert.equal(ai.deaggro, mule.ai.deaggroTicks, 'the bar is full when it gives up')
    }
  })
  assert.ok(outAt !== undefined && gaveUpAt !== undefined, 'it went out of its range of home, and gave up')
  // Out of it, its bar fills a tick at a time, with the player right there beside it, and it does not give up till it is full.
  assert.deepEqual(filling.slice(0, 5), [1, 2, 3, 4, 5], 'the bar was filling the whole time')
  // (A tick out either way: it is seen out of range a tick before it thinks it is.)
  assert.ok(Math.abs(gaveUpAt - outAt - mule.ai.deaggroTicks) <= 2, `a full bar of ticks after it left its range (${gaveUpAt - outAt})`)
  // The player walks at 100 a second, so it can only have got so far in the three seconds of its bar.
  assert.ok(farthest > 400 && farthest < 400 + 3 * 100 + 40, `out of its range by the bar and no more (${farthest})`)
  assert.ok(apart < 120, `with the player right beside it (${apart})`)
  assert.ok(dist(at(simulator, 900, MONSTER)?.getPosition(), HOME) <= 30, 'and it walked home')
  assert.ok((at(simulator, 900, PLAYER)?.getHealth() ?? 3000) < 3000, 'having been hitting them')
})

test('a shipped monster that is hit and left behind goes home through a full deaggro bar, and not before', () => {
  const archer = champions.get('archer')
  assert.ok(archer, 'the archer is a champion')
  for (const id of ['slime', 'golem']) {
    const monster = getMonster(id)
    const simulator = camp(monster)
    withPlayer(simulator, home(230), archer)
    // It is hit from 230, and the archer, faster than it, runs away.
    simulator.addOrder(PLAYER, { id: 'hit', seq: 1, tick: 1, type: 'attack', targetId: MONSTER })
    simulator.addOrder(PLAYER, { id: 'run', seq: 2, tick: 60, type: 'move', target: { x: 2300, y: HOME.y } })
    let gaveUp = false
    play(simulator, 1500, (tick) => {
      const ai = at(simulator, tick, MONSTER)?.getAi()
      if (!gaveUp && ai?.mode === 'return') {
        gaveUp = true
        assert.equal(ai.deaggro, monster.ai.deaggroTicks, `the ${id} gave up with its bar full, not on the spot`)
      }
    })
    assert.ok(gaveUp, `the ${id} gave up`)
    assert.deepEqual(at(simulator, 1500, MONSTER)?.getAi(), { mode: 'idle' }, `the ${id} is home, with nothing in the bar`)
    assert.equal(at(simulator, 1500, MONSTER)?.getHealth(), monster.champion.maxHp, `and healed`)
  }
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

  const once = defineMonster({ ...grunt.champion, id: 't-once', name: 'Once', abilities: [], ai: { aggroRange: 300 } })
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

// ---------------------------------------------------------------------------- the walk to someone, and the deaggro bar

// Someone who hits from a long way off and is quick: faster than the monster, so it can get away.
const sniper = defineChampion({
  id: 't-sniper',
  name: 'Test Sniper',
  base: { maxHp: 2000, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 400,
  radius: 18,
  attackRange: 500,
  attackWindupTicks: 0,
  abilities: [...brawler.abilities],
})
// Notices someone 300 away (by the walk), loses interest once it is 450 from where it started, and its bar takes a second to fill.
const walker = defineMonster({
  id: 't-walker',
  name: 'Test Walker',
  base: { maxHp: 800, attackDamage: 10, attackSpeed: 1 },
  moveSpeed: 200,
  radius: 20,
  attackRange: 60,
  attackWindupTicks: 0,
  abilities: [],
  ai: { aggroRange: 300, deaggroRange: 450, deaggroTicks: 60 },
})
const WALKER_HOME = { x: 700, y: 300 }

// The monster at (700, 300) and the sniper 400 east of it, shooting at it, with a wall between them that is a long way round (it
// goes from the top of the arena down to y 1000) or with nothing between them.
function across(wall: boolean): Simulator {
  const terrain = new Terrain({ width: 2400, height: 1400 }, wall ? [{ x: 900, y: 0, width: 80, height: 1000 }] : [])
  const simulator = new Simulator(terrain)
  simulator.addMonster(MONSTER, walker, WALKER_HOME)
  simulator.addPlayer(PLAYER, 'p', 'P', { x: 1100, y: 300 }, sniper, 1)
  simulator.addOrder(PLAYER, { id: 'snipe', seq: 1, tick: 1, type: 'attack', targetId: MONSTER })
  return simulator
}

test('a monster hit from across a wall goes after them the long way round, from wherever they hit it, and gives up when it is too far from home', () => {
  const simulator = across(true)
  const modes = new Set<string>()
  let gaveUp: number | undefined
  play(simulator, 700, (tick) => {
    const ai = at(simulator, tick, MONSTER)?.getAi()
    modes.add(ai?.mode ?? 'none')
    if (ai?.mode === 'return') {
      gaveUp ??= tick
      assert.equal(ai.deaggro, 60, 'with its bar full')
    }
    if (tick === 150) {
      assert.ok((at(simulator, tick, MONSTER)?.getHealth() ?? 800) < 800, 'it was hit across the wall: attacks go over walls')
      assert.equal(ai?.mode, 'chase', 'the walk to them is over a thousand, but it went after them all the same')
      assert.ok(dist(at(simulator, tick, MONSTER)?.getPosition(), WALKER_HOME) > 100, 'and is on its way')
    }
  })
  assert.ok(gaveUp !== undefined, 'the walk took it out of its range of home, and it gave up')
  assert.ok(modes.has('return'))
  assert.equal(at(simulator, 700, PLAYER)?.getHealth(), 2000, 'without getting to them')
})

test('a monster hit from where there is no way to them does not go after them, and one hit across open ground does', () => {
  // The sniper is shut in a box of walls, which its shots go over and the monster cannot.
  const terrain = new Terrain({ width: 2400, height: 1400 }, [
    { x: 1000, y: 200, width: 200, height: 20 },
    { x: 1000, y: 380, width: 200, height: 20 },
    { x: 1000, y: 200, width: 20, height: 200 },
    { x: 1180, y: 200, width: 20, height: 200 },
  ])
  const shut = new Simulator(terrain)
  shut.addMonster(MONSTER, walker, WALKER_HOME)
  shut.addPlayer(PLAYER, 'p', 'P', { x: 1100, y: 300 }, sniper, 1)
  shut.addOrder(PLAYER, { id: 'snipe', seq: 1, tick: 1, type: 'attack', targetId: MONSTER })
  const open = across(false)
  play(shut, 150)
  play(open, 150)
  assert.ok((at(shut, 150, MONSTER)?.getHealth() ?? 800) < 800, 'it was hit from inside the box')
  assert.deepEqual(at(shut, 150, MONSTER)?.getAi(), { mode: 'idle' })
  assert.deepEqual(at(shut, 150, MONSTER)?.getPosition(), WALKER_HOME, 'and has not moved')
  assert.equal(at(open, 150, MONSTER)?.getAi()?.mode, 'chase', 'across open ground it goes after them')
})

test('its range of home is the walk home: on the far side of a wall it is a long way out, though it is near home in a line, and it gives up', () => {
  // The monster at (700, 300) and the sniper at (820, 300), with a wall between them that goes from the top of the arena down to y 600,
  // so the way round it is down and back up. Their line is 120, and the walk is over 700.
  const terrain = new Terrain({ width: 2400, height: 1400 }, [{ x: 740, y: 0, width: 40, height: 600 }])
  const simulator = new Simulator(terrain)
  simulator.addMonster(MONSTER, walker, WALKER_HOME)
  simulator.addPlayer(PLAYER, 'p', 'P', { x: 820, y: 300 }, sniper, 1)
  simulator.addOrder(PLAYER, { id: 'snipe', seq: 1, tick: 1, type: 'attack', targetId: MONSTER })
  let farthestInALine = 0
  let gaveUp: number | undefined
  play(simulator, 330, (tick) => {
    const state = at(simulator, tick, MONSTER)
    farthestInALine = Math.max(farthestInALine, dist(state?.getPosition(), WALKER_HOME))
    const ai = state?.getAi()
    if (gaveUp === undefined && ai?.mode === 'return') {
      gaveUp = tick
      assert.equal(ai.deaggro, 60, 'with its bar full')
    }
  })
  assert.ok(farthestInALine < 450, `it was never out of its range of 450 in a line (${farthestInALine.toFixed(0)})`)
  assert.ok(gaveUp !== undefined, 'but the walk home was, and it gave up')
  assert.equal(at(simulator, 330, PLAYER)?.getHealth(), 2000, 'before it got to them')
})

test('a monster that is drawn out of its range of home goes on after them while its bar fills, then gives up and goes home, and settles with the bar empty', () => {
  const simulator = across(false)
  // It is hit, and goes after them; and from tick 40 they run, much faster than it, drawing it out past its range of 450.
  simulator.addOrder(PLAYER, { id: 'run', seq: 2, tick: 40, type: 'move', target: { x: 2300, y: 300 } })
  const bars: number[] = []
  const modes = new Set<string>()
  const targets = new Set<number | undefined>()
  let gaveUp: number | undefined
  play(simulator, 500, (tick) => {
    const ai = at(simulator, tick, MONSTER)?.getAi()
    modes.add(ai?.mode ?? 'none')
    if (ai?.mode === 'chase') {
      targets.add(ai.targetId)
      if (ai.deaggro !== undefined) bars.push(ai.deaggro)
    }
    if (ai?.mode === 'return') {
      gaveUp ??= tick
      assert.equal(ai.deaggro, 60, 'the bar is full when it gives up, and stays full till it is home')
    }
  })
  assert.deepEqual(bars, Array.from({ length: 59 }, (_, index) => index + 1), 'a tick of the bar at a time, from 1, and the 60th tick is the one that fills it')
  assert.deepEqual([...targets], [PLAYER], 'after the same player all that time, though it was out of its range')
  assert.deepEqual([...modes].sort(), ['chase', 'idle', 'return'])
  assert.ok(gaveUp !== undefined && gaveUp > 100, `it gave up at ${gaveUp}`)
  assert.deepEqual(at(simulator, 500, MONSTER)?.getAi(), { mode: 'idle' }, 'at home, settled, with nothing in the bar')
  assert.ok(Math.hypot((at(simulator, 500, MONSTER)?.getPosition()?.x ?? 0) - WALKER_HOME.x, (at(simulator, 500, MONSTER)?.getPosition()?.y ?? 0) - WALKER_HOME.y) <= 30, 'home')
  assert.equal(at(simulator, 500, MONSTER)?.getHealth(), 800, 'and healed')
})

test('a monster whose bar has been filling and then empties because it is back within its range of home is not given up, and the bar goes down a tick at a time', () => {
  const simulator = across(false)
  // They run 200 east and stop, which draws the monster out past its range of 450 (at about tick 134), and then at tick 150 come back
  // to 100 from its home. It turns after them, and is back inside before its bar is full.
  simulator.addOrder(PLAYER, { id: 'run', seq: 2, tick: 40, type: 'move', target: { x: 1300, y: 300 } })
  simulator.addOrder(PLAYER, { id: 'back', seq: 3, tick: 150, type: 'move', target: { x: WALKER_HOME.x + 100, y: 300 } })
  const bars: number[] = []
  const modes = new Set<string>()
  play(simulator, 400, (tick) => {
    const ai = at(simulator, tick, MONSTER)?.getAi()
    modes.add(ai?.mode ?? 'none')
    if (ai?.mode === 'chase') bars.push(ai.deaggro ?? 0)
  })
  const peak = Math.max(...bars)
  assert.ok(peak > 10 && peak < 59, `the bar was part filled (${peak})`)
  assert.ok(!modes.has('return'), 'and it was not given up')
  assert.equal(at(simulator, 400, MONSTER)?.getAi()?.mode, 'chase', 'still after them')
  assert.equal(bars[bars.length - 1], 0, 'and the bar is empty again')
  const down = bars.slice(bars.indexOf(peak))
  assert.deepEqual(down, Array.from({ length: peak + 1 }, (_, index) => peak - index).concat(down.slice(peak + 1)), 'it went down a tick at a time from its peak, to nothing')
})

test('the deaggro bar is in a snapshot, so a client that restores one carries on filling it as the server does', () => {
  const server = across(false)
  server.addOrder(PLAYER, { id: 'run', seq: 2, tick: 40, type: 'move', target: { x: 2300, y: 300 } })
  play(server, 170)
  const bar = at(server, 170, MONSTER)?.getAi()?.deaggro
  assert.ok(bar !== undefined && bar > 10, `part filled (${bar})`)

  const parsed = GameSnapshotSchema.parse(JSON.parse(JSON.stringify(server.snapshot())))
  // What is sent is the frame at the commit tick, which is a little behind, so that is the bar to look for.
  const sentAt = parsed.checkpoint.tick
  const sent = at(server, sentAt, MONSTER)?.getAi()?.deaggro
  assert.ok(sent !== undefined && sent > 10 && sent < bar, `the bar a few ticks back (${sent})`)
  assert.equal(parsed.checkpoint.characters.find((character) => character.characterId === MONSTER)?.ai?.deaggro, sent, 'it is in what is sent')
  const client = new Simulator(new Terrain({ width: 2400, height: 1400 }))
  client.replaceFromSnapshot(parsed)
  assert.equal(client.at(sentAt).getCharacterState(MONSTER)?.ai?.deaggro, sent, 'and the client has it')
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
  play(server, 300)
  client.advanceTo(300)
  assert.deepEqual(plain(client.at(300).toData()), plain(server.at(300).toData()), 'and the two stay the same, through giving up and going home')
})
