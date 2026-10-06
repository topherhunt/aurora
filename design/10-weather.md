## 10. Weather

> **Covers:** cloud cover, overcast light, rain and snow, the fog they bring, the two kinds of cloud (a sky layer and summit wreaths), and how all of it hangs off the world clock. All four phases are built and gated; the build order at the end is kept as the map of the pieces.
> **Read this when:** starting or extending weather, or touching anything in `clock.js state()`, `sky-glsl.js` or `lighting.js` that weather multiplies.
> **Not here:** the aurora's own activity noise, which shares the mechanism (§13), and the day-night palette itself (§8, `clock.js` `KEYS`).

The world today is always clear. What it should have: clear days with some cloud in them, days that thicken to overcast, and grey rainy spells of one to five real minutes that close the distance in, after which it clears again. Even on the clearest day a few summits should carry cloud.

### Four constraints that decide the design

1. **Weather is a pure function of the room's clock.** The room's clock is an anchor timestamp plus a skip count; nothing about time is sent per frame, and every peer draws the same sky because `WorldClock.state()` is deterministic (§8, `net.js`). Weather that draws a random number anywhere puts each peer under a different sky. It is noise over `elapsed`, exactly as the aurora's activity is, and `skip()` advances it along with the sun. Its seed is the **anchor itself** (`WorldClock.coverAt`), not the world `SEED`: the world seed names the terrain and is the same in every game, so seeding weather from it would rain on every game's first day at the same minute. The anchor is new for every room and every solo boot, shared by every peer in a room, and `elapsed` is never wrapped, so day three never repeats day one. The relay never chooses weather.
2. **No second path.** `sky.js` states the rule for the day-night cycle: every colour is a uniform, there is no branch on time of day, sunset is where the numbers happen to be. Overcast obeys the same rule. It is a set of multipliers applied to the palette *after* `paletteAt`, so `KEYS` is untouched and cover 0 is bit-identical to today. The gate asserts that.
3. **Quest is fill-rate bound (§0, §5).** Nothing here adds a near-fullscreen transparent pass. Sky clouds go inside the dome pass that is already paid for; summit clouds are opaque geometry with dithered edges; precipitation is a small box of thin quads.
4. **The clock runs one in-world hour per real minute.** A one-to-five minute rain is a one-to-five in-world hour rain, and the durations below are in in-world hours.

### The weather channel

Two octaves of `noise1` over `elapsed`, the aurora's mechanism (`clock.js`):

- a **regime** octave, period 36 h, which decides whether today is a clear day or a grey one, so there are whole clear days rather than a permanent drizzle of small changes;
- a **squall** octave, period 2.5 h, which makes cloud come and go inside the regime.

Their equal-weight sum, stretched 1.6x about 0.5 (two value noises summed rarely leave 0.25..0.75 otherwise), is `cover`, 0 to 1. `precip = smoothstep(0.70, 0.85, cover)`, so rain is what a thick overcast becomes, never a separate switch, and it fades in and out with the cloud rather than starting on a frame. The constants live in `WEATHER` (`clock.js`) and are held by `check-weather.mjs`'s **measured episode histogram**: ten rooms, two in-world weeks each at one-minute resolution, `precip > 0.5` runs. As tuned: median spell 2.5 h, 68% between 1 and 5 h, p90 7 h, rain 19% of the time, cover under 0.35 29% of the time, a whole fair day (never overcast) in 7 fortnights of 10.

Precipitation **type** is decided where she is, not in the channel: her head above the snowline band gets snow, below it rain, with a crossfade across the band so climbing into a storm turns rain to snow. The sky does not know or care; only the particle box and the sound do.

Both numbers travel in the state object as `cover` and `precip`, beside `aurora` and `activity`. `WorldClock.weather` holds the channel at a fixed cover: the debug-menu row (`weather >`, K on a desktop) cycles live, clear, scattered, overcast and rain from `WEATHER.presets`, this client only, and the gates construct clear clocks so the day-night table is measured without it. Tuning a look against a 36-hour noise is impossible without the row.

### What overcast does to the palette

Applied by `overcast()` in `clock.js` to the interpolated palette `p`. Each one is a multiplier or a mix toward a target, never a branch, and each is listed with why it exists.

- **`sunIntensity × (1 - 0.85·cover²)`, `sunLight` desaturated toward white.** The direct term falling is what removes the shadows, and shadowlessness is the thing the eye reads as overcast. Nothing touches the horizon-map shadow itself; a weak sun through a weak shadow is the right answer.
- **`hemiSky` mixed toward an overcast grey, `hemiIntensity` slightly up.** The grey is derived from the palette's own horizon luminance, so overcast at dusk is a dim warm grey and overcast at noon a bright one. A fixed grey would make every overcast hour look like the same hour.
- **`horizon` and `zenith` toward the same grey, `glowAmt` down.** The dome flattens. The cloud layer below paints texture over it; this is the colour under the texture.
- **`haze` lifted toward `fog`.** Overcast kills the ridge ladder that `lighting.js` builds from the near-haze/far-fog gap (the in-scatter has no sunlight to scatter), and a flat far field is correct under a flat sky.
- **`hazeDensity × (1 + cover + 1.7·precip)`.** This is the visibility. The day value 0.00113 puts 1/e extinction at 885 m; full rain lands at 0.0042, about 240 m, so a rainy valley ends at the next hill and the skyline is gone. It reaches the water for free, since `water.js` reads the same density. The night rows must be watched here: `clock.js` documents at length why a night that ends at arm's length is the failure this file must never reintroduce, and rain at night is the case that could.
- **`fog` toward grey.** The far field and the flattened dome must still meet at one colour.
- **`stars`, `auroraMax`, `moonBright` × `(1 - cover)²`.** Stars through an overcast are the loudest tell there is, and §13 already asks for weather to mute the aurora.

The night-lift terms (`skyGlow`, `skyFloor`, the far-field envelope) are not touched. They are the dark-adapted eye, not the sky.

### Two kinds of cloud

They are different objects because they answer different questions. The sky layer says *what the weather is*. The summit wreaths say *how far away those mountains are*.

#### The sky layer, inside `skyRadiance`

A flat cloud plane at 1500 m, above every summit (terrain tops out at 900 m). The view ray is projected onto it, `p = dir.xz * (1500 / dir.y)`, and a **256² seamless fBm texture**, baked offline by `scripts/make-clouds.mjs` to `public/world/clouds.png` and handed to the dome by `Sky.setClouds`, is sampled at two scales (tiles of 6000 m and 2600 m, weighted 0.65/0.35) that drift along the room's wind heading at 0.08 tiles per in-world hour of `elapsed`, so the drift is as deterministic as the cover. R is the density; G/B are the slope (u, v) of the first three octaves alone, normalised to the steepest texel, which the dome lights each cloud's sides from (the full sum's slope is crinkle, since every octave adds equal slope). Two fetches and a little arithmetic per sky fragment.

The load-bearing trick is the **coverage remap** (`cloudRemap` in `sky-glsl.js`): `density = smoothstep(lo, hi, tex)` with `lo = 1 - 0.9·cover`, `hi = lo + 0.3`. One texture gives scattered puffs at cover 0.4, a broken ceiling at 0.7 and a solid one at 1, and every state between is continuous, so thickening is a slide of two numbers rather than a crossfade between looks.

Shading takes two colours derived from the palette each frame, so there is no cloud row in `KEYS`: lit faces a quarter above the `horizon` colour (white by day, peach at sunset, near black at night), bellies a dimmed mean of `horizon` and `zenith`, mixed by thickness past the remap's top edge so a solid ceiling still shows texture. The layer takes the horizon colour as it recedes toward the rim, the same aerial perspective the terrain gets, so a ceiling meets the fog rather than ending on it. Each cloud has a lit and a far side: the slope chained through both samplings and dotted with the light's horizontal direction (so a high sun, lighting tops nobody sees, does little) gives `side`, ×10 and clamped to ±1, where a cloud that thins toward the sun is its lit face. By day the lit colour is clipped white, so `side` moves the shade mix (±0.4) rather than scaling, plus a ×1.3 and a sun-tinted lift on the lit face, which is what shows at sunset; the moon's version adds cool light on its face and dims the far one by up to 45%, only once the sun's sides have faded (the faint daytime moon would otherwise grey day clouds). The layer is also lit by direction across the dome: away from the sun it leans toward the belly colour (up to 0.7 more thickness at the antisolar point), toward it it brightens (up to 1.45×, a `dot⁵` lobe) after the horizon fade so a low sun's low clouds keep it, and thin edges near the sun (`dot¹⁶`, sun-tinted) or moon (`dot⁴⁰`, cool) get a silver lining added over the composite by `√alpha`, since those edges are the most transparent part and a plain mix would hand the glow back to the sky. The sun terms fade on their own ramp to 7° below the horizon, outlasting the disc's `uSunFade`, and the sun's rim goes with `1 - cover²` (an overcast has no backlit edge); the moon's take `uMoon.y`, which already carries the cover dim. The cloud is composited after the sun, so it occludes the disc where it is thick; the halo and disc are also scaled by `1 - cover²` so the lake highlight, which never fetches cloud, dims with the sky. At night the layer is dark, and the dome's existing sRGB dither handles the banding.

A horizon fade over `dir.y` from 0.02 to 0.15 hides the plane's infinite stretch at the horizon, which is where the fog is eating the terrain anyway, so the two hand off.

**The sky ends in the land's fog.** `skyRadiance` is `skyClear` (the dome, sun, clouds) mixed toward the same aerial ramp the terrain gets, with the view ray at elevation `e` treated as a ridge `SKY_HAZE_M / sin(e)` metres off (30 m; `sky-glsl.js`): the mix is `1 - exp(-(L × hazeDensity)²)`, its near end the palette's `fog` and its far end `fog × airCeiling(cover)` (`lighting.js`), the same two colours a far ridge lands on. On a clear day that is a 35% band at 3°, 1% at 20°, so a far range still stands dark against the sky over it and a clear day sees the ranges; under rain it is 100% at 3°, 41% at 10°, 2% overhead, so the horizon and the sun in it go the way the land went while the clouds straight up stay readable. `overcast()` takes `haze` to `fog`, so under a ceiling the near air, the far air and the horizon are one grey. The water reflects `skyRadiance` and fades, at the same density, to the land's own aerial ramp at its own distance (§11), so a far lake is the colour of the ridge beside it, and under rain a lake is not a sharp patch in a grey valley. `check-weather.mjs` pins the uniforms to the palette and the band's width at both ends.

The water calls `skyRadiance` once per top-face pixel (the reflected ray, `water.js`) and once on the underwater face, so an unconditional cloud term is two fetches per water pixel on a lake shore. The cloud term therefore sits behind a branch on `coreGain`, which already distinguishes the dome (1.0) from the water (0.0) and is coherent across the draw. The lake ships without cloud texture in its reflection; it still goes grey under overcast because it reads the same flattened `horizon` and `zenith`. Reflected clouds are an A/B on the headset, not a default.

**The dome is drawn last, not first.** `sky.js` draws it at `renderOrder 950`: after every opaque and the boats' depth-only lids at 900, before the overlays at 998 and the menu at 1000, with no depth write and the depth test on, so early-Z rejects every dome fragment behind a ridge and the sky pays only for visible sky, typically a fifth to a half of the eye. The stars and the aurora are transparent and so still draw after it. This is what makes two extra fetches affordable, and the debug row `sky clouds` is the A/B for them.

**Why not the two scrolling alpha planes §13 lists as outstanding:** that is two near-fullscreen transparent overdraws on a fill-bound GPU. This is zero extra overdraw in a pass already paid for, and it reflects for free.

#### Summit wreaths: shaded cloud cards, dithered edges

The picture is distant mountains wreathed in cloud, present even on a clear day. Cloud that hugs a peak is orographic, a cap or banner cloud, and it sits still relative to the summit while the air moves through it. That physical fact is what makes the cheap version honest.

Placement (`scripts/make-summits.mjs` → `public/world/summits.json`): the 28 highest local maxima of the shipped field (heightmap plus `RELIEF_SHIPPED`, so the wreath sits on the ground she sees) above 420 m and no closer than 900 m to a higher one, each hill-climbed to the true crest before the suppression so the spacing holds at the crests, and baked with an 11×11 grid of ground heights over a ±400 m footprint. `render/wreaths.js` gives each four to seven **cards**: vertical billboards 220 to 480 m wide and half as tall, the first on the summit, the rest scattered down the flanks up to 0.9 of the footprint out, each seated with its centre 0.2 to 0.4 of its height above the ground under it, so its base is in the rock. Every card of every wreath is a quad in **one `BufferGeometry`** with no position attribute: `aCenter`, `aCorner`, `aSize`, `aGround` (the ground height at the centre and its slope, from the grid), `aTile` (which sprite, flipped or not) and `aSummit`. The vertex stage turns the quad about its own axis to face her and leans its normal up and toward her, so a cloud between her and the sun is the darker one. About 150 cards, one draw, and no `heightAt` call at boot.

The sprite is a **shaded cloud rendered offline**: `scripts/make-cloud-cards.mjs` → `public/world/cloud-cards.png`, four 256×128 tiles of a domed union of puffs (saturating as `s/(0.7+s)`, since a clamp gives a flat lobe with a hard shaded edge) warped by fBm, a flat base, shaded as a height field lit from the upper left and darkened toward the base; grey RGB is the shade, alpha the coverage, ~99 KB. The card's Lambert colour (0xe6e9ee) is multiplied by the shade, so the sun and the sky fill still light it, and the sprite gives it bellies.

The edge is **dithered, not blended**. Per fragment `alpha = smoothstep(uThick, uThick + 0.5, card.a) × smoothstep(0, GROUND_FADE_M, above)`, with `above` the height over the card's ground plane, carried from the vertex stage and applied per fragment (a fade interpolated from the corners would stipple the whole body). The ground term is what seats a card into its mountain rather than cutting a line where the depth test meets it, over 50 m. `alpha` is tested against interleaved gradient noise on `gl_FragCoord`: `coverage = 5 × alpha - 4 × hash`, a threshold a quarter wide placed so alpha 0 keeps no pixel and alpha 1 every pixel whole, the fragment discarded at or below 0, the rest written as alpha with `alphaToCoverage` on so 4x MSAA adds coverage levels under the hash and the fringe still stipples without MSAA.

Why it stays in the opaque pass: no sorting, depth writes on, terrain occludes it correctly, and it is lit by the ordinary path under `lighting.js`'s per-vertex patch (cache key `v2-wreaths`), so it takes the sun colour, the horizon-map shadow and the night envelope. It does **not** take the patch's aerial mix. That mix takes a ridge to the dark near `haze` on purpose (a silhouette, `clock.js`), and a white cloud a kilometre off rendered that way is a dark grey smudge on the peak. A cloud is as bright as the air in front of it, so the card takes the fog slot first (`AIR_GLSL`, before the patch looks for it) and fades to `fog`, the horizon the dome ends in, at `AIR_SHARE` (0.5) of `hazeDensity`: 1/e at 1.8 km on a clear noon where the ridge is at 0.9 km, so the cloud keeps its shading past the ridge it sits on, as a bright thing does against a dark one; under rain it is gone by 1.2 km with everything else. At sunset the cards take the fog's orange.

**The `discard` costs the draw its low-resolution-Z on Adreno** (§28, `grass.js`), so every fragment the cards cover is shaded whether or not terrain is in front of it. That penalty scales with the draw's screen area, which is what the cull below holds small: the widest card is 50° across at its 500 m cull and 27° at 1 km, most cards are far and a few pixels tall, and the atlas's coverage is 35-41% per tile, so most of a quad discards on its first fetch. The fill is the few cards of the nearest wreath, and it is the number the headset owes. The mesh is `frustumCulled = false` at `renderOrder 10`, after the terrain and props at 0, since three would otherwise sort it by its one world-spanning bounding sphere. The alpha-blend fallback (transparent pass, no depth write, a CPU sort) is not built; it is warranted only if the headset measures this badly, and the `summit clouds` debug row is the A/B that would say so.

Under weather the cards **thicken** (`uThick = 0.4 - 0.4 × cover`, the alpha threshold; the sprite's dense core at 0, the whole sprite at 1) and their **base descends** (`uLower = 140 × cover` m, subtracted in the vertex shader), so "wreathed" intensifies into "summits gone" as rain comes in, which is what a lowering cloud base looks like.

Near field: she can summit, and a card is **culled, never faded**, because a fragment at alpha 0 costs what a fragment at alpha 1 costs. The vertex stage pushes every card whose centre is within `CULL_M` (500 m) of `uHead` behind the far plane, card by card, so at 900 m spacing being in reach of two summits is fine. In its place `hazeGain(head)` multiplies `state.hazeDensity`: 1 beyond `HAZE_REACH_M` (1000 m) from the nearest summit, a smoothstep up to `HAZE_GAIN` (2.5) at the cull radius. Walking into the cloud becomes the fog closing in, for the price of one number on the CPU. `check-wreaths.mjs` gates the summit list against the field, the atlas's shape, the draw's shape and slot (every card seated and clear of the fade at its top), and the gain's shape; `check-shaders.mjs` compiles the program and checks that its own fog slot, not the aerial mix, landed.

### Precipitation

`src/v2/render/precip.js`. One draw of `COUNT = 2000` quads in a `BOX_M = 12` cube whose centre sits `0.2 × box` above her head, wrapping modulo the box as she moves, so the cost is constant whatever the world size and the fall comes from above rather than half from below. There is no position attribute: each quad carries a seed in the unit cube, a corner and two picks, and the vertex stage places it. The box is small on purpose: a particle system is a screen-wide alpha source and the GPU is fill-rate bound, so `BOX_M` and `COUNT` are the first things to dial back if frame time is tight.

- **One material, rain or snow per quad.** `uSnow = smoothstep(-60, 60, head.y - snowLine)` and each quad is snow when its pick is under it, so the `SLEET_BAND_M = 60` about the snow line is sleet and neither kind needs a second draw. Both blend normally with no depth write: at a pixel or two wide the sort errors additive snow would have sidestepped are invisible, and additive white over a bright sky was invisible too. The fragment ends on `#include <colorspace_fragment>`, without which a ShaderMaterial's set colour lands in the sRGB framebuffer unconverted and a white flake draws dark grey.
- **The fall is summed on the CPU.** `velocity(snow, wind, intensity)` exists in GLSL and JS and must agree: a drop falls at 9 m/s sheared by the wind at `2 + 4 × intensity`, a flake at 1.3 m/s with a 1.2 shear and a sway. `uFallRain` and `uFallSnow` accumulate `velocity × dt` and wrap each component into `[0, BOX_M)`, and the sway clock wraps at its period, so nothing outgrows a float however long it rains.
- **Intensity** is `precip × (0.6 + 0.4 × clamp(head.y / 800))` (`ELEVATION_GAIN`, `ELEVATION_TOP_M`): summits are stormier. A quad whose second pick is above the intensity is pushed behind the far plane in the vertex stage, and the mesh is hidden outright when the intensity is under 0.001.
- **Streaks and flakes.** A streak runs along `vel - uCamVel` as the eye sees it, `clamp(|relVel| × 0.03, 0.05, 0.8)` m long and `dist × 0.0044 + 0.004` m wide, so it is a pixel or two at any range; a flake is an upright square of `max(0.05, dist × 0.011)` so the far half of the box is not empty. `uCamVel` is her head's velocity smoothed at 6/s and zeroed for any frame above `TELEPORT_MPS = 30`, so a teleport is not a gust. Quads fade in over the first 0.7 m and out between 4.3 and 6 m, so nothing pops at the wrap plane.
- **Colour.** A drop is the fog colour, the air it falls through. A flake is `max(0.3, fog × 0.82)`: a shade under the sky so it reads against it, white against the ground, and floored at night so it is a speck and not a hole.
- `renderOrder 960`, after the dome at 950, `frustumCulled = false`. Not drawn while her eye is under a water surface (`main.js` passes its `submerged` to `Precip.update`, after `applySky` decides it for the frame). The debug row is `rain and snow`; `check-precip.mjs` gates the draw's shape, the intensity and snow numbers, three hours of fall staying in the box, and the teleport rule.

**Accumulation** is the follow-on that makes weather consequential rather than cosmetic: lerp the terrain's snow splat weight (§7) toward 1 on a slowly varying accumulation scalar, and swap prop geometry to `_Snow` variants above a threshold via `setGeometryIdAt`. Nearly free, and out of scope for the first build.

### Sound

`ambience.js` takes `cover` and `precip` from the clock's state each frame. `RULES.wind.cover = 0.6` raises the wind loop's floor by `cover × 0.6`, so a grey day sounds like one before it rains. `RULES.rain` holds a `rain` loop at `0.35 × rain`, where `rain = precip × (1 - smoothstep(-60, 60, aboveSnow))` is the share of the fall that is water: the same `SLEET_BAND_M` the particle draw crossfades over, so the loop follows the drops it hears, and snow is silent, since snow makes no such sound. The patter is the drops on the ground and the leaves, so `rain` is also thinned to nothing across `aloft = [2, 20]` metres of her head above the ground: standing she hears all of it, and flying above 20 m none. The hysteresis (0.02 on, 0.01 off) runs on `rain`, so climbing into the snow or the air stops the loop and coming back down starts it. The asset, `sounds/weather-rain-1.mp3`, is synthesised by `scripts/make-rain.mjs` (the library has no rain): a hiss band-passed 300 Hz to 2.5 kHz and held low, a rumble bed, and 138 drops a second in three tiers of damped sines with an onset click (90/s at 1.8-4.2 kHz, 40/s at 0.7-1.6 kHz, 8/s at 260-520 Hz), so the texture is pitter-patter with body rather than a hiss; 12 s looped by an equal-power crossfade, -12 dBFS peak where the library's loops sit. In a headset the sound is at least half of what makes rain rain. Gated in `check-ambience.mjs`, which also pins the band to the draw's.

### What it costs

The frame it lands on is already over budget: a Quest 2 at medium load measures 16.67 ms against 13.9 at 72 Hz (`_notes/local-shadows.md`), and the one calibration for fragment work is ~0.64 ms per full-screen texture fetch (`terrain-material.js`, with its caveat that fetch count alone does not predict cost). Weather is almost entirely fragment work, so it is priced that way. Hand counts, for ordering; the headset gives the values, and every phase lands with a debug-menu toggle so each row is an A/B against the frame-time readout.

| item | GPU, both eyes, worst case | notes |
| --- | --- | --- |
| channel, palette, fog | 0 | uniform arithmetic; two `noise1` calls of JS |
| dome drawn last | a saving | recovers the hidden-dome overdraw; measured alone |
| sky cloud layer | 0.3-0.7 ms | two fetches on visible sky only, given the reorder |
| clouds in the water reflection | +0.5-1.0 ms on a shore | ships off; A/B |
| wreaths | 0.1-0.5 ms | ~150 cards, one draw; bounded by the 500 m cull; the LRZ caveat above |
| precipitation | 0.1-0.3 ms while raining | 2000 quads in a 12 m box, each a pixel or two; `rain and snow` row |

All on, raining, on a lake shore, clouds not reflected: about 1.0-1.5 ms, offset partly or wholly by the dome reorder.

Nothing is baked at load. The cloud texture is an offline 256² PNG (256² of fBm in JS is 20-50 ms on the Quest 2 main thread) and the summit list is an offline JSON (a 1024² heightmap scan is 100 ms or more). No weather term does per-particle or per-instance work in JS per frame.

Fog **hides** far tiles but does not stop drawing them. The real saving under rain is a shorter draw distance, which is exactly when the GPU is busiest, and that is a change in the tile pool's visibility policy rather than in the fog. Deferred until the pool is read for it, and promoted ahead of the wreaths if the sky layer measures at the high end.

### Deferred

- Draw-distance coupling to `precip`, as above.
- Wet ground: one diffuse multiplier on the terrain under `precip`.
- Water in rain: roughen the reflection (dim `uReflTint`, soften the highlight) rather than simulate ripples; the water pixel is already the most expensive in the frame.
- Snow accumulation.

### Build order

All built. Each phase has its debug row and its node gate, and the headset A/B against the frame-time readout is the measurement still owed.

1. **The channel and the palette.** `cover` and `precip` in `state()`, the multipliers above, the `weather` row, and `check-weather.mjs`: continuity, the episode-length histogram, and cover 0 bit-identical to the prior palette at every elevation.
2. **The dome reorder**, then **the sky layer** in `sky-glsl.js` with the offline texture and the sun attenuated through it; the `sky clouds` row.
3. **Summit wreaths**, `wreaths.js`, `make-summits.mjs`, `make-cloud-cards.mjs`, `check-wreaths.mjs`; the `summit clouds` row.
4. **Precipitation and sound**, `precip.js`, `check-precip.mjs`, `make-rain.mjs`, the ambience rules; the `rain and snow` row.

---
