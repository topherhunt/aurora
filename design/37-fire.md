# 37 -- Fire: flint, sticks, flames and torches

Code: `src/v2/flint.js`, `src/v2/render/sticks.js`, `src/v2/render/wildfire.js`, the `hands.js` lit-item support, `src/lighting.js` torch light, the flame relay in `server/src/main.js` and `src/net.js`. Gates: `check-sticks`, `check-wildfire`, `check-flares`, `check-hands`, `check-hands-net`, `check-ambience`, `check-daynight`. Status: shipped, art pending (the flint and steel is a placeholder of boxes; `flint` is in the prop roster for a real pick).

## Input

Drop is the grip in the headset and `e` on the desktop (the physical key, so the Dvorak character 'e' still strafes). A trigger or a click never drops: with a thing in hand it stows over the backpack or does what the thing does (fire the gun, strike the flint).

## Flint and steel

It starts in the backpack. Held, the trigger or a click kicks it up in size like the flare gun, clicks (synthesised, `clickBuffer`), and strikes a spark `STRIKE` (8 cm) in front of it: a second `Flares` layer in spark mode, at 0.25 m, a random colour from orange to yellow, fading over 250 ms. Under water it only clicks. Below the snowline in rain it catches one time in five. Sparks are local: peers see the flames they light, not the sparks.

On the one-handed desktop a torch cannot be lit with a flint in one hand and a stick in the other, so a click with a stick in hand and the flint in the backpack strikes at the stick's tip.

## Sticks

`Sticks` scatters 0.5 m sticks in cells of 4 m within 10 m, 0.06 a square metre, only between half a stick and 3 m out from a trunk's bark (`Trees.pureTrunksInto`, so every peer agrees on ground none has grown), none in a village, none under a lake. A stick is a pure function of where it lies and the `taken` registry, so a picked stick stays gone and a peer's pick evicts it here. The mesh is nine sides, three crooked segments and jagged ends, textured with the interiors' plank grain along its length, the tip at -Z. `lies` makes `hands.js` drop it flat.

## Flames

`Wildfire` owns the flames and draws them, and the torches' flames, in one `TriFlames` draw. What burns is asked of a `near` lookup (trees, ferns, ground sticks).

- A spark within `LIGHT_M` (0.3 m) of a flammable lights a flame there. It lives 5-10 s and dims over its last 1.5 s.
- An object burns once: 10-20 s (`BURN_S`) from its first flame, which no flame on it outlives, and once out it never lights again this session. Without that, flames spreading back onto their own object kept it burning forever.
- The third flame on one object makes every flame on it big, holds them to its burn's end, and chars the object once (`Trees.char`, `Ferns.char` set the per-instance tint to soot). A tile that regrows forgets the char.
- Each second a flame has a 12% chance of lighting another flame on a flammable within 1 m.
- A flame is a function of where and when. The lighting machine sends `[id, room, x, y, z, lifeS]`; the relay keeps `FLAME_CAP` and forwards each once with its age; a peer burns its copy and never spreads it, so flames do not double.
- Every card that turns to face the player (trees' cards, critters, gen-props, wreaths) turns toward the head, not the eye being drawn, through `src/head-eye.js`; `main.js` sets it once a frame. In a headset `cameraPosition` is per-eye, so a card turned toward it doubles up close. New billboard shaders take `HEAD_EYE_DECL` / `bindHeadEye` / `HEAD_EYE_GLSL`; `check-flames` and `check-shaders` pin it.
- The campfire loop (`RULES.blaze`) is one loop at the nearest flame. One flame in the hand is faint (level 0.0375); each flame in reach adds its share and the level grows with the square root of the sum, to 8x at a blaze of dozens.

## Torches

A held stick whose tip is within 15 cm of a spark is `rec.lit = true`, re-announced through `hands.rehold`; the flag replicates in the slot, so a peer sees the lit stick in the hand. It has one permanent flame at the tip and lights the world through `uTorch` (`TORCH_GLSL`): warm, flickering, fading out at 15 m, the four nearest torches. Stowing or submerging puts it out; dropped lit, it keeps burning. Torch light casts no shadow yet (a roadmap item). A torch's tip held within `TOUCH_M` (12 cm) of a tree, fern or ground stick for `IGNITE_S` (2 s) lights a flame on it exactly as a spark does, and again every 2 s it stays, so a torch left against a tree burns it big and black. The check runs at 10 Hz.

## Flames drawn

`src/v2/render/fire-tris.js` (`TriFlames`) draws every flame in the world: the hearth's campfire (`TRI_CAMPFIRE`), the lamps (`TRI_LAMP`), wildfire's tree fires (`TRI_WILDFIRE`), the torches (`TRI_TORCH`, a draw of their own) and the house candles (`TRI_CANDLE`; `InteriorView` places one per candle at the room anchor plus the candle's local position and keeps the additive halo sprites behind them). The card shader in `fire.js` is now only the `/test-fire` bench's.

A flame is three nested flat cel silhouettes (red, orange, yellow; 16 outline points each, the inner ones stepped toward the head) whose tongues run up their edges while the tip jumps and the top sways, plus 24 two-triangle sparks rising off it: 96 triangles in two instanced draws sharing matrices and the per-instance `aFlame` (phase, flicker group). Opaque, one varying, no texture, no discard, so the cost is covered pixels plus the vertex shader and early depth rejection stays on. All motion is a pure function of the clock; the CPU writes a flame's matrix only in `place`. There is no LOD.

Both turn about Y toward the head (`HEAD_EYE_GLSL`, so the eyes agree) and pitch toward an eye above by `tilt` (0.5) of its elevation, about the flame's foot, as the tree and fern cards do; a candle looked down on shows its face, not a slice. The presets differ only in size, gain and `sparkSize` (2 for the torch, lamp and candle, 1 for the campfire and wildfire).

The bench is `/test-fire-looks.html` (`?view=tris&scale=campfire|lamp|candle`): the shipped flame beside the candidates it was chosen from (`src/fire-looks.js`, bench-only). Gate: `check-fire-tris`. Nothing is measured on a Quest yet.

## Night

The night rows of `clock.js` (-12 deg and below) carry a third of the additive glow, a fifth of the occlusion floor and about half the hemisphere light, so a shaded trunk can read pure black; ground the moon reaches is untouched. Lamp and window light is halved (`LAMP.gain`). The daynight gate now asks for a trunk that can go black and a floor of luma 4 on ground the moon misses.
