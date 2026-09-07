# A distance ring of cards under the blade bed (built 2026-09-03, rejected on look)

**It was built, looked at in the headset, and taken out again.** The far field of the blade bed (`src/props/grass-blades.js`) is now plain triangles all the way to the cull radius, thinned by `BLADE_FALLOFF = 3`. This note keeps the case for the ring, which is still the best statement of what the far field costs, and adds what the built version actually looked like -- so the next person to have the idea gets the measurements *and* the verdict.

The case below was written before it was built. The grass bed had just moved from alpha-tested billboard cards to opaque blade geometry (previewed at `/gen-grass`); this is the case for putting cards *back* in the far field only, and the reasons that case is weaker than it looks.

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

## What was built, and what it looked like

The whole ring, and it worked as designed. The crossover sat at 8 m; both rungs rode in ONE geometry with the unwanted one collapsed to the instance origin in the vertex stage, which is the only LOD ladder an `InstancedMesh` can have; the card was cylindrically spun, cut out against its baked alpha, and cross-dissolved against the blades over ±0.75 m with complementary dither thresholds, keyed to distance rather than to a clock so there was no state to keep and no hysteresis to get wrong. It took **37% of the bed's drawn triangles off the screen**, exactly as predicted.

Three things were tried against the flatness before it was abandoned:

- **A photograph of four clumps, not one**, at their own seeds, yaws and scales -- because `(F/d)³` has already emptied that ground and a picture of a single ten-blade spray out there is a few grey hairs. Half the ring mirrored its UV, which is the one free bit of variety a single baked layer allows.
- **The per-clump tip ramp carried onto the card**, over its own height, so a distant clump got the same two-tone brightness variation `aTipMul` gives a near one instead of reading as one flat stamp repeated.
- **The clump's disc narrowed from 0.40 m to 0.16 m** (and `lean` from 0.45 to 0.28), because the impostor frame is measured off the subject and a clump three times wider than it is tall photographs as a strip. That took the card from 2.9:1 to 1.3:1.

**None of it was enough.** In the headset the ring read as ugly and flat at every setting tried -- a band of billboards, legible as billboards, with the near field's shading variation obviously missing across the crossover. The verdict was on look, not on frame time: the triangles it saved were real and were not worth what it did to the picture.

So the far field's answer is **fewer far blades, not different far blades** -- which is what the last line of the aliasing section above already said, and what `BLADE_FALLOFF` now does. Options 1 and 2 in that list were never tried and are still the cheap things to reach for. If the ring is ever revisited, the thing to fix first is the one that was never addressed: a card is a photograph taken under one light and the near field is shaded live, so the two cannot agree across a crossover the eye is looking straight at.
