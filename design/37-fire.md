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
- The campfire loop (`RULES.blaze`) is one loop at the nearest flame, louder with more flames.

## Torches

A held stick whose tip is within 15 cm of a spark is `rec.lit = true`, re-announced through `hands.rehold`; the flag replicates in the slot, so a peer sees the lit stick in the hand. It has one permanent flame at the tip and lights the world through `uTorch` (`TORCH_GLSL`): warm, flickering, fading out at 15 m, the four nearest torches. Stowing or submerging puts it out; dropped lit, it keeps burning. Torch light casts no shadow yet (a roadmap item). A torch does not set flammables alight.

## Night

The night rows of `clock.js` (-12 deg and below) carry a third of the additive glow, a fifth of the occlusion floor and about half the hemisphere light, so a shaded trunk can read pure black; ground the moon reaches is untouched. Lamp and window light is halved (`LAMP.gain`). The daynight gate now asks for a trunk that can go black and a floor of luma 4 on ground the moon misses.
