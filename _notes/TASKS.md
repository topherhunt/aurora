Claude: Do NOT modify this file. This is Topher's notes. You can suggest tasks, you can reference tasks, but don't add or remove stuff here.

### Notes

- Resources:
  - <https://sketchfab.com/>
  - <https://polyhaven.com/>
  - https://www.opensource3dassets.com/en
  - [Stone textures](https://seamless-pixels.blogspot.com/2012/09/free-seamless-stone-textures.html)
  - https://quest3-playground.pages.dev/
  - https://www.meshy.ai/features/ai-animation-generator
  - https://developers.tripo3d.ai/en/pricing
  - https://developers.tripo3d.ai/en/docs/quick-start
  - https://developers.tripo3d.ai/en/docs/animations-retarget
  - https://www.mixamo.com/#/?page=1&type=Motion%2CMotionPack
  - [Claude - AI animation tools](https://claude.ai/chat/801dd461-e625-4511-8b37-8e283541e6fe)
  - [Skyrim trees](https://duckduckgo.com/?q=skyrim+tree&iar=images&iai=https%3A%2F%2Fimg.goodfon.com%2Fwallpaper%2Fnbig%2F0%2F5d%2Fskyrim-tes-5-elder-scrolls-fir-tree-stone-grass-mountain-fog.jpg) pics
- Internal tools
  - https://192.168.178.75:5173/gen-tree
  - https://192.168.178.75:5173/gen-fern
  - https://192.168.178.75:5173/gen-rock
  - https://192.168.178.75:5173/gen-deadwood
  - https://192.168.178.75:5173/gen-mushroom
  - https://192.168.178.75:5173/gen-building
  - <https://192.168.178.75:5173/test-aurora>

### Tasks

- [ ] Leafkin
  - [x] Meaning, we need an inventory system.
  - [x] Leafkin actually take mushrooms, carry them in their hands and against their chest, and if startled will drop them all on the ground.
  - [x] They sit and gaze at the campfire.
  - [x] Debug: The leafkin glade takes an unreasonably long amount of time to load into in Quest 2 vr. Maybe the map gen process is part of that? We want to get it to under 2 seconds. The 4km-by-4km square map probably is part of it. Can we refactor so rooms can be smaller than that? And don't place props outside of the world map boundary, that's just a waste of compute and triangles.
  - [x] Debug: leafkins are not netplay-synced. Leafkin gatherer (outside the glade) was visible to my sister but not to me. And then in the village also, leafkins are doing totally different things for one of us vs the other, they aren't synced.
  - [ ] Leafkin in their glades: They're unfriendly and push you away if you try to talk to them UNLESS you bring them something they want. Then they're eager to talk.
  - [ ] Leafkin glades hold puzzles:
    - Each glade has an assigned song.
  - [ ] A giant deer-skull, either a house, or on top of of a house?
  - Leafkin hobby: catching frogs (frogs run away from them) and carrying them around and putting them beside their home.
- [ ] terrain-v3
  - [ ] Simpler approach to hydrology:
    - Identify all sealed water pockets.
- [ ] Use Eleven Labs for better sound effects.
- [ ] You don't start the game outside in the open world. You start the game waking up on a table on a hilltop glade in one such leafkin village, listening to creepy leafkin chanting and drumming. When you first make a movement, you hear them shriek in startlement and then the pitter-patter of feet running away. Your view fades in from black, and you're sitting on a ceremonial table in a lush leafkin village-glade. You wander around, the leafkin are frightened and hiding and want nothing to do with you, they run away from you and cower and wimper if you corner them. You find your way to the exit from the village, and open out into the wider world.
- [ ] Add a 2nd pine texture with blotchy snow cover. Apply that to outer tris of each bough, and make this the tree instance to use above the snowline. Use the SAME standard tree card & clump card though, so it's only for LOD0 & LOD1.
- [ ] Snowpeak quest: the yetis follow you until you leave the snowline or reach a giant skeleton. If they see a giant skeleton, they will kneel down and start praying in front of it. If you get three Yeti's praying around a giant skeleton, then the skeleton will rumble and shake and come to life and start roaming around the countryside, at which point the Yeti's will run away screaming (skeleton wakefulness is persisted world state in your savefile).
- [ ] Snowpeak quest: if you get too close to a yeti, it will make threatening sounds and then hit you which knocks you back. At which point it will laugh and resume normal conversation. Yetis will follow you if they see you. If you give a yeti a flower (occasionally NPCs in human villages will mention that they've heard Yeti's Love Flowers, human village NPCs are a good source of hints about what you can do in the world. If you can get reliable information out of them, since sometimes they just make stuff up to sound impressive.) then the Yeti will hold the flower, gaze at it for a while, totally lose interest in you, and then walk back to its village. Yeti villages are inside entrances in giant rock sides, covered by a rock slab. When a yeti goes back to its village, it moves the rock slab for 3 seconds, and if you're fast, you can sneak in behind it. This lets you into the world of the Yeti village, which is in the gigantic interior of a rock similar to leaf kin villages. There are paths and hillsides and terraces and flowing water, trees and huts and yetis roaming around doing their thing. If they discover you, they will scream in shock, become aggressive, push you or knock you back a couple of times, and then pick you up and evict you from the village. But if you stay out of their line of sight, you can sneak around and find some valuable items. Also, some yetis are approachable and will even talk with you and help you if you are holding an item that they value or want.
- [ ] Human villages. If you do a favor for the potionmaker, he'll thank you by giving you a flare gun. Flare guns shoot out permanent flares which hover and shimmer in the air forever -- but you only have 10 charges. If you run out, you'll need to do another potionmaker another favor. and other human NPCs have similar such quest lines.
- [ ] another human villager quest is that there's a person who says that they've always dreamed of having a pet deer. And if you figure out a way to lead a wild deer into their fenced yard and close the gate, then they will be over the moon about it and will give you something cool as a reward. Same with pet foxes and pet rabbits and pet frogs (maybe multiple in the latter case). Deer and rabbits can be led by holding a carrot. Foxes can be led by holding a chicken egg. (Oh yeah!! Villages are full of chickens!) Frogs and fish can be led by holding a butterfly or a spider. Again, this sort of information can be gleaned by talking to human NPCs who bring it up in a natural way, like mentioning that they did a certain thing, but sometimes it can be hard to distinguish between truth and tall tales.
- \[ \]
- [ ] Adjust the terrain to be more jagged:
  - Peaks need more jaggedness.
  - sheer cliffs: lips at tops & bottoms of many cliffs, rather than rounding (ie steep angles tend steeper)
- [ ] Lakes: Bake the shoreline cutout (there may be multiple) and render the lake as a mesh whose shape roughly follows the shoreline, roughly 1 vertex per 10m of shoreline (all poking 1-2m into the ground). When viewed from much higher up, lakes should be raised up 5m so they don't z-fight with the terrain.
- [ ] Rivers:
  - [x] Tributaries that fold in, should never be fully coplanar.
  - Keep the height even until it risks breaking above the landscape level, then drop down in an abrupt cascade. Have foam spraying up (white camera-rotated circles, dithering to fade out slowly).
- [ ] Creatures' states should sync up between different players in the same room. How to do this, performantly?
  - creature behavior is random but deterministic if given the same inputs
  - any interaction events caused by one player are broadcast to the other, so the creature state can be replayed based on that....?
- 
- [ ] Skeleton creatures roaming around at night. During the day they're just bone piles.
- [ ] Procedural villages. A couple big buildings in the center, surrounded by progressively smaller and humbler buildings as you go outward. A market square with stalls of various goods for sale. Various trade workshops with realistic props and people doing their work there. NPCs walk around town doing their business, walking into and out of buildings and talking to each other.
- \[ \]
- [ ] Pine tree idea: inner faces of each bough are solid, outer fringe is frayed? So each mesh has multiple materials (on different faces) but there's not a lot of transparency fill?
- Get VR looking passable
  - [ ] Aspen trees (yellow)
    - Let's have the oak foliage be ONE giant sealed mesh, with lots of lobes and bumps that span multiple vertices so it feels lumpy but not jagged-pointy.
  - [ ] Characters
    - [ ] A snake, slithering through the grass.
    - [ ] A boar -- don't startle it or it will charge you and knock you back, giving you temporary star-spangle.
    - [ ] Songbirds, flitting through the trees. InstancedMesh, one for sitting and one with wings open, color tintable to denote different species. LOD0 + LOD1, no card needed.
    - [ ] Hawks wheeling around cliffs.
- ...
  - [ ] simple shadows.
  - [ ] procedural towns, grown around a seed central location. Procedural roads between them. Each has a stable w horses you can take.
  - [ ] procedural house interiors. Hearth and chimney, table, food, dishware, beds, storage barrels, shelves, chairs, divider walls, stairs down to cellar, candles (cast light), torches, windows.
  - [ ] procedural caves. Mazelike
  - [ ] procedual flowers.
  - [ ] Multiplayer: support shooting up a flare that other players can find each other.
- 
- [ ] Procedural bushes - Scattered throguhout the forest like trees, but with different LOD thresholds. 2 sizes x 2 random seed rolls x species.

- [ ] Leaf atlas and lichen atlas - scatter onto boulders & forest floor. (Moss is done for boulders -- see the moss bullet under nature props; trunks are the next entry in `MOSS_LAYERS` and need a height cue first.)

- [ ] Clear out the scanned 3D assets that are bad-quality & not worth keeping

### Wishlist

- A complex achievement ladder of things you can get. Advanced tools etc which each require coordinating / solving many quest-pieces to achieve.
- [ ] Ruins (in caves?) full of statues that move when you aren't looking, like Weeping Angels. A whole class of monster/creature that you can never actually see move, or hear or talk with, and yet it can pose dangers and opportunities and provide hints to you, ask for help and offer points of help in return.
- [ ] Idea for a creepy rare wilderness encounter: on misty days, ghosts that pull you into an alternate dimension, where you start hearing creepy sounds and see hints of something sinister following you, and no matter where you go, the world is empty, there's no creatures or NPCs anywhere.
- [ ] Cheap API-fed TTS so NPCs can actually speak to you with realistic voices.
- [ ] Water sfx by pond size: play `water-lapping-wave-1.mp3` only where a lake is large enough for a wave to break on its shore, and `water-lapping-quiet-1.mp3` alone on small ponds (for now the village lake alone is quiet, via `Ambience`'s `waves` option).

- [ ] Keep the gen-prop GLBs loaded across a room swap. `loadGenProp` (render/gen-props.js) re-fetches and re-decodes every GLB on each room build -- walking into the glade and back out reloads the same meshes twice, which is still a few hundred ms of the swap. Cache each bank by URL for the life of the session. The blocker: eight beds (deadwood, bones, carrots, rowboats, entrances, roosts, lamps, room-props) free bank-owned geometry and maps in their own `dispose()`, so the cache needs the banks to own their assets and the beds to stop disposing what they borrowed.

- [ ] Props should cast shadows on the terrain and on other props. See \_notes/local-shadows.md.

- [ ] Weather

  - [x] Randomly changes / comes and goes
  - [ ] Fucking AMAZING. Now: clouds should be in front of, and block, the aurora. At night when there's clouds, they generally seem "behind" the aurora; they should not be.
  - [ ] Rain & snow: visibility distance
  - [ ] Rain at temperate elevations, snow once you reach snowline
  - [ ] Low-lying cloud cover in mountains sometimes
  - [ ] Performance-efficient mist clouds floating around/between distant mountains, drifting slowly

- [ ] Procedural buildings: Vertical wooden beams should be segmented rather than joining two separate wooden beams end to end, since the latter (current) approach wastes those end-face triangles and creates ugly cracks. Also, I noticed many corners where there's two wooden beams placed overlapping on top of each other and that doesn't make any sense. Also the top of wooden beams should rise to intersect with the roof plane rather than just being a flat horizontal cap below the roof where it's clearly not supporting anything. Also, house walls waste vertices; each wall has more vertices along the roof line than the roof has horizontal seams where it can bend. We can save 20-80? tris per house by ensuring walls don't have more triangels than they need to in order to match the warping of the roof plane.
- [ ] Spike: Procedural buildings, from a kit system?
  - [ ] I'd need to hand it a bunch of screenshots of skyrim buildings, for it to get art-element-inspiration ideas. And hand it a bunch of textures for wood beam, cut timber, shingle, thatch, stone/cement wall, door, window, etc.
  - [ ] Props: wood chopping piles, axe & chopping block, barrels, baskets of food, market stalls, etc.
  - [ ] Research first: Would it be faster/easier to just gen 8 med-poly buildings with Meshy and use those instead of making it actually procedural?

- [ ] Procedural caves

  - [ ] Cave-wall meshes that can open up to different sizes and have regions with different tints, darknesses, biome foliage, etc. Very dark by default, some local procedurally placed lights or glowing foliage (lighting baked for performance)

- [ ] Wild creatures roaming around, walking or running or flying (songbirds, eagles, deer, mythic creatures). They pause and turn to look at you when you get close

- [ ] A creature let go from the hand should run, swim or fly off the same way for everyone. Today a released creature exists only in the releaser's world (hands.js `release`; hands-net.js syncs held and dropped things, not creatures). Once creature behaviour is a deterministic function of a shared seed and a shared timestamp (the cross-player creature sync work), a release is one small message: kind, spawn pose, seed, room time; every client spawns the creature into its own layer and the same seed walks it the same path. Nothing streamed after the spawn.

- [ ] Creatures' poses fitted to the slope naturally. Bodies stand on the world vertical now, so on a hillside a stag's uphill feet sink into the ground and its downhill feet float. The real fix is foot IK (runtime inverse kinematics): a ground probe under each foot, a two-bone solve per leg to plant it, and the pelvis dropped to the lowest reach -- a body-height row of the same walk.js probe the creature already pays once, times four, plus a bone solve per drawn creature per frame. Cheaper stand-ins that get most of the look: a baked uphill and downhill variant of each gait clip blended by the slope under the body, or just pitching the body a few degrees toward the slope, capped well short of the ground's normal. Far down the roadmap, and worth a measurement on the Quest 2 before committing to the IK version; the blend-pose version costs nothing at runtime.

- [ ] Foot IK for a seated leafkin. A villager on a stool is placed by its butt: the stool is cut so its top lands a metre-tall leafkin's seat height (`SEAT_M` 0.19) over the ground its feet will stand on, and the body hangs from that, so the contact with the wood is exact by construction. What the cut cannot absorb is the sitter's own size roll (0.85-1.15): a big one's feet ride up to 4.4 cm off the ground, a small one's sink. The fix is the same two-bone solve as the row above, but only from the knee down and only against the ground under the foot, with the pelvis left where the seat puts it -- the opposite of `puppet.js`'s `FootIK`, which drops the root onto the ground and would pull a seated body off its stool (which is why the sit clips are kept out of `PLANTED`). See `design/30-leafkin.md` §30 stools.

- \[ \]

- [ ] Fog

- [ ] River water renderer

  - Shader for flowing water. Narrower = faster, wider = shallower. Steeper = faster. beyond 45deg = waterfall, with emitted spray clouds.

### Later

- [ ] Try again at subdividing ridgelines. When rendering an LOD for a region (just then, not per-frame), as seen from the player's current standpoint, any edge that's > N arc-minutes of view that borders a hidden / backfaced triangle, should get subdivided until it's < N arc-minutes of view. (help me pick a reasonable N.)
- You can sleep in any bed, to pass time. If in multiplayer, all players need to be in a bed. If it's after sunset, you wake up at sunrise. Otherwise 8h pass.
- Ensure inward faces are culled as appropriate. (Tree trunks & branches, boulders, etc?)
- Underwater shader
- Lakebed seaweed!!! Some very tall
- Lakeside & lakebed boulders
- Terrain LOD: How to preserve toothy peaks while minimizing triangles used in terrain rendering?
  - Idea 1: define billboard triangles for distant peaks (1 "layer" that provides 1 "resolution" more of terrain than what the actual LOD allows for at that distance, created only when the lower LOD loses a hill/protrusion that's added when you get closer)
  - Idea 2: "skyline backdrop" ???
- https://192.168.178.75:5173/map.html

### Gameplay mechanics

- Quest mechanic: You need to go to a place to verify something, or talk to a person and get some piece of information from them (in some cases, without alerting them to your intentions), and then report back to the requester and (in dialogue) actually compose or select the correct information, meaning, you actually need to REMEMBER what you see. The game state doesn't remember it for you.
- Quest log is minimalistic and just gives you reminders of who's asked you what, or what interesting things you found. It doesn't baby you, it doesn't tell you literally every step you need to take. Each quest is an environmental puzzle, and if you're not smart enough / attentive enough to solve it, your loss.

## Props -- follow-ups

The Blender pipeline is built and gated (`npm run props`, `scripts/check-props.mjs`, DESIGN.md §9). 154 assets, 120 texture layers of a guaranteed 256, 75.6k triangles across every LOD. Nothing in the runtime loads any of it yet -- that is the next piece of work, and it is the larger half.

`public/props` is untracked and built locally, so anyone picking this up needs `npm run props` (needs Blender) before `check-props.mjs` will pass.

- [ ] **Load** `public/props` **at runtime.** `src/props/scatter.js` still builds every prop procedurally from `shapes.js`. It needs to fetch the GLBs, pack the LODs into a `BatchedMesh` per material, and switch tiers with `setGeometryIdAt` at the per-class distances the manifest already carries (`lod0_m`, `billboard_m`, `cull_m`).

- [ ] **Build the** `uArrAsset` **DataArrayTexture** from the 120 layer PNGs (21 albedo, 99 impostor sheets) and give each *tier* its layer index -- the index is per-LOD now (`lods[i].layer`), not per-asset, because each mesh tier is unwrapped and baked separately. The layers are all 128^2 RGBA and the gate enforces it, so the array upload should be mechanical.

- [ ] **The TREE card tier is still not wired into** `scatter.js`. The fern's is (see the fern bullets above), and the pattern it established is what the tree should follow: a sync geometry half in the `Scatter` constructor, a pixel half chained off `loadImageLayers()`, and a second kind sharing the near kind's geometry bank through `geometryFrom` so reach and density can be tuned apart. The tree's bake and card builder work today but are reachable only from `gen-tree.html`.

- [ ] **Biome-sensitive placement rules.** Phase A already reports bare/pine/mixed/heath/lush per cell; the scatter tables that map biome to species mix and density do not exist yet. §5 says density is the lever the look hangs on, affordable to ~0.2 stems/m^2. The whole of `src/v2/` mentions the word "biome" exactly once, in a comment in `render/deadwood.js` that is about something else, so nothing in the shipped route reads a biome today: every tree is `(rand() * variantCount) | 0` over four species at a flat `DENSITY = 0.05` and a flat `SCALE = [0.5, 1.5]`. Sub-items below are the shape of the answer, roughly in dependency order.

  - [ ] **Two named axes plus one unnamed one, and the first two already exist.** `biomeWeights()` in `sim/phase-a.js` is the design: altitude relative to the LOCAL snow line crossed with moisture, both soft, `mid` falling out as what is left rather than being its own smoothstep, so the five weights sum to 1 with nothing to keep in sync. Do not redesign that. **What it does not have is the clearings-vs-dense axis**, and that should NOT become a sixth band: a clearing is the same species mix at a fraction of the tree density with the grass bed filling in behind it, so it is a low-frequency multiplier on density, not a new biome. One octave at ~200-400 m, one number, applied to the keep threshold. A sixth band would need its own row in every table and would fight the border jitter that already exists.
  - [ ] **v2 has no moisture field at all, and that is the actual blocker.** `biomeWeights` takes `(h, moist, snowLine, x, z, jitterNoise)`; v2 can answer `h` (`field.scatterAt`) and `snowLine` (`field.snowLineAt`, the authored `SnowField`) and has nothing for `moist`. Phase A derives it from a flow-accumulation raster that the v2 route does not run -- v2's terrain is an imported heightmap and its water is authored. So moisture has to be rebuilt from what v2 actually has: `layers.paths.nearest(x, z, 'river')`, the `LakeSet`, and a low-frequency wet/dry belt. The constants to start from are `MOISTURE` in `phase-a.js`, which are measured rather than picked -- reach 250 m e-folding, `nearWater` 0.55, `regional` 0.45 at freq 0.00035, `altitudeDry` 0.3, `base` 0.3 -- and the 250 m is load-bearing: at 420 m the proximity term read ~1 across every valley, "low and dry" became impossible and heather fell to 1% of the map.
  - [ ] **Bake moisture as a grid, do not query paths per candidate.** `SnowField` already proved the pattern and it is the reason the snow line costs the same whether there are three authored points or three thousand: a 1024^2 Float32 over 16 km is 16 m/texel and 4 MB, baked once, re-baked only inside the layers' dirty rect, and read per vertex as a bicubic tap. Moisture wants exactly that -- otherwise every tree candidate pays a `paths.nearest` walk, and trees.js is already paying one `scatterAt` per candidate. 16 m/texel is coarse for a riparian strip whose e-folding distance is 250 m, which is fine; what it is NOT fine for is the last few metres against a bank, and that is the verge ramp's job below, not moisture's.
  - [ ] **Paint the INPUTS, not the biome id.** The manual override should be `SnowField` again -- `[x, z, ...]` points in `doc.js`, singular Shepard kernel, partition-of-unity mask so the field returns to the default with no ring, baked grid, dirty-rect rebake, `check-v2-layers.mjs` measuring that a query costs the same at any point count. The one design call: a biome brush paints a **delta on the two axes** (`dElevRel`, `dMoist`, and a third for the openness multiplier), NOT a biome id. Painting the axes keeps one pure function of two inputs, means a painted patch blends at its rim for free with no new blending code, and means the border jitter still wanders through it. Painting an id needs its own blend rule between neighbouring stamps, and hard-edged biome stamps is the failure mode.
  - [ ] **What biome drives, and how to apply it without reshaping the forest.** Three things: a density multiplier, a normalised 4-vector of species weights, and a per-(biome x species) height range replacing the global `SCALE`. **The constraint is the invariant already written into** `_fill` **in** `render/trees.js`: every candidate draws the same randoms in the same order whether or not it survives (`x, z, variant, yaw, scale, tintG, tintR, u`), so a tree's identity cannot depend on how many neighbours were rejected or on which band the tile has grown to. So biome must REINTERPRET existing draws and never add one -- density folds into the `u < uNew` keep test as a position-dependent threshold (still monotone in `u`, so the incremental `uOld`/`uNew` band growth stays correct: a widening tile only ever adds trees), species becomes a weighted pick over the same single uniform, scale is the same uniform read against a different range. Get this wrong and the forest changes shape when a lake is edited or when you walk toward it.
  - [ ] **Trees, rocks and litter do not test paths at all.** `paths.nearest` is called in `ferns.js`, `grass.js`, `mushrooms.js` and `deadwood.js` and in none of the other three, so trees currently grow through roads. Beyond fixing that, the road/river rule is a **signed-distance ramp per kind, not a boolean**: one shared `verge(x, z, kind)` returning `dist - halfWidth` (negative on the surface), because five scatters would otherwise each grow their own version of it. Trees 0 on the corridor and 0 for a couple of metres past it; bushes and ferns PEAKING one to three metres off the verge, which is §6's "increase prop density immediately alongside it -- the walled, wending, you-must-follow-this feeling" and which nothing implements; grass unchanged through the corridor but shorter. River banks want the same ramp with rocks, tall grass and ferns peaking inside a half-width of the bank. Rocks take the road half of this and explicitly not the river half -- §6 already settles that, a riverbed is the river, and the beds already have `river`/`submergedOnly` environments and a `sizeByEnv` range to say what a bank boulder is.
  - [ ] **There are no bushes, and this is not an art problem.** `BUSH_OVERRIDES` in `src/props/tree.js` is a signed-off preset -- 1.1 m, 138 triangles, 42 cards, branching from the ground at `firstBranch` 0.04 -- and it composes with any of the four species presets, so four species of bush already exist and nothing in `src/v2/` renders one. §5 already budgets the class (`bush`: 84/56/28 mesh tiers, 2-quad card from 26 m, 500 m cull, Batched then Instanced), and the snow ceiling comes free through `setLeafSnowVary`. So this is a new `src/v2/render/bushes.js` modelled on `ferns.js`, not a generator task. It is also what makes the undergrowth read as varied: the bush species should be picked from a DIFFERENT vector than the canopy's, so a pine stand can have birch scrub under it.
  - [ ] **The LOD ladder is already decided and should not be re-opened here.** §5's class table is the answer, thresholds are per class because they are set by the parallax rule (`billboard crossover ~ depth x 28.6`, which is 120 m for a 4.2 m tree and 14 m for a 0.5 m fern), and Batched-vs-Instanced is settled per row. The only row with no implementation behind it is `bush`.
  - [ ] **Start with two tables, not five.** The lesson §20 records from the bush preset is that adding every knob at once produced four species of identical bush. Same risk here, larger: five biomes x four species x per-kind density x a scale range is enough numbers to tune nothing. Ship the species-weight vector and the density multiplier first, leave the scale ranges flat, and only reach for per-biome heights once the mix reads right on a ridgeline.
  - [ ] **What a gate can hold.** Phase A's already holds each of the five bands over 2% of the map and that is what catches an axis collapsing. New: no tree inside road half-width + clearance (a boolean, cheap, and it is a real bug today); the sampled species mix in a patch matching that patch's biome vector; a painted point reading back exactly, which is the promise `check-v2-layers.mjs` already makes for the snow line; and the per-ring density law surviving the biome multiplier, in the shape `check-grass.mjs` and `check-trees.mjs` already assert it.

- [ ] **Compression.** No meshopt, no KTX2. 4.46 MB is fine to ship today, but the KTX2 array-texture round-trip is unverified and worth checking before the layer count grows.

- [ ] **Headset gate (§17).** §5's ladder predicts ~4,500 mostly-6-tri instances in view. §0 measured 8,000 instances but at ~190 triangles each -- the opposite regime, geometry-bound rather than instance-bound. The instance count is the untested number, not the triangle count.

- [ ] **Replacement sources for the excluded assets** -- see the shopping list in `tools/props/make-manifest.mjs`. Photoreal card foliage cannot be decimated (every leaf is its own quad, so the mesh is ~100% boundary edges and collapse does nothing at all); it has to be re-authored as cross-cards with a baked canopy, or replaced with game-ready low-poly. Run `tools/props/probe-source.py` on anything new **before** adding it -- boundary fraction plus measured floor called every accept and reject in the second batch without building anything.

- [x] **~~The albedo bake comes unstuck from the mesh when the mesh decimates hard.~~** Fixed: `consolidate_texture` now runs per LOD tier, after decimation, so each tier's UVs describe that tier's own triangles. `grass_tall_scan_a` went 5% → 89% of its UV footprint surviving alphaTest, `forest_floor_cluster` 0% → 100%. Costs 6 more array slices (114 → 120). DESIGN.md §9.

- [ ] **The 4 remaining stalled LODs are boundary stalls, and the seam theory for them was wrong.** I had recorded that unwrapping after decimation would unblock them; it did not move them by one triangle. Decimating `grass_tall_scan_a` to a 16-tri target gives 83 with its source UVs, 83 with every UV layer removed, and 83 with Smart UV Project applied first. The floor is the mesh's 46.1% boundary-edge fraction, and nothing in the UV path touches it. Fixing these means re-authoring the sources (same conclusion as the card-foliage bullet above), not reordering the pipeline.

- [x] **~~Every textured asset's impostor sheet is black.~~** Fixed: `finalize_material` installs the real baked atlas, and the 1×1 export stub is swapped in by `swap_to_stub` *after* `render_billboard` instead of before it. All 9 affected sheets now carry real albedo.

- [x] `windmill`**~~'s albedo bakes pure black.~~** Fixed, and the source was blameless: it carried `metallicFactor: 1.0`, and a Cycles DIFFUSE bake of a fully metallic surface is black by definition. `neutralize_pbr` zeroes Metallic, Transmission and Specular (links included -- `watchtower` drives the same input from a map) before every bake. windmill went RGB (0,0,0) → (112,75,41).

- [x] **~~Four grass variants and two trees shipped broken, and only a render caught them.~~** Excluded, with reasons recorded in `make-manifest.mjs`. `grass_tall_scan_a/b/c` and `grass_wild_scan_a` were crushed rather than simplified -- 84-88% of their triangles under 1 cm², presenting 0.1-3.9% of their own silhouette, rendering as a dozen specks while every check passed them. `tree_deciduous_hi` had a canopy of 0.8 grey (its leaf material references no image at all). `tree_oak_hero` at its floor was 1,794 twig cards, 5 trunk polygons and zero leaves. `check-props.mjs` now measures world surface area and degenerate-triangle fraction, so this class fails the gate instead of shipping. DESIGN.md §9 bugs 10-11.

- [ ] `fern_polypody` **is thin and it is an art call, not a bug.** It keeps 29% of its UV footprint through alphaTest and spends 6 of its 15 triangles on slivers, which is what a frond made of alpha cards genuinely looks like at that budget -- it passes the crush check because the other 9 triangles are a real fern. The question is whether 15 triangles can be a fern at all. Same for `grass_wild_scan_b`/`_c` baking at mean RGB 20 and 12: all the `grass_wild` variants share one 8K map averaging (64,64,36), so the dark ones are clumps that sat in shadow in the scan.

- [ ] **A replacement hero tree.** Two trees came out of the library above and nothing has taken their place. The want is authored low-poly cross-cards with a baked canopy, not a photoscan and not card foliage. See the shopping list in `make-manifest.mjs`. **The grass half of this is answered**: `gen_grass_tall/lush/dry` are generated cross-cards over one shared 128² tuft, and `src/v2/render/grass.js` carpets /v2 with them at 3/m² off that same layer without touching a GLB.

## Buildings -- follow-ups

The Nordic building kit is built and gated (`src/buildings/*`, DESIGN.md §19). Thirteen texture layers, five wall styles, four kinds, three LOD tiers from one plan. **v2 is the geometry layer** (`src/buildings/v2/*`, `gen-building.html`, `scripts/check-buildings-v2.mjs`): one position-keyed warp field over the finished vertex array, so nothing is quite straight and the shell is still airtight -- and daylight-tight, which is a separate claim the gate now measures by firing 3.5 M rays from inside the rooms (0 escaping rays straight, 2 warped). Mean 1,482 triangles and worst 2,460 against §5's 2,600 for the `structure` class. The straight geometry remains covered by `scripts/check-buildings.mjs` as the v2 control case. Nothing in the runtime uses the kit yet.

- [ ] **Visual review pass in** `gen-building.html`. Two questions, and both are looking questions rather than script questions. The proportion calls -- log diameter, roof pitch, eave overhang, window size, porch depth -- argued against the 1.75 m figure. And **how crooked is too crooked**: the master `strength` slider reaches 0 for the straight control, `vs straight` stands the pair side by side, and the per-term multipliers are there so "too warped" can be pinned on the term that did it. The shipping strength is currently 1 by assertion, not by having been looked at.
- [ ] **Migrate** `src/village/*` **onto the v2 kit** and delete the vertex-coloured placeholder shapes. Until this lands, §5's village row is what the kit measures rather than what a frame draws, and `npm run check` never reaches either building gate -- `check-village.mjs` has two pre-existing failures that stop the `&&` chain ahead of them. The plan already places buildings correctly and the +Z door convention is shared, so this is a substitution at the shapes layer -- but the old kit's architectural range is not a ceiling on the new one, and the village's building mix should be re-picked from the four kinds rather than mapped one-for-one.
- [ ] `PLASTER` **is the last tile still generated**, `MI_Medieval_Modular_Door` being the intended source. Lowest priority of the three placeholders and arguably not worth doing at all: a plaster wall's texture is not its silhouette, so only texel scale matters and that is already right. `tools/buildings/cut-tiles.mjs` is where it would go.
- [ ] **Interiors.** Every building is a closed shell; the door is a leaf on the outside of a solid wall. Opening one means the first hole in the kit, and a hole is what LOD-by-re-generation was chosen to avoid -- so an interior is a separate mesh swapped in at the threshold, not a subtraction from the exterior.
- [ ] **Let a window that cannot duck slide ALONG its wall before it is dropped.** Every window now reserves 30 cm of wall above its head against everything that can be over it (§19), and the 5% that cannot get it are dropped -- which costs 11 buildings in 480 the last window on their front, a promise plan.js makes before any roof exists to sit on it. `check-buildings-v2.mjs` holds that count as a ceiling. Almost all of them are one shape: a long wall whose outer bays stand under the eave of the wing next door, with clear wall a bay away. The move is for plan.js to hand each window the free interval along its own wall (it already knows the bays, the door and the end margins) and for the duck to try that before giving up -- but the band `wall2` dodges is built from the PLANNED position, and it is only tall enough to survive the duck by luck (measured: 0 of 394 panes on a framed wall has a member across it, with windows moving a median of 20 cm). Sliding sideways has to move that band with the window.
- [ ] **Real ironwork and runes.** `IRON` and `RUNE` are the other two layers where alpha carries the shape, so they are the other two the placeholder genuinely lies about. Both are hand-drawn geometry in `sheetIron`/`sheetRunes` today.
- [ ] **Headset gate (§17).** 20 buildings at the v2 mean is 30k triangles in one draw call, which is comfortable on paper. The untested part is the merge cost at village load, not the frame cost.

## Villages -- follow-ups

Content and layout are done and gated by `scripts/check-village.mjs` (see DESIGN.md §6). What is left:

- [ ] Wire Phase A's scored villages into the v2 runtime. The macro pass currently reaches only `map.html`, and the v1 host that carried the stand-in `devVillageSite()` has been retired, so v2 has no village placement at all -- `villages.setSites(phaseA.villages)` is still the shape of the answer.
- [ ] Connect villages to the §6 long-distance path network. Arteries currently end at the village edge; they should hand off to the A\* routes between villages so a road actually goes somewhere.
- [ ] Villagers. The plan already knows where the market, the fires, the fields and the doors are, which is the hard half of a schedule.
- [ ] Swap the remaining placeholder geometry -- wells, fences, drying racks, market stalls -- for the §9 asset pipeline. The dwellings are handled separately by the §19 kit; see Buildings above.
- [ ] Smoke drifts on a constant wind (`TUNING.wind` in `village.js`). Should follow the weather system when there is one.

## Day/night, sky and aurora -- follow-ups

The cycle, the horizon-map shadows, the starfield, the moon and the aurora are built and gated by `scripts/check-daynight.mjs`; the raymarch lab that will replace the aurora is gated separately by `scripts/check-aurora-lab.mjs` (see DESIGN.md §8 and §13). **Items below tune the band mesh, now parked in** `archive/aurora-mesh/` **and drawn by nothing. They are worth spending time on only if the Quest measurement brings it back** -- see `archive/README.md`. What is left:

- [ ] **Night brightness is calibrated to a model, not to a headset.** `scripts/check-daynight.mjs` reproduces three's Lambert + hemisphere maths on the CPU and reports sRGB luma; the numbers it targets are a moonlit-photograph look chosen on a desktop monitor. At 01:00, near field: trunk 8, gully rock 16, shaded grass 24, lit grass 67, snow 129, and 4.4:1 slope contrast under a full moon. Far field (past 75 m): lit grass 34, shaded grass 0, snow 70. The knobs are `skyGlowAmt`, `skyFloor`, `hemiIntensity` in the night rows of `KEYS`, plus `MOONLIGHT.intensity` and the two new `farDirect`/`farAmbient` columns; the gate re-measures whatever they are set to.
- [ ] **The near-field lighting envelope is a brightness gradient centred on the player, and nothing in nature does that.** §8 round five, adjusted in round seven: ambient now fades from full at her feet to zero at 75 m (`WL_NEAR_M = 0`, `WL_FAR_M = 75` in `lighting.js`), so there is no ring and no plateau -- the light level falls off gradually the whole way out, which is what the reported version asked for. It is still a pool of light that travels with her, and in stereo, where the ground plane is a strong depth cue, it may still read as a spotlight. If it does, the fixes in order are: push `WL_FAR_M` out (75 -> 120), or give `farAmbient` in `clock.js` a small non-zero floor at the cost of some far-field slope contrast.
- [ ] **Night fog went from 0.0022 to 0.00032 and now needs a look on device.** Round six: the heavy night fog was the reported "pitch-black past 500 m", and it is gone -- 10% at a kilometre instead of 99%. What that exposes is everything the fog used to hide: the far terrain LOD seams, the props' billboard tier, the chunk edges, and whatever the horizon map does at grazing angles are all visible at 1-3 km at night now. Judge those before adding any density back, because the fog was covering for them and it should not be asked to again.
- [ ] **Village windows and fires do not yet respond to the clock**, and night fog makes that more visible rather than less: the one thing guaranteed to stay bright at 800 m is a fire, so a village with no lit windows now reads as a cluster of hearths floating in the dark. (Same item as the one further down; noted here because round four changed its priority.)
- [ ] **The aurora does not light the world's geometry, only its ambient.** `state()` tints `hemiSky` green and lifts `skyGlowAmt` with aurora strength, so a storm does brighten the ground -- but uniformly, with no direction. A curtain overhead and a curtain on the northern horizon light the scene identically. A cheap fix would be a second weak directional light aimed at the brightest live band.
- [ ] The drifting cloud layer from §13 (two scrolling alpha-blended layers on the dome). Not built.
- [ ] Per-chunk fine horizon maps (§8). Deliberately skipped -- the 1024^2 global tier plus the AO bake carries it. Revisit only if crevice-scale shadowing looks flat on device.
- [ ] Aurora reflections in water. `src/water.js` samples the sky colour, not the aurora, so a lake under a full storm stays dark.
- [ ] **Sky-map blend: revisit in whichever direction the headset's fps points.** The map is rebuilt once a second and the dome blends the three newest by a quadratic B-spline (`skymap/skymap.js` THE SCHEDULE, DESIGN.md §13); measured 50 vs 62 fps before the change. If fps still suffers, drop back to two snapshots and hide the kinks with an eased weight curve instead of a third map (a two-map crossfade pulses at 1 Hz because contrast peaks at every landing; smoothing the ramp alone was not tried). If fps is comfortable, spend the headroom on the sky: raise `smRows`/`smAzRes`/`smTaps` (512x64 at 40 taps today), or a 0.5 s interval.
- [ ] Village window and fire light does not respond to the clock. `flameMat` is deliberately unshadowed so it stays bright at night, but nothing lights up *at dusk* -- windows should come on as the sun goes down.
- [ ] `curl` **was tuned against a reversal count, not against a look.** The gate walks each footprint and counts bearing reversals, and the per-form `curl` values were picked to land each form in a target band: quiet arc 0.0, omega 1.0, drapery 13.3, flaming 20.7, breakup 59.3, auroral curls 69.1. That measurement is honest about *whether* a band folds back; it says nothing about whether the folds are the right size or read as curtain rather than as ribbon-tangle. `breakup` and `auroral curls` at 60-70 reversals per frame are the two most likely to be too much. The knob is `curl` per band and the gate re-measures it.
- [ ] Substorm activity is a pure function of in-world time (`clock.js`, `AURORA_ACTIVITY`). When §10 weather exists, cloud cover should gate it -- an overcast night should hide the aurora entirely.
