// Node-side gates for the v2 building kit (src/buildings/v2/*, DESIGN.md §19).
//
//   node scripts/check-buildings-v2.mjs [seeds]
//
// This does NOT re-run the tile gates -- v2 shares every texture layer with v1
// and scripts/check-buildings.mjs already faces them with the seam metric.
// What it does test is everything v2 changed, plus the two invariants v2 is most
// likely to break and least likely to break visibly:
//
//   AIRTIGHTNESS UNDER THE WARP. The claim in warp.js is that a displacement
//   field keyed on position cannot open a seam, because coincident vertices
//   share an input and therefore share an output. That is an argument, not a
//   proof that the code implements it -- one part computing its own jitter
//   instead of taking the field's would pass every visual check and leave a
//   hairline you can see the inside of the building through. So every part and
//   every assembled building is checked warped, at several strengths.
//
//   WINDING UNDER THE WARP. A displacement large against the local feature size
//   CAN turn a face inside out, and an inside-out shell pairs its edges
//   perfectly -- so signed volume is the only thing that catches it. The
//   strengths tested go past 1 deliberately: the previewer's slider does, and
//   the answer to "how far can it go before it breaks" should be measured
//   rather than assumed.
//
// And one gate v1 does not have: WHAT DETAIL 1 COSTS. Detail 1 exists to be
// cheap, v1's came out at about a third of detail 2, and a third is not cheap.
// v2 targets an eighth, measures a sixth, and gates on the mean plus an absolute
// cap -- see LOD1_MEAN below for why the ratio itself is the wrong thing to fail
// a building on. A target nobody measures is a target that drifts back.

import { planBuilding, KINDS } from '../src/buildings/plan.js'
import { buildBuilding2 } from '../src/buildings/v2/building.js'
import {
  Builder, WALL_STYLE, openEdges, signedVolume,
  plinth, gableEnd, leanEnd, doorway, steps2, roughSlab,
  wall2, gableRoof2, leanToRoof2, windowUnit2, chimney2, porch2, member2,
  boxSection,
} from '../src/buildings/v2/parts.js'
import { makeCharacter, makeWarp, warpBuilder } from '../src/buildings/v2/warp.js'
import { LAYER } from '../src/textures.js'

const SEEDS = Number(process.argv[2] ?? 300)

// §5, the `structure` prop class mesh tier, for v2.
//
// v2 spends triangles on the roof -- an nu x nv grid where v1 had one quad, and
// two extra edge-band rings on a thatched eave -- and buys most of them back on
// the chimney (48 -> 12, one flared prism instead of a battered stack plus a
// corbelled cap) and the window surround (a 4-or-5 sided ring where v1 used 5 or
// 6, across as many as fifteen windows on an inn). The number below is what that
// nets out to, measured, with the same margin v1's carried.
//
// A budget to be DEFENDED, not a number to raise whenever a part grows.
const STRUCTURE_BUDGET = 2600
// Detail 1: the macro structure with the bevelling, rounding and 3D joinery
// gone. The design target is an eighth of detail 2. Measured, the mean lands at
// 0.143 -- close to a seventh -- and the gate is set above that rather than at
// the target, for a reason worth writing down.
//
// THE FLOOR IS THE WINDOWS. A detail-1 window is three flat rectangles: frame,
// glass, and a leaf per shutter. Every one of them has to be `double: true` to
// pair its directed edges for the airtightness gate, so a rectangle is 4
// triangles and not 2, and a shuttered window is 16. An inn with twelve
// shuttered windows and three plain ones therefore spends 216 triangles on
// openings alone -- most of an eighth of its 1,672-triangle detail 2, before a
// single wall, roof or plinth is drawn. Dropping to a literal eighth means
// dropping the shutters, and a shutterless inn at 30 m reads as a blank wall.
//
// So the gate is on the MEAN, which is the number that governs what a village
// costs, plus an absolute cap on the worst single building, which is the number
// that governs the worst frame. Per-building ratio is deliberately NOT gated,
// because it measures how many OPENINGS a building has rather than how thrifty
// its far tier is: the worst is an inn at 0.204 whose fifteen windows are most
// of its detail 1, and the next worst is a small cottage at 0.209 for the mirror
// reason -- its detail 2 had little ornament to lose. Neither is a problem, and
// failing either measures the wrong thing.
const LOD1_MEAN = 0.18
const LOD1_BUDGET = 460
// Detail 0 is the village-backdrop tier: a box per mass, a four-triangle roof
// with no overhang, and one flat rectangle for the door and each window. The
// rectangles are the whole point -- at that range the pattern of openings is
// the only thing that reads as a building rather than a crate -- so the cap is
// set above the old no-openings figure of 80 rather than the openings being cut
// to meet it. A hundred of these is 14k triangles, which the backdrop can hold.
const LOD0_BUDGET = 140
// How far past the shipping strength of 1 the warp has to stay sane.
const STRENGTHS = [0, 0.5, 1, 1.6]

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

console.log(`\n=== building v2 checks, ${SEEDS} seeds x ${Object.keys(KINDS).length} kinds ===\n`)

// ---------------------------------------------------------------------------
// 0. Sections
// ---------------------------------------------------------------------------

console.log('sections')

{
  const bad = []
  let count = 0
  for (let seed = 0; seed < 400; seed++) {
    for (const [hu, hv] of [[0.31, 0.31], [0.5, 0.2], [0.08, 0.6]]) {
      const s = boxSection(hu, hv, seed, 0.24)
      count++
      // Anticlockwise: prism()'s side winding and both cap fans depend on it.
      let area = 0
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4
        area += s[i][0] * s[j][1] - s[j][0] * s[i][1]
      }
      if (area <= 0) bad.push(`seed ${seed} area ${area.toExponential(2)}`)
      // Each corner stays in its own quadrant, which is what makes the loop
      // simple without having to test for crossings: a jitter that could flip a
      // sign would let two corners swap sides and tie the section in a knot.
      const Q = [[1, 1], [-1, 1], [-1, -1], [1, -1]]
      for (let i = 0; i < 4; i++) {
        if (Math.sign(s[i][0]) !== Q[i][0] || Math.sign(s[i][1]) !== Q[i][1]) {
          bad.push(`seed ${seed} corner ${i} left its quadrant`)
        }
      }
    }
  }
  check(bad.length === 0, 'every box section is simple and wound anticlockwise',
    bad.length ? `${bad.length} bad, e.g. ${bad[0]}` : `${count.toLocaleString()} sections`)
}

// ---------------------------------------------------------------------------
// 1. Parts, in isolation and under the warp.
// ---------------------------------------------------------------------------

console.log('\nparts')

const NORMALS = [[0, 1], [0, -1], [1, 0], [-1, 0]]
const PARTS = []
for (const [nx, nz] of NORMALS) {
  const at = (a, out) => [-nz * a + nx * out, nx * a + nz * out]
  const dir = nx ? (nx > 0 ? '+x' : '-x') : nz > 0 ? '+z' : '-z'
  PARTS.push(
    [`window ${dir}`, (b, detail, seed, k) => windowUnit2(b, { x: 0, z: 0, y0: 1.2, nx, nz, seed, detail, k }), 'solid'],
    [`window+shutters ${dir}`, (b, detail, seed, k) => windowUnit2(b, { x: 0, z: 0, y0: 1.2, nx, nz, shutters: true, seed, detail, k }), 'solid'],
    [`door ${dir}`, (b, detail, seed) => doorway(b, { x: 0, z: 0, y0: 0, nx, nz, runes: true, seed, detail }), 'solid'],
    [`wall log ${dir}`, (b, detail, seed) => wall2(b, { p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.LOG, seed, rough: seed, detail }), 'solid'],
    [`wall stave ${dir}`, (b, detail, seed) => wall2(b, { p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.STAVE, seed, rough: seed, detail }), 'solid'],
    [`wall halfTimber ${dir}`, (b, detail, seed) => wall2(b, { p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.HALF_TIMBER, seed, rough: seed, detail }), 'solid'],
    [`wall stoneBase ${dir}`, (b, detail, seed) => wall2(b, { p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.STONE_BASE, seed, rough: seed, detail }), 'solid'],
    // A short wall, where the column count clamps to one and the subdivision has
    // to degrade to exactly what v1 drew rather than to a degenerate strip.
    [`wall short ${dir}`, (b, detail, seed) => wall2(b, { p0: at(-0.6, 0), p1: at(0.6, 0), y0: 0, y1: 2.4, style: WALL_STYLE.LOG, seed, rough: seed, detail }), 'solid'],
    [`gableEnd ${dir}`, (b, detail, seed) => gableEnd(b, { p0: at(-2, 0), p1: at(2, 0), y0: 2.4, apexY: 4.2, style: WALL_STYLE.LOG, seed, detail }), 'solid'],
    [`leanEnd ${dir}`, (b) => leanEnd(b, { p0: at(-1.5, 0), p1: at(1.5, 0), y0: 2, y1: 3.1, style: WALL_STYLE.LOG }), 'flat'],
  )
}
for (const axis of ['x', 'z']) {
  PARTS.push(
    [`gableRoof thatch ${axis}`, (b, detail, seed, k) => gableRoof2(b, { cx: 0, cz: 0, w: 5, d: 4, eaveY: 2.4, rise: 1.8, ridgeAxis: axis, layer: LAYER.THATCH, tint: [1, 1, 1], fringe: true, seed, detail, k }), 'sheet'],
    [`gableRoof shingle ${axis}`, (b, detail, seed, k) => gableRoof2(b, { cx: 0, cz: 0, w: 5, d: 4, eaveY: 2.4, rise: 1.8, ridgeAxis: axis, layer: LAYER.SHINGLE, tint: [1, 1, 1], fringe: false, seed, detail, k }), 'sheet'],
    [`gableRoof catslide ${axis}`, (b, detail, seed, k) => gableRoof2(b, { cx: 0, cz: 0, w: 5, d: 4, eaveY: 2.4, rise: 1.8, ridgeAxis: axis, layer: LAYER.SHINGLE, tint: [1, 1, 1], vergeHi: 2.2, seed, detail, k }), 'sheet'],
    // A long inn range and a tiny outshut, so both ends of roofGrid()'s ladder
    // are exercised: nu = 3 and nu = 1, nv = 3 and nv = 1.
    [`gableRoof long ${axis}`, (b, detail, seed, k) => gableRoof2(b, { cx: 0, cz: 0, w: 12, d: 6, eaveY: 2.6, rise: 2.4, ridgeAxis: axis, layer: LAYER.ROOF_TILE, tint: [1, 1, 1], seed, detail, k }), 'sheet'],
    [`gableRoof tiny ${axis}`, (b, detail, seed, k) => gableRoof2(b, { cx: 0, cz: 0, w: 2, d: 1.6, eaveY: 2, rise: 0.7, ridgeAxis: axis, layer: LAYER.SHINGLE, tint: [1, 1, 1], seed, detail, k }), 'sheet'],
  )
}
for (const dir of ['+x', '-x', '+z', '-z']) {
  PARTS.push([`leanToRoof ${dir}`, (b, detail, seed, k) => leanToRoof2(b, { cx: 0, cz: 0, w: 3, d: 2.5, highY: 3.2, lowY: 2.2, dir, layer: LAYER.THATCH, tint: [1, 1, 1], seed, detail, k }), 'sheet'])
}
PARTS.push(
  ['plinth', (b, detail, seed) => plinth(b, { cx: 0, cz: 0, w: 5, d: 4, top: 0.4, bottom: -0.3, batter: detail >= 2 ? 0.06 : 0, bevel: detail >= 2 ? 0.05 : 0, seed }), 'solid'],
  ['chimney', (b, detail, seed, k) => chimney2(b, { x: 0, z: 0, baseY: 3, topY: 5, seed, detail, k }), 'solid'],
  ['porch', (b, detail, seed, k) => porch2(b, { x: 0, z: 2, floorY: 0.4, groundY: -0.3, headY: 2.4, seed, detail, k }), 'solid'],
  ['porch flat', (b, detail, seed, k) => porch2(b, { x: 0, z: 2, floorY: 0.05, groundY: 0, headY: 2.4, seed, detail, k }), 'solid'],
  ['steps', (b, detail, seed) => steps2(b, { x: 0, z: 2, topY: 0.55, groundY: -0.2, seed, detail }), 'solid'],
  ['steps doorstep', (b, detail, seed) => steps2(b, { x: 0, z: 2, topY: 0.16, groundY: 0, seed, detail }), 'solid'],
  ['steps tall flight', (b, detail, seed) => steps2(b, { x: 0, z: 2, topY: 1.5, groundY: -0.1, seed, detail }), 'solid'],
  ['roughSlab thin', (b, detail, seed) => roughSlab(b, [-1, 0, -0.06], [1, 0.04, 0.06], { seed, bevel: 0.05, layer: LAYER.STONE, color: [1, 1, 1] }), 'solid'],
  // A bowed, segmented member on its own: the joints between spans are buried
  // faces inside a union of solids, which is legal, and the gate has to agree.
  ['member2 bowed', (b, detail, seed) => member2(b, [0, 0, 0], [0, 2.4, 0], { hu: 0.09, seed, segments: 2, bow: 0.06, round: 0.4, color: [1, 1, 1] }), 'solid'],
  ['member2 flat span', (b, detail, seed) => member2(b, [-1, 1, 0], [1, 1, 0], { hu: 0.06, seed, segments: 3, bow: 0.03, color: [1, 1, 1] }), 'solid'],
)

// Seeds, because the hewn section draws its SIDE COUNT from the seed: at one
// seed a part is only ever tested as (say) a six-gon, and the winding of a
// prism, the non-crossing of its corners and the mitre of a swept ring are all
// properties of n. Only detail 2 varies -- it is the only tier that rounds
// anything.
const PART_SEEDS = [0, 1, 2, 3, 4, 5, 6, 7]
const partBad = { open: [], vol: [] }
let partCases = 0
for (const [name, draw, kindOf] of PARTS) {
  for (const detail of [2, 1, 0]) {
    for (const seed of detail === 2 ? PART_SEEDS : [0]) {
      for (const strength of detail === 2 ? STRENGTHS : [1]) {
        const k = makeCharacter(seed * 13 + 5, strength)
        const b = new Builder()
        draw(b, detail, seed, k)
        if (b.triangles === 0) continue
        partCases++
        // The part is warped exactly as a building is: field applied to the
        // vertex array before the geometry is made. This is the gate that would
        // catch a part computing its own wander instead of taking the field's.
        warpBuilder(b, makeWarp(k, 0))
        const g = b.toGeometry()
        const tag = `${name} d${detail} s${seed} w${strength}`
        const open = openEdges(g)
        if (open.length) partBad.open.push(`${tag} ${open.length} unpaired`)
        const vol = signedVolume(g)
        // Only detail 2 has to be POSITIVE: the lower tiers drop the solid parts
        // of a window or a door and keep the doubled panel, which is honestly
        // zero. No tier of anything may ever be negative.
        // 'sheet' is the roof: a covering has no thickness at any tier now, so
        // its planes contribute exactly zero and whatever solid trim rides on
        // top of them -- the ridge roll, and only at detail 2 -- contributes a
        // little. What must never happen is NEGATIVE, which is the thing this
        // gate is really for: a plane wound the wrong way round.
        const ok = kindOf === 'flat'
          ? Math.abs(vol) < 1e-5
          : kindOf === 'sheet' ? vol > -1e-5
            : detail === 2 ? vol > 1e-5 : vol > -1e-5
        if (!ok) partBad.vol.push(`${tag} ${vol.toExponential(2)} m3, wanted ${kindOf}`)
        g.dispose()
      }
    }
  }
}
check(partBad.open.length === 0, 'every part is airtight on its own, warped',
  partBad.open.length ? `${partBad.open.length} bad, e.g. ${partBad.open[0]}` : `${PARTS.length} parts, ${partCases} cases`)
check(partBad.vol.length === 0, 'every solid part is wound outwards, every sheet is flat or better',
  partBad.vol.length ? `${partBad.vol.length} bad, e.g. ${partBad.vol[0]}` : `signed volume as declared, strengths ${STRENGTHS.join('/')}`)

// ---------------------------------------------------------------------------
// 2. The geometry.
// ---------------------------------------------------------------------------

console.log('\ngeometry')

const GEO_SEEDS = Math.min(SEEDS, 60)
const ATTRS = ['position', 'normal', 'uvProj', 'texLayer', 'color']
const slopeFor = (s) => (s % 2 === 0 ? null : (x) => -x * 0.14)
let worstTris = 0
let worstId = ''
let sumTris = 0
let geoCount = 0
let worstRatio = 0
let worstRatioId = ''
let sumRatio = 0
let worstLod1 = 0
let worstLod1Id = ''
let worstLod0 = 0
let worstLod0Id = ''
const geoBad = {
  attrs: [], finite: [], budget: [], lod: [], lod1: [], lod0: [], below: [],
  layer: [], open: [], inverted: [], nrm: [],
}

for (const kind of Object.keys(KINDS)) {
  for (let s = 1; s <= GEO_SEEDS; s++) {
    const id = `${kind}/${s}`
    const p = planBuilding({ seed: s, kind, groundAt: slopeFor(s) })
    const tiers = [2, 1, 0].map((detail) => buildBuilding2(p, { detail }))

    for (const [i, t] of tiers.entries()) {
      const g = t.geometry
      const d = 2 - i
      // Every geometry has to agree on the attribute set or the village merge
      // returns null -- a silent disappearance, not an error.
      for (const a of ATTRS) if (!g.getAttribute(a)) geoBad.attrs.push(`${id} d${d} missing ${a}`)
      const pos = g.getAttribute('position').array
      const uv = g.getAttribute('uvProj').array
      const nrm = g.getAttribute('normal').array
      for (let kk = 0; kk < pos.length; kk++) if (!Number.isFinite(pos[kk])) { geoBad.finite.push(`${id} d${d} position`); break }
      for (let kk = 0; kk < uv.length; kk++) if (!Number.isFinite(uv[kk])) { geoBad.finite.push(`${id} d${d} uvProj`); break }

      // computeVertexNormals() after the warp can only produce a zero normal
      // from a degenerate triangle, and a degenerate triangle is a collapsed
      // face -- so this is the cheapest test for "the warp folded something".
      for (let kk = 0; kk < nrm.length; kk += 3) {
        const l = Math.hypot(nrm[kk], nrm[kk + 1], nrm[kk + 2])
        if (!(l > 0.5)) { geoBad.nrm.push(`${id} d${d} |n| ${l.toFixed(3)}`); break }
      }

      // Nothing may hang below the plinth: a part that does is a part standing
      // in mid-air on the downhill side of a slope.
      let minY = Infinity
      for (let kk = 1; kk < pos.length; kk += 3) if (pos[kk] < minY) minY = pos[kk]
      if (minY < p.plinthBottom - 0.5) geoBad.below.push(`${id} d${d} ${minY.toFixed(2)}`)

      // Buildings must only wear building layers -- a stray BARK on a wall is a
      // one-digit typo that renders as a plausible-looking wrong material.
      const lay = g.getAttribute('texLayer').array
      const legal = new Set([
        LAYER.TIMBER_BEAM, LAYER.TIMBER_HEWN, LAYER.TIMBER_PLANK, LAYER.THATCH, LAYER.SHINGLE,
        LAYER.STONE, LAYER.PLASTER, LAYER.THATCH_FRINGE, LAYER.GLASS,
        LAYER.IRON, LAYER.RUNE, LAYER.ROOF_TILE, LAYER.DOOR,
      ])
      for (let kk = 0; kk < lay.length; kk++) if (!legal.has(lay[kk])) { geoBad.layer.push(`${id} d${d} layer ${lay[kk]}`); break }

      // AIRTIGHT: every directed edge a->b matched by a b->a. Deliberately NOT
      // "every edge shared by exactly two triangles" -- the kit is a union of
      // interpenetrating solids, so four triangles may meet at one edge quite
      // legitimately. What no arrangement of solids can do is leave an edge
      // unpaired, so an imbalance is always a face genuinely missing.
      if (signedVolume(g) <= 0) geoBad.inverted.push(`${id} d${d}`)
      const open = openEdges(g)
      if (open.length) geoBad.open.push(`${id} d${d} ${open.length} unpaired, e.g. ${open[0].key}`)
    }

    // LOD by re-generation only works if the tiers actually get cheaper.
    if (!(tiers[0].triangles > tiers[1].triangles && tiers[1].triangles > tiers[2].triangles)) {
      geoBad.lod.push(`${id} ${tiers.map((t) => t.triangles).join(' / ')}`)
    }
    const ratio = tiers[1].triangles / tiers[0].triangles
    if (tiers[1].triangles > LOD1_BUDGET) geoBad.lod1.push(`${id} ${tiers[1].triangles}`)
    if (tiers[1].triangles > worstLod1) { worstLod1 = tiers[1].triangles; worstLod1Id = id }
    if (tiers[2].triangles > LOD0_BUDGET) geoBad.lod0.push(`${id} ${tiers[2].triangles}`)
    if (tiers[2].triangles > worstLod0) { worstLod0 = tiers[2].triangles; worstLod0Id = id }
    if (ratio > worstRatio) { worstRatio = ratio; worstRatioId = id }
    sumRatio += ratio

    if (tiers[0].triangles > STRUCTURE_BUDGET) geoBad.budget.push(`${id} ${tiers[0].triangles}`)
    if (tiers[0].triangles > worstTris) { worstTris = tiers[0].triangles; worstId = id }
    sumTris += tiers[0].triangles
    geoCount++
    for (const t of tiers) t.geometry.dispose()
  }
}

const geoReport = (key, label, extra = '') =>
  check(geoBad[key].length === 0, label, geoBad[key].length ? `${geoBad[key].length} bad, e.g. ${geoBad[key][0]}` : extra)

geoReport('attrs', 'every tier carries the full attribute set', ATTRS.join(', '))
geoReport('finite', 'no non-finite positions or UVs')
geoReport('nrm', 'no degenerate triangles after the warp', 'every recomputed normal is unit length')
geoReport('layer', 'every texLayer names a building layer')
geoReport('below', 'nothing hangs below the plinth')
geoReport('open', 'every warped tier is airtight -- no unpaired edges', `${geoCount * 3} meshes closed`)
geoReport('inverted', 'every assembled tier encloses positive volume')
geoReport('lod', 'detail 2 > detail 1 > detail 0, every seed')
geoReport('lod1', `no detail 1 tier costs more than ${LOD1_BUDGET} tris`,
  `worst ${worstLod1} (${worstLod1Id})`)
geoReport('lod0', `no detail 0 tier costs more than ${LOD0_BUDGET} tris`,
  `worst ${worstLod0} (${worstLod0Id})`)
{
  const mean = sumRatio / geoCount
  check(mean <= LOD1_MEAN, `detail 1 averages at most ${LOD1_MEAN} of detail 2`,
    `mean ${mean.toFixed(3)}, worst ${worstRatio.toFixed(3)} (${worstRatioId})`)
}
geoReport('budget', `every building fits the structure budget (${STRUCTURE_BUDGET} tris)`,
  `worst ${worstTris} (${worstId}), mean ${Math.round(sumTris / geoCount)}`)

// A whole village of the largest kind still has to fit §5's allotment.
const villageTris = worstTris * 20
check(villageTris < 55000, '20 of the worst-case building fit the village allotment',
  `${villageTris.toLocaleString()} tris for 20 visible`)

// ---------------------------------------------------------------------------
// 3. The warp itself.
// ---------------------------------------------------------------------------

console.log('\nwarp')

{
  // Strength 0 must be the identity, not merely close to it. The previewer's
  // slider bottoms out there and the whole claim that v2 is v1 plus a field
  // rests on it: if strength 0 wandered, there would be no control case to
  // compare a crooked building against.
  const k = makeCharacter(7, 0)
  check(makeWarp(k, 0) === null, 'strength 0 builds no warp at all', 'makeWarp returns null')
  check(k.flare === 1, 'strength 0 leaves the chimney unflared', `flare ${k.flare}`)

  // Determinism, which everything downstream assumes: a village is generated
  // once, merged, and never rebuilt, so a building that differs between two
  // calls is a building that differs between the mesh and the collider.
  const p = planBuilding({ seed: 11, kind: 'cottage' })
  const a = buildBuilding2(p, { detail: 2 })
  const bb = buildBuilding2(p, { detail: 2 })
  const pa = a.geometry.getAttribute('position').array
  const pb = bb.geometry.getAttribute('position').array
  let same = pa.length === pb.length
  if (same) for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) { same = false; break }
  check(same, 'the same plan warps to the same vertices every time', `${pa.length / 3} vertices`)
  a.geometry.dispose()
  bb.geometry.dispose()

  // The field has to actually DO something at strength 1, and a measurable
  // amount of it. A warp that quietly resolved to nothing would pass every gate
  // above -- they all test that the building is still valid, not that it moved.
  //
  // The ceiling is derived, not picked. The furthest-moving vertex on any
  // building is a high eave corner, and it collects, worst case: the settle lean,
  // leanX up to 0.021 at h^1.35, which on a 6 m inn ridge is 0.235 an axis and
  // ~0.33 across two; the eave reach, up to 0.23; the eave sway, 0.12; and the
  // two noise octaves, 0.074 an axis and ~0.13 in space. That sums to about
  // 0.95 m, and 0.95 is what the corpus actually measures. 1.2 leaves room for
  // an unlucky seed without leaving room for a building that has stopped reading
  // as settled and started reading as melted.
  //
  // Swept over a sample of the corpus rather than one plan, because the worst
  // case is a TALL building with a LONG eave and any single seed is very unlikely
  // to be it -- the first version of this gate tested one cottage, measured
  // 0.595, and was a hair from passing a bound the inns were already over.
  //
  // MEASURED BY WARPING THE STRAIGHT BUILDING'S OWN VERTICES, not by differencing
  // a strength-0 build against a strength-1 one. Those two no longer have the
  // same vertices to difference: a log wall stops its courses under the roof it
  // actually stands under, so a building whose eave has sagged carries one course
  // fewer than the same building drawn straight, and from there the two arrays
  // are offset from each other and every subsequent comparison is between
  // unrelated vertices. That is correct behaviour and a broken measurement. What
  // this gate is actually about is the SIZE OF THE FIELD, so it applies the field
  // and measures it.
  let maxD = 0
  let maxId = ''
  for (const kind of Object.keys(KINDS)) {
    for (let seed = 0; seed < 40; seed++) {
      const plan = planBuilding({ seed, kind })
      const straight = buildBuilding2(plan, { detail: 2, strength: 0 })
      const f = makeWarp(makeCharacter(plan.seed, 1), plan.plinthBottom)
      const ps = straight.geometry.getAttribute('position').array
      for (let i = 0; i < ps.length; i += 3) {
        const q = f(ps[i], ps[i + 1], ps[i + 2])
        const d = Math.hypot(q[0] - ps[i], q[1] - ps[i + 1], q[2] - ps[i + 2])
        if (d > maxD) { maxD = d; maxId = `${kind}/${seed}` }
      }
      straight.geometry.dispose()
    }
  }
  check(maxD > 0.04 && maxD < 1.2, 'the field at strength 1 moves vertices, and not by much',
    `worst vertex moved ${maxD.toFixed(3)} m (${maxId})`)
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
