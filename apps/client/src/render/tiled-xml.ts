// Tiled saves a tileset as XML (.tsx) unless it is told otherwise, so a map saved as JSON still has
// tilesets in this form. This turns one into the same shape Tiled's JSON tilesets (.tsj) have, for
// `parseTiledTileset` to read. Only what the game uses is taken from it.
export function tilesetFromXml(text: string): unknown {
  const document = new DOMParser().parseFromString(text, 'application/xml')
  if (document.querySelector('parsererror')) throw new Error('The tileset file is not valid XML.')
  const root = document.documentElement
  if (root.nodeName !== 'tileset') throw new Error(`The tileset file holds a <${root.nodeName}>, not a <tileset>.`)

  const number = (element: Element, name: string): number | undefined => {
    const value = element.getAttribute(name)
    return value === null || value.trim() === '' || Number.isNaN(Number(value)) ? undefined : Number(value)
  }
  const child = (element: Element, name: string): Element | undefined =>
    Array.from(element.children).find((candidate) => candidate.nodeName === name)
  const picture = (element: Element | undefined): { image?: string; imagewidth?: number; imageheight?: number } => {
    const source = element?.getAttribute('source')
    if (!element || !source) return {}
    return { image: source, imagewidth: number(element, 'width'), imageheight: number(element, 'height') }
  }

  const tileoffset = child(root, 'tileoffset')
  const tiles = Array.from(root.children)
    .filter((element) => element.nodeName === 'tile')
    .map((tile) => ({ id: number(tile, 'id') ?? 0, ...picture(child(tile, 'image')) }))
    .filter((tile) => tile.image !== undefined)
  return {
    name: root.getAttribute('name') ?? '',
    tilewidth: number(root, 'tilewidth'),
    tileheight: number(root, 'tileheight'),
    tilecount: number(root, 'tilecount'),
    columns: number(root, 'columns'),
    margin: number(root, 'margin'),
    spacing: number(root, 'spacing'),
    ...picture(child(root, 'image')),
    ...(tileoffset ? { tileoffset: { x: number(tileoffset, 'x') ?? 0, y: number(tileoffset, 'y') ?? 0 } } : {}),
    ...(tiles.length > 0 ? { tiles } : {}),
  }
}
