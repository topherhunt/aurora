// A leafkin house's inside, meshed from rollInterior (design/30-leafkin.md, Interiors): one merged mesh per texture, lit by a per-vertex bake of ambient, candle and window light that three uniforms scale each frame, plus the flames and the potted mushrooms, which are the island's own. Everything is built in room-local metres and the group is set at the room's anchor.
import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { TriFlames, TRI_CANDLE } from './fire-tris.js'
import { FILLET, HAMPER_H, STOOL_H, angDiff, ceilingAt, loftDepthAt, rAt, smooth } from '../rooms/interior.js'

const TAU = 2 * Math.PI
const TEX = ['floor', 'wall', 'grain', 'linen', 'door', 'window', 'pot', 'soil', 'pages']
const REPEAT = new Set(['wall', 'grain', 'linen', 'pot', 'soil'])
// Texture metres per repeat on the wall and on carved wood.
const WALL_M = 2.0, WOOD_M = 0.6
const FLAT = [0.5, 0.5]
// The speckle every surface carries on top of its texture: `px` square, one repeat `m` metres on the plane its normal faces most, whole on the flat-coloured (FLAT) and `textured` of it on the rest.
const SPECK = { px: 64, m: 0.3, textured: 0.35 }

let texReady = null
/** The interior textures, loaded once. */
export function loadInteriorTextures() {
  texReady ??= Promise.all(TEX.map((id) => id === 'pages' ? ['pages', pagesTexture()] : new THREE.TextureLoader().loadAsync(`interiors/${id}.webp`).then((t) => {
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
attribute float speck;
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vLight;
varying vec3 vPos;
varying vec3 vNrm;
varying float vSpeck;
void main() {
  vUv = tuv;
  vTint = tint;
  vLight = light;
  vPos = position;
  vNrm = normal;
  vSpeck = speck;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uAmb;
uniform float uCandle;
uniform float uWin;
uniform float uDay;
uniform float uFlicker;
uniform sampler2D speckMap;
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vLight;
varying vec3 vPos;
varying vec3 vNrm;
varying float vSpeck;
void main() {
  vec3 an = abs(vNrm);
  vec2 sp = an.y >= an.x && an.y >= an.z ? vPos.xz : an.x >= an.z ? vPos.zy : vPos.xy;
  vec3 t = texture2D(map, vUv).rgb * mix(1.0, 2.0 * texture2D(speckMap, sp * ${(1 / SPECK.m).toFixed(4)}).r, vSpeck);
  float lit = uAmb * vLight.x + uCandle * vLight.y * uFlicker + uWin * vLight.z * (0.15 + 0.85 * uDay);
  gl_FragColor = vec4(t * vTint * lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

const VERT_WATER = /* glsl */ `
attribute vec3 light;
varying vec3 vLight;
varying vec3 vPos;
varying vec3 vView;
void main() {
  vLight = light;
  vPos = position;
  vView = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
// The basin's water: the room's baked light on dark water, with a Fresnel share of a made-up room (dim wood, lighter upward, banded so the swells visibly bend it) and the nearest candles' glints, all bent by three crossing standing swells a few centimetres long, which rise and fall in place rather than travel.
const WATER_FRAG = /* glsl */ `
uniform float uAmb;
uniform float uCandle;
uniform float uWin;
uniform float uDay;
uniform float uFlicker;
uniform float uTime;
uniform vec4 uGlint[3];
varying vec3 vLight;
varying vec3 vPos;
varying vec3 vView;
void main() {
  vec2 p = vPos.xz, g = vec2(0.0);
  vec2 k0 = vec2(118.0, 41.0), k1 = vec2(-52.0, 131.0), k2 = vec2(-97.0, -88.0);
  g += 0.00022 * cos(dot(p, k0)) * sin(uTime * 1.3) * k0;
  g += 0.00018 * cos(dot(p, k1) + 1.9) * sin(uTime * 0.9 + 2.0) * k1;
  g += 0.00015 * cos(dot(p, k2) + 4.1) * sin(uTime * 1.7 + 4.0) * k2;
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 v = normalize(vView), r = reflect(v, n);
  float lit = uAmb * vLight.x + uCandle * vLight.y * uFlicker + uWin * vLight.z * (0.15 + 0.85 * uDay);
  vec3 room = vec3(0.16, 0.1, 0.055) * (0.45 + 0.25 * r.y + 0.35 * sin(r.x * 23.0) * sin(r.z * 17.0));
  float fres = 0.3 + 0.7 * pow(1.0 - max(0.0, dot(-v, n)), 5.0);
  vec3 c = mix(vec3(0.012, 0.02, 0.018), room, fres) * lit;
  for (int i = 0; i < 3; i++) {
    vec3 l = uGlint[i].xyz - vPos;
    c += vec3(1.0, 0.72, 0.4) * pow(max(0.0, dot(r, normalize(l))), 300.0) * 2.5 * uGlint[i].w * uFlicker / (1.0 + dot(l, l));
  }
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

/** Linear rgb for an sRGB hsl. The wood, wall and floor textures are near grey, so the tint carries their colour. */
function rgb(h, s, l) {
  const c = new THREE.Color().setHSL(((h % 1) + 1) % 1, Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, l)), THREE.SRGBColorSpace)
  return [c.r, c.g, c.b]
}
/** A room tint `{ h, s, l }`, `dl` lighter and `ds` more saturated. */
const tone = (t, dl = 0, ds = 0) => rgb(t.h, t.s + ds, t.l + dl)

/** One merged mesh's buffers. `tri` winds each triangle to face its vertices' normals, so no builder has to. */
class Mesher {
  constructor() {
    this.pos = []
    this.nrm = []
    this.uv = []
    this.tint = []
    this.speck = []
    this.idx = []
    this.lit = null
  }

  get count() { return this.pos.length / 3 }

  v(p, n, uv, tint) {
    this.pos.push(p[0], p[1], p[2])
    this.nrm.push(n[0], n[1], n[2])
    this.uv.push(uv[0], uv[1])
    this.tint.push(tint[0], tint[1], tint[2])
    this.speck.push(uv === FLAT ? 1 : SPECK.textured)
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

  /** A (cols+1) x (rows+1) grid of `at(i, j)` -> { p, uv, n?, tint? }; normals by finite difference where not given, faced the way `sign` says (+1: Tu x Tv). */
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
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
/** `v` turned `ang` about the unit axis `k`. */
const rot = (v, k, ang) => {
  const c = Math.cos(ang), s = Math.sin(ang), d = dot(k, v) * (1 - c), x = cross(k, v)
  return [v[0] * c + x[0] * s + k[0] * d, v[1] * c + x[1] * s + k[1] * d, v[2] * c + x[2] * s + k[2] * d]
}

/** Local -> room frame: an origin and an orthonormal basis with az = ax x ay. `frame` stands it upright at a yaw (three's rotation.y: +Z looks along (sin yaw, cos yaw)). */
const frame = (x, y, z, yaw = 0) => { const c = Math.cos(yaw), s = Math.sin(yaw); return { x, y, z, ax: [c, 0, -s], ay: [0, 1, 0], az: [s, 0, c] } }
/** A frame at `p` whose y runs along `up`, turned `spin` about it. */
const along = (p, up, spin = 0) => {
  const ay = norm(up), ax = rot(norm(cross(ay, Math.abs(ay[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0])), ay, spin)
  return { x: p[0], y: p[1], z: p[2], ax, ay, az: cross(ax, ay) }
}
/** `F` turned `ang` about its own axis `key` ('ax', 'ay' or 'az'), about its origin. */
const tip = (F, key, ang) => { const k = F[key]; return { ...F, ax: rot(F.ax, k, ang), ay: rot(F.ay, k, ang), az: rot(F.az, k, ang) } }
const put = (F, lx, ly, lz) => [F.x + lx * F.ax[0] + ly * F.ay[0] + lz * F.az[0], F.y + lx * F.ax[1] + ly * F.ay[1] + lz * F.az[1], F.z + lx * F.ax[2] + ly * F.ay[2] + lz * F.az[2]]
const turn = (F, nx, ny, nz) => [nx * F.ax[0] + ny * F.ay[0] + nz * F.az[0], nx * F.ax[1] + ny * F.ay[1] + nz * F.az[1], nx * F.ax[2] + ny * F.ay[2] + nz * F.az[2]]
/** Signed power: the superellipse's corner. */
const sp = (t, e) => Math.sign(t) * Math.abs(t) ** e

/** The build kit: every call adds to `m`, in frame `F`, jittered by `rng`. */
function kit(rng) {
  const j = (a) => (rng() * 2 - 1) * a
  /** `F` knocked a little off true, as nothing hand-made stands square. */
  const crook = (F, a) => tip(tip(F, 'ax', j(a)), 'az', j(a))

  /** A profile of [r, y] revolved about the frame's y; a repeated point is a hard edge. `sx`/`sz` squash it, `rough` wobbles its radius, `lobes` [n, depth] ribs it like a gourd. */
  function lathe(m, F, prof, tint, { segs = 16, rough = 0, sx = 1, sz = 1, uvM = WOOD_M, flat = false, phase = 0, lobes = null } = {}) {
    const wob = Array.from({ length: segs }, () => prof.map(() => 1 + j(rough)))
    const len = [0]
    for (let k = 1; k < prof.length; k++) len.push(len[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]))
    const around = Math.max(1, Math.round((TAU * Math.max(...prof.map((p) => p[0]))) / uvM))
    const base = m.count
    for (let i = 0; i <= segs; i++) {
      const q = phase + (i / segs) * TAU, cq = Math.cos(q), sq = Math.sin(q)
      // The lobes' radius factor and its slope round the axis, which tips the normal into the grooves.
      const L = lobes ? 1 - lobes[1] * (0.5 - 0.5 * Math.cos(lobes[0] * q)) : 1
      const dL = lobes ? -lobes[1] * 0.5 * lobes[0] * Math.sin(lobes[0] * q) : 0
      for (let k = 0; k < prof.length; k++) {
        const [r0, y] = prof[k], r = r0 * wob[i % segs][k] * L
        const prev = prof[Math.max(0, k - 1)], next = prof[Math.min(prof.length - 1, k + 1)]
        const same = (a, b) => a[0] === b[0] && a[1] === b[1]
        const t = same(prev, prof[k]) ? sub2(next, prof[k]) : same(next, prof[k]) ? sub2(prof[k], prev) : sub2(next, prev)
        const tl = Math.hypot(t[0], t[1]) || 1
        const nr = t[1] / tl, ny = -t[0] / tl, nt = (-nr * dL) / L
        const n = turn(F, (cq * nr - sq * nt) / sx, ny, (sq * nr + cq * nt) / sz)
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

  /** A rounded box centred at local (cx, cy, cz), half-sizes h: a superellipsoid, `round` 0 square to 1 round, its eight corners pushed about `crook` so no two are alike. Grain runs across each face. */
  function box(m, F, cx, cy, cz, hx, hy, hz, tint, { round = 0.3, segs = 16, rows = 8, crook: cj = 0.01, uvM = WOOD_M, flat = false } = {}) {
    const e = Math.max(0.08, round), jit = Array.from({ length: 8 }, () => [j(cj), j(cj) * 0.5, j(cj)])
    const off = [rng(), rng()], base = m.count
    for (let k = 0; k <= rows; k++) {
      const v = -Math.PI / 2 + (k / rows) * Math.PI, cv = Math.cos(v), sv = Math.sin(v)
      for (let i = 0; i <= segs; i++) {
        const u = (i / segs) * TAU, cu = Math.cos(u), su = Math.sin(u)
        const ux = sp(cv, e) * sp(cu, e), uy = sp(sv, e), uz = sp(cv, e) * sp(su, e)
        const n = [sp(cv, 2 - e) * sp(cu, 2 - e) / hx, sp(sv, 2 - e) / hy, sp(cv, 2 - e) * sp(su, 2 - e) / hz]
        // Trilinear in the corners' pushes.
        const fx = (ux + 1) / 2, fy = (uy + 1) / 2, fz = (uz + 1) / 2
        let d = [0, 0, 0]
        for (let c = 0; c < 8; c++) {
          const w = (c & 1 ? fx : 1 - fx) * (c & 2 ? fy : 1 - fy) * (c & 4 ? fz : 1 - fz)
          d = add(d, jit[c], w)
        }
        const lx = ux * hx + d[0], ly = uy * hy + d[1], lz = uz * hz + d[2]
        const an = [Math.abs(n[0] * hx), Math.abs(n[1] * hy), Math.abs(n[2] * hz)]
        const uv = flat ? FLAT : an[1] >= an[0] && an[1] >= an[2] ? [lx / uvM + off[0], lz / uvM + off[1]] : an[0] >= an[2] ? [lz / uvM + off[0], ly / uvM + off[1]] : [lx / uvM + off[0], ly / uvM + off[1]]
        m.v(put(F, cx + lx, cy + ly, cz + lz), norm(turn(F, ...n)), uv, tint)
      }
    }
    for (let k = 0; k < rows; k++) for (let i = 0; i < segs; i++) {
      const a = base + k * (segs + 1) + i
      m.quad(a, a + 1, a + segs + 2, a + segs + 1)
    }
  }

  /** Rings strung into a tube: each { c, u, v, a, b } is an ellipse about c with semi-axes a along u and b along v. */
  function rings(m, list, tint, { segs = 8, uvM = WOOD_M, flat = false } = {}) {
    const base = m.count
    let len = 0
    for (let k = 0; k < list.length; k++) {
      const R = list[k]
      if (k > 0) len += Math.hypot(...sub(R.c, list[k - 1].c))
      for (let i = 0; i <= segs; i++) {
        const q = (i / segs) * TAU, cq = Math.cos(q), sq = Math.sin(q)
        const p = add(add(R.c, R.u, cq * R.a), R.v, sq * R.b)
        const n = norm(add(R.u.map((x) => (x * cq) / Math.max(R.a, 1e-4)), R.v, sq / Math.max(R.b, 1e-4)))
        m.v(p, n, flat ? FLAT : [(i / segs) * Math.max(1, Math.round((TAU * R.a) / uvM + 0.5)), len / uvM], tint)
      }
    }
    for (let k = 0; k < list.length - 1; k++) for (let i = 0; i < segs; i++) {
      const a = base + k * (segs + 1) + i
      m.quad(a, a + 1, a + segs + 2, a + segs + 1)
    }
  }

  /** A round tube through `pts` with radius `rads[k]` at each, its ends domed shut. */
  function tube(m, pts, rads, tint, { segs = 8, uvM = WOOD_M, flat = false, caps = true } = {}) {
    const T = pts.map((p, k) => norm(sub(pts[Math.min(pts.length - 1, k + 1)], pts[Math.max(0, k - 1)])))
    let u = norm(cross(T[0], Math.abs(T[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))
    const list = []
    for (let k = 0; k < pts.length; k++) {
      u = norm(sub(u, T[k].map((x) => x * dot(u, T[k]))))
      list.push({ c: pts[k], u, v: cross(T[k], u), a: rads[k], b: rads[k] })
    }
    if (caps) {
      const end = (R, t, s) => [0.45, 0.8, 1].map((o, k) => ({ ...R, c: add(R.c, t, s * o * R.a), a: R.a * [0.85, 0.5, 0.02][k], b: R.b * [0.85, 0.5, 0.02][k] }))
      list.unshift(...end(list[0], T[0], -1).reverse())
      list.push(...end(list[list.length - 1], T[T.length - 1], 1))
    }
    rings(m, list, tint, { segs, uvM, flat })
  }

  /** A tapered open rod from p0 to p1. */
  function rod(m, p0, p1, r0, r1, tint, { segs = 8, rough = 0, flat = false, uvM = WOOD_M } = {}) {
    const w = norm(sub(p1, p0)), L = Math.hypot(...sub(p1, p0))
    const u = norm(cross(Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], w)), v = cross(w, u)
    const base = m.count
    for (let i = 0; i <= segs; i++) {
      const q = (i / segs) * TAU, dir = [u[0] * Math.cos(q) + v[0] * Math.sin(q), u[1] * Math.cos(q) + v[1] * Math.sin(q), u[2] * Math.cos(q) + v[2] * Math.sin(q)]
      for (const [t, r] of [[0, r0], [1, r1]]) {
        const rr = r * (1 + (i % segs === 0 ? 0 : j(rough)))
        m.v(add(t === 0 ? p0 : p1, dir, rr), dir, flat ? FLAT : [i / segs, (t * L) / uvM], tint)
      }
    }
    for (let i = 0; i < segs; i++) m.quad(base + i * 2, base + i * 2 + 2, base + i * 2 + 3, base + i * 2 + 1)
  }

  /** A crooked tube from p0 to p1 bowed `bow` sideways at its middle: a leg, a handle, a post. */
  function limb(m, p0, p1, r0, r1, tint, { bow = 0.01, segs = 8, uvM = WOOD_M } = {}) {
    const d = sub(p1, p0), side = norm(cross(d, [j(1), j(1), j(1)]))
    const pts = [0, 0.25, 0.5, 0.75, 1].map((t) => add(lerp3(p0, p1, t), side, bow * Math.sin(Math.PI * t) + j(bow * 0.3) * (t > 0 && t < 1 ? 1 : 0)))
    tube(m, pts, [0, 0.25, 0.5, 0.75, 1].map((t) => r0 + (r1 - r0) * t), tint, { segs, uvM })
  }

  /** An ellipsoid at local c with radii rx, ry, rz. */
  function blob(m, F, c, rx, ry, rz, tint, { segs = 12, rows = 8, rough = 0, flat = true } = {}) {
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

  /** A flat disc of radius r facing `n` at `c`, textured once across (the floor's tree rings on a log's end) or tiled by `uvM`. */
  function disc(m, c, n, r, tint, { segs = 14, uvM = 0, mound = 0 } = {}) {
    const u = norm(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), v = cross(n, u)
    const uv = (x, y) => (uvM ? [x / uvM, y / uvM] : [0.5 + (0.45 * x) / r, 0.5 + (0.45 * y) / r])
    const mid = m.v(add(c, n, mound), n, uv(0, 0), tint), ring = []
    for (let i = 0; i <= segs; i++) {
      const q = (i / segs) * TAU, rr = r * (i === segs ? 1 : 1 + j(0.04)), x = Math.cos(q) * rr, y = Math.sin(q) * rr
      ring.push(m.v(add(add(c, u, x), v, y), n, uv(x, y), tint))
    }
    for (let i = 0; i < segs; i++) m.tri(mid, ring[i], ring[i + 1])
  }

  /** A leaf: a two-sided pointed quad from `at` along `dir`, `w` wide, facing `face`. */
  function leaf(m, at, dir, len, w, face, tint) {
    const side = norm(cross(dir, face)), n = norm(face)
    const tip2 = add(at, dir, len), mid = add(at, dir, len * 0.45)
    const l = add(mid, side, w), r = add(mid, side, -w)
    for (const s of [1, -1]) {
      const nn = [n[0] * s, n[1] * s, n[2] * s]
      const ids = [at, l, tip2, r].map((p) => m.v(p, nn, FLAT, tint))
      m.quad(...ids)
    }
  }

  return { j, crook, lathe, box, rings, tube, rod, limb, blob, disc, leaf }
}

/**
 * The meshes for `room`, set at (ox, oy, oz); its potted mushrooms are drawn from `mushrooms`, the island's own bank and material. `update(t, dayness, eye)` flickers the candles (their LODs measured from `eye`) and brings the windows up with the day.
 */
export class InteriorView {
  constructor(room, tex, ox, oy, oz, mushrooms) {
    if (!mushrooms?.bank || !mushrooms.material) throw new Error('InteriorView: needs the island\'s mushrooms for the pots')
    this.room = room
    this.group = new THREE.Group()
    this.group.position.set(ox, oy, oz)
    this.uniforms = { uAmb: { value: 0.55 }, uCandle: { value: 1.0 }, uWin: { value: 0.9 }, uDay: { value: 1 }, uFlicker: { value: 1 } }
    const rng = mulberry32(hash32(room.seed, room.index, 0x1d1))
    const K = kit(rng)
    const M = Object.fromEntries(TEX.map((id) => [id, new Mesher()]))
    const out = { shrooms: [], water: [] }
    buildShell(room, M, K)
    for (const it of room.items) {
      const make = ITEMS[it.kind]
      if (!make) throw new Error(`InteriorView: no builder for ${it.kind}`)
      make(it, M, K, room, rng, out)
    }
    const tops = shadeTops(room)
    const speckMap = speckleTexture()
    for (const id of TEX) {
      const m = M[id]
      if (m.count === 0) continue
      bake(room, m, tops)
      // The panes are lit from outside, not by the room.
      if (id === 'window') for (let i = 0; i < m.count; i++) m.lit.set([0.35, 0.1, 1.5], i * 3)
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3))
      g.setAttribute('normal', new THREE.Float32BufferAttribute(m.nrm, 3))
      g.setAttribute('speck', new THREE.Float32BufferAttribute(m.speck, 1))
      g.setAttribute('tuv', new THREE.Float32BufferAttribute(m.uv, 2))
      g.setAttribute('tint', new THREE.Float32BufferAttribute(m.tint, 3))
      g.setAttribute('light', new THREE.Float32BufferAttribute(m.lit, 3))
      g.setIndex(m.idx)
      g.computeBoundingSphere()
      const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { map: { value: tex[id] }, speckMap: { value: speckMap }, ...this.uniforms }, fog: false })
      const mesh = new THREE.Mesh(g, mat)
      mesh.name = `interior-${id}`
      mesh.frustumCulled = false
      this.group.add(mesh)
    }
    this.uTime = { value: 0 }
    for (const w of out.water) this.group.add(buildWater(room, w, tops, this.uniforms, this.uTime))
    this.shroomMeshes = buildShrooms(out.shrooms, mushrooms)
    for (const mesh of this.shroomMeshes) this.group.add(mesh)
    this.flames = buildFlames(room.candles, ox, oy, oz)
    this.group.add(this.flames.group)
  }

  update(t, dayness, eye) {
    const f = 0.9 + 0.06 * Math.sin(t * 7.3) + 0.04 * Math.sin(t * 13.7 + 1.3)
    this.uniforms.uFlicker.value = f
    this.uniforms.uDay.value = dayness
    this.uTime.value = t
    this.flames.update(t, f, eye)
  }

  dispose() {
    this.group.removeFromParent()
    // The mushrooms' material is the island's; only their instance geometry is ours.
    const shared = new Set(this.shroomMeshes.map((m) => m.material))
    this.group.traverse((o) => {
      o.geometry?.dispose()
      if (o.material && !shared.has(o.material)) o.material.dispose()
    })
    this.flames.dispose()
  }
}

/** A basin's water: disc `w` ({ x, y, z, r }), baked like the room and glinting with its three nearest candles. */
function buildWater(room, w, tops, uniforms, uTime) {
  const m = new Mesher(), segs = 24
  const c = m.v([w.x, w.y, w.z], [0, 1, 0], FLAT, [1, 1, 1])
  for (let k = 0; k <= segs; k++) { const a = (k / segs) * TAU; m.v([w.x + Math.cos(a) * w.r, w.y, w.z + Math.sin(a) * w.r], [0, 1, 0], FLAT, [1, 1, 1]) }
  for (let k = 0; k < segs; k++) m.tri(c, c + 1 + k, c + 2 + k)
  bake(room, m, tops)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3))
  g.setAttribute('light', new THREE.Float32BufferAttribute(m.lit, 3))
  g.setIndex(m.idx)
  g.computeBoundingSphere()
  const near = [...room.candles].sort((a, b) => Math.hypot(a.x - w.x, a.z - w.z) - Math.hypot(b.x - w.x, b.z - w.z))
  const glint = [0, 1, 2].map((i) => (near[i] ? new THREE.Vector4(near[i].x, near[i].y, near[i].z, near[i].i) : new THREE.Vector4()))
  const mat = new THREE.ShaderMaterial({ vertexShader: VERT_WATER, fragmentShader: WATER_FRAG, uniforms: { ...uniforms, uTime, uGlint: { value: glint } }, fog: false })
  const mesh = new THREE.Mesh(g, mat)
  mesh.name = 'interior-water'
  return mesh
}

/** One InstancedMesh per mushroom variant in the pots, on the bank's finest tier; `aPropFade` 1 is the material's never-faded. */
function buildShrooms(list, { bank, material }) {
  const byV = new Map()
  for (const s of list) {
    const v = Math.min(bank.variants.length - 1, Math.floor(s.v * bank.variants.length))
    if (!byV.has(v)) byV.set(v, [])
    byV.get(v).push(s)
  }
  const meshes = []
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qt = new THREE.Quaternion(), ax = new THREE.Vector3(), sc = new THREE.Vector3(), pos = new THREE.Vector3()
  for (const [v, all] of byV) {
    const src = bank.tiers[0].geometries[v], geo = new THREE.BufferGeometry()
    for (const [name, attr] of Object.entries(src.attributes)) geo.setAttribute(name, attr)
    geo.setIndex(src.index)
    geo.setAttribute('aPropFade', new THREE.InstancedBufferAttribute(new Float32Array(all.length).fill(1), 1))
    const mesh = new THREE.InstancedMesh(geo, material, all.length)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(all.length * 3), 3)
    all.forEach((s, k) => {
      q.setFromAxisAngle(ax.set(0, 1, 0), s.yaw)
      qt.setFromAxisAngle(ax.set(Math.cos(s.tiltA), 0, Math.sin(s.tiltA)), s.tilt)
      q.premultiply(qt)
      const k1 = s.size / bank.variants[v].height
      m4.compose(pos.set(s.x, s.y, s.z), q, sc.set(k1, k1, k1))
      mesh.setMatrixAt(k, m4)
      // Sun-lit material in a candle-lit room: dimmed to sit with the bake.
      mesh.instanceColor.setXYZ(k, 0.5, 0.47, 0.42)
    })
    mesh.frustumCulled = false
    mesh.name = 'interior-shrooms'
    meshes.push(mesh)
  }
  return meshes
}

// --- the shell: wall, floor, ceiling, ribs, openings, loft, stairs ------------------------------

// A door's or window's reveal: its own polar mesh easing from the pane out to the wall over `w` metres, then a `skirt` lying `lift` proud of the wall. The wall's grid is too coarse to carry that curve (its rim comes out in squares), so under the reveal the grid is sunk out of sight behind it; the skirt must outreach the sunk patch by a grid cell's diagonal (~0.1 m), or the cells sloping down into it notch the wall.
const REVEAL = { w: 0.12, skirt: 0.14, lift: 0.004 }

/** How far the wall at bearing `a`, height `y` is pushed out of sight behind the door's or a window's reveal. */
function recess(room, a, y) {
  let out = 0
  for (const o of [room.door, ...room.windows]) if (Math.hypot(angDiff(a, o.a) * rAt(room.rs, o.a), y - o.y) < o.r + REVEAL.w + 0.02) out = Math.max(out, o.depth + 0.04)
  return out
}

/** The floor's cove at height `y`: how far in from the wall the profile stands there. */
const coveAt = (y) => FILLET * (1 - Math.sqrt(1 - (1 - Math.min(Math.max(y, 0), FILLET) / FILLET) ** 2))

function buildShell(room, M, K) {
  const { rs, hW, H } = room
  const COLS = 300
  // The wall's profile up from the floor's edge: the cove, then the wall to the ring beam, as [inset from the wall, y].
  const prof = []
  for (let k = 0; k <= 4; k++) { const q = (k / 4) * (Math.PI / 2); prof.push([FILLET * (1 - Math.sin(q)), FILLET * (1 - Math.cos(q))]) }
  const rows = Math.ceil((hW - FILLET) / 0.065)
  for (let k = 1; k <= rows; k++) prof.push([0, FILLET + ((hW - FILLET) * k) / rows])
  const arc = [0]
  for (let k = 1; k < prof.length; k++) arc.push(arc[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]))
  const around = Math.round((TAU * room.R) / WALL_M)
  const wallPt = (i, j) => {
    const a = (i / COLS) * TAU
    const rr = rAt(rs, a) - prof[j][0] + recess(room, a, prof[j][1])
    return { p: [Math.cos(a) * rr, prof[j][1], Math.sin(a) * rr], uv: [(i / COLS) * around, arc[j] / WALL_M] }
  }
  // Tu (round the bearing) x Tv (up the profile) looks into the room.
  const wallTint = tone(room.tints.wall, 0.12, 0.1)
  M.wall.grid(COLS, prof.length - 1, wallPt, wallTint, 1, true)
  // Each opening's reveal, textured as the wall it stands in; Tu (round the pane) x Tv (outward) looks into the wall. The door's runs under the floor: there it is held a hair over the floor and eased out of the cove, so it lays a threshold into the recess.
  for (const o of [room.door, ...room.windows]) {
    const r0 = rAt(rs, o.a), ds = []
    for (let k = 0; k <= 8; k++) ds.push(o.r + (REVEAL.w * k) / 8)
    ds.push(o.r + REVEAL.w + REVEAL.skirt)
    M.wall.grid(48, ds.length - 1, (i, j) => {
      const th = (i / 48) * TAU, d = ds[j], y = Math.max(0.003, o.y + d * Math.sin(th)), a = o.a + (d * Math.cos(th)) / r0
      const rr = rAt(rs, a) + (o.depth - 0.012 + REVEAL.lift) * (1 - smooth(o.r, o.r + REVEAL.w, d)) - REVEAL.lift - coveAt(y) * smooth(o.r, o.r + REVEAL.w, d)
      return { p: [Math.cos(a) * rr, y, Math.sin(a) * rr], uv: [(a / TAU) * around, (arc[4] + y - FILLET) / WALL_M] }
    }, wallTint, -1, true)
  }

  // The floor, in rings out to the wall's foot, its rings texture stretched once across it; the rings close enough that the bake's furniture shadows don't smear out along the spokes.
  const RINGS = 36, span = 2 * Math.max(...rs)
  M.floor.grid(COLS, RINGS, (i, j) => {
    const edge = wallPt(i, 0).p, t = j / RINGS
    const p = [edge[0] * t, 0, edge[2] * t]
    return { p, uv: [p[0] / span + 0.5, p[2] / span + 0.5], n: [0, 1, 0] }
  }, tone(room.tints.wood, 0.2), 1, true)

  // The dome, one slab of end grain: the floor's rings, laid out by true distance from the apex so they neither tile nor pinch.
  const DOME = 18, dome = []
  let reach = 0
  for (let i = 0; i <= COLS; i++) {
    const a = (i / COLS) * TAU, r = rAt(rs, a), col = []
    for (let j = 0; j <= DOME; j++) {
      const phi = (j / DOME) * (Math.PI / 2)
      col.push([Math.cos(a) * r * Math.cos(phi), hW + (H - hW) * Math.sin(phi), Math.sin(a) * r * Math.cos(phi)])
    }
    const s = [0]
    for (let j = DOME - 1; j >= 0; j--) s.unshift(s[0] + Math.hypot(...sub(col[j], col[j + 1])))
    reach = Math.max(reach, s[0])
    dome.push({ a, col, s })
  }
  M.floor.grid(COLS, DOME, (i, j) => {
    const { a, col, s } = dome[i], k = (0.48 * s[j]) / reach
    return { p: col[j], uv: [0.5 + Math.cos(a) * k, 0.5 + Math.sin(a) * k], n: j === DOME ? [0, -1, 0] : null }
  }, tone(room.tints.wood, 0.12), 1, true)

  // The ring beam over the seam of wall and dome.
  const beam = []
  for (let i = 0; i <= COLS; i += 2) {
    const a = (i / COLS) * TAU, r = rAt(rs, a), c = [Math.cos(a) * r, hW + 0.01 * Math.sin(a * 7), Math.sin(a) * r]
    beam.push({ c, u: [0, 1, 0], v: [-Math.cos(a), 0, -Math.sin(a)], a: 0.075 + 0.008 * Math.sin(a * 5), b: 0.07 })
  }
  K.rings(M.grain, beam, tone(room.tints.wood, -0.07, 0.08), { segs: 10 })
  for (const rb of room.ribs) buildRib(room, M, K, rb)

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
  disc(M.door, room.door, [0.27, 0.24, 0.21])
  for (const w of room.windows) disc(M.window, w, [1, 1, 1])

  if (room.loft) buildLoft(room, M, K)
  if (room.stairs.length) buildStairs(room, M, K)
}

/** A rib: a timber half sunk in the wall, flared at its foot, leaning as it climbs, and carried over the dome to taper into it short of the apex. */
function buildRib(room, M, K, rb) {
  const { rs, hW, H } = room, list = []
  const ring = (a, c, v, w, d) => list.push({ c, u: [-Math.sin(a), 0, Math.cos(a)], v, a: w, b: d })
  const wob = K.j(10)
  for (let y = -0.02; y < hW; y += 0.08) {
    const a = rb.a + (rb.lean * y) / hW + 0.004 * Math.sin(y * 4 + wob), r = rAt(rs, a)
    const flare = 1 + 0.6 * (1 - smooth(0, 0.35, y))
    ring(a, [Math.cos(a) * r, y, Math.sin(a) * r], [-Math.cos(a), 0, -Math.sin(a)], (rb.w / 2) * flare, rb.d * flare)
  }
  const a = rb.a + rb.lean, r = rAt(rs, a), N = 12, end = 0.8 * (Math.PI / 2)
  for (let k = 0; k <= N; k++) {
    const phi = (k / N) * end, t = k / N
    const c = [Math.cos(a) * r * Math.cos(phi), hW + (H - hW) * Math.sin(phi), Math.sin(a) * r * Math.cos(phi)]
    const out = norm([(Math.cos(a) * Math.cos(phi)) / r, Math.sin(phi) / (H - hW), (Math.sin(a) * Math.cos(phi)) / r])
    ring(a, c, [-out[0], -out[1], -out[2]], (rb.w / 2) * (1 - 0.45 * t), rb.d * (1 - t) ** 1.5 * 0.9 + 0.005)
  }
  K.rings(M.grain, list, tone(room.tints.wood, -0.08, 0.08), { segs: 12 })
}

/**
 * The stairs as one piece carved down the wall from the loft's end: a height field along the wall (each tread's top, blended into the next over a rounded nose) swept through a rounded cross-section. Every tread is knocked a little off in height, width and tilt, and blended by the same weights, so the whole flight is crooked and nothing is square.
 */
function buildStairs(room, M, K) {
  const { loft, stairs } = room
  const dir = loft.dir, e = dir > 0 ? loft.a1 : loft.a0, W0 = stairs[0].w
  const rc = rAt(room.rs, e) - W0 / 2
  // Metres along the wall from the loft's end to each tread's far edge.
  const edge = stairs.map((s) => ((dir > 0 ? s.a1 : s.a0) - e) * dir * rc)
  const n = stairs.length
  const jit = stairs.map(() => ({ dh: K.j(0.02), dw: K.j(0.05), tilt: K.j(0.07), dl: K.j(0.05) }))
  const B = 0.06
  const step = (x) => smooth(-B, B, x)
  const t0 = -0.14, t1 = edge[n - 1] + 0.08
  const cols = Math.ceil((t1 - t0) / 0.015)
  const phase = K.j(10)
  const col = []
  for (let i = 0; i <= cols; i++) {
    const t = t0 + ((t1 - t0) * i) / cols
    let h = 0, W = 0, tilt = 0, dl = 0
    for (let k = 0; k < n; k++) {
      const w = (k === 0 ? 1 : step(t - edge[k - 1])) - step(t - edge[k])
      h += w * (stairs[k].top + jit[k].dh); W += w * (W0 + jit[k].dw); tilt += w * jit[k].tilt; dl += w * jit[k].dl
    }
    // Past the last tread it runs down to the floor; under the loft it narrows into the wall.
    W = (W + step(t - edge[n - 1]) * W0 * 0.8 + 0.012 * Math.sin(t * 23 + phase)) * smooth(t0, -0.04, t)
    // Treads worn hollow and lumpy, not planed.
    h += 0.007 * Math.sin(t * 31 + phase) + 0.004 * Math.sin(t * 71 + 2 * phase)
    const ht = (inset) => Math.max(0, h + tilt * (inset - W / 2) - 0.012 * Math.sin((Math.PI * Math.min(Math.max(inset, 0), W)) / Math.max(W, 0.01)))
    const sec = [[W - 0.02, 0], [W + 0.012, h * 0.45], [W, Math.max(0, h - 0.05)], [W - 0.018, Math.max(0, h - 0.014)], [W - 0.05, ht(W - 0.05)], [W * 0.5, ht(W * 0.5) + 0.006], [0.05, ht(0.05)], [-0.1, ht(0)]]
    const a = e + (dir * t) / rc
    const pts = sec.map(([inset, y], k) => { const r = rAt(room.rs, a) - inset - (k > 0 && k < 7 ? K.j(0.005) : 0); return [Math.cos(a) * r, y, Math.sin(a) * r] })
    const s = [0]
    for (let k = 1; k < pts.length; k++) s.push(s[k - 1] + Math.hypot(...sub(pts[k], pts[k - 1])))
    col.push({ t, pts, s, tint: tone(room.tints.wood, -0.03 + dl, 0.08) })
  }
  M.grain.grid(cols, 7, (i, k) => ({ p: col[i].pts[k], uv: [col[i].t / WOOD_M, col[i].s[k] / WOOD_M], tint: col[i].tint }), null, dir)
}

function buildLoft(room, M, K) {
  const { loft } = room
  const wood = tone(room.tints.wood, -0.03, 0.08)
  const cols = Math.max(8, Math.ceil(((loft.a1 - loft.a0) * room.R) / 0.05))
  const y0 = loft.y - loft.thick, y1 = loft.y
  // The slab's cross-section at each bearing, from the wall under it round its rounded lip to the wall over it.
  const sect = (d) => [[-0.1, y0], [d - 0.07, y0], [d - 0.02, y0 + 0.015], [d, y0 + 0.05], [d + 0.006, y1 - 0.04], [d - 0.008, y1 - 0.01], [d - 0.035, y1], [-0.1, y1]]
  const wob = K.j(10)
  const at = (i, k) => {
    const a = loft.a0 + (i / cols) * (loft.a1 - loft.a0), d = loftDepthAt(loft, a) + 0.015 * Math.sin(a * 17 + wob), r = rAt(room.rs, a)
    const [inset, y] = sect(Math.max(d, 0.02))[k]
    return { a, p: [Math.cos(a) * (r - inset), y, Math.sin(a) * (r - inset)] }
  }
  // Grain across the boards on top, along the slab below.
  M.grain.grid(cols, 7, (i, k) => {
    const { a, p } = at(i, k)
    return { p, uv: [((a - loft.a0) * room.R) / WOOD_M, (k * 0.05 + Math.hypot(p[0], p[2])) / WOOD_M] }
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
  const top = (p, k) => [p[0], p[1] + 0.45 + 0.012 * Math.sin(k * 1.7), p[2]]
  for (let k = 0; k < pts.length; k += 2) K.limb(M.grain, pts[k], top(pts[k], k), 0.03, 0.024, wood, { bow: 0.012 })
  if (pts.length > 1) K.tube(M.grain, pts.map((p, k) => top(p, k)), pts.map((_, k) => 0.03 + 0.003 * Math.sin(k * 2.3)), wood, { segs: 10 })
  for (let k = 0; k < pts.length - 1; k += 2) {
    const mid = [(pts[k][0] + pts[k + 1][0]) / 2, pts[k][1] + 0.22, (pts[k][2] + pts[k + 1][2]) / 2]
    K.limb(M.grain, [pts[k][0], pts[k][1] + 0.05, pts[k][2]], mid, 0.013, 0.012, wood, { bow: 0.006, segs: 6 })
  }
}

// --- the bake ---------------------------------------------------------------

// The bake is analytic, a few hundred flops a vertex, so it runs behind the door's fade on a Quest. The fill `amb` falls to `corner` of itself in the wall's foot and under the loft; each candle gives `candle` times its `i` at the flame, falling by e every `reach` metres so its pool ends within a few metres and the corners stay dark; a flat top (a table, a chest, the loft) between a light and a vertex passes `pass` of it, softened over a penumbra from `pen[0]` metres at the top's edge widening `pen[1]` a metre of drop below it; under such a top the fill falls to `under`. A window's light comes from its pane, `depth` back in its reveal: a beam into the room, halved `beamM` metres out, and `spill` round itself whichever way a surface faces, falling by e every `spillM` metres, so the reveal and the wall about it are the room's brightest.
const SHADE = { amb: 0.18, corner: 0.45, candle: 2.6, reach: 0.6, cap: 1.8, pass: 0.12, pen: [0.03, 0.35], under: 0.35, spill: 2.6, spillM: 1.0, beamM: 1.1 }

/** The flat tops that shade what is under them: the room's solids that are true furniture tops (under BLOCK) and the loft's floor, highest first, each with `y`, its footprint's bounds `x0 x1 z0 z1`, and `inBy(x, z)`, metres inside that footprint (negative outside). */
function shadeTops(room) {
  const tops = []
  const box = (t, pts) => {
    t.x0 = Math.min(...pts.map((p) => p[0])); t.x1 = Math.max(...pts.map((p) => p[0]))
    t.z0 = Math.min(...pts.map((p) => p[1])); t.z1 = Math.max(...pts.map((p) => p[1]))
    return t
  }
  for (const s of room.solids) {
    if (s.rail || (!s.loft && (s.y1 >= 0.79 || s.y1 < 0.1))) continue
    if (s.kind === 'cyl') tops.push(box({ y: s.y1, inBy: (x, z) => s.r - Math.sqrt((x - s.x) ** 2 + (z - s.z) ** 2) }, [[s.x - s.r, s.z - s.r], [s.x + s.r, s.z + s.r]]))
    else if (s.kind === 'box') {
      const c = Math.cos(s.yaw), sn = Math.sin(s.yaw), e = Math.hypot(s.hx, s.hz)
      tops.push(box({ y: s.y1, inBy: (x, z) => { const dx = x - s.x, dz = z - s.z; return Math.min(s.hx - Math.abs(dx * c - dz * sn), s.hz - Math.abs(dx * sn + dz * c)) } }, [[s.x - e, s.z - e], [s.x + e, s.z + e]]))
    } else {
      const pts = []
      for (let k = 0; k <= 24; k++) {
        const a = s.a0 + ((s.a1 - s.a0) * k) / 24, r = rAt(room.rs, a)
        for (const d of s.loft ? [0, loftDepthAt(s.loft, a)] : [s.from, s.to]) pts.push([Math.cos(a) * (r - d), Math.sin(a) * (r - d)])
      }
      tops.push(box({ y: s.y1, loft: !!s.loft, inBy: (x, z) => bandIn(room, s, x, z) }, pts))
    }
  }
  return tops.sort((a, b) => b.y - a.y)
}

/** Whether (x, z) is within `m` metres of top `t`'s bounds. */
const nearTop = (t, x, z, m) => x > t.x0 - m && x < t.x1 + m && z > t.z0 - m && z < t.z1 + m

/** Metres inside band `s` (a wall arc, or the loft's floor to its lip) at (x, z), negative outside. */
function bandIn(room, s, x, z) {
  const a = Math.atan2(z, x), r = rAt(room.rs, a), inset = r - Math.sqrt(x * x + z * z)
  const t = ((a - s.a0) % TAU + TAU) % TAU, span = s.a1 - s.a0
  const side = (t > span ? -Math.min(t - span, TAU - t) : Math.min(t, span - t)) * r
  const deep = s.loft ? loftDepthAt(s.loft, a) - inset : Math.min(inset - s.from, s.to - inset)
  return Math.min(side, deep)
}

/** Per vertex: x fill, y candle, z window. */
function bake(room, m, tops) {
  const n = m.count, L = new Float32Array(n * 3), P = m.pos, N = m.nrm
  const wins = room.windows.map((w) => {
    const r = rAt(room.rs, w.a) + w.depth
    return { p: [Math.cos(w.a) * r, w.y, Math.sin(w.a) * r], ax: [-Math.cos(w.a), 0, -Math.sin(w.a)], k: ((w.r / 0.3) ** 2) * 1.2 }
  })
  // Each candle's tops near enough to come between it and anything: those under its flame from the highest down, those over it from the lowest up, so a vertex's search stops at the first top not between them.
  const lights = room.candles.map((c) => {
    const near = tops.filter((t) => nearTop(t, c.x, c.z, 2.5))
    return { c, under: near.filter((t) => t.y < c.y - 0.01).sort((a, b) => b.y - a.y), over: near.filter((t) => t.y > c.y + 0.01).sort((a, b) => a.y - b.y) }
  })
  for (let i = 0; i < n; i++) {
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2], nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2]
    let amb = SHADE.amb * (0.8 + 0.2 * ny)
    if (py < 0.5) amb *= 1 - (1 - SHADE.corner) * (1 - smooth(0, 0.5, py)) * (1 - smooth(FILLET, FILLET + 0.6, rAt(room.rs, Math.atan2(pz, px)) - Math.sqrt(px * px + pz * pz)))
    // Under the loft the whole height; under furniture its first metre.
    for (const t of tops) { if (py >= t.y - 0.01) break; if (nearTop(t, px, pz, 0.1)) amb *= 1 - (1 - SHADE.under) * smooth(-0.1, 0.12, t.inBy(px, pz)) * (t.loft ? 0.6 : 1 - smooth(0.3, 0.9, t.y - py)) }
    let cand = 0
    for (const { c, under, over } of lights) {
      const dx = c.x - px, dy = c.y - py, dz = c.z - pz, d2 = dx * dx + dy * dy + dz * dz
      if (d2 > 16) continue
      const dl = Math.sqrt(d2) || 1
      let got = SHADE.candle * c.i * Math.exp(-dl / SHADE.reach) * (0.35 + 0.65 * Math.max(0, (nx * dx + ny * dy + nz * dz) / dl))
      // A top between the flame's height and the vertex's shades it where the line between them crosses it; light this faint is left unshaded.
      const list = py < c.y ? under : over
      for (let j = 0; got > 0.03 && j < list.length; j++) {
        const t = list[j], drop = Math.abs(t.y - py)
        if (py < c.y ? t.y < py + 0.005 : t.y > py - 0.005) break
        const k = (t.y - py) / dy, pen = SHADE.pen[0] + SHADE.pen[1] * drop, qx = px + dx * k, qz = pz + dz * k
        if (nearTop(t, qx, qz, pen)) got *= 1 - (1 - SHADE.pass) * smooth(-pen, pen, t.inBy(qx, qz))
      }
      cand += got
    }
    let win = 0
    for (const w of wins) {
      const dx = px - w.p[0], dy = py - w.p[1], dz = pz - w.p[2], along = dx * w.ax[0] + dz * w.ax[2]
      if (along <= -0.1) continue
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1, facing = Math.max(0, -(nx * dx + ny * dy + nz * dz) / dl)
      win += w.k * (SHADE.spill * Math.exp(-dl / SHADE.spillM) * (0.5 + 0.5 * facing) + (smooth(0.15, 0.85, along / dl) * Math.max(0.2, facing)) / (1 + (dl / SHADE.beamM) ** 2))
    }
    // Candles crowd onto the table: saturate their sum so it glows rather than bleaches.
    L[i * 3] = amb; L[i * 3 + 1] = SHADE.cap * (1 - Math.exp(-cand / SHADE.cap)); L[i * 3 + 2] = win * (amb / SHADE.amb)
  }
  m.lit = L
}

let speckTex = null
/** The speckle, built once in code: a fine grain of blurred noise with sparse dark and light flecks, about a half grey (the shader doubles it), tiling. */
function speckleTexture() {
  if (speckTex) return speckTex
  const n = SPECK.px, rng = mulberry32(0x5bec1e), raw = Float32Array.from({ length: n * n }, () => rng() - 0.5), d = new Uint8Array(n * n * 4)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let g = 0
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) g += raw[((y + j + n) % n) * n + ((x + i + n) % n)]
    const r = rng()
    const v = 1 + 0.16 * g - (r < 0.05 ? 0.35 : 0) + (r > 0.97 ? 0.2 : 0)
    d.fill(Math.max(0, Math.min(255, Math.round(v * 127.5))), (y * n + x) * 4, (y * n + x) * 4 + 3)
    d[(y * n + x) * 4 + 3] = 255
  }
  speckTex = new THREE.DataTexture(d, n, n)
  speckTex.wrapS = speckTex.wrapT = THREE.RepeatWrapping
  speckTex.magFilter = THREE.LinearFilter
  speckTex.minFilter = THREE.LinearMipmapLinearFilter
  speckTex.generateMipmaps = true
  speckTex.needsUpdate = true
  return speckTex
}

// A book's page edges, built in code: one repeat is `m` metres of paper across the block, cream leaves with grey gaps.
const PAGES = { px: 32, m: 0.012 }
function pagesTexture() {
  const n = PAGES.px, rng = mulberry32(0x9a9e5), d = new Uint8Array(n * 4 * 4)
  for (let x = 0; x < n; x++) {
    const v = rng() < 0.3 ? 150 + rng() * 40 : 215 + rng() * 25
    for (let y = 0; y < 4; y++) d.set([v, v * 0.97, v * 0.9, 255], (y * n + x) * 4)
  }
  const t = new THREE.DataTexture(d, n, 4)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.needsUpdate = true
  return t
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

// The flames are triangle flames (fire-tris.js) in world space, so they are placed at the room's anchor; the halo behind each is a soft additive sprite.
function buildFlames(candles, ox, oy, oz) {
  const group = new THREE.Group()
  const flames = new TriFlames(candles.length, TRI_CANDLE, { seed: candles.length + 1 })
  // A candle's `y` is 3.5 cm over its wax's shoulder; the flame's foot rests on the wax.
  candles.forEach((c, i) => flames.place(i, ox + c.x, oy + c.y - 0.02, oz + c.z, { height: TRI_CANDLE.height, radius: TRI_CANDLE.radius, phase: i * 2.1, group: i % 3 }))
  group.add(flames.group)
  const hp = new THREE.BufferGeometry()
  hp.setAttribute('position', new THREE.Float32BufferAttribute(candles.flatMap((c) => [c.x, c.y, c.z]), 3))
  const glowMap = glowTexture()
  const haloMat = new THREE.PointsMaterial({ map: glowMap, size: 0.35, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })
  const halos = new THREE.Points(hp, haloMat)
  halos.frustumCulled = false
  group.add(halos)
  return {
    group,
    update(t, f, eye) {
      haloMat.size = 0.35 * (0.85 + 0.3 * (f - 0.9) * 5)
      halos.visible = TriFlames.shown
      flames.update(t, [f, f, f], eye)
    },
    dispose() { flames.dispose(); glowMap.dispose() },
  }
}

// --- the furniture and things ---------------------------------------------------

// Worn country colours: earthenware, tallow, moss, rust, iron, cord and wicker, none of them brighter than the bark outside by much.
const CLAY = (h) => rgb(0.05 + h * 0.04, 0.36, 0.3)
const CREAM = rgb(0.11, 0.2, 0.52)
const WAX = rgb(0.12, 0.3, 0.72)
const GREEN = (k = 0) => rgb(0.24 + k * 0.06, 0.3, 0.3)
const MUTED = (h) => rgb(h, 0.22, 0.36)
const DARK = rgb(0.07, 0.3, 0.18)
const IRON = rgb(0.08, 0.08, 0.2)
const TIN = rgb(0.1, 0.08, 0.38)
const CORD = rgb(0.1, 0.25, 0.45)
const WICKER = rgb(0.1, 0.36, 0.4)
const BURLAP = (h) => rgb(0.08 + h * 0.03, 0.28, 0.26 + h * 0.05)
/** A room wood tint, a touch lighter or darker per piece. */
const woodOf = (room, K, key = 'wood', dl = -0.03) => tone(room.tints[key], dl + K.j(0.04), 0.08)

/** A point against the wall at bearing `a`, `inset` in, height y. */
const wallAt = (room, a, inset, y) => { const r = rAt(room.rs, a) - inset; return [Math.cos(a) * r, y, Math.sin(a) * r] }
/** The yaw that faces into the room from the wall at bearing `a`. */
const inward = (a) => Math.atan2(-Math.cos(a), -Math.sin(a))

/**
 * A run along the wall from bearing a0 to a1 of the cross-section `sec(f)` -> [[inset, y], ...], listed from its foot on the room side up and over into the wall. Its ends round back into the wall over `endM` as `f` goes to 0 there.
 */
function wallRun(m, room, a0, a1, sec, tint, { endM = 0.06, step = 0.03 } = {}) {
  const rm = rAt(room.rs, (a0 + a1) / 2), cols = Math.max(6, Math.ceil(((a1 - a0) * rm) / step)), rows = sec(1).length - 1
  m.grid(cols, rows, (i, k) => {
    const a = a0 + (i / cols) * (a1 - a0), f = Math.sqrt(smooth(0, endM, Math.min(a - a0, a1 - a) * rm))
    const s = sec(f), [inset, y] = s[k]
    let v = 0
    for (let q = 1; q <= k; q++) v += Math.hypot(s[q][0] - s[q - 1][0], s[q][1] - s[q - 1][1])
    return { p: wallAt(room, a, inset, y), uv: [((a - a0) * rm) / WOOD_M, v / WOOD_M] }
  }, tint, 1)
}

function candleOn(M, K, x, y, z, h, dish = CLAY(0.3)) {
  K.lathe(M.linen, frame(x, y, z), [[0, 0], [0.04, 0], [0.046, 0.008], [0.044, 0.014], [0.02, 0.014], [0, 0.014]], dish, { segs: 14, flat: true, rough: 0.04 })
  K.lathe(M.linen, frame(x, y + 0.012, z), [[0, 0], [0.017, 0], [0.018, h * 0.6], [0.016, h * 0.92], [0.012, h], [0, h + 0.004]], WAX, { segs: 10, flat: true, rough: 0.08 })
}

/** A clay pot on the pot texture with soil at `soilY` (all local to F), for real mushrooms. */
function potOn(M, K, F, r, h, soilY) {
  K.lathe(M.pot, F, [[0, 0.003], [r * 0.62, 0], [r * 0.7, 0.012], [r * 0.86, h * 0.45], [r * 0.93, h * 0.8], [r * 1.02, h * 0.88], [r * 1.04, h * 0.97], [r * 0.99, h], [r * 0.9, h * 0.97], [r * 0.86, soilY - 0.01]], rgb(0.07, 0.18, 0.78), { segs: 18, rough: 0.025, uvM: 0.14 })
  K.disc(M.soil, put(F, 0, soilY, 0), F.ay, r * 0.88, rgb(0.08, 0.1, 0.72), { segs: 16, uvM: 0.24, mound: 0.008 })
}

/** Queue a pot's mushrooms at room point (x, y, z): each sized to the pot. */
function shroomsAt(out, x, y, z, r, list) {
  for (const s of list) out.shrooms.push({ v: s.v, x: x + s.dx, y: y + s.y, z: z + s.dz, yaw: s.yaw, tilt: s.tilt, tiltA: s.tiltA, size: s.s * r * 0.8 })
}

function food(M, K, F, kind, spread, rng) {
  if (kind === 'berries') {
    const col = rng() < 0.5 ? rgb(0.97, 0.45, 0.3) : rgb(0.72, 0.3, 0.26)
    for (let k = 0; k < 7; k++) K.blob(M.linen, F, [K.j(spread), 0.018 + (k > 4 ? 0.02 : 0), K.j(spread)], 0.018, 0.018, 0.018, col, { segs: 8, rows: 5 })
  } else if (kind === 'bread') {
    K.blob(M.linen, F, [0, 0.03, 0], spread * 0.9, 0.035, spread * 0.6, rgb(0.08, 0.45, 0.38), { rough: 0.08 })
  } else if (kind === 'apples') {
    for (let k = 0; k < 4; k++) K.blob(M.linen, F, [K.j(spread * 0.8), 0.035 + (k === 3 ? 0.035 : 0), K.j(spread * 0.8)], 0.035, 0.032, 0.035, rng() < 0.5 ? rgb(0.02, 0.45, 0.36) : rgb(0.18, 0.4, 0.4))
  } else {
    for (let k = 0; k < 4; k++) {
      const c = [K.j(spread), 0.02, K.j(spread)]
      K.blob(M.linen, F, c, 0.018, 0.024, 0.018, rgb(0.09, 0.45, 0.33), { segs: 8, rows: 5 })
      K.blob(M.grain, F, [c[0], c[1] + 0.018, c[2]], 0.02, 0.01, 0.02, DARK, { segs: 8, rows: 4, flat: false })
    }
  }
}

/** A sack: a slumped lathe with a tied neck. */
function sackAt(M, K, F, r, h, tint) {
  K.lathe(M.linen, F, [[0, 0], [r * 0.85, 0], [r, h * 0.3], [r * 0.92, h * 0.72], [r * 0.45, h * 0.9], [r * 0.2, h * 0.95], [r * 0.3, h * 1.08], [r * 0.12, h * 1.12], [0, h * 1.1]], tint, { segs: 16, rough: 0.07, sz: 0.85, uvM: 0.25 })
  K.lathe(M.linen, F, [[r * 0.2, h * 0.9], [r * 0.26, h * 0.93], [r * 0.2, h * 0.96]], CORD, { segs: 10, flat: true })
}

/** A plain stool: a rounded seat on three splayed legs. */
function stoolAt(M, K, F, r, h, wood) {
  K.lathe(M.grain, F, [[0, h - 0.045], [r - 0.02, h - 0.045], [r + 0.006, h - 0.03], [r + 0.008, h - 0.012], [r - 0.014, h], [0, h + 0.004]], wood, { segs: 20, rough: 0.05 })
  for (let k = 0; k < 3; k++) {
    const q = (k / 3) * TAU + K.j(0.2)
    K.limb(M.grain, put(F, Math.cos(q) * r * 0.95, 0, Math.sin(q) * r * 0.95), put(F, Math.cos(q) * r * 0.55, h - 0.04, Math.sin(q) * r * 0.55), 0.022, 0.019, wood, { bow: 0.008 })
  }
}

/** A square block in `F` from lo to hi, one quad a face, uv by `uvOf(p, n)` in local metres. */
function slab(m, F, lo, hi, tint, uvOf) {
  for (let ax = 0; ax < 3; ax++) for (const s of [-1, 1]) {
    const a = (ax + 1) % 3, b = (ax + 2) % 3, n = [0, 0, 0]
    n[ax] = s
    m.quad(...[[0, 0], [1, 0], [1, 1], [0, 1]].map(([i, k]) => {
      const p = [0, 0, 0]
      p[ax] = s < 0 ? lo[ax] : hi[ax]; p[a] = i ? hi[a] : lo[a]; p[b] = k ? hi[b] : lo[b]
      return m.v(put(F, ...p), turn(F, ...n), uvOf(p, n), tint)
    }))
  }
}

// Bookcloth: dark reds, blues, browns, a bottle green, an ochre, as [h, s, l].
const BINDINGS = [[0.99, 0.5, 0.17], [0.02, 0.45, 0.2], [0.61, 0.4, 0.16], [0.63, 0.35, 0.12], [0.07, 0.45, 0.15], [0.08, 0.3, 0.2], [0.36, 0.3, 0.13], [0.1, 0.5, 0.2]]
const binding = (rng) => { const [h, s, l] = BINDINGS[Math.floor(rng() * BINDINGS.length)]; return rgb(h + (rng() - 0.5) * 0.02, s, l * (0.85 + rng() * 0.3)) }

/** A book in `F`, `t` thick along x, `h` tall along y, `d` deep along z with its spine to +z: cloth boards, a spine rounded across its width and straight along its length, and the page block set in between, striped along its head, tail and fore-edge. */
function bookAt(M, F, t, h, d, tint) {
  const ht = t / 2, hh = h / 2, hd = d / 2, b = Math.min(0.003, t * 0.15), bulge = Math.min(ht * 0.5, 0.01), zs = hd - bulge
  const cloth = (p, n) => (n[0] ? [p[2] / 0.1, p[1] / 0.1] : n[1] ? [p[0] / 0.1, p[2] / 0.1] : [p[0] / 0.1, p[1] / 0.1])
  for (const s of [-1, 1]) slab(M.linen, F, [s < 0 ? -ht : ht - b, -hh, -hd], [s < 0 ? -ht + b : ht, hh, zs], tint, cloth)
  slab(M.pages, F, [-ht + b, -hh + 0.004, -hd + 0.003], [ht - b, hh - 0.004, zs], [1, 1, 1], (p, n) => [p[0] / PAGES.m, n[1] ? p[2] / 0.1 : p[1] / 0.1])
  const spine = (q, y) => [Math.sin(q) * ht, y, zs + Math.cos(q) * bulge]
  M.linen.grid(8, 1, (i, j) => {
    const q = -Math.PI / 2 + (i / 8) * Math.PI
    return { p: put(F, ...spine(q, j ? hh : -hh)), n: norm(turn(F, Math.sin(q) / ht, 0, Math.cos(q) / bulge)), uv: [q * ht / 0.1, (j ? hh : -hh) / 0.1] }
  }, tint, 1)
  for (const y of [-hh, hh]) {
    const n = turn(F, 0, Math.sign(y), 0), mid = M.linen.v(put(F, 0, y, zs), n, FLAT, tint), rim = []
    for (let i = 0; i <= 8; i++) rim.push(M.linen.v(put(F, ...spine(-Math.PI / 2 + (i / 8) * Math.PI, y)), n, FLAT, tint))
    for (let i = 0; i < 8; i++) M.linen.tri(mid, rim[i], rim[i + 1])
  }
}

const ITEMS = {
  table(it, M, K, room) {
    const tint = tone(room.tints.table, -0.12 + K.j(0.03), 0.14), T = it.top, F = K.crook(frame(it.x, 0, it.z, it.spin), 0.015)
    K.lathe(M.grain, F, [[0, T - 0.065], [it.r - 0.04, T - 0.065], [it.r - 0.008, T - 0.05], [it.r + 0.004, T - 0.03], [it.r, T - 0.012], [it.r - 0.018, T], [0, T + 0.003]], tint, { segs: 32, rough: 0.035 })
    for (let k = 0; k < it.legs; k++) {
      const q = (k / it.legs) * TAU
      K.limb(M.grain, put(F, Math.cos(q) * it.r * 0.74, 0, Math.sin(q) * it.r * 0.74), put(F, Math.cos(q) * it.r * 0.5, T - 0.06, Math.sin(q) * it.r * 0.5), 0.05, 0.04, tint, { bow: 0.02, segs: 10 })
    }
  },

  chair(it, M, K, room, rng) {
    const tint = woodOf(room, K), F = K.crook(frame(it.x, 0, it.z, it.yaw + K.j(0.12)), 0.03), S = it.top, r = it.r
    if (it.style === 2) {
      K.lathe(M.grain, F, [[0, 0], [r + 0.025, 0], [r + 0.01, 0.03], [r * 0.93, 0.1], [r * 0.9, S - 0.03], [r * 0.93, S - 0.012], [r * 0.85, S], [0, S + 0.004]], tint, { segs: 20, rough: 0.07 })
    } else {
      if (it.style === 0) K.box(M.grain, F, 0, S - 0.028, 0, r, 0.028, r, tint, { round: 0.45, rows: 6, crook: 0.012 })
      else K.lathe(M.grain, F, [[0, S - 0.05], [r - 0.02, S - 0.05], [r + 0.008, S - 0.035], [r + 0.01, S - 0.015], [r - 0.012, S], [0, S + 0.004]], tint, { segs: 20, rough: 0.05 })
      const n = it.style === 0 ? 4 : 3, feet = []
      for (let k = 0; k < n; k++) {
        const q = (k / n) * TAU + Math.PI / 4, foot = put(F, Math.cos(q) * r * 1.0, 0, Math.sin(q) * r * 1.0)
        feet.push(put(F, Math.cos(q) * r * 0.86, 0.07, Math.sin(q) * r * 0.86))
        K.limb(M.grain, foot, put(F, Math.cos(q) * r * 0.62, S - 0.045, Math.sin(q) * r * 0.62), 0.027, 0.023, tint, { bow: 0.01 })
      }
      if (it.style === 0) for (let k = 0; k < n; k += 2) K.limb(M.grain, feet[k], feet[(k + 1) % n], 0.012, 0.012, tint, { bow: 0.006, segs: 6 })
    }
    if (it.back > 0) {
      const zb = -(r - 0.035), B = it.back
      for (const x of [-r * 0.72, r * 0.72]) K.tube(M.grain, [put(F, x, S - 0.03, zb), put(F, x * 1.02, (S + B) / 2, zb - 0.025), put(F, x * 1.05, B, zb - 0.06)], [0.024, 0.021, 0.02], tint)
      const rail = (y, rr, cup) => K.tube(M.grain, [-1, -0.5, 0, 0.5, 1].map((u) => put(F, u * r * 0.8, y + 0.018 * (1 - u * u), zb - 0.06 * ((y - S) / (B - S)) - cup * (1 - u * u))), [rr, rr * 1.1, rr * 1.15, rr * 1.1, rr], tint, { segs: 10 })
      rail(B - 0.035, 0.028, 0.025)
      rail((S + B) / 2 + 0.02, 0.016, 0.018)
    }
    if (it.cushion) K.blob(M.linen, F, [0, S + 0.016, 0.01], r * 0.86, 0.022, r * 0.84, tone(room.tints.cloth, -0.06 + K.j(0.03), -0.1), { segs: 16, rows: 6, flat: false, rough: 0.05 })
    void rng
  },

  plate(it, M, K, room, rng) {
    const F = frame(it.x, it.y, it.z)
    K.lathe(M.linen, F, [[0, 0], [0.085, 0], [0.108, 0.016], [0.106, 0.021], [0.08, 0.009], [0, 0.009]], CLAY(rng()), { segs: 18, flat: true, rough: 0.02 })
    if (it.food) food(M, K, frame(it.x, it.y + 0.009, it.z), it.food, 0.04, rng)
  },

  cup(it, M, K, room, rng) {
    const F = K.crook(frame(it.x, it.y, it.z, rng() * TAU), 0.04)
    K.lathe(M.linen, F, [[0, 0], [0.03, 0], [0.035, 0.035], [0.037, 0.065], [0.032, 0.066], [0.029, 0.012], [0, 0.012]], CLAY(rng()), { segs: 14, flat: true, rough: 0.03 })
    K.tube(M.linen, [put(F, 0.034, 0.052, 0), put(F, 0.055, 0.045, 0), put(F, 0.056, 0.025, 0), put(F, 0.034, 0.018, 0)], [0.006, 0.007, 0.007, 0.006], CLAY(rng()), { segs: 6, flat: true, caps: false })
  },

  vase(it, M, K, room, rng) {
    const F = K.crook(frame(it.x, it.y, it.z), 0.04)
    K.lathe(M.linen, F, [[0, 0], [0.05, 0], [0.066, 0.06], [0.034, 0.12], [0.03, 0.13], [0.042, 0.15], [0.032, 0.152], [0, 0.12]], CLAY(rng()), { segs: 16, flat: true, rough: 0.03 })
    for (let k = 0; k < it.flowers; k++) {
      const q = (k / it.flowers) * TAU, lean = 0.05 + rng() * 0.05
      const head = put(F, Math.cos(q) * lean, 0.26 + rng() * 0.08, Math.sin(q) * lean)
      K.rod(M.linen, put(F, 0, 0.12, 0), head, 0.004, 0.004, GREEN(), { segs: 4, flat: true })
      const col = rgb(it.hue + k * 0.07, 0.35, 0.52)
      for (let p = 0; p < 5; p++) {
        const pq = (p / 5) * TAU
        K.leaf(M.linen, head, [Math.cos(pq), 0.3, Math.sin(pq)], 0.035, 0.015, [0, 1, 0], col)
      }
      K.blob(M.linen, frame(...head), [0, 0.005, 0], 0.01, 0.01, 0.01, rgb(0.13, 0.5, 0.5), { segs: 6, rows: 4 })
    }
  },

  bowl(it, M, K, room, rng) {
    K.lathe(M.grain, K.crook(frame(it.x, it.y, it.z), 0.03), [[0, 0], [0.07, 0], [0.12, 0.045], [0.132, 0.062], [0.122, 0.066], [0.06, 0.014], [0, 0.014]], woodOf(room, K), { segs: 20, rough: 0.03 })
    food(M, K, frame(it.x, it.y + 0.014, it.z), it.food, 0.05, rng)
  },

  candle(it, M, K) { candleOn(M, K, it.x, it.y, it.z, it.h) },

  counter(it, M, K, room) {
    const wood = woodOf(room, K), topTint = woodOf(room, K, 'table', -0.06), d = FILLET + it.depth, T = it.top
    wallRun(M.grain, room, it.a0, it.a1, (f) => [[(d - 0.07) * f, 0], [(d - 0.065) * f, 0.06], [(d - 0.02) * f, 0.085], [(d - 0.012) * f, T - 0.08], [(d - 0.03) * f, T - 0.05], [-0.05, T - 0.05]], wood)
    wallRun(M.grain, room, it.a0 - 0.02 / room.R, it.a1 + 0.02 / room.R, (f) => [[(d - 0.02) * f, T - 0.056], [(d + 0.025) * f, T - 0.05], [(d + 0.04) * f, T - 0.032], [(d + 0.034) * f, T - 0.008], [(d + 0.012) * f, T], [-0.05, T]], topTint)
    // Cupboard doors along its front, each with a knob.
    const rm = rAt(room.rs, (it.a0 + it.a1) / 2), n = Math.max(2, Math.round(((it.a1 - it.a0) * rm) / 0.34))
    for (let k = 0; k < n; k++) {
      const a = it.a0 + ((it.a1 - it.a0) * (k + 0.5)) / n, p = wallAt(room, a, d - 0.012, (T - 0.05 + 0.1) / 2)
      const F = K.crook(frame(...p, inward(a)), 0.02), hw = ((it.a1 - it.a0) * rm) / n / 2 - 0.025
      K.box(M.grain, F, 0, 0, 0, hw, (T - 0.2) / 2, 0.012, tone(room.tints.wood, 0 + K.j(0.04), 0.08), { round: 0.35, segs: 8, rows: 4, crook: 0.006 })
      K.blob(M.grain, F, [(k % 2 ? -1 : 1) * (hw - 0.04), 0.03, 0.02], 0.014, 0.014, 0.012, DARK, { segs: 8, rows: 5, flat: false })
    }
    // A shelf of plates on the wall above.
    const shelfY = Math.min(1.25, room.hW - 0.3)
    if (!room.loft || loftDepthAt(room.loft, (it.a0 + it.a1) / 2) < 0.4) {
      const m0 = it.a0 + (it.a1 - it.a0) * 0.2, m1 = it.a1 - (it.a1 - it.a0) * 0.2
      wallRun(M.grain, room, m0, m1, (f) => [[0.2 * f, shelfY - 0.035], [0.225 * f, shelfY - 0.02], [0.215 * f, shelfY], [-0.05, shelfY]], wood)
      for (const a of [m0 + 0.06 / rm, m1 - 0.06 / rm]) K.tube(M.grain, [wallAt(room, a, 0, shelfY - 0.2), wallAt(room, a, 0.06, shelfY - 0.12), wallAt(room, a, 0.16, shelfY - 0.04)], [0.018, 0.016, 0.014], wood)
      for (let k = 0; k < 3; k++) {
        const a = m0 + ((m1 - m0) * (k + 0.5)) / 3, p = wallAt(room, a, 0.1, shelfY)
        K.lathe(M.linen, K.crook(frame(...p), 0.05), [[0, 0], [0.05, 0], [0.07, 0.055], [0.064, 0.062], [0.045, 0.012], [0, 0.012]], CLAY(k * 0.3), { segs: 14, flat: true })
      }
    }
  },

  basin(it, M, K, room, rng, out) {
    const F = K.crook(frame(it.x, it.y, it.z), 0.02)
    K.lathe(M.linen, F, [[0, 0], [it.r * 0.7, 0], [it.r * 0.95, 0.06], [it.r, 0.09], [it.r - 0.015, 0.096], [it.r * 0.65, 0.02], [0, 0.02]], CLAY(0.2), { segs: 20, flat: true, rough: 0.02 })
    out.water.push({ x: it.x, y: it.y + 0.07, z: it.z, r: it.r * 0.9 })
  },

  jar(it, M, K) {
    const h = it.h, F = K.crook(frame(it.x, it.y, it.z, it.yaw), 0.04)
    K.lathe(M.linen, F, [[0, 0], [0.045, 0], [0.055, h * 0.5], [0.04, h * 0.85], [0.032, h * 0.88], [0.032, h], [0, h]], MUTED(it.hue), { segs: 14, flat: true, rough: 0.03 })
    K.blob(M.linen, F, [0, h, 0], 0.037, 0.016, 0.037, CREAM, { segs: 12, rows: 5, rough: 0.1 })
    K.lathe(M.linen, F, [[0.033, h * 0.9], [0.038, h * 0.93], [0.033, h * 0.96]], CORD, { segs: 12, flat: true })
  },

  crock(it, M, K) {
    const h = it.h * 0.8, F = K.crook(frame(it.x, it.y, it.z, it.yaw), 0.03)
    K.lathe(M.pot, F, [[0, 0], [0.06, 0], [0.072, h * 0.6], [0.058, h * 0.95], [0.062, h], [0.05, h], [0, h * 0.97]], rgb(0.08, 0.15, 0.8), { segs: 16, uvM: 0.12, rough: 0.02 })
  },

  loaf(it, M, K) { K.blob(M.linen, frame(it.x, it.y, it.z, it.yaw), [0, 0.04, 0], 0.09, 0.05, 0.06, rgb(0.08, 0.45, 0.38), { rough: 0.06 }) },

  cheese(it, M, K) {
    const F = frame(it.x, it.y, it.z, it.yaw)
    K.lathe(M.linen, F, [[0, 0], [0.07, 0], [0.076, 0.012], [0.076, 0.048], [0.07, 0.06], [0, 0.06]], rgb(0.12, 0.45, 0.55), { segs: 16, flat: true })
  },

  herbs(it, M, K, room, rng) {
    const p0 = wallAt(room, it.a0, it.inset, it.y), p1 = wallAt(room, it.a1, it.inset, it.y)
    K.limb(M.grain, p0, p1, 0.015, 0.015, woodOf(room, K), { bow: 0.01 })
    for (const [a, p] of [[it.a0, p0], [it.a1, p1]]) K.rod(M.grain, wallAt(room, a, -0.02, it.y), p, 0.01, 0.01, DARK)
    for (let k = 0; k < it.n; k++) {
      const t = (k + 0.5) / it.n, top = [p0[0] + (p1[0] - p0[0]) * t, it.y, p0[2] + (p1[2] - p0[2]) * t]
      const len = 0.18 + rng() * 0.1, col = rng() < 0.3 ? rgb(0.12, 0.28, 0.4) : GREEN(rng())
      K.rod(M.linen, top, [top[0], top[1] - 0.05, top[2]], 0.004, 0.004, CORD, { segs: 4, flat: true })
      for (let s = 0; s < 7; s++) {
        const q = rng() * TAU, spread = 0.2 + rng() * 0.3
        K.leaf(M.linen, [top[0], top[1] - 0.04, top[2]], norm([Math.cos(q) * spread, -1, Math.sin(q) * spread]), len, 0.02, [Math.sin(q), 0, -Math.cos(q)], col)
      }
    }
  },

  sack(it, M, K) { sackAt(M, K, K.crook(frame(it.x, it.y, it.z, it.yaw), 0.12), it.r, it.h, BURLAP(it.hue)) },

  sacks(it, M, K, room, rng) {
    const n = Math.min(5, Math.max(3, it.n)), rs = it.r * 0.5
    for (let k = 0; k < n; k++) {
      const q = it.yaw + (k / n) * TAU, d = k === 0 ? 0 : it.r - rs * 0.85
      sackAt(M, K, K.crook(frame(it.x + Math.cos(q) * d, 0, it.z + Math.sin(q) * d, rng() * TAU), 0.18), rs * (0.9 + rng() * 0.2), 0.3 + rng() * 0.12, BURLAP(rng()))
    }
  },

  barrel(it, M, K, room) {
    const r = it.r, h = it.h, F = K.crook(frame(it.x, it.y, it.z, it.yaw), 0.02), wood = woodOf(room, K)
    K.lathe(M.grain, F, [[0, 0.01], [r * 0.86, 0], [r * 0.9, 0.02], [r, h * 0.5], [r * 0.9, h - 0.02], [r * 0.86, h], [r * 0.8, h - 0.012], [0, h - 0.015]], wood, { segs: 22, rough: 0.015, lobes: [22, 0.012] })
    for (const y of [0.14, 0.86]) {
      const ry = r * (1 - 0.5 * (0.5 - y) ** 2 * 0.56 * 2) + 0.004
      K.lathe(M.grain, frame(it.x, it.y + h * y - 0.016, it.z), [[ry - 0.004, 0], [ry + 0.004, 0.004], [ry + 0.005, 0.028], [ry - 0.004, 0.032]], IRON, { segs: 22, flat: true })
    }
  },

  crate(it, M, K, room) {
    let y = it.y
    for (let L = 0; L < it.stack; L++) {
      const s = it.s * (L ? 0.88 : 1), hs = s / 2, F = K.crook(frame(it.x, y, it.z, it.yaw + (L ? K.j(0.3) : 0)), 0.02), wood = woodOf(room, K, 'wood', 0)
      const o = { round: 0.3, segs: 8, rows: 4, crook: 0.004 }
      K.box(M.grain, F, 0, hs, 0, hs - 0.02, hs - 0.012, hs - 0.02, tone(room.tints.wood, -0.22, 0.08), o)
      for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) K.box(M.grain, F, x * (hs - 0.022), hs, z * (hs - 0.022), 0.024, hs, 0.024, wood, o)
      for (let k = 0; k < 3; k++) {
        const sy = 0.05 + ((s - 0.1) * k) / 2
        for (const side of [-1, 1]) {
          K.box(M.grain, F, 0, sy, side * (hs - 0.008), hs - 0.03, 0.034, 0.011, wood, o)
          K.box(M.grain, F, side * (hs - 0.008), sy, 0, 0.011, 0.034, hs - 0.03, wood, o)
        }
      }
      for (let k = -1; k <= 1; k++) K.box(M.grain, F, k * hs * 0.64, s - 0.012, 0, hs * 0.3, 0.012, hs - 0.01, wood, o)
      y += s
    }
  },

  armchair(it, M, K, room) {
    const F = K.crook(frame(it.x, 0, it.z, it.yaw), 0.02), wood = woodOf(room, K), cloth = tone(room.tints.cloth, -0.06, -0.1)
    K.box(M.grain, F, 0, 0.1, 0, 0.29, 0.07, 0.25, wood, { round: 0.4 })
    const Fb = tip(F, 'ax', -0.18)
    K.box(M.grain, Fb, 0, 0.38, -0.2, 0.29, 0.22, 0.065, wood, { round: 0.45, crook: 0.015 })
    for (const x of [-0.26, 0.26]) K.box(M.grain, F, x, 0.22, -0.02, 0.055, 0.1, 0.24, wood, { round: 0.5, rows: 6, crook: 0.012 })
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) K.lathe(M.grain, frame(...put(F, x * 0.24, 0, z * 0.2)), [[0, 0], [0.03, 0], [0.036, 0.02], [0.03, 0.035], [0, 0.036]], wood, { segs: 10 })
    K.blob(M.linen, F, [0, 0.2, 0.03], 0.22, 0.05, 0.21, cloth, { segs: 18, rows: 8, flat: false, rough: 0.04 })
    K.blob(M.linen, Fb, [0, 0.4, -0.12], 0.21, 0.16, 0.05, cloth, { segs: 18, rows: 8, flat: false, rough: 0.04 })
    for (const x of [-0.26, 0.26]) K.blob(M.linen, F, [x, 0.32, 0.0], 0.06, 0.035, 0.2, cloth, { segs: 12, rows: 6, flat: false })
  },

  sidetable(it, M, K, room) {
    const F = K.crook(frame(it.x, 0, it.z), 0.02), wood = woodOf(room, K, 'table', -0.06), T = it.top
    K.lathe(M.grain, F, [[0, T - 0.04], [it.r - 0.02, T - 0.04], [it.r + 0.004, T - 0.025], [it.r, T - 0.008], [it.r - 0.015, T], [0, T + 0.002]], wood, { segs: 22, rough: 0.04 })
    for (let k = 0; k < 3; k++) {
      const q = (k / 3) * TAU
      K.limb(M.grain, put(F, Math.cos(q) * it.r * 0.85, 0, Math.sin(q) * it.r * 0.85), put(F, Math.cos(q) * it.r * 0.5, T - 0.04, Math.sin(q) * it.r * 0.5), 0.021, 0.018, wood, { bow: 0.01 })
    }
  },

  books(it, M, K, room, rng) {
    let y = 0
    for (let k = 0; k < it.n; k++) {
      const hy = 0.012 + rng() * 0.01
      // Lying flat: the book's thickness turned up.
      bookAt(M, tip(frame(it.x, it.y + y + hy, it.z, it.yaw + K.j(0.4)), 'az', Math.PI / 2), hy * 2, 0.11 + rng() * 0.04, 0.15, binding(rng))
      y += hy * 2
    }
  },

  rug(it, M, K) {
    const segs = 40, F = frame(it.x, 0.006, it.z), cols = [rgb(it.hue, 0.14, 0.28), rgb(it.hue + 0.05, 0.12, 0.22), rgb(it.hue, 0.14, 0.28)]
    const wob = Array.from({ length: segs }, () => 1 + K.j(0.05))
    const at = (i, t) => { const q = (i / segs) * TAU, r = it.r * t * wob[i % segs]; return put(F, Math.cos(q) * r, 0, Math.sin(q) * r) }
    const c = M.linen.v(put(F, 0, 0, 0), [0, 1, 0], [0.5, 0.5], cols[0])
    let prev = null
    for (const [ri, t] of [[0, 0.55], [1, 0.8], [2, 1]]) {
      const ring = []
      for (let i = 0; i <= segs; i++) { const p = at(i, t); ring.push(M.linen.v(p, [0, 1, 0], [(p[0] - it.x) * 2, (p[2] - it.z) * 2], cols[ri])) }
      for (let i = 0; i < segs; i++) {
        if (prev) M.linen.quad(prev[i], prev[i + 1], ring[i + 1], ring[i])
        else M.linen.tri(c, ring[i], ring[i + 1])
      }
      prev = ring
    }
  },

  bed(it, M, K, room) {
    const F = K.crook(frame(it.x, it.y, it.z, it.yaw), 0.015), wood = woodOf(room, K), hl = it.len / 2, hw = it.wid / 2
    K.box(M.grain, F, 0, 0.075, 0, hw, 0.065, hl, wood, { round: 0.35 })
    K.box(M.grain, F, 0, 0.27, hl - 0.04, hw + 0.03, 0.27, 0.045, wood, { round: 0.45, crook: 0.02 })
    K.tube(M.grain, [-1, -0.5, 0, 0.5, 1].map((u) => put(F, u * (hw + 0.02), 0.54 + 0.07 * (1 - u * u), hl - 0.04)), [0.05, 0.055, 0.06, 0.055, 0.05], wood, { segs: 12 })
    K.box(M.grain, F, 0, 0.15, -hl + 0.03, hw + 0.02, 0.15, 0.035, wood, { round: 0.5, crook: 0.015 })
    K.box(M.linen, F, 0, 0.165, 0, hw - 0.02, 0.05, hl - 0.04, CREAM, { round: 0.6, segs: 12, rows: 6, flat: true })
    K.blob(M.linen, F, [0, 0.235, hl - 0.18], hw * 0.72, 0.055, 0.1, CREAM, { flat: false, segs: 16, rows: 8, rough: 0.05 })
    K.box(M.linen, F, 0, 0.19, -hl * 0.22, hw + 0.03, 0.04, hl * 0.74, tone(room.tints.cloth2, -0.04), { round: 0.6, segs: 16, rows: 6, crook: 0.02 })
  },

  plush(it, M, K) {
    const s = it.size, col = MUTED(it.hue), o = { flat: false, segs: 14, rows: 8 }
    // Tossed down any which way: sat up, slumped, on its back, face-down or on either side. The
    // lying poses turn the frame so its y runs along the bed, lifted by its half-thickness there.
    const U = [0, 1, 0], S = frame(0, 0, 0, it.yaw), neg = (a) => a.map((x) => -x), pose = Math.floor((K.j(1) + 1) * 3) % 6
    const [ax, ay, az] = [[S.ax, U, S.az], [S.ax, U, S.az], [S.ax, neg(S.az), U], [S.ax, S.az, neg(U)], [U, S.az, S.ax], [neg(U), S.az, neg(S.ax)]][pose]
    const half = it.shape === 2 ? 0.7 : pose >= 4 ? 0.5 : 0.42
    let F = { x: it.x, y: pose < 2 ? it.y : it.y - 0.04 + s * half * 0.9, z: it.z, ax, ay, az }
    F = pose === 1 ? tip(tip(F, 'ax', -0.5), 'az', K.j(0.4)) : tip(F, 'ax', K.j(0.15))
    if (pose >= 2) Object.assign(F, Object.fromEntries(['x', 'y', 'z'].map((k, i) => [k, put(F, 0, -s * 0.6, 0)[i]])))
    if (it.shape === 2) {
      K.blob(M.linen, F, [0, s * 0.4, 0], s * 0.35, s * 0.45, s * 0.35, CREAM, o)
      K.blob(M.linen, F, [0, s * 0.95, 0], s * 0.7, s * 0.35, s * 0.7, col, o)
      return
    }
    K.blob(M.linen, F, [0, s * 0.45, 0], s * 0.5, s * 0.5, s * 0.42, col, o)
    const n = put(F, 0, s * 0.85, 0), H = tip(tip({ ...F, x: n[0], y: n[1], z: n[2] }, 'az', K.j(0.45)), 'ax', K.j(0.3))
    K.blob(M.linen, H, [0, s * 0.3, 0.02], s * 0.38, s * 0.35, s * 0.35, col, o)
    const ear = it.shape === 0 ? [s * 0.13, s * 0.12] : [s * 0.08, s * 0.35]
    for (const x of [-1, 1]) K.blob(M.linen, H, [x * s * 0.22, s * 0.55 + ear[1] * 0.6, 0], ear[0], ear[1], ear[0] * 0.6, col, o)
    for (const x of [-1, 1]) K.blob(M.linen, H, [x * s * 0.13, s * 0.35, s * 0.33], s * 0.05, s * 0.05, s * 0.03, DARK, { segs: 8, rows: 5 })
  },

  bookcase(it, M, K, room) {
    const F = K.crook(frame(it.x, it.y, it.z, it.yaw), 0.015), wood = woodOf(room, K), hw = it.w / 2, hd = it.d / 2
    const rng = mulberry32(it.seed), o = { round: 0.3, segs: 8, rows: 6, crook: 0.008 }
    for (const x of [-hw, hw]) K.box(M.grain, F, x, it.h / 2, 0, 0.028, it.h / 2, hd, wood, o)
    K.box(M.grain, F, 0, it.h / 2, -hd + 0.015, hw, it.h / 2, 0.015, tone(room.tints.wood, -0.16, 0.08), o)
    for (let k = 0; k <= it.shelves; k++) {
      const y = 0.03 + ((it.h - 0.06) * k) / it.shelves
      K.box(M.grain, F, 0, y, 0, hw + 0.025, 0.022, hd + 0.012, wood, o)
      if (k === it.shelves) break
      const room2 = (it.h - 0.06) / it.shelves - 0.06
      let x = -hw + 0.03
      while (x < hw - 0.05) {
        const t = 0.02 + rng() * 0.025, bh = room2 * (0.6 + rng() * 0.35)
        if (rng() < 0.12) { x += 0.06; continue }
        bookAt(M, frame(...put(F, x + t / 2, y + 0.02 + bh / 2, 0.01), it.yaw + (rng() - 0.5) * 0.1), t - 0.004, bh, hd * 1.6, binding(rng))
        x += t
      }
    }
  },

  divider(it, M, K, room, rng) {
    const wood = woodOf(room, K), p0 = [it.x0, 0, it.z0], p1 = [it.x1, 0, it.z1], h = it.h
    const lerp = (t, y) => [p0[0] + (p1[0] - p0[0]) * t, y, p0[2] + (p1[2] - p0[2]) * t]
    const along2 = norm(sub(p1, p0)), face = [-along2[2], 0, along2[0]]
    if (it.style === 'sticks') {
      const n = Math.round(Math.hypot(...sub(p1, p0)) / 0.045)
      for (let k = 0; k <= n; k++) {
        const t = k / n
        K.limb(M.grain, lerp(t, 0), lerp(t + K.j(0.01), h * (0.92 + rng() * 0.12)), 0.02, 0.014, tone(room.tints.wood, -0.06 + K.j(0.08), 0.08), { bow: 0.015, segs: 6 })
      }
      for (const y of [0.3, h * 0.75]) K.limb(M.linen, add(lerp(0, y), face, 0.025), add(lerp(1, y), face, 0.025), 0.01, 0.01, CORD, { bow: 0.01, segs: 6 })
      return
    }
    K.limb(M.grain, lerp(0, 0), lerp(0, h), 0.032, 0.028, wood, { bow: 0.015 })
    K.limb(M.grain, lerp(1, 0), lerp(1, h), 0.032, 0.028, wood, { bow: 0.015 })
    K.limb(M.grain, lerp(0, h - 0.02), lerp(1, h - 0.02), 0.024, 0.024, wood, { bow: 0.012 })
    if (it.style === 'curtain') {
      const cols = 24, rows = 8, cloth = rgb(it.hue, 0.25, 0.4)
      for (const side of [1, -1]) {
        M.linen.grid(cols, rows, (i, j) => {
          const t = 0.03 + (0.94 * i) / cols, y = 0.08 + ((h - 0.12) * (rows - j)) / rows, fold = 0.03 * Math.sin(i * 1.6) * side
          const b = lerp(t, y)
          return { p: [b[0] + face[0] * fold, y, b[2] + face[2] * fold], uv: [t * 3, y * 3] }
        }, cloth, side)
      }
      return
    }
    // Lattice: crossed slats, each leaf on a stalk sprouting from one of them.
    const L = Math.hypot(...sub(p1, p0)), n = Math.max(2, Math.round(L / 0.25)), slats = []
    for (let k = 0; k <= n; k++) {
      const t0 = k / n
      slats.push([lerp(Math.max(0, t0 - 0.5), 0.05), lerp(t0, h - 0.05)], [lerp(Math.min(1, t0 + 0.5), 0.05), lerp(t0, h - 0.05)])
    }
    for (const [a, b] of slats) K.limb(M.grain, a, b, 0.013, 0.013, wood, { bow: 0.01, segs: 6 })
    for (let k = 0; k < n * 8; k++) {
      const [a, b] = slats[Math.floor(rng() * slats.length)], base = lerp3(a, b, 0.1 + rng() * 0.8), side = rng() < 0.5 ? 1 : -1
      const out = norm(add(add(face.map((x) => x * side), along2, K.j(0.8)), [0, 1, 0], K.j(0.5))), stalk = add(base, out, 0.035)
      K.limb(M.grain, base, stalk, 0.004, 0.0025, wood, { bow: 0.004, segs: 4 })
      K.leaf(M.linen, stalk, norm(add(out, [0, -0.6, 0], 1)), 0.06 + rng() * 0.03, 0.022, face, GREEN(0.35 + rng() * 0.3))
    }
  },

  mushpot(it, M, K, room, rng, out) {
    potOn(M, K, K.crook(frame(it.x, it.y, it.z, it.yaw), 0.03), it.r, it.h, it.shrooms[0].y)
    shroomsAt(out, it.x, it.y, it.z, it.r, it.shrooms)
  },

  mushhang(it, M, K, room, rng, out) {
    const soil = it.shrooms[0].y, F = frame(it.x, it.y, it.z, K.j(Math.PI))
    potOn(M, K, F, it.r, it.h, soil)
    // An iron arm from the wall to over the pot, and three cords down to its rim.
    const knot = [it.x, it.hy - 0.03, it.z]
    K.tube(M.grain, [[it.hx, it.hy, it.hz], lerp3([it.hx, it.hy, it.hz], knot, 0.5).map((v, k) => (k === 1 ? v + 0.03 : v)), [it.x, it.hy + 0.01, it.z], knot], [0.013, 0.012, 0.011, 0.01], IRON, { segs: 8 })
    K.blob(M.grain, frame(it.hx, it.hy, it.hz, inward(Math.atan2(it.hz, it.hx))), [0, 0, 0], 0.04, 0.05, 0.012, IRON, { segs: 12, rows: 6, flat: false })
    for (let k = 0; k < 3; k++) {
      const q = (k / 3) * TAU
      K.rod(M.linen, knot, put(F, Math.cos(q) * it.r, it.h, Math.sin(q) * it.r), 0.004, 0.004, CORD, { segs: 4, flat: true })
    }
    shroomsAt(out, it.x, it.y, it.z, it.r, it.shrooms)
  },

  broom(it, M, K, room) {
    const F = frame(it.x, 0, it.z, it.yaw)
    const base = put(F, 0, 0.02, 0.06), top = put(F, 0, it.h, -it.r * 1.5)
    K.limb(M.grain, base, top, 0.015, 0.014, woodOf(room, K), { bow: 0.015, segs: 6 })
    K.lathe(M.linen, along(put(F, 0, 0, 0.04), sub(top, base)), [[0, 0], [0.075, 0], [0.06, 0.08], [0.03, 0.2], [0.018, 0.22], [0, 0.22]], rgb(0.12, 0.35, 0.5), { segs: 14, rough: 0.12, sz: 0.5, flat: true })
    K.lathe(M.linen, along(put(F, 0, 0.19, 0.035), sub(top, base)), [[0.02, 0], [0.024, 0.01], [0.02, 0.02]], CORD, { segs: 10, flat: true })
  },

  bucket(it, M, K, room) {
    const F = K.crook(frame(it.x, 0, it.z, it.yaw), 0.03), h = it.h, r = it.r
    K.lathe(M.grain, F, [[0, 0.02], [r * 0.85, 0], [r, h], [r - 0.015, h], [r * 0.82, 0.03], [0, 0.03]], woodOf(room, K), { segs: 18, lobes: [14, 0.02] })
    for (const y of [0.2, 0.8]) K.lathe(M.grain, put(F, 0, 0, 0) && frame(...put(F, 0, h * y - 0.012, 0)), [[r * (0.85 + 0.15 * y) - 0.002, 0], [r * (0.85 + 0.15 * y) + 0.005, 0.006], [r * (0.85 + 0.15 * y) + 0.005, 0.02], [r * (0.85 + 0.15 * y) - 0.002, 0.024]], IRON, { segs: 18, flat: true })
    const pts = Array.from({ length: 7 }, (_, k) => { const q = (k / 6) * Math.PI; return put(F, Math.cos(q) * r, h + Math.sin(q) * r * 0.8, 0) })
    K.tube(M.grain, pts, pts.map(() => 0.006), IRON, { segs: 6, flat: true })
  },

  basket(it, M, K, room, rng) {
    const F = K.crook(frame(it.x, it.y ?? 0, it.z, it.yaw), 0.04), h = it.h, r = it.r
    K.lathe(M.grain, F, [[0, 0.01], [r * 0.8, 0], [r, h], [r - 0.012, h + 0.008], [r - 0.02, h], [r * 0.78, 0.02], [0, 0.02]], WICKER, { segs: 20, lobes: [20, 0.04], uvM: 0.12 })
    for (let k = 0; k < 3; k++) K.blob(M.linen, F, [K.j(r * 0.5), h - 0.02, K.j(r * 0.5)], 0.05, 0.045, 0.05, rgb(it.hue + k * 0.3, 0.3, 0.42), { flat: false })
    if (rng() < 0.5) K.tube(M.grain, [-1, -0.5, 0, 0.5, 1].map((u) => put(F, u * r * 0.95, h + (1 - u * u) * r * 0.9, 0)), [0.008, 0.009, 0.009, 0.009, 0.008], WICKER, { segs: 6 })
  },

  tool(it, M, K, room) {
    const foot = [it.x0, 0, it.z0], top = [it.x1, it.y1, it.z1], d = norm(sub(top, foot)), wood = woodOf(room, K, 'wood', 0.02)
    // The head rests on the floor; the handle leans up to the wall.
    const head = it.tool === 'spade' ? 0.26 : it.tool === 'fork' ? 0.24 : 0.1
    const F = along(foot, d, it.twist)
    K.limb(M.grain, add(foot, d, head - 0.02), top, 0.017, 0.015, wood, { bow: 0.012 })
    if (it.tool === 'spade') {
      K.box(M.grain, F, 0, 0.12, 0, 0.085, 0.12, 0.011, IRON, { round: 0.35, segs: 12, rows: 6, flat: true })
      K.lathe(M.grain, along(add(foot, d, 0.22), d, it.twist), [[0.012, 0], [0.024, 0.02], [0.02, 0.06], [0.014, 0.07]], IRON, { segs: 10, flat: true })
      K.tube(M.grain, [-1, -0.5, 0, 0.5, 1].map((u) => add(put(F, u * 0.06, 0, 0), d, Math.hypot(...sub(top, foot)) + 0.03 + 0.05 * (1 - u * u))), [0.011, 0.012, 0.012, 0.012, 0.011], wood, { segs: 6 })
    } else if (it.tool === 'rake') {
      K.box(M.grain, F, 0, 0.08, 0, 0.16, 0.014, 0.016, IRON, { round: 0.4, segs: 12, rows: 6, flat: true })
      for (let k = 0; k < 8; k++) K.rod(M.grain, put(F, -0.14 + k * 0.04, 0.075, 0.008), put(F, -0.14 + k * 0.04, 0.005, 0.03), 0.0045, 0.003, IRON, { segs: 4, flat: true })
    } else if (it.tool === 'hoe') {
      K.box(M.grain, F, 0, 0.05, 0.05, 0.075, 0.045, 0.008, IRON, { round: 0.35, segs: 12, rows: 6, flat: true })
      K.limb(M.grain, put(F, 0, 0.09, 0.008), put(F, 0, 0.07, 0.05), 0.008, 0.007, IRON, { bow: 0.004, segs: 5 })
    } else {
      K.box(M.grain, F, 0, 0.2, 0, 0.07, 0.014, 0.014, IRON, { round: 0.45, segs: 12, rows: 6, flat: true })
      for (let k = 0; k < 4; k++) K.tube(M.grain, [put(F, -0.06 + k * 0.04, 0.2, 0), put(F, -0.06 + k * 0.04, 0.1, 0.008), put(F, -0.06 + k * 0.04, 0.005, 0.02)], [0.006, 0.005, 0.003], IRON, { segs: 5, flat: true })
    }
  },

  wcan(it, M, K) {
    const F = K.crook(frame(it.x, it.y, it.z, it.yaw), 0.03), r = it.r, h = it.h
    K.lathe(M.linen, F, [[0, 0], [r * 0.95, 0], [r, 0.02], [r, h * 0.8], [r * 0.9, h * 0.95], [r * 0.5, h], [r * 0.45, h + 0.01], [0, h]], TIN, { segs: 20, flat: true, rough: 0.015 })
    const spout = [put(F, 0, h * 0.25, r * 0.85), put(F, 0, h * 0.6, r * 1.5), put(F, 0, h * 0.95, r * 2.1)]
    K.tube(M.linen, spout, [0.018, 0.013, 0.012], TIN, { segs: 8, flat: true, caps: false })
    K.lathe(M.linen, along(spout[2], sub(spout[2], spout[1])), [[0.012, -0.005], [0.03, 0.02], [0.032, 0.026], [0, 0.028]], TIN, { segs: 12, flat: true })
    K.tube(M.linen, [put(F, 0, h * 0.95, -r * 0.4), put(F, 0, h * 1.3, -r * 0.3), put(F, 0, h * 1.25, -r * 1.05), put(F, 0, h * 0.55, -r * 1.02)], [0.01, 0.011, 0.011, 0.01], TIN, { segs: 8, flat: true })
  },

  dresser(it, M, K, room) {
    const F = K.crook(frame(it.x, it.y, it.z, it.yaw), 0.015), wood = woodOf(room, K), hw = it.w / 2, hd = it.d / 2, h = it.h
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) K.lathe(M.grain, frame(...put(F, x * (hw - 0.05), 0, z * (hd - 0.05))), [[0, 0], [0.03, 0], [0.038, 0.025], [0.03, 0.045], [0, 0.046]], wood, { segs: 10 })
    K.box(M.grain, F, 0, (h + 0.04) / 2, 0, hw, (h - 0.04) / 2 - 0.02, hd, wood, { round: 0.14, crook: 0.012 })
    K.box(M.grain, F, 0, h - 0.018, 0.012, hw + 0.025, 0.02, hd + 0.02, tone(room.tints.table, -0.05, 0.08), { round: 0.45, rows: 6, crook: 0.01 })
    const cols = hw > 0.35 ? 2 : 1, rowH = (h - 0.14) / it.rows
    for (let rI = 0; rI < it.rows; rI++) for (let c = 0; c < cols; c++) {
      const cx = cols === 1 ? 0 : (c - 0.5) * hw, cy = 0.07 + rowH * (rI + 0.5), hwD = hw / cols - 0.03
      const Fd = K.crook(frame(...put(F, cx, cy, hd + 0.006), it.yaw), 0.015)
      K.box(M.grain, Fd, 0, 0, 0, hwD, rowH / 2 - 0.018, 0.014, tone(room.tints.wood, -0.05 + K.j(0.05), 0.08), { round: 0.18, segs: 16, rows: 6, crook: 0.004 })
      K.blob(M.grain, Fd, [0, 0, 0.022], 0.017, 0.017, 0.013, DARK, { segs: 10, rows: 6, flat: false })
    }
  },

  chest(it, M, K, room) {
    const F = K.crook(frame(it.x, it.y, it.z, it.yaw), 0.015), wood = woodOf(room, K), hw = it.w / 2, hd = it.d / 2, h = it.h
    K.box(M.grain, F, 0, h * 0.34, 0, hw, h * 0.34, hd, wood, { round: 0.3, crook: 0.012 })
    K.box(M.grain, F, 0, h * 0.72, 0, hw + 0.015, h * 0.16, hd + 0.015, tone(room.tints.wood, 0, 0.08), { round: 0.75, crook: 0.012 })
    for (const x of [-hw * 0.6, hw * 0.6]) K.box(M.grain, F, x, h * 0.46, 0, 0.022, h * 0.46 + 0.006, hd + 0.02, IRON, { round: 0.4, flat: true })
    K.box(M.grain, F, 0, h * 0.62, hd + 0.02, 0.035, 0.042, 0.012, IRON, { round: 0.4, segs: 12, rows: 6, flat: true })
  },

  woodpile(it, M, K, room) {
    const rng = mulberry32(it.seed), rm = rAt(room.rs, it.a), a0 = it.a - it.half / rm, a1 = it.a + it.half / rm
    const lr = 0.06, n0 = Math.max(1, Math.floor((it.depth - 0.03) / (2 * lr))), segs = Math.max(1, Math.round((2 * it.half) / 0.5))
    for (let row = 0; row < it.rows && n0 - row >= 1; row++) {
      for (let i = 0; i < n0 - row; i++) {
        const inset = FILLET * 0.4 + lr + (i + row * 0.5) * 2 * lr, y = lr + row * lr * 1.72
        for (let s = 0; s < segs; s++) {
          const r = lr * (0.8 + rng() * 0.3), b0 = a0 + ((a1 - a0) * s) / segs + (rng() * 0.04) / rm, b1 = a0 + ((a1 - a0) * (s + 1)) / segs - (rng() * 0.04) / rm
          const p0 = wallAt(room, b0, inset + (rng() - 0.5) * 0.02, y + (r - lr)), p1 = wallAt(room, b1, inset + (rng() - 0.5) * 0.02, y + (r - lr))
          const bark = tone(room.tints.wood, -0.16 + (rng() - 0.5) * 0.08, 0.06), ax = norm(sub(p1, p0))
          K.rod(M.grain, p0, p1, r, r * (0.9 + rng() * 0.15), bark, { segs: 10, rough: 0.1 })
          K.disc(M.floor, p0, ax.map((v) => -v), r, tone(room.tints.wood, 0.28), { segs: 10 })
          K.disc(M.floor, p1, ax, r, tone(room.tints.wood, 0.28), { segs: 10 })
        }
      }
    }
  },

  workbench(it, M, K, room) {
    const F = K.crook(frame(it.x, it.y, it.z, it.yaw), 0.015), wood = woodOf(room, K), T = it.top
    K.box(M.grain, F, 0, T - 0.03, 0, it.hx, 0.03, it.hz, woodOf(room, K, 'table', -0.06), { round: 0.3, rows: 6, crook: 0.012 })
    const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => [put(F, x * (it.hx - 0.05), 0, z * (it.hz - 0.04)), put(F, x * (it.hx - 0.08), T - 0.055, z * (it.hz - 0.06))])
    for (const [lo, hi] of legs) K.limb(M.grain, lo, hi, 0.032, 0.028, wood, { bow: 0.012 })
    K.box(M.grain, F, 0, 0.12, 0, it.hx - 0.07, 0.015, it.hz - 0.05, wood, { round: 0.3, segs: 12, rows: 4, crook: 0.01 })
    K.box(M.grain, F, it.hx - 0.07, T + 0.03, it.hz - 0.02, 0.045, 0.03, 0.03, IRON, { round: 0.4, segs: 12, rows: 6, flat: true })
  },

  gourds(it, M, K, room, rng) {
    const n = Math.max(3, it.n)
    for (let k = 0; k < n; k++) {
      const top = k === n - 1 && n > 3, q = it.yaw + (k / (n - (top ? 1 : 0))) * TAU, d = top ? 0 : it.r * 0.5 * (0.8 + rng() * 0.3)
      const rr = it.r * (top ? 0.34 : 0.3 + rng() * 0.12), gh = rr * (1.1 + rng() * 0.4)
      const pal = [rgb(0.07 + it.hue * 0.03, 0.42, 0.4), rgb(0.12, 0.32, 0.55), rgb(0.2, 0.2, 0.36), rgb(0.09, 0.45, 0.34)]
      const F = K.crook(frame(it.x + Math.cos(q) * d, top ? it.r * 0.42 : 0, it.z + Math.sin(q) * d, rng() * TAU), 0.2)
      K.lathe(M.linen, F, [[0, gh * 0.06], [rr * 0.6, 0], [rr * 0.95, gh * 0.3], [rr, gh * 0.55], [rr * 0.8, gh * 0.86], [rr * 0.3, gh], [0, gh * 0.92]], pal[Math.floor(rng() * pal.length)], { segs: 20, flat: true, lobes: [8, 0.14], rough: 0.02 })
      K.limb(M.grain, put(F, 0, gh * 0.9, 0), put(F, 0.02, gh * 0.9 + 0.05, 0.01), 0.012, 0.008, DARK, { bow: 0.006, segs: 6 })
    }
  },

  stools(it, M, K, room) { stoolAt(M, K, K.crook(frame(it.x, 0, it.z, it.yaw), 0.04), it.r, STOOL_H, woodOf(room, K)) },

  hamper(it, M, K) {
    const F = K.crook(frame(it.x, 0, it.z, it.yaw), 0.04), r = it.r, h = HAMPER_H
    K.lathe(M.grain, F, [[0, 0.01], [r * 0.86, 0], [r * 0.95, 0.04], [r, h * 0.7], [r * 1.02, h - 0.02], [r * 0.98, h], [0, h - 0.01]], WICKER, { segs: 24, lobes: [24, 0.035], uvM: 0.12 })
    K.lathe(M.grain, F, [[r * 1.04, h - 0.03], [r * 1.07, h - 0.02], [r * 1.05, h + 0.01], [r * 0.7, h + 0.045], [0, h + 0.055]], WICKER, { segs: 24, uvM: 0.12 })
    for (const s of [-1, 1]) K.tube(M.grain, [-0.5, 0, 0.5].map((u) => put(F, s * (r + 0.012), h * 0.78 + (1 - 4 * u * u) * 0.04, u * r * 0.4)), [0.009, 0.01, 0.009], WICKER, { segs: 6 })
  },

  mobile(it, M, K, room, rng) {
    const rho = Math.hypot(it.x, it.z), ceil = ceilingAt(room, rho, rAt(room.rs, Math.atan2(it.z, it.x)))
    const hub = [it.x, it.y, it.z]
    K.rod(M.linen, hub, [it.x, ceil + 0.05, it.z], 0.003, 0.003, CORD, { segs: 3, flat: true })
    K.lathe(M.grain, frame(it.x, it.y - 0.01, it.z), [[0.16, 0], [0.175, 0.002], [0.18, 0.012], [0.172, 0.02], [0.16, 0.018], [0.155, 0.006], [0.16, 0]], woodOf(room, K), { segs: 28 })
    for (let k = 0; k < it.n; k++) {
      const q = (k / it.n) * TAU, len = 0.12 + rng() * 0.2
      const top = [it.x + Math.cos(q) * 0.17, it.y, it.z + Math.sin(q) * 0.17], end = [top[0], top[1] - len, top[2]]
      K.rod(M.linen, top, end, 0.002, 0.002, CORD, { segs: 3, flat: true })
      K.leaf(M.linen, end, [0, -1, 0], 0.11, 0.035, [Math.cos(q + 1), 0, Math.sin(q + 1)], rgb(it.hue + k * 0.05, 0.3, 0.4))
    }
  },

  garland(it, M, K, room, rng) {
    let prev = null
    for (let k = 0; k <= it.n * 2; k++) {
      const t = k / (it.n * 2), a = it.a0 + (it.a1 - it.a0) * t
      const p = wallAt(room, a, 0.06 + 0.04 * Math.sin(Math.PI * t), it.y - it.sag * Math.sin(Math.PI * t))
      if (prev) K.rod(M.linen, prev, p, 0.004, 0.004, CORD, { segs: 3, flat: true })
      if (k % 2 === 1) {
        const out = [-Math.cos(a), 0, -Math.sin(a)]
        K.leaf(M.linen, p, norm([K.j(0.5), -1, K.j(0.5)]), 0.09, 0.035, out, rng() < 0.5 ? GREEN(rng()) : rgb(0.07 + rng() * 0.04, 0.45, 0.38))
      }
      prev = p
    }
  },

  sconce(it, M, K, room) {
    const face = inward(it.a), plate = wallAt(room, it.a, 0.005, it.y - 0.05)
    K.blob(M.grain, K.crook(frame(...plate, face), 0.08), [0, 0, 0], 0.058, 0.09, 0.02, woodOf(room, K, 'wood', -0.01), { segs: 16, rows: 10, flat: false, rough: 0.06 })
    const cup = [it.x, it.y, it.z], out = norm(sub([it.x, 0, it.z], [plate[0], 0, plate[2]]))
    K.tube(M.grain, [add(plate, out, 0.01), add(add(plate, out, 0.05), [0, 1, 0], -0.03), add(cup, [0, 1, 0], -0.03), add(cup, [0, 1, 0], -0.005)], [0.011, 0.01, 0.01, 0.012], IRON, { segs: 8 })
    candleOn(M, K, it.x, it.y, it.z, 0.1, IRON)
  },
}

// The kit and palette render/town-interior.js builds from.
export { Mesher, kit, frame, put, turn, tip, rgb, tone, FLAT, WOOD_M, VERT, FRAG, speckleTexture, buildFlames, slab, bookAt, candleOn, sackAt, binding, CLAY, CREAM, WAX, IRON, TIN, CORD, WICKER, BURLAP, DARK, MUTED, add, sub, norm, cross }
