import { abilityDefs, beyondMinCastRange, meetsRequirement, readyKey, withinCastRange, type AbilityDef } from './abilities.js'
import { boxTouchesCircle, distanceToSegment } from './geometry.js'
import { think, type AiBody, type AiOrder, type AiOther } from './ai.js'
import { DEFAULT_CHAMPION_ID, getChampion, type Champion } from './champions.js'
import {
  GAME_BURN_PULSE_TICKS,
  GAME_CAST_ORIGIN_TOLERANCE,
  GAME_COLLISION_STIFFNESS,
  GAME_MONSTER_TEAM,
  GAME_RESPAWN_TICKS,
  GAME_SNAPSHOT_HISTORY_TICKS,
  GAME_TPS,
} from './constants.js'
import {
  areEnemies,
  ATTACK_SOURCE_PREFIX,
  getDashDef,
  getEntityDef,
  mark,
  runEffects,
  self,
  type GameEvent,
  type SimContext,
} from './effects.js'
import { advanceObjective, initialObjective, modeHasEconomy, type ObjectiveCore, type ObjectiveUnit } from './modes.js'
import { cores, type Core } from './cores.js'
import { getCharacterChampion, monsters, type Monster } from './monsters.js'
import { buyProblem, getItem, ITEM_SLOTS, itemTotals, sellValue, withItems, type Inventory } from './items.js'
import { GAME_STARTING_GOLD, levelForXp, monsterLevelAfterKill, monsterXpAt, PLAYER_KILL_REWARD, type Resources } from './progression.js'
import { mayShop, type ShopZone } from './shops.js'
import { hastedCooldownTicks, statMultiplier, type ChampionStats } from './stats.js'
import { Terrain } from './terrain.js'
import { shieldedStructures, type StructureRef } from './structures.js'
import { chooseTurretTarget, turrets, type Turret, type TurretPrey } from './turrets.js'
import type {
  AiState,
  BuyOrder,
  CastOrder,
  CastTarget,
  CharacterOrder,
  GameAttackOrder,
  GameCharacterSnapshot,
  GameFrame,
  GameFrameAction,
  GameFrameCharacter,
  GameHealthStats,
  GameSnapshot,
  Marker,
  ModeSetup,
  ObjectiveState,
  SellOrder,
  SimEntity,
  Status,
  Vector2,
} from './index.js'

const DIRECTION_LENGTH_TOLERANCE = 0.01

// A character dying: the tick it died on, who it was, and who did the damage that took its last
// health (nobody, if it was its own).
export type DeathRecord = {
  tick: number
  victimId: number
  killerId?: number
}

// A step of a dash that has effects of its own: where it started from this tick, what the dash
// carries (and the enemies it has touched so far), and whether this step finished it.
type DashStep = {
  characterId: number
  from: Vector2
  contact: NonNullable<NonNullable<GameFrameCharacter['dash']>['contact']>
  finished: boolean
}

export class SimCharacter {
  readonly orders: CharacterOrder[]
  // The deaths it has caused that can no longer be undone, which are the ones at or before the
  // commit tick. A death after it may still be undone by an order that has not arrived yet.
  kills: number
  // What those kills have paid in shards, which are kept the same way. They are the character's and not a frame's, so they are kept through a
  // death and a respawn. (The experience, which is its level, and the gold, which buys its items, are in the frame: see `GameFrameCharacter.xp`
  // and `.gold`.)
  shards: number
  private lastOrderSequence: number

  constructor(
    readonly id: number,
    readonly initialPosition: Vector2,
    orders: CharacterOrder[],
    readonly champion: Champion,
    readonly player?: GameCharacterSnapshot['player'],
    highestOrderSequence = 0,
    kills = 0,
    // Characters on the same team are teammates. By default each is on a team of its own, so
    // everyone is an enemy of everyone else.
    readonly team: number = id,
    resources: Partial<Pick<Resources, 'shards'>> = {},
  ) {
    this.orders = orders.map(cloneOrder).sort(compareCharacterOrders)
    this.kills = kills
    this.shards = resources.shards ?? 0
    this.lastOrderSequence = Math.max(
      highestOrderSequence,
      ...this.orders.map((order) => order.seq),
    )
  }

  // What it is, if it is a monster: a character the game plays (see monsters.ts), which a player does not.
  get monster(): Monster | undefined {
    const monster = monsters.get(this.champion.id)
    return monster?.champion === this.champion ? monster : undefined
  }

  // What it is, if it is a turret: a structure the map puts on the ground, which shoots the enemy players in its range and does
  // not move (see turrets.ts).
  get turret(): Turret | undefined {
    const turret = turrets.get(this.champion.id)
    return turret?.champion === this.champion ? turret : undefined
  }

  // What it is, if it is a core: the structure that decides Core Destruction, which does not move or attack (see cores.ts).
  get core(): Core | undefined {
    const core = cores.get(this.champion.id)
    return core?.champion === this.champion ? core : undefined
  }

  // Whether it is a structure, a turret or a core: it stands where it was put, is solid, is hurt by attacks only and never by an
  // ability, takes no status, and is destroyed for good (see structures.ts).
  get structure(): boolean {
    return this.turret !== undefined || this.core !== undefined
  }

  // Whether the game plays it (a monster, a turret or a core) and not a player. None of these scores, holds the hill or carries a flag,
  // and none is paid for what it kills.
  get isNpc(): boolean {
    return this.monster !== undefined || this.structure
  }

  // What it is to the rules of structures, if it is one.
  asStructure(): StructureRef | undefined {
    const turret = this.turret
    if (turret) return { id: this.id, team: this.team, turretTier: turret.tier }
    const core = this.core
    return core ? { id: this.id, team: this.team, guardedByTier: core.guardedByTier } : undefined
  }

  // Takes the shards a kill paid. (Its experience and gold are paid in the frame, on the tick of the kill.)
  earn(reward: Readonly<Resources>): void {
    this.shards += reward.shards
  }

  get highestOrderSequence(): number {
    return this.lastOrderSequence
  }

  recordOrderSequence(seq: number): void {
    this.lastOrderSequence = Math.max(this.lastOrderSequence, seq)
  }

  snapshot(): GameCharacterSnapshot {
    return {
      id: this.id,
      initialPosition: { ...this.initialPosition },
      orders: this.orders.map(cloneOrder),
      kills: this.kills,
      shards: this.shards,
      highestOrderSequence: this.highestOrderSequence,
      championId: this.champion.id,
      team: this.team,
      ...(this.player ? { player: { ...this.player } } : {}),
    }
  }
}

export class CharacterTickSnapshot {
  constructor(
    private readonly state: GameFrameCharacter,
    private readonly tick: number,
  ) {}

  getPosition(): Vector2 {
    return { ...this.state.position }
  }

  getHealth(): number | undefined {
    return this.state.health?.hp
  }

  getHealthState(): GameHealthStats | undefined {
    return this.state.health ? { ...this.state.health } : undefined
  }

  // Every active shield status; characters have no shield of their own.
  getShield(): number | undefined {
    if (!this.state.health) return undefined
    return this.state.statuses.reduce(
      (total, status) => status.kind === 'shield' ? total + status.amount : total,
      0,
    )
  }

  getDeathTick(): number | undefined {
    return this.state.health?.deathTick
  }

  isDead(): boolean {
    return this.state.health?.deathTick !== undefined
  }

  isDashing(): boolean {
    return this.state.dash !== undefined
  }

  // Where the character is currently heading, whether walking or dashing.
  getMoveTarget(): Vector2 | undefined {
    const target = this.state.dash?.target ?? this.state.movement?.target
    return target ? { ...target } : undefined
  }

  getNextAttackTick(): number {
    return this.state.nextAttackTick
  }

  // The experience it has, and the level that makes (see progression.ts).
  getXp(): number {
    return this.state.xp ?? 0
  }

  // A player's level is what its experience makes, and a monster's is what it has gained by being killed.
  getLevel(): number {
    return levelOfState(this.state)
  }

  // The gold it has to spend, and the items it carries by slot (see items.ts).
  getGold(): number {
    return this.state.gold ?? 0
  }

  getItems(): Inventory {
    return { ...this.state.items }
  }

  // The character this one is going after, if it has been told to attack someone and not to stop.
  getAttackTarget(): number | undefined {
    return this.state.attackTarget?.targetId
  }

  getCooldown(): { ready: boolean; ticksRemaining: number } {
    return toCooldown(this.tick, this.state.nextAttackTick)
  }

  getAbilityCooldown(abilityId: string): { ready: boolean; ticksRemaining: number } {
    return toCooldown(this.tick, this.state.cooldowns[abilityId] ?? 0)
  }

  getAction(): GameFrameAction | undefined {
    return this.state.action ? cloneAction(this.state.action) : undefined
  }

  getStatuses(): Status[] {
    return this.state.statuses.map((status) => ({ ...status }))
  }

  getMarkers(): Marker[] {
    return this.state.markers.map((marker) => ({ ...marker }))
  }

  // What a monster is up to: idle, after someone, or walking home. Nothing for a character that is not one.
  getAi(): AiState | undefined {
    return this.state.ai ? { ...this.state.ai } : undefined
  }
}

export class GameTickSnapshot {
  private readonly characters: Map<number, CharacterTickSnapshot>
  private readonly characterStates: Map<number, GameFrameCharacter>
  private readonly entities: SimEntity[]
  private readonly objective: ObjectiveState | undefined

  constructor(
    readonly tick: number,
    frame: GameFrame,
    // Events emitted while computing this tick; empty for restored checkpoints.
    readonly events: readonly GameEvent[] = [],
    // The characters that died on this tick; empty for restored checkpoints.
    readonly deaths: readonly DeathRecord[] = [],
  ) {
    this.characterStates = new Map(frame.characters.map((character) => [
      character.characterId,
      cloneFrameCharacter(character),
    ]))
    this.characters = new Map([...this.characterStates.values()].map((character) => [
      character.characterId,
      new CharacterTickSnapshot(character, tick),
    ]))
    this.entities = frame.entities.map(cloneEntity)
    this.objective = frame.objective ? cloneObjective(frame.objective) : undefined
  }

  get(characterId: number): CharacterTickSnapshot | undefined {
    return this.characters.get(characterId)
  }

  // How the game's hill or flags stand on this tick; nothing in a game of team deathmatch.
  getObjective(): ObjectiveState | undefined {
    return this.objective ? cloneObjective(this.objective) : undefined
  }

  getCharacterState(characterId: number): GameFrameCharacter | undefined {
    return this.characterStates.get(characterId)
  }

  getEntities(): SimEntity[] {
    return this.entities.map(cloneEntity)
  }

  toData(): GameFrame {
    return {
      tick: this.tick,
      characters: [...this.characterStates.values()]
        .sort((left, right) => left.characterId - right.characterId)
        .map(cloneFrameCharacter),
      entities: this.getEntities(),
      ...(this.objective ? { objective: cloneObjective(this.objective) } : {}),
    }
  }

  getCharacterIds(): number[] {
    return [...this.characterStates.keys()].sort((left, right) => left - right)
  }
}

export function entityPosAt(entity: SimEntity, tick: number): Vector2 {
  // An entity that follows its owner or chases a unit keeps its latest position instead of a
  // straight path.
  if (entity.position) return { ...entity.position }
  const elapsedTicks = Math.max(0, Math.min(
    entity.lifetimeTicks ?? Infinity,
    tick - entity.startTick,
  ))
  return {
    x: entity.origin.x + entity.velocity.x * elapsedTicks / GAME_TPS,
    y: entity.origin.y + entity.velocity.y * elapsedTicks / GAME_TPS,
  }
}

// The SimContext handed to effects while one tick is computed. Reads see the
// tick's state before any effect writes; writes are applied by the simulator
// in emission order once every action and entity has resolved.
class TickContext implements SimContext {
  readonly events: GameEvent[] = []
  readonly statusWrites: Array<{ unitId: number; status: Status }> = []
  readonly markerWrites: Array<{ unitId: number; marker: Marker }> = []
  readonly markerRemovals: Array<{ unitId: number; key: string; ownerId: number; count?: number }> = []
  readonly dashWrites: Array<{
    unitId: number
    target: Vector2
    speed: number
    through: boolean
    contact?: { defId: string; origin: Vector2; sourceId: string; orderId: string }
  }> = []
  readonly blinkWrites: Array<{ unitId: number; target: Vector2 }> = []
  readonly orderWrites: Array<{ unitId: number; order: CharacterOrder }> = []
  readonly entityWrites: SimEntity[] = []
  readonly entityRemovals: Array<{ ownerId: number; defId: string }> = []

  constructor(
    readonly tick: number,
    private readonly characters: ReadonlyMap<number, SimCharacter>,
    private readonly states: ReadonlyMap<number, GameFrameCharacter>,
    // The entities as the previous frame left them, which effects read before this tick moves any.
    private readonly entities: readonly SimEntity[],
    private readonly history: (tick: number) => GameTickSnapshot,
    // The ground the tick is played on, which effects ask about where a body can be.
    readonly terrain: Terrain,
  ) {}

  character(id: number): SimCharacter | undefined {
    return this.characters.get(id)
  }

  posAt(id: number, tick: number): Vector2 | undefined {
    return this.statesAt(tick).find((state) => state.characterId === id)?.position
  }

  unitsInRadius(center: Vector2, r: number, tick: number): number[] {
    return this.statesAt(tick)
      .filter((state) => {
        const character = this.characters.get(state.characterId)
        return character
          && isAlive(state)
          && distanceBetween(center, state.position) <= r + character.champion.radius
      })
      .map((state) => state.characterId)
      .sort((left, right) => left - right)
  }

  markersOn(unitId: number, key: string, ownerId?: number): Marker[] {
    return (this.states.get(unitId)?.markers ?? [])
      .filter((marker) => marker.key === key && (ownerId === undefined || marker.ownerId === ownerId))
      .map((marker) => ({ ...marker }))
  }

  statsOf(unitId: number): ChampionStats | undefined {
    return statsOfState(this.characters.get(unitId), this.states.get(unitId))
  }

  levelOf(unitId: number): number | undefined {
    const state = this.states.get(unitId)
    return state ? levelOfState(state) : undefined
  }

  healthOf(unitId: number): { hp: number; maxHp: number } | undefined {
    const health = this.states.get(unitId)?.health
    return health ? { hp: health.hp, maxHp: health.maxHp } : undefined
  }

  statusesOn(unitId: number): Status[] {
    return (this.states.get(unitId)?.statuses ?? []).map((status) => ({ ...status }))
  }

  entitiesOf(ownerId: number, defId: string): Array<{ id: string; position: Vector2 }> {
    return this.entities
      .filter((entity) => entity.ownerId === ownerId && entity.defId === defId)
      .map((entity) => ({ id: entity.id, position: entityPosAt(entity, this.tick) }))
  }

  isAlive(unitId: number): boolean {
    const state = this.states.get(unitId)
    return state !== undefined && isAlive(state)
  }

  addStatus(unitId: number, s: Status): void {
    this.statusWrites.push({ unitId, status: { ...s } })
  }

  addOrder(unitId: number, o: CharacterOrder): void {
    this.orderWrites.push({ unitId, order: cloneOrder(o) })
  }

  addMarker(unitId: number, m: Marker): void {
    this.markerWrites.push({ unitId, marker: { ...m } })
  }

  removeMarkers(unitId: number, key: string, ownerId: number, count?: number): void {
    this.markerRemovals.push({ unitId, key, ownerId, ...(count === undefined ? {} : { count }) })
  }

  startDash(
    unitId: number,
    target: Vector2,
    speed: number,
    options: {
      through?: boolean
      contact?: { defId: string; origin: Vector2; sourceId: string; orderId: string }
    } = {},
  ): void {
    this.dashWrites.push({
      unitId,
      target: { ...target },
      speed,
      through: options.through === true,
      ...(options.contact ? { contact: { ...options.contact, origin: { ...options.contact.origin } } } : {}),
    })
  }

  blink(unitId: number, target: Vector2): void {
    this.blinkWrites.push({ unitId, target: { ...target } })
  }

  addEntity(p: SimEntity): void {
    this.entityWrites.push(cloneEntity(p))
  }

  removeEntities(ownerId: number, defId: string): void {
    this.entityRemovals.push({ ownerId, defId })
  }

  emitEvent(e: GameEvent): void {
    this.events.push({ ...e })
  }

  private statesAt(tick: number): GameFrameCharacter[] {
    if (tick > this.tick) throw new RangeError('Effects cannot read future ticks.')
    if (tick === this.tick) return [...this.states.values()].map(cloneFrameCharacter)
    const frame = this.history(tick)
    return frame.getCharacterIds().flatMap((id) => {
      const state = frame.getCharacterState(id)
      return state ? [cloneFrameCharacter(state)] : []
    })
  }
}

export class Simulator {
  readonly characters = new Map<number, SimCharacter>()
  private readonly frameBuffer: Array<GameTickSnapshot | undefined> =
    new Array(GAME_SNAPSHOT_HISTORY_TICKS)
  private latestComputedTick = 0
  // Deaths on ticks after the commit tick, as the frames now stand. They move to the killers' tallies
  // when the commit tick reaches them, and are dropped with the frames when an order undoes them.
  private readonly pendingDeaths = new Map<number, readonly DeathRecord[]>()
  tick = 0
  commitTick = 0
  // Told of each death as it can no longer be undone: the commit tick has reached it, so no order
  // that could save the character can still arrive.
  onDeathConfirmed: ((death: DeathRecord) => void) | undefined
  // The ground the game is played on. It is the same for the whole game, so it is not in the frames,
  // and a restored snapshot brings it with it.
  private ground: Terrain
  // What the game is played for: team deathmatch, or a hill or flags to fight over. Like the ground it is
  // the same for the whole game, so it is not in the frames (what happens to the hill and flags is), and a
  // restored snapshot brings it with it.
  private setup: ModeSetup

  get latestSnapshotTick(): number {
    return this.latestComputedTick
  }

  get terrain(): Terrain {
    return this.ground
  }

  get mode(): ModeSetup {
    return this.setup
  }

  // How many ticks a dead champion stays dead, which the game's rules can set.
  get respawnTicks(): number {
    return this.setup.respawnTicks ?? GAME_RESPAWN_TICKS
  }

  // With no terrain given, the game is on the plain arena with no walls, and with no mode it is team
  // deathmatch. With no shops it can be shopped in from anywhere.
  constructor(terrain: Terrain = Terrain.plain(), setup: ModeSetup = { kind: 'deathmatch' }, shops: readonly ShopZone[] = []) {
    this.ground = terrain
    this.setup = setup
    this.shops = shops.map((zone) => ({ ...zone }))
    this.storeFrame(this.createInitialFrame())
  }

  // Where each team can shop (see shops.ts). Like the ground it is the same for the whole game, so it is not in the frames, and a restored
  // snapshot brings it with it.
  private shops: readonly ShopZone[]

  get shopZones(): readonly ShopZone[] {
    return this.shops
  }

  // Whether this game has an economy (see `modeHasEconomy`): if not, nothing pays experience, gold or shards, there is nothing to buy, and every champion is
  // at level 1.
  get hasEconomy(): boolean {
    return modeHasEconomy(this.setup.kind)
  }

  // Whether a character that is where a frame has it can buy and sell now: a champion that is dead can, and a living one must be in a shop of its team
  // (any place, if the game has no shops). It is the rule `buy` and `sell` orders are done by, and what the page asks before it sends one.
  canShop(characterId: number, frame: GameTickSnapshot): boolean {
    const character = this.characters.get(characterId)
    const state = frame.get(characterId)
    if (!character || !state || !this.hasEconomy) return false
    return state.isDead() || mayShop(this.shops, character.team, state.getPosition())
  }

  private mayShopNow(character: SimCharacter, state: GameFrameCharacter): boolean {
    return this.hasEconomy && (!isAlive(state) || mayShop(this.shops, character.team, state.position))
  }

  addPlayer(
    id: number,
    playerId: string,
    name: string,
    position: Vector2,
    champion: Champion = getChampion(DEFAULT_CHAMPION_ID),
    // Players on the same team are teammates. By default a player is on a team of their own.
    team: number = id,
  ): SimCharacter {
    const character = new SimCharacter(
      id,
      this.ground.resolve(position, champion.radius),
      [],
      champion,
      { playerId, name },
      0,
      0,
      team,
    )
    this.characters.set(id, character)
    if (this.tick === 0 && this.commitTick === 0) this.resetFrameHistory()
    return character
  }

  // Puts a monster in the game at its home, which is where it starts, goes back to, and comes back to after it dies. It is
  // on the monsters' team, an enemy of every player.
  addMonster(id: number, monster: Monster, position: Vector2): SimCharacter {
    const character = new SimCharacter(
      id,
      this.ground.resolve(position, monster.champion.radius),
      [],
      monster.champion,
      undefined,
      0,
      0,
      GAME_MONSTER_TEAM,
    )
    this.characters.set(id, character)
    if (this.tick === 0 && this.commitTick === 0) this.resetFrameHistory()
    return character
  }

  // Puts a turret in the game where it stands for good, on a team: an enemy of every other team, monsters too. It is solid and does
  // not move, and when it is destroyed it stays destroyed.
  addTurret(id: number, turret: Turret, position: Vector2, team: number): SimCharacter {
    const character = new SimCharacter(
      id,
      this.ground.resolve(position, turret.champion.radius),
      [],
      turret.champion,
      undefined,
      0,
      0,
      team,
    )
    this.characters.set(id, character)
    if (this.tick === 0 && this.commitTick === 0) this.resetFrameHistory()
    return character
  }

  // Puts a core in the game where it stands for good, on a team, as the heart of its base: an enemy of every other team. It is solid and
  // does not move or attack, and when it is broken it stays broken.
  addCore(id: number, core: Core, position: Vector2, team: number): SimCharacter {
    const character = new SimCharacter(
      id,
      this.ground.resolve(position, core.champion.radius),
      [],
      core.champion,
      undefined,
      0,
      0,
      team,
    )
    this.characters.set(id, character)
    if (this.tick === 0 && this.commitTick === 0) this.resetFrameHistory()
    return character
  }

  // The structures that are protected on a frame: they take no damage at all while what guards them is standing (see structures.ts).
  shieldedIn(frame: GameTickSnapshot): ReadonlySet<number> {
    return this.shieldedBy((id) => frame.get(id)?.isDead() === false)
  }

  // Whether a character that is dead on a frame will come back: not in Core Destruction once its team's core is broken, when what is
  // left of the team is all it has. (It is always true for a character that is alive, and for any other mode.)
  canRespawn(characterId: number, frame: GameTickSnapshot): boolean {
    const character = this.characters.get(characterId)
    return !character || !this.teamCoreBroken(character.team, (id) => frame.get(id)?.isDead() === false)
  }

  private shieldedBy(isStanding: (id: number) => boolean): Set<number> {
    const structures: StructureRef[] = []
    for (const character of this.characters.values()) {
      const ref = character.asStructure()
      if (ref) structures.push(ref)
    }
    return structures.length === 0 ? new Set() : shieldedStructures(structures, isStanding)
  }

  private teamCoreBroken(team: number, isStanding: (id: number) => boolean): boolean {
    if (this.setup.kind !== 'core') return false
    for (const character of this.characters.values()) {
      if (character.core && character.team === team && !isStanding(character.id)) return true
    }
    return false
  }

  addOrder(characterId: number, order: CharacterOrder): boolean {
    const character = this.characters.get(characterId)
    if (!character || order.tick <= this.commitTick) return false
    if (
      order.tick <= this.latestComputedTick
      && !this.getCachedFrame(order.tick - 1)
    ) return false
    if (character.orders.some((existing) => existing.id === order.id)) return false
    character.orders.push(cloneOrder(order))
    character.orders.sort((left, right) => compareCharacterOrders(left, right, character, character))
    character.recordOrderSequence(order.seq)
    this.invalidateFrom(order.tick)
    return true
  }

  removeOrder(characterId: number, seq: number): boolean {
    const character = this.characters.get(characterId)
    if (!character) return false
    const orderIndex = character.orders.findIndex((order) => order.seq === seq)
    if (orderIndex < 0) return false
    const removedOrder = character.orders[orderIndex]
    if (removedOrder.tick <= this.latestComputedTick && !this.getCachedFrame(removedOrder.tick - 1)) {
      return false
    }
    character.orders.splice(orderIndex, 1)
    this.invalidateFrom(removedOrder.tick)
    return true
  }

  at(tick: number): GameTickSnapshot {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new RangeError('Snapshot tick must be a nonnegative safe integer.')
    }
    const cached = this.getCachedFrame(tick)
    if (cached) return cached
    if (tick <= this.latestComputedTick) {
      throw new RangeError(`Snapshot tick ${tick} is no longer in the ring buffer.`)
    }
    const previous = this.at(tick - 1)
    const frame = this.computeFrame(tick, previous)
    this.storeFrame(frame)
    if (frame.deaths.length > 0) this.pendingDeaths.set(tick, frame.deaths)
    // A frame computed after its tick was committed is already beyond undoing.
    if (tick <= this.commitTick) this.confirmDeathsUpTo(this.commitTick)
    return frame
  }

  setCommitTick(tick: number): void {
    if (!Number.isSafeInteger(tick) || tick < this.commitTick || tick > this.tick) {
      throw new RangeError('Commit tick must advance monotonically and not exceed the simulator tick.')
    }
    if (tick > this.latestComputedTick) this.at(tick)
    this.commitTick = tick
    for (const character of this.characters.values()) {
      let index = 0
      while (index < character.orders.length && character.orders[index].tick < tick) {
        index += 1
      }
      character.orders.splice(0, index)
    }
    this.confirmDeathsUpTo(tick)
  }

  // Credits the kills of the deaths up to `tick`, oldest first, and tells `onDeathConfirmed` of each.
  private confirmDeathsUpTo(tick: number): void {
    const confirmed = [...this.pendingDeaths]
      .filter(([deathTick]) => deathTick <= tick)
      .sort(([left], [right]) => left - right)
    for (const [deathTick, deaths] of confirmed) {
      this.pendingDeaths.delete(deathTick)
      for (const death of deaths) {
        // A kill is one player's of another: monsters and turrets do not score, and nor does killing one (what that is worth
        // is for the game's rules to say, from the death record).
        if (death.killerId !== undefined) {
          const killer = this.characters.get(death.killerId)
          const victim = this.characters.get(death.victimId)
          if (killer && !killer.isNpc) {
            if (!victim?.isNpc) killer.kills += 1
            // Any kill a player makes pays them, of a player, a monster or a turret: what the monster's or the turret's entry says it
            // is worth, or a flat amount for a player. A monster or a turret that kills is paid nothing.
            if (this.hasEconomy) killer.earn(killReward(victim))
          }
        }
        this.onDeathConfirmed?.({ ...death })
      }
    }
  }

  // Empties the game. With a terrain, the next game is played on that ground instead, and with a mode
  // it is played for that. Its shops are the ones given, and none if none are.
  reset(terrain?: Terrain, setup?: ModeSetup, shops: readonly ShopZone[] = []): void {
    if (terrain) this.ground = terrain
    if (setup) this.setup = setup
    this.shops = shops.map((zone) => ({ ...zone }))
    this.characters.clear()
    this.tick = 0
    this.commitTick = 0
    this.resetFrameHistory()
  }

  remove(characterId: number): void {
    this.characters.delete(characterId)
    this.invalidateFrom(Math.max(this.commitTick + 1, this.tick))
  }

  advanceTo(tick: number): void {
    if (!Number.isSafeInteger(tick) || tick < this.tick) {
      throw new RangeError('Simulator tick must be a safe integer that does not go backwards.')
    }
    if (tick > this.latestComputedTick) this.at(tick)
    this.tick = Math.max(this.tick, tick, this.latestComputedTick)
  }

  snapshot(): GameSnapshot {
    const checkpoint = this.at(this.commitTick)
    return {
      tick: this.tick,
      commitTick: this.commitTick,
      terrain: this.ground.toData(),
      ...(this.shops.length > 0 ? { shops: this.shops.map((zone) => ({ ...zone })) } : {}),
      // Team deathmatch with the default rules is what a snapshot without a mode is, so it is left out.
      ...(isPlainDeathmatch(this.setup) ? {} : { mode: this.setup }),
      characters: [...this.characters.values()].map((character) => ({
        ...character.snapshot(),
        orders: character.orders
          .filter((order) => order.tick > this.commitTick)
          .map(cloneOrder),
      })),
      checkpoint: checkpoint.toData(),
    }
  }

  replaceFromSnapshot(snapshot: GameSnapshot): void {
    if (
      snapshot.checkpoint.tick !== snapshot.commitTick
      || snapshot.commitTick > snapshot.tick
    ) {
      throw new RangeError('Snapshot checkpoint must match its commit tick and not exceed its current tick.')
    }
    const champions = snapshot.characters.map((character) => getCharacterChampion(character.championId))
    // The ground is the snapshot's, and kept as it is when it is the same, which it is every time
    // after the first, so what was worked out for it (see `Pathfinder`) is not lost.
    if (!snapshot.terrain) this.ground = Terrain.plain()
    else if (!this.ground.sameAs(snapshot.terrain)) this.ground = Terrain.fromData(snapshot.terrain)
    this.setup = snapshot.mode ?? { kind: 'deathmatch' }
    this.shops = (snapshot.shops ?? []).map((zone) => ({ ...zone }))
    // The deaths up to the checkpoint that this simulator had not yet seen confirmed are confirmed by
    // it now (their kills are already in the snapshot's tallies). Later ones are worked out again.
    const confirmedByCheckpoint = [...this.pendingDeaths]
      .filter(([deathTick]) => deathTick <= snapshot.commitTick)
      .sort(([left], [right]) => left - right)
    this.pendingDeaths.clear()
    this.characters.clear()
    this.commitTick = snapshot.commitTick
    snapshot.characters.forEach((character, index) => {
      this.characters.set(character.id, new SimCharacter(
        character.id,
        character.initialPosition,
        character.orders,
        champions[index],
        character.player,
        character.highestOrderSequence,
        character.kills,
        character.team,
        { shards: character.shards },
      ))
    })
    for (const [, deaths] of confirmedByCheckpoint) {
      for (const death of deaths) this.onDeathConfirmed?.({ ...death })
    }
    this.frameBuffer.fill(undefined)
    this.latestComputedTick = snapshot.commitTick
    this.storeFrame(new GameTickSnapshot(snapshot.checkpoint.tick, snapshot.checkpoint))
    this.tick = snapshot.commitTick
    this.advanceTo(snapshot.tick)
  }

  private computeFrame(tick: number, previous: GameTickSnapshot): GameTickSnapshot {
    const states = new Map<number, GameFrameCharacter>()
    // Dashes with effects of their own, to settle once everyone is where this tick left them.
    const dashSteps: DashStep[] = []
    for (const characterId of previous.getCharacterIds()) {
      const character = this.characters.get(characterId)
      const prior = previous.getCharacterState(characterId)
      if (!character || !prior) continue
      const state = cloneFrameCharacter(prior)
      if (state.dash) {
        // A dash replaces walking for as long as it lasts, at its own speed. It goes over walls: only
        // the arena's edge holds it.
        state.position = stepToward(prior.position, state.dash.target, state.dash.speed / GAME_TPS, character.champion.radius, this.ground)
        const finished = state.position.x === state.dash.target.x && state.position.y === state.dash.target.y
        if (state.dash.contact) {
          dashSteps.push({ characterId, from: { ...prior.position }, contact: state.dash.contact, finished })
        }
        if (finished) state.dash = undefined
      } else if (state.movement && !isImmobilized(prior.statuses)) {
        // Movement over (tick - 1, tick] uses the previous frame's statuses, as they stood then.
        const speed = getMoveSpeed(character, prior.statuses, tick - 1, itemTotals(prior.items).moveSpeed ?? 0)
        const radius = character.champion.radius
        // The way round any walls in the way, from where it is now, which is worked out again every
        // tick so it needs nothing kept in the frame: its first point is where to head.
        const route = this.ground.path(prior.position, state.movement.target, radius)
        if (!route) {
          // There is no way to where it was sent.
          state.movement = undefined
        } else {
          const heading = route[0] ?? prior.position
          state.position = this.ground.keepOutOfWalls(
            stepToward(prior.position, heading, speed / GAME_TPS, radius, this.ground),
            radius,
          )
          // It has arrived when it reaches the last point of the way.
          const goal = route[route.length - 1] ?? prior.position
          if (route.length <= 1 && state.position.x === goal.x && state.position.y === goal.y) {
            state.movement = undefined
          }
        }
      }
      state.statuses = state.statuses.filter((status) => status.endTick > tick)
      state.markers = state.markers.filter((marker) => marker.endTick > tick)
      // A dead character comes back a fixed time after the tick it died on: a monster when its profile says (never, if it does not),
      // and a structure never, as it is destroyed for the rest of the game. In Core Destruction a player whose team's core is broken
      // does not either: it is a player of a team that is running out of them.
      const wait = character.monster ? character.monster.ai.respawnTicks : character.structure ? undefined : this.respawnTicks
      if (wait !== undefined && state.health?.deathTick !== undefined && tick === state.health.deathTick + wait) {
        const standing = (id: number): boolean => previous.getCharacterState(id)?.health?.deathTick === undefined
        // A monster comes back a level higher, in a game with an economy (the levels of the game are that).
        if (!this.teamCoreBroken(character.team, standing)) respawnCharacter(character, state, tick, character.monster !== undefined && this.hasEconomy)
      }
      states.set(characterId, state)
    }
    for (const character of this.characters.values()) {
      if (states.has(character.id)) continue
      states.set(character.id, this.createInitialCharacterFrame(character))
    }
    pushCharactersApart(states, this.characters, this.ground)
    const characters = [...this.characters.values()].sort((left, right) => left.id - right.id)
    const context = new TickContext(
      tick,
      this.characters,
      states,
      previous.getEntities(),
      (historyTick) => this.at(historyTick),
      this.ground,
    )

    // Burning characters take their burn on every pulse tick, as damage from whoever lit them.
    if (tick % GAME_BURN_PULSE_TICKS === 0) {
      for (const character of characters) {
        const state = states.get(character.id)
        if (!state || !isAlive(state)) continue
        for (const status of state.statuses) {
          if (status.kind !== 'burn') continue
          context.emitEvent({
            type: 'damage',
            id: `${status.id}:pulse:t${tick}`,
            rootId: status.rootId,
            ownerId: status.ownerId,
            targetId: character.id,
            amount: status.amount,
          })
        }
      }
    }

    // What a dash touched on its way this tick, and whether it ended having touched no one.
    this.resolveDashes(context, characters, states, dashSteps, tick)

    // Windups that finish this tick launch before this tick's orders can cancel them.
    for (const character of characters) {
      const state = states.get(character.id)
      if (state?.action?.launchTick === tick) this.launchAction(context, character, state, states, tick)
    }

    const orders = characters.flatMap((character) =>
      character.orders
        .filter((order) => order.tick === tick)
        .map((order) => ({ character, order })),
    )
    orders.sort((left, right) =>
      compareCharacterOrders(left.order, right.order, left.character, right.character),
    )
    for (const character of characters) {
      const state = states.get(character.id)
      if (!state) continue
      for (const order of state.queuedOrders) {
        if (order.tick === tick) orders.push({ character, order })
      }
      state.queuedOrders = state.queuedOrders.filter((order) => order.tick > tick)
    }
    // The monsters decide what to do from where everyone stands now, and what they decide is orders like any
    // other, so they are carried out the same way, after the players' of the tick.
    orders.push(...this.thinkMonsters(characters, states, tick))
    orders.push(...this.thinkTurrets(characters, states, tick))
    for (const { character, order } of orders) {
      const state = states.get(character.id)
      if (!state) continue
      // The shop is open to the dead as well as the living: what they buy is there when they are back.
      if (order.type === 'buy') {
        this.buyItem(character, state, order)
        continue
      }
      if (order.type === 'sell') {
        this.sellItem(character, state, order)
        continue
      }
      if (!isAlive(state)) continue
      if (order.type === 'move') {
        // Walking somewhere cancels a windup and stops going after anyone.
        state.action = undefined
        state.attackTarget = undefined
        state.movement = { target: this.ground.resolve(order.target, character.champion.radius) }
      } else if (order.type === 'attack') {
        this.lockOnto(character, state, order, states)
      } else {
        this.startCast(context, character, state, order, states, tick)
      }
    }
    // Whoever has a target now goes after it, in the same tick the order arrived if it can.
    this.driveAttacks(context, characters, states, tick)

    const entities = this.advanceEntities(context, previous.getEntities(), states, tick)
    for (const state of states.values()) {
      if (state.action && state.action.endTick <= tick) state.action = undefined
    }
    const deaths = this.applyWrites(context, states, entities, tick)
    this.anchorStructures(states)
    const objective = this.advanceObjective(previous, states, tick, deaths)

    return new GameTickSnapshot(tick, {
      tick,
      characters: [...states.values()].sort((left, right) => left.characterId - right.characterId),
      entities,
      ...(objective ? { objective } : {}),
    }, context.events, deaths)
  }

  // The hill, the flags or the kills after this tick, with everyone where the tick left them: the deaths it
  // caused and the blinks it made are done. A kill scores for the team of whoever made it.
  private advanceObjective(
    previous: GameTickSnapshot,
    states: ReadonlyMap<number, GameFrameCharacter>,
    tick: number,
    deaths: readonly DeathRecord[],
  ): ObjectiveState | undefined {
    const units: ObjectiveUnit[] = []
    if (this.setup.kind !== 'deathmatch') {
      for (const state of states.values()) {
        const character = this.characters.get(state.characterId)
        // Monsters stand on the hill and walk over flags without taking either, and turrets are not on it.
        if (!character || character.isNpc) continue
        units.push({
          id: character.id,
          team: character.team,
          position: state.position,
          radius: character.champion.radius,
          alive: isAlive(state),
        })
      }
    }
    // A team scores for the players its players kill, not for monsters or turrets, or for the players they kill.
    const killerTeams = deaths.flatMap((death) => {
      const killer = death.killerId === undefined ? undefined : this.characters.get(death.killerId)
      return killer && !killer.isNpc && !this.characters.get(death.victimId)?.isNpc ? [killer.team] : []
    })
    // The cores, for the mode that has them: whose they are, and whether they are standing as the tick leaves them.
    const standing: ObjectiveCore[] = []
    if (this.setup.kind === 'core') {
      for (const character of this.characters.values()) {
        const state = states.get(character.id)
        if (character.core && state) standing.push({ team: character.team, standing: isAlive(state) })
      }
    }
    return advanceObjective(previous.getObjective(), this.setup, units, tick, killerTeams, standing)
  }

  // Every monster that is alive decides what to do (see `think`): it reads where everyone stands this tick, what it
  // is up to from the last, and what it can do, and gives the orders it wants carried out and what it is up to
  // next. A monster that has got home after a fight is healed to full. A dead monster is waiting to come back.
  private thinkMonsters(
    characters: readonly SimCharacter[],
    states: ReadonlyMap<number, GameFrameCharacter>,
    tick: number,
  ): Array<{ character: SimCharacter; order: CharacterOrder }> {
    const issued: Array<{ character: SimCharacter; order: CharacterOrder }> = []
    if (!characters.some((character) => character.monster)) return issued
    // What a monster can notice is the players: a structure is on a team of its own, but no monster goes after one.
    const sight: AiOther[] = []
    for (const character of characters) {
      const state = states.get(character.id)
      if (state && !character.structure) sight.push({ id: character.id, team: character.team, position: state.position, alive: isAlive(state) })
    }
    for (const character of characters) {
      const monster = character.monster
      const state = states.get(character.id)
      if (!monster || !state) continue
      if (!isAlive(state) || !state.health) {
        state.ai = { mode: 'idle' }
        continue
      }
      const body: AiBody = {
        id: character.id,
        team: character.team,
        position: state.position,
        home: character.initialPosition,
        hp: state.health.hp,
        maxHp: state.health.maxHp,
        busy: isWindingUp(state, tick) || state.dash !== undefined || isStunned(state.statuses),
        silenced: isSilenced(state.statuses),
        attacking: state.attackTarget?.targetId,
        moving: state.movement !== undefined,
        ready: (abilityId) => (state.cooldowns[abilityId] ?? 0) <= tick,
      }
      // How far it has to walk to someone is what its ranges are measured in: the way round the walls, for a body of its size.
      const radius = character.champion.radius
      const decision = think(monster, body, state.ai ?? { mode: 'idle' }, sight, (from, to) => this.ground.walkDistance(from, to, radius))
      state.ai = decision.state
      if (decision.reset) {
        state.health = { hp: state.health.maxHp, maxHp: state.health.maxHp, hpSeq: state.health.hpSeq + 1, finalizedTick: tick }
        state.statuses = []
        state.markers = []
      }
      decision.orders.forEach((order, index) => {
        issued.push({ character, order: aiOrder(character, order, state.position, tick, index) })
      })
    }
    return issued
  }

  // Every turret that is alive shoots (see `chooseTurretTarget`): the enemy player it is shooting while they are alive and in its
  // range, and else the nearest in its range. It gives the same kind of order a player does, an attack, which makes the turret's
  // attack lock do the shooting, and it drops its target the tick they leave its range, since it cannot go after them. A turret
  // never targets a monster or another turret.
  private thinkTurrets(
    characters: readonly SimCharacter[],
    states: ReadonlyMap<number, GameFrameCharacter>,
    tick: number,
  ): Array<{ character: SimCharacter; order: CharacterOrder }> {
    const issued: Array<{ character: SimCharacter; order: CharacterOrder }> = []
    if (!characters.some((character) => character.turret)) return issued
    const prey: TurretPrey[] = []
    for (const character of characters) {
      const state = states.get(character.id)
      if (state && !character.isNpc) prey.push({ id: character.id, team: character.team, position: state.position, alive: isAlive(state) })
    }
    for (const character of characters) {
      const state = states.get(character.id)
      if (!character.turret || !state || !isAlive(state)) continue
      const target = chooseTurretTarget({
        team: character.team,
        position: state.position,
        range: character.champion.attackRangeWith(state.statuses),
        attacking: state.attackTarget?.targetId,
      }, prey)
      if (target === undefined) {
        // No one to shoot: whoever it was shooting has gone out of its range, or died, so a shot not yet away is called off.
        state.attackTarget = undefined
        if (state.action?.kind === 'attack') state.action = undefined
      } else if (state.attackTarget?.targetId !== target) {
        issued.push({ character, order: aiOrder(character, { type: 'attack', targetId: target }, state.position, tick, 0) })
      }
    }
    return issued
  }

  // A structure stands where it was put: whatever pushed or pulled it this tick is undone, and it is not walking or dashing anywhere.
  private anchorStructures(states: ReadonlyMap<number, GameFrameCharacter>): void {
    for (const character of this.characters.values()) {
      if (!character.structure) continue
      const state = states.get(character.id)
      if (!state) continue
      state.position = { ...character.initialPosition }
      state.movement = undefined
      state.dash = undefined
    }
  }

  // A dash with effects of its own: every enemy its body reached on this tick's step, each once for
  // the whole dash, takes its `onHit`; the first of them also sets off `onConnect`; and a dash that
  // finishes having reached no one runs `onMiss`. It is a sweep along the step, so a fast dash cannot
  // skip over someone, and it reads the enemies where they are on this tick, not where they were when
  // it was ordered.
  private resolveDashes(
    context: TickContext,
    characters: readonly SimCharacter[],
    states: ReadonlyMap<number, GameFrameCharacter>,
    steps: readonly DashStep[],
    tick: number,
  ): void {
    for (const { characterId, from, contact, finished } of steps) {
      const character = this.characters.get(characterId)
      const state = states.get(characterId)
      const def = getDashDef(contact.defId)
      if (!character || !state || !def || !isAlive(state)) continue
      const source = { rootId: contact.orderId, ownerId: characterId, tick, aim: null }
      for (const enemy of characters) {
        const enemyState = states.get(enemy.id)
        if (
          !enemyState
          || !areEnemies(character, enemy)
          || !isAlive(enemyState)
          || contact.hitIds.includes(enemy.id)
          || distanceToSegment(enemyState.position, from, state.position)
            > character.champion.radius + enemy.champion.radius
        ) continue
        const first = contact.hitIds.length === 0
        contact.hitIds.push(enemy.id)
        runEffects(def.onHit ?? [], context, {
          ...source,
          id: `${contact.sourceId}:dash:u${enemy.id}`,
          at: { ...state.position },
          subject: enemy.id,
        })
        if (first) {
          runEffects(def.onConnect ?? [], context, {
            ...source,
            id: `${contact.sourceId}:dash:connect`,
            at: { ...contact.origin },
            subject: enemy.id,
          })
        }
      }
      if (finished && contact.hitIds.length === 0) {
        runEffects(def.onMiss ?? [], context, {
          ...source,
          id: `${contact.sourceId}:dash:miss`,
          at: { ...contact.origin },
          subject: null,
        })
      }
    }
  }

  // Buys an item with the gold the character has on this tick, if it is in a shop (`mayShopNow`) and can afford it (`buyProblem`): the gold is spent,
  // the item is in its slot, and the health goes up by what the item adds to it, as a level does. An order that cannot be carried out is nothing, on
  // every peer alike.
  private buyItem(character: SimCharacter, state: GameFrameCharacter, order: BuyOrder): void {
    const item = getItem(order.itemId)
    if (!item || !this.mayShopNow(character, state) || buyProblem(item, state.gold ?? 0, state.items ?? {}) !== undefined) return
    state.gold = (state.gold ?? 0) - item.cost
    state.items = { ...copyItems(state.items), [item.slot]: item.id }
    refitHealth(character, state)
  }

  // Sells what is in a slot, in a shop, for the part of its cost the sell rate pays back, and takes what it added to the health off it again.
  private sellItem(character: SimCharacter, state: GameFrameCharacter, order: SellOrder): void {
    const id = state.items?.[order.slot]
    if (id === undefined || !this.mayShopNow(character, state)) return
    const items = copyItems(state.items)
    delete items[order.slot]
    if (Object.keys(items).length > 0) state.items = items
    else delete state.items
    const item = getItem(id)
    state.gold = (state.gold ?? 0) + (item ? sellValue(item) : 0)
    refitHealth(character, state)
  }

  // An attack order makes its target the one this character goes after, until it is told to do
  // something else. It does not swing here: `driveAttacks` does, as soon as the character is able
  // and in reach. An order for something that cannot be attacked (a teammate, a character who is
  // dead or gone, a structure that is protected) changes nothing, so it does not interrupt a walk.
  private lockOnto(
    character: SimCharacter,
    state: GameFrameCharacter,
    order: GameAttackOrder,
    states: ReadonlyMap<number, GameFrameCharacter>,
  ): void {
    const target = this.characters.get(order.targetId)
    const targetState = target ? states.get(target.id) : undefined
    if (!target || !targetState || !areEnemies(character, target) || !isAlive(targetState) || !isAlive(state)) return
    if (target.structure && this.shieldedBy((id) => { const other = states.get(id); return other !== undefined && isAlive(other) }).has(target.id)) return
    state.attackTarget = { targetId: order.targetId, orderId: order.id }
    state.movement = undefined
  }

  // Everyone who is going after someone does what that needs this tick. A target that is dead or
  // gone ends it. A character that is busy (winding up, dashing, stunned) waits and keeps its target.
  // One out of reach heads for where the target stands now. One in reach stops and attacks as soon
  // as its attack is ready, and again each time it is, for as long as it keeps the target.
  private driveAttacks(
    context: TickContext,
    characters: readonly SimCharacter[],
    states: ReadonlyMap<number, GameFrameCharacter>,
    tick: number,
  ): void {
    for (const character of characters) {
      const state = states.get(character.id)
      const lock = state?.attackTarget
      if (!state || !lock) continue
      const target = this.characters.get(lock.targetId)
      const targetState = target ? states.get(target.id) : undefined
      if (!target || !targetState || !isAlive(state) || !isAlive(targetState) || !areEnemies(character, target)) {
        state.attackTarget = undefined
        continue
      }
      if (isWindingUp(state, tick) || state.dash || isStunned(state.statuses)) continue

      if (distanceBetween(state.position, targetState.position) > character.champion.attackRangeWith(state.statuses, itemTotals(state.items).attackRange ?? 0)) {
        state.movement = { target: { ...targetState.position } }
        continue
      }
      state.movement = undefined
      if (tick >= state.nextAttackTick) this.beginAttack(context, character, state, lock, states, tick)
    }
  }

  // One swing at the target: a windup, and then the hit.
  private beginAttack(
    context: TickContext,
    character: SimCharacter,
    state: GameFrameCharacter,
    lock: NonNullable<GameFrameCharacter['attackTarget']>,
    states: ReadonlyMap<number, GameFrameCharacter>,
    tick: number,
  ): void {
    const launchTick = tick + character.champion.attackWindupTicks
    state.action = {
      kind: 'attack',
      orderId: lock.orderId,
      targetId: lock.targetId,
      startTick: tick,
      launchTick,
      endTick: launchTick,
    }
    if (launchTick === tick) this.launchAction(context, character, state, states, tick)
  }

  private startCast(
    context: TickContext,
    character: SimCharacter,
    state: GameFrameCharacter,
    order: CastOrder,
    states: ReadonlyMap<number, GameFrameCharacter>,
    tick: number,
  ): void {
    const def = abilityDefs.get(order.abilityId)
    const valid = Boolean(
      def
      && character.champion.hasAbility(def.id)
      && isAlive(state)
      && !isWindingUp(state, tick)
      && !state.dash
      && !isStunned(state.statuses)
      && !isSilenced(state.statuses)
      && !(def.movement && isImmobilized(state.statuses))
      && meetsRequirement(
        def,
        (defId) => context.entitiesOf(character.id, defId).length > 0,
        (abilityId) => (state.cooldowns[abilityId] ?? 0) > tick,
      )
      && (state.cooldowns[def.id] ?? 0) <= tick
      && distanceBetween(order.origin, state.position) <= GAME_CAST_ORIGIN_TOLERANCE
      && this.isValidCastTarget(character, def, order, states),
    )
    if (!valid || !def) return

    // A cast with a windup stops the character: it stops walking, and going after its target, to cast,
    // and does not go back to either. One with none does not: it carries on around it, so a walk
    // goes on through it (and resumes after a dash it started), and an attack can be followed by an
    // ability and then another.
    if (def.windUpTicks > 0) {
      state.movement = undefined
      state.attackTarget = undefined
    }
    const launchTick = tick + def.windUpTicks
    state.action = {
      kind: 'cast',
      orderId: order.id,
      abilityId: def.id,
      target: cloneCastTarget(order.target),
      origin: { ...order.origin },
      startTick: tick,
      launchTick,
      endTick: launchTick + def.backswingTicks,
    }
    if (launchTick === tick) this.launchAction(context, character, state, states, tick)
  }

  private isValidCastTarget(
    character: SimCharacter,
    def: AbilityDef,
    order: CastOrder,
    states: ReadonlyMap<number, GameFrameCharacter>,
  ): boolean {
    const target = order.target
    if (target.mode !== def.targeting) return false
    switch (target.mode) {
      case 'none':
        return true
      case 'point':
        return withinCastRange(order.origin, target.point, def.range)
          && beyondMinCastRange(order.origin, target.point, def.minRange)
      case 'direction':
        return Math.abs(target.dir.x * target.dir.x + target.dir.y * target.dir.y - 1)
          <= DIRECTION_LENGTH_TOLERANCE
      case 'unit': {
        const unit = this.characters.get(target.unitId)
        const unitState = states.get(target.unitId)
        return Boolean(
          unit
          && unitState
          && areEnemies(character, unit)
          && isAlive(unitState)
          && withinCastRange(order.origin, unitState.position, def.range),
        )
      }
    }
  }

  private launchAction(
    context: TickContext,
    character: SimCharacter,
    state: GameFrameCharacter,
    states: ReadonlyMap<number, GameFrameCharacter>,
    tick: number,
  ): void {
    const action = state.action
    if (!action) return
    if (!isAlive(state)) {
      state.action = undefined
      return
    }
    if (action.kind === 'attack') {
      // An attack whose target died or left during windup is cancelled, not spent.
      const targetState = states.get(action.targetId)
      if (!this.characters.has(action.targetId) || !targetState || !isAlive(targetState)) {
        state.action = undefined
        return
      }
      state.nextAttackTick = action.startTick + character.champion.attackCooldownTicksWith(state.statuses, levelOfState(state), itemTotals(state.items).attackSpeed ?? 0)
      // A blind attacker swings at nothing: the windup and cooldown are spent, but nothing lands
      // and no shot leaves. A shot already in the air is unaffected.
      if (state.statuses.some((status) => status.kind === 'blind')) return
      // An instant attack lands here; one with a projectile launches it, and it lands on arrival.
      runEffects(character.champion.onAttackLaunch, context, {
        // One order makes many attacks, and what an attack places (a stack, a shot) is named by
        // this ID, so each attack has its own: otherwise the next would replace the last.
        id: `${ATTACK_SOURCE_PREFIX}${action.orderId}:t${action.startTick}`,
        rootId: action.orderId,
        ownerId: character.id,
        tick,
        at: { ...state.position },
        // Aimed like a unit-targeted cast, so targetUnit() and spawnEntity work in onAttackHit.
        aim: { mode: 'unit', unitId: action.targetId },
        subject: action.targetId,
      })
      return
    }

    const def = abilityDefs.get(action.abilityId)
    if (!def) {
      state.action = undefined
      return
    }
    // The cooldown is shortened by the caster's haste.
    state.cooldowns[def.id] = tick + hastedCooldownTicks(def.cooldownTicks, statsOfState(character, state)?.haste ?? 0)
    runEffects(def.apply, context, {
      id: `c:${action.orderId}`,
      rootId: action.orderId,
      ownerId: character.id,
      tick,
      at: { ...action.origin },
      aim: cloneCastTarget(action.target),
      subject: null,
    })
    // An ability applied through an auto attack only readies it here. The champion's attack
    // effects find the readiness and spend it when the next auto lands.
    if (def.empowerAttack) {
      runEffects([mark(readyKey(def.id), def.empowerAttack.ticks, self(), { cap: 1 })], context, {
        id: `c:${action.orderId}:ready`,
        rootId: action.orderId,
        ownerId: character.id,
        tick,
        at: { ...action.origin },
        aim: cloneCastTarget(action.target),
        subject: null,
      })
    }
    // The champion's own reaction to any spell it casts (Capricorn's passive).
    runEffects(character.champion.onCast, context, {
      id: `c:${action.orderId}:cast`,
      rootId: action.orderId,
      ownerId: character.id,
      tick,
      at: { ...action.origin },
      aim: cloneCastTarget(action.target),
      subject: null,
    })
  }

  private advanceEntities(
    context: TickContext,
    entities: SimEntity[],
    states: ReadonlyMap<number, GameFrameCharacter>,
    tick: number,
  ): SimEntity[] {
    const remaining: SimEntity[] = []
    for (const entity of entities) {
      const def = getEntityDef(entity.defId)
      if (!def) continue
      // A volley's later copies wait at the origin until their start tick.
      if (tick < entity.startTick) {
        remaining.push(entity)
        continue
      }
      if (entity.lifetimeTicks !== undefined && tick > entity.startTick + entity.lifetimeTicks) {
        if (def.onExpire) {
          // It ends where its final tick left it, so a lob spawns its follow-up on the aimed point.
          runEffects(def.onExpire, context, {
            id: `${entity.id}:expire`,
            rootId: entity.rootId,
            ownerId: entity.ownerId,
            tick,
            at: entityPosAt(entity, tick),
            aim: null,
            subject: null,
          })
        }
        continue
      }
      const owner = this.characters.get(entity.ownerId)
      if (def.follow) {
        // A damped spring toward a rest point by the owner, stepped one tick at a time (velocity
        // first, then position from it). The rest point stays inside the arena, and over walls.
        const leader = states.get(entity.ownerId)
        if (leader && isAlive(leader)) {
          const { stiffness, damping, offset } = def.follow
          const rest = this.ground.clamp(
            { x: leader.position.x + (offset?.x ?? 0), y: leader.position.y + (offset?.y ?? 0) },
            def.radius ?? 0,
          )
          const from = entityPosAt(entity, tick)
          const dt = 1 / GAME_TPS
          const velocity = {
            x: entity.velocity.x + (stiffness * (rest.x - from.x) - damping * entity.velocity.x) * dt,
            y: entity.velocity.y + (stiffness * (rest.y - from.y) - damping * entity.velocity.y) * dt,
          }
          entity.velocity = velocity
          entity.position = { x: from.x + velocity.x * dt, y: from.y + velocity.y * dt }
        }
      }
      if (def.homing && tick > entity.startTick) {
        // One step toward where the target stands this tick, so it turns with the target. It is
        // over, without hitting, if the target died or left the game, or if its shooter left.
        const target = entity.targetId === undefined ? undefined : states.get(entity.targetId)
        if (!owner || !target || !isAlive(target)) continue
        const from = entity.position ?? entity.origin
        const next = stepToward(from, target.position, def.speed / GAME_TPS, 0, this.ground)
        entity.velocity = { x: (next.x - from.x) * GAME_TPS, y: (next.y - from.y) * GAME_TPS }
        entity.position = next
      }
      const position = entityPosAt(entity, tick)
      if (def.stayWhile && !def.stayWhile(context, {
        id: `${entity.id}:stay`,
        rootId: entity.rootId,
        ownerId: entity.ownerId,
        tick,
        at: position,
        aim: null,
        subject: null,
      })) continue
      // Where the entity stops, for effects that care how much of its travel is left. A chaser's
      // path bends, so it has no such point.
      const travelEnd = entity.lifetimeTicks === undefined || def.homing
        ? undefined
        : entityPosAt(entity, entity.startTick + entity.lifetimeTicks)
      const onHit = def.onHit ?? []
      const hits = owner && onHit.length > 0
        ? [...states.values()]
          .flatMap((state) => {
            const unit = this.characters.get(state.characterId)
            if (
              !unit
              || !areEnemies(owner, unit)
              || !isAlive(state)
              || entity.hitIds.includes(unit.id)
              // A chaser passes through everyone but its target, unless it pierces on the way home.
              || (def.homing && !def.pierce && unit.id !== entity.targetId)
            ) return []
            const distance = distanceBetween(position, state.position)
            const touching = def.box
              ? boxTouchesCircle(position, entity.facing ?? { x: 1, y: 0 }, def.box, state.position, unit.champion.radius)
              : distance <= def.radius + unit.champion.radius
            return touching ? [{ id: unit.id, distance }] : []
          })
          .sort((left, right) => left.distance - right.distance || left.id - right.id)
        : []
      const struck = def.pierce ? hits : hits.slice(0, 1)
      // The effects an entity runs know which way it points: the way a rectangle faces, else the
      // way it travels. A wave uses it to push what it strikes, a rectangular field to find who
      // is inside it.
      const speed = Math.sqrt(entity.velocity.x * entity.velocity.x + entity.velocity.y * entity.velocity.y)
      const travel: CastTarget | null = entity.facing
        ? { mode: 'direction', dir: { ...entity.facing } }
        : speed > 0
          ? { mode: 'direction', dir: { x: entity.velocity.x / speed, y: entity.velocity.y / speed } }
          : null
      for (const { id } of struck) {
        entity.hitIds.push(id)
        runEffects(onHit, context, {
          id: `${entity.id}:u${id}:t${tick}`,
          rootId: entity.rootId,
          ownerId: entity.ownerId,
          tick,
          at: position,
          aim: travel,
          subject: id,
          travelEnd,
        })
      }
      // The owner picks it up by touching it: walking over it, or it arriving home. Any hits it
      // made this tick still count, and then it is gone without running its other effects.
      if (def.pickup && def.radius !== undefined && owner) {
        const ownerState = states.get(entity.ownerId)
        if (
          ownerState
          && isAlive(ownerState)
          && distanceBetween(position, ownerState.position) <= def.radius + owner.champion.radius
        ) {
          runEffects(def.pickup, context, {
            id: `${entity.id}:pickup`,
            rootId: entity.rootId,
            ownerId: entity.ownerId,
            tick,
            at: position,
            aim: null,
            subject: entity.ownerId,
          })
          continue
        }
      }
      if (def.onPulse && def.pulseEveryTicks && tick > entity.startTick
        && (tick - entity.startTick) % def.pulseEveryTicks === 0) {
        runEffects(def.onPulse, context, {
          id: `${entity.id}:pulse:t${tick}`,
          rootId: entity.rootId,
          ownerId: entity.ownerId,
          tick,
          at: position,
          aim: travel,
          subject: null,
          travelEnd,
        })
      }
      if (def.onTick) {
        // No tick in the ID: statuses an entity applies each tick refresh instead of stacking.
        runEffects(def.onTick, context, {
          id: `${entity.id}:tick`,
          rootId: entity.rootId,
          ownerId: entity.ownerId,
          tick,
          at: position,
          aim: travel,
          subject: null,
          travelEnd,
        })
      }
      if (struck.length > 0 && !def.pierce) continue
      remaining.push(entity)
    }
    return remaining
  }

  // How long an ability's whole cooldown is for this character: the ability's own, shortened by its haste.
  private cooldownOf(def: AbilityDef, characterId: number, state: GameFrameCharacter): number {
    return hastedCooldownTicks(def.cooldownTicks, statsOfState(this.characters.get(characterId), state)?.haste ?? 0)
  }

  private applyWrites(
    context: TickContext,
    states: ReadonlyMap<number, GameFrameCharacter>,
    entities: SimEntity[],
    tick: number,
  ): DeathRecord[] {
    // A structure is hurt by attacks and nothing else: no status, marker, push, blink, heal or lost health lands on it, and while it is
    // protected nothing at all does damage to it. Who is protected is worked out before anything lands, so a turret that falls this
    // tick does not open the one it guards until the next.
    const isStructure = (unitId: number): boolean => this.characters.get(unitId)?.structure === true
    const shielded = this.shieldedBy((id) => { const state = states.get(id); return state !== undefined && isAlive(state) })
    for (const { unitId, status } of context.statusWrites) {
      const state = states.get(unitId)
      if (!state || !isAlive(state) || isStructure(unitId)) continue
      // Reapplying the same provenance ID refreshes the status instead of stacking it.
      state.statuses = [...state.statuses.filter((existing) => existing.id !== status.id), status]
      // A stun interrupts a windup that has not launched yet; nothing is spent.
      if (status.kind === 'stun' && state.action && state.action.launchTick > tick) state.action = undefined
    }
    // Pops land before new stacks so one tick can pop a unit and re-apply to it.
    for (const { unitId, key, ownerId, count } of context.markerRemovals) {
      const state = states.get(unitId)
      if (!state) continue
      const matching = state.markers.filter((marker) => marker.key === key && marker.ownerId === ownerId)
      // A set number goes oldest first, the order they were placed in.
      const removed = new Set(
        matching
          .sort((left, right) => left.startTick - right.startTick || compareStrings(left.id, right.id))
          .slice(0, count ?? matching.length)
          .map((marker) => marker.id),
      )
      state.markers = state.markers.filter((marker) => !removed.has(marker.id))
    }
    const markedStates = new Set<GameFrameCharacter>()
    for (const { unitId, marker } of context.markerWrites) {
      const state = states.get(unitId)
      if (!state || !isAlive(state) || isStructure(unitId)) continue
      state.markers = [...state.markers.filter((existing) => existing.id !== marker.id), marker]
      markedStates.add(state)
    }
    for (const state of markedStates) state.markers = settleStacks(state.markers)
    for (const { unitId, target, speed, through, contact } of context.dashWrites) {
      const state = states.get(unitId)
      const character = this.characters.get(unitId)
      if (!state || !character || !isAlive(state) || character.structure) continue
      state.dash = {
        // A dash goes over walls, so it can end behind one, but not in one: it lands on the nearest
        // place the character can stand.
        target: this.ground.resolve(target, character.champion.radius),
        speed,
        ...(through ? { through: true } : {}),
        ...(contact ? { contact: { ...contact, origin: { ...contact.origin }, hitIds: [] } } : {}),
      }
    }
    // Who did the damage that took each character's last health.
    const killers = new Map<number, number>()
    for (const event of context.events) {
      if (event.type === 'damage') {
        const state = states.get(event.targetId)
        // An ability's damage does nothing to a structure (an auto attack's id starts with `ATTACK_SOURCE_PREFIX`), and none does
        // anything while it is protected.
        if (isStructure(event.targetId) && (!event.id.startsWith(ATTACK_SOURCE_PREFIX) || shielded.has(event.targetId))) continue
        if (state) {
          const hadHealth = (state.health?.hp ?? 0) > 0
          applyDamage(state, event.amount, tick, statsOfState(this.characters.get(event.targetId), state)?.resistance ?? 0)
          if (hadHealth && state.health?.hp === 0) killers.set(event.targetId, event.ownerId)
          // A monster that is minding its own business and is hurt by an enemy knows who to go after.
          if (state.ai?.mode === 'idle' && event.amount > 0) {
            const victim = this.characters.get(event.targetId)
            const attacker = this.characters.get(event.ownerId)
            if (victim && attacker && areEnemies(victim, attacker)) state.ai = { mode: 'idle', provokedBy: attacker.id }
          }
        }
      } else if (event.type === 'lose-health') {
        const health = states.get(event.unitId)?.health
        if (health && health.deathTick === undefined && health.hp > 1 && !isStructure(event.unitId)) {
          health.hp = Math.max(1, health.hp - event.amount)
          health.hpSeq += 1
          health.finalizedTick = tick
        }
      } else if (event.type === 'heal') {
        const health = states.get(event.unitId)?.health
        if (health && health.deathTick === undefined && health.hp > 0 && !isStructure(event.unitId)) {
          health.hp = Math.min(health.maxHp, health.hp + event.amount)
        }
      } else if (event.type === 'interrupt') {
        const state = states.get(event.unitId)
        if (state?.action && state.action.launchTick > tick) state.action = undefined
      } else if (event.type === 'cap-cooldown') {
        const state = states.get(event.unitId)
        const readyTick = state?.cooldowns[event.abilityId]
        if (state && readyTick !== undefined) {
          state.cooldowns[event.abilityId] = Math.min(readyTick, tick + event.ticks)
        }
      } else if (event.type === 'start-cooldown') {
        const state = states.get(event.unitId)
        const def = abilityDefs.get(event.abilityId)
        if (state && def) state.cooldowns[event.abilityId] = tick + this.cooldownOf(def, event.unitId, state)
      } else if (event.type === 'refund-cooldown') {
        const state = states.get(event.unitId)
        const def = abilityDefs.get(event.abilityId)
        const readyTick = state?.cooldowns[event.abilityId]
        if (state && def && readyTick !== undefined && readyTick > tick) {
          state.cooldowns[event.abilityId] = Math.max(
            tick,
            readyTick - Math.round(this.cooldownOf(def, event.unitId, state) * event.fraction) - event.ticks,
          )
        }
      } else {
        const state = states.get(event.unitId)
        if (state) state.nextAttackTick = Math.min(state.nextAttackTick, tick)
      }
    }
    // Whoever the tick's damage left with no health dies on this tick, before anything else can
    // act for it.
    const deaths: DeathRecord[] = []
    for (const state of [...states.values()].sort((left, right) => left.characterId - right.characterId)) {
      const health = state.health
      if (!health || health.deathTick !== undefined || health.hp > 0) continue
      const killerId = killers.get(state.characterId)
      killCharacter(state, tick)
      deaths.push({
        tick,
        victimId: state.characterId,
        ...(killerId !== undefined && killerId !== state.characterId ? { killerId } : {}),
      })
    }
    // A kill pays its experience and its gold on the tick it happens, in the frame, so a level and a purchase are the same tick on every peer and a
    // death that a late order undoes takes them back with the rest of the frame. (The shards are credited when the kill can no longer
    // be undone: see `confirmDeathsUpTo`.) Only a player is paid, whatever it killed.
    for (const death of deaths) {
      if (death.killerId === undefined || !this.hasEconomy) continue
      const killer = this.characters.get(death.killerId)
      const state = states.get(death.killerId)
      if (!killer || killer.isNpc || !state) continue
      const reward = killReward(this.characters.get(death.victimId), levelOfState(states.get(death.victimId)))
      if (reward.xp > 0) gainExperience(killer, state, reward.xp)
      if (reward.gold > 0) state.gold = (state.gold ?? 0) + reward.gold
    }
    // A blink lands after the tick's damage and pushes but before anything else can move the unit,
    // so the next frame has it at the point.
    for (const { unitId, target } of context.blinkWrites) {
      const state = states.get(unitId)
      const character = this.characters.get(unitId)
      if (!state || !character || !isAlive(state) || character.structure) continue
      // A blink goes over walls, and lands where the character can stand.
      state.position = this.ground.resolve(target, character.champion.radius)
    }
    for (const { ownerId, defId } of context.entityRemovals) {
      for (let index = entities.length - 1; index >= 0; index -= 1) {
        if (entities[index].ownerId === ownerId && entities[index].defId === defId) entities.splice(index, 1)
      }
    }
    for (const entity of context.entityWrites) {
      const index = entities.findIndex((existing) => existing.id === entity.id)
      if (index >= 0) entities.splice(index, 1)
      entities.push(entity)
    }
    for (const { unitId, order } of context.orderWrites) {
      const state = states.get(unitId)
      if (!state) continue
      state.queuedOrders.push({ ...order, tick: Math.max(order.tick, tick + 1) })
    }
    return deaths
  }

  private createInitialFrame(): GameTickSnapshot {
    const objective = initialObjective(this.setup)
    return new GameTickSnapshot(0, {
      tick: 0,
      characters: [...this.characters.values()]
        .sort((left, right) => left.id - right.id)
        .map((character) => this.createInitialCharacterFrame(character)),
      entities: [],
      ...(objective ? { objective } : {}),
    })
  }

  private createInitialCharacterFrame(character: SimCharacter): GameFrameCharacter {
    const champion = character.champion
    return {
      ...(character.monster ? { ai: { mode: 'idle' as const } } : {}),
      characterId: character.id,
      position: { ...character.initialPosition },
      health: {
        hp: champion.maxHp,
        maxHp: champion.maxHp,
        hpSeq: 0,
        finalizedTick: 0,
      },
      nextAttackTick: 0,
      cooldowns: {},
      statuses: [],
      markers: [],
      queuedOrders: [],
      // After the rest, which is the order a frame read back from a snapshot has its fields in (see `GameFrameCharacterSchema`).
      ...(character.player && this.hasEconomy ? { gold: GAME_STARTING_GOLD } : {}),
    }
  }

  private storeFrame(frame: GameTickSnapshot): void {
    this.frameBuffer[frame.tick % this.frameBuffer.length] = frame
    this.latestComputedTick = Math.max(this.latestComputedTick, frame.tick)
  }

  private getCachedFrame(tick: number): GameTickSnapshot | undefined {
    const frame = this.frameBuffer[tick % this.frameBuffer.length]
    return frame?.tick === tick ? frame : undefined
  }

  private invalidateFrom(tick: number): void {
    if (tick > this.latestComputedTick) return
    if (tick === 0) {
      this.resetFrameHistory()
      return
    }
    for (const deathTick of this.pendingDeaths.keys()) {
      if (deathTick >= tick) this.pendingDeaths.delete(deathTick)
    }
    for (let frameTick = tick; frameTick <= this.latestComputedTick; frameTick += 1) {
      const slot = frameTick % this.frameBuffer.length
      if (this.frameBuffer[slot]?.tick === frameTick) this.frameBuffer[slot] = undefined
    }
    this.latestComputedTick = tick - 1
  }

  private resetFrameHistory(): void {
    this.pendingDeaths.clear()
    this.frameBuffer.fill(undefined)
    this.latestComputedTick = 0
    this.storeFrame(this.createInitialFrame())
  }
}

function compareCharacterOrders(
  left: CharacterOrder,
  right: CharacterOrder,
  leftCharacter?: SimCharacter,
  rightCharacter?: SimCharacter,
): number {
  if (left.tick !== right.tick) return left.tick - right.tick
  if (left.seq !== right.seq) return left.seq - right.seq
  const leftPlayerId = leftCharacter?.player?.playerId ?? ''
  const rightPlayerId = rightCharacter?.player?.playerId ?? ''
  if (leftPlayerId < rightPlayerId) return -1
  if (leftPlayerId > rightPlayerId) return 1
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  if (leftCharacter && rightCharacter && leftCharacter.id !== rightCharacter.id) {
    return leftCharacter.id - rightCharacter.id
  }
  return 0
}

// The level a frame's character is, from the experience in it.
function levelOfState(state: GameFrameCharacter | undefined): number {
  return state?.level ?? levelForXp(state?.xp ?? 0)
}

// A character's stats at the level its frame has (see `Champion.statsAt`), with what the items it carries add to them (see items.ts).
function statsOfState(character: SimCharacter | undefined, state: GameFrameCharacter | undefined): ChampionStats | undefined {
  return character ? withItems(character.champion.statsAt(levelOfState(state)), state?.items) : undefined
}

// A copy of what a frame's character carries, to change.
function copyItems(items: GameFrameCharacter['items']): Record<string, string> {
  const copy: Record<string, string> = {}
  for (const slot of ITEM_SLOTS) {
    const id = items?.[slot]
    if (id !== undefined) copy[slot] = id
  }
  return copy
}

// Sets the character's maximum health to what its stats say now, its level and its items, and moves the health it has by as much: more for what was
// gained, and less for what was lost, though never to nothing for one that is alive. That is not damage or a heal, so the health's sequence is left as
// it was. A character that is dead has none to move.
function refitHealth(character: SimCharacter, state: GameFrameCharacter): void {
  const health = state.health
  const stats = statsOfState(character, state)
  if (!health || !stats) return
  const change = stats.maxHp - health.maxHp
  health.maxHp = stats.maxHp
  if (change === 0 || health.deathTick !== undefined || health.hp <= 0) return
  health.hp = Math.min(stats.maxHp, Math.max(1, health.hp + change))
}

// What killing this character pays whoever does it: what a monster's, a turret's or a core's entry says it is worth, or a flat amount for a player. A
// monster pays more experience for each level it has gained (`monsterXpAt`, at the level it died at) and the same gold and shards; the level is not
// needed for the shards, which are credited later, so that one can be left out.
function killReward(victim: SimCharacter | undefined, victimLevel = 1): Readonly<Resources> {
  const monster = victim?.monster
  if (monster) return { ...monster.reward, xp: monsterXpAt(monster.reward.xp, monster.xpGrowth, victimLevel) }
  return victim?.turret?.reward ?? victim?.core?.reward ?? PLAYER_KILL_REWARD
}

// Gives the character experience. A level gained is more health: the maximum goes up to what the new level's stats say, and so does
// the health it has, by as much, unless it is dead (`refitHealth`).
function gainExperience(character: SimCharacter, state: GameFrameCharacter, amount: number): void {
  state.xp = (state.xp ?? 0) + amount
  refitHealth(character, state)
}

// Takes the damage off the health. What is taken is the damage less what the character's resistance takes off it (see `statReduction`)
// and less what its resist statuses take, which add up to at most 90%, and both act before shields.
function applyDamage(state: GameFrameCharacter, amount: number, tick: number, resistanceStat = 0): void {
  const health = state.health
  if (!health || health.deathTick !== undefined) return
  const resistance = Math.min(0.9, state.statuses.reduce(
    (total, status) => status.kind === 'resist' ? total + status.amount : total,
    0,
  ))
  let remaining = Math.max(0, Math.round(amount * (1 - resistance) * statMultiplier(resistanceStat)))
  if (remaining === 0) return
  // Shield statuses absorb first, soonest-expiring first.
  const shields = state.statuses
    .filter((status) => status.kind === 'shield')
    .sort((left, right) => left.endTick - right.endTick || compareStrings(left.id, right.id))
  for (const status of shields) {
    const absorbed = Math.min(status.amount, remaining)
    status.amount -= absorbed
    remaining -= absorbed
    if (remaining === 0) break
  }
  state.statuses = state.statuses.filter((status) => status.kind !== 'shield' || status.amount > 0)
  health.hp = Math.max(0, health.hp - remaining)
  health.hpSeq += 1
  health.finalizedTick = tick
}

// Whoever has no health left is dead: it stops what it was doing and is a ghost until it respawns.
function killCharacter(state: GameFrameCharacter, tick: number): void {
  const health = state.health
  if (!health || health.deathTick !== undefined) return
  health.hp = 0
  health.deathTick = tick
  health.finalizedTick = tick
  clearActivity(state)
  if (state.ai) state.ai = { mode: 'idle' }
}

function respawnCharacter(character: SimCharacter, state: GameFrameCharacter, tick: number, levelUp = false): void {
  const health = state.health
  if (!health) return
  state.position = { ...character.initialPosition }
  // Whatever killed it has made it a level higher, which is more health to come back with (the level is read for the health just below).
  if (levelUp) state.level = monsterLevelAfterKill(levelOfState(state))
  // Back at the health its level and its items give it. The experience, the gold and the items are kept, as everything in the frame that is not cleared.
  const maxHp = statsOfState(character, state)?.maxHp ?? character.champion.maxHp
  state.health = {
    hp: maxHp,
    maxHp,
    hpSeq: health.hpSeq + 1,
    finalizedTick: tick,
  }
  state.nextAttackTick = tick
  state.cooldowns = {}
  clearActivity(state)
  if (character.monster) state.ai = { mode: 'idle' }
}

function clearActivity(state: GameFrameCharacter): void {
  state.action = undefined
  state.movement = undefined
  state.attackTarget = undefined
  state.dash = undefined
  state.statuses = []
  state.markers = []
  state.queuedOrders = []
}

// A root stops walking; a stun stops that and attacking and casting too.
function isImmobilized(statuses: readonly Status[]): boolean {
  return statuses.some((status) => status.kind === 'root' || status.kind === 'stun')
}

function isStunned(statuses: readonly Status[]): boolean {
  return statuses.some((status) => status.kind === 'stun')
}

// A silence stops starting an ability and nothing else.
function isSilenced(statuses: readonly Status[]): boolean {
  return statuses.some((status) => status.kind === 'silence')
}

// Haste bonuses add together; only the strongest slow applies; the slow scales the hasted speed.
// A fading haste counts for the share of its length still to run at `tick`.
// `itemSpeed` is what the character's items add to its speed (see items.ts).
function getMoveSpeed(character: SimCharacter, statuses: readonly Status[], tick: number, itemSpeed = 0): number {
  let strongestSlow = 0
  let hasteBonus = 0
  for (const status of statuses) {
    if (status.kind === 'slow') strongestSlow = Math.max(strongestSlow, status.amount)
    else if (status.kind === 'haste') hasteBonus += status.fades ? status.amount * shareLeft(status, tick) : status.amount
  }
  return (character.champion.moveSpeed + itemSpeed) * (1 + hasteBonus) * (1 - Math.min(1, strongestSlow))
}

// How much of a status's length is still ahead at `tick`: 1 as it starts, 0 as it ends.
function shareLeft(status: Status, tick: number): number {
  const length = status.endTick - status.startTick
  return length <= 0 ? 0 : Math.max(0, Math.min(1, (status.endTick - tick) / length))
}

// Markers with a cap form a stack per key and owner. Applying to a stack refreshes the
// timer of every marker in it, and only the newest `cap` markers stay.
function settleStacks(markers: Marker[]): Marker[] {
  const groups = new Map<string, Marker[]>()
  for (const marker of markers) {
    if (marker.cap === undefined) continue
    const group = groups.get(`${marker.key}:${marker.ownerId}`) ?? []
    group.push(marker)
    groups.set(`${marker.key}:${marker.ownerId}`, group)
  }
  if (groups.size === 0) return markers

  const settled = new Map<string, Marker>()
  for (const group of groups.values()) {
    const cap = Math.min(...group.map((marker) => marker.cap ?? Infinity))
    const endTick = Math.max(...group.map((marker) => marker.endTick))
    group
      .sort((left, right) => right.startTick - left.startTick || compareStrings(right.id, left.id))
      .slice(0, cap)
      .forEach((marker) => settled.set(marker.id, { ...marker, endTick }))
  }
  return markers.flatMap((marker) =>
    marker.cap === undefined ? [marker] : settled.has(marker.id) ? [settled.get(marker.id) as Marker] : [])
}

function isAlive(state: GameFrameCharacter): boolean {
  return Boolean(state.health && state.health.deathTick === undefined)
}

function isWindingUp(state: GameFrameCharacter, tick: number): boolean {
  return state.action !== undefined && tick < state.action.launchTick
}

function toCooldown(tick: number, readyTick: number): { ready: boolean; ticksRemaining: number } {
  return {
    ready: tick >= readyTick,
    ticksRemaining: Math.max(0, readyTick - tick),
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

function distanceBetween(left: Vector2, right: Vector2): number {
  const dx = left.x - right.x
  const dy = left.y - right.y
  return Math.sqrt(dx * dx + dy * dy)
}

function cloneCastTarget(target: CastTarget): CastTarget {
  switch (target.mode) {
    case 'none':
      return { mode: 'none' }
    case 'point':
      return { mode: 'point', point: { ...target.point } }
    case 'direction':
      return { mode: 'direction', dir: { ...target.dir } }
    case 'unit':
      return { mode: 'unit', unitId: target.unitId }
  }
}

function cloneOrder(order: CharacterOrder): CharacterOrder {
  switch (order.type) {
    case 'move':
      return { ...order, target: { ...order.target } }
    case 'attack':
      return { ...order }
    case 'cast':
      return { ...order, origin: { ...order.origin }, target: cloneCastTarget(order.target) }
    case 'buy':
    case 'sell':
      return { ...order }
  }
}

function cloneAction(action: GameFrameAction): GameFrameAction {
  return action.kind === 'attack'
    ? { ...action }
    : { ...action, origin: { ...action.origin }, target: cloneCastTarget(action.target) }
}

function cloneEntity(entity: SimEntity): SimEntity {
  return {
    ...entity,
    origin: { ...entity.origin },
    velocity: { ...entity.velocity },
    hitIds: [...entity.hitIds],
    ...(entity.facing ? { facing: { ...entity.facing } } : {}),
    ...(entity.position ? { position: { ...entity.position } } : {}),
  }
}

// What a monster decided to do, as the order the simulator carries out. Its ID says whose, and when, so what it
// starts (a stack, a shot) has an ID of its own on every tick.
function aiOrder(character: SimCharacter, order: AiOrder, position: Vector2, tick: number, index: number): CharacterOrder {
  const base = { id: `ai:${character.id}:${tick}:${index}`, seq: tick * 8 + index + 1, tick }
  if (order.type === 'move') return { ...base, type: 'move', target: { ...order.target } }
  if (order.type === 'attack') return { ...base, type: 'attack', targetId: order.targetId }
  return { ...base, type: 'cast', abilityId: order.abilityId, target: cloneCastTarget(order.target), origin: { ...position } }
}

function cloneObjective(objective: ObjectiveState): ObjectiveState {
  if (objective.kind === 'koth' || objective.kind === 'deathmatch') return { ...objective, scores: { ...objective.scores } }
  if (objective.kind === 'core') {
    return { ...objective, broken: [...objective.broken], eliminated: [...objective.eliminated], scores: { ...objective.scores } }
  }
  return {
    ...objective,
    flags: objective.flags.map((flag) => ({ ...flag, position: { ...flag.position } })),
    scores: { ...objective.scores },
  }
}

// Team deathmatch played with no rules set: what a game is when it is not given a mode.
function isPlainDeathmatch(setup: ModeSetup): boolean {
  return setup.kind === 'deathmatch' && setup.respawnTicks === undefined && setup.scoreLimit === undefined
}

function cloneFrameCharacter(character: GameFrameCharacter): GameFrameCharacter {
  const clone: GameFrameCharacter = {
    ...character,
    position: { ...character.position },
    ...(character.health ? { health: { ...character.health } } : {}),
    ...(character.movement ? {
      movement: {
        target: { ...character.movement.target },
      },
    } : {}),
    ...(character.dash ? {
      dash: {
        target: { ...character.dash.target },
        speed: character.dash.speed,
        ...(character.dash.through ? { through: true } : {}),
        ...(character.dash.contact
          ? {
            contact: {
              ...character.dash.contact,
              origin: { ...character.dash.contact.origin },
              hitIds: [...character.dash.contact.hitIds],
            },
          }
          : {}),
      },
    } : {}),
    ...(character.attackTarget ? { attackTarget: { ...character.attackTarget } } : {}),
    ...(character.ai ? { ai: { ...character.ai } } : {}),
    ...(character.action ? { action: cloneAction(character.action) } : {}),
    cooldowns: { ...character.cooldowns },
    statuses: character.statuses.map((status) => ({ ...status })),
    markers: character.markers.map((marker) => ({ ...marker })),
    queuedOrders: character.queuedOrders.map(cloneOrder),
  }
  // The experience, the gold and the items come last, in the order the schema has them, whenever in a frame's life each was first set: a
  // frame is the same data however it got there, and so it is the same text, which is what a frame computed and a frame read back from a
  // snapshot are compared as.
  delete clone.xp
  delete clone.gold
  delete clone.items
  delete clone.level
  if (character.xp !== undefined) clone.xp = character.xp
  if (character.gold !== undefined) clone.gold = character.gold
  if (character.items) clone.items = { ...character.items }
  if (character.level !== undefined) clone.level = character.level
  return clone
}

// Living characters are solid. For every pair whose bodies overlap, each is pushed away from the
// other along the line between their centres by half of `GAME_COLLISION_STIFFNESS` times the
// overlap, so the overlap shrinks by that share every tick. The force grows with the depth, like a
// spring, and the response is too damped to bounce: they slide apart and settle just touching.
//
// Every push is worked out from the positions as the tick found them and applied together, and
// pairs are visited in ID order, so the result does not depend on who is looked at first. Two
// characters on exactly the same spot have no line between them; the lower ID goes toward -x.
// The dead are ghosts, and the arena's edge and the walls still hold whoever is pushed against them. A structure does not give way to
// anyone: whoever is pushed against it takes the whole push, and two structures do not push each other.
function pushCharactersApart(
  states: ReadonlyMap<number, GameFrameCharacter>,
  characters: ReadonlyMap<number, SimCharacter>,
  terrain: Terrain,
): void {
  const living = [...states.values()]
    .filter((state) => isAlive(state) && characters.has(state.characterId))
    .sort((left, right) => left.characterId - right.characterId)
  const pushes = new Map<number, Vector2>()
  const addPush = (id: number, x: number, y: number): void => {
    const total = pushes.get(id) ?? { x: 0, y: 0 }
    pushes.set(id, { x: total.x + x, y: total.y + y })
  }
  for (let first = 0; first < living.length; first += 1) {
    for (let second = first + 1; second < living.length; second += 1) {
      const left = living[first]
      const right = living[second]
      // Someone dashing through passes through everyone, and no one is pushed for it.
      if (left.dash?.through || right.dash?.through) continue
      const reach = (characters.get(left.characterId)?.champion.radius ?? 0)
        + (characters.get(right.characterId)?.champion.radius ?? 0)
      const dx = right.position.x - left.position.x
      const dy = right.position.y - left.position.y
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance >= reach) continue
      const leftFixed = characters.get(left.characterId)?.structure === true
      const rightFixed = characters.get(right.characterId)?.structure === true
      if (leftFixed && rightFixed) continue
      const push = (reach - distance) * GAME_COLLISION_STIFFNESS / 2
      const awayX = distance === 0 ? 1 : dx / distance
      const awayY = distance === 0 ? 0 : dy / distance
      if (!leftFixed) addPush(left.characterId, -awayX * push * (rightFixed ? 2 : 1), -awayY * push * (rightFixed ? 2 : 1))
      if (!rightFixed) addPush(right.characterId, awayX * push * (leftFixed ? 2 : 1), awayY * push * (leftFixed ? 2 : 1))
    }
  }
  for (const [id, push] of pushes) {
    const state = states.get(id)
    const character = characters.get(id)
    if (!state || !character) continue
    const radius = character.champion.radius
    const pushed = terrain.clamp({ x: state.position.x + push.x, y: state.position.y + push.y }, radius)
    // Walls hold whoever is pushed against them too, but not one dashing over them.
    state.position = state.dash ? pushed : terrain.keepOutOfWalls(pushed, radius)
  }
}

function stepToward(position: Vector2, target: Vector2, stepLength: number, radius: number, terrain: Terrain): Vector2 {
  const dx = target.x - position.x
  const dy = target.y - position.y
  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance <= stepLength) return { ...target }

  const progress = stepLength / distance
  return terrain.clamp({
    x: position.x + dx * progress,
    y: position.y + dy * progress,
  }, radius)
}

