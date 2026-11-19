import { Application } from 'pixi.js'

// A Pixi application filling `container`, sized with it and drawn at the screen's own pixel density,
// with its canvas put in the container.
export async function createPixiApp(container: HTMLElement, options: { maxFPS?: number } = {}): Promise<Application> {
  const app = new Application()
  await app.init({
    background: '#101827',
    // Made see-through, so the canvas has an alpha channel: the 3D world is drawn under it. The 2D world makes it solid again
    // (see `makeRenderer` in game.ts). Whether a canvas can be see-through is fixed when it is made.
    backgroundAlpha: 0,
    resizeTo: container,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  })
  if (options.maxFPS !== undefined) app.ticker.maxFPS = options.maxFPS
  container.replaceChildren(app.canvas)
  return app
}
