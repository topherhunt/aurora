// The towns' buildings (DESIGN.md §32), laid out by layers/towns.js. A town swaps tier whole, by the distance to its edge: near it is ONE merged mesh (detail 2 within near, detail 1 within mid), each tier merged once and cached until evict; from mid out to `far`, its buildings are 14-triangle box-and-gables in ONE InstancedMesh shared by every town, tinted per instance, and past `far` none is drawn. So the town the player stands in costs one draw call, and every distant town together costs one more.
import THREE from '../../three-instance.js'
import { createPropMaterial } from '../../material.js'
import { LAYER } from '../../textures.js'
import { buildBuilding2 } from '../../buildings/v2/building.js'
import { roofHeightAt } from '../../buildings/plan.js'
import { townsOccupyAt } from '../layers/towns.js'

export const TOWN_BANDS = { near: 60, mid: 140, far: 1500, hysteresis: 4, prebuild: 300, evict: 420 }
// Frame budget for building geometry: a detail-2 building runs about 1.6 ms on desktop and several times that on the Quest, so no more than one of those a frame.
const BUILD_MS = 4

// The distant box's colours. They MULTIPLY the far box's PLASTER texture (linear mean about 0.47, 0.43, 0.34), so each is the detail-1 building's area-weighted linear albedo (texture mean times vertex colour) divided by that mean, not the colour it reads as. A tint picked by eye comes out about twice as bright as the house it swaps for.
const WALL_TINT = { log: [0.26, 0.25, 0.22], stave: [0.25, 0.23, 0.21], halfTimber: [0.53, 0.53, 0.52], stoneBase: [0.25, 0.24, 0.23], masonry: [0.24, 0.26, 0.26] }
const ROOF_TINT = { thatch: [0.36, 0.28, 0.16], shake: [0.24, 0.23, 0.21], slate: [0.17, 0.19, 0.19], pantile: [0.28, 0.17, 0.15] }
const EAVE = 0.55
const OVER = 0.06
const CELL = 32

// Unit box from y 0 to EAVE, gabled up to a ridge at 1 along X. 8 wall + 2 gable + 4 roof triangles; no floor and no ceiling, neither is ever seen.
function farBoxGeometry() {
  const pos = []
  const roof = []
  const quad = (a, b, c, d, r) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d)
    for (let i = 0; i < 6; i++) roof.push(r)
  }
  const e = EAVE
  quad([-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, e, 0.5], [-0.5, e, 0.5], 0)
  quad([0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, e, -0.5], [0.5, e, -0.5], 0)
  quad([0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, e, -0.5], [0.5, e, 0.5], 0)
  quad([-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, e, 0.5], [-0.5, e, -0.5], 0)
  pos.push(0.5, e, 0.5, 0.5, e, -0.5, 0.5, 1, 0, -0.5, e, -0.5, -0.5, e, 0.5, -0.5, 1, 0)
  for (let i = 0; i < 6; i++) roof.push(0)
  const x = 0.5 + OVER
  const z = 0.5 + OVER
  const drop = e - (OVER / 0.5) * (1 - e)
  quad([-x, drop, z], [x, drop, z], [x, 1, 0], [-x, 1, 0], 1)
  quad([x, drop, -z], [-x, drop, -z], [-x, 1, 0], [x, 1, 0], 1)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  const n = pos.length / 3
  const uv = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    uv[i * 2] = pos[i * 3] + pos[i * 3 + 2]
    uv[i * 2 + 1] = pos[i * 3 + 1]
  }
  g.setAttribute('uvProj', new THREE.BufferAttribute(uv, 2))
  g.setAttribute('texLayer', new THREE.BufferAttribute(new Float32Array(n).fill(LAYER.PLASTER), 1))
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3))
  g.setAttribute('aRoof', new THREE.Float32BufferAttribute(roof, 1))
  return g
}

const ATTRS = [['position', 3], ['normal', 3], ['uvProj', 2], ['texLayer', 1], ['color', 3]]

// A building's geometry at one tier, moved into its town's frame, as plain arrays ready to concatenate.
function placedArrays(b, town, detail) {
  const g = buildBuilding2(b.plan, { detail }).geometry
  const c = Math.cos(b.yaw)
  const s = Math.sin(b.yaw)
  const ox = b.x - town.x
  const oz = b.z - town.z
  const out = { tris: g.index.count / 3 }
  for (const [name, size] of ATTRS) out[name] = Float32Array.from(g.getAttribute(name).array)
  const p = out.position
  const nrm = out.normal
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]
    const z = p[i + 2]
    p[i] = ox + x * c + z * s
    p[i + 1] += b.y
    p[i + 2] = oz - x * s + z * c
    const nx = nrm[i]
    const nz = nrm[i + 2]
    nrm[i] = nx * c + nz * s
    nrm[i + 2] = -nx * s + nz * c
  }
  out.index = Uint32Array.from(g.index.array)
  g.dispose()
  return out
}

// One geometry from a town's placed buildings at one tier.
function mergeParts(parts) {
  let verts = 0
  let idx = 0
  for (const p of parts) {
    verts += p.position.length / 3
    idx += p.index.length
  }
  const g = new THREE.BufferGeometry()
  for (const [name, size] of ATTRS) {
    const arr = new Float32Array(verts * size)
    let o = 0
    for (const p of parts) {
      arr.set(p[name], o)
      o += p[name].length
    }
    g.setAttribute(name, new THREE.BufferAttribute(arr, size))
  }
  const index = verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx)
  let o = 0
  let base = 0
  for (const p of parts) {
    for (let i = 0; i < p.index.length; i++) index[o + i] = p.index[i] + base
    o += p.index.length
    base += p.position.length / 3
  }
  g.setIndex(new THREE.BufferAttribute(index, 1))
  g.computeBoundingSphere()
  g.userData.tris = idx / 3
  return g
}

export class Towns {
  constructor(scene, { towns, textures, patch }) {
    this.scene = scene
    this.towns = towns
    this.buildings = towns.flatMap((t) => t.buildings.map((b) => ({ ...b, town: t })))
    // Per town: the tier shown and wanted, each tier's merged geometry once built, the placed buildings of a tier still being built, and its far boxes.
    this.sites = towns.map((town) => ({ town, tier: 0, want: 0, farShown: false, geo: [null, null, null], parts: [null, [], []], mesh: null, masses: [] }))

    this.material = createPropMaterial(textures, { vertexColors: true })
    this.material.side = THREE.FrontSide
    patch(this.material, 'v2-town-near')

    // The far box: roof vertices take the instance colour (the roof tint), wall and gable vertices the instanced aWallTint.
    this.farMaterial = createPropMaterial(textures, { vertexColors: true })
    this.farMaterial.side = THREE.FrontSide
    const prevCompile = this.farMaterial.onBeforeCompile
    this.farMaterial.onBeforeCompile = (shader, renderer) => {
      prevCompile.call(this.farMaterial, shader, renderer)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aRoof;\nattribute vec3 aWallTint;')
        .replace('#include <color_vertex>', '#include <color_vertex>\n  vColor.rgb = mix( aWallTint, vColor.rgb, aRoof );')
    }
    const prevKey = this.farMaterial.customProgramCacheKey
    this.farMaterial.customProgramCacheKey = () => `town-far|${prevKey.call(this.farMaterial)}`
    patch(this.farMaterial, 'v2-town-far')

    let count = 0
    for (const b of this.buildings) count += b.plan.masses.length
    const geo = farBoxGeometry()
    this.wallTint = new Float32Array(count * 3)
    geo.setAttribute('aWallTint', new THREE.InstancedBufferAttribute(this.wallTint, 3))
    this.far = new THREE.InstancedMesh(geo, this.farMaterial, count)
    this.far.frustumCulled = false
    this.far.name = 'town-far'
    const m = new THREE.Matrix4()
    const tmp = new THREE.Matrix4()
    for (const [i, town] of towns.entries()) for (const b of town.buildings) {
      const base = b.y + b.plan.plinthBottom
      for (const ms of b.plan.masses) {
        const top = b.y + (ms.roof.kind === 'lean' ? ms.roof.highY : ms.roof.ridgeY)
        const along = ms.ridgeAxis === 'z' ? ms.d : ms.w
        const across = ms.ridgeAxis === 'z' ? ms.w : ms.d
        m.makeRotationY(b.yaw).setPosition(b.x, base, b.z)
        m.multiply(tmp.makeTranslation(ms.cx, 0, ms.cz))
        if (ms.ridgeAxis === 'z') m.multiply(tmp.makeRotationY(Math.PI / 2))
        m.multiply(tmp.makeScale(along, top - base, across))
        const r = ROOF_TINT[b.plan.roofKind]
        this.sites[i].masses.push({ matrix: m.clone(), roof: new THREE.Color(r[0], r[1], r[2]), wall: WALL_TINT[b.plan.style] })
      }
    }
    this.far.count = 0
    this.far.setColorAt(0, new THREE.Color())
    scene.add(this.far)

    this.grid = new Map()
    for (const b of this.buildings) {
      const r = Math.hypot(b.box.hx, b.box.hz)
      for (let gx = Math.floor((b.box.x - r) / CELL); gx <= Math.floor((b.box.x + r) / CELL); gx++) {
        for (let gz = Math.floor((b.box.z - r) / CELL); gz <= Math.floor((b.box.z + r) / CELL); gz++) {
          const key = `${gx},${gz}`
          if (!this.grid.has(key)) this.grid.set(key, [])
          this.grid.get(key).push(b)
        }
      }
    }
    this.stats = { towns: towns.length, buildings: this.buildings.length, instances: count, farShown: 0, nearTris: 0, builds: 0, buildMs: 0, merges: 0 }
  }

  // Each town's tier by the distance from (x, z) to its edge, its tiers' buildings placed under the frame budget, and a tier shown only once all of it is merged.
  update(x, z) {
    const B = TOWN_BANDS
    const H = B.hysteresis
    const t0 = performance.now()
    let heavy = false
    let farDirty = false
    for (const s of this.sites) {
      const d = Math.max(0, Math.hypot(s.town.x - x, s.town.z - z) - s.town.radius)
      s.want = d < B.near + (s.want === 2 ? H : -H) ? 2 : d < B.mid + (s.want > 0 ? H : -H) ? 1 : 0
      if (d > B.evict) this._evict(s)
      else if (s.geo[1] === null && d < B.prebuild) heavy = this._grow(s, 1, t0, heavy)
      else if (s.geo[2] === null && s.want > 0) heavy = this._grow(s, 2, t0, heavy)
      const tier = s.want === 2 && s.geo[2] !== null ? 2 : s.want > 0 && s.geo[1] !== null ? 1 : 0
      if (tier !== s.tier) this._show(s, tier)
      const shown = tier === 0 && d < B.far + (s.farShown ? H : -H)
      if (shown !== s.farShown) {
        s.farShown = shown
        farDirty = true
      }
    }
    if (farDirty) this._packFar()
  }

  // Places the town's next buildings at `detail` while the budget lasts (detail 2: one a frame across all towns), and merges the tier once the last is placed. Returns whether a detail-2 building was placed this frame.
  _grow(s, detail, t0, heavy) {
    const parts = s.parts[detail]
    const list = s.town.buildings
    while (parts.length < list.length && performance.now() - t0 < BUILD_MS) {
      if (detail === 2) {
        if (heavy) break
        heavy = true
      }
      const t1 = performance.now()
      parts.push(placedArrays(list[parts.length], s.town, detail))
      this.stats.builds++
      this.stats.buildMs += performance.now() - t1
    }
    if (parts.length === list.length) {
      s.geo[detail] = mergeParts(parts)
      s.parts[detail] = []
      this.stats.merges++
    }
    return heavy
  }

  _show(s, tier) {
    if (s.tier > 0) this.stats.nearTris -= s.mesh.geometry.userData.tris
    s.tier = tier
    if (tier === 0) {
      this.scene.remove(s.mesh)
      return
    }
    if (s.mesh === null) {
      s.mesh = new THREE.Mesh(s.geo[tier], this.material)
      s.mesh.name = `town-near-${s.town.id}`
      s.mesh.position.set(s.town.x, 0, s.town.z)
    }
    s.mesh.geometry = s.geo[tier]
    if (s.mesh.parent === null) this.scene.add(s.mesh)
    this.stats.nearTris += s.geo[tier].userData.tris
  }

  // Past evict, which lies outside mid, so the town is already drawn far.
  _evict(s) {
    for (const detail of [1, 2]) {
      if (s.geo[detail] !== null) s.geo[detail].dispose()
      s.geo[detail] = null
      s.parts[detail] = []
    }
  }

  // The far boxes of every town showing them, packed to the front of the instance buffers. A town-level change is rare enough that rewriting about 1500 instances beats tracking slots.
  _packFar() {
    let k = 0
    for (const s of this.sites) {
      if (!s.farShown) continue
      for (const ms of s.masses) {
        this.far.setMatrixAt(k, ms.matrix)
        this.far.setColorAt(k, ms.roof)
        this.wallTint.set(ms.wall, k * 3)
        k++
      }
    }
    this.far.count = k
    this.far.instanceMatrix.needsUpdate = true
    this.far.instanceColor.needsUpdate = true
    this.far.geometry.getAttribute('aWallTint').needsUpdate = true
    this.stats.farShown = k
  }

  _cellAt(x, z) {
    return this.grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`)
  }

  // The building's solid over (x, z): [bottom, top] into out at span `at`, or false. Inside a mass's walls only, up to its roof there; eaves and porches are open to walk under.
  _span(b, x, z, out, at) {
    const dx = x - b.x
    const dz = z - b.z
    const c = Math.cos(b.yaw)
    const s = Math.sin(b.yaw)
    const lx = dx * c - dz * s
    const lz = dx * s + dz * c
    let top = -Infinity
    for (const m of b.plan.masses) {
      if (Math.abs(lx - m.cx) > m.w / 2 || Math.abs(lz - m.cz) > m.d / 2) continue
      top = Math.max(top, roofHeightAt(m.roof, lx, lz))
    }
    if (top === -Infinity) return false
    out[at * 2] = b.y + b.plan.plinthBottom
    out[at * 2 + 1] = b.y + top
    return true
  }

  // Stone to the walker (walk.js addStone): one span per building standing over (x, z).
  columnAt(x, z, _minSize, out) {
    const list = this._cellAt(x, z)
    if (list === undefined) return 0
    const cap = out.length >> 1
    let n = 0
    for (const b of list) {
      if (n >= cap) break
      if (this._span(b, x, z, out, n)) n++
    }
    return n
  }

  blockTopAt(x, z) {
    const list = this._cellAt(x, z)
    if (list === undefined) return -Infinity
    let top = -Infinity
    const s = this._scratch || (this._scratch = new Float32Array(2))
    for (const b of list) if (this._span(b, x, z, s, 0) && s[1] > top) top = s[1]
    return top
  }

  // Whether (x, z) is within about `r` of a building: its centre within r plus its half-diagonal. What keeps the wildlife out of town.
  nearBuildingAt(x, z, r) {
    for (const t of this.towns) {
      if ((x - t.x) ** 2 + (z - t.z) ** 2 > (t.radius + r) ** 2) continue
      for (const b of t.buildings) {
        if ((x - b.box.x) ** 2 + (z - b.box.z) ** 2 < (r + Math.hypot(b.box.hx, b.box.hz)) ** 2) return true
      }
    }
    return false
  }

  dispose() {
    for (const s of this.sites) {
      if (s.mesh !== null) this.scene.remove(s.mesh)
      this._evict(s)
    }
    this.scene.remove(this.far)
    this.far.geometry.dispose()
    this.material.dispose()
    this.farMaterial.dispose()
  }

  // The trees' `deadwood` contract (layers/towns.js townsOccupyAt).
  occupiesAt(x, z, pad) {
    return townsOccupyAt(this.towns, x, z, pad)
  }
}
