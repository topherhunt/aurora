// Town hearth light. Near, a hearth takes a torch slot (lighting.setTorches) and flickers; at any range its pool is also baked into each terrain vertex as `hearth` = index + amount, which the shader scales by uHearthFar[index] so the stored glow can be dimmed per town as that town's live slot fades in.
export const HEARTH_LIGHT = {
  on: 30, // a hearth closer than this to her head takes a torch slot
  fade: 6, // over the last metres of `on`, the slot fades in and the stored glow out
  gain: 1.5,
  day: 0.5, // fraction of the night light kept at full day
  reach: 18,
  coarse: 1.5, // the baked reach widens to this many cells, or a coarse chunk's vertices all miss the pool
}
// uHearthFar's length, a multiple of 4 (packed as vec4s). Not TOWN.site.target: planTowns keeps every tile's best site before topping up to the target, so a world can hold more.
export const HEARTHS = 128

/** Whether any hearth's baked pool can reach the square [ox, ox+size] x [oz, oz+size], so a chunk far from every town skips the per-vertex search. */
export function hearthsReach(hearths, ox, oz, size, step) {
  const reach = Math.max(HEARTH_LIGHT.reach, HEARTH_LIGHT.coarse * step)
  return hearths.some((h) => h.x > ox - reach && h.x < ox + size + reach && h.z > oz - reach && h.z < oz + size + reach)
}

/** The baked `hearth` value at a vertex: the strongest hearth's index plus its k² (kept under 1 so the index survives), or 0. */
export function hearthGlowAt(hearths, x, y, z, step) {
  const reach = Math.max(HEARTH_LIGHT.reach, HEARTH_LIGHT.coarse * step)
  let best = 0, bestK = 0
  for (let i = 0; i < hearths.length; i++) {
    const h = hearths[i]
    const k = 1 - Math.hypot(x - h.x, y - h.y, z - h.z) / reach
    if (k > bestK) { bestK = k; best = i }
  }
  return bestK > 0 ? best + Math.min(bestK * bestK, 0.999) : 0
}

// A labyrinth's gate torches and beacon ride the same attribute as minus their k², so they need no index: the shader scales that by uLabyrinthGlow and drops it over the labyrinths whose torches are live (render/palisades.js, uLabyrinthLive). The reach is a gate torch's live one, palisades.js GATE_LIGHT of lighting.js TORCH_REACH.
export const LABYRINTH_GLOW = { reach: 7.5, gain: 1 }
export const LABYRINTHS_LIVE = 3

/** The gate torches and beacons, flat [x, z, ...], of every labyrinth whose baked pool can reach the square; `labyrinths` is the biome's, or null. */
export function labyrinthTorchesNear(labyrinths, ox, oz, size, step) {
  const out = []
  if (labyrinths === null) return out
  const reach = Math.max(LABYRINTH_GLOW.reach, HEARTH_LIGHT.coarse * step)
  for (const s of labyrinths.sitesIn(ox - reach, oz - reach, ox + size + reach, oz + size + reach)) {
    const m = labyrinths.mazeOf(s)
    for (const [x, z] of m.torches) out.push(x, z)
    out.push(m.beacon[0], m.beacon[1])
  }
  return out
}

/** The nearest of `torches`' (labyrinthTorchesNear) k² at (x, z), kept under 1, or 0. */
export function labyrinthGlowAt(torches, x, z, step) {
  const reach = Math.max(LABYRINTH_GLOW.reach, HEARTH_LIGHT.coarse * step)
  let best = 0
  for (let i = 0; i < torches.length; i += 2) best = Math.max(best, 1 - Math.hypot(x - torches[i], z - torches[i + 1]) / reach)
  return Math.min(best * best, 0.999)
}
