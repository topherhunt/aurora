# §30 -- Leafkin and the leafkin villages

Every large forest has a hidden leafkin village: grubby elf-men a metre tall who grunt, squeak and pant to themselves while they bumble through the wood collecting mushrooms. See one and it squeals, drops what it carries and runs for home. Home is a dark hole low in the side of a giant boulder, easy to miss, and walking into that hole puts her inside the boulder: a glade of fern-lined winding paths, tall trees, a stream running to a small lake, and a clearing of shabby stump-huts around one great one. The leafkin are not friendly unless she brings them something they want. Later: leafkin at home in the village, and trade. Built in three pieces, each a thing on its own: the entrances, the leafkin, the village -- the last being the first **room** that is not the overworld.

## The files

| piece | where |
|---|---|
| entrance boulders | `rocks.js` `BEDS` `hollow`; `Rocks.hollowsInto` |
| mouths and the portal | `src/v2/render/entrances.js`; `main.js` `portalTest`, `PORTAL` |
| the leafkin | `src/v2/render/leafkin.js`; `public/creatures/leafkin.glb` (ladder + human library + `run-carry` + `gather`); `hands.js` `carry`, `CARRY_MAX`, `CARRIERS` |
| voice | `ambience.js` `SOUNDS` (`leafkinChatter1..4`, `leafkinSqueal`, `leafkinScream`, `leafkinWhimper`, `panting`), a herd entry on `FOOTFALLS.human`; `public/sounds/npc-leafkin-*.mp3` |
| the room | `main.js` `ROOMS`, `bootWorld`, `buildRoom`, `disposeRoom`, `bootRoom`, `sinkCave`; `src/v2/render/room-props.js`; `src/v2/render/shell.js` |
| the village | `src/v2/rooms/village.js` (built in memory at boot); `public/gen-props/house-leafkin*.glb`, `cave-mouth*.glb` |
| gates | `scripts/check-entrances.mjs`, `check-leafkin.mjs`, `check-village.mjs` (plus `check-hands`, `check-ambience`, `check-rocks`) |

## 1. The entrances

### Siting: the `hollow` rock bed

The entrance boulder needs 2 m of near-vertical face at ground level, deep in a wood. §25's giants cannot promise a standing stone on an open flank, so the entrances are a bed of their own: **one per 300 m tile that holds a wood**, the tile's one candidate put by `deep` at the point of the tile furthest from open ground and the tile refused unless that point is 50 m into the forest (the forest law's, which runs 55 m up into peak ground), `maxSlopeDeg: 20`, not submerged, `stand: true` (the longest axis up), the burial pinned at `sinkRange [0.4, 0.41]` (never squashed, so the face is the hull's own), `anchor` and `blocks`, resident to 1250 m. A pure function of the tile seed like every bed. Tall giants were not made more common in general: only the entrance needs the face. `scripts/probe-villages.mjs` counts the shipped map's and lists them nearest a point; the `critter LOD tint` row paints them purple (`Rocks.setHollowTint`).

### The mouth

`Entrances` owns no scatter: every frame it asks the rocks for the resident hollows within `RADIUS_M` (400) and seats a mouth on each new one, so a site is where its boulder is and goes when the boulder goes. The face is found by rays against the boulder's own hull from a bearing rolled off the site's key (`PROBE`: 1 m out, eye 0.75 m, 2 m of wall within 20° of vertical, up to 8 bearings), so two clients agree on the mouth to the bit. The mouth is the shipped `cave-mouth` arch scaled to `MOUTH_HEIGHT_M` 1.5, sunk 0.1 m into the face along the normal, drawn on the props' ladder with the shipped T3 in the card's place (an arch is on a wall; a card spun to her would stand out of it), and a **black quad** -- unlit, `fog: false`, 1.1 x 1.3 m -- a hair proud of the stone across the arch's passage rather than a cavity: the depth test keeps it in front of the face and the arch's walls around it, and the parallax across the arch's protruding half metre makes it read as a hole.

`sites(into)` yields `{ key, x, y, z, nx, nz, r }`: the **mouth point**, `MOUTH_STEP_M` 0.7 in from the face along the outward normal, for the leafkin and the portal. A room passes `fixed: [site]` instead and gets that one mouth, at that point, on nothing.

### The portal test

The slope limiter is not replaced: `player.js` refuses the step into the face and slides, as it must at every other boulder. `portalTest` runs after the step: for a site within `PORTAL.reach` 20 m, she enters when her feet are within `walk` 0.9 m of the mouth point and the step ran into the face (`-(step · n) / |step| >= into` 0.5), or a teleport landed within `blink` 1.2 m; the door she stands in takes her once a visit (`portalIn`). Into a village she arrives at its own exit; out of one she arrives at the mouth she came in by (`cameInBy`). Refused in the editor.

## 2. The leafkin

### Pipeline

`rig-map.mjs` derives `rig-map.json` from the Tripo biped rig (the `--forward` flag names the facing axis where the rig's own guess is wrong), the skin ladder cuts the tiers, the clip solver bakes the human library plus two new specs, and `ship-biped.mjs` with `'leafkin'` in `BIPEDS` writes `public/creatures/leafkin.glb`. The two clips are human-library specs, so every biped gets them: **`run-carry`** (the run gait with the arms held still, raised and bent so the hands meet at the chest; its speed is the run's) and **`gather`** (a pose clip, `loops: false`, ~0.9 s: crouch, spine forward, one arm to the ground; the key at t 0.5 is the reach). The snowman was re-shipped with the grown library. The 12 villager GLBs were not.

### Runtime: `leafkin.js`

Snowmen's puppet, tiers, FootIK and fade, with the scatter replaced by **one leafkin per resident entrance site** (`MAX` 16: the 400 m entrance radius on the 300 m tiling), seeded from the site key and its spawn tick, spawned at a random point of its `ROAM_M` 100 disc at least `SPAWN_CLEAR_M` 15 from her feet, so it is never seen to appear. It steps on the score's fixed ticks (`sim/score.js`) so two instances stepped on different frame times agree to the bit; `SIZE_M` 1 ±15%; drawn only within `critterTier`'s cull (~36 m for a metre of body), minded as long as its site is resident. It never walks: every gait is the run.

| state | what | leaves when |
|---|---|---|
| **roam** | a target inside the site's `ROAM_M` 100 disc every `RETARGET_S` 5-15 s, run (run-carry with a bundle) on a heading that random-walks about the bearing (`WOBBLE_*`), so the path arcs and doubles; every step probed on the walk surface, a refused probe turning it away by `DETOUR`, `REFUSALS` 10 in a row picking a new target | a cap within `SEEK_M` 3 -> gather; her feet within `STARTLE_M` 3 of its feet -> startle |
| **gather** | run to the cap, the gather clip, `mushrooms.take` at `GATHER_KEY`, the cap into the bundle (`CARRY_MAX`); then the next cap in reach, else roam. A full bundle stops the gathering. Mushrooms are only drawn within ~55 m of her, so only those are gathered | no cap in reach -> roam; she is near -> startle |
| **startle** | stop, face her, recoil, the bundle scattered, a scream; `STARTLE_S` 1 | -> flee |
| **flee** | run straight at the mouth point, a refused step sliding along the obstacle (`SLIDES`), the slide committed | within `HOME_M` 0.6 of the mouth, or out past its cull -> gone |
| **gone** | despawned; the site empty `EMPTY_S` 300 | the time up and her inside `ROAM_M` -> a fresh spawn at a random point of the disc |

A leafkin is not constructed in a room (`ROOMS.leafkin.leafkin` false).

### Carrying and dropping: `hands.js`

`carry(owner)` returns a carrier -- `add(record)`, `place(x, y, z, yaw)` per frame, `count()`, `scatter()` -- drawn by the hands' item pool, the items fanned in the arms' hollow; `scatter()` moves them into the loose list in state `fall` with random headings, so they fall, thud and roll with the drop physics and are pickable after. Carriers are taken lazily and held to `CARRIERS` 16, one per resident leafkin, since a leafkin gathers whether or not it is drawn; `POOL_CAP` grows by `CARRY_MAX * CARRIERS`.

### Voice: `ambience.js`

A herd entry `{ layer: leafkin, clips: 'human' }` for the feet (`run-carry` on the run's beats); **one** panting loop, at the nearest resident body; the one-shots (chatter every `CHATTER_S` 1.5-4 s, a squeal per gather stop, the scream, a whimper every `WHIMPER_S` 2-5 s in flight) drained from the layer's `voices(into)` with a position, so the sound engine and the state machine never share a clock. The six `.m4a` were re-encoded to `.mp3`; `npc-leafkin-panting.mp3` was a genuine MP3 and plays as is.

### Multiplayer

The seed makes every client spawn the same leafkin at the same site, and nothing keeps their states together: your leafkin flees, mine goes on gathering; a dropped bundle is local too. The leafkin adopts creature sync (`_notes/creature-sync.md`, `src/sim/score.js`) when it lands rather than growing a third pattern.

## 3. The village: the first room

### What a room is

A room is what `ROOMS[id]` names: the overworld (`dir: 'world'`, its files, sky, hollows, leafkin) and the village (`village: true`, built in memory at boot). `bootWorld` reads the save and builds the room it names; `bootRoom(room, site)` is the swap: black over the view (a sphere on the camera, so it holds in XR), every layer disposed, the room's stack rebuilt (`buildRoom`), her feet `ARRIVE_M` 2 out from the site along its normal, facing along it (`faceAlong`). The clock, the backpack and the net come with her; what her hands hold is packed and restored (`restoreHeld`), except a creature, whose layer is gone -- it goes in the backpack if there is room, else it is lost. The banks (atlas, GLBs, clips) stay loaded, so the swap is the terrain build and the placement. The save carries `room`. Positions still cross the net without a room tag: a peer in the village is drawn to an overworld player near the origin, and vice versa; a `room` id on the pose is the deferred first cut.

### The valley: `rooms/village.js`

`buildVillage({ shell, house })` answers `{ heightmap, doc, spawn, exit, clearing, props, ground }` in ~25 ms, deterministic from `SEED`; the gate rebuilds it and checks it. Nothing in the height stack knows it is a room: the heightmap is a 1025² `Heightmap` over `WORLD_SIZE` at the overworld's 8 m texel, the layers a doc in the overworld's format, and the field the same `V2Height` with the shipped relief, so the 10 cm detail, the road carving and the lake and river cuts are the overworld's. The terrain worker seeds itself with `SEED` and calibrates the detail from the heightmap it is sent, so a room has one seed and the map itself must calibrate like the overworld's: the valley's `rough` comes out 0.053 against the overworld's 0.068 (the gate wants the ratio within 0.5..2), and a cliff cut as steps or lumps under ~100 m pushed it to 3x. **The tile repeats**: the valley is one 32-texel (256 m) tile evaluated once about the origin and laid across the map, since the field's altitude bands and calibration read the whole map and a map that is one value with a hole in it hands them nothing; the lumps die over the cliff so the plateau is flat and the tile periodic.

The ground, in metres about the room's axis, the macro a rough perlinified bowl and the micro the overworld's detail:

- **The floor** `FLOOR` 60 m (over every scatter's elevation floor), flat to `RISE.from` 56 m out, then up `RISE.grade` 0.3 to `RISE.max` 10 m -- metric, not a fraction of the rim, so the huts' yards (out to ~58 m) stand on the floor and the room's tight side rises less. A 12 m domain warp (`WARP`, λ 90) on the bowl and the lumps, so the valley is no ellipse; **lumps** `LUMPS` ±4 m at λ 120 over two octaves and **divots** `DIVOTS` 1.6 m at λ 30, both at `CALM` 0.25 inside the clearing and full past 30 m outside it; a 1.5 m dip into the lake, within `DIP.still` 30 m of which everything but the dip fades, so the river's mouth meets the ground the lake's level was chosen against (paths.js pins a mouth to a lake only within a channel depth of its ground).
- **The cliff and the rim**: the shell is read once at `top` (103.6 m) on every degree; the rim is `CLIFF.in` 24 m inside that wall, and past it the ground climbs at grade 1.4 (54°, over her 50°) to `top`, so she cannot walk to the stone and the terrain goes into it where the wall stands at `top`. The 8 m reconstruction rounds the cliff's foot and top over a texel; the gate keeps 8 m off the foot and allows 2 m of lean.
- **Water**: one 14 x 12 m elliptical lake at `LAKE` (-13, 0), `FLOOR - 1.2`, 1.6 m deep, its bank under the walk limit; one river from `RIVER.source` (-52, 32), bent twice by 6 m, to the lake's own rim (`mouthQ` 0.75 into the footprint, so `flowReach` sees it arrive).
- **Paths**: 1 m roads. A trunk from the exit to the arc, and an arc of radius `ARC.r` 26 round the lake over 240°, both **wandering sinusoidally** (`WANDER` λ 12 m, amplitude 1.2 m) since random jitter never clears the no-straight-run rule (`STRAIGHT_M` 8 m within `STRAIGHT_DEG` 6°); chords cut, never filled, to 15° so the spline stays under `ROAD_GRADE` 18°. **No terraces**: a road's smooth blends in only the nearest road's height, so where two roads' feathers overlap on a slope the ground steps; the floor is flat under every road and yard instead, and the arc is cut level (`levelled`) across each hut's front, since a hut's footprint samples read the arc, not its yard.
- **Huts**: six huts of 5.5-9 m at bearings round the arc, each a step off the road with its door on it, and the 20 m great hut inside the arc, all facing the lake; each on a **yard**, a two-point road at the door's height and the hut's radius plus `YARD.margin`, feathered over 12 m, so the hut stands level. `props` is what `RoomProps` places from the shipped `house-leafkin` ladder: `[{ x, z, yaw, height }]`, the door on the pick's +X.
- **Scatter**: the same rocks (hollows off: no village inside a village), trees, ferns, grass, mushrooms, litter and deadwood against the room's field, the wood kept off the `clearing` (a 44 m disc on the axis, over the lake, the arc and every hut; the exit road runs through wood) and the huts through the trees' occupier.

### The shell, the light, the exit

The **shell** (`shell.js`) is **the rock bank's boulder she walked into**, on the bank's own stone layer, stood as the hollow bed stands it (a Z quarter turn), at `SHELL.scale` 160 with `sink` 0.4 of its height under the floor, turned inside out (index winding reversed and normals negated: a negative scale alone does not expose the inside, three flips the front face for it), front-face-only, the stone tiling at `TILE_M` 8 in world metres, and tinted as a placed boulder is (`Rocks.tintAt`, the bank shared: `rocks.bank === shell's`). `wallAt(y, bearing)` and `roofAt(x, y, z)` are rays against it, and the gate demands 3 m of roof over every walkable point.

The **light** is the overworld's: the same clock, hour, sun, hemisphere, fog and palette, unchanged, since the clock comes with her through the door. `sinkCave` only hides the sky, the stars and the aurora, which the shell closes over; the weather holds cover and rain at zero in a room and the wreaths off. A lit hole in the roof or lanterns are a later pass.

The **exit** is the same arch and quad, one fixed site from the build's `exit` on the +X rim (`EXIT.in` 3 inside it), its normal into the room; the same portal test sends her home.

### Gate: `scripts/check-village.mjs`

The build is deterministic, under 250 ms, at the overworld's pitch and seamless a tile over; the ground's sub-texel relief calibrates to the overworld's, the dry bowl stands over every scatter floor and is walkable short of the cliff's foot and the shore, and a cliff she cannot walk rings it on every bearing, meeting the wall within its lean; the river descends, reaches the lake and ends at its level; every road holds the grade, the wander and the dry ground, the trunk from the spawn to the arc; seven huts with one of 20 m, each door on a road, each footprint dry and level within 0.5 m, no road through a hut; the wood off the clearing, the lake and every hut inside it, and wood between the clearing and the cliff all round; 3 m of shell over every walkable point and over the exit, the shell drawn inside-out on the bank's boulder; the room boots on the real banks: the rocks share the shell's bank, no hollows, the shell takes a boulder's tint, one fixed mouth at the exit, the walk surface stands on the great hut, and she arrives dry, walkable and level with the mouth.

## Decisions taken

- The room is built in memory in the overworld's format at the overworld's 8 m texel; nothing ships for it.
- The bowl is a valley of its own inside the bank's boulder, not the boulder's underside; the shell is that boulder's mesh and stone.
- The light inside is the overworld's, on the same clock; only the sky, stars and aurora are hidden.
- `hollow` is a rock bed.
- The `house-leafkin` mesh ships; no stand-in huts.
- The mouth is 1.5 m and she does not duck.
- The startle range is measured feet to feet: the leafkin's ground point against her plan position, never her head.
- The leafkin is per client until creature sync lands (the aurora-game-22 build); the seed keeps the same leafkin at the same site on every client.
- `npc-leafkin-panting.mp3` is a valid MP3 and is used as is.
