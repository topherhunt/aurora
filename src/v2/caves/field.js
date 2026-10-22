// The cave as a signed distance field (design/39-caves.md §4): positive in rock, negative in air, roughly metres. Pure, and deterministic from the graph, so the mesher (in a worker) and the walk surface (on the main thread) build identical copies and agree to the millimetre.
//
// Passages are vaults over a flat floor swept along each edge's samples, each edge in its own cross-section (passageForm). Nodes are ellipsoid domes cut by a floor. Each piece is misshapen by as many shape octaves as its size holds. The pieces join by a smooth min, so every junction gets a fillet instead of a crease.

import { Noise3 } from './noise3.js'
import { reliefAt } from './graph.js'
import { mulberry32 } from '../../sim/mathx.js'

const BIN = 8
// Smooth-min radius: how wide the fillet where two pieces of air meet. It also sags a shared floor by up to BLEND / 4, which is why a passage's own segments join by a hard min.
const BLEND = 0.8
// The wall noise is skipped deeper in rock than its whole carve (1.26 m), and farther into air than a 0.5 m voxel's crossing corner can sit. Occlusion's far samples read the uncarved distance.
const ROUGH = 1.3, AIRY = 1.3
const FAR = 50

// Metres a passage's floor rises into its walls.
const COVE = 0.9
// Metres from each end of a passage over which its form fades in, so it meets its chambers as a plain vault; and the headroom no form takes it under.
const FORM_FADE = 6
const FORM_H_MIN = 2.3

/** Edge e's cross-section, or null for the plain half-ellipse vault (a mouth's way in, a swim, a drop): wide and low, a round tube, or crumpled, any of them maybe leaning, its vault swaying side to side along it. Seeded by the edge, apart from the graph's own stream. */
function passageForm(seed, e, plain) {
  const rand = mulberry32(seed ^ Math.imul(e.i + 1, 0x2c9277b5))
  const kind = Math.floor(rand() * 4)
  const lean = rand() < 0.45 ? rr(rand, 0.25, 0.55) : 0
  if (plain || (kind === 0 && lean === 0)) return null
  return {
    fw: kind === 1 ? rr(rand, 1.3, 1.7) : kind === 2 ? 1.15 : 1,
    fh: kind === 1 ? 0.7 : 1,
    tube: kind === 2,
    crumple: kind === 3 ? rr(rand, 0.3, 0.5) : 0,
    lean, lf: rr(rand, 0.05, 0.13), lph: rand() * 6.28,
    total: e.pts[e.pts.length - 1].s,
  }
}
const rr = (rand, a, b) => a + (b - a) * rand()

const lowOf = (n) => (n.relief === undefined ? 0 : n.relief.lo)

// Metres a sky mouth's flare runs on past the exit before the sky plane, in steps of FLARE_STEP.
export const FLARE_M = 20
const FLARE_STEP = 2.5

/** Mouth n's flare: the passage running on outward behind it to the plane the room draws across its far end, { pts, end: { x, y, z }, w, h }. A sky mouth's wanders, swells and climbs over FLARE_M, seeded by its place, so she sees passage before sky; a cellar's runs straight to its door. */
export function mouthFlare(n) {
  const first = { x: n.x, y: n.y, z: n.z, w: 1.2, h: 2.6, cut: 0 }
  if (n.cellar) {
    const end = { x: n.x - n.dx * 2.4, y: n.y, z: n.z - n.dz * 2.4 }
    return { pts: [first, { ...end, w: 1.1, h: 2.5, cut: 0 }], end, w: 1.1, h: 2.5 }
  }
  const rand = mulberry32(Math.floor(n.x * 73.1 + n.z * 191.7) ^ 0xf1a7)
  const pts = [first]
  let side = 0, y = n.y
  for (let k = 1; k * FLARE_STEP <= FLARE_M; k++) {
    const t = (k * FLARE_STEP) / FLARE_M, d = k * FLARE_STEP
    side = Math.max(-1.5, Math.min(1.5, side + (rand() - 0.5) * 1.4))
    y += rand() * 0.35
    pts.push({ x: n.x - n.dx * d - n.dz * side, y, z: n.z - n.dz * d + n.dx * side, w: 1.3 + 1.2 * t + (rand() - 0.5) * 0.6, h: 2.7 + 0.9 * t + (rand() - 0.5) * 0.8, cut: 0 })
  }
  const end = pts[pts.length - 1]
  return { pts, end: { x: end.x, y: end.y, z: end.z }, w: end.w, h: end.h }
}

// Shape octaves (§4): feature sizes SHAPE_BASE·2^k metres, each up to SHAPE_AMP of its size deep, a room or passage taking every one whose size fits SHAPE_FIT times in its largest dimension. A room's are biased in by SHAPE_BIAS of their reach and push its wall in at full depth but carve it out at most SHAPE_CARVE, fading in over SHAPE_RISE above the floor: grown further it would reach the sumps and passages the graph kept clear of its rim, and at the floor its rim must stay where each passage's flat run ends, or her ramp starts with a ledge. A passage's only carve, so no lump comes under the headroom it was rolled for, and at most SHAPE_CARVE too, or a wide one's breaks through the SILL of rock (graph.js) over or under it.
const SHAPE_BASE = 0.625, SHAPE_AMP = 0.9, SHAPE_FIT = 3.6, SHAPE_OCT = 7, SHAPE_RISE = 5, SHAPE_CARVE = 2, SHAPE_BIAS = 0.2
const octavesOf = (dim) => { let k = 0; while (k < SHAPE_OCT && SHAPE_FIT * SHAPE_BASE * 2 ** k <= dim) k++; return k }
// The most an octave count's sum reaches either way.
const reachOf = (oct) => SHAPE_AMP * SHAPE_BASE * (2 ** oct - 1)
const roomOct = (n) => octavesOf(Math.max(2 * n.rx, 2 * n.rz, 1.05 * n.h))

// A passage vault's distance in metres to first order, from its normalised radius |(a, b)|. Scaled by its narrower axis instead, a carve or lump of a metre would reach h/w metres up a tall passage, through the SILL of rock (graph.js) the graph left over it.
const ell = (a, b, w, h) => { const q = Math.sqrt(a * a + b * b); return q < 1e-6 ? -Math.min(w, h) : ((q - 1) * q) / Math.sqrt((a / w) ** 2 + (b / h) ** 2) }

export class CaveField {
  constructor(graph, seed) {
    this.graph = graph
    this.noise = new Noise3(seed ^ 0x51ab)
    this.floorNoise = new Noise3(seed ^ 0x7e1d)
    const prims = []
    for (const n of graph.nodes) {
      const oct = roomOct(n), reach = oct > 0 ? SHAPE_CARVE : 0, r = Math.max(n.rx, n.rz) + reach
      prims.push({
        node: true, rough: 1, group: n.i, region: n.region, x: n.x, y: n.y, z: n.z, c: Math.cos(n.rot), s: Math.sin(n.rot), rx: n.rx, rz: n.rz, h: n.h, dish: n.dish, cavern: n.kind === 'cavern' && !n.great, owner: n, oct, bias: SHAPE_BIAS * reachOf(oct), deep: (1 + SHAPE_BIAS) * reachOf(oct), rise: Math.min(SHAPE_RISE, 0.5 * n.h),
        x0: n.x - r, x1: n.x + r, z0: n.z - r, z1: n.z + r, y0: n.y - Math.max(n.dish, -lowOf(n)) - 1, y1: n.y + n.h * 1.05 + reach,
      })
    }
    // A passage's octaves are its widest cross-section's, the same along its whole run so its segments meet without a step.
    const run = (pts, group, regionAt, rough, form = null) => {
      const gw = form === null ? 1 : form.fw + form.lean + form.crumple, gh = form === null ? 1 : Math.hypot(1, form.lean)
      const oct = rough < 1 ? 0 : octavesOf(Math.max(...pts.map((p) => Math.max(2 * p.w * gw, p.h * gh)))), full = reachOf(oct), reach = Math.min(full, SHAPE_CARVE)
      for (let k = 0; k + 1 < pts.length; k++) {
        const p = pts[k], q = pts[k + 1]
        const ex = q.x - p.x, ez = q.z - p.z
        const w = Math.max(p.w, q.w) * gw + reach, h = Math.max(p.h * gh, q.h * gh, form === null ? 0 : FORM_H_MIN) + reach
        prims.push({
          node: false, rough, group, region: regionAt(k), ca: p.cut, cb: q.cut, form, sa: p.s, sb: q.s, oct, full, reach,
          ax: p.x, az: p.z, ex, ez, il2: 1 / (ex * ex + ez * ez), len: Math.hypot(ex, ez), ya: p.y, yb: q.y, wa: p.w, wb: q.w, ha: p.h, hb: q.h,
          x0: Math.min(p.x, q.x) - w, x1: Math.max(p.x, q.x) + w, z0: Math.min(p.z, q.z) - w, z1: Math.max(p.z, q.z) + w,
          y0: Math.min(p.y, q.y) - 1, y1: Math.max(p.y, q.y) + h,
        })
      }
    }
    for (const e of graph.edges) {
      const ra = graph.nodes[e.a].region, rb = graph.nodes[e.b].region
      const swim = e.kind === 'sump' || e.kind === 'drowned'
      const plain = swim || e.kind === 'drop' || graph.nodes[e.a].kind === 'mouth' || graph.nodes[e.b].kind === 'mouth'
      run(e.pts, graph.nodes.length + e.i, (k) => (k < e.pts.length / 2 ? ra : rb), swim ? 0.3 : 1, passageForm(seed, e, plain))
    }
    let group = graph.nodes.length + graph.edges.length
    for (const l of graph.lobes) {
      const n = graph.nodes[l.node], oct = roomOct(l), reach = oct > 0 ? SHAPE_CARVE : 0, r = Math.max(l.rx, l.rz) + reach
      prims.push({
        node: true, rough: 1, group: group++, region: l.region, x: l.x, y: l.y, z: l.z, c: Math.cos(l.rot), s: Math.sin(l.rot), rx: l.rx, rz: l.rz, h: l.h, dish: 0, cavern: false, owner: n, oct, bias: SHAPE_BIAS * reachOf(oct), deep: (1 + SHAPE_BIAS) * reachOf(oct), rise: Math.min(SHAPE_RISE, 0.5 * l.h),
        x0: l.x - r, x1: l.x + r, z0: l.z - r, z1: l.z + r, y0: l.y + lowOf(n) - 1, y1: l.y + l.h * 1.05 + reach,
      })
    }
    for (const o of graph.nooks) run(o.pts, group++, () => o.region, 1)
    for (const n of graph.nodes) if (n.kind === 'mouth') run(mouthFlare(n).pts, group++, () => n.region, 1)
    const pad = BLEND + ROUGH
    for (const p of prims) { p.x0 -= pad; p.x1 += pad; p.z0 -= pad; p.z1 += pad; p.y0 -= pad; p.y1 += pad }
    this.prims = prims
    this.box = {
      x0: Math.min(...prims.map((p) => p.x0)), x1: Math.max(...prims.map((p) => p.x1)),
      y0: Math.min(...prims.map((p) => p.y0)), y1: Math.max(...prims.map((p) => p.y1)),
      z0: Math.min(...prims.map((p) => p.z0)), z1: Math.max(...prims.map((p) => p.z1)),
    }
    this.bx = Math.floor(this.box.x0 / BIN)
    this.bz = Math.floor(this.box.z0 / BIN)
    this.nbx = Math.floor(this.box.x1 / BIN) - this.bx + 1
    this.nbz = Math.floor(this.box.z1 / BIN) - this.bz + 1
    this.bins = Array.from({ length: this.nbx * this.nbz }, () => [])
    prims.forEach((p, i) => {
      for (let bz = Math.floor(p.z0 / BIN) - this.bz; bz <= Math.floor(p.z1 / BIN) - this.bz; bz++) {
        for (let bx = Math.floor(p.x0 / BIN) - this.bx; bx <= Math.floor(p.x1 / BIN) - this.bx; bx++) this.bins[bz * this.nbx + bx].push(i)
      }
    })
    // Which prim the last at() call found nearest: the mesher reads it for the region colour.
    this.owner = -1
    this._oct = new Float64Array(SHAPE_OCT)
    this._octN = 0
  }

  /** The prims whose padded boxes overlap a box: the mesher's per-chunk short list. */
  primsIn(x0, y0, z0, x1, y1, z1) {
    const out = []
    this.prims.forEach((p, i) => { if (p.x1 >= x0 && p.x0 <= x1 && p.y1 >= y0 && p.y0 <= y1 && p.z1 >= z0 && p.z0 <= z1) out.push(i) })
    return out
  }

  _bin(x, z) {
    const bx = Math.floor(x / BIN) - this.bx, bz = Math.floor(z / BIN) - this.bz
    if (bx < 0 || bz < 0 || bx >= this.nbx || bz >= this.nbz) return null
    return this.bins[bz * this.nbx + bx]
  }

  /** Signed distance at a point; `list` is an optional short list of prim indices to consider (from primsIn). */
  at(x, y, z, list) {
    const ids = list === undefined ? this._bin(x, z) : list
    this.owner = -1
    this._crumple = NaN
    this._bump = NaN
    this._octN = 0
    if (ids === null) return FAR
    // ids ascend, so a passage's segments arrive together: a hard min within the group, the smooth min between groups.
    // sw, sWall: each prim's wall weight blended by its nearness, so the carve has no seam where the nearest prim changes.
    let d = FAR, best = FAR, g = FAR, group = -1, sw = 0, sWall = 0
    const prims = this.prims
    for (let k = 0; k <= ids.length; k++) {
      const p = k < ids.length ? prims[ids[k]] : null
      if (p !== null && (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1 || y < p.y0 || y > p.y1)) continue
      if (p === null || p.group !== group) {
        const h = Math.max(BLEND - Math.abs(d - g), 0) / BLEND
        d = Math.min(d, g) - h * h * BLEND * 0.25
        if (p === null) break
        g = FAR
        group = p.group
      }
      const di = p.node ? this._node(p, x, y, z) : this._seg(p, x, y, z)
      if (di < g) g = di
      if (di < best) { best = di; this.owner = ids[k] }
      const v = this._v
      const wt = Math.exp(-6 * (di < -3 ? -3 : di))
      sw += wt
      sWall += wt * p.rough * (v < 0.3 ? 0 : v > 1.4 ? 1 : (v - 0.3) / 1.1)
    }
    if (d > ROUGH || d < -AIRY) return d
    // Roughness only ever carves, so no lump of rock comes lower than the shape a passage's headroom was rolled for. It fades out toward each prim's floor, which bump() roughens instead: carved, a floor would pit past her step.
    const wall = sWall / sw
    const n = this.noise
    // `crease` is ridged (an absolute value), so the rock between its grooves stands in sharp edges.
    const fine = 0.14 * (1 + n.at3(x * 0.9, y * 1.1, z * 0.9)) + 0.18 * Math.abs(n.at3(x * 0.55 + 23, y * 0.7, z * 0.55))
    if (wall === 0) return d - 0.25 * fine
    // Big lumps warped along the wall, so it bellies and folds rather than ripples, over the warp's own broader swell.
    const warp = n.at3(z * 0.15, y * 0.2, x * 0.15)
    const lump = 0.32 * (1 + n.at3((x + 1.5 * warp) * 0.3, y * 0.36, z * 0.3)) + 0.08 * (1 + warp)
    return d - wall * (lump + fine) - (1 - wall) * 0.25 * fine
  }

  /** The floor bump shared by every floor, so a passage meets its chamber without a step: broad swells and sharp ridged ledges. Never above the nominal floor, for the same reason. */
  bump(x, z) {
    const f = this.floorNoise
    return 0.18 * f.at2(x * 0.45, z * 0.45) + 0.1 * (1 - 2 * Math.abs(f.at2(x * 1.1 + 7, z * 1.1))) + 0.04 * f.at2(x * 3, z * 3) + 0.12 * (f.at2(x * 0.16 + 31, z * 0.16) - 1) + 0.06 * (Math.abs(f.at2(x * 0.75, z * 0.75 + 19)) - 1) - 0.32
  }

  // bump() at this at()'s point, read once however many prims ask: it is most of a prim's cost.
  _floorBump(x, z) {
    if (Number.isNaN(this._bump)) this._bump = this.bump(x, z)
    return this._bump
  }

  // The first `oct` shape octaves summed at this at()'s point, each octave's noise read once however many prims ask.
  _shape(x, y, z, oct) {
    const o = this._oct
    for (; this._octN < oct; this._octN++) {
      const k = this._octN, f = 1 / (SHAPE_BASE * 2 ** k)
      o[k] = SHAPE_AMP * SHAPE_BASE * 2 ** k * this.noise.at3(x * f + 61.3 * k + 90, y * f * 1.2 + 17.9 * k, z * f - 43.7 * k)
    }
    let sum = 0
    for (let k = 0; k < oct; k++) sum += o[k]
    return sum
  }

  _node(p, x, y, z) {
    const dx = x - p.x, dz = z - p.z
    const lx = (dx * p.c + dz * p.s) / p.rx, lz = (dz * p.c - dx * p.s) / p.rz
    const ry = 0.8 * p.h
    const ly = (y - p.y - 0.25 * p.h) / ry
    const q = Math.sqrt(lx * lx + lz * lz + ly * ly)
    const m = Math.min(p.rx, p.rz, ry)
    let shell = (q - 1) * m
    // Deeper than the octaves reach either way, the noise is skipped for the bound nearest the wall: a tracer only steps shorter.
    if (p.oct > 0 && shell < -3 - p.deep) shell += p.deep
    else if (p.oct > 0 && shell > 3 + SHAPE_CARVE) shell -= SHAPE_CARVE
    else if (p.oct > 0) {
      let s = this._shape(x, y, z, p.oct) - p.bias
      if (s > 0) s = SHAPE_CARVE * Math.tanh(s / SHAPE_CARVE) * Math.max(0, Math.min(1, (y - p.y) / p.rise))
      // In metres along the ray from the dome's centre: the shell's are its shortest axis's, which would stretch a carve along its longest.
      const r = Math.sqrt(dx * dx + dz * dz + (y - p.y - 0.25 * p.h) ** 2)
      shell -= r > 1e-6 ? (s * m * q) / r : s
    }
    // The octaves steepen the shell to ~3.7 m per metre, past what a sphere tracer's 0.8 step trusts: one from deep in a room would cross a wall into the void outside every prim. Past a metre off the wall it is squeezed back under that.
    if (p.oct > 0 && (shell < -1 || shell > 1)) shell = Math.sign(shell) * (1 + (Math.abs(shell) - 1) / (1.5 + 0.5 * p.oct))
    const rho2 = lx * lx + lz * lz
    let floor = p.y + this._floorBump(x, z) + reliefAt(p.owner, x, z)
    if (p.dish > 0) floor -= p.dish * Math.max(0, 1 - rho2 / 0.4356)
    // Swells in a cavern's floor, gone by its rim so a passage's ramp starts level with it.
    if (p.cavern) floor += 0.5 * this.floorNoise.at2(x * 0.11, z * 0.11) * Math.min(1, rho2 * 2, Math.max(0, (0.81 - rho2) / 0.3))
    this._v = y - floor
    return Math.max(shell, floor - y)
  }

  _seg(p, x, y, z) {
    const along = ((x - p.ax) * p.ex + (z - p.az) * p.ez) * p.il2
    const u = along < 0 ? 0 : along > 1 ? 1 : along
    const t = Math.hypot(x - p.ax - u * p.ex, z - p.az - u * p.ez)
    let w = p.wa + (p.wb - p.wa) * u, h = p.ha + (p.hb - p.ha) * u
    const f = p.form, s = p.sa + (p.sb - p.sa) * u
    const k = f === null ? 0 : Math.max(0, Math.min(1, s / FORM_FADE, (f.total - s) / FORM_FADE))
    if (k > 0) {
      w *= 1 + (f.fw - 1) * k
      h = Math.max(FORM_H_MIN, h * (1 + (f.fh - 1) * k) * (1 + (Math.hypot(1, f.lean) - 1) * k))
    }
    // The floor climbs a metre a metre into the rounded end caps: otherwise the lower of two segments on a climb shelves a terrace as far into the next as it is wide. The vault stays on the unclimbed floor, or a cap's lifted vault leaves a film of air at its neighbour's roof that reads as a floor.
    const over = (along < 0 ? -along : along > 1 ? along - 1 : 0) * p.len
    // The floor coves up into each wall, so where a passage climbs out of another's tube her foot finds a ramp instead of a ledge at the tube's edge.
    const side = t / w - 0.55
    let floor = p.ya + (p.yb - p.ya) * along + over + this._floorBump(x, z) + (side > 0 ? COVE * (side / 0.45) ** 2 : 0)
    const cut = p.ca + (p.cb - p.ca) * u
    if (cut > 0) floor -= cut * Math.max(0, 1 - (t / (0.55 * w)) ** 2)
    const v = y - floor
    this._v = v
    const fade = p.oct === 0 ? 0 : Math.max(0, Math.min(1, v / Math.min(SHAPE_RISE, 0.5 * h)))
    if (k === 0) {
      const a = t / w, b = (v + over) / h
      return Math.max(this._carve(p, fade, ell(a, b, w, h), x, y, z), -v)
    }
    // The vault's plan offset from the line: swayed by the lean, more the higher up it (her headroom over the line kept by h's hypot above), and folded by the crumple.
    const cross = ((x - p.ax) * p.ez - (z - p.az) * p.ex) / p.len
    let lat = cross - k * f.lean * w * (v / h) * Math.sin(s * f.lf + f.lph)
    if (f.crumple > 0) {
      if (Number.isNaN(this._crumple)) this._crumple = this.noise.at3(x * 0.4 + 50, y * 0.5, z * 0.4)
      lat += k * f.crumple * w * this._crumple
    }
    const r = Math.sqrt(Math.max(0, t * t - cross * cross) + lat * lat)
    // A tube's centre stands at 0.4 h, so its walls belly out over the floor.
    const c0 = f.tube ? 0.4 * h * k : 0
    const a = r / w, b = (v + over - c0) / (h - c0)
    return Math.max(this._carve(p, fade, ell(a, b, w, h - c0), x, y, z), -v)
  }

  // A passage's vault `e` carved by its shape octaves, 0 to p.full held under p.reach. Over 3 m from the wall the noise is skipped for the bound nearest it.
  _carve(p, fade, e, x, y, z) {
    if (fade === 0 || e < -3) return e
    if (e > 3 + p.reach) return e - p.reach * fade
    const c = 0.5 * (p.full + this._shape(x, y, z, p.oct))
    return e - fade * (p.full > SHAPE_CARVE ? SHAPE_CARVE * Math.tanh(c / SHAPE_CARVE) : c)
  }
}
