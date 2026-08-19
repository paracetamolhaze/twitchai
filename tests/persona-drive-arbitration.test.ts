import { describe, expect, it } from 'vitest';
import { arbitrateDriveReaction, HOOK_TTL_MS } from '../src/personas/persona-drive-arbitration';
import { ChatMessage, StreamEvent } from '../src/stream-brain/types';

function chatMsg(timestamp: number, message: string, username = 'realviewer'): ChatMessage {
  return { id: `${username}-${timestamp}`, timestamp, username, displayName: username, message, kind: 'viewer' };
}

function event(timestamp: number, importance: number, summary: string, overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id: `event-${timestamp}`, timestamp, type: 'speech', summary, importance, confidence: 0.9,
    source: 'transcription', directMentions: [], ...overrides,
  };
}

const GENERATION_STARTED_AT = 1_000_000;
const BASE = {
  reaction: { username: 'karlbekner', message: 'го дальше по классике, чё как' },
  generationStartedAt: GENERATION_STARTED_AT,
  hookSubjectText: 'стример собирает пати в доту, зовёт друзей катку катать',
  now: GENERATION_STARTED_AT + 5_000,
  recentChat: [] as ChatMessage[],
  recentEvents: [] as StreamEvent[],
};

// generationStartedAt is the only clock this function knows about — how old the subject already
// was when generation began is not a parameter here at all, by construction, so there is nothing to
// pin for it at this level. That regression — a drive opportunity built from a five-minute-old
// observation must still send once generation itself was quick — is covered where the real age
// actually enters the picture: persona-drive.test.ts, service-level, against the real call site.
describe('arbitrateDriveReaction', () => {
  it('A. is valid when nothing at all was recorded during generation', () => {
    expect(arbitrateDriveReaction(BASE)).toEqual({ outcome: 'valid' });
  });

  it('B. is valid across an unrelated event at each of the two real, audited false-positive importances (0.4, 0.5)', () => {
    for (const importance of [0.4, 0.5]) {
      const result = arbitrateDriveReaction({
        ...BASE,
        recentEvents: [event(GENERATION_STARTED_AT + 1_000, importance, 'кто-то в чате написал про погоду за окном')],
      });
      expect(result.outcome).toBe('valid');
    }
  });

  it('C. expires once generation is older than HOOK_TTL_MS', () => {
    const result = arbitrateDriveReaction({ ...BASE, now: GENERATION_STARTED_AT + HOOK_TTL_MS + 1 });
    expect(result.outcome).toBe('expired');
  });

  it('D. does not expire exactly at the TTL boundary', () => {
    const result = arbitrateDriveReaction({ ...BASE, now: GENERATION_STARTED_AT + HOOK_TTL_MS });
    expect(result.outcome).not.toBe('expired');
  });

  it('E. is a duplicate when a chat message during generation closely matches the reaction text', () => {
    const result = arbitrateDriveReaction({
      ...BASE,
      recentChat: [chatMsg(GENERATION_STARTED_AT + 1_000, 'го дальше по классике, чё как')],
    });
    expect(result.outcome).toBe('duplicate');
    expect(result.reason).toContain('realviewer');
  });

  it('F. is not a duplicate when a chat message during generation is about something else entirely', () => {
    const result = arbitrateDriveReaction({
      ...BASE,
      recentChat: [chatMsg(GENERATION_STARTED_AT + 1_000, 'кто-нибудь смотрел новый сериал на выходных')],
    });
    expect(result.outcome).toBe('valid');
  });

  it('G. is superseded by a high-importance event that shares no vocabulary with the hook subject', () => {
    const result = arbitrateDriveReaction({
      ...BASE,
      recentEvents: [event(GENERATION_STARTED_AT + 1_000, 0.9, 'стример роняет кружку с чаем на клавиатуру и вскакивает')],
    });
    expect(result.outcome).toBe('superseded');
  });

  it('H. is not superseded by a high-importance event that continues the same subject as the hook', () => {
    const result = arbitrateDriveReaction({
      ...BASE,
      recentEvents: [event(GENERATION_STARTED_AT + 1_000, 0.9, 'друзья стримера подтверждают, что готовы катать доту прямо сейчас')],
    });
    expect(result.outcome).toBe('valid');
  });

  it('I. an unrelated event just under the importance threshold does not supersede', () => {
    const result = arbitrateDriveReaction({
      ...BASE,
      recentEvents: [event(GENERATION_STARTED_AT + 1_000, 0.59, 'стример роняет кружку с чаем на клавиатуру и вскакивает')],
    });
    expect(result.outcome).toBe('valid');
  });

  it('J. duplicate takes precedence over a simultaneous superseding event', () => {
    const result = arbitrateDriveReaction({
      ...BASE,
      recentChat: [chatMsg(GENERATION_STARTED_AT + 1_000, 'го дальше по классике, чё как')],
      recentEvents: [event(GENERATION_STARTED_AT + 1_500, 0.9, 'стример роняет кружку с чаем на клавиатуру и вскакивает')],
    });
    expect(result.outcome).toBe('duplicate');
  });

  it('K. a reaction with no content tokens (pure laughter) can never register as a duplicate', () => {
    const result = arbitrateDriveReaction({
      ...BASE,
      reaction: { username: 'karlbekner', message: 'ХА' },
      recentChat: [chatMsg(GENERATION_STARTED_AT + 1_000, 'ХА')],
    });
    expect(result.outcome).toBe('valid');
  });

  it('L. ignores chat and events that arrived before generation started, even when they would otherwise match or supersede', () => {
    const result = arbitrateDriveReaction({
      ...BASE,
      recentChat: [chatMsg(GENERATION_STARTED_AT - 1_000, 'го дальше по классике, чё как')],
      recentEvents: [event(GENERATION_STARTED_AT - 1_000, 0.95, 'стример роняет кружку с чаем на клавиатуру и вскакивает')],
    });
    expect(result.outcome).toBe('valid');
  });
});
