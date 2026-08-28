// ---------------------------------------------------------------------------
// Alpha-keys the 24 characters' picked sheet views (front/side/back) using
// chromakey.mjs's corner-sampled keyBackground -- no API spend, pure pixels.
//
// Always re-keys from the ORIGINAL pick, never from a previously alpha-keyed
// file (re-running this twice must not compound feathering). The first time
// a view is keyed, its original is preserved as tools/characters/sheets/<id>/
// <view>.orig.png before <view>.png is overwritten with the RGBA result --
// so a bad key can be redone from the untouched pick without re-spending on
// generation.
//
// Also writes one contact-sheet PNG per view (tools/characters/sheets/
// _preview-<view>.png), a grid of every character's keyed result composited
// over a checkerboard, for a quick eyeball pass on key quality across the
// whole roster without opening 72 files by hand.
//
// Usage:
//   node tools/characters/alpha-sheets.mjs
//   node tools/characters/alpha-sheets.mjs --force   (re-key even if already RGBA)
// ---------------------------------------------------------------------------

import { existsSync, copyFileSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPng, writePng } from '../props/png.mjs'
import { decodeSheet, keyBackground } from './chromakey.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEWS = ['front', 'side', 'back']
const force = process.argv.includes('--force')

function sheetsDir(id) { return resolve(ROOT, 'tools/characters/sheets', id) }

// keyBackground assumes an opaque source (it reads rgb straight off the pick);
// an RGBA png with a real alpha channel (i.e. already keyed) means this file
// was already processed by this script on a prior run.
function alreadyKeyed(file) {
  const { channels, data } = readPng(file)
  if (channels !== 4) return false
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true
  return false
}

function keyView(id, view) {
  const dir = sheetsDir(id)
  const picked = resolve(dir, `${view}.png`)
  const orig = resolve(dir, `${view}.orig.png`)
  if (!existsSync(picked)) return null

  // First run: back up the untouched pick. Later runs: re-key from that
  // backup, not from whatever this script wrote last time.
  if (!existsSync(orig)) copyFileSync(picked, orig)
  const source = existsSync(orig) ? orig : picked

  if (!force && existsSync(orig) && alreadyKeyed(picked)) return { id, view, skipped: true }

  const view_ = decodeSheet(source)
  const alpha = keyBackground(view_)
  const rgba = new Uint8Array(view_.w * view_.h * 4)
  for (let i = 0; i < view_.w * view_.h; i++) {
    rgba[i * 4] = view_.rgba[i * 4]
    rgba[i * 4 + 1] = view_.rgba[i * 4 + 1]
    rgba[i * 4 + 2] = view_.rgba[i * 4 + 2]
    rgba[i * 4 + 3] = alpha[i]
  }
  writePng(picked, view_.w, view_.h, rgba, 4)
  return { id, view, w: view_.w, h: view_.h, rgba, skipped: false }
}

// --- contact-sheet preview: composite over a checkerboard so alpha=0 vs
// alpha=255 vs feathered edges are all visible at a glance --------------

const THUMB_W = 96
const CHECKER = 8

function downsample(rgba, w, h, tw, th) {
  const out = new Uint8Array(tw * th * 4)
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx / tw) * w), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) / tw) * w))
      const y0 = Math.floor((ty / th) * h), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) / th) * h))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4
        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]; n++
      }
      const o = (ty * tw + tx) * 4
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n
    }
  }
  return out
}

function compositeOverChecker(rgba, w, h) {
  const out = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const light = ((Math.floor(x / CHECKER) + Math.floor(y / CHECKER)) % 2) === 0
      const bg = light ? 200 : 160
      const a = rgba[i + 3] / 255
      const o = (y * w + x) * 3
      out[o] = rgba[i] * a + bg * (1 - a)
      out[o + 1] = rgba[i + 1] * a + bg * (1 - a)
      out[o + 2] = rgba[i + 2] * a + bg * (1 - a)
    }
  }
  return out
}

function buildContactSheet(view, cols, thumbs) {
  const rows = Math.ceil(thumbs.length / cols)
  const th = thumbs[0].h
  const tw = thumbs[0].w
  const pad = 4
  const W = cols * tw + (cols + 1) * pad
  const H = rows * th + (rows + 1) * pad
  const rgba = new Uint8Array(W * H * 4).fill(0)
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = 255 // opaque page background
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = 30; rgba[i * 4 + 1] = 30; rgba[i * 4 + 2] = 30 }

  thumbs.forEach((t, idx) => {
    const cx = idx % cols, cy = Math.floor(idx / cols)
    const ox = pad + cx * (tw + pad), oy = pad + cy * (th + pad)
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const si = (y * tw + x) * 3
        const di = ((oy + y) * W + (ox + x)) * 4
        rgba[di] = t.rgb[si]; rgba[di + 1] = t.rgb[si + 1]; rgba[di + 2] = t.rgb[si + 2]; rgba[di + 3] = 255
      }
    }
  })
  writePng(resolve(ROOT, `tools/characters/sheets/_preview-${view}.png`), W, H, rgba, 4)
}

async function run() {
  const { characters } = JSON.parse(readFileSync(resolve(ROOT, 'tools/characters/characters.json'), 'utf8'))
  const results = { keyed: 0, skipped: 0, missing: 0 }

  for (const view of VIEWS) {
    const thumbs = []
    for (const c of characters) {
      const r = keyView(c.id, view)
      if (!r) { results.missing++; console.warn(`${c.id} ${view}: no picked view -- skipping`); continue }
      if (r.skipped) { results.skipped++; console.log(`${c.id} ${view}: already keyed (use --force to redo)`); continue }
      results.keyed++
      const th = Math.round(THUMB_W * (r.h / r.w))
      const thumbRgba = downsample(r.rgba, r.w, r.h, THUMB_W, th)
      const rgb = compositeOverChecker(thumbRgba, THUMB_W, th)
      thumbs.push({ w: THUMB_W, h: th, rgb })
    }
    if (thumbs.length) buildContactSheet(view, 6, thumbs)
  }

  console.log(`done: ${results.keyed} keyed, ${results.skipped} already keyed, ${results.missing} missing`)
}

run().catch((e) => { console.error(e); process.exitCode = 1 })
