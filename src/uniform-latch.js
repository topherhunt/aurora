// ---------------------------------------------------------------------------
// UNIFORM LATCH -- A PERFORMANCE MANDATE (see uniform-block.js for the numbers).
//
// The sun, the hemisphere light and the fog are three's own uniforms, so they
// cannot go in a UniformBlock. They creep every frame (a weather ease moves
// fogDensity in its 7th digit), and three keeps its upload cache per program,
// so each creep is re-sent once per lit program: ~100 `uniform*` calls a frame
// on the Quest for changes nobody can see.
//
// The latch lets a value move only when it has drifted past a tolerance beyond
// what the screen can show: each registered field is held at its latched value
// for the duration of a `renderer.render` call and restored afterwards, so the
// writers (main.js's per-frame lighting) are untouched and three's per-program
// cache hits every frame in between. A jump (a cave, the water surface) is
// larger than the tolerance and passes straight through.
// ---------------------------------------------------------------------------

export class UniformLatch {
  constructor(renderer) {
    this.items = []
    const render = renderer.render
    const latch = this
    renderer.render = function (...args) {
      const items = latch.items
      for (let i = 0; i < items.length; i++) items[i].hold()
      try {
        return render.apply(this, args)
      } finally {
        for (let i = 0; i < items.length; i++) items[i].release()
      }
    }
  }

  /** A numeric field `obj[key]` (an intensity, a density); moves when it drifts by `rel` of its latched value or `abs`. */
  number(obj, key, rel = 0.004, abs = 1e-7) {
    let held = null, latched
    this.items.push({
      hold() {
        held = obj[key]
        if (latched === undefined || Math.abs(held - latched) > abs + rel * Math.abs(latched)) latched = held
        obj[key] = latched
      },
      release() { obj[key] = held },
    })
  }

  /** A THREE.Color (linear): any channel moving by `rel` of its latched value or `abs` moves all three. */
  color(c, rel = 0.004, abs = 5e-4) {
    let hr, hg, hb, lr, lg, lb
    this.items.push({
      hold() {
        hr = c.r; hg = c.g; hb = c.b
        if (lr === undefined || Math.abs(hr - lr) > abs + rel * lr || Math.abs(hg - lg) > abs + rel * lg || Math.abs(hb - lb) > abs + rel * lb) { lr = hr; lg = hg; lb = hb }
        c.r = lr; c.g = lg; c.b = lb
      },
      release() { c.r = hr; c.g = hg; c.b = hb },
    })
  }

  /** A THREE.Vector3 (a light's position, so its direction): moves when any component drifts by `abs`. */
  vector(v, abs = 5e-4) {
    let hx, hy, hz, lx, ly, lz
    this.items.push({
      hold() {
        hx = v.x; hy = v.y; hz = v.z
        if (lx === undefined || Math.abs(hx - lx) > abs || Math.abs(hy - ly) > abs || Math.abs(hz - lz) > abs) { lx = hx; ly = hy; lz = hz }
        v.set(lx, ly, lz)
      },
      release() { v.set(hx, hy, hz) },
    })
  }
}
