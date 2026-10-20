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
numeric ID; entities evaluate their position at a synchronized tick using
their orders. Each entity stores its starting position separately from its
orders. Movement stays at its destination implicitly once its calculated travel
time completes; the simulator does not append a hold order.
Right-click the map to issue a movement order. Click an enemy to attack, or
press Space to attack the closest enemy in range. Attack orders are intents:
the server clamps their click tick to its backdate window and validates range,
life state, and cooldown at that stamped tick. An accepted attack interrupts
movement at the later of the server tick and the click tick, using the unit's
position at that time. The attack action becomes the position anchor, so the
unit implicitly remains there when the action finishes (attack wind-up is
currently zero ticks); no hold order is appended. The click stamp remains the
basis for attack timing and damage ordering. Shield and health damage are
finalized five ticks later.
Resending an order returns its cached acknowledgement
without rebroadcasting it. Units start with 10 HP and 1 shield. The client
shows health, shield, local attack range, and cooldown, and applies only newer
server health results. Movement and attack intents share one order stream,
sequence, and acknowledgement event; each order is acknowledged as accepted or
rejected. Pending orders are retried with exponential backoff
(50 ms, then 100 ms) and undone if no acknowledgement arrives within 200 ms.
The channel-bound reliable messenger owns sending, acknowledgement matching,
retries, and timeouts. It acknowledges received broadcasts only after the
client successfully applies them. The client reconciles movement predictions
when acknowledgements arrive.
Accepted orders are broadcast to other clients instead of
sending recurring full snapshots. Each recipient acknowledges accepted-order
broadcasts; the server retries unacknowledged orders until the delivery timeout.
Snapshot recovery after a delivery timeout is not implemented yet. Clients ping
once per second and average the measured RTT to refine their estimate of the
server tick. An initial snapshot is still sent when a client joins to establish
simulation state. Projectiles
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
