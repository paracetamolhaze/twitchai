import { StreamContextSnapshot, StreamEventCandidate } from './types';

export interface StreamBrainClient {
  start(): Promise<void>;
  stop(): void;
  sendAudio(pcm: Buffer): void;
  sendVideo(jpeg: Buffer): void;
  updateContext(snapshot: StreamContextSnapshot): void;
  requestReaction(candidate: StreamEventCandidate): void;
  isConnected(): boolean;
  getSessionStartedAt?(): number | undefined;
}
