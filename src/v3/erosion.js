import { priorityFlood } from '../sim/hydrology.js'
import { NB_DI, NB_DJ, NB_DIST } from '../sim/world-grid.js'
import { mulberry32 } from '../sim/mathx.js'
import { BIOMES } from './biomes.js'

// ---------------------------------------------------------------------------
// Step D, first half -- rain. EROSION.droplets units of water are thrown at random over the land and each is walked downhill, cell to steepest cell, until it reaches the sea or runs out of steps, cutting a slight groove as it goes and dropping what it carries where it slows. The field is never routed for them: each droplet reads the slope under its own feet, so where many of them agree a valley forms and its tributaries branch off it on their own.
//
//   THE GROOVE. A droplet carries sediment up to a capacity that grows with the drop it just took, its speed and the water left in it. Under capacity it cuts the difference times EROSION.erode (times the biome's yield) out of the ground, never more than the drop itself so it can make no pit; over capacity it drops EROSION.deposit of the surplus. The cut is spread over a brush of EROSION.radius cells with a weight falling off from the centre, so a groove is a V cut into the slopes beside it and not a slot one texel wide; the deposit lands on the cell it stands on.
//   THE BOWL. A droplet that finds no downhill has run into a closed bowl. The water that gathers there stands at the level of the bowl's spill -- the lowest point on its rim -- and that is what the droplet flows on: a priority flood, re-run every EROSION.batch droplets, gives every ponded cell the level the water would rise to and the way to its spill, so a droplet crossing a bowl walks the flat to the rim and grooves the rim on its way down the far side, while the sediment it carried in settles on the bowl's floor, never over the water. The bowl drains as its outlet cuts, and fills as the floor rises: both are what a lake does with time. A pit made since the last flood, by a deposit, holds the droplet that meets it: it lays what it carries and is done.
//
// Heights are metres. Three-free and DOM-free like the rest of src/v3.
// ---------------------------------------------------------------------------

export const EROSION = {
  droplets: 300000,     // about one per land cell; the cut scales with it, and so does the time
  maxSteps: 2000,       // a droplet's life in cells walked; the summit is 300-odd cells from the sea
  batch: 30000,         // droplets between re-floods of the field
  capacity: 0.06,       // metres of sediment a droplet holds per metre of drop, per unit of speed and water
  minSlope: 0.05,       // metres: the drop the capacity is read from is at least this, so a droplet on a flat still holds a little
  erode: 0.05,          // share of the spare capacity cut per step
  deposit: 0.1,         // share of the surplus sediment dropped per step
  evaporate: 0.003,     // share of the water lost per step
  gravity: 2,           // speed^2 grows by this per metre of drop
  maxCut: 1,            // metres one droplet may cut in one step, whatever the cliff it fell down
  radius: 5,            // cells the cut spreads over either side of the droplet, weight 1 - d / (radius + 1): a groove 88 m wide at the ground, 3 made the trunks slots
  // Multipliers on the cut per class, by BIOMES id: how fast the ground yields.
  byBiome: { arctic: 0.6, forest: 1, plains: 1, jungle: 1.3, swamp: 0.3, canyon: 2.5, desert: 1.6 },
}

/**
 * `erode(elev, sea, ground, n, seed)` -> stats. Works on `elev` in place. `sea` marks the cells a droplet dies on, `ground` the class grid the cut is scaled by.
 */
export function erode(elev, sea, ground, n, seed) {
  const E = EROSION
  const size = n * n
  if (sea.length !== size || ground.length !== size) throw new Error(`erode: sea has ${sea.length} texels, ground ${ground.length}, the field ${size}`)
  const yield_ = BIOMES.map((b) => {
    const k = E.byBiome[b.id]
    if (!(k >= 0)) throw new Error(`erode: EROSION.byBiome has no ${b.id}`)
    return k
  })
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const land = []
  for (let c = 0; c < size; c++) if (!sea[c]) land.push(c)
  if (land.length === 0) throw new Error('erode: no land')

  // The brush: offsets and weights summing to one.
  const brush = []
  let wsum = 0
  for (let dj = -E.radius; dj <= E.radius; dj++) {
    for (let di = -E.radius; di <= E.radius; di++) {
      const d = Math.hypot(di, dj)
      if (d > E.radius) continue
      const w = 1 - d / (E.radius + 1)
      brush.push([di, dj, w])
      wsum += w
    }
  }
  for (const b of brush) b[2] /= wsum

  const before = Float32Array.from(elev)
  // `S` is the surface the droplets read: the water's where the ground is under it, the ground's elsewhere. `pond` marks the former; `tree` leads across a pond to its spill.
  let S
  let tree
  const pond = new Uint8Array(size)
  const flood = () => {
    const f = priorityFlood(elev, n)
    S = f.filled
    tree = f.tree
    for (let c = 0; c < size; c++) pond[c] = S[c] - elev[c] > 1e-3 ? 1 : 0
  }
  flood()

  let steps = 0
  let toSea = 0
  let offEdge = 0
  let ponded = 0
  let spent = 0
  let deepestStep = 0
  for (let d = 0; d < E.droplets; d++) {
    if (d > 0 && d % E.batch === 0) flood()
    let c = land[(rng() * land.length) | 0]
    let speed = 1
    let water = 1
    let sediment = 0
    let fate = 'spent'
    for (let step = 0; step < E.maxSteps; step++) {
      const ci = c % n
      const cj = (c / n) | 0
      const hc = S[c]
      // The steepest of the eight; on a flat, the flood's way to the spill.
      let next = -1
      let bestSlope = 0
      let edge = false
      for (let k = 0; k < 8; k++) {
        const ni = ci + NB_DI[k]
        const nj = cj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) {
          edge = true
          continue
        }
        const nn = nj * n + ni
        const s = (hc - S[nn]) / NB_DIST[k]
        if (s > bestSlope) {
          bestSlope = s
          next = nn
        }
      }
      if (next < 0) {
        if (pond[c]) next = tree[c]
        if (next < 0) {
          // A pit the last flood did not see, or the box edge: what it carries stays here.
          lay(c, sediment)
          fate = edge ? 'edge' : 'ponded'
          break
        }
      }
      if (sea[next]) {
        fate = 'sea'
        break
      }
      const dh = S[next] - hc
      const cap = Math.max(-dh, E.minSlope) * speed * water * E.capacity
      if (sediment > cap) {
        const drop = (sediment - cap) * E.deposit
        lay(c, drop)
        sediment -= drop
      } else {
        const cut = Math.min((cap - sediment) * E.erode * yield_[ground[c]], -dh, E.maxCut)
        if (cut > 0) {
          if (cut > deepestStep) deepestStep = cut
          for (let k = 0; k < brush.length; k++) {
            const b = brush[k]
            const bi = ci + b[0]
            const bj = cj + b[1]
            if (bi < 0 || bj < 0 || bi >= n || bj >= n) continue
            const bc = bj * n + bi
            elev[bc] -= cut * b[2]
            if (!pond[bc]) S[bc] = elev[bc]
          }
          sediment += cut
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * E.gravity))
      water *= 1 - E.evaporate
      c = next
      steps++
    }
    if (fate === 'sea') toSea++
    else if (fate === 'edge') offEdge++
    else if (fate === 'ponded') ponded++
    else spent++
  }

  /** Drop `amt` metres of sediment on cell c, never over the water standing on it. */
  function lay(c, amt) {
    if (amt <= 0) return
    if (pond[c]) elev[c] = Math.min(elev[c] + amt, S[c])
    else {
      elev[c] += amt
      S[c] = elev[c]
    }
  }

  let cutSum = 0
  let cutCells = 0
  let deepest = 0
  let fillSum = 0
  let fillCells = 0
  let highest = 0
  for (let c = 0; c < size; c++) {
    if (sea[c]) continue
    const d = before[c] - elev[c]
    if (d > 0.5) {
      cutSum += d
      cutCells++
      if (d > deepest) deepest = d
    } else if (d < -0.5) {
      fillSum -= d
      fillCells++
      if (-d > highest) highest = -d
    }
  }
  return { droplets: E.droplets, steps, meanSteps: steps / E.droplets, toSea, offEdge, ponded, spent, deepestStep, cutCells, cutMean: cutCells ? cutSum / cutCells : 0, deepest, fillCells, fillMean: fillCells ? fillSum / fillCells : 0, highest }
}
