import { WORLD_SIZE, WORLD_HALF } from '../config.js'

// ---------------------------------------------------------------------------
// THE PROFILE TARGET. A third LOD target beside quadtree-v2.js's triDeg and
// periphDeg, for ground that draws a SILHOUETTE EDGE.
//
// THE COMPLAINT THIS ANSWERS. Distant peaks read as polygons. The split rule
// caps every triangle at triDeg degrees, and that is the right invariant for a
// SURFACE -- a facet in the middle of a hillside is hidden by its own shading,
// and doubling the triangles there buys almost nothing. It is the wrong
// invariant for an EDGE. A profile line has nothing behind it to hide the
// facets against: a 3-degree triangle on a ridge crest is a 3-degree corner cut
// out of the sky, and the eye reads corners on a boundary far more readily than
// corners on a shaded interior. So silhouette error is worth more per metre
// than interior error, and that is a claim about perception rather than about
// geometry, which is why no amount of measuring the height field would ever
// have produced it.
//
// THE RULE. A node is on a RELATIVE SKYLINE if the top of it stands above the
// ground BEHIND it -- not against sky necessarily, just above whatever the next
// stretch of world along that azimuth reaches, because a nearer ridge crossing a
// further mountain is as much a profile line as one crossing the sky. Those
// nodes are graded toward SKYLINE.profileDeg; everything else keeps the target
// it already had. A second, cheaper test throws away anything HIDDEN behind
// nearer ground, since refining what she cannot see is pure waste.
//
// "ABOVE WHAT IS BEHIND IT" IS THE WHOLE TRICK, and the obvious formulation --
// above everything NEARER, i.e. is it visible over the running horizon -- was
// tried first and is quietly useless. For an eye above the ground, elevation
// angle RISES with distance all by itself: flat ground at 1 km sits at -8.5
// degrees from 150 m up and the same flat ground at 3 km sits at -2.9, so every
// distant thing clears every nearer thing and a visibility test classifies half
// the world as silhouette. Measured, that rule privileged 51% of far leaves and
// the ground it picked averaged 606 m against 592 m for the ground it did not,
// which is a detector that has learned almost nothing. Turning it around fixes
// it exactly: the same flat ground now FAILS, because the stretch behind it is
// higher in angle for the same reason. Only real protrusion passes.
//
// WHY THIS IS NOT THE HEURISTIC v1 ALREADY REJECTED, and src/terrain/quadtree.js
// carries that rejection at length so the difference has to be stated. v1's
// elevation bias keyed on a node's MEAN ELEVATION, a property of the map, and
// its correlation with actual geometric error was 0.16 at the depths it acted
// on. This keys on whether the node is on a silhouette, which is a property of
// WHERE THE EYE IS: the same 200 m hill is privileged against sky and not
// privileged from a viewpoint where a 400 m ridge stands in front of it. No
// earlier heuristic had access to that quantity at all. And v1's bias was a
// HIERARCHICAL GATE that could stop a descent, which is what pinned summits
// inside a low-mean quadrant at 64 m cells; this can only ever make a target
// FINER (see the Math.min on profileDeg) and so has no such failure mode.
//
// WHAT IT IS NOT FOR. It does not fix SUMMIT TRUNCATION, and confusing the two
// wastes the triangles. The imported field is point-sampled at the chunk's own
// spacing, so a summit landing between coarse vertices is simply missed --
// measured over the 150 highest summits, a 64 m cell loses 17 m at the median
// and 63 m in the tail, which is 6-7x what typical ground loses at the same
// cell. That is a ONE-SIDED BIAS and it is removable by a SHIFTED SAMPLE at
// zero triangle cost: chunk-mesh-v2.js's crest term, RELIEF_KNOBS 'crest'.
// Refining removes it only the slow way, 4x the leaves to halve it. Turn crest
// up first; this target is for the residual, which is the polygonal edge that
// remains once the peak height is right.
//
// Three-free and node-runnable, per DESIGN.md Constraint 3, so the gate can
// measure the cost of a policy change without a browser.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// THE KNOBS. Mutable for the same reason LOD is: the panel moves them and
// selection reads them every tick, so a change lands without a regeneration.
// ---------------------------------------------------------------------------
export const SKYLINE = {
  // Off makes selection bit-identical to the two-target rule. Every check that
  // asserts something about triDeg alone runs with this false, and that is what
  // keeps those assertions meaningful rather than measuring this by accident.
  on: true,

  // The target a fully-privileged silhouette node gets, in degrees, on the same
  // scale as LOD.triDeg. Clamped DOWN to triDeg at the point of use -- the
  // profile is a FINER target or it is nothing, and without the clamp a coarse
  // profileDeg beside a fine triDeg would decimate exactly the ground this
  // module exists to refine.
  //
  // 1.2 is MIN_TRI_DEG, i.e. as fine as the pool has ever been shown to hold,
  // and it is affordable HERE for the reason it is not affordable everywhere:
  // it applies to a line rather than to a field. It reaches about 6% of the
  // leaves past minRange. Measured over 144 selections (36 positions x 4
  // headings, half airborne), worst case, 640 tris/chunk, against terrain's
  // 117k third of the budget -- check-v2-skyline.mjs prints this ladder and
  // these numbers came off it:
  //
  //     rule                              sel MAX + 21 pinned   drawn tris   % of 117k
  //     triDeg 3.0, no profile                    361                95k          82%
  //     triDeg 3.0 + profile 1.2 (shipped)        379               109k          94%
  //     triDeg 3.0 + profile 1.2, ungated         433               130k         111%
  //     triDeg 1.2 everywhere                     871               301k         258%
  //     triDeg 5.72, no profile                   187                54k          46%
  //     triDeg 5.72 + profile 1.2                 247                70k          60%
  //
  // Two rows are worth reading twice. The profile costs 14k triangles over the
  // flat 3.0 it is added to, against the 206k it would cost to buy the same
  // silhouette by refining everything -- that ratio, roughly fifteen to one, IS
  // the argument for the module. And the last row is the one to reach for if the
  // budget ever tightens: a COARSER default paired with a fine profile draws
  // fewer triangles than today's flat 3.0 and puts them where they show.
  profileDeg: 1.2,

  // How far BELOW the ground behind it a node may sit and still count as
  // profile, in degrees, and the width of the ramp that grades it in.
  //
  // GRADED, NOT SWITCHED, and that is not polish. A binary flip would put a
  // discontinuity in the target exactly ON the silhouette, which is the one
  // place in the frame where a discontinuity is guaranteed to be looked at:
  // walk twenty metres, the classification of a ridge chunk flips, and the ridge
  // pops. This is the same lesson LOD.periphDeg's comment records, and the fix
  // is the same one -- interpolate the target rather than choosing between two.
  //
  // The width is nearly free, so it is set for how it LOOKS rather than for what
  // it costs: sweeping 0.25 to 4.0 degrees moved the worst selection 355 to 367
  // and the drawn triangles 106k to 112k, about 6% over a 16x change in the
  // knob. A degree is roughly two chunk-widths of ramp on a ridge at a
  // kilometre, which is enough travel for the target to slide rather than snap.
  marginDeg: 1.0,

  // Below this range the privilege ramps off, over minRange/2 to minRange.
  //
  // THIS IS A SHARPENING, NOT A BUDGET CAP, and it is worth being clear about
  // that because the first draft of this module needed it to be one. Under the
  // detector this shipped with, the whole sweep 0 to 1200 m moves the cost 130k
  // to 97k -- real, but the rule is affordable ungated. The reason to gate it is
  // that near ground is where the detector is WEAKEST and where the complaint
  // is not. Close in, small convexities pass -- the lip of a bank, a hummock --
  // and refining those buys nothing anyone has ever asked for, while at a
  // kilometre a 3-degree facet is the widest thing about a ridge. 600 m is
  // inside the range where the artifact is the whole reason for the module and
  // outside the range where the detector is guessing. Dropping to 300 costs
  // about 6% more triangles if a closer silhouette ever looks wrong.
  minRange: 600,

  // HOW FAR BEHIND the node to look for the ground it has to stand above, as a
  // multiple of the node's own range. 3 means "out to three times as far".
  //
  // This is what separates a RELATIVE skyline from the true one. At Infinity the
  // backdrop is the whole world behind the node and only ground standing against
  // SKY survives. At 3 the backdrop is local, so a near ridge crossing a far
  // mountain is measured against the valley immediately behind it, passes, and
  // gets its edge -- while flat ground still fails, because the next stretch of
  // flat ground is always higher in angle than the last.
  //
  // ON THIS MAP IT IS A TRIM, NOT A MODE. That was the expectation and the
  // measurement says otherwise, so the measurement goes here: the whole sweep
  // 1.5 to Infinity moves the privileged share only 7.3% to 5.6% of far leaves
  // and the worst selection 373 to 358, and 3 against Infinity differs on 0.3%
  // of selected nodes. The reason is the world: at 8 km across, the ground three
  // times past a node is usually the same ground the far horizon is made of, so
  // local and global backdrops coincide almost everywhere. The knob is kept at
  // its principled value rather than collapsed to the cheaper Infinity, because
  // the case it exists for is real and merely rare HERE -- a low foreground
  // ridge against a distant range is a map away, not a rewrite away.
  //
  // 3 rather than 1.5 or 5 because a bucket is a fixed ratio in range (BUCKETS
  // over FAR/R0, about 1.2x each) and 3x is six of them: enough that a ridge's
  // own bucket-quantised range cannot land the window on top of the ridge
  // itself, few enough that the window does not run out past the far mountains.
  backdropX: 3,
}


// Bin count and bucket count for the horizon table below. BINS is a power of two
// so the azimuth wrap is a mask rather than a modulo, in a loop that runs
// BINS * ~120 times per rebuild.
const BINS = 256
const BIN_RAD = (Math.PI * 2) / BINS
const BUCKETS = 40
// The world diagonal with margin. Nothing can occlude from further away than
// this, so it is also where a backdrop window runs out and the test becomes
// "does it stand against sky".
const FAR = WORLD_SIZE * 1.45
const R0 = 8
const LOG_SPAN = Math.log(FAR / R0)
const NADIR = -Math.PI / 2

// Log-spaced range buckets. Linear buckets would spend most of their resolution
// on ground beyond a kilometre, where the running max has long since stopped
// changing, and none at all over the first two hundred metres, where it changes
// on every step.
const bucketOf = (r) => {
  const b = Math.floor((Math.log((r > R0 ? r : R0) / R0) / LOG_SPAN) * BUCKETS)
  return b < 0 ? 0 : b >= BUCKETS ? BUCKETS - 1 : b
}

const smoothstep = (a, b, x) => {
  if (!(b > a)) return x >= b ? 1 : 0
  let t = (x - a) / (b - a)
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}


/**
 * A MAX-MIPMAP over the imported coarse field: level L holds the maximum of each
 * 2^L x 2^L block of texels, so a conservative "how high does the ground get
 * anywhere in this box" is at most four array reads at any box size.
 *
 * WHY THIS AND NOT terrain-v2.js's `info` TABLE, which already holds a per-node
 * maxY and is right there. Two reasons and the first is fatal. `info` is LAZY --
 * it is what the mesher LEARNED, and a node has no entry until it has been built
 * once. Classifying on it would mean a node's silhouette membership depends on
 * whether it has been meshed yet, which decides whether it gets refined, which
 * decides whether it gets meshed: a feedback loop with no fixed point, that
 * would settle differently depending on which way the camera arrived. This grid
 * is complete before the first frame and is a pure function of the import.
 * Second, `info` is keyed by node, and the horizon march needs maxima over
 * arbitrary boxes along a ray, which no node table can answer.
 *
 * It describes the COARSE IMPORT ONLY. detail.js's octaves are not in it and
 * cannot be -- they are procedural and band-limited. That is the right call
 * rather than a limitation: the detail layer is bounded by its own amplitude law
 * and is small against the relief that decides a silhouette, and a classifier
 * that had to evaluate the composed field per march step would cost more than
 * the triangles it saves.
 */
export class MaxPyramid {
  /**
   * @param heightmapRaw {width, height, data} -- Heightmap.toRaw()'s shape, in
   *   metres, on the gridStep registration (texel 0 on the -X/-Z world corner).
   */
  constructor({ width, height, data }) {
    if (!data || data.length !== width * height) {
      throw new Error(`MaxPyramid: ${width}x${height} needs ${width * height} floats, got ${data ? data.length : 'nothing'}`)
    }
    if (width !== height) throw new Error(`MaxPyramid: ${width}x${height} is not square -- the level walk assumes one size`)
    this.width = width
    // The SAME registration heightmap.js uses. Written as WORLD_SIZE/(width-1)
    // rather than imported because importing Heightmap here would drag png.js
    // into the selection path; the gate asserts the two agree.
    this.step = WORLD_SIZE / (width - 1)
    this._inv = 1 / this.step

    // Level 0 aliases the source rather than copying it: this is 4 MB at 1024
    // and the terrain already holds it. Nothing here writes to a level.
    const levels = [data]
    const sizes = [width]
    let n = width
    while (n > 1) {
      const prev = levels[levels.length - 1]
      const pn = n
      n = Math.ceil(n / 2)
      const next = new Float32Array(n * n)
      for (let j = 0; j < n; j++) {
        // An odd level repeats its last row/column rather than dropping it. A
        // dropped edge would make the far world corner report a max that does
        // not include the ground actually there, and under-reporting a maximum
        // is the direction that loses a silhouette.
        const j0 = j * 2
        const j1 = j0 + 1 < pn ? j0 + 1 : j0
        for (let i = 0; i < n; i++) {
          const i0 = i * 2
          const i1 = i0 + 1 < pn ? i0 + 1 : i0
          const a = prev[j0 * pn + i0]
          const b = prev[j0 * pn + i1]
          const c = prev[j1 * pn + i0]
          const d = prev[j1 * pn + i1]
          const m0 = a > b ? a : b
          const m1 = c > d ? c : d
          next[j * n + i] = m0 > m1 ? m0 : m1
        }
      }
      levels.push(next)
      sizes.push(n)
    }
    this.levels = levels
    this.sizes = sizes
    this.maxLevel = levels.length - 1
  }

  /**
   * The highest ground anywhere in the world-space box, conservatively.
   *
   * Conservative UPWARD, always, and the direction is chosen rather than
   * incidental. Over-reporting a node's own top makes it look more like a
   * silhouette, which spends triangles; under-reporting it would drop a
   * silhouette on the floor, which is the artifact. Spending is recoverable by
   * a knob, missing is not.
   */
  maxIn(x0, z0, x1, z1, cells = 4) {
    const u0 = (x0 + WORLD_HALF) * this._inv
    const v0 = (z0 + WORLD_HALF) * this._inv
    const u1 = (x1 + WORLD_HALF) * this._inv
    const v1 = (z1 + WORLD_HALF) * this._inv
    const du = u1 - u0
    const dv = v1 - v0
    const span = du > dv ? du : dv
    // THE LEVEL IS A PRECISION DIAL, and `cells` is the dial: pick the level
    // whose cell is at most span/cells, so the box straddles at most cells+1 of
    // them per axis.
    //
    // What the dial buys is SLACK. A mip query reads whole cells, so it reaches
    // up to one cell past each edge of the box it was asked about, and that
    // reach is phantom mountain -- ground outside the node reported as the
    // node's own top. At the natural choice (one cell covering the whole box)
    // the reach is a full box-width and on this heightmap that put the
    // over-report at 118 m at p90, which is more than a third of the relief of
    // the map on a number whose entire job is deciding whether one ridge stands
    // above another.
    //
    // It is paid for in reads, (cells+1)^2 of them, and the two callers want
    // opposite ends of that trade. The horizon march runs ~30k queries a rebuild
    // and only needs to know roughly how high a wedge of ground gets, so it
    // takes the default. gain() runs a few thousand and the answer IS the
    // classification, so it pays for 8. Neither number is a tuning: they are the
    // two points where the gate's over-report and its millisecond budget both
    // sit where they should.
    let L = Math.ceil(Math.log2(span / cells))
    if (!(L > 0)) L = 0
    else if (L > this.maxLevel) L = this.maxLevel
    const shift = 1 << L
    const n = this.sizes[L]
    const grid = this.levels[L]
    // EPS is in level cells and guards one failure: a box edge landing exactly
    // on a cell boundary, where accumulated float error in
    // (-WORLD_HALF + i * step + WORLD_HALF) / step puts the coordinate a few
    // ulps off the integer it should be. On the high edge that makes ceil round
    // a whole cell UP and on the low edge it makes floor round one DOWN -- the
    // first is harmless slack, the second is an under-report, which is the one
    // direction this function may not go, and it showed up as 17 short boxes in
    // 3000 before the nudge. Nudging INWARD rather than outward is what keeps a
    // zero-width box reading exactly the one texel it lands on.
    const EPS = 1e-6
    let i0 = Math.floor(u0 / shift + EPS)
    let i1 = Math.ceil(u1 / shift - EPS)
    let j0 = Math.floor(v0 / shift + EPS)
    let j1 = Math.ceil(v1 / shift - EPS)
    // Border clamp, matching heightmap.js's _tap: edge-extend, never wrap.
    if (i0 < 0) i0 = 0
    if (j0 < 0) j0 = 0
    if (i1 >= n) i1 = n - 1
    if (j1 >= n) j1 = n - 1
    if (i1 < i0) i1 = i0
    if (j1 < j0) j1 = j0
    let best = -Infinity
    for (let j = j0; j <= j1; j++) {
      const row = j * n
      for (let i = i0; i <= i1; i++) {
        const v = grid[row + i]
        if (v > best) best = v
      }
    }
    return best
  }
}


/**
 * THE HORIZON TABLE, which is really two tables over the same march, both
 * indexed [bin][bucket] -- one azimuth, one range -- from one camera position.
 *
 *   hz[b][r]  the highest elevation angle of any ground NEARER than r. The
 *             running max, i.e. the horizon she has already seen by the time her
 *             eye reaches that range. Used to throw away HIDDEN nodes.
 *   bm[b][r]  the highest elevation angle of the ground IN that bucket alone.
 *             A window of these buckets just past a node is the BACKDROP it is
 *             drawn against, and standing above that backdrop is the detector.
 *
 * Both fall out of the same march, and the second is the one that decides --
 * see THE RULE at the top of this file for why it is that way round and not the
 * obvious way round. bm is stored per-bucket rather than pre-windowed so that
 * SKYLINE.backdropX stays a LIVE knob: the window is applied at lookup, which
 * costs six reads and means moving the knob does not invalidate the table. It
 * also could not be built by suffixing hz, since a running max is cumulative and
 * any suffix of one is just its last element -- that would collapse every
 * backdropX to Infinity and quietly turn the local test into the sky-only one.
 *
 * REBUILT PER SELECTION, not per frame, because it is a function of the camera
 * POSITION and selection is the only thing that cares. Selection runs at 12 Hz
 * (terrain-v2.js SELECT_EVERY_FRAMES) and a rebuild is BINS * ~120 pyramid
 * queries of at most four reads each -- see check-v2-skyline.mjs for the measured
 * ms, which is what this claim is worth rather than the arithmetic.
 *
 * A yaw-limited march was considered and rejected: the streaming cone is 90
 * degrees half-angle and the camera turns between selections, so a table built
 * for one heading would be wrong for the next and the bins saved are the cheap
 * ones anyway.
 */
export class HorizonTable {
  constructor(pyramid) {
    this.pyramid = pyramid
    this.hz = new Float32Array(BINS * BUCKETS)
    this.bm = new Float32Array(BINS * BUCKETS)
    this.cam = { x: NaN, y: NaN, z: NaN }
    this._b0 = 0
    this.builds = 0
    this.lastMs = 0
  }

  /**
   * Rebuild for this eye position. Returns false and does nothing if the eye has
   * not moved enough to matter -- the table is a function of position alone, so
   * standing still or turning on the spot reuses it.
   */
  build(cam, moveEps = 4) {
    if (cam.y === undefined) {
      throw new Error('HorizonTable.build: camera has no y -- an elevation-angle table cannot be built from a ground position')
    }
    const c = this.cam
    if (
      Math.abs(cam.x - c.x) < moveEps &&
      Math.abs(cam.z - c.z) < moveEps &&
      Math.abs(cam.y - c.y) < moveEps
    ) {
      return false
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0
    c.x = cam.x
    c.y = cam.y
    c.z = cam.z
    const hz = this.hz
    const bm = this.bm
    bm.fill(NADIR)
    const pyr = this.pyramid
    for (let b = 0; b < BINS; b++) {
      const a = (b + 0.5) * BIN_RAD
      // Matches inCone's azimuth convention -- atan2(dx, dz), z forward.
      const sx = Math.sin(a)
      const sz = Math.cos(a)
      let running = NADIR
      let bucket = 0
      let d = R0
      let stepM = 6
      const base = b * BUCKETS
      while (d < FAR) {
        // The bin is a WEDGE, not a ray, and it widens with distance. Sampling
        // the centre line alone would let a ridge slip between two bins and
        // occlude nothing, which shows up as a single over-refined column of
        // chunks with correctly coarse neighbours. The pyramid makes the
        // wedge-width max the same price as the point sample.
        const fp = d * BIN_RAD > stepM ? d * BIN_RAD : stepM
        const h = pyr.maxIn(cam.x + sx * d - fp, cam.z + sz * d - fp, cam.x + sx * d + fp, cam.z + sz * d + fp)
        const ang = Math.atan2(h - cam.y, d)
        if (ang > running) running = ang
        const nb = bucketOf(d)
        // The sample lands in exactly one bucket for bm...
        if (ang > bm[base + nb]) bm[base + nb] = ang
        // ...and into every bucket up to and including this range for hz, so a
        // bucket holds the max over everything NEARER than it. Filling forward
        // like this rather than post-scanning keeps the pass single.
        while (bucket <= nb && bucket < BUCKETS) hz[base + bucket++] = running
        d += stepM
        // Geometric growth, so the step settles at a constant FRACTION of range
        // -- 5% -- and the sample density matches what the table can actually
        // represent. A fixed step fine enough for the first hundred metres would
        // spend thousands of samples on ground that changes the answer by
        // nothing.
        //
        // 5% and not the 3.5% this started at, because the march is the only
        // part of this module that costs milliseconds and the rate is where the
        // milliseconds are: 212 steps a bin at 3.5%, 150 at 5%, and the whole
        // rebuild went 4.6 ms to 3.3 and back inside its budget. It buys that
        // by sampling more sparsely along the ray, NOT by reading the pyramid
        // more coarsely, and the distinction is the point. A coarser pyramid
        // read over-reports the wedge, which raises the horizon, which calls
        // real silhouettes hidden and real protrusions flat -- it buys time by
        // losing exactly the thing the module is for. Sampling every 5% of range
        // instead of every 3.5% is still four times finer than the 20% buckets
        // the answer is stored in.
        stepM *= 1.05
      }
      while (bucket < BUCKETS) hz[base + bucket++] = running
    }
    this.builds++
    this.lastMs = typeof performance !== 'undefined' ? performance.now() - t0 : 0
    return true
  }

  /**
   * How much of the profile target this node has earned, 0..1. Zero means it is
   * fully occluded or too near to matter, and selection then behaves exactly as
   * it did before this module existed.
   *
   * `range` is selection's own range, passed in rather than recomputed, because
   * a classifier that measured distance differently from the rule it modifies
   * would be privileging nodes at ranges the split test does not agree exist.
   */
  gain(cam, x, z, size, range) {
    const rangeGain = smoothstep(SKYLINE.minRange * 0.5, SKYLINE.minRange, range)
    if (rangeGain <= 0) return 0

    // The node's own top, from the pyramid, over its exact footprint.
    // 8 cells across rather than the default 4: this one number IS the
    // classification, and slack here reads as one peak's height smeared onto its
    // neighbours, which widens the privileged band into exactly the field the
    // rule exists not to be.
    const top = this.pyramid.maxIn(x, z, x + size, z + size, 8)
    // HORIZONTAL distance to the box, not `range`. The elevation angle of a
    // node's top is rise over RUN, and range carries the vertical term, so using
    // it would flatten the angle of anything directly above or below the eye --
    // exactly the case flying over a ridge, where the answer matters most.
    const dx = Math.max(x - cam.x, 0, cam.x - (x + size))
    const dz = Math.max(z - cam.z, 0, cam.z - (z + size))
    const horiz = Math.max(Math.hypot(dx, dz), 1)
    const topAngle = Math.atan2(top - cam.y, horiz)

    const margin = (SKYLINE.marginDeg * Math.PI) / 180
    const bucket = bucketOf(range)
    const nbins = this._bins(cam, x, z, size)

    // VISIBLE? Anything standing below the horizon she has already seen by this
    // range is behind a nearer ridge, and refining ground she cannot see is the
    // purest waste there is. Cheap, and it runs first so the backdrop lookup is
    // skipped for the majority of nodes in broken country.
    let occ = NADIR
    for (let k = 0; k < nbins; k++) {
      const v = this.hz[this._binAt(k) * BUCKETS + bucket]
      if (v > occ) occ = v
    }
    const visGain = smoothstep(occ - margin, occ, topAngle)
    if (visGain <= 0) return 0

    // PROTRUDING? The backdrop is the ground just past this node, out to
    // backdropX times its range, and the node earns the profile target by
    // standing above it. The window starts at bucket + 1, strictly BEHIND, or a
    // ridge would be measured against its own bucket and every ridge would
    // always tie with itself.
    const win = SKYLINE.backdropX >= FAR / R0 ? BUCKETS : Math.round((Math.log(SKYLINE.backdropX) / LOG_SPAN) * BUCKETS)
    const last = Math.min(BUCKETS - 1, bucket + win)
    let back = NADIR
    for (let k = 0; k < nbins; k++) {
      const base = this._binAt(k) * BUCKETS
      for (let r = bucket + 1; r <= last; r++) {
        const v = this.bm[base + r]
        if (v > back) back = v
      }
    }
    return rangeGain * visGain * smoothstep(back - margin, back, topAngle)
  }

  /**
   * How many azimuth bins a node's footprint covers, leaving the first one in
   * this._b0 for _binAt. Split in two and stashed on the instance rather than
   * returned as a pair because gain() is the innermost thing in selection and an
   * object per node here is an object per node in the GC.
   *
   * Bins are taken over the node's FULL azimuth span and maxed by both callers
   * above, not sampled at its centre. A centre sample would call a ridge
   * occluded because its middle happens to sit behind a nearer knoll while both
   * its ends stand clear against sky -- and the ends are the silhouette.
   */
  _bins(cam, x, z, size) {
    const dx = x + size / 2 - cam.x
    const dz = z + size / 2 - cam.z
    const dist = Math.hypot(dx, dz)
    // The node's own angular half-width, the same 0.71 half-diagonal inCone uses.
    const half = Math.atan2(size * 0.71, dist > 1 ? dist : 1)
    this._b0 = Math.floor((Math.atan2(dx, dz) - half) / BIN_RAD)
    return Math.ceil((2 * half) / BIN_RAD) + 1
  }

  _binAt(k) {
    return (((this._b0 + k) % BINS) + BINS) % BINS
  }
}

// Exported so probes and the gate read the table's own geometry rather than
// re-deriving constants that would then silently disagree with it.
export { BINS, BUCKETS, FAR }
