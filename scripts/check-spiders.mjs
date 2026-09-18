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
// its tilt; a scatter all one colour, a spider lighter than the map or darker
// than TINT_DARK, one tinted blue rather than brown, or an instance or a card
// not carrying its spider's own tint; a frame that costs more than a scatter is allowed to. The shipped
// GLB is checked for shape too -- a skinned tier per rung of the ladder, the
// skeleton naming its legs and its six clips -- because the world loads it by
// name and bakes the legs off its skeleton.
//
// What this can NOT check: whether they look like spiders, or how the crawl
// reads. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import {
  Spiders, SHIPPED_TIERS, MESH_TIER, LOD_TIERS, SIZE_M, GROUND_SCALE, CLIMB_M, GROUP, GROUND_ROAM_M, GROUND_FLEE_M, ROCK_MIN_SIZE, TRUNK_MIN_R, FLAT_NY, MAX, SINK, RESEAT_EVERY, WALL_M, FLEE_M, FLEE_TO_M, FLEE_HASTE, STALL_S, STRIDE, REAR_RAD, TINT_DARK, TINT_BROWN,
} from '../src/v2/render/spiders.js'
import { WALK } from '../src/v2/walk.js'
import { PERCH_STRIDE } from '../src/v2/render/rocks.js'
import { TRUNK_STRIDE } from '../src/v2/render/trees.js'
import { CRITTER_GLB, LOD_RUNGS, CARD_RUNGS, lodReach } from '../src/v2/render/critters.js'
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
// Her head straight over a spider, inside its card rung by more than the ladder's hysteresis: simulated and drawn, too far to alarm it (ALERT_M is 1.2 m; the smallest spider's card rung starts at 1.8 m), and over its own tile, so the tiles walked from under her hold while it is watched.
const nearTo = (c) => [c.x, c.y + lodReach(c.size, LOD_RUNGS) * 0.8, c.z]
// Back over the middle of the wood, high enough that nobody is simulated: the tiles her last stand walked from under the wood come back, with their spiders placed afresh.
const home = () => tick(spiders, 0, GROUND + 40, 0, 0)
// The snow line is a hundred metres up, except where a test lowers it.
let snowLine = GROUND + 100
const height = { heightAt: () => GROUND, snowLineAt: () => snowLine }
const POND = { x: 30, z: 30, r: 6 }
// And a puddle a boulder stands in, its level a hand over the ground.
const PUDDLE = { x: -14, z: 12, r: 3, y: GROUND + 0.3 }
// And a pool a test lays down wherever it needs one, a metre deep.
let POOL = null
const levelAt = (x, z) => (Math.hypot(x - POND.x, z - POND.z) < POND.r ? GROUND + 1 : Math.hypot(x - PUDDLE.x, z - PUDDLE.z) < PUDDLE.r ? PUDDLE.y : POOL !== null && Math.hypot(x - POOL.x, z - POOL.z) < POOL.r ? GROUND + 1 : null)
const water = { levelAt, isSubmerged: (x, z, g) => { const l = levelAt(x, z); return l !== null && g < l } }

// Trunks: base radius, height and stretch. Each is its own variant of the trees' LOD0 profile, a unit-tall trunk the stub scales by the height, its Y by the stretch on top, and turns by the yaw, as Trees.trunksInto says: the oaks crooked and lobed, the rest straight eight-sided cones; the pine and the thin birch are two-ring cones, a base ring straight to the apex, the shape the shipped pine has. The thin birch's bark thins under TRUNK_MIN_R two metres up, which caps its climb there. The pine and the first oak are stretched either way, so a seat that ignored the stretch would sit off their bark by millimetres.
const TAU = Math.PI * 2
const TRUNKS = [
  { name: 'oak', x: 2, z: 0, r0: 0.35, height: 15, stretch: 0.8, yaw: 0.7 },
  { name: 'pine', x: -3, z: 4, r0: 0.2, height: 12, stretch: 1.25, yaw: 2.1 },
  { name: 'birch', x: 6, z: -5, r0: 0.12, height: 9, stretch: 1, yaw: 4.0 },
  { name: 'birch2', x: -6, z: -6, r0: 0.08, height: 8, stretch: 1, yaw: 5.5 },
  { name: 'oak2', x: 9, z: 6, r0: 0.4, height: 18, stretch: 1, yaw: 3.3 },
  { name: 'sapling', x: 0, z: 8, r0: 0.03, height: 2, stretch: 1, yaw: 0 },
  { name: 'far', x: 80, z: 80, r0: 0.3, height: 12, stretch: 1, yaw: 1 },
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
      out[o] = t.x; out[o + 1] = trunkY; out[o + 2] = t.z; out[o + 3] = t.r0; out[o + 4] = t.height; out[o + 5] = t.yaw; out[o + 6] = TRUNKS.indexOf(t); out[o + 7] = t.stretch
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
/** How far a point is off the trunk's own triangles -- the bark as tree.js's addCone winds it from the profile, scaled, stretched and yawed as the stub places it. */
const _tri = new THREE.Triangle()
const _p = new THREE.Vector3()
const _q = new THREE.Vector3()
function offTrunk(t, c) {
  const prof = trees.trunkProfile[TRUNKS.indexOf(t)]
  const { sides, y, corners } = prof
  const cy = Math.cos(t.yaw), sy = Math.sin(t.yaw)
  const wx = c.x - t.x, wz = c.z - t.z
  _p.set((wx * cy - wz * sy) / t.height, (c.y - trunkY) / (t.height * t.stretch), (wx * sy + wz * cy) / t.height)
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
  const fy = (c.y - trunkY) / (t.height * t.stretch)
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
const GROUND_HOST = { name: 'ground' }
const hostOf = (c) => (c.host.kind === 'ground' ? GROUND_HOST : (c.host.kind === 'tree' ? TRUNKS : ROCKS).find((h) => h.x === c.host.x && h.z === c.host.z))
const offSurface = (c) => (c.host.kind === 'tree' ? offTrunk(hostOf(c), c) : c.host.kind === 'rock' ? offRock(hostOf(c), c) : Math.abs(c.y - GROUND))

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
        // Named as the GLB names it, then sanitised as GLTFLoader sanitises every node name (the dot goes), so the bake sees what the world sees.
        hip.name = THREE.PropertyBinding.sanitizeNodeName(`Leg${n + 1}Hip.${side}`)
        hip.position.set(side === 'L' ? -0.5 : 0.5, 0.125, LEG_Z[n])
        root.add(hip)
        bones.push(hip)
      }
    }
  }
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  // Both slabs carry the four hips a side: the drawn tier (MESH_TIER) must name every leg.
  const tiers = [4, 4].map((seg) => {
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
check(spiders.meshes.length === LOD_TIERS && spiders.meshes.every((m, k) => m.isInstancedMesh && !m.isSkinnedMesh && m.material === spiders.material && m.count === 0 && m.instanceMatrix.count === MAX && m.geometry === spiders.asset.tiers[MESH_TIER + k] && m.geometry.getAttribute('aGait') === spiders.gaits[k] && m.geometry.getAttribute('aLeg')?.itemSize === 2) && spiders.asset.tiers[0].getAttribute('aLeg') === undefined, `${LOD_TIERS} InstancedMesh, no skeleton on it, the asset's tier ${MESH_TIER} with its legs baked on and its gaits per instance, none drawn yet; the pick untouched, for the card`)
check(spiders.gaits.every((g) => g.isInstancedBufferAttribute && g.itemSize === 2 && g.count === MAX), 'a gait -- phase and amplitude -- per instance per tier')
check(!spiders.card.visible && spiders.card.count === 0 && spiders.batch.children.length === LOD_TIERS + 1 && spiders.meshes.every((m) => spiders.batch.children.includes(m)), 'the card is hidden until baked, and the tiers and the card are the whole batch')
{
  // The legs as baked onto the drawn tier: a side-face vertex swings with its leg, a body vertex never does.
  const geo = spiders.asset.tiers[MESH_TIER]
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
const groupSizes = { tree: [], rock: [], ground: [] }
const hosted = { tree: 0, rock: 0, ground: 0 }
const hostedOf = new Map()
let dropped = 0
for (let seed = 1; seed <= SEEDS; seed++) {
  const k = new Spiders(scene, height, water, { seed, trees, rocks, assets: makeAsset() })
  k.place(0, 0)
  dropped += k.overflow + k.saturated
  for (const t of k.tiles.values()) {
    for (const h of t.hosts.values()) {
      if (!h.spiders.length) continue
      groupSizes[h.kind].push(h.spiders.length)
      hosted[h.kind]++
      const name = hostOf(h.spiders[0]).name
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
  for (const kind of ['tree', 'rock', 'ground']) {
    const [lo, hi] = GROUP[kind]
    const sizes = groupSizes[kind]
    check(sizes.length > 0 && sizes.every((n) => n >= lo && n <= hi) && Math.min(...sizes) === lo && Math.max(...sizes) === hi, `every ${kind} group is ${lo} to ${hi}, and both ends are seen`, `${sizes.join(' ')}`)
  }
  check(hosted.tree > 0 && hosted.rock > 0 && hosted.ground > 0, 'groups on trees, on rocks and on the ground alike', `${hosted.tree} tree groups, ${hosted.rock} rock groups, ${hosted.ground} on the ground`)
  check(!hostedOf.has('sapling') && !hostedOf.has('cobble') && !hostedOf.has('small') && !hostedOf.has('drowned') && !hostedOf.has('far'), `none on the sapling (under ${TRUNK_MIN_R} m), the cobble or the ${sizeOf(ROCKS.find((b) => b.name === 'small'))} m stone (under ${ROCK_MIN_SIZE} m), the drowned rock or anything far off`, [...hostedOf.keys()].join(', '))
  check(!hostedOf.has('slab') && !hostedOf.has('buried'), `none on the slab or the buried stone: no ${WALL_M} m of wall to climb`, [...hostedOf.keys()].join(', '))
  const waders = pool.filter((c) => hostOf(c).name === 'wader')
  const wet = waders.filter((c) => levelAt(c.x, c.z) !== null)
  check(hostedOf.has('wader') && wet.every((c) => c.y > PUDDLE.y + 0.04), 'the boulder on the puddle\'s bank carries spiders, none of them at the waterline on its wet side', `${waders.length} spiders, ${wet.length} over the water, lowest ${wet.length ? (Math.min(...wet.map((c) => c.y)) - PUDDLE.y).toFixed(2) : '-'} m over it`)
  check(pool.every((c) => c.ny > -0.3), 'no spider hangs from a ceiling', `lowest ny ${Math.min(...pool.map((c) => c.ny)).toFixed(2)}`)
  const climbers = pool.filter((c) => c.host.kind !== 'ground')
  const grounders = pool.filter((c) => c.host.kind === 'ground')
  check(climbers.every((c) => c.size >= SIZE_M[0] - 1e-6 && c.size <= SIZE_M[1] + 1e-6), `every climbing spider is ${SIZE_M[0]} to ${SIZE_M[1]} m`, `${Math.min(...climbers.map((c) => c.size)).toFixed(3)} to ${Math.max(...climbers.map((c) => c.size)).toFixed(3)} m`)
  check(grounders.length > 0 && grounders.every((c) => c.size >= SIZE_M[0] * GROUND_SCALE - 1e-6 && c.size <= SIZE_M[1] * GROUND_SCALE + 1e-6) && Math.max(...grounders.map((c) => c.size)) > SIZE_M[1] * GROUND_SCALE * 0.8, `every ground spider is ${SIZE_M[0] * GROUND_SCALE} to ${SIZE_M[1] * GROUND_SCALE} m, half the climbers`, `${grounders.length} of them, ${Math.min(...grounders.map((c) => c.size)).toFixed(3)} to ${Math.max(...grounders.map((c) => c.size)).toFixed(3)} m`)
  check(grounders.every((c) => Math.abs(c.y - GROUND) < 1e-9 && Math.abs(c.ny - 1) < 1e-9 && Math.abs(c.ty) < 1e-9 && Math.abs(Math.hypot(c.tx, c.tz) - 1) < 1e-9 && levelAt(c.x, c.z) === null && c.state === 'go' && c.speed > 0), 'a ground spider stands on the flat ground, its normal up and its heading level, out of the water, and is on the move from its first frame')
  const oneTiles = alive().filter((c) => c.host.kind === 'ground').map((c) => `${Math.floor(c.x / 16)},${Math.floor(c.z / 16)}`)
  check(grounders.every((c) => Math.hypot(c.x - c.host.x, c.z - c.host.z) < 1e-9) && oneTiles.length > 0 && new Set(oneTiles).size === oneTiles.length && oneTiles.length < spiders.tiles.size, 'a ground spider stands at its tile\'s own point, one a tile at most and not in every tile', `${oneTiles.length} in ${spiders.tiles.size} tiles`)
  const hs = pool.map((c) => c.y - GROUND)
  check(hs.every((h) => h >= 0 && h <= CLIMB_M + 1e-6), `every spider is 0 to ${CLIMB_M} m up`, `${Math.min(...hs).toFixed(2)} to ${Math.max(...hs).toFixed(2)} m`)
  check(Math.max(...hs) > 2 && Math.min(...hs) < 0.3, 'and the climb is used, top and bottom')
  const pillar = pool.filter((c) => hostOf(c).name === 'pillar')
  check(pillar.length > 0 && pillar.every((c) => c.y - GROUND <= CLIMB_M) && Math.max(...pillar.map((c) => c.y - GROUND)) > 1.5, `the 6 m pillar's spiders stop at ${CLIMB_M} m and some climb past 1.5`, `${pillar.length} spiders, highest ${Math.max(...pillar.map((c) => c.y - GROUND)).toFixed(2)} m`)
  const off = pool.map(offSurface)
  check(off.every((d) => d < 1e-4), 'every spider sits on its host\'s own surface', `worst ${Math.max(...off).toExponential(2)} m`)
  check(pool.every((c) => Math.abs(Math.hypot(c.nx, c.ny, c.nz) - 1) < 1e-6 && Math.abs(c.tx * c.nx + c.ty * c.ny + c.tz * c.nz) < 1e-6), 'unit normal, heading in the tangent plane')
  const flat = climbers.filter((c) => c.ny > FLAT_NY).length / climbers.length
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
  const key = (of) => alive(of).map((c) => `${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)},${c.size.toFixed(4)},${c.tr.toFixed(4)},${c.tg.toFixed(4)},${c.tb.toFixed(4)}`).sort().join('|')
  check(key(again) === key(spiders) && alive(spiders).length > 0, 'the scatter, tints and all, is a pure function of the seed', `${alive(spiders).length} spiders`)
  again.dispose()
  // The tint: a run from the map's own colour (1, 1, 1) down through darker and browner -- never lighter than the map, never below TINT_DARK, green and blue never over red and blue never over green -- and spread well across it.
  {
    const all = alive()
    const inRange = all.every((c) => c.tr <= 1 + 1e-9 && c.tr >= TINT_DARK - 1e-9 && c.tg <= c.tr + 1e-9 && c.tb <= c.tg + 1e-9 && c.tg >= c.tr * (1 - TINT_BROWN.g) - 1e-9 && c.tb >= c.tr * (1 - TINT_BROWN.b) - 1e-9)
    const shades = all.map((c) => c.tr), warmths = all.map((c) => 1 - c.tb / c.tr)
    check(inRange && Math.max(...shades) - Math.min(...shades) > 0.3 && Math.max(...warmths) - Math.min(...warmths) > 0.3, 'every spider is tinted between the map and dark brown, and the scatter is spread across the range', `shade ${Math.min(...shades).toFixed(2)}..${Math.max(...shades).toFixed(2)}, warmth ${Math.min(...warmths).toFixed(2)}..${Math.max(...warmths).toFixed(2)}`)
    check(spiders.meshes.every((m) => m.instanceColor?.isInstancedBufferAttribute && m.instanceColor.count === MAX) && spiders.card.instanceColor?.isInstancedBufferAttribute && spiders.card.instanceColor.count === MAX, 'the tint rides in instanceColor on every tier and on the card')
  }
  // A tile whose hosts land late gets its spiders on the rescan.
  liveTrunks = []
  liveRocks = []
  const late = new Spiders(scene, height, water, { seed: 34, trees, rocks, assets: makeAsset() })
  late.place(0, 0)
  check(alive(late).length > 0 && alive(late).every((c) => c.host.kind === 'ground'), 'no trunks and no rocks, only the ground\'s spiders', `${alive(late).length} on the ground`)
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
  // Standing in the middle of the wood: every spider is on its own rung by its size, and the ones past their cull are neither drawn nor simulated.
  const HER = [0, GROUND + EYE, 0]
  const before = alive().map((c) => ({ c, x: c.x, y: c.y, z: c.z, left: c.left }))
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
    tick(spiders, ...HER, 1 / 60)
    ms += performance.now() - t0
    for (const c of alive()) {
      if (c.rung >= CARD_RUNGS) continue
      // A ground spider goes from one spell straight into the next, so the clip counts as a change too.
      if (wasState.get(c) !== c.state + c.clip) { wasState.set(c, c.state + c.clip); since.set(c, 0) } else since.set(c, since.get(c) + 1)
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
  const sim = before.filter(({ c }) => c.rung < CARD_RUNGS)
  const moved = sim.filter(({ c, x, y, z }) => Math.hypot(c.x - x, c.y - y, c.z - z) > 0.02)
  check(sim.length >= 3 && moved.length > sim.length / 2, 'most of the spiders within their cull have crawled somewhere in ten seconds', `${moved.length} of ${sim.length}, ${before.length} alive`)
  const frozen = before.filter(({ c }) => c.rung >= CARD_RUNGS)
  check(frozen.length > 0 && frozen.every(({ c, x, y, z, left }) => c.x === x && c.y === y && c.z === z && c.left === left), 'and the ones past it have not moved, being frozen where they were placed', `${frozen.length} frozen`)
  check(states.has('go') && states.has('pause'), 'they crawl and they pause', [...states].join(', '))
  check(['walk', 'idle'].every((n) => clipsSeen.has(n)) && !clipsSeen.has('alert'), 'walking and idling, with nobody reared up while she is far', [...clipsSeen].join(', '))
  check(worstOff < 0.02, 'no spider left its surface', `worst ${worstOff.toFixed(4)} m`)
  check(worstH[0] >= -1e-6 && worstH[1] <= CLIMB_M + 1e-6, `no spider went under the ground or over ${CLIMB_M} m`, `${worstH[0].toFixed(2)} to ${worstH[1].toFixed(2)} m`)
  check(alive().every((c) => Math.abs(Math.hypot(c.nx, c.ny, c.nz) - 1) < 1e-4 && Math.abs(c.tx * c.nx + c.ty * c.ny + c.tz * c.nz) < 1e-3 && Math.abs(Math.hypot(c.tx, c.ty, c.tz) - 1) < 1e-4), 'unit normal and unit tangent heading still, after the crawl')
  const rockOnTop = alive().filter((c) => c.host.kind === 'rock' && c.ny > FLAT_NY).length
  check(rockOnTop <= Math.ceil(alive().filter((c) => c.host.kind === 'rock').length * 0.2), 'the rock crawlers keep to the faces', `${rockOnTop} on top`)
  // The ladder, by each spider's own size: the mesh to lodReach(size, 3), the card to lodReach(size, 4), nothing past; a rung is left a tenth past its edge.
  const dist = (c) => Math.hypot(c.x - HER[0], c.y - HER[1], c.z - HER[2])
  const onRung = (c) => (c.rung === 0 || dist(c) >= lodReach(c.size, c.rung - 1) * 0.9 - 1e-9) && (c.rung === CARD_RUNGS || dist(c) <= lodReach(c.size, c.rung) * 1.1 + 1e-9)
  const meshed = alive().filter((c) => c.rung < LOD_RUNGS), carded = alive().filter((c) => c.rung === LOD_RUNGS), culled = alive().filter((c) => c.rung === CARD_RUNGS)
  check(alive().every(onRung) && meshed.every((c) => c.lod === 0) && carded.every((c) => c.lod === LOD_TIERS), 'every spider is on the rung its size and distance earn: the mesh to 36 sizes, the card to 72, nothing past', alive().filter((c) => !onRung(c)).map((c) => `${c.size.toFixed(2)} m at ${dist(c).toFixed(1)} m on rung ${c.rung}`).join(', '))
  check(meshed.length > 0 && carded.length > 0 && culled.length > 0 && spiders.stats.meshes[0] === meshed.length && spiders.card.count === carded.length, 'from the middle of the wood some are meshes, some cards and some culled, each drawn once or not at all', `${meshed.length} meshes, ${carded.length} cards, ${culled.length} culled of ${alive().length}`)
  check(legs.walking > 0 && legs.sitting > 0 && legs.wrong === 0 && legs.over === 0, 'a spider a second into its walk swings its legs half a stride, a second into its pause not at all, and never more than half the run', `${legs.walking} walking and ${legs.sitting} sitting spider-frames, ${legs.wrong} wrong`)
  check(legs.phase === 0, 'the phase runs while it walks and holds while it sits', `${legs.phase} wrong`)
  const perFrame = ms / 600
  check(perFrame < 3, `a frame of ${alive().length} spiders costs under 3 ms`, `${perFrame.toFixed(3)} ms, ${rocks.rays} rays`)
  // The card lies where its spider clings, sunk into the surface, its up along the normal. Instance 0 is the first card in tile order.
  const c = [...spiders.tiles.values()].flatMap((t) => [...t.hosts.values()]).flatMap((h) => h.spiders).find((c) => c.rung === LOD_RUNGS)
  const m = new THREE.Matrix4().fromArray(spiders.card.instanceMatrix.array, 0)
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
  m.decompose(p, q, s)
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
  const k = c.size / spiders.span
  const sink = SINK * spiders.bodyH * k
  check(Math.abs(s.x - k) < 1e-6 && Math.abs(s.y - k) < 1e-6 && p.distanceTo(new THREE.Vector3(c.x - c.nx * sink, c.y - c.ny * sink, c.z - c.nz * sink)) < 1e-5, 'the first card is at its spider\'s size, sunk into its surface', `scale ${s.x.toFixed(3)}, sink ${sink.toFixed(4)} m`)
  const ct = spiders.card.instanceColor.array
  check(Math.abs(ct[0] - c.tr) < 1e-6 && Math.abs(ct[1] - c.tg) < 1e-6 && Math.abs(ct[2] - c.tb) < 1e-6, 'and carries its spider\'s tint', `${c.tr.toFixed(3)} ${c.tg.toFixed(3)} ${c.tb.toFixed(3)}`)
  check(up.distanceTo(new THREE.Vector3(c.nx, c.ny, c.nz)) < 1e-5 && fwd.distanceTo(new THREE.Vector3(c.tx, c.ty, c.tz)) < 1e-5, 'its up is the surface normal and its face is its heading')
  check(spiders.stats.dropped === 0, 'no stone went from under anybody', `${spiders.stats.dropped} dropped`)
}

// --- the top of the climb, a stone gone from under a spider ---------------------
{
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
    tick(spiders, ...nearTo(p), 1 / 60)
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
  for (let f = 0; f < 12 && s.state === 'go'; f++, sat++) tick(spiders, ...nearTo(s), 1 / 60)
  check(s.state === 'pause' && s.stuck === 3 && sat <= 9 && Math.hypot(s.x - lifted[0], s.y - lifted[1], s.z - lifted[2]) < 0.01, 'a spider in the air turns back three times and sits down where it is', `${s.state} after ${sat} frames, stuck ${s.stuck}`)
  for (let f = 0; f < RESEAT_EVERY; f++) tick(spiders, ...nearTo(s), 0)
  check(s.host !== null && hostOf(s) === sphere && offRock(sphere, s) < 1e-4 && s.y > GROUND, 'sitting, it re-reads its stone and is back on the sphere', `off ${offRock(sphere, s).toExponential(2)} m`)
  // The sphere itself gone: every spider on it is taken away, and the slots come back.
  const onSphere = alive().filter((c) => hostOf(c).name === 'sphere')
  const freeBefore = spiders.free.length
  liveRocks = ROCKS.filter((b) => b.name !== 'sphere')
  // Each in turn within her cull, since only a simulated spider re-reads its stone.
  for (const c of onSphere) for (let f = 0; f < RESEAT_EVERY + 12; f++) tick(spiders, ...nearTo(c), 0)
  check(onSphere.length > 0 && onSphere.every((c) => c.host === null) && spiders.stats.dropped === onSphere.length && spiders.free.length === freeBefore + onSphere.length, 'the sphere gone from under them, its spiders are taken away and their slots freed', `${onSphere.length} dropped`)
  check(![...spiders.tiles.values()].some((t) => [...t.hosts.values()].some((h) => h.spiders.some((c) => c.host === null))), 'and no host still lists one')
  check(alive().every((c) => offSurface(c) < 0.02), 'everyone else is where they were')
  liveRocks = ROCKS
}

// --- the ground spider: turned by water and its tether, and its flight ---------------------
{
  const g = alive().find((c) => c.host.kind === 'ground')
  const head = (c, phi) => { c.state = 'go'; c.clip = 'walk'; c.speed = 0.5; c.left = 100; spiders._headGround(c, phi) }
  // A pool two metres east of its point, and the spider on the pool's west bank heading east, straight at it: a quarter turn is +X.
  POOL = { x: g.host.x + 2, z: g.host.z, r: 1 }
  spiders._placeGround(g, POOL.x - POOL.r - 0.02, POOL.z)
  head(g, Math.PI / 2)
  check(g.tx > 0.999, 'a ground spider on a pool\'s bank headed east, at the water')
  for (let f = 0; f < 30; f++) tick(spiders, ...nearTo(g), 1 / 60)
  check(levelAt(g.x, g.z) === null && g.tx < 0 && g.state === 'go', 'half a second on it has turned back from the water and is still walking, dry', `x ${g.x.toFixed(2)} heading tx ${g.tx.toFixed(2)}`)
  POOL = null
  // Past its tether heading away: the next step turns it for home.
  spiders._placeGround(g, g.host.x + GROUND_ROAM_M + 0.5, g.host.z)
  head(g, Math.PI / 2)
  tick(spiders, ...nearTo(g), 1 / 60)
  check(g.state === 'go' && g.tx < 0 && Math.abs(Math.atan2(g.tx, g.tz) - (-Math.PI / 2)) < 0.5, `${GROUND_ROAM_M} m out and heading away, it turns for its point`, `heading ${Math.atan2(g.tx, g.tz).toFixed(2)} rad`)
  // Her body a hand off: it bolts straight away from her, is heard, and calms once FLEE_TO_M off.
  spiders._placeGround(g, g.host.x, g.host.z)
  head(g, 0)
  tick(spiders, ...nearTo(g), 1 / 60)
  const her = [g.x - (0.2 + WALK.radius), GROUND + EYE, g.z]
  tick(spiders, ...her, 1 / 60)
  check(g.state === 'flee' && g.clip === 'run' && spiders.startled([])[0] === g && g.tx > 0.9 && Math.abs(g.ey - GROUND) < 1e-9, 'her feet a hand off, a ground spider bolts straight away from her at the run, heard as it sets off', `${g.state} heading tx ${g.tx.toFixed(2)}`)
  let frames = 0
  while (g.state === 'flee' && frames++ < 600) tick(spiders, ...her, 1 / 60)
  check(g.state !== 'flee' && Math.hypot(g.x - her[0], g.z - her[2]) - WALK.radius >= GROUND_FLEE_M - 0.15 && Math.abs(g.y - GROUND) < 1e-9, `and calms ${GROUND_FLEE_M} m off, still on the ground`, `${g.state} after ${frames} frames, ${(Math.hypot(g.x - her[0], g.z - her[2]) - WALK.radius).toFixed(2)} m off`)
  // Left alone it walks on rather than sitting: over ten seconds with her off at its card rung, a pause is the rare exception.
  let paused = 0
  for (let f = 0; f < 600; f++) { tick(spiders, ...nearTo(g), 1 / 60); if (g.state === 'pause') paused++ }
  check(paused < 60 && g.state !== 'flee', 'and, left alone, walks on with hardly a pause', `${paused} of 600 frames paused`)
  // Three of them from where they were placed, ten seconds each with her at its card rung: hardly a pause, a hand's breadth (a 10 cm spider walks a centimetre a second) or more crawled, never past the tether, off the ground or into the water.
  const ground = { frames: 0, paused: 0, strayed: 0, moved: 0, n: 0 }
  // Picked one at a time: her move to the next one's column can walk the tiles from under the ones not yet watched.
  const watched = new Set([g])
  for (let i = 0; i < 3; i++) {
    const c = alive().find((c) => c.host.kind === 'ground' && !watched.has(c))
    if (!c) break
    watched.add(c)
    const x0 = c.x, z0 = c.z
    ground.n++
    for (let f = 0; f < 600; f++) {
      tick(spiders, ...nearTo(c), 1 / 60)
      ground.frames++
      if (c.state === 'pause') ground.paused++
      if (Math.hypot(c.x - c.host.x, c.z - c.host.z) > GROUND_ROAM_M + 0.05 || Math.abs(c.y - GROUND) > 1e-9 || levelAt(c.x, c.z) !== null) ground.strayed++
    }
    if (Math.hypot(c.x - x0, c.z - z0) > 0.05) ground.moved++
  }
  check(ground.n === 3 && ground.paused < ground.frames * 0.1 && ground.moved === ground.n, 'three more ground spiders hardly ever stop, and every one crawls a hand\'s breadth or more in ten seconds', `${ground.paused} of ${ground.frames} frames paused, ${ground.moved} of ${ground.n} moved`)
  check(ground.strayed === 0, `none strayed past ${GROUND_ROAM_M} m from its point, left the ground or walked into the water`, `${ground.strayed} strayed frames`)
}

// --- the ear hears the spiders --------------------------------------------------
// bodies() is what the ambience reads for the crawl loop: the slots themselves, `speed > 0` on the ones on the move, a pause at speed 0.
{
  home()
  const w = alive().find((c) => c.host.kind === 'tree')
  w.state = 'go'; w.clip = 'walk'; w.speed = 0.05; w.left = 100
  const listed = spiders.bodies([])
  check(listed.length === alive().length && listed.includes(w) && w.speed > 0, 'every seated spider is listed, the walker at its pace', `${listed.length} of ${alive().length}`)
  w.left = 0
  tick(spiders, ...nearTo(w), 1 / 60)
  check(w.state === 'pause' && w.speed === 0 && spiders.bodies([]).includes(w), 'its spell over, the walker pauses at speed 0 and stays listed')
  spiders.batch.visible = false
  check(spiders.bodies([]).length === 0, 'a hidden layer lists nobody')
  spiders.batch.visible = true
}

// --- near: the tiers, the legs, the rear-up ------------------------------------------------
{
  home()
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
  check(t1 === 0 && i1 >= 0 && spiders.meshes[0].count >= 1, `${close.toFixed(2)} m off, the spider is an instance of the mesh`, `tier ${t1}, instance ${i1}`)
  {
    const m = new THREE.Matrix4().fromArray(spiders.meshes[0].instanceMatrix.array, i1 * 16)
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    m.decompose(p, q, s)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
    const k = target.size / spiders.span
    check(Math.abs(s.x - k) < 1e-6 && up.distanceTo(new THREE.Vector3(target.nx, target.ny, target.nz)) < 1e-5 && fwd.distanceTo(new THREE.Vector3(target.tx, target.ty, target.tz)) < 1e-5, 'the instance stands where the spider is at its size, its up the bark\'s normal and its nose along its heading')
    const g = spiders.gaits[0].array
    check(Math.abs(g[i1 * 2] - target.gait) < 1e-6 && Math.abs(g[i1 * 2 + 1] - target.amp) < 1e-6 && target.amp > 0, 'and carries its gait: the phase and a swing', `phase ${target.gait.toFixed(3)} amp ${target.amp.toFixed(4)}`)
    const t = spiders.meshes[0].instanceColor.array
    check(Math.abs(t[i1 * 3] - target.tr) < 1e-6 && Math.abs(t[i1 * 3 + 1] - target.tg) < 1e-6 && Math.abs(t[i1 * 3 + 2] - target.tb) < 1e-6, 'and its tint', `${target.tr.toFixed(3)} ${target.tg.toFixed(3)} ${target.tb.toFixed(3)}`)
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
  const simulated = () => alive().filter((c) => c.rung < CARD_RUNGS).length
  check(alive().every((c) => (c.rung < LOD_RUNGS) === (c.lod === 0)) && drawn() === simulated() && spiders.stats.meshes[target.lod] >= 1, 'every spider on a mesh rung is a mesh and every one on the card rung a card, each drawn once, and the culled not at all', `tiers ${spiders.stats.meshes.join('/')}, ${spiders.card.count} cards, ${simulated()} of ${alive().length} simulated`)
  // The four mesh rungs are all the one mesh: on the second and at the end of the fourth alike.
  const mid = lodReach(target.size, 1) * Math.SQRT2, last = lodReach(target.size, LOD_RUNGS - 1) * 0.95
  const tMid = tiersAt(mid), rMid = target.rung, iMid = instanceOf(0, target)
  check(tMid === 0 && rMid === 2 && iMid >= 0, `at ${mid.toFixed(2)} m, on the second rung, it is the one mesh`, `tier ${tMid}, rung ${rMid} for a ${target.size.toFixed(2)} m spider`)
  const tLast = tiersAt(last)
  check(tLast === 0 && target.rung === LOD_RUNGS - 1 && instanceOf(0, target) >= 0, `and at ${last.toFixed(2)} m, on the fourth, still`, `tier ${tLast}, rung ${target.rung}`)
  // Stepping past the mesh rungs: the next frame it is a card, and NOTHING is drawn twice. Past the card rung it is gone, and frozen.
  const cardAt = lodReach(target.size, LOD_RUNGS - 1) * 1.15
  const tCard = tiersAt(cardAt, 1)
  check(tCard === LOD_TIERS && target.rung === LOD_RUNGS && instanceOf(0, target) < 0 && drawn() === simulated(), `at ${cardAt.toFixed(2)} m, past the fourth rung by more than its hysteresis, it is a card the next frame, a mesh or a card and never both`, `tiers ${spiders.stats.meshes.join('/')}, ${spiders.card.count} cards, ${simulated()} simulated`)
  const cullAt = lodReach(target.size, LOD_RUNGS) * 1.15
  const wasLeft = target.left
  for (let f = 0; f < 2; f++) tick(spiders, target.x, target.y + cullAt, target.z, 1 / 60)
  check(target.rung === CARD_RUNGS && target.left === wasLeft && drawn() === simulated() && instanceOf(0, target) < 0, `at ${cullAt.toFixed(2)} m, past the card rung, it is neither drawn nor simulated`, `rung ${target.rung}, ${drawn()} drawn of ${alive().length}`)
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
  // Through to the frame the flight ends, then the swing's ease-out.
  let fleeing = 0
  while (target.state === 'flee' && fleeing++ < 20 * 60) run(target, t.her, 1)
  run(target, t.her, 30)
  const d2 = bodyDist(target, t.her)
  check(fleeing < 20 * 60 && target.state === 'pause' && target.amp === 0 && d2 < FLEE_TO_M && d2 > d1 + 0.5 && target.h > target.host.hHi - 0.1, `having got as far as the trunk allows -- the top of the climb, the far side -- it calms down there, its legs still`, `${target.state} at ${d2.toFixed(2)} m, ${target.h.toFixed(2)} m up of ${target.host.hHi.toFixed(2)}`)
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
  const still = alive().find((c) => c.host.kind === 'rock' && c !== p)
  still.state = 'pause'; still.speed = 0; still.left = 100; still.clip = 'idle'; still.rear = 0
  // Up to and through its re-seat frame, so the frames counted are the ones between re-seats.
  do tick(spiders, ...nearTo(still), 1 / 60); while ((spiders.frame + still.id) % RESEAT_EVERY !== 0)
  let writes = 0
  const kept = still.m.slice()
  // Every index write to its matrix counted; reads go to the array itself, whose getters want it and not the proxy as their receiver.
  still.m = new Proxy(still.m, { set(m, k, v) { writes++; m[k] = v; return true }, get(m, k) { const v = m[k]; return typeof v === 'function' ? v.bind(m) : v } })
  for (let f = 0; f < RESEAT_EVERY - 1; f++) tick(spiders, ...nearTo(still), 1 / 60)
  check(writes === 0 && !still.dirty && kept.every((v, i) => v === still.m[i]), 'a sitting spider keeps its matrix from frame to frame rather than composing it again', `${writes} writes over ${RESEAT_EVERY - 1} frames`)
}

// --- her hand: a spider picked off its host, the host never regrowing it, one let go of fleeing on the ground --
{
  const k = new Spiders(scene, height, water, { seed: 34, trees, rocks, assets: makeAsset() })
  k.place(0, 0)
  const c = alive(k).find((g) => g.host.kind === 'tree')
  const host = c.host
  check(k.pickAt(c.x, c.y, c.z, 0.3) === null, 'a spider not yet on the ladder is not picked')
  // Her head over it: the tiles about it fill, so the count is taken after.
  tick(k, ...nearTo(c), 1 / 60)
  const before = alive(k).length
  const hit = k.pickAt(c.x + c.nx * 0.1, c.y + c.ny * 0.1, c.z + c.nz * 0.1, 0.3)
  check(hit !== null && hit.c === c && hit.size === c.size, 'a drawn one is, from a hand just off the bark', hit ? `${hit.dist.toFixed(3)} m` : 'null')
  const rec = k.take(hit)
  check(rec.kind === 'spider' && rec.size === c.size && rec.geometry === k.asset.tiers[MESH_TIER] && rec.material === k.material && rec.attrs.aGait[1] === 0 && rec.color[0] === c.tr && rec.scale[0] === rec.scale[1] && rec.stowable === true, 'take hands back the record', JSON.stringify({ size: rec.size, scale: rec.scale[0] }))
  const { geometry: _g, material: _m, ...slot } = rec
  check(k.dress(slot).geometry === rec.geometry && k.dress(slot).material === rec.material, 'dress puts the packed record back on the mesh tier and material')
  k.loaded = false
  check(k.dress(slot) === null, 'and is null before the asset lands')
  k.loaded = true
  let wrong = false
  try { k.dress({ ...slot, kind: 'crab' }) } catch { wrong = true }
  check(wrong, 'and throws for another kind')
  check(c.host === null && !host.spiders.includes(c) && alive(k).length === before - 1, 'and the spider is off its trunk')
  const again = new Spiders(scene, height, water, { seed: 34, trees, rocks, assets: makeAsset() })
  again.place(0, 0)
  tick(again, ...nearTo(c), 1 / 60)
  // By host and place in its group, which a flee does not change.
  const key = (of) => alive(of).map((g) => `${g.host.kind},${g.host.x},${g.host.z},${g.member},${g.size.toFixed(4)}`).sort().join('|')
  check(key(again) === key(k) && alive(again).length === before - 1, 'the trunk regrows without it, and nothing else moved', `${alive(again).length} of ${before}`)
  again.dispose()
  // Let go on open ground: it runs from her.
  const head = { x: 20, y: GROUND + EYE, z: 20, yaw: 0 }
  const ok = k.release(rec, 20.2, GROUND + 1, 20, head)
  const loose = alive(k).find((g) => g.member === -1)
  check(ok && loose && loose.host.kind === 'ground' && loose.size === rec.size && loose.state === 'flee', 'release puts it on the ground under the hand, fleeing', loose ? loose.state : 'none')
  check(Math.abs(loose.y - GROUND) < 0.1 && Math.abs(loose.x - 20.2) < 0.01, 'where the hand was', `${loose.x.toFixed(2)}, ${loose.y.toFixed(2)}`)
  const d0 = Math.hypot(loose.x - head.x, loose.z - head.z)
  for (let i = 0; i < 5 * 60; i++) tick(k, head.x, head.y, head.z, 1 / 60)
  const d1 = Math.hypot(loose.x - head.x, loose.z - head.z)
  check(d1 > d0 + 0.5, 'it runs from her feet', `${d0.toFixed(2)} to ${d1.toFixed(2)} m in 5 s`)
  check(k.release({ ...rec, kind: 'spider' }, POND.x, GROUND, POND.z, head) === false, 'and is refused over the water')
  k.dispose()
}

spiders.dispose()
check(spiders.batch.parent === null, 'dispose takes the batch out of the scene')

console.log(`\n${failures === 0 ? 'all spider checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
