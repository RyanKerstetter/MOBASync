import {
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_ATTACK_WINDUP_TICKS,
  GAME_ATTACK_BACKDATE_CAP_TICKS,
  FINALIZE_LAG,
  GAME_TPS,
  GAME_ORDER_VERDICT_RETENTION_MS,
  GameStatusSchema,
  Simulator,
  type GameBroadcastOrder,
  type GameHealthResult,
  type GameOrder,
  type GameOrderAck,
  type GameSnapshot,
  type GameStatus,
} from '../../../packages/shared/src/index.js'

type LobbyPlayer = { id: string; name: string }
type CachedOrderAck = { ack: GameOrderAck; expiresAt: number }
type OrderVerdict = { ack: GameOrderAck; broadcast?: GameBroadcastOrder }
const HP_EFFECT_PRIORITY = {
  damage: 0,
  heal: 1,
  revive: 2,
} as const
export class ServerGameState {
  status: GameStatus = GameStatusSchema.enum.idle
  readonly simulator = new Simulator()
  private readonly readyPlayers = new Set<string>()
  private readonly entityIdsByPlayerId = new Map<string, number>()
  private readonly orderAcksByPlayerId = new Map<string, Map<string, CachedOrderAck>>()
  private nextEntityId = 1

  get readyPlayerIds(): string[] {
    return [...this.readyPlayers]
  }

  begin(players: Iterable<LobbyPlayer>): void {
    this.status = GameStatusSchema.enum.starting
    this.readyPlayers.clear()
    this.simulator.entities.clear()
    this.simulator.projectiles.clear()
    this.simulator.tick = 0
    this.entityIdsByPlayerId.clear()
    this.orderAcksByPlayerId.clear()
    this.nextEntityId = 1

    const roster = [...players]
    roster.forEach((player, index) => {
      const entityId = this.nextEntityId
      this.nextEntityId += 1
      this.entityIdsByPlayerId.set(player.id, entityId)
      this.simulator.addPlayer(
        entityId,
        player.id,
        player.name,
        {
          x: GAME_ARENA_WIDTH * (index + 1) / (roster.length + 1),
          y: GAME_ARENA_HEIGHT / 2,
        },
      )
    })
  }

  cancelStart(): void {
    if (this.status !== GameStatusSchema.enum.starting) return
    this.status = GameStatusSchema.enum.idle
    this.readyPlayers.clear()
    this.simulator.entities.clear()
    this.simulator.projectiles.clear()
    this.entityIdsByPlayerId.clear()
    this.orderAcksByPlayerId.clear()
  }

  markReady(playerId: string): boolean {
    if (this.status !== GameStatusSchema.enum.starting || !this.entityIdsByPlayerId.has(playerId)) {
      return false
    }
    this.readyPlayers.add(playerId)
    return true
  }

  unmarkReady(playerId: string): void {
    this.readyPlayers.delete(playerId)
  }

  startIfReady(): GameSnapshot | undefined {
    if (
      this.status !== GameStatusSchema.enum.starting
      || this.entityIdsByPlayerId.size === 0
      || this.readyPlayers.size !== this.entityIdsByPlayerId.size
    ) {
      return undefined
    }
    this.status = GameStatusSchema.enum.running
    return this.snapshot()
  }

  snapshot(): GameSnapshot {
    return this.simulator.snapshot()
  }

  advanceTick(): void {
    this.simulator.advanceTo(this.simulator.tick + 1)
  }

  getEntityId(playerId: string): number | undefined {
    return this.entityIdsByPlayerId.get(playerId)
  }

  getNextOrderSequence(playerId: string): number {
    const entityId = this.entityIdsByPlayerId.get(playerId)
    const entity = entityId === undefined ? undefined : this.simulator.entities.get(entityId)
    return (entity?.highestOrderSequence ?? 0) + 1
  }

  private getCachedOrderAck(playerId: string, orderId: string, now = Date.now()): GameOrderAck | undefined {
    const orderAcks = this.orderAcksByPlayerId.get(playerId)
    if (!orderAcks) return undefined
    for (const [id, cached] of orderAcks) {
      if (cached.expiresAt <= now) orderAcks.delete(id)
    }
    if (orderAcks.size === 0) this.orderAcksByPlayerId.delete(playerId)
    return this.orderAcksByPlayerId.get(playerId)?.get(orderId)?.ack
  }

  acceptOrder(playerId: string, order: GameOrder): OrderVerdict {
    const cachedAck = this.getCachedOrderAck(playerId, order.id)
    if (cachedAck) return { ack: cachedAck }

    const entityId = this.entityIdsByPlayerId.get(playerId)
    const attacker = entityId === undefined ? undefined : this.simulator.entities.get(entityId)
    const serverTick = this.simulator.tick
    let reason: string | undefined

    if (attacker?.hasOrderSequence(order.seq)) {
      reason = 'stale'
    } else if (entityId === undefined || !attacker) {
      reason = order.type === 'attack' ? 'dead' : 'The player entity is not available.'
    } else if (order.type === 'move') {
      if (
        order.clientTick < Math.max(0, serverTick - GAME_TPS * 2)
        || order.clientTick > serverTick + GAME_TPS * 2
        || order.clientTick < attacker.latestOrderTick
        || order.seq <= attacker.highestOrderSequence
      ) {
        reason = 'stale'
      } else if (attacker.health && (attacker.health.hp <= 0 || attacker.health.deathTick !== undefined)) {
        reason = 'dead'
      } else if (!this.simulator.addOrder(entityId, order)) {
        reason = 'The order could not be applied to the player entity.'
      }
    } else {
      const stamp = this.getAttackStamp(order.clickTick, serverTick)
      const actionTick = Math.max(serverTick, order.clickTick)
      const target = this.simulator.entities.get(order.targetId)
      if (
        order.clickTick < Math.max(0, serverTick - GAME_ATTACK_BACKDATE_CAP_TICKS)
        || order.clickTick > serverTick + GAME_ATTACK_BACKDATE_CAP_TICKS
      ) {
        reason = 'stale'
      } else if (
        !attacker.health
        || attacker.health.hp <= 0
        || attacker.health.deathTick !== undefined
        || !target?.health
        || target.health.hp <= 0
        || target.health.deathTick !== undefined
      ) {
        reason = 'dead'
      } else if (
        target.player?.playerId === playerId
        || !attacker.attackStats
        || Math.hypot(
          attacker.posAt(actionTick).x - target.posAt(actionTick).x,
          attacker.posAt(actionTick).y - target.posAt(actionTick).y,
        ) > attacker.attackStats.attackRange
      ) {
        reason = 'out_of_range'
      } else if (!attacker.attackStats.canAttackAt(
        stamp,
        serverTick,
        GAME_ATTACK_BACKDATE_CAP_TICKS,
      )) {
        reason = 'cooldown'
      } else {
        const position = attacker.posAt(actionTick)
        const inserted = this.simulator.addOrder(entityId, {
          type: 'attack',
          tick: actionTick,
          seq: order.seq,
          stamp,
          position,
        })
        if (!inserted) {
          reason = 'stale'
        } else {
          attacker.attackStats.recordAttackAt(stamp)
          const effectTick = Math.max(
            stamp + GAME_ATTACK_WINDUP_TICKS,
            (target.health.finalizedTick ?? 0) + 1,
          )
          target.health.pendingHp.push({
            id: `${order.id}:dmg`,
            tick: effectTick,
            amount: 1,
            priority: HP_EFFECT_PRIORITY.damage,
            stamp,
            seq: order.seq,
            attackerId: playerId,
          })

          const verdict: OrderVerdict = {
            ack: { id: order.id, seq: order.seq, status: 'accepted', serverTick, stamp, actionTick, position },
            broadcast: {
              ...order,
              entityId,
              playerId,
              playerName: attacker.player?.name ?? 'Player',
              serverTick,
              stamp,
              actionTick,
              position,
            },
          }
          this.cacheOrderAck(playerId, verdict.ack)
          return verdict
        }
      }
    }

    const verdict: OrderVerdict = {
      ack: {
        id: order.id,
        seq: order.seq,
        status: reason ? 'rejected' : 'accepted',
        serverTick,
        ...(reason ? { reason } : {}),
      },
      ...(reason || !attacker || entityId === undefined || order.type !== 'move'
        ? {}
        : {
          broadcast: {
            ...order,
            entityId,
            playerId,
            playerName: attacker.player?.name ?? 'Player',
            serverTick,
          },
        }),
    }
    this.cacheOrderAck(playerId, verdict.ack)
    return verdict
  }

  finalizeUpTo(nowTick: number): GameHealthResult[] {
    const finalizeThrough = Math.max(0, nowTick - FINALIZE_LAG)
    const results: GameHealthResult[] = []
    for (const entity of this.simulator.entities.values()) {
      const health = entity.health
      if (!health) continue
      const effectsByTick = new Map<number, typeof health.pendingHp>()
      health.pendingHp.sort((left, right) =>
        left.tick - right.tick
        || left.priority - right.priority
        || left.stamp - right.stamp
        || left.seq - right.seq
        || left.attackerId.localeCompare(right.attackerId)
        || left.id.localeCompare(right.id),
      )
      for (let index = 0; index < health.pendingHp.length;) {
        const effect = health.pendingHp[index]
        if (effect.tick > finalizeThrough) {
          index += 1
          continue
        }
        health.pendingHp.splice(index, 1)
        const effects = effectsByTick.get(effect.tick) ?? []
        effects.push(effect)
        effectsByTick.set(effect.tick, effects)
      }

      for (const [tick, effects] of effectsByTick) {
        if (
          health.deathTick !== undefined
        ) continue

        let dealt = 0
        for (const effect of effects) {
          const shieldDamage = Math.min(health.shield, effect.amount)
          health.shield -= shieldDamage
          const hpDamage = Math.min(health.hp, effect.amount - shieldDamage)
          health.hp -= hpDamage
          dealt += shieldDamage + hpDamage
        }
        health.hpSeq += 1
        if (health.hp <= 0) health.deathTick = tick
        results.push({
          targetId: entity.id,
          hpAfter: health.hp,
          shieldAfter: health.shield,
          hpSeq: health.hpSeq,
          dealt,
        })
      }
      health.finalizedTick = Math.max(health.finalizedTick, finalizeThrough)
      if (health.deathTick !== undefined) health.pendingHp.length = 0
    }
    return results
  }

  removePlayer(playerId: string): void {
    const entityId = this.entityIdsByPlayerId.get(playerId)
    if (entityId !== undefined) this.simulator.remove(entityId)
    this.entityIdsByPlayerId.delete(playerId)
    this.readyPlayers.delete(playerId)
    this.orderAcksByPlayerId.delete(playerId)
  }

  private cacheOrderAck(playerId: string, ack: GameOrderAck, now = Date.now()): void {
    const orderAcks = this.orderAcksByPlayerId.get(playerId) ?? new Map<string, CachedOrderAck>()
    const cached = orderAcks.get(ack.id)
    if (cached && cached.expiresAt > now) return
    for (const [id, entry] of orderAcks) {
      if (entry.expiresAt <= now) orderAcks.delete(id)
    }
    orderAcks.set(ack.id, { ack, expiresAt: now + GAME_ORDER_VERDICT_RETENTION_MS })
    this.orderAcksByPlayerId.set(playerId, orderAcks)
  }

  private getAttackStamp(clickTick: number, serverTick: number): number {
    return Math.max(
      Math.max(0, serverTick - GAME_ATTACK_BACKDATE_CAP_TICKS),
      Math.min(clickTick, serverTick),
    )
  }
}
