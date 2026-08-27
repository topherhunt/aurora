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
//   THE ROOF PLANE. A roof is a zero-thickness sheet and everything under it is
//   cut to fit; a wall that stops 20 cm short of it is airtight, positively wound
//   and inside budget, and is a slot of daylight under the eave. So section 2
//   measures parts against the covering's DRAWN TRIANGLES, in both directions.
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
  wall2, gableRoof2, leanToRoof2, planGableRoof, drawRoof, windowUnit2, chimney2, porch2, member2,
  boxSection,
} from '../src/buildings/v2/parts.js'
import { makeCharacter, makeWarp, warpBuilder } from '../src/buildings/v2/warp.js'
import { probeBuilding, selfCheck as probeSelfCheck, CORPUS_SEEDS, KIND_NAMES } from './probe-building-gaps.mjs'
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
//
// IT MOVED ONCE, from 2600 to 2700, and this is the defence. Dormers are a new
// PART, not an old one that swelled: a five-sided stub swept into the slope with
// its own covering laid over it, 24 triangles, plus a shutterless window at 36.
// Sixty apiece, and a building draws at most two whatever its dice say -- so the
// ceiling this raises is bounded at 120 and cannot creep. The worst building in
// the corpus measures 2624 with both of them on it; everything else has room
// already. The constraint this number is a proxy for is the village allotment at
// the bottom of §4, which is 2,750 a building, and that still passes with 126 to
// spare.
const STRUCTURE_BUDGET = 2700
// Detail 1: the macro structure with the bevelling, rounding and 3D joinery
// gone. The design target is an eighth of detail 2. Measured, the mean lands at
// 0.136 -- close to a seventh -- and the gate is set above that rather than at
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
// its far tier is: the worst is a small cottage at 0.242, whose detail 2 had
// little ornament to lose, and the ones behind it are inns whose fifteen windows
// are most of their detail 1. Neither is a problem, and
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
    [`wall masonry ${dir}`, (b, detail, seed) => wall2(b, { p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.MASONRY, seed, rough: seed, detail }), 'solid'],
    // A wall with a door cut into it. Two of them: the door on the wall's own
    // line, which cuts every course it crosses in half, and a door on the wall
    // AROUND THE CORNER, which cuts nothing but the interlock. Both leave log
    // ends that the closure test has to see capped.
    [`wall log doorway ${dir}`, (b, detail, seed) => wall2(b, {
      p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.LOG, seed, rough: seed, detail,
      openings: [{ x: at(0.3, 0)[0], z: at(0.3, 0)[1], nx, nz, hw: 0.5, y0: 0, y1: 2.1, solid: true }],
    }), 'solid'],
    [`wall log corner door ${dir}`, (b, detail, seed) => wall2(b, {
      p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.LOG, seed, rough: seed, detail,
      openings: [{
        x: at(2, 0.55)[0], z: at(2, 0.55)[1], nx: -nz, nz: nx, hw: 0.5, y0: 0, y1: 2.1, solid: true,
      }],
    }), 'solid'],
    [`wall halfTimber window ${dir}`, (b, detail, seed) => wall2(b, {
      p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.HALF_TIMBER, seed, rough: seed, detail,
      openings: [{ x: at(0, 0)[0], z: at(0, 0)[1], nx, nz, hw: 0.6, y0: 1.1, y1: 2 }],
    }), 'solid'],
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
        // 'sheet' is the roof: a covering has no thickness at any tier, so its
        // planes contribute exactly zero and the fringe hanging off the eave
        // contributes a little. What must never happen is NEGATIVE, which is the
        // thing this gate is really for: a plane wound the wrong way round.
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
// 2. Nothing stands through the covering, and nothing stops short of it.
// ---------------------------------------------------------------------------
//
// A roof is a zero-thickness sheet and everything under it is cut to fit: wall
// tops, corner and king posts, and a window that would otherwise wear the roof
// through its head. Each is a separate piece of arithmetic against the same
// surface and each fails the same two ways -- long, which is a timber coming out
// through the thatch, or short, which is a slot of daylight under the eave.
//
// Neither shows up in any other gate here. A wall that stops 20 cm low is still
// airtight (its own back face closes it), still positively wound, still inside
// budget. So it is measured directly, and from the DRAWN TRIANGLES rather than
// from heightAt(): asking the surface the geometry was built from would only
// prove it agrees with itself, and both things that broke this -- a smooth
// answer for a folded surface, and a chord laid across a fold -- are invisible
// from there.
//
// The scene is deliberately ONE roof and ONE part. On a whole building the
// question is ill-posed: an ell's wing wall stands well above the main range's
// overhang where it passes under it, quite legitimately, and no rule stated in
// world space tells that apart from a wall through a roof.
//
// Character strength is 1 throughout, because a roof at strength 0 is a flat
// plane with nothing to align to. What varies is whether the displacement field
// is applied. Unwarped, the arithmetic is exact and the tolerances are tight --
// this is the run that would catch a dropped fold. Warped, only the overshoot is
// asked about: the field moves a wall's top vertex and the three corners of the
// roof triangle above it, metres away, by different amounts, so the covering
// lands a centimetre or two off the plane its own corners promised. That
// residual is what the 2.5 cm tuck in wall2() is sized against and is not
// something any part can do arithmetic about.

console.log('\nthe roof plane')

const COVER_LAYERS = new Set([LAYER.THATCH, LAYER.SHINGLE, LAYER.ROOF_TILE, LAYER.THATCH_FRINGE])
// Masonry is exempt because a chimney is SUPPOSED to come out through the roof.
// Nothing else is.
const UNDER_LAYERS = new Set([
  LAYER.TIMBER_BEAM, LAYER.TIMBER_PLANK, LAYER.TIMBER_HEWN, LAYER.PLASTER, LAYER.GLASS,
])

/** Where a vertical line through (x, z) meets the triangle abc, or null. */
const triAt = (a, b, c, x, z) => {
  const den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
  if (Math.abs(den) < 1e-12) return null
  const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / den
  const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / den
  const w = 1 - u - v
  if (u < -1e-6 || v < -1e-6 || w < -1e-6) return null
  return u * a[1] + v * b[1] + w * c[1]
}

/** Split a scene into the covering's triangles and everything under it. */
function partition(g) {
  const pos = g.getAttribute('position').array
  const lay = g.getAttribute('texLayer').array
  // Indexed, so the triangles are the index buffer's triples, NOT consecutive
  // runs of the position array. Reading it the other way silently answers about
  // triangles nobody draws.
  const idx = g.getIndex().array
  const at = (v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]
  const cover = []
  const under = []
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [at(idx[t]), at(idx[t + 1]), at(idx[t + 2])]
    if (COVER_LAYERS.has(lay[idx[t]])) cover.push(tri)
    else if (UNDER_LAYERS.has(lay[idx[t]])) under.push(tri)
  }
  return { cover, under }
}

/** The highest covering above (x, z), or null where there is none. */
const roofOver = (cover, x, z) => {
  let top = null
  for (const c of cover) {
    const y = triAt(c[0], c[1], c[2], x, z)
    if (y !== null && (top === null || y > top)) top = y
  }
  return top
}

/**
 * The wall's drawn top edge, as an ordered polyline.
 *
 * A wall face is the only thing in these scenes drawn `double: true`, so its
 * triangles are the ones that appear twice with opposite winding -- that is how
 * the face is told apart from the posts and courses standing in front of it
 * without the gate having to be told which style it asked for. Vertices that
 * share a plan position are the two ends of a column boundary; the higher is on
 * the top edge. Unwarped only: warped, a column's foot and head no longer share
 * a plan position and this stops being able to tell them apart.
 */
function topEdge(under, p0, p1) {
  const seen = new Map()
  const key = (t) => t.map((v) => v.map((n) => n.toFixed(4)).join()).sort().join('|')
  for (const t of under) seen.set(key(t), (seen.get(key(t)) ?? 0) + 1)
  const node = new Map()
  for (const t of under) {
    if (seen.get(key(t)) < 2) continue
    for (const v of t) {
      const k = `${v[0].toFixed(3)},${v[2].toFixed(3)}`
      if (!node.has(k) || v[1] > node.get(k)[1]) node.set(k, v)
    }
  }
  const dx = p1[0] - p0[0]
  const dz = p1[1] - p0[1]
  const len2 = dx * dx + dz * dz
  return [...node.values()]
    .map((v) => ({ v, u: ((v[0] - p0[0]) * dx + (v[2] - p0[1]) * dz) / len2 }))
    .sort((a, c) => a.u - c.u)
    .map((e) => e.v)
}

{
  // How far anything may stand through the covering, and how far short the wall's
  // top edge may fall of it. `short` includes the 1.2 cm tuck by construction --
  // the wall is deliberately built that far under -- so the slack over it is what
  // the chord between two folds is allowed to sag.
  const THROUGH = { warp: 0.05, flat: 0.005 }
  const SHORT = 0.055

  const ROOF = {
    cx: 0, cz: 0, w: 6.4, d: 4.8, eaveY: 2.5, rise: 1.7,
    ridgeAxis: 'x', overhang: 0.45, verge: 0.35,
    layer: LAYER.SHINGLE, tint: [1, 1, 1], fringe: false, detail: 2,
  }
  // Both orientations, because an eaves wall crosses the roof's cell boundaries
  // along its length while a gable end walks up one slope, over the ridge and
  // down the other, and they fail differently.
  const WALLS = [
    ['eaves front', [-3.2, 2.4], [3.2, 2.4], [0, 1]],
    ['eaves back', [3.2, -2.4], [-3.2, -2.4], [0, -1]],
    ['gable end +x', [3.2, 2.4], [3.2, -2.4], [1, 0]],
    ['gable end -x', [-3.2, -2.4], [-3.2, 2.4], [-1, 0]],
  ]

  const CASES = []
  for (const [name, p0, p1, [nx, nz]] of WALLS) {
    for (const style of Object.keys(WALL_STYLE)) {
      CASES.push({
        name: `${name} ${style}`, p0, p1, wall: true,
        add: (b, R, k) => wall2(b, {
          p0, p1, y0: 0, y1: 2.5, style: WALL_STYLE[style], seed: 3, rough: 11,
          detail: 2, topAt: R.heightAt, topBreaks: R.breaksAlong, topCols: 0, k,
        }),
      })
    }
    // Windows placed where a plan would happily put them: one under the eave and
    // three up where the covering is falling away over the sill.
    const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2]
    for (const y0 of [1.4, 2.1, 2.8, 3.3]) {
      CASES.push({
        name: `${name} window y${y0}`, p0, p1, wall: false,
        add: (b, R, k) => windowUnit2(b, {
          x: mid[0], z: mid[1], y0, nx, nz, shutters: true, seed: 5, detail: 2,
          k, topAt: R.heightAt,
        }),
      })
    }
    // And a corner post on its own, which is what ducks furthest under a slope.
    CASES.push({
      name: `${name} post`, p0, p1, wall: false,
      add: (b, R, k) => wall2(b, {
        p0, p1, y0: 0, y1: 2.5, style: WALL_STYLE.STAVE, seed: 3, rough: 11,
        detail: 2, topAt: R.heightAt, topBreaks: R.breaksAlong, topCols: 0, k,
      }),
    })
  }

  const bad = []
  const worst = { warp: [-Infinity, ''], flat: [-Infinity, ''], short: [-Infinity, ''] }
  let cases = 0
  for (const c of CASES) {
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const k = makeCharacter(seed * 29 + 7, 1)
      for (const warped of [false, true]) {
        const b = new Builder()
        const R = planGableRoof({ ...ROOF, seed: seed * 7 + 3, k })
        c.add(b, R, k)
        drawRoof(b, R)
        if (warped) warpBuilder(b, makeWarp(k, 0))
        const g = b.toGeometry()
        const { cover, under } = partition(g)
        g.dispose()
        cases++
        const tag = `${c.name} s${seed}${warped ? ' warped' : ''}`

        let over = -Infinity
        for (const t of under) {
          for (const v of t) {
            const top = roofOver(cover, v[0], v[2])
            if (top !== null) over = Math.max(over, v[1] - top)
          }
        }
        const lim = warped ? THROUGH.warp : THROUGH.flat
        if (over > lim) bad.push(`${tag}: ${over.toFixed(3)} m through`)
        const w = worst[warped ? 'warp' : 'flat']
        if (over > w[0]) { w[0] = over; w[1] = tag }

        if (warped || !c.wall) continue
        // The top edge, sampled between its nodes as well as at them: a chord
        // laid across a fold is exactly what the fold-aligned columns exist to
        // prevent and it is invisible at the nodes themselves.
        const edge = topEdge(under, c.p0, c.p1)
        let short = -Infinity
        for (let i = 0; i + 1 < edge.length; i++) {
          for (let n = 0; n <= 16; n++) {
            const f = n / 16
            const x = edge[i][0] + (edge[i + 1][0] - edge[i][0]) * f
            const y = edge[i][1] + (edge[i + 1][1] - edge[i][1]) * f
            const z = edge[i][2] + (edge[i + 1][2] - edge[i][2]) * f
            const top = roofOver(cover, x, z)
            if (top !== null) short = Math.max(short, top - y)
          }
        }
        if (short > SHORT) bad.push(`${tag}: ${short.toFixed(3)} m short`)
        if (short > worst.short[0]) { worst.short[0] = short; worst.short[1] = tag }
      }
    }
  }
  const say = (w) => `${w[0].toFixed(3)} m (${w[1]})`
  check(bad.filter((s) => s.endsWith('through')).length === 0,
    'nothing but masonry stands through the covering',
    bad.some((s) => s.endsWith('through')) ? `e.g. ${bad.find((s) => s.endsWith('through'))}`
      : `worst ${say(worst.flat)} flat, ${say(worst.warp)} warped, ${cases} scenes`)
  check(bad.filter((s) => s.endsWith('short')).length === 0,
    'and the wall top follows it the whole way along',
    bad.some((s) => s.endsWith('short')) ? `e.g. ${bad.find((s) => s.endsWith('short'))}`
      : `worst ${say(worst.short)}, tuck 0.012 included`)
}

// ---------------------------------------------------------------------------
// 3. The doorway, and what the wall does about it.
// ---------------------------------------------------------------------------
//
// A doorway is the one place in the kit where three separately-correct pieces
// have to agree about the same volume of air. The wall wants to run its courses
// and its studs from corner to corner. The surround wants to stand 2 m tall
// wherever the plan put it. The roof wants to come down to whatever height the
// eave falls to. Each is right on its own and any two of them together can be
// wrong, in ways that only show from a standpoint nobody checks from: logs lying
// across the opening, seen from inside; a stud framed down the middle of a
// window; a lintel out through the thatch.
//
// So the door is measured on WHOLE BUILDINGS, unlike section 2. It can be: the
// question here is not "how high is the roof over this point", which an ell
// makes ill-posed, but "is anything inside this box", and the box is 30 cm wide
// and belongs to exactly one wall of one mass.

console.log('\nthe doorway')

// Shared with section 4, which walks the same corpus: a subset of the seeds the
// cheap checks run over, half of them on a slope.
const GEO_SEEDS = Math.min(SEEDS, 60)
const slopeFor = (s) => (s % 2 === 0 ? null : (x) => -x * 0.14)
// What counts as through. Flat is arithmetic and is held to millimetres; warped
// carries the same allowance section 2 gives everything else, because the field
// moves the lintel and the roof triangle over it by different amounts.
const DOOR_THROUGH = { 0: 0.005, 1: 0.05 }
// And what counts as across it, measured from the door leaf outward. Unwarped a
// log course is cut clear of the opening and there is nothing there at all; the
// warped allowance is for the field moving a log and the jamb it was cut to sit
// behind by different amounts, which no amount of cutting can pre-empt.
const CLEAR = { 0: -0.02, 1: 0.02 }

const TIMBERS = new Set([LAYER.TIMBER_BEAM, LAYER.TIMBER_PLANK, LAYER.TIMBER_HEWN])
const doorBad = { clear: [], through: [] }
let doorWorst = { clear: [-9, ''], through: [-9, ''] }
let doorN = 0
let doorClamped = 0

for (const strength of [0, 1]) {
  for (const kind of Object.keys(KINDS)) {
    for (let s = 1; s <= GEO_SEEDS; s++) {
      const plan = planBuilding({ seed: s, kind, groundAt: slopeFor(s) })
      const g = buildBuilding2(plan, { detail: 2, strength }).geometry
      const pos = g.getAttribute('position').array
      const lay = g.getAttribute('texLayer').array
      const idx = g.getIndex().array
      const at = (v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]
      const d = plan.door
      const tag = `${kind}/${s}${strength ? ' warped' : ''}`
      // The door's own frame. `a` runs across the opening, `o` out of the wall.
      const aOf = (p) => (p[0] - d.x) * d.nz - (p[2] - d.z) * d.nx
      const rawO = (p) => (p[0] - d.x) * d.nx + (p[2] - d.z) * d.nz

      // AND `o` IS MEASURED FROM THE WALL WHERE THE FIELD LEFT IT, not from the
      // plane the door was planned in. The wall is not plumb: it leans as it
      // settles and it is battered off square when it is raised, so by the time
      // it reaches the head of a doorway its face can stand 7 cm outside the
      // plane through the sill. Against a fixed plane every timber in the wall
      // drifts into the door's slot as it rises, and the check reads a leaning
      // wall as an obstruction and a lintel as if it were a metre lower than it
      // is. So the reference is the field's own answer for the door plane at
      // this point's height, and what is left is the standoff that was built.
      //
      // The field is asked at the point's WARPED height rather than at the
      // height it was drawn at, which is out by however far the field lifted it
      // -- a couple of centimetres, against a term that varies by a few
      // millimetres over that. Inverting the field to do better would be
      // measuring the measurement.
      const wall = strength
        ? makeWarp(makeCharacter(plan.seed, strength), plan.plinthBottom, plan.footprint)
        : null
      const oOf = (p) => {
        if (!wall) return rawO(p)
        const a = aOf(p)
        const q = wall(d.x + d.nz * a, p[1], d.z - d.nx * a)
        return rawO(p) - ((q[0] - d.x) * d.nx + (q[2] - d.z) * d.nz)
      }

      // 3a. NOTHING IN THE DOORWAY. The clear volume is inset from the opening
      // on every side, because the point is not that a jamb touches the reveal --
      // it is supposed to -- but that nothing lies ACROSS it. The band in `o`
      // runs from just outside the wall plane to just inside the leaf, which is
      // exactly the slot a log course standing 5 cm proud occupies.
      const cover = []
      let top = -9
      let tx = 0
      let tz = 0
      for (let t = 0; t < idx.length; t += 3) {
        const tri = [at(idx[t]), at(idx[t + 1]), at(idx[t + 2])]
        const layer = lay[idx[t]]
        if (COVER_LAYERS.has(layer)) { cover.push(tri); continue }
        if (layer === LAYER.DOOR || TIMBERS.has(layer)) {
          // The surround: everything of the door's own that stands in its
          // footprint. BOUNDED IN HEIGHT as well as in plan, because the
          // footprint is a column that runs to the sky and other things stand in
          // it -- a dormer's window frame sits a couple of metres above the door
          // and half a metre back, and the warp is enough to swing it into the
          // band. The drawn surround never reaches past the head of the planned
          // opening plus its own frame; anything above that belongs to something
          // else and answers to its own gate.
          if (tri.every((p) => Math.abs(aOf(p)) < d.width / 2 + 0.18
            && oOf(p) > -0.09 && oOf(p) < 0.19
            && p[1] < d.y0 + d.height + 0.45)) {
            for (const p of tri) if (p[1] > top) { top = p[1]; tx = p[0]; tz = p[2] }
          }
        }
        if (!TIMBERS.has(layer)) continue
        for (const p of tri) {
          if (Math.abs(aOf(p)) > d.width / 2 - 0.03) continue
          if (p[1] < d.y0 + 0.06 || p[1] > d.y0 + 1.3) continue
          // The leaf hangs at 8 cm. Anything in front of it is across the door.
          const o = oOf(p) - 0.08
          if (o > CLEAR[strength] && oOf(p) < 0.14) {
            doorBad.clear.push(`${tag}: timber ${o.toFixed(3)} m past the leaf`)
          }
          if (o > doorWorst.clear[0] && oOf(p) < 0.14) doorWorst.clear = [o, tag]
        }
      }
      if (top < -8) continue
      doorN++
      if (top < d.y0 + d.height + 0.14) doorClamped++

      // 3b. AND THE HEAD STAYS UNDER THE COVERING. Measured at the highest point
      // of the surround, against whatever covering is over that point -- on an
      // ell that may be the wing's roof rather than the range's, which is why the
      // HIGHEST answer wins rather than the mass's own.
      let roof = null
      for (const tri of cover) {
        const y = triAt(tri[0], tri[1], tri[2], tx, tz)
        if (y !== null && (roof === null || y > roof)) roof = y
      }
      if (roof === null) continue
      const through = top - roof
      if (through > DOOR_THROUGH[strength]) {
        doorBad.through.push(`${tag}: ${through.toFixed(3)} m through`)
      }
      if (through > doorWorst.through[0]) doorWorst.through = [through, tag]
    }
  }
}

check(doorBad.clear.length === 0, 'nothing lies across a doorway',
  doorBad.clear.length ? `${doorBad.clear.length} bad, e.g. ${doorBad.clear[0]}`
    : `worst ${doorWorst.clear[0].toFixed(3)} m past the leaf (${doorWorst.clear[1]}), ${doorN} doors`)
check(doorBad.through.length === 0, 'and the surround stays under the covering',
  doorBad.through.length ? `${doorBad.through.length} bad, e.g. ${doorBad.through[0]}`
    : `worst ${doorWorst.through[0].toFixed(3)} m (${doorWorst.through[1]}), ${doorClamped} doors shortened to fit`)

// 3c. AND THE STUDS REACH THE FLOOR AND DODGE THE OPENINGS. A stud is a
// two-ring sweep, so it has vertices at its two ends and nowhere else: its
// bottom ring is the only thing in a half-timber wall that sits AT y0 and off
// the wall plane, since the plaster face is a plane at z = 0 and the two rails
// only ever put a vertex at the wall's own ends. So counting exactly that -- y0,
// off-plane, away from the corners -- counts stud feet, and it reads zero the
// moment a stud goes back to starting on top of the bottom rail. That is a
// failure the eye cannot be trusted with: from straight on, a stud founded on a
// rail looks founded on the ground.
{
  const feet = (openings) => {
    const b = new Builder()
    wall2(b, {
      p0: [-3, 0], p1: [3, 0], y0: 0.4, y1: 2.6, style: WALL_STYLE.HALF_TIMBER,
      seed: 3, rough: 11, detail: 2, openings,
    })
    const pos = b.toGeometry().getAttribute('position').array
    const xs = []
    for (let i = 0; i < pos.length; i += 3) {
      // 1e-5, not 0: the buffer is float32 and 0.4 is not one of the numbers it has.
      if (Math.abs(pos[i + 1] - 0.4) > 1e-5) continue
      if (Math.abs(pos[i + 2]) < 0.02 || Math.abs(pos[i]) > 2.9) continue
      xs.push(pos[i])
    }
    // One ring is five to seven vertices spread over the stud's own width, so
    // they are clustered back into studs before being counted.
    xs.sort((a, c) => a - c)
    const studs = []
    for (const x of xs) if (!studs.length || x - studs[studs.length - 1] > 0.3) studs.push(x)
    return studs
  }
  const bare = feet([])
  const withDoor = feet([{ x: 0, z: 0, nx: 0, nz: 1, hw: 0.55, y0: 0.4, y1: 2.4, solid: true }])
  // 4 bays over 6 m: three studs, plus the one at the start corner that the
  // |x| > 2.9 filter drops along with the rails' end rings.
  check(bare.length === 3, 'every stud is founded on the wall base, not on its rail',
    `${bare.length} studs, all of them standing on y0`)
  // The stud that was standing in the doorway has to be somewhere ELSE, not
  // gone: deleting it was the old answer and it left the frame visibly gappy
  // while the window still sat hard against the next stud along. So the wall
  // must still carry the same studs, none of them in the opening, and at least
  // one of them not where the bay grid would have put it.
  const across = withDoor.filter((x) => Math.abs(x) < 0.62)
  const moved = withDoor.filter((x) => !bare.some((c) => Math.abs(c - x) < 0.02))
  check(across.length === 0 && withDoor.length === bare.length && moved.length > 0,
    'and no stud is framed across an opening',
    `${moved.length} of ${bare.length} studs stepped aside, ${across.length} left in the opening`)
}

// ---------------------------------------------------------------------------
// 3b. The window, and the two things that touch it.
// ---------------------------------------------------------------------------
//
// Both of these are LOOKING faults rather than geometric ones, which is why
// neither the airtightness gate nor the daylight probe ever saw them: a shutter
// floating 7 cm clear of the building it is hung on is a perfectly closed mesh,
// and so is a window with the eaves resting on its head.
//
// So they are measured the way you would look at them. The shutter check builds
// ONE window on its own, picks the leaf out of the mesh by its layer and its
// triangle count, and asks whether the leaf's hinged edge is INSIDE the timber
// of the surround -- a crossing-parity test against the ring's own shell, which
// is the only question that survives the warp moving both of them. The headroom
// check walks whole buildings and fires a ray straight up off each window's
// head, because what has to be 30 cm away is whatever is actually up there:
// the covering, the eaves, or the wall plate lying across the top of the wall.

console.log('\nthe window')

/** The mesh split into welded connected components, each with its own layer,
 *  bounding box and triangle list. A part drawn by one call is one component:
 *  nothing in the kit welds two parts together. */
function componentsOf(g) {
  const pos = g.getAttribute('position').array
  const lay = g.getAttribute('texLayer').array
  const idx = g.getIndex().array
  const weld = new Map()
  const rep = new Int32Array(pos.length / 3)
  for (let v = 0; v < rep.length; v++) {
    const key = `${pos[v * 3].toFixed(4)},${pos[v * 3 + 1].toFixed(4)},${pos[v * 3 + 2].toFixed(4)}`
    if (!weld.has(key)) weld.set(key, v)
    rep[v] = weld.get(key)
  }
  const parent = new Int32Array(rep.length).map((_, i) => i)
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  for (let i = 0; i < idx.length; i += 3) {
    for (const j of [1, 2]) {
      const a = find(rep[idx[i]])
      const b = find(rep[idx[i + j]])
      if (a !== b) parent[a] = b
    }
  }
  const out = new Map()
  for (let i = 0; i < idx.length; i += 3) {
    const r = find(rep[idx[i]])
    if (!out.has(r)) out.set(r, { tris: [], layer: lay[idx[i]], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], verts: new Map() })
    const c = out.get(r)
    const tri = [0, 1, 2].map((j) => {
      const o = idx[i + j] * 3
      return [pos[o], pos[o + 1], pos[o + 2]]
    })
    c.tris.push(tri)
    for (const v of tri) {
      c.verts.set(v.map((q) => q.toFixed(4)).join(), v)
      for (let a = 0; a < 3; a++) { c.lo[a] = Math.min(c.lo[a], v[a]); c.hi[a] = Math.max(c.hi[a], v[a]) }
    }
  }
  return [...out.values()]
}

/** Möller-Trumbore, double sided, forward hits only. */
/** A triangle's unit normal, either way up. */
function triNormal([a, b, c]) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const n = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ]
  const l = Math.hypot(n[0], n[1], n[2]) || 1
  return [n[0] / l, n[1] / l, n[2] / l]
}

function hitT(tri, o, d) {
  const [a, b, c] = tri
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]]
  const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2]
  if (Math.abs(det) < 1e-12) return -1
  const inv = 1 / det
  const tv = [o[0] - a[0], o[1] - a[1], o[2] - a[2]]
  const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * inv
  if (u < 0 || u > 1) return -1
  const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]]
  const v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) * inv
  if (v < 0 || u + v > 1) return -1
  const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv
  return t > 1e-4 ? t : -1
}

// An odd number of crossings of a closed shell means the point is inside it.
// Asked of ONE component rather than of the whole mesh, because a building is a
// union of interpenetrating solids and a point inside two of them crosses an
// even number of times.
const PROBE_DIR = [0.31, 0.87, 0.383]
const insideComp = (c, p) => {
  for (let a = 0; a < 3; a++) if (p[a] < c.lo[a] || p[a] > c.hi[a]) return false
  let n = 0
  for (const tri of c.tris) if (hitT(tri, p, PROBE_DIR) > 0) n++
  return n % 2 === 1
}

{
  // The leaf hangs on the ring, seed by seed and straight and warped. Straight
  // is the case the arithmetic can be reasoned about; warped is the one that
  // actually ships, and it is the one that was broken before -- the field moves
  // the surround and the leaf by nearly, but not exactly, the same amount, so a
  // leaf that only just touches at strength 0 lets go at strength 1.
  const WIN_SEEDS = 200
  const bad = []
  let leaves = 0
  let ajar = 0
  for (let seed = 0; seed < WIN_SEEDS; seed++) {
    for (const strength of [0, 1]) {
      const k = makeCharacter(seed * 7 + 3, strength)
      const b = new Builder()
      windowUnit2(b, {
        x: 0, z: 0, y0: 1.2, nx: 0, nz: 1, width: 0.7, height: 0.88,
        shutters: true, seed, detail: 2, k,
      })
      const warp = makeWarp(k, 0)
      if (warp) warpBuilder(b, warp)
      const comps = componentsOf(b.toGeometry())
      const tag = `seed ${seed}${strength ? ' warped' : ''}`
      // The ring is the only plank part of a window with more than one quad in
      // it; the leaves are the plank parts with exactly one, doubled.
      const ring = comps.find((c) => c.layer === LAYER.TIMBER_PLANK && c.tris.length > 8)
      const leafComps = comps.filter((c) => c.layer === LAYER.TIMBER_PLANK && c.tris.length === 4)
      if (!ring || leafComps.length !== 2) {
        bad.push(`${tag}: found ${leafComps.length} leaves and ${ring ? 'a' : 'no'} surround`)
        continue
      }
      for (const leaf of leafComps) {
        leaves++
        const vs = [...leaf.verts.values()]
        const hung = vs.filter((v) => insideComp(ring, v))
        if (hung.length !== 2) {
          bad.push(`${tag}: ${hung.length} of ${vs.length} leaf corners in the surround`)
          continue
        }
        // And the whole hinged edge, not just its ends: a leaf pinned at the
        // corners and bowed out in the middle is still hanging in the air.
        for (const t of [0.25, 0.5, 0.75]) {
          const p = [0, 1, 2].map((a) => hung[0][a] + (hung[1][a] - hung[0][a]) * t)
          if (!insideComp(ring, p)) { bad.push(`${tag}: the hinged edge leaves the surround at ${t}`); break }
        }
        // Ajar or shut, measured off the mesh: the free edge stands further out
        // of the wall than the hinged one. The wall faces +z here.
        const free = vs.filter((v) => !hung.includes(v))
        const dz = Math.max(...free.map((v) => v[2])) - Math.max(...hung.map((v) => v[2]))
        if (dz > 0.03) ajar++
      }
    }
  }
  check(bad.length === 0, 'every shutter is hung on the surround, not on the air',
    bad.length ? `${bad.length} loose, e.g. ${bad[0]}` : `${leaves} leaves, straight and warped`)
  // A kit where every leaf is shut is a kit whose shutters read as painted-on
  // panels, and one where every leaf is open is a building nobody lives in.
  check(ajar > leaves * 0.2 && ajar < leaves * 0.9, 'and some of them stand open',
    `${ajar} of ${leaves} leaves ajar`)
}

{
  // 30 CM OF WALL ABOVE THE HEAD, measured off the built building rather than
  // off the numbers that were supposed to produce it. plan.js reserves the band,
  // windowUnit2 ducks the unit down when the covering has come lower than the
  // plan thought, and wall2 hands up the height of the plate lying across the
  // top of the wall -- three pieces, any two of which can agree while the third
  // puts a beam through the window head. What the eye measures is the gap, so
  // that is what this measures: straight up off the head of every window in the
  // corpus, until it hits something.
  const WANT = 0.3
  // WHERE THE RAY STARTS, measured out of the wall plane.
  //
  // A log wall's face IS its courses -- 15 cm timbers standing 5 cm proud, laid
  // straight across the opening because the surround stands in front of them --
  // so a course over a window is the wall, not an object jammed on its head, and
  // measuring at the wall plane there measures the inside of a log. The only
  // honest place to stand on those is in front of the courses, at the outer face
  // of the frame. A plastered wall carries nothing on its face except its own
  // framing, which stands 7.5 cm out, so there the measurement is taken close in
  // as well -- and that near sample is the one that sees the wall plate.
  const OUT_OF = {
    log: [0.16], stave: [0.16],
    halfTimber: [0.06, 0.16], stoneBase: [0.06, 0.16], masonry: [0.06, 0.16],
  }
  // The allowance, and what it is for. The duck reserves the band against the
  // WARPED covering -- sheet, verge and thatch skirt alike -- and it reserves it
  // over the whole patch of ground the head takes up rather than at a handful of
  // samples, so what is left over is the difference between the head of the
  // frame and the top edge of the glass this ray starts from. Two centimetres
  // for the straight building and three for the warped one, where the transform
  // tilts the unit in its own plane.
  const SLACK = { 0: 0.02, 1: 0.03 }
  // How many buildings may lose the last window on their front elevation before
  // the reserve costs more than it buys. It measures 11 of 480; this is a
  // ceiling on that, not a target. The fix when it is reached is to let a window
  // that cannot get under the covering slide ALONG its wall before it is
  // dropped -- a change to where plan.js says a window may stand, not to this
  // band. Every one of the 11 is a front wall whose outer bays stand under the
  // eave of the wing next door, where the alternative to a blank wall is a
  // window with a roof through it.
  const BLANK_FRONTS = 12
  const bad = []
  let worst = [Infinity, '']
  let panes = 0
  // WHAT THE RESERVE COSTS. A window that cannot be got under the covering by
  // less than three quarters of its own height is not drawn at all, and the band
  // is what decides how many of those there are -- so the drop rate is part of
  // the same measurement and is counted here rather than guessed at. Most of
  // them are the same shape: a window on a long wall whose outer half stands
  // under the eave of the wing next door, two metres up. The number to watch is
  // the second one: plan.js promises every building a window on its front, and
  // that promise is made before any roof exists to sit on it.
  let planned = 0
  let drawn = 0
  let blankFront = 0
  for (const strength of [0, 1]) {
    for (const kind of Object.keys(KINDS)) {
      for (let s = 1; s <= GEO_SEEDS; s++) {
        const plan = planBuilding({ seed: s, kind, groundAt: slopeFor(s) })
        const g = buildBuilding2(plan, { detail: 2, strength }).geometry
        const comps = componentsOf(g)
        const centre = [0, 2].map((a) => {
          let t = 0
          for (const c of comps) t += (c.lo[a] + c.hi[a]) / 2
          return t / comps.length
        })
        const panesHere = comps.filter((c) => c.layer === LAYER.GLASS && c.verts.size === 4)
        // Matched in PLAN, not in space: the duck only ever moves a window down
        // its own wall, so a pane still stands over the position it was planned
        // at even when it has slid half a metre.
        //
        // COUNTED THROUGH THE MATCH rather than by counting panes, because not
        // every pane on the building is a planned window: a dormer carries one
        // that plan.js has never heard of, and counting glass would let a
        // building that dropped a window off its wall and grew one in its roof
        // report as having lost nothing.
        const near = (wn) => panesHere.some((c) => {
          const cm = [0, 2].map((a) => (c.lo[a] + c.hi[a]) / 2)
          return Math.hypot(cm[0] - wn.x, cm[1] - wn.z) < 0.4
        })
        planned += plan.windows.length
        drawn += plan.windows.filter(near).length
        const fronts = plan.windows.filter((wn) => wn.side === 'front' && wn.massId === 0)
        if (fronts.length && !fronts.some((wn) => panesHere.some((c) => {
          const cm = [0, 2].map((a) => (c.lo[a] + c.hi[a]) / 2)
          return Math.hypot(cm[0] - wn.x, cm[1] - wn.z) < 0.4
        }))) blankFront++
        for (const pane of panesHere) {
          const vs = [...pane.verts.values()]
          panes++
          const mid = [0, 1, 2].map((a) => vs.reduce((t, v) => t + v[a], 0) / 4)
          // The pane's own normal, flattened into the horizontal and turned to
          // face away from the middle of the building. A window looking into the
          // inner corner of an ell can take the wrong sign here, which costs
          // nothing: the ray then starts inside the room, where the covering is
          // higher than it is out under the eave.
          const [a0, b0, c0] = pane.tris[0]
          const e1 = [b0[0] - a0[0], b0[1] - a0[1], b0[2] - a0[2]]
          const e2 = [c0[0] - a0[0], c0[1] - a0[1], c0[2] - a0[2]]
          let n = [e1[1] * e2[2] - e1[2] * e2[1], 0, e1[0] * e2[1] - e1[1] * e2[0]]
          const ln = Math.hypot(n[0], n[2])
          if (ln < 1e-6) continue
          n = [n[0] / ln, 0, n[2] / ln]
          if (n[0] * (mid[0] - centre[0]) + n[2] * (mid[2] - centre[1]) < 0) n = [-n[0], 0, -n[2]]
          // Everything this window is made of, which is not what has to be 30 cm
          // away. Nothing else in the kit is plank or iron within a metre of a
          // pane: the studs, the rails and the courses are beam or hewn, and the
          // covering has layers of its own.
          const own = new Set([pane])
          for (const c of comps) {
            if (c.layer !== LAYER.TIMBER_PLANK && c.layer !== LAYER.IRON) continue
            const cm = [0, 1, 2].map((a) => (c.lo[a] + c.hi[a]) / 2)
            if (Math.hypot(cm[0] - mid[0], cm[1] - mid[1], cm[2] - mid[2]) < 0.9) own.add(c)
          }
          // And the wall itself, which is the thing that is SUPPOSED to be above
          // the head: plaster and masonry are the face the window is set into.
          // (A log wall's face is its courses, which is why the samples for those
          // styles stand in front of them instead.) Under the warp a wall bellies
          // out, so a plumb ray started 6 cm off a leaning face walks into it
          // half a metre up -- which measures the lean, not the window.
          const FACE = new Set([LAYER.STONE, LAYER.PLASTER])
          const above = comps.filter((c) => !own.has(c) && !FACE.has(c.layer) && c.hi[1] > mid[1])
          // The head of the frame: the top edge of the glass, plus the frame it
          // is set in. The pane is 7 cm out of the wall plane, which is what the
          // sample distances below are measured back from.
          const top = vs.slice().sort((p, q) => q[1] - p[1]).slice(0, 2)
          for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            const e = [0, 1, 2].map((a) => top[0][a] + (top[1][a] - top[0][a]) * t)
            for (const face of OUT_OF[plan.style]) {
              const out = face - 0.07
              const o = [e[0] + n[0] * out, e[1] + 0.07, e[2] + n[2] * out]
              let hit = Infinity
              for (const c of above) {
                if (o[0] < c.lo[0] || o[0] > c.hi[0] || o[2] < c.lo[2] || o[2] > c.hi[2]) continue
                for (const tri of c.tris) {
                  // ONLY FACES THAT ACTUALLY LIE OVER THE WINDOW. A plumb ray
                  // started 9 cm off the glass grazes any near-vertical face
                  // standing in front of it -- the neighbouring wing's end wall
                  // on an ell, six centimetres away and leaning a couple of
                  // degrees out of plumb under the warp -- and reads a
                  // centimetre of headroom off it. That measures how far the
                  // window stands from a WALL, which is a different complaint
                  // from this one and would be answered by moving the window
                  // sideways, not down. Everything this gate is actually about
                  // is roughly horizontal: a roof sheet at a 50 degree pitch has
                  // |ny| 0.64, a plate soffit or a log course 1.0.
                  if (Math.abs(triNormal(tri)[1]) < 0.2) continue
                  const d = hitT(tri, o, [0, 1, 0])
                  if (d > 0 && d < hit) hit = d
                }
              }
              const tag = `${kind}/${s}${strength ? ' warped' : ''}`
              if (hit < worst[0]) worst = [hit, tag]
              if (hit < WANT - SLACK[strength]) bad.push(`${tag} ${hit.toFixed(3)} m`)
            }
          }
        }
      }
    }
  }
  check(bad.length === 0, 'every window keeps 30 cm of wall above its head',
    bad.length
      ? `${bad.length} tight, worst ${worst[0].toFixed(3)} m (${worst[1]})`
      : `worst ${worst[0] === Infinity ? 'open sky' : `${worst[0].toFixed(3)} m (${worst[1]})`}, ${panes} windows`)
  check(drawn > planned * 0.9 && blankFront <= BLANK_FRONTS, 'and the band costs few enough windows to be worth it',
    `${planned - drawn} of ${planned} dropped, ${blankFront} buildings left with a blank front`)
}

// ---------------------------------------------------------------------------
// 3c. The rake, and how far it diverges from the wall under it.
// ---------------------------------------------------------------------------
//
// THE THING BEING GATED IS A LOOK, and it is the one warp term whose absence is
// completely invisible to everything else here. A rake cut exactly parallel to
// the gable wall under it is a perfectly good roof: airtight, positively wound,
// inside budget, letting no daylight in, and it is what the whole village had
// before `vergeSplay` existed. Not one gate above would notice it coming back.
// So the divergence is measured over the corpus, and BOTH halves of the
// intended distribution are held -- most buildings splay, a few do not, and the
// few are on purpose.
//
// MEASURED OFF THE SURFACE, NOT OFF THE FORMULA. A gate that recomputed
// warp.js's `vergeSplay` draw and checked that planGableRoof had multiplied it
// by the run would prove that two copies of one expression agree, which is
// worth nothing at all. What is asked here instead is the question the eye asks
// from the street: how far does the sheet hang past the gable end wall at the
// TOP of the rake, and how far at the BOTTOM. Both numbers are read off
// `slopeSurface`'s own grid, which is the array `drawRoof` turns straight into
// quads, so what is measured is the roof that gets drawn.
//
// THE MAIN MASS ONLY, and that is a deliberate scope rather than a shortcut. A
// wing's verge is not free: building.js's wingVerge() works out how far a
// cross-wing has to oversail to die into the range's slope, hands planGableRoof
// an explicit `vergeLo`/`vergeHi`, and planGableRoof zeroes the splay on that
// end because a character term that shortened a functional verge would open the
// valley. A wing's rake is therefore parallel BY DESIGN, and averaging wings in
// would measure how many ells the corpus happens to contain rather than how
// much splay the term produces. Mass 0 is the one every building has and the
// one whose verges are always the free ones.
//
// THE ANCHOR IS THE INVARIANT. `splayAt` in parts.js is anchored on whichever
// end of the rake keeps the nominal verge rather than centred on it, precisely
// so that half of a large splay is never subtracted from a verge only 0.3 m
// deep. Centred, it would end the sheet INSIDE the gable wall on the seeds
// where the term is doing the most work, and a covering that stops short of the
// wall it covers is a slot of daylight rather than a look -- the same failure
// section 2 is built around, arriving from the other direction. That is a claim
// about arithmetic nobody can see, so the whole rake is walked and the closest
// it ever comes to the wall plane is reported. Sampling its vertices is EXACT
// rather than a sample: the rake is a polyline through those points and the
// wall plane is a constant, so the minimum over the polyline is the minimum
// over its vertices.

console.log('\nthe rake')

{
  // What counts as READABLE, in metres of difference between the two ends of
  // one rake. The corpus turns out to be sharply bimodal with an empty gap in
  // the middle of it: the ruled group runs from 0.036 to 0.083 m and the
  // splayed group starts at 0.250 and reaches 1.211, so this is set mid-gap,
  // where any cut from 0.09 to 0.24 would sort the corpus identically and the
  // classification cannot be turned over by one unlucky hut landing near the
  // line. 0.15 m of divergence off a verge only 0.3 m deep is half again as
  // much oversail at one end of the rake as at the other, which is well past
  // what the eye needs to see that the line is not parallel to the wall under
  // it.
  const READABLE = 0.15
  // And how much of the village has to have it. Measured: 192 of 240 splay, 48
  // are ruled. The gate is the INTENT -- most, and some -- with both bands set
  // well clear of what was measured, because these are draws from a die and 240
  // buildings is not a large sample of it. What should fail here is a change to
  // the odds or to the anchoring, not an unlucky seed.
  //
  // The ruled share has a FLOOR as well as a ceiling, because it is a feature
  // rather than a residue. warp.js draws it deliberately at about one building
  // in four, and a village where every single roof flares reads as a mannerism
  // instead of as character -- which is the same argument the eave `sway` term
  // makes for itself, and the reason the sign and the size of the splay are
  // drawn separately.
  const MOST = 0.6
  const RULED = [0.05, 0.4]

  const rows = []
  let closest = [Infinity, '']
  for (const kind of Object.keys(KINDS)) {
    for (let s = 1; s <= GEO_SEEDS; s++) {
      const plan = planBuilding({ seed: s, kind, groundAt: slopeFor(s) })
      const m = plan.masses[0]
      if (m.roof.kind !== 'gable') continue
      // Exactly the call building.js makes for mass 0. planRoofs() passes the
      // plan's own overhang and a 0.3 verge, and wingVerge() returns an empty
      // object for the main mass, so there is no spread argument to reproduce
      // and nothing here restates a decision made over there. The covering's
      // LAYER is the one argument not taken from the plan, and it cannot move a
      // vertex: slopeSurface reads it for the tile size the UVs are divided by
      // and for nothing else, and the grid it is sampled on comes from
      // roofGrid(), which is handed a width and a run.
      const k = makeCharacter(plan.seed, 1)
      const R = planGableRoof({
        cx: m.cx, cz: m.cz, w: m.w, d: m.d, eaveY: m.eaveY, rise: m.roof.rise,
        ridgeAxis: m.ridgeAxis, overhang: plan.overhang ?? 0.4, verge: 0.3,
        layer: LAYER.THATCH, seed: plan.seed * 29 + m.id, detail: 2, k,
      })
      const alongX = m.ridgeAxis === 'x'
      const alongHalf = (alongX ? m.w : m.d) / 2
      const mid = alongX ? m.cx : m.cz
      // How far past the gable end wall this sheet vertex hangs, positive
      // outward. `sign` is which end of the roof the rake is, so both ends of
      // both slopes answer one question with one sign and a retreat is always
      // negative whichever gable it happens on.
      const over = (p, sign) => sign * ((alongX ? p[0] : p[2]) - mid) - alongHalf
      const tag = `${kind}/${s}`
      let diverge = 0
      for (const sl of R.slopes) {
        const nv = sl.P.length - 1
        const nu = sl.P[0].length - 1
        for (const [i, sign] of [[0, -1], [nu, 1]]) {
          // The two ends of the rake: row 0 is the eave tip, row nv is the top
          // edge at the ridge. The MAX over the four rakes rather than any one
          // of them, so a change that splayed only one gable of a roof would
          // still be seen.
          diverge = Math.max(diverge, Math.abs(over(sl.P[nv][i], sign) - over(sl.P[0][i], sign)))
          for (let j = 0; j <= nv; j++) {
            const o = over(sl.P[j][i], sign)
            if (o < closest[0]) closest = [o, tag]
          }
        }
      }
      rows.push({ tag, diverge })
    }
  }

  const splayed = rows.filter((r) => r.diverge >= READABLE)
  const ruled = rows.length - splayed.length
  const sorted = rows.map((r) => r.diverge).sort((a, b) => a - b)
  const widest = rows.reduce((a, r) => (r.diverge > a.diverge ? r : a), rows[0])
  check(splayed.length >= rows.length * MOST,
    `most rakes diverge from the wall under them by ${READABLE} m or more`,
    `${splayed.length} of ${rows.length}, median ${sorted[rows.length >> 1].toFixed(2)} m, widest ${widest.diverge.toFixed(2)} m (${widest.tag})`)
  check(ruled >= rows.length * RULED[0] && ruled <= rows.length * RULED[1],
    'and a few are ruled nearly flush, on purpose',
    `${ruled} of ${rows.length} within ${READABLE} m of parallel, tightest ${sorted[0].toFixed(3)} m`)
  check(closest[0] > 0, 'and no rake ever retreats inside the gable end wall',
    `closest approach ${closest[0].toFixed(3)} m outside it (${closest[1]})`)
}

// ---------------------------------------------------------------------------
// 3d. The dormer.
// ---------------------------------------------------------------------------
//
// A dormer is a closed five-sided prism driven THROUGH the covering, which is
// the same trick the chimney uses, and it fails the same silent way: the main
// sheet has to climb and close over the BACK of the stub, and where it does
// not, the back gablet stands out of the roof behind the dormer and is visible
// from anywhere uphill of the building. Nothing else in this file can see that.
// The stub is closed, the sheet is closed, the union of two closed shells is
// closed, the winding is positive, the triangle budget has room, and the
// daylight probe stands inside the room and never looks into the attic.
//
// dormer2() guarantees the clearance BY MARCHING rather than by arithmetic: it
// walks `sheetAt` back into the slope in 12 cm steps until the covering has
// climbed 0.22 m clear over the stub's apex, and draws nothing at all where
// that never happens before the ridge. The pitch alone would be the wrong
// judge, because the sag can be 40 cm and the buckle wanders. That march is
// exact in the space the building is DRAWN in, so the only question left is
// whether the WARP then erodes it -- and it can, because the field moves the
// stub's back apex and the piece of sheet a metre above it by different
// amounts. So both points go through the same displacement field the building
// itself goes through, rebuilt from the character the build handed back, and
// the clearance is measured on the far side of it.
//
// MEASURED FROM THE SEATS THE BUILD RETURNED, not from the vertex array.
// buildBuilding2 hands back where it put every dormer, in unwarped plan
// coordinates, along with the covering's own height function for that mass.
// That is the difference between measuring the thing and hunting for a
// five-sided shape among 2,600 triangles and hoping the one found is the one
// meant.
//
// AND THE DISTRIBUTION, because a dormer is a strong and specific statement --
// there is a room up there and somebody wanted to see out of it -- and a
// village that makes it about every building has not made it. building.js rolls
// a blank five sides in six per pitch and caps the building at two however the
// dice fall. That cap is what the structure budget at the top of this file was
// raised against, and a budget defended against a bound nobody measures is a
// budget waiting to be surprised, so the bound is held here.

console.log('\nthe dormer')

{
  // Measured over the corpus: 171 buildings with none, 42 with one, 27 with
  // two, which is 69 of 240 carrying at least one. The band is deliberately
  // wide for the same reason the rake's is: this is a die, not an invariant,
  // and what should fail here is a change to the odds or to the vetoes rather
  // than an unlucky corner of the seed space.
  const CARRY = [0.18, 0.45]
  // How much of dormer2's 0.22 m the warp is allowed to eat. It eats almost
  // none of it: the worst seat in the corpus keeps 0.224 m, which is ABOVE the
  // unwarped guarantee of 0.22 rather than under it, because the march
  // overshoots by up to one of its 12 cm steps wherever the sheet is climbing
  // fast and that is worth more than the field takes back. So the
  // failure this is set against is not today's field getting slightly
  // unluckier, it is the field getting STRONGER or the march getting coarser,
  // and half the guarantee is far enough below the measurement to say that and
  // still fail long before anything surfaces.
  const KEEP = 0.12

  const hist = new Map()
  let buildings = 0
  let carriers = 0
  let seats = 0
  let overCap = 0
  let worst = [Infinity, '']
  for (const kind of Object.keys(KINDS)) {
    for (let s = 1; s <= GEO_SEEDS; s++) {
      const plan = planBuilding({ seed: s, kind, groundAt: slopeFor(s) })
      const built = buildBuilding2(plan, { detail: 2, strength: 1 })
      const ds = built.dormers
      buildings++
      hist.set(ds.length, (hist.get(ds.length) ?? 0) + 1)
      if (ds.length > 0) carriers++
      if (ds.length > 2) overCap++
      const warp = makeWarp(built.character, plan.plinthBottom, plan.footprint)
      for (const dm of ds) {
        seats++
        // The far end of the sweep, which is where the back gablet stands: the
        // ridge of the stub's own covering -- which is `lift` above the section
        // apex, that sheet being laid over the solid rather than being a face of
        // it -- and the point on the main covering directly over it. The lift is
        // millimetres and the clearance is centimetres, but a check that
        // measures the second-highest thing drawn is not measuring the thing.
        // Warped as a PAIR and differenced afterwards,
        // because each of them lands somewhere the other did not and the gap
        // between the two is the entire question.
        const bx = dm.x - dm.nx * dm.depth
        const bz = dm.z - dm.nz * dm.depth
        const apex = warp(bx, dm.faceY + dm.apexH + dm.lift, bz)
        const sheet = warp(bx, dm.sheetAt(bx, bz), bz)
        const clear = sheet[1] - apex[1]
        if (clear < worst[0]) worst = [clear, `${kind}/${s}`]
      }
      built.geometry.dispose()
    }
  }

  const spread = [...hist.entries()].sort((a, c) => a[0] - c[0]).map(([n, c]) => `${c} with ${n}`).join(', ')
  check(carriers >= buildings * CARRY[0] && carriers <= buildings * CARRY[1] && overCap === 0,
    'about a third of buildings carry a dormer, and none carries more than two',
    `${carriers} of ${buildings} (${spread})`)
  check(worst[0] > KEEP, 'and the covering closes over the back of every stub, warped',
    worst[0] === Infinity ? 'no dormers drawn at all'
      : `worst ${worst[0].toFixed(3)} m clear (${worst[1]}), ${seats} dormers`)
}

// ---------------------------------------------------------------------------
// 4. The geometry.
// ---------------------------------------------------------------------------

console.log('\ngeometry')

const ATTRS = ['position', 'normal', 'uvProj', 'texLayer', 'color']
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
// 5. The warp itself.
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
      const f = makeWarp(makeCharacter(plan.seed, 1), plan.plinthBottom, plan.footprint)
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
// 6. Daylight: can you see out of a building through something that is not an
//    opening?
// ---------------------------------------------------------------------------

console.log('\ndaylight')

// Section 2's airtightness gate cannot answer this and never could. It asks
// whether every directed edge is paired, and a wall's own back face pairs the
// wall's own edges whatever is or is not standing next to it -- so two masses
// meeting with a 20 cm band of nothing between them are two separately closed
// shells, and the union of two closed shells is closed. Every hole the user has
// reported was invisible to that gate and obvious from inside the room.
//
// So this section stands inside the room instead. scripts/probe-building-gaps.mjs
// puts sample points where a person's head would be, fires 512 fixed directions
// from each, and counts the ones that reach open air without meeting a triangle;
// rays that leave within 0.75 m of a window or a door centre are discarded,
// because those holes are on purpose. The probe file is imported rather than
// reimplemented so the number that gates the build and the number the report
// prints cannot drift apart. Run it directly for per-mass detail and somewhere
// to go and look:
//
//   node scripts/probe-building-gaps.mjs 54494
//
// 40 seeds x 4 kinds x 2 strengths is 3.5M rays and takes about a second, which
// is why the whole corpus is swept here rather than a sample of it.
{
  let selfOk = true
  let selfWhy = ''
  let self = null
  try {
    self = probeSelfCheck({ log: () => {} })
  } catch (e) {
    selfOk = false
    selfWhy = e.message.replace('probe-building-gaps: ', '')
  }
  // The instrument before the measurement. A probe that had quietly stopped
  // seeing anything would report a clean corpus and would be the most expensive
  // way this gate could lie, so the same three self-checks the standalone report
  // prints run here: a sealed room leaks nothing, the same room with a 20 cm band
  // cut out of one wall leaks, and a point 3 m outside a real hut escapes in
  // nearly every direction.
  check(selfOk, 'the probe sees a known hole and does not see a sealed room',
    selfOk
      ? `sealed 0, a 20 cm slot ${self.openOut}/${self.dirs}, ${self.cut} triangles out of hut/1's ${self.wallSide} wall ${self.holed}, outside ${self.outside}/${self.dirs}`
      : selfWhy)

  const rows = { 0: [], 1: [] }
  for (const strength of [0, 1]) {
    for (const kind of KIND_NAMES) {
      for (const seed of CORPUS_SEEDS) {
        const plan = planBuilding({ seed, kind })
        rows[strength].push({ kind, seed, ...probeBuilding(plan, strength) })
      }
    }
  }
  const tally = (rs) => ({
    leaky: rs.filter((r) => r.filtered > 0),
    escaped: rs.reduce((a, r) => a + r.filtered, 0),
    cast: rs.reduce((a, r) => a + r.cast, 0),
  })
  const where = (rs) => rs.filter((r) => r.filtered > 0)
    .sort((a, b) => b.filtered - a.filtered).slice(0, 4)
    .map((r) => `${r.kind}/${r.seed} ${r.filtered}`).join(', ')

  // STRENGTH 0 IS EXACT. The straight building is arithmetic: every joint
  // overlap in plan.js and parts.js is a number somebody wrote down, and a ray
  // that gets out of one is a mistake in that number rather than bad luck. It
  // measured 66 of 160 buildings leaking before the burial and joint fixes and
  // measures 0 rays of 1.7M now, so 0 is what it is held to.
  const s0 = tally(rows[0])
  check(s0.escaped === 0, 'the straight building lets no daylight in anywhere but its openings',
    s0.escaped === 0
      ? `0 of ${s0.cast.toLocaleString()} rays, ${rows[0].length} buildings`
      : `${s0.escaped} rays, ${s0.leaky.length} buildings: ${where(rows[0])}`)

  // STRENGTH 1 HAS AN ALLOWANCE, and it is small on purpose. What ships is the
  // straight building plus a displacement field that moves a vertex up to 0.95 m,
  // and at a couple of mass junctions it pulls two surfaces apart fractionally
  // faster than the overlaps can absorb -- currently 2 rays of 1.7M, one each in
  // hut/17 and longhouse/33, both single rays grazing an outshut junction. A real
  // hole is nothing like that: the defects the user reported scored hundreds to
  // thousands of rays in a single building. 12 rays and 4 buildings sits far
  // above today's pinholes and far below anything a person could see, so a
  // regression fails here rather than in the headset.
  const s1 = tally(rows[1])
  const ok1 = s1.escaped <= 12 && s1.leaky.length <= 4
  check(ok1, 'the warped building leaks no more than a few stray rays at mass junctions',
    `${s1.escaped} rays of ${s1.cast.toLocaleString()}, ${s1.leaky.length} of ${rows[1].length} buildings${s1.leaky.length ? ` (${where(rows[1])})` : ''}`)
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
