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
      const oOf = (p) => (p[0] - d.x) * d.nx + (p[2] - d.z) * d.nz

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
          // The surround: everything of the door's own that stands in its footprint.
          if (tri.every((p) => Math.abs(aOf(p)) < d.width / 2 + 0.18
            && oOf(p) > -0.09 && oOf(p) < 0.19)) {
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
