import { ReactionExample } from '../learning/types';
import { BotMessageRecord, BotPersona } from '../personas/types';
import { StreamContextSnapshot, StreamEvent } from '../stream-brain/types';

export interface ResponseRequest {
  event: StreamEvent;
  context: StreamContextSnapshot;
  persona: BotPersona;
  username: string;
  history: BotMessageRecord[];
  examples: ReactionExample[];
  retryReason?: string;
}

export type GeneratedResponse = { kind: 'message'; text: string } | { kind: 'skip' };

export interface ResponseProvider {
  generate(request: ResponseRequest): Promise<GeneratedResponse>;
}

export class UnavailableResponseProvider implements ResponseProvider {
  async generate(): Promise<GeneratedResponse> { return { kind: 'skip' }; }
}
