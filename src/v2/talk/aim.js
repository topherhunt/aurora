// Whom her pointer picks out, for a hail by trigger. Pure, for check-talk.mjs.

export const AIM = {
  // Metres at her scale that the ray may pass from their axis, and the largest |dir.y| that still points at someone.
  side: 0.5,
  steep: 0.7,
}

/** The one of `people` ({ c: { pose: { x, z } } }) the ray nearest passes within `reach` metres ahead, or null. `dir` is unit length. */
export function aimedAt(origin, dir, reach, scale, people) {
  if (Math.abs(dir.y) > AIM.steep) return null
  const flat = Math.hypot(dir.x, dir.z)
  const fx = dir.x / flat, fz = dir.z / flat
  let best = null, bestSide = AIM.side * scale
  for (const p of people) {
    const dx = p.c.pose.x - origin.x, dz = p.c.pose.z - origin.z
    const ahead = dx * fx + dz * fz
    if (ahead <= 0 || Math.hypot(dx, dz) > reach) continue
    const side = Math.abs(dx * fz - dz * fx)
    if (side < bestSide) { best = p; bestSide = side }
  }
  return best
}
