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

export const WALL_STYLES = ['log', 'stave', 'halfTimber', 'stoneBase']
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
    styles: ['log', 'stave', 'halfTimber', 'stoneBase'],
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
    styles: ['halfTimber', 'stoneBase', 'stave'],
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

  const walls = masses.flatMap(rectWalls)
  const buried = (wall) => {
    // A wall stretch is buried if another mass covers its midpoint just behind
    // the face. Cheap, and exact enough for axis-aligned rectangles.
    const mx = (wall.p0[0] + wall.p1[0]) / 2 + wall.n[0] * 0.05
    const mz = (wall.p0[1] + wall.p1[1]) / 2 + wall.n[1] * 0.05
    return masses.some(
      (m) =>
        m.id !== wall.massId &&
        Math.abs(mx - m.cx) < m.w / 2 - 0.02 &&
        Math.abs(mz - m.cz) < m.d / 2 - 0.02
    )
  }
  for (const wl of walls) wl.buried = buried(wl)

  // The door: front wall of the main mass, in a bay, nudged off centre because
  // a perfectly centred door reads as a diagram.
  const frontWall = walls.find((wl) => wl.massId === 0 && wl.side === 'front')
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

  const windows = []
  for (const wl of walls) {
    if (wl.buried) continue
    const m = masses.find((mm) => mm.id === wl.massId)
    const bays = Math.max(1, Math.round(wl.len / BAY))
    const headroom = m.wallH - 1.35
    if (headroom < WIN_H * 0.6) continue // an outshut is too low for a window
    for (let i = 0; i < bays; i++) {
      if (wl === frontWall && i === doorBay) continue
      // `windows` is a per-kind density: the chance that any one bay is glazed.
      // Weighted by side because glass was expensive and nobody put a window in
      // the north gable to look at their own woodpile -- the frontage gets
      // them, the back wall mostly does not, and that asymmetry is most of what
      // makes a generated building read as having a front.
      const sideFactor = { front: 1, right: 0.62, left: 0.62, back: 0.4 }[wl.side]
      if (r() > windowDensity * sideFactor) continue
      const [x, z] = bayCentre(wl, i, bays)
      const sillY = m.floorY + m.wallH * range(r, [0.44, 0.52])
      windows.push({
        x, z, nx: wl.n[0], nz: wl.n[1], massId: m.id, side: wl.side,
        y0: sillY, width: WIN_W, height: Math.min(WIN_H, m.wallH - (sillY - m.floorY) - 0.35),
        shutters: r() < 0.45,
      })
    }
  }

  // A building with no window at all on its front reads as abandoned. Force one
  // rather than re-rolling, because re-rolling would break seed determinism for
  // everything drawn after it.
  if (!windows.some((wn) => wn.side === 'front' && wn.massId === 0) && frontBays > 1) {
    const i = doorBay === 0 ? frontBays - 1 : 0
    const [x, z] = bayCentre(frontWall, i, frontBays)
    windows.push({
      x, z, nx: 0, nz: 1, massId: 0, side: 'front',
      y0: floorY + wallH * 0.48, width: WIN_W, height: WIN_H, shutters: false,
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
      exteriorWalls: walls.filter((wl) => !wl.buried).length,
      ridgeY: main.roof.ridgeY,
      width: Math.max(...allCorners.map((c) => c[0])) - Math.min(...allCorners.map((c) => c[0])),
      depth: Math.max(...allCorners.map((c) => c[1])) - Math.min(...allCorners.map((c) => c[1])),
    },
  }
}
