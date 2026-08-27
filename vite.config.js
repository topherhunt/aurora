import { dirname, join, relative, resolve } from 'node:path'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { decodePng } from './src/v2/height/png.js'
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

// --- the v2 heightmap, written back to disk (dev only) ----------------------
//
// The terrain brush (src/v2/height/sculpt.js) is the one editor tool that
// changes the IMPORT rather than the document, so Save has a second half: the
// sculpted texels go back to public/world/height.png, the file
// scripts/make-heightmap.mjs baked and every boot loads.
//
// THIS ENDPOINT OVERWRITES A COMMITTED ASSET, which is a heavier act than
// /__world's, so it verifies rather than trusts. The body is decoded with the
// same decoder the browser loads the world through, and the result must match
// world/height.json's own `size` and be RGB8 -- the rg16 encoding. A truncated
// upload, a half-written stream, or a browser that quietly handed back a
// re-encoded canvas image all fail here, at the cost of one inflate, rather than
// on the next boot with the world already flattened.
//
// It changes ONE field of height.json: `sculpted`. Everything else there still
// describes this file correctly -- the metres are recovered through minY/maxY
// and the brush clamps to exactly that range (see sculpt.js) -- but the PNG is
// no longer only what the bake produced, and make-heightmap.mjs refuses to
// overwrite it without --force on the strength of that one flag. Without it, a
// re-bake would replace an afternoon of sculpting with the JPEG and say nothing.
//
// Same fixed path and `apply: 'serve'` as /__world, and for the same reason: a
// dev server on `host: true` is on the LAN, and a caller-supplied path here
// would be an arbitrary file write to anyone on the wifi.
function worldHeight() {
  return {
    name: 'aurora:world-height',
    apply: 'serve',
    configureServer(server) {
      const file = resolve(server.config.root, 'public/world/height.png')
      const metaFile = resolve(server.config.root, 'public/world/height.json')
      server.middlewares.use('/__height', (req, res) => {
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
          // 1024^2 RGB8 is 3 MB raw and deflates to about 1.3 MB. 8 MB is room
          // for a much larger import without being room for a mistake.
          if (bytes > 8 << 20) req.destroy(new Error('heightmap over 8 MB'))
          chunks.push(c)
        })
        req.on('error', (e) => {
          res.statusCode = 413
          res.end(JSON.stringify({ error: String(e?.message ?? e) }))
        })
        req.on('end', async () => {
          try {
            const buf = Buffer.concat(chunks)
            const png = await decodePng(new Uint8Array(buf))
            const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
            if (png.width !== meta.size || png.height !== meta.size) {
              throw new Error(`heightmap is ${png.width}x${png.height}, but world/height.json says ${meta.size}x${meta.size}`)
            }
            if (png.channels !== 3 || png.depth !== 8) {
              throw new Error(`heightmap is ${png.channels}x${png.depth}-bit, but the rg16 encoding is RGB8`)
            }
            writeFileSync(file, buf)
            if (meta.sculpted !== true) {
              meta.sculpted = true
              writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n')
            }
            res.end(JSON.stringify({ ok: true, path: relative(server.config.root, file), bytes: buf.length }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(e?.stack ?? e) }))
          }
        })
      })
    },
  }
}

// --- bare paths as routes rather than filenames (dev only) ------------------
//
// §18 asks for a "/v2 route", and gen-rock was asked for as "/gen-rock". Without
// this there is neither. `v2.html` is a rollup input, so `/v2.html` works -- but
// a bare `/v2` misses on disk and falls into vite's SPA fallback, which answers
// index.html. That is the WRONG page served with a 200, so the failure looks
// like "v2 renders the v1 world" rather than like a missing route.
//
// A list rather than a blanket "append .html to anything that misses": the
// fallback is what makes a genuine 404 look like a working page, and widening
// the rewrite to every miss would spread that failure mode rather than fix it.
//
// Registered in the body of configureServer, not in the returned post-hook, so
// it rewrites the URL before vite's own html middleware and fallback see it.
const BARE_ROUTES = ['v2', 'v2-new-grass', 'gen-rock', 'gen-fern', 'gen-tree', 'gen-deadwood', 'gen-mushroom', 'gen-building', 'gen-building-v2', 'test-aurora', 'test-aurora-v2']

function bareRoutes() {
  return {
    name: 'aurora:bare-routes',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = req.url.split('?')[0]
        const name = path.replace(/^\/|\/$/g, '')
        if (BARE_ROUTES.includes(name)) req.url = `/${name}.html${req.url.slice(path.length)}`
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
// nothing could actually show you. gen-fern.html, gen-tree.html, gen-rock.html,
// gen-deadwood.html and gen-building.html (with gen-building-v2.html beside it)
// are the tuning benches for the procedural content
// (src/props/fern.js, tree.js, rock.js, deadwood.js, src/buildings/), which has no built asset to
// inspect -- the "library" for a generated asset is the range its parameters
// cover, and the only way to see a range is to put twenty seeds side by side.
export default defineConfig({
  base: './',
  plugins: [basicSsl(), propOriginals(), worldDoc(), worldHeight(), bareRoutes()],
  // HMR IS OFF ON PURPOSE, and the refresh is yours: Cmd-R.
  //
  // None of these pages accepts a hot update -- there is no `import.meta.hot`
  // anywhere in src/ -- so every save turned into a full page reload. That is
  // fine when the person editing and the person looking are the same person. It
  // is not fine here: agents write files while the world is being walked
  // through, and a reload throws away the camera, the flying/walking state, the
  // selection, and any edit not yet saved to localStorage. Losing your place
  // mid-flight to someone else's save is worse than pressing a key.
  //
  // `false` disables the HMR websocket entirely, so the dev server never pushes
  // anything to an open tab. Files are still WATCHED -- the module graph is
  // invalidated on save, which is what makes the next manual reload serve the
  // new code rather than a cached transform. It also takes the error overlay
  // with it, since that arrives over the same socket; a syntax error now shows
  // up in the console on reload instead of as a red panel.
  //
  // Set `hmr: true` to get the old behaviour back.
  server: { host: true, port: 5173, hmr: false },
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
        // The rock bench, served at /gen-rock. Its job is narrower than the
        // others': the tree and fern generators ship a settled bank, this one is
        // still choosing which variants the world gets, and PRESETS in
        // src/gen-rock-main.js is where that choice is being written down.
        genRock: resolve(__dirname, 'gen-rock.html'),
        // The deadwood bench, served at /gen-deadwood. The two props that are
        // not trees and not rocks: a broken-off snag and a fallen log. It is
        // also where the moss and snow recipe on WOOD gets judged, since dead
        // wood is the first thing in the world that wears both.
        genDeadwood: resolve(__dirname, 'gen-deadwood.html'),
        // The mushroom bench, served at /gen-mushroom. The only generator whose
        // texture is code rather than a photograph (src/props/mushroom-texture.js),
        // so the bench is also the only place the sheets can be looked at.
        genMushroom: resolve(__dirname, 'gen-mushroom.html'),
        genBuilding: resolve(__dirname, 'gen-building.html'),
        // v2 of the same bench. Kept alongside v1 rather than replacing it: the
        // question v2 asks is "how crooked is too crooked", and the only honest
        // answer is the straight version standing next to it.
        genBuildingV2: resolve(__dirname, 'gen-building-v2.html'),
        // §18. The alternative world: coarse shape imported from an image, fine
        // shape procedural down to 10 cm, and everything a human wants to place
        // by hand authored as a content layer on top. Shares the coordinate box
        // with index.html and nothing else.
        v2: resolve(__dirname, 'v2.html'),
        // The grass bench, served at /v2-new-grass. Not a mode inside v2: the
        // comparison it exists to make is between two carpets on one hill under
        // one light, and it needs its own world -- GPU-placed blades out to
        // 72 m and a ground material that IS the grass past it -- standing
        // beside the shipped scatter's measured numbers rather than replacing
        // it. See the header of src/newgrass/grass-field.js.
        v2NewGrass: resolve(__dirname, 'v2-new-grass.html'),
        // The aurora shader lab, served at /test-aurora. A separate page rather
        // than a mode inside v2 for the same reason the grass bench is: what it
        // needs is an empty sky over a nominal skyline and sixty sliders, and
        // putting that behind a terrain load, a document fetch and a walk to a
        // vantage point would mean paying all three every time you want to see
        // what one exponent does. It is also the only page whose whole content
        // is one quad, which is what makes it honest about the shader's cost.
        // See the header of src/aurora-lab/glsl/frame.js.
        testAurora: resolve(__dirname, 'test-aurora.html'),
        testAuroraV2: resolve(__dirname, 'test-aurora-v2.html'),
      },
    },
  },
})
