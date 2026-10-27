// The plain arena: the size of the ground when a game is not given a map to play on (the tests, and
// the floor drawn when a map cannot be used). A game on a map plays on the map's `arena` rectangle
// instead, whatever its size, and walls in it (see `Terrain`).
export const GAME_ARENA_WIDTH = 2376
export const GAME_ARENA_HEIGHT = 1440
// No champion's body is wider than this, so a map that holds one of this size has room for all of
// them: its spawn points are checked against it, and so is the way between them.
export const GAME_MAX_CHAMPION_RADIUS = 24
// The map a new lobby starts on, if the server has it: res/maps/<id>.tmj, made in Tiled. The leader can pick any
// other map in res/maps. Nothing else assumes it: a game is played on the map its lobby picked.
export const DEFAULT_MAP_ID = 'competetive'
// How much of the world the camera shows at least, centred on the controlled champion. A screen
// with another shape shows more of the world on its long side rather than adding bars. It is wide
// enough that an ability aimed at its full range is on screen: the longest reach of any champion's
// abilities is about 650, and the champion is in the middle, so the shortest half of the view should
// come close to it.
export const GAME_VIEW_WIDTH = 16 * 120
export const GAME_VIEW_HEIGHT = 9 * 120
// How far a champion sees, in world units, from its middle. It is a little under the shortest half of the view
// (`GAME_VIEW_HEIGHT` / 2, 540) so the edge of what is seen is on screen on every side, not just behind walls.
// What blocks sight, and how it is worked out, is the vision system's (see vision.ts).
export const GAME_VISION_RANGE = 500
// The most players one lobby can hold.
export const GAME_MAX_PLAYERS = 8
// The most players one team can hold. With GAME_MAX_PLAYERS it decides how many spawn points a map
// needs (see `spawnPointsNeeded`).
export const GAME_MAX_TEAM_SIZE = 4
// The team every monster is on, one past the last a player can pick. Monsters are teammates of each other and
// enemies of every player, so a blast from one never hurts another and any player can hurt any monster. It is
// no team of the game: it has no score, no start places and no colour in the lobby.
export const GAME_MONSTER_TEAM = GAME_MAX_PLAYERS + 1
// King of the hill: how many ticks one team with the most players on the hill takes to fill its bar, and so
// to empty it again when another team has the most. Capturing is the same speed whoever is on it and
// however many, since only having more than every other team counts.
export const GAME_HILL_CAPTURE_TICKS = 10 * 60
// A team that holds the hill with its bar full scores a point this often.
export const GAME_HILL_POINT_TICKS = 60
// Capture the flag: a flag is touched by a champion whose body is within this distance of it, beyond
// the champion's own radius. It is how close a champion must walk to pick up a flag, return one, or
// turn one in at its base.
export const GAME_FLAG_RADIUS = 40
// Living characters are solid. Each tick, two that overlap are pushed apart along the line between
// their centres, like a spring that is stiffer the deeper they sit: the overlap shrinks by this
// share every tick (0.75 leaves a quarter of it after one tick and a sixteenth after two). Lower is
// softer and lets a walking character sink in further before it is stopped; 1 is a hard wall.
export const GAME_COLLISION_STIFFNESS = 0.75
// How big one pixel of art is drawn, in world units: champions' sprites and, unless the map says
// otherwise, the tiles of the map.
export const GAME_ART_SCALE = 3
export const GAME_TPS = 60
// A burning character takes its burn's damage on every tick that is a multiple of this, so twice a
// second. Whole numbers of health only, so a burn lands in chunks rather than a fraction per tick.
export const GAME_BURN_PULSE_TICKS = GAME_TPS / 2
export const GAME_FPS = 60
export const GAME_ORDER_WINDOW_TICKS = 12
export const GAME_SNAPSHOT_HISTORY_TICKS = GAME_ORDER_WINDOW_TICKS + 2
export const FINALIZE_LAG = GAME_ORDER_WINDOW_TICKS
// How long a champion stays dead: it comes back this many ticks after the tick it died on.
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
