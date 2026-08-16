import { ChatMessage, SpokenLine, StreamContextSnapshot, StreamEvent } from './types';

export interface ContextStoreOptions {
  chatWindowMs: number;
  maxChatMessages: number;
  maxEvents: number;
  maxSpeechLines?: number;
  now?: () => number;
}

export class ContextStore {
  private readonly chatWindowMs: number;
  private readonly maxChatMessages: number;
  private readonly maxEvents: number;
  private readonly maxSpeechLines: number;
  private readonly now: () => number;
  private channel = '';
  private category = '';
  private streamContext = '';
  private isLive = false;
  private botUsernames: string[] = [];
  private chat: ChatMessage[] = [];
  private events: StreamEvent[] = [];
  /** What was actually said, as transcribed — kept apart from perception's retelling of it. */
  private speech: SpokenLine[] = [];

  constructor(options: ContextStoreOptions) {
    this.chatWindowMs = options.chatWindowMs;
    this.maxChatMessages = options.maxChatMessages;
    this.maxEvents = options.maxEvents;
    this.maxSpeechLines = options.maxSpeechLines ?? 25;
    this.now = options.now ?? Date.now;
  }

  configure(input: Partial<Pick<StreamContextSnapshot, 'channel' | 'category' | 'streamContext' | 'isLive' | 'botUsernames'>>): void {
    if (input.channel !== undefined) this.channel = input.channel;
    if (input.category !== undefined) this.category = input.category;
    if (input.streamContext !== undefined) this.streamContext = input.streamContext;
    if (input.isLive !== undefined) this.isLive = input.isLive;
    if (input.botUsernames !== undefined) this.botUsernames = [...input.botUsernames];
  }

  addChat(message: ChatMessage): void {
    this.chat.push(message);
    this.prune();
  }

  /**
   * Perception already transcribes the stream, and until now those words were read only to spot a
   * spoken bot name and then dropped. The decision layer saw the summary instead — a retelling
   * that turns "we are trying to drag him along for drinks" into "proposes some sort of plan".
   */
  addSpeech(text: string, timestamp = this.now()): void {
    const line = text.trim();
    if (!line) return;
    this.speech.push({ timestamp, text: line });
    if (this.speech.length > this.maxSpeechLines) this.speech.splice(0, this.speech.length - this.maxSpeechLines);
  }

  addEvent(event: StreamEvent): void {
    const existing = this.events.findIndex((candidate) => candidate.id === event.id);
    if (existing >= 0) this.events[existing] = event;
    else this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  snapshot(): StreamContextSnapshot {
    this.prune();
    return {
      channel: this.channel,
      category: this.category,
      streamContext: this.streamContext,
      isLive: this.isLive,
      recentChat: [...this.chat],
      recentEvents: [...this.events],
      recentSpeech: [...this.speech],
      botUsernames: [...this.botUsernames],
      updatedAt: this.now(),
    };
  }

  private prune(): void {
    const cutoff = this.now() - this.chatWindowMs;
    this.chat = this.chat.filter((message) => message.timestamp >= cutoff);
    if (this.chat.length > this.maxChatMessages) {
      this.chat.splice(0, this.chat.length - this.maxChatMessages);
    }
  }
}
