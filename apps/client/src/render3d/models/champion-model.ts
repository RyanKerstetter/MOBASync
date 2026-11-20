import type { Champion } from '../../../../../packages/shared/src/index.ts'
import type { VisionShading } from '../vision-shading.ts'
import { HoundModel } from './hound.ts'
import { championFigure } from './humanoid.ts'
import { championLook } from './looks.ts'
import type { Model } from './model.ts'

// A champion's model: a beast of its own for one that is no figure (the Hellhound, on four legs), and otherwise a figure dressed by its look (see humanoid.ts).
export function championModel(vision: VisionShading, champion: Pick<Champion, 'id' | 'radius' | 'attackProjectile'>): Model {
  if (champion.id === 'hellhound') return new HoundModel(vision, champion.radius)
  return championFigure(vision, champion.radius, championLook(champion), champion.id)
}
