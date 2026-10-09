# Quest 80 FPS ledger

The standing record of what the trace battery has established. Read this before proposing a perf experiment. Edit facts in place; per-trace chronology lives in `2026-10-05-perf-trace-findings.md` and `design/history/`.

Goal: 80 Hz on Quest 2 in every environment (12.5 ms budget; the headset runs 90 Hz, 11.1 ms, so a CPU-bound frame snaps to 22 ms).

## How to measure
- Pull with `bash ./devops/fetch-traces.sh`, read with `node scripts/trace-report.mjs <id>`. The battery is `src/v2/perf-suite.js`; it must stay near two minutes (the user will not sit through seven).
- `calls` are two-eye sums. `gpuMs` is null on this headset. `waitMs` includes idle to vsync. "cpu" (js + rend) is the smooth column; "saved" steps in jumps.
- The battery drifts thermally (about 19 to 23.6 ms over a run). A single state is good to about ±1 to 2 ms. Trust only a group that repeats across both rounds (spread under about 1 ms); baselines are interpolated per state.
- Ambient traces (record mode) show per-window stages and the worst frames; use them for hitches, the battery for steady-state cost.

## Current budget (village, trace 2026-10-09T21-34-55, ms saved by turning off)
- Floor (everything off): 11.5 ms, at vsync; cpu 3.4. Baseline about 22 ms, cpu js 4.0 + rend 8.4 = 12.4.
- scatter 3.6 / 3.9 (ladder: boulders about 1.5, litter and grass about 1 each, trees 0.6, ferns about 0)
- animals 2.4 / 3.2 (water critters 1.4, insects 1.2, wildlife 1.4; no single part removes "animals" itself)
- village 2.8 / 2.6 (townsfolk 2.1, people 2.0 with 16 calls and 21 upload calls, towns 1.0, hearth+forge 1.3, striders 0.1)
- terrain 1.9 / 1.4; water, sky+fire 0.2 to 1.8 and not repeatable
- Ambient town (12:09): js 6 to 8 + rend 9 = 15 to 17 ms cpu, worse than the battery spot. Forest (08:30): rend 7.3 to 8.5, grass 1.3 and rocks 0.8 mean.

## Hitches (they cost more than the means)
- `probes` 4 to 5 ms on most windows in town and forest; `grass` 3 to 6 ms and `rocks` 2 to 7 ms tile growth while moving; `ferns` 2 to 4.5; `pebbles` 5 to 6 ms in the forest; a 79 ms `sky+ambience` frame; 15.9 ms `animals` spike; `other` (GC, A-Frame, GPU wait) 10 to 78 ms on single frames.

## Falsified (do not retry)
- Halving litter, grass or the card pool: saves 0 within noise. Dropping the alpha discard on litter or grass: 0 within noise. Wind off: 0 or negative.
- Upload bytes: about 50 KB standing and 1 MB walking per frame. Not the cost.
- Per-triangle cost: pebbles at 56k tris cost 0.3 to 0.8; mushrooms at 500 tris and sticks at 4.5k cost 0.3 to 0.6. The earlier "sticks and mushrooms 1 ms each" did not repeat.
- Hiding empty instanced meshes (`PropMeshes` hides at `count 0`): baseline unchanged (22.3 ms before and after, render 8.4 vs 8.2). Three does still run `setProgram` and the VAO setup for a visible mesh with `count 0` (`renderBufferDirect`), but it is not the lever.
- Fill: `fb 0.7` changed nothing in an earlier night trace.
- Fireflies: 0.8 in one trace, -0.8 in the next. Noise.

## Open, ranked by evidence
1. Townsfolk: 2 to 3 ms, 21 small upload calls (`baked-puppet`, `v2-strider-reins`); the NPC efficient autopilot (GPU clip time, velocity position) is queued.
2. Probes, grass and rocks tile-growth hitches while moving; a shared per-tile height/path cache (`heightAt`, `carveRivers`, `_nearestInto` dominate); gate litter loops on camera movement.
3. Boulders about 1.5 ms (10 calls).
4. Animals: water critters, insects, wildlife about 1.2 each.
5. A SharedTri pool for distant single trees.

## Structural facts
- `LitterCards` is the shared far-card pool (12,288 instances; real use 5 to 6k). Clumps in it get no snow whitening and no wind; mipmaps are on for all users.
- `PropMeshes` and `PropArena` use swap-remove packing and range uploads; `InstancedArena` (instanced-arena.js, used by grass) tracks dirty ranges. three's ranged `bufferSubData` passes the whole array, so count `length * BYTES_PER_ELEMENT` (`gl-uploads.js` does).
- Battery A/B rows (`cardsHalf`, `litterDiscard`, `grassHalf`, `litterPebbles`, and so on) are trace-only toggles in `main.js`; the helpers are `src/v2/render/ab-switch.js`.
