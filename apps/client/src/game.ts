import geckos from '@geckos.io/client'
import {
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_VIEW_HEIGHT,
  GAME_VIEW_WIDTH,
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
import { Application, Container, Graphics, Text } from 'pixi.js'
import { computeCamera, screenToWorld, type Camera } from './camera.ts'
import { CastControl, DEFAULT_CAST_MODE, type CastMode } from './cast-control.ts'
import { layoutHealthBar } from './health-bar.ts'
import {
  ClientGameState,
  type CastPreview,
  type RenderedCharacter,
  type RenderedEntity,
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
  // Quick cast, or quick cast with an indicator while the key is held (the default).
  castMode?: CastMode
}

type Actor = {
  node: Container
  statusRing: Graphics
  stackPips: Graphics
  label: Text
  healthBar: Graphics
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
// The health bar over each champion, in world units. A tick marks every HEALTH_TICK_EVERY health,
// and a bigger one every HEALTH_MAJOR_TICK_EVERY.
const HEALTH_BAR_WIDTH = 84
const HEALTH_BAR_HEIGHT = 9
const HEALTH_TICK_EVERY = 100
const HEALTH_MAJOR_TICK_EVERY = 1000
// A ground target whose ability gives no indicator size is marked with a small ring this big.
const CAST_INDICATOR_MARKER_RADIUS = 6
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
  castMode = DEFAULT_CAST_MODE,
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
  // The camera is locked on the champion being controlled, so the scene is moved so that champion
  // is always the middle of the screen. Until it exists the camera rests on the middle of the map.
  let cameraCenter = { x: GAME_ARENA_WIDTH / 2, y: GAME_ARENA_HEIGHT / 2 }
  let camera: Camera = computeCamera(app.screen, { width: GAME_VIEW_WIDTH, height: GAME_VIEW_HEIGHT }, cameraCenter)
  const updateCamera = (center: { x: number; y: number }): void => {
    cameraCenter = center
    camera = computeCamera(app.screen, { width: GAME_VIEW_WIDTH, height: GAME_VIEW_HEIGHT }, center)
    scene.scale.set(camera.scale)
    scene.position.set(camera.x, camera.y)
  }
  updateCamera(cameraCenter)

  // A grid on the floor, otherwise a plain floor gives no sense of moving across a big map.
  const floor = new Graphics().rect(0, 0, GAME_ARENA_WIDTH, GAME_ARENA_HEIGHT).fill({ color: '#18263a' })
  for (let x = 100; x < GAME_ARENA_WIDTH; x += 100) floor.moveTo(x, 0).lineTo(x, GAME_ARENA_HEIGHT)
  for (let y = 100; y < GAME_ARENA_HEIGHT; y += 100) floor.moveTo(0, y).lineTo(GAME_ARENA_WIDTH, y)
  floor.stroke({ color: '#1f3149', width: 1 })
  floor.rect(0, 0, GAME_ARENA_WIDTH, GAME_ARENA_HEIGHT).stroke({ color: '#314862', width: 4 })
  scene.addChild(floor)

  const gameState = new ClientGameState()
  const actors = new Map<number, Actor>()
  // A telegraph also keeps its inner disc, which swells to the full circle as the warning runs out.
  const entityActors = new Map<string, { node: Container; fill?: Graphics }>()
  const floatingDamage: FloatingDamage[] = []
  const displayedHealth = new Map<number, DisplayedHealth>()
  // The mouse is remembered on screen and turned into a world point when it is used, because the
  // camera moves under a still mouse as the champion walks.
  let pointerOnScreen = { x: app.screen.width / 2, y: app.screen.height / 2 }
  const pointerInWorld = () => screenToWorld(camera, pointerOnScreen)
  const attackRangeRing = new Graphics()
  attackRangeRing.alpha = 0.3
  attackRangeRing.visible = false
  scene.addChild(attackRangeRing)
  // The aimed ability's indicator, on the ground under the champions.
  const castControl = new CastControl(castMode)
  const castIndicator = new Graphics()
  scene.addChild(castIndicator)
  const addActor = (character: RenderedCharacter): Actor => {
    const isLocal = character.player?.playerId === sessionId
    const node = new Container()
    const shape = new Graphics()
      .circle(0, 0, character.champion.radius)
      .fill({
        color: isLocal ? '#79dfb1' : '#81b8ff',
      })
      .stroke({ color: '#e8f4ff', width: 3 })
    const label = new Text({
      text: character.player?.name ?? '',
      style: { fill: '#e8f4ff', fontSize: 16, fontFamily: 'Arial' },
    })
    label.anchor.set(0.5, 1)
    const healthBar = new Graphics()
    const cooldownBar = new Graphics()
    const statusRing = new Graphics()
    const stackPips = new Graphics()
    node.addChild(shape, statusRing, stackPips, label, healthBar, cooldownBar)
    scene.addChild(node)
    const actor = { node, statusRing, stackPips, label, healthBar, cooldownBar }
    actors.set(character.id, actor)
    return actor
  }

  // A ring around the body shows crowd control and speed effects. The most disabling one wins:
  // stun, then root, then slow, then haste.
  const drawStatusRing = (graphics: Graphics, radius: number, character: RenderedCharacter): void => {
    graphics.clear()
    if (character.dead) return
    const ring = character.stunned
      ? { color: '#ffffff', width: 3 }
      : character.rooted
        ? { color: '#c98f5a', width: 3 }
        : character.slowed
          ? { color: '#6db7f2', width: 2 }
          : character.hasted
            ? { color: '#e8f26d', width: 2 }
            : undefined
    if (!ring) return
    graphics.circle(0, 0, radius + 5).stroke({ ...ring, alpha: 0.9 })
  }

  // One pip per stack under the body, laid out in a single row: curse (purple) and gale (pale blue)
  // sit on enemies; sword (gold) and empowered (cyan) sit on their owner.
  const stackColors: Record<string, string> = {
    curse: '#b36df2',
    sword: '#f2c14e',
    empowered: '#7fd6ff',
    gale: '#bfe6ff',
  }
  const drawStackPips = (graphics: Graphics, radius: number, stacks: Record<string, number>): void => {
    graphics.clear()
    const pips = Object.entries(stackColors).flatMap(([key, color]) =>
      Array.from({ length: stacks[key] ?? 0 }, () => color))
    pips.forEach((color, index) => {
      graphics
        .circle((index - (pips.length - 1) / 2) * 9, radius + 10, 3.5)
        .fill({ color })
        .stroke({ color: '#1c1c28', width: 1 })
    })
  }

  const drawBar = (
    graphics: Graphics,
    y: number,
    fraction: number,
    fillColor: string,
    height = 4,
  ): void => {
    const width = HEALTH_BAR_WIDTH
    graphics.clear()
      .roundRect(-width / 2, y, width, height, 2)
      .fill({ color: '#101827' })
      .roundRect(-width / 2, y, width * Math.max(0, Math.min(1, fraction)), height, 2)
      .fill({ color: fillColor })
  }

  // Health from the left, the shield on the end of it, and ticks across the bar to read it by.
  const drawHealthBar = (
    graphics: Graphics,
    y: number,
    health: { hp: number; maxHp: number; shield: number },
  ): void => {
    const layout = layoutHealthBar(health, HEALTH_BAR_WIDTH, {
      every: HEALTH_TICK_EVERY,
      major: HEALTH_MAJOR_TICK_EVERY,
    })
    const left = -HEALTH_BAR_WIDTH / 2
    graphics.clear()
      .rect(left, y, HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT)
      .fill({ color: '#0b1220' })
      .rect(left, y, layout.healthWidth, HEALTH_BAR_HEIGHT)
      .fill({ color: '#67d391' })
      .rect(left + layout.healthWidth, y, layout.shieldWidth, HEALTH_BAR_HEIGHT)
      .fill({ color: '#e8f4ff' })
    // A small tick reaches half way up from the bottom; a major one runs the full height.
    for (const tick of layout.ticks) {
      if (!tick.major) graphics.moveTo(left + tick.x, y + HEALTH_BAR_HEIGHT / 2).lineTo(left + tick.x, y + HEALTH_BAR_HEIGHT)
    }
    graphics.stroke({ color: '#0b1220', width: 1, alpha: 0.85 })
    for (const tick of layout.ticks) {
      if (tick.major) graphics.moveTo(left + tick.x, y).lineTo(left + tick.x, y + HEALTH_BAR_HEIGHT)
    }
    graphics
      .stroke({ color: '#0b1220', width: 2 })
      .rect(left, y, HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT)
      .stroke({ color: '#0b1220', width: 1.5 })
  }

  // The range around the champion, and where the ability would go if the key were let go now.
  const drawCastIndicator = (
    preview: CastPreview | undefined,
    from: { x: number; y: number } | undefined,
    characters: RenderedCharacter[],
  ): void => {
    castIndicator.clear()
    if (!preview || !from) return
    const color = '#f2e8a0'
    // A skillshot flies a straight line that its own band already shows, so only abilities aimed at
    // a point or a unit get the ring that marks how far they reach.
    if (preview.range > 0 && preview.targeting !== 'direction') {
      castIndicator.circle(from.x, from.y, preview.range).stroke({ color, width: 2, alpha: 0.45 })
    }
    const target = preview.target
    if (target?.mode === 'direction') {
      const end = { x: from.x + target.dir.x * preview.range, y: from.y + target.dir.y * preview.range }
      // The band is as wide as what the ability fires; the line down its middle is the aim.
      const width = preview.indicator?.width
      if (width) castIndicator.moveTo(from.x, from.y).lineTo(end.x, end.y).stroke({ color, width, alpha: 0.18 })
      castIndicator.moveTo(from.x, from.y).lineTo(end.x, end.y).stroke({ color, width: 2, alpha: 0.7 })
    } else if (target?.mode === 'point') {
      const radius = preview.indicator?.radius
      castIndicator
        .circle(target.point.x, target.point.y, radius ?? CAST_INDICATOR_MARKER_RADIUS)
        .fill({ color, alpha: radius ? 0.18 : 0 })
        .stroke({ color, width: 2, alpha: 0.8 })
    } else if (target?.mode === 'unit') {
      const unit = characters.find((character) => character.id === target.unitId)
      // Red when the enemy is past the ability's reach, so the ring tells whether it will cast.
      if (unit) {
        castIndicator
          .circle(unit.position.x, unit.position.y, unit.champion.radius + 7)
          .stroke({ color: preview.outOfRange ? '#ff6b6b' : color, width: 3, alpha: 0.9 })
      }
    }
  }

  const renderState = (now = performance.now()): { x: number; y: number } | undefined => {
    const characters = gameState.getCharacters(now)
    const activeIds = new Set(characters.map((character) => character.id))
    for (const character of characters) {
      const health = {
        total: (character.health?.hp ?? 0) + character.totalShield,
        hpSeq: character.health?.hpSeq ?? 0,
      }
      const previousHealth = displayedHealth.get(character.id)
      // Only damage advances hpSeq, so an expiring shield is not shown as damage.
      if (
        previousHealth !== undefined
        && health.hpSeq > previousHealth.hpSeq
        && health.total < previousHealth.total
      ) {
        showFloatingDamage(character.id, previousHealth.total - health.total)
      }
      displayedHealth.set(character.id, health)
    }
    for (const [id, actor] of actors) {
      if (!activeIds.has(id)) {
        scene.removeChild(actor.node)
        actor.node.destroy({ children: true })
        actors.delete(id)
        displayedHealth.delete(id)
      }
    }
    for (const character of characters) {
      const actor = actors.get(character.id) ?? addActor(character)
      actor.label.text = character.player?.name ?? ''
      const radius = character.champion.radius
      actor.node.position.set(character.position.x, character.position.y)
      // A confirmed death leaves a faint ghost with no bars until the respawn.
      actor.node.alpha = character.dead ? 0.25 : 1
      actor.healthBar.visible = !character.dead
      actor.label.position.set(0, -radius - 25)
      drawHealthBar(actor.healthBar, -radius - 20, {
        hp: character.health?.hp ?? 0,
        maxHp: character.health?.maxHp ?? 0,
        shield: character.totalShield,
      })
      drawStatusRing(actor.statusRing, radius, character)
      drawStackPips(actor.stackPips, radius, character.dead ? {} : character.stacks)
      const isLocal = character.id === gameState.getLocalCharacterId()
      actor.cooldownBar.visible = isLocal && !character.dead
      if (isLocal && character.dead) {
        attackRangeRing.visible = false
      } else if (isLocal) {
        drawBar(actor.cooldownBar, -radius - 8, gameState.getAttackCooldownProgress(now), '#f2b66d', 3)
        attackRangeRing.clear()
          .circle(0, 0, gameState.getLocalAttackRange() ?? 0)
          .stroke({ color: '#79dfb1', width: 2 })
        attackRangeRing.position.set(character.position.x, character.position.y)
        attackRangeRing.visible = true
      }
    }
    if (!characters.some((character) => character.id === gameState.getLocalCharacterId())) {
      attackRangeRing.visible = false
    }

    const entities = gameState.getEntities(now)
    const activeEntityIds = new Set(entities.map((entity) => entity.id))
    for (const [id, actor] of entityActors) {
      if (!activeEntityIds.has(id)) {
        scene.removeChild(actor.node)
        actor.node.destroy({ children: true })
        entityActors.delete(id)
      }
    }
    for (const entity of entities) {
      const actor = entityActors.get(entity.id) ?? addEntityActor(entity)
      actor.node.position.set(entity.position.x, entity.position.y)
      actor.fill?.scale.set(entity.progress)
    }
    const localPosition = characters.find((character) => character.id === gameState.getLocalCharacterId())?.position
    if (gameState.isLocalDead(now)) castControl.cancel()
    const aimed = castControl.aiming
    drawCastIndicator(
      aimed === undefined ? undefined : gameState.getCastPreview(aimed, pointerInWorld(), now),
      localPosition,
      characters,
    )
    return localPosition
  }

  const addEntityActor = (entity: RenderedEntity): { node: Container; fill?: Graphics } => {
    const actor = new Container()
    let fill: Graphics | undefined
    if (entity.visual === 'telegraph' && !entity.box) {
      // An outline of where it will land, with a disc growing inside it until it goes off.
      const color = entity.color ?? '#ff6b4a'
      fill = new Graphics().circle(0, 0, entity.radius).fill({ color, alpha: 0.35 })
      fill.scale.set(entity.progress)
      actor.addChild(
        new Graphics()
          .circle(0, 0, entity.radius)
          .fill({ color, alpha: 0.1 })
          .stroke({ color, width: 2, alpha: 0.9 }),
        fill,
      )
      // Under the champions, so it never hides who is standing in it.
      scene.addChildAt(actor, 1)
    } else if (entity.box) {
      // A rectangle is drawn pointing the way it was aimed. A field is faint and sits under the
      // champions; anything else is solid and travels over them.
      const { halfLength, halfWidth } = entity.box
      const isField = entity.visual === 'field'
      const color = entity.color ?? (isField ? '#9b6df2' : '#f2b66d')
      actor.addChild(
        new Graphics()
          .rect(-halfLength, -halfWidth, halfLength * 2, halfWidth * 2)
          .fill({ color, alpha: isField ? 0.16 : 0.7 })
          .stroke({ color, width: 2, alpha: isField ? 0.6 : 1 }),
      )
      actor.rotation = Math.atan2(entity.facing?.y ?? 0, entity.facing?.x ?? 1)
      if (isField) scene.addChildAt(actor, 1)
      else scene.addChild(actor)
    } else if (entity.visual === 'field') {
      actor.addChild(
        new Graphics()
          .circle(0, 0, entity.radius)
          .fill({ color: entity.color ?? '#9b6df2', alpha: 0.16 })
          .stroke({ color: entity.color ?? '#9b6df2', width: 2, alpha: 0.6 }),
      )
      // Under the champions, just above the arena floor.
      scene.addChildAt(actor, 1)
    } else {
      actor.addChild(new Graphics().circle(0, 0, entity.radius).fill({ color: entity.color ?? '#f2b66d' }))
      scene.addChild(actor)
    }
    const entry = { node: actor, ...(fill ? { fill } : {}) }
    entityActors.set(entity.id, entry)
    return entry
  }

  const showFloatingDamage = (targetId: number, dealt: number): void => {
    if (dealt <= 0) return
    const character = gameState.getCharacters().find((candidate) => candidate.id === targetId)
    if (!character) return
    const node = new Text({
      text: `-${dealt}`,
      style: { fill: '#ffd27a', fontSize: 16, fontFamily: 'Arial', fontWeight: 'bold' },
    })
    node.anchor.set(0.5)
    node.position.set(character.position.x, character.position.y - character.champion.radius - 24)
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

  // Listen on the whole screen, not the map, so clicks and aiming work over the void past its edge.
  app.stage.eventMode = 'static'
  app.stage.hitArea = app.screen
  app.stage.on('pointermove', (event) => {
    pointerOnScreen = { x: event.global.x, y: event.global.y }
  })
  app.stage.on('pointerdown', (event) => {
    const target = screenToWorld(camera, event.global)
    if (gameState.isLocalDead()) return
    if (event.button === 0 && started && !disconnected) {
      const clickedEnemy = gameState.getEnemyNear({ x: target.x, y: target.y })
      if (clickedEnemy) {
        // Giving an attack or move command drops any ability being aimed.
        castControl.cancel()
        const order = gameState.createAttackOrder(clickedEnemy.id, sessionId)
        if (order) reliableMessenger.send(order)
        return
      }
    }
    if (event.button !== 2 || !started || disconnected) return
    castControl.cancel()
    const order = gameState.createMoveOrder({ x: target.x, y: target.y })
    if (order) reliableMessenger.send(order)
  })
  const onContextMenu = (event: MouseEvent): void => event.preventDefault()
  app.canvas.addEventListener('contextmenu', onContextMenu)
  const castAtCursor = (slot: number): void => {
    const attempt = gameState.createCastOrder(slot, pointerInWorld(), sessionId)
    if (attempt.ok) reliableMessenger.send(attempt.order)
    else onStatus(attempt.reason, true)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape') {
      castControl.cancel()
      return
    }
    const abilitySlot = abilityKeys.indexOf(event.code)
    if (event.code !== 'Space' && abilitySlot < 0) return
    if (event.repeat || !started || disconnected || gameState.isLocalDead()) return
    if (
      event.target instanceof HTMLElement
      && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target.tagName))
    ) return
    event.preventDefault()
    if (abilitySlot >= 0) {
      const action = castControl.press(abilitySlot, gameState.abilityNeedsAim(abilitySlot))
      if (action.type === 'cast') {
        castAtCursor(abilitySlot)
      } else if (action.type === 'aim') {
        // An ability that could not be cast anyway says so now instead of showing its indicator.
        const blocker = gameState.getCastBlocker(abilitySlot)
        if (blocker) {
          castControl.cancel()
          onStatus(blocker, true)
        }
      }
      return
    }
    const target = gameState.getClosestEnemyInRange()
    if (!target) return
    castControl.cancel()
    const order = gameState.createAttackOrder(target.id, sessionId)
    if (order) reliableMessenger.send(order)
  }
  const onKeyUp = (event: KeyboardEvent): void => {
    const abilitySlot = abilityKeys.indexOf(event.code)
    if (abilitySlot < 0) return
    if (castControl.release(abilitySlot).type !== 'cast') return
    if (!started || disconnected || gameState.isLocalDead()) return
    castAtCursor(abilitySlot)
  }
  // A key let go while the window is not focused never reports its release.
  const onBlur = (): void => castControl.cancel()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

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
    gameState.setLocalCharacterId(parsed.data.characterId)
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
      onStatus(castControl.mode === 'quick'
        ? 'Game started. Right-click to move; click an enemy or press Space to attack; Q/W/E/R cast at the cursor.'
        : 'Game started. Right-click to move; click an enemy or press Space to attack; hold Q/W/E/R to aim and let go to cast.')
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
    // The camera follows the position the champion was just drawn at, so the two never drift apart.
    updateCamera(renderState(now) ?? cameraCenter)
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
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    debugOverlay.remove()
    reliableMessenger.close()
    channel.close()
    app.destroy(true, { children: true })
    container.replaceChildren()
  }
}
