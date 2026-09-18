# §29 -- generated props: the creature pipeline with the rig cut off

A stump, a log, a mushroom, a skeleton or a cave mouth, made from a sentence. One bench, `/gen-prop`, runs the chain: a candidate image, a mesh reconstructed from it, our own LOD ladder, a card cross for the far rung. It is §27's pipeline stopped at stage 3b -- nothing here has a skeleton, so there is no rig stage, no animation stage, no clip solver -- and it reuses §27's vendor client (`tools/creatures/tripo.mjs`), decimator (`src/mesh/decimate.js`), card bake (`src/props/impostor.js` helpers) and spend model wholesale. What it adds is a prompt for scenery, a roster of props, and a workspace that does not know what a rig is.

## Why this exists: the procedural deadwood and mushrooms have no personality

§21's deadwood is one swept surface and §24's mushrooms are a two-knob cap family. Both are cheap and both are correct and neither has a face: every stump is the same stump with a different seed, its rim a clean sweep rather than a crown of torn splinters, and the world is a place where a hollow log with a shelf-fungus underside and a knuckled root flare would be a landmark rather than a tile. §27 showed that a reconstruction model given a detailed concept image hands back a mesh that keeps the detail in its silhouette and its atlas. That is exactly the knob the procedural generators lack, so the plan is to author a small library of prop *characters* this way -- the rotting stump, the fallen log, the fly agaric, the deer skeleton, the cave mouth -- and scatter those, while §21 and §24 stay as the generic fill.

## What differs from a creature

**The prompt asks for a gritty, real specimen with a jagged outline.** `tools/props/gen/prop-prompt.mjs` keeps every staging rule §27 stage 2 found the hard way (neutral grey cyclorama, shadowless light, three-quarter view, never a chroma key) and adds a `HOUSE_STYLE` clause: photorealistic and weathered, dense fine surface detail in true muted colour, a jagged broken irregular silhouette, never smoothed or simplified. The first draft asked for a "stylised hand-painted low-poly game asset" and the pictures came back smooth, rounded and cartoonish -- the reconstruction and the decimator will simplify the mesh quite enough on their own, and the one thing they cannot add back is grit. `check-prop-gen.mjs` refuses a prompt that asks for low-poly or stylised again.

**Only name what belongs in the picture.** FLUX Klein is literal: every noun is a thing to paint, and a negation or a contrast plants exactly what it rules out. "Snapped off rather than sawn" produced a stump of sawn boards; "about a person's height" is an invitation to paint a person, "beetle galleries" a beetle, "like a bread roll" bread. So the house style and every roster description are written as positive statements of what is there -- sizes in metres, holes as "small dark round bore holes", a root flare as "gnarled" and not "like knuckles" -- and the gate refuses negations, contrasts, similes and the off-subject nouns that have bitten. The staging paragraph's "no shadow, no text" list is the one carried-over exception, from the creature prompt where it proved out. Per-prop `styleNote` extends the house style; it never replaces the staging, and it is the one piece of prompt text the gate cannot see, so the same rule applies to it by hand.

**Every mushroom is one specimen.** A generated cluster is the same three mushrooms in the same arrangement at every site it stands on; copies of one mesh scattered by the placer at random sizes, tilts and spacings make a different clump every time. So the roster's mushrooms are single fruiting bodies at their real size (a fly agaric at 0.2 m, a honey fungus at 0.12 m), framed 3:4, and the clustering is the scatter's job.

**The subject is told it rests on the floor with its underside flat on the ground.** The card bake seats a prop at y = 0 and so does the world. A prop drawn floating, or on a plinth, reconstructs with a base that is not flat, and that shows as a stump hovering a hand's width above the moss at every scatter site.

**Only the stages a prop has.** The pipeline is:

| stage | who | cost | output |
|---|---|---|---|
| 1 | candidate image (OpenRouter, §27's image models) | ~$0.015 | `work/<id>/candidates/<n>.png` |
| 2 | mesh (Tripo image-to-model, P1 by default, textured, quad) | 50 credits ($0.50) | `work/<id>/meshes/<n>.glb` or `.fbx` |
| 3 | LOD ladder + card cross | ours, in the browser | free | `work/<id>/meshes/<n>-lod<k>.glb` |

Every mesh is asked for textured: unlike §28's trees, a prop's colour is in its atlas and there is nothing to paint it with afterwards. The bench prices the mesh button from the same `estimateCredits` table `check-creatures.mjs` pins, and `check-prop-gen.mjs` pins the textured-P1 figure it quotes.

**The roster carries a size and a category, not a rig type.** `tools/props/gen/prop-roster.mjs`: `sizeM` is the prop's longest dimension in metres (what the bench frames the viewer on -- Tripo's own output scale is a claim about nothing, so the viewer frames on the file's bounds, and the world never reads `sizeM`: each scatter carries its own metre band and rescales the ladder per instance); `category` is the world layer that will eventually scatter it (`deadwood`, `mushroom`, `bones`, `cave`, `other`) and nothing else keys on it. `texPx` and `shipTexPx()` are §27's, imported: mushrooms are designated `TEX_PX_SMALL` because they are a few pixels tall in the world, everything else ships at the cap.

## What is the same, on purpose

The spend model is §27's, unchanged: nothing fires on its own, the orange buttons carry their price on their face, the ledger sums what the server reports, a task id is written to `state.json` before the wait, nothing paid for is ever overwritten (candidate and mesh slots are claimed with exclusive creates), and the generate buttons go dead for one second so a double-click is one charge. The library grid shows every prop's prompt beside what it cost, because two props that came out wrong usually came out wrong the same way.

The viewer is §27's: colour map only, fully matte, every Tripo file culled on load through `src/tripo-culling.js` (pinned by `check-prop-gen.mjs`, because `check-creatures.mjs` only scans for files that load from the creature work dir), and the two texture twins so a prop is judged at the 512 it ships at or the 128 it is designated, never at Tripo's 2048.

The ladder and the card cross are §27 stage 3b verbatim -- same decimator, same weld and weight knobs, same `bakeCardCross` photographing the front card down the viewer's current bearing and the side card a quarter turn round. A prop is a better fit for the card rung than a creature is: it does not move, so the two silhouettes it was photographed at are the two silhouettes it will ever show.

## Shipping, and the scatters that draw the result

`npm run props:ship [id ...]` (`tools/props/gen/ship.mjs`) moves every picked mesh and its saved tiers out of the gitignored workspace into `public/gen-props/<id>.glb`, `<id>-lod1..3.glb` and `<id>.webp`, packed the way a critter ships: only the buffer views the accessors read, one material on an external WebP boxed to the roster's `texPx`. Not `public/props/`, which `npm run props` wipes before the Blender build. Two things differ from a creature: the mesh node ships under the identity rather than Tripo's node yaw, so in its own frame a prop is axis-aligned and the world measures its length and radius straight off the pick; and no index is written, because each scatter names the files it wants and carries its own metre band. Commit what it writes. A roster entry flagged `delight` ships its map flattened first (`tools/props/gen/delight.mjs`): Tripo paints the side the concept never showed, and paints it in shadow -- the fallen log's map measures five times darker where the mesh faces down than up, a gradient the sun then adds to and which rolls with the log -- so the pass rasterises the mesh's normals into UV space, fits luminance against `normal.y` by least squares and scales every texel to the fit's mean (gain capped at 4x, hue kept, uncovered texels taking their nearest neighbour's gain so mips do not bleed the shadow back). Run bare it writes `work/<id>/delight-preview.png` and prints the luminance by facing before and after, which is how to judge the flag; the concept prompt cannot fix this, since it already asks for shadowless light and the reconstruction's underside was never in the picture, and a fresh image cannot be dropped in either, since the map is the pick's own UV atlas.

`src/v2/render/gen-props.js` is the browser side: `loadGenProp(url, { longAxisZ })` fetches the four tiers, centres the pick over its feet at y = 0, moves every tier by the pick's own move and turns the long axis onto Z when asked, and hands back `{ geometries, map, bounds }` with `bounds.long/width/height` in the file's own units; `createGenPropMaterial` is the one Lambert the scatters share, with the rim fade in a per-instance `aPropFade`. `scripts/lib/gen-prop-node.mjs` reads the same ladder off disk for the gates, so a scatter's node gate builds the bank the browser builds.

Two scatters draw the four props shipped so far, both on `PropArena` and both stepping the ladder pick, lod2, card on the creatures' rule with the props' own spacing (§5, `ladderTier` over gen-props.js's `PROP_STEPS` and `PROP_MESH_TIERS`): the pick to 12.7 degrees of the instance's longest axis, lod2 to half that arc, the card to 72 sizes, and the instance culled past that by its own size through the rim (`rim.place`); lod1 and lod3 ship but are not drawn, each rung being a draw call per variant on an instanced prop, so the tile grid reaches the bank's biggest piece's cull and holds mostly hidden instances. A standing prop (stump, skull) takes one 'side' quad spun to the eye in the vertex shader (`createGenPropMaterial`'s `billboard`, `spunBounds` widening it to the pick's widest side); a lying one (log, skeleton) takes its side view crossed about its own axis (`setAxisCard`, two quads, upright and flat), since a spun quad would show a lying thing's broadside from every bearing. `src/v2/render/deadwood.js` is §21's scatter with the rotting stump standing in for the snag at 1-4 m tall and the fallen log for the log at 2-10 m long; its bank is `deadwoodBankFrom` over the two shipped ladders, and the procedural generator stays behind the `/gen-deadwood` bench. `src/v2/render/bones.js` is new: one candidate per 40 m tile kept at 32 %, seated by §21's rule, a deer skeleton at 2-5 m long and an elk skull at 0.5-3 m, the skeleton's cap opening to 10 m where the ground is drowned or above the snowline. `scripts/check-deadwood.mjs` and `scripts/check-bones.mjs` pin the bank shape, the card shape, the size bands, the seating gap, the per-piece cull and the ladder walk.

## Where things are

```
gen-prop.html                        the bench page
src/gen-prop-main.js                 the bench: galleries, viewer, texture twins, ladder, card bake, tier save
tools/props/gen/prop-prompt.mjs      the prompt: §27's staging plus the house style
tools/props/gen/prop-roster.mjs      the seed props, CATEGORIES, shipTexPx
tools/props/gen/workspace.mjs        work/<id>/: candidates, meshes, picks, tiers, meta, the ledger
tools/props/gen/work/<id>/           gitignored: candidates/, meshes/, source.png, mesh.<ext>, state.json
vite.config.js  propGen()            the /__prop-* endpoints; the only place the API keys are read
scripts/check-prop-gen.mjs           the gate: id validator, prompt rules, roster shape, the quoted price, the culling import
tools/props/gen/ship.mjs             the shipper: work/<id>/ -> public/gen-props/ (npm run props:ship)
public/gen-props/                    the shipped ladders and colour maps, committed
src/v2/render/gen-props.js           the world's loader for a shipped ladder and the shared prop material
scripts/lib/gen-prop-node.mjs        the same ladder read in node, for the scatter gates
src/v2/render/deadwood.js            the stump and log scatter (§21); scripts/check-deadwood.mjs
src/v2/render/bones.js               the skeleton and skull scatter; scripts/check-bones.mjs
```
