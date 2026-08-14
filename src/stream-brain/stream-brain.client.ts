import { GeminiLiveDiagnostics, StreamContextSnapshot, StreamEventCandidate } from './types';

export interface StreamBrainClient {
  start(): Promise<void>;
  stop(): void;
  sendAudio(pcm: Buffer): boolean;
  sendVideo(jpeg: Buffer): boolean;
  updateContext(snapshot: StreamContextSnapshot): boolean;
  requestReaction(candidate: StreamEventCandidate): boolean;
  isConnected(): boolean;
  getSessionStartedAt?(): number | undefined;
  getDiagnostics?(): GeminiLiveDiagnostics;
}
