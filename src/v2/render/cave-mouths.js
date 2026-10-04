// The cave mouths on the overworld (design/39-caves.md §2): a hood of the cliff's own stippled rock standing out of each face, with a hole she walks into that darkens to black. The ground cannot overhang, so the clefts (layers/clefts.js) only keep the terrain out of the hole; the hood is what she sees and what stops her at its walls.
//
// Built in world axes about each mouth, never rotated: the stipple rung reads its plane off the local position, so a rotated mesh would slide its grain.
import THREE from '../../three-instance.js'
import { MOUTH } from '../caves/sites.js'
import { mulberry32 } from '../../sim/mathx.js'

const C_ROCK = [0.085, 0.082, 0.078]
const ARCH = 15
const SLICES = 7
// Metres behind the foot the hood runs on into the cliff, past the cleft's end, and its walls' footing under the ground.
const BACK = 6.6
const SINK = 0.8
const STIP = 1 / 1.5
// Her clearance from the hole's sides.
const PAD = 0.3

/** One mouth's hood, `{ position, normal, color, index }` about (m.x, m.y, m.z). */
function hoodGeometry(m) {
  const rand = mulberry32(0x40d0 + m.id * 7919)
  const ix = -m.nx, iz = -m.nz
  const tx = -iz, tz = ix
  const pos = [], col = [], idx = []
  const v = (s, t, y, c) => {
    pos.push(ix * s + tx * t, y, iz * s + tz * t)
    col.push(c[0], c[1], c[2])
    return pos.length / 3 - 1
  }
  const quad = (a, b, c, d) => idx.push(a, b, c, a, c, d)
  // An arch of half-width w and height h, theta 0 at +t to pi at -t, with its feet at `foot`.
  const arch = (w, h, k, foot) => {
    if (k < 0) return [w, foot]
    if (k > ARCH) return [-w, foot]
    const a = (k / ARCH) * Math.PI
    return [w * Math.cos(a), h * Math.pow(Math.sin(a), 0.55)]
  }
  const lump = Array.from({ length: (SLICES + 1) * (ARCH + 3) }, () => 1 + (rand() - 0.5) * 0.18)
  const s0 = -MOUTH.hoodOut

  // The outer shell, front to back, swelling from a rounded lip to the full hood.
  const shell = []
  for (let i = 0; i <= SLICES; i++) {
    const s = s0 + ((BACK - s0) * i) / SLICES
    const f = Math.min(1, (s - s0) / MOUTH.hoodOut)
    const w = MOUTH.hoodW * (0.72 + 0.28 * Math.sqrt(f)), h = (MOUTH.holeH + 0.9) + 1.5 * Math.sqrt(f)
    const row = []
    for (let k = -1; k <= ARCH + 1; k++) {
      const [t, y] = arch(w, h, k, -SINK)
      const l = lump[i * (ARCH + 3) + k + 1]
      row.push(v(s, t * l, y < 0 ? y : y * l, C_ROCK))
    }
    shell.push(row)
  }
  for (let i = 0; i < SLICES; i++) for (let k = 0; k < ARCH + 2; k++) quad(shell[i][k], shell[i + 1][k], shell[i + 1][k + 1], shell[i][k + 1])

  // The tunnel, its rock fading to black by the throat.
  const tunnel = []
  const TS = 5
  for (let i = 0; i <= TS; i++) {
    const s = s0 + ((MOUTH.throat - s0) * i) / TS
    const dark = Math.pow(1 - i / TS, 1.8)
    const c = C_ROCK.map((x) => x * dark)
    const row = []
    for (let k = -1; k <= ARCH + 1; k++) {
      const [t, y] = arch(MOUTH.holeW, MOUTH.holeH, k, 0)
      row.push(v(s, t, y, c))
    }
    tunnel.push(row)
  }
  for (let i = 0; i < TS; i++) for (let k = 0; k < ARCH + 2; k++) quad(tunnel[i][k + 1], tunnel[i + 1][k + 1], tunnel[i + 1][k], tunnel[i][k])

  // The front: the ring between the lip of the shell and the hole.
  const front = shell[0], hole = tunnel[0]
  for (let k = 0; k < ARCH + 2; k++) quad(front[k + 1], hole[k + 1], hole[k], front[k])

  // The floor plate, and the black cap closing the throat.
  const black = [0, 0, 0]
  const fl = []
  for (let i = 0; i <= TS; i++) {
    const s = s0 + ((MOUTH.throat - s0) * i) / TS
    const c = C_ROCK.map((x) => x * 0.7 * Math.pow(1 - i / TS, 1.8))
    fl.push([v(s, MOUTH.holeW, 0.02, c), v(s, -MOUTH.holeW, 0.02, c)])
  }
  for (let i = 0; i < TS; i++) quad(fl[i][0], fl[i + 1][0], fl[i + 1][1], fl[i][1])
  const mid = v(MOUTH.throat, 0, MOUTH.holeH * 0.4, black)
  const cap = []
  for (let k = -1; k <= ARCH + 1; k++) {
    const [t, y] = arch(MOUTH.holeW, MOUTH.holeH, k, 0)
    cap.push(v(MOUTH.throat, t, y, black))
  }
  for (let k = 0; k < cap.length - 1; k++) idx.push(mid, cap[k], cap[k + 1])
  return { pos, col, idx }
}

export class CaveMouths {
  /** `mouths` from siteMouths, `material` the terrain's plain stipple rung (it needs color, forest and stipple attributes). */
  constructor(mouths, material) {
    this.mouths = mouths
    this.group = new THREE.Group()
    this.group.name = 'cave-mouths'
    for (const m of mouths) {
      const { pos, col, idx } = hoodGeometry(m)
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
      g.setIndex(idx)
      g.computeVertexNormals()
      const n = pos.length / 3
      g.setAttribute('forest', new THREE.Float32BufferAttribute(new Float32Array(n), 1))
      const nrm = g.getAttribute('normal')
      const stip = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) {
        const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i))
        stip[i * 4] = STIP
        stip[i * 4 + 3] = ay >= ax && ay >= az ? 0 : ax >= az ? 1 : 2
      }
      g.setAttribute('stipple', new THREE.BufferAttribute(stip, 4))
      const mesh = new THREE.Mesh(g, material)
      mesh.position.set(m.x, m.y, m.z)
      mesh.name = `cave-mouth-${m.id}`
      this.group.add(mesh)
    }
  }

  // (s, t) of a point in mouth m's frame: s metres in past the foot, t across.
  _frame(m, x, z) {
    const dx = x - m.x, dz = z - m.z
    return { s: -(dx * m.nx + dz * m.nz), t: dx * m.nz - dz * m.nx }
  }

  /** The mouth whose hole (x, y, z) has walked MOUTH.into past the foot of, or null. */
  entered(x, y, z) {
    for (const m of this.mouths) {
      if (Math.abs(x - m.x) > 8 || Math.abs(z - m.z) > 8 || Math.abs(y - m.y) > 1.5) continue
      const { s, t } = this._frame(m, x, z)
      if (s >= MOUTH.into && s < MOUTH.throat + 1 && Math.abs(t) <= MOUTH.holeW) return m
    }
    return null
  }

  /** The nearest mouth within r metres of (x, z), or null: when to start meshing its cave. */
  near(x, z, r) {
    let best = null, bd = r
    for (const m of this.mouths) {
      const d = Math.hypot(x - m.x, z - m.z)
      if (d < bd) { bd = d; best = m }
    }
    return best
  }

  /** Pushes `p` ({x, y, z}, feet) out of any hood's rock in place: the hood is solid but for its hole. Returns whether it moved her. */
  collide(p) {
    let moved = false
    for (const m of this.mouths) {
      if (Math.abs(p.x - m.x) > 12 || Math.abs(p.z - m.z) > 12 || p.y > m.y + MOUTH.holeH + 3 || p.y < m.y - 2) continue
      const { s, t } = this._frame(m, p.x, p.z)
      const w = MOUTH.hoodW + PAD
      if (s < -MOUTH.hoodOut - PAD || s > BACK || Math.abs(t) > w) continue
      const inHole = Math.abs(t) <= MOUTH.holeW - PAD && p.y < m.y + 1.0
      if (inHole) {
        if (s > MOUTH.throat - PAD) this._put(p, m, MOUTH.throat - PAD, t)
        moved = moved || s > MOUTH.throat - PAD
        continue
      }
      // Out by the nearest face: the front, a side, or (inside the tunnel) the hole's own wall.
      const tunnel = s > -MOUTH.hoodOut + PAD && Math.abs(t) < MOUTH.holeW + 0.6
      if (tunnel) this._put(p, m, s, Math.sign(t) * (MOUTH.holeW - PAD))
      else {
        const toFront = s + MOUTH.hoodOut + PAD, toSide = w - Math.abs(t)
        if (toFront < toSide) this._put(p, m, -MOUTH.hoodOut - PAD, t)
        else this._put(p, m, s, Math.sign(t) * w)
      }
      moved = true
    }
    return moved
  }

  _put(p, m, s, t) {
    p.x = m.x - m.nx * s + m.nz * t
    p.z = m.z - m.nz * s - m.nx * t
  }

  dispose() {
    for (const c of this.group.children) c.geometry.dispose()
    this.group.removeFromParent()
  }
}
