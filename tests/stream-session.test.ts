import { describe, expect, it } from 'vitest';
import { StreamSession } from '../src/stream-brain/stream-session';

/**
 * The lifecycle bug this exists for: an operator paused a live broadcast for a few seconds and
 * resumed it, and the Brain re-bootstrapped with reason `stream_start` and `currentSessionEvents:
 * 0` — the same evening, entered as a stranger, followed by the usual cold-start default message.
 * A rollover in the same run kept all 25 events, because a rollover does not touch the clock the
 * bootstrap was reading. This owns the other clock.
 */
describe('which evening this is', () => {
  const at = (start: number) => {
    let clock = start;
    let counter = 0;
    const session = new StreamSession({
      now: () => clock,
      newId: () => `session-${(counter += 1)}`,
      continuityGraceMs: 15 * 60_000,
    });
    return { session, advance: (ms: number) => { clock += ms; }, clockAt: () => clock };
  };

  it('starts an evening when nothing was running', () => {
    const { session } = at(1_000);
    const { session: snapshot, continuity } = session.begin();
    expect(continuity).toBe('new');
    expect(snapshot.startedAt).toBe(1_000);
    expect(snapshot.hasSentAiMessage).toBe(false);
    expect(session.isStrictColdStart()).toBe(true);
  });

  it('treats an operator pause and resume as the same evening', () => {
    // Case E. Messages were already sent before the pause, so the first-message gate must stay down.
    const { session, advance } = at(1_000);
    const first = session.begin('broadcast-1').session;
    session.markMessageSent();
    advance(20_000);
    const { session: resumed, continuity } = session.begin('broadcast-1');
    expect(continuity).toBe('resumed');
    expect(resumed.id).toBe(first.id);
    expect(resumed.startedAt).toBe(first.startedAt);
    expect(resumed.hasSentAiMessage).toBe(true);
    expect(session.isStrictColdStart()).toBe(false);
  });

  it('starts a new evening when Twitch reports a different broadcast', () => {
    // Case F. Same channel, genuinely new stream: everything resets, gate included.
    const { session, advance } = at(1_000);
    const first = session.begin('broadcast-1').session;
    session.markMessageSent();
    advance(4 * 60 * 60_000);
    const { session: second, continuity } = session.begin('broadcast-2');
    expect(continuity).toBe('new');
    expect(second.id).not.toBe(first.id);
    expect(second.hasSentAiMessage).toBe(false);
    expect(session.isStrictColdStart()).toBe(true);
  });

  it('ends the evening mid-flight when the broadcast id changes under it', () => {
    const { session } = at(1_000);
    session.begin('broadcast-1');
    session.markMessageSent();
    session.observeBroadcast('broadcast-2');
    expect(session.snapshot()).toBeUndefined();
    expect(session.isStrictColdStart()).toBe(true);
  });

  it('attaches a late broadcast id to the session already running', () => {
    // Helix is polled on a timer, so the first minutes of an evening often have no id at all.
    const { session, advance } = at(1_000);
    const first = session.begin().session;
    expect(first.broadcastId).toBeUndefined();
    session.observeBroadcast('broadcast-1');
    advance(5_000);
    const { session: resumed, continuity } = session.begin('broadcast-1');
    expect(continuity).toBe('resumed');
    expect(resumed.id).toBe(first.id);
    expect(resumed.broadcastId).toBe('broadcast-1');
  });

  it('falls back to the gap when Twitch has told it nothing', () => {
    // Case H: a media reconnect is seconds and keeps the session. A gap of hours does not.
    const short = at(1_000);
    short.session.begin();
    short.session.markMessageSent();
    short.advance(30_000);
    expect(short.session.begin().continuity).toBe('resumed');
    expect(short.session.isStrictColdStart()).toBe(false);

    const long = at(1_000);
    long.session.begin();
    long.session.markMessageSent();
    long.advance(60 * 60_000);
    expect(long.session.begin().continuity).toBe('new');
    expect(long.session.isStrictColdStart()).toBe(true);
  });

  it('measures the gap from the last thing observed, not from when the session opened', () => {
    // A long uneventful stretch mid-broadcast is not the gap between two evenings.
    const { session, advance } = at(1_000);
    session.begin();
    session.markMessageSent();
    for (let index = 0; index < 6; index += 1) {
      advance(10 * 60_000);
      session.touch();
    }
    advance(60_000);
    expect(session.begin().continuity).toBe('resumed');
  });

  it('keeps the gate up until a message has actually reached Twitch', () => {
    // Case I. Generated, selected, accepted and then failed to send is still nothing said.
    const { session } = at(1_000);
    session.begin();
    expect(session.isStrictColdStart()).toBe(true);
    session.markMessageSent();
    // Case J: and once one lands, the gate is down for the rest of the evening.
    expect(session.isStrictColdStart()).toBe(false);
    session.markMessageSent();
    expect(session.snapshot()?.hasSentAiMessage).toBe(true);
  });

  it('reports cold start when no evening is running at all', () => {
    const { session } = at(1_000);
    expect(session.isStrictColdStart()).toBe(true);
    session.begin();
    session.markMessageSent();
    session.end();
    expect(session.snapshot()).toBeUndefined();
    expect(session.isStrictColdStart()).toBe(true);
  });
});

/**
 * The bug the strict window exists to fix: a live run held every account silent for seven minutes
 * and twelve seconds — eighteen stream-event decisions and three Persona Drive calls, every one of
 * them returning complete silence — because `hasSentAiMessage=false` alone was allowed to hold the
 * bar up indefinitely. `active` must now turn itself off on a clock even if nothing was ever sent,
 * and `hasSentAiMessage` must go on meaning exactly what it always meant: this is two independent
 * facts, not one renamed.
 */
describe('the strict first-message window', () => {
  const windowed = (start: number, coldStartWindowMs = 60_000) => {
    let clock = start;
    let counter = 0;
    const session = new StreamSession({
      now: () => clock,
      newId: () => `session-${(counter += 1)}`,
      coldStartWindowMs,
    });
    return { session, advance: (ms: number) => { clock += ms; } };
  };

  it('stays active for the configured window and turns itself off without a message ever landing', () => {
    // Case C. The formula this exists to prevent: no time bound, so "nobody has spoken yet" and
    // "the bar is up" were the same fact forever.
    const { session, advance } = windowed(1_000);
    session.begin();
    expect(session.isStrictColdStart()).toBe(true);
    advance(59_000);
    expect(session.isStrictColdStart()).toBe(true);
    advance(2_000);
    // hasSentAiMessage is still false — nothing was ever forced — but the elevated bar is gone.
    expect(session.snapshot()?.hasSentAiMessage).toBe(false);
    expect(session.isStrictColdStart()).toBe(false);
  });

  it('turns off the instant a message lands, without waiting for the timer', () => {
    // Case F from the naturalness-guard round, reused here: a good moment at 32 seconds must not
    // wait for the clock to finish a window it has already earned its way out of.
    const { session, advance } = windowed(1_000);
    session.begin();
    advance(32_000);
    expect(session.isStrictColdStart()).toBe(true);
    session.markMessageSent();
    expect(session.isStrictColdStart()).toBe(false);
    advance(1_000);
    expect(session.isStrictColdStart()).toBe(false);
  });

  it('never reopens the bar once the window has expired, even long after', () => {
    // Ordinary quiet stretches later in the stream must not look like a second cold start.
    const { session, advance } = windowed(1_000);
    session.begin();
    advance(90_000);
    expect(session.isStrictColdStart()).toBe(false);
    advance(30 * 60_000);
    expect(session.isStrictColdStart()).toBe(false);
  });

  it('reports the full diagnostic picture, not just the one bit', () => {
    const { session, advance } = windowed(1_000);
    session.begin();
    advance(10_000);
    const early = session.coldStartStatus();
    expect(early).toEqual({ active: true, ageMs: 10_000, windowMs: 60_000, hasSentAiMessage: false, expired: false });

    advance(55_000);
    const late = session.coldStartStatus();
    expect(late).toMatchObject({ active: false, ageMs: 65_000, hasSentAiMessage: false, expired: true });
  });

  it('is never expired while a message has been sent, however old the session is', () => {
    const { session, advance } = windowed(1_000);
    session.begin();
    session.markMessageSent();
    advance(10 * 60_000);
    expect(session.coldStartStatus()).toMatchObject({ active: false, expired: false, hasSentAiMessage: true });
  });

  it('keeps counting through an operator pause: the window is the evening\'s clock, not the processing clock', () => {
    // Case I/E combined: a pause does not extend the window, and a resume does not reset it — the
    // window is measured against session.startedAt, which a resumed continuity carries over unchanged.
    const { session, advance } = windowed(1_000);
    session.begin('broadcast-1');
    advance(40_000); // 40s into the evening, still strict
    expect(session.isStrictColdStart()).toBe(true);
    // Operator pauses for a while — no touch(), no begin() calls while paused — then resumes.
    advance(20_000); // now 60s of wall-clock time have passed since startedAt
    const { continuity } = session.begin('broadcast-1');
    expect(continuity).toBe('resumed');
    // The window elapsed during the pause; resuming does not grant a fresh 60 seconds.
    expect(session.isStrictColdStart()).toBe(false);
  });

  it('gives a genuinely new broadcast its own full window, even seconds after the last one ended', () => {
    // Case K. A new broadcast id is unambiguous evidence of a new evening regardless of timing.
    const { session, advance } = windowed(1_000);
    session.begin('broadcast-1');
    session.markMessageSent();
    advance(5_000);
    const { continuity } = session.begin('broadcast-2');
    expect(continuity).toBe('new');
    expect(session.isStrictColdStart()).toBe(true);
    expect(session.coldStartStatus().ageMs).toBe(0);
  });

  it('lets a caller choose a different window length', () => {
    const { session, advance } = windowed(1_000, 90_000);
    session.begin();
    advance(75_000);
    expect(session.isStrictColdStart()).toBe(true);
    advance(20_000);
    expect(session.isStrictColdStart()).toBe(false);
  });
});
