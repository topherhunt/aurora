# 22 -- Ground litter

Strewn small stones on the /v2 route, drawn as pictures of small stones instead of as small stones. Bake: `src/props/litter.js`. Scatter: `src/v2/render/litter.js`. Gate: `scripts/check-litter.mjs`.

## Why it is a texture and not props

The rock scatter's `underfoot` bed put a modelled pebble on the ground every 1.7 m across every wood and cliffside, at about 11 cm across -- forty-one specks for every rock big enough to read as a rock. A `BatchedMesh` instance costs the same whether it is a four-face pebble or a seven-metre lip, so nearly the whole prop budget went on things smaller than a boot. The look was right and the mechanism was wrong: ground scattered with small stones is a TEXTURE. `props/litter.js` bakes four photographs of exactly that and the scatter stamps them on the hill. **Two triangles buy what eighty instances used to.**

## The smallest cut of the standard scatter

Same machine as its four siblings, deliberately reduced: one `InstancedArena` over a single `InstancedMesh` -- all four baked pictures ride one quad, choosing between them with a per-instance `texLayer` attribute -- one material, a tiled camera-following scatter keyed on `tileSeed`, graded thinning by per-candidate rank, rank-based incremental regrow, and the rim dissolve -- all argued in `render/trees.js`'s header. What it does NOT have is the usual bulk: no variant bank, no tier ladder, no LOD bands, no promote/demote loop, because a quad is already the floor of every ladder. A patch is born at its only tier and stays there until evicted.

**Four geometries, one per baked layer.** The atlas layer a prop samples is a per-VERTEX attribute (`texLayer`, `material.js`), not per instance, so "which of the four pictures" has to be a choice of geometry: four copies of the same 2-triangle quad differing in one float, 16 vertices in the arena for the whole system.

**Four pictures is more than four patches.** Each stamp also rolls a continuous yaw, so the repeat the eye can catch is one picture at a random rotation beside the same picture at a different one. A litter patch has no orientation of its own -- no up, no grain, no silhouette against the sky -- which is exactly the condition under which rotation defeats recognition, and why four bakes is enough where four TREES would not be.

**The quad's normal is exactly (0, 1, 0)**, which is the marker `material.js` uses to decide a card wants spinning toward the camera (`CARD_UP_MARK`). Safe here because that test is ANDed with a per-material list of billboard layers and this material is built without one -- and a ground stamp is the one prop that must never turn. If litter is ever merged into a material that does billboard, this is the line that breaks.

## The riverbed costs a second pass

A riverbed and a lake floor are where loose stone collects and stays -- washed there, sorted there, nothing growing over it -- so the one ground this file used to refuse outright should have the most of it.

Making it the most is not turning a number up, which is why `_growTile` has two candidate loops. `ENV_DENSITY` is an accept RATE (`rocks.js`'s `BEDS` argues this at length): `river` is already saturated, so every candidate offered on shingle is already taken and no multiplier produces another. The only lever left is how many candidates are OFFERED, and candidates are per-pass -- `rocks.js`'s own conclusion when it wanted a scree PILE rather than a scree ratio and gave it a bed of its own. **The wet pass is that bed**: `WET_DENSITY` more candidates per square metre out of a SEPARATE random stream, everything not under water thrown away, survivors through the identical drift, slope and rate tests. The two passes differ in exactly two things -- how many candidates they offer, and whether they demand water.

**A separate stream is why this was affordable to add.** The dry pass's draw order is the most fragile line in the file: every candidate draws the same randoms whether or not it survives, so one extra draw reshuffles every patch in the world. The wet pass draws from `tileSeed` slot 1 where the dry pass draws from slot 0, so not one dry candidate moves. It costs a second loop over ground that is nearly all dry, bought back by testing water FIRST -- `WaterSurfaces.levelAt` is an AABB reject and a bucket scan, returning null on dry land long before anything pays the ~4.9 us terrain sample.

## The honest limit: a plane on a hill

The patch is a PLANE and the ground is not. It is laid on the field's normal at the patch centre and lifted `LITTER_LIFT` above the drawn surface, so on ground that curves inside 1.6 m one corner rides higher than the lift and another tries to sink through. Past that limit the answer is not a bigger lift -- a stamp that floats is worse than one that clips -- it is the slope test, which is why `MAX_SLOPE_DEG` here is 34 against the 42 of the underfoot rock bed whose pebbles it replaces.

`SCALE` runs to 1.4, so the largest stamp is 2.24 m across and reaches 1.58 m centre to corner: ground whose slope differs by only 5 degrees from the patch centre carries that corner 14 cm off the plane, three times the whole lift. No lift small enough to stay invisible covers that.

## Density is a spacing, never a ratio

The figure that matters is the one AFTER the rejections -- getting that wrong is the mistake this whole change was made to fix: the last attempt at "more stone" doubled a ratio inside one bed and moved the sight from a rock every 15 m to one every 10.6 m, arithmetically a doubling and visually nothing. So the number to check is METRES BETWEEN STAMPS on real ground. The drift floor throws away a measured 25.5% of candidates before anything else looks, and `ENV_DENSITY` throws away more than half again in a wood.

Measured on the gate's stubs inside the full-density radius:

| Ground | at `DENSITY` 0.14 | at 0.08 |
|---|---|---|
| Wood | 3.7 m | 6.1 m |
| Peak | 3.4 m | 4.6 m |
| Shore | 3.3 m | 3.3 m |
| Sine ridge | 6.7 m | -- |

The sine ridge is half past the slope limit, and 6.7 m is the answer wanted there: a face is not strewn ground. At 1.6 m a side, a stamp every 3.7 m puts litter on about a fifth of the ground, and rather less carrying stone since the picture is mostly transparent. That reads as "there are stones about" rather than "the ground is paved": much denser and the square stamps meet edge to edge, which is where the trick stops working, because two overlapping rectangles of gravel show their corners in a way one never does.

`WET_DENSITY` 0.18 is deliberately through its own margin. A stamp is `LITTER_PATCH_M * SCALE` across, 1.8 m a side mid-range; 0.18 sits near 1.82 m mean spacing, so squares meet edge to edge and in places overlap (0.09 sat at 2.57 m, comfortably clear). Riverbed coverage was wanted more than the margin was, and it is least bad here: this is the WET pass only, ground seen through moving water and refraction, never the walked forest floor that `check-litter.mjs`'s 2.5 m paved-floor limit was measured for. If the corners show, this number is the whole fix -- 0.13 buys most of the coverage back at 2.13 m.

## `ENV_DENSITY`: where each rate caps

- **`river` 0.9 is saturated on purpose, and the only one allowed to be.** Every candidate reaching the test has cleared `CLUMP_FLOOR`, so the rate it faces is at least `0.9 * (1 + 0.55 * 0.34) = 1.068`: nothing is refused on shingle and `CLUMP_GAIN` is inert. Worth saying plainly because it is the failure `check-rocks.mjs` gates against on the scree bed. Here it is the intent -- river shingle IS where loose stone collects, and the drift still carves swept lanes because the FLOOR still bites. Buying the in-drift gradation back means dropping `river` under `1 / (1 + 0.55 * 0.34) = 0.842`, below the peak, giving up the thing the entry exists to say.
- **`forest` 0.6** tops out at 0.930 and is never capped, so the gain is live across its whole range.
- **`peak` 0.75** reaches 1.0 at clump 0.606, so the gain is live over the lower two thirds of the drift and inert above -- 34 refusals per thousand candidates is what a partial cap looks like from outside.
- **`cliff` 0 is also unreachable**, two different facts and both wanted. `_envAt` only says `cliff` past `CLIFF_TAN` (42 deg) and `MAX_SLOPE_DEG` refuses past 34, so no candidate can arrive carrying that name. The entry is kept at zero for what happens if someone raises `MAX_SLOPE_DEG`: the branch would come alive, and a plausible-looking 0.22 here would quietly stamp flat pictures of gravel onto vertical rock. The loose stone that belongs at the base of a face is the rock scatter's scree bed, which is real geometry rather than a picture.

## Taking the ground's colour

`GROUND_BRIGHT`'s ceiling is a snow setting and nothing else. Every un-snowed entry in the mesher's palette sits between 0.059 (dirt) and 0.082 (rock) in luminance, so the compressed ratio lands between 0.81 and 0.96 for all of them -- inside both bounds, which makes the floor a guard against a repalette rather than something that bites on any ground today. `C_SNOW` is 0.879, eleven times the rest of the table: at a ceiling of 1.6 litter clamped to less than half of what the ground under it was doing and read as wet coal on a snowfield. 2.7 puts the mean stone near 0.57 albedo against snow's 0.879 -- still darker, because stone in snow IS darker, but by a stone's worth rather than a hole's. Partial snow ramps smoothly rather than stepping, since half-snowed ground compresses to 2.3, still under the clamp.

The hue fraction is deliberately NOT ramped alongside it: `C_SNOW` normalised to unit luminance is `[0.98, 1.00, 1.06]`, so at any fraction the tint moves by under 3% and the whole of the snow problem is the magnitude.
