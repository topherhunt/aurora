import THREE from '../three-instance.js'

// A lit torch held to a creature: `s` seconds of its tip within `reach` of the body's size across from its middle, and no higher over its feet than its size, costs it `hp` of its `max`. It pulses toward `red` `beats` times over `pulse` s, cries out and runs.
export const SINGE = { s: 1, hp: 10, max: 100, reach: 0.5, pulse: 1.2, beats: 3, red: [1.5, 0.12, 0.08] }
// A creature brought to 0 hp falls where it stands (one with no dead clip tipping onto its side over `tip` s), goes black over `dark` s and dissolves `lie` s after the fall, not to come again this session.
export const FELL = { tip: 0.5, dark: 1.5, lie: 3.5 }
// Her sword: its blade (main.js blades, points touches() takes as it takes a torch's tips) swung with an end past `mps` costs a creature SINGE.hp, one at most `every` s.
export const SWORD = { mps: 3, every: 1 }
// Her shield: a creature's blow from within `deg` of where it faces -- out from her head through it -- loses `off` of its hurt.
export const SHIELD = { deg: 60, off: 0.9 }
const RED = new THREE.Color(...SINGE.red)

/** Whether any of `tips` ({ x, y, z }) is in the body `size` m long standing at (x, y, z). */
export function touches(tips, x, y, z, size) {
  const r = SINGE.reach * size
  for (const t of tips) if (t.y >= y && t.y <= y + size && Math.hypot(t.x - x, t.z - z) <= r) return true
  return false
}

/** Whether the creature `key`, last cut at the time `cuts` keeps for it, may be cut again at `now`: if so the cut is kept. */
export function recut(cuts, key, now) {
  const at = cuts.get(key)
  if (at !== undefined && now - at < SWORD.every) return false
  cuts.set(key, now)
  return true
}

/** What of a blow from `from` gets past a shield at `shield` her head at `head` holds, each { x, z }. */
export function shielded(head, shield, from) {
  const sx = shield.x - head.x, sz = shield.z - head.z, fx = from.x - head.x, fz = from.z - head.z
  return sx * fx + sz * fz >= Math.cos((SHIELD.deg * Math.PI) / 180) * Math.hypot(sx, sz) * Math.hypot(fx, fz) ? 1 - SHIELD.off : 1
}

/** How far toward the red a body last hurt at `at` is at `now`, 0..1. */
export function redAt(at, now) {
  const t = now - at
  return t < 0 || t >= SINGE.pulse ? 0 : 0.5 - 0.5 * Math.cos((2 * Math.PI * SINGE.beats * t) / SINGE.pulse)
}

/** `color` drawn `u` of the way to the hurt red. */
export const reddened = (color, u) => color.lerp(RED, u)
