import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'

// Seaweed for the depths: a clump of ribbon blades, each a strip that tapers to a point as it rises, leaning out and
// rippling side to side, under a dark-green mottle drawn here in code. Not scattered yet.

export const SEAWEED = {
  blades: [5, 9],
  height: [0.5, 1.4],
  // The widest a blade gets, metres either side of its midrib.
  width: [0.04, 0.08],
  segs: 8,
  // Texture side in texels; the mottle repeats every `repeat` metres up a blade.
  tex: 64,
  repeat: 0.5,
}

const DARK = [0.035, 0.11, 0.03]
const MID = [0.08, 0.2, 0.05]
const OLIVE = [0.22, 0.3, 0.08]

/** One clump of blades for `seed`, rooted at the origin: positions, normals, and a uv whose v runs in metres / SEAWEED.repeat. */
export function seaweedGeometry(seed) {
  const r = mulberry32(seed)
  const range = ([a, b]) => a + (b - a) * r()
  const n = Math.round(range(SEAWEED.blades))
  const S = SEAWEED.segs
  const pos = []
  const uv = []
  const index = []
  for (let b = 0; b < n; b++) {
    const yaw = (b / n + r() * 0.3) * Math.PI * 2
    const dx = Math.cos(yaw)
    const dz = Math.sin(yaw)
    const root = r() * 0.08
    const h = range(SEAWEED.height)
    const w = range(SEAWEED.width)
    const lean = (0.15 + 0.35 * r()) * h
    const amp = 0.04 + 0.05 * r()
    const freq = (1.5 + 1.5 * r()) * Math.PI * 2
    const phase = r() * Math.PI * 2
    const twist = (r() - 0.5) * Math.PI
    const base = pos.length / 3
    for (let s = 0; s <= S; s++) {
      const t = s / S
      const out = root + lean * t * t
      const wig = amp * Math.sin(freq * t + phase) * t
      const cx = dx * out - dz * wig
      const cz = dz * out + dx * wig
      // Narrow at the holdfast, widest a third of the way up, a point at the tip.
      const hw = w * Math.sin(Math.PI * (0.08 + 0.92 * t)) ** 0.7
      const face = yaw + Math.PI / 2 + twist * t
      const ax = Math.cos(face) * hw
      const az = Math.sin(face) * hw
      const y = h * t
      pos.push(cx - ax, y, cz - az, cx + ax, y, cz + az)
      const v = y / SEAWEED.repeat
      uv.push(0, v, 1, v)
      if (s > 0) {
        const i = base + (s - 1) * 2
        index.push(i, i + 1, i + 2, i + 1, i + 3, i + 2)
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(index)
  geo.computeVertexNormals()
  return geo
}

/** The mottle: two octaves of tiling value noise between a dark and a mid green, olive flecks where both run high, a paler midrib down u = 0.5. */
export function seaweedTexture(seed = 1) {
  const N = SEAWEED.tex
  const r = mulberry32(seed)
  const lattice = (cells) => {
    const g = Float32Array.from({ length: cells * cells }, () => r())
    return (x, y) => {
      const fx = (x / N) * cells
      const fy = (y / N) * cells
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      const sx = (fx - x0) ** 2 * (3 - 2 * (fx - x0))
      const sy = (fy - y0) ** 2 * (3 - 2 * (fy - y0))
      const at = (i, j) => g[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)]
      const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx
      const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx
      return top + (bot - top) * sy
    }
  }
  const coarse = lattice(6)
  const fine = lattice(16)
  const data = new Uint8Array(N * N * 4)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const m = coarse(x, y) * 0.65 + fine(x, y) * 0.35
      const k = Math.min(1, Math.max(0, (m - 0.3) / 0.45))
      const fleck = Math.max(0, (fine(x, y) * coarse(x, y) - 0.42) / 0.3)
      const rib = Math.max(0, 1 - Math.abs(x / N - 0.5) * 14) * 0.35
      const o = (y * N + x) * 4
      for (let c = 0; c < 3; c++) {
        let v = DARK[c] + (MID[c] - DARK[c]) * k
        v += (OLIVE[c] - v) * Math.min(1, fleck + rib)
        data[o + c] = Math.round(v ** (1 / 2.2) * 255)
      }
      data[o + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, N, N)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

export function seaweedMaterial(map = seaweedTexture()) {
  return new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: 0.8, metalness: 0 })
}
