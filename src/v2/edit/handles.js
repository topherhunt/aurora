// ---------------------------------------------------------------------------
// Re-resolving a point selection across a structural edit.
//
// THE BUG THIS EXISTS TO PREVENT, which is real and was found in the layer code
// rather than imagined: the two point-holding layers disagree about what happens
// to the indices above a removed point. SnowField.removePoint NULLS the slot
// (snowline.js says why: "the editor holds indices as selection handles and a
// splice would silently repoint every selection above the removed one"), while
// PathSet.removePoint SPLICES (paths.js:352). So an editor that caches
// {kind, id, index} is correct for snow and silently wrong for splines: delete
// point 2 of a six-point river while point 4 is selected and the selection now
// names what used to be point 5, with the gizmo attached to the wrong handle and
// nothing anywhere reporting an error.
//
// The fix is not to pick a side. It is to stop treating an index as an identity
// across an edit that can move it: remember WHERE the selected point was, redo
// the lookup afterwards, and take whichever index now holds that position. That
// is correct under nulling, correct under splicing, and stays correct if the two
// are made consistent later -- which is the point, because they are being made
// consistent by someone else while this is being written.
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

/** `[x, y, z, width]` control points, as stored on a river or a road. */
export const pathPointPos = (p) => ({ x: p[0], z: p[2] })

/** `{x, z, delta, radius}` snow points, as SnowField holds them at runtime. */
export const snowPointPos = (p) => ({ x: p.x, z: p.z })
