import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { tileSeed, walkTiles } from './critters.js'
import { seaweedGeometry, seaweedMaterial } from './seaweed.js'

// Seaweed on lake and river beds: clump SEED of render/seaweed.js, instanced, one draw call.
//
// The water within RADIUS of her is cut into TILE-metre tiles, each rolling its sites from its tile seed (critters.js
// tileSeed), so a bed is a pure function of position like the fish beds. A clump grows HEIGHT_M tall and stands only where
// the water over its root is that tall plus TOP_GAP_M: its tip is never nearer the surface than TOP_GAP_M, so nothing grows
// in less than 2 m of water.

export const SEAWEED_SCATTER = {
  seed: 42,
  tile: 16,
  radius: 96,
  perTile: 8,
  heightM: [1, 4],
  topGapM: 1,
  capacity: 1200,
}

/**
 * The clumps of tile (tx, tz): [{ x, y, z, h, yaw }], `y` the bed and `h` the clump's height in metres. `levelAt(x, z)` is
 * the water surface or null on dry land, `bedAt(x, z)` the ground.
 */
export function weedSites(tx, tz, worldSeed, levelAt, bedAt) {
  const C = SEAWEED_SCATTER
  const rand = mulberry32(tileSeed(tx, tz, worldSeed))
  const sites = []
  for (let i = 0; i < C.perTile; i++) {
    // Every roll is drawn before the site is tested, so a refused site leaves the stream where an accepted one would.
    const x = (tx + rand()) * C.tile, z = (tz + rand()) * C.tile
    const h = C.heightM[0] + (C.heightM[1] - C.heightM[0]) * rand()
    const yaw = rand() * Math.PI * 2
    const level = levelAt(x, z)
    if (level === null) continue
    const y = bedAt(x, z)
    if (level - y < h + C.topGapM) continue
    sites.push({ x, y, z, h, yaw })
  }
  return sites
}

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
    patch(this.material)
    this.mesh = new THREE.InstancedMesh(geo, this.material, SEAWEED_SCATTER.capacity)
    this.mesh.name = 'v2-seaweed'
    // Instances span the whole radius and never move once placed; the one bounding sphere would have to be the radius anyway.
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    scene.add(this.mesh)
    this.at = null
    this._m = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this._p = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)
  }

  /** Brings the tiles in reach of (x, z) up to date; cheap when she has not crossed into a new tile. */
  place(x, z) {
    const C = SEAWEED_SCATTER
    const gx = Math.floor(x / C.tile), gz = Math.floor(z / C.tile)
    if (this.at !== null && this.at[0] === gx && this.at[1] === gz) return
    this.at = [gx, gz]
    const changed = walkTiles(
      this.tiles, x, z, C.tile, C.radius,
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
