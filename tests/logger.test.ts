import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger';
describe('safe usage logging', () => {
  it('keeps numeric counters while redacting credentials and string values', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      new Logger('TEST').info('usage', { inputTokens: 123, outputTokens: 9, accessToken: 'secret', nested: { apiKey: 'secret' }, thinkingTokens: 'secret' });
      const entry = JSON.parse(String(output.mock.calls[0]![0]));
      expect(entry).toMatchObject({ inputTokens: 123, outputTokens: 9, accessToken: '[REDACTED]', nested: { apiKey: '[REDACTED]' }, thinkingTokens: '[REDACTED]' });
    } finally { output.mockRestore(); }
  });
});
