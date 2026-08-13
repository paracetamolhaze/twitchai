export interface BotPersona {
  id: string;
  name: string;
  description: string;
  styleInstructions: string;
  verbosity: { minWords: number; maxWords: number };
  reactionProbability: number;
  uppercaseProbability: number;
  questionProbability: number;
  emojiProbability: number;
  slangLevel: number;
  sarcasmLevel: number;
  toxicityLimit: number;
  interests: string[];
  temperature: number;
  minimumIntervalMs: number;
}

export interface BotMessageRecord {
  id: string;
  username: string;
  message: string;
  eventId?: string;
  sentAt: number;
}
