# The skyline profile target (removed 2026-08-28)

A third LOD target beside `quadtree-v2.js`'s `triDeg` and `periphDeg`, for ground that draws a **silhouette edge**. Built, shipped on the desktop route behind `K`, measured, and then removed wholesale: `src/v2/terrain/skyline.js` (565 lines) and `scripts/check-v2-skyline.mjs` (382 lines) are gone, along with the `skyline` parameter to `selectNodes`, the `profileDeg`/`horizonMs` stats, and the `K` binding. Recover them from git history before `git log -S skyline` stops finding them.

**Why it went:** it cost 15-25 ms of Quest 2 main-thread time per 4 m of player movement -- more than a whole 72 Hz frame -- and the symptom was a headset that blinked as the compositor reprojected stale frames. Sharper distant ridges are worth less than a headset that holds frame rate and shows the same fidelity as the desktop preview. That is a priority call, not a defect finding; the module worked.

## The argument, which is still good

The angular split rule is right for a *surface* and wrong for an *edge*. A 3-degree facet in the middle of a hillside is hidden by its own shading -- the eye has no reference against which to read the corner. The same facet on a ridge crest is a 3-degree corner cut out of the sky, with nothing behind it to hide against. The eye reads corners on a boundary far more readily than corners on a shaded interior, so **silhouette error is worth more per metre than interior error**. That is a claim about perception rather than about geometry, which is why it cannot be derived from the error term the rule already caps.

**The rule.** A node is on a *relative* skyline if the top of it stands above the ground **behind** it along that azimuth, out to `backdropX` (3) times its own range -- so a near ridge crossing a far mountain counts, not just ground against open sky. The alternative formulation, "stands above everything nearer", was tried and was useless: it privileged 51% of the far leaves, which is a blanket, not a detector.

**Graded, not switched.** Nodes were interpolated toward `profileDeg` 1.2 over a `marginDeg` 1.0 ramp. A binary classifier puts its discontinuity exactly *on* the silhouette, the one place in the frame guaranteed to be looked at, and the symptom is a ridge that pops as you walk.

**A refinement only, never a veto.** Interpolation clamped to `Math.min(profileDeg, triDeg)`, so the term could only ever make ground finer. This is the invariant v1's elevation bias broke by gating *descent*, and it is what made the whole thing safe to switch off at runtime.

## What it cost and what it bought

Measured on `public/world/height.png`, worst case over the gate's camera sweep:

| configuration | selected leaves | drawn triangles |
|---|---|---|
| `triDeg` 3.0, no profile | 361 | 95k |
| `triDeg` 3.0 + profile 1.2 (shipped) | 379 | 109k |
| `triDeg` 1.2 everywhere | 871 | 301k |

So the silhouette cost 14k triangles where buying it by refining everything cost 206k -- about 15:1. It reached roughly 6% of leaves past `minRange` 600 m, which is what made it a detector rather than a blanket.

The corollary is the row worth reading twice: **`triDeg` 5.72 plus the profile drew 70k where a flat 3.0 drew 95k.** A coarser surface with a fine silhouette was both cheaper and better-looking than a uniformly finer one. If this idea comes back, that pairing is the operating point, not 3.0 + 1.2.

## What actually killed it

`HorizonTable.build` marched 256 azimuth bins x ~150 geometric steps (`stepM` from 6 m, x1.05 per step) against a `MaxPyramid` over the imported field: about 38k pyramid queries, **3.7 ms on this Mac**, on the main thread, whenever the eye moved more than `moveEps` 4 m in any axis. Call it 15-25 ms on a Quest 2. The faster you walked, the more often it fired. `gain()` -- one extra `maxIn` per visited node during selection -- was negligible beside it; the table rebuild was the whole cost.

Its own header records tuning the step growth from 3.5% to 5% to take the rebuild from 4.6 ms to 3.3 ms, so the cheap wins in that direction were already taken.

## If you rebuild it

Four options, cheapest first. None was tried before removal.

1. **Amortize the build.** The 256 bins are independent and the table only nudges LOD targets, so a slightly stale one is harmless -- there is no correctness cliff. Sixteen bins per frame is ~0.25 ms/frame with the full table refreshed every 16 frames, instead of a 20 ms stall.
2. **Raise `moveEps` far above 4 m.** It is an *angular* table; 4 m of walking barely changes it. 64 m looks defensible and was never measured against. 4 m appears to have been a cautious default rather than a measured one.
3. **Move the build into a worker.** Most work: the pyramid has to be copied over, and the result has to land without tearing a selection.
4. **Desktop-only.** Keep it behind the same runtime flag but never enable it on the XR route. This is the smallest change and it is also the one that breaks the "consistent fidelity between desktop and VR preview" goal that motivated the removal, so it is listed last on purpose.

## Two things it was NOT

- **Not summit truncation.** A peak landing between coarse grid samples is simply absent, one-sided, 17 m at the median for a 64 m cell over the 150 highest summits. That is fixed at zero triangle cost by `chunk-mesh-v2.js`'s crest term (`RELIEF_KNOBS` `crest`), which is unaffected by this removal. The profile target was for the *residual* -- the polygonal edge left over once the peak height is right.
- **Not v1's horizon map.** `src/sim/horizon.js`'s `bakeHorizon` (Stewart 1998) is a different system entirely: an n^2 x 16-azimuth `Uint8Array` baked once in `src/sim/phase-a-worker.js`, handed to `lighting.setMaps()` for terrain shadows and sky-view AO and sampled by `src/water.js` for sky-reflection occlusion. It is baked once and read on the GPU, costs nothing per frame, and v2 does not use it at all. The shared word "horizon" is the only thing the two have in common.

## Open defects it had when it was removed

From `notes/distant-terrain-jaggedness.md`, unfixed:

- `backdropX` made the backdrop window **multiplicative in range**, so it shrank as you approached. A peak silhouetted against a far range could stop qualifying and **de-refine as you flew closer**. A principled fix would floor it in metres (`max(backdropX*R, R + FLOOR_M)`) or latch gain per node so refinement is monotonic.
- The same test missed peaks that dominate the frame while standing in front of other high ground, because they fail "stands above the ground behind it."

Anything rebuilt from this should start by fixing those, not by porting the detector as it stood.
