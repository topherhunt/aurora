import { runPhaseA } from './phase-a.js'
import { bakeHorizon } from './horizon.js'

// Phase A off the main thread. §2 says this pass runs in a Web Worker at load,
// so the map view exercises the real arrangement rather than a convenient one --
// if the result turns out not to be structured-cloneable, this is where that
// gets discovered, not on the headset.
self.onmessage = (e) => {
  const { seed, n } = e.data
  try {
    const result = runPhaseA(seed, n, (line) => self.postMessage({ type: 'log', line }))

    // The horizon bake rides along on Phase A's elevation grid rather than
    // sampling its own. That grid cost 1.05M heightAt calls and about four
    // seconds; asking for it a second time would double the load screen for an
    // array that is already sitting right here.
    //
    // `elev` and not `base`: `base` is the raw analytic surface, `elev` is the
    // carved one after breaching, and the carved one is what the terrain mesh
    // actually reproduces (§2). Shadows have to be cast by the geometry she can
    // see, or a breached gorge would still be shaded by the ridge that used to
    // be across it.
    const t = performance.now()
    const { horizon, sky } = bakeHorizon(result.elev, result.n, result.cell)
    self.postMessage({ type: 'log', line: `horizon map    ${`${(performance.now() - t).toFixed(0)}ms`.padStart(7)}  ${result.n}^2 x 16 azimuths` })
    result.horizon = horizon
    result.skyView = sky

    // Transferred, not copied. These two are 17 MB between them and the worker
    // has no further use for either; a structured clone of that is a visible
    // hitch at the end of a load screen that is already long enough.
    self.postMessage({ type: 'done', result }, [horizon.buffer, sky.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message, stack: err.stack })
  }
}
