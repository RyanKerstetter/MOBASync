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
lobby leader starts the game for the whole lobby, which first opens champion
select for everyone: pick a champion, then lock in. Picks are visible to the other
players, and any player can back out for the whole lobby. When every player has
locked in, the game moves to its loading screen, which stays up until every player
is connected and ready.

The simulation runs at 60 ticks per second (TPS), and the PixiJS renderer is
capped at 60 frames per second (FPS). The shared `Simulator` stores characters by
numeric ID and keeps a fixed-size ring of tick snapshots. Query state with
`simulator.at(tick).get(characterId)`, then read the derived position, health,
and cooldown from that character snapshot. Each tick is computed from the
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
orders rather than stored as mutable character state. The server acknowledges log
insertion separately from gameplay validity. Every peer uses the shared
simulator to derive attack validity and damage from the same
orders; the server does not send attack verdicts or health changes. The server
commits through `currentTick - 12` to prune old orders.

## The map and the camera

The map is 2400 by 1350 (`GAME_ARENA_WIDTH` and `GAME_ARENA_HEIGHT`), three times the width and
height of the original single-screen arena, and champions walk anywhere on it; its edge stops
them at their radius. Players start in a row across the middle, `GAME_SPAWN_SPACING` apart.
The floor has a grid so movement across it is visible.

The camera is locked on the champion you control: that champion is always the middle of the
screen, drawn at the exact position it was just rendered at so the two never drift apart.
`GAME_VIEW_WIDTH` by `GAME_VIEW_HEIGHT` (800 by 450, the size of the old arena, so ranges and
champion sizes look as they did) is the least of the world a screen shows; a wider or taller
screen shows more on its long side instead of leaving bars. Past the map's edge you see the
dark background.

Because the camera moves under a still mouse, the mouse is remembered as a screen position and
converted to a world point (`computeCamera` and `screenToWorld` in `camera.ts`) at the moment
it is used: when you click, and when a key casts an ability at the cursor. Clicks and aiming
work over the dark area past the map's edge too, and an order aimed there is clamped to the map.

Each champion has one health bar over its head, in the style of League of Legends: current
health from the left, the shield on the end of it in white, and the health still missing after
that. The bar stands for the maximum health, or for health plus shield when that is more, so a
big shield shrinks the rest of the bar instead of running off the end. A small tick marks every
100 health and a taller, thicker one every 1000 (`HEALTH_TICK_EVERY` and
`HEALTH_MAJOR_TICK_EVERY` in `game.ts`). The layout is the pure function `layoutHealthBar`
(`health-bar.ts`), which `game.ts` only draws. A champion's maximum health is at most 1000 so far,
so a 1000 tick shows only when a shield stretches the bar past it.

## Champions and abilities

Per-unit stats live on a `Champion` (`packages/shared/src/champions.ts`): max
HP, move speed, radius, attack damage, speed, range, windup, and an ability kit in
Q/W/E/R slot order, plus a description and passive text for champion select.
Characters have no shield of their own. There are five champions: Cursebearer, Archer, Swordsman, Capricorn, and Soldier (all below).
Health and damage are whole numbers in the hundreds. To add a champion, add another
`new Champion({...})` to the list in `champions.ts`; the select screen lists every
champion in that map. Arena size, tick rate, and network timing remain global
constants in `constants.ts`.

A champion's auto attack is its `onAttackHit` effect list, which defaults to
`[damage(attackDamage())]`. `attackDamage()` reads the champion's own stat, so the
number is written once. The effects run with the attacked unit as both `subject` and
a unit `aim`, so `targetUnit()` works the same as in an ability and `spawnEntity` can
launch a projectile auto.

Abilities are data (`abilities.ts`). Each `AbilityDef` has a targeting mode
(`none`, `point`, `direction`, or `unit`), range, windup, backswing, cooldown,
and an `apply` list of composable effects, for example:

```ts
apply: [
  damage(linear(150, 100, curseStacksOnTarget), targetUnit()),
  haste(linear(0, 0.1, curseStacksOnTarget), seconds(2.5), self()),
  refundCooldown('feast', linear(0, 1 / CURSE_MAX_STACKS, curseStacksOnTarget), self()),
  popMarkers(CURSE_KEY, targetUnit()),
]
```

The tests do not read the real abilities or champions. `tests/fixtures.ts` holds copies of
every kit (and a plain "Test Brawler" with a shield and each targeting mode) under their own
`t-` ids with every number spelled out, so retuning the game never changes what a test
expects, and a test can add an ability of its own to pin one behaviour. `tests/content.test.ts`
is the separate check on the real roster: it confirms every champion and ability is
well-formed, accepted by the server, and actually runs, without reading any tuned number.

Q/W/E/R cast at the cursor in one of two cast modes, as in League of Legends, set with the
`castMode` option of `startGame` (`DEFAULT_CAST_MODE` in `cast-control.ts`; there is no menu
for it yet). Quick cast with indicator, the default, shows the ability's indicator while its key
is held and casts where the cursor is when the key is let go; Escape, the window losing focus, or
giving a move or attack command (right-click, clicking an enemy, or Space with an enemy in range)
drops the aim without casting. Quick cast casts the moment the key goes down. In both, an ability
with nothing to aim (targeting `none`) casts on the press. Pressing another ability key while
aiming moves the aim to it. A skillshot's indicator is just its band. An ability aimed at a point
or a unit also gets a ring at its range around the champion. The indicator is where it would go: a band along the quantized direction, a circle at the point held to range, or a ring
on the enemy under the cursor, which turns red when that enemy is beyond the ability's range. The
reach is measured centre to centre on the simulator's position of the enemy, not where it is drawn
(remote champions are drawn a little in the past), by `withinCastRange`, the same test the
simulator uses to accept a cast. The client refuses a unit cast out of range with a message
instead of sending one the simulator would silently drop. The band's width and the circle's radius come from the ability's
`indicator` (`{ width }` or `{ radius }`), which reads the size of what the ability fires (for
example Spout's `SPOUT_RADIUS`, or `soldierBolt.radius * 2`), so retuning a hitbox moves its
indicator with it. An aimed ability without one, such as Leap, gets a thin line or a small marker
ring. `ClientGameState.getCastPreview` resolves the target
the same way `createCastOrder` does but issues nothing, and reads the frame being drawn so that
calling it every frame does not move the simulation ahead.

The client resolves the slot to an ability
ID and writes a `cast` order containing the click tick, the caster's origin, and
the target (point clamped to range, direction quantized). The simulator checks
the kit, cooldown, origin, and target on every peer, then starts a windup. A
move order during windup cancels the cast without spending its cooldown. At
launch the simulator calls `runEffects` with an `EffectSource` (provenance
`id`, `rootId`, `ownerId`, `tick`, `at`, `aim`, `subject`). Auto-attacks follow
the same path and run the champion's `onAttackHit` effects.

**Cursebearer** is a ranged champion built around stacking a curse. Its auto attacks
(the passive) add one `curse` marker to the target, up to five, lasting ten
seconds (`CURSE_DURATION_TICKS`). Applying a stack refreshes the timer of the
whole stack, so they expire together. Q, Feast, pops the target's stacks: damage and haste per stack, and it
refunds a fifth of its own cooldown per stack (five stacks refunds all of it). W,
Miasma, leaves a stationary field where it was cast that hastes the caster and slows
enemies inside. E, Hex, is a line shot that slows and adds two stacks; against a
target already at five stacks it pops them for damage and haste instead.

**Archer** is a mobile marksman. Its passive takes one second off Leap's cooldown with
every auto (`reduceCooldown('leap', ticks)`, which shares the event `refundCooldown`
uses). Q, Leap, is a point-targeted dash of up to 280 px at 900 px/s. W, Focus, adds
40% attack speed and 120 attack range for four seconds. E, Snare, lobs a canister to
the target point and bursts into a slowing field there.

A dash is a `dash` on the character's frame: a target and a fixed speed. While it
lasts it replaces walking (slows and haste do not touch it), attack and cast orders
are rejected like any other invalid order, and a move order waits for it to end.
The `dash(speed, maxDistance)` effect writes it with `startDash`, so it begins on the
tick after the cast launches. Dying clears it. The local character is drawn
a fraction of a tick ahead along its step so a 15 px/tick dash is not drawn in jumps,
and remote characters skip catch-up smoothing while they dash.

Snare chains two entities. An `EntityDef` with `landAtAim` flies to the aimed point
and ends there, so its lifetime is the travel time (distance over `speed`, fitted to
whole ticks so it lands exactly). One with a plain `lifetimeTicks` is a set timer. When
either runs out its `onExpire` effects run at the point it ended, which is how Snare
spawns its field. Attack speed and range bonuses are `attackspeed` and `attackrange`
statuses; `Champion.attackRangeWith` and `attackCooldownTicksWith` read them for the
attack checks and for the client's range ring and cooldown bar.

**Swordsman** is a melee duelist whose stacks sit on himself. His autos add a sword stack
(up to three, eight seconds, refreshed together), and each stack adds damage to his autos
and to Slash. Q, Slash, cuts a 300 by 60 rectangle in front of him (`enemiesInLine`) and
leaves a trail of fire in exactly that rectangle that slows enemies and hastes allies. W, Radiance, spends the stacks in
a burst around him, with damage and haste per stack. E, Shackle, spends the stacks to
root an enemy, or stun them if he had all three, and resets his auto.

Root and stun are statuses. A root stops walking but not attacks or casts; a stun stops
those as well and cancels a windup that has not launched, without spending its cooldown.
Neither interrupts a dash already under way, but both stop an ability flagged `movement`
(Leap) from starting.

A rectangular field is one entity with a `box`, put in front of the caster with
`spawnEntity(def, { at: alongAim(distance) })`. Its effects find who is inside it with
`enemiesInBox(halfLength, halfWidth)` and `alliesInBox(...)`, which take the same half-extents
as the box and read the entity's heading, which entities pass to the effects they run
(a rectangle's facing, otherwise its direction of travel). `enemiesInLine` is the same
rectangle laid from the cast origin, with square ends, for instant hits. Two older options
remain on `spawnEntity` and `haste` but no champion uses them now: `{ line: { length, count } }`
lays a stationary entity as several copies along the aim, and `haste(..., { shared: 'name' })`
gives all copies from one cast a single status so overlapping copies do not add up.
`linear`'s base can itself be an amount, so an auto can be `attackDamage()` plus a bonus
per stack.

**Capricorn** is a water mage. Its passive is a champion-level `onCast` hook, which runs
after any of its abilities launches and marks it `empowered` (one marker, so casting twice
does not stack); its next auto spends the marker for bonus damage. Q, Tsunami, sends a
piercing rectangular wave (70 wide, 20 deep) that deals damage, shoves each target along the wave's
direction (up to 140 px, and never more than 50 px past where the wave stops), and interrupts it. W, Bubbles, fires a stream of five bubbles: on each target the first bubble
to hit deals full damage, leaves a short `bubbled` marker, and the rest deal half. E, Spout,
marks a small circle (65 radius) at the aimed point. After a 0.7 second warning it erupts,
damaging and slowing whoever is still inside, so the warning is the chance to step out.

A knockback is the same forced movement as a dash (`knockback(distance, speed)` starts a
dash on the target), so a shoved target cannot attack or cast until it lands and a root
does not hold it. With `{ pastEnd }` a push from a moving entity is capped at the end of that
entity's travel plus that much (entities tell their effects where their travel ends as
`travelEnd`), so something caught right at the end of a wave is not thrown as far as something
caught early in it. An entity's hits now carry its travel direction as their `aim`, which is
how a wave knows which way to push. `interrupt()` cancels a windup that has not launched
without stunning. `spawnEntity` takes a `volley` option (`count` copies from one spot, each
`intervalTicks` after the last, waiting unseen at the origin until their turn) and an `at`
anchor such as `aimPoint()`. An entity can also carry `onPulse` effects that run every
`pulseEveryTicks` ticks with a fresh source ID each time (the Soldier's medic bot heals with it).
`damage` now evaluates its amount
once per target with that target as the `subject`, so an amount that reads stacks on the
target is correct for each one.

Spout is two entities. The first, with `visual: 'telegraph'`, only counts down: the client draws
its outline and a disc inside it that swells to the full circle (the entity's `progress`, its
elapsed share of its lifetime, plus the tick its expiry effects fire on). Its `onExpire` effects
are the eruption itself: damage and slow on whoever is inside on that tick, then a short flash
entity. Everything about the hit happens at expiry, which is why dodging works.

**Soldier** is a ranged fighter that is deadliest up close. Its passive is its `onAttackHit`:
`when(subjectWithin(120), [melee strike], [plain attack])`, where the melee strike is
`damage(linear(attackDamage(), 0.6, attackDamage()))`, so a target within 120 px (centre to
centre, checked when the hit lands) takes 60% more. Q, Stim, costs 150 health and for five seconds
adds 50% attack speed, 30% move speed, and 30% damage resistance. W, Bolt, is a piercing shot
that slows and deals 80 plus a fifth of the target's missing health (`missingHealth()`, which
reads `SimReader.healthOf` as the tick began). E, Medic, gives a 250 shield and summons a bot
that heals 12 health every half second. Both last until the shield is broken, which is how the
bot is killed; casting Medic again replaces the bot and refreshes the shield.

Stim's cost is `loseHealth(amount)`: it ignores shields and resistance, and never takes the last
point, so it cannot kill. `heal(amount)` restores up to the maximum and does nothing for a unit
already at 0 health, since only the server can confirm a death and a heal must not undo one.
`resist(fraction, ticks)` is a status. Resistances add up to 90% and cut each hit before shields
absorb what is left.

The bot has no timer. An entity definition may leave out `lifetimeTicks` (and `landAtAim`) if it has
a `stayWhile`, which is then the only thing that ends it; `shield` takes a duration of `Infinity` for
a shield that lasts until damage breaks it or its owner dies. `shield(..., { shared: 'medic' })`
names the shield for its owner (`${ownerId}:shield:medic`) instead of giving it an ID of its own, so
casting it again refreshes it rather than adding a second one, and the bot's `stayWhile` looks that
status up on its owner with `SimReader.statusesOn` every tick. The moment the shield is broken, the
bot ends without running `onExpire`. Entities are not targets (attacks and casts aim at champions),
so damaging the Soldier through its shield is how the bot is killed. `spawnEntity(def,
{ onePerOwner: true })` gives the entity an ID from its owner rather than from the cast, so
spawning another replaces the one already out. The bot has no art of its own; a plain circle is the
indicator.

The bot hangs on its owner by a spring: `follow: { stiffness, damping, offset }`. An entity's path
is normally a straight line worked out from its origin and velocity, which cannot describe this, so
a following entity keeps its live `velocity` and its `position` on the entity and the simulator
steps them every tick (velocity first, then position from it). The acceleration is `stiffness`
times the distance to a rest point (the owner's position plus `offset`, kept inside the arena)
minus `damping` times the velocity. The bot is summoned on the Soldier, rises to its rest point 36
above, swings a little past it and settles. Walking, it settles into a constant lag behind of
`damping * speed / stiffness`, and when the Soldier stops it swings ahead and back. There is no
fixed distance. Damping under `2 * sqrt(stiffness)` is what makes it swing; raise it for a
tighter bot and lower it for a floatier one. `entityPosAt` returns the stored position, and the
position and velocity travel in checkpoints with the rest of the entity. The client reads the
position from the frame, so the bot moves in whole-tick steps rather than being smoothed between
ticks like the champions.

An entity definition has a `radius` (a circle) or a `box` (`halfLength` along its heading,
`halfWidth` across it), never both. A box entity hits the units its rectangle touches, using
`boxTouchesCircle` (`geometry.ts`), and is drawn as a rotated rectangle. Its heading is the
aimed direction, stored as the entity's optional `facing` so a stationary box points where it
was aimed and the heading survives snapshots. Only entity hits use the box; field selectors
such as `enemiesInRadius` still read as circles, and characters are always circles. Tsunami is
the only box so far.

Effects never touch simulator state directly. They receive a `SimContext`
(`effects.ts`): `SimReader` reads characters, positions, and units in a radius;
`SimWriter` adds statuses, markers, queued orders, and entities, and emits
events such as damage. Writes are buffered and applied at the end of the tick,
so every effect in a tick reads the same state. Cooldowns, windups, statuses
(slow, shield), markers, effect-queued orders, and entities are all frame
state. They roll back, replay, and travel in checkpoints like movement and
health. Shield statuses, from the `shield` effect, absorb damage before health. Move speed is the
champion's base times `1 + the sum of active haste` times `1 - the strongest slow`.

Stacks are markers, one per stack. `SimReader.markersOn` counts them as they stood
before this tick's writes, so an ability can read the stacks it is about to pop and
use them for several results at once: `linear(base, each, stacks('curse'))` scales
damage, haste, and the `refundCooldown` fraction, and `popMarkers` removes them at
the end of the tick. `mark(key, ticks, to, { count, cap })` adds stacks and keeps
only the newest `cap` and, because a capped marker is a stack, refreshes every marker's
timer in it. `when(condition, then, otherwise)` branches between effects.

An `EntityDef` can carry `onHit` (runs for each enemy it touches), `onTick` (runs
every tick at its position), a `speed` of 0 for something stationary, and a
`visual` of `'bolt'` or `'field'`. Miasma is a stationary entity whose `onTick`
re-applies two-tick haste and slow statuses to whoever is inside, so the effect
ends right after a unit leaves.

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
server tick. An initial snapshot is sent when a client joins. Entities
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
