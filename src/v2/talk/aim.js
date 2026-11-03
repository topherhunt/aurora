// Whom her pointer picks out, for a hail by trigger or click. Pure, for check-talk.mjs.

export const AIM = {
  // Metres at her scale that the ray may pass from their axis, or above or below their body.
  side: 0.5,
  // The smallest horizontal part of the ray that still points at someone rather than straight up or down.
  flat: 0.1,
}

/** Of `people` ({ c: { pose: { x, y, z }, size } }, `pose` at the feet), the one the ray passes nearest within `reach` metres ahead, and `t` the metres along the ray to them; or null. `dir` is unit length. */
export function aimedAt(origin, dir, reach, scale, people) {
  const flat = Math.hypot(dir.x, dir.z)
  if (flat < AIM.flat) return null
  const fx = dir.x / flat, fz = dir.z / flat, slack = AIM.side * scale
  let best = null, bestSide = slack
  for (const person of people) {
    const dx = person.c.pose.x - origin.x, dz = person.c.pose.z - origin.z
    const ahead = dx * fx + dz * fz
    if (ahead <= 0 || Math.hypot(dx, dz) > reach) continue
    const t = ahead / flat, up = origin.y + dir.y * t - person.c.pose.y
    if (up < -slack || up > person.c.size + slack) continue
    const side = Math.abs(dx * fz - dz * fx)
    if (side < bestSide) { best = { person, t }; bestSide = side }
  }
  return best
}
