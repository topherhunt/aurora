// Gate for the v2 composed height field, the detail term and the chunk mesher --
// §18 sections 2 to 4 of the check.
//
//   node scripts/check-v2-field.mjs
//
// Exported as run() as well, so scripts/check-v2.mjs can fold this in as one
// section without shelling out; run() throws on any failure.
//
// NO ELEVATION LITERALS LIVE IN THIS FILE, and that is a deliberate constraint
// rather than an omission. The coarse shape is an IMPORT whose vertical range is
// chosen at bake time off an 8-bit source that carries no metres, and during this
// build the world has already been 16 km, 4 km and 8 km wide. Every assertion
// below is therefore a RELATIONSHIP -- the ramp is monotone, the snow line sits
// above the ramp's foot, the residual shrinks as the cell shrinks, the coverage
// does not drift with LOD -- measured against whatever height.png is on disk. A
// gate that asserted "p90 is 218 m" would pass today, fail on the next import for
// no reason anyone could act on, and get its number bumped until it asserted
// nothing.
//
// Four things here are checkable only by machine, and every one of them fails
// silently in the game:
//
//   THE SLOPE UNITS. src/player.js compares this field's slopeAt against
//   maxSlopeDeg * PI / 180 while src/v2/height/heightmap.js's slopeAt returns
//   0..1. Two conventions, one method name, no type to tell them apart. Getting
//   it wrong does not throw: she is blocked on flat ground, or walks up cliffs.
//
//   THE BAND LIMIT'S DIRECTION. smoothstep's two edges can be transposed and the
//   result is still a smooth 0..1 weight -- it just keeps exactly the octaves the
//   cell cannot resolve and discards the ones it can. §18's stated formula has
//   them that way round. The convergence table is what reads the difference.
//
//   THE EXTRA SAMPLING RING. Drop it and the mesh is still a mesh; it has a
//   lighting seam along every chunk join. The LOD-seam section meshes four
//   sibling chunks and compares normals on their shared edges, and it was run
//   with the ring deliberately removed to confirm it can fail -- see the note on
//   that section.
//
//   VERTEX COLOUR VS LOD. v1 paid for this once already: shade() took the MESH
//   normal, so coarsening a chunk repainted its rock as snow and the world
//   flashed white in chunk-shaped squares. v2's cells span 50 cm to 512 m, a
//   factor of 1024, so it is a worse problem here. Same 400-site methodology as
//   scripts/check-terrain.mjs so the two numbers can be read side by side.

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { KNEE_TEXELS, LAMBDA0, LAMBDA_MIN, DETAIL_GAIN, measureSite, measureAngle, roughnessOf } from '../src/v2/height/detail.js'
import { V2Height, WORLD_SEED } from '../src/v2/height/field.js'
import { RELIEF_KNOBS, RELIEF_DEFAULTS, RELIEF_SHIPPED, normalizeRelief, reliefIsOff } from '../src/v2/height/relief.js'
import { thermalErode } from '../src/v2/height/erode.js'
import { brushRect, stamp } from '../src/v2/height/sculpt.js'
import { CRAG_SLOPE_LO } from '../src/v2/height/crag.js'
import { RidgeField, SHATTER_VERTEX_CELLS } from '../src/v2/height/ridge.js'
import { CreaseField, CREASE_CELL, CREASE_REACH, CREASE_JITTER, CREASE_CAP, CREASE_SILL, CREASE_ANISO, CREASE_FLOOR } from '../src/v2/height/crease.js'
import { Layers } from '../src/v2/layers/layers.js'
import { BED_SHOAL } from '../src/v2/layers/paths.js'
import { snowDefaults } from '../src/v2/layers/doc.js'
import THREE from '../src/three-instance.js'
import { createPlainTerrainMaterial, createTerrainMaterial } from '../src/terrain/terrain-material.js'
import { TerrainTint } from '../src/terrain/terrain-tint.js'
import { buildChunkV2, shade, stippleTilesPerM, CLASS_EPS, CREST_CELL_LO, STIPPLE_TILE_MIN } from '../src/v2/terrain/chunk-mesh-v2.js'
import { WORLD_SIZE, WORLD_HALF, CHUNK_RES, CHUNK_VERTS, CHUNK_INDICES, MAX_DEPTH } from '../src/v2/config.js'
import { clamp01, smoothstep } from '../src/sim/mathx.js'

const PNG_PATH = new URL('../public/world/height.png', import.meta.url)
const JSON_PATH = new URL('../public/world/height.json', import.meta.url)
const PLAYER_PATH = new URL('../src/player.js', import.meta.url)
const MESH_PATH = new URL('../src/v2/terrain/chunk-mesh-v2.js', import.meta.url)
const RIDGE_PATH = new URL('../src/v2/height/ridge.js', import.meta.url)

// Where the camera stands for every chunk built here. Only the stipple frame
// reads it, and only section 10 looks at what it wrote.
const CAM = { x: 0, y: 0, z: 0 }

// A deterministic scatter of world points, used by every statistical section so
// two sections' numbers are comparable. Confined to the inner 90% so no probe
// lands on the heightmap's border clamp and measures the edge condition.
const site = (i) => ({
  x: (((i * 977) % 1000) / 1000 - 0.5) * WORLD_SIZE * 0.9,
  z: (((i * 1597) % 1000) / 1000 - 0.5) * WORLD_SIZE * 0.9,
})

const pct = (v) => `${(v * 100).toFixed(1)}%`

// THE WALKABILITY INSTRUMENT, at module scope because two sections read it and
// they have to read it the same way. §4's guarantee is about a rise over one
// STRIDE, not a derivative: anything shorter averages out under a boot and a
// real cliff does not. The "walkable fraction" section measures the detail
// term's cost with it and the "relief knobs" section measures each knob's cost
// with it, and the whole value of the second number is that it can be held
// against the first -- same 3000 sites, same stride, same angle from the same
// golden-angle sequence, so the only thing that differs between two readings is
// the field handed in.
const WALK_SITES = 3000
function walkableFraction(f, maxTan, stride) {
  let ok = 0
  for (let i = 0; i < WALK_SITES; i++) {
    const p = site(i)
    const a = (i * 2.399963229728653) % (Math.PI * 2)
    const rise = Math.abs(f(p.x + Math.cos(a) * stride, p.z + Math.sin(a) * stride) - f(p.x, p.z))
    if (rise / stride <= maxTan) ok++
  }
  return ok / WALK_SITES
}

/**
 * A synthetic heightmap that is exactly a plane of known inclination, for the
 * units section. Built through fromRaw, which is also the only coverage that
 * entry point gets outside the worker.
 */
function planeHeightmap(degrees) {
  const n = 64
  const texel = WORLD_SIZE / (n - 1)
  const grad = Math.tan((degrees * Math.PI) / 180)
  const data = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) data[j * n + i] = (-WORLD_HALF + i * texel) * grad
  }
  return Heightmap.fromRaw({ width: n, height: n, data, meta: { world: WORLD_SIZE, minY: -WORLD_HALF * grad, maxY: WORLD_HALF * grad, encoding: 'raw' } })
}

export async function run({ heightmap } = {}) {
  let failures = 0
  const check = (ok, label, detail = '') => {
    if (!ok) failures++
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
  }

  console.log('\n=== v2 composed field ===\n')

  const hm = heightmap === undefined ? await Heightmap.read({ path: PNG_PATH, metaPath: JSON_PATH }) : heightmap
  const layers = new Layers()
  const field = new V2Height({ heightmap: hm, layers, seed: WORLD_SEED })
  const cal = field.calibration
  const bands = field.bands
  const texel = hm.texelSize

  console.log(
    `        world ${WORLD_SIZE} m, heightmap ${hm.width}x${hm.height}, texel ${texel.toFixed(3)} m, ` +
      `relief ${hm.min.toFixed(1)}..${hm.max.toFixed(1)} m, max depth ${MAX_DEPTH} (leaf cell ${(WORLD_SIZE / (1 << MAX_DEPTH) / CHUNK_RES).toFixed(4)} m)`
  )

  // --- 1. the detail amplitude, and where it came from ----------------------
  console.log('\ndetail calibration')
  console.log(
    `        coarse roughness fit: R(${cal.fitLagA.toFixed(1)} m) = ${cal.rA.toFixed(3)} m, R(${cal.fitLagB.toFixed(1)} m) = ${cal.rB.toFixed(3)} m ` +
      `-> R(d) = ${cal.C.toFixed(4)} * d^${cal.exponent.toFixed(3)}`
  )
  console.log(
    `        probe at ${cal.probe.toFixed(3)} m: extrapolated ${cal.target.toFixed(4)} m, image supplies ${cal.imageAt.toFixed(4)} m (${pct(cal.imageShare)}), deficit ${cal.deficit.toFixed(4)} m, unit detail ${cal.unitAt.toFixed(4)} m`
  )
  console.log(`        ROUGH = ${cal.rough.toFixed(5)}   knee = ${(texel * KNEE_TEXELS).toFixed(2)} m (${KNEE_TEXELS} texels)`)
  console.log(`        spectral continuity alone wants ${cal.continuous.toFixed(5)}; DETAIL_GAIN ${DETAIL_GAIN.toFixed(4)}x on top of it`)
  console.log('        octave table (lambda m / amplitude m):')
  console.log('        ' + field.detail.table.map((t) => `${t.lambda >= 1 ? t.lambda : t.lambda.toFixed(2)}:${t.amp.toFixed(4)}`).join('  '))

  // The exponent is what gets extrapolated below one texel, so it has to be a
  // terrain exponent and not an artifact. A curvature exponent of 2 is a smooth
  // surface -- an interpolant with nothing under it -- and 0 is white noise;
  // eroded ground sits between, near 1. Outside this band the extrapolation is
  // reading the import's resampling rather than its landscape.
  check(cal.exponent > 0.5 && cal.exponent < 1.8, 'coarse field has a terrain-like roughness exponent', `${cal.exponent.toFixed(3)} (2 = smooth, 0 = noise)`)
  check(cal.rough > 0, 'detail amplitude is positive and measured, not configured', `ROUGH = ${cal.rough.toFixed(5)}`)
  // If the import already carried most of the sub-texel band, the extrapolation
  // would be fitting the import's own resampling noise rather than terrain, and
  // the detail term would be doubling it.
  check(cal.imageShare < 0.5, 'the sub-texel band is genuinely missing from the import', `image supplies ${pct(cal.imageShare)} of the extrapolation at ${cal.probe.toFixed(3)} m`)

  // The shipped amplitude is the continuity fit times DETAIL_GAIN and nothing
  // else -- in particular the bake's exaggeration is NOT divided back out, so a
  // taller import is a rockier one at every scale the detail term covers.
  check(
    Math.abs(cal.rough / cal.continuous - DETAIL_GAIN) < 1e-9,
    'the detail amplitude is the continuity fit scaled by DETAIL_GAIN alone',
    `${cal.rough.toFixed(5)} / ${cal.continuous.toFixed(5)} = ${(cal.rough / cal.continuous).toFixed(4)}x`
  )

  // The shoulder is the reason the fractal does not lay a second landscape over
  // the authored one: the octave at the coarse field's own scale must be far
  // smaller than the relief the author drew.
  {
    const top = field.detail.table[0]
    check(top.amp < (hm.max - hm.min) * 0.05, 'the shoulder keeps the fractal off the authored relief', `A(${LAMBDA0} m) = ${top.amp.toFixed(3)} m vs ${(hm.max - hm.min).toFixed(1)} m of relief`)
    const kneeAmp = field.detail.table.find((t) => t.lambda <= texel * KNEE_TEXELS).amp
    check(kneeAmp > top.amp, 'the spectrum peaks at the seam rather than at the top of the range', `A(knee) ${kneeAmp.toFixed(3)} m > A(${LAMBDA0} m) ${top.amp.toFixed(3)} m`)
    check(field.detail.table[field.detail.table.length - 1].lambda === LAMBDA_MIN, 'the octave table reaches the stated fine limit', `${field.detail.table.length} octaves, finest ${LAMBDA_MIN} m`)
  }

  // --- 2. determinism -------------------------------------------------------
  console.log('\ndeterminism')
  {
    const twin = new V2Height({ heightmap: hm, layers, seed: WORLD_SEED })
    let sameCall = true
    let sameInstance = true
    let differentSeed = false
    const other = new V2Height({ heightmap: hm, layers, seed: WORLD_SEED + 1 })
    for (let i = 0; i < 500; i++) {
      const p = site(i)
      const a = field.heightAt(p.x, p.z)
      if (field.heightAt(p.x, p.z) !== a) sameCall = false
      if (twin.heightAt(p.x, p.z) !== a) sameInstance = false
      if (other.heightAt(p.x, p.z) !== a) differentSeed = true
    }
    check(sameCall, 'heightAt is a pure function of (x, z, cell)')
    check(sameInstance, 'two separately constructed instances agree bit for bit', 'same seed, same calibration')
    // Without this the previous check is vacuous: a Detail that ignored its seed
    // would pass it trivially.
    check(differentSeed, 'and the seed is actually wired to the octave offsets', 'a different seed gives a different field')
  }

  // --- 3. band-limit convergence -------------------------------------------
  //
  // The claim `cell` band-limits detail and nothing else, tested where it matters:
  // the residual against the exact field must fall monotonically as the cell
  // shrinks, and vanish in the limit. This is what says the LOD ladder is a
  // low-pass sequence converging on the collision surface rather than a set of
  // independent approximations.
  console.log('\nband limit')
  {
    const leafCell = WORLD_SIZE / (1 << MAX_DEPTH) / CHUNK_RES
    const CELLS = [leafCell, 1, 16, 256]
    const rms = []
    for (const cell of CELLS) {
      let s2 = 0
      for (let i = 0; i < 800; i++) {
        const p = site(i)
        const d = field.heightAt(p.x, p.z, cell) - field.heightAt(p.x, p.z, 0)
        s2 += d * d
      }
      rms.push(Math.sqrt(s2 / 800))
    }
    console.log('        residual vs the exact field: ' + CELLS.map((c, i) => `${c >= 1 ? c : c.toFixed(4)} m cell -> ${rms[i].toFixed(4)} m`).join(',  '))
    let monotone = true
    for (let i = 1; i < rms.length; i++) if (!(rms[i] > rms[i - 1])) monotone = false
    check(monotone, 'residual grows monotonically with cell size')
    // WHAT THE 8 M CHUNK COSTS, in metres, measured rather than argued.
    //
    // This check used to read `rms[0] === 0`: the leaf cell IS the exact field,
    // bit for bit. That was TRUE at the old MAX_DEPTH 13, where a 6.25 cm cell
    // puts the band edges at lo = 12.5 cm and hi = 25 cm, so even LAMBDA_MIN's
    // 25 cm octave sat at the top edge with weight exactly 1 and the two
    // evaluations were the same arithmetic. At the 50 cm cell the edges are 1 m
    // and 2 m, which kills the 1 m, 50 cm and 25 cm octaves outright -- three,
    // not the one the depth ladder alone suggests, because the limiter is two
    // octaves wide.
    //
    // So the leaf is now an APPROXIMATION and the honest question is how good
    // one. The bound is the cell it came from: a residual comparable to the cell
    // would mean the mesh is missing relief it could have drawn, while a
    // residual an order of magnitude under it is relief no 50 cm mesh could
    // represent anyway. A tenth is the line. Measured it comes out near 1 cm --
    // and running the same probe at a 25 cm cell gives 0.37 cm, which is the
    // whole vertical payoff of a 4 m leaf. config.js's MAX_DEPTH banner spends
    // that number.
    check(rms[0] < leafCell / 10, 'the leaf cell costs an order of magnitude less than the cell itself', `${leafCell.toFixed(4)} m cell, residual ${(rms[0] * 100).toFixed(2)} cm, bound ${((leafCell / 10) * 100).toFixed(1)} cm`)
    // And the exact field is still a genuine LIMIT of the band-limited one rather
    // than a separate code path: below LAMBDA_MIN / 4 every octave is over 4x the
    // cell again and the residual returns to bit-exact zero. That is the property
    // the old leaf check was really protecting, and it survives the cap change.
    let s2 = 0
    for (let i = 0; i < 800; i++) {
      const p = site(i)
      const d = field.heightAt(p.x, p.z, LAMBDA_MIN / 4) - field.heightAt(p.x, p.z, 0)
      s2 += d * d
    }
    check(s2 === 0, 'and a cell under LAMBDA_MIN / 4 IS the exact field, bit for bit', `${(LAMBDA_MIN / 4).toFixed(4)} m cell, residual ${Math.sqrt(s2 / 800)}`)
    // The coarsest residual must still be bounded by the detail term's own total
    // amplitude -- if it exceeded that, the band limit would be adding energy
    // rather than removing it, which is what the transposed smoothstep does.
    const totalAmp = field.detail.table.reduce((s, t) => s + t.amp, 0)
    check(rms[rms.length - 1] < totalAmp, 'the band limit removes energy rather than adding it', `256 m residual ${rms[rms.length - 1].toFixed(3)} m < sum of amplitudes ${totalAmp.toFixed(3)} m`)
  }

  // --- 4. what an LOD swap actually moves ----------------------------------
  //
  // Reported in metres AND in arcminutes at the range that chunk is drawn from,
  // because the metres alone are unreadable: 40 cm at a leaf under her feet is a
  // stumble and 40 cm on a chunk two kilometres away is nothing. The range comes
  // from the split rule itself -- refine while cell > range * tan(triDeg) -- so a
  // chunk sits at range = cell / tan(3 deg) when it is on the point of splitting,
  // which is the worst case and the moment the swap happens.
  console.log('\nLOD swap magnitude')
  {
    const TAN_TRI = Math.tan((3.0 * Math.PI) / 180)
    const rows = []
    for (let d = MAX_DEPTH; d >= 4; d -= 3) {
      const cell = WORLD_SIZE / (1 << d) / CHUNK_RES
      let s2 = 0
      let worst = 0
      for (let i = 0; i < 600; i++) {
        const p = site(i)
        const diff = Math.abs(field.heightAt(p.x, p.z, cell) - field.heightAt(p.x, p.z, cell * 2))
        s2 += diff * diff
        if (diff > worst) worst = diff
      }
      const rms = Math.sqrt(s2 / 600)
      const range = cell / TAN_TRI
      rows.push({ d, cell, rms, worst, arcmin: (Math.atan(worst / range) * 180 * 60) / Math.PI, range })
    }
    for (const r of rows) {
      console.log(
        `        depth ${String(r.d).padStart(2)} (cell ${r.cell < 1 ? r.cell.toFixed(4) : r.cell.toFixed(1)} m): rms ${r.rms.toFixed(4)} m (${(r.rms / r.cell).toFixed(3)} cells), ` +
          `worst ${r.worst.toFixed(4)} m (${(r.worst / r.cell).toFixed(3)} cells), ${r.arcmin.toFixed(0)}' at the ${r.range.toFixed(0)} m split range`
      )
    }
    // The scale-free statement, and the one worth asserting: a swap must move the
    // surface by less than the cell it is resolving. That is what makes the
    // coarser level a low-pass of the finer one rather than a different surface,
    // and it is exactly what the band limit's fade is for -- what a swap removes
    // is one octave near the cell's own Nyquist, whose amplitude is a fraction of
    // the cell by construction. Transpose smoothstep's edges and this is where it
    // shows: the swap starts removing the octaves that carry the relief.
    const worstCells = Math.max(...rows.map((r) => r.worst / r.cell))
    const rmsCells = Math.max(...rows.map((r) => r.rms / r.cell))
    check(worstCells < 0.75, 'no LOD swap moves the surface by as much as one cell', `worst ${worstCells.toFixed(3)} cells`)
    check(rmsCells < 0.35, 'and typically by a fifth of one', `worst rms ${rmsCells.toFixed(3)} cells`)
    // In angular terms this peaks near 90 arcmin at the split range, which is half
    // of the 3 degrees a triangle subtends there. That is inherent to a fractal
    // field under a triangle-angle split rule and it is the quadtree's number to
    // move (MIN_TRI_DEG), not this module's -- reported here so it is a measured
    // quantity rather than an assumption on either side.
    console.log(`        worst angular swap: ${Math.max(...rows.map((r) => r.arcmin)).toFixed(0)}' -- half the 180' a triangle subtends at its split range`)
  }

  // --- 5. slope units, on a plane of known inclination ----------------------
  //
  // The one section that does not use the imported field, because the point is to
  // know the answer in advance. See the units banner at the top.
  console.log('\nslope units')
  {
    // The stride and the slope limit are read out of src/player.js as TEXT rather
    // than imported, because player.js imports three and this gate runs headless.
    // Reading them is not a workaround: it is what makes the coupling checkable,
    // so moving maxSlopeDeg there shows up here instead of quietly diverging.
    const src = await readFile(PLAYER_PATH, 'utf8')
    const maxSlopeDeg = Number(/maxSlopeDeg:\s*([0-9.]+)/.exec(src)[1])
    const stride = Number(/stride:\s*([0-9.]+)/.exec(src)[1])
    console.log(`        src/player.js: maxSlopeDeg ${maxSlopeDeg}, stride ${stride} m`)

    // rough pinned to a millionth of a metre so the plane, and not the fractal,
    // is what is being measured.
    const planeLayers = new Layers()
    let worst = 0
    for (const deg of [5, 20, 40, 55]) {
      const pf = new V2Height({ heightmap: planeHeightmap(deg), layers: planeLayers, seed: WORLD_SEED, rough: 1e-6 })
      for (let i = 0; i < 40; i++) {
        const p = site(i * 7)
        const got = (pf.slopeAt(p.x, p.z) * 180) / Math.PI
        worst = Math.max(worst, Math.abs(got - deg))
      }
    }
    check(worst < 0.05, 'V2Height.slopeAt returns RADIANS, the convention src/player.js compares against', `worst error ${worst.toFixed(4)} deg over planes at 5/20/40/55 deg`)

    // And the other convention is still available, under a name that cannot be
    // confused with it. 45 deg -> 0.5 is Heightmap.slopeAt's documented anchor.
    const p45 = new V2Height({ heightmap: planeHeightmap(45), layers: planeLayers, seed: WORLD_SEED, rough: 1e-6 })
    const s01 = p45.slope01At(0, 0)
    check(Math.abs(s01 - 0.5) < 0.01, 'V2Height.slope01At returns the 0..1 convention detail.js consumes', `45 deg -> ${s01.toFixed(4)}`)
    check(Math.abs(p45.slopeAt(0, 0) - Math.PI / 4) < 0.01, 'the two are demonstrably different numbers for the same ground', `radians ${p45.slopeAt(0, 0).toFixed(4)} vs 0..1 ${s01.toFixed(4)}`)

    // heightAt must be callable with two arguments, because Player and the editor
    // do exactly that and a required third would be a TypeError at walk time.
    check(field.heightAt(10, 20) === field.heightAt(10, 20, 0), 'heightAt(x, z) defaults cell to 0, the exact field', 'Player and the editor call it with two arguments')
  }

  // --- 6. what the detail term does to where she can walk ------------------
  //
  // §4's guarantee is about the composed field, and the detail term is the only
  // part of it that this module chose. Measured the way player.js measures it: a
  // rise over one stride, not a derivative -- anything shorter averages out under
  // a boot and a real cliff does not.
  console.log('\nwalkable fraction')
  {
    const src = await readFile(PLAYER_PATH, 'utf8')
    const maxTan = Math.tan((Number(/maxSlopeDeg:\s*([0-9.]+)/.exec(src)[1]) * Math.PI) / 180)
    const stride = Number(/stride:\s*([0-9.]+)/.exec(src)[1])
    const bare = walkableFraction((x, z) => hm.sample(x, z), maxTan, stride)
    const composed = walkableFraction((x, z) => field.heightAt(x, z), maxTan, stride)
    console.log(`        walkable over a ${stride} m stride: coarse field alone ${pct(bare)}, composed field ${pct(composed)}  (cost ${pct(bare - composed)})`)
    // The detail term is texture, not terrain. If it were closing off the world
    // the fine octaves would need damping -- which is what SLOPE_KNEE/HURST_FINE
    // in detail.js exist for, and this is the measurement that sets them.
    check(composed > bare - 0.05, 'fractal detail does not meaningfully close off the world', `${pct(bare - composed)} of the world lost to detail`)
    check(bare > 0.5, 'the imported relief is walkable in the first place', `${pct(bare)} of the coarse field is under the limit`)
  }

  // --- 7. the Z mirror-extension seam --------------------------------------
  //
  // The source image is not square: make-heightmap.mjs fits it to the world box
  // and mirror-extends the rows beyond its Z coverage. A mirror is C0 but not C1
  // -- the gradient flips sign across it -- so the risk is a ridge running the
  // full width of the map at the join, which reads as a mesher bug rather than as
  // an import artifact. Compared against the field's own typical step so the
  // check survives any vertical range.
  console.log('\nnorth-south continuity')
  {
    const dz = texel / 4
    const stepAt = (z) => {
      let s2 = 0
      for (let i = 0; i < 400; i++) {
        const x = (((i * 977) % 1000) / 1000 - 0.5) * WORLD_SIZE * 0.9
        const d = field.heightAt(x, z + dz) - field.heightAt(x, z - dz)
        s2 += d * d
      }
      return Math.sqrt(s2 / 400)
    }
    // Wherever the seam is, it is symmetric about the world centre and the fit is
    // stated in config.js's banner. Scan a band of candidate rows rather than
    // hardcoding one, so a change to the source image's aspect cannot make this
    // section silently measure empty ground.
    let worstZ = 0
    let worstStep = 0
    const typical = stepAt(0)
    for (let z = texel; z < WORLD_HALF - texel; z += texel) {
      const s = stepAt(z)
      if (s > worstStep) { worstStep = s; worstZ = z }
    }
    console.log(`        transect step over ${dz.toFixed(2)} m: typical ${typical.toFixed(4)} m at z=0, worst ${worstStep.toFixed(4)} m at z=${worstZ.toFixed(0)} m`)
    check(worstStep < typical * 6, 'no discontinuity anywhere on a north-south transect', `worst row is ${(worstStep / typical).toFixed(2)}x the centre row`)
  }

  // --- 8. composition order ------------------------------------------------
  console.log('\ncomposition order')
  {
    const doc = new Layers()
    const y = hm.sample(0, 0)
    // A river running north-south through the origin and a road running east-west
    // across it. The crossing is the whole test. The field is built before the
    // river is added because a river bakes against the terrain the field attaches,
    // and nodes come every 200 m so the probe below, 200 m up the channel, sits ON
    // a node rather than on a chord the router bowed off the line.
    const cf = new V2Height({ heightmap: hm, layers: doc, seed: WORLD_SEED })
    doc.addPath({ kind: 'river', depth: 4, pts: [-400, -200, 0, 200, 400].map((z) => [0, z, 12]) })
    doc.addPath({ kind: 'road', feather: 10, pts: [[-400, y, 0, 6], [0, y, 0, 6], [400, y, 0, 6]] })
    const lakeY = hm.sample(1000, 1000)
    doc.addLake({ x: 1000, z: 1000, y: lakeY, rx: 150, rz: 120, carve: 1, depth: 9 })

    // ROADS LAST. At the crossing the road's carriageway wins, so the answer is
    // the road's own y and not the river bed 4 m below it. Run the road first and
    // this reads bed height: a ford where the author drew a causeway.
    const atCrossing = cf.heightAt(0, 0)
    check(Math.abs(atCrossing - y) < 0.02, 'a road crossing a river reads as a causeway, not a ford', `crossing ${atCrossing.toFixed(3)} m vs road surface ${y.toFixed(3)} m, bed would be ${(y - 4).toFixed(3)} m`)

    // And the river is really carving where the road is not: 200 m up the channel.
    // The solved level comes back out of waterLevelAt -- the surface IS that level
    // and the bed is the authored depth below it less the terrain's own detail
    // term, which the channel keeps as its relief -- so the expectation is read
    // from the document and the detail field rather than recomputed here from
    // the ground taps and freeboard.
    const inChannel = cf.heightAt(0, 200)
    const levelY = doc.waterLevelAt(0, 200)
    const relief = cf.detail.at(0, 200, 0, hm.slopeAt(0, 200), 0)
    const bedY = levelY - Math.max(4 - relief, 4 * BED_SHOAL)
    const ground = hm.sample(0, 200)
    check(levelY < ground, 'the water sits in the ground, not on it', `level ${levelY.toFixed(3)} m under ground ${ground.toFixed(3)} m`)
    check(inChannel < ground - 3.9 + Math.max(relief, 0), 'the river carve reaches its authored depth', `bed ${inChannel.toFixed(3)} m, ${(ground - inChannel).toFixed(3)} m below the untouched ground, level ${levelY.toFixed(3)} m, depth 4 m, relief ${relief.toFixed(3)} m`)
    check(Math.abs(inChannel - bedY) < 0.01, 'the channel bottom sits depth below the water, less the detail term it keeps as relief', `${inChannel.toFixed(3)} m vs ${bedY.toFixed(3)} m (relief ${relief.toFixed(3)} m)`)
    check(Math.abs(cf.heightAt(0, 200, 16) - levelY + Math.max(4 - cf.detail.at(0, 200, 16, hm.slopeAt(0, 200), 0), 4 * BED_SHOAL)) < 0.01, 'and the bed relief is band-limited by the caller\'s cell, like the ground around it', `cell 16: ${cf.heightAt(0, 200, 16).toFixed(3)} m`)

    // The lake basin sits below its water level, or it is not a lake.
    const bed = cf.heightAt(1000, 1000)
    check(bed < lakeY - 8, 'a carving lake puts its bed below its water level', `bed ${bed.toFixed(2)} m, level ${lakeY.toFixed(2)} m, depth 9 m`)
    check(doc.waterLevelAt(1000, 1000) === lakeY, 'and the water surface is the authored level', `${lakeY.toFixed(2)} m`)

    // Detail is suppressed on authored surfaces: fbm on a road is potholes.
    const roadDetail = Math.abs(cf.heightAt(120, 0) - cf.heightAt(122, 0))
    const wildDetail = Math.abs(cf.heightAt(120, 900) - cf.heightAt(122, 900))
    check(roadDetail < wildDetail, 'flattening suppresses the fractal on the carriageway', `road ${roadDetail.toFixed(4)} m vs open ground ${wildDetail.toFixed(4)} m over 2 m`)
  }

  // --- 9. the empty-document fast path -------------------------------------
  //
  // Counted, not timed only: a timing that happens to be fast proves nothing
  // about whether the branch exists. The spy proves the carve chain is never
  // entered; the timing says what that is worth.
  console.log('\nempty-document fast path')
  {
    const empty = new Layers()
    let calls = 0
    const spy = (obj, name) => {
      const orig = obj[name].bind(obj)
      obj[name] = (...a) => { calls++; return orig(...a) }
    }
    spy(empty, 'carve')
    spy(empty, 'flattenAt')
    const ef = new V2Height({ heightmap: hm, layers: empty, seed: WORLD_SEED })
    for (let i = 0; i < 2000; i++) { const p = site(i); ef.heightAt(p.x, p.z) }
    check(calls === 0, 'an unedited document never enters the carve chain', `${calls} layer calls over 2000 queries`)

    // The spy must be capable of firing, or the check above is measuring nothing.
    empty.addLake({ x: 0, z: 0, y: 0, rx: 100, rz: 100, carve: 1, depth: 5 })
    calls = 0
    for (let i = 0; i < 200; i++) { const p = site(i); ef.heightAt(p.x, p.z) }
    check(calls === 400, 'and the spy fires once the document is authored', `${calls} layer calls over 200 queries`)

    // The epoch trap: a NEW Layers restarts at epoch 0, so swapping documents by
    // assignment would leave the cached flag stale. setLayers is the fix and this
    // is the assertion that keeps it.
    const authored = new Layers()
    authored.addLake({ x: 0, z: 0, y: 0, rx: 100, rz: 100, carve: 1, depth: 5 })
    const swap = new V2Height({ heightmap: hm, layers: new Layers(), seed: WORLD_SEED })
    check(swap.authored === false, 'a fresh field over an empty document reports unauthored')
    swap.setLayers(authored)
    check(swap.authored === true, 'setLayers re-reads authorship across two epoch-0 documents', 'the trap that would hide every freshly loaded river')

    // What the branch buys, on the same query set.
    const timed = (f) => {
      for (let i = 0; i < 4000; i++) { const p = site(i); f(p.x, p.z) }
      const t0 = performance.now()
      for (let i = 0; i < 40000; i++) { const p = site(i); f(p.x, p.z) }
      return performance.now() - t0
    }
    const fastField = new V2Height({ heightmap: hm, layers: new Layers(), seed: WORLD_SEED })
    const slowField = new V2Height({ heightmap: hm, layers: authored, seed: WORLD_SEED })
    const tFast = timed((x, z) => fastField.heightAt(x, z))
    const tSlow = timed((x, z) => slowField.heightAt(x, z))
    console.log(`        40k queries: empty document ${tFast.toFixed(1)} ms, authored document ${tSlow.toFixed(1)} ms (${(tSlow / tFast).toFixed(2)}x)`)
    check(tSlow > tFast, 'the carve chain costs something, so skipping it saves something', `${(tSlow / tFast).toFixed(2)}x`)
  }

  // --- 10. mesher invariants -----------------------------------------------
  console.log('\nmesher invariants')
  {
    const size = WORLD_SIZE / (1 << 8)
    const r = buildChunkV2(field, layers, { ox: 512, oz: -1024, size, res: CHUNK_RES, cam: CAM })
    const vpr = CHUNK_RES + 1
    const inner = vpr * vpr

    check(r.positions.length === CHUNK_VERTS * 3, 'vertex count matches config exactly', `${r.positions.length / 3} of ${CHUNK_VERTS}`)
    check(r.indices.length === CHUNK_INDICES, 'index count matches config exactly', `${r.indices.length} of ${CHUNK_INDICES}`)

    let nan = 0
    for (const a of [r.positions, r.normals, r.colors]) for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) nan++
    check(nan === 0, 'no NaN in positions, normals or colours', `${nan} non-finite values`)

    let outside = 0
    for (let v = 0; v < inner; v++) {
      const y = r.positions[v * 3 + 1]
      if (y < r.minY - 1e-4 || y > r.maxY + 1e-4) outside++
    }
    check(outside === 0, 'minY/maxY bracket every surface vertex', `${outside} outside`)

    // The skirt is a copy of its edge vertex pushed straight down. Anything else
    // and the flange leans, which shows through the crack it is filling.
    let skirtBad = 0
    let sv = inner
    const edgeOrder = []
    for (let i = 0; i <= CHUNK_RES; i++) edgeOrder.push(i)
    for (let i = CHUNK_RES; i >= 0; i--) edgeOrder.push(CHUNK_RES * vpr + i)
    for (let j = CHUNK_RES; j >= 0; j--) edgeOrder.push(j * vpr)
    for (let j = 0; j <= CHUNK_RES; j++) edgeOrder.push(j * vpr + CHUNK_RES)
    for (const vi of edgeOrder) {
      const a = sv * 3
      const b = vi * 3
      if (r.positions[a] !== r.positions[b]) skirtBad++
      if (r.positions[a + 2] !== r.positions[b + 2]) skirtBad++
      if (Math.abs(r.positions[a + 1] - (r.positions[b + 1] - r.skirtDepth)) > 1e-4) skirtBad++
      sv++
    }
    check(sv === CHUNK_VERTS, 'the skirt ring is exactly the four edges', `${sv - inner} skirt vertices`)
    check(skirtBad === 0, `every skirt vertex hangs exactly skirtDepth below its edge vertex`, `skirtDepth ${r.skirtDepth.toFixed(3)} m, ${skirtBad} deviations`)

    // The stipple frame: one vec4 per vertex, its tile sized to THAT vertex's
    // distance from the camera, so a chunk is not one scale end to end; its
    // plane the normal's dominant axis; its offset placing the chunk on the
    // world tiling of that plane so neighbours at one scale share a sheet.
    check(r.stipple.length === CHUNK_VERTS * 4, 'stipple frame is one vec4 per vertex', `${r.stipple.length / 4} of ${CHUNK_VERTS}`)
    const frac = (v) => Math.fround((((v % 1) + 1) % 1))
    let kBad = 0
    let offBad = 0
    let pow2Bad = 0
    let planeBad = 0
    const ks = new Set()
    const planes = new Set()
    for (let v = 0; v < inner; v++) {
      const wx = 512 + r.positions[v * 3]
      const wy = r.positions[v * 3 + 1]
      const wz = -1024 + r.positions[v * 3 + 2]
      const k = r.stipple[v * 4]
      if (k !== Math.fround(stippleTilesPerM(Math.hypot(wx - CAM.x, wy - CAM.y, wz - CAM.z)))) kBad++
      const tileStep = Math.log2(1 / (k * STIPPLE_TILE_MIN))
      if (Math.abs(tileStep - Math.round(tileStep)) > 1e-6 || tileStep < 0) pow2Bad++
      const plane = r.stipple[v * 4 + 3]
      if (!(plane === 0 || plane === 1 || plane === 2)) planeBad++
      const ou = r.stipple[v * 4 + 1]
      const ov = r.stipple[v * 4 + 2]
      const wantU = plane === 1 ? frac(k * -1024) : frac(k * 512)
      const wantV = plane === 0 ? frac(k * -1024) : 0
      if (Math.abs(ou - wantU) > 1e-6 || Math.abs(ov - wantV) > 1e-6) offBad++
      ks.add(k)
      planes.add(plane)
    }
    check(kBad === 0, 'every vertex tiles the stipple at stippleTilesPerM(distance)', `${kBad} of ${inner} off`)
    check(pow2Bad === 0, 'every tile is the minimum times a power of two', `${pow2Bad} of ${inner} off`)
    check(planeBad === 0, 'every vertex names one of the three planes', `${planeBad} of ${inner} off`)
    check(offBad === 0, 'stipple offsets are frac(k * chunk origin) on the plane\'s axes', `${offBad} wrong`)
    check(ks.size === 1, 'a chunk a kilometre out sits inside one tile step', `${ks.size} distinct scales`)
    check(planes.has(0), 'the chunk has walkable ground on the xz plane', `planes ${[...planes].join(',')}`)
    // A chunk under the camera straddles several steps: the tile is the
    // minimum at the feet and doubles outward.
    {
      const near = buildChunkV2(field, layers, { ox: -size / 2, oz: -size / 2, size, res: CHUNK_RES, cam: { x: 0, y: field.heightAt(0, 0) + 1.6, z: 0 } })
      const kMid = near.stipple[((vpr >> 1) * vpr + (vpr >> 1)) * 4]
      const kCorner = near.stipple[0]
      check(kMid === Math.fround(1 / STIPPLE_TILE_MIN), 'the vertex under the feet gets the minimum tile', `${(1 / kMid).toFixed(2)} m`)
      check(kCorner < kMid, 'the corner of the chunk under the feet gets a coarser tile than its middle', `${(1 / kCorner).toFixed(2)} m vs ${(1 / kMid).toFixed(2)} m`)
    }
    // The plane pick, on ground that is exactly a plane rising along x: past
    // 45 degrees the geometric normal's x beats its y and the tile goes onto
    // zy. 40 degrees is inside the band where the shading bump alone would
    // tip some vertices over, which is why the pick reads the slope, not the
    // normal in the buffer.
    {
      const planeLayers = new Layers()
      const planeOf = (deg) => {
        const pf = new V2Height({ heightmap: planeHeightmap(deg), layers: planeLayers, seed: WORLD_SEED, rough: 1e-6 })
        const pr = buildChunkV2(pf, planeLayers, { ox: 0, oz: 0, size, res: CHUNK_RES, cam: CAM })
        const got = new Set()
        for (let v = 0; v < inner; v++) got.add(pr.stipple[v * 4 + 3])
        return [...got].join(',')
      }
      check(planeOf(40) === '0', 'a 40 degree slope keeps the xz plane', `planes ${planeOf(40)}`)
      check(planeOf(55) === '1', 'a 55 degree slope facing x takes the zy plane', `planes ${planeOf(55)}`)
    }
    let skirtFrame = 0
    sv = inner
    for (const vi of edgeOrder) {
      for (let c = 0; c < 4; c++) if (r.stipple[sv * 4 + c] !== r.stipple[vi * 4 + c]) skirtFrame++
      sv++
    }
    check(skirtFrame === 0, 'every skirt vertex carries its edge vertex\'s stipple frame', `${skirtFrame} deviations`)

    // Winding, in the XZ projection: every surface triangle must come out
    // counter-clockwise seen from above, or it is invisible from the only side
    // anyone stands on.
    const crossY = (a, b, c) => {
      const v1x = r.positions[b * 3] - r.positions[a * 3]
      const v1z = r.positions[b * 3 + 2] - r.positions[a * 3 + 2]
      const v2x = r.positions[c * 3] - r.positions[a * 3]
      const v2z = r.positions[c * 3 + 2] - r.positions[a * 3 + 2]
      return v1z * v2x - v1x * v2z
    }
    let wrong = 0
    const surfaceTris = CHUNK_RES * CHUNK_RES * 2
    for (let t = 0; t < surfaceTris; t++) {
      if (crossY(r.indices[t * 3], r.indices[t * 3 + 1], r.indices[t * 3 + 2]) <= 0) wrong++
    }
    check(wrong === 0, 'every surface triangle winds counter-clockwise from above', `${wrong} of ${surfaceTris} inverted`)

    // Skirt winding: the horizontal part of each flange's normal must point AWAY
    // from the chunk. Facing inward makes the skirts invisible from outside,
    // which is the only place they are ever seen.
    let inward = 0
    const cx = (CHUNK_RES * size) / CHUNK_RES / 2
    for (let t = surfaceTris; t < CHUNK_INDICES / 3; t++) {
      const a = r.indices[t * 3]
      const b = r.indices[t * 3 + 1]
      const c = r.indices[t * 3 + 2]
      const ux = r.positions[b * 3] - r.positions[a * 3]
      const uy = r.positions[b * 3 + 1] - r.positions[a * 3 + 1]
      const uz = r.positions[b * 3 + 2] - r.positions[a * 3 + 2]
      const wx = r.positions[c * 3] - r.positions[a * 3]
      const wy = r.positions[c * 3 + 1] - r.positions[a * 3 + 1]
      const wz = r.positions[c * 3 + 2] - r.positions[a * 3 + 2]
      const nx = uy * wz - uz * wy
      const nz = ux * wy - uy * wx
      // Chunk-local centroid of the triangle, relative to the chunk centre.
      const mx = (r.positions[a * 3] + r.positions[b * 3] + r.positions[c * 3]) / 3 - cx
      const mz = (r.positions[a * 3 + 2] + r.positions[b * 3 + 2] + r.positions[c * 3 + 2]) / 3 - cx
      if (nx * mx + nz * mz <= 0) inward++
    }
    check(inward === 0, 'every skirt triangle faces outward', `${inward} of ${CHUNK_INDICES / 3 - surfaceTris} facing in`)

    // The res guard. A chunk of a different size is not a smaller chunk -- it is
    // memory corruption in the shape of terrain, because terrain-v2.js recycles
    // fixed-size BatchedMesh slots.
    let threw = false
    try { buildChunkV2(field, layers, { ox: 0, oz: 0, size, res: CHUNK_RES + 1, cam: CAM }) } catch { threw = true }
    check(threw, 'a res that does not match config throws rather than meshing', `res ${CHUNK_RES + 1}`)
  }

  // --- 11. no seam between chunks -------------------------------------------
  //
  // THE EXTRA SAMPLING RING, tested directly. Four sibling chunks at the same
  // depth share three interior edges; every vertex on a shared edge is the same
  // world point sampled at the same cell, so the normals must be IDENTICAL, not
  // merely close. Without the ring each chunk computes its edge normal from a
  // one-sided difference and the two disagree by whatever the terrain does across
  // that edge -- a lighting seam along every chunk join, brightest exactly when
  // the sun is lowest, which in this game is most of the time.
  //
  // Confirmed able to fail, by actually doing it: chunk-mesh-v2.js was temporarily
  // cut back to epr = res + 1 -- sampling only the chunk's own vertices and
  // clamping the central difference to a one-sided difference at the border -- and
  // this section reported a worst shared-edge normal component disagreement of
  // 0.548 against the 1e-6 tolerance below, while every other check in the file
  // stayed green. Half a unit of normal is roughly 33 deg of surface tilt
  // disagreeing across a join that both chunks think they render identically.
  // Restored immediately after.
  console.log('\nchunk seams')
  {
    const parentSize = WORLD_SIZE / (1 << 7)
    const ox = -parentSize
    const oz = parentSize * 2
    const half = parentSize / 2
    const kids = []
    for (let q = 0; q < 4; q++) {
      kids.push(buildChunkV2(field, layers, { ox: ox + (q & 1) * half, oz: oz + (q >> 1) * half, size: half, res: CHUNK_RES, cam: CAM }))
    }
    const vpr = CHUNK_RES + 1
    let worst = 0
    // West-east pairs: child 0's east column against child 1's west column, and
    // child 2 against child 3. Then north-south: 0 against 2, 1 against 3.
    const compare = (a, b, ia, ib) => {
      for (let n = 0; n <= CHUNK_RES; n++) {
        const va = ia(n) * 3
        const vb = ib(n) * 3
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a.normals[va + c] - b.normals[vb + c]))
      }
    }
    compare(kids[0], kids[1], (n) => n * vpr + CHUNK_RES, (n) => n * vpr)
    compare(kids[2], kids[3], (n) => n * vpr + CHUNK_RES, (n) => n * vpr)
    compare(kids[0], kids[2], (n) => CHUNK_RES * vpr + n, (n) => n)
    compare(kids[1], kids[3], (n) => CHUNK_RES * vpr + n, (n) => n)
    console.log(`        worst normal component disagreement across four shared edges: ${worst.toExponential(2)}`)
    check(worst < 1e-6, 'adjacent chunks agree on their shared edge normals', 'the extra sampling ring, measured')

    // Positions have to agree too, or the ring is fixing lighting over a crack.
    let posWorst = 0
    for (let n = 0; n <= CHUNK_RES; n++) {
      posWorst = Math.max(posWorst, Math.abs(kids[0].positions[(n * vpr + CHUNK_RES) * 3 + 1] - kids[1].positions[n * vpr * 3 + 1]))
    }
    check(posWorst < 1e-6, 'and on their shared edge heights', `${posWorst.toExponential(2)} m`)
  }

  // --- 12. vertex colour must not depend on LOD ----------------------------
  //
  // Same 400-site methodology as scripts/check-terrain.mjs's "surface colour vs
  // LOD" section, deliberately, so the two percentages can be read side by side.
  // Per-vertex disagreement is expected and allowed: a 512 m vertex cannot resolve
  // a 20 m snowfield, so it can only report an unbiased sample of the steepness
  // around it. What must not happen is a systematic DRIFT, because that is what
  // the eye reads as a flash.
  console.log('\nsurface colour vs LOD')
  {
    const isSnow = (b) => b > 0.45

    // One change from v1's version of this test, and it is an improvement to the
    // instrument rather than to the code under test. v1 colours a site by rounding
    // it to the nearest vertex of whichever chunk contains it, which at its
    // coarsest depth is a 128 m grid -- so it compares the colour of a point at
    // the leaf against the colour of a point up to 90 m away at depth 2, and the
    // sites were SELECTED for being above the snow line, so the neighbour is
    // biased low. That quantisation error read as an 11-point drift here and it
    // is not an LOD artifact at all.
    //
    // Instead each site is placed exactly on vertex (8, 8) of a chunk built for
    // it. Nothing else moves -- same 400 sites, same isSnow threshold, same
    // depths -- so the percentages stay comparable with scripts/check-terrain.mjs
    // while measuring only what the section is named for: the same ground, at the
    // same coordinates, painted at different cell sizes.
    const colorAt = (x, z, depth) => {
      const step = WORLD_SIZE / (1 << depth) / CHUNK_RES
      const half = CHUNK_RES / 2
      const c = buildChunkV2(field, layers, { ox: x - half * step, oz: z - half * step, size: step * CHUNK_RES, res: CHUNK_RES, cam: CAM })
      return c.colors[(half * (CHUNK_RES + 1) + half) * 3 + 2]
    }

    // Only ground that can hold snow; below the line every depth agrees trivially
    // and would dilute the statistic to nothing.
    const sites = []
    for (let i = 0; sites.length < 400 && i < 400000; i++) {
      const p = site(i)
      if (field.heightAt(p.x, p.z) > field.snowLineAt(p.x, p.z)) sites.push(p)
    }
    console.log(`        snow line ${layers.snow.base} m (base) + ${layers.snow.band} m band; field p50 ${bands.p50.toFixed(1)} m, p90 ${bands.p90.toFixed(1)} m, max ${bands.max.toFixed(1)} m`)
    check(sites.length === 400, 'there is ground above the snow line to measure', `found ${sites.length} of 400 sites -- a snow base above the terrain puts snow nowhere at all, which is exactly the failure v1 hit twice`)

    if (sites.length === 400) {
      const DEPTHS = [MAX_DEPTH, 8, 6, 4, 2]
      const white = new Map()
      const flags = new Map()
      for (const d of DEPTHS) {
        const f = sites.map((s) => isSnow(colorAt(s.x, s.z, d)))
        flags.set(d, f)
        white.set(d, f.filter(Boolean).length / sites.length)
      }
      console.log('        white fraction by depth: ' + DEPTHS.map((d) => `${d}:${pct(white.get(d))}`).join('  '))
      const leaf = flags.get(MAX_DEPTH)
      const coarse = flags.get(2)
      const flips = leaf.reduce((n, v, i) => n + (v === coarse[i] ? 0 : 1), 0) / sites.length
      console.log(`        per-site flip between depth ${MAX_DEPTH} and depth 2: ${pct(flips)}`)

      let worst = 0
      let worstDepth = MAX_DEPTH
      for (const d of DEPTHS) {
        const drift = Math.abs(white.get(d) - white.get(MAX_DEPTH))
        if (drift > worst) { worst = drift; worstDepth = d }
      }
      check(worst < 0.06, 'snow coverage does not drift as chunks coarsen', `worst ${(worst * 100).toFixed(1)} points at depth ${worstDepth}, leaf ${pct(white.get(MAX_DEPTH))}`)
      let up = 0
      for (const d of DEPTHS) if (white.get(d) > white.get(MAX_DEPTH)) up++
      check(up < DEPTHS.length - 1, 'coarsening does not whiten the world monotonically', `${up}/${DEPTHS.length - 1} coarser levels whiter than the leaf`)

      // AND THE INSTRUMENT CAN SEE A DRIFT.
      //
      // The two checks above come out at zero, which is the right answer and also
      // indistinguishable from a test that measures nothing. The control is the
      // same shade(), fed the one thing CLASS_EPS exists to replace: steepness from
      // the MESH normal, a central difference over the chunk's own cell. That is
      // what v1 shipped before its fix.
      //
      // It runs on a DIFFERENT population, and the reason is worth recording. The
      // 400 sites above are chosen for altitude, and on the imported map that
      // makes them overwhelmingly saturated -- 148 m snow base against a p50 of
      // 151 m, so most of them are past the top of the smoothstep where no
      // steepness changes the answer. Run there, the control drifts 1.0 point and
      // proves nothing. The classification only has an opinion inside shade()'s
      // rock knee, ny 0.62..0.86, which is 2.9% of the world at CLASS_EPS: this map
      // is smooth at texel scale (99.9% walkable) but not flat, and the cliffs it
      // does have are where all the scale sensitivity lives. So the control draws
      // its own sites from inside that knee and pairs them: identical sites,
      // identical depths, one knob moved.
      const nyAt = (x, z, cell) => {
        const gx = (field.heightAt(x + cell, z, cell) - field.heightAt(x - cell, z, cell)) / (2 * cell)
        const gz = (field.heightAt(x, z + cell, cell) - field.heightAt(x, z - cell, cell)) / (2 * cell)
        return 1 / Math.hypot(gx, 1, gz)
      }
      const knee = []
      for (let i = 0; knee.length < 400 && i < 400000; i++) {
        const p = site(i + 900000)
        const n = nyAt(p.x, p.z, CLASS_EPS)
        if (n > 0.62 && n < 0.86) knee.push(p)
      }
      check(knee.length === 400, 'there is steep ground to run the control on', `${knee.length} of 400 sites inside shade()'s rock knee`)

      const out = [0, 0, 0]
      const paint = (s, cell, useMeshNormal) => {
        shade(field.heightAt(s.x, s.z, cell), useMeshNormal ? nyAt(s.x, s.z, cell) : nyAt(s.x, s.z, CLASS_EPS), field.snowLineAt(s.x, s.z), layers.snow.band, 0, bands.altLo, bands.altSpan, s.x, s.z, out, 0)
        return isSnow(out[2])
      }
      const fixedWhite = new Map()
      const meshWhite = new Map()
      for (const d of DEPTHS) {
        const cell = WORLD_SIZE / (1 << d) / CHUNK_RES
        fixedWhite.set(d, knee.filter((s) => paint(s, cell, false)).length / knee.length)
        meshWhite.set(d, knee.filter((s) => paint(s, cell, true)).length / knee.length)
      }
      console.log('        on knee sites, CLASS_EPS  : ' + DEPTHS.map((d) => `${d}:${pct(fixedWhite.get(d))}`).join('  '))
      console.log('        on knee sites, MESH normal: ' + DEPTHS.map((d) => `${d}:${pct(meshWhite.get(d))}`).join('  '))
      let ctrlWorst = 0
      let fixedWorst = 0
      for (const d of DEPTHS) {
        ctrlWorst = Math.max(ctrlWorst, Math.abs(meshWhite.get(d) - meshWhite.get(MAX_DEPTH)))
        fixedWorst = Math.max(fixedWorst, Math.abs(fixedWhite.get(d) - fixedWhite.get(MAX_DEPTH)))
      }
      check(ctrlWorst > 0.06, 'and the measurement can see a drift -- the mesh normal fails it badly', `${(ctrlWorst * 100).toFixed(1)} points of drift without CLASS_EPS`)
      check(fixedWorst * 4 < ctrlWorst, 'CLASS_EPS is what removes it, on the same sites', `${(fixedWorst * 100).toFixed(1)} points with it vs ${(ctrlWorst * 100).toFixed(1)} without`)
    }

    // The altitude ramp, asserted as relationships. Every number here is measured
    // off the loaded image; none of them is written down anywhere.
    console.log(
      `        altitude ramp: p10 ${bands.p10.toFixed(1)}  p25 ${bands.p25.toFixed(1)}  p50 ${bands.p50.toFixed(1)}  ` +
        `p75 ${bands.p75.toFixed(1)}  p90 ${bands.p90.toFixed(1)}  p99 ${bands.p99.toFixed(1)} m  ->  altLo ${bands.altLo.toFixed(1)} m, span ${bands.altSpan.toFixed(1)} m`
    )
    check(bands.altSpan > 0, 'the altitude ramp is monotone increasing', `span ${bands.altSpan.toFixed(2)} m`)
    check(bands.altLo >= bands.min && bands.altLo + bands.altSpan <= bands.max, 'the ramp lies inside the relief it was cut from', `${bands.altLo.toFixed(1)}..${(bands.altLo + bands.altSpan).toFixed(1)} within ${bands.min.toFixed(1)}..${bands.max.toFixed(1)}`)
    check(bands.p25 <= bands.p50 && bands.p50 <= bands.p75 && bands.p75 <= bands.p90, 'the percentile ladder is ordered', 'histogram sanity')
    // Against snowDefaults(bands) and NOT against `layers.snow`, which is doc.js's
    // fallback: that pair of literals is what a document gets when there is no
    // heightmap in the room, and every gate in here is exactly that case. The
    // browser derives its line from the loaded image, so the browser's line is
    // the one that has to sit inside the relief -- and re-baking with a different
    // --maxY moves the percentiles under it without touching the fallback.
    const snow = snowDefaults(bands)
    check(snow.base > bands.altLo, 'the snow line sits above the foot of the altitude ramp', `snow base ${snow.base.toFixed(1)} m vs altLo ${bands.altLo.toFixed(1)} m`)
    // Half a band, because shade() centres the transition on the line: it opens at
    // base - band/2 and closes at base + band/2. A world whose top is inside that
    // ramp has no fully white ground anywhere, which is the "snow nowhere at all"
    // failure with an extra step.
    check(snow.base + snow.band / 2 < bands.max, 'and the snow band closes below the highest ground', `${(snow.base + snow.band / 2).toFixed(1)} m vs max ${bands.max.toFixed(1)} m`)
  }

  // --- 13. the plain rung, and the grass standing in it ---------------------
  //
  // THE MESHER'S COLOUR IS NOT THE COLOUR ANYTHING IS DRAWN. What reaches the
  // eye is shade() times whatever the terrain material does over it, and with the
  // plain rung shipping that is now two multiplies in the VERTEX shader rather
  // than a fragment chain. Two things have to hold and neither is visible from
  // one file:
  //
  //   The blade bed takes its foot colour from TerrainTint on the CPU, so that
  //   replay has to agree with the GLSL, EXACTLY -- a blade whose base is a
  //   different green from the ground it grows out of is the one failure the
  //   whole terrain-match trick exists to avoid. So the numbers are read back OUT
  //   of the emitted shader source rather than restated here: change
  //   PLAIN_GRASS_TONE and both sides move, change one side alone and this fails.
  //
  //   And the level swing has to leave grass classified as grass. shade() scales
  //   all three channels together, so it scales the margin the vegetation knee is
  //   measured on, and MOTTLE_VALUE is the one knob that can push mottled meadow
  //   under it -- at which point the shader stops treating it as vegetation and
  //   the tone above stops being applied, in patches, because the mottle is
  //   patchy. See the C_MOSS banner in chunk-mesh-v2.js for the arithmetic.
  console.log('\nthe plain rung')
  {
    const shaded = createTerrainMaterial()
    const plainMat = createPlainTerrainMaterial(shaded)
    const src = { vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: '', uniforms: {} }
    plainMat.onBeforeCompile(src)

    // SWIZZLED, and the pattern says so on purpose: the headset's three declares
    // vColor a vec4, so a bare assignment there does not compile at all. What
    // catches that is check-shaders, which compiles this rung against the vec4;
    // matching the same spelling here keeps the two gates describing one shader.
    const toneLine = src.vertexShader.match(/vColor\.rgb \*= mix\( vec3\( 1\.0 \), uGrassTone, auroraGreenBase \* ([0-9.]+) \);/)
    check(toneLine !== null, 'the plain rung applies uGrassTone in the vertex shader, scaled by the green mask')
    check(/vColor\.rgb \*= mix\( 1\.0, uSnowAlbedo, auroraVertexSnow \);/.test(src.vertexShader),
      'and uSnowAlbedo, without which C_SNOW under a 2.1 sun clips to a flat white sheet')
    if (!toneLine) {
      throw new Error('check-v2-field: the plain rung no longer emits the uGrassTone line this section reads its factor out of -- the pattern above and createPlainTerrainMaterial have drifted apart')
    }
    const toneK = Number(toneLine[1])
    check(toneK > 0 && toneK < 1, 'at PART of full strength -- the whole multiply is tuned against a fragment chain that is no longer there', `${toneK}`)

    // The knees are lifted from the GLSL for the same reason the factor is: they
    // are the fragment stage's auroraGreenBase and auroraVertexSnow, and a rung
    // that classified the surface differently would move the surfaces as well as
    // their level.
    const knee = src.vertexShader.match(/auroraGreenBase = smoothstep\( ([0-9.]+), ([0-9.]+), vColor\.g - max\( vColor\.r, vColor\.b \) \)/)
    check(knee !== null, 'and it classifies vegetation off the same knee the fragment rungs use')
    if (!knee) {
      throw new Error('check-v2-field: the plain rung no longer emits the auroraGreenBase line this section reads its knee out of')
    }

    const tint = new TerrainTint(shaded, layers, bands, 'plain')
    const tone = shaded.userData.uniforms.uGrassTone.value
    const out = [0, 0, 0]
    const nyAt = (x, z) => {
      const gx = (field.heightAt(x + CLASS_EPS, z, CLASS_EPS) - field.heightAt(x - CLASS_EPS, z, CLASS_EPS)) / (2 * CLASS_EPS)
      const gz = (field.heightAt(x, z + CLASS_EPS, CLASS_EPS) - field.heightAt(x, z - CLASS_EPS, CLASS_EPS)) / (2 * CLASS_EPS)
      return 1 / Math.hypot(gx, 1, gz)
    }

    // MEADOW SITES ARE PICKED BY GEOMETRY, NOT BY COLOUR. The knee is the thing
    // under test, so selecting on it would only prove that ground the knee likes
    // is ground the knee likes. Low, shallow and below the snow band is C_GRASS by
    // construction in shade(), whatever the mottle then does to it.
    let worst = 0
    let lowVeg = 1
    let meadow = 0
    let moved = 0
    const rgb = [0, 0, 0]
    for (let i = 0; i < 6000; i++) {
      const p = site(i + 4200000)
      const ny = nyAt(p.x, p.z)
      const h = field.heightAt(p.x, p.z, CLASS_EPS)
      const snowLine = field.snowLineAt(p.x, p.z)

      // What the mesher writes, and then what the GLSL above does to it.
      shade(h, ny, snowLine, layers.snow.band, 0, bands.altLo, bands.altSpan, p.x, p.z, out, 0)
      const green = smoothstep(Number(knee[1]), Number(knee[2]), out[1] - Math.max(out[0], out[2]))
      const drawn = [
        out[0] * (1 + (tone.r - 1) * green * toneK),
        out[1] * (1 + (tone.g - 1) * green * toneK),
        out[2] * (1 + (tone.b - 1) * green * toneK),
      ]

      // And what a blade planted there is painted.
      tint.groundAt(rgb, p.x, p.z, h, ny, snowLine)
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(rgb[c] - drawn[c]))

      if (clamp01((h - bands.altLo) / bands.altSpan) < 0.3 && ny > 0.95 && h < snowLine - layers.snow.band) {
        meadow++
        lowVeg = Math.min(lowVeg, green)
        if (Math.abs(rgb[0] - out[0]) > 1e-9) moved++
      }
    }
    check(worst < 1e-12, "a blade's foot is painted the colour the plain rung draws that ground",
      `worst channel disagreement ${worst.toExponential(1)}`)
    check(meadow > 50, 'there is meadow in this world to run the classification on', `${meadow} of 6000 sites`)
    check(moved === meadow, 'and the instrument can see a disagreement -- the tone moves every one of them',
      `${moved}/${meadow} moved by the tone`)
    // 0.75 AND NOT THE MEASURED 0.89. What is being defended is that the mottle
    // cannot switch vegetation OFF in patches -- the failure is the shader picking
    // the rock grit layer and skipping the moss and the tone across a meadow, and
    // it arrives patchy because the mottle is. A bar set just under today's
    // reading would fail on any retune of the palette that is still perfectly
    // safe; a bar at the knee's own midpoint fails when the margin is genuinely
    // being spent.
    check(lowVeg > 0.75, 'the doubled level swing leaves the darkest meadow still classified as vegetation',
      `worst meadow site ${lowVeg.toFixed(3)} vegetated`)

    // The snow half of the same knob, from the source: the two constants are not
    // exported and the value they defend is a LOOK, so what is asserted is the
    // relationship the comment states rather than either number.
    const meshSrc = await readFile(MESH_PATH, 'utf8')
    const ground = Number(meshSrc.match(/const MOTTLE_VALUE = ([0-9.]+)/)[1])
    const onSnow = Number(meshSrc.match(/const MOTTLE_VALUE_SNOW = ([0-9.]+)/)[1])
    check(ground > onSnow, 'snow takes a smaller level swing than ground -- it is an order of magnitude brighter, so the same fraction is a far larger step',
      `${ground} on ground, ${onSnow} on snow`)
  }

  // --- 14. mesher throughput ------------------------------------------------
  console.log('\nmesher throughput')
  {
    const authored = new Layers()
    const y = hm.sample(0, 0)
    const af = new V2Height({ heightmap: hm, layers: authored, seed: WORLD_SEED })
    authored.addPath({ kind: 'river', depth: 3, pts: [[-2000, -2000, 10], [0, 0], [2000, 2000, 10]] })
    authored.addPath({ kind: 'road', feather: 12, pts: [[-2000, y, 1000, 5], [2000, y, -1000, 5]] })
    authored.addLake({ x: 300, z: 300, y, rx: 400, rz: 300, carve: 1, depth: 8 })
    af.bands

    const bench = (f, lyr, label) => {
      const size = WORLD_SIZE / (1 << 9)
      const specs = []
      for (let n = 0; n < 64; n++) specs.push({ ox: -1024 + (n % 8) * size, oz: -1024 + Math.floor(n / 8) * size, size, res: CHUNK_RES, cam: CAM })
      for (const s of specs) buildChunkV2(f, lyr, s)
      const t0 = performance.now()
      for (const s of specs) buildChunkV2(f, lyr, s)
      const ms = (performance.now() - t0) / specs.length
      let culled = 0
      for (const s of specs) if (buildChunkV2(f, lyr, s).culled) culled++
      console.log(`        ${label}: ${ms.toFixed(2)} ms/chunk over ${specs.length} chunks, ${culled}/${specs.length} took the culled path`)
      return ms
    }
    const msEmpty = bench(field, layers, 'empty document ')
    const msAuthored = bench(af, authored, 'authored world ')
    // The worker meshes these one at a time and terrain-v2.js uploads a handful
    // per frame; a chunk that takes longer than a frame turns streaming into
    // visible pop-in no matter how the budget is scheduled.
    check(msEmpty < 13.9, 'an unauthored chunk meshes inside a frame', `${msEmpty.toFixed(2)} ms`)
    check(msAuthored < 13.9, 'an authored chunk meshes inside a frame', `${msAuthored.toFixed(2)} ms`)
  }

  // --- 15. the relief knobs -------------------------------------------------
  //
  // §18's opt-in jaggedness set (src/v2/height/relief.js). Last in the file
  // because it is the only section that builds fields other than the shipped
  // one -- eight of them, one of which runs a full-field erosion -- and because
  // its FIRST assertion is what licenses every section above it. Everything from
  // "detail calibration" down measures a V2Height constructed with no `relief`
  // argument at all; if that default were not bit-for-bit the field that shipped
  // before any of this existed, all thirteen sections above would be honest
  // measurements of a world nobody is playing.
  //
  // `crest` IS A MESHER CONCERN AND CANNOT BE ASSERTED FROM HERE, deliberately.
  // Every other knob reshapes the field, so a field-level gate can see it. crest
  // does not: it biases a COARSE CHUNK's vertices toward the local maximum so a
  // distant ridge keeps its edge, which lives in src/v2/terrain/chunk-mesh-v2.js
  // and is invisible to heightAt by construction. Two consequences worth writing
  // down rather than discovering:
  //
  //   IT KNOWINGLY LIFTS COARSE CHUNKS OFF THE COLLISION FIELD. Every other term
  //   here is band-limited toward the cell = 0 field, which is what section 4
  //   ("no LOD swap moves the surface by as much as one cell") measures and what
  //   makes a coarse chunk a low-pass image of the ground she is standing on. A
  //   max-bias is not a low-pass; it is a different surface, biased upward. If
  //   crest were ever defaulted ON, section 4 would fail -- and that would be the
  //   gate working, not the gate being wrong.
  //
  //   THE KNOB CAN GO DEAD WITHOUT ANY FIELD CHECK NOTICING. `relief.crest`
  //   appears in relief.js, in the HUD, in reliefNeeds (it bakes the exposure
  //   grid), and on the wire to the workers. All of that can stay wired up while
  //   the one consumer that makes it mean anything quietly stops existing, and
  //   every assertion in this file would still pass, because a dead crest and a
  //   correct crest look identical to heightAt. That is the exact silent failure
  //   the "every knob moves something" block below exists to catch, and crest is
  //   out of its reach. So crest is asserted in two halves: it must leave the
  //   FIELD alone, and the mesher source must be READ AS TEXT and shown to
  //   consume it -- the same trick the "slope units" section uses on player.js,
  //   and for the same reason. Importing the mesher (this file already does) only
  //   proves the module parses; grepping it proves the coupling is still there.
  console.log('\nrelief knobs')
  {
    const t0 = performance.now()
    const mk = (r, rough) => new V2Height({ heightmap: hm, layers, seed: WORLD_SEED, relief: { ...RELIEF_DEFAULTS, ...r }, rough })
    const knobOf = (key) => {
      const k = RELIEF_KNOBS.find((n) => n.key === key)
      if (!k) throw new Error(`check-v2-field: no relief knob named '${key}'`)
      return k
    }

    // ALL KNOBS OFF IS BIT-IDENTICAL.
    //
    // `===` and not a tolerance, at every site, because relief.js promises
    // exactly that: an all-zero relief skips every branch rather than evaluating
    // a term that happens to come out near zero. A tolerance here would pass a
    // default that moved the world by a millimetre, and a millimetre of
    // disagreement between the main thread's field and a worker's is a player
    // hovering or sinking -- the failure the whole module is shaped around.
    {
      const explicit = new V2Height({ heightmap: hm, layers, seed: WORLD_SEED, relief: RELIEF_DEFAULTS })
      const N = 3000
      let mismatch = 0
      let worst = 0
      for (let i = 0; i < N; i++) {
        const p = site(i)
        const a = field.heightAt(p.x, p.z)
        const b = explicit.heightAt(p.x, p.z)
        if (a !== b) { mismatch++; worst = Math.max(worst, Math.abs(a - b)) }
      }
      check(reliefIsOff(RELIEF_DEFAULTS), 'RELIEF_DEFAULTS is the off state, by its own predicate', `${RELIEF_KNOBS.length} knobs`)
      // What main.js boots on: the two knobs the world ships with, on a table
      // that normalizes, and nothing else up -- "disable all other terrain
      // effects" is a property of this object and not of a saved HUD.
      const shipped = normalizeRelief(RELIEF_SHIPPED)
      const shippedUp = RELIEF_KNOBS.filter((k) => shipped[k.key] !== k.off).map((k) => k.key)
      check(
        shippedUp.length === 2 && shipped.jagged === 1 && shipped.peaks === 1,
        'RELIEF_SHIPPED is jagged and peaks alone',
        shippedUp.length ? shippedUp.join(', ') : 'nothing up'
      )
      check(mismatch === 0, 'no relief argument and RELIEF_DEFAULTS are the same field, bit for bit', `${mismatch}/${N} sites differ, worst ${worst} m`)
      check(explicit.calibration.rough === cal.rough, 'and the same calibration, bit for bit', `ROUGH ${cal.rough}`)
      // The copy is what erosion costs; with the knob off there must not be one.
      // A 4 MB duplicate of the import, resident on three threads, bought by a
      // default that changes nothing.
      check(field.ground === field.heightmap, 'with relief off the world is built on the import itself, not a copy', 'no eroded duplicate is allocated')
      check(explicit.ground === explicit.heightmap, 'and the same through the explicit all-off relief')
      // AND NOTHING IS HOOKED INTO Heightmap.sample. `crease` and `jagged` are
      // the two knobs that do not add a term: each replaces the coarse
      // reconstruction from inside sample() itself, so with both off the
      // assertion is not "the term evaluates to zero" but "the branch does not
      // exist" -- sample() is literally the Catmull-Rom expression it has always
      // been, and the two flag tests in front of it are the only cost the
      // default pays. Reached into deliberately: `field.crease === null` alone
      // would still pass over an import somebody else had left an operator on.
      check(
        field.crease === null && explicit.crease === null && hm._crease === null && hm._linear === false,
        'and no reconstruction is attached -- with the knobs off sample() IS the plain bicubic, not a branch that returns it',
        'Heightmap._crease null and _linear false on the import and on both fields'
      )
    }

    // EVERY KNOB'S `on` VALUE MOVES SOMETHING.
    //
    // The silent failure this exists for: a knob wired to the HUD, validated by
    // normalizeRelief, plumbed over postMessage to every worker, and read by
    // nothing. It throws nowhere. The panel scrubs, the world remeshes, the
    // ground does not change, and the only symptom is a person concluding the
    // idea was no good.
    //
    // The table is ITERATED rather than listed, and every key must have a probe
    // below, so adding a knob to relief.js fails here until somebody says what
    // moving it is supposed to move.
    //
    //   height    the composed field. Most of them.
    //   snowline  snowJag, which moves a COLOUR boundary and no geometry.
    //   mesher    crest and peaks. See the banner: asserted as a non-effect on
    //             the field; peaks' own effect on a coarse chunk is probed below.
    const PROBE = { bare: 'height', sharpen: 'height', exposure: 'height', crag: 'height', aniso: 'height', ridge: 'height', shatter: 'height', crease: 'height', erode: 'height', talus: 'height', jagged: 'height', jitter: 'height', snowJag: 'snowline', crest: 'mesher', peaks: 'mesher' }
    {
      const unlisted = RELIEF_KNOBS.filter((k) => PROBE[k.key] === undefined).map((k) => k.key)
      check(unlisted.length === 0, 'every knob in the table has a probe in this gate', unlisted.length ? `no probe for ${unlisted.join(', ')}` : `${RELIEF_KNOBS.length} knobs`)

      // The reference scale for "a meaningful move", measured rather than
      // written down: the composed field's own curvature roughness at the
      // calibration's probe lag. A knob that moves the ground by a tenth of what
      // the ground already does at that scale is doing something a person can
      // see; one that moves it by less is indistinguishable from a rounding
      // difference on this import and would be on any other.
      const floor = roughnessOf((x, z) => field.heightAt(x, z), cal.probe) * 0.1

      for (const knob of RELIEF_KNOBS) {
        const kind = PROBE[knob.key]
        // `talus` and `jitter` are the knobs whose `on` IS their `off` -- a
        // repose angle and a fraction, not amounts, each shipping at the value
        // the HUD toggle restores. Their min is the ablation, and it is a value
        // from the table rather than a number invented here.
        const value = knob.on !== knob.off ? knob.on : knob.min
        // The two dependent knobs are measured against PARENT-ONLY, not against
        // all-off, or `aniso` would be credited with the crag it is stretching.
        const parent = knob.needs ? { [knob.needs]: knobOf(knob.needs).on } : {}
        const base = knob.needs ? mk(parent) : field
        const on = mk({ ...parent, [knob.key]: value })
        const against = knob.needs ? `${knob.needs}=${knobOf(knob.needs).on} alone` : 'all off'

        let moved = 0
        let s2 = 0
        const N = 400
        for (let i = 0; i < N; i++) {
          const p = site(i)
          const d = kind === 'snowline'
            ? on.snowLineAt(p.x, p.z) - base.snowLineAt(p.x, p.z)
            : on.heightAt(p.x, p.z) - base.heightAt(p.x, p.z)
          if (d !== 0) moved++
          s2 += d * d
        }
        const frac = moved / N
        const rms = Math.sqrt(s2 / N)
        const what = kind === 'snowline' ? 'snowLineAt' : 'heightAt'
        if (kind === 'mesher') {
          // Not "does nothing" -- "does nothing HERE". The field is not where it
          // lives, and a crest term that did reach heightAt would be a term the
          // collision surface carries, which is precisely what it must not be.
          check(frac === 0, `${knob.key}=${value} leaves the composed field alone -- it is a mesher term`, `${pct(frac)} of sites moved`)
          // The other half of the assertion, and the only half that can catch the
          // knob going dead: the mesher has to actually read it. Read as text, not
          // inferred from the import at the top of this file, which would still
          // succeed against a mesher that had dropped the term entirely.
          const meshSrc = await readFile(MESH_PATH, 'utf8')
          const reads = new RegExp(`relief\\.${knob.key}\\b`).test(meshSrc)
          check(
            reads,
            `${knob.key} is consumed by src/v2/terrain/chunk-mesh-v2.js`,
            reads ? `reads field.relief.${knob.key}` : 'NO reader -- the knob is wired to nothing and this gate cannot see it move'
          )
          // And the one condition that keeps a mesher term out of a collision
          // question. Section 4's leaf identity survives the crest bias only
          // because the finest cell sits at or below the low end of the crest
          // ramp, where smoothstep is exactly 0 and a leaf chunk is still raw
          // heightAtCell. Lower CREST_CELL_LO under CLASS_EPS and crest starts
          // biasing the LOD the player collides against, silently. (peaks has
          // no ramp: it is off wherever a cell is under two texels, which the
          // leaf-identity probe below holds it to.)
          if (knob.key === 'crest') {
            check(
              CREST_CELL_LO >= CLASS_EPS,
              `the crest ramp starts at or above the finest cell, so leaf chunks are never crest-biased`,
              `CREST_CELL_LO ${CREST_CELL_LO} m vs CLASS_EPS ${CLASS_EPS} m`
            )
          }
          continue
        }
        check(
          frac > 0.25 && rms > floor,
          `${knob.key}=${value} moves ${what}, against ${against}`,
          `${pct(frac)} of sites, rms ${rms.toFixed(4)} m (floor ${floor.toFixed(4)} m)`
        )
      }
    }

    // `bare` IS AN EXACT FADE ON THE DETAIL TERM, AT BOTH ENDS AND IN BETWEEN.
    //
    // The knob exists to answer one question -- what is the imported field
    // actually shaped like -- and the answer is only worth having if the fade is
    // arithmetic rather than approximate. So all three statements below are
    // exact rather than tolerant:
    //
    //   0    the shipped field, bit for bit. Asserted separately from the all-off
    //        block above because `bare` is the one knob whose branch sits in the
    //        composed expression itself -- `_plain` is keyed on it -- so a `> 0`
    //        written as `>= 0` would route the DEFAULT world down _micro, and
    //        every measurement in this file would be reading the other path.
    //   1    exactly heightmap.sample, with no epsilon of detail left underneath.
    //        A knob that got to 99.9% of the way there would still be showing the
    //        import through a film of the thing it was asked to remove.
    //   0.5  exactly half the detail term, which is a claim about WHERE the fade
    //        is applied. It multiplies Detail's output from outside, so
    //        calibrateRough never sees it and the octave table does not move;
    //        fold it into `rough` instead and the calibration re-fits the deficit
    //        against the import's structure function, 0.5 buys something other
    //        than half, and scrubbing the knob up and back no longer lands on the
    //        field you started from.
    //
    // The carve chain is out of the way throughout: `layers` is the empty
    // document every section above shares, so heightAt IS coarse plus detail and
    // the macro field can be named exactly rather than approached.
    {
      const bareKnob = knobOf('bare')
      const bareOff = mk({ bare: bareKnob.off })
      const bareOn = mk({ bare: bareKnob.on })
      const bareHalf = mk({ bare: 0.5 })

      const N = 400
      let offDiff = 0
      let onDiff = 0
      let worstOn = 0
      let worstHalf = 0
      let maxDetail = 0
      let s2 = 0
      for (let i = 0; i < N; i++) {
        const p = site(i)
        const macro = hm.sample(p.x, p.z)
        const full = field.heightAt(p.x, p.z)
        if (bareOff.heightAt(p.x, p.z) !== full) offDiff++
        const stripped = bareOn.heightAt(p.x, p.z)
        if (stripped !== macro) { onDiff++; worstOn = Math.max(worstOn, Math.abs(stripped - macro)) }
        // The detail term, recovered the only way a black-box probe can: the
        // composed field less the macro field it was added to. That subtraction
        // is where the half-fade check's tolerance comes from and nowhere else --
        // (macro + d) - macro loses the bits of d that fell off the bottom of a
        // sum with a few hundred metres, which on this import is about 1e-13 m.
        const d = full - macro
        const h = bareHalf.heightAt(p.x, p.z) - macro
        worstHalf = Math.max(worstHalf, Math.abs(h - d / 2))
        maxDetail = Math.max(maxDetail, Math.abs(d))
        s2 += d * d
      }
      // THE NUMBER THIS BLOCK IS FOR. Everything else here is an exactness claim;
      // this is the only line that says how much ground the knob is actually
      // moving, and it is small on purpose -- the detail term is texture over an
      // authored landscape, so fading all of it out must cost centimetres against
      // hundreds of metres of imported relief. A max in the metres would mean the
      // fractal had become the terrain.
      console.log(
        `        detail amplitude bare fades out, over ${N} sites: max ${maxDetail.toFixed(4)} m, rms ${Math.sqrt(s2 / N).toFixed(4)} m ` +
          `-- against ${(hm.max - hm.min).toFixed(0)} m of imported relief`
      )

      check(offDiff === 0, 'bare=0 is the field built with no relief argument at all, bit for bit', `${offDiff}/${N} sites differ`)
      check(onDiff === 0, 'bare=1 is EXACTLY the imported macro field -- no detail left under it', `${onDiff}/${N} sites differ, worst ${worstOn} m`)
      check(worstHalf < 1e-9, 'and bare=0.5 removes exactly half the detail term', `worst departure from half ${worstHalf.toExponential(2)} m against a ${maxDetail.toFixed(4)} m term`)
      // The calibration is the reason 0.5 can mean half at all, so it is asserted
      // as bits and not as a comment: the same ROUGH at every point of the scrub.
      check(
        bareOn.calibration.rough === cal.rough && bareHalf.calibration.rough === cal.rough,
        'the octave table does not move as the knob scrubs -- the fade sits outside calibrateRough',
        `ROUGH ${cal.rough} at bare 0, 0.5 and 1`
      )

      // AND IT LEAVES THE CRAG BAND ALONE.
      //
      // The half of the semantics a future simplification is most likely to lose,
      // and it cannot be seen from any check above: `bare` scales the detail
      // stack and the crease band is added to the result afterwards, so bare=1
      // with crag on is the macro field plus the crag cut and nothing else. Wrap
      // the fade around the whole of _micro's return instead -- one plausible
      // tidy-up -- and the knob quietly becomes a master mute, at which point
      // "what does the bare macro look like" depends on a knob it does not name.
      {
        const cragOn = knobOf('crag').on
        const withCrag = mk({ crag: cragOn })
        const withCragBare = mk({ crag: cragOn, bare: bareKnob.on })
        let band2 = 0
        let through2 = 0
        for (let i = 0; i < N; i++) {
          const p = site(i)
          const band = withCrag.heightAt(p.x, p.z) - field.heightAt(p.x, p.z)
          const through = withCragBare.heightAt(p.x, p.z) - hm.sample(p.x, p.z)
          band2 += band * band
          through2 += through * through
        }
        const bandRms = Math.sqrt(band2 / N)
        const throughRms = Math.sqrt(through2 / N)
        check(
          Math.abs(throughRms / bandRms - 1) < 0.01,
          `bare=${bareKnob.on} fades the detail term and not the crag band`,
          `crag=${cragOn} cuts ${bandRms.toFixed(4)} m rms at bare 0 and ${throughRms.toFixed(4)} m rms at bare ${bareKnob.on} (${((throughRms / bandRms - 1) * 100).toFixed(2)}%)`
        )
      }
    }

    // `jagged` IS THE UNSMOOTHED STACK, AND "UNSMOOTHED" IS ARITHMETIC.
    //
    // The knob replaces the bicubic read with a bilinear one and the simplex
    // octaves with lattice midpoint displacement (see jagged.js's banner), so
    // its promises are all exactness claims rather than looks:
    //
    //   texels    the surface passes through every texel of the import -- every
    //             lattice point that is also a texel corner carries exactly 0.
    //   20%       at a first-layer lattice point every finer layer is 0 too, so
    //             the departure from the bilinear macro IS one layer's value,
    //             bounded by jitter x the macro rise across the parent cell.
    //   lines     between two lattice points of the finest layer the term is a
    //             straight line; the smooth stack's is not. This is the one that
    //             says "no curve anywhere", and it is the one a well-meaning
    //             smoothstep on the lattice weights would break silently.
    //   band      cell 0 and the finest drawn cell are the same field, and at a
    //             texel-sized cell every layer is gone and the drawn ground is
    //             the bilinear macro alone. Same LOD ladder as Detail's.
    //
    // Determinism across two instances is asserted because the lattice hash is
    // integer arithmetic on purpose: a worker and the main thread must agree
    // bit for bit with no shared table, and a `Math.random` slipped into the
    // hash would fail here and nowhere else.
    {
      const jagKnob = knobOf('jagged')
      const jitKnob = knobOf('jitter')
      const jag = mk({ jagged: jagKnob.on })
      const again = mk({ jagged: jagKnob.on })
      const texel = hm.texelSize
      const s0 = jag.detail.table[0].spacing
      check(jag.detail.constructor.name === 'Jagged' && field.detail.constructor.name === 'Detail', 'jagged swaps the detail stack and the default keeps the smooth one', `${jag.detail.count} layers: ${jag.detail.table.map((t) => `${t.spacing.toFixed(2)} m ${t.rule}`).join(', ')}`)
      check(jag.ground !== hm && jag.ground._linear === true && hm._linear === false, 'the bilinear read is attached to a view, never to the shared import', `view linear, import not`)
      check(Math.abs(s0 * 2 - texel) < 1e-9, 'the first layer sits at half the texel', `${s0.toFixed(4)} m under ${texel.toFixed(4)} m texels`)
      check(jag.detail.table.filter((t) => t.rule === 'calibrated').map((t) => t.spacing.toFixed(2)).join(',') === '1.00,0.50,0.25', 'and the 1, 0.5 and 0.25 m layers take the calibrated amplitudes', jag.detail.table.filter((t) => t.rule === 'calibrated').map((t) => `${t.spacing.toFixed(2)} m ${t.coef.toFixed(4)} m`).join(', '))

      // texels: walk a block of the import and read the field at each corner.
      let worstTexel = 0
      for (let j = 200; j < 240; j++) {
        for (let i = 200; i < 240; i++) {
          const x = -WORLD_HALF + i * texel
          const z = -WORLD_HALF + j * texel
          worstTexel = Math.max(worstTexel, Math.abs(jag.heightAt(x, z) - hm.field[j * hm.width + i]))
        }
      }
      check(worstTexel < 1e-9, 'jagged passes through every texel of the import exactly', `worst ${worstTexel.toExponential(2)} m over 1600 corners`)

      // 20%: first-layer lattice points that are not texel corners.
      let worstOver = -Infinity
      let sloped = 0
      for (let j = 200; j < 240; j++) {
        for (let i = 200; i < 240; i++) {
          if ((i & 1) === 0 && (j & 1) === 0) continue
          const x = -WORLD_HALF + i * s0
          const z = -WORLD_HALF + j * s0
          const s01 = jag.ground.slopeAt(x, z)
          const tan = s01 / (1 - s01)
          const bound = jitKnob.off * texel * tan
          const dev = Math.abs(jag.heightAt(x, z) - jag.ground.sample(x, z))
          worstOver = Math.max(worstOver, dev - bound)
          if (bound > 0.05 && dev > bound * 0.5) sloped++
        }
      }
      check(worstOver < 1e-9, `at a ${s0.toFixed(2)} m lattice point the departure from the bilinear macro is at most jitter x the parent cell's rise`, `worst over the bound ${worstOver.toExponential(2)} m`)
      check(sloped > 0, 'and on sloped ground it uses a good part of that allowance', `${sloped} lattice points past half the bound`)

      // lines: three points along x inside one cell of the finest layer.
      const sFine = jag.detail.table[jag.detail.count - 1].spacing
      let worstLine = 0
      let smoothLine = 0
      for (let i = 0; i < 400; i++) {
        const p = site(i)
        const x0 = Math.floor((p.x + WORLD_HALF) / sFine) * sFine - WORLD_HALF + sFine * 0.1
        const x1 = x0 + sFine * 0.8
        const xm = (x0 + x1) / 2
        const slope = 0.4
        const j = jag.detail
        worstLine = Math.max(worstLine, Math.abs(j.at(xm, p.z, 0, slope, 0) - (j.at(x0, p.z, 0, slope, 0) + j.at(x1, p.z, 0, slope, 0)) / 2))
        const d = field.detail
        smoothLine = Math.max(smoothLine, Math.abs(d.at(xm, p.z, 0, slope, 0) - (d.at(x0, p.z, 0, slope, 0) + d.at(x1, p.z, 0, slope, 0)) / 2))
      }
      check(worstLine < 1e-9, 'between two points of the finest lattice the jagged term is a straight line', `worst departure ${worstLine.toExponential(2)} m; the smooth stack departs by ${smoothLine.toExponential(2)} m over the same segments`)
      check(smoothLine > 1e-6, 'and that assertion bites -- the smooth stack fails it', `${smoothLine.toExponential(2)} m`)

      // band and determinism.
      let worstFine = 0
      let worstCoarse = 0
      let mismatch = 0
      for (let i = 0; i < 400; i++) {
        const p = site(i)
        const exact = jag.heightAt(p.x, p.z)
        if (exact !== again.heightAt(p.x, p.z)) mismatch++
        worstFine = Math.max(worstFine, Math.abs(jag.heightAt(p.x, p.z, sFine / 4) - exact))
        worstCoarse = Math.max(worstCoarse, Math.abs(jag.heightAt(p.x, p.z, texel) - jag.ground.sample(p.x, p.z)))
      }
      check(mismatch === 0, 'two jagged fields from one seed agree bit for bit', `${mismatch}/400 sites differ`)
      check(worstFine === 0, `a ${(sFine / 4).toFixed(4)} m cell carries every layer and is the exact field`, `worst ${worstFine} m`)
      check(worstCoarse < 1e-9, `a texel-sized cell carries none and is the bilinear macro alone`, `worst ${worstCoarse.toExponential(2)} m`)
    }

    // `peaks` IS AN UPPER ENVELOPE, AND ONLY WHERE A CELL IS COARSER THAN A TEXEL.
    //
    // The knob lives in the mesher (its non-effect on the field is asserted
    // above); what it promises is per vertex of a coarse chunk: at least the
    // point sample, at least the field at every texel of the vertex's own
    // footprint, and exactly the point sample at the 4 m rung and below, where
    // the leaf identity of section 4 has to survive it.
    {
      const texel = hm.texelSize
      const peaks = mk({ peaks: 1 })
      const vpr = CHUNK_RES + 1
      const inner = vpr * vpr
      const spec = (size) => ({ ox: -size / 2 + 64, oz: -size / 2 - 128, size, res: CHUNK_RES, cam: CAM })
      for (const depth of [4, 6]) {
        const size = WORLD_SIZE / (1 << depth)
        const step = size / CHUNK_RES
        const sp = spec(size)
        const off = buildChunkV2(field, layers, sp)
        const on = buildChunkV2(peaks, layers, sp)
        let below = 0
        let rose = 0
        let underFoot = 0
        let worstUnder = 0
        const taps = Math.ceil(step / texel) + 1
        for (let v = 0; v < inner; v++) {
          const yOff = off.positions[v * 3 + 1]
          const yOn = on.positions[v * 3 + 1]
          if (yOn < yOff) below++
          if (yOn > yOff) rose++
          const wx = sp.ox + (v % vpr) * step
          const wz = sp.oz + Math.floor(v / vpr) * step
          let hMax = -Infinity
          for (let b = 0; b < taps; b++) {
            for (let a = 0; a < taps; a++) {
              hMax = Math.max(hMax, field.heightAt(wx - step / 2 + (a * step) / (taps - 1), wz - step / 2 + (b * step) / (taps - 1), step))
            }
          }
          // Float32 positions against a float64 field.
          const under = Math.fround(hMax) - yOn
          if (under > 1e-3) { underFoot++; worstUnder = Math.max(worstUnder, under) }
        }
        check(below === 0, `at a ${step} m cell peaks=1 lowers no vertex under the point sample`, `${below}/${inner} below`)
        check(rose > inner / 4, `and raises a good part of them`, `${rose}/${inner} rose`)
        check(underFoot === 0, `and no vertex sits under the field at any texel of its own footprint`, `${underFoot} under, worst ${worstUnder.toFixed(4)} m`)
      }
      for (const depth of [7, 9]) {
        const size = WORLD_SIZE / (1 << depth)
        const step = size / CHUNK_RES
        if (step * 2 > texel) throw new Error(`peaks probe: depth ${depth} is a ${step} m cell, coarser than half a texel`)
        const sp = spec(size)
        const off = buildChunkV2(field, layers, sp)
        const on = buildChunkV2(peaks, layers, sp)
        let differ = 0
        for (let i = 0; i < off.positions.length; i++) if (off.positions[i] !== on.positions[i]) differ++
        check(differ === 0, `at a ${step} m cell peaks=1 is the point sample, bit for bit`, `${differ} position components differ`)
      }
    }

    // THE CALIBRATION HOLDS ROUGHNESS CONSTANT.
    //
    // calibrateRough measures the unit octave stack THROUGH `sharpen` and
    // through the exposure gain, on exactly the same footing as SLOPE_BOOST, and
    // then scales `rough` to hit the same measured deficit. The consequence is
    // the point of the whole knob set: turning one up REDISTRIBUTES roughness
    // rather than adding it, so a side-by-side is a comparison of two characters
    // and not of two amplitudes. Without it every knob is a volume control and
    // the one that looks best is just the loudest.
    //
    // Measured at the calibration's own probe lag, on the COMPOSED field --
    // which is what the eye and the player's stride actually meet, and which the
    // import contributes to as well, so this is not the calibration checking its
    // own arithmetic. The control below is what says so.
    {
      const lag = cal.probe
      const rough = (f) => roughnessOf((x, z) => f.heightAt(x, z), lag)
      const detailRough = (f) => roughnessOf((x, z) => f.heightAt(x, z) - hm.sample(x, z), lag)
      const sharpOn = mk({ sharpen: knobOf('sharpen').on })
      const expoOn = mk({ exposure: knobOf('exposure').on })
      const rOff = rough(field)
      const rSharp = rough(sharpOn)
      const rExpo = rough(expoOn)
      const image = roughnessOf((x, z) => hm.sample(x, z), lag)
      console.log(
        `        curvature roughness at the ${lag.toFixed(3)} m probe lag: all off ${rOff.toFixed(5)} m ` +
          `(the import supplies ${image.toFixed(5)} m of it, the detail term ${detailRough(field).toFixed(5)} m)`
      )
      console.log(
        `        sharpen=${knobOf('sharpen').on} -> ${rSharp.toFixed(5)} m (${((rSharp / rOff - 1) * 100).toFixed(2)}%),  ` +
          `exposure=${knobOf('exposure').on} -> ${rExpo.toFixed(5)} m (${((rExpo / rOff - 1) * 100).toFixed(2)}%)`
      )
      // Exposure is a spatial gain and commutes with FINE_CUT, so its neutrality
      // is exact. Sharpen's is not: the rectifier puts harmonics of the 4-16 m
      // octaves into the 1-2 m band, the fit balanced those against the UNCUT
      // stack (FINE_CUT sits outside it, deliberately), and halving the 1-2 m
      // octaves leaves the sharpened stack 12-13% rougher at the probe lag.
      const SHARPEN_NEUTRAL = 0.15
      check(Math.abs(rSharp / rOff - 1) < SHARPEN_NEUTRAL, 'sharpen redistributes roughness rather than adding it, to within FINE_CUT\'s reach', `${((rSharp / rOff - 1) * 100).toFixed(2)}% at the probe lag`)
      check(Math.abs(rExpo / rOff - 1) < 0.05, 'exposure redistributes roughness rather than adding it', `${((rExpo / rOff - 1) * 100).toFixed(2)}% at the probe lag`)

      // AND THE MEASUREMENT CAN SEE THE DIFFERENCE. Both numbers above come out
      // near zero, which is the right answer and is also what a check that
      // measures nothing looks like. The control is the same fields with `rough`
      // PINNED to the all-off value -- i.e. calibrateRough NOT re-measured
      // through the knob, which is what these two knobs would be if the
      // `sharpen` and `exposureGain` parameters had never been threaded into it.
      const pinnedSharp = mk({ sharpen: knobOf('sharpen').on }, cal.rough)
      const pinnedExpo = mk({ exposure: knobOf('exposure').on }, cal.rough)
      const dOff = detailRough(field)
      const dSharp = detailRough(pinnedSharp)
      const dExpo = detailRough(pinnedExpo)
      console.log(
        `        control, rough pinned to the all-off value: detail roughness ${dOff.toFixed(5)} m -> ` +
          `sharpen ${dSharp.toFixed(5)} m (${((dSharp / dOff - 1) * 100).toFixed(1)}%), exposure ${dExpo.toFixed(5)} m (${((dExpo / dOff - 1) * 100).toFixed(1)}%)`
      )
      check(
        Math.abs(dSharp / dOff - 1) > 0.05 || Math.abs(dExpo / dOff - 1) > 0.05,
        'and un-calibrated, the same knobs would move it -- so the checks above are not vacuous',
        `sharpen ${((dSharp / dOff - 1) * 100).toFixed(1)}%, exposure ${((dExpo / dOff - 1) * 100).toFixed(1)}% with the calibration held back`
      )
      // Exposure is held to five digits, because this IS the quantity
      // calibrateRough solves for. Worth asserting anyway: it is the plumbing,
      // not the maths -- the exposureGain closure reaching the calibration at all
      // is a thing the field has to remember to pass. Sharpen is held to the
      // FINE_CUT margin above, for the reason given there.
      check(
        Math.abs(detailRough(sharpOn) / dOff - 1) < SHARPEN_NEUTRAL && Math.abs(detailRough(expoOn) / dOff - 1) < 0.01,
        'the detail term itself lands on the same deficit through either knob',
        `${dOff.toFixed(5)} m vs ${detailRough(sharpOn).toFixed(5)} / ${detailRough(expoOn).toFixed(5)} m`
      )
    }

    // SHARPEN RAISES CURVATURE KURTOSIS.
    //
    // The claim in detail.js: a sum of twelve independent octaves is gaussian by
    // the central limit theorem, gaussian ground has no rare large excursions --
    // no creases, no facets, no edges -- and the sharpen curve buys those back by
    // compressing small excursions and leaving large ones alone. Kurtosis
    // (m4 / m2^2; 3.0 is exactly gaussian) is the statistic that says so.
    //
    // MEASURED ON THE DETAIL TERM AND NOT ON THE COMPOSED FIELD, and this is a
    // correction to what §18 assumes rather than a convenience. The composed
    // field's curvature kurtosis is not an estimable quantity at these sample
    // sizes: the import's own curvature distribution has a tail so heavy that at
    // a 1 m lag TEN sites out of twenty thousand carry ~86% of m4, and the
    // estimate wanders between 4.7 and 75 depending only on how many sites you
    // ask for. The often-quoted "the composed field collapses to 4.0" is that
    // estimator at 1500 sites, not a property of the field. Both counts are
    // printed below so the instability is on the record; nothing is asserted
    // against them.
    //
    // The detail term alone converges by 6000 sites and stays put, which makes it
    // the only place the knob's actual claim is checkable. Slope modulation is
    // switched off (slope01 = 0) so the statistic is the octave sum's own shape
    // and not the world's slope distribution leaking into it as a mixture.
    {
      const kurtosis = (f, lag, sites) => {
        const d = new Float64Array(sites)
        let mean = 0
        for (let n = 0; n < sites; n++) {
          const p = measureSite(n)
          const a = measureAngle(n)
          const cx = Math.cos(a) * lag
          const cz = Math.sin(a) * lag
          d[n] = f(p.x + cx, p.z + cz) - 2 * f(p.x, p.z) + f(p.x - cx, p.z - cz)
          mean += d[n]
        }
        mean /= sites
        let m2 = 0
        let m4 = 0
        for (let n = 0; n < sites; n++) {
          const c = d[n] - mean
          m2 += c * c
          m4 += c * c * c * c
        }
        return (m4 / sites) / (m2 / sites) ** 2
      }
      const LAG = 1
      const sharpOn = mk({ sharpen: knobOf('sharpen').on })
      const sharpMax = mk({ sharpen: knobOf('sharpen').max })
      console.log(
        `        curvature kurtosis at a ${LAG} m lag (3.0 = gaussian) -- import ${kurtosis((x, z) => hm.sample(x, z), LAG, 1500).toFixed(1)} at 1500 sites, ` +
          `${kurtosis((x, z) => hm.sample(x, z), LAG, 20000).toFixed(1)} at 20000`
      )
      console.log(
        `        composed field ${kurtosis((x, z) => field.heightAt(x, z), LAG, 1500).toFixed(1)} at 1500 sites, ` +
          `${kurtosis((x, z) => field.heightAt(x, z), LAG, 20000).toFixed(1)} at 20000 -- an unconverged estimator, reported and not asserted`
      )
      const bare = (f) => (x, z) => f.detail.at(x, z, 0, 0, 0)
      const kOff = kurtosis(bare(field), LAG, 20000)
      const kOn = kurtosis(bare(sharpOn), LAG, 20000)
      const kMax = kurtosis(bare(sharpMax), LAG, 20000)
      console.log(`        detail term alone: sharpen 0 -> ${kOff.toFixed(3)},  ${knobOf('sharpen').on} -> ${kOn.toFixed(3)},  ${knobOf('sharpen').max} -> ${kMax.toFixed(3)}`)
      check(Math.abs(kOff - 3) < 0.5, 'the unsharpened octave stack is gaussian, exactly as the central limit theorem says', `kurtosis ${kOff.toFixed(3)} vs 3.0`)
      check(kOn > kOff * 1.04, 'and sharpen pushes it off gaussian -- rare excursions kept, ordinary ground flattened', `${kOff.toFixed(3)} -> ${kOn.toFixed(3)} (${((kOn / kOff - 1) * 100).toFixed(1)}%)`)
      // The top of the knob's range is REPORTED and not asserted against the on
      // value. The lift saturates -- most of it is bought by the first half of
      // the curve, and the gap between 0.7 and 1.0 is inside the estimator's own
      // scatter at 20000 sites, so an assertion there would be a coin toss
      // dressed up as a check.
      if (kMax <= kOn) console.log(`          NOTE: kurtosis saturates -- sharpen ${knobOf('sharpen').max} buys nothing over ${knobOf('sharpen').on}`)
    }

    // THE CRAG BAND IS ZERO-MEAN AND GATED.
    //
    // Two separate promises, and both are about the knob being SAFE to turn up
    // rather than about it looking good.
    //
    // ZERO-MEAN: the crease operator is a rectified sqrt(n^2 + ROUND^2), which
    // has a large positive mean, and it is SUBTRACTED. Skip the mean correction
    // and raising the knob lowers the entire mountain range by the mean cut,
    // which walks the world down past the snow line and the altitude ramp -- so
    // the A/B a person runs to judge the knob is a comparison of two different
    // worlds and tells them nothing.
    //
    // GATED: convexity squared times a steepness smoothstep. §3 records v1
    // sealing its own world off with a cliff layer that never asked whether the
    // ground it was cragging was the only way through a pass. A pass floor is
    // flat and concave and both gates are zero there, which is checked exactly
    // rather than statistically: below CRAG_SLOPE_LO the term must be 0, not
    // small.
    {
      const cragKnob = knobOf('crag')
      const cragOn = mk({ crag: cragKnob.on })
      const N = 3000
      let sum = 0
      let s2 = 0
      let convex2 = 0
      let convexN = 0
      let concave2 = 0
      let concaveN = 0
      let flatN = 0
      let flatMoved = 0
      for (let i = 0; i < N; i++) {
        const p = measureSite(i)
        const d = cragOn.heightAt(p.x, p.z) - field.heightAt(p.x, p.z)
        sum += d
        s2 += d * d
        if (cragOn.exposureAt(p.x, p.z) > 0.5) { convex2 += d * d; convexN++ } else { concave2 += d * d; concaveN++ }
        if (cragOn.slope01At(p.x, p.z) <= CRAG_SLOPE_LO) { flatN++; if (d !== 0) flatMoved++ }
      }
      const mean = sum / N
      const rms = Math.sqrt(s2 / N)
      const convexRms = Math.sqrt(convex2 / convexN)
      const concaveRms = Math.sqrt(concave2 / concaveN)
      console.log(
        `        crag=${cragKnob.on} m against all off, over ${N} sites: mean ${mean.toFixed(4)} m, rms ${rms.toFixed(4)} m ` +
          `(|mean|/rms ${(Math.abs(mean) / rms).toFixed(4)})`
      )
      console.log(
        `        by landform: convex (exposure > 0.5) n=${convexN} rms ${convexRms.toFixed(4)} m,  ` +
          `concave n=${concaveN} rms ${concaveRms.toFixed(4)} m,  ratio ${(convexRms / concaveRms).toFixed(1)}x`
      )
      check(Math.abs(mean) < rms * 0.15, 'the crag band is zero-mean -- turning it up does not walk the range downhill', `|mean|/rms ${(Math.abs(mean) / rms).toFixed(4)}`)
      check(convexRms > concaveRms * 10, 'and it lands on convex ground, not on the hollows between', `${(convexRms / concaveRms).toFixed(1)}x more cut on the convex half`)
      check(flatMoved === 0, 'ground below the crag slope gate is untouched EXACTLY -- valley floors are the route network', `${flatMoved} of ${flatN} sites under slope01 ${CRAG_SLOPE_LO} moved`)
      check(flatN > 100, 'and there is enough flat ground in the world for that to mean something', `${flatN} of ${N} sites are under the gate`)
    }

    // THE RIDGE TERM IS ZERO-MEAN, LINEAR, BAND-LIMITED, AND FREE WHEN IT IS OFF.
    //
    // Five promises, and every one of them is a way for the knob to be quietly
    // wrong rather than a way for it to look bad:
    //
    // OFF IS OFF, AND IT IS OFF TWICE OVER. `ridge` is the second knob after
    // `bare` whose branch sits in `_plain` itself, so a `> 0` written as `>= 0`
    // would route the DEFAULT world down _micro and every measurement in this file
    // would be reading the other path. And the structure is not free to have
    // around: three Hessian scales over the whole import is ~260 ms of bake and
    // 9 MB resident, PER THREAD, which a `needs.ridge` that was true at zero would
    // buy on every boot for a term that then adds nothing.
    //
    // ZERO-MEAN, which is crag.js's argument and bites harder here. The crease
    // operator has a large positive mean and it is SUBTRACTED, and what scales it
    // is a gate that is highest on exactly the spines the term is aimed at. Skip
    // the subtraction and raising the knob walks the ridges up relative to their
    // own valleys -- so the A/B against `crag` at matched amplitude, which is the
    // whole reason both knobs are in metres and both `on` at 12, would be a
    // comparison of two elevations instead of two shapes.
    //
    // LINEAR IN THE KNOB. `amount` multiplies the whole sum, so a HUD scrub is an
    // amplitude and not a redesign of the field at every tick. Asserted EXACTLY on
    // the term and to floating point through the composed field, for the reason
    // the `bare` block records: recovering a term by subtracting two composed
    // heights loses the bits that fall off the bottom of a sum with a few hundred
    // metres, which on this import is about 1e-13 m.
    //
    // BAND-LIMITED ON ITS OWN WAVELENGTHS. Each detection scale cuts teeth at a
    // wavelength of its own and fades on that wavelength, so the term dies with
    // the mesh instead of outliving the terms beside it and changing the character
    // of the ground with viewing distance. The cell that kills it is COMPUTED from
    // the baked lambdas rather than written down, because those follow the
    // import's texel size and a literal would silently stop testing anything the
    // next time the image is rebaked at another resolution.
    //
    // AND IT SHARPENS RATHER THAN MERELY DISPLACING, which is the only one of the
    // five that says the change of parameterisation bought anything at all. A term
    // that moved peak ground by metres without raising its curvature would be a
    // second macro layer, not teeth. Measured as rms second difference at a 2 m
    // lag -- the instrument the calibration itself rests on, see roughnessOf -- on
    // peak ground only, because that is where a directed operator claims to be
    // able to tell a spine from a lump and everywhere else it is gated off.
    {
      const ridgeKnob = knobOf('ridge')
      const ridgeOff = mk({ ridge: ridgeKnob.off })
      const ridgeOn = mk({ ridge: ridgeKnob.on })
      const ridgeTwice = mk({ ridge: ridgeKnob.on * 2 })

      let mismatch = 0
      let worstOff = 0
      for (let i = 0; i < 400; i++) {
        const p = site(i)
        const a = ridgeOff.heightAt(p.x, p.z)
        const b = field.heightAt(p.x, p.z)
        if (a !== b) { mismatch++; worstOff = Math.max(worstOff, Math.abs(a - b)) }
      }

      // The cell at which every scale is dead: `at` fades each scale over
      // smoothstep(2 * cell, 4 * cell, lambda), which is exactly 0 at and below
      // the low edge, so the longest lambda halved silences all three.
      const dead = Math.max(...ridgeOn.ridge.lambda) / 2

      const N = 3000
      let sum = 0
      let s2 = 0
      let worstLin = 0
      let termLin = 0
      let live = 0
      let deadAlive = 0
      for (let i = 0; i < N; i++) {
        const p = measureSite(i)
        const base = field.heightAt(p.x, p.z)
        const d = ridgeOn.heightAt(p.x, p.z) - base
        const d2 = ridgeTwice.heightAt(p.x, p.z) - base
        sum += d
        s2 += d * d
        worstLin = Math.max(worstLin, Math.abs(d2 - 2 * d))
        // The same claim on the term itself, where it IS exact: `amount` is one
        // multiply on the finished sum, so doubling the knob doubles the metres
        // with no rounding at all, and any amplitude that had crept inside the
        // scale loop -- a gate raised to a power of the knob, a wavelength that
        // moved with it -- would break this and leave the tolerant check above
        // still passing.
        if (ridgeOn.ridge.at(p.x, p.z, 0, ridgeKnob.on * 2) !== 2 * ridgeOn.ridge.at(p.x, p.z, 0, ridgeKnob.on)) termLin++
        if (ridgeOn.ridge.at(p.x, p.z, 0, ridgeKnob.on) !== 0) live++
        if (ridgeOn.ridge.at(p.x, p.z, dead, ridgeKnob.on) !== 0) deadAlive++
      }
      const mean = sum / N
      const rms = Math.sqrt(s2 / N)

      // PEAK GROUND, defined off the world rather than off a number: the top tenth
      // of the same scatter these sections all share, and steep with it. 0.30 is
      // Heightmap.slopeAt's 0..1 convention (see slope01At) and is a 23 degree
      // hillside, well clear of the summit plateaus where there is no face for a
      // rib to run down.
      const PEAK_SITES = 6000
      const PEAK_SLOPE = 0.30
      const LAG = 2
      const heights = new Float64Array(PEAK_SITES)
      for (let i = 0; i < PEAK_SITES; i++) {
        const p = measureSite(i)
        heights[i] = field.heightAt(p.x, p.z)
      }
      const sorted = Float64Array.from(heights).sort()
      const p90 = sorted[Math.floor(0.90 * (PEAK_SITES - 1))]
      const curve = (f, i, p) => {
        const a = measureAngle(i)
        const cx = Math.cos(a) * LAG
        const cz = Math.sin(a) * LAG
        return f.heightAt(p.x + cx, p.z + cz) - 2 * f.heightAt(p.x, p.z) + f.heightAt(p.x - cx, p.z - cz)
      }
      let peakN = 0
      let curveOff2 = 0
      let curveOn2 = 0
      for (let i = 0; i < PEAK_SITES; i++) {
        if (heights[i] < p90) continue
        const p = measureSite(i)
        if (field.slope01At(p.x, p.z) <= PEAK_SLOPE) continue
        const c0 = curve(field, i, p)
        const c1 = curve(ridgeOn, i, p)
        curveOff2 += c0 * c0
        curveOn2 += c1 * c1
        peakN++
      }
      const curveOff = Math.sqrt(curveOff2 / peakN)
      const curveOn = Math.sqrt(curveOn2 / peakN)

      console.log(
        `        ridge=${ridgeKnob.on} m against all off, over ${N} sites: rms ${rms.toFixed(4)} m, mean ${mean.toFixed(4)} m ` +
          `(|mean|/rms ${(Math.abs(mean) / rms).toFixed(4)}), and ${(curveOn / curveOff).toFixed(1)}x the ${LAG} m curvature on peak ground ` +
          `(${curveOff.toFixed(4)} m -> ${curveOn.toFixed(4)} m over ${peakN} sites)`
      )

      check(mismatch === 0, 'ridge=0 is the field built with no relief argument at all, bit for bit', `${mismatch}/400 sites differ, worst ${worstOff} m`)
      check(
        ridgeOff.ridge === null && ridgeOn.ridge !== null,
        'and ridge=0 does not bake the structure at all -- off pays for nothing',
        `off: no RidgeField;  on: ${ridgeOn.ridge.count} scales of ${ridgeOn.ridge.width}x${ridgeOn.ridge.height}`
      )
      check(Math.abs(mean) < rms * 0.1, 'the ridge term is zero-mean -- turning it up does not walk the spines off their own valleys', `|mean|/rms ${(Math.abs(mean) / rms).toFixed(4)}`)
      check(termLin === 0, `ridge=${ridgeKnob.on * 2} is EXACTLY twice ridge=${ridgeKnob.on} in the term itself -- the knob is one multiply on the sum`, `${termLin}/${N} sites differ`)
      check(
        worstLin < 1e-9,
        'and twice as far through the composed field, to the last bit a few hundred metres of macro leaves',
        `worst departure from double ${worstLin.toExponential(2)} m against a ${rms.toFixed(4)} m rms term`
      )
      check(deadAlive === 0, `every scale is band-limited away by a ${dead.toFixed(1)} m cell -- the term is EXACTLY 0, not small`, `${deadAlive}/${N} sites still moving at cell ${dead.toFixed(1)} m`)
      check(live > N * 0.25, 'and it is emphatically alive at cell 0, so that is not zero by inaction', `${pct(live / N)} of sites cut at the exact field`)
      // The bare field's 2 m curvature already carries the continuity-fit detail
      // stack (DETAIL_GAIN), so ridge=12 stands 1.6x above it, not 3.7x above a
      // near-bicubic; 1.4 is that with a little headroom, and a displacing term
      // would sit at 1.0.
      check(curveOn > curveOff * 1.4, 'ridge SHARPENS peak ground rather than displacing it -- teeth, not a second macro layer', `${(curveOn / curveOff).toFixed(1)}x the rms ${LAG} m curvature`)
      check(peakN > 100, 'and there are enough peaks in the world for that to mean something', `${peakN} of ${PEAK_SITES} sites are over p90 and steeper than slope01 ${PEAK_SLOPE}`)

      // A DOME SCORES NOTHING, which is the claim ridge.js's header rests the
      // whole detector on and the one the shipped world cannot be asked about,
      // because there is no clean dome anywhere in it. So both landforms are
      // built here: the SAME Gaussian, once extruded along a line and once spun
      // about a point, at the same amplitude and the same width, and each given
      // its own RidgeField. Everything that could flatter the ridge is held
      // equal, and the only difference left is whether the shape has an axis.
      //
      // What separates them is the `flat` factor -- 1 - |kBig| / convex -- and
      // nothing else. Drop it and both score their convexity, which the dome has
      // in full measure; a detector that fired on domes would put teeth on every
      // knoll and hummock in the world and read as noise rather than structure.
      //
      // MEASURED ON THE GATE, so this is also a test of the percentile
      // normalisation: each synthetic world is calibrated against ITSELF, so the
      // dome world's own most ridge-like ground sets its 255. A dome that still
      // comes out near zero at its summit under its own calibration is a dome
      // that has nothing ridge-like at its summit at all.
      //
      // Sigma is five times the coarsest detection radius so the shape is
      // resolved by every stencil in the table rather than read as a spike by
      // the widest one, and the grid is the world's own registration at a
      // quarter of the import's resolution -- big enough that a landform of that
      // width is not mostly border clamp.
      {
        const SYN = 256
        const synTexel = WORLD_SIZE / (SYN - 1)
        const SIGMA = Math.max(...ridgeOn.ridge.scales) * 5 * synTexel
        const AMP = 400
        const TILT = 0.7
        const ca = Math.cos(TILT)
        const sa = Math.sin(TILT)
        const gauss = (d) => AMP * Math.exp(-(d * d) / (2 * SIGMA * SIGMA))
        const synth = (fn) => {
          const data = new Float32Array(SYN * SYN)
          for (let j = 0; j < SYN; j++) {
            for (let i = 0; i < SYN; i++) data[j * SYN + i] = fn(-WORLD_HALF + i * synTexel, -WORLD_HALF + j * synTexel)
          }
          return Heightmap.fromRaw({ width: SYN, height: SYN, data, meta: { world: WORLD_SIZE, minY: 0, maxY: AMP, encoding: 'raw' } })
        }
        const bake = (hmap) => new V2Height({ heightmap: hmap, layers, seed: WORLD_SEED, relief: { ...RELIEF_DEFAULTS, ridge: ridgeKnob.on }, rough: 1e-6 }).ridge
        const spine = bake(synth((x, z) => gauss(-x * sa + z * ca)))
        const dome = bake(synth((x, z) => gauss(Math.hypot(x, z))))

        // The same offsets on both, run along the spine's crest and along a
        // diameter of the dome -- which by symmetry is every diameter, so this is
        // the dome's best case and not a corner of it. Averaged over all three
        // scales, since a detector that only rejected domes at one radius would
        // still be putting teeth on them at the other two.
        const CREST = 64
        const HALF = SIGMA * 0.25
        const crestMean = (rf) => {
          let acc = 0
          for (let k = 0; k < CREST; k++) {
            const t = ((k + 0.5) / CREST - 0.5) * 2 * HALF
            const u = (ca * t + WORLD_HALF) * rf._invX
            const v = (sa * t + WORLD_HALF) * rf._invZ
            for (let si = 0; si < rf.count; si++) acc += rf._cubic(rf.ridge[si], u, v)
          }
          return acc / (CREST * rf.count)
        }
        const onSpine = crestMean(spine)
        const onDome = crestMean(dome)
        check(
          onSpine >= onDome * 5,
          'ridgeness fires on a spine and not on a dome -- a dome has no axis to be right about, so it must not get one',
          `crest ${onSpine.toFixed(1)}/255 against summit ${onDome.toFixed(1)}/255 over ${CREST} sites x ${spine.count} scales, ${onDome > 0 ? `${(onSpine / onDome).toFixed(0)}x` : 'the dome scores exactly nothing'}`
        )
      }

      // THE DIRECTOR SURVIVES THE 0/PI WRAP, which is the reason the axis is
      // stored as the DOUBLE ANGLE rather than as the angle. theta and theta + pi
      // are the same ridge, so a grid holding theta has a seam wherever the axis
      // crosses the wrap, and averaging across that seam gives an axis at RIGHT
      // ANGLES to both its neighbours -- ribbing cut across the crest instead of
      // down it, along a line of grid texels, on ground that is otherwise a
      // perfectly good spine. Nothing else in this file would notice: the term
      // would still be zero-mean, still linear, still band-limited, and still
      // sharpen peak ground, because a rib at 90 degrees is exactly as sharp as a
      // rib at 0.
      //
      // Asserted against the Hessian itself rather than against a second copy of
      // the module's own arithmetic. The blur is ridge.js's blur, texel for texel
      // -- two box passes per axis with the border clamped -- and the angle is
      // recomputed on the nearest texel from scratch, then held against what the
      // shipped read path returns for the same place: bytes, bilinear, atan2,
      // halved. Compared as DIRECTORS, mod pi, because that is what the two
      // things claim to be.
      //
      // The coarsest scale, because that is where the claim is strongest and the
      // tolerance therefore means something -- the axis at a 288 m detection
      // width turns slowly enough that a texel of interpolation is a fraction of
      // a degree, so a median error of 2 degrees is a wide gate that only a
      // structurally wrong director can walk through.
      {
        const si = ridgeOn.ridge.count - 1
        const r = ridgeOn.ridge.scales[si]
        const gw = ridgeOn.ridge.width
        const gh = ridgeOn.ridge.height
        const gn = gw * gh
        const src = ridgeOn.ground.field
        const boxU = (a, b) => {
          const norm = 1 / (2 * r + 1)
          for (let j = 0; j < gh; j++) {
            const row = j * gw
            let acc = 0
            for (let i = -r; i <= r; i++) acc += a[row + (i < 0 ? 0 : i >= gw ? gw - 1 : i)]
            for (let i = 0; i < gw; i++) {
              b[row + i] = acc * norm
              const out = i - r
              const inn = i + r + 1
              acc += a[row + (inn >= gw ? gw - 1 : inn)] - a[row + (out < 0 ? 0 : out)]
            }
          }
        }
        const boxV = (a, b) => {
          const norm = 1 / (2 * r + 1)
          for (let i = 0; i < gw; i++) {
            let acc = 0
            for (let j = -r; j <= r; j++) acc += a[(j < 0 ? 0 : j >= gh ? gh - 1 : j) * gw + i]
            for (let j = 0; j < gh; j++) {
              b[j * gw + i] = acc * norm
              const out = j - r
              const inn = j + r + 1
              acc += a[(inn >= gh ? gh - 1 : inn) * gw + i] - a[(out < 0 ? 0 : out) * gw + i]
            }
          }
        }
        const blurred = new Float32Array(gn)
        const scratch = new Float32Array(gn)
        boxU(src, scratch)
        boxV(scratch, blurred)
        boxU(blurred, scratch)
        boxV(scratch, blurred)

        const hx = r * (WORLD_SIZE / (gw - 1))
        const hz = r * (WORLD_SIZE / (gh - 1))
        const invXX = 1 / (hx * hx)
        const invZZ = 1 / (hz * hz)
        const invXZ = 1 / (4 * hx * hz)

        const DIRS = 400
        const errs = []
        for (let i = 0; errs.length < DIRS && i < 200000; i++) {
          const p = measureSite(i)
          const u = (p.x + WORLD_HALF) * ridgeOn.ridge._invX
          const v = (p.z + WORLD_HALF) * ridgeOn.ridge._invZ
          const ti = Math.round(u)
          const tj = Math.round(v)
          if (ti < 0 || tj < 0 || ti >= gw || tj >= gh) continue
          // Gated ground only. On flat or concave ground the axis is arbitrary by
          // construction and comparing two arbitrary numbers proves nothing.
          if (ridgeOn.ridge.ridge[si][tj * gw + ti] <= 128) continue
          const im = ti - r < 0 ? 0 : ti - r
          const ip = ti + r >= gw ? gw - 1 : ti + r
          const jm = (tj - r < 0 ? 0 : tj - r) * gw
          const jp = (tj + r >= gh ? gh - 1 : tj + r) * gw
          const j0 = tj * gw
          const c = blurred[j0 + ti]
          const hxx = (blurred[j0 + ip] - 2 * c + blurred[j0 + im]) * invXX
          const hzz = (blurred[jp + ti] - 2 * c + blurred[jm + ti]) * invZZ
          const hxz = (blurred[jp + ip] - blurred[jm + ip] - blurred[jp + im] + blurred[jm + im]) * invXZ
          const direct = 0.5 * Math.atan2(2 * hxz, hxx - hzz)
          const read = 0.5 * Math.atan2(ridgeOn.ridge._linear(ridgeOn.ridge.s2[si], u, v) - 127.5, ridgeOn.ridge._linear(ridgeOn.ridge.c2[si], u, v) - 127.5)
          const wrapped = Math.abs(direct - read) % Math.PI
          errs.push((Math.min(wrapped, Math.PI - wrapped) * 180) / Math.PI)
        }
        errs.sort((a, b) => a - b)
        const qAt = (q) => errs[Math.min(errs.length - 1, Math.floor(q * errs.length))]
        check(
          errs.length === DIRS && qAt(0.5) < 2,
          "the baked director is the Hessian's own axis, mod pi -- the double angle carries it across the 0/pi wrap intact",
          `median ${qAt(0.5).toFixed(3)} deg, p95 ${qAt(0.95).toFixed(3)} deg over ${errs.length} gated sites at the ${r}-texel scale`
        )
      }

      // SHATTER IS THE OTHER OPERATOR OVER THE SAME BAKE, AND EVERY ASSERTION
      // BELOW IS AIMED AT A FAILURE MODE `ridge` ACTUALLY HAS.
      //
      // Same gate, same three scales, same band limit, same units of metres --
      // ridge.js builds ONE RidgeField and both knobs read it, which is why the
      // probes here reuse `ridgeOn.ridge` rather than baking a second copy. Only
      // the operator differs, so this section is a controlled comparison and not
      // a description of a new term.
      //
      // IT MUST NOT STRIPE, and that is the assertion the operator exists for.
      // `ridge` filters noise ACROSS the crest, so what survives is a function of
      // along-crest position alone; the level sets of a function of one variable
      // are parallel lines, and |N| creases at every zero crossing. That is
      // corduroy at a fixed spacing -- the standard recipe for a fingerprint
      // texture -- and no amplitude fixes it. Measured as an autocorrelation
      // revival along transects: ridge's correlation comes back up after its first
      // zero crossing, which is what periodic spacing MEANS, and shatter's does
      // not because a tall shard overruns its neighbours and the spacing sets
      // itself. Both are measured in the same run on the same transects so the
      // comparison is one number against another and not against a remembered one.
      //
      // IT MUST BE FACETED. Within a facet the surface is a plane and the second
      // difference is near zero; all the curvature is at the edges between facets.
      // A noise band spreads the same curvature evenly instead. So the statistic
      // is the CONCENTRATION of local curvature, p95 over median, and it is a
      // ratio of two quantiles of one distribution -- invariant under the knob, so
      // three terms carrying different metres can be compared without matching
      // their amplitudes first. Measured on each term ALONE rather than on the
      // composed field, for the reason the sharpen block records at length: the
      // import's own curvature tail is so heavy that nothing estimated through it
      // converges.
      //
      // IT MUST HAVE NO LATTICE SEAM. `_shatterRaw` searches the 3x3 cell
      // neighbourhood only, which is sufficient exactly while no shard can reach
      // out of its own cell. Violate that and the flank is truncated at a straight
      // line one cell out -- a faint square grid pressed over the whole world, and
      // silent. Asserted from both ends: walk fine steps and find no cliff, and
      // hand the constructor a pair that breaks the bound and watch it refuse.
      {
        const shatterKnob = knobOf('shatter')
        const shatterOff = mk({ shatter: shatterKnob.off })
        const shatterOn = mk({ shatter: shatterKnob.on })
        const cragRef = mk({ crag: knobOf('crag').on })
        const shatterAt = (x, z, cell) => ridgeOn.ridge.atShatter(x, z, cell, shatterKnob.on)
        const ridgeAt = (x, z, cell) => ridgeOn.ridge.at(x, z, cell, ridgeKnob.on)

        // OFF IS OFF, on the same terms as every other knob: `===` at every site,
        // because relief.js promises the branch is skipped and not that the term
        // evaluates near zero.
        const SN = 3000
        let sMismatch = 0
        let sWorstOff = 0
        for (let i = 0; i < SN; i++) {
          const p = measureSite(i)
          const a = shatterOff.heightAt(p.x, p.z)
          const b = field.heightAt(p.x, p.z)
          if (a !== b) { sMismatch++; sWorstOff = Math.max(sWorstOff, Math.abs(a - b)) }
        }
        check(sMismatch === 0, 'shatter=0 is the field built with no relief argument at all, bit for bit', `${sMismatch}/${SN} sites differ, worst ${sWorstOff} m`)
        // And the bake is keyed on this knob too. reliefNeeds folds `shatter` into
        // the same `ridge` flag, so a miss there would either cost 9 MB and a
        // Hessian sweep per thread for a term nobody asked for, or -- the other
        // way round -- leave field.ridge null and make `shatter` alone do nothing
        // at all while `ridge` plus `shatter` worked fine.
        check(
          shatterOff.ridge === null && shatterOn.ridge !== null,
          'and shatter=0 does not bake the shared structure -- a knob that borrows another one still pays for nothing when it is off',
          `off: no RidgeField;  on: ${shatterOn.ridge.count} scales of ${shatterOn.ridge.width}x${shatterOn.ridge.height}`
        )

        // The peak population the block above already defined, kept this time:
        // high ground, steep with it, which is where both operators are gated on
        // and the only place a comparison between them means anything.
        const peaks = []
        for (let i = 0; i < PEAK_SITES; i++) {
          if (heights[i] < p90) continue
          const p = measureSite(i)
          if (field.slope01At(p.x, p.z) <= PEAK_SLOPE) continue
          peaks.push({ i, p })
        }

        // --- no stripes ------------------------------------------------------
        //
        // The revival, and the one trap in measuring it: the maximum of r(k) over
        // all lags is r at one sample, ~0.99, off the monotone decay every
        // continuous field has near zero. That number says nothing about spacing.
        // So the search starts at the FIRST ZERO CROSSING -- the correlation has
        // to have died before it is allowed to come back -- and stops at the
        // coarsest teeth wavelength, which is read out of the bake rather than
        // written down because it follows the import's texel size.
        const STRIPE_T = 120
        const STRIPE_STEP = 0.5
        const STRIPE_N = 600
        const STRIPE_MAXLAG = Math.max(...ridgeOn.ridge.lambda)
        const revival = (f, x0, z0, dx, dz) => {
          const v = new Float64Array(STRIPE_N)
          let m = 0
          for (let k = 0; k < STRIPE_N; k++) {
            v[k] = f(x0 + dx * k * STRIPE_STEP, z0 + dz * k * STRIPE_STEP)
            m += v[k]
          }
          m /= STRIPE_N
          let var0 = 0
          for (let k = 0; k < STRIPE_N; k++) { v[k] -= m; var0 += v[k] * v[k] }
          if (!(var0 > 0)) return null
          const maxLag = Math.min(Math.floor(STRIPE_N / 3), Math.floor(STRIPE_MAXLAG / STRIPE_STEP))
          let zero = -1
          const r = new Float64Array(maxLag + 1)
          for (let k = 0; k <= maxLag; k++) {
            let s = 0
            for (let n = 0; n + k < STRIPE_N; n++) s += v[n] * v[n + k]
            r[k] = s / var0
            if (zero < 0 && k > 0 && r[k] <= 0) zero = k
          }
          if (zero < 0) return null
          let best = -1
          let bestK = 0
          for (let k = zero; k <= maxLag; k++) if (r[k] > best) { best = r[k]; bestK = k }
          return { best, lag: bestK * STRIPE_STEP, zero: zero * STRIPE_STEP }
        }
        const midOf = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]
        const rRev = []
        const sRev = []
        const rLag = []
        const sLag = []
        const rZero = []
        for (const { i, p } of peaks) {
          if (rRev.length >= STRIPE_T) break
          const a = measureAngle(i)
          const dx = Math.cos(a)
          const dz = Math.sin(a)
          const rr = revival((x, z) => ridgeAt(x, z, 0), p.x, p.z, dx, dz)
          const rs = revival((x, z) => shatterAt(x, z, 0), p.x, p.z, dx, dz)
          if (!rr || !rs) continue
          rRev.push(rr.best); rLag.push(rr.lag); rZero.push(rr.zero)
          sRev.push(rs.best); sLag.push(rs.lag)
        }
        // The MEDIAN transect and not the mean one. A revival is a maximum over
        // lags, so its estimator is biased upward by however noisy any individual
        // transect happens to be, and a handful of unlucky ones drag a mean around
        // -- shatter's mean is 0.07 against a median of 0.00, entirely on the
        // strength of the tail. The median says what the typical transect does,
        // which is the question.
        const rMid = midOf(rRev)
        const sMid = midOf(sRev)
        console.log(
          `        autocorrelation over ${rRev.length} ${(STRIPE_STEP * STRIPE_N).toFixed(0)} m transects on peak ground, searched past the first zero crossing ` +
            `(median ${midOf(rZero).toFixed(0)} m) out to the ${STRIPE_MAXLAG.toFixed(0)} m coarse teeth wavelength:`
        )
        console.log(
          `        ridge=${ridgeKnob.on} revives to ${rMid.toFixed(3)} at a median lag of ${midOf(rLag).toFixed(0)} m,  ` +
            `shatter=${shatterKnob.on} to ${sMid.toFixed(3)} at ${midOf(sLag).toFixed(0)} m`
        )
        check(
          sMid < rMid * 0.35,
          'shatter does not stripe -- its correlation dies at the first zero crossing and never comes back',
          `median revival ${sMid.toFixed(3)} against ridge's ${rMid.toFixed(3)} on the same transects`
        )
        check(
          rMid > 0.05,
          'and the instrument can see corduroy, because ridge really does have it -- this is the failure the operator was written to answer',
          `ridge revives to ${rMid.toFixed(3)} at a median lag of ${midOf(rLag).toFixed(0)} m, about half its ${STRIPE_MAXLAG.toFixed(0)} m coarse teeth wavelength`
        )

        // --- faceted, not merely displaced -----------------------------------
        const concentration = (on) => {
          const c = []
          let d2 = 0
          for (const { i, p } of peaks) {
            const term = (x, z) => on.heightAt(x, z) - field.heightAt(x, z)
            const a = measureAngle(i)
            const cx = Math.cos(a) * LAG
            const cz = Math.sin(a) * LAG
            c.push(Math.abs(term(p.x + cx, p.z + cz) - 2 * term(p.x, p.z) + term(p.x - cx, p.z - cz)))
            const d = term(p.x, p.z)
            d2 += d * d
          }
          c.sort((a, b) => a - b)
          const q = (t) => c[Math.min(c.length - 1, Math.floor(t * c.length))]
          return { ratio: q(0.95) / q(0.5), med: q(0.5), p95: q(0.95), disp: Math.sqrt(d2 / c.length) }
        }
        const cCrag = concentration(cragRef)
        const cRidge = concentration(ridgeOn)
        const cShatter = concentration(shatterOn)
        console.log(
          `        ${LAG} m curvature of each term alone over ${peaks.length} peak sites, p95 / median:  ` +
            `crag=${knobOf('crag').on} ${cCrag.ratio.toFixed(1)}x,  ridge=${ridgeKnob.on} ${cRidge.ratio.toFixed(1)}x,  shatter=${shatterKnob.on} ${cShatter.ratio.toFixed(1)}x`
        )
        console.log(
          `        (median ${cCrag.med.toFixed(4)} / ${cRidge.med.toFixed(4)} / ${cShatter.med.toFixed(4)} m against p95 ${cCrag.p95.toFixed(4)} / ${cRidge.p95.toFixed(4)} / ${cShatter.p95.toFixed(4)} m, ` +
            `displacing ${cCrag.disp.toFixed(2)} / ${cRidge.disp.toFixed(2)} / ${cShatter.disp.toFixed(2)} m rms)`
        )
        check(
          cShatter.ratio > Math.max(cCrag.ratio, cRidge.ratio) * 1.5,
          'shatter puts its curvature on edges and leaves the facets between them flat -- crisper than either noise band',
          `${cShatter.ratio.toFixed(1)}x against crag ${cCrag.ratio.toFixed(1)}x and ridge ${cRidge.ratio.toFixed(1)}x`
        )

        // --- continuous everywhere, with no lattice seam ---------------------
        //
        // A 1 cm step is two orders of magnitude below the finest shard, so a
        // truncated flank cannot hide inside one: the reach failure is a step in
        // the VALUE, and a value step of any size shows up here as a slope no
        // face has. Measured on the term alone at cell 0, where the pyramid edges
        // are perfectly sharp and there is no rounding to soften anything.
        const SEAM_T = 16
        const SEAM_STEP = 0.01
        const SEAM_N = 20000
        let worstJump = 0
        let liveTerm = 0
        for (let t = 0; t < SEAM_T; t++) {
          const { i, p } = peaks[(t * 7) % peaks.length]
          const a = measureAngle(i)
          const dx = Math.cos(a)
          const dz = Math.sin(a)
          let prev = shatterAt(p.x, p.z, 0)
          for (let k = 1; k < SEAM_N; k++) {
            const v = shatterAt(p.x + dx * k * SEAM_STEP, p.z + dz * k * SEAM_STEP, 0)
            const jump = Math.abs(v - prev)
            if (jump > worstJump) worstJump = jump
            if (Math.abs(v) > liveTerm) liveTerm = Math.abs(v)
            prev = v
          }
        }
        console.log(
          `        ${SEAM_T} transects of ${(SEAM_N * SEAM_STEP).toFixed(0)} m walked at ${(SEAM_STEP * 100).toFixed(0)} cm: worst step ${worstJump.toFixed(4)} m, ` +
            `a slope of ${(worstJump / SEAM_STEP).toFixed(2)}, over a term reaching ${liveTerm.toFixed(1)} m`
        )
        check(
          worstJump < 0.05,
          'the shatter surface is continuous -- the steepest 1 cm step is a face, not a cliff, so no shard is truncated at a cell wall',
          `worst ${worstJump.toFixed(4)} m over ${SEAM_STEP * 100} cm (slope ${(worstJump / SEAM_STEP).toFixed(2)}) against a 0.05 m limit`
        )
        check(
          liveTerm > 1,
          'and the transects ran over real shards, so that is not continuity by inaction',
          `the term reaches ${liveTerm.toFixed(1)} m along them`
        )
        // THE GUARD ITSELF, because the check above can only see the parameters
        // that shipped. taper 1.8 with tilt 0.6 is the pair the constant carried
        // until the reach bound was corrected: 1/(taper - tilt) is 0.83 cells and
        // reads legal, but a Chebyshev level set is a SQUARE and its corners stand
        // at sqrt(2) times its inradius, so the true reach is 1.18 cells and the
        // 3x3 evaluator was clipping flanks. A guard that only refuses the
        // obviously broken pairs would not have caught it.
        let guardThrew = false
        let guardMsg = ''
        try {
          new RidgeField(hm, { seed: WORLD_SEED, taper: 1.8, tilt: 0.6 })
        } catch (e) {
          guardThrew = true
          guardMsg = e.message
        }
        check(
          guardThrew && /shard/.test(guardMsg),
          'and a taper/tilt pair whose shards would leave their own cell is REFUSED at construction rather than drawing a square grid over the world',
          guardThrew ? guardMsg.replace(/^RidgeField: /, '') : 'taper 1.8, tilt 0.6 was accepted'
        )

        // --- it lands on the spines ------------------------------------------
        //
        // Held against ridge and crag on the same sites, and the honest reading is
        // that neither directed term is anywhere near crag's selectivity: crag has
        // a hard slope gate and is EXACTLY zero on valley floors, while the
        // ridgeness gate is a smoothstep over a percentile and leaves both of
        // these terms with something to say on gentle ground. The claim being
        // checked is therefore the modest one -- more on the spines than off them
        // -- and the number is printed so it stays modest.
        const GENTLE = CRAG_SLOPE_LO
        const selectivity = (on) => {
          let p2 = 0
          let pn = 0
          let g2 = 0
          let gn = 0
          for (let i = 0; i < PEAK_SITES; i++) {
            const p = measureSite(i)
            const d = on.heightAt(p.x, p.z) - field.heightAt(p.x, p.z)
            const s = field.slope01At(p.x, p.z)
            if (heights[i] >= p90 && s > PEAK_SLOPE) { p2 += d * d; pn++ }
            else if (s <= GENTLE) { g2 += d * d; gn++ }
          }
          return { peak: Math.sqrt(p2 / pn), gentle: Math.sqrt(g2 / gn), pn, gn }
        }
        const selShatter = selectivity(shatterOn)
        const selRidge = selectivity(ridgeOn)
        const selCrag = selectivity(cragRef)
        console.log(
          `        rms on ${selShatter.pn} peak sites against ${selShatter.gn} sites under slope01 ${GENTLE}:  ` +
            `shatter ${selShatter.peak.toFixed(3)} / ${selShatter.gentle.toFixed(3)} m (${(selShatter.peak / selShatter.gentle).toFixed(1)}x),  ` +
            `ridge ${selRidge.peak.toFixed(3)} / ${selRidge.gentle.toFixed(3)} m (${(selRidge.peak / selRidge.gentle).toFixed(1)}x),  ` +
            `crag ${selCrag.peak.toFixed(3)} / ${selCrag.gentle.toFixed(3)} m (gated off exactly)`
        )
        check(
          selShatter.peak > selShatter.gentle * 1.5,
          'shatter cuts harder on the spines than on gentle ground',
          `${(selShatter.peak / selShatter.gentle).toFixed(1)}x, against the ${(selRidge.peak / selRidge.gentle).toFixed(1)}x ridge manages on the same sites`
        )

        // --- and it fades with the mesh --------------------------------------
        //
        // Same smoothstep on the same baked wavelengths as `ridge`, so the same
        // `dead` cell silences it, and for the same reason: a term that outlived
        // the terms beside it would change the character of the ground with
        // viewing distance.
        //
        // The ladder is HALF EACH BAKED WAVELENGTH rather than an even split of
        // the range, because those are the cells where the weights are exactly 0
        // or exactly 1 and nothing is caught halfway. Each rung therefore holds
        // one scale fewer than the one above it, and the term should step down as
        // each one goes.
        const ladder = [0, ...ridgeOn.ridge.lambda.map((l) => l / 2)]
        const cellStats = (cell) => {
          let s = 0
          let s2 = 0
          let alive = 0
          for (let i = 0; i < SN; i++) {
            const p = measureSite(i)
            const v = shatterAt(p.x, p.z, cell)
            if (v !== 0) alive++
            s += v
            s2 += v * v
          }
          return { rms: Math.sqrt(s2 / SN), mean: s / SN, alive }
        }
        const rungs = ladder.map(cellStats)
        const last = rungs[rungs.length - 1]
        console.log(
          `        shatter=${shatterKnob.on} against cell size, over ${SN} sites: ` +
            ladder.map((c, k) => `${c.toFixed(1)} m -> ${rungs[k].rms.toFixed(3)} m (${rungs[k].alive} alive)`).join(',  ')
        )
        let fades = true
        for (let k = 1; k < rungs.length; k++) if (!(rungs[k].rms < rungs[k - 1].rms)) fades = false
        check(
          fades,
          'each baked scale drops out of the shatter term at exactly half its own wavelength, and the term steps down as each one goes',
          `${rungs.map((r) => r.rms.toFixed(3)).join(' -> ')} m over ${ladder.length} rungs`
        )
        check(
          last.alive === 0,
          `every scale is band-limited away by a ${dead.toFixed(1)} m cell -- the term is EXACTLY 0, not small`,
          `${last.alive}/${SN} sites still moving`
        )
        // AND IN BETWEEN THE RUNGS TOO, which the ladder above cannot see on its
        // own: those cells are chosen where every weight is exactly 0 or exactly
        // 1, so a term that lurched about between them would still step down
        // cleanly at each one. The off-rung cell is printed for that reason.
        const mid = cellStats(dead / 2)
        console.log(
          `        (and in between: a ${(dead / 2).toFixed(1)} m cell reads ${mid.rms.toFixed(3)} m rms against ${rungs[rungs.length - 2].rms.toFixed(3)} m at ` +
            `${ladder[ladder.length - 2].toFixed(1)} m, with a mean of ${mid.mean.toFixed(3)} m against ${rungs[0].mean.toFixed(3)} m at cell 0)`
        )

        // --- and the fade leaves the GROUND where it was ---------------------
        //
        // THE LADDER ABOVE IS ABOUT AMPLITUDE; THIS IS ABOUT WHERE THE MIDDLE OF
        // IT SITS, and the two are independent. A term can shrink to nothing with
        // distance and still drag the surface down on its way out -- which is what
        // this operator did, and it is the most expensive kind of wrong a height
        // field can be, because a distant hill standing metres below where it will
        // stand when you reach it does not read as a bug. It reads as hills growing
        // in front of you as you fly.
        //
        // THE MECHANISM, and it is FIRST-ORDER rather than a second-order slop that
        // the band limit could be trusted to absorb. `atShatter` rounds the pyramid
        // apexes by SHATTER_VERTEX_CELLS * cell / lambda so a shard's edges are
        // never narrower than the triangles carrying them, and that rounding does
        // not merely soften the envelope, it COLLAPSES it: the mean raw envelope
        // runs 0.186 at round 0 and is exactly 0 well before the last knot, and the
        // whole table is printed below so the shape is on the record. Subtract a
        // round-0 constant from a collapsed envelope and what is left is not a
        // fading term at all, it is `r * (0 - 0.186) * gain` -- a negative constant
        // scaled by the ridgeness gate, digging out precisely the crests the gate
        // selects.
        //
        // THE BAND LIMIT DOES NOT RESCUE IT, which is the part that makes this easy
        // to reason past. The two effects are on different schedules, and the
        // argument is stated in units of `round` rather than of metres because
        // SHATTER_VERTEX_CELLS has been retuned once already and any figure in
        // metres goes stale the moment it moves again: `bw` holds a scale FULLY on
        // (weight exactly 1) all the way out to cell = lambda / 4, and the mean
        // measured at that cell is printed below beside the round-0 one. Whatever
        // the gap between those two numbers reads, it is offset the old code left
        // standing on ground the band limit had not begun to retire. The PRE-FIX
        // row further down is that same claim as a measured sag in metres, and it
        // fails the bound it is checked against.
        //
        // So the mean is tabulated against `round` and interpolated, and the four
        // probes below are the four ways that can be got wrong: the table can be
        // read at the wrong argument (the bias check), it can be built so it no
        // longer agrees with the old constant at cell 0 (the close-up identity), it
        // can be too short for the collapse (the tail), and it can be measured on a
        // sample too small to be monotone (the knots).
        {
          const rf = ridgeOn.ridge

          // SHATTER_MEAN_KNOTS and SHATTER_MEAN_STEP are module-private in
          // ridge.js, so they are read out of it AS TEXT -- the same trick the
          // slope-units section uses on player.js, and worth more than an import
          // would be: the knot count read from the source is then checked against
          // the array the bake actually filled, so a table shortened in one place
          // and not the other fails here instead of silently reading 0 over the
          // part of the rounding it no longer covers.
          const ridgeSrc = await readFile(RIDGE_PATH, 'utf8')
          const KNOTS = Number(/SHATTER_MEAN_KNOTS\s*=\s*([0-9.]+)/.exec(ridgeSrc)[1])
          const STEP = Number(/SHATTER_MEAN_STEP\s*=\s*([0-9.]+)/.exec(ridgeSrc)[1])
          const knotAt = (s, k) => rf._sMeanTab[s * KNOTS + k]
          console.log(
            `        shatter mean envelope tabulated over ${KNOTS} knots at ${STEP} in round, reaching round ${((KNOTS - 1) * STEP).toFixed(1)} ` +
              `(round = ${SHATTER_VERTEX_CELLS} * cell / lambda, so ${(((KNOTS - 1) * STEP * rf.lambda[0]) / SHATTER_VERTEX_CELLS).toFixed(1)} m of cell at the finest scale):`
          )
          for (let s = 0; s < rf.count; s++) {
            console.log(
              `          scale ${s} (lambda ${rf.lambda[s].toFixed(1)} m): ` +
                Array.from({ length: KNOTS }, (_, k) => knotAt(s, k).toFixed(4)).join(' ')
            )
          }
          // The two schedules, side by side, in the units that survive a retune.
          // `bw = smoothstep(2*cell, 4*cell, lambda)` is still exactly 1 at
          // cell = lambda / 4, so the round reached there is the LAST argument at
          // which the band limit is doing nothing at all -- and the mean already
          // read at it is what the old code was subtracting the round-0 constant
          // against on a fully present scale.
          const fullRound = SHATTER_VERTEX_CELLS * 0.25
          console.log(
            `        where the two schedules disagree: bw is still exactly 1 out to cell = lambda/4, i.e. round ${fullRound.toFixed(2)}, ` +
              `and the mean there has already fallen ` +
              rf.lambda.map((l, s) => `${rf._shatterMean(s, 0).toFixed(3)} -> ${rf._shatterMean(s, fullRound).toFixed(3)} (${l.toFixed(0)} m)`).join(', ')
          )
          check(
            rf._sMeanTab.length === rf.count * KNOTS,
            `the mean table ridge.js baked is the ${KNOTS} knots per scale its own constant declares`,
            `${rf._sMeanTab.length} entries over ${rf.count} scales`
          )

          // THE CLOSE-UP IDENTITY, and it is `===` rather than a tolerance for the
          // reason every bit-exact check in this file is: this is the assertion
          // that the ground she WALKS on did not move. At cell 0 the rounding is 0,
          // knot 0 is the round-0 mean the old code subtracted everywhere, and the
          // interpolation at t = 0 must return it untouched. A millimetre here is a
          // player hovering or sinking, and a table that had been rebuilt with a
          // different sample count or a knot 0 at STEP rather than at 0 would land
          // exactly there.
          const idBad = []
          for (let s = 0; s < rf.count; s++) if (rf._shatterMean(s, 0) !== rf._sMean[s]) idBad.push(s)
          check(
            idBad.length === 0,
            'at cell 0 the tabulated mean IS the round-0 mean, bit for bit, at every scale -- the surface she walks on did not move',
            `${rf.count} scales, ${rf.lambda.map((l, s) => `${l.toFixed(0)} m: ${rf._shatterMean(s, 0)}`).join(', ')}`
          )

          // THE TABLE SPANS THE ROUNDING. `_shatterMean` returns a flat 0 past the
          // last knot, so if the envelope has not actually gone by then the lookup
          // starts inventing a mean of 0 for a term that still has one -- which is
          // the trench above, back again and now confined to the far LOD tiers
          // where nobody stands to notice. The bake throws on this too; asserted
          // here as well so the tail is a number on the record rather than a
          // condition that merely failed to fire.
          const tails = Array.from({ length: rf.count }, (_, s) => knotAt(s, KNOTS - 1))
          check(
            tails.every((t) => t === 0),
            `the envelope's mean is EXACTLY 0 at the last knot, so the lookup's flat tail is the truth and not an assumption`,
            `round ${((KNOTS - 1) * STEP).toFixed(1)}: ${tails.join(', ')}`
          )
          // Monotone, because rounding a pyramid's edges off can only take envelope
          // away and never add it. A rise anywhere in the table is a sampling
          // artifact -- MEAN_SITES too small for the scale -- and it would put a
          // slope of the wrong sign into the interpolation, which is a term that
          // grows slightly as the mesh coarsens.
          const rises = []
          for (let s = 0; s < rf.count; s++) {
            for (let k = 1; k < KNOTS; k++) if (knotAt(s, k) > knotAt(s, k - 1)) rises.push(`scale ${s} knot ${k}`)
          }
          check(
            rises.length === 0,
            'and it falls monotonically with the rounding -- rounding a shard off removes envelope, it cannot add any',
            rises.length ? rises.join(', ') : `0 rises over ${rf.count * (KNOTS - 1)} knot intervals, ${knotAt(0, 0).toFixed(4)} down to 0`
          )

          // THE PRE-FIX OPERATOR, REBUILT. Nine lines of `atShatter` with ONE
          // symbol changed -- `_sMean[s]`, the single round-0 constant, where the
          // shipped code reads `_shatterMean(s, round)` -- and it is what turns the
          // bias bound below from a formality into a bound. A threshold that only
          // the correct code has ever been run against says nothing about how loose
          // it is; this one is measured against the exact expression that shipped
          // the bug, on the same sites, in the same run.
          const shatterOldAt = (x, z, cell) => {
            const u = (x + WORLD_HALF) * rf._invX
            const v = (z + WORLD_HALF) * rf._invZ
            let sum = 0
            for (let s = 0; s < rf.count; s++) {
              const bw = cell > 0 ? smoothstep(cell * 2, cell * 4, rf.lambda[s]) : 1
              if (bw <= 0) continue
              const r = clamp01(rf._cubic(rf.ridge[s], u, v) * (1 / 255))
              if (r <= 0) continue
              const round = SHATTER_VERTEX_CELLS * cell * rf._freq[s]
              sum += bw * rf.sWeight[s] * r * (rf._shatterRaw(x, z, s, round) - rf._sMean[s]) * rf._sGain[s]
            }
            return shatterKnob.on * sum
          }

          // PEAK GROUND, the same p90 off the same scatter the block above sorted,
          // without the slope gate: the sag is driven by the ridgeness gate rather
          // than by steepness, and summit plateaus are exactly where a person
          // stands and looks at the range opposite.
          const above = []
          for (let i = 0; i < PEAK_SITES; i++) if (heights[i] >= p90) above.push(measureSite(i))
          const BIAS_CELLS = [1, 2, 4, 8, 16, 32, 64]
          // 3x the worst measured bias of any correct term here and 4.6x under the
          // 2.31 m the pre-fix operator sags at a 16 m cell. Wide enough that a
          // re-import or a re-tune does not have to move it, narrow enough that
          // half a metre of drift on a summit -- a stride's worth of climb
          // appearing out of nothing as a chunk splits -- fails.
          const BIAS_BOUND = 0.5

          // Hoisted, because it is the shape of loop that has cost this file dearly
          // before: a V2Height built inside the sample loop took a section from 8 s
          // to 387 s and passed the whole time.
          const biasOf = (f) => BIAS_CELLS.map((cell) => {
            let sum = 0
            let worst = 0
            for (const p of above) {
              const d = f(p.x, p.z, cell) - f(p.x, p.z, 0)
              sum += d
              if (Math.abs(d) > Math.abs(worst)) worst = d
            }
            return { mean: sum / above.length, worst }
          })
          const rowsBias = [
            [`shatter=${shatterKnob.on}`, biasOf((x, z, cell) => shatterOn.heightAt(x, z, cell))],
            [`ridge=${ridgeKnob.on}`, biasOf((x, z, cell) => ridgeOn.heightAt(x, z, cell))],
            [`crag=${knobOf('crag').on}`, biasOf((x, z, cell) => cragRef.heightAt(x, z, cell))],
            // The pre-fix world: the shipped field with the shipped shatter term
            // swapped for the rebuilt one. Everything else about it is identical,
            // so the difference between this row and the first IS the mean table.
            ['PRE-FIX', biasOf((x, z, cell) => shatterOn.heightAt(x, z, cell) + shatterOldAt(x, z, cell) - shatterAt(x, z, cell))],
          ]
          console.log(
            `        LOD bias on ${above.length} sites above p90 (${p90.toFixed(0)} m), mean heightAt(cell) - heightAt(0) in m, against a ${BIAS_BOUND.toFixed(1)} m bound:`
          )
          console.log('          ' + 'cell'.padEnd(14) + BIAS_CELLS.map((c) => `${c} m`.padStart(9)).join(''))
          for (const [label, row] of rowsBias) {
            console.log('          ' + label.padEnd(14) + row.map((r) => `${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(3)}`.padStart(9)).join(''))
          }
          const worstOf = (row) => row.reduce((a, r) => Math.max(a, Math.abs(r.mean)), 0)
          const cellOf = (row) => BIAS_CELLS[row.indexOf(row.reduce((a, r) => (Math.abs(r.mean) > Math.abs(a.mean) ? r : a)))]
          for (const [label, row] of rowsBias.slice(0, 3)) {
            check(
              worstOf(row) < BIAS_BOUND,
              `${label} moves peak ground by under ${BIAS_BOUND.toFixed(1)} m of mean bias at every cell from ${BIAS_CELLS[0]} to ${BIAS_CELLS[BIAS_CELLS.length - 1]} m`,
              `worst ${worstOf(row).toFixed(3)} m at a ${cellOf(row)} m cell, over ${above.length} sites`
            )
          }
          // AND THE BOUND CAN BE FAILED. The first three rows come out at a
          // fraction of it, which is the right answer and is also what a bound
          // loose enough to pass anything looks like.
          const pre = rowsBias[3][1]
          check(
            worstOf(pre) > BIAS_BOUND,
            `and the pre-fix operator FAILS that same bound on those same sites -- a round-0 mean against a collapsed envelope, which is what this probe was written to catch`,
            `worst ${worstOf(pre).toFixed(3)} m at a ${cellOf(pre)} m cell (${(worstOf(pre) / BIAS_BOUND).toFixed(1)}x the bound), worst single site ${pre.reduce((a, r) => (Math.abs(r.worst) > Math.abs(a) ? r.worst : a), 0).toFixed(1)} m`
          )
          // And the control is the shipped operator everywhere the fix is a no-op,
          // or the row above is a different term rather than the same term with one
          // symbol changed. `===`: at round 0 the interpolation reads knot 0, which
          // IS `_sMean`, so this is exact arithmetic and not a near miss.
          let ctrlDiff = 0
          for (const p of above) if (shatterOldAt(p.x, p.z, 0) !== shatterAt(p.x, p.z, 0)) ctrlDiff++
          check(
            ctrlDiff === 0,
            'and at cell 0 that control IS the shipped operator, bit for bit -- so the row above differs from the world in one symbol and nowhere else',
            `${ctrlDiff}/${above.length} sites differ`
          )

          // THE MAGNITUDE NEVER GROWS WITH THE CELL. Weaker than the bias check and
          // deliberately kept beside it: a term whose contribution got LARGER as the
          // mesh coarsened would be a term the LOD ladder cannot converge on at all,
          // whatever its mean did. Printed for both operators because the pre-fix
          // one PASSES this -- its sag is a constant offset, which shrinks along
          // with everything else -- and that is the whole argument for why the bias
          // check has to exist separately.
          const MAG_CELLS = [0, 1, 2, 4, 8, 16, 32, 64]
          const magOf = (f) => MAG_CELLS.map((cell) => {
            let s = 0
            for (let i = 0; i < SN; i++) {
              const p = measureSite(i)
              s += Math.abs(f(p.x, p.z, cell))
            }
            return s / SN
          })
          const magNew = magOf(shatterAt)
          const magOld = magOf(shatterOldAt)
          console.log(`        mean |shatter| over ${SN} sites by cell: ` + MAG_CELLS.map((c, k) => `${c} m -> ${magNew[k].toFixed(3)} m`).join(',  '))
          console.log(`          (pre-fix, for contrast: ` + MAG_CELLS.map((c, k) => `${magOld[k].toFixed(3)}`).join(' ') + ` -- also non-increasing, which is why the bias row above is the probe that matters)`)
          const grew = []
          for (let k = 1; k < MAG_CELLS.length; k++) if (magNew[k] > magNew[k - 1]) grew.push(`${MAG_CELLS[k - 1]} -> ${MAG_CELLS[k]} m`)
          check(
            grew.length === 0,
            'the shatter term never contributes MORE at a coarser cell than at a finer one',
            grew.length ? `grew over ${grew.join(', ')}` : `${magNew[0].toFixed(3)} m at cell 0 down to ${magNew[MAG_CELLS.length - 1].toFixed(3)} m at ${MAG_CELLS[MAG_CELLS.length - 1]} m, over ${MAG_CELLS.length} rungs`
          )

          // --- and the individual SUMMITS, which the mean above cannot see ------
          //
          // A ZERO MEAN IS COMPATIBLE WITH A HILL CLIMBING TWENTY METRES, and the
          // block above is a mean. It was written against a bias that really was a
          // uniform offset, it passed at 0.07 m once the mean table landed, and the
          // symptom -- one particular hill visibly rising as you fly at it -- did
          // not go away. That is not the probe having been wrong. It is the probe
          // having answered the question it asks, which is about the population, in
          // a world where what a person actually looks at is one point of it. So
          // this block asserts on the DISTRIBUTION over the highest ground instead:
          // p95 and max of each summit's own |heightAt(cell) - heightAt(0)|, no
          // averaging across sites anywhere in it.
          //
          // THE BOUNDS ARE IN UNITS OF THE CELL, the same rule section 4 already
          // holds the mesher to: a summit may not move by as much as a fraction of
          // the triangle that is representing it. Metres alone would be the wrong
          // unit here -- a 32 m cell is entitled to more slop than a 2 m one, and a
          // flat metre bound would be simultaneously unreachable up close and
          // meaningless far out.
          //
          // WHAT IS LEFT IS NOT ZERO AND THE BOUND DOES NOT PRETEND IT IS. Roughly
          // ten metres of climb remains on the worst summits at the coarsest rungs.
          // It is NOT the apex rounding, which SHATTER_VERTEX_CELLS now handles; it
          // is the band limit itself retiring whole scales -- once `bw` reaches 0 a
          // scale's shard is gone from that tier entirely, and no rounding constant
          // can reach that. It is a known, open defect, it is not fixed, and it has
          // not been judged either way. What this probe does is pin the CURRENT
          // numbers so the next change to the term has to be deliberate about them.
          const summitOrder = Array.from({ length: PEAK_SITES }, (_, i) => i).sort((a, b) => heights[b] - heights[a])
          const SUMMIT_N = 60
          const summits = summitOrder.slice(0, SUMMIT_N).map((i) => measureSite(i))
          const SUM_CELLS = [2, 4, 8, 16, 32]

          // The operator with the apex rounding parameterised, so the constant that
          // was just retuned is a variable here rather than a fact of the file. The
          // vc = 3 row below is the shipped world with ONLY that constant put back,
          // and it is a regression control in exactly the sense the PRE-FIX row is:
          // the bound is measured against a version known to be wrong, in the same
          // run, on the same summits.
          const shatterAtVC = (vc) => (x, z, cell) => {
            const u = (x + WORLD_HALF) * rf._invX
            const v = (z + WORLD_HALF) * rf._invZ
            let sum = 0
            for (let s = 0; s < rf.count; s++) {
              const bw = cell > 0 ? smoothstep(cell * 2, cell * 4, rf.lambda[s]) : 1
              if (bw <= 0) continue
              const r = clamp01(rf._cubic(rf.ridge[s], u, v) * (1 / 255))
              if (r <= 0) continue
              const round = vc * cell * rf._freq[s]
              sum += bw * rf.sWeight[s] * r * (rf._shatterRaw(x, z, s, round) - rf._shatterMean(s, round)) * rf._sGain[s]
            }
            return shatterKnob.on * sum
          }
          const shatterVCShipped = shatterAtVC(SHATTER_VERTEX_CELLS)
          const shatterVC3 = shatterAtVC(3)
          let vcDiff = 0
          for (const p of summits) {
            if (shatterVCShipped(p.x, p.z, 0) !== shatterAt(p.x, p.z, 0)) vcDiff++
            if (shatterVCShipped(p.x, p.z, 16) !== shatterAt(p.x, p.z, 16)) vcDiff++
          }
          check(
            vcDiff === 0,
            `at SHATTER_VERTEX_CELLS = ${SHATTER_VERTEX_CELLS} the parameterised operator IS the shipped one, bit for bit, at cell 0 and at a 16 m cell -- so the vc=3 row below differs from the world in that constant and nothing else`,
            `${vcDiff}/${summits.length * 2} summit samples differ`
          )

          const ladderOf = (f) => SUM_CELLS.map((cell) => {
            const d = summits.map((p) => Math.abs(f(p.x, p.z, cell) - f(p.x, p.z, 0))).sort((a, b) => a - b)
            return { cell, p95: d[Math.floor(0.95 * (d.length - 1))], max: d[d.length - 1] }
          })
          const withVC3 = (x, z, cell) => shatterOn.heightAt(x, z, cell) + shatterVC3(x, z, cell) - shatterVCShipped(x, z, cell)
          const rowsSummit = [
            ['all off', ladderOf((x, z, cell) => field.heightAt(x, z, cell))],
            [`shatter=${shatterKnob.on}`, ladderOf((x, z, cell) => shatterOn.heightAt(x, z, cell))],
            ['vc=3', ladderOf(withVC3)],
          ]
          console.log(
            `        per-summit LOD growth, top ${SUMMIT_N} of the ${PEAK_SITES}-site scatter (${heights[summitOrder[SUMMIT_N - 1]].toFixed(0)} .. ${heights[summitOrder[0]].toFixed(0)} m), ` +
              `|heightAt(cell) - heightAt(0)| per site in m, no averaging across sites:`
          )
          console.log('          ' + 'cell'.padEnd(12) + SUM_CELLS.map((c) => `${c} m`.padStart(16)).join(''))
          for (const [label, row] of rowsSummit) {
            console.log('          ' + label.padEnd(12) + row.map((r) => `${r.p95.toFixed(2)}/${r.max.toFixed(2)}`.padStart(16)).join('') + '   (p95/max)')
          }

          // Scale-free, and the same shape of rule as section 4's `worstCells`:
          // 0.75 of a cell for the worst summit, 0.45 for the 95th percentile of
          // them. Both are set from what the shipped term measures with headroom --
          // the shipped max peaks at 0.45 cells and its p95 at 0.33 -- and both are
          // failed by the vc = 3 row at 1.27 and 0.96 cells, so neither is a bound
          // that merely happens to be true.
          const SUMMIT_MAX_CELLS = 0.75
          const SUMMIT_P95_CELLS = 0.45
          const inCells = (row, key) => row.reduce((a, r) => Math.max(a, r[key] / r.cell), 0)
          const atCells = (row, key) => row.reduce((a, r) => (r[key] / r.cell > a[key] / a.cell ? r : a)).cell
          const shipped = rowsSummit[1][1]
          const meanBiasWorst = worstOf(rowsBias[0][1])
          check(
            inCells(shipped, 'max') < SUMMIT_MAX_CELLS,
            `no single summit of the top ${SUMMIT_N} climbs by ${SUMMIT_MAX_CELLS} of a cell between LOD tiers -- the growth the mean-bias probe above cannot see`,
            `worst ${inCells(shipped, 'max').toFixed(2)} cells (${shipped.reduce((a, r) => Math.max(a, r.max), 0).toFixed(2)} m at a ${atCells(shipped, 'max')} m cell), against ${meanBiasWorst.toFixed(3)} m of MEAN bias over the same knob -- one summit moves metres where the population moves centimetres`
          )
          check(
            inCells(shipped, 'p95') < SUMMIT_P95_CELLS,
            `and 95% of those summits stay inside ${SUMMIT_P95_CELLS} of a cell, so the worst is a tail and not the typical summit`,
            `worst p95 ${inCells(shipped, 'p95').toFixed(2)} cells (${shipped.reduce((a, r) => Math.max(a, r.p95), 0).toFixed(2)} m at a ${atCells(shipped, 'p95')} m cell)`
          )
          const vc3row = rowsSummit[2][1]
          check(
            inCells(vc3row, 'max') > SUMMIT_MAX_CELLS && inCells(vc3row, 'p95') > SUMMIT_P95_CELLS,
            `and putting SHATTER_VERTEX_CELLS back to 3 FAILS both of those bounds on those same summits -- rounding a shard by three cells shrinks it faster than the mesh loses the ability to draw it`,
            `max ${inCells(vc3row, 'max').toFixed(2)} cells and p95 ${inCells(vc3row, 'p95').toFixed(2)} cells, against ${SUMMIT_MAX_CELLS} and ${SUMMIT_P95_CELLS}`
          )

          // THE MESHER'S OWN SHARE, which is what makes the rows above attributable
          // to the knob at all. Every LOD tier resamples a band-limited field, so
          // some movement is structural and belongs to no relief term. Bounded in
          // cells like the two shatter bounds above, because what a swap shows is
          // the fraction of a cell a vertex jumps, not the metre: with all four
          // knobs off the detail stack's own retiring octaves reach 0.28 of a cell
          // at the 2 m tier (0.57 m on the steepest summit, where SLOPE_BOOST is
          // near full) and a tenth of a cell at 16 m, against shatter's 0.53.
          const OFF_MAX_CELLS = 0.35
          const offRow = rowsSummit[0][1]
          const offMax = offRow.reduce((a, r) => Math.max(a, r.max), 0)
          const shippedMax = shipped.reduce((a, r) => Math.max(a, r.max), 0)
          check(
            inCells(offRow, 'max') < OFF_MAX_CELLS,
            `with every relief knob off, no summit moves ${OFF_MAX_CELLS} of a cell across the whole ladder -- LOD growth on a summit past that is a knob's doing, not the mesher's`,
            `worst ${inCells(offRow, 'max').toFixed(2)} cells (${offMax.toFixed(2)} m at a ${atCells(offRow, 'max')} m cell), over ${SUMMIT_N} summits and ${SUM_CELLS.length} tiers`
          )
          check(
            shippedMax / offMax > 4,
            `and the shatter knob moves them at least 4x further than that bare ladder does, so the residual below is the term's to answer for`,
            `${shippedMax.toFixed(2)} m against ${offMax.toFixed(2)} m, ${(shippedMax / offMax).toFixed(1)}x`
          )

          // THE SHAPE, for two or three summits by name, because a percentile does
          // not show which DIRECTION a summit goes or that different summits go
          // opposite ways. Some sink as the mesh coarsens and some rise; a reader
          // who has only seen the bias row would expect neither.
          const movers = summits
            .map((p) => {
              const base = shatterOn.heightAt(p.x, p.z, 0)
              return { p, d: Math.max(...SUM_CELLS.map((c) => Math.abs(shatterOn.heightAt(p.x, p.z, c) - base))) }
            })
            .sort((a, b) => b.d - a.d)
            .slice(0, 3)
          const LAD_CELLS = [0, ...SUM_CELLS]
          console.log(`        the three worst of them by name, heightAt in m at cells ${LAD_CELLS.join('/')}:`)
          for (const m of movers) {
            console.log(
              `          (${m.p.x.toFixed(0)}, ${m.p.z.toFixed(0)})  shatter ` +
                LAD_CELLS.map((c) => shatterOn.heightAt(m.p.x, m.p.z, c).toFixed(1)).join(' -> ') +
                `   all off ` +
                LAD_CELLS.map((c) => field.heightAt(m.p.x, m.p.z, c).toFixed(1)).join(' -> ')
            )
          }
          console.log(
            `        the ~${shippedMax.toFixed(0)} m spread in those rows is the OPEN residual: the band limit retiring whole scales, which no rounding constant reaches. Not fixed, not yet judged -- pinned here so it cannot get worse unnoticed.`
          )
        }
      }
    }

    // CREASE, WHICH IS THE ONLY KNOB THAT CHANGES HOW THE IMPORT IS READ RATHER
    // THAN WHAT IS ADDED TO IT.
    //
    // ALMOST EVERYTHING BELOW IS ASSERTED AGAINST A BARE CreaseField AND NOT
    // AGAINST TWO V2Height INSTANCES, and that is the distinction the whole
    // section is built on rather than a convenience. `crease.at - hm.sample` is
    // the operator's own departure, and it obeys exactly the three things the
    // construction guarantees: it only raises, it saturates at the cap, and it
    // is continuous. `heightAt(crease=on) - heightAt(crease=off)` obeys none of
    // them exactly, and correctly so -- the detail term's amplitude is
    // slope-dependent and the coarse slope now comes off the creased surface, so
    // the micro stack legitimately moves DOWN by a few centimetres on ground the
    // operator raised. An assertion of non-negativity through the composed field
    // would fail, and it would be the assertion that was wrong.
    //
    // ITS UNITS ARE NOT METRES and it is not comparable to `crag`, `ridge` or
    // `shatter` at equal numbers, so there is no matched-amplitude A/B here the
    // way there is between those three. The knob is an exaggeration of a corner
    // the geometry already implies: 1 restores it and nothing more, 3 overdraws
    // it 3x, and the metres that come out are the terrain's own curvature.
    {
      const creaseKnob = knobOf('crease')
      const ON = creaseKnob.on
      console.log(
        `        crease constants: cell ${CREASE_CELL} m, reach ${CREASE_REACH} m, cap ${CREASE_CAP} m, sill ${CREASE_SILL} m, ` +
          `aniso ${CREASE_ANISO}, floor ${CREASE_FLOOR}, jitter ${CREASE_JITTER} rad -- knob ${creaseKnob.min}..${creaseKnob.max}, on at ${ON}, DIMENSIONLESS`
      )

      // --- off is off, and a sibling with the knob on cannot change that -----
      //
      // The operator hangs off the Heightmap rather than off its callers,
      // because sample() is the one choke point the mesher, the collision, the
      // scatter and the raycast all already go through. What that buys is shared
      // state: one import is read by several V2Height instances at once -- this
      // file builds a dozen of them, and the editor holds one beside the live
      // world -- so attaching the operator to the import ITSELF lets the last
      // field constructed decide what all the others are standing on. That is
      // not a hypothetical. It was the first version of this knob, and under it
      // three fields built in a row came out identical because all three were
      // creased, and a sibling's calibrateRough was fitted to a surface its own
      // knob had switched off. Heightmap.view() is the fix: same texel buffer,
      // own operator.
      //
      // THE CONTROL IS READ BEFORE THE CREASED FIELD EXISTS, and that ordering
      // is the only one that can see the failure. Read afterwards, a
      // contaminated control moves with the very thing it is controlling for and
      // the check passes on broken code -- which is exactly what the first
      // version of this test did.
      const CN = 3000
      const beforeH = new Float64Array(CN)
      for (let i = 0; i < CN; i++) { const p = measureSite(i); beforeH[i] = field.heightAt(p.x, p.z) }
      const creaseOn = mk({ crease: ON })
      let drifted = 0
      let worstDrift = 0
      for (let i = 0; i < CN; i++) {
        const p = measureSite(i)
        const a = field.heightAt(p.x, p.z)
        if (a !== beforeH[i]) { drifted++; worstDrift = Math.max(worstDrift, Math.abs(a - beforeH[i])) }
      }
      check(
        drifted === 0,
        `building a field with crease=${ON} over the same import leaves the plain field bit-identical`,
        `${drifted}/${CN} sites moved under a sibling, worst ${worstDrift} m`
      )
      check(
        hm._crease === null && creaseOn.ground !== hm && creaseOn.ground.field === hm.field,
        'because the operator attaches to a VIEW of the import -- same texels, own operator, nothing copied and nothing mutated',
        `import carries no operator; the creased field's ground is a distinct Heightmap over the same ${hm.width}x${hm.height} buffer`
      )

      // --- the corner is really in the imported texels ------------------------
      //
      // THE MEASUREMENT THAT JUSTIFIES THE OPERATOR EXISTING AT ALL, which is
      // why it is in the gate rather than in a scratch file. Every other knob in
      // this table invents relief and has only to be judged on whether it looks
      // like rock. This one claims to RECOVER something the interpolant threw
      // away, and that claim is either true of the imported data or it is not.
      //
      // For every texel that is a strict local maximum along an axis, take the
      // 7-texel cross-section and fit two models with a free apex:
      //
      //     TENT   y = A - sL*|x - x0|      kinked apex
      //     DOME   y = A - cL*(x - x0)^2    smooth apex
      //
      // FOUR PARAMETERS EACH, same points, same apex search, so the residual
      // comparison is fair and neither model can win on flexibility. Run on the
      // RAW TEXELS and never through sample(), because sample() IS the
      // Catmull-Rom whose behaviour is the thing in question -- ask the question
      // through it and the answer is a dome by construction.
      //
      // AND BOTH CONTROLS STAY, because without them the instrument is
      // unfalsifiable: a fitter that preferred tents for everything would give
      // the same headline. The same field blurred 3x3 is known-smooth and must
      // come out doming; a synthetic field of pure tents is known-kinked and
      // must come out strongly creased. The import has to land between them and
      // on the kinked side of the blur.
      {
        const solve3 = (M, b) => {
          const A = [[M[0][0], M[0][1], M[0][2], b[0]], [M[1][0], M[1][1], M[1][2], b[1]], [M[2][0], M[2][1], M[2][2], b[2]]]
          for (let c = 0; c < 3; c++) {
            let piv = c
            for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r
            if (Math.abs(A[piv][c]) < 1e-12) return null
            const t = A[c]; A[c] = A[piv]; A[piv] = t
            for (let r = 0; r < 3; r++) {
              if (r === c) continue
              const f = A[r][c] / A[c][c]
              for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k]
            }
          }
          return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]]
        }
        // y = A - pL*|d|^power (left) - pR*d^power (right), with the apex x0
        // searched on a grid across the middle texel. The two sides get their
        // own slope so an asymmetric crest -- which is what a real arete is --
        // is not scored as a bad fit by either model.
        const fitApex = (xs, ys, power) => {
          let best = null
          for (let t = 0; t <= 40; t++) {
            const x0 = -0.5 + t / 40
            const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
            const rhs = [0, 0, 0]
            for (let k = 0; k < xs.length; k++) {
              const d = xs[k] - x0
              const b = [1, -(d < 0 ? Math.pow(-d, power) : 0), -(d > 0 ? Math.pow(d, power) : 0)]
              for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) M[i][j] += b[i] * b[j]
                rhs[i] += b[i] * ys[k]
              }
            }
            const p = solve3(M, rhs)
            if (!p) continue
            let ss = 0
            for (let k = 0; k < xs.length; k++) {
              const d = xs[k] - x0
              const r = p[0] - p[1] * (d < 0 ? Math.pow(-d, power) : 0) - p[2] * (d > 0 ? Math.pow(d, power) : 0) - ys[k]
              ss += r * r
            }
            const rms = Math.sqrt(ss / xs.length)
            if (!best || rms < best.rms) best = { rms, A: p[0], sL: p[1], sR: p[2] }
          }
          return best
        }
        const XS = [-3, -2, -1, 0, 1, 2, 3]
        const survey = (data, w, h) => {
          const wins = []
          const ratios = []
          const clips = []
          const relief = []
          for (let axis = 0; axis < 2; axis++) {
            for (let j = 4; j < h - 4; j += 3) {
              for (let i = 4; i < w - 4; i += 3) {
                const at = (k) => (axis === 0 ? data[j * w + i + k] : data[(j + k) * w + i])
                const c = at(0)
                if (!(at(-1) < c && c > at(1))) continue
                const ys = XS.map(at)
                // A 2 m bump at 8 m texels is the import's own quantisation, not
                // a landform, and there are tens of thousands of them.
                const span = c - Math.min(...ys)
                if (span < 2) continue
                const tent = fitApex(XS, ys, 1)
                const dome = fitApex(XS, ys, 2)
                if (!tent || !dome) continue
                // Both flanks must actually fall away, or it is a shoulder
                // rather than a crest and neither model is being asked anything.
                if (!(tent.sL > 0 && tent.sR > 0)) continue
                wins.push(tent.rms < dome.rms ? 1 : 0)
                ratios.push(tent.rms / (dome.rms + 1e-9))
                // How far above the interpolated texel the tent's own apex sits:
                // the corner Catmull-Rom cannot draw, in metres, measured.
                clips.push(tent.A - c)
                relief.push(span)
              }
            }
          }
          const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]
          const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
          const pick = (a, idx) => idx.map((k) => a[k])
          const band = (lo, hi) => {
            const idx = []
            for (let k = 0; k < relief.length; k++) if (relief[k] >= lo && relief[k] < hi) idx.push(k)
            return idx.length < 40 ? null : { n: idx.length, tent: 100 * mean(pick(wins, idx)), ratio: med(pick(ratios, idx)), clip: med(pick(clips, idx)) }
          }
          return { n: wins.length, tent: 100 * mean(wins), ratio: med(ratios), clip: med(clips), relief: med(relief), band }
        }

        const w = hm.width
        const h = hm.height
        const blurred = new Float32Array(w * h)
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            let s = 0
            let acc = 0
            for (let b = -1; b <= 1; b++) {
              for (let a = -1; a <= 1; a++) {
                const x = i + a
                const y = j + b
                if (x < 0 || y < 0 || x >= w || y >= h) continue
                const k = (a === 0 ? 2 : 1) * (b === 0 ? 2 : 1)
                s += k * hm.field[y * w + x]
                acc += k
              }
            }
            blurred[j * w + i] = s / acc
          }
        }
        // Two interfering triangle waves at an angle to the texel grid, so the
        // crests are genuine tents but do not run along rows or columns and
        // cannot be found by the axis scan for free.
        const tents = new Float32Array(w * h)
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            const u = ((i * 0.37 + j * 0.21) % 11) - 5.5
            const v = ((i * 0.11 - j * 0.43 + 1000) % 13) - 6.5
            tents[j * w + i] = 40 - 6 * Math.abs(u) - 4 * Math.abs(v)
          }
        }

        const imp = survey(hm.field, w, h)
        const blur = survey(blurred, w, h)
        const syn = survey(tents, w, h)
        const line = (label, s) =>
          console.log(
            `        ${label.padEnd(26)} tent beats dome at ${s.tent.toFixed(1).padStart(5)}% of ${s.n.toLocaleString().padStart(6)} crests,  ` +
              `residual ratio ${s.ratio.toFixed(3)} (below 1 = kinked),  apex clipped by ${s.clip.toFixed(2)} m over ${s.relief.toFixed(1)} m of relief`
          )
        console.log(`        tent vs dome on the RAW texels, 7-texel cross-sections, 4 parameters each with a free apex:`)
        line('the shipped import', imp)
        line('CONTROL 3x3 blurred', blur)
        line('CONTROL synthetic tents', syn)
        // STRATIFIED BY LANDFORM, because the question is not whether 5 m
        // hummocks are kinked -- nobody looks at those -- but whether the aretes
        // are. This is the row crease.js's header quotes: on the biggest
        // landforms the import stays kinked while the blurred control goes
        // sharply the other way, so the gap WIDENS exactly where the operator
        // is aimed.
        for (const [lo, hi] of [[2, 8], [8, 20], [20, 50], [50, 1e9]]) {
          const a = imp.band(lo, hi)
          const b = blur.band(lo, hi)
          if (!a || !b) continue
          console.log(
            `          relief ${String(lo).padStart(2)}-${hi > 1e8 ? '  +' : String(hi).padStart(3)} m:  import n=${String(a.n).padStart(5)} tent ${a.tent.toFixed(1)}% ratio ${a.ratio.toFixed(3)} clipped ${a.clip.toFixed(2)} m   ` +
              `|  blurred n=${String(b.n).padStart(5)} tent ${b.tent.toFixed(1)}% ratio ${b.ratio.toFixed(3)}`
          )
        }
        check(
          imp.tent > blur.tent + 10 && imp.ratio < blur.ratio * 0.9,
          'the imported texels prefer a KINKED crest, and by a wide margin over the same field blurred -- the corner is in the data',
          `import ${imp.tent.toFixed(1)}% / ratio ${imp.ratio.toFixed(3)} against the blur's ${blur.tent.toFixed(1)}% / ${blur.ratio.toFixed(3)}`
        )
        // AND THE INSTRUMENT LANDS BOTH CONTROLS ON THEIR KNOWN SIDES. Without
        // these two lines the check above is a fitter's bias reported as a
        // finding: a tent fits any noisy 7 points better than a parabola does,
        // and nothing so far would tell the difference.
        check(
          blur.ratio > 0.9 && blur.tent < 60,
          'and a known-SMOOTH field comes out doming under the same fit -- the tent does not simply win everywhere',
          `3x3 blurred: ${blur.tent.toFixed(1)}% of crests, ratio ${blur.ratio.toFixed(3)}`
        )
        check(
          syn.ratio < 0.2 && syn.tent > 90,
          'and a known-KINKED field comes out emphatically creased -- the fit can see a corner when there is one',
          `synthetic tents: ${syn.tent.toFixed(1)}% of crests, ratio ${syn.ratio.toFixed(3)}`
        )
      }

      // --- the operator only ever raises, and it saturates at the cap --------
      //
      // ONLY EVER RAISES is a real invariant of the construction and not a
      // statistic: the tooth is the two straight faces extended until they meet
      // ABOVE the rounded cap, so the corner is grafted ON TOP of the bicubic
      // and the departure is 0.5 * k * d^2 with k > 0. A sign error anywhere in
      // the axis, the curvature or the graft turns teeth into notches, and a
      // notch on a crest reads as erosion rather than as a bug. Asserted as
      // `>= 0` at every site, exactly, because there is no tolerance in which
      // this is allowed to be nearly true.
      //
      // SATURATES because k is the terrain's own curvature and an unbounded k is
      // an unbounded spike -- Catmull-Rom's overshoot beside a cliff produced
      // 114 m ones before the cap. The bound is analytic: the tooth is at most
      // 0.5 * kmax * reach^2 = CREASE_CAP, times the cell's draw (at most 1) and
      // the lift, so no departure may exceed CREASE_CAP * lift at any lift.
      //
      // AND IT IS EXACTLY LINEAR IN THE LIFT, which is what makes the knob an
      // exaggeration rather than a redesign of the field at every tick: `lift`
      // enters once, as one multiply on the cell weight, and every branch above
      // it is taken on quantities that do not contain it. So a HUD scrub is an
      // amplitude, and the value at 3 is the value at 1 tripled to the last bit
      // the arithmetic keeps.
      const probe = new CreaseField(hm, WORLD_SEED)
      const DN = 20000
      {
        const rows = []
        for (const lift of [1, 2, ON]) {
          probe.lift = lift
          let s2 = 0
          let mn = Infinity
          let mx = -Infinity
          let zero = 0
          for (let i = 0; i < DN; i++) {
            const p = measureSite(i)
            const d = probe.at(p.x, p.z) - hm.sample(p.x, p.z)
            s2 += d * d
            if (d < mn) mn = d
            if (d > mx) mx = d
            if (d === 0) zero++
          }
          rows.push({ lift, rms: Math.sqrt(s2 / DN), mn, mx, zero: zero / DN })
        }
        console.log(
          `        departure from the plain bicubic over ${DN.toLocaleString()} sites: ` +
            rows.map((r) => `lift ${r.lift} -> rms ${r.rms.toFixed(4)} m, max +${r.mx.toFixed(2)} m, min ${r.mn.toFixed(4)} m`).join(',  ')
        )
        const on = rows[rows.length - 1]
        check(
          rows.every((r) => r.mn >= 0),
          'the crease only ever RAISES the surface -- the corner is grafted on top of the cap, never cut into it',
          `min departure ${rows.map((r) => `${r.mn.toFixed(4)}`).join(' / ')} m at lift ${rows.map((r) => r.lift).join(' / ')}`
        )
        check(
          rows.every((r) => r.mx <= CREASE_CAP * r.lift),
          `no tooth exceeds CREASE_CAP times the lift -- k saturates, so an overshooting bicubic cannot make a spike`,
          `max +${on.mx.toFixed(2)} m at lift ${on.lift} against the ${(CREASE_CAP * on.lift).toFixed(0)} m bound (${(CREASE_CAP * on.lift / on.mx).toFixed(1)}x of headroom)`
        )
        // The other half of "it only touches crests", and the one a person can
        // check by eye: most of the world is left EXACTLY alone. There is no
        // crest detector anywhere in the operator -- the amplitude is the
        // terrain's own curvature and the sill is what keeps it off broad
        // ground -- so this fraction is a measurement of that gate and not of a
        // threshold somebody chose.
        check(
          on.zero > 0.3 && on.mx > 1,
          'and it is silent over most of the world, EXACTLY 0 rather than small -- teeth where there is a crest, nothing where there is not',
          `${pct(on.zero)} of sites untouched, and the rest reaches +${on.mx.toFixed(2)} m, so that is not silence by inaction`
        )

        probe.lift = 1
        const unit = new Float64Array(3000)
        for (let i = 0; i < 3000; i++) { const p = measureSite(i); unit[i] = probe.at(p.x, p.z) - hm.sample(p.x, p.z) }
        probe.lift = ON
        let worstLin = 0
        for (let i = 0; i < 3000; i++) {
          const p = measureSite(i)
          worstLin = Math.max(worstLin, Math.abs(probe.at(p.x, p.z) - hm.sample(p.x, p.z) - ON * unit[i]))
        }
        // NOT bit-exact, and the reason is the one the `bare` and `ridge` blocks
        // record: the departure is recovered by subtracting two sums that each
        // carry a few hundred metres of macro, which costs about 1e-13 m. The
        // arithmetic inside the operator is one multiply.
        check(
          worstLin < 1e-9,
          `crease=${ON} is exactly ${ON}x crease=1 -- the lift is one multiply on the cell weight, so a scrub is an amplitude`,
          `worst departure from ${ON}x ${worstLin.toExponential(2)} m against a ${rows[rows.length - 1].rms.toFixed(4)} m rms term`
        )
      }

      // --- the departure field is continuous ---------------------------------
      //
      // THE LOAD-BEARING PROBE IN THIS SECTION, and the one that has already
      // earned its place: it caught a 26 m TEAR across one millimetre, at every
      // probe step, when the curvature was read off Catmull-Rom. Catmull-Rom is
      // C1 and not C2 -- its second derivative jumps at every knot -- and a
      // tooth is k/2 * reach^2 tall, so a discontinuous k is a discontinuous
      // SURFACE. The uniform cubic B-spline over the same 4x4 block is C2 and
      // that is why it is there. Nothing else in this file would have noticed:
      // the term would still only raise, still be capped, still be linear in the
      // lift, and still land on crests.
      //
      // MEASURED ON THE DEPARTURE AND NOT ON THE FINISHED SURFACE, which is the
      // only way to make the number mean anything. The plain bicubic already has
      // an 87.8 degree face on this import and it is not crease's doing; walk
      // the composed field and the worst step you find is the import's, with the
      // operator contributing nothing to it. Subtracting the bicubic leaves the
      // operator's own contribution alone.
      //
      // A 1 cm step is two orders of magnitude below the 13 m reach, so no tooth
      // can hide between two samples: a break of any size shows up here as a
      // slope no face has.
      {
        probe.lift = ON
        const dep = (x, z) => probe.at(x, z) - hm.sample(x, z)
        // Seeded where the operator is actually doing something, or 200 m of
        // untouched valley floor would report a worst step of exactly zero and
        // pass by measuring nothing.
        const SEAM_T = 64
        const SEAM_STEP = 0.01
        const SEAM_N = 20000
        const hot = []
        for (let i = 0; hot.length < SEAM_T && i < 900000; i++) {
          const p = measureSite(i)
          if (dep(p.x, p.z) > 1) hot.push({ i, p })
        }
        const steps = []
        let worstJump = 0
        let liveTerm = 0
        for (const { i, p } of hot) {
          const a = measureAngle(i)
          const dx = Math.cos(a)
          const dz = Math.sin(a)
          let prev = dep(p.x, p.z)
          for (let k = 1; k < SEAM_N; k++) {
            const v = dep(p.x + dx * k * SEAM_STEP, p.z + dz * k * SEAM_STEP)
            const jump = Math.abs(v - prev)
            steps.push(jump)
            if (jump > worstJump) worstJump = jump
            if (v > liveTerm) liveTerm = v
            prev = v
          }
        }
        steps.sort((a, b) => a - b)
        const q = (t) => steps[Math.floor(t * (steps.length - 1))]
        console.log(
          `        ${hot.length} transects of ${(SEAM_N * SEAM_STEP).toFixed(0)} m across live teeth, walked at ${(SEAM_STEP * 100).toFixed(0)} cm: ` +
            `p99 step ${q(0.99).toFixed(4)} m, p99.9 ${q(0.999).toFixed(4)} m, worst ${worstJump.toFixed(4)} m (a slope of ${(worstJump / SEAM_STEP).toFixed(1)}), over a term reaching ${liveTerm.toFixed(1)} m`
        )
        check(
          worstJump < 1,
          'the crease departure is continuous -- the corner is a break in the SLOPE and nowhere a break in the surface',
          `worst ${worstJump.toFixed(4)} m over ${SEAM_STEP * 100} cm against a 1 m limit, and against the 26 m tear this probe caught off a C1 basis`
        )
        check(
          q(0.99) < 0.05,
          'and the typical step is centimetres, so the worst one is a steep face and not a population of them',
          `p99 ${q(0.99).toFixed(4)} m over ${steps.length.toLocaleString()} steps`
        )
        check(
          liveTerm > 1,
          'and the transects ran over real teeth, so that is not continuity by inaction',
          `the departure reaches ${liveTerm.toFixed(1)} m along them`
        )
      }

      // --- the 3x3 Voronoi neighbourhood really is the whole neighbourhood ---
      //
      // VERIFIED AGAINST A 5x5 REFERENCE RATHER THAN ARGUED, because the same
      // assertion on `shatter` was once wrong BY A FACTOR OF SQRT(2): a
      // Chebyshev level set is a square and its corners stand at sqrt(2) times
      // its inradius, so a reach that read as 0.83 cells was really 1.18 and the
      // 3x3 evaluator was clipping flanks. The argument here is a different one
      // -- jitter is confined to the middle half of each cell, so a far site
      // cannot get closer than 1.25 cells while the home site is never further
      // than 1.06 -- and it is a better argument, but "better argument" is what
      // the shatter bound had too.
      //
      // ALL THREE RETURNED VALUES, not just the nearest distance. `h` is the
      // permutation byte the cell's amplitude and rotation are drawn from, so a
      // d1 that agreed while h did not would still flip the tooth's height and
      // lean between two adjacent samples -- a tear, from a search that looked
      // correct on distances alone.
      {
        const VN = 200000
        let bad1 = 0
        let bad2 = 0
        let badH = 0
        for (let i = 0; i < VN; i++) {
          const p = site(i * 7 + 3)
          const near = probe._site(p.x, p.z, 1)
          const wide = probe._site(p.x, p.z, 2)
          if (near.d1 !== wide.d1) bad1++
          if (near.d2 !== wide.d2) bad2++
          if (near.h !== wide.h) badH++
        }
        check(
          bad1 === 0 && bad2 === 0 && badH === 0,
          `a 3x3 cell search returns the same site as a 5x5 one, at every point -- the ${CREASE_CELL} m lattice cannot reach past its neighbours`,
          `${VN.toLocaleString()} points: ${bad1} disagreements on d1, ${bad2} on d2, ${badH} on the drawn byte`
        )
      }

      // --- what it costs the route network -----------------------------------
      //
      // Through the same instrument as the walkability table below -- same 3000
      // sites, same stride out of src/player.js -- and this knob gets a
      // THRESHOLD where the others deliberately do not. The difference is that
      // `crag` at 30 making the world harder to cross is a taste, whereas crease
      // sealing a pass would mean the operator is acting on valley floors, and
      // "it only touches crests" is the claim the whole design rests on. It only
      // ever raises, so it can only ever steepen; if the gate on curvature were
      // leaking onto flat ground this is where it would show.
      {
        const src = await readFile(PLAYER_PATH, 'utf8')
        const maxTan = Math.tan((Number(/maxSlopeDeg:\s*([0-9.]+)/.exec(src)[1]) * Math.PI) / 180)
        const stride = Number(/stride:\s*([0-9.]+)/.exec(src)[1])
        const offWalk = walkableFraction((x, z) => field.heightAt(x, z), maxTan, stride)
        const onWalk = walkableFraction((x, z) => creaseOn.heightAt(x, z), maxTan, stride)
        // Hoisted out of the callback deliberately: walkableFraction evaluates it
        // 6000 times, and building the field inside the arrow rebuilt and
        // recalibrated it at every one of them -- 380 s of the gate.
        const cragF = mk({ crag: knobOf('crag').on })
        const cragWalk = walkableFraction((x, z) => cragF.heightAt(x, z), maxTan, stride)
        console.log(
          `        walkable over a ${stride} m stride: all off ${pct(offWalk)}, crease=${ON} ${pct(onWalk)} ` +
            `(${((onWalk - offWalk) * 100).toFixed(1)} points), against crag=${knobOf('crag').on}'s ${((cragWalk - offWalk) * 100).toFixed(1)}`
        )
        check(
          offWalk - onWalk < 0.01 && onWalk < offWalk,
          'crease costs the route network under a point, an order of magnitude less than the ungated bands -- it is on the crests, not in the passes',
          `${((offWalk - onWalk) * 100).toFixed(1)} points against crag's ${((offWalk - cragWalk) * 100).toFixed(1)}`
        )
      }

      // --- what it costs per sample ------------------------------------------
      //
      // Reported and not asserted, on the same footing as the empty-document
      // timing above: it is a number worth having on the record, and a threshold
      // on it would be a threshold on this machine. Every consumer of the coarse
      // field pays it -- the mesher, the collision, the scatter, the raycast --
      // because sample() is where the operator lives, which is the same property
      // that makes the knob reach all of them from one line.
      {
        const timed = (f) => {
          for (let i = 0; i < 20000; i++) { const p = site(i); f(p.x, p.z) }
          const t0 = performance.now()
          for (let i = 0; i < 200000; i++) { const p = site(i); f(p.x, p.z) }
          return ((performance.now() - t0) / 200000) * 1e3
        }
        const tPlain = timed((x, z) => hm.sample(x, z))
        const tCrease = timed((x, z) => probe.at(x, z))
        console.log(`        cost per coarse sample: plain bicubic ${tPlain.toFixed(3)} us, creased ${tCrease.toFixed(3)} us (${(tCrease / tPlain).toFixed(1)}x)`)
      }
    }

    // EROSION CONSERVES MASS AND RESPECTS THE DEAD BAND.
    //
    // thermalErode is the one term here that rewrites the field the world is
    // built on rather than adding to it, so it gets asserted directly rather
    // than through V2Height. Both properties are the ones that make it sharpen
    // ground instead of smoothing it: mass conservation is why the faces come out
    // PLANAR (material leaves the summit and arrives at the foot, it does not
    // evaporate), and the dead band is why ground already at rest is left exactly
    // alone instead of being low-passed a little more with every pass.
    //
    // The synthetics are 64x64 at the import's own texel size, so the dynamics
    // scale with whatever image is loaded and the pass counts below do not.
    {
      const eKnob = knobOf('erode')
      const tKnob = knobOf('talus')
      const talus = tKnob.off
      const n = 64
      const tan = Math.tan((talus * Math.PI) / 180)

      // DEAD BAND. A ramp at half the repose angle, run for the knob's own `on`
      // pass count: every texel must come back with the same bits. Not "within a
      // tolerance" -- the operator's `if (d > 0)` is what makes this an exact
      // statement, and a version that leaked a fraction of the drop everywhere
      // would still pass a tolerance and would round the whole world off over
      // twenty passes.
      const gentle = new Float32Array(n * n)
      const gTan = Math.tan(((talus / 2) * Math.PI) / 180)
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) gentle[j * n + i] = i * texel * gTan
      const gOut = thermalErode(gentle, n, n, texel, { passes: eKnob.on, talusDeg: talus })
      let gMoved = 0
      for (let i = 0; i < gentle.length; i++) if (gOut[i] !== gentle[i]) gMoved++
      check(gMoved === 0, `ground at half the repose angle is bit-identical after ${eKnob.on} passes`, `${gMoved} of ${gentle.length} texels moved`)
      check(gOut !== gentle, 'and the result is a copy -- the import has to survive, or the knob is not reversible', 'thermalErode returns a new Float32Array')

      // A ramp ONE DEGREE under repose, which is the check that says the dead
      // band's edge is at the repose angle and not somewhere convenient.
      const near = new Float32Array(n * n)
      const nTan = Math.tan((((talus - 1) * Math.PI) / 180))
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) near[j * n + i] = i * texel * nTan
      const nOut = thermalErode(near, n, n, texel, { passes: eKnob.on, talusDeg: talus })
      let nMoved = 0
      for (let i = 0; i < near.length; i++) if (nOut[i] !== near[i]) nMoved++
      check(nMoved === 0, 'and so is ground one degree under it -- the dead band edge is the repose angle itself', `${nMoved} of ${near.length} texels moved`)

      // RELAXATION. A vertical step tall enough that a talus slope at the repose
      // angle needs a quarter of the field to run out, so the relaxation has
      // somewhere to go and the answer is not the border clamp.
      const rise = tan * texel * (n / 4)
      const step = new Float32Array(n * n)
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) step[j * n + i] = i < n / 2 ? 0 : rise
      const worstDeg = (a) => {
        let t = 0
        for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 2; i++) t = Math.max(t, Math.abs(a[j * n + i + 1] - a[j * n + i]) / texel)
        return (Math.atan(t) * 180) / Math.PI
      }
      const LADDER = [1, 25, 100, 800]
      const rows = LADDER.map((passes) => ({ passes, out: thermalErode(step, n, n, texel, { passes, talusDeg: talus }) }))
      console.log(
        `        a ${rise.toFixed(0)} m vertical step at ${texel.toFixed(2)} m texels, relaxing toward ${talus} deg: ` +
          rows.map((r) => `${r.passes}p -> ${worstDeg(r.out).toFixed(2)} deg`).join(',  ')
      )
      let monotone = true
      for (let i = 1; i < rows.length; i++) if (!(worstDeg(rows[i].out) < worstDeg(rows[i - 1].out))) monotone = false
      const finalDeg = worstDeg(rows[rows.length - 1].out)
      check(monotone, 'a vertical step relaxes monotonically -- no overshoot, so no checkerboard', `${worstDeg(step).toFixed(1)} deg -> ${finalDeg.toFixed(2)} deg over ${LADDER[LADDER.length - 1]} passes`)
      // Approached from ABOVE and never crossed: the operator's `move` is a
      // fraction of the WORST excess, halved again between giver and receivers,
      // which is a stability bound. A version that overshot would dip under the
      // angle and oscillate, and the visible symptom is a checkerboard rather
      // than anything that reads as wrong.
      check(finalDeg > talus && finalDeg < talus + 0.25, 'and converges on the repose angle from above rather than through it', `${finalDeg.toFixed(3)} deg vs ${talus} deg`)

      // MASS. On the real import, at the knob's own settings, because the
      // synthetic cannot show what a million texels of accumulated Float32
      // rounding does. Erosion is a scatter into a delta buffer and back, so the
      // drift is bounded by the arithmetic and not by the number of passes; a
      // leak here would lower or raise the whole world silently and the altitude
      // ramp would follow it without complaint.
      const t1 = performance.now()
      const eroded = thermalErode(hm.field, hm.width, hm.height, texel, { passes: eKnob.on, talusDeg: talus })
      const erodeMs = performance.now() - t1
      let before = 0
      let after = 0
      let touched = 0
      for (let i = 0; i < eroded.length; i++) {
        before += hm.field[i]
        after += eroded[i]
        if (eroded[i] !== hm.field[i]) touched++
      }
      const drift = (after - before) / before
      console.log(
        `        full field, ${eKnob.on} passes at ${talus} deg: ${erodeMs.toFixed(0)} ms over ${hm.width}x${hm.height}, ` +
          `${pct(touched / eroded.length)} of texels moved, mass drift ${drift.toExponential(2)}`
      )
      check(Math.abs(drift) < 1e-5, 'thermal erosion conserves mass to floating-point drift', `${drift.toExponential(2)} relative over ${eroded.length} texels`)
      // Conservation is trivially true of a pass that did nothing, and how much
      // ground is over the repose angle in the first place is a property of the
      // import and of wherever the talus default currently sits -- at 42 deg
      // this touches a fifth of the world and at 55 deg under a tenth of it. So
      // the bar is "some real fraction of the world", not a number fitted to
      // today's default.
      check(touched / eroded.length > 0.01, 'and it really did move the world, so that is not conservation by inaction', `${pct(touched / eroded.length)} of texels changed`)
    }

    // THE SCULPT PATH, WHICH IS THE ONLY PLACE THE ERODED COPY IS UPDATED
    // INCREMENTALLY -- and the one place it went badly wrong.
    //
    // `thermalErode` with a rect returns a copy of the IMPORT with that rect
    // relaxed, so everything outside the rect comes back UN-eroded. Assigning the
    // return value straight to `field.ground` therefore threw the whole eroded
    // world away on the first tick of the first stroke: 8.8% of the world's
    // texels moved by up to 148 m, nearly all of them nowhere near the brush.
    // Nothing throws when that happens; the range just snaps back to the import
    // the instant the brush is pressed, and the player then collides with a
    // surface that is no longer being drawn.
    //
    // The assertion is not "it changed less this time" -- it is EXACTNESS against
    // a full-field re-erode of the same patched import, over a whole eight-stamp
    // drag, because an incremental scheme that is merely close accumulates.
    {
      const eKnob = knobOf('erode')
      const talus = knobOf('talus').off
      const scratch = Heightmap.fromRaw({ width: hm.width, height: hm.height, data: Float32Array.from(hm.field), meta: hm.meta })
      const f = new V2Height({ heightmap: scratch, layers, seed: WORLD_SEED, relief: { ...RELIEF_DEFAULTS, erode: eKnob.on, talus } })
      const standing = Float32Array.from(f.ground.field)

      let stampMs = 0
      const RECTS = []
      for (let k = 0; k < 8; k++) {
        const x = 1200 + k * 90
        const rect = brushRect(scratch, x, -800, 200)
        stamp(scratch, { x, z: -800, radius: 200, mode: 'raise', amount: 5 })
        RECTS.push(rect)
        const t0 = performance.now()
        f.coarsePatched(rect)
        stampMs += performance.now() - t0
      }

      const truth = thermalErode(scratch.field, scratch.width, scratch.height, scratch.texelSize, { passes: eKnob.on, talusDeg: talus })
      let differ = 0
      let worst = 0
      for (let i = 0; i < truth.length; i++) {
        const d = Math.abs(f.ground.field[i] - truth[i])
        if (d > 0) differ++
        if (d > worst) worst = d
      }
      check(differ === 0, 'an eight-stamp drag leaves the eroded field bit-identical to a full re-erode', `${differ} texels differ, worst ${worst.toExponential(2)} m`)

      // The half of that which is specifically the reverted-world bug: ground far
      // outside every brush rect must not have moved at all. Stated separately
      // because it is the half a future incremental scheme is most likely to
      // break, and "0 texels differ" above would not say WHICH texels.
      const far = (i, j) => RECTS.every((r) => i < r.i0 - 2 * eKnob.on || i >= r.i1 + 2 * eKnob.on || j < r.j0 - 2 * eKnob.on || j >= r.j1 + 2 * eKnob.on)
      let moved = 0
      for (let j = 0; j < scratch.height; j++) {
        for (let i = 0; i < scratch.width; i++) {
          if (!far(i, j)) continue
          if (f.ground.field[j * scratch.width + i] !== standing[j * scratch.width + i]) moved++
        }
      }
      check(moved === 0, 'and ground far from the brush is untouched -- the eroded world is spliced, not rebuilt from the import', `${moved} texels moved out of reach of any stamp`)
      console.log(`        ${(stampMs / 8).toFixed(1)} ms per stamp incrementally, against the full-field figure above`)
    }

    // WALKABILITY, WHICH IS WHAT THESE KNOBS COST.
    //
    // Reported through the same instrument as the "walkable fraction" section
    // above -- same 3000 sites, same stride out of src/player.js -- so the
    // numbers can be read side by side against the detail term's own cost.
    //
    // NO THRESHOLD ON ANY KNOB-ON NUMBER, deliberately. These are opt-in and a
    // person turning `crag` to 30 is entitled to a world that is harder to cross;
    // a gate that failed on that would be asserting a taste. What it must do is
    // SURFACE the cost, because the failure mode §3 records from v1 is nobody
    // noticing that a jaggedness layer had sealed the passes. The all-off number
    // IS asserted, because that one is the shipped world.
    {
      const src = await readFile(PLAYER_PATH, 'utf8')
      const maxTan = Math.tan((Number(/maxSlopeDeg:\s*([0-9.]+)/.exec(src)[1]) * Math.PI) / 180)
      const stride = Number(/stride:\s*([0-9.]+)/.exec(src)[1])
      const offWalk = walkableFraction((x, z) => field.heightAt(x, z), maxTan, stride)
      const rows = []
      // `shatter` earns its own row rather than riding in `everything`: it
      // displaces roughly twice what `ridge` does on peak ground, so it is the
      // knob most likely to seal a pass, and burying it in the all-on figure is
      // exactly the not-noticing this table exists to prevent.
      for (const key of ['sharpen', 'exposure', 'crag', 'ridge', 'shatter', 'crease', 'erode']) {
        const k = knobOf(key)
        const f = mk({ [key]: k.on })
        rows.push({ key, value: k.on, frac: walkableFraction((x, z) => f.heightAt(x, z), maxTan, stride) })
      }
      const cragAniso = mk({ crag: knobOf('crag').on, aniso: knobOf('aniso').on })
      rows.push({ key: 'crag+aniso', value: knobOf('aniso').on, frac: walkableFraction((x, z) => cragAniso.heightAt(x, z), maxTan, stride) })
      const everything = {}
      for (const k of RELIEF_KNOBS) everything[k.key] = k.on
      const all = mk(everything)
      rows.push({ key: 'everything', value: '', frac: walkableFraction((x, z) => all.heightAt(x, z), maxTan, stride) })
      console.log(`        walkable over a ${stride} m stride, all knobs off: ${pct(offWalk)}`)
      for (const r of rows) {
        console.log(`          ${(r.key + (r.value === '' ? '' : `=${r.value}`)).padEnd(14)} ${pct(r.frac)}   (${r.frac < offWalk ? '-' : '+'}${(Math.abs(r.frac - offWalk) * 100).toFixed(1)} points)`)
      }
      const worst = rows.reduce((a, b) => (a.frac < b.frac ? a : b))
      console.log(`        worst knob for the route network: ${worst.key} at ${pct(worst.frac)}, ${((offWalk - worst.frac) * 100).toFixed(1)} points below all-off`)
      check(offWalk > 0.5, 'the shipped world is walkable with the relief off', `${pct(offWalk)} under the slope limit`)
    }

    console.log(`        section runtime ${((performance.now() - t0) / 1000).toFixed(1)} s -- the erosion knob is most of it`)
  }

  if (failures > 0) throw new Error(`check-v2-field: ${failures} check(s) failed`)
  return { failures: 0 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run()
    console.log('\nv2 field: ALL CHECKS PASSED\n')
  } catch (e) {
    console.log(`\nv2 field: ${e.message}\n`)
    process.exit(1)
  }
}
