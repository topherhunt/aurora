import THREE from '../three-instance.js'

// A lit torch held to a creature: `s` seconds of its tip within `reach` of the body's size across from its middle, and no higher over its feet than its size, costs it `hp` of its `max`. It pulses toward `red` `beats` times over `pulse` s, cries out and runs.
export const SINGE = { s: 1, hp: 10, max: 100, reach: 0.5, pulse: 1.2, beats: 3, red: [1.5, 0.12, 0.08] }
const RED = new THREE.Color(...SINGE.red)

/** Whether any of `tips` ({ x, y, z }) is in the body `size` m long standing at (x, y, z). */
export function touches(tips, x, y, z, size) {
  const r = SINGE.reach * size
  for (const t of tips) if (t.y >= y && t.y <= y + size && Math.hypot(t.x - x, t.z - z) <= r) return true
  return false
}

/** How far toward the red a body last hurt at `at` is at `now`, 0..1. */
export function redAt(at, now) {
  const t = now - at
  return t < 0 || t >= SINGE.pulse ? 0 : 0.5 - 0.5 * Math.cos((2 * Math.PI * SINGE.beats * t) / SINGE.pulse)
}

/** `color` drawn `u` of the way to the hurt red. */
export const reddened = (color, u) => color.lerp(RED, u)
