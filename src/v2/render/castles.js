// The sited castles (design/44-castles.md, Tiers): a crossed far card per site, then the worker's full or mid-distance exterior and
// its court near by, and the exterior as stone. A castle's interior is set down CASTLE_RISE over it while she is inside, as its own
// stone (CastleInteriorStone) under her own walk; main.js swaps walks. Portals: `portalAt`.
import THREE from '../../three-instance.js'
import { castleLayout, CASTLE } from '../castles/layout.js'
import { courtGeometry, exteriorGeometry, toGeometry, UV_METRES } from '../castles/shell.js'
import { exteriorSpans, interiorSpans, SPANS } from '../castles/solids.js'
import { castleExtents, toLocal } from '../layers/castles.js'
import { TriFlames, TRI_TORCH } from './fire-tris.js'
import { downsample, flipY, dilate, SUPERSAMPLE } from '../../props/impostor.js'

// Metres from the site: built within `build`, dropped past `drop`; its meshes drawn within `mesh` (the card past it), the full
// exterior within `full` and the mid-distance one past `low`.
export const CASTLE_BANDS = { build: 220, drop: 260, mesh: 200, full: 50, low: 55 }
// The far card: baked off seed `seed`'s castle from the front (its gate's side), scaled to each site's size.
export const CASTLE_CARD = { seed: 3, size: 512, bottom: -3 }
// How far over its site a castle's interior is set down.
export const CASTLE_RISE = 320
// Plan metres round a rope, a hatch or a ladder where each fires, and how near her feet must be to its height. The rope hangs a
// metre off the lookout's face, past its 1.3 m battlement band, which she cannot step onto: she takes it over the band. A door
// fires within `door` of its leaves' face, which is solid, so touching them is going through.
const ZONE = { rope: 2.2, hatch: 0.6, ladder: 0.7, door: 0.5, rise: 0.6 }
// How square to the rope she must walk at it, as the cosine of her step on its way out.
const ROPE_INTO = 0.6

const loadTile = (path, metres, done) => {
  const t = new THREE.TextureLoader().load(path, done, undefined, () => { throw new Error(`Castles: ${path} failed to load`) })
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  t.repeat.setScalar(UV_METRES / metres)
  return t
}
// Castle-local direction to world (layers/castles.js toWorld's turn).
const turn = (s, u, v) => [u * Math.cos(s.yaw) + v * Math.sin(s.yaw), -u * Math.sin(s.yaw) + v * Math.cos(s.yaw)]

// TriFlames draws in world coordinates: castle-local flames (x, y, z, height, radius) turned and set down at foot height `y0`.
function flamesOf(site, list, y0) {
  const n = list.length / 5
  if (n === 0) return null
  const f = new TriFlames(n, TRI_TORCH, { seed: site.seed % 97 + 1 })
  for (let i = 0; i < n; i++) {
    const [x, y, z, height, radius] = list.subarray(i * 5, i * 5 + 5), [wx, wz] = turn(site, x, z)
    f.place(i, site.x + wx, y0 + y, site.z + wz, { height, radius })
  }
  return f
}

export class Castles {
  /** `sites` layers/castles.js CastleSites.list; `patch(material, cacheKey)` lighting.js's vertex patch. */
  constructor(scene, sites, { patch }) {
    this.scene = scene
    this.sites = sites
    let left = 5, loaded
    this.texturesReady = new Promise((resolve) => { loaded = resolve })
    const done = () => { if (--left === 0) loaded() }
    this.maps = { stone: loadTile('/buildings/castle_stone.webp', UV_METRES, done), plank: loadTile('/buildings/timber_plank.png', UV_METRES, done), cobble: loadTile('/terrain/cobble.webp', 3, done), door: loadTile('/buildings/door.png', UV_METRES, done), gate: loadTile('/buildings/castle_gate.png', UV_METRES, done) }
    this.material = ['stone', 'plank', 'door', 'gate'].map((k) => patch(new THREE.MeshLambertMaterial({ vertexColors: true, map: this.maps[k] }), `v2-castle-${k}`))
    this.courtMaterial = patch(new THREE.MeshLambertMaterial({ vertexColors: true, map: this.maps.cobble }), 'v2-castle-court')
    // The interior has no sun: drawn unlit, its colours shaded in the worker.
    this.innerMaterial = ['stone', 'plank', 'door', 'gate'].map((k) => new THREE.MeshBasicMaterial({ vertexColors: true, map: this.maps[k] }))

    this.cardTexture = new THREE.DataTexture(new Uint8Array(CASTLE_CARD.size * CASTLE_CARD.size * 4), CASTLE_CARD.size, CASTLE_CARD.size, THREE.RGBAFormat, THREE.UnsignedByteType)
    this.cardTexture.colorSpace = THREE.SRGBColorSpace
    this.cardTexture.minFilter = THREE.LinearMipmapLinearFilter
    this.cardTexture.magFilter = THREE.LinearFilter
    this.cardTexture.generateMipmaps = true
    this.cardMaterial = patch(new THREE.MeshLambertMaterial({ map: this.cardTexture, alphaTest: 0.5, side: THREE.DoubleSide }), 'v2-castle-card')
    // A unit picture standing on its bottom edge's middle, v running down it as the bake's rows do, its normal leant up so the
    // card takes the sky's light as a roofline does rather than going dark edge-on to the sun.
    const plane = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)
    const uv = plane.getAttribute('uv'), nrm = plane.getAttribute('normal')
    for (let i = 0; i < uv.count; i++) { uv.setY(i, 1 - uv.getY(i)); nrm.setXYZ(i, 0, 0.6, 0.8) }
    this.cards = new THREE.InstancedMesh(plane, this.cardMaterial, Math.max(1, sites.length * 2))
    this.cards.frustumCulled = false
    this.cards.visible = false
    scene.add(this.cards)
    this.cardFrame = null
    this._baking = false
    // Site id -> { site, state 'building' | 'ready' | 'failed', group, full, low, solids, shown }.
    this.live = new Map()
    this.worker = null
    this._job = 0
    this.inside = null
    // Sites whose dungeon door she has unlocked.
    this.unlocked = new Set()
    this.stats = { built: 0, live: 0, full: 0, low: 0, cards: 0 }
  }

  /** Photograph seed CASTLE_CARD.seed's exterior and court from its gate's side into the far card, once its textures are in. */
  async bakeCard(renderer) {
    if (this._baking) return
    this._baking = true
    await this.texturesReady
    const lay = castleLayout(CASTLE_CARD.seed)
    if (!lay.stats.ok) throw new Error(`Castles: card seed ${CASTLE_CARD.seed} has no good layout`)
    const ext = castleExtents(lay), shell = toGeometry(exteriorGeometry(lay)), court = toGeometry(courtGeometry(lay))
    shell.computeBoundingBox()
    const half = Math.max(ext.hx, ext.hz) + 1.5, F = { half, bottom: CASTLE_CARD.bottom, top: shell.boundingBox.max.y + 0.5, size: Math.max(ext.hx, ext.hz) }
    const scene = new THREE.Scene()
    const mats = ['stone', 'plank', 'door', 'gate'].map((k) => new THREE.MeshLambertMaterial({ vertexColors: true, map: this.maps[k] }))
    const courtMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: this.maps.cobble })
    scene.add(new THREE.Mesh(shell, mats), new THREE.Mesh(court, courtMat))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(half * 0.8, half * 2, half * 2)
    scene.add(key, new THREE.HemisphereLight(0xffffff, 0x6f6658, 1.1))
    const cam = new THREE.OrthographicCamera(-half, half, F.top, F.bottom, 0.1, half * 8)
    cam.position.set(0, 0, half * 3)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld()
    const big = CASTLE_CARD.size * SUPERSAMPLE
    const target = new THREE.WebGLRenderTarget(big, big, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true })
    const prev = { target: renderer.getRenderTarget(), clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), xr: renderer.xr.enabled }
    // XR off: presenting, three swaps the camera passed to render() for the headset's (impostor.js renderLayer).
    renderer.xr.enabled = false
    renderer.setRenderTarget(target)
    renderer.setClearColor(0x000000, 0)
    renderer.clear(true, true, false)
    renderer.render(scene, cam)
    const raw = new Uint8Array(big * big * 4)
    renderer.readRenderTargetPixels(target, 0, 0, big, big, raw)
    renderer.xr.enabled = prev.xr
    renderer.setRenderTarget(prev.target)
    renderer.setClearColor(prev.clear, prev.alpha)
    target.dispose()
    for (const m of [...mats, courtMat]) m.dispose()
    shell.dispose()
    court.dispose()
    const px = downsample(raw, big, CASTLE_CARD.size)
    flipY(px, CASTLE_CARD.size)
    dilate(px, CASTLE_CARD.size)
    this.cardTexture.image.data.set(px)
    this.cardTexture.needsUpdate = true
    this.cardFrame = F
    this._placeCards()
  }

  /** Every site's two crossed cards, a site with its meshes drawn scaled to nothing. */
  _placeCards() {
    if (this.cardFrame === null) return
    const F = this.cardFrame, m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
    let n = 0
    this.sites.forEach((s, i) => {
      const c = this.live.get(s.id), f = Math.max(s.hx, s.hz) / F.size, hide = c !== undefined && c.shown
      for (let k = 0; k < 2; k++) {
        q.setFromAxisAngle(up, s.yaw + k * Math.PI / 2)
        p.set(s.x, s.y + F.bottom * f, s.z)
        sc.set(hide ? 0 : 2 * F.half * f, hide ? 0 : (F.top - F.bottom) * f, 1)
        this.cards.setMatrixAt(i * 2 + k, m.compose(p, q, sc))
      }
      if (!hide) n++
    })
    this.cards.count = this.sites.length * 2
    this.cards.instanceMatrix.needsUpdate = true
    this.cards.visible = n > 0
    this.stats.cards = n
  }

  /** Once a frame: build and drop castles by the eye, pick each one's tier, and run the flames, the court's and roofs' lit by `night` (0 by day to 1). */
  update(eye, t, night) {
    const B = CASTLE_BANDS
    let cards = false
    for (const s of this.sites) {
      const d = Math.hypot(eye.x - s.x, eye.z - s.z), c = this.live.get(s.id)
      if (c === undefined) {
        if (d < B.build) this._build(s)
        continue
      }
      if (d > B.drop && this.inside !== c) { this._drop(c); cards = true; continue }
      if (c.state !== 'ready') continue
      const shown = d < B.mesh
      if (shown !== c.shown) { c.shown = shown; c.group.visible = shown; cards = true }
      const full = d < B.full ? true : d > B.low ? false : c.full.visible
      c.full.visible = full
      c.low.visible = !full
      if (c.flames !== null) {
        c.flames.update(t, [night, night, night])
        c.flames.mesh.visible &&= shown && full && night > 0.05
      }
    }
    if (this.inside !== null && this.inside.innerFlames !== null) this.inside.innerFlames.update(t, [1, 1, 1])
    if (cards) this._placeCards()
    this.stats.live = this.live.size
    this.stats.full = [...this.live.values()].filter((c) => c.state === 'ready' && c.shown && c.full.visible).length
    this.stats.low = [...this.live.values()].filter((c) => c.state === 'ready' && c.shown && c.low.visible).length
  }

  _build(s) {
    if (this.worker === null) {
      this.worker = new Worker(new URL('../castles/worker.js', import.meta.url), { type: 'module' })
      this.worker.onmessage = (ev) => this._built(ev.data)
      this.worker.onerror = (e) => { throw new Error(`Castles: the worker failed: ${e.message}`) }
    }
    const id = ++this._job
    this.live.set(s.id, { site: s, state: 'building', job: id, shown: false })
    this.worker.postMessage({ id, seed: s.seed })
  }

  _built(d) {
    const c = [...this.live.values()].find((v) => v.job === d.id)
    // Dropped while the worker was at it.
    if (c === undefined) return
    if (d.seed !== c.site.seed) throw new Error(`Castles: job ${d.id} came back as seed ${d.seed}, not ${c.site.seed}`)
    // A failed castle stays in `live` while near, keeping its card, not rebuilt each frame.
    if (d.error) { c.state = 'failed'; throw new Error(`Castles: castle ${c.site.id} (seed ${d.seed}) failed to build: ${d.error}`) }
    const s = c.site, group = new THREE.Group()
    group.position.set(s.x, s.y, s.z)
    group.rotation.y = s.yaw
    c.full = new THREE.Mesh(toGeometry(d.full), this.material)
    c.low = new THREE.Mesh(toGeometry(d.low), this.material)
    c.court = new THREE.Mesh(toGeometry(d.court), this.courtMaterial)
    group.add(c.full, c.low, c.court)
    group.visible = false
    group.updateMatrixWorld(true)
    for (const m of [c.full, c.low, c.court]) m.matrixAutoUpdate = false
    this.scene.add(group)
    c.group = group
    c.interior = d.interior
    c.door = d.door
    c.solids = d.solids
    c.flames = flamesOf(s, d.flames.exterior, s.y)
    if (c.flames !== null) this.scene.add(c.flames.group)
    c.innerFlameList = d.flames.interior
    c.state = 'ready'
    this.stats.built++
  }

  _drop(c) {
    this.live.delete(c.site.id)
    if (c.state !== 'ready') return
    c.group.removeFromParent()
    for (const m of [c.full, c.low, c.court]) m.geometry.dispose()
    if (c.flames !== null) { c.flames.group.removeFromParent(); c.flames.dispose() }
  }

  /** The built castle whose footprint holds world (x, z), with (x, z) in its local metres; null where there is none. */
  _at(x, z) {
    for (const c of this.live.values()) {
      if (c.state !== 'ready') continue
      const s = c.site
      if (Math.hypot(x - s.x, z - s.z) > s.reach) continue
      const [lx, lz] = toLocal(s, x, z)
      _hit.c = c; _hit.lx = lx; _hit.lz = lz
      return _hit
    }
    return null
  }

  // Stone spans on world (x, z) into `out`, from the castle there; the walk reads out.length / 2 spans or more as solid.
  columnAt(x, z, _minSize, out) {
    const h = this._at(x, z)
    if (h === null) return 0
    const n = exteriorSpans(h.c.solids.ex, h.lx, h.lz)
    return writeSpans(n, h.c.site.y, out)
  }

  blockTopAt(x, z) {
    const h = this._at(x, z)
    if (h === null) return -Infinity
    const n = exteriorSpans(h.c.solids.ex, h.lx, h.lz)
    return n === 0 ? -Infinity : h.c.site.y + spanTop(n)
  }

  /** The built castle site `id`'s summit chest, world [x, y, z] of its top; null until built. */
  chestOf(id) {
    const c = this.live.get(id)
    if (c === undefined || c.state !== 'ready') return null
    const [x, y, z] = c.solids.portals.chest, [wx, wz] = turn(c.site, x, z)
    return [c.site.x + wx, c.site.y + y + 0.2, c.site.z + wz]
  }

  /** The dungeon key's and dungeon chest's spots in built castle site `id`'s interior, world [x, y, z] while it is drawn at
   * CASTLE_RISE; null until built. */
  keyOf(id) { return this._inner(id, 'key') }
  dungeonChestOf(id) { return this._inner(id, 'chest') }
  _inner(id, what) {
    const c = this.live.get(id)
    if (c === undefined || c.state !== 'ready') return null
    const [x, y, z] = c.solids.portals.dungeon[what], [wx, wz] = turn(c.site, x, z)
    return [c.site.x + wx, c.site.y + CASTLE_RISE + y, c.site.z + wz]
  }

  /** Opens the dungeon door of the castle she is in, for good. */
  unlock(site) {
    const c = this.inside
    if (c === null || c.site.id !== site.id) throw new Error(`Castles: unlocking castle ${site.id} from outside it`)
    this.unlocked.add(site.id)
    c.solids.it.unlocked = true
    c.doorMesh.removeFromParent()
    c.doorMesh.geometry.dispose()
    c.doorMesh = null
  }

  /** Built castles, for the chests' loot. */
  *built() {
    for (const c of this.live.values()) if (c.state === 'ready') yield c.site
  }

  /** Castle `c`'s interior drawn and its stone made, for her to go in. */
  openInterior(site) {
    const c = this.live.get(site.id)
    if (c === undefined || c.state !== 'ready') throw new Error(`Castles: castle ${site.id} is not built`)
    if (this.inside !== null) throw new Error('Castles: already inside a castle')
    const mesh = new THREE.Mesh(toGeometry(c.interior), this.innerMaterial)
    mesh.position.set(site.x, site.y + CASTLE_RISE, site.z)
    mesh.rotation.y = site.yaw
    mesh.frustumCulled = false
    this.scene.add(mesh)
    this.inside = c
    c.innerMesh = mesh
    c.solids.it.unlocked = this.unlocked.has(site.id)
    c.doorMesh = null
    if (!c.solids.it.unlocked) {
      c.doorMesh = new THREE.Mesh(toGeometry(c.door), this.innerMaterial)
      mesh.add(c.doorMesh)
    }
    c.innerFlames = flamesOf(site, c.innerFlameList, site.y + CASTLE_RISE)
    if (c.innerFlames !== null) this.scene.add(c.innerFlames.group)
    c.innerStone = new CastleInteriorStone(c)
    this._zone = null
    return c.innerStone
  }

  closeInterior() {
    const c = this.inside
    if (c === null) return
    c.innerMesh.removeFromParent()
    c.innerMesh.geometry.dispose()
    if (c.doorMesh !== null) c.doorMesh.geometry.dispose()
    if (c.innerFlames !== null) { c.innerFlames.group.removeFromParent(); c.innerFlames.dispose() }
    c.innerMesh = c.innerStone = c.innerFlames = c.doorMesh = null
    this.inside = null
    this._zone = null
  }

  /**
   * After the step, her feet now at `feet` and before it at `from` (world): the portal she just went through, as { kind: 'enter' |
   * 'leave' | 'rope', site, at: world [x, y, z], face: world [fx, fz], back: an enter's way out (world) }, { kind: 'locked', site } at
   * the dungeon's locked door, or null. The rope fires
   * walking at it; the rest on entering their zone, so an arrival inside one stays put.
   */
  portalAt(feet, from) {
    const c = this.inside ?? this._at(feet.x, feet.z)?.c
    if (!c) { this._zone = null; return null }
    const s = c.site, P = c.solids.portals, inside = this.inside === c
    const oy = s.y + (inside ? CASTLE_RISE : 0)
    const [lx, lz] = toLocal(s, feet.x, feet.z), [fx, fz] = toLocal(s, from.x, from.z), ly = feet.y - oy
    const sx = lx - fx, sz = lz - fz, step = Math.hypot(sx, sz)
    const world = (p, dy) => { const [wx, wz] = turn(s, p[0], p[2]); return [s.x + wx, dy + p[1], s.z + wz] }
    const face = (u, v) => turn(s, u, v)
    // The rope: walking at it off the summit, not merely past it.
    const r = P.rope, ru = r.x - r.from[0], rv = r.z - r.from[1], rl = Math.hypot(ru, rv)
    if (!inside && Math.hypot(lx - r.x, lz - r.z) < ZONE.rope && Math.abs(ly - r.top) < ZONE.rise && step > 0 && (sx * ru + sz * rv) / (step * rl) >= ROPE_INTO) return { kind: 'rope', site: s, at: world([r.x, r.top, r.z], s.y), face: face(ru, rv) }
    // Zones: the first one her feet are in, by key; it fires only when it was not the one they were in last.
    let zone = null, act = null
    const near = (x, z, r, y) => Math.hypot(lx - x, lz - z) < r && Math.abs(ly - y) < ZONE.rise
    const atLeaves = (p, hw) => Math.abs(ly - p.y) <= ZONE.rise && Math.abs((lx - p.x) * p.nx + (lz - p.z) * p.nz) <= ZONE.door && Math.abs((lx - p.x) * p.nz - (lz - p.z) * p.nx) <= hw
    P.doors.forEach((d, i) => {
      if (zone !== null) return
      if (!inside && atLeaves(d.ext, d.hw)) { zone = `d${i}`; act = { kind: 'enter', site: s, at: world(d.in, s.y + CASTLE_RISE), face: face(-d.ext.nx, -d.ext.nz), back: world(d.out, s.y) } }
      if (inside && atLeaves(d.int, d.hw * CASTLE.scale)) { zone = `d${i}`; act = { kind: 'leave', site: s, at: world(d.out, s.y), face: face(d.ext.nx, d.ext.nz) } }
    })
    if (inside) {
      if (zone === null && !c.solids.it.unlocked && atLeaves(P.dungeon.door, P.dungeon.door.hw)) { zone = 'lock'; act = { kind: 'locked', site: s } }
      P.ladders.forEach((l, i) => {
        if (zone === null && near(l.x, l.z, ZONE.ladder, l.down[1])) { zone = `l${i}`; act = { kind: 'leave', site: s, at: world(l.roof, s.y), face: face(-l.hatch[0], -l.hatch[2]) } }
      })
    } else {
      P.ladders.forEach((l, i) => {
        if (zone === null && near(l.hatch[0], l.hatch[2], ZONE.hatch, l.hatch[1])) { zone = `t${i}`; act = { kind: 'enter', site: s, at: world(l.down, s.y + CASTLE_RISE), face: face(-l.x, -l.z), back: world(l.roof, s.y) } }
      })
    }
    const fire = zone !== null && zone !== this._zone
    this._zone = zone
    return fire ? act : null
  }

  /** After a portal set her down: the zone she now stands in is the one she is in, so it does not fire. */
  arrived(feet) {
    this._zone = undefined
    this.portalAt(feet, feet)
  }

  dispose() {
    for (const c of [...this.live.values()]) this._drop(c)
    this.closeInterior()
    if (this.worker !== null) this.worker.terminate()
    this.cards.removeFromParent()
    this.cards.geometry.dispose()
    this.cards.dispose()
    for (const m of [...this.material, ...this.innerMaterial, this.courtMaterial, this.cardMaterial]) m.dispose()
    for (const t of [...Object.values(this.maps), this.cardTexture]) t.dispose()
  }
}

/** The interior of the castle she is in, as stone: interior metres at CASTLE_RISE over the site. A column asked without her foot
 * (ceilingAt, a teleport landing) reads the storeys round `hint`, the castle layer's last sight of her. */
export class CastleInteriorStone {
  constructor(c) {
    this.c = c
    this.oy = c.site.y + CASTLE_RISE
    this.hint = 0
  }

  columnAt(x, z, _minSize, out, foot) {
    const [lx, lz] = toLocal(this.c.site, x, z)
    const n = interiorSpans(this.c.solids.it, lx, lz, (foot === undefined ? this.hint : foot) - this.oy + 0.5)
    return writeSpans(n, this.oy, out)
  }

  blockTopAt(x, z) {
    const [lx, lz] = toLocal(this.c.site, x, z)
    const n = interiorSpans(this.c.solids.it, lx, lz, this.hint - this.oy + 0.5)
    return this.oy + spanTop(n)
  }

  /** Every top inside is level, so the walk reads a spiral's steps as floor and not the slope across them. */
  deckAt() { return true }
}

const _hit = { c: null, lx: 0, lz: 0 }
const { LO, HI } = SPANS

function writeSpans(n, oy, out) {
  if (n * 2 > out.length) throw new Error(`Castles: ${n} spans on one column, past the walk's ${out.length / 2}`)
  for (let i = 0; i < n; i++) { out[i * 2] = LO[i] + oy; out[i * 2 + 1] = HI[i] + oy }
  return n
}

/** The highest top of the `n` spans solids.js last left, short of the open sky over a castle's interior. */
function spanTop(n) {
  let top = -Infinity
  for (let i = 0; i < n; i++) if (HI[i] < 999) top = Math.max(top, HI[i])
  return top
}
