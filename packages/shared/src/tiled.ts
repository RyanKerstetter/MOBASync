import { z } from 'zod'

// The part of Tiled's JSON map format (.tmj, with tilesets as .tsj) that the game reads. It is only
// parsing and plain arithmetic, with nothing to draw with, so the server can read a map with it too
// when it needs the shapes in one. Fields the game does not use are left out and ignored.
// https://doc.mapeditor.org/en/stable/reference/json-map-format/

const PointSchema = z.object({ x: z.number(), y: z.number() })

const PropertySchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  value: z.unknown(),
})
const properties = z.array(PropertySchema).optional()
export type TiledProperty = z.infer<typeof PropertySchema>

const TiledObjectSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  // Tiled 1.9 calls this `class`; before that it was `type`.
  class: z.string().optional(),
  type: z.string().optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  // Degrees, clockwise, about (x, y).
  rotation: z.number().optional(),
  visible: z.boolean().optional(),
  // An object that is a picture of a tile: the tile's global ID, with flip flags in its top bits.
  gid: z.number().optional(),
  ellipse: z.boolean().optional(),
  point: z.boolean().optional(),
  polygon: z.array(PointSchema).optional(),
  polyline: z.array(PointSchema).optional(),
  properties,
})
export type TiledObject = z.infer<typeof TiledObjectSchema>

const layerFields = {
  id: z.number().optional(),
  name: z.string(),
  visible: z.boolean().optional(),
  opacity: z.number().optional(),
  // Pixels the layer is moved by.
  offsetx: z.number().optional(),
  offsety: z.number().optional(),
  properties,
}

const TileChunkSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  data: z.union([z.array(z.number()), z.string()]),
})

const TileLayerSchema = z.object({
  type: z.literal('tilelayer'),
  ...layerFields,
  width: z.number().optional(),
  height: z.number().optional(),
  // The tile IDs, as a list ("CSV" in Tiled's settings) or as base64 text.
  data: z.union([z.array(z.number()), z.string()]).optional(),
  encoding: z.string().optional(),
  compression: z.string().optional(),
  // An infinite map is stored in chunks, with positions in tiles.
  chunks: z.array(TileChunkSchema).optional(),
})
export type TileLayer = z.infer<typeof TileLayerSchema>

const ObjectLayerSchema = z.object({
  type: z.literal('objectgroup'),
  ...layerFields,
  objects: z.array(TiledObjectSchema),
})
export type ObjectLayer = z.infer<typeof ObjectLayerSchema>

const ImageLayerSchema = z.object({
  type: z.literal('imagelayer'),
  ...layerFields,
  image: z.string().optional(),
})
export type ImageLayer = z.infer<typeof ImageLayerSchema>

const GroupLayerBase = z.object({ type: z.literal('group'), ...layerFields })
export type GroupLayer = z.infer<typeof GroupLayerBase> & { layers: TiledLayer[] }
export type TiledLayer = TileLayer | ObjectLayer | ImageLayer | GroupLayer

const LayerSchema: z.ZodType<TiledLayer> = z.lazy(() => z.union([
  TileLayerSchema,
  ObjectLayerSchema,
  ImageLayerSchema,
  GroupLayerBase.extend({ layers: z.array(LayerSchema) }),
]))

const TilesetBodySchema = z.object({
  name: z.string(),
  tilewidth: z.number(),
  tileheight: z.number(),
  tilecount: z.number().optional(),
  columns: z.number().optional(),
  margin: z.number().optional(),
  spacing: z.number().optional(),
  // A tileset is one picture cut into tiles, or (with no `image`) a collection of pictures, one for each of its `tiles`.
  image: z.string().optional(),
  imagewidth: z.number().optional(),
  imageheight: z.number().optional(),
  tileoffset: PointSchema.optional(),
  tiles: z.array(z.object({
    id: z.number(),
    image: z.string().optional(),
    imagewidth: z.number().optional(),
    imageheight: z.number().optional(),
  })).optional(),
  properties,
})
export type TilesetBody = z.infer<typeof TilesetBodySchema>
// A tileset as the map uses it: its first global tile ID, and where it came from when it is in its own file.
export type Tileset = TilesetBody & { firstgid: number; source?: string }

const MapTilesetSchema = z.union([
  z.object({ firstgid: z.number(), source: z.string() }),
  TilesetBodySchema.extend({ firstgid: z.number() }),
])

const TiledMapSchema = z.object({
  orientation: z.string(),
  width: z.number(),
  height: z.number(),
  tilewidth: z.number(),
  tileheight: z.number(),
  infinite: z.boolean().optional(),
  backgroundcolor: z.string().optional(),
  layers: z.array(LayerSchema),
  tilesets: z.array(MapTilesetSchema),
  properties,
})
export type TiledMap = Omit<z.infer<typeof TiledMapSchema>, 'layers' | 'tilesets'> & {
  layers: TiledLayer[]
  tilesets: Array<{ firstgid: number; source: string } | Tileset>
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0]
  const where = issue?.path.length ? ` (at ${issue.path.join('.')})` : ''
  return `${issue?.message ?? 'unknown problem'}${where}`
}

// Reads a map from its JSON. It says what is wrong with one that is not a map the game can draw.
export function parseTiledMap(json: unknown): TiledMap {
  const parsed = TiledMapSchema.safeParse(json)
  if (!parsed.success) throw new Error(`The map is not a Tiled map: ${describe(parsed.error)}`)
  if (parsed.data.orientation !== 'orthogonal') {
    throw new Error(`Only orthogonal maps can be drawn, and this one is ${parsed.data.orientation}.`)
  }
  return parsed.data as TiledMap
}

export function parseTiledTileset(json: unknown): TilesetBody {
  const parsed = TilesetBodySchema.safeParse(json)
  if (!parsed.success) throw new Error(`The tileset is not a Tiled tileset: ${describe(parsed.error)}`)
  return parsed.data
}

// ---------------------------------------------------------------------------- properties and paths

export function getProperty(properties: readonly TiledProperty[] | undefined, name: string): unknown {
  return properties?.find((property) => property.name === name)?.value
}

// How many world units one pixel of the map's art is drawn as: the map's `worldScale` property if it
// has a positive one, and `fallback` if not.
export function mapWorldScale(map: TiledMap, fallback: number): number {
  const value = getProperty(map.properties, 'worldScale')
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

// A path written in a file (with `..` in it, and `\` if it was made on Windows) as a plain path from
// the folder the files are in, given the folder of the file it was written in.
export function resolveAssetPath(fromDirectory: string, relative: string): string {
  const parts: string[] = []
  for (const part of `${fromDirectory}/${relative.replaceAll('\\', '/')}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

// ---------------------------------------------------------------------------- tile IDs

const FLIP_HORIZONTAL = 0x80000000
const FLIP_VERTICAL = 0x40000000
const FLIP_DIAGONAL = 0x20000000
// The top four bits are flags (the last, for hexagonal maps, is not used here).
const GID_MASK = 0x0fffffff

export type TileCell = {
  col: number
  row: number
  // The tile's global ID, with the flags taken off.
  gid: number
  flipH: boolean
  flipV: boolean
  // A flip along the diagonal, which comes first when there are others (together they make the quarter turns).
  flipD: boolean
}

export function splitGid(raw: number): Omit<TileCell, 'col' | 'row'> {
  const bits = raw >>> 0
  return {
    gid: bits & GID_MASK,
    flipH: (bits & FLIP_HORIZONTAL) !== 0,
    flipV: (bits & FLIP_VERTICAL) !== 0,
    flipD: (bits & FLIP_DIAGONAL) !== 0,
  }
}

// The 2D transform [a, b, c, d] that flips a tile about its middle, in the form a canvas takes
// (x' = a·x + c·y, y' = b·x + d·y): the diagonal flip swaps the axes, and then the horizontal and
// vertical flips mirror the result.
export function flipMatrix(flags: Pick<TileCell, 'flipH' | 'flipV' | 'flipD'>): [number, number, number, number] {
  let [a, b, c, d] = flags.flipD ? [0, 1, 1, 0] : [1, 0, 0, 1]
  if (flags.flipH) {
    a = -a
    c = -c
  }
  if (flags.flipV) {
    b = -b
    d = -d
  }
  return [a + 0, b + 0, c + 0, d + 0]
}

// The tileset a tile belongs to: the one with the highest first ID that is not above it.
export function findTileset<T extends { firstgid: number }>(tilesets: readonly T[], gid: number): T | undefined {
  let found: T | undefined
  for (const tileset of tilesets) {
    if (tileset.firstgid <= gid && (found === undefined || tileset.firstgid > found.firstgid)) found = tileset
  }
  return found
}

// Where a tile is in its tileset's picture, in pixels. A tile with no place in it (an ID beyond the
// picture) gives nothing.
export function tileRect(
  tileset: Pick<TilesetBody, 'tilewidth' | 'tileheight' | 'columns' | 'margin' | 'spacing' | 'imagewidth'>,
  localId: number,
): { x: number; y: number; width: number; height: number } | undefined {
  const margin = tileset.margin ?? 0
  const spacing = tileset.spacing ?? 0
  const columns = tileset.columns
    ?? (tileset.imagewidth === undefined ? undefined : Math.floor((tileset.imagewidth - margin + spacing) / (tileset.tilewidth + spacing)))
  if (!columns || columns < 1 || localId < 0) return undefined
  return {
    x: margin + (localId % columns) * (tileset.tilewidth + spacing),
    y: margin + Math.floor(localId / columns) * (tileset.tileheight + spacing),
    width: tileset.tilewidth,
    height: tileset.tileheight,
  }
}

// ---------------------------------------------------------------------------- layers

function decodeData(data: number[] | string, encoding: string | undefined, compression: string | undefined): number[] {
  if (Array.isArray(data)) return data
  if (encoding !== 'base64') throw new Error('A tile layer is stored in a way that is not understood. Set its format to CSV in Tiled.')
  if (compression) {
    throw new Error(`A tile layer is compressed (${compression}). In Tiled, set the map's Tile Layer Format to CSV or Base64 (uncompressed).`)
  }
  const binary = atob(data)
  if (binary.length % 4 !== 0) throw new Error('A tile layer has data that is the wrong length.')
  const tiles: number[] = []
  for (let offset = 0; offset < binary.length; offset += 4) {
    tiles.push(
      (binary.charCodeAt(offset)
        | (binary.charCodeAt(offset + 1) << 8)
        | (binary.charCodeAt(offset + 2) << 16)
        | (binary.charCodeAt(offset + 3) << 24)) >>> 0,
    )
  }
  return tiles
}

export type TileBounds = { col: number; row: number; cols: number; rows: number }

// Every tile in a tile layer that is not empty, by column and row, and the area (in tiles) the layer
// covers. A map of a set size covers all of it; an infinite one covers just the chunks it has.
export function tileLayerCells(layer: TileLayer, map: Pick<TiledMap, 'width' | 'height'>): { cells: TileCell[]; bounds: TileBounds } {
  const cells: TileCell[] = []
  const readBlock = (data: number[], col0: number, row0: number, cols: number): void => {
    data.forEach((raw, index) => {
      if (raw === 0) return
      const split = splitGid(raw)
      if (split.gid === 0) return
      cells.push({ col: col0 + (index % cols), row: row0 + Math.floor(index / cols), ...split })
    })
  }
  if (layer.chunks && layer.chunks.length > 0) {
    let minCol = Infinity
    let minRow = Infinity
    let maxCol = -Infinity
    let maxRow = -Infinity
    for (const chunk of layer.chunks) {
      readBlock(decodeData(chunk.data, layer.encoding, layer.compression), chunk.x, chunk.y, chunk.width)
      minCol = Math.min(minCol, chunk.x)
      minRow = Math.min(minRow, chunk.y)
      maxCol = Math.max(maxCol, chunk.x + chunk.width)
      maxRow = Math.max(maxRow, chunk.y + chunk.height)
    }
    return { cells, bounds: { col: minCol, row: minRow, cols: maxCol - minCol, rows: maxRow - minRow } }
  }
  const cols = layer.width ?? map.width
  const rows = layer.height ?? map.height
  if (layer.data !== undefined) readBlock(decodeData(layer.data, layer.encoding, layer.compression), 0, 0, cols)
  return { cells, bounds: { col: 0, row: 0, cols, rows } }
}

// A layer with what it inherits from the groups it is in: their offsets add up, their opacities
// multiply, and a layer in a hidden group is hidden.
export type PlacedLayer = {
  layer: Exclude<TiledLayer, GroupLayer>
  offsetx: number
  offsety: number
  opacity: number
  visible: boolean
}

// Every layer that holds something, bottom to top, with groups opened out.
export function flattenLayers(
  layers: readonly TiledLayer[],
  inherited: { offsetx: number; offsety: number; opacity: number; visible: boolean } = { offsetx: 0, offsety: 0, opacity: 1, visible: true },
): PlacedLayer[] {
  const placed: PlacedLayer[] = []
  for (const layer of layers) {
    const here = {
      offsetx: inherited.offsetx + (layer.offsetx ?? 0),
      offsety: inherited.offsety + (layer.offsety ?? 0),
      opacity: inherited.opacity * (layer.opacity ?? 1),
      visible: inherited.visible && (layer.visible ?? true),
    }
    if (layer.type === 'group') placed.push(...flattenLayers(layer.layers, here))
    else placed.push({ layer, ...here })
  }
  return placed
}

// The area a map covers, in pixels from the map's own origin. A map of a set size covers all of it. An
// infinite map has no edge, so it covers the tiles that are actually in it, and Tiled may have put
// them anywhere, such as at negative positions. A map with no tiles covers its set size.
export function mapContentBounds(map: TiledMap): { x: number; y: number; width: number; height: number } {
  const whole = { x: 0, y: 0, width: map.width * map.tilewidth, height: map.height * map.tileheight }
  if (!map.infinite) return whole
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const { layer } of flattenLayers(map.layers)) {
    if (layer.type !== 'tilelayer') continue
    for (const cell of tileLayerCells(layer, map).cells) {
      left = Math.min(left, cell.col)
      top = Math.min(top, cell.row)
      right = Math.max(right, cell.col + 1)
      bottom = Math.max(bottom, cell.row + 1)
    }
  }
  if (left === Infinity) return whole
  return { x: left * map.tilewidth, y: top * map.tileheight, width: (right - left) * map.tilewidth, height: (bottom - top) * map.tileheight }
}
