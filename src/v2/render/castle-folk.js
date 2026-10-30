// A castle's household and garrison (design/44-castles.md §Garrison), local to this client and set by the clock: inside, the lord
// and his steward in the throne hall, a cook and the kitchen maid who talks of the dungeon, servants at their chores and a guard;
// outside, guards pacing the wall walks, two at the gate, one at the well, and two travellers on the trail to the roads. Each wears
// one of the townsfolk's bodies (public/creatures/<id>.glb), its second-richest tier, facing +X under its yaw as the ghost does.

import THREE from '../../three-instance.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { CASTLE, castleLayout } from '../castles/layout.js'
import { courtProps, keyChamber, roomPlan, roomProps } from '../castles/furnish.js'
import { interiorLight } from '../castles/light.js'
import { toLocal, toWorld } from '../layers/castles.js'
import { hash32 } from '../../sim/score.js'
import { gltfLoader } from './critters.js'
import { INNER_LIGHT } from './castles.js'

export const FOLK = {
  size: 1.75,
  sizeVar: 0.04,
  // Metres a second on the walls and the trail; seconds a rampart guard stands at each end, and a traveller spends in town.
  pace: 0.9,
  trail: 1.05,
  turnS: 4,
  awayS: 150,
  // The outside cast is drawn while she is within `drawM` of the castle.
  drawM: 140,
  // The maid speaks as she comes within `near` m (times her size).
  near: 2.6,
  // Clear metres round a chamber stand: from a prop's footprint, and from a portal.
  clear: 0.45,
  portal: 1.4,
}

// Who is inside: their body, the chamber roles they may stand in (first found), what they stand by, and their clip.
const INSIDE = [
  { who: 'lord', body: 'jarlsthane', rooms: ['throne'], by: 'dais', clip: 'idle' },
  { who: 'steward', body: 'skald', rooms: ['throne'], by: 'steward', clip: 'talk-gesture' },
  { who: 'cook', body: 'farmer', rooms: ['kitchen'], by: ['hearth', 'oven', 'cauldron'], clip: 'gather' },
  { who: 'maid', body: 'innkeeper', rooms: ['kitchen'], by: ['table'], clip: 'idle' },
  { who: 'servant', body: 'shepherd', rooms: ['mess', 'library'], by: ['dresser', 'shelf', 'longtable', 'table'], clip: 'gather' },
  { who: 'servant', body: 'herbalist', rooms: ['bedchamber', 'guest'], by: ['fourposter', 'wardrobe', 'bed'], clip: 'gather' },
  { who: 'servant', body: 'healer', rooms: ['pantry', 'cellar', 'store', 'granary'], by: ['barrel', 'sacks', 'grain', 'cask'], clip: 'gather' },
  { who: 'guard', body: 'guard', rooms: ['barracks', 'armoury', 'guard'], by: ['rack', 'anvil', 'grind', 'bunk'], clip: 'idle' },
]
const WALL_GUARDS = ['shieldmaiden', 'battlemage', 'guard']
const GATE_GUARDS = ['guard', 'shieldmaiden']
const TRAVELLERS = ['hunter', 'trapper']
// Props a stand may overlap: flat on the floor, or on the wall above head height.
const UNDERFOOT = new Set(['rug', 'carpet', 'chandelier', 'sconce', 'banner', 'tapestry', 'herbs', 'hams', 'chains', 'shields'])

const SH = CASTLE.storey * CASTLE.tall
const frame = (o, u, v) => [o.x + u * Math.cos(o.yaw) + v * Math.sin(o.yaw), o.z - u * Math.sin(o.yaw) + v * Math.cos(o.yaw)]
const facing = (nx, nz) => Math.atan2(-nz, nx)

/** What the kitchen maid says in castle `lay`: the ghost she has seen when it `haunted`, the noises below, and while the dungeon is
 * still locked where its key is said to be (keyChamber). */
export function maidSays(lay, haunted, unlocked) {
  if (unlocked) return 'You went down the dungeons? Rather you than me. I still hear it, some nights.'
  const hint = { throne: 'The lord keeps its key about his hall.', treasury: 'Its key lies in the treasury, they say.', bedchamber: 'The lord keeps its key in his bedchamber.' }[keyChamber(lay).c.role]
  return `${haunted ? 'I saw a ghost, all white and drifting! ' : ''}Things scratch and moan behind the dungeon door at night. ${hint}`
}

/** A stand in chamber `c` of the props `props`: the clear floor point nearest `want` (interior [x, z]), kept from `taken`. */
function standIn(c, props, taken, want) {
  const [x0, z0, x1, z1] = c.rect, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, near = props.filter((o) => o.k === c.k && !UNDERFOOT.has(o.kind))
  let best = null, bestD = Infinity
  for (let x = x0 + 0.5; x <= x1 - 0.5; x += 0.25) for (let z = z0 + 0.5; z <= z1 - 0.5; z += 0.25) {
    if (c.round && Math.hypot(x - cx, z - cz) > (x1 - x0) / 2 - 0.6) continue
    if (c.portals.some((p) => Math.hypot(p[0] - x, p[1] - z) < FOLK.portal)) continue
    if (taken.some((t) => Math.hypot(t[0] - x, t[1] - z) < 1.1)) continue
    if (near.some((o) => {
      const dx = x - o.x, dz = z - o.z, u = dx * Math.cos(o.yaw) - dz * Math.sin(o.yaw), v = dx * Math.sin(o.yaw) + dz * Math.cos(o.yaw)
      return Math.hypot(Math.max(0, Math.abs(u) - o.w / 2), Math.max(0, Math.abs(v) - o.d / 2)) < FOLK.clear
    })) continue
    const d = Math.hypot(x - want[0], z - want[1])
    if (d < bestD) { bestD = d; best = [x, z] }
  }
  return best
}

/** The inside cast of `lay`, in interior metres: `{ who, body, clip, x, y, z, h }`, h the local heading. */
export function insideCast(lay) {
  const { chambers } = roomPlan(lay), props = roomProps(lay), taken = [], out = []
  for (const p of INSIDE) {
    const c = p.rooms.map((r) => chambers.find((q) => q.role === r)).find((q) => q !== undefined)
    if (c === undefined) continue
    const y = c.k * SH, mine = props.filter((o) => o.k === c.k && o.x > c.rect[0] && o.x < c.rect[2] && o.z > c.rect[1] && o.z < c.rect[3])
    const dais = mine.find((o) => o.kind === 'dais')
    if (p.by === 'dais' && dais !== undefined) {
      // On the dais at the throne's side, looking down the hall.
      const [x, z] = frame(dais, Math.min(1, dais.w / 2 - 0.35), -0.2)
      out.push({ ...p, x, y: y + 0.3, z, h: facing(Math.sin(dais.yaw), Math.cos(dais.yaw)) })
      taken.push([x, z])
      continue
    }
    let want = [(c.rect[0] + c.rect[2]) / 2, (c.rect[1] + c.rect[3]) / 2], look = null
    if (p.by === 'steward' && dais !== undefined) { want = frame(dais, 0, dais.d / 2 + 1.4); look = [dais.x, dais.z] }
    else if (Array.isArray(p.by)) {
      const o = mine.filter((q) => p.by.includes(q.kind)).sort((a, b) => Math.hypot(a.x - want[0], a.z - want[1]) - Math.hypot(b.x - want[0], b.z - want[1]))[0]
      if (o !== undefined) { want = frame(o, 0, o.d / 2 + 0.55); look = [o.x, o.z] }
    }
    const at = standIn(c, props, taken, want)
    if (at === null) continue
    taken.push(at)
    const [lx, lz] = look === null ? [want[0] + 1, want[1]] : look
    out.push({ ...p, x: at[0], y, z: at[1], h: look === null ? facing(Math.cos(lay.seed), Math.sin(lay.seed)) : facing(lx - at[0], lz - at[1]) })
  }
  return out
}

/** The outside cast of `lay` in exterior metres, heights unset: on the longest wall walks a guard pacing `{ path: [[x, z], [x, z]] }`
 * (or on one cell, standing to look out), gate and well stands, and travellers along `trail` ([[x, y, z, w]] world) converted by `site`. */
export function outsideCast(lay, site, trail) {
  const out = [], span = (n) => Math.max(n.sec.w, n.sec.d)
  const walks = lay.nodes.filter((n) => n.kind === 'walk').sort((p, q) => span(q) - span(p))
  walks.slice(0, WALL_GUARDS.length).forEach((n, i) => {
    const s = n.sec, a = [lay.X(s.x0), lay.Z(s.z0)], b = [lay.X(s.x0 + s.w), lay.Z(s.z0 + s.d)], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const alongX = s.w > s.d, half = (alongX ? b[0] - a[0] : b[1] - a[1]) / 2 - 1.5
    if (half < 1) { out.push({ who: 'watch', body: WALL_GUARDS[i], clip: 'idle', x: mid[0], z: mid[1], h: facing(mid[0], mid[1]) }); return }
    const path = alongX ? [[mid[0] - half, mid[1]], [mid[0] + half, mid[1]]] : [[mid[0], mid[1] - half], [mid[0], mid[1] + half]]
    out.push({ who: 'watch', body: WALL_GUARDS[i], clip: 'walk', path, x: mid[0], z: mid[1], h: 0 })
  })
  const entry = lay.nodes.find((n) => n.kind === 'entry')
  GATE_GUARDS.forEach((body, i) => out.push({ who: 'gate', body, clip: 'idle', x: entry.pos[0] + (i ? 2.2 : -2.2), z: entry.pos[2] - 3, h: facing(0, 1) }))
  const well = courtProps(lay).find((o) => o.kind === 'well')
  if (well !== undefined) out.push({ who: 'yard', body: 'woodcutter', clip: 'gather', x: well.x + 1.35, z: well.z, h: facing(-1, 0) })
  if (trail !== null) {
    const pts = trail.map((p) => { const [x, z] = toLocal(site, p[0], p[2]); return [x, p[1] - site.y, z] })
    TRAVELLERS.forEach((body, i) => out.push({ who: 'traveller', body, clip: 'walk', trail: pts, offset: i * 0.5, x: pts[0][0], z: pts[0][2], h: 0 }))
  }
  return out
}

export class CastleFolk {
  /** `castles` render/castles.js Castles; `ground(x, z)` the overworld's ground or stone top; `patch(material, cacheKey)` the
   * lighting's vertex patch; `trails` the keep trails' road records (layers/castles.js planCastles, `{ id, pts }`). */
  constructor(scene, { castles, ground, patch, trails }) {
    this.scene = scene
    this.castles = castles
    this.ground = ground
    this.patch = patch
    this.trails = trails
    this.bodies = new Map()
    this.inner = new THREE.Group()
    this.outer = new THREE.Group()
    this.inner.name = 'v2-castle-folk-inside'
    this.outer.name = 'v2-castle-folk-outside'
    scene.add(this.inner, this.outer)
    // Each cast: the site it is for, its lay, and its people `{ spec, obj, mixer, actions, clip }`.
    this.inside = null
    this.outside = null
    this.maidSpoke = false
  }

  /** The body `id`'s GLB, loaded once. */
  _body(id) {
    if (!this.bodies.has(id)) this.bodies.set(id, gltfLoader().then((l) => l.loadAsync(`creatures/${id}.glb`)))
    return this.bodies.get(id)
  }

  /** Into `group`, a cast of `specs` for site `site`, each dressed in `material(spec, map)` as its body loads. */
  _cast(site, lay, specs, group, material) {
    for (const o of [...group.children]) this._drop(o)
    const cast = { site, lay, people: [] }
    specs.forEach((spec, i) => {
      const p = { spec, obj: null, mixer: null, actions: null, clip: null }
      cast.people.push(p)
      this._body(spec.body).then((gltf) => {
        if (group.userData.cast !== cast) return
        const obj = cloneSkinned(gltf.scene), skinned = []
        obj.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o) })
        if (!skinned.length) throw new Error(`CastleFolk: creatures/${spec.body}.glb carries no skinned mesh`)
        skinned.sort((a, b) => b.geometry.index.count - a.geometry.index.count)
        const tier = skinned[Math.min(1, skinned.length - 1)]
        for (const m of skinned) {
          m.visible = m === tier
          m.frustumCulled = false
          if (m === tier) m.material = material(spec, m.material.map)
        }
        p.mixer = new THREE.AnimationMixer(obj)
        p.actions = new Map(gltf.animations.map((c) => [c.name, p.mixer.clipAction(c)]))
        for (const name of ['idle', 'walk', spec.clip]) if (!p.actions.has(name)) throw new Error(`CastleFolk: creatures/${spec.body}.glb has no ${name} clip`)
        p.mixer.update(0)
        obj.updateMatrixWorld(true)
        const box = new THREE.Box3().setFromObject(tier), size = FOLK.size * (1 + FOLK.sizeVar * (((hash32(site.seed, i) % 200) / 100) - 1))
        const body = new THREE.Group()
        obj.scale.setScalar(size / (box.max.y - box.min.y))
        obj.position.y = -box.min.y * obj.scale.y
        body.add(obj)
        body.position.set(spec.x, spec.y, spec.z)
        body.rotation.y = spec.h
        group.add(body)
        p.obj = body
        this._play(p, spec.clip)
        p.mixer.setTime((hash32(site.seed, i + 40) % 1000) / 100)
      })
    })
    group.userData.cast = cast
    group.position.set(site.x, 0, site.z)
    group.rotation.y = site.yaw
    return cast
  }

  _play(p, clip) {
    if (p.clip === clip) return
    const next = p.actions.get(clip)
    if (p.clip !== null) p.actions.get(p.clip).fadeOut(0.3)
    next.reset().fadeIn(p.clip === null ? 0 : 0.3).play()
    p.clip = clip
  }

  _drop(o) {
    o.removeFromParent()
    o.traverse((m) => { if (m.isMesh) m.material.dispose() })
  }

  /** The kitchen maid's world point `{ x, y, z }` (her feet) in the castle she is in, or null. */
  get maid() {
    if (this.inside === null) return null
    const p = this.inside.people.find((q) => q.spec.who === 'maid')
    if (p === undefined || p.obj === null) return null
    return p.obj.getWorldPosition(new THREE.Vector3())
  }

  /** The kitchen maid's feet, once each time `her` ({ x, y, z }) comes within `near` m of her; else null. */
  greet(her, near) {
    const at = this.maid
    if (at === null) return null
    const d = Math.hypot(her.x - at.x, her.z - at.z), close = d < near && Math.abs(her.y - at.y) < 3, fresh = close && !this.maidSpoke
    if (close) this.maidSpoke = true
    else if (d > near + 2) this.maidSpoke = false
    return fresh ? at : null
  }

  /** Once a frame: the inside cast while she is in castle `site` (its floor `oy`), else the outside cast of the nearest drawn castle
   * within FOLK.drawM of `her`, posed at `seconds`. */
  update(dt, seconds, her, site, oy) {
    if (site !== null) {
      if (this.inside === null || this.inside.site !== site) {
        const lay = castleLayout(site.seed), light = interiorLight(lay), L = INNER_LIGHT
        this.inside = this._cast(site, lay, insideCast(lay), this.inner, (spec, map) => {
          const [f, t, w] = light.at([spec.x, spec.y + 1.1, spec.z], null)
          const col = new THREE.Color(L.fill[0] * f + L.fire[0] * t + L.win * w, L.fill[1] * f + L.fire[1] * t + L.win * w, L.fill[2] * f + L.fire[2] * t + L.win * w)
          return new THREE.MeshBasicMaterial({ map, color: col, side: THREE.DoubleSide })
        })
        this.maidSpoke = false
      }
      this.inner.position.y = oy
      this.inner.visible = true
      this.outer.visible = false
      this._step(this.inside, dt, seconds)
      return
    }
    this.inner.visible = false
    const s = this.castles.nearestDrawn(her, FOLK.drawM)
    if (s === null) { this.outer.visible = false; return }
    if (this.outside === null || this.outside.site !== s) {
      const lay = castleLayout(s.seed), specs = outsideCast(lay, s, this._trail(s))
      for (const spec of specs) if (spec.trail === undefined) spec.y = this.ground(...toWorld(s, spec.x, spec.z)) - s.y
      this.outside = this._cast(s, lay, specs, this.outer, (spec, map) => this.patch(new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide }), 'v2-castle-folk'))
    }
    this.outer.position.y = s.y
    this.outer.visible = true
    this._step(this.outside, dt, seconds)
  }

  /** The keep trail leaving site `s`, castle end first, or null when no road reached it. */
  _trail(s) {
    let best = null, bestD = s.reach + 40
    for (const r of this.trails) for (const [end, pts] of [[r.pts[0], r.pts], [r.pts[r.pts.length - 1], [...r.pts].reverse()]]) {
      const d = Math.hypot(end[0] - s.x, end[2] - s.z)
      if (d < bestD) { bestD = d; best = pts }
    }
    return best
  }

  _step(cast, dt, seconds) {
    for (const p of cast.people) {
      if (p.obj === null) continue
      const spec = p.spec
      if (spec.path !== undefined) this._pace(p, spec.path, seconds)
      else if (spec.trail !== undefined) this._travel(p, spec, seconds)
      p.mixer.update(dt)
    }
  }

  /** Back and forth along `path` at FOLK.pace, standing FOLK.turnS at each end. */
  _pace(p, [a, b], seconds) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), leg = L / FOLK.pace, cycle = 2 * (leg + FOLK.turnS)
    const t = (seconds + (hash32(p.spec.x * 100 | 0, 7) % 60)) % cycle, back = t >= cycle / 2, u = t % (cycle / 2)
    const f = Math.min(1, u / leg), [from, to] = back ? [b, a] : [a, b]
    p.obj.position.set(from[0] + (to[0] - from[0]) * f, p.spec.y, from[1] + (to[1] - from[1]) * f)
    p.obj.rotation.y = facing(to[0] - from[0], to[1] - from[1]) + (f === 1 ? Math.PI : 0)
    this._play(p, f < 1 ? 'walk' : 'idle')
  }

  /** Out along the trail from the castle to the roads and away to town, then back and in at the gate, each leg at FOLK.trail. */
  _travel(p, spec, seconds) {
    const pts = spec.trail
    if (spec.lens === undefined) {
      spec.lens = [0]
      for (let i = 1; i < pts.length; i++) spec.lens.push(spec.lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]))
    }
    const L = spec.lens[spec.lens.length - 1], leg = L / FOLK.trail, cycle = 2 * (leg + FOLK.awayS)
    const t = (seconds + spec.offset * cycle) % cycle, back = t >= cycle / 2, u = t % (cycle / 2)
    p.obj.visible = u < leg
    if (!p.obj.visible) return
    const d = back ? L * (1 - u / leg) : L * (u / leg)
    let i = 1
    while (i < pts.length - 1 && spec.lens[i] < d) i++
    const f = (d - spec.lens[i - 1]) / (spec.lens[i] - spec.lens[i - 1]), a = pts[i - 1], b = pts[i]
    p.obj.position.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f)
    p.obj.rotation.y = back ? facing(a[0] - b[0], a[2] - b[2]) : facing(b[0] - a[0], b[2] - a[2])
    this._play(p, 'walk')
  }

  dispose() {
    for (const g of [this.inner, this.outer]) { for (const o of [...g.children]) this._drop(o); g.removeFromParent() }
  }
}
