import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'

// ---------------------------------------------------------------------------
// A PINE WHOSE FOLIAGE IS ONE WIDE RUMPLED SHEET PER BRANCH. The bench is
// /gen-tree-v4; nothing in the shipped forest imports this.
//
// Same premise as props/tree-voxel.js -- opaque geometry instead of an
// alpha-tested cutout, so the draw keeps its low-resolution-Z -- and a
// different unit. tree-voxel spends one triangle per LEAF, which reads as a
// crown of individually legible darts. Here the unit is a whole branch's worth
// of needles, and there is no branch geometry at all: the wood a frond would
// hang on is never visible through its own needles, so it is not built.
//
// THE SHAPE, and it is the whole file. A frond is a SPINE of vertices walking
// out from the trunk, crooked -- each segment turns from the one before it, so
// the frond is warped rather than straight, and one signed curve per frond
// decides whether it droops further or lifts its tip. The spine is a line to
// hang geometry on, never a limb.
//
// Out from every spine vertex STRICTLY INSIDE the spine, one HEM vertex to
// either side, swung well below the frond and reaching out most of a frond's
// length -- so a frond is a wide, deep, two-sided sheet that OVERLAPS its
// neighbours, and a branch reads as a mass rather than as a blade. Both ends of
// the spine are bare: the root is buried in the crown, and the tip closes on a
// single vertex, so a frond comes to a point the way a needle spray does
// instead of ending in a blunt hem. The two strips of triangles between spine
// and hem are the frond, and they are all the geometry there is.
//
// THE HEM IS RUMPLED, NOT SERRATED. Every hem vertex takes its own drop angle
// and its own reach, and is then shoved along all three local axes -- fore and
// aft along the spine, in and out, up and down. The up-down shove ALTERNATES
// sign along the chain, because two neighbouring hem vertices at the same
// height leave the triangles between them flat to each other; its size and the
// other two axes stay random, so what comes out is a crease everywhere and a
// pattern nowhere.
//
// Vertex count follows the frond's own LENGTH and follows it steeply, so the
// long fronds at the bottom of the crown get every vertex and the short ones
// near the leader fall to the floor of three -- one hem vertex a side, four
// triangles, and never less than that. Their hems are still sized off the
// crown, not off themselves, or the leader thins into sky.
//
// Nothing closes underneath; solid here means the MATERIAL is opaque, with no
// alpha channel and no discard, not that the surface is a sealed body.
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180

export const CLOAK_PINE_DEFAULTS = {
  seed: 7,
  height: 9,               // metres, root to tip. Everything below is a
                           // fraction of it unless the comment says metres.

  // --- trunk ---------------------------------------------------------------
  //
  // The radius ratio is props/tree.js's pine, so the two trees stand on the
  // same trunk. The top ring closes to a POINT, the way that cone does, and the
  // last segment is one triangle per side rather than two.
  trunkRadius: 0.026,      // base radius as a fraction of height
  trunkSides: 5,
  trunkSegs: 3,
  trunkTaper: 0.16,
  trunkKink: 0.011,        // sideways step a node may take, fraction of height
  barkTile: 1.1,           // metres of bark per tile, the same both ways round

  // --- where the fronds sit -------------------------------------------------
  //
  // Placement is props/tree-voxel.js's, trimmed: no whorls and no sub-branches,
  // just a count of fronds stratified up the crown and jittered off their slots.
  firstBranch: 0.17,
  branchCount: 34,
  branchJitter: 0.8,       // fraction of a slot a frond may slide off it
  branchLength: 0.34,      // longest frond, as a fraction of height
  branchMin: 0.34,         // shortest, as a fraction of the longest
  crownPeak: 0.06,         // where up the crown the longest frond sits
  crownFullness: 0.95,     // falloff from that peak. 1 is a straight-sided cone
                           // -- the triangle a pine is meant to read as; above
                           // it the sides go concave and the leader thins out
                           // into sky, below it the crown bulges

  // --- the spine ------------------------------------------------------------
  //
  // Vertex count follows the frond's own length, so the long fronds at the
  // bottom of the crown are the detailed ones and the short ones near the
  // leader cost two vertices and two triangles.
  spineMax: 6,             // branch vertices on the longest frond
  spineMin: 3,             // and on the shortest, which is also a hard floor:
                           // three is one hem vertex a side and four triangles
  spineFalloff: 1.5,       // exponent on that ramp. >1 keeps the maximum for
                           // the longest fronds only, which is where the
                           // silhouette is -- a triangle at the leader covers a
                           // fraction of the pixels one at the skirt does
  branchPitch: 8,          // degrees below horizontal a frond leaves the trunk
  branchPitchTop: 34,      // and how much more of that at the leader -- the
                           // fronds near the tip hang, they do not reach
  spineCurve: 5,           // degrees a segment turns from the one before it.
                           // ONE SIGN PER FROND: negative curls the tip down,
                           // positive lifts it, and the mix is what stops the
                           // crown reading as one rule applied 34 times.
  spineKink: 6,            // degrees of extra random turn per segment, in both
                           // pitch and yaw -- the crooked in "crooked branch"

  // --- the hem --------------------------------------------------------------
  //
  // One vertex either side of every spine vertex STRICTLY INSIDE the spine --
  // the root is buried and the tip closes to a point. `fringe*` says where the
  // vertex goes: how far under the frond it swings and how far out it reaches.
  // Both are generous, because a frond has to overlap its neighbours before a
  // branch reads as a mass rather than as a blade.
  fringeDropMin: 34,       // degrees below the frond's own plane
  fringeDropMax: 62,
  fringeWide: 0.55,        // reach where the frond meets the trunk, as a
                           // fraction of the length the hem is sized off
  fringeTip: 0.16,         // and at its tip
  fringeVary: 0.34,        // per-vertex roll on that reach
  fringeFloor: 0.45,       // that length is the frond's own, but never less
                           // than this much of the crown's longest. It is what
                           // fills the leader: a short frond up there scaled
                           // purely off itself is a sliver with sky round it
  // THE RUMPLE, and it is the difference between needles and a pinking shear.
  // Every hem vertex is shoved along all three local axes -- along the spine,
  // in and out, up and down -- by up to this fraction of its own reach. Roll
  // the reach alone and the hem is a sawtooth: still regular, just uneven.
  // Up-and-down is the half that matters, since it is the only one that lets a
  // hem vertex climb ABOVE its spine and break the frond out of one plane, and
  // it is the one the alternating fold guarantees.
  hemRumple: 0.5,

  // --- the leader -----------------------------------------------------------
  apexCount: 2,            // short fronds at the very top
  apexPitch: 65,           // degrees below horizontal, so the tip is a spray
                           // pointing down rather than a bare spike
  apexLength: 0.10,        // their length, as a fraction of height

  // --- shading (baked into vertex colour) ----------------------------------
  //
  // Deliberately mild: the light in the scene does the shading, and this is
  // only the palette it works on.
  //
  // THESE NUMBERS ARE LINEAR-LIGHT, AND THEY ARE MEASURED. A colour attribute
  // is handed to the shader as linear with no conversion, while a texture is
  // decoded from sRGB first -- so a triple picked to look right in a colour
  // picker renders about twice as bright as it looks, which is what put this
  // crown well above /gen-tree's. `needleMid` is instead the opaque mean of
  // trees/spray_pine.png, the tile /gen-tree's needles wear, converted to
  // linear: that is the colour a crown of those cards averages to, so matching
  // it is the whole of matching /gen-tree.
  needleDark: [0.047, 0.074, 0.011],   // deep in the crown, in shade
  needleMid: [0.104, 0.165, 0.023],    // the body of the canopy
  needleTip: [0.170, 0.238, 0.045],    // this season's growth at a frond's end
  depthShade: 0.45,        // how far toward `needleDark` a buried vertex goes
  heightLift: 0.10,        // extra light on the top of the crown
  tipRun: 0.60,            // how much of a frond's length the tip colour runs
  hueVary: 0.08,           // per-frond colour roll
  leafPatch: 0.55,         // metres of needle tile per tile, both ways round
}

/**
 * Pine only. The other three are a table entry each once the shape is settled;
 * the open question this file exists to answer is a conifer's.
 */
export const CLOAK_SPECIES = {
  pine: { label: 'pine', tile: 'trees/leaf_pine_solid.png', params: {} },
}

/** The full parameter set for a species, pine defaults underneath. */
export function cloakSpecies(name) {
  const sp = CLOAK_SPECIES[name]
  if (!sp) throw new Error(`no cloak species "${name}" -- have ${Object.keys(CLOAK_SPECIES).join(', ')}`)
  return { ...CLOAK_PINE_DEFAULTS, ...sp.params }
}

const lerp = (a, b, t) => a + (b - a) * t
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const clamp01 = (x) => Math.min(1, Math.max(0, x))

/**
 * Build one fringed pine.
 *
 * @param {object} params  CLOAK_PINE_DEFAULTS, overridden
 * @returns {{geometry: THREE.BufferGeometry, stats: object}} geometry carries
 *   position / normal / color / uvProj / texLayer. The TRUNK is indexed first,
 *   so `stats.woodIndices` splits the buffer into the two material groups; it
 *   is also the only wood there is.
 */
export function buildCloakPine(params = {}, barkLayer = 0) {
  const p = { ...CLOAK_PINE_DEFAULTS, ...params }
  const rng = mulberry32((p.seed | 0) * 2654435761 % 2147483647 || 12345)
  const rand = (a, b) => a + (b - a) * rng()
  const h = p.height
  const crownBase = p.firstBranch * h
  const crownTop = h

  // --- the trunk -----------------------------------------------------------
  const trunkPts = []
  {
    let x = 0, z = 0
    for (let i = 0; i <= p.trunkSegs; i++) {
      const t = i / p.trunkSegs
      trunkPts.push([x, t * h, z])
      const step = p.trunkKink * h * (0.4 + t)
      x += rand(-1, 1) * step
      z += rand(-1, 1) * step
    }
  }
  const trunkAt = (y) => {
    const f = Math.min(p.trunkSegs - 1e-6, Math.max(0, (y / h) * p.trunkSegs))
    const i = Math.min(p.trunkSegs - 1, Math.floor(f)), k = f - i
    return [lerp(trunkPts[i][0], trunkPts[i + 1][0], k), y,
            lerp(trunkPts[i][2], trunkPts[i + 1][2], k)]
  }
  const trunkRadiusAt = (y) => p.trunkRadius * h * lerp(1, p.trunkTaper, clamp01(y / h))

  // --- the fronds ----------------------------------------------------------
  //
  // Built whole -- spine and fringe -- before anything is emitted, because the
  // crown's radius profile is measured off the FRINGE and the colour ramp reads
  // depth against that profile.
  const longest = p.branchLength * h
  const fronds = []

  /**
   * One frond: a crooked spine walked out from `base`, and a rumpled hem to
   * either side of it. A hem chain runs from spine vertex 1 to n-2 -- BOTH ENDS
   * of the spine are bare. The root end is buried in the crown, and the tip end
   * closes on a single vertex so a frond ends in a point rather than in a blunt
   * two-vertex hem, which is what a needle spray does.
   *
   * Three spine vertices is the floor, and it is a hard floor: that is one hem
   * vertex per side, two triangles per side, and a frond that still reads as a
   * frond. Below it there is nothing to hang a hem on.
   */
  function growFrond(base, yaw, length, pitchDeg, count) {
    const n = Math.max(3, count | 0)
    const step = length / (n - 1)
    // One signed curve for the whole frond, so a frond commits to drooping or
    // to lifting its tip instead of wandering.
    const curve = rand(-1, 1) * p.spineCurve * DEG
    let pitch = -pitchDeg * DEG
    let dir = [Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)]
    let cur = base.slice()
    const spine = [cur.slice()]
    for (let i = 1; i < n; i++) {
      cur = [cur[0] + dir[0] * step, cur[1] + dir[1] * step, cur[2] + dir[2] * step]
      spine.push(cur.slice())
      pitch += curve + rand(-1, 1) * p.spineKink * DEG
      yaw += rand(-1, 1) * p.spineKink * DEG
      dir = [Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)]
    }

    // THE HEM. One vertex per side per spine vertex strictly inside the spine,
    // swung under the frond on the horizontal square to it, then rumpled: its
    // own drop, its own reach, and a shove along all three local axes.
    //
    // The hem is sized off a length no shorter than `fringeFloor` of the crown's
    // longest frond, so the short fronds near the leader still carry a hem worth
    // seeing. Scale it by the frond's own length alone and the top of the tree
    // is a handful of slivers with sky between them.
    const left = [], right = []
    const reachLen = Math.max(length, p.fringeFloor * longest)
    for (const sign of [1, -1]) {
      const chain = sign > 0 ? left : right
      // THE FOLD, and it is why this alternates rather than rolling free: two
      // hem vertices that happen to land at the same height leave the triangles
      // between them flat to each other, which is the one thing a needle mass
      // must never look like. The SIGN of the up-down shove flips every vertex
      // so there is always a crease; its size, and both other axes, stay
      // random, so the fold is not a sawtooth.
      let fold = rng() < 0.5 ? 1 : -1
      for (let i = 1; i + 1 < n; i++) {
        const s = i / (n - 1)
        const tan = norm(sub(spine[i], spine[i - 1]))
        const side = norm(cross(tan, Math.abs(tan[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
        const drop = rand(p.fringeDropMin, p.fringeDropMax) * DEG
        const L = reachLen * lerp(p.fringeWide, p.fringeTip, s) * rand(1 - p.fringeVary, 1 + p.fringeVary)
        const d = [side[0] * sign * Math.cos(drop),
                   side[1] * sign * Math.cos(drop) - Math.sin(drop),
                   side[2] * sign * Math.cos(drop)]
        const r = p.hemRumple * L
        // The along-spine shove is bounded by the spine's own step, because two
        // hem vertices that swap places bowtie the strip between them. A hem is
        // rumpled, not scrambled: it still runs out the frond in order.
        const along = rand(-1, 1) * Math.min(r, 0.45 * len(sub(spine[i], spine[i - 1])))
        const out = rand(-1, 1) * r
        const up = fold * rand(0.4, 1) * r
        fold = -fold
        const P = [spine[i][0] + d[0] * L + tan[0] * along + side[0] * out,
                   spine[i][1] + d[1] * L + tan[1] * along + side[1] * out + up,
                   spine[i][2] + d[2] * L + tan[2] * along + side[2] * out]
        // `s` is nudged with the vertex so the tip colour and the tile follow
        // the hem where it wandered rather than where it was meant to be.
        chain.push({ P, s: clamp01(s + along / Math.max(1e-4, length)), lat: sign })
      }
    }
    fronds.push({ spine, left, right, n, length, hue: rand(-1, 1) * p.hueVary })
  }

  const slot = (crownTop - crownBase) / p.branchCount
  for (let b = 0; b < p.branchCount; b++) {
    const y = Math.min(crownTop - 0.02, Math.max(crownBase,
      crownBase + (b + 0.5 + rand(-1, 1) * p.branchJitter) * slot))
    const t = clamp01((y - crownBase) / (crownTop - crownBase))
    const yaw = b * 2.399963 + rand(-0.4, 0.4)
    const d = Math.abs(t - p.crownPeak) / Math.max(1e-3, 1 - p.crownPeak)
    const shape = Math.pow(Math.max(0, 1 - d), p.crownFullness)
    const length = longest * lerp(p.branchMin, 1, shape) * rand(0.84, 1.12)
    // Vertex count follows LENGTH, not height, and follows it steeply: only a
    // full-length frond at the skirt earns the maximum, and a short one near
    // the leader falls to the floor of three.
    const count = Math.max(3, Math.round(lerp(p.spineMin, p.spineMax,
      Math.pow(clamp01(length / longest), p.spineFalloff))))
    const base = trunkAt(y)
    const r0 = trunkRadiusAt(y)
    growFrond([base[0] + Math.cos(yaw) * r0, y, base[2] + Math.sin(yaw) * r0],
      yaw, length, p.branchPitch + p.branchPitchTop * Math.pow(t, 1.5), count)
  }
  // The leader, which no frond reaches. Short sprays angled steeply down, so
  // the tree ends in foliage rather than in a bare spike.
  for (let a = 0; a < p.apexCount; a++) {
    const yaw = rand(0, Math.PI * 2) + (a / Math.max(1, p.apexCount)) * Math.PI * 2
    const top = trunkAt(h - 0.02)
    growFrond(top, yaw, p.apexLength * h, p.apexPitch, Math.max(3, p.spineMin | 0))
  }

  // --- the crown profile ---------------------------------------------------
  //
  // Measured off every vertex the crown actually grew, fringe included, since
  // the fringe IS the silhouette.
  const PROFILE = 32
  const profile = new Float32Array(PROFILE)
  const note = (q) => {
    const ax = trunkAt(clamp01(q[1] / h) * h)
    const r = Math.hypot(q[0] - ax[0], q[2] - ax[2])
    const bin = Math.min(PROFILE - 1, Math.max(0, Math.floor(q[1] / h * PROFILE)))
    if (r > profile[bin]) profile[bin] = r
  }
  for (const f of fronds) {
    for (const q of f.spine) note(q)
    for (const w of f.left) note(w.P)
    for (const w of f.right) note(w.P)
  }
  for (let i = 0; i < PROFILE; i++) {
    const a = profile[Math.max(0, i - 1)], b = profile[i], c = profile[Math.min(PROFILE - 1, i + 1)]
    profile[i] = (a + b * 2 + c) / 4
  }
  const crownRadiusAt = (y) => {
    const f = Math.min(PROFILE - 1.001, Math.max(0, y / h * PROFILE - 0.5))
    const i = Math.floor(f)
    return Math.max(0.05, lerp(profile[i], profile[Math.min(PROFILE - 1, i + 1)], f - i))
  }

  // --- emit ----------------------------------------------------------------
  const pos = [], nor = [], col = [], uv = [], layer = []
  const idx = []
  let foliageArea = 0

  emitTrunk()
  const woodIndices = idx.length
  const woodVerts = pos.length / 3
  for (const f of fronds) emitFrond(f)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(uv, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(layer, 1))
  geo.setIndex(idx)
  geo.computeBoundingSphere()

  const foliageTris = (idx.length - woodIndices) / 3
  const stats = {
    height: h,
    crownBase,
    crownRadius: Math.max(...profile),
    fronds: fronds.length,
    spineVerts: fronds.reduce((a, f) => a + f.n, 0),
    woodIndices,
    woodVerts,
    woodTris: woodIndices / 3,
    foliageTris,
    perFrondTris: +(foliageTris / fronds.length).toFixed(1),
    tris: idx.length / 3,
    verts: pos.length / 3,
    // An open sheet is drawn both sides, and a double-sided sheet's mean
    // projected area over all directions is HALF its own area.
    coverage: foliageArea / 2,
    axis: trunkAt((crownBase + h) / 2),
  }
  stats.silhouette = stats.crownRadius * (crownTop - crownBase)
  // Depth layers of foliage over one pixel of the crown. The cards it replaces
  // rasterise 3.4 fragments per silhouette pixel to keep 0.85; anything much
  // past ~2 here is geometry hidden behind its own crown.
  stats.layers = stats.coverage / Math.max(1e-3, stats.silhouette)
  geo.userData.cloakPine = stats
  return { geometry: geo, stats }

  // --- emitters ------------------------------------------------------------

  /**
   * A cone, and it CLOSES TO A POINT the way props/tree.js's trunk does: the
   * rings below the tip are quads, the last segment is one triangle per side.
   * A ring of radius near zero costs twice the triangles to say the same thing.
   */
  function emitTrunk() {
    const sides = Math.max(3, p.trunkSides | 0)
    const rings = Math.max(1, p.trunkSegs | 0)
    const base = pos.length / 3
    // sides + 1 vertices per ring: the last sits on the first but carries u =
    // the full circumference, so the closing quad does not run the tile
    // backwards across one face of the trunk.
    const ring = sides + 1
    for (let r = 0; r < rings; r++) {
      const y = (r / rings) * h
      const c = trunkPts[r]
      const rad = trunkRadiusAt(y)
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2
        pos.push(c[0] + Math.cos(a) * rad, c[1], c[2] + Math.sin(a) * rad)
        nor.push(Math.cos(a), 0.12, Math.sin(a))
        col.push(1, 1, 1)
        uv.push(((s / sides) * 2 * Math.PI * rad) / p.barkTile, y / p.barkTile)
        layer.push(barkLayer)
      }
    }
    // The apex, once per FACE rather than once: a single shared tip vertex
    // would have to carry one u for every face that meets there, and the tile
    // would smear around the top of the trunk.
    const apex = pos.length / 3
    const tip = trunkPts[rings]
    const tipRad = trunkRadiusAt(h * (rings - 1) / rings)
    for (let s = 0; s < sides; s++) {
      const a = ((s + 0.5) / sides) * Math.PI * 2
      pos.push(tip[0], tip[1], tip[2])
      nor.push(Math.cos(a) * 0.5, 0.86, Math.sin(a) * 0.5)
      col.push(1, 1, 1)
      uv.push((((s + 0.5) / sides) * 2 * Math.PI * tipRad) / p.barkTile, h / p.barkTile)
      layer.push(barkLayer)
    }
    for (let r = 0; r + 1 < rings; r++) {
      for (let s = 0; s < sides; s++) {
        const a = base + r * ring + s, b = a + 1
        idx.push(a, a + ring, b, b, a + ring, b + ring)
      }
    }
    for (let s = 0; s < sides; s++) {
      const a = base + (rings - 1) * ring + s
      idx.push(a, apex + s, a + 1)
    }
  }

  /**
   * ONE FROND, as two triangle strips off a shared spine. The spine vertices
   * belong to both strips, so the frond lights as one surface with a soft ridge
   * along its middle instead of as a pair of flaps meeting at a crease.
   *
   * The strips are wound in opposite directions -- `flip` -- because they lie on
   * opposite sides of the spine, and one rule for both would face one of them at
   * the ground. Which way UP is for the frond as a whole is then decided ONCE,
   * by a vote over its own faces, since a rumpled hem can drag any single
   * triangle past vertical.
   */
  function emitFrond(fr) {
    const ou = rand(0, 1), ov = rand(0, 1)
    const n = fr.n
    // slot 0..n-1 spine, then the left hem, then the right hem.
    const local = [...fr.spine.map((P, i) => ({ P, s: i / (n - 1), lat: 0 })), ...fr.left, ...fr.right]
    const faces = []
    for (const [chain, flip] of [[n, false], [n + fr.left.length, true]]) {
      const tri = (a, b, c) => faces.push(flip ? [a, c, b] : [a, b, c])
      // Hem vertex for spine i, which exists for 1 <= i <= n-2 only.
      const H = (i) => chain + i - 1
      // Both ends of the spine are bare, so the strip opens on one triangle and
      // closes on one: a quad at either end would need a hem vertex there.
      tri(0, H(1), 1)
      for (let i = 1; i + 2 < n; i++) {
        tri(i, H(i), H(i + 1))
        tri(i, H(i + 1), i + 1)
      }
      tri(n - 2, H(n - 2), n - 1)
    }

    let vote = 0
    const normals = faces.map((f) => {
      const nrm = cross(sub(local[f[1]].P, local[f[0]].P), sub(local[f[2]].P, local[f[0]].P))
      vote += nrm[1]
      return nrm
    })
    const slotN = new Float64Array(local.length * 3)
    for (let k = 0; k < faces.length; k++) {
      const f = faces[k], nrm = normals[k]
      if (vote < 0) {
        const t = f[1]; f[1] = f[2]; f[2] = t
        nrm[0] = -nrm[0]; nrm[1] = -nrm[1]; nrm[2] = -nrm[2]
      }
      foliageArea += len(nrm) / 2
      // Area-weighted, because the accumulation is over the raw cross products:
      // a broad triangle bends the shared normal more than a sliver does.
      for (const v of f) {
        slotN[v * 3] += nrm[0]; slotN[v * 3 + 1] += nrm[1]; slotN[v * 3 + 2] += nrm[2]
      }
    }

    const base = pos.length / 3
    for (let v = 0; v < local.length; v++) {
      const P = local[v].P
      const nrm = norm([slotN[v * 3], slotN[v * 3 + 1], slotN[v * 3 + 2]])
      // How far out of the crown this vertex sits. The value structure is the
      // only place the crown as a whole enters the shading at all.
      const ax = trunkAt(P[1])
      const rel = Math.min(1.4, Math.hypot(P[0] - ax[0], P[2] - ax[2]) / crownRadiusAt(P[1]))
      const depth = Math.pow(clamp01(1 - rel), 0.75)
      const lift = clamp01((P[1] - crownBase) / Math.max(1e-3, crownTop - crownBase))
      const body = mix3(p.needleMid, p.needleDark, Math.min(1, depth * p.depthShade))
      const litBody = [
        body[0] * (1 + lift * p.heightLift + fr.hue),
        body[1] * (1 + lift * p.heightLift + fr.hue * 0.6),
        body[2] * (1 + lift * p.heightLift * 0.5 + fr.hue * 0.3),
      ]
      // New growth only shows where light reaches it: out at the end of a
      // frond, and only on the part of it that is not buried.
      const c = mix3(litBody, p.needleTip, local[v].s * p.tipRun * (1 - depth))
      pos.push(P[0], P[1], P[2])
      nor.push(nrm[0], nrm[1], nrm[2])
      col.push(c[0], c[1], c[2])
      // Flat along the frond and across it, so the needle tile runs down the
      // frond at a fixed metres-per-tile whatever the frond's size.
      uv.push(ou + (local[v].lat * fr.length * 0.5) / p.leafPatch,
              ov + (local[v].s * fr.length) / p.leafPatch)
      layer.push(-1)
    }
    for (const f of faces) idx.push(base + f[0], base + f[1], base + f[2])
  }
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
function norm(a) {
  const l = len(a) || 1e-6
  return [a[0] / l, a[1] / l, a[2] / l]
}

// ---------------------------------------------------------------------------
// THE MATERIAL. A STOCK MeshLambertMaterial, lit by the scene's own lights like
// every other prop in the project -- same model /gen-rock, /gen-fern and
// /gen-tree are judged under. The only patch is the needle tile: it is sampled
// with REPEAT wrapping off `uvProj`, which the layer atlas cannot do, and
// divided by its own mean so the image supplies GRAIN over the vertex palette
// instead of repainting it.
//
// No alpha channel and no `discard` anywhere -- which is the whole reason the
// draw keeps its low-resolution-Z.
//
// DoubleSide, and three's back-face normal flip is UNDONE, exactly as
// createPropMaterial does it for a leaf card -- see the long note there. A
// frond is one cell of needles thick and lit from both sides at once; let three
// negate its normal and the underside of the crown is handed a normal aimed at
// the ground, which is dotNL 0 from the sun and near-black from the hemisphere.
// That reading, over smoothly-varying normals, is what makes an opaque crown
// look like wax. What is left is the same gentle backside ramp the prop
// material uses.
//
// The caller adds wrap diffuse (preview-stage.js's wrapLambert) on top, the way
// the bench already does for the bark material.
// ---------------------------------------------------------------------------

export function createCloakFoliageMaterial(opts = {}) {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    ...opts,
  })
  material.uniforms = {
    uMap: { value: null },
    uMapMean: { value: new THREE.Color(1, 1, 1) },
    uMapMix: { value: 0 },
  }
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 uvProj;
        varying vec2 vUvProj;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vUvProj = uvProj;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uMap;
        uniform vec3 uMapMean;
        uniform float uMapMix;
        varying vec2 vUvProj;`)
      // faceDirection twice is the identity: the fragment is lit by the normal
      // the geometry authored, whichever side of the frond you are on.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal *= faceDirection;
        diffuseColor.rgb *= mix( 0.72, 1.0,
          smoothstep( -0.35, 0.15, dot( normal, normalize( vViewPosition ) ) ) );`)
      // After <color_fragment>, which is where vertex colour lands on
      // diffuseColor: the tile modulates the palette, it does not replace it.
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (uMapMix > 0.0) {
          vec3 tile = texture2D(uMap, vUvProj).rgb / uMapMean;
          diffuseColor.rgb *= mix(vec3(1.0), tile, uMapMix);
        }`)
  }
  material.customProgramCacheKey = () => 'cloak-foliage-v3'
  return material
}
