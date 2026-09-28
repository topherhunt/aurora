import { Noise } from '../sim/noise.js'
import { clamp01 } from '../sim/mathx.js'
import { BIOMES } from './biomes.js'

// ---------------------------------------------------------------------------
// Step D, between the drain and the lakes -- the island grows cliffs. The field has none and cannot be made to yield any by thresholding: over 304592 land texels the steepest texel-to-texel drop is 24 deg at the median and 45 deg at p90, and only 0.216% of them fall more than two texel-distances (16 m over 8 m). Cliffs are not in the field to be found, so they are MADE here, by taking the slope that is there and standing it up.
//
//   THE TABLE. A ladder of rungs `step` metres apart cuts the slope into bands. Inside a band a texel's height, 0 at the rung below to 1 at the rung above, is remapped through a ramp with two straight pieces: a FACE over the lowest `riser` of the band that climbs `snap` of its fall, and a SHELF over the rest that carries the remaining 1 - `snap` gently up to the rung above. The face's grade is therefore the old grade times `snap / riser` -- 30 degrees at 0.8 over 0.12 is 77 -- and the shelf's is the old grade times (1 - `snap`) / (1 - `riser`), a third of it or less, which is the "flat-ish mesa top" half of the ask without ever being dead level.
//
//   THE SHELF SITS ABOVE ITS FACE, and it has to. A shelf under a face can only be made by cutting the ground down to it, and the cut is a trench: the ground below the face was never touched, so the shelf sits in a hollow with the natural slope rising away on both sides, and where the weight `w` varies from texel to texel that hollow turns into a run of dishes. A shelf above its face is made by lifting instead, so `f >= frac` everywhere and this pass NEVER LOWERS A TEXEL (it throws if it computes a move that would). What is under a face is the untouched slope the carve left -- a real downhill grade, shy of flat, no trench.
//
//   THE LADDER IS SPARSE. Table every band and a hillside comes out as stairs: face, shelf, face, shelf, at a fixed pitch all the way up. So a rung only carries a face when its hash stands above both its neighbours' -- about one rung in three, never two in a row, so there is always a whole band of untouched slope between one face and the next. Integer hash and not noise, because what is wanted between neighbouring rungs is independence, not continuity. The pattern is per class and island-wide; it reads as irregular anyway because the ladder's own offset drifts (below), so the same rung index is a different height in different places.
//
//   THE HEIGHT WANDERS. Two things keep a face from being the same height everywhere along it and a shelf from being a billiard table. `snap` -- how much of a band's fall the face takes -- is drawn per rung from a span the class sets, so one band puts half its fall in the face and leaves the shelf a walkable grade while the next puts all of it there and goes flat. And `roll`, a fast octave on the ladder's offset, slides the rungs up and down by a fraction of a step over a couple of hundred metres, so a shelf tilts and rolls and a face grows and shrinks along its run.
//
//   THE CEILING, and it is the reason `riser` below 0.2 buys nothing. A face narrower than a texel cannot be drawn: the field is 8 m/texel and V2Height reads it through a Catmull-Rom, which smears any step across 0.8 of a texel whatever its size, so a D-metre drop in one texel tops out at atan(1.25 * D / 8) -- 68 deg at 16 m, 79 at 34. Asking for a narrower face than that does no harm (the two texels either side simply land on the two rungs, which is the most the grid can hold) but it is not what you get. A genuinely sheer face needs the escarpment carve, §31 step E, which this pass is also the source of: the break lines are here.
//
//   THE BAND. A per-texel coin flip on steep ground gives salt and pepper -- isolated 8 m nubs, no two adjacent. So the gate is one octave of simplex at CLIFFS.wavelength: cliffs come out as bands and outcrops hundreds of metres long whose ends taper off as the noise crosses back under the threshold. The threshold is a QUANTILE of that noise over each class's own steep ground, so `share` means exactly what it says -- the fraction of that biome's steep ground the band lets through -- rather than a number that has to be re-guessed whenever the noise changes. A third of what it lets through is what the sparse ladder then actually moves.
//
//   THE PHASE. One ladder over the whole island would put every shelf on the same rungs and read as a contour map. A second, slower noise offsets the ladder by up to a step, so two massifs a kilometre apart bench at different heights.
//
//   WHERE IT RUNS. After the drain and before the lakes (hydrology.js). After, because the drain's dishes are broad and shallow and would grind a scarp back into a slope; before, because everything downstream of it re-reads the ground -- the lakes are fitted, and the route and the rivers are solved, on the shape that will actually be drawn. What it does not get is a second drain: this pass only ever lifts, so a shelf that dams a hollow the drain emptied leaves it dammed, one of the reasons the pass is off by default. Nothing here knows about rivers or lakes because at this point there are none.
//
// Heights are metres. Three-free and DOM-free like the rest of src/v3.
// ---------------------------------------------------------------------------

export const CLIFFS = {
  wavelength: 320,    // metres: the scale of the band field, so roughly the length of a run of cliff
  bandFeather: 0.14,  // noise units past the threshold over which a band reaches full strength; its taper at either end
  phaseScale: 1100,   // metres over which the ladder's offset drifts, so neighbouring massifs bench at different heights
  rollScale: 240,     // metres of the fast octave on that offset: the scale a shelf tilts and rolls over
  roll: 0.25,         // that octave's amplitude as a fraction of a step, so a face's height wanders along its run
  minSlope: 26,       // degrees: under this the ground is flat enough to leave alone, or plains terrace into paddies
  slopeFeather: 6,    // degrees over which that gate opens. Narrow on purpose: it is there to spare the flats, not to scale the effect with steepness, and a wide one leaves the 30-degree ground -- which is most of the steep ground there is -- tabled at a fifth strength and no cliff anywhere.
  minHeight: 6,       // metres above the waterline under which nothing tables, so the coast keeps its beaches
  // Per class, by BIOMES id. `share` is the fraction of that class's steep ground the band gate lets through, `strength` how far toward the fully tabled profile it goes, `step` the rung of the ladder in metres -- about a third of the height from one face to the next, since about one rung in three carries one -- and `riser` the fraction of each band the face occupies.
  // `snap` is the span the fraction of a band's fall taken by the face is drawn from, one draw per rung: what the face does not take stays behind as the shelf's downhill grade, so the top of `snap` is a mesa and the bottom of it a ramp, and a class whose span is wide gets both. The canyon's sits high because a mesa top is the point of it; the forest's low, because a shelf there should still fall away under the walker. Its floor must stay above `riser` or the ramp would cut.
  // Reading `riser`: a face is `riser * step / tan(slope)` metres of ground, so at the 30 degrees most steep ground sits at, `riser * step * 1.73`. Under 8 m it lands inside one texel and the whole of `snap * step` falls between two of them -- the most the grid can hold, and a wall. Over 8 m it is shared out over two or three texels and comes back a firm bank. Canyon and desert sit under the line; the rest sit over it, which is the "45 degrees is fine here" half of the ask.
  byBiome: {
    arctic: { share: 0.38, strength: 0.75, step: 26, riser: 0.30, snap: [0.50, 0.90] },
    forest: { share: 0.30, strength: 0.70, step: 21, riser: 0.34, snap: [0.45, 0.85] },
    plains: { share: 0.16, strength: 0.60, step: 17, riser: 0.42, snap: [0.50, 0.85] },
    jungle: { share: 0.24, strength: 0.70, step: 21, riser: 0.34, snap: [0.45, 0.85] },
    swamp: { share: 0, strength: 0, step: 17, riser: 0.42, snap: [0.50, 0.85] },
    canyon: { share: 0.85, strength: 1, step: 34, riser: 0.11, snap: [0.80, 1] },
    desert: { share: 0.58, strength: 0.85, step: 28, riser: 0.13, snap: [0.70, 1] },
  },
}

/** The pass switched off: no class bands any of its steep ground, so `table` walks the grid, moves nothing and returns the same stats record it always does, all zero. A table of zeroes rather than a skipped call, so the shape the map page and the gate read off never depends on whether the step ran. */
export const CLIFFS_OFF = Object.freeze({
  ...CLIFFS,
  byBiome: Object.fromEntries(Object.entries(CLIFFS.byBiome).map(([id, k]) => [id, { ...k, share: 0 }])),
})

/** The value `share` of the way up a sorted copy of `values`, or -Infinity for an empty list. */
function quantile(values, share) {
  if (values.length === 0) return -Infinity
  const sorted = Float64Array.from(values).sort()
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]
}

/** A value in [0, 1) for rung `r` of class `b`'s ladder, independent of its neighbours'. */
function rungHash(r, b, salt) {
  let h = (Math.imul(r | 0, 374761393) + Math.imul(b + 1, 668265263) + (salt | 0)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/**
 * `table(elev, sea, ground, n, cell, seed, C = CLIFFS)` -> stats. Works on `elev` in place: the slope every texel is judged by is read off the field as it arrives, so a texel already moved cannot change its neighbour's verdict.
 */
export function table(elev, sea, ground, n, cell, seed, C = CLIFFS) {
  const size = n * n
  if (sea.length !== size || ground.length !== size) throw new Error(`table: sea has ${sea.length} texels, ground ${ground.length}, the field ${size}`)
  const byBiome = BIOMES.map((b) => {
    const k = C.byBiome[b.id]
    if (!k) throw new Error(`table: CLIFFS.byBiome has no ${b.id}`)
    if (!(k.snap[0] > k.riser && k.snap[1] >= k.snap[0] && k.snap[1] <= 1)) throw new Error(`table: ${b.id} snap must be a span inside (riser = ${k.riser}, 1], got ${k.snap}`)
    if (!(k.riser > 0 && k.riser < 1)) throw new Error(`table: ${b.id} riser must be in (0, 1), got ${k.riser}`)
    if (!(k.step > 0)) throw new Error(`table: ${b.id} step must be > 0, got ${k.step}`)
    return k
  })
  const half = ((n - 1) * cell) / 2
  const band = new Noise(seed * 7 + 521)
  const phase = new Noise(seed * 7 + 523)
  const roll = new Noise(seed * 7 + 527)
  const minTan = Math.tan((C.minSlope * Math.PI) / 180)
  const maxTan = Math.tan(((C.minSlope + C.slopeFeather) * Math.PI) / 180)

  // Candidate texels: land, clear of the waterline, and steep. The gradient is a central difference on the four neighbours, which is the same stencil Heightmap.slopeAt reads, so a texel this calls steep is one the field agrees is steep.
  const gate = new Float32Array(size)
  const noise = new Float32Array(size)
  const perBiome = BIOMES.map(() => [])
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const c = j * n + i
      if (sea[c] || elev[c] < C.minHeight) continue
      const gx = (elev[c + 1] - elev[c - 1]) / (2 * cell)
      const gz = (elev[c + n] - elev[c - n]) / (2 * cell)
      const g = clamp01((Math.hypot(gx, gz) - minTan) / (maxTan - minTan))
      if (g <= 0) continue
      gate[c] = g
      const v = 0.5 + 0.5 * band.simplex2((i * cell - half) / C.wavelength, (j * cell - half) / C.wavelength)
      noise[c] = v
      perBiome[ground[c]].push(v)
    }
  }
  // Per class, the noise level its `share` of steep ground stands above.
  const threshold = byBiome.map((k, b) => (k.share <= 0 ? Infinity : k.share >= 1 ? -Infinity : quantile(perBiome[b], 1 - k.share)))

  let cells = 0
  let moveSum = 0
  let maxMove = 0
  const hit = BIOMES.map(() => 0)
  const banded = BIOMES.map(() => 0)
  const out = Float32Array.from(elev)
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const c = j * n + i
      if (gate[c] <= 0) continue
      const b = ground[c]
      const k = byBiome[b]
      const w = gate[c] * k.strength * clamp01((noise[c] - threshold[b]) / C.bandFeather)
      if (w <= 0) continue
      banded[b]++
      const x = i * cell - half
      const z = j * cell - half
      const h = elev[c]
      const p = k.step * (0.5 + 0.5 * phase.simplex2(x / C.phaseScale, z / C.phaseScale) + C.roll * roll.simplex2(x / C.rollScale, z / C.rollScale))
      const t = (h - p) / k.step
      const rung = Math.floor(t)
      // Only a rung whose hash beats both its neighbours' carries a face, so no two faces are ever a band apart.
      const hr = rungHash(rung, b, seed)
      if (hr <= rungHash(rung - 1, b, seed) || hr <= rungHash(rung + 1, b, seed)) continue
      const snap = k.snap[0] + (k.snap[1] - k.snap[0]) * rungHash(rung, b, seed + 9176)
      const frac = t - rung
      const f = frac <= k.riser ? (frac * snap) / k.riser : snap + ((frac - k.riser) * (1 - snap)) / (1 - k.riser)
      const move = w * (f - frac) * k.step
      if (move < 0) throw new Error(`table: ${BIOMES[b].id} would cut ${(-move).toFixed(2)} m at frac ${frac.toFixed(3)}, snap ${snap.toFixed(3)}, riser ${k.riser}`)
      if (move === 0) continue
      out[c] = h + move
      cells++
      hit[b]++
      moveSum += move
      if (move > maxMove) maxMove = move
    }
  }
  elev.set(out)

  return {
    cells,
    km2: (cells * cell * cell) / 1e6,
    meanMove: cells ? moveSum / cells : 0,
    maxMove,
    byBiome: BIOMES.map((b, k) => ({ id: b.id, cells: hit[k], steep: perBiome[k].length, share: perBiome[k].length ? banded[k] / perBiome[k].length : 0 })),
  }
}
