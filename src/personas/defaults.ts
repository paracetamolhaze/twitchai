import { generatePersonaV3 } from './generator-v3';
import { BotPersona } from './types';

/**
 * Deep Persona v3 no longer seeds global archetypes. Accounts receive an
 * independent username-derived canon when BotManager/PersonaStore sees them.
 * Kept as an empty export for callers that previously imported demo defaults.
 */
export const DEFAULT_PERSONAS: BotPersona[] = [];

/** Backward-compatible entry point used by account provisioning. */
export function personaTemplateForUsername(username: string, index = 0): BotPersona {
  void index;
  return generatePersonaV3(username);
}
