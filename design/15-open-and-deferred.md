## 15. Decisions deliberately deferred

> **Covers:** §15 deliberately deferred decisions and §16 open questions, with the answered ones struck through.
> **Read this when:** you are about to decide something that may already have been decided, or need the list of things only a headset can answer.

- `batched-mesh-extensions` -- offers BVH culling, LOD helpers, and per-instance uniforms. The per-instance uniform need is eliminated by §8's texture-sampling approach. It is a single-maintainer package sitting under a core system. Validate stock `BatchedMesh` first (§0); adopt only if culling or LOD bookkeeping measurably becomes the bottleneck.
- **A multiview spike, half a day, to settle whether stereo can cost one submission instead of two.** In XR three r180 renders an `ArrayCamera` by looping `renderScene` once per eye, so every draw call, every material bind and every uniform upload in the frame is paid twice; multiview (`OVR_multiview2`, or a WebXR projection layer with `textureType: 'texture-array'`) submits once into a 2-layer array texture and indexes the view matrix by `gl_ViewID_OVR`, which is where the "6 draw calls flat" ceiling in §0 would suddenly be twelve eyes' worth. **We believe Quest Browser's WebXR does not expose it and we have not actually checked** -- the recollection is of some other advanced feature being unsupported, so it is a guess and the spike exists to replace it with a reading. THE SPIKE: add a row beside the panel's existing `multiDraw` one (`main.js hasMultiDraw`, the same shape -- a device question answered on device and left visible) reporting `renderer.extensions.has('OVR_multiview2')` and whether `XRWebGLBinding.createProjectionLayer({ textureType: 'texture-array' })` throws inside a live session; read it in the headset. That is the whole spike, and it is the only part worth doing before the answer is known. IF IT READS YES, the adoption is NOT cheap and is a separate decision: `WebGLRenderer` has no multiview path at all (only the WebGPU build does), so it means patching or forking the renderer's XR loop, and every hand-written shader and every `onBeforeCompile` patch in the repo -- terrain, water, grass, trees, the dissolve, the cards -- needs `#extension GL_OVR_multiview2` and its view matrix indexed rather than uniform. Worth knowing the answer; not worth building on a guess (§27's cost paragraph is what makes the doubling expensive).
- **4096² global sim grid** -- only if stream density is unsatisfying at a low accumulation threshold, and only with the memory caveat in §2.
- **Per-chunk fine horizon maps** -- ship global-tier-only if too expensive (§8).
- **`gltfpack` + `EXT_meshopt_compression` on the creature GLBs** -- the one shipped animated creature (`ship-spider.mjs`) is 320 KB, 57% of it float32 clip samples at up to 67 fps and 20% JSON channel boilerplate; a villager with the 17-clip human library at the same encoding would be ~350 KB, ~4 MB across twelve. gltfpack quantizes mesh and animation (`-ar`/`-af`) and compresses both, typically 5-10x on clips, for one WASM decoder (`three/examples/jsm/libs/meshopt_decoder.module.js`) and a `setMeshoptDecoder` on the loader; it is also the compression step §9 still owes the props. Adopt when the first animated biped ships and run every creature GLB through it in one pass, rather than quantizing per shipper. Retargeting one shared human clip library across villagers is rejected, not deferred: the clips are solved per rig on purpose (§27).

## 16. Open questions

- ~~Does Quest Browser expose~~ `WEBGL_multi_draw`~~?~~ **Yes** (§0)
- Does Quest Browser's WebXR expose `OVR_multiview2` or a `texture-array` projection layer? Believed no, never actually read -- the spike is a panel row (§15)
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
