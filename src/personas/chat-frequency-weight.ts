import { PersonaActivityPattern } from './types';

/**
 * How much more likely a persona is to be offered a spontaneous moment, purely from its own
 * declared habit. Backend-only: never sent to the model, because chatFrequency read as a payload
 * field once meant "very-low → better stay quiet", the same restraint applied twice for the same
 * account. Here it only decides who the backend offers a chance to, never whether they take it.
 *
 * Shared between Persona Drive's own candidate weighting and the stream-event candidate shortlist,
 * so the two mechanisms agree on what "more talkative" means instead of maintaining two tables that
 * could quietly drift apart.
 */
export const CHAT_FREQUENCY_WEIGHT: Record<PersonaActivityPattern['chatFrequency'], number> = {
  'very-low': 0.15,
  low: 0.4,
  medium: 1,
  high: 2,
};
