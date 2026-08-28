import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { PeerAvatars } from './v2/render/avatar.js'

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a0e16)
scene.add(new THREE.HemisphereLight(0xd6e7ff, 0x202638, 2.2))
const key = new THREE.DirectionalLight(0xffe5cb, 2.2)
key.position.set(-2, 4, 3)
scene.add(key)

const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 100)
camera.position.set(0, 1.55, 0.75)
camera.lookAt(0, 1.45, 0)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 1.45, 0)
controls.enablePan = false
controls.minDistance = 0.35
controls.maxDistance = 3
controls.update()

const grid = new THREE.GridHelper(2, 10, 0x2b4a72, 0x16253b)
grid.position.y = 1.05
scene.add(grid)

const avatars = new PeerAvatars(scene)
avatars.apply([{
  id: 'preview',
  pose: [0, 1.65, 0, 0, 0, 0, 1, -0.18, 1.28, -0.02, 0, 0, 0, 1, 0.18, 1.28, -0.02, 0, 0, 0, 1],
  hands: [true, true],
  alpha: 1,
}])

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

renderer.setAnimationLoop(() => renderer.render(scene, camera))
