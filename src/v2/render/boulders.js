import THREE from '../../three-instance.js'

import { PropArena } from './prop-arena.js'
import { ladderTris } from './gen-props.js'
import { mulberry32 } from '../../sim/mathx.js'
import { ROCK_LOD_AT, ROCK_LOD_HYSTERESIS, rockLodSize } from '../../props/rock.js'

// ---------------------------------------------------------------------------
// A ROOM'S OWN BOULDERS (DESIGN.md §30): the stones a village puts against its
// houses (rooms/village.js DECOR), seated where the room file says rather than
// scattered. The rocks' own bed cannot do this -- its tiles pack by rank and
// would move a stone off the wall it is meant to bite into -- so this is the
// entrances' flanking stones (entrances.js _flank) with a fixed list in place
// of the roll: one arena over the rocks' boulder shape, every instance placed
// at construction and none ever evicted, re-runged by distance on the rocks'
// own thresholds. Each is stone to the walker (walk.js addStone) as a cylinder
// at its plan radius, the same crude column the flanking stones use.
// ---------------------------------------------------------------------------

// How a boulder is bedded and shaded. `sink` of its height goes into the
// ground, so it sits in the earth rather than on it. `r` of its plan radius is
// the cylinder the walker climbs, inside the hull so she is never stopped by
// air. `tone` is the per-instance lightness spread -- the rocks' bed's own
// 0.86..1.16 without its ground cue, which needs the bed's tile machinery; what
// is left is enough that two stones against one wall do not read as one shape.
const BED = { sink: 0.4, r: 0.8, tone: [0.86, 1.16] }
const LOD_SQ = Float32Array.from(ROCK_LOD_AT, (k) => k * k)
const LOD_SQ_OUT = Float32Array.from(ROCK_LOD_AT, (k) => (k * (1 + ROCK_LOD_HYSTERESIS)) ** 2)

export class Boulders {
  /**
   * @param field  V2Height: heightAt
   * @param rocks  Rocks: boulder
   * @param opts.boulders  `[{ x, z, across, yaw }]`, metres and radians: `across` is the stone's width, which is what scales it.
   * @param opts.seed  The room's seed, so a village's stones are shaded its own way.
   */
  constructor(scene, field, rocks, { boulders = [], seed = 1 } = {}) {
    if (!field || typeof field.heightAt !== 'function') throw new Error('Boulders: needs a V2Height with heightAt')
    if (!rocks || typeof rocks.boulder !== 'function') throw new Error('Boulders: needs the Rocks, for its boulder shape')
    if (!Array.isArray(boulders) || boulders.some((b) => ![b.x, b.z, b.across, b.yaw].every(Number.isFinite) || !(b.across > 0))) {
      throw new Error('Boulders: `boulders` is a list of { x, z, across, yaw }')
    }
    // Cloned, because PropMeshes hangs its fade attribute on the geometry it is given and the rocks' own meshes already hold that on these.
    const shape = rocks.boulder()
    const pool = Math.max(1, boulders.length)
    this.batch = new PropArena(pool, shape.tiers.map((g) => ({ geometries: [g.clone()] })), new Array(shape.tiers.length).fill(pool), () => shape.material, 'v2-boulders')
    this.tris = ladderTris(shape.tiers)
    this.tierAt = new Int8Array(pool).fill(-1)
    this.drawn = 0

    const mm = shape.measured
    const rand = mulberry32(seed ^ 0x6d2b79f5)
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0), c = new THREE.Color()
    // Per boulder: its foot, the cylinder the walker climbs and the metre its rung is read at.
    this.stones = []
    for (const b of boulders) {
      const scale = b.across / mm.width
      const radius = 0.5 * Math.max(mm.width, mm.depth) * scale
      const height = mm.height * scale
      const y = field.heightAt(b.x, b.z) - BED.sink * height
      const id = this.batch.addInstance(0)
      this.batch.setVisibleAt(id, false)
      q.setFromAxisAngle(up, b.yaw)
      this.batch.setMatrixAt(id, m.compose(p.set(b.x, y, b.z), q, s.setScalar(scale)))
      const v = BED.tone[0] + rand() * (BED.tone[1] - BED.tone[0])
      this.batch.setColorAt(id, c.setRGB(v, v, v))
      this.stones.push({ id, x: b.x, z: b.z, y, r: radius * BED.r, top: y + height, size: rockLodSize(mm) * scale })
    }
    scene.add(this.batch)
  }

  /** Re-rung every stone by its distance, on the rocks' own thresholds: a stone leaves a rung 12% further out than it came in. */
  update(camX, camY, camZ) {
    let drawn = 0
    for (const f of this.stones) {
      const dx = f.x - camX, dy = 0.5 * (f.y + f.top) - camY, dz = f.z - camZ
      const d2 = dx * dx + dy * dy + dz * dz
      const cur = this.tierAt[f.id]
      let tier = LOD_SQ.length
      for (let b = 0; b < LOD_SQ.length; b++) {
        if (d2 < f.size * f.size * (cur >= 0 && cur <= b ? LOD_SQ_OUT[b] : LOD_SQ[b])) { tier = b; break }
      }
      if (tier !== cur) {
        this.tierAt[f.id] = tier
        this.batch.setGeometryIdAt(f.id, tier)
        this.batch.setVisibleAt(f.id, true)
      }
      drawn += this.tris[tier]
    }
    this.drawn = drawn
  }

  // -- stone to the walker (walk.js addStone) ---------------------------------

  columnAt(x, z, _minSize, out) {
    const cap = out.length >> 1
    let n = 0
    for (const f of this.stones) {
      if (n >= cap) return n
      const dx = x - f.x, dz = z - f.z
      if (dx * dx + dz * dz > f.r * f.r) continue
      out[n * 2] = f.y
      out[n * 2 + 1] = f.top
      n++
    }
    return n
  }

  blockTopAt(x, z) {
    let top = -Infinity
    for (const f of this.stones) {
      const dx = x - f.x, dz = z - f.z
      if (dx * dx + dz * dz <= f.r * f.r && f.top > top) top = f.top
    }
    return top
  }

  get stats() {
    return { placed: this.stones.length, tris: this.drawn }
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.batch.dispose()
  }
}
