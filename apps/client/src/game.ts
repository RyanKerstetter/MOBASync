import geckos from '@geckos.io/client'
import {
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_FPS,
  GAME_ORDER_TIMEOUT_MS,
  GAME_PING_INTERVAL_MS,
  GAME_TPS,
  GameBroadcastOrderSchema,
  GameDeathSchema,
  GameJoinedSchema,
  GameOrderAckSchema,
  GamePongSchema,
  GameSnapshotSchema,
  ReliableMessenger,
  lagConfigFromQuery,
  withLag,
  type GameOrder,
  type GameOrderAck,
  type GameSnapshot,
  type LagConfig,
} from '../../../packages/shared/src/index.ts'
import { Application, Container, Graphics, Rectangle, Text } from 'pixi.js'
import {
  ClientGameState,
  type RenderedEntity,
  type RenderedProjectile,
} from './game-state.ts'

type GameOptions = {
  container: HTMLElement
  lobbyCode: string
  sessionId: string
  playerName: string
  onStatus: (text: string, isError?: boolean) => void
  onReadyProgress: (readyCount: number, totalPlayers: number) => void
  onStarted: (snapshot: GameSnapshot) => void
  onCancelled: (message: string) => void
  onDisconnected: () => void
  orderTimeoutMs?: number
}

type Actor = {
  node: Container
  label: Text
  healthBar: Graphics
  shieldBar: Graphics
  cooldownBar: Graphics
}

type FloatingDamage = {
  node: Text
  startedAt: number
}

type DisplayedHealth = {
  total: number
  hpSeq: number
}

const abilityKeys = ['KeyQ', 'KeyW', 'KeyE', 'KeyR']
const START_PING_RETRY_MS = 250

export async function startGame({
  container,
  lobbyCode,
  sessionId,
  onStatus,
  onReadyProgress,
  onStarted,
  onCancelled,
  onDisconnected,
  orderTimeoutMs = GAME_ORDER_TIMEOUT_MS,
}: GameOptions): Promise<() => void> {
  if (!Number.isFinite(orderTimeoutMs) || orderTimeoutMs <= 0) {
    throw new RangeError('Order timeout must be a finite, positive number.')
  }
  const app = new Application()
  await app.init({
    background: '#101827',
    resizeTo: container,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  })
  app.ticker.maxFPS = GAME_FPS
  container.replaceChildren(app.canvas)

  const debugOverlay = document.createElement('pre')
  debugOverlay.className = 'game-debug-overlay'
  debugOverlay.setAttribute('aria-label', 'Game network and simulation diagnostics')
  debugOverlay.textContent = 'Waiting for game diagnostics…'
  container.appendChild(debugOverlay)

  const scene = new Container()
  app.stage.addChild(scene)
  const resizeScene = (): void => {
    const scale = Math.min(app.screen.width / GAME_ARENA_WIDTH, app.screen.height / GAME_ARENA_HEIGHT)
    scene.scale.set(scale)
    scene.position.set(
      (app.screen.width - GAME_ARENA_WIDTH * scale) / 2,
      (app.screen.height - GAME_ARENA_HEIGHT * scale) / 2,
    )
  }
  resizeScene()

  scene.addChild(
    new Graphics()
      .roundRect(0, 0, GAME_ARENA_WIDTH, GAME_ARENA_HEIGHT, 18)
      .fill({ color: '#18263a' })
      .stroke({ color: '#314862', width: 2 }),
  )

  const gameState = new ClientGameState()
  const actors = new Map<number, Actor>()
  const projectileActors = new Map<string, Container>()
  const floatingDamage: FloatingDamage[] = []
  const displayedHealth = new Map<number, DisplayedHealth>()
  let pointer = { x: GAME_ARENA_WIDTH / 2, y: GAME_ARENA_HEIGHT / 2 }
  const attackRangeRing = new Graphics()
  attackRangeRing.alpha = 0.3
  attackRangeRing.visible = false
  scene.addChild(attackRangeRing)
  const addActor = (entity: RenderedEntity): Actor => {
    const isLocal = entity.player?.playerId === sessionId
    const node = new Container()
    const shape = new Graphics()
      .circle(0, 0, entity.champion.radius)
      .fill({
        color: isLocal ? '#79dfb1' : '#81b8ff',
      })
      .stroke({ color: '#e8f4ff', width: 3 })
    const label = new Text({
      text: entity.player?.name ?? '',
      style: { fill: '#e8f4ff', fontSize: 16, fontFamily: 'Arial' },
    })
    label.anchor.set(0.5, 1)
    const healthBar = new Graphics()
    const shieldBar = new Graphics()
    const cooldownBar = new Graphics()
    node.addChild(shape, label, healthBar, shieldBar, cooldownBar)
    scene.addChild(node)
    const actor = { node, label, healthBar, shieldBar, cooldownBar }
    actors.set(entity.id, actor)
    return actor
  }

  const drawBar = (
    graphics: Graphics,
    y: number,
    fraction: number,
    fillColor: string,
    height = 4,
  ): void => {
    const width = 40
    graphics.clear()
      .roundRect(-width / 2, y, width, height, 2)
      .fill({ color: '#101827' })
      .roundRect(-width / 2, y, width * Math.max(0, Math.min(1, fraction)), height, 2)
      .fill({ color: fillColor })
  }

  const renderState = (now = performance.now()): void => {
    const entities = gameState.getEntities(now)
    const activeIds = new Set(entities.map((entity) => entity.id))
    for (const entity of entities) {
      const health = {
        total: (entity.health?.hp ?? 0) + entity.totalShield,
        hpSeq: entity.health?.hpSeq ?? 0,
      }
      const previousHealth = displayedHealth.get(entity.id)
      // Only damage advances hpSeq, so an expiring shield is not shown as damage.
      if (
        previousHealth !== undefined
        && health.hpSeq > previousHealth.hpSeq
        && health.total < previousHealth.total
      ) {
        showFloatingDamage(entity.id, previousHealth.total - health.total)
      }
      displayedHealth.set(entity.id, health)
    }
    for (const [id, actor] of actors) {
      if (!activeIds.has(id)) {
        scene.removeChild(actor.node)
        actor.node.destroy({ children: true })
        actors.delete(id)
        displayedHealth.delete(id)
      }
    }
    for (const entity of entities) {
      const actor = actors.get(entity.id) ?? addActor(entity)
      actor.label.text = entity.player?.name ?? ''
      const radius = entity.champion.radius
      actor.node.position.set(entity.position.x, entity.position.y)
      // A confirmed death leaves a faint ghost with no bars until the respawn.
      actor.node.alpha = entity.dead ? 0.25 : 1
      actor.healthBar.visible = !entity.dead
      actor.shieldBar.visible = !entity.dead
      actor.label.position.set(0, -radius - 25)
      drawBar(
        actor.healthBar,
        -radius - 15,
        entity.health ? entity.health.hp / entity.health.maxHp : 0,
        '#67d391',
      )
      drawBar(
        actor.shieldBar,
        -radius - 9,
        entity.health ? entity.totalShield / entity.health.maxHp : 0,
        '#72c9ff',
        3,
      )
      const isLocal = entity.id === gameState.getLocalEntityId()
      actor.cooldownBar.visible = isLocal && !entity.dead
      if (isLocal && entity.dead) {
        attackRangeRing.visible = false
      } else if (isLocal) {
        drawBar(actor.cooldownBar, -radius - 4, gameState.getAttackCooldownProgress(now), '#f2b66d', 2)
        attackRangeRing.clear()
          .circle(0, 0, gameState.getLocalAttackRange() ?? 0)
          .stroke({ color: '#79dfb1', width: 2 })
        attackRangeRing.position.set(entity.position.x, entity.position.y)
        attackRangeRing.visible = true
      }
    }
    if (!entities.some((entity) => entity.id === gameState.getLocalEntityId())) {
      attackRangeRing.visible = false
    }

    const projectiles = gameState.getProjectiles(now)
    const activeProjectileIds = new Set(projectiles.map((projectile) => projectile.id))
    for (const [id, actor] of projectileActors) {
      if (!activeProjectileIds.has(id)) {
        scene.removeChild(actor)
        actor.destroy()
        projectileActors.delete(id)
      }
    }
    for (const projectile of projectiles) {
      const actor = projectileActors.get(projectile.id) ?? addProjectileActor(projectile)
      actor.position.set(projectile.position.x, projectile.position.y)
    }
  }

  const addProjectileActor = (projectile: RenderedProjectile): Container => {
    const actor = new Container()
    actor.addChild(new Graphics().circle(0, 0, projectile.radius).fill({ color: '#f2b66d' }))
    scene.addChild(actor)
    projectileActors.set(projectile.id, actor)
    return actor
  }

  const showFloatingDamage = (targetId: number, dealt: number): void => {
    if (dealt <= 0) return
    const entity = gameState.getEntities().find((candidate) => candidate.id === targetId)
    if (!entity) return
    const node = new Text({
      text: `-${dealt}`,
      style: { fill: '#ffd27a', fontSize: 16, fontFamily: 'Arial', fontWeight: 'bold' },
    })
    node.anchor.set(0.5)
    node.position.set(entity.position.x, entity.position.y - entity.champion.radius - 24)
    scene.addChild(node)
    floatingDamage.push({ node, startedAt: performance.now() })
  }

  let started = false
  let pendingStart: GameSnapshot | undefined
  let startPingTimer: number | undefined
  let disconnected = false
  let connected = false
  // Open the page with ?lag=100&jitter=20&loss=0.05, or tweak window.lag live in the console.
  const { channel, config: lagConfig } = withLag(
    // The dev and preview servers proxy Geckos signaling (/.wrtc) on the page's own port.
    geckos({
      url: `${window.location.protocol}//${window.location.hostname}`,
      port: Number(window.location.port) || (window.location.protocol === 'https:' ? 443 : 80),
    }),
    lagConfigFromQuery(window.location.search),
  )
  ;(window as unknown as { lag: LagConfig }).lag = lagConfig
  const requestSnapshot = (): void => {
    channel.emit('game:resync', {}, { reliable: true })
  }
  const reliableMessenger = new ReliableMessenger<GameOrder, GameOrderAck>({
    channel,
    messageEvent: 'game:order',
    acknowledgementEvent: 'game:order-ack',
    timeoutMs: orderTimeoutMs,
    parseAcknowledgement: (data) => {
      const parsed = GameOrderAckSchema.safeParse(data)
      return parsed.success ? parsed.data : undefined
    },
    onAcknowledgement: (ack) => {
      if (gameState.applyOrderAck(ack)) requestSnapshot()
      if (ack.status === 'rejected') {
        const reasonMessages: Record<string, string> = {
          out_of_range: 'Target is out of attack range.',
          cooldown: 'Attack is not ready yet.',
          dead: 'Attacker or target is dead.',
          stale: 'Order was too old or out of sequence.',
          unknown_ability: 'Your champion does not have that ability.',
        }
        onStatus(reasonMessages[ack.reason ?? ''] ?? ack.reason ?? `Order ${ack.seq} was rejected.`, true)
      }
    },
    onTimeout: () => {
      requestSnapshot()
      onStatus('Order acknowledgement delayed; requesting a state sync.', true)
    },
  })

  scene.eventMode = 'static'
  scene.hitArea = new Rectangle(0, 0, GAME_ARENA_WIDTH, GAME_ARENA_HEIGHT)
  scene.on('pointermove', (event) => {
    const position = event.getLocalPosition(scene)
    pointer = { x: position.x, y: position.y }
  })
  scene.on('pointerdown', (event) => {
    const target = event.getLocalPosition(scene)
    if (gameState.isLocalDead()) return
    if (event.button === 0 && started && !disconnected) {
      const clickedEnemy = gameState.getEnemyNear({ x: target.x, y: target.y })
      if (clickedEnemy) {
        const order = gameState.createAttackOrder(clickedEnemy.id, sessionId)
        if (order) reliableMessenger.send(order)
        return
      }
    }
    if (event.button !== 2 || !started || disconnected) return
    const order = gameState.createMoveOrder({ x: target.x, y: target.y })
    if (order) reliableMessenger.send(order)
  })
  const onContextMenu = (event: MouseEvent): void => event.preventDefault()
  app.canvas.addEventListener('contextmenu', onContextMenu)
  const onKeyDown = (event: KeyboardEvent): void => {
    const abilitySlot = abilityKeys.indexOf(event.code)
    if (event.code !== 'Space' && abilitySlot < 0) return
    if (event.repeat || !started || disconnected || gameState.isLocalDead()) return
    if (
      event.target instanceof HTMLElement
      && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target.tagName))
    ) return
    event.preventDefault()
    if (abilitySlot >= 0) {
      const attempt = gameState.createCastOrder(abilitySlot, pointer, sessionId)
      if (attempt.ok) reliableMessenger.send(attempt.order)
      else onStatus(attempt.reason, true)
      return
    }
    const target = gameState.getClosestEnemyInRange()
    if (!target) return
    const order = gameState.createAttackOrder(target.id, sessionId)
    if (order) reliableMessenger.send(order)
  }
  window.addEventListener('keydown', onKeyDown)

  channel.onConnect((error) => {
    if (error) {
      onStatus(`Could not connect to the game server: ${error.message}`, true)
      return
    }
    connected = true
    onStatus('Connected. Joining the lobby game…')
    channel.emit('game:join', { lobbyCode, sessionId }, { reliable: true })
  })

  channel.on('game:joined', (data) => {
    const parsed = GameJoinedSchema.safeParse(data)
    if (!parsed.success) {
      onStatus('The server sent invalid game synchronization state.', true)
      return
    }
    gameState.setLocalEntityId(parsed.data.entityId)
    gameState.setNextOrderSequence(parsed.data.nextOrderSeq)
    gameState.setServerTick(parsed.data.serverTick)
    channel.emit('playerReady', {}, { reliable: true })
    channel.emit('game:ping', { clientTime: performance.now() })
    onStatus('You are ready. Waiting for every player…')
  })

  channel.on('game:ready-progress', (data) => {
    if (
      typeof data !== 'object'
      || data === null
      || !('readyCount' in data)
      || !('totalPlayers' in data)
      || typeof data.readyCount !== 'number'
      || typeof data.totalPlayers !== 'number'
    ) {
      return
    }
    onReadyProgress(data.readyCount, data.totalPlayers)
    onStatus(`Waiting for players: ${data.readyCount}/${data.totalPlayers} ready.`)
  })

  channel.on('game:started', (data) => {
    const parsed = GameSnapshotSchema.safeParse(data)
    if (!parsed.success) {
      onStatus('The server sent invalid game state.', true)
      return
    }
    if (started || pendingStart) return
    const snapshotResult = gameState.applySnapshot(parsed.data)
    for (const order of snapshotResult.confirmedOrders) {
      reliableMessenger.acknowledge(order.id, order.seq)
    }
    gameState.resetServerTickAnchor(parsed.data.tick)
    // Stay on the loading screen until a ping round trip has synchronized the
    // tick estimate, otherwise early orders are stamped outside the server's window.
    pendingStart = parsed.data
    onStatus('Synchronizing game clock…')
    const sendStartPing = (): void => {
      if (pendingStart && !disconnected) channel.emit('game:ping', { clientTime: performance.now() })
    }
    sendStartPing()
    startPingTimer = window.setInterval(sendStartPing, START_PING_RETRY_MS)
  })

  channel.on('game:snapshot', (data) => {
    const parsed = GameSnapshotSchema.safeParse(data)
    if (!parsed.success) {
      onStatus('The server sent invalid recovery state.', true)
      return
    }
    const snapshotResult = gameState.applySnapshot(parsed.data)
    for (const order of snapshotResult.confirmedOrders) {
      reliableMessenger.acknowledge(order.id, order.seq)
    }
    if (!snapshotResult.applied) return
    onStatus('Game state synchronized.')
  })

  reliableMessenger.listenFor('game:order', 'game:order-delivery-ack', (data) => {
    const parsed = GameBroadcastOrderSchema.safeParse(data)
    if (!parsed.success) {
      onStatus('The server sent an invalid order.', true)
      return false
    }
    return gameState.applyOrder(parsed.data)
  })

  channel.on('game:pong', (data) => {
    const parsed = GamePongSchema.safeParse(data)
    if (!parsed.success) {
      onStatus('The server sent an invalid ping response.', true)
      return
    }
    gameState.recordPong(parsed.data.clientTime, parsed.data.serverTick)
    if (pendingStart && gameState.getAverageRttMs() > 0) {
      const snapshot = pendingStart
      pendingStart = undefined
      window.clearInterval(startPingTimer)
      started = true
      onStarted(snapshot)
      onStatus('Game started. Right-click to move; click an enemy or press Space to attack; Q/W/E/R cast at the cursor.')
    }
  })

  channel.on('game:death', (data) => {
    const parsed = GameDeathSchema.safeParse(data)
    if (!parsed.success) {
      onStatus('The server sent an invalid death.', true)
      return
    }
    if (!gameState.applyDeath(parsed.data)) requestSnapshot()
  })

  channel.on('game:error', (data) => {
    if (typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string') {
      onStatus(data.message, true)
    }
  })

  channel.on('game:cancelled', (data) => {
    if (typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string') {
      onCancelled(data.message)
    }
  })

  channel.onDisconnect(() => {
    connected = false
    disconnected = true
    onStatus('Disconnected from game server.', true)
    onDisconnected()
  })

  const pingTimer = window.setInterval(() => {
    if (connected && !disconnected) {
      channel.emit('game:ping', { clientTime: performance.now() })
    }
  }, GAME_PING_INTERVAL_MS)

  let debugUpdateElapsedMs = 0
  let debugText = ''
  let fpsFrameCount = 0
  let fpsSampleStartedAt = performance.now()
  let displayedFps = app.ticker.FPS
  app.ticker.add(() => {
    if (!started || disconnected) return
    resizeScene()
    fpsFrameCount += 1
    const fpsSampleElapsedMs = performance.now() - fpsSampleStartedAt
    if (fpsSampleElapsedMs >= 1000) {
      displayedFps = fpsFrameCount * 1000 / fpsSampleElapsedMs
      fpsFrameCount = 0
      fpsSampleStartedAt = performance.now()
    }
    debugUpdateElapsedMs += app.ticker.deltaMS
    if (debugUpdateElapsedMs >= 250) {
      debugUpdateElapsedMs %= 250
      const debugInfo = gameState.getDebugInfo()
      const position = debugInfo.localPosition
      debugText = [
        `FPS: ${displayedFps.toFixed(1)}`,
        `RTT: ${debugInfo.lastRttMs === undefined ? '—' : `${debugInfo.lastRttMs.toFixed(1)} ms`} (avg ${debugInfo.averageRttMs.toFixed(1)} ms, n=${debugInfo.rttSampleCount})`,
        `Tick: ${debugInfo.estimatedTick.toFixed(1)} (server ${debugInfo.serverTick}, update ${debugInfo.tickAnchorAgeMs.toFixed(0)} ms ago)`,
        `Pending orders: ${debugInfo.pendingOrderCount}${debugInfo.oldestPendingOrderAgeMs === undefined ? '' : ` (oldest ${debugInfo.oldestPendingOrderAgeMs.toFixed(0)} ms)`}`,
        `Local position: ${position ? `${position.x.toFixed(1)}, ${position.y.toFixed(1)}` : 'unavailable'}`,
      ].join('\n')
    }
    const now = performance.now()
    // Cooldowns refresh every frame so they count down smoothly.
    debugOverlay.textContent = [
      debugText,
      ...gameState.getAbilityCooldowns(now).map(({ slot, abilityId, ticksRemaining }) =>
        `${abilityKeys[slot]?.slice(3) ?? slot + 1} ${abilityId}: ${ticksRemaining === 0 ? 'ready' : `${(ticksRemaining / GAME_TPS).toFixed(2)} s`}`),
    ].join('\n')
    renderState(now)
    for (let index = floatingDamage.length - 1; index >= 0; index -= 1) {
      const floating = floatingDamage[index]
      const elapsed = now - floating.startedAt
      if (elapsed >= 900) {
        scene.removeChild(floating.node)
        floating.node.destroy()
        floatingDamage.splice(index, 1)
        continue
      }
      floating.node.alpha = 1 - elapsed / 900
      floating.node.y -= app.ticker.deltaMS / 45
    }
  })

  return () => {
    disconnected = true
    window.clearInterval(pingTimer)
    window.clearInterval(startPingTimer)
    app.canvas.removeEventListener('contextmenu', onContextMenu)
    window.removeEventListener('keydown', onKeyDown)
    debugOverlay.remove()
    reliableMessenger.close()
    channel.close()
    app.destroy(true, { children: true })
    container.replaceChildren()
  }
}
