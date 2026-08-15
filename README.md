# Twitch AI Viewers

Система событийных AI-зрителей Twitch с двумя независимыми AI-слоями. Gemini 3.1 Flash Live только видит и слышит эфир, а stateful Gemini 3.7 Flash через Interactions API решает, стоит ли реагировать, выбирает 0..N персон и пишет финальные сообщения. Проект подключает аккаунты только к официальному Twitch IRC и не накручивает просмотры.

## Архитектура

```text
Twitch stream
      │
Streamlink / FFmpeg ─ PCM audio + sampled JPEG video
      │
      ▼
Gemini 3.1 Flash Live · PERCEPTION ONLY
      │  sees, hears, transcribes, detects direct mentions
      │  tool: emit_stream_event (zero calls while nothing meaningful happens)
      ▼
deterministic StreamEvent dedup / burst merge
      │
      ▼
Gemini 3.7 Flash · STATEFUL BRAIN · Interactions API
      │  bootstrap once per real stream: compact 30-persona snapshots + durable memory
      │  next turns: previous_interaction_id + small event/chat/delta payload
      │  one semantic interaction per event, never one call per bot
      ▼
BrainDecision { reactions: 0..N, memoryUpdates }
      │
PolicyGuard → zero-delay Scheduler → official Twitch chat

PostgreSQL = persistent truth between streams
Interactions state = working memory of the current stream only
Railway backend ← authenticated HTTPS + Socket.IO → Vercel dashboard
```

Live-модель не получает биографии, persona memory или длинную историю, не выбирает аккаунты и не пишет Twitch-сообщения. В production нет отдельных AI-вызовов для каждого бота, stateless `generateContent`, Flash Lite, Markov-генератора или правила «всегда ответить». Пустой `reactions: []` — нормальное решение промолчать. Backend после Brain только валидирует аккаунт, соединение, cooldown, дубликаты, длину и лимиты, затем отправляет принятые сообщения без искусственной паузы.

## Global Streamer Memory

`GlobalStreamerMemory` — отдельный долгоживущий слой знания канала, не связанный с конкретной persona и не заменяющий `ReactionMemory`. Он хранит лишь важные подтверждённые факты, планы, обещания, людей, поездки, результаты и повторяющиеся шутки. Raw transcript, каждое сообщение чата и обычные игровые моменты туда не попадают.

Для каждого фактического эфира создаётся `StreamSession` при состоянии медиапайплайна `STREAMING`, а при Twitch `OFFLINE` сессия закрывается. Heartbeat и advisory-lock PostgreSQL не дают Railway restart создать duplicate live session; устаревшая незакрытая сессия завершается как `interrupted`. При закрытии backend строит короткое детерминированное summary из связанных записей, без второй модели.

Semantic memory decision теперь делает Brain 3.7 в том же единственном решении события, даже если `reactions: []`. Backend валидирует предложения, отбрасывает секреты/контакты/точные адреса, объединяет повторы по type+summary+entities+tags, повышает confidence и обновляет `lastSeenAt`. Старый факт можно `resolved`, `expired` или `superseded` новым. Компактный snapshot важных записей загружается один раз в Brain bootstrap; последующие изменения идут короткими `MEMORY_ADDED` delta. Gemini Live долговременную память не получает.

## Глубокие постоянные личности

Каждый Twitch-аккаунт связан ровно с одной отдельной вымышленной личностью. Старые четыре archetype больше не циклируются между аккаунтами. Deep Persona Generator v3 содержит 30 редакторски проверенных deterministic blueprints для фактических production usernames: один и тот же `username + generationVersion` всегда даёт тот же канон без дополнительного LLM-вызова. Сгенерированный профиль нельзя переназначить другому username. Для неизвестного нового username backend создаёт честный пустой ручной профиль — он никогда не клонирует биографию другого человека — и держит аккаунт выключенным, пока оператор не заполнит связный канон с тем же Twitch nickname. PostgreSQL защищает связь уникальным индексом.

Canon хранится в `personas.config` как типизированная `schemaVersion=2`; логика генерации версионируется отдельно как `generationVersion=3`:

- identity: имя и preferred name, история ника, единственная стабильная `birthDate`, вычисляемый возраст, места, языки, работа и образование;
- biography: родственники, timeline и структурированные personal facts;
- persistent opinions и явные границы `expertise / familiar / weak / unknown`;
- character, человеческие несовершенства, disclosure boundaries, activity pattern и подробный speech fingerprint;
- отдельное отношение к стримеру и необязательные отношения между персонажами.

Canon меняется только оператором через защищённый dashboard API. Gemini и Twitch chat не имеют операции его записи. Ручные изменения отмечаются типизированными `manualOverrides` и переживают повторную генерацию. Перед подтверждённой regeneration предыдущий полный канон сохраняется в `persona_canon_backups`. Preview показывает полный канон «Сейчас → Новая личность» и причину изменения. Bulk-операция применяет только изменившиеся назначенные автопрофили без чувствительных ручных правок; остальные требуют отдельного сравнения и явного подтверждения. `PersonaMemory` хранится отдельно: слабые записи отбрасываются, средние получают TTL текущей сессии, а долгосрочно сохраняются только важные события и личные продолжения разговора. Короткий `viewer ↔ persona` thread живёт 10 минут и не смешивается с другими людьми или аккаунтами.

`PersonaContextBuilder` строит компактный `BrainPersonaSnapshot` один раз на stream bootstrap: характер, speech fingerprint, знания, интересы, activity pattern, отношение к стримеру и disclosure boundaries. Полные биографии не пересылаются на каждый event. Родственники, timeline, история ника, локация и работа извлекаются точечно лишь для прямо адресованной персоны и с учётом disclosure; private canon другой персоны в targeted payload не попадает. Никакой второй модели для retrieval нет.

Все 30 биографий полностью вымышлены и не выводятся из данных реальных владельцев аккаунтов. Воспроизводимый audit можно получить командой `npm run personas:audit`: он показывает mapping, географию, профессии, speech/behavior profiles, пять полных примеров, профиль `karlbekner`, распределение 26 мужчин / 4 женщины и weighted-similarity/coherence отчёт.

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
- Twitch: необязательный стартовый `TWITCH_CHANNEL`, Client ID/Secret, OAuth callback, ключ шифрования и legacy `BOTn_*`;
- Gemini: один `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL`, `GEMINI_BRAIN_MODEL`, thinking level, merge window и rollover threshold;
- медиа: `STREAM_CONTEXT`, `VISION_FPS`, `VISION_FRAME_WIDTH`;
- hard policy: общий rate limit и `MAX_REACTIONS_PER_EVENT`;
- обучение: окно сбора и количество retrieval-примеров;
- Global Streamer Memory: лимиты snapshot/retrieval и stale-session heartbeat;
- необязательный debug/fallback Whisper через Groq;
- PostgreSQL: `DATABASE_URL`, `DATABASE_SSL`.

Канал обычно вводится в русскоязычном dashboard и хранится в PostgreSQL, поэтому `TWITCH_CHANNEL` в Railway можно оставить пустым. Смена канала и `VISION_FPS` применяются без ручного рестарта.

## Авторизация dashboard

`DASHBOARD_TOKEN` вводится только при первом входе. Backend проверяет его и выдаёт подписанную HttpOnly Secure cookie на срок `DASHBOARD_SESSION_DAYS` (по умолчанию 30 дней). Исходный токен не сохраняется в `localStorage`, `sessionStorage` или JavaScript и не передаётся в Socket.IO payload. Повторный ввод нужен только после истечения cookie, очистки данных браузера или смены `DASHBOARD_TOKEN`.

Production CORS принимает только точные адреса из `FRONTEND_URL`; cookie и realtime-соединение используют тот же авторизованный контур. API-ключи Gemini и OAuth Twitch во frontend не попадают.

## Настройка Twitch OAuth

1. Создайте **Confidential** приложение в [Twitch Developer Console](https://dev.twitch.tv/console).
2. Добавьте точный callback: локально `http://localhost:3000/api/twitch/oauth/callback`, в production — `https://your-backend.up.railway.app/api/twitch/oauth/callback`.
3. Задайте `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` и тот же адрес в `TWITCH_OAUTH_REDIRECT_URI`.
4. Один раз сгенерируйте `TWITCH_TOKEN_ENCRYPTION_KEY`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

5. Откройте страницу «Боты» в dashboard, нажмите «Подключить или обновить аккаунт» и войдите в конкретный bot-аккаунт. Для каждого аккаунта это делается один раз.
6. Backend использует Authorization Code Grant только со scopes `chat:read` и `chat:edit`, проверяет реального владельца через Twitch `/validate`, шифрует access/refresh tokens AES-256-GCM и сохраняет их в PostgreSQL.

Access token не бывает бессрочным. Backend обновляет его через refresh token заранее перед истечением и реактивно при невалидном access token. Новый refresh token сохраняется атомарно. Повторный ручной вход понадобится только после отзыва приложения, смены пароля, потери ключа шифрования или другого отзыва Twitch. Один сломанный аккаунт не останавливает остальные.

`BOTn_USERNAME`/`BOTn_OAUTH_TOKEN` остаются только как legacy/bootstrap путь. Токены из Implicit Flow (например, сторонних генераторов) refresh token не имеют и автоматически продлеваться не могут.

Состояния: `DISCONNECTED`, `CONNECTING`, `CONNECTED`, `ERROR`, `DISABLED`. Backend применяет дополнительный локальный Twitch rate limiter.

## Настройка Gemini Perception + Brain

1. Создайте ключ в [Google AI Studio](https://aistudio.google.com/apikey).
2. Добавьте `GEMINI_API_KEY` только в Railway.
3. По умолчанию используются `GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview`, `GEMINI_BRAIN_MODEL=gemini-3.7-flash` и `GEMINI_BRAIN_THINKING_LEVEL=low`. Обе модели используют один ключ.

Аудио отправляется как mono 16-bit PCM 16 kHz по 40 мс. Видео — JPEG с настраиваемой частотой `0.05–1 FPS`. Live-сессия использует low media resolution, input transcription, low thinking, context-window compression, resumption handle, обработку `goAway` и bounded exponential backoff. Ответная аудиодорожка не воспроизводится; единственный Live tool — строгий `emit_stream_event`.

При подтверждённом `STREAMING` backend создаёт одну stateful Brain chain. Первый Interactions request загружает compact profiles всех назначенных Persona v3, важную Global Memory, категорию, контекст канала, недавние значимые события и чат. Каждый следующий request повторно задаёт обязательные interaction-scoped параметры, но передаёт только `previous_interaction_id`, один event, новый chat delta, 0–3 примера и targeted private context при прямом вопросе. Вызовы сериализованы. При invalid/expired previous id chain восстанавливается из PostgreSQL; при достижении configurable context threshold выполняется controlled rollover. Transient ошибки получают только ограниченный retry и никогда не возвращают генерацию сообщений в Live.

Платный lifecycle привязан только к фактическому состоянию медиапайплайна. При запуске приложения работает дешёвая проверка Twitch, но Gemini не подключается. Только переход в `STREAMING` атомарно открывает одну Live-сессию; `OFFLINE`, `CONNECTING`, `ERROR` и остановка приложения сразу закрывают WebSocket, отменяют reconnect/context timers и запрещают media/context/memory sends. Три ошибки протокола `1007` за две минуты открывают circuit breaker `FATAL_CONFIG_ERROR`; transient network error и `goAway` по-прежнему переподключаются только пока медиапоток активен.

Dashboard отдельно показывает PERCEPTION и BRAIN: длительность/медиа/tokens/cost Live; interactions/input/cached/output/thinking/latency/cost Brain; total cost и cost/hour; events/decisions/messages per hour. Сквозной trace с одним `eventId` показывает русский event, Brain interaction/latency/selected usernames, policy, scheduler и результат Twitch send. Произносимые usernames и безопасные `spokenAliases` превращаются в targeted direct mention; приветствие и визуальные события остаются полноценными event types, а естественная тишина сохраняется.

## PostgreSQL и миграции

`migrations/001_initial.sql` создаёт таблицы персон, метаданных ботов, ReactionMemory, истории сообщений, событий стрима, runtime settings и usage snapshots. `migrations/002_twitch_oauth.sql` добавляет зашифрованное хранилище обновляемых учётных данных Twitch; открытые токены в таблицу не записываются. `migrations/003_twitch_oauth_credential_version.sql` добавляет версию записи, чтобы устаревший экземпляр Railway не мог затереть результат успешного обновления токена.

Новая `migrations/004_deep_personas.sql`:

- создаёт `persona_memories`, `persona_conversation_messages` и `persona_relationships` с индексами по persona/time/importance/tags;
- чинит старые dangling persona references;
- разделяет повторные назначения старых archetype и вводит one-to-one индекс;
- добавляет `bot_accounts.persona_id → personas.id` с `ON DELETE RESTRICT`.

`migrations/005_deep_persona_generation_v3.sql` добавляет append-only резервные копии канона перед automatic/operator regeneration. `schemaVersion` при этом остаётся 2, а версия deterministic generator хранится внутри канона отдельно.

`migrations/006_global_streamer_memory.sql` добавляет `stream_sessions` и `streamer_memories`: статус, traceability source session/event, tags/entities, expiry, confirmation count и indexes по channel/type/status/importance/date/source. Существующие `stream_events` остаются raw/normalized историей и не заменяются этой памятью.

Старый JSON persona автоматически проходит безопасный runtime upgrade в schema v2. Не назначенные аккаунтам и явно ручные профили не получают придуманную биографию. Назначенные старые autogenerated archetypes распознаются по legacy-маркерам: backend сохраняет полный канон в backup и ставит флаг обязательного ручного сравнения, но сам профиль не переписывает. Оператор сравнивает «Сейчас → Новая личность» и явно применяет индивидуальную или массовую regeneration. После подтверждения v3 любые последующие операторские изменения записываются как `manualOverrides` и накладываются поверх следующих версий генератора.

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
3. Укажите точный Vercel origin в `FRONTEND_URL`, а публичный backend callback — в `TWITCH_OAUTH_REDIRECT_URI` и Twitch Developer Console.
4. Создайте стабильный `TWITCH_TOKEN_ENCRYPTION_KEY` и не меняйте его между deploy/restart.
5. `nixpacks.toml` ставит Node 20, FFmpeg и Streamlink; Railway запускает `node dist/main.js` как long-running process.
6. Healthcheck: `GET /health`. Ответ не содержит секретов.

## Vercel: dashboard

Root Directory: `frontend/`, Framework: Vite, Output: `dist`. Единственная production-переменная frontend:

```env
VITE_API_URL=https://your-backend.up.railway.app
```

Dashboard раздельно показывает backend/Twitch, Gemini Live Perception и Gemini 3.7 Brain, аккаунты и OAuth, события, чат, решения и exact usage metadata. Канал вводится в панели. Раздел «Мозг стрима» показывает funnel Event → Brain decision → silence/reactions → sent, cache tokens, стоимость обоих слоёв и русский event→message trace. «Память стримера» показывает persistent PostgreSQL truth, поиск, filters, status, source session, confirmation/expiry, edit/delete/resolve/obsolete и безопасный retrieval preview.

Русский редактор личностей содержит разделы «Основное», «Характер», «Семья», «Биография», «Интересы», «Мнения», «Речь», «Twitch», «Память» и «Качество». Отдельно показаны детерминированные эвристики заполненности, уникальности и связности, ближайшая похожая persona и общий cohort audit. Доступны ручное создание, проверенная генерация из ника, дублирование, CRUD, индивидуальный preview/confirmation и массовая проверка/пересоздание только autogenerated profiles. Кнопка OAuth только начинает защищённый переход; Client Secret и полученные токены никогда не проходят через Vercel frontend. Постоянные Twitch/Gemini/FFmpeg соединения на Vercel не создаются.

## Проверка

```powershell
npm run verify
```

Команда один раз выполняет lint, backend/frontend/test typecheck, unit/API tests и обе production-сборки. Реальный Twitch/Gemini поток требует валидных credentials и активного канала; тесты внешние сервисы не вызывают.

## Диагностика

- **Perception выключена:** проверьте `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL` и реальный медиапоток; offline является нормой.
- **Brain ERROR:** проверьте `GEMINI_BRAIN_MODEL`, quota и русский текст причины в dashboard; реакция пропускается, Live не становится генератором.
- **Медиапоток offline/error:** проверьте Streamlink, FFmpeg и активность канала.
- **Bot ERROR:** проверьте владельца токена и scopes `chat:read`/`chat:edit`.
- **OAuth redirect mismatch:** адрес в Twitch Developer Console должен посимвольно совпадать с `TWITCH_OAUTH_REDIRECT_URI`.
- **Refresh token недействителен:** переподключите только этот аккаунт кнопкой в dashboard; остальные продолжат работу.
- **Категория не обновляется:** нужны Twitch Client ID/Secret.
- **Dashboard снова просит токен:** cookie истекла/очищена, `DASHBOARD_TOKEN` сменился или браузер блокирует cross-site cookies.
- **CORS:** `FRONTEND_URL` должен точно совпадать с origin браузера.
- **Данные пропадают:** убедитесь, что backend использует PostgreSQL, а не in-memory fallback.
- **Память не записывается:** нужен активный `StreamSession`; Brain должен предложить важный факт с достаточной уверенностью, после чего backend ещё применяет validation/dedupe.

## Production checklist

- [ ] Все секреты находятся только в Railway; `.env` не отслеживается Git.
- [ ] Старые/показанные где-либо credentials отозваны и заменены.
- [ ] PostgreSQL подключён, migration применена, `/health` показывает `database: true`.
- [ ] Применена `006_global_streamer_memory.sql`; в разделе «Память стримера» видна статистика для выбранного канала.
- [ ] У каждого Twitch-аккаунта отдельный `personaId`; в dashboard нет незаполненных shallow-личностей.
- [ ] `npm run personas:audit` показывает 30 уникальных persona/speech fingerprints и 0 coherence errors.
- [ ] У каждого Twitch token правильный username и scopes.
- [ ] OAuth callback совпадает в Twitch Console/Railway, а `TWITCH_TOKEN_ENCRYPTION_KEY` сохранён как стабильный secret.
- [ ] `GEMINI_LIVE_MODEL` и `GEMINI_BRAIN_MODEL` доступны; Live reconnect и Brain interaction/cache/latency usage отслеживаются раздельно.
- [ ] `FRONTEND_URL` и `VITE_API_URL` указывают друг на друга корректно.
- [ ] Вход по HttpOnly-сессии и Socket.IO проверены с production-origin.
- [ ] Старые Railway volumes/backups проверены до удаления проекта.
- [ ] Учитываются актуальные ограничения и правила Twitch.
