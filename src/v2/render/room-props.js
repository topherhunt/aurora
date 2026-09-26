import THREE from '../../three-instance.js'

import { GEN_PROP_LODS, PROP_STEPS, createGenPropMaterial, ladderTris, loadGenProp } from './gen-props.js'
import { LOD_DEG, distAt, ladderTier } from './critters.js'
import { PropArena } from './prop-arena.js'

// ---------------------------------------------------------------------------
// A ROOM'S OWN PROPS (DESIGN.md §30): the huts of a leafkin village, seated
// where the room file says rather than scattered. One shipped ladder, a few
// dozen instances at most, each `height` metres tall on the ground at its
// point, facing `yaw`, half of them the pick's mirror image; re-runged by
// distance on the props' steps with the shipped T3 in the card's place, like
// the entrances' arch. Every one is stone to the walker in the pick's own
// shape (a column table off its finest tier), so she walks up the roots,
// round the trunk and under the eaves, and onto a roof only where its eave
// stands within her reach. Its windows glow from inside (gen-props.js
// addGlow) at WINDOWS, shaded like the wall by day and amber after dark on
// the lamps' breath, and each throws a cone of light out of the wall through
// the lamp map (lamps.js).
// ---------------------------------------------------------------------------

export const HOUSE_GLB = 'gen-props/house-leafkin.glb'
// Shipped tiers drawn, in rung order, on PROP_STEPS.
export const TIERS = [0, 2, 3]
// Which way the pick's door faces, in its own frame: +X at yaw 0. The trunk's
// wall under it stands `wall` of the box's half-width out; the roots and the
// eaves reach the rest (village.js HUTS packs the trunks). Two steps up from the
// ground, the landing meets the door `sill` out, in the pick's unit, and the door's
// `face` (measured through the walker's columns).
export const DOOR = { x: 1, z: 0, wall: 0.7, sill: 0.235, face: 0.227 }
// The windows, in the shipped pick's frame (its raw vertices over their feet,
// Tripo's node yaw dropped by ship.mjs), placed in the /gen-prop viewer's glow
// points table: r the disc each lights and (nx, nz) the way the pane faces.
// A mirrored house's are these with z and nz negated.
export const WINDOWS = [
  { x: 0.038, y: 0.3, z: -0.138, r: 0.07, nx: 0.472, nz: -0.882 },
  { x: -0.136, y: 0.706, z: -0.097, r: 0.025, nx: 0.99, nz: 0.142 },
]
// After dark the pane's own colour is drawn unlit (gen-props.js addGlow) times this tint at this gain.
export const GLOW = { color: [1, 0.62, 0.28], night: 1.6 }
const POOL = 32
// Which of the pick's columns are roof enough to grow something on (roofSpots).
// The topmost span's top must stand over `high` of the pick's height (not a
// root's back, the landing or the step), that span must be over `thick` cells
// through (the awning is one cloth, closed a cell thick by columnTable), its
// four neighbours must be roof within `step` cells of it (so the seat is not
// the last cell of an eave, nor astride the ridge) and the slope they read must
// be under `tilt` degrees. Seats stand `apart` of the house's own radius from
// each other, so they scale with the house.
export const ROOF = { high: 0.5, thick: 1.5, step: 2, tilt: 45, apart: 0.3 }
// The column table's cell, in the pick's unit: 0.24 m at the tallest house.
const CELL = 1 / 40
// Crossings one column may hold; the walker takes at most walk.js SPAN_CAP spans.
const CROSS_CAP = 12
const CROSS_EPS = 1e-3
// The posts (columnTable): faces whose normal's y is under `steep` of its length, climbing from `foot` cells to `tall` cells over the ground.
const POST = { steep: 0.5, foot: 2, tall: 8 }

/** The bank from a shipped ladder (loadGenProp): the drawn tiers, each with its mirror image, the pick's box, and its column table. */
export function propBankFrom(ladder) {
  if (!ladder || ladder.geometries.length !== GEN_PROP_LODS + 1) {
    throw new Error(`RoomProps: the ladder has ${ladder?.geometries?.length ?? 0} tiers, expected ${GEN_PROP_LODS + 1}`)
  }
  const geometries = TIERS.map((t) => ladder.geometries[t])
  return { tiers: geometries.map((g) => ({ geometries: [g, mirrored(g)] })), tris: ladderTris(geometries), bounds: ladder.bounds, map: ladder.map, table: columnTable(geometries[0]) }
}

/** The geometry's mirror image across z = 0: z negated on every vertex and normal, the winding turned so the front face stays the front (a negative scale on the instance would flip it). */
function mirrored(geo) {
  const g = geo.clone()
  const pos = g.attributes.position.array
  for (let i = 2; i < pos.length; i += 3) pos[i] = -pos[i]
  const nrm = g.attributes.normal.array
  for (let i = 2; i < nrm.length; i += 3) nrm[i] = -nrm[i]
  const idx = g.index.array
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t }
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

/**
 * The pick's column table (the shape of Shell._table): over its plan at CELL,
 * per cell the spans of stone on the vertical line through its centre, in the
 * pick's unit, lowest first. A face looking down is the underside of stone and
 * a face looking up its top, read from the bottom up: an underside opens a
 * span, the next top closes it, and a top met with no underside open is a
 * cloth a cell thick (the awning and the roof's skirt have faces looking up
 * alone). Closing that top from the crossing under it instead stood a wall
 * from the porch's step to the awning. So a root is stone from the ground to
 * its back, and the eaves and the awning are stone with open air under them.
 */
export function columnTable(geo) {
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const x0 = bb.min.x - CELL, z0 = bb.min.z - CELL
  const nx = Math.ceil((bb.max.x - bb.min.x) / CELL) + 3, nz = Math.ceil((bb.max.z - bb.min.z) / CELL) + 3
  const cross = new Float32Array(nx * nz * CROSS_CAP)
  const up = new Int8Array(nx * nz * CROSS_CAP)
  const count = new Uint8Array(nx * nz)
  const pos = geo.attributes.position.array, idx = geo.index.array
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
        let dup = false
        for (let q = 0; q < n && !dup; q++) dup = Math.abs(cross[k * CROSS_CAP + q] - y) < CROSS_EPS
        if (dup) continue
        if (n >= CROSS_CAP) throw new Error(`RoomProps: ${CROSS_CAP} crossings on the column at ${px.toFixed(2)}, ${pz.toFixed(2)}`)
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
  // The posts: a vertical line through a pole thinner than a cell crosses none of its faces. Its steep faces, taken lowest first, climb each cell their plan touches from within `foot` cells of the ground for as long as each starts under the reach so far; a climb `tall` cells high is stone from the ground to its top.
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
  for (const t of steep) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const lo = low(t), hi = Math.max(pos[a + 1], pos[b + 1], pos[c + 1])
    const i0 = Math.max(0, Math.floor((Math.min(pos[a], pos[b], pos[c]) - x0) / CELL)), i1 = Math.min(nx - 1, Math.floor((Math.max(pos[a], pos[b], pos[c]) - x0) / CELL))
    const j0 = Math.max(0, Math.floor((Math.min(pos[a + 2], pos[b + 2], pos[c + 2]) - z0) / CELL)), j1 = Math.min(nz - 1, Math.floor((Math.max(pos[a + 2], pos[b + 2], pos[c + 2]) - z0) / CELL))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (lo <= reach[j * nx + i] && hi > reach[j * nx + i]) reach[j * nx + i] = hi
  }
  for (let k = 0; k < nx * nz; k++) if (reach[k] >= POST.tall * CELL) spans[k] = mergeSpan(cross, k * CROSS_CAP, spans[k], 0, reach[k])
  return { x0, z0, nx, nz, cross, spans }
}

/** The `n` spans at `base` with [lo, hi] made stone too, overlapping ones merged, lowest first: how many now. */
function mergeSpan(cross, base, n, lo, hi) {
  const out = []
  for (let q = 0; q < n; q++) {
    const b = cross[base + q * 2], t = cross[base + q * 2 + 1]
    if (t < lo || b > hi) out.push([b, t])
    else { lo = Math.min(lo, b); hi = Math.max(hi, t) }
  }
  out.push([lo, hi])
  out.sort((p, q) => p[0] - q[0])
  if (out.length > CROSS_CAP / 2) throw new Error(`RoomProps: ${out.length} spans on one column`)
  for (let q = 0; q < out.length; q++) { cross[base + q * 2] = out[q][0]; cross[base + q * 2 + 1] = out[q][1] }
  return out.length
}

export async function loadHouseBank() {
  return propBankFrom(await loadGenProp(HOUSE_GLB))
}

export class RoomProps {
  /**
   * @param field  V2Height: heightAt
   * @param opts.bank  propBankFrom's answer. Required.
   * @param opts.props  `[{ x, z, yaw, height, mirror }]`, metres and radians. Required.
   * @param opts.clearing  `{ x, z, r }`: the disc the wood keeps off, with the huts. Required.
   */
  constructor(scene, field, { bank = null, props = null, clearing = null } = {}) {
    if (!bank || !Array.isArray(bank.tiers) || !bank.table) throw new Error('RoomProps: needs the bank from loadHouseBank (or propBankFrom)')
    if (!field || typeof field.heightAt !== 'function') throw new Error('RoomProps: needs a V2Height with heightAt')
    if (!Array.isArray(props) || props.some((p) => ![p.x, p.z, p.yaw, p.height].every(Number.isFinite) || !(p.height > 0) || !(p.sink >= 0) || typeof p.mirror !== 'boolean' || typeof p.fiddle !== 'boolean')) {
      throw new Error('RoomProps: `props` is a list of { x, z, yaw, height, mirror, fiddle, sink }')
    }
    if (props.length > POOL) throw new Error(`RoomProps: ${props.length} props, the pool holds ${POOL}`)
    if (!clearing || ![clearing.x, clearing.z, clearing.r].every(Number.isFinite) || !(clearing.r > 0)) throw new Error('RoomProps: `clearing` is { x, z, r }')
    this.clearing = { ...clearing }
    this.field = field
    this.bank = bank
    // One material a variant, the mirrored one's glow points mirrored with it (addGlow keys on the pick's own frame), one program between them. Both sides drawn until the mesh's holes are closed: the roof shows through them from above.
    this.materials = [WINDOWS, WINDOWS.map((w) => ({ ...w, z: -w.z }))].map((glow) => {
      const m = createGenPropMaterial({ glow })
      m.map = bank.map
      m.side = THREE.DoubleSide
      m.uGlow.value.setRGB(GLOW.color[0] * GLOW.night, GLOW.color[1] * GLOW.night, GLOW.color[2] * GLOW.night)
      return m
    })
    this.material = this.materials[0]
    this.setGlow(0)
    this.batch = new PropArena(POOL, bank.tiers, new Array(bank.tiers.length).fill(POOL), (t, v) => this.materials[v], 'v2-room-props')
    this.tierAt = new Int8Array(POOL).fill(-1)
    // Per prop: its floor's point, its yaw, its scale, `sink`, `mirror` -1 where it is the mirror image, its box's radius, its top and whether a fiddle plays inside. `y` is the floor, the ground under the house less its `sink`; the ground itself is `y + sink`.
    this.props = []
    this.tris = 0
    this._cross = new Float32Array(CROSS_CAP)
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    const b = bank.bounds
    for (const { x, z, yaw, height, mirror, fiddle, sink } of props) {
      const scale = height / b.height
      // Set `sink` metres into its own ground (village.js HUTS.sink). The pick's
      // floor sits at its origin, so this one y carries the whole house down with
      // it: its walk spans, its roof seats, its windows and its top.
      const y = field.heightAt(x, z) - sink
      const id = this.batch.addInstance(mirror ? 1 : 0)
      this.batch.setVisibleAt(id, false)
      q.setFromAxisAngle(up, yaw)
      this.batch.setMatrixAt(id, m.compose(p.set(x, y, z), q, s.setScalar(scale)))
      this.props.push({ id, x, y, z, yaw, scale, sink, mirror: mirror ? -1 : 1, r: Math.min(b.halfX, b.halfZ) * scale, top: y + height, size: b.lodSize * scale, base: distAt(b.lodSize * scale, LOD_DEG), fiddle })
    }
    scene.add(this.batch)
  }

  /** Where each prop's door is, on the ground a step out from its wall, and its sill atop the steps: `[{ x, z, sill: { x, z } }]`. */
  doors() {
    return this.props.map((h) => {
      const c = Math.cos(h.yaw), sn = Math.sin(h.yaw)
      const dz0 = DOOR.z * h.mirror
      const dx = DOOR.x * c + dz0 * sn
      const dz = -DOOR.x * sn + dz0 * c
      const out = h.r * DOOR.wall + 0.5, sill = h.scale * DOOR.sill
      return { x: h.x + dx * out, z: h.z + dz * out, sill: { x: h.x + dx * sill, z: h.z + dz * sill } }
    })
  }

  /** Each house's doorway, on the face of its door, with the way out and its height, for going inside: `[{ k, x, z, nx, nz, height }]`. */
  entries() {
    return this.props.map((h, k) => {
      const c = Math.cos(h.yaw), sn = Math.sin(h.yaw)
      const dz0 = DOOR.z * h.mirror
      const nx = DOOR.x * c + dz0 * sn, nz = -DOOR.x * sn + dz0 * c
      const face = h.scale * DOOR.face
      return { k, x: h.x + nx * face, z: h.z + nz * face, nx, nz, height: h.top - h.y }
    })
  }

  /** The houses with a fiddler inside, each its floor and its trunk's radius: `[{ x, y, z, r }]`, for the ambience. */
  fiddlers() {
    return this.props.filter((h) => h.fiddle).map((h) => ({ x: h.x, y: h.y, z: h.z, r: h.r * DOOR.wall }))
  }

  /** Every window in the world, with the way it faces out of the wall: `[{ x, y, z, dx, dz }]`, for the lamp map. */
  windows() {
    const out = []
    for (const h of this.props) {
      const c = Math.cos(h.yaw), sn = Math.sin(h.yaw)
      for (const w of WINDOWS) {
        const wz = w.z * h.mirror, wnz = w.nz * h.mirror
        const x = w.x * c + wz * sn, z = -w.x * sn + wz * c
        const dx = w.nx * c + wnz * sn, dz = -w.nx * sn + wnz * c
        const len = Math.hypot(dx, dz)
        if (!(len > 1e-3)) throw new Error('RoomProps: a window facing straight up or down lights no ground')
        out.push({ x: h.x + x * h.scale, y: h.y + w.y * h.scale, z: h.z + z * h.scale, dx: dx / len, dz: dz / len })
      }
    }
    return out
  }

  /** How unlit the panes are this frame: `breath` the lamps' mean glow, 0 by day (Lamps.breath), when they shade like the wall. */
  setGlow(breath) {
    for (const m of this.materials) m.uGlowOn.value = breath
  }

  /** Re-rung every prop by its distance. */
  update(camX, camY, camZ) {
    let tris = 0
    for (const h of this.props) {
      const ex = h.x - camX, ey = h.y + (h.top - h.y) / 2 - camY, ez = h.z - camZ
      const cur = this.tierAt[h.id]
      const tier = ladderTier(h.base, PROP_STEPS, TIERS.length, Math.sqrt(ex * ex + ey * ey + ez * ez), cur)
      if (tier !== cur) {
        this.tierAt[h.id] = tier
        const drawn = tier < TIERS.length
        this.batch.setVisibleAt(h.id, drawn)
        if (drawn) this.batch.setGeometryIdAt(h.id, tier * 2 + (h.mirror < 0 ? 1 : 0))
      }
      if (tier < TIERS.length) tris += this.bank.tris[tier]
    }
    this.tris = tris
  }

  /**
   * Up to `count` seats for something growing on prop `i`'s roof, in world
   * metres: `[{ x, y, z }]`, each on the roof's own skin. ROOF says which of the
   * pick's columns are roof at all; the seats are drawn from those off `rand`
   * (the village's own roll, so a seed's roofs are its own), each ROOF.apart of
   * the house's radius clear of the ones before it. A roof with no room left
   * seats fewer than asked -- the small houses' are barely a square metre.
   */
  roofSpots(i, count, rand) {
    const h = this.props[i]
    if (!h) throw new Error(`RoomProps: no prop ${i} to sit on`)
    const cells = this._roofCells()
    const c = Math.cos(h.yaw), sn = Math.sin(h.yaw), apart = h.r * ROOF.apart
    const out = []
    for (let t = 0; t < count * 8 && out.length < count; t++) {
      const cell = cells[Math.floor(rand() * cells.length)]
      // The pick's frame back to the world: _spansAt's turn and mirror, undone.
      const a = cell.x * h.scale, b = cell.z * h.mirror * h.scale
      const x = h.x + a * c + b * sn, z = h.z - a * sn + b * c
      if (out.some((p) => Math.hypot(p.x - x, p.z - z) < apart)) continue
      out.push({ x, y: h.y + cell.y * h.scale, z })
    }
    return out
  }

  /** The pick's roof cells (ROOF) in its own frame, `[{ x, y, z }]` at their centres: one table between every house, so one answer. */
  _roofCells() {
    if (this._roof) return this._roof
    const g = this.bank.table
    const high = ROOF.high * this.bank.bounds.height, tilt = Math.tan((ROOF.tilt * Math.PI) / 180)
    const topAt = (ii, jj) => {
      if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.nz) return null
      const k = jj * g.nx + ii, n = g.spans[k]
      return n === 0 ? null : { top: g.cross[k * CROSS_CAP + n * 2 - 1], bot: g.cross[k * CROSS_CAP + n * 2 - 2] }
    }
    const out = []
    for (let j = 0; j < g.nz; j++) {
      for (let i = 0; i < g.nx; i++) {
        const cell = topAt(i, j)
        if (!cell || cell.top < high || cell.top - cell.bot < ROOF.thick * CELL) continue
        const w = topAt(i - 1, j), e = topAt(i + 1, j), s = topAt(i, j - 1), n = topAt(i, j + 1)
        if (![w, e, s, n].every((q) => q && Math.abs(q.top - cell.top) <= ROOF.step * CELL)) continue
        if (Math.hypot(e.top - w.top, n.top - s.top) / (2 * CELL) > tilt) continue
        out.push({ x: g.x0 + (i + 0.5) * CELL, y: cell.top, z: g.z0 + (j + 0.5) * CELL })
      }
    }
    if (out.length === 0) throw new Error('RoomProps: the pick has no roof flat enough to seat a fern')
    this._roof = out
    return out
  }

  /** Whether (x, z) is within `pad` of the clearing or a hut's box: the trees' `deadwood` contract, so the wood stops at the village. */
  occupiesAt(x, z, pad) {
    const c = this.clearing
    const cx = x - c.x, cz = z - c.z, cr = c.r + pad
    if (cx * cx + cz * cz < cr * cr) return true
    for (const h of this.props) {
      const dx = x - h.x, dz = z - h.z, r = h.r + pad
      if (dx * dx + dz * dz < r * r) return true
    }
    return false
  }

  // -- stone to the walker (walk.js addStone) ---------------------------------

  /**
   * The prop's spans of stone on the vertical line through (x, z), in metres,
   * into `out` from span `at` up to `cap` spans in all: how many. The table is
   * read in the pick's frame -- the point turned back by the yaw, scaled to the
   * unit, mirrored where the house is -- bilinearly where the four cells about
   * it hold as many spans as each other, the nearest cell's where they do not.
   */
  _spansAt(h, x, z, out, at, cap) {
    const c = Math.cos(h.yaw), sn = Math.sin(h.yaw)
    const wx = x - h.x, wz = z - h.z
    const px = (wx * c - wz * sn) / h.scale, pz = ((wx * sn + wz * c) / h.scale) * h.mirror
    const g = this.bank.table, cross = g.cross, spans = g.spans
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
      // The box's corner reaches root 2 of its half-width.
      if (dx * dx + dz * dz > h.r * h.r * 2) continue
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
      if (dx * dx + dz * dz > h.r * h.r * 2) continue
      const n = this._spansAt(h, x, z, c, 0, CROSS_CAP >> 1)
      if (n > 0 && c[n * 2 - 1] > top) top = c[n * 2 - 1]
    }
    return top
  }

  /**
   * Whether any prop's mesh stands over (x, z), or over a point within `pad` of
   * it: a roof, a wall, a step, a root. The columns are read at the point and at
   * four round it, which is what `pad` buys -- a root arching over a gap thinner
   * than the grid (CELL) is missed either way, and the gardens (village.js
   * weedGardens) only need the rows to miss the wood, not the shadow of it.
   */
  rootedAt(x, z, pad = 0) {
    if (this.blockTopAt(x, z) > -Infinity) return true
    if (!(pad > 0)) return false
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2
      if (this.blockTopAt(x + Math.cos(a) * pad, z + Math.sin(a) * pad) > -Infinity) return true
    }
    return false
  }

  get stats() {
    return { placed: this.props.length, tris: this.tris, pool: POOL }
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.batch.dispose()
    if (this.material.map) this.material.map.dispose()
    for (const m of this.materials) m.dispose()
    for (const t of this.bank.tiers) for (const g of t.geometries) g.dispose()
  }
}
