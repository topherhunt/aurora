import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry32 } from '../sim/mathx.js'

// ---------------------------------------------------------------------------
// Scattered conifers -- a SCALE REFERENCE, not the placement system.
//
// The real thing is DESIGN.md §6 (density fields from the Phase A biome pass,
// path-aware clearing, village exclusion) plus §5's LOD tiering, and it lands
// at build step 5. None of that exists yet, and building it now would mean
// building it blind.
//
// What this is for: an empty heightfield gives you no way to judge how big a
// mountain is or how far away a ridge is. A 10 m tree does, immediately. So
// this places a sparse deterministic scatter of full-detail trees, no LOD, and
// nothing else. It is ~180 trees at ~64 tris -- about 1.5% of the frame budget,
// which is cheap enough that it can stay until step 5 replaces it wholesale.
//
// It does share the architecture it needs to share: one BatchedMesh, one
// material, per-instance geometry selection (§5). If that part is wrong, better
// to find out on 180 trees than on 4,000.
// ---------------------------------------------------------------------------

// Placement is a jittered grid, evaluated in a disc around her and rebuilt when
// she leaves the cell she was in. Deterministic from the seed and the cell
// index, so a tree is always in the same place no matter how she got there.
const SPACING = 75 // m between grid cells
const RADIUS = 800 // m; beyond this fog has swallowed them anyway
const DENSITY = 0.4 // fraction of candidate cells that get a tree
const MAX_TREES = 512

// A treeline is one of the strongest scale cues a mountain can have: it tells
// you how high you are without a number.
const MIN_ELEVATION = 45
const TREELINE = 470
const TREELINE_FADE = 90 // trees thin out over this band rather than stopping dead
const MAX_SLOPE_DEG = 32

const TRUNK = new THREE.Color(0x4a3b2e)
const NEEDLE_DARK = new THREE.Color(0x1f3324)
const NEEDLE_LIGHT = new THREE.Color(0x33553a)

// One conifer: an open trunk cylinder plus stacked cones, tapering upward.
// Radial segments are deliberately low -- §1's N64-era brief, and the silhouette
// is the only part that reads at the distances these are seen from.
function buildConifer({ height, radius, tiers, segments, lean }) {
  const parts = []

  const trunkH = height * 0.34
  const trunk = new THREE.CylinderGeometry(radius * 0.11, radius * 0.17, trunkH, segments, 1, true)
  trunk.translate(0, trunkH / 2, 0)
  paint(trunk, TRUNK, TRUNK)
  parts.push(trunk)

  // Cones overlap by a third of their height so the tiers read as one canopy
  // rather than as separate hats.
  const canopyBase = height * 0.22
  const canopyH = height - canopyBase
  const tierH = canopyH / (1 + (tiers - 1) * 0.62)
  for (let t = 0; t < tiers; t++) {
    const f = t / Math.max(1, tiers - 1)
    const r = radius * (1 - 0.42 * f)
    const cone = new THREE.ConeGeometry(r, tierH * (1 + 0.15 * (1 - f)), segments)
    const y = canopyBase + t * tierH * 0.62
    cone.translate(0, y + tierH / 2, 0)
    // Lighter toward the top, where light actually reaches.
    paint(cone, NEEDLE_DARK, NEEDLE_LIGHT, f)
    parts.push(cone)
  }

  const geo = mergeGeometries(parts, false)
  if (!geo) throw new Error('conifer merge failed -- part geometries have mismatched attributes')
  for (const p of parts) p.dispose()

  // A slight lean stops a stand of them looking like a picket fence.
  geo.rotateZ(lean)
  geo.computeBoundingSphere()
  return geo
}

// Vertex colours, since there are no textures yet (§7 lands at step 6). Blend
// by normalised height within the part so each cone has some internal shading.
function paint(geo, lo, hi, bias = 0) {
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const span = Math.max(1e-4, maxY - minY)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, (pos.getY(i) - minY) / span * 0.7 + bias * 0.3)
    c.copy(lo).lerp(hi, t)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.deleteAttribute('uv')
  return geo
}

const VARIANTS = [
  { height: 13.5, radius: 2.5, tiers: 4, segments: 7, lean: 0.02 },
  { height: 9.0, radius: 2.1, tiers: 3, segments: 6, lean: -0.035 },
  { height: 17.0, radius: 2.8, tiers: 5, segments: 7, lean: 0.045 },
]

export class Trees {
  constructor(scene, terrainHeight, { seed = 1337 } = {}) {
    this.th = terrainHeight
    this.seed = seed
    this.scene = scene

    const geos = VARIANTS.map(buildConifer)
    const maxVerts = Math.max(...geos.map((g) => g.attributes.position.count))
    const maxIndices = Math.max(...geos.map((g) => g.index.count))

    this.material = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.batch = new THREE.BatchedMesh(MAX_TREES, MAX_TREES * maxVerts, MAX_TREES * maxIndices, this.material)
    this.batch.name = 'trees'
    this.batch.frustumCulled = false // per-instance culling does the work
    scene.add(this.batch)

    this.geometryIds = geos.map((g) => this.batch.addGeometry(g))
    this.trisPer = geos.map((g) => g.index.count / 3)
    for (const g of geos) g.dispose()

    // All instances exist from the start; placement only ever rewrites their
    // geometry id, matrix and visibility.
    this.instances = []
    for (let i = 0; i < MAX_TREES; i++) {
      const id = this.batch.addInstance(this.geometryIds[0])
      this.batch.setVisibleAt(id, false)
      this.instances.push(id)
    }

    this._m = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._up = new THREE.Vector3(0, 1, 0)
    this._p = new THREE.Vector3()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()

    this._cellX = null
    this._cellZ = null
    this.stats = { count: 0, tris: 0, lastBuildMs: 0, capped: false }
  }

  // Cheap enough to call every frame; it only does work when she crosses into a
  // new grid cell. Rebuilding costs ~1.5 ms (a few thousand heightAt samples),
  // which at fly speed is once every ~5 s.
  update(camX, camZ) {
    const cx = Math.round(camX / SPACING)
    const cz = Math.round(camZ / SPACING)
    if (cx === this._cellX && cz === this._cellZ) return
    this._cellX = cx
    this._cellZ = cz
    this._rebuild(cx, cz)
  }

  _rebuild(cx, cz) {
    const t0 = performance.now()
    const reach = Math.ceil(RADIUS / SPACING)
    const maxSlope = (MAX_SLOPE_DEG * Math.PI) / 180
    const r2 = RADIUS * RADIUS

    let n = 0
    let tris = 0
    let capped = false

    for (let jz = -reach; jz <= reach && !capped; jz++) {
      for (let jx = -reach; jx <= reach; jx++) {
        const gx = cx + jx
        const gz = cz + jz

        // Hash the absolute cell index, not the loop index, so a tree does not
        // move when she does.
        const rand = mulberry32((this.seed ^ (gx * 73856093) ^ (gz * 19349663)) >>> 0)

        if (rand() > DENSITY) continue

        const x = gx * SPACING + (rand() - 0.5) * SPACING * 0.9
        const z = gz * SPACING + (rand() - 0.5) * SPACING * 0.9

        const dx = x - cx * SPACING
        const dz = z - cz * SPACING
        if (dx * dx + dz * dz > r2) continue

        const h = this.th.heightAt(x, z)
        if (h < MIN_ELEVATION) continue
        // Thin out through the treeline band instead of cutting a hard line.
        if (h > TREELINE - TREELINE_FADE) {
          const above = (h - (TREELINE - TREELINE_FADE)) / TREELINE_FADE
          if (above >= 1 || rand() < above) continue
        }
        if (this.th.slopeAt(x, z, 1.5) > maxSlope) continue

        if (n >= MAX_TREES) {
          capped = true
          break
        }

        const id = this.instances[n]
        const variant = (rand() * VARIANTS.length) | 0
        this.batch.setGeometryIdAt(id, this.geometryIds[variant])

        this._p.set(x, h, z)
        this._q.setFromAxisAngle(this._up, rand() * Math.PI * 2)
        const scale = 0.75 + rand() * 0.55
        this._s.set(scale, scale, scale)
        this._m.compose(this._p, this._q, this._s)
        this.batch.setMatrixAt(id, this._m)

        // Slight per-instance tint so a stand does not look cloned.
        const g = 0.88 + rand() * 0.24
        this._c.setRGB(g * (0.94 + rand() * 0.12), g, g * 0.96)
        this.batch.setColorAt(id, this._c)

        this.batch.setVisibleAt(id, true)
        tris += this.trisPer[variant]
        n++
      }
    }

    for (let i = n; i < MAX_TREES; i++) this.batch.setVisibleAt(this.instances[i], false)

    this.stats.count = n
    this.stats.tris = tris
    this.stats.capped = capped
    this.stats.lastBuildMs = performance.now() - t0
    if (capped) {
      console.warn(`trees: hit the ${MAX_TREES} instance cap -- raise MAX_TREES or lower DENSITY`)
    }
  }

  dispose() {
    this.scene.remove(this.batch)
    this.batch.dispose()
    this.material.dispose()
  }
}
