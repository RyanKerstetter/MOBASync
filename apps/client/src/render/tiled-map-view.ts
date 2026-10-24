import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import {
  findTileset,
  flattenLayers,
  flipMatrix,
  mapContentBounds,
  splitGid,
  tileLayerCells,
  tileRect,
  type ObjectLayer,
  type TiledObject,
} from '../../../../packages/shared/src/index.ts'
import type { MapView } from './map-view.ts'
import type { LoadedTiledMap, LoadedTileset } from './tiled-loader.ts'

// Browsers will not make a canvas bigger than this on a side, so a layer cannot be drawn bigger.
const MAX_LAYER_PIXELS = 16384
const DEBUG_COLOR = '#ff9f43'

type Rect = { x: number; y: number; width: number; height: number }
type Flips = { flipH: boolean; flipV: boolean; flipD: boolean }

// A map from Tiled, drawn as the ground: its tile layers, the pictures of tiles that are objects, and
// its picture layers, in the order Tiled has them. The art is drawn `scale` world units to a pixel of
// the map, and nothing is smoothed, so pixel art stays sharp. The top left corner of the map's arena
// (`arena`, in the map's pixels) is the world's origin, so the art that surrounds the arena is drawn
// at negative positions and past its far edges. The shapes of the map's objects (what will be walls,
// say) are not part of how it looks: the debug view (P) draws them.
//
// Not drawn yet: tile animations, tile layer tints, parallax, and rotated or hexagonal maps.
export class TiledMapView implements MapView {
  readonly view = new Container()
  private readonly content = new Container()
  private readonly debugLayer = new Container()
  private readonly missingTilesets = new Set<number>()

  constructor(private readonly loaded: LoadedTiledMap, private readonly scale: number, arena: Rect) {
    const { map } = loaded
    this.content.scale.set(scale)
    this.content.position.set(-arena.x * scale, -arena.y * scale)
    this.view.addChild(this.content)

    const background = parseColor(map.backgroundcolor)
    if (background) {
      const covered = mapContentBounds(map)
      this.content.addChild(new Graphics().rect(covered.x, covered.y, covered.width, covered.height).fill(background))
    }

    const debugShapes = new Graphics()
    this.debugLayer.addChild(debugShapes)
    this.debugLayer.visible = false
    for (const placed of flattenLayers(map.layers)) {
      const { layer, visible } = placed
      if (layer.type === 'objectgroup') {
        this.drawDebugObjects(debugShapes, layer, placed.offsetx, placed.offsety)
        if (visible) this.addTileObjects(layer, placed)
      } else if (visible && layer.type === 'tilelayer') {
        const sprite = this.drawTileLayer(layer)
        if (sprite) this.place(sprite, placed)
      } else if (visible && layer.type === 'imagelayer') {
        const picture = loaded.imageLayers.get(layer)
        if (picture) this.place(new Sprite(textureOf(picture)), placed)
      }
    }
    this.content.addChild(this.debugLayer)
  }

  setDebug(enabled: boolean): void {
    this.debugLayer.visible = enabled
  }

  private place(sprite: Sprite, placed: { offsetx: number; offsety: number; opacity: number }): void {
    sprite.position.set(sprite.x + placed.offsetx, sprite.y + placed.offsety)
    sprite.alpha = placed.opacity
    this.content.addChild(sprite)
  }

  // A tile layer is drawn once onto a canvas, and shown as one picture. That is cheap to draw every
  // frame, and leaves no hairline gaps between tiles however far the view is zoomed. The canvas is
  // just big enough for the tiles the layer has (a layer of a few flowers is a small picture, not one
  // as big as the map), and a tile bigger than the grid is drawn whole, past the edge of its cell.
  private drawTileLayer(layer: Parameters<typeof tileLayerCells>[0]): Sprite | undefined {
    const { map } = this.loaded
    const { cells, bounds } = tileLayerCells(layer, map)
    const placements: Array<{ image: CanvasImageSource; rect: Rect; x: number; y: number; flips: Flips }> = []
    for (const cell of cells) {
      const found = this.tileGraphic(cell.gid)
      if (!found) continue
      const offset = found.owner.tileset.tileoffset
      placements.push({
        image: found.image,
        rect: found.rect,
        // A tile bigger than the grid sits on the bottom left of its cell, and grows up and to the right.
        x: (cell.col - bounds.col) * map.tilewidth + (offset?.x ?? 0),
        y: (cell.row - bounds.row + 1) * map.tileheight - found.rect.height + (offset?.y ?? 0),
        flips: cell,
      })
    }
    if (placements.length === 0) return undefined
    const left = Math.min(...placements.map((place) => place.x))
    const top = Math.min(...placements.map((place) => place.y))
    const right = Math.max(...placements.map((place) => place.x + place.rect.width))
    const bottom = Math.max(...placements.map((place) => place.y + place.rect.height))
    const width = right - left
    const height = bottom - top
    if (width > MAX_LAYER_PIXELS || height > MAX_LAYER_PIXELS) {
      throw new Error(`The layer "${layer.name}" is ${width} by ${height} pixels, which is too big to draw.`)
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('A canvas cannot be drawn on in this browser.')
    context.imageSmoothingEnabled = false
    for (const place of placements) drawTile(context, place.image, place.rect, place.x - left, place.y - top, place.flips)
    const sprite = new Sprite(textureOf(canvas))
    sprite.position.set(bounds.col * map.tilewidth + left, bounds.row * map.tileheight + top)
    return sprite
  }

  // Objects that are a picture of a tile (a tree, a rock). Their position is the bottom left corner.
  private addTileObjects(layer: ObjectLayer, placed: { offsetx: number; offsety: number; opacity: number }): void {
    for (const object of layer.objects) {
      if (object.gid === undefined || object.visible === false) continue
      const split = splitGid(object.gid)
      const found = this.tileGraphic(split.gid)
      if (!found) continue
      const width = object.width ?? found.rect.width
      const height = object.height ?? found.rect.height
      const canvas = document.createElement('canvas')
      canvas.width = found.rect.width
      canvas.height = found.rect.height
      const context = canvas.getContext('2d')
      if (!context) continue
      context.imageSmoothingEnabled = false
      drawTile(context, found.image, found.rect, 0, 0, split)
      const sprite = new Sprite(textureOf(canvas))
      sprite.anchor.set(0, 1)
      sprite.width = width
      sprite.height = height
      sprite.position.set(object.x, object.y)
      sprite.rotation = (object.rotation ?? 0) * Math.PI / 180
      this.place(sprite, placed)
    }
  }

  // The picture a tile is cut from, and where in it, or nothing for an ID no tileset has.
  private tileGraphic(gid: number): { owner: LoadedTileset; image: CanvasImageSource; rect: Rect } | undefined {
    const owner = findTileset(this.loaded.tilesets, gid)
    if (!owner) {
      if (!this.missingTilesets.has(gid)) {
        this.missingTilesets.add(gid)
        console.warn(`The map has a tile (${gid}) that no tileset has, so it is not drawn.`)
      }
      return undefined
    }
    const localId = gid - owner.tileset.firstgid
    if (owner.image) {
      const rect = tileRect(owner.tileset, localId)
      return rect ? { owner, image: owner.image, rect } : undefined
    }
    const picture = owner.tileImages.get(localId)
    return picture ? { owner, image: picture, rect: { x: 0, y: 0, width: picture.naturalWidth, height: picture.naturalHeight } } : undefined
  }

  // The outlines of every object that is a shape, over the map, for checking where they are.
  private drawDebugObjects(graphics: Graphics, layer: ObjectLayer, offsetx: number, offsety: number): void {
    const line = 2 / this.scale
    for (const object of layer.objects) {
      if (object.gid !== undefined) continue
      const shape = objectShape(object)
      if (!shape) continue
      const at = (point: { x: number; y: number }) => ({ x: point.x + offsetx, y: point.y + offsety })
      if (shape.kind === 'point') {
        graphics.circle(shape.x + offsetx, shape.y + offsety, 4 / this.scale).fill({ color: DEBUG_COLOR }).stroke({ color: DEBUG_COLOR, width: line })
      } else if (shape.kind === 'line') {
        const [first, ...rest] = shape.points.map(at)
        graphics.moveTo(first.x, first.y)
        for (const point of rest) graphics.lineTo(point.x, point.y)
        graphics.stroke({ color: DEBUG_COLOR, width: line })
      } else {
        graphics.poly(shape.points.map(at).flatMap((point) => [point.x, point.y])).fill({ color: DEBUG_COLOR, alpha: 0.15 }).stroke({ color: DEBUG_COLOR, width: line })
      }
    }
  }
}

// An object as the shape it is drawn as: a closed polygon (rectangles and ellipses included), an open
// line, or a point, in map pixels. Rotation is clockwise about the object's own position.
function objectShape(object: TiledObject):
  | { kind: 'polygon'; points: Array<{ x: number; y: number }> }
  | { kind: 'line'; points: Array<{ x: number; y: number }> }
  | { kind: 'point'; x: number; y: number }
  | undefined {
  const angle = (object.rotation ?? 0) * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const place = (local: { x: number; y: number }) => ({
    x: object.x + local.x * cos - local.y * sin,
    y: object.y + local.x * sin + local.y * cos,
  })
  if (object.point) return { kind: 'point', x: object.x, y: object.y }
  if (object.polygon) return { kind: 'polygon', points: object.polygon.map(place) }
  if (object.polyline) return { kind: 'line', points: object.polyline.map(place) }
  const width = object.width ?? 0
  const height = object.height ?? 0
  if (width <= 0 && height <= 0) return undefined
  if (object.ellipse) {
    const points = Array.from({ length: 32 }, (_, index) => {
      const turn = index / 32 * Math.PI * 2
      return place({ x: width / 2 + Math.cos(turn) * width / 2, y: height / 2 + Math.sin(turn) * height / 2 })
    })
    return { kind: 'polygon', points }
  }
  return { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }].map(place) }
}

function drawTile(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  rect: Rect,
  x: number,
  y: number,
  flips: Flips,
): void {
  if (!flips.flipH && !flips.flipV && !flips.flipD) {
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height, x, y, rect.width, rect.height)
    return
  }
  // Flipped about the middle of the tile.
  context.save()
  context.translate(x + rect.width / 2, y + rect.height / 2)
  const [a, b, c, d] = flipMatrix(flips)
  context.transform(a, b, c, d, 0, 0)
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, -rect.width / 2, -rect.height / 2, rect.width, rect.height)
  context.restore()
}

function textureOf(source: HTMLCanvasElement | HTMLImageElement): Texture {
  const texture = Texture.from(source)
  texture.source.scaleMode = 'nearest'
  return texture
}

// Tiled writes colours as #RRGGBB or #AARRGGBB.
function parseColor(text: string | undefined): { color: number; alpha: number } | undefined {
  const match = text ? /^#?([0-9a-f]{2})?([0-9a-f]{6})$/i.exec(text) : null
  if (!match) return undefined
  return { color: parseInt(match[2], 16), alpha: match[1] ? parseInt(match[1], 16) / 255 : 1 }
}
