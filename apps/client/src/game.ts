import geckos from '@geckos.io/client'
import {
  GAME_ARENA_HEIGHT,
  GAME_ARENA_WIDTH,
  GAME_VIEW_HEIGHT,
  GAME_VIEW_WIDTH,
  GAME_FPS,
  GAME_ORDER_TIMEOUT_MS,
  GAME_PING_INTERVAL_MS,
  GameBroadcastOrderSchema,
  GameJoinedSchema,
  GameOrderAckSchema,
  GamePongSchema,
  GameResultSchema,
  GameSnapshotSchema,
  ReliableMessenger,
  lagConfigFromQuery,
  withLag,
  type GameOrder,
  type GameOrderAck,
  type GameSnapshot,
  type LagConfig,
} from '../../../packages/shared/src/index.ts'
import { chooseAttackMarkers } from './render/attack-marker.ts'
import { computeCamera, screenToWorld, type Camera } from './camera.ts'
import { CastControl, type CastMode } from './cast-control.ts'
import { loadSpriteSets, type LoadedSpriteSet } from './character-sprite.ts'
import { championSprites } from './champion-sprites.ts'
import { createDebugOverlay } from './ui/debug-overlay.ts'
import { createGameMenu, menuItems } from './game-menu.ts'
import { HoldCommand, type HeldCommand } from './hold-command.ts'
import { loadSettings, saveSettings } from './game-settings.ts'
import { ClientGameState } from './game-state.ts'
import { createTeamVision, type TeamVision } from './team-vision.ts'
import { abilitySlotViews } from './ui/hud.ts'
import { createHudView } from './ui/hud-view.ts'
import { createItemTooltip } from './ui/item-tooltip.ts'
import { createModeHudView } from './ui/mode-hud-view.ts'
import { createResultsView } from './ui/results-view.ts'
import { createGameMap } from './render/game-map.ts'
import { createPixiApp } from './render/pixi-app.ts'
import { WorldRenderer } from './render/world-renderer.ts'
import { createScoreboardView } from './ui/scoreboard-view.ts'
import { createShopView } from './ui/shop-view.ts'
import { decodeSnapshot } from './snapshot-codec.ts'
import { spriteFileKey, spriteOverridesFrom } from './sprite-overrides.ts'

type GameOptions = {
  container: HTMLElement
  lobbyCode: string
  sessionId: string
  // The map the game is on: its id, which the page loads, and its size, for the floor it is drawn on if the page
  // cannot load it (0 if not known).
  map: { id: string; width: number; height: number }
  onStatus: (text: string, isError?: boolean) => void
  onReadyProgress: (readyCount: number, totalPlayers: number) => void
  onStarted: (snapshot: GameSnapshot) => void
  onCancelled: (message: string) => void
  onDisconnected: () => void
  // The player is going back to the lobby: they chose to, from the escape menu or the results (and the game
  // goes on without them if it is not over), or the leader ended the game. The message, if any, is what the
  // lobby says about why.
  onLeave: (message?: string) => void
  orderTimeoutMs?: number
  // Quick cast, or quick cast with an indicator while the key is held. By default, what the player
  // last chose in the escape menu, which is kept in the browser.
  castMode?: CastMode
}

const abilityKeys = ['KeyQ', 'KeyW', 'KeyE', 'KeyR']
const START_PING_RETRY_MS = 250

// What the server says when it turns an order down, for the reasons it gives one. Any other reason is
// shown as it is.
const ORDER_REJECTION_MESSAGES: Readonly<Record<string, string>> = {
  dead: 'Attacker or target is dead.',
  stale: 'Order was too old or out of sequence.',
  unknown_ability: 'Your champion does not have that ability.',
  unknown_item: 'That item is not in the game.',
}

// Whether a key was pressed in a field the player is typing in (or on a button, if that counts too),
// where the game must leave it alone.
function isTypingIn(target: EventTarget | null, includeButtons = false): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable
    || ['INPUT', 'TEXTAREA', 'SELECT', ...(includeButtons ? ['BUTTON'] : [])].includes(target.tagName)
}

// Runs one game: the connection to the server, the player's input, and each frame, handing what the
// simulation says to the world renderer (render/) and to the HUD, scoreboard and diagnostics over it.
export async function startGame({
  container,
  lobbyCode,
  sessionId,
  map: mapInfo,
  onStatus,
  onReadyProgress,
  onStarted,
  onCancelled,
  onDisconnected,
  onLeave,
  orderTimeoutMs = GAME_ORDER_TIMEOUT_MS,
  castMode,
}: GameOptions): Promise<() => void> {
  if (!Number.isFinite(orderTimeoutMs) || orderTimeoutMs <= 0) {
    throw new RangeError('Order timeout must be a finite, positive number.')
  }
  const app = await createPixiApp(container, { maxFPS: GAME_FPS })
  // The sprite sheets, before anything is drawn. If they cannot be loaded, champions are circles.
  const spriteSets: Map<string, LoadedSpriteSet> = await loadSpriteSets(championSprites).catch((error: unknown) => {
    console.warn('Could not load the champion sprites, so champions are drawn as circles.', error)
    return new Map<string, LoadedSpriteSet>()
  })

  const debugOverlay = createDebugOverlay(container)
  // The shop and the item slots, which share one box that says what an item is. A purchase is an order like any other: it is checked against what
  // the champion has now (so the shop can say why not), sent to the server, and done on its tick by every peer alike.
  const itemTooltip = createItemTooltip(container)
  const shop = createShopView(container, itemTooltip, {
    onBuy: (itemId) => {
      if (!inPlay()) return 'The game is not running.'
      const attempt = gameState.createBuyOrder(itemId)
      if (!attempt.ok) return attempt.reason
      reliableMessenger.send(attempt.order)
      return undefined
    },
  })
  const hud = createHudView(container, {
    tooltip: itemTooltip,
    onShop: (filter) => {
      if (gameState.hasEconomy) shop.toggle(filter)
    },
    onSell: (slot) => {
      if (!inPlay()) return
      const attempt = gameState.createSellOrder(slot)
      if (attempt.ok) reliableMessenger.send(attempt.order)
      else onStatus(attempt.reason, true)
    },
  })
  const modeHud = createModeHudView(container)
  const scoreboard = createScoreboardView(container)
  // Shown when the server says the game is over, with the way back to the lobby.
  const results = createResultsView(container, { onReturn: () => onLeave() })

  // The world, in layers over the map. Everything in it is drawn from what the simulation says on
  // each frame (see `drawFrame` below).
  const arenaSize = {
    width: mapInfo.width > 0 ? mapInfo.width : GAME_ARENA_WIDTH,
    height: mapInfo.height > 0 ? mapInfo.height : GAME_ARENA_HEIGHT,
  }
  const { map, terrain: pageTerrain } = await createGameMap(mapInfo.id, arenaSize)
  const world = new WorldRenderer({ map, spriteSets })
  app.stage.addChild(world.scene)
  // The camera is locked on the champion being controlled, so the world is moved so that champion
  // is always the middle of the screen. Until it exists the camera rests on the middle of the map.
  let cameraCenter = { x: (pageTerrain?.width ?? arenaSize.width) / 2, y: (pageTerrain?.height ?? arenaSize.height) / 2 }
  let camera: Camera = computeCamera(app.screen, { width: GAME_VIEW_WIDTH, height: GAME_VIEW_HEIGHT }, cameraCenter)
  const updateCamera = (center: { x: number; y: number }): void => {
    cameraCenter = center
    camera = computeCamera(app.screen, { width: GAME_VIEW_WIDTH, height: GAME_VIEW_HEIGHT }, center)
    world.setCamera(camera)
  }
  updateCamera(cameraCenter)

  const gameState = new ClientGameState()
  // What the team sees: the vision system is made on the first frame, when the game's ground has come, and the address
  // can ask for another (`?vision=range`, or `?vision=off`). Until then, and for what is picked, everything is seen.
  let teamVision: TeamVision | undefined
  const visionOf = (): TeamVision => {
    if (!teamVision) {
      teamVision = createTeamVision(gameState.getTerrain(), window.location.search)
      const vision = teamVision
      gameState.setSight((character) => vision.isVisible(character))
      console.info(`Vision: ${vision.name}.`)
    }
    return teamVision
  }
  // The mouse is remembered on screen and turned into a world point when it is used, because the
  // camera moves under a still mouse as the champion walks.
  let pointerOnScreen = { x: app.screen.width / 2, y: app.screen.height / 2 }
  const pointerInWorld = () => screenToWorld(camera, pointerOnScreen)
  const settings = loadSettings()
  const castControl = new CastControl(castMode ?? settings.castMode)
  // Dev tool: redraw every champion from `overrides` (sheets picked from a folder, see
  // `spriteOverridesFrom`) over the art the game came with, or from that art alone with none.
  const applySprites = async (overrides?: ReadonlyMap<string, Blob>): Promise<void> => {
    world.setSpriteSets(await loadSpriteSets(championSprites, overrides))
  }
  const pickSpriteFolder = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.setAttribute('webkitdirectory', '')
    input.addEventListener('change', () => {
      const overrides = spriteOverridesFrom(Array.from(input.files ?? []))
      const wanted = new Set(Object.values(championSprites).flatMap((set) =>
        Object.values(set.clips).map((clip) => spriteFileKey(clip.url))))
      const used = [...overrides.keys()].filter((key) => wanted.has(key))
      if (used.length === 0) {
        window.alert('No sheets in that folder match the game\'s. Pick a folder laid out like res/ (Champion_X/Idle.png, …).')
        return
      }
      applySprites(overrides)
        .then(() => console.info(`Loaded ${used.length} sprite sheets from the folder; the rest are the game's own.`))
        .catch((error: unknown) => console.warn('Could not load the sprites from that folder.', error))
    })
    input.click()
  }
  // The escape menu. Its items are data (`menuItems`), so what it offers grows by adding to that list.
  const menu = createGameMenu({
    container,
    items: () => menuItems({
      ...(import.meta.env.DEV
        ? {
          sprites: {
            pickFolder: pickSpriteFolder,
            reset: () => {
              applySprites().catch((error: unknown) => console.warn('Could not reload the champion sprites.', error))
            },
          },
        }
        : {}),
      getCastMode: () => castControl.mode,
      setCastMode: (mode) => {
        castControl.setMode(mode)
        settings.castMode = mode
        saveSettings(settings)
      },
      leaveGame: () => {
        menu.close()
        onLeave()
      },
    }),
  })

  let started = false
  let pendingStart: GameSnapshot | undefined
  let startPingTimer: number | undefined
  let disconnected = false
  let connected = false
  // The server has said the game is over: it takes no more orders, and the results are showing.
  let ended = false
  const inPlay = (): boolean => started && !disconnected && !ended
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
        onStatus(ORDER_REJECTION_MESSAGES[ack.reason ?? ''] ?? ack.reason ?? `Order ${ack.seq} was rejected.`, true)
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
  // Gives an attack or a walk as the champion's next order.
  const sendCommand = (command: HeldCommand, now = performance.now()): void => {
    const order = command.type === 'attack'
      ? gameState.createAttackOrder(command.targetId, now)
      : gameState.createMoveOrder(command.target, now)
    if (order) reliableMessenger.send(order)
  }
  // Holding the right button goes on giving the command, a few times a second (see `HoldCommand`).
  const holdCommand = new HoldCommand()
  // Right click is the command button: on an enemy it attacks them, anywhere else it walks there.
  app.stage.on('pointerdown', (event) => {
    if (menu.isOpen) return
    const target = screenToWorld(camera, event.global)
    if (gameState.isLocalDead()) return
    if (event.button !== 2 || !inPlay()) return
    // Giving an attack or move command drops any ability being aimed.
    castControl.cancel()
    const clickedEnemy = gameState.getEnemyNear(target)
    const given: HeldCommand = clickedEnemy ? { type: 'attack', targetId: clickedEnemy.id } : { type: 'move', target }
    const now = performance.now()
    sendCommand(given, now)
    holdCommand.press(now, given)
  })
  // The command is given again while the button is down, wherever the mouse and the champion have got to, unless the game
  // has something else to do with them: a menu, an ability being aimed, a champion that is dead.
  const giveHeldCommand = (now: number): void => {
    if (!holdCommand.held || !inPlay() || menu.isOpen || castControl.aiming !== undefined || gameState.isLocalDead()) return
    const command = holdCommand.next(now, () => {
      const cursor = pointerInWorld()
      const enemy = gameState.getEnemyNear(cursor, now)
      const motion = gameState.getLocalMotion(now)
      return {
        cursor,
        ...(enemy ? { enemyId: enemy.id } : {}),
        attackingId: gameState.getLocalAttackTarget(now),
        position: motion?.position ?? cursor,
        moving: motion?.moving ?? false,
      }
    })
    if (command) sendCommand(command, now)
  }
  const onContextMenu = (event: MouseEvent): void => event.preventDefault()
  app.canvas.addEventListener('contextmenu', onContextMenu)
  const castAtCursor = (slot: number): void => {
    const attempt = gameState.createCastOrder(slot, pointerInWorld())
    if (attempt.ok) reliableMessenger.send(attempt.order)
    else onStatus(attempt.reason, true)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape') {
      // Escape puts the shop away first if it is open, then drops an aim, as it always has, and opens the menu when there is
      // none (and closes it when it is open).
      if (shop.isOpen) {
        shop.close()
        return
      }
      if (castControl.aiming !== undefined) {
        castControl.cancel()
        return
      }
      if (inPlay()) menu.toggle()
      return
    }
    // The menu has the keyboard while it is open: nothing reaches the game.
    if (menu.isOpen) return
    // P turns the debug view on and off: every hitbox, and whatever the map shows for debugging.
    if (event.code === 'KeyP' && !event.repeat && !isTypingIn(event.target)) {
      world.debug = !world.debug
      return
    }
    const abilitySlot = abilityKeys.indexOf(event.code)
    if (event.code !== 'Space' && abilitySlot < 0) return
    if (event.repeat || !inPlay() || gameState.isLocalDead()) return
    if (isTypingIn(event.target, true)) return
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
    // The enemy nearest the mouse, not the one nearest the champion.
    const target = gameState.getClosestEnemy(pointerInWorld())
    if (!target) return
    castControl.cancel()
    const order = gameState.createAttackOrder(target.id)
    if (order) reliableMessenger.send(order)
  }
  const onKeyUp = (event: KeyboardEvent): void => {
    const abilitySlot = abilityKeys.indexOf(event.code)
    if (abilitySlot < 0) return
    if (castControl.release(abilitySlot).type !== 'cast') return
    if (!inPlay() || gameState.isLocalDead()) return
    castAtCursor(abilitySlot)
  }
  // A key let go while the window is not focused never reports its release.
  const onBlur = (): void => {
    castControl.cancel()
    holdCommand.release()
  }
  // The button can be let go anywhere, so this listens on the window and not the map.
  const onPointerUp = (event: PointerEvent): void => {
    if (event.button === 2) holdCommand.release()
  }
  const onPointerCancel = (): void => holdCommand.release()
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
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
    // The game is played on the server's ground. If this page drew another version of the map, what
    // is drawn does not match where walls are and champions stand.
    if (parsed.data.map !== undefined && parsed.data.map !== mapInfo.id) {
      console.warn(`The server is playing on the map "${parsed.data.map}", and this page drew "${mapInfo.id}". Reload the page.`)
    }
    if (pageTerrain && parsed.data.terrain && !pageTerrain.sameAs(parsed.data.terrain)) {
      console.warn(
        'The server is playing on a different version of the map than this page drew. Reload the page. '
        + `The page's map is ${pageTerrain.width} by ${pageTerrain.height} with ${pageTerrain.walls.length} walls, `
        + `and the server's is ${parsed.data.terrain.width} by ${parsed.data.terrain.height} with ${parsed.data.terrain.walls.length}.`,
      )
    }
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

  // The only raw messages the server sends are gzipped snapshots. They are unzipped one at a time, so
  // two that arrive together are still applied in the order they came.
  let snapshotQueue: Promise<void> = Promise.resolve()
  channel.onRaw((data) => {
    snapshotQueue = snapshotQueue.then(async () => {
      let decoded: unknown
      try {
        decoded = await decodeSnapshot(data as ArrayBuffer)
      } catch {
        if (!disconnected) onStatus('The server sent invalid recovery state.', true)
        return
      }
      if (disconnected) return
      const parsed = GameSnapshotSchema.safeParse(decoded)
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
        ? 'Game started. Right-click to move, or right-click an enemy to attack; Space attacks the enemy nearest the cursor; Q/W/E/R cast at the cursor.'
        : 'Game started. Right-click to move, or right-click an enemy to attack; Space attacks the enemy nearest the cursor; hold Q/W/E/R to aim and let go to cast.')
    }
  })

  channel.on('game:error', (data) => {
    if (typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string') {
      onStatus(data.message, true)
    }
  })

  // The game is over, because a team reached the score limit or the leader ended it: stop playing, and show how it
  // went (or, if the leader ended it, leave). The server sends this more than once to be sure it arrives, so only
  // the first counts.
  channel.on('game:ended', (data) => {
    const parsed = GameResultSchema.safeParse(data)
    if (!parsed.success) {
      onStatus('The server sent an invalid game result.', true)
      return
    }
    if (!started || ended) return
    ended = true
    castControl.cancel()
    menu.close()
    shop.close()
    // The leader ended it to get everyone back in the lobby, so there are no results to look at: go straight
    // there. (The server has already shut the game down, and what it was is on the lobby.)
    if (parsed.data.reason === 'ended') {
      onLeave('The leader ended the game.')
      return
    }
    results.show(parsed.data, gameState.getLocalTeam())
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

  // One frame: what the simulation says now, drawn by the world renderer; the camera, which follows
  // where the champion was drawn so the two never drift apart; and the HUD and scoreboard over them.
  const drawFrame = (now: number): void => {
    const characters = gameState.getCharacters(now)
    const localCharacterId = gameState.getLocalCharacterId()
    const local = characters.find((character) => character.id === localCharacterId)
    const dead = local?.dead ?? false
    // What the team sees, before anything is picked or drawn: the debug view (P) shows everything.
    const sight = visionOf()
    sight.update(characters, gameState.getLocalTeam(), { reveal: world.debug })
    if (dead) castControl.cancel()
    const aimed = castControl.aiming
    // Only an enemy a right click would attack is marked as hovered: not while an ability is being
    // aimed (a right click then drops the aim), nor when dead.
    const hovered = aimed === undefined && !dead
      ? gameState.getEnemyNear(pointerInWorld(), now, characters)
      : undefined
    // The hill or the flags, and each team's score: drawn on the map and in the HUD from the same view.
    const mode = gameState.getModeView(now)
    world.update({
      now,
      // What is not seen is not drawn, nor are its names and bars: the darkness is over everything else.
      characters: sight.visibleCharacters(characters),
      unseen: sight.hiddenCharacters(characters),
      entities: sight.visibleEntities(gameState.getEntities(now)),
      ...(sight.mask ? { fog: sight.mask } : {}),
      mode,
      localCharacterId,
      ...(local ? { localAttackCooldown: gameState.getAttackCooldownProgress(now) } : {}),
      ...(world.debug ? { debugPath: gameState.getLocalPath(now) } : {}),
      ...(aimed === undefined ? {} : { castPreview: gameState.getCastPreview(aimed, pointerInWorld(), now, characters) }),
      attackMarkers: chooseAttackMarkers({
        hoveredId: hovered?.id,
        lockedId: gameState.getLocalAttackTarget(now),
      }),
    })
    app.canvas.style.cursor = hovered ? 'crosshair' : ''
    updateCamera(local?.position ?? cameraCenter)
    // The cooldowns refresh every frame so they fill smoothly.
    const progress = gameState.getLocalProgress(now)
    const stats = gameState.getLocalStats(now)
    const loadout = gameState.getLocalLoadout(now)
    if (loadout) shop.update(loadout, now)
    // Without an economy there is no level, no stats panel and no items or shop: the HUD is the abilities and the health.
    if (!gameState.hasEconomy) shop.close()
    hud.update({
      economy: gameState.hasEconomy,
      ...(loadout ? { inventory: loadout.items, inShop: loadout.inShop } : {}),
      dead,
      ...(local
        ? { health: { hp: local.health?.hp ?? 0, maxHp: local.health?.maxHp ?? 0, shield: local.totalShield } }
        : {}),
      ...(progress ? { progress } : {}),
      // The champion's stats at its level; what items add to them will go here.
      ...(stats ? { stats } : {}),
      ...(dead ? { respawnSeconds: gameState.getRespawnSecondsLeft(now), out: gameState.isLocalOutOfTheGame(now) } : {}),
      abilities: abilitySlotViews(
        gameState.getAbilityCooldowns(now),
        (slot) => abilityKeys[slot]?.slice(3) ?? String(slot + 1),
      ),
    })
    modeHud.update(mode, local ? { id: local.id, team: local.team } : undefined)
    scoreboard.update(gameState.getLeaderboard(), gameState.getKillFeed(now))
  }

  app.ticker.add(() => {
    if (!started || disconnected) return
    const now = performance.now()
    debugOverlay.frame(now, () => gameState.getDebugInfo())
    giveHeldCommand(now)
    drawFrame(now)
  })

  return () => {
    disconnected = true
    window.clearInterval(pingTimer)
    window.clearInterval(startPingTimer)
    app.canvas.removeEventListener('contextmenu', onContextMenu)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerCancel)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    debugOverlay.destroy()
    shop.destroy()
    itemTooltip.destroy()
    hud.destroy()
    modeHud.destroy()
    scoreboard.destroy()
    results.destroy()
    menu.destroy()
    reliableMessenger.close()
    channel.close()
    app.destroy(true, { children: true })
    container.replaceChildren()
  }
}
