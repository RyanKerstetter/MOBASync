import { GAME_ART_SCALE, GAME_MAX_CHAMPION_RADIUS, GAME_MAX_PLAYERS } from './constants.js'
import type { HillArea, Vector2 } from './index.js'
import { monsters } from './monsters.js'
import type { SpawnSlots } from './spawns.js'
import { Terrain, type Rect } from './terrain.js'
import { getCore, turretId, turrets, turretTiers } from './turrets.js'
import { flattenLayers, getProperty, mapWorldScale, type TiledMap, type TiledObject } from './tiled.js'

// What the game takes from a map made in Tiled besides how it looks, found by the class of the
// objects in it:
//
// - one `arena`: a rectangle over the ground champions walk on. Its top left corner is where the
//   world begins (0, 0), and its size is the arena's, once drawn.
// - any number of `wall` rectangles, which champions cannot walk through and find their way
//   round. They are only for walking: shots, dashes and the rest go over them. A wall the arena does
//   not reach is left out. Other shapes than a plain rectangle are not read yet.
// - `spawn` points, each with a `team-name` (the slot of spawn points it is in, from 1) and a
//   `spawn-number` (which of the slot's points it is, from 1). The biggest team in a game starts at
//   slot 1, the next biggest at slot 2, and so on, with its players at the slot's points in order
//   (see `assignSpawns`). A map has as many slots as it has teams to start, in order from 1 with none
//   skipped, and as many points in each as the team of that rank can have players: that is what the
//   map allows, and what a lobby's teams are checked against (see `teamSetupProblem`). A map with
//   `spawnPointsNeeded` points in every slot allows every way the players can split into teams.
// - the map's own properties `title` and `description`, which the lobby shows when picking it.
// - for the game modes, which a map need not have anything for (a mode its map has nothing for cannot
//   be picked for it):
//   - at most one `hill`, an ellipse or rectangle where king of the hill is fought over;
//   - `ctf-flag` points, each with the `team-name` of the slot of spawn points whose base it is: slot 1
//     is where the biggest team starts, and so on, as for spawn points. Capture the flag is for two
//     teams, so it uses the flags of slots 1 and 2.
// - `monster-spawn` points, each with a `monster-type` property naming one of the game's monsters (see monsters.ts).
//   A monster is in the game from the start, at its point, which is its home: where it goes back to after a fight,
//   and comes back to when it respawns. They are in every mode, and a map with none is a map with none. A point for a
//   monster the game does not have (yet) is left out, and said so in the layout's `warnings`, so a map can keep
//   places for monsters still to come.
// - `turret` points, each with a `team-name` (the slot of spawn points whose team it belongs to: the team that starts there has the
//   turret, and every other team is its enemy) and a `turret-tier` (which of the game's tiers of turret it is: see turrets.ts, where
//   each tier's health, damage, resistance, range and the rest are). A turret stands where its point is for the whole game, is in every
//   mode, and is left out of a game whose slot has no team (a map for two teams played by one has no turret for the second). A point
//   for a tier the game does not have (yet) is left out, and said so in `warnings`, like a monster's.
// - `core` points, each with the `team-name` of the slot of spawn points whose base it is the heart of, like a flag: slot 1 is where the
//   biggest team starts, and so on. Core destruction is for two teams, so it uses the cores of slots 1 and 2, and a map that has both can
//   be played in it (see modes.ts). A core is a turret (see turrets.ts), so it is solid and needs room for its size clear of the walls and the arena's edge, and a
//   way to it from the spawn points. The core is in a game of that mode only: in the others its point is not used.
// - `shop` rectangles, each with the `team-name` of the slot of spawn points whose team shops there: a champion can buy and sell items only while
//   it stands in a shop of its team (see shops.ts). A map with no shops can be shopped in from anywhere; a map with any needs one for every slot that
//   has spawn points, or a team would have nowhere to buy, and is refused without.
// - A turret or a core is solid, so a spawn point has to be clear of each by its size and the widest champion's, and each has to be clear
//   of the others by their sizes, or the map is refused (a champion would start inside one, or two would stand in each other). A point too close to a wall or the arena's edge is refused with the nearest place that clears them.
const ARENA_CLASS = 'arena'
const WALL_CLASS = 'wall'
const SPAWN_CLASS = 'spawn'
const HILL_CLASS = 'hill'
const FLAG_CLASS = 'ctf-flag'
const MONSTER_CLASS = 'monster-spawn'
const MONSTER_PROPERTY = 'monster-type'
// The competitive map spells it `monester-type`, so that is read too, after the right spelling.
const MONSTER_PROPERTY_MISSPELT = 'monester-type'
const CORE_CLASS = 'core'
const SHOP_CLASS = 'shop'
const TURRET_CLASS = 'turret'
const TURRET_TIER_PROPERTY = 'turret-tier'
const SLOT_PROPERTY = 'team-name'
const NUMBER_PROPERTY = 'spawn-number'

export type MapRect = { x: number; y: number; width: number; height: number }

// A monster the map has: which one, and where it starts, in whole world units.
export type MapMonster = { monster: string; at: Vector2 }

// A shop the map has: the slot of spawn points whose team shops there (from 1) and the rectangle, in whole world units.
export type MapShop = { slot: number; x: number; y: number; width: number; height: number }

// A turret the map has: which tier, which slot of spawn points it is the team of (from 1), and where it stands, in whole world units.
export type MapTurret = { tier: number; slot: number; at: Vector2 }

export interface MapLayout {
  // What the lobby calls the map, and a line about it, if the map says (its `title` and `description` properties).
  title?: string
  description?: string
  // The arena, in the map's own pixels: where it is in the map, and so where the world's origin is.
  arenaRect: MapRect
  // The ground, in world units from the arena's top left corner: the arena and the walls in it.
  terrain: Terrain
  // Where each slot of spawn points is in the world (in whole world units, so every peer starts
  // champions in exactly the same places).
  spawns: SpawnSlots
  // Where king of the hill is fought over, in world units, if the map has a hill.
  hill?: HillArea
  // Where the flag of each slot is at home, in whole world units: index 0 is slot 1, and a slot the map
  // has no flag for is undefined.
  flags: readonly (Vector2 | undefined)[]
  // The monsters the game starts with, in the order the map lists them.
  monsters: readonly MapMonster[]
  // The turrets the game starts with, in the order the map lists them.
  turrets: readonly MapTurret[]
  // Where the core of each slot of spawn points stands, in whole world units: index 0 is slot 1, and a slot the map has no core for is
  // undefined.
  cores: readonly (Vector2 | undefined)[]
  // The shops, in the order the map lists them (see shops.ts). None means the whole map is a shop.
  shops: readonly MapShop[]
  // What on the map was left out, though it can be played on without it: a point for a monster the game does not have.
  warnings: readonly string[]
}

type Spawn = { at: Vector2; label: string }

// Reads the arena, walls and spawn points of a map, or says everything that is wrong with it if it
// cannot be played on, so all of it can be put right at once.
export function readMapLayout(map: TiledMap): MapLayout {
  const problems: string[] = []
  const scale = mapWorldScale(map, GAME_ART_SCALE)
  const objects = flattenLayers(map.layers).flatMap(({ layer, offsetx, offsety }) =>
    layer.type === 'objectgroup'
      ? layer.objects.map((object) => ({ object, x: object.x + offsetx, y: object.y + offsety }))
      : [])
  const ofClass = (name: string) => objects.filter(({ object }) => (object.class ?? object.type) === name)

  // Without an arena there is nowhere to measure anything from, so that is put right first.
  const arenaRect = readArena(ofClass(ARENA_CLASS), problems)
  if (!arenaRect) throw cannotBePlayedOn(problems)
  const width = Math.round(arenaRect.width * scale)
  const height = Math.round(arenaRect.height * scale)
  // Measured from the arena's corner, in whole world units.
  const inWorld = (x: number, y: number): Vector2 => ({
    x: Math.round((x - arenaRect.x) * scale),
    y: Math.round((y - arenaRect.y) * scale),
  })

  const walls: Rect[] = []
  for (const { object, x, y } of ofClass(WALL_CLASS)) {
    const label = object.name || `wall object ${object.id}`
    if (!isPlainRectangle(object)) {
      problems.push(`${label} is not a plain rectangle (walls cannot be rotated, or any other shape, yet).`)
      continue
    }
    const topLeft = inWorld(x, y)
    const bottomRight = inWorld(x + (object.width ?? 0), y + (object.height ?? 0))
    if (bottomRight.x <= 0 || bottomRight.y <= 0 || topLeft.x >= width || topLeft.y >= height) continue
    walls.push({ x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y })
  }
  const terrain = new Terrain({ width, height }, walls)

  const found = new Map<number, Map<number, Spawn>>()
  for (const { object, x, y } of ofClass(SPAWN_CLASS)) {
    const label = object.name || `spawn object ${object.id}`
    const slot = getProperty(object.properties, SLOT_PROPERTY)
    const number = getProperty(object.properties, NUMBER_PROPERTY)
    if (!object.point) {
      problems.push(`${label} is not a point (make it with Tiled's Insert Point tool).`)
    } else if (!isWhole(slot, 1, GAME_MAX_PLAYERS)) {
      problems.push(`${label} needs a ${SLOT_PROPERTY} from 1 to ${GAME_MAX_PLAYERS}.`)
    } else if (!isWhole(number, 1, Infinity)) {
      problems.push(`${label} needs a ${NUMBER_PROPERTY} of 1 or more.`)
    } else if (found.get(slot)?.has(number)) {
      problems.push(`${label} has the same ${NUMBER_PROPERTY} (${number}) as another point in slot ${slot}.`)
    } else {
      const at = inWorld(x, y)
      if (at.x < 0 || at.y < 0 || at.x > width || at.y > height) {
        problems.push(`${label} is outside the arena.`)
      } else if (!standable(terrain, at)) {
        problems.push(`${label} is too close to a wall or the arena's edge: a champion would start inside it.`)
      } else {
        found.set(slot, (found.get(slot) ?? new Map()).set(number, { at, label }))
      }
    }
  }

  const slots: Spawn[][] = []
  for (let slot = 1; slot <= GAME_MAX_PLAYERS; slot += 1) {
    const points = found.get(slot) ?? new Map<number, Spawn>()
    const inOrder: Spawn[] = []
    while (points.has(inOrder.length + 1)) inOrder.push(points.get(inOrder.length + 1) as Spawn)
    if (inOrder.length < points.size) {
      problems.push(`Slot ${slot}'s ${SPAWN_CLASS} points must be numbered 1, 2, 3 ... with none missing.`)
    }
    slots.push(inOrder)
  }
  // The slots in use are the first ones, with none skipped: the second biggest team starts at slot 2 whatever
  // is in slot 3.
  let used = slots.length
  while (used > 0 && slots[used - 1].length === 0) used -= 1
  const skipped = slots.slice(0, used).findIndex((points) => points.length === 0)
  if (used === 0) {
    problems.push(`It has no ${SPAWN_CLASS} points: a team has nowhere to start (add points of class "${SPAWN_CLASS}", with a ${SLOT_PROPERTY} and a ${NUMBER_PROPERTY}).`)
  } else if (skipped >= 0) {
    problems.push(`Slot ${skipped + 1} has no ${SPAWN_CLASS} points but slot ${used} has: slots are used in order from 1, since the biggest team starts at slot 1, the next at slot 2, and so on.`)
  }
  const spawns: Vector2[][] = slots.slice(0, used).map((points) => points.map((spawn) => spawn.at))
  const placed: Spawn[] = slots.slice(0, used).flat()

  const shops: MapShop[] = []
  for (const { object, x, y } of ofClass(SHOP_CLASS)) {
    const label = object.name || `shop object ${object.id}`
    const slot = getProperty(object.properties, SLOT_PROPERTY)
    if (!isPlainRectangle(object)) {
      problems.push(`${label} is not a plain rectangle (a shop cannot be rotated, or any other shape).`)
    } else if (!isWhole(slot, 1, GAME_MAX_PLAYERS)) {
      problems.push(`${label} needs a ${SLOT_PROPERTY} from 1 to ${GAME_MAX_PLAYERS}: the slot of spawn points whose team shops there.`)
    } else {
      const topLeft = inWorld(x, y)
      const bottomRight = inWorld(x + (object.width ?? 0), y + (object.height ?? 0))
      if (bottomRight.x <= 0 || bottomRight.y <= 0 || topLeft.x >= width || topLeft.y >= height) {
        problems.push(`${label} is outside the arena.`)
      } else {
        shops.push({ slot, x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y })
      }
    }
  }
  // A map with shops has one for every team that can start on it: one with none for a slot would leave that team nowhere to buy.
  if (shops.length > 0) {
    for (let slot = 1; slot <= used; slot += 1) {
      if (shops.some((shop) => shop.slot === slot)) continue
      problems.push(`Slot ${slot} has spawn points but no shop, so its team could never buy: give a shop the ${SLOT_PROPERTY} ${slot}.`)
    }
  }

  const hills = ofClass(HILL_CLASS)
  let hill: HillArea | undefined
  if (hills.length > 1) {
    problems.push(`It has ${hills.length} objects of class "${HILL_CLASS}", and needs at most one.`)
  } else if (hills.length === 1) {
    hill = readHill(hills[0], inWorld, { width, height }, problems)
  }

  const flagPoints = new Map<number, Spawn>()
  for (const { object, x, y } of ofClass(FLAG_CLASS)) {
    const label = object.name || `flag object ${object.id}`
    const slot = getProperty(object.properties, SLOT_PROPERTY)
    if (!object.point) {
      problems.push(`${label} is not a point (make it with Tiled's Insert Point tool).`)
    } else if (!isWhole(slot, 1, GAME_MAX_PLAYERS)) {
      problems.push(`${label} needs a ${SLOT_PROPERTY} from 1 to ${GAME_MAX_PLAYERS}.`)
    } else if (flagPoints.has(slot)) {
      problems.push(`${label} has the same ${SLOT_PROPERTY} (${slot}) as another flag.`)
    } else {
      const at = inWorld(x, y)
      if (at.x < 0 || at.y < 0 || at.x > width || at.y > height) {
        problems.push(`${label} is outside the arena.`)
      } else if (!standable(terrain, at)) {
        problems.push(`${label} is too close to a wall or the arena's edge: a champion could not walk up to it.`)
      } else {
        flagPoints.set(slot, { at, label })
      }
    }
  }
  const camps: MapMonster[] = []
  const warnings: string[] = []
  const known = [...monsters.keys()].join(', ')
  for (const { object, x, y } of ofClass(MONSTER_CLASS)) {
    const label = object.name || `monster object ${object.id}`
    const kind = getProperty(object.properties, MONSTER_PROPERTY) ?? getProperty(object.properties, MONSTER_PROPERTY_MISSPELT)
    const body = typeof kind === 'string' ? monsters.get(kind) : undefined
    if (!object.point) {
      problems.push(`${label} is not a point (make it with Tiled's Insert Point tool).`)
    } else if (typeof kind !== 'string' || !kind.trim()) {
      problems.push(`${label} needs a ${MONSTER_PROPERTY} property that names a monster (${known}).`)
    } else if (!body) {
      warnings.push(`${label} is for a monster called "${kind}", which the game does not have (only ${known}), so it is left out.`)
    } else {
      const at = inWorld(x, y)
      if (at.x < 0 || at.y < 0 || at.x > width || at.y > height) {
        problems.push(`${label} is outside the arena.`)
      } else if (!roomFor(terrain, at, body.champion.radius)) {
        problems.push(`${label} is too close to a wall or the arena's edge: a ${body.name} would start inside it.`)
      } else {
        camps.push({ monster: body.id, at })
      }
    }
  }

  // Where, in the map's own pixels, a body of this radius fits nearest to a place it does not, for the message that says so, and how far
  // apart two places are in the same pixels. A map is made in pixels, so that is what it is told in.
  const nearestFit = (at: Vector2, radius: number): string => {
    const fit = terrain.resolve(at, radius)
    const pixel = (value: number, origin: number): number => Math.round((origin + value / scale) * 10) / 10
    return (
      ` The nearest place that clears the walls and the edge is about (${pixel(fit.x, arenaRect.x)}, ${pixel(fit.y, arenaRect.y)}) in the map's own pixels`
      + ' (keep it clear of the spawn points and the turrets too).'
    )
  }
  const pixels = (units: number): number => Math.round((units / scale) * 10) / 10

  // The turrets and cores that are standing in the ground, which are solid: a champion cannot start inside one.
  const solids: Array<{ label: string; at: Vector2; radius: number }> = []
  const posts: MapTurret[] = []
  const tiers = turretTiers().join(', ')
  for (const { object, x, y } of ofClass(TURRET_CLASS)) {
    const label = object.name || `turret object ${object.id}`
    const slot = getProperty(object.properties, SLOT_PROPERTY)
    const tier = getProperty(object.properties, TURRET_TIER_PROPERTY)
    // The core is a turret too, but a map puts it down with a `core` point: a `turret` point is for the tiers `turretTiers` lists.
    const found = isWhole(tier, 1, Infinity) ? turrets.get(turretId(tier)) : undefined
    const body = found?.core ? undefined : found
    if (!object.point) {
      problems.push(`${label} is not a point (make it with Tiled's Insert Point tool).`)
    } else if (!isWhole(slot, 1, GAME_MAX_PLAYERS)) {
      problems.push(`${label} needs a ${SLOT_PROPERTY} from 1 to ${GAME_MAX_PLAYERS}: the slot of spawn points whose team it belongs to.`)
    } else if (!isWhole(tier, 1, Infinity)) {
      problems.push(`${label} needs a ${TURRET_TIER_PROPERTY} of 1 or more (the game has tiers ${tiers}).`)
    } else if (!body) {
      warnings.push(`${label} is for a tier ${tier} turret, which the game does not have (only tiers ${tiers}), so it is left out.`)
    } else {
      const at = inWorld(x, y)
      if (at.x < 0 || at.y < 0 || at.x > width || at.y > height) {
        problems.push(`${label} is outside the arena.`)
      } else if (!roomFor(terrain, at, body.champion.radius)) {
        problems.push(`${label} is too close to a wall or the arena's edge: a ${body.name} would stand in it.${nearestFit(at, body.champion.radius)}`)
      } else {
        posts.push({ tier, slot, at })
        solids.push({ label, at, radius: body.champion.radius })
      }
    }
  }

  const corePoints = new Map<number, Spawn>()
  const coreBody = getCore()
  for (const { object, x, y } of ofClass(CORE_CLASS)) {
    const label = object.name || `core object ${object.id}`
    const slot = getProperty(object.properties, SLOT_PROPERTY)
    if (!object.point) {
      problems.push(`${label} is not a point (make it with Tiled's Insert Point tool).`)
    } else if (!isWhole(slot, 1, GAME_MAX_PLAYERS)) {
      problems.push(`${label} needs a ${SLOT_PROPERTY} from 1 to ${GAME_MAX_PLAYERS}: the slot of spawn points whose base it is the heart of.`)
    } else if (corePoints.has(slot)) {
      problems.push(`${label} has the same ${SLOT_PROPERTY} (${slot}) as another core.`)
    } else {
      const at = inWorld(x, y)
      if (at.x < 0 || at.y < 0 || at.x > width || at.y > height) {
        problems.push(`${label} is outside the arena.`)
      } else if (!roomFor(terrain, at, coreBody.champion.radius)) {
        problems.push(`${label} is too close to a wall or the arena's edge: the core would stand in it.${nearestFit(at, coreBody.champion.radius)}`)
      } else {
        corePoints.set(slot, { at, label })
        solids.push({ label, at, radius: coreBody.champion.radius })
      }
    }
  }

  // A champion that starts inside a turret or a core would have to be shoved out of it, so a spawn point has to be clear of each, by their
  // sizes and the widest champion's.
  for (const spawn of placed) {
    for (const solid of solids) {
      const need = solid.radius + GAME_MAX_CHAMPION_RADIUS
      const apart = Math.hypot(spawn.at.x - solid.at.x, spawn.at.y - solid.at.y)
      if (apart < need) {
        problems.push(
          `${spawn.label} is too close to ${solid.label}: they are ${pixels(apart)} map pixels apart and need ${Math.ceil((need / scale) * 10) / 10}, `
          + 'or a champion would start inside it.',
        )
      }
    }
  }
  // And one solid cannot stand in another: neither gives way, so two that overlap would stay that way.
  for (let first = 0; first < solids.length; first += 1) {
    for (let second = first + 1; second < solids.length; second += 1) {
      const one = solids[first]
      const other = solids[second]
      const need = one.radius + other.radius
      const apart = Math.hypot(one.at.x - other.at.x, one.at.y - other.at.y)
      if (apart < need) {
        problems.push(
          `${one.label} is too close to ${other.label}: they are ${pixels(apart)} map pixels apart and need ${Math.ceil((need / scale) * 10) / 10}, `
          + 'or they would stand in each other.',
        )
      }
    }
  }

  // The flags and the cores are only worth having if they can be walked to.
  placed.push(...flagPoints.values(), ...corePoints.values())

  // Every spawn point and flag can be walked to from every other, or a team could start walled off.
  const [reference, ...others] = placed
  for (const spawn of others) {
    if (!terrain.path(reference.at, spawn.at, GAME_MAX_CHAMPION_RADIUS)) {
      problems.push(`${spawn.label} cannot be reached from ${reference.label}: walls shut it off.`)
    }
  }

  if (problems.length > 0) throw cannotBePlayedOn(problems)
  const flags = Array.from({ length: Math.max(0, ...flagPoints.keys()) }, (_, index) => flagPoints.get(index + 1)?.at)
  return {
    ...(textProperty(map, 'title') ? { title: textProperty(map, 'title') } : {}),
    ...(textProperty(map, 'description') ? { description: textProperty(map, 'description') } : {}),
    arenaRect,
    terrain,
    spawns,
    flags,
    monsters: camps,
    turrets: posts,
    shops,
    cores: Array.from({ length: Math.max(0, ...corePoints.keys()) }, (_, index) => corePoints.get(index + 1)?.at),
    warnings,
    ...(hill ? { hill } : {}),
  }
}

// The hill, in world units from the arena's corner. It is an ellipse (a circle, if it is as wide as it is
// tall) or a rectangle, and it has to be at least partly in the arena.
function readHill(
  candidate: { object: TiledObject; x: number; y: number },
  inWorld: (x: number, y: number) => Vector2,
  arena: { width: number; height: number },
  problems: string[],
): HillArea | undefined {
  const { object, x, y } = candidate
  const label = object.name || `hill object ${object.id}`
  if (!hasPlainBox(object)) {
    problems.push(`${label} is not a plain ellipse or rectangle (a hill cannot be rotated, or any other shape).`)
    return undefined
  }
  const topLeft = inWorld(x, y)
  const bottomRight = inWorld(x + (object.width ?? 0), y + (object.height ?? 0))
  const area = {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
    ellipse: object.ellipse === true,
  }
  if (area.width <= 0 || area.height <= 0) {
    problems.push(`${label} is too small.`)
    return undefined
  }
  if (bottomRight.x <= 0 || bottomRight.y <= 0 || topLeft.x >= arena.width || topLeft.y >= arena.height) {
    problems.push(`${label} is outside the arena.`)
    return undefined
  }
  return area
}

// A text property of the map itself, with no spaces round it, if it has one that is not empty.
function textProperty(map: TiledMap, name: string): string | undefined {
  const value = getProperty(map.properties, name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function cannotBePlayedOn(problems: readonly string[]): Error {
  return new Error(`The map cannot be played on:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
}

function readArena(
  candidates: ReadonlyArray<{ object: TiledObject; x: number; y: number }>,
  problems: string[],
): MapRect | undefined {
  if (candidates.length !== 1) {
    problems.push(candidates.length === 0
      ? `It has no object of class "${ARENA_CLASS}": a rectangle over the ground champions walk on.`
      : `It has ${candidates.length} objects of class "${ARENA_CLASS}", and needs exactly one.`)
    return undefined
  }
  const { object, x, y } = candidates[0]
  if (!isPlainRectangle(object)) {
    problems.push(`The ${ARENA_CLASS} must be a plain rectangle, not rotated.`)
    return undefined
  }
  return { x, y, width: object.width ?? 0, height: object.height ?? 0 }
}

// A box that is not turned, and has some size: a rectangle or an ellipse (not a point, a line, a shape of
// more corners or a picture).
function hasPlainBox(object: TiledObject): boolean {
  return (object.width ?? 0) > 0
    && (object.height ?? 0) > 0
    && !object.point
    && !object.polygon
    && !object.polyline
    && object.gid === undefined
    && !object.rotation
}

// A rectangle that is not turned, and has some size (not a point, a circle, a line or a picture).
function isPlainRectangle(object: TiledObject): boolean {
  return hasPlainBox(object) && !object.ellipse
}

// Whether the widest champion can stand at the point, with no wall or edge to push it elsewhere.
function standable(terrain: Terrain, point: Vector2): boolean {
  const settled = terrain.resolve(point, GAME_MAX_CHAMPION_RADIUS)
  return settled.x === point.x && settled.y === point.y
}

// Whether a body of this radius can stand at the point, with no wall or edge to push it elsewhere.
function roomFor(terrain: Terrain, point: Vector2, radius: number): boolean {
  const settled = terrain.resolve(point, radius)
  return settled.x === point.x && settled.y === point.y
}

function isWhole(value: unknown, least: number, most: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= least && value <= most
}
