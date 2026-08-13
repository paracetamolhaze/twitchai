import { describe, expect, it } from 'vitest';
import { EventDetector } from '../src/stream-brain/event-detector';

describe('StreamBrain event normalization', () => {
  const detector = new EventDetector({ minimumConfidence: 0.2 });

  it('normalizes a valid multimodal candidate', () => {
    const event = detector.normalize({
      type: 'fail',
      summary: 'streamer missed Black Hole and lost the fight',
      speech: 'ну всё приехали',
      visualContext: 'Enigma cast the ultimate away from every enemy',
      gameContext: 'Dota 2 ranked match',
      emotion: 'frustrated',
      importance: 0.91,
      confidence: 0.94,
    }, { category: 'Dota 2', timestamp: 1_700_000_000_000 });

    expect(event).toMatchObject({
      type: 'fail',
      summary: 'streamer missed Black Hole and lost the fight',
      category: 'Dota 2',
      importance: 0.91,
      confidence: 0.94,
      timestamp: 1_700_000_000_000,
    });
    expect(event?.id).toEqual(expect.any(String));
  });

  it('rejects malformed and very low-confidence candidates', () => {
    expect(detector.normalize('{not json', { category: 'Dota 2' })).toBeNull();
    expect(detector.normalize({
      type: 'gameplay',
      summary: 'something moved',
      importance: 0.4,
      confidence: 0.05,
    }, { category: 'Dota 2' })).toBeNull();
  });

  it('ignores hallucinated direct mentions that are not configured bot usernames', () => {
    const event = detector.normalize({
      type: 'conversation',
      summary: 'someone called a viewer',
      importance: 0.7,
      confidence: 0.9,
      directMentions: ['not-a-bot', 'real-bot'],
    }, { botUsernames: ['real-bot'] });
    expect(event?.directMentions).toEqual(['real-bot']);
  });
});
