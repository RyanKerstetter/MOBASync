import { z } from 'zod'

export const Vector2Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
})

export const MoveOrderSchema = z.object({
  id: z.string().min(1).max(160),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  type: z.literal('move'),
  target: Vector2Schema,
})

export const GameAttackOrderSchema = z.object({
  id: z.string().min(1).max(160),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  type: z.literal('attack'),
  targetId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

export const GameOrderSchema = z.discriminatedUnion('type', [
  MoveOrderSchema,
  GameAttackOrderSchema,
])

export const GameMoveSchema = MoveOrderSchema.extend({
  entityId: z.number().int().positive(),
  playerId: z.string(),
  playerName: z.string(),
})

export const GameAttackSchema = GameAttackOrderSchema.extend({
  entityId: z.number().int().positive(),
  playerId: z.string(),
  playerName: z.string(),
})

export const GameBroadcastOrderSchema = z.discriminatedUnion('type', [
  GameMoveSchema,
  GameAttackSchema,
])

export const GameHealthStatsSchema = z.object({
  hp: z.number().int().nonnegative(),
  maxHp: z.number().int().positive(),
  shield: z.number().int().nonnegative(),
  hpSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  finalizedTick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deathTick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
})

export const GameAttackStatsSchema = z.object({
  attackSpeed: z.number().finite().positive(),
  attackRange: z.number().finite().positive(),
})

export const EntityOrderSchema = GameOrderSchema

export const GameOrderAckSchema = z.object({
  id: z.string().min(1).max(160),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['accepted', 'rejected']),
  serverTick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  reason: z.string().optional(),
})

export const GameOrderDeliveryAckSchema = z.object({
  id: z.string().min(1).max(160),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

export const GamePongSchema = z.object({
  clientTime: z.number().finite(),
  serverTick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})

export const GameJoinSchema = z.object({
  lobbyCode: z.string().length(6),
  sessionId: z.string().min(1).max(100),
})

export const GameJoinedSchema = z.object({
  entityId: z.number().int().positive(),
  nextOrderSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  serverTick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})

export const GameEntitySchema = z.object({
  id: z.number().int().positive(),
  initialPosition: Vector2Schema,
  orders: z.array(EntityOrderSchema),
  highestOrderSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  health: GameHealthStatsSchema.optional(),
  attackStats: GameAttackStatsSchema.optional(),
  player: z.object({
    playerId: z.string(),
    name: z.string(),
  }).optional(),
  removedAtTick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
})

export const GameProjectileSchema = z.object({
  id: z.number().int().positive(),
  initialPosition: Vector2Schema,
  initialTick: z.number().int().nonnegative(),
  velocity: Vector2Schema,
  lifetimeTicks: z.number().int().positive(),
})

export const GameFrameMovementSchema = z.object({
  origin: Vector2Schema,
  target: Vector2Schema,
  startTick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})

export const GameFrameEntitySchema = z.object({
  entityId: z.number().int().positive(),
  position: Vector2Schema,
  health: GameHealthStatsSchema.optional(),
  nextAttackTick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  movement: GameFrameMovementSchema.optional(),
})

export const GameFrameSchema = z.object({
  tick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  entities: z.array(GameFrameEntitySchema),
})

export const GameSnapshotSchema = z.object({
  tick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  commitTick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  entities: z.array(GameEntitySchema),
  projectiles: z.array(GameProjectileSchema),
  history: z.array(GameFrameSchema),
})

export const GameStatusSchema = z.enum(['idle', 'starting', 'running'])

export const GAME_ARENA_WIDTH = 800
export const GAME_ARENA_HEIGHT = 450
export const GAME_PLAYER_RADIUS = 18
export const GAME_PLAYER_SPEED = 220
export const GAME_TPS = 60
export const GAME_FPS = 60
export const GAME_MAX_HP = 10
export const GAME_MAX_SHIELD = 1
export const GAME_ATTACK_DAMAGE = 1
export const GAME_ATTACK_SPEED = 1
export const GAME_ATTACK_RANGE = 150
export const GAME_ATTACK_WINDUP_TICKS = 0
export const GAME_ORDER_WINDOW_TICKS = 12
export const GAME_SNAPSHOT_HISTORY_TICKS = GAME_ORDER_WINDOW_TICKS + 2
export const FINALIZE_LAG = GAME_ORDER_WINDOW_TICKS
export const GAME_REMOTE_CATCHUP_MAX_SPEED_MULTIPLIER = 3
export const GAME_REMOTE_CATCHUP_EASE_TICKS = 5
export const GAME_ORDER_TIMEOUT_MS = 200
export const GAME_ORDER_VERDICT_RETENTION_MS = GAME_ORDER_TIMEOUT_MS * 2
export const GAME_ATTACK_BACKDATE_CAP_TICKS = GAME_ORDER_WINDOW_TICKS
export const GAME_PING_INTERVAL_MS = 1000

export type Vector2 = z.infer<typeof Vector2Schema>
export type MoveOrder = z.infer<typeof MoveOrderSchema>
export type GameOrder = z.infer<typeof GameOrderSchema>
export type GameAttackOrder = z.infer<typeof GameAttackOrderSchema>
export type GameAttack = z.infer<typeof GameAttackSchema>
export type GameBroadcastOrder = z.infer<typeof GameBroadcastOrderSchema>
export type GameHealthStats = z.infer<typeof GameHealthStatsSchema>
export type GameAttackStats = z.infer<typeof GameAttackStatsSchema>
export type GameFrame = z.infer<typeof GameFrameSchema>
export type GameFrameEntity = z.infer<typeof GameFrameEntitySchema>
export type GameFrameMovement = z.infer<typeof GameFrameMovementSchema>
export type EntityOrder = z.infer<typeof EntityOrderSchema>
export type GameOrderAck = z.infer<typeof GameOrderAckSchema>
export type GameOrderDeliveryAck = z.infer<typeof GameOrderDeliveryAckSchema>
export type GameMove = z.infer<typeof GameMoveSchema>
export type GamePong = z.infer<typeof GamePongSchema>
export type GameJoin = z.infer<typeof GameJoinSchema>
export type GameJoined = z.infer<typeof GameJoinedSchema>
export type GameEntitySnapshot = z.infer<typeof GameEntitySchema>
export type GameProjectileSnapshot = z.infer<typeof GameProjectileSchema>
export type GameSnapshot = z.infer<typeof GameSnapshotSchema>
export type GameStatus = z.infer<typeof GameStatusSchema>

export function getAttackCooldownTicks(attackSpeed: number): number {
  return Math.max(1, Math.ceil(GAME_TPS / attackSpeed))
}

export { AttackStats, EntityTickSnapshot, GameTickSnapshot, HealthStats, Simulator } from './simulator.js'
export { ReliableMessenger, parseIdentifiedMessage } from './reliable-messages.js'
export type { IdentifiedMessage } from './reliable-messages.js'
