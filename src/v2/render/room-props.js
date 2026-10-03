import THREE from '../../three-instance.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { mulberry32 } from '../../sim/mathx.js'
import { createPropMaterial } from '../../material.js'
import { LAYER } from '../../textures.js'
import { buildHouse, rollHouse } from './house-exterior.js'

// ---------------------------------------------------------------------------
// A ROOM'S OWN PROPS (DESIGN.md §30, design/36-leafkin-houses.md): the huts of
// a leafkin village, seated where the room file says. Each is its own house,
// rolled from the glade's seed and built on entry (house-exterior.js), and all
// of them merge into one mesh in the prop material, drawn whole at every
// distance, with their window glass a second. Every one is stone to the walker
// in its own shape (a column table), so she walks up the roots, round the
// trunk and under the eaves. Its windows glow like the wall by day and amber
// after dark on the lamps' breath, and each throws a cone of light out of the
// wall through the lamp map (lamps.js).
// ---------------------------------------------------------------------------

// The house's box for village siting (village.js HUTS), as a fraction of its height: `r` is its half-width. Its trunk stands `DOOR.wall` of that out; its roots and eaves reach the rest.
export const HOUSE_BOUNDS = { halfX: 0.6, halfZ: 0.6, height: 1 }
export const DOOR = { wall: 0.7 }
// The glass by day, shaded near the wall's own colour, and after dark this tint at this gain.
export const GLOW = { day: [0x6a / 255, 0x5a / 255, 0x44 / 255], color: [1, 0.62, 0.28], night: 1.6 }
// Which of a house's columns are roof enough to grow something on (roofSpots): the topmost span's top stands over `high` of the house's height, inside its eave (not the awning), its four neighbours are roof within `step` cells of it and the slope they read is under `tilt` degrees. Seats stand `apart` of the house's radius from each other.
export const ROOF = { high: 0.5, step: 2, tilt: 60, apart: 0.25 }
// The column table's cell, in the house's own unit (its height): 0.24 m at the tallest house.
const CELL = 1 / 40
// Crossings one column may hold; the walker takes at most walk.js SPAN_CAP spans. A column crossing more is inside the carving (a crown's shards, a tower's walls): stone from its lowest crossing to its highest.
const CROSS_CAP = 12
const CROSS_EPS = 1e-3
// The posts (columnTable): faces whose normal's y is under `steep` of its length, climbing from `foot` cells to `tall` cells over the ground.
const POST = { steep: 0.5, foot: 2, tall: 8 }
// Layers the walker passes through: the ivy's leaf cards, and the shelf fungi and the ironwork's grit.
const SOFT = new Set([LAYER.IVY_LEAF, LAYER.ROCK_BUMP])
// Out from the door's face: where a villager's walk to the door ends past the lowest step, and the sill on the top step, where a villager stops and she stands coming back out. The door's own face is its frame's stone to the walker, a post as tall as the door.
const DOOR_OUT = 0.3, SILL = 0.3
// The stump to the walker (wallOutline): per bearing, the wall's least radius `lo`..`hi` metres over the ground, where her shoulders meet it. A vertical wall crosses no column and its flare is too shallow for a post to climb, so without this she walks through the bark into the hollow.
const WALL = { bins: 32, lo: 0.8, hi: 1.9 }

/** House-space `geo`'s wall radius in metres at WALL.bins bearings round +Y, bin 0 at +X, from its solid vertices WALL's band over `ground` (the floor's depth under it). */
function wallOutline(geo, ground) {
  const pos = geo.attributes.position.array, layer = geo.attributes.texLayer.array
  const r = new Float32Array(WALL.bins).fill(Infinity)
  for (let v = 0; v < pos.length / 3; v++) {
    const y = pos[v * 3 + 1] - ground
    if (y < WALL.lo || y > WALL.hi || SOFT.has(layer[v])) continue
    const x = pos[v * 3], z = pos[v * 3 + 2], b = Math.round(((Math.atan2(z, x) / (2 * Math.PI)) + 1) * WALL.bins) % WALL.bins
    r[b] = Math.min(r[b], Math.hypot(x, z))
  }
  // A bearing with no vertex in the band is the doorway (its leaf is one quad): the outline across it is drawn between the jambs.
  const held = [...r.keys()].filter((b) => r[b] !== Infinity)
  if (held.length < WALL.bins * 0.75) throw new Error(`RoomProps: a house has wall at shoulder height on only ${held.length} of ${WALL.bins} bearings`)
  const out = r.slice()
  for (let b = 0; b < WALL.bins; b++) {
    if (r[b] !== Infinity) continue
    let lo = 1, hi = 1
    while (r[(b - lo + WALL.bins) % WALL.bins] === Infinity) lo++
    while (r[(b + hi) % WALL.bins] === Infinity) hi++
    out[b] = (r[(b - lo + WALL.bins) % WALL.bins] * hi + r[(b + hi) % WALL.bins] * lo) / (lo + hi)
  }
  return out
}

/**
 * The column table of `geo`'s solid faces, divided by `unit` (the shape of
 * Shell._table): over its plan at CELL, per cell the spans of stone on the
 * vertical line through its centre, lowest first. A face looking down is the
 * underside of stone and a face looking up its top, read from the bottom up:
 * an underside opens a span, the next top closes it, and a top met with no
 * underside open is a cloth a cell thick (the roof and the awning are single
 * sheets). Closing that top from the crossing under it instead would stand a
 * wall from the step to the awning. With `wall` ({ r: wallOutline, top, door,
 * soft } in metres), every cell inside the outline is stone from the floor to
 * `top`, no post stands on the stoop before `door` (buildHouse's), whose cells
 * also take in the door's face, and the `soft` run of the index (the awning)
 * is passed through: its sagging tip is within a step of the road, and as stone
 * it is a ramp walked up onto the hood over the door.
 */
export function columnTable(geo, unit = 1, wall = null) {
  const src = geo.attributes.position.array, layer = geo.attributes.texLayer.array, all = geo.index.array
  const pos = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) pos[i] = src[i] / unit
  const [soft0, soft1] = wall === null ? [0, 0] : wall.soft
  const idx = all.filter((_, t) => !SOFT.has(layer[all[t - (t % 3)]]) && !(t >= soft0 && t < soft1))
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const v of idx) { const x = pos[v * 3], z = pos[v * 3 + 2]; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z) }
  const x0 = minX - CELL, z0 = minZ - CELL
  const nx = Math.ceil((maxX - minX) / CELL) + 3, nz = Math.ceil((maxZ - minZ) / CELL) + 3
  const cross = new Float32Array(nx * nz * CROSS_CAP)
  const up = new Int8Array(nx * nz * CROSS_CAP)
  const count = new Uint8Array(nx * nz)
  const loY = new Float32Array(nx * nz).fill(Infinity), hiY = new Float32Array(nx * nz).fill(-Infinity), over = new Uint8Array(nx * nz)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2]
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2]
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2]
    // A counter-clockwise front's normal has y = -det.
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az)
    if (Math.abs(det) < 1e-12) continue
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / CELL - 0.5)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / CELL - 0.5))
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / CELL - 0.5)), j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) - z0) / CELL - 0.5))
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) * CELL
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * CELL
        const wb = ((px - ax) * (cz - az) - (cx - ax) * (pz - az)) / det
        const wc = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / det
        const wa = 1 - wb - wc
        if (wa < 0 || wb < 0 || wc < 0) continue
        const y = wa * ay + wb * by + wc * cy
        const k = j * nx + i, n = count[k]
        loY[k] = Math.min(loY[k], y); hiY[k] = Math.max(hiY[k], y)
        let dup = false
        for (let q = 0; q < n && !dup; q++) dup = Math.abs(cross[k * CROSS_CAP + q] - y) < CROSS_EPS
        if (dup) continue
        if (n >= CROSS_CAP) { over[k] = 1; continue }
        cross[k * CROSS_CAP + n] = y
        up[k * CROSS_CAP + n] = det < 0 ? 1 : -1
        count[k] = n + 1
      }
    }
  }
  // The spans, written over the crossings as pairs, lowest first.
  const spans = new Uint8Array(nx * nz)
  const order = new Int32Array(CROSS_CAP)
  for (let k = 0; k < nx * nz; k++) {
    const n = count[k]
    if (n === 0) continue
    const base = k * CROSS_CAP
    if (over[k]) { cross[base] = loY[k]; cross[base + 1] = hiY[k]; spans[k] = 1; continue }
    for (let q = 0; q < n; q++) order[q] = q
    const o = order.subarray(0, n)
    o.sort((p, q) => cross[base + p] - cross[base + q])
    const ys = Array.from(o, (q) => cross[base + q]), tops = Array.from(o, (q) => up[base + q] > 0)
    let m = 0, open = null
    for (let q = 0; q < n; q++) {
      if (!tops[q]) { if (open === null) open = ys[q] }
      else if (m < CROSS_CAP / 2) { cross[base + m * 2] = open ?? ys[q] - CELL; cross[base + m * 2 + 1] = ys[q]; m++; open = null }
    }
    spans[k] = m
  }
  // The posts: a vertical line through a wall or a pole crosses none of its faces. Its steep faces, taken lowest first, climb each cell whose centre lies within half a cell of their plan from within `foot` cells of the ground for as long as each starts under the reach so far; a climb `tall` cells high is stone from the ground to its top.
  const steep = []
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2]
    const ny = uz * vx - ux * vz
    if (Math.abs(ny) > POST.steep * Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx)) continue
    steep.push(t)
  }
  const low = (t) => Math.min(pos[idx[t] * 3 + 1], pos[idx[t + 1] * 3 + 1], pos[idx[t + 2] * 3 + 1])
  steep.sort((p, q) => low(p) - low(q))
  const reach = new Float32Array(nx * nz).fill(POST.foot * CELL)
  if (wall) {
    const d = wall.door, n = Math.hypot(d.n[0], d.n[2]), dx = d.n[0] / n, dz = d.n[2] / n
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const rx = (x0 + (i + 0.5) * CELL) * unit - d.p[0], rz = (z0 + (j + 0.5) * CELL) * unit - d.p[2], o = rx * dx + rz * dz
      if (o > 0 && o < d.steps && Math.abs(rz * dx - rx * dz) < d.w / 2) reach[j * nx + i] = -Infinity
    }
  }
  for (const t of steep) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const lo = low(t), hi = Math.max(pos[a + 1], pos[b + 1], pos[c + 1])
    const i0 = Math.max(0, Math.floor((Math.min(pos[a], pos[b], pos[c]) - x0) / CELL)), i1 = Math.min(nx - 1, Math.floor((Math.max(pos[a], pos[b], pos[c]) - x0) / CELL))
    const j0 = Math.max(0, Math.floor((Math.min(pos[a + 2], pos[b + 2], pos[c + 2]) - z0) / CELL)), j1 = Math.min(nz - 1, Math.floor((Math.max(pos[a + 2], pos[b + 2], pos[c + 2]) - z0) / CELL))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (!(lo <= reach[j * nx + i] && hi > reach[j * nx + i])) continue
      const px = x0 + (i + 0.5) * CELL, pz = z0 + (j + 0.5) * CELL
      if (Math.min(planDist(px, pz, pos[a], pos[a + 2], pos[b], pos[b + 2]), planDist(px, pz, pos[b], pos[b + 2], pos[c], pos[c + 2]), planDist(px, pz, pos[c], pos[c + 2], pos[a], pos[a + 2])) > CELL / 2) continue
      reach[j * nx + i] = hi
    }
  }
  for (let k = 0; k < nx * nz; k++) if (reach[k] >= POST.tall * CELL) spans[k] = mergeSpan(cross, k * CROSS_CAP, spans[k], 0, reach[k])
  if (wall) {
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * CELL, z = z0 + (j + 0.5) * CELL
      const f = ((Math.atan2(z, x) / (2 * Math.PI)) + 1) * WALL.bins, b = Math.floor(f) % WALL.bins, t = f - Math.floor(f)
      const r = (wall.r[b] * (1 - t) + wall.r[(b + 1) % WALL.bins] * t) / unit
      if (x * x + z * z < r * r) spans[j * nx + i] = mergeSpan(cross, (j * nx + i) * CROSS_CAP, spans[j * nx + i], 0, wall.top / unit)
    }
  }
  return { x0, z0, nx, nz, cross, spans }
}

/** The plan distance from (px, pz) to the segment (ax, az)-(bx, bz). */
function planDist(px, pz, ax, az, bx, bz) {
  const ux = bx - ax, uz = bz - az, len2 = ux * ux + uz * uz
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ux + (pz - az) * uz) / len2)) : 0
  return Math.hypot(px - ax - ux * t, pz - az - uz * t)
}

/** The `n` spans at `base` with [lo, hi] made stone too, overlapping ones merged, lowest first: how many now. Past CROSS_CAP's spans the column is stone from its lowest to its highest, as columnTable's overflow is. */
function mergeSpan(cross, base, n, lo, hi) {
  const out = []
  for (let q = 0; q < n; q++) {
    const b = cross[base + q * 2], t = cross[base + q * 2 + 1]
    if (t < lo || b > hi) out.push([b, t])
    else { lo = Math.min(lo, b); hi = Math.max(hi, t) }
  }
  out.push([lo, hi])
  out.sort((p, q) => p[0] - q[0])
  if (out.length > CROSS_CAP / 2) out.splice(0, out.length, [out[0][0], Math.max(...out.map((s) => s[1]))])
  for (let q = 0; q < out.length; q++) { cross[base + q * 2] = out[q][0]; cross[base + q * 2 + 1] = out[q][1] }
  return out.length
}

export class RoomProps {
  /**
   * @param field  V2Height: heightAt
   * @param opts.props  `[{ x, z, yaw, height, fiddle, sink }]`, metres and radians. Required.
   * @param opts.clearing  `{ x, z, r }`: the disc the wood keeps off, with the huts. Required.
   * @param opts.seed  the glade's seed; house k is rolled off it. Required.
   * @param opts.textures  the prop atlas (DataArrayTexture). Required.
   * @param opts.glowMap  the window glass's texture, owned from here on. Required.
   * @param opts.patch  (material, cacheKey) => material, the lighting patch. Required.
   */
  constructor(scene, field, { props = null, clearing = null, seed = null, textures = null, glowMap = null, patch = null } = {}) {
    if (!field || typeof field.heightAt !== 'function') throw new Error('RoomProps: needs a V2Height with heightAt')
    if (!Array.isArray(props) || props.some((p) => ![p.x, p.z, p.yaw, p.height].every(Number.isFinite) || !(p.height > 0) || !(p.sink >= 0) || typeof p.fiddle !== 'boolean')) {
      throw new Error('RoomProps: `props` is a list of { x, z, yaw, height, fiddle, sink }')
    }
    if (!clearing || ![clearing.x, clearing.z, clearing.r].every(Number.isFinite) || !(clearing.r > 0)) throw new Error('RoomProps: `clearing` is { x, z, r }')
    if (!Number.isInteger(seed)) throw new Error('RoomProps: needs the glade\'s integer seed')
    if (!textures || !textures.image) throw new Error('RoomProps: needs the prop atlas')
    if (!glowMap || !glowMap.isTexture) throw new Error('RoomProps: needs the window glass texture')
    if (typeof patch !== 'function') throw new Error('RoomProps: needs the lighting patch')
    this.clearing = { ...clearing }
    this.field = field
    this._cross = new Float32Array(CROSS_CAP)
    const rand = mulberry32(seed)
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1)
    const solid = [], glass = []
    // Per prop: its floor's point, its yaw, its height (`scale`, the table's unit), `sink`, its siting radius `r`, the plan radius its mesh reaches, its top, its door, its windows, its eave and trunk radii, and whether a fiddle plays inside. `y` is the floor, the ground under the house less its `sink`.
    this.props = props.map(({ x, z, yaw, height, fiddle, sink }) => {
      const built = buildHouse(rollHouse(Math.floor(rand() * 2 ** 31), height))
      const table = columnTable(built.geometry, height, { r: wallOutline(built.geometry, sink), top: built.trunk.top, door: built.door, soft: built.awning })
      const y = field.heightAt(x, z) - sink
      m.compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(up, yaw), one)
      solid.push(built.geometry.applyMatrix4(m))
      glass.push(built.glow.applyMatrix4(m))
      const c = Math.cos(yaw), sn = Math.sin(yaw)
      const at = (p) => ({ x: x + p[0] * c + p[2] * sn, y: y + p[1], z: z - p[0] * sn + p[2] * c })
      const way = (n) => { const len = Math.hypot(n[0], n[2]); return { dx: (n[0] * c + n[2] * sn) / len, dz: (-n[0] * sn + n[2] * c) / len } }
      const d = built.door
      return {
        x, y, z, yaw, height, scale: height, sink, fiddle, table,
        r: HOUSE_BOUNDS.halfX * height, reach: built.reach, top: y + built.top,
        eave: built.eave.r, trunk: built.trunk.r,
        door: { ...at(d.p), ...way(d.n), sill: d.sill, steps: d.steps, landing: d.landing },
        windows: built.windows.map((w) => ({ ...at(w.p), ...way(w.n) })),
      }
    })
    this.material = patch(createPropMaterial(textures, { vertexColors: true }), 'v2-houses')
    this.geometry = mergeGeometries(solid, false)
    this.glowGeometry = mergeGeometries(glass, false)
    for (const g of [...solid, ...glass]) g.dispose()
    glowMap.colorSpace = THREE.SRGBColorSpace
    this.glowMaterial = new THREE.MeshBasicMaterial({ map: glowMap })
    this.setGlow(0)
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.name = 'v2-houses'
    this.glowMesh = new THREE.Mesh(this.glowGeometry, this.glowMaterial)
    this.glowMesh.name = 'v2-house-glass'
    scene.add(this.mesh, this.glowMesh)
  }

  /** Where each prop's door is, on the ground past its steps, and its sill on the top step: `[{ x, z, sill: { x, z } }]`. */
  doors() {
    return this.props.map(({ door: d }) => ({
      x: d.x + d.dx * (d.steps + DOOR_OUT), z: d.z + d.dz * (d.steps + DOOR_OUT),
      sill: { x: d.x + d.dx * SILL, z: d.z + d.dz * SILL },
    }))
  }

  /** Each house's doorway, on the face of its door at its sill's height `y`, with the way out and the house's height, for going inside, and where she stands on the top step coming back out: `[{ k, x, y, z, nx, nz, height, back: { x, y, z } }]`. */
  entries() {
    return this.props.map((h, k) => {
      const d = h.door, y = h.y + d.sill
      return { k, x: d.x, y, z: d.z, nx: d.dx, nz: d.dz, height: h.height, back: { x: d.x + d.dx * SILL, y: h.y + d.landing, z: d.z + d.dz * SILL } }
    })
  }

  /** The houses with a fiddler inside, each its floor and its trunk's radius: `[{ x, y, z, r }]`, for the ambience. */
  fiddlers() {
    return this.props.filter((h) => h.fiddle).map((h) => ({ x: h.x, y: h.y, z: h.z, r: h.trunk }))
  }

  /** Every window in the world, with the way it faces out of the wall: `[{ x, y, z, dx, dz }]`, for the lamp map. */
  windows() {
    return this.props.flatMap((h) => h.windows.map((w) => ({ ...w })))
  }

  /** How unlit the panes are this frame: `breath` the lamps' mean glow, 0 by day (Lamps.breath), when they shade like the wall. */
  setGlow(breath) {
    const k = (i) => GLOW.day[i] + (GLOW.color[i] * GLOW.night - GLOW.day[i]) * breath
    this.glowMaterial.color.setRGB(k(0), k(1), k(2))
  }

  /**
   * Up to `count` seats for something growing on prop `i`'s roof, in world
   * metres: `[{ x, y, z }]`, each on the roof's own skin. ROOF says which of its
   * columns are roof at all; the seats are drawn from those off `rand` (the
   * village's own roll, so a seed's roofs are its own), each ROOF.apart of the
   * house's radius clear of the ones before it. A roof with no room left seats
   * fewer than asked.
   */
  roofSpots(i, count, rand) {
    const h = this.props[i]
    if (!h) throw new Error(`RoomProps: no prop ${i} to sit on`)
    const cells = this._roofCells(h)
    const c = Math.cos(h.yaw), sn = Math.sin(h.yaw), apart = h.r * ROOF.apart
    const out = []
    for (let t = 0; t < count * 8 && out.length < count; t++) {
      const cell = cells[Math.floor(rand() * cells.length)]
      const a = cell.x * h.scale, b = cell.z * h.scale
      const x = h.x + a * c + b * sn, z = h.z - a * sn + b * c
      if (out.some((p) => Math.hypot(p.x - x, p.z - z) < apart)) continue
      out.push({ x, y: h.y + cell.y * h.scale, z })
    }
    return out
  }

  /** House `h`'s roof cells (ROOF) in its own frame and unit, `[{ x, y, z }]` at their centres. */
  _roofCells(h) {
    if (h.roof) return h.roof
    const g = h.table
    const tilt = Math.tan((ROOF.tilt * Math.PI) / 180), eave = h.eave / h.scale, high = (ROOF.high * (h.top - h.y)) / h.scale
    const topAt = (ii, jj) => {
      if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.nz) return null
      const k = jj * g.nx + ii, n = g.spans[k]
      return n === 0 ? null : g.cross[k * CROSS_CAP + n * 2 - 1]
    }
    const out = []
    for (let j = 0; j < g.nz; j++) {
      for (let i = 0; i < g.nx; i++) {
        const top = topAt(i, j), x = g.x0 + (i + 0.5) * CELL, z = g.z0 + (j + 0.5) * CELL
        if (top === null || top < high || Math.hypot(x, z) > eave) continue
        const w = topAt(i - 1, j), e = topAt(i + 1, j), s = topAt(i, j - 1), n = topAt(i, j + 1)
        if (![w, e, s, n].every((q) => q !== null && Math.abs(q - top) <= ROOF.step * CELL)) continue
        if (Math.hypot(e - w, n - s) / (2 * CELL) > tilt) continue
        out.push({ x, y: top, z })
      }
    }
    if (out.length === 0) throw new Error('RoomProps: a house has no roof flat enough to seat a fern')
    h.roof = out
    return out
  }

  /** Whether (x, z) is within `pad` of the clearing or a hut's reach: the trees' `deadwood` contract, so the wood stops at the village. */
  occupiesAt(x, z, pad) {
    const c = this.clearing
    const cx = x - c.x, cz = z - c.z, cr = c.r + pad
    if (cx * cx + cz * cz < cr * cr) return true
    for (const h of this.props) {
      const dx = x - h.x, dz = z - h.z, r = h.reach + pad
      if (dx * dx + dz * dz < r * r) return true
    }
    return false
  }

  // -- stone to the walker (walk.js addStone) ---------------------------------

  /**
   * The prop's spans of stone on the vertical line through (x, z), in metres,
   * into `out` from span `at` up to `cap` spans in all: how many. The table is
   * read in the house's frame -- the point turned back by the yaw, over its
   * height -- bilinearly where the four cells about it hold as many spans as
   * each other, the nearest cell's where they do not.
   */
  _spansAt(h, x, z, out, at, cap) {
    const c = Math.cos(h.yaw), sn = Math.sin(h.yaw)
    const wx = x - h.x, wz = z - h.z
    const px = (wx * c - wz * sn) / h.scale, pz = (wx * sn + wz * c) / h.scale
    const g = h.table, cross = g.cross, spans = g.spans
    const fx = (px - g.x0) / CELL - 0.5, fz = (pz - g.z0) / CELL - 0.5
    const i = Math.floor(fx), j = Math.floor(fz)
    const spansAt = (ii, jj) => (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.nz ? -1 : spans[jj * g.nx + ii])
    let n = spansAt(i, j)
    if (n > 0 && spansAt(i + 1, j) === n && spansAt(i, j + 1) === n && spansAt(i + 1, j + 1) === n) {
      n = Math.min(n, cap - at)
      const tx = fx - i, tz = fz - j
      const k00 = (j * g.nx + i) * CROSS_CAP, k10 = k00 + CROSS_CAP, k01 = k00 + g.nx * CROSS_CAP, k11 = k01 + CROSS_CAP
      for (let q = 0; q < n * 2; q++) {
        out[at * 2 + q] = h.y + ((cross[k00 + q] * (1 - tx) + cross[k10 + q] * tx) * (1 - tz) + (cross[k01 + q] * (1 - tx) + cross[k11 + q] * tx) * tz) * h.scale
      }
      return n
    }
    const ni = Math.round(fx), nj = Math.round(fz)
    n = Math.min(spansAt(ni, nj), cap - at)
    if (n <= 0) return 0
    const k = (nj * g.nx + ni) * CROSS_CAP
    for (let q = 0; q < n * 2; q++) out[at * 2 + q] = h.y + cross[k + q] * h.scale
    return n
  }

  columnAt(x, z, _minSize, out) {
    const cap = out.length >> 1
    let n = 0
    for (const h of this.props) {
      if (n >= cap) break
      const dx = x - h.x, dz = z - h.z
      if (dx * dx + dz * dz > h.reach * h.reach) continue
      n += this._spansAt(h, x, z, out, n, cap)
    }
    return n
  }

  /** The highest stone over (x, z): a roof, the back of a root. */
  blockTopAt(x, z) {
    let top = -Infinity
    const c = this._cross
    for (const h of this.props) {
      const dx = x - h.x, dz = z - h.z
      if (dx * dx + dz * dz > h.reach * h.reach) continue
      const n = this._spansAt(h, x, z, c, 0, CROSS_CAP >> 1)
      if (n > 0 && c[n * 2 - 1] > top) top = c[n * 2 - 1]
    }
    return top
  }

  /**
   * Whether any prop's mesh stands out of the ground over (x, z), or over a
   * point within `pad` of it: a roof, a wall, a step, a root (a root's tip runs
   * on under the grass, and that is not over it). The columns are read at the point and at
   * four round it, which is what `pad` buys -- a root arching over a gap thinner
   * than the grid (CELL) is missed either way, and the gardens (village.js
   * weedGardens) only need the rows to miss the wood, not the shadow of it.
   */
  rootedAt(x, z, pad = 0) {
    const over = (px, pz) => this.blockTopAt(px, pz) > this.field.heightAt(px, pz)
    if (over(x, z)) return true
    if (!(pad > 0)) return false
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2
      if (over(x + Math.cos(a) * pad, z + Math.sin(a) * pad)) return true
    }
    return false
  }

  get stats() {
    return { placed: this.props.length, tris: this.geometry.index.count / 3 }
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh)
    this.glowMesh.parent?.remove(this.glowMesh)
    this.geometry.dispose()
    this.glowGeometry.dispose()
    this.material.dispose()
    this.glowMaterial.map.dispose()
    this.glowMaterial.dispose()
  }
}
