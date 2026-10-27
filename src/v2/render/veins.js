import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'

// Ore veins and gems on a cave's walls (caves/veins.js places them): lumpy ore outcrops and clustered crystals in one merged mesh, lit by the cave's torches. Ore reads as dim rock-coloured knots; a gem is nearly black until a torch is near and then glints, a different facet each moment.

export const VEIN_LOOK = {
  'bog-iron': { color: [0.34, 0.15, 0.07], shine: 0.05, blobs: 3, size: 0.55 },
  lodestone: { color: [0.11, 0.12, 0.15], shine: 0.35, blobs: 3, size: 0.5 },
  rimesilver: { color: [0.62, 0.72, 0.8], shine: 0.5, blobs: 4, size: 0.5 },
  jade: { color: [0.1, 0.55, 0.28], shine: 1, size: 0.14 },
  ruby: { color: [0.75, 0.04, 0.1], shine: 1, size: 0.12 },
  sapphire: { color: [0.08, 0.2, 0.8], shine: 1, size: 0.13 },
  diamond: { color: [0.85, 0.92, 1], shine: 1, size: 0.12 },
}

// An ore knot sinks this far into the wall so its edge meets the rock.
const SINK_M = 0.06
const GEM_SIDES = 6

// Unit icosahedron (20 faces), vertex positions shared by index so a jitter keyed on the index moves a vertex once.
const T = (1 + Math.sqrt(5)) / 2
const ICO_V = [[-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0], [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T], [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1]].map((v) => { const l = Math.hypot(...v); return v.map((c) => c / l) })
const ICO_F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]

class Soup {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.shine = []; this.facet = [] }
  /** One flat-shaded triangle; `facet` seeds a gem's twinkle. */
  tri(a, b, c, color, shine, facet) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    if (l < 1e-12) return
    nx /= l; ny /= l; nz /= l
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]); this.nrm.push(nx, ny, nz); this.col.push(color[0], color[1], color[2]); this.shine.push(shine); this.facet.push(facet)
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setAttribute('shine', new THREE.Float32BufferAttribute(this.shine, 1))
    g.setAttribute('facet', new THREE.Float32BufferAttribute(this.facet, 1))
    return g
  }
}

/** The wall frame at a vein: n out of the wall, t sideways along it, b = n x t. */
function frame(v) {
  const n = [v.nx, v.ny, v.nz]
  const l = Math.hypot(...n)
  n[0] /= l; n[1] /= l; n[2] /= l
  let t = [-n[2], 0, n[0]]
  if (Math.hypot(t[0], t[2]) < 1e-6) t = [1, 0, 0]
  const tl = Math.hypot(...t)
  t = t.map((c) => c / tl)
  const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]]
  return { n, t, b }
}

function ore(soup, v, look, rand) {
  const { n, t, b } = frame(v)
  for (let k = 0; k < look.blobs; k++) {
    const r = look.size * (0.6 + 0.6 * rand())
    const cu = (rand() - 0.5) * 1.1, cv = (rand() - 0.5) * 0.7
    const o = [v.x, v.y, v.z]
    const c = o.map((x, i) => x + t[i] * cu + b[i] * cv - n[i] * SINK_M)
    const pts = ICO_V.map((p) => {
      const j = 0.7 + 0.5 * rand()
      const u = p[0] * r * j, w = p[1] * r * j * 0.8, h = p[2] * r * 0.45 * j
      return [0, 1, 2].map((i) => c[i] + t[i] * u + b[i] * w + n[i] * h)
    })
    const shade = 0.75 + 0.5 * rand()
    const color = look.color.map((x) => x * shade)
    for (const f of ICO_F) soup.tri(pts[f[0]], pts[f[1]], pts[f[2]], color, look.shine, rand())
  }
}

function gem(soup, v, look, rand) {
  const { n, t, b } = frame(v)
  const crystals = 2 + Math.floor(rand() * 3)
  for (let k = 0; k < crystals; k++) {
    const r = look.size * (0.6 + 0.6 * rand()), len = r * (2.2 + 2 * rand())
    const base = [v.x, v.y, v.z].map((x, i) => x + t[i] * (rand() - 0.5) * 0.3 + b[i] * (rand() - 0.5) * 0.3 - n[i] * 0.02)
    // The axis leans out of the wall, tilted a little in a random direction.
    const lean = (rand() - 0.5) * 1.2, spin = rand() * Math.PI
    const axis = [0, 1, 2].map((i) => n[i] + (t[i] * Math.cos(spin) + b[i] * Math.sin(spin)) * lean)
    const al = Math.hypot(...axis)
    const a = axis.map((c) => c / al)
    let s = [a[1] * t[2] - a[2] * t[1], a[2] * t[0] - a[0] * t[2], a[0] * t[1] - a[1] * t[0]]
    const sl = Math.hypot(...s)
    s = s.map((c) => c / sl)
    const q = [a[1] * s[2] - a[2] * s[1], a[2] * s[0] - a[0] * s[2], a[0] * s[1] - a[1] * s[0]]
    const ring = (h, rad, k0) => Array.from({ length: GEM_SIDES }, (_, i) => {
      const ang = ((i + k0) / GEM_SIDES) * Math.PI * 2
      return [0, 1, 2].map((d) => base[d] + a[d] * h + s[d] * Math.cos(ang) * rad + q[d] * Math.sin(ang) * rad)
    })
    const lo = ring(0, r, 0), hi = ring(len * 0.7, r * 0.9, 0)
    const tip = [0, 1, 2].map((d) => base[d] + a[d] * len)
    for (let i = 0; i < GEM_SIDES; i++) {
      const j = (i + 1) % GEM_SIDES
      soup.tri(lo[i], lo[j], hi[j], look.color, 1, rand())
      soup.tri(lo[i], hi[j], hi[i], look.color, 1, rand())
      soup.tri(hi[i], hi[j], tip, look.color, 1, rand())
    }
  }
}

/** One merged geometry for `veins` (caves/veins.js placeVeins output, cave-local). Deterministic: each vein rolls from its own id. */
export function veinGeometry(veins) {
  const soup = new Soup()
  for (const v of veins) {
    const look = VEIN_LOOK[v.kind]
    if (look === undefined) throw new Error(`veinGeometry: unknown kind ${v.kind}`)
    let h = 2166136261
    for (const ch of v.id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
    const rand = mulberry32(h >>> 0)
    if (look.shine === 1) gem(soup, v, look, rand)
    else ore(soup, v, look, rand)
  }
  return soup.geometry()
}

const VERT = /* glsl */ `
attribute vec3 color;
attribute float shine;
attribute float facet;
varying vec3 vCol;
varying float vShine;
varying float vFacet;
varying vec3 vPos;
varying vec3 vNrm;
void main() {
  vCol = color;
  vShine = shine;
  vFacet = facet;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPos = w.xyz;
  vNrm = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`

// A gem is lit only by a glint: a torch-side specular that flares on the facets whose twinkle phase is up, so the stone sparks as she moves. Ore takes the cave's ordinary torchlight and a faint sheen.
const fragment = (common) => /* glsl */ `
${common}
uniform float uTime;
varying vec3 vCol;
varying float vShine;
varying float vFacet;
varying vec3 vPos;
varying vec3 vNrm;
void main() {
  vec3 n = normalize(vNrm);
  vec3 v = normalize(cameraPosition - vPos);
  vec3 lit = caveTorch(vPos, n);
  vec3 glint = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float s = uTorch[i].w;
    if (s <= 0.0) continue;
    vec3 l = uTorch[i].xyz - vPos;
    float d = length(l);
    float k = clamp(1.0 - d / 9.0, 0.0, 1.0);
    vec3 h = normalize(l / max(d, 0.001) + v);
    float sp = pow(max(dot(n, h), 0.0), vShine > 0.9 ? 40.0 : 12.0);
    float tw = vShine > 0.9 ? 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * 3.0 + vFacet * 40.0), 3.0) : 1.0;
    glint += uTorchColor * (s * k * sp * tw * vShine * 6.0);
  }
  vec3 c;
  if (vShine > 0.9) c = vCol * (0.04 + lit * 0.25) + glint * (0.4 + vCol);
  else c = vCol * max(lit, vec3(uLitFloor)) + glint * vCol;
  gl_FragColor = vec4(caveFog(c, vPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

/** The vein layer: `uniforms` are the room's shared cave uniforms, `common` its torch and fog GLSL. */
export class VeinLayer {
  constructor(group, uniforms, common, veins) {
    this.group = group
    this.veins = veins
    this.material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: fragment(common) })
    this.mesh = null
    this.tris = 0
    this.setMined(new Set())
  }

  /** Rebuilds the mesh without the veins whose ids are in `mined`. */
  setMined(mined) {
    if (this.mesh !== null) { this.mesh.geometry.dispose(); this.mesh.removeFromParent() }
    const g = veinGeometry(this.veins.filter((v) => !mined.has(v.id)))
    this.tris = g.getAttribute('position').count / 3
    this.mesh = new THREE.Mesh(g, this.material)
    this.mesh.name = 'cave-veins'
    this.mesh.frustumCulled = false
    this.group.add(this.mesh)
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.removeFromParent()
    this.material.dispose()
  }
}
