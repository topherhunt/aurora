// Node-side gates for the spiders (src/v2/render/spiders.js).
//
//   node scripts/check-spiders.mjs
//
// The scatter runs against a synthetic wood on flat ground: a stand of trunks
// of several girths (straight cones and crooked, lobed boles, one a sapling too
// thin to host), a sphere boulder, a six-metre pillar, a cobble too small to
// host, a boulder under a pond, a flat slab and a buried stone with no wall to
// climb, a boulder on a puddle's bank, and a tree and a rock far off.
// Everything below is a way a spider can go wrong without anything throwing: a
// group of none or six; a spider on the terrain, off its surface, under the
// ground, in the water or above the climb; spiders mostly on the tops of
// things; a spider on a sapling, a cobble, a drowned rock, a slab or a buried
// stone; a scatter that is not the same twice; a spider that never moves,
// walks off its stone or climbs past three metres; one left spinning in the
// air when its stone is gone, or left behind when its trunk re-seats; a near
// spider drawn as a card or a far one as a puppet, a puppet on the wrong tier,
// one whose clip is not its state, or one that does not rear up when she is
// close; a card that is two quads, or that does not lie where its spider clings
// at its tilt; a frame that costs more than a scatter is allowed to. The
// shipped GLB is checked for shape too -- a skinned tier per rung of the ladder, the
// skeleton and its six clips -- because the world loads it by name and builds
// every puppet from it.
//
// What this can NOT check: whether they look like spiders, or how the crawl
// reads. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import {
  Spiders, LOD_TIERS, NEAR_M, SIZE_M, CLIMB_M, GROUP, ROCK_MIN_SIZE, TRUNK_MIN_R, FLAT_NY, PUPPETS, SINK, HUE, RESEAT_EVERY, WALL_M,
} from '../src/v2/render/spiders.js'
import { PERCH_STRIDE } from '../src/v2/render/rocks.js'
import { TRUNK_STRIDE } from '../src/v2/render/trees.js'
import { CRITTER_GLB, critterTier, lodReach } from '../src/v2/render/critters.js'
import { LOD_FADE_S } from '../src/v2/render/puppet.js'
import { TEX_PX_SMALL } from '../tools/creatures/creature-roster.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the synthetic wood ----------------------------------------------------------
const GROUND = 5
const height = { heightAt: () => GROUND }
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
    check(names.length === LOD_TIERS && names.join(',') === ['birch-spider', ...Array.from({ length: LOD_TIERS - 1 }, (_, k) => `birch-spider-lod${k + 1}`)].join(','), `${LOD_TIERS} tiers, the pick then lod1 up, one for each rung of the ladder`, names.join(','))
    const tris = (json.meshes ?? []).map((m) => json.accessors[m.primitives[0].indices].count / 3)
    check(tris.every((t, k) => k === 0 || t < tris[k - 1]) && tris[tris.length - 1] >= 50, 'each tier is coarser than the last and the coarsest is still a spider and not a smear', tris.join('/'))
    check((json.meshes ?? []).every((m) => m.primitives.length === 1 && m.primitives[0].attributes.JOINTS_0 !== undefined && m.primitives[0].attributes.WEIGHTS_0 !== undefined && m.primitives[0].material === 0), 'every tier is skinned, one primitive, on the one material')
    const skin = json.skins?.[0]
    check(json.skins?.length === 1 && skin.joints.length === 42 && json.nodes[skin.skeleton].name === 'Pedicel', 'one skeleton of 42 joints rooted at the Pedicel', `${skin?.joints.length} joints`)
    check((json.nodes ?? []).filter((n) => n.skin !== undefined).length === LOD_TIERS && (json.nodes ?? []).filter((n) => n.skin !== undefined).every((n) => n.skin === 0), 'every tier node wears the one skin')
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

// --- a stand-in asset: three slabs on a two-bone skeleton, six clips ---------------
function makeAsset() {
  const root = new THREE.Bone()
  root.name = 'Pedicel'
  const head = new THREE.Bone()
  head.name = 'Head'
  head.position.set(0, 0.1, -0.2)
  root.add(head)
  root.position.set(0, 0.11, 0)
  const bones = [root, head]
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const tiers = Array.from({ length: LOD_TIERS }, (_, k) => 2 ** (LOD_TIERS - 1 - k)).map((seg) => {
    const geo = new THREE.BoxGeometry(1, 0.25, 1, seg, 1, seg).translate(0, 0.125, 0)
    const n = geo.getAttribute('position').count
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
    return geo
  })
  const clips = [['walk', 0.9], ['run', 0.42], ['idle', 3.2], ['alert', 3], ['eat', 1.6], ['rest', 5.2]].map(([name, dur]) =>
    new THREE.AnimationClip(name, dur, [new THREE.QuaternionKeyframeTrack('Pedicel.quaternion', [0, dur], [0, 0, 0, 1, 0, 0, 0, 1])]))
  return { root, skeleton, tiers, clips, map: null }
}

// --- construction and the shader hook -----------------------------------------
const scene = new THREE.Scene()
const spiders = new Spiders(scene, height, water, { seed: 11, trees, rocks, assets: makeAsset() })
check(spiders.loaded && Math.abs(spiders.span - 1) < 1e-6 && Math.abs(spiders.bodyH - 0.25) < 1e-6, 'asset set: span 1, body 0.25 high', `span ${spiders.span} body ${spiders.bodyH}`)
check(spiders.puppets.length === PUPPETS && spiders.freePuppets.length === PUPPETS && spiders.puppetMats.length === PUPPETS && spiders.materials.length === PUPPETS * 3, `${PUPPETS} puppets built and free, three materials each -- settled, dissolving in, dissolving out`)
check(spiders.puppets.every((p) => p.meshes.length === LOD_TIERS && p.meshes.every((m) => m.isSkinnedMesh && m.skeleton === p.skeleton && !m.visible) && p.skeleton.bones.length === 2 && p.skeleton.bones[0].name === 'Pedicel' && p.skeleton !== spiders.asset.skeleton), `each puppet: ${LOD_TIERS} skinned tiers bound to its own copy of the skeleton, none shown`)
check(spiders.puppets.every((p) => p.actions.size === 6 && p.mixer.getRoot() === p.group), 'each puppet has a mixer over the six clips, rooted at its group')
check(!spiders.card.visible && spiders.card.count === 0 && spiders.batch.children.length === 1, 'the card is hidden until baked, and no puppet is in the scene')
{
  const compile = (m) => {
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <clipping_planes_fragment>\n#include <map_fragment>\n' }
    m.onBeforeCompile(shader)
    return shader
  }
  const mats = spiders.puppetMats[0]
  const shader = compile(mats.plain)
  check(shader.uniforms.uHue === mats.uHue && shader.fragmentShader.includes('uniform float uHue;') && shader.fragmentShader.includes('#define vHue uHue') && !shader.vertexShader.includes('aHue') && /cross\( hueK, diffuseColor\.rgb \)/.test(shader.fragmentShader), 'a puppet\'s hue is its materials\' one shared uHue uniform, turned after map_fragment')
  check(!shader.fragmentShader.includes('discard'), 'a settled puppet draws through a shader with no discard in it, so it does not cost a tiled GPU its early-Z')
  const [a, b] = [compile(mats.in), compile(mats.out)]
  check(a.uniforms.uCut === mats.uCut && b.uniforms.uCut === mats.uCut && a.uniforms.uSide.value === -b.uniforms.uSide.value && a.fragmentShader === b.fragmentShader && a.fragmentShader.includes('gl_FragCoord'), 'both halves of a fade read one screen-space hash and compare one shared cut the opposite way round')
  check(new Set(spiders.materials.map((m) => m.customProgramCacheKey())).size === 2 && spiders.puppetMats.every((m) => m.plain.customProgramCacheKey() === 'spiders' && m.in.customProgramCacheKey() === 'spiders-fade'), 'two programs between every puppet, not one a puppet')
  const cshader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <map_fragment>\n#include <normal_fragment_begin>\n' }
  spiders.cardMaterial.onBeforeCompile(cshader)
  check(cshader.vertexShader.includes('attribute float aHue;') && spiders.card.geometry.getAttribute('aHue') === spiders.cardHue, 'the card\'s hue rides in aHue per instance')
  const geo = spiders.card.geometry
  const pos = geo.getAttribute('position')
  const ys = new Set(Array.from({ length: pos.count }, (_, i) => pos.getY(i).toFixed(6)))
  check(geo.index.count === 6 && pos.count === 4 && ys.size === 1, 'the card is ONE quad, lying flat at the body\'s middle', `${geo.index.count / 3} tris at y ${[...ys].join(',')}`)
}

// --- placement -----------------------------------------------------------------
const alive = (of = spiders) => of.slots.filter((c) => c.host !== null)
liveTrunks = TRUNKS
liveRocks = ROCKS
const SEEDS = 12
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
  check(!hostedOf.has('sapling') && !hostedOf.has('cobble') && !hostedOf.has('drowned') && !hostedOf.has('far'), `none on the sapling (under ${TRUNK_MIN_R} m), the cobble (under ${ROCK_MIN_SIZE} m), the drowned rock or anything far off`, [...hostedOf.keys()].join(', '))
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
  const hues = new Set(pool.map((c) => c.hue.toFixed(3)))
  check(hues.size > pool.length / 2 && pool.every((c) => Math.abs(c.hue) <= HUE), `spiders wear their own hues within ${HUE}`, `${hues.size} hues in ${pool.length}`)
  // Determinism: the same seed lays the same spiders twice, and place() after leave puts them back where they were.
  const again = new Spiders(scene, height, water, { seed: 11, trees, rocks, assets: makeAsset() })
  again.place(0, 0)
  const key = (of) => alive(of).map((c) => `${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)},${c.size.toFixed(4)}`).sort().join('|')
  check(key(again) === key(spiders) && alive(spiders).length > 0, 'the scatter is a pure function of the seed', `${alive(spiders).length} spiders`)
  again.dispose()
  // A tile whose hosts land late gets its spiders on the rescan.
  liveTrunks = []
  liveRocks = []
  const late = new Spiders(scene, height, water, { seed: 11, trees, rocks, assets: makeAsset() })
  late.place(0, 0)
  check(alive(late).length === 0, 'no hosts, no spiders')
  liveTrunks = TRUNKS
  liveRocks = ROCKS
  // dt 0: the frames only rescan, nobody's pause runs out.
  for (let f = 0; f < 200; f++) late.update(0, GROUND + 1.6, 0, 0)
  check(key(late) === key(spiders), 'hosts that land after place() get their spiders on the rescan, the same ones')
  late.dispose()
  // A trunk re-seated with its chunk takes its spiders with it, on the next rescan.
  const treeSpiders = alive().filter((c) => c.host.kind === 'tree')
  const ys = treeSpiders.map((c) => c.y)
  trunkY += 0.3
  for (let f = 0; f < 4 * spiders.tiles.size + 8; f++) spiders.update(0, GROUND + 40, 0, 0)
  check(treeSpiders.every((c, i) => Math.abs(c.y - ys[i] - 0.3) < 1e-5 && offTrunk(hostOf(c), c) < 1e-3), 'a trunk that re-seats 0.3 m up takes its spiders with it, still on the bark')
  trunkY -= 0.3
  for (let f = 0; f < 4 * spiders.tiles.size + 8; f++) spiders.update(0, GROUND + 40, 0, 0)
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
  for (let f = 0; f < 600; f++) {
    const t0 = performance.now()
    spiders.update(...FAR, 1 / 60)
    ms += performance.now() - t0
    for (const c of alive()) {
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
  check(spiders.card.count === alive().length && spiders.stats.puppets === 0, 'far away, every spider is a card and no puppet is out', `${spiders.card.count} cards, ${alive().length} alive`)
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
    spiders.update(...FAR, 1 / 60)
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
  for (let f = 0; f < 12 && s.state === 'go'; f++, sat++) spiders.update(...FAR, 1 / 60)
  check(s.state === 'pause' && s.stuck === 3 && sat <= 9 && Math.hypot(s.x - lifted[0], s.y - lifted[1], s.z - lifted[2]) < 0.01, 'a spider in the air turns back three times and sits down where it is', `${s.state} after ${sat} frames, stuck ${s.stuck}`)
  for (let f = 0; f < RESEAT_EVERY; f++) spiders.update(...FAR, 0)
  check(s.host !== null && hostOf(s) === sphere && offRock(sphere, s) < 1e-4 && s.y > GROUND, 'sitting, it re-reads its stone and is back on the sphere', `off ${offRock(sphere, s).toExponential(2)} m`)
  // The sphere itself gone: every spider on it is taken away, and the slots come back.
  const onSphere = alive().filter((c) => hostOf(c).name === 'sphere')
  const freeBefore = spiders.free.length
  liveRocks = ROCKS.filter((b) => b.name !== 'sphere')
  for (let f = 0; f < RESEAT_EVERY + 12; f++) spiders.update(...FAR, 0)
  check(onSphere.length > 0 && onSphere.every((c) => c.host === null && !c.puppet) && spiders.stats.dropped === onSphere.length && spiders.free.length === freeBefore + onSphere.length, 'the sphere gone from under them, its spiders are taken away and their slots freed', `${onSphere.length} dropped`)
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
  spiders.update(0, GROUND + 40, 0, 1 / 60)
  check(w.state === 'pause' && w.speed === 0 && spiders.bodies([]).includes(w), 'its spell over, the walker pauses at speed 0 and stays listed')
  spiders.batch.visible = false
  check(spiders.bodies([]).length === 0, 'a hidden layer lists nobody')
  spiders.batch.visible = true
}

// --- near: puppets, tiers, clips ------------------------------------------------
{
  const target = alive().find((c) => c.host.kind === 'tree')
  const at = (d) => [target.x + target.nx * d, target.y, target.z + target.nz * d]
  // Out along the normal, so the distance is exactly d. Long enough by default
  // for the dissolve to finish, a puppet not being back in its pool until it has.
  const SETTLE = Math.ceil(LOD_FADE_S * 60) + 2
  const tiersAt = (d, frames = SETTLE) => {
    for (let f = 0; f < frames; f++) spiders.update(...at(d), 1 / 60)
    return target.puppet ? target.puppet.meshes.findIndex((m) => m.visible) : -1
  }
  // Well inside its own top rung -- a spider is a hand's breadth across, so that is centimetres and not metres.
  const close = lodReach(target.size, 0) / 2
  const t1 = tiersAt(close)
  check(target.puppet && t1 === 0 && spiders.batch.children.includes(target.puppet.group), `${close.toFixed(2)} m off, the spider is a puppet on tier 0, in the scene`)
  check(target.puppet.current && target.puppet.current.getClip().name === target.clip && target.puppet.current.isRunning(), 'its clip is its state\'s', `${target.clip}`)
  check(target.puppet.mats.uHue.value === target.hue, 'its materials wear its hue')
  const pos = new THREE.Vector3().setFromMatrixPosition(target.puppet.group.matrix)
  check(Math.abs(pos.distanceTo(new THREE.Vector3(target.x, target.y, target.z)) - SINK * spiders.bodyH * target.size / spiders.span) < 1e-6 && !target.puppet.group.matrixAutoUpdate, 'the puppet stands where the spider is, sunk its feet into the bark, under a matrix the scatter writes')
  const dist = (c) => Math.hypot(c.x - at(1)[0], c.y - at(1)[1], c.z - at(1)[2])
  // A puppet is kept to 1.15 NEAR_M once taken; a step is under 2 cm.
  check(alive().every((c) => (c.puppet ? dist(c) <= NEAR_M * 1.15 + 0.02 : dist(c) >= NEAR_M - 0.02)) && spiders.stats.puppets + spiders.card.count === alive().length && spiders.stats.puppets >= 1 && spiders.starved === 0, `every spider within ${NEAR_M} m is a puppet and the rest are cards`, `${spiders.stats.puppets} puppets, ${spiders.card.count} cards`)
  // The floor is held rather than culled: a spider inside NEAR_M is always a mesh, the card being what takes over out there.
  const expect = (d) => Math.min(critterTier(target.size, d, -1, LOD_TIERS), LOD_TIERS - 1)
  const t5 = tiersAt(5), t95 = tiersAt(9.5)
  check(t5 === expect(5) && t95 === expect(9.5) && t95 === LOD_TIERS - 1, `at 5 m tier ${expect(5)}, at 9.5 m the last tier and not a cull`, `${t5}, ${t95} for a ${target.size.toFixed(2)} m spider`)
  // Stepping out of range: one frame in, the mesh is still there and dissolving, and NOTHING is drawn twice.
  for (let f = 0; f < 1; f++) spiders.update(...at(12), 1 / 60)
  const going = target.puppet
  check(going && going.tier === -1 && going.meshes.filter((m) => m.visible).length === 1 && going.meshes.find((m) => m.visible).material === going.mats.out && going.mats.uCut.value < 1,
    'a spider that walks out of range dissolves away rather than blinking out')
  check(spiders.stats.puppets + spiders.card.count === alive().length, 'and is a mesh or a card in that moment, never both at once', `${spiders.stats.puppets} puppets, ${spiders.card.count} cards, ${alive().length} alive`)
  const t12 = tiersAt(12)
  check(t12 === -1 && !target.puppet, `at 12 m it is a card again and its puppet is back in the pool`)
  check(spiders.freePuppets.length === PUPPETS - spiders.stats.puppets, 'the pool balances')
  // Reared up when she is close and paused; back to its business when she goes.
  target.state = 'pause'; target.clip = 'idle'; target.left = 100
  tiersAt(0.5, 3)
  check(target.clip === 'alert' && target.puppet.current.getClip().name === 'alert', 'a paused spider with her head half a metre off is alert')
  tiersAt(3, 3)
  check(target.clip !== 'alert', 'and drops it when she steps back', target.clip)
  // Mixer time runs only while a puppet is out.
  const time = target.puppet.mixer.time
  tiersAt(3, 10)
  check(target.puppet.mixer.time > time, 'its mixer advances with the frames')
}

spiders.dispose()
check(spiders.batch.parent === null, 'dispose takes the batch out of the scene')

console.log(`\n${failures === 0 ? 'all spider checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
