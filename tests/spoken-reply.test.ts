import { describe, expect, it } from 'vitest';
import { findSpokenReply } from '../src/reaction/spoken-reply';
import { StreamEvent } from '../src/stream-brain/types';

const message = { username: 'karlbekner', message: 'они на клей обычно идут или на сетку', sentAt: 100_000 };
const event: StreamEvent = {
  id: 'reply', timestamp: 129_000, type: 'question', source: 'transcription',
  summary: 'уточнение', speech: 'S: А они на клей обычно идут или на сетку? Облака, ты имеешь в виду?',
  directMentions: [], importance: 0.6, confidence: 0.9,
};

describe('spoken reply attribution', () => {
  it('matches a recent read-out without depending on punctuation or case', () => {
    expect(findSpokenReply(event, [{ ...message, message: message.message.toUpperCase() }])?.username).toBe('karlbekner');
  });
  it('does not infer an addressee from a shared topic', () => {
    expect(findSpokenReply({ ...event, speech: 'S: облака буду на клей крепить, сетку не хочу' }, [message])).toBeUndefined();
  });
  it('does not attribute quotes spoken by another person or across different speakers', () => {
    expect(findSpokenReply({ ...event, speech: event.speech!.replace('S:', 'O:') }, [message])).toBeUndefined();
    expect(findSpokenReply({ ...event, speech: 'S: они на клей обычно O: идут или на сетку' }, [message])).toBeUndefined();
  });
  it('rejects stale and future messages', () => {
    expect(findSpokenReply({ ...event, timestamp: 190_001 }, [message])).toBeUndefined();
    expect(findSpokenReply({ ...event, timestamp: 99_999 }, [message])).toBeUndefined();
  });
  it('leaves ambiguous authors, generic short phrases and explicit other addressees alone', () => {
    expect(findSpokenReply(event, [message, { ...message, username: 'other' }])).toBeUndefined();
    expect(findSpokenReply({ ...event, speech: 'S: да, точно. Ты уверен?' }, [{ ...message, message: 'да точно' }])).toBeUndefined();
    expect(findSpokenReply({ ...event, directMentions: ['other'] }, [message])).toBeUndefined();
  });
  it('never treats text chat as the streamer reading aloud', () => {
    expect(findSpokenReply({ ...event, source: 'chat' }, [message])).toBeUndefined();
  });
});
