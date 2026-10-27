import THREE from '../../three-instance.js'
import { mulberry32, smoothstep } from '../../sim/mathx.js'
import { CURRENT } from '../../water.js'
import { tileSeed, walkTiles } from './critters.js'
import { seaweedGeometry, seaweedMaterial } from './seaweed.js'

// Seaweed on lake and river beds: clump SEED of render/seaweed.js, instanced, one draw call.
//
// The water within RADIUS of her is cut into TILE-metre tiles, each rolling its sites from its tile seed (critters.js
// tileSeed), so a bed is a pure function of position like the fish beds. A clump stands only where the water over its
// root is its height plus TOP_GAP_M: its tip is never nearer the surface than TOP_GAP_M, so nothing grows in less than 2 m
// of water. A slow two-octave noise field (densityAt) thins the beds: dense ground takes patches -- a few tall clumps
// near a middle ringed by many short ones -- and loose singles, sparse ground only the odd single.

export const SEAWEED_SCATTER = {
  seed: 42,
  tile: 12,
  // CULL_M past her the vertex stage drops a clump (UNDERWATER.visibility is 20 m). Tiles are walked from the middle of her own, so RADIUS is CULL_M plus two half-diagonals (hers off that middle, a clump's off its tile's) plus a patch's widest spread.
  cullM: 30,
  radius: 52,
  // Noise cells of the density field in metres, coarse and fine, and the fine octave's weight.
  field: [48, 17],
  fine: 0.35,
  // Single clumps rolled per tile, each kept at `floor` odds on the sparsest ground, rising to 1 on the densest.
  singles: 4,
  floor: 0.12,
  singleM: [1, 8],
  // One patch rolled per tile, kept at `odds` times density squared: `count` clumps within `spread` metres, `big` of them `bigM` tall inside `core` of the spread, the rest `smallM`.
  patch: { odds: 0.7, count: [10, 30], spread: [2, 5], big: [1, 3], core: 0.35, bigM: [2.8, 8], smallM: [1, 2] },
  topGapM: 1,
  // Metres of tip travel per metre of clump height at peak current, and seconds of phase lag per metre down the current.
  sway: 0.08,
  lag: 0.12,
  // A wave climbing every blade: `wave` metres crest to crest, a crest every `period` seconds, swinging `amp` metres at the tip and none at the holdfast; `across` of it runs edgewise a quarter out of step, so a blade writhes rather than flaps.
  ripple: { wave: 2.6, period: 5, amp: 0.12, across: 0.5 },
  capacity: 2048,
}

const lattice = (i, j, seed) => tileSeed(i, j, seed) / 4294967296

function octave(x, z, cell, seed) {
  const fx = x / cell, fz = z / cell
  const i = Math.floor(fx), j = Math.floor(fz)
  const sx = smoothstep(0, 1, fx - i), sz = smoothstep(0, 1, fz - j)
  const a = lattice(i, j, seed), b = lattice(i + 1, j, seed), c = lattice(i, j + 1, seed), d = lattice(i + 1, j + 1, seed)
  return a + (b - a) * sx + (c - a + (a - b - c + d) * sx) * sz
}

/** How thickly the bed at (x, z) grows, 0 (bare but for the odd single) to 1 (patch after patch). */
export function densityAt(x, z, worldSeed) {
  const C = SEAWEED_SCATTER
  const n = (1 - C.fine) * octave(x, z, C.field[0], worldSeed ^ 0x5ea3eed) + C.fine * octave(x, z, C.field[1], worldSeed ^ 0x3b1d)
  return smoothstep(0.38, 0.68, n)
}

/**
 * The clumps of tile (tx, tz): [{ x, y, z, h, yaw }], `y` the bed and `h` the clump's height in metres. `levelAt(x, z)` is
 * the water surface or null on dry land, `bedAt(x, z)` the ground.
 */
export function weedSites(tx, tz, worldSeed, levelAt, bedAt) {
  const C = SEAWEED_SCATTER
  const P = C.patch
  const rand = mulberry32(tileSeed(tx, tz, worldSeed))
  const sites = []
  const grow = (x, z, [lo, hi], r) => {
    const h = lo + (hi - lo) * r()
    const yaw = r() * Math.PI * 2
    const level = levelAt(x, z)
    if (level === null) return
    const y = bedAt(x, z)
    if (level - y < h + C.topGapM) return
    sites.push({ x, y, z, h, yaw })
  }
  // Every roll the main stream owes is drawn whether or not its site is kept, and a patch rolls its members from a seed of its own, so a refused site leaves the stream where an accepted one would.
  for (let i = 0; i < C.singles; i++) {
    const x = (tx + rand()) * C.tile, z = (tz + rand()) * C.tile
    const keep = rand()
    const r = mulberry32((rand() * 4294967296) >>> 0)
    if (keep < C.floor + (1 - C.floor) * densityAt(x, z, worldSeed)) grow(x, z, C.singleM, r)
  }
  const cx = (tx + rand()) * C.tile, cz = (tz + rand()) * C.tile
  const keep = rand()
  const r = mulberry32((rand() * 4294967296) >>> 0)
  if (keep < P.odds * densityAt(cx, cz, worldSeed) ** 2) {
    const n = Math.round(P.count[0] + (P.count[1] - P.count[0]) * r())
    const big = Math.round(P.big[0] + (P.big[1] - P.big[0]) * r())
    const spread = P.spread[0] + (P.spread[1] - P.spread[0]) * r()
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2
      // sqrt spreads the small ones evenly over the disc; the big ones keep to its core.
      const d = spread * (k < big ? P.core * r() : Math.sqrt(r()))
      grow(cx + Math.cos(a) * d, cz + Math.sin(a) * d, k < big ? P.bigM : P.smallM, r)
    }
  }
  return sites
}

const TAU = (Math.PI * 2).toFixed(6)

// A wave climbing each blade along its own bearing (seaweed.js `blade`, at its own phase and the clump's hash), then the current's along-and-across of water.js currentDrift leaning the whole clump by its height squared.
const SWAY_GLSL = /* glsl */ `
  {
    vec3 swRoot = instanceMatrix[3].xyz;
    float swK2 = dot( instanceMatrix[0].xyz, instanceMatrix[0].xyz );
    float swK = sqrt( swK2 );
    float swHash = fract( sin( dot( swRoot.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    float swFrac = transformed.y / uSwayGeoH;
    vec2 swOut = blade.xy;
    float swRip = ${TAU} * ( transformed.y * swK / ${SEAWEED_SCATTER.ripple.wave.toFixed(4)} - uSwayT / ${SEAWEED_SCATTER.ripple.period.toFixed(4)} + swHash ) + blade.z;
    vec2 swWrithe = ( swOut * sin( swRip ) + vec2( -swOut.y, swOut.x ) * ( ${SEAWEED_SCATTER.ripple.across.toFixed(4)} * cos( swRip ) ) ) * ( ${SEAWEED_SCATTER.ripple.amp.toFixed(4)} * swFrac / swK );
    transformed.xz += swWrithe;
    float swT = uSwayT + dot( swRoot.xz, uSwayDir ) * ${SEAWEED_SCATTER.lag.toFixed(4)} + swHash * 2.0;
    float swAlong = ${CURRENT.slowShare.toFixed(4)} * sin( ${TAU} * swT / ${CURRENT.slow.toFixed(4)} ) + ${(1 - CURRENT.slowShare).toFixed(4)} * sin( ${TAU} * swT / ${CURRENT.fast.toFixed(4)} + 1.7 );
    float swAcross = ${CURRENT.cross.toFixed(4)} * sin( ${TAU} * swT / ${(CURRENT.slow * 0.61).toFixed(4)} + 0.9 );
    vec3 swWorld = vec3( uSwayDir.x * swAlong - uSwayDir.y * swAcross, 0.0, uSwayDir.y * swAlong + uSwayDir.x * swAcross ) * ( ${SEAWEED_SCATTER.sway.toFixed(4)} * swFrac * swFrac * uSwayGeoH * swK );
    // Back through the instance's rotation and scale, so the lean runs down the current in the world whatever the clump's yaw.
    transformed += transpose( mat3( instanceMatrix ) ) * swWorld / swK2;
  }`


export class SeaweedScatter {
  /** @param height V2Height: heightAt(x, z); @param water WaterSurfaces: levelAt(x, z) */
  constructor(scene, height, water, { seed, patch }) {
    if (typeof height.heightAt !== 'function') throw new Error('SeaweedScatter needs a height field with heightAt')
    if (typeof water.levelAt !== 'function') throw new Error('SeaweedScatter needs WaterSurfaces, for levelAt')
    this.height = height
    this.water = water
    this.seed = seed
    this.tiles = new Map()
    const geo = seaweedGeometry(SEAWEED_SCATTER.seed)
    geo.computeBoundingBox()
    this.geoHeight = geo.boundingBox.max.y
    this.material = seaweedMaterial()
    const heading = (CURRENT.heading * Math.PI) / 180
    this.uniforms = {
      uSwayT: { value: 0 },
      uSwayGeoH: { value: this.geoHeight },
      uSwayDir: { value: new THREE.Vector2(Math.sin(heading), -Math.cos(heading)) },
    }
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 blade;\nuniform float uSwayT;\nuniform float uSwayGeoH;\nuniform vec2 uSwayDir;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SWAY_GLSL}`)
        // Behind the far plane with w positive, so the clipper drops the whole clump.
        .replace('#include <project_vertex>', `#include <project_vertex>
          if ( distance( ( modelMatrix * instanceMatrix[3] ).xyz, cameraPosition ) > ${SEAWEED_SCATTER.cullM.toFixed(1)} ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );`)
    }
    patch(this.material)
    this.mesh = new THREE.InstancedMesh(geo, this.material, SEAWEED_SCATTER.capacity)
    this.mesh.name = 'v2-seaweed'
    // Instances span the whole radius and never move once placed; the one bounding sphere would have to be the radius anyway.
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.mesh.visible = false
    scene.add(this.mesh)
    this.at = null
    this._m = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this._p = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)
  }

  /** Brings the tiles in reach of (x, z) up to date, cheap when she has not crossed into a new tile, and sets the sway to wall-clock second `t` (the clock water.js currentDrift runs on). */
  place(x, z, t) {
    this.uniforms.uSwayT.value = t
    const C = SEAWEED_SCATTER
    const gx = Math.floor(x / C.tile), gz = Math.floor(z / C.tile)
    if (this.at !== null && this.at[0] === gx && this.at[1] === gz) return
    this.at = [gx, gz]
    const changed = walkTiles(
      this.tiles, (gx + 0.5) * C.tile, (gz + 0.5) * C.tile, C.tile, C.radius,
      (tx, tz) => ({ tx, tz, sites: weedSites(tx, tz, this.seed, (px, pz) => this.water.levelAt(px, pz), (px, pz) => this.height.heightAt(px, pz)) }),
      () => {},
    )
    if (changed > 0) this._upload()
  }

  _upload() {
    let n = 0
    for (const t of this.tiles.values()) {
      for (const s of t.sites) {
        if (n === SEAWEED_SCATTER.capacity) throw new Error(`SeaweedScatter: more than ${SEAWEED_SCATTER.capacity} clumps in reach`)
        const k = s.h / this.geoHeight
        this._q.setFromAxisAngle(this._up, s.yaw)
        this.mesh.setMatrixAt(n++, this._m.compose(this._p.set(s.x, s.y, s.z), this._q, this._s.set(k, k, k)))
      }
    }
    this.mesh.count = n
    this.mesh.visible = n > 0
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.material.map.dispose()
    this.material.dispose()
    this.mesh.dispose()
  }
}
