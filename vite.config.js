import { dirname, join, relative, resolve } from 'node:path'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// --- the prop originals index (dev only) ------------------------------------
//
// props.html can show what the pipeline BUILT. Deciding whether a bad-looking
// prop is worth another pass needs the other half: what went in. Those sources
// live in `tmp/`, which is gitignored on purpose -- a 120 MB photoscan FBX has
// no business in the repo -- and they stay there. Vite's dev server already
// serves the whole project root, so `/tmp/<path>` streams the original bytes to
// the browser with no copy into `public/` and nothing new to commit.
//
// Two things the browser cannot do for itself, which is all this endpoint is:
//
//   Say whether a source is still on disk. A missing file under the dev server
//   comes back 200 with index.html in it (the SPA fallback), so a fetch cannot
//   tell "gone" from "here" without parsing the answer -- and 133 of the 154
//   sources ARE gone: the Quaternius pack was deleted from tmp/ after the build.
//
//   Find the texture files. `tools/props/manifest.json` names the loose maps for
//   the Megascans scans, and everything else keeps its maps in a sibling folder
//   the FBX does not point at correctly. This indexes images by basename the way
//   `resolve_missing_images` in build.py does -- widening outward one directory
//   at a time and stopping at the first level that has any -- so the loader can
//   re-point a texture the source names at the author's old C: drive.
//
// `apply: 'serve'` because none of this exists in a build: the deployed props
// page shows the library and says the originals need the dev server.
const IMAGE_EXT = /\.(png|jpe?g|tga|tiff?|webp|exr)$/i

function indexImages(startDir, root) {
  const found = {}
  let budget = 2000 // directory entries, total -- a widened search must not walk the whole pack tree
  const walk = (dir, depth) => {
    if (depth > 2 || budget <= 0) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (budget-- <= 0) return
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1)
      else if (IMAGE_EXT.test(e.name) && !(e.name.toLowerCase() in found)) {
        const abs = join(dir, e.name)
        found[e.name.toLowerCase()] = { path: relative(root, abs), bytes: statSync(abs).size }
      }
    }
  }
  let from = null
  for (let dir = startDir, up = 0; up < 3; up++, dir = dirname(dir)) {
    if (!dir.startsWith(root) || isCollection(dir)) break
    walk(dir, 0)
    if (Object.keys(found).length) { from = relative(root, dir); break } // first level with any images wins, per build.py
  }
  return { images: found, from }
}

// Where widening has to stop. One directory up from `_x/bush-test/source` is the
// pack, but two is `_x/` itself -- two dozen unrelated packs -- and a basename
// match across that would quietly dress the bush in the windmill's textures.
// A pack folder holds a `source/` and maybe a `textures/`; a collection holds
// one entry per asset, so the count separates them without hardcoding a name.
function isCollection(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length > 4
  } catch {
    return true
  }
}

// The generated trees (`gen_*`) carry `tiers` instead of `src`: they have no
// source file to show, their LOD0 GLB *is* the original, and the page already
// shows that. Anything without a `src` is simply not in the index.
function indexSources(root) {
  const spec = JSON.parse(readFileSync(resolve(root, 'tools/props/manifest.json'), 'utf8'))
  const assets = {}
  for (const a of spec.assets) {
    if (!a.src) continue
    const abs = resolve(root, a.src)
    const st = statSync(abs, { throwIfNoEntry: false })
    const found = st ? indexImages(dirname(abs), root) : { images: {}, from: null }
    assets[a.id] = {
      src: a.src,
      exists: Boolean(st),
      bytes: st?.size ?? 0,
      base_color_map: a.base_color_map ?? null,
      opacity_map: a.opacity_map ?? null,
      base_color: a.base_color ?? null,
      rotate_x_deg: a.rotate_x_deg ?? null,
      images: found.images,
      images_dir: found.from,
    }
  }
  return assets
}

function propOriginals() {
  return {
    name: 'aurora:prop-originals',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root
      server.middlewares.use('/__prop-originals', (req, res) => {
        res.setHeader('content-type', 'application/json')
        try {
          res.end(JSON.stringify({ assets: indexSources(root) }))
        } catch (e) {
          // Answer JSON even on the way down. Letting this throw gives Vite's
          // HTML error page, which the page cannot tell apart from "served from
          // a build, there are no originals here" -- so a real bug in here would
          // show up as a calm and completely wrong explanation.
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.stack ?? e) }))
        }
      })
    },
  }
}


// --- the v2 world document, written back to disk (dev only) -----------------
//
// The §18 editor authors content layers -- snow line points, lakes, rivers,
// roads -- and they are worth nothing if they live only in the browser. They
// autosave to localStorage, which survives a reload but not a machine, is
// invisible to git, and cannot be diffed when a river moves.
//
// The document is kilobytes of JSON by construction (§18's two-representation
// rule: stored parametric, runtime baked), so the cheapest possible thing is
// also the right one -- POST it and write the file. `apply: 'serve'` because a
// deployed build has no filesystem to write to and the panel falls back to its
// Export button there.
//
// The path is fixed rather than taken from the request. A dev server bound to
// `host: true` is reachable from the LAN, and an endpoint that writes to a
// caller-supplied path is an arbitrary file write to anyone on the wifi.
function worldDoc() {
  return {
    name: 'aurora:world-doc',
    apply: 'serve',
    configureServer(server) {
      const file = resolve(server.config.root, 'public/world/layers.json')
      server.middlewares.use('/__world', (req, res) => {
        res.setHeader('content-type', 'application/json')
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'POST only' }))
          return
        }
        const chunks = []
        let bytes = 0
        req.on('data', (c) => {
          bytes += c.length
          // A world document that is megabytes long means the two-representation
          // rule has been broken somewhere upstream -- something is storing baked
          // data instead of parameters. Refusing it here is how that gets noticed.
          if (bytes > 4 << 20) req.destroy(new Error('world document over 4 MB'))
          chunks.push(c)
        })
        req.on('error', (e) => {
          res.statusCode = 413
          res.end(JSON.stringify({ error: String(e?.message ?? e) }))
        })
        req.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8')
            JSON.parse(text) // parse before writing, so a bad body cannot truncate a good file
            mkdirSync(dirname(file), { recursive: true })
            writeFileSync(file, text)
            res.end(JSON.stringify({ ok: true, path: relative(server.config.root, file), bytes: text.length }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(e?.stack ?? e) }))
          }
        })
      })
    },
  }
}

// --- /v2 as a route rather than a filename (dev only) -----------------------
//
// §18 asks for a "/v2 route", and without this there is not one. `v2.html` is a
// rollup input, so `/v2.html` works -- but a bare `/v2` misses on disk and falls
// into vite's SPA fallback, which answers index.html. That is the WRONG page
// served with a 200, so the failure looks like "v2 renders the v1 world" rather
// than like a missing route.
//
// Registered in the body of configureServer, not in the returned post-hook, so
// it rewrites the URL before vite's own html middleware and fallback see it.
function v2Route() {
  return {
    name: 'aurora:v2-route',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = req.url.split('?')[0]
        if (path === '/v2' || path === '/v2/') req.url = `/v2.html${req.url.slice(path.length)}`
        next()
      })
    },
  }
}

// WebXR requires a secure context. Three ways to get one on the Quest:
//
//   1. `npm run dev` -> https://<your-lan-ip>:5173 (self-signed; Quest Browser will
//      show a warning you must click through: "Advanced" -> "Proceed").
//   2. USB + developer mode, then `adb reverse tcp:5173 tcp:5173` and open
//      http://localhost:5173 on the headset. localhost counts as a secure context,
//      so there is no cert warning. Cleanest dev loop if you have a cable.
//   3. `npm run build` and deploy dist/ to GitHub Pages.
//
// `base` is relative so the built output works from any subpath, including
// topherhunt.com/games/aurora.
// Four pages: index.html is the game, spike.html is the §0 measurement harness
// (which still has unread numbers on it and stays deployed alongside), map.html
// is the §14 step 3 Phase A map view -- the only place the global pass can be
// inspected whole, and the "eye" that every "tune it by eye" constant in
// phase-a.js refers to -- and props.html is the same kind of eye for the §9
// asset library: 160 built props that check-props.mjs can assert are correct and
// nothing could actually show you. gen-fern.html, gen-tree.html and
// gen-building.html are the tuning benches for the procedural content
// (src/props/fern.js, tree.js, src/buildings/), which has no built asset to
// inspect -- the "library" for a generated asset is the range its parameters
// cover, and the only way to see a range is to put twenty seeds side by side.
export default defineConfig({
  base: './',
  plugins: [basicSsl(), propOriginals(), worldDoc(), v2Route()],
  server: { host: true, port: 5173 },
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        spike: resolve(__dirname, 'spike.html'),
        map: resolve(__dirname, 'map.html'),
        props: resolve(__dirname, 'props.html'),
        genFern: resolve(__dirname, 'gen-fern.html'),
        genTree: resolve(__dirname, 'gen-tree.html'),
        genBuilding: resolve(__dirname, 'gen-building.html'),
        // §18. The alternative world: coarse shape imported from an image, fine
        // shape procedural down to 10 cm, and everything a human wants to place
        // by hand authored as a content layer on top. Shares the coordinate box
        // with index.html and nothing else.
        v2: resolve(__dirname, 'v2.html'),
      },
    },
  },
})
