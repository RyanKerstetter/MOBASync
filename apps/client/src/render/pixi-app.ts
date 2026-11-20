import { Application } from 'pixi.js'
import { GRAPHICS_PRESETS, type GraphicsOptions } from './graphics-quality.ts'

// The pixels the page's own canvas (the 2D world, or the names, bars and numbers over the 3D one) is drawn with for each of the page's:
// the screen's own density with the resolution setting on High, and one on Standard, which on a high-density screen is a quarter of the
// pixels or fewer.
export function pixiResolution(graphics: Readonly<GraphicsOptions>): number {
  return graphics.resolution === 'standard' ? 1 : window.devicePixelRatio || 1
}

// The PixiJS application the game is drawn in, filling `container`, with its edges smoothed if the graphics settings say so (which is fixed
// when it is made) and drawn at `pixiResolution`.
export async function createPixiApp(container: HTMLElement, options: { maxFPS?: number; graphics?: Readonly<GraphicsOptions> } = {}): Promise<Application> {
  const graphics = options.graphics ?? GRAPHICS_PRESETS.high
  const app = new Application()
  await app.init({
    background: '#101827',
    // Made see-through, so the canvas has an alpha channel: the 3D world is drawn under it. The 2D world makes it solid again
    // (see `makeRenderer` in game.ts). Whether a canvas can be see-through is fixed when it is made.
    backgroundAlpha: 0,
    resizeTo: container,
    antialias: graphics.smoothEdges,
    autoDensity: true,
    resolution: pixiResolution(graphics),
  })
  if (options.maxFPS !== undefined) app.ticker.maxFPS = options.maxFPS
  container.replaceChildren(app.canvas)
  return app
}
