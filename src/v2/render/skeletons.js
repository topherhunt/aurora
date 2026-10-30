// THE BONE FRIENDS (design/45-bone-friends.md): a shy skeleton in each town's missing-child hideout (talk/quests.js
// hideouts), the boy beside it while he is lost, and the ones she has fed following her everywhere. Local to this client:
// nothing here is relayed, and `friends` (the place keys of the ones she tamed) is all that is saved.

import THREE from '../../three-instance.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { lazyLoad } from '../lazy-load.js'
import { swing } from '../../sim/score.js'
import { CRITTER_GLB, LOD_RUNGS, critterTier } from './critters.js'
import { groundFeet, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { makePuppet } from './baked-puppet.js'
import { loadBipedGlb } from './snowmen.js'
import { TOWNSFOLK } from './townsfolk.js'
import { KIND as PUMPKIN, SIZE_M as PUMPKIN_M } from './pumpkins.js'
import { caveSpot, castleSpot } from '../hideout-spot.js'
import { castleLayout } from '../castles/layout.js'
import { roomProps } from '../castles/furnish.js'
import { toWorld } from '../layers/castles.js'

export const SKELETON = {
  heightM: 1.15,
  // She closing on a shy one faster than this inside startleM (a tame one: tameM) collapses it, as does a blade within bladeM.
  startleV: 2.4, startleM: 4, tameM: 1.2, bladeM: 0.45,
  // Seconds a pile lies before it gets up, and the squash a collapse takes.
  pileS: [2.5, 4.5], squashS: 0.22, riseS: 0.6,
  // A follower stands off this far, runs past runM, and is put beside her past lostM.
  followM: 1.8, runM: 6, lostM: 30,
  // A bone in her hand this close draws a shy one out; held this close to its head, it eats.
  coaxM: 5, eatM: 0.6,
  // A pumpkin in her hand this close brings one to kneel kneelM in front of her and beg; held within offerM of its hands, it takes it at takeRate of the clip's pace.
  pumpkinM: 10, kneelM: 0.8, offerM: 0.5, takeRate: 0.45, joyS: 2.6, rompS: 12, rompR: 2.6,
  // Her within foundM of a lost boy finds him; he waves and is gone home goneS after.
  foundM: 2.5, goneS: 5,
  friendsMax: 4, fidgetS: [5, 11], dugMax: 12,
  // A still loose thing she threw, at least fetchMinM from her and inside fetchM of a follower, is brought back to her feet.
  fetchM: 15, fetchMinM: 3,
  // Bones laid by the hideout spot for her to feed it with.
  stash: 3,
  // Ghost caps (eating.js EAT.ghost) growing round its hideout, `capR` m out.
  caps: 4,
  capR: [1.3, 2.2],
}

export const CLIPS = ['idle', 'walk', 'run', 'run-carry', 'cower', 'recoil', 'kneel', 'beg', 'take', 'joy', 'jig', 'rise', 'eat', 'gather', 'talk-nod', 'wave']
const ONE_SHOT = new Set(['kneel', 'rise', 'take', 'eat', 'gather'])
const PLANTED = new Set(['idle', 'cower', 'kneel', 'beg', 'take', 'eat', 'gather', 'talk-nod', 'wave'])
// One per possible follower, and the shy one at a hideout.
const PUPPETS = SKELETON.friendsMax + 1
const FADE_S = 0.3
const TURN_RATE = 3
// Eye sockets off the Head joint in the body's own units (tools/creatures/rig-skeleton.mjs), and a socket's glow radius.
const EYE = { x: 0.15, y: 0.08, z: 0.05, r: 0.022 }
const BONE_M = 0.26
const BONE_KIND = 'bone'
const CAP_KIND = 'ghostcap'
export const CAP_M = 0.12
// A ground read further than this from where the body stands is another storey's (a castle's tower, a cave's ledge), not this one's.
const STOREY_M = 1.5

const UP = new THREE.Vector3(0, 1, 0)
const _mat = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _v = new THREE.Vector3()
const _w = new THREE.Vector3()

const between = ([lo, hi]) => lo + (hi - lo) * Math.random()
const pick = (list) => list[(Math.random() * list.length) | 0]

/** A cartoon bone along x: a shaft with two knobs at each end, ivory, centred on the origin. */
export function boneGeometry() {
  const parts = [new THREE.CylinderGeometry(0.016, 0.016, BONE_M - 0.05, 6).rotateZ(Math.PI / 2)]
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(new THREE.SphereGeometry(0.024, 8, 6).translate(sx * (BONE_M / 2 - 0.024), 0, sz * 0.016))
  for (const g of parts) {
    const n = g.attributes.position.count
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.93).map((v, i) => (i % 3 === 2 ? 0.8 : v)), 3))
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()))
}

/** A ghost cap, its foot at the origin: a pale stalk under a dome that glows cyan-white, CAP_M tall. */
export function capGeometry() {
  const stalk = new THREE.CylinderGeometry(0.012, 0.016, 0.08, 6).translate(0, 0.04, 0)
  const dome = new THREE.SphereGeometry(0.045, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1).translate(0, 0.08, 0)
  const paint = (g, rgb) => g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).map((_, i) => rgb[i % 3]), 3))
  paint(stalk, [0.75, 0.82, 0.85])
  paint(dome, [0.6, 1, 0.95])
  return mergeGeometries([stalk.toNonIndexed(), dome.toNonIndexed()])
}

export class Skeletons {
  /**
   * @param opts.hands     Hands: lures, eatLure, carry, loose and lift
   * @param opts.pumpkins  the pumpkins' hands source, for a pumpkin carried
   * @param opts.townsfolk Townsfolk: the lost boy's body
   * @param opts.conv      () => the Conversations, or null before they are up
   * @param opts.friends   the saved Set of tamed place keys, owned by the caller
   * @param opts.bones     the hands kinds it eats; opts.fetches those it fetches
   * @param opts.asset     a loaded asset, for a gate; the world fetches the GLB
   */
  constructor(scene, { walk, hands, pumpkins, townsfolk, conv, friends, bones, fetches, asset = null }) {
    this.walk = walk
    this.hands = hands
    this.pumpkins = pumpkins
    this.townsfolk = townsfolk
    this.conv = conv
    this.friends = friends
    this.eats = new Set([BONE_KIND, ...bones])
    this.fetches = new Set([BONE_KIND, ...fetches])
    this.lies = true
    this.blades = []
    this.batch = new THREE.Group()
    this.batch.name = 'v2-skeletons'
    scene.add(this.batch)

    this.plain = makeSettledMaterial('skeletons')
    this.puppetMats = Array.from({ length: PUPPETS }, () => makePuppetMaterials('skeletons', this.plain))
    this.boyPlain = makeSettledMaterial('skeletons-boy')
    this.boyMats = makePuppetMaterials('skeletons-boy', this.boyPlain)
    this.boneMat = new THREE.MeshLambertMaterial({ vertexColors: true })
    // `materials` share a lighting cache key; the bones' own Lambert wants another.
    this.materials = [this.plain, this.boyPlain, this.boyMats.in, this.boyMats.out, ...this.puppetMats.flatMap((m) => [m.in, m.out])]

    this.boneGeo = boneGeometry()
    this.stash = new THREE.InstancedMesh(this.boneGeo, this.boneMat, SKELETON.dugMax + SKELETON.stash)
    this.stash.count = 0
    this.stash.frustumCulled = false
    this.batch.add(this.stash)
    this.eyes = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 1, 0.55), toneMapped: false, fog: false }), PUPPETS * 2)
    this.eyes.count = 0
    this.eyes.frustumCulled = false
    this.batch.add(this.eyes)
    this.capGeo = capGeometry()
    this.capMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false })
    this.capMesh = new THREE.InstancedMesh(this.capGeo, this.capMat, SKELETON.caps)
    this.capMesh.count = 0
    this.capMesh.frustumCulled = false
    this.batch.add(this.capMesh)

    // The bones lying where she can pick them up, and the ghost caps growing: `{ x, y, z, yaw }`.
    this.lying = []
    this.caps = []
    this.list = []
    this.place = null
    this.boy = null
    this.said = []
    this.scare = []
    this.lureList = []
    this.her = { x: 0, y: 0, z: 0, hy: 0, v: 0 }
    this.rejoin = true
    this.asset = null
    this.loaded = false
    if (asset) {
      this.setAsset(asset)
      this.ready = Promise.resolve(true)
    } else {
      this.lazy = lazyLoad(() => this.load())
      this.ready = this.lazy.ready
    }
  }

  async load() {
    this.setAsset(await loadBipedGlb(CRITTER_GLB.boneFriend))
    return true
  }

  setAsset(asset) {
    for (const name of CLIPS) if (!asset.clips.some((c) => c.name === name)) throw new Error(`Skeletons: bone-friend.glb has no ${name} clip`)
    this.asset = asset
    this.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
    this.plain.map = asset.map
    this.plain.needsUpdate = true
    this.free = this.puppetMats.map((mats) => {
      for (const m of [mats.in, mats.out]) { m.map = asset.map; m.needsUpdate = true }
      const p = makePuppet(asset, mats, { clipFade: FADE_S, oneShot: ONE_SHOT })
      // GLTFLoader drops the dot: the GLB's `Wrist.R` loads as `WristR`.
      p.named = Object.fromEntries(['Head', 'Wrist.R', 'Wrist.L'].map((n) => {
        const b = p.bones.find((b) => b.name === THREE.PropertyBinding.sanitizeNodeName(n))
        if (!b) throw new Error(`Skeletons: bone-friend.glb has no ${n} bone`)
        return [n, b]
      }))
      return p
    })
    this.loaded = true
  }

  // -------------------------------------------------------------------------
  // Where she is: the hideout of the cave or castle she just entered, if it is a town's, and her followers put beside her.
  // -------------------------------------------------------------------------

  /** Into cave system `sys`, its plan's `graph` at world height offset `oy`, walked on `walk`. */
  intoCave(sys, graph, oy, walk) {
    const key = `cave:${sys.id}`
    const spot = this._isHideout(key) ? caveSpot(graph) : null
    this._enter(walk, spot && { key, x: spot.x, y: spot.y + oy, z: spot.z, heading: Math.random() * Math.PI * 2 })
  }

  /** Into castle `site`'s interior, its floor at world height `oy`, walked on `walk`. */
  intoCastle(site, oy, walk) {
    const key = `castle:${site.id}`
    const lay = this._isHideout(key) ? castleLayout(site.seed) : null
    const spot = lay && castleSpot(lay, roomProps(lay))
    const at = spot && toWorld(site, spot.lx, spot.lz)
    this._enter(walk, spot && { key, x: at[0], y: oy + spot.ly, z: at[1], heading: spot.face + site.yaw })
  }

  /** Back out on the overworld's `walk`. */
  outside(walk) {
    this._enter(walk, null)
  }

  _isHideout(key) {
    const conv = this.conv()
    if (conv === null) return false
    return conv.world.hideouts.some((h) => h !== null && placeKey(h) === key)
  }

  _enter(walk, place) {
    this.walk = walk
    for (const b of this.list.filter((b) => !b.tame)) this._drop(b)
    this._dropBoy()
    this.lying.length = 0
    this.caps.length = 0
    this.place = place
    this.rejoin = true
    if (place === null) return
    for (let i = 0; i < SKELETON.stash; i++) {
      const a = place.heading + 0.6 + i * 0.9
      this.lying.push({ x: place.x + Math.cos(a) * (0.7 + 0.25 * i), y: place.y + 0.024, z: place.z - Math.sin(a) * (0.7 + 0.25 * i), yaw: Math.random() * Math.PI })
    }
    for (let i = 0; i < SKELETON.caps; i++) {
      const a = place.heading + Math.PI + (i - 1.5) * 0.7, r = between(SKELETON.capR)
      const x = place.x + Math.cos(a) * r, z = place.z - Math.sin(a) * r
      this.caps.push({ x, y: this._ground(x, z, place.y), z, yaw: Math.random() * Math.PI * 2 })
    }
  }

  // -------------------------------------------------------------------------
  // The frame.
  // -------------------------------------------------------------------------

  /** One frame: `feet` and `head` her world points, `now` seconds. */
  update(dt, now, feet, head) {
    const want = this.friends.size > 0 || this.place !== null
    if (!want) {
      while (this.list.length > 0) this._drop(this.list[0])
      this.eyes.count = 0
      this._drawStash()
      return
    }
    if (!this.loaded) return this.lazy.want()
    const her = this.her
    const d = Math.hypot(feet.x - her.x, feet.z - her.z)
    her.v = dt > 0 && d < 5 ? d / dt : 0
    her.x = feet.x; her.y = feet.y; her.z = feet.z; her.hy = head.y
    this.lureList.length = 0
    this.hands.lures(this.lureList)
    this._census(now)
    for (const b of this.list) this._think(b, dt, now)
    this._stepBoy(dt, now)
    this.rejoin = false
    this._draw(dt)
  }

  /** The followers the saved keys name, and the shy one at this hideout unless it is one of them. */
  _census(now) {
    for (const b of this.list.filter((b) => b.tame && !this.friends.has(b.key))) this._drop(b)
    let i = 0
    for (const key of this.friends) {
      if (i++ >= SKELETON.friendsMax) break
      if (!this.list.some((b) => b.key === key)) this._beside(this._spawn(now, key, true, this.her.x, this.her.z, 0), i)
    }
    const p = this.place
    if (p !== null && !this.friends.has(p.key) && !this.list.some((b) => b.key === p.key)) this._spawn(now, p.key, false, p.x, p.z, p.heading, p.y)
    if (this.rejoin) {
      this.list.filter((b) => b.tame).forEach((b, j) => this._beside(b, j))
    }
  }

  _spawn(now, key, tame, x, z, heading, y = null) {
    const puppet = this.free.pop()
    if (puppet === undefined) throw new Error(`Skeletons: no puppet for ${key}`)
    const b = {
      key, tame, puppet, x, z, y: y === null ? this.her.y : y, heading, aim: heading, home: { x, z, y: y === null ? this.her.y : y, heading },
      size: SKELETON.heightM, k: SKELETON.heightM / this.asset.height, speed: 0, clip: 'idle', cue: 0, cycle: 1, lod: LOD_RUNGS,
      state: tame ? 'follow' : 'hide', t: 0, squash: 0, rate: 1, until: 0, nextFidget: now + between(SKELETON.fidgetS), angle: 0,
      lure: null, carrier: null, fetching: null, near: Infinity, lastD: Infinity, whimperAt: 0,
    }
    this.batch.add(puppet.group)
    this.list.push(b)
    this._play(b, tame ? 'idle' : 'cower')
    return b
  }

  _drop(b) {
    if (b.carrier !== null) { b.carrier.scatter(); b.carrier.release() }
    b.puppet.release()
    this.batch.remove(b.puppet.group)
    this.free.push(b.puppet)
    this.list.splice(this.list.indexOf(b), 1)
  }

  /** A follower put on her ring, the `j`th of them, after she went through a door. */
  _beside(b, j) {
    const a = j * 1.6 + 2.4
    b.x = this.her.x + Math.cos(a) * SKELETON.followM
    b.z = this.her.z - Math.sin(a) * SKELETON.followM
    b.y = this._ground(b.x, b.z, this.her.y)
    b.heading = b.aim = a + Math.PI
    if (b.state !== 'pile') this._go(b, 'follow')
  }

  _play(b, clip, rate = 1) {
    if (b.clip !== clip) b.cue++
    b.clip = clip
    b.rate = rate
    b.cycle = this.durations[clip] / rate
    const gait = this.asset.gait[clip === 'run-carry' ? 'run' : clip]
    b.speed = gait === undefined ? 0 : gait * b.k * rate
  }

  _go(b, state) {
    b.state = state
    b.t = 0
  }

  _say(b, sound, rate = 0.9 + 0.2 * Math.random()) {
    this.said.push({ sound, rule: 'villagerVoice', rate, x: b.x, y: b.y + b.size * 0.8, z: b.z })
  }

  /** The ground under (x, z), unless it is another storey's than `ref`'s. */
  _ground(x, z, ref) {
    const y = this.walk.heightAt(x, z)
    return Number.isFinite(y) && Math.abs(y - ref) < STOREY_M ? y : ref
  }

  /** Toward (tx, tz) on `clip`'s gait this frame, turning as it goes; true once within `stop`. */
  _walkTo(b, tx, tz, clip, dt, stop) {
    const dx = tx - b.x, dz = tz - b.z, d = Math.hypot(dx, dz)
    b.aim = Math.atan2(-dz, dx)
    // The last step lands on `stop` itself, a rounding error over it: without the slack it never arrives.
    if (d <= stop + 1e-3) return true
    if (b.clip !== clip) this._play(b, clip)
    const turn = this._turn(b, dt)
    const step = Math.min(d - stop, b.speed * dt * Math.max(0, turn))
    b.x += Math.cos(b.heading) * step
    b.z -= Math.sin(b.heading) * step
    b.y = this._ground(b.x, b.z, b.y)
    return false
  }

  _turn(b, dt) {
    const s = swing(b.heading, b.aim)
    b.heading += Math.sign(s) * Math.min(Math.abs(s), TURN_RATE * dt)
    return Math.cos(swing(b.heading, b.aim))
  }

  _face(b, x, z, dt) {
    b.aim = Math.atan2(-(z - b.z), x - b.x)
    this._turn(b, dt)
  }

  /** Stood still on `clip`. */
  _stand(b, clip, rate = 1) {
    if (b.clip !== clip || b.rate !== rate) this._play(b, clip, rate)
    b.speed = 0
  }

  /** Its point `bone` (a name) offset by (ox, oy, oz) in its own units, in the world, into `out`. */
  _at(b, bone, ox, oy, oz, out) {
    out.set(ox, oy, oz).applyMatrix4(b.puppet.named[bone].matrixWorld)
    return out.applyMatrix4(b.puppet.group.matrix)
  }

  /** Her lure of a kind in `kinds` within `m` of the body, nearest first: one in her own hand, the one it can eat or take. */
  _lure(b, kinds, m) {
    let best = null, bd = m
    for (const l of this.lureList) {
      if (l.by !== null || !kinds.has(l.kind)) continue
      const d = Math.hypot(l.x - b.x, l.z - b.z)
      if (d < bd) { best = l; bd = d }
    }
    return best
  }

  _collapse(b, now) {
    if (b.state === 'pile' || b.state === 'rise') return
    if (b.carrier !== null) b.carrier.scatter()
    b.fetching = null
    this._go(b, 'pile')
    b.until = now + between(SKELETON.pileS)
    this._stand(b, 'idle')
    this._say(b, 'skeletonCollapse')
  }

  _think(b, dt, now) {
    b.t += dt
    const her = this.her
    const dx = her.x - b.x, dz = her.z - b.z, d = Math.hypot(dx, dz)
    // Startled: she rushing it, or a blade through it.
    const closing = Number.isFinite(b.lastD) && dt > 0 ? (b.lastD - d) / dt : 0
    b.lastD = d
    const rushed = closing > SKELETON.startleV && her.v > SKELETON.startleV && d < (b.tame ? SKELETON.tameM : SKELETON.startleM)
    const cut = this.blades.some((p) => Math.hypot(p.x - b.x, p.z - b.z) < SKELETON.bladeM && p.y > b.y && p.y < b.y + b.size)
    if (rushed || cut) this._collapse(b, now)
    if (b.tame && d > SKELETON.lostM && b.state !== 'pile') this._beside(b, this.list.indexOf(b))
    const holding = b.carrier !== null && b.carrier.count() > 0
    const busy = b.state === 'pile' || b.state === 'rise' || b.state === 'eat' || b.state === 'take' || b.state === 'joy' || b.state === 'romp'
    const pumpkin = !holding && !busy && b.fetching === null ? this._lure(b, PUMPKINS, SKELETON.pumpkinM) : null
    if (pumpkin !== null && b.state !== 'come' && b.state !== 'kneel' && b.state !== 'beg') { b.lure = pumpkin; this._go(b, 'come') }

    switch (b.state) {
      case 'hide': {
        this._stand(b, 'cower')
        const bone = this._lure(b, this.eats, SKELETON.coaxM)
        if (bone !== null) { b.lure = bone; this._go(b, 'coax') }
        break
      }
      case 'coax': case 'feed': {
        const bone = this._lure(b, this.eats, SKELETON.coaxM + 2)
        if (bone === null) { this._go(b, b.tame ? 'follow' : 'home'); break }
        b.lure = bone
        if (this._walkTo(b, bone.x, bone.z, 'walk', dt, SKELETON.eatM * 0.7)) {
          this._stand(b, 'beg')
          this._face(b, bone.x, bone.z, dt)
          const head = b.y + b.size * 0.8
          if (Math.abs(bone.y - head) < SKELETON.eatM + 0.4) {
            const rec = this.hands.eatLure(bone, 'skeleton')
            if (rec !== null) { this._go(b, 'eat'); this._play(b, 'eat'); this._say(b, 'skeletonCrunch') }
          }
        }
        break
      }
      case 'eat':
        if (b.t >= this.durations.eat) {
          if (!b.tame && this.friends.size < SKELETON.friendsMax) { b.tame = true; this.friends.add(b.key) }
          this._go(b, 'joy'); this._play(b, 'joy'); this._say(b, 'skeletonGiggle')
        }
        break
      case 'home':
        if (this._walkTo(b, b.home.x, b.home.z, 'walk', dt, 0.2)) { b.heading = b.aim = b.home.heading; this._go(b, 'hide') }
        break
      case 'pile':
        b.squash = Math.min(1, b.squash + dt / SKELETON.squashS)
        if (now >= b.until) { this._go(b, 'rise'); this._play(b, 'rise'); this._say(b, 'skeletonReassemble') }
        break
      case 'rise':
        b.squash = Math.max(0, b.squash - dt / SKELETON.riseS)
        if (b.t >= this.durations.rise) this._go(b, b.tame ? 'follow' : 'hide')
        break
      case 'come': {
        const l = b.lure
        if (!this.lureList.includes(l) || l.kind !== PUMPKIN) { this._go(b, b.tame ? 'follow' : 'hide'); break }
        // In front of her on its own side, so two that come kneel apart.
        const a = Math.atan2(-(b.z - her.z), b.x - her.x)
        if (this._walkTo(b, her.x + Math.cos(a) * SKELETON.kneelM, her.z - Math.sin(a) * SKELETON.kneelM, d > SKELETON.kneelM + 1 ? 'run' : 'walk', dt, 0.15)) {
          this._go(b, 'kneel'); this._stand(b, 'kneel'); this._say(b, 'skeletonWhimper')
        }
        break
      }
      case 'kneel': case 'beg': {
        const l = b.lure
        this._face(b, l.x, l.z, dt)
        if (!this.lureList.includes(l) || l.kind !== PUMPKIN || d > SKELETON.kneelM + 1.5) { this._go(b, 'rise'); this._play(b, 'rise'); break }
        if (b.state === 'kneel' && b.t >= this.durations.kneel) { this._go(b, 'beg'); this._stand(b, 'beg') }
        if (b.state === 'beg' && now >= b.whimperAt) { b.whimperAt = now + 2 + Math.random() * 2; this._say(b, 'skeletonWhimper') }
        const r = this._at(b, 'Wrist.R', 0, 0, 0, _v), q = this._at(b, 'Wrist.L', 0, 0, 0, _w)
        if (Math.min(r.distanceTo(_pos.set(l.x, l.y, l.z)), q.distanceTo(_pos)) < SKELETON.offerM) { this._go(b, 'take'); this._stand(b, 'take', SKELETON.takeRate) }
        break
      }
      case 'take': {
        const l = b.lure
        if (!this.lureList.includes(l) || l.kind !== PUMPKIN) { this._go(b, 'beg'); this._stand(b, 'beg'); break }
        if (b.t < this.durations.take / SKELETON.takeRate) break
        const rec = this.hands.eatLure(l, 'skeleton')
        if (rec === null) { this._go(b, 'beg'); this._stand(b, 'beg'); break }
        if (b.carrier === null) b.carrier = this.hands.carry(`skeleton:${b.key}`, PUMPKIN_M)
        b.carrier.add(rec, this.pumpkins)
        if (!b.tame && this.friends.size < SKELETON.friendsMax) { b.tame = true; this.friends.add(b.key) }
        this._go(b, 'joy'); this._play(b, 'joy'); this._say(b, 'skeletonGiggle'); this._say(b, 'skeletonRattle')
        break
      }
      case 'joy':
        this._stand(b, 'joy')
        if (b.t >= SKELETON.joyS) {
          b.angle = Math.atan2(-(b.z - her.z), b.x - her.x)
          this._go(b, holding ? 'romp' : b.tame ? 'follow' : 'home')
        }
        break
      case 'romp': {
        // Laps of her at a run, the pumpkin held up.
        b.angle += ((this.asset.gait.run * b.k) / SKELETON.rompR) * dt
        this._walkTo(b, her.x + Math.cos(b.angle) * SKELETON.rompR, her.z - Math.sin(b.angle) * SKELETON.rompR, 'run-carry', dt, 0)
        if (Math.random() < dt * 0.25) this._say(b, 'skeletonGiggle')
        if (b.t >= SKELETON.rompS) this._go(b, b.tame ? 'follow' : 'home')
        break
      }
      case 'fetch': {
        const item = b.fetching
        if (!this.hands.loose.includes(item) || item.state !== 'still') { b.fetching = null; this._go(b, 'follow'); break }
        if (this._walkTo(b, item.x, item.z, 'run', dt, 0.35)) {
          this._stand(b, 'gather')
          if (b.t > 0.6) {
            this.hands.lift(item)
            if (b.carrier === null) b.carrier = this.hands.carry(`skeleton:${b.key}`, item.rec.size)
            b.carrier.add(item.rec, item.src)
            b.fetching = null
            this._go(b, 'bring')
            this._say(b, 'skeletonClack')
          }
        } else b.t = 0
        break
      }
      case 'bring':
        if (this._walkTo(b, her.x, her.z, d > SKELETON.runM ? 'run-carry' : 'walk', dt, 0.9)) {
          b.carrier.scatter()
          this._go(b, 'joy'); this._play(b, 'jig'); this._say(b, 'skeletonGiggle')
        }
        break
      case 'fidget':
        this._face(b, her.x, her.z, dt)
        if (b.t >= b.until) {
          if (b.clip === 'gather') this._dig(b)
          this._go(b, 'follow')
        } else if (d > SKELETON.runM) this._go(b, 'follow')
        break
      case 'follow': {
        if (d > SKELETON.followM) {
          this._walkTo(b, her.x, her.z, d > SKELETON.runM ? (holding ? 'run-carry' : 'run') : 'walk', dt, SKELETON.followM * 0.8)
          break
        }
        this._stand(b, 'idle')
        this._face(b, her.x, her.z, dt)
        const bone = this._lure(b, this.eats, SKELETON.coaxM)
        if (bone !== null && !holding) { this._go(b, 'feed'); break }
        const thrown = holding ? null : this._thrown(b)
        if (thrown !== null) { b.fetching = thrown; this._go(b, 'fetch'); break }
        if (now >= b.nextFidget) this._fidget(b, now, holding)
        break
      }
      default:
        throw new Error(`Skeletons: no state ${b.state}`)
    }
  }

  /** A loose thing come to rest that it fetches: hers to bring back, far enough from her to want bringing, no other follower after it. */
  _thrown(b) {
    for (const item of this.hands.loose) {
      if (item.state !== 'still' || !this.fetches.has(item.rec.kind)) continue
      if (Math.hypot(item.x - this.her.x, item.z - this.her.z) < SKELETON.fetchMinM) continue
      if (Math.hypot(item.x - b.x, item.z - b.z) > SKELETON.fetchM) continue
      if (this.list.some((o) => o.fetching === item)) continue
      return item
    }
    return null
  }

  _fidget(b, now, holding) {
    b.nextFidget = now + between(SKELETON.fidgetS)
    const clip = holding ? pick(['jig', 'talk-nod']) : pick(['jig', 'jig', 'gather', 'talk-nod'])
    this._go(b, 'fidget')
    this._stand(b, clip)
    b.until = clip === 'gather' ? this.durations.gather : this.durations[clip] * (clip === 'jig' ? 2 : 1)
    if (clip === 'jig') this._say(b, 'skeletonGiggle')
    if (clip === 'gather') this._say(b, 'skeletonClack')
  }

  /** A bone dug up at its feet, the oldest dug one gone past dugMax. */
  _dig(b) {
    const x = b.x + Math.cos(b.heading) * 0.35, z = b.z - Math.sin(b.heading) * 0.35
    this.lying.push({ x, y: this._ground(x, z, b.y) + 0.024, z, yaw: Math.random() * Math.PI })
    if (this.lying.length > SKELETON.dugMax + SKELETON.stash) this.lying.shift()
  }

  // -------------------------------------------------------------------------
  // The lost boy, at the hideout while his quest is open.
  // -------------------------------------------------------------------------

  _stepBoy(dt, now) {
    const p = this.place
    if (p === null) return
    if (this.boy === null) {
      const conv = this.conv()
      if (conv === null) return
      const lost = conv.lost().find(({ quest }) => placeKey(quest.where) === p.key)
      if (lost === undefined) return
      if (this.townsfolk.bodies === null) { this.townsfolk.lazy.want(); return }
      const body = this.townsfolk.bodies[TOWNSFOLK.bodies.indexOf(lost.child.body)]
      if (body === undefined) throw new Error(`Skeletons: no townsfolk body ${lost.child.body}`)
      for (const m of [this.boyPlain, this.boyMats.in, this.boyMats.out]) { m.map = body.asset.map; m.needsUpdate = true }
      const puppet = makePuppet(body.asset, this.boyMats, { clipFade: FADE_S })
      this.batch.add(puppet.group)
      // Crouched over his bones by the skeleton, a step off its side.
      const a = p.heading + Math.PI / 2
      const x = p.x + Math.cos(a) * 0.9, z = p.z - Math.sin(a) * 0.9
      this.boy = { quest: lost.quest, puppet, x, y: p.y, z, heading: p.heading - Math.PI / 4, k: body.heightM / body.height, size: body.heightM, speed: 0, clip: 'gather', cue: 0, lod: LOD_RUNGS, foundAt: null }
    }
    const boy = this.boy
    if (boy.foundAt === null && Math.hypot(this.her.x - boy.x, this.her.z - boy.z) < SKELETON.foundM) {
      boy.foundAt = now
      boy.clip = 'wave'
      boy.cue++
      this.conv().found(boy.quest.id)
    }
    if (boy.foundAt !== null) boy.heading += swing(boy.heading, Math.atan2(-(this.her.z - boy.z), this.her.x - boy.x)) * Math.min(1, dt * 4)
    if (boy.foundAt !== null && now - boy.foundAt > SKELETON.goneS) {
      boy.puppet.show(-1)
      if (boy.puppet.done) this._dropBoy()
      else boy.puppet.step(dt)
      return
    }
    this._pose(boy, boy.puppet, dt, 1, 0)
  }

  _dropBoy() {
    if (this.boy === null) return
    this.boy.puppet.release()
    this.batch.remove(this.boy.puppet.group)
    this.boy = null
  }

  // -------------------------------------------------------------------------
  // Drawing.
  // -------------------------------------------------------------------------

  /** A body `c` on its puppet: its rung by distance from her, its clip at `rate`, squashed `squash` of the way into a pile. */
  _pose(c, puppet, dt, rate, squash) {
    c.lod = critterTier(c.size, Math.hypot(c.x - this.her.x, c.y - this.her.hy, c.z - this.her.z), c.lod, LOD_RUNGS)
    puppet.show(c.lod === LOD_RUNGS ? -1 : c.lod)
    _pos.set(c.x, c.y, c.z)
    _quat.setFromAxisAngle(UP, c.heading)
    _scl.set(c.k * (1 + 0.4 * squash), c.k * (1 - 0.85 * squash), c.k * (1 + 0.4 * squash))
    _mat.compose(_pos, _quat, _scl)
    puppet.play(c.clip, c.cue)
    groundFeet(puppet, c, this.walk, PLANTED, false)
    puppet.step(dt * rate)
    puppet.group.matrix.copy(_mat)
    puppet.group.matrixWorldNeedsUpdate = true
  }

  _draw(dt) {
    let e = 0
    for (const b of this.list) {
      this._pose(b, b.puppet, dt, b.rate, b.squash)
      const holding = b.carrier !== null && b.carrier.count() > 0
      if (holding) {
        this._at(b, 'Wrist.R', 0, 0, 0, _v).add(this._at(b, 'Wrist.L', 0, 0, 0, _w)).multiplyScalar(0.5)
        b.carrier.grip(_v.x + Math.cos(b.heading) * 0.12, _v.y, _v.z - Math.sin(b.heading) * 0.12, b.heading)
      }
      if (b.squash > 0.5 || b.lod === LOD_RUNGS) continue
      for (const side of [-1, 1]) {
        this._at(b, 'Head', EYE.x, EYE.y, side * EYE.z, _v)
        _mat.compose(_v, _quat.identity(), _scl.setScalar(EYE.r * b.k))
        this.eyes.setMatrixAt(e++, _mat)
      }
    }
    this.eyes.count = e
    this.eyes.instanceMatrix.needsUpdate = true
    this._drawStash()
  }

  _drawStash() {
    this.lying.forEach((l, i) => {
      _mat.compose(_pos.set(l.x, l.y, l.z), _quat.setFromAxisAngle(UP, l.yaw), _scl.setScalar(1))
      this.stash.setMatrixAt(i, _mat)
    })
    this.stash.count = this.lying.length
    this.stash.instanceMatrix.needsUpdate = true
    this.caps.forEach((c, i) => {
      _mat.compose(_pos.set(c.x, c.y, c.z), _quat.setFromAxisAngle(UP, c.yaw), _scl.setScalar(1))
      this.capMesh.setMatrixAt(i, _mat)
    })
    this.capMesh.count = this.caps.length
    this.capMesh.instanceMatrix.needsUpdate = true
  }

  // -------------------------------------------------------------------------
  // For the world: the ear, the spiders, her hands.
  // -------------------------------------------------------------------------

  /** Every skeleton drawn, for the ear's footfalls: x, y, z, size, clip, cycle and speed. */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const b of this.list) if (b.lod < LOD_RUNGS && b.state !== 'pile') into.push(b)
    return into
  }

  /** Its rattles, giggles and whimpers since the last call, moved into `into`. */
  voices(into) {
    for (const v of this.said) into.push(v)
    this.said.length = 0
    return into
  }

  /** Every standing skeleton as a body the spiders flee, `{ x, y, z, foot, by }`, appended to `into`. */
  scarers(into) {
    let i = 0
    for (const b of this.list) {
      if (b.state === 'pile') continue
      const s = this.scare[i] ?? (this.scare[i] = { x: 0, y: 0, z: 0, foot: 0, by: null })
      s.x = b.x; s.y = b.y + b.size; s.z = b.z; s.foot = b.y
      into.push(s)
      i++
    }
    return into
  }

  /** The lying bone or growing cap nearest (x, y, z) within `reach`: `{ dist, kind, at, size }`, or null. For hands.js. */
  pickAt(x, y, z, reach) {
    let best = null
    for (const [kind, list, size, up] of [[BONE_KIND, this.lying, BONE_M, 0], [CAP_KIND, this.caps, CAP_M, CAP_M / 2]]) {
      for (const at of list) {
        const dist = Math.max(0, Math.hypot(at.x - x, at.y + up - y, at.z - z) - size / 2)
        if (dist < reach && (best === null || dist < best.dist)) best = { dist, kind, at, size }
      }
    }
    return best
  }

  take(hit) {
    const list = hit.kind === BONE_KIND ? this.lying : this.caps
    const i = list.indexOf(hit.at)
    if (i < 0) throw new Error(`Skeletons.take: that ${hit.kind} was taken already`)
    list.splice(i, 1)
    const name = hit.kind === BONE_KIND ? 'bone' : 'ghost cap'
    return { kind: hit.kind, name, size: hit.size, scale: [1, 1, 1], color: null, stowable: true, attrs: {}, ...this.dress({ kind: hit.kind }) }
  }

  dress(slot) {
    if (slot.kind === BONE_KIND) return { geometry: this.boneGeo, material: this.boneMat }
    if (slot.kind === CAP_KIND) return { geometry: this.capGeo, material: this.capMat }
    throw new Error(`Skeletons.dress: not a bone or a ghost cap, ${slot.kind}`)
  }

  get stats() {
    return { list: this.list.map((b) => `${b.key}:${b.state}${b.tame ? '*' : ''}`), lying: this.lying.length, caps: this.caps.length, boy: this.boy !== null, place: this.place && this.place.key }
  }

  dispose() {
    for (const b of this.list.slice()) this._drop(b)
    this._dropBoy()
    this.batch.removeFromParent()
    for (const m of this.materials) m.dispose()
    this.boneMat.dispose()
    this.boneGeo.dispose()
    this.capMat.dispose()
    this.capGeo.dispose()
  }
}

const PUMPKINS = new Set([PUMPKIN])

/** A hideout's place key (talk/quests.js hideouts), as `intoCave` and `intoCastle` name the place she is in. */
export function placeKey(h) {
  if (h.kind === 'cave') return `cave:${h.system}`
  if (h.kind === 'castle') return `castle:${h.site}`
  throw new Error(`Skeletons: no hideout kind ${h.kind}`)
}
