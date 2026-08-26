import { mulberry32 } from '../sim/mathx.js'

// ---------------------------------------------------------------------------
// The building grammar: DESIGN.md §19, the data half.
//
// NO three.js IN THIS FILE. That is the §1 porting rule and it buys something
// concrete here: scripts/check-buildings.mjs can plan ten thousand buildings in
// a second and assert that none of them puts a window through its own door,
// floats a chimney above its roof, or grows past the §5 `structure` budget --
// without a WebGL context, without a scene, without a frame. The failures this
// system produces are silent geometric ones, and silent failures are only
// affordable if they are cheap to look for.
//
// FOOTPRINT-FIRST AND ADDITIVE. A building is one or two rectangular masses.
// The room count is not a knob: it falls out of floor area, because that is how
// it works in the world and because a "3 rooms" slider would immediately start
// disagreeing with the shape on screen. What the caller picks is a KIND -- hut,
// cottage, longhouse, inn -- and the kind sets the area, the height, and which
// mass arrangements are legal.
//
// CONVENTIONS (shared with src/village/shapes.js, and the spur-path router
// depends on both):
//   * Everything sits on y = 0 and is centred on XZ.
//   * THE FRONT DOOR IS ON LOCAL +Z.
// ---------------------------------------------------------------------------

export const WALL_STYLES = ['log', 'stave', 'halfTimber', 'stoneBase', 'masonry']
export const ROOF_KINDS = ['thatch', 'shake', 'slate', 'pantile']

/**
 * The kinds, and what each one is allowed to be.
 *
 * `area` is the primary mass footprint in m^2 and everything else scales off
 * it. `styles` is a whitelist rather than a weight table because the wrong
 * pairing is not "less likely", it is wrong: a grand inn is not built from
 * stacked round logs, and a woodcutter's hut is not half-timbered with lime
 * plaster.
 */
export const KINDS = {
  hut: {
    area: [11, 17], ratio: [1.0, 1.35], wallH: [2.1, 2.45],
    shapes: ['single', 'outshut'],
    styles: ['log', 'stave'],
    roofs: ['thatch', 'thatch', 'shake'],
    pitch: [0.62, 0.8], windows: 0.34, runes: 0.15,
  },
  cottage: {
    area: [22, 34], ratio: [1.25, 1.7], wallH: [2.4, 2.9],
    shapes: ['single', 'outshut', 'ell', 'wing'],
    styles: ['log', 'stave', 'halfTimber', 'stoneBase', 'masonry'],
    roofs: ['thatch', 'thatch', 'shake', 'slate', 'pantile'],
    pitch: [0.6, 0.78], windows: 0.62, runes: 0.3,
  },
  longhouse: {
    area: [48, 72], ratio: [2.1, 3.0], wallH: [2.5, 3.0],
    shapes: ['single', 'outshut', 'wing'],
    styles: ['log', 'stave'],
    roofs: ['thatch', 'thatch', 'shake'],
    pitch: [0.66, 0.85], windows: 0.55, runes: 0.5,
  },
  inn: {
    area: [58, 84], ratio: [1.4, 1.9], wallH: [4.4, 5.4],
    shapes: ['ell', 'tee', 'wing'],
    styles: ['halfTimber', 'stoneBase', 'stave', 'masonry'],
    roofs: ['shake', 'slate', 'pantile', 'thatch'],
    pitch: [0.58, 0.72], windows: 0.8, runes: 0.6,
  },
}

// Bay spacing. A "bay" is one structural interval along a wall, and openings
// land in bays rather than at fractions of the wall, which is why a long wall
// gets more windows instead of wider-spaced ones.
const BAY = 2.15
const DOOR_W = 1.05
const DOOR_H = 1.98
const WIN_W = 0.72
const WIN_H = 0.88

const lerp = (a, b, t) => a + (b - a) * t
const pick = (r, arr) => arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))]
const range = (r, [lo, hi]) => lerp(lo, hi, r())

/** How much wall a window occupies each side of its centre.
 *
 * The glass is the small part of it: the surround adds 7 cm a side and an open
 * shutter swings a whole leaf clear of that again, so a 0.72 m shuttered window
 * takes up 1.6 m of frontage. Anything that has to keep out of a window's way --
 * a corner return, a half-timber stud, a gable's king post -- has to keep out of
 * THIS number and not out of the glass, which is why it is exported rather than
 * written out at each of those three places. The 0.07 and the 0.52 are read off
 * `windowUnit2`'s `frame` and `leafW`; the last 9 cm is daylight.
 */
export function windowHalfWidth(wn) {
  return wn.width / 2 + 0.07 + (wn.shutters ? wn.width * 0.52 : 0) + 0.09
}

/**
 * The surface height of a roof at a point, used to seat chimneys.
 *
 * Exported because it is the one piece of roof maths that has to agree between
 * the planner (deciding where a chimney base goes) and parts.js (drawing the
 * slope). Two copies of it would drift, and the symptom -- a chimney hovering
 * two centimetres above the thatch -- is invisible until someone walks up to it.
 */
export function roofHeightAt(roof, x, z) {
  if (roof.kind === 'lean') {
    const acr = roof.dir[1] === 'x' ? x - roof.cx : z - roof.cz
    const s = roof.dir[0] === '+' ? acr : -acr
    const t = (s + roof.runHalf) / (2 * roof.runHalf)
    return lerp(roof.highY, roof.lowY, Math.max(0, Math.min(1, t)))
  }
  const acr = roof.ridgeAxis === 'x' ? z - roof.cz : x - roof.cx
  const t = Math.min(1, Math.abs(acr) / roof.runHalf)
  return roof.ridgeY - t * roof.rise
}

/** The four corners of an axis-aligned mass, CCW seen from above. */
function rectCorners(m) {
  const hw = m.w / 2
  const hd = m.d / 2
  return [
    [m.cx - hw, m.cz + hd],
    [m.cx + hw, m.cz + hd],
    [m.cx + hw, m.cz - hd],
    [m.cx - hw, m.cz - hd],
  ]
}

/**
 * The walls of a mass, wound so the outward normal is (-dz, 0, dx).
 *
 * Front (+Z) first, then right, back, left -- the order the door and window
 * placement below assumes, and the order parts.wall() is documented against.
 */
function rectWalls(m) {
  const c = rectCorners(m)
  const out = [
    [0, 1], // front, +Z
    [1, 2], // right, +X
    [2, 3], // back, -Z
    [3, 0], // left, -X
  ]
  return out.map(([i, j], k) => ({
    massId: m.id,
    side: ['front', 'right', 'back', 'left'][k],
    p0: c[i],
    p1: c[j],
    n: [[0, 1], [1, 0], [0, -1], [-1, 0]][k],
    len: Math.hypot(c[j][0] - c[i][0], c[j][1] - c[i][1]),
  }))
}

/** Convex hull of a point cloud, for the footprint the village router uses.
 *
 *  An L-plan's true outline is a re-entrant hexagon, and the hull fills in the
 *  notch. That is deliberate: the router's only question is "where may a path
 *  not go", and answering it conservatively costs a couple of square metres of
 *  yard while answering it exactly costs a rectilinear-union routine that would
 *  then need its own tests. */
function hull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (src) => {
    const h = []
    for (const p of src) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop()
      h.push(p)
    }
    h.pop()
    return h
  }
  return [...half(pts), ...half(pts.reverse())]
}

/**
 * Plan one building.
 *
 * `groundAt(x, z)` lets the plan sit the building on real terrain: the floor
 * goes at the HIGHEST footprint corner and the plinth grows down to the LOWEST,
 * so a building on a slope can never float and never sinks its doorsill into
 * the hill. Omit it and everything is flat at y = 0, which is what the
 * previewer does.
 */
export function planBuilding(opts = {}) {
  const {
    seed = 1,
    kind = 'cottage',
    groundAt = null,
    style: styleOverride = null,
    roof: roofOverride = null,
    shape: shapeOverride = null,
    // Sliders from the previewer. Applied AFTER every random draw rather than
    // instead of one, so a seed keeps producing the same building as you drag
    // -- otherwise every slider would also reroll the shape and there would be
    // no way to judge what the slider itself did.
    tweak = null,
  } = opts

  const K = KINDS[kind]
  if (!K) throw new Error(`planBuilding: unknown kind "${kind}"`)
  const r = mulberry32(seed * 2654435761 + 12345)

  const style = styleOverride ?? pick(r, K.styles)
  const roofKind = roofOverride ?? pick(r, K.roofs)
  const shape = shapeOverride ?? pick(r, K.shapes)

  // --- 1. masses -----------------------------------------------------------
  //
  // The long axis of the primary mass runs along X, so its ridge runs along X
  // and both its gable ends face +/-X. That is what leaves the +Z front wall a
  // long eaves wall with room for a door and windows, which is the only reason
  // "the door is on +Z" is a liveable convention rather than a constant fight.

  const T = tweak ?? {}
  const area = range(r, K.area) * (T.areaScale ?? 1)
  const ratio = range(r, K.ratio) * (T.ratioScale ?? 1)
  const w = Math.round(Math.sqrt(area * ratio) * 10) / 10
  const d = Math.round((area / w) * 10) / 10
  const wallH = range(r, K.wallH) * (T.wallScale ?? 1)
  const pitch = range(r, K.pitch) * (T.pitchScale ?? 1) // rise per metre of run
  const overhang = T.overhang ?? range(r, [0.32, 0.48])
  const windowDensity = K.windows * (T.windowScale ?? 1)

  const masses = []
  const main = {
    id: 0, role: 'main', cx: 0, cz: 0, w, d,
    wallH, ridgeAxis: 'x',
  }
  masses.push(main)

  if (shape === 'outshut') {
    // A low store shed down one long side, roofed by carrying the main slope
    // on down. Always on -Z so it never lands in front of the door.
    const od = Math.max(1.6, d * range(r, [0.42, 0.6]))
    masses.push({
      id: 1, role: 'outshut', cx: 0, cz: -(d / 2 + od / 2), w: w * range(r, [0.6, 0.92]), d: od,
      wallH: wallH * range(r, [0.52, 0.66]), ridgeAxis: null,
    })
  } else if (shape === 'wing' || shape === 'ell') {
    // A gabled wing off one gable end, its ridge crossing the main one. On an
    // ell it also steps forward or back, which is what turns a straight range
    // into an L.
    const side = r() < 0.5 ? -1 : 1
    const ww = w * range(r, [0.42, 0.58])
    const wd = d * range(r, [0.95, 1.35])
    const shift = shape === 'ell' ? (wd - d) / 2 * (r() < 0.5 ? -1 : 1) : 0
    masses.push({
      id: 1, role: 'wing',
      cx: side * (w / 2 + ww / 2 - 0.12), cz: shift,
      w: ww, d: wd,
      wallH: wallH * range(r, [0.86, 1.0]), ridgeAxis: 'z',
    })
  } else if (shape === 'tee') {
    // A cross-wing off the BACK, so the frontage stays one clean range.
    const ww = w * range(r, [0.3, 0.42])
    const wd = d * range(r, [0.75, 1.0])
    masses.push({
      id: 1, role: 'wing', cx: range(r, [-0.18, 0.18]) * w, cz: -(d / 2 + wd / 2 - 0.12),
      w: ww, d: wd, wallH: wallH * range(r, [0.9, 1.0]), ridgeAxis: 'z',
    })
  }

  // --- 2. terrain, floor, plinth -------------------------------------------

  const allCorners = masses.flatMap(rectCorners)
  let gMin = 0
  let gMax = 0
  if (groundAt) {
    gMin = Infinity
    gMax = -Infinity
    for (const [x, z] of allCorners) {
      const h = groundAt(x, z)
      if (h < gMin) gMin = h
      if (h > gMax) gMax = h
    }
  }
  const floorY = gMax + 0.14
  const plinthBottom = Math.min(gMin, floorY - 0.3) - 0.22
  const doorGroundY = groundAt ? groundAt(0, d / 2 + 0.6) : 0

  // --- 3. roofs ------------------------------------------------------------

  for (const m of masses) {
    const y0 = floorY + (m.role === 'outshut' ? 0 : 0)
    m.floorY = y0
    m.eaveY = y0 + m.wallH
    if (m.role === 'outshut') {
      // The catslide: it starts where the main wall already is and falls away.
      m.roof = {
        kind: 'lean', cx: m.cx, cz: m.cz, dir: '-z',
        runHalf: m.d / 2,
        highY: main.floorY + main.wallH,
        lowY: m.eaveY,
      }
    } else {
      const runHalf = (m.ridgeAxis === 'x' ? m.d : m.w) / 2
      const rise = runHalf * pitch * 2
      m.roof = {
        kind: 'gable', cx: m.cx, cz: m.cz, ridgeAxis: m.ridgeAxis,
        runHalf, rise, ridgeY: m.eaveY + rise,
      }
    }
  }

  // --- 4. walls and their openings -----------------------------------------
  //
  // An opening lands in a BAY, and a bay is skipped if the mass behind that
  // stretch of wall is another mass -- a window looking into the next room is
  // the single most generated-looking mistake this kind of system makes.

  // A wall is only buried where another mass actually stands behind it, and
  // "where" is the operative word: testing the MIDPOINT alone, which this used
  // to do, is a coin flip on any plan whose wing is narrower than the wall it
  // covers. An outshut covering the middle 75% of a back wall answered "buried",
  // the whole wall was dropped, and the two uncovered ends became open doorways
  // into the room. So resolve the coverage as an interval along the wall and
  // keep what is left over.
  //
  // Both the wall and the mass are axis-aligned, so a mass either misses the
  // wall's plane entirely or covers one contiguous run of it -- no sampling, no
  // clipper, just two slab tests.
  const coverSpan = (wl, m) => {
    const ux = (wl.p1[0] - wl.p0[0]) / wl.len
    const uz = (wl.p1[1] - wl.p0[1]) / wl.len
    // 5 cm behind the face, so a mass merely ABUTTING the wall does not hide it.
    const bx = wl.p0[0] + wl.n[0] * 0.05
    const bz = wl.p0[1] + wl.n[1] * 0.05
    let lo = 0
    let hi = wl.len
    for (const [b, u, c, e] of [
      [bx, ux, m.cx, m.w / 2 - 0.02],
      [bz, uz, m.cz, m.d / 2 - 0.02],
    ]) {
      if (u === 0) {
        // The wall does not move along this axis: it is either inside this slab
        // for its whole length or outside it for its whole length.
        if (Math.abs(b - c) >= e) return null
      } else {
        const r0 = (c - e - b) / u
        const r1 = (c + e - b) / u
        lo = Math.max(lo, Math.min(r0, r1))
        hi = Math.min(hi, Math.max(r0, r1))
      }
    }
    return hi - lo > 0.02 ? [lo, hi] : null
  }
  // Short enough to look like a return, long enough to be worth building. A
  // leftover sliver is grown to this rather than dropped: it is grown INTO the
  // covering mass, where the extra length is interior and invisible, whereas
  // dropping it would put the hole back.
  const MIN_STRETCH = 0.55
  const walls = []
  for (const wl of masses.flatMap(rectWalls)) {
    const own = masses.find((mm) => mm.id === wl.massId)
    const ux = (wl.p1[0] - wl.p0[0]) / wl.len
    const uz = (wl.p1[1] - wl.p0[1]) / wl.len
    const stretch = (a0, c0, extra) => {
      // Overlap the joint by 8 cm. The cut already lands 2 cm inside the
      // covering mass; this is the margin that survives the warp field bellying
      // the two surfaces apart. A leftover shorter than MIN_STRETCH is grown to
      // it rather than dropped: it grows INTO the covering mass, where the extra
      // length is interior and invisible, whereas dropping it puts the hole back.
      const grow = Math.max(0.08, (MIN_STRETCH - (c0 - a0)) / 2)
      const a = Math.max(0, a0 - grow)
      const c = Math.min(wl.len, c0 + grow)
      walls.push({
        ...wl,
        p0: [wl.p0[0] + ux * a, wl.p0[1] + uz * a],
        p1: [wl.p0[0] + ux * c, wl.p0[1] + uz * c],
        len: c - a,
        buried: false,
        clipped: true,
        ...extra,
      })
    }
    const cuts = []
    let spans = [[0, wl.len]]
    for (const m of masses) {
      if (m.id === wl.massId) continue
      const cut = coverSpan(wl, m)
      if (!cut) continue
      cuts.push([Math.max(0, cut[0]), Math.min(wl.len, cut[1]), m])
      spans = spans.flatMap(([a, c]) => {
        if (c <= cut[0] || a >= cut[1]) return [[a, c]]
        const out = []
        if (cut[0] - a > 0.02) out.push([a, cut[0]])
        if (c - cut[1] > 0.02) out.push([cut[1], c])
        return out
      })
    }

    // WHAT THE COVERING MASS DOES NOT REACH.
    //
    // Being hidden in plan is not the same as being hidden. A wing two storeys
    // shorter than the hall it abuts hides the bottom of the hall's gable end
    // and leaves the top of it open to the sky -- and because the wall was never
    // drawn at all, the hole is above the wing's roof, where it is invisible
    // from outside and stares straight down into the room from inside. So for
    // every covered run, ask how high the cover actually gets and, where the
    // wall's own roof is higher than that, build the part above it.
    for (const [a0, c0, cov] of cuts) {
      if (c0 - a0 < 0.1) continue
      let ownTop = -Infinity
      let covTop = Infinity
      for (let i = 0; i <= 8; i++) {
        const a = a0 + (c0 - a0) * (i / 8)
        const x = wl.p0[0] + ux * a
        const z = wl.p0[1] + uz * a
        ownTop = Math.max(ownTop, roofHeightAt(own.roof, x, z))
        covTop = Math.min(covTop, roofHeightAt(cov.roof, x, z))
      }
      // 0.1 m of shortfall is the covering's own thickness and sag arguing with
      // a nominal plane, not a hole.
      if (ownTop <= covTop + 0.1) continue
      // Start it a hand's width BELOW the covering surface, so the two overlap
      // rather than meeting at a line the warp can pull apart.
      const y0 = Math.max(own.floorY, Math.min(covTop - 0.15, ownTop - 0.3))
      stretch(a0, c0, { y0, sliver: true })
    }

    if (!spans.length) {
      if (!walls.some((w) => w.massId === wl.massId && w.side === wl.side)) {
        walls.push({ ...wl, buried: true })
      }
      continue
    }
    if (spans.length === 1 && spans[0][0] === 0 && spans[0][1] === wl.len) {
      walls.push({ ...wl, buried: false })
      continue
    }
    for (const [a0, c0] of spans) stretch(a0, c0)
  }

  // The door: front wall of the main mass, in a bay, nudged off centre because
  // a perfectly centred door reads as a diagram.
  // The longest one: a frontage clipped by a wing that steps forward is two
  // stretches, and the door belongs on the one there is room to stand in front
  // of. Almost always there is only one.
  const frontWall = walls
    .filter((wl) => wl.massId === 0 && wl.side === 'front' && !wl.buried && !wl.sliver)
    .sort((a, c) => c.len - a.len)[0]
  const frontBays = Math.max(1, Math.round(frontWall.len / BAY))
  // Bays are numbered from p0, which is the -X end. Put the door at the end of
  // the frontage AWAY from any wing, so a wing that steps forward can never end
  // up standing over the porch that gets raised in front of the door.
  const wingSide = masses.find((m) => m.role === 'wing')?.cx ?? 0
  const doorFromLeft = wingSide <= 0
  const doorBay = frontBays === 1
    ? 0
    : (() => {
        const k = Math.floor(r() * Math.min(frontBays, 3))
        return doorFromLeft ? frontBays - 1 - k : k
      })()
  const bayCentre = (wl, i, n) => {
    const t = (i + 0.5) / n
    return [lerp(wl.p0[0], wl.p1[0], t), lerp(wl.p0[1], wl.p1[1], t)]
  }
  const [dx0, dz0] = bayCentre(frontWall, doorBay, frontBays)
  const door = {
    x: dx0, z: dz0, nx: 0, nz: 1,
    y0: floorY, width: DOOR_W, height: DOOR_H,
    runes: r() < K.runes,
    bay: doorBay,
  }

  const winHalf = (shutters) => windowHalfWidth({ width: WIN_W, shutters })
  // HOW MUCH WALL IS LEFT ABOVE A WINDOW, and what has to fit in it. The frame
  // stands 7 cm above the glass; a half-timber wall plate is 16 cm of timber
  // lying directly under the eaves; and 30 cm of daylight between the two is
  // what stops a window reading as jammed up under the roof.
  //
  // It was 0.35, measured to the top of the GLASS, which is 0.28 to the top of
  // the frame and 0.12 to the underside of the plate -- so on the tightest walls
  // the frame stopped exactly on the plate with nothing between them, and the
  // windows whose height that rule clipped ended up 12 cm INSIDE it. A window
  // with a beam laid across its head is the same defect as a window with a stud
  // through it, seen from the other axis.
  const HEAD_RESERVE = 0.55
  // A sill lower than this is a hatch, not a window. Nothing in the corpus
  // reaches it -- the shortest wall that carries a window is 2.13 m and slides
  // its sill to 0.70 -- so it is a bound rather than a working number.
  const MIN_SILL = 0.62
  // Daylight between a window's outermost timber and the corner post at the end
  // of the stretch it hangs on. A stave corner is 0.115 m of half-section, so
  // this is that plus a hand's width.
  const END_MARGIN = 0.24

  const windows = []
  for (let wi = 0; wi < walls.length; wi++) {
    const wl = walls[wi]
    // A sliver is the scrap of gable that pokes up above an abutting roof. It
    // starts above head height by construction and it looks out over next door's
    // shingles, so it gets no window and is not frontage.
    if (wl.buried || wl.sliver) continue
    const m = masses.find((mm) => mm.id === wl.massId)
    const bays = Math.max(1, Math.round(wl.len / BAY))
    const headroom = m.wallH - 1.35
    if (headroom < WIN_H * 0.6) continue // an outshut is too low for a window
    const ux = (wl.p1[0] - wl.p0[0]) / wl.len
    const uz = (wl.p1[1] - wl.p0[1]) / wl.len
    const onThisWall = []
    for (let i = 0; i < bays; i++) {
      if (wl === frontWall && i === doorBay) continue
      // `windows` is a per-kind density: the chance that any one bay is glazed.
      // Weighted by side because glass was expensive and nobody put a window in
      // the north gable to look at their own woodpile -- the frontage gets
      // them, the back wall mostly does not, and that asymmetry is most of what
      // makes a generated building read as having a front.
      const sideFactor = { front: 1, right: 0.62, left: 0.62, back: 0.4 }[wl.side]
      if (r() > windowDensity * sideFactor) continue
      const shutters = r() < 0.45
      // Rolled BEFORE the position, because the shutters are half of how much
      // room the window needs and the position has to answer to that.
      //
      // A corner post is up to 12 cm of timber and wants a hand's width of
      // daylight beside it, so `need` is how close to the end of this stretch
      // the centre of the window may come. A bay centre usually clears it
      // easily; what does not is a wall the plan has clipped down to a short
      // return, and pulling the window in beats hanging it through the corner.
      const need = winHalf(shutters) + END_MARGIN
      if (wl.len < 2 * need) continue
      const a = Math.min(Math.max((i + 0.5) / bays * wl.len, need), wl.len - need)
      if (onThisWall.some((p) => Math.abs(p[0] - a) < winHalf(shutters) + p[1] + 0.2)) continue
      onThisWall.push([a, winHalf(shutters)])
      const x = wl.p0[0] + ux * a
      const z = wl.p0[1] + uz * a
      // SLID DOWN, NOT CUT SHORT. The old rule kept the rolled sill and took the
      // height off the top, which is the wrong end: it made exactly the windows
      // that were closest to the eaves into the squat ones, and it is the head
      // that has somewhere else to be. Sliding the whole opening down instead
      // costs nothing anywhere in the corpus -- 300 of 834 windows move, none
      // loses a millimetre of height -- and the shrink is kept only as the bound
      // for a wall too short to slide in.
      const headMax = m.floorY + m.wallH - HEAD_RESERVE
      const sillY = Math.max(
        m.floorY + MIN_SILL,
        Math.min(m.floorY + m.wallH * range(r, [0.44, 0.52]), headMax - WIN_H))
      windows.push({
        x, z, nx: wl.n[0], nz: wl.n[1], massId: m.id, side: wl.side,
        // Which wall it hangs on, so the kit can ask that wall how low the
        // timber above it came out. The index is into `walls`, which is the
        // array this loop is walking and the one the plan hands back.
        wallIndex: wi,
        y0: sillY, width: WIN_W, height: Math.min(WIN_H, headMax - sillY),
        shutters,
      })
    }
  }

  // A building with no window at all on its front reads as abandoned. Force one
  // rather than re-rolling, because re-rolling would break seed determinism for
  // everything drawn after it.
  if (!windows.some((wn) => wn.side === 'front' && wn.massId === 0) && frontBays > 1) {
    const i = doorBay === 0 ? frontBays - 1 : 0
    // Held off the corner by the same margin the rolled windows keep, or the one
    // window a building is guaranteed to have is the one hung through its own
    // corner post. Unshuttered, so the margin is the narrow one.
    const need = winHalf(false) + END_MARGIN
    const a = Math.min(Math.max((i + 0.5) / frontBays * frontWall.len, need), frontWall.len - need)
    const t = a / frontWall.len
    // Same head reserve as a rolled window: this one is forced onto the frontage
    // and gets no say in whether it fits, so it is the one most likely to end up
    // under a wall plate if it is not slid down with the rest of them.
    const headMax = floorY + wallH - HEAD_RESERVE
    const y0 = Math.max(floorY + MIN_SILL, Math.min(floorY + wallH * 0.48, headMax - WIN_H))
    windows.push({
      x: lerp(frontWall.p0[0], frontWall.p1[0], t),
      z: lerp(frontWall.p0[1], frontWall.p1[1], t),
      nx: 0, nz: 1, massId: 0, side: 'front',
      wallIndex: walls.indexOf(frontWall),
      y0, width: WIN_W, height: Math.min(WIN_H, headMax - y0), shutters: false,
    })
  }

  // --- 5. attachments ------------------------------------------------------

  // The chimney rides a gable end of the main mass, offset in from the verge so
  // it visibly pierces the slope rather than clinging to the wall. Its base is
  // the roof surface at that point, computed with the same function parts.js
  // draws the slope from.
  const chSide = r() < 0.5 ? -1 : 1
  const chX = chSide * (main.w / 2 - range(r, [0.5, 0.95]))
  const chZ = range(r, [-0.22, 0.22]) * main.d
  const chBase = roofHeightAt(main.roof, chX, chZ)
  const chimney = {
    x: chX, z: chZ, baseY: chBase,
    topY: main.roof.ridgeY + range(r, [0.55, 1.0]),
    w: range(r, [0.55, 0.75]), d: range(r, [0.55, 0.75]),
  }

  const stepRise = floorY - doorGroundY
  const wantsPorch = stepRise > 0.5 || (kind === 'inn' && r() < 0.8) || r() < 0.25
  const porch = wantsPorch
    ? {
        x: door.x, z: d / 2, floorY,
        width: Math.min(2.6, DOOR_W + 1.3), depth: range(r, [1.1, 1.6]),
        headY: floorY + Math.min(wallH - 0.25, DOOR_H + 0.55),
      }
    : null
  const stepsPlan = stepRise > 0.12
    ? {
        x: door.x,
        z: d / 2 + (porch ? porch.depth : 0),
        topY: floorY,
        groundY: doorGroundY,
        width: DOOR_W + 0.35,
      }
    : null

  const footprint = hull(allCorners)
  const rooms = Math.max(1, Math.round(masses.reduce((s, m) => s + m.w * m.d, 0) / 17))

  return {
    seed, kind, shape, style, roofKind,
    masses, walls, footprint, overhang,
    door, windows,
    chimney, porch, steps: stepsPlan,
    floorY, plinthBottom, groundMin: gMin, groundMax: gMax,
    stats: {
      rooms,
      area: Math.round(masses.reduce((s, m) => s + m.w * m.d, 0)),
      windows: windows.length,
      exteriorWalls: walls.filter((wl) => !wl.buried && !wl.sliver).length,
      ridgeY: main.roof.ridgeY,
      width: Math.max(...allCorners.map((c) => c[0])) - Math.min(...allCorners.map((c) => c[0])),
      depth: Math.max(...allCorners.map((c) => c[1])) - Math.min(...allCorners.map((c) => c[1])),
    },
  }
}
