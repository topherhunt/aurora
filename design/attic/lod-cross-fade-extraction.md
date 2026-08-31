# Extracting LodCrossFade (not built, 2026-08-30)

A refactor, parked before it was started. Four scatters now hand-roll the same cross-dissolve -- `_crossFade` / `_endFade` / `_sweepFades` in `src/v2/render/trees.js`, `rocks.js`, `grass.js` and `ferns.js` -- and two more (`mushrooms.js`, `deadwood.js`) swap tiers with nothing to dissolve them and are the next callers. This note is the case for lifting the shared half into a class beside `RimFade`, the boundary it should be cut on, and the reasons the *bigger* abstraction people reach for first is the wrong one.

## What is actually the same in all four

Every copy is the same object and the same five operations, differing only in field names:

- `fades`, an array of `{ start, tris, ... }` in flight, and `fadeTris`, their triangles, added to the bed's own `tris` after the update loop so this frame's swaps are in this frame's number.
- `fadeAt`, an `Int32Array` index back from an instance id, so a second band crossing or a rim retire can end a running fade in O(1) instead of scanning.
- A swap-remove in `_endFade` that keeps `fades` dense and rewrites `fadeAt[last]`.
- A sweep that retires on `age >= PROP_FADE_SECONDS || age < 0`, where the second half is the prop clock having wrapped underneath the fade -- which cannot be resumed and must not restart from zero.
- The stamp pair: `setPropFadeTimerAt(batch, ghost, now, false)` and `(batch, arrival, now, true)`, one clock reading, complementary thresholds, so coverage is conserved exactly.
- Ceilings that all degrade to the pop the swap used to be: `FADE_MAX_INFLIGHT`, and a pool reserve so a dissolve can never starve growth.
- End the running fade FIRST in `_thin`, `_release` and any retier, while the instance's tier and slot still describe it.

That is about sixty lines a bed, and it holds the only invariant here that is expensive to get wrong. A ghost that outlives its window is a leaked slot; leaks compound; a pool that runs dry **throws** inside `_growTile`, several seconds and several hundred metres after the mistake. `scripts/check-trees.mjs`'s *the LOD swap dissolves* section exists because that failure is invisible until it is fatal, and every bed needs the same gate.

## What is genuinely different, and is the whole difficulty

**What a ghost IS.** Trees, rocks and grass take a **second pool instance**, copy the original's matrix and colour into it, and give it the departing geometry; the ghost is returned to the free list when the window closes. Ferns need no duplicate: its two representations live in two different arenas, so the departing one is already drawn somewhere the arrival does not touch, and the ghost is simply **the ring slot it just left**, held rather than returned. So the entry is `{ orig, dup, start, tris }` in three beds and `{ id, tier, slot, start, tris }` in the fourth.

**Which ceilings apply.** Rocks 1024 in flight, grass 2048, trees and ferns 256. Trees carries a third that nobody else needs -- `PropArena.roomAt` against `FADE_MESH_RESERVE`, because its tiers are separate `InstancedMesh`es and a mesh that fills throws in `_alloc`, where the other beds only have a pool to run short of. Ferns carries a per-ring reserve for the same reason one ring down.

**Whether the rim can collide with it at all.** The rim dissolve and the cross-dissolve share one fade slot per instance, so a bed whose two dissolves can reach the same instance has to arbitrate -- trees, rocks and grass all pass `onPreempt` to `RimFade` and all check `rim.isBusy` before starting. Ferns proves by a constructor assertion that its bands cannot overlap (the rim fires past 32.4 m, a tier changes inside 11.2 m) and therefore wires no callback. An extraction must not force ferns to pretend it has the problem.

## The shape it should take

`LodCrossFade`, beside `RimFade`, owning the clock, the index and the accounting, and knowing nothing about what a ghost is:

```
new LodCrossFade(maxInstances, { maxInflight, take(id, from) -> handle | null, drop(handle) })
  start(id, from, tris, now)   // asks take(); false if it refused or a ceiling bound
  endFor(id)                   // the preempt and retier path
  sweep(now)                   // once per frame, before the update loop
  tris                         // what to add to the bed's own count
```

`take` is where every difference above goes: a bed returns a duplicate instance id, or a retained slot, or **null** to refuse -- and null is a first-class answer, not an error, because refusing a dissolve costs a pop and popping is what the swap did before any of this existed. `RimFade` is the precedent that this cut works: the rim dissolve was the same situation, came out as a class with a small interface, and every bed now shares it.

The two-line win at each call site is that `this.tris = tris + this.fadeTris` and the three `endFor` calls in `_thin` / `_release` / `_demote` stop being things a new bed has to remember.

## Why NOT `InstancedMeshDitherableLodPool`

The obvious bigger abstraction -- one base class for "many objects, same mesh, different LODs, billboards, density falloff, dithered transitions" -- would have to absorb the four things that are least alike between beds:

- **Placement.** A jittered grid for trees, clumps for grass, strips for the old card bed, ring loans for ferns, anchored sites for mushrooms and deadwood.
- **The ladder's UNIT.** Trees band in **metres** (`LOD_BANDS = [8, 22.5, 100]`); rocks band in **multiples of the rock's own size** (`ROCK_LOD_AT`), which is what lets one ladder serve a 60x size range; mushrooms band in units of the prop's own span. These are not the same rule with different constants.
- **The arena.** `PropArena` (tiered meshes) for trees and mushrooms, `InstancedArena` for grass, ferns and litter, still a `BatchedMesh` for rocks.
- **The ceilings**, which follow from the arena, as above.

A base class spanning those is a config object with a hook per difference, and every bed overrides most of it -- which reads worse than the duplication it replaced and makes the next bed's *real* question ("what is my ghost?") harder to see rather than easier. The shared parts have already been extracted one at a time and that is the pattern that has worked: `rim.js` for the rim dissolve, `tile-pool.js` for the thinning law, `prop-arena.js` and `instanced-arena.js` for the two arena shapes. The cross-dissolve is the last piece in that set, not the first piece of a new one.

## Do it when the beds are quiet, and take the dedup with it

Two things make this a bad refactor to start on a whim. It touches four files that are each under active work by a different session, and it is exactly the kind of change that reads as clean and green while having quietly moved a leak. So: land it when `rocks.js` and `ferns.js` are not mid-change, and port the beds **one at a time**, each with its gate section already written and passing against the hand-rolled version first -- `check-trees` has one, and it should be copied to the other three before any of them moves.

Two smaller pieces of the same tidy-up, worth doing at the same time or before:

1. **`grass.js` holds a private copy of `InstancedArena`** (its own class at the top of the file) alongside the shared `instanced-arena.js` that ferns and litter import. One of the two should go.
2. **`prop-arena.js`'s header names the pattern** -- this class, `rim.js`, `tile-pool.js` and four `_crossFade`s together add up to a hand-rolled `BatchedMesh`, built because three's own does not run acceptably on the target headset (see §5). That paragraph is where a reader currently finds out the duplication is deliberate, and it should point here once this note exists.
