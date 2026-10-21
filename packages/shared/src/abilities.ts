import { GAME_TPS } from './constants.js'
import {
  aimPoint,
  damage,
  enemiesInRadius,
  fireProjectile,
  resetAutoTimer,
  self,
  shield,
  slow,
  targetUnit,
  type Effect,
} from './effects.js'
import type { CastTarget, Vector2 } from './index.js'

export interface AbilityDef {
  id: string
  targeting: CastTarget['mode']
  range: number
  windUpTicks: number
  backswingTicks: number
  cooldownTicks: number
  apply: readonly Effect[]
}

const seconds = (value: number): number => Math.round(value * GAME_TPS)

const abilityList: AbilityDef[] = [
  {
    id: 'shockwave',
    targeting: 'none',
    range: 0,
    windUpTicks: 6,
    backswingTicks: 6,
    cooldownTicks: seconds(8),
    apply: [
      damage(2, enemiesInRadius(120)),
      slow(0.3, seconds(1), enemiesInRadius(120)),
      shield(2, seconds(1.5), self()),
      resetAutoTimer(),
    ],
  },
  {
    id: 'lash',
    targeting: 'unit',
    range: 200,
    windUpTicks: 9,
    backswingTicks: 6,
    cooldownTicks: seconds(5),
    apply: [
      damage(3, targetUnit()),
      slow(0.5, seconds(0.75), targetUnit()),
    ],
  },
  {
    id: 'bolt',
    targeting: 'direction',
    range: 450,
    windUpTicks: 9,
    backswingTicks: 3,
    cooldownTicks: seconds(4),
    apply: [
      fireProjectile({
        id: 'bolt',
        speed: 600,
        radius: 8,
        lifetimeTicks: seconds(0.75),
        onHit: [damage(3)],
      }),
    ],
  },
  {
    id: 'meteor',
    targeting: 'point',
    range: 300,
    windUpTicks: seconds(0.5),
    backswingTicks: 6,
    cooldownTicks: seconds(12),
    apply: [damage(4, enemiesInRadius(90, aimPoint()))],
  },
]

export const abilityDefs: ReadonlyMap<string, AbilityDef> = new Map(
  abilityList.map((def) => [def.id, def]),
)

export function getAbilityDef(id: string): AbilityDef | undefined {
  return abilityDefs.get(id)
}

const DIRECTION_STEPS = 4096
const DIRECTION_PRECISION = 10_000

// Client-side only: the quantized result travels as order data, so peers never
// need bit-identical trigonometry.
export function quantizeDirection(dir: Vector2): Vector2 | undefined {
  if (dir.x === 0 && dir.y === 0) return undefined
  const step = Math.PI * 2 / DIRECTION_STEPS
  const angle = Math.round(Math.atan2(dir.y, dir.x) / step) * step
  return {
    x: Math.round(Math.cos(angle) * DIRECTION_PRECISION) / DIRECTION_PRECISION,
    y: Math.round(Math.sin(angle) * DIRECTION_PRECISION) / DIRECTION_PRECISION,
  }
}
