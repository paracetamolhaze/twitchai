import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BrainInteractionClient } from '../brain/gemini-brain.service';
import { Logger } from '../logger';
import { MessageVerdictRecord } from '../personas/types';
import { AppRepository } from '../persistence/repository';
import { StreamEvent } from '../stream-brain/types';
import { UsageTracker } from '../usage/usage-tracker';
import { LearnedPolicyStore } from './learned-policy-store';
import {
  FeedbackCase,
  LearnedPolicyRule,
  LearnedRuleScope,
  TeacherAction,
  TeacherRunOutcome,
} from './learned-policy.types';

/** Below this many unread verdicts an automatic run is not worth a call: one dislike is an opinion
 *  about one message, and a Teacher shown two cases has nothing to generalize across. */
export const MIN_NEW_VERDICTS_FOR_AUTO_RUN = 5;
/** A batch past this is mostly older evidence the store has already absorbed, at rising token cost. */
const MAX_CASES_PER_RUN = 40;
/** Enough existing rules for the Teacher to recognise a duplicate, not so many it recites them. */
const MAX_EXISTING_RULES_IN_CONTEXT = 30;
/** Two automatic runs closer than this are almost always the same handful of verdicts twice. */
export const AUTO_RUN_COOLDOWN_MS = 10 * 60_000;
/** How much of the chat around a rated message is enough to check "was this already said". */
const CHAT_CONTEXT_PER_CASE = 8;

const MAX_RULE_CHARS = 220;
const MAX_RATIONALE_CHARS = 300;

const actionSchema = z.object({
  action: z.enum(['CREATE_RULE', 'UPDATE_RULE', 'DISABLE_RULE', 'NO_CHANGE']),
  ruleId: z.string().trim().max(64),
  scopeType: z.enum(['global', 'persona', 'topic']),
  scopeKey: z.string().trim().max(80),
  rule: z.string().trim().max(MAX_RULE_CHARS),
  rationale: z.string().trim().max(MAX_RATIONALE_CHARS),
  confidence: z.coerce.number().min(0).max(1),
  evidenceIds: z.array(z.string().trim().max(64)).max(MAX_CASES_PER_RUN),
}).strict();

const teacherResponseSchema = z.object({ actions: z.array(actionSchema).max(24) }).strict();

/**
 * The one shape the Teacher may answer in.
 *
 * Flat rather than a discriminated union because strict structured output requires every property
 * to be present: a union of four action shapes would have to be expressed as four schemas the
 * provider cannot choose between. Unused fields come back empty and are ignored per action.
 */
export const TEACHER_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['actions'],
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'ruleId', 'scopeType', 'scopeKey', 'rule', 'rationale', 'confidence', 'evidenceIds'],
        properties: {
          action: { type: 'string', enum: ['CREATE_RULE', 'UPDATE_RULE', 'DISABLE_RULE', 'NO_CHANGE'] },
          ruleId: { type: 'string', description: 'Existing rule id for UPDATE_RULE/DISABLE_RULE. Empty string otherwise.' },
          scopeType: { type: 'string', enum: ['global', 'persona', 'topic'] },
          scopeKey: { type: 'string', description: 'Account username for persona scope, a short topic phrase for topic scope, empty for global.' },
          rule: { type: 'string', description: 'Short functional imperative. Empty when not creating or rewording.' },
          rationale: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidenceIds: { type: 'array', items: { type: 'string' }, description: 'Feedback case ids from this batch that support the action.' },
        },
      },
    },
  },
} as const;

export const TEACHER_SYSTEM_INSTRUCTION = `You read a channel operator's own verdicts on messages an AI viewer sent to their Twitch chat, and you turn repeated judgements into a small set of standing rules. You are not writing messages, not inventing personality, and not rephrasing the operator's notes.

Each case carries the message, the operator's verdict (good or bad), an optional note in their own words, the moment it answered (what was said, what was on screen, who was being addressed), and — where it matters — that account's own interests, expertise and weak topics.

Your job is to name the decision mistake, not the words. "Do not restate an opinion the stream has already expressed just to agree with it" is a rule. "Never say мощно" is not, and is never acceptable: a rule naming one phrase teaches nothing about the next phrase, and phrases quoted as forbidden come back as things to say. Write each rule as one short imperative about when to speak, what makes a message worth sending, or what to avoid concluding — generalizable to a message nobody has written yet.

Scope carefully. global applies to every account and needs several agreeing cases behind it, because one dislike is an opinion about one message. persona applies to one account and may be created from a single case when the note points at a real contradiction with that account's own canon — being confidently helpful about something listed in its weakTopics, for instance. topic applies only when a moment matches it, and is worth creating only if the pattern genuinely depends on the subject rather than on the account.

Before creating anything, read the existing rules you were given. If one already says what a new case shows, UPDATE it — raise confidence, extend its evidence, reword it only if the new case genuinely widens or narrows what it should say. Three rules meaning the same thing are worse than one, because the decision they inform can only carry a few.

Evidence can also go the other way. If cases contradict an existing rule — the operator liking messages a rule would have prevented — lower its confidence, narrow its wording to the case it really covers, or DISABLE it. A rule is a current best reading of this operator's taste, not a permanent truth.

Positive verdicts are evidence too, but liking one message is not a rule. Draw a positive principle only when several likes agree on something a naive reading would get wrong, or when they contradict a rule that is too broad.

When a case is ambiguous, the note is vague, or nothing repeats, answer NO_CHANGE. Creating a rule from noise costs more than missing one, because every rule you keep takes a slot in a real decision. Reference only the case ids you were given, never invent one, and never include private reasoning in a rule or rationale.`;

export interface FeedbackTeacherOptions {
  client: BrainInteractionClient;
  model: string;
  repository: Pick<AppRepository, 'listUnprocessedMessageVerdicts' | 'getStreamEvent' | 'listBotMessages'>;
  policyStore: LearnedPolicyStore;
  /** Interests/expertise/weakTopics for an account, from the live persona catalog. */
  personaProfile: (username: string) => { interests: string[]; expertise: string[]; weakTopics: string[] } | undefined;
  /** Chat around a rated message, so "it repeated what was already said" is checkable. */
  recentChat: () => Array<{ username: string; message: string; kind: string; timestamp: number }>;
  usage: UsageTracker;
  logger: Logger;
  now?: () => number;
}

/**
 * The layer that turns individual verdicts into transferable rules.
 *
 * Runs rarely and on a batch, which is what makes a stronger, slower model the right choice here
 * and the wrong one for the realtime Brain. Everything it proposes is validated against the batch it
 * was given before anything is stored, and the whole result is applied in one transaction or not at
 * all — a half-applied run would either lose evidence or double-count it on the next one.
 */
export class FeedbackTeacher {
  private readonly logger: Logger;
  private readonly now: () => number;
  private running = false;
  private lastRunAt = 0;

  constructor(private readonly options: FeedbackTeacherOptions) {
    this.logger = options.logger.child('TEACHER');
    this.now = options.now ?? Date.now;
  }

  /**
   * Fired opportunistically after a verdict is recorded — not from a timer. There is nothing to
   * poll for: new evidence only ever appears because the operator just clicked something, so the
   * click is the signal, and a background loop would spend a wakeup every minute to discover
   * nothing changed.
   */
  async maybeRunAutomatically(): Promise<TeacherRunOutcome | undefined> {
    if (this.running) return undefined;
    if (this.now() - this.lastRunAt < AUTO_RUN_COOLDOWN_MS) return undefined;
    const pending = await this.options.repository.listUnprocessedMessageVerdicts(MAX_CASES_PER_RUN);
    if (pending.length < MIN_NEW_VERDICTS_FOR_AUTO_RUN) return undefined;
    return this.run(pending, 'automatic');
  }

  /** The dashboard button. Ignores the batch-size threshold and the cooldown, never the lock. */
  async runManually(): Promise<TeacherRunOutcome | undefined> {
    if (this.running) return undefined;
    const pending = await this.options.repository.listUnprocessedMessageVerdicts(MAX_CASES_PER_RUN);
    if (pending.length === 0) return undefined;
    return this.run(pending, 'manual');
  }

  private async run(verdicts: MessageVerdictRecord[], trigger: 'automatic' | 'manual'): Promise<TeacherRunOutcome | undefined> {
    this.running = true;
    const startedAt = this.now();
    try {
      const cases = await Promise.all(verdicts.map((verdict) => this.buildCase(verdict)));
      const existing = this.options.policyStore.active().slice(0, MAX_EXISTING_RULES_IN_CONTEXT);
      this.logger.info('TEACHER_RUN_STARTED', {
        trigger, feedbackCases: cases.length, existingRules: existing.length, model: this.options.model,
      });

      const response = await this.options.client.create({
        kind: 'teacher',
        model: this.options.model,
        input: JSON.stringify({
          feedbackCases: cases,
          existingRules: existing.map((rule) => ({
            id: rule.id, scopeType: rule.scopeType, scopeKey: rule.scopeKey,
            rule: rule.rule, confidence: rule.confidence, supportCount: rule.supportCount,
          })),
        }),
        systemInstruction: TEACHER_SYSTEM_INSTRUCTION,
        responseSchema: TEACHER_RESPONSE_SCHEMA,
        // Rare, batched, and judged on how well it generalizes — the one call in this system where
        // thinking budget is worth more than latency.
        thinkingLevel: 'high',
        maxOutputTokens: 2_048,
        store: true,
      });
      if (response.status !== 'completed' || !response.outputText) {
        throw new Error(`teacher response ${response.status}`);
      }
      this.options.usage.recordTeacherInteraction(response.usage);

      const parsed = teacherResponseSchema.parse(JSON.parse(response.outputText));
      const { upserts, counts } = this.validateActions(parsed.actions, cases);
      // One transaction: the rules and the "these verdicts have been read" stamp land together or
      // neither does, so a failure here leaves the batch exactly as pending as it was.
      await this.options.policyStore.apply(upserts, verdicts.map((verdict) => verdict.id), this.now());

      const outcome: TeacherRunOutcome = {
        ...counts,
        model: this.options.model,
        latencyMs: this.now() - startedAt,
        casesConsidered: cases.length,
      };
      this.lastRunAt = this.now();
      this.logger.info('TEACHER_RUN_COMPLETED', {
        trigger,
        ...outcome,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        ...(response.usage.costUsd !== undefined ? { costUsd: response.usage.costUsd } : {}),
      });
      return outcome;
    } catch (cause) {
      // Nothing was written: no rule is stored and no verdict is stamped, so the same batch is still
      // pending and the next run repeats it. A provider outage costs a call, never evidence.
      this.logger.warn('TEACHER_RUN_FAILED', { trigger, cause });
      this.lastRunAt = this.now();
      return undefined;
    } finally {
      this.running = false;
    }
  }

  /**
   * Everything the Teacher may act on, checked against what it was actually given.
   *
   * A model asked to cite evidence will occasionally cite evidence that does not exist, and a rule
   * resting on an invented case is a rule with nothing behind it. Every id must be in this batch,
   * every ruleId must resolve to a rule that exists and is not operator-disabled, and every field
   * must be within bounds — an action failing any of these is dropped rather than repaired.
   */
  private validateActions(
    actions: TeacherAction[], cases: FeedbackCase[],
  ): { upserts: LearnedPolicyRule[]; counts: Omit<TeacherRunOutcome, 'model' | 'latencyMs' | 'casesConsidered'> } {
    const caseById = new Map(cases.map((item) => [item.id, item]));
    const upserts: LearnedPolicyRule[] = [];
    const counts = { created: 0, updated: 0, disabled: 0, unchanged: 0, rejected: 0 };
    const now = this.now();

    for (const action of actions) {
      if (action.action === 'NO_CHANGE') { counts.unchanged += 1; continue; }

      const evidence = action.evidenceIds.filter((id) => caseById.has(id));
      if (evidence.length !== action.evidenceIds.length) {
        this.logger.warn('TEACHER_ACTION_REJECTED', { reason: 'unknown_evidence_id', action: action.action });
        counts.rejected += 1;
        continue;
      }

      if (action.action === 'CREATE_RULE') {
        const created = this.buildCreatedRule(action, evidence, caseById, now);
        if (!created) { counts.rejected += 1; continue; }
        upserts.push(created);
        counts.created += 1;
        this.logger.info('LEARNED_RULE_CREATED', {
          ruleId: created.id, scope: created.scopeType, scopeKey: created.scopeKey,
          confidence: created.confidence, support: created.supportCount,
        });
        continue;
      }

      const existing = this.options.policyStore.byId(action.ruleId);
      if (!existing) {
        this.logger.warn('TEACHER_ACTION_REJECTED', { reason: 'unknown_rule_id', action: action.action });
        counts.rejected += 1;
        continue;
      }
      if (existing.status === 'disabled') {
        // An operator switching a rule off in the dashboard is a decision, not a hypothesis for the
        // Teacher to re-open on the next batch.
        this.logger.warn('TEACHER_ACTION_REJECTED', { reason: 'rule_disabled_by_operator', ruleId: existing.id });
        counts.rejected += 1;
        continue;
      }

      if (action.action === 'DISABLE_RULE') {
        upserts.push({
          ...existing,
          status: 'superseded',
          rationale: action.rationale || existing.rationale,
          updatedAt: now,
          version: existing.version + 1,
        });
        counts.disabled += 1;
        this.logger.info('LEARNED_RULE_DISABLED', { ruleId: existing.id, scope: existing.scopeType, by: 'teacher' });
        continue;
      }

      const evidenceIds = [...new Set([...existing.evidenceIds, ...evidence])];
      const { positive, negative } = countEvidence(evidence, caseById);
      upserts.push({
        ...existing,
        rule: action.rule ? action.rule : existing.rule,
        rationale: action.rationale || existing.rationale,
        confidence: action.confidence,
        // Support is the number of distinct cases behind the rule across every run, which is why it
        // is derived from the merged id set rather than incremented: a re-cited case must not count
        // twice just because two runs both mentioned it.
        supportCount: evidenceIds.length,
        positiveEvidence: existing.positiveEvidence + positive,
        negativeEvidence: existing.negativeEvidence + negative,
        evidenceIds,
        teacherModel: this.options.model,
        updatedAt: now,
        version: existing.version + 1,
      });
      counts.updated += 1;
      this.logger.info('LEARNED_RULE_UPDATED', {
        ruleId: existing.id, scope: existing.scopeType, confidence: action.confidence, support: evidenceIds.length,
      });
    }
    return { upserts, counts };
  }

  private buildCreatedRule(
    action: TeacherAction, evidence: string[], caseById: Map<string, FeedbackCase>, now: number,
  ): LearnedPolicyRule | undefined {
    if (!action.rule) return undefined;
    if (action.scopeType === 'persona') {
      // A persona rule naming an account nobody has is a rule that can never be retrieved.
      if (!action.scopeKey || !this.options.personaProfile(action.scopeKey)) {
        this.logger.warn('TEACHER_ACTION_REJECTED', { reason: 'unknown_persona_scope', scopeKey: action.scopeKey });
        return undefined;
      }
    }
    if (action.scopeType === 'topic' && !action.scopeKey) {
      this.logger.warn('TEACHER_ACTION_REJECTED', { reason: 'topic_rule_without_key' });
      return undefined;
    }
    if (evidence.length === 0) {
      this.logger.warn('TEACHER_ACTION_REJECTED', { reason: 'no_evidence' });
      return undefined;
    }
    const { positive, negative } = countEvidence(evidence, caseById);
    return {
      id: randomUUID(),
      scopeType: action.scopeType as LearnedRuleScope,
      scopeKey: action.scopeType === 'global' ? '' : action.scopeKey,
      rule: action.rule,
      rationale: action.rationale,
      confidence: action.confidence,
      supportCount: evidence.length,
      positiveEvidence: positive,
      negativeEvidence: negative,
      status: 'active',
      teacherModel: this.options.model,
      evidenceIds: evidence,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  }

  /**
   * A verdict plus enough of the moment it answered to explain itself.
   *
   * Assembled here rather than denormalized into message_verdicts: stream_events already stores the
   * whole event, and a second copy of speech and visual context would be one more thing to keep in
   * sync for no gain. What is stored is the link — event_id — and this rebuilds the rest from it.
   */
  private async buildCase(verdict: MessageVerdictRecord): Promise<FeedbackCase> {
    const autonomous = verdict.eventId?.startsWith('persona-drive:') ?? false;
    const event = verdict.eventId && !autonomous
      ? await this.options.repository.getStreamEvent(verdict.eventId).catch(() => undefined)
      : undefined;
    const profile = this.options.personaProfile(verdict.username);
    const chat = this.options.recentChat()
      .filter((message) => message.timestamp <= verdict.createdAt)
      .slice(-CHAT_CONTEXT_PER_CASE)
      .map(({ username, message, kind }) => ({ username, message, kind }));
    return {
      id: verdict.id,
      createdAt: verdict.createdAt,
      username: verdict.username,
      message: verdict.message,
      verdict: verdict.verdict,
      ...(verdict.note ? { note: verdict.note } : {}),
      triggerKind: autonomous ? 'persona_drive' : 'external_stream_event',
      ...(event ? { event: describeEvent(event) } : {}),
      ...(profile ? { persona: profile } : {}),
      recentChat: chat,
    };
  }
}

function countEvidence(evidence: string[], caseById: Map<string, FeedbackCase>): { positive: number; negative: number } {
  let positive = 0;
  let negative = 0;
  for (const id of evidence) {
    if (caseById.get(id)?.verdict === 'good') positive += 1;
    else negative += 1;
  }
  return { positive, negative };
}

function describeEvent(event: StreamEvent): NonNullable<FeedbackCase['event']> {
  const spoken = Boolean(event.speech);
  const seen = Boolean(event.visualContext);
  return {
    id: event.id,
    type: event.type,
    summary: event.summary,
    ...(event.speech ? { speech: event.speech } : {}),
    ...(event.visualContext ? { visualContext: event.visualContext } : {}),
    ...(event.audience ? { audience: event.audience } : {}),
    grounding: spoken && seen ? 'speech+scene' : spoken ? 'speech' : seen ? 'scene' : 'none',
    importance: event.importance,
  };
}
