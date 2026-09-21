import { generate } from './generate.js'

// The generator off the main thread -- §31. One message in ({ seed, n, tune }), log lines out as they happen, then the result with its field transferred rather than copied.
self.onmessage = (e) => {
  const { seed, n, tune } = e.data
  try {
    const r = generate({ seed, n, tune, log: (line) => self.postMessage({ type: 'log', line }) })
    self.postMessage({ type: 'done', result: r }, [r.height.buffer, r.ground.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message, stack: err.stack })
  }
}
