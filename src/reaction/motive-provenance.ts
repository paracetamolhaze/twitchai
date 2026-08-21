import { PERSONAL_SOURCE_TYPES } from '../brain/types';
import { emptySuppliedSources, SuppliedSources } from '../personas/persona-mind';
import { topicRelevance } from '../shared/topics';

/**
 * The check that keeps the motive fields honest.
 *
 * The Brain reports motive/sourceType/sourceRef with every reaction, and a self-report is not
 * evidence: a model can write the message first and invent a life story for it second —
 * sourceType=knowledge_gap, sourceRef=china_rent, when no such gap was ever supplied. Left
 * unchecked, the dashboard would then present fabricated provenance as fact and the whole Living
 * Persona criterion would be decorative. So every claimed PERSISTENT source is validated against
 * what the backend actually put in the payload for that persona — the frozen supplied pools, the
 * recalled memories, the canonical expertise and opinions — and a claim that matches nothing is a
 * rejection, not a footnote.
 *
 * Deterministic, local, and deliberately forgiving about CATEGORY: a real source cited under the
 * wrong label (the model calling a curiosity a knowledge_gap) is downgraded to the category where
 * the reference actually matched, because punishing taxonomy mistakes as hallucinations would
 * reject honest messages. What is never forgiven is a reference that matches nothing anywhere.
 */

export interface ProvenancePools {
  /** What the mind slice actually carried for this persona, frozen at payload time. */
  mind: SuppliedSources;
  /** Summaries of recalledMemories sent for this persona in the same payload. */
  memories: string[];
  /** Canonical grounding that travels via bootstrap rather than the event payload. */
  expertise: string[];
  opinions: string[];
  /** Whether the payload carried any recent chat for a chat-sourced reply to answer. */
  hadRecentChat: boolean;
}

export function emptyProvenancePools(): ProvenancePools {
  return { mind: emptySuppliedSources(), memories: [], expertise: [], opinions: [], hadRecentChat: false };
}

export interface ProvenanceVerdict {
  sourceValidated: boolean;
  validatedSourceType?: string;
  validationReason:
    | 'confirmed'
    | 'category_corrected'
    | 'structural'
    | 'not_personal'
    | 'unreported'
    | 'no_source_supplied'
    | 'ref_matches_nothing'
    | 'chat_not_supplied';
}

/** Sources that must point at something that really existed in the supplied state. */
const PERSISTENT_SOURCE_TYPES = new Set([
  'knowledge_gap', 'curiosity', 'memory', 'relationship', 'current_life', 'open_loop', 'belief', 'expertise',
]);

/** How the claimed reference is matched: token overlap via the shared topic yardstick, or plain
 *  substring either way — a ref like "аренда" against "аренда жилья в Шанхае" must count. */
function refMatches(reference: string, candidates: string[]): boolean {
  const needle = reference.trim().toLowerCase();
  if (!needle) return false;
  return candidates.some((candidate) => {
    const haystack = candidate.toLowerCase();
    if (haystack.includes(needle) || needle.includes(haystack)) return true;
    return topicRelevance(reference, candidate) > 0;
  });
}

function poolsByCategory(pools: ProvenancePools): Record<string, string[]> {
  return {
    knowledge_gap: [...pools.mind.knowledge_gap, ...pools.mind.curiosity],
    curiosity: pools.mind.curiosity,
    open_loop: pools.mind.open_loop,
    current_life: pools.mind.current_life,
    relationship: pools.mind.relationship,
    memory: [...pools.memories, ...pools.mind.open_loop],
    belief: pools.opinions,
    expertise: [...pools.expertise, ...pools.mind.expertise],
  };
}

export function validateMotiveProvenance(
  reaction: { sourceType?: string; sourceRef?: string; message: string },
  pools: ProvenancePools,
): ProvenanceVerdict {
  const sourceType = reaction.sourceType?.trim() ?? '';
  if (!sourceType) return { sourceValidated: false, validationReason: 'unreported' };

  if (sourceType === 'chat' || sourceType === 'chat_reply') {
    // A reply needs something to reply to; the payload either carried chat or it did not.
    return pools.hadRecentChat
      ? { sourceValidated: true, validatedSourceType: 'chat', validationReason: 'confirmed' }
      : { sourceValidated: false, validationReason: 'chat_not_supplied' };
  }

  if (!PERSISTENT_SOURCE_TYPES.has(sourceType)) {
    // event_emotion and none are structurally valid — a laugh needs no archive — but they are not
    // personal sources, and analytics keeps them apart from the validated-personal bucket.
    return {
      sourceValidated: true,
      validatedSourceType: sourceType,
      validationReason: PERSONAL_SOURCE_TYPES.has(sourceType) ? 'confirmed' : 'not_personal',
    };
  }

  const categories = poolsByCategory(pools);
  const claimedPool = categories[sourceType] ?? [];
  const reference = reaction.sourceRef?.trim() || '';
  // With no ref at all, a persistent claim can still be honest if exactly this category was
  // supplied — the model grounded in what it was shown and skipped the label.
  if (!reference) {
    return claimedPool.length > 0
      ? { sourceValidated: true, validatedSourceType: sourceType, validationReason: 'confirmed' }
      : { sourceValidated: false, validationReason: 'no_source_supplied' };
  }

  if (refMatches(reference, claimedPool)) {
    return { sourceValidated: true, validatedSourceType: sourceType, validationReason: 'confirmed' };
  }

  // Wrong label, real source: find where the reference actually matched. Taxonomy confusion is a
  // downgrade, not a hallucination.
  for (const [category, pool] of Object.entries(categories)) {
    if (category === sourceType) continue;
    if (refMatches(reference, pool)) {
      return { sourceValidated: true, validatedSourceType: category, validationReason: 'category_corrected' };
    }
  }

  return { sourceValidated: false, validationReason: 'ref_matches_nothing' };
}
