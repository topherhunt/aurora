// ---------------------------------------------------------------------------
// The performance budget, in one place so the game and the spike cannot drift.
//
// Measured on Quest 3 (DESIGN.md §0): ~800k triangles per frame holds 72 Hz.
// 1.5M drops to 30-35 fps, and the cliff between them is steep.
//
// Compare against renderer.info AS REPORTED -- do not halve it for "per eye".
// Whether that counter double-counts stereo passes was never established
// on-device, and the number is only useful as something to check the HUD
// against, which requires both sides use the same convention.
//
// This exists because desktop lies (DESIGN.md §17): a monitor runs the scene at
// hundreds of fps and will happily report 3M triangles as "fine". The budget
// breach is the signal, not the framerate.
// ---------------------------------------------------------------------------

export const TRI_BUDGET = 800_000
export const CALL_BUDGET = 60

export function budgetLine(info) {
  const triPct = Math.round((info.render.triangles / TRI_BUDGET) * 100)
  const over = triPct > 100 || info.render.calls > CALL_BUDGET
  return `${over ? '!!' : '++'} quest budget: tris ${triPct}%  calls ${info.render.calls}/${CALL_BUDGET}${
    over ? '  OVER' : ''
  }`
}
