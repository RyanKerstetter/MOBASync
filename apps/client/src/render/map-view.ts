import { Container, Graphics } from 'pixi.js'

// The ground the game is played on, drawn under everything else. The world renderer takes one and
// does not care how it is drawn: the plain arena floor below is one, and a map with terrain can be
// another, drawn the same way in the game and in anything else that shows the map.
export type MapView = {
  readonly view: Container
  // The debug view (P in the game) is on or off. A map with something only worth seeing while
  // debugging, such as the true outlines of its walls, shows it then.
  setDebug?(enabled: boolean): void
}

// An empty arena: a floor with a grid on it, since a plain floor gives no sense of moving across a
// big map, and a border round its edge.
export function createArenaFloor(size: { width: number; height: number }): MapView {
  const { width, height } = size
  const floor = new Graphics().rect(0, 0, width, height).fill({ color: '#18263a' })
  for (let x = 100; x < width; x += 100) floor.moveTo(x, 0).lineTo(x, height)
  for (let y = 100; y < height; y += 100) floor.moveTo(0, y).lineTo(width, y)
  floor.stroke({ color: '#1f3149', width: 1 })
  floor.rect(0, 0, width, height).stroke({ color: '#314862', width: 4 })
  return { view: floor }
}
