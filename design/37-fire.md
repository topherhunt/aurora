# 37 -- Fire: flint, sticks, flames and torches

Code: `src/v2/flint.js`, `src/v2/render/sticks.js`, `src/v2/render/wildfire.js`, the `hands.js` lit-item support, `src/lighting.js` torch light, the flame relay in `server/src/main.js` and `src/net.js`. Gates: `check-sticks`, `check-wildfire`, `check-flares`, `check-hands`, `check-hands-net`, `check-ambience`, `check-daynight`. Status: shipped, art pending (the flint and steel is a placeholder of boxes; `flint` is in the prop roster for a real pick).

## Input

Drop is the grip in the headset and `e` on the desktop (the physical key, so the Dvorak character 'e' still strafes). A trigger or a click never drops: with a thing in hand it stows over the backpack or does what the thing does (fire the gun, strike the flint).

## Flint and steel

It starts in the backpack. Held, the trigger or a click kicks it up in size like the flare gun, clicks (synthesised, `clickBuffer`), and strikes a spark `STRIKE` (8 cm) in front of it: a second `Flares` layer in spark mode, at 0.25 m, a random colour from orange to yellow, fading over 250 ms. Under water it only clicks. Below the snowline in rain it catches one time in five. Sparks are local: peers see the flames they light, not the sparks.

On the one-handed desktop a torch cannot be lit with a flint in one hand and a stick in the other, so a click with a stick in hand and the flint in the backpack strikes at the stick's tip.

## Sticks

`Sticks` scatters 0.5 m sticks at every elevation in cells of 4 m within 40 m, clumped, none in a village, none under a lake. A stick is a pure function of where it lies and the `taken` registry, so a picked stick stays gone and a peer's pick evicts it here. The mesh is nine sides, three crooked segments and jagged ends, textured with the interiors' plank grain along its length, the tip at -Z. `lies` makes `hands.js` drop it flat.

## Flames

`Wildfire` owns the flames and draws them, and the torches' flames, in one `Flames` call. What burns is asked of a `near` lookup (trees, ferns, ground sticks).

- A spark within `LIGHT_M` (0.3 m) of a flammable lights a flame there. It lives 5-10 s and dims over its last 1.5 s. The same object can be lit again.
- The third flame on one object makes every flame on it big, holds them to 20 s from then, and chars the object once (`Trees.char`, `Ferns.char` set the per-instance tint to soot). A tile that regrows forgets the char.
- Each second a flame has a 12% chance of lighting another flame on a flammable within 1 m.
- A flame is a function of where and when. The lighting machine sends `[id, room, x, y, z, lifeS]`; the relay keeps `FLAME_CAP` and forwards each once with its age; a peer burns its copy and never spreads it, so flames do not double.
- Every card that turns to face the player (flames, trees' cards, critters, gen-props, wreaths) turns toward the head, not the eye being drawn, through `src/head-eye.js`; `main.js` sets it once a frame. In a headset `cameraPosition` is per-eye, so a card turned toward it doubles up close. New billboard shaders take `HEAD_EYE_DECL` / `bindHeadEye` / `HEAD_EYE_GLSL`; `check-flames` and `check-shaders` pin it.
- The flame fragment shader is cheap on a tile GPU: it `discard`s an emptied fragment, runs the mask in `mediump` and keeps the clock and noise coordinates `highp`. The card hull is already near the tightest that never clips the noise, so it was left alone.
- The campfire loop (`RULES.blaze`) is one loop at the nearest flame. One flame in the hand is faint (level 0.0375); each flame in reach adds its share and the level grows with the square root of the sum, to 8x at a blaze of dozens.

## Torches

A held stick whose tip is within 15 cm of a spark is `rec.lit = true`, re-announced through `hands.rehold`; the flag replicates in the slot, so a peer sees the lit stick in the hand. It has one permanent flame at the tip and lights the world through `uTorch` (`TORCH_GLSL`): warm, flickering, fading out at 15 m, the four nearest torches. Stowing or submerging puts it out; dropped lit, it keeps burning. Torch light casts no shadow yet (a roadmap item). A torch's tip held within `TOUCH_M` (12 cm) of a tree, fern or ground stick for `IGNITE_S` (2 s) lights a flame on it exactly as a spark does, and again every 2 s it stays, so a torch left against a tree burns it big and black. The check runs at 10 Hz.

## Triangle flames (prototype)

`src/v2/render/fire-tris.js` (`TriFlames`) is the candidate replacement for the card flame: each flame is a cloud of opaque flat-coloured triangles that rise, tumble, shift yellow to red and shrink to nothing. No blend, no texture, no discard, so the cost is covered pixels plus the vertex shader, and early depth rejection stays on. Every shard is a pure function of the clock and a static per-vertex seed; the CPU writes only the instance matrices. Real 3D shards have per-eye parallax, so no billboard and no head-centre aiming.

LOD is four `InstancedMesh`es, level k holding the first `shards * lodKeep^k` shards of one master list (so a level is a subset of the one above), thinner levels drawn larger by `boost`. `update(t, glow, eye)` buckets flames by distance at `lodNear * lodStep^k`. Close flames use the same system at full count; there is no shader flame for them.

The bench is `/test-fire-tris.html` (`?preset=lamp|torch|campfire`, numeric query params override a knob): sliders for every `TRI_FIRE` knob, `lod` (-1 auto, 0-3 pinned), `lodTint` to colour the levels, and a copy button that emits the tuned `TRI_FIRE`. Gate: `check-fire-tris`. Not yet wired into `wildfire.js`, no LOD hysteresis, and nothing is measured on a Quest: tiny-triangle quad overhead and MSAA edge cost are the risks to check on-device.

## Night

The night rows of `clock.js` (-12 deg and below) carry a third of the additive glow, a fifth of the occlusion floor and about half the hemisphere light, so a shaded trunk can read pure black; ground the moon reaches is untouched. Lamp and window light is halved (`LAMP.gain`). The daynight gate now asks for a trunk that can go black and a floor of luma 4 on ground the moon misses.
