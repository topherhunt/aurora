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
//   flashed white in chunk-shaped squares. v2's cells span 6.25 cm to 512 m, a
//   factor of 8192, so it is a worse problem here. Same 400-site methodology as
//   scripts/check-terrain.mjs so the two numbers can be read side by side.

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { KNEE_TEXELS, LAMBDA0, LAMBDA_MIN, measureSite, measureAngle, roughnessOf } from '../src/v2/height/detail.js'
import { V2Height, WORLD_SEED } from '../src/v2/height/field.js'
import { RELIEF_KNOBS, RELIEF_DEFAULTS, reliefIsOff } from '../src/v2/height/relief.js'
import { thermalErode } from '../src/v2/height/erode.js'
import { CRAG_SLOPE_LO } from '../src/v2/height/crag.js'
import { Layers } from '../src/v2/layers/layers.js'
import { snowDefaults } from '../src/v2/layers/doc.js'
import { buildChunkV2, shade, CLASS_EPS, CREST_CELL_LO } from '../src/v2/terrain/chunk-mesh-v2.js'
import { WORLD_SIZE, WORLD_HALF, CHUNK_RES, CHUNK_VERTS, CHUNK_INDICES, MAX_DEPTH } from '../src/v2/config.js'

const PNG_PATH = new URL('../public/world/height.png', import.meta.url)
const JSON_PATH = new URL('../public/world/height.json', import.meta.url)
const PLAYER_PATH = new URL('../src/player.js', import.meta.url)
const MESH_PATH = new URL('../src/v2/terrain/chunk-mesh-v2.js', import.meta.url)

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
  console.log(
    `        exaggeration ${cal.exaggeration}x: spectral continuity alone wants ${cal.continuous.toFixed(5)}, the stretch is divided back out`
  )
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

  // THE STRETCH DOES NOT REACH THE GRAVEL. The bake exaggerates the import's
  // metres for drama (make-heightmap.mjs, NATURAL_MAX_Y) and the roughness the
  // calibration measures scales with it exactly, so without the divide in
  // calibrateRough a taller world is also a rockier one at 6 cm cells. The first
  // check would pass vacuously on an unstretched import, so the second one
  // asserts this world is actually stretched.
  check(
    Math.abs(cal.continuous / cal.rough - cal.exaggeration) < 1e-9,
    "the bake's exaggeration is divided back out of the detail amplitude",
    `${cal.continuous.toFixed(5)} / ${cal.rough.toFixed(5)} = ${(cal.continuous / cal.rough).toFixed(4)}x, meta says ${cal.exaggeration}x`
  )
  check(
    hm.exaggeration > 1,
    'and the shipped import really is stretched, so that check is not vacuous',
    `height.json exaggeration ${hm.exaggeration}x -- ${(hm.max - hm.min).toFixed(0)} m of relief standing in for ${((hm.max - hm.min) / hm.exaggeration).toFixed(0)} m of terrain`
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
  // shrinks, and vanish at the leaf. This is what says the LOD ladder is a
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
    // At the leaf every octave down to LAMBDA_MIN is at least 4x the cell, so the
    // weights are all exactly 1 and the two evaluations are the same arithmetic.
    check(rms[0] === 0, 'the leaf cell IS the exact field, bit for bit', `${leafCell.toFixed(4)} m cell, residual ${rms[0]}`)
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
    // across it. The crossing is the whole test.
    //
    // Each river node takes its y FROM THE TERRAIN, which is both what an author
    // dragging control points would produce and what this test needs to stay
    // honest. A river authored at one constant y -- which is what stood here
    // first -- is fine on gentle ground and meaningless on real relief: carveRivers
    // deliberately leaves ground that is already below the bed alone (min, not
    // lerp, so a channel cannot fill a gorge it crosses), so on the imported map,
    // where the ground falls 4.2 m over the 200 m to the probe, the flat channel
    // was simply not cutting there and the check was asserting against a carve
    // that had correctly declined to happen. The guard below now says so out loud.
    // Nodes every 200 m rather than every 400 m, for the same reason: with the
    // wider spacing the Catmull-Rom chord cut across a dip and the river's own
    // surface floated 2 m above the ground at the probe, so the channel had only
    // 1.9 m of relief left to cut and "reaches its authored depth" was measuring
    // the spline's sag rather than the carve. The probe below sits ON a node.
    const river = [-400, -200, 0, 200, 400].map((z) => [0, z === 0 ? y : hm.sample(0, z), z, 12])
    doc.addPath({ kind: 'river', depth: 4, pts: river })
    doc.addPath({ kind: 'road', feather: 10, pts: [[-400, y, 0, 6], [0, y, 0, 6], [400, y, 0, 6]] })
    const lakeY = hm.sample(1000, 1000)
    doc.addLake({ x: 1000, z: 1000, y: lakeY, rx: 150, rz: 120, carve: 1, depth: 9 })
    const cf = new V2Height({ heightmap: hm, layers: doc, seed: WORLD_SEED })

    // ROADS LAST. At the crossing the road's carriageway wins, so the answer is
    // the road's own y and not the river bed 4 m below it. Run the road first and
    // this reads bed height: a ford where the author drew a causeway.
    const atCrossing = cf.heightAt(0, 0)
    check(Math.abs(atCrossing - y) < 0.02, 'a road crossing a river reads as a causeway, not a ford', `crossing ${atCrossing.toFixed(3)} m vs road surface ${y.toFixed(3)} m, bed would be ${(y - 4).toFixed(3)} m`)

    // And the river is really carving where the road is not: 200 m up the channel.
    // The spline's own y comes back out of waterLevelAt -- the surface IS the
    // spline y and the bed is depth below it -- so the expectation is read from
    // the document rather than recomputed here from an assumption about how
    // Catmull-Rom interpolated the nodes.
    const inChannel = cf.heightAt(0, 200)
    const splineY = doc.waterLevelAt(0, 200)
    const bedY = splineY - 4
    const ground = hm.sample(0, 200)
    check(ground > bedY + 1, 'the probe sits on ground the channel has to cut through', `ground ${ground.toFixed(3)} m stands ${(ground - bedY).toFixed(3)} m above the bed`)
    check(inChannel < ground - 3.9, 'the river carve reaches its authored depth', `bed ${inChannel.toFixed(3)} m, ${(ground - inChannel).toFixed(3)} m below the untouched ground, spline y ${splineY.toFixed(3)} m, depth 4 m`)
    check(Math.abs(inChannel - bedY) < 0.01, 'the channel bottom sits exactly depth below the spline', `${inChannel.toFixed(3)} m vs ${bedY.toFixed(3)} m`)

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
    const r = buildChunkV2(field, layers, { ox: 512, oz: -1024, size, res: CHUNK_RES })
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
    try { buildChunkV2(field, layers, { ox: 0, oz: 0, size, res: CHUNK_RES + 1 }) } catch { threw = true }
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
      kids.push(buildChunkV2(field, layers, { ox: ox + (q & 1) * half, oz: oz + (q >> 1) * half, size: half, res: CHUNK_RES }))
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
      const c = buildChunkV2(field, layers, { ox: x - half * step, oz: z - half * step, size: step * CHUNK_RES, res: CHUNK_RES })
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
      const DEPTHS = [MAX_DEPTH, 10, 7, 4, 2]
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
        shade(field.heightAt(s.x, s.z, cell), useMeshNormal ? nyAt(s.x, s.z, cell) : nyAt(s.x, s.z, CLASS_EPS), field.snowLineAt(s.x, s.z), layers.snow.band, 0, bands.altLo, bands.altSpan, out, 0)
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

  // --- 13. mesher throughput ------------------------------------------------
  console.log('\nmesher throughput')
  {
    const authored = new Layers()
    const y = hm.sample(0, 0)
    authored.addPath({ kind: 'river', depth: 3, pts: [[-2000, y, -2000, 10], [0, y, 0, 10], [2000, y, 2000, 10]] })
    authored.addPath({ kind: 'road', feather: 12, pts: [[-2000, y, 1000, 5], [2000, y, -1000, 5]] })
    authored.addLake({ x: 300, z: 300, y, rx: 400, rz: 300, carve: 1, depth: 8 })
    const af = new V2Height({ heightmap: hm, layers: authored, seed: WORLD_SEED })
    af.bands

    const bench = (f, lyr, label) => {
      const size = WORLD_SIZE / (1 << 9)
      const specs = []
      for (let n = 0; n < 64; n++) specs.push({ ox: -1024 + (n % 8) * size, oz: -1024 + Math.floor(n / 8) * size, size, res: CHUNK_RES })
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

  // --- 14. the relief knobs -------------------------------------------------
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
      let mismatch = 0
      let worst = 0
      for (let i = 0; i < 400; i++) {
        const p = site(i)
        const a = field.heightAt(p.x, p.z)
        const b = explicit.heightAt(p.x, p.z)
        if (a !== b) { mismatch++; worst = Math.max(worst, Math.abs(a - b)) }
      }
      check(reliefIsOff(RELIEF_DEFAULTS), 'RELIEF_DEFAULTS is the off state, by its own predicate', `${RELIEF_KNOBS.length} knobs`)
      check(mismatch === 0, 'no relief argument and RELIEF_DEFAULTS are the same field, bit for bit', `${mismatch}/400 sites differ, worst ${worst} m`)
      check(explicit.calibration.rough === cal.rough, 'and the same calibration, bit for bit', `ROUGH ${cal.rough}`)
      // The copy is what erosion costs; with the knob off there must not be one.
      // A 4 MB duplicate of the import, resident on three threads, bought by a
      // default that changes nothing.
      check(field.ground === field.heightmap, 'with relief off the world is built on the import itself, not a copy', 'no eroded duplicate is allocated')
      check(explicit.ground === explicit.heightmap, 'and the same through the explicit all-off relief')
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
    //   mesher    crest. See the banner: asserted as a non-effect on the field.
    const PROBE = { sharpen: 'height', exposure: 'height', crag: 'height', aniso: 'height', erode: 'height', talus: 'height', snowJag: 'snowline', crest: 'mesher' }
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
        // `talus` is the one knob whose `on` IS its `off` -- it is a repose
        // angle, not an amount, and 42 deg is both the default and what the HUD
        // toggle restores. Its min is the ablation, and it is a value from the
        // table rather than a number invented here.
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
          check(
            /relief\.crest/.test(meshSrc),
            `${knob.key} is consumed by src/v2/terrain/chunk-mesh-v2.js`,
            /relief\.crest/.test(meshSrc) ? 'reads field.relief.crest' : 'NO reader -- the knob is wired to nothing and this gate cannot see it move'
          )
          // And the one condition that keeps a mesher term out of a collision
          // question. Section 4's leaf identity survives the crest bias only
          // because the finest cell sits at or below the low end of the crest
          // ramp, where smoothstep is exactly 0 and a leaf chunk is still raw
          // heightAtCell. Lower CREST_CELL_LO under CLASS_EPS and crest starts
          // biasing the LOD the player collides against, silently.
          check(
            CREST_CELL_LO >= CLASS_EPS,
            `the crest ramp starts at or above the finest cell, so leaf chunks are never crest-biased`,
            `CREST_CELL_LO ${CREST_CELL_LO} m vs CLASS_EPS ${CLASS_EPS} m`
          )
          continue
        }
        check(
          frac > 0.25 && rms > floor,
          `${knob.key}=${value} moves ${what}, against ${against}`,
          `${pct(frac)} of sites, rms ${rms.toFixed(4)} m (floor ${floor.toFixed(4)} m)`
        )
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
      check(Math.abs(rSharp / rOff - 1) < 0.05, 'sharpen redistributes roughness rather than adding it', `${((rSharp / rOff - 1) * 100).toFixed(2)}% at the probe lag`)
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
      // Held constant to five digits, because this IS the quantity calibrateRough
      // solves for. Worth asserting anyway: it is the plumbing, not the maths --
      // the exposureGain closure reaching the calibration at all is a thing the
      // field has to remember to pass.
      check(
        Math.abs(detailRough(sharpOn) / dOff - 1) < 0.01 && Math.abs(detailRough(expoOn) / dOff - 1) < 0.01,
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
      for (const key of ['sharpen', 'exposure', 'crag', 'erode']) {
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
