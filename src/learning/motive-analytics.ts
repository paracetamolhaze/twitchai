import { PERSONAL_SOURCE_TYPES } from '../brain/types';
import { MessageVerdictRecord } from '../personas/types';
import { SentMessageMotiveRecord } from '../reaction/types';

/**
 * The join that makes Living Persona falsifiable: operator verdicts against the durable record of
 * where each sent message claimed to come from. The one comparison this exists for is
 * personalSourceApprovalRate vs genericEventOnlyApprovalRate — if messages grounded in a validated
 * personal source are not approved more often than generic event commentary, the whole layer is
 * explaining messages beautifully rather than making them better.
 *
 * The join is BY REACTION ID. One account writes «ахахах» twice in an evening with two different
 * motives, and a text join would hand both verdicts to whichever record happened to be newer; the
 * metric this layer is accountable to cannot be built on an approximation. Text is used only to
 * recover verdicts written before reaction ids existed, and only under a bounded, unambiguous rule
 * — see resolveVerdictLink — and those recovered links are reported separately from the exact ones.
 *
 * Pure and deterministic on purpose: no gating, no thresholds, no feedback into generation. What
 * the numbers change is the operator's next decision, never tonight's behaviour.
 */

/**
 * How far back a legacy verdict may look for the sending it judged. A verdict is clicked during
 * or shortly after the stream the message belongs to; twelve hours covers one long evening and no
 * more, so a text match from a different night never counts.
 */
export const LEGACY_LINK_WINDOW_MS = 12 * 60 * 60_000;

export type VerdictLinkKind = 'exact' | 'legacy' | 'legacy_ambiguous' | 'unmatched' | 'lost';

export interface VerdictLink {
  kind: VerdictLinkKind;
  motive?: SentMessageMotiveRecord;
}

export interface MotiveSourceTypeStats {
  sourceType: string;
  sent: number;
  judged: number;
  approved: number;
  /** approved / judged; null until at least one verdict exists for this source type. */
  approvalRate: number | null;
}

export interface ApprovalSplit {
  /** Verdicts on messages whose validated source is a personal one (memory, curiosity, life...). */
  personalSourceApprovalRate: number | null;
  /** Verdicts on messages with no personal origin: event_emotion, none, or nothing reported. */
  genericEventOnlyApprovalRate: number | null;
  totalJudged: number;
}

/** How much of the statistic stands on certain ground. */
export interface MotiveLinkQuality {
  /** Verdicts joined by reaction id — the only links the strict rates are built from. */
  exactIdMatches: number;
  /** Pre-id verdicts recovered by the bounded text+time rule, with exactly one candidate. */
  legacyFallbackMatches: number;
  /** Pre-id verdicts whose text matched more than one sending in the window — left unlinked. */
  legacyAmbiguous: number;
  /** Verdicts with no sending to join: no id and no candidate in the window. */
  unmatchedVerdicts: number;
  /** Verdicts written after ids existed but without one — a logged bug, never text-matched. */
  lostIdVerdicts: number;
}

export interface MotiveAnalytics extends ApprovalSplit {
  totalSent: number;
  /** Strict: per source type, exact-id links only. */
  bySourceType: MotiveSourceTypeStats[];
  /** The same split with legacy-recovered links added in. Wider, less certain; never the headline. */
  includingLegacy: ApprovalSplit;
  linkQuality: MotiveLinkQuality;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function textKey(username: string, message: string): string {
  return `${username.toLowerCase()}::${normalize(message)}`;
}

/**
 * Which sending a verdict judges.
 *
 * exact: the verdict carries a reaction id and a motive record has it. lost: the verdict was
 * written after ids existed but carries none — recorded as such and never repaired by text, because
 * a repaired bug is an invisible bug. legacy: the verdict predates ids; the ONLY admissible recovery
 * is the same account, the same normalized text, sent before the verdict and within the window —
 * and exactly one such sending. Two candidates is legacy_ambiguous and links to nothing: a verdict
 * that might belong to either message must not be counted under either motive.
 */
export function resolveVerdictLink(
  verdict: MessageVerdictRecord,
  motives: SentMessageMotiveRecord[],
  options: { byId?: Map<string, SentMessageMotiveRecord>; windowMs?: number } = {},
): VerdictLink {
  if (verdict.reactionId) {
    const motive = options.byId
      ? options.byId.get(verdict.reactionId)
      : motives.find((record) => record.id === verdict.reactionId);
    return motive ? { kind: 'exact', motive } : { kind: 'unmatched' };
  }
  if (verdict.linkKind === 'lost') return { kind: 'lost' };
  const windowMs = options.windowMs ?? LEGACY_LINK_WINDOW_MS;
  const key = textKey(verdict.username, verdict.message);
  const candidates = motives.filter((record) =>
    textKey(record.username, record.message) === key
    && record.createdAt <= verdict.createdAt
    && verdict.createdAt - record.createdAt <= windowMs);
  if (candidates.length === 1) return { kind: 'legacy', motive: candidates[0]! };
  return candidates.length === 0 ? { kind: 'unmatched' } : { kind: 'legacy_ambiguous' };
}

/** The source a message is counted under: the backend-validated category when one exists, the raw
 *  claim otherwise — so a fabrication that slipped through before validation existed still shows
 *  up under what it claimed, marked apart by never contributing to the personal bucket. */
function effectiveSourceType(record: SentMessageMotiveRecord): string {
  if (record.sourceValidated && record.validatedSourceType) return record.validatedSourceType;
  return record.sourceType || 'unreported';
}

function isPersonal(record: SentMessageMotiveRecord): boolean {
  return record.sourceValidated
    && record.validatedSourceType !== undefined
    && PERSONAL_SOURCE_TYPES.has(record.validatedSourceType);
}

function rate(approved: number, judged: number): number | null {
  return judged === 0 ? null : Number((approved / judged).toFixed(3));
}

class SplitAccumulator {
  private personalJudged = 0;
  private personalApproved = 0;
  private genericJudged = 0;
  private genericApproved = 0;

  add(record: SentMessageMotiveRecord, approved: boolean): void {
    if (isPersonal(record)) {
      this.personalJudged += 1;
      if (approved) this.personalApproved += 1;
    } else {
      this.genericJudged += 1;
      if (approved) this.genericApproved += 1;
    }
  }

  result(): ApprovalSplit {
    return {
      personalSourceApprovalRate: rate(this.personalApproved, this.personalJudged),
      genericEventOnlyApprovalRate: rate(this.genericApproved, this.genericJudged),
      totalJudged: this.personalJudged + this.genericJudged,
    };
  }
}

export function computeMotiveAnalytics(
  motives: SentMessageMotiveRecord[],
  verdicts: MessageVerdictRecord[],
): MotiveAnalytics {
  const byId = new Map(motives.map((record) => [record.id, record]));

  const bySource = new Map<string, MotiveSourceTypeStats>();
  const statsFor = (sourceType: string): MotiveSourceTypeStats => {
    let stats = bySource.get(sourceType);
    if (!stats) {
      stats = { sourceType, sent: 0, judged: 0, approved: 0, approvalRate: null };
      bySource.set(sourceType, stats);
    }
    return stats;
  };
  for (const record of byId.values()) statsFor(effectiveSourceType(record)).sent += 1;

  const strict = new SplitAccumulator();
  const wide = new SplitAccumulator();
  const quality: MotiveLinkQuality = {
    exactIdMatches: 0, legacyFallbackMatches: 0, legacyAmbiguous: 0, unmatchedVerdicts: 0, lostIdVerdicts: 0,
  };
  for (const verdict of verdicts) {
    const link = resolveVerdictLink(verdict, motives, { byId });
    const approved = verdict.verdict === 'good';
    switch (link.kind) {
      case 'exact': {
        quality.exactIdMatches += 1;
        const stats = statsFor(effectiveSourceType(link.motive!));
        stats.judged += 1;
        if (approved) stats.approved += 1;
        strict.add(link.motive!, approved);
        wide.add(link.motive!, approved);
        break;
      }
      case 'legacy':
        quality.legacyFallbackMatches += 1;
        wide.add(link.motive!, approved);
        break;
      case 'legacy_ambiguous':
        quality.legacyAmbiguous += 1;
        break;
      case 'lost':
        quality.lostIdVerdicts += 1;
        break;
      default:
        quality.unmatchedVerdicts += 1;
    }
  }
  for (const stats of bySource.values()) stats.approvalRate = rate(stats.approved, stats.judged);

  return {
    totalSent: byId.size,
    ...strict.result(),
    bySourceType: [...bySource.values()].sort((a, b) => b.sent - a.sent || a.sourceType.localeCompare(b.sourceType)),
    includingLegacy: wide.result(),
    linkQuality: quality,
  };
}
