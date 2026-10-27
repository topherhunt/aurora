import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { onRock, rayRock, gradient } from '../caves/chalk.js'
import { columnAt } from '../caves/props.js'

// The giant cave spiders (design/39-caves.md §12): body-length-a-metre crawlers on the walls and ceilings of the caverns and chambers. They never attack her. A torch near one stops it, it rears and hisses, then backs away from the light, facing it, until the light is far. Each has HP for the fight (hurt, onDeath).
//
// The sim steps each spider every TICK_S on the field's own surface (one projection per step) and the draw lerps between steps; spiders further than SLEEP_M from her eye do not step. One InstancedMesh draws them all; the legs swing in the vertex shader from a per-instance phase.

export const SPIDER = {
  hp: 20,
  size: [0.8, 1.3],
  // Body centre this far off the wall, per unit size: the feet reach it.
  bodyH: 0.45,
  walkMps: 0.5,
  retreatMps: 1.5,
  // A torch this near (metres, world) makes one hiss; it stops retreating once every torch is CALM_M away.
  hissM: 6,
  calmM: 9,
  hissS: 0.8,
  pauseS: [1.5, 5],
  deathS: 2.5,
  max: 40,
  sleepM: 70,
  drawM: 70,
  // Not within this many metres of a mouth as the crow flies; nodes this big (rx) take 1 to 3, chambers 0 to 1.
  mouthM: 50,
}
// Spiders step this often; the draw lerps between steps.
export const TICK_S = 0.15
// The wood spiders (render/spiders.js) multiply their map by at least 0.3; a cave spider's body is this share of that darkest, on a nominal brown.
export const SHADE = 0.35 * 0.3
export const BASE_COLOR = [0.32, 0.24, 0.18]

const LIFT_M = 0.25
const REACH_M = 1.5
const FLOOR_NY = 0.6
const STUCK_TURNS = 6
// A seat's field value must be this near the surface: the projection can land short on a thin fin.
const SEAT_F = 0.35

class Spider {
  constructor(id, x, y, z, n, rand) {
    this.id = id
    this.size = SPIDER.size[0] + (SPIDER.size[1] - SPIDER.size[0]) * rand()
    this.p = [x, y, z]
    this.prev = [x, y, z]
    this.n = n
    this.prevN = [...n]
    // Heading in the tangent plane, and the way the body faces (differs from the heading while backing away).
    const a = rand() * Math.PI * 2
    this.h = tangent(n, [Math.cos(a), 0.3 * Math.sin(a * 2), Math.sin(a)], [1, 0, 0])
    this.face = [...this.h]
    this.state = 'wander'
    this.until = 0
    this.clock = rand() * TICK_S
    this.phase = rand() * 6.28
    this.rear = 0
    this.curl = 0
    this.hp = SPIDER.hp
    this.turns = 0
    this.rand = rand
    this.speed = 0
    this.deadFor = 0
  }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l < 1e-9 ? null : [v[0] / l, v[1] / l, v[2] / l] }

/** `want` projected into the plane normal to `n`, unit; `fallback` projected the same way if `want` lies along n. */
function tangent(n, want, fallback) {
  for (const w of [want, fallback, [0, 0, 1], [1, 0, 0]]) {
    const k = dot(w, n)
    const t = norm([w[0] - n[0] * k, w[1] - n[1] * k, w[2] - n[2] * k])
    if (t !== null) return t
  }
  throw new Error('tangent: no direction in the plane')
}

/** Where the plan seats spiders: [{ x, y, z, nx, ny, nz }] on walls and ceilings of its caverns and chambers, cave-local; deterministic from the seed. */
export function spiderHomes(plan) {
  const { graph, field, seed } = plan
  const rand = mulberry32((seed ^ 0x51d3) >>> 0)
  const mouths = graph.nodes.filter((n) => n.kind === 'mouth')
  const out = []
  for (const n of graph.nodes) {
    if (n.kind !== 'cavern' && n.kind !== 'chamber') continue
    if (mouths.some((m) => Math.hypot(m.x - n.x, m.z - n.z) < SPIDER.mouthM)) continue
    const count = n.kind === 'cavern' ? 1 + Math.floor(rand() * 3) : rand() < 0.4 ? 1 : 0
    for (let k = 0; k < count && out.length < SPIDER.max; k++) {
      for (let tries = 0; tries < 30; tries++) {
        const a = rand() * Math.PI * 2, u = Math.sqrt(rand()) * 0.7
        const lx = Math.cos(a) * u * n.rx, lz = Math.sin(a) * u * n.rz, c = Math.cos(n.rot), s = Math.sin(n.rot)
        const x = n.x + lx * c - lz * s, z = n.z + lx * s + lz * c
        const col = columnAt(field, x, z, n.y + 1)
        if (col === null) continue
        const el = (rand() - 0.2) * 1.4
        const dx = Math.cos(a) * Math.cos(el), dy = Math.sin(el), dz = Math.sin(a) * Math.cos(el)
        const hit = [0, 0, 0]
        if (!rayRock(field, x, col.floor + 1 + rand() * (col.roof - col.floor - 1.5), z, dx, dy, dz, 40, hit)) continue
        const g = [0, 0, 0]
        if (Math.abs(field.at(hit[0], hit[1], hit[2])) > SEAT_F || gradient(field, hit[0], hit[1], hit[2], g) === 0) continue
        const nrm = [-g[0], -g[1], -g[2]]
        if (nrm[1] > FLOOR_NY) continue
        out.push({ x: hit[0], y: hit[1], z: hit[2], nx: nrm[0], ny: nrm[1], nz: nrm[2] })
        break
      }
    }
  }
  return out
}

// Unit spider, +Z forward, +Y the wall's normal, feet at y = -bodyH: a thorax and abdomen and eight two-jointed legs.
// Vertex `part` = (leg index 0..7 or -1 for the body, how far out along its leg 0..1, tone).
function spiderGeometry() {
  const pos = [], nrm = [], part = []
  const tri = (a, b, c, info) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    ;[a, b, c].forEach((p, i) => { pos.push(...p); nrm.push(nx, ny, nz); part.push(info[0], info[1][i], info[2]) })
  }
  const ellipsoid = (cx, cy, cz, rx, ry, rz, tone) => {
    const U = 8, V = 5
    const P = (i, j) => { const th = (i / U) * Math.PI * 2, ph = (j / V) * Math.PI; return [cx + Math.cos(th) * Math.sin(ph) * rx, cy + Math.cos(ph) * ry, cz + Math.sin(th) * Math.sin(ph) * rz] }
    for (let j = 0; j < V; j++) for (let i = 0; i < U; i++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1)
      if (j > 0) tri(a, d, b, [-1, [0, 0, 0], tone])
      if (j < V - 1) tri(b, d, c, [-1, [0, 0, 0], tone])
    }
  }
  ellipsoid(0, 0.05, 0.2, 0.16, 0.13, 0.2, 0.9)
  ellipsoid(0, 0.1, -0.25, 0.24, 0.2, 0.3, 1.1)
  const tube = (a, b, ta, tb, ra, rb, leg) => {
    const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]])
    const s = norm([-d[2], 0, d[0]]) ?? [1, 0, 0]
    const q = [d[1] * s[2] - d[2] * s[1], d[2] * s[0] - d[0] * s[2], d[0] * s[1] - d[1] * s[0]]
    const ring = (c, r) => [0, 1, 2].map((k) => [0, 1, 2].map((m) => c[m] + (s[m] * Math.cos((k * 2 * Math.PI) / 3) + q[m] * Math.sin((k * 2 * Math.PI) / 3)) * r))
    const A = ring(a, ra), B = ring(b, rb)
    for (let k = 0; k < 3; k++) {
      const m = (k + 1) % 3
      tri(A[k], A[m], B[m], [leg, [ta, ta, tb], 0.8])
      tri(A[k], B[m], B[k], [leg, [ta, tb, tb], 0.8])
    }
  }
  for (let leg = 0; leg < 8; leg++) {
    const side = leg % 2 === 0 ? 1 : -1, pair = leg >> 1
    const yaw = [0.7, 0.2, -0.3, -0.75][pair]
    const d = [side * Math.cos(yaw), 0, Math.sin(yaw)]
    const hip = [side * 0.12, 0.02, 0.28 - pair * 0.13]
    const knee = [hip[0] + d[0] * 0.5, 0.38, hip[2] + d[2] * 0.5]
    const foot = [knee[0] + d[0] * 0.45, -SPIDER.bodyH, knee[2] + d[2] * 0.45]
    tube(hip, knee, 0, 0.55, 0.035, 0.028, leg)
    tube(knee, foot, 0.55, 1, 0.028, 0.008, leg)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('part', new THREE.Float32BufferAttribute(part, 3))
  return g
}

const VERT = /* glsl */ `
attribute vec3 part;
attribute vec4 iAnim;
varying vec3 vPos;
varying vec3 vNrm;
varying float vTone;
void main() {
  vec3 p = position;
  float leg = part.x, tip = part.y;
  if (leg >= 0.0) {
    float side = mod(leg, 2.0) < 0.5 ? 1.0 : -1.0;
    float pair = floor(leg * 0.5);
    float phi = iAnim.x + (mod(pair, 2.0) < 0.5 ? 0.0 : 3.14159) * side + pair * 0.6;
    p.z += sin(phi) * 0.12 * iAnim.y * tip;
    p.y += max(0.0, cos(phi)) * 0.1 * iAnim.y * tip;
    float front = pair < 0.5 ? 1.0 : (pair < 1.5 ? 0.4 : 0.0);
    p.y += iAnim.z * front * 0.55 * tip;
    p.z += iAnim.z * front * 0.25 * tip;
    p.x -= p.x * 0.6 * iAnim.w * tip;
    p.z -= (p.z - 0.1) * 0.5 * iAnim.w * tip;
    p.y += 0.7 * iAnim.w * tip;
  }
  vTone = part.z;
  vec4 w = modelMatrix * (instanceMatrix * vec4(p, 1.0));
  mat3 m = mat3(instanceMatrix);
  vNrm = normalize(mat3(modelMatrix) * (m * (normal / vec3(dot(m[0], m[0]), dot(m[1], m[1]), dot(m[2], m[2])))));
  vPos = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const fragment = (common) => /* glsl */ `
${common}
varying vec3 vPos;
varying vec3 vNrm;
varying float vTone;
void main() {
  vec3 n = normalize(vNrm);
  vec3 albedo = vec3(${BASE_COLOR.map((c) => (c * SHADE).toFixed(4)).join(', ')}) * vTone;
  vec3 v = normalize(cameraPosition - vPos);
  vec3 lit = caveTorch(vPos, n);
  // A torch-side sheen off the carapace.
  vec3 sheen = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float s = uTorch[i].w;
    if (s <= 0.0) continue;
    vec3 l = uTorch[i].xyz - vPos;
    float d = length(l);
    float k = clamp(1.0 - d / 8.0, 0.0, 1.0);
    sheen += uTorchColor * (s * k * k * pow(max(dot(n, normalize(l / max(d, 0.001) + v)), 0.0), 18.0) * 0.5);
  }
  vec3 c = albedo * max(lit, vec3(uLitFloor)) + sheen * 0.25;
  gl_FragColor = vec4(caveFog(c, vPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

const _m = new THREE.Matrix4()

export class CaveSpiders {
  /** `group` is the cave room's group (at height `oy`), `uniforms` its shared cave uniforms, `common` its torch and fog GLSL, `plan` from planCave. */
  constructor(group, uniforms, common, plan, oy) {
    this.group = group
    this.plan = plan
    this.oy = oy
    this.field = plan.field
    this.rand = mulberry32((plan.seed ^ 0x2f71) >>> 0)
    /** Called (spider) as one starts to hiss; its world position is in list(). Set by the caller. */
    this.onHiss = null
    /** Called (spider) once when one's HP runs out: the spider freezes curled until remove(id), or goes by itself after deathS if this is null. */
    this.onDeath = null
    this.spiders = spiderHomes(plan).map((h, i) => new Spider(i, h.x, h.y, h.z, [h.nx, h.ny, h.nz], mulberry32((plan.seed * 7919 + i) >>> 0)))
    this.geometry = spiderGeometry()
    this.tris = this.geometry.getAttribute('position').count / 3
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(SPIDER.max * 4), 4)
    this.anim.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('iAnim', this.anim)
    this.material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: fragment(common) })
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, SPIDER.max)
    this.mesh.name = 'cave-spiders'
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = 0
    group.add(this.mesh)
    this.now = 0
  }

  /** Each spider with its world position: [{ id, x, y, z, hp, maxHp, state, size }]. */
  list() {
    return this.spiders.map((s) => ({ id: s.id, x: s.p[0], y: s.p[1] + this.oy, z: s.p[2], hp: s.hp, maxHp: SPIDER.hp, state: s.state, size: s.size }))
  }

  /** `amount` off spider `id`'s HP. Returns { hp, dead }; the death hook fires the once. */
  hurt(id, amount) {
    const s = this.spiders.find((q) => q.id === id)
    if (s === undefined) throw new Error(`CaveSpiders: no spider ${id}`)
    if (s.state === 'dead') return { hp: 0, dead: true }
    s.hp = Math.max(0, s.hp - amount)
    if (s.hp === 0) {
      s.state = 'dead'
      s.deadFor = 0
      s.rear = 0
      if (this.onDeath !== null) this.onDeath(s)
    }
    return { hp: s.hp, dead: s.hp === 0 }
  }

  remove(id) {
    const i = this.spiders.findIndex((q) => q.id === id)
    if (i === -1) throw new Error(`CaveSpiders: no spider ${id}`)
    this.spiders.splice(i, 1)
  }

  /** `dt` seconds on; `eye` her eye in world metres; `lights` the torch uniform (Vector4s: world xyz, strength w). */
  update(dt, eye, lights) {
    this.now += dt
    const ex = eye.x, ey = eye.y - this.oy, ez = eye.z
    const live = []
    for (const s of this.spiders) {
      if (s.state === 'dead') {
        s.deadFor += dt
        s.curl = Math.min(1, s.curl + dt * 2.5)
        if (this.onDeath === null && s.deadFor > SPIDER.deathS) { live.push(null); continue }
        live.push(s)
        continue
      }
      const far = (s.p[0] - ex) ** 2 + (s.p[1] - ey) ** 2 + (s.p[2] - ez) ** 2 > SPIDER.sleepM * SPIDER.sleepM
      if (!far) {
        s.clock += dt
        while (s.clock >= TICK_S) { s.clock -= TICK_S; this._step(s, TICK_S, lights) }
      }
      live.push(s)
    }
    if (live.includes(null)) this.spiders = live.filter((s) => s !== null)
    this._draw(ex, ey, ez, dt)
  }

  _threat(s, lights) {
    let best = null, bd = Infinity
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i]
      if (l.w <= 0.05) continue
      const d = Math.hypot(l.x - (s.p[0]), l.y - (s.p[1] + this.oy), l.z - s.p[2])
      if (d < bd) { bd = d; best = l }
    }
    return { light: best, dist: bd }
  }

  _step(s, dt, lights) {
    const { light, dist } = this._threat(s, lights)
    s.prev = [...s.p]
    s.prevN = [...s.n]
    if (s.state === 'wander' || s.state === 'pause') {
      if (light !== null && dist < SPIDER.hissM) {
        s.state = 'hiss'
        s.until = this.now + SPIDER.hissS
        s.face = tangent(s.n, [light.x - s.p[0], light.y - this.oy - s.p[1], light.z - s.p[2]], s.face)
        s.speed = 0
        if (this.onHiss !== null) this.onHiss(s)
      }
    }
    if (s.state === 'hiss') {
      s.rear = Math.min(1, s.rear + dt * 6)
      if (light !== null) s.face = tangent(s.n, [light.x - s.p[0], light.y - this.oy - s.p[1], light.z - s.p[2]], s.face)
      if (this.now >= s.until) s.state = 'retreat'
      s.speed = 0
      return
    }
    s.rear = Math.max(0, s.rear - dt * 3)
    if (s.state === 'retreat') {
      if (light === null || dist > SPIDER.calmM) { s.state = 'wander'; s.until = 0; return }
      const away = tangent(s.n, [s.p[0] - light.x, s.p[1] - (light.y - this.oy), s.p[2] - light.z], s.h)
      s.h = away
      s.face = tangent(s.n, [-away[0], -away[1], -away[2]], s.face)
      this._move(s, SPIDER.retreatMps * dt, false)
      s.speed = 1
      return
    }
    if (s.state === 'pause') {
      s.speed = 0
      if (this.now >= s.until) s.state = 'wander'
      return
    }
    // wander: a drift of the heading about the normal, now and then a pause.
    const turn = (s.rand() - 0.5) * 0.7
    const c = Math.cos(turn), sn = Math.sin(turn)
    const side = [s.n[1] * s.h[2] - s.n[2] * s.h[1], s.n[2] * s.h[0] - s.n[0] * s.h[2], s.n[0] * s.h[1] - s.n[1] * s.h[0]]
    s.h = tangent(s.n, [s.h[0] * c + side[0] * sn, s.h[1] * c + side[1] * sn, s.h[2] * c + side[2] * sn], s.h)
    s.face = s.h
    if (s.rand() < 0.03) { s.state = 'pause'; s.until = this.now + SPIDER.pauseS[0] + (SPIDER.pauseS[1] - SPIDER.pauseS[0]) * s.rand(); s.speed = 0; return }
    this._move(s, SPIDER.walkMps * dt, true)
    s.speed = 0.5
  }

  /** One step of `dist` along the heading, re-seated on the rock. A step that finds no wall, a floor or water is retried at a new heading, up to 3 times; STUCK_TURNS failed steps in a row sit it down. */
  _move(s, dist, steerFace) {
    const f = this.field
    const out = [0, 0, 0], g = [0, 0, 0]
    for (let attempt = 0; attempt < 3; attempt++) {
      const cx = s.p[0] + s.h[0] * dist + s.n[0] * LIFT_M, cy = s.p[1] + s.h[1] * dist + s.n[1] * LIFT_M, cz = s.p[2] + s.h[2] * dist + s.n[2] * LIFT_M
      if (onRock(f, cx, cy, cz, REACH_M, out) && Math.abs(f.at(out[0], out[1], out[2])) < SEAT_F && gradient(f, out[0], out[1], out[2], g) > 0) {
        const nn = [-g[0], -g[1], -g[2]]
        if (nn[1] <= FLOOR_NY && dot(nn, s.n) > -0.3 && !this._wet(out)) {
          s.p = [out[0], out[1], out[2]]
          s.n = nn
          s.h = tangent(nn, s.h, s.face)
          if (steerFace) s.face = s.h
          s.turns = 0
          return
        }
      }
      const a = (s.rand() < 0.5 ? 1 : -1) * (1.2 + s.rand() * 1.5)
      const c = Math.cos(a), sn = Math.sin(a)
      const side = [s.n[1] * s.h[2] - s.n[2] * s.h[1], s.n[2] * s.h[0] - s.n[0] * s.h[2], s.n[0] * s.h[1] - s.n[1] * s.h[0]]
      s.h = tangent(s.n, [s.h[0] * c + side[0] * sn, s.h[1] * c + side[1] * sn, s.h[2] * c + side[2] * sn], s.h)
      if (steerFace) s.face = s.h
    }
    if (++s.turns >= STUCK_TURNS) { s.turns = 0; s.state = 'pause'; s.until = this.now + SPIDER.pauseS[1] }
  }

  _wet(p) {
    for (const b of this.plan.waters) {
      if (p[0] < b.x0 || p[0] > b.x1 || p[2] < b.z0 || p[2] > b.z1) continue
      const level = b.levelAt(p[0], p[2])
      if (level !== null && p[1] < level + 0.2) return true
    }
    return false
  }

  _draw(ex, ey, ez, dt) {
    const arr = this.anim.array
    let n = 0
    for (const s of this.spiders) {
      if (n === SPIDER.max) break
      const a = Math.min(1, s.clock / TICK_S)
      const x = s.prev[0] + (s.p[0] - s.prev[0]) * a, y = s.prev[1] + (s.p[1] - s.prev[1]) * a, z = s.prev[2] + (s.p[2] - s.prev[2]) * a
      if ((x - ex) ** 2 + (y - ey) ** 2 + (z - ez) ** 2 > SPIDER.drawM * SPIDER.drawM) continue
      const nn = norm([s.prevN[0] + (s.n[0] - s.prevN[0]) * a, s.prevN[1] + (s.n[1] - s.prevN[1]) * a, s.prevN[2] + (s.n[2] - s.prevN[2]) * a]) ?? s.n
      const fz = tangent(nn, s.face, s.h)
      const fx = [nn[1] * fz[2] - nn[2] * fz[1], nn[2] * fz[0] - nn[0] * fz[2], nn[0] * fz[1] - nn[1] * fz[0]]
      const k = s.size, lift = SPIDER.bodyH * k
      _m.set(
        fx[0] * k, nn[0] * k, fz[0] * k, x + nn[0] * lift,
        fx[1] * k, nn[1] * k, fz[1] * k, y + nn[1] * lift,
        fx[2] * k, nn[2] * k, fz[2] * k, z + nn[2] * lift,
        0, 0, 0, 1,
      )
      this.mesh.setMatrixAt(n, _m)
      s.phase += dt * (s.speed > 0.75 ? 16 : s.speed > 0 ? 7 : 0)
      arr[n * 4] = s.phase
      arr[n * 4 + 1] = s.speed > 0 ? 1 : 0
      arr[n * 4 + 2] = s.rear
      arr[n * 4 + 3] = s.curl
      n++
    }
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
    this.anim.needsUpdate = true
  }

  dispose() {
    this.mesh.removeFromParent()
    this.geometry.dispose()
    this.material.dispose()
    this.mesh.dispose()
  }
}
