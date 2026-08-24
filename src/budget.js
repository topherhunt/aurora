// ---------------------------------------------------------------------------
// The performance budget, in one place so the game and the spike cannot drift.
//
// THE DEVICE IS QUEST 2. It is the planning target, the measurement target and
// the thing this gate is set against. There is no second device in this file:
// a higher quality tier for stronger headsets is a user-facing setting to be
// added later, and it would live here as a multiplier on these numbers rather
// than as a second set of them.
//
// ~350k triangles per frame is the working ceiling (DESIGN.md §0).
//
// ⚠️ THIS NUMBER IS DERIVED, NOT MEASURED. It is scaled from a reading taken on
// stronger hardware by the ratio of the two GPUs. Replace it the first time the
// §0 spike is run on the Quest 2 itself -- that is a half-hour job and it
// retires this warning.
//
// Compare against renderer.info AS REPORTED -- do not halve it for "per eye".
// Whether that counter double-counts stereo passes was never established
// on-device, and the number is only useful as something to check the HUD
// against, which requires both sides use the same convention.
//
// This exists because desktop lies (DESIGN.md §17): a monitor runs the scene at
// hundreds of fps and will happily report 3M triangles as "fine". The budget
// breach is the signal, not the framerate.
//
// INSTANCES ARE A BUDGET TOO, and they are not implied by the triangle count.
// BatchedMesh.onBeforeRender walks every visible instance every frame -- matrix
// read, bounding sphere transform, frustum test, then a sort of the survivors --
// which measured 37 ns each on desktop with sortObjects on. A 2-triangle
// billboard costs the same there as a 500-triangle tree, so a field of cheap
// cards can eat a whole frame while the triangle gauge reads 25%. Quest 2's JS
// is roughly 4x slower than the desktop that number came from, so the ceiling
// below is ~1.5 ms of desktop time and nothing like a hard device limit.
// Far card bands escape this entirely by living in tiled InstancedMeshes, which
// have no per-instance per-frame cost at all -- see DESIGN.md §5, "the
// BatchedMesh / InstancedMesh crossover". Only batched instances count here.
// ---------------------------------------------------------------------------

export const TRI_BUDGET = 350_000
export const CALL_BUDGET = 45
export const INSTANCE_BUDGET = 12_000

/**
 * `batchedInstances` is the count of visible instances across every
 * BatchedMesh in the scene -- the thing that pays the 37 ns. Pass it when the
 * caller knows it; omitted, the instance gauge is left off the line rather than
 * reported as zero, because a silent zero reads as "in budget".
 */
export function budgetLine(info, batchedInstances = null) {
  const triPct = Math.round((info.render.triangles / TRI_BUDGET) * 100)
  const instPct =
    batchedInstances === null ? null : Math.round((batchedInstances / INSTANCE_BUDGET) * 100)
  const over = triPct > 100 || info.render.calls > CALL_BUDGET || (instPct !== null && instPct > 100)
  const inst = instPct === null ? '' : `  inst ${instPct}%`
  return `${over ? '!!' : '++'} quest2 budget: tris ${triPct}%  calls ${
    info.render.calls
  }/${CALL_BUDGET}${inst}${over ? '  OVER' : ''}`
}
