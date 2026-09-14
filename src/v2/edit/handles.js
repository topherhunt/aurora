// ---------------------------------------------------------------------------
// Re-resolving a point selection across a structural edit.
//
// THE BUG THIS EXISTS TO PREVENT is an editor that treats an index as an
// identity across an edit that renumbers the list: delete point 2 of a six-point
// river while point 4 is selected, and if the list compacted, the selection now
// names what used to be point 5 -- the gizmo attached to the wrong handle, the
// next drag editing something the author was not looking at, and nothing
// anywhere reporting an error.
//
// BOTH POINT-HOLDING LAYERS NOW TOMBSTONE rather than compact, for exactly this
// reason: SnowField.removePoint nulls the slot (snowline.js), and so does
// PathSet.removePoint (paths.js, "Tombstones the point rather than splicing it
// out, so every OTHER handle into this path still addresses the point it
// addressed before"). They did not always agree, and the shape of that
// disagreement is why this file exists.
//
// It stays because the convention is not the whole story. PathSet.insertPoint
// into the MIDDLE still shifts everything after it -- unavoidably, since a
// path's points are ordered and the order IS the curve -- and it returns the new
// index precisely because a caller has to re-anchor. Re-resolving by position is
// correct under tombstones, correct under compaction, and correct across an
// insert, so the editor does not have to know which of the three it just did.
//
// EPS is 1 mm. Positions are metres and every path here is a copy of a number
// that was never arithmetic'd, so an exact match would work; 1 mm costs nothing
// and survives a round trip through JSON.stringify at 17 significant digits or
// a layer that normalises a coordinate on the way in.
// ---------------------------------------------------------------------------

const EPS = 1e-3

/**
 * Find the index in `list` whose position is `want`, skipping null holes.
 *
 * `posOf(entry)` returns `{x, z}` -- Y is deliberately not compared: a snow
 * point has no elevation of its own and a path point's Y can legitimately be
 * rewritten by the same edit that moved its neighbours. Two control points of
 * one spline sharing an XZ to the millimetre is a degenerate path, not a
 * selection this has to disambiguate.
 *
 * Returns the index, or null when the point that was selected is gone -- which
 * is the answer when the selected point is the one that was just deleted, and
 * the caller should fall back to selecting the object as a whole.
 */
export function rebindIndex(list, want, posOf) {
  if (want === null) return null
  let best = null
  let bestD = EPS
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    if (entry === null || entry === undefined) continue
    const p = posOf(entry)
    const d = Math.hypot(p.x - want.x, p.z - want.z)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** `[x, y, z, width]` control points, as stored on a road. */
export const pathPointPos = (p) => ({ x: p[0], z: p[2] })

/** `[x, z, width-or-null]` nodes, as stored on a river. */
export const riverPointPos = (p) => ({ x: p[0], z: p[1] })

/** `{x, z, delta, radius}` snow points, as SnowField holds them at runtime. */
export const snowPointPos = (p) => ({ x: p.x, z: p.z })
