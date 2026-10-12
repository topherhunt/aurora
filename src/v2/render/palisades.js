// The labyrinths' palisades (DESIGN.md §41): posts stood along each labyrinth's wall lines (layers/labyrinths.js) only while the eye is within PALISADE_BANDS.card of them, swapped LOD0 / LOD1 / the shared card by distance, and the two torches at each gate. Stone to the walker along the lines themselves, placed posts or none.
import THREE from '../../three-instance.js'
import { createPropMaterial } from '../../material.js'
import { bakeImpostor, impostorCardExtents } from '../../props/impostor.js'
import { POST, POST_CARD_FRAME, TORCH_POLE, buildPalisadePost, buildTorchPole, tonePostCard } from '../../props/palisade.js'
import { POST_R, POST_STRIDE } from '../layers/labyrinths.js'
import { mulberry32 } from '../../sim/mathx.js'
import { PropArena } from './prop-arena.js'
import { TriFlames, TRI_TORCH } from './fire-tris.js'
import { flicker } from './fire.js'

// Metres from the eye: LOD0 inside lod0, LOD1 inside lod1, the card inside `card`, nothing past it.
export const PALISADE_BANDS = { lod0: 10, lod1: 28, card: 80 }
// Pool ids: three of the largest labyrinths (~4400 posts) at once. The card claim is what can stand in the card band.
const POOL = 14000
export const PALISADE_CARDS = 10000
const VARIANTS = 4
const CAPS = [600, 2000]
// Metres the eye moves before the posts are rebucketed.
const REBUCKET = 1
const TORCHES = 6
const FLAME = { height: 0.34, radius: 0.1 }
export const GATE_LIGHT = 0.5
// The walker's torch pole is a stake this wide.
const POLE_R = 0.12
// Each post's variety off its roll. Girth never under fat[0], so the widest crack stays under 5 cm (props/palisade.js POST.rough); the lean (radians) and the shift (metres) are across the wall only, since either along it would open a crack.
export const POST_VARY = { height: [0.92, 1.06], fat: [0.97, 1.15], lean: 0.045, shift: 0.025, shade: [0.86, 1.12], warm: 0.1 }
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _ql = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _along = new THREE.Vector3()
const _c = new THREE.Color()
const _sites = []

/** Post `i` of a Labyrinths.postsOf record standing on ground height `y`, into `matrix` and `color`; returns its variant. The bench places its wall through this too. */
export function postPose(posts, i, y, matrix, color) {
  const k = i * POST_STRIDE
  const tx = posts[k + 2], tz = posts[k + 3], roll = posts[k + 5]
  const V = POST_VARY
  const rand = mulberry32(Math.floor(roll * 0x7fffffff))
  const lerp = ([a, b], t) => a + (b - a) * t
  const across = (rand() * 2 - 1) * V.shift
  _p.set(posts[k] - tz * across, y, posts[k + 1] + tx * across)
  _ql.setFromAxisAngle(_along.set(tx, 0, tz), (rand() * 2 - 1) * V.lean)
  _q.setFromAxisAngle(_up, posts[k + 4]).premultiply(_ql)
  const fat = lerp(V.fat, rand())
  matrix.compose(_p, _q, _s.set(fat, lerp(V.height, (roll * VARIANTS) % 1), fat))
  const shade = lerp(V.shade, rand()), warm = (rand() * 2 - 1) * V.warm
  color.setRGB(shade * (1 + warm), shade, shade * (1 - warm))
  return Math.floor(roll * VARIANTS)
}

export class Palisades {
  /** `labyrinths` is the biome's Labyrinths, `field` the ground the posts stand on, `cards` the LitterCards that draw the far band. */
  constructor(scene, { labyrinths, field, textures, patch, cards }) {
    if (POST.radius !== POST_R) throw new Error(`Palisades: the post's radius ${POST.radius} is not the labyrinths' wall half width ${POST_R}`)
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
    this.poles.count = 0
    this.poles.frustumCulled = false
    scene.add(this.poles)
    this.flames = new TriFlames(TORCHES, { ...TRI_TORCH, ...FLAME })
    scene.add(this.flames.group)
    this.torches = []
    this.stats = { labyrinths: 0, posts: 0, tiers: [0, 0, 0] }
  }

  /** Once a frame: place and release labyrinths by the eye, rebucket the posts' tiers when it has moved, and run the flames. */
  update(eye, now) {
    const reachOut = PALISADE_BANDS.card
    const near = this.labyrinths.sitesIn(eye.x - reachOut, eye.z - reachOut, eye.x + reachOut, eye.z + reachOut, _sites)
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
    if (changed) this._placeTorches()
    if (changed || Math.hypot(eye.x - this._eye.x, eye.z - this._eye.z) > REBUCKET) {
      this._eye.copy(eye)
      this._rebucket()
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
    const { lod0, lod1, card } = PALISADE_BANDS
    const e = this._eye
    const tiers = this.stats.tiers
    tiers.fill(0)
    let posts = 0
    for (const a of this.active.values()) {
      const p = a.posts
      for (let i = 0; i < a.ids.length; i++) {
        const d2 = (p[i * POST_STRIDE] - e.x) ** 2 + (p[i * POST_STRIDE + 1] - e.z) ** 2
        let tier = d2 < lod0 * lod0 ? 0 : d2 < lod1 * lod1 ? 1 : d2 < card * card && this.cardReady ? 2 : -1
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

  _placeTorches() {
    this.torches.length = 0
    for (const a of this.active.values()) {
      for (const [x, z] of this.labyrinths.mazeOf(a.site).torches) {
        this.torches.push({ x, y: this.field.heightAt(x, z) + TORCH_POLE.height, z, phase: (x * 0.37 + z * 0.61) % (Math.PI * 2) })
      }
    }
    if (this.torches.length > TORCHES) throw new Error(`Palisades: ${this.torches.length} gate torches in reach, room for ${TORCHES}`)
    this.flames.count = 0
    this.torches.forEach((t, i) => {
      this.poles.setMatrixAt(i, _m.makeTranslation(t.x, t.y - TORCH_POLE.height, t.z))
      this.flames.place(i, t.x, t.y, t.z, { ...FLAME, phase: t.phase })
    })
    this.poles.count = this.torches.length
    this.poles.instanceMatrix.needsUpdate = true
  }

  /** The gate torches' lights for main.js updateFire, pushed onto `out` as its torch entries; `reach` is a hand torch's, a gate torch's is GATE_LIGHT of it. */
  torchLights(head, now, reach, out) {
    for (const t of this.torches) {
      out.push({ x: t.x, y: t.y + 0.15, z: t.z, strength: flicker(now, t.phase), reach: reach * GATE_LIGHT, d: Math.hypot(t.x - head.x, t.y - head.y, t.z - head.z) })
    }
  }

  /** Photograph a LOD0 post side-on into the card picture and start drawing the far band. Once per room, after the atlas' images are in. */
  bakeCard(renderer) {
    const { pixels } = bakeImpostor(renderer, this.lods[0][0], this.textures, null, { ...POST_CARD_FRAME, vertexColors: true })
    this.litterCards.setPixels(this.cardPicture, tonePostCard(pixels))
    this.cardReady = true
    this._eye.set(Infinity, 0, Infinity)
  }

  // The top of the post or torch pole on (x, z), or null: a wall line within a post's radius, or a pole.
  _standing(x, z) {
    if (this.labyrinths.wallAt(x, z)) return POST.height
    const s = this.labyrinths.siteAt(x, z)
    if (s === null || Math.hypot(x - s.cx, z - s.cz) > s.reach) return null
    for (const [tx, tz] of this.labyrinths.mazeOf(s).torches) if ((x - tx) ** 2 + (z - tz) ** 2 < POLE_R * POLE_R) return TORCH_POLE.height
    return null
  }

  // Sheer to the walker (DESIGN.md §41): a post's span runs to Infinity when asked so, so no reach finds its top and no stride climbs it.
  columnAt(x, z, _minSize, out, sheer) {
    const top = this._standing(x, z)
    if (top === null || out.length < 2) return 0
    const g = this.field.heightAt(x, z)
    out[0] = g - POST.bury
    out[1] = sheer ? Infinity : g + top
    return 1
  }

  blockTopAt(x, z) {
    const top = this._standing(x, z)
    return top === null ? -Infinity : this.field.heightAt(x, z) + top
  }

  dispose() {
    this.posts.removeFromParent()
    this.poles.removeFromParent()
    this.flames.group.removeFromParent()
    this.posts.dispose()
    for (const tier of this.lods) for (const g of tier) g.dispose()
    this.poles.geometry.dispose()
    this.flames.dispose()
    this.material.dispose()
  }
}
