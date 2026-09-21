import THREE from '../../three-instance.js'

import { createPropMaterial } from '../../material.js'

// ---------------------------------------------------------------------------
// A ROOM'S SHELL (DESIGN.md §30): the inside of the boulder the village is in.
// The rock bank's boulder as the hollow bed stands it -- the longest axis up
// (the bed's `stand`, a Z quarter turn), `sink` of its height under the floor
// (the bed's `sinkRange`) -- at one uniform scale, turned inside out and drawn
// front-face-only from within on the same stone layer. NEGATIVE SCALE ALONE
// DOES NOT EXPOSE THE INSIDE: three flips the front face for a negative
// determinant, so the winding is reversed on the index and the normals negated
// instead. The stone is the boulder's own tile at the stood scale (a placed
// boulder's tile scales with the rock, gen-rock-main.js), so the wall reads as
// one rock's grain seen from inside rather than a wall of small stones.
//
// THE SHELL IS STONE TO HER (walk.js addStone, Player._fly): a column table
// over the hull's plan at CELL m, each cell the heights at which the vertical
// line through its centre crosses the surface, sorted. Below the first and
// above the last is stone -- the boulder under the underside, whose top she
// stands on where it rises past the ground, and the roof, stone up to the sky
// -- and so is every second gap between: a wall that bulges into the room is
// a ledge on that line, with the room's air over it. A line that misses the
// hull is stone from end to end, its top the boulder's crown. Read bilinearly
// where the four cells about the point cross the surface as often as each
// other, the nearest cell where they do not, and not at all inside the door
// (setDoor): the arch's hole is drawn there.
// ---------------------------------------------------------------------------

const CELL = 0.5
// Crossings one column may hold: a span each and one more in the walker's
// eight (walk.js SPAN_CAP), which is past what the boulder's 320 faces fold.
const CROSS_CAP = 12
// How far apart two crossings must stand to be two: a centre on a shared edge is in both triangles.
const CROSS_EPS = 1e-3

export class Shell {
  /**
   * @param bank  buildRockBank()'s answer; the boulder's tier 0 is the shell.
   * @param fit  `{ x, z, floor, scale, sink, yaw }`: the axis, the room's floor height, the uniform scale over the bank's metres, the fraction of the stood height under the floor, and the stood boulder's turn about the axis (radians; a village's roll).
   */
  constructor(scene, bank, textureArray, fit) {
    const f = { yaw: 0, ...fit }
    if (!fit || ![f.x, f.z, f.floor, f.scale, f.sink, f.yaw].every(Number.isFinite) || !(f.scale > 0) || !(f.sink >= 0 && f.sink < 1)) {
      throw new Error('Shell: `fit` is { x, z, floor, scale, sink, yaw }')
    }
    const src = bank.shapes.boulder.tiers[0]
    const geo = src.clone()
    const index = geo.index.array
    for (let i = 0; i < index.length; i += 3) {
      const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t
    }
    const n = geo.attributes.normal.array
    for (let i = 0; i < n.length; i++) n[i] = -n[i]
    geo.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
    geo.rotateY(f.yaw)
    geo.computeBoundingBox()
    const bb = geo.boundingBox
    this.material = createPropMaterial(textureArray, { side: THREE.FrontSide, bump: true })
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.name = 'v2-shell'
    this.mesh.frustumCulled = false
    this.mesh.scale.setScalar(f.scale)
    this.mesh.position.set(
      f.x - ((bb.min.x + bb.max.x) / 2) * f.scale,
      f.floor - f.sink * (bb.max.y - bb.min.y) * f.scale - bb.min.y * f.scale,
      f.z - ((bb.min.z + bb.max.z) / 2) * f.scale,
    )
    this.mesh.updateMatrixWorld(true)
    this.fit = { ...f }
    this.top = this.mesh.position.y + bb.max.y * f.scale
    this._ray = new THREE.Raycaster()
    this._origin = new THREE.Vector3()
    this._dir = new THREE.Vector3()
    this.door = null
    this._cross = new Float32Array(CROSS_CAP)
    this._table(geo, bb)
    scene.add(this.mesh)
  }

  /** The column table: every triangle's height at every cell centre under it, sorted per column, the pair about the floor kept. */
  _table(geo, bb) {
    const s = this.fit.scale, m = this.mesh.position
    const x0 = m.x + bb.min.x * s - CELL, z0 = m.z + bb.min.z * s - CELL
    const nx = Math.ceil((bb.max.x - bb.min.x) * s / CELL) + 3, nz = Math.ceil((bb.max.z - bb.min.z) * s / CELL) + 3
    const cross = new Float32Array(nx * nz * CROSS_CAP)
    const count = new Uint8Array(nx * nz)
    const pos = geo.attributes.position.array, idx = geo.index.array
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
      const ax = pos[a] * s + m.x, az = pos[a + 2] * s + m.z, ay = pos[a + 1] * s + m.y
      const bx = pos[b] * s + m.x, bz = pos[b + 2] * s + m.z, by = pos[b + 1] * s + m.y
      const cx = pos[c] * s + m.x, cz = pos[c + 2] * s + m.z, cy = pos[c + 1] * s + m.y
      const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az)
      if (Math.abs(det) < 1e-12) continue
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / CELL - 0.5)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / CELL - 0.5))
      const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / CELL - 0.5)), j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) - z0) / CELL - 0.5))
      for (let j = j0; j <= j1; j++) {
        const pz = z0 + (j + 0.5) * CELL
        for (let i = i0; i <= i1; i++) {
          const px = x0 + (i + 0.5) * CELL
          // Barycentric weights of the centre in the triangle's plan.
          const wb = ((px - ax) * (cz - az) - (cx - ax) * (pz - az)) / det
          const wc = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / det
          const wa = 1 - wb - wc
          if (wa < 0 || wb < 0 || wc < 0) continue
          const y = wa * ay + wb * by + wc * cy
          const k = j * nx + i, n = count[k]
          let dup = false
          for (let q = 0; q < n && !dup; q++) dup = Math.abs(cross[k * CROSS_CAP + q] - y) < CROSS_EPS
          if (dup) continue
          if (n >= CROSS_CAP) throw new Error(`Shell: ${CROSS_CAP} crossings on the column at ${px.toFixed(1)}, ${pz.toFixed(1)}`)
          cross[k * CROSS_CAP + n] = y
          count[k] = n + 1
        }
      }
    }
    // A lone crossing is a graze on the silhouette, no room.
    for (let k = 0; k < nx * nz; k++) {
      if (count[k] < 2) { count[k] = 0; continue }
      const col = cross.subarray(k * CROSS_CAP, k * CROSS_CAP + count[k])
      col.sort()
    }
    this._grid = { x0, z0, nx, nz, cross, count }
  }

  /**
   * Where the vertical line through (x, z) crosses the surface, lowest first,
   * into `out` (CROSS_CAP long): how many, none where the line misses the hull.
   */
  crossingsAt(x, z, out) {
    const g = this._grid, cross = g.cross, count = g.count
    const fx = (x - g.x0) / CELL - 0.5, fz = (z - g.z0) / CELL - 0.5
    const i = Math.floor(fx), j = Math.floor(fz)
    const countAt = (ii, jj) => (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.nz ? -1 : count[jj * g.nx + ii])
    const n = countAt(i, j)
    if (n > 0 && countAt(i + 1, j) === n && countAt(i, j + 1) === n && countAt(i + 1, j + 1) === n) {
      const tx = fx - i, tz = fz - j
      const k00 = (j * g.nx + i) * CROSS_CAP, k10 = k00 + CROSS_CAP, k01 = k00 + g.nx * CROSS_CAP, k11 = k01 + CROSS_CAP
      for (let q = 0; q < n; q++) {
        out[q] = (cross[k00 + q] * (1 - tx) + cross[k10 + q] * tx) * (1 - tz) + (cross[k01 + q] * (1 - tx) + cross[k11 + q] * tx) * tz
      }
      return n
    }
    const ni = Math.round(fx), nj = Math.round(fz)
    const m = countAt(ni, nj)
    if (m <= 0) return 0
    const k = (nj * g.nx + ni) * CROSS_CAP
    for (let q = 0; q < m; q++) out[q] = cross[k + q]
    return m
  }

  /** The door: within `r` of (x, z) in plan the stone gives way top to bottom, for the arch and its hole (entrances.js) drawn on the face there. */
  setDoor(x, z, r) {
    if (![x, z, r].every(Number.isFinite) || !(r > 0)) throw new Error('Shell.setDoor: needs x, z and a radius')
    this.door = { x, z, r }
  }

  // -- the stone to the walker (walk.js addStone) ------------------------------

  /** Stone from below the first crossing, between every second pair after it, and from the last up; the pair left over by an odd count is air. */
  columnAt(x, z, _minSize, out) {
    if (this.door !== null && Math.hypot(x - this.door.x, z - this.door.z) < this.door.r) return 0
    const c = this._cross
    const n = this.crossingsAt(x, z, c)
    out[0] = -Infinity
    if (n === 0) {
      out[1] = Infinity
      return 1
    }
    out[1] = c[0]
    let spans = 1
    for (let q = 1; q + 1 < n - 1; q += 2) {
      out[spans * 2] = c[q]
      out[spans * 2 + 1] = c[q + 1]
      spans++
    }
    out[spans * 2] = c[n - 1]
    out[spans * 2 + 1] = Infinity
    return spans + 1
  }

  /** The highest stone top short of the roof: the underside, or the last ledge a bulge makes; the crown where the line misses the hull. */
  blockTopAt(x, z) {
    if (this.door !== null && Math.hypot(x - this.door.x, z - this.door.z) < this.door.r) return -Infinity
    const c = this._cross
    const n = this.crossingsAt(x, z, c)
    if (n === 0) return this.top
    return n % 2 === 0 ? c[n - 2] : c[Math.max(0, n - 3)]
  }

  /** The wall's distance from the axis at height `y` along `bearing` (radians from +X toward +Z). Throws when the ray leaves the hull, since that is not a room. */
  wallAt(y, bearing) {
    this._ray.set(this._origin.set(this.fit.x, y, this.fit.z), this._dir.set(Math.cos(bearing), 0, Math.sin(bearing)))
    const hit = this._ray.intersectObject(this.mesh, false)
    if (hit.length === 0) throw new Error(`Shell.wallAt: no wall at ${y.toFixed(1)} m along ${((bearing * 180) / Math.PI).toFixed(0)} degrees`)
    return hit[0].distance
  }

  /** The roof's height over (x, z) from `y`, or null where there is none. */
  roofAt(x, y, z) {
    this._ray.set(this._origin.set(x, y, z), this._dir.set(0, 1, 0))
    const hit = this._ray.intersectObject(this.mesh, false)
    return hit.length === 0 ? null : hit[0].distance
  }

  /** The stone's tint, the way a placed boulder wears one (Rocks.tintAt). */
  setTint(color) {
    this.material.color.copy(color)
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
