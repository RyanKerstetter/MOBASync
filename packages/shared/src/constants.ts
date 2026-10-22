// The whole map, three times the width and height of the original single-screen arena.
export const GAME_ARENA_WIDTH = 2400
export const GAME_ARENA_HEIGHT = 1350
// How much of the world the camera shows at least, centred on the controlled champion. A screen
// with another shape shows more of the world on its long side rather than adding bars. It is wide
// enough that an ability aimed at its full range is on screen: the longest reach of any champion's
// abilities is about 650, and the champion is in the middle, so the shortest half of the view should
// come close to it.
export const GAME_VIEW_WIDTH = 1200
export const GAME_VIEW_HEIGHT = 675
// The most players one lobby can hold.
export const GAME_MAX_PLAYERS = 8
// Teams start spread evenly around a circle centred on the middle of the map, with each team's
// players side by side along it. The circle is as big as fits with `GAME_SPAWN_MARGIN` to spare
// between it and the nearest edge of the map, and teammates start this far apart along it.
export const GAME_SPAWN_MARGIN = 200
export const GAME_SPAWN_RADIUS = GAME_ARENA_HEIGHT / 2 - GAME_SPAWN_MARGIN
export const GAME_SPAWN_TEAMMATE_SPACING = 110
// Living characters are solid. Each tick, two that overlap are pushed apart along the line between
// their centres, like a spring that is stiffer the deeper they sit: the overlap shrinks by this
// share every tick (0.75 leaves a quarter of it after one tick and a sixteenth after two). Lower is
// softer and lets a walking character sink in further before it is stopped; 1 is a hard wall.
export const GAME_COLLISION_STIFFNESS = 0.75
export const GAME_TPS = 60
// A burning character takes its burn's damage on every tick that is a multiple of this, so twice a
// second. Whole numbers of health only, so a burn lands in chunks rather than a fraction per tick.
export const GAME_BURN_PULSE_TICKS = GAME_TPS / 2
export const GAME_FPS = 60
export const GAME_ORDER_WINDOW_TICKS = 12
export const GAME_SNAPSHOT_HISTORY_TICKS = GAME_ORDER_WINDOW_TICKS + 2
export const FINALIZE_LAG = GAME_ORDER_WINDOW_TICKS
// A confirmed death takes effect this many ticks after the server announces it, which
// leaves clients time to receive the message before the tick it names.
export const GAME_DEATH_LEAD_TICKS = 6
export const GAME_RESPAWN_TICKS = 3 * GAME_TPS
export const GAME_REMOTE_CATCHUP_MAX_SPEED_MULTIPLIER = 3
export const GAME_REMOTE_CATCHUP_EASE_TICKS = 5
// Remote champions are drawn this many ticks behind the round-trip delay, so orders
// that arrive a little late still land before the displayed tick.
export const GAME_REMOTE_RENDER_BUFFER_TICKS = 2
export const GAME_ORDER_TIMEOUT_MS = 200
export const GAME_ORDER_VERDICT_RETENTION_MS = GAME_ORDER_TIMEOUT_MS * 2
export const GAME_PING_INTERVAL_MS = 1000
// How far a cast's written origin may sit from the caster's simulated position.
export const GAME_CAST_ORIGIN_TOLERANCE = 24
