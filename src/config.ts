import { z } from 'zod';

export type TranscriptionProvider = 'gemini' | 'groq-whisper';

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
    frontendUrls: string[];
  };
  twitch: {
    channel: string;
    clientId?: string;
    clientSecret?: string;
    accounts: BotAccountConfig[];
    categoryRefreshMs: number;
  };
  gemini: {
    apiKey?: string;
    liveModel: string;
    responseModel: string;
  };
  stream: {
    context: string;
    visionFps: number;
    frameWidth: number;
    eventThreshold: number;
    confidenceThreshold: number;
    contextRefreshMs: number;
  };
  response: {
    provider: 'gemini';
    minimumDelayMs: number;
    maximumDelayMs: number;
    globalMessagesPer30Seconds: number;
  };
  learning: {
    enabled: boolean;
    reactionWindowSeconds: number;
    retrievalLimit: number;
  };
  transcription: {
    provider: TranscriptionProvider;
    fallback?: 'groq-whisper';
    groqApiKey?: string;
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
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  TWITCH_CHANNEL: z.string().default(''),
  TWITCH_CLIENT_ID: z.string().trim().optional(),
  TWITCH_CLIENT_SECRET: z.string().trim().optional(),
  TWITCH_CATEGORY_REFRESH_SECONDS: z.coerce.number().min(30).max(3600).default(120),
  GEMINI_API_KEY: z.string().trim().optional(),
  GEMINI_LIVE_MODEL: z.string().trim().default('gemini-3.1-flash-live-preview'),
  RESPONSE_PROVIDER: z.literal('gemini').default('gemini'),
  RESPONSE_MODEL: z.string().trim().default('gemini-3.1-flash-lite'),
  STREAM_CONTEXT: z.string().default(''),
  VISION_FPS: z.coerce.number().min(0.05).max(1).default(1),
  VISION_FRAME_WIDTH: z.coerce.number().int().min(320).max(1280).default(640),
  EVENT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.45),
  EVENT_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  STREAM_CONTEXT_REFRESH_SECONDS: z.coerce.number().min(10).max(300).default(30),
  REACTION_MIN_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(1200),
  REACTION_MAX_DELAY_MS: z.coerce.number().int().min(100).max(120_000).default(9000),
  CHAT_MESSAGES_PER_30_SECONDS: z.coerce.number().int().min(1).max(20).default(18),
  LEARN_ENABLED: z.string().default('true'),
  LEARN_REACTION_WINDOW_SECONDS: z.coerce.number().int().min(5).max(120).default(25),
  LEARN_RETRIEVAL_LIMIT: z.coerce.number().int().min(1).max(10).default(4),
  TRANSCRIPTION_PROVIDER: z.enum(['gemini', 'groq-whisper']).default('gemini'),
  TRANSCRIPTION_FALLBACK: z.enum(['groq-whisper']).optional(),
  GROQ_API_KEY: z.string().trim().optional(),
  ORIGINAL_STREAM_LANGUAGE: z.string().trim().default('ru'),
  DATABASE_URL: z.string().trim().optional(),
  DATABASE_SSL: z.string().default('true'),
});

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
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
  const minimumDelayMs = parsed.REACTION_MIN_DELAY_MS;
  const maximumDelayMs = Math.max(minimumDelayMs, parsed.REACTION_MAX_DELAY_MS);

  return {
    app: {
      nodeEnv: parsed.NODE_ENV,
      port: parsed.PORT,
      logLevel: parsed.LOG_LEVEL,
      dashboardToken: parsed.DASHBOARD_TOKEN,
      frontendUrls: parsed.FRONTEND_URL.split(',').map((url) => url.trim()).filter(Boolean),
    },
    twitch: {
      channel: normalizeChannel(parsed.TWITCH_CHANNEL),
      clientId: parsed.TWITCH_CLIENT_ID,
      clientSecret: parsed.TWITCH_CLIENT_SECRET,
      accounts: readBotAccounts(env),
      categoryRefreshMs: parsed.TWITCH_CATEGORY_REFRESH_SECONDS * 1000,
    },
    gemini: {
      apiKey: parsed.GEMINI_API_KEY,
      liveModel: parsed.GEMINI_LIVE_MODEL,
      responseModel: parsed.RESPONSE_MODEL,
    },
    stream: {
      context: parsed.STREAM_CONTEXT.trim(),
      visionFps: parsed.VISION_FPS,
      frameWidth: parsed.VISION_FRAME_WIDTH,
      eventThreshold: parsed.EVENT_THRESHOLD,
      confidenceThreshold: parsed.EVENT_CONFIDENCE_THRESHOLD,
      contextRefreshMs: parsed.STREAM_CONTEXT_REFRESH_SECONDS * 1000,
    },
    response: {
      provider: parsed.RESPONSE_PROVIDER,
      minimumDelayMs,
      maximumDelayMs,
      globalMessagesPer30Seconds: parsed.CHAT_MESSAGES_PER_30_SECONDS,
    },
    learning: {
      enabled: bool(parsed.LEARN_ENABLED, true),
      reactionWindowSeconds: parsed.LEARN_REACTION_WINDOW_SECONDS,
      retrievalLimit: parsed.LEARN_RETRIEVAL_LIMIT,
    },
    transcription: {
      provider: parsed.TRANSCRIPTION_PROVIDER,
      fallback: parsed.TRANSCRIPTION_FALLBACK,
      groqApiKey: parsed.GROQ_API_KEY,
      language: parsed.ORIGINAL_STREAM_LANGUAGE,
    },
    database: {
      url: parsed.DATABASE_URL,
      ssl: bool(parsed.DATABASE_SSL, true),
    },
  };
}
