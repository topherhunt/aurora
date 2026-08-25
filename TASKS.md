### Notes

- Resources:
  - <https://sketchfab.com/>
  - <https://polyhaven.com/>
  - https://www.opensource3dassets.com/en
- Process for setting up a procedural asset:
  - Find a good basic texture asset
  - Create a slider-generator to play with the proc-gen parameters
  - Determine which parameters to lock and which ones should have a combinatorial array
  - Check how much of the GPU buffer asset slot pool the variants will use

### Tasks

- [x] Procedural ferns
  - [x] Card tier. `bakeFernImpostors` in `src/props/fern-bank.js` photographs the LOD0 mesh side-on at load and stands it up as 2 crossed quads (4 tris) wearing `IMPOSTOR_FERN_UPRIGHT` / `IMPOSTOR_FERN_ARCHED`. No offline asset, no build step: the card cannot disagree with the mesh. `gen-fern.html`'s `card` button draws it, and its `planes` slider and `can it be a card?` table are how the two calls below get settled.
  - [x] Card tier wired into the world. The geometry half (`fernCardGeometries`) runs in the `Scatter` constructor; the pixel half is chained off `loadImageLayers()` in `src/main.js`, because the photograph is of a fern wearing a PNG that has not arrived yet. Ferns no longer stop dead at 26 m: a second scatter kind, `fern_far`, shares `fern`'s geometry bank via `geometryFrom` and reaches 80 m at 5.0 m spacing, drawing cards past 26 m and meshes inside it. Sparse out there (~0.02 ferns/m² against 0.46 close in) and that is an instance-cap limit, not a tuning one -- see the clump bullet below.
  - [ ] **A fern's far reach is bounded by rebuild cost, and clump cards are what lifts it.** `fern_far` costs 1,089 candidate cells and ~2.4 ms per rebuild for 80 m; DESIGN.md §5's pixel argument permits 170 m and its fill argument says the band is nearly free, so the ceiling is placement, not drawing. One card baked from a patch of ferns buys reach at a fraction of the cells and looks better than sparse singles, and moving the far band to tiled `InstancedMesh` takes it off the per-frame budget entirely. Neither is built.
  - [ ] **Two numbers in the card are arithmetic, not a looked-at judgement.** `FERN_CARD_PLANES = 2` is a triangle-for-solidity trade, and the choice of *two* impostor layers cut on `arch` rests on a fern being ~20 px tall at 26 m. Both need a pass in `gen-fern.html`: walk 1 / 2 / 3 planes and check whether the arched and upright bakes really read apart at that size, or whether one layer would do.
- [ ] Procedural trees (use EZTrees as a base, but customize to support 3 shape-preserving LODs + 1-2 billboard levels)
  - [ ] let's bake variants!! I'm thinking of these combinatorial variations (and as with ferns, each variant should be a different seed\
    roll):
    - 3 heights (default, 2/3 default young, 1/3 default sapling)
    - firstBranch: \[default, or default / 2\]

    Bushes also need variants: 2 sizes x 2 random seed rolls each.
  - [ ] Assess with Claude, and smoke-test to confirm that procedural trees don't bog down performance.
  - [ ] 
  - [ ] Snow cover partial/full (just a shader on the sprays?)
- [ ] Redo the Aurora using a planar shader (one plane, northern tilted sky-wall)
  - [ ] Look at Skyrim's auroras. They're specific procedurally-determined(?) channels in the sky, sinuous and snaking around, the magnetic leylines, and various neon patterns flow and shimmer through them. Shimmering overlaid intersectional shader similar to what water surfaces have?
  - [ ] Layers to weave in:
    - [ ] global perlin shader that causes dim/opacity/fuzz/scatter/blur/sharpness
    - \[ \]
- [ ] Procedural other nature props
  - [ ] Giant fallen logs, broken stumps, boulders & rocks
  - Placed to hem off paths & create a sense of verticality & obstacle clutters
  - [ ] Procedural rock cliffsides, procedural rock crags on hillocks, hillsides, & especially on snowy peaks. To add that toothy jaggedness.
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
- [ ] Terrain LOD: what if just visible peaks get further decimation (down to ~1.2deg) whereas everything else stays at ~5.72deg?
- [ ] Blue distance shader
- [ ] Fog
- [ ] River water renderer
  - Shader for flowing water. Narrower = faster, wider = shallower. Steeper = faster. beyond 45deg = waterfall, with emitted spray clouds.

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
- [ ] **Replacement grass and a replacement hero tree.** Four grass variants and two trees came out of the library above and nothing has taken their place; `grass_wild_scan_b/c/d` plus the hand-built tufts are what is left for ground cover. Both wants are the same want: authored low-poly cross-cards with a baked canopy, not photoscans and not card foliage. See the shopping list in `make-manifest.mjs`.

## Buildings -- follow-ups

The Nordic building kit is built and gated (`src/buildings/*`, DESIGN.md §19). Thirteen texture layers, four wall styles, four kinds, three LOD tiers from one plan. **v2 is the geometry layer** (`src/buildings/v2/*`, `gen-building-v2.html`, `scripts/check-buildings-v2.mjs`): one position-keyed warp field over the finished vertex array, so nothing is quite straight and the shell is still airtight. Mean 1,360 triangles and worst 2,532 against §5's 2,600 for the `structure` class. v1 (`gen-building.html`, `scripts/check-buildings.mjs`) is kept as the straight control and still passes. Nothing in the runtime uses either yet.

- [ ] **Visual review pass in** `gen-building-v2.html`. Two questions, and both are looking questions rather than script questions. The proportion calls -- log diameter, roof pitch, eave overhang, window size, porch depth -- argued against the 1.75 m figure. And **how crooked is too crooked**: the master `strength` slider reaches 0 for the straight control, `vs straight` stands the pair side by side, and the per-term multipliers are there so "too warped" can be pinned on the term that did it. The shipping strength is currently 1 by assertion, not by having been looked at.
- [ ] **Migrate** `src/village/*` **onto the v2 kit** and delete the vertex-coloured placeholder shapes. Until this lands, §5's village row is what the kit measures rather than what a frame draws, and `npm run check` never reaches either building gate -- `check-village.mjs` has two pre-existing failures that stop the `&&` chain ahead of them. The plan already places buildings correctly and the +Z door convention is shared, so this is a substitution at the shapes layer -- but the old kit's architectural range is not a ceiling on the new one, and the village's building mix should be re-picked from the four kinds rather than mapped one-for-one.
- [ ] **`PLASTER` is the last tile still generated**, `MI_Medieval_Modular_Door` being the intended source. Lowest priority of the three placeholders and arguably not worth doing at all: a plaster wall's texture is not its silhouette, so only texel scale matters and that is already right. `tools/buildings/cut-tiles.mjs` is where it would go.
- [ ] **Interiors.** Every building is a closed shell; the door is a leaf on the outside of a solid wall. Opening one means the first hole in the kit, and a hole is what LOD-by-re-generation was chosen to avoid -- so an interior is a separate mesh swapped in at the threshold, not a subtraction from the exterior.
- [ ] **Real ironwork and runes.** `IRON` and `RUNE` are the other two layers where alpha carries the shape, so they are the other two the placeholder genuinely lies about. Both are hand-drawn geometry in `sheetIron`/`sheetRunes` today.
- [ ] **Headset gate (§17).** 20 buildings at the v2 mean is 27k triangles in one draw call, which is comfortable on paper. The untested part is the merge cost at village load, not the frame cost.

## Villages -- follow-ups

Content and layout are done and gated by `scripts/check-village.mjs` (see DESIGN.md §6). What is left:

- [ ] Replace the stand-in village site in `src/main.js` (`devVillageSite()`) with Phase A's scored villages, once the macro pass is wired into the runtime rather than only into `map.html`. `villages.setSites(phaseA.villages)` and delete the block -- the village content does not change, it just moves to where the water is.
- [ ] Connect villages to the §6 long-distance path network. Arteries currently end at the village edge; they should hand off to the A\* routes between villages so a road actually goes somewhere.
- [ ] Villagers. The plan already knows where the market, the fires, the fields and the doors are, which is the hard half of a schedule.
- [ ] Swap the remaining placeholder geometry -- wells, fences, drying racks, market stalls -- for the §9 asset pipeline. The dwellings are handled separately by the §19 kit; see Buildings above.
- [ ] Smoke drifts on a constant wind (`TUNING.wind` in `village.js`). Should follow the weather system when there is one.

## Day/night, sky and aurora -- follow-ups

The cycle, the horizon-map shadows, the starfield, the moon and the aurora are built and gated by `scripts/check-daynight.mjs` (see DESIGN.md §8 and §13). What is left:

- [ ] **Nothing in** `npm run check` **compiles a shader, and one release of the aurora shipped GLSL that did not link.** The redeclaration scan in `check-daynight.mjs` closes the specific hole that caused it, but only that one: a type mismatch, a missing varying, an undeclared identifier or a wrong argument count would all still pass every check in the project and still draw nothing. The real fix is a headless GL context (`gl` or a Playwright page) that links each program once and fails on the info log. Worth doing before the next shader-heavy round.
- [ ] **The meander was tuned to a swing target, not to a look, and it is deliberately the only new mechanism.** §13 round seven: `MEANDER_FRAC = 0.36` in `aurora.js` puts the hem's peak-to-peak swing at 2.2 degrees on the quietest arc and 8.3 on a breakup, which is what the gate asserts. Whether that reads as an S rather than as a long wobble is a look question and only the headset answers it. The intended next steps, one at a time and in this order: judge the swing magnitude (`MEANDER_FRAC`), then whether the meander's *wavelength* (`0.0034`, about 73 km of sky at the 250 km reference) makes one broad S or three, then whether the two forms held straight (`meander: 0.12` on `SAR arc` and `STEVE`) are right to be. Everything rounds five and six tried on top of this -- the shell, the curvature drop, the re-siting -- is reverted and should not come back as a bundle.
- [ ] **Headset gate.** Per §17 rule 3, everything here is new, transparent and full-screen -- the aurora, the starfield and the sky dome have never been fill-rate tested on device. Read frametime and worst-frame at 01:00 in-world with the aurora at storm strength and three forms overlaid on top of the always-on `diffuse patches` floor (press `P` to pin `breakup`, `corona` or `vapour spiral`, which are the three heaviest), which is the worst case the system can produce. Eleven slots, 35,640 triangles, and the two floor slots are never degenerate so they always cost fill. Working against it, the round-four presence envelope multiplies two masks instead of summing them, so a typical frame is substantially darker than round three's and average overdraw is down even though peak is unchanged.
- [ ] **Night brightness is calibrated to a model, not to a headset.** `scripts/check-daynight.mjs` reproduces three's Lambert + hemisphere maths on the CPU and reports sRGB luma; the numbers it targets are a moonlit-photograph look chosen on a desktop monitor. At 01:00, near field: trunk 8, gully rock 16, shaded grass 24, lit grass 67, snow 129, and 4.4:1 slope contrast under a full moon. Far field (past 75 m): lit grass 34, shaded grass 0, snow 70. The knobs are `skyGlowAmt`, `skyFloor`, `hemiIntensity` in the night rows of `KEYS`, plus `MOONLIGHT.intensity` and the two new `farDirect`/`farAmbient` columns; the gate re-measures whatever they are set to.
- [ ] **The near-field lighting envelope is a brightness gradient centred on the player, and nothing in nature does that.** §8 round five, adjusted in round seven: ambient now fades from full at her feet to zero at 75 m (`WL_NEAR_M = 0`, `WL_FAR_M = 75` in `lighting.js`), so there is no ring and no plateau -- the light level falls off gradually the whole way out, which is what the reported version asked for. It is still a pool of light that travels with her, and in stereo, where the ground plane is a strong depth cue, it may still read as a spotlight. If it does, the fixes in order are: push `WL_FAR_M` out (75 -> 120), or give `farAmbient` in `clock.js` a small non-zero floor at the cost of some far-field slope contrast.
- [ ] **Night fog went from 0.0022 to 0.00032 and now needs a look on device.** Round six: the heavy night fog was the reported "pitch-black past 500 m", and it is gone -- 10% at a kilometre instead of 99%. What that exposes is everything the fog used to hide: the far terrain LOD seams, the props' billboard tier, the chunk edges, and whatever the horizon map does at grazing angles are all visible at 1-3 km at night now. Judge those before adding any density back, because the fog was covering for them and it should not be asked to again.
- [ ] **Village windows and fires do not yet respond to the clock**, and night fog makes that more visible rather than less: the one thing guaranteed to stay bright at 800 m is a fire, so a village with no lit windows now reads as a cluster of hearths floating in the dark. (Same item as the one further down; noted here because round four changed its priority.)
- [ ] **The aurora does not light the world's geometry, only its ambient.** `state()` tints `hemiSky` green and lifts `skyGlowAmt` with aurora strength, so a storm does brighten the ground -- but uniformly, with no direction. A curtain overhead and a curtain on the northern horizon light the scene identically. A cheap fix would be a second weak directional light aimed at the brightest live band.
- [ ] The drifting cloud layer from §13 (two scrolling alpha-blended layers on the dome). Not built.
- [ ] Per-chunk fine horizon maps (§8). Deliberately skipped -- the 1024^2 global tier plus the AO bake carries it. Revisit only if crevice-scale shadowing looks flat on device.
- [ ] Aurora reflections in water. `src/water.js` samples the sky colour, not the aurora, so a lake under a full storm stays dark.
- [ ] Village window and fire light does not respond to the clock. `flameMat` is deliberately unshadowed so it stays bright at night, but nothing lights up *at dusk* -- windows should come on as the sun goes down.
- [ ] `curl` **was tuned against a reversal count, not against a look.** §13 round five: the gate walks each footprint and counts bearing reversals, and the per-form `curl` values were picked to land each form in a target band. As re-measured in round seven: quiet arc 0.0, omega 1.0, drapery 13.3, flaming 20.7, breakup 59.3, auroral curls 69.1. That measurement is honest about *whether* a band folds back; it says nothing about whether the folds are the right size or read as curtain rather than as ribbon-tangle. `breakup` and `auroral curls` at 60-70 reversals per frame are the two most likely to be too much. The knob is `curl` per band and the gate re-measures it.
- [ ] Substorm activity is a pure function of in-world time (`clock.js`, `AURORA_ACTIVITY`). When §10 weather exists, cloud cover should gate it -- an overcast night should hide the aurora entirely.
