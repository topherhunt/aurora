// ---------------------------------------------------------------------------
// Generated foliage: trees, bushes and grass, authored rather than converted.
//
// WHY THIS EXISTS. Every tree in `tmp/placeholder-props` arrives as a solid
// polygon mesh and has to be decimated down to budget. That works for a boulder
// and it does not work for a canopy: the collapse decimator will not collapse
// across an open boundary, and card foliage is ~100% boundary, so it either
// stalls thousands of triangles above target or -- worse -- crushes the mesh
// into slivers that still pass a triangle count while presenting 0.1% of their
// own silhouette (DESIGN.md §9, bugs 10 and 11). Four grass variants and two
// trees were excluded for exactly that.
//
// A generator has no such floor, because the budget is an INPUT. We ask for 500
// triangles and get 500 triangles, with alpha cards that were cards from birth
// and never had to survive a decimator. Measured across the presets, the whole
// range 64 -> 20,000 triangles is reachable continuously by parameter.
//
// EZ-Tree (MIT, Daniel Greenheck) does the branch structure. It is a BUILD-TIME
// dependency only -- nothing in `src/` imports it. It ships four leaf atlases
// and four tiling bark sets; we take the leaf atlases (downrezzed to 128^2 by
// `layers.py`) and leave the bark, because at this budget a trunk is a handful
// of quads and its colour belongs in COLOR_0.
//
// It does not run in Node out of the box: it loads its textures eagerly at
// import time through three's TextureLoader, which reaches for `document`. The
// shim below is the whole fix. We never sample those textures here -- we only
// want the geometry -- so a stub image is enough.
//
// OUTPUT is one GLB per tier into `tmp/generated-props/`, which then goes
// through the ordinary Blender pipeline (`build.py`, spec key `tiers`) for AO,
// grounding, the impostor render and the manifest. This script deliberately
// stops short of that: Blender already does all of it correctly for 154 assets
// and none of that work should be reimplemented here.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// --- the shim ---------------------------------------------------------------
//
// three's ImageLoader calls document.createElementNS('img') and sets .src on
// the result. It never renders here, so an object with an addEventListener and
// a settable src satisfies it completely.
globalThis.document = {
  createElementNS(_ns, name) {
    if (name !== 'img') return {}
    return { addEventListener() {}, removeEventListener() {}, set src(v) { this._src = v }, get src() { return this._src } }
  },
  createElement(name) { return this.createElementNS(null, name) },
}
globalThis.self = globalThis

const { Tree } = await import('@dgreenheck/ez-tree')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'tmp/generated-props')

// --- the shared atlas contract ----------------------------------------------
//
// One 128^2 layer per SPECIES, shared by every tier and by every tree of that
// species -- not one per tier per asset, which is what the scan pipeline does
// and which costs `tree_dead_standing` three near-identical 40 KB PNGs.
//
// The bottom PATCH_V of the layer is a solid opaque white block written by
// `layers.py`. Every bark triangle maps to a single texel inside it, which is
// what lets bark and leaves live in ONE primitive against ONE texture: the
// trunk's colour comes entirely from COLOR_0 multiplied by white, the leaves'
// from the atlas. One geometry, one layer, one draw, and check-props.mjs's
// per-LOD "is one primitive" rule still holds.
//
// WHY A QUARTER OF THE LAYER, for a colour that could be one texel. Because the
// atlas mipmaps (src/textures.js sets LinearMipmapLinearFilter + generateMipmaps)
// and a patch adjacent to green leaf art bleeds green into the trunk as the mip
// chain shortens. Bark sits at the patch's CENTRE and the patch is a quarter of
// the height, so bark stays a full patch-quarter from the leaf boundary at every
// mip until the patch itself is under two texels -- a 4x4 mip, by which point
// the tree is a few pixels wide and drawing its impostor anyway. An 8-row patch
// (the obvious choice) goes green at the 32x32 mip, which is well inside the
// range LOD1 actually renders at.
//
// This costs the leaf art 32 of 128 rows. It buys back all of them the day the
// prop runtime adopts createPropMaterial, whose per-vertex `texLayer` attribute
// (src/material.js) lets bark and leaf index DIFFERENT
// array layers from within one primitive -- no patch, no bleed, no shared image.
// The previewer and scatter.js both still use a single-`map` MeshLambertMaterial,
// so that is a later step, not this one.
// ⚠️ V ORIENTATION. Three axes flip between here and the screen and they do not
// cancel. three.js puts v=0 at the BOTTOM of an image; glTF puts it at the TOP,
// and this file writes glTF directly, so every v out of EZ-Tree needs `1 - v`.
// Blender's image rows also start at the bottom, so `layers.py` writing the
// patch into its rows 0..31 puts the patch in the LAST rows of the PNG file --
// which, with the runtime's `flipY = false` (props-main.js, set precisely
// because these UVs are glTF's), is v in [0.75, 1].
//
// So: patch at the BOTTOM of v, art above it, and art top at v=0.
// Getting this wrong is silent -- bark samples leaves and leaves sample white,
// both of which still render -- so it is checked by eye in the preview render,
// not reasoned about and trusted.
const PATCH_V = 0.25                     // patch occupies v in [0.75, 1]
const BARK_UV = [0.5, 1 - PATCH_V / 2]   // dead centre of the patch

// three's v, flipped into glTF's, then squeezed above the patch.
const leafV = (v) => (1 - v) * (1 - PATCH_V)

// --- colour -----------------------------------------------------------------
//
// COLOR_0 is LINEAR everywhere along this chain -- Blender colour attributes,
// the glTF spec, and three's `vertexColors` all agree -- while the tints below
// are written as sRGB because that is the space a human picks a brown in. The
// conversion is not a formality: sRGB 0.30 is linear 0.073, a factor of four,
// and skipping it is exactly the "glowing plastic toy" failure that
// props/shapes.js warns about, where a prop authored in sRGB sits against
// linear-0.05 terrain looking lit from inside.
//
// Calibration check against the procedural placeholders in shapes.js, which are
// already in the world and already read correctly: TRUNK is linear
// (0.036, 0.024, 0.015) and bark below lands at (0.073, 0.040, 0.024), about
// twice as bright, which is right for bark that is meant to catch light rather
// than sit in shadow. Grass BLADE_BASE is (0.022, 0.034, 0.012); the dry grass
// tint through a mid-grey tuft texel lands at roughly (0.03, 0.047, 0.010).
const srgb = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linear = (rgb) => rgb.map(srgb)

// --- species ----------------------------------------------------------------
//
// `height_m` and `class` are the numbers §5's LOD ladder keys off, and they are
// deliberately the same shape as a hand-collected asset's manifest entry so
// that nothing downstream can tell the difference.
//
// `lod_tris` is a BUDGET, not a hope. `tune()` searches for it.
// `leafTint` is deliberately near-white. The leaf atlases are photographic and
// already carry the species' own colour, so a saturated green tint on top
// multiplies green by green and reads as poster paint. What is left for the
// tint to do is small seasonal and species drift -- and, later, an autumn set
// that costs a vector rather than a texture layer. `bark` is the opposite: the
// trunk samples a white patch, so its tint IS its colour.
const SPECIES = [
  { id: 'gen_pine',        preset: 'Pine Medium',  leaf: 'pine',   class: 'large',  height_m: 11.0, lod_tris: [500, 130], bark: [0.30, 0.22, 0.17], leafTint: [0.86, 0.96, 0.80] },
  { id: 'gen_pine_young',  preset: 'Pine Small',   leaf: 'pine',   class: 'large',  height_m: 5.5,  lod_tris: [500, 130], bark: [0.32, 0.24, 0.18], leafTint: [0.92, 1.00, 0.84] },
  { id: 'gen_oak',         preset: 'Oak Medium',   leaf: 'oak',    class: 'large',  height_m: 9.0,  lod_tris: [500, 130], bark: [0.34, 0.28, 0.22], leafTint: [0.94, 1.00, 0.86] },
  { id: 'gen_aspen',       preset: 'Aspen Medium', leaf: 'aspen',  class: 'large',  height_m: 12.0, lod_tris: [500, 130], bark: [0.72, 0.70, 0.64], leafTint: [0.96, 1.00, 0.88] },
  { id: 'gen_ash',         preset: 'Ash Medium',   leaf: 'ash',    class: 'large',  height_m: 10.0, lod_tris: [500, 130], bark: [0.38, 0.34, 0.30], leafTint: [0.90, 0.98, 0.82] },
  // 50, not 40, on Bush 2's low tier: one level of 3-segment branches with one
  // leaf each is 44 triangles and there is nothing left to remove. Budgeting 40
  // would just print a warning on every run.
  { id: 'gen_bush',        preset: 'Bush 2',       leaf: 'aspen',  class: 'medium', height_m: 1.1,  lod_tris: [150, 60],  bark: [0.33, 0.27, 0.20], leafTint: [0.84, 0.94, 0.72] },
  { id: 'gen_bush_berry',  preset: 'Bush 3',       leaf: 'oak',    class: 'medium', height_m: 0.9,  lod_tris: [150, 60],  bark: [0.33, 0.27, 0.20], leafTint: [0.80, 0.92, 0.68] },
]

// --- budget search ----------------------------------------------------------
//
// A triangle spent on a leaf card buys far more tree than a triangle spent on
// branch tube, so the budget is ALLOCATED rather than merely respected.
//
// This is the whole lesson of the first attempt. Driving every knob from one
// "detail" scalar and maximising triangles under budget produced a 484-triangle
// pine that was a bare pole with a dozen sprigs on it: the search had put ~450
// triangles into eleven tapered branch cylinders and left 30 for the canopy.
// Under budget, on target, and not a tree.
//
// Three rules come out of that:
//
//   1. BRANCH TESSELLATION IS PINNED AT THE FLOOR, never searched. A trunk of
//      five sides and a branch of three is the whole N64 vocabulary; ring
//      resolution above that is invisible at any distance a prop is drawn and
//      costs triangles proportional to length. What varies is how many branches
//      there are, not how round each one is.
//   2. BRANCHES GET A FIXED SHARE. `BRANCH_SHARE` of the budget, found by
//      bisection; the remainder goes to leaves. Without a ceiling the branches
//      take everything, because they are what the preset scales first.
//   3. LEAF SIZE GROWS AS LEAF COUNT FALLS. Pine Medium's canopy is 82 branches
//      x 30 leaves = 2,460 cards; ours is ~150. The same crown volume with 6%
//      of the cards is see-through unless each card grows to cover the gap, so
//      the size scales as the square root of the density ratio -- area per card
//      times cards is what fills a silhouette.
const BRANCH_SHARE = 0.4

// How far a card may grow to cover for cards the budget could not buy. This is
// what makes LOD1 lush rather than sparse, so it is generous: at 8x a Pine
// Medium card is ~0.8 m across, a leaf spray rather than a leaf, which is what
// the atlas art is anyway. Not unbounded -- a tier reduced to a handful of cards
// would grow them past the crown they are meant to sit inside, and a billboard
// is the honest answer at that point, not a bigger card.
const MAX_LEAF_SCALE = 8

function build(spec, detail, levels, seed, leafCount = 0, leafScale = 1) {
  const t = new Tree()
  t.loadPreset(spec.preset)
  const o = t.options
  o.seed = seed
  o.branch.levels = levels

  // Rule 1: chosen from the budget, never searched. A trunk wants more than
  // three sides so it does not read as a triangle head-on -- but 5x5 costs 50
  // triangles, which is most of a 130-triangle LOD1 spent before a single leaf,
  // and that is exactly why the low tiers came out as bare sticks. So the
  // trunk's resolution steps down with the budget it has to live inside.
  const trunk = spec.budget >= 400 ? 5 : spec.budget >= 150 ? 4 : 3
  o.branch.segments[0] = trunk
  o.branch.sections[0] = trunk
  for (const k of ['1', '2', '3']) {
    // Three sides and TWO sections -- a straight untapered stub. Not three
    // sections: the extra ring only buys a slight curve along a branch that is
    // covered in leaf cards, and at 18 triangles a branch instead of 12 it buys
    // it by deleting a third of the branches. Branch COUNT is what reads as a
    // conifer; branch curvature is what nobody can see.
    o.branch.segments[k] = 3
    o.branch.sections[k] = 2
  }
  // Branch COUNT is the search variable. Squared, so the scalar has a similar
  // feel across levels that multiply.
  //
  // Weighting the cut toward deeper levels (detail, detail^2, detail^3, on the
  // theory that a primary limb draws more silhouette than a twig) was tried and
  // reverted: the bisection simply solved for a different `detail` and landed on
  // the same branch triangle count, so the oak rendered identically, while the
  // higher level-0 floor cost pine's LOD1 twelve cards. The sparseness is not in
  // how the budget is split across levels.
  for (const k of ['0', '1', '2']) {
    o.branch.children[k] = Math.max(1, Math.round(o.branch.children[k] * detail * detail))
  }

  o.leaves.count = leafCount
  o.leaves.size *= leafScale

  // Single-sided cards halve the leaf cost. The runtime draws props with
  // `side: DoubleSide` already (§5), so a single card is still visible from
  // behind -- paying for a second one buys nothing but triangles.
  o.leaves.billboard = 'single'
  // Flat shading is the look, and it also means the generator's normals survive
  // the trip through Blender without a smoothing pass second-guessing them.
  o.bark.flatShading = true

  t.generate()
  return t
}

// Branch and leaf triangles separately -- the allocator needs to know which is
// which, and the leaf mesh is the one carrying an alphaTest material.
function split(tree) {
  let branch = 0, leaf = 0
  tree.traverse((o) => {
    if (!o.isMesh) return
    const g = o.geometry
    const n = Math.round((g.index ? g.index.count : g.attributes.position.count) / 3)
    if ((o.material?.alphaTest ?? 0) > 0) leaf += n
    else branch += n
  })
  return { branch, leaf, total: branch + leaf }
}

// --- canopy carry-down -------------------------------------------------------
//
// WHY LOWER TIERS DO NOT RE-GROW THEIR CANOPY.
//
// The obvious way to build LOD1 is to run the same search at a smaller budget,
// and that is what this did first. Matching the total leaf AREA across tiers was
// not enough: a pine LOD1 with a quarter of LOD0's branches puts every leaf on
// the four branches it can afford, so the same amount of foliage arrives as two
// dense whorls with a bare leader spiking out of the top. Same lushness, wrong
// tree -- and the transition reads as the crown reassembling itself, which is
// worse than it reading as thin.
//
// So the canopy is CARRIED DOWN instead. LOD0's cards are clustered by position,
// and each cluster collapses to one card: the cluster's own most-central card,
// moved to the cluster centroid and grown by the square root of how many cards
// it stands in for. Three things then hold by construction rather than by tuning:
//
//   crown shape    -- cards only ever appear where LOD0 had cards, so the
//                     silhouette is LOD0's silhouette resampled, not a new one
//   local density  -- area is conserved per CLUSTER, not just in total, so a
//                     thick lower whorl stays thicker than a sparse leader
//   colour balance -- same atlas, same tint, same card aspect; only count changes
//
// It also costs nothing to be exact: the tier gets precisely as many cards as
// its leftover triangles allow, with no search and no measure-to-fixed-point.

// Every leaf EZ-Tree emits with `billboard: 'single'` is one quad -- four
// vertices, indices n,n+1,n+2,n,n+2,n+3 -- so cards can be read straight out of
// the buffer by fours. Verified against the generated mesh rather than assumed.
function readCards(tree) {
  const cards = []
  tree.traverse((o) => {
    if (!o.isMesh || (o.material?.alphaTest ?? 0) <= 0) return
    const g = o.geometry
    const P = g.attributes.position, N = g.attributes.normal, T = g.attributes.uv
    if (P.count % 4 !== 0) throw new Error(`leaf mesh has ${P.count} verts, not a whole number of quads`)
    for (let v = 0; v < P.count; v += 4) {
      const p = [], n = [], uv = [], c = [0, 0, 0]
      for (let k = 0; k < 4; k++) {
        const i = v + k
        p.push(P.getX(i), P.getY(i), P.getZ(i))
        n.push(N.getX(i), N.getY(i), N.getZ(i))
        uv.push(T.getX(i), T.getY(i))
        c[0] += P.getX(i) / 4; c[1] += P.getY(i) / 4; c[2] += P.getZ(i) / 4
      }
      cards.push({ p, n, uv, c })
    }
  })
  return cards
}

// Deterministic: the whole pipeline is reproducible from a species id, and a
// canopy that reshuffles between builds would make every diff meaningless.
function lcg(seed) {
  let s = seed >>> 0 || 1
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

// Lloyd's algorithm, k-means++ seeding. Plain spatial binning was the cheaper
// option and it is the wrong one: a fixed grid cuts a crown at cell walls rather
// than where the foliage actually clumps, so a card lands in the gap between two
// whorls -- somewhere LOD0 has nothing.
function mergeCards(cards, n, seed) {
  if (n >= cards.length) return cards
  const rand = lcg(seed)

  const cent = [cards[Math.floor(rand() * cards.length)].c.slice()]
  while (cent.length < n) {
    // Farthest-first with a random draw weighted by distance: pure random
    // seeding leaves whole limbs unrepresented at these small counts.
    const d = cards.map((c) => Math.min(...cent.map((m) => dist2(c.c, m))))
    const total = d.reduce((a, b) => a + b, 0)
    if (total <= 0) break
    let r = rand() * total, pick = 0
    while (pick < d.length - 1 && (r -= d[pick]) > 0) pick++
    cent.push(cards[pick].c.slice())
  }

  let owner = new Array(cards.length).fill(0)
  for (let iter = 0; iter < 12; iter++) {
    let moved = false
    for (let i = 0; i < cards.length; i++) {
      let bi = 0, bd = Infinity
      for (let k = 0; k < cent.length; k++) {
        const d = dist2(cards[i].c, cent[k])
        if (d < bd) { bd = d; bi = k }
      }
      if (owner[i] !== bi) { owner[i] = bi; moved = true }
    }
    if (!moved && iter > 0) break
    const sum = cent.map(() => [0, 0, 0, 0])
    for (let i = 0; i < cards.length; i++) {
      const s = sum[owner[i]]
      s[0] += cards[i].c[0]; s[1] += cards[i].c[1]; s[2] += cards[i].c[2]; s[3]++
    }
    for (let k = 0; k < cent.length; k++) {
      if (sum[k][3]) cent[k] = [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]]
    }
  }

  const out = []
  for (let k = 0; k < cent.length; k++) {
    const members = cards.filter((_, i) => owner[i] === k)
    if (!members.length) continue   // k-means++ can strand a centroid; drop it rather than emit a degenerate card

    // The most central MEMBER, not a synthetic average: averaging four corners
    // across cards of different orientations collapses the quad toward its own
    // centre and the card comes out shrunken and skewed.
    let rep = members[0], bd = Infinity
    for (const m of members) {
      const d = dist2(m.c, cent[k])
      if (d < bd) { bd = d; rep = m }
    }

    // Grow about the representative's own centre by sqrt(members), then move
    // that centre onto the cluster's. Area x count is what fills a silhouette,
    // so sqrt(count) is exactly the factor that conserves the area this one card
    // is now responsible for.
    const g = Math.sqrt(members.length)
    const p = []
    for (let v = 0; v < 4; v++) {
      for (let a = 0; a < 3; a++) {
        p.push(cent[k][a] + (rep.p[v * 3 + a] - rep.c[a]) * g)
      }
    }
    out.push({ p, n: rep.n, uv: rep.uv, c: cent[k].slice() })
  }
  return out
}

// Grow the canopy into whatever the branches left over.
//
// Measured to a fixed point rather than computed, because `leaves.count` is not
// simply cards-per-branch: which branches bear leaves depends on `levels` and
// on `leaves.start`, and the arithmetic estimate came out roughly half right
// (an oak asked for 155 cards and got 78, landing at 346 of a 500 budget). One
// probe plus a handful of proportional corrections converges without needing to
// know the rule, and each step is a generate that already gets measured anyway.
function fillLeaves(spec, detail, levels, seed, budget, branchTris) {
  const room = Math.max(0, budget - branchTris)
  const probe = split(build(spec, detail, levels, seed, 1))
  const perCount = Math.max(2, probe.leaf)         // leaf triangles at count = 1

  let count = Math.max(1, Math.floor(room / perCount))
  let best = count
  for (let i = 0; i < 8; i++) {
    const got = split(build(spec, detail, levels, seed, count)).leaf
    if (got <= room) best = Math.max(best, count)
    if (got === 0) break
    const next = Math.max(1, Math.round(count * (room / got)))
    if (next === count) break
    count = next
  }
  // The loop tracks the largest count seen UNDER budget, but its last probe may
  // have been over; re-walk down from the best to guarantee the returned count
  // actually fits, since nothing downstream re-checks it.
  while (best > 1 && split(build(spec, detail, levels, seed, best)).leaf > room) best--

  // Rule 3, and this is what keeps a distant tree from reading as skeletal.
  //
  // `baseline` is the preset's own card total at the preset's own branch count
  // -- the density its author chose. Scaling each card by the square root of how
  // far below that we land means cards x card-area comes out CONSTANT, so every
  // tier of a species covers the same crown with the same total leaf area: LOD1
  // holds a third of LOD0's cards at 1.7x the width. That is deliberate and it
  // is the whole defence against a tree that thins out at range and then pops
  // back to full foliage as you walk up to it. The tiers are not each tuned to
  // look good on their own; they are tuned to the same number.
  //
  // Leaf-to-branch RATIO holds across tiers for the same reason one level up:
  // BRANCH_SHARE is a fraction of the budget, not an absolute, so a 130-triangle
  // tier splits 40/60 exactly like a 500-triangle one.
  //
  // The clamp is the one thing that can break the invariant, so when it binds it
  // is REPORTED rather than silently applied -- a clamped tier is precisely the
  // tier that ends up thinner than the one above it, and the place to find that
  // out is a build log, not a headset.
  const base = new Tree()
  base.loadPreset(spec.preset)
  const baseline = base.options.leaves.count * Object.values(base.options.branch.children).reduce((a, b) => a + b, 0)
  const cards = Math.max(1, split(build(spec, detail, levels, seed, best)).leaf / 2)
  const wantScale = Math.max(1, Math.sqrt(baseline / cards))
  const scale = Math.min(MAX_LEAF_SCALE, wantScale)

  return { count: best, scale, cards, wantScale }
}

// Bisect branch COUNT until branches take their share of the budget, then fill.
// Two nested certainties instead of one search over everything: the branch
// scalar is monotonic in branch triangles, and the leaf count is exact once the
// branch cost is known.
function fitBranches(spec, budget, levels, seed) {
  const want = budget * BRANCH_SHARE
  let lo = 0.05, hi = 1.6, best = null
  for (let i = 0; i < 20 && hi - lo > 1e-3; i++) {
    const mid = (lo + hi) / 2
    const b = split(build(spec, mid, levels, seed)).branch
    if (b <= want) { best = { detail: mid, branch: b }; lo = mid } else hi = mid
  }
  // Nothing fit the share -- take the floor and let the leaf fill absorb it,
  // which is the right answer for a 40-triangle bush where one branch already
  // costs more than 40% of the budget.
  if (!best) best = { detail: 0.05, branch: split(build(spec, 0.05, levels, seed)).branch }
  return best
}

function attempt(spec, budget, levels, seed) {
  const best = fitBranches(spec, budget, levels, seed)
  const { count, scale, cards, wantScale } = fillLeaves(spec, best.detail, levels, seed, budget, best.branch)
  const tree = build(spec, best.detail, levels, seed, count, scale)
  // `area` is this tier's total card area as a fraction of the preset's own, so
  // 1.0 means it covers exactly the crown the preset's author drew and every
  // tier at 1.0 covers the same crown as every other. It falls below 1 only when
  // the scale clamp bit, so it is the single number that answers "does this tree
  // thin out at range", and it is carried out of the search rather than recomputed.
  const area = (scale * scale) / (wantScale * wantScale)
  return { tree, detail: best.detail, levels, leafCount: count, leafScale: scale, cards, area, ...split(tree) }
}

// Try each branching depth from the preset's own down to one and keep the tree
// with the most CANOPY that still fits -- not the most triangles. Leaf area is
// what a tree reads as at 30 m; branch count is what it costs.
function tune(spec, budget, seed) {
  spec = { ...spec, budget }   // `build` picks its trunk resolution off this
  const base = new Tree()
  base.loadPreset(spec.preset)

  let best = null
  for (let levels = base.options.branch.levels; levels >= 1; levels--) {
    const r = attempt(spec, budget, levels, seed)
    if (r.total <= budget && (!best || r.leaf > best.leaf)) best = r
  }
  if (best) return { ...best, over: false }

  // Every depth overshoots even at the floor. Say so rather than shipping a
  // tier that quietly misses its budget -- that is the lie the decimator told.
  const r = attempt(spec, budget, 1, seed)
  return { ...r, over: true }
}

// A lower tier: branches only, canopy carried down from LOD0.
//
// `levels` is pinned to 1 rather than searched, and that is the one place this
// spends a triangle on purpose. Sub-branches are hidden under a merged canopy at
// every range this tier is drawn at, so buying depth here would buy geometry
// nobody can see with triangles the canopy needs.
function lowerTier(spec, budget, seed, lod0Cards) {
  spec = { ...spec, budget }
  const fit = fitBranches(spec, budget, 1, seed)
  const tree = build(spec, fit.detail, 1, seed)
  const branch = split(tree).branch
  const n = Math.max(1, Math.floor((budget - branch) / 2))
  const cards = mergeCards(lod0Cards, n, seed)
  return {
    tree, cards, levels: 1, detail: fit.detail,
    branch, leaf: cards.length * 2, total: branch + cards.length * 2,
    over: branch + cards.length * 2 > budget,
  }
}

// --- geometry ---------------------------------------------------------------
//
// Merge the two meshes EZ-Tree emits (opaque branches, alpha-tested leaves)
// into one indexed buffer. Bark loses its UVs to the opaque patch and carries
// the species' bark colour in COLOR_0; leaves keep theirs, remapped past the
// patch, and carry a near-white tint so the atlas reads through unmodified.
//
// Deliberately NOT welded here. Blender welds and re-grounds every tier in
// `build_asset`, and doing it twice with two different epsilons is how you get
// a mesh that measures differently than it renders.
function extract(tree, spec, cards = null) {
  const pos = [], nrm = [], uv = [], col = [], idx = []
  let base = 0

  tree.traverse((o) => {
    if (!o.isMesh) return
    const g = o.geometry
    const isLeaf = (o.material?.alphaTest ?? 0) > 0
    // A lower tier brings its canopy with it (see the carry-down note above), so
    // the tree's own leaf mesh -- grown with leafCount 0, and empty -- is skipped
    // outright rather than merged and then hoped to be empty.
    if (isLeaf && cards) return
    const P = g.attributes.position, N = g.attributes.normal, T = g.attributes.uv
    if (!P || !N || !T) throw new Error(`${spec.id}: mesh "${o.name}" is missing position/normal/uv`)

    const tint = linear(isLeaf ? spec.leafTint : spec.bark)
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i))
      nrm.push(N.getX(i), N.getY(i), N.getZ(i))
      if (isLeaf) uv.push(T.getX(i), leafV(T.getY(i)))
      else uv.push(BARK_UV[0], BARK_UV[1])
      col.push(tint[0], tint[1], tint[2])
    }

    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i))
    else for (let i = 0; i < P.count; i++) idx.push(base + i)
    base += P.count
  })

  if (cards) {
    const tint = linear(spec.leafTint)
    for (const c of cards) {
      for (let v = 0; v < 4; v++) {
        pos.push(c.p[v * 3], c.p[v * 3 + 1], c.p[v * 3 + 2])
        nrm.push(c.n[v * 3], c.n[v * 3 + 1], c.n[v * 3 + 2])
        uv.push(c.uv[v * 2], leafV(c.uv[v * 2 + 1]))
        col.push(tint[0], tint[1], tint[2])
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      base += 4
    }
  }

  return { pos, nrm, uv, col, idx }
}

// --- GLB --------------------------------------------------------------------
//
// Hand-rolled, ~60 lines, because three's GLTFExporter wants a canvas to
// re-encode textures with and there are no textures to encode: the atlas ships
// as a separate layer PNG (§9) and the GLB carries no image at all. Pulling in
// a headless-canvas native dependency to write a file that has no images in it
// would be the wrong trade.
function writeGlb(file, geo) {
  const pos = new Float32Array(geo.pos)
  const nrm = new Float32Array(geo.nrm)
  const uv = new Float32Array(geo.uv)
  const col = new Float32Array(geo.col)
  const vcount = pos.length / 3
  const idx = vcount > 65535 ? new Uint32Array(geo.idx) : new Uint16Array(geo.idx)

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (pos[i + c] < min[c]) min[c] = pos[i + c]
      if (pos[i + c] > max[c]) max[c] = pos[i + c]
    }
  }

  const views = [], accessors = []
  let offset = 0
  const chunks = []
  const add = (arr, target, type, componentType, extra = {}) => {
    // glTF requires each bufferView to start on a multiple of its component
    // size. Everything here is 4-byte or 2-byte, so pad to 4 and be done.
    const pad = (4 - (offset % 4)) % 4
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad }
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target })
    accessors.push({ bufferView: views.length - 1, componentType, count: extra.count, type, ...extra.bounds })
    chunks.push(buf)
    offset += buf.length
    return accessors.length - 1
  }

  const aPos = add(pos, 34962, 'VEC3', 5126, { count: vcount, bounds: { min, max } })
  const aNrm = add(nrm, 34962, 'VEC3', 5126, { count: vcount })
  const aUv = add(uv, 34962, 'VEC2', 5126, { count: vcount })
  const aCol = add(col, 34962, 'VEC3', 5126, { count: vcount })
  const aIdx = add(idx, 34963, 'SCALAR', idx.BYTES_PER_ELEMENT === 4 ? 5125 : 5123, { count: idx.length })

  const bin = Buffer.concat(chunks)
  const json = {
    asset: { version: '2.0', generator: 'aurora tools/trees/generate.mjs' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: aPos, NORMAL: aNrm, TEXCOORD_0: aUv, COLOR_0: aCol }, indices: aIdx }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors,
  }

  const jsonBuf = Buffer.from(JSON.stringify(json))
  const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)   // spaces
  const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4, 0)
  const jsonChunk = Buffer.concat([jsonBuf, jsonPad])
  const binChunk = Buffer.concat([bin, binPad])

  const header = Buffer.alloc(12)
  header.write('glTF', 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)

  const jsonHdr = Buffer.alloc(8)
  jsonHdr.writeUInt32LE(jsonChunk.length, 0)
  jsonHdr.writeUInt32LE(0x4E4F534A, 4)
  const binHdr = Buffer.alloc(8)
  binHdr.writeUInt32LE(binChunk.length, 0)
  binHdr.writeUInt32LE(0x004E4942, 4)

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([header, jsonHdr, jsonChunk, binHdr, binChunk]))
  return { bytes: fs.statSync(file).size, verts: vcount, tris: idx.length / 3 }
}

// --- grass ------------------------------------------------------------------
//
// Three crossed quads, then two, then one. This is the whole asset: EZ-Tree's
// own grass tuft is 6 triangles and 12 vertices, and there is no version of
// "better" here that is not just a different texture. Built by hand rather than
// lifted from `grass.glb` because the tiers below LOD0 have to be authored
// anyway, and three cards at three counts is nine lines.
//
// The texture is greyscale, so COLOR_0 sets the colour: one layer serves dry,
// lush, autumn and frosted without a second byte of atlas.
function crossQuads(n, srgbTint) {
  const tint = linear(srgbTint)
  const pos = [], nrm = [], uv = [], col = [], idx = []
  for (let q = 0; q < n; q++) {
    const a = (Math.PI * q) / n
    const dx = Math.cos(a) * 0.5, dz = Math.sin(a) * 0.5
    // Normal is the card's own plane normal; the runtime lights foliage with a
    // hemisphere fill, so a horizontal normal on a vertical card reads fine and
    // an up-normal would flatten the tuft into a disc.
    const nx = -Math.sin(a), nz = Math.cos(a)
    const b = pos.length / 3
    pos.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 1, -dz)
    for (let i = 0; i < 4; i++) { nrm.push(nx, 0, nz); col.push(tint[0], tint[1], tint[2]) }
    // Full 0..1 in v, not the leafV remap: the grass layer has no bark patch to
    // dodge (see layers.py), so a card gets all 128 rows of the tuft. Still
    // flipped -- the card's top vertices want the image's top, which is v=0.
    uv.push(0, 1, 1, 1, 1, 0, 0, 0)
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  return { pos, nrm, uv, col, idx }
}

const GRASS = [
  { id: 'gen_grass_tall',  class: 'small', height_m: 0.55, cards: [3, 2, 1], tint: [0.42, 0.52, 0.24] },
  { id: 'gen_grass_dry',   class: 'small', height_m: 0.40, cards: [3, 2, 1], tint: [0.60, 0.56, 0.30] },
  { id: 'gen_grass_lush',  class: 'small', height_m: 0.35, cards: [3, 2, 1], tint: [0.30, 0.50, 0.20] },
]

// --- main -------------------------------------------------------------------

// Clear only the tiers, not the directory: `layers.py` stages its atlases in
// here too, and this script has no business deleting them -- the two halves run
// in either order.
fs.mkdirSync(OUT, { recursive: true })
for (const f of fs.readdirSync(OUT)) {
  if (f.endsWith('.glb')) fs.rmSync(path.join(OUT, f))
}

const specs = []

for (const spec of SPECIES) {
  const seed = [...spec.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0
  const tiers = []
  let lod0Cards = null
  for (let i = 0; i < spec.lod_tris.length; i++) {
    const budget = spec.lod_tris[i]
    const t = i === 0 ? tune(spec, budget, seed) : lowerTier(spec, budget, seed, lod0Cards)
    if (i === 0) {
      lod0Cards = readCards(t.tree)
      if (!lod0Cards.length) throw new Error(`${spec.id}: LOD0 grew no leaf cards, nothing to carry down`)
      // Area per card is uniform within a tier (one `leaves.size`), so LOD0's
      // card count IS its crown, and every lower tier conserves it per cluster.
      t.cards = lod0Cards.length
      t.area = 1
    }
    const file = path.join(OUT, `${spec.id}_LOD${i}.glb`)
    const r = writeGlb(file, extract(t.tree, spec, i === 0 ? null : t.cards))
    if (t.over) console.log(`WARN ${spec.id} LOD${i}: floor is ${r.tris} tris, budget was ${budget}`)
    console.log(`  ${spec.id.padEnd(16)} LOD${i} ${String(r.tris).padStart(4)}/${String(budget).padEnd(4)} tris`
      + `  ${String(t.branch).padStart(3)} branch + ${String(t.leaf).padStart(3)} leaf`
      + `  ${String(r.verts).padStart(4)} verts  lv${t.levels}`
      + `  ${String(i === 0 ? t.cards : t.cards.length).padStart(3)} cards`
      + (i === 0 ? `  x${t.leafScale.toFixed(1)} grown` : `  merged from ${lod0Cards.length}`)
      + `  ${(r.bytes / 1024).toFixed(1)} KB`)
    tiers.push(path.relative(ROOT, file))
  }
  specs.push({
    id: spec.id, class: spec.class, height_m: spec.height_m, tiers, lod_tris: spec.lod_tris,
    shared_layer: `layers/leaf_${spec.leaf}.png`,
    shared_layer_src: path.relative(ROOT, path.join(OUT, `layers/leaf_${spec.leaf}.png`)),
  })
}

for (const g of GRASS) {
  const tiers = []
  for (let i = 0; i < g.cards.length; i++) {
    const file = path.join(OUT, `${g.id}_LOD${i}.glb`)
    const r = writeGlb(file, crossQuads(g.cards[i], g.tint))
    console.log(`  ${g.id.padEnd(16)} LOD${i}  ${String(r.tris).padStart(4)} tris        ${String(r.verts).padStart(5)} verts  ${g.cards[i]} card(s)   ${(r.bytes / 1024).toFixed(1)} KB`)
    tiers.push(path.relative(ROOT, file))
  }
  specs.push({
    id: g.id, class: g.class, height_m: g.height_m, tiers, lod_tris: g.cards.map((c) => c * 2),
    shared_layer: 'layers/grass_tuft.png',
    shared_layer_src: path.relative(ROOT, path.join(OUT, 'layers/grass_tuft.png')),
  })
}

fs.writeFileSync(path.join(OUT, 'generated.json'), JSON.stringify(specs, null, 2))
console.log(`\n${specs.length} generated assets -> ${path.relative(ROOT, OUT)}/generated.json`)
