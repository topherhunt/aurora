// Node-side gates for the spiders (src/v2/render/spiders.js).
//
//   node scripts/check-spiders.mjs
//
// The scatter runs against a synthetic wood on flat ground: a stand of trunks
// of several girths (straight cones and crooked, lobed boles, one a sapling too
// thin to host), a sphere boulder, a six-metre pillar, a cobble and a stone
// just under two metres, both too small to host, a boulder under a pond, a flat slab and a buried stone with no wall to
// climb, a boulder on a puddle's bank, and a tree and a rock far off.
// Everything below is a way a spider can go wrong without anything throwing: a
// group of none or six; a spider on the terrain, off its surface, under the
// ground, in the water or above the climb; spiders mostly on the tops of
// things; a spider on a sapling, a cobble, a stone under two metres, a drowned
// rock, a slab or a buried stone; a scatter that is not the same twice; a spider that never moves,
// walks off its stone or climbs past three metres; one left spinning in the
// air when its stone is gone, or left behind when its trunk re-seats; a near
// spider drawn as a card or a far one as a mesh, a mesh on the wrong tier, a
// spider drawn twice or not at all, legs that swing while it sits or hold still
// while it walks, a leg baked onto the body or a body vertex onto a leg, or one
// that does not rear up when she is close; one that does not run from her body
// at arm's length or only from her head, runs toward her, no faster than its
// walk, is heard setting off twice, stops short while it is still gaining
// ground, or runs on once it can gain no more or is three metres off, or bolts
// again while she stands over it; a host above the snow line with a group on
// it; a card that is two quads, or that does not lie where its spider clings at
// its tilt; a frame that costs more than a scatter is allowed to. The shipped
// GLB is checked for shape too -- a skinned tier per rung of the ladder, the
// skeleton naming its legs and its six clips -- because the world loads it by
// name and bakes the legs off its skeleton.
//
// What this can NOT check: whether they look like spiders, or how the crawl
// reads. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import {
  Spiders, SHIPPED_TIERS, LOD_TIERS, NEAR_M, SIZE_M, CLIMB_M, GROUP, ROCK_MIN_SIZE, TRUNK_MIN_R, FLAT_NY, MAX, SINK, RESEAT_EVERY, WALL_M, FLEE_M, FLEE_TO_M, FLEE_HASTE, STALL_S, STRIDE, REAR_RAD,
} from '../src/v2/render/spiders.js'
import { WALK } from '../src/v2/walk.js'
import { PERCH_STRIDE } from '../src/v2/render/rocks.js'
import { TRUNK_STRIDE } from '../src/v2/render/trees.js'
import { CRITTER_GLB, critterTier, lodReach } from '../src/v2/render/critters.js'
import { TEX_PX_SMALL } from '../tools/creatures/creature-roster.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the synthetic wood ----------------------------------------------------------
const GROUND = 5
// Her eyes over her feet: every update below takes her head and puts her feet this far under it.
const EYE = 1.65
const tick = (k, x, y, z, dt) => k.update(x, y, z, dt, y - EYE)
// The snow line is a hundred metres up, except where a test lowers it.
let snowLine = GROUND + 100
const height = { heightAt: () => GROUND, snowLineAt: () => snowLine }
const POND = { x: 30, z: 30, r: 6 }
// And a puddle a boulder stands in, its level a hand over the ground.
const PUDDLE = { x: -14, z: 12, r: 3, y: GROUND + 0.3 }
const levelAt = (x, z) => (Math.hypot(x - POND.x, z - POND.z) < POND.r ? GROUND + 1 : Math.hypot(x - PUDDLE.x, z - PUDDLE.z) < PUDDLE.r ? PUDDLE.y : null)
const water = { levelAt, isSubmerged: (x, z, g) => { const l = levelAt(x, z); return l !== null && g < l } }

// Trunks: base radius and height. Each is its own variant of the trees' LOD0 profile, a unit-tall trunk the stub scales by the height and turns by the yaw, as Trees.trunksInto says: the oaks crooked and lobed, the rest straight eight-sided cones; the pine and the thin birch are two-ring cones, a base ring straight to the apex, the shape the shipped pine has. The thin birch's bark thins under TRUNK_MIN_R two metres up, which caps its climb there.
const TAU = Math.PI * 2
const TRUNKS = [
  { name: 'oak', x: 2, z: 0, r0: 0.35, height: 15, yaw: 0.7 },
  { name: 'pine', x: -3, z: 4, r0: 0.2, height: 12, yaw: 2.1 },
  { name: 'birch', x: 6, z: -5, r0: 0.12, height: 9, yaw: 4.0 },
  { name: 'birch2', x: -6, z: -6, r0: 0.08, height: 8, yaw: 5.5 },
  { name: 'oak2', x: 9, z: 6, r0: 0.4, height: 18, yaw: 3.3 },
  { name: 'sapling', x: 0, z: 8, r0: 0.03, height: 2, yaw: 0 },
  { name: 'far', x: 80, z: 80, r0: 0.3, height: 12, yaw: 1 },
]
/** A trunkProfile in tree.js's shape: rings of `sides` corners about their own centres, the apex last. */
function makeProfile(t) {
  const ur = t.r0 / t.height
  const crooked = t.name.startsWith('oak')
  const rings = crooked
    ? [{ y: 0, cx: 0, cz: 0, r: ur }, { y: 0.3, cx: 0.03, cz: 0.01, r: ur * 0.8 }, { y: 0.62, cx: 0.05, cz: -0.02, r: ur * 0.55 }, { y: 0.9, cx: 0.06, cz: -0.03, r: 0 }]
    : t.name === 'pine' || t.name === 'birch2'
      ? [{ y: 0, cx: 0, cz: 0, r: ur }, { y: 1, cx: 0, cz: 0, r: 0 }]
      : [{ y: 0, cx: 0, cz: 0, r: ur }, { y: 1 / 3, cx: 0, cz: 0, r: ur * 2 / 3 }, { y: 2 / 3, cx: 0, cz: 0, r: ur / 3 }, { y: 1, cx: 0, cz: 0, r: 0 }]
  const sides = crooked ? 9 : 8
  const y = new Float32Array(rings.length)
  const radius = new Float32Array(rings.length)
  const centre = new Float32Array(rings.length * 3)
  const corners = new Float32Array(rings.length * sides * 3)
  rings.forEach((ring, r) => {
    y[r] = ring.y
    radius[r] = ring.r
    centre[r * 3] = ring.cx; centre[r * 3 + 1] = ring.y; centre[r * 3 + 2] = ring.cz
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * TAU
      const radius = ring.r * (crooked ? 1 + 0.1 * Math.cos(2 * a + 0.4) : 1)
      const o = (r * sides + k) * 3
      corners[o] = ring.cx + Math.cos(a) * radius; corners[o + 1] = ring.y; corners[o + 2] = ring.cz + Math.sin(a) * radius
    }
  })
  return { sides, y, radius, centre, corners }
}
// Rocks: a sphere sits with its centre `cy` over the ground (0: on it); a pillar is a vertical cylinder of radius r and height h. The slab is a knee-high disc, the buried stone a sphere showing a hand's height of crown, the wader a sphere on the puddle's bank whose near side dips into the water.
const ROCKS = [
  { name: 'sphere', kind: 'sphere', x: -8, z: 2, r: 1.5 },
  { name: 'pillar', kind: 'pillar', x: 4, z: 10, r: 0.8, h: 6 },
  { name: 'cobble', kind: 'sphere', x: -2, z: -3, r: 0.2 },
  { name: 'small', kind: 'sphere', x: 14, z: 2, r: 0.9 },
  { name: 'drowned', kind: 'sphere', x: POND.x, z: POND.z, r: 1.5 },
  { name: 'slab', kind: 'pillar', x: 12, z: -10, r: 1.5, h: 0.25 },
  { name: 'buried', kind: 'sphere', x: -12, z: -12, r: 1.5, cy: -1.3 },
  { name: 'wader', kind: 'sphere', x: PUDDLE.x + PUDDLE.r + 0.5, z: PUDDLE.z, r: 1.5 },
  { name: 'far', kind: 'sphere', x: -80, z: 80, r: 2 },
]
const sizeOf = (b) => (b.kind === 'sphere' ? 2 * b.r : Math.max(2 * b.r, b.h))
const hullOf = (b) => (b.kind === 'sphere' ? b.r * 1.1 : Math.max(b.r, b.h / 2) * 1.1)
let liveTrunks = []
let liveRocks = []
// Where the trunks' origins sit; moved to stand in for a chunk re-seating its trees.
let trunkY = GROUND - 0.1
const trees = {
  trunkProfile: TRUNKS.map(makeProfile),
  trunksInto(x0, z0, x1, z1, out) {
    let w = 0
    for (const t of liveTrunks) {
      if (t.x < x0 || t.x >= x1 || t.z < z0 || t.z >= z1) continue
      const o = w * TRUNK_STRIDE
      out[o] = t.x; out[o + 1] = trunkY; out[o + 2] = t.z; out[o + 3] = t.r0; out[o + 4] = t.height; out[o + 5] = t.yaw; out[o + 6] = TRUNKS.indexOf(t)
      w++
    }
    return w
  },
}
/** Nearest hit of one rock on the ray, or Infinity; `out` written like Rocks.rayAt, the normal facing the ray. */
function rayRock(b, x, y, z, dx, dy, dz, reach, out) {
  let best = Infinity
  let nx = 0, ny = 0, nz = 0
  const px = x - b.x, pz = z - b.z
  if (b.kind === 'sphere') {
    const py = y - GROUND - (b.cy ?? 0)
    const bb = px * dx + py * dy + pz * dz
    const cc = px * px + py * py + pz * pz - b.r * b.r
    const disc = bb * bb - cc
    if (disc < 0) return Infinity
    const sq = Math.sqrt(disc)
    for (const t of [-bb - sq, -bb + sq]) {
      if (t <= 0 || t > reach || t >= best) continue
      if (y + dy * t < GROUND) continue
      best = t
      nx = (px + dx * t) / b.r; ny = (py + dy * t) / b.r; nz = (pz + dz * t) / b.r
    }
  } else {
    const a = dx * dx + dz * dz
    const bb = px * dx + pz * dz
    const cc = px * px + pz * pz - b.r * b.r
    if (a > 1e-12) {
      const disc = bb * bb - a * cc
      if (disc >= 0) {
        const sq = Math.sqrt(disc)
        for (const t of [(-bb - sq) / a, (-bb + sq) / a]) {
          if (t <= 0 || t > reach || t >= best) continue
          const hy = y + dy * t
          if (hy < GROUND || hy > GROUND + b.h) continue
          best = t
          nx = (px + dx * t) / b.r; ny = 0; nz = (pz + dz * t) / b.r
        }
      }
    }
    if (Math.abs(dy) > 1e-12) {
      const t = (GROUND + b.h - y) / dy
      if (t > 0 && t <= reach && t < best) {
        const hx = px + dx * t, hz = pz + dz * t
        if (hx * hx + hz * hz <= b.r * b.r) { best = t; nx = 0; ny = 1; nz = 0 }
      }
    }
  }
  if (best === Infinity) return Infinity
  if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz }
  out.x = x + dx * best; out.y = y + dy * best; out.z = z + dz * best
  out.nx = nx; out.ny = ny; out.nz = nz
  out.ox = b.x; out.oz = b.z; out.size = sizeOf(b)
  return best
}
const rocks = {
  rays: 0,
  perchesInto(x0, z0, x1, z1, out) {
    let w = 0
    for (const b of liveRocks) {
      if (b.x < x0 || b.x >= x1 || b.z < z0 || b.z >= z1) continue
      const o = w * PERCH_STRIDE
      out[o] = b.x; out[o + 1] = GROUND - 0.3; out[o + 2] = b.z; out[o + 3] = hullOf(b); out[o + 4] = sizeOf(b)
      w++
    }
    return w
  },
  rayAt(x, y, z, dx, dy, dz, reach, minSize, out) {
    this.rays++
    if (Math.abs(Math.hypot(dx, dy, dz) - 1) > 1e-6) throw new Error('rayAt wants a unit direction')
    let best = Infinity
    for (const b of liveRocks) {
      if (sizeOf(b) < minSize) continue
      const d = rayRock(b, x, y, z, dx, dy, dz, Math.min(reach, best), out)
      if (d < best) best = d
    }
    return best
  },
}
/** How far a point is off a rock's surface, in metres. */
const offRock = (b, c) => {
  if (b.kind === 'sphere') return Math.abs(Math.hypot(c.x - b.x, c.y - GROUND, c.z - b.z) - b.r)
  const radial = Math.abs(Math.hypot(c.x - b.x, c.z - b.z) - b.r)
  return c.y <= GROUND + b.h + 1e-6 ? radial : Math.abs(c.y - GROUND - b.h)
}
/** How far a point is off the trunk's own triangles -- the bark as tree.js's addCone winds it from the profile, scaled and yawed as the stub places it. */
const _tri = new THREE.Triangle()
const _p = new THREE.Vector3()
const _q = new THREE.Vector3()
function offTrunk(t, c) {
  const prof = trees.trunkProfile[TRUNKS.indexOf(t)]
  const { sides, y, corners } = prof
  const cy = Math.cos(t.yaw), sy = Math.sin(t.yaw)
  const wx = c.x - t.x, wz = c.z - t.z
  _p.set((wx * cy - wz * sy) / t.height, (c.y - trunkY) / t.height, (wx * sy + wz * cy) / t.height)
  const P = (r, k) => new THREE.Vector3().fromArray(corners, (r * sides + (k % sides)) * 3)
  let best = Infinity
  for (let r = 0; r < y.length - 1; r++) {
    for (let k = 0; k < sides; k++) {
      for (const tri of [[P(r, k), P(r, k + 1), P(r + 1, k + 1)], [P(r, k), P(r + 1, k + 1), P(r + 1, k)]]) {
        _tri.set(...tri).closestPointToPoint(_p, _q)
        best = Math.min(best, _q.distanceTo(_p))
      }
    }
  }
  return best * t.height
}
/** Whether a normal points away from the trunk's centre line at the spider's height, in the world. */
function outwardOfTrunk(t, c) {
  const { y, centre } = trees.trunkProfile[TRUNKS.indexOf(t)]
  const fy = (c.y - trunkY) / t.height
  let r = 0
  while (r < y.length - 2 && y[r + 1] <= fy) r++
  const f = (fy - y[r]) / (y[r + 1] - y[r])
  const lx = centre[r * 3] + (centre[(r + 1) * 3] - centre[r * 3]) * f
  const lz = centre[r * 3 + 2] + (centre[(r + 1) * 3 + 2] - centre[r * 3 + 2]) * f
  const cy = Math.cos(t.yaw), sy = Math.sin(t.yaw)
  const ax = t.x + t.height * (lx * cy + lz * sy)
  const az = t.z + t.height * (lz * cy - lx * sy)
  return c.nx * (c.x - ax) + c.nz * (c.z - az) > 0
}
const hostOf = (c) => (c.host.kind === 'tree' ? TRUNKS : ROCKS).find((h) => h.x === c.host.x && h.z === c.host.z)
const offSurface = (c) => (c.host.kind === 'tree' ? offTrunk(hostOf(c), c) : offRock(hostOf(c), c))

// --- the shipped asset ---------------------------------------------------------
{
  const file = new URL(`../public/${CRITTER_GLB.spider}`, import.meta.url)
  check(fs.existsSync(file), `${CRITTER_GLB.spider} is shipped -- run tools/creatures/ship-spider.mjs`)
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file)
    check(buf.toString('latin1', 0, 4) === 'glTF', 'the spider GLB has a glTF header')
    const jsonLen = buf.readUInt32LE(12)
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen))
    const names = (json.meshes ?? []).map((m) => m.name)
    check(names.length === SHIPPED_TIERS && names.join(',') === ['birch-spider', ...Array.from({ length: SHIPPED_TIERS - 1 }, (_, k) => `birch-spider-lod${k + 1}`)].join(','), `${SHIPPED_TIERS} tiers, the pick then lod1 up, one for each rung of the ladder`, names.join(','))
    const tris = (json.meshes ?? []).map((m) => json.accessors[m.primitives[0].indices].count / 3)
    check(tris.every((t, k) => k === 0 || t < tris[k - 1]) && tris[tris.length - 1] >= 50, 'each tier is coarser than the last and the coarsest is still a spider and not a smear', tris.join('/'))
    check((json.meshes ?? []).every((m) => m.primitives.length === 1 && m.primitives[0].attributes.JOINTS_0 !== undefined && m.primitives[0].attributes.WEIGHTS_0 !== undefined && m.primitives[0].material === 0), 'every tier is skinned, one primitive, on the one material')
    const skin = json.skins?.[0]
    check(json.skins?.length === 1 && skin.joints.length === 42 && json.nodes[skin.skeleton].name === 'Pedicel', 'one skeleton of 42 joints rooted at the Pedicel', `${skin?.joints.length} joints`)
    const legBones = (skin?.joints ?? []).map((j) => json.nodes[j].name).filter((n) => /^Leg[1-4](Hip|Knee|Ankle|Foot)\.(L|R)$/.test(n))
    check(legBones.length === 32, 'the skeleton names its eight legs, Leg1 to Leg4 by side, hip to foot -- the legs are baked off these names', `${legBones.length} leg bones`)
    check((json.nodes ?? []).filter((n) => n.skin !== undefined).length === SHIPPED_TIERS && (json.nodes ?? []).filter((n) => n.skin !== undefined).every((n) => n.skin === 0), 'every tier node wears the one skin')
    const clips = (json.animations ?? []).map((a) => a.name)
    check(clips.join(',') === 'walk,run,idle,alert,eat,rest', 'the six clips, walk run idle alert eat rest', clips.join(','))
    const joints = new Set(skin?.joints ?? [])
    check((json.animations ?? []).every((a) => a.channels.every((ch) => joints.has(ch.target.node))), 'every clip channel targets a joint of the skeleton')
    check((json.animations ?? []).every((a) => a.samplers.every((s) => json.accessors[s.input].min !== undefined && json.accessors[s.input].max !== undefined)), 'every sampler input carries min and max')
    check(!fs.existsSync(new URL('../public/creatures/birch-spider-lod1.glb', import.meta.url)) && !fs.existsSync(new URL('../public/creatures/birch-spider-lod4.glb', import.meta.url)), 'no separate ladder files beside it: the tiers are in the one GLB')
    const image = json.images?.[0]
    check(image?.uri === 'birch-spider.webp' && image.bufferView === undefined && json.images.length === 1, 'the one image is the packed WebP beside the GLB', JSON.stringify(json.images))
    if (image?.uri && fs.existsSync(new URL(image.uri, file))) {
      const { width, height: h } = webpSize(fs.readFileSync(new URL(image.uri, file)))
      check(width === TEX_PX_SMALL && h === TEX_PX_SMALL, `the colour map is ${TEX_PX_SMALL}px square`, `${width}x${h}`)
    } else check(false, 'the WebP is shipped')
    check(json.extensionsRequired?.includes('EXT_texture_webp') && json.textures?.[0]?.extensions?.EXT_texture_webp?.source === 0, 'the texture declares EXT_texture_webp')
    const pbr = json.materials?.[0]?.pbrMetallicRoughness
    check(json.materials?.length === 1 && pbr?.metallicFactor === 0 && pbr.roughnessFactor === 1 && pbr.metallicRoughnessTexture === undefined && json.materials[0].normalTexture === undefined, 'one matte material, colour only')
  }
}

// --- a stand-in asset: two slabs on a skeleton of a body, a head and eight hips, six clips ---------------
// A slab a metre square and 0.25 high; its two side faces (x = +-0.5) are the legs, four a side by z, each vertex there weighted to its hip, and everything between is the body on the Pedicel.
const LEG_Z = [-0.375, -0.125, 0.125, 0.375]
const legOfVertex = (x, z) => (Math.abs(x) < 0.5 - 1e-6 ? -1 : Math.min(3, Math.floor((z + 0.5) / 0.25)) * 2 + (x > 0 ? 1 : 0))
function makeAsset({ legs = true } = {}) {
  const root = new THREE.Bone()
  root.name = 'Pedicel'
  const head = new THREE.Bone()
  head.name = 'Head'
  head.position.set(0, 0.1, -0.6)
  root.add(head)
  const bones = [root, head]
  if (legs) {
    for (let n = 0; n < 4; n++) {
      for (const side of ['L', 'R']) {
        const hip = new THREE.Bone()
        hip.name = `Leg${n + 1}Hip.${side}`
        hip.position.set(side === 'L' ? -0.5 : 0.5, 0.125, LEG_Z[n])
        root.add(hip)
        bones.push(hip)
      }
    }
  }
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const tiers = [4, 2].map((seg) => {
    const geo = new THREE.BoxGeometry(1, 0.25, 1, seg, 1, seg).translate(0, 0.125, 0)
    const pos = geo.getAttribute('position')
    const n = pos.count
    const idx = new Uint16Array(n * 4)
    const wgt = new Float32Array(n * 4)
    for (let v = 0; v < n; v++) {
      const leg = legs ? legOfVertex(pos.getX(v), pos.getZ(v)) : -1
      idx[v * 4] = leg < 0 ? 0 : 2 + leg
      wgt[v * 4] = 1
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4))
    return geo
  })
  const clips = [['walk', 0.9], ['run', 0.42], ['idle', 3.2], ['alert', 3], ['eat', 1.6], ['rest', 5.2]].map(([name, dur]) =>
    new THREE.AnimationClip(name, dur, [new THREE.QuaternionKeyframeTrack('Pedicel.quaternion', [0, dur], [0, 0, 0, 1, 0, 0, 0, 1])]))
  return { root, skeleton, tiers, clips, map: null }
}

// --- construction and the shader hook -----------------------------------------
const scene = new THREE.Scene()
const spiders = new Spiders(scene, height, water, { seed: 34, trees, rocks, assets: makeAsset() })
check(spiders.loaded && Math.abs(spiders.span - 1) < 1e-6 && Math.abs(spiders.bodyH - 0.25) < 1e-6, 'asset set: span 1, body 0.25 high', `span ${spiders.span} body ${spiders.bodyH}`)
check(spiders.material.isMeshLambertMaterial && spiders.materials === undefined, 'ONE material for every mesh spider, and nothing else to patch')
check(spiders.meshes.length === LOD_TIERS && spiders.meshes.every((m, k) => m.isInstancedMesh && !m.isSkinnedMesh && m.material === spiders.material && m.count === 0 && m.instanceMatrix.count === MAX && m.geometry === spiders.asset.tiers[k] && m.geometry.getAttribute('aGait') === spiders.gaits[k] && m.geometry.getAttribute('aLeg')?.itemSize === 2), `${LOD_TIERS} InstancedMeshes, no skeleton on any, each the asset's tier with its legs baked on and its gaits per instance, none drawn yet`)
check(spiders.gaits.every((g) => g.isInstancedBufferAttribute && g.itemSize === 2 && g.count === MAX), 'a gait -- phase and amplitude -- per instance per tier')
check(!spiders.card.visible && spiders.card.count === 0 && spiders.batch.children.length === LOD_TIERS + 1 && spiders.meshes.every((m) => spiders.batch.children.includes(m)), 'the card is hidden until baked, and the tiers and the card are the whole batch')
{
  // The legs as baked onto tier 0: a side-face vertex swings with its leg, a body vertex never does.
  const geo = spiders.asset.tiers[0]
  const pos = geo.getAttribute('position')
  const leg = geo.getAttribute('aLeg')
  let bodyStill = true, legMoves = true, halves = new Set(), reachOne = new Map()
  for (let v = 0; v < pos.count; v++) {
    const l = legOfVertex(pos.getX(v), pos.getZ(v))
    if (l < 0) { if (leg.getX(v) !== 0 || leg.getY(v) !== 0) bodyStill = false; continue }
    if (!(leg.getY(v) > 0 && leg.getY(v) <= 1 + 1e-6)) legMoves = false
    halves.add(`${l}:${leg.getX(v)}`)
    reachOne.set(l, Math.max(reachOne.get(l) ?? 0, leg.getY(v)))
  }
  check(bodyStill && legMoves, 'a body vertex is baked 0,0 and every leg vertex a depth in (0, 1]')
  check(reachOne.size === 8 && [...reachOne.values()].every((r) => Math.abs(r - 1) < 1e-6), 'every one of the eight legs reaches 1 at its furthest vertex', `${reachOne.size} legs`)
  const half = (l) => [...halves].filter((h) => h.startsWith(`${l}:`)).map((h) => +h.split(':')[1])
  check([0, 3, 4, 7].every((l) => half(l).length === 1 && half(l)[0] === 0) && [1, 2, 5, 6].every((l) => half(l).length === 1 && Math.abs(half(l)[0] - Math.PI) < 1e-6), 'the alternating tetrapod: L1 R2 L3 R4 step together, R1 L2 R3 L4 half a cycle behind')
  let threw = false
  try { new Spiders(scene, height, water, { seed: 1, trees, rocks, assets: makeAsset({ legs: false }) }) } catch { threw = true }
  check(threw, 'a skeleton naming no legs is refused at setAsset')
}
{
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <clipping_planes_fragment>\n#include <map_fragment>\n' }
  spiders.material.onBeforeCompile(shader)
  check(shader.vertexShader.includes('attribute vec2 aLeg;') && shader.vertexShader.includes('attribute vec2 aGait;') && /transformed\.z -= legSwing \* sin\( legAt \)/.test(shader.vertexShader) && shader.vertexShader.indexOf('#include <begin_vertex>') < shader.vertexShader.indexOf('legSwing'), 'the legs are the vertex shader: the swing is added to `transformed` after begin_vertex, phased by the instance\'s gait and the vertex\'s leg')
  check(!shader.fragmentShader.includes('uHue') && !shader.vertexShader.includes('aHue') && !shader.fragmentShader.includes('discard'), 'nothing per-spider in the fragment and no discard in it, so it does not cost a tiled GPU its early-Z')
  check(spiders.material.customProgramCacheKey() === 'spiders-legs', 'one program for every tier')
  const cshader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <map_fragment>\n#include <normal_fragment_begin>\n' }
  spiders.cardMaterial.onBeforeCompile(cshader)
  check(!cshader.vertexShader.includes('attribute float aHue;') && spiders.cardMaterial.customProgramCacheKey().endsWith('-flat'), 'and the card wears no hue either, there being none on the mesh it takes over from')
  const geo = spiders.card.geometry
  const pos = geo.getAttribute('position')
  const ys = new Set(Array.from({ length: pos.count }, (_, i) => pos.getY(i).toFixed(6)))
  check(geo.index.count === 6 && pos.count === 4 && ys.size === 1, 'the card is ONE quad, lying flat at the body\'s middle', `${geo.index.count / 3} tris at y ${[...ys].join(',')}`)
}

// --- placement -----------------------------------------------------------------
const alive = (of = spiders) => of.slots.filter((c) => c.host !== null)
liveTrunks = TRUNKS
liveRocks = ROCKS
const SEEDS = 40
const pool = []
const groupSizes = []
const hosted = { tree: 0, rock: 0 }
const hostedOf = new Map()
let dropped = 0
for (let seed = 1; seed <= SEEDS; seed++) {
  const k = new Spiders(scene, height, water, { seed, trees, rocks, assets: makeAsset() })
  k.place(0, 0)
  dropped += k.overflow + k.saturated
  for (const t of k.tiles.values()) {
    for (const h of t.hosts.values()) {
      if (!h.spiders.length) continue
      groupSizes.push(h.spiders.length)
      hosted[h.kind]++
      const name = (h.kind === 'tree' ? TRUNKS : ROCKS).find((x) => x.x === h.x && x.z === h.z).name
      hostedOf.set(name, (hostedOf.get(name) ?? 0) + 1)
    }
  }
  for (const c of alive(k)) pool.push({ ...c, host: c.host })
  k.dispose()
}
spiders.place(0, 0)
{
  check(dropped === 0, 'nothing was dropped for want of room, over every seed')
  check(pool.length >= 3 * SEEDS, 'the wood carries spiders', `${pool.length} over ${SEEDS} seeds; one seed: ${JSON.stringify(spiders.stats)}`)
  check(groupSizes.every((n) => n >= GROUP[0] && n <= GROUP[1]) && Math.min(...groupSizes) === GROUP[0] && Math.max(...groupSizes) === GROUP[1], `every group is ${GROUP[0]} to ${GROUP[1]}, and both ends are seen`, `${groupSizes.join(' ')}`)
  check(hosted.tree > 0 && hosted.rock > 0, 'groups on trees and on rocks alike', `${hosted.tree} tree groups, ${hosted.rock} rock groups`)
  check(!hostedOf.has('sapling') && !hostedOf.has('cobble') && !hostedOf.has('small') && !hostedOf.has('drowned') && !hostedOf.has('far'), `none on the sapling (under ${TRUNK_MIN_R} m), the cobble or the ${sizeOf(ROCKS.find((b) => b.name === 'small'))} m stone (under ${ROCK_MIN_SIZE} m), the drowned rock or anything far off`, [...hostedOf.keys()].join(', '))
  check(!hostedOf.has('slab') && !hostedOf.has('buried'), `none on the slab or the buried stone: no ${WALL_M} m of wall to climb`, [...hostedOf.keys()].join(', '))
  const waders = pool.filter((c) => hostOf(c).name === 'wader')
  const wet = waders.filter((c) => levelAt(c.x, c.z) !== null)
  check(hostedOf.has('wader') && wet.every((c) => c.y > PUDDLE.y + 0.04), 'the boulder on the puddle\'s bank carries spiders, none of them at the waterline on its wet side', `${waders.length} spiders, ${wet.length} over the water, lowest ${wet.length ? (Math.min(...wet.map((c) => c.y)) - PUDDLE.y).toFixed(2) : '-'} m over it`)
  check(pool.every((c) => c.ny > -0.3), 'no spider hangs from a ceiling', `lowest ny ${Math.min(...pool.map((c) => c.ny)).toFixed(2)}`)
  check(pool.every((c) => c.size >= SIZE_M[0] - 1e-6 && c.size <= SIZE_M[1] + 1e-6), `every spider is ${SIZE_M[0]} to ${SIZE_M[1]} m`, `${Math.min(...pool.map((c) => c.size)).toFixed(3)} to ${Math.max(...pool.map((c) => c.size)).toFixed(3)} m`)
  const hs = pool.map((c) => c.y - GROUND)
  check(hs.every((h) => h >= 0 && h <= CLIMB_M + 1e-6), `every spider is 0 to ${CLIMB_M} m up`, `${Math.min(...hs).toFixed(2)} to ${Math.max(...hs).toFixed(2)} m`)
  check(Math.max(...hs) > 2 && Math.min(...hs) < 0.3, 'and the climb is used, top and bottom')
  const pillar = pool.filter((c) => hostOf(c).name === 'pillar')
  check(pillar.length > 0 && pillar.every((c) => c.y - GROUND <= CLIMB_M) && Math.max(...pillar.map((c) => c.y - GROUND)) > 1.5, `the 6 m pillar's spiders stop at ${CLIMB_M} m and some climb past 1.5`, `${pillar.length} spiders, highest ${Math.max(...pillar.map((c) => c.y - GROUND)).toFixed(2)} m`)
  const off = pool.map(offSurface)
  check(off.every((d) => d < 1e-4), 'every spider sits on its host\'s own surface', `worst ${Math.max(...off).toExponential(2)} m`)
  check(pool.every((c) => Math.abs(Math.hypot(c.nx, c.ny, c.nz) - 1) < 1e-6 && Math.abs(c.tx * c.nx + c.ty * c.ny + c.tz * c.nz) < 1e-6), 'unit normal, heading in the tangent plane')
  const flat = pool.filter((c) => c.ny > FLAT_NY).length / pool.length
  check(flat < 0.15, `few sit on top of anything (normal rising past ${FLAT_NY})`, `${(flat * 100).toFixed(0)}% flat`)
  const onTrees = pool.filter((c) => c.host.kind === 'tree')
  check(onTrees.every((c) => Math.abs(c.ny) < 0.2 && outwardOfTrunk(hostOf(c), c)), 'a tree spider clings to the bark, its normal off the trunk\'s centre line and near level, the crooked boles\' lean and all', `ny ${Math.min(...onTrees.map((c) => c.ny)).toFixed(3)} to ${Math.max(...onTrees.map((c) => c.ny)).toFixed(3)}`)
  check(onTrees.some((c) => hostOf(c).name.startsWith('oak')) && onTrees.some((c) => !hostOf(c).name.startsWith('oak')), 'on the crooked boles and the straight cones alike')
  const onPine = onTrees.filter((c) => hostOf(c).name === 'pine')
  check(onPine.length > 0 && onPine.some((c) => c.y - GROUND > 2), 'a two-ring cone, base ring straight to the apex, is climbed to the top of the climb', `${onPine.length} on the pine, highest ${onPine.length ? Math.max(...onPine.map((c) => c.y - GROUND)).toFixed(2) : '-'} m`)
  const onThin = onTrees.filter((c) => hostOf(c).name === 'birch2')
  check(onThin.length > 0 && onThin.every((c) => c.y - GROUND <= 1.9 + 1e-6) && onThin.some((c) => c.y - GROUND > 1.5), `and the thin birch only up to where its bark thins under ${TRUNK_MIN_R} m, two metres up`, `${onThin.length} on it, highest ${onThin.length ? Math.max(...onThin.map((c) => c.y - GROUND)).toFixed(2) : '-'} m`)
  // Determinism: the same seed lays the same spiders twice, and place() after leave puts them back where they were.
  const again = new Spiders(scene, height, water, { seed: 34, trees, rocks, assets: makeAsset() })
  again.place(0, 0)
  const key = (of) => alive(of).map((c) => `${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)},${c.size.toFixed(4)}`).sort().join('|')
  check(key(again) === key(spiders) && alive(spiders).length > 0, 'the scatter is a pure function of the seed', `${alive(spiders).length} spiders`)
  again.dispose()
  // A tile whose hosts land late gets its spiders on the rescan.
  liveTrunks = []
  liveRocks = []
  const late = new Spiders(scene, height, water, { seed: 34, trees, rocks, assets: makeAsset() })
  late.place(0, 0)
  check(alive(late).length === 0, 'no hosts, no spiders')
  liveTrunks = TRUNKS
  liveRocks = ROCKS
  // dt 0: the frames only rescan, nobody's pause runs out.
  for (let f = 0; f < 200; f++) tick(late, 0, GROUND + 1.6, 0, 0)
  check(key(late) === key(spiders), 'hosts that land after place() get their spiders on the rescan, the same ones')
  late.dispose()
  // Above the snow line, the same hosts carry nobody.
  snowLine = GROUND - 1
  const snowed = new Spiders(scene, height, water, { seed: 34, trees, rocks, assets: makeAsset() })
  snowed.place(0, 0)
  check(snowed.stats.hosts === spiders.stats.hosts && alive(snowed).length === 0, 'a host above the snow line carries no group', `${snowed.stats.hosts} hosts, ${alive(snowed).length} spiders`)
  snowed.dispose()
  snowLine = GROUND + 100
  // A trunk re-seated with its chunk takes its spiders with it, on the next rescan.
  const treeSpiders = alive().filter((c) => c.host.kind === 'tree')
  const ys = treeSpiders.map((c) => c.y)
  trunkY += 0.3
  for (let f = 0; f < 4 * spiders.tiles.size + 8; f++) tick(spiders, 0, GROUND + 40, 0, 0)
  check(treeSpiders.every((c, i) => Math.abs(c.y - ys[i] - 0.3) < 1e-5 && offTrunk(hostOf(c), c) < 1e-3), 'a trunk that re-seats 0.3 m up takes its spiders with it, still on the bark')
  trunkY -= 0.3
  for (let f = 0; f < 4 * spiders.tiles.size + 8; f++) tick(spiders, 0, GROUND + 40, 0, 0)
  check(treeSpiders.every((c, i) => Math.abs(c.y - ys[i]) < 1e-5), 'and back down')
}

// --- the crawl -----------------------------------------------------------------
{
  // Straight up, so the tiles hold and every spider is past NEAR_M.
  const FAR = [0, GROUND + 40, 0]
  const before = alive().map((c) => ({ c, x: c.x, y: c.y, z: c.z }))
  spiders.setCard(null)
  check(spiders.card.visible, 'setCard shows the card')
  let ms = 0
  const states = new Set()
  const clipsSeen = new Set()
  let worstOff = 0
  let worstH = [Infinity, -Infinity]
  // The legs, every frame: a spider a second into its walk swings them half a stride and its phase runs; a second into its pause they are still and its phase holds. `since` is frames in the state.
  const since = new Map()
  const wasState = new Map()
  const gaitWas = new Map()
  const legs = { walking: 0, sitting: 0, wrong: 0, phase: 0, over: 0 }
  for (let f = 0; f < 600; f++) {
    for (const c of alive()) gaitWas.set(c, c.gait)
    const t0 = performance.now()
    tick(spiders, ...FAR, 1 / 60)
    ms += performance.now() - t0
    for (const c of alive()) {
      if (wasState.get(c) !== c.state) { wasState.set(c, c.state); since.set(c, 0) } else since.set(c, since.get(c) + 1)
      if (!(c.amp >= 0 && c.amp <= STRIDE.run / 2 + 1e-9)) legs.over++
      if (since.get(c) >= 60) {
        if (c.state === 'go') { legs.walking++; if (c.amp !== STRIDE[c.clip] / 2) legs.wrong++; if (c.gait === gaitWas.get(c)) legs.phase++ }
        if (c.state === 'pause') { legs.sitting++; if (c.amp !== 0) legs.wrong++; if (c.gait !== gaitWas.get(c)) legs.phase++ }
      }
      states.add(c.state)
      clipsSeen.add(c.clip)
      worstOff = Math.max(worstOff, offSurface(c))
      worstH = [Math.min(worstH[0], c.y - GROUND), Math.max(worstH[1], c.y - GROUND)]
    }
  }
  const moved = before.filter(({ c, x, y, z }) => Math.hypot(c.x - x, c.y - y, c.z - z) > 0.02)
  check(moved.length > before.length / 2, 'most spiders have crawled somewhere in ten seconds', `${moved.length} of ${before.length}`)
  check(states.has('go') && states.has('pause'), 'they crawl and they pause', [...states].join(', '))
  check(['walk', 'idle'].every((n) => clipsSeen.has(n)) && !clipsSeen.has('alert'), 'walking and idling, with nobody reared up while she is far', [...clipsSeen].join(', '))
  check(worstOff < 0.02, 'no spider left its surface', `worst ${worstOff.toFixed(4)} m`)
  check(worstH[0] >= -1e-6 && worstH[1] <= CLIMB_M + 1e-6, `no spider went under the ground or over ${CLIMB_M} m`, `${worstH[0].toFixed(2)} to ${worstH[1].toFixed(2)} m`)
  check(alive().every((c) => Math.abs(Math.hypot(c.nx, c.ny, c.nz) - 1) < 1e-4 && Math.abs(c.tx * c.nx + c.ty * c.ny + c.tz * c.nz) < 1e-3 && Math.abs(Math.hypot(c.tx, c.ty, c.tz) - 1) < 1e-4), 'unit normal and unit tangent heading still, after the crawl')
  const rockOnTop = alive().filter((c) => c.host.kind === 'rock' && c.ny > FLAT_NY).length
  check(rockOnTop <= Math.ceil(alive().filter((c) => c.host.kind === 'rock').length * 0.2), 'the rock crawlers keep to the faces', `${rockOnTop} on top`)
  check(spiders.card.count === alive().length && spiders.stats.meshes.every((n) => n === 0) && alive().every((c) => c.lod === LOD_TIERS), 'far away, every spider is a card and no tier draws anybody', `${spiders.card.count} cards, ${alive().length} alive, tiers ${spiders.stats.meshes.join('/')}`)
  check(legs.walking > 0 && legs.sitting > 0 && legs.wrong === 0 && legs.over === 0, 'a spider a second into its walk swings its legs half a stride, a second into its pause not at all, and never more than half the run', `${legs.walking} walking and ${legs.sitting} sitting spider-frames, ${legs.wrong} wrong`)
  check(legs.phase === 0, 'the phase runs while it walks and holds while it sits', `${legs.phase} wrong`)
  const perFrame = ms / 600
  check(perFrame < 3, `a frame of ${alive().length} spiders costs under 3 ms`, `${perFrame.toFixed(3)} ms, ${rocks.rays} rays`)
  // The card lies where its spider clings, sunk into the surface, its up along the normal. Instance 0 is the first spider in tile order.
  const c = [...spiders.tiles.values()].flatMap((t) => [...t.hosts.values()]).flatMap((h) => h.spiders)[0]
  const m = new THREE.Matrix4().fromArray(spiders.card.instanceMatrix.array, 0)
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
  m.decompose(p, q, s)
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
  const k = c.size / spiders.span
  const sink = SINK * spiders.bodyH * k
  check(Math.abs(s.x - k) < 1e-6 && Math.abs(s.y - k) < 1e-6 && p.distanceTo(new THREE.Vector3(c.x - c.nx * sink, c.y - c.ny * sink, c.z - c.nz * sink)) < 1e-5, 'the first card is at its spider\'s size, sunk into its surface', `scale ${s.x.toFixed(3)}, sink ${sink.toFixed(4)} m`)
  check(up.distanceTo(new THREE.Vector3(c.nx, c.ny, c.nz)) < 1e-5 && fwd.distanceTo(new THREE.Vector3(c.tx, c.ty, c.tz)) < 1e-5, 'its up is the surface normal and its face is its heading')
  check(spiders.stats.dropped === 0, 'no stone went from under anybody', `${spiders.stats.dropped} dropped`)
}

// --- the top of the climb, a stone gone from under a spider ---------------------
{
  const FAR = [0, GROUND + 40, 0]
  // Walking straight up the pillar past CLIMB_M: one turn back, then on down.
  const p = alive().find((c) => hostOf(c).name === 'pillar')
  const pillar = hostOf(p)
  const az = Math.atan2(p.z - pillar.z, p.x - pillar.x)
  p.x = pillar.x + pillar.r * Math.cos(az); p.y = GROUND + CLIMB_M - 0.05; p.z = pillar.z + pillar.r * Math.sin(az)
  p.nx = Math.cos(az); p.ny = 0; p.nz = Math.sin(az)
  spiders._heading(p, 0)
  p.state = 'go'; p.clip = 'walk'; p.speed = 0.05; p.left = 100
  let flips = 0
  let top = -Infinity
  let was = p.ty
  for (let f = 0; f < 120; f++) {
    tick(spiders, ...FAR, 1 / 60)
    if (Math.sign(p.ty) !== Math.sign(was)) flips++
    was = p.ty
    top = Math.max(top, p.y - GROUND)
  }
  check(flips === 1 && p.ty < -0.5 && p.state === 'go' && top <= CLIMB_M + 0.01, `at the top of the climb the spider turns back once and walks down`, `${flips} turns, heading ty ${p.ty.toFixed(2)}, topped at ${top.toFixed(3)} m`)
  // A spider with no stone under it turns back three times and sits down, then finds its stone again.
  const s = alive().find((c) => hostOf(c).name === 'sphere')
  const sphere = hostOf(s)
  s.x += s.nx; s.y += s.ny; s.z += s.nz
  const lifted = [s.x, s.y, s.z]
  s.state = 'go'; s.clip = 'walk'; s.speed = 0.05; s.left = 100
  let sat = 0
  for (let f = 0; f < 12 && s.state === 'go'; f++, sat++) tick(spiders, ...FAR, 1 / 60)
  check(s.state === 'pause' && s.stuck === 3 && sat <= 9 && Math.hypot(s.x - lifted[0], s.y - lifted[1], s.z - lifted[2]) < 0.01, 'a spider in the air turns back three times and sits down where it is', `${s.state} after ${sat} frames, stuck ${s.stuck}`)
  for (let f = 0; f < RESEAT_EVERY; f++) tick(spiders, ...FAR, 0)
  check(s.host !== null && hostOf(s) === sphere && offRock(sphere, s) < 1e-4 && s.y > GROUND, 'sitting, it re-reads its stone and is back on the sphere', `off ${offRock(sphere, s).toExponential(2)} m`)
  // The sphere itself gone: every spider on it is taken away, and the slots come back.
  const onSphere = alive().filter((c) => hostOf(c).name === 'sphere')
  const freeBefore = spiders.free.length
  liveRocks = ROCKS.filter((b) => b.name !== 'sphere')
  for (let f = 0; f < RESEAT_EVERY + 12; f++) tick(spiders, ...FAR, 0)
  check(onSphere.length > 0 && onSphere.every((c) => c.host === null) && spiders.stats.dropped === onSphere.length && spiders.free.length === freeBefore + onSphere.length, 'the sphere gone from under them, its spiders are taken away and their slots freed', `${onSphere.length} dropped`)
  check(![...spiders.tiles.values()].some((t) => [...t.hosts.values()].some((h) => h.spiders.some((c) => c.host === null))), 'and no host still lists one')
  check(alive().every((c) => offSurface(c) < 0.02), 'everyone else is where they were')
  liveRocks = ROCKS
}

// --- the ear hears the spiders --------------------------------------------------
// bodies() is what the ambience reads for the crawl loop: the slots themselves, `speed > 0` on the ones on the move, a pause at speed 0.
{
  const w = alive().find((c) => c.host.kind === 'tree')
  w.state = 'go'; w.clip = 'walk'; w.speed = 0.05; w.left = 100
  const listed = spiders.bodies([])
  check(listed.length === alive().length && listed.includes(w) && w.speed > 0, 'every seated spider is listed, the walker at its pace', `${listed.length} of ${alive().length}`)
  w.left = 0
  tick(spiders, 0, GROUND + 40, 0, 1 / 60)
  check(w.state === 'pause' && w.speed === 0 && spiders.bodies([]).includes(w), 'its spell over, the walker pauses at speed 0 and stays listed')
  spiders.batch.visible = false
  check(spiders.bodies([]).length === 0, 'a hidden layer lists nobody')
  spiders.batch.visible = true
}

// --- near: the tiers, the legs, the rear-up ------------------------------------------------
{
  const target = alive().find((c) => c.host.kind === 'tree')
  const at = (d) => [target.x + target.nx * d, target.y, target.z + target.nz * d]
  // Out along the normal, so the distance is exactly d.
  let her = at(0)
  const tiersAt = (d, frames = 2) => {
    for (let f = 0; f < frames; f++) { her = at(d); tick(spiders, ...her, 1 / 60) }
    return target.lod
  }
  const drawn = () => spiders.stats.meshes.reduce((a, b) => a + b, 0) + spiders.card.count
  const seat = (c) => { const sink = SINK * spiders.bodyH * c.size / spiders.span; return new THREE.Vector3(c.x - c.nx * sink, c.y - c.ny * sink, c.z - c.nz * sink) }
  /** The instance of tier k standing where the spider is, or -1. */
  const instanceOf = (k, c) => {
    const a = spiders.meshes[k].instanceMatrix.array
    const p = seat(c)
    for (let i = 0; i < spiders.meshes[k].count; i++) if (Math.abs(a[i * 16 + 12] - p.x) < 1e-5 && Math.abs(a[i * 16 + 13] - p.y) < 1e-5 && Math.abs(a[i * 16 + 14] - p.z) < 1e-5) return i
    return -1
  }
  // Well inside its own top rung -- a spider is a hand's breadth across, so that is centimetres and not metres. Walking, so it is not reared up for the matrix check.
  target.state = 'go'; target.clip = 'walk'; target.speed = 0.05; target.left = 100
  const close = lodReach(target.size, 0) / 2
  const t1 = tiersAt(close)
  const i1 = instanceOf(0, target)
  check(t1 === 0 && i1 >= 0 && spiders.meshes[0].count >= 1, `${close.toFixed(2)} m off, the spider is an instance of tier 0`, `tier ${t1}, instance ${i1}`)
  {
    const m = new THREE.Matrix4().fromArray(spiders.meshes[0].instanceMatrix.array, i1 * 16)
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    m.decompose(p, q, s)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
    const k = target.size / spiders.span
    check(Math.abs(s.x - k) < 1e-6 && up.distanceTo(new THREE.Vector3(target.nx, target.ny, target.nz)) < 1e-5 && fwd.distanceTo(new THREE.Vector3(target.tx, target.ty, target.tz)) < 1e-5, 'the instance stands where the spider is at its size, its up the bark\'s normal and its nose along its heading')
    const g = spiders.gaits[0].array
    check(Math.abs(g[i1 * 2] - target.gait) < 1e-6 && Math.abs(g[i1 * 2 + 1] - target.amp) < 1e-9 && target.amp > 0, 'and carries its gait: the phase and a swing', `phase ${target.gait.toFixed(3)} amp ${target.amp.toFixed(4)}`)
  }
  // The phase runs one cycle a stride of the seat. Her body that close set it fleeing; put back on its walk with her 2 m off, out of FLEE_M of it.
  {
    target.state = 'go'; target.clip = 'walk'; target.speed = 0.05; target.left = 100
    tiersAt(2, 1)
    const was = target.gait
    tiersAt(2, 1)
    const turned = (target.gait - was + 2 * Math.PI) % (2 * Math.PI)
    check(target.state === 'go' && Math.abs(turned - (2 * Math.PI * 0.05 * (1 / 60) * spiders.span) / (target.size * STRIDE.walk)) < 1e-9, 'a frame\'s walk turns the phase by that step over the stride', `${turned.toFixed(4)} rad`)
  }
  const dist = (c) => Math.hypot(c.x - her[0], c.y - her[1], c.z - her[2])
  // A mesh is kept to 1.15 NEAR_M once it is one; a step is under 2 cm.
  check(alive().every((c) => (c.lod < LOD_TIERS ? dist(c) <= NEAR_M * 1.15 + 0.02 : dist(c) >= NEAR_M - 0.02)) && drawn() === alive().length && spiders.stats.meshes[target.lod] >= 1, `every spider within ${NEAR_M} m is a mesh and the rest are cards, each drawn once`, `tiers ${spiders.stats.meshes.join('/')}, ${spiders.card.count} cards`)
  // The floor is held rather than culled: a spider inside NEAR_M is always a mesh, the card being what takes over out there.
  const expect = (d) => Math.min(critterTier(target.size, d, LOD_TIERS, LOD_TIERS), LOD_TIERS - 1)
  // The middle rung is probed at its own geometric middle, a rolled size putting
  // its edges wherever it likes: the hysteresis band is a tenth either way and
  // cannot reach that far, so what is promised is the ladder and not one spider.
  const mid = lodReach(target.size, 1) * Math.SQRT2
  const tMid = tiersAt(mid), t95 = tiersAt(9.5)
  check(tMid === expect(mid) && t95 === expect(9.5) && t95 === LOD_TIERS - 1 && instanceOf(LOD_TIERS - 1, target) >= 0, `at ${mid.toFixed(2)} m tier ${expect(mid)}, at 9.5 m the last tier and not a cull`, `${tMid}, ${t95} for a ${target.size.toFixed(2)} m spider`)
  // Stepping out of range: the next frame it is a card, and NOTHING is drawn twice.
  const t12 = tiersAt(12, 1)
  check(t12 === LOD_TIERS && instanceOf(LOD_TIERS - 1, target) < 0 && drawn() === alive().length, 'at 12 m it is a card the next frame, a mesh or a card and never both', `tiers ${spiders.stats.meshes.join('/')}, ${spiders.card.count} cards, ${alive().length} alive`)
  // Reared up when she is close and paused, the instance pitched nose-up about its seat; back to its business, and flat, when she goes.
  target.state = 'pause'; target.clip = 'idle'; target.left = 100
  tiersAt(1.0, 3)
  check(target.clip === 'alert' && target.rear > 0 && target.rear < 1, 'a paused spider with her head a metre off is alert and rearing', `rear ${target.rear.toFixed(3)}`)
  tiersAt(1.0, 120)
  {
    const i = instanceOf(target.lod, target)
    const m = new THREE.Matrix4().fromArray(spiders.meshes[target.lod].instanceMatrix.array, i * 16)
    const q = new THREE.Quaternion()
    m.decompose(new THREE.Vector3(), q, new THREE.Vector3())
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
    const n = new THREE.Vector3(target.nx, target.ny, target.nz), t = new THREE.Vector3(target.tx, target.ty, target.tz)
    check(target.rear === 1 && i >= 0 && Math.abs(up.angleTo(n) - REAR_RAD) < 1e-5 && Math.abs(fwd.angleTo(t) - REAR_RAD) < 1e-5 && fwd.dot(n) > 0 && Math.abs(up.dot(new THREE.Vector3().crossVectors(n, t.clone().negate()))) < 1e-6, `two seconds on it is fully reared: the instance pitched ${REAR_RAD} rad nose-up off the bark about its seat`, `rear ${target.rear}, up off normal ${up.angleTo(n).toFixed(3)} rad`)
    check(target.amp === 0, 'and its legs hold still while it rears', `amp ${target.amp}`)
  }
  tiersAt(3, 3)
  check(target.clip !== 'alert' && target.rear < 1, 'and drops it when she steps back, easing down', `${target.clip} rear ${target.rear.toFixed(3)}`)
  tiersAt(3, 120)
  check(target.rear === 0, 'flat again two seconds on')
  // Her BODY closer than FLEE_M -- here her waist, her head a metre off -- and it flees: at FLEE_HASTE times the run, heard once as it sets off, for the far side of the trunk and the top of the climb.
  const run = (c, her, frames) => { for (let f = 0; f < frames; f++) tick(spiders, ...her, 1 / 60) }
  const bodyDist = (c, her) => Math.hypot(c.x - her[0], Math.max(0, c.y - her[1], her[1] - EYE - c.y), c.z - her[2]) - WALK.radius
  const flee = (c) => {
    // The spider a metre up its host and her coming from afar to stand on the ground a hand off the surface, so the nearest point of her is level with it and her crown is under the top of the climb.
    if (c.host.kind === 'tree') { c.h = c.host.hLo + 1; spiders._placeTree(c) }
    const her = [c.x + c.nx * (0.2 + WALK.radius), GROUND + EYE, c.z + c.nz * (0.2 + WALK.radius)]
    c.state = 'pause'; c.clip = 'idle'; c.left = 100
    tick(spiders, c.x + c.nx * 5, her[1], c.z + c.nz * 5, 1 / 60)
    tick(spiders, ...her, 1 / 60)
    const fled = spiders.startled([])
    // Toward the nearest point of her body, level with the spider.
    const away = c.tx * (her[0] - c.x) + c.tz * (her[2] - c.z)
    tick(spiders, ...her, 1 / 60)
    return { her, fled, away, twice: spiders.startled([]).length, still: c.state === 'flee' }
  }
  const t = flee(target)
  // The run gait is STRIDE.run a 0.42 s cycle (spiders.js GAIT), at the body's scale.
  const runSpeed = (STRIDE.run / 0.42) * target.size / spiders.span
  check(target.state === 'flee' && target.clip === 'run', `her body 0.2 m off and her head ${Math.hypot(0.2 + WALK.radius, GROUND + EYE - target.y).toFixed(2)} m off, the spider flees at the run`, `${target.state} ${target.clip}`)
  {
    const was = target.gait
    run(target, t.her, 1)
    const turned = (target.gait - was + 2 * Math.PI) % (2 * Math.PI)
    check(Math.abs(target.speed - FLEE_HASTE * runSpeed) < 1e-9 && Math.abs(turned - (2 * Math.PI * target.speed * (1 / 60) * spiders.span) / (target.size * STRIDE.run)) < 1e-9, `${FLEE_HASTE} times as fast as its run, the legs cycling ${FLEE_HASTE} times as fast to match`, `${target.speed.toFixed(3)} m/s, ${(turned * 60 / (2 * Math.PI)).toFixed(2)} cycles a second`)
  }
  check(t.fled.length === 1 && t.fled[0] === target && t.twice === 0 && t.still, 'it is listed as startled the frame it sets off and never again while it runs')
  check(t.away < 0.05 && target.ty > 0.3, 'it makes for the far side of the trunk and the top of the climb, not toward her', `heading ty ${target.ty.toFixed(2)}, toward her ${t.away.toFixed(2)}`)
  // She stands there: it keeps running up past her, gaining nothing on her body until it clears her crown, and calms where it is once it is there, and does not bolt again while she stays.
  const h0 = target.h, d1 = bodyDist(target, t.her)
  run(target, t.her, 60)
  check(target.state === 'flee' && target.h > h0 + 0.15, 'a second on it is still running, up the trunk past her', `${h0.toFixed(2)} -> ${target.h.toFixed(2)} m up`)
  run(target, t.her, 12 * 60)
  const d2 = bodyDist(target, t.her)
  check(target.state === 'pause' && target.amp === 0 && d2 < FLEE_TO_M && d2 > d1 + 0.5 && target.h > target.host.hHi - 0.1, `having got as far as the trunk allows -- the top of the climb, the far side -- it calms down there, its legs still`, `${target.state} at ${d2.toFixed(2)} m, ${target.h.toFixed(2)} m up of ${target.host.hHi.toFixed(2)}`)
  run(target, t.her, 60)
  check(target.state !== 'flee' && spiders.startled([]).length === 0, 'and does not bolt again while she stands under it')
  // She steps back and returns: it bolts again, once.
  const back = [t.her[0] + target.nx * 2, t.her[1], t.her[2] + target.nz * 2]
  run(target, back, 5)
  const again = flee(target)
  check(target.state === 'flee' && again.fled.length === 1, 'she steps back and comes again, and it bolts again')
  // Mid-flight she is suddenly FLEE_TO_M off: it calms at once.
  const off = [target.x + target.nx * (FLEE_TO_M + WALK.radius + 0.5), GROUND + EYE, target.z + target.nz * (FLEE_TO_M + WALK.radius + 0.5)]
  run(target, off, 1)
  check(target.state === 'pause', `and calms the moment she is ${FLEE_TO_M} m off`, target.state)
  // A rock spider flees the same way, along its face.
  const p = alive().find((c) => hostOf(c).name === 'pillar')
  const r = flee(p)
  check(p.state === 'flee' && r.fled[0] === p && r.away < 0.05 && Math.abs(p.tx * p.nx + p.ty * p.ny + p.tz * p.nz) < 1e-6 && Math.abs(Math.hypot(p.tx, p.ty, p.tz) - 1) < 1e-6, 'a rock spider flees too, along its face and not toward her', `toward her ${r.away.toFixed(2)}`)
  // Her head alone, high over a spider at her feet, is not her body: no flight, only the rear-up.
  const low = alive().find((c) => c !== target && c !== p && c.host.kind === 'tree') ?? target
  low.state = 'pause'; low.clip = 'idle'; low.left = 100
  tick(spiders, low.x + low.nx * (0.2 + WALK.radius), low.y + EYE - 0.1, low.z + low.nz * (0.2 + WALK.radius), 1 / 60)
  check(low.state === 'flee', 'her feet beside a spider low on the trunk, her head far above it, it flees her feet', low.state)
  let threw = false
  try { spiders.update(0, GROUND, 0, 1 / 60, GROUND + 1) } catch { threw = true }
  check(threw, 'feet over her head throws')
  spiders.batch.visible = false
  flee(target)
  check(spiders.startled([]).length === 0 && target.state === 'flee', 'a hidden layer lists no startled spider')
  spiders.batch.visible = true
  // A spider's matrix is rebuilt only when it has moved or turned: a paused rock spider between re-seats writes nothing new.
  const still = alive().find((c) => c.host.kind === 'rock' && c.state === 'pause' && c !== p)
  still.left = 100; still.clip = 'idle'; still.rear = 0
  // Up to and through its re-seat frame, so the frames counted are the ones between re-seats.
  do tick(spiders, 0, GROUND + 40, 0, 1 / 60); while ((spiders.frame + still.id) % RESEAT_EVERY !== 0)
  let writes = 0
  const kept = still.m.slice()
  // Every index write to its matrix counted; reads go to the array itself, whose getters want it and not the proxy as their receiver.
  still.m = new Proxy(still.m, { set(m, k, v) { writes++; m[k] = v; return true }, get(m, k) { const v = m[k]; return typeof v === 'function' ? v.bind(m) : v } })
  for (let f = 0; f < RESEAT_EVERY - 1; f++) tick(spiders, 0, GROUND + 40, 0, 1 / 60)
  check(writes === 0 && !still.dirty && kept.every((v, i) => v === still.m[i]), 'a sitting spider keeps its matrix from frame to frame rather than composing it again', `${writes} writes over ${RESEAT_EVERY - 1} frames`)
}

spiders.dispose()
check(spiders.batch.parent === null, 'dispose takes the batch out of the scene')

console.log(`\n${failures === 0 ? 'all spider checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
