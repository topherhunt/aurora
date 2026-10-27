// Castle layouts: sections on a 4 m grid ringed round a court, every path their rooms, walks and roofs could hold, and the maze picked
// from those paths. Pure and deterministic per seed; positions are exterior metres about the castle's centre, and the interior is the
// same layout at CASTLE.scale about that centre, so a door inside lands on its door outside.
import { mulberry32 } from '../../sim/mathx.js'

export const CASTLE = { cell: 4, storey: 4, scale: 1.5, wallT: 2.4, trials: 60, minRoute: 12, minSwitches: 3 }
const C = CASTLE.cell, H = CASTLE.storey

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
  const add = (id, kind, x0, z0, w, d, floors) => { const s = { id, kind, x0, z0, w, d, floors }; secs.push(s); return s }

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
  // The lookout: a back corner raised, a tower against the keep's back, or one a cell behind it that only a bridge reaches.
  const lf = Math.min(8, Math.max(...secs.map((s) => s.floors)) + 2 + int(0, 1))
  const mode = rng()
  const look = mode < 0.4 ? Object.assign(corners[int(0, 1)], { id: 'L', kind: 'lookout', floors: lf })
    : add('L', 'lookout', kx0 + int(0, kw - 1), -kd - (mode < 0.7 ? 1 : 2), 1, 1, lf)
  let tn = 0
  for (const s of secs) if (s.id === 'T') s.id = `T${++tn}`

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
  const entry = node({ id: 'out', kind: 'entry', out: true, k: 0, pos: [X(gate.x0 + 0.5), 0.4, Z(gate.z0 + gate.d) + 6] })
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
    const [w, h] = look === 'gate' ? [2.6, 3.4] : [1.2, 2.4]
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
  // Stairs and roof ladders climb in a cell corner; a corner a stair arrives through is not reused for the next one up.
  const arrived = new Map()
  const corner = (s, k, cx, cz) => {
    let c = int(0, 3)
    if (arrived.get(`${s.id}|${k}|${cx},${cz}`) === c) c ^= 3
    return [c, X(cx) + (c & 1 ? C - 1.2 : 1.2), Z(cz) + (c & 2 ? C - 1.2 : 1.2)]
  }
  for (const s of solid) for (let k = 0; k < s.floors; k++) for (const r of s.rooms[k]) {
    const cx = int(r.x0, r.x0 + r.w - 1), cz = int(r.z0, r.z0 + r.d - 1)
    const [c, x, z] = corner(s, k, cx, cz)
    const up = k + 1 < s.floors ? roomAt(s, k + 1, cx, cz) : s.roof
    const kind = up === s.roof ? 'ladder' : 'stair'
    if (kind === 'stair') arrived.set(`${s.id}|${k + 1}|${cx},${cz}`, c)
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
      fixed.push({ a: from, b: r, kind: 'barred', doors: [d], pts: [from.pos, through(d), r.pos] })
    }
  }
  const flightPt = (axis, a, c, y) => (axis === 'x' ? [a, y, c] : [c, y, a])
  for (const w of secs) if (w.kind === 'wall') {
    const inn = w.inner[0] || w.inner[1]
    const starts = range(0, w.cells.length - 1).filter((i) => [i, i + 1].every((j) => isCourt(w.cells[j][0] + w.inner[0], w.cells[j][1] + w.inner[1])))
    if (!starts.length) continue
    const i = starts[int(0, starts.length - 1)], dir = rng() < 0.5 ? 1 : -1
    const A = w.axis === 'x' ? X : Z, B = w.axis === 'x' ? Z : X
    const g = w.cells[i][w.axis === 'x' ? 0 : 1], across = B(w.axis === 'x' ? w.z0 : w.x0) + C / 2 + inn * CASTLE.wallT / 2
    const a0 = A(dir > 0 ? g : g + 2), a1 = A(dir > 0 ? g + 2 : g), mid = across + inn * 0.7
    cand(courtNode, w.walk, 'outstair', {
      flight: { axis: w.axis, a0, a1, c0: across, c1: across + inn * 1.4, rise: 2 * H, landing: 0 },
      pts: [courtNode.pos, flightPt(w.axis, a0, mid, 0.4), flightPt(w.axis, a1, mid, 2 * H + 0.4), w.walk.pos],
    })
  }
  for (const s of solid) if (s.floors >= 2) for (const r of s.rooms[1]) {
    const open = facesOn(r, isCourt).filter(({ f, t }) => !groundDoor.has(`${f.axis}${f.at}|${t}`))
    if (!open.length || rng() < 0.4) continue
    const { f, t } = open[int(0, open.length - 1)], dir = rng() < 0.5 ? 1 : -1
    const along = f.axis === 'x' ? 'z' : 'x', A = along === 'x' ? X : Z
    const across = (f.axis === 'x' ? X : Z)(f.at), side = outOf(r, f), mid = across + side * 0.7
    const a0 = A(dir > 0 ? t : t + 1), a1 = A(dir > 0 ? t + 1 : t), at = a1 - dir * 0.8
    const [x, z] = f.axis === 'x' ? [across, at] : [at, across]
    const d = { x, y: H, z, axis: f.axis, w: 1.2, h: 2.4, look: 'door', side }
    cand(courtNode, r, 'outstair', {
      doors: [d], flight: { axis: along, a0, a1, c0: across, c1: across + side * 1.4, rise: H, landing: 1.6 },
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
    cand(ra, rb, 'bridge', { doors: [da, db], bridge: { axis: ax, a0: P(fa.at), a1: P(fb.at), c: (ax === 'x' ? Z : X)(t + 0.5), y: k * H }, pts: [ra.pos, through(da), through(db), rb.pos] })
  }
  // The way back down from the summit: a rope off the lookout's face farthest from the centre.
  const [lx0, lz0, lx1, lz1] = [X(look.x0), Z(look.z0), X(look.x0 + look.w), Z(look.z0 + look.d)]
  const [rx, rz] = [[(lx0 + lx1) / 2, lz0 - 0.3], [(lx0 + lx1) / 2, lz1 + 0.3], [lx0 - 0.3, (lz0 + lz1) / 2], [lx1 + 0.3, (lz0 + lz1) / 2]]
    .reduce((p, q) => (Math.hypot(...q) > Math.hypot(...p) ? q : p))
  fixed.push({ a: look.roof, b: entry, kind: 'rope', doors: [], rope: { x: rx, z: rz, top: look.floors * H }, pts: [look.roof.pos, [rx, look.floors * H + 0.6, rz], [rx, 0.4, rz], entry.pos] })

  const best = pickMaze(seed, nodes, rooms, cands, entry, look.roof)
  for (const n of nodes) n.unused = best.unused.has(n)
  const edges = [...best.pick, ...fixed]
  const onRoute = new Set(best.route.edges)
  for (const e of edges) e.onRoute = onRoute.has(e)
  const count = (list, f) => list.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {})
  return {
    seed, cw, cd, sections: secs, nodes, edges, X, Z,
    route: best.route,
    occAt: (x, z) => occ.get(key(x, z)) ?? null,
    stats: {
      ok: best.ok, trial: best.trial, rooms: rooms.length, outdoor: nodes.filter((n) => n.out && !n.unused).length,
      candidates: cands.length, edges: best.pick.size, loops: best.loops, routeEdges: best.route.edges.length,
      switches: best.switches, descents: best.descents, deadEnds: best.deadEnds, stranded: best.stranded,
      sections: count(secs, (s) => s.kind), kinds: count([...best.pick], (e) => e.kind), ms: performance.now() - t0,
    },
  }
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
