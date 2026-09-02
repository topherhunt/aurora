import { clamp01, smoothstep } from '../../sim/mathx.js'
import { WORLD_HALF } from '../config.js'

// ---------------------------------------------------------------------------
// The terrain brush. §18's content layers are PARAMETRIC -- a lake is six
// numbers, a river is a spline -- and this one is not: it writes texels into the
// imported coarse field itself, and Save writes that field back to
// public/world/height.png.
//
// THAT IS A DELIBERATE EXCEPTION TO THE TWO-REPRESENTATION RULE, and it is worth
// stating why rather than discovering it later. Every other layer is stored
// parametrically because the parameters are what a human means: a lake IS an
// ellipse, and storing the ellipse is both smaller and more editable than
// storing the ground it displaces. A sculpt has no such form. "I pushed this
// ridge down and dragged that saddle across" is not a shape, it is a history,
// and a document that stored the history would replay a growing list of strokes
// on every worker at every boot -- unbounded work, in the one place (the coarse
// sample) that every vertex in the world already pays for. The image IS the
// compact representation of an arbitrary height edit; it is a fixed 1024x1024
// and it does not grow with how long you sculpt.
//
// The cost is that a sculpt is not undoable from layers.json and not diffable in
// git, which is why the editor keeps its own per-stroke undo in memory and why
// Save is explicit rather than autosaving.
//
// Three-free and node-runnable, like everything under src/v2/height/, so the
// brush kernel is gate-reachable -- see scripts/check-v2-sculpt.mjs. The parts
// that cannot be (pointer events, workers, the POST) live in edit/sculptor.js.
// ---------------------------------------------------------------------------

// raise/lower move ground by metres; smooth pulls it toward the local mean. They
// are listed rather than derived because the panel prints this array.
export const SCULPT_MODES = ['raise', 'lower', 'smooth']

// The smoothing stencil, in texels of radius. 1 is the 3x3 neighbourhood, which
// at 8 m/texel is a 24 m box -- one wavelength of the source's own quantisation
// staircase, which is the main thing anyone reaches for `smooth` to remove.
// Wider blurs faster but starts eating the ridge lines that make the import
// worth importing.
const SMOOTH_TAPS = 1

/**
 * BRUSH FALLOFF, and it is not a matter of taste.
 *
 * smoothstep from the rim inward: 0 at r = radius, 1 at the centre, with zero
 * DERIVATIVE at both ends. The derivative is the point. A brush with a hard rim
 * (linear falloff, or any cone) leaves a slope discontinuity in a circle around
 * every stamp, and the composed field is sampled down to 50 cm cells -- so
 * that circle is not a soft edge, it is a visible crease ring, one per stamp,
 * and a drag lays down sixty of them a second.
 *
 * Exported so the gate can assert the derivative rather than trust this comment.
 */
export const falloff = (r01) => smoothstep(1, 0, clamp01(r01))

/**
 * The texel rect a brush at world (x, z) with `radius` metres can touch,
 * clamped to the grid. Half-open in both axes: i0 <= i < i1.
 *
 * Returns null when the brush misses the grid entirely, which is a real case --
 * the world box is square and the import's mirror bands run off both Z edges, so
 * a stroke near a corner is routinely half outside.
 *
 * The +1 padding is for `smooth`, which reads one texel beyond every texel it
 * writes; raise and lower would be exact without it and are not harmed by it,
 * and one rect function that is right for all three modes is worth more than one
 * texel of extra remesh.
 */
export function brushRect(heightmap, x, z, radius) {
  if (!(radius > 0) || !Number.isFinite(radius)) throw new Error(`brushRect: radius must be a finite number of metres > 0, got ${radius}`)
  const u = (x + WORLD_HALF) / heightmap.texelSize
  const v = (z + WORLD_HALF) / heightmap.texelSize
  const ru = radius / heightmap.texelSize + SMOOTH_TAPS
  const i0 = Math.max(0, Math.ceil(u - ru))
  const j0 = Math.max(0, Math.ceil(v - ru))
  const i1 = Math.min(heightmap.width, Math.floor(u + ru) + 1)
  const j1 = Math.min(heightmap.height, Math.floor(v + ru) + 1)
  if (i1 <= i0 || j1 <= j0) return null
  return { i0, j0, i1, j1 }
}

// How far a moved texel reaches, in texels. Heightmap.sample is Catmull-Rom: a
// sample between texels i and i+1 reads i-1 through i+2, so texel t is visible
// to every sample within 2 texels of it. Remeshing only the texels themselves
// would leave a ring of ground two texels wide -- 16 m at the shipped grid --
// still meshed against heights that are no longer there, and the seam is exactly
// where the brush edge already draws the eye.
const STENCIL = 2

/**
 * The world box a texel rect can CHANGE, in the {minX, minZ, maxX, maxZ} shape
 * TerrainV2 takes for a dirty rect. Wider than the texels by the sampling
 * stencil above; that widening lives here, with the sampler it is a fact about,
 * rather than in the caller that happens to need it.
 */
export function rectToWorld(heightmap, rect) {
  const s = heightmap.texelSize
  return {
    minX: (rect.i0 - STENCIL) * s - WORLD_HALF,
    minZ: (rect.j0 - STENCIL) * s - WORLD_HALF,
    maxX: (rect.i1 - 1 + STENCIL) * s - WORLD_HALF,
    maxZ: (rect.j1 - 1 + STENCIL) * s - WORLD_HALF,
  }
}

/** The union of two texel rects; either may be null. */
export function unionRect(a, b) {
  if (!a) return b
  if (!b) return a
  return {
    i0: Math.min(a.i0, b.i0),
    j0: Math.min(a.j0, b.j0),
    i1: Math.max(a.i1, b.i1),
    j1: Math.max(a.j1, b.j1),
  }
}

/** Copy a texel rect out of the field, row-major and tightly packed. What the workers are sent and what undo holds. */
export function readRect(heightmap, rect) {
  const w = rect.i1 - rect.i0
  const out = new Float32Array(w * (rect.j1 - rect.j0))
  for (let j = rect.j0, o = 0; j < rect.j1; j++, o += w) {
    out.set(heightmap.field.subarray(j * heightmap.width + rect.i0, j * heightmap.width + rect.i1), o)
  }
  return out
}

/**
 * ONE STAMP. Mutates `heightmap.field` in place and returns what it touched:
 * `{rect, moved, clamped}` where `moved` is the largest absolute change in
 * metres and `clamped` counts texels that hit the encoding's ceiling or floor.
 * Returns null when the brush missed the grid.
 *
 * `amount` is metres for raise/lower and a 0..1 blend fraction for smooth. The
 * caller scales it by frame time -- see Sculptor.stroke -- so a 120 Hz machine
 * does not dig twice as fast as a 60 Hz one.
 *
 * CLAMPED TO THE ENCODING'S RANGE, not to the field's current extremes. The PNG
 * stores 16 bits over meta.minY..meta.maxY and there is nowhere to put a metre
 * above that: letting a stroke run past the ceiling would look correct on screen
 * until Save, then silently flatten the summit on reload. `clamped` is reported
 * so the editor can say so while it is happening.
 *
 * SMOOTH READS A SNAPSHOT. Blurring in place would make each texel's new value
 * an input to its neighbour's, which is not a blur -- it is a directional smear
 * that runs whichever way the loop does, and it shows up as a comet tail off
 * every smoothed hollow.
 */
export function stamp(heightmap, { x, z, radius, mode, amount }) {
  if (!SCULPT_MODES.includes(mode)) throw new Error(`sculpt: unknown mode '${mode}' (expected ${SCULPT_MODES.join(', ')})`)
  if (!Number.isFinite(amount)) throw new Error(`sculpt: amount must be finite, got ${amount}`)
  const rect = brushRect(heightmap, x, z, radius)
  if (!rect) return null

  const field = heightmap.field
  const width = heightmap.width
  const s = heightmap.texelSize
  const lo = heightmap.meta.minY
  const hi = heightmap.meta.maxY
  const before = mode === 'smooth' ? readRect(heightmap, rect) : null
  const rw = rect.i1 - rect.i0

  let moved = 0
  let clamped = 0
  for (let j = rect.j0; j < rect.j1; j++) {
    const wz = j * s - WORLD_HALF - z
    for (let i = rect.i0; i < rect.i1; i++) {
      const wx = i * s - WORLD_HALF - x
      const w = falloff(Math.hypot(wx, wz) / radius)
      if (w <= 0) continue

      const at = j * width + i
      const was = field[at]
      let want
      if (mode === 'smooth') {
        // The stencil is read from the FIELD, not from `before`, outside the
        // rect -- `before` only covers the rect, and the rect is padded by
        // SMOOTH_TAPS precisely so the ring it needs is inside it.
        let sum = 0
        let n = 0
        for (let dj = -SMOOTH_TAPS; dj <= SMOOTH_TAPS; dj++) {
          const jj = j + dj
          if (jj < rect.j0 || jj >= rect.j1) continue
          for (let di = -SMOOTH_TAPS; di <= SMOOTH_TAPS; di++) {
            const ii = i + di
            if (ii < rect.i0 || ii >= rect.i1) continue
            sum += before[(jj - rect.j0) * rw + (ii - rect.i0)]
            n++
          }
        }
        want = was + (sum / n - was) * clamp01(amount) * w
      } else {
        want = was + (mode === 'raise' ? amount : -amount) * w
      }

      if (want < lo) {
        want = lo
        clamped++
      } else if (want > hi) {
        want = hi
        clamped++
      }
      field[at] = want
      const d = Math.abs(want - was)
      if (d > moved) moved = d
    }
  }
  return { rect, moved, clamped }
}
