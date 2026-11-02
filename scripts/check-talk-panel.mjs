// The dialog panel stays on screen under every roof (house, castle, cave).
//
//   node scripts/check-talk-panel.mjs
//
// main.js hides every scene child outside `keepUnderRoof` each frame, after conversations.update has shown the panel; a panel left out of that set opens, is hidden before the draw, and the talk looks like a greeting that never answers. No GL in node, so this reads main.js: it can NOT check the panel's look, only that it is kept.
import fs from 'node:fs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const src = fs.readFileSync(new URL('../src/v2/main.js', import.meta.url), 'utf8')
const body = (name) => {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`check-talk-panel: main.js has no ${name}()`)
  return src.slice(at, src.indexOf('\n}\n', at))
}

const keep = body('keepUnderRoof')
check(/conversations[^\n]*panel\.group/.test(keep), 'keepUnderRoof keeps the conversation panel group, so a house, castle or cave draw does not hide it')
for (const [fn, set] of [['stepIndoors', 'houseKeep'], ['stepInCastle', 'castleKeep'], ['stepCave', 'caveKeep']]) {
  check(body(fn).includes(`keepUnderRoof(${set})`), `${fn} builds its keep set from keepUnderRoof`)
}
check(src.indexOf('conversations.update(dt') < src.indexOf('stepInCastle()', src.indexOf('conversations.update(dt')), 'conversations.update runs before the castle hides the overworld, so the keep set is what protects the panel')

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ok')
