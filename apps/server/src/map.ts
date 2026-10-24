import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseTiledMap, readMapLayout, type MapLayout } from '../../../packages/shared/src/index.js'

// Where the maps are: res/maps, or the folder GAME_MAPS_DIR names.
export const MAPS_DIRECTORY = new URL('../../../res/maps/', import.meta.url)

// A map is picked by the name of its file without the extension, which is made of letters, digits, `_` and `-`
// alone, so what a page sends can never be a path to anything else.
export function isMapId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
}

// The file of the map with this id: <id>.tmj, or <id>.json if it was saved as that.
export function findMapFile(id: string, directory: URL = MAPS_DIRECTORY): URL | undefined {
  if (!isMapId(id)) return undefined
  return [`${id}.tmj`, `${id}.json`].map((candidate) => new URL(candidate, directory)).find((candidate) => existsSync(candidate))
}

// What is in a map file, as the game plays on it. It throws what is wrong with the file, which is everything wrong
// with the map if it cannot be played on (see `readMapLayout`).
export function readMapFile(file: URL): MapLayout {
  return readMapLayout(parseTiledMap(JSON.parse(readFileSync(file, 'utf-8'))))
}

// The arena, walls and spawn points of the map with this id, read from its file as it is now, so one changed in Tiled
// since the server started is the one played on. A map that is missing or cannot be played on is refused with
// the reason, and where its file is.
export function loadMapLayout(id: string, directory: URL = MAPS_DIRECTORY): MapLayout {
  const file = findMapFile(id, directory)
  if (!file) throw new Error(`There is no map called ${id}.tmj in ${fileURLToPath(directory)}.`)
  try {
    return readMapFile(file)
  } catch (error) {
    throw new Error(`${fileURLToPath(file)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
