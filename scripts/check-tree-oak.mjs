// Node-side gates for the oak generator (src/props/tree-oak.js).
//
//   node scripts/check-tree-oak.mjs [seeds]
//
// What this holds, in the order it would cost the most to lose:
//
//   THE PINE IS PINNED. tree-v8.js is the conifer generator and the bench that
//   hosts both now dispatches per species. Nothing here imports the oak into
//   the pine's path, but the fingerprint is the proof rather than the argument:
//   a hash over every attribute of every v8 species at every tier, against the
//   values recorded when the oak arrived.
//
//   THE LAW IS THE BUILDER. resolveTreeOak() prices a parameter set before any
//   geometry exists and the ladder table prints it; buildTreeOak() must emit
//   exactly that many triangles, at every tier and over every shape here.
//
//   A SCOOP IS A SCOOP. Five faces fanned one way round, so every face agrees
//   with the scoop's opening, which is turned away from the openings beside
//   it, with the body reaching any way but back down a limb at its tip; the
//   stem corner on a branch's surface and, on the whole, further from the
//   centre than the other four.
//
//   THE TIERS ARE ONE TREE. A coarse rung is a prefix of LOD0's scoops, vertex
//   for vertex: dropped, not re-rolled, and at the same scale.
//
//   THE LAYOUTS MATCH THE MATERIALS. The wood is createPropMaterial's layout
//   and the crown is the mapped Lambert's, and BatchedMesh refuses a batch over
//   one stray attribute.

import { createHash } from 'node:crypto'

import {
  buildTreeOak, resolveTreeOak, treeOakLod, TREE_OAK_DEFAULTS, TREE_OAK_SPECIES, treeOakSpecies,
} from '../src/props/tree-oak.js'
import { buildTrunkV8, buildFoliageV8, treeV8Lod, treeV8Species, TREE_V8_SPECIES } from '../src/props/tree-v8.js'

const SEEDS = Number(process.argv[2] ?? 40)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- 1. the pine is pinned ---------------------------------------------------
//
// Recorded from tree-v8.js the day the oak generator landed. A change to these
// is a change to a tree the user called dialed; the gate does not decide
// whether it was wanted, it only makes sure nobody finds out on the stage.
const V8_PINS = {
  'pine:0': 'trunk=1ef594f423802cac foliage=c92bec72344b8ca9 tris=352',
  'pine:1': 'trunk=b83848a437413be2 foliage=a39896a215aed5dc tris=201',
  'pine:2': 'trunk=b83848a437413be2 foliage=0903319e3a478852 tris=129',
  'oak:0': 'trunk=be27625b78491d16 foliage=88e2e98295994839 tris=432',
  'oak:1': 'trunk=0fd6881c2ed9fee0 foliage=d2de6305f66f3019 tris=219',
  'oak:2': 'trunk=0fd6881c2ed9fee0 foliage=0946e228d8ae5202 tris=75',
  'aspen:0': 'trunk=c18cec8e2511e4c2 foliage=56642a0a90c56231 tris=433',
  'aspen:1': 'trunk=aeb3af654e8f9cb3 foliage=ec79211c45a728c9 tris=243',
  'aspen:2': 'trunk=aeb3af654e8f9cb3 foliage=5dabde299ae551fa tris=111',
  'birch:0': 'trunk=272bc8a31ef615da foliage=15bef92f225aaa7d tris=413',
  'birch:1': 'trunk=1955d9b4e256d7e6 foliage=e76b1a01e7703b2e tris=219',
  'birch:2': 'trunk=1955d9b4e256d7e6 foliage=e1d6dae54b1e4104 tris=93',
}

function fingerprint(geo) {
  const h = createHash('sha256')
  for (const name of Object.keys(geo.attributes).sort()) {
    h.update(name)
    h.update(Buffer.from(geo.attributes[name].array.buffer))
  }
  if (geo.index) h.update(Buffer.from(geo.index.array.buffer))
  return h.digest('hex').slice(0, 16)
}

console.log('--- 1. the v8 species are pinned')
for (const name of Object.keys(TREE_V8_SPECIES)) {
  for (let tier = 0; tier < 3; tier++) {
    const p = treeV8Lod(treeV8Species(name), tier)
    const { geometry: trunk, frame, tree } = buildTrunkV8(p)
    const foliage = buildFoliageV8(p, frame)
    const got = `trunk=${fingerprint(trunk)} foliage=${fingerprint(foliage)} tris=${tree.triangles + foliage.userData.foliage.triangles}`
    check(got === V8_PINS[`${name}:${tier}`], `${name} LOD${tier} unchanged`, got === V8_PINS[`${name}:${tier}`] ? '' : `got ${got}`)
  }
}

// --- the shapes ---------------------------------------------------------------
const SHAPES = [
  { name: 'default', over: {} },
  { name: 'straight', over: { trunkSegments: 1, branchSegments: 1, trunkCrook: 0, branchCrook: 0 } },
  { name: 'gnarled', over: { trunkSegments: 6, trunkCrook: 0.4, branchSegments: 6, branchCrook: 0.7, branchRise: -0.2 } },
  { name: 'bare', over: { branches: 0 } },
  { name: 'flat', over: { boughDepth: 0, boughSkew: 0, boughJitter: 0, tipZone: 0 } },
  { name: 'tips', over: { tipZone: 1 } },
  { name: 'plain', over: { boughAims: 1, boughSpins: 1 } },
  { name: 'many', over: { branches: 11, boughs: 160, boughRadius: 0.04, tipBias: 0.5 } },
  { name: 'round', over: { trunkLobe: 0, trunkSides: 5, branchSides: 3 } },
  { name: 'tiny', over: { height: 1.2, boughs: 12 } },
  { name: 'fat', over: { trunkRadius: 0.09, branchRadius: 1, boughDepth: 1.2, boughAims: 64, boughSpins: 12, stemReach: 3 } },
  { name: 'cups', over: { boughDepth: 1, boughSkew: 0.9, boughJitter: 0.6, stemReach: 0.3, boughFrom: 0.9 } },
  { name: 'aspen', over: TREE_OAK_SPECIES.aspen.params },
  { name: 'birch', over: TREE_OAK_SPECIES.birch.params },
]

// The unwelded crown is fifteen vertices a scoop, in the fan's order: face k
// is (centre, rim k, rim k + 1), and rim 0 is the stem.
const PER_SCOOP = 15
const scoopVerts = (pos, i) => {
  const v = (k) => [pos[(i * PER_SCOOP + k) * 3], pos[(i * PER_SCOOP + k) * 3 + 1], pos[(i * PER_SCOOP + k) * 3 + 2]]
  return { centre: v(0), stem: v(1), rim: [v(2), v(5), v(8), v(11)] }
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// --- 2. the law is the builder ----------------------------------------------
console.log('--- 2. resolveTreeOak() prices what buildTreeOak() builds')
{
  let worst = ''
  let n = 0
  for (const shape of SHAPES) {
    for (let s = 0; s < SEEDS; s++) {
      for (let tier = 0; tier < 3; tier++) {
        const p = treeOakLod({ ...TREE_OAK_DEFAULTS, ...shape.over, seed: 1000 + s }, tier)
        const r = resolveTreeOak(p)
        const { trunk, foliage, stats } = buildTreeOak(p)
        const idx = trunk.index.count / 3 + foliage.index.count / 3
        const wood = trunk.index.count / 3
        n++
        if (idx !== r.triangles || stats.triangles !== r.triangles || wood !== r.woodTris || stats.woodTris !== r.woodTris) {
          worst = worst || `${shape.name} seed ${1000 + s} LOD${tier}: law ${r.triangles} (wood ${r.woodTris}), index ${idx} (wood ${wood}), stats ${stats.triangles}`
        }
      }
    }
  }
  check(worst === '', `index count == law over ${n} builds`, worst)
}

// --- 3. a scoop is a scoop --------------------------------------------------
//
// The fan goes one way round, so every face's own cross product must have a
// positive part along the scoop's opening -- a face against it is one the
// skew or the jitter turned over -- and the stored normal must be that cross
// product turned to the sky side. The opening is read off the fan itself: the
// SUM of the unnormalised cross products is twice the rim polygon's vector
// area, which lies along the opening exactly, where a mean of unit normals
// does not -- a deep cup's opposite walls cancel. The bodies reach every way:
// with every scoop in the tip zone none runs back down its limb, and over all
// the shapes only a few reach straight out along the limb -- the litter is
// not a clamshell of scoops closing on each tip. The aim's whole point is
// measured too: over scoops within three rim radii of one another, the mean
// of how parallel two openings are must come out clearly lower with the aim
// on than with a single candidate (`plain`). The stem is on a branch's
// surface: within the tube's radius of its polyline, read back off the wood's
// own rings. And, in all but a few, the stem is further from the centre than
// the other rim corners.
console.log('--- 3. every scoop is fanned one way, aimed off its neighbours, stemmed on a branch and reaches off it')
{
  let faces = 0
  let against = 0
  let notOwn = 0
  let notReaching = 0
  let straightOut = 0
  let scoops = 0
  let reaching = 0
  let stemNear = 0
  let offWood = 0
  let worst = ''
  let worstWood = ''
  const parallel = { default: { sum: 0, pairs: 0 }, plain: { sum: 0, pairs: 0 } }
  for (const shape of SHAPES) {
    for (let s = 0; s < SEEDS; s++) {
      const p = { ...TREE_OAK_DEFAULTS, ...shape.over, seed: 1000 + s }
      const r = resolveTreeOak(p)
      const { trunk, foliage } = buildTreeOak(p)
      const pos = foliage.attributes.position.array
      const nrm = foliage.attributes.normal.array
      // The branches' polylines and ring radii, off the wood. The bole comes
      // first: its rings and its apex; then each branch's rings and apex. A
      // ring's mean is its centre, a seam corner over.
      const wood = trunk.attributes.position.array
      let at = r.trunkSegments * (r.trunkSides + 1) + r.trunkSides
      const limbs = []
      for (let b = 0; b < r.branches; b++) {
        const path = []
        const radii = []
        for (let ring = 0; ring < r.branchSegments; ring++) {
          let cx = 0, cy = 0, cz = 0
          const n = r.branchSides + 1
          for (let k = 0; k < n; k++) { cx += wood[(at + k) * 3]; cy += wood[(at + k) * 3 + 1]; cz += wood[(at + k) * 3 + 2] }
          const c = [cx / n, cy / n, cz / n]
          let rad = 0
          for (let k = 0; k < n; k++) rad += dist(c, [wood[(at + k) * 3], wood[(at + k) * 3 + 1], wood[(at + k) * 3 + 2]])
          path.push(c)
          radii.push(rad / n)
          at += n
        }
        path.push([wood[at * 3], wood[at * 3 + 1], wood[at * 3 + 2]])
        radii.push(0)
        at += r.branchSides
        limbs.push({ path, radii })
      }
      // How far a point is off the nearest tube surface, in that branch's butt
      // radii: distance to the closest polyline segment, less the radius there;
      // and which way every segment whose surface it is on runs -- at a sharp
      // joint a stem sits on two, and it is the seat's own that it reaches
      // along.
      const nearestWood = (q) => {
        let best = Infinity
        const alongs = []
        for (const limb of limbs) {
          for (let i = 0; i + 1 < limb.path.length; i++) {
            const a = limb.path[i], b = limb.path[i + 1]
            const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
            const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
            const t = Math.min(1, Math.max(0, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1] + (q[2] - a[2]) * ab[2]) / len2))
            const on = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]
            const rad = limb.radii[i] + (limb.radii[i + 1] - limb.radii[i]) * t
            const off = Math.abs(dist(q, on) - rad) / limb.radii[0]
            best = Math.min(best, off)
            if (off <= 0.3) alongs.push(ab.map((v) => v / Math.sqrt(len2)))
          }
        }
        return { off: best, alongs }
      }
      const openings = []
      for (let i = 0; i < r.boughs; i++) {
        scoops++
        const { centre, stem, rim } = scoopVerts(pos, i)
        // Own cross products, unnormalised, and their sum: the opening.
        const own = []
        for (let f = 0; f < 5; f++) {
          const v = (i * 5 + f) * 3
          const ax = pos[(v + 1) * 3] - pos[v * 3], ay = pos[(v + 1) * 3 + 1] - pos[v * 3 + 1], az = pos[(v + 1) * 3 + 2] - pos[v * 3 + 2]
          const bx = pos[(v + 2) * 3] - pos[v * 3], by = pos[(v + 2) * 3 + 1] - pos[v * 3 + 1], bz = pos[(v + 2) * 3 + 2] - pos[v * 3 + 2]
          own.push([ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx])
        }
        const opening = own.reduce((m, w) => [m[0] + w[0], m[1] + w[1], m[2] + w[2]], [0, 0, 0])
        for (let f = 0; f < 5; f++) {
          faces++
          const v = (i * 5 + f) * 3
          const w = own[f]
          const l = Math.hypot(...w)
          if (w[0] * opening[0] + w[1] * opening[1] + w[2] * opening[2] <= 0) { against++; worst = worst || `${shape.name} seed ${1000 + s} scoop ${i} face ${f} turned over` }
          if (Math.abs(w[0] * nrm[v * 3] + w[1] * nrm[v * 3 + 1] + w[2] * nrm[v * 3 + 2]) / l < 0.999 || nrm[v * 3 + 1] < 0) { notOwn++; worst = worst || `${shape.name} seed ${1000 + s} scoop ${i} face ${f} stored normal is not its own, skyward` }
        }
        // The rim's centre, for the neighbourhood the aim scores.
        const rimC = [stem, ...rim].reduce((m, q) => [m[0] + q[0] / 5, m[1] + q[1] / 5, m[2] + q[2] / 5], [0, 0, 0])
        const l = Math.hypot(...opening)
        openings.push({ c: rimC, n: [opening[0] / l, opening[1] / l, opening[2] / l] })
        const { off, alongs } = nearestWood(stem)
        if (off > 0.3) { offWood++; worstWood = worstWood || `${shape.name} seed ${1000 + s} scoop ${i}: stem ${off.toFixed(2)} butt radii off the wood`; continue }
        // The body: the rim's mean less the stem, which the skew and the
        // spin leave at the rim's centre and the jitter moves only a little.
        // Every scoop of `tips` is a tip scoop, and those must reach past the
        // limb, not back down it: the aim refuses a body behind the seat's
        // tangent, and a body square to it read through the jittered rim
        // comes out a little behind at most.
        const body = rim.reduce((m, q) => [m[0] + q[0] / 4, m[1] + q[1] / 4, m[2] + q[2] / 4], [0, 0, 0]).map((v, k) => v - stem[k])
        const forward = Math.max(...alongs.map((a) => (body[0] * a[0] + body[1] * a[1] + body[2] * a[2]) / Math.hypot(...body)))
        if (p.tipZone >= 1 && forward < -0.2) { notReaching++; worst = worst || `${shape.name} seed ${1000 + s} scoop ${i} at a tip runs back down the limb` }
        if (forward > Math.cos(Math.PI / 6)) straightOut++
        // `cups` puts the stem at a third of a rim radius on purpose; the
        // promise is for every shape that keeps the reach past one.
        if (p.stemReach > 1) {
          reaching++
          const others = rim.reduce((sum, q) => sum + dist(q, centre), 0) / rim.length
          if (dist(stem, centre) <= others) stemNear++
        }
      }
      if (shape.name in parallel) {
        // The aim's own neighbourhood: three rim radii, as the generator sizes
        // the rim before the rescale, which is within a few percent of one.
        const near = 3 * p.boughRadius * p.height
        const tally = parallel[shape.name]
        for (let i = 0; i < openings.length; i++) {
          for (let j = 0; j < i; j++) {
            const a = openings[i], b = openings[j]
            if (dist(a.c, b.c) >= near) continue
            tally.sum += Math.abs(a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2])
            tally.pairs++
          }
        }
      }
    }
  }
  check(against === 0 && notOwn === 0 && notReaching === 0, `${faces} faces: ${against} turned over, ${notOwn} not their own skyward normal; ${notReaching} tip scoops running back down the limb`, worst)
  // A body within thirty degrees of its limb's own heading: a cone of a
  // fifteenth of the sphere, so a litter reaching every way keeps well under a
  // fifth of its scoops there.
  check(straightOut < scoops * 0.2, `${straightOut} of ${scoops} scoops reach straight out along their limb`)
  const aimed = parallel.default.sum / parallel.default.pairs
  const plain = parallel.plain.sum / parallel.plain.pairs
  check(parallel.default.pairs > 0 && aimed < plain * 0.85, `neighbouring openings are less parallel aimed than not: ${aimed.toFixed(3)} against ${plain.toFixed(3)} over ${parallel.default.pairs} and ${parallel.plain.pairs} pairs`)
  check(offWood === 0, `${scoops} stems on a branch's surface`, worstWood)
  check(stemNear <= reaching * 0.01, `the stem is further from the centre than the other corners in all but ${stemNear} of ${reaching}`)
}

// --- 4. the tiers are one tree ----------------------------------------------
//
// A coarse rung's crown must be the first N scoops of LOD0's crown, vertex for
// vertex: the seats are drawn the same, nothing is re-rolled, and the extent
// that sets the scale is measured over every scoop drawn rather than over
// those kept, so the tiers share one scale to the float.
console.log('--- 4. a coarse tier is a prefix of LOD0, at LOD0\'s scale')
{
  let worst = 0
  let where = ''
  let counts = ''
  for (const shape of SHAPES) {
    for (let s = 0; s < SEEDS; s++) {
      const base = { ...TREE_OAK_DEFAULTS, ...shape.over, seed: 1000 + s }
      const a = buildTreeOak(treeOakLod(base, 0)).foliage.attributes.position.array
      for (let tier = 1; tier < 3; tier++) {
        const p = treeOakLod(base, tier)
        const r = resolveTreeOak(p)
        const b = buildTreeOak(p).foliage.attributes.position.array
        if (b.length !== r.boughs * PER_SCOOP * 3 || b.length > a.length) { counts = counts || `${shape.name} seed ${1000 + s} LOD${tier}: ${b.length / 3} vertices for ${r.boughs} scoops, LOD0 has ${a.length / 3}`; continue }
        for (let i = 0; i < b.length; i++) {
          const d = Math.abs(a[i] - b[i]) / base.height
          if (d > worst) { worst = d; where = `${shape.name} seed ${1000 + s} LOD${tier} float ${i}: ${(d * 100).toFixed(4)}% of height` }
        }
      }
    }
  }
  check(counts === '', 'a coarse tier holds exactly the kept count', counts)
  check(worst < 1e-6, 'every kept vertex is where LOD0 put it', where ? `worst ${where}` : 'to the float')
}

// --- 5. the layouts ---------------------------------------------------------
console.log('--- 5. attribute layouts')
{
  const { trunk, foliage } = buildTreeOak(TREE_OAK_DEFAULTS)
  const keys = (g) => Object.keys(g.attributes).sort().join(',')
  check(keys(trunk) === 'normal,position,texLayer,uvProj', 'wood is createPropMaterial\'s layout', keys(trunk))
  check(keys(foliage) === 'color,normal,position,uv', 'crown is {position, normal, uv, color}', keys(foliage))
  check(foliage.index !== null && foliage.index.count === foliage.attributes.position.count, 'crown carries an identity index')
  const col = foliage.attributes.color.array
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < col.length; i++) { lo = Math.min(lo, col[i]); hi = Math.max(hi, col[i]) }
  check(lo > 0.3 && hi <= 1.4 && lo < hi, 'the shade ramp is a grey in a sane range', `${lo.toFixed(2)}..${hi.toFixed(2)}`)
}

// --- 6. the tree stands at height ------------------------------------------
console.log('--- 6. the rescale lands the crown at height')
{
  let worst = 0
  let where = ''
  let below = 0
  for (const shape of SHAPES) {
    for (let s = 0; s < SEEDS; s++) {
      const p = { ...TREE_OAK_DEFAULTS, ...shape.over, seed: 1000 + s }
      const { stats } = buildTreeOak(p)
      const err = Math.abs(stats.height - p.height) / p.height
      if (err > worst) { worst = err; where = `${shape.name} seed ${1000 + s}: ${stats.height.toFixed(3)} for ${p.height}` }
      if (stats.belowGround > p.height * 0.25) below++
    }
  }
  // The extent is measured on the scoops' own vertices, so LOD0 lands on the
  // height to float noise; a coarse tier can fall short of it by whatever the
  // scoops it dropped reached, and that is section 4's promise, not this one's.
  check(worst < 1e-4, 'LOD0 stands at the height', where)
  check(below === 0, 'no shape puts more than a quarter of its height below ground', `${below} did`)
}

// --- 7. the bank ------------------------------------------------------------
console.log('--- 7. the species bank')
check(['oak', 'aspen', 'birch'].every((name) => treeOakSpecies(name).height > 0 && TREE_OAK_SPECIES[name].mat.startsWith('/trees/mat_')), 'oak, aspen and birch resolve from the bank, each with a mat')
{
  let threw = false
  try { treeOakSpecies('yew') } catch { threw = true }
  check(threw, 'an unknown species throws')
  threw = false
  try { treeOakLod(TREE_OAK_DEFAULTS, 3) } catch { threw = true }
  check(threw, 'tier 3 is not a mesh tier')
}

console.log(failures === 0 ? '\nall oak gates pass' : `\n${failures} oak gate(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
