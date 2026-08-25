// Node-side gates for the procedural building kit (src/buildings/*, DESIGN.md §19).
//
//   node scripts/check-buildings.mjs [seeds]
//
// Buildings fail the way villages fail: silently and geometrically. A chimney
// floating four centimetres above its own thatch, a window centred on the door,
// a wall whose logs step at every corner, a tile with a bright seam running up
// it every 1.3 metres -- none of those throw, none of them show up in a
// triangle count, and every one of them is found by walking there and looking,
// which is the most expensive way to find anything.
//
// Three parts, and they need different machinery:
//
//   THE PLAN, which is pure data. src/buildings/plan.js imports no three.js
//   (the §1 porting rule), so a few thousand buildings can be planned and
//   asserted in under a second with no WebGL context anywhere. That is what
//   makes it affordable to check EVERY seed of EVERY kind rather than a
//   sample, and coverage is the whole point: the bugs in a grammar live in the
//   combinations nobody thought to look at.
//
//   THE TILES, which are pixels. The seam metric here is the one that took
//   three wrong attempts to get right, and the reasoning is written out at
//   seamScore() because it is the kind of thing that gets "simplified" back
//   into being wrong.
//
//   THE SHIPPED PNGs, which OVERWRITE some of those tiles at runtime via
//   IMAGE_LAYERS. A generated tile that passes is worth nothing if the PNG
//   patched over it a few frames later does not, so they face the same metric.

import { planBuilding, KINDS, roofHeightAt } from '../src/buildings/plan.js'
import { buildBuilding } from '../src/buildings/building.js'
import {
  Builder, WALL_STYLE, openEdges, signedVolume,
  plinth, wall, gableEnd, leanEnd, gableRoof, leanToRoof,
  doorway, windowUnit, chimney, porch, steps, roughSection, roughSlab,
} from '../src/buildings/parts.js'
import { LAYER, TEX_SIZE } from '../src/textures.js'
import {
  tileLogs, tilePlanks, tileThatch, tileShingles, tileStone, tilePlaster,
  tileFringe, tileGlass, sheetIron, sheetRunes, IRON_ISLANDS, RUNE_ISLANDS, GUTTER,
} from '../src/buildings/tiles.js'
import { readPng } from '../tools/props/png.mjs'

const SEEDS = Number(process.argv[2] ?? 300)
// §5, the `structure` prop class mesh tier, and the SAME number v2's gate
// defends -- one budget, two kits, so a comparison between them is a comparison
// of what they spend it on.
//
// Raised from 1800 when the kit went from boxes to hewn prisms (§19,
// "Rough-hewn"): worst 1660 -> 2380, mean 766 -> 1064, and §5's village row moved
// with it. Raised from 2500 to 2600 when a partly-covered wall stopped being
// dropped whole: a wall that a wing hides the middle of is now two stretches
// plus, where the wing is shorter than the wall, a sliver above its roof, and
// the worst inn went 2380 -> 2576 buying the daylight gaps out of its interior.
// This is a budget to be DEFENDED, not a number to raise whenever a part grows
// -- both raises were deliberate and both were for correctness rather than for
// decoration, and the next thing that wants triangles takes them from somewhere
// else.
const STRUCTURE_BUDGET = 2600

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

console.log(`\n=== building checks, ${SEEDS} seeds x ${Object.keys(KINDS).length} kinds ===\n`)

// ---------------------------------------------------------------------------
// 1. The plan, over every seed of every kind.
// ---------------------------------------------------------------------------

console.log('plan')

const bad = {
  doorFacing: [], doorOnWall: [], windowOnDoor: [], windowInWall: [],
  chimneySeated: [], chimneyAboveRidge: [], footprint: [], sunk: [], roomCount: [],
}
let planned = 0
let worstPlanMs = 0

// A hillside, so the plinth/steps/porch logic is exercised rather than skipped.
// Half the seeds flat and half on a slope: the flat case is the one the
// previewer shows and the sloped case is the one that produces the bugs.
const slopeFor = (s) => (s % 2 === 0 ? null : (x) => -x * 0.14)

for (const kind of Object.keys(KINDS)) {
  for (let s = 1; s <= SEEDS; s++) {
    const t0 = performance.now()
    const p = planBuilding({ seed: s, kind, groundAt: slopeFor(s) })
    worstPlanMs = Math.max(worstPlanMs, performance.now() - t0)
    planned++
    const id = `${kind}/${s}`

    // The convention the village spur-path router depends on. If this ever
    // drifts, every village grows paths to the backs of its houses.
    if (!(p.door.nz === 1 && p.door.nx === 0)) bad.doorFacing.push(id)

    const main = p.masses[0]
    // The door has to be ON the front wall, not floating past its end.
    if (Math.abs(p.door.z - (main.cz + main.d / 2)) > 1e-6) bad.doorOnWall.push(id)
    if (Math.abs(p.door.x - main.cx) > main.w / 2 - p.door.width / 2) bad.doorOnWall.push(id)

    for (const w of p.windows) {
      // A window overlapping the doorway is the single most generated-looking
      // failure this system can produce, and bay allocation is what prevents it.
      const sameWall = w.nz === 1 && Math.abs(w.z - p.door.z) < 1e-6
      const overlapX = Math.abs(w.x - p.door.x) < (w.width + p.door.width) / 2 + 0.12
      const overlapY = w.y0 < p.door.y0 + p.door.height + 0.1
      if (sameWall && overlapX && overlapY) bad.windowOnDoor.push(id)

      // And it has to fit between the floor and the eave of its own mass.
      const m = p.masses.find((mm) => mm.id === w.massId)
      if (w.y0 < m.floorY + 0.2 || w.y0 + w.height > m.eaveY - 0.1) bad.windowInWall.push(id)
    }

    // The chimney base must lie ON the roof surface. plan.js and parts.js both
    // compute the slope, and this is the assertion that keeps the two copies of
    // that maths from drifting -- the symptom otherwise is a chimney hovering,
    // which is invisible until someone stands under it.
    const seated = roofHeightAt(main.roof, p.chimney.x, p.chimney.z)
    if (Math.abs(seated - p.chimney.baseY) > 1e-6) bad.chimneySeated.push(id)
    if (p.chimney.topY <= main.roof.ridgeY + 0.2) bad.chimneyAboveRidge.push(id)
    // ...and it must be inside the roof it pierces, not out past the verge.
    if (Math.abs(p.chimney.x - main.cx) > main.w / 2 - 0.25) bad.chimneySeated.push(id)

    // The footprint is what the router keeps paths out of. A degenerate or
    // unclosed hull would silently let a road run through a house.
    if (p.footprint.length < 4) bad.footprint.push(id)
    const area = polyArea(p.footprint)
    if (!(area > p.stats.area * 0.8)) bad.footprint.push(`${id} hull ${area.toFixed(1)} < plan ${p.stats.area}`)

    // On a slope the floor goes at the highest corner and the plinth reaches
    // the lowest, so nothing can float and no sill can be buried.
    if (p.plinthBottom >= p.groundMin || p.floorY < p.groundMax) bad.sunk.push(id)

    // Room count falls out of area rather than being a knob; check it stayed
    // sane rather than collapsing to 1 for everything.
    if (p.stats.rooms < 1 || p.stats.rooms > 12) bad.roomCount.push(id)
  }
}

const report = (key, label) =>
  check(bad[key].length === 0, label, bad[key].length ? `${bad[key].length} bad, e.g. ${bad[key][0]}` : `${planned} plans`)

report('doorFacing', 'every door faces local +Z')
report('doorOnWall', 'every door sits on the front wall of the main mass')
report('windowOnDoor', 'no window overlaps the doorway')
report('windowInWall', 'every window fits between its own floor and eave')
report('chimneySeated', 'every chimney base lands on the roof surface it pierces')
report('chimneyAboveRidge', 'every chimney top clears the ridge')
report('footprint', 'every footprint hull closes and covers the plan area')
report('sunk', 'no building floats or buries its doorsill on a slope')
report('roomCount', 'room count stays plausible')
check(worstPlanMs < 5, 'planning is cheap enough to gate exhaustively', `worst ${worstPlanMs.toFixed(2)} ms`)

// ---------------------------------------------------------------------------
// 1b. Every part, alone, at every orientation.
//
// The whole-building gate below catches the same defects, but it reports them as
// "hut/2 detail 2 has an unpaired edge", which is a hole somewhere in nine
// hundred triangles. Building each part into its own Builder localises the
// failure to the function that has the bug, and -- more usefully -- covers the
// orientations a plan happens not to produce. Windows sit on all four walls of
// every building, but leanEnd() only ever gets the outshut directions the
// grammar picks, and the winding of a part is exactly the thing that is right on
// one axis and inside out on another.
//
// TWO PROPERTIES, and they are not the same property:
//
//   AIRTIGHT   openEdges() -- no boundary. This is the user-visible one: a
//              missing face is a hole you see the inside of the building
//              through.
//   OUTWARD    signedVolume() -- and this is openEdges()'s blind spot. A shell
//              wound inside out balances every edge just as neatly as a correct
//              one, and under back-face culling it renders as the same hole.
//              Solid parts must come out positive; the parts that are honestly
//              zero-thickness (a doubled gable triangle, a lean-to end) come out
//              at zero and are declared so here rather than skipped.
// ---------------------------------------------------------------------------

console.log('\nparts')

// The hewn cross-section, before anything is swept along it.
//
// EVERYTHING ELSE IN THIS SECTION RESTS ON THIS ONE PROPERTY: prism() derives
// its outward winding and both of its cap fans from the section being a SIMPLE
// polygon wound anticlockwise. Jitter two corners past each other and the loop
// crosses itself -- which still pairs every directed edge, so the airtight
// check passes, and produces a member with an inside-out lobe that renders as a
// hole. Cheaper to assert here, on the 2D loop, than to infer it from a volume.
{
  const cross2 = (o, a, c) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0])
  const hits = (p1, p2, p3, p4) => {
    const d1 = cross2(p3, p4, p1)
    const d2 = cross2(p3, p4, p2)
    const d3 = cross2(p1, p2, p3)
    const d4 = cross2(p1, p2, p4)
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
  }
  const bad = []
  let count = 0
  // Aspect ratios out past anything the kit asks for: a window surround's
  // section is the widest at about 1:2.3.
  for (const [hu, hv] of [[0.1, 0.1], [0.035, 0.08], [0.3, 0.1], [0.02, 0.16], [0.4, 0.05]]) {
    for (let n = 5; n <= 8 && bad.length < 4; n++) {
      for (let seed = 0; seed < 250; seed++) {
        for (const round of [0, 0.16, 0.55, 0.95]) {
          const s = roughSection(n, hu, hv, seed, { round, jitter: 0.22 })
          count++
          let area = 0
          for (let k = 0; k < n; k++) {
            const j = (k + 1) % n
            area += s[k][0] * s[j][1] - s[j][0] * s[k][1]
          }
          if (!(area > 0)) { bad.push(`n${n} seed${seed} round${round} area ${area.toExponential(2)}`); continue }
          for (let k = 0; k < n; k++) {
            for (let m = k + 2; m < n; m++) {
              if (k === 0 && m === n - 1) continue // adjacent across the wrap
              if (hits(s[k], s[(k + 1) % n], s[m], s[(m + 1) % n])) {
                bad.push(`n${n} seed${seed} round${round} edges ${k}/${m} cross`)
              }
            }
          }
        }
      }
    }
  }
  check(bad.length === 0, 'every rough section is simple and wound anticlockwise',
    bad.length ? `${bad.length} bad, e.g. ${bad[0]}` : `${count.toLocaleString()} sections, 5-8 sides`)
}

const NORMALS = [[0, 1], [0, -1], [1, 0], [-1, 0]]
const PARTS = []
for (const [nx, nz] of NORMALS) {
  const at = (a, out) => [-nz * a + nx * out, nx * a + nz * out]
  const dir = nx ? (nx > 0 ? '+x' : '-x') : nz > 0 ? '+z' : '-z'
  PARTS.push(
    [`window ${dir}`, (b, detail, seed) => windowUnit(b, { x: 0, z: 0, y0: 1.2, nx, nz, seed, detail }), 'solid'],
    [`window+shutters ${dir}`, (b, detail, seed) => windowUnit(b, { x: 0, z: 0, y0: 1.2, nx, nz, shutters: true, seed, detail }), 'solid'],
    [`door ${dir}`, (b, detail, seed) => doorway(b, { x: 0, z: 0, y0: 0, nx, nz, runes: true, seed, detail }), 'solid'],
    [`wall log ${dir}`, (b, detail, seed) => wall(b, { p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.LOG, seed, rough: seed, detail }), 'solid'],
    [`wall stave ${dir}`, (b, detail, seed) => wall(b, { p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.STAVE, seed, rough: seed, detail }), 'solid'],
    [`wall halfTimber ${dir}`, (b, detail, seed) => wall(b, { p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.HALF_TIMBER, seed, rough: seed, detail }), 'solid'],
    [`wall stoneBase ${dir}`, (b, detail, seed) => wall(b, { p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.STONE_BASE, seed, rough: seed, detail }), 'solid'],
    // 'flat', unlike the other four: v1's masonry is the texture and nothing
    // else (the quoins are v2's), so it is one doubled quad and encloses no
    // volume. Declaring it solid here would be asking the control kit to have a
    // part it deliberately does not have.
    [`wall masonry ${dir}`, (b, detail, seed) => wall(b, { p0: at(-2, 0), p1: at(2, 0), y0: 0, y1: 2.4, style: WALL_STYLE.MASONRY, seed, rough: seed, detail }), 'flat'],
    [`gableEnd ${dir}`, (b, detail, seed) => gableEnd(b, { p0: at(-2, 0), p1: at(2, 0), y0: 2.4, apexY: 4.2, style: WALL_STYLE.LOG, seed, detail }), 'solid'],
    [`leanEnd ${dir}`, (b) => leanEnd(b, { p0: at(-1.5, 0), p1: at(1.5, 0), y0: 2, y1: 3.1, style: WALL_STYLE.LOG }), 'flat'],
  )
}
for (const axis of ['x', 'z']) {
  PARTS.push(
    [`gableRoof thatch ${axis}`, (b, detail, seed) => gableRoof(b, { cx: 0, cz: 0, w: 5, d: 4, eaveY: 2.4, rise: 1.8, ridgeAxis: axis, layer: LAYER.THATCH, tint: [1, 1, 1], fringe: true, seed, detail }), 'solid'],
    [`gableRoof shingle ${axis}`, (b, detail, seed) => gableRoof(b, { cx: 0, cz: 0, w: 5, d: 4, eaveY: 2.4, rise: 1.8, ridgeAxis: axis, layer: LAYER.SHINGLE, tint: [1, 1, 1], fringe: false, seed, detail }), 'solid'],
    [`gableRoof catslide ${axis}`, (b, detail, seed) => gableRoof(b, { cx: 0, cz: 0, w: 5, d: 4, eaveY: 2.4, rise: 1.8, ridgeAxis: axis, layer: LAYER.SHINGLE, tint: [1, 1, 1], vergeHi: 2.2, seed, detail }), 'solid'],
  )
}
for (const dir of ['+x', '-x', '+z', '-z']) {
  PARTS.push([`leanToRoof ${dir}`, (b, detail, seed) => leanToRoof(b, { cx: 0, cz: 0, w: 3, d: 2.5, highY: 3.2, lowY: 2.2, dir, layer: LAYER.THATCH, tint: [1, 1, 1], seed, detail }), 'solid'])
}
PARTS.push(
  ['plinth', (b, detail, seed) => plinth(b, { cx: 0, cz: 0, w: 5, d: 4, top: 0.4, bottom: -0.3, batter: detail >= 2 ? 0.06 : 0, bevel: detail >= 2 ? 0.05 : 0, seed }), 'solid'],
  ['chimney', (b, detail, seed) => chimney(b, { x: 0, z: 0, baseY: 3, topY: 5, seed, detail }), 'solid'],
  ['porch', (b, detail, seed) => porch(b, { x: 0, z: 2, floorY: 0.4, groundY: -0.3, headY: 2.4, seed, detail }), 'solid'],
  ['porch flat', (b, detail, seed) => porch(b, { x: 0, z: 2, floorY: 0.05, groundY: 0, headY: 2.4, seed, detail }), 'solid'],
  ['steps', (b, detail, seed) => steps(b, { x: 0, z: 2, topY: 0.55, groundY: -0.2, seed, detail }), 'solid'],
  // One riser, where the tread is shallower than the chamfer wants to be and the
  // stringer is nearly flat. Both clamps in roughSlab() and steps() live here.
  ['steps doorstep', (b, detail, seed) => steps(b, { x: 0, z: 2, topY: 0.16, groundY: 0, seed, detail }), 'solid'],
  // A slab far thinner than its chamfer, to prove the bevel clamps rather than
  // turning the thing inside out.
  ['roughSlab thin', (b, detail, seed) => roughSlab(b, [-1, 0, -0.06], [1, 0.04, 0.06], { seed, bevel: 0.05, layer: LAYER.STONE, color: [1, 1, 1] }), 'solid'],
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
      const b = new Builder()
      draw(b, detail, seed)
      if (b.triangles === 0) continue
      partCases++
      const g = b.toGeometry()
      const open = openEdges(g)
      if (open.length) partBad.open.push(`${name} d${detail} s${seed} ${open.length} unpaired`)
      const vol = signedVolume(g)
      // 1e-5 m3 is below anything the kit places deliberately and far above the
      // drift on a doubled quad, whose two halves cancel to the last bit.
      //
      // Only detail 2 has to be POSITIVE: the lower tiers drop the solid parts
      // of a window or a door and keep the doubled panel, which is honestly
      // zero. No tier of anything may ever be negative.
      const ok = kindOf === 'flat'
        ? Math.abs(vol) < 1e-5
        : detail === 2 ? vol > 1e-5 : vol > -1e-5
      if (!ok) partBad.vol.push(`${name} d${detail} s${seed} ${vol.toExponential(2)} m3, wanted ${kindOf}`)
      g.dispose()
    }
  }
}
check(partBad.open.length === 0, 'every part is airtight on its own',
  partBad.open.length ? `${partBad.open.length} bad, e.g. ${partBad.open[0]}` : `${PARTS.length} parts, ${partCases} cases`)
check(partBad.vol.length === 0, 'every solid part is wound outwards, every flat part is flat',
  partBad.vol.length ? `${partBad.vol.length} bad, e.g. ${partBad.vol[0]}` : 'signed volume as declared')

// ---------------------------------------------------------------------------
// 2. The geometry. Fewer seeds -- this one allocates.
// ---------------------------------------------------------------------------

console.log('\ngeometry')

const GEO_SEEDS = Math.min(SEEDS, 60)
const ATTRS = ['position', 'normal', 'uvProj', 'texLayer', 'color']
let worstTris = 0
let worstId = ''
let sumTris = 0
let geoCount = 0
const geoBad = { attrs: [], finite: [], budget: [], lod: [], below: [], layer: [], open: [], inverted: [] }
let worstOpen = 0

for (const kind of Object.keys(KINDS)) {
  for (let s = 1; s <= GEO_SEEDS; s++) {
    const id = `${kind}/${s}`
    const p = planBuilding({ seed: s, kind, groundAt: slopeFor(s) })
    const tiers = [2, 1, 0].map((detail) => buildBuilding(p, { detail }))

    for (const [i, t] of tiers.entries()) {
      const g = t.geometry
      // Every geometry has to agree on the attribute set or the village merge
      // returns null -- which is a silent disappearance, not an error.
      for (const a of ATTRS) if (!g.getAttribute(a)) geoBad.attrs.push(`${id} d${2 - i} missing ${a}`)
      const pos = g.getAttribute('position').array
      const uv = g.getAttribute('uvProj').array
      for (let k = 0; k < pos.length; k++) if (!Number.isFinite(pos[k])) { geoBad.finite.push(`${id} d${2 - i} position`); break }
      for (let k = 0; k < uv.length; k++) if (!Number.isFinite(uv[k])) { geoBad.finite.push(`${id} d${2 - i} uvProj`); break }

      // Nothing may hang below the plinth. A part that does is a part standing
      // in mid-air on the downhill side of a slope.
      let minY = Infinity
      for (let k = 1; k < pos.length; k += 3) if (pos[k] < minY) minY = pos[k]
      if (minY < p.plinthBottom - 0.5) geoBad.below.push(`${id} d${2 - i} ${minY.toFixed(2)}`)

      // Every texLayer must name a layer the array actually has, and buildings
      // must only wear building layers -- a stray BARK on a wall is a one-digit
      // typo that renders as a plausible-looking wrong material.
      const lay = g.getAttribute('texLayer').array
      const legal = new Set([
        LAYER.TIMBER_BEAM, LAYER.TIMBER_HEWN, LAYER.TIMBER_PLANK, LAYER.THATCH, LAYER.SHINGLE,
        LAYER.STONE, LAYER.PLASTER, LAYER.THATCH_FRINGE, LAYER.GLASS,
        LAYER.IRON, LAYER.RUNE, LAYER.ROOF_TILE, LAYER.DOOR,
      ])
      for (let k = 0; k < lay.length; k++) if (!legal.has(lay[k])) { geoBad.layer.push(`${id} d${2 - i} layer ${lay[k]}`); break }

      // AIRTIGHT. Every directed edge a->b must be matched by a b->a somewhere,
      // which is what it means for the surface to have no boundary. This is
      // deliberately NOT "every edge is shared by exactly two triangles": the kit
      // is a union of interpenetrating solids -- a chimney driven through a roof
      // slope, a log end driven through a wall -- so four triangles may meet at
      // one edge quite legitimately, and a back-to-back double-sided quad (the
      // thatch fringe, the door leaf) pairs its edges perfectly while sharing
      // none. What no arrangement of solids can do is leave an edge unpaired, so
      // an imbalance here is always a face that is genuinely missing, and always
      // a hole you can see the inside of the building through.
      // The composition, as a net under the per-part gate above: a part added to
      // building.js but never listed in PARTS still has to not be inside out.
      if (signedVolume(g) <= 0) geoBad.inverted.push(`${id} d${2 - i}`)

      const open = openEdges(g)
      if (open.length) {
        geoBad.open.push(`${id} d${2 - i} ${open.length} unpaired, e.g. ${open[0].key}`)
        if (open.length > worstOpen) worstOpen = open.length
      }
    }

    // LOD by re-generation only works if the tiers actually get cheaper.
    if (!(tiers[0].triangles > tiers[1].triangles && tiers[1].triangles > tiers[2].triangles)) {
      geoBad.lod.push(`${id} ${tiers.map((t) => t.triangles).join(' / ')}`)
    }
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
geoReport('layer', 'every texLayer names a building layer')
geoReport('below', 'nothing hangs below the plinth')
geoReport('open', 'every tier is airtight -- no unpaired edges', `${geoCount * 3} meshes closed`)
geoReport('inverted', 'every assembled tier encloses positive volume')
geoReport('lod', 'detail 2 > detail 1 > detail 0, every seed')
geoReport('budget', `every building fits the structure budget (${STRUCTURE_BUDGET} tris)`,
  `worst ${worstTris} (${worstId}), mean ${Math.round(sumTris / geoCount)}`)

// A whole village of the largest kind still has to fit §5's allotment.
const villageTris = worstTris * 20
check(villageTris < 55000, '20 of the worst-case building fit the village allotment',
  `${villageTris.toLocaleString()} tris for 20 visible`)

// One material, and therefore one draw call, is the entire architectural
// premise. Verify it holds rather than assuming it.
{
  const p = planBuilding({ seed: 3, kind: 'cottage', style: 'stoneBase', roof: 'thatch' })
  const { geometry } = buildBuilding(p, { detail: 2 })
  const layers = new Set(geometry.getAttribute('texLayer').array)
  check(layers.size >= 5, 'one geometry wears many materials at once',
    `${layers.size} texture layers in a single BufferGeometry`)
  check(geometry.groups.length === 0, 'no geometry groups, so no multi-material split')
  geometry.dispose()
}

// ---------------------------------------------------------------------------
// 3. The tiles.
// ---------------------------------------------------------------------------

console.log('\ntiles')

/**
 * How much worse the wrap edge is than the strongest line the tile already has.
 *
 * The baseline is the MAXIMUM interior step, and it took three wrong answers to
 * get there, all of them worth recording because each is the obvious choice:
 *
 *   One interior row pair, as the control. Misleading -- whichever pair you
 *   pick is usually in a smooth region, so every deliberate line in the tile
 *   scores as a catastrophic seam.
 *
 *   The mean step over the whole tile. Now the legitimate hard lines (a shingle
 *   butt, a log chink, a mortar joint) drag the baseline down, and a tile whose
 *   course count divides evenly puts one of those lines exactly ON the wrap
 *   edge -- which is correct and scores 4.6.
 *
 *   The 95th percentile of interior steps. Better, but a tile with only three
 *   or four strong lines has them all above p95, so the baseline lands in the
 *   noise again.
 *
 * The max is the right question: "is the boundary worse than the strongest line
 * this tile already contains?" A score at or under 1 means it is
 * indistinguishable from the tile's own periodic detail. A real discontinuity
 * -- and the noise-argument-scaling bug that put one in five of these tiles
 * scored 3.5 to 29 -- runs far above it.
 */
function seamScore(px, n, axis) {
  const at = (x, y, c) => px[((y % n) * n + (x % n)) * 4 + c]
  const step = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) {
        step[k] += axis === 'u'
          ? Math.abs(at(k, i, c) - at(k + 1, i, c))
          : Math.abs(at(i, k, c) - at(i, k + 1, c))
      }
    }
  }
  let max = 0
  for (let k = 0; k < n - 1; k++) max = Math.max(max, step[k])
  return step[n - 1] / Math.max(1e-6, max)
}

const N = TEX_SIZE
const TILES = [
  ['logs', tileLogs, 'uv'],
  ['planks', tilePlanks, 'uv'],
  ['thatch', tileThatch, 'uv'],
  ['shingles', tileShingles, 'uv'],
  ['stone', tileStone, 'uv'],
  ['plaster', tilePlaster, 'uv'],
  ['glass', tileGlass, 'uv'],
  // The fringe tiles along the eave and is CLAMPED across it -- v = 1 is the
  // eave line and v = 0 is the hanging tip, so a discontinuity in v is the
  // asset working, not failing.
  ['fringe', tileFringe, 'u'],
]

for (const [name, gen, axes] of TILES) {
  const px = gen(N)
  check(px.length === N * N * 4, `${name} is ${N}x${N} RGBA`, `${px.length} bytes`)
  for (const axis of axes) {
    const sc = seamScore(px, N, axis)
    const ok = sc <= 1.05
    check(ok, `${name} wraps in ${axis}`, `seam ${sc.toFixed(2)} of the tile's own strongest line`)
  }
}

// Decal sheets: every island must live inside the unit square with a
// transparent gutter around it, which is what lets them share a RepeatWrapping
// array with the tiles. Wrap mode only bites outside [0,1], and bilinear only
// reaches a neighbour if there is a neighbour within a texel to reach.
const GUTTER_TEXELS = Math.round(GUTTER * N)
for (const [name, gen, islands] of [['iron', sheetIron, IRON_ISLANDS], ['runes', sheetRunes, RUNE_ISLANDS]]) {
  const px = gen(N)
  let outside = 0
  let dirty = 0
  for (const isl of Object.values(islands)) {
    if (isl.u0 < 0 || isl.v0 < 0 || isl.u1 > 1 || isl.v1 > 1) outside++
    // Walk the gutter band and demand it be fully transparent.
    const x0 = Math.floor(isl.u0 * N) - GUTTER_TEXELS
    const x1 = Math.ceil(isl.u1 * N) + GUTTER_TEXELS
    const y0 = Math.floor(isl.v0 * N) - GUTTER_TEXELS
    const y1 = Math.ceil(isl.v1 * N) + GUTTER_TEXELS
    for (let y = Math.max(0, y0); y < Math.min(N, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(N, x1); x++) {
        const inIsland =
          x >= Math.floor(isl.u0 * N) && x < Math.ceil(isl.u1 * N) &&
          y >= Math.floor(isl.v0 * N) && y < Math.ceil(isl.v1 * N)
        if (inIsland) continue
        if (px[(y * N + x) * 4 + 3] > 8) { dirty++; break }
      }
    }
  }
  check(outside === 0, `${name} islands stay inside [0,1]`, `${Object.keys(islands).length} islands`)
  check(dirty === 0, `${name} islands have a clean ${GUTTER_TEXELS}-texel gutter`,
    dirty ? `${dirty} islands bleed` : 'nothing for bilinear to reach')
}

// The fringe's alpha is its shape, and the shape has a direction: v = 1 is the
// eave line and must be solid, v = 0 is the ragged tip and must be mostly gone.
// Getting this upside down flips the fringe into a sawtooth along the ridge.
{
  const px = tileFringe(N)
  const rowAlpha = (y) => {
    let sum = 0
    for (let x = 0; x < N; x++) sum += px[(y * N + x) * 4 + 3]
    return sum / N / 255
  }
  // Row 0 is v = 0 and row N-1 is v = 1. Nothing flips on upload -- see the
  // paint() header in tiles.js, which is where this was wrong for a while and
  // where the fringe learned to hang its tips along the ridge.
  const eave = rowAlpha(N - 1)
  const tip = rowAlpha(0)
  check(eave > 0.97, 'the fringe is solid at the eave line', `alpha ${eave.toFixed(2)} at v=1`)
  check(tip < 0.4, 'the fringe is ragged at the hanging tip', `alpha ${tip.toFixed(2)} at v=0`)
}

// ---------------------------------------------------------------------------
// 4. The shipped PNGs.
//
// IMAGE_LAYERS entries are patched over the generators at runtime, which means
// a PNG that is the wrong size, the wrong way up, or does not wrap replaces a
// tile that WAS all three and nothing anywhere says so -- `loadImageLayers`
// resolves, the array uploads, and the roof is simply wrong. Every assertion
// the generated tile has to pass, the PNG that overwrites it has to pass too.
// ---------------------------------------------------------------------------

console.log('\nshipped tiles')

// Every entry of IMAGE_LAYERS that points into public/buildings/. `door.png` is
// the one exception and is deliberately absent: it is a decal sheet addressed
// 0..1 by island, never repeated, so a seam across its edge is a seam nothing
// samples. It gets its own assertion below instead.
for (const [name, file, axes] of [
  ['thatch.png', 'public/buildings/thatch.png', 'uv'],
  ['thatch_fringe.png', 'public/buildings/thatch_fringe.png', 'u'],
  ['timber_beam.png', 'public/buildings/timber_beam.png', 'uv'],
  ['timber_hewn.png', 'public/buildings/timber_hewn.png', 'uv'],
  ['timber_plank.png', 'public/buildings/timber_plank.png', 'uv'],
  ['shingle.png', 'public/buildings/shingle.png', 'uv'],
  ['roof_tile.png', 'public/buildings/roof_tile.png', 'uv'],
  ['stone.png', 'public/buildings/stone.png', 'uv'],
  ['glass.png', 'public/buildings/glass.png', 'uv'],
]) {
  let png
  try {
    png = readPng(new URL(`../${file}`, import.meta.url).pathname)
  } catch (e) {
    check(false, `${name} loads`, String(e.message ?? e))
    continue
  }
  const ok = png.width === N && png.height === N && png.channels === 4
  check(ok, `${name} is ${N}x${N} RGBA`, `${png.width}x${png.height}x${png.channels}`)
  if (!ok) continue
  for (const axis of axes) {
    const sc = seamScore(png.data, N, axis)
    check(sc <= 1.05, `${name} wraps in ${axis}`, `seam ${sc.toFixed(2)} of the tile's own strongest line`)
  }
}

// The fringe PNG's alpha is the outline of every thatched roof at LOD1, so it
// gets the same eave/tip assertion as the generator it replaces. Upside down
// here turns the fray into a sawtooth along the ridge.
{
  const px = readPng(new URL('../public/buildings/thatch_fringe.png', import.meta.url).pathname).data
  const rowAlpha = (y) => {
    let sum = 0
    for (let x = 0; x < N; x++) sum += px[(y * N + x) * 4 + 3]
    return sum / N / 255
  }
  check(rowAlpha(N - 1) > 0.97, 'the shipped fringe is solid at the eave line', `alpha ${rowAlpha(N - 1).toFixed(2)} at v=1`)
  check(rowAlpha(0) < 0.4, 'the shipped fringe is ragged at the hanging tip', `alpha ${rowAlpha(0).toFixed(2)} at v=0`)
}

// The door sheet is addressed by island, so what matters about it is not a seam
// but that it is fully opaque -- a hole in a door leaf is a hole into the
// building, and `alphaTest: 0.5` would happily cut one.
{
  const png = readPng(new URL('../public/buildings/door.png', import.meta.url).pathname)
  check(png.width === N && png.height === N && png.channels === 4,
    `door.png is ${N}x${N} RGBA`, `${png.width}x${png.height}x${png.channels}`)
  let clear = 0
  for (let i = 0; i < N * N; i++) if (png.data[i * 4 + 3] < 128) clear++
  check(clear === 0, 'the shipped door leaf is fully opaque',
    clear ? `${clear} texels would be cut by alphaTest` : 'nothing for alphaTest to cut')
}

// A multiply-only tint (§19: thatchOld, slate and the moss overlay are all
// per-vertex colour multiplies) can take brightness away and never add it. A
// shipped tile with texels at 255 has nowhere left to go, and the roof that is
// supposed to look NEW ends up identical to the one that is supposed to look
// old -- or the slate one comes out the same value as the shake one.
for (const name of ['thatch', 'timber_beam', 'timber_hewn', 'timber_plank', 'shingle', 'roof_tile', 'stone']) {
  const px = readPng(new URL(`../public/buildings/${name}.png`, import.meta.url).pathname).data
  let hot = 0
  for (let i = 0; i < N * N; i++) {
    if (px[i * 4] > 240 && px[i * 4 + 1] > 240 && px[i * 4 + 2] > 240) hot++
  }
  check(hot / (N * N) < 0.005, `the shipped ${name} keeps headroom for the tint`,
    `${((hot / (N * N)) * 100).toFixed(2)}% of texels are at the ceiling`)
}

// WHICH WAY UP a lapped roof tile is.
//
// This is the assertion that the thatch fringe earned for everything else. Row
// 0 is v = 0 is the EAVE, and a lapped roof is photographed the way it is
// looked at, with the courses running down the frame -- so every roof source
// has to be flipped on the way in, and a tile that was not flipped renders as a
// roof that laps uphill. Nothing about the finished tile looks wrong in an
// image viewer, and nothing about the building looks obviously wrong either;
// it just sheds water into itself.
//
// The measurable consequence is that the exposed butt of each course is the
// brightest band on the roof and the head, under the course above, is the
// darkest -- so the low-v half of every course period must be brighter than the
// high-v half. Thatch is combed rather than lapped but its butt ends sit proud
// and catch the light the same way.
//
// roof_tile is absent, and that is a gap rather than an oversight: a pantile's
// direction is carried by the SHAPE of the scallop and not by its value, its
// two halves measure 1.003 apart, and a threshold tight enough to catch a flip
// would be a number fitted to this one file. It was checked by eye instead.
for (const [name, courses, floor] of [['shingle', 6, 1.1], ['thatch', 4, 1.05]]) {
  const px = readPng(new URL(`../public/buildings/${name}.png`, import.meta.url).pathname).data
  const period = N / courses
  let butt = 0
  let head = 0
  let nb = 0
  let nh = 0
  for (let y = 0; y < N; y++) {
    let row = 0
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4
      row += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
    }
    if (((y + 0.5) % period) / period < 0.5) { butt += row; nb++ } else { head += row; nh++ }
  }
  const ratio = (butt / nb) / (head / nh)
  check(ratio > floor, `the shipped ${name} laps downhill`,
    `butt half is ${ratio.toFixed(2)}x the head half`)
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all building checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)

// --- helpers ----------------------------------------------------------------

function polyArea(poly) {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
  }
  return Math.abs(a) / 2
}
