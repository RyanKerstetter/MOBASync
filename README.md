# 2D MoBA

A small browser lobby and game built with TypeScript, PixiJS, Geckos, Vite, and
a lightweight HTTP server.

## Project structure

- `apps/client` contains the lobby interface and PixiJS game.
- `apps/server` contains the in-memory lobby API and Geckos game server.

The client's game code is split by what it does:

- `game.ts` runs one game: the connection to the server, the player's input, and each frame. It works out
  what to show from `ClientGameState` and hands it on; it draws nothing itself.
- `render/` draws the world with PixiJS and knows nothing of the network or the simulation.
  `WorldRenderer` stacks its layers in a fixed order (the map, the hill and flags, ground effects, the turrets' ranges, indicators,
  the champions and the walls together, carried flags, shots, the darkness of what the team cannot see, the champions' names
  and bars, damage numbers, debug), and each frame it is given a plain
  `WorldFrame` to draw. The ground is a
  `MapView` handed to it: `createGameMap` gives it the Tiled map, or the plain arena floor when there
  is none (see "Maps from Tiled"). The pure layout code the layers draw from (`health-bar.ts`, `stack-pips.ts`,
  `attack-marker.ts`, `status-labels.ts`, `hitboxes.ts`, `depth.ts`) is beside them.
  **Walking behind walls** is a depth sort, not a depth buffer (PixiJS draws back to front and has none for sprites):
  everything that can be in front of or behind a champion has a depth, which is how far down the map it stands
  (`depth.ts`), and the champions' bodies and the map's wall art (`MapView.sorted`) are attached to one `RenderLayer`
  that draws them from the smallest depth up. A champion's depth is where it stands; a wall's is its base, the bottom edge of
  its collision rectangle, which is where it meets the ground and where a champion stops walking up to it from the south, and
  all of that wall's art has it, however many pieces it is (the wall itself, the bits that stick off it). So a champion whose
  middle is above a wall's base is behind it and the wall is drawn over it wherever they overlap, and one below is in front of it.
  The layer only decides when they are drawn: they stay in the scene where they were, so transforms, the camera and clean-up
  are as they were. Names and bars are in a layer of their own over it, so one is never hidden by a wall.
- `ui/` is what is drawn over the canvas as ordinary page elements: the HUD, the game mode's scores, hill bar
  and flags, the scoreboard and killfeed, and the diagnostics overlay, each a `*-view.ts` over its pure logic.

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
Teams can be changed only in the lobby, not once champion select has opened. A team holds at most
four players (`GAME_MAX_TEAM_SIZE`): the server turns a fifth away, and the button of a full team is off.
The leader also picks the game mode from the **Game mode** drop-down (team deathmatch, king of the hill,
capture the flag or core destruction, see "Game modes") and sets the **Game rules** under it: how long a champion stays dead, the
score to win at (the box for the mode that is picked, and only that one), and for king of the hill how long
the hill takes to capture. Everyone sees what is set, and it is fixed once champion select opens.
The lobby leader starts the game for the whole lobby, which first opens champion
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
Right-click the map to issue a movement order, or right-click an enemy to attack it (the left button does nothing).
Holding the right button keeps giving the command, so the champion follows the mouse (or keeps on the enemy under it),
but only every 150 ms (`HOLD_COMMAND_INTERVAL_MS` in `apps/client/src/hold-command.ts`) and only when it would change
something: a walk to within a few units of the last one given is not sent again, and neither is an attack on the enemy
the champion is already after. A walk that was cut short, such as by a cast with a windup, is given again. Opening the
menu, aiming an ability, dying, or letting go of the button (anywhere) stops it.
Space attacks the enemy closest to the mouse cursor, near or far, and not the one closest to your champion (one out of
reach is walked up to, as when it is right-clicked). All are timestamped intents
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
on keeps slightly heavier red ticks for as long as it is (`render/attack-marker.ts`). Neither shows while an ability is
being aimed, since the click would cast it, or while dead.

What is affecting a champion is written in small words above its name (`stunned`, `rooted`, `silenced`,
`blinded`, `burning`, `slowed`, `hasted`, all that apply, the most disabling first; `render/status-labels.ts`), not
drawn as a coloured ring around it.

## The map and the camera

The arena is as big as the `arena` rectangle of the map from Tiled, once drawn (at the usual scale of
three, a rectangle of 803 by 494 pixels is 2409 by 1482), and champions walk anywhere on it that no wall
holds them out of; its edge stops them at their radius. The world's origin is the top left corner of that
rectangle. With no map, a game is on the plain arena (`GAME_ARENA_WIDTH` by `GAME_ARENA_HEIGHT`, 2376 by
1440) with no walls, which is what the tests use. The ground (the arena's size and its walls) is a
`Terrain`, which the simulator holds and every snapshot carries (a few bytes a wall), so a client plays on
exactly the ground the server does.

Where teams start comes from the map's spawn points (see below). The biggest team in a game starts at
the first slot of points, the next biggest at the second, and so on, with a tie going to the team with
the lower number, and a team's players take the points of its slot in the order they are listed in the
lobby (`assignSpawns`, `spawns.ts`). So where a team starts depends on how big the teams are, not on
which colours they picked or who joined first. The server works out the starting places once and sends
them in the snapshot, so no peer works them out for itself.
The floor has a grid so movement across it is visible, when there is no map from Tiled to draw instead.

### Maps from Tiled

The ground can be a map made in [Tiled](https://www.mapeditor.org), and there can be as many as you like: every
`.tmj` in `res/maps` is a map the lobby leader can pick from the **Map** drop-down (see "Choosing a map" below).
The game draws the map the lobby picked in place of the plain floor, and the server reads the same file, for the
arena, the walls, the spawn points and the hill and flags of the game modes, every time a game starts (when the
leader presses Start), so a map exported from Tiled is played on by starting a new game, with no restart of the
server and no reload of the lobby. It will not start a game on a map it cannot play on: the leader is told
everything that is wrong with it (`readMapLayout`) and the lobby stays as it was. A browser that cannot use the
map draws the plain arena floor instead (of the map's size) and says why in the console, and one whose map is not
the one the server played on says so in the console too. The server finds a new map within a second, but the
browser's copy of the map files is bundled into the page when it loads, so a map added later needs a reload under
`npm run dev`, and a rebuild of the client (`npm run build:client`) for a hosted build, before a page can draw it. The shapes of the map's objects are outlined in the debug view (P). `GAME_MAPS_DIR` makes the server
read its maps from another folder than `res/maps`. Nothing else assumes a map: `DEFAULT_MAP_ID` (`competetive`) is
only the map a new lobby starts on, if the server has it (or else the first that can be played on).

### Choosing a map

The server lists every map it has (`MapCatalog`, `apps/server/src/maps.ts`): each `.tmj` in the folder, and each
`.json` that is a map (a tileset saved as `.json` is not listed). A map is only read again when its file changes,
and the folder is looked at once a second at most, so a map saved in Tiled appears in every lobby's list. What the
lobby is told of each (`MapSummary`, `packages/shared/src/maps.ts`) is: its name, a line about it, its size, how
many players each team slot holds, whether it has a hill, and whether it has the flags for the first two teams.
A map that cannot be played on is listed with what is wrong, but cannot be picked.

- **Name and line:** give the map the properties `title` and `description` (text, on the map itself, in Tiled's
  *Map → Map Properties*). With no title the map is named after its file (`duel_arena` is "Duel Arena").
- **The leader picks the map** (`POST /api/lobbies/:code/map`, leader only, while the lobby is idle), and the lobby
  says what it is: its size, which team setups it takes, and which modes it has what they need for.
- **Only modes the map supports can be picked.** King of the hill needs a hill, capture the flag needs a flag for
  each of the first two teams, and core destruction needs a core for each of the first two (`modeSupportProblem`). The others are in the mode list but greyed, with "(not on
  this map)". Picking a map that lacks the selected mode puts the lobby back on team deathmatch and says so; the
  server turns a request for an unsupported mode away, with the reason.
- **The teams have to fit the map** (`teamSetupProblem`). The biggest team starts at the map's first slot of spawn
  points, the next biggest at the second, and so on (a tie to the lower team number), so a map needs a slot for each
  team, and each slot must hold the team that takes it. A lobby that does not fit shows the reason under the mode
  list, in words, and Start is off until it is put right: `Duel has starting places for 2 teams, and there are 3.`,
  or `Blue, the 2nd biggest team, has 3 players, but Tight Quarters only has room for 2 on its 2nd biggest team.`
  Several problems are said together. The server checks the same thing (`startProblem`, one function for the page
  and the server, so they agree) when the leader presses Start, and again when the last player locks in a champion,
  since players leave while champions are picked: a game whose teams no longer fit is called off.

- **Saving:** save the map as JSON (`.tmj`). Tile layers must be stored as CSV or uncompressed
  Base64 (the map's Tile Layer Format; the default is CSV). Maps must be orthogonal, and can be of
  a set size or infinite.
- **Where the files go:** the map, its tilesets (`.tsx` or `.tsj`, or embedded in the map) and their
  pictures must all be somewhere inside `res/maps`. Tiled writes paths from where it found them, so
  a tileset or picture the map names at a path that is not there (in Downloads, say) is found by its
  file name instead, as long as only one file in `res/maps` has it. The game says which file is
  missing if one is.
- **What is drawn:** tile layers (with flips and turns), tiles that are objects, picture layers and
  group layers, with their offsets, opacity and visibility, and the map's background colour. A tile
  larger than the grid sits on the bottom left of its cell, as in Tiled. Not drawn yet: tile
  animations, tints, parallax, and isometric or hexagonal maps.
- **Walls in front of and behind champions:** a tile layer is drawn under the champions, unless it is depth sorted: then it is
  drawn in pieces that are each in front of the champions whose middle is below their sort line and behind those above it, so
  a champion can walk behind a wall and in front of it (see "Walking behind walls" above). A layer is depth sorted if its
  custom property `y-sort` (a boolean) is set, and where it is not set, if its name starts with "wall" (so a layer called
  "Wall Layer" is, with nothing set in Tiled). Set `y-sort` on any other layer that stands up out of the ground (a layer of
  tree tops, say), or to false on a "wall" layer that is only drawn on the ground.
  **The sort line of a wall is the bottom edge of its `wall` rectangle**, whatever tiles it is drawn from or where the
  tiles' rows end, so the rectangles are how you say where each wall stands. A wall's own art is the tiles that overlap its
  rectangle in height and are over it, or up to a tile to either side of it (the bits that stick out of its ends), which takes in
  the lip of its face that hangs a little below the rectangle where an edge is not on a line of the tiles. A tile whose top is at
  or below a rectangle's base is in front of that wall and not part of it. **The bits that stick off a wall without being over its
  rectangle (spikes on top of it) are attached by touching**: a tile that touches (by an edge or a corner) the wall's art has the
  wall's sort line too, so the wall and the bits are over a champion behind it together, however far the bits are from the
  rectangle. How many tiles out that goes is `WALL_ATTACH_TILES` (1), or the layer's custom property `y-sort-attach` (a whole
  number): 0 is the wall's own art alone, and the more there is the further the art of a wall reaches. It is a limit because depth
  is all or nothing where things overlap on screen and has no sense of distance, so a bit that sticks up two tiles covers a champion
  two tiles behind the wall. Where a tile could be two walls' it is the one whose columns it is over before one it is only beside
  (so the lip of a wall's face next to a wall that hangs below it stays the first wall's, and does not take the lower base and
  draw over a champion standing in front of it), then the one whose height its middle is in, then the one with the highest base on
  the page, and a tile that no wall has by either is sorted by the bottom edge of its own row (art with no collision under it, say).
  A tile is drawn whole and has one depth, so one that spans the seam between two walls side by side (the competitive map has two,
  where a wall's south face meets the face of a taller one) takes one of them, and can cover a champion standing in that corner.
  Tiles that are objects are not sorted yet; they are drawn under the champions.
- **Size:** a pixel of the map's art is drawn `GAME_ART_SCALE` (3) world units across, the same as the
  champions' sprites, or whatever the map's own custom property `worldScale` (a float) says.
- **The arena:** one rectangle object of class `arena` covers the ground champions walk on. Its top left
  corner is the world's origin, so the art around it (a rim, say) is drawn at negative positions and past
  the far edges, wherever Tiled put it. Its size is the size of the ground, so it can be changed in Tiled
  and nothing else has to be.
- **Walls:** rectangle objects of class `wall`, in any layer, as many as there are. Champions cannot walk
  through them and walk round them (see "Walls and walking"); nothing else is stopped by them. They must be
  plain rectangles, not turned (other shapes are refused for now), and one the arena does not reach is left
  out. The walls are not drawn: the art is whatever tiles are drawn under them, and the debug view (P)
  outlines the walls, so the two can be lined up.
- **Spawn points:** point objects of class `spawn`, each with a whole-number property `team-name`, the
  slot it is in (1 to 8), and a `spawn-number`, which of the slot's points it is (1, 2, 3 ... with none
  missing). **How many slots, and how many points in each, is what the map allows**: a map has a slot for each
  team it can start, in order from 1 with none skipped, and as many points in each as the team of that rank
  can have players. A map of two slots of four takes two teams of up to four; one with 3, 3 and 2 takes three
  teams, two of up to three and one of two. A map with 4, 4, 2, 2, 1, 1, 1, 1 points (`spawnPointsNeeded`) takes
  every way eight players can split into teams of up to four (the k biggest teams are each at least as big as the
  kth, so the kth has at most 8 / k players), which is what `ffa_arena` has. A map with no points, or that skips a
  slot, is refused. Points are measured from the arena's corner and must be inside it. Two slots can share a
  place when no game can use both points (a game that has a team of two in its fourth slot has no fifth team,
  so the fourth slot's second point and the fifth slot's only point can be the same), but check that first,
  because two champions started on one place push each other apart. A point must have room for the widest
  champion (`GAME_MAX_CHAMPION_RADIUS`, 24) clear of the walls and the arena's edge, and every point must be
  somewhere a champion can walk to from every other, or the map is refused: a team could start shut in.
- **Hill (king of the hill):** at most one object of class `hill`, an ellipse (a circle if it is as wide as
  it is tall) or a plain rectangle, not turned. It is the place that is fought over. A champion is on it
  when its middle is in the shape. A hill that is not at all in the arena is refused. A map with no hill
  is fine, but king of the hill cannot be started on it: the leader is told why. The hill is not drawn
  by the map: the game draws it (and fills it as it is captured), so the art under it is up to you.
- **Flags (capture the flag):** point objects of class `ctf-flag`, each with a whole-number `team-name`: the
  slot of spawn points whose base the flag is at (1 to 8, once each). Slot 1 is where the biggest team in
  a game starts and slot 2 the next biggest (see `assignSpawns`), so the first flag is the biggest team's,
  and capture the flag, which is for two teams, uses the flags of slots 1 and 2. Like a spawn point, a flag
  needs room for a champion clear of the walls and the arena's edge, and a way to it from the spawn points.
  A map with fewer than two flags is fine, but capture the flag cannot be started on it.
- **Cores (core destruction):** point objects of class `core`, each with a whole-number `team-name` (1 to 8, once each): the slot of
  spawn points whose base it is the heart of, as for a flag. Core destruction is for two teams, so it uses the cores of slots 1
  and 2, and a map with both can be played in it; a map with fewer is fine, but the mode cannot be started on it. A core is solid and needs
  room for its size (`CORE.radius`, `cores.ts`) clear of the walls and the arena's edge, and a way to it from the spawn points. The
  core is in a game of that mode only: in the others its point is not used. Put it inside the base the turrets guard, and clear of the
  spawn points and the turrets (below).
- **Room for turrets and cores.** They are solid, and a champion that starts inside one would have to be shoved out of it, so the map is
  refused, with every one that is wrong, if a **spawn point** is nearer a turret or a core than its size and the widest champion's
  (`GAME_MAX_CHAMPION_RADIUS`, 24) put together, or if **a turret or a core overlaps another** of them. The messages say how far apart
  they are and how far they need to be, in the map's own pixels (`spawn-1-1 is too close to core-1: they are 25.6 map pixels apart and
  need 28`). A point too close to a wall or the arena's edge says the nearest place that clears the walls and the edge (`about (60, -288)
  in the map's own pixels`), which may still be too near a spawn point or a turret: that is checked as well. A core is 20 map pixels across from its middle (`CORE.radius`, 60 world units at the default scale of 3), so it cannot sit
  against the arena's edge: its middle has to be at least 20 pixels in.
- **Shops:** rectangles of class `shop`, each with a whole-number `team-name` (1 to 8): the slot of spawn points whose team shops there, as for a flag or a
  core. A champion can buy and sell items only while its middle is in a shop of its team (see "Items and the shop"), so put one over each base, with the
  spawn points in it. They must be plain rectangles, not turned, and at least partly in the arena. **A map with any shop needs one for every slot that has
  spawn points** (a second for the same team is fine): `Slot 2 has spawn points but no shop, so its team could never buy: give a shop the team-name 2.` A
  map with none is fine, and is shopped in from anywhere.
- **Monsters:** point objects of class `monster-spawn`, each with a text property `monster-type` naming one of the
  game's monsters (`slime`, `golem` or `wolf`, see "Monsters"; `monester-type`, as the competitive map spells it, is read
  too). The monster is in the game from the start, at its point, which is its home. A point needs room for that
  monster's size clear of the walls and the arena's edge, and one with no `monster-type` is refused. A point naming
  a monster the game does not have yet is left out, and the server logs a warning saying which, when a game starts
  on the map, so a map can hold places for monsters that are still to come. A map with none has none, and every
  mode has the map's monsters.
- **Turrets:** point objects of class `turret`, each with a whole-number `team-name` (1 to 8) and a whole-number
  `turret-tier` (see "Turrets"). Like a flag, the `team-name` is the slot of spawn points the turret belongs to: the
  biggest team in a game is at slot 1, so the turrets of slot 1 are its, and every other team is their enemy. A
  game with no team at a slot has no turrets for it. A point needs room for its tier's size clear of the walls and
  the arena's edge, and one with no `team-name` or no `turret-tier` is refused. A point for a tier the game does not
  have yet is left out, with a warning, like a monster's. A map with none has none, and every mode has the map's turrets.

The Tiled file is read by `parseTiledMap` in `packages/shared/src/tiled.ts`, which is only parsing and
arithmetic, so the server uses it too: `readMapLayout` (`map-layout.ts`) takes the arena, the walls, the
spawn points, the hill and the flags from it, and `apps/server/src/map.ts` loads the file. What draws it is
in `apps/client/src/render`: `tiled-assets.ts` finds the files (Vite gives each its address, in
development and in a build, and `.tsx` tilesets are read as text because Vite takes them for
TypeScript), `tiled-loader.ts` loads a map and its pictures, and `TiledMapView` draws it as a
`MapView`. Each tile layer is drawn once onto a canvas just big enough for its tiles and shown as
one picture, so there are no hairline gaps between tiles at any zoom.

## Walls and walking

Walls hold champions out while they walk, and that is all they do: attacks, abilities, shots, dashes,
blinks and knockbacks all go over them, and so does attacking a target across one that is in reach.
They are baked into the map, so they never change in a game and are not in the simulation's frames, so
rollback has nothing to undo. `Terrain` (`terrain.ts`) is the ground, and the simulator asks it three
things:

- `clamp(position, radius)` holds a body inside the arena. It is all that holds a dash, a shot or the
  medic bot, which go over walls.
- `resolve(position, radius)` is where a body can stand nearest to a point: clamped, and pushed out of any
  wall. It is how a click, a respawn, a blink and the end of a dash are made to land somewhere a champion
  can be, and `keepOutOfWalls` is the push alone. A circle is pushed out of a rectangle by the shortest way,
  along the line from the rectangle's nearest point, so it goes round a corner on a curve, and one whose
  centre is inside leaves by the nearest side that is still inside the arena and clear of the other walls. Where
  another wall is against that side (a narrow wall hanging from a wide one's south face, or two that meet), the
  point straight out can be inside it, so it leaves by the nearest point on the free part of any wall's edge
  (`nearestFree`, `exits.ts`): a step along the face, and not round to the far side of the wall. Every tick a walker is pushed
  out of any wall it stepped into, so the part of its step along the wall is kept and it slides; characters
  pushed by others are held out of walls too (the wall wins, and the pair overlap a little). A character
  that is dashing is not, so a dash can be inside a wall on the way, but it lands outside.
- `path(from, to, radius)` is the way round walls, below.

A walk is a move order, or a chase (an attack order on someone out of reach, which walks toward them each
tick and swings when they are in reach, wall or no wall). Each tick a walker asks for the path from where
it is to where it is going and heads for the first point of it, so nothing about the path is kept in the
frame, a new order or a moved target simply changes the answer, and a late order recomputes the same
frames. A click inside a wall walks to the nearest place a champion can stand, and a target that no way
leads to (walled in) leaves the champion where it is.

### Pathfinding

How a body finds its way is a `Pathfinder` (`pathfinding.ts`): given where it is, where it is going and its
radius, the points to walk through, in order (straight between them never touches a wall), empty when it is
already there, `undefined` when there is no way. It must be a pure function of its arguments and the
walls, because it is part of the simulation, and every peer must use the same one. `Terrain` is built with a
`PathfinderFactory` (`new Terrain(arena, walls, factory)`, the visibility graph by default), so another
method is a function that takes the walls and gives back a pathfinder, and nothing else changes.
`tests/pathfinder-contract.ts` is what any pathfinder has to pass (`pathfinderContract(name, factory)`).

The visibility graph (`visibility-graph.ts`) is the string pulled tight round the walls. Each wall is
grown by the body's radius so the body can be a point, the graph's nodes are the corners of the grown walls
(a pixel out, so a body at one is clear of the wall), and two nodes are joined when the straight line
between them does not go through a wall. The start and the target are joined to the nodes they can see
and the shortest way through the graph is taken (Dijkstra, the lowest node first on a tie, so peers agree).
A clear line is one straight segment and costs a handful of checks. The graph is built once for each
radius, the first time one is asked for. It grows with the square of the number of corners, so it suits
maps of a few dozen walls; a bigger map wants a navigation mesh, which is another factory. A body that is
touching a wall round a corner is inside the square the grown wall makes, so it first steps out of it,
and a target in a wall is moved to the nearest place outside it.

In the debug view (P) the path of the champion you control is drawn as a yellow line through its points.

## Vision

What the local player's team can see. The page darkens what it cannot, so the edge of what is seen is plain, and leaves
out what stands in the dark: an enemy, a monster or an enemy's shot is drawn only where the team can see it, and a click, Space
or a unit-aimed ability cannot pick one that is not seen. The map under the darkness is still drawn, dimmed.

**The rules, as they are now.** Vision is the team's: every living champion of the local team sees `GAME_VISION_RANGE` (500
world units: a little under half the screen's height, so the edge of what is seen shows on every side), and they see together,
so a teammate's view is yours. So does every standing **turret** of the team, as far as its tier's `visionRange` (see "Turrets"):
it lights what is round it, behind the walls' shadows like a champion, whether or not a champion of the team is near, and a
destroyed one sees nothing. Walls block sight (the map's `wall` rectangles, as they block walking). A champion, monster or
shot is seen if its middle or any of the four furthest points of its body is; the team's own champions and turrets and what
they put out are always drawn. A team with no champion alive sees the whole game until one is back (its turrets add to what
a team sees, they do not keep a dead player in the dark), and the debug view (P) shows everything too. The page's address can say `?vision=range` (only how far a champion sees, with no shadows behind walls) or `?vision=off`.

**It is how the page looks, not a rule of the game.** Every client plays the whole game from every order the server sends
everyone (that is how rollback works), so each already has everyone's position; the server hides nothing, and a changed
client could show it all. Hiding things from clients would be a different netcode. What the page does with vision is
`TeamVision` (`team-vision.ts`: whom it looks from, what it leaves out of the frame, what `ClientGameState.setSight` lets a click
pick) and `FogLayer` (`render/fog-layer.ts`: the darkness).

**How it is worked out is a `VisionSystem`, and one can be swapped for another** (`vision.ts`). A system is given the ground
(its size and walls: a `Terrain` is one) and `see(viewers)` is asked for what the viewers see together: a `VisionView` that says
whether a point is seen (`canSee`) and a `VisionMask`, the picture the darkness is drawn from. The same shape as the
pathfinder. To try another way of working it out:

1. Write a `VisionFactory` (`(ground) => VisionSystem`) and add it to `visionSystems` (`vision-systems.ts`).
2. Run the page with `?vision=<its name>`; `DEFAULT_VISION_SYSTEM` is what the page uses when it says nothing.
3. Run `visionContract('name', factory, { blocksSight })` (`tests/vision-contract.ts`) on it: what any system has to do, and the
   tests of walls if it blocks sight on them.

A mask is a grid of cells (`kind: 'cells'`, each `cell` world units across, a 1 for seen) that the page draws stretched and
smoothed, so any system can draw its view into cells as fine as it likes. Another kind of picture (polygons) is another member
of the `VisionMask` type and a branch in `FogLayer`, which the compiler asks for. A system with its own `revision` counter
(it goes up when the mask changes) spares the page an upload on every frame.

**The default is symmetric shadowcasting on a fine grid** (`shadowcast-vision.ts`). From each viewer's cell the grid is
swept outward a row at a time in four quadrants, with a window of slopes that is still open: a wall cuts the window, so what is
behind it is never reached. A cell is seen if its middle is in the window, which makes it symmetric (if A sees B, B sees A: a
test checks it on the competitive map). The slopes are fractions of whole numbers and are compared by multiplying across, so there
is no trig and no rounding, and every machine gets the same answer (a system like that could be used by rules one day).

The grid is 8 pixels of the map's art (`SHADOWCAST_CELL`, 24 world units), finer than the 16 pixel tiles because the walls sit on
8 pixel lines (the competitive map is laid out on them, from the arena's corner, so the grid starts at the world's origin and its
lines are the map's). A wall is the cells whose middle is inside its rectangle, so each edge is rounded to the nearest line of the
grid: an edge that is on a line is exact (83 of the competitive map's 104 are, and the rest are 1 or 2 pixels off, bar two at 4),
and one that is not is up to 12 units off, which is where a map is not laid out on the grid (`ffa_arena`'s four walls are 7 units
off on average). A sweep is a few hundred cells, so a team of eight moving every frame costs about a tenth of a millisecond,
and a viewer that stays in the same cells costs nothing (the mask has the same `revision`). A test checks it against a straight line drawn between 8,000 random pairs of points, for every pair the line
clearly clears or clearly goes through a wall. A viewer a little inside a wall (a dash can leave one there) sees from the nearest
cell that is not. `?vision=range` is the same code with the walls left out.

**The darkness is smoothed when it is drawn, not when it is worked out** (`FogPicture`, `render/fog.ts`). Drawn as it is, the edge of
what is seen goes in steps a cell wide, and on a cell of 24 units a circle looks like a staircase. So the mask is blurred a
little (each cell a quarter of each neighbour and half of itself, along and down, twice), made two pixels to the cell, and
sharpened again between 0.3 and 0.7 of the blurred value: the edge is where that is a half, a smooth curve through the middle of
the steps, about two thirds of a cell from nearly dark to nearly clear. On a circle of 20 cells the edge is 0.35 of a cell out of
true at the most, where the steps alone are 0.8 out, and it is in the same place on average, so the picture shows as much as the mask
says. It costs about half a millisecond when a viewer crosses a cell, and nothing otherwise. Two things it does not do: a sliver of
light one cell wide is dimmed almost to nothing (two cells show, three are clear), and the edge still moves a cell at a time as a
viewer crosses cells, though it is no longer jagged. What a click can pick, and what is drawn, go by the mask itself and not the
smoothed picture. A finer grid would be smoother still, at about three times the cost for half the cell
(`createShadowcastVision(ground, { cell })`), and a system that works out polygons could be smooth to start with.

**What is out of sight is kept, not drawn.** A character the team cannot see is left out of the frame (`WorldFrame.characters`) but
handed on as `unseen`, and its body is kept and updated, hidden: so what it is doing carries on out of sight, and a monster that died
out of sight (or while you were away) is already gone, or lying down if it died just now, when you see it, and does not die again. (A body taken away when it went
into the dark would be made again from its first frame when it came back, which is how a corpse used to melt a second time.)

**Not here yet**: brush and other tile-painted hiding places (they are cells that block, so the grid is ready for them),
wards as places that see, a range for each champion (`SightViewer` already has one each; the page gives every
champion `GAME_VISION_RANGE`, and every turret its tier's), monsters that notice only what they can see, rules that turn away an order aimed at what is not seen,
and things fading in and out at the edge of the light instead of appearing.

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
champion you control, since a green fill no longer tells you which it is. Right-clicking a teammate (which just walks there), the
Space key, and an ability aimed at a unit never pick a teammate, and the lobby shows
each player's team by colour and name. Champion select lists who is picking what grouped by team, a heading in
the team's colour over each group.

## Game modes

A new lobby starts on the default map (`competetive`) in the default mode, **Core Destruction** (`DEFAULT_GAME_MODE`), when that map can be
played in it, which `startingMode` works out; if not (a map with no cores, or none that can be played on) it starts in team deathmatch. Team
deathmatch is also `FALLBACK_GAME_MODE`: what a lobby is put back on when its leader picks a map that cannot be played in the mode it had, and
what a game is when it is given no mode. (Core Destruction needs exactly two teams, so a lobby of one player says so and cannot start until
there are two teams or another mode is picked.)

The lobby leader picks the mode (`GAME_MODES` in `packages/shared/src/modes.ts`) and the server keeps it on
the lobby (`POST /api/lobbies/:code/mode`, leader only, while the lobby is idle). Starting a game checks that the
mode can be played (`modeStartProblem`): the server turns a start away with the reason, and the lobby says
the same so the leader knows before pressing Start (capture the flag shows what is wrong under the
drop-down, and Start is off until it is put right). Every mode keeps the kill counts and the leaderboard.

**Only Core Destruction has an economy** (`GameModeDef.economy`, `modeHasEconomy`): experience and levels, gold and the shop, and shards (see
"Resources and levels"). In team deathmatch, king of the hill and capture the flag **a kill is a kill on the scoreboard and nothing else**: it pays
no experience, gold or shards (and nor does anything else, a monster included), nobody starts with gold, every champion is level 1 all game, and an
order to buy or sell is nothing. The simulator decides it (`Simulator.hasEconomy`, from the mode it was given), so every peer agrees, and the page
leaves out the two side panels of the HUD (the level and stats, and the items and shops) and does not open the shop. To give another mode an economy, set
`economy: true` on its entry in `GAME_MODES`.

- **Team Deathmatch** (the mode every map can be played in): a team's score is the kills its players have made. The kills are kept in
  the frame (`ObjectiveState`, scored on the tick of the kill, to the killer's team), not added up from the
  characters, so a team keeps its kills when a player goes back to the lobby.
- **King of the Hill:** the team with more living players on the hill than any other team fills the hill's bar
  for itself, one tick's worth a tick, however many more it has. How long that takes from empty to full is the
  leader's to set (**Seconds to capture the hill**, 1 to 120, ten by default; `captureTicks` in the setup,
  `GAME_HILL_CAPTURE_TICKS` is the default). The bar goes up for the team that leads (`hillMovement`), whether it
  is empty, that team's own, or full. It goes **down** when it is another team's and some team has more
  players on the hill than the bar's team has, *even if the teams outnumbering it are level with each other*, so
  a team that has left the hill to two rivals, or is outnumbered by a crowd of them, loses its bar to nothing
  while they fight: it does not freeze, and an empty bar fills only for a team that has the lead. Equal numbers
  with the bar's team, or nobody on the hill, leave the bar as it is, and the dead do not count. A team
  *holds* the hill while its bar is full, and scores a point every second (`GAME_HILL_POINT_TICKS`) for as
  long as it does, so a tie with the holder leaves it held and scoring, and the points stop the moment the
  bar drops from full.
- **Capture the Flag:** for exactly two teams. Each team has a flag at its base, on the map's flag of the slot
  the team starts at. A champion that walks up to the other team's flag (within `GAME_FLAG_RADIUS` and
  its own radius) picks it up, whether it is at its base or on the ground, and carries it. Carrying it to its
  own team's base turns it in, for a point for its team, and the flag goes back to its base, **but only
  while its team's own flag is at its base**: if the own flag is out (carried, or dropped), the carrier
  keeps carrying and nothing scores until it is back. A carrier that dies (or leaves) drops the flag
  where it was, and it stays there until a living champion of the flag's own team walks over it, which sends
  it back to its base, or an enemy picks it up again. A flag does not go home by itself, and only a champion of
  its own team returns it.
- **Core Destruction:** for exactly two teams. Each team has a **core** at its base (see "Cores", below), on the map's core of the slot the
  team starts at, guarded by its turrets. Break the enemy core, and that team **cannot respawn**: a player who dies stays dead, and
  one who was already waiting to come back does not. Take down every player left on it and it is out, and the last team that is not
  out wins. There is no score limit, and no box for one in the lobby: the game ends when a team is. A team is *out* when its core is
  broken and none of its players is alive; a team whose core stands is never out, however many of its players are dead, since they
  come back. (Should the last players of the two teams go down on the same tick, no one has won and the game goes on with no one in
  it until the leader ends it.) The score each team shows is how many cores of the other team it has broken, 1 or 0.

**Winning.** The leader sets the score a team wins at for each mode but core destruction (`Kills to win`, `Points to win`,
`Captures to win`; defaults 25, 100 and 3; 0 is no limit, and a game with none goes on until the leader ends it). The server checks
the score as the commit tick has it, which no late order can still change, so no one is told of a win that is then
taken back (`winningTeam`, in `ServerGameState.advanceTick`). The team that has reached the limit and is ahead of
every other wins; two teams that reach it level play on until one is ahead. The score each team is playing to is in
the title of the mode's panel on screen (`TEAM DEATHMATCH · FIRST TO 25 KILLS`). Core destruction is won by being the last team out
of the game (`winningTeam` reads who is out from the objective), checked at the commit tick in the same way.

**Respawn time** is a rule too (1 to 60 seconds, three by default). It is part of the setup the snapshot carries
(`respawnTicks`), so every peer brings a champion back on the same tick, and a champion that is dead sees
`Respawning in 8s` where its health was.

### Playing a game through, and going back to the lobby

A game is `running` until a team wins or the leader ends it, and then `finished`: it stops running, and the server
sends everyone still in it the result (`game:ended`, a `GameResult`: how it ended, each team's score, each player's
kills, marking those who had left). Their game stops taking orders and a results screen
(`ui/results-view.ts`, from `ui/results.ts`) shows **Victory** or **Defeat** (or the winner's name to a player on no
team) with the scores and a **Return to lobby** button. The result is also kept on the lobby (`lastResult`) and shown
to everyone in it until the next game starts. A game the leader ended (`reason: 'ended'`) has no results screen: see
**End game** below.

Going back to the lobby does not leave it. **Escape → Leave game** (or **Return to lobby** on the results) takes the
player back to the lobby page (`POST /api/lobbies/:code/leave-game`) and the game goes on without them: their
champion is taken out of it (a flag it carried is dropped), their kills stay on the results, and the lobby shows who is
still `In game` and how many are playing. A game that has begun and has no one left in it **shuts down**, whether it
was running or over, and the lobby can start another. A player who left cannot rejoin that game.

The leader's **End game** button in the lobby (`POST /api/lobbies/:code/end`) ends a running game for everyone, with the
score as it stands (the team ahead wins, if one is, and that is kept on the lobby as the last result). Its point is to
get everyone back in the lobby so another game can start, so the server shuts the game down at once (it never sits in
`finished`) and sends `game:ended` with `reason: 'ended'`, which makes each player's client skip the results screen and
go straight back to the lobby ("The leader ended the game."). On a game that is already over (a team reached the limit)
the button reads **Close game** and shuts it down, sending anyone still looking at the results back to the lobby.
Players who close their tab or leave the lobby leave the game the same way.

How a game of a mode is played out is `advanceObjective` (`modes.ts`), plain whole-number arithmetic on the
hill's bar, the flags and the cores, run by the simulator at the end of every tick it computes (so after the tick's
deaths and blinks). Its state is in the frame (`GameFrame.objective`: for the hill the team whose bar it is,
how full it is and the points, for capture the flag where each flag is, who carries it, and the points, and for core destruction
which teams' cores are broken and which teams are out),
so, like everything else in a frame, it is recomputed when a late order changes who was where, it is in
every snapshot's checkpoint, and every peer agrees on it. What the mode is played on, which cannot change
during the game (the hill's shape, or each team's flag base), is the snapshot's `mode` (`ModeSetup`), worked out
by the server when the game starts (`createModeSetup`): the flag of the first team in `rankTeams` order (the
biggest, a tie to the lower number) is the first flag of the map. A snapshot with no `mode` is team deathmatch.
If players leave champion select and the mode cannot be played by whoever is left (capture the flag down to
one team), the start is called off and the lobby is back to being a lobby.

What the players see: the top middle of the screen (`ui/mode-hud.ts`, `mode-hud-view.ts`) names the mode and
shows each team's score, highest first with the local player's team marked; on the hill, the bar in the colour
of the team whose it is, with who is capturing, pushing back or holding it (and that it is contested); in
capture the flag, a card for each flag (at base, dropped, or carried by whom, in the carrier's team colour)
and a hint to the local player (bring the flag home, your own flag is out, return your dropped flag); in core destruction, a row
for each team's core instead of the scores, with its health in the team's colour and in words how it stands (`Protected by
turrets`, its health, `Core broken · 2 players left`, `Eliminated`), and a hint to the local player (their own core is down, so
they cannot respawn; or the enemy's is, so take down every player left). A dead player whose team has lost its core sees
`Out of the game: your core is down` where the respawn countdown was. On the
map (`render/objective-layer.ts`) the hill is outlined and filled from its middle by the share captured, with the
share written over it, flickering while contested and with a heavy outline once it is held; the flags stand on a
ring at their bases, a dropped flag lies on the ground with a pulsing ring, and a carried flag is held at the
carrier's side over it, with a ring in the flag's colour round the carrier. `ClientGameState.getModeView`
makes all of it from the frame being drawn.

## Monsters

Monsters are characters the game plays itself, to be fought: camps to clear, bosses, whatever the game needs. There
are three so far:

- **Slime** (`slime`): small, slow and soft, in the pockets beside the competitive map's lane. It notices no one, but
  goes after whoever hurts it, from however far, bumps them for a little damage once a cooldown, and goes home once
  it has been drawn too far from where it spawned. It is slower than every champion, so it can be walked away from, and
  it comes back 30 seconds after it dies.
- **Golem** (`golem`): a huge, slow lump of rock in a notch of the wall on each side of the competitive map's middle.
  It has five times a slime's health and four times its damage, but strikes only once every 2.5 seconds, after a
  windup of 0.7 seconds in which it rises up and leaps, and it comes back a minute after it dies. It chases by the
  way round the walls, like anyone, so a player who stands where it can be seen but not reached through the wall
  has it walking the long way round.
- **Wolf** (`wolf`): a placeholder to build on, which no map has yet.

Everything that makes a monster what it is, to be tuned, is its entry in `monsters.ts`, with times written in
seconds: how near a player must come for it to chase (`aggroRange`), how far from its spawn it goes before it gives up (`deaggroRange`),
its damage, how long until it can hit again and its health (the `base` stats: `base: { maxHp: 300, attackDamage: 10, attackSpeed: attackEvery(1.5) }`,
where `attackEvery(1.5)` is once every 1.5 seconds, to the tick), how near it must be to hit (`attackRange`), the windup before a hit
lands and its speed.

**What a monster is** (`monsters.ts`). A `Monster` is a champion (health, an attack, abilities, a size: the simulator
plays it with the same combat code as a player's champion, so everything abilities can do, they can do to a monster and
a monster can do) plus an `AiProfile`. Abilities are defined with the rest in `abilities.ts`, listed on the monster's
`abilities`, and used by its profile. Monsters are in their own registry (`monsters`), not `champions`, so they are not
on the champion select screen; ids are shared, so a monster cannot have a champion's.

**The AI profile** (`AiProfileDef`):

| Field | Meaning |
| --- | --- |
| `aggroRange` | An idle monster goes after the nearest player this near (by the walk, round any walls). 0 notices no one, and only fights back. |
| `deaggroRange` | How far from its home (where it spawned) it will go: how far it would have to walk to get back to the spawn, round any walls and not the straight line through them, which does not move. While the monster is outside it, its deaggro bar fills, wherever the one it is after is. Default 1.5 × aggro, so a monster with no aggro range has to say. |
| `deaggroTicks` | How long, in ticks (write `seconds(3)`), the bar takes to fill while the monster is outside its deaggro range (default 3 seconds). When it is full the monster ignores everyone and goes home. |
| `deaggroRecovery` | How much the bar empties each tick while the monster is back inside the range (default 1: as fast as it filled). |
| `abilities` | Rules for what it casts in a fight, best first: an ability, `withinRange` of the target (else the ability's own range, else its attack range) and optionally `belowHealth` (a share, for an ability it keeps for when it is hurt). The first rule that can be cast is, when it is free to act. |
| `respawnTicks` | How long after dying it comes back at home with full health. Without it, it does not. |
| `resetOnReturn` | Healed to full (and cleansed) when it gets home after giving up. Default yes. |
| `aggroOnHit` | An idle monster goes after whoever hurts it, from however far they hit it, if there is any way to them. Default yes. |
| `homeRadius` | How near home counts as home (default 30). |

**How it behaves** (`think`, `ai.ts`). A monster is *idle* (at home), *chasing* or *returning*:

- Idle, it notices the nearest living enemy in its aggro range, or goes after whoever hurt it from wherever they did
  (if there is a way to them), and starts a chase. If something pushes it off its post it walks back.
- Chasing, it gives its attack order, and the simulator's attack lock does the rest: it walks up to its target and
  strikes it again and again, round walls. It keeps the same target while it can, uses its abilities when its rules say
  (an ability with a windup stops the attack lock, so it puts it back afterwards), and gives up at once when the
  target dies (taking the nearest player in its aggro range instead, if there is one). Its deaggro range is the walk
  home: while the monster is outside it, its **deaggro bar** fills a tick at a time (and it does while there
  is no way to its target, which is a chase going nowhere), and while it is inside the bar empties. When the bar is
  full, it ignores everyone and goes home. There is no other limit on how far it is drawn.
- Returning, it walks home paying no attention to anyone, so it cannot be kited back and forth. A monster whose bar
  filled keeps it full on the way. At home it is healed and idle again.

The walk to someone is `Terrain.walkDistance`, the length of the pathfinder's route. Only someone within the aggro range in
a straight line can be within it on foot, so the pathfinder is asked only about those, and a clear line is answered
without searching. It is also asked once for the one a monster is after, or hurt by, to see that there is a way to them,
and, for a monster that is after someone and within its deaggro range of home in a line, for the way back home.

**It runs inside the simulation**, not beside it. `think` is a pure function of what a monster can see (the frame: where
everyone is, health, cooldowns, what it was doing), and the simulator calls it for every monster on every tick it
computes, turning what it decides into the same orders a player gives (move, attack, cast, with ids like
`ai:10:482:0`). So the server and every client work out the same monsters with nothing sent about them (only the `ai`
state in a monster's frame: its mode, target and deaggro bar, which the frame keeps because they cannot be worked out from the rest),
a late order that changes who was where plays the monsters out again from that tick, and a snapshot carries them. The rule
that follows: **a monster's choices may depend only on what is in its arguments**. No random numbers, no clock, no
iteration order that is not by ID. If a monster needs a variety of choices, derive it from the tick and the IDs.

**What a monster is not.** All monsters are on one team (`GAME_MONSTER_TEAM`, 9): enemies of every player, teammates of
each other, so a blast from one never hurts another. The team is no team of the game: monsters have no score, are not on
the leaderboard or the results, stand on the hill and walk over flags without taking either, and a game with only monsters
left is not a game with players in it. A player's `kills` are kills of players, and so are a team's in team
deathmatch, so killing a monster, or being killed by one, scores for no one: the death still reaches `onDeathConfirmed`
(the killfeed shows "Alice defeated Wolf"), with the victim and killer to look up, for whatever the game decides it is
worth.

**On the page.** Monsters are named and drawn like champions (from the sprites in `champion-sprites.ts` under the
monster's id, or as a circle in the monsters' colour without), can be right-clicked and attacked, and are what Space
attacks if they are the enemy nearest the cursor. The slime's and the golem's art (`res/monsters`) is drawn facing four
ways, a row of each sheet for each: a set with `directions` (which row is down, up, left and right) turns to the way the
character is going, and to what it attacks, instead of being flipped. Going corner-wise it keeps the way it faces
until the other is clearly more of the step (`DIAGONAL_BIAS`), and like the flip it only turns once it has gone
`TURN_DISTANCE` the new way, so a wobble does not turn it. It idles facing down, toward the player. A figure that
stands taller than its body is wide (the golem) says how far up it reaches (`top` in its set), and its name and health
bar are put over that, not over its radius. A monster that is losing interest has a **deaggro bar** under its health bar: amber
as it fills, red when it is full and the monster is on its way home (`layoutDeaggroBar`). It is not drawn when the bar is
empty, or for a dead monster. The debug view (P) draws each monster's aggro range (yellow) round it, and its deaggro range
(orange) round its home, which is marked. The circles are straight-line distances, but both ranges are walks, so past a
wall a circle shows further than the monster goes: a monster on the far side of a wall can be inside the orange circle
and still out of its range, if the way back round is long.

**When a monster dies** its nameplate (its name, health bar and the bars under it) is gone at once, its death animation plays and it lies where
it fell, and after `CORPSE_SECONDS` (2, from the tick it died on) its body is gone as well (`layoutCorpse`, `render/corpse.ts`). It is drawn again,
whole, when it respawns. The page works out how long it has been dead from the tick it died on (`RenderedCharacter.deadForSeconds`), so a monster
that died out of sight, or before you arrived, is already gone when you look. A player's champion is not a corpse: it stays as a ghost until it
respawns, and a structure that is destroyed is gone at once (see "Structures"). `tests/corpse.test.ts` covers it.

**To add one:** write its abilities in `abilities.ts` if it has new ones, add a `Monster` to the list in `monsters.ts`, give
it a sprite set in `champion-sprites.ts`, and put a `monster-spawn` point with its id as the `monster-type` on a map. `tests/ai.test.ts` is `think` on its own (aggro, targets, deaggro,
abilities, returning), `tests/monsters.test.ts` is monsters in a simulator (fights, going home, respawning, rolling back,
snapshots), and `defineMonster` in `tests/fixtures.ts` registers one for a test.

**Not here yet**, where a game would want it: monsters in a camp helping each other (a hit on one aggros the others),
patrols or wandering, target choices other than the nearest, the AI telling players what it is about to do, loot
beyond the resources a kill pays (below), and a lobby switch for whether a game has monsters. They would go in `think` (new fields in the
profile and in `AiState`) and in `thinkMonsters` in `simulator.ts`, which gathers what `think` sees.

### Monsters level up

In a game with an economy (Core Destruction), **a monster gains a level each time it is killed**, so it comes back stronger, and pays more:

- **Its level** is in its frame (`GameFrameCharacter.level`, absent is level 1), so it is rolled back with the frame and carried in a snapshot. It goes up
  when the monster respawns (`respawnCharacter`), by `monsterLevelAfterKill` in `progression.ts`: a kill is one level. A monster with no `respawnTicks` does
  not come back, so it does not level. In a mode with no economy a monster stays level 1.
- **Its stats** are `Champion.statsAt(level)` like a champion's: its `base` plus its `growth` for each level above the first, so they rise in a straight
  line. A monster says its own growth in its entry (`growth: { maxHp: 40, attackDamage: 2 }` for the slime), and comes back at the full health of its new level.
- **Its experience** is `monsterXpAt(baseXp, xpGrowth, level)` (in `progression.ts`: the one place that says how it scales): its `reward.xp` at level 1 plus
  `xpGrowth` more for each level after, also a straight line. `MonsterDef.xpGrowth` is a whole number (default `DEFAULT_MONSTER_XP_GROWTH`, 10; the
  slime has 10 and the golem 25). It pays the experience of the level it died at.
- **Its gold and its shards** are the same at every level.

## Turrets

A turret is a structure the map puts on the ground. It stands where it is put for the whole game, belongs to a team, and
shoots the enemy players who come within its range: it is attackable by every other team, and kills what it shoots if it is
left alone. It is a champion that cannot move (`turrets.ts`), so the same combat code plays it, but it is a **structure** (see
"Structures", below): only an attack hurts it, and it is protected until the turret below it has fallen.

**Tiers.** What a turret is, is its tier, and every number that makes one what it is lives in the `TURRET_TIERS` table in
`turrets.ts`, one entry for each tier, with times in ticks (60 a second) and distances in world units (a champion is about 40 across):

| Field | What it is |
| --- | --- |
| `base` | `maxHp`, `attackDamage`, `attackSpeed` (shots a second), and `resistance` (`x / (100 + x)` off every hit it takes, as for a champion: 100 takes half) |
| `radius` | How big it is, to hit and to walk into |
| `attackRange` | How far it reaches, from its middle to the middle of whoever it shoots, and the radius of the circle drawn round it |
| `visionRange` | How far its team sees from it, round any walls (see "Vision"). Leave it out for as far as a champion sees, `GAME_VISION_RANGE` |
| `attackWindupTicks` | How long after it starts to shoot until the shot leaves |
| `attackProjectile` | The bolt it fires: `speed`, `radius` and `color`. Leave it out for a hit that lands as the windup ends |
| `reward` | What the player who destroys it is paid: `gold`, `xp` and `shards`, each a whole number. What it leaves out is `DEFAULT_TURRET_REWARD` |

A tier is tuned by changing its entry, and a new one is a new entry; the map says which tier each of its turrets is. A tier has no
name or description to set: it is called `Tier <n> Turret`, which is only said where something has to say what it is (the killfeed,
a map with no room for one), and nothing is written over a turret in the game. The two tiers there are, 1 and 2, are numbers to tune.
The map's `turret-tier` of a
tier that is not in the table is left out of the game with a warning in the server log, so a map can keep places for tiers still to
come. A turret never levels, so a tier has no growth. The id of its body is `turret-<tier>`, which is what a snapshot says it is, and
turrets are in a registry of their own (`turrets`), so no one can pick one in champion select.

**What it does.** Every tick (`thinkTurrets` in `simulator.ts`, which reads only the frame, so every peer works out the same
shots and nothing about a turret is sent) each living turret chooses a target with `chooseTurretTarget`:

- It shoots enemy **players** only. It never targets a monster or another turret, no monster goes after a turret, and a turret does not shoot its own team.
- It keeps the player it is shooting for as long as they are alive and in its range, even if another is nearer. When they die or
  walk out of its range, it takes the nearest player in its range (the lowest id if two are as near), or none.
- Range is measured from the turret's middle to the player's middle, the same way every auto attack in the game is, so the circle
  drawn round it is exactly where it stops. A player on the edge is in it.
- It cannot chase: a target that walks out of its range is dropped on that tick, and a shot not yet away is called off.
- It shoots with the same attack as any champion: a windup, a hit (or a bolt that homes on arrival) for its `attackDamage`, and a
  cooldown from its `attackSpeed`. It cannot be stunned, so nothing stops it shooting, and it shoots while it is protected too.

**Being destroyed.** It has health and resistance like any champion, and is hurt by auto attacks (whether a swing or a shot) and
nothing else. When it is destroyed it stays destroyed (it never respawns, and
is not drawn), is no longer solid, and pays its `reward` to the player who did it (the shards when the kill can no longer
be undone, the experience and the gold on the tick, as for a monster). Destroying a turret is not a kill on the scoreboard and scores nothing for a
team, and a turret that kills a player is paid nothing and scores nothing for its team: only players score.

**Solid, and fixed.** Living characters are solid, and a turret is too, but it does not give way: a player walking into one is
held off and takes the whole push, and a knockback, a pull or a dash aimed at it does not move it. The pathfinder does not
know about turrets, so a walk that goes straight through one slides round it, as it does round another champion. Mind the room
round them in the map: a champion needs about 48 clear between the turret and a wall to get by.

**On screen.** A turret is drawn as a dark ring edged in its team's colour, with a core of that colour, and its health bar over it
(no name). Round it is a **transparent circle** out to the end of its range (`TurretRangeLayer`, `turret-range.ts`): only a thin line
in its team's colour, very faint (`TURRET_RING_EDGE_ALPHA`), with nothing filled in inside it, under the champions, so whoever stands in
it and whatever is under it show through. It is drawn for every turret the team can see, and not for one that is
destroyed. A turret of the other team can be right-clicked and picked with Space like an enemy champion, until it is protected: a protected one has a
pale **barrier** ring round it and cannot be clicked on or picked, since nothing would come of it.
A team always sees its own turrets, an enemy turret in the dark is not drawn (like any enemy), and a standing turret is a place its
team **sees from**, out to its `visionRange` (`TeamVision`): an enemy who comes within it is drawn, can be clicked on and picked
with Space, even with no champion of the team near, and a turret that is destroyed stops seeing. Turrets are not on the scoreboard, the leaderboard or the results.

**To add a tier:** add an entry to `TURRET_TIERS`, and put `turret` points with that `turret-tier` on a map. `tests/turrets.test.ts`
covers the tiers, the targeting on its own (`chooseTurretTarget`), turrets in a simulator (shooting, range, destruction, rewards,
being fixed, rolling back, snapshots), reading them from a map (including the competitive map's own), and the server starting them;
`tests/turret-range.test.ts` covers how the page shows them. `defineTurret` in `tests/fixtures.ts` registers a tier for a test.

**Not here yet**, where a game would want it: targeting other things first (minions, or whoever hit an allied champion), a lobby
switch for whether a game has turrets, and art for the body and a destruction effect in place of the shapes drawn now.

## Structures

Turrets and cores are **structures** (`structures.ts`; `SimCharacter.structure`). They stand where they are put, are solid, belong to a
team, are destroyed for good (nothing brings one back), and are never paid for what they kill, scored for, or on the scoreboard. Two
rules make them what they are:

- **Only attacks hurt them.** An auto attack, a swing or a shot, does its damage to a structure, less its resistance. An ability does
  **nothing** to one: no damage (however it reaches it, a blast, a bolt, a burn), no health lost, no heal, no knockback or pull, no
  blink, and no status or mark, so it cannot be stunned, rooted, slowed, silenced or burnt. (The simulator tells an attack's damage
  by its source id, `ATTACK_SOURCE_PREFIX`: an auto's damage is physical, an ability's is magic.) It is done in `applyWrites`, where every
  effect lands, so no effect has to know of it.
- **A structure is protected until what guards it is down.** While it is, it takes no damage at all, from anything: a hit that
  splashes it does nothing either, and an order to attack it changes nothing, so a champion walking up to it is not stopped. It can
  still shoot. It is open once what guards it is down, and stays open, since nothing that is destroyed comes back.
  - A **turret** is guarded by every turret of its own team of a lower tier: tier 2 takes no damage until the tier 1 turrets are down,
    and tier 3 waits for tier 2, which waits for tier 1. With a tier missing from a map, the next up waits for every one below it,
    and turrets of the same tier do not guard each other (tier 2 waits for all of tier 1).
  - A **core** is guarded by the turrets of its team up to its `guardedByTier` (`CORE` in `cores.ts`, 1 by default): the core can be
    hurt once the tier 1 turrets of its team are down, whatever stands above them. Set it to 2 for the core to wait for the tier 2 turrets
    as well, or to 0 for a core with no guard.

Who is protected is `shieldedStructures`, a pure function of the structures and which of them stand, so the server and every client
work out the same set from a frame (`Simulator.shieldedIn`). It is worked out at the start of each tick's writes, so a turret that
falls on a tick opens the one it guards from the next.

## Cores

A core is the heart of a team's base, and what Core Destruction is played for. It is a champion that cannot move or attack (`cores.ts`)
and a structure, so it is hurt by attacks only and is protected until its turrets are down. Everything that makes it what it is, to be
tuned, is `CORE`: `maxHp`, `resistance`, `radius`, `guardedByTier`, and a `reward` (gold, experience and shards for the player who
breaks it, nothing by default). The server puts one in a game of that mode for each of its two teams, at the base of the slot the team
starts at (the biggest team at the first core of the map), after the players and the turrets. No monster goes after one, and it gives
its team no vision.

Once a core is broken its team cannot respawn (`Simulator.canRespawn`; in `computeFrame`, a dead character's respawn is skipped while
its team's core is down, so a player who died before it fell and was waiting to come back stays dead as well). It is drawn as a
diamond in its team's colour, with its health bar over it, and the barrier ring while it is protected; a broken one is gone.

**To add one to a map:** put a point of class `core` with the `team-name` of the slot on each team's base (see "Maps from Tiled"). The
competitive map has none yet, so Core Destruction is greyed on it until it does. `tests/structures.test.ts` covers the two rules
(who is protected, what hurts a structure) and `tests/core-mode.test.ts` the mode (the objective, respawns, winning, reading it from
a map, the server, and what the page shows); `defineCore` in `tests/fixtures.ts` registers a core for a test.

## Resources and levels

*This is for the modes that have an economy: only Core Destruction does (see "Game modes"). In the others none of it happens.*

A player collects **gold**, **shards** and **experience**, and the level their experience makes. The level makes the champion
stronger (see *Stats and growth*, below); the gold buys items (see *Items and the shop*, below); the shards are only kept and shown for now,
as nothing is bought with them. The numbers are in `progression.ts`.

- **What a kill pays.** Whoever makes a kill is paid, whatever they killed: a monster pays what its entry in `monsters.ts`
  says (`reward`, below, and more experience for each level it has gained: see "Monsters level up"), and a player pays
  `PLAYER_KILL_REWARD` (300 gold, 60 experience), flat, whatever level either is. A monster that kills is paid nothing. The golem alone pays shards.
- **Setting a monster's reward.** `MonsterDef.reward` is `{ gold, xp, shards }`, each a whole number, 0 or more. Whatever it
  leaves out is `DEFAULT_MONSTER_REWARD` (25 gold, 25 experience, no shards), so a monster that says nothing is worth that.
  At level 1 the slime pays 20 gold and 60 experience, and the golem 120 gold, 100 experience and 1 shard.
- **Levels.** You start at level 1, and each level takes **more experience than the one before**, in a straight line: `xpToNextLevel(level)` is
  `GAME_XP_FIRST_LEVEL` (100) plus `GAME_XP_STEP` (50) for each level after the first, so the levels take 100, 150, 200, 250 ... and level 2 is at 100
  experience, level 3 at 250, level 4 at 450. Up to `GAME_MAX_LEVEL` (18), and experience past the highest is still counted. **`xpToNextLevel` is the one
  place that says how levelling scales**: `levelForXp`, `xpProgress` (how far it is to the next) and `xpToReachLevel` (the experience a level starts at) are all
  worked out from it, so to change the scaling change that function (or the two numbers it reads).
- **Monsters level up.** See below.
- **The experience is in the frame.** It is `GameFrameCharacter.xp`, credited on the tick of the kill in `applyWrites`, like the
  health. It has to be: a level changes what a frame works out (a hit's damage, a cooldown, the health), so every peer must have
  it on the same tick, and a death that a late order undoes must take it back with the rest of the frame. (A tally kept outside
  the frames, credited when the commit tick passes the kill, would let a frame come out differently depending on when it was worked out.)
  It is kept through a death and a respawn, and it is in a snapshot's checkpoint frame, so it shows on screen as soon as the kill does.
- **The gold is in the frame too.** It is `GameFrameCharacter.gold`, credited on the tick of the kill with the experience, because what it buys
  (items) changes what a frame works out. A player starts with `GAME_STARTING_GOLD` (500, in `progression.ts`: the one place to change it); a monster
  or a structure has none. It is kept through a death and a respawn, and a kill that a late order undoes takes it back.
- **The shards are a tally.** `shards` on `SimCharacter` are credited when a kill can no longer be undone, the same moment the kill is counted
  (`confirmDeathsUpTo`), since nothing in a frame depends on them. They are the same on the server and on every client, a kill that a late order
  undoes pays nothing, they are kept through a death and a respawn, and they are in a snapshot (`GameCharacterSchema`; a snapshot without them
  has none). They show up a moment after a kill, like the leaderboard.
- **On screen.** The level and experience bar are in the left panel of the HUD (below), and the gold and shards on the buttons of the right one.

## Items and the shop

A champion has **eight slots**, one for each kind of item: boots, chest, back, head, weapon, accessory, pet and potion (`ITEM_SLOTS`, in the order of the
grid on the HUD, four across and two down, which they fill). Each holds **one** item: to buy another of that kind, the one in the slot has to be sold first. An item costs
gold, and **adds its stats** to the champion that carries it.

**The items** are in `items.ts`, a plain list of records (`ItemDef`): an `id`, a `name`, a `slot`, a `cost` in whole gold, an `icon`
(the file in `res/shop_icons` without `.png`; it is the `id` when left out), and `stats`. The items there now are filler (a cost and stats made up to try the shop with), one for each
picture in `res/shop_icons`, 75 of them. Adding one is adding a record and a picture. An item can add any of these, each a flat amount to the stat of the same name
(`ITEM_STAT_KEYS`): `maxHp` (whole), `attackDamage`, `attackSpeed` (attacks a second), `resistance`, `haste`, `arcane` (ability power, in whole
points: 20 is 20 more of it, see "Stats and growth"), `attackRange` and `moveSpeed`. A mistake in one (a slot that is not one, a cost that is not a whole number, a stat that does not exist) is
refused with the item named, when the game starts.

**Selling** pays back `ITEM_SELL_RATE` of the cost, rounded down: **0.7**, which is 70%. It is one number at the top of `items.ts`; the simulator
and the shop both read it, so changing it changes both.

**What the stats do.** What a champion carries is added to what it has at its level (`withItems`), and everything that reads a champion's stats
reads that: the damage of its autos and its abilities (attack damage, arcane), what it takes (resistance), its cooldowns (haste), its swing (attack
speed), how far it hits from (attack range), how fast it walks (move speed), and its health. An item with health raises the most health a champion
can have and the health it has by as much, as a level does, and selling it takes the same off again (never down to 0 for one that is alive, so
buying and selling is not a way to heal). The stats panel and the champion's bars on screen show what the items make of them. Items are not
for monsters or structures.

**Buying and selling are orders**, like moving and casting (`buy` with an `itemId`, `sell` with a `slot`). They are done on the order's tick, by the
simulator, with the gold and the slots that frame has (`buyProblem`), so the server and every client agree, and an order that arrives late changes the
frames after it like any other. One that cannot be carried out (it costs too much, the slot is full, the item does not exist) is nothing, on every
peer alike; the server turns away one for an item that is not in the game (`unknown_item`). The gold and the items are in the frame
(`GameFrameCharacter.gold` and `.items`), so they roll back with it, are in every snapshot's checkpoint, and are kept through a death: the dead
can shop, and are back with what they bought, at the health it gives.

**Where.** The shop can be **opened from anywhere**, to look at, but items are **bought and sold only in a shop of your own team**: a rectangle the map
draws (a `shop` object, see "Maps from Tiled"). A champion is in one when its middle is inside it, edges included (`shopZoneContains`, `mayShop`, in
`shops.ts`). The rule is the simulator's (`Simulator.canShop`, checked by `buy` and `sell` orders on their tick), so an order sent from outside a shop is
nothing on the server and on every client alike, and the page checks it first (`NOT_IN_SHOP`: "You can only buy and sell in your own shop.") and sends none.
The zones are fixed for the game, so they are in the snapshot (`shops`), not in the frames, as the ground is. The server makes each shop the shop of the team
that starts at its slot, as it does a turret (`rankTeams`): the biggest team shops in the shop of slot 1. Three details:
- **A dead champion can shop**, wherever its body lies: it comes back in its base, where its shop is. (To make the dead need a shop too, drop the
  `!isAlive(state)` from `mayShopNow` and `state.isDead()` from `canShop` in `simulator.ts`.)
- **A game with no shops can be shopped in from anywhere**, so a map made without any (the free-for-all one) is not left with items nobody can buy.
- **A map with shops needs one for every slot that has spawn points**, or that team could never buy: it is refused, saying which slot (see below).

**On screen.**
- **The slots** are the grid on the right of the HUD, four across and two down (`HUD_ITEM_COLUMNS` by `HUD_ITEM_ROWS`, the one place that says so: the
  panel and the grid are sized from it): each shows the picture of the item in it, or the name of the kind, dim, when it is empty. The kinds fill it
  from the top left in the order of `ITEM_SLOTS`, and any cells left over are dashed outlines that do nothing, room for kinds to come (there are none now, with
  eight kinds): a new kind is a new entry in `ITEM_SLOTS`, and a test fails if the grid has no cell for it, so make `HUD_ITEM_ROWS` bigger first. *Clicking* a slot opens the shop on that kind of item; *right-clicking* one with an
  item in it sells it, in a shop. Pointing at one says what is in it, what it adds, and what selling it pays (away from your shop it says that it is sold
  there).
- **The gold button** shows the gold you have, and opens the shop on the kind of item you looked at last (the first, boots, the first time). Pressing the same
  button again (or a slot, with the shop open on that kind) puts the shop away; so do the cross on the shop and Escape.
- **The shop** (`ui/shop-view.ts`) is a panel over the game, which goes on behind it, sorted by kind, with a tab for each kind of item and none for all of
  them (cheapest first in each), the gold you have, and a grid of the items there, each a picture with its price. Pointing at one
  says its name, what kind it is, its cost, what it adds, and a line about what it is; **clicking one buys it**, in your shop (away from it, a line under the
  tabs says you are away and can only look, and clicking says `You can only buy and sell in your own shop.`). One you cannot buy now, because it costs more
  than you have or because another item is in its slot, is drawn **grey** but can still be pointed at, and the tooltip says why (`You need 60 more
  gold.`, `You already have Worn Boots in your boots slot: sell it first.`); the one you have is marked *Owned*. What was bought, or why not, is said
  in a line under the tabs.
- What it shows is `ui/shop.ts` (pure: `shopEntries`, `shopTooltip`, `ownedTooltip`, `itemStatLines`), and the rule it asks, `buyProblem`, is the one the
  simulator buys by, so the shop never offers what the game would refuse. The tooltip is one box shared by the shop and the slots (`ui/item-tooltip.ts`).

**To add an item:** add a record to `ITEM_DEFS` in `items.ts` and a picture to `res/shop_icons` (the 16 px art is scaled up with hard edges). Nothing
else needs to know of it: the shop lists it, the slots show it, the stats apply. `tests/items.test.ts` covers the rules and what each stat does in a
simulator (and checks each shipped item has its picture), `tests/shop.test.ts` what the shop lists and says and how the page buys and sells, and
`tests/shops.test.ts` where (the zones, the map's shops, the server, and the grid); `defineItem` in `tests/fixtures.ts` registers an item for a test.

**Making items do more.** An item is a plain record, and the one place the simulator asks what a character carries is `statsOfState` (with
`itemTotals` for what only the cost of a swing or a step needs), so an item that does more than add stats grows from there: an effect when an attack
lands (`onAttackHit`) or when an ability is cast (`onCast`) would be a field of `ItemDef`, run next to the champion's own in `launchAction`; an
ability an item gives would be a field naming it, added to what `startCast` accepts;. None of those is built yet: items add stats, and nothing else.

## Stats and growth

A champion is made of more than health and a swing. `stats.ts` has the types and the formulas, and `Champion.statsAt(level)` is
what a champion is at a level: its **base** stats are what it is at level 1, and each level after that adds its **growth**.
Every one that a frame works out is read at the level in that frame.

| Stat | What it does |
| --- | --- |
| `maxHp`, `attackDamage`, `attackSpeed` | As before, and they grow. A level gained adds its health to the maximum and to the health the character has (a dead one's stays 0), and a respawn is at the health of its level. |
| `arcane` | **Ability power**: an amount, 0 for none, that does **nothing by itself**. Damage is as it is written unless an ability says it scales with arcane, by its own ratio (`scaled(100, { arcane: 0.6 })` is 100 and 0.6 for each point of it), so one ability can grow harder with it than another. Items and levels add points of it; the stats panel shows the amount. See "Scaling an ability" below. |
| `resistance` | Takes `x / (100 + x)` off every hit taken, League's formula: 100 takes half, 300 three quarters, and no amount all of it. It applies to autos, abilities and burns alike, and then to a `resist` status as well (they multiply). A health cost (`loseHealth`) is not damage and ignores it. |
| `haste` | Takes `x / (100 + x)` off an ability's cooldown, as it starts it (`hastedCooldownTicks`, whole ticks, never under one). It applies to a cooldown that is put back on its whole (`startCooldown`) and to what a refund takes off (a share of the shortened cooldown). An auto attack's rate is the attack speed, not this. |

**Base and growth.** A champion holds its stats twice, as two `StatBlock`s (`stats.ts`), a class of the six numbers `maxHp`,
`attackDamage`, `attackSpeed`, `resistance`, `haste` and `arcane`, each a number, 0 or more. `base` is what it is at level 1, and
`growth` is what each level after the first adds. Both are said in the champion's own entry, so its numbers are all in one place to change:

```ts
base: { maxHp: 800, attackDamage: 40, attackSpeed: 1.3, resistance: 0, haste: 0, arcane: 0 },
growth: { maxHp: 50, attackDamage: 3, attackSpeed: 0.03, resistance: 3, haste: 2, arcane: 4 },
moveSpeed: 140, radius: 20, attackRange: 190, attackWindupTicks: 12,
```

There is no growth shared by all of them: each champion in the game says its own, in all six stats (they are the same placeholder
numbers for now, to tune one at a time). The range and the move speed do not grow. A stat left out of a block is made up from what
nothing means: in a `base`, no resistance, no haste and no arcane; in a `growth`, nothing added. The health, the attack damage and
the attack speed of a `base` have to be said, and a number that is not (or is negative) is refused, naming the champion and the stat.
`champion.base` and `champion.growth` are the blocks, `champion.maxHp` (and the other five) read the base's, and `statsAt(level)`
is the base plus the growth for every level above the first (`StatBlock.grownBy`). A stat written on the champion itself (`maxHp: 800`
beside `radius`, as it used to be) is refused with an error, and not quietly ignored.

### Scaling an ability

Nothing multiplies an ability's damage on its own: `damage(100)` is 100 whatever the caster has, and a burn is as written. An ability grows with
the caster's stats only if it says so in its amount, with a ratio for each stat it uses, so abilities can scale as hard or as little as they like
(arcane is League's ability power: an amount you have, used in the sum, and not a multiplier). The amounts that read the **caster** (the owner of the
effect, whoever is hit, as they stand when it runs, with their level and items) are in `effects.ts`:

| Amount | Is |
| --- | --- |
| `arcane()` | The caster's arcane. |
| `attackDamage()` | The caster's attack damage. |
| `maxHealth()` | The most health the caster can have. |
| `health()` | The health the caster has now (before this tick's writes). |
| `level()` | The caster's level. |

Use them in `linear(base, each, of)` (base plus `each` times the amount), or give several ratios at once with `scaled(base, { arcane, attackDamage,
maxHealth, health, level })`, where each ratio left out adds nothing and the base can itself be an amount (such as `linear(60, 30, swordStacks)`):

```ts
damage(scaled(120, { arcane: 0.7 }), enemiesInRadius(200))                        // 120 and 0.7 per point of arcane
damage(scaled(100, { maxHealth: 0.08, arcane: 0.3 }), enemiesInRadius(200))       // 100, 8% of the caster's health, and 0.3 per arcane
burn(scaled(30, { arcane: 0.2 }), seconds(3), enemiesInRadius(200))                // a burn's amount is read when it is lit
```

An auto attack takes the same: `damage(scaled(attackDamage(), { arcane: 0.2 }))`. The abilities in the game scale a little now (Spout, Bubbles,
Hex, Grenade, Molotov, Stick, Feast and Radiance with arcane; Shadow Step, Kunai, Bolt and Slash with attack damage; Tsunami with health and
arcane; Radiance with level too), and those ratios are the numbers written in `abilities.ts` to tune. A champion's arcane is 0 until a level or an item
gives it some, so an ability that scales only with arcane plays exactly as it is written until then.

A monster is a champion, so it has a `base` and a `growth` too (a monster in the game says its own: health and damage). A monster does not earn experience, but
it **levels up each time it is killed**: see "Monsters level up" under Monsters.

The stats panel of the HUD lists all of them at the champion's level. A level-up shows at once, and the cooldowns on the ability
slots fill over the shortened time. The champion select screen shows the champion as it is at level 1.

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

The bottom of the screen is the HUD (`ui/hud.ts` works out what it shows and `ui/hud-view.ts` fills in the
elements): three separate panels in a row, each standing on the bottom edge with nothing under it. (In a mode with no economy, which is every one but Core
Destruction, the two side panels are left out and the middle one, the abilities and the health, stands alone: `HudInput.economy`.) The whole UI is flat: square
corners (the level's circle is the one exception), solid colours, and no shadows, glows or gradients. The dark screens share one set of
colours (the `--ui-*` custom properties at the top of `style.css`), text on a picture is plain text with a hard one-pixel edge and
nothing behind it, and the browser's own buttons, inputs and focus rings are square too.

- **Left: the level, the experience and the stats.** The experience bar is on the far left of the panel and fills upward from
  the level, a circle at its foot that stands out past the panel's left edge a little. It has no numbers, only how full it is
  (full at the highest level). To the right of it are the champion's stats, one row each (`statRows`): max health, attack
  damage, attack speed (a rate, to two places), attack range, move speed, arcane (a whole amount, `46`), and resistance and haste (each as the
  stat and, after it, what it takes off: `33 (25%)`). They are the champion's stats at its level (`ChampionStats`, from
  `Champion.statsAt`), and are where items will add to them.
- **Middle: the abilities, over the health.** A slot for each ability on its key, which fills from the bottom as the cooldown runs,
  shows the seconds left, and lights up when the ability is ready (a key that has turned into its recast shows that ability's
  cooldown); and under the slots the exact health as `hp / max`, with any shield as `+n` beside it and laid after the health on
  the bar.
- **Right: the items and the shops.** A grid of item slots, four across and two down (`HUD_ITEM_COLUMNS` by `HUD_ITEM_ROWS`), and under
  it two buttons: the shop, which shows the gold, and the shard shop, which shows the shards (always a number, even 0), each with
  its picture from `res/general` (`gold.png`, `shard.png`, found by `ui/general-icon-urls.ts`). The slots and the gold button work (see
  "Items and the shop"): this panel takes clicks (`pointer-events`), and the rest of the HUD does not, so they go through to the game. **The
  shard shop is still a mock-up**: its button does nothing.

The debug overlay at the top left keeps only the network and simulation diagnostics.

Because the camera moves under a still mouse, the mouse is remembered as a screen position and
converted to a world point (`computeCamera` and `screenToWorld` in `camera.ts`) at the moment
it is used: when you click, and when a key casts an ability at the cursor. Clicks and aiming
work over the dark area past the map's edge too, and an order aimed there is clamped to the map.

Each champion has one health bar over its head, in the style of League of Legends: current
health from the left, the shield on the end of it in white, and the health still missing after
that. The bar stands for the maximum health, or for health plus shield when that is more, so a
big shield shrinks the rest of the bar instead of running off the end. A small tick marks every
100 health and a taller, thicker one every 1000 (`HEALTH_TICK_EVERY` and
`HEALTH_MAJOR_TICK_EVERY` in `render/character-layer.ts`). The layout is the pure function `layoutHealthBar`
(`render/health-bar.ts`), which `render/character-layer.ts` only draws. A champion's maximum health is at most 1000 so far,
so a 1000 tick shows only when a shield stretches the bar past it.

### The escape menu

Escape opens a menu over the game (and closes it again). The game goes on behind it, and while it is
open nothing reaches the game: no keys, and no clicks on the map. If an ability is being aimed,
Escape drops the aim first, as it always has, and opens the menu on the next press. It offers the
cast mode (quick cast, or quick cast with an indicator) and **Leave game**, which takes the player back to the lobby
and leaves the game to the others (the lobby's own Leave button is what leaves the lobby).

It is built to grow. `menuItems` in `game-menu.ts` is the list of rows, as data: a `choice` (a few
options with the current one lit) or an `action` (a button), each given what to do by the game, so the
menu knows nothing of it. Adding an option is adding an item there, and `createGameMenu` draws it.
What a player chooses is kept in the browser by `game-settings.ts` (`loadSettings` and
`saveSettings`, every value checked on the way in and defaulted if missing or odd), so the cast mode
is what they last chose the next time they play. A setting is a field of `GameSettings`.

### Hitbox debug view

P toggles it on and off (nothing to hold). It outlines every body that can touch something, as the
simulator sees it and whatever it is drawn as, so it stays right when everything is a sprite: each
living champion's body circle (yours in green, others in red; the dead have none), and each entity's
circle or rectangle, turned the way it faces (orange). `hitboxShapes` (`render/hitboxes.ts`) works the
shapes out from the same rendered characters and entities the game draws, and `HitboxLayer` outlines
them on a layer kept above everything else. A new kind of body is drawn by adding it there. It also draws
the path the champion you control is walking (`ClientGameState.getLocalPath`) round the walls.

### Sprites and animation

A champion can be drawn from sprite sheets instead of as a plain circle. Every champion has its own
folder, `res/Champion_<name>`. The Swordsman is the sword-and-shield knight, the Archer the crossbowman,
the Cursebearer the staff bearer, and the Ninja has art of its own. The Trinketmaster (melee) is a copy of
the Swordsman's sheets, and the Capricorn, Soldier and Grenadier (ranged) are copies of the Archer's,
as placeholders until they have art. They are drawn a little bigger than their
bodies and with no circle behind them. The name above every champion is in its team's colour, which is how
a sprite shows the team. The work is split in three, so animations can be added as data:

- `champion-sprites.ts` is the data. A `SpriteSet` per champion ID gives the frame size, the point
  in a frame that sits on the champion's position (`anchor`, the middle of the figure), how big an
  art pixel is drawn (`scale`), which way the art faces, and its `clips`: for each animation, a
  sheet (`url`, a single row of frames, left to right), how many frames, the rate, and whether it
  loops. Sheets are referenced with `new URL('../../../res/...', import.meta.url)`, which Vite serves
  in development and bundles in a build.
- `animation.ts` is the logic, and knows nothing of drawing. `chooseAnimation` picks the clip:
  being dead first, then what the champion is in the middle of (an `attack` or a `cast`), then
  walking, then `idle`, taking the first of those the set has a clip for. So a set with only a walk
  and an idle walks or stands through attacks and casts until it is given clips for them.
  `CharacterAnimator` keeps one champion's state from frame to frame. It works out walking and
  facing from where the champion is drawn (a short grace so a still frame does not flicker it to
  idle, and a jump such as a respawn is not a step), restarts a clip from its first frame when the
  clip changes, and gives the frame to show.
- `character-sprite.ts` is the Pixi side. `loadSpriteSets` loads every sheet once at the start of a
  game, sampled nearest so pixel art stays crisp, and cuts it into frames. A `CharacterSprite` per
  champion asks its animator what to show each frame, and flips the frame when the champion faces
  the other way from the art. If the sheets cannot be loaded, champions are drawn as circles.

The Swordsman's `attack` is `Attack_1.png`. A clip marked `syncToAction` has its frames spread over the
action instead of running at `fps`, so the last frame is the hit however long the windup is: the
client works out how far through the action each champion is (`RenderedCharacter.action`, with
`progress`), and while it attacks or casts the champion turns to face what the action is aimed at.
A clip can also give each frame its own time (`frameMs`) instead of one rate: the Swordsman's death sits on its
first frame for 0.4 s and then holds the second for as long as he is dead. To add an animation to a champion, add its clip to the set, for example `cast: { url: ..., frames: 3,
fps: 10, loop: false }`. To draw another champion, add a set under its ID.
`RenderedCharacter.action` already says whether a champion is attacking or casting, which is what
`attack` and `cast` clips will play on. A new kind of animation is a new `AnimationKey` and a place
for it in `chooseAnimation`. `tests/animation.test.ts` checks each set against its sheets (every
clip fills its sheet exactly) and the roster, so a wrong frame count fails the tests.

**Ability icons.** An ability's icon is `res/icons/<ability id>.png` (16 x 16, so `hex.png` is Hex's), drawn on its
slot in the HUD and beside its name on the champion select screen. The ids are the ones in `abilities.ts`, so a key
that changes ability (Q turning into `recall` or `shadowreturn`) changes its icon with it, and giving an ability an
icon is dropping a file of that name in the folder. `ui/ability-icon-urls.ts` finds the files (Vite's
`import.meta.glob`, so a new file is picked up by the dev server), and `ui/ability-icon.ts` makes the element. An
ability with no file, or whose file will not load, shows a dim "N/A" tile with the tooltip "Icon not available" in its place.

Stacks are drawn as pips under the body, by the pure function `layoutStackPips` (`render/stack-pips.ts`).
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
giving a move or attack command (right-click, on the ground or on an enemy, or Space with an enemy anywhere)
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
and Shadow Step) also draws a line from the champion to the point, and with a `width` too (the stick)
the line is a band that wide. A point-aimed ability can have a `minRange`, the nearest it can be aimed. `ClientGameState.getCastPreview` resolves the target
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
and to Slash. Q, Slash, cuts a 250 by 60 rectangle in front of him (`enemiesInLine`) and
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
direction (up to 140 px, and never more than 50 px past where the wave stops), and stuns it for 0.6 seconds (which also
interrupts a windup that has not launched). W, Bubbles, fires a stream of five bubbles: on each target the first bubble
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
without stunning (no champion in the game uses it at the moment: the Tsunami stuns instead). `spawnEntity` takes a `volley` option (`count` copies from one spot, each
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

**Soldier** is a ranged fighter with no passive: its auto is a plain attack. Q, Stim, costs 150 health and for five seconds
adds 50% attack speed, 30% move speed, and 30% damage resistance. W, Bolt, is a piercing shot
that slows and deals 80 plus a fifth of the target's missing health (`missingHealth()`, which
reads `SimReader.healthOf` as the tick began). E, Medic, gives a 250 shield and summons a bot
that heals 12 health every half second. Both last until the shield is broken, which is how the
bot is killed; casting Medic again replaces the bot and refreshes the shield.

Stim's cost is `loseHealth(amount)`: it ignores shields and resistance, and never takes the last
point, so it cannot kill. `heal(amount)` restores up to the maximum and does nothing for a unit
already at 0 health, since a champion with none left is dead and a heal must not bring it back.
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
does not count. Q, Stick, is aimed at a point, and the player chooses how far to throw it: the stick flies
to the point at 540 px a second, hurting every enemy it passes through once, and lands in the
ground there (or against the wall, if the point is past it) and stays, with no timer, until the
Trinketmaster dies. The point is at least 150 and at most 360 from him (`minRange` and `range` on
the ability): the client pushes an aim nearer than 150 out to it along the same heading, holds a
farther one to 360, and the simulator drops a cast aimed outside either. It is drawn as a band as
wide as the stick, from him to where it will land, with a faint ring at the nearest it can go. Walking over it
picks it up and leaves Q no more than a second to wait, however long was left; a Q that had less is
not lengthened. Calling it back is different: pressing Q again sends the stick flying home through
enemies, hurting and slowing each once, and it is gone when it reaches the Trinketmaster, but Q's
cooldown is exactly as it was. An enemy in the line is therefore hit going out, for damage alone, and
again coming back, for damage and a slow. Only walking over the stick refunds Q. W, Hush, readies his next auto (for five seconds)
to silence its target for 1.5 s, and resets his auto timer. It has no windup and no target, so it
goes between autos. E, Warp, blinks the Trinketmaster to the stick,
wherever it is: it is there on the next frame, standing on the stick, so the stick is walked over and
Q is left a second to wait. Warp has no range limit. With no stick anywhere, on the ground, in the air
going out, or in the air coming back, but Q still on cooldown, Warp has nothing to blink to and
gives Q back instead, all of its cooldown, at the cost of its own; with Q ready and no stick out, or a
stick in the air, it cannot be cast.

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
shot with `stopsAtWalls` never leaves the arena: a straight one ends where its edge meets the arena's edge
instead of flying on past it, running its `onExpire` there, and one that lands at its aim
(`landAtAim`, which is how the stick is thrown) flies to the aimed point held inside the arena. The
stick's throw uses it so that the stick always lands somewhere the Trinketmaster can walk to. It
is worked out when the shot is spawned, and only shortens the flight.

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
passes, leaving a new shadow where it was cast from. A shadow lasts 4 seconds (`SHADOW_LIFETIME_TICKS` in
`abilities.ts`, the one number to change to retune it, for Shadow Step and Shadow Return alike) and then
fades, and the key is Shadow Step again from then. Q was ready before, since the first enemy hands
three quarters of its 8 second cooldown back, so it is only the key that waits. A dash back through an
enemy hands Q's cooldown back too and leaves a new shadow with 4 seconds of its own, a chain of dashes going back and forth through one enemy until a third finds
the stacks already full. A shadow is also lost by a dash back to it that finishes without passing
anyone, or when the Ninja dies. Shadow Return has a 1.75 second cooldown of its own, started when the
dash that left the shadow reached its enemy, so the dash back is not ready the moment the dash
forward is over and the chain cannot be spammed. A miss puts Shadow Step on its whole cooldown from
the moment the dash back finishes (`startCooldown`), so the time that ran while the shadow was out is
no help and Q cannot be cast twice in a row. (The Trinketmaster's stick is deliberately the other
way: its cooldown keeps running while the stick is out, and calling it back leaves it alone.) W, Kunai, is a piercing line shot that hurts and slows every
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
down. An ability can have a second way to be castable, `orWhen: { none, onCooldown }`: when none of
the entities listed are out and the ability named is on cooldown. Warp has it, so it can be cast with
no stick in play while Q is on cooldown, and its effects check for a stick on the ground to choose
between the blink and giving Q back. (`meetsRequirement` takes a way to ask whether an ability is on
cooldown, as the simulator and the client each have their own.) Silenced characters are labelled `silenced`.

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

Death is worked out by the simulator, so every client predicts it and the server sends nothing. A
champion left with no health dies on that tick: it stops, becomes a ghost, and respawns at its
starting position with full health `GAME_RESPAWN_TICKS` later. Everything about it is in the
frames, so a rollback undoes a death that a late order saves, and a checkpoint carries a dead
champion with it. The damage that took the last health decides the killer (`DeathRecord`), and
a champion that dealt it to itself has none.

What cannot be taken back waits for the commit tick, after which no late order can arrive (the
server refuses them) and a death is certain. The simulator keeps the deaths after the commit tick
as pending, and when the commit tick passes one it adds a kill to the killer's `kills` and calls
`onDeathConfirmed`. The champion falling on screen is predicted; the leaderboard and the killfeed
only show confirmed deaths, so a kill that was undone is never shown. Snapshots carry each
character's confirmed `kills`, which also corrects a client that had drifted.

The top right of the screen holds both. `ui/scoreboard.ts` orders the leaderboard (most kills
first, ties in join order, the local player marked) and keeps the killfeed lines fresh for six
seconds, five at a time; `ClientGameState` hands them to `game.ts`, which passes them to
`ui/scoreboard-view.ts`, which redraws the elements only when what they show changes. Names are in their team's colour.

Pending order messages are retried with exponential backoff. Silence does not
undo a prediction: after the retry timeout the client requests a full state
snapshot, and retries continue until an acknowledgement arrives. Server-side
broadcast timeout also triggers a snapshot. Handshake and lifecycle messages (joining,
starting, cancelling, errors) use Geckos reliable delivery, which sends a message ten times.
Snapshots and order acknowledgements deliberately do not: the next snapshot is a second away and a
client that falls behind asks for one, and an order whose acknowledgement is lost is resent by the
client and acknowledged again from the server's cache. Orders themselves use the reliable messenger's
own retries, not the Geckos option.

Network snapshots use the latest committed frame as a checkpoint and include
only orders newer than that checkpoint for replay. The server sends these
checkpoints once per second by default; configure the positive-integer
`GAME_CHECKPOINT_INTERVAL_MS` environment variable to change the interval.
A snapshot is the biggest and most repetitive message, so it is sent gzipped (about a quarter of the
JSON) as a raw binary message (`apps/server/src/snapshot-codec.ts`), which is also small enough not to
be split into several packets, any of which could be lost. The client unzips it with the browser's
`DecompressionStream` (`apps/client/src/snapshot-codec.ts`), one at a time so they apply in order.
Nothing else is gzipped: the other messages are too small for it to help.

An order is named `characterId:seq` (for example `3:41`), and the order broadcast to the lobby carries
only the order and `characterId`, not the sender's session id or name, which are already known from the
lobby. Order ids are repeated through the game state, so keeping them short also shrinks snapshots.

The server counts what it sends and logs it every 5 seconds while it is sending (`bandwidth.ts`): the
total, and each kind of message from the busiest, with how many a second and how many times each is
sent. It counts what goes on the wire: a message sent with Geckos' `reliable` option is sent 10 times
by default, 150 ms apart, and a room message goes to every player in it (it is counted once for each,
as Geckos sends it to each player's channel). Set `GAME_BANDWIDTH_LOG_MS`
to another interval, or 0 to turn it off.

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
| `GAME_MAPS_DIR` | `res/maps` | The folder the server reads its maps from (every `.tmj` in it), and reads again each time a game starts |

### Keeping it running

`npm run dev` stops when your SSH session closes. Run it under `tmux`, `screen`,
or a process manager such as `npx pm2 start "npm run dev" --name moba`.

`npm run dev` is the development setup: it restarts the server whenever a file
changes, which drops the in-memory lobbies. For a steadier setup run `npm start`.
It builds the client once and serves it with the same ports and the same proxy.

### The server log

The server writes one line to its output (stdout, stderr for errors) for each thing that happens to a
lobby or its game, to its output (stdout, and stderr for warnings and errors), which a process manager
such as `pm2` keeps for you (`pm2 logs moba`). The time is UTC, and what follows is a message and
`name=value` fields:

```
2026-10-24T09:41:22.752Z INFO  lobby created lobby=6LWDQ6 leader=Alice map=competetive mode=core lobbies=1
2026-10-24T09:41:22.757Z INFO  player joined lobby=6LWDQ6 name="Bob Smith" players=2/8
2026-10-24T09:41:22.765Z WARN  join rejected lobby=6LWDQ6 name=Dave reason="This lobby has already started a game."
2026-10-24T09:41:33.582Z INFO  game started lobby=UATV6Q mode=deathmatch map=ffa_arena players="Alice (Red), Bob (Blue)"
2026-10-24T09:42:01.220Z INFO  game finished lobby=L2VMZT mode=deathmatch map=ffa_arena reason=limit winner=Blue scores="Blue 25, Red 17" players=2 seconds=412
```

What is logged: a lobby made and closed, players joining, rejoining, leaving, being kicked or timing out,
a join turned away (and why), the leader changing, the map, mode and rules being changed, a game being
opened for champion select, cancelled, started, finished (how, who won, the scores, how long it took) and
closed, a player leaving a game, a game that was refused its start (and why), a player's game connection
being made or lost, and the server's own errors. Players are named by their username, never by their session
ID, which is what their requests are trusted by.

What is left out, so the log stays readable on a busy server: lobby polling, chat, team picks, username
changes, a setting set to what it already was, and everything inside a game (orders, pings, snapshots). A
player's username (or anything else a player typed) is quoted and escaped when it has more than plain
characters in it, so a name cannot end a line or pose as another field. Because anyone can ask to join any
lobby, a refused join (and a refused game connection) is logged once every 10 seconds for each kind, with
`leftOut=N` saying how many were not. The bandwidth report above is separate, and is the one thing that
is logged on a timer.

`apps/server/src/log.ts` is the logger, and `tests/server-log.test.ts` its tests.

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
