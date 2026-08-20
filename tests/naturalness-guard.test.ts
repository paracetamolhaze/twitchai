import { describe, expect, it } from 'vitest';
import { NaturalnessGuard } from '../src/reaction/naturalness-guard';
import { StreamEvent } from '../src/stream-brain/types';

const guard = new NaturalnessGuard();

function moment(overrides: Partial<StreamEvent>): StreamEvent {
  return {
    id: 'event-1',
    timestamp: 1_700_000_000_000,
    type: 'speech',
    summary: '',
    importance: 0.6,
    confidence: 0.9,
    source: 'transcription',
    directMentions: [],
    ...overrides,
  };
}

const speech = (text: string, overrides: Partial<StreamEvent> = {}): StreamEvent =>
  moment({ summary: text, speech: text, ...overrides });

/**
 * Every rejecting case below is a message this system actually sent to a live Twitch chat, with the
 * moment it answered taken verbatim from the same log. Every accepting case is a shape the guard
 * must not touch — the failure mode of a check like this is not missing a bad message, it is
 * swallowing a good one, and short good messages look superficially identical to short bad ones.
 */
describe('what the naturalness guard turns into silence', () => {
  it('rejects a conclusion the stream had already drawn', () => {
    // 15:24:25. Two people establish they are the same age three times over, and an account
    // announces it in Russian. No word overlaps; the shape is a bare noun and a "therefore".
    const verdict = guard.check({
      message: 'ровесники получается',
      event: speech('S: How old are you? O: Me? 27. S: 27 too. O: 27. Same? S: Yeah, yeah, same. Same.',
        { type: 'question' }),
    });
    expect(verdict).toEqual({ ok: false, reason: 'semantic_echo' });
  });

  it('rejects somebody else\'s opinion handed back with a stamp on it', () => {
    // 15:25:10, after "He's a legend" and "Legend. Yeah, No[o]ne".
    const verdict = guard.check({
      message: 'нунун легенда без вопросов',
      event: speech('O: Legend. Yeah, No[o]ne S: You have good English. O: Yeah, O: recently.'),
    });
    expect(verdict).toEqual({ ok: false, reason: 'borrowed_opinion' });
  });

  it('rejects a subject from the stream with a grade attached and nothing else', () => {
    // 15:26:16, after "I support Yandex" / "Yandex so good" — including the alphabet change.
    const verdict = guard.check({
      message: 'Яндекс это мощно конечно',
      event: speech('O: Maybe... I support Yandex. S: Yandex? Yandex? Oh. Yandex so good.',
        { type: 'question' }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('generic_evaluator');
  });

  it('does not pretend to catch a scene label, which is not separable locally', () => {
    // "Планёрка на улице пошла" is a novel noun over scene words — the same shape as "у него рюкзак
    // больше него", which is a good joke. Telling them apart needs to know what планёрка means, so
    // this class stays with the instruction rather than getting a rule that only fires on fixtures
    // written to make it fire.
    const label = guard.check({
      message: 'планёрка на улице пошла',
      event: moment({
        type: 'visual',
        summary: 'Молодой человек стоит на улице и разговаривает с двумя парнями.',
        visualContext: 'Молодой человек стоит на улице и разговаривает с двумя парнями.',
      }),
    });
    expect(label.ok).toBe(true);
  });
});

/**
 * A second live run, taken once activity was already at a reasonable level (18 sent reactions of 71
 * decisions), surfaced a longer-message version of the same failure — and, just as instructively, a
 * cluster of near-misses that the existing rules already handle correctly for reasons worth pinning
 * explicitly rather than leaving as an accident of the fixtures nobody wrote.
 */
describe('majority echo — a length the first pass did not reach', () => {
  it('rejects most of a short message being the event\'s own words with a laugh on top', () => {
    // 11:58:11. "Как бы я хотела, чтобы все в Доте были добрее" — two of three words reused
    // verbatim, and a laugh does not add a third.
    const verdict = guard.check({
      message: 'добрее в доте ахах',
      event: speech('O: Ну я держусь. O: Как бы я хотела, чтобы все в Доте были добрее. S: Как бы я хотел, чтобы вы все были подо мной. O: Глаз подняли. Скинь мне.',
        { type: 'funny' }),
    });
    expect(verdict).toEqual({ ok: false, reason: 'majority_echo' });
  });

  it('leaves a negated echo alone — the existing negation exemption, not a new rule', () => {
    // 11:41:55. "Фармите, пацаны, главное" — reused almost word for word, but a real live example
    // of why negation stays exempt: this is advice framed as what not to do, not a restatement.
    const verdict = guard.check({
      message: 'главное не отдаваться пока фармите',
      event: speech('O: Да, нормально, да. S: Фармите, пацаны, главное. Всё'),
    });
    expect(verdict.ok).toBe(true);
  });

  it('rejects a bare necessity standing in for a conclusion marker, even at just two content words', () => {
    // 11:54:54, against real (garbled) transcription output. "конца" is the event's own word, and
    // "надо" restates "я хочу... играть всегда" as a duty instead of a want — the same shape
    // semantic_echo already catches for "получается", now reached through NECESSITY_MARKER.
    const verdict = guard.check({
      message: 'до конца надо',
      event: speech('): ... Underlord... Speaker 1 (0 O: ...несвою, блядь. O: O: Я хочу до конца играть всегда. O:'),
    });
    expect(verdict).toEqual({ ok: false, reason: 'semantic_echo' });
  });

  it('does not treat a bare echoed word plus one unrelated word as necessity — the floor is the marker set, not word count', () => {
    // "готов" answering "ты готов?" reuses the event's own word and must stay legal; pairing it with
    // an ordinary second word that is not in NECESSITY_MARKER must not manufacture a rejection either.
    const verdict = guard.check({
      message: 'готов реально',
      event: speech('S: ты готов?', { type: 'question' }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('does not reach for a paraphrase that shares no surface words with the event', () => {
    // 11:39:23. "не гудите... не тильтуйте... чё вы орёте" and "спокойно, без криков" are the same
    // thought with no word in common — meaning, not shape, and majority echo cannot see it any more
    // than the three rules above it can. Honest gap, not a missed catch.
    const verdict = guard.check({
      message: 'спокойно, без криков',
      event: speech('S: Во-первых, не гудите. Во-вторых, не тильтуйте. S: Опять, блядь, ну типа уже вёб S: Не тильтуйте. Чё вы орё'),
    });
    expect(verdict.ok).toBe(true);
  });

  it('still catches a marker-word echo the original three rules were built for, once not addressed to chat', () => {
    // 11:47:43, real event — sent live because perception tagged this as audience:'twitch_chat'
    // when the actual speech ("Пацаны, это камбэк сейчас будет... на низ бежим") is the streamer
    // directing teammates, not talking to chat; the direct-address exemption exists for exactly the
    // case it was built for, and a misclassified audience is a perception-layer question, not a
    // naturalness one. Without that misclassification the existing semantic_echo rule already
    // catches this shape — 'получается' is an inference marker, 'камбэк' is the event's own word,
    // and the one residual word is exactly the tolerance that rule already allows.
    const verdict = guard.check({
      message: 'камбэк пошел получается',
      event: speech('O: Там Заебись. Пацаны, это камбэк сейчас будет. На низ, на низ, пожалуйста. Все на низ бежим. На низ бежим. O: А Лёша, ты ты зафармил крипов? O: На низ На низ, ой, наверх, парни, надо уже идти. O: На низ, на низ. Мы пойдём, если что. Вниз, вниз, пожалуйста. O: За сорок',
        { type: 'question' }),
    });
    expect(verdict).toEqual({ ok: false, reason: 'semantic_echo' });
  });

  it('lets a real Dota reaction through — short, on-topic, and not majority echo', () => {
    // 11:37:49. "Т2 пушат, ребят. Надо дефа" and "тп на базу и встречать" share no surface word at
    // all; short and Dota-vocabulary is not itself a reason to touch a message.
    const verdict = guard.check({
      message: 'тп на базу и встречать',
      event: speech('O: Т2 пушат, ребят. S: Надо дефа'),
    });
    expect(verdict.ok).toBe(true);
  });
});

/**
 * A third live run, on the deployment that first shipped learned policy. Two of the operator's three
 * flagged messages are grounded here against the events they actually answered, pulled from the same
 * production log.
 */
describe('transcript replay — the stream\'s own words in the stream\'s own order', () => {
  it('F. rejects a message that stitches two consecutive speaker turns together and laughs', () => {
    // 12:01:13. Two turns, verbatim, plus a laugh. It passed the old guard because it contains
    // "нет" — the negation exemption read a copied line as this account's disagreement.
    const verdict = guard.check({
      message: 'я умер нет ты жив ахахах',
      event: speech('O: Я умер. O: Нет, ты жив. O: Нету. O: А. O: Рошан у них, походу. ля, надо было оставить, я б добил.'),
    });
    expect(verdict).toEqual({ ok: false, reason: 'transcript_echo' });
  });

  it('G. lets a pure laugh through on the same event', () => {
    const verdict = guard.check({
      message: 'ахахах',
      event: speech('O: Я умер. O: Нет, ты жив. O: Нету. O: А.'),
    });
    expect(verdict.ok).toBe(true);
  });

  it('H. lets a disagreement through on the same event, even though it reuses the words', () => {
    const verdict = guard.check({
      message: 'да ты вообще не умер',
      event: speech('O: Я умер. O: Нет, ты жив. O: Нету. O: А.'),
    });
    expect(verdict.ok).toBe(true);
  });

  it('lets a short quoted fragment through — three words is a phrase, not a replay', () => {
    const verdict = guard.check({
      message: 'не успел уйти',
      event: speech('O: не успел уйти, блядь, там стан был'),
    });
    expect(verdict.ok).toBe(true);
  });

  it('rejects a replay that arrives without any laugh attached', () => {
    const verdict = guard.check({
      message: 'надо было оставить я б добил',
      event: speech('O: Рошан у них, походу. ля, надо было оставить, я б добил.'),
    });
    expect(verdict).toEqual({ ok: false, reason: 'transcript_echo' });
  });

  it('does not treat a scene description as something anyone said', () => {
    // visualContext is written by the perception layer, not spoken, so reproducing it is not a
    // replay of anyone's line. Long enough to clear the short-message rules, so the only thing that
    // could reject it here is transcript replay — and it must not, because nobody said this.
    const verdict = guard.check({
      message: 'мужчина в наушниках сидит за светящейся клавиатурой глядя на монитор',
      event: moment({
        type: 'visual',
        summary: 'кто-то играет',
        visualContext: 'Мужчина в наушниках сидит за светящейся клавиатурой, глядя на монитор.',
      }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('still rejects a replay when the account was the one being addressed', () => {
    // The direct-mention exemption exists because an answer reuses the question's words. Copying
    // four consecutive words of the transcript is not answering, whoever was addressed.
    const verdict = guard.check({
      message: 'я умер нет ты жив',
      event: speech('O: Я умер. O: Нет, ты жив.', { directMentions: ['aaaarrtyom'] }),
    });
    expect(verdict).toEqual({ ok: false, reason: 'transcript_echo' });
  });

  it('leaves a wry label for what just happened alone — the scene-label class, still not local', () => {
    // 11:26:54, the operator's third flagged message. Its event was recoverable from the production
    // log after all: the stream said "завтра уже типа торнамент? Ну тогда бухаем", and the account
    // labelled that as tournament preparation. Nothing overlaps — "турнир" and "торнамент" are not
    // even the same word to a transliteration key — so no surface rule sees it, and it is the same
    // class as "планёрка на улице пошла": naming what a moment amounts to. Deliberately left to
    // learned policy rather than given a rule that would only fire on this fixture.
    const verdict = guard.check({
      message: 'ахаха чисто настрой на турнир',
      event: speech('S: Сегодня ещё... И за всё, и завтра уже типа торнамент? Ну тогда бухаем. Налейте мне кто-нибудь.',
        { type: 'question' }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('leaves a paraphrased punchline alone — one shared word is not a replay', () => {
    // 11:56:48, the other flagged message. The stream had already made the Rapier joke and the
    // account made it again in its own words. Only "рапиру" overlaps, so no surface rule can see
    // it; this is deliberately left to learned policy rather than guessed at here.
    const verdict = guard.check({
      message: 'рапиру сразу бери чего мелочиться ахах',
      event: speech('O: Дальше чё хочешь: хоть Блинк, хоть Хекс, хоть там Рапиру ёбни вообще. O: А, давай. O: Всё, погнали.',
        { type: 'reaction' }),
    });
    expect(verdict.ok).toBe(true);
  });
});

/**
 * The first live run that actually had learned policy in the payload. Both grounded against the
 * events they answered, from the production log.
 */
describe('short echo — the whole message is a word the stream just used', () => {
  it('rejects a greeting handed straight back', () => {
    // 13:02:21. The stream said "Здорово, чат" and the account said "здорово" — the greeting
    // returned rather than answered.
    const verdict = guard.check({
      message: 'здорово',
      event: speech('O: посчитай. 1 2 3. Или на эту, да. S: Здорово, чат. O: А обратно как? О. Толя? S: Сейчас бабах будет.',
        { type: 'question' }),
    });
    expect(verdict).toEqual({ ok: false, reason: 'transcript_echo' });
  });

  it('lets a greeting answered with a different word through', () => {
    for (const message of ['ку', 'дарова', 'привет']) {
      expect(guard.check({
        message,
        event: speech('S: Здорово, чат.', { type: 'question' }),
      }).ok).toBe(true);
    }
  });

  it('lets a short answer through when the word was never in the event', () => {
    const verdict = guard.check({
      message: 'пуджа',
      event: speech('S: кого брать?', { type: 'question' }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('lets a quoted word through when it is asking something', () => {
    const verdict = guard.check({
      message: 'рапира?',
      event: speech('O: там рапира собирается'),
    });
    expect(verdict.ok).toBe(true);
  });

  it('lets a one-word correction through, which is the case this must never break', () => {
    // The existing fixture: "баранина" against "это свинина?" — the word is not in the event, so
    // there is residue and nothing fires.
    const verdict = guard.check({
      message: 'баранина',
      event: speech('S: это свинина? O: не знаю, похоже на свинину', { type: 'question' }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('lets a negated echo through, because a negation is usually a disagreement', () => {
    const verdict = guard.check({
      message: 'не здорово',
      event: speech('S: Здорово, чат.'),
    });
    expect(verdict.ok).toBe(true);
  });

  it('still lets a pure laugh through', () => {
    expect(guard.check({ message: 'ахахах', event: speech('S: Здорово, чат.') }).ok).toBe(true);
  });
});

describe('what the naturalness guard must never touch', () => {
  it('lets a one-word correction through even though it repeats the subject', () => {
    const verdict = guard.check({
      message: 'баранина',
      event: speech('S: это свинина? O: не знаю, похоже на свинину', { type: 'question' }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('lets pure feeling through, which carries no information by definition', () => {
    for (const message of ['ахахах', 'бляя', '??????', 'KEKW', 'ооо']) {
      expect(guard.check({
        message,
        event: speech('S: Yandex so good. O: Yandex is the best'),
      }).ok).toBe(true);
    }
  });

  it('lets an answer through when the chat was the one being addressed', () => {
    // 15:22:56, and the message the guard must not have blocked: "Garena, you know what is this?"
    // answered with "олды на месте".
    const verdict = guard.check({
      message: 'олды на месте',
      event: speech('S: I ICCup, Garena. You know what is this, man?',
        { type: 'question', audience: 'twitch_chat', audienceConfidence: 0.9 }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('lets a disagreement through, which reuses the subject by nature', () => {
    const verdict = guard.check({
      message: 'не лучший он, сильно упал',
      event: speech('O: этот герой лучший сейчас, база'),
    });
    expect(verdict.ok).toBe(true);
  });

  it('lets a question through', () => {
    const verdict = guard.check({
      message: 'а он вообще на инт едет?',
      event: speech('O: He is a legend. S: Yeah, No[o]ne'),
    });
    expect(verdict.ok).toBe(true);
  });

  it('lets a joke through when it targets a detail of its own', () => {
    const verdict = guard.check({
      message: 'у него рюкзак больше него',
      event: moment({
        type: 'visual',
        summary: 'Молодой человек идет по набережной ночного города.',
        visualContext: 'Молодой человек идет по набережной ночного города.',
      }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('lets an account be named without judging the message at all', () => {
    const verdict = guard.check({
      message: 'легенда конечно',
      event: speech('S: gigantiuz что думаешь', { directMentions: ['gigantiuz'] }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('lets a longer message through, where the extra words are carrying something', () => {
    const verdict = guard.check({
      message: 'яндекс мощно конечно, но у них состав второй год не меняется совсем',
      event: speech('O: I support Yandex. S: Yandex so good.'),
    });
    expect(verdict.ok).toBe(true);
  });

  it('does not judge a message with no moment behind it', () => {
    expect(guard.check({ message: 'мощно конечно' }).ok).toBe(true);
  });

  it('leaves an inference marker alone when the message carries a real thought', () => {
    const verdict = guard.check({
      message: 'значит патч сломал ему керри полностью',
      event: speech('O: он вообще не фармит в этой игре'),
    });
    expect(verdict.ok).toBe(true);
  });
});
