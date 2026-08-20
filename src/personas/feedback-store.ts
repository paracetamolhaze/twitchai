import { randomUUID } from 'node:crypto';
import { Logger } from '../logger';
import { AppRepository } from '../persistence/repository';
import { messageTokens, tokenSetSimilarity } from '../shared/similarity';
import { MessageVerdictRecord } from './types';

export type FeedbackVerdictInput = Omit<MessageVerdictRecord, 'id' | 'createdAt'>;

/**
 * How similar a candidate reaction has to be to a disliked message from the same account before
 * it reads as the same message again rather than a coincidence. Matches `BotHistory.isDuplicate`'s
 * own threshold (src/personas/bot-history.ts) and reuses its exact scoring function, so a dislike
 * and an ordinary repeat are judged by one yardstick rather than two independently-tuned ones.
 */
const NEAR_DUPLICATE_THRESHOLD = 0.72;

/** How many of a persona's most recent likes are eligible to compete for a generation-snapshot slot. */
const MAX_LIVE_EXAMPLES_CONSIDERED = 8;

export interface FeedbackSnapshot {
  likesAvailable: number;
  dislikesAvailable: number;
  approvedLiveExamplesUsed: number;
  similarityRejected: number;
}

/**
 * The runtime half of the operator's like/dislike verdicts.
 *
 * Before this existed, a verdict reached `message_verdicts` and the dashboard list that reads it
 * back, and nothing else — Brain, persona examples, NaturalnessGuard, Persona Drive and persona
 * memory never touched the table. This is the part that makes a click actually change something:
 * an in-memory mirror, updated synchronously on every write, so a like has already taken effect by
 * the time its own POST request returns. No restart, no refresh interval, no async lookup on the
 * read side — the read side does no I/O at all, which is what "practically free" requires here.
 *
 * It does not rewrite canon. A liked message becomes an extra candidate in the SAME diversity
 * selection `persona.speech.messageExamples` already goes through (see
 * `persona-context-builder.ts`'s `selectShapeExamples`/`selectSpeechExamples`) — never a write to
 * the authored catalog, never a guarantee of a slot, and capped at `MAX_LIVE_EXAMPLES_CONSIDERED`
 * so one early like cannot calcify into a permanent catchphrase once real likes accumulate.
 */
/**
 * One indexed verdict. `tokens` is present only for dislikes, computed once at index time: the
 * near-duplicate check runs on the send path against every dislike an account has, and re-tokenizing
 * the same stored messages on each call measured at 460us per candidate reaction against a realistic
 * history. Tokenizing both sides once brings the same comparison to a few microseconds.
 */
interface IndexedVerdict {
  record: MessageVerdictRecord;
  tokens?: Set<string>;
}

export class PersonaFeedbackStore {
  private readonly byUsername = new Map<string, IndexedVerdict[]>();
  private readonly logger: Logger;
  private approvedLiveExamplesUsed = 0;
  private similarityRejected = 0;

  constructor(
    private readonly repository: Pick<AppRepository, 'saveMessageVerdict' | 'listMessageVerdicts'>,
    logger: Logger,
  ) {
    this.logger = logger.child('FEEDBACK');
  }

  /** Populates the in-memory mirror from durable storage. Call once, before generation can start. */
  async load(limit = 2000): Promise<void> {
    const verdicts = await this.repository.listMessageVerdicts(limit);
    this.byUsername.clear();
    // listMessageVerdicts returns newest-first; index() unshifts, which would reverse that
    // ordering on a batch load, so walk it back-to-front to end up newest-first per persona too.
    for (let index = verdicts.length - 1; index >= 0; index -= 1) this.index(verdicts[index]!);
    this.logger.info('FEEDBACK_STORE_LOADED', { likes: this.countBy('good'), dislikes: this.countBy('bad') });
  }

  async record(input: FeedbackVerdictInput): Promise<MessageVerdictRecord> {
    const record: MessageVerdictRecord = { id: randomUUID(), createdAt: Date.now(), ...input };
    await this.repository.saveMessageVerdict(record);
    this.index(record);
    this.logger.info('FEEDBACK_RECORDED', {
      messageId: record.id, persona: record.username, verdict: record.verdict,
      hasComment: Boolean(record.note), ...(record.eventId ? { eventId: record.eventId } : {}),
    });
    return record;
  }

  /**
   * Up to `limit` of this persona's own liked live messages, newest first. Deliberately keyed by
   * exact username, never pooled across accounts: one account's good line is evidence about how
   * that Twitch viewer writes, not a style note for the other twenty-nine.
   */
  approvedExamplesFor(username: string, limit = MAX_LIVE_EXAMPLES_CONSIDERED): string[] {
    return (this.byUsername.get(normalizeUsername(username)) ?? [])
      .filter((item) => item.record.verdict === 'good')
      .slice(0, limit)
      .map((item) => item.record.message);
  }

  /** Called by PersonaContextBuilder after selection, so the counter reflects examples that
   *  actually survived diversity selection into a real snapshot, not merely ones that were eligible. */
  recordExamplesUsed(count: number): void {
    if (count > 0) this.approvedLiveExamplesUsed += count;
  }

  /**
   * Whether this persona has a recent dislike close enough to `message` to read as the same thing
   * said again. Not a blacklist of phrases — a per-persona comparison against messages an operator
   * specifically rejected, using the same similarity function BotHistory already uses to stop an
   * account repeating itself.
   */
  isNearDuplicateOfDisliked(username: string, message: string): boolean {
    const indexed = this.byUsername.get(normalizeUsername(username));
    if (!indexed) return false;
    let candidate: Set<string> | undefined;
    for (const item of indexed) {
      if (!item.tokens) continue; // a like — nothing to compare against
      candidate ??= messageTokens(message); // tokenized at most once, and only if a dislike exists
      if (tokenSetSimilarity(item.tokens, candidate) >= NEAR_DUPLICATE_THRESHOLD) {
        this.similarityRejected += 1;
        return true;
      }
    }
    return false;
  }

  snapshot(): FeedbackSnapshot {
    return {
      likesAvailable: this.countBy('good'),
      dislikesAvailable: this.countBy('bad'),
      approvedLiveExamplesUsed: this.approvedLiveExamplesUsed,
      similarityRejected: this.similarityRejected,
    };
  }

  private index(verdict: MessageVerdictRecord): void {
    const key = normalizeUsername(verdict.username);
    const list = this.byUsername.get(key) ?? [];
    list.unshift({
      record: verdict,
      ...(verdict.verdict === 'bad' ? { tokens: messageTokens(verdict.message) } : {}),
    });
    this.byUsername.set(key, list);
  }

  private countBy(verdict: 'good' | 'bad'): number {
    let total = 0;
    for (const list of this.byUsername.values()) {
      for (const item of list) if (item.record.verdict === verdict) total += 1;
    }
    return total;
  }
}

function normalizeUsername(username: string): string { return username.trim().toLowerCase(); }
