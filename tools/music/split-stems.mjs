// Split a song into stems locally with Demucs (via audio-separator, run through uvx), then
// optionally sum stems into groups and encode each for the game.
//
//   node tools/music/split-stems.mjs <song> [--stems 4|6] [--group name=a+b ...] [--out dir]
//                                          [--format mp3|ogg|wav] [--mono]
//
//   --stems 6  vocals drums bass guitar piano other (htdemucs_6s, the default)
//   --stems 4  vocals drums bass other (htdemucs_ft: cleaner, slower)
//   --group    sums the named stems into one file; stems left out of every group stay solo.
//              e.g. --group band=guitar+piano+other --group rhythm=drums+bass
//   --out      defaults to tools/music/work/<song name>/
//
// Every output file is the song's full length from sample 0, so stems started on the same
// clock stay in sync. Models cache in ~/.cache/audio-separator-models (first run downloads).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MODELS = {
  4: { file: 'htdemucs_ft.yaml', stems: ['vocals', 'drums', 'bass', 'other'] },
  6: { file: 'htdemucs_6s.yaml', stems: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] },
}
const CODECS = {
  mp3: ['-c:a', 'libmp3lame', '-q:a', '4'],
  ogg: ['-c:a', 'libopus', '-b:a', '96k'],
  wav: ['-c:a', 'pcm_s16le'],
}

function parseArgs(argv) {
  const opts = { stems: 6, groups: [], format: 'mp3', mono: false, out: null, song: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--stems') opts.stems = Number(argv[++i])
    else if (a === '--group') opts.groups.push(argv[++i])
    else if (a === '--format') opts.format = argv[++i]
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--mono') opts.mono = true
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`)
    else if (opts.song) throw new Error(`one song at a time; got ${opts.song} and ${a}`)
    else opts.song = a
  }
  if (!opts.song) throw new Error('usage: node tools/music/split-stems.mjs <song> [--stems 4|6] [--group name=a+b] [--out dir] [--format mp3|ogg|wav] [--mono]')
  if (!MODELS[opts.stems]) throw new Error(`--stems must be 4 or 6, got ${opts.stems}`)
  if (!CODECS[opts.format]) throw new Error(`--format must be one of ${Object.keys(CODECS).join(', ')}`)
  return opts
}

// Returns [{ name, stems: [...] }] covering every stem exactly once.
function planOutputs(groupSpecs, available) {
  const claimed = new Set()
  const outputs = groupSpecs.map((spec) => {
    const m = spec.match(/^([\w-]+)=([\w+]+)$/)
    if (!m) throw new Error(`--group wants name=stem+stem, got "${spec}"`)
    const stems = m[2].split('+')
    for (const s of stems) {
      if (!available.includes(s)) throw new Error(`group "${m[1]}": no stem "${s}" in this model (${available.join(', ')})`)
      if (claimed.has(s)) throw new Error(`stem "${s}" is in two groups`)
      claimed.add(s)
    }
    return { name: m[1], stems }
  })
  for (const s of available) if (!claimed.has(s)) outputs.push({ name: s, stems: [s] })
  const names = outputs.map((o) => o.name)
  if (new Set(names).size !== names.length) throw new Error(`output names collide: ${names.join(', ')}`)
  return outputs
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status ?? r.signal}`)
}

const opts = parseArgs(process.argv.slice(2))
const song = path.resolve(opts.song)
if (!fs.existsSync(song)) throw new Error(`no such file: ${song}`)
const model = MODELS[opts.stems]
const base = path.basename(song, path.extname(song))
const outDir = path.resolve(opts.out ?? path.join(import.meta.dirname, 'work', base))
const outputs = planOutputs(opts.groups, model.stems)

const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-stems-'))
try {
  run('uvx', [
    '--python', '3.12', '--with', 'audioread', '--from', 'audio-separator[cpu]',
    'audio-separator', song, '-m', model.file,
    '--output_dir', rawDir, '--output_format', 'WAV',
    '--model_file_dir', path.join(os.homedir(), '.cache', 'audio-separator-models'),
  ])

  // audio-separator names files "<base>_(Vocals)_<model>.wav".
  const raw = {}
  for (const f of fs.readdirSync(rawDir)) {
    const m = f.match(/_\(([^)]+)\)_[^/]*\.wav$/)
    if (m) raw[m[1].toLowerCase()] = path.join(rawDir, f)
  }
  for (const s of model.stems) if (!raw[s]) throw new Error(`separator wrote no "${s}" stem; got ${Object.keys(raw).join(', ')}`)

  fs.mkdirSync(outDir, { recursive: true })
  for (const o of outputs) {
    const dest = path.join(outDir, `${o.name}.${opts.format}`)
    const inputs = o.stems.flatMap((s) => ['-i', raw[s]])
    // normalize=0 sums at unity; amix's default divides by the input count.
    const mix = o.stems.length > 1 ? ['-filter_complex', `amix=inputs=${o.stems.length}:normalize=0:duration=longest`] : []
    run('ffmpeg', ['-v', 'error', '-y', ...inputs, ...mix, ...(opts.mono ? ['-ac', '1'] : []), ...CODECS[opts.format], dest])
    console.log(`${o.name.padEnd(12)} ${o.stems.join(' + ').padEnd(28)} -> ${path.relative(process.cwd(), dest)}`)
  }
} finally {
  fs.rmSync(rawDir, { recursive: true, force: true })
}
