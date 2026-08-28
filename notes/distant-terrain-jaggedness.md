# Distant terrain jaggedness -- sitrep

**Question asked:** prepass to find hills lost by coarse LOD, replace each with a 1-tri impostor billboard. Sensible or insanity?

**Answer: don't build it.** Not because the reasoning is bad, but because it is a third mechanism for a problem that already has two, and because this repo already refused the same trade one scale down. `rocks.js:93-99` and `design/05-rendering.md:191` give rocks no card tier on purpose: "a rock card would be photographed from the side, where a rock's normals are horizontal by construction... a flat picture of a boulder is a flat picture of a boulder." A landform is a boulder at 100x and every objection gets stronger: `bakeImpostor` writes one 128^2 layer at one azimuth (fine for a near-radially-symmetric tree, fatal for a ridge that is a wall broadside and a point end-on); the bake is re-lit through at most 4 authored normals under a *moving coloured aurora*; `litter.js`'s note already names the missing piece as "contact," and a hill's base is a long curved occluding intersection. Worst, it trades your current geometry pop for an impostor-to-geometry pop on a whole mountain. There is no octahedral impostor atlas in this codebase and building one is the real cost, not the triangles.

## What is actually erasing the jaggedness -- two separate mechanisms

A third one, the skyline profile target, was **removed on 2026-08-28** because its horizon-table rebuild cost more than a Quest 2 frame. Everything below that referred to it has been cut; the argument, the ladder and its two open defects are in `design/attic/skyline-profile-target.md`.

**1. Band-limit retirement. This is the one you found empirically, and it is the main event.** `detail.js:200-222`: every octave is weighted `w = smoothstep(cell*2, cell*4, lambda)`, so wavelengths under ~2-4 cells are faded to zero. At a 64 m cell that deletes everything below ~128 m. Shatter's protrusions melting away as you retreat *is this filter*, working as designed. The same construction gates ridge and shatter (`ridge.js:1010-1015`, `:971-975`). Your own gate already convicts it -- `check-v2-field.mjs:2268-2274`: "once `bw` reaches 0 a scale's shard is gone from that tier entirely, and no rounding constant can reach that. It is a known, open defect, it is not fixed, and it has not been judged either way." Roughly 10 m of climb remains missing on the worst summits at the coarsest rungs. It is correct as anti-aliasing and wrong as silhouette policy, and it is a **filter parameter -- fixing it costs zero triangles.**

**2. Summit truncation from point sampling.** A chunk point-samples the field on a grid, so a peak between samples is simply absent. `design/18-v2-world.md:86` measures it: 17 m at the median for a 64 m cell over the 150 highest summits, 6-7x what typical ground loses. One-sided bias, removable at zero triangle cost. The fix is **built and off**: `chunk-mesh-v2.js:310-325` takes a 5-tap diagonal max at +/-0.35*step, weighted by `field.exposureAt` so it lifts ribs and not hollows, ramped by `smoothstep(1, 6, step)` so it is exactly zero underfoot. Measured lift: mean 0.64 m / worst 2.02 m at an 8 m cell, **mean 2.71 m / worst 10.50 m at 32 m.** The knob is `crest`, `relief.js:204-208`, `off: 0`, and `main.js:224` starts from `RELIEF_DEFAULTS` (all off). As far as I know you have not tried it.

## Ranked plan

1. **Try `crest`.** Free, built, measured, never switched on. Highest value per minute of anything here.
2. **Re-aim the band limit at the silhouette.** Widening the smoothstep (or floor-ing `bw`) attacks root cause 1 directly, and it is still zero triangles. With the profile target gone there is no per-node skyline tag to scope it to, so this now has to be scoped by something else -- range, or exposure, or nothing.
3. **Only after all that**, if silhouette detail is still genuinely missing, add *world-space geometry*, not cards -- `TASKS.md:54` (procedural rock cliffsides) is the existing thread. `TASKS.md:93` "Terrain LOD: toothy peaks" is this ticket.

## Open, and not investigated

- **"The other knobs mostly don't work as advertised or have no effect."** Not diagnosed. This is its own session and possibly its own bug -- `normalizeRelief` throws on unknown keys, so silent no-ops are more likely a knob whose term is gated off downstream (`relief.js:267`'s `reliefNeeds` exposure list) than a typo. Worth naming which ones before anyone digs.
- No geomorphing exists anywhere in the terrain path -- no vertex lerp between levels, no morph attribute, no crossfade. LOD changes are hard pops, hidden only by tight angular targets and stand-in covers (`terrain-v2.js:1010-1046`). Relevant to how any of the above will *read* in motion.
- Nothing here was confirmed visually in the running game.
