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

Vite prints the browser URL (port `5173`). The lobby API listens on port `9208`
and the Geckos game server on port `9209`; the Vite server forwards `/api` and
`/.wrtc` to them, so the browser only ever talks to one port. Players see lobby
updates while connected, and inactive players are removed after a short timeout.
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
simulator to derive attack validity, damage, and shield from the same
orders; the server does not send attack verdicts or health changes. The server
commits through `currentTick - 12` to prune old orders.

## Champions and abilities

Per-unit stats live on a `Champion` (`packages/shared/src/champions.ts`): max
HP, base shield, move speed, radius, attack damage, speed, range, windup, and an
ability kit in Q/W/E/R slot order. Every player currently plays the default
Vanguard (10 HP, 1 shield). Arena size, tick rate, and network timing remain
global constants in `constants.ts`.

Abilities are data (`abilities.ts`). Each `AbilityDef` has a targeting mode
(`none`, `point`, `direction`, or `unit`), range, windup, backswing, cooldown,
and an `apply` list of composable effects, for example:

```ts
apply: [
  damage(2, enemiesInRadius(120)),
  slow(0.3, seconds(1), enemiesInRadius(120)),
  shield(2, seconds(1.5), self()),
  resetAutoTimer(),
]
```

Press Q/W/E/R to cast at the cursor. The client resolves the slot to an ability
ID and writes a `cast` order containing the click tick, the caster's origin, and
the target (point clamped to range, direction quantized). The simulator checks
the kit, cooldown, origin, and target on every peer, then starts a windup. A
move order during windup cancels the cast without spending its cooldown. At
launch the simulator calls `runEffects` with an `EffectSource` (provenance
`id`, `rootId`, `ownerId`, `tick`, `at`, `aim`, `subject`). Auto-attacks follow
the same path and run the champion's `onAttackHit` effects.

Effects never touch simulator state directly. They receive a `SimContext`
(`effects.ts`): `SimReader` reads entities, positions, and units in a radius;
`SimWriter` adds statuses, markers, queued orders, and projectiles, and emits
events such as damage. Writes are buffered and applied at the end of the tick,
so every effect in a tick reads the same state. Cooldowns, windups, statuses
(slow, shield), markers, effect-queued orders, and projectiles are all frame
state. They roll back, replay, and travel in checkpoints like movement and
health. Shield statuses absorb damage before the base shield, and the strongest
active slow scales movement speed.

Death is the one outcome clients never derive. Reaching 0 health leaves a
champion alive in every simulator. Once the lethal tick is committed (so no late
order can undo it) the server sends a reliable `game:death` message naming the
tick it takes effect (`GAME_DEATH_LEAD_TICKS` ahead) and the respawn tick
(`GAME_RESPAWN_TICKS` later). Clients add it to the simulator with
`addDeath`, which stops the champion at that tick and respawns it at its
starting position with full health at the respawn tick. Pending deaths travel
in snapshots, so a lost message is recovered by a resync.

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
are spawned by ability effects, stored in each simulation frame, and hit the
first enemy they overlap unless their definition pierces.
The local champion renders at the current estimated tick. Remote champions render
about one round trip plus `GAME_REMOTE_RENDER_BUFFER_TICKS` in the past, so the
orders that shape their path have already arrived and they are not corrected on
every order. Their displayed position still eases toward that target, with a
catch-up speed that grows toward a 3x cap as the gap widens, and snaps when a
respawn teleports them.

## Hosting on a VPS

```sh
git clone <your repo url>
cd <repo>
npm install
npm run dev
```

Then open `http://<your-vps-ip>:5173`. That is the whole app, but a VPS also
needs its firewall opened, because it blocks incoming traffic by default.

### What to open

| Port | Protocol | What uses it | Open to the internet? |
| --- | --- | --- | --- |
| `5173` | TCP | The web page, plus the lobby API and game signaling that Vite forwards | Yes |
| `10000` | UDP | The WebRTC game connection | Yes |
| `9208`, `9209` | TCP | Lobby API and Geckos signaling | No. They only need to be reachable from the VPS itself |

The game itself runs over WebRTC. The browser first signals over HTTP (through
port `5173`), then the real game traffic flows over UDP. Geckos multiplexes every
player onto one UDP port, so a single rule covers all lobbies. If the page loads
and you can create a lobby but the game never leaves "Connecting", the UDP port
is blocked.

There are usually two firewalls to open:

1. **The cloud provider's firewall** (AWS security group, GCP VPC firewall rule,
   Azure NSG, Oracle security list, or the DigitalOcean/Hetzner/Vultr cloud
   firewall). Add inbound rules for TCP `5173` and UDP `10000` from anywhere.
2. **The firewall on the machine itself**, if one is enabled:

   ```sh
   sudo ufw allow 5173/tcp
   sudo ufw allow 10000/udp
   ```

   On Windows Server, add the same two inbound rules in Windows Defender Firewall.

### NAT and STUN

Some clouds (AWS, GCP, Azure, Oracle) give the VM a private address that is
translated to its public one. The game server cannot see its public address
there, so it asks a STUN server. Google's public one is the default. Providers
that put the public address straight on the machine (Hetzner, DigitalOcean,
Vultr, Linode) work either way. Override with `WEBRTC_ICE_SERVERS`, a
comma-separated list such as `stun:stun.example.com:3478`, or set it to an empty
string to disable STUN.

### Settings

Set these as environment variables on the server, for example
`CLIENT_PORT=8080 npm run dev`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLIENT_PORT` | `5173` | Public web port |
| `LOBBY_API_PORT` | `9208` | Internal lobby API port |
| `GECKOS_PORT` | `9209` | Internal Geckos signaling port |
| `WEBRTC_PORT_MIN` | `10000` | UDP port used for WebRTC |
| `WEBRTC_PORT_MAX` | same as min | Top of the UDP range, if you want to allow a range |
| `WEBRTC_ICE_SERVERS` | Google STUN | Comma-separated STUN/TURN URLs |
| `LOBBY_MAX_PLAYERS` | `2` | Players per lobby |

### Keeping it running

`npm run dev` stops when your SSH session closes. Run it under `tmux`, `screen`,
or a process manager such as `npx pm2 start "npm run dev" --name moba`.

`npm run dev` is the development setup: it restarts the server whenever a file
changes, which drops the in-memory lobbies. For a steadier setup run `npm start`.
It builds the client once and serves it with the same ports and the same proxy.

### HTTPS and a domain

Plain `http://<ip>:5173` works for playing. Browsers disable a few features on
non-HTTPS pages (the "Copy" button for the lobby code); the game works without
them. For HTTPS, put a reverse proxy such as Caddy in front. With this
`Caddyfile` it obtains a certificate automatically:

```
game.example.com {
    reverse_proxy localhost:5173
}
```

Open TCP `80` and `443` instead of `5173`. The UDP rule stays the same, because
WebRTC traffic does not go through the proxy.

## Build

```sh
npm run build
npm run preview
```
