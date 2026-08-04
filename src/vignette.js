import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Comfort vignette (DESIGN.md §12): tunnel the periphery during movement.
//
// Peripheral vision is where optical-flow-driven nausea comes from, so masking
// it while she moves is the single highest-value comfort feature after the
// acceleration curve.
//
// Drawn as a camera-child quad rather than a fullscreen post pass -- a post
// pass would mean a second render target on a fill-rate-bound mobile GPU, for
// an effect that is geometrically trivial.
// ---------------------------------------------------------------------------

const DIST = 0.5 // metres in front of the eye
const SIZE = 1.9 // wide enough to cover Quest 3's FOV at that distance

export class Vignette {
  constructor(camera) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uInner: { value: 1.0 },
        uOuter: { value: 1.4 },
        uStrength: { value: 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform float uInner;
        uniform float uOuter;
        uniform float uStrength;
        void main() {
          float d = length( vUv - 0.5 ) * 2.0;
          float a = smoothstep( uInner, uOuter, d ) * uStrength;
          if ( a < 0.004 ) discard;
          gl_FragColor = vec4( 0.0, 0.0, 0.0, a );
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    })

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), this.material)
    this.mesh.position.set(0, 0, -DIST)
    this.mesh.renderOrder = 1000
    this.mesh.frustumCulled = false
    camera.add(this.mesh)

    this._current = 0
  }

  // speed01: current speed as a fraction of max.
  update(speed01, dt) {
    // Ease the vignette itself, so it does not snap open the instant she stops.
    this._current += (speed01 - this._current) * (1 - Math.exp(-dt / 0.25))
    const t = Math.min(1, Math.max(0, this._current))
    // Skip it entirely at rest. A transparent quad still rasterises the whole
    // screen even when every fragment discards, and this GPU is fill-bound.
    this.mesh.visible = t > 0.01
    const u = this.material.uniforms
    u.uStrength.value = 0.92 * t
    // Aperture tightens with speed: wide-open at rest, closed in at full walk.
    u.uInner.value = 1.05 - 0.42 * t
    u.uOuter.value = u.uInner.value + 0.42
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
