# Perf trace findings, 2026-10-05

Source: three production batteries from the Quest 2 at 90 Hz (11.1 ms budget), commit b5037d8 plus dirty files. T1 inside a Leafkin house (13:45), T2 Leafkin village by the campfire (15:46), T3 rainy night woods (18:48, 98% weather, overworld forest). Read them with `node scripts/trace-report.mjs <id>`. Numbers below are "saved ms" from turning a group off, mean of both rounds, p50 unless stated.

## What changed in code this session

- Indoors now deloads the outer world: `stepOverworld`, both reflection probes and every scene child except the house view, residents, rig, hands, held things, peers, effects and lights are skipped or hidden (`stepIndoors`, `keepUnderRoof`, `hideOutside`, `houseKeep`, `houseHidden` in `src/v2/main.js`; restored in `closeHouse`). Layers stay in memory, so leaving the house rebuilds nothing.
- Outdoor sound through a house wall is quieter and duller: `INDOORS` in `sound-engine.js` went from `{ lp: 2500, gain: 0.5 }` to `{ lp: 1100, gain: 0.25 }`.
- Boulder ladder `ROCK_LOD_AT` went from `[4, 7.5, 25]` to `[3, 5.5, 18]` m per metre of rock (a 2 m rock now steps at 6/11/36 m, was 8/15/50). Fern `DRAW_RADIUS` went from 90 to 65 m. Gates updated to match (`check-rocks` step pin and shore-ratio tolerance 6% to 10%, `check-ferns` thinning probe now at 74 m).
- The battery now records per-stage laps, `waitMs` (frame minus js minus render) and GPU ms per sample, the record trace records GPU ms per window, and the report prints them. GPU ms comes from `src/v2/gpu-timer.js` and is `null` where the headset browser does not expose `EXT_disjoint_timer_query_webgl2`.
- The battery lost its separate `sky` and `fire` groups (merged into `sky+fire`, drills kept) and gained a `floor+terrain` state (everything off except terrain).
- Not changed, needs a decision: glade fish, creature cadence, litter draw calls, build budgets, reflection cadence (sections below).

## Cost model

- Render CPU ("rend") per draw call: 0.12 ms (T1), 0.09 (T2), 0.07 (T3). Treat 0.07 to 0.1 ms per call as the rule. Draw calls beat triangles as the cost driver, matching `_notes/questv3-performance.md`.
- `calls` undercounts the load: three skips the GL draw for a zero-instance InstancedMesh (`WebGLBufferRenderer.renderInstances` returns on `primcount === 0`) but only after it has selected the program, uploaded uniforms and bound attributes. Empty tiers are not free.
- Frame time exceeds js + rend by 7 to 10 ms in every state. That residue (`waitMs` in new traces) is GPU, compositor and vsync wait; it is why removing 5 ms of CPU saves less than 5 ms of frame at times. Until the GPU column is populated from a headset run, do not assume the residue is CPU.

## Per-trace results

| group off | T1 house | T2 village | T3 woods |
|---|---|---|---|
| scatter | 2.8 | 4.9 | 5.2 |
| animals | 5.5 | 5.5 | 4.9 |
| sky | 0.2 | -1.0 | 0.7 |
| water | 1.8 | 1.9 | 2.3 |
| fire | 0.5 | 0.1 | 0.3 |
| everything | 10.8 | 10.5 | 13.0 |

- T1 was the scandal: 5.5 ms of animals and 2.8 of scatter while standing in a house. Cause: `stepOverworld` ran whenever `cave === null`; a house is only a room in the same scene, 40 m past the village disc (or 250 m over a town), so the whole overworld sim and draw ran behind the walls. Fixed by the indoor deload.
- Wildlife was the largest animal cost in T1 (1.8 ms, 2.3 ms of CPU js). In T2 water critters (2.2), insects (1.9) and snowmen+leafkin (1.2) led. T3 animals were never drilled (MAX_DRILL ran out on scatter).
- T3 scatter drill: litter 3.0 (26 calls), boulders 1.7 (12 calls), ferns 1.6 (12), grass 1.1 (2), trees only 0.3 (8 calls, 60k tris). Trees at 0.3 ms confirms trees are cheap in the overworld forest; the glade is no comparison because T2's trees cost 0.9 with different species mix. The scatter parts overlap by 1.5 ms (they share a cost), so do not sum the drill rows.
- Water 1.8 to 2.5 ms. `water/reflections` was skipped by MAX_DRILL in all three, so reflections have never been isolated.

## The floor: why it misses 90 Hz

- By day the floor is fine: `everything` off is 10.5 ms p50 in T2 and 10.8 in T1, inside 11.1. At night in rain (T3) it is 13.0 ms. So the "baseline crept" is real only at night or in weather, and the toggles do not remove it.
- Not toggled by `everything`, therefore baseline: the sky dome, stars and moon, the aurora skymap pass at night (renderer.info comment in main.js notes the skymap and both probes each render before the main pass), lamps and windows, rig, hands, peers, HUD textures, and A-Frame's own ticks. T3 floor is 24 calls and 78k tris, js 1.2, rend 4.2, so about 6.9 ms of the 12.3 ms frame is `waitMs` (GPU or compositor), not CPU.
- Hypothesis, unconfirmed: a night-only GPU cost (sky, stars, fog/rain fragment work) or the XR compositor at fb scale 1.0. The new traces record `stages`, `waitMs` and `gpuMs` for `everything`, `floor+terrain` and every baseline; run one at night and one by day. If `gpuMs` is null, fall back to the `floor+terrain` delta and a separate sky-only toggle.
- Detection architecture now in place: any stage that costs at least 0.3 ms shows by name in every sample, `other` is the lap-uncovered remainder, and `waitMs` flags non-CPU time. New baseline work shows up as a named stage in the `everything` row first. A per-commit floor number in `trace-report` output (`everything` p50 and its stage list) is the thing to compare release to release.

## Recommendations, by subject

### Litter (3.0 ms, 26 calls)
- Your guess is right in structure. One draw per tier per variant: pebbles 1, sticks 1, deadwood 2 variants x (3 mesh LODs + card) = 8, bones 8, and the mushroom bank (I did not count its variants) covers the rest. CPU is about 1.8 ms render (26 x 0.07) plus 0.7 ms js for ring maintenance.
- Fix 1: set `visible = false` on any tier mesh whose count is zero, so three skips its program setup entirely. Most tiers are empty at any spot (no bones, no skull). Biggest low-risk saving, probably half the calls.
- Fix 2: merge the far tiers. The cards of all prop types can share one atlas and one InstancedMesh; stumps/logs/skeletons/skulls in cards are the same quad.
- Fix 3: drop bones and sticks entirely beyond about 25 m (they are decoration) and shorten litter `DRAW_RADIUS` for mushrooms from 55.
- Acceptance: T3 `scatter/litter` calls 26 to under 12 with the same visuals.

### Boulders (1.7) and ferns (1.6)
- Done: shortened ladders as above. Expect roughly 0.5 ms from boulders (fewer high rungs drawn) and 0.3 to 0.5 ms from ferns (about 40% fewer far billboards; the far ring is 95% of instances). Watch for pop-in on big rocks near 36 m.
- If more is needed: ferns `LOD_BANDS [5, 10]` to `[4, 8]`, and grass `DRAW_RADIUS` 70 to 55.

### Creatures and update frequency
- What an "update" is. Crabs and grasshoppers are pure functions of room time: each frame `update` re-evaluates every resident creature's pose (`_play`), recomposes its matrix and rewrites it into an instance buffer. There is no integration and no decision tick. Butterflies integrate on absolute ticks at `TICK_HZ` with catch-up. Leg and wing motion is shader-side and free. So the cost is per-frame JS pose evaluation plus buffer upload, linear in resident creatures, not shader work.
- Rough size: animals are 1.2 to 3.1 ms of CPU js and 1.6 to 2.8 ms render in the three traces. Wildlife alone was 2.3 ms js in T1.
- Recommendation: distance-tiered cadence on the pose evaluation only. Within 12 m every frame; 12 to 25 m every 2nd frame; beyond 25 m every 4th, reusing the cached matrix (grasshoppers already skip `_play` for homes beyond `SHOW_M + TETHER`; the same reuse path covers this). Stagger by id so work spreads across frames. At 90 Hz a 22 Hz pose is invisible past 25 m. Butterflies: step fewer ticks per frame for far ones and rely on `CATCH_UP_TICKS`. Leafkin and hobs (sims with real decisions): decision ticks at 10 Hz beyond 30 m, 2 Hz beyond 60 m; walk translation stays per-frame for near ones only. Indoors all of this is gone because the layers do not run.
- Not done: needs the wildlife, leafkin and hob code read for their per-creature state, and the nearest-frame gates (`check-crabs`, `check-grasshoppers`, `check-butterflies`) pass fixed times that a stride would perturb.

### Fish
- Fish are drawn only when submerged or `currentRoom.village` (`main.js` fishShown). The Leafkin glade pools show fish from above because the village pond is deliberately clear (VILLAGE_POND comment). That is why you saw them. If you want them gone until the player dives, drop `|| currentRoom.village`, at the cost of the visible-fish pond. Decision for you; I left it.

### Outdoor sound while inside
- Done: halved gain and darker filter. A true background-sounds engine (occasional muffled realistic sounds in proportion to real frequency, aware of the surroundings, no sim) is a design item, not built. Sketch: sample the surroundings once at door entry (biome, water within 60 m, night/day, weather), then Poisson-schedule from a per-biome table of one-shot clips through the existing `INDOORS` bus, with rate = real-world frequency x a constant. No creature state.

### Water (1.8 to 2.5 ms) and reflections
- `WorldProbe` is a 5-face 128 px cube of the full scene, a burst every 150 frames or 12 m of movement. Each face is a whole extra scene render (draw calls and triangles included), so it is the likeliest big part of water cost and was never drilled. It now stays off indoors.
- Recommend: skip the burst unless a water surface is within view and within about 150 m; stretch `refreshFrames` when the nearest visible water area is small; per-face frustum cadence: the faces facing within 60 degrees of the view direction refresh at the base rate, faces behind the player at a quarter of it (they only matter after a turn, and the 1 s cross-fade hides the lag). Add `water/reflections` to a guaranteed drill slot (it is the only group member that always drills) before changing anything, and confirm the cost first.

### Build budgets and the strider lag
- Every scatter layer has its own per-frame placement budget: trees 2.0 + 1.0, grass 2.0, ferns 2.0, rocks 1.5 + 1.0, mushrooms 1.5, litter 0.6, deadwood 1.0, about 12.6 ms if all drain at once. There is no shared cap, and each layer's thin pass runs unbudgeted. While flying or striding fast every layer's queue refills each frame, so the sum can exceed the frame. That is the likeliest cause of lag at speed.
- Recommend: one shared per-frame build allowance (about 3 ms) drawn down in priority order (terrain-adjacent first: trees, rocks, grass, ferns, litter), a fall to 0.5 ms when the previous frame ran long, and speed-aware radii (shrink grass and fern `DRAW_RADIUS` while moving faster than a run, restore on slowing). Placement algorithm itself is already tile-seeded and incremental; the sweep is where cost hides, not the per-tile roll. The record-trace row now shows `placement` stages per window, which will confirm.

### Trace length (about 2 minutes)
- Done: sky and fire merged into one group (they saved about 0 ms in all three). That removes four timed states.
- Further low-hanging fruit: skip round 2 for any group whose round 1 saved under 0.3 ms; settle 1000 ms to 700 ms. Together about 25 s. I left them, since the second round is what gave the spread error bar. The 70 s countdown mentioned before is the queue length times 4 s plus baselines; every baseline costs 4 s, so `BASELINE_EVERY` 3 to 4 saves about 10 s at the price of more drift.

## Open items and verification gaps

- Nothing here was run in a headset. The indoor deload, the ranges and the new trace fields are verified by build and by the node gates only (grass-variance and snow-tile failures in `check-rocks` are pre-existing and unrelated).
- Not verified: that residents' puppets and potted mushrooms stay visible indoors on a real device (their groups are in the keep set; the mushroom pots draw from the island's bank, which I did not trace). Villagers no longer step while you are indoors, so those marked `inside` stay inside until you leave.
- Run one battery in a house, one by day, one at night after redeploying, and send them.
