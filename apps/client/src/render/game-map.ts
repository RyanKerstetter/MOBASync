import { GAME_ART_SCALE, mapWorldScale, readMapLayout, type Terrain } from '../../../../packages/shared/src/index.ts'
import { createArenaFloor, type MapView } from './map-view.ts'
import { findMapFile, mapAssetUrl } from './tiled-assets.ts'
import { loadTiledMap } from './tiled-loader.ts'
import { TiledMapView } from './tiled-map-view.ts'

// The map a game is played on, by its id: res/maps/<id>.tmj, made in Tiled. A game whose map the page has no
// file for, or one that cannot be read or played on (see `readMapLayout`), is drawn on the plain arena floor
// instead (of the size the map is, if it is known), with the reason in the console; the server will not
// start a game on a map it cannot play on at all.
//
// `terrain` is the ground this page's copy of the map makes, for checking against the server's: the
// game is played on the server's, so a page that was loaded with another version of the map draws
// something that does not match what happens.
export async function createGameMap(
  mapId: string,
  arena: { width: number; height: number },
): Promise<{ map: MapView; terrain?: Terrain }> {
  const file = findMapFile(mapId)
  if (!file) {
    console.warn(`This page has no map called "${mapId}" (res/maps/${mapId}.tmj), so the plain arena is used instead. The page's maps are bundled when it loads: reload it (npm run dev), or rebuild the client (npm run build:client) if it was built before the map was added.`)
    return { map: createArenaFloor(arena) }
  }
  try {
    const loaded = await loadTiledMap(file, mapAssetUrl)
    // The world begins at the corner of the map's arena, which is where the server puts the spawn points from.
    const { arenaRect, terrain } = readMapLayout(loaded.map)
    return { map: new TiledMapView(loaded, mapWorldScale(loaded.map, GAME_ART_SCALE), arenaRect, terrain.walls), terrain }
  } catch (error) {
    console.warn(`Could not use the map "${file}", so the plain arena is used instead.`, error)
    return { map: createArenaFloor(arena) }
  }
}
