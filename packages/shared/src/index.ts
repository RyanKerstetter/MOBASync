import { z } from 'zod'
import { GAME_MODE_IDS } from './modes.js'

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
  // Kills made up to the snapshot's commit tick: the ones that can no longer be undone.
  kills: z.number().int().nonnegative().default(0),
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

// What a monster is up to (see ai.ts): idle at home, after someone, or walking home. It is in the frame because
// it is not something that can be worked out from the rest of it: a monster that is after someone stays after
// them until it gives up, wherever they go. Only monsters have it.
export const AiStateSchema = z.object({
  mode: z.enum(['idle', 'chase', 'return']),
  // Whom it is after, while it is chasing.
  targetId: z.number().int().positive().optional(),
  // The last player to hurt it, which an idle monster goes after on its next tick (see `AiProfileDef.aggroOnHit`).
  provokedBy: z.number().int().positive().optional(),
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
  ai: AiStateSchema.optional(),
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

export const GameModeSchema = z.enum(GAME_MODE_IDS)

// The area of the map that is the hill, in world units: the box it fits in, and whether it is the
// ellipse in that box (a circle, if the box is square) or the whole box.
export const HillAreaSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  ellipse: z.boolean(),
})

// How the game is played, for every mode, fixed for the whole game: how many ticks a champion stays dead
// (the default if absent), and the score a team wins at (no limit if absent).
const RulesFields = {
  respawnTicks: z.number().int().positive().optional(),
  scoreLimit: z.number().int().positive().optional(),
}

// What a game of a mode is played on, fixed for the whole game: the hill, or where each team's flag is
// at home. A snapshot without one is a game of team deathmatch with the default rules.
export const ModeSetupSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deathmatch'), ...RulesFields }),
  z.object({
    kind: z.literal('koth'),
    hill: HillAreaSchema,
    // How many ticks a team takes to fill the hill's bar (the default if absent).
    captureTicks: z.number().int().positive().optional(),
    ...RulesFields,
  }),
  z.object({
    kind: z.literal('ctf'),
    flags: z.array(z.object({ team: z.number().int().positive(), home: Vector2Schema })),
    ...RulesFields,
  }),
])

// Points by team, keyed by the team's number.
const ScoresSchema = z.record(z.string(), z.number().int().nonnegative())

// How the game's objective stands on a tick (see `advanceObjective`). In team deathmatch it is the kills each
// team has made, which are kept here and not worked out from the characters, so they stay when a player leaves.
export const ObjectiveStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deathmatch'), scores: ScoresSchema }),
  z.object({
    kind: z.literal('koth'),
    // Whose bar the hill's bar is, while it has anything in it, and how full it is in ticks of capturing.
    capturer: z.number().int().positive().optional(),
    progress: z.number().int().nonnegative(),
    scores: ScoresSchema,
  }),
  z.object({
    kind: z.literal('ctf'),
    flags: z.array(z.object({
      // The team the flag belongs to.
      team: z.number().int().positive(),
      // Where it is: at home, dropped on the ground, or with whoever carries it.
      position: Vector2Schema,
      carrierId: z.number().int().positive().optional(),
    })),
    scores: ScoresSchema,
  }),
])

export const GameFrameSchema = z.object({
  tick: TickSchema,
  characters: z.array(GameFrameCharacterSchema),
  entities: z.array(GameFrameEntitySchema),
  objective: ObjectiveStateSchema.optional(),
})

// The ground a game is played on: the arena's size, and each wall as [x, y, width, height], in world
// units. A snapshot without one is on the plain arena.
export const TerrainSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  walls: z.array(z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()])),
})

export const GameSnapshotSchema = z.object({
  tick: TickSchema,
  commitTick: TickSchema,
  terrain: TerrainSchema.optional(),
  mode: ModeSetupSchema.optional(),
  // The map the game is played on (see `MapSummary`), so a page can check it drew the same one.
  map: z.string().min(1).max(100).optional(),
  characters: z.array(GameCharacterSchema),
  checkpoint: GameFrameSchema,
}).refine(
  ({ tick, commitTick, checkpoint }) =>
    checkpoint.tick === commitTick && commitTick <= tick,
  { message: 'Checkpoint must match the commit tick and not exceed the current tick.' },
)

// A game is idle (no game: the lobby), picking champions, loading, running, or finished: over, with its results
// shown, until every player has gone back to the lobby.
export const GameStatusSchema = z.enum(['idle', 'selecting', 'starting', 'running', 'finished'])

// How a game ended, as every player is shown it: who won (the team ahead, or none if none was), how each team
// scored, and what each player did. `reason` is a team reaching the score limit, or the leader ending the game.
export const GameResultSchema = z.object({
  mode: GameModeSchema,
  reason: z.enum(['limit', 'ended']),
  winner: z.number().int().positive().optional(),
  scoreLimit: z.number().int().positive().optional(),
  teams: z.array(z.object({
    team: z.number().int().positive(),
    score: z.number().int().nonnegative(),
  })),
  players: z.array(z.object({
    name: z.string(),
    team: z.number().int().positive(),
    kills: z.number().int().nonnegative(),
    // They went back to the lobby before the game ended.
    left: z.boolean().optional(),
  })),
})

export type Vector2 = z.infer<typeof Vector2Schema>
export type MoveOrder = z.infer<typeof MoveOrderSchema>
export type GameOrder = z.infer<typeof GameOrderSchema>
export type GameAttackOrder = z.infer<typeof GameAttackOrderSchema>
export type CastTarget = z.infer<typeof CastTargetSchema>
export type CastOrder = z.infer<typeof CastOrderSchema>
export type GameBroadcastOrder = z.infer<typeof GameBroadcastOrderSchema>
export type GameHealthStats = z.infer<typeof GameHealthStatsSchema>
export type GameFrame = z.infer<typeof GameFrameSchema>
export type GameFrameCharacter = z.infer<typeof GameFrameCharacterSchema>
export type GameFrameAction = z.infer<typeof GameFrameActionSchema>
export type SimEntity = z.infer<typeof GameFrameEntitySchema>
export type Status = z.infer<typeof StatusSchema>
export type Marker = z.infer<typeof MarkerSchema>
export type CharacterOrder = z.infer<typeof CharacterOrderSchema>
export type GameOrderAck = z.infer<typeof GameOrderAckSchema>
export type GameCharacterSnapshot = z.infer<typeof GameCharacterSchema>
export type GameSnapshot = z.infer<typeof GameSnapshotSchema>
export type GameStatus = z.infer<typeof GameStatusSchema>
export type AiState = z.infer<typeof AiStateSchema>
export type GameMode = z.infer<typeof GameModeSchema>
export type GameResult = z.infer<typeof GameResultSchema>
export type HillArea = z.infer<typeof HillAreaSchema>
export type ModeSetup = z.infer<typeof ModeSetupSchema>
export type ObjectiveState = z.infer<typeof ObjectiveStateSchema>

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
  damage,
  dash,
  dodge,
  enemiesInBox,
  enemiesInLine,
  enemiesInRadius,
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
  DashDef,
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
  getAbilityDef,
  meetsRequirement,
  quantizeDirection,
  withinCastRange,
} from './abilities.js'
export type { AbilityDef, AbilityIndicator } from './abilities.js'
export {
  dirname,
  findTileset,
  flattenLayers,
  flipMatrix,
  getProperty,
  mapContentBounds,
  mapWorldScale,
  parseTiledMap,
  parseTiledTileset,
  resolveAssetPath,
  splitGid,
  tileLayerCells,
  tileRect,
} from './tiled.js'
export type {
  ImageLayer,
  ObjectLayer,
  TileLayer,
  TiledMap,
  TiledObject,
  Tileset,
} from './tiled.js'
export { balancedTeam, GAME_TEAMS, getTeam, isMonsterTeam, isTeamId, MONSTER_TEAM, teamHasRoom } from './teams.js'
export { assignSpawns, rankTeams, spawnPointsNeeded } from './spawns.js'
export {
  advanceObjective,
  applyRulesChange,
  CAPTURE_SECONDS,
  createModeSetup,
  defaultRules,
  DEFAULT_GAME_MODE,
  GAME_MODE_IDS,
  GAME_MODES,
  getGameMode,
  hillCaptureTicks,
  hillContains,
  hillLeader,
  hillMovement,
  hillOwner,
  hillPresence,
  initialObjective,
  isGameMode,
  leadingTeam,
  modeRules,
  modeStartProblem,
  modeSupportProblem,
  NO_OBJECTIVES,
  objectiveScores,
  readRulesChange,
  RESPAWN_SECONDS,
  teamCountProblem,
  winningTeam,
} from './modes.js'
export type { GameModeDef, HillMovement, LobbyRules, MapObjectives, ModeRules, ObjectiveUnit, RulesChange, ScoreName } from './modes.js'
export { Terrain } from './terrain.js'
export type { Rect, TerrainData } from './terrain.js'
export { createVisibilityGraph } from './visibility-graph.js'
export type { PathfinderFactory, PathWorld, Pathfinder } from './pathfinding.js'
export type { SpawnSlots } from './spawns.js'
export { readMapLayout } from './map-layout.js'
export {
  mapDisplayName,
  mapRoomText,
  startProblem,
  summarizeMap,
  supportedModes,
  teamSetupProblem,
  unplayableMap,
} from './maps.js'
export type { MapCapabilities, MapSummary } from './maps.js'
export type { MapLayout, MapMonster, MapRect } from './map-layout.js'
export { Champion, champions, DEFAULT_CHAMPION_ID, getChampion } from './champions.js'
export { aimAt, think } from './ai.js'
export type { AiBody, AiDecision, AiOrder, AiOther } from './ai.js'
export { getCharacterChampion, getMonster, Monster, monsters } from './monsters.js'
export type { AiAbilityRule, AiProfile, AiProfileDef, MonsterDef } from './monsters.js'
export type { ChampionDef } from './champions.js'
export {
  CharacterTickSnapshot,
  GameTickSnapshot,
  entityPosAt,
  SimCharacter,
  Simulator,
} from './simulator.js'
export type { DeathRecord } from './simulator.js'
export { ReliableMessenger, parseIdentifiedMessage } from './reliable-messages.js'
export type { IdentifiedMessage } from './reliable-messages.js'
export type { ChatMessage, PublicLobby, PublicPlayer } from './lobby.js'
export { lagConfigFromQuery, withLag } from './lag-simulator.js'
export type { LagConfig } from './lag-simulator.js'
