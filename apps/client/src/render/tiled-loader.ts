import {
  dirname,
  flattenLayers,
  parseTiledMap,
  parseTiledTileset,
  resolveAssetPath,
  type ImageLayer,
  type TiledMap,
  type Tileset,
} from '../../../../packages/shared/src/index.ts'
import { tilesetFromXml } from './tiled-xml.ts'

// Finds a file by its path from the folder the maps are in, giving its address, or nothing.
export type AssetResolver = (path: string) => string | undefined

// A tileset with its pictures loaded.
export type LoadedTileset = {
  tileset: Tileset
  // The tileset's first global tile ID, which is what finds the tileset a tile is in.
  firstgid: number
  // The picture a tileset made of one sheet is cut from.
  image?: HTMLImageElement
  // The picture of each tile of a tileset that is a collection of pictures, by tile.
  tileImages: Map<number, HTMLImageElement>
}

export type LoadedTiledMap = {
  map: TiledMap
  // Every tileset the map uses, in the order of their first IDs.
  tilesets: LoadedTileset[]
  imageLayers: Map<ImageLayer, HTMLImageElement>
}

// Reads a map and everything it needs to be drawn: its tilesets (embedded, or in files of their own),
// and the pictures of those and of its picture layers. It says which file is missing if one is.
export async function loadTiledMap(mapPath: string, resolve: AssetResolver): Promise<LoadedTiledMap> {
  const fetchFile = async (path: string, usedBy: string): Promise<Response> => {
    const url = resolve(path)
    if (!url) throw new Error(`${usedBy} uses "${path}", which is not in res/maps. Copy it there.`)
    const response = await fetch(url)
    // A dev server answers for a file that is not there with its own page, not an error.
    if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
      throw new Error(`${usedBy} uses "${path}", which could not be loaded (${response.status}). Is it in res/maps?`)
    }
    return response
  }
  const json = async (path: string, usedBy: string): Promise<unknown> => (await fetchFile(path, usedBy)).json()
  const images = new Map<string, Promise<HTMLImageElement>>()
  const image = (path: string, usedBy: string): Promise<HTMLImageElement> => {
    let loading = images.get(path)
    if (!loading) {
      const url = resolve(path)
      if (!url) return Promise.reject(new Error(`${usedBy} uses "${path}", which is not in res/maps.`))
      loading = (async () => {
        const element = new Image()
        element.src = url
        await element.decode().catch(() => {
          throw new Error(`"${path}" is not a picture that can be read.`)
        })
        return element
      })()
      images.set(path, loading)
    }
    return loading
  }

  const map = parseTiledMap(await json(mapPath, 'The game'))
  const mapDirectory = dirname(mapPath)

  const tilesets = await Promise.all(map.tilesets.map(async (entry): Promise<LoadedTileset> => {
    let tileset: Tileset
    let directory = mapDirectory
    let usedBy = `The map "${mapPath}"`
    if ('source' in entry && !('tilewidth' in entry)) {
      const path = resolveAssetPath(mapDirectory, entry.source)
      // Tilesets are saved as XML (.tsx) by default, and can be JSON (.tsj) too.
      let body: unknown
      if (path.endsWith('.tsx')) body = tilesetFromXml(await (await fetchFile(path, usedBy)).text())
      else if (path.endsWith('.tsj') || path.endsWith('.json')) body = await json(path, usedBy)
      else throw new Error(`The tileset "${entry.source}" is not a .tsx or .tsj file.`)
      tileset = { ...parseTiledTileset(body), firstgid: entry.firstgid, source: path }
      directory = dirname(path)
      usedBy = `The tileset "${path}"`
    } else {
      tileset = entry as Tileset
    }
    const loaded: LoadedTileset = { tileset, firstgid: tileset.firstgid, tileImages: new Map() }
    if (tileset.image) {
      loaded.image = await image(resolveAssetPath(directory, tileset.image), usedBy)
    } else {
      await Promise.all((tileset.tiles ?? []).map(async (tile) => {
        if (tile.image) loaded.tileImages.set(tile.id, await image(resolveAssetPath(directory, tile.image), usedBy))
      }))
    }
    return loaded
  }))
  tilesets.sort((left, right) => left.tileset.firstgid - right.tileset.firstgid)

  const imageLayers = new Map<ImageLayer, HTMLImageElement>()
  await Promise.all(flattenLayers(map.layers).map(async ({ layer }) => {
    if (layer.type === 'imagelayer' && layer.image) {
      imageLayers.set(layer, await image(resolveAssetPath(mapDirectory, layer.image), `The layer "${layer.name}"`))
    }
  }))

  return { map, tilesets, imageLayers }
}
