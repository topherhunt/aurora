// ---------------------------------------------------------------------------
// Where a NEW control point goes when you split a spline.
//
// This is three-free and DOM-free on purpose. The rest of the operation --
// hit-testing the click, calling PathSet.insertPoint, re-anchoring the
// selection onto the handle it hands back -- needs a canvas and cannot be
// gated. The arithmetic can be, and it is the part that goes silently wrong:
// an off-by-one on `dir` splits the wrong segment, and averaging the widths of
// the wrong pair narrows a river at the point you asked to widen.
//
// TWO CASES, and only two:
//
//   between      There is a neighbour on the `dir` side, so the new point is
//                the MIDPOINT of the pair -- "split it into two different
//                equidistant points" -- and its width is their mean, so the
//                bank does not step where nothing was moved.
//
//   past the end There is no segment to halve. Rather than refuse, the line is
//                EXTENDED: half the last segment again, in the same direction.
//                Without it there is no way to lengthen a river once it has
//                been drawn, short of deleting it. Y comes from the GROUND and
//                not from continuing the slope, because an extension is a guess
//                about where the path goes next and a guess that follows the
//                terrain is one the author can leave alone. A slope continued
//                past the end of a river runs it into the sky.
//
// The degenerate case -- one live point, so no direction to extend along --
// steps sideways by four times the point's own width: far enough to grab, near
// enough not to fling the new point over the ridge behind it.
// ---------------------------------------------------------------------------

const SOLO_STEP_WIDTHS = 4

/**
 * @param points  live control points in CURVE ORDER, each [x, y, z, width].
 *                Tombstones must already be gone -- see PathSet.pointsOf.
 * @param at      index into `points` of the point being split from.
 * @param dir     -1 to split the segment before it, +1 the one after.
 * @param groundAt (x, z) => y, used only when extending past an end.
 * @returns [x, y, z, width] for the point to insert.
 */
export function splitPoint(points, at, dir, groundAt) {
  if (!Array.isArray(points) || points.length === 0) throw new Error('splitPoint: needs at least one control point')
  if (!Number.isInteger(at) || at < 0 || at >= points.length) throw new Error(`splitPoint: at ${at} out of range 0..${points.length - 1}`)
  if (dir !== 1 && dir !== -1) throw new Error(`splitPoint: dir must be +1 or -1, got ${dir}`)
  if (typeof groundAt !== 'function') throw new Error('splitPoint: groundAt(x, z) is required')

  const p = points[at]
  const nAt = at + dir
  if (nAt >= 0 && nAt < points.length) {
    const n = points[nAt]
    return [(p[0] + n[0]) / 2, (p[1] + n[1]) / 2, (p[2] + n[2]) / 2, (p[3] + n[3]) / 2]
  }

  // Past the end. The segment to mirror is the one on the OTHER side, which is
  // the one that reaches this end of the path.
  const backAt = at - dir
  const back = backAt >= 0 && backAt < points.length ? points[backAt] : null
  const dx = back === null ? p[3] * SOLO_STEP_WIDTHS : (p[0] - back[0]) / 2
  const dz = back === null ? 0 : (p[2] - back[2]) / 2
  const x = p[0] + dx
  const z = p[2] + dz
  return [x, groundAt(x, z), z, p[3]]
}
