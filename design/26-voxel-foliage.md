## 26. Voxel foliage: leaf orientation and load cost

> **Covers:** how `src/props/tree-voxel.js` decides which way each leaf plate faces, the measurements that settled it, and what building one of these crowns costs at load time on a Quest 2.
> **Read this when:** you are changing `leafOpen`, adding a species, or deciding whether the shipped forest bakes these meshes or generates them.

### Turning leaves toward open space is worth 3-6%, in a narrow crown

Grow the crown one leaf at a time; for each leaf pick the roll around its twig and the spin about its own stem that face the most of whatever is *not* already a leaf. `leafOpen` turns it on, `leafOpenJitter` slops the answer, and `leafOpenUp` aims it: 0 is openness in any direction at all, 1 is the cosine-weighted sky.

**The solve is closed form and 2x2.** A plate's normal is already confined to the circle perpendicular to its own stem, so write the objective in that stem's `(s0, u0)` basis and it becomes a quadratic form. The objective is `sum(w * T * (n . d)^2)` -- squared, because a plate and its flip are the same plate, so the sign of `n . d` must not matter over a whole sphere. The largest eigenvalue of `[[a, b], [b, c]]` is the best openness a roll can reach and its eigenvector is the spin that reaches it, so one march per candidate answers both with no search. When the two eigenvalues are equal the spot is equally open every way round; that is not an answer and the leaf keeps the random roll it was dealt.

Unioned silhouette, rasterised orthographically from eight horizontal directions, **averaged over five seeds**, at 9 m. Identical triangle counts and identical leaf area in every row -- only the facing differs:

| species | crown R | random | outward (`up 0`) | sky (`up 1`) |
|---|---|---|---|---|
| aspen | 1.6 m | 11.68 | **12.40 (+6.2%)** | 8.98 (-23%) |
| birch | 2.4 m | 16.97 | **17.72 (+4.4%)** | 12.48 (-25%) |
| pine | 3.0 m | 21.47 | **22.13 (+3.1%)** | 16.20 (-25%) |
| oak | 3.9 m | **26.29** | 25.60 (-2.6%) | 14.27 (-45%) |

**The gain tracks crown narrowness, and the sign flips.** Openness-seeking needs neighbours worth turning away from. An oak's 3.9 m crown has open space in nearly every direction, so every leaf finds the same answer -- point outward -- and coherent alignment costs more than the gap-filling buys. Aspen's 1.6 m crown is packed, every leaf faces a genuinely different local gap, and the placement decorrelates instead of aligning. So `leafOpen` is on by default and **oak turns it off**.

### Why aiming at the sky instead loses badly

Two terms, and the sweeps separate them.

**Zenith-facing plates are edge-on to a player.** Mean projected area of a plate over ALL directions is half its own area no matter which way it points -- orientation cannot change the total. But the views that matter are a horizontal ring at eye level, not the whole sphere, and a face-up plate contributes nearly nothing there. This term alone is most of the 23-45% loss, and it is why `leafOpenUp` defaults to 0: real phototropism is the wrong objective for something a player stands under.

**The rest is correlation.** Silhouette is a UNION, so what hurts is neighbours agreeing: leaves that share a target go broad together and vanish together. Sweeping `leafOpenJitter` up walks a sky-seeking crown monotonically back toward the random baseline and never past it. This is the term that makes oak lose even with the zenith bias removed.

The renders are not subtle: at `leafOpenUp 1` you can read the trunk straight through an oak crown that is a solid mass at `leafOpen 0`, on the same 2,179 triangles.

### Load cost, and whether to bake

Build time for one 9 m tree, median of 40, on an M-series desktop. The pass costs `sites x (OPEN_PHI + 1) x OPEN_DIRS x OPEN_STEPS` grid reads -- 2.1M for a 2,048-leaf pine -- because every candidate roll marches, and then the chosen one marches again for its spin. `OPEN_STEPS` and `OPEN_PHI` are the two knobs that price it; `OPEN_DIRS` is 19 because the objective needs a full sphere, not the hemisphere the sky version got away with.

| species | `leafOpen 0` | `leafOpen 1` |
|---|---|---|
| pine | 17.7 ms | 41.3 ms |
| oak | 11.8 ms | 29.4 ms |
| birch | 11.8 ms | 30.0 ms |
| aspen | 9.1 ms | 23.7 ms |

But the pass is not the problem, and neither is any single tree. A Quest 2's JS thread runs this work roughly 5-8x slower than the desktop it was measured on, so **one tree is ~90-140 ms even with the pass off**, and generating a dozen distinct trees at load is several seconds on the main thread with the compositor waiting.

**So: bake, for reasons that predate this experiment.** Ship geometry, not a generator; the generator is a bench tool and an offline step. That also makes the 3-6% free -- a prebaked crown pays the pass once, on a desktop, and never on the device. Nothing is urgent yet: `src/v2/render/trees.js` still draws `tree.js` cards and does not import `tree-voxel.js`, so today the shipped forest pays none of this. The bill arrives the day the voxel crowns go into the world, and the answer that day is a prebake.
