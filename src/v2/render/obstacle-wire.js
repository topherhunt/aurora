import THREE from '../../three-instance.js'

// ---------------------------------------------------------------------------
// The obstacle wireframes, a debug overlay (the debug grid's row): the outline
// of what stops her feet and the teleport round her, read off the walk surface
// itself (WalkSurface or CaveWalk) rather than any mesh, so a gap between these
// lines and a drawn wall is a gap in the collision. Orange outlines stone across
// her head volume over the ground there -- a wall, not a step; red outlines a
// trunk or a body (obstacleAt, padded). Drawn through everything, at the ground
// on the free side of each edge, and re-read as she moves or the bodies walk.
// ---------------------------------------------------------------------------

/** Metres at her full size: the square read round her feet, its cell, the lines' lift off the ground, how far she moves before a re-read. Seconds between re-reads standing still. A read is ~2.6k cells, ~10 ms in headless Chrome. */
export const OBSTACLE_WIRE = { radius: 5, cell: 0.2, lift: 0.04, moveM: 1, refreshS: 1 }
const COLOUR = [null, new THREE.Color(0xff9a2e), new THREE.Color(0xff3b3b)]
const MAX_SEGMENTS = 40000

export class ObstacleWire {
  constructor(scene) {
    this.pos = new Float32Array(MAX_SEGMENTS * 6)
    this.col = new Float32Array(MAX_SEGMENTS * 6)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage))
    g.setDrawRange(0, 0)
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }))
    this.lines.name = 'obstacle-wire'
    this.lines.frustumCulled = false
    this.lines.renderOrder = 999
    this.lines.visible = false
    scene.add(this.lines)
    this._walk = null
    this._at = -Infinity
    this._x = this._z = Infinity
    this._out = { x: 0, z: 0, r: 0 }
  }

  get visible() { return this.lines.visible }
  set visible(on) {
    this.lines.visible = on
    this._walk = null
  }

  /** Re-reads `walk` round `feet` at her `scale` when she has moved moveM or refreshS has passed; `now` in ms. */
  update(walk, feet, scale, now) {
    if (!this.lines.visible) return
    const cell = OBSTACLE_WIRE.cell * scale
    if (walk === this._walk && now - this._at < OBSTACLE_WIRE.refreshS * 1000 && Math.hypot(feet.x - this._x, feet.z - this._z) < OBSTACLE_WIRE.moveM * scale) return
    this._walk = walk
    this._at = now
    this._x = feet.x
    this._z = feet.z
    this._read(walk, feet, cell, Math.ceil((OBSTACLE_WIRE.radius * scale) / cell), OBSTACLE_WIRE.lift * scale)
  }

  _read(walk, feet, cell, n, lift) {
    const side = 2 * n + 1
    // Snapped to the cell, so the outline stays put as she walks rather than swimming under her.
    const x0 = (Math.round(feet.x / cell) - n) * cell
    const z0 = (Math.round(feet.z / cell) - n) * cell
    const kind = new Uint8Array(side * side)
    const ground = new Float32Array(side * side)
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const x = x0 + i * cell, z = z0 + j * cell, c = j * side + i
        const g = walk.heightAt(x, z, feet.y)
        ground[c] = g
        kind[c] = walk.obstacleAt(x, z, this._out) ? 2 : walk.crossed(x, z, g + walk.reach, g + walk.height) ? 1 : 0
      }
    }
    let s = 0
    const edge = (a, b, ax, az, bx, bz) => {
      if (kind[a] === kind[b] || s >= MAX_SEGMENTS) return
      const free = kind[a] === 0 ? a : kind[b] === 0 ? b : Math.max(ground[a], ground[b]) === ground[a] ? a : b
      const y = ground[free] + lift
      const col = COLOUR[Math.max(kind[a], kind[b])]
      const o = s++ * 6
      this.pos[o] = ax; this.pos[o + 1] = y; this.pos[o + 2] = az
      this.pos[o + 3] = bx; this.pos[o + 4] = y; this.pos[o + 5] = bz
      for (let v = 0; v < 6; v += 3) { this.col[o + v] = col.r; this.col[o + v + 1] = col.g; this.col[o + v + 2] = col.b }
    }
    const h = cell / 2
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const c = j * side + i, x = x0 + i * cell + h, z = z0 + j * cell + h
        if (i + 1 < side) edge(c, c + 1, x, z - cell, x, z)
        if (j + 1 < side) edge(c, c + side, x - cell, z, x, z)
      }
    }
    const g = this.lines.geometry
    g.setDrawRange(0, s * 2)
    g.attributes.position.needsUpdate = true
    g.attributes.color.needsUpdate = true
  }

  dispose() {
    this.lines.removeFromParent()
    this.lines.geometry.dispose()
    this.lines.material.dispose()
  }
}
