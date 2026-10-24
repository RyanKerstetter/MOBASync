import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dirname,
  findTileset,
  flattenLayers,
  flipMatrix,
  getProperty,
  mapContentBounds,
  mapWorldScale,
  parseTiledMap,
  parseTiledTileset,
  resolveAssetPath,
  splitGid,
  tileLayerCells,
  tileRect,
  type TileLayer,
} from '../packages/shared/src/index.ts'

// A map as Tiled writes it to a .tmj: a tileset in a file of its own and one inside the map, a group
// with an offset, an object layer with a shape and a picture of a tile, and a picture layer.
function sampleMap(): unknown {
  return {
    type: 'map',
    version: '1.10',
    tiledversion: '1.10.2',
    orientation: 'orthogonal',
    renderorder: 'right-down',
    infinite: false,
    width: 3,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    nextlayerid: 7,
    backgroundcolor: '#101827',
    properties: [{ name: 'worldScale', type: 'float', value: 2 }, { name: 'author', type: 'string', value: 'Ryan' }],
    tilesets: [
      { firstgid: 1, source: 'terrain.tsj' },
      { firstgid: 101, name: 'props', tilewidth: 16, tileheight: 16, tilecount: 4, columns: 2, image: 'props.png', imagewidth: 32, imageheight: 32 },
    ],
    layers: [
      { id: 1, name: 'ground', type: 'tilelayer', width: 3, height: 2, opacity: 1, visible: true, x: 0, y: 0, data: [1, 2, 3, 0, 5, 6] },
      {
        id: 2, name: 'decor', type: 'group', offsetx: 8, offsety: 0, opacity: 0.5,
        layers: [
          { id: 3, name: 'flowers', type: 'tilelayer', width: 3, height: 2, offsetx: 4, data: [0, 0, 0, 101, 0, 0] },
          { id: 4, name: 'hidden', type: 'tilelayer', width: 3, height: 2, visible: false, data: [0, 0, 0, 0, 0, 0] },
        ],
      },
      {
        id: 5, name: 'collision', type: 'objectgroup',
        objects: [
          { id: 1, name: 'wall', class: 'wall', x: 16, y: 16, width: 32, height: 16, rotation: 0, visible: true },
          { id: 2, x: 0, y: 0, polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] },
          { id: 3, x: 40, y: 40, gid: 102, width: 16, height: 16 },
        ],
      },
      { id: 6, name: 'sky', type: 'imagelayer', image: '../sky/clouds.png', opacity: 0.8 },
    ],
  }
}

test('a map as Tiled writes it is read, with its layers, tilesets and objects', () => {
  const map = parseTiledMap(sampleMap())
  assert.deepEqual([map.width, map.height, map.tilewidth, map.tileheight], [3, 2, 16, 16])
  assert.deepEqual(map.layers.map((layer) => [layer.type, layer.name]), [
    ['tilelayer', 'ground'], ['group', 'decor'], ['objectgroup', 'collision'], ['imagelayer', 'sky'],
  ])
  assert.deepEqual(map.tilesets.map((tileset) => tileset.firstgid), [1, 101])
  assert.equal('source' in map.tilesets[0], true, 'the first tileset is in a file of its own')
  const objects = map.layers[2].type === 'objectgroup' ? map.layers[2].objects : []
  assert.deepEqual(objects.map((object) => [object.id, object.class, object.polygon?.length, object.gid]), [
    [1, 'wall', undefined, undefined], [2, undefined, 3, undefined], [3, undefined, undefined, 102],
  ])
  assert.equal(getProperty(map.properties, 'author'), 'Ryan')
  assert.equal(getProperty(map.properties, 'missing'), undefined)
})

test('a map that is not orthogonal, or not a map at all, is refused with a reason', () => {
  assert.throws(() => parseTiledMap({ ...(sampleMap() as object), orientation: 'isometric' }), /orthogonal.*isometric/)
  assert.throws(() => parseTiledMap({ orientation: 'orthogonal' }), /not a Tiled map/)
  assert.throws(() => parseTiledMap('nope'), /not a Tiled map/)
  const broken = sampleMap() as { layers: Array<Record<string, unknown>> }
  broken.layers[0].type = 'mystery'
  assert.throws(() => parseTiledMap(broken), /not a Tiled map/)
})

test('a tileset file is read, and a collection of pictures has no image of its own', () => {
  const sheet = parseTiledTileset({ name: 'terrain', tilewidth: 16, tileheight: 16, tilecount: 6, columns: 3, image: 'terrain.png', imagewidth: 48, imageheight: 32 })
  assert.equal(sheet.image, 'terrain.png')
  const collection = parseTiledTileset({ name: 'trees', tilewidth: 32, tileheight: 48, tiles: [{ id: 0, image: 'oak.png', imagewidth: 32, imageheight: 48 }] })
  assert.equal(collection.image, undefined)
  assert.equal(collection.tiles?.[0].image, 'oak.png')
  assert.throws(() => parseTiledTileset({ name: 'x' }), /not a Tiled tileset/)
})

test('a tile ID carries its flips in its top bits', () => {
  assert.deepEqual(splitGid(5), { gid: 5, flipH: false, flipV: false, flipD: false })
  assert.deepEqual(splitGid(0x80000005), { gid: 5, flipH: true, flipV: false, flipD: false })
  assert.deepEqual(splitGid(0x40000007), { gid: 7, flipH: false, flipV: true, flipD: false })
  assert.deepEqual(splitGid(0xe0000009), { gid: 9, flipH: true, flipV: true, flipD: true })
  // Tiled writes these as plain numbers, so they can be past what a signed 32 bit integer holds.
  assert.equal(splitGid(4_294_967_295).gid, 0x0fffffff)
})

test('the flips are the turns and mirrors Tiled draws', () => {
  const apply = (flags: Parameters<typeof flipMatrix>[0], x: number, y: number): [number, number] => {
    const [a, b, c, d] = flipMatrix(flags)
    return [a * x + c * y, b * x + d * y]
  }
  const none = { flipH: false, flipV: false, flipD: false }
  assert.deepEqual(apply(none, 1, 0), [1, 0])
  assert.deepEqual(apply({ ...none, flipH: true }, 1, 0), [-1, 0], 'mirrored left to right')
  assert.deepEqual(apply({ ...none, flipV: true }, 0, 1), [0, -1], 'mirrored top to bottom')
  assert.deepEqual(apply({ ...none, flipH: true, flipV: true }, 1, 0), [-1, 0], 'a half turn')
  // On screen y points down, so right goes to down and down to left in a clockwise quarter turn.
  const clockwise = { flipH: true, flipV: false, flipD: true }
  assert.deepEqual(apply(clockwise, 1, 0), [0, 1])
  assert.deepEqual(apply(clockwise, 0, 1), [-1, 0])
  const counter = { flipH: false, flipV: true, flipD: true }
  assert.deepEqual(apply(counter, 1, 0), [0, -1])
  assert.deepEqual(apply({ ...none, flipD: true }, 1, 0), [0, 1], 'a diagonal flip alone swaps the axes')
})

test('the cells of a tile layer skip the empty ones and keep their flips', () => {
  const layer: TileLayer = { type: 'tilelayer', name: 'ground', width: 3, height: 2, data: [1, 2, 0, 0x80000003, 5, 0] }
  const { cells, bounds } = tileLayerCells(layer, { width: 3, height: 2 })
  assert.deepEqual(bounds, { col: 0, row: 0, cols: 3, rows: 2 })
  assert.deepEqual(cells.map((cell) => [cell.col, cell.row, cell.gid, cell.flipH]), [
    [0, 0, 1, false], [1, 0, 2, false], [0, 1, 3, true], [1, 1, 5, false],
  ])
})

test('tile data written as uncompressed base64 is read the same, and a compressed layer says how to fix it', () => {
  const values = [1, 2, 0, 0x80000003]
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4))
  const layer: TileLayer = { type: 'tilelayer', name: 'ground', width: 2, height: 2, encoding: 'base64', data: bytes.toString('base64') }
  const { cells } = tileLayerCells(layer, { width: 2, height: 2 })
  assert.deepEqual(cells.map((cell) => [cell.col, cell.row, cell.gid, cell.flipH]), [[0, 0, 1, false], [1, 0, 2, false], [1, 1, 3, true]])

  assert.throws(() => tileLayerCells({ ...layer, compression: 'zlib' }, { width: 2, height: 2 }), /CSV or Base64 \(uncompressed\)/)
  assert.throws(() => tileLayerCells({ ...layer, encoding: undefined }, { width: 2, height: 2 }), /CSV/)
})

test('an infinite map is read from its chunks, with the area they cover', () => {
  const layer: TileLayer = {
    type: 'tilelayer',
    name: 'ground',
    chunks: [
      { x: -2, y: 0, width: 2, height: 2, data: [1, 0, 0, 2] },
      { x: 0, y: 0, width: 2, height: 2, data: [0, 3, 0, 0] },
    ],
  }
  const { cells, bounds } = tileLayerCells(layer, { width: 0, height: 0 })
  assert.deepEqual(bounds, { col: -2, row: 0, cols: 4, rows: 2 })
  assert.deepEqual(cells.map((cell) => [cell.col, cell.row, cell.gid]), [[-2, 0, 1], [-1, 1, 2], [1, 0, 3]])
})

test('a tile belongs to the tileset with the highest first ID that is not above it, and is found in its picture', () => {
  const tilesets = [{ firstgid: 101, name: 'props' }, { firstgid: 1, name: 'terrain' }, { firstgid: 201, name: 'trees' }]
  assert.equal(findTileset(tilesets, 1)?.name, 'terrain')
  assert.equal(findTileset(tilesets, 100)?.name, 'terrain')
  assert.equal(findTileset(tilesets, 101)?.name, 'props')
  assert.equal(findTileset(tilesets, 500)?.name, 'trees')
  assert.equal(findTileset(tilesets, 0), undefined)

  assert.deepEqual(tileRect({ tilewidth: 16, tileheight: 16, columns: 3 }, 4), { x: 16, y: 16, width: 16, height: 16 })
  // With a margin round the picture and a gap between tiles.
  assert.deepEqual(tileRect({ tilewidth: 16, tileheight: 16, columns: 3, margin: 1, spacing: 2 }, 4), { x: 19, y: 19, width: 16, height: 16 })
  // With no column count, it is worked out from the picture's width: 50 pixels hold two tiles and a gap.
  assert.deepEqual(tileRect({ tilewidth: 16, tileheight: 16, imagewidth: 50, spacing: 2 }, 3), { x: 18, y: 18, width: 16, height: 16 })
  assert.equal(tileRect({ tilewidth: 16, tileheight: 16 }, 0), undefined, 'no way to tell where it is')
})

test('paths written in a map or tileset are worked out from the folder it is in', () => {
  assert.equal(resolveAssetPath('', 'terrain.tsj'), 'terrain.tsj')
  assert.equal(resolveAssetPath('maps', '../sky/clouds.png'), 'sky/clouds.png')
  assert.equal(resolveAssetPath('maps/tiles', './img\\grass.png'), 'maps/tiles/img/grass.png')
  assert.equal(resolveAssetPath('a', '../../x.png'), 'x.png', 'it cannot go above the folder')
  assert.equal(dirname('maps/arena.tmj'), 'maps')
  assert.equal(dirname('arena.tmj'), '')
})

test('the map says how big its art is drawn, or it is the game\'s own scale', () => {
  const map = parseTiledMap(sampleMap())
  assert.equal(mapWorldScale(map, 3), 2)
  assert.equal(mapWorldScale({ ...map, properties: undefined }, 3), 3)
  assert.equal(mapWorldScale({ ...map, properties: [{ name: 'worldScale', value: 'big' }] }, 3), 3)
  assert.equal(mapWorldScale({ ...map, properties: [{ name: 'worldScale', value: -1 }] }, 3), 3)
})

test('groups are opened out, their offsets added, their opacity multiplied and their hiding passed on', () => {
  const map = parseTiledMap(sampleMap())
  const placed = flattenLayers(map.layers)
  assert.deepEqual(placed.map(({ layer, offsetx, offsety, opacity, visible }) => [layer.name, offsetx, offsety, opacity, visible]), [
    ['ground', 0, 0, 1, true],
    ['flowers', 12, 0, 0.5, true],
    ['hidden', 8, 0, 0.5, false],
    ['collision', 0, 0, 1, true],
    ['sky', 0, 0, 0.8, true],
  ])

  const hiddenGroup = flattenLayers([{
    type: 'group', name: 'g', visible: false,
    layers: [{ type: 'tilelayer', name: 'inside', data: [] }],
  }])
  assert.deepEqual(hiddenGroup.map(({ layer, visible }) => [layer.name, visible]), [['inside', false]])
})

test('a map of a set size covers all of it, and an infinite one covers the tiles it has, wherever Tiled put them', () => {
  const finite = parseTiledMap(sampleMap())
  assert.deepEqual(mapContentBounds(finite), { x: 0, y: 0, width: 48, height: 32 })

  const infinite = parseTiledMap({
    orientation: 'orthogonal', infinite: true, width: 30, height: 20, tilewidth: 16, tileheight: 16, tilesets: [],
    layers: [
      {
        type: 'tilelayer', name: 'ground',
        chunks: [
          // Chunks are always whole, so these have a lot of empty space round the tiles in them.
          { x: 0, y: -32, width: 4, height: 4, data: [0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
          { x: 4, y: 0, width: 4, height: 4, data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9] },
        ],
      },
      { type: 'tilelayer', name: 'extra', chunks: [{ x: -2, y: 1, width: 2, height: 2, data: [3, 0, 0, 0] }] },
    ],
  })
  // Columns -2 to 8 and rows -31 to 4, in tiles of 16.
  assert.deepEqual(mapContentBounds(infinite), { x: -32, y: -31 * 16, width: 10 * 16, height: 35 * 16 })

  const empty = parseTiledMap({ orientation: 'orthogonal', infinite: true, width: 30, height: 20, tilewidth: 16, tileheight: 16, tilesets: [], layers: [] })
  assert.deepEqual(mapContentBounds(empty), { x: 0, y: 0, width: 480, height: 320 })
})
