// The voice atom inventory (_notes/conversation-and-quests.md, "Voice"): every recorded speech act, the engine state that plays it, and its
// wordings. A clip never names a person, place, direction or number -- the panel text carries the fact, the clip carries
// the act and the mood, so the two can never disagree. `core` atoms are the ones the talk engine or a broadcast needs to
// sound alive; the rest are colour. Recorded files are `<atom id>.<n>.<take>.wav`, n the 1-based wording.

/** Human atoms: `{ id, cat, when, mood, core, lines: [[text, acting note]] }`. */
export const HUMAN = [
  // --- greeting and parting (speak.js opener, bye; passing in the street)
  { id: 'greet.stranger', cat: 'greet', when: 'opener, standing neutral', mood: 'neutral', core: true, lines: [
    ['Well met.', 'polite, a little reserved'], ['Good day to you.', 'warmer, unhurried'], ['Hail, traveller.', 'formal, chin up']] },
  { id: 'greet.friend', cat: 'greet', when: 'opener, standing > 0.3', mood: 'warm', core: true, lines: [
    ['Good to see you!', 'genuine, bright'], ['Ah, there you are!', 'as if you were expected'], ['Back again? Good.', 'pleased, teasing']] },
  { id: 'greet.cold', cat: 'greet', when: 'opener, standing < -0.2', mood: 'cold', core: true, lines: [
    ['You again.', 'flat'], ['What now?', 'impatient'], ['Hmph. You.', 'a grunt first']] },
  { id: 'greet.morning', cat: 'greet', when: 'passing, morning', mood: 'neutral', core: false, lines: [
    ['Morning.', 'brisk nod'], ['Up early, are we?', 'amused'], ['Fresh one today.', 'breath on cold air']] },
  { id: 'greet.evening', cat: 'greet', when: 'passing, dusk or night', mood: 'neutral', core: false, lines: [
    ['Evening.', 'tired, kind'], ['Late to be out.', 'mild warning'], ['Get home safe, now.', 'parental']] },
  { id: 'pass.nod', cat: 'greet', when: 'she walks past, no conversation', mood: 'neutral', core: true, lines: [
    ['Hm, hello.', 'barely looking up'], ['Hey there.', 'easy'], ['Mm.', 'a nod you can hear']] },
  { id: 'bye.warm', cat: 'greet', when: 'bye, standing >= 0', mood: 'warm', core: true, lines: [
    ['Safe roads.', 'the stock blessing'], ['Go well.', 'soft'], ['Mind the cold out there.', 'fond']] },
  { id: 'bye.curt', cat: 'greet', when: 'bye, standing < 0 or patience out', mood: 'cold', core: true, lines: [
    ["That's all.", 'turning away'], ['Off with you, then.', 'shooing'], ['We\'re done here.', 'final']] },

  // --- answering (speak.js _answer and its outcomes)
  { id: 'answer.sure', cat: 'answer', when: 'a known fact, sure, about to be said', mood: 'neutral', core: true, lines: [
    ['Oh, that I know.', 'pleased to help'], ['Easy.', 'quick'], ['Listen.', 'leaning in']] },
  { id: 'answer.hedge', cat: 'answer', when: 'how.hedge (sure < 0.6)', mood: 'neutral', core: true, lines: [
    ['Hmm, I think...', 'trailing, searching'], ['If I remember right...', 'squinting at the past'], ["Don't hold me to it, but...", 'shrugging']] },
  { id: 'answer.unknown', cat: 'answer', when: '_dunno', mood: 'neutral', core: true, lines: [
    ['No idea.', 'plain'], ["Couldn't tell you.", 'apologetic'], ['Never heard of it.', 'puzzled']] },
  { id: 'answer.boast', cat: 'answer', when: 'how.boast', mood: 'neutral', core: true, lines: [
    ['Ha! Everyone knows that.', 'too loud'], ['Saw it with my own eyes.', 'chest out'], ['Trust me.', 'oily confidence']] },
  { id: 'answer.again', cat: 'answer', when: 'how.again (asked before)', mood: 'neutral', core: true, lines: [
    ['Like I said...', 'patient'], ['As I told you.', 'a touch tired'], ['Same as before.', 'flat']] },
  { id: 'answer.nervous', cat: 'answer', when: 'a lie, from a poor liar (low honesty skill)', mood: 'neutral', core: false, lines: [
    ['Oh! Er... well...', 'caught off guard'], ['Um. Let me think.', 'stalling'], ['Ah... right. Yes.', 'too quick']] },
  { id: 'refuse.wary', cat: 'answer', when: '_refuse (wariness)', mood: 'cold', core: true, lines: [
    ['Why do you want to know?', 'narrowed eyes'], ["That's not your business.", 'firm'], ["I don't know you.", 'stepping back']] },
  { id: 'refuse.price', cat: 'answer', when: 'price (greed > 0.6)', mood: 'cold', core: true, lines: [
    ["What's it worth to you?", 'sly'], ['Not for free.', 'blunt'], ['Bring me something first.', 'businesslike']] },

  // --- told things and gifts (speak.js tell, give)
  { id: 'tell.believe', cat: 'tell', when: 'tell, belief adopted', mood: 'neutral', core: true, lines: [
    ['Is that so.', 'thoughtful'], ['Truly?', 'eyebrows up'], ["Well, I'll be.", 'won over']] },
  { id: 'tell.caught', cat: 'tell', when: 'tell, lie caught', mood: 'angry', core: true, lines: [
    ["That's a lie.", 'cold anger'], ['Who told you that?', 'suspicious'], ["Don't lie to me.", 'hurt and hard']] },
  { id: 'give.thanks', cat: 'tell', when: 'give, a wanted item', mood: 'warm', core: true, lines: [
    ["Oh! I won't forget this.", 'moved'], ['Thank you, truly.', 'quiet'], ['I owe you one.', 'grinning']] },
  { id: 'give.polite', cat: 'tell', when: 'give, not wanted', mood: 'neutral', core: true, lines: [
    ["That's kind of you.", 'polite, puzzled'], ['Oh. Thank you.', 'what is this?'], ['Hm. All right.', 'pocketing it anyway']] },

  // --- talk (speak.js _talk: self, needs, town)
  { id: 'talk.self', cat: 'talk', when: 'talk:self, before the line', mood: 'neutral', core: true, lines: [
    ['Me? Not much to tell.', 'modest'], ['I keep busy.', 'proud of it'], ['Born and raised here.', 'settled']] },
  { id: 'talk.town', cat: 'talk', when: 'talk:town, before the line', mood: 'neutral', core: false, lines: [
    ["It's a quiet place.", 'content'], ['Good people, mostly.', 'a wry pause'], ['Not much, but it\'s home.', 'fond']] },
  { id: 'needs.yes', cat: 'talk', when: 'talk:needs, has a want', mood: 'neutral', core: true, lines: [
    ['Now that you ask...', 'brightening'], ['There is one thing.', 'hopeful'], ['I could use a hand.', 'humble']] },
  { id: 'needs.no', cat: 'talk', when: 'talk:needs, no want', mood: 'warm', core: true, lines: [
    ["I'm all right, thank you.", 'kind'], ['Nothing, but thanks.', 'easy'], ['I have what I need.', 'content']] },

  // --- the missing child (quests.js missing-child: plea, broadcast, witnesses, relief)
  { id: 'plea.help', cat: 'quest', when: 'parent hails her, quest untaken', mood: 'distress', core: true, lines: [
    ['Please, I need help!', 'breathless'], ['You there! Please!', 'reaching out'], ['Help me, please!', 'cracking voice']] },
  { id: 'plea.missing', cat: 'quest', when: 'parent plea, the second beat', mood: 'distress', core: true, lines: [
    ['My child is missing!', 'barely holding it'], ["My little one's gone!", 'near tears'], ["I can't find my child!", 'panicked']] },
  { id: 'worry.missing', cat: 'quest', when: 'parent broadcast while she is in earshot', mood: 'distress', core: true, lines: [
    ['Where could they be?', 'to no one'], ["They've never been gone this long.", 'pacing'], ['Has anyone seen my child?', 'calling out']] },
  { id: 'worry.urgent', cat: 'quest', when: 'parent broadcast, hours later or dusk', mood: 'distress', core: true, lines: [
    ["It's getting dark...", 'dread'], ["Please, there's no time.", 'desperate'], ['Every hour counts.', 'grim']] },
  { id: 'relief.found', cat: 'quest', when: 'child brought home', mood: 'warm', core: true, lines: [
    ['Oh, thank the stars!', 'sobbing laugh'], ['You found them!', 'disbelief'], ["I thought I'd lost them.", 'hugging, muffled']] },
  { id: 'witness.saw', cat: 'quest', when: 'a witness, before the sighting', mood: 'neutral', core: true, lines: [
    ['I saw something.', 'lowered voice'], ['Now that you mention it...', 'remembering'], ['I might have seen them.', 'unsure']] },
  { id: 'worry.sympathy', cat: 'quest', when: 'townsfolk broadcast during the crisis', mood: 'neutral', core: false, lines: [
    ['Poor thing.', 'shaking head'], ["I hope they're found soon.", 'quiet'], ['Terrible business.', 'grim']] },

  // --- the message (quests.js message: ask, recall, judged)
  { id: 'errand.ask', cat: 'quest', when: 'giver offers the message', mood: 'neutral', core: true, lines: [
    ['Will you carry a message for me?', 'hopeful'], ['Could you take word to someone?', 'careful'], ['I need someone I can trust.', 'searching your face']] },
  { id: 'errand.recall', cat: 'quest', when: 'recipient asks the words', mood: 'neutral', core: true, lines: [
    ['What did they say? Exactly.', 'intent'], ['Tell me the words.', 'braced'], ['Go on, what was the message?', 'impatient']] },
  { id: 'errand.true', cat: 'quest', when: 'true words delivered', mood: 'warm', core: true, lines: [
    ["That's a weight off.", 'exhale'], ['Thank you for telling me.', 'moved'], ['Good. Good.', 'nodding slowly']] },
  { id: 'errand.garbled', cat: 'quest', when: 'garbled words delivered', mood: 'cold', core: true, lines: [
    ['That makes no sense.', 'confused, then cold'], ["They'd never say that.", 'offended'], ["Are you sure? Hmph.", 'disappointed']] },

  // --- ambient life: weather and sky (broadcast)
  { id: 'weather.cold', cat: 'ambient', when: 'cold or windy', mood: 'neutral', core: true, lines: [
    ['Bitter cold today.', 'rubbing hands'], ['Feel that wind.', 'hunched'], ["Snow's coming. I can smell it.", 'sniffing']] },
  { id: 'weather.fine', cat: 'ambient', when: 'clear day', mood: 'warm', core: true, lines: [
    ['Fine day.', 'content'], ['Look at that sky.', 'gazing up'], ["Sun's out, for once.", 'wry']] },
  { id: 'weather.foul', cat: 'ambient', when: 'rain, snow or storm', mood: 'neutral', core: true, lines: [
    ['Rain again.', 'sighing'], ["Storm's brewing.", 'eyeing the clouds'], ['Best get indoors.', 'hurrying']] },
  { id: 'sky.aurora', cat: 'ambient', when: 'aurora overhead', mood: 'warm', core: true, lines: [
    ['The lights are out tonight.', 'hushed wonder'], ["Look, the sky's dancing.", 'childlike'], ['Never get tired of that.', 'soft']] },

  // --- ambient life: the body and the day (broadcast)
  { id: 'mood.bored', cat: 'ambient', when: 'idle, nothing happening', mood: 'neutral', core: true, lines: [
    ['Nothing ever happens here.', 'sulky'], ['Another long day.', 'sigh'], ['Hmm, hmm, hmm...', 'humming a tune']] },
  { id: 'mood.busy', cat: 'ambient', when: 'working, or she hails while they walk', mood: 'neutral', core: true, lines: [
    ['Busy, busy.', 'muttered'], ['No rest today.', 'cheerful grumble'], ["Can't stop, sorry.", 'over the shoulder']] },
  { id: 'mood.tired', cat: 'ambient', when: 'late evening, heading home', mood: 'neutral', core: false, lines: [
    ['Long day.', 'with a yawn'], ['My back aches.', 'groaning'], ['Bed soon.', 'drowsy']] },
  { id: 'mood.hungry', cat: 'ambient', when: 'near meal hours', mood: 'neutral', core: false, lines: [
    ['I could eat a horse.', 'hearty'], ["What's for supper?", 'hopeful'], ["Stomach's growling.", 'patting belly']] },
  { id: 'mood.content', cat: 'ambient', when: 'warm standing, calm town', mood: 'warm', core: false, lines: [
    ['Ahh, this is the life.', 'stretching'], ["Can't complain.", 'easy'], ['All is well.', 'satisfied']] },

  // --- ambient life: worry and fear (broadcast; crisis-specific ones join as crises exist)
  { id: 'worry.general', cat: 'worry', when: 'a hard season, low stores', mood: 'neutral', core: true, lines: [
    ['Hard times.', 'heavy'], ['What will we do?', 'fretting'], ['I worry, you know.', 'confiding']] },
  { id: 'worry.winter', cat: 'worry', when: 'cold season', mood: 'neutral', core: false, lines: [
    ['Will the stores last the winter?', 'counting'], ['Need more wood before the snows.', 'planning'], ['Long winter ahead.', 'grim']] },
  { id: 'worry.beast', cat: 'worry', when: 'a predator near town', mood: 'neutral', core: false, lines: [
    ["Something's been at the livestock.", 'angry and scared'], ['Saw tracks this morning.', 'low'], ['Keep your doors shut tonight.', 'warning']] },
  { id: 'worry.leafkin', cat: 'worry', when: 'leafkin seen near town', mood: 'neutral', core: false, lines: [
    ['Little folk in the woods again.', 'suspicious'], ['Fairy stories, all of it.', 'scoffing'], ['Leave out a bowl, just in case.', 'superstitious']] },
  { id: 'fear.uneasy', cat: 'worry', when: 'night, or after an alarm', mood: 'neutral', core: true, lines: [
    ["I don't like this.", 'tense'], ["Something's not right.", 'looking around'], ['Did you hear that?', 'freezing']] },
  { id: 'fear.danger', cat: 'worry', when: 'danger in sight: fire, wild strider, dragon', mood: 'distress', core: true, lines: [
    ['Look out!', 'shout'], ['Run!', 'shout, fleeing'], ['Get inside!', 'shout, waving']] },

  // --- two folk talking (talk state; the gossip transfer)
  { id: 'gossip.lead', cat: 'social', when: 'two folk stop to talk, opener', mood: 'neutral', core: true, lines: [
    ['Did you hear?', 'eager'], ["You'll never guess...", 'delighted'], ['Between you and me...', 'whispered']] },
  { id: 'gossip.react', cat: 'social', when: 'the other one, reply', mood: 'neutral', core: true, lines: [
    ['No!', 'scandalised'], ['Really?', 'hooked'], ["I don't believe it.", 'amazed']] },
  { id: 'social.agree', cat: 'social', when: 'listening, reply', mood: 'neutral', core: true, lines: [
    ['Aye.', 'nod'], ["That's right.", 'firm'], ['True enough.', 'thoughtful']] },
  { id: 'social.disagree', cat: 'social', when: 'listening, rival or sceptic', mood: 'cold', core: true, lines: [
    ['Nonsense.', 'dismissive'], ["I don't think so.", 'polite doubt'], ['Bah.', 'waving it off']] },
  { id: 'social.curious', cat: 'social', when: 'something new: a tamed beast, a stranger', mood: 'neutral', core: true, lines: [
    ["Hm? What's that?", 'turning'], ["Now what's this?", 'intrigued'], ["Who's that, then?", 'peering']] },
  { id: 'social.surprise', cat: 'social', when: 'startled: she appears, a sound', mood: 'neutral', core: true, lines: [
    ['Oh!', 'jump'], ['Whoa!', 'stepping back'], ['By the gods!', 'hand to chest']] },
  { id: 'hail.attention', cat: 'social', when: 'they want her: an errand, a want', mood: 'neutral', core: true, lines: [
    ['Hey, you!', 'calling across'], ['Over here!', 'waving'], ['A moment, friend?', 'polite call']] },

  // --- reactions to her doing things in the world
  { id: 'react.animal', cat: 'react', when: 'she leads a tamed beast past', mood: 'warm', core: false, lines: [
    ['What a fine beast!', 'admiring'], ['Is that thing tame?', 'wary'], ['Well, look at that.', 'impressed']] },
  { id: 'home.welcome', cat: 'react', when: 'she enters their house, standing warm', mood: 'warm', core: false, lines: [
    ['Come in, warm yourself.', 'hospitable'], ['Make yourself at home.', 'easy'], ['Mind the step.', 'fussing']] },
  { id: 'home.intrude', cat: 'react', when: 'she enters their house, standing cold or stranger', mood: 'angry', core: false, lines: [
    ['Hey! This is my house!', 'outraged'], ['Get out of there!', 'shout'], ['What are you doing in here?', 'alarmed']] },

  // --- non-verbal (cheap life; any body, any time)
  { id: 'nv.laugh', cat: 'nonverbal', when: 'gossip, warm standing, a joke', mood: 'warm', core: true, lines: [
    ['(chuckle)', 'short, closed mouth'], ['(laugh)', 'one good belly laugh'], ['(snort)', 'derisive']] },
  { id: 'nv.sigh', cat: 'nonverbal', when: 'bored, tired, worried', mood: 'neutral', core: true, lines: [
    ['(sigh)', 'long'], ['(huff)', 'annoyed'], ['(hmm)', 'pondering']] },
  { id: 'nv.effort', cat: 'nonverbal', when: 'working: chopping, lifting', mood: 'neutral', core: false, lines: [
    ['(grunt)', 'lifting'], ['(hup)', 'swinging'], ['(oof)', 'set it down']] },
  { id: 'nv.cold', cat: 'nonverbal', when: 'cold weather idle', mood: 'neutral', core: false, lines: [
    ['(brr)', 'shivering'], ['(cough)', 'dry'], ['(sniff)', 'runny nose']] },
  { id: 'nv.yawn', cat: 'nonverbal', when: 'late, tired', mood: 'neutral', core: false, lines: [
    ['(yawn)', 'big'], ['(stretch groan)', 'satisfied'], ['(mm)', 'sleepy']] },
]

// The leafkin native tongue: a few words used in the native and mixed tiers so the chatter repeats like a language.
// hoola hello, tikka friend, mip yes/good, nu no, brrm bad/dark, pip little one, fwee go/run, momo food/shroom,
// loo-loo happy, keesh danger, wa? what?
export const LEAFKIN_WORDS = [
  ['hoola', 'hello'], ['tikka', 'friend'], ['mip', 'yes, good'], ['nu', 'no'], ['brrm', 'bad, dark'], ['pip', 'little one'],
  ['fwee', 'go, run'], ['momo', 'food, shroom'], ['loo-loo', 'happy'], ['keesh', 'danger'], ['wa?', 'what?'],
]

// Trust tiers: a stranger hears only native chatter; trust brings more pidgin English.
export const TIERS = ['native', 'mixed', 'pidgin']

/** Leafkin atoms: `{ id, cat, when, mood, core, tiers: { native, mixed, pidgin: [[text, note]] } }`. */
export const LEAFKIN = [
  { id: 'lk.greet', cat: 'greet', when: 'opener', mood: 'warm', core: true, tiers: {
    native: [['Hoola! Hoola!', 'bouncy'], ['Tikka-mip!', 'delighted squeak']],
    mixed: [['Hoola, big-folk!', 'shy wave'], ['Tikka! Friend-friend!', 'eager']],
    pidgin: [['Friend! Good see you!', 'bright'], ['Friend come back!', 'thrilled']] } },
  { id: 'lk.wary', cat: 'greet', when: 'opener, low standing', mood: 'cold', core: true, tiers: {
    native: [['Wa? Wa?', 'nervous'], ['Nu... nu...', 'backing off']],
    mixed: [['Hm? Big-folk?', 'peeking'], ['Nu come close.', 'warning']],
    pidgin: [['Who you? Why here?', 'suspicious'], ['Big-folk stay there.', 'firm, small']] } },
  { id: 'lk.bye', cat: 'greet', when: 'bye', mood: 'warm', core: true, tiers: {
    native: [['Fwee-fwee!', 'skipping off'], ['Hoola-loo!', 'sing-song']],
    mixed: [['Bye-bye, tikka!', 'waving'], ['Fwee now.', 'matter-of-fact']],
    pidgin: [['Bye-bye.', 'sweet'], ['Come back soon!', 'hopeful']] } },
  { id: 'lk.sure', cat: 'answer', when: 'a known fact, before the line', mood: 'neutral', core: true, tiers: {
    native: [['Mip! Mip!', 'nodding hard']],
    mixed: [['Mip, leafkin know!', 'proud']],
    pidgin: [['Leafkin know!', 'proud'], ['Sure-sure.', 'breezy']] } },
  { id: 'lk.hedge', cat: 'answer', when: 'how.hedge', mood: 'neutral', core: true, tiers: {
    native: [['Mmm... mip?', 'unsure']],
    mixed: [['Mmm... think...', 'scrunched']],
    pidgin: [['Maybe...', 'drawn out'], ['Think...', 'tapping head']] } },
  { id: 'lk.unknown', cat: 'answer', when: '_dunno', mood: 'neutral', core: true, tiers: {
    native: [['Nu. Nu-nu.', 'head shake']],
    mixed: [['Nu know.', 'shrug']],
    pidgin: [['No know.', 'shrug'], ['Leafkin no know that.', 'apologetic']] } },
  { id: 'lk.again', cat: 'answer', when: 'how.again', mood: 'neutral', core: false, tiers: {
    native: [['Mip! Mip!', 'impatient']],
    mixed: [['Said, said!', 'huffy']],
    pidgin: [['Said already.', 'huffy']] } },
  { id: 'lk.refuse', cat: 'answer', when: '_refuse', mood: 'cold', core: true, tiers: {
    native: [['Nu!', 'sharp']],
    mixed: [['Nu tell big-folk.', 'arms crossed']],
    pidgin: [['No tell big-folk.', 'firm'], ['Hmph. No.', 'turning away']] } },
  { id: 'lk.price', cat: 'answer', when: 'price', mood: 'cold', core: true, tiers: {
    native: [['Momo? Momo!', 'hand out']],
    mixed: [['Momo first, then tell.', 'bargaining']],
    pidgin: [['Give shroom, then tell.', 'sly']] } },
  { id: 'lk.want', cat: 'talk', when: 'talk:needs, has a want', mood: 'warm', core: true, tiers: {
    native: [['Momo-momo!', 'drooling']],
    mixed: [['Want momo! Mip mip!', 'hopping']],
    pidgin: [['Want shroom! Love shroom!', 'pleading']] } },
  { id: 'lk.content', cat: 'talk', when: 'talk:needs, no want', mood: 'warm', core: true, tiers: {
    native: [['Loo-loo.', 'humming']],
    mixed: [['Loo-loo. Need nothing.', 'cosy']],
    pidgin: [['Need nothing. Happy.', 'cosy']] } },
  { id: 'lk.thanks', cat: 'tell', when: 'give, wanted', mood: 'warm', core: true, tiers: {
    native: [['Tikka! Tikka! Tikka!', 'overjoyed']],
    mixed: [['Tikka! Friend! Friend!', 'overjoyed']],
    pidgin: [['Friend! Friend! Thank!', 'overjoyed']] } },
  { id: 'lk.polite', cat: 'tell', when: 'give, not wanted', mood: 'neutral', core: false, tiers: {
    native: [['Hm. Mip.', 'polite']],
    mixed: [['Hm. Thank.', 'polite']],
    pidgin: [['Hm. Thank.', 'polite, puzzled']] } },
  { id: 'lk.believe', cat: 'tell', when: 'tell, adopted', mood: 'neutral', core: true, tiers: {
    native: [['Oo! Mip.', 'wide-eyed']],
    mixed: [['Oo! Leafkin see.', 'wide-eyed']],
    pidgin: [['Oh! Leafkin see.', 'impressed']] } },
  { id: 'lk.caught', cat: 'tell', when: 'tell, caught', mood: 'angry', core: true, tiers: {
    native: [['Nu! Brrm! Brrm!', 'stamping']],
    mixed: [['Brrm! Big-folk lie!', 'stamping']],
    pidgin: [['Liar! Big-folk lie!', 'furious, tiny']] } },
  { id: 'lk.fear', cat: 'worry', when: 'danger near, fleeing', mood: 'distress', core: true, tiers: {
    native: [['Keesh! Keesh!', 'shriek'], ['Fwee! Fwee!', 'running']],
    mixed: [['Keesh! Run!', 'shriek']],
    pidgin: [['Bad-dark! Run!', 'shriek'], ['Hide! Hide!', 'panicked']] } },
  { id: 'lk.uneasy', cat: 'worry', when: 'night, or something odd', mood: 'neutral', core: false, tiers: {
    native: [['Brrm...', 'shivering whisper']],
    mixed: [['Brrm... nu like.', 'whisper']],
    pidgin: [['Bad-dark here.', 'whisper'], ['No like this.', 'huddled']] } },
  { id: 'lk.curious', cat: 'social', when: 'something new nearby', mood: 'neutral', core: true, tiers: {
    native: [['Wa? Wa-wa?', 'tilted head']],
    mixed: [['Wa? What that?', 'sniffing']],
    pidgin: [['What that? Show!', 'eager']] } },
  { id: 'lk.happy', cat: 'social', when: 'fed, playing, warm', mood: 'warm', core: true, tiers: {
    native: [['Loo-loo-loo!', 'giggling'], ['Mip-mip-mip!', 'bouncing']],
    mixed: [['Loo-loo! Happy!', 'giggling']],
    pidgin: [['Happy! Happy!', 'twirling']] } },
  { id: 'lk.sky', cat: 'ambient', when: 'aurora overhead', mood: 'warm', core: false, tiers: {
    native: [['Oooo...', 'awed']],
    mixed: [['Oooo... sky loo-loo.', 'awed']],
    pidgin: [['Sky dancing!', 'awed']] } },
  { id: 'lk.lost', cat: 'quest', when: 'a leafkin in trouble or seeking help', mood: 'distress', core: false, tiers: {
    native: [['Pip! Pip!', 'calling, worried']],
    mixed: [['Pip gone! Help!', 'tugging']],
    pidgin: [['Little one gone! Help!', 'tugging'], ['Please! Come!', 'urgent']] } },
  { id: 'lk.nv', cat: 'nonverbal', when: 'anywhere', mood: 'neutral', core: true, tiers: {
    native: [['(giggle)', 'tiny'], ['(squeak)', 'startled'], ['(hum)', 'tuneless'], ['(gasp)', 'sharp']],
    mixed: [],
    pidgin: [] } },
]

/** The performances each line can be recorded in; conversion happens later. `rate` previews playback (leafkin). */
export const TAKES = [
  { id: 'base', label: 'Base (guttural man)', rate: 1 },
  { id: 'elder', label: 'Elder', rate: 1 },
  { id: 'light', label: 'Light (source for female)', rate: 1 },
  { id: 'leafkin', label: 'Leafkin (play fast)', rate: 1.5 },
]
