import { GAME_TPS } from './constants.js'
import { attackDamage, damage, mark, stacks, subject, type Effect } from './effects.js'

// The ramp of a structure's shots: a turret, or a core that shoots like one, hits harder with every shot it lands on the same target. The first
// shot at someone does its damage, the next `step` more of it, and so on up to `max` times it, so with a step of 0.5 and a most of 4 a target
// that stays in reach is hit for 1x, 1.5x, 2x, 2.5x, 3x, 3.5x and then 4x every time. Standing under a turret gets worse the longer you stay, and
// a target that is out of reach for a while, or a new one, starts again from the first.
//
// It is kept as a stack of markers on the target, put there by the structure (see `mark`): one for each shot of the ramp, refreshed together by
// every shot, and gone `TURRET_RAMP_GRACE_TICKS` after the last one has had time to be followed by another. So it is in the frame and travels
// in snapshots and rolls back like any other marker, and each structure ramps on its own: two turrets on the same target each build their own.
// The damage reads the stack before the shot adds to it.

export interface TurretRamp {
  // How much more each shot does than the one before it, as a share of the first: 0.5 is half as much again, so 1x, 1.5x, 2x. More than 0.
  step: number
  // The most one shot does, as a multiple of the first: 4 is four times. 1 or more (1 is no ramp).
  max: number
}

// The ramp the turrets and the core of the game have: 1x, 1.5x, 2x, and on by a half to 4x.
export const TURRET_RAMP: Readonly<TurretRamp> = { step: 0.5, max: 4 }

// How long after a shot's own interval a structure goes on remembering whom it was shooting. A target that leaves its reach and comes back
// within this keeps the ramp it had; one that stays away longer starts again.
export const TURRET_RAMP_GRACE_TICKS = 2 * GAME_TPS

// What the marks of the ramp are called: the stacks on the target, which the page shows as pips under it.
export const TURRET_RAMP_KEY = 'focus'

// What is wrong with a ramp, if anything, said as a turret or a core says it of itself.
export function rampProblem(ramp: TurretRamp): string | undefined {
  if (!(Number.isFinite(ramp.step) && ramp.step > 0)) return 'needs a ramp with a step that is more than 0'
  if (!(Number.isFinite(ramp.max) && ramp.max >= 1)) return 'needs a ramp with a most that is 1 or more'
  return undefined
}

// How much a shot does, as a multiple of the first, when this many shots at the same target went before it.
export function rampMultiplier(ramp: TurretRamp, shots: number): number {
  return Math.min(ramp.max, 1 + ramp.step * Math.max(0, shots))
}

// How many shots it takes to reach the most: the size of the stack, which is not made any bigger than that.
export function rampStacks(ramp: TurretRamp): number {
  return Math.max(0, Math.ceil((ramp.max - 1) / ramp.step - 1e-9))
}

// What a shot does when it lands, for a structure that shoots `attackSpeed` times a second: its damage, times what the ramp says for the shots
// at this target so far, and then a stack of the ramp on the target, which lasts until the next shot is due and a grace after it.
export function rampedShot(ramp: TurretRamp, attackSpeed: number): Effect[] {
  const size = rampStacks(ramp)
  if (size === 0) return [damage(attackDamage())]
  const own = attackDamage()
  const shots = stacks(TURRET_RAMP_KEY, subject())
  // The same wait `Champion.attackCooldownTicks` gives, which a turret's attack speed never changes.
  const interval = Math.max(1, Math.ceil(GAME_TPS / attackSpeed))
  return [
    damage((sim, src) => own(sim, src) * rampMultiplier(ramp, shots(sim, src))),
    mark(TURRET_RAMP_KEY, interval + TURRET_RAMP_GRACE_TICKS, subject(), { cap: size }),
  ]
}
