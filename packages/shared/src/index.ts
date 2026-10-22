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

// An order is sent to every player with only who gave it. Their name and session are already known
// from the lobby, and the order id (`characterId:seq`) is kept short because it is repeated through
// the game state.
const BroadcastFields = {
  characterId: z.number().int().positive(),
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
  hpSeq: TickSchema,
  finalizedTick: TickSchema,
  deathTick: TickSchema.optional(),
})

export const CharacterOrderSchema = GameOrderSchema

// Deaths are authoritative inputs: the server confirms one, and every simulator applies
// it at the named tick instead of deriving it from health.
export const GameDeathTimingSchema = z.object({
  tick: TickSchema,
  respawnTick: TickSchema,
})

export const GameDeathSchema = GameDeathTimingSchema.extend({
  characterId: z.number().int().positive(),
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
  characterId: z.number().int().positive(),
  nextOrderSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  serverTick: TickSchema,
})

export const GameCharacterSchema = z.object({
  id: z.number().int().positive(),
  initialPosition: Vector2Schema,
  orders: z.array(CharacterOrderSchema),
  deaths: z.array(GameDeathTimingSchema).default([]),
  highestOrderSequence: TickSchema,
  championId: z.string().min(1).max(64),
  // Who it is on. Characters with the same team are teammates; anyone else is an enemy.
  team: z.number().int().positive(),
  player: z.object({
    playerId: z.string(),
    name: z.string(),
  }).optional(),
  removedAtTick: TickSchema.optional(),
})

export const GameFrameMovementSchema = z.object({
  target: Vector2Schema,
})

// Forced movement toward a target at its own fixed speed, such as a dash. While it lasts it
// replaces walking, and slows and haste do not change it.
export const GameFrameDashSchema = z.object({
  target: Vector2Schema,
  speed: z.number().finite().positive(),
  // A dash that passes through other characters instead of shoving them along.
  through: z.boolean().optional(),
  // A dash whose effects happen as it goes: the definition that has them, where it started from, the
  // cast that made it (which its effects are credited to), and the enemies it has already touched.
  contact: z.object({
    defId: z.string().min(1),
    origin: Vector2Schema,
    sourceId: z.string().min(1),
    orderId: z.string().min(1),
    hitIds: z.array(z.number().int().positive()),
  }).optional(),
})

// Statuses are active for frames in [startTick, endTick).
export const StatusSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['slow', 'haste', 'attackspeed', 'attackrange', 'resist', 'root', 'stun', 'shield', 'burn', 'blind', 'silence', 'dodge']),
  rootId: z.string(),
  ownerId: z.number().int().positive(),
  startTick: TickSchema,
  endTick: TickSchema,
  // A burn's damage for each pulse; a blind has no amount of its own.
  amount: z.number().finite().nonnegative(),
  // A haste that dies away: its amount is full when it starts and falls in a straight line to
  // nothing at endTick, instead of staying the same until it ends.
  fades: z.boolean().optional(),
})

// Markers are inert tags that later effects can read, active in [startTick, endTick).
export const MarkerSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  rootId: z.string(),
  ownerId: z.number().int().positive(),
  startTick: TickSchema,
  endTick: TickSchema,
  // When set, only the newest `cap` markers of this key and owner stay on a unit.
  cap: z.number().int().positive().optional(),
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

// Who a character is going after. An attack order sets it, and it stays until the character is
// told to do something else or the target is gone: the character walks up to it and attacks it
// again and again.
export const GameFrameAttackTargetSchema = z.object({
  targetId: z.number().int().positive(),
  // The order that set it, which the attacks it makes are credited to.
  orderId: z.string().min(1),
})

export const GameFrameCharacterSchema = z.object({
  characterId: z.number().int().positive(),
  position: Vector2Schema,
  health: GameHealthStatsSchema.optional(),
  nextAttackTick: TickSchema,
  movement: GameFrameMovementSchema.optional(),
  attackTarget: GameFrameAttackTargetSchema.optional(),
  dash: GameFrameDashSchema.optional(),
  action: GameFrameActionSchema.optional(),
  // Ready tick per ability ID.
  cooldowns: z.record(z.string(), TickSchema),
  statuses: z.array(StatusSchema),
  markers: z.array(MarkerSchema),
  // Orders written by effects; they resolve after logged orders on their tick.
  queuedOrders: z.array(CharacterOrderSchema),
})

export const GameFrameEntitySchema = z.object({
  id: z.string().min(1),
  defId: z.string().min(1),
  rootId: z.string(),
  ownerId: z.number().int().positive(),
  origin: Vector2Schema,
  velocity: Vector2Schema,
  startTick: TickSchema,
  // Absent for an entity that stays until its `stayWhile` ends it.
  lifetimeTicks: z.number().int().positive().optional(),
  hitIds: z.array(z.number().int().positive()),
  // Which way a rectangular entity points (a unit vector); circles have none.
  facing: Vector2Schema.optional(),
  // Where an entity that follows its owner is now. Its path is not a straight line, so it cannot
  // be worked out from the origin and velocity; once it has moved it is stored each tick.
  position: Vector2Schema.optional(),
  // The unit a homing entity is chasing. Like `position`, it is stored because it cannot be worked
  // out from the origin and velocity.
  targetId: z.number().int().positive().optional(),
})

export const GameFrameSchema = z.object({
  tick: TickSchema,
  characters: z.array(GameFrameCharacterSchema),
  entities: z.array(GameFrameEntitySchema),
})

export const GameSnapshotSchema = z.object({
  tick: TickSchema,
  commitTick: TickSchema,
  characters: z.array(GameCharacterSchema),
  checkpoint: GameFrameSchema,
}).refine(
  ({ tick, commitTick, checkpoint }) =>
    checkpoint.tick === commitTick && commitTick <= tick,
  { message: 'Checkpoint must match the commit tick and not exceed the current tick.' },
)

export const GameStatusSchema = z.enum(['idle', 'selecting', 'starting', 'running'])

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
export type GameFrameCharacter = z.infer<typeof GameFrameCharacterSchema>
export type GameFrameMovement = z.infer<typeof GameFrameMovementSchema>
export type GameFrameAttackTarget = z.infer<typeof GameFrameAttackTargetSchema>
export type GameFrameDash = z.infer<typeof GameFrameDashSchema>
export type GameFrameAction = z.infer<typeof GameFrameActionSchema>
export type SimEntity = z.infer<typeof GameFrameEntitySchema>
export type Status = z.infer<typeof StatusSchema>
export type Marker = z.infer<typeof MarkerSchema>
export type CharacterOrder = z.infer<typeof CharacterOrderSchema>
export type GameOrderAck = z.infer<typeof GameOrderAckSchema>
export type GameOrderDeliveryAck = z.infer<typeof GameOrderDeliveryAckSchema>
export type GameMove = z.infer<typeof GameMoveSchema>
export type GamePong = z.infer<typeof GamePongSchema>
export type GameJoin = z.infer<typeof GameJoinSchema>
export type GameJoined = z.infer<typeof GameJoinedSchema>
export type GameCharacterSnapshot = z.infer<typeof GameCharacterSchema>
export type GameSnapshot = z.infer<typeof GameSnapshotSchema>
export type GameStatus = z.infer<typeof GameStatusSchema>

export * from './constants.js'
export { boxTouchesCircle } from './geometry.js'
export type { BoxShape } from './geometry.js'
export {
  aimPoint,
  alliesInBox,
  alliesInRadius,
  alongAim,
  attackDamage,
  attackRangeBonus,
  attackSpeedBonus,
  blind,
  blink,
  burn,
  capCooldown,
  castOrigin,
  damage,
  dash,
  dodge,
  enemiesInBox,
  enemiesInLine,
  enemiesInRadius,
  getDashDef,
  getEntityDef,
  haste,
  heal,
  interrupt,
  knockback,
  linear,
  loseHealth,
  mark,
  missingHealth,
  ownEntity,
  popMarkers,
  reduceCooldown,
  refundCooldown,
  removeEntities,
  resetAutoTimer,
  resist,
  root,
  runEffects,
  self,
  selfInRadius,
  shield,
  silence,
  slow,
  spawnEntity,
  stacks,
  startCooldown,
  stun,
  subject,
  subjectWithin,
  targetUnit,
  when,
} from './effects.js'
export type {
  Amount,
  Anchor,
  DashDef,
  Effect,
  EffectSource,
  GameEvent,
  EntityDef,
  Selector,
  SimContext,
  SimReader,
  SimWriter,
} from './effects.js'
export {
  abilityDefs,
  abilityOnKey,
  beyondMinCastRange,
  getAbilityDef,
  meetsRequirement,
  quantizeDirection,
  withinCastRange,
} from './abilities.js'
export type { AbilityDef, AbilityIndicator } from './abilities.js'
export { balancedTeam, GAME_TEAMS, getTeam, isTeamId, teamSpawnPositions } from './teams.js'
export type { TeamDef } from './teams.js'
export { Champion, champions, DEFAULT_CHAMPION_ID, getChampion } from './champions.js'
export type { AttackProjectileDef, ChampionDef } from './champions.js'
export {
  CharacterTickSnapshot,
  GameTickSnapshot,
  entityPosAt,
  SimCharacter,
  Simulator,
} from './simulator.js'
export { ReliableMessenger, parseIdentifiedMessage } from './reliable-messages.js'
export type { IdentifiedMessage } from './reliable-messages.js'
export { lagConfigFromQuery, noLag, withLag } from './lag-simulator.js'
export type { LagConfig } from './lag-simulator.js'
