# 2D MoBA

A small browser lobby and game built with TypeScript, PixiJS, Geckos, Vite, and
a lightweight HTTP server.

## Project structure

- `apps/client` contains the lobby interface and PixiJS game.
- `apps/server` contains the in-memory lobby API and Geckos game server.

## Run the project

Install dependencies once from the project root:

```sh
npm install
```

Start the client and server together:

```sh
npm run dev
```

Vite prints the browser URL. The lobby API listens on port `9208` and the Geckos
game server listens on port `9209`; players see lobby updates while connected,
and inactive players are removed after a short timeout.
You can also run only one side with `npm run dev:client` or
`npm run dev:server`.

Create a lobby to get a six-character code, then share it with other players.
Usernames default to `Player`; if a name is already in use in a lobby, a number
is appended. Lobbies allow two players by default; configure this with the
positive-integer `LOBBY_MAX_PLAYERS` environment variable on the server. The
lobby leader starts the game for the whole lobby. The game stays on its loading
screen until every player is connected and ready.

The simulation runs at 60 ticks per second (TPS), and the PixiJS renderer is
capped at 60 frames per second (FPS). The shared `Simulator` stores entities by
numeric ID and keeps a fixed-size ring of tick snapshots. Query state with
`simulator.at(tick).get(entityId)`, then read the derived position, health,
shield, and cooldown from that entity snapshot. Each tick is computed from the
preceding cached tick. If a late order or health result changes an earlier
tick, cached snapshots from that tick onward are invalidated and recomputed.
Movement stays at its destination implicitly once its calculated travel time
completes; the simulator does not append a hold order.
Right-click the map to issue a movement order. Click an enemy to attack, or
press Space to attack the closest enemy in range. Both are timestamped intents
ordered deterministically by `(tick, sequence, player, id)`. The client inserts
its own attack into the simulator immediately. Shared simulation code derives
whether each attack is valid from life state, range, and cooldown; only a valid
attack stops movement or starts cooldown, so an invalid attack cannot interrupt
a move while waiting for the server. Cooldown is derived from valid attack
orders rather than stored as mutable entity state. The server acknowledges log
insertion separately from gameplay validity. Every peer uses the shared
simulator to derive attack validity, damage, shield, and death from the same
orders; the server does not send attack verdicts or health changes. The server
commits through `currentTick - 12` to prune old orders. Units start with 10 HP
and 1 shield.

Pending order messages are retried with exponential backoff. Silence does not
undo a prediction: after the retry timeout the client requests a full state
snapshot, and retries continue until an acknowledgement arrives. Server-side
broadcast timeout also triggers a snapshot. Selected handshake and
acknowledgement messages use Geckos reliable delivery.

Network snapshots use the latest committed frame as a checkpoint and include
only orders newer than that checkpoint for replay. The server sends these
checkpoints once per second by default; configure the positive-integer
`GAME_CHECKPOINT_INTERVAL_MS` environment variable to change the interval.
Delivery acknowledgements are per message rather than cumulative, and reliability has
not yet been applied to every lobby/game lifecycle event. Clients ping once per
second and use an exponential moving average of measured RTT to estimate the
server tick. An initial snapshot is sent when a client joins. Projectiles
are stored and simulated separately from entities, with basic velocity and
lifetime support, but are not currently spawned by a game command.
All entities render at the current estimated tick. Remote entities retain their
last displayed position and catch up toward the current order-derived position.
The catch-up speed eases from normal toward a 3x cap as the position gap grows,
then approaches normal as the gap closes; remote entities are not rendered on
a delayed timeline.

## Build

```sh
npm run build
npm run preview
```
