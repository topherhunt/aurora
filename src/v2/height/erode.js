// ---------------------------------------------------------------------------
// THERMAL EROSION -- talus-angle relaxation over the imported coarse field.
// Opt-in; `erode = 0` means this file is never entered.
//
// Three-free and node-runnable.
//
// WHAT IT DOES AND WHY IT MAKES GROUND SHARPER RATHER THAN SMOOTHER, which is
// the counter-intuitive part. Every other pass over a heightmap that moves
// material around is a low-pass filter and rounds things off. This one has a
// DEAD BAND: material only moves where the local drop exceeds the repose angle,
// and where it does move, it moves until the drop is exactly the repose angle
// and then stops. Ground below the angle is untouched at any number of passes.
//
// The consequence is that the surface converges toward a union of PLANES all
// standing at the same angle, and planes at the same angle meeting each other
// meet in an EDGE. That is what a scree slope under a crag looks like, and it is
// why the operator is worth having: a low-pass filter cannot produce a crease
// anywhere, and a fractal produces creases with no relationship to the shape
// they are cutting. This produces them along the intersections of the landform's
// own faces.
//
// IT IS MASS-CONSERVING, so it lowers summits and fills hollows. That is not a
// side effect to be corrected -- it is the reason the faces become planar -- but
// it does mean a large number of passes visibly reduces the relief, and the
// summit it takes 3 m off is the one whose silhouette you were trying to sharpen.
// Twenty passes on the shipped 8 m/texel field is where the faces have formed
// and the range has not yet noticeably sagged.
//
// WHY IT LIVES ON THE FIELD RATHER THAN IN scripts/make-heightmap.mjs. An
// offline bake would be free at runtime and would be the right answer if the
// angle were settled. It is not settled -- it is the knob with the largest
// effect on character in the whole relief set -- and an offline pass cannot be
// A/B'd against the world it changed. It runs at load, on every thread, and it
// is the most expensive knob in the relief set by a wide margin: measured, a
// full 1024^2 field at twenty passes takes `new V2Height(...)` from 55 ms to
// 241 ms, so the relaxation itself is about 190 ms. Every other relief knob
// rebuilds in 55-65 ms. That is roughly four times a plain rebuild and still
// only a fifth of a second -- and the three threads each run it on their own
// copy at the same time, so the wall-clock is the slowest of the three rather
// than their sum.
// ---------------------------------------------------------------------------

// Fraction of the excess drop moved per pass. 0.5 is the standard value and it
// is a stability bound as much as a rate: the move is further halved between the
// giving texel and the receiving ones, so a pass can never overshoot the repose
// angle and start oscillating, which shows up as a checkerboard rather than as
// an obvious failure.
export const ERODE_AMOUNT = 0.5

/**
 * Relax `src` toward the repose angle, in place on a COPY.
 *
 * `rect` (texel indices, half-open, as sculpt.js produces) restricts the work to
 * a region -- the sculpt path, where re-eroding a million texels per brush tick
 * is not available. Material moves at most one texel per pass, so the region is
 * grown by `passes + 1` texels and the result inside the original rect is then
 * identical to what a full-field run would have produced there.
 *
 * Returns a NEW Float32Array. The caller keeps the import intact, because the
 * knob has to be reversible and because the sculpt brush and the PNG writer both
 * still have to be talking about the field the human authored.
 */
export function thermalErode(src, width, height, texelSize, { passes, talusDeg, amount = ERODE_AMOUNT, rect = null }) {
  if (!(src instanceof Float32Array)) throw new Error('thermalErode: src must be the Float32Array of metres from Heightmap.field')
  if (src.length !== width * height) throw new Error(`thermalErode: src has ${src.length} texels, ${width}x${height} needs ${width * height}`)
  if (!Number.isInteger(passes) || passes < 0) throw new Error(`thermalErode: passes must be a non-negative integer, got ${passes}`)
  if (!Number.isFinite(talusDeg) || !(talusDeg > 0) || !(talusDeg < 90)) throw new Error(`thermalErode: talusDeg must be in (0, 90), got ${talusDeg}`)
  if (!(texelSize > 0)) throw new Error(`thermalErode: texelSize must be metres > 0, got ${texelSize}`)

  const f = Float32Array.from(src)
  if (passes === 0) return f

  // The eight-neighbour stencil. Four would be cheaper and is what most
  // published versions use; it also aligns every talus facet to the texel grid,
  // so the mountains grow flats facing exactly N/S/E/W. At 8 m texels under a
  // 24 m crag band that grid is well inside what the eye picks up as a pattern.
  const w = width
  const di = [-1, 1, 0, 0, -1, 1, -1, 1]
  const dj = [0, 0, -1, 1, -1, -1, 1, 1]
  const off = new Int32Array(8)
  const talusH = new Float64Array(8)
  const diag = Math.SQRT2
  const tanT = Math.tan((talusDeg * Math.PI) / 180)
  for (let k = 0; k < 8; k++) {
    off[k] = dj[k] * w + di[k]
    const dist = k < 4 ? texelSize : texelSize * diag
    talusH[k] = tanT * dist
  }

  // Border texels are never updated, so the world edge keeps the import's own
  // values and no stencil ever needs a clamp inside the hot loop.
  const grow = passes + 1
  let i0 = 1
  let j0 = 1
  let i1 = width - 1
  let j1 = height - 1
  if (rect) {
    i0 = Math.max(1, rect.i0 - grow)
    j0 = Math.max(1, rect.j0 - grow)
    i1 = Math.min(width - 1, rect.i1 + grow)
    j1 = Math.min(height - 1, rect.j1 + grow)
    if (i1 <= i0 || j1 <= j0) return f
  }

  // Deltas rather than a second field: the update scatters to neighbours, so a
  // straight double-buffer would need the outflow of every neighbour recomputed
  // to gather it back, which is eight times the work for the same answer.
  // Accumulating into a zeroed delta buffer keeps the pass order-independent --
  // every texel reads the same generation -- at one extra memset.
  const delta = new Float32Array(src.length)
  const excess = new Float64Array(8)

  // The clear is restricted to the region the scatter can reach -- the worked
  // rect grown by one, since a texel only ever writes to its own neighbours.
  // delta.fill(0) over the whole million would cost more per pass than the
  // erosion itself on a brush-sized rect, and the sculpt path runs this on every
  // tick of a drag.
  const ci0 = Math.max(0, i0 - 1)
  const ci1 = Math.min(width, i1 + 1)
  const cj0 = Math.max(0, j0 - 1)
  const cj1 = Math.min(height, j1 + 1)

  for (let pass = 0; pass < passes; pass++) {
    for (let j = cj0; j < cj1; j++) delta.fill(0, j * w + ci0, j * w + ci1)
    for (let j = j0; j < j1; j++) {
      const row = j * w
      for (let i = i0; i < i1; i++) {
        const idx = row + i
        const h = f[idx]
        let total = 0
        let worst = 0
        for (let k = 0; k < 8; k++) {
          const d = h - f[idx + off[k]] - talusH[k]
          if (d > 0) {
            excess[k] = d
            total += d
            if (d > worst) worst = d
          } else {
            excess[k] = 0
          }
        }
        if (total <= 0) continue
        // Move a fraction of the STEEPEST excess, shared out in proportion to
        // each neighbour's own. Keying the amount on the worst drop rather than
        // on the sum is what makes a texel with one cliff below it shed as fast
        // as a texel with eight -- otherwise an isolated cliff edge, which is
        // exactly the feature this is meant to turn into a facet, erodes eight
        // times slower than a pit.
        const move = amount * worst * 0.5
        const share = move / total
        delta[idx] -= move
        for (let k = 0; k < 8; k++) {
          if (excess[k] > 0) delta[idx + off[k]] += excess[k] * share
        }
      }
    }
    for (let j = cj0; j < cj1; j++) {
      const row = j * w
      for (let i = ci0; i < ci1; i++) f[row + i] += delta[row + i]
    }
  }
  return f
}
