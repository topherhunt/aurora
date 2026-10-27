# §43 -- sealed remesh to LOD tiers

Ported from pocket-game (its `design/43-remesh.md`, where the findings below were made on its creatures). A generated mesh (Runware TRELLIS-2) arrives as a dense, leaky surface with baked colour and metal/rough maps. `tools/mesh/remesh.py` turns it into closed, evenly triangulated tiers at fixed triangle counts, and re-bakes the colour map from the dense original. `node tools/mesh/remesh.mjs <dense.glb> <out-dir> --tiers 500` runs it in Blender and writes `<out-dir>/<name>-<tris>.glb`.

**This is the decimator to reuse.** Several meshes look as good or better at 500 triangles than the source does, and none gains holes or bridges. Generated props and solid flora should go through it rather than growing their own; card foliage is the exception, as the seal would fill a crown of leaf cards into a blob. The items in `public/gen-props/items/` (design/42-valuables.md) ship its 500-triangle tier: concept art and Trellis meshes are made by pocket-game's `tools/concept/generate.mjs` and `tools/props/gen/batch-mesh.mjs` (manifest `aurora-items-mesh`), whose remesh phase runs this same script.

## Requirements

- **Sealed.** Every edge borders exactly two triangles. `main()` raises before writing a tier that has open or non-manifold edges.
- **Topology-preserving.** A tier may not cut a hole that the source lacks (a slice through a thin wing), nor bridge two surfaces that were apart (fused arms).
- **Volume-respecting.** Triangles stay roughly even in size.
- **Exact budget.** Each tier lands within 2% of its target.
- **Colour map only.** Baked from the dense mesh at `--tex` (default 512) and packed as WEBP. A normal map costs per-pixel shader work on Quest, so there is none; gloss is one flat roughness per creature (`tools/creatures/gloss.json`, applied by the rig kit, §44), and the tiers ship at roughness 1, metalness 0.

## Pipeline

1. **Import.** Join all parts and apply transforms.
2. **Raster seal** (`seal`, at each `--seal-res`, default 128, 96, 64, 48 cells on the longest axis, built lazily).
   - `solid_grid` samples the surface at half-cell spacing and rasterises it into a numpy shell grid.
   - *tight* = everything the outside flood from the grid border cannot reach.
   - *closed* = the same after a morphological close of `--close` voxels (default 2).
   - Of what the close adds, keep only the part that survives an opening of the same radius (*fat*). Solid = tight | fat.
   - `grid_mesh` emits the boundary quads of the solid. Blender's VOXEL remesh at twice the raster resolution smooths the steps. `drop_small_parts` removes fragments under 0.2% of the area. Finally, triangulate.
3. **Collapse each tier** (`remesh_tier`). Quadric COLLAPSE straight to the target, then shade smooth. A big collapsed face can tilt off the surface it replaces and light as a streak, even with the bake correct (human-man-b's brow-to-nose line vanished when rendered unlit). `--normals transfer` copies the dense mesh's normals onto every corner after the bake, so the tier shades like the source at no vertex cost: human-man-b's 2000 tier stayed at 1596 vertices, because the UV seams already split them. `weighted` (face area) only softened that streak, and `angle:N` turned it into a lit facet. The default stays `smooth`. `--focus z>0.85:4` spares a slab of the bbox (a person's head) by weighting its vertices 1/strength and the rest 1. Collapse never moves a weight-0 vertex, so the slab can't simply be left out of the group. Strength is not a density ratio. On human-man-b at 2000 tris, strengths 1.5, 2, 4 and 10 gave the top 15% 2.0, 2.6, 3.5 and 3.9 times its share of faces, and the tier reports the gain it reached as `focusGain`.
4. **Pick the seal per tier.** Try the seals finest first. Take the first whose collapse lands on target with no more than `--max-crossings` (2%) of its triangles in crossing face pairs. If none does, raise.
5. **Unwrap** (`unwrap`) with xatlas at `--tex`, with `--padding` 4 texels between charts. Install it once with `npm run mesh:pydeps`; this puts the wheel for Blender's Python 3.13 into the gitignored `tools/mesh/.pydeps`.
6. **Bake.** Cycles selected-to-active from the dense mesh: one EMIT pass of the base colour. Cage extrusion and max ray distance default to 0.03 and 0.08 of the longest side. `--cage` and `--ray` set them in metres. A ray longer than the gap between two dense surfaces bakes the far one's colour: on a 1.8 m person the default reaches from the chin into the throat. A short ray leaves black holes where the low surface sits far from the dense one (a flat chest). `--ray-far` adds a second, longer bake. A white hit-mask bake picks the short ray's colour wherever it hit and the far ray's elsewhere, and the tier reports `farShare`. On human-man-b, `--ray 0.012 --ray-far 0.06` took 14% of the texels from the far ray and left no holes.

Each run takes 8–30 s per creature for three tiers and peaks at 1.0–2.2 GB. Run it under the 4 GB RSS watchdog anyway, one creature per process.

## Why each step

- **The seal must be a raster, not a level set.** OpenVDB re-samples the surface. At a coarse voxel size, it drops a diagonal sheet thinner than a voxel wherever the sheet falls between samples (the horizontal stairstep slices through bladewing's wings), and it fuses limbs closer than a voxel (gravelfist's arms). A rasterised shell marks every voxel the surface passes through, so it cannot open a hole. OpenVDB runs only after that, at twice the raster resolution, where it has nothing thin left to lose.
- **Fat-cavity close.** Many TRELLIS bodies are a thick hollow shell whose cavity leaks to the outside. The outside flood fills the cavity, so the body stays hollow. A plain close shuts the leak, but it also webs every slit under 2×close voxels. A cavity is fat and survives an opening; a slit between limbs is thin and does not. On bladewing the close added 381k voxels and kept 367k (the body cavity). On gravelfist it added 24k and kept 766 (the arm slits stay open).
- **Collapse straight from the seal.** Collapse merges only vertices that an edge already joins, so it can neither bridge two surfaces nor open a hole. A second voxel pass at the tier's scale did both.
- **Why a ladder of seal resolutions.** Collapse must preserve every tunnel the seal has, real or not. Fine fur, spines and flowers rasterise at 128 as dozens of tiny tunnels: thistlehog's seal has genus 93 at 128, 36 at 96 and 3 at 64. Keeping them, collapse either stalls above target (618 triangles for a 500 target) or folds surfaces through each other. A coarser raster closes the noise tunnels, and also gaps narrower than its cell. So each tier takes the finest seal that collapses cleanly. Gravelfist (genus 6 at 128, against 5 real arm loops in a 256 seal) and bladewing stay at 128 for every tier. Thistlehog takes 64. Tuskbeetle takes 128 at 2000 triangles and 96 below. Rotcrown's toadstool forest still has genus 23 at 64, so its 500 tier needs the 48 rung (genus 8).
- **xatlas, not smart_project.** On these lumpy low-poly tiers, smart_project cuts 70–470 ragged islands, and they cover 19–45% of the image. xatlas grows 40–230 rounder charts and packs them by shape, covering 43–62%. That is why a 512 bake reads about the same as the old 1024 bake. Blender's concave packer applied to smart_project's islands adds only about 5 points. Letting xatlas accept more stretch (`max_cost`, `normal_deviation_weight`) plateaus at about 60%: what remains is padding and the gaps between curved charts.
- **Crossing face pairs** (`self_intersections`) count the BVH-overlapping triangles that share no vertex. This is a fold, which the sealed check cannot see. Clean tiers report 0–6.

## Rejected

- **QuadriFlow.** It rejects TRELLIS edges under 1e-4. With those dissolved it returns garbage (58 triangles, open edges). On voxel input it undershoots by about 2× and leaves open edges. It went past 4 GB on a 38k-face input, and a 558k-face attempt pushed the machine deep into swap.
- **Voxel remesh per tier (shape res 40–90), then collapse.** It cut the wing stairsteps and fused gravelfist's arms; see above.
- **Pure voxel remesh solved to the triangle target.** At 2000 triangles the resolution falls to about 18, and legs vanish.
- **Collapse on the unsealed or hollow mesh.** It stalls on the double wall and bridges gaps.
- **Inside test by ray parity or signed winding.** Hollow-shell walls alternate orientation, so both votes fail. The vote code was correct on a sphere.
- **Mesh-side hole fill** (`remove_doubles` + `holes_fill`). It leaves bladewing with 240 open and 457 non-manifold edges.
- **Separating tunnels from slits by voxel component size.** Thistlehog's coat region is one 65k-voxel component; gravelfist's largest slit is 2.9k. The sizes overlap with real anatomy.
- **Decimate vertex-group protection** around thin regions. Blender's collapse never touches unweighted vertices, so the tier stalls. Graded weights did not help.
- **An untangle pass** that pushes crossing faces apart along their normals. It diverged: crossings increased.

## Source density

Remesh from the dense TRELLIS output (`decimationTarget` 300k–500k), not the 20k variant. TRELLIS decimates before anything seals the mesh, and its 20k meshes have pits that bake as black speckles (gravelfist, tuskbeetle). The dense request costs about $0.01 more per creature. Thin feather gaps that the seal bridges bake as light streaks (bladewing); a denser source narrows them but does not remove them.
