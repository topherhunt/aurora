# §30 -- Leafkin and the leafkin villages

Every large forest has a hidden leafkin village: grubby elf-men a metre tall who grunt, squeak and pant to themselves while they bumble through the wood collecting mushrooms. See one and it squeals, drops what it carries and runs for home. Home is a dark hole low in the side of a giant boulder, easy to miss, and walking into that hole puts her inside the boulder: a glade of fern-lined winding paths, tall trees, a stream running to a small lake, and a clearing of shabby stump-huts around one great one. The leafkin are not friendly unless she brings them something they want. Later: leafkin at home in the village, and trade. Built in three pieces, each a thing on its own: the entrances, the leafkin, the village -- the last being the first **room** that is not the overworld.

## The files

| piece | where |
|---|---|
| entrance boulders | `rocks.js` `BEDS` `hollow`; `Rocks.hollowsInto` |
| mouths and the portal | `src/v2/render/entrances.js`; `main.js` `portalTest`, `PORTAL` |
| the leafkin | `src/v2/render/leafkin.js`; `public/creatures/leafkin.glb` (ladder + human library + `run-carry` + `gather`); `hands.js` `carry`, `CARRY_MAX`, `CARRIERS` |
| voice | `ambience.js` `SOUNDS` (`leafkinChatter1..4`, `leafkinSqueal`, `leafkinScream`, `leafkinWhimper`, `panting`), a herd entry on `FOOTFALLS.human`; `public/sounds/npc-leafkin-*.mp3` |
| the room | `main.js` `ROOMS`, `bootWorld`, `buildRoom`, `disposeRoom`, `bootRoom`, `sinkCave`, `CAVE`; `src/v2/render/room-props.js`; `src/v2/render/shell.js` |
| the village | `tools/rooms/make-village.mjs` -> `public/rooms/leafkin/{height.png, height.json, layers.json, room.json}`; `public/gen-props/house-leafkin*.glb`, `cave-mouth*.glb` |
| gates | `scripts/check-entrances.mjs`, `check-leafkin.mjs`, `check-village.mjs` (plus `check-hands`, `check-ambience`, `check-rocks`) |

## 1. The entrances

### Siting: the `hollow` rock bed

The entrance boulder needs 2 m of near-vertical face at ground level, in deep wood, never within 400 m of another. §25's giants cannot promise a standing stone on an open flank, so the entrances are a bed of their own: one candidate per 460 m tile jittered within 30 m of the tile's middle (so two are never nearer than 400 m by construction), `cover: 0.6` against the biome field (a hollow is always in forest), `maxSlopeDeg: 20`, not submerged, `stand: true` (the longest axis up), the burial pinned at `sinkRange [0.4, 0.41]` (never squashed, so the face is the hull's own), `anchor` and `blocks`, resident to 1250 m. A pure function of the tile seed like every bed. Tall giants were not made more common in general: only the entrance needs the face.

### The mouth

`Entrances` owns no scatter: every frame it asks the rocks for the resident hollows within `RADIUS_M` (400) and seats a mouth on each new one, so a site is where its boulder is and goes when the boulder goes. The face is found by rays against the boulder's own hull from a bearing rolled off the site's key (`PROBE`: 1 m out, eye 0.75 m, 2 m of wall within 20° of vertical, up to 8 bearings), so two clients agree on the mouth to the bit. The mouth is the shipped `cave-mouth` arch scaled to `MOUTH_HEIGHT_M` 1.5, sunk 0.1 m into the face along the normal, drawn on the props' ladder with the shipped T3 in the card's place (an arch is on a wall; a card spun to her would stand out of it), and a **black quad** -- unlit, `fog: false`, 1.1 x 1.3 m -- a hair proud of the stone across the arch's passage rather than a cavity: the depth test keeps it in front of the face and the arch's walls around it, and the parallax across the arch's protruding half metre makes it read as a hole.

`sites(into)` yields `{ key, x, y, z, nx, nz, r }`: the **mouth point**, `MOUTH_STEP_M` 0.7 in from the face along the outward normal, for the leafkin and the portal. A room passes `fixed: [site]` instead and gets that one mouth, at that point, on nothing.

### The portal test

The slope limiter is not replaced: `player.js` refuses the step into the face and slides, as it must at every other boulder. `portalTest` runs after the step: for a site within `PORTAL.reach` 20 m, she enters when her feet are within `walk` 0.9 m of the mouth point and the step ran into the face (`-(step · n) / |step| >= into` 0.5), or a teleport landed within `blink` 1.2 m; the door she stands in takes her once a visit (`portalIn`). Into a village she arrives at its own exit; out of one she arrives at the mouth she came in by (`cameInBy`). Refused in the editor.

## 2. The leafkin

### Pipeline

`rig-map.mjs` derives `rig-map.json` from the Tripo biped rig (the `--forward` flag names the facing axis where the rig's own guess is wrong), the skin ladder cuts the tiers, the clip solver bakes the human library plus two new specs, and `ship-biped.mjs` with `'leafkin'` in `BIPEDS` writes `public/creatures/leafkin.glb`. The two clips are human-library specs, so every biped gets them: **`run-carry`** (the run gait with the arms held still, raised and bent so the hands meet at the chest; its speed is the run's) and **`gather`** (a pose clip, `loops: false`, ~0.9 s: crouch, spine forward, one arm to the ground; the key at t 0.5 is the reach). The snowman was re-shipped with the grown library. The 12 villager GLBs were not.

### Runtime: `leafkin.js`

Snowmen's puppet, tiers, FootIK and fade, with the scatter replaced by **one leafkin per resident entrance site**, seeded from the site key and its spawn tick. It steps on the score's fixed ticks (`sim/score.js`) so two instances stepped on different frame times agree to the bit; `SIZE_M` 1 ±15%; drawn only within `critterTier`'s cull (~36 m for a metre of body), minded as long as its site is resident.

| state | what | leaves when |
|---|---|---|
| **roam** | a target inside the site's `ROAM_M` 200 disc every `RETARGET_S` 5-15 s, walked (run-carry with a bundle) on a heading driven by a damped oscillator about the bearing (`WOBBLE_*`), so the path arcs and doubles; every step probed on the walk surface, a refused probe turning it away by `DETOUR`, `REFUSALS` 10 in a row picking a new target | a cap within `SEEK_M` 3 -> gather; her feet within `STARTLE_M` 3 of its feet -> startle |
| **gather** | run to the cap, the gather clip, `mushrooms.take` at `GATHER_KEY`, the cap into the bundle (`CARRY_MAX`); then the next cap in reach, else roam. A full bundle stops the gathering. Mushrooms are only drawn within ~55 m of her, so only those are gathered | no cap in reach -> roam; she is near -> startle |
| **startle** | stop, face her, recoil, the bundle scattered, a scream; `STARTLE_S` 1 | -> flee |
| **flee** | run straight at the mouth point, a refused step sliding along the obstacle (`SLIDES`), the slide committed | within `HOME_M` 0.6 of the mouth, or out past its cull -> gone |
| **gone** | despawned; the site empty `EMPTY_S` 300 | the time up and her inside `ROAM_M` -> a fresh spawn at the mouth |

A leafkin is not constructed in a room (`ROOMS.leafkin.leafkin` false).

### Carrying and dropping: `hands.js`

`carry(owner)` returns a carrier -- `add(record)`, `place(x, y, z, yaw)` per frame, `count()`, `scatter()` -- drawn by the hands' item pool, the items fanned in the arms' hollow; `scatter()` moves them into the loose list in state `fall` with random headings, so they fall, thud and roll with the drop physics and are pickable after. Carriers are taken lazily and held to `CARRIERS` 2 (two villages 400 m apart can both be resident); `POOL_CAP` grows by `CARRY_MAX * CARRIERS`.

### Voice: `ambience.js`

A herd entry `{ layer: leafkin, clips: 'human' }` for the feet (`run-carry` on the run's beats); **one** panting loop, at the nearest resident body; the one-shots (chatter every `CHATTER_S` 4-12 s, a squeal per gather stop, the scream, a whimper every `WHIMPER_S` 2-5 s in flight) drained from the layer's `voices(into)` with a position, so the sound engine and the state machine never share a clock. The six `.m4a` were re-encoded to `.mp3`; `npc-leafkin-panting.mp3` was a genuine MP3 and plays as is.

### Multiplayer

The seed makes every client spawn the same leafkin at the same site, and nothing keeps their states together: your leafkin flees, mine goes on gathering; a dropped bundle is local too. The leafkin adopts creature sync (`_notes/creature-sync.md`, `src/sim/score.js`) when it lands rather than growing a third pattern.

## 3. The village: the first room

### What a room is

A room is a set of world files under `ROOMS[id].dir`: the overworld (`world/`, sky, hollows, leafkin) and the village (`rooms/leafkin/`, plus a `room.json` with its `seed`, `spawn`, `exit`, `shell`, `clearing`, `fog` and `props`). `bootWorld` reads the save and builds the room it names; `bootRoom(room, site)` is the swap: black over the view (a sphere on the camera, so it holds in XR), every layer disposed, the room's files loaded and its whole stack rebuilt against them (`buildRoom`), her feet `ARRIVE_M` 2 out from the site along its normal, facing along it (`faceAlong`). The clock, the backpack and the net come with her; what her hands hold is packed and restored (`restoreHeld`), except a creature, whose layer is gone -- it goes in the backpack if there is room, else it is lost. The banks (atlas, GLBs, clips) stay loaded, so the swap is the terrain build and the placement. The save carries `room`. Positions still cross the net without a room tag: a peer in the village is drawn to an overworld player near the origin, and vice versa; a `room` id on the pose is the deferred first cut.

### The room's field: the overworld's format, unchanged

The room heightmap is a full 1025² file over `WORLD_SIZE` at 8 m per texel (`height.png` ~1.4 MB, mostly one value); nothing in the height stack knows it is a room. No windowed heightmap was needed. The 10 cm detail, the road carving and the lake and river cuts resolve at full resolution regardless of the texel, so the paths, the banks and the shore are as sharp as the overworld's. The editor works the room file unchanged. 120 m was tried first and kept; 200 m remains the fallback if it reads as a lump.

### Generating the village: `make-village.mjs`

A script writing the four files from `SEED`, deterministic and gate-checkable; `check-village` rebuilds it in memory and demands the shipped files match. What it lays down, in the room's own metres about the origin:

- **Ground**: `FLOOR` 60 m, flat to 0.8 of a 60 x 60 m bowl, then a gentle `RISE` 4 m climb to the rim, a dip of 1.5 m into the lake, a 1.5 m roll on the rim, and past the `WALL` ellipse a cliff at grade 2.5 to 40 m, so she cannot walk to the shell. **No terraces**: a road's smooth blends only the nearest road's height in, so where two roads' feathers overlap on a slope the ground steps; the floor is flat under every road and yard instead.
- **Water**: one river from the far rim to the lake's own rim (`RIVER.mouthQ` 0.75 into the footprint, so `flowReach` sees it arrive), one 14 x 12 m elliptical lake at `FLOOR - 1.2`, 1.6 m deep, its bank under the walk limit.
- **Paths**: 1 m roads. A trunk from the exit to the arc, and an arc road of radius 26 m round the lake over 240°, both **wandering sinusoidally** (`WANDER` λ 12 m, amplitude 1.2 m) since random jitter never clears the no-straight-run rule (`STRAIGHT_M` 8 m within `STRAIGHT_DEG` 6°); chords cut, never filled, to 15° so the spline stays under `ROAD_GRADE` 18°.
- **Huts**: six huts of 5.5-9 m at bearings round the arc, each a step off the road with its door on it, and the 20 m great hut inside the arc, all facing the lake; each on a **yard**, a two-point road at the door's height and the hut's radius, so the hut stands level. `props` in `room.json` is what `RoomProps` places from the shipped `house-leafkin` ladder: `[{ x, z, yaw, height }]`, the door on the pick's +X.
- **Scatter**: the same rocks (hollows off: no village inside a village), trees, ferns, grass, mushrooms, litter and deadwood against the room's field, the wood kept off the `clearing` (a 44 m disc over the lake, the arc and every hut; the exit road runs 30 m through wood) and the huts through the trees' occupier.

### The shell, the light, the exit

The **shell** (`shell.js`) is the rock bank's boulder turned inside out (index winding reversed and normals negated: a negative scale alone does not expose the inside, three flips the front face for it), fitted to `room.shell`'s 176 x 176 m box from 30 m under the floor to 48 m over it, front-face-only on the stone atlas tiling at 8 m in world metres. The gate demands 3 m of roof over every walkable point.

The **air** is `sinkCave`'s: `room.fog` (near-black, density 0.012) in place of the overworld's, the sun at `CAVE.light` 0.35 and the hemisphere at 0.5 of the clock's, the sky, stars and aurora hidden, so noon is a warm grey and night blue-black with no sky to say why. A lit hole in the roof or lanterns are a later pass.

The **exit** is the same arch and quad, one fixed site from `room.exit` on the +X rim, its normal into the room; the same portal test sends her home.

### Gate: `scripts/check-village.mjs`

The generator reproduces the shipped files; the dry bowl is walkable everywhere and ringed by the cliff; the river descends, reaches the lake and ends at its level; every road holds the grade, the wander and the dry ground, the trunk from the spawn to the arc; seven huts with one of 20 m, each door on a road, each footprint dry and level within 0.5 m, no road through a hut; the wood off the clearing, and the lake and every hut inside it; 3 m of shell over every walkable point and over the exit; the room boots on the real banks: no hollows, one fixed mouth at the exit, the walk surface stands on the great hut, and she arrives dry, walkable and level with the mouth.

## Decisions taken

- The room is a world file in the overworld's format; the room heightmap keeps 8 m texels; 120 m first, 200 m if it reads as a lump.
- The bowl, the river, the lake, the paths and the hut placements are all generated by `make-village.mjs`; the bowl is a shallow bowl of its own, not the boulder's underside.
- `hollow` is a rock bed.
- The `house-leafkin` mesh ships; no stand-in huts.
- The mouth is 1.5 m and she does not duck.
- The startle range is measured feet to feet: the leafkin's ground point against her plan position, never her head.
- The leafkin is per client until creature sync lands (the aurora-game-22 build); the seed keeps the same leafkin at the same site on every client.
- `npc-leafkin-panting.mp3` is a valid MP3 and is used as is.
