import { z } from 'zod';

/**
 * Where speech comes from. `live` is the Gemini Live session transcribing as a side effect of
 * holding a conversation; `shadow` runs the transcription layer alongside it and only records what
 * it heard, so the two can be compared on one stream; `transcriber` makes it the only source.
 *
 * Named for the role, not for a model: which service actually listens is TRANSCRIPTION_PROVIDER,
 * and it has already changed once.
 */
export type TranscriptionMode = 'live' | 'shadow' | 'transcriber';

export interface BotAccountConfig {
  username: string;
  oauthToken: string;
  personaId: string;
  enabled: boolean;
}

export interface AppConfig {
  app: {
    nodeEnv: 'development' | 'test' | 'production';
    port: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    dashboardToken?: string;
    dashboardSessionDays: number;
    frontendUrls: string[];
  };
  twitch: {
    channel: string;
    clientId?: string;
    clientSecret?: string;
    oauthRedirectUri?: string;
    tokenEncryptionKey?: string;
    accounts: BotAccountConfig[];
    categoryRefreshMs: number;
  };
  gemini: {
    apiKey?: string;
    liveModel: string;
    liveResponseModality: 'text' | 'audio';
    liveSpeechStartSensitivity: 'low' | 'high';
    liveSpeechEndSensitivity: 'low' | 'high';
    liveSpeechSilenceMs: number;
    brainModel: string;
    brainThinkingLevel: 'low' | 'medium' | 'high';
    brainEventMergeWindowMs: number;
    brainContextRolloverTokens: number;
    brainInteractionTimeoutMs: number;
    momentFreshnessMs: number;
  };
  openRouter: {
    /** Set to route the Brain through OpenRouter instead of Gemini's stateful Interactions API. */
    apiKey?: string;
    brainModel: string;
    /**
     * The offline Feedback Teacher's model. It runs rarely, on a batch, and is judged on how well it
     * generalizes rather than on latency, so a stronger and slower model is the right trade here and
     * the wrong one for the per-event Brain. Defaults to the Brain's own model: shipping a default
     * naming a model this deployment may not have access to would break the feature on first run,
     * and one env var is a cheaper way to opt into a bigger one than a broken default is to fix.
     */
    teacherModel: string;
    appUrl?: string;
    appName: string;
  };
  vision: {
    /** Empty disables watching entirely; the accounts then work from speech and chat alone. */
    model: string;
    describeIntervalMs: number;
  };
  stream: {
    context: string;
    visionFps: number;
    frameWidth: number;
    confidenceThreshold: number;
    contextRefreshMs: number;
  };
  reaction: {
    globalMessagesPer30Seconds: number;
    maxReactionsPerEvent: number;
    reactionShareOfCandidates: number;
    batchStaggerMs: number;
  };
  learning: {
    enabled: boolean;
    reactionWindowSeconds: number;
    retrievalLimit: number;
  };
  globalMemory: {
    retrievalLimit: number;
    snapshotLimit: number;
    sessionStaleMinutes: number;
    /** Only this channel's streams accumulate durable memory. Empty means every channel does. */
    channel: string;
  };
  personaDrive: {
    enabled: boolean;
    minIntervalMs: number;
    maxIntervalMs: number;
    minQuietMs: number;
    globalCooldownMs: number;
    personaCooldownMs: number;
    maxCandidates: number;
    maxBrainCallsPerHour: number;
    maxMessagesPerHour: number;
    maxBrainCallProbability: number;
  };
  transcription: {
    mode: TranscriptionMode;
    /** Which service listens. Both take the same segments; only accuracy and price differ. */
    provider: 'openrouter' | 'groq';
    groqApiKey?: string;
    model: string;
    groqModel: string;
    windowMs: number;
    overlapMs: number;
    language: string;
  };
  database: {
    url?: string;
    ssl: boolean;
  };
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DASHBOARD_TOKEN: z.string().trim().min(16).optional(),
  DASHBOARD_SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  TWITCH_CHANNEL: z.string().default(''),
  TWITCH_CLIENT_ID: z.string().trim().optional(),
  TWITCH_CLIENT_SECRET: z.string().trim().optional(),
  TWITCH_OAUTH_REDIRECT_URI: z.string().trim().url().optional(),
  TWITCH_TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),
  TWITCH_CATEGORY_REFRESH_SECONDS: z.coerce.number().min(30).max(3600).default(120),
  GEMINI_API_KEY: z.string().trim().optional(),
  OPENROUTER_API_KEY: z.string().trim().optional(),
  OPENROUTER_BRAIN_MODEL: z.string().trim().default('google/gemini-3.7-flash'),
  OPENROUTER_TEACHER_MODEL: z.string().trim().optional(),
  OPENROUTER_APP_NAME: z.string().trim().default('twitch-ai'),
  GEMINI_LIVE_MODEL: z.string().trim().default('gemini-3.1-flash-live-preview'),
  // Text output would be both cheaper ($4.5/M against $12/M) and closer to what this layer does,
  // since perception is instructed never to speak and its audio is discarded on arrival — but
  // gemini-3.1-flash-live-preview rejects the session outright with 1007: "The requested
  // combination of response modalities (TEXT) is not supported by the model." Kept configurable
  // for a model that does support it; on this one, audio is the only working value.
  GEMINI_LIVE_RESPONSE_MODALITY: z.enum(['text', 'audio']).default('audio'),
  // Live defaults to high sensitivity, tuned for conversation. Watching a stream is the opposite:
  // a pause mid-sentence ends a turn, and every turn re-bills the whole retained context, so one
  // thought spoken with pauses is billed several times. Low merges them; the cost is about a
  // second of added latency, which nobody is waiting on here.
  // Split on purpose: setting both low cost transcription outright — an outdoor stream is speech
  // over wind and crowd, so a low start threshold missed it entirely and perception was left
  // describing what it saw while guessing at what was said.
  GEMINI_LIVE_SPEECH_START_SENSITIVITY: z.enum(['low', 'high']).default('high'),
  GEMINI_LIVE_SPEECH_END_SENSITIVITY: z.enum(['low', 'high']).default('low'),
  GEMINI_LIVE_SPEECH_SILENCE_MS: z.coerce.number().int().min(200).max(5_000).default(1_200),
  GEMINI_BRAIN_MODEL: z.string().trim().default('gemini-3.7-flash'),
  GEMINI_BRAIN_THINKING_LEVEL: z.enum(['low', 'medium', 'high']).default('low'),
  BRAIN_EVENT_MERGE_WINDOW_MS: z.coerce.number().int().min(0).max(2_000).default(250),
  // The Interactions API bills each chained call for the whole reconstructed conversation, so
  // input tokens grow with every decision in a session. 75% of the 1,048,576-token window (the
  // old default) let a single session's per-call cost run into the hundreds of thousands of
  // tokens before ever resetting. Roll over much sooner instead; a fresh bootstrap is cheap
  // (~15K tokens) next to letting the chain run unchecked.
  // Each chained call re-reads the whole conversation, so this bounds what one decision can cost.
  // Lower than it looks safe because a rollover no longer forgets: the outgoing session writes a
  // recap that travels into the next one, so the shorter chain costs recall of detail, not of the
  // stream. Measured at 150k the chain grew about 1.4k tokens a minute and reached 53k in 38.
  BRAIN_CONTEXT_ROLLOVER_TOKENS: z.coerce.number().int().min(20_000).max(1_048_576).default(60_000),
  // Must stay below the 45s reaction context TTL: a decision arriving after its context expired is
  // discarded anyway, so waiting longer only holds up every event queued behind it.
  // How long a moment stays worth answering. Past this it is left alone rather than answered late:
  // a reply about something the stream has moved on from reads as not having watched. Held above
  // the model's own latency so an ordinary decision is never caught by it.
  MOMENT_FRESHNESS_SECONDS: z.coerce.number().int().min(5).max(120).default(25),
  BRAIN_INTERACTION_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(40).default(35),
  STREAM_CONTEXT: z.string().default(''),
  // One frame per second is far more than an IRL stream needs — a moment worth reacting to lasts
  // seconds, and video is the largest share of perception input. Raise only if events are missed.
  VISION_FPS: z.coerce.number().min(0.05).max(1).default(0.33),
  VISION_MODEL: z.string().default('google/gemini-3.5-flash-lite'),
  VISION_DESCRIBE_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(300).default(25),
  VISION_FRAME_WIDTH: z.coerce.number().int().min(320).max(1280).default(640),
  EVENT_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  STREAM_CONTEXT_REFRESH_SECONDS: z.coerce.number().min(10).max(300).default(30),
  CHAT_MESSAGES_PER_30_SECONDS: z.coerce.number().int().min(1).max(20).default(18),
  // Ceiling only: the number allowed for one moment scales with how many accounts are available,
  // so four connected accounts get one voice and thirty get four or five.
  MAX_REACTIONS_PER_EVENT: z.coerce.number().int().min(1).max(10).default(5),
  REACTION_SHARE_OF_CANDIDATES: z.coerce.number().min(0.02).max(1).default(0.15),
  // Spacing between accounts answering the same event. The first still replies immediately; this
  // only stops two accounts hitting Twitch in the same instant, which it can drop silently.
  REACTION_BATCH_STAGGER_MS: z.coerce.number().int().min(0).max(10_000).default(900),
  LEARN_ENABLED: z.string().default('true'),
  LEARN_REACTION_WINDOW_SECONDS: z.coerce.number().int().min(5).max(120).default(25),
  LEARN_RETRIEVAL_LIMIT: z.coerce.number().int().min(1).max(10).default(4),
  GLOBAL_MEMORY_RETRIEVAL_LIMIT: z.coerce.number().int().min(1).max(15).default(6),
  GLOBAL_MEMORY_SNAPSHOT_LIMIT: z.coerce.number().int().min(1).max(15).default(10),
  GLOBAL_MEMORY_SESSION_STALE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  GLOBAL_MEMORY_CHANNEL: z.string().default(''),
  TRANSCRIPTION_MODE: z.enum(['live', 'shadow', 'transcriber']).default('live'),
  TRANSCRIPTION_PROVIDER: z.enum(['openrouter', 'groq']).default('openrouter'),
  // Chosen on a real minute of the stream rather than on a synthesised phrase, which is how the
  // previous choice went wrong: clean studio speech says nothing about a far-field microphone with
  // three people talking over café noise. On that minute 3.7-flash caught whole idioms
  // ("инициатива, как говорится, наказуема") where 3.5-flash-lite produced "оличная два вообще базу
  // выдаёт" for "уличные торговцы вообще базу выдают" — and cost less per window measured, not
  // assumed. 3.5-flash, the full one, leaked its own deliberation into the transcript.
  TRANSCRIPTION_MODEL: z.string().default('google/gemini-3.7-flash'),
  TRANSCRIPTION_GROQ_MODEL: z.string().default('whisper-large-v3-turbo'),
  // How much audio goes in one request. An hour of audio is about ninety thousand tokens, three
  // cents, so windows exist to shape latency and request count rather than to save money.
  TRANSCRIPTION_WINDOW_SECONDS: z.coerce.number().int().min(4).max(30).default(12),
  TRANSCRIPTION_OVERLAP_SECONDS: z.coerce.number().min(0).max(5).default(1.5),
  GROQ_API_KEY: z.string().trim().optional(),
  ORIGINAL_STREAM_LANGUAGE: z.string().trim().default('ru'),
  DATABASE_URL: z.string().trim().optional(),
  DATABASE_SSL: z.string().default('true'),
  PERSONA_DRIVE_ENABLED: z.string().default('true'),
  PERSONA_DRIVE_MIN_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3_600).default(22),
  PERSONA_DRIVE_MAX_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(7_200).default(45),
  PERSONA_DRIVE_MIN_QUIET_SECONDS: z.coerce.number().int().min(0).max(3_600).default(12),
  PERSONA_DRIVE_GLOBAL_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3_600).default(20),
  PERSONA_DRIVE_PERSONA_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(21_600).default(150),
  PERSONA_DRIVE_MAX_CANDIDATES: z.coerce.number().int().min(1).max(10).default(3),
  // Hard rule, not actually configurable: at most one autonomous persona speaks per opportunity
  // (enforced in code regardless of this value). Kept as a validated env var so a misconfiguration
  // fails loudly at startup instead of silently doing nothing.
  PERSONA_DRIVE_MAX_REACTIONS: z.coerce.number().int().min(1).max(1).default(1),
  PERSONA_DRIVE_MAX_BRAIN_CALLS_PER_HOUR: z.coerce.number().int().min(0).max(400).default(90),
  PERSONA_DRIVE_MAX_MESSAGES_PER_HOUR: z.coerce.number().int().min(0).max(400).default(50),
  PERSONA_DRIVE_MAX_BRAIN_CALL_PROBABILITY: z.coerce.number().min(0).max(1).default(0.9),
}).refine(
  (value) => value.PERSONA_DRIVE_MAX_INTERVAL_SECONDS >= value.PERSONA_DRIVE_MIN_INTERVAL_SECONDS,
  {
    message: 'PERSONA_DRIVE_MAX_INTERVAL_SECONDS must be >= PERSONA_DRIVE_MIN_INTERVAL_SECONDS',
    path: ['PERSONA_DRIVE_MAX_INTERVAL_SECONDS'],
  },
);

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Whether what happens on a channel is worth remembering permanently.
 *
 * The pipeline is regularly exercised against a throwaway channel, and those streams are not the
 * streamer the characters are supposed to know. Memory is stored per channel, so a test stream
 * could never surface on the real one, but it still opened sessions and wrote rows about a person
 * nobody is watching. With memoryChannel set, only that channel accumulates anything; empty keeps
 * the old behaviour of every channel counting.
 */
export function accumulatesMemory(channel: string, memoryChannel: string): boolean {
  if (!memoryChannel) return true;
  return normalizeChannel(channel) === normalizeChannel(memoryChannel);
}

export function normalizeChannel(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?twitch\.tv\//i, '')
    .replace(/^#/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function readBotAccounts(env: NodeJS.ProcessEnv): BotAccountConfig[] {
  const accounts: BotAccountConfig[] = [];
  for (let index = 1; index <= 50; index += 1) {
    const username = env[`BOT${index}_USERNAME`]?.trim().toLowerCase();
    const oauthToken = (
      env[`BOT${index}_OAUTH_TOKEN`] ?? env[`BOT${index}_OAUTH`] ?? ''
    ).trim();
    if (!username || !oauthToken) continue;
    accounts.push({
      username,
      oauthToken,
      personaId: env[`BOT${index}_PERSONA`]?.trim() || `persona-${index}`,
      enabled: bool(env[`BOT${index}_ENABLED`], true),
    });
  }
  return accounts;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  return {
    app: {
      nodeEnv: parsed.NODE_ENV,
      port: parsed.PORT,
      logLevel: parsed.LOG_LEVEL,
      dashboardToken: parsed.DASHBOARD_TOKEN,
      dashboardSessionDays: parsed.DASHBOARD_SESSION_DAYS,
      frontendUrls: parsed.FRONTEND_URL.split(',').map((url) => url.trim()).filter(Boolean),
    },
    twitch: {
      channel: normalizeChannel(parsed.TWITCH_CHANNEL),
      clientId: parsed.TWITCH_CLIENT_ID,
      clientSecret: parsed.TWITCH_CLIENT_SECRET,
      oauthRedirectUri: parsed.TWITCH_OAUTH_REDIRECT_URI,
      tokenEncryptionKey: parsed.TWITCH_TOKEN_ENCRYPTION_KEY,
      accounts: readBotAccounts(env),
      categoryRefreshMs: parsed.TWITCH_CATEGORY_REFRESH_SECONDS * 1000,
    },
    gemini: {
      apiKey: parsed.GEMINI_API_KEY,
      liveModel: parsed.GEMINI_LIVE_MODEL,
      liveResponseModality: parsed.GEMINI_LIVE_RESPONSE_MODALITY,
      liveSpeechStartSensitivity: parsed.GEMINI_LIVE_SPEECH_START_SENSITIVITY,
      liveSpeechEndSensitivity: parsed.GEMINI_LIVE_SPEECH_END_SENSITIVITY,
      liveSpeechSilenceMs: parsed.GEMINI_LIVE_SPEECH_SILENCE_MS,
      brainModel: parsed.GEMINI_BRAIN_MODEL,
      brainThinkingLevel: parsed.GEMINI_BRAIN_THINKING_LEVEL,
      brainEventMergeWindowMs: parsed.BRAIN_EVENT_MERGE_WINDOW_MS,
      brainContextRolloverTokens: parsed.BRAIN_CONTEXT_ROLLOVER_TOKENS,
      brainInteractionTimeoutMs: parsed.BRAIN_INTERACTION_TIMEOUT_SECONDS * 1000,
      momentFreshnessMs: parsed.MOMENT_FRESHNESS_SECONDS * 1000,
    },
    openRouter: {
      apiKey: parsed.OPENROUTER_API_KEY,
      brainModel: parsed.OPENROUTER_BRAIN_MODEL,
      teacherModel: parsed.OPENROUTER_TEACHER_MODEL || parsed.OPENROUTER_BRAIN_MODEL,
      ...(parsed.FRONTEND_URL ? { appUrl: parsed.FRONTEND_URL.split(',')[0] } : {}),
      appName: parsed.OPENROUTER_APP_NAME,
    },
    vision: {
      model: parsed.VISION_MODEL.trim(),
      describeIntervalMs: parsed.VISION_DESCRIBE_INTERVAL_SECONDS * 1000,
    },
    stream: {
      context: parsed.STREAM_CONTEXT.trim(),
      visionFps: parsed.VISION_FPS,
      frameWidth: parsed.VISION_FRAME_WIDTH,
      confidenceThreshold: parsed.EVENT_CONFIDENCE_THRESHOLD,
      contextRefreshMs: parsed.STREAM_CONTEXT_REFRESH_SECONDS * 1000,
    },
    reaction: {
      globalMessagesPer30Seconds: parsed.CHAT_MESSAGES_PER_30_SECONDS,
      maxReactionsPerEvent: parsed.MAX_REACTIONS_PER_EVENT,
      reactionShareOfCandidates: parsed.REACTION_SHARE_OF_CANDIDATES,
      batchStaggerMs: parsed.REACTION_BATCH_STAGGER_MS,
    },
    learning: {
      enabled: bool(parsed.LEARN_ENABLED, true),
      reactionWindowSeconds: parsed.LEARN_REACTION_WINDOW_SECONDS,
      retrievalLimit: parsed.LEARN_RETRIEVAL_LIMIT,
    },
    globalMemory: {
      retrievalLimit: parsed.GLOBAL_MEMORY_RETRIEVAL_LIMIT,
      snapshotLimit: parsed.GLOBAL_MEMORY_SNAPSHOT_LIMIT,
      sessionStaleMinutes: parsed.GLOBAL_MEMORY_SESSION_STALE_MINUTES,
      channel: normalizeChannel(parsed.GLOBAL_MEMORY_CHANNEL),
    },
    personaDrive: {
      enabled: bool(parsed.PERSONA_DRIVE_ENABLED, true),
      minIntervalMs: parsed.PERSONA_DRIVE_MIN_INTERVAL_SECONDS * 1000,
      maxIntervalMs: parsed.PERSONA_DRIVE_MAX_INTERVAL_SECONDS * 1000,
      minQuietMs: parsed.PERSONA_DRIVE_MIN_QUIET_SECONDS * 1000,
      globalCooldownMs: parsed.PERSONA_DRIVE_GLOBAL_COOLDOWN_SECONDS * 1000,
      personaCooldownMs: parsed.PERSONA_DRIVE_PERSONA_COOLDOWN_SECONDS * 1000,
      maxCandidates: parsed.PERSONA_DRIVE_MAX_CANDIDATES,
      maxBrainCallsPerHour: parsed.PERSONA_DRIVE_MAX_BRAIN_CALLS_PER_HOUR,
      maxMessagesPerHour: parsed.PERSONA_DRIVE_MAX_MESSAGES_PER_HOUR,
      maxBrainCallProbability: parsed.PERSONA_DRIVE_MAX_BRAIN_CALL_PROBABILITY,
    },
    transcription: {
      mode: parsed.TRANSCRIPTION_MODE,
      provider: parsed.TRANSCRIPTION_PROVIDER,
      model: parsed.TRANSCRIPTION_MODEL,
      groqModel: parsed.TRANSCRIPTION_GROQ_MODEL,
      windowMs: parsed.TRANSCRIPTION_WINDOW_SECONDS * 1000,
      overlapMs: Math.round(parsed.TRANSCRIPTION_OVERLAP_SECONDS * 1000),
      groqApiKey: parsed.GROQ_API_KEY,
      language: parsed.ORIGINAL_STREAM_LANGUAGE,
    },
    database: {
      url: parsed.DATABASE_URL,
      ssl: bool(parsed.DATABASE_SSL, true),
    },
  };
}
