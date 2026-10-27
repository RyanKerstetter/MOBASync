import { BufferImageSource, Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { VisionMask } from '../../../../packages/shared/src/index.ts'
import { FOG_ALPHA, FOG_COLOR, FogPicture } from './fog.ts'

// How far past the edge of the arena the darkness goes, which is further than the camera can see.
const SURROUND = 6000

// The darkness over what is not seen: a picture of the mask (`FogPicture`, which rounds off the steps in its edge),
// stretched over the world and smoothed by the graphics card. Outside the arena is dark. The
// picture is made again only when the mask is a new one (its `revision`), which is when a viewer has gone into another cell.
// Without a mask there is no darkness at all: that is what the page asks for when it shows everything.
export class FogLayer {
  readonly view = new Container()
  private picture: {
    mask: Pick<VisionMask, 'cell' | 'cols' | 'rows'>
    fog: FogPicture
    source: BufferImageSource
    revision: number
  } | undefined

  constructor() {
    this.view.visible = false
  }

  update(mask: VisionMask | undefined): void {
    this.view.visible = mask !== undefined
    if (!mask) return
    // Another kind of mask is another member of the type, and a way of drawing it here: the compiler asks for it.
    switch (mask.kind) {
      case 'cells':
        this.updateCells(mask)
        return
      default:
        return assertNever(mask.kind)
    }
  }

  private updateCells(mask: VisionMask): void {
    const current = this.picture
    if (current && current.mask.cols === mask.cols && current.mask.rows === mask.rows && current.mask.cell === mask.cell) {
      if (current.revision === mask.revision) return
      current.fog.paint(mask)
      current.revision = mask.revision
      current.source.update()
      return
    }
    // The first mask, or one of another shape (another system, with another cell): the picture is made again.
    this.view.removeChildren().forEach((child) => child.destroy({ children: true }))
    current?.source.destroy()
    const fog = new FogPicture(mask.cols, mask.rows)
    fog.paint(mask)
    const source = new BufferImageSource({
      resource: fog.pixels,
      width: fog.width,
      height: fog.height,
      format: 'rgba8unorm',
      alphaMode: 'premultiplied-alpha',
      scaleMode: 'linear',
    })
    const sprite = new Sprite(new Texture({ source }))
    const width = mask.cols * mask.cell
    const height = mask.rows * mask.cell
    sprite.width = width
    sprite.height = height
    const surround = new Graphics()
      .rect(-SURROUND, -SURROUND, width + 2 * SURROUND, SURROUND)
      .rect(-SURROUND, height, width + 2 * SURROUND, SURROUND)
      .rect(-SURROUND, 0, SURROUND, height)
      .rect(width, 0, SURROUND, height)
      .fill({ color: FOG_COLOR, alpha: FOG_ALPHA })
    this.view.addChild(surround, sprite)
    this.picture = { mask: { cell: mask.cell, cols: mask.cols, rows: mask.rows }, fog, source, revision: mask.revision }
  }
}

function assertNever(value: never): never {
  throw new Error(`The fog layer cannot draw a mask of kind "${String(value)}".`)
}
