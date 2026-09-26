import { priorityFlood } from '../sim/hydrology.js'
import { NB_DI, NB_DJ, NB_DIST } from '../sim/world-grid.js'
import { mulberry32 } from '../sim/mathx.js'
import { Noise } from '../sim/noise.js'
import { BIOMES } from './biomes.js'

// ---------------------------------------------------------------------------
// Step D, first half -- rain. EROSION.dropletsPerKm2 units of water per square kilometre of land are thrown at random over the land and each is walked downhill until it reaches the sea or runs out of steps, cutting a slight groove as it goes and dropping what it carries where it slows. The field is never routed for them: each droplet reads the slope under its own feet, so where many of them agree a valley forms and its tributaries branch off it on their own.
//
//   THE DROPLET HAS A HEADING, and this is the whole of why the grooves curve. A walker that steps to the STEEPEST of eight neighbours can only ever draw one of eight headings, so its track is a ruled line or a zigzag between two ruled lines, and a valley gathered out of a thousand such tracks is a straightedge. This one carries a continuous unit HEADING that is turned toward the downhill gradient by `1 - inertia` each step and keeps `inertia` of where it was already going, and it steps to a lower neighbour that AGREES WITH THAT HEADING rather than to the lowest one (which of them, see THE DRAW). The eight cells are still all there is to step to, but which of them is taken is now decided by a quantity that varies smoothly, so a run of steps reads N, NNE, N, NNE as a curve where steepest descent would have locked onto one of them; and the droplet holds a bend past its apex instead of turning the instant the fall line does, which is what runs a river wide onto its outer bank.
//   THE SWIRL, because inertia alone still settles onto the fall line on an even slope. A slow, spatially coherent nudge -- one pair of noise fields at EROSION.swirlScale metres, baked once per run -- is added to the heading. Coherent is the operative word: a random per-step jitter averages out over a thousand droplets and leaves the groove exactly where it was, while a nudge that every droplet crossing the same hillside feels the SAME way bends all of their tracks together, so the groove itself is laid down curved and the river routed along it later inherits the curve. `swirl` is its size against the unit gradient, so 0.9 pulls a heading up to about 40 degrees off the fall line and wanders back over a couple of hundred metres. It is what bends a gorge, the one place the draw cannot help: once a channel is cut, its bed is so much lower than the cells beside it that the draw's weights collapse onto the bed and the walk is deterministic again, so a steep valley only meanders if it was laid down meandering.
//   THE DRAW, because a heading and a swirl together still cut straight gulches. Both of them are smooth in space, so on one hillside every droplet is turned the SAME way and takes the same one of the eight bearings; the track curves over a few hundred metres but is locally a ruled line, and a thousand of them stacked cut a straight slash a few texels wide. What breaks that is randomness per droplet, not per hillside. So the next cell is DRAWN rather than won: each lower neighbour gets a weight of its own slope times `stray` plus the heading's agreement with it, and the step is a roulette over those weights. On an even slope the fall line still takes about half the draws and its two flanking cells a quarter each, so the drift is downhill and along the heading exactly as before -- but no two droplets crossing that hillside walk the same cells, and the ensemble lays a groove with a width and a wander instead of a line.
//   IT NEVER STEPS UP, and everything here rests on it. The droplet's height falls on every step, which is what bounds the whole pass: a track cannot cycle, so it cannot dig the same cell twice, and there is no ping-pong between two cells cutting over an 81-cell brush and laying it back on one. A first draft let the heading carry the droplet onto a rise and fill it to cross -- it dug craters and stood spikes in them, 158 m of deposit where the old walk laid 2. So the draw only ever runs over the LOWER neighbours; where there are none, the droplet ponds.
//   THE GROOVE. A droplet carries sediment up to a capacity that grows with the drop it just took, its speed and the water left in it. Under capacity it cuts the difference times EROSION.erode (times the biome's yield) out of the ground, never more than the drop itself so it can make no pit; over capacity it drops EROSION.deposit of the surplus. The cut is spread over a brush of EROSION.radius cells with a weight falling off from the centre, so a groove is a V cut into the slopes beside it and not a slot one texel wide; the deposit lands on the cell it stands on.
//   THE BOWL. A droplet that finds no downhill at all has run into a closed bowl. The water that gathers there stands at the level of the bowl's spill -- the lowest point on its rim -- and that is what the droplet flows on: a priority flood, re-run every EROSION.batchShare of the run, gives every ponded cell the level the water would rise to and the way to its spill, so a droplet crossing a bowl walks the flat to the rim and grooves the rim on its way down the far side, while the sediment it carried in settles on the bowl's floor, never over the water. The bowl drains as its outlet cuts, and fills as the floor rises: both are what a lake does with time. Crossing a pond is the one place the walk is still discrete, cell to cell down the flood's tree. That is not where the straightness that survives lives, though: of the 400 m river reaches that still read as straight, none is on a lake and none on flat ground -- they sit on 25 deg at the median where the network sits on 18.6, in the cut gorges, where the draw's weights have collapsed onto a bed and only the swirl can bend anything.
//
// Heights are metres. Three-free and DOM-free like the rest of src/v3.
// ---------------------------------------------------------------------------

export const EROSION = {
  // THE RAIN IS A DENSITY AND A DISTANCE, NOT A COUNT AND A STEP COUNT. Both of the numbers that used to live here were tuned on an 8 m grid, and both are wrong on any other one: a fixed droplet count rains a quarter as hard per unit area on a grid with four times the cells, and a fixed step budget kills a droplet a quarter of the way to the sea. So they are stated in the units the landscape is in -- droplets per square kilometre of land, and metres a droplet may walk -- and `erode` turns them into counts once it knows the cell.
  dropletsPerKm2: 15400, // 300000 droplets over the 19.5 km2 the 8 m island calls land: about one per 8 m cell, which is the density the cut was tuned at
  maxWalkM: 6400,       // metres a droplet may walk before it is abandoned. The summit is 2.5 km from the sea and a droplet averages 2.5 km, so this is generous; what it cuts off is the tail that crawls a flat at a centimetre a step
  batchShare: 0.1,      // share of the run between re-floods of the field
  // THE DROPLET'S STATE IS KEPT IN REFERENCE-GRID UNITS, and `refCell` is what that means. Every rate below was fitted on an 8 m grid, and a droplet's sediment and cut are DEPTHS: the volume one step moves is the cut times the cell's own area, so on a 2 m grid the same cut moves a sixteenth of the earth, and the per-step drop the capacity is read from is itself a quarter as big. Run as written on a finer grid the rain stops carving -- measured, at 2 m: 1.7 m mean cut over 0.56 km2 where 8 m cuts 5.5 m over 10.1 km2. So the droplet is walked in the reference frame: the drop it reads is the drop the SAME SLOPE would give over an 8 m step, its rates are per 8 m of path rather than per step, and the depth it takes out of this grid is its reference depth scaled by the ratio of the two cells' areas. At cell = refCell every conversion is one and the field is the 8 m field to the bit.
  refCell: 8,           // metres a texel covered on the grid the rates below were fitted on
  capacity: 0.06,       // metres of sediment a droplet holds per metre of drop, per unit of speed and water. Reference frame.
  minSlope: 0.05,       // metres over one reference step (so a slope of 0.6%): the drop the capacity is read from is at least this, so a droplet on a flat still holds a little
  erode: 0.05,          // share of the spare capacity cut per reference step of path
  deposit: 0.1,         // share of the surplus sediment dropped per reference step of path
  evaporate: 0.003,     // share of the water lost per reference step of path
  gravity: 2,           // speed^2 grows by this per metre of drop. The one rate that needs no conversion: it is an energy and the fall is the fall however finely it is cut up
  maxCut: 1,            // reference metres one droplet may cut per reference step, whatever the cliff it fell down
  inertia: 0.6,         // share of the heading a droplet keeps each step. 0 turns to the fall line every step; near 1 it holds its heading until the ground makes it turn. See THE DROPLET HAS A HEADING.
  swirl: 0.9,           // the nudge's size against the unit gradient. See THE SWIRL.
  swirlScale: 260,      // metres over which the nudge turns, so the wavelength of the meander it puts in
  stray: 0.5,           // the pull a lower neighbour keeps on its slope alone, before the heading's agreement is added. 0 follows the heading absolutely and relocks to the lattice; large lets the ground carry the droplet anywhere downhill. See THE DRAW.
  radius: 5,            // CELLS the cut spreads over either side of the droplet, weight 1 - d / (radius + 1). In cells and not in metres on purpose: it is the narrowest groove the grid can hold without becoming a one-texel slot, so it tracks the grid down. At 8 m that is an 88 m trunk valley; at 2 m it is a 22 m one, which is the rivulet the finer grid is for.
  // Multipliers on the cut per class, by BIOMES id: how fast the ground yields.
  byBiome: { arctic: 0.6, forest: 1, plains: 1, jungle: 1.3, swamp: 0.3, canyon: 2.5, desert: 1.6 },
}

// The eight neighbours as unit headings, so the agreement test in the inner loop is two multiplies and no division.
const NB_UX = NB_DI.map((d, k) => d / NB_DIST[k])
const NB_UZ = NB_DJ.map((d, k) => d / NB_DIST[k])
const NB_INV = NB_DIST.map((d) => 1 / d)

/**
 * `erode(elev, sea, ground, n, cell, seed)` -> stats. Works on `elev` in place. `sea` marks the cells a droplet dies on, `ground` the class grid the cut is scaled by, `cell` the metres a texel covers -- which is what turns EROSION's densities and distances into a droplet count and a step budget.
 */
export function erode(elev, sea, ground, n, cell, seed) {
  const E = EROSION
  const size = n * n
  if (!(cell > 0)) throw new Error(`erode: cell must be a positive number of metres, got ${cell}`)
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

  // The density and the distance, turned into a count and a step budget by the cell. See THE RAIN IS A DENSITY.
  const droplets = Math.max(1, Math.round((E.dropletsPerKm2 * land.length * cell * cell) / 1e6))
  const maxSteps = Math.max(1, Math.round(E.maxWalkM / cell))
  const batch = Math.max(1, Math.round(droplets * E.batchShare))
  // The reference frame. `perStep` is how much of a reference step one step of this walk covers, so a rate per reference step becomes a rate per step; `toHere` turns a reference depth into a depth on this grid at the same volume. Both are 1 at cell = refCell. See the note by `refCell`.
  const perStep = cell / E.refCell
  const toHere = (E.refCell / cell) ** 2

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

  // The swirl, baked once: the two components of the nudge per cell. Cheap to read and, more to the point, the SAME for every droplet that crosses a given hillside, which is what makes the bend it puts in survive a thousand of them. See THE SWIRL.
  const swirlX = new Float32Array(size)
  const swirlZ = new Float32Array(size)
  {
    const nx = new Noise((seed * 7 + 811) | 0)
    const nz = new Noise((seed * 7 + 823) | 0)
    const s = E.swirlScale / cell // cells, from the metres the meander is stated in
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i
        swirlX[c] = E.swirl * nx.simplex2(i / s, j / s)
        swirlZ[c] = E.swirl * nz.simplex2(i / s + 5.3, j / s - 2.1)
      }
    }
  }

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

  // The draw's scratch, one entry per lower neighbour, reused every step.
  const drawW = new Float64Array(8)
  const drawC = new Int32Array(8)
  const drawK = new Int32Array(8)

  let steps = 0
  let toSea = 0
  let offEdge = 0
  let ponded = 0
  let spent = 0
  let deepestStep = 0
  for (let d = 0; d < droplets; d++) {
    if (d > 0 && d % batch === 0) flood()
    let c = land[(rng() * land.length) | 0]
    // The heading, continuous and carried between steps. Drawn at random to start, so the first step is not biased to an axis.
    const a0 = rng() * Math.PI * 2
    let dx = Math.cos(a0)
    let dz = Math.sin(a0)
    let speed = 1
    let water = 1
    let sediment = 0
    let fate = 'spent'
    for (let step = 0; step < maxSteps; step++) {
      const ci = c % n
      const cj = (c / n) | 0
      const hc = S[c]

      // The heading: what it was, turned toward the downhill gradient and nudged by the swirl. The gradient is normalised first, so `inertia` is a share of one heading against another and means the same on a scree slope as on a meadow.
      const gx = (S[ci + 1 < n ? c + 1 : c] - S[ci > 0 ? c - 1 : c]) / 2
      const gz = (S[cj + 1 < n ? c + n : c] - S[cj > 0 ? c - n : c]) / 2
      const g2 = gx * gx + gz * gz
      if (g2 > 1e-18) {
        const gi = (1 - E.inertia) / Math.sqrt(g2)
        dx = dx * E.inertia - gx * gi
        dz = dz * E.inertia - gz * gi
      }
      dx += swirlX[c]
      dz += swirlZ[c]
      const d2 = dx * dx + dz * dz
      if (d2 > 1e-18) {
        const di = 1 / Math.sqrt(d2)
        dx *= di
        dz *= di
      }

      // Which of the lower neighbours: a roulette, not a winner. See THE DRAW.
      let nw = 0
      let wsum = 0
      let edge = false
      for (let k = 0; k < 8; k++) {
        const ni = ci + NB_DI[k]
        const nj = cj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) {
          edge = true
          continue
        }
        const nn = nj * n + ni
        const s = (hc - S[nn]) * NB_INV[k]
        if (s <= 0) continue
        const agree = NB_UX[k] * dx + NB_UZ[k] * dz
        const w = s * (E.stray + (agree > 0 ? agree : 0))
        drawW[nw] = w
        drawC[nw] = nn
        drawK[nw] = k
        nw++
        wsum += w
      }
      let next = -1
      let nextK = -1
      if (nw > 0) {
        let r = rng() * wsum
        for (let q = 0; q < nw; q++) {
          r -= drawW[q]
          if (r <= 0 || q === nw - 1) {
            next = drawC[q]
            nextK = drawK[q]
            break
          }
        }
      }
      if (next < 0) {
        if (pond[c]) {
          next = tree[c]
          nextK = -1
        }
        if (next < 0) {
          // A pit the last flood did not see, or the box edge: what it carries stays here.
          lay(c, sediment * toHere)
          fate = edge ? 'edge' : 'ponded'
          break
        }
      }
      if (sea[next]) {
        fate = 'sea'
        break
      }
      if (nextK >= 0) {
        dx = NB_UX[nextK]
        dz = NB_UZ[nextK]
      }
      const dh = S[next] - hc
      // The drop the same slope would give over one reference step. Everything from here to the end of the step is in the reference frame.
      const dhRef = -dh / perStep
      const cap = Math.max(dhRef, E.minSlope) * speed * water * E.capacity
      if (sediment > cap) {
        const drop = (sediment - cap) * E.deposit * perStep
        lay(c, drop * toHere)
        sediment -= drop
      } else {
        const cut = Math.min((cap - sediment) * E.erode * perStep * yield_[ground[c]], dhRef, E.maxCut * perStep)
        if (cut > 0) {
          const here = cut * toHere
          if (here > deepestStep) deepestStep = here
          for (let k = 0; k < brush.length; k++) {
            const b = brush[k]
            const bi = ci + b[0]
            const bj = cj + b[1]
            if (bi < 0 || bj < 0 || bi >= n || bj >= n) continue
            const bc = bj * n + bi
            elev[bc] -= here * b[2]
            if (!pond[bc]) S[bc] = elev[bc]
          }
          sediment += cut
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * E.gravity))
      water *= 1 - E.evaporate * perStep
      c = next
      steps++
    }
    if (fate === 'sea') toSea++
    else if (fate === 'edge') offEdge++
    else if (fate === 'ponded') ponded++
    else spent++
  }

  /** Drop `amt` metres of sediment on cell c -- a depth on THIS grid, converted by the caller -- never over the water standing on it. */
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
  return { droplets, maxSteps, steps, meanSteps: steps / droplets, toSea, offEdge, ponded, spent, deepestStep, cutCells, cutMean: cutCells ? cutSum / cutCells : 0, deepest, fillCells, fillMean: fillCells ? fillSum / fillCells : 0, highest }
}
