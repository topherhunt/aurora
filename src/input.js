// ---------------------------------------------------------------------------
// Quest Touch controller polling with edge detection.
//
// Standard xr-standard gamepad mapping:
//   buttons[0] trigger  buttons[1] grip  buttons[3] stick press
//   buttons[4] A (right) / X (left)      buttons[5] B (right) / Y (left)
//   axes[2] stick X     axes[3] stick Y  (axes[0..1] are the trackpad, unused)
// ---------------------------------------------------------------------------

const BTN = { TRIGGER: 0, GRIP: 1, STICK: 3, PRIMARY: 4, SECONDARY: 5 }

export class Input {
  constructor(renderer) {
    this.renderer = renderer
    this.prev = { left: {}, right: {} }
    this.state = {
      left: { axes: [0, 0], buttons: {} },
      right: { axes: [0, 0], buttons: {} },
      connected: 0,
    }
  }

  update() {
    const session = this.renderer.xr.getSession()
    this.state.connected = 0
    this.state.left.source = null
    this.state.right.source = null
    if (!session) return this.state

    // session.inputSources is an XRInputSourceArray, not a real Array -- it's
    // only guaranteed indexed access + length, so Array.prototype methods like
    // .indexOf aren't safe to call on it directly (throws on some browsers).
    const sources = session.inputSources
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
      const src = sources[sourceIndex]
      const hand = src.handedness
      if (hand !== 'left' && hand !== 'right') continue
      const gp = src.gamepad
      if (!gp) continue
      this.state.connected++

      const side = this.state[hand]
      side.source = src
      side.sourceIndex = sourceIndex
      side.axes = [gp.axes[2] ?? 0, gp.axes[3] ?? 0]

      const prev = this.prev[hand]
      for (const [name, idx] of Object.entries(BTN)) {
        const pressed = !!gp.buttons[idx]?.pressed
        side.buttons[name] = {
          pressed,
          justPressed: pressed && !prev[name],
        }
        prev[name] = pressed
      }
    }
    return this.state
  }
}
