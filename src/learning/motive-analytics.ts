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
 * Pure and deterministic on purpose: no gating, no thresholds, no feedback into generation. What
 * the numbers change is the operator's next decision, never tonight's behaviour.
 */

export interface MotiveSourceTypeStats {
  sourceType: string;
  sent: number;
  judged: number;
  approved: number;
  /** approved / judged; null until at least one verdict exists for this source type. */
  approvalRate: number | null;
}

export interface MotiveAnalytics {
  totalSent: number;
  totalJudged: number;
  bySourceType: MotiveSourceTypeStats[];
  /** Verdicts on messages whose validated source is a personal one (memory, curiosity, life...). */
  personalSourceApprovalRate: number | null;
  /** Verdicts on messages with no personal origin: event_emotion, none, or nothing reported. */
  genericEventOnlyApprovalRate: number | null;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The source a message is counted under: the backend-validated category when one exists, the raw
 *  claim otherwise — so a fabrication that slipped through before validation existed still shows
 *  up under what it claimed, marked apart by never contributing to the personal bucket. */
function effectiveSourceType(record: SentMessageMotiveRecord): string {
  if (record.sourceValidated && record.validatedSourceType) return record.validatedSourceType;
  return record.sourceType || 'unreported';
}

function rate(approved: number, judged: number): number | null {
  return judged === 0 ? null : Number((approved / judged).toFixed(3));
}

export function computeMotiveAnalytics(
  motives: SentMessageMotiveRecord[],
  verdicts: MessageVerdictRecord[],
): MotiveAnalytics {
  // Newest motive record wins per (account, text): a repeated message keeps one identity here, and
  // the verdict that judged it judged the message, not a particular sending.
  const motiveByKey = new Map<string, SentMessageMotiveRecord>();
  for (const record of [...motives].sort((a, b) => a.createdAt - b.createdAt)) {
    motiveByKey.set(`${record.username.toLowerCase()}::${normalize(record.message)}`, record);
  }

  const bySource = new Map<string, MotiveSourceTypeStats>();
  const statsFor = (sourceType: string): MotiveSourceTypeStats => {
    let stats = bySource.get(sourceType);
    if (!stats) {
      stats = { sourceType, sent: 0, judged: 0, approved: 0, approvalRate: null };
      bySource.set(sourceType, stats);
    }
    return stats;
  };
  for (const record of motiveByKey.values()) statsFor(effectiveSourceType(record)).sent += 1;

  let personalJudged = 0;
  let personalApproved = 0;
  let genericJudged = 0;
  let genericApproved = 0;
  let totalJudged = 0;
  for (const verdict of verdicts) {
    const record = motiveByKey.get(`${verdict.username.toLowerCase()}::${normalize(verdict.message)}`);
    if (!record) continue;
    totalJudged += 1;
    const approved = verdict.verdict === 'good';
    const stats = statsFor(effectiveSourceType(record));
    stats.judged += 1;
    if (approved) stats.approved += 1;
    const personal = record.sourceValidated
      && record.validatedSourceType !== undefined
      && PERSONAL_SOURCE_TYPES.has(record.validatedSourceType);
    if (personal) {
      personalJudged += 1;
      if (approved) personalApproved += 1;
    } else {
      genericJudged += 1;
      if (approved) genericApproved += 1;
    }
  }
  for (const stats of bySource.values()) stats.approvalRate = rate(stats.approved, stats.judged);

  return {
    totalSent: motiveByKey.size,
    totalJudged,
    bySourceType: [...bySource.values()].sort((a, b) => b.sent - a.sent || a.sourceType.localeCompare(b.sourceType)),
    personalSourceApprovalRate: rate(personalApproved, personalJudged),
    genericEventOnlyApprovalRate: rate(genericApproved, genericJudged),
  };
}
