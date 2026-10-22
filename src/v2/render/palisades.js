// The labyrinths' palisades (DESIGN.md §41): posts stood along each labyrinth's wall lines (layers/labyrinths.js) only while the eye is within PALISADE_BANDS.card of its centre, swapped LOD0 / LOD1 / the shared post card by distance, with the torches at each gate; past that, out to PALISADE_BANDS.far, one card of the whole labyrinth. Stone to the walker along the lines themselves, placed posts or none.
import THREE from '../../three-instance.js'
import { createPropMaterial } from '../../material.js'
import { bakeImpostor, bakeImpostorView, impostorCardExtents } from '../../props/impostor.js'
import { POST, POST_CARD_FRAME, RUNG, TORCH_POLE, buildLadder, buildPalisadePost, buildPlinth, buildTorchPole, buildTowerDeck, tonePostCard } from '../../props/palisade.js'
import { ALTAR, BEACON, POST_HEIGHT, POST_R, POST_STRIDE, TOWER } from '../layers/labyrinths.js'
import { EGG_ROUGHNESS, EGG_TINTS } from './roosts.js'
import { mulberry32 } from '../../sim/mathx.js'
import { PropArena } from './prop-arena.js'
import { TriFlames, TRI_TORCH } from './fire-tris.js'
import { FLICKER, flicker } from './fire.js'
import { LABYRINTH_GLOW, LABYRINTHS_LIVE } from '../hearth-light.js'

// Metres from the eye: a post is LOD0 inside lod0, LOD1 inside lod1, else the post card, while its labyrinth's centre is inside `card`; the labyrinth's card stands for it from there to `far`.
export const PALISADE_BANDS = { lod0: 10, lod1: 28, card: 80, far: 1500 }
// The labyrinth's card: one typical labyrinth (Labyrinths.typicalSite) photographed `size` px square from `elevation` above the horizon, the gate `gate` radians round from the camera. `count` cards at most stand at once.
const FAR_CARD = { elevation: (35 * Math.PI) / 180, gate: 0.7, size: 256, count: 40 }
// Pool ids: three of the largest labyrinths (~4400 posts) at once. The card claim is what can stand in the card band.
const POOL = 14000
export const PALISADE_CARDS = 10000
const VARIANTS = 4
const CAPS = [600, 2000]
// Metres the eye moves before the posts are rebucketed.
const REBUCKET = 1
// Two gate torches and the beacon per labyrinth, three labyrinths in reach.
const TORCHES = 9
const FLAME = { height: 0.34, radius: 0.1 }
// The towers' decks and ladders across the labyrinths in reach.
const FIXTURES = 24
// The ladder's rails stand this far over the deck, the handhold for stepping off.
export const LADDER_OVER = 1
// The egg's metres tall on the plinth.
const EGG_TALL = 0.5
// Metres under a post's top her feet may be and still stand on it rather than be walled by it.
const ON_TOP = 0.05
const DECK_THICK = 0.18
export const GATE_LIGHT = 0.5
// The walker's torch pole is a stake this wide.
const POLE_R = 0.12
// Each post's variety off its roll; its girth and height share are the record's (layers/labyrinths.js POST_GIRTH, TOWER), and a tower's post stands plumb. The lean (radians) and shift (metres) are mostly across the wall: `along` leans it into a neighbour, so it stays small enough that the shafts only kiss.
export const POST_VARY = { height: [0.9, 1.08], lean: 0.1, along: 0.02, shift: 0.04, shade: [0.84, 1.14], warm: 0.12 }
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _ql = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _along = new THREE.Vector3()
const _c = new THREE.Color()
const _n = new THREE.Vector3()
const _u = new THREE.Vector3()
const _r = new THREE.Vector3()
const _nm = new THREE.Matrix3()
const _sites = []
const _spanBuf = new Float64Array(8)
const TAU = Math.PI * 2

/** Post `i` of a Labyrinths.postsOf record standing on ground height `y`, into `matrix` and `color`; returns its variant. The bench places its wall through this too. */
export function postPose(posts, i, y, matrix, color) {
  const k = i * POST_STRIDE
  const tx = posts[k + 2], tz = posts[k + 3], roll = posts[k + 5], tall = posts[k + 7]
  const V = POST_VARY
  const rand = mulberry32(Math.floor(roll * 0x7fffffff))
  const lerp = ([a, b], t) => a + (b - a) * t
  const wall = tall === 1 ? 1 : 0
  const across = (rand() * 2 - 1) * V.shift * wall
  _p.set(posts[k] - tz * across, y, posts[k + 1] + tx * across)
  _ql.setFromAxisAngle(_along.set(tx, 0, tz), (rand() * 2 - 1) * V.lean * wall)
  _q.setFromAxisAngle(_up, posts[k + 4]).premultiply(_ql)
  _ql.setFromAxisAngle(_along.set(-tz, 0, tx), (rand() * 2 - 1) * V.along * wall)
  _q.premultiply(_ql)
  const fat = posts[k + 6]
  matrix.compose(_p, _q, _s.set(fat, wall ? lerp(V.height, (roll * VARIANTS) % 1) : tall, fat))
  const shade = lerp(V.shade, rand()), warm = (rand() * 2 - 1) * V.warm
  color.setRGB(shade * (1 + warm), shade, shade * (1 - warm))
  return Math.floor(roll * VARIANTS)
}

/** Maze `m`'s fixtures standing on `ground(x, z)`, each handed to `put(kind, matrix)`: the gate torches' poles, the beacon, each tower's deck and ladder, and the altar's plinth. */
function poseFixtures(m, ground, put) {
  for (const [x, z] of m.torches) put('poles', _m.makeTranslation(x, ground(x, z), z))
  put('beacons', _m.makeTranslation(m.beacon[0], ground(m.beacon[0], m.beacon[1]), m.beacon[1]))
  for (const t of m.towers) {
    const g = ground(t.x, t.z)
    _q.setFromAxisAngle(_up, Math.atan2(-t.uz, t.ux))
    put('decks', _m.compose(_p.set(t.x, g + TOWER.deck, t.z), _q, _s.set(1, 1, 1)))
    // The ladder's plane is its local x-y: turned so x runs along the tower's v and it stands TOWER.ladderOut along u, its foot on the ground there.
    _q.setFromAxisAngle(_up, Math.atan2(-t.uz, t.ux) + Math.PI / 2)
    const lx = t.x + t.ux * TOWER.ladderOut, lz = t.z + t.uz * TOWER.ladderOut, lg = ground(lx, lz)
    put('ladders', _m.compose(_p.set(lx, lg, lz), _q, _s.set(1, (g + TOWER.deck + LADDER_OVER - lg) / (TOWER.deck + LADDER_OVER), 1)))
  }
  const al = m.altar
  _q.setFromAxisAngle(_up, Math.atan2(-al.uz, al.ux))
  put('plinths', _m.compose(_p.set(al.x, ground(al.x, al.z), al.z), _q, _s.set(1, 1, 1)))
}

/** The typical labyrinth on flat ground as one geometry in the posts' attributes, its posts at `posts` (a LOD's variants) and its fixtures off `meshes`' geometries: `{ geometry, reach, mouth }`. */
function typicalModel(labyrinths, posts, meshes) {
  const s = labyrinths.typicalSite()
  const m = labyrinths.mazeOf(s), laid = labyrinths.postsOf(s)
  const parts = []
  for (let i = 0; i < laid.length / POST_STRIDE; i++) {
    const v = postPose(laid, i, 0, _m, _c)
    parts.push([posts[v], _m.clone(), _c.clone()])
  }
  const white = new THREE.Color(1, 1, 1)
  poseFixtures(m, () => 0, (kind, matrix) => parts.push([meshes[kind].geometry, matrix.clone(), white]))
  let n = 0
  for (const [g] of parts) n += g.index ? g.index.count : g.getAttribute('position').count
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), layer = new Float32Array(n), col = new Float32Array(n * 3)
  let o = 0
  for (const [g, matrix, tint] of parts) {
    _nm.getNormalMatrix(matrix)
    const P = g.getAttribute('position'), N = g.getAttribute('normal'), U = g.getAttribute('uvProj'), L = g.getAttribute('texLayer'), C = g.getAttribute('color')
    const count = g.index ? g.index.count : P.count
    for (let k = 0; k < count; k++, o++) {
      const i = g.index ? g.index.getX(k) : k
      _p.fromBufferAttribute(P, i).applyMatrix4(matrix).toArray(pos, o * 3)
      _n.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize().toArray(nrm, o * 3)
      uv[o * 2] = U.getX(i)
      uv[o * 2 + 1] = U.getY(i)
      layer[o] = L.getX(i)
      col[o * 3] = C.getX(i) * tint.r
      col[o * 3 + 1] = C.getY(i) * tint.g
      col[o * 3 + 2] = C.getZ(i) * tint.b
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geometry.setAttribute('uvProj', new THREE.BufferAttribute(uv, 2))
  geometry.setAttribute('texLayer', new THREE.BufferAttribute(layer, 1))
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return { geometry, reach: s.reach, mouth: m.mouth }
}

export class Palisades {
  /** `labyrinths` is the biome's Labyrinths, `field` the ground the posts stand on, `cards` the LitterCards that draw the posts' far band, `egg` the altars' egg (roosts.js loadEggBank), `light` lighting.js's uniforms, whose labyrinth glow this keeps. */
  constructor(scene, { labyrinths, field, textures, patch, cards, egg, light }) {
    if (POST.radius !== POST_R) throw new Error(`Palisades: the post's radius ${POST.radius} is not the labyrinths' wall half width ${POST_R}`)
    if (POST.height !== POST_HEIGHT) throw new Error(`Palisades: the post's height ${POST.height} is not the labyrinths' ${POST_HEIGHT}`)
    if (!egg) throw new Error('Palisades: needs the egg the altars carry')
    this.labyrinths = labyrinths
    this.field = field
    this.textures = textures
    this.material = createPropMaterial(textures, { vertexColors: true })
    this.material.side = THREE.FrontSide
    patch(this.material, 'v2-palisade')
    this.lods = [0, 1].map((lod) => Array.from({ length: VARIANTS }, (_, v) => buildPalisadePost({ lod, seed: v + 1 })))
    this.litterCards = cards
    const ext = impostorCardExtents(POST_CARD_FRAME)
    this.cardPicture = cards.addPicture({ kind: 'spun', cx: 0, cy: ext.height / 2 - ext.sink, hw: ext.width / 2, hh: ext.height / 2 })
    cards.claim('palisades', PALISADE_CARDS)
    this.cardBase = 2 * VARIANTS
    this.posts = new PropArena(POOL, this.lods.map((geometries) => ({ geometries })), CAPS, this.material, 'v2-palisades', { cards: cards.meshes, cardBase: this.cardBase })
    scene.add(this.posts)
    this.cardReady = false
    this._free = []
    // Region key -> { site, posts, ids, tier }, the labyrinths whose posts are placed.
    this.active = new Map()
    this._eye = new THREE.Vector3(Infinity, 0, Infinity)

    this.poles = new THREE.InstancedMesh(buildTorchPole(), this.material, TORCHES)
    this.beacons = new THREE.InstancedMesh(buildTorchPole(BEACON.height), this.material, 3)
    this.decks = new THREE.InstancedMesh(buildTowerDeck(TOWER.deckHalf), this.material, FIXTURES)
    this.ladders = new THREE.InstancedMesh(buildLadder(TOWER.deck + LADDER_OVER, TOWER.ladderHalf), this.material, FIXTURES)
    this.plinths = new THREE.InstancedMesh(buildPlinth(ALTAR.half, ALTAR.height), this.material, 3)
    this.eggMaterial = patch(new THREE.MeshStandardMaterial({ map: egg.map, roughness: EGG_ROUGHNESS, metalness: 0 }), 'v2-palisade-egg')
    this.eggs = new THREE.InstancedMesh(egg.geometry, this.eggMaterial, 3)
    this.eggScale = EGG_TALL / egg.bounds.height
    this.fixtures = [this.poles, this.beacons, this.decks, this.ladders, this.plinths, this.eggs]
    // An instanced mesh at count 0 still issues its draw: three skips only an invisible one, so every count here sets `visible` with it.
    for (const f of this.fixtures) {
      f.count = 0
      f.visible = false
      f.frustumCulled = false
      scene.add(f)
    }
    this.flames = new TriFlames(TORCHES, { ...TRI_TORCH, ...FLAME })
    scene.add(this.flames.group)
    this.torches = []

    this.light = light
    light.uLabyrinthGlow.value = LABYRINTH_GLOW.gain * FLICKER.mean
    this.farTexture = new THREE.DataTexture(new Uint8Array(FAR_CARD.size * FAR_CARD.size * 4), FAR_CARD.size, FAR_CARD.size, THREE.RGBAFormat, THREE.UnsignedByteType)
    this.farTexture.colorSpace = THREE.SRGBColorSpace
    this.farTexture.minFilter = THREE.LinearMipmapLinearFilter
    this.farTexture.magFilter = THREE.LinearFilter
    this.farTexture.generateMipmaps = true
    this.farMaterial = patch(new THREE.MeshLambertMaterial({ map: this.farTexture, alphaTest: 0.5, side: THREE.DoubleSide }), 'v2-palisade-far')
    // A unit picture standing on its bottom edge's middle; v runs down it, as the bake's rows do.
    const plane = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)
    const uv = plane.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i))
    this.far = new THREE.InstancedMesh(plane, this.farMaterial, FAR_CARD.count)
    this.far.count = 0
    this.far.visible = false
    this.far.frustumCulled = false
    scene.add(this.far)
    this.farFrame = null
    this.stats = { labyrinths: 0, posts: 0, tiers: [0, 0, 0], far: 0 }
  }

  /** Once a frame: place and release labyrinths by the eye, rebucket the posts' tiers and stand the labyrinths' cards when it has moved, and run the flames. */
  update(eye, now) {
    const { card, far } = PALISADE_BANDS
    const near = this.labyrinths.sitesIn(eye.x - card, eye.z - card, eye.x + card, eye.z + card, _sites).filter((s) => Math.hypot(s.cx - eye.x, s.cz - eye.z) < card)
    let changed = false
    for (const [key, a] of this.active) {
      if (near.includes(a.site)) continue
      this._release(a)
      this.active.delete(key)
      changed = true
    }
    for (const s of near) {
      const key = s.rx * 0x10000 + s.rz
      if (this.active.has(key)) continue
      this.active.set(key, this._place(s))
      changed = true
    }
    if (changed) {
      this._placeFixtures()
      this._liveGlow()
    }
    if (changed || Math.hypot(eye.x - this._eye.x, eye.z - this._eye.z) > REBUCKET) {
      this._eye.copy(eye)
      this._rebucket()
      this._standFar(eye, card, far)
    }
    this.flames.update(now, [1, 1, 1])
  }

  _place(s) {
    const posts = this.labyrinths.postsOf(s)
    const n = posts.length / POST_STRIDE
    const ids = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const variant = postPose(posts, i, this.field.heightAt(posts[i * POST_STRIDE], posts[i * POST_STRIDE + 1]), _m, _c)
      const id = this._free.length > 0 ? this._free.pop() : this.posts.addInstance(variant)
      this.posts.setGeometryIdAt(id, variant)
      this.posts.setMatrixAt(id, _m)
      this.posts.setColorAt(id, _c)
      this.posts.setLayerShiftAt(id, this.cardPicture)
      ids[i] = id
    }
    return { site: s, posts, ids, tier: new Int8Array(n).fill(-1) }
  }

  _release(a) {
    for (const id of a.ids) {
      this.posts.setVisibleAt(id, false)
      this._free.push(id)
    }
  }

  _rebucket() {
    const { lod0, lod1 } = PALISADE_BANDS
    const e = this._eye
    const tiers = this.stats.tiers
    tiers.fill(0)
    let posts = 0
    for (const a of this.active.values()) {
      const p = a.posts
      for (let i = 0; i < a.ids.length; i++) {
        const d2 = (p[i * POST_STRIDE] - e.x) ** 2 + (p[i * POST_STRIDE + 1] - e.z) ** 2
        let tier = d2 < lod0 * lod0 ? 0 : d2 < lod1 * lod1 ? 1 : this.cardReady ? 2 : -1
        const id = a.ids[i]
        if (tier !== a.tier[i]) {
          if (tier < 0) this.posts.setVisibleAt(id, false)
          else {
            const variant = Math.floor(p[i * POST_STRIDE + 5] * VARIANTS)
            // A full mesh refuses: the post keeps the tier it had, a rung coarse or fine rather than missing.
            if (this.posts.setGeometryIdAt(id, tier === 2 ? this.cardBase : tier * VARIANTS + variant) && this.posts.setVisibleAt(id, true)) a.tier[i] = tier
            else tier = a.tier[i]
          }
          if (tier < 0) a.tier[i] = -1
        }
        if (tier >= 0) { tiers[tier]++; posts++ }
      }
    }
    this.stats.labyrinths = this.active.size
    this.stats.posts = posts
  }

  // The gate torches, the beacons, the towers' decks and ladders and the altars of the labyrinths placed.
  _placeFixtures() {
    this.torches.length = 0
    const meshes = { poles: this.poles, beacons: this.beacons, decks: this.decks, ladders: this.ladders, plinths: this.plinths }
    const c = { poles: 0, beacons: 0, decks: 0, ladders: 0, plinths: 0 }
    const ground = (x, z) => this.field.heightAt(x, z)
    for (const a of this.active.values()) {
      const m = this.labyrinths.mazeOf(a.site)
      poseFixtures(m, ground, (kind, matrix) => {
        if (c[kind] >= meshes[kind].instanceMatrix.count) throw new Error(`Palisades: more ${kind} in reach than ${meshes[kind].instanceMatrix.count}`)
        meshes[kind].setMatrixAt(c[kind]++, matrix)
      })
      for (const [x, z] of [...m.torches, m.beacon]) {
        const top = x === m.beacon[0] && z === m.beacon[1] ? BEACON.height : TORCH_POLE.height
        this.torches.push({ x, y: ground(x, z) + top, z, phase: (x * 0.37 + z * 0.61) % TAU })
      }
      const al = m.altar
      _q.setFromAxisAngle(_along.set(al.ux, 0, al.uz), 0.12)
      this.eggs.setMatrixAt(c.plinths - 1, _m.compose(_p.set(al.x, ground(al.x, al.z) + ALTAR.height + EGG_TALL / 2 - 0.03, al.z), _q, _s.setScalar(this.eggScale)))
      this.eggs.setColorAt(c.plinths - 1, _c.setHex(EGG_TINTS[(a.site.rx * 7 + a.site.rz * 13 + 1000) % EGG_TINTS.length][1]))
    }
    if (this.torches.length > TORCHES) throw new Error(`Palisades: ${this.torches.length} torches in reach, room for ${TORCHES}`)
    this.flames.count = 0
    this.torches.forEach((t, i) => this.flames.place(i, t.x, t.y, t.z, { ...FLAME, phase: t.phase }))
    for (const kind in meshes) meshes[kind].count = c[kind]
    this.eggs.count = c.plinths
    for (const f of this.fixtures) {
      f.visible = f.count > 0
      f.instanceMatrix.needsUpdate = true
      if (f.instanceColor) f.instanceColor.needsUpdate = true
    }
  }

  // Hand each placed labyrinth's ground glow to its live torches (hearth-light.js LABYRINTH_GLOW).
  _liveGlow() {
    const live = this.light.uLabyrinthLive.value
    if (this.active.size > live.length) throw new Error(`Palisades: ${this.active.size} labyrinths placed, uLabyrinthLive holds ${live.length}`)
    for (const v of live) v.set(0, 0, 0, 0)
    let i = 0
    for (const a of this.active.values()) live[i++].set(a.site.cx, a.site.cz, a.site.reach + LABYRINTH_GLOW.reach, 0)
  }

  // A card for each labyrinth whose centre is from `card` to `far` off the eye: the photograph stood on the near rim of its reach and faced to the eye, as wide as the labyrinth and as tall as it would look from the eye's elevation, up to the photograph's own.
  _standFar(eye, card, far) {
    let n = 0
    if (this.farFrame !== null) {
      const F = this.farFrame
      for (const s of this.labyrinths.sitesIn(eye.x - far, eye.z - far, eye.x + far, eye.z + far, _sites)) {
        const dx = eye.x - s.cx, dz = eye.z - s.cz, d = Math.hypot(dx, dz)
        if (d < card || d >= far) continue
        if (n >= FAR_CARD.count) throw new Error(`Palisades: more than ${FAR_CARD.count} labyrinth cards in reach`)
        const k = s.reach / F.reach, fx = dx / d, fz = dz / d
        const rx = s.cx + fx * F.reach * k, rz = s.cz + fz * F.reach * k
        const rim = this.field.heightAt(rx, rz)
        const up = Math.max(0, Math.atan2(eye.y - this.field.heightAt(s.cx, s.cz), d))
        const tall = Math.min(F.top - F.bottom, 2 * F.reach * Math.sin(up) + F.height * Math.cos(up)) * k
        _n.set(fx * Math.cos(up), Math.sin(up), fz * Math.cos(up))
        _u.set(-fx * Math.sin(up), Math.cos(up), -fz * Math.sin(up))
        _r.crossVectors(_u, _n)
        _m.makeBasis(_r.multiplyScalar(2 * F.half * k), _u.multiplyScalar(tall), _n).setPosition(rx, rim, rz)
        this.far.setMatrixAt(n++, _m)
      }
    }
    this.far.count = n
    this.far.visible = n > 0
    this.far.instanceMatrix.needsUpdate = true
    this.stats.far = n
  }

  /** The tower whose ladder (x, z) stands at, as `{ x, z, ux, uz, bottom, top }`: its foot within `reach` of the climber's spot TOWER.foot out along u, `bottom` the ground there and `top` the deck. Else null. */
  ladderAt(x, z, reach) {
    const s = this.labyrinths.siteAt(x, z)
    if (s === null || Math.hypot(x - s.cx, z - s.cz) > s.reach) return null
    for (const t of this.labyrinths.mazeOf(s).towers) {
      const fx = t.x + t.ux * TOWER.foot, fz = t.z + t.uz * TOWER.foot
      if (Math.hypot(x - fx, z - fz) > reach) continue
      return { x: fx, z: fz, ux: t.ux, uz: t.uz, bottom: this.field.heightAt(fx, fz), top: this.field.heightAt(t.x, t.z) + TOWER.deck }
    }
    return null
  }

  /** The rungs of the ladder nearest (x, y, z) within `reach`, as the ladder (ladderAt) with `rung` the grip height nearest y; else null. A hand's grab. */
  rungAt(x, y, z, reach) {
    const s = this.labyrinths.siteAt(x, z)
    if (s === null || Math.hypot(x - s.cx, z - s.cz) > s.reach) return null
    for (const t of this.labyrinths.mazeOf(s).towers) {
      const lx = t.x + t.ux * TOWER.ladderOut, lz = t.z + t.uz * TOWER.ladderOut
      const across = Math.abs(-(x - lx) * t.uz + (z - lz) * t.ux), out = Math.abs((x - lx) * t.ux + (z - lz) * t.uz)
      if (across > TOWER.ladderHalf + reach || out > reach) continue
      const ground = this.field.heightAt(lx, lz), top = this.field.heightAt(t.x, t.z) + TOWER.deck + LADDER_OVER
      if (y < ground || y > top + reach) continue
      const fx = t.x + t.ux * TOWER.foot, fz = t.z + t.uz * TOWER.foot
      return { x: fx, z: fz, ux: t.ux, uz: t.uz, bottom: this.field.heightAt(fx, fz), top: top - LADDER_OVER, rung: ground + Math.max(1, Math.round((y - ground) / RUNG)) * RUNG }
    }
    return null
  }

  /** Whether her feet at `foot` on (x, z) are on a wall's top: then `out` is the unit across that wall. */
  onWallTop(x, z, foot, out) {
    if (!this.labyrinths.wallAcross(x, z, out)) return false
    return foot >= this.field.heightAt(x, z) + POST.height - ON_TOP
  }

  /** The gate torches' lights for main.js updateFire, pushed onto `out` as its torch entries; `reach` is a hand torch's, a gate torch's is GATE_LIGHT of it. */
  torchLights(head, now, reach, out) {
    for (const t of this.torches) {
      out.push({ x: t.x, y: t.y + 0.15, z: t.z, strength: flicker(now, t.phase), reach: reach * GATE_LIGHT, d: Math.hypot(t.x - head.x, t.y - head.y, t.z - head.z) })
    }
  }

  /** Photograph a LOD0 post side-on into the post card, and the typical labyrinth into its card, and start drawing both. Once per room, after the atlas' images are in. */
  bakeCard(renderer) {
    const { pixels } = bakeImpostor(renderer, this.lods[0][0], this.textures, null, { ...POST_CARD_FRAME, vertexColors: true })
    this.litterCards.setPixels(this.cardPicture, tonePostCard(pixels))
    this.cardReady = true
    const model = typicalModel(this.labyrinths, this.lods[1], { poles: this.poles, beacons: this.beacons, decks: this.decks, ladders: this.ladders, plinths: this.plinths })
    const E = FAR_CARD.elevation, F = { reach: model.reach, height: TOWER.height, half: model.reach }
    F.bottom = -F.reach * Math.sin(E)
    F.top = F.reach * Math.sin(E) + F.height * Math.cos(E)
    const azimuth = Math.atan2(model.mouth[0], model.mouth[1]) + FAR_CARD.gate
    const far = bakeImpostorView(renderer, model.geometry, this.textures, { half: F.half, bottom: F.bottom, top: F.top, elevation: E, azimuth, size: FAR_CARD.size, vertexColors: true })
    model.geometry.dispose()
    this.farTexture.image.data.set(tonePostCard(far))
    this.farTexture.needsUpdate = true
    this.farFrame = F
    this._eye.set(Infinity, 0, Infinity)
  }

  // Stone spans on (x, z) into `out` as [bottom, top] pairs, `foot` her foot height or undefined. A post or pole is sheer (DESIGN.md §41) while her feet are under its top: its span runs to Infinity, so no reach finds its top and no stride climbs it. Asked without a foot (ceilingAt, a teleport's landing), every top is its own.
  _spans(x, z, foot, out) {
    const s = this.labyrinths.siteAt(x, z)
    if (s === null || Math.hypot(x - s.cx, z - s.cz) > s.reach || out.length < 2) return 0
    const g = this.field.heightAt(x, z)
    let n = 0
    const put = (lo, hi, sheer) => {
      if (n * 2 + 1 >= out.length) { n++; return }
      out[n * 2] = lo
      out[n * 2 + 1] = sheer && foot !== undefined && foot < hi - ON_TOP ? Infinity : hi
      n++
    }
    if (this.labyrinths.wallAt(x, z)) put(g - POST.bury, g + POST.height, true)
    const m = this.labyrinths.mazeOf(s)
    for (const [tx, tz] of m.torches) if ((x - tx) ** 2 + (z - tz) ** 2 < POLE_R * POLE_R) put(g - TORCH_POLE.bury, g + TORCH_POLE.height, true)
    if ((x - m.beacon[0]) ** 2 + (z - m.beacon[1]) ** 2 < POLE_R * POLE_R) put(g - TORCH_POLE.bury, g + BEACON.height, true)
    const post = (POST_R * TOWER.girth) ** 2
    for (const t of m.towers) {
      const u = (x - t.x) * t.ux + (z - t.z) * t.uz, v = -(x - t.x) * t.uz + (z - t.z) * t.ux
      if (Math.abs(u) > TOWER.deckHalf || Math.abs(v) > TOWER.deckHalf) continue
      const deck = this.field.heightAt(t.x, t.z) + TOWER.deck
      put(deck - DECK_THICK, deck, false)
      for (const [cx, cz] of t.corners) if ((x - cx) ** 2 + (z - cz) ** 2 < post) put(g - POST.bury, g + TOWER.height, true)
    }
    const al = m.altar
    const au = (x - al.x) * al.ux + (z - al.z) * al.uz, av = -(x - al.x) * al.uz + (z - al.z) * al.ux
    if (Math.abs(au) < ALTAR.half && Math.abs(av) < ALTAR.half) put(g - 0.2, this.field.heightAt(al.x, al.z) + ALTAR.height, false)
    return n
  }

  columnAt(x, z, _minSize, out, foot) {
    return this._spans(x, z, foot, out)
  }

  blockTopAt(x, z) {
    const n = this._spans(x, z, undefined, _spanBuf)
    let top = -Infinity
    for (let i = 0; i < Math.min(n, _spanBuf.length / 2); i++) top = Math.max(top, _spanBuf[i * 2 + 1])
    return top
  }

  dispose() {
    this.light.uLabyrinthGlow.value = 0
    for (const v of this.light.uLabyrinthLive.value) v.set(0, 0, 0, 0)
    this.far.removeFromParent()
    this.far.geometry.dispose()
    this.farMaterial.dispose()
    this.farTexture.dispose()
    this.posts.removeFromParent()
    this.flames.group.removeFromParent()
    this.posts.dispose()
    for (const tier of this.lods) for (const g of tier) g.dispose()
    for (const f of this.fixtures) {
      f.removeFromParent()
      if (f !== this.eggs) f.geometry.dispose()
    }
    this.eggMaterial.dispose()
    this.flames.dispose()
    this.material.dispose()
  }
}
