import { z } from 'zod'

const TickSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const Vector2Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
})

export const MoveOrderSchema = z.object({
  id: z.string().min(1).max(160),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tick: TickSchema,
  type: z.literal('move'),
  target: Vector2Schema,
})

export const GameAttackOrderSchema = z.object({
  id: z.string().min(1).max(160),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tick: TickSchema,
  type: z.literal('attack'),
  targetId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

export const CastTargetSchema = z.discriminatedUnion('mode', [
  // Self-cast or nova.
  z.object({ mode: z.literal('none') }),
  // Ground-targeted, already clamped to range.
  z.object({ mode: z.literal('point'), point: Vector2Schema }),
  // Skillshot, normalized and quantized.
  z.object({ mode: z.literal('direction'), dir: Vector2Schema }),
  // Unit-targeted.
  z.object({ mode: z.literal('unit'), unitId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
])

export const CastOrderSchema = z.object({
  id: z.string().min(1).max(160),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  // Click tick (the client's synced estimate).
  tick: TickSchema,
  type: z.literal('cast'),
  // Resolved from the slot at click time, not the slot itself.
  abilityId: z.string().min(1).max(64),
  target: CastTargetSchema,
  // Caster position at click time, written explicitly.
  origin: Vector2Schema,
})

export const GameOrderSchema = z.discriminatedUnion('type', [
  MoveOrderSchema,
  GameAttackOrderSchema,
  CastOrderSchema,
])

const BroadcastFields = {
  entityId: z.number().int().positive(),
  playerId: z.string(),
  playerName: z.string(),
}

export const GameMoveSchema = MoveOrderSchema.extend(BroadcastFields)
export const GameAttackSchema = GameAttackOrderSchema.extend(BroadcastFields)
export const GameCastSchema = CastOrderSchema.extend(BroadcastFields)

export const GameBroadcastOrderSchema = z.discriminatedUnion('type', [
  GameMoveSchema,
  GameAttackSchema,
  GameCastSchema,
])

export const GameHealthStatsSchema = z.object({
  hp: z.number().int().nonnegative(),
  maxHp: z.number().int().positive(),
  shield: z.number().int().nonnegative(),
  hpSeq: TickSchema,
  finalizedTick: TickSchema,
  deathTick: TickSchema.optional(),
})

export const EntityOrderSchema = GameOrderSchema

// Deaths are authoritative inputs: the server confirms one, and every simulator applies
// it at the named tick instead of deriving it from health.
export const GameDeathTimingSchema = z.object({
  tick: TickSchema,
  respawnTick: TickSchema,
})

export const GameDeathSchema = GameDeathTimingSchema.extend({
  entityId: z.number().int().positive(),
})

export const GameOrderAckSchema = z.object({
  id: z.string().min(1).max(160),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['accepted', 'rejected']),
  serverTick: TickSchema,
  tick: TickSchema.optional(),
  reason: z.string().optional(),
})

export const GameOrderDeliveryAckSchema = z.object({
  id: z.string().min(1).max(160),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

export const GamePongSchema = z.object({
  clientTime: z.number().finite(),
  serverTick: TickSchema,
})

export const GameJoinSchema = z.object({
  lobbyCode: z.string().length(6),
  sessionId: z.string().min(1).max(100),
})

export const GameJoinedSchema = z.object({
  entityId: z.number().int().positive(),
  nextOrderSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  serverTick: TickSchema,
})

export const GameEntitySchema = z.object({
  id: z.number().int().positive(),
  initialPosition: Vector2Schema,
  orders: z.array(EntityOrderSchema),
  deaths: z.array(GameDeathTimingSchema).default([]),
  highestOrderSequence: TickSchema,
  championId: z.string().min(1).max(64),
  player: z.object({
    playerId: z.string(),
    name: z.string(),
  }).optional(),
  removedAtTick: TickSchema.optional(),
})

export const GameFrameMovementSchema = z.object({
  target: Vector2Schema,
})

// Statuses are active for frames in [startTick, endTick).
export const StatusSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['slow', 'shield']),
  rootId: z.string(),
  ownerId: z.number().int().positive(),
  startTick: TickSchema,
  endTick: TickSchema,
  amount: z.number().finite().nonnegative(),
})

// Markers are inert tags that later effects can read, active in [startTick, endTick).
export const MarkerSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  rootId: z.string(),
  ownerId: z.number().int().positive(),
  startTick: TickSchema,
  endTick: TickSchema,
})

const ActionTimingFields = {
  orderId: z.string().min(1),
  startTick: TickSchema,
  // Effects fire at launchTick; the action blocks new attacks and casts before it.
  launchTick: TickSchema,
  // Backswing ends at endTick; a move or new action may cancel it early.
  endTick: TickSchema,
}

export const GameFrameActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('attack'),
    targetId: z.number().int().positive(),
    ...ActionTimingFields,
  }),
  z.object({
    kind: z.literal('cast'),
    abilityId: z.string().min(1),
    target: CastTargetSchema,
    origin: Vector2Schema,
    ...ActionTimingFields,
  }),
])

export const GameFrameEntitySchema = z.object({
  entityId: z.number().int().positive(),
  position: Vector2Schema,
  health: GameHealthStatsSchema.optional(),
  nextAttackTick: TickSchema,
  movement: GameFrameMovementSchema.optional(),
  action: GameFrameActionSchema.optional(),
  // Ready tick per ability ID.
  cooldowns: z.record(z.string(), TickSchema),
  statuses: z.array(StatusSchema),
  markers: z.array(MarkerSchema),
  // Orders written by effects; they resolve after logged orders on their tick.
  queuedOrders: z.array(EntityOrderSchema),
})

export const GameFrameProjectileSchema = z.object({
  id: z.string().min(1),
  defId: z.string().min(1),
  rootId: z.string(),
  ownerId: z.number().int().positive(),
  origin: Vector2Schema,
  velocity: Vector2Schema,
  startTick: TickSchema,
  lifetimeTicks: z.number().int().positive(),
  hitIds: z.array(z.number().int().positive()),
})

export const GameFrameSchema = z.object({
  tick: TickSchema,
  entities: z.array(GameFrameEntitySchema),
  projectiles: z.array(GameFrameProjectileSchema),
})

export const GameSnapshotSchema = z.object({
  tick: TickSchema,
  commitTick: TickSchema,
  entities: z.array(GameEntitySchema),
  checkpoint: GameFrameSchema,
}).refine(
  ({ tick, commitTick, checkpoint }) =>
    checkpoint.tick === commitTick && commitTick <= tick,
  { message: 'Checkpoint must match the commit tick and not exceed the current tick.' },
)

export const GameStatusSchema = z.enum(['idle', 'starting', 'running'])

export type Vector2 = z.infer<typeof Vector2Schema>
export type MoveOrder = z.infer<typeof MoveOrderSchema>
export type GameOrder = z.infer<typeof GameOrderSchema>
export type GameAttackOrder = z.infer<typeof GameAttackOrderSchema>
export type CastTarget = z.infer<typeof CastTargetSchema>
export type CastOrder = z.infer<typeof CastOrderSchema>
export type GameAttack = z.infer<typeof GameAttackSchema>
export type GameCast = z.infer<typeof GameCastSchema>
export type GameBroadcastOrder = z.infer<typeof GameBroadcastOrderSchema>
export type GameHealthStats = z.infer<typeof GameHealthStatsSchema>
export type GameDeathTiming = z.infer<typeof GameDeathTimingSchema>
export type GameDeath = z.infer<typeof GameDeathSchema>
export type GameFrame = z.infer<typeof GameFrameSchema>
export type GameFrameEntity = z.infer<typeof GameFrameEntitySchema>
export type GameFrameMovement = z.infer<typeof GameFrameMovementSchema>
export type GameFrameAction = z.infer<typeof GameFrameActionSchema>
export type SimProjectile = z.infer<typeof GameFrameProjectileSchema>
export type Status = z.infer<typeof StatusSchema>
export type Marker = z.infer<typeof MarkerSchema>
export type EntityOrder = z.infer<typeof EntityOrderSchema>
export type GameOrderAck = z.infer<typeof GameOrderAckSchema>
export type GameOrderDeliveryAck = z.infer<typeof GameOrderDeliveryAckSchema>
export type GameMove = z.infer<typeof GameMoveSchema>
export type GamePong = z.infer<typeof GamePongSchema>
export type GameJoin = z.infer<typeof GameJoinSchema>
export type GameJoined = z.infer<typeof GameJoinedSchema>
export type GameEntitySnapshot = z.infer<typeof GameEntitySchema>
export type GameSnapshot = z.infer<typeof GameSnapshotSchema>
export type GameStatus = z.infer<typeof GameStatusSchema>

export * from './constants.js'
export {
  aimPoint,
  castOrigin,
  damage,
  enemiesInRadius,
  fireProjectile,
  getProjectileDef,
  mark,
  resetAutoTimer,
  runEffects,
  self,
  shield,
  slow,
  subject,
  targetUnit,
} from './effects.js'
export type {
  Amount,
  Anchor,
  Effect,
  EffectSource,
  GameEvent,
  ProjectileDef,
  Selector,
  SimContext,
  SimReader,
  SimWriter,
} from './effects.js'
export { abilityDefs, getAbilityDef, quantizeDirection } from './abilities.js'
export type { AbilityDef } from './abilities.js'
export { Champion, champions, DEFAULT_CHAMPION_ID, getChampion } from './champions.js'
export type { ChampionDef } from './champions.js'
export {
  EntityTickSnapshot,
  GameTickSnapshot,
  projectilePosAt,
  SimEntity,
  Simulator,
} from './simulator.js'
export { ReliableMessenger, parseIdentifiedMessage } from './reliable-messages.js'
export type { IdentifiedMessage } from './reliable-messages.js'
export { lagConfigFromQuery, noLag, withLag } from './lag-simulator.js'
export type { LagConfig } from './lag-simulator.js'
