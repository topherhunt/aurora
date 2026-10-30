import THREE from '../three-instance.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// The smith's knife (items.js kind 'knife'), built here rather than shipped: a steel blade along -Z, a wrapped wooden handle
// along +Z, centred, ITEMS.knife.size long. HEEL to TIP, in its frame, is the edge that carves (main.js carveByHand).

const LONG = 0.26
export const TIP = new THREE.Vector3(0, 0.004, -LONG / 2)
export const HEEL = new THREE.Vector3(0, 0.004, 0.006)

/** The knife's geometry, vertex-coloured, and its material. */
export function buildKnife() {
  const paint = (g, hex) => {
    const c = new THREE.Color(hex)
    const n = g.attributes.position.count
    const a = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) c.toArray(a, i * 3)
    g.setAttribute('color', new THREE.BufferAttribute(a, 3))
    return g
  }
  // A blade tapering to its point: a box whose far end's top corners are pulled down to the edge.
  const blade = new THREE.BoxGeometry(0.004, 0.026, 0.14, 1, 1, 4).translate(0, 0.004, -0.06)
  const p = blade.attributes.position
  for (let i = 0; i < p.count; i++) {
    const t = THREE.MathUtils.clamp((-p.getZ(i) - 0.01) / 0.12, 0, 1)
    if (p.getY(i) > 0.004) p.setY(i, 0.004 + (p.getY(i) - 0.004) * (1 - t * t))
  }
  const guard = new THREE.BoxGeometry(0.012, 0.036, 0.008).translate(0, 0.002, 0.012)
  const handle = new THREE.CylinderGeometry(0.011, 0.012, 0.11, 8).rotateX(Math.PI / 2).translate(0, 0, 0.07)
  const pommel = new THREE.SphereGeometry(0.013, 8, 6).translate(0, 0, 0.125)
  const geometry = mergeGeometries([paint(blade.toNonIndexed(), 0xb8bec6), paint(guard.toNonIndexed(), 0x5a5048), paint(handle.toNonIndexed(), 0x6a4426), paint(pommel.toNonIndexed(), 0x5a5048)])
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return { geometry, material: new THREE.MeshLambertMaterial({ vertexColors: true }) }
}
