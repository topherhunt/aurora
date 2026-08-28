# /questv3 performance observations (Quest 2, on-device)

Raw findings from manual panel-toggle testing in `/questv3`. Not yet gated by any check script -- this is a running log to steer what's worth optimizing before the real `/quest` content (real trees, real terrain) gets the same treatment.

## Instanced vs. individual matters enormously

8,192 tree billboards as individual meshes: ~5 FPS, effectively unusable. The same 8,192 as `InstancedMesh`: ~50 FPS, passable. This is the single biggest lever found so far -- confirms the CPU-side draw-call/object-churn theory from the code review, since geometry and fragment cost are identical between the two modes.

## Triangle count is not the bottleneck at this scale

8,192 billboard quads (2 tri each) + 512 individually-modeled trees + 512 boulders = ~60k triangles total, and it's workable at the FPS above. Vertex throughput isn't what's limiting this scene. Open question the user flagged: this is billboard geometry (2 tri, masked) -- unknown whether the same headroom holds for up-close trees with real triangle-heavy canopies instead of 2-tri cards.

## Masked alpha (alphaTest) costs less than expected

Toggling `masked` off saves only ~2 FPS at 8,192 instanced billboards. Alpha-test discard was expected to be a bigger chunk of the frame budget than this. Tentative read: the alpha-test instruction itself is cheap; if there's an overdraw cost here it's not dominated by the discard branch specifically.

## Lighting: real cost

Turning dynamic lighting on at this content volume: ~65 FPS -> ~53 FPS, about a 15 FPS hit. Expected and unsurprising -- this is the one toggle so far with a clearly attributable, non-trivial cost.

## Inward faces (DoubleSide) cost approximately nothing

Enabling inward-facing billboard sides visually doubles visible tree density (random Y-rotation means ~half of billboards face away from camera and were being backface-culled before), but produces no measurable FPS change.

Why this is plausible rather than surprising: backface culling is a fixed-function GPU stage that runs *before* rasterization/fragment shading -- it's essentially free either way, so switching it off was never going to show up as an added cost by itself. The actual cost of "more visible geometry" would have to come from the extra overdraw and alpha-test fragment work those newly-visible backs introduce -- and the masked-alpha finding above already showed that cost is small at this content density. The two observations are consistent, not contradictory: alpha-tested billboard fragments are just cheap here, whether you reach them via more visible instances (DoubleSide) or via disabling the discard (masked off).

## Terrain triangle cost is negligible

The procedural terrain mesh is ~4,000 triangles and produces no measurable FPS impact on its own.

## Known-broken, not yet testable here

- Sky/atmosphere system: not working in `/questv3`.
- Water/QMaps: doesn't render correctly in `/questv3` or `/quest`.

## Next test planned

Real (non-billboard, triangle-heavy) trees with masked alpha, up close -- to see whether the "masking is cheap" finding above still holds when the alpha-tested surface has real geometric complexity behind it rather than a flat 2-tri card.

`/quest` was rearchitected onto the same A-Frame bootstrap as `/questv3` (real tree-bank/rock-bank/texture-array/Sky content instead of questv3's simplified stand-ins, same richer panel) specifically so this next test can run there directly. Not yet verified on-device -- see the risk noted at the top of `src/quest-main.js`: its content modules import this project's own npm three.js (0.180.0), while A-Frame 1.5.0 bundles a much older one (~r150) -- a real, unconfirmed compatibility gap worth checking first if trees/rocks render wrong.
