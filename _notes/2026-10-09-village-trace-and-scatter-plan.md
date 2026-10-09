# Village trace 2026-10-09T13-58-34 and the scatter plan

## The trace
Mid-afternoon at the village centre, 90 Hz, fb 1. Baselines drift 19 to 24 ms; floor (everything off) is 11.5 ms, at vsync. CPU is js 4.4 plus render 9 against an 11.1 ms vsync, so every frame misses and snaps to two vsyncs (22 ms). The upload columns are empty: this build predates the counter.

| group off | saved ms | cpu ms | calls | tris |
|---|---|---|---|---|
| scatter | 2.8 / 4.9 | 3.4 | 34 | 166k |
| village | 2.6 / 3.0 | 2.2 | 21 | 52k |
| animals | 1.3 / 2.5 | 1.9 | 9 | 6k |
| sky+fire, water, terrain | under 1 | | | |

Scatter ladder (marginal): litter 3.1 ms for 4 calls and 65k tris; boulders about 0 for 13 calls; ferns about 0.1; grass+trees 1.5 for 13 calls. Village: townsfolk 3.2 (people 1.9), towns 1.2 for 2 calls. The village drill is overlapping (parts share a cost).

## Findings
- Draw calls do not predict cost: litter is the dearest scatter layer with the fewest calls, boulders the reverse. The cost is per-frame CPU work in the layer (tile loops, buffer writes) or what the driver does with its buffers, not submission.
- Ferns are close to free once litter and boulders are off, so the fern card tier is not the problem.
- Grass+trees 1.5 ms is not split yet (MAX_DRILL cut the grass rung). Raised MAX_DRILL to 12 so the next run separates them.

## Grass and ferns: what is known
- Draw calls: 13 calls (both eyes) cannot be 1.5 ms. Excluded.
- Fill: fbscale 0.7 changed nothing in the earlier night trace, so the scene is not fill-bound. grass.js documents the alpha-test (`discard`) low-res-Z loss; there is no toggle to test it.
- Wind: a global `wind` toggle exists. New battery group `wind` (once) prices it across grass, ferns and trees.
- Uploads: ruled out for standing still. Desktop, per layer toggled off: the whole frame uploads about 24 calls and 0.4 to 0.5 MB, and removing litter, grass, ferns, trees, boulders or townsfolk moves it by noise only. Walking is another matter: about 8.8 MB a frame, trees about half (tile growth). The village trace was a stand-still trace, so uploads do not explain litter's 2.7 ms there.
- Per-triangle cost: the trace's savings run about 0.05 ms per 1k tris for litter (3.1 ms, 65k), 0.02 for grass+trees (1.5, 71k), 0.008 for opaque terrain (0.7, 84k), none for boulders and ferns. The alpha-tested layers cost several times more per triangle than opaque ones. That fits alpha-test/overdraw or vertex cost on the tile-based GPU, and the `cards half` group tells them apart for the shared card pool.
- Hidden-instance vertices: the rim dissolve takes hidden instances off the GPU; grass keeps about 4k resident-but-dissolved, drawn count is already trimmed.
- Missing: an alpha-mask-off toggle for grass/ferns, and a grass-only rung (now unblocked).

## Plan
1. Next trace on a fresh deploy: the grass rung, the wind group and `cards half`. Uploads are already ruled out.
2. Litter: gate its tile loops on camera movement (skip when the eye moved under STILL_M), as the desktop profile shows standing-still loops are cheap but walking tile growth is not.
3. A shared per-tile height/path cache for tile growth (litter, rocks, grass): `heightAt`, `carveRivers`, `_nearestInto` dominate walking cost.
4. Trees: clump tier now in the shared pool (done). Single 1-tri cards stay out; a SharedTri pool for distant single trees of several species is the follow-up.
5. NPC efficient autopilot stays queued until upl shows townsfolk buffer writes matter.
