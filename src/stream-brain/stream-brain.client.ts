import { GeminiLiveDiagnostics, StreamContextSnapshot } from './types';

export interface StreamBrainClient {
  start(): Promise<void>;
  stop(): void;
  sendAudio(pcm: Buffer): boolean;
  sendVideo(jpeg: Buffer): boolean;
  updateContext(snapshot: StreamContextSnapshot): boolean;
  isConnected(): boolean;
  getSessionStartedAt?(): number | undefined;
  getDiagnostics?(): GeminiLiveDiagnostics;
}
