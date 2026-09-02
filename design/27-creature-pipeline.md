# §27 -- the creature pipeline

Wildlife and people, made from a sentence. One bench, `/gen-creature`, runs the whole chain: a candidate image, a mesh and texture generated from it, a skeleton, and animation clips -- each stage previewed before the next is paid for.

This is the first pipeline in the tree that **spends real money per click**, and that fact shapes every design decision below far more than the rendering does.

## Why a vendor at all

The tree already has two home-grown asset pipelines and both stay:

- `tools/characters/` -- chromakey a generated sheet, loft a mesh from the silhouette, rig, animate. Good for humanoids seen at village distance, and free per asset after the image.
- `tools/fauna/` -- the same idea for fish, where a lofted profile IS the animal.

Both work because their subjects are approximately extrusions of a silhouette. A fox is not. The loft has no answer for four legs that occlude each other, for antlers, or for a muzzle that is a different width than the skull. Rather than grow the loft into a general reconstruction engine, this pipeline hands that one job -- silhouette to volume -- to a vendor and keeps everything else local.

## Why Tripo and not Meshy

Meshy was researched first and rejected on one hard fact: **its rigging and animation API is biped-only.** There is no `rig_type` parameter, no quadruped entries in the API changelog through 2026-08-28, and every animation preview in its library is served under `biped/`. Its webapp guide claims "humanoid and quadruped characters", which contradicts its own API reference; the API is the thing being integrated, so the API wins. A pipeline that cannot rig a fox does not solve the problem that motivated it.

Tripo exposes seven skeleton families -- `biped`, `quadruped`, `hexapod`, `octopod`, `avian`, `serpentine`, `aquatic` -- which covers the whole intended roster.

**Tripo's animation library is nevertheless lopsided**, and this is the pipeline's one real gap. Bipeds get eleven presets on the v2.5 rig model; quadruped, hexapod and octopod get a single `walk` each, serpentine and aquatic a single `march`, and **avian gets none at all**. So Tripo is used for the mesh and the *skeleton*, and everything past the first gait is authored here. That is workable because `tools/characters/animations.mjs` already writes clips as functions of a 0..1 phase against a fixed bone hierarchy, and Tripo's `spec: 'mixamo'` yields Mixamo-compatible bone names -- the same names those clips are already written against, with no mapping table in between.

`PRESETS` in `tools/creatures/tripo.mjs` is the honest record of that coverage, including the empty `avian` array. `scripts/check-creatures.mjs` asserts the biped/quadruped asymmetry rather than papering over it, so the day it changes, the gate says so.

## The 128px texture is the gate, not the polycount

This is the load-bearing idea of the whole section.

Everything in this world ships with a 128px texture. Triangle budget is a solved problem -- `face_limit` handles it, and `src/budget.js` says what the number has to be. The unsolved problem is that **a mesh's UV layout decides whether its texture survives being 128 pixels wide**, and nothing about the triangle count tells you that.

A high-fidelity model that is decimated down to budget gets its UVs re-solved after the fact, and an auto-unwrap of a decimated surface produces a scatter of many small islands. At 128px each island is a handful of texels; the smallest ones round away to nothing, and bilinear filtering bleeds neighbouring islands across every seam because there is no room left for a gutter. The full-size texture looks fine. The shipped one is mush.

**P1 Smart Mesh (`P1-20260311`) is the default for this reason.** It generates native quad topology with coherent edge flow rather than decimating a dense surface, so the unwrap yields fewer and larger islands, and those survive the downrez. It is also all-inclusive on price where H3 stacks surcharges, which makes the default the cheap option too.

The bench is built around checking this and nothing else is as important: `#texRow` draws the same texture into a 256px and a 128px canvas side by side, `image-rendering: pixelated` so the browser's smoothing does not flatter it. **Judge a candidate on the small panel.** H3 (`v3.1-20260211`) stays selectable for the case where a creature genuinely needs the fidelity and someone has looked at both panels and decided.

## The stages

| # | stage | vendor | cost | writes |
|---|---|---|---|---|
| 1 | species | -- | free | (form state) |
| 2 | candidate image | OpenRouter, FLUX.2 Klein 4B | ~$0.015 | `candidates/<n>.png` |
| 3 | mesh + texture | Tripo image-to-model | $0.40--$0.55 | `mesh.glb` |
| 3b | LOD ladder | **ours** (`src/mesh/decimate.js`) | free | `mesh-lod<n>.glb` |
| 4a | rig-check | Tripo | **free** | -- |
| 4b | rig | Tripo | $0.25 | `rig.glb` |
| 5 | animations | Tripo retarget | $0.10 each | `anim-<preset>.glb` |

A full creature -- P1 mesh with texture, a rig, three clips -- is **105 credits, $1.05**. `check-creatures.mjs` pins that number, so a change to any price or default that moves it fails the gate rather than surprising the next invoice.

### Stage 2: the image is not a character sheet

`tools/creatures/creature-prompt.mjs` is deliberately not `tools/characters/sheet-prompt.mjs` and must not drift toward it. Those images get chroma-keyed and measured; this one gets handed whole to a reconstruction model that paints a texture from it. Three consequences:

- **Neutral light-grey background, never `#FF00FF`.** A saturated key bleeds a magenta rim into the fur of the shipped texture. The gate asserts no prompt asks for a chroma key.
- **Flat shadowless light.** Any cast shadow or rim light bakes into base colour and then fights `src/lighting.js` forever. Not undoable downstream.
- **Three-quarter view, not orthographic front.** Reconstruction wants depth; the chromakey loft wanted a flat measurable profile.

The pose clause is selected by rig type, because **a limb tucked against the torso is the documented cause of a bad auto-rig** -- the solver cannot find a leg it cannot see. Each clause asks for limbs held clear of the body; the serpentine clause, having no limbs to separate, forbids the body coiling across itself instead, which is the same failure in a different shape.

### Stage 3: quad topology, and what the +5 credits buy

H3 charges 5 extra credits for `quad: true`. P1 charges nothing, because quads are what it generates.

**glTF has no quad primitive.** Mode 4 is TRIANGLES and there is no other option, so whichever model produced it, `mesh.glb` arrives triangulated and no runtime anywhere in this repo will ever see a quad. Paying for quad mode does not buy a different file format. It buys a different *arrangement* of the triangles inside the same format: a quad-generated mesh is triangle pairs that were coplanar quads a moment earlier, laid out in edge loops that follow the form.

That arrangement is not cosmetic, and it matters for exactly one reason -- the one the previous section is about. Edge loops that follow the form unwrap into few large UV islands. Scattered triangles unwrap into many small ones. At 128px the second kind is mush.

`estimateQuadFraction()` in `src/mesh/decimate.js` measures what survived: it greedily pairs adjacent triangles whose face normals agree to within `cosTol` and reports the fraction claimed. It is a lower bound and it is ambiguous on flat regions -- on a plane every neighbour is coplanar, so a flat grid reads ~0.91 rather than 1.0 while genuinely-independent planar quads read exactly 1.0. As a comparator between two meshes of the same creature it is still the right instrument, and the bench prints it next to the island count where the comparison is easy.

**Practically: pay it on H3, or use P1 and do not think about it.** P1 is the default and its price is all-inclusive, so the surcharge only ever arises when someone has deliberately chosen H3 for fidelity -- and having made that choice, refusing the 5 credits gives up the property that made H3 worth choosing. Five credits is $0.05 against a $1.05 creature.

### Stage 3b: the LOD ladder is ours

Tripo will also sell retopology. Buying it would put the one step that can be iterated for free behind a per-attempt charge, so `src/mesh/decimate.js` does it instead: quadric error metric, half-edge collapse, plain arrays in and out, no dependency on three so the same code runs in the bench tab and under `scripts/check-decimate.mjs` in node.

**The one rule: a vertex on a UV seam or a geometric boundary is never moved and never removed.** Half-edge collapse means the surviving vertex stays exactly where it was, so no position, UV or normal is ever interpolated or invented. The gate asserts this directly -- every UV in the output existed in the input, zero foreign -- because a decimator that computes new texture coordinates is a decimator that can put one in the wrong island, and that is the same 128px failure arriving by a different road.

three's `SimplifyModifier` was read and rejected. It carries a `uv` attribute through, but `computeEdgeCollapseCost` is `edgelength * curvature` with no attribute term at all, and its border-cost branch is commented out. On a textured mesh it will happily collapse across a seam.

**The reduction ceiling is a measurement, not a bug.** Pinning seams and boundaries means a mesh can refuse to reach its target, and how far it does get is a direct reading of how few, how large and how well-closed its UV islands are -- the same property that decides 128px survival. The bench prints the island count, the pinned fraction, the unremovable-face floor and, per tier, why it stopped.

Run against this repo's own props the ceiling is severe, and the numbers say why:

| mesh | tris | islands | pinned | reached, asked 50% |
|---|---|---|---|---|
| `gen_oak_LOD0` | 494 | 2 | 88% | 28% |
| `tree_cracked_dead_LOD0` | 500 | 120 | 95% | 2% |

Two different causes. The oak is open surfaces -- leaf cards, an open trunk -- so almost every vertex is a geometric boundary. The dead tree is atlas-mapped with roughly an island per face, so almost every edge is a UV seam. Both are already-baked Blender LODs, which is to say the worst case and not the target: a Tripo mesh is one closed organic surface with a single unwrap. **That is untested -- no mesh has been generated yet -- and it is the first thing to look at on the first real run.** If the ceiling turns out to bite there too, the fix is known and is a real piece of work: allow collapses that run *along* a seam or boundary by choosing, per rewritten face, the corner of the surviving vertex that lies in that face's own UV island. Today's version forbids them outright.

Tiers are decimated from the tier above rather than from the original, so tier 2's vertices are a subset of tier 1's and swapping between them does not pop.

### Stage 4: rig-check first, always

`POST /v3/animations/rig-check` costs nothing and returns `riggable` plus a recommended `rig_type`. It is the only way to learn that a mesh will not take a skeleton without paying 25 credits to find out. The bench offers it as its own non-orange button and writes Tripo's suggestion back into the rig-type selector.

`rigType: 'none'` is a real answer, not a gap. A butterfly wants two textured planes on a hinge -- `gen-butterfly.html` already does that better and cheaper than a rigged solid mesh would -- and a frog is small enough that a hop is a whole-body transform.

## The spend model

The project's standing rule is that external API dollars are a separate budget from tokens and never get spent without a human deciding. That rule is implemented, not just documented:

- **Nothing fires on its own.** No retry loop, no auto-advance between stages, no batch. Each stage is one explicit click.
- **The price is on the button face**, computed by `estimateCredits` -- pure arithmetic, no network -- before the click. It lives beside the request builders in `tripo.mjs` so a cost-changing parameter cannot be added without the estimate landing in the same diff, and the gate pins the resulting table against Tripo's published prices.
- **Orange means it charges a card.** `button.spend` in `gen-creature.html`. `rig-check` is not orange.
- **The ledger sums server-reported costs only**, never client estimates -- what the page shows is what was actually billed.
- **`waitForTask` has a hard timeout and no retry.** A stuck task is something to look at, not to silently resubmit; a retry loop here spends money per iteration.

## State on disk survives a restart

Everything lands under `tools/creatures/work/<id>/` (gitignored -- these are working sources; the bake step is what writes `public/`):

```
candidates/<n>.png   every generated candidate
source.png           the picked one -- the single image every Tripo step reads
mesh.glb             textured mesh
mesh-preview.png     Tripo's own render
rig.glb              skeleton bound to the mesh
anim-<preset>.glb    one file per retargeted clip
state.json           task ids, credits, picks
```

**A Tripo task id is the only handle on work already paid for.** `charge()` in `workspace.mjs` writes it to `state.json` the moment the task is created, *before* the wait -- so a dev-server restart mid-generation loses the poll, not the purchase. For the same reason every output is downloaded to disk in the request that observed success: Tripo's result URLs are CDN links that expire, and a stored URL is a receipt for something you can no longer collect.

The bench's stage buttons gate on `/__creature-assets`, which reads that directory, so a reload mid-pipeline resumes where it stopped rather than restarting.

## Where the pieces live

```
tools/creatures/tripo.mjs            v3 API client: upload, mesh, rig-check, rig, retarget, poll, and the credit table
tools/creatures/creature-prompt.mjs  the image prompt and its per-rig-type pose clause
tools/creatures/creature-roster.mjs  the starter roster (9 creatures)
tools/creatures/workspace.mjs        disk layout, the library index, the prompt store, the four orchestrated steps
src/mesh/decimate.js                 the LOD decimator -- three-free, runs in the tab and in node
gen-creature.html                    the bench
src/gen-creature-main.js             its page logic, library, LOD ladder and 3D preview
scripts/check-creatures.mjs          the pipeline gate -- network-free, spends nothing
scripts/check-decimate.mjs           the decimator gate -- synthetic fixtures whose answers are known by construction
vite.config.js  creatureGen()        the dev-server endpoints; the only place the API keys are read
```

The bench's library overlay lists every creature the roster seeds *and* every directory under `work/`, with its prompt, its thumbnail, what stages exist for it and what it has cost so far. **The prompt is editable and saves into the creature's own `state.json`, not into the roster file.** That is what lets a creature be invented in the page and survive a reload without an edit to `creature-roster.mjs`; the roster stays a seed list, and promoting a settled creature into it is a separate, deliberate act.

Orchestration lives in `workspace.mjs` rather than in the Vite plugin so a batch script can drive the same pipeline later without a browser. `creatureGen()` is a thin wrapper: it validates the creature id (`/^[a-z0-9-]+$/`) and returns JSON for every outcome including errors.

**The id validator is a security boundary, not tidiness.** It arrives from a query string and is concatenated into a filesystem path, and the dev server binds to the LAN (`server.host`). `../` in that string is an arbitrary file write. The gate tests it against traversal directly.

`TRIPO_API_KEY` and `OPENROUTER_API_KEY` live in `.env` (gitignored) and are read only by dev-server middleware. Neither ever reaches the browser.

## Adding a second vendor

The seam is `tools/creatures/tripo.mjs`. It exports a small surface -- `uploadImage`, `createMeshTask`, `createRigTask`, `createRetargetTask`, `waitForTask`, `estimateCredits` -- and `workspace.mjs` is the only caller. A Meshy client implementing the same surface would slot in behind a model selector, at the cost of losing non-biped rigging for creatures generated through it. Nothing else in the tree imports the vendor client.

## Unverified

**The exact v3 multipart upload path and field name were never confirmed in Tripo's published docs** -- they are inconsistent about the base URL, showing both `api.tripo3d.ai/v2/openapi/task` and `openapi.tripo3d.ai/v3`. v3 was chosen because the animation endpoints exist only there. `unwrap()` quotes the raw response body when it is not JSON, because an HTML error page from a wrong path is the single most likely first-run failure and "unexpected token <" would hide it; `uploadImage` throws explicitly when no `file_token` comes back. The first real run settles this.

Nothing in this pipeline has been run against the live API yet. Everything above is built and gated; none of it has spent a credit.
