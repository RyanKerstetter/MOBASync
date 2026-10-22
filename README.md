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
is appended. Lobbies hold up to eight players (`GAME_MAX_PLAYERS`, which is also the default);
set the `LOBBY_MAX_PLAYERS` environment variable on the server to a whole number from 1 to 8 for
a smaller cap. Each player picks a team in the lobby from a row of coloured buttons (`GAME_TEAMS`: Red,
Blue, Green, Gold, Purple, Orange, Teal and Pink, one for every player a full lobby holds). Someone who
joins is put on the smaller of the first two teams, Red when they are level, so a lobby fills up as
two even teams, and renaming keeps your team. Players on the same team are teammates and everyone
else is an enemy, so if everyone picks a different team, a full lobby is an eight-way free for all.
Teams can be changed only in the lobby, not once champion select has opened. The
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
its own order into the simulator immediately. The server acknowledges log
insertion separately from gameplay validity. Every peer uses the shared
simulator to derive attacks and damage from the same
orders; the server does not send attack verdicts or health changes. The server
commits through `currentTick - 12` to prune old orders.

**An attack order locks on; it is not one swing.** It makes the enemy the character's target
(`attackTarget` on the character's frame: the target's ID and the order that set it), and from then
on the simulator (`driveAttacks`, every tick) does the rest. A target out of attack range is chased:
the character walks toward where it stands now, so a fleeing target is followed. In range, it stops
and begins an attack whenever its attack is off cooldown, and again each time the cooldown is up,
until the lock ends. A click does not need to be timed against the cooldown: an order for a target
that is on cooldown just waits for it. The lock ends when:

- the character is given a move order, or an attack order for someone else (an attack order that cannot
  be carried out, such as one at a teammate or at someone already dead, changes nothing, so it does
  not interrupt a walk);
- it casts an ability with a windup, since it stops to cast and does not go back to the target;
- the target dies, leaves, or stops being an enemy, or the character itself dies (a respawn does not
  resume it).

It is held but kept while the character is stunned, dashing or winding up, and a rooted character
stays where it is and carries on after its target once freed. An ability with **no windup** does not end
it, so a character can auto, cast one, and auto again with a single order. It does not interrupt a
walk either: a character told to move goes on walking through such a cast (after a dash it started,
it resumes the walk), where a cast with a windup stops it to cast and it does not set off again. The
lock lives in the frame, so it is part of every checkpoint and replay like any other state.

On the screen, an enemy a click would attack is marked when the mouse is over it (four small ticks
around it and a crosshair cursor), so you can see that the attack can be queued; the enemy the attack is locked
on keeps slightly heavier red ticks for as long as it is (`attack-marker.ts`). Neither shows while an ability is
being aimed, since the click would cast it, or while dead.

What is affecting a champion is written in small words above its name (`stunned`, `rooted`, `silenced`,
`blinded`, `burning`, `slowed`, `hasted`, all that apply, the most disabling first; `status-labels.ts`), not
drawn as a coloured ring around it.

## The map and the camera

The map is 2400 by 1350 (`GAME_ARENA_WIDTH` and `GAME_ARENA_HEIGHT`), three times the width and
height of the original single-screen arena, and champions walk anywhere on it; its edge stops
them at their radius. Teams start spread round the middle of the map. The circle is as big as fits
with `GAME_SPAWN_MARGIN` to spare from the nearest edge (`GAME_SPAWN_RADIUS`, 475), each team gets
an equal slice of it, in order of team number starting from the west and going round clockwise, and
a team's players stand side by side at the middle of its slice, `GAME_SPAWN_TEAMMATE_SPACING` apart.
Two teams therefore face each other across the middle, and eight teams of one are evenly round it.
The layout is the pure function `teamSpawnPositions` (`teams.ts`): the server works out the starting
places once, rounds them to whole numbers and sends them in the snapshot, so no peer depends on
trigonometry giving the same answer.
The floor has a grid so movement across it is visible.

## Teams

A character's `team` is a number, held on its `SimCharacter` and sent in the snapshot. Two
characters on the same team are teammates and any others are enemies; `areEnemies` is the one
place that decides, and by default a character is on a team of its own (its ID), so a game where
nobody is given a team is a free for all. Everything that can hurt or disable already asked "is this
an enemy?", so teams reached all of it at once: attacks and unit-targeted casts cannot be aimed at a
teammate, and `enemiesInRadius`, `enemiesInLine`, `enemiesInBox` and every entity's hits skip
them, so blasts, lines, shots, traps, fires and the pushes, stuns, roots, silences, blinds and burns
that come with them only ever reach enemies. A shot that stops at the first thing it hits
flies through a teammate. The Grenadier's grenade therefore does not bounce, hurt or
refund for a teammate, and its flashbang does not stun or blind one. The effects meant for allies
(`alliesInRadius`, `alliesInBox`) reach teammates as well as the caster: Miasma's speed-up, and the
speed-up in the fire Slash leaves. Teammates are still solid, and push each other apart like anyone.

The client draws each body in its team's colour (`getTeam`), with a thick white outline on the
champion you control, since a green fill no longer tells you which it is. Clicking a teammate, the
Space key, and an ability aimed at a unit never pick a teammate, and the lobby shows
each player's team by colour and name. Champion select lists who is picking what grouped by team, a heading in
the team's colour over each group.

## Collision

Living characters are solid: they cannot be walked or dashed through. After every character has
moved on a tick, each pair whose bodies overlap (centres closer than the two radii) is pushed
apart along the line between their centres, each by half of `GAME_COLLISION_STIFFNESS` times
the overlap. That is a spring whose force grows with the depth and whose response is too damped
to bounce, so the overlap shrinks by the same share every tick (at the default 0.75, to a
quarter after one tick and a sixteenth after two) and the pair slide apart and settle just
touching. A walker pressing into a character sinks in about a pixel, because it keeps stepping
in while the spring pushes back, and one aimed off-centre slides around the other and carries
on to its target. Lower the stiffness for softer bodies, up to 1 for a hard wall (which starts
to jitter in a crowd). Eight characters all walking to one point compress further, to roughly a
third of a body, since each keeps pressing in against several neighbours at once.

Nothing is stored for this: the push is worked out from the tick's positions alone, so it
replays the same after a rollback or a checkpoint restore. All pushes are computed from the
positions as the tick found them, then applied together, pairs visited in ID order, so arrival
order cannot matter. Two characters on exactly the same spot have no line between them, and the
lower ID goes toward -x. The arena's edge still holds whoever is pushed against it, and the
other takes the rest of the room. The dead are ghosts that neither push nor are pushed, and a
character that respawns onto someone is pushed off them. Dashes and knockbacks collide too, so
a leap into someone shoves them ahead of it rather than passing through (a dash made `through` is the
exception, below). The client needs
nothing for it: the local champion is drawn along its last net step, push included.

The camera is locked on the champion you control: that champion is always the middle of the
screen, drawn at the exact position it was just rendered at so the two never drift apart.
`GAME_VIEW_WIDTH` by `GAME_VIEW_HEIGHT` (1920 by 1080) is the least of the world a screen
shows; a wider or taller screen shows more on its long side instead of leaving bars. It is big
enough that an ability aimed at its full range is on screen, since the champion is in the middle and
the longest reach of any ability is about 650. Past the map's edge you see the dark background.

The bottom of the screen is the HUD (`hud.ts` works out what it shows and `game.ts` fills in the
elements): the controlled champion's exact health as `hp / max`, with any shield as `+n` beside it and
laid after the health on the bar, and a slot for each ability on its key. A slot fills from the
bottom as the cooldown runs, shows the seconds left, and lights up when the ability is ready; a key
that has turned into its recast shows that ability's cooldown. The debug overlay at the top left
keeps only the network and simulation diagnostics.

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

Stacks are drawn as pips under the body, by the pure function `layoutStackPips` (`stack-pips.ts`).
There are two kinds, told apart by shape, colour and row, so two with similar colours can never
share a spot. A champion's own stacks (Swordsman's sword, Capricorn's empowered, Ninja's shadow) are
round and sit in the row nearest the body. Marks that other champions place on it (Cursebearer's
curse, the Grenadier's sighted) are diamonds, and when it carries both they take a row of their own below.
A row with nothing in it takes no room, so a champion with one kind has it nearest the body. Each
kind of stack has a colour of its own; to give a new stack a pip, add its key and colour to the
list for its kind.

## Champions and abilities

Per-unit stats live on a `Champion` (`packages/shared/src/champions.ts`): max
HP, move speed, radius, attack damage, speed, range, windup, and an ability kit in
Q/W/E/R slot order, plus a description and passive text for champion select.
Characters have no shield of their own. There are eight champions: Cursebearer, Archer, Swordsman, Capricorn, Soldier, Grenadier, Trinketmaster, and Ninja (all below).
Health and damage are whole numbers in the hundreds. To add a champion, add another
`new Champion({...})` to the list in `champions.ts`; the select screen lists every
champion in that map. Arena size, tick rate, and network timing remain global
constants in `constants.ts`.

A champion's auto attack is its `onAttackHit` effect list, which defaults to
`[damage(attackDamage())]`. `attackDamage()` reads the champion's own stat, so the
number is written once. The effects run with the attacked unit as both `subject` and
a unit `aim`, so `targetUnit()` works the same as in an ability and `spawnEntity` can
launch a projectile auto.

An auto is either instant or fires a shot, chosen per champion with the optional
`attackProjectile: { speed, radius, color }` on its definition. Without it the attack lands
the moment its windup finishes, however far away the target is (melee champions, and a ranged
champion that should hit instantly). With it, the windup launches a shot from the attacker that
flies at `speed` (px/s) straight at the target and turns as the target moves, and `onAttackHit`
runs when the shot touches it, which is within the shot's `radius` plus the target's. The shot has
no timer. It passes through anyone else in its way, and it is spent without doing anything if its
target dies or leaves the game. The range is checked once, when the attack starts; after that a
target cannot get out of reach, so a shot slower than the target's run speed would chase forever.
Cursebearer, Archer, Capricorn and Soldier fire shots (`speed`, `radius` and `color` are tuned in
`champions.ts`); Swordsman is instant. The cooldown starts at launch either way.

Because `onAttackHit` runs on arrival, everything it reads is read then: Capricorn's empower is
spent and Soldier's melee range is measured when the shot lands, and Cursebearer's curse is added
then. Behind this, `Champion.onAttackLaunch` is what the simulator runs when a windup finishes:
`onAttackHit` itself for an instant attack, or the launch of the shot. The shot is a homing
entity (below) shared by every champion with the same speed, radius and colour, whose hit runs
its shooter's own `onAttackHit`, so a copy of a champion with different effects needs nothing
registered.

An ability can instead **ready the next auto**, with the optional `empowerAttack: { ticks, effects }`
on its definition. Casting it does its `apply` effects as usual, and also puts a `ready:<id>` marker
on the caster for `ticks`. The champion's `attackEffects` (its `onAttackHit` plus, for each such
ability, a `when` that runs `empowerAttack.effects` and pops the marker if it is there) are what an
auto runs, so the next auto to land carries the effects, once, whether it is instant or a shot, and the
ability's own cooldown starts at the cast. An auto that does not land, because its attacker was blind,
does not use the marker up. Hush and Shackle are these: no windup, no target, and a `resetAutoTimer()`
in `apply` so the auto that follows can go at once. Because an attack lock carries on through a
no-windup cast, auto, Hush, auto is a single click and a single key.

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
indicator with it. A circle can have a second one inside it, `{ radius, innerRadius }`, for an
ability whose middle does something other than its edge: the Flashbang draws the whole flash and
the core that stuns. The two overlap, so the core is drawn darker than the ring around it. An aimed
ability without one gets a small marker ring at the point. A dash (`indicator: { line: true }`, as on Leap
and Shadow Step) also draws a line from the champion to the point. `ClientGameState.getCastPreview` resolves the target
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
the target point and leaves a small trap there (70 radius) for one second. The trap roots each
enemy for 1.5 seconds the moment its body touches it, whether it lands on them or they walk into
it, and only once each; the Archer is never caught in her own.

A dash is a `dash` on the character's frame: a target and a fixed speed. While it
lasts it replaces walking (slows and haste do not touch it), cast orders are rejected
like any other invalid order, and a move order waits for it to end. An attack order locks on at
once, and the chase and the first swing wait for the dash to end.
The `dash(speed, maxDistance)` effect writes it with `startDash`, so it begins on the
tick after the cast launches. Dying clears it. The local character is drawn
a fraction of a tick ahead along its step so a 15 px/tick dash is not drawn in jumps,
and remote characters skip catch-up smoothing while they dash.

Snare chains two entities. An `EntityDef` with `landAtAim` flies to the aimed point
and ends there, so its lifetime is the travel time (distance over `speed`, fitted to
whole ticks so it lands exactly). One with a plain `lifetimeTicks` is a set timer. When
either runs out its `onExpire` effects run at the point it ended, which is how Snare
spawns its trap. The trap is a stationary `pierce` entity with an `onHit`: an entity's hit runs
once for each enemy it touches, and a piercing one stays out after a catch instead of ending on
the first, so one `root` effect covers both the enemy it lands on (caught on the tick after it
lands) and anyone who walks in while it is out. (An `onTick` effect would instead re-apply every
tick to everyone inside and keep renewing a root.) Attack speed and range bonuses are `attackspeed` and `attackrange`
statuses; `Champion.attackRangeWith` and `attackCooldownTicksWith` read them for the
attack checks and for the client's range ring and cooldown bar.

**Swordsman** is a melee duelist whose stacks sit on himself. His autos add a sword stack
(up to three, eight seconds, refreshed together), and each stack adds damage to his autos
and to Slash. Q, Slash, cuts a 300 by 60 rectangle in front of him (`enemiesInLine`) and
leaves a trail of fire in exactly that rectangle that slows enemies and hastes allies (him and his teammates). W, Radiance, spends the stacks in
a burst around him, with damage and haste per stack. E, Shackle, readies his next auto
(for five seconds) to spend the stacks on its target: it roots them for 1.5 s, or stuns them for 1 s if
he had all three. It has no windup, so it can be used between autos, and it resets his auto timer.
The auto reads the stacks he had before it adds its own, so the stack that auto adds stays.

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

**Grenadier** is a ranged bomber. Its passive is its `onAttackHit`: each auto puts a `sighted`
marker on its target (shown as a red diamond), and the auto that would be the third on the same
enemy within five seconds pops them instead and gives the Grenadier 50% move speed that fades to
nothing over three seconds. The markers sit on each enemy separately, so the count is per enemy,
and autos at others neither add to it nor reset it. All three abilities are lobs to a point, like
Snare: they take longer the farther they go (distance over speed, fitted to whole ticks) and do
their work in the entity's `onExpire`, on the tick after they land. Q, Grenade, explodes in a
110 radius. Everyone in the blast is thrown 150 px straight away from its centre, and enemies
also take damage; the Grenadier is thrown 120 px away from the centre too, but only if it is
standing in the blast (so a grenade thrown near its feet is a jump, as with Ziggs' satchel, and
one thrown across the map does nothing to it). A blast that catches an enemy hands back half of
the ability's cooldown. W, Molotov, leaves fire where it lands for four seconds that slows enemies
and sets them alight, and they keep burning for three seconds after they leave it. E, Flashbang,
goes off in a 130 radius with a 55 core: an enemy in the core, a direct hit, is stunned for a
second, and one that only gets the edge of the flash is blinded for a second and a half instead,
so a near miss still costs them. The indicator shows the whole flash.

Four things were added for it. A haste can `fade`: `haste(fraction, ticks, to, { fades: true })`
starts at the full bonus and falls in a straight line to nothing at the end, instead of holding
steady (the movement step reads how much of the status is left on the tick it walks). `burn(dps,
ticks)` is a status that deals damage: its `amount` is the damage for each pulse, and every
`GAME_BURN_PULSE_TICKS` (half a second) each living burning character takes that much as an
ordinary damage event credited to whoever lit it, so resistance and shields apply. A fire that
re-applies the burn every tick it is stood in keeps refreshing the one status, which is how it
outlasts the fire; burns from different sources add up. `blind(ticks)` is a status like root and
stun: a blinded character walks, casts and takes the same cooldowns, but its auto attacks miss, so
the windup and the cooldown are spent and nothing lands or launches (a shot already in the air
still lands). The blast's push is a plain `knockback`: an effect an entity runs on expiry has no
aim, so it pushes away from where the entity ended, which is the centre of the blast.
`selfInRadius(r)` is the matching selector for the caster, empty unless its body reaches into the
circle, so the thrower is thrown only when it is close. Statuses carry the new `fades` flag in
checkpoints, and the client names a burning or blinded character as such above its name, below stun
and root but above slow and haste.

**Trinketmaster** is a melee trickster built around a stick. His passive is a three-hit combo, for damage
and speed, and it is for abilities, not plain autos: every ability hit he lands on an enemy, the stick
going out, the stick coming back, or the auto that Hush readies (Hush landing), leaves a `trick`
marker on it for five seconds (refreshed by each hit), and the third such hit on the same enemy pops
the markers instead, for 50 more damage on top of its own and 30% move speed for two seconds. The
list of effects that does this is `trickEffects` (`abilities.ts`), added to each hit that counts: the
`onHit` of the stick and the recall, and the `empowerAttack` effects of Hush, which run when its auto
lands. His plain autos are not in it. The count is per enemy, and a swing that is dodged or missed
does not count. Q, Stick, is a skillshot, aimed and drawn
as a straight band like Hex's: the stick flies 420 px in a line, hurting every enemy it passes
through once, and lands in the ground where the flight ends (or against the wall, if it meets one
first) and stays, with no timer, until the Trinketmaster dies. Walking over it
picks it up and leaves Q no more than a second to wait, however long was left; a Q that had less is
not lengthened. Calling it back is different: pressing Q again sends the stick flying home through
enemies, hurting and slowing each once, and it is gone when it reaches the Trinketmaster, but Q's
cooldown is exactly as it was. An enemy in the line is therefore hit going out, for damage alone, and
again coming back, for damage and a slow. Only walking over the stick refunds Q. W, Hush, readies his next auto (for five seconds)
to silence its target for 1.5 s, and resets his auto timer. It has no windup and no target, so it
goes between autos. E, Warp, blinks the Trinketmaster to the stick,
wherever it is: it is there on the next frame, standing on the stick, so the stick is walked over and
Q is left a second to wait. Warp has no range limit.

This needed a few things the engine did not have. **Blink** is an effect, `blink(anchor)`, that moves
a unit to a point as the tick ends: unlike a dash it has nothing in between, a root does not hold it,
and a character at the other end is no obstacle (the two are pushed apart as usual). **Silence** is a
status like root and stun that stops starting an ability and nothing else: the unit walks, attacks,
and finishes a cast it had begun. A **pickup** is an entity's `pickup` effects, which run, and end the
entity, the first tick its owner's body touches it. The stick's refunds Q, for walking over it (and
Warp lands on it). The returning stick's list is empty, so it only ends the stick on arrival and
gives nothing back. `capCooldown(abilityId, ticks)` is the event behind "no more than a
second to wait": it sets a ceiling on what is left of a cooldown, where the refunds only take a share
off. Effects can find their caster's own entities (`SimReader.entitiesOf`, the `ownEntity(defId)`
anchor that Warp blinks to and the recall launches from) and remove them (`removeEntities`). A
straight shot with `stopsAtWalls` ends where its edge meets the arena's wall instead of flying on past
it, running its `onExpire` there; the stick's throw uses it so that the stick always lands somewhere
the Trinketmaster can walk to. It is worked out when the shot is spawned, from where it starts and
which way it points, and only shortens the lifetime.

**Ninja** is a melee skirmisher built around shadow stacks, which sit on himself and are each an
enhanced auto. P: dashing through an enemy with Shadow Step gives him a shadow stack, at most two,
lasting six seconds (refreshed together). Each auto he makes spends one for 60 bonus damage, and so
does Kunai, so a stack is one enhanced auto banked. Q, Shadow Step, dashes 300 px to the aimed point
at 1200 px/s, **through** whoever is in the way, and what it does to them happens as he passes, not when
it is cast: each enemy his body reaches is hurt and slowed (40%) at that moment, wherever it has got
to by then, and the first he reaches also gives him a shadow stack (one, however many he passes),
hands back 75% of Q's cooldown, and leaves a shadow where he was standing when he cast it. While a
shadow is out the key becomes Shadow Return (the ability's `recast`, `requires` an entity `shadow`
out), which dashes back to the shadow from any distance, and does the same for the enemies it
passes, leaving a new shadow where it was cast from, so a chain of dashes goes back and forth
through one enemy and a third finds the stacks already full. A shadow has no timer and is lost only
by a dash back to it that finishes without passing anyone, or when the Ninja dies. Shadow Return has
a one-second cooldown of its own, started when the dash that left the shadow reached its enemy, so
the dash back is not ready the moment the dash forward is over and the chain cannot be spammed. A
miss puts Shadow Step on its whole cooldown from the moment the dash back finishes
(`startCooldown`), so the time that ran while the shadow was out is no help and Q cannot be cast
twice in a row. (The Trinketmaster's stick is deliberately the other way: its cooldown keeps
running while the stick is out, and calling it back leaves it alone.) W, Kunai, is a piercing line shot that hurts and slows every
enemy in its line; if he has a shadow stack, the cast spends one, and the kunai hurts more and roots
instead of slowing. E, Dodge, gives 40% move speed for 1.5 s and makes every auto aimed at him miss
for 1.2 s.

The engine got a few things for this. A dash can be **`through`** (`dash(speed, maxDistance, to, {
through: true })`): the dash on the frame carries the flag, and while it does nothing is pushed
apart from the dasher, where an ordinary dash (Leap, a knockback) shoves the characters in its way
along. A dash can go `toward` an anchor (`ownEntity('shadow')`) instead of the aim, and its
`maxDistance` can be `Infinity`, for a dash that goes all the way.

A dash can also have effects of its own, run as it goes: `dash(..., { on: dashDef })` with a
`DashDef` (`effects.ts`) of `onHit` (for each enemy the dasher's body reaches, with that enemy as the
subject, at the dasher's position), `onConnect` (once, on the first enemy it reaches, at the point the
dash was cast from) and `onMiss` (once, if the dash finishes having reached no one, also at the cast
point). The dash on the frame carries the definition's ID, where it started, the cast it is credited
to, and the enemies it has already reached (`contact`, which is in checkpoints), and the simulator
settles it each tick after everyone has moved (`resolveDashes`): an enemy is reached when the segment
the dasher moved along this tick comes within both bodies' radii of it, so a fast dash cannot skip
over anyone, and it is read where the enemy is on that tick, not where it was when the dash was
ordered. Each enemy is reached once per dash. A dash that is replaced (by a knockback) or ends with
its dasher's death runs no `onMiss`.

`popMarkers(key, to, { count })` takes only that many of a stack, the oldest, where it used to take all
of them, which is how an auto or a Kunai spends one stack of two. `startCooldown(abilityId)` puts an
ability on its whole cooldown from now, whatever was left, where `refundCooldown` and `capCooldown` only
take time off.

**Dodge** is a status (`dodge(ticks)`) that makes an auto aimed at the unit land nothing, whether it is
a swing or a shot arriving. `Champion.attackEffects` is replaced as a whole for a dodging subject:
the swing and its cooldown are spent and a shot is used up, none of the attacker's effects happen (not
the damage, not its own on-hit effects such as a Swordsman's stack), and an ability readied for the
auto (Hush, Shackle) is spent along with it. Dodging an auto is how the Ninja avoids being silenced,
rooted or stunned by one. Abilities are not dodged. The client labels the status `dodging`.

One key doing two things is the ability's `recast`. Stick names `recast: 'recall'`, and `recall` is an
ability in full, with its own cooldown, that the key becomes while it can be cast. What can be cast
is the ability's `requires`: `{ entity: 'stick', out: true }` means only while the caster has a stick
out, so Recall and Warp need one, and Stick (`out: false`) cannot be thrown while one is already
down. Silenced characters are labelled `silenced`.

How a recast gets from the key to the server. Only the client knows which ability a key means; the
server never does, because an order names the ability and not the key (`CastOrderSchema.abilityId`,
"resolved from the slot at click time"). So there is no key-to-ability state to keep in step:

1. The client turns the key press into an ability. `createCastOrder` takes the champion's ability
   for that slot (Stick) and passes it to `abilityOnKey` with the entities in the frame at the
   order's tick. If the `recast` (Recall) has its `requires` met there, that is the ability, and the
   order is built from it: `abilityId: 'recall'`, and a target of whatever Recall's `targeting` is,
   which is none, so it casts on the press. The same `abilityOnKey` decides whether the key needs an
   aim and which cooldown to show, and the client checks the resolved ability's cooldown, `requires`,
   silence and stun, so it does not send an order it knows will be dropped.
2. The order is just a cast order with that ability ID. It goes to the server as any other does.
3. `ServerGameState.acceptOrder` checks the order's tick window and `champion.hasAbility(abilityId)`.
   `hasAbility` is true for the abilities on the champion's keys and for the `recast` of any of
   them, which is the one change on the server's side: a recall is on no key, but it is the
   Trinketmaster's. An ability the champion does not have is rejected as `unknown_ability`. Then
   the order is logged and acknowledged, and it is broadcast to the other players.
4. An acknowledgement only means the order is in the log. Whether it casts is decided by the shared
   `Simulator`, which the server and every client run on the same ordered log. `startCast` checks
   `hasAbility` again, that the caster is alive and not winding up, dashing, stunned or silenced, that
   `meetsRequirement` holds against the entities as the previous frame left them
   (`TickContext.entitiesOf`), that the cooldown of *that ability ID* is up (Recall has its own, so
   Stick being on cooldown does not stop it), that the origin is where the caster is, and that the
   target matches the ability's targeting. If any fails, the order is dropped without spending a
   cooldown, and since every peer runs the same check on the same log, all of them drop it.

So the server does not trust the client's idea of what a key does, and does not need a verdict
message: a modified client can send any ability ID, but only the champion's own are accepted, and the
simulation refuses a recall with no stick out or a second stick with one out. The one thing a client
can get wrong is its prediction. If the stick is picked up between the key press and the order's tick,
the recall is dropped, by the player's own simulation as by everyone else's, since they all derive it
from the same log. As with every predicted order, a late order from another player that changes the
picture (a push that moves the owner onto the stick, say) is handled by the usual replay, which can
make a recall the player saw vanish. `tests/server-game-state.test.ts` pins the server's half, and the
client and simulator tests the rest.

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

A `homing` entity is how an auto's shot works, and an ability can use it too. It is spawned
with a unit aim (`spawnEntity` reads the unit from `aim`), flies at its `speed` and each tick
steps toward where that unit stands now, and only that unit can be hit by it, so it cannot also
`pierce`, `landAtAim` or `follow`. With no `lifetimeTicks` nothing but a hit ends it, and it is also dropped when
the unit dies or leaves the game or when its owner leaves; with one it expires like any other
entity. `homing: 'owner'` chases whoever fired it instead, needing no aim; it is the one kind that
may `pierce`, hitting each enemy it passes once on the way home, and a `pickup` ends it on arrival. Its path bends, so it keeps its latest `position` and heading `velocity` on the entity
like the medic bot does, plus the `targetId` it is chasing, and all three travel in checkpoints.
Unlike the bot, the client draws a shot a fraction of a tick ahead along its heading (the same
trick as the local champion's dash), so it glides at 60 FPS instead of moving in whole-tick steps.

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
| `LOBBY_MAX_PLAYERS` | `8` | Players per lobby, from 1 to 8 |

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
