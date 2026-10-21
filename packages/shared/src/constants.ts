// The whole map, three times the width and height of the original single-screen arena.
export const GAME_ARENA_WIDTH = 2400
export const GAME_ARENA_HEIGHT = 1350
// How much of the world the camera shows at least, centred on the controlled champion. A screen
// with another shape shows more of the world on its long side rather than adding bars.
export const GAME_VIEW_WIDTH = 800
export const GAME_VIEW_HEIGHT = 450
// Players start in a row across the middle of the map, this far apart.
export const GAME_SPAWN_SPACING = 400
export const GAME_TPS = 60
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
