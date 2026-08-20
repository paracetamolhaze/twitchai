import { Logger } from '../logger';
import { relevanceScore, semanticTokens } from '../personas/persona-memory';
import { AppRepository } from '../persistence/repository';
import { StreamEvent } from '../stream-brain/types';
import { LearnedPolicyForDecision, LearnedPolicyRule, LearnedRuleStatus } from './learned-policy.types';

type PolicyRepository = Pick<AppRepository,
  'listLearnedPolicyRules' | 'applyLearnedPolicyBatch' | 'setLearnedPolicyRuleStatus' | 'deleteLearnedPolicyRule'>;

/**
 * How many rules of each scope one decision may carry.
 *
 * Measured rather than guessed: a rule as the Teacher is asked to write it runs 60-110 characters,
 * so this ceiling is roughly 850 characters of payload — about 250 tokens against a decision that
 * already sends 10-20k. Split per scope rather than as one number so a run of persona rules can
 * never crowd out the global ones, which are the whole reason this layer exists: the general
 * principle is what transfers to a sentence nobody has written yet.
 */
const MAX_GLOBAL_RULES = 3;
const MAX_TOPIC_RULES = 1;
const MAX_PERSONA_RULES_PER_ACCOUNT = 1;
const MAX_PERSONA_RULES_TOTAL = 3;

/** Below this a rule is a hypothesis the Teacher is still unsure of, and stays out of decisions. */
const MIN_CONFIDENCE_FOR_USE = 0.5;

/** A topic rule needs a real match against this moment, not an incidental shared word. */
const MIN_TOPIC_RELEVANCE = 0.15;

/**
 * The sentence that tells the model what the attached rules are. It lives in the payload, never in
 * BRAIN_SYSTEM_INSTRUCTION — the same choice FIRST_MESSAGE_GATE already makes, and for the same
 * reason: the permanent instruction is a cached prefix of standing principles, and this is a
 * conditional block that is absent on most decisions and different on the rest.
 */
const POLICY_GUIDANCE = 'Learned from this channel operator\'s own judgement on earlier messages. '
  + 'Treat these as standing corrections to how you decide and write, not as forbidden words: they '
  + 'describe mistakes to avoid making again and shapes that worked. A rule under global applies to '
  + 'everyone; a rule under byPersona applies only to that one account and says nothing about the '
  + 'others; a rule under topic applies because this particular moment matches it.';

/**
 * Everything the operator's verdicts have been generalized into, and the retrieval that puts a few
 * of them in front of one decision.
 *
 * Kept in memory and refreshed on write, for the same reason PersonaFeedbackStore is: retrieval runs
 * on the decision path, and a database round trip per event would be paid on every moment of the
 * stream for data that changes a few times an evening.
 */
export class LearnedPolicyStore {
  private rules: LearnedPolicyRule[] = [];
  private readonly logger: Logger;
  private applied = 0;
  private decisionsWithPolicy = 0;

  constructor(private readonly repository: PolicyRepository, logger: Logger) {
    this.logger = logger.child('POLICY');
  }

  async load(): Promise<void> {
    this.rules = await this.repository.listLearnedPolicyRules();
    this.logger.info('LEARNED_POLICY_LOADED', {
      total: this.rules.length,
      active: this.rules.filter((rule) => rule.status === 'active').length,
    });
  }

  all(): LearnedPolicyRule[] { return [...this.rules]; }

  /** Active rules only, which is what a Teacher run should reason about and what retrieval may use. */
  active(): LearnedPolicyRule[] { return this.rules.filter((rule) => rule.status === 'active'); }

  byId(id: string): LearnedPolicyRule | undefined { return this.rules.find((rule) => rule.id === id); }

  /**
   * Commits a Teacher run and refreshes the in-memory copy from what was actually stored — never
   * from what the Teacher proposed, so a rule only becomes live once it has survived persistence.
   */
  async apply(upserts: LearnedPolicyRule[], processedVerdictIds: string[], processedAt: number): Promise<void> {
    await this.repository.applyLearnedPolicyBatch({ upserts, processedVerdictIds, processedAt });
    await this.load();
  }

  async setStatus(id: string, status: LearnedRuleStatus): Promise<LearnedPolicyRule | undefined> {
    const updated = await this.repository.setLearnedPolicyRuleStatus(id, status);
    if (updated) {
      await this.load();
      this.logger.info(status === 'active' ? 'LEARNED_RULE_ENABLED' : 'LEARNED_RULE_DISABLED', {
        ruleId: id, scope: updated.scopeType, scopeKey: updated.scopeKey,
      });
    }
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const deleted = await this.repository.deleteLearnedPolicyRule(id);
    if (deleted) {
      await this.load();
      this.logger.info('LEARNED_RULE_DELETED', { ruleId: id });
    }
    return deleted;
  }

  /**
   * The few rules that bear on this moment and these candidates.
   *
   * Never all of them: a store that grows over months would otherwise turn every decision into a
   * recitation of every correction ever made, which is both expensive and the surest way to have
   * none of them read. Persona rules are keyed by account so one account's correction cannot be
   * read as a rule about the others — the payload has to keep them apart, because one Brain call
   * decides for several shortlisted accounts at once.
   */
  forDecision(event: StreamEvent | undefined, candidateUsernames: string[]): LearnedPolicyForDecision | undefined {
    const usable = this.active().filter((rule) => rule.confidence >= MIN_CONFIDENCE_FOR_USE);
    if (usable.length === 0) return undefined;

    const global = usable
      .filter((rule) => rule.scopeType === 'global')
      .sort(byConfidenceThenRecency)
      .slice(0, MAX_GLOBAL_RULES);

    const moment = event
      ? semanticTokens([event.summary, event.speech, event.visualContext, event.gameContext].filter(Boolean).join(' '))
      : new Set<string>();
    const topic = event
      ? usable
        .filter((rule) => rule.scopeType === 'topic')
        .map((rule) => ({ rule, score: relevanceScore(moment, `${rule.scopeKey} ${rule.rule}`) }))
        .filter(({ score }) => score >= MIN_TOPIC_RELEVANCE)
        .sort((left, right) => right.score - left.score)
        .slice(0, MAX_TOPIC_RULES)
        .map(({ rule }) => rule)
      : [];

    const byPersona: Record<string, string[]> = {};
    const personaApplied: LearnedPolicyRule[] = [];
    for (const username of candidateUsernames) {
      if (personaApplied.length >= MAX_PERSONA_RULES_TOTAL) break;
      const forAccount = usable
        .filter((rule) => rule.scopeType === 'persona' && rule.scopeKey.toLowerCase() === username.toLowerCase())
        .sort(byConfidenceThenRecency)
        .slice(0, MAX_PERSONA_RULES_PER_ACCOUNT);
      if (forAccount.length === 0) continue;
      byPersona[username] = forAccount.map((rule) => rule.rule);
      personaApplied.push(...forAccount);
    }

    const applied = [...global, ...topic, ...personaApplied];
    if (applied.length === 0) return undefined;
    this.applied += applied.length;
    this.decisionsWithPolicy += 1;
    return {
      guidance: POLICY_GUIDANCE,
      global: global.map((rule) => rule.rule),
      topic: topic.map((rule) => rule.rule),
      byPersona,
      applied: applied.map((rule) => ({ id: rule.id, scope: rule.scopeType, scopeKey: rule.scopeKey })),
    };
  }

  snapshot(): { activeRules: number; disabledRules: number; rulesApplied: number; decisionsWithPolicy: number } {
    return {
      activeRules: this.rules.filter((rule) => rule.status === 'active').length,
      disabledRules: this.rules.filter((rule) => rule.status !== 'active').length,
      rulesApplied: this.applied,
      decisionsWithPolicy: this.decisionsWithPolicy,
    };
  }
}

function byConfidenceThenRecency(left: LearnedPolicyRule, right: LearnedPolicyRule): number {
  return right.confidence - left.confidence || right.updatedAt - left.updatedAt;
}
