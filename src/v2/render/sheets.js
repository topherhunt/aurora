// Sheet ghosts: after dark the town's children go about under a white sheet with two eye holes (design/45-bone-friends.md §Sheets).

import THREE from '../../three-instance.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

export const SHEET = {
  // At most this many drawn at once; past `dayness` they are off. Sitting or riding, a child is not wearing one.
  max: 24,
  dayness: 0.3,
  unworn: new Set(['sit', 'idle-sit', 'ride', 'ride-idle']),
}

/** A sheet one metre tall, its hem at y 0.12 so the feet show, the eye holes on +X (a townsperson's forward). */
export function sheetGeometry() {
  const profile = [[0, 1.04], [0.09, 1.02], [0.15, 0.96], [0.18, 0.86], [0.2, 0.76], [0.24, 0.66], [0.28, 0.4], [0.33, 0.14], [0.34, 0.12]]
  const body = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 16)
  const parts = [body]
  for (const side of [-1, 1]) {
    const a = side * 0.32
    const eye = new THREE.CircleGeometry(0.035, 10)
    eye.scale(1, 1.4, 1)
    eye.rotateY(Math.PI / 2 + a)
    eye.translate(Math.cos(a) * 0.188, 0.88, -Math.sin(a) * 0.188)
    parts.push(eye)
  }
  const colours = [[0.94, 0.94, 0.9], [0.04, 0.04, 0.05], [0.04, 0.04, 0.05]]
  parts.forEach((g, i) => {
    g.deleteAttribute('uv')
    const n = g.attributes.position.count
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).map((_, j) => colours[i][j % 3]), 3))
  })
  const geo = mergeGeometries(parts.map((g) => g.index ? g.toNonIndexed() : g))
  geo.computeVertexNormals()
  return geo
}

export class Sheets {
  constructor(scene) {
    this.geometry = sheetGeometry()
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, SHEET.max)
    this.mesh.name = 'v2-sheets'
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    scene.add(this.mesh)
    this.worn = 0
  }

  get materials() { return [this.material] }

  /** One frame over the townsfolk drawn this frame (Townsfolk.shown): each child up and about wears one after dark. */
  update(shown, dayness) {
    let n = 0
    if (dayness < SHEET.dayness) {
      for (const c of shown) {
        if (n === SHEET.max) break
        if (c.role !== 'child' || c.hidden || SHEET.unworn.has(c.pose.clip)) continue
        _pos.set(c.pose.x, c.pose.y, c.pose.z)
        _quat.setFromAxisAngle(UP, c.pose.heading)
        _scl.setScalar(c.size)
        this.mesh.setMatrixAt(n++, _mat.compose(_pos, _quat, _scl))
      }
    }
    this.mesh.count = this.worn = n
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.mesh.removeFromParent()
    this.geometry.dispose()
    this.material.dispose()
  }
}

const UP = new THREE.Vector3(0, 1, 0)
const _pos = new THREE.Vector3(), _quat = new THREE.Quaternion(), _scl = new THREE.Vector3(), _mat = new THREE.Matrix4()
