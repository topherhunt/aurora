import { runPhaseA } from './phase-a.js'

// Phase A off the main thread. §2 says this pass runs in a Web Worker at load,
// so the map view exercises the real arrangement rather than a convenient one --
// if the result turns out not to be structured-cloneable, this is where that
// gets discovered, not on the headset.
self.onmessage = (e) => {
  const { seed, n } = e.data
  try {
    const result = runPhaseA(seed, n, (line) => self.postMessage({ type: 'log', line }))
    self.postMessage({ type: 'done', result })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message, stack: err.stack })
  }
}
