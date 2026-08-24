## 15. Decisions deliberately deferred

> **Covers:** §15 deliberately deferred decisions and §16 open questions, with the answered ones struck through.
> **Read this when:** you are about to decide something that may already have been decided, or need the list of things only a headset can answer.

- `batched-mesh-extensions` -- offers BVH culling, LOD helpers, and per-instance uniforms. The per-instance uniform need is eliminated by §8's texture-sampling approach. It is a single-maintainer package sitting under a core system. Validate stock `BatchedMesh` first (§0); adopt only if culling or LOD bookkeeping measurably becomes the bottleneck.
- **4096² global sim grid** -- only if stream density is unsatisfying at a low accumulation threshold, and only with the memory caveat in §2.
- **Per-chunk fine horizon maps** -- ship global-tier-only if too expensive (§8).

## 16. Open questions

- ~~Does Quest Browser expose~~ `WEBGL_multi_draw`~~?~~ **Yes** (§0)
- ~~What are the real draw call and triangle ceilings?~~ **6 draw calls flat**; the triangle ceiling still needs a Quest 2 reading -- ~350k is derived (§0)
- ~~Is 64×64 the right base texture size?~~ **No -- 128×128, in two arrays** (§9)
- Is 60° the right snap angle, or does it want to be 45°? (§12 -- try it)
- ~~Is ~2.75° of terrain LOD error acceptable on ridgelines?~~ **It can go the other way: 3.58° at** `splitK` **1.0 is fine and chunky-at-distance is acceptable** (§5)
- **Is a 2.2° triangle cap acceptable on ridgelines?** The Quest 2 retarget needs it -- 1.2° draws 237k, 68% of the frame, for ground alone -- and it is 1.8x the horizon triangle size the world ships with today. This is the one number that has to be judged in a headset, and it is what `check-sim.mjs`'s terrain-share gate currently fails on (§5)
- Does the coarse ancestor poke through finer chunks while a new LOD ring streams in? (§5 -- expected artifact, needs eyes on it)
- Is 2048² adequate for global hydrology at 16 km? (§2)
- Does snow particle overdraw fit the fill-rate budget? (§10)
- What is Quest's real `MAX_ARRAY_TEXTURE_LAYERS`? (§0 prints it; §9 now needs ~150, not ~12)
- Does `KTX2Loader` round-trip array textures? (§9 -- now load-bearing at 128×128)
- Where does the frametime cliff sit once terrain, water, and weather share the budget? (§17 -- re-measure at each gate)

---
