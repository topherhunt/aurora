import * as THREE from 'three'
import { WORLD_SIZE, WORLD_HALF } from '../config.js'
import { createTerrainMaterial } from '../../terrain/terrain-material.js'

// Quest diagnostic terrain: one fixed mesh sampled directly from the imported
// macro heightmap. It intentionally has no quadtree, workers, chunk streaming,
// skirts, BatchedMesh, skyline selection, or procedural detail. The grid is
// deliberately much smaller than the source image so this test measures the
// terrain machinery without replacing it with a million-vertex stress test.
const RES = 128

export class MacroTerrain {
  constructor(scene, { heightmap, atlas = null } = {}) {
    if (!heightmap || !(heightmap.field instanceof Float32Array)) {
      throw new Error('MacroTerrain: needs a decoded Heightmap')
    }

    this.heightmap = heightmap
    this.material = createTerrainMaterial({ atlas })
    this.geometry = new THREE.BufferGeometry()

    const verts = (RES + 1) * (RES + 1)
    const positions = new Float32Array(verts * 3)
    const colors = new Float32Array(verts * 3)
    const index = new Uint32Array(RES * RES * 6)
    const sample = (x, z) => {
      const sx = Math.round((x + WORLD_HALF) / WORLD_SIZE * (heightmap.width - 1))
      const sz = Math.round((z + WORLD_HALF) / WORLD_SIZE * (heightmap.height - 1))
      const ix = Math.max(0, Math.min(heightmap.width - 1, sx))
      const iz = Math.max(0, Math.min(heightmap.height - 1, sz))
      return heightmap.field[iz * heightmap.width + ix]
    }

    for (let z = 0; z <= RES; z++) {
      const wz = -WORLD_HALF + WORLD_SIZE * z / RES
      for (let x = 0; x <= RES; x++) {
        const wx = -WORLD_HALF + WORLD_SIZE * x / RES
        const i = z * (RES + 1) + x
        positions[i * 3] = wx
        positions[i * 3 + 1] = sample(wx, wz)
        positions[i * 3 + 2] = wz

        // Keep the material's vertex-colour path active, but use a compact
        // macro-world palette rather than the authored layer/detail classifier.
        const h = positions[i * 3 + 1]
        const t = Math.max(0, Math.min(1, (h - heightmap.min) / Math.max(1, heightmap.max - heightmap.min)))
        colors[i * 3] = 0.045 + t * 0.045
        colors[i * 3 + 1] = 0.075 + t * 0.035
        colors[i * 3 + 2] = 0.028 + t * 0.045
      }
    }

    let k = 0
    for (let z = 0; z < RES; z++) {
      for (let x = 0; x < RES; x++) {
        const a = z * (RES + 1) + x
        const b = a + 1
        const c = a + RES + 1
        const d = c + 1
        index[k++] = a; index[k++] = c; index[k++] = b
        index[k++] = b; index[k++] = c; index[k++] = d
      }
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1))
    this.geometry.computeVertexNormals()
    this.geometry.computeBoundingSphere()

    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.name = 'v2-quest-macro-terrain'
    scene.add(this.mesh)

    this.stats = {
      rendered: 1,
      drawnTris: RES * RES * 2,
      slots: 1,
      queued: 0,
      cached: 1,
      pending: 0,
      pendingEdits: 0,
      workerBusy01: 0,
      triDeg: 15,
      profileDeg: null,
      horizonMs: 0,
      cellUnderfoot: WORLD_SIZE / RES,
    }
  }

  update() {}

  groundAt(x, z) {
    const sx = Math.max(0, Math.min(this.heightmap.width - 1, Math.round((x + WORLD_HALF) / WORLD_SIZE * (this.heightmap.width - 1))))
    const sz = Math.max(0, Math.min(this.heightmap.height - 1, Math.round((z + WORLD_HALF) / WORLD_SIZE * (this.heightmap.height - 1))))
    return this.heightmap.field[sz * this.heightmap.width + sx]
  }

  groundKeyAt() {
    return 0
  }

  setRelief() {}
}
