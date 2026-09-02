import { dirname, join, relative, resolve } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import { decodePng } from './src/v2/height/png.js'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { generateImage } from './tools/characters/openrouter.mjs'
import { buildViewPrompt } from './tools/characters/sheet-prompt.mjs'
import { generateCharacter } from './tools/characters/generate-character.mjs'
import { decodeSheet, keyBackground, silhouetteProfile, columnProfile, cropToFigure } from './tools/characters/chromakey.mjs'
import { encodePng } from './tools/props/png.mjs'
import { buildFishPrompt } from './tools/fauna/fish-prompt.mjs'
import { buildFishMesh } from './tools/fauna/loft-fish-mesh.mjs'
import { SPECIES as FISH_SPECIES } from './tools/fauna/fish-roster.mjs'
import { buildCreaturePrompt } from './tools/creatures/creature-prompt.mjs'
import { CREATURES } from './tools/creatures/creature-roster.mjs'
import { estimateCredits as tripoCredits, PRESETS as TRIPO_PRESETS } from './tools/creatures/tripo.mjs'
import * as creatures from './tools/creatures/workspace.mjs'

// Vite loads .env into import.meta.env for client bundles, but NOT into
// process.env for its own config/plugin code -- openrouter.mjs reads
// process.env.OPENROUTER_API_KEY directly (a plain Node script also imports
// it, with no Vite involved at all), so pull it in explicitly here.
if (!process.env.OPENROUTER_API_KEY) {
  process.env.OPENROUTER_API_KEY = loadEnv('development', process.cwd(), 'OPENROUTER_API_KEY').OPENROUTER_API_KEY
}
if (!process.env.TRIPO_API_KEY) {
  process.env.TRIPO_API_KEY = loadEnv('development', process.cwd(), 'TRIPO_API_KEY').TRIPO_API_KEY
}

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

// --- character tuning benches: save tuned params back to disk (dev only) ----
//
// gen-anim.html tunes tools/characters/animations.mjs's per-clip parameters
// live and needs them to land in the checked-in tools/characters/animations.json
// (generate-character.mjs reads that file, falling back to animations.mjs's
// own DEFAULT_PARAMS when it's absent) so a batch run picks up the tuning.
// gen-character.html adjusts one character's bone offsets and writes a
// rig-override.json next to that character's own GLBs.
//
// The rig-override route takes an `id` from the request, unlike /__world and
// /__height's fixed paths, so it validates against an existing character
// directory first -- an unchecked id would be an arbitrary file write to
// anyone on the wifi, same risk /__world's fixed path was written to avoid.
function charactersSave() {
  const readBody = (req, maxBytes) => new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', (c) => {
      bytes += c.length
      if (bytes > maxBytes) req.destroy(new Error(`body over ${maxBytes} bytes`))
      chunks.push(c)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
  return {
    name: 'aurora:characters-save',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root
      const animFile = resolve(root, 'tools/characters/animations.json')
      server.middlewares.use('/__animations', (req, res) => {
        res.setHeader('content-type', 'application/json')
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return }
        readBody(req, 1 << 16).then((text) => {
          JSON.parse(text) // parse before writing, so a bad body cannot truncate a good file
          writeFileSync(animFile, text)
          res.end(JSON.stringify({ ok: true, path: relative(root, animFile) }))
        }).catch((e) => { res.statusCode = 400; res.end(JSON.stringify({ error: String(e?.message ?? e) })) })
      })
      server.middlewares.use('/__character-rig', (req, res) => {
        res.setHeader('content-type', 'application/json')
        const id = new URL(req.url, 'http://x').searchParams.get('id') || ''
        const dir = resolve(root, 'public/characters', id)
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return }
        if (!/^[a-z0-9-]+$/.test(id) || !existsSync(resolve(dir, 'lod0.glb'))) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: `no character "${id}"` }))
          return
        }
        readBody(req, 1 << 16).then((text) => {
          JSON.parse(text)
          const file = resolve(dir, 'rig-override.json')
          writeFileSync(file, text)
          res.end(JSON.stringify({ ok: true, path: relative(root, file) }))
        }).catch((e) => { res.statusCode = 400; res.end(JSON.stringify({ error: String(e?.message ?? e) })) })
      })
    },
  }
}

// --- character sheet image generation (dev only) -----------------------------
//
// gen-sheet.html's reroll/preview/pick bench. Two of these three endpoints
// are pure local file I/O and free; only /__generate-sheet-view spends real
// money (one OpenRouter call per request), and it fires exclusively when the
// bench's "generate" button is clicked -- this file never calls it in a loop
// or on its own initiative. Consistency across the front/side/back views
// comes from attaching the already-picked front.png as an image-edit
// reference (openrouter.mjs's `referenceImages`) when generating the other two.
function sheetGen() {
  const readBody = (req, maxBytes) => new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', (c) => {
      bytes += c.length
      if (bytes > maxBytes) req.destroy(new Error(`body over ${maxBytes} bytes`))
      chunks.push(c)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

  return {
    name: 'aurora:sheet-gen',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root
      const sheetsDir = (id) => resolve(root, 'tools/characters/sheets', id)

      server.middlewares.use('/__generate-sheet-view', (req, res) => {
        res.setHeader('content-type', 'application/json')
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return }
        readBody(req, 1 << 16).then(async (text) => {
          const { id, view, vars, seed, useReference } = JSON.parse(text)
          if (!/^[a-z0-9-]+$/.test(id || '')) throw new Error(`invalid character id "${id}"`)
          const prompt = buildViewPrompt(view, vars)
          let referenceImages
          if (useReference) {
            const refPath = resolve(sheetsDir(id), 'front.png')
            if (!existsSync(refPath)) throw new Error(`no saved front.png for "${id}" yet -- generate and pick a front view first`)
            referenceImages = [readFileSync(refPath)]
          }
          const { buffer, cost } = await generateImage({ prompt, seed, referenceImages })
          res.end(JSON.stringify({ ok: true, imageB64: buffer.toString('base64'), cost }))
        }).catch((e) => { res.statusCode = 400; res.end(JSON.stringify({ error: String(e?.message ?? e) })) })
      })

      // Zero-cost local write: persists a picked candidate so it survives a
      // reload and becomes generate-character.mjs's sheetDir input directly.
      server.middlewares.use('/__save-sheet-view', (req, res) => {
        res.setHeader('content-type', 'application/json')
        const q = new URL(req.url, 'http://x').searchParams
        const id = q.get('id') || ''
        const view = q.get('view') || ''
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return }
        if (!/^[a-z0-9-]+$/.test(id) || !['front', 'side', 'back'].includes(view)) {
          res.statusCode = 400; res.end(JSON.stringify({ error: `invalid id "${id}" or view "${view}"` })); return
        }
        readBody(req, 1 << 24).then((text) => {
          const { imageB64 } = JSON.parse(text)
          const dir = sheetsDir(id)
          mkdirSync(dir, { recursive: true })
          const file = resolve(dir, `${view}.png`)
          const buf = Buffer.from(imageB64, 'base64')
          writeFileSync(file, buf)

          // Record WHICH candidate this was, by filename, not by the bytes we
          // just wrote -- a later pass (alpha-sheets.mjs) rewrites <view>.png
          // in place (adds an alpha channel), which would silently break a
          // byte-equality "picked" check on every future read. Comparing here,
          // at save time, is the last point the saved file is guaranteed
          // byte-identical to the candidate it came from.
          const manifestFile = resolve(dir, 'candidates.json')
          const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {}
          const entries = manifest[view] || []
          const match = entries.find((e) => {
            try { return readFileSync(resolve(dir, 'candidates', e.file)).equals(buf) } catch { return false }
          })
          manifest.picked = manifest.picked || {}
          manifest.picked[view] = match ? match.file : null
          writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))

          res.end(JSON.stringify({ ok: true, path: relative(root, file) }))
        }).catch((e) => { res.statusCode = 400; res.end(JSON.stringify({ error: String(e?.message ?? e) })) })
      })

      // Lists candidates batch-sheets.mjs already generated on disk for one
      // character/view, so gen-sheet.html can load them into its existing
      // gallery/pick UI instead of only showing what was just live-generated.
      server.middlewares.use('/__sheet-candidates', (req, res) => {
        res.setHeader('content-type', 'application/json')
        const q = new URL(req.url, 'http://x').searchParams
        const id = q.get('id') || ''
        const view = q.get('view') || ''
        if (!/^[a-z0-9-]+$/.test(id) || !['front', 'side', 'back'].includes(view)) {
          res.statusCode = 400; res.end(JSON.stringify({ error: `invalid id "${id}" or view "${view}"` })); return
        }
        const manifestFile = resolve(sheetsDir(id), 'candidates.json')
        const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {}
        const entries = manifest[view] || []
        // "picked" is the candidate filename /__save-sheet-view recorded at
        // save time (manifest.picked[view]) -- not a byte comparison against
        // the current <view>.png, which alpha-sheets.mjs mutates in place.
        const pickedFilename = manifest.picked?.[view]
        const candidates = entries.map((e) => {
          const buf = readFileSync(resolve(sheetsDir(id), 'candidates', e.file))
          return { imageB64: buf.toString('base64'), cost: e.cost, picked: e.file === pickedFilename }
        })
        res.end(JSON.stringify({ ok: true, candidates }))
      })

      // Reference image for the current pick (e.g. the picked front, shown
      // alongside side/back candidates so they can be compared side by side).
      server.middlewares.use('/__sheet-view', (req, res) => {
        res.setHeader('content-type', 'application/json')
        const q = new URL(req.url, 'http://x').searchParams
        const id = q.get('id') || ''
        const view = q.get('view') || ''
        if (!/^[a-z0-9-]+$/.test(id) || !['front', 'side', 'back'].includes(view)) {
          res.statusCode = 400; res.end(JSON.stringify({ error: `invalid id "${id}" or view "${view}"` })); return
        }
        const file = resolve(sheetsDir(id), `${view}.png`)
        if (!existsSync(file)) { res.end(JSON.stringify({ ok: true, exists: false })); return }
        res.end(JSON.stringify({ ok: true, exists: true, imageB64: readFileSync(file).toString('base64') }))
      })

      // gen-character.html's reference-plane overlay: the picked (already
      // alpha-keyed) view, cropped tight to the figure and sized in world
      // metres, so the bench can place it as a card the skeleton's own
      // metre-scale bone positions land on directly -- no guessing at the
      // sheet's empty margin above the head or below the feet.
      server.middlewares.use('/__sheet-reference', (req, res) => {
        res.setHeader('content-type', 'application/json')
        const q = new URL(req.url, 'http://x').searchParams
        const id = q.get('id') || ''
        const view = q.get('view') || ''
        if (!/^[a-z0-9-]+$/.test(id) || !['front', 'side', 'back'].includes(view)) {
          res.statusCode = 400; res.end(JSON.stringify({ error: `invalid id "${id}" or view "${view}"` })); return
        }
        const file = resolve(sheetsDir(id), `${view}.png`)
        if (!existsSync(file)) { res.end(JSON.stringify({ ok: true, exists: false })); return }
        try {
          const { characters } = JSON.parse(readFileSync(resolve(root, 'tools/characters/characters.json'), 'utf8'))
          // heightM is only needed to report a real-metre size (gen-character.html's
          // reference planes) -- gen-sheet.html's alpha-preview just wants the
          // cropped image and works fine for a freeform id that isn't in the
          // roster yet, so a missing character isn't an error here.
          const character = characters.find((c) => c.id === id)
          const decoded = decodeSheet(file)
          const alpha = keyBackground(decoded)
          const profile = silhouetteProfile(alpha, decoded.w, decoded.h)
          const crop = cropToFigure(decoded, alpha, profile)
          const png = encodePng(crop.w, crop.h, crop.rgba, 4)
          const out = { ok: true, exists: true, imageB64: png.toString('base64') }
          if (character) {
            const pixelsPerMeter = (profile.bottom - profile.top) / character.heightM
            out.worldWidthM = crop.w / pixelsPerMeter
            out.worldHeightM = crop.h / pixelsPerMeter
          }
          res.end(JSON.stringify(out))
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: String(e?.message ?? e) }))
        }
      })

      // Closes the loop: once all three views are picked, bake straight into
      // public/characters/<id>/ with the already-built mesh/rig/texture/anim
      // pipeline -- no separate CLI step needed from the bench.
      server.middlewares.use('/__bake-character', (req, res) => {
        res.setHeader('content-type', 'application/json')
        const q = new URL(req.url, 'http://x').searchParams
        const id = q.get('id') || ''
        const heightM = Number(q.get('heightM') || '1.7')
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return }
        if (!/^[a-z0-9-]+$/.test(id)) { res.statusCode = 400; res.end(JSON.stringify({ error: `invalid id "${id}"` })); return }
        const dir = sheetsDir(id)
        for (const view of ['front', 'side', 'back']) {
          if (!existsSync(resolve(dir, `${view}.png`))) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: `missing ${view}.png for "${id}" -- pick all three views first` }))
            return
          }
        }
        try {
          const outDir = resolve(root, 'public/characters', id)
          const r = generateCharacter({ id, sheetDir: dir, outDir, heightM })
          res.end(JSON.stringify({ ok: true, results: r.results, billboard: r.billboard }))
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: String(e?.message ?? e) }))
        }
      })
    },
  }
}

// --- fish sheet image generation (dev only) ----------------------------------
//
// gen-fish.html's reroll/preview/pick bench -- the same shape as sheetGen()
// above, cut down to fish's one view (side) and no reference-image chaining
// (a character needs front/side/back to agree with each other; a fish sprite
// is judged whole from a single profile image, so there is nothing for a
// second generation to stay consistent with). Only /__generate-fish-view
// spends real money; the rest is local file I/O.
function fishGen() {
  const readBody = (req, maxBytes) => new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', (c) => {
      bytes += c.length
      if (bytes > maxBytes) req.destroy(new Error(`body over ${maxBytes} bytes`))
      chunks.push(c)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

  return {
    name: 'aurora:fish-gen',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root
      const sheetsDir = (id) => resolve(root, 'tools/fauna/sheets', id)

      server.middlewares.use('/__generate-fish-view', (req, res) => {
        res.setHeader('content-type', 'application/json')
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return }
        readBody(req, 1 << 16).then(async (text) => {
          const { id, description, seed } = JSON.parse(text)
          if (!/^[a-z0-9-]+$/.test(id || '')) throw new Error(`invalid fish id "${id}"`)
          const prompt = buildFishPrompt(description)
          const { buffer, cost } = await generateImage({ prompt, aspectRatio: '16:9', seed })
          res.end(JSON.stringify({ ok: true, imageB64: buffer.toString('base64'), cost }))
        }).catch((e) => { res.statusCode = 400; res.end(JSON.stringify({ error: String(e?.message ?? e) })) })
      })

      // Zero-cost local write: persists a picked candidate as side.png so it
      // survives a reload.
      server.middlewares.use('/__save-fish-view', (req, res) => {
        res.setHeader('content-type', 'application/json')
        const q = new URL(req.url, 'http://x').searchParams
        const id = q.get('id') || ''
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return }
        if (!/^[a-z0-9-]+$/.test(id)) { res.statusCode = 400; res.end(JSON.stringify({ error: `invalid id "${id}"` })); return }
        readBody(req, 1 << 24).then((text) => {
          const { imageB64 } = JSON.parse(text)
          const dir = sheetsDir(id)
          mkdirSync(dir, { recursive: true })
          const file = resolve(dir, 'side.png')
          const buf = Buffer.from(imageB64, 'base64')
          writeFileSync(file, buf)

          const manifestFile = resolve(dir, 'candidates.json')
          const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {}
          const entries = manifest.side || []
          const match = entries.find((e) => {
            try { return readFileSync(resolve(dir, 'candidates', e.file)).equals(buf) } catch { return false }
          })
          manifest.picked = match ? match.file : null
          writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))

          res.end(JSON.stringify({ ok: true, path: relative(root, file) }))
        }).catch((e) => { res.statusCode = 400; res.end(JSON.stringify({ error: String(e?.message ?? e) })) })
      })

      // Lists candidates already on disk (from a live "generate" click, saved
      // below, or from a future batch script) for one fish id.
      server.middlewares.use('/__fish-candidates', (req, res) => {
        res.setHeader('content-type', 'application/json')
        const q = new URL(req.url, 'http://x').searchParams
        const id = q.get('id') || ''
        if (!/^[a-z0-9-]+$/.test(id)) { res.statusCode = 400; res.end(JSON.stringify({ error: `invalid id "${id}"` })); return }
        const manifestFile = resolve(sheetsDir(id), 'candidates.json')
        const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {}
        const entries = manifest.side || []
        const candidates = entries.map((e) => {
          const buf = readFileSync(resolve(sheetsDir(id), 'candidates', e.file))
          return { imageB64: buf.toString('base64'), cost: e.cost, picked: e.file === manifest.picked }
        })
        res.end(JSON.stringify({ ok: true, candidates }))
      })

      // Alpha-keyed, tight-cropped picked view -- same chromakey pipeline as
      // gen-sheet.html's /__sheet-reference, used here for the tint-preview
      // panel (natural color, alpha-keyed cutout; the panel re-hues it live
      // via CSS hue-rotate for per-individual variation). closeRadius: 4
      // is the fish-specific difference from the character pipeline -- a fish
      // sprite has no consumer that needs its real gaps (fin-ray slivers,
      // open mouth) to stay open the way loft-mesh.mjs needs a character's leg
      // gap to, so it reads better keyed as one fully solid silhouette. It
      // also rescues a species painted close to the magenta key itself (e.g.
      // Glimmerfin's purple scales) from losing chunks of its own body to the
      // key -- see chromakey.mjs's keepEnclosedRegions header.
      server.middlewares.use('/__fish-reference', (req, res) => {
        res.setHeader('content-type', 'application/json')
        const q = new URL(req.url, 'http://x').searchParams
        const id = q.get('id') || ''
        if (!/^[a-z0-9-]+$/.test(id)) { res.statusCode = 400; res.end(JSON.stringify({ error: `invalid id "${id}"` })); return }
        const file = resolve(sheetsDir(id), 'side.png')
        if (!existsSync(file)) { res.end(JSON.stringify({ ok: true, exists: false })); return }
        try {
          const decoded = decodeSheet(file)
          const alpha = keyBackground(decoded, { closeRadius: 4 })
          const profile = silhouetteProfile(alpha, decoded.w, decoded.h)
          const crop = cropToFigure(decoded, alpha, profile)
          const png = encodePng(crop.w, crop.h, crop.rgba, 4)
          res.end(JSON.stringify({ ok: true, exists: true, imageB64: png.toString('base64') }))
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: String(e?.message ?? e) }))
        }
      })

      // Low-poly swim-ready mesh for the picked side view -- see
      // tools/fauna/loft-fish-mesh.mjs's header for the contour-loft +
      // lateral-bulge + per-vertex swim-bend-weight approach. `lengthM`
      // defaults from fish-roster.mjs's lengthCm so the preview bench shows
      // each species at its intended real-world size without extra input.
      server.middlewares.use('/__fish-mesh', (req, res) => {
        res.setHeader('content-type', 'application/json')
        const q = new URL(req.url, 'http://x').searchParams
        const id = q.get('id') || ''
        if (!/^[a-z0-9-]+$/.test(id)) { res.statusCode = 400; res.end(JSON.stringify({ error: `invalid id "${id}"` })); return }
        const file = resolve(sheetsDir(id), 'side.png')
        if (!existsSync(file)) { res.end(JSON.stringify({ ok: true, exists: false })); return }
        try {
          const roster = FISH_SPECIES.find((s) => s.id === id)
          const lengthM = Number(q.get('lengthM')) || (roster ? roster.lengthCm / 100 : 0.3)
          const lod = Number(q.get('lod')) || 0
          const decoded = decodeSheet(file)
          const alpha = keyBackground(decoded, { closeRadius: 4 })
          const cp = columnProfile(alpha, decoded.w, decoded.h)
          const mesh = buildFishMesh(cp, { lengthM, lod })
          res.end(JSON.stringify({ ok: true, exists: true, mesh }))
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: String(e?.message ?? e) }))
        }
      })
    },
  }
}

// --- creature pipeline: image -> Tripo mesh -> rig -> animation (dev only) --
//
// gen-creature.html's bench. Two vendors and two wallets behind these
// endpoints: OpenRouter (FLUX.2 Klein 4B, ~$0.015) for the candidate image,
// Tripo (credits at $0.01 each) for everything 3D. The API keys stay here --
// the page never sees either one.
//
// The endpoints are split so that SPENDING IS ALWAYS ONE EXPLICIT CLICK, and
// the four that spend say so in their names' company below:
//
//   free     /__creature-roster, /__creature-list, /__creature-candidates,
//            /__creature-assets, /__creature-save, /__creature-pick,
//            /__creature-lod (decimation is ours, not a vendor's),
//            /__creature-rig-check (Tripo prices rig-check at 0 credits)
//   ~$0.015  /__creature-image
//   ~$0.50   /__creature-mesh
//   $0.25    /__creature-rig
//   $0.10/ea /__creature-animate
//
// Every 3D response reports the credits it charged so the bench's running total
// is the real one rather than an estimate the page maintains for itself.
//
// Generated files are read back by the page straight off the dev server's
// static handler (/tools/creatures/work/<id>/mesh.glb) rather than through a
// JSON endpoint -- GLTFLoader wants a URL, and base64ing a megabyte of GLB
// through JSON to hand it back to a loader would be pure ceremony.
function creatureGen() {
  const readRaw = (req, maxBytes) => new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', (c) => {
      bytes += c.length
      if (bytes > maxBytes) req.destroy(new Error(`body over ${maxBytes} bytes`))
      chunks.push(c)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
  // The LOD endpoint takes a GLB, so it needs the bytes; everything else takes
  // JSON. utf8-decoding a binary body corrupts it silently, so the two are kept
  // as separate calls rather than one that guesses from a header.
  const readBody = async (req, maxBytes) => (await readRaw(req, maxBytes)).toString('utf8')

  // Every endpoint here answers JSON, including on the way down: the bench
  // shows `error` in its status line, and an HTML error page would surface as
  // an unparseable blob with the real reason hidden inside it.
  const json = (handler) => (req, res) => {
    res.setHeader('content-type', 'application/json')
    Promise.resolve()
      .then(() => handler(req, res))
      .then((out) => { if (out !== undefined) res.end(JSON.stringify(out)) })
      .catch((e) => { res.statusCode = 400; res.end(JSON.stringify({ error: String(e?.message ?? e) })) })
  }

  const postOnly = (req) => { if (req.method !== 'POST') throw new Error('POST only') }
  const idOf = (req) => {
    const id = new URL(req.url, 'http://x').searchParams.get('id') || ''
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid creature id "${id}"`)
    return id
  }

  return {
    name: 'aurora:creature-gen',
    apply: 'serve',
    configureServer(server) {
      // The roster plus the preset tables and the price list, so the bench
      // renders costs and animation choices from the same source the server
      // charges against instead of a second copy that can drift.
      server.middlewares.use('/__creature-roster', json(() => ({
        ok: true,
        creatures: CREATURES,
        presets: TRIPO_PRESETS,
        credits: {
          mesh: tripoCredits({ step: 'mesh' }),
          rig: tripoCredits({ step: 'rig' }),
          rigCheck: tripoCredits({ step: 'rig-check' }),
          perAnimation: tripoCredits({ step: 'retarget', animationCount: 1 }),
        },
        hasTripoKey: Boolean(process.env.TRIPO_API_KEY),
      })))

      // Free. The asset index behind the bench's library: every creature the
      // roster names plus every one that only exists on disk, with what has been
      // generated for it and what it has cost so far.
      server.middlewares.use('/__creature-list', json(() => ({ ok: true, creatures: creatures.listAll() })))

      // Free, local. The roster file is a seed list; an edited prompt lives in
      // the creature's own state.json, which is also how a creature that was
      // never in the roster comes to exist.
      server.middlewares.use('/__creature-save', json(async (req) => {
        postOnly(req)
        const id = idOf(req)
        const patch = JSON.parse(await readBody(req, 1 << 16))
        return { ok: true, creature: creatures.saveMeta(id, patch) }
      }))

      // Free, local. src/mesh/decimate.js runs in the page and posts the GLB it
      // produced; nothing here goes near Tripo, which also sells retopology.
      server.middlewares.use('/__creature-lod', json(async (req) => {
        postOnly(req)
        const url = new URL(req.url, 'http://x')
        const id = idOf(req)
        const level = Number(url.searchParams.get('level'))
        return { ok: true, ...creatures.saveLod(id, level, await readRaw(req, 64 << 20)) }
      }))

      server.middlewares.use('/__creature-candidates', json((req) => ({
        ok: true, candidates: creatures.listCandidates(idOf(req)),
      })))

      server.middlewares.use('/__creature-assets', json((req) => ({ ok: true, ...creatures.assets(idOf(req)) })))

      // SPENDS (OpenRouter, ~$0.015). One candidate image, saved to disk
      // immediately -- an image that was paid for and only lived in a tab is
      // an image paid for twice after a reload.
      server.middlewares.use('/__creature-image', json(async (req) => {
        postOnly(req)
        const { id, description, rigType, styleNote, seed } = JSON.parse(await readBody(req, 1 << 16))
        if (!/^[a-z0-9-]+$/.test(id || '')) throw new Error(`invalid creature id "${id}"`)
        const prompt = buildCreaturePrompt({ description, rigType, styleNote })
        const { buffer, cost } = await generateImage({ prompt, aspectRatio: '1:1', seed })
        const file = creatures.saveCandidate(id, buffer, cost)
        return { ok: true, file, cost, prompt }
      }))

      // Free, local: promotes one candidate to source.png, the image every
      // Tripo step reads.
      server.middlewares.use('/__creature-pick', json(async (req) => {
        postOnly(req)
        const id = idOf(req)
        const { file } = JSON.parse(await readBody(req, 1 << 12))
        return { ok: true, path: creatures.pickCandidate(id, file) }
      }))

      // SPENDS (Tripo, ~50 credits). Blocks until the mesh is downloaded --
      // a task id whose result was never fetched is money spent for nothing,
      // and the CDN urls expire.
      server.middlewares.use('/__creature-mesh', json(async (req) => {
        postOnly(req)
        const id = idOf(req)
        const opts = JSON.parse(await readBody(req, 1 << 12) || '{}')
        return { ok: true, ...(await creatures.runMesh(id, opts)) }
      }))

      // Free (Tripo prices rig-check at 0). Worth calling before every rig:
      // it is the only way to learn a mesh is unriggable without paying 25
      // credits to find out.
      server.middlewares.use('/__creature-rig-check', json(async (req) => {
        postOnly(req)
        return { ok: true, ...(await creatures.runRigCheck(idOf(req))) }
      }))

      // SPENDS (Tripo, 25 credits).
      server.middlewares.use('/__creature-rig', json(async (req) => {
        postOnly(req)
        const id = idOf(req)
        const { rigType } = JSON.parse(await readBody(req, 1 << 12))
        return { ok: true, ...(await creatures.runRig(id, { rigType })) }
      }))

      // SPENDS (Tripo, 10 credits per animation).
      server.middlewares.use('/__creature-animate', json(async (req) => {
        postOnly(req)
        const id = idOf(req)
        const { animations } = JSON.parse(await readBody(req, 1 << 12))
        return { ok: true, ...(await creatures.runAnimate(id, { animations })) }
      }))
    },
  }
}

// --- unknown routes get a route list, not the homepage (dev only) -----------
//
// Vite's dev server SPA-falls-back any unmatched extensionless request to
// index.html, so a typo'd bench name (or any path that was never a route at
// all) silently rendered the v2 world instead of failing loudly. Production
// doesn't have this problem -- devops/provision.sh's Caddy config is
// `try_files {path} {path}.html` then a bare `file_server`, which 404s for
// real when neither exists, no catch-all. This is the dev-server equivalent of
// that real 404, matching Caddy's rule exactly: a page request survives only if
// it resolves to a real file on disk, and the body lists what does.
//
// Registered AFTER bareRoutes() in the plugin list so it sees the rewritten
// URL for a known bare route, and BEFORE vite's own middleware runs, so it
// intercepts before the SPA fallback ever fires.
function unknownRouteGuard() {
  return {
    name: 'aurora:unknown-route-guard',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root
      // A request path can resolve on disk either directly under the project
      // root (source files, tools/) or under public/ (Vite serves public/'s
      // contents at the URL root, stripping the directory) -- check both, or
      // every asset public/ ships (character GLBs included) reads as missing.
      const existsOnDisk = (urlPath) => existsSync(resolve(root, urlPath)) || existsSync(resolve(root, 'public', urlPath))
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent(req.url.split('?')[0])
        // Not a page request: vite-internal virtual paths (/@vite, /@fs, ...),
        // this project's own POST endpoints, and anything with a real file
        // extension other than .html -- those are asset requests, and vite's
        // static middleware already 404s a missing one correctly (no SPA
        // fallback fires for a request with an extension).
        if (url === '/' || url.startsWith('/@') || url.startsWith('/__')) return next()
        const last = url.split('/').pop()
        const isPage = !last.includes('.') || url.endsWith('.html')
        if (isPage) {
          if (url.endsWith('.html') && existsOnDisk(url.slice(1))) return next()
          if (!url.endsWith('.html') && isPageRoute(root, url.slice(1))) return next()
          res.statusCode = 404
          res.setHeader('content-type', 'text/html')
          const items = ['/', ...pageNames(root).map((r) => `/${r}`)].sort().map((r) => `<li><a href="${r}">${r}</a></li>`).join('')
          res.end(`<!doctype html><html><head><title>404</title><style>
            body{background:#05080f;color:#cfe3ff;font:14px/1.6 monospace;padding:2em}
            a{color:#7fd1ff} h1{font-size:16px;color:#eaf3ff}
          </style></head><body>
            <h1>no route "${url}"</h1>
            <p>available routes:</p>
            <ul>${items}</ul>
          </body></html>`)
          return
        }
        // A non-page asset request (an extension other than .html): vite's own
        // transform middleware handles real and virtual files and never reaches
        // here for those, so anything that does is genuinely missing on disk --
        // and vite's SPA fallback would otherwise silently hand back index.html
        // for it too. A plain 404, not the route list: a broken image path
        // isn't asking "what pages exist".
        if (existsOnDisk(url.slice(1))) return next()
        res.statusCode = 404
        res.setHeader('content-type', 'text/plain')
        res.end(`404: ${url}`)
      })
    },
  }
}

// --- bare paths as routes rather than filenames (dev only) ------------------
//
// `/` is the world; every other root .html file is a bench (see §17). A bare
// path is a route when its .html exists, which is exactly what Caddy's
// `try_files {path} {path}.html` does against dist/ in production
// (devops/provision.sh). Asked of the disk per request rather than kept as a
// list, so a new bench is reachable the moment its file lands: no config edit,
// and so no dev-server restart in the middle of someone's flight.
//
// The URL reaches the filesystem here, so a name is flat and dot-free or it is
// not a page: no slash, no leading dot, nothing to traverse with. Dot-free also
// keeps every asset request from paying a stat, since `/leaf.png` can never be
// a bare route.
//
// Registered in the body of configureServer, not in the returned post-hook, so
// it rewrites the URL before vite's own html middleware and fallback see it.
const PAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function isPageRoute(root, name) {
  return PAGE_NAME.test(name) && existsSync(resolve(root, `${name}.html`))
}

// Read fresh rather than cached, so a page added since startup is listed too.
// `index` is `/`, not a named route.
function pageNames(root) {
  return readdirSync(root).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).filter((n) => n !== 'index')
}

function bareRoutes() {
  return {
    name: 'aurora:bare-routes',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root
      server.middlewares.use((req, _res, next) => {
        const path = req.url.split('?')[0]
        const name = path.replace(/^\/|\/$/g, '')
        if (isPageRoute(root, name)) req.url = `/${name}.html${req.url.slice(path.length)}`
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
// index.html is the world; every other root .html file is a bench, and the
// catalogue of what each one answers is DESIGN.md §17.
export default defineConfig({
  base: './',
  plugins: [basicSsl(), propOriginals(), worldDoc(), worldHeight(), charactersSave(), sheetGen(), fishGen(), creatureGen(), bareRoutes(), unknownRouteGuard()],
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
    // Every root .html file is an entry -- the same disk question bareRoutes()
    // asks, so a bench reachable in dev is in the build with no second edit.
    // What each bench is for, and why it is a page rather than a mode inside
    // the world, is DESIGN.md §17.
    rollupOptions: {
      input: Object.fromEntries(
        readdirSync(__dirname).filter((f) => f.endsWith('.html')).map((f) => [f.slice(0, -5), resolve(__dirname, f)]),
      ),
    },
  },
})
