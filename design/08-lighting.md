## 8. Lighting, shadows, and the day/night cycle

> **Covers:** horizon mapping, the AO bake, the day/night palette keyed on sun elevation, and the night lighting/fog split.
> **Read this when:** touching `src/clock.js`, `src/lighting.js`, `src/sim/horizon.js`, or `scripts/check-daynight.mjs`.

**24 real minutes = 24 in-world hours.** One real minute per in-world hour.

### Technique: horizon mapping

For each terrain texel, precompute the **horizon elevation angle** in N azimuth directions (N = 16) by raymarching the heightmap. Store as a texture. At runtime:

```
sunOccluded = smoothstep(horizonAngle - softness, horizonAngle + softness, sunElevation)
```

where `horizonAngle` is bilinearly interpolated between the two azimuth slices nearest the sun's current azimuth.

Horizon maps are **computed once and valid for every sun position**, which is what makes a continuously moving sun affordable. This gives:

- **Continuous sun movement** with no re-baking, no crossfade artifacts, no periodic hitches
- **Soft, blurry shadow edges** for free -- the `smoothstep` band replaces a hard step, and band width is a single tunable
- Correct behavior at grazing dawn/dusk angles, which is where long mountain shadows look best

### Separate AO bake for crevice deepening

Shadow (directional occlusion) and ambient occlusion are different terms and must be computed separately. Bake a **sky-visibility / AO value** per texel once at generation. It is sun-independent, so it is computed exactly once and never recomputed. This is what deepens gorges, gullies, and cliff bases regardless of sun position -- and gorges are a headline feature, so this term is doing real work.

```
terrainLight = sunColor * NdotL * (1 - sunOccluded) + ambientColor * ao
```

Ambient color is driven by time of day (warm at dusk, deep blue at night, tinted green when the aurora is active).

### Props inherit terrain lighting

In the vertex shader, use the instance's world XZ to compute a UV into the horizon map and AO texture, sample both, pass the resulting scalar to the fragment shader as a varying, multiply into albedo.

Trees on the shadowed side of a ridge are darker than trees catching the sun; props tucked into gullies pick up the crevice darkening. All automatic, all consistent with the terrain they stand on, for the cost of two vertex-shader texture samples. **No per-instance attribute needed**, which is why `batched-mesh-extensions` is not required (see §13).

### Resolution strategy (most likely part to need tuning)

Horizon maps at 16 azimuths cost 16 bytes/texel. Two tiers:

- **Global coarse:** 1024² over 16 km (15.6 m/texel), ~16 MB, computed once at load. Macro "which side of the mountain" shadowing for distant terrain
- **Per-chunk fine:** ~1 m/texel, computed in the worker as chunks stream in within the detail radius. Crevice-scale detail near the player

Blend by distance. **If the fine tier proves too expensive, ship the global tier alone** -- macro mountain shadows are 80% of the payoff, and the AO bake (cheap, sun-independent) carries crevice detail on its own.

### Other lighting

- **Blob shadow decals** under props for contact shadow
- **AO baked into each asset's own texture/vertex colors** during the Blender pass
- One real-time directional light for sun/moon. Nothing else

### What shipped

`src/clock.js` (no three.js import, so the gate can run it in node), `src/sim/horizon.js`, `src/lighting.js`. Gated by `scripts/check-daynight.mjs`.

**The clock.** 24 real minutes = 24 in-world hours as specified. Latitude 65 N, declination -4 deg, which is early November at the top of Norway: the sun culminates at 21 deg, so shadows are long *all day*, not only at dawn -- that is the whole reason for the latitude. Day length is 10.85 h, leaving a 13-hour night to put an aurora in. `N` (or the right grip in VR) skips 6 in-world hours.

The clock's `elapsed` counter is monotonic and never wrapped; only the *displayed* hour wraps. That matters because the aurora's substorm noise is indexed on `elapsed` -- if the skip wrapped the counter, skipping forward a full day would land you on a byte-identical sky.

**The palette.** A 10-row keyframe table indexed on **sun elevation**, not on clock hour. Elevation is the physically meaningful variable -- it is what actually determines how much atmosphere the light is crossing -- and keying on it means the whole table stays correct if the latitude or the date ever changes. Rows at +25, +12, +5, +1, -1, -4, -6, -12, -18 and -90 deg; the tight cluster between +5 and -6 is where the entire sunset happens. Each row carries sky horizon and zenith colour, horizon glow colour/amount/sharpness, sun colour and intensity, hemisphere sky/ground/intensity, fog colour and density, star fade, moon brightness and the aurora ceiling. The daytime horizon colour is the pre-existing `FOG_COLOR`, so **noon looks exactly as it did before this work**.

The gate sweeps this table at 20,000 steps and fails on any channel step above 0.009. A keyframe accidentally typed out of order is otherwise a two-frame flash at dusk that nobody is wearing the headset to see.

**Sun and moon share one directional light.** The handover happens at -6 deg sun elevation, where the palette has already taken sun intensity to exactly 0 -- so the direction snaps while the light contributes nothing, and the snap is unobservable. Crossfading the *direction* instead would swing every shadow in the world through angles neither body ever occupies.

**The moon** is a genuine crescent: 19% lit, rising once a day and up for essentially the whole dark. That fraction is art direction and `clock.js` says so out loud -- a real 19% crescent sets shortly after the sun and would be gone by the time the aurora starts. What is *not* faked is the terminator's **orientation**, which is derived from the true sun direction every frame, because the angle of the horns against the sky is the part the eye actually checks.

**The horizon bake** is the interesting piece. Naive raymarching of 1024² texels x 16 azimuths is ~23 billion samples. Instead `bakeHorizon` uses **Stewart's (1998) O(n) upper-convex-hull line sweep**: for each azimuth, walk the grid as a family of near-parallel lines, and sweep each line backwards maintaining the upper hull of the points behind you. The maximum slope from any point to anything ahead of it is always on that hull, so it falls out in amortised O(1) per cell. That is ~25M point visits: **533 ms for 1024² x 16 azimuths**, run inside the existing Phase A worker on `result.elev`, so it costs nothing beyond those 533 ms.

The line enumeration is the part that wants care. The obvious scheme does not cover every cell exactly once, and a missed cell keeps its initial horizon of zero -- which reads as a pinprick of *full sunlight* in the middle of a mountain shadow. The shipped version offsets by an integer that is a bijection onto the minor axis for each major-axis step, and the gate checks the result against brute force: **max error 0.1751 deg, exactly half the byte quantisation step**, i.e. the sweep is exact and quantisation is the only error. That step is in turn 8x finer than the 1.5 deg penumbra, so it is invisible.

The same pass accumulates `mean_a(cos^2(h_a))`, the closed-form cosine-weighted fraction of visible sky, into the AO map for free -- with a 0.16 floor, because this is the *only* ambient occlusion term in the scene and true black in a crevice is worse than a slightly lifted one.

**Two shading granularities.** Terrain samples the horizon map **per fragment**; props and village geometry sample it **per vertex** and pass a `vec2` varying. Terrain has to be per-fragment because far-LOD triangles are 64 m across and per-vertex shading would pin every shadow edge to a quadtree boundary. Props are the triangle budget, and a tree is small against a mountain shadow, so per-vertex is not a compromise there -- it is the right answer.

`WorldLighting.patch()` chains onto any existing `onBeforeCompile` rather than replacing it, which is how the terrain keeps its own surface-grain patch. The gate runs those patches against three.js's real `ShaderLib.lambert` source and asserts the injected identifiers are present, because **a** `String.replace` **that matches nothing returns the string unchanged** -- a three.js version bump that renames a chunk would silently delete every shadow in the game while everything still compiled and rendered.

The uniforms are shared **by reference** into each compiled shader, so the horizon maps can land four seconds after the world is already on screen with no recompile and no pop. Until they arrive a flag uniform makes the sampler functions early-return 1.0.

The per-chunk fine tier above was **not** built, as anticipated: the global tier plus the AO bake carries it.

#### Night had to be lit properly, and multiplied light could not do it

The first night shipped was unnavigable -- "pitch dark, especially in the grassy areas". Measured rather than eyeballed, by reproducing three.js's Lambert + HemisphereLight maths on the CPU and reading out sRGB bytes: **grass in shadow at luma 1, rock in a gully at 0, a tree trunk at 0**, while snow sat at 89. Not "a bit dark": black.

The obvious repair -- raise `hemiIntensity` -- cannot work, and it is worth being precise about why. **A hemisphere light is a multiplier on albedo.** A tree trunk at 4% albedo under an ambient bright enough to blow the snow out is still black, because 0.04 x anything reasonable is still nothing. Every lever in the palette as it stood was a multiplier, so no combination of them had a solution.

The fix is three terms, and the important one is not a multiplier:

- `skyGlow` **x** `skyGlowAmt` -- an **additive**, albedo-independent glow added to `reflectedLight.indirectDiffuse` in `lighting.js`, *after* the BRDF has already multiplied in `diffuseColor`. Physically this is airglow and scattered starlight, which really are additive at the eye. It lifts a 4% trunk and 90% snow by the same absolute amount, which is exactly the behaviour needed and exactly what a multiplier cannot give.
- `skyFloor` -- remaps the AO term so that full occlusion means `skyFloor` rather than zero. At noon zero is right, because the sun fills the gully the AO term is darkening. After dark the ambient *is* the light, so an unfloored 0.1 occlusion leaves a crease with a tenth of all the illumination there is. Grass is self-occluding by construction, which is why the grass was the worst of it.
- **Raised night hemisphere and moonlight**, which now *rise* slightly from -6 deg to -18 deg rather than falling. That is deliberate and it is not the sky -- it is the **dark-adaptation curve**. We cannot adapt the viewer's eye; the headset is worn in a lit room. So the number that belongs in the table is what a dark-adapted eye reports, which is far closer to a moonlit photograph than to the physical millionth-of-noon ratio.

All three are exactly zero above the horizon, so **noon is bit-for-bit unchanged** and the gate asserts it.

Measured after: **trunk 21, gully rock 35, grass in shadow 41, lit grass 62, snow 119** -- a 6x range with nothing at black. The gate now sweeps every dark hour of the day, including the ones with the moon under the horizon, and fails if the darkest surface at the darkest hour drops below luma 12. That check found a real dip near dawn that the 01:00 spot-check had missed.

**Then it was too grey, and the fix was to halve the same term.** The complaint was that night had gone flat -- "there's still dark areas and lighter areas" was what it *should* look like, and it did not. The reason is the same additive-versus-multiplicative distinction, read the other way round: because `skyGlow` adds the same absolute amount to a 4% trunk and to 88% snow, **it does not merely brighten, it compresses contrast**. Lifting everything by a constant is what a fog layer does, and a fog layer is exactly what it looked like.

So both night knobs were halved across all six sub-horizon rows -- `skyGlowAmt` 0.019 -> 0.0095 at full dark, `skyFloor` 0.31 -> 0.155 -- and the hemisphere light and moonlight were left alone, because those multiply albedo and are therefore the terms that carry *colour* and *material difference*. Halving the additive term darkens the image and **raises** its contrast at the same time, which is not a tradeoff anyone gets to make with a multiplier.

Measured at 01:00 after: **trunk 12, gully rock 25, grass in shadow 34, lit grass 58, snow 117** -- the snow-to-darkest ratio went from 5.7x to 9.8x while every surface got darker. The gate's night promise is now split in two, because they are different promises: a **tree trunk** is allowed to become a silhouette at 03:00 (floor luma 6), but the **ground she is walking on** is not (floor 14 at 01:00, 12 at the worst moonless hour). A `GROUND` subset excluding trunk and snow carries the second one.

#### And then it was flat, which is a different complaint from grey -- and the check was causing it

"At nighttime the ground and terrain just feel flat and even and grayscale." Note what that is *not*: it is not "too dark" and it is not "too bright". Every brightness number above was in range and the night still had no shape. The missing quantity was **direction**, and the diagnosis is a ratio rather than a level.

At full dark the directional moonlight contributed `0.50 x 0.474 = 0.237` against a hemisphere at 0.50 plus an additive lift. So under a third of any surface's brightness came from the one term that knows where the moon is. Ambient light has no direction by construction, so while it dominated, the answer to "which way is this hillside facing" barely changed what you saw. **Measured, a full moon overhead gave lit grass 80 against shaded grass 34 -- 2.4:1.** That is the number that reads as flat.

Worse, the gate was actively enforcing it. `worstGround >= 12` swept every surface at every dark hour and demanded a floor, and the only way to meet a floor on the *shaded* side is to raise ambient, which lifts the lit side by the same amount and flattens the ratio further. The check had been written to catch "unnavigable" and it had quietly become a check for "evenly lit".

The repair is one move with two halves, and neither half works alone:

- `MOONLIGHT.intensity` **0.50 -> 1.20**, and
- **night ambient cut about 40%** across all six sub-horizon rows: `hemiIntensity` 0.50 -> 0.30, `skyGlowAmt` 0.0095 -> 0.0062, `skyFloor` 0.155 -> 0.115 at full dark, proportionately at -12, -6 and -4.

Measured after, at a full moon well up: **lit grass 106 / shaded grass 24, lit snow 197 / shaded snow 43** -- 4.4:1 and 4.6:1, where it was 2.4:1. Snow on the moonlit side is now genuinely bright enough to walk by and a slope with the moon behind it goes most of the way to a silhouette, which is the requested behaviour and is the same behaviour on both counts.

**Distance is the other half of "flat".** A night that is correctly lit at 20 m is still a diorama if the ridge at 800 m is a slightly dimmer version of the same thing. This round tried to buy that with heavy night fog and it was the wrong knob; see "Night fog and the far field" below for what the two knobs actually do. (The retracted argument is in `design/history/night-fog.md`.)

**One thing had to be exempted.** Village fires are `MeshBasicMaterial`, and three fogs those like anything else -- so a hearth in the far distance gets lerped toward the fog colour and washes out, when a distant fire on a dark night is in fact the *last* thing to disappear. Fog models attenuation between here and there; it has no way to model the eye adapting to a small bright source rather than to the landscape. So `flameMat` gets `fog: false`, alongside the pre-existing decision that it is unlit. The gate asserts it from `check-daynight.mjs`, reaching into `village.js`, because the reason for the flag lives in the fog table and not in the village.

**The gate's night promise is now three promises, not one**, and the middle one has an *upper* bound, which is the only check in the file that does:

- ground **the moon reaches** is readable at every hour the moon is up (luma >= 40; worst measured 55). Conditioned on the moon actually delivering light, because a 3-degree crescent is not a light source and requiring navigability under one is what put the ambient back.
- ground **it does not reach** is dark without being gone (luma >= 6; worst measured 8).
- **slope contrast** at a full moon is at least 3:1 on both grass and snow, and shaded grass is at most 26. Before this round it measured 2.4:1, which passed every brightness check in the file and still looked like nothing.

#### Night fog and the far field: dim is lighting's job, hazy is fog's

The reported symptom was "all terrain at night is pitch-black except the mountains within ~500 m of me", and that is exactly what `fogDensity` 0.0022 does: 70% gone at 500 m, 95% at 800 m, 99% at a kilometre, toward a colour darker than the sky.

The reasoning error is worth naming, because it is a general one. Fog is applied *after* the lighting, so it is not a contrast effect at all -- it is a multiply toward a constant, and a density that erases a ridge at 600 m erases it however well the moon happens to be lighting it. "A dark-adapted eye loses contrast at distance" is a real observation, but the mechanism that models it is *lighting*, not *fog*: dimmer far-field illumination lowers the far field's contrast while leaving it visible, which is what the eye actually does. Fog toward near-black does not lower contrast, it deletes.

So the two knobs got the division of labour they should have had from the start. **The far-field lighting split makes distance dim. The fog makes distance hazy.** Night density drops from 0.0022 to 0.00032, which is a hair over the daytime 0.00022 rather than ten times it: 3% gone at 500 m, 10% at a kilometre, 33% at two, 60% at three, 92% at five. A moonlit ridge two valleys over is scenery again.

The checks were rewritten to guard the opposite promise -- under 20% at a kilometre, still over 35% at three and over 85% at six, and the night density within a factor of two of noon's, because night air is not actually thicker than day air and whatever rise there is here is a look choice that should stay small enough to be one.

#### Splitting the lighting by distance

The ratio fix above bought slope contrast, but it bought it *everywhere*, and the follow-up request was to split the two jobs the night lighting is doing:

> Make the DEFAULT lighting for the whole scene just based on the position of the moon/sun, ~half as bright as the lighting currently used for nearby terrain. In addition, terrain within 25 m of you should be lit to the same degree that it currently is, fading out to "no additional lighting beyond moon lighting" at 50 m.

Two new palette columns, `farDirect` and `farAmbient`, and one new term in `lighting.js`:

```glsl
float wlNear = 1.0 - smoothstep( 25.0, 50.0, distance( worldPos, cameraPosition ) );
reflectedLight.directDiffuse *= sun * mix( uFarLight.x, 1.0, wlNear );
float wlSkyF = mix( uSkyFloor, 1.0, sky ) * mix( uFarLight.y, 1.0, wlNear );
```

At full dark `uFarLight` is **(0.40, 0.0)**, and *the zero is the point*. Ambient light has no direction, so out where it was most of the illumination, a slope facing the moon and a slope facing away measured the same -- the same defect the round-four ratio fix addressed, surviving in the part of the frame the round-four fix could not reach. Delete the ambient beyond arm's reach and the far field becomes purely a function of where the moon is. Measured at 01:00: **lit grass 67 near / 34 far, shaded grass 24 near / 0 far, snow 129 / 70.**

The near field keeps its ambient because that is where the ambient is doing honest work -- it is what stops the ground under her feet being a hole -- and 25 m is roughly how far a dark-adapted eye resolves ground texture by starlight.

Both columns are exactly 1.0 whenever the sun is up, so daylight is bit-for-bit untouched; they come down across the same civil-twilight band where the moon takes over as key light, and the continuity sweep now includes them (a step in `farAmbient` is a step in the brightness of most of the frame).

**The cost is honest and is written down**: a brightness gradient centred on the player. Shaded ground fades 24 to 0 across a 25 m annulus that travels with her, and nothing in nature does that. It is a deliberate trade against a flat far field on one side and a near field with no floor on the other, and it is the first thing to judge on device.

There is also an unresolved interaction with the fog. `fogDensity` at full dark (0.0022) was tuned when the far field still had ambient; the far field is now darker by that much again, so distance is being attenuated twice. Nothing was changed -- retuning two coupled knobs without a headset is how the last three rounds went wrong -- but it is flagged in TASKS.md.

The gate carries four new promises: distant moonlit ground is 40-62% of the ground at her feet, ground the moon cannot see is *genuinely zero* out there rather than grey, distant moonlit snow still carries the ridgelines (luma >= 60), and the envelope is exactly inert at 09:00, 12:00 and 15:00.

---
