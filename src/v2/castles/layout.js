// Castle layouts: sections on a 4 m grid ringed round a court, every path their rooms, walks and roofs could hold, and the maze picked
// from those paths. Pure and deterministic per seed; positions are exterior metres about the castle's centre, and the interior is the
// same layout at CASTLE.scale across and CASTLE.tall upward about that centre, so a door inside lands on its door outside.
import { mulberry32 } from '../../sim/mathx.js'

// `raise`: how far the castle's floor (y 0) stands above the ground it is sited on (design/44-castles.md, Siting).
// `scale` and `tall`: interior metres per exterior metre, in plan and upward.
export const CASTLE = { cell: 4, storey: 4, scale: 2, tall: 1.5, wallT: 2.4, raise: 1.2, trials: 60, minRoute: 12, minSwitches: 3 }
const C = CASTLE.cell, H = CASTLE.storey
// A door's width and height, in metres outside and in alike (the interior does not scale doors). 2 m clears her 1.9 m crown over
// the exterior notch's 6 cm sill.
const DOOR = [0.96, 2]

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i)
const key = (x, z) => `${x},${z}`

/** The face two cell rects share, or null: the plane (axis, grid line `at`) and the overlapping cells [lo, hi) along it. */
function face(A, B) {
  for (const [ax, w, o, d] of [['x', 'w', 'z0', 'd'], ['z', 'd', 'x0', 'w']]) {
    const a0 = A[`${ax}0`], b0 = B[`${ax}0`]
    const at = a0 + A[w] === b0 ? b0 : b0 + B[w] === a0 ? a0 : null
    if (at === null) continue
    const lo = Math.max(A[o], B[o]), hi = Math.min(A[o] + A[d], B[o] + B[d])
    if (hi > lo) return { axis: ax, at, lo, hi }
  }
  return null
}
const contains = (r, x, z) => x >= r.x0 && x < r.x0 + r.w && z >= r.z0 && z < r.z0 + r.d
/** The cell of R that touches face f at t. */
const cellOf = (R, f, t) => (f.axis === 'x' ? [R.x0 === f.at ? f.at : f.at - 1, t] : [t, R.z0 === f.at ? f.at : f.at - 1])
/** Which way is out of R through f: -1 when R lies on the high side of the plane. */
const outOf = (R, f) => (R[`${f.axis}0`] === f.at ? -1 : 1)

export function castleLayout(seed) {
  const t0 = performance.now()
  const rng = mulberry32(Math.imul(seed, 2654435761) ^ 0x5bd1e995)
  const int = (a, b) => a + Math.floor(rng() * (b - a + 1))
  const secs = []
  const add = (id, kind, x0, z0, w, d, floors) => { const s = { id, kind, x0, z0, w, d, floors, round: false }; secs.push(s); return s }

  // The ring: court cells [0,cw) x [0,cd), corner towers, the keep on the back row (-z) pushed outward, the gate on the front (+z).
  const cw = int(3, 5), cd = int(3, 5)
  const corners = [[-1, -1], [cw, -1], [-1, cd], [cw, cd]].map(([cx, cz]) => {
    const n = rng() < 0.4 ? 2 : 1
    return add('T', 'tower', cx < 0 ? -n : cw, cz < 0 ? -n : cd, n, n, int(3, 5))
  })
  const kw = Math.min(cw, int(2, 4)), kd = int(2, 3), kx0 = int(0, cw - kw)
  add('K', 'keep', kx0, -kd, kw, kd, 4)
  const gate = add('G', 'gate', int(1, cw - 2), cd, 1, 2, 3)
  for (const x of [-1, cw]) if (cd >= 4 && rng() < 0.55) add('T', 'tower', x, int(1, cd - 2), 1, 1, int(3, 4))
  if (rng() < 0.6) add('H', 'hall', kx0, 0, kw, 1, 2)
  // The lookout, built into the castle: a back corner raised, or a tower against the keep's back.
  const lf = Math.min(8, Math.max(...secs.map((s) => s.floors)) + 2 + int(0, 1))
  const mode = rng()
  const look = mode < 0.4 ? Object.assign(corners[int(0, 1)], { id: 'L', kind: 'lookout', floors: lf })
    : add('L', 'lookout', kx0 + int(0, kw - 1), -kd - 1, 1, 1, lf)
  let tn = 0
  for (const s of secs) if (s.id === 'T') s.id = `T${++tn}`
  // Half the one-cell towers are round, from a stream of their own so the choice reshuffles nothing else.
  const roundRng = mulberry32(seed * 7919 + 17)
  for (const s of secs) s.round = (s.kind === 'tower' || s.kind === 'lookout') && s.w === 1 && s.d === 1 && roundRng() < 0.5

  const occ = new Map()
  for (const s of secs) for (let x = s.x0; x < s.x0 + s.w; x++) for (let z = s.z0; z < s.z0 + s.d; z++) {
    if (occ.has(key(x, z))) throw new Error(`castle ${seed}: ${s.id} overlaps ${occ.get(key(x, z)).id}`)
    occ.set(key(x, z), s)
  }
  // Curtain walls: the ring cells nothing else took, one section per straight run.
  let wn = 0
  const sides = [
    { cells: range(-1, cw + 1).map((x) => [x, -1]), axis: 'x', inner: [0, 1] },
    { cells: range(-1, cw + 1).map((x) => [x, cd]), axis: 'x', inner: [0, -1] },
    { cells: range(0, cd).map((z) => [-1, z]), axis: 'z', inner: [1, 0] },
    { cells: range(0, cd).map((z) => [cw, z]), axis: 'z', inner: [-1, 0] },
  ]
  for (const side of sides) {
    let run = []
    const flush = () => {
      if (!run.length) return
      const [x0, z0] = run[0]
      const w = add(`W${++wn}`, 'wall', x0, z0, side.axis === 'x' ? run.length : 1, side.axis === 'z' ? run.length : 1, 2)
      Object.assign(w, { axis: side.axis, inner: side.inner, cells: run })
      for (const [x, z] of run) occ.set(key(x, z), w)
      run = []
    }
    for (const c of side.cells) if (occ.has(key(...c))) flush(); else run.push(c)
    flush()
  }
  const court = new Set()
  for (let x = 0; x < cw; x++) for (let z = 0; z < cd; z++) if (!occ.has(key(x, z))) court.add(key(x, z))

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const s of secs) { minX = Math.min(minX, s.x0); maxX = Math.max(maxX, s.x0 + s.w); minZ = Math.min(minZ, s.z0); maxZ = Math.max(maxZ, s.z0 + s.d) }
  const ox = (minX + maxX) * C / 2, oz = (minZ + maxZ) * C / 2
  const X = (gx) => gx * C - ox, Z = (gz) => gz * C - oz
  const centre = (r, y) => [X(r.x0 + r.w / 2), y, Z(r.z0 + r.d / 2)]

  // Nodes: a room per section storey (split in two along a long side of 3+ cells), a walk per wall, a roof per section.
  const nodes = []
  const node = (n) => { nodes.push(n); return n }
  for (const s of secs) {
    if (s.kind === 'wall') { s.walk = node({ id: s.id, kind: 'walk', out: true, sec: s, k: 2, pos: centre(s, 2 * H + 0.4) }); continue }
    s.rooms = []
    for (let k = 0; k < s.floors; k++) {
      const long = Math.max(s.w, s.d), rects = []
      if (long >= 3 && rng() < 0.85) {
        const c = int(1, long - 1)
        if (s.w >= s.d) rects.push({ x0: s.x0, z0: s.z0, w: c, d: s.d }, { x0: s.x0 + c, z0: s.z0, w: s.w - c, d: s.d })
        else rects.push({ x0: s.x0, z0: s.z0, w: s.w, d: c }, { x0: s.x0, z0: s.z0 + c, w: s.w, d: s.d - c })
      } else rects.push({ x0: s.x0, z0: s.z0, w: s.w, d: s.d })
      s.rooms.push(rects.map((r, i) => node({ ...r, id: `${s.id}-${k}${rects.length > 1 ? 'ab'[i] : ''}`, kind: 'room', out: false, sec: s, k, pos: centre(r, k * H + 1.2) })))
    }
    s.roof = node({ id: `${s.id}^`, kind: s.kind === 'lookout' ? 'summit' : 'roof', out: true, sec: s, k: s.floors, pos: centre(s, s.floors * H + 0.4) })
  }
  const courtCells = [...court].map((c) => c.split(',').map(Number))
  const courtNode = node({ id: 'court', kind: 'court', out: true, k: 0, pos: [courtCells.reduce((a, c) => a + X(c[0] + 0.5), 0) / courtCells.length, 0.4, courtCells.reduce((a, c) => a + Z(c[1] + 0.5), 0) / courtCells.length] })
  const entry = node({ id: 'out', kind: 'entry', out: true, k: 0, pos: [X(gate.x0 + 0.5), 0.4 - CASTLE.raise, Z(gate.z0 + gate.d) + 4.5] })
  const rooms = nodes.filter((n) => n.kind === 'room')
  const solid = secs.filter((s) => s.kind !== 'wall')
  const roomAt = (s, k, x, z) => {
    const r = s.rooms[k].find((q) => contains(q, x, z))
    if (!r) throw new Error(`castle ${seed}: no room of ${s.id} storey ${k} at ${x},${z}`)
    return r
  }

  // Candidate edges, each carrying the geometry that builds it. Doors sit on a face at their storey's floor.
  const cands = [], fixed = [], seen = new Set()
  const cand = (a, b, kind, extra) => {
    const id = [a.id, b.id].sort().join('|') + kind
    if (seen.has(id)) return
    seen.add(id)
    cands.push({ a, b, kind, doors: [], ...extra })
  }
  const facePoint = (f, t) => (f.axis === 'x' ? [X(f.at), Z(t + 0.5)] : [X(t + 0.5), Z(f.at)])
  const door = (f, t, y, room, look = 'door') => {
    const [x, z] = facePoint(f, t)
    const [w, h] = look === 'gate' ? [2.6, 3.4] : DOOR
    return { x, y, z, axis: f.axis, w, h, look, side: outOf(room, f) }
  }
  const through = (d) => [d.x, d.y + 1.2, d.z]

  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
    const a = rooms[i], b = rooms[j]
    const f = a.k === b.k && face(a, b)
    if (!f) continue
    const d = door(f, int(f.lo, f.hi - 1), a.k * H, a)
    cand(a, b, 'door', { doors: [d], pts: [a.pos, through(d), b.pos] })
  }
  for (const w of secs) if (w.kind === 'wall') for (const s of solid) {
    const f = face(w, s)
    if (!f) continue
    const t = int(f.lo, f.hi - 1)
    if (s.floors > 2) {
      const r = roomAt(s, 2, ...cellOf(s, f, t)), d = door(f, t, 2 * H, r)
      cand(w.walk, r, 'door', { doors: [d], pts: [w.walk.pos, through(d), r.pos] })
    } else {
      const [x, z] = facePoint(f, t)
      cand(w.walk, s.roof, 'step', { pts: [w.walk.pos, [x, 2 * H + 0.4, z], s.roof.pos] })
    }
  }
  for (const a of solid) for (const b of solid) {
    const f = a !== b && face(a, b)
    if (!f) continue
    const t = int(f.lo, f.hi - 1)
    if (a.floors < b.floors) {
      const r = roomAt(b, a.floors, ...cellOf(b, f, t)), d = door(f, t, a.floors * H, r)
      cand(a.roof, r, 'door', { doors: [d], pts: [a.roof.pos, through(d), r.pos] })
    } else if (a.floors === b.floors && a.id < b.id) {
      const [x, z] = facePoint(f, t)
      cand(a.roof, b.roof, 'step', { pts: [a.roof.pos, [x, a.floors * H + 0.4, z], b.roof.pos] })
    }
  }
  // A spiral stair climbs about its cell's centre, so stairs stacked in one cell make one helix. A roof ladder stands in a corner,
  // or in a round room on an axis, either way clear of a spiral's drum in its cell (spiral.js SPIRAL).
  for (const s of solid) for (let k = 0; k < s.floors; k++) for (const r of s.rooms[k]) {
    const cx = int(r.x0, r.x0 + r.w - 1), cz = int(r.z0, r.z0 + r.d - 1), c = int(0, 3)
    const up = k + 1 < s.floors ? roomAt(s, k + 1, cx, cz) : s.roof
    const kind = up === s.roof ? 'ladder' : 'stair'
    const [x, z] = kind === 'stair' ? [X(cx + 0.5), Z(cz + 0.5)]
      : s.round ? [X(cx + 0.5) + [1.2, -1.2, 0, 0][c], Z(cz + 0.5) + [0, 0, 1.2, -1.2][c]]
        : [X(cx) + (c & 1 ? C - 1.2 : 1.2), Z(cz) + (c & 2 ? C - 1.2 : 1.2)]
    cand(r, up, kind, { [kind]: { x, z, k }, pts: [r.pos, [x, k * H + 0.4, z], [x, (k + 1) * H + 0.4, z], up.pos] })
  }
  // The ground: doors onto the court, the gate, and the lookout's barred door; flights up the court faces to walks and first floors.
  const facesOn = (r, test) => {
    const out = []
    for (let x = r.x0; x < r.x0 + r.w; x++) for (let z = r.z0; z < r.z0 + r.d; z++) for (const [dx, dz] of DIRS) {
      const nx = x + dx, nz = z + dz
      if (contains(r, nx, nz) || !test(nx, nz)) continue
      out.push(dx ? { f: { axis: 'x', at: dx > 0 ? x + 1 : x }, t: z } : { f: { axis: 'z', at: dz > 0 ? z + 1 : z }, t: x })
    }
    return out
  }
  const isCourt = (x, z) => court.has(key(x, z))
  const isOut = (x, z) => !occ.has(key(x, z)) && !court.has(key(x, z))
  const groundDoor = new Set()
  for (const s of solid) for (const r of s.rooms[0]) {
    const onCourt = facesOn(r, isCourt)
    if (onCourt.length) {
      const { f, t } = onCourt[int(0, onCourt.length - 1)], d = door(f, t, 0, r)
      groundDoor.add(`${f.axis}${f.at}|${t}`)
      cand(courtNode, r, 'door', { doors: [d], pts: [courtNode.pos, through(d), r.pos], forced: s === gate })
    }
    if (s === gate) {
      const { f, t } = facesOn(r, isOut).find((q) => q.f.axis === 'z' && q.f.at === gate.z0 + gate.d), d = door(f, t, 0, r, 'gate')
      cand(entry, r, 'gate', { doors: [d], pts: [entry.pos, through(d), r.pos], forced: true })
    }
    if (s === look) {
      const outside = facesOn(r, isOut), from = outside.length ? entry : courtNode
      const { f, t } = (outside.length ? outside : onCourt)[int(0, (outside.length || onCourt.length) - 1)], d = door(f, t, 0, r, 'barred')
      if (!outside.length) groundDoor.add(`${f.axis}${f.at}|${t}`)
      fixed.push({ a: from, b: r, kind: 'barred', doors: [d], pts: [from.pos, through(d), r.pos] })
    }
  }
  const flightPt = (axis, a, c, y) => (axis === 'x' ? [a, y, c] : [c, y, a])
  // Two flights may not share court: each claims its plan rect, and one that would overlap a claim is not offered.
  // A flight climbs at 32-40 deg in 0.2 m steps: a walk's over 3 cells, a first floor's over 2. FOOT of court before its foot stays
  // clear to turn onto it, its foot set in that far where the court stops at the flight's end.
  const FOOT = 1, STEP = 0.2
  const claimed = []
  const claim = (f) => {
    const foot = f.a0 - Math.sign(f.a1 - f.a0) * FOOT
    const [u0, u1, v0, v1] = [Math.min(foot, f.a1), Math.max(foot, f.a1), Math.min(f.c0, f.c1), Math.max(f.c0, f.c1)]
    const r = f.axis === 'x' ? [u0, v0, u1, v1] : [v0, u0, v1, u1]
    if (claimed.some((q) => r[0] < q[2] + 0.2 && q[0] < r[2] + 0.2 && r[1] < q[3] + 0.2 && q[1] < r[3] + 0.2)) return false
    claimed.push(r)
    return true
  }
  for (const w of secs) if (w.kind === 'wall') {
    const inn = w.inner[0] || w.inner[1], L = w.cells.length
    const courtAt = (j) => j >= 0 && j < L && isCourt(w.cells[j][0] + w.inner[0], w.cells[j][1] + w.inner[1])
    // The top lands mid-wall where the wall is long enough, never against the tower it ends on.
    const opts = range(0, L - 2).filter((i) => [i, i + 1, i + 2].every(courtAt)).flatMap((i) => [1, -1].map((dir) => ({ i, dir })))
      .filter(({ i, dir }) => L <= 3 || (dir > 0 ? i + 3 < L : i > 0))
    if (!opts.length) continue
    const { i, dir } = opts[int(0, opts.length - 1)], clear = courtAt(dir > 0 ? i - 1 : i + 3)
    const A = w.axis === 'x' ? X : Z, B = w.axis === 'x' ? Z : X
    const g = w.cells[i][w.axis === 'x' ? 0 : 1], across = B(w.axis === 'x' ? w.z0 : w.x0) + C / 2 + inn * CASTLE.wallT / 2
    const a0 = A(dir > 0 ? g : g + 3) + (clear ? 0 : dir * FOOT), a1 = A(dir > 0 ? g + 3 : g), mid = across + inn * 0.7
    const flight = { axis: w.axis, a0, a1, c0: across, c1: across + inn * 1.4, rise: 2 * H, steps: Math.round(2 * H / STEP), landing: 1.6 }
    if (!claim(flight)) continue
    cand(courtNode, w.walk, 'outstair', {
      flight,
      pts: [courtNode.pos, flightPt(w.axis, a0, mid, 0.4), flightPt(w.axis, a1, mid, 2 * H + 0.4), w.walk.pos],
    })
  }
  for (const s of solid) if (s.floors >= 2) for (const r of s.rooms[1]) {
    // The flight runs on along the face past the door's cell, against whatever stands there.
    const along1 = (f, t) => {
      const side = outOf(r, f), out = side > 0 ? f.at : f.at - 1, back = side > 0 ? f.at - 1 : f.at, free = !groundDoor.has(`${f.axis}${f.at}|${t}`)
      return f.axis === 'x' ? { court: isCourt(out, t), backed: free && occ.has(key(back, t)) } : { court: isCourt(t, out), backed: free && occ.has(key(t, back)) }
    }
    const open = facesOn(r, isCourt).filter(({ f, t }) => !groundDoor.has(`${f.axis}${f.at}|${t}`))
      .flatMap(({ f, t }) => [1, -1].map((dir) => ({ f, t, dir }))).filter(({ f, t, dir }) => { const q = along1(f, t - dir); return q.court && q.backed })
    if (!open.length || rng() < 0.4) continue
    const { f, t, dir } = open[int(0, open.length - 1)], clear = along1(f, t - 2 * dir).court
    const along = f.axis === 'x' ? 'z' : 'x', A = along === 'x' ? X : Z
    const across = (f.axis === 'x' ? X : Z)(f.at), side = outOf(r, f), mid = across + side * 0.7
    const a0 = A(dir > 0 ? t - 1 : t + 2) + (clear ? 0 : dir * FOOT), a1 = A(dir > 0 ? t + 1 : t), at = a1 - dir * 0.8
    const [x, z] = f.axis === 'x' ? [across, at] : [at, across]
    const d = { x, y: H, z, axis: f.axis, w: DOOR[0], h: DOOR[1], look: 'door', side }
    const flight = { axis: along, a0, a1, c0: across, c1: across + side * 1.4, rise: H, steps: Math.round(H / STEP), landing: 1.6 }
    if (!claim(flight)) continue
    cand(courtNode, r, 'outstair', {
      doors: [d], flight,
      pts: [courtNode.pos, flightPt(along, a0, mid, 0.4), flightPt(along, at, mid, H + 0.4), r.pos],
    })
  }
  // Bridges between facing sections up to four cells apart, high enough to clear whatever stands in the gap.
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) for (const ax of ['x', 'z']) {
    let [A, B] = [solid[i], solid[j]]
    const o = ax === 'x' ? 'z' : 'x', len = ax === 'x' ? 'w' : 'd', wid = ax === 'x' ? 'd' : 'w'
    if (B[`${ax}0`] < A[`${ax}0`]) [A, B] = [B, A]
    const gap = B[`${ax}0`] - (A[`${ax}0`] + A[len])
    const lo = Math.max(A[`${o}0`], B[`${o}0`]), hi = Math.min(A[`${o}0`] + A[wid], B[`${o}0`] + B[wid])
    if (gap < 1 || gap > 4 || hi <= lo) continue
    const t = int(lo, hi - 1)
    let tallest = 0
    for (let g = A[`${ax}0`] + A[len]; g < B[`${ax}0`]; g++) {
      const s = occ.get(ax === 'x' ? key(g, t) : key(t, g))
      if (s) tallest = Math.max(tallest, s.floors)
    }
    const kmin = Math.max(2, tallest + 1), kmax = Math.min(A.floors, B.floors) - 1
    if (kmin > kmax) continue
    const k = int(kmin, kmax)
    const fa = { axis: ax, at: A[`${ax}0`] + A[len] }, fb = { axis: ax, at: B[`${ax}0`] }
    const ra = roomAt(A, k, ...cellOf(A, fa, t)), rb = roomAt(B, k, ...cellOf(B, fb, t))
    const da = door(fa, t, k * H, ra), db = door(fb, t, k * H, rb)
    const P = ax === 'x' ? X : Z
    cand(ra, rb, 'bridge', { doors: [da, db], bridge: { axis: ax, a0: P(fa.at), a1: P(fb.at), c: (ax === 'x' ? Z : X)(t + 0.5), y: k * H, clear: tallest * H }, pts: [ra.pos, through(da), through(db), rb.pos] })
  }
  // The way back down from the summit: a rope a metre off the lookout's face farthest from the centre, clear of its flares.
  const [lx0, lz0, lx1, lz1] = [X(look.x0), Z(look.z0), X(look.x0 + look.w), Z(look.z0 + look.d)]
  const [rx, rz] = [[(lx0 + lx1) / 2, lz0 - 1], [(lx0 + lx1) / 2, lz1 + 1], [lx0 - 1, (lz0 + lz1) / 2], [lx1 + 1, (lz0 + lz1) / 2]]
    .reduce((p, q) => (Math.hypot(...q) > Math.hypot(...p) ? q : p))
  fixed.push({ a: look.roof, b: entry, kind: 'rope', doors: [], rope: { x: rx, z: rz, top: look.floors * H }, pts: [look.roof.pos, [rx, look.floors * H + 0.6, rz], [rx, 0.4 - CASTLE.raise, rz], entry.pos] })

  const best = pickMaze(seed, nodes, rooms, cands, entry, look.roof)
  for (const n of nodes) n.unused = best.unused.has(n)
  const edges = [...best.pick, ...fixed]
  const planned = planShafts(seed, secs, edges, X, Z, (x, z) => occ.get(key(x, z)) ?? null, isCourt, claimed)
  const onRoute = new Set(best.route.edges)
  for (const e of edges) e.onRoute = onRoute.has(e)
  const count = (list, f) => list.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {})
  return {
    seed, cw, cd, sections: secs, nodes, edges, X, Z, shafts: planned && planned.shafts, dungeon: planned && planned.dungeon,
    route: best.route,
    occAt: (x, z) => occ.get(key(x, z)) ?? null,
    stats: {
      ok: best.ok && planned !== null, trial: best.trial, rooms: rooms.length, outdoor: nodes.filter((n) => n.out && !n.unused).length,
      candidates: cands.length, edges: best.pick.size, loops: best.loops, routeEdges: best.route.edges.length,
      switches: best.switches, descents: best.descents, deadEnds: best.deadEnds, stranded: best.stranded,
      sections: count(secs, (s) => s.kind), kinds: count([...best.pick], (e) => e.kind), ms: performance.now() - t0,
    },
  }
}

// Cardinal c faces SIDES[c]: +x, +z, -x, -z, at bearing c * 90 deg (4c of a helix's 16 segments).
const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const mod16 = (v) => ((v % 16) + 16) % 16
// Where a doorway's centre may sit on a shaft storey, in segments from the start of the flight arriving (pass, top) or leaving
// (bottom), counted the way it climbs. A mouth spans its centre's segment and the one before, and lies wholly over flat floor with
// head room: on a bottom storey under treads high enough and short of the first, on a pass storey within its landing (whose end
// grows with L), on a top storey over its floor short of the hole.
const WINDOW = { bottom: [8, 15], pass: [16, 14], top: [16, 22] }
const LANDING_MAX = 9, SKEW = 1, GAP = 3
const LADDER_CLEAR = 3, REVEAL = 2.95 / CASTLE.scale

/**
 * The spiral shafts (design/44-castles.md, Spiral shafts). Every storey a helix climbs from or to is sealed round its cell: she
 * meets the drum only through a doorway, from a door in the cell's face or from the rest of her room. Each stair moves to the cell of
 * its room with the fewest doors on its faces (staying stacked on the stair below where it can), the dungeon's stair takes a ground
 * room's, then the doors that can slide along their face and the ladders leave sealed cells; a ladder whose room is all shaft stands
 * in the drum. Each helix then picks its hand, its first flight's start and the length of each landing (1-9 segments) so every
 * doorway falls in its window; null when no helix fits some cell's doorways. Mutates the stairs', doors' and ladders' positions in
 * `edges`.
 */
function planShafts(seed, secs, edges, X, Z, occAt, isCourt, claimed) {
  const cellAt = (x, z) => [Math.round((x - X(0)) / C - 0.5), Math.round((z - Z(0)) / C - 0.5)]
  const centreOf = (gx, gz) => [X(gx + 0.5), Z(gz + 0.5)]
  const cellsOf = (n) => { const out = []; for (let x = n.x0; x < n.x0 + n.w; x++) for (let z = n.z0; z < n.z0 + n.d; z++) out.push([x, z]); return out }
  const doorsOf = (n, k) => edges.filter((e) => e.a === n || e.b === n).flatMap((e) => e.doors).filter((d) => Math.abs(d.y - k * H) < 0.1 && d.look !== 'barred')
  /** The cardinal of cell (gx, gz)'s face door d stands in, or -1. */
  const faceOf = (gx, gz, d) => {
    const [x, z] = centreOf(gx, gz)
    return SIDES.findIndex(([sx, sz]) => d.axis === (sx ? 'x' : 'z') && Math.abs((sx ? (d.x - x) * sx : (d.z - z) * sz) - C / 2) < 0.01 && Math.abs(sx ? d.z - z : d.x - x) < C / 2 - 0.01)
  }
  const moveStair = (e, gx, gz) => {
    const [x, z] = centreOf(gx, gz)
    Object.assign(e.stair, { x, z })
    e.pts[1] = [x, e.pts[1][1], z]; e.pts[2] = [x, e.pts[2][1], z]
  }

  const stairs = edges.filter((e) => e.stair).sort((p, q) => p.stair.k - q.stair.k)
  for (const e of stairs) {
    const r = e.a, up = e.b, k = e.stair.k, below = stairs.find((q) => q.b === r)
    const doors = [...doorsOf(r, k), ...doorsOf(up, k + 1)]
    let best = null
    for (const [gx, gz] of cellsOf(r)) {
      if (!contains(up, gx, gz)) continue
      const [x, z] = centreOf(gx, gz)
      const cost = doors.filter((d) => faceOf(gx, gz, d) >= 0).length * 10 + (x === e.stair.x && z === e.stair.z ? 0 : 1)
        + (below && !(x === below.stair.x && z === below.stair.z) ? 5 : 0)
      if (!best || cost < best.cost) best = { cost, gx, gz }
    }
    moveStair(e, best.gx, best.gz)
  }

  // The dungeon's stair: in a corner tower's ground room when one is in use, continuing a spiral that rises from it, else in the
  // cell farthest from its doors. Drawn from the stream dungeonPlan goes on with.
  const drng = mulberry32(seed * 9151 + 5)
  const corners = secs.slice(0, 4).filter((s) => s.kind === 'tower' && !s.rooms[0][0].unused)
  const pool = corners.length ? corners : secs.filter((s) => s.kind !== 'wall' && s.kind !== 'gate' && s.rooms[0].some((r) => !r.unused))
  if (!pool.length) throw new Error(`castle ${seed}: no ground room for the dungeon stair`)
  const droom = pool[Math.floor(drng() * pool.length)].rooms[0].find((r) => !r.unused)
  const rising = stairs.find((e) => e.a === droom && e.stair.k === 0)
  let dungeon = rising ? { node: droom, x: rising.stair.x, z: rising.stair.z } : null
  if (!dungeon) {
    const doors = doorsOf(droom, 0)
    let far = -1
    for (const [gx, gz] of cellsOf(droom)) {
      const [x, z] = centreOf(gx, gz), d = Math.min(...doors.map((q) => Math.hypot(q.x - x, q.z - z)))
      if (d > far) { far = d; dungeon = { node: droom, x, z } }
    }
  }

  // Runs of stacked flights per cell; the dungeon's is flight k -1.
  const byCell = new Map()
  const run = (x, z) => { const kk = `${x},${z}`; if (!byCell.has(kk)) byCell.set(kk, { ks: new Set(), rooms: new Map() }); return byCell.get(kk) }
  for (const e of stairs) { const c = run(e.stair.x, e.stair.z); c.ks.add(e.stair.k); c.rooms.set(e.stair.k, e.a); c.rooms.set(e.stair.k + 1, e.b) }
  { const c = run(dungeon.x, dungeon.z); c.ks.add(-1); c.rooms.set(-1, null); c.rooms.set(0, dungeon.node) }
  const runs = [], sealed = new Set(), sk = (gx, gz, k) => `${gx},${gz},${k}`
  for (const [kk, c] of byCell) {
    const [x, z] = kk.split(',').map(Number), [gx, gz] = cellAt(x, z)
    for (const k of [...c.ks].sort((p, q) => p - q)) {
      const last = runs.at(-1)
      if (last && last.gx === gx && last.gz === gz && last.ks.at(-1) === k - 1) last.ks.push(k)
      else runs.push({ gx, gz, x, z, ks: [k], rooms: c.rooms })
    }
  }
  for (const r of runs) for (let k = r.ks[0]; k <= r.ks.at(-1) + 1; k++) sealed.add(sk(r.gx, r.gz, k))

  // Doors that can slide along their face to a cell no shaft seals, keeping the same rooms either side.
  const owns = (n, gx, gz) => (n.kind === 'room' ? contains(n, gx, gz) : n.kind === 'court' ? isCourt(gx, gz) : occAt(gx, gz) === n.sec)
  for (const e of edges) if (e.kind === 'door') {
    const d = e.doors[0], k = Math.round(d.y / H), alongX = d.axis === 'z'
    const sideCell = (t, s) => (d.axis === 'x' ? cellAt(d.x + s * C / 2, Z(t + 0.5)) : cellAt(X(t + 0.5), d.z + s * C / 2))
    const ok = (t) => [-1, 1].every((s) => {
      const [gx, gz] = sideCell(t, s), n = [e.a, e.b].find((q) => owns(q, gx, gz))
      return n && !(n.kind === 'room' && sealed.has(sk(gx, gz, k)))
    }) && [e.a, e.b].every((n) => [-1, 1].some((s) => owns(n, ...sideCell(t, s))))
    const t0 = cellAt(d.x, d.z)[alongX ? 0 : 1]
    if (ok(t0)) continue
    for (let m = 1; m < 6; m++) {
      const t = [t0 - m, t0 + m].find((q) => ok(q) && !(k === 0 && claimed.some((c) => {
        const [px, pz] = alongX ? [X(q + 0.5), d.z] : [d.x, Z(q + 0.5)]
        return px > c[0] - 0.9 && px < c[2] + 0.9 && pz > c[1] - 0.9 && pz < c[3] + 0.9
      })))
      if (t === undefined) continue
      const old = [d.x, d.y + 1.2, d.z]
      if (alongX) d.x = X(t + 0.5); else d.z = Z(t + 0.5)
      const i = e.pts.findIndex((p) => p[0] === old[0] && p[1] === old[1] && p[2] === old[2])
      if (i < 0) throw new Error(`castle ${seed}: door edge ${e.a.id}|${e.b.id} has no waypoint at its door`)
      e.pts[i] = [d.x, d.y + 1.2, d.z]
      break
    }
  }
  // A ladder stands in a cell of its room no shaft seals, LADDER_CLEAR interior metres from its room's doors on its storey: at a
  // corner, else on an axis (a round room's first choice), else the cell's centre (4 m from any door in its faces); where it is if
  // that is clear, else the clear spot nearest; with no unsealed cell, in the drum.
  const drumLadders = new Map()
  for (const e of edges) if (e.ladder) {
    const l = e.ladder, [gx, gz] = cellAt(l.x, l.z)
    const free = cellsOf(e.a).filter(([x, z]) => !sealed.has(sk(x, z, l.k)))
    if (!free.length) { drumLadders.set(sk(gx, gz, l.k), e); continue }
    const doors = edges.filter((f) => f.a === e.a || f.b === e.a).flatMap((f) => f.doors).filter((d) => Math.abs(d.y - l.k * H) < 0.1)
    const clear = ([x, z]) => doors.every((d) => {
      const [n, t] = d.axis === 'x' ? [x - d.x, z - d.z] : [z - d.z, x - d.x]
      return Math.hypot(n * CASTLE.scale, Math.max(0, Math.abs(t) * CASTLE.scale - d.w / 2)) >= LADDER_CLEAR
    })
    const q = C / 2 - 1.2, corners = [[-q, -q], [q, -q], [-q, q], [q, q]], axes = [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]
    const tiers = (e.a.sec.round ? [axes, [[0, 0]]] : [corners, axes, [[0, 0]]]).map((offs) => free.flatMap(([x, z]) => offs.map(([u, v]) => [X(x + 0.5) + u, Z(z + 0.5) + v])).filter(clear))
    const tier = tiers.find((t) => t.length)
    if (!tier) throw new Error(`castle ${seed}: no spot in ${e.a.id} stands its ladder ${LADDER_CLEAR} m from its doors`)
    const at = tier.sort((p, q) => Math.hypot(p[0] - l.x, p[1] - l.z) - Math.hypot(q[0] - l.x, q[1] - l.z))[0]
    ;[l.x, l.z] = at
    e.pts[1] = [l.x, e.pts[1][1], l.z]; e.pts[2] = [l.x, e.pts[2][1], l.z]
  }

  // Each run's storeys: the doors in its cell's faces, and the parts of its room no shaft seals that it must open onto.
  const pers = runs.map((r) => {
    const per = []
    for (let k = r.ks[0]; k <= r.ks.at(-1) + 1; k++) {
      const n = r.rooms.get(k), role = k === r.ks[0] ? 'bottom' : k === r.ks.at(-1) + 1 ? 'top' : 'pass'
      const doors = new Map(), comps = [], turn = new Map()
      if (n === null) {
        const [x, z] = centreOf(r.gx, r.gz)
        const c = Math.abs(x) >= Math.abs(z) ? (x > 0 ? 2 : 0) : (z > 0 ? 3 : 1)
        doors.set(c, []); turn.set(c, 0)
      } else {
        for (const d of doorsOf(n, k)) { const c = faceOf(r.gx, r.gz, d); if (c >= 0) doors.set(c, [...(doors.get(c) ?? []), d]) }
        // A door off its face's middle (an outstair's) turns its doorway toward it by whole segments, aimed where the tunnel meets
        // it at the reveal (spiral.js SHAFT.reveal): aimed at the face line, it slants too narrow to stand in.
        const [x, z] = centreOf(r.gx, r.gz)
        for (const [c, ds] of doors) {
          const [sx, sz] = SIDES[c], lat = (d) => (d.x - x) * -sz + (d.z - z) * sx
          const mid = (Math.min(...ds.map((d) => lat(d) - d.w / 2)) + Math.max(...ds.map((d) => lat(d) + d.w / 2))) / 2
          turn.set(c, Math.round(Math.atan2(mid, REVEAL) / (Math.PI / 8)))
        }
        const open = cellsOf(n).filter(([x, z]) => !sealed.has(sk(x, z, k))), seen = new Set()
        for (const [x0, z0] of open) {
          if (seen.has(`${x0},${z0}`)) continue
          const comp = [[x0, z0]]
          seen.add(`${x0},${z0}`)
          for (let i = 0; i < comp.length; i++) for (const [sx, sz] of SIDES) {
            const q = [comp[i][0] + sx, comp[i][1] + sz]
            if (!seen.has(`${q}`) && open.some(([x, z]) => x === q[0] && z === q[1])) { seen.add(`${q}`); comp.push(q) }
          }
          const faces = SIDES.map(([sx, sz], c) => (comp.some(([x, z]) => x === r.gx + sx && z === r.gz + sz) ? c : -1)).filter((c) => c >= 0)
          if (faces.length) comps.push(faces)
        }
      }
      const ladder = drumLadders.get(sk(r.gx, r.gz, k)) ?? null
      if (ladder && role !== 'top') throw new Error(`castle ${seed}: a ladder stands in a shaft's ${role} storey`)
      per.push({ k, role, node: n, doors, turn, comps, ladder, links: [] })
    }
    return per
  })
  // A top or bottom storey walled in by its room's other shafts tunnels through to the drum beside it, which opens back onto it.
  const storeyAt = new Map(runs.flatMap((r, i) => pers[i].map((p) => [sk(r.gx, r.gz, p.k), p])))
  runs.forEach((r, i) => pers[i].forEach((p) => {
    if (p.role === 'pass' || p.node === null || p.doors.size || p.comps.length || p.ladder) return
    const c = SIDES.findIndex(([sx, sz]) => contains(p.node, r.gx + sx, r.gz + sz) && storeyAt.has(sk(r.gx + sx, r.gz + sz, p.k)))
    if (c < 0) throw new Error(`castle ${seed}: the ${p.role} storey ${p.k} of the shaft in cell ${r.gx},${r.gz} has no way out`)
    p.links.push(c)
    storeyAt.get(sk(r.gx + SIDES[c][0], r.gz + SIDES[c][1], p.k)).links.push((c + 2) % 4)
  }))

  const shafts = runs.map((r, ri) => {
    const per = pers[ri]
    let best = null
    for (const hand of [1, -1]) {
      const plan = solveShaft(per, hand)
      if (plan && (!best || plan.cost < best.cost)) best = { ...plan, hand }
    }
    if (!best) return null
    const { hand, A, L } = best
    const flights = r.ks.map((k, i) => ({ k, s: mod16(hand * A[i]), L: L[i] ?? 0 }))
    const storeys = per.map((p, i) => {
      const a = p.role === 'bottom' ? A[0] : A[i - 1], exits = exitsOf(p, hand, ...windowOf(p.role, a, L[i - 1]))
      if (p.ladder) {
        const b = hand * ladderSeg(exits, hand, a) * Math.PI / 8, l = p.ladder.ladder, [x, z] = centreOf(r.gx, r.gz)
        Object.assign(l, { x: x + Math.cos(b) * 0.55, z: z + Math.sin(b) * 0.55, yaw: b + Math.PI / 2 })
        p.ladder.pts[1] = [l.x, p.ladder.pts[1][1], l.z]; p.ladder.pts[2] = [l.x, p.ladder.pts[2][1], l.z]
        // The summit's chest stands across the drum from the hatch; its pos is shared by reference with every edge's waypoints.
        if (p.ladder.b.kind === 'summit') { const top = p.ladder.b.pos; top[0] = x - Math.cos(b) * 0.9; top[2] = z - Math.sin(b) * 0.9 }
      }
      return { k: p.k, role: p.role, node: p.node, exits }
    })
    return { gx: r.gx, gz: r.gz, x: r.x, z: r.z, hand, flights, storeys }
  })
  return shafts.includes(null) ? null : { shafts, dungeon }
}

/** A storey's doorway window [lo, hi] in the helix's own (handed) segments, from its flight's start `a` and its landing `L`. */
function windowOf(role, a, L) {
  const [lo, hi] = WINDOW[role]
  return [a + lo, a + hi + (role === 'pass' ? L : 0)]
}

/** Storey `p`'s doorways for hand `hand` and window [lo, hi]: per door face, link and part of the room a cardinal c and the
 * doorway's centre segment o, skewed up to SKEW segments off the one facing it (a door's turn included), its tunnel slanting
 * through the stone; doorways GAP apart, the least total skew; null when they cannot all fall inside. */
function exitsOf(p, hand, lo, hi) {
  const want = [...p.doors].map(([c, doors]) => [{ c, kind: 'door', doors, at: 4 * c + p.turn.get(c) }])
  for (const c of new Set(p.links)) if (!p.doors.has(c)) want.push([{ c, kind: 'link', at: 4 * c }])
  for (const faces of p.comps) if (!faces.some((c) => p.doors.has(c))) want.push(faces.map((c) => ({ c, kind: 'room', at: 4 * c })))
  if (hi < lo) return want.length ? null : []
  const off = (o) => mod16(hand * o - lo), apart = (o, exits) => exits.every((x) => { const d = mod16(o - x.o); return Math.min(d, 16 - d) >= GAP })
  let best = null
  const pick = (i, exits, cost) => {
    if (best && cost >= best.cost) return
    if (i === want.length) { best = { cost, exits }; return }
    for (const { at, ...w } of want[i]) for (let d = -SKEW; d <= SKEW; d++) {
      const o = mod16(at + d)
      if (off(o) <= hi - lo && !exits.some((x) => x.c === w.c) && apart(o, exits)) pick(i + 1, [...exits, { ...w, o }], cost + Math.abs(d))
    }
  }
  pick(0, [], 0)
  return best && best.exits
}

/** Where a top storey's ladder stands in the drum, in handed segments: over the floor (1-6 past the arriving flight's start `a`),
 * two clear of every doorway, nearest the floor's middle; null when no such bearing. */
function ladderSeg(exits, hand, a) {
  const gap = (v, o) => { const d = mod16(v - hand * o); return Math.min(d, 16 - d) }
  return [4, 3, 5, 2, 6, 1].map((u) => a + u).find((v) => exits.every((x) => gap(v, x.o) >= 2)) ?? null
}

/** The least total landing over a run's storeys `per` that opens every door and each part of the room within its storey's window,
 * with a top storey's drum ladder clear of them, for helix hand `hand`: { cost, A (each flight's start), L (each landing) }, or null. */
function solveShaft(per, hand) {
  const fits = (p, lo, hi, a) => { const ex = exitsOf(p, hand, lo, hi); return ex !== null && (!p.ladder || ladderSeg(ex, hand, a) !== null) }
  // State: the start of the flight leaving the storey reached, and the cheapest way there.
  let states = new Map()
  for (let a = 0; a < 16; a++) if (fits(per[0], ...windowOf('bottom', a))) states.set(a, { cost: 0, A: [a], L: [] })
  for (const p of per.slice(1)) {
    const next = new Map()
    for (const [a, s] of states) {
      if (p.role === 'top') {
        if (fits(p, ...windowOf('top', a), a) && (!next.has(-1) || s.cost < next.get(-1).cost)) next.set(-1, s)
        continue
      }
      for (let L = 1; L <= LANDING_MAX; L++) {
        if (!fits(p, ...windowOf('pass', a, L))) continue
        const a2 = mod16(a + 15 + L), v = { cost: s.cost + L, A: [...s.A, a + 15 + L], L: [...s.L, L] }
        if (!next.has(a2) || v.cost < next.get(a2).cost) next.set(a2, v)
      }
    }
    states = next
  }
  return [...states.values()].sort((p, q) => p.cost - q.cost)[0] ?? null
}

/** Random spanning trees over the candidates, leaf roofs dropped, loops added back while the gate-to-summit route stays long; the best of CASTLE.trials. */
function pickMaze(seed, nodes, rooms, cands, entry, summit) {
  const idx = new Map(nodes.map((n, i) => [n, i]))
  const forced = cands.filter((e) => e.forced), free = cands.filter((e) => !e.forced)
  const degrees = (pick) => {
    const d = new Map()
    for (const e of pick) for (const n of [e.a, e.b]) d.set(n, (d.get(n) ?? 0) + 1)
    return d
  }
  const path = (pick, from, to) => {
    const adj = new Map()
    for (const e of pick) for (const [p, q] of [[e.a, e.b], [e.b, e.a]]) { if (!adj.has(p)) adj.set(p, []); adj.get(p).push([q, e]) }
    const prev = new Map([[from, null]]), queue = [from]
    for (let i = 0; i < queue.length; i++) for (const [q, e] of adj.get(queue[i]) ?? []) if (!prev.has(q)) { prev.set(q, [queue[i], e]); queue.push(q) }
    if (!prev.has(to)) return { reach: prev, nodes: null, edges: [] }
    const ns = [to], es = []
    for (let n = to; prev.get(n); n = prev.get(n)[0]) { es.unshift(prev.get(n)[1]); ns.unshift(prev.get(n)[0]) }
    return { reach: prev, nodes: ns, edges: es }
  }
  let best = null
  for (let trial = 0; trial < CASTLE.trials; trial++) {
    const r = mulberry32(Math.imul(seed + 1, 40503) + trial * 7919)
    const order = free.map((e) => [r(), e]).sort((p, q) => p[0] - q[0]).map((p) => p[1])
    const parent = nodes.map((_, i) => i)
    const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
    const pick = new Set(), spare = []
    const join = (e) => {
      const a = find(idx.get(e.a)), b = find(idx.get(e.b))
      if (a === b) return false
      parent[a] = b
      pick.add(e)
      return true
    }
    for (const e of forced) join(e)
    for (const e of order) if (!join(e)) spare.push(e)
    const unused = new Set(), deg = degrees(pick)
    for (const e of [...pick]) for (const n of [e.a, e.b]) if (n.kind === 'roof' && deg.get(n) === 1 && r() < 0.6) { pick.delete(e); unused.add(n) }
    // A one-cell room its spiral's drum fills (planShafts) is a dead end when the stair is all that reaches it: it takes one of its
    // other ways in instead, or stands closed when it has none, and the room it led from may become such a dead end in turn.
    for (let more = true; more;) {
      more = false
      for (const n of rooms) {
        if (unused.has(n) || n.w * n.d !== 1) continue
        const mine = [...pick].filter((e) => e.a === n || e.b === n)
        if (mine.length !== 1 || !mine[0].stair) continue
        const alts = free.filter((e) => !e.stair && (e.a === n || e.b === n) && !unused.has(e.a === n ? e.b : e.a))
        pick.delete(mine[0])
        if (alts.length) pick.add(alts[Math.floor(r() * alts.length)]); else unused.add(n)
        more = true
      }
    }
    let route = path(pick, entry, summit)
    const floor = Math.max(CASTLE.minRoute, route.edges.length * 0.85)
    let loops = 0
    for (const e of spare) {
      if (loops >= Math.round(rooms.length * 0.12)) break
      if (unused.has(e.a) || unused.has(e.b)) continue
      pick.add(e)
      const next = path(pick, entry, summit)
      if (next.edges.length >= floor) { route = next; loops++ } else pick.delete(e)
    }
    const stranded = nodes.filter((n) => !unused.has(n) && !route.reach.has(n)).length
    let switches = 0, descents = 0
    const seq = route.nodes ?? []
    for (let i = 1; i < seq.length; i++) {
      if (seq[i].out !== seq[i - 1].out) switches++
      if (seq[i].pos[1] < seq[i - 1].pos[1] - 1) descents++
    }
    const d = degrees(pick), deadEnds = rooms.filter((n) => d.get(n) === 1).length
    const ok = stranded === 0 && route.edges.length >= CASTLE.minRoute && switches >= CASTLE.minSwitches && descents >= 1
    const score = (ok ? 1000 : 0) + route.edges.length + 1.5 * switches + 2 * Math.min(descents, 3)
    if (!best || score > best.score) best = { score, ok, pick, unused, route, switches, descents, deadEnds, loops, stranded, trial }
  }
  return best
}
