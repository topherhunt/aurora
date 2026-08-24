# Lessons this project keeps re-learning

Cross-cutting failure modes, each one counted because each one recurred. **Read this before writing a check or diagnosing "it looks wrong".** Every entry here cost at least one wasted round somewhere in `design/`.

## Instruments drift out from under the thing they name

Thirteen instrument failures so far, and they are not exotic -- each one is a measurement that kept reporting a number after the thing it measured moved. The pattern is that a check keeps passing, so nothing draws attention to it.

- `check-sim.mjs` masked *nodes* while `player.js` tests *edges*: 71.8% reported against the player's true 92.5% on identical terrain.
- The probe's `TOTAL_RELIEF` read pre-`SHRINK` `TUNING` constants against post-shrink heights.
- `check-terrain.mjs` validated prop placement against a raw `maxElev` after the snow line became a field (`snowLineAt`) -- the tenth instance.
- `check-terrain.mjs` lost its exit code and printed failures while exiting 0.
- The reference render cropped at a fixed 6437 m when the comparison it exists for is *features per pixel*, not metres per pixel.
- The reachability gate floods over 16 m edges, so it could not see a 2 cm walkability bug and could not see the fix either. **Three orders of magnitude of disagreement between a gate and the thing it gates**, and it took a headset to notice.

**Rule:** when a constant moves, grep the scripts for it. When a gate and the runtime disagree about what they are measuring, the gate is the one that is wrong, and it will not tell you.

## A presence check cannot see a duplicate

The aurora shader failed to link for two rounds because `mScale` was declared twice in one scope. The gate asserting the feature was present passed -- **twice over, because of the bug**. Written as a count rather than a match it would have failed immediately.

Same shape elsewhere: a python slice silently deleted both `band({...})` rows from `flaming aurora` and every check still passed, because `[].every(...)` is vacuously true. Hence `minBands >= 1`.

**Rule:** assert counts and bounds, not existence. "At least one" is not a check.

## Shape complaints have to become numbers

"Too pointy", "too open", "flat", "wrinkled cloth", "molded clay", "it should snake" are all real observations and none of them is tunable. Every one of them had to be turned into a statistic first -- summit apex angle, area-weighted plain size, slope contrast ratio, lit:shaded luma, an S-count -- and in several cases the first three statistics chosen were the wrong ones. Measuring "an S" took four metrics and three wrong ones.

**Corollary:** the *magnitude of the right axis* is a separate question from the axis. Round three's aurora envelope, vortices and flaming form were all judged wrong from inside the headset with the mechanism correct in every case.

## Anything periodic in height is a terrace generator

Four separate paths to the same staircase: doubled frequencies at held relief, the terrace layer itself, `terraceStrength` interacting with the scarp knee, and the Worley cliff gate. A riser is ~1.24x the local slope, so on ground already at 33-41 degrees any periodic band crosses the walkable threshold on its risers but not its treads.

**Rule:** before adding a height-domain periodic term, work out what its riser angle is on the steepest ground it will touch.

## No metric can distinguish one legible ledge from six illegible ones

Percentile histograms of slope were green through several rounds that looked wrong. Hillshading is the primary character instrument, because **a crease is a discontinuity in the gradient and an elevation map does not show the gradient**. Four ways a height field looks wrong while measuring right -- domain-warp shear, fbm gain above 0.5, a hard clamp creasing along a level set, ridged noise making filaments -- were all found by rendering shaded, not by any statistic.

Scale matters too: at 1.5 m/px a 10 m hummock is seven pixels, which is a smudge whether it is a crisp scarp or a clay mound. Look at `hm-human-shaded` (0.29 m/px) for anything under ~20 m.

## The thing that looks at the mesh and the thing that ships the mesh must read the same data

The decimator leaves collapsed vertices in the mesh, so every measurement taken after it read the pre-decimation silhouette and the renormalisation pass ran as a no-op. Assets exported at the wrong size and it looked like a decimation artefact. `transform_apply` bakes an object's *local* basis only, so a mesh under a Megascans `world_root` empty shipped 100x too large and on its side while every in-Blender measurement read correct.

**Rule:** assert against the exported bytes, not against the in-tool state. All four silent pipeline bugs were one assertion each against the GLB.

## "Before X" means the last state that was seen, not the last commit before X

Rounds five and six of the aurora never linked, so nobody ever saw them; a revert request naming round five was really a request for the last state that had drawn a pixel. Tuning on top of a mesh nobody has looked at is work whose appearance is not in evidence.

**Corollary, from the same episode:** verify what a revert actually landed on. §13 recorded the target as "the commit before round five"; the tree is on round three. See `design/history/aurora-rounds-4-6.md`.

## The pattern is four for four on the wrong layer

Four operators were built to fix a walkability complaint that turned out to be a 46 cm feature and a 2 cm sampling window in `player.js`. *No amount of sculpting can make a 46 cm feature visible.* Three of the four failed operators did nothing; the fourth wrecked the cliffs.

Same in lighting: the "flat night" fix was a ratio, not a level, and the gate's own `worstGround >= 12` floor was actively enforcing the flatness -- the only way to meet a floor on the shaded side is to raise ambient, which flattens the ratio further.

**Rule:** before building an operator, find the smallest feature the complaint could be about and check whether the layer you are about to edit can even represent it.

## Fog multiplies, it does not reduce contrast

Applied after lighting, fog is a lerp toward a constant. A density that erases a ridge at 600 m erases it however well that ridge is lit. Contrast falloff with distance is a *lighting* job (`farDirect`/`farAmbient`); haze is fog's. See `design/history/night-fog.md`.

## Small, cheap, and true

- A GLSL comment inside a JS template literal must not contain a backtick. Five did, and the `SyntaxError` pointed 100 lines away.
- `fillText` does not complain when it draws off the panel; HUD labels have to budget their own width.
- A "rarest" form with too high a gate on too long a period draws **zero** frames in a simulated fortnight. Rare has to be measured at a sample count where the number means something.
- Debug it with a 2D map view before it renders in 3D: 42 green checks passed over a river network made entirely of straight 45-degree segments (a `sum` where a `max` belonged). No invariant over a height field can express "these are not rivers".
