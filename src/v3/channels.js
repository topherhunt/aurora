import { priorityFlood, flowDirections, flowAccumulation } from '../sim/hydrology.js'
import { NB_DI, NB_DJ } from '../sim/world-grid.js'
import { Noise } from '../sim/noise.js'

// ---------------------------------------------------------------------------
// Step D, second of all -- the channels. The basins have already drained (basins.js), so this pass is about rivers and nothing else. ONE priority flood reads the drained field for an acyclic route off every flat; D8 on that surface gives a flow network, the network is walked as chains from source to mouth, each chain becomes a meandering centreline, and a bed is cut along it whose width and depth come from the catchment IN METRES. There is no rain here, no droplet, no deposition.
//
//   THE CARVE ONLY EVER LOWERS A TEXEL. `elev[c] = min(elev[c], target)`, never `elev[c] -= delta`. Three things fall out of that one line and none of them has to be tuned for. It is order-independent and idempotent, so which chain is carved first cannot change the field. It cannot stand a spike, a fin or a needle anywhere, because nothing is ever added -- the whole class of carve-out remnants is impossible rather than merely unlikely. And "the carve never raises a texel" is a one-line invariant the gate asserts over sixteen million cells.
//   WIDTH AND DEPTH ARE METRES FROM CATCHMENT, WHICH IS WHAT MAKES THE GRID STOP MATTERING. `w = halfAtMin * sqrt(ratio)` and `d = depthAtMin * ratio^depthExp`, with `ratio` the catchment over `minCatchment`; the flank that carries the bed back up to the ground is `rise / bankSlope` wide. A headwater comes out a 4 m gully and the trunk a ~100 m valley, at 8 m per texel and at 2 m alike, because every one of those numbers is a length on the ground and none of them is a count of cells. Widths are HALF-widths throughout, as they are everywhere in the v2 doc. Three things ride on top of the catchment: the bed runs up to `flatWiden` wider again where the valley floor is flat and keeps its bare width where it is steep; it wanders by `wobble` of itself along a `wobbleScale` noise, so no reach holds one width for long; and the depth is capped at the full width, because water deeper than it is wide is a slot and not a river. A confluence needs no term of its own -- two equal branches meeting is twice the catchment, so the trunk leaves it 41% wider than either arm, which is the square-root law doing exactly what the real one does.
//   THE BED IS MONOTONE, IN TWO PASSES. Forward, `bed_k = min(g_k - d_k, bed_(k-1) - minFall * ds)`: the bed follows the ground down and, where the ground rises, holds its level and notches through. Backward, `bed_k = max(bed_k, bed_(k+1) + minFall * ds)` with the last sample pinned to what the chain runs into -- the sea, a kept lake's surface, or the trunk's already-carved bed at the junction. Both sequences fall, so the bed falls, lands exactly on its anchor, and never cuts below the water it empties into. The notch the forward pass cuts is small here, because the ground it runs on has already been drained: what is left to cross is under a metre.
//   THE MEANDER IS SMOOTH, SWIRL, AND A CLAMP, in that order. A D8 chain is a staircase of eight bearings, so it is first box-smoothed twice over `smoothM` of arc, which leaves the valley's real shape and removes the lattice. Then every sample is pushed sideways by the lateral component of a pair of coherent simplex fields at `swirlScale` -- coherent being the whole point, since a nudge every sample of a reach feels the SAME way bends the reach, where per-sample noise averages out -- at `meander` metres on a steep reach and `flatBend` times that on a flat one, with a second octave `fineScale` times finer at `fineBend` of the amplitude that only runs where it is flat. Aggressive bends and a fine wobble on top of them are what a river on its own floodplain does; a river on a hillside has one gradient to follow and follows it. Then the clamp: the offset is halved until the flood's surface at the offset point stands no more than `climb` above the surface at the centreline, and the resulting factor is slope-limited over `bendLen` of arc so it opens and closes smoothly instead of kinking. A river on a floodplain wanders its full amplitude; a river in a gorge runs true, because there is nowhere for it to go. That is the answer to a channel tunnelling straight through a hillside: the clamp will not let the centreline leave the valley floor, and the valley floor is where the meander is.
//   THE KEPT LAKES ARE GIVEN, NOT CHOSEN. `spare` and `surface` come in from the drain, which picked them on depth alone. A kept lake is masked out of the stamp entirely, so its floor is untouched and the chains stop at its shore and start again at its spill -- which the carve notches by `outletDrop` and no more, so the lake's outlet leaves at the water's surface without the channel cutting its own full depth through the sill and emptying it.
//
// Heights are metres. Three-free and DOM-free like the rest of src/v3.
// ---------------------------------------------------------------------------

export const CARVE = {
  minCatchment: 2e4,   // square metres draining through a cell before a channel is cut there. Finer than RIVERS.minCatchment on purpose: the doc draws water in the rivers, the carve gives the hillsides above them their dendritic texture
  halfAtMin: 2.1,      // metres of flat bed either side of the line at minCatchment -- a HALF-width, as every width in the v2 doc is. Sized so the bed stands about a third wider than the water RIVERS draws in it, everywhere along the chain, which is why the two share `tip` and the same shape of law
  maxHalf: 30,
  minHalf: 0.7,        // metres. An absolute floor, not a fraction of halfAtMin, or it would undo `tip`
  tip: 0.35,           // the share of its downstream width a chain has at its source, easing to 1 at its mouth. The catchment alone will not do this: a chain is walked up its LARGEST donor, so it keeps most of its catchment almost to its head and a pure catchment law gives it nearly one width end to end
  depthAtMin: 0.9,     // metres the bed sits below the ground at minCatchment
  depthExp: 0.3,       // the catchment ratio is raised to this for the depth, so a thousandfold catchment is eight times the depth and thirty times the width
  maxDepth: 12,
  flatWiden: 0.9,      // how much of itself again the bed gains where the valley floor is flat. A steep reach gets none of it
  steepGrade: 0.25,    // the longitudinal grade at which a reach counts as fully steep, so the flat terms are off. Measured against this terrain and not a real one: the median channel grade here is 0.275 over `gradeLen`, so 0.07 would have called nine reaches in ten steep and the flat terms would never have fired
  gradeLen: 140,       // metres of arc the grade is measured over, well past the jitter's reach so it reads the valley and not the grit
  wobble: 0.25,        // the share of its width a reach wanders by, chaotically, along the line
  wobbleScale: 80,     // metres over which that wander turns
  bankSlope: 0.35,     // mean grade of the flank that carries the bed back up to the ground: a 7 m bed gets a 20 m flank either side
  maxRise: 45,         // metres of cut the flank is sized for. A notch deeper than this keeps the same flank and stands its walls up, which is a gorge
  minFall: 0.0015,     // metres of fall per metre of channel the bed is forced to keep, so no reach is level and nothing ponds in one
  smoothM: 24,         // metres of arc the D8 chain is box-smoothed over, twice
  meander: 45,         // metres the centreline may be pushed sideways on a steep reach
  flatBend: 1.7,       // and this much of that again on a flat one. Past swirlScale / 2pi, so a flat reach can double back on itself -- which is an oxbow, and a min-stamp cannot make an artifact of one
  swirlScale: 330,     // metres over which the swirl turns, so the wavelength of the meander
  fineBend: 0.3,       // a second swirl octave at this share of the amplitude, `fineScale` times finer, and only where the valley floor is flat
  fineScale: 3,
  climb: 9,            // metres of flooded surface the offset point may stand above the centreline, on top of the bed's own depth there. What pins a gorge to its floor and lets a floodplain wander -- and it has to clear the grit, since the finest baked rung moves the ground several metres over a 45 m hop and a tight tolerance stops the meander on jitter rather than on a wall
  bendLen: 60,         // metres of arc over which the clamp may open or close, so a pinned reach eases into a free one
  outletDrop: 1.5,     // metres the rim of a kept lake is notched by, and so the metres its water falls below its old spill. Without the cap the outlet channel cuts its own full depth through the sill and a shallow lake empties
  outletGrade: 0.06,   // the grade the notch is released at, so the channel reaches its natural bed within a hundred metres of the shore
}

/**
 * `runChannels(elev, sea, n, cell, seed, spare, surface)` -> { stats }
 *
 * Works on `elev` in place and may widen `sea` (a pocket the flood fills to the waterline is the sea's). `spare` marks the cells of the lakes the drain kept and `surface` holds their level: the stamp leaves those cells alone and the chains anchor on that level where they meet one. Both come from drainBasins.
 */
export function runChannels(elev, sea, n, cell, seed, spare, surface) {
  const C = CARVE
  const t0 = Date.now()
  const size = n * n
  const cellArea = cell * cell
  if (!(cell > 0)) throw new Error(`runChannels: cell must be a positive number of metres, got ${cell}`)
  if (sea.length !== size) throw new Error(`runChannels: sea has ${sea.length} texels, the field ${size}`)
  if (spare.length !== size || surface.length !== size) throw new Error(`runChannels: spare has ${spare.length} texels and surface ${surface.length}, the field ${size}`)
  if (!Number.isFinite(seed)) throw new Error(`runChannels: seed must be a finite number, got ${seed}`)

  const before = Float32Array.from(elev)

  // --- the flood --------------------------------------------------------------
  const flood = priorityFlood(elev, n)
  const filled = flood.filled
  for (let c = 0; c < size; c++) if (filled[c] <= 0) sea[c] = 1

  // --- the network -------------------------------------------------------------
  const recv = flowDirections(filled, flood.tree, n)
  // A kept lake drains through its spill and nowhere else: steepest descent off the flat would let the cells beside the spill step over the rim, and each such step is another outlet. The flood's tree leads every cell of the flat to the one the flood came in by.
  for (let c = 0; c < size; c++) if (spare[c]) recv[c] = flood.tree[c]
  const acc = flowAccumulation(recv, flood.order, size)

  const chan = new Uint8Array(size)
  let chanCells = 0
  for (let c = 0; c < size; c++) {
    if (sea[c] || spare[c] || acc[c] * cellArea < C.minCatchment) continue
    chan[c] = 1
    chanCells++
  }

  // --- the swirl and the wobble ---------------------------------------------------
  // Two coherent vector fields at unit amplitude -- `meander` is the metres -- and one scalar for the width. Read per sample rather than baked over the grid: sixteen million texels of simplex cost more than the twenty-eight thousand samples that actually ask for it, and read at the sample's own fractional position the fields are smoother than a bilinear lift off a bake would be.
  const swX = new Noise((seed * 7 + 811) | 0)
  const swZ = new Noise((seed * 7 + 823) | 0)
  const wobN = new Noise((seed * 7 + 839) | 0)
  const sCoarse = C.swirlScale / cell
  const sFine = sCoarse / C.fineScale
  const sWob = C.wobbleScale / cell

  // --- the chains ----------------------------------------------------------------
  // Donors per channel cell, as CSR. Every mouth (a channel cell whose receiver is not one) is walked up its largest donor to a source; each other donor met on the way is the mouth of a tributary, pushed onto the same stack. LIFO is what guarantees a trunk is carved before its tributaries, so a tributary can read its anchor straight out of `elev` at the junction with no bookkeeping at all.
  const start = new Int32Array(size + 1)
  for (let c = 0; c < size; c++) {
    if (!chan[c]) continue
    const r = recv[c]
    if (r >= 0 && chan[r]) start[r + 1]++
  }
  for (let c = 0; c < size; c++) start[c + 1] += start[c]
  const donors = new Int32Array(start[size])
  const fill = Int32Array.from(start.subarray(0, size))
  for (let c = 0; c < size; c++) {
    if (!chan[c]) continue
    const r = recv[c]
    if (r >= 0 && chan[r]) donors[fill[r]++] = c
  }

  const heads = []
  for (let c = 0; c < size; c++) {
    if (!chan[c]) continue
    const r = recv[c]
    if (r >= 0 && chan[r]) continue
    heads.push({ mouth: c, tail: r })
  }

  let chains = 0
  let samples = 0
  let metres = 0
  let bendSum = 0
  let bendMax = 0
  let walled = 0
  let deepestNotch = 0
  let widSum = 0
  let widMax = 0
  let flatSum = 0
  let gradeSum = 0
  let slotMax = 0
  const path = []
  while (heads.length) {
    const head = heads.pop()
    path.length = 0
    let c = head.mouth
    for (;;) {
      path.push(c)
      let best = -1
      for (let k = start[c]; k < start[c + 1]; k++) if (best < 0 || acc[donors[k]] > acc[best]) best = donors[k]
      if (best < 0) break
      for (let k = start[c]; k < start[c + 1]; k++) if (donors[k] !== best) heads.push({ mouth: donors[k], tail: c })
      c = best
    }
    path.reverse()
    carve(Int32Array.from(path), head.tail)
  }

  /** Bilinear read of `f` at fractional cell coordinates. */
  function at(f, fi, fj) {
    let i = Math.floor(fi)
    let j = Math.floor(fj)
    if (i < 0) i = 0
    else if (i > n - 2) i = n - 2
    if (j < 0) j = 0
    else if (j > n - 2) j = n - 2
    let u = fi - i
    let v = fj - j
    if (u < 0) u = 0
    else if (u > 1) u = 1
    if (v < 0) v = 0
    else if (v > 1) v = 1
    const a = f[j * n + i]
    const b = f[j * n + i + 1]
    const d = f[(j + 1) * n + i]
    const e = f[(j + 1) * n + i + 1]
    return (a + (b - a) * u) * (1 - v) + (d + (e - d) * u) * v
  }

  /** The level the chain must land on: the sea, a kept lake's surface, or the trunk's bed where it joins. */
  function anchorAt(tail) {
    if (tail < 0) return -Infinity
    if (sea[tail]) return 0
    if (spare[tail]) return surface[tail]
    return elev[tail]
  }

  function carve(cells, tail) {
    const K = cells.length
    if (K < 2) return
    chains++
    const R = Math.max(1, Math.round(C.smoothM / cell / 2))
    const T = Math.max(1, Math.min(R, (K - 1) / 3))
    const rx = new Float64Array(K)
    const rz = new Float64Array(K)
    for (let k = 0; k < K; k++) {
      rx[k] = cells[k] % n
      rz[k] = (cells[k] / n) | 0
    }
    // Two box passes, which is a triangle filter: the lattice goes and the valley stays. Tapered to nothing at both ends, so the source and the mouth stay on the cells the network gave them.
    const ax = box(box(rx, R), R)
    const az = box(box(rz, R), R)
    const sx = new Float64Array(K)
    const sz = new Float64Array(K)
    for (let k = 0; k < K; k++) {
      const w = Math.min(1, k / T, (K - 1 - k) / T)
      sx[k] = rx[k] + w * (ax[k] - rx[k])
      sz[k] = rz[k] + w * (az[k] - rz[k])
    }
    const s = new Float64Array(K)
    for (let k = 1; k < K; k++) s[k] = s[k - 1] + Math.hypot(sx[k] - sx[k - 1], sz[k] - sz[k - 1]) * cell

    // How flat the valley floor runs here: the ground's grade over `gradeLen` of arc, read on the smoothed line before the offset moves it, and mapped to 1 on the flat and 0 at `steepGrade`. A window this long is deliberate -- over a few metres the grade is the jitter's, not the valley's.
    const flat = new Float64Array(K)
    {
      const g0 = new Float64Array(K)
      for (let k = 0; k < K; k++) g0[k] = at(elev, sx[k], sz[k])
      let a = 0
      let b = 0
      for (let k = 0; k < K; k++) {
        while (a < k && s[k] - s[a] > C.gradeLen / 2) a++
        while (b < K - 1 && s[b] - s[k] < C.gradeLen / 2) b++
        const run = s[b] - s[a]
        const grade = run > 1 ? Math.abs(g0[a] - g0[b]) / run : 0
        flat[k] = 1 - Math.min(1, grade / C.steepGrade)
        gradeSum += grade
      }
    }

    // Width and depth are metres off the catchment at this sample, which the offset below does not move, so they are known before the line is. Half-widths: the flat bed runs `wid` either side of the line.
    const wid = new Float64Array(K)
    const dep = new Float64Array(K)
    for (let k = 0; k < K; k++) {
      const ratio = Math.max(1, (acc[cells[k]] * cellArea) / C.minCatchment)
      const wob = wobN.simplex2(sx[k] / sWob, sz[k] / sWob) * 0.7 + wobN.simplex2(sx[k] / (sWob * 0.4) + 11.7, sz[k] / (sWob * 0.4) - 4.3) * 0.3
      const taper = C.tip + (1 - C.tip) * ((k + 0.5) / K)
      const w = C.halfAtMin * Math.sqrt(ratio) * taper * (1 + C.flatWiden * flat[k]) * (1 + C.wobble * wob)
      wid[k] = Math.max(C.minHalf, Math.min(w, C.maxHalf))
      // Never deeper than it is wide. A channel narrower than it is deep is a slot in the ground, and no amount of catchment makes one a river.
      dep[k] = Math.min(C.depthAtMin * Math.pow(ratio, C.depthExp), C.maxDepth, 2 * wid[k])
      widSum += 2 * wid[k]
      flatSum += flat[k]
      if (2 * wid[k] > widMax) widMax = 2 * wid[k]
      if (dep[k] / (2 * wid[k]) > slotMax) slotMax = dep[k] / (2 * wid[k])
    }

    // The offset: the swirl's component across the line, at `meander` metres on a steep reach and `flatBend` times that on a flat one, plus a finer octave that only runs where it is flat.
    const ux = new Float64Array(K)
    const uz = new Float64Array(K)
    const off = new Float64Array(K)
    const fac = new Float64Array(K)
    for (let k = 0; k < K; k++) {
      const a = k > 0 ? k - 1 : 0
      const b = k < K - 1 ? k + 1 : K - 1
      let tx = sx[b] - sx[a]
      let tz = sz[b] - sz[a]
      const tl = Math.hypot(tx, tz) || 1
      tx /= tl
      tz /= tl
      ux[k] = -tz
      uz[k] = tx
      const px = sx[k]
      const pz = sz[k]
      const cx = swX.simplex2(px / sCoarse, pz / sCoarse)
      const cz = swZ.simplex2(px / sCoarse + 5.3, pz / sCoarse - 2.1)
      const fx = swX.simplex2(px / sFine + 17.1, pz / sFine + 9.4)
      const fz = swZ.simplex2(px / sFine - 3.7, pz / sFine + 21.8)
      let sw = (cx + C.fineBend * flat[k] * fx) * ux[k] + (cz + C.fineBend * flat[k] * fz) * uz[k]
      if (sw > 1) sw = 1
      else if (sw < -1) sw = -1
      off[k] = ((C.meander * (1 + (C.flatBend - 1) * flat[k])) / cell) * sw
    }
    // The clamp. Halve the offset until the flooded surface at the offset point is within `climb` of the surface here; five halvings and it is refused outright. The tolerance carries the bed's own depth, because ground the bed is going to be under anyway is not a wall.
    for (let k = 0; k < K; k++) {
      const base = at(filled, sx[k], sz[k]) + C.climb + dep[k]
      let f = 1
      while (f > 1 / 32) {
        if (at(filled, sx[k] + f * off[k] * ux[k], sz[k] + f * off[k] * uz[k]) <= base) break
        f *= 0.5
      }
      fac[k] = f > 1 / 32 ? f : 0
    }
    // and slope-limited both ways, so the clamp cannot kink the line where it closes.
    for (let k = 1; k < K; k++) {
      const lim = fac[k - 1] + (s[k] - s[k - 1]) / C.bendLen
      if (fac[k] > lim) fac[k] = lim
    }
    for (let k = K - 2; k >= 0; k--) {
      const lim = fac[k + 1] + (s[k + 1] - s[k]) / C.bendLen
      if (fac[k] > lim) fac[k] = lim
    }

    const gx = new Float64Array(K)
    const gz = new Float64Array(K)
    for (let k = 0; k < K; k++) {
      const w = Math.min(1, k / T, (K - 1 - k) / T)
      const m = w * fac[k] * off[k]
      gx[k] = clamp01(sx[k] + m * ux[k], n - 1)
      gz[k] = clamp01(sz[k] + m * uz[k], n - 1)
      const bend = Math.abs(m) * cell
      bendSum += bend
      if (bend > bendMax) bendMax = bend
      if (fac[k] < 0.999) walled++
    }

    // The bed, on the line as it finally runs.
    const fs = new Float64Array(K)
    for (let k = 1; k < K; k++) fs[k] = fs[k - 1] + Math.hypot(gx[k] - gx[k - 1], gz[k] - gz[k - 1]) * cell
    const gh = new Float64Array(K)
    const bed = new Float64Array(K)
    for (let k = 0; k < K; k++) {
      gh[k] = at(elev, gx[k], gz[k])
      const want = gh[k] - dep[k]
      bed[k] = k === 0 ? want : Math.min(want, bed[k - 1] - C.minFall * (fs[k] - fs[k - 1]))
    }
    // The sill. Where the chain runs beside a spared bowl -- at its outlet, above all -- the bed may not sink more than `outletDrop` under that water, or the channel would cut its own full depth through the rim and empty the lake. The cap is released at `outletGrade` either way along the chain, and the backward pass below puts the bed back in order afterwards.
    const cap = new Float64Array(K).fill(-Infinity)
    let capped = false
    for (let k = 0; k < K; k++) {
      const ci = cells[k] % n
      const cj = (cells[k] / n) | 0
      for (let q = 0; q < 8; q++) {
        const ni = ci + NB_DI[q]
        const nj = cj + NB_DJ[q]
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nn = nj * n + ni
        if (!spare[nn]) continue
        const v = surface[nn] - C.outletDrop
        if (v > cap[k]) cap[k] = v
        capped = true
      }
    }
    if (capped) {
      for (let k = 1; k < K; k++) {
        const v = cap[k - 1] - C.outletGrade * (fs[k] - fs[k - 1])
        if (v > cap[k]) cap[k] = v
      }
      for (let k = K - 2; k >= 0; k--) {
        const v = cap[k + 1] - C.outletGrade * (fs[k + 1] - fs[k])
        if (v > cap[k]) cap[k] = v
      }
      for (let k = 0; k < K; k++) if (cap[k] > bed[k]) bed[k] = cap[k]
    }
    const L = anchorAt(tail)
    for (let k = K - 1; k >= 0; k--) {
      const lo = k === K - 1 ? L : bed[k + 1] + C.minFall * (fs[k + 1] - fs[k])
      if (bed[k] < lo) bed[k] = lo
    }

    samples += K
    metres += fs[K - 1]
    for (let k = 0; k < K; k++) {
      const rise = gh[k] - bed[k]
      if (rise <= 0) continue
      if (rise > deepestNotch) deepestNotch = rise
      const flank = Math.max(cell * 0.5, Math.min(rise, C.maxRise) / C.bankSlope)
      const reach = (wid[k] + flank) / cell
      const lo = Math.ceil(reach)
      const ci = Math.round(gx[k])
      const cj = Math.round(gz[k])
      for (let dj = -lo; dj <= lo; dj++) {
        const nj = cj + dj
        if (nj < 0 || nj >= n) continue
        const oz = (nj - gz[k]) * cell
        for (let di = -lo; di <= lo; di++) {
          const ni = ci + di
          if (ni < 0 || ni >= n) continue
          const cc = nj * n + ni
          if (sea[cc] || spare[cc]) continue
          const ox = (ni - gx[k]) * cell
          const r = Math.hypot(ox, oz)
          let target
          if (r <= wid[k]) target = bed[k]
          else {
            const t = (r - wid[k]) / flank
            if (t >= 1) continue
            target = bed[k] + rise * t * t
          }
          if (target < elev[cc]) elev[cc] = target
        }
      }
    }
  }

  let cutCells = 0
  let cutSum = 0
  let deepest = 0
  let raised = 0
  for (let c = 0; c < size; c++) {
    const d = before[c] - elev[c]
    if (d > 0.01) {
      cutCells++
      cutSum += d
      if (d > deepest) deepest = d
    } else if (d < -1e-6) raised++
  }

  return {
    stats: {
      chains,
      samples,
      cells: chanCells,
      km: metres / 1000,
      bendMean: samples ? bendSum / samples : 0,
      bendMax,
      walled,
      widthMean: samples ? widSum / samples : 0,
      widthMax: widMax,
      slotMax,
      flatShare: samples ? flatSum / samples : 0,
      gradeMean: samples ? gradeSum / samples : 0,
      notch: deepestNotch,
      cutCells,
      cutKm2: (cutCells * cellArea) / 1e6,
      cutMean: cutCells ? cutSum / cutCells : 0,
      deepest,
      raised,
      ms: Date.now() - t0,
    },
  }
}

/** A box filter of radius `R` over an open sequence, edges clamped to the end values. */
function box(src, R) {
  const K = src.length
  const out = new Float64Array(K)
  const pre = new Float64Array(K + 1)
  for (let k = 0; k < K; k++) pre[k + 1] = pre[k] + src[k]
  const wide = 2 * R + 1
  for (let k = 0; k < K; k++) {
    const lo = k - R
    const hi = k + R
    const a = lo > 0 ? lo : 0
    const b = hi < K - 1 ? hi : K - 1
    out[k] = (pre[b + 1] - pre[a] + (a - lo) * src[0] + (hi - b) * src[K - 1]) / wide
  }
  return out
}

const clamp01 = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v)
