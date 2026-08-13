# Twitch AI Viewers

Система событийных AI-зрителей Twitch. Одна мультимодальная сессия Gemini Live видит стрим, слышит речь, учитывает чат и память, сама выбирает подходящие персоны и пишет все финальные реакции. Проект подключает аккаунты только к официальному Twitch IRC и не накручивает просмотры.

## Архитектура

```text
Twitch stream
    │
Streamlink → FFmpeg ── PCM 16 kHz ─┐
                    └─ JPEG ≤1 FPS ├──────────────┐
Twitch IRC ─ recent chat / @mentions ─────────────┤
PostgreSQL ─ events / history / ReactionMemory ───┤
                                                  ▼
                           ONE Gemini 3.1 Flash Live session
                                      │
                          prepare_reaction_context
                                      │
                 all eligible personas + each history + chat
                         + retrieved examples + constraints
                                      │
                            emit_reaction_batch (0..N)
                                      │
                         backend PolicyGuard + Scheduler
                                      │
                       natural delays → official Twitch chat

Railway backend ← authenticated HTTPS + Socket.IO → Vercel dashboard
                         │
                     PostgreSQL
```

В production нет отдельных вызовов AI для каждого бота, `generateContent`, Flash Lite, Markov-генератора или правила «всегда ответить». Пустой `reactions: []` — нормальное решение промолчать. Backend не принимает творческих решений: он только проверяет аккаунт, соединение, cooldown, дубликаты, длину и лимиты, затем разносит готовые сообщения по естественным задержкам.

## Локальная разработка

Требования: Node.js 20+, FFmpeg, Streamlink и PostgreSQL для постоянных данных.

```powershell
npm ci
npm --prefix frontend ci
Copy-Item .env.example .env
npm run db:migrate
npm run dev
# в другом терминале
npm --prefix frontend run dev
```

Backend: `http://localhost:3000`, dashboard: `http://localhost:5173`. Без `DATABASE_URL` backend запустит временное in-memory хранилище и явно предупредит об этом.

## Переменные окружения

Полный шаблон находится в [.env.example](.env.example). Основные группы:

- приложение: `PORT`, `LOG_LEVEL`, `DASHBOARD_TOKEN`, `DASHBOARD_SESSION_DAYS`, `FRONTEND_URL`;
- Twitch: необязательный стартовый `TWITCH_CHANNEL`, Client ID/Secret и `BOTn_*`;
- Gemini: `GEMINI_API_KEY`, централизованный `GEMINI_LIVE_MODEL`;
- медиа: `STREAM_CONTEXT`, `VISION_FPS`, `VISION_FRAME_WIDTH`;
- hard policy: задержки, общий rate limit и `MAX_REACTIONS_PER_EVENT`;
- обучение: окно сбора и количество retrieval-примеров;
- необязательный debug/fallback Whisper через Groq;
- PostgreSQL: `DATABASE_URL`, `DATABASE_SSL`.

Канал обычно вводится в русскоязычном dashboard и хранится в PostgreSQL, поэтому `TWITCH_CHANNEL` в Railway можно оставить пустым. Смена канала и `VISION_FPS` применяются без ручного рестарта.

## Авторизация dashboard

`DASHBOARD_TOKEN` вводится только при первом входе. Backend проверяет его и выдаёт подписанную HttpOnly Secure cookie на срок `DASHBOARD_SESSION_DAYS` (по умолчанию 30 дней). Исходный токен не сохраняется в `localStorage`, `sessionStorage` или JavaScript и не передаётся в Socket.IO payload. Повторный ввод нужен только после истечения cookie, очистки данных браузера или смены `DASHBOARD_TOKEN`.

Production CORS принимает только точные адреса из `FRONTEND_URL`; cookie и realtime-соединение используют тот же авторизованный контур. API-ключи Gemini и OAuth Twitch во frontend не попадают.

## Настройка Twitch OAuth

1. Создайте приложение в [Twitch Developer Console](https://dev.twitch.tv/console).
2. Задайте `TWITCH_CLIENT_ID` и `TWITCH_CLIENT_SECRET` для автоматического обновления категории.
3. Получите отдельный user access token каждого bot-аккаунта со scope `chat:read` и `chat:edit`.
4. Добавьте `BOT1_USERNAME` и `BOT1_OAUTH_TOKEN`, затем следующие аккаунты. Для миграции поддерживается старое имя `BOTn_OAUTH`.
5. Token каждого аккаунта проверяется официальным endpoint Twitch; один сломанный аккаунт не останавливает остальные.

Состояния: `DISCONNECTED`, `CONNECTING`, `CONNECTED`, `ERROR`, `DISABLED`. Backend применяет дополнительный локальный Twitch rate limiter.

## Настройка Gemini Live

1. Создайте ключ в [Google AI Studio](https://aistudio.google.com/apikey).
2. Добавьте `GEMINI_API_KEY` только в Railway.
3. По умолчанию используется `GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview`; имя модели меняется в одном env без правок бизнес-логики.

Аудио отправляется как mono 16-bit PCM 16 kHz по 40 мс. Видео — JPEG с настраиваемой частотой `0.05–1 FPS`. Live-сессия использует low media resolution, input transcription, low thinking, context-window compression, resumption handle, обработку `goAway` и bounded exponential backoff. Ответная аудиодорожка Gemini не воспроизводится: модель обязана принимать решения через два синхронных tool call.

## PostgreSQL и миграции

`migrations/001_initial.sql` создаёт таблицы персон, метаданных ботов, ReactionMemory, истории сообщений, событий стрима, runtime settings и usage snapshots.

```powershell
$env:DATABASE_URL='postgresql://...'
npm run db:migrate
```

Миграции идемпотентны, выполняются под advisory lock и также автоматически проверяются при старте backend.

### Перенос со старого Railway

Старая production-среда использовала service variables и могла хранить `config-<channel>.json` на volume/эфемерном диске. Без доступа к старому workspace секретные значения получить нельзя. Создайте API token именно в workspace старого проекта и выполните локально:

```powershell
$env:RAILWAY_SOURCE_TOKEN='токен старого workspace'
$env:RAILWAY_TARGET_TOKEN='токен нового workspace'
npm run railway:migrate:variables
```

Скрипт переносит совместимые Twitch/Gemini/Groq и `BOTn_*` переменные напрямую Railway→Railway, не печатая значения. Он намеренно сохраняет новые `DATABASE_URL`, `FRONTEND_URL`, `DASHBOARD_TOKEN` и не переносит `TWITCH_CHANNEL`, потому что канал теперь задаётся в dashboard. Sealed variables Railway нельзя прочитать через API — их надо создать заново.

Если у старого сервиса есть volume, сначала скачайте `config-<channel>.json`, затем импортируйте совместимые пользовательские персоны и историю отправленных ботами сообщений:

```powershell
$env:DATABASE_URL='postgresql://...'
$env:LEGACY_CHANNEL='имя_канала' # необязательно
npm run db:import:legacy -- C:\path\to\config-channel.json
```

Старый `markov-data.json` остаётся архивом и не импортируется в production: цепочки Markov не содержат надёжной связи `событие → реальные реакции` и возвращать их в генерацию нельзя. Новая `ReactionMemory` начинает собирать корректные пары автоматически. Если старый файл находился только на эфемерном Railway filesystem и уже исчез после redeploy, восстановить его технически невозможно; проверьте вкладки Volumes/Backups старого проекта до удаления.

Если аккаунты экспортированы в локальный `twitchaccs.txt`, файл уже исключён через `.gitignore`. Безопасный импорт выполняется командой:

```powershell
npm run railway:import:twitch-accounts -- twitchaccs.txt
```

Скрипт распознаёт явно помеченные `oauth:`/`token:` значения и bare-token только в последней строке известного трёхстрочного legacy-блока. Затем он отправляет access token в официальный Twitch `/oauth2/validate`, получает настоящий login и загружает в Railway только `BOTn_USERNAME`, `BOTn_OAUTH_TOKEN`, persona и enabled-state. Неиспользуемые `BOTn_*` слоты очищаются. Email и password не отправляются и не загружаются. Аккаунты без текущих IRC scopes `chat:read` + `chat:edit` импортируются выключенными до повторной OAuth-авторизации. Подключение к Twitch IRC означает участие в чате; оно не имитирует просмотр видеопотока и не гарантирует увеличение `viewer_count`.

## Railway: backend

1. Создайте service из этого репозитория и подключите PostgreSQL.
2. Добавьте backend-переменные из `.env.example`; `DATABASE_URL` лучше задавать ссылкой `${{Postgres.DATABASE_URL}}`.
3. Укажите точный Vercel origin в `FRONTEND_URL`.
4. `nixpacks.toml` ставит Node 20, FFmpeg и Streamlink; Railway запускает `node dist/main.js` как long-running process.
5. Healthcheck: `GET /health`. Ответ не содержит секретов.

## Vercel: dashboard

Root Directory: `frontend/`, Framework: Vite, Output: `dist`. Единственная production-переменная frontend:

```env
VITE_API_URL=https://your-backend.up.railway.app
```

Dashboard показывает состояние backend/Twitch/Gemini, аккаунты, события, чат, решения AI, usage, настройки канала и персон. Постоянные Twitch/Gemini/FFmpeg соединения на Vercel не создаются.

## Проверка

```powershell
npm run verify
```

Команда один раз выполняет lint, backend/frontend/test typecheck, unit/API tests и обе production-сборки. Реальный Twitch/Gemini поток требует валидных credentials и активного канала; тесты внешние сервисы не вызывают.

## Диагностика

- **Мозг стрима выключен:** проверьте `GEMINI_API_KEY` и модель; канал можно задать в dashboard.
- **Медиапоток offline/error:** проверьте Streamlink, FFmpeg и активность канала.
- **Bot ERROR:** проверьте владельца токена и scopes `chat:read`/`chat:edit`.
- **Категория не обновляется:** нужны Twitch Client ID/Secret.
- **Dashboard снова просит токен:** cookie истекла/очищена, `DASHBOARD_TOKEN` сменился или браузер блокирует cross-site cookies.
- **CORS:** `FRONTEND_URL` должен точно совпадать с origin браузера.
- **Данные пропадают:** убедитесь, что backend использует PostgreSQL, а не in-memory fallback.

## Production checklist

- [ ] Все секреты находятся только в Railway; `.env` не отслеживается Git.
- [ ] Старые/показанные где-либо credentials отозваны и заменены.
- [ ] PostgreSQL подключён, migration применена, `/health` показывает `database: true`.
- [ ] У каждого Twitch token правильный username и scopes.
- [ ] `GEMINI_LIVE_MODEL` доступна, reconnect/usage отслеживаются.
- [ ] `FRONTEND_URL` и `VITE_API_URL` указывают друг на друга корректно.
- [ ] Вход по HttpOnly-сессии и Socket.IO проверены с production-origin.
- [ ] Старые Railway volumes/backups проверены до удаления проекта.
- [ ] Учитываются актуальные ограничения и правила Twitch.
