## 0. Priority task: the multi-draw spike

> **Covers:** the §0 multi-draw spike and its measured numbers -- `WEBGL_multi_draw`, `BatchedMesh` batching, the triangle ceiling, and the frame budget everything else is spent against.
> **Read this when:** you need a hard performance number, or are about to assume one. Contains the only measurements taken on real hardware.

**Do this before writing any other code. Everything in §5 depends on the answer.**

The entire rendering architecture rests on `THREE.BatchedMesh`, which needs the `WEBGL_multi_draw` WebGL2 extension to collapse many different geometries into a single draw call. Quest Browser is Chromium 146 on Adreno hardware, so it is very likely present, but this has not been verified on-device and no documentation confirms it.

Build a throwaway page, serve it to the headset, enter immersive VR, and report:

| Check | How | Why it matters |
| --- | --- | --- |
| `WEBGL_multi_draw` present | `gl.getExtension('WEBGL_multi_draw')` -- print to an in-world HUD, not the console | If absent, `BatchedMesh` degrades to per-geometry draws and §5 needs rethinking |
| `BatchedMesh` actually batches | Render ~2,000 instances across ~10 distinct geometries, read `renderer.info.render.calls` | Should be a small constant, not ~2,000. This is the whole thesis |
| Draw call ceiling | Scale instance count and distinct-geometry count until frametime degrades | Establishes the real budget, replacing the estimates in §5 |
| Triangle ceiling | Same, but scale geometry density | Ditto |
| `setFoveation(1.0)` works and helps | Toggle it, watch frametime | Free perf, confirm it is not a no-op |
| Frame rate control | Request 72Hz and 90Hz via the WebXR frame rate API | Determines the target |
| Sustained thermals | Leave it running 20+ minutes at load, watch for frametime cliff | Sets the length of the experience |

Deliverable: an in-world debug HUD showing `renderer.info.render.calls`, `.triangles`, `memory.geometries`, `memory.textures`, and frametime. **This HUD stays in the project permanently**, toggled by a controller button.

Note the HUD-not-console requirement: you cannot see a JS console while wearing the headset, and remote debugging over `chrome://inspect` is slow enough that you will avoid doing it. Print to a world-space panel.

### RESULTS -- 2026-08-04, on a Quest 3 (NOT quest 2)

`WEBGL_multi_draw` **is present.** `BatchedMesh` **batches. The core thesis holds.**

⚠️ **The framerate column below was not read off a Quest 2 and does not apply to one.** The draw-call finding is device-independent and stands; the triangle ceiling is not, and the whole point of the table now is the shape of the curve rather than the numbers on it. **Re-run this spike on the Quest 2** -- it is the single highest-value half hour available, and it retires every derived figure in this document.

| Instances (BATCHED) | Draw calls | Triangles (`renderer.info`) | Framerate |
| --- | --- | --- | --- |
| ≤ 2,000 | 6 | ~800k | 72-80, buttery |
| 4,000 | 6 | ~1.5M | ~30-35 |
| 8,000 | 6 | ~3M | ~15, nauseating |

**Draw calls stayed flat at 6 from 250 instances to 8,000.** That is the whole thesis, confirmed: object count is now decoupled from draw calls, and the §5 architecture is sound.

**The bottleneck moved to geometry throughput, which is the good failure mode** -- it is exactly what LOD and billboarding attack. The placeholder props run ~200 tris/instance at *full detail regardless of distance*, because the spike deliberately has no LOD.

### Working ceiling: ~350k triangles

**Budget against the** `renderer.info` **number directly.** Do not divide it by two for "per eye" -- whether that counter double-counts stereo passes was never established on-device, and the whole quantity is only useful as a number the HUD can be compared against.

Quest 2 is Snapdragon XR2 Gen 1 / Adreno 650. The ceiling is scaled down from the spike above by the ratio of the two GPUs (~2.6x), which is roughly how both geometry throughput and fill rate move; CPU is about half.

| Quest 2 |  |
| --- | --- |
| Triangles/frame at 72 Hz (`renderer.info`) | **~350k** (derived) |
| Eye buffer, WebXR default | ~1440 x 1584 |
| Total overdraw sustainable | ~2x |
| JS main-thread budget per frame | ~13.9 ms, of which spend **< 3 ms** |
| Draw calls | 40-50 |

⚠️ **350k is an estimate from a hardware ratio, not a reading off a headset.** It is the number `src/budget.js` gates against. Replace it with a measured figure at the first opportunity -- the §0 procedure is a half-hour job and it retires this whole paragraph.

Consequence for LOD, and it is the decision this ceiling forced: terrain used to draw **237k worst case** at a 1.2° triangle cap -- 68% of the frame for a world containing nothing but ground. `LOD.triDeg` **now ships at 5.72°, which draws 45k (13%)**, chosen by eye with the `[` `]` keys and then measured. That leaves about **250k triangles for everything else**. Ground is the backdrop, not the subject; see "Terrain LOD" in §5 for the ladder and for why 10% is not reachable with this knob alone.

| Tier mix | Avg tris/prop | Props affordable in a 250k prop budget |
| --- | --- | --- |
| 15% LOD0 (300) / 35% LOD1 (100) / 50% billboard (4) | ~82 | ~3,000 |
| 10% LOD0 (300) / 25% LOD1 (100) / 65% billboard (4) | ~58 | ~4,300 |

The lush-world target is still reachable, but **only with billboards as the majority tier, not the fallback tier**, and only because cards are cheap enough that the count above is not the interesting limit. LOD is not an optimization here, it is load-bearing.

**And triangles are not the wall the foliage carpet hits.** See "What actually binds, per resource" in §5: for anything below ~10 triangles the cost moved to per-instance CPU, and the fix is a different mesh class, not a lower triangle count.

Caveats on what this run did *not* establish:

- **The BATCHED-vs-INDIVIDUAL comparison was inconclusive, and that is expected.** INDIVIDUAL was not much slower at 4,000 because at ~190 tris/instance the scene is geometry-bound long before draw-call submission matters. Batching's win shows up in the opposite regime -- thousands of *cheap* objects (4-tri billboards, grass tufts), which is precisely the regime the real world lives in. The 4,000 cap in INDIVIDUAL mode is a hardcoded guard in `main.js`, not a device limit.
- Not yet read off the HUD: `MAX_ARRAY_TEXTURE_LAYERS`, foveation delta, 90 Hz behavior, 20-minute thermal soak.

### Fallback if `WEBGL_multi_draw` is absent

Moot -- it is present. Retained for the record: fall back to one `InstancedMesh` per (asset type × LOD tier × chunk), which costs more draw calls and shrinks the §5 asset variety budget substantially.

---
