## 17. Development workflow: desktop-first, headset-gated

> **Covers:** desktop-first development, the `npm run check` gate scripts, the headset-gate protocol, and the bench pages.
> **Read this when:** adding a check, adding a bench, or deciding whether something needs a headset before it counts as done.

**Iterate in Chrome on the desktop. Verify in the headset at gates.** Deploy-and-don-the-headset is a ~2 minute round trip against a ~2 second one, and most of this project's work -- procedural generation, placement aesthetics, LOD popping, terrain material, lighting, the aurora -- is judged with the eyes and reads fine on a monitor.

### What desktop tells you honestly

Silhouettes, colour, biome transitions, path layout, village siting, LOD pop distances, shadow softness, water shading, sky and aurora. Triangle counts and draw calls are also literally true -- they just need doubling to compare against a headset number.

### What desktop actively lies about

This list is why the gates exist, not a disclaimer:

| Lie | Why |
| --- | --- |
| **Fill rate** | Quest renders ~2× the pixels at a higher effective resolution and is fill-bound far more often than a desktop GPU. Alpha-tested foliage overdraw looks free on a monitor and is not |
| **Stereo cost** | Everything CPU-side and every draw call happens twice; there is no multiview in three.js (§5) |
| `discard` **cost** | The early-Z penalty from `alphaTest` is an Adreno tiler behaviour with no desktop analogue (§7) |
| **Thermals** | Minute 3 and minute 20 are different machines. Only a soak finds the cliff |
| **Foveation** | No desktop equivalent; it is real headroom that only appears on-device |
| **Scale and comfort** | Tree height, locomotion speed, snap-turn angle, gorge depth, vignette strength. **Not assessable on a monitor at all.** A mountain that reads as majestic on a screen can read as a hill in VR |

### Making the desktop HUD tell the truth

The §0 HUD stays on desktop and gets a budget line: **red past 350k triangles or 45 draw calls** (frame totals, matching the headset's `renderer.info`). Desktop then flags a budget breach the moment it happens, instead of hiding it behind a 200 fps monitor framerate. This converts most performance regressions into desktop-visible failures and shrinks what the gates have to catch to genuinely device-specific effects.

### Gates -- put on the headset when

1. A **new material or shader** enters the scene (fill-rate and `discard` behaviour are unmeasurable on desktop)
2. **Instance density or LOD distances** change materially
3. **Anything transparent or full-screen** is added -- snow particles, fog, aurora, vignette
4. Anything touching **locomotion, scale, or comfort** -- always, no exceptions, and judge by feel rather than by numbers
5. The end of **each §14 build step**, with a 20-minute soak at the last one before it gets handed over

A gate visit is a checklist, not a look-around: read frametime, worst-frame, draw calls, triangles, and the soak worst-case off the HUD, then toggle foveation to confirm the headroom is still there.

### The benches

`index.html` is the world: `/` is what a player and a headset get, and `/?editor` is the same world with the §18 authoring panel over it. **Every other `.html` at the repo root is a bench, and that is the whole registration.** `vite.config.js` reads the root directory for both the dev-server routes and the build's entry points, and Caddy's `try_files {path} {path}.html` does the same against `dist/` in production, so a new bench is live at `/<name>` the moment the file exists -- no config edit, no dev-server restart, no provisioning step. Delete the file and the route is gone the same way.

A bench exists when the thing it judges cannot be judged inside the world. For procedural content the "library" is the range the parameters cover, so the only way to see a generator is twenty seeds side by side; for a shader it is an empty sky and sixty sliders, which is not worth a terrain load and a walk to a vantage point every time you want to see what one exponent does.

| Route | What it answers |
| --- | --- |
| `/map` | The §14 step 3 Phase A map: the "eye" the tune-by-eye constants in `phase-a.js` refer to |
| `/props` | The same eye for the §9 asset library. With the dev server it can also show what went *in* -- see `propOriginals()` in `vite.config.js` |
| `/gen-fern`, `/gen-tree*` | The vegetation generators (§20). The tree ladder runs v1 through v4 |
| `/gen-grass` | The only generator that boots the REAL world -- `V2Height`, the layers document, `TerrainV2`'s quadtree -- because how fast density may fall off with distance, and whether opaque blades still read as grass on a hillside, in snow and from above, do not survive being asked on a flat test plane |
| `/gen-rock` | Narrower than the others: the tree and fern generators ship a settled bank, this one is still choosing which variants the world gets, and `PRESETS` in `src/gen-rock-main.js` is where that choice is written down (§23) |
| `/gen-deadwood` | The two props that are neither tree nor rock, a snag and a fallen log (§21); also where the moss and snow recipe on WOOD gets judged, since dead wood is the first thing in the world wearing both |
| `/gen-mushroom`, `/gen-crab`, `/gen-butterfly` | The three props whose texture is code rather than a photograph, so the bench is the only place the sheets can be looked at. The butterfly's reroll throws colour and size wide rather than picking from a fixed species table, because those are the point (§24) |
| `/gen-building` | §19. Its strength-0 mode is the straight control for judging the warped geometry |
| `/gen-anim`, `/gen-character`, `/gen-sheet` | `tools/characters/`: the shared procedural animation set, one character's bone placement, and the view sheet |
| `/gen-fish` | The fauna analogue of `/gen-sheet`, cut to one sideview per species (`tools/fauna/`) |
| `/gen-creature` | Candidate image to Tripo mesh to rig to animation (§27). With `/gen-tree-v9` and `/gen-prop` below, one of the three benches that spend money at a vendor other than OpenRouter, and both are useless from a build since every button needs the dev server's API keys |
| `/gen-tree-v9` | The same vendor bought for a tree instead of a creature (§28), and the only bench where the mesh arrives untextured on purpose: its faces are painted here with the world's own tiling textures, so Tripo's unwrap is discarded and its texture is not worth the 10 extra credits. Its prompt asks for a low-poly model of a tree rather than a photograph of one, because a photographed crown reconstructs as lollipops. With `/gen-prop`, one of the two benches that pick their image model |
| `/gen-prop` | `/gen-creature` with the rig and animation stages cut off (§29): candidate image to textured Tripo mesh to our LOD ladder and card cross, for stumps, logs, mushrooms, bones and cave mouths with a personality the procedural generators cannot give them. Its prompt asks for a stylised game asset resting flat on the floor, and its roster carries a size and a world category rather than a rig type |
| `/test-aurora` | The aurora shader lab (§13). The only page whose whole content is one quad, which is what makes it honest about the shader's cost -- see the header of `src/aurora-lab/glsl/frame.js` |
| `/poly-trace`, `/tileable`, `/chroma-key` | Image utilities, not generators: trace a polygon, make a texture wrap, key a colour out. No three.js and no dev-server endpoint, so unlike the benches above these work identically from a build |
| `/quest`, `/questv2`, `/questv3` | WebXR entry, still unproven on the test Quest 2. `questv2` is the minimum-complexity control -- no texture array, no baking, no image loads -- to isolate whether the boot hang is `/quest`'s texture pipeline or something more basic. `questv3` is A-Frame rather than Three.js, since A-Frame's own Hello World does enter VR on that headset |
