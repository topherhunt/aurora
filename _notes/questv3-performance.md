# /questv3 performance observations (Quest 2, on-device)

Raw findings from manual panel-toggle testing in `/questv3`, later extended with real content in `/quest`. Not yet gated by any check script -- this is a running log to steer what's worth optimizing.

## Overall conclusion so far

In WebXR on the Quest 2, there is no substantial performance penalty from triangle count or from basic features like masked opacity and lighting on their own -- they run passably and acceptably. The dominant cost by far is **draw-call count** (equivalently: number of individually-drawn objects), not geometric complexity. A scene budget should be built around "how many separate draw calls" first, triangle count a distant second.

## Draw-call count is the dominant bottleneck

8,192 tree billboards as individual meshes: ~5 FPS, effectively unusable. The same 8,192 as `InstancedMesh`: ~50 FPS, passable. Confirmed again with real (non-billboard) trees: 4,096 real trees individually drawn (~200k tris, ~5,600 draw calls, ~2,900 Geo) ran at 10-11 FPS; the same 4,096 as `InstancedMesh` (~95 draw calls, ~40 Geo) ran at 88-92 FPS.

This also explains the inward-faces (`DoubleSide`) result more precisely than first thought. Enabling inward-facing billboard sides in **individual** draw mode is catastrophic: 8,192 individually-drawn billboards went from 16-17 FPS to ~2 FPS, with draw calls roughly doubling from ~6,000 to ~11,000 -- because each newly-visible "back" face is itself a full separate draw call in that regime. But once the same billboards are instanced, inward faces cost nothing (83-85 FPS stable regardless of masked/inward toggles) -- draw calls are decoupled from instance count, so there's no per-face draw-call multiplication left to pay for. Earlier framing of this as "backface culling is a free GPU stage" was only correct for the already-instanced case; the real driver is draw-call count, not overdraw/fill-rate.

## Triangle-count headroom is large, once instanced

8,192 billboard quads (2 tri each) + 512 individually-modeled trees + 512 boulders (~60k tris total) is workable. Pushed much further with real trees, still instanced: 16,384 trees (~750-800k tris) still ran 45-50 FPS. Vertex throughput is not the limiting factor at these scales -- draw-call count is.

Boulder ceiling in individual mode: 4,096 boulders (~147k tris) ran 21 FPS with lighting off, 15 FPS with lighting on -- consistent with the draw-call-dominated read, since boulders were tested individually-drawn here.

## Extreme-scale instanced billboard scaling

Billboards, instanced, pushed well past normal scene budgets to find the ceiling:
- 65,536 instances: 76-78 FPS, stable.
- 131,072 instances: dropped to 40-43 FPS, despite draw calls staying stable (still ~1 draw call per material/variant). Open question the user flagged: unclear whether this drop is instance-count-driven (e.g. CPU-side matrix upload/skinning cost) or triangle-count-times-alpha-mask-driven (fragment cost from a much larger masked/lit surface). Not yet disentangled -- planned as the next test.
- ~250,000 instances (~500k tris): survivable, low double-digit FPS.
- ~500,000 instances (~1M tris): crashed the headset outright, required a restart. This is a hard ceiling, not just a slow frame.

## Masked alpha (alphaTest) costs less than expected

Toggling `masked` off saves only ~2 FPS at 8,192 instanced billboards. Tentative read: the alpha-test discard instruction itself is cheap; if there's an overdraw cost here it's not dominated by the discard branch specifically.

## Lighting: real cost

Turning dynamic lighting on at 8,192-billboard content volume: ~65 FPS -> ~53 FPS, about a 15 FPS hit. Expected and unsurprising -- this is the one toggle so far with a clearly attributable, non-trivial cost on its own (separate from the draw-call effects above).

## Terrain triangle cost is negligible

The procedural terrain mesh is ~4,000 triangles and produces no measurable FPS impact on its own.

## BatchedMesh is confirmed impossible under A-Frame 1.5.0, not just untested

A-Frame 1.5.0 bundles three.js r158 (confirmed on-device via console log, not the earlier "~r150" guess). Per the three.js migration guide, `BatchedMesh` doesn't exist until r159 -- one revision later. `/quest`'s tree-render toggle briefly had a third `batched` mode built from this project's own npm three.js (`^0.180.0`) `BatchedMesh`, added directly to A-Frame's live scene; that mode has been removed entirely rather than kept as an untested experiment, since the migration-guide research makes the outcome analytically certain (A-Frame's bundled `WebGLRenderer` has no render path for `isBatchedMesh` objects at all) rather than something worth spending a headset test on. `instanced` stays the only multi-object mode -- and per the r158-vs-0.180 diff, it's also the *only* capability actually lost by A-Frame's older three.js: every other API this codebase's content pipeline uses (`BufferGeometry`, `ShaderMaterial`, `DataArrayTexture`, `MeshLambertMaterial`, etc.) is unaffected. `createPropMaterial`'s existing per-vertex `texLayer`/`uvProj` + shared `DataArrayTexture` atlas already gives visual variety within one `InstancedMesh` draw call, and tree-bank/rock-bank already bucket by geometry variant into separate `InstancedMesh`es -- so `BatchedMesh`'s one unique capability (mixed geometries in one draw call) isn't load-bearing for this project's variety strategy. `InstancedMesh` can't give per-instance skeletal animation, which matters for future animated villagers -- but the plan there is a separate, small-N draw call per animated actor (distant villagers as a simple billboard card with a hop, not a skinned mesh), not instancing, so this doesn't reopen the batched-mesh question.

## npm-three / AFRAME.THREE version mix: foreign DATA is safe, foreign live SCENE OBJECTS are not

`/quest`'s content pipeline (`sky.js`, `stars.js`, `tree-bank.js`, `rock.js`, `material.js`, etc.) imports this project's own npm three.js (`0.180.0`), a ~22-revision gap from A-Frame's bundled r158. Two on-device crashes this surfaced:

- **Tree-impostor baking** (`bakeTreeImpostors`/`bakeImpostor`) threw `TypeError: e.onBuild is not a function` -- it builds an entirely npm-three scene graph and renders it with whatever renderer it's handed; `quest-main.js` was passing A-Frame's own r158 renderer instead of a matching-version one. Fixed with a dedicated, disposed-after-use npm-three `WebGLRenderer` for that one-off bake, matching the pattern already used at every other bake call site in this codebase (`gen-tree-main.js`, `main.js`, `v2/main.js`).
- **Broader, more severe**: adding real billboards/trees, or toggling the sky/day-night system, caused an immediate full black screen on the Quest 2 with **no JS console error at all** (a GPU/driver-level crash, not a catchable exception) -- required a browser force-quit. Root cause: a native `AFRAME.THREE.Mesh`/`Points` wrapping a *foreign* (npm-three) `BufferGeometry`/`Material`, added directly to the live A-Frame scene and rendered every frame by A-Frame's r158 renderer, is not safe -- unlike foreign *data* (plain `Vector3`/`Color` reads, or a foreign `DataTexture` assigned as `.map`, both confirmed fine on-device already, e.g. terrain's `grassTexture()`).

Fix: a translation shim in `quest-main.js` (`localGeometry`/`localMaterial`/`localShaderMaterial`) that rebuilds every geometry/material as a native `AFRAME.THREE` instance before it touches the live scene -- rocks, billboards, trees, and Sky/Stars (built against a throwaway detached npm-three `Scene` since their constructors do their own internal `scene.add(...)`, then mirrored into native `Mesh`/`Points` objects whose transform/visibility is copied from the originals each frame; materials share their `uniforms` dict by reference so in-place uniform mutation, e.g. `writeSkyUniforms`, propagates automatically). The shared content-generation files themselves are untouched npm-three, since `main.js`/`v2/main.js`/`gen-*-main.js` depend on that and don't load A-Frame.

**CONFIRMED ON-DEVICE**: shim resolves the crash. Billboards, real trees, and the sky/day-night toggle all render correctly now. Unifying three.js versions across the main (root-loaded) v2 app is still explicitly deferred, but the shim itself is no longer an open question.

## Instanced billboards: near-free up to ~250k, a hard wall past that

With the shim confirmed working, pushed billboard instancing far past every earlier test:
- 262,144 instanced billboards (262k tris, all alpha-masked cutouts): ~35 FPS. Slightly lower than the 131,072-instance `/questv3` number (40-43 FPS) despite being instanced both times -- worth another look, but not a regression severe enough to chase yet.
- ~500,000 instanced billboards (~500k tris): total crash, way under 1 FPS, browser barely quittable. Confirms the ~250k-500k range as a hard instance-count ceiling **even fully instanced** (1 draw call) -- this is not a draw-call problem, so it's most likely CPU-side per-instance overhead (matrix upload, culling bookkeeping) or GPU vertex-stage throughput at very high instance counts, not fragment/mask cost. Re-confirms masked alpha is free even at this scale: toggling `masked` off at 262k instanced billboards gave no measurable FPS change, matching the ~2 FPS-at-8,192 result from `/questv3`.
- Inward faces (`DoubleSide`) reconfirmed free once instanced, this time at real scale: no measurable cost turning it on with hundreds of thousands of instanced billboards. Necessary too, not just cheap -- these trees' leaf sprays are authored to be seen from both sides, so real (non-billboard) trees look ~50% bare with inward faces off.

## Real trees at LOD0: individual vs. instanced is a much bigger gap than expected

2,048 real (non-billboard) trees at LOD0/max detail (~750k-1M triangles, nearly all alpha-masked leaf geometry):
- Individual draw mode: ~26-30 FPS. Still usable, and notably the Quest 2 held up fine with ~1M masked triangles on their own -- geometric/fragment cost at this scale is not the bottleneck.
- Same 2,048 trees, `instanced`: jumped to ~65 FPS. A far bigger individual-vs-instanced gap than the earlier 4,096-billboard comparison (10-11 -> 88-92 FPS) would suggest scales linearly -- real trees carry much more per-object JS/driver overhead per individual draw call than a 2-triangle billboard does, so the instancing payoff compounds at higher per-object complexity, not just at higher counts.

Overall takeaway: dense, lush forests (both billboard-only distant fields and real high-LOD near trees) are well within Quest 2 budget as long as everything stays instanced -- the ceiling is instance count in the hundreds of thousands, not triangle count or alpha masking.

## Known-broken, not yet testable here

- Water/QMaps: doesn't render correctly in `/questv3` or `/quest`.

## Next test planned

Landscape/terrain complexity tolerance -- now that prop density is proven out, push terrain scale/vertex density to find its own ceiling. Separately, still open: disentangle the exact cause of the 250k-500k instanced-billboard cliff (CPU matrix-upload cost vs. GPU vertex throughput at high instance counts).
