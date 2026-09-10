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
- Internal tools
  - https://192.168.178.75:5173/gen-tree
  - https://192.168.178.75:5173/gen-fern
  - https://192.168.178.75:5173/gen-rock
  - https://192.168.178.75:5173/gen-deadwood
  - https://192.168.178.75:5173/gen-mushroom
  - https://192.168.178.75:5173/gen-building
  - <https://192.168.178.75:5173/test-aurora>
- Process for setting up a procedural asset:
  - Find a good basic texture asset
  - Create a slider-generator to play with the proc-gen parameters
  - Determine which parameters to lock and which ones should have a combinatorial array
  - Check how much of the GPU buffer asset slot pool the variants will use

### Tasks

- Get VR looking passable
  - [ ] Trees
    - [x] Try a new version of the voxel tree where each leaf is 2 crossed symmetrical tris, each bearing the "bristle" texture.
    - [x] Try a "stacked irregular cones" tree model, using my new tileable pine needles.
      - [x] Solid material at LOD1+
      - [x] Alpha material at LOD0
    - [x] Try a hybrid model where most tris are solid, and fringes are done via alpha
    - [x] A separate version of pine -v6 where each branch has its own cloak
    - [x] Pine trees are locked
    - [ ] Oak trees
      - instead of separate icosahedrons for separate boughs, let's have the oak foliage be ONE giant sealed mesh, with lots of lobes and bumps that span multiple vertices so it feels lumpy but not jagged-pointy.
  - [ ] Rocks
    - [ ] Get rid of all these rock caps. Boulders should be placed and rendered at a distance relative to their size, maxing out at 1.1km. (Ensure trees max out at 1km. Trees must place AFTER boulders, and thus must have a closer viewing distance.)
    - [ ] Rock caps: positioned impostor card rather than billboard.
    - [ ] Fix boulder billboard colors & positions
      - Currently billboard color is substantially misaligned from the color / light level of the rock itself.
      - Also, billboard POSITION is off-center, and often size too, it needs to match the center-position and size of the rock mesh it's replacing. (I may have previously specified that billboards should never embed in the ground; that was wrong and I'm sorry.
      - Billboards apparently have a "size on screen" based fadeout trigger, so their fade distance is size-dependent. That's good. But it needs to be 2x the size it currently is. Currently we have lots of tiny pebbles busying up the screen.
    - [ ] Fix rock-cap far-distance cards
      - Rock caps' impostor photo should be top-down. Instead of a cylindrically-rotated billboard, the rock card will just be positioned along whatever surface the cap was on, tangent to the top surface of where the mesh reached (so it's out a bit from the cliff wall or whatever), at the same rotation and scale.
  - [ ] Pebbles
    - 1 mesh, reuse the boulder LOD1 + LOD2 + billboard. Lower tri count, irregular, sunk into ground.
    - Billboard is positioned 50% of the rock height UP so it doesn't clip into the ground.
  - Ensure the various prop scatterers are only calculating placement within their local rim of visibility & not beyond that.
  - [ ] Characters
    - \[ \]
    - [ ] A snake, slithering through the grass.
    - [ ] A small wood-and-twig creature, like a fey.
    - [ ] Figure out how distant cards should work.
  - [ ] Gen trees WITH the texture, preserve that version, also take the mesh and repaint it with my tiled textures. Can I do a "partial repaint" which preserves the orig's 128px texture wrap but overrides it for certain faces where I have something better?
  - \[ \]
- ...
  - [ ] greeting dialog on 1st load on pc (point to vr).
  - [ ] simple shadows.
  - [ ] animals. Wrapped uv from ai gen character sheet, low poly. Dragon, horse, fox, songbird, hawk, boar, deer, fish (3 kinds), snake, butterfly.
  - [ ] Gnome doorways into giant boulders. You can go inside, and you're transported into an interior of the same rock but 2x the size.
  - [ ] procedural towns, grown around a seed central location. Procedural roads between them. Each has a stable w horses you can take.
  - [ ] procedural house interiors. Hearth and chimney, table, food, dishware, beds, storage barrels, shelves, chairs, divider walls, stairs down to cellar, candles (cast light), torches, windows.
  - [ ] procedural caves. Mazelike
  - [ ] procedual flowers.
  - [ ] Multiplayer: support shooting up a flare that other players can find each other.
- 
- Make auroras more sinuous. Also the curtains / ley-lines currently tend to run east<>west, shouldn't they roughly run north-south?
- Rivers should sit into the hillside (node needs to be placed deep enough that the river wall bites in
- 2x ground variation at the 0.5m-2m level. This should help riverbanks feel broken up rather than smooth splines.
- [ ] Deadwood: currently it's always placed in the same places as trees. Scatter it randomly, NOT under trees, though it's OK if it occasionally intersects. Also it needs to be browner, less red. Also vary size randomly from (current size) to 4x current size.
- [ ] Mushrooms: double current default size? and randomly vary sizes obvi
- [ ] Procedural bushes - Scattered throguhout the forest like trees, but with different LOD thresholds. 2 sizes x 2 random seed rolls x species.

- [ ] Pebbles on ground: can they be atlassed so they bend following the existing triangles, ratehr than being new separate triangles? Perf implications of that? (if doable, it would be very useful)
- [ ] Leaf atlas and lichen atlas - scatter onto boulders & forest floor. (Moss is done for boulders -- see the moss bullet under nature props; trunks are the next entry in `MOSS_LAYERS` and need a height cue first.)

- [ ] **Redo the Aurora as a raymarched field instead of eleven curtain meshes.**

  - Gorgeous starting point, but unworkable perf-wise. Leylines and Weave looked gorgeous, the 3rd algo (filament) was nothing.
  - [ ] Get data on, how is the new aurora structured? Is it a dome mesh, a plane, or sth else? It should be as few tris as possible ideally.

- [ ] Clear out the scanned 3D assets that are bad-quality & not worth keeping

- [ ] Props should cast shadows on the terrain and on other props. See \_notes/local-shadows.md.

- [ ] Weather

  - [ ] Randomly changes / comes and goes
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
- [ ] Village window and fire light does not respond to the clock. `flameMat` is deliberately unshadowed so it stays bright at night, but nothing lights up *at dusk* -- windows should come on as the sun goes down.
- [ ] `curl` **was tuned against a reversal count, not against a look.** The gate walks each footprint and counts bearing reversals, and the per-form `curl` values were picked to land each form in a target band: quiet arc 0.0, omega 1.0, drapery 13.3, flaming 20.7, breakup 59.3, auroral curls 69.1. That measurement is honest about *whether* a band folds back; it says nothing about whether the folds are the right size or read as curtain rather than as ribbon-tangle. `breakup` and `auroral curls` at 60-70 reversals per frame are the two most likely to be too much. The knob is `curl` per band and the gate re-measures it.
- [ ] Substorm activity is a pure function of in-world time (`clock.js`, `AURORA_ACTIVITY`). When §10 weather exists, cloud cover should gate it -- an overcast night should hide the aurora entirely.
