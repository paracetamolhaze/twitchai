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
  /** Set once a genuinely new logical stream session begins; unset means "use the rolling window". */
  private sessionStartedAt?: number;
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
   * Marks a genuinely new logical stream session. Chat retention from here is bounded by this
   * moment rather than by the rolling `chatWindowMs` clock, so a dashboard reading the snapshot
   * hours into a stream still sees everything this evening actually said instead of a rolling few
   * minutes of it — the window a real run cut nineteen sent messages down to about six by the time
   * anyone looked. Call only for a new session, not a resumed one (the same 'new'/'resumed'
   * distinction StreamSession itself makes): a resumed session keeps whatever it already has.
   */
  beginSession(startedAt = this.now()): void {
    this.sessionStartedAt = startedAt;
    // Pruning is what drops the previous evening, rather than an unconditional clear: everything
    // older than the boundary goes, everything at or after it stays. The two differ only when
    // `startedAt` is in the past, and there the prune is the answer that does not throw away
    // messages that genuinely belong to the session being declared.
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
    // Once a session boundary is known, chat is bounded by it rather than by a rolling clock. The
    // rolling window survives as the fallback for whenever no session has begun yet — construction
    // time, and any caller that never adopts beginSession — which is the exact previous behavior.
    const cutoff = this.sessionStartedAt ?? (this.now() - this.chatWindowMs);
    this.chat = this.chat.filter((message) => message.timestamp >= cutoff);
    if (this.chat.length > this.maxChatMessages) {
      this.chat.splice(0, this.chat.length - this.maxChatMessages);
    }
  }
}
