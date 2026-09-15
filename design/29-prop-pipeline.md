# §29 -- generated props: the creature pipeline with the rig cut off

A stump, a log, a mushroom, a skeleton or a cave mouth, made from a sentence. One bench, `/gen-prop`, runs the chain: a candidate image, a mesh reconstructed from it, our own LOD ladder, a card cross for the far rung. It is §27's pipeline stopped at stage 3b -- nothing here has a skeleton, so there is no rig stage, no animation stage, no clip solver -- and it reuses §27's vendor client (`tools/creatures/tripo.mjs`), decimator (`src/mesh/decimate.js`), card bake (`src/props/impostor.js` helpers) and spend model wholesale. What it adds is a prompt for scenery, a roster of props, and a workspace that does not know what a rig is.

## Why this exists: the procedural deadwood and mushrooms have no personality

§21's deadwood is one swept surface and §24's mushrooms are a two-knob cap family. Both are cheap and both are correct and neither has a face: every stump is the same stump with a different seed, and the world is a place where a hollow log with a shelf-fungus underside and a knuckled root flare would be a landmark rather than a tile. §27 showed that a reconstruction model given a stylised, exaggerated concept image hands back a mesh that keeps the exaggeration. That is exactly the knob the procedural generators lack, so the plan is to author a small library of prop *characters* this way -- the rotting stump, the fallen log, the fly agaric cluster, the deer skeleton, the cave mouth -- and scatter those, while §21 and §24 stay as the generic fill.

## What differs from a creature

**The prompt asks for a game asset, not a specimen.** `tools/props/gen/prop-prompt.mjs` keeps every staging rule §27 stage 2 found the hard way (neutral grey cyclorama, shadowless light, three-quarter view, never a chroma key) and adds a `HOUSE_STYLE` clause: chunky exaggerated forms, a silhouette that reads at a glance, painterly shading in the paint itself. A prop is judged from sixty metres on a four-triangle card, and a botanically correct bolete reads as nothing at that range; a comically heavy one reads as a bolete. Per-prop `styleNote` extends the house style; it never replaces the staging.

**The subject is told it rests on the floor with its underside flat on the ground.** The card bake seats a prop at y = 0 and so does the world. A prop drawn floating, or on a plinth, reconstructs with a base that is not flat, and that shows as a stump hovering a hand's width above the moss at every scatter site.

**Only the stages a prop has.** The pipeline is:

| stage | who | cost | output |
|---|---|---|---|
| 1 | candidate image (OpenRouter, §27's image models) | ~$0.015 | `work/<id>/candidates/<n>.png` |
| 2 | mesh (Tripo image-to-model, P1 by default, textured, quad) | 50 credits ($0.50) | `work/<id>/meshes/<n>.glb` or `.fbx` |
| 3 | LOD ladder + card cross | ours, in the browser | free | `work/<id>/meshes/<n>-lod<k>.glb` |

Every mesh is asked for textured: unlike §28's trees, a prop's colour is in its atlas and there is nothing to paint it with afterwards. The bench prices the mesh button from the same `estimateCredits` table `check-creatures.mjs` pins, and `check-prop-gen.mjs` pins the textured-P1 figure it quotes.

**The roster carries a size and a category, not a rig type.** `tools/props/gen/prop-roster.mjs`: `sizeM` is the prop's longest dimension in metres (the scale the world will place it at -- Tripo's own output scale is a claim about nothing, so the viewer frames on the file's bounds and the shipper will rescale to `sizeM`); `category` is the world layer that will eventually scatter it (`deadwood`, `mushroom`, `bones`, `cave`, `other`) and nothing else keys on it. `texPx` and `shipTexPx()` are §27's, imported: mushrooms are designated `TEX_PX_SMALL` because they are a few pixels tall in the world, everything else ships at the cap.

## What is the same, on purpose

The spend model is §27's, unchanged: nothing fires on its own, the orange buttons carry their price on their face, the ledger sums what the server reports, a task id is written to `state.json` before the wait, nothing paid for is ever overwritten (candidate and mesh slots are claimed with exclusive creates), and the generate buttons go dead for one second so a double-click is one charge. The library grid shows every prop's prompt beside what it cost, because two props that came out wrong usually came out wrong the same way.

The viewer is §27's: colour map only, fully matte, every Tripo file culled on load through `src/tripo-culling.js` (pinned by `check-prop-gen.mjs`, because `check-creatures.mjs` only scans for files that load from the creature work dir), and the two texture twins so a prop is judged at the 512 it ships at or the 128 it is designated, never at Tripo's 2048.

The ladder and the card cross are §27 stage 3b verbatim -- same decimator, same weld and weight knobs, same `bakeCardCross` photographing the front card down the viewer's current bearing and the side card a quarter turn round. A prop is a better fit for the card rung than a creature is: it does not move, so the two silhouettes it was photographed at are the two silhouettes it will ever show.

## What is not built yet

The shipper. A picked mesh sits in `tools/props/gen/work/<id>/mesh.glb` with its tiers beside it and nothing moves it to `public/props/` or rescales it to `sizeM`; that is the same job `tools/creatures/ship-quadruped.mjs` does for a creature minus the skeleton, and it waits on the first prop worth shipping. The scatter side -- which of §21's and §24's anchor sites take a generated character instead of a procedural fill -- is a renderer change for when there are assets to scatter.

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
```
