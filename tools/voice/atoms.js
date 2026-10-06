// The voice inventory (_notes/conversation-and-quests.md, "Voice"). A clip never names a person, place, direction or
// number -- the panel text carries the fact, the clip carries the act and the mood, so the two can never disagree.
//
// A MOMENT is where the engine wants a clip; an UTTERANCE is a recorded line. One utterance serves every moment its
// reading fits, and a line that needs a different delivery in another moment ("It's getting dark", easy or afraid) is a
// second reading, so a second file. The engine's pool for a moment is every reading that lists it. `{he|she}` in a text
// is a form: each form is its own file, picked by who is meant. Files are `<utterance>.<variant>.<take>.wav`.

/** Moment id -> [when the engine plays it, mood, core]. Core moments are the ones needed to sound alive. */
export const MOMENTS = {
  'greet.stranger': ['opener, standing neutral', 'neutral', true],
  'greet.friend': ['opener, standing > 0.3', 'warm', true],
  'greet.cold': ['opener, standing < -0.2', 'cold', true],
  'greet.morning': ['passing, morning', 'neutral', false],
  'greet.evening': ['passing, dusk or night', 'neutral', false],
  'pass.nod': ['she walks past, no conversation', 'neutral', true],
  'bye.warm': ['bye, standing >= 0', 'warm', true],
  'bye.curt': ['bye, standing < 0 or patience out', 'cold', true],
  'answer.sure': ['a known fact, sure, before the line', 'neutral', true],
  'answer.hedge': ['how.hedge (sure < 0.6)', 'neutral', true],
  'answer.unknown': ['_dunno', 'neutral', true],
  'answer.boast': ['how.boast', 'neutral', true],
  'answer.again': ['how.again (asked before)', 'neutral', true],
  'answer.nervous': ['a lie from a poor liar', 'neutral', false],
  'refuse.wary': ['_refuse (wariness)', 'cold', true],
  'refuse.price': ['price (greed > 0.6)', 'cold', true],
  'tell.believe': ['tell, belief adopted', 'neutral', true],
  'tell.caught': ['tell, lie caught', 'angry', true],
  'give.thanks': ['give, a wanted item', 'warm', true],
  'give.polite': ['give, not wanted', 'neutral', true],
  'talk.self': ['talk:self, before the line', 'neutral', true],
  'talk.town': ['talk:town, before the line', 'neutral', false],
  'needs.yes': ['talk:needs, has a want', 'neutral', true],
  'needs.no': ['talk:needs, no want', 'warm', true],
  'missing.plea': ['someone who cares hails her, quest untaken', 'distress', true],
  'missing.child': ['the plea, when the missing one is their child', 'distress', true],
  'missing.worry': ['the one who cares, broadcast in earshot', 'distress', true],
  'missing.late': ['broadcast, hours on or at dusk', 'distress', true],
  'missing.found': ['the missing one brought home, to her', 'warm', true],
  'missing.reunion': ['the missing one brought home, to the one found', 'warm', true],
  'missing.sympathy': ['townsfolk broadcast during the search', 'neutral', false],
  'witness.lead': ['a witness, before the sighting', 'neutral', true],
  'errand.ask': ['giver offers a message', 'neutral', true],
  'errand.recall': ['recipient asks the words', 'neutral', true],
  'errand.true': ['true words delivered', 'warm', true],
  'errand.garbled': ['garbled words delivered', 'cold', true],
  'observe.dusk': ['evening, at ease', 'neutral', false],
  'observe.marvel': ['something remarkable in view', 'warm', true],
  'weather.cold': ['cold or windy', 'neutral', true],
  'weather.fine': ['clear day', 'warm', true],
  'weather.foul': ['rain, snow or storm', 'neutral', true],
  'sky.aurora': ['aurora overhead', 'warm', true],
  'mood.bored': ['idle, nothing happening', 'neutral', true],
  'mood.busy': ['working, or hailed while walking', 'neutral', true],
  'mood.tired': ['late evening, heading home', 'neutral', false],
  'mood.hungry': ['near meal hours', 'neutral', false],
  'mood.content': ['warm standing, calm town', 'warm', false],
  'worry.general': ['a hard season, low stores', 'neutral', true],
  'worry.winter': ['cold season', 'neutral', false],
  'worry.beast': ['a predator near town', 'neutral', false],
  'worry.leafkin': ['leafkin seen near town', 'neutral', false],
  'fear.uneasy': ['night, or after an alarm', 'neutral', true],
  'fear.danger': ['danger in sight: fire, wild strider, dragon', 'distress', true],
  'gossip.lead': ['two folk stop to talk, opener', 'neutral', true],
  'gossip.react': ['the other one, reply', 'neutral', true],
  'social.agree': ['listening, reply', 'neutral', true],
  'social.disagree': ['listening, rival or sceptic', 'cold', true],
  'social.curious': ['something new: a beast, a stranger', 'neutral', true],
  'social.surprise': ['startled: she appears, a sound', 'neutral', true],
  'hail.attention': ['they want her: an errand, a want', 'neutral', true],
  'react.animal': ['she leads a tamed beast past', 'warm', false],
  'home.welcome': ['she enters their house, standing warm', 'warm', false],
  'home.intrude': ['she enters their house, cold or stranger', 'angry', false],
  'nv.laugh': ['gossip, warm standing, a joke', 'warm', true],
  'nv.sigh': ['bored, tired, worried', 'neutral', true],
  'nv.think': ['before a hedge, pondering', 'neutral', true],
  'nv.cough': ['idle, cold, a sickbed', 'neutral', true],
  'nv.effort': ['working: chopping, lifting', 'neutral', false],
  'nv.cold': ['cold weather idle', 'neutral', false],
  'nv.yawn': ['late, tired', 'neutral', false],
}

// One utterance: id, recording group, text, then its readings as [acting note, ...moments].
const u = (id, cat, text, ...reads) => ({ id, cat, text, reads: reads.map(([note, ...uses]) => ({ note, uses })) })

/** Human utterances: `{ id, cat, text, reads: [{ note, uses }] }`. */
export const HUMAN = [
  // --- greeting and parting
  u('well-met', 'greet', 'Well met.', ['polite, a little reserved', 'greet.stranger']),
  u('good-day', 'greet', 'Good day to you.', ['warm, unhurried', 'greet.stranger', 'pass.nod']),
  u('hail-traveller', 'greet', 'Hail, traveller.', ['formal, chin up', 'greet.stranger']),
  u('good-to-see', 'greet', 'Good to see you!', ['genuine, bright', 'greet.friend']),
  u('there-you-are', 'greet', 'Ah, there you are!', ['as if you were expected', 'greet.friend', 'hail.attention']),
  u('back-again', 'greet', 'Back again?', ['pleased, teasing', 'greet.friend'], ['flat, unwelcome', 'greet.cold']),
  u('you-again', 'greet', 'You again.', ['flat', 'greet.cold']),
  u('what-now', 'greet', 'What now?', ['impatient', 'greet.cold'], ['weary, at bad news', 'worry.general']),
  u('hmph-you', 'greet', 'Hmph. You.', ['a grunt first', 'greet.cold']),
  u('morning', 'greet', 'Morning.', ['brisk nod', 'greet.morning', 'pass.nod']),
  u('up-early', 'greet', 'Up early, are we?', ['amused', 'greet.morning']),
  u('evening', 'greet', 'Evening.', ['tired, kind', 'greet.evening', 'pass.nod']),
  u('late-to-be-out', 'greet', 'Late to be out.', ['mild warning', 'greet.evening', 'fear.uneasy']),
  u('hm-hello', 'greet', 'Hm, hello.', ['barely looking up', 'pass.nod']),
  u('hey-there', 'greet', 'Hey there.', ['easy', 'pass.nod', 'greet.stranger']),
  u('safe-roads', 'greet', 'Safe roads.', ['the stock blessing', 'bye.warm']),
  u('go-well', 'greet', 'Go well.', ['soft', 'bye.warm']),
  u('mind-the-cold', 'greet', 'Mind the cold out there.', ['fond', 'bye.warm', 'weather.cold']),
  u('get-home-safe', 'greet', 'Get home safe, now.', ['parental', 'bye.warm', 'greet.evening']),
  u('thats-all', 'greet', "That's all.", ['turning away', 'bye.curt']),
  u('off-with-you', 'greet', 'Off with you, then.', ['shooing', 'bye.curt']),
  u('were-done', 'greet', "We're done here.", ['final', 'bye.curt']),

  // --- answering
  u('that-i-know', 'answer', 'Oh, that I know.', ['pleased to help', 'answer.sure']),
  u('easy', 'answer', 'Easy.', ['quick', 'answer.sure']),
  u('listen', 'answer', 'Listen.', ['leaning in', 'answer.sure', 'witness.lead', 'gossip.lead']),
  u('i-think', 'answer', 'Hmm, I think...', ['trailing, searching', 'answer.hedge']),
  u('if-i-remember', 'answer', 'If I remember right...', ['squinting at the past', 'answer.hedge', 'witness.lead']),
  u('dont-hold-me', 'answer', "Don't hold me to it, but...", ['shrugging', 'answer.hedge', 'witness.lead']),
  u('no-idea', 'answer', 'No idea.', ['plain', 'answer.unknown']),
  u('couldnt-tell', 'answer', "Couldn't tell you.", ['apologetic', 'answer.unknown']),
  u('never-heard', 'answer', 'Never heard of it.', ['puzzled', 'answer.unknown']),
  u('everyone-knows', 'answer', 'Ha! Everyone knows that.', ['too loud', 'answer.boast']),
  u('own-eyes', 'answer', 'Saw it with my own eyes.', ['chest out', 'answer.boast', 'witness.lead']),
  u('trust-me', 'answer', 'Trust me.', ['oily confidence', 'answer.boast'], ['earnest, pleading', 'missing.plea']),
  u('like-i-said', 'answer', 'Like I said...', ['patient', 'answer.again']),
  u('as-i-told', 'answer', 'As I told you.', ['a touch tired', 'answer.again']),
  u('er-well', 'answer', 'Oh! Er... well...', ['caught off guard', 'answer.nervous']),
  u('let-me-think', 'answer', 'Um. Let me think.', ['stalling', 'answer.nervous'], ['honestly thinking', 'answer.hedge']),
  u('right-yes', 'answer', 'Ah... right. Yes.', ['too quick', 'answer.nervous']),
  u('why-know', 'answer', 'Why do you want to know?', ['narrowed eyes', 'refuse.wary']),
  u('not-your-business', 'answer', "That's not your business.", ['firm', 'refuse.wary']),
  u('dont-know-you', 'answer', "I don't know you.", ['stepping back', 'refuse.wary']),
  u('whats-it-worth', 'answer', "What's it worth to you?", ['sly', 'refuse.price']),
  u('not-for-free', 'answer', 'Not for free.', ['blunt', 'refuse.price']),
  u('bring-something', 'answer', 'Bring me something first.', ['businesslike', 'refuse.price']),

  // --- told things and gifts
  u('is-that-so', 'tell', 'Is that so.', ['thoughtful', 'tell.believe', 'gossip.react']),
  u('truly', 'tell', 'Truly?', ['eyebrows up', 'tell.believe', 'gossip.react']),
  u('well-ill-be', 'tell', "Well, I'll be.", ['won over', 'tell.believe', 'observe.marvel']),
  u('thats-a-lie', 'tell', "That's a lie.", ['cold anger', 'tell.caught']),
  u('who-told-you', 'tell', 'Who told you that?', ['suspicious', 'tell.caught'], ['delighted, nosy', 'gossip.react']),
  u('dont-lie', 'tell', "Don't lie to me.", ['hurt and hard', 'tell.caught']),
  u('wont-forget', 'tell', "Oh! I won't forget this.", ['moved', 'give.thanks', 'missing.found']),
  u('thank-you-truly', 'tell', 'Thank you, truly.', ['quiet', 'give.thanks', 'errand.true', 'missing.found']),
  u('owe-you', 'tell', 'I owe you one.', ['grinning', 'give.thanks']),
  u('thats-kind', 'tell', "That's kind of you.", ['polite, puzzled', 'give.polite']),
  u('oh-thank-you', 'tell', 'Oh. Thank you.', ['what is this?', 'give.polite']),
  u('hm-all-right', 'tell', 'Hm. All right.', ['pocketing it anyway', 'give.polite'], ['grudging yes', 'social.agree']),

  // --- talk
  u('not-much-to-tell', 'talk', 'Me? Not much to tell.', ['modest', 'talk.self']),
  u('keep-busy', 'talk', 'I keep busy.', ['proud of it', 'talk.self', 'mood.busy']),
  u('born-raised', 'talk', 'Born and raised here.', ['settled', 'talk.self', 'talk.town']),
  u('quiet-place', 'talk', "It's a quiet place.", ['content', 'talk.town']),
  u('good-people', 'talk', 'Good people, mostly.', ['a wry pause', 'talk.town']),
  u('now-you-ask', 'talk', 'Now that you ask...', ['brightening', 'needs.yes', 'witness.lead']),
  u('one-thing', 'talk', 'There is one thing.', ['hopeful', 'needs.yes', 'errand.ask']),
  u('use-a-hand', 'talk', 'I could use a hand.', ['humble', 'needs.yes', 'hail.attention']),
  u('all-right-thanks', 'talk', "I'm all right, thank you.", ['kind', 'needs.no']),
  u('have-what-i-need', 'talk', 'I have what I need.', ['content', 'needs.no', 'mood.content']),

  // --- someone missing: a child, a partner, a friend, the town's sellsword, the elder
  u('need-help', 'missing', 'Please, I need help!', ['breathless', 'missing.plea']),
  u('you-there-please', 'missing', 'You there! Please!', ['reaching out', 'missing.plea', 'hail.attention']),
  u('someones-missing', 'missing', "Someone's gone missing!", ['panicked', 'missing.plea'], ['hushed, to a neighbour', 'gossip.lead']),
  u('cant-find-child', 'missing', "I can't find my child!", ['near tears', 'missing.child']),
  u('never-came-home', 'missing', '{He|She} never came home.', ['barely holding it', 'missing.plea', 'missing.worry']),
  u('never-gone-long', 'missing', "{He's|She's} never been gone this long.", ['pacing', 'missing.worry']),
  u('where-could-be', 'missing', 'Where could {he|she} be?', ['to no one', 'missing.worry']),
  u('anyone-seen', 'missing', 'Has anyone seen {him|her}?', ['calling out', 'missing.worry']),
  u('getting-dark', 'missing', "It's getting dark...", ['easy, an evening remark', 'observe.dusk'], ['dread', 'missing.late', 'fear.uneasy']),
  u('no-time', 'missing', "Please, there's no time.", ['desperate', 'missing.late']),
  u('every-hour', 'missing', 'Every hour counts.', ['grim', 'missing.late']),
  u('thank-the-stars', 'missing', 'Oh, thank the stars!', ['sobbing laugh', 'missing.found', 'missing.reunion']),
  u('you-found', 'missing', 'You found {him|her}!', ['disbelief', 'missing.found']),
  u('lost-you', 'missing', "I thought I'd lost you.", ['hugging, muffled', 'missing.reunion']),
  u('youre-safe', 'missing', "You're safe!", ['relief', 'missing.reunion'], ['to her, back from danger', 'greet.friend']),
  u('poor-soul', 'missing', 'Poor soul.', ['shaking head', 'missing.sympathy']),
  u('terrible-business', 'missing', 'Terrible business.', ['grim', 'missing.sympathy', 'worry.general']),
  u('hope-found', 'missing', "I hope {he's|she's} found soon.", ['quiet', 'missing.sympathy']),
  u('saw-something', 'missing', 'I saw something.', ['lowered voice', 'witness.lead']),
  u('might-have-seen', 'missing', 'I might have seen {him|her|it}.', ['unsure', 'witness.lead']),

  // --- the message
  u('carry-message', 'errand', 'Will you carry a message for me?', ['hopeful', 'errand.ask']),
  u('someone-i-trust', 'errand', 'I need someone I can trust.', ['searching your face', 'errand.ask', 'missing.plea']),
  u('tell-me-words', 'errand', 'Tell me the words. Exactly.', ['intent', 'errand.recall']),
  u('go-on', 'errand', 'Go on...', ['braced', 'errand.recall'], ['hooked', 'gossip.react']),
  u('weight-off', 'errand', "That's a weight off.", ['exhale', 'errand.true', 'missing.found']),
  u('good-good', 'errand', 'Good. Good.', ['nodding slowly', 'errand.true', 'social.agree']),
  u('makes-no-sense', 'errand', 'That makes no sense.', ['confused, then cold', 'errand.garbled', 'social.disagree']),
  u('doesnt-sound-right', 'errand', "That doesn't sound right.", ['offended', 'errand.garbled', 'tell.caught']),

  // --- what they see: weather, sky, the remarkable
  u('look-at-that', 'ambient', 'Well, look at that.', ['impressed', 'observe.marvel', 'react.animal', 'sky.aurora'], ['wry, at trouble', 'worry.general']),
  u('never-tired', 'ambient', 'Never get tired of that.', ['soft', 'sky.aurora', 'observe.marvel']),
  u('lights-out', 'ambient', 'The lights are out tonight.', ['hushed wonder', 'sky.aurora']),
  u('sky-dancing', 'ambient', "Look, the sky's dancing.", ['childlike', 'sky.aurora']),
  u('bitter-cold', 'ambient', 'Bitter cold today.', ['rubbing hands', 'weather.cold']),
  u('feel-wind', 'ambient', 'Feel that wind.', ['hunched', 'weather.cold', 'weather.foul']),
  u('smell-snow', 'ambient', "Snow's coming. I can smell it.", ['sniffing', 'weather.cold', 'worry.winter']),
  u('fine-day', 'ambient', 'Fine day.', ['content', 'weather.fine', 'pass.nod']),
  u('look-at-sky', 'ambient', 'Look at that sky.', ['gazing up', 'weather.fine', 'weather.foul', 'sky.aurora']),
  u('sun-out', 'ambient', "Sun's out, for once.", ['wry', 'weather.fine']),
  u('rain-again', 'ambient', 'Rain again.', ['sighing', 'weather.foul']),
  u('storm-brewing', 'ambient', "Storm's brewing.", ['eyeing the clouds', 'weather.foul', 'fear.uneasy']),
  u('get-indoors', 'ambient', 'Best get indoors.', ['hurrying', 'weather.foul', 'fear.uneasy']),

  // --- the body and the day
  u('nothing-happens', 'ambient', 'Nothing ever happens here.', ['sulky', 'mood.bored']),
  u('long-day', 'ambient', 'Another long day.', ['sigh', 'mood.bored', 'mood.tired']),
  u('hum', 'ambient', 'Hmm, hmm, hmm...', ['humming a tune', 'mood.bored', 'mood.content']),
  u('busy-busy', 'ambient', 'Busy, busy.', ['muttered', 'mood.busy']),
  u('no-rest', 'ambient', 'No rest today.', ['cheerful grumble', 'mood.busy']),
  u('cant-stop', 'ambient', "Can't stop, sorry.", ['over the shoulder', 'mood.busy']),
  u('back-aches', 'ambient', 'My back aches.', ['groaning', 'mood.tired']),
  u('bed-soon', 'ambient', 'Bed soon.', ['drowsy', 'mood.tired']),
  u('eat-a-horse', 'ambient', 'I could eat a horse.', ['hearty', 'mood.hungry']),
  u('whats-supper', 'ambient', "What's for supper?", ['hopeful', 'mood.hungry']),
  u('the-life', 'ambient', 'Ahh, this is the life.', ['stretching', 'mood.content']),
  u('cant-complain', 'ambient', "Can't complain.", ['easy', 'mood.content', 'needs.no']),

  // --- worry and fear
  u('hard-times', 'worry', 'Hard times.', ['heavy', 'worry.general', 'missing.sympathy']),
  u('what-will-we-do', 'worry', 'What will we do?', ['fretting', 'worry.general', 'missing.worry']),
  u('i-worry', 'worry', 'I worry, you know.', ['confiding', 'worry.general', 'missing.worry']),
  u('stores-last', 'worry', 'Will the stores last the winter?', ['counting', 'worry.winter']),
  u('long-winter', 'worry', 'Long winter ahead.', ['grim', 'worry.winter']),
  u('at-the-livestock', 'worry', "Something's been at the livestock.", ['angry and scared', 'worry.beast']),
  u('saw-tracks', 'worry', 'Saw tracks this morning.', ['low', 'worry.beast', 'witness.lead']),
  u('doors-shut', 'worry', 'Keep your doors shut tonight.', ['warning', 'worry.beast', 'fear.uneasy']),
  u('little-folk', 'worry', 'Little folk in the woods again.', ['suspicious', 'worry.leafkin']),
  u('fairy-stories', 'worry', 'Fairy stories, all of it.', ['scoffing', 'worry.leafkin', 'social.disagree']),
  u('dont-like-this', 'worry', "I don't like this.", ['tense', 'fear.uneasy', 'missing.late']),
  u('not-right', 'worry', "Something's not right.", ['looking around', 'fear.uneasy', 'missing.worry']),
  u('hear-that', 'worry', 'Did you hear that?', ['freezing', 'fear.uneasy'], ['eager, gossip', 'gossip.lead']),
  u('look-out', 'worry', 'Look out!', ['shout', 'fear.danger']),
  u('run', 'worry', 'Run!', ['shout, fleeing', 'fear.danger']),
  u('get-inside', 'worry', 'Get inside!', ['shout, waving', 'fear.danger']),

  // --- two folk talking, and noticing
  u('did-you-hear', 'social', 'Did you hear?', ['eager', 'gossip.lead']),
  u('never-guess', 'social', "You'll never guess...", ['delighted', 'gossip.lead']),
  u('between-us', 'social', 'Between you and me...', ['whispered', 'gossip.lead', 'witness.lead']),
  u('no', 'social', 'No!', ['scandalised', 'gossip.react'], ['refusing, sharp', 'refuse.wary']),
  u('really', 'social', 'Really?', ['hooked', 'gossip.react', 'tell.believe']),
  u('dont-believe', 'social', "I don't believe it.", ['amazed', 'gossip.react', 'observe.marvel'], ['flat, sceptical', 'tell.caught']),
  u('aye', 'social', 'Aye.', ['nod', 'social.agree']),
  u('thats-right', 'social', "That's right.", ['firm', 'social.agree']),
  u('true-enough', 'social', 'True enough.', ['thoughtful', 'social.agree']),
  u('nonsense', 'social', 'Nonsense.', ['dismissive', 'social.disagree', 'tell.caught']),
  u('dont-think-so', 'social', "I don't think so.", ['polite doubt', 'social.disagree']),
  u('bah', 'social', 'Bah.', ['waving it off', 'social.disagree', 'mood.bored']),
  u('whats-that', 'social', "Hm? What's that?", ['turning', 'social.curious']),
  u('whats-this', 'social', "Now what's this?", ['intrigued', 'social.curious', 'react.animal']),
  u('whos-that', 'social', "Who's that, then?", ['peering', 'social.curious']),
  u('oh', 'social', 'Oh!', ['jump', 'social.surprise'], ['delighted', 'give.thanks']),
  u('whoa', 'social', 'Whoa!', ['stepping back', 'social.surprise', 'react.animal']),
  u('by-the-gods', 'social', 'By the gods!', ['hand to chest', 'social.surprise', 'observe.marvel']),
  u('hey-you', 'social', 'Hey, you!', ['calling across', 'hail.attention'], ['angry', 'home.intrude']),
  u('over-here', 'social', 'Over here!', ['waving', 'hail.attention']),
  u('a-moment', 'social', 'A moment, friend?', ['polite call', 'hail.attention']),

  // --- reactions to her
  u('fine-beast', 'react', 'What a fine beast!', ['admiring', 'react.animal']),
  u('thing-tame', 'react', 'Is that thing tame?', ['wary', 'react.animal']),
  u('warm-yourself', 'react', 'Come in, warm yourself.', ['hospitable', 'home.welcome']),
  u('make-at-home', 'react', 'Make yourself at home.', ['easy', 'home.welcome']),
  u('my-house', 'react', 'This is my house!', ['outraged', 'home.intrude']),
  u('get-out', 'react', 'Get out of there!', ['shout', 'home.intrude']),
  u('doing-in-here', 'react', 'What are you doing in here?', ['alarmed', 'home.intrude'], ['pleasantly surprised', 'home.welcome']),

  // --- non-verbal: free to use anywhere the moment fits
  u('chuckle', 'nonverbal', '(chuckle)', ['short, closed mouth', 'nv.laugh', 'mood.content']),
  u('laugh', 'nonverbal', '(laugh)', ['one good belly laugh', 'nv.laugh', 'gossip.react']),
  u('snort', 'nonverbal', '(snort)', ['derisive', 'nv.laugh', 'social.disagree']),
  u('sigh-long', 'nonverbal', '(long sigh)', ['weary', 'nv.sigh', 'mood.bored', 'mood.tired']),
  u('sigh-worried', 'nonverbal', '(shaky sigh)', ['worried', 'nv.sigh', 'missing.worry', 'worry.general']),
  u('sigh-content', 'nonverbal', '(contented sigh)', ['settling in', 'nv.sigh', 'mood.content']),
  u('huff', 'nonverbal', '(huff)', ['annoyed', 'nv.sigh', 'greet.cold']),
  u('hmm', 'nonverbal', '(hmm)', ['pondering', 'nv.think', 'answer.hedge']),
  u('huh', 'nonverbal', '(huh?)', ['puzzled', 'nv.think', 'social.curious']),
  u('ah', 'nonverbal', '(ah!)', ['remembering', 'nv.think', 'answer.sure']),
  u('tsk', 'nonverbal', '(tsk)', ['disapproving', 'nv.think', 'social.disagree']),
  u('cough-dry', 'nonverbal', '(dry cough)', ['short', 'nv.cough']),
  u('cough-chesty', 'nonverbal', '(chesty cough)', ['rattling', 'nv.cough', 'weather.cold']),
  u('throat-clear', 'nonverbal', '(clears throat)', ['for attention', 'nv.cough', 'hail.attention', 'answer.nervous']),
  u('grunt', 'nonverbal', '(grunt)', ['lifting', 'nv.effort']),
  u('hup', 'nonverbal', '(hup)', ['swinging', 'nv.effort']),
  u('oof', 'nonverbal', '(oof)', ['set it down', 'nv.effort', 'mood.tired']),
  u('brr', 'nonverbal', '(brr)', ['shivering', 'nv.cold', 'weather.cold']),
  u('sniff', 'nonverbal', '(sniff)', ['runny nose', 'nv.cold']),
  u('yawn', 'nonverbal', '(yawn)', ['big', 'nv.yawn', 'mood.tired', 'mood.bored']),
  u('stretch', 'nonverbal', '(stretch groan)', ['satisfied', 'nv.yawn', 'mood.content']),
]

/**
 * Splice experiments (voice-recorder.html, Splice lab): a carrier with a `___` slot and the fillers that may go in it.
 * Each filler is recorded in the whole sentence, and the carrier and fillers alone; the lab cuts and joins them.
 */
export const SPLICES = [
  { id: 'might-have-seen', carrier: 'I might have seen ___.', fillers: ['him', 'her', 'it', 'something'] },
  { id: 'where-could', carrier: 'Where could ___ be?', fillers: ['he', 'she', 'it'] },
  { id: 'never-came-home', carrier: '___ never came home.', fillers: ['He', 'She'] },
  { id: 'head', carrier: 'Head ___ from here.', fillers: ['north', 'south', 'east', 'west'] },
  { id: 'go-to', carrier: 'Go to the ___.', fillers: ['cave', 'inn', 'bridge', 'woods'] },
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
