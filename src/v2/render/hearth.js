import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { LAYER } from '../../textures.js'
import { createPropMaterial } from '../../material.js'
import { TINT_GAIN } from '../../props/rock-bank.js'
import { decimate } from '../../mesh/decimate.js'
import { bakeImpostor, buildImpostorCard } from '../../props/impostor.js'
import { CAMPFIRE, Flames } from './fire.js'

// ---------------------------------------------------------------------------
// A VILLAGE'S GATHERING PLACE (DESIGN.md §30): a campfire at the centre of the
// clearing and a ring of stools round it. The fire is a ring of seven of the
// bank's T20 boulders with six pentagon logs leaning in over it, teepee
// fashion, and one flame (fire.js, the CAMPFIRE knobs) burning in the middle
// day and night; a stool is a nonagon of pine bark with its corners jittered
// so no two are the same block. One merged mesh in the prop layout, drawn
// whole inside HEARTH.lod[0] metres, decimated to a third past it and a spun
// card of one photograph past HEARTH.lod[1], the flame at every distance. The
// fire ring and every stool are stone to the walker, and the wood keeps off
// the whole place.
// ---------------------------------------------------------------------------

export const HEARTH = {
  // The fire ring: `count` boulders on a ring of radius `r`, each `size` metres wide, `sink` of its height in the ground.
  ring: { count: 7, r: 0.55, size: [0.26, 0.36], sink: 0.3, tints: [0, 1, 6] },
  // The logs: `count` pentagon prisms, `radius` metres across the flats and `length` long, the foot on a ring of `foot` metres and the tip `rise` metres up over a ring of `tip`, so they cross above the centre rather than meet on it; the bark tile once every `tile` metres.
  logs: { count: 6, foot: 0.4, tip: 0.1, rise: 0.5, radius: 0.055, length: 0.7, tile: 1 },
  // The flame's foot, metres over the ground: up among the logs.
  fire: { lift: 0.1 },
  // The stools: `count` nonagon prisms on a ring `r` metres out with `spread` metres of play, each `radius` across and `height` tall (a metre-tall leafkin's seated hips, villagers.js SIT), every corner moved `jitter` of the radius. The scattered stools (stools.js) are cut to the same numbers.
  stools: { count: [5, 7], r: 1.7, spread: 0.3, radius: [0.16, 0.2], height: [0.22, 0.28], jitter: 0.15, tile: 1 },
  // Metres: where the decimated tier takes over, where the card does, and the fraction of that a rung comes back at.
  lod: [15, 30],
  hysteresis: 0.9,
  // The decimated tier's triangles as a fraction of the whole's.
  decimate: 1 / 3,
}

/** The seed the card's photograph is taken at: one picture for every village's hearth. */
export const HEARTH_CARD_SEED = 1978

const RING_TOP = (s) => s * 0.75

const STEADY = [1, 1, 1]

// The rock's tint gain, per instance; the bark tile is an albedo and wears none.
const WHITE = [1, 1, 1]

// The prop layout (material.js): every face its own three vertices under the face's normal, `uvProj` in the tile's metres, `texLayer`, and `color` the tint over the tile.
export class Faces {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.lay = []; this.col = [] }
  tri(a, b, c, uva, uvb, uvc, layer, color) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (!(len > 1e-9)) throw new Error('Hearth: a degenerate face')
    nx /= len; ny /= len; nz /= len
    for (const [p, uv] of [[a, uva], [b, uvb], [c, uvc]]) {
      this.pos.push(p[0], p[1], p[2])
      this.nrm.push(nx, ny, nz)
      this.uv.push(uv[0], uv[1])
      this.lay.push(layer)
      this.col.push(color[0], color[1], color[2])
    }
  }
  /** A geometry in the prop layout with an identity index. */
  geometry() {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(this.uv, 2))
    geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(this.lay, 1))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    const n = this.pos.length / 3
    const index = new Uint32Array(n)
    for (let i = 0; i < n; i++) index[i] = i
    geo.setIndex(new THREE.BufferAttribute(index, 1))
    geo.computeBoundingBox()
    geo.computeBoundingSphere()
    return geo
  }
}

/**
 * A prism on the bark tile: `ring` its corners `[x, z]` about a local Y axis,
 * `tops` each corner's height, carried into the world by `m`. The sides tile u
 * along the perimeter and v up the height, in metres over `tile`; a cap
 * projects its own plane.
 */
export function prism(faces, ring, tops, m, tile, color) {
  const n = ring.length
  const at = (x, y, z) => { const p = new THREE.Vector3(x, y, z).applyMatrix4(m); return [p.x, p.y, p.z] }
  let along = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const w = Math.hypot(ring[j][0] - ring[i][0], ring[j][1] - ring[i][1])
    const a = at(ring[i][0], 0, ring[i][1]), b = at(ring[j][0], 0, ring[j][1])
    const c = at(ring[j][0], tops[j], ring[j][1]), d = at(ring[i][0], tops[i], ring[i][1])
    const u0 = along / tile, u1 = (along + w) / tile
    // The ring runs clockwise seen from +Y, so the outward face is a, c, b.
    faces.tri(a, c, b, [u0, 0], [u1, tops[j] / tile], [u1, 0], LAYER.BARK_PINE, color)
    faces.tri(a, d, c, [u0, 0], [u0, tops[i] / tile], [u1, tops[j] / tile], LAYER.BARK_PINE, color)
    along += w
  }
  const cap = (y, flip) => {
    for (let i = 1; i < n - 1; i++) {
      const [p, q, r] = flip ? [0, i, i + 1] : [0, i + 1, i]
      const uv = (k) => [ring[k][0] / tile, ring[k][1] / tile]
      faces.tri(at(ring[p][0], y(p), ring[p][1]), at(ring[q][0], y(q), ring[q][1]), at(ring[r][0], y(r), ring[r][1]), uv(p), uv(q), uv(r), LAYER.BARK_PINE, color)
    }
  }
  cap(() => 0, true)
  cap((k) => tops[k], false)
}

/** A regular n-gon of radius `r`, each corner pushed in or out by up to `jitter` of it. */
export function polygon(n, r, jitter, rand) {
  const ring = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const k = r * (1 + (rand() * 2 - 1) * jitter)
    ring.push([Math.cos(a) * k, Math.sin(a) * k])
  }
  return ring
}

const between = (rand, [lo, hi]) => lo + rand() * (hi - lo)

/**
 * The hearth's geometry, built about (0, 0) on a ground `groundAt(x, z)`:
 * `{ geometry, ring, stools, top, extent }`, the ring and each stool as the
 * discs they are stone over.
 */
export function buildHearth(bank, seed, groundAt) {
  if (!bank || !bank.shapes || !bank.shapes.boulder) throw new Error('Hearth: needs the rock bank (buildRockBank)')
  const rand = mulberry32(seed)
  const faces = new Faces()
  const y0 = groundAt(0, 0)
  const H = HEARTH

  // The ring: the bank's T20 boulder, scaled to size, turned, and set on its own ground with `sink` of it buried.
  const src = bank.shapes.boulder.tiers[2]
  const measured = bank.shapes.boulder.measured
  const P = src.attributes.position.array, N = src.attributes.normal.array, UV = src.attributes.uvProj.array
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0)
  const v = new THREE.Vector3(), nm = new THREE.Matrix3()
  let ringSize = 0
  for (let i = 0; i < H.ring.count; i++) {
    const a = ((i + rand() * 0.3) / H.ring.count) * Math.PI * 2
    const size = between(rand, H.ring.size)
    const s = size / measured.width
    const x = Math.cos(a) * H.ring.r, z = Math.sin(a) * H.ring.r
    const y = groundAt(x, z) - measured.height * s * H.ring.sink
    q.setFromAxisAngle(up, rand() * Math.PI * 2)
    m.compose(v.set(x, y, z), q, new THREE.Vector3(s, s, s))
    nm.getNormalMatrix(m)
    const color = TINT_GAIN[H.ring.tints[Math.floor(rand() * H.ring.tints.length)]]
    const corner = (k) => {
      v.set(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]).applyMatrix4(m)
      return [v.x, v.y, v.z]
    }
    for (let k = 0; k < P.length / 3; k += 3) {
      // The rock's own projection, not the face normal: its uvs are per-face planar and its normals per vertex, and both survive the rigid move.
      const a3 = corner(k), b3 = corner(k + 1), c3 = corner(k + 2)
      faces.tri(a3, b3, c3, [UV[k * 2], UV[k * 2 + 1]], [UV[k * 2 + 2], UV[k * 2 + 3]], [UV[k * 2 + 4], UV[k * 2 + 5]], LAYER.ROCK, color)
      for (let j = 0; j < 3; j++) {
        v.set(N[(k + j) * 3], N[(k + j) * 3 + 1], N[(k + j) * 3 + 2]).applyMatrix3(nm).normalize()
        const at = faces.nrm.length - 9 + j * 3
        faces.nrm[at] = v.x; faces.nrm[at + 1] = v.y; faces.nrm[at + 2] = v.z
      }
    }
    if (size > ringSize) ringSize = size
  }
  const ring = { x: 0, z: 0, r: H.ring.r + ringSize / 2, y: y0, top: y0 + RING_TOP(ringSize) }

  // The logs: each stood on local Y from its foot on the outer ring to its tip over the inner one, a third of a turn on.
  const L = H.logs
  const dir = new THREE.Vector3()
  for (let i = 0; i < L.count; i++) {
    const a = ((i + 0.5 + (rand() - 0.5) * 0.4) / L.count) * Math.PI * 2
    const foot = new THREE.Vector3(Math.cos(a) * L.foot, groundAt(Math.cos(a) * L.foot, Math.sin(a) * L.foot) - L.radius * 0.5, Math.sin(a) * L.foot)
    const tip = new THREE.Vector3(Math.cos(a + 2.1) * L.tip, y0 + L.rise, Math.sin(a + 2.1) * L.tip)
    dir.subVectors(tip, foot).normalize()
    q.setFromUnitVectors(up, dir)
    m.compose(foot, q, new THREE.Vector3(1, 1, 1))
    const ring5 = polygon(5, L.radius, 0.1, rand)
    prism(faces, ring5, ring5.map(() => L.length), m, L.tile, WHITE)
  }

  // The stools, round the fire and clear of one another.
  const S = H.stools
  const count = Math.round(between(rand, S.count))
  const stools = []
  for (let i = 0; i < count; i++) {
    const a = ((i + rand() * 0.5) / count) * Math.PI * 2
    const r = S.r + (rand() * 2 - 1) * S.spread
    const x = Math.cos(a) * r, z = Math.sin(a) * r
    const radius = between(rand, S.radius), height = between(rand, S.height)
    const y = groundAt(x, z) - 0.02
    q.setFromAxisAngle(up, rand() * Math.PI * 2)
    m.compose(v.set(x, y, z), q, new THREE.Vector3(1, 1, 1))
    const ring9 = polygon(9, radius, S.jitter, rand)
    prism(faces, ring9, ring9.map(() => height * (1 + (rand() * 2 - 1) * 0.05)), m, S.tile, WHITE)
    stools.push({ x, z, r: radius * (1 + S.jitter), y, top: y + height })
  }

  const geometry = faces.geometry()
  const bb = geometry.boundingBox
  return {
    geometry,
    ring,
    stools,
    top: bb.max.y,
    // The place's plan extent, metres across, and its height over its ground: the card's frame.
    extent: { width: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z), height: bb.max.y - y0 },
  }
}

/** The geometry a third the triangles, its uvs slid over the collapsed edges, `texLayer` and `color` carried on the vertex each output vertex is. */
export function decimateHearth(geometry, fraction) {
  const positions = geometry.attributes.position.array
  const tris = geometry.index.count / 3
  const out = decimate(
    { positions, uvs: geometry.attributes.uvProj.array, normals: geometry.attributes.normal.array, indices: geometry.index.array },
    Math.max(4, Math.round(tris * fraction)),
    { uvMode: 'stretch', dropIslands: false },
  )
  const lay = geometry.attributes.texLayer.array, col = geometry.attributes.color.array
  const n = out.sourceVertex.length
  const layers = new Float32Array(n), colors = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const s = out.sourceVertex[i]
    layers[i] = lay[s]
    colors[i * 3] = col[s * 3]; colors[i * 3 + 1] = col[s * 3 + 1]; colors[i * 3 + 2] = col[s * 3 + 2]
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(out.positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(out.normals, 3))
  geo.setAttribute('uvProj', new THREE.BufferAttribute(out.uvs, 2))
  geo.setAttribute('texLayer', new THREE.BufferAttribute(layers, 1))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setIndex(new THREE.BufferAttribute(out.indices, 1))
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  geo.userData.decimate = out.stats
  return geo
}

export class Hearth {
  /**
   * @param field  V2Height: heightAt, the ground it sits on
   * @param opts.bank  buildRockBank()'s answer: the boulder's T20 is the ring. Required.
   * @param opts.at  `{ x, z }`: the clearing's centre. Required.
   * @param opts.textures  the prop atlas (DataArrayTexture). Required.
   * @param opts.patch  (material, cacheKey) => material, the lighting patch. Required.
   */
  constructor(scene, field, { bank = null, at = null, textures = null, seed = 1, patch = null } = {}) {
    if (!field || typeof field.heightAt !== 'function') throw new Error('Hearth: needs a V2Height with heightAt')
    if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.z)) throw new Error('Hearth: `at` is { x, z }')
    if (!textures || !textures.image || !(textures.image.depth > LAYER.IMPOSTOR_HEARTH)) throw new Error('Hearth: needs the prop atlas')
    if (typeof patch !== 'function') throw new Error('Hearth: needs the lighting patch')
    this.x = at.x
    this.z = at.z
    this.y = field.heightAt(at.x, at.z)
    // Built about the origin on the real ground under it, so the mesh's own bounds hold it and the card spins about the fire.
    const built = buildHearth(bank, seed, (x, z) => field.heightAt(this.x + x, this.z + z) - this.y)
    this.ring = built.ring
    this.stools = built.stools
    this.extent = built.extent
    this.material = patch(createPropMaterial(textures, { side: THREE.FrontSide, bump: true, vertexColors: true }), 'v2-hearth')
    this.cardMaterial = patch(createPropMaterial(textures, { side: THREE.DoubleSide, billboardLayers: [LAYER.IMPOSTOR_HEARTH] }), 'v2-hearth-card')
    this.tiers = [built.geometry, decimateHearth(built.geometry, HEARTH.decimate)]
    this.tris = this.tiers.map((g) => g.index.count / 3)
    this.group = new THREE.Group()
    this.group.position.set(this.x, this.y, this.z)
    this.meshes = this.tiers.map((g, i) => {
      const mesh = new THREE.Mesh(g, this.material)
      mesh.name = `v2-hearth-${i}`
      mesh.visible = i === 0
      this.group.add(mesh)
      return mesh
    })
    // The card's quad comes with its photograph (bakeCard); until then the far rung draws the decimated tier.
    this.card = null
    this.tier = 0
    // The flame's shader reads its instance origin as world space, so it hangs off the scene, not the group.
    this.flames = new Flames(1, CAMPFIRE, { seed })
    this.flames.place(0, this.x, this.y + HEARTH.fire.lift, this.z, { height: CAMPFIRE.height, radius: CAMPFIRE.radius, group: 0 })
    scene.add(this.flames.group)
    scene.add(this.group)
    this.textures = textures
    this.bank = bank
  }

  /**
   * Photograph the hearth into its atlas layer and hang the card, once the
   * atlas' images are in (main.js bakeImpostors). Needs the live renderer.
   * The subject is the canonical hearth on flat ground (HEARTH_CARD_SEED),
   * so every village's card is the one picture.
   */
  bakeCard(renderer) {
    const subject = buildHearth(this.bank, HEARTH_CARD_SEED, () => 0)
    const shot = bakeImpostor(renderer, subject.geometry, this.textures, LAYER.IMPOSTOR_HEARTH, {
      width: subject.extent.width, height: subject.extent.height, unlit: true, vertexColors: true,
    })
    subject.geometry.dispose()
    if (this.card) { this.group.remove(this.card); this.card.geometry.dispose() }
    this.card = new THREE.Mesh(buildImpostorCard(shot.width, shot.height, LAYER.IMPOSTOR_HEARTH, 1, { upNormal: true, sink: shot.sink }), this.cardMaterial)
    this.card.name = 'v2-hearth-card'
    this.card.visible = false
    this.group.add(this.card)
    this._show(this.tier)
    return shot
  }

  _show(tier) {
    this.tier = tier
    this.meshes[0].visible = tier === 0
    this.meshes[1].visible = tier === 1 || (tier === 2 && !this.card)
    if (this.card) this.card.visible = tier === 2
  }

  /** Once a frame: the rung by the eye's distance, and the flame's clock in seconds. */
  update(camX, camY, camZ, t) {
    const dx = this.x - camX, dy = this.y + this.extent.height / 2 - camY, dz = this.z - camZ
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    let tier = this.tier
    const [mid, far] = HEARTH.lod
    if (tier < 2 && d > far) tier = 2
    else if (tier === 2 && d < far * HEARTH.hysteresis) tier = 1
    if (tier < 1 && d > mid) tier = 1
    else if (tier === 1 && d < mid * HEARTH.hysteresis) tier = 0
    if (tier !== this.tier) this._show(tier)
    // A steady glow of 1: the campfire was locked on /test-fire with `flicker` 0, and the lamps' breathing curve would pulse its height by a fifth.
    this.flames.update(t, STEADY)
  }

  /** Whether (x, z) is within `pad` of the gathering place: the trees' `deadwood` contract. */
  occupiesAt(x, z, pad) {
    const dx = x - this.x, dz = z - this.z
    const r = HEARTH.stools.r + HEARTH.stools.spread + HEARTH.stools.radius[1] * 2 + pad
    return dx * dx + dz * dz < r * r
  }

  // -- stone to the walker (walk.js addStone): the fire ring one block, each stool its own ------

  _discs(x, z, each) {
    const lx = x - this.x, lz = z - this.z
    const r = this.ring
    if (lx * lx + lz * lz <= r.r * r.r) each(r)
    for (const s of this.stools) {
      const dx = lx - s.x, dz = lz - s.z
      if (dx * dx + dz * dz <= s.r * s.r) each(s)
    }
  }

  columnAt(x, z, _minSize, out) {
    const cap = out.length >> 1
    let n = 0
    this._discs(x, z, (d) => {
      if (n >= cap) return
      out[n * 2] = this.y + d.y
      out[n * 2 + 1] = this.y + d.top
      n++
    })
    return n
  }

  blockTopAt(x, z) {
    let top = -Infinity
    this._discs(x, z, (d) => { if (this.y + d.top > top) top = this.y + d.top })
    return top
  }

  get stats() {
    return { tier: this.tier, tris: this.tier === 2 && this.card ? 2 : this.tris[Math.min(this.tier, 1)], stools: this.stools.length, card: !!this.card }
  }

  /** Where the fire burns, for the ambience's crackle (RULES.campfire). */
  get fire() {
    return { x: this.x, y: this.y + HEARTH.fire.lift, z: this.z }
  }

  dispose() {
    this.group.parent?.remove(this.group)
    this.flames.group.parent?.remove(this.flames.group)
    for (const g of this.tiers) g.dispose()
    if (this.card) this.card.geometry.dispose()
    this.material.dispose()
    this.cardMaterial.dispose()
    this.flames.dispose()
  }
}
