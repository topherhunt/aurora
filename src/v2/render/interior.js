// A leafkin house's inside, meshed from rollInterior (design/30-leafkin.md, Interiors): one merged mesh per texture, lit by a per-vertex bake of ambient, candle and window light that three uniforms scale each frame, plus the flames. Everything is built in room-local metres and the group is set at the room's anchor.
import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { FILLET, angDiff, ceilingAt, loftDepthAt, rAt, smooth } from '../rooms/interior.js'

const TAU = 2 * Math.PI
const TEX = ['floor', 'wall', 'grain', 'linen', 'door', 'window']
const REPEAT = new Set(['wall', 'grain', 'linen'])
// Texture metres per repeat on the wall and on carved wood.
const WALL_M = 0.9, WOOD_M = 0.35
const FLAT = [0.5, 0.5]

let texReady = null
/** The interior textures, loaded once. */
export function loadInteriorTextures() {
  texReady ??= Promise.all(TEX.map((id) => new THREE.TextureLoader().loadAsync(`interiors/${id}.webp`).then((t) => {
    t.colorSpace = THREE.SRGBColorSpace
    if (REPEAT.has(id)) t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 4
    return [id, t]
  }))).then(Object.fromEntries)
  return texReady
}

const VERT = /* glsl */ `
attribute vec2 tuv;
attribute vec3 tint;
attribute vec3 light;
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vLight;
void main() {
  vUv = tuv;
  vTint = tint;
  vLight = light;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uAmb;
uniform float uCandle;
uniform float uWin;
uniform float uDay;
uniform float uFlicker;
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vLight;
void main() {
  vec3 t = texture2D(map, vUv).rgb;
  float lit = uAmb * vLight.x + uCandle * vLight.y * uFlicker + uWin * vLight.z * (0.15 + 0.85 * uDay);
  gl_FragColor = vec4(t * vTint * lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

/** Linear rgb for an sRGB hsl, mixed `white` of the way to white: textured surfaces take a wash of their tint, not the whole colour. */
function rgb(h, s, l, white = 0) {
  const c = new THREE.Color().setHSL(((h % 1) + 1) % 1, s, l, THREE.SRGBColorSpace)
  return [c.r + (1 - c.r) * white, c.g + (1 - c.g) * white, c.b + (1 - c.b) * white]
}
const hsl = (t, white = 0) => rgb(t.h, t.s, t.l, white)

/** One merged mesh's buffers. `tri` winds each triangle to face its vertices' normals, so no builder has to. */
class Mesher {
  constructor() {
    this.pos = []
    this.nrm = []
    this.uv = []
    this.tint = []
    this.idx = []
    this.lit = null
  }

  get count() { return this.pos.length / 3 }

  v(p, n, uv, tint) {
    this.pos.push(p[0], p[1], p[2])
    this.nrm.push(n[0], n[1], n[2])
    this.uv.push(uv[0], uv[1])
    this.tint.push(tint[0], tint[1], tint[2])
    return this.count - 1
  }

  tri(a, b, c) {
    const P = this.pos, N = this.nrm
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2]
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2]
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
    const nx = N[a * 3] + N[b * 3] + N[c * 3], ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2]
    if (fx * nx + fy * ny + fz * nz < 0) this.idx.push(a, c, b)
    else this.idx.push(a, b, c)
  }

  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d) }

  /** A (cols+1) x (rows+1) grid of `at(i, j)` -> { p, uv, n? }; normals by finite difference where not given, faced the way `sign` says (+1: Tu x Tv). */
  grid(cols, rows, at, tint, sign, wrap = false) {
    const pts = []
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) pts.push(at(i, j))
    const P = (i, j) => pts[j * (cols + 1) + i].p
    const base = this.count
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const q = pts[j * (cols + 1) + i]
        let n = q.n
        if (!n) {
          const il = i > 0 ? i - 1 : wrap ? cols - 1 : 0, ir = i < cols ? i + 1 : wrap ? 1 : cols
          const jd = Math.max(0, j - 1), ju = Math.min(rows, j + 1)
          n = cross(sub(P(ir, j), P(il, j)), sub(P(i, ju), P(i, jd)))
          const len = Math.hypot(n[0], n[1], n[2])
          n = len < 1e-9 ? [0, 1, 0] : [(n[0] / len) * sign, (n[1] / len) * sign, (n[2] / len) * sign]
        }
        this.v(q.p, n, q.uv, q.tint ?? tint)
      }
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = base + j * (cols + 1) + i
        this.quad(a, a + 1, a + cols + 2, a + cols + 1)
      }
    }
  }
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Local -> room frame: a position and a yaw (three's rotation.y). */
const frame = (x, y, z, yaw = 0) => ({ x, y, z, c: Math.cos(yaw), s: Math.sin(yaw) })
const put = (F, lx, ly, lz) => [F.x + lx * F.c + lz * F.s, F.y + ly, F.z - lx * F.s + lz * F.c]
const turn = (F, nx, ny, nz) => [nx * F.c + nz * F.s, ny, -nx * F.s + nz * F.c]

/** The build kit: every call adds to `m`, in frame `F`, jittered by `rng`. */
function kit(rng) {
  const j = (a) => (rng() * 2 - 1) * a

  /** A profile of [r, y] revolved about the frame's y, from the axis at the bottom up to the axis at the top; a repeated point is a hard edge. `sx`/`sz` squash it, `rough` wobbles its radius. */
  function lathe(m, F, prof, tint, { segs = 12, rough = 0, sx = 1, sz = 1, uvM = WOOD_M, flat = false, phase = 0 } = {}) {
    const wob = Array.from({ length: segs }, () => prof.map(() => 1 + j(rough)))
    const len = [0]
    for (let k = 1; k < prof.length; k++) len.push(len[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]))
    const around = Math.max(1, Math.round((TAU * Math.max(...prof.map((p) => p[0]))) / uvM))
    const base = m.count
    for (let i = 0; i <= segs; i++) {
      const q = phase + (i / segs) * TAU, cq = Math.cos(q), sq = Math.sin(q)
      for (let k = 0; k < prof.length; k++) {
        const [r0, y] = prof[k], r = r0 * wob[i % segs][k]
        const prev = prof[Math.max(0, k - 1)], next = prof[Math.min(prof.length - 1, k + 1)]
        const same = (a, b) => a[0] === b[0] && a[1] === b[1]
        const t = same(prev, prof[k]) ? sub2(next, prof[k]) : same(next, prof[k]) ? sub2(prof[k], prev) : sub2(next, prev)
        const tl = Math.hypot(t[0], t[1]) || 1
        const nr = t[1] / tl, ny = -t[0] / tl
        const n = turn(F, cq * nr / sx, ny, sq * nr / sz)
        m.v(put(F, cq * r * sx, y, sq * r * sz), norm(n), flat ? FLAT : [(i / segs) * around, len[k] / uvM], tint)
      }
    }
    const K = prof.length
    for (let i = 0; i < segs; i++) {
      for (let k = 0; k < K - 1; k++) {
        const a = base + i * K + k
        m.quad(a, a + K, a + K + 1, a + 1)
      }
    }
  }
  const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]]

  /** Eight corners, bottom ring then top ring, as a rough carved block: flat faces, each textured along its own edges. */
  function hexa(m, c, tint, { uvM = WOOD_M, flat = false } = {}) {
    const mid = c.reduce((s, p) => [s[0] + p[0] / 8, s[1] + p[1] / 8, s[2] + p[2] / 8], [0, 0, 0])
    const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
    for (const f of faces) {
      const p = f.map((k) => c[k])
      let n = norm(cross(sub(p[2], p[0]), sub(p[3], p[1])))
      const fc = [(p[0][0] + p[2][0]) / 2, (p[0][1] + p[2][1]) / 2, (p[0][2] + p[2][2]) / 2]
      if (dot(n, sub(fc, mid)) < 0) n = [-n[0], -n[1], -n[2]]
      const e1 = norm(sub(p[1], p[0])), e2 = cross(n, e1)
      const ids = p.map((q) => m.v(q, n, flat ? FLAT : [dot(sub(q, p[0]), e1) / uvM, dot(sub(q, p[0]), e2) / uvM], tint))
      m.quad(...ids)
    }
  }

  /** A box centred at local (cx, cy, cz), half-sizes h, its corners jittered `rough`. */
  function box(m, F, cx, cy, cz, hx, hy, hz, tint, { rough = 0.01, ...o } = {}) {
    const c = []
    for (const y of [-1, 1]) for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) c.push(put(F, cx + x * hx + j(rough), cy + y * hy + j(rough * 0.5), cz + z * hz + j(rough)))
    hexa(m, c, tint, o)
  }

  /** A tapered rod from p0 to p1 (room frame). */
  function rod(m, p0, p1, r0, r1, tint, { segs = 6, rough = 0, flat = false, uvM = WOOD_M } = {}) {
    const w = norm(sub(p1, p0)), L = Math.hypot(...sub(p1, p0))
    const u = norm(cross(Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], w)), v = cross(w, u)
    const base = m.count
    for (let i = 0; i <= segs; i++) {
      const q = (i / segs) * TAU, dir = [u[0] * Math.cos(q) + v[0] * Math.sin(q), u[1] * Math.cos(q) + v[1] * Math.sin(q), u[2] * Math.cos(q) + v[2] * Math.sin(q)]
      for (const [t, r] of [[0, r0], [1, r1]]) {
        const rr = r * (1 + (i % segs === 0 ? 0 : j(rough)))
        const at = t === 0 ? p0 : p1
        m.v([at[0] + dir[0] * rr, at[1] + dir[1] * rr, at[2] + dir[2] * rr], dir, flat ? FLAT : [i / segs, (t * L) / uvM], tint)
      }
    }
    for (let i = 0; i < segs; i++) m.quad(base + i * 2, base + i * 2 + 2, base + i * 2 + 3, base + i * 2 + 1)
  }

  /** An ellipsoid at local c with radii rx, ry, rz. */
  function blob(m, F, c, rx, ry, rz, tint, { segs = 8, rows = 6, rough = 0, flat = true } = {}) {
    const base = m.count
    for (let k = 0; k <= rows; k++) {
      const phi = (k / rows) * Math.PI - Math.PI / 2
      for (let i = 0; i <= segs; i++) {
        const q = (i / segs) * TAU, w = 1 + (k === 0 || k === rows || i === segs ? 0 : j(rough))
        const d = [Math.cos(phi) * Math.cos(q), Math.sin(phi), Math.cos(phi) * Math.sin(q)]
        m.v(put(F, c[0] + d[0] * rx * w, c[1] + d[1] * ry * w, c[2] + d[2] * rz * w), norm(turn(F, d[0] / rx, d[1] / ry, d[2] / rz)), flat ? FLAT : [i / segs, k / rows], tint)
      }
    }
    for (let k = 0; k < rows; k++) for (let i = 0; i < segs; i++) {
      const a = base + k * (segs + 1) + i
      m.quad(a, a + 1, a + segs + 2, a + segs + 1)
    }
  }

  /** A leaf: a two-sided pointed quad from `at` along `dir`, `w` wide, facing `face`. */
  function leaf(m, at, dir, len, w, face, tint) {
    const side = norm(cross(dir, face)), n = norm(face)
    const tip = [at[0] + dir[0] * len, at[1] + dir[1] * len, at[2] + dir[2] * len]
    const mid = [at[0] + dir[0] * len * 0.45, at[1] + dir[1] * len * 0.45, at[2] + dir[2] * len * 0.45]
    const l = [mid[0] + side[0] * w, mid[1] + side[1] * w, mid[2] + side[2] * w], r = [mid[0] - side[0] * w, mid[1] - side[1] * w, mid[2] - side[2] * w]
    for (const s of [1, -1]) {
      const nn = [n[0] * s, n[1] * s, n[2] * s]
      const ids = [at, l, tip, r].map((p) => m.v(p, nn, FLAT, tint))
      m.quad(...ids)
    }
  }

  return { j, lathe, hexa, box, rod, blob, leaf }
}

/**
 * The meshes for `room`, set at (ox, oy, oz). `update(t, dayness)` flickers the candles and brings the windows up with the day.
 */
export class InteriorView {
  constructor(room, tex, ox, oy, oz) {
    this.room = room
    this.group = new THREE.Group()
    this.group.position.set(ox, oy, oz)
    this.uniforms = { uAmb: { value: 0.55 }, uCandle: { value: 1.0 }, uWin: { value: 0.9 }, uDay: { value: 1 }, uFlicker: { value: 1 } }
    const rng = mulberry32(hash32(room.seed, room.index, 0x1d1))
    const K = kit(rng)
    const M = Object.fromEntries(TEX.map((id) => [id, new Mesher()]))
    buildShell(room, M, K)
    for (const it of room.items) {
      const make = ITEMS[it.kind]
      if (!make) throw new Error(`InteriorView: no builder for ${it.kind}`)
      make(it, M, K, room, rng)
    }
    for (const id of TEX) {
      const m = M[id]
      if (m.count === 0) continue
      bake(room, m)
      // The panes are lit from outside, not by the room.
      if (id === 'window') for (let i = 0; i < m.count; i++) m.lit.set([0.35, 0.1, 1.5], i * 3)
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3))
      g.setAttribute('tuv', new THREE.Float32BufferAttribute(m.uv, 2))
      g.setAttribute('tint', new THREE.Float32BufferAttribute(m.tint, 3))
      g.setAttribute('light', new THREE.Float32BufferAttribute(m.lit, 3))
      g.setIndex(m.idx)
      g.computeBoundingSphere()
      const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { map: { value: tex[id] }, ...this.uniforms }, fog: false })
      const mesh = new THREE.Mesh(g, mat)
      mesh.name = `interior-${id}`
      mesh.frustumCulled = false
      this.group.add(mesh)
    }
    this.flames = buildFlames(room.candles)
    this.group.add(this.flames.group)
  }

  update(t, dayness) {
    const f = 0.9 + 0.06 * Math.sin(t * 7.3) + 0.04 * Math.sin(t * 13.7 + 1.3)
    this.uniforms.uFlicker.value = f
    this.uniforms.uDay.value = dayness
    this.flames.update(t, f)
  }

  dispose() {
    this.group.removeFromParent()
    this.group.traverse((o) => {
      o.geometry?.dispose()
      o.material?.dispose()
    })
    this.flames.dispose()
  }
}

// --- the shell: wall, floor, ceiling, openings, loft, stairs -------------------------------------

/** How far the wall at bearing `a`, height `y` is pushed out into the recess of an opening. */
function recess(room, a, y) {
  let out = 0
  for (const o of [room.door, ...room.windows]) {
    const r = rAt(room.rs, o.a)
    const d = Math.hypot(angDiff(a, o.a) * r, y - o.y)
    out = Math.max(out, o.depth * (1 - smooth(o.r, o.r + 0.14, d)))
  }
  return out
}

function buildShell(room, M, K) {
  const { rs, hW, H } = room
  const COLS = 300
  // The wall's profile up from the floor's edge: the cove, the wall, the dome to the apex, as [inset from the wall, y].
  const prof = []
  for (let k = 0; k <= 4; k++) { const q = (k / 4) * (Math.PI / 2); prof.push([FILLET * (1 - Math.sin(q)), FILLET * (1 - Math.cos(q))]) }
  const rows = Math.ceil((hW - FILLET) / 0.065)
  for (let k = 1; k <= rows; k++) prof.push([0, FILLET + ((hW - FILLET) * k) / rows])
  const domeRows = 16
  const arc = [0]
  for (let k = 1; k < prof.length; k++) arc.push(arc[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]))
  const wallTint = hsl(room.tints.wall, 0.45)
  const around = Math.round((TAU * room.R) / WALL_M)
  const rowCount = prof.length - 1 + domeRows
  const wallPt = (i, j) => {
    const a = (i / COLS) * TAU, r = rAt(rs, a)
    let rr, y, v
    if (j < prof.length) {
      rr = r - prof[j][0]; y = prof[j][1]; v = arc[j] / WALL_M
    } else {
      const k = j - prof.length + 1, phi = (k / domeRows) * (Math.PI / 2)
      rr = r * Math.cos(phi); y = hW + (H - hW) * Math.sin(phi)
      v = (arc[prof.length - 1] + (k / domeRows) * (H - hW + r) * 0.8) / WALL_M
    }
    rr += recess(room, a, y)
    const p = [Math.cos(a) * rr, y, Math.sin(a) * rr]
    return { p, uv: [(i / COLS) * around, v], n: j === rowCount ? [0, -1, 0] : null }
  }
  // Tu (round the bearing) x Tv (up the profile) looks into the room.
  M.wall.grid(COLS, rowCount, wallPt, wallTint, 1, true)

  // The floor, in rings out to the wall's foot, its rings texture stretched once across it.
  const floorTint = hsl(room.tints.wood, 0.55)
  const RINGS = 12, span = 2 * Math.max(...rs)
  M.floor.grid(COLS, RINGS, (i, j) => {
    const edge = wallPt(i, 0).p, t = j / RINGS
    const p = [edge[0] * t, 0, edge[2] * t]
    return { p, uv: [p[0] / span + 0.5, p[2] / span + 0.5], n: [0, 1, 0] }
  }, floorTint, 1, true)

  // The door and panes: patches of the wall's own curve at the back of each recess.
  const disc = (m, o, tint) => {
    const R = o.r + 0.03
    m.grid(10, 10, (i, j) => {
      const u = (i / 10) * 2 - 1, v = (j / 10) * 2 - 1
      // Squeeze the square onto the disc so its rim is round.
      const s = Math.max(Math.abs(u), Math.abs(v)), l = Math.hypot(u, v) || 1
      const du = (u * s) / l, dv = (v * s) / l
      const r0 = rAt(room.rs, o.a), a = o.a + (du * R) / r0
      const rr = rAt(room.rs, a) + o.depth - 0.012
      return { p: [Math.cos(a) * rr, o.y + dv * R, Math.sin(a) * rr], uv: [du * 0.5 + 0.5, dv * 0.5 + 0.5], n: [-Math.cos(o.a), 0, -Math.sin(o.a)] }
    }, tint, 1)
  }
  disc(M.door, room.door, [1, 1, 1])
  for (const w of room.windows) disc(M.window, w, [1, 1, 1])

  if (room.loft) buildLoft(room, M, K)
  const wood = hsl(room.tints.wood)
  for (const s of room.stairs) {
    const c = []
    for (const y of [0, s.top]) for (const [a, inset] of [[s.a0, -0.08], [s.a1, -0.08], [s.a1, s.w], [s.a0, s.w]]) {
      const r = rAt(room.rs, a) - inset - (y > 0 ? K.j(0.015) : 0)
      c.push([Math.cos(a) * r, y + (y > 0 ? K.j(0.01) : 0), Math.sin(a) * r])
    }
    K.hexa(M.grain, c, wood)
  }
}

function buildLoft(room, M, K) {
  const { loft } = room
  const wood = hsl(room.tints.wood)
  const cols = Math.max(8, Math.ceil(((loft.a1 - loft.a0) * room.R) / 0.08))
  const y0 = loft.y - loft.thick, y1 = loft.y
  // The slab's cross-section at each bearing, from the wall under it round its lip to the wall over it.
  const sect = (d) => [[-0.1, y0], [d - 0.06, y0], [d, y0 + 0.05], [d, y1 - 0.03], [d - 0.03, y1], [-0.1, y1]]
  const at = (i, k) => {
    const a = loft.a0 + (i / cols) * (loft.a1 - loft.a0), d = loftDepthAt(loft, a), r = rAt(room.rs, a)
    const [inset, y] = sect(Math.max(d, 0.02))[k]
    return { a, p: [Math.cos(a) * (r - inset), y, Math.sin(a) * (r - inset)] }
  }
  // Grain across the boards on top, along the slab below.
  M.grain.grid(cols, 5, (i, k) => {
    const { a, p } = at(i, k)
    return { p, uv: [((a - loft.a0) * room.R) / WOOD_M, (k + Math.hypot(p[0], p[2])) / WOOD_M] }
  }, wood, 1)
  // The stair end is cut square: cap it.
  const e = loft.dir > 0 ? loft.a1 : loft.a0
  const d = loftDepthAt(loft, e), r = rAt(room.rs, e)
  const n = [-Math.sin(e) * loft.dir, 0, Math.cos(e) * loft.dir]
  const ids = sect(d).map(([inset, y]) => M.grain.v([Math.cos(e) * (r - inset), y, Math.sin(e) * (r - inset)], n, [inset / WOOD_M, y / WOOD_M], wood))
  for (let k = 1; k < ids.length - 1; k++) M.grain.tri(ids[0], ids[k], ids[k + 1])

  // The rail: posts along the lip and a rail over them, open at the stairs.
  const openA = e, openHalf = 0.55 / room.R
  const lip = (a) => { const dd = loftDepthAt(loft, a) - 0.05, rr = rAt(room.rs, a) - dd; return [Math.cos(a) * rr, y1, Math.sin(a) * rr] }
  const rail = []
  for (let a = loft.a0; a <= loft.a1 + 1e-6; a += 0.18 / room.R) {
    if (Math.abs(angDiff(a, openA)) < openHalf || loftDepthAt(loft, a) < 0.25) { if (rail.length) { railRun(M, K, rail, wood); rail.length = 0 } continue }
    rail.push(lip(a))
  }
  if (rail.length) railRun(M, K, rail, wood)
}

function railRun(M, K, pts, wood) {
  const top = (p) => [p[0], p[1] + 0.45, p[2]]
  for (let k = 0; k < pts.length; k += 2) K.rod(M.grain, pts[k], top(pts[k]), 0.028, 0.022, wood, { rough: 0.2 })
  for (let k = 0; k < pts.length - 1; k++) {
    K.rod(M.grain, top(pts[k]), top(pts[k + 1]), 0.03, 0.03, wood, { rough: 0.1 })
    const mid = (p, q) => [(p[0] + q[0]) / 2, p[1] + 0.22, (p[2] + q[2]) / 2]
    if (k % 2 === 0) K.rod(M.grain, [pts[k][0], pts[k][1] + 0.05, pts[k][2]], mid(pts[k], pts[k + 1]), 0.012, 0.012, wood)
  }
}

// --- the bake ---------------------------------------------------------------

/** Per vertex: x ambient (dimmer low, under the loft and facing down), y candle, z window. */
function bake(room, m) {
  const n = m.count, L = new Float32Array(n * 3)
  const P = m.pos, N = m.nrm
  const wins = room.windows.map((w) => {
    const r = rAt(room.rs, w.a)
    return { p: [Math.cos(w.a) * r, w.y, Math.sin(w.a) * r], ax: [-Math.cos(w.a), 0, -Math.sin(w.a)], k: ((w.r / 0.3) ** 2) * 1.2 }
  })
  for (let i = 0; i < n; i++) {
    const p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], nn = [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]]
    let amb = (0.6 + 0.25 * nn[1]) * (0.7 + 0.3 * smooth(0, 0.4, p[1]))
    if (room.loft && p[1] < room.loft.y - room.loft.thick) {
      const a = Math.atan2(p[2], p[0]), inset = rAt(room.rs, a) - Math.hypot(p[0], p[2])
      amb *= 1 - 0.35 * smooth(-0.2, 0.3, loftDepthAt(room.loft, a) - inset)
    }
    let cand = 0
    for (const c of room.candles) {
      const d = [c.x - p[0], c.y - p[1], c.z - p[2]], dl = Math.hypot(...d) || 1
      cand += (c.i / (1 + (dl / 0.9) ** 2)) * (0.3 + 0.7 * Math.max(0, dot(nn, d) / dl))
    }
    let win = 0
    for (const w of wins) {
      const d = sub(p, w.p), dl = Math.hypot(...d) || 1, along = dot(d, w.ax)
      if (along <= 0) continue
      const cone = smooth(0.15, 0.85, along / dl)
      win += (w.k * cone * Math.max(0.2, -dot(nn, d) / dl)) / (1 + (dl / 1.6) ** 2)
    }
    L[i * 3] = amb; L[i * 3 + 1] = cand; L[i * 3 + 2] = win
  }
  m.lit = L
}

// --- the flames -------------------------------------------------------------

function glowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,210,140,0.9)')
  grad.addColorStop(0.3, 'rgba(255,160,70,0.35)')
  grad.addColorStop(1, 'rgba(255,120,40,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function buildFlames(candles) {
  const group = new THREE.Group()
  const m = new Mesher()
  const K = kit(mulberry32(candles.length + 1))
  for (const c of candles) K.lathe(m, frame(c.x, c.y - 0.03, c.z), [[0, 0], [0.012, 0.012], [0.009, 0.035], [0, 0.06]], [1, 1, 1], { segs: 6, flat: true })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3))
  g.setIndex(m.idx)
  const flameMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.78, 0.4), fog: false })
  group.add(new THREE.Mesh(g, flameMat))
  const hp = new THREE.BufferGeometry()
  hp.setAttribute('position', new THREE.Float32BufferAttribute(candles.flatMap((c) => [c.x, c.y, c.z]), 3))
  const glowMap = glowTexture()
  const haloMat = new THREE.PointsMaterial({ map: glowMap, size: 0.35, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })
  const halos = new THREE.Points(hp, haloMat)
  halos.frustumCulled = false
  group.add(halos)
  return {
    group,
    update(t, f) {
      haloMat.size = 0.35 * (0.85 + 0.3 * (f - 0.9) * 5)
      flameMat.color.setRGB(f, 0.78 * f, 0.4 * f)
    },
    dispose() { glowMap.dispose() },
  }
}

// --- the furniture and things ---------------------------------------------------

const CLAY = (h) => rgb(0.05 + h * 0.08, 0.35, 0.55)
const CREAM = rgb(0.11, 0.3, 0.85)
const WAX = rgb(0.12, 0.45, 0.88)
const GREEN = (k = 0) => rgb(0.26 + k * 0.08, 0.45, 0.38)
const PASTEL = (h) => rgb(h, 0.45, 0.68)
const DARK = rgb(0.07, 0.35, 0.28)
const IRON = rgb(0.08, 0.1, 0.25)

/** A point against the wall at bearing `a`, `inset` in, height y. */
const wallAt = (room, a, inset, y) => { const r = rAt(room.rs, a) - inset; return [Math.cos(a) * r, y, Math.sin(a) * r] }

function candleOn(M, K, x, y, z, h) {
  K.lathe(M.linen, frame(x, y, z), [[0, 0], [0.04, 0], [0.045, 0.012], [0.02, 0.014], [0.02, 0.014], [0, 0.014]], CLAY(0.3), { segs: 10, flat: true })
  K.lathe(M.linen, frame(x, y + 0.012, z), [[0, 0], [0.017, 0], [0.018, h * 0.6], [0.016, h], [0, h + 0.004]], WAX, { segs: 8, flat: true, rough: 0.08 })
}

function food(M, K, F, kind, spread, rng) {
  if (kind === 'berries') {
    const col = rng() < 0.5 ? rgb(0.95, 0.6, 0.35) : rgb(0.72, 0.4, 0.3)
    for (let k = 0; k < 7; k++) K.blob(M.linen, F, [K.j(spread), 0.018 + (k > 4 ? 0.02 : 0), K.j(spread)], 0.018, 0.018, 0.018, col, { segs: 6, rows: 4 })
  } else if (kind === 'bread') {
    K.blob(M.linen, F, [0, 0.03, 0], spread * 0.9, 0.035, spread * 0.6, rgb(0.08, 0.55, 0.45), { rough: 0.08 })
  } else if (kind === 'apples') {
    for (let k = 0; k < 4; k++) K.blob(M.linen, F, [K.j(spread * 0.8), 0.035 + (k === 3 ? 0.035 : 0), K.j(spread * 0.8)], 0.035, 0.032, 0.035, rng() < 0.5 ? rgb(0.02, 0.6, 0.45) : rgb(0.18, 0.55, 0.5))
  } else {
    for (let k = 0; k < 4; k++) {
      const c = [K.j(spread), 0.02, K.j(spread)]
      K.blob(M.linen, F, c, 0.018, 0.024, 0.018, rgb(0.09, 0.55, 0.42), { segs: 6, rows: 4 })
      K.blob(M.grain, F, [c[0], c[1] + 0.018, c[2]], 0.02, 0.01, 0.02, DARK, { segs: 6, rows: 3, flat: false })
    }
  }
}

const ITEMS = {
  table(it, M, K, room) {
    const tint = hsl(room.tints.table), T = it.top
    K.lathe(M.grain, frame(it.x, 0, it.z, it.spin), [[0, T - 0.07], [it.r - 0.03, T - 0.07], [it.r, T - 0.04], [it.r, T - 0.015], [it.r - 0.02, T], [0, T]], tint, { segs: 18, rough: 0.05 })
    for (let k = 0; k < it.legs; k++) {
      const q = it.spin + (k / it.legs) * TAU
      const lo = [it.x + Math.cos(q) * it.r * 0.72, 0, it.z + Math.sin(q) * it.r * 0.72], hi = [it.x + Math.cos(q) * it.r * 0.5, T - 0.07, it.z + Math.sin(q) * it.r * 0.5]
      K.rod(M.grain, lo, hi, 0.05, 0.04, tint, { rough: 0.15, segs: 7 })
    }
  },

  chair(it, M, K, room, rng) {
    const tint = hsl({ ...room.tints.wood, l: room.tints.wood.l * (0.85 + rng() * 0.3) }), F = frame(it.x, 0, it.z, it.yaw + K.j(0.15)), S = it.top, r = it.r
    if (it.style === 2) {
      K.lathe(M.grain, F, [[0, 0], [r + 0.02, 0], [r, 0.05], [r * 0.95, S - 0.01], [r * 0.9, S], [0, S]], tint, { segs: 10, rough: 0.12 })
    } else {
      if (it.style === 0) K.box(M.grain, F, 0, S - 0.03, 0, r, 0.03, r, tint, { rough: 0.02 })
      else K.lathe(M.grain, F, [[0, S - 0.055], [r, S - 0.055], [r + 0.01, S - 0.02], [r - 0.01, S], [0, S]], tint, { segs: 10, rough: 0.08 })
      const n = it.style === 0 ? 4 : 3
      for (let k = 0; k < n; k++) {
        const q = (k / n) * TAU + Math.PI / 4
        K.rod(M.grain, put(F, Math.cos(q) * r * 0.95, 0, Math.sin(q) * r * 0.95), put(F, Math.cos(q) * r * 0.6, S - 0.05, Math.sin(q) * r * 0.6), 0.03, 0.026, tint, { rough: 0.2 })
      }
    }
    if (it.back > 0) {
      const zb = -(r - 0.03)
      for (const x of [-r * 0.75, r * 0.75]) K.rod(M.grain, put(F, x, S - 0.02, zb), put(F, x * 1.05, it.back, zb - 0.04), 0.026, 0.022, tint, { rough: 0.2 })
      K.box(M.grain, F, 0, it.back - 0.05, zb - 0.035, r * 0.9, 0.06, 0.025, tint, { rough: 0.02 })
    }
  },

  plate(it, M, K, room, rng) {
    const F = frame(it.x, it.y, it.z)
    K.lathe(M.linen, F, [[0, 0], [0.09, 0], [0.11, 0.018], [0.1, 0.02], [0.08, 0.008], [0, 0.008]], CLAY(rng()), { segs: 12, flat: true })
    if (it.food) food(M, K, frame(it.x, it.y + 0.008, it.z), it.food, 0.04, rng)
  },

  cup(it, M, K, room, rng) {
    K.lathe(M.linen, frame(it.x, it.y, it.z), [[0, 0], [0.03, 0], [0.036, 0.065], [0.03, 0.065], [0.026, 0.01], [0, 0.01]], CLAY(rng()), { segs: 10, flat: true })
  },

  vase(it, M, K, room, rng) {
    const F = frame(it.x, it.y, it.z)
    K.lathe(M.linen, F, [[0, 0], [0.05, 0], [0.065, 0.06], [0.03, 0.13], [0.04, 0.15], [0.03, 0.15], [0, 0.12]], CLAY(rng()), { segs: 12, flat: true })
    for (let k = 0; k < it.flowers; k++) {
      const q = (k / it.flowers) * TAU, lean = 0.05 + rng() * 0.05
      const head = put(F, Math.cos(q) * lean, 0.26 + rng() * 0.08, Math.sin(q) * lean)
      K.rod(M.linen, put(F, 0, 0.12, 0), head, 0.004, 0.004, GREEN(), { segs: 4, flat: true })
      const col = rgb(it.hue + k * 0.07, 0.6, 0.65)
      for (let p = 0; p < 5; p++) {
        const pq = (p / 5) * TAU
        K.leaf(M.linen, head, [Math.cos(pq), 0.3, Math.sin(pq)], 0.035, 0.015, [0, 1, 0], col)
      }
      K.blob(M.linen, frame(...head), [0, 0.005, 0], 0.01, 0.01, 0.01, rgb(0.13, 0.8, 0.55), { segs: 5, rows: 3 })
    }
  },

  bowl(it, M, K, room, rng) {
    K.lathe(M.grain, frame(it.x, it.y, it.z), [[0, 0], [0.07, 0], [0.13, 0.06], [0.12, 0.065], [0.06, 0.012], [0, 0.012]], hsl(room.tints.wood), { segs: 14 })
    food(M, K, frame(it.x, it.y + 0.012, it.z), it.food, 0.05, rng)
  },

  candle(it, M, K) { candleOn(M, K, it.x, it.y, it.z, it.h) },

  counter(it, M, K, room) {
    const wood = hsl(room.tints.wood), topTint = hsl(room.tints.table)
    const segs = Math.max(2, Math.ceil(((it.a1 - it.a0) * room.R) / 0.3))
    const face = (a, inset, y) => wallAt(room, a, inset, y)
    for (let s = 0; s < segs; s++) {
      const a0 = it.a0 + ((it.a1 - it.a0) * s) / segs, a1 = it.a0 + ((it.a1 - it.a0) * (s + 1)) / segs
      const d = FILLET + it.depth
      K.hexa(M.grain, [face(a0, -0.05, 0), face(a1, -0.05, 0), face(a1, d - 0.03, 0), face(a0, d - 0.03, 0), face(a0, -0.05, it.top - 0.05), face(a1, -0.05, it.top - 0.05), face(a1, d - 0.03, it.top - 0.05), face(a0, d - 0.03, it.top - 0.05)], wood)
      K.hexa(M.grain, [face(a0, -0.05, it.top - 0.05), face(a1, -0.05, it.top - 0.05), face(a1, d + 0.02, it.top - 0.05), face(a0, d + 0.02, it.top - 0.05), face(a0, -0.05, it.top), face(a1, -0.05, it.top), face(a1, d + 0.02, it.top), face(a0, d + 0.02, it.top)], topTint)
    }
    // A shelf of plates on the wall above.
    const shelfY = Math.min(1.25, room.hW - 0.3)
    if (!room.loft || loftDepthAt(room.loft, (it.a0 + it.a1) / 2) < 0.4) {
      const m0 = it.a0 + (it.a1 - it.a0) * 0.2, m1 = it.a1 - (it.a1 - it.a0) * 0.2
      K.hexa(M.grain, [face(m0, -0.05, shelfY - 0.03), face(m1, -0.05, shelfY - 0.03), face(m1, 0.22, shelfY - 0.03), face(m0, 0.22, shelfY - 0.03), face(m0, -0.05, shelfY), face(m1, -0.05, shelfY), face(m1, 0.22, shelfY), face(m0, 0.22, shelfY)], wood)
      for (let k = 0; k < 3; k++) {
        const a = m0 + ((m1 - m0) * (k + 0.5)) / 3, p = face(a, 0.08, shelfY)
        const F = { x: p[0], y: p[1], z: p[2], c: 1, s: 0 }
        K.lathe(M.linen, F, [[0, 0], [0.05, 0], [0.07, 0.06], [0.06, 0.065], [0, 0.01]], CLAY(k * 0.3), { segs: 10, flat: true })
      }
    }
  },

  basin(it, M, K, room) {
    const F = frame(it.x, it.y, it.z)
    K.lathe(M.linen, F, [[0, 0], [it.r * 0.7, 0], [it.r, 0.09], [it.r - 0.015, 0.095], [it.r * 0.65, 0.02], [0, 0.02]], CLAY(0.2), { segs: 14, flat: true })
    K.lathe(M.linen, frame(it.x, it.y + 0.07, it.z), [[0, 0], [it.r * 0.9, 0], [0, 0]], rgb(0.55, 0.35, 0.45), { segs: 14, flat: true })
  },

  jar(it, M, K) {
    const h = it.h, F = frame(it.x, it.y, it.z, it.yaw)
    K.lathe(M.linen, F, [[0, 0], [0.045, 0], [0.055, h * 0.5], [0.04, h * 0.85], [0.032, h * 0.88], [0.032, h], [0, h]], PASTEL(it.hue), { segs: 10, flat: true })
    K.blob(M.linen, F, [0, h, 0], 0.036, 0.015, 0.036, CREAM, { segs: 8, rows: 4 })
  },

  crock(it, M, K) {
    const h = it.h * 0.8, F = frame(it.x, it.y, it.z, it.yaw)
    K.lathe(M.linen, F, [[0, 0], [0.06, 0], [0.07, h * 0.6], [0.055, h], [0.055, h], [0, h]], CLAY(it.hue), { segs: 12, flat: true })
  },

  loaf(it, M, K) { K.blob(M.linen, frame(it.x, it.y, it.z, it.yaw), [0, 0.04, 0], 0.09, 0.05, 0.06, rgb(0.08, 0.55, 0.45), { rough: 0.06 }) },

  cheese(it, M, K) {
    const F = frame(it.x, it.y, it.z, it.yaw)
    K.lathe(M.linen, F, [[0, 0], [0.07, 0], [0.075, 0.03], [0.07, 0.06], [0.07, 0.06], [0, 0.06]], rgb(0.13, 0.7, 0.6), { segs: 12, flat: true })
  },

  herbs(it, M, K, room, rng) {
    const p0 = wallAt(room, it.a0, it.inset, it.y), p1 = wallAt(room, it.a1, it.inset, it.y)
    K.rod(M.grain, p0, p1, 0.015, 0.015, hsl(room.tints.wood))
    for (const [a, p] of [[it.a0, p0], [it.a1, p1]]) K.rod(M.grain, wallAt(room, a, -0.02, it.y), p, 0.01, 0.01, DARK)
    for (let k = 0; k < it.n; k++) {
      const t = (k + 0.5) / it.n, top = [p0[0] + (p1[0] - p0[0]) * t, it.y, p0[2] + (p1[2] - p0[2]) * t]
      const len = 0.18 + rng() * 0.1, col = rng() < 0.3 ? rgb(0.12, 0.35, 0.45) : GREEN(rng())
      K.rod(M.linen, top, [top[0], top[1] - 0.05, top[2]], 0.004, 0.004, CREAM, { segs: 4, flat: true })
      for (let s = 0; s < 7; s++) {
        const q = rng() * TAU, spread = 0.2 + rng() * 0.3
        K.leaf(M.linen, [top[0], top[1] - 0.04, top[2]], norm([Math.cos(q) * spread, -1, Math.sin(q) * spread]), len, 0.02, [Math.sin(q), 0, -Math.cos(q)], col)
      }
    }
  },

  sack(it, M, K) {
    const r = it.r, h = it.h
    K.lathe(M.linen, frame(it.x, 0, it.z, it.yaw), [[0, 0], [r * 0.85, 0], [r, h * 0.3], [r * 0.92, h * 0.72], [r * 0.45, h * 0.9], [r * 0.2, h * 0.95], [r * 0.3, h * 1.08], [0, h * 1.1]], rgb(0.1, 0.3, 0.62), { segs: 12, rough: 0.07, sz: 0.85 })
  },

  barrel(it, M, K, room) {
    const r = it.r, h = it.h, F = frame(it.x, 0, it.z, it.yaw), wood = hsl(room.tints.wood)
    K.lathe(M.grain, F, [[0, 0], [r * 0.88, 0], [r, h * 0.5], [r * 0.88, h], [r * 0.88, h], [0, h]], wood, { segs: 14, rough: 0.02 })
    for (const y of [0.15, 0.85]) K.lathe(M.grain, frame(it.x, h * y - 0.015, it.z), [[r * 0.94, 0], [r * 0.99 + 0.006, 0], [r * 0.99 + 0.006, 0.03], [r * 0.94, 0.03]], IRON, { segs: 14, flat: true })
  },

  armchair(it, M, K, room) {
    const F = frame(it.x, 0, it.z, it.yaw), wood = hsl(room.tints.wood), cloth = hsl(room.tints.cloth, 0.1)
    K.box(M.grain, F, 0, 0.08, 0, 0.3, 0.08, 0.26, wood, { rough: 0.02 })
    K.box(M.grain, F, 0, 0.36, -0.22, 0.3, 0.2, 0.07, wood, { rough: 0.03 })
    for (const x of [-0.26, 0.26]) K.box(M.grain, F, x, 0.24, -0.02, 0.05, 0.1, 0.24, wood, { rough: 0.02 })
    K.blob(M.linen, F, [0, 0.19, 0.02], 0.22, 0.04, 0.22, cloth, { flat: false })
    K.blob(M.linen, F, [0, 0.38, -0.13], 0.22, 0.14, 0.04, cloth, { flat: false })
  },

  sidetable(it, M, K, room) {
    const F = frame(it.x, 0, it.z), wood = hsl(room.tints.table)
    K.lathe(M.grain, F, [[0, it.top - 0.04], [it.r, it.top - 0.04], [it.r, it.top], [0, it.top]], wood, { segs: 12, rough: 0.05 })
    for (let k = 0; k < 3; k++) {
      const q = (k / 3) * TAU
      K.rod(M.grain, put(F, Math.cos(q) * it.r * 0.8, 0, Math.sin(q) * it.r * 0.8), put(F, Math.cos(q) * it.r * 0.5, it.top - 0.04, Math.sin(q) * it.r * 0.5), 0.02, 0.018, wood, { rough: 0.2 })
    }
  },

  books(it, M, K, room, rng) {
    let y = 0
    for (let k = 0; k < it.n; k++) {
      const hy = 0.012 + rng() * 0.01
      K.box(M.linen, frame(it.x, it.y, it.z, it.yaw + K.j(0.4)), 0, y + hy, 0, 0.055 + rng() * 0.02, hy, 0.075, rgb(rng(), 0.45, 0.4), { flat: true, rough: 0.003 })
      y += hy * 2
    }
  },

  rug(it, M, K, room) {
    const segs = 24, F = frame(it.x, 0.006, it.z), col = rgb(it.hue, 0.35, 0.55, 0.2)
    const c = M.linen.v(put(F, 0, 0, 0), [0, 1, 0], [0.5, 0.5], col)
    const ring = []
    for (let i = 0; i <= segs; i++) {
      const q = (i / segs) * TAU, r = it.r * (i === segs ? 1 : 1 + K.j(0.06))
      ring.push(M.linen.v(put(F, Math.cos(q) * r, 0, Math.sin(q) * r), [0, 1, 0], [0.5 + Math.cos(q) * r * 2, 0.5 + Math.sin(q) * r * 2], col))
    }
    for (let i = 0; i < segs; i++) M.linen.tri(c, ring[i], ring[i + 1])
  },

  bed(it, M, K, room) {
    const F = frame(it.x, it.y, it.z, it.yaw), wood = hsl(room.tints.wood), hl = it.len / 2, hw = it.wid / 2
    K.box(M.grain, F, 0, 0.06, 0, hw, 0.06, hl, wood, { rough: 0.02 })
    K.box(M.grain, F, 0, 0.3, hl - 0.04, hw + 0.02, 0.3, 0.04, wood, { rough: 0.03 })
    K.box(M.linen, F, 0, 0.16, 0, hw - 0.03, 0.04, hl - 0.05, CREAM, { rough: 0.01 })
    K.blob(M.linen, F, [0, 0.23, hl - 0.18], hw * 0.7, 0.05, 0.1, CREAM, { flat: false })
    K.box(M.linen, F, 0, 0.19, -hl * 0.25, hw + 0.02, 0.03, hl * 0.72, hsl(room.tints.cloth2, 0.1), { rough: 0.015 })
  },

  plush(it, M, K) {
    const F = frame(it.x, it.y, it.z, it.yaw), s = it.size, col = PASTEL(it.hue)
    if (it.shape === 2) {
      K.blob(M.linen, F, [0, s * 0.4, 0], s * 0.35, s * 0.45, s * 0.35, CREAM, { flat: false })
      K.blob(M.linen, F, [0, s * 0.95, 0], s * 0.7, s * 0.35, s * 0.7, col, { flat: false })
      return
    }
    K.blob(M.linen, F, [0, s * 0.45, 0], s * 0.5, s * 0.5, s * 0.42, col, { flat: false })
    K.blob(M.linen, F, [0, s * 1.15, 0.02], s * 0.38, s * 0.35, s * 0.35, col, { flat: false })
    const ear = it.shape === 0 ? [s * 0.13, s * 0.12] : [s * 0.08, s * 0.35]
    for (const x of [-1, 1]) K.blob(M.linen, F, [x * s * 0.22, s * 1.4 + ear[1] * 0.6, 0], ear[0], ear[1], ear[0] * 0.6, col, { flat: false })
    for (const x of [-1, 1]) K.blob(M.linen, F, [x * s * 0.13, s * 1.2, s * 0.33], s * 0.05, s * 0.05, s * 0.03, DARK)
  },

  bookcase(it, M, K, room) {
    const F = frame(it.x, it.y, it.z, it.yaw), wood = hsl(room.tints.wood), hw = it.w / 2, hd = it.d / 2
    const rng = mulberry32(it.seed)
    for (const x of [-hw, hw]) K.box(M.grain, F, x, it.h / 2, 0, 0.025, it.h / 2, hd, wood)
    K.box(M.grain, F, 0, it.h / 2, -hd + 0.015, hw, it.h / 2, 0.015, wood)
    for (let k = 0; k <= it.shelves; k++) {
      const y = 0.03 + ((it.h - 0.06) * k) / it.shelves
      K.box(M.grain, F, 0, y, 0, hw + 0.02, 0.02, hd + 0.01, wood)
      if (k === it.shelves) break
      const room2 = (it.h - 0.06) / it.shelves - 0.06
      let x = -hw + 0.03
      while (x < hw - 0.05) {
        const t = 0.02 + rng() * 0.025, bh = room2 * (0.6 + rng() * 0.35)
        if (rng() < 0.12) { x += 0.06; continue }
        K.box(M.linen, F, x + t / 2, y + 0.02 + bh / 2, 0.01, t / 2 - 0.002, bh / 2, hd * 0.8, rgb(rng(), 0.4 + rng() * 0.2, 0.3 + rng() * 0.2), { flat: true, rough: 0.002 })
        x += t
      }
    }
  },

  divider(it, M, K, room, rng) {
    const wood = hsl(room.tints.wood), p0 = [it.x0, 0, it.z0], p1 = [it.x1, 0, it.z1], h = it.h
    const lerp = (t, y) => [p0[0] + (p1[0] - p0[0]) * t, y, p0[2] + (p1[2] - p0[2]) * t]
    const along = norm(sub(p1, p0)), face = [-along[2], 0, along[0]]
    if (it.style === 'sticks') {
      const n = Math.round(Math.hypot(...sub(p1, p0)) / 0.045)
      for (let k = 0; k <= n; k++) {
        const t = k / n
        K.rod(M.grain, lerp(t, 0), lerp(t + K.j(0.01), h * (0.92 + rng() * 0.12)), 0.02, 0.014, hsl({ ...room.tints.wood, l: room.tints.wood.l * (0.8 + rng() * 0.4) }, 0.2), { rough: 0.2, segs: 5 })
      }
      for (const y of [0.3, h * 0.75]) K.rod(M.linen, [lerp(0, y)[0] + face[0] * 0.025, y, lerp(0, y)[2] + face[2] * 0.025], [lerp(1, y)[0] + face[0] * 0.025, y, lerp(1, y)[2] + face[2] * 0.025], 0.01, 0.01, rgb(0.1, 0.35, 0.55), { flat: true })
      return
    }
    K.rod(M.grain, lerp(0, 0), lerp(0, h), 0.03, 0.028, wood, { rough: 0.15 })
    K.rod(M.grain, lerp(1, 0), lerp(1, h), 0.03, 0.028, wood, { rough: 0.15 })
    K.rod(M.grain, lerp(0, h - 0.02), lerp(1, h - 0.02), 0.022, 0.022, wood, { rough: 0.1 })
    if (it.style === 'curtain') {
      const cols = 24, rows = 8, cloth = hsl({ h: it.hue, s: 0.4, l: 0.55 }, 0.15)
      for (const side of [1, -1]) {
        M.linen.grid(cols, rows, (i, j) => {
          const t = 0.03 + (0.94 * i) / cols, y = 0.08 + ((h - 0.12) * (rows - j)) / rows, fold = 0.03 * Math.sin(i * 1.6) * side
          const b = lerp(t, y)
          return { p: [b[0] + face[0] * fold, y, b[2] + face[2] * fold], uv: [t * 3, y * 3] }
        }, cloth, side)
      }
      return
    }
    // Lattice: crossed slats with leaves where they meet.
    const L = Math.hypot(...sub(p1, p0)), n = Math.max(2, Math.round(L / 0.25)), leafCol = GREEN(0.5)
    for (let k = 0; k <= n; k++) {
      const t0 = k / n
      K.rod(M.grain, lerp(Math.max(0, t0 - 0.5), 0.05), lerp(t0, h - 0.05), 0.012, 0.012, wood, { segs: 4 })
      K.rod(M.grain, lerp(Math.min(1, t0 + 0.5), 0.05), lerp(t0, h - 0.05), 0.012, 0.012, wood, { segs: 4 })
    }
    for (let k = 0; k < n * 2; k++) {
      const at = lerp(rng(), 0.2 + rng() * (h - 0.35)), q = rng() * TAU
      K.leaf(M.linen, at, norm([Math.cos(q), -0.3, Math.sin(q)]), 0.08, 0.03, face, leafCol)
    }
  },

  mushpot(it, M, K) {
    const F = frame(it.x, 0, it.z, it.yaw)
    K.lathe(M.linen, F, [[0, 0], [it.r * 0.7, 0], [it.r, 0.14], [it.r * 0.9, 0.15], [0, 0.13]], CLAY(0.1), { segs: 12, flat: true })
    for (let k = 0; k < 3; k++) {
      const x = K.j(0.05), z = K.j(0.05), hh = 0.1 + k * 0.05
      K.rod(M.linen, put(F, x, 0.13, z), put(F, x * 1.3, 0.13 + hh, z * 1.3), 0.012, 0.01, CREAM, { flat: true, segs: 5 })
      K.blob(M.linen, F, [x * 1.3, 0.13 + hh, z * 1.3], 0.04 - k * 0.006, 0.02, 0.04 - k * 0.006, rgb(it.hue, 0.6, 0.5), { segs: 8, rows: 4 })
    }
  },

  broom(it, M, K, room) {
    const F = frame(it.x, 0, it.z, it.yaw)
    const base = put(F, 0, 0.02, 0.06), top = put(F, 0, it.h, -it.r * 1.5)
    K.rod(M.grain, base, top, 0.014, 0.014, hsl(room.tints.wood), { segs: 5 })
    K.lathe(M.linen, frame(base[0], 0, base[2]), [[0, 0], [0.07, 0], [0.03, 0.2], [0, 0.22]], rgb(0.13, 0.55, 0.6), { segs: 8, rough: 0.12, sz: 0.5 })
  },

  bucket(it, M, K, room) {
    const F = frame(it.x, 0, it.z, it.yaw), h = it.h, r = it.r
    K.lathe(M.grain, F, [[0, 0.02], [r * 0.85, 0], [r, h], [r - 0.015, h], [r * 0.82, 0.03], [0, 0.03]], hsl(room.tints.wood), { segs: 12 })
    const pts = Array.from({ length: 7 }, (_, k) => { const q = (k / 6) * Math.PI; return put(F, Math.cos(q) * r, h + Math.sin(q) * r * 0.8, 0) })
    for (let k = 0; k < 6; k++) K.rod(M.grain, pts[k], pts[k + 1], 0.006, 0.006, IRON, { segs: 4, flat: true })
  },

  basket(it, M, K, room, rng) {
    const F = frame(it.x, 0, it.z, it.yaw), h = it.h, r = it.r
    K.lathe(M.linen, F, [[0, 0.01], [r * 0.8, 0], [r, h], [r - 0.012, h], [r * 0.78, 0.02], [0, 0.02]], rgb(0.1, 0.45, 0.5), { segs: 14 })
    for (let k = 0; k < 3; k++) K.blob(M.linen, F, [K.j(r * 0.5), h - 0.02, K.j(r * 0.5)], 0.05, 0.05, 0.05, rgb(it.hue + k * 0.3, 0.5, 0.6), { flat: false })
    if (rng() < 0.5) K.rod(M.grain, put(F, 0, h, 0), put(F, 0.1, h + 0.12, 0.05), 0.004, 0.004, DARK, { segs: 4 })
  },

  mobile(it, M, K, room, rng) {
    const rho = Math.hypot(it.x, it.z), ceil = ceilingAt(room, rho, rAt(room.rs, Math.atan2(it.z, it.x)))
    const hub = [it.x, it.y, it.z]
    K.rod(M.linen, hub, [it.x, ceil + 0.05, it.z], 0.003, 0.003, CREAM, { segs: 3, flat: true })
    K.lathe(M.grain, frame(it.x, it.y - 0.01, it.z), [[0.16, 0], [0.18, 0], [0.18, 0.02], [0.16, 0.02], [0.16, 0]], hsl(room.tints.wood), { segs: 16 })
    for (let k = 0; k < it.n; k++) {
      const q = (k / it.n) * TAU, len = 0.12 + rng() * 0.2
      const top = [it.x + Math.cos(q) * 0.17, it.y, it.z + Math.sin(q) * 0.17], end = [top[0], top[1] - len, top[2]]
      K.rod(M.linen, top, end, 0.002, 0.002, CREAM, { segs: 3, flat: true })
      K.leaf(M.linen, end, [0, -1, 0], 0.11, 0.035, [Math.cos(q + 1), 0, Math.sin(q + 1)], rgb(it.hue + k * 0.05, 0.55, 0.5))
    }
  },

  garland(it, M, K, room, rng) {
    let prev = null
    for (let k = 0; k <= it.n * 2; k++) {
      const t = k / (it.n * 2), a = it.a0 + (it.a1 - it.a0) * t
      const p = wallAt(room, a, 0.06 + 0.04 * Math.sin(Math.PI * t), it.y - it.sag * Math.sin(Math.PI * t))
      if (prev) K.rod(M.linen, prev, p, 0.004, 0.004, GREEN(0.2), { segs: 3, flat: true })
      if (k % 2 === 1) {
        const out = [-Math.cos(a), 0, -Math.sin(a)]
        K.leaf(M.linen, p, norm([K.j(0.5), -1, K.j(0.5)]), 0.09, 0.035, out, rng() < 0.5 ? GREEN(rng()) : rgb(0.08 + rng() * 0.05, 0.7, 0.5))
      }
      prev = p
    }
  },

  sconce(it, M, K, room) {
    const wall = wallAt(room, it.a, -0.02, it.y - 0.05), cup = [it.x, it.y, it.z]
    K.rod(M.grain, wall, cup, 0.018, 0.012, IRON, { segs: 5 })
    K.box(M.grain, frame(...wallAt(room, it.a, 0.01, it.y - 0.05), Math.atan2(-Math.cos(it.a), -Math.sin(it.a))), 0, 0, 0, 0.05, 0.08, 0.015, hsl(room.tints.wood))
    candleOn(M, K, it.x, it.y, it.z, 0.1)
  },
}
