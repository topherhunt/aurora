// A castle's household and garrison (design/44-castles.md §Garrison), local to this client and set by the clock: inside, the lord
// and his steward in the throne hall, a cook and the kitchen maid who talks of the dungeon, servants at their chores and a guard;
// outside, guards pacing the wall walks, two at the gate, one at the well, the old guard keeping the summit, and two travellers on
// the trail to the roads. Each wears one of the townsfolk's bodies (public/creatures/<id>.glb), stepping down its tiers on the
// creature ladder (critters.js), facing +X under its yaw as the ghost does. She talks with them as with townsfolk (talk/castle.js).

import THREE from '../../three-instance.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CASTLE, castleLayout } from '../castles/layout.js'
import { courtProps, keyChamber, roomPlan, roomProps } from '../castles/furnish.js'
import { interiorLight } from '../castles/light.js'
import { toLocal, toWorld } from '../layers/castles.js'
import { hash32 } from '../../sim/score.js'
import { critterTier, gltfLoader } from './critters.js'
import { INNER_LIGHT } from './castles.js'
import { TriFlames, TRI_TORCH } from './fire-tris.js'
import { flicker } from './fire.js'
import { bodyVoice, VOICE } from '../talk/mind.js'
import { castleName } from '../talk/castle.js'

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
  // As she comes within `near` m (times her size), each speaks to her `hail` of the time (FOLK_SAYS, a castle moment `color` of
  // that), nods to her `nod`, else lets her pass; but none speaks to her within `hailGapS` of the last who did.
  near: 3,
  hailGapS: 10,
  hail: 0.4,
  nod: 0.25,
  color: 0.7,
  mouth: 1.55,
  // Two standing within `pairM` of each other trade an exchange (FOLK_CHAT) every `chatS` seconds, a turn each `turnS`, while
  // she is within `overhearM`.
  pairM: 5,
  chatS: [14, 32],
  turnS: 2.8,
  overhearM: 16,
  // Clear metres round a chamber stand: from a prop's footprint, and from a portal.
  clear: 0.45,
  portal: 1.4,
  // A guard comes to her (conversations.js) at `come` m/s from within `comeM`, on her own level; the summit guard stands `lore` m
  // off the summit's centre.
  come: 1.3,
  comeM: 8,
  lore: 1.2,
  // The guards on the walls and at the gate carry torches lit above `torchNight` (lighting.js's dynamic slots, `torchReach` m): a
  // stave `len` m long held `grip` m up it.
  torchNight: 0.05,
  torchReach: 12,
  torch: { len: 0.62, grip: 0.2 },
}
const TORCH_BEARERS = new Set(['watch', 'gate'])

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
// Who says what: [castle moments, everyday moments] (tools/voice/atoms.js). A gate guard halts her first.
export const FOLK_SAYS = {
  lord: [['castle.lord'], ['greet.stranger']],
  steward: [['castle.steward'], ['greet.curt', 'greet.stranger']],
  cook: [['castle.cook'], ['mood.busy']],
  maid: [['castle.maid'], ['greet.stranger']],
  servant: [['castle.servant'], ['mood.busy', 'pass.nod']],
  guard: [['castle.guard'], ['greet.curt', 'mood.bored']],
  watch: [['castle.watch'], ['greet.curt', 'weather.cold']],
  gate: [['castle.guard'], ['greet.curt', 'greet.stranger']],
  yard: [['castle.servant'], ['pass.nod', 'mood.busy']],
  traveller: [['castle.road'], ['greet.stranger', 'pass.nod']],
  lore: [['castle.watch'], ['greet.stranger', 'mood.content']],
}

/** The moment `who` says as she comes near, or null to let her pass: `first` the first time in this visit, `rand` in [0, 1).
 * A gate guard halts her first, and the maid always speaks, for the hint her caption carries. */
export function folkMoment(who, first, rand) {
  if (who === 'gate' && first) return 'castle.halt'
  const r = who === 'maid' ? 0 : rand()
  if (r >= FOLK.hail + FOLK.nod) return null
  if (r >= FOLK.hail) return 'pass.nod'
  const pool = FOLK_SAYS[who][rand() < FOLK.color ? 0 : 1]
  return pool[(rand() * pool.length) | 0]
}

// What two of them say to each other, by who opens: each exchange its turns in order, `moment: ids` limiting a turn to those words.
const GUARD_CHAT = [['castle.watch: all-quiet cold-up-here long-night', 'social.agree'], ['weather.cold', 'social.agree'], ['mood.bored', 'social.agree'], ['gossip.lead', 'gossip.react']]
export const FOLK_CHAT = {
  lord: [['small.ask', 'small.reply'], ['gossip.lead', 'social.agree']],
  steward: [['gossip.lead', 'gossip.react'], ['small.ask', 'small.reply']],
  cook: [['castle.cook: dont-touch no-time-no-time', 'castle.servant: beg-pardon'], ['mood.busy', 'social.agree']],
  maid: [['castle.maid: hear-at-night dont-go-down', 'social.comfort'], ['gossip.lead', 'gossip.react']],
  servant: [['gossip.lead', 'gossip.react'], ['small.ask', 'small.reply'], ['castle.servant: floor-wet no-time-no-time', 'social.agree']],
  guard: GUARD_CHAT,
  watch: GUARD_CHAT,
  gate: GUARD_CHAT,
  lore: GUARD_CHAT,
  yard: [['small.ask', 'small.reply'], ['gossip.lead', 'gossip.react']],
  traveller: [['castle.road', 'social.agree'], ['small.ask', 'small.reply']],
}

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

/** The inside cast of `lay`, in interior metres: `{ who, body, clip, x, y, z, h, room }`, h the local heading, room its chamber. */
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
      out.push({ ...p, x, y: y + 0.3, z, h: facing(Math.sin(dais.yaw), Math.cos(dais.yaw)), room: c })
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
    out.push({ ...p, x: at[0], y, z: at[1], h: look === null ? facing(Math.cos(lay.seed), Math.sin(lay.seed)) : facing(lx - at[0], lz - at[1]), room: c })
  }
  return out
}

/** The outside cast of `lay` in exterior metres, heights unset but the summit guard's: on the longest wall walks a guard pacing
 * `{ path: [[x, z], [x, z]] }` (or on one cell, standing to look out), gate, well and summit stands, and travellers along `trail`
 * ([[x, y, z, w]] world) converted by `site`. */
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
  // The summit guard, on the side of the chest farthest from the rope and the way up, looking out.
  const summit = lay.nodes.find((n) => n.kind === 'summit'), [sx, sy, sz] = summit.pos, rope = lay.edges.find((e) => e.rope).rope
  const keep = [[rope.x, rope.z]]
  for (const e of lay.edges) {
    if (e.a !== summit && e.b !== summit) continue
    if (e.ladder) keep.push([e.ladder.x, e.ladder.z])
    if (e.kind === 'step') keep.push([e.pts[1][0], e.pts[1][2]])
    for (const d of e.doors) if (Math.abs(d.y - (sy - 0.4)) < 0.1) keep.push([d.x, d.z])
  }
  const clear = ([ux, uz]) => Math.min(...keep.map(([x, z]) => Math.hypot(sx + ux * FOLK.lore - x, sz + uz * FOLK.lore - z)))
  const [ux, uz] = [[1, 0], [-1, 0], [0, 1], [0, -1]].reduce((a, b) => (clear(b) > clear(a) ? b : a))
  out.push({ who: 'lore', body: 'guard', clip: 'idle', x: sx + ux * FOLK.lore, y: sy - 0.4, z: sz + uz * FOLK.lore, h: facing(ux, uz) })
  const well = courtProps(lay).find((o) => o.kind === 'well')
  if (well !== undefined) out.push({ who: 'yard', body: 'woodcutter', clip: 'gather', x: well.x + 1.35, z: well.z, h: facing(-1, 0) })
  if (trail !== null) {
    const pts = trail.map((p) => { const [x, z] = toLocal(site, p[0], p[2]); return [x, p[1] - site.y, z] })
    TRAVELLERS.forEach((body, i) => out.push({ who: 'traveller', body, clip: 'walk', trail: pts, offset: i * 0.5, x: pts[0][0], z: pts[0][2], h: 0 }))
  }
  return out
}

const _v = new THREE.Vector3()

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
    this.hailAt = -Infinity
    this.inner = new THREE.Group()
    this.outer = new THREE.Group()
    this.inner.name = 'v2-castle-folk-inside'
    this.outer.name = 'v2-castle-folk-outside'
    scene.add(this.inner, this.outer)
    // Each cast: the site it is for, its lay, its group, and its people `{ spec, obj, mixer, actions, clip, tiers, lod, pose, ... }`.
    this.inside = null
    this.outside = null
    this.her = { x: 0, y: 0, z: 0 }
    const T = FOLK.torch, wood = new THREE.CylinderGeometry(0.022, 0.03, T.len, 6).translate(0, T.len / 2, 0), head = new THREE.CylinderGeometry(0.045, 0.034, 0.12, 6).translate(0, T.len - 0.04, 0)
    for (const [g, c] of [[wood, 0x4a3422], [head, 0x1c1612]]) g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: g.attributes.position.count }, () => new THREE.Color(c).toArray()).flat(), 3))
    this.torchGeometry = mergeGeometries([wood.deleteAttribute('uv'), head.deleteAttribute('uv')])
    wood.dispose(); head.dispose()
    this.flames = new TriFlames(8, TRI_TORCH, { seed: 31 })
    scene.add(this.flames.group)
    // The lit torches' flames this frame (world points with their flicker phase), and the night they were lit by.
    this.lights = []
    this.night = 0
  }

  /** The body `id`'s GLB, loaded once. */
  _body(id) {
    if (!this.bodies.has(id)) this.bodies.set(id, gltfLoader().then((l) => l.loadAsync(`creatures/${id}.glb`)))
    return this.bodies.get(id)
  }

  /** Into `group`, a cast of `specs` for site `site`, each dressed in `material(spec, map)` as its body loads. */
  _cast(site, lay, specs, group, material) {
    for (const o of [...group.children]) this._drop(o)
    const cast = { site, lay, group, people: [] }, rooms = lay.nodes.filter((n) => n.kind === 'room' && !n.unused).length
    specs.forEach((spec, i) => {
      const { pack, he } = bodyVoice(spec.body), h = hash32(site.seed, i + 80)
      const voice = { pack, he, rate: 1 + ((h % 201) / 100 - 1) * VOICE.rate, tilt: (((h >>> 8) % 201) / 100 - 1) * VOICE.tilt }
      const mind = { id: `castle:${site.seed}:${group.name}:${i}`, kind: 'human', voice, who: spec.who, name: castleName(spec.who, he, h >>> 16) }
      const size = FOLK.size * (1 + FOLK.sizeVar * (((hash32(site.seed, i) % 200) / 100) - 1))
      // `greet` while coming to her or waiting there (conversations.js), `held` while she talks with them; `home` where to walk back
      // to after, and `lag` the seconds a pacer or traveller has stood out of its round.
      const p = { spec, obj: null, mixer: null, actions: null, clip: null, mind, near: false, spoke: 0, chatAt: null, tiers: null, lod: -1, size, pose: { x: 0, y: 0, z: 0 }, rooms, greet: null, held: false, home: null, lag: 0, gestureUntil: 0, torch: null }
      cast.people.push(p)
      this._body(spec.body).then((gltf) => {
        if (group.userData.cast !== cast) return
        const obj = cloneSkinned(gltf.scene), skinned = []
        obj.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o) })
        if (!skinned.length) throw new Error(`CastleFolk: creatures/${spec.body}.glb carries no skinned mesh`)
        skinned.sort((a, b) => b.geometry.index.count - a.geometry.index.count)
        for (const m of skinned) {
          m.visible = false
          m.frustumCulled = false
          m.material = material(spec, m.material.map)
        }
        p.tiers = skinned
        // The right hand (+Z, the body facing +X), read off the rest pose: the rigs name their bones each its own way, so it is the
        // outermost joint between 45% and 70% of the skeleton's height.
        let hand = null
        if (TORCH_BEARERS.has(spec.who)) {
          obj.updateMatrixWorld(true)
          const bones = skinned[0].skeleton.bones, at = bones.map((b) => b.getWorldPosition(new THREE.Vector3()))
          const y0 = Math.min(...at.map((v) => v.y)), y1 = Math.max(...at.map((v) => v.y))
          at.forEach((v, k) => { const f = (v.y - y0) / (y1 - y0); if (f > 0.45 && f < 0.7 && (hand === null || v.z > hand.z)) hand = { bone: bones[k], z: v.z } })
          if (hand === null) throw new Error(`CastleFolk: creatures/${spec.body}.glb has no joint at hand height`)
        }
        p.mixer = new THREE.AnimationMixer(obj)
        p.actions = new Map(gltf.animations.map((c) => [c.name, p.mixer.clipAction(c)]))
        for (const name of ['idle', 'walk', spec.clip]) if (!p.actions.has(name)) throw new Error(`CastleFolk: creatures/${spec.body}.glb has no ${name} clip`)
        p.mixer.update(0)
        obj.updateMatrixWorld(true)
        const box = new THREE.Box3().setFromObject(skinned[0]), body = new THREE.Group()
        obj.scale.setScalar(size / (box.max.y - box.min.y))
        obj.position.y = -box.min.y * obj.scale.y
        body.add(obj)
        body.position.set(spec.x, spec.y, spec.z)
        body.rotation.y = spec.h
        group.add(body)
        p.obj = body
        if (hand !== null) {
          const mesh = new THREE.Mesh(this.torchGeometry, this.patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'v2-castle-folk-torch'))
          mesh.visible = false
          body.add(mesh)
          p.torch = { hand: hand.bone, mesh, phase: (h % 628) / 100 }
        }
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

  /** Who of the drawn cast has just come within `near` m of `her` ({ x, y, z }) at `seconds`, each once a time she comes:
   * `[{ who, mind, moment, feet, mouth }]`, world points. The maid comes with a null moment when another spoke too lately. */
  barks(her, near, seconds) {
    const cast = this.inner.visible ? this.inside : this.outer.visible ? this.outside : null
    if (cast === null) return []
    const out = []
    for (const p of cast.people) {
      if (p.obj === null || !p.obj.visible || p.held || p.greet !== null) continue
      const feet = p.obj.getWorldPosition(new THREE.Vector3()), d = Math.hypot(her.x - feet.x, her.z - feet.z)
      const close = d < near && Math.abs(her.y - feet.y) < 3
      if (close && !p.near) {
        let moment = folkMoment(p.spec.who, p.spoke === 0, Math.random)
        if (moment !== null && seconds - this.hailAt < FOLK.hailGapS) moment = null
        if (moment !== null) this.hailAt = seconds
        if (moment !== null || p.spec.who === 'maid') out.push({ who: p.spec.who, mind: p.mind, moment, feet, mouth: { x: feet.x, y: feet.y + FOLK.mouth, z: feet.z } })
        p.spoke++
      }
      if (close) p.near = true
      else if (d > near + 2) p.near = false
    }
    return out
  }

  /** The turns of the drawn cast's talk among themselves due at `seconds` while `her` ({ x, y, z }) is in earshot:
   * `[{ mind, step, mouth }]`, `step` a FOLK_CHAT turn. A pair forms of two standing still within FOLK.pairM of each other. */
  chatter(her, seconds) {
    const cast = this.inner.visible ? this.inside : this.outer.visible ? this.outside : null
    if (cast === null) return []
    const out = [], mouth = (p) => { const v = p.obj.getWorldPosition(new THREE.Vector3()); v.y += FOLK.mouth; return v }
    if (cast.talk !== undefined) {
      const { a, b, turns, t0 } = cast.talk, k = Math.floor((seconds - t0) / FOLK.turnS)
      if (k >= turns.length) cast.talk = undefined
      else if (k > cast.talk.k) { cast.talk.k = k; const p = k % 2 === 0 ? a : b; out.push({ mind: p.mind, step: turns[k], mouth: mouth(p) }) }
      return out
    }
    const still = cast.people.filter((p) => p.obj !== null && p.obj.visible && p.clip !== 'walk' && !p.held && p.greet === null && p.home === null)
    for (const a of still) {
      if (a.chatAt === null) a.chatAt = seconds + Math.random() * FOLK.chatS[1]
      if (seconds < a.chatAt) continue
      a.chatAt = seconds + FOLK.chatS[0] + Math.random() * (FOLK.chatS[1] - FOLK.chatS[0])
      const at = mouth(a)
      if (Math.hypot(her.x - at.x, her.y - at.y, her.z - at.z) > FOLK.overhearM) continue
      const b = still.find((q) => q !== a && mouth(q).distanceTo(at) < FOLK.pairM)
      if (b === undefined) continue
      const book = FOLK_CHAT[a.spec.who], turns = book[(Math.random() * book.length) | 0]
      cast.talk = { a, b, turns, t0: seconds, k: 0 }
      out.push({ mind: a.mind, step: turns[0], mouth: at })
      break
    }
    return out
  }

  /** Once a frame: the inside cast while she is in castle `site` (its floor `oy`), else the outside cast of the nearest drawn castle
   * within FOLK.drawM of `her`, posed at `seconds`. */
  update(dt, seconds, her, site, oy, night, t) {
    if (!(night >= 0)) throw new Error(`CastleFolk.update: needs night, got ${night}`)
    this.her.x = her.x; this.her.y = her.y; this.her.z = her.z
    this.night = night
    if (site !== null) {
      if (this.inside === null || this.inside.site !== site) {
        const lay = castleLayout(site.seed), light = interiorLight(lay), L = INNER_LIGHT
        this.inside = this._cast(site, lay, insideCast(lay), this.inner, (spec, map) => {
          const [f, t, w] = light.at([spec.x, spec.y + 1.1, spec.z], null)
          const col = new THREE.Color(L.fill[0] * f + L.fire[0] * t + L.win * w, L.fill[1] * f + L.fire[1] * t + L.win * w, L.fill[2] * f + L.fire[2] * t + L.win * w)
          return new THREE.MeshBasicMaterial({ map, color: col, side: THREE.DoubleSide })
        })
      }
      this.inner.position.y = oy
      this.inner.visible = true
      this.outer.visible = false
      this._step(this.inside, dt, seconds)
      this._torches(null, t)
      return
    }
    this.inner.visible = false
    const s = this.castles.nearestDrawn(her, FOLK.drawM)
    if (s === null) { this.outer.visible = false; this._torches(null, t); return }
    if (this.outside === null || this.outside.site !== s) {
      const lay = castleLayout(s.seed), specs = outsideCast(lay, s, this._trail(s))
      for (const spec of specs) if (spec.trail === undefined && spec.y === undefined) spec.y = this.ground(...toWorld(s, spec.x, spec.z)) - s.y
      this.outside = this._cast(s, lay, specs, this.outer, (spec, map) => this.patch(new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide }), 'v2-castle-folk'))
    }
    this.outer.position.y = s.y
    this.outer.visible = true
    this._step(this.outside, dt, seconds)
    this._torches(this.outside, t)
  }

  /** Each drawn torch bearer's torch put in the hand and lit by the night, the flames at their tops (`cast` null: none). */
  _torches(cast, t) {
    const T = FOLK.torch, lit = this.night > FOLK.torchNight
    this.lights.length = 0
    if (cast !== null) for (const p of cast.people) {
      if (p.torch === null) continue
      const on = lit && p.lod < p.tiers.length, mesh = p.torch.mesh
      mesh.visible = on
      if (!on) continue
      p.obj.worldToLocal(p.torch.hand.getWorldPosition(_v))
      mesh.position.set(_v.x, _v.y - T.grip, _v.z)
      mesh.updateWorldMatrix(true, false)
      mesh.localToWorld(_v.set(0, T.len, 0))
      this.flames.place(this.lights.length, _v.x, _v.y, _v.z, { height: TRI_TORCH.height, radius: TRI_TORCH.radius, phase: p.torch.phase })
      this.lights.push({ x: _v.x, y: _v.y, z: _v.z, phase: p.torch.phase })
    }
    this.flames.count = this.lights.length
    this.flames.update(t, [this.night, this.night, this.night])
  }

  /** Into `out` (main.js's torch list), each lit torch as lighting.js's setTorches takes it, with its distance `d` from `head`. */
  torchLights(head, now, out) {
    for (const l of this.lights) out.push({ x: l.x, y: l.y + 0.15, z: l.z, strength: this.night * flicker(now, l.phase), reach: FOLK.torchReach, d: Math.hypot(l.x - head.x, l.y - head.y, l.z - head.z) })
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
    cast.group.updateMatrixWorld()
    const her = cast.group.worldToLocal(_v.set(this.her.x, this.her.y, this.her.z)), hx = her.x, hz = her.z
    for (const p of cast.people) {
      if (p.obj === null) continue
      const spec = p.spec
      if (p.held || p.greet !== null) { p.lag += dt; this._attend(p, cast, hx, hz, dt, seconds) }
      else if (p.home !== null) { p.lag += dt; this._return(p, cast, dt) }
      else if (spec.path !== undefined) this._pace(p, spec.path, seconds - p.lag)
      else if (spec.trail !== undefined) this._travel(p, spec, seconds - p.lag)
      p.obj.getWorldPosition(_v)
      p.pose.x = _v.x; p.pose.y = _v.y; p.pose.z = _v.z
      const was = p.lod
      p.lod = critterTier(p.size, Math.hypot(_v.x - this.her.x, _v.y - this.her.y, _v.z - this.her.z), p.lod, p.tiers.length)
      if (p.lod !== was) p.tiers.forEach((m, k) => { m.visible = k === p.lod })
      if (p.lod < p.tiers.length) p.mixer.update(dt)
    }
  }

  /** Coming to her at FOLK.come until `greet.come` m off, then standing turned to her, a gesture played out before the idle. */
  _attend(p, cast, hx, hz, dt, seconds) {
    const o = p.obj.position, dx = hx - o.x, dz = hz - o.z, d = Math.hypot(dx, dz)
    if (p.greet !== null && p.greet.at === Infinity) {
      if (d > p.greet.come) {
        this._walk(p, cast, dx / d, dz / d, Math.min(d - p.greet.come, FOLK.come * dt))
        return
      }
      p.greet.at = seconds
    }
    if (d > 0.01) p.obj.rotation.y = facing(dx, dz)
    if (seconds >= p.gestureUntil) this._play(p, 'idle')
  }

  /** Back to where it stood before it came to her or was held, then on with its round. */
  _return(p, cast, dt) {
    const o = p.obj.position, [x, z, h] = p.home, dx = x - o.x, dz = z - o.z, d = Math.hypot(dx, dz)
    if (d > 0.05) { this._walk(p, cast, dx / d, dz / d, Math.min(d, FOLK.come * dt)); return }
    o.x = x; o.z = z
    p.obj.rotation.y = h
    p.home = null
    if (p.spec.path === undefined && p.spec.trail === undefined) this._play(p, p.spec.clip)
  }

  /** `step` m along unit (ux, uz), facing it; outside, on the ground. */
  _walk(p, cast, ux, uz, step) {
    const o = p.obj.position
    o.x += ux * step; o.z += uz * step
    if (cast === this.outside) o.y = this.ground(...toWorld(cast.site, o.x, o.z)) - cast.site.y
    p.obj.rotation.y = facing(ux, uz)
    this._play(p, 'walk')
  }

  /** Into `into`, the drawn cast she may talk with: on her level, drawn on the ladder and not away on the road. */
  talkers(into) {
    const cast = this.inner.visible ? this.inside : this.outer.visible ? this.outside : null
    if (cast === null) return into
    for (const p of cast.people) if (p.obj !== null && p.obj.visible && p.lod < p.tiers.length && Math.abs(this.her.y - p.pose.y - FOLK.mouth) < 2) into.push(p)
    return into
  }

  /** `p` stops its round for her and keeps turned to her until released. */
  hold(p) {
    p.held = true
    if (p.home === null) p.home = [p.obj.position.x, p.obj.position.z, p.obj.rotation.y]
  }

  release(p) {
    p.held = false
    p.greet = null
  }

  /** Whether guard `p` can come to her: on her level within FOLK.comeM, and inside, in its own chamber. */
  reaches(p) {
    if (!['guard', 'watch', 'gate'].includes(p.spec.who)) return false
    const cast = this.inner.visible ? this.inside : this.outside
    const her = cast.group.worldToLocal(_v.set(this.her.x, this.her.y, this.her.z)), o = p.obj.position
    if (Math.hypot(her.x - o.x, her.z - o.z) > FOLK.comeM || Math.abs(her.y - o.y - FOLK.mouth) > 1.2) return false
    if (p.spec.room === undefined) return true
    const [x0, z0, x1, z1] = p.spec.room.rect
    return her.x > x0 + 0.3 && her.x < x1 - 0.3 && her.z > z0 + 0.3 && her.z < z1 - 0.3
  }

  /** `p` comes to within `come` m of her (`reaches`), and waits there. */
  approach(p, come) {
    this.hold(p)
    p.greet = { at: Infinity, come }
  }

  /** `p` plays `clip` through once, then stands idle. */
  gesture(p, clip, seconds) {
    const a = p.actions.get(clip)
    if (a === undefined) throw new Error(`CastleFolk: creatures/${p.spec.body}.glb has no ${clip} clip`)
    this._play(p, clip)
    p.gestureUntil = seconds + a.getClip().duration
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
    this.flames.group.removeFromParent()
    this.flames.dispose()
    this.torchGeometry.dispose()
  }
}
