import { flattenLayers, tileLayerCells, type Rect, type TiledMap } from '../../../../packages/shared/src/index.ts'

// Where a map made in Tiled draws its paths, for the 3D ground to lay dirt there: every tile of a visible tile layer whose name
// says it is a path ("paths"), and not one on the walls ("wall-paths"), as a rectangle in world units from the arena's corner.
export function pathTilesOf(map: TiledMap, arena: { x: number; y: number }, scale: number): Rect[] {
  const tiles: Rect[] = []
  for (const placed of flattenLayers(map.layers)) {
    const { layer } = placed
    if (layer.type !== 'tilelayer' || !placed.visible) continue
    if (!/path/i.test(layer.name) || /wall/i.test(layer.name)) continue
    for (const cell of tileLayerCells(layer, map).cells) {
      tiles.push({
        x: (cell.col * map.tilewidth + placed.offsetx - arena.x) * scale,
        y: (cell.row * map.tileheight + placed.offsety - arena.y) * scale,
        width: map.tilewidth * scale,
        height: map.tileheight * scale,
      })
    }
  }
  return tiles
}
