import { WORLD_SIZE, WORLD_HALF } from './terrain-height.js'

// ---------------------------------------------------------------------------
// The global sim grid (§2). Pure math, no three.js -- see the porting note in
// §1: everything in sim/ has to survive being lifted into Godot.
//
// 2048^2 over 16.384 km = 8.0 m/cell, and it is NEVER RENDERED. This grid
// decides *where water flows* and *where villages go*; the chunk heightmap
// decides *what the ground looks like*. §2 has a table for this specifically
// because conflating the two is the classic way to end up asking whether a 8 m
// cell means 8 m polygons. It does not.
//
// One float layer is 16.8 MB, and Phase A holds several at once plus
// priority-flood's working set. §2 budgets ~100 MB transient for the whole pass.
// ---------------------------------------------------------------------------

export const GRID_N = 2048
export const CELL = WORLD_SIZE / GRID_N

// Cell CENTRES, not corners. The distinction matters for the village sites and
// the stream centrelines that come out of this pass: those are world positions
// handed to other systems, and a half-cell bias is 4 m of drift that nothing
// downstream can detect.
export const gridX = (i) => -WORLD_HALF + (i + 0.5) * CELL
export const gridZ = (j) => -WORLD_HALF + (j + 0.5) * CELL

// Nearest cell to a world position, clamped. Clamped rather than wrapped or
// asserted because the caller is usually asking about the player, and she is
// held one chunk inside the world edge by player.js anyway.
export const cellI = (x) => {
  const i = Math.floor((x + WORLD_HALF) / CELL)
  return i < 0 ? 0 : i > GRID_N - 1 ? GRID_N - 1 : i
}
export const cellJ = cellI

// The 8-neighbourhood, as index offsets and the distance each one covers in
// cells. Kept in one place because flow routing, distance transforms and the
// connectivity fill all walk it, and a mismatched diagonal cost between them is
// a bug that produces plausible-looking wrong answers rather than a crash.
export const NB_DI = [1, 1, 0, -1, -1, -1, 0, 1]
export const NB_DJ = [0, 1, 1, 1, 0, -1, -1, -1]
export const NB_DIST = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2]

// Sample the analytic height field onto the grid.
//
// This is the single most expensive thing in Phase A -- 4.2M heightAt calls --
// and it is worth knowing that up front rather than discovering it as a mystery
// load hitch. It is also the only part of Phase A that touches TerrainHeight;
// everything downstream works on the returned array.
export function sampleElevation(th, n = GRID_N) {
  const cell = WORLD_SIZE / n
  const H = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    const z = -WORLD_HALF + (j + 0.5) * cell
    const row = j * n
    for (let i = 0; i < n; i++) {
      H[row + i] = th.heightAt(-WORLD_HALF + (i + 0.5) * cell, z)
    }
  }
  return H
}

// Steepest slope in radians, from the grid itself rather than from
// TerrainHeight.slopeAt. Deliberate: this measures the grade at the scale the
// grid actually resolves, which is the scale every decision made from it
// operates at. Asking slopeAt would report the 0.75 m grade at the cell centre,
// which is a different question and has bitten this project twice already --
// a single steep metre in the middle of a cell is not a reason to call the cell
// impassable.
export function gridSlope(H, i, j, n, cell) {
  const im = i > 0 ? i - 1 : i
  const ip = i < n - 1 ? i + 1 : i
  const jm = j > 0 ? j - 1 : j
  const jp = j < n - 1 ? j + 1 : j
  const dx = (H[j * n + ip] - H[j * n + im]) / ((ip - im) * cell)
  const dz = (H[jp * n + i] - H[jm * n + i]) / ((jp - jm) * cell)
  return Math.atan(Math.hypot(dx, dz))
}
