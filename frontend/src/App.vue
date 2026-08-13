<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { io, Socket } from 'socket.io-client'

type Page = 'overview' | 'bots' | 'brain' | 'chat' | 'settings'
type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'DISABLED'

interface BrainStatus {
  state: ConnectionState
  mediaConnected: boolean
  geminiConnected: boolean
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
  generatedResponses: number
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

const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '')
const activePage = ref<Page>('overview')
const authToken = ref(sessionStorage.getItem('dashboardToken') || '')
const draftToken = ref('')
const authenticated = ref(Boolean(authToken.value))
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
  geminiReconnects: 0, geminiInputTokens: 0, geminiOutputTokens: 0,
  generatedResponses: 0, skippedResponses: 0,
})
const bots = ref<Bot[]>([])
const events = ref<StreamEvent[]>([])
const chat = ref<ChatMessage[]>([])
const personas = ref<Persona[]>([])
const settings = reactive({ channel: '', streamContext: '', visionFps: 1, eventThreshold: 0.45 })
let socket: Socket | undefined
let pollTimer: number | undefined

const pages: Array<{ id: Page; label: string; glyph: string }> = [
  { id: 'overview', label: 'Overview', glyph: '◫' },
  { id: 'bots', label: 'Bots', glyph: '◎' },
  { id: 'brain', label: 'Stream Brain', glyph: '◇' },
  { id: 'chat', label: 'Chat', glyph: '≡' },
  { id: 'settings', label: 'Settings', glyph: '⚙' },
]

const timeline = computed(() => [
  ...events.value.map((event) => ({
    id: `event-${event.id}`, timestamp: event.timestamp, kind: 'event' as const,
    title: event.summary, meta: `${event.type} · importance ${event.importance.toFixed(2)}`,
    tone: event.importance >= .8 ? 'strong' : event.importance >= .55 ? 'medium' : 'quiet',
  })),
  ...chat.value.map((message) => ({
    id: `chat-${message.id}`, timestamp: message.timestamp, kind: message.kind,
    title: `${message.displayName}: ${message.message}`, meta: message.kind === 'bot' ? 'bot reaction' : 'Twitch chat',
    tone: message.kind === 'bot' ? 'bot' : 'quiet',
  })),
].sort((a, b) => b.timestamp - a.timestamp).slice(0, 80))

const healthItems = computed(() => [
  { label: 'Backend', ok: backendOnline.value, detail: backendOnline.value ? 'API reachable' : 'Unavailable' },
  { label: 'Twitch chat', ok: overview.twitchConnected, detail: `${overview.activeBots}/${overview.totalBots} bots online` },
  { label: 'Media pipeline', ok: overview.streamBrain.mediaConnected, detail: overview.streamBrain.mediaConnected ? 'Audio + sampled video' : overview.streamBrain.state },
  { label: 'Gemini Live', ok: overview.streamBrain.geminiConnected, detail: overview.streamBrain.geminiConnected ? 'Live session connected' : overview.streamBrain.lastError || 'Disconnected' },
])

function requestHeaders(extra?: HeadersInit): Headers {
  const value = new Headers(extra)
  value.set('Authorization', `Bearer ${authToken.value}`)
  value.set('Content-Type', 'application/json')
  return value
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...options, headers: requestHeaders(options.headers) })
  if (response.status === 401 || response.status === 503) {
    logout()
    throw new Error(response.status === 503 ? 'На backend не настроен DASHBOARD_TOKEN' : 'Неверный dashboard token')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string }
    throw new Error(body.error || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

async function loadDashboard(): Promise<void> {
  if (!authToken.value) return
  loading.value = true
  try {
    const [overviewData, botData, eventData, chatData, usageData, settingsData, personaData] = await Promise.all([
      api<Overview>('/api/overview'), api<Bot[]>('/api/bots'), api<StreamEvent[]>('/api/events?limit=100'),
      api<ChatMessage[]>('/api/chat'), api<Usage>('/api/usage'), api<Record<string, unknown>>('/api/settings'),
      api<Persona[]>('/api/personas'),
    ])
    Object.assign(overview, overviewData)
    Object.assign(usage, usageData)
    bots.value = botData
    events.value = eventData
    chat.value = chatData
    personas.value = personaData
    settings.channel = String(settingsData.channel || '')
    settings.streamContext = String(settingsData.streamContext || '')
    settings.visionFps = Number(settingsData.visionFps || 1)
    settings.eventThreshold = Number(settingsData.eventThreshold || .45)
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
  socket = io(API_URL, { auth: { token: authToken.value }, transports: ['websocket', 'polling'] })
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
}

function login(): void {
  if (!draftToken.value.trim()) return
  authToken.value = draftToken.value.trim()
  sessionStorage.setItem('dashboardToken', authToken.value)
  authenticated.value = true
  draftToken.value = ''
  void loadDashboard()
}

function logout(): void {
  sessionStorage.removeItem('dashboardToken')
  authToken.value = ''
  authenticated.value = false
  realtimeOnline.value = false
  socket?.disconnect()
}

async function toggleBot(bot: Bot): Promise<void> {
  try {
    await api(`/api/bots/${encodeURIComponent(bot.username)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !bot.enabled }) })
    saveMessage.value = `${bot.username}: ${!bot.enabled ? 'enabled' : 'disabled'}`
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
}

async function saveSettings(): Promise<void> {
  saveMessage.value = ''
  try {
    const result = await api<{ restartRequired: string[] }>('/api/settings', { method: 'PATCH', body: JSON.stringify(settings) })
    saveMessage.value = result.restartRequired.length
      ? `Сохранено. Перезапустите backend для: ${result.restartRequired.join(', ')}`
      : 'Настройки применены'
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
}

async function savePersona(persona: Persona): Promise<void> {
  try {
    await api(`/api/personas/${encodeURIComponent(persona.id)}`, { method: 'PUT', body: JSON.stringify(persona) })
    saveMessage.value = `Persona «${persona.name}» сохранена`
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
}

function formatTime(timestamp?: number): string {
  return timestamp ? new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp) : '—'
}
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}h ${minutes}m`
}
function stateClass(state: ConnectionState): string { return state.toLowerCase() }

onMounted(() => {
  if (authenticated.value) void loadDashboard()
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
  <div v-if="!authenticated" class="auth-shell">
    <form class="auth-card" @submit.prevent="login">
      <div class="brand-mark">TV</div>
      <p class="eyebrow">TWITCH AI VIEWERS</p>
      <h1>Operations dashboard</h1>
      <p class="muted">Введите <code>DASHBOARD_TOKEN</code>. Он хранится только в sessionStorage этой вкладки.</p>
      <label>
        Dashboard token
        <input v-model="draftToken" type="password" autocomplete="current-password" autofocus placeholder="••••••••••••••••" />
      </label>
      <button class="primary wide" type="submit">Connect securely</button>
      <p v-if="errorMessage" class="notice error">{{ errorMessage }}</p>
    </form>
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark small">TV</span><span>Twitch AI<br><b>Viewers</b></span></div>
      <nav aria-label="Dashboard sections">
        <button v-for="page in pages" :key="page.id" :class="{ active: activePage === page.id }" @click="activePage = page.id">
          <span class="nav-glyph">{{ page.glyph }}</span><span>{{ page.label }}</span>
        </button>
      </nav>
      <div class="sidebar-foot">
        <span :class="['connection-dot', realtimeOnline ? 'ok' : '']"></span>
        <span>{{ realtimeOnline ? 'Realtime connected' : 'Realtime offline' }}</span>
        <button class="text-button" @click="logout">Log out</button>
      </div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ overview.category || 'CATEGORY UNKNOWN' }}</p>
          <h2>{{ overview.channel || 'Channel not configured' }}</h2>
        </div>
        <div class="topbar-actions">
          <span :class="['live-pill', overview.isLive ? 'live' : '']"><i></i>{{ overview.isLive ? 'LIVE' : 'OFFLINE' }}</span>
          <button class="icon-button" title="Refresh" :disabled="loading" @click="loadDashboard">↻</button>
        </div>
      </header>

      <main>
        <p v-if="errorMessage" class="notice error">{{ errorMessage }}</p>
        <p v-if="saveMessage" class="notice success">{{ saveMessage }}</p>

        <template v-if="activePage === 'overview'">
          <div class="page-heading"><div><p class="eyebrow">CONTROL ROOM</p><h1>Overview</h1></div><p class="muted">One stream, one multimodal brain, {{ overview.totalBots }} independent personas.</p></div>
          <section class="health-grid" aria-label="System health">
            <article v-for="item in healthItems" :key="item.label" class="health-card">
              <div><span :class="['status-light', item.ok ? 'ok' : '']"></span><span>{{ item.label }}</span></div>
              <strong>{{ item.ok ? 'Operational' : 'Degraded' }}</strong>
              <small>{{ item.detail }}</small>
            </article>
          </section>

          <section class="metric-strip">
            <div><span>Uptime</span><strong>{{ formatDuration(usage.uptimeSeconds) }}</strong></div>
            <div><span>Stream analyzed</span><strong>{{ usage.streamMinutes.toFixed(1) }} min</strong></div>
            <div><span>Responses sent</span><strong>{{ usage.generatedResponses }}</strong></div>
            <div><span>Natural skips</span><strong>{{ usage.skippedResponses }}</strong></div>
            <div><span>Gemini reconnects</span><strong>{{ usage.geminiReconnects }}</strong></div>
          </section>

          <div class="overview-grid">
            <section class="panel timeline-panel">
              <div class="panel-heading"><div><p class="eyebrow">CAUSE → EFFECT</p><h3>Unified timeline</h3></div><span class="subtle-chip">live</span></div>
              <div v-if="timeline.length" class="timeline">
                <article v-for="item in timeline" :key="item.id" :class="['timeline-item', item.tone]">
                  <time>{{ formatTime(item.timestamp) }}</time>
                  <span class="timeline-node"></span>
                  <div><p>{{ item.title }}</p><small>{{ item.meta }}</small></div>
                </article>
              </div>
              <div v-else class="empty-state">Events and chat will appear here when the stream starts.</div>
            </section>
            <section class="panel">
              <div class="panel-heading"><div><p class="eyebrow">ACCOUNTS</p><h3>Bot fleet</h3></div><button class="text-button" @click="activePage = 'bots'">View all</button></div>
              <div class="compact-bots">
                <article v-for="bot in bots.slice(0, 8)" :key="bot.username">
                  <span class="avatar">{{ bot.username.slice(0, 2).toUpperCase() }}</span>
                  <div><strong>{{ bot.username }}</strong><small>{{ bot.personaId }}</small></div>
                  <span :class="['state-badge', stateClass(bot.connectionState)]">{{ bot.connectionState }}</span>
                </article>
                <div v-if="!bots.length" class="empty-state">No BOTn credentials configured.</div>
              </div>
            </section>
          </div>
        </template>

        <template v-else-if="activePage === 'bots'">
          <div class="page-heading"><div><p class="eyebrow">OFFICIAL TWITCH CHAT</p><h1>Bot accounts</h1></div><p class="muted">Connection state is isolated per account. No viewer-count simulation.</p></div>
          <section class="panel table-panel">
            <div class="bot-table table-head"><span>Account</span><span>State</span><span>Persona</span><span>Messages</span><span>Last reaction</span><span>Enabled</span></div>
            <div v-for="bot in bots" :key="bot.username" class="bot-table table-row">
              <div class="account-cell"><span class="avatar">{{ bot.username.slice(0, 2).toUpperCase() }}</span><div><strong>{{ bot.username }}</strong><small>{{ bot.chatConnected ? 'chat joined' : bot.lastError || 'chat offline' }}</small></div></div>
              <span :class="['state-badge', stateClass(bot.connectionState)]">{{ bot.connectionState }}</span>
              <span>{{ bot.personaId }}</span><span>{{ bot.messagesSent }}</span><span>{{ formatTime(bot.lastReactionAt) }}</span>
              <button :class="['toggle', bot.enabled ? 'on' : '']" :aria-label="`Toggle ${bot.username}`" @click="toggleBot(bot)"><i></i></button>
            </div>
            <div v-if="!bots.length" class="empty-state">Configure BOT1_USERNAME and BOT1_OAUTH_TOKEN on Railway.</div>
          </section>
        </template>

        <template v-else-if="activePage === 'brain'">
          <div class="page-heading"><div><p class="eyebrow">MULTIMODAL UNDERSTANDING</p><h1>Stream Brain</h1></div><p class="muted">Normalized events, not raw transcripts.</p></div>
          <section class="brain-summary">
            <div><span>Live session</span><strong>{{ overview.streamBrain.state }}</strong></div>
            <div><span>Audio</span><strong>{{ usage.audioMinutes.toFixed(1) }} min</strong></div>
            <div><span>Video sampled</span><strong>{{ usage.videoMinutes.toFixed(1) }} min</strong></div>
            <div><span>Last event</span><strong>{{ formatTime(overview.streamBrain.lastEventAt) }}</strong></div>
          </section>
          <section class="event-grid">
            <article v-for="event in events" :key="event.id" class="event-card">
              <div class="event-top"><time>{{ formatTime(event.timestamp) }}</time><span>{{ event.category || overview.category || 'Unknown' }}</span><b>{{ event.type }}</b></div>
              <h3>{{ event.summary }}</h3><p v-if="event.speech">“{{ event.speech }}”</p>
              <div class="event-bars"><label>importance <meter min="0" max="1" :value="event.importance"></meter><b>{{ event.importance.toFixed(2) }}</b></label><label>confidence <meter min="0" max="1" :value="event.confidence"></meter><b>{{ event.confidence.toFixed(2) }}</b></label></div>
              <small>{{ event.source }}<template v-if="event.directMentions.length"> · @{{ event.directMentions.join(', @') }}</template></small>
            </article>
            <div v-if="!events.length" class="empty-state panel">No normalized events yet.</div>
          </section>
        </template>

        <template v-else-if="activePage === 'chat'">
          <div class="page-heading"><div><p class="eyebrow">REALTIME CONTEXT</p><h1>Twitch chat</h1></div><p class="muted">Viewer, bot and system messages are marked separately.</p></div>
          <section class="panel chat-feed">
            <article v-for="message in [...chat].reverse()" :key="message.id" :class="['chat-line', message.kind]">
              <time>{{ formatTime(message.timestamp) }}</time><span class="kind-chip">{{ message.kind }}</span><strong>{{ message.displayName }}</strong><p>{{ message.message }}</p>
            </article>
            <div v-if="!chat.length" class="empty-state">Chat messages will appear after a bot joins the channel.</div>
          </section>
        </template>

        <template v-else>
          <div class="page-heading"><div><p class="eyebrow">SAFE RUNTIME CONTROL</p><h1>Settings</h1></div><p class="muted">API keys and OAuth tokens never pass through this dashboard.</p></div>
          <section class="settings-grid">
            <form class="panel settings-form" @submit.prevent="saveSettings">
              <div class="panel-heading"><div><p class="eyebrow">STREAM</p><h3>Understanding</h3></div></div>
              <label>Channel<input v-model="settings.channel" autocomplete="off" /></label>
              <label>Stream context<textarea v-model="settings.streamContext" rows="4" placeholder="Стример играет рейтинговую Dota 2 с друзьями"></textarea></label>
              <label>Vision FPS <span>{{ settings.visionFps }}</span><input v-model.number="settings.visionFps" type="range" min="0.05" max="1" step="0.05" /></label>
              <label>Event threshold <span>{{ settings.eventThreshold.toFixed(2) }}</span><input v-model.number="settings.eventThreshold" type="range" min="0" max="1" step="0.05" /></label>
              <button class="primary" type="submit">Save settings</button>
              <small class="muted">Channel and Vision FPS changes are persisted but require a backend restart.</small>
            </form>
            <section class="panel security-panel">
              <div class="panel-heading"><div><p class="eyebrow">SECURITY</p><h3>Deployment boundary</h3></div></div>
              <ul><li><span>Gemini key</span><b>Railway only</b></li><li><span>Twitch OAuth</span><b>Railway only</b></li><li><span>Dashboard auth</span><b>Bearer + Socket auth</b></li><li><span>CORS</span><b>FRONTEND_URL allowlist</b></li></ul>
            </section>
          </section>

          <div class="section-heading"><div><p class="eyebrow">VOICE & BEHAVIOR</p><h2>Personas</h2></div></div>
          <section class="persona-grid">
            <form v-for="persona in personas" :key="persona.id" class="panel persona-card" @submit.prevent="savePersona(persona)">
              <div class="panel-heading"><div><span class="persona-id">{{ persona.id }}</span><h3>{{ persona.name }}</h3></div></div>
              <label>Description<textarea v-model="persona.description" rows="2"></textarea></label>
              <label>Style instructions<textarea v-model="persona.styleInstructions" rows="3"></textarea></label>
              <div class="two-fields"><label>Min words<input v-model.number="persona.verbosity.minWords" type="number" min="1" max="50" /></label><label>Max words<input v-model.number="persona.verbosity.maxWords" type="number" min="1" max="100" /></label></div>
              <label>Reaction probability <span>{{ persona.reactionProbability.toFixed(2) }}</span><input v-model.number="persona.reactionProbability" type="range" min="0" max="1" step="0.05" /></label>
              <label>Sarcasm <span>{{ persona.sarcasmLevel.toFixed(2) }}</span><input v-model.number="persona.sarcasmLevel" type="range" min="0" max="1" step="0.05" /></label>
              <button class="secondary" type="submit">Save persona</button>
            </form>
          </section>
        </template>
      </main>
    </div>
  </div>
</template>
