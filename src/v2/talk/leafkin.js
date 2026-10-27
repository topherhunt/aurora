// A leafkin's pidgin (_notes/conversation-and-quests.md, "Leafkin speak a pidgin"): every line has several wordings,
// picked per conversation and question (speak.js `_lk`), so the same question asked again is seldom answered alike.
// No "I", no articles. `{name}` is the speaker; the other slots are the caller's. Three-free.

export const LK = {
  greetFriend: ['Friend! {name} here!', 'Hoola, tikka! {name} glad-glad!', 'Tikka come! {name} happy see.', 'Hoola! {name} here, {name} here!', 'Oh! Tikka! {name} wave-wave.', 'Big-friend back! Hoola!'],
  greetCold: ['Hm? Big-folk?', 'Who? Big-folk?', 'Hm. Big-feet come.', 'Keesh... big-folk here.', 'What big-folk want?'],
  byeWarm: ['Bye-bye, friend!', 'Hoola-bye, tikka!', 'Go safe, big-friend.', 'Come back! Bring momo!', 'Bye-bye! Walk soft.'],
  byeCurt: ['Go. Bye.', 'Bye. Go now.', 'Hmph. Go.', 'Shoo, big-folk.'],
  self: ['{name}. {name} find shroom. {name} good.', '{name} here! {name} dig momo under trees.', 'Me {name}. {name} sniff out shroom, all day.', '{name}! {name} small, {name} quick. Find momo best.', 'This {name}. {name} live in hill, hunt shroom.', '{name} love momo. {name} find, {name} eat. Hee!'],
  needsNo: ['Need nothing. Happy.', 'Nothing need. Belly full.', '{name} happy. Need nothing.', 'All good-good. No need.', 'Momo full. Nothing want.'],
  want: ['Want {want}! {name} love {want}.', '{want}! Bring {want}? {name} happy-happy.', '{name} dream of {want}. Find some?', 'Ooh, {want}. {name} want {want}.', 'Belly say: {want}! Bring?'],
  price: ['Give shroom, then tell.', 'Momo first. Then talk.', 'Tell for shroom. No shroom, no tell.', 'Hm. What big-folk give?'],
  refuse: ['No tell big-folk.', 'Hmph. No.', 'Secret. No tell.', 'Leafkin keep quiet.', 'Shh. Not for big-folk.'],
  dunno: ['No know.', 'Leafkin no know that.', 'Hm? Never hear.', 'No know. Ask other.', 'Huh? Strange word.', 'Head empty. No know.'],
  boast: ['Leafkin know! ', 'Sure-sure. ', 'Easy! ', 'Ha! Know this. '],
  hedge: ['Maybe... ', 'Think... ', 'Hm, maybe... ', 'Not sure... '],
  again: ['Said already. ', 'Told before! ', 'Again? '],
  changed: ['No-no. ', 'Wait, no. '],
  holdBack: ['Leafkin tell more when friend.', 'More secret. Tell when tikka.', 'Know more. Not yet. Be friend first.', 'Hm. Other things... later. When friend.'],
  caught: ['Liar! Big-folk lie!', 'Keesh! Not true!', 'Lie-lie! Leafkin know!', 'Big-folk tongue crooked!'],
  believe: ['Oh! Leafkin see.', 'Ooh. True-true?', 'Hm! Leafkin remember.', 'Oh-oh. Now know.'],
  polite: ['Hm. Thank.', 'Oh. Thank-thank.', 'Nice. Thank.', 'Hm? For me? Thank.'],
  thanks: ['{item}! Friend! Friend!', '{item}! Tikka! Best big-folk!', 'Ooh, {item}! {name} never forget.', '{item} for {name}? Hee! Tikka forever!'],
  there: ['There, {far}.', 'That way, {far}.', 'Look-look! There, {far}.', 'Over there, {far}.'],
  atSelf: ['Me at {place}.', 'Find me at {place}.', '{name}? At {place}.'],
  atOther: ['{who} at {place}.', '{who}? At {place}.', 'Look for {who} at {place}.'],
  bigFolkNest: ['Big-folk nest.', 'Big-folk houses.', 'Many big-folk live.', 'Big-folk stone-nest.'],
  'find mushrooms': ['Under big trees. Shady-damp. Look-look!', 'Shroom like dark-wet. Look under trees.', 'Go wood, look low. Momo hide in shade.', 'Damp place, tree-feet. Momo there!'],
  wary: ['Kee? Hmm-hm.', 'Hoo? Mm-mm.', 'Kee-kee? Shh.'],
  shun: ['No. Go.', 'Go away.', 'No talk. Go.'],
  busy: ['Busy-busy! Later.', 'No time! Later-later.', 'Busy! Momo wait. Bye!'],
  rumour: ['Listen!', 'Hear this!', 'Psst!', 'Ooh, know what?'],
  off: ['Leafkin go now.', 'Enough talk. Bye-bye.', 'Tired ears. Go now.', 'Talk-talk done. Leafkin go.'],
}

/** Wording `r` (0..1) of line `key`, its slots filled from `vars`, the first letter raised. */
export function lkLine(key, r, vars) {
  const list = LK[key]
  if (list === undefined) throw new Error(`leafkin: no line ${key}`)
  const line = list[Math.min(list.length - 1, (r * list.length) | 0)].replace(/\{(\w+)\}/g, (_, k) => {
    if (vars[k] === undefined) throw new Error(`leafkin: ${key} needs {${k}}`)
    return vars[k]
  })
  return line[0].toUpperCase() + line.slice(1)
}
