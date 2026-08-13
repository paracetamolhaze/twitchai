import { BotPersona } from '../personas/types';
import { BotConnectionState } from '../persistence/repository';
import { StreamEvent } from '../stream-brain/types';

export interface ReactionBotCandidate {
  username: string;
  persona: BotPersona;
  enabled: boolean;
  connectionState: BotConnectionState;
  chatConnected: boolean;
  lastReactionAt?: number;
}

export interface PlannedReaction {
  reservationId: string;
  event: StreamEvent;
  bot: ReactionBotCandidate;
  delayMs: number;
  directMention: boolean;
}
