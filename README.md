# Twitch AI Viewers

Event-driven AI viewers for Twitch. One multimodal Gemini Live session understands the stream; independent personas decide whether they have a natural reason to react. This project connects accounts to official Twitch chat and does **not** manipulate viewer counts or simulate views.

## Architecture

```text
                                  ┌── Twitch IRC chat (official OAuth)
Twitch stream                     │         │
      │                           │         ├── recent real chat
  Streamlink                      │         └── direct @mentions
      │                           │
    FFmpeg ── PCM 16 kHz ─────┐   │
      └───── sampled JPEG ────┼───┴──> one Gemini Live Stream Brain
                              │              │
                              │       normalized StreamEvent
                              │              │
                              │      ReactionDecisionEngine
                              │              │
                              │      0..3 selected personas
                              │              │
                              │   Gemini text ResponseProvider
                              │     │        │          │
                              │  <skip>  duplicate  natural delay
                              │                       │
                              └────────────────> Twitch chat

PostgreSQL <── events, personas, reaction examples, bot history, settings
Railway backend <── HTTPS + authenticated Socket.IO ──> Vercel dashboard
```

The Stream Brain emits events rather than forcing a response for every sentence. `ReactionMemory` associates a normalized event with nearby messages from real viewers and retrieves similar examples as style evidence. Real messages are never automatically copied. Markov generation is not part of the system.

## Local development

Requirements:

- Node.js 20+
- FFmpeg on `PATH`
- Streamlink on `PATH`
- PostgreSQL for persistent development data (optional only for a short local demo)

```bash
npm ci
npm --prefix frontend ci
copy .env.example .env        # PowerShell / cmd
npm run db:migrate            # requires DATABASE_URL
npm run dev                   # backend, http://localhost:3000
npm --prefix frontend run dev # dashboard, http://localhost:5173
```

Without `DATABASE_URL`, the backend deliberately uses an in-memory repository and logs a warning. Nothing is written to an unreliable Railway filesystem.

## Environment variables

The complete, commented template is [.env.example](.env.example). Important groups:

- App: `PORT`, `LOG_LEVEL`, `DASHBOARD_TOKEN`, `FRONTEND_URL`
- Twitch: `TWITCH_CHANNEL`, client credentials, and numbered `BOTn_*` account variables
- Gemini: `GEMINI_API_KEY`, centralized `GEMINI_LIVE_MODEL`
- Stream: `STREAM_CONTEXT`, `VISION_FPS`, event/confidence thresholds
- Response: `RESPONSE_PROVIDER`, `RESPONSE_MODEL`, delay and rate settings
- Learning: reaction collection window and retrieval count
- Optional debug fallback: `TRANSCRIPTION_FALLBACK=groq-whisper`, `GROQ_API_KEY`
- Database: `DATABASE_URL`, `DATABASE_SSL`

Never prefix frontend variables with API keys or OAuth tokens. `DASHBOARD_TOKEN` is entered by the operator in the dashboard and stored only for the browser tab session.

## Twitch OAuth setup

1. Create an application in the [Twitch Developer Console](https://dev.twitch.tv/console).
2. Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`; the backend uses them for the official Helix category refresh.
3. Obtain a **user access token for each bot account** with `chat:read` and `chat:edit`.
4. Put the matching username and token in `BOT1_USERNAME` / `BOT1_OAUTH_TOKEN`, then repeat with `BOT2_*`, etc.
5. Do not reuse one account token under another username. Tokens are validated against Twitch before IRC connection and are never stored in PostgreSQL or logs.

The manager isolates account failures, tracks `DISCONNECTED`, `CONNECTING`, `CONNECTED`, `ERROR`, and `DISABLED`, and applies conservative local chat rate limits.

## Gemini setup

1. Create a key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Set `GEMINI_API_KEY` on the backend only.
3. Set `GEMINI_LIVE_MODEL` to the currently available Flash Live model. The model name is read in one config module and is not hardcoded across business logic.
4. Optionally change `RESPONSE_MODEL` independently; final response generation uses the `ResponseProvider` abstraction.

Audio is raw mono 16-bit PCM at 16 kHz in 40 ms chunks. Video is resized JPEG sampled at configurable `VISION_FPS` (0.05–1). Live sessions use context-window compression, session resumption handles, `goAway` handling, and exponential reconnect backoff.

## Database migrations

The initial schema lives in `migrations/001_initial.sql` and includes personas, bot metadata, reaction examples, message history, stream events, settings, and usage snapshots.

```bash
DATABASE_URL=postgresql://... npm run db:migrate
```

The PostgreSQL repository also applies pending idempotent migrations during initialization under an advisory lock.

## Railway deployment (backend)

1. Create a Railway service from this repository and attach PostgreSQL.
2. Add the backend variables from `.env.example`, including the Railway `DATABASE_URL`.
3. Set `FRONTEND_URL` to the exact Vercel origin; comma-separate additional trusted origins if needed.
4. Deploy. `nixpacks.toml` installs Node 20, FFmpeg, Streamlink, runs `npm ci`, and builds only the backend.
5. Railway starts `node dist/main.js` as a long-running process and checks `GET /health`.

`/health` is intentionally public and contains only booleans. It returns HTTP 200 when persistent storage is configured and healthy, while the Twitch, Stream Brain, and Gemini fields report their own live state; without healthy PostgreSQL it returns HTTP 503 with `status: "degraded"`. Every `/api/*` route and Socket.IO handshake requires `DASHBOARD_TOKEN`.

## Vercel deployment (dashboard)

Use `frontend/` as the Vercel Root Directory:

1. Framework preset: Vite.
2. Build command: `npm run build`.
3. Output: `dist`.
4. Set `VITE_API_URL=https://your-backend.up.railway.app`.
5. Add the resulting Vercel origin to backend `FRONTEND_URL` and redeploy the backend.

The dashboard provides Overview, bot states, normalized Stream Brain events, typed chat feed, usage counters, runtime settings, and persona editing. Channel and vision-FPS changes are persisted but require a backend restart; stream context and event threshold apply immediately.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
# or all checks once:
npm run verify
```

Live Gemini/Twitch integration cannot be exercised without real credentials and an active channel. Unit and API tests use fakes and never contact external services.

## Troubleshooting

- **Stream Brain remains DISABLED:** set both `TWITCH_CHANNEL` and `GEMINI_API_KEY`.
- **Media ERROR/OFFLINE:** verify `streamlink --version`, `ffmpeg -version`, and whether the channel is live.
- **Bot ERROR:** confirm token ownership and `chat:read` / `chat:edit` scopes. One bad bot does not stop the others.
- **Category is empty:** configure Twitch client ID/secret and check Helix access.
- **Dashboard says unauthorized:** `DASHBOARD_TOKEN` must match Railway and contain at least 16 characters.
- **Dashboard has CORS errors:** `FRONTEND_URL` must exactly match the browser origin, including scheme.
- **Gemini reconnects:** transient reconnects use bounded exponential backoff and session resumption; inspect redacted `[BRAIN]` logs.
- **Data disappears after restart:** configure PostgreSQL; in-memory mode is for local evaluation only.

## Production checklist

- [ ] Revoke and replace any credential ever exposed in a Git remote, terminal capture, or log.
- [ ] Store all secrets in Railway variables; keep `.env` untracked.
- [ ] Use a strong `DASHBOARD_TOKEN` and exact production `FRONTEND_URL`.
- [ ] Configure PostgreSQL and confirm migrations.
- [ ] Validate every bot's OAuth identity/scopes and enable accounts gradually.
- [ ] Confirm FFmpeg/Streamlink and `/health` after deploy.
- [ ] Confirm Gemini model availability and monitor reconnect/usage counters.
- [ ] Test dashboard HTTP and realtime authorization from the Vercel origin.
- [ ] Review Twitch rate limits and platform policy before production use.
