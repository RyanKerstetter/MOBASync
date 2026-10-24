import { readFileSync, readdirSync, statSync } from 'node:fs'
import {
  DEFAULT_MAP_ID,
  summarizeMap,
  unplayableMap,
  type MapSummary,
} from '../../../packages/shared/src/index.js'
import { MAPS_DIRECTORY, findMapFile, readMapFile } from './map.js'

// How long a look at the folder is trusted: the lobby asks for the list on every poll of every player, and
// a map that is saved in Tiled shows up in the list within this long.
const SCAN_INTERVAL_MS = 1000

// Every map the server has: each .tmj in the maps folder (and each .json that is a map, which is how a map saved as
// JSON is told from a tileset), with what it can be played for. A map is only read again when its file has
// changed. One that cannot be played on is listed with what is wrong with it, so the leader sees it is there and
// why it cannot be picked, and the lobby does not lose the map from its list because of a typo.
export class MapCatalog {
  private readonly cache = new Map<string, { stamp: string; summary: MapSummary }>()
  private scannedAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly directory: URL = MAPS_DIRECTORY,
    private readonly now: () => number = Date.now,
  ) {}

  // The maps, by name. Unless `fresh`, the folder is looked at only once in a while.
  list(options: { fresh?: boolean } = {}): MapSummary[] {
    if (options.fresh || this.now() - this.scannedAt >= SCAN_INTERVAL_MS) this.scan()
    return [...this.cache.values()]
      .map(({ summary }) => summary)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  }

  get(id: string, options: { fresh?: boolean } = {}): MapSummary | undefined {
    return this.list(options).find((summary) => summary.id === id)
  }

  // The map a lobby that has not picked one starts on: the game's default if it can be played on, or else the
  // first that can be, or none if the server has no map to play on.
  defaultMapId(): string | undefined {
    const playable = this.list().filter((summary) => !summary.problem)
    return (playable.find((summary) => summary.id === DEFAULT_MAP_ID) ?? playable[0])?.id
  }

  private scan(): void {
    this.scannedAt = this.now()
    let names: string[] = []
    try {
      names = readdirSync(this.directory)
    } catch {
      // No folder, no maps.
    }
    const seen = new Set<string>()
    for (const name of names) {
      const match = /^([A-Za-z0-9_-]+)\.(tmj|json)$/.exec(name)
      if (!match) continue
      const [, id, extension] = match
      // <id>.tmj is the file a map is read from when both are there.
      if (seen.has(id) || (extension === 'json' && names.includes(`${id}.tmj`))) continue
      const file = findMapFile(id, this.directory)
      if (!file) continue
      let stamp: string
      try {
        const stats = statSync(file)
        stamp = `${stats.mtimeMs}:${stats.size}`
      } catch {
        continue
      }
      seen.add(id)
      if (this.cache.get(id)?.stamp === stamp) continue
      try {
        this.cache.set(id, { stamp, summary: summarizeMap(id, readMapFile(file)) })
      } catch (error) {
        if (extension === 'json' && !looksLikeMap(file)) {
          seen.delete(id)
          this.cache.delete(id)
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        this.cache.set(id, { stamp, summary: unplayableMap(id, message) })
      }
    }
    for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id)
  }
}

// A .json file in the folder is a map if it says it has layers, as Tiled's maps do; a tileset or anything else does not.
function looksLikeMap(file: URL): boolean {
  try {
    const json = JSON.parse(readFileSync(file, 'utf-8')) as { layers?: unknown }
    return Array.isArray(json.layers)
  } catch {
    return false
  }
}
