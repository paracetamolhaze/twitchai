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
    expect(session.isColdStart()).toBe(true);
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
    expect(session.isColdStart()).toBe(false);
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
    expect(session.isColdStart()).toBe(true);
  });

  it('ends the evening mid-flight when the broadcast id changes under it', () => {
    const { session } = at(1_000);
    session.begin('broadcast-1');
    session.markMessageSent();
    session.observeBroadcast('broadcast-2');
    expect(session.snapshot()).toBeUndefined();
    expect(session.isColdStart()).toBe(true);
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
    expect(short.session.isColdStart()).toBe(false);

    const long = at(1_000);
    long.session.begin();
    long.session.markMessageSent();
    long.advance(60 * 60_000);
    expect(long.session.begin().continuity).toBe('new');
    expect(long.session.isColdStart()).toBe(true);
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
    expect(session.isColdStart()).toBe(true);
    session.markMessageSent();
    // Case J: and once one lands, the gate is down for the rest of the evening.
    expect(session.isColdStart()).toBe(false);
    session.markMessageSent();
    expect(session.snapshot()?.hasSentAiMessage).toBe(true);
  });

  it('reports cold start when no evening is running at all', () => {
    const { session } = at(1_000);
    expect(session.isColdStart()).toBe(true);
    session.begin();
    session.markMessageSent();
    session.end();
    expect(session.snapshot()).toBeUndefined();
    expect(session.isColdStart()).toBe(true);
  });
});
