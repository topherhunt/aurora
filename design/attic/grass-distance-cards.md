# A distance ring of cards under the blade bed (not built, 2026-08-29)

An optimisation idea, parked before it was written. The grass bed is moving from alpha-tested billboard cards to opaque blade geometry (`src/props/grass-blades.js`, previewed at `/gen-grass`); this note is the case for putting cards *back* in the far field only, and the reasons that case is weaker than it looks.

**The shape it would take.** Keep blade clumps inside some radius -- 15 or 20 m, wherever the eye stops resolving an individual blade -- and past it draw one card per clump, cylindrically spun toward the eye, baked from a photograph of the blade clump itself so the swap is a dissolve between two pictures of the same object. A ring rather than a ladder: one crossover, one geometry each side, both `InstancedMesh`.

## Fill is not the argument, and that is the surprise

The instinct is that cards get cheaper as things get smaller, because ten triangles collapse into two. On this bed the arithmetic runs the other way, because the card's fragments are mostly thrown away and the blades' are not.

- The shipped tuft texture is **18.9% opaque**. A card at 30 m shades ~360 fragments to keep ~68, and on a tiled Adreno the `discard` that does the throwing away also disables low-resolution-Z for the whole draw, so the layers behind it are not rejected before shading either.
- Ten blades at 30 m are each thinner than a pixel. Quad granularity floors each one at ~4 fragments, so the clump costs **~40 fragments, all kept**, and nothing discards, so LRZ stays on.

So the far field is roughly **9x cheaper in fill as blades than as cards**, and a distance ring would be paying fill to save triangles. Whether that trade is ever worth making depends on a triangle ceiling this bed is nowhere near: at the defaults (6 clumps/m², full to 8 m, cull at 70 m) the whole disc is 19,906 clumps and **199k triangles**, against a 350k frame ceiling that the arena has already been pushed past to ~1M.

## Aliasing is the argument

A sub-pixel opaque triangle has **no mip chain**. There is nothing for the hardware to prefilter, so a blade smaller than a pixel either lands on a sample or does not, and the answer changes every frame as the head moves -- which in a headset is every frame, because the head never actually holds still. The far field will crawl and sparkle. A card mips cleanly and does not.

This is the only real case for the ring, and it is a case about **image stability**, not about frame time. It should be judged in the headset, on the far field, with the near field switched off -- not on a desktop monitor, where the pixel is bigger and the head does not move.

Three cheaper things to try before building it, in order:

1. **MSAA.** The blade is a geometric edge, which is exactly what multisampling is for, and the XR path may already have samples available for free.
2. **Fade blade width up with distance** so a blade never goes below ~1.5 px, trading a slightly too-fat far blade for a stable one. This is `GROW_SCALE`'s trick applied to width alone, costs no instances and no triangles, and is the one to try first if MSAA is unavailable or insufficient.
3. **Thin harder past 25 m** and accept a sparser far field. Fewer sub-pixel triangles is fewer things to crawl, and the density law already halves per doubling -- steepening it out there costs almost nothing that reads.

## The objection that stands regardless

A card ring reads worse **from above**. The player flies in this world, and a cylindrically-spun card is a vertical plane: looked down on, the entire ring collapses toward edge-on and the ground goes bald exactly when the most grass is in frame. Scattered triangles have no such angle. So even if the ring wins on the aliasing question, its crossover has to be far enough out that the bald ring is below the fog, or it has to be suppressed by pitch -- and a crossover that moves with where the player is looking is a swap the player can cause, which is the worst class of LOD artefact (see the dead-wood card in §5 for the same failure with a different cause).

## If it is built anyway

The pieces already exist and none of them is the hard part. `buildImpostorCard` and `bakeImpostor` in `src/props/impostor.js` bake and build the quad; `billboardVertex` in `src/material.js` spins it; the density law and the tile scatter are shared with whatever the blade bed ends up using. What has to be decided is the crossover radius and the dissolve, and both are look calls to be made in the headset with a slider, which is what `/gen-grass` exists for.

The measurement that would settle it: draw the far field as blades and as cards in alternating frames, stand still, and look at which one is stable. If neither is, the answer is fewer far blades, not different far blades.
