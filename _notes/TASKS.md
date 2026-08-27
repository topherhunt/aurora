Claude: Do NOT modify this file. This is Topher's notes. You can suggest tasks, you can reference tasks, but don't add or remove stuff here.

### Notes

- Resources:
  - <https://sketchfab.com/>
  - <https://polyhaven.com/>
  - https://www.opensource3dassets.com/en
  - [Stone textures](https://seamless-pixels.blogspot.com/2012/09/free-seamless-stone-textures.html)
- Internal tools
  - https://192.168.178.75:5173/gen-tree
  - https://192.168.178.75:5173/gen-fern
  - https://192.168.178.75:5173/gen-rock
  - https://192.168.178.75:5173/gen-deadwood
  - https://192.168.178.75:5173/gen-mushroom
  - https://192.168.178.75:5173/gen-building-v2
  - <https://192.168.178.75:5173/test-aurora>
- Process for setting up a procedural asset:
  - Find a good basic texture asset
  - Create a slider-generator to play with the proc-gen parameters
  - Determine which parameters to lock and which ones should have a combinatorial array
  - Check how much of the GPU buffer asset slot pool the variants will use

### Tasks

- Tame rock counts. Currently way too many. In valley forests, should be 1/5th current volume.
- Tame rock LODs & tri budget. Currently wasteful.
  - Rock caps: instead of a billboard, maybe a flat card for the distance LOD?
- Cliffsides: Include larger rock caps. Fit rock shade / brightness better with the terrain it's on.
- Giant boulders underwater (rivers, lakebeds).
- Fix the x-cross on top of tree cards. (mipmap bleed?)
- Make auroras more sinuous. Also the curtains / ley-lines currently tend to run east<>west, shouldn't they roughly run north-south?
- Rivers should sit into the hillside (node needs to be placed deep enough that the river wall  bites in
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

- [ ] Improve the water shader

  - [ ] Don't fade out the small octave at distance.
  - [ ] Large octave: irregular alternating blobs of more-reflection and more-darkness. Or maybe the large octave is just a larger scale of the small-octave, but don't fade out the small-octave. Large octave MUST be 4x slower in its progression than the small octave.

- [ ] Weather

  - [ ] Randomly changes / comes and goes
  - [ ] Rain & snow: visibility distance
  - [ ] Rain at temperate elevations, snow once you reach snowline
  - [ ] Low-lying cloud cover in mountains sometimes
  - [ ] Performance-efficient mist clouds floating around/between distant mountains, drifting slowly

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

- 
- Underwater shader
- Lakebed seaweed!!! Some very tall
- Lakebed boulders
- Terrain LOD: How to preserve toothy peaks while minimizing triangles used in terrain rendering?
  - Idea 1: define billboard triangles for distant peaks (1 "layer" that provides 1 "resolution" more of terrain than what the actual LOD allows for at that distance, created only when the lower LOD loses a hill/protrusion that's added when you get closer)
  - Idea 2: "skyline backdrop" ???

## Props -- follow-ups

The Blender pipeline is built and gated (`npm run props`, `scripts/check-props.mjs`, DESIGN.md §9). 154 assets, 120 texture layers of a guaranteed 256, 75.6k triangles across every LOD. Nothing in the runtime loads any of it yet -- that is the next piece of work, and it is the larger half.

`public/props` is untracked and built locally, so anyone picking this up needs `npm run props` (needs Blender) before `check-props.mjs` will pass.

- [ ] **Load** `public/props` **at runtime.** `src/props/scatter.js` still builds every prop procedurally from `shapes.js`. It needs to fetch the GLBs, pack the LODs into a `BatchedMesh` per material, and switch tiers with `setGeometryIdAt` at the per-class distances the manifest already carries (`lod0_m`, `billboard_m`, `cull_m`).
- [ ] **Build the** `uArrAsset` **DataArrayTexture** from the 120 layer PNGs (21 albedo, 99 impostor sheets) and give each *tier* its layer index -- the index is per-LOD now (`lods[i].layer`), not per-asset, because each mesh tier is unwrapped and baked separately. The layers are all 128^2 RGBA and the gate enforces it, so the array upload should be mechanical.
- [ ] **The TREE card tier is still not wired into** `scatter.js`. The fern's is (see the fern bullets above), and the pattern it established is what the tree should follow: a sync geometry half in the `Scatter` constructor, a pixel half chained off `loadImageLayers()`, and a second kind sharing the near kind's geometry bank through `geometryFrom` so reach and density can be tuned apart. The tree's bake and card builder work today but are reachable only from `gen-tree.html`.
- [ ] **Biome-sensitive placement rules.** Phase A already reports bare/pine/mixed/heath/lush per cell; the scatter tables that map biome to species mix and density do not exist yet. §5 says density is the lever the look hangs on, affordable to ~0.2 stems/m^2.
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

The Nordic building kit is built and gated (`src/buildings/*`, DESIGN.md §19). Thirteen texture layers, five wall styles, four kinds, three LOD tiers from one plan. **v2 is the geometry layer** (`src/buildings/v2/*`, `gen-building-v2.html`, `scripts/check-buildings-v2.mjs`): one position-keyed warp field over the finished vertex array, so nothing is quite straight and the shell is still airtight -- and daylight-tight, which is a separate claim the gate now measures by firing 3.5 M rays from inside the rooms (0 escaping rays straight, 2 warped). Mean 1,482 triangles and worst 2,460 against §5's 2,600 for the `structure` class. v1 (`gen-building.html`, `scripts/check-buildings.mjs`) is kept as the straight control and still passes. Nothing in the runtime uses either yet.

- [ ] **Visual review pass in** `gen-building-v2.html`. Two questions, and both are looking questions rather than script questions. The proportion calls -- log diameter, roof pitch, eave overhang, window size, porch depth -- argued against the 1.75 m figure. And **how crooked is too crooked**: the master `strength` slider reaches 0 for the straight control, `vs straight` stands the pair side by side, and the per-term multipliers are there so "too warped" can be pinned on the term that did it. The shipping strength is currently 1 by assertion, not by having been looked at.
- [ ] **Migrate** `src/village/*` **onto the v2 kit** and delete the vertex-coloured placeholder shapes. Until this lands, §5's village row is what the kit measures rather than what a frame draws, and `npm run check` never reaches either building gate -- `check-village.mjs` has two pre-existing failures that stop the `&&` chain ahead of them. The plan already places buildings correctly and the +Z door convention is shared, so this is a substitution at the shapes layer -- but the old kit's architectural range is not a ceiling on the new one, and the village's building mix should be re-picked from the four kinds rather than mapped one-for-one.
- [ ] `PLASTER` **is the last tile still generated**, `MI_Medieval_Modular_Door` being the intended source. Lowest priority of the three placeholders and arguably not worth doing at all: a plaster wall's texture is not its silhouette, so only texel scale matters and that is already right. `tools/buildings/cut-tiles.mjs` is where it would go.
- [ ] **Interiors.** Every building is a closed shell; the door is a leaf on the outside of a solid wall. Opening one means the first hole in the kit, and a hole is what LOD-by-re-generation was chosen to avoid -- so an interior is a separate mesh swapped in at the threshold, not a subtraction from the exterior.
- [ ] **Let a window that cannot duck slide ALONG its wall before it is dropped.** Every window now reserves 30 cm of wall above its head against everything that can be over it (§19), and the 5% that cannot get it are dropped -- which costs 11 buildings in 480 the last window on their front, a promise plan.js makes before any roof exists to sit on it. `check-buildings-v2.mjs` holds that count as a ceiling. Almost all of them are one shape: a long wall whose outer bays stand under the eave of the wing next door, with clear wall a bay away. The move is for plan.js to hand each window the free interval along its own wall (it already knows the bays, the door and the end margins) and for the duck to try that before giving up -- but the band `wall2` dodges is built from the PLANNED position, and it is only tall enough to survive the duck by luck (measured: 0 of 394 panes on a framed wall has a member across it, with windows moving a median of 20 cm). Sliding sideways has to move that band with the window.
- [ ] **Real ironwork and runes.** `IRON` and `RUNE` are the other two layers where alpha carries the shape, so they are the other two the placeholder genuinely lies about. Both are hand-drawn geometry in `sheetIron`/`sheetRunes` today.
- [ ] **Headset gate (§17).** 20 buildings at the v2 mean is 30k triangles in one draw call, which is comfortable on paper. The untested part is the merge cost at village load, not the frame cost.

## Villages -- follow-ups

Content and layout are done and gated by `scripts/check-village.mjs` (see DESIGN.md §6). What is left:

- [ ] Replace the stand-in village site in `src/main.js` (`devVillageSite()`) with Phase A's scored villages, once the macro pass is wired into the runtime rather than only into `map.html`. `villages.setSites(phaseA.villages)` and delete the block -- the village content does not change, it just moves to where the water is.
- [ ] Connect villages to the §6 long-distance path network. Arteries currently end at the village edge; they should hand off to the A\* routes between villages so a road actually goes somewhere.
- [ ] Villagers. The plan already knows where the market, the fires, the fields and the doors are, which is the hard half of a schedule.
- [ ] Swap the remaining placeholder geometry -- wells, fences, drying racks, market stalls -- for the §9 asset pipeline. The dwellings are handled separately by the §19 kit; see Buildings above.
- [ ] Smoke drifts on a constant wind (`TUNING.wind` in `village.js`). Should follow the weather system when there is one.

## Day/night, sky and aurora -- follow-ups

The cycle, the horizon-map shadows, the starfield, the moon and the aurora are built and gated by `scripts/check-daynight.mjs`; the raymarch lab that will replace the aurora is gated separately by `scripts/check-aurora-lab.mjs` (see DESIGN.md §8 and §13). **Items below that tune** `src/aurora.js` **are worth spending time on only if the meshes survive the lab** -- see the aurora bullet in Tasks above. What is left:

- [ ] **Nothing in** `npm run check` **compiles a shader, and one release of the aurora shipped GLSL that did not link.** The redeclaration scan in `check-daynight.mjs` closes the specific hole that caused it, but only that one: a type mismatch, a missing varying, an undeclared identifier or a wrong argument count would all still pass every check in the project and still draw nothing. `check-aurora-lab.mjs` is in the same position and the stakes there are higher, because the lab's shader is *assembled* -- three algorithms times one shared frame, with the uniform block generated from the param schema -- so a chunk that fails to link fails at a join no single source file contains. The real fix is a headless GL context (`gl` or a Playwright page) that links each program once and fails on the info log; for the lab that is four programs, and it is now the highest-value check in the project.
- [ ] **The meander was tuned to a swing target, not to a look.** `MEANDER_FRAC = 0.36` in `aurora.js` puts the hem's peak-to-peak swing at 2.3 degrees on the quietest arc and 8.3 on a breakup, which is what the gate asserts. Whether that reads as an S rather than as a long wobble is a look question and only the headset answers it. The steps, one at a time and in this order: judge the swing magnitude (`MEANDER_FRAC`), then whether the meander's *wavelength* (`0.0034`, about 73 km of sky at the 250 km reference) makes one broad S or three, then whether the two forms held straight (`meander: 0.12` on `SAR arc` and `STEVE`) are right to be. The reverted shell, curvature drop and re-siting (`design/history/aurora-rounds-4-6.md`) should not come back as a bundle.
- [ ] **Headset gate.** Per §17 rule 3, everything here is new, transparent and full-screen -- the aurora, the starfield and the sky dome have never been fill-rate tested on device. Read frametime and worst-frame at 01:00 in-world with the aurora at storm strength and three forms overlaid on top of the always-on `diffuse patches` floor (press `P` to pin `breakup`, `corona` or `vapour spiral`, which are the three heaviest), which is the worst case the system can produce. Eleven slots, 35,640 triangles, and the two floor slots are never degenerate so they always cost fill. Working against it, the presence envelope multiplies two masks instead of summing them, so a typical frame is dark and average overdraw is low even though peak is unchanged. `/test-aurora` needs its own reading and it is a different regime entirely -- one additive sector of northern sky, a few thousand triangles that cost nothing, and ~840 noise lookups a pixel, so all of it is in the march.
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
