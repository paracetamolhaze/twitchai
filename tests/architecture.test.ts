import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceText(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return [sourceText(path)];
      return extname(path) === '.ts' ? [readFileSync(path, 'utf8')] : [];
    })
    .join('\n');
}

describe('single Stream Brain architecture', () => {
  it('does not reintroduce per-bot text generation or the legacy reaction tool', () => {
    const source = sourceText(join(process.cwd(), 'src'));
    expect(source).not.toContain('.generateContent(');
    expect(source).not.toContain('GeminiResponseProvider');
    expect(source).not.toContain('gemini-3.1-flash-lite');
    expect(source).not.toContain('record_stream_event');
    expect(source.match(/new GeminiLiveClient\(/g)).toHaveLength(1);
    expect(source.match(/new GoogleGenAI\(/g)).toHaveLength(1);
    expect(readFileSync(join(process.cwd(), 'src', 'stream-brain', 'gemini-live.client.ts'), 'utf8'))
      .toContain('record_stream_memories');
    expect(readFileSync(join(process.cwd(), 'src', 'persistence', 'run-migrations.ts'), 'utf8'))
      .toContain('005_deep_persona_generation_v3.sql');
    expect(readFileSync(join(process.cwd(), 'src', 'persistence', 'run-migrations.ts'), 'utf8'))
      .toContain('006_global_streamer_memory.sql');
  });
});
