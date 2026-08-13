<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { io, Socket } from 'socket.io-client'

type Page = 'overview' | 'bots' | 'brain' | 'chat' | 'settings'
type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'DISABLED'

interface BrainStatus {
  state: ConnectionState
  mediaConnected: boolean
  geminiConnected: boolean
  model?: string
  sessionStartedAt?: number
  lastEventAt?: number
  lastError?: string
}
interface Overview {
  channel: string
  category: string
  isLive: boolean
  twitchConnected: boolean
  streamBrain: BrainStatus
  activeBots: number
  totalBots: number
  uptimeSeconds: number
}
interface Bot {
  username: string
  personaId: string
  enabled: boolean
  connectionState: ConnectionState
  chatConnected: boolean
  messagesSent: number
  lastMessage?: string
  lastReactionAt?: number
  lastError?: string
}
interface StreamEvent {
  id: string
  timestamp: number
  type: string
  summary: string
  speech?: string
  visualContext?: string
  gameContext?: string
  category?: string
  importance: number
  confidence: number
  source: 'gemini-live' | 'chat' | 'fallback-transcription'
  directMentions: string[]
}
interface ChatMessage {
  id: string
  timestamp: number
  username: string
  displayName: string
  message: string
  kind: 'viewer' | 'bot' | 'system'
}
interface Usage {
  uptimeSeconds: number
  streamMinutes: number
  audioMinutes: number
  videoMinutes: number
  geminiReconnects: number
  geminiInputTokens: number
  geminiOutputTokens: number
  geminiToolCalls: number
  preparedReactionContexts: number
  reactionBatches: number
  emptyReactionBatches: number
  guardRejections: number
  eventsDetected: number
  generatedResponses: number
  sentResponses: number
  skippedResponses: number
}
interface Persona {
  id: string
  name: string
  description: string
  styleInstructions: string
  verbosity: { minWords: number; maxWords: number }
  reactionProbability: number
  uppercaseProbability: number
  questionProbability: number
  emojiProbability: number
  slangLevel: number
  sarcasmLevel: number
  toxicityLimit: number
  interests: string[]
  temperature: number
  minimumIntervalMs: number
}
type ReactionRejectionReason =
  | 'duplicate_username' | 'unknown_candidate' | 'not_connected' | 'too_many_reactions'
  | 'empty_message' | 'control_value' | 'message_too_long' | 'account_cooldown'
  | 'account_busy' | 'global_rate_limit' | 'recent_duplicate' | 'invalid_item'
interface ReactionDecision {
  eventId: string
  timestamp: number
  selected: Array<{ username: string; message: string; delayMs: number }>
  rejected: Array<{ username: string; reason: ReactionRejectionReason }>
  candidateCount: number
  silentCandidateCount: number
}

const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '')
const activePage = ref<Page>('overview')
const draftToken = ref('')
const authenticated = ref(false)
const checkingSession = ref(true)
const backendOnline = ref(false)
const realtimeOnline = ref(false)
const loading = ref(false)
const errorMessage = ref('')
const saveMessage = ref('')
const overview = reactive<Overview>({
  channel: '', category: '', isLive: false, twitchConnected: false,
  streamBrain: { state: 'DISCONNECTED', mediaConnected: false, geminiConnected: false },
  activeBots: 0, totalBots: 0, uptimeSeconds: 0,
})
const usage = reactive<Usage>({
  uptimeSeconds: 0, streamMinutes: 0, audioMinutes: 0, videoMinutes: 0,
  geminiReconnects: 0, geminiInputTokens: 0, geminiOutputTokens: 0, geminiToolCalls: 0,
  preparedReactionContexts: 0, reactionBatches: 0, emptyReactionBatches: 0,
  guardRejections: 0, eventsDetected: 0, generatedResponses: 0, sentResponses: 0, skippedResponses: 0,
})
const bots = ref<Bot[]>([])
const events = ref<StreamEvent[]>([])
const chat = ref<ChatMessage[]>([])
const personas = ref<Persona[]>([])
const decisions = ref<ReactionDecision[]>([])
const settings = reactive({ channel: '', streamContext: '', visionFps: 1 })
let socket: Socket | undefined
let pollTimer: number | undefined

const pages: Array<{ id: Page; label: string; glyph: string }> = [
  { id: 'overview', label: 'Обзор', glyph: '◫' },
  { id: 'bots', label: 'Боты', glyph: '◎' },
  { id: 'brain', label: 'Мозг стрима', glyph: '◇' },
  { id: 'chat', label: 'Чат', glyph: '≡' },
  { id: 'settings', label: 'Настройки', glyph: '⚙' },
]

const timeline = computed(() => [
  ...events.value.map((event) => ({
    id: `event-${event.id}`, timestamp: event.timestamp,
    title: event.summary, meta: `${eventTypeLabel(event.type)} · важность ${event.importance.toFixed(2)}`,
    tone: event.importance >= .8 ? 'strong' : event.importance >= .55 ? 'medium' : 'quiet',
  })),
  ...chat.value.map((message) => ({
    id: `chat-${message.id}`, timestamp: message.timestamp,
    title: `${message.displayName}: ${message.message}`,
    meta: message.kind === 'bot' ? 'реакция бота' : 'чат Twitch',
    tone: message.kind === 'bot' ? 'bot' : 'quiet',
  })),
].sort((a, b) => b.timestamp - a.timestamp).slice(0, 80))

const healthItems = computed(() => [
  { label: 'Сервер', ok: backendOnline.value, detail: backendOnline.value ? 'API доступен' : 'Нет соединения' },
  { label: 'Чат Twitch', ok: overview.twitchConnected, detail: `${overview.activeBots} из ${overview.totalBots} ботов в чате` },
  { label: 'Медиапоток', ok: overview.streamBrain.mediaConnected, detail: overview.streamBrain.mediaConnected ? 'Аудио и выбранные видеокадры' : stateLabel(overview.streamBrain.state) },
  { label: 'Gemini Live', ok: overview.streamBrain.geminiConnected, detail: overview.streamBrain.geminiConnected ? 'Единая Live-сессия подключена' : overview.streamBrain.lastError || 'Отключено' },
])

function requestHeaders(extra?: HeadersInit, hasBody = false): Headers {
  const value = new Headers(extra)
  if (hasBody && !value.has('Content-Type')) value.set('Content-Type', 'application/json')
  return value
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: requestHeaders(options.headers, options.body !== undefined),
  })
  if (response.status === 401 || response.status === 503) {
    endLocalSession()
    throw new Error(response.status === 503 ? 'На сервере не настроена авторизация панели' : 'Сессия истекла или недействительна')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string }
    throw new Error(translateApiError(body.error || `HTTP ${response.status}`))
  }
  return response.json() as Promise<T>
}

async function checkSession(): Promise<void> {
  checkingSession.value = true
  try {
    const response = await fetch(`${API_URL}/api/auth/session`, { credentials: 'include' })
    authenticated.value = response.ok
    if (response.ok) await loadDashboard()
  } catch {
    authenticated.value = false
  } finally {
    checkingSession.value = false
  }
}

async function loadDashboard(): Promise<void> {
  if (!authenticated.value) return
  loading.value = true
  try {
    const [overviewData, botData, eventData, chatData, usageData, settingsData, personaData, decisionData] = await Promise.all([
      api<Overview>('/api/overview'), api<Bot[]>('/api/bots'), api<StreamEvent[]>('/api/events?limit=100'),
      api<ChatMessage[]>('/api/chat'), api<Usage>('/api/usage'), api<Record<string, unknown>>('/api/settings'),
      api<Persona[]>('/api/personas'), api<ReactionDecision[]>('/api/decisions'),
    ])
    Object.assign(overview, overviewData)
    Object.assign(usage, usageData)
    bots.value = botData
    events.value = eventData
    chat.value = chatData
    personas.value = personaData
    decisions.value = decisionData
    settings.channel = String(settingsData.channel || '')
    settings.streamContext = String(settingsData.streamContext || '')
    settings.visionFps = Number(settingsData.visionFps || 1)
    backendOnline.value = true
    errorMessage.value = ''
    connectRealtime()
  } catch (error) {
    backendOnline.value = false
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

function connectRealtime(): void {
  socket?.disconnect()
  socket = io(API_URL, { withCredentials: true, transports: ['websocket', 'polling'] })
  socket.on('connect', () => { realtimeOnline.value = true })
  socket.on('disconnect', () => { realtimeOnline.value = false })
  socket.on('connect_error', () => { realtimeOnline.value = false })
  socket.on('overview', (value: Overview) => Object.assign(overview, value))
  socket.on('brain', (value: BrainStatus) => { overview.streamBrain = value })
  socket.on('bots', (value: Bot[]) => { bots.value = value })
  socket.on('events:init', (value: StreamEvent[]) => { events.value = value })
  socket.on('event', (value: StreamEvent) => { events.value = [value, ...events.value.filter((item) => item.id !== value.id)].slice(0, 200) })
  socket.on('chat:init', (value: ChatMessage[]) => { chat.value = value })
  socket.on('chat', (value: ChatMessage) => { chat.value = [...chat.value.filter((item) => item.id !== value.id), value].slice(-300) })
  socket.on('decision', (value: ReactionDecision) => { decisions.value = [value, ...decisions.value].slice(0, 100) })
}

async function login(): Promise<void> {
  if (!draftToken.value.trim()) return
  loading.value = true
  errorMessage.value = ''
  try {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: draftToken.value.trim() }),
    })
    if (!response.ok) throw new Error(response.status === 503 ? 'На сервере не настроена авторизация панели' : 'Неверный токен')
    draftToken.value = ''
    authenticated.value = true
    await loadDashboard()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

async function logout(): Promise<void> {
  await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined)
  endLocalSession()
}

function endLocalSession(): void {
  authenticated.value = false
  realtimeOnline.value = false
  socket?.disconnect()
}

async function toggleBot(bot: Bot): Promise<void> {
  try {
    await api(`/api/bots/${encodeURIComponent(bot.username)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !bot.enabled }) })
    saveMessage.value = `${bot.username}: ${!bot.enabled ? 'включён' : 'выключен'}`
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
}

async function saveSettings(): Promise<void> {
  saveMessage.value = ''
  try {
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify(settings) })
    saveMessage.value = 'Настройки применены. Канал и медиапоток переключены без ручного рестарта.'
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
}

async function savePersona(persona: Persona): Promise<void> {
  try {
    await api(`/api/personas/${encodeURIComponent(persona.id)}`, { method: 'PUT', body: JSON.stringify(persona) })
    saveMessage.value = `Персона «${persona.name}» сохранена`
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
}

function formatTime(timestamp?: number): string {
  return timestamp ? new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp) : '—'
}
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours} ч ${minutes} мин`
}
function formatSessionDuration(startedAt?: number): string {
  return startedAt ? formatDuration(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))) : '—'
}
function stateClass(state: ConnectionState): string { return state.toLowerCase() }
function stateLabel(state: ConnectionState): string {
  return ({ DISCONNECTED: 'Отключено', CONNECTING: 'Подключение', CONNECTED: 'Подключено', ERROR: 'Ошибка', DISABLED: 'Выключено' })[state]
}
function kindLabel(kind: ChatMessage['kind']): string {
  return ({ viewer: 'зритель', bot: 'бот', system: 'система' })[kind]
}
function eventTypeLabel(type: string): string {
  return ({ speech: 'речь', gameplay: 'игровой момент', reaction: 'реакция', funny: 'смешной момент', fail: 'ошибка', win: 'победа', loss: 'поражение', surprise: 'неожиданность', conversation: 'разговор', irl: 'вне игры', other: 'другое' } as Record<string, string>)[type] || type
}
function sourceLabel(source: StreamEvent['source']): string {
  return ({ 'gemini-live': 'Gemini Live', chat: 'чат', 'fallback-transcription': 'резервная транскрипция' })[source]
}
function rejectionLabel(reason: ReactionRejectionReason): string {
  const labels: Record<ReactionRejectionReason, string> = {
    duplicate_username: 'аккаунт указан дважды', unknown_candidate: 'неизвестный аккаунт',
    not_connected: 'нет соединения', too_many_reactions: 'слишком много реакций',
    empty_message: 'пустое сообщение', control_value: 'служебное значение',
    message_too_long: 'сообщение слишком длинное', account_cooldown: 'пауза аккаунта',
    account_busy: 'аккаунт уже занят', global_rate_limit: 'общий лимит сообщений',
    recent_duplicate: 'похожее сообщение уже было', invalid_item: 'некорректная реакция',
  }
  return labels[reason]
}
function translateApiError(message: string): string {
  const labels: Record<string, string> = {
    'Dashboard authentication is not configured': 'Авторизация панели не настроена на сервере',
    Unauthorized: 'Сессия истекла или недействительна',
    'Bot not found': 'Бот не найден',
    'Invalid request': 'Некорректный запрос',
    'Internal server error': 'Внутренняя ошибка сервера',
  }
  return labels[message] || message
}

onMounted(() => {
  void checkSession()
  pollTimer = window.setInterval(() => {
    if (!authenticated.value) return
    void Promise.all([
      api<Overview>('/api/overview').then((value) => Object.assign(overview, value)),
      api<Usage>('/api/usage').then((value) => Object.assign(usage, value)),
    ]).then(() => { backendOnline.value = true }).catch(() => { backendOnline.value = false })
  }, 15_000)
})
onBeforeUnmount(() => {
  socket?.disconnect()
  if (pollTimer) window.clearInterval(pollTimer)
})
</script>

<template>
  <div v-if="checkingSession" class="auth-shell"><div class="auth-card"><div class="brand-mark">TV</div><h1>Проверяем сессию…</h1></div></div>
  <div v-else-if="!authenticated" class="auth-shell">
    <form class="auth-card" @submit.prevent="login">
      <div class="brand-mark">TV</div>
      <p class="eyebrow">TWITCH AI VIEWERS</p>
      <h1>Панель управления</h1>
      <p class="muted">Введите токен один раз. Сервер выдаст защищённую HttpOnly-сессию на 30 дней; сам токен не сохраняется в браузере.</p>
      <label>Токен панели<input v-model="draftToken" type="password" autocomplete="current-password" autofocus placeholder="••••••••••••••••" /></label>
      <button class="primary wide" type="submit" :disabled="loading">Войти безопасно</button>
      <p v-if="errorMessage" class="notice error">{{ errorMessage }}</p>
    </form>
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark small">TV</span><span>Twitch AI<br><b>Viewers</b></span></div>
      <nav aria-label="Разделы панели">
        <button v-for="page in pages" :key="page.id" :class="{ active: activePage === page.id }" @click="activePage = page.id">
          <span class="nav-glyph">{{ page.glyph }}</span><span>{{ page.label }}</span>
        </button>
      </nav>
      <div class="sidebar-foot">
        <span :class="['connection-dot', realtimeOnline ? 'ok' : '']"></span>
        <span>{{ realtimeOnline ? 'Обновления подключены' : 'Обновления отключены' }}</span>
        <button class="text-button" @click="logout">Выйти</button>
      </div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div><p class="eyebrow">{{ overview.category || 'КАТЕГОРИЯ НЕИЗВЕСТНА' }}</p><h2>{{ overview.channel || 'Канал не настроен' }}</h2></div>
        <div class="topbar-actions">
          <span :class="['live-pill', overview.isLive ? 'live' : '']"><i></i>{{ overview.isLive ? 'В ЭФИРЕ' : 'НЕ В ЭФИРЕ' }}</span>
          <button class="icon-button" title="Обновить" :disabled="loading" @click="loadDashboard">↻</button>
        </div>
      </header>

      <main>
        <p v-if="errorMessage" class="notice error">{{ errorMessage }}</p>
        <p v-if="saveMessage" class="notice success">{{ saveMessage }}</p>

        <template v-if="activePage === 'overview'">
          <div class="page-heading"><div><p class="eyebrow">ЦЕНТР УПРАВЛЕНИЯ</p><h1>Обзор</h1></div><p class="muted">Один стрим, один мультимодальный мозг, {{ overview.totalBots }} самостоятельных персон.</p></div>
          <section class="health-grid" aria-label="Состояние системы">
            <article v-for="item in healthItems" :key="item.label" class="health-card">
              <div><span :class="['status-light', item.ok ? 'ok' : '']"></span><span>{{ item.label }}</span></div>
              <strong>{{ item.ok ? 'Работает' : 'Требует внимания' }}</strong><small>{{ item.detail }}</small>
            </article>
          </section>
          <section class="metric-strip">
            <div><span>Время работы</span><strong>{{ formatDuration(usage.uptimeSeconds) }}</strong></div>
            <div><span>Стрим проанализирован</span><strong>{{ usage.streamMinutes.toFixed(1) }} мин</strong></div>
            <div><span>Сообщений отправлено</span><strong>{{ usage.sentResponses }}</strong></div>
            <div><span>Решений промолчать</span><strong>{{ usage.emptyReactionBatches }}</strong></div>
            <div><span>Переподключений Gemini</span><strong>{{ usage.geminiReconnects }}</strong></div>
          </section>
          <div class="overview-grid">
            <section class="panel timeline-panel">
              <div class="panel-heading"><div><p class="eyebrow">ПРИЧИНА → РЕАКЦИЯ</p><h3>Общая лента</h3></div><span class="subtle-chip">сейчас</span></div>
              <div v-if="timeline.length" class="timeline"><article v-for="item in timeline" :key="item.id" :class="['timeline-item', item.tone]"><time>{{ formatTime(item.timestamp) }}</time><span class="timeline-node"></span><div><p>{{ item.title }}</p><small>{{ item.meta }}</small></div></article></div>
              <div v-else class="empty-state">События и чат появятся после начала стрима.</div>
            </section>
            <section class="panel">
              <div class="panel-heading"><div><p class="eyebrow">АККАУНТЫ</p><h3>Боты</h3></div><button class="text-button" @click="activePage = 'bots'">Показать все</button></div>
              <div class="compact-bots">
                <article v-for="bot in bots.slice(0, 8)" :key="bot.username"><span class="avatar">{{ bot.username.slice(0, 2).toUpperCase() }}</span><div><strong>{{ bot.username }}</strong><small>{{ bot.personaId }}</small></div><span :class="['state-badge', stateClass(bot.connectionState)]">{{ stateLabel(bot.connectionState) }}</span></article>
                <div v-if="!bots.length" class="empty-state">В Railway пока не настроены аккаунты BOTn.</div>
              </div>
            </section>
          </div>
        </template>

        <template v-else-if="activePage === 'bots'">
          <div class="page-heading"><div><p class="eyebrow">ОФИЦИАЛЬНЫЙ ЧАТ TWITCH</p><h1>Аккаунты ботов</h1></div><p class="muted">Сбой одного аккаунта не останавливает остальные. Накрутка просмотров не используется.</p></div>
          <section class="panel table-panel">
            <div class="bot-table table-head"><span>Аккаунт</span><span>Состояние</span><span>Персона</span><span>Сообщения</span><span>Последняя реакция</span><span>Включён</span></div>
            <div v-for="bot in bots" :key="bot.username" class="bot-table table-row">
              <div class="account-cell"><span class="avatar">{{ bot.username.slice(0, 2).toUpperCase() }}</span><div><strong>{{ bot.username }}</strong><small>{{ bot.chatConnected ? 'вошёл в чат' : bot.lastError || 'чат отключён' }}</small></div></div>
              <span :class="['state-badge', stateClass(bot.connectionState)]">{{ stateLabel(bot.connectionState) }}</span><span>{{ bot.personaId }}</span><span>{{ bot.messagesSent }}</span><span>{{ formatTime(bot.lastReactionAt) }}</span>
              <button :class="['toggle', bot.enabled ? 'on' : '']" :aria-label="`Переключить ${bot.username}`" @click="toggleBot(bot)"><i></i></button>
            </div>
            <div v-if="!bots.length" class="empty-state">Перенесите BOT1_USERNAME / BOT1_OAUTH и следующие аккаунты в переменные Railway.</div>
          </section>
        </template>

        <template v-else-if="activePage === 'brain'">
          <div class="page-heading"><div><p class="eyebrow">МУЛЬТИМОДАЛЬНОЕ ПОНИМАНИЕ</p><h1>Мозг стрима</h1></div><p class="muted">Одна Gemini Live-сессия понимает медиа, выбирает персон и пишет все финальные реакции.</p></div>
          <section class="brain-summary">
            <div><span>Сессия Gemini Live</span><strong>{{ stateLabel(overview.streamBrain.state) }}</strong></div>
            <div><span>Модель</span><strong>{{ overview.streamBrain.model || '—' }}</strong></div>
            <div><span>Аудио</span><strong>{{ usage.audioMinutes.toFixed(1) }} мин</strong></div>
            <div><span>Выбранное видео</span><strong>{{ usage.videoMinutes.toFixed(1) }} мин</strong></div>
            <div><span>Длительность сессии</span><strong>{{ formatSessionDuration(overview.streamBrain.sessionStartedAt) }}</strong></div>
            <div><span>Последнее событие</span><strong>{{ formatTime(overview.streamBrain.lastEventAt) }}</strong></div>
          </section>
          <section class="panel metric-strip"><div><span>Медиа</span><strong>→</strong></div><div><span>Gemini Live</span><strong>→</strong></div><div><span>Контекст персон</span><strong>→</strong></div><div><span>Единый пакет</span><strong>→</strong></div><div><span>Чат Twitch</span><strong>✓</strong></div></section>
          <section class="metric-strip">
            <div><span>События</span><strong>{{ usage.eventsDetected }}</strong></div><div><span>Контексты / инструменты</span><strong>{{ usage.preparedReactionContexts }} / {{ usage.geminiToolCalls }}</strong></div><div><span>Создано / отправлено</span><strong>{{ usage.generatedResponses }} / {{ usage.sentResponses }}</strong></div><div><span>Отклонено фильтром</span><strong>{{ usage.guardRejections }}</strong></div><div><span>Токены вход / выход</span><strong>{{ usage.geminiInputTokens }} / {{ usage.geminiOutputTokens }}</strong></div>
          </section>
          <div class="section-heading"><div><p class="eyebrow">ПОСЛЕДНИЕ РЕШЕНИЯ AI</p><h2>Кто решил реагировать</h2></div></div>
          <section class="event-grid">
            <article v-for="decision in decisions" :key="`${decision.eventId}-${decision.timestamp}`" class="event-card"><div class="event-top"><time>{{ formatTime(decision.timestamp) }}</time><b>{{ decision.selected.length ? `${decision.selected.length} реакц.` : 'тишина' }}</b></div><div v-if="decision.selected.length"><p v-for="reaction in decision.selected" :key="reaction.username"><strong>@{{ reaction.username }}</strong> — {{ reaction.message }} <small>через {{ (reaction.delayMs / 1000).toFixed(1) }} с</small></p></div><p v-else>Gemini решила, что естественнее промолчать.</p><small>Кандидатов: {{ decision.candidateCount }} · промолчали: {{ decision.silentCandidateCount }}</small><small v-if="decision.rejected.length">Фильтр отклонил: {{ decision.rejected.map((item) => `${item.username}: ${rejectionLabel(item.reason)}`).join(', ') }}</small></article>
            <div v-if="!decisions.length" class="empty-state panel">Решений пока нет.</div>
          </section>
          <div class="section-heading"><div><p class="eyebrow">СОБЫТИЯ</p><h2>Понятые моменты стрима</h2></div></div>
          <section class="event-grid">
            <article v-for="event in events" :key="event.id" class="event-card"><div class="event-top"><time>{{ formatTime(event.timestamp) }}</time><span>{{ event.category || overview.category || 'Категория неизвестна' }}</span><b>{{ eventTypeLabel(event.type) }}</b></div><h3>{{ event.summary }}</h3><p v-if="event.speech">«{{ event.speech }}»</p><div class="event-bars"><label>важность <meter min="0" max="1" :value="event.importance"></meter><b>{{ event.importance.toFixed(2) }}</b></label><label>уверенность <meter min="0" max="1" :value="event.confidence"></meter><b>{{ event.confidence.toFixed(2) }}</b></label></div><small>{{ sourceLabel(event.source) }}<template v-if="event.directMentions.length"> · @{{ event.directMentions.join(', @') }}</template></small></article>
            <div v-if="!events.length" class="empty-state panel">Нормализованных событий пока нет.</div>
          </section>
        </template>

        <template v-else-if="activePage === 'chat'">
          <div class="page-heading"><div><p class="eyebrow">КОНТЕКСТ В РЕАЛЬНОМ ВРЕМЕНИ</p><h1>Чат Twitch</h1></div><p class="muted">Сообщения зрителей, ботов и системы отмечены отдельно.</p></div>
          <section class="panel chat-feed"><article v-for="message in [...chat].reverse()" :key="message.id" :class="['chat-line', message.kind]"><time>{{ formatTime(message.timestamp) }}</time><span class="kind-chip">{{ kindLabel(message.kind) }}</span><strong>{{ message.displayName }}</strong><p>{{ message.message }}</p></article><div v-if="!chat.length" class="empty-state">Сообщения появятся, когда хотя бы один бот войдёт в канал.</div></section>
        </template>

        <template v-else>
          <div class="page-heading"><div><p class="eyebrow">БЕЗОПАСНОЕ УПРАВЛЕНИЕ</p><h1>Настройки</h1></div><p class="muted">API-ключи и OAuth-токены никогда не передаются в панель.</p></div>
          <section class="settings-grid">
            <form class="panel settings-form" @submit.prevent="saveSettings">
              <div class="panel-heading"><div><p class="eyebrow">СТРИМ</p><h3>Источник и контекст</h3></div></div>
              <label>Канал Twitch<input v-model="settings.channel" autocomplete="off" placeholder="gudini_younger" /></label>
              <label>Контекст стрима<textarea v-model="settings.streamContext" rows="4" placeholder="Стример играет рейтинговую Dota 2 с друзьями"></textarea></label>
              <label>Частота видеокадров <span>{{ settings.visionFps }} FPS</span><input v-model.number="settings.visionFps" type="range" min="0.05" max="1" step="0.05" /></label>
              <button class="primary" type="submit">Сохранить и применить</button>
              <small class="muted">Канал хранится в PostgreSQL и переключается сразу. В Railway переменную TWITCH_CHANNEL можно оставить пустой.</small>
            </form>
            <section class="panel security-panel"><div class="panel-heading"><div><p class="eyebrow">БЕЗОПАСНОСТЬ</p><h3>Границы развертывания</h3></div></div><ul><li><span>Ключ Gemini</span><b>Только Railway</b></li><li><span>OAuth Twitch</span><b>Только Railway</b></li><li><span>Авторизация панели</span><b>HttpOnly-сессия</b></li><li><span>CORS</span><b>Список FRONTEND_URL</b></li></ul></section>
          </section>
          <div class="section-heading"><div><p class="eyebrow">ГОЛОС И ПОВЕДЕНИЕ</p><h2>Персоны</h2></div></div>
          <section class="persona-grid">
            <form v-for="persona in personas" :key="persona.id" class="panel persona-card" @submit.prevent="savePersona(persona)"><div class="panel-heading"><div><span class="persona-id">{{ persona.id }}</span><h3>{{ persona.name }}</h3></div></div><label>Описание<textarea v-model="persona.description" rows="2"></textarea></label><label>Инструкции по стилю<textarea v-model="persona.styleInstructions" rows="3"></textarea></label><div class="two-fields"><label>Минимум слов<input v-model.number="persona.verbosity.minWords" type="number" min="1" max="50" /></label><label>Максимум слов<input v-model.number="persona.verbosity.maxWords" type="number" min="1" max="100" /></label></div><label>Склонность реагировать <span>{{ persona.reactionProbability.toFixed(2) }}</span><input v-model.number="persona.reactionProbability" type="range" min="0" max="1" step="0.05" /></label><label>Сарказм <span>{{ persona.sarcasmLevel.toFixed(2) }}</span><input v-model.number="persona.sarcasmLevel" type="range" min="0" max="1" step="0.05" /></label><button class="secondary" type="submit">Сохранить персону</button></form>
          </section>
        </template>
      </main>
    </div>
  </div>
</template>
