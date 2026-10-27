import { createShadowcastVision } from './shadowcast-vision.js'
import type { VisionFactory, VisionGround, VisionSystem } from './vision.js'

// The vision systems the game has, by name. The page uses `DEFAULT_VISION_SYSTEM`, or the one its address asks for:
// `?vision=range` (or `?vision=off` for none at all). To try another way of working out what a team sees, write a
// `VisionFactory` (see vision.ts) and add it here.
export const visionSystems: ReadonlyMap<string, VisionFactory> = new Map<string, VisionFactory>([
  // Symmetric shadowcasting on a grid of 8 pixels of the map's art, with walls blocking sight.
  ['shadowcast', (ground) => createShadowcastVision(ground)],
  // Only how far a champion sees: a circle round it, with no shadows behind walls. For telling the two apart.
  ['range', (ground) => createShadowcastVision(ground, { walls: false, name: 'range' })],
])

export const DEFAULT_VISION_SYSTEM = 'shadowcast'

export function createVision(ground: VisionGround, name: string = DEFAULT_VISION_SYSTEM): VisionSystem {
  const factory = visionSystems.get(name)
  if (!factory) throw new RangeError(`Unknown vision system "${name}" (there are ${[...visionSystems.keys()].join(', ')}).`)
  return factory(ground)
}
