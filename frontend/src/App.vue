<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { io, Socket } from 'socket.io-client'

type Page = 'overview' | 'bots' | 'brain' | 'chat' | 'settings'
type PersonaTab = 'main' | 'character' | 'family' | 'biography' | 'interests' | 'opinions' | 'speech' | 'twitch' | 'memory'
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
interface TwitchOAuthAccount {
  username: string
  scopes: string[]
  expiresAt: number
  refreshable: boolean
  refreshState: 'HEALTHY' | 'ERROR' | 'RECONNECT_REQUIRED'
  lastRefreshAt?: number
  lastRefreshError?: string
}
interface TwitchOAuthStatus {
  configured: boolean
  callbackUrl?: string
  accounts: TwitchOAuthAccount[]
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
  schemaVersion: 2
  fictionalPersona: true
  id: string
  name: string
  description: string
  identity: {
    firstName: string; nickname?: string; birthDate?: string
    birthplace?: { country: string; city: string }; grewUpIn?: { country: string; city: string }
    currentLocation?: { country: string; city: string }
    languages: Array<{ language: string; level: string }>
    occupation?: string; education?: string; relationshipStatus?: string
  }
  family: Array<{ id: string; relation: string; name: string; birthDate?: string; occupation?: string; city?: string; relationshipDescription?: string; facts: string[] }>
  timeline: Array<{ id: string; year?: number; title: string; description: string; emotionalWeight: number; tags: string[] }>
  facts: Array<{ id: string; category: string; fact: string; importance: number; privateByDefault?: boolean; tags: string[] }>
  opinions: Array<{ id: string; topic: string; stance: string; strength: number; reasoning?: string; immutable: boolean; tags: string[] }>
  knowledge: { expertise: string[]; familiarTopics: string[]; weakTopics: string[]; unknownTopics: string[] }
  character: { summary: string; traits: string[]; strengths: string[]; flaws: string[]; humor: string; conflictStyle: string }
  interests: { games: string[]; music: string[]; food: string[]; other: string[] }
  speech: {
    averageMessageWords: number; vocabulary: string[]; favoriteExpressions: string[]; rareExpressions: string[]
    avoidedExpressions: string[]; fillerWords: string[]; typoStyle: string[]; punctuationStyle: string
    capitalizationStyle: string; laughStyles: string[]; emojiPreferences: string[]; profanityLevel: number; messageExamples: string[]
  }
  behavior: {
    styleInstructions: string; verbosity: { minWords: number; maxWords: number }; reactionProbability: number
    uppercaseProbability: number; questionProbability: number; emojiProbability: number; slangLevel: number
    sarcasmLevel: number; toxicityLimit: number; temperature: number; minimumIntervalMs: number
    imperfections: { typingMistakes: string[]; hesitations: string[]; emotionalTriggers: string[]; blindSpots: string[] }
    activity: { chatFrequency: 'very-low' | 'low' | 'medium' | 'high'; directReplyLikelihood: number; eventSelectivity: number; preferredEventTypes: string[]; averageDelayMs: { min: number; max: number } }
  }
  streamerRelationship: { firstSeen?: string; familiarity: number; supportiveness: number; teasingLevel: number; favoriteStreamTypes: string[]; recurringReferences: string[]; rememberedStreamerMoments: string[] }
  relationships: Array<{ targetPersonaId: string; familiarity: number; sentiment: number; notes: string[] }>
}
interface PersonaMemoryItem {
  id: string; personaId: string; createdAt: number; type: string; summary: string; importance: number; tags: string[]
}
interface PersonaSummary {
  id: string; name: string; firstName: string; age?: number; city?: string; occupation?: string; completeness: number
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
const oauthConnecting = ref(false)
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
const personaSummaries = ref<PersonaSummary[]>([])
const selectedPersonaId = ref('')
const personaTab = ref<PersonaTab>('main')
const personaMemories = ref<PersonaMemoryItem[]>([])
const personaContextQuery = ref('как тебя зовут и где ты вырос?')
const personaContextPreview = ref<Record<string, unknown> | null>(null)
const personaBusy = ref(false)
const decisions = ref<ReactionDecision[]>([])
const twitchOAuth = reactive<TwitchOAuthStatus>({ configured: false, accounts: [] })
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

const personaTabs: Array<{ id: PersonaTab; label: string }> = [
  { id: 'main', label: 'Основное' }, { id: 'character', label: 'Характер' }, { id: 'family', label: 'Семья' },
  { id: 'biography', label: 'Биография' }, { id: 'interests', label: 'Интересы' }, { id: 'opinions', label: 'Мнения' },
  { id: 'speech', label: 'Речь' }, { id: 'twitch', label: 'Twitch' }, { id: 'memory', label: 'Память' },
]
const selectedPersona = computed(() => personas.value.find((persona) => persona.id === selectedPersonaId.value))
const personaById = computed(() => new Map(personas.value.map((persona) => [persona.id, persona])))
const personaSummaryById = computed(() => new Map(personaSummaries.value.map((summary) => [summary.id, summary])))

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
  { label: 'Сервер', ok: backendOnline.value, detail: backendOnline.value ? 'Интерфейс сервера доступен' : 'Нет соединения' },
  { label: 'Чат Twitch', ok: overview.twitchConnected, detail: `${overview.activeBots} из ${overview.totalBots} ботов в чате` },
  { label: 'Медиапоток', ok: overview.streamBrain.mediaConnected, detail: overview.streamBrain.mediaConnected ? 'Аудио и выбранные видеокадры' : stateLabel(overview.streamBrain.state) },
  { label: 'Gemini Live', ok: overview.streamBrain.geminiConnected, detail: overview.streamBrain.geminiConnected ? 'Единая Live-сессия подключена' : overview.streamBrain.lastError || 'Отключено' },
])
const refreshableUsernames = computed(() => new Set(
  twitchOAuth.accounts.filter((account) => account.refreshable).map((account) => account.username),
))

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
  if (response.status === 204) return undefined as T
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
    const [overviewData, botData, eventData, chatData, usageData, settingsData, personaData, personaSummaryData, decisionData, oauthData] = await Promise.all([
      api<Overview>('/api/overview'), api<Bot[]>('/api/bots'), api<StreamEvent[]>('/api/events?limit=100'),
      api<ChatMessage[]>('/api/chat'), api<Usage>('/api/usage'), api<Record<string, unknown>>('/api/settings'),
      api<Persona[]>('/api/personas'), api<PersonaSummary[]>('/api/persona-summaries'),
      api<ReactionDecision[]>('/api/decisions'), api<TwitchOAuthStatus>('/api/twitch/oauth/status'),
    ])
    Object.assign(overview, overviewData)
    Object.assign(usage, usageData)
    bots.value = botData
    events.value = eventData
    chat.value = chatData
    personas.value = personaData
    personaSummaries.value = personaSummaryData
    if (!personas.value.some((persona) => persona.id === selectedPersonaId.value)) {
      selectedPersonaId.value = personas.value[0]?.id || ''
    }
    if (selectedPersona.value) preparePersonaForEditing(selectedPersona.value)
    decisions.value = decisionData
    Object.assign(twitchOAuth, oauthData)
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

async function assignPersona(bot: Bot, personaId: string): Promise<void> {
  if (!personaId || personaId === bot.personaId) return
  try {
    await api(`/api/bots/${encodeURIComponent(bot.username)}`, { method: 'PATCH', body: JSON.stringify({ personaId }) })
    bot.personaId = personaId
    saveMessage.value = `${bot.username}: личность назначена без перезапуска`
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
}

async function connectTwitchAccount(): Promise<void> {
  oauthConnecting.value = true
  errorMessage.value = ''
  try {
    const result = await api<{ authorizationUrl: string }>('/api/twitch/oauth/start', { method: 'POST' })
    const authorizationUrl = new URL(result.authorizationUrl)
    if (authorizationUrl.origin !== new URL(API_URL).origin || authorizationUrl.pathname !== '/api/twitch/oauth/launch') {
      throw new Error('Сервер вернул недопустимый адрес авторизации Twitch')
    }
    window.location.assign(authorizationUrl.toString())
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    oauthConnecting.value = false
  }
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
    personaBusy.value = true
    const saved = await api<Persona>(`/api/personas/${encodeURIComponent(persona.id)}`, { method: 'PUT', body: JSON.stringify(personaPayload(persona)) })
    replacePersona(saved)
    await refreshPersonaSummaries()
    saveMessage.value = `Личность «${saved.name}» сохранена`
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { personaBusy.value = false }
}

async function createManualPersona(): Promise<void> {
  const requestedId = window.prompt('Укажите постоянный ID личности (латиница, цифры, дефис):', `persona-${personas.value.length + 1}`)?.trim()
  if (!requestedId) return
  const name = window.prompt('Как назвать вымышленного человека?', 'Новая личность')?.trim()
  if (!name) return
  try {
    personaBusy.value = true
    const created = await api<Persona>('/api/personas', { method: 'POST', body: JSON.stringify({ mode: 'manual', id: requestedId, name }) })
    personas.value.push(created)
    await refreshPersonaSummaries()
    selectPersona(created.id)
    saveMessage.value = `Создана личность «${created.name}»`
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { personaBusy.value = false }
}

async function createTemplatePersona(): Promise<void> {
  const username = window.prompt('Для какого Twitch-аккаунта создать уникальный шаблон?', '')?.trim()
  if (!username) return
  try {
    personaBusy.value = true
    const created = await api<Persona>('/api/personas', { method: 'POST', body: JSON.stringify({ mode: 'template', username }) })
    personas.value.push(created)
    await refreshPersonaSummaries()
    selectPersona(created.id)
    saveMessage.value = `Создан уникальный шаблон «${created.name}»`
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { personaBusy.value = false }
}

async function duplicateSelectedPersona(): Promise<void> {
  const source = selectedPersona.value
  if (!source) return
  const id = window.prompt('ID новой личности:', `${source.id}-copy`)?.trim()
  if (!id) return
  const name = window.prompt('Имя новой личности:', `${source.name} — копия`)?.trim()
  if (!name) return
  try {
    personaBusy.value = true
    const created = await api<Persona>('/api/personas', { method: 'POST', body: JSON.stringify({ mode: 'duplicate', sourceId: source.id, id, name }) })
    personas.value.push(created)
    await refreshPersonaSummaries()
    selectPersona(created.id)
    saveMessage.value = `Создана копия «${created.name}»; персонализируйте её канон перед назначением.`
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { personaBusy.value = false }
}

async function deleteSelectedPersona(): Promise<void> {
  const persona = selectedPersona.value
  if (!persona || !window.confirm(`Удалить личность «${persona.name}»? Назначенную аккаунту личность сервер удалить не позволит.`)) return
  try {
    personaBusy.value = true
    await api(`/api/personas/${encodeURIComponent(persona.id)}`, { method: 'DELETE' })
    personas.value = personas.value.filter((candidate) => candidate.id !== persona.id)
    await refreshPersonaSummaries()
    selectedPersonaId.value = personas.value[0]?.id || ''
    saveMessage.value = `Личность «${persona.name}» удалена`
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { personaBusy.value = false }
}

function selectPersona(id: string): void {
  selectedPersonaId.value = id
  personaContextPreview.value = null
  const persona = selectedPersona.value
  if (persona) preparePersonaForEditing(persona)
  if (personaTab.value === 'memory') void loadPersonaMemories()
}

function setPersonaTab(tab: PersonaTab): void {
  personaTab.value = tab
  if (tab === 'memory') void loadPersonaMemories()
}

async function loadPersonaMemories(): Promise<void> {
  if (!selectedPersonaId.value) return
  try { personaMemories.value = await api<PersonaMemoryItem[]>(`/api/personas/${encodeURIComponent(selectedPersonaId.value)}/memories?limit=50`) }
  catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
}

async function refreshPersonaSummaries(): Promise<void> {
  personaSummaries.value = await api<PersonaSummary[]>('/api/persona-summaries')
}

async function previewPersonaContext(): Promise<void> {
  const persona = selectedPersona.value
  if (!persona || !personaContextQuery.value.trim()) return
  const assigned = bots.value.find((bot) => bot.personaId === persona.id)
  try {
    personaBusy.value = true
    personaContextPreview.value = await api<Record<string, unknown>>(`/api/personas/${encodeURIComponent(persona.id)}/context-preview`, {
      method: 'POST', body: JSON.stringify({ query: personaContextQuery.value.trim(), ...(assigned ? { username: assigned.username } : {}) }),
    })
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { personaBusy.value = false }
}

function replacePersona(persona: Persona): void {
  const index = personas.value.findIndex((candidate) => candidate.id === persona.id)
  if (index >= 0) personas.value[index] = persona
  else personas.value.push(persona)
  preparePersonaForEditing(persona)
}

function preparePersonaForEditing(persona: Persona): void {
  persona.identity.birthplace ||= { country: '', city: '' }
  persona.identity.grewUpIn ||= { country: '', city: '' }
  persona.identity.currentLocation ||= { country: '', city: '' }
}

function addRelative(persona: Persona): void {
  persona.family.push({ id: crypto.randomUUID(), relation: 'other', name: 'Новый родственник', facts: [] })
}
function addTimelineEvent(persona: Persona): void {
  persona.timeline.push({ id: crypto.randomUUID(), title: 'Новое событие', description: 'Опишите устойчивый факт биографии', emotionalWeight: 0.5, tags: [] })
}
function addFact(persona: Persona): void {
  persona.facts.push({ id: crypto.randomUUID(), category: 'other', fact: 'Новый канонический факт', importance: 0.5, tags: [] })
}
function addOpinion(persona: Persona): void {
  persona.opinions.push({ id: crypto.randomUUID(), topic: 'Новая тема', stance: 'Устойчивое мнение', strength: 0.5, immutable: false, tags: [] })
}
function addPersonaRelationship(persona: Persona): void {
  const target = personas.value.find((candidate) => candidate.id !== persona.id && !persona.relationships.some((relationship) => relationship.targetPersonaId === candidate.id))
  if (target) persona.relationships.push({ targetPersonaId: target.id, familiarity: 0.1, sentiment: 0, notes: [] })
}
function addTextItem(items: string[], placeholder: string): void { items.push(placeholder) }

function personaAssignedToOther(personaId: string, username: string): boolean {
  return bots.value.some((bot) => bot.username !== username && bot.personaId === personaId)
}

function personaPayload(persona: Persona): Persona {
  const payload = JSON.parse(JSON.stringify(persona)) as Persona
  if (!payload.identity.birthDate) delete payload.identity.birthDate
  payload.family.forEach((relative) => { if (!relative.birthDate) delete relative.birthDate })
  payload.timeline.forEach((lifeEvent) => { if (typeof lifeEvent.year !== 'number') delete lifeEvent.year })
  return payload
}

function formatTime(timestamp?: number): string {
  return timestamp ? new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp) : '—'
}
function formatDate(timestamp?: number): string {
  return timestamp ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp) : '—'
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
function memoryTypeLabel(type: string): string {
  return ({ stream_event: 'событие стрима', conversation: 'разговор', viewer: 'зритель', streamer: 'стример', self: 'собственная реплика', relationship: 'отношения' } as Record<string, string>)[type] || type
}
function factCategoryLabel(category: string): string {
  return ({ family: 'семья', childhood: 'детство', education: 'учёба', work: 'работа', gaming: 'игры', food: 'еда', music: 'музыка', travel: 'поездки', technology: 'техника', relationships: 'отношения', habit: 'привычка', preference: 'предпочтение', story: 'история', other: 'другое' } as Record<string, string>)[category] || category
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

function consumeOAuthResult(): void {
  const url = new URL(window.location.href)
  const result = url.searchParams.get('twitchOAuth')
  if (!result) return
  activePage.value = 'bots'
  if (result === 'success') {
    const username = url.searchParams.get('username') || 'аккаунт'
    saveMessage.value = `Учётная запись Twitch ${username} подключена. Токен будет обновляться автоматически.`
  } else {
    const reason = url.searchParams.get('reason') || 'authorization_failed'
    const labels: Record<string, string> = {
      access_denied: 'Вы отменили доступ в Twitch.',
      invalid_state: 'Срок безопасной сессии авторизации истёк. Запустите подключение ещё раз.',
      invalid_callback: 'Twitch вернул неполный ответ авторизации.',
      invalid_launch: 'Ссылка подключения уже использована или истекла. Нажмите кнопку ещё раз.',
      not_configured: 'Авторизация Twitch ещё не настроена на сервере.',
      authorization_failed: 'Не удалось завершить авторизацию Twitch. Проверьте адрес возврата и повторите.',
    }
    errorMessage.value = labels[reason] || labels.authorization_failed
  }
  url.searchParams.delete('twitchOAuth')
  url.searchParams.delete('username')
  url.searchParams.delete('reason')
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

onMounted(() => {
  consumeOAuthResult()
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
          <div class="page-heading"><div><p class="eyebrow">ЦЕНТР УПРАВЛЕНИЯ</p><h1>Обзор</h1></div><p class="muted">Один стрим, один мультимодальный мозг, {{ overview.totalBots }} самостоятельных личностей.</p></div>
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
                <article v-for="bot in bots.slice(0, 8)" :key="bot.username"><span class="avatar">{{ bot.username.slice(0, 2).toUpperCase() }}</span><div><strong>{{ bot.username }}</strong><small>{{ personaById.get(bot.personaId)?.name || bot.personaId }}</small></div><span :class="['state-badge', stateClass(bot.connectionState)]">{{ stateLabel(bot.connectionState) }}</span></article>
                <div v-if="!bots.length" class="empty-state">В Railway пока не настроены аккаунты BOTn.</div>
              </div>
            </section>
          </div>
        </template>

        <template v-else-if="activePage === 'bots'">
          <div class="page-heading"><div><p class="eyebrow">ОФИЦИАЛЬНЫЙ ЧАТ TWITCH</p><h1>Аккаунты ботов</h1></div><p class="muted">Сбой одного аккаунта не останавливает остальные. Накрутка просмотров не используется.</p></div>
          <section class="panel oauth-panel">
            <div class="panel-heading">
              <div><p class="eyebrow">АВТОМАТИЧЕСКОЕ ОБНОВЛЕНИЕ</p><h3>Подключение через Twitch</h3></div>
              <span :class="['state-badge', twitchOAuth.configured ? 'connected' : 'error']">{{ twitchOAuth.configured ? 'настроено' : 'не настроено' }}</span>
            </div>
            <div class="oauth-layout">
              <div>
                <p class="muted">Войдите в нужную учётную запись бота Twitch и подтвердите только чтение и отправку сообщений. Токены доступа и обновления сохраняются в PostgreSQL в зашифрованном виде и не попадают в клиентскую часть.</p>
                <button class="primary" type="button" :disabled="!twitchOAuth.configured || oauthConnecting" @click="connectTwitchAccount">
                  {{ oauthConnecting ? 'Переходим в Twitch…' : 'Подключить или обновить аккаунт' }}
                </button>
              </div>
              <div class="oauth-summary">
                <span>С автообновлением</span><strong>{{ twitchOAuth.accounts.filter((account) => account.refreshable).length }} из {{ bots.length }}</strong>
                <small v-if="twitchOAuth.callbackUrl">Адрес возврата для панели разработчика Twitch:<br><code>{{ twitchOAuth.callbackUrl }}</code></small>
              </div>
            </div>
            <div v-if="twitchOAuth.accounts.length" class="oauth-accounts">
              <span v-for="account in twitchOAuth.accounts" :key="account.username" :class="['subtle-chip', account.refreshable ? '' : 'danger-chip']" :title="account.lastRefreshError || `Следующее обновление до ${formatDate(account.expiresAt)}`">{{ account.username }} · {{ account.refreshState === 'RECONNECT_REQUIRED' ? 'переподключить' : account.refreshState === 'ERROR' ? 'повтор' : 'авто' }}</span>
            </div>
          </section>
          <section class="panel table-panel">
            <div class="bot-table table-head"><span>Аккаунт</span><span>Состояние</span><span>Личность</span><span>Сообщения</span><span>Последняя реакция</span><span>Включён</span></div>
            <div v-for="bot in bots" :key="bot.username" class="bot-table table-row">
              <div class="account-cell"><span class="avatar">{{ bot.username.slice(0, 2).toUpperCase() }}</span><div><strong>{{ bot.username }}</strong><small>{{ refreshableUsernames.has(bot.username) ? 'авторизация с автообновлением' : bot.chatConnected ? 'вошёл в чат' : bot.lastError || 'нужно переподключить через Twitch' }}</small></div></div>
              <span :class="['state-badge', stateClass(bot.connectionState)]">{{ stateLabel(bot.connectionState) }}</span>
              <div class="persona-assignment"><select :value="bot.personaId" @change="assignPersona(bot, ($event.target as HTMLSelectElement).value)"><option v-for="persona in personas" :key="persona.id" :value="persona.id" :disabled="personaAssignedToOther(persona.id, bot.username)">{{ persona.name }}{{ personaAssignedToOther(persona.id, bot.username) ? ' · занята' : '' }}</option></select><small v-if="personaSummaryById.get(bot.personaId)">{{ personaSummaryById.get(bot.personaId)?.firstName }} · {{ personaSummaryById.get(bot.personaId)?.age ?? 'возраст не указан' }} · {{ personaSummaryById.get(bot.personaId)?.city || 'город не указан' }} · {{ personaSummaryById.get(bot.personaId)?.occupation || 'работа не указана' }}</small></div>
              <span>{{ bot.messagesSent }}</span><span>{{ formatTime(bot.lastReactionAt) }}</span>
              <button :class="['toggle', bot.enabled ? 'on' : '']" :aria-label="`Переключить ${bot.username}`" @click="toggleBot(bot)"><i></i></button>
            </div>
            <div v-if="!bots.length" class="empty-state">Подключите первую учётную запись кнопкой выше — логин и обновляемые токены сервер сохранит сам.</div>
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
          <div class="page-heading"><div><p class="eyebrow">БЕЗОПАСНОЕ УПРАВЛЕНИЕ</p><h1>Настройки</h1></div><p class="muted">Ключи доступа и токены Twitch никогда не передаются в панель.</p></div>
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
          <div class="section-heading"><div><p class="eyebrow">УСТОЙЧИВЫЕ ВЫМЫШЛЕННЫЕ ЛЮДИ</p><h2>Редактор личностей</h2></div><p class="muted">Канон меняется только здесь. Память стрима не может переписать имя, семью или биографию.</p></div>
          <section class="panel persona-toolbar">
            <label>Выбранная личность<select :value="selectedPersonaId" @change="selectPersona(($event.target as HTMLSelectElement).value)"><option v-for="persona in personas" :key="persona.id" :value="persona.id">{{ persona.name }} · {{ persona.id }}</option></select></label>
            <div class="persona-toolbar-actions"><button class="primary" type="button" :disabled="personaBusy" @click="createManualPersona">Создать вручную</button><button class="secondary" type="button" :disabled="personaBusy" @click="createTemplatePersona">Создать шаблон</button><button class="secondary" type="button" :disabled="!selectedPersona || personaBusy" @click="duplicateSelectedPersona">Дублировать основу</button><button class="danger-button" type="button" :disabled="!selectedPersona || personaBusy" @click="deleteSelectedPersona">Удалить</button></div>
            <div v-if="selectedPersona" class="completeness"><span>Заполненность личности</span><meter min="0" max="100" :value="personaSummaryById.get(selectedPersona.id)?.completeness ?? 0"></meter><strong>{{ personaSummaryById.get(selectedPersona.id)?.completeness ?? 0 }}%</strong></div>
          </section>

          <form v-if="selectedPersona" class="panel persona-editor" @submit.prevent="savePersona(selectedPersona)">
            <div class="persona-editor-heading"><div><span class="persona-id">{{ selectedPersona.id }}</span><h3>{{ selectedPersona.name }}</h3><small>Вымышленная личность · возраст вычисляется сервером из даты рождения: {{ personaSummaryById.get(selectedPersona.id)?.age ?? 'не указан' }}</small></div><span class="subtle-chip">схема v{{ selectedPersona.schemaVersion }}</span></div>
            <nav class="persona-tabs" aria-label="Разделы личности"><button v-for="tab in personaTabs" :key="tab.id" type="button" :class="{ active: personaTab === tab.id }" @click="setPersonaTab(tab.id)">{{ tab.label }}</button></nav>

            <section v-if="personaTab === 'main'" class="persona-section">
              <div class="three-fields"><label>Название в панели<input v-model="selectedPersona.name" /></label><label>Имя человека<input v-model="selectedPersona.identity.firstName" /></label><label>Никнейм<input v-model="selectedPersona.identity.nickname" /></label></div>
              <label>Краткое описание<textarea v-model="selectedPersona.description" rows="3"></textarea></label>
              <div class="three-fields"><label>Дата рождения<input v-model="selectedPersona.identity.birthDate" type="date" /></label><label>Работа<input v-model="selectedPersona.identity.occupation" /></label><label>Статус отношений<input v-model="selectedPersona.identity.relationshipStatus" /></label></div>
              <label>Образование<input v-model="selectedPersona.identity.education" /></label>
              <h4>Места</h4><div class="location-grid"><div><strong>Родился</strong><input v-model="selectedPersona.identity.birthplace!.city" placeholder="Город" /><input v-model="selectedPersona.identity.birthplace!.country" placeholder="Страна" /></div><div><strong>Вырос</strong><input v-model="selectedPersona.identity.grewUpIn!.city" placeholder="Город" /><input v-model="selectedPersona.identity.grewUpIn!.country" placeholder="Страна" /></div><div><strong>Живёт сейчас</strong><input v-model="selectedPersona.identity.currentLocation!.city" placeholder="Город" /><input v-model="selectedPersona.identity.currentLocation!.country" placeholder="Страна" /></div></div>
              <div class="subsection-heading"><h4>Языки</h4><button class="text-button" type="button" @click="selectedPersona.identity.languages.push({ language: 'русский', level: 'разговорный' })">+ Добавить язык</button></div><div class="repeat-list"><div v-for="(language, index) in selectedPersona.identity.languages" :key="index" class="inline-edit"><input v-model="language.language" placeholder="Язык" /><input v-model="language.level" placeholder="Уровень" /><button type="button" class="icon-button" @click="selectedPersona.identity.languages.splice(index, 1)">×</button></div></div>
            </section>

            <section v-else-if="personaTab === 'character'" class="persona-section">
              <label>Характер<textarea v-model="selectedPersona.character.summary" rows="3"></textarea></label><div class="two-fields"><label>Юмор<input v-model="selectedPersona.character.humor" /></label><label>Поведение в конфликте<input v-model="selectedPersona.character.conflictStyle" /></label></div>
              <div class="four-columns"><div><div class="subsection-heading"><h4>Черты</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.character.traits, 'новая черта')">+</button></div><div v-for="(_, index) in selectedPersona.character.traits" :key="index" class="inline-edit"><input v-model="selectedPersona.character.traits[index]" /><button type="button" @click="selectedPersona.character.traits.splice(index, 1)">×</button></div></div><div><div class="subsection-heading"><h4>Сильные стороны</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.character.strengths, 'новая сильная сторона')">+</button></div><div v-for="(_, index) in selectedPersona.character.strengths" :key="index" class="inline-edit"><input v-model="selectedPersona.character.strengths[index]" /><button type="button" @click="selectedPersona.character.strengths.splice(index, 1)">×</button></div></div><div><div class="subsection-heading"><h4>Недостатки</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.character.flaws, 'новый недостаток')">+</button></div><div v-for="(_, index) in selectedPersona.character.flaws" :key="index" class="inline-edit"><input v-model="selectedPersona.character.flaws[index]" /><button type="button" @click="selectedPersona.character.flaws.splice(index, 1)">×</button></div></div><div><div class="subsection-heading"><h4>Слепые зоны</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.behavior.imperfections.blindSpots, 'новая слепая зона')">+</button></div><div v-for="(_, index) in selectedPersona.behavior.imperfections.blindSpots" :key="index" class="inline-edit"><input v-model="selectedPersona.behavior.imperfections.blindSpots[index]" /><button type="button" @click="selectedPersona.behavior.imperfections.blindSpots.splice(index, 1)">×</button></div></div></div>
              <label>Инструкции поведения<textarea v-model="selectedPersona.behavior.styleInstructions" rows="3"></textarea></label><div class="three-fields"><label>Минимум слов<input v-model.number="selectedPersona.behavior.verbosity.minWords" type="number" min="1" max="50" /></label><label>Максимум слов<input v-model.number="selectedPersona.behavior.verbosity.maxWords" type="number" min="1" max="100" /></label><label>Минимальная пауза, мс<input v-model.number="selectedPersona.behavior.minimumIntervalMs" type="number" min="1000" /></label></div>
              <div class="slider-grid"><label>Склонность реагировать <b>{{ selectedPersona.behavior.reactionProbability.toFixed(2) }}</b><input v-model.number="selectedPersona.behavior.reactionProbability" type="range" min="0" max="1" step="0.05" /></label><label>Избирательность событий <b>{{ selectedPersona.behavior.activity.eventSelectivity.toFixed(2) }}</b><input v-model.number="selectedPersona.behavior.activity.eventSelectivity" type="range" min="0" max="1" step="0.05" /></label><label>Ответ на прямое обращение <b>{{ selectedPersona.behavior.activity.directReplyLikelihood.toFixed(2) }}</b><input v-model.number="selectedPersona.behavior.activity.directReplyLikelihood" type="range" min="0" max="1" step="0.05" /></label><label>Сарказм <b>{{ selectedPersona.behavior.sarcasmLevel.toFixed(2) }}</b><input v-model.number="selectedPersona.behavior.sarcasmLevel" type="range" min="0" max="1" step="0.05" /></label></div>
              <label>Частота активности<select v-model="selectedPersona.behavior.activity.chatFrequency"><option value="very-low">очень редко</option><option value="low">редко</option><option value="medium">средне</option><option value="high">активно</option></select></label>
            </section>

            <section v-else-if="personaTab === 'family'" class="persona-section">
              <div class="subsection-heading"><div><h4>Вымышленная семья</h4><p class="muted">Эти факты попадают в контекст только по релевантному вопросу.</p></div><button class="secondary" type="button" @click="addRelative(selectedPersona)">+ Родственник</button></div>
              <article v-for="(relative, index) in selectedPersona.family" :key="relative.id" class="nested-card"><div class="three-fields"><label>Связь<select v-model="relative.relation"><option value="mother">мать</option><option value="father">отец</option><option value="brother">брат</option><option value="sister">сестра</option><option value="uncle">дядя</option><option value="aunt">тётя</option><option value="grandmother">бабушка</option><option value="grandfather">дедушка</option><option value="cousin">двоюродный родственник</option><option value="daughter">дочь</option><option value="son">сын</option><option value="other">другое</option></select></label><label>Имя<input v-model="relative.name" /></label><label>Дата рождения<input v-model="relative.birthDate" type="date" /></label></div><div class="two-fields"><label>Работа<input v-model="relative.occupation" /></label><label>Город<input v-model="relative.city" /></label></div><label>Отношения<textarea v-model="relative.relationshipDescription" rows="2"></textarea></label><div class="subsection-heading"><h4>Факты</h4><button type="button" class="text-button" @click="addTextItem(relative.facts, 'новый факт')">+</button></div><div v-for="(_, factIndex) in relative.facts" :key="factIndex" class="inline-edit"><input v-model="relative.facts[factIndex]" /><button type="button" @click="relative.facts.splice(factIndex, 1)">×</button></div><button class="danger-button compact" type="button" @click="selectedPersona.family.splice(index, 1)">Удалить родственника</button></article>
              <div v-if="!selectedPersona.family.length" class="empty-state">Семья пока не описана.</div>
            </section>

            <section v-else-if="personaTab === 'biography'" class="persona-section">
              <div class="subsection-heading"><div><h4>Жизненная хронология</h4><p class="muted">Устойчивые события, а не случайные истории Gemini.</p></div><button class="secondary" type="button" @click="addTimelineEvent(selectedPersona)">+ Событие</button></div>
              <article v-for="(lifeEvent, index) in selectedPersona.timeline" :key="lifeEvent.id" class="nested-card"><div class="two-fields"><label>Год<input v-model.number="lifeEvent.year" type="number" min="1900" max="2200" /></label><label>Название<input v-model="lifeEvent.title" /></label></div><label>Описание<textarea v-model="lifeEvent.description" rows="2"></textarea></label><label>Эмоциональный вес <b>{{ lifeEvent.emotionalWeight.toFixed(2) }}</b><input v-model.number="lifeEvent.emotionalWeight" type="range" min="0" max="1" step="0.05" /></label><button class="danger-button compact" type="button" @click="selectedPersona.timeline.splice(index, 1)">Удалить событие</button></article>
              <div class="subsection-heading"><div><h4>Канонические факты</h4><p class="muted">До шести релевантных фактов выбираются сервером по теме.</p></div><button class="secondary" type="button" @click="addFact(selectedPersona)">+ Факт</button></div>
              <article v-for="(fact, index) in selectedPersona.facts" :key="fact.id" class="nested-card"><div class="two-fields"><label>Категория<select v-model="fact.category"><option v-for="value in ['family','childhood','education','work','gaming','food','music','travel','technology','relationships','habit','preference','story','other']" :key="value" :value="value">{{ factCategoryLabel(value) }}</option></select></label><label>Важность <b>{{ fact.importance.toFixed(2) }}</b><input v-model.number="fact.importance" type="range" min="0" max="1" step="0.05" /></label></div><label>Факт<textarea v-model="fact.fact" rows="2"></textarea></label><label class="check-line"><input v-model="fact.privateByDefault" type="checkbox" /> Не передавать без явной необходимости</label><button class="danger-button compact" type="button" @click="selectedPersona.facts.splice(index, 1)">Удалить факт</button></article>
            </section>

            <section v-else-if="personaTab === 'interests'" class="persona-section">
              <div class="four-columns"><div v-for="group in [{ key: 'games', label: 'Игры' }, { key: 'music', label: 'Музыка' }, { key: 'food', label: 'Еда' }, { key: 'other', label: 'Другое' }]" :key="group.key"><div class="subsection-heading"><h4>{{ group.label }}</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.interests[group.key as keyof Persona['interests']], 'новый интерес')">+</button></div><div v-for="(_, index) in selectedPersona.interests[group.key as keyof Persona['interests']]" :key="index" class="inline-edit"><input v-model="selectedPersona.interests[group.key as keyof Persona['interests']][index]" /><button type="button" @click="selectedPersona.interests[group.key as keyof Persona['interests']].splice(index, 1)">×</button></div></div></div>
              <h4>Границы знаний</h4><div class="four-columns"><div v-for="group in [{ key: 'expertise', label: 'Эксперт' }, { key: 'familiarTopics', label: 'Знакомые темы' }, { key: 'weakTopics', label: 'Слабые темы' }, { key: 'unknownTopics', label: 'Не знает' }]" :key="group.key"><div class="subsection-heading"><h4>{{ group.label }}</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.knowledge[group.key as keyof Persona['knowledge']], 'новая тема')">+</button></div><div v-for="(_, index) in selectedPersona.knowledge[group.key as keyof Persona['knowledge']]" :key="index" class="inline-edit"><input v-model="selectedPersona.knowledge[group.key as keyof Persona['knowledge']][index]" /><button type="button" @click="selectedPersona.knowledge[group.key as keyof Persona['knowledge']].splice(index, 1)">×</button></div></div></div>
            </section>

            <section v-else-if="personaTab === 'opinions'" class="persona-section">
              <div class="subsection-heading"><div><h4>Устойчивые мнения</h4><p class="muted">Сильное мнение не меняется от случайной фразы в чате.</p></div><button class="secondary" type="button" @click="addOpinion(selectedPersona)">+ Мнение</button></div><article v-for="(opinion, index) in selectedPersona.opinions" :key="opinion.id" class="nested-card"><div class="two-fields"><label>Тема<input v-model="opinion.topic" /></label><label>Сила <b>{{ opinion.strength.toFixed(2) }}</b><input v-model.number="opinion.strength" type="range" min="0" max="1" step="0.05" /></label></div><label>Позиция<textarea v-model="opinion.stance" rows="2"></textarea></label><label>Обоснование<textarea v-model="opinion.reasoning" rows="2"></textarea></label><label class="check-line"><input v-model="opinion.immutable" type="checkbox" /> Неизменяемое базовое предпочтение</label><button class="danger-button compact" type="button" @click="selectedPersona.opinions.splice(index, 1)">Удалить мнение</button></article>
            </section>

            <section v-else-if="personaTab === 'speech'" class="persona-section">
              <div class="three-fields"><label>Средняя длина, слов<input v-model.number="selectedPersona.speech.averageMessageWords" type="number" min="1" max="80" /></label><label>Пунктуация<input v-model="selectedPersona.speech.punctuationStyle" /></label><label>Регистр<input v-model="selectedPersona.speech.capitalizationStyle" /></label></div>
              <div class="slider-grid"><label>Сленг <b>{{ selectedPersona.behavior.slangLevel.toFixed(2) }}</b><input v-model.number="selectedPersona.behavior.slangLevel" type="range" min="0" max="1" step="0.05" /></label><label>Капс <b>{{ selectedPersona.behavior.uppercaseProbability.toFixed(2) }}</b><input v-model.number="selectedPersona.behavior.uppercaseProbability" type="range" min="0" max="1" step="0.05" /></label><label>Эмодзи <b>{{ selectedPersona.behavior.emojiProbability.toFixed(2) }}</b><input v-model.number="selectedPersona.behavior.emojiProbability" type="range" min="0" max="1" step="0.05" /></label><label>Ненормативная лексика <b>{{ selectedPersona.speech.profanityLevel.toFixed(2) }}</b><input v-model.number="selectedPersona.speech.profanityLevel" type="range" min="0" max="1" step="0.05" /></label></div>
              <div class="four-columns"><div v-for="group in [{ key: 'favoriteExpressions', label: 'Любимые выражения' }, { key: 'fillerWords', label: 'Слова-паразиты' }, { key: 'laughStyles', label: 'Смех' }, { key: 'avoidedExpressions', label: 'Не использует' }]" :key="group.key"><div class="subsection-heading"><h4>{{ group.label }}</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.speech[group.key as 'favoriteExpressions'|'fillerWords'|'laughStyles'|'avoidedExpressions'], 'новое выражение')">+</button></div><div v-for="(_, index) in selectedPersona.speech[group.key as 'favoriteExpressions'|'fillerWords'|'laughStyles'|'avoidedExpressions']" :key="index" class="inline-edit"><input v-model="selectedPersona.speech[group.key as 'favoriteExpressions'|'fillerWords'|'laughStyles'|'avoidedExpressions'][index]" /><button type="button" @click="selectedPersona.speech[group.key as 'favoriteExpressions'|'fillerWords'|'laughStyles'|'avoidedExpressions'].splice(index, 1)">×</button></div></div></div>
              <div class="subsection-heading"><h4>Примеры сообщений</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.speech.messageExamples, 'новый пример')">+</button></div><div v-for="(_, index) in selectedPersona.speech.messageExamples" :key="index" class="inline-edit"><input v-model="selectedPersona.speech.messageExamples[index]" /><button type="button" @click="selectedPersona.speech.messageExamples.splice(index, 1)">×</button></div>
            </section>

            <section v-else-if="personaTab === 'twitch'" class="persona-section">
              <div class="two-fields"><label>Впервые увидел стрим<input v-model="selectedPersona.streamerRelationship.firstSeen" placeholder="2024-03" /></label><label>Любимые типы стримов<input :value="selectedPersona.streamerRelationship.favoriteStreamTypes.join(', ')" @change="selectedPersona.streamerRelationship.favoriteStreamTypes = ($event.target as HTMLInputElement).value.split(',').map(value => value.trim()).filter(Boolean)" /></label></div>
              <div class="slider-grid"><label>Знакомство со стримером <b>{{ selectedPersona.streamerRelationship.familiarity.toFixed(2) }}</b><input v-model.number="selectedPersona.streamerRelationship.familiarity" type="range" min="0" max="1" step="0.05" /></label><label>Поддержка <b>{{ selectedPersona.streamerRelationship.supportiveness.toFixed(2) }}</b><input v-model.number="selectedPersona.streamerRelationship.supportiveness" type="range" min="0" max="1" step="0.05" /></label><label>Поддразнивание <b>{{ selectedPersona.streamerRelationship.teasingLevel.toFixed(2) }}</b><input v-model.number="selectedPersona.streamerRelationship.teasingLevel" type="range" min="0" max="1" step="0.05" /></label></div>
              <div class="subsection-heading"><h4>Повторяющиеся ссылки</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.streamerRelationship.recurringReferences, 'новая ссылка')">+</button></div><div v-for="(_, index) in selectedPersona.streamerRelationship.recurringReferences" :key="index" class="inline-edit"><input v-model="selectedPersona.streamerRelationship.recurringReferences[index]" /><button type="button" @click="selectedPersona.streamerRelationship.recurringReferences.splice(index, 1)">×</button></div>
              <div class="subsection-heading"><div><h4>Знакомства с другими личностями</h4><p class="muted">Не создают принудительный разговор; используются только при естественном поводе.</p></div><button class="secondary" type="button" @click="addPersonaRelationship(selectedPersona)">+ Знакомство</button></div><article v-for="(relationship, index) in selectedPersona.relationships" :key="relationship.targetPersonaId" class="nested-card"><label>Другая личность<select v-model="relationship.targetPersonaId"><option v-for="candidate in personas.filter(candidate => candidate.id !== selectedPersona!.id)" :key="candidate.id" :value="candidate.id">{{ candidate.name }}</option></select></label><div class="two-fields"><label>Знакомство <b>{{ relationship.familiarity.toFixed(2) }}</b><input v-model.number="relationship.familiarity" type="range" min="0" max="1" step="0.05" /></label><label>Отношение <b>{{ relationship.sentiment.toFixed(2) }}</b><input v-model.number="relationship.sentiment" type="range" min="-1" max="1" step="0.05" /></label></div><div class="subsection-heading"><h4>Заметки</h4><button type="button" class="text-button" @click="addTextItem(relationship.notes, 'новая заметка')">+</button></div><div v-for="(_, noteIndex) in relationship.notes" :key="noteIndex" class="inline-edit"><input v-model="relationship.notes[noteIndex]" /><button type="button" @click="relationship.notes.splice(noteIndex, 1)">×</button></div><button class="danger-button compact" type="button" @click="selectedPersona.relationships.splice(index, 1)">Удалить знакомство</button></article>
            </section>

            <section v-else class="persona-section">
              <div class="debug-context"><div><h4>Что получила бы Gemini</h4><p class="muted">Без ключей и токенов. Показывает только контекст одной выбранной личности.</p><div class="inline-edit"><input v-model="personaContextQuery" placeholder="Например: как дядю зовут?" /><button class="secondary" type="button" :disabled="personaBusy" @click="previewPersonaContext">Собрать контекст</button></div></div><pre v-if="personaContextPreview">{{ JSON.stringify(personaContextPreview, null, 2) }}</pre></div>
              <div class="subsection-heading"><div><h4>Долгосрочная память</h4><p class="muted">Канон выше памяти. Записи ниже не меняют биографию.</p></div><button class="text-button" type="button" @click="loadPersonaMemories">Обновить</button></div><div class="memory-list"><article v-for="memory in personaMemories" :key="memory.id"><div><strong>{{ memory.summary }}</strong><small>{{ formatDate(memory.createdAt) }} · {{ memoryTypeLabel(memory.type) }} · важность {{ memory.importance.toFixed(2) }}</small></div><span class="subtle-chip">{{ memory.tags.join(', ') || 'без тегов' }}</span></article><div v-if="!personaMemories.length" class="empty-state">У этой личности ещё нет сохранённых воспоминаний.</div></div>
            </section>

            <div class="persona-editor-footer"><p class="muted">Сохранение изменяет канон. Обычный чат и Gemini не имеют доступа к этой операции.</p><button class="primary" type="submit" :disabled="personaBusy">{{ personaBusy ? 'Сохраняем…' : 'Сохранить личность' }}</button></div>
          </form>
          <div v-else class="empty-state panel">Создайте первую личность вручную или из уникального шаблона.</div>
        </template>
      </main>
    </div>
  </div>
</template>
