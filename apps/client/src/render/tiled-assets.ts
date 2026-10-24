import { createAssetLookup } from './asset-lookup.ts'

// The files of the game's maps, which are in res/maps (a map, its tilesets, and their pictures). Vite
// finds them here by name and gives each its address, in development and in a build alike, which is
// why the map's own paths for its pictures are looked up and not fetched as they are written.
const PREFIX = '../../../../res/maps/'
const urls = import.meta.glob('../../../../res/maps/**/*.{png,jpg,jpeg,gif,webp,tmj,tsj,json}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>
// Tiled saves tilesets as .tsx by default, and Vite takes a .tsx file for TypeScript and would try to
// compile it if it were fetched. Their text is taken in with the code instead (they are small), and
// handed on as a data address, which is read like any other.
const tilesetTexts = import.meta.glob('../../../../res/maps/**/*.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>
const files: Record<string, string> = {
  ...urls,
  ...Object.fromEntries(Object.entries(tilesetTexts).map(([key, text]) => [key, `data:text/xml;charset=utf-8,${encodeURIComponent(text)}`])),
}

// The address of a file given its path from res/maps (such as "arena.tmj" or "tiles/grass.png"). A path
// that leads out of res/maps is found by the file's name (see `createAssetLookup`).
export const mapAssetUrl = createAssetLookup(files, PREFIX)

// The path of the map with this name: res/maps/<name>.tmj, or <name>.json if it was saved as that.
export function findMapFile(name: string): string | undefined {
  return [`${name}.tmj`, `${name}.json`].find((path) => mapAssetUrl(path) !== undefined)
}
