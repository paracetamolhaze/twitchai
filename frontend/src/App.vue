<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { io, Socket } from 'socket.io-client'

type Page = 'overview' | 'bots' | 'brain' | 'memories' | 'chat' | 'settings'
type PersonaTab = 'main' | 'character' | 'family' | 'biography' | 'interests' | 'opinions' | 'speech' | 'twitch' | 'memory' | 'quality'
type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'DISABLED'
type BrainState = 'STOPPED' | 'OFFLINE' | 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'FATAL_CONFIG_ERROR' | 'DISABLED'

interface BrainStatus {
  state: BrainState
  mediaState: 'STOPPED' | 'CONNECTING' | 'STREAMING' | 'OFFLINE' | 'ERROR'
  geminiState: 'STOPPED' | 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'FATAL_CONFIG_ERROR' | 'DISABLED'
  mediaConnected: boolean
  geminiConnected: boolean
  geminiStable: boolean
  geminiSessionActive: boolean
  geminiSessionReason: 'twitch_live' | 'twitch_offline' | 'media_connecting' | 'media_error' | 'fatal_error' | 'application_stopped' | 'disabled'
  model?: string
  sessionStartedAt?: number
  lastEventAt?: number
  lastError?: string
  lastCloseCode?: number
  lastCloseReason?: string
  lastCloseWasClean?: boolean
  lastSessionAgeMs?: number
  lastOutbound?: string
  lastToolCall?: string
  lastToolResponse?: string
  lastMediaInput?: 'audio' | 'video'
  outboundTrace?: Array<{ at: number; type: string; bytes?: number }>
  protocolErrorsInWindow?: number
  resumeAttempts?: number
  freshReconnects?: number
  audioChunksSent?: number
  videoFramesSent?: number
  transcriptsReceived?: number
  stallRecoveries?: number
  msSincePerceptionOutput?: number
  modelTurns?: number
  usageReports?: number
  contextWindowMode?: 'explicit' | 'service_default'
  responseModality?: 'text' | 'audio'
  spokenMentionsDetected?: number
  eligibleBots?: number
}
interface GeminiBrainStatus {
  state: 'OFFLINE' | 'STARTING' | 'READY' | 'THINKING' | 'ERROR'
  model: string
  thinkingLevel: 'low' | 'medium' | 'high'
  sessionStartedAt?: number
  interactionStartedAt?: number
  previousInteractionId?: string
  interactions: number
  decisions: number
  silentDecisions: number
  generatedReactions: number
  averageLatencyMs: number
  lastLatencyMs?: number
  lastError?: string
  rebuiltSessions: number
  rollovers: number
  contextTokens: number
  bootstrapChars: number
  bootstrapInputTokens: number
}
interface Overview {
  channel: string
  category: string
  isLive: boolean
  twitchConnected: boolean
  streamBrain: BrainStatus
  geminiBrain: GeminiBrainStatus
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
  capturedAudioMinutes: number
  capturedVideoMinutes: number
  geminiAudioSentMinutes: number
  geminiVideoSentMinutes: number
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
  memoryToolCalls: number
  memoriesCreated: number
  memoriesMerged: number
  memoriesSuperseded: number
  memoryRetrievals: number
  perception: {
    sessionDurationMinutes: number; audioSentMinutes: number; videoSentMinutes: number
    inputTokens: number; outputTokens: number; toolCalls: number; events: number; estimatedCostUsd: number
    inputTokensByModality: TokenModalityUsage; outputTokensByModality: TokenModalityUsage
  }
  brain: {
    interactions: number; decisions: number; inputTokens: number; cachedInputTokens: number
    outputTokens: number; thinkingTokens: number; totalTokens: number
    averageLatencyMs: number; lastLatencyMs?: number; estimatedCostUsd: number
  }
  totalAi: {
    estimatedCostUsd: number; estimatedCostPerHourUsd: number
    eventsPerHour: number; brainDecisionsPerHour: number; messagesPerHour: number
  }
  drive: DriveUsageCounters
  driveBrain: Usage['brain']
  driveCacheHitRatio: number
  currentStream: {
    active: boolean
    startedAt?: number
    durationMinutes: number
    capturedAudioMinutes: number
    capturedVideoMinutes: number
    geminiAudioSentMinutes: number
    geminiVideoSentMinutes: number
    geminiReconnects: number
    geminiInputTokens: number
    geminiOutputTokens: number
    sentResponses: number
    confirmedDeliveries: number
    undeliveredMessages: number
    perception: Usage['perception']
    brain: Usage['brain']
    totalAi: Usage['totalAi']
    drive: DriveUsageCounters
    driveBrain: Usage['brain']
    driveCacheHitRatio: number
  }
}
interface TokenModalityUsage { text: number; audio: number; video: number; other: number }
interface DriveUsageCounters {
  ticks: number; eligibleTicks: number; localSkips: number
  brainCalls: number; brainCallsBlockedByHourlyLimit: number
  silentDecisions: number; messages: number; messagesBlockedByHourlyLimit: number
  cancelledForExternalEvent: number; cancelledForCooldown: number; cancelledForNoCandidates: number
}
type StreamerMemoryType = 'fact' | 'preference' | 'person' | 'relationship' | 'plan' | 'promise' | 'result' | 'place' | 'trip' | 'running_joke' | 'important_event' | 'recurring_context' | 'other'
type StreamerMemoryStatus = 'active' | 'resolved' | 'superseded' | 'expired'
interface StreamerMemory {
  id: string
  channel: string
  type: StreamerMemoryType
  summary: string
  details?: Record<string, unknown>
  entities: string[]
  tags: string[]
  importance: number
  confidence: number
  occurredAt?: number
  createdAt: number
  updatedAt: number
  lastSeenAt: number
  confirmationCount: number
  sourceSessionId?: string
  sourceEventId?: string
  status: StreamerMemoryStatus
  expiresAt?: number
  resolvedAt?: number
  supersededBy?: string
}
interface StreamerMemoryStats {
  channel: string
  total: number
  active: number
  resolved: number
  superseded: number
  expired: number
  duplicateMerges: number
  averageImportance: number
  averageConfidence: number
}
interface Persona {
  schemaVersion: 2
  generationVersion: number
  source: 'generated' | 'manual'
  generatedFromUsername?: string
  manuallyEdited: boolean
  manualOverrides: string[]
  legacyManualReviewRequired: boolean
  fictionalPersona: true
  id: string
  name: string
  spokenAliases?: string[]
  description: string
  identity: {
    firstName: string; preferredName?: string; nickname?: string; nicknameOrigin?: string; birthDate?: string
    birthplace?: { country: string; city: string }; grewUpIn?: { country: string; city: string }
    currentLocation?: { country: string; city: string }
    languages: Array<{ language: string; level: string }>
    occupation?: string; education?: string; relationshipStatus?: string
  }
  familyBackground: string
  family: Array<{ id: string; relation: string; name: string; birthDate?: string; occupation?: string; city?: string; relationshipDescription?: string; facts: string[] }>
  timeline: Array<{ id: string; year?: number; title: string; description: string; emotionalWeight: number; tags: string[] }>
  facts: Array<{ id: string; category: string; fact: string; importance: number; privateByDefault?: boolean; tags: string[] }>
  opinions: Array<{ id: string; topic: string; stance: string; strength: number; reasoning?: string; immutable: boolean; tags: string[] }>
  knowledge: { expertise: string[]; familiarTopics: string[]; weakTopics: string[]; unknownTopics: string[] }
  character: { summary: string; traits: string[]; strengths: string[]; flaws: string[]; humor: string; conflictStyle: string }
  interests: { games: string[]; music: string[]; food: string[]; other: string[] }
  speech: {
    averageMessageWords: number; openingPatterns: string[]; endingPatterns: string[]; vocabulary: string[]
    favoriteExpressions: string[]; rareExpressions: string[]; avoidedExpressions: string[]; fillerWords: string[]
    abbreviations: string[]; typoStyle: string[]; punctuationStyle: string; capitalizationStyle: string
    laughStyles: string[]; emojiPreferences: string[]; twitchEmotes: string[]; profanityLevel: number; messageExamples: string[]
  }
  behavior: {
    styleInstructions: string; verbosity: { minWords: number; maxWords: number }; reactionProbability: number
    uppercaseProbability: number; questionProbability: number; emojiProbability: number; slangLevel: number
    sarcasmLevel: number; toxicityLimit: number; temperature: number; minimumIntervalMs: number
    imperfections: { typingMistakes: string[]; hesitations: string[]; emotionalTriggers: string[]; blindSpots: string[] }
    activity: { chatFrequency: 'very-low' | 'low' | 'medium' | 'high'; directReplyLikelihood: number; eventSelectivity: number; preferredEventTypes: string[]; ignoredEventTypes: string[]; averageDelayMs: { min: number; max: number } }
  }
  disclosure: { defaultLevel: 'open' | 'moderate' | 'private'; privatePerson: boolean; topics: { family: 'open' | 'moderate' | 'private'; work: 'open' | 'moderate' | 'private'; relationships: 'open' | 'moderate' | 'private'; money: 'open' | 'moderate' | 'private'; location: 'open' | 'moderate' | 'private' } }
  streamerRelationship: { firstSeen?: string; familiarity: number; supportiveness: number; teasingLevel: number; favoriteStreamTypes: string[]; recurringReferences: string[]; rememberedStreamerMoments: string[] }
  relationships: Array<{ targetPersonaId: string; familiarity: number; sentiment: number; notes: string[] }>
}
interface PersonaMemoryItem {
  id: string; personaId: string; createdAt: number; type: string; summary: string; importance: number; tags: string[]
}
interface PersonaSummary {
  id: string; name: string; firstName: string; age?: number; city?: string; occupation?: string; quickSummary: string
  completeness: number; uniqueness: number; consistency: number; mostSimilarPersonaId?: string; mostSimilarUsername?: string
  similarityReasons: string[]; qualityWarnings: string[]
}
interface PersonaSimilarityPair {
  leftPersonaId: string; rightPersonaId: string; leftUsername?: string; rightUsername?: string
  similarity: number; reasons: string[]
}
interface PersonaGenderDistribution {
  male: number; female: number; malePercentage?: number; femalePercentage?: number; femaleUsernames?: string[]
}
interface PersonaIdentityChangeAudit {
  username: string; canonicalName: string; status: 'matched' | 'diverged' | 'missing'
  observed?: { firstName: string; preferredName?: string }
}
interface PersonaAuditReport {
  accountCount: number; personaCount: number; uniquePersonaCount: number; uniqueSpeechFingerprintCount: number
  genderDistribution?: PersonaGenderDistribution
  identityChanges?: PersonaIdentityChangeAudit[]
  countryOfBirthDistribution: Record<string, number>; currentCountryDistribution: Record<string, number>
  currentCityDistribution: Record<string, number>; occupationDistribution: Record<string, number>
  behaviorRanges: Record<string, { min: number; max: number }>; maximumSimilarity: number; averageSimilarity: number
  structureRanges?: Record<string, { min: number; max: number }>
  mostSimilarPairs: PersonaSimilarityPair[]; coherenceErrors: Array<{ message: string }>; coherenceWarnings: Array<{ message: string }>
  duplicateNicknameOrigins: string[]; duplicateRelativeNames: string[]; duplicateFavoriteExpressions: string[]; duplicateBiographyEvents: string[]; duplicateSpeechExamples: string[]
}
interface PersonaRegenerationPreview {
  personaId: string; username: string; current: Persona; proposed: Persona; previewHash: string; preservedManualOverrides: string[]; legacyManualReviewRequired: boolean
  changed?: boolean; reason?: string; requiresIndividualConfirmation?: boolean
}
interface BulkRegenerationPreview {
  items: PersonaRegenerationPreview[]
  audit: PersonaAuditReport
}
type ReactionRejectionReason =
  | 'duplicate_username' | 'unknown_candidate' | 'not_connected' | 'too_many_reactions'
  | 'empty_message' | 'control_value' | 'typographic_dash' | 'account_classification' | 'internal_metadata' | 'message_too_long' | 'account_cooldown'
  | 'account_busy' | 'global_rate_limit' | 'recent_duplicate' | 'invalid_item'
interface ReactionDecision {
  eventId: string
  timestamp: number
  selected: Array<{ username: string; message: string; delayMs: number }>
  rejected: Array<{ username: string; reason: ReactionRejectionReason }>
  candidateCount: number
  silentCandidateCount: number
}
interface ReactionTrace {
  eventId: string
  timestamp: number
  updatedAt: number
  eventType: string
  summary: string
  stage: 'EVENT_DETECTED' | 'CANDIDATES_PREPARED' | 'GEMINI_SELECTED' | 'POLICY_VALIDATED' | 'SCHEDULED' | 'SEND_SUCCEEDED' | 'SEND_FAILED' | 'STOPPED'
  outcome: 'PENDING' | 'SILENT' | 'SCHEDULED' | 'SENT' | 'PARTIAL' | 'FAILED' | 'STALE'
  eligibleBots: number
  eligibleUsernames: string[]
  candidateCount: number
  directMentions: string[]
  directTargetUnavailable: Array<{ username: string; reason: string }>
  geminiSelected: string[]
  policyAccepted: string[]
  policyRejected: Array<{ username: string; reason: ReactionRejectionReason }>
  scheduled: string[]
  sent: string[]
  sendFailed: Array<{ username: string; reason: string }>
  timing?: {
    detectedAt: number
    contextReadyAt?: number
    brainStartedAt?: number
    brainReadyAt?: number
    brainLatencyMs?: number
    brainApiLatencyMs?: number
    decisionAt?: number
    completedAt?: number
  }
  reactions?: Array<{
    username: string
    message: string
    artificialDelayMs: number
    status: 'ACCEPTED' | 'SCHEDULED' | 'SENT' | 'FAILED'
    selectedAt: number
    scheduledAt?: number
    sentAt?: number
    failedAt?: number
    failureReason?: string
  }>
  brainInteractionId?: string
  brainPreviousInteractionId?: string
  brainPreviousInteractionUsed?: boolean
  terminalReason?: string
}
type ReactionTraceMessage = NonNullable<ReactionTrace['reactions']>[number]

const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '')
const PERSONA_SIMILARITY_WARNING_THRESHOLD = 0.65
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
  streamBrain: {
    state: 'STOPPED', mediaState: 'STOPPED', geminiState: 'STOPPED',
    mediaConnected: false, geminiConnected: false, geminiStable: false,
    geminiSessionActive: false, geminiSessionReason: 'application_stopped',
  },
  geminiBrain: {
    state: 'OFFLINE', model: 'gemini-3.7-flash', thinkingLevel: 'low', interactions: 0, decisions: 0,
    silentDecisions: 0, generatedReactions: 0, averageLatencyMs: 0, rebuiltSessions: 0,
    rollovers: 0, contextTokens: 0, bootstrapChars: 0, bootstrapInputTokens: 0,
  },
  activeBots: 0, totalBots: 0, uptimeSeconds: 0,
})
const usage = reactive<Usage>({
  uptimeSeconds: 0, streamMinutes: 0, audioMinutes: 0, videoMinutes: 0,
  capturedAudioMinutes: 0, capturedVideoMinutes: 0, geminiAudioSentMinutes: 0, geminiVideoSentMinutes: 0,
  geminiReconnects: 0, geminiInputTokens: 0, geminiOutputTokens: 0, geminiToolCalls: 0,
  preparedReactionContexts: 0, reactionBatches: 0, emptyReactionBatches: 0,
  guardRejections: 0, eventsDetected: 0, generatedResponses: 0, sentResponses: 0, skippedResponses: 0,
  memoryToolCalls: 0, memoriesCreated: 0, memoriesMerged: 0, memoriesSuperseded: 0, memoryRetrievals: 0,
  perception: { sessionDurationMinutes: 0, audioSentMinutes: 0, videoSentMinutes: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, events: 0, estimatedCostUsd: 0, inputTokensByModality: emptyModalities(), outputTokensByModality: emptyModalities() },
  brain: { interactions: 0, decisions: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, averageLatencyMs: 0, estimatedCostUsd: 0 },
  totalAi: { estimatedCostUsd: 0, estimatedCostPerHourUsd: 0, eventsPerHour: 0, brainDecisionsPerHour: 0, messagesPerHour: 0 },
  drive: emptyDriveUsage(),
  driveBrain: { interactions: 0, decisions: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, averageLatencyMs: 0, estimatedCostUsd: 0 },
  driveCacheHitRatio: 0,
  currentStream: {
    active: false, durationMinutes: 0, capturedAudioMinutes: 0, capturedVideoMinutes: 0,
    geminiAudioSentMinutes: 0, geminiVideoSentMinutes: 0, geminiReconnects: 0,
    geminiInputTokens: 0, geminiOutputTokens: 0, sentResponses: 0,
    confirmedDeliveries: 0, undeliveredMessages: 0,
    perception: { sessionDurationMinutes: 0, audioSentMinutes: 0, videoSentMinutes: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, events: 0, estimatedCostUsd: 0, inputTokensByModality: emptyModalities(), outputTokensByModality: emptyModalities() },
    brain: { interactions: 0, decisions: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, averageLatencyMs: 0, estimatedCostUsd: 0 },
    totalAi: { estimatedCostUsd: 0, estimatedCostPerHourUsd: 0, eventsPerHour: 0, brainDecisionsPerHour: 0, messagesPerHour: 0 },
    drive: emptyDriveUsage(),
    driveBrain: { interactions: 0, decisions: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, averageLatencyMs: 0, estimatedCostUsd: 0 },
    driveCacheHitRatio: 0,
  },
})
const bots = ref<Bot[]>([])
const events = ref<StreamEvent[]>([])
const chat = ref<ChatMessage[]>([])
const personas = ref<Persona[]>([])
const personaSummaries = ref<PersonaSummary[]>([])
const personaAudit = ref<PersonaAuditReport | null>(null)
const selectedPersonaId = ref('')
const personaTab = ref<PersonaTab>('main')
const personaMemories = ref<PersonaMemoryItem[]>([])
const personaContextQuery = ref('как тебя зовут и где ты вырос?')
const personaContextPreview = ref<Record<string, unknown> | null>(null)
const personaBusy = ref(false)
const regenerationPreview = ref<PersonaRegenerationPreview | null>(null)
const bulkRegenerationPreview = ref<BulkRegenerationPreview | null>(null)
const decisions = ref<ReactionDecision[]>([])
const reactionTraces = ref<ReactionTrace[]>([])
const streamerMemories = ref<StreamerMemory[]>([])
const streamerMemoryStats = reactive<StreamerMemoryStats>({
  channel: '', total: 0, active: 0, resolved: 0, superseded: 0, expired: 0,
  duplicateMerges: 0, averageImportance: 0, averageConfidence: 0,
})
const memoryTypeFilter = ref<'all' | StreamerMemoryType>('all')
const memoryStatusFilter = ref<'all' | StreamerMemoryStatus>('all')
const memorySearch = ref('')
const memoryPreviewQuery = ref('')
const memoryContextPreview = ref<StreamerMemory[] | null>(null)
const memoryBusy = ref(false)
const editingStreamerMemoryId = ref<string | null>(null)
const streamerMemoryEditDraft = reactive({
  summary: '',
  entities: '',
  tags: '',
  importance: 0.5,
  confidence: 0.5,
  occurredAt: '',
  expiresAt: '',
  status: 'active' as Exclude<StreamerMemoryStatus, 'superseded'>,
})
const twitchOAuth = reactive<TwitchOAuthStatus>({ configured: false, accounts: [] })
const settings = reactive({ channel: '', streamContext: '', visionFps: 1, paused: false, memoryChannel: '' })
let socket: Socket | undefined
let pollTimer: number | undefined

const pages: Array<{ id: Page; label: string; glyph: string }> = [
  { id: 'overview', label: 'Обзор', glyph: '◫' },
  { id: 'bots', label: 'Боты', glyph: '◎' },
  { id: 'brain', label: 'Мозг стрима', glyph: '◇' },
  { id: 'memories', label: 'Память стримера', glyph: '◌' },
  { id: 'chat', label: 'Чат', glyph: '≡' },
  { id: 'settings', label: 'Настройки', glyph: '⚙' },
]

const personaTabs: Array<{ id: PersonaTab; label: string }> = [
  { id: 'main', label: 'Основное' }, { id: 'character', label: 'Характер' }, { id: 'family', label: 'Семья' },
  { id: 'biography', label: 'Биография' }, { id: 'interests', label: 'Интересы' }, { id: 'opinions', label: 'Мнения' },
  { id: 'speech', label: 'Речь' }, { id: 'twitch', label: 'Twitch' }, { id: 'memory', label: 'Память' },
  { id: 'quality', label: 'Качество' },
]
const selectedPersona = computed(() => personas.value.find((persona) => persona.id === selectedPersonaId.value))
const personaById = computed(() => new Map(personas.value.map((persona) => [persona.id, persona])))
const personaSummaryById = computed(() => new Map(personaSummaries.value.map((summary) => [summary.id, summary])))
const selectedPersonaSummary = computed(() => selectedPersona.value ? personaSummaryById.value.get(selectedPersona.value.id) : undefined)
const selectedPersonaTooSimilar = computed(() => (selectedPersonaSummary.value?.uniqueness ?? 100)
  <= Math.round((1 - PERSONA_SIMILARITY_WARNING_THRESHOLD) * 100))
const bulkChangedItems = computed(() => (bulkRegenerationPreview.value?.items ?? []).filter((item) => item.changed === true))
const bulkIndividualConfirmationItems = computed(() => bulkChangedItems.value
  .filter((item) => item.requiresIndividualConfirmation === true))
const bulkApplicableItems = computed(() => bulkChangedItems.value
  .filter((item) => item.requiresIndividualConfirmation !== true))
const bulkUnchangedItems = computed(() => (bulkRegenerationPreview.value?.items ?? []).filter((item) => item.changed === false))
const visibleStreamerMemories = computed(() => {
  const query = memorySearch.value.trim().toLowerCase()
  return streamerMemories.value.filter((memory) => {
    if (memoryTypeFilter.value !== 'all' && memory.type !== memoryTypeFilter.value) return false
    if (memoryStatusFilter.value !== 'all' && memory.status !== memoryStatusFilter.value) return false
    if (!query) return true
    return [memory.summary, ...memory.entities, ...memory.tags].join(' ').toLowerCase().includes(query)
  })
})

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
  { label: 'Сервер', tone: backendOnline.value ? 'ok' : 'error', status: backendOnline.value ? 'Работает' : 'Требует внимания', detail: backendOnline.value ? 'Интерфейс сервера доступен' : 'Нет соединения' },
  { label: 'Чат Twitch', tone: overview.twitchConnected ? 'ok' : 'error', status: overview.twitchConnected ? 'Работает' : 'Требует внимания', detail: `${overview.activeBots} из ${overview.totalBots} ботов в чате` },
  {
    label: 'Медиапоток',
    tone: overview.streamBrain.mediaConnected ? 'ok' : overview.streamBrain.mediaState === 'ERROR' ? 'error' : overview.streamBrain.mediaState === 'CONNECTING' ? 'pending' : 'idle',
    status: overview.streamBrain.mediaConnected ? 'Идёт стрим' : overview.streamBrain.mediaState === 'ERROR' ? 'Требует внимания' : overview.streamBrain.mediaState === 'CONNECTING' ? 'Поиск медиапотока…' : 'Стрим офлайн — норма',
    detail: overview.streamBrain.mediaConnected
      ? 'Аудио и выбранные видеокадры'
      : overview.streamBrain.mediaState === 'ERROR' && overview.streamBrain.lastError
        ? mediaErrorLabel(overview.streamBrain.lastError)
        : stateLabel(overview.streamBrain.mediaState),
  },
  {
    label: 'Gemini Live',
    tone: overview.streamBrain.geminiStable ? 'ok' : ['ERROR', 'FATAL_CONFIG_ERROR'].includes(overview.streamBrain.geminiState) ? 'error' : overview.streamBrain.geminiSessionActive ? 'pending' : 'idle',
    status: overview.streamBrain.geminiStable ? 'Стабильно' : ['ERROR', 'FATAL_CONFIG_ERROR'].includes(overview.streamBrain.geminiState) ? 'Требует внимания' : overview.streamBrain.geminiSessionActive ? 'Подключение…' : 'Физически остановлена',
    detail: overview.streamBrain.geminiStable
      ? 'Единая Live-сессия стабильна'
      : ['ERROR', 'FATAL_CONFIG_ERROR'].includes(overview.streamBrain.geminiState) && overview.streamBrain.lastError
        ? operatorErrorLabel(overview.streamBrain.lastError)
        : sessionReasonLabel(overview.streamBrain.geminiSessionReason),
  },
  {
    label: 'Gemini Brain',
    tone: ['READY', 'THINKING'].includes(overview.geminiBrain.state) ? 'ok' : overview.geminiBrain.state === 'ERROR' ? 'error' : 'idle',
    status: overview.geminiBrain.state === 'READY' ? 'Готов' : overview.geminiBrain.state === 'THINKING' ? 'Принимает решение…' : overview.geminiBrain.state === 'STARTING' ? 'Загружает контекст…' : overview.geminiBrain.state === 'ERROR' ? 'Требует внимания' : 'Остановлен вместе со стримом',
    detail: overview.geminiBrain.lastError
      ? operatorErrorLabel(overview.geminiBrain.lastError)
      : `${overview.geminiBrain.decisions} решений · среднее ${formatMilliseconds(overview.geminiBrain.averageLatencyMs)}`,
  },
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
    const [overviewData, botData, eventData, chatData, usageData, settingsData, personaData, personaSummaryData, personaAuditData, decisionData, traceData, oauthData, memoryData, memoryStatsData] = await Promise.all([
      api<Overview>('/api/overview'), api<Bot[]>('/api/bots'), api<StreamEvent[]>('/api/events?limit=100'),
      api<ChatMessage[]>('/api/chat'), api<Usage>('/api/usage'), api<Record<string, unknown>>('/api/settings'),
      api<Persona[]>('/api/personas'), api<PersonaSummary[]>('/api/persona-summaries'), api<PersonaAuditReport>('/api/persona-audit'),
      api<ReactionDecision[]>('/api/decisions'), api<ReactionTrace[]>('/api/reaction-traces'), api<TwitchOAuthStatus>('/api/twitch/oauth/status'),
      api<StreamerMemory[]>('/api/streamer-memories?limit=100'), api<StreamerMemoryStats>('/api/streamer-memories/stats'),
    ])
    Object.assign(overview, overviewData)
    Object.assign(usage, usageData)
    bots.value = botData
    events.value = eventData
    chat.value = chatData
    personas.value = personaData
    personaSummaries.value = personaSummaryData
    personaAudit.value = personaAuditData
    if (!personas.value.some((persona) => persona.id === selectedPersonaId.value)) {
      selectedPersonaId.value = personas.value[0]?.id || ''
    }
    if (selectedPersona.value) preparePersonaForEditing(selectedPersona.value)
    decisions.value = decisionData
    reactionTraces.value = traceData
    streamerMemories.value = memoryData
    Object.assign(streamerMemoryStats, memoryStatsData)
    Object.assign(twitchOAuth, oauthData)
    settings.channel = String(settingsData.channel || '')
    settings.streamContext = String(settingsData.streamContext || '')
    settings.visionFps = Number(settingsData.visionFps || 1)
    settings.paused = settingsData.paused === true
    settings.memoryChannel = String(settingsData.memoryChannel || '')
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
  socket.on('reaction-traces:init', (value: ReactionTrace[]) => { reactionTraces.value = value })
  socket.on('reaction-trace', (value: ReactionTrace) => {
    reactionTraces.value = [value, ...reactionTraces.value.filter((item) => item.eventId !== value.eventId)].slice(0, 100)
  })
  socket.on('streamer-memories:init', (value: StreamerMemory[]) => { streamerMemories.value = value })
  socket.on('streamer-memory', (value: StreamerMemory) => {
    streamerMemories.value = [value, ...streamerMemories.value.filter((memory) => memory.id !== value.id)]
  })
  socket.on('streamer-memory-stats', (value: StreamerMemoryStats) => Object.assign(streamerMemoryStats, value))
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

interface DeliveryCheckAccount {
  username: string; index: number; message: string
  skipped?: 'not_enabled' | 'not_connected'
  submitted: boolean; submitFailureReason?: string
  delivered: boolean; rejectionReason?: string; selfEchoUnreliable?: boolean
}
interface DeliveryCheckReport {
  channel: string; reader?: string
  totalAccounts: number; delivered: number; notDelivered: number
  observedChatMessages: number; detectionVerified: boolean; detectionWarning?: string
  accounts: DeliveryCheckAccount[]
}
const deliveryCheck = ref<DeliveryCheckReport | undefined>()
const deliveryCheckRunning = ref(false)

async function runDeliveryCheck(): Promise<void> {
  deliveryCheckRunning.value = true
  errorMessage.value = ''
  try {
    // Runs for a while by design: one account every couple of seconds, then a window for echoes.
    deliveryCheck.value = await api<DeliveryCheckReport>('/api/diagnostics/delivery-check', { method: 'POST' })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    deliveryCheckRunning.value = false
  }
}

function deliveryCheckStatus(account: DeliveryCheckAccount): string {
  if (account.skipped === 'not_enabled') return 'выключен'
  if (account.skipped === 'not_connected') return 'нет в чате'
  if (account.rejectionReason) return reactionTraceReasonLabel(account.rejectionReason)
  if (!account.submitted) return account.submitFailureReason ?? 'не отправлено'
  if (account.delivered) return account.selfEchoUnreliable ? 'дошло (не показатель — это ридер)' : 'дошло'
  return 'Twitch не показал'
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

async function refreshStreamerMemories(): Promise<void> {
  try {
    const [memories, stats] = await Promise.all([
      api<StreamerMemory[]>('/api/streamer-memories?limit=100'),
      api<StreamerMemoryStats>('/api/streamer-memories/stats'),
    ])
    streamerMemories.value = memories
    Object.assign(streamerMemoryStats, stats)
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
}

function startStreamerMemoryEdit(memory: StreamerMemory): void {
  editingStreamerMemoryId.value = memory.id
  streamerMemoryEditDraft.summary = memory.summary
  streamerMemoryEditDraft.entities = memory.entities.join(', ')
  streamerMemoryEditDraft.tags = memory.tags.join(', ')
  streamerMemoryEditDraft.importance = memory.importance
  streamerMemoryEditDraft.confidence = memory.confidence
  streamerMemoryEditDraft.occurredAt = toLocalDateTimeInput(memory.occurredAt)
  streamerMemoryEditDraft.expiresAt = toLocalDateTimeInput(memory.expiresAt)
  streamerMemoryEditDraft.status = memory.status === 'superseded' ? 'active' : memory.status
}

function cancelStreamerMemoryEdit(): void {
  editingStreamerMemoryId.value = null
}

async function saveStreamerMemoryEdit(): Promise<void> {
  const id = editingStreamerMemoryId.value
  if (!id || !streamerMemoryEditDraft.summary.trim()) return
  try {
    memoryBusy.value = true
    const saved = await api<StreamerMemory>(`/api/streamer-memories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        summary: streamerMemoryEditDraft.summary.trim(),
        entities: splitMemoryValues(streamerMemoryEditDraft.entities),
        tags: splitMemoryValues(streamerMemoryEditDraft.tags),
        importance: clampUnitInterval(streamerMemoryEditDraft.importance),
        confidence: clampUnitInterval(streamerMemoryEditDraft.confidence),
        occurredAt: parseLocalDateTimeInput(streamerMemoryEditDraft.occurredAt),
        expiresAt: parseLocalDateTimeInput(streamerMemoryEditDraft.expiresAt),
        status: streamerMemoryEditDraft.status,
      }),
    })
    upsertStreamerMemory(saved)
    editingStreamerMemoryId.value = null
    await refreshStreamerMemoryStats()
    saveMessage.value = 'Запись памяти обновлена'
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { memoryBusy.value = false }
}

async function setStreamerMemoryStatus(memory: StreamerMemory, status: Exclude<StreamerMemoryStatus, 'superseded'>): Promise<void> {
  if (memory.status === status) return
  try {
    memoryBusy.value = true
    const saved = await api<StreamerMemory>(`/api/streamer-memories/${encodeURIComponent(memory.id)}`, {
      method: 'PATCH', body: JSON.stringify({ status }),
    })
    upsertStreamerMemory(saved)
    await refreshStreamerMemoryStats()
    saveMessage.value = status === 'resolved' ? 'Запись помечена как завершённая' : status === 'expired'
      ? 'Запись помечена как устаревшая' : 'Запись снова активна'
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { memoryBusy.value = false }
}

async function deleteStreamerMemory(memory: StreamerMemory): Promise<void> {
  if (!window.confirm(`Удалить запись «${memory.summary}»? Это действие нельзя отменить.`)) return
  try {
    memoryBusy.value = true
    await api(`/api/streamer-memories/${encodeURIComponent(memory.id)}`, { method: 'DELETE' })
    streamerMemories.value = streamerMemories.value.filter((candidate) => candidate.id !== memory.id)
    if (editingStreamerMemoryId.value === memory.id) editingStreamerMemoryId.value = null
    await refreshStreamerMemoryStats()
    saveMessage.value = 'Запись памяти удалена'
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { memoryBusy.value = false }
}

async function previewStreamerMemoryContext(): Promise<void> {
  const query = memoryPreviewQuery.value.trim()
  if (!query) return
  try {
    memoryBusy.value = true
    memoryContextPreview.value = await api<StreamerMemory[]>('/api/streamer-memories/context-preview', {
      method: 'POST', body: JSON.stringify({ query, limit: 8 }),
    })
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { memoryBusy.value = false }
}

async function refreshStreamerMemoryStats(): Promise<void> {
  const stats = await api<StreamerMemoryStats>('/api/streamer-memories/stats')
  Object.assign(streamerMemoryStats, stats)
}

function upsertStreamerMemory(memory: StreamerMemory): void {
  streamerMemories.value = [memory, ...streamerMemories.value.filter((candidate) => candidate.id !== memory.id)]
}

async function refreshPersonaSummaries(): Promise<void> {
  const [summaries, audit] = await Promise.all([
    api<PersonaSummary[]>('/api/persona-summaries'),
    api<PersonaAuditReport>('/api/persona-audit'),
  ])
  personaSummaries.value = summaries
  personaAudit.value = audit
}

async function previewSelectedRegeneration(): Promise<void> {
  const persona = selectedPersona.value
  if (!persona || persona.source !== 'generated') return
  try {
    personaBusy.value = true
    bulkRegenerationPreview.value = null
    regenerationPreview.value = await api<PersonaRegenerationPreview>(`/api/personas/${encodeURIComponent(persona.id)}/regeneration-preview`, { method: 'POST' })
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { personaBusy.value = false }
}

async function applySelectedRegeneration(): Promise<void> {
  const preview = regenerationPreview.value
  if (!preview) return
  if (preview.changed === false) {
    regenerationPreview.value = null
    saveMessage.value = 'Проверка завершена: обновление не требуется, запись не изменена'
    return
  }
  try {
    personaBusy.value = true
    const saved = await api<Persona>(`/api/personas/${encodeURIComponent(preview.personaId)}/regenerate`, {
      method: 'POST', body: JSON.stringify({ previewHash: preview.previewHash }),
    })
    replacePersona(saved)
    regenerationPreview.value = null
    bulkRegenerationPreview.value = null
    await refreshPersonaSummaries()
    saveMessage.value = `Личность «${saved.name}» пересоздана; ручные поля сохранены`
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { personaBusy.value = false }
}

async function previewBulkRegeneration(): Promise<void> {
  try {
    personaBusy.value = true
    regenerationPreview.value = null
    bulkRegenerationPreview.value = await api<BulkRegenerationPreview>('/api/persona-regeneration/preview', { method: 'POST' })
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { personaBusy.value = false }
}

async function applyBulkRegeneration(): Promise<void> {
  const preview = bulkRegenerationPreview.value
  if (!preview) return
  const applicable = bulkApplicableItems.value
  if (!applicable.length) {
    saveMessage.value = 'Нет безопасных изменений для массового применения. Профили с ручными изменениями подтвердите отдельно.'
    return
  }
  try {
    personaBusy.value = true
    const result = await api<{ personas: Persona[]; audit: PersonaAuditReport }>('/api/persona-regeneration/apply', {
      method: 'POST',
      body: JSON.stringify({ previews: applicable.map((item) => ({ personaId: item.personaId, previewHash: item.previewHash })) }),
    })
    for (const persona of result.personas) replacePersona(persona)
    personaAudit.value = result.audit
    bulkRegenerationPreview.value = null
    await refreshPersonaSummaries()
    saveMessage.value = `Пересоздано ${result.personas.length} личностей без чувствительных ручных изменений; резервные копии сохранены`
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) }
  finally { personaBusy.value = false }
}

function personaPreviewText(persona: Persona): string {
  const identity = persona.identity
  const preferred = identity.preferredName && identity.preferredName !== identity.firstName ? ` (${identity.preferredName})` : ''
  const birthplace = identity.birthplace ? `${identity.birthplace.city}, ${identity.birthplace.country}` : 'место рождения не указано'
  const current = identity.currentLocation ? `${identity.currentLocation.city}, ${identity.currentLocation.country}` : 'текущее место не указано'
  return `${identity.firstName}${preferred} · ${birthplace} → ${current} · ${identity.occupation || 'работа не указана'} · ${persona.character.summary}`
}

function personaFullPreview(persona: Persona): string {
  const place = (value?: { country: string; city: string }) => value ? `${value.city}, ${value.country}` : 'не указано'
  const list = (values: string[]) => values.join(', ') || 'не указано'
  return [
    `Имя: ${persona.identity.firstName}${persona.identity.preferredName ? `; обращаться: ${persona.identity.preferredName}` : ''}`,
    `Ник Twitch: ${persona.identity.nickname || 'не указан'}`,
    `История ника: ${persona.identity.nicknameOrigin || 'не указана'}`,
    `Дата рождения: ${persona.identity.birthDate || 'не указана'}`,
    `Родился: ${place(persona.identity.birthplace)}; вырос: ${place(persona.identity.grewUpIn)}; живёт: ${place(persona.identity.currentLocation)}`,
    `Работа: ${persona.identity.occupation || 'не указана'}; образование: ${persona.identity.education || 'не указано'}; отношения: ${persona.identity.relationshipStatus || 'не указано'}`,
    `Языки: ${list(persona.identity.languages.map((item) => `${item.language} (${item.level})`))}`,
    `Описание: ${persona.description}`,
    `Семейный фон: ${persona.familyBackground || 'не указан'}`,
    `Семья:\n${persona.family.map((relative) => `• ${relativeKindLabel(relative.relation)}: ${relative.name}; ${relative.occupation || 'работа не указана'}; ${relative.city || 'город не указан'}; ${relative.relationshipDescription || ''}; ${list(relative.facts)}`).join('\n') || 'не указана'}`,
    `Жизненные события:\n${persona.timeline.map((event) => `• ${event.year ?? 'год?'} — ${event.title}: ${event.description}`).join('\n') || 'не указаны'}`,
    `Факты:\n${persona.facts.map((fact) => `• [${factCategoryLabel(fact.category)}] ${fact.fact}`).join('\n') || 'не указаны'}`,
    `Мнения:\n${persona.opinions.map((opinion) => `• ${opinion.topic}: ${opinion.stance}`).join('\n') || 'не указаны'}`,
    `Знает глубоко: ${list(persona.knowledge.expertise)}\nЗнакомые темы: ${list(persona.knowledge.familiarTopics)}\nСлабые темы: ${list(persona.knowledge.weakTopics)}\nНе знает: ${list(persona.knowledge.unknownTopics)}`,
    `Характер: ${persona.character.summary}\nЧерты: ${list(persona.character.traits)}\nСильные стороны: ${list(persona.character.strengths)}\nНедостатки: ${list(persona.character.flaws)}\nЮмор: ${persona.character.humor}\nВ конфликте: ${persona.character.conflictStyle}`,
    `Интересы — игры: ${list(persona.interests.games)}; музыка: ${list(persona.interests.music)}; еда: ${list(persona.interests.food)}; другое: ${list(persona.interests.other)}`,
    `Речь — в среднем ${persona.speech.averageMessageWords} слов; начала: ${list(persona.speech.openingPatterns)}; окончания: ${list(persona.speech.endingPatterns)}; любимые выражения: ${list(persona.speech.favoriteExpressions)}; смех: ${list(persona.speech.laughStyles)}; пунктуация: ${persona.speech.punctuationStyle}; регистр: ${persona.speech.capitalizationStyle}; примеры: ${list(persona.speech.messageExamples)}`,
    `Поведение — вероятность реакции ${persona.behavior.reactionProbability}; избирательность ${persona.behavior.activity.eventSelectivity}; прямой ответ ${persona.behavior.activity.directReplyLikelihood}; частота ${activityFrequencyLabel(persona.behavior.activity.chatFrequency)}; предпочитает: ${list(persona.behavior.activity.preferredEventTypes)}; игнорирует: ${list(persona.behavior.activity.ignoredEventTypes)}; инструкции: ${persona.behavior.styleInstructions}`,
    `Границы личного — общая: ${disclosureLevelLabel(persona.disclosure.defaultLevel)}; семья: ${disclosureLevelLabel(persona.disclosure.topics.family)}; работа: ${disclosureLevelLabel(persona.disclosure.topics.work)}; отношения: ${disclosureLevelLabel(persona.disclosure.topics.relationships)}; деньги: ${disclosureLevelLabel(persona.disclosure.topics.money)}; местоположение: ${disclosureLevelLabel(persona.disclosure.topics.location)}`,
    `Twitch — впервые: ${persona.streamerRelationship.firstSeen || 'не указано'}; знакомство ${persona.streamerRelationship.familiarity}; поддержка ${persona.streamerRelationship.supportiveness}; поддразнивание ${persona.streamerRelationship.teasingLevel}; любимые эфиры: ${list(persona.streamerRelationship.favoriteStreamTypes)}; повторяющиеся отсылки: ${list(persona.streamerRelationship.recurringReferences)}`,
    `Точная техническая копия всех полей канона:\n${JSON.stringify(persona, null, 2)}`,
  ].join('\n\n')
}

function openBulkPersonaPreview(item: PersonaRegenerationPreview): void {
  regenerationPreview.value = item
}

function relativeKindLabel(value: string): string {
  return ({ mother: 'мать', father: 'отец', brother: 'брат', sister: 'сестра', uncle: 'дядя', aunt: 'тётя', grandmother: 'бабушка', grandfather: 'дедушка', cousin: 'двоюродный родственник', daughter: 'дочь', son: 'сын', other: 'другой родственник' } as Record<string, string>)[value] || value
}

function disclosureLevelLabel(value: string): string {
  return ({ open: 'открыто', moderate: 'умеренно', private: 'приватно' } as Record<string, string>)[value] || value
}

function activityFrequencyLabel(value: string): string {
  return ({ 'very-low': 'очень редко', low: 'редко', medium: 'средне', high: 'активно' } as Record<string, string>)[value] || value
}

function sourceLabelForPersona(persona: Persona): string {
  return persona.source === 'generated' ? `автогенерация v${persona.generationVersion}` : 'создана вручную'
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
  persona.spokenAliases ||= []
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

function personaMatchesAccount(persona: Persona, username: string): boolean {
  const normalized = username.trim().toLowerCase()
  if (persona.identity.nickname?.trim().toLowerCase() !== normalized) return false
  return persona.source === 'manual' || persona.generatedFromUsername === normalized
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
function emptyModalities(): TokenModalityUsage {
  return { text: 0, audio: 0, video: 0, other: 0 }
}
function emptyDriveUsage(): DriveUsageCounters {
  return {
    ticks: 0, eligibleTicks: 0, localSkips: 0, brainCalls: 0, brainCallsBlockedByHourlyLimit: 0,
    silentDecisions: 0, messages: 0, messagesBlockedByHourlyLimit: 0,
    cancelledForExternalEvent: 0, cancelledForCooldown: 0, cancelledForNoCandidates: 0,
  }
}
function formatSessionDuration(startedAt?: number): string {
  return startedAt ? formatDuration(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))) : '—'
}
function stateClass(state: ConnectionState): string { return state.toLowerCase() }
function stateLabel(state: ConnectionState | BrainState | BrainStatus['mediaState'] | GeminiBrainStatus['state']): string {
  return ({
    DISCONNECTED: 'Отключено', STOPPED: 'Остановлено', OFFLINE: 'Стрим офлайн',
    CONNECTING: 'Подключение', CONNECTED: 'Подключено', STREAMING: 'Медиапоток идёт',
    STARTING: 'Запуск', READY: 'Готов', THINKING: 'Принимает решение',
    ERROR: 'Ошибка', FATAL_CONFIG_ERROR: 'Фатальная ошибка конфигурации', DISABLED: 'Выключено',
  } as Record<string, string>)[state] || state
}
function sessionReasonLabel(reason: BrainStatus['geminiSessionReason']): string {
  return ({
    twitch_live: 'Медиапоток подтверждает прямой эфир', twitch_offline: 'Стрим офлайн',
    media_connecting: 'Ожидание медиапотока', media_error: 'Ошибка медиапотока',
    fatal_error: 'Переподключения остановлены', application_stopped: 'Приложение остановлено', disabled: 'Gemini выключена',
  })[reason]
}
function operatorErrorLabel(message?: string): string {
  if (!message) return 'Техническая причина не указана.'
  const normalized = message.toLowerCase()
  if (/no playable streams found|stream.*offline|not live/u.test(normalized)) return 'Трансляция сейчас офлайн.'
  if (/api.?key|invalid key|authentication|unauthorized|\b401\b/u.test(normalized)) return 'Gemini отклонила ключ доступа. Проверьте ключ на Railway.'
  if (/permission denied|forbidden|\b403\b/u.test(normalized)) return 'У ключа Gemini недостаточно прав для этой модели.'
  // Depleted prepaid credits and a per-minute rate limit both arrive as 429, and only one of them
  // recovers on its own. Told to wait for a limit that never lifts, the operator waits.
  if (/prepayment|credits are depleted|billing|insufficient|balance/u.test(normalized)) {
    return 'У Gemini закончились предоплаченные кредиты. Само не восстановится — пополните баланс в AI Studio.'
  }
  if (/quota|resource exhausted|rate.?limit|\b429\b/u.test(normalized)) return 'Достигнут лимит Gemini. Подключение возобновится после восстановления лимита.'
  if (/\b1007\b|invalid argument|malformed|protocol/u.test(normalized)) return 'Gemini отклонила формат данных или настройки сессии.'
  if (/timed? ?out|timeout/u.test(normalized)) return 'Gemini не ответила вовремя. Система попробует переподключиться.'
  if (/network|websocket|socket|econn|fetch failed|dns|connection/u.test(normalized)) return 'Соединение с Gemini прервалось. Система попробует переподключиться.'
  return 'Произошла техническая ошибка Gemini. Подробность доступна ниже.'
}
function mediaErrorLabel(message?: string): string {
  if (!message) return 'Не удалось получить медиапоток.'
  const normalized = message.toLowerCase()
  if (/no playable streams found|stream.*offline|not live/u.test(normalized)) return 'Трансляция сейчас офлайн.'
  if (/ffmpeg|decoder|codec|invalid data/u.test(normalized)) return 'Не удалось декодировать аудио или видео трансляции.'
  if (/streamlink/u.test(normalized)) return 'Streamlink не смог открыть медиапоток Twitch.'
  if (/timed? ?out|timeout|network|econn|fetch failed|dns|connection/u.test(normalized)) return 'Соединение с медиапотоком Twitch прервалось.'
  return 'Произошла техническая ошибка медиапотока.'
}
function closeReasonLabel(code?: number, reason?: string): string {
  const labels: Record<number, string> = {
    1000: 'Соединение штатно закрыто.',
    1001: 'Сервер завершил соединение или перезапускается.',
    1006: 'Соединение неожиданно оборвалось.',
    1007: 'Gemini отклонила формат переданных данных.',
    1008: 'Gemini отклонила запрос по правилам сервиса.',
    1011: 'На стороне Gemini произошла внутренняя ошибка.',
    1012: 'Сервис Gemini перезапускается.',
    1013: 'Сервис Gemini временно перегружен.',
  }
  return code !== undefined && labels[code] ? labels[code] : reason ? operatorErrorLabel(reason) : 'Причина отсутствует.'
}
function reactionTraceStageLabel(stage: ReactionTrace['stage']): string {
  return ({
    EVENT_DETECTED: 'событие найдено', CANDIDATES_PREPARED: 'кандидаты подготовлены',
    GEMINI_SELECTED: 'Brain выбрал реакцию', POLICY_VALIDATED: 'защита проверила', SCHEDULED: 'передано на отправку',
    SEND_SUCCEEDED: 'отправлено', SEND_FAILED: 'ошибка отправки', STOPPED: 'цепочка остановлена',
  })[stage]
}
function reactionTraceOutcomeLabel(outcome: ReactionTrace['outcome']): string {
  return ({
    PENDING: 'в процессе', SILENT: 'осознанная тишина', SCHEDULED: 'отправляется сейчас',
    SENT: 'отправлено в Twitch', PARTIAL: 'частично отправлено', FAILED: 'не отправлено', STALE: 'контекст устарел',
  })[outcome]
}
function reactionTraceMessageStatusLabel(status: ReactionTraceMessage['status']): string {
  return ({
    ACCEPTED: 'принято защитой', SCHEDULED: 'ожидает отправки', SENT: 'отправлено', FAILED: 'не отправлено',
    UNDELIVERED: 'Twitch не показал',
  })[status]
}
// Perception can hold a healthy-looking session while returning nothing at all; production ran
// 5.8 minutes that way. The watchdog remakes the session at two minutes, so anything approaching
// that is worth seeing on screen rather than only in the logs.
const perceptionSilenceClass = computed(() => {
  const silent = overview.streamBrain.msSincePerceptionOutput
  if (silent === undefined) return ''
  if (silent >= 90_000) return 'silence-critical'
  return silent >= 45_000 ? 'silence-warning' : ''
})

function formatMilliseconds(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const milliseconds = Math.max(0, value)
  return milliseconds < 1000
    ? `${Math.round(milliseconds)} мс`
    : `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} с`
}
function elapsed(start?: number, end?: number): string {
  return start === undefined || end === undefined ? '—' : formatMilliseconds(end - start)
}
function traceDetectedAt(trace: ReactionTrace): number {
  return trace.timing?.detectedAt ?? trace.timestamp
}
function traceContextDuration(trace: ReactionTrace): string {
  return elapsed(traceDetectedAt(trace), trace.timing?.contextReadyAt)
}
function traceGeminiDuration(trace: ReactionTrace): string {
  // Prefer the model call on its own. The older brainLatencyMs counts from when the event was
  // observed, so on a backed-up queue it reported the wait as if the model had been slow.
  if (trace.timing?.brainApiLatencyMs !== undefined) return formatMilliseconds(trace.timing.brainApiLatencyMs)
  return trace.timing?.brainLatencyMs !== undefined
    ? formatMilliseconds(trace.timing.brainLatencyMs)
    : elapsed(trace.timing?.brainStartedAt ?? trace.timing?.contextReadyAt ?? traceDetectedAt(trace), trace.timing?.brainReadyAt ?? trace.timing?.decisionAt)
}
function traceQueueWait(trace: ReactionTrace): string {
  const total = trace.timing?.brainLatencyMs
  const api = trace.timing?.brainApiLatencyMs
  return total !== undefined && api !== undefined ? formatMilliseconds(Math.max(0, total - api)) : '—'
}
function traceReactionEnd(reaction: ReactionTraceMessage): number | undefined {
  return reaction.sentAt ?? reaction.failedAt
}
function traceDeliveryDuration(reaction: ReactionTraceMessage): string {
  return elapsed(reaction.selectedAt, traceReactionEnd(reaction))
}
function traceTotalDuration(trace: ReactionTrace, reaction: ReactionTraceMessage): string {
  return elapsed(traceDetectedAt(trace), traceReactionEnd(reaction))
}
function reactionTraceReasonLabel(reason?: string): string {
  if (!reason) return 'Решение ещё формируется.'
  return ({
    gemini_selected_silence: 'Brain решил, что для этого момента естественнее промолчать.',
    reaction_context_stale: 'Решение Brain пришло после закрытия контекста события.',
    reaction_context_expired_before_gemini_batch: 'Brain не успел вернуть решение до истечения контекста.',
    no_available_candidate: 'Названный аккаунт сейчас недоступен — отвечать некому, Brain не вызывался.',
    msg_followersonly: 'Twitch отклонил: включён режим «только для фолловеров», аккаунт не подписан на канал.',
    msg_followersonly_followed: 'Twitch отклонил: аккаунт подписан на канал недостаточно давно.',
    msg_followersonly_zero: 'Twitch отклонил: включён режим «только для фолловеров».',
    msg_subsonly: 'Twitch отклонил: чат только для подписчиков.',
    msg_emoteonly: 'Twitch отклонил: чат в режиме «только эмоции».',
    msg_slowmode: 'Twitch отклонил: медленный режим, аккаунт пишет слишком часто.',
    msg_r9k: 'Twitch отклонил: режим уникальных сообщений, такое уже отправляли.',
    msg_duplicate: 'Twitch отклонил: точно такое же сообщение уже отправлялось.',
    msg_ratelimit: 'Twitch отклонил: превышен лимит частоты отправки.',
    msg_banned: 'Twitch отклонил: аккаунт забанен на канале.',
    msg_timedout: 'Twitch отклонил: аккаунт в таймауте на канале.',
    msg_rejected: 'Twitch отклонил: сообщение задержано AutoMod.',
    msg_rejected_mandatory: 'Twitch отклонил: сообщение заблокировано AutoMod.',
    msg_verified_email: 'Twitch отклонил: на канале нужен подтверждённый email.',
    msg_requires_verified_phone_number: 'Twitch отклонил: на канале нужен подтверждённый номер телефона.',
    msg_channel_suspended: 'Twitch отклонил: канал заблокирован.',
    msg_suspended: 'Twitch отклонил: аккаунт заблокирован.',
    msg_channel_blocked: 'Twitch отклонил: аккаунту закрыт доступ к каналу.',
    msg_bad_characters: 'Twitch отклонил: недопустимые символы в сообщении.',
    gemini_disconnected_before_reaction_batch: 'Brain остановился до того, как вернул решение.',
    all_selected_reactions_rejected: 'Все выбранные сообщения остановила защитная проверка.',
    coordinator_stopped: 'Сервис остановился до отправки сообщения.',
    account_unavailable_at_send: 'Аккаунт потерял соединение перед отправкой.',
    persona_reassigned: 'Личность аккаунта изменилась до отправки.',
    recent_duplicate_at_send: 'Перед отправкой обнаружилось недавнее похожее сообщение.',
    account_unavailable: 'Аккаунт недоступен для отправки.',
    local_rate_limit: 'Сообщение остановил локальный лимит Twitch.',
    twitch_send_failed: 'Не удалось передать сообщение в соединение Twitch.',
    twitch_sender_returned_false: 'Сервис отправки вернул ошибку.',
    some_reactions_failed: 'Часть выбранных сообщений отправилась, а часть остановилась с ошибкой.',
  } as Record<string, string>)[reason] || 'Цепочка остановилась по неизвестной технической причине.'
}
function directTargetReasonLabel(reason: string): string {
  return ({
    unknown_bot: 'аккаунт не найден', disabled: 'аккаунт выключен',
    not_connected: 'аккаунт не подключён', chat_disconnected: 'нет соединения с чатом',
  } as Record<string, string>)[reason] || 'адресат недоступен'
}
function diagnosticOperationLabel(operation?: string): string {
  if (!operation) return '—'
  if (operation.startsWith('tool_response:')) {
    return `ответ инструмента: ${diagnosticToolLabel(operation.slice('tool_response:'.length))}`
  }
  return ({
    connect: 'подключение', audio: 'аудио', video: 'видеокадр',
    context_update: 'минимальный контекст восприятия',
  } as Record<string, string>)[operation] || 'неизвестная операция'
}
function diagnosticToolLabel(tool?: string): string {
  if (!tool) return '—'
  return ({
    emit_stream_event: 'значимое событие стрима',
  } as Record<string, string>)[tool] || 'неизвестный инструмент'
}
function kindLabel(kind: ChatMessage['kind']): string {
  return ({ viewer: 'зритель', bot: 'бот', system: 'система' })[kind]
}
function eventTypeLabel(type: string): string {
  return ({ speech: 'речь', gameplay: 'игровой момент', reaction: 'реакция', funny: 'смешной момент', fail: 'ошибка', win: 'победа', loss: 'поражение', surprise: 'неожиданность', conversation: 'разговор', greeting: 'приветствие', visual: 'визуальное событие', question: 'вопрос', direct_mention: 'прямое обращение', irl: 'вживую', food: 'еда', place: 'место', purchase: 'покупка', travel: 'дорога', stranger: 'посторонний', mishap: 'неловкий момент', other: 'другое' } as Record<string, string>)[type] || type
}
function sourceLabel(source: StreamEvent['source']): string {
  return ({ 'gemini-live': 'Gemini Live', chat: 'чат', 'fallback-transcription': 'резервная транскрипция' })[source]
}
function streamerMemoryTypeLabel(type: StreamerMemoryType): string {
  return ({
    fact: 'факт', preference: 'предпочтение', person: 'человек', relationship: 'отношение',
    plan: 'план', promise: 'обещание', result: 'результат', place: 'место', trip: 'поездка',
    running_joke: 'внутренняя шутка', important_event: 'важное событие',
    recurring_context: 'повторяющийся контекст', other: 'другое',
  } as Record<StreamerMemoryType, string>)[type]
}
function streamerMemoryStatusLabel(status: StreamerMemoryStatus): string {
  return ({ active: 'актуальна', resolved: 'завершена', superseded: 'заменена', expired: 'устарела' } as Record<StreamerMemoryStatus, string>)[status]
}
function splitMemoryValues(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))].slice(0, 16)
}
function clampUnitInterval(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}
function toLocalDateTimeInput(timestamp?: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}
function parseLocalDateTimeInput(value: string): number | null {
  if (!value) return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}
function shortMemoryId(id?: string): string {
  return id ? `${id.slice(0, 8)}…` : '—'
}
function memoryTypeLabel(type: string): string {
  return ({ stream_event: 'событие стрима', conversation: 'разговор', viewer: 'зритель', streamer: 'стример', self: 'собственная реплика', relationship: 'отношения' } as Record<string, string>)[type] || type
}
function factCategoryLabel(category: string): string {
  return ({ family: 'семья', childhood: 'детство', education: 'учёба', work: 'работа', gaming: 'игры', food: 'еда', music: 'музыка', travel: 'поездки', technology: 'техника', automotive: 'автомобили', animals: 'животные', art: 'искусство', biology: 'биология', law: 'право', money: 'деньги', sport: 'спорт', imperfection: 'недостаток', relationships: 'отношения', habit: 'привычка', preference: 'предпочтение', story: 'история', other: 'другое' } as Record<string, string>)[category] || category
}
function rejectionLabel(reason: ReactionRejectionReason): string {
  const labels: Record<ReactionRejectionReason, string> = {
    duplicate_username: 'аккаунт указан дважды', unknown_candidate: 'неизвестный аккаунт',
    not_connected: 'нет соединения', too_many_reactions: 'слишком много реакций',
    empty_message: 'пустое сообщение', control_value: 'служебное значение', typographic_dash: 'длинное тире', account_classification: 'вопрос о природе аккаунта', internal_metadata: 'внутренние служебные данные',
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
          <button class="text-button" type="button" @click="settings.paused = !settings.paused; saveSettings()">{{ settings.paused ? 'Запустить' : 'Остановить всё' }}</button>
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
              <div><span :class="['status-light', item.tone]"></span><span>{{ item.label }}</span></div>
              <strong>{{ item.status }}</strong><small>{{ item.detail }}</small>
            </article>
          </section>
          <section class="metric-strip">
            <div><span>Время работы</span><strong>{{ formatDuration(usage.uptimeSeconds) }}</strong></div>
            <div><span>Медиапоток захвачен</span><strong>{{ usage.streamMinutes.toFixed(1) }} мин</strong></div>
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
          <section class="panel">
            <div class="panel-heading">
              <div><p class="eyebrow">ДИАГНОСТИКА</p><h3>Проверка доставки</h3></div>
            <button class="text-button" type="button" :disabled="deliveryCheckRunning" @click="runDeliveryCheck()">
                {{ deliveryCheckRunning ? 'Идёт проверка…' : 'Проверить все аккаунты' }}
              </button>
            </div>
            <p class="muted">Каждый аккаунт пишет в чат свой номер с паузой в 2 секунды. Twitch не подтверждает отправку, поэтому доставка определяется по тому, вернулось ли сообщение обратно через читающий аккаунт. Проверка идёт примерно по 2 секунды на аккаунт плюс окно ожидания.</p>
            <template v-if="deliveryCheck">
              <p v-if="!deliveryCheck.detectionVerified" class="notice error">{{ deliveryCheck.detectionWarning }}</p>
              <div class="metric-strip">
                <div><span>Канал</span><strong>{{ deliveryCheck.channel || '—' }}</strong></div>
                <div><span>Дошло</span><strong>{{ deliveryCheck.delivered }} / {{ deliveryCheck.totalAccounts }}</strong></div>
                <div><span>Twitch не показал</span><strong>{{ deliveryCheck.notDelivered }}</strong></div>
                <div><span>Читающий аккаунт</span><strong>{{ deliveryCheck.reader || '—' }}</strong></div>
                <div><span>Видел сообщений в чате</span><strong>{{ deliveryCheck.observedChatMessages }}</strong></div>
              </div>
              <div class="bulk-preview-list">
                <article v-for="item in deliveryCheck.accounts" :key="item.username">
                  <strong>{{ item.index }}. {{ item.username }}</strong>
                  <span>{{ deliveryCheckStatus(item) }}</span>
                  <small>отправлено в чат: «{{ item.message }}»</small>
                </article>
              </div>
            </template>
          </section>
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
              <div class="persona-assignment"><select :value="bot.personaId" @change="assignPersona(bot, ($event.target as HTMLSelectElement).value)"><option v-for="persona in personas" :key="persona.id" :value="persona.id" :disabled="personaAssignedToOther(persona.id, bot.username) || !personaMatchesAccount(persona, bot.username)">{{ persona.name }}{{ personaAssignedToOther(persona.id, bot.username) ? ' · занята' : !personaMatchesAccount(persona, bot.username) ? ' · другой аккаунт' : '' }}</option></select><small v-if="personaSummaryById.get(bot.personaId)">{{ personaSummaryById.get(bot.personaId)?.firstName }} · {{ personaSummaryById.get(bot.personaId)?.age ?? 'возраст не указан' }} · {{ personaSummaryById.get(bot.personaId)?.city || 'город не указан' }} · {{ personaSummaryById.get(bot.personaId)?.occupation || 'работа не указана' }}</small></div>
              <span>{{ bot.messagesSent }}</span><span>{{ formatTime(bot.lastReactionAt) }}</span>
              <button :class="['toggle', bot.enabled ? 'on' : '']" :aria-label="`Переключить ${bot.username}`" @click="toggleBot(bot)"><i></i></button>
            </div>
            <div v-if="!bots.length" class="empty-state">Подключите первую учётную запись кнопкой выше — логин и обновляемые токены сервер сохранит сам.</div>
          </section>
        </template>

        <template v-else-if="activePage === 'brain'">
          <div class="page-heading"><div><p class="eyebrow">ДВА НЕЗАВИСИМЫХ AI-СЛОЯ</p><h1>Мозг стрима</h1></div><p class="muted">Gemini Live только видит и слышит. Stateful Gemini Brain решает, кому и что написать.</p></div>
          <section class="brain-summary">
            <div><span>PERCEPTION · Gemini Live</span><strong>{{ stateLabel(overview.streamBrain.geminiState) }}</strong></div>
            <div><span>Live-модель</span><strong>{{ overview.streamBrain.model || '—' }}</strong></div>
            <div><span>BRAIN · Gemini Interactions</span><strong>{{ stateLabel(overview.geminiBrain.state) }}</strong></div>
            <div><span>Brain-модель / thinking</span><strong>{{ overview.geminiBrain.model }} / {{ overview.geminiBrain.thinkingLevel }}</strong></div>
            <div><span>Возраст Brain-сессии</span><strong>{{ formatSessionDuration(overview.geminiBrain.sessionStartedAt) }}</strong></div>
            <div><span>Последнее событие</span><strong>{{ formatTime(overview.streamBrain.lastEventAt) }}</strong></div>
          </section>
          <section class="panel metric-strip"><div><span>Twitch media</span><strong>→</strong></div><div><span>3.1 Live · восприятие</span><strong>→</strong></div><div><span>StreamEvent</span><strong>→</strong></div><div><span>3.7 Brain · решение</span><strong>→</strong></div><div><span>Policy / Twitch</span><strong>✓</strong></div></section>
          <div class="section-heading"><div><p class="eyebrow">ТЕКУЩИЙ ЭФИР</p><h2>Расход и результат</h2></div></div>
          <section class="metric-strip">
            <div><span>3.1 Live · длительность</span><strong>{{ usage.currentStream.perception.sessionDurationMinutes.toFixed(1) }} мин</strong></div>
            <div><span>3.1 · аудио / видео</span><strong>{{ usage.currentStream.perception.audioSentMinutes.toFixed(1) }} / {{ usage.currentStream.perception.videoSentMinutes.toFixed(1) }} мин</strong></div>
            <div><span>3.1 · input / output</span><strong>{{ usage.currentStream.perception.inputTokens }} / {{ usage.currentStream.perception.outputTokens }}</strong></div>
            <div><span>3.1 · стоимость</span><strong>${{ usage.currentStream.perception.estimatedCostUsd.toFixed(4) }}</strong></div>
          </section>
          <section class="metric-strip">
            <div><span>3.1 input · видео</span><strong>{{ usage.currentStream.perception.inputTokensByModality.video }}</strong></div>
            <div><span>3.1 input · аудио</span><strong>{{ usage.currentStream.perception.inputTokensByModality.audio }}</strong></div>
            <div><span>3.1 input · текст</span><strong>{{ usage.currentStream.perception.inputTokensByModality.text }}</strong></div>
            <div><span>3.1 output · аудио</span><strong>{{ usage.currentStream.perception.outputTokensByModality.audio }}</strong></div>
            <div><span>3.1 output · текст</span><strong>{{ usage.currentStream.perception.outputTokensByModality.text }}</strong></div>
          </section>
          <section class="metric-strip">
            <div><span>3.7 · interactions / decisions</span><strong>{{ usage.currentStream.brain.interactions }} / {{ usage.currentStream.brain.decisions }}</strong></div>
            <div><span>3.7 · input / cached</span><strong>{{ usage.currentStream.brain.inputTokens }} / {{ usage.currentStream.brain.cachedInputTokens }}</strong></div>
            <div><span>3.7 · output / thinking</span><strong>{{ usage.currentStream.brain.outputTokens }} / {{ usage.currentStream.brain.thinkingTokens }}</strong></div>
            <div><span>3.7 · latency / стоимость</span><strong>{{ formatMilliseconds(usage.currentStream.brain.averageLatencyMs) }} / ${{ usage.currentStream.brain.estimatedCostUsd.toFixed(4) }}</strong></div>
          </section>
          <section class="panel metric-strip">
            <div><span>События Live</span><strong>{{ usage.currentStream.perception.events }}</strong></div>
            <div><span>Решения Brain</span><strong>{{ overview.geminiBrain.decisions }}</strong></div>
            <div><span>Осознанная тишина</span><strong>{{ overview.geminiBrain.silentDecisions }}</strong></div>
            <div><span>Создано / отправлено</span><strong>{{ overview.geminiBrain.generatedReactions }} / {{ usage.currentStream.sentResponses }}</strong></div>
            <div><span>Подтверждено в чате</span><strong>{{ usage.currentStream.confirmedDeliveries }}</strong></div>
            <div><span>Twitch не показал</span><strong>{{ usage.currentStream.undeliveredMessages }}</strong></div>
            <div><span>Всего / в час</span><strong>${{ usage.currentStream.totalAi.estimatedCostUsd.toFixed(4) }} / ${{ usage.currentStream.totalAi.estimatedCostPerHourUsd.toFixed(4) }}</strong></div>
          </section>
          <section class="panel metric-strip">
            <div><span>Событий / час</span><strong>{{ usage.currentStream.totalAi.eventsPerHour.toFixed(1) }}</strong></div>
            <div><span>Решений / час</span><strong>{{ usage.currentStream.totalAi.brainDecisionsPerHour.toFixed(1) }}</strong></div>
            <div><span>Сообщений / час</span><strong>{{ usage.currentStream.totalAi.messagesPerHour.toFixed(1) }}</strong></div>
            <div><span>Brain context tokens</span><strong>{{ overview.geminiBrain.contextTokens }}</strong></div>
            <div><span>Bootstrap chars / tokens</span><strong>{{ overview.geminiBrain.bootstrapChars }} / {{ overview.geminiBrain.bootstrapInputTokens }}</strong></div>
          </section>
          <div class="section-heading"><div><p class="eyebrow">АВТОНОМНЫЙ СЛОЙ</p><h2>Persona Drive · текущий стрим</h2></div><p class="muted">Внутренние спонтанные реплики поверх Gemini 3.7 Brain — Gemini 3.1 Live не получает от Persona Drive ни одного дополнительного вызова.</p></div>
          <section class="panel metric-strip">
            <div><span>Тиков / eligible</span><strong>{{ usage.currentStream.drive.ticks }} / {{ usage.currentStream.drive.eligibleTicks }}</strong></div>
            <div><span>Brain calls / лимит в час</span><strong>{{ usage.currentStream.drive.brainCalls }} / {{ usage.currentStream.drive.brainCallsBlockedByHourlyLimit }}</strong></div>
            <div><span>Input / cached</span><strong>{{ usage.currentStream.driveBrain.inputTokens }} / {{ usage.currentStream.driveBrain.cachedInputTokens }}</strong></div>
            <div><span>Output + thinking</span><strong>{{ usage.currentStream.driveBrain.outputTokens + usage.currentStream.driveBrain.thinkingTokens }}</strong></div>
            <div><span>Cache hit</span><strong>{{ (usage.currentStream.driveCacheHitRatio * 100).toFixed(0) }}%</strong></div>
          </section>
          <section class="panel metric-strip">
            <div><span>Отправлено / лимит в час</span><strong>{{ usage.currentStream.drive.messages }} / {{ usage.currentStream.drive.messagesBlockedByHourlyLimit }}</strong></div>
            <div><span>Тишина</span><strong>{{ usage.currentStream.drive.silentDecisions }}</strong></div>
            <div><span>Отменено: событие / cooldown / нет кандидатов</span><strong>{{ usage.currentStream.drive.cancelledForExternalEvent }} / {{ usage.currentStream.drive.cancelledForCooldown }} / {{ usage.currentStream.drive.cancelledForNoCandidates }}</strong></div>
            <div><span>Локальных пропусков</span><strong>{{ usage.currentStream.drive.localSkips }}</strong></div>
            <div><span>Стоимость Persona Drive</span><strong>${{ usage.currentStream.driveBrain.estimatedCostUsd.toFixed(4) }}</strong></div>
          </section>
          <section class="panel debug-context">
            <div><h3>Диагностика двух слоёв</h3><p>Perception стабильна: <b>{{ overview.streamBrain.geminiStable ? 'да' : 'нет' }}</b> · состояние: <b>{{ stateLabel(overview.streamBrain.geminiState) }}</b> · ошибок протокола: <b>{{ overview.streamBrain.protocolErrorsInWindow || 0 }}</b></p><p>Live-сессия: возраст <b>{{ formatSessionDuration(overview.streamBrain.sessionStartedAt) }}</b> · reconnects <b>{{ usage.geminiReconnects }}</b> · аудио отправлено в Gemini <b>{{ overview.streamBrain.audioChunksSent ?? 0 }}</b> чанков · видео отправлено <b>{{ overview.streamBrain.videoFramesSent ?? 0 }}</b> кадров · транскриптов получено <b>{{ overview.streamBrain.transcriptsReceived ?? 0 }}</b> · молчит <b :class="perceptionSilenceClass">{{ formatMilliseconds(overview.streamBrain.msSincePerceptionOutput) }}</b> · пересозданий из-за тишины <b>{{ overview.streamBrain.stallRecoveries ?? 0 }}</b></p><p>Live turns: <b>{{ overview.streamBrain.modelTurns ?? 0 }}</b> · отчётов об usage <b>{{ overview.streamBrain.usageReports ?? 0 }}</b> · окно контекста <b>{{ overview.streamBrain.contextWindowMode === 'service_default' ? 'ДЕФОЛТ СЕРВИСА (дорого)' : '16k → 8k' }}</b> · вывод <b>{{ overview.streamBrain.responseModality ?? "—" }}</b></p><p>Brain: <b>{{ stateLabel(overview.geminiBrain.state) }}</b> · последнее решение {{ formatMilliseconds(overview.geminiBrain.lastLatencyMs) }} · среднее {{ formatMilliseconds(overview.geminiBrain.averageLatencyMs) }} · recovery {{ overview.geminiBrain.rebuiltSessions }} · rollover {{ overview.geminiBrain.rollovers }}</p><p v-if="overview.geminiBrain.lastError">Ошибка Brain: <b>{{ operatorErrorLabel(overview.geminiBrain.lastError) }}</b></p><p>Последнее закрытие Live: <b>{{ overview.streamBrain.lastCloseCode ?? '—' }}</b> · {{ closeReasonLabel(overview.streamBrain.lastCloseCode, overview.streamBrain.lastCloseReason) }}</p><details v-if="overview.streamBrain.lastCloseReason"><summary>Техническое сообщение сервера</summary><code>{{ overview.streamBrain.lastCloseReason }}</code></details><p>Последние операции Live: исходящая <b>{{ diagnosticOperationLabel(overview.streamBrain.lastOutbound) }}</b> · инструмент <b>{{ diagnosticToolLabel(overview.streamBrain.lastToolCall) }}</b> · медиа <b>{{ diagnosticOperationLabel(overview.streamBrain.lastMediaInput) }}</b></p></div>
            <pre>{{ (overview.streamBrain.outboundTrace || []).map(item => `${formatTime(item.at)} ${diagnosticOperationLabel(item.type)}${item.bytes !== undefined ? ` (${item.bytes} байт)` : ''}`).join('\n') || 'Исходящих операций пока нет.' }}</pre>
          </section>
          <div class="section-heading reaction-trace-heading">
            <div><p class="eyebrow">СКВОЗНАЯ ЦЕПОЧКА РЕАКЦИИ</p><h2>На какой момент ответил бот</h2></div>
            <p class="muted">Один блок связывает момент стрима с точным сообщением. Время считается с обнаружения события системой; задержка самого видеопотока до обнаружения сюда не входит.</p>
          </div>
          <section class="event-grid reaction-trace-grid">
            <article v-for="trace in reactionTraces" :key="`${trace.eventId}-${trace.updatedAt}`" class="event-card reaction-trace-card">
              <div class="event-top">
                <time>{{ formatTime(traceDetectedAt(trace)) }}</time>
                <span>{{ reactionTraceStageLabel(trace.stage) }}</span>
                <b>{{ reactionTraceOutcomeLabel(trace.outcome) }}</b>
              </div>
              <div class="trace-moment">
                <span>НА ЧТО ОТРЕАГИРОВАЛ</span>
                <h3>{{ trace.summary }}</h3>
              </div>
              <div v-if="trace.reactions?.length" class="trace-reactions">
                <article v-for="reaction in (trace.reactions || [])" :key="reaction.username" class="trace-reaction">
                  <div class="trace-reaction-heading">
                    <span>ЧТО НАПИСАЛ</span>
                    <strong>@{{ reaction.username }}</strong>
                    <b :class="['trace-delivery-status', reaction.status.toLowerCase()]">{{ reactionTraceMessageStatusLabel(reaction.status) }}</b>
                  </div>
                  <blockquote>«{{ reaction.message }}»</blockquote>
                  <p class="trace-link"><strong>Почему:</strong> Brain 3.7 связал эту реплику именно с описанным выше событием и выбрал @{{ reaction.username }}.</p>
                  <div class="trace-timing-grid">
                    <div><span>Подготовка контекста</span><strong>{{ traceContextDuration(trace) }}</strong></div>
                    <div><span>Ожидание в очереди</span><strong>{{ traceQueueWait(trace) }}</strong></div>
                    <div><span>Решение Brain 3.7</span><strong>{{ traceGeminiDuration(trace) }}</strong></div>
                    <div><span>От решения до отправки</span><strong>{{ traceDeliveryDuration(reaction) }}</strong></div>
                    <div><span>Всего от обнаружения</span><strong>{{ traceTotalDuration(trace, reaction) }}</strong></div>
                  </div>
                  <p v-if="reaction.failureReason" class="trace-stop-reason">{{ reactionTraceReasonLabel(reaction.failureReason) }}</p>
                </article>
              </div>
              <div v-else-if="trace.reactions === undefined" class="trace-no-reaction">
                <strong>{{ trace.sent.length ? 'Сообщение отправлено в Twitch. Подробная связь с текстом появится после обновления серверной части.' : reactionTraceReasonLabel(trace.terminalReason) }}</strong>
              </div>
              <div v-else class="trace-no-reaction">
                <strong>{{ reactionTraceReasonLabel(trace.terminalReason) }}</strong>
                <div class="trace-timing-grid compact">
                  <div><span>Подготовка контекста</span><strong>{{ traceContextDuration(trace) }}</strong></div>
                  <div><span>Ожидание в очереди</span><strong>{{ traceQueueWait(trace) }}</strong></div>
                  <div><span>Решение Brain 3.7</span><strong>{{ traceGeminiDuration(trace) }}</strong></div>
                  <div><span>Вся цепочка</span><strong>{{ elapsed(traceDetectedAt(trace), trace.timing?.completedAt) }}</strong></div>
                </div>
              </div>
              <details class="trace-details">
                <summary>Технические детали цепочки</summary>
                <p>Доступно аккаунтов: {{ trace.eligibleBots }} · передано Brain: {{ trace.candidateCount }} · выбрано: {{ trace.geminiSelected.length }} · принято: {{ trace.policyAccepted.length }} · отправлено: {{ trace.sent.length }}</p>
                <small v-if="trace.brainInteractionId">Interaction: {{ trace.brainInteractionId }} · previous использован: {{ trace.brainPreviousInteractionUsed ? 'да' : 'нет' }}</small>
                <small v-if="trace.directTargetUnavailable.length">Прямой адресат недоступен: {{ trace.directTargetUnavailable.map(item => `@${item.username}: ${directTargetReasonLabel(item.reason)}`).join(', ') }}</small>
                <small v-if="trace.policyRejected.length">Защитная проверка остановила: {{ trace.policyRejected.map(item => `${item.username}: ${rejectionLabel(item.reason)}`).join(', ') }}</small>
                <small v-if="trace.sendFailed.length">Ошибка отправки: {{ trace.sendFailed.map(item => `${item.username}: ${reactionTraceReasonLabel(item.reason)}`).join(', ') }}</small>
              </details>
            </article>
            <div v-if="!reactionTraces.length" class="empty-state panel">Реакций пока нет. Они появятся после первого понятного момента стрима.</div>
          </section>
          <div class="section-heading"><div><p class="eyebrow">РАСПОЗНАННЫЕ СОБЫТИЯ</p><h2>Понятые моменты стрима</h2></div></div>
          <section class="event-grid">
            <article v-for="event in events" :key="event.id" class="event-card"><div class="event-top"><time>{{ formatTime(event.timestamp) }}</time><span>{{ event.category || overview.category || 'Категория неизвестна' }}</span><b>{{ eventTypeLabel(event.type) }}</b></div><h3>{{ event.summary }}</h3><p v-if="event.speech">«{{ event.speech }}»</p><div class="event-bars"><label>важность <meter min="0" max="1" :value="event.importance"></meter><b>{{ event.importance.toFixed(2) }}</b></label><label>уверенность <meter min="0" max="1" :value="event.confidence"></meter><b>{{ event.confidence.toFixed(2) }}</b></label></div><small>{{ sourceLabel(event.source) }}<template v-if="event.directMentions.length"> · @{{ event.directMentions.join(', @') }}</template></small></article>
            <div v-if="!events.length" class="empty-state panel">Нормализованных событий пока нет.</div>
          </section>
        </template>

        <template v-else-if="activePage === 'memories'">
          <div class="page-heading"><div><p class="eyebrow">ДОЛГОСРОЧНЫЙ КОНТЕКСТ КАНАЛА</p><h1>Память стримера</h1></div><p class="muted">PostgreSQL хранит истину между эфирами; Brain получает компактный снимок один раз при bootstrap и предлагает только важные обновления.</p></div>

          <section class="memory-stat-grid" aria-label="Статистика памяти стримера">
            <article><span>Всего записей</span><strong>{{ streamerMemoryStats.total }}</strong><small>канал: {{ streamerMemoryStats.channel || overview.channel || 'не выбран' }}</small></article>
            <article><span>Актуальны</span><strong>{{ streamerMemoryStats.active }}</strong><small>доступны для подбора контекста</small></article>
            <article><span>Подтверждения</span><strong>{{ streamerMemoryStats.duplicateMerges }}</strong><small>повторных наблюдений объединено</small></article>
            <article><span>Средняя уверенность</span><strong>{{ streamerMemoryStats.averageConfidence.toFixed(2) }}</strong><small>важность {{ streamerMemoryStats.averageImportance.toFixed(2) }}</small></article>
            <article><span>Завершены</span><strong>{{ streamerMemoryStats.resolved }}</strong><small>факты и планы закрыты</small></article>
            <article><span>Заменены</span><strong>{{ streamerMemoryStats.superseded }}</strong><small>уступили более свежему факту</small></article>
            <article><span>Устарели</span><strong>{{ streamerMemoryStats.expired }}</strong><small>вышел срок действия</small></article>
          </section>

          <section class="panel streamer-memory-controls">
            <label>Поиск по памяти<input v-model="memorySearch" autocomplete="off" placeholder="Например: поездка, Таиланд, турнир" /></label>
            <label>Тип<select v-model="memoryTypeFilter"><option value="all">Все типы</option><option value="fact">Факт</option><option value="preference">Предпочтение</option><option value="person">Человек</option><option value="relationship">Отношение</option><option value="plan">План</option><option value="promise">Обещание</option><option value="result">Результат</option><option value="place">Место</option><option value="trip">Поездка</option><option value="running_joke">Внутренняя шутка</option><option value="important_event">Важное событие</option><option value="recurring_context">Повторяющийся контекст</option><option value="other">Другое</option></select></label>
            <label>Состояние<select v-model="memoryStatusFilter"><option value="all">Все состояния</option><option value="active">Актуальные</option><option value="resolved">Завершённые</option><option value="superseded">Заменённые</option><option value="expired">Устаревшие</option></select></label>
            <div class="streamer-memory-control-actions"><span>{{ visibleStreamerMemories.length }} из {{ streamerMemories.length }}</span><button class="secondary" type="button" :disabled="memoryBusy" @click="refreshStreamerMemories">Обновить</button></div>
          </section>

          <section class="streamer-memory-layout">
            <div class="streamer-memory-list">
              <article v-for="memory in visibleStreamerMemories" :key="memory.id" :class="['streamer-memory-card', `is-${memory.status}`]">
                <form v-if="editingStreamerMemoryId === memory.id" class="streamer-memory-edit" @submit.prevent="saveStreamerMemoryEdit">
                  <div class="panel-heading"><div><p class="eyebrow">РУЧНОЕ РЕДАКТИРОВАНИЕ</p><h3>{{ streamerMemoryTypeLabel(memory.type) }}</h3></div><span :class="['streamer-memory-status', `is-${memory.status}`]">{{ streamerMemoryStatusLabel(memory.status) }}</span></div>
                  <label>Краткая формулировка<textarea v-model="streamerMemoryEditDraft.summary" rows="3" maxlength="600"></textarea></label>
                  <div class="two-fields"><label>Сущности через запятую<input v-model="streamerMemoryEditDraft.entities" placeholder="Таиланд, Миша" /></label><label>Теги через запятую<input v-model="streamerMemoryEditDraft.tags" placeholder="план, поездка" /></label></div>
                  <div class="four-columns"><label>Важность <b>{{ streamerMemoryEditDraft.importance.toFixed(2) }}</b><input v-model.number="streamerMemoryEditDraft.importance" type="range" min="0" max="1" step="0.05" /></label><label>Уверенность <b>{{ streamerMemoryEditDraft.confidence.toFixed(2) }}</b><input v-model.number="streamerMemoryEditDraft.confidence" type="range" min="0" max="1" step="0.05" /></label><label>Когда произошло<input v-model="streamerMemoryEditDraft.occurredAt" type="datetime-local" /></label><label>Срок действия<input v-model="streamerMemoryEditDraft.expiresAt" type="datetime-local" /></label></div>
                  <label>Состояние<select v-model="streamerMemoryEditDraft.status"><option value="active">Актуальна</option><option value="resolved">Завершена</option><option value="expired">Устарела</option></select></label>
                  <div class="streamer-memory-actions"><button class="secondary" type="button" :disabled="memoryBusy" @click="cancelStreamerMemoryEdit">Отмена</button><button class="primary" type="submit" :disabled="memoryBusy">{{ memoryBusy ? 'Сохраняем…' : 'Сохранить' }}</button></div>
                  <small class="muted">Пустой срок действия снимает ограничение. Запись не изменяет канон личностей и не показывает технические секреты.</small>
                </form>

                <template v-else>
                  <div class="streamer-memory-card-top"><div><p class="eyebrow">{{ streamerMemoryTypeLabel(memory.type) }}</p><h3>{{ memory.summary }}</h3></div><span :class="['streamer-memory-status', `is-${memory.status}`]">{{ streamerMemoryStatusLabel(memory.status) }}</span></div>
                  <div class="streamer-memory-chip-row"><span v-for="entity in memory.entities" :key="`entity-${entity}`" class="memory-chip entity">{{ entity }}</span><span v-for="tag in memory.tags" :key="`tag-${tag}`" class="memory-chip">#{{ tag }}</span><span v-if="!memory.entities.length && !memory.tags.length" class="memory-chip muted-chip">без сущностей и тегов</span></div>
                  <div class="streamer-memory-scores"><label>важность <meter min="0" max="1" :value="memory.importance"></meter><b>{{ memory.importance.toFixed(2) }}</b></label><label>уверенность <meter min="0" max="1" :value="memory.confidence"></meter><b>{{ memory.confidence.toFixed(2) }}</b></label></div>
                  <dl class="streamer-memory-meta"><div><dt>Создана</dt><dd>{{ formatDate(memory.createdAt) }}</dd></div><div><dt>Произошла</dt><dd>{{ memory.occurredAt ? formatDate(memory.occurredAt) : 'время не указано' }}</dd></div><div><dt>Подтверждена</dt><dd>{{ formatDate(memory.lastSeenAt) }} · ×{{ memory.confirmationCount }}</dd></div><div><dt>Источник эфира</dt><dd>{{ memory.sourceSessionId ? `эфир ${shortMemoryId(memory.sourceSessionId)}` : 'без привязки к эфиру' }}</dd></div><div><dt>Источник события</dt><dd>{{ memory.sourceEventId ? shortMemoryId(memory.sourceEventId) : 'не указан' }}</dd></div><div><dt>Срок действия</dt><dd>{{ memory.expiresAt ? formatDate(memory.expiresAt) : 'без срока' }}</dd></div><div v-if="memory.supersededBy"><dt>Заменена</dt><dd>{{ shortMemoryId(memory.supersededBy) }}</dd></div></dl>
                  <div class="streamer-memory-actions"><button class="text-button" type="button" :disabled="memoryBusy" @click="startStreamerMemoryEdit(memory)">Изменить</button><button v-if="memory.status === 'active'" class="text-button" type="button" :disabled="memoryBusy" @click="setStreamerMemoryStatus(memory, 'resolved')">Завершить</button><button v-if="memory.status === 'active'" class="text-button warning" type="button" :disabled="memoryBusy" @click="setStreamerMemoryStatus(memory, 'expired')">Устарела</button><button v-if="memory.status === 'resolved' || memory.status === 'expired'" class="text-button" type="button" :disabled="memoryBusy" @click="setStreamerMemoryStatus(memory, 'active')">Вернуть в актуальные</button><button class="danger-button compact" type="button" :disabled="memoryBusy" @click="deleteStreamerMemory(memory)">Удалить</button></div>
                </template>
              </article>
              <div v-if="!visibleStreamerMemories.length" class="empty-state panel">Записей с такими фильтрами пока нет. Во время эфира Gemini сохраняет только важные и безопасные факты, планы, людей и повторяющиеся контексты.</div>
            </div>

            <aside class="panel streamer-memory-preview">
              <div class="panel-heading"><div><p class="eyebrow">ОТЛАДКА ПОДБОРА</p><h3>Контекст для Gemini</h3></div></div>
              <p class="muted">Проверяет только серверный детерминированный поиск. Этот запрос не создаёт память, не запускает новую модель и показывает лишь безопасные поля записей.</p>
              <form class="streamer-memory-preview-form" @submit.prevent="previewStreamerMemoryContext"><label>Событие или вопрос<input v-model="memoryPreviewQuery" autocomplete="off" placeholder="Стример опять говорит о поездке" /></label><button class="primary" type="submit" :disabled="memoryBusy || !memoryPreviewQuery.trim()">{{ memoryBusy ? 'Ищем…' : 'Проверить контекст' }}</button></form>
              <div v-if="memoryContextPreview" class="streamer-memory-preview-results"><p class="preview-result-count">Найдено: {{ memoryContextPreview.length }}</p><article v-for="memory in memoryContextPreview" :key="memory.id"><div><span>{{ streamerMemoryTypeLabel(memory.type) }}</span><strong>{{ memory.summary }}</strong></div><small>{{ memory.entities.join(', ') || 'без сущностей' }} · важность {{ memory.importance.toFixed(2) }} · уверенность {{ memory.confidence.toFixed(2) }}</small></article><p v-if="!memoryContextPreview.length" class="empty-state">Релевантных активных записей нет — старый контекст не будет добавлен просто из-за давности или важности.</p></div>
              <p v-else class="empty-state">Введите текущую тему, чтобы увидеть, какие записи реально могут попасть в общий контекст.</p>
            </aside>
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
              <label>Канал, для которого копится память<input v-model="settings.memoryChannel" autocomplete="off" placeholder="gudini_younger" /></label>
              <small class="muted">Стримы на других каналах ничего не запоминают: сессия памяти не открывается, факты о стримере не пишутся. Пусто — копится на любом канале.</small>
              <button class="primary" type="submit">Сохранить и применить</button>
              <small class="muted">Канал хранится в PostgreSQL и переключается сразу. В Railway переменную TWITCH_CHANNEL можно оставить пустой.</small>
            </form>
            <section class="panel security-panel"><div class="panel-heading"><div><p class="eyebrow">БЕЗОПАСНОСТЬ</p><h3>Границы развертывания</h3></div></div><ul><li><span>Ключ Gemini</span><b>Только Railway</b></li><li><span>OAuth Twitch</span><b>Только Railway</b></li><li><span>Авторизация панели</span><b>HttpOnly-сессия</b></li><li><span>CORS</span><b>Список FRONTEND_URL</b></li></ul></section>
          </section>
          <div class="section-heading"><div><p class="eyebrow">УСТОЙЧИВЫЕ ВЫМЫШЛЕННЫЕ ЛЮДИ</p><h2>Редактор личностей</h2></div><p class="muted">Канон меняется только здесь. Память стрима не может переписать имя, семью или биографию.</p></div>
          <section class="panel persona-toolbar">
            <label>Выбранная личность<select :value="selectedPersonaId" @change="selectPersona(($event.target as HTMLSelectElement).value)"><option v-for="persona in personas" :key="persona.id" :value="persona.id">{{ persona.name }} · {{ persona.id }}</option></select></label>
            <div class="persona-toolbar-actions"><button class="primary" type="button" :disabled="personaBusy" @click="createManualPersona">Создать вручную</button><button class="secondary" type="button" :disabled="personaBusy" @click="createTemplatePersona">Создать из ника</button><button class="secondary" type="button" :disabled="!selectedPersona || selectedPersona.source !== 'generated' || personaBusy" @click="previewSelectedRegeneration">Пересоздать с учётом ника</button><button class="secondary" type="button" :disabled="personaBusy" @click="previewBulkRegeneration">Проверить все автогенерированные</button><button class="secondary" type="button" :disabled="!selectedPersona || personaBusy" @click="duplicateSelectedPersona">Дублировать основу</button><button class="danger-button" type="button" :disabled="!selectedPersona || personaBusy" @click="deleteSelectedPersona">Удалить</button></div>
            <div v-if="selectedPersonaSummary" class="quality-scores"><div><span>Заполненность</span><meter min="0" max="100" :value="selectedPersonaSummary.completeness"></meter><strong>{{ selectedPersonaSummary.completeness }}%</strong></div><div><span>Уникальность</span><meter min="0" max="100" :value="selectedPersonaSummary.uniqueness"></meter><strong>{{ selectedPersonaSummary.uniqueness }}%</strong></div><div><span>Связность</span><meter min="0" max="100" :value="selectedPersonaSummary.consistency"></meter><strong>{{ selectedPersonaSummary.consistency }}%</strong></div></div>
          </section>

          <form v-if="selectedPersona" class="panel persona-editor" @submit.prevent="savePersona(selectedPersona)">
            <div class="persona-editor-heading"><div><span class="persona-id">{{ selectedPersona.id }}</span><h3>{{ selectedPersona.name }}</h3><small>{{ selectedPersonaSummary?.quickSummary }} · {{ sourceLabelForPersona(selectedPersona) }}<template v-if="selectedPersona.manuallyEdited"> · ручных разделов: {{ selectedPersona.manualOverrides.length }}</template></small></div><div class="heading-chips"><span class="subtle-chip">схема v{{ selectedPersona.schemaVersion }}</span><span class="subtle-chip">генератор v{{ selectedPersona.generationVersion }}</span></div></div>
            <nav class="persona-tabs" aria-label="Разделы личности"><button v-for="tab in personaTabs" :key="tab.id" type="button" :class="{ active: personaTab === tab.id }" @click="setPersonaTab(tab.id)">{{ tab.label }}</button></nav>

            <section v-if="personaTab === 'main'" class="persona-section">
              <div class="four-columns"><label>Название в панели<input v-model="selectedPersona.name" /></label><label>Имя человека<input v-model="selectedPersona.identity.firstName" /></label><label>Как называть<input v-model="selectedPersona.identity.preferredName" /></label><label>Никнейм Twitch<input v-model="selectedPersona.identity.nickname" /></label></div>
              <label>История никнейма<textarea v-model="selectedPersona.identity.nicknameOrigin" rows="3"></textarea></label>
              <label>Краткое описание<textarea v-model="selectedPersona.description" rows="3"></textarea></label>
              <label>Семейный фон<textarea v-model="selectedPersona.familyBackground" rows="3"></textarea></label>
              <div class="three-fields"><label>Дата рождения<input v-model="selectedPersona.identity.birthDate" type="date" /></label><label>Работа<input v-model="selectedPersona.identity.occupation" /></label><label>Статус отношений<input v-model="selectedPersona.identity.relationshipStatus" /></label></div>
              <label>Образование<input v-model="selectedPersona.identity.education" /></label>
              <h4>Места</h4><div class="location-grid"><div><strong>Родился</strong><input v-model="selectedPersona.identity.birthplace!.city" placeholder="Город" /><input v-model="selectedPersona.identity.birthplace!.country" placeholder="Страна" /></div><div><strong>Вырос</strong><input v-model="selectedPersona.identity.grewUpIn!.city" placeholder="Город" /><input v-model="selectedPersona.identity.grewUpIn!.country" placeholder="Страна" /></div><div><strong>Живёт сейчас</strong><input v-model="selectedPersona.identity.currentLocation!.city" placeholder="Город" /><input v-model="selectedPersona.identity.currentLocation!.country" placeholder="Страна" /></div></div>
              <div class="subsection-heading"><h4>Языки</h4><button class="text-button" type="button" @click="selectedPersona.identity.languages.push({ language: 'русский', level: 'разговорный' })">+ Добавить язык</button></div><div class="repeat-list"><div v-for="(language, index) in selectedPersona.identity.languages" :key="index" class="inline-edit"><input v-model="language.language" placeholder="Язык" /><input v-model="language.level" placeholder="Уровень" /><button type="button" class="icon-button" @click="selectedPersona.identity.languages.splice(index, 1)">×</button></div></div>
              <h4>Границы личного</h4>
              <div class="three-fields">
                <label>Общая открытость<select v-model="selectedPersona.disclosure.defaultLevel"><option value="open">открытая</option><option value="moderate">умеренная</option><option value="private">закрытая</option></select></label>
                <label class="check-line"><input v-model="selectedPersona.disclosure.privatePerson" type="checkbox" /> Не любит раскрывать личное</label>
                <label>Семья<select v-model="selectedPersona.disclosure.topics.family"><option value="open">открыто</option><option value="moderate">умеренно</option><option value="private">приватно</option></select></label>
                <label>Работа<select v-model="selectedPersona.disclosure.topics.work"><option value="open">открыто</option><option value="moderate">умеренно</option><option value="private">приватно</option></select></label>
                <label>Отношения<select v-model="selectedPersona.disclosure.topics.relationships"><option value="open">открыто</option><option value="moderate">умеренно</option><option value="private">приватно</option></select></label>
                <label>Деньги<select v-model="selectedPersona.disclosure.topics.money"><option value="open">открыто</option><option value="moderate">умеренно</option><option value="private">приватно</option></select></label>
                <label>Местоположение<select v-model="selectedPersona.disclosure.topics.location"><option value="open">открыто</option><option value="moderate">умеренно</option><option value="private">приватно</option></select></label>
              </div>
            </section>

            <section v-else-if="personaTab === 'character'" class="persona-section">
              <label>Характер<textarea v-model="selectedPersona.character.summary" rows="3"></textarea></label><div class="two-fields"><label>Юмор<input v-model="selectedPersona.character.humor" /></label><label>Поведение в конфликте<input v-model="selectedPersona.character.conflictStyle" /></label></div>
              <div class="four-columns"><div><div class="subsection-heading"><h4>Черты</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.character.traits, 'новая черта')">+</button></div><div v-for="(_, index) in selectedPersona.character.traits" :key="index" class="inline-edit"><input v-model="selectedPersona.character.traits[index]" /><button type="button" @click="selectedPersona.character.traits.splice(index, 1)">×</button></div></div><div><div class="subsection-heading"><h4>Сильные стороны</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.character.strengths, 'новая сильная сторона')">+</button></div><div v-for="(_, index) in selectedPersona.character.strengths" :key="index" class="inline-edit"><input v-model="selectedPersona.character.strengths[index]" /><button type="button" @click="selectedPersona.character.strengths.splice(index, 1)">×</button></div></div><div><div class="subsection-heading"><h4>Недостатки</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.character.flaws, 'новый недостаток')">+</button></div><div v-for="(_, index) in selectedPersona.character.flaws" :key="index" class="inline-edit"><input v-model="selectedPersona.character.flaws[index]" /><button type="button" @click="selectedPersona.character.flaws.splice(index, 1)">×</button></div></div><div><div class="subsection-heading"><h4>Слепые зоны</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.behavior.imperfections.blindSpots, 'новая слепая зона')">+</button></div><div v-for="(_, index) in selectedPersona.behavior.imperfections.blindSpots" :key="index" class="inline-edit"><input v-model="selectedPersona.behavior.imperfections.blindSpots[index]" /><button type="button" @click="selectedPersona.behavior.imperfections.blindSpots.splice(index, 1)">×</button></div></div></div>
              <label>Инструкции поведения<textarea v-model="selectedPersona.behavior.styleInstructions" rows="3"></textarea></label><div class="three-fields"><label>Минимум слов<input v-model.number="selectedPersona.behavior.verbosity.minWords" type="number" min="1" max="50" /></label><label>Максимум слов<input v-model.number="selectedPersona.behavior.verbosity.maxWords" type="number" min="1" max="100" /></label><label>Минимальный интервал между сообщениями, мс<input v-model.number="selectedPersona.behavior.minimumIntervalMs" type="number" min="1000" /></label></div>
              <div class="slider-grid"><label>Склонность реагировать <b>{{ selectedPersona.behavior.reactionProbability.toFixed(2) }}</b><input v-model.number="selectedPersona.behavior.reactionProbability" type="range" min="0" max="1" step="0.05" /></label><label>Избирательность событий <b>{{ selectedPersona.behavior.activity.eventSelectivity.toFixed(2) }}</b><input v-model.number="selectedPersona.behavior.activity.eventSelectivity" type="range" min="0" max="1" step="0.05" /></label><label>Ответ на прямое обращение <b>{{ selectedPersona.behavior.activity.directReplyLikelihood.toFixed(2) }}</b><input v-model.number="selectedPersona.behavior.activity.directReplyLikelihood" type="range" min="0" max="1" step="0.05" /></label><label>Сарказм <b>{{ selectedPersona.behavior.sarcasmLevel.toFixed(2) }}</b><input v-model.number="selectedPersona.behavior.sarcasmLevel" type="range" min="0" max="1" step="0.05" /></label></div>
              <div class="three-fields"><label>Частота активности<select v-model="selectedPersona.behavior.activity.chatFrequency"><option value="very-low">очень редко</option><option value="low">редко</option><option value="medium">средне</option><option value="high">активно</option></select></label></div>
              <div class="two-fields"><label>Любимые типы событий<input :value="selectedPersona.behavior.activity.preferredEventTypes.join(', ')" @change="selectedPersona.behavior.activity.preferredEventTypes = ($event.target as HTMLInputElement).value.split(',').map(value => value.trim()).filter(Boolean)" /></label><label>Игнорируемые типы событий<input :value="selectedPersona.behavior.activity.ignoredEventTypes.join(', ')" @change="selectedPersona.behavior.activity.ignoredEventTypes = ($event.target as HTMLInputElement).value.split(',').map(value => value.trim()).filter(Boolean)" /></label></div>
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
              <article v-for="(fact, index) in selectedPersona.facts" :key="fact.id" class="nested-card"><div class="two-fields"><label>Категория<select v-model="fact.category"><option v-for="value in ['family','childhood','education','work','gaming','food','music','travel','technology','automotive','animals','art','biology','law','money','sport','imperfection','relationships','habit','preference','story','other']" :key="value" :value="value">{{ factCategoryLabel(value) }}</option></select></label><label>Важность <b>{{ fact.importance.toFixed(2) }}</b><input v-model.number="fact.importance" type="range" min="0" max="1" step="0.05" /></label></div><label>Факт<textarea v-model="fact.fact" rows="2"></textarea></label><label class="check-line"><input v-model="fact.privateByDefault" type="checkbox" /> Не передавать без явной необходимости</label><button class="danger-button compact" type="button" @click="selectedPersona.facts.splice(index, 1)">Удалить факт</button></article>
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
              <div class="four-columns"><div v-for="group in [{ key: 'openingPatterns', label: 'Начала фраз' }, { key: 'endingPatterns', label: 'Концы фраз' }, { key: 'abbreviations', label: 'Сокращения' }, { key: 'twitchEmotes', label: 'Эмоуты Twitch' }]" :key="group.key"><div class="subsection-heading"><h4>{{ group.label }}</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.speech[group.key as 'openingPatterns'|'endingPatterns'|'abbreviations'|'twitchEmotes'], 'новый вариант')">+</button></div><div v-for="(_, index) in selectedPersona.speech[group.key as 'openingPatterns'|'endingPatterns'|'abbreviations'|'twitchEmotes']" :key="index" class="inline-edit"><input v-model="selectedPersona.speech[group.key as 'openingPatterns'|'endingPatterns'|'abbreviations'|'twitchEmotes'][index]" /><button type="button" @click="selectedPersona.speech[group.key as 'openingPatterns'|'endingPatterns'|'abbreviations'|'twitchEmotes'].splice(index, 1)">×</button></div></div></div>
              <div class="subsection-heading"><h4>Примеры сообщений</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.speech.messageExamples, 'новый пример')">+</button></div><div v-for="(_, index) in selectedPersona.speech.messageExamples" :key="index" class="inline-edit"><input v-model="selectedPersona.speech.messageExamples[index]" /><button type="button" @click="selectedPersona.speech.messageExamples.splice(index, 1)">×</button></div>
            </section>

            <section v-else-if="personaTab === 'twitch'" class="persona-section">
              <div class="two-fields"><label>Впервые увидел стрим<input v-model="selectedPersona.streamerRelationship.firstSeen" placeholder="2024-03" /></label><label>Любимые типы стримов<input :value="selectedPersona.streamerRelationship.favoriteStreamTypes.join(', ')" @change="selectedPersona.streamerRelationship.favoriteStreamTypes = ($event.target as HTMLInputElement).value.split(',').map(value => value.trim()).filter(Boolean)" /></label></div>
              <label>Произносимые псевдонимы для прямого обращения<input :value="(selectedPersona.spokenAliases || []).join(', ')" placeholder="например: супер, супер си эс" @change="selectedPersona.spokenAliases = ($event.target as HTMLInputElement).value.split(',').map(value => value.trim()).filter(Boolean)" /></label>
              <div class="slider-grid"><label>Знакомство со стримером <b>{{ selectedPersona.streamerRelationship.familiarity.toFixed(2) }}</b><input v-model.number="selectedPersona.streamerRelationship.familiarity" type="range" min="0" max="1" step="0.05" /></label><label>Поддержка <b>{{ selectedPersona.streamerRelationship.supportiveness.toFixed(2) }}</b><input v-model.number="selectedPersona.streamerRelationship.supportiveness" type="range" min="0" max="1" step="0.05" /></label><label>Поддразнивание <b>{{ selectedPersona.streamerRelationship.teasingLevel.toFixed(2) }}</b><input v-model.number="selectedPersona.streamerRelationship.teasingLevel" type="range" min="0" max="1" step="0.05" /></label></div>
              <div class="subsection-heading"><h4>Повторяющиеся ссылки</h4><button type="button" class="text-button" @click="addTextItem(selectedPersona.streamerRelationship.recurringReferences, 'новая ссылка')">+</button></div><div v-for="(_, index) in selectedPersona.streamerRelationship.recurringReferences" :key="index" class="inline-edit"><input v-model="selectedPersona.streamerRelationship.recurringReferences[index]" /><button type="button" @click="selectedPersona.streamerRelationship.recurringReferences.splice(index, 1)">×</button></div>
              <div class="subsection-heading"><div><h4>Знакомства с другими личностями</h4><p class="muted">Не создают принудительный разговор; используются только при естественном поводе.</p></div><button class="secondary" type="button" @click="addPersonaRelationship(selectedPersona)">+ Знакомство</button></div><article v-for="(relationship, index) in selectedPersona.relationships" :key="relationship.targetPersonaId" class="nested-card"><label>Другая личность<select v-model="relationship.targetPersonaId"><option v-for="candidate in personas.filter(candidate => candidate.id !== selectedPersona!.id)" :key="candidate.id" :value="candidate.id">{{ candidate.name }}</option></select></label><div class="two-fields"><label>Знакомство <b>{{ relationship.familiarity.toFixed(2) }}</b><input v-model.number="relationship.familiarity" type="range" min="0" max="1" step="0.05" /></label><label>Отношение <b>{{ relationship.sentiment.toFixed(2) }}</b><input v-model.number="relationship.sentiment" type="range" min="-1" max="1" step="0.05" /></label></div><div class="subsection-heading"><h4>Заметки</h4><button type="button" class="text-button" @click="addTextItem(relationship.notes, 'новая заметка')">+</button></div><div v-for="(_, noteIndex) in relationship.notes" :key="noteIndex" class="inline-edit"><input v-model="relationship.notes[noteIndex]" /><button type="button" @click="relationship.notes.splice(noteIndex, 1)">×</button></div><button class="danger-button compact" type="button" @click="selectedPersona.relationships.splice(index, 1)">Удалить знакомство</button></article>
            </section>

            <section v-else-if="personaTab === 'memory'" class="persona-section">
              <div class="debug-context"><div><h4>Что получила бы Gemini</h4><p class="muted">Без ключей и токенов. Показывает только контекст одной выбранной личности.</p><div class="inline-edit"><input v-model="personaContextQuery" placeholder="Например: как дядю зовут?" /><button class="secondary" type="button" :disabled="personaBusy" @click="previewPersonaContext">Собрать контекст</button></div></div><pre v-if="personaContextPreview">{{ JSON.stringify(personaContextPreview, null, 2) }}</pre></div>
              <div class="subsection-heading"><div><h4>Долгосрочная память</h4><p class="muted">Канон выше памяти. Записи ниже не меняют биографию.</p></div><button class="text-button" type="button" @click="loadPersonaMemories">Обновить</button></div><div class="memory-list"><article v-for="memory in personaMemories" :key="memory.id"><div><strong>{{ memory.summary }}</strong><small>{{ formatDate(memory.createdAt) }} · {{ memoryTypeLabel(memory.type) }} · важность {{ memory.importance.toFixed(2) }}</small></div><span class="subtle-chip">{{ memory.tags.join(', ') || 'без тегов' }}</span></article><div v-if="!personaMemories.length" class="empty-state">У этой личности ещё нет сохранённых воспоминаний.</div></div>
            </section>

            <section v-else class="persona-section quality-section">
              <div v-if="selectedPersonaSummary" class="quality-overview"><article><span>Заполненность</span><strong>{{ selectedPersonaSummary.completeness }}%</strong><small>наличие канонических полей</small></article><article><span>Уникальность</span><strong>{{ selectedPersonaSummary.uniqueness }}%</strong><small>детерминированное сравнение с ближайшей личностью</small></article><article><span>Связность</span><strong>{{ selectedPersonaSummary.consistency }}%</strong><small>проверка дат, семьи и диапазонов</small></article></div>
              <p v-if="selectedPersonaTooSimilar" class="notice error">⚠ Эта личность слишком похожа на ближайшую: сходство достигло порога {{ PERSONA_SIMILARITY_WARNING_THRESHOLD.toFixed(2) }}. Перед сохранением измените речь, знания или поведение.</p>
              <div v-if="selectedPersonaSummary?.mostSimilarPersonaId" class="nested-card"><h4>Наиболее похожая личность</h4><p>{{ selectedPersonaSummary.mostSimilarUsername || selectedPersonaSummary.mostSimilarPersonaId }}</p><p class="muted">{{ selectedPersonaSummary.similarityReasons.join(' · ') || 'Сильного общего измерения не обнаружено' }}</p></div>
              <div class="nested-card"><h4>Проверка связности</h4><p v-if="!selectedPersonaSummary?.qualityWarnings.length" class="quality-ok">Ошибок и предупреждений нет.</p><ul v-else class="quality-warnings"><li v-for="warning in selectedPersonaSummary.qualityWarnings" :key="warning">{{ warning }}</li></ul></div>
              <p v-if="personaAudit && personaAudit.maximumSimilarity >= PERSONA_SIMILARITY_WARNING_THRESHOLD" class="notice error">⚠ В наборе есть слишком похожие личности: максимальное сходство {{ personaAudit.maximumSimilarity.toFixed(3) }}.</p>
              <div v-if="personaAudit" class="audit-grid"><article><span>Аккаунтов / уникальных личностей</span><strong>{{ personaAudit.accountCount }} / {{ personaAudit.uniquePersonaCount }}</strong></article><article><span>Мужчины / женщины в v3-наборе</span><strong>{{ personaAudit.genderDistribution?.male ?? '—' }} / {{ personaAudit.genderDistribution?.female ?? '—' }}</strong><small>{{ personaAudit.genderDistribution?.malePercentage ?? '—' }}% / {{ personaAudit.genderDistribution?.femalePercentage ?? '—' }}%</small></article><article><span>Уникальных стилей речи</span><strong>{{ personaAudit.uniqueSpeechFingerprintCount }}</strong></article><article><span>Максимальное сходство</span><strong>{{ personaAudit.maximumSimilarity.toFixed(3) }}</strong></article><article><span>Среднее сходство</span><strong>{{ personaAudit.averageSimilarity.toFixed(3) }}</strong></article><article><span>Ошибок связности</span><strong>{{ personaAudit.coherenceErrors.length }}</strong></article><article><span>Предупреждений</span><strong>{{ personaAudit.coherenceWarnings.length }}</strong></article><article><span>Родственников на личность</span><strong>{{ personaAudit.structureRanges?.relatives?.min ?? '—' }}–{{ personaAudit.structureRanges?.relatives?.max ?? '—' }}</strong></article><article><span>Фактов на личность</span><strong>{{ personaAudit.structureRanges?.facts?.min ?? '—' }}–{{ personaAudit.structureRanges?.facts?.max ?? '—' }}</strong></article></div>
              <div v-if="personaAudit?.genderDistribution?.femaleUsernames?.length" class="nested-card"><h4>Женские профили в наборе</h4><p>{{ personaAudit.genderDistribution.femaleUsernames.join(', ') }}</p></div>
              <div v-if="personaAudit?.identityChanges?.length" class="nested-card"><h4>Аудит пересобранных identity</h4><ul class="quality-warnings"><li v-for="change in personaAudit.identityChanges" :key="change.username"><strong>{{ change.username }}</strong> — {{ change.canonicalName }}: {{ change.status === 'matched' ? 'канон совпадает' : change.status === 'missing' ? 'профиль не назначен' : 'нужно проверить канон' }}</li></ul></div>
            </section>

            <div class="persona-editor-footer"><p class="muted">Сохранение изменяет канон. Обычный чат и Gemini не имеют доступа к этой операции.</p><button class="primary" type="submit" :disabled="personaBusy">{{ personaBusy ? 'Сохраняем…' : 'Сохранить личность' }}</button></div>
          </form>
          <div v-else class="empty-state panel">Создайте первую личность вручную или из уникального шаблона.</div>
        </template>
      </main>
    </div>
    <div v-if="regenerationPreview || bulkRegenerationPreview" class="modal-backdrop" @click.self="regenerationPreview = null; bulkRegenerationPreview = null">
      <section class="modal-card" role="dialog" aria-modal="true" aria-label="Предпросмотр пересоздания личности">
        <template v-if="regenerationPreview">
          <div class="panel-heading"><div><p class="eyebrow">ПРЕДПРОСМОТР</p><h3>Пересоздать {{ regenerationPreview.username }}</h3></div><button class="icon-button" type="button" @click="regenerationPreview = null">×</button></div>
          <p class="muted">Имя аккаунта и идентификатор личности останутся прежними. Перед записью сервер сохранит полный предыдущий канон; ручные разделы имеют приоритет.</p>
          <p v-if="regenerationPreview.changed === false" class="notice">Проверено: изменения не требуются. {{ regenerationPreview.reason || 'Текущий канон уже совпадает с предложенной генерацией.' }}</p>
          <p v-if="regenerationPreview.requiresIndividualConfirmation" class="notice error">Нужно индивидуальное подтверждение: этот профиль нельзя применять массово. {{ regenerationPreview.reason }}</p>
          <p v-else-if="regenerationPreview.legacyManualReviewRequired" class="notice error">Этот профиль создан до появления точного учёта ручных полей. Внимательно сравните канон перед индивидуальным применением. Полная старая версия уже сохранена в PostgreSQL.</p>
          <div class="preview-comparison"><article><span>Сейчас</span><h4>{{ regenerationPreview.current.name }}</h4><p>{{ personaPreviewText(regenerationPreview.current) }}</p><details open><summary>Полный текущий канон</summary><pre>{{ personaFullPreview(regenerationPreview.current) }}</pre></details></article><article><span>Новая личность</span><h4>{{ regenerationPreview.proposed.name }}</h4><p>{{ personaPreviewText(regenerationPreview.proposed) }}</p><details open><summary>Полный предлагаемый канон</summary><pre>{{ personaFullPreview(regenerationPreview.proposed) }}</pre></details></article></div>
          <div class="preview-notice"><strong>Сохранятся ручные разделы: {{ regenerationPreview.preservedManualOverrides.length }}</strong><small>{{ regenerationPreview.preservedManualOverrides.join(', ') || 'Ручных изменений пока нет' }}</small></div>
          <div class="modal-actions"><button class="secondary" type="button" @click="regenerationPreview = null">Отмена</button><button class="primary" type="button" :disabled="personaBusy || regenerationPreview.changed === false" @click="applySelectedRegeneration">{{ regenerationPreview.requiresIndividualConfirmation ? 'Подтвердить индивидуально и применить' : 'Создать резервную копию и применить' }}</button></div>
        </template>
        <template v-else-if="bulkRegenerationPreview">
          <div class="panel-heading"><div><p class="eyebrow">МАССОВЫЙ ПРЕДПРОСМОТР</p><h3>Проверено личностей: {{ bulkRegenerationPreview.items.length }}</h3></div><button class="icon-button" type="button" @click="bulkRegenerationPreview = null">×</button></div>
          <p class="muted">Проверено: {{ bulkRegenerationPreview.items.length }} · изменится: {{ bulkChangedItems.length }} · без изменений: {{ bulkUnchangedItems.length }}. Ручные личности пропущены; безопасные изменения получат отдельные резервные копии.</p>
          <p v-if="bulkIndividualConfirmationItems.length" class="notice error">{{ bulkIndividualConfirmationItems.length }} профилей с чувствительными ручными изменениями исключены из массового применения. Откройте каждый профиль, сравните канон и подтвердите обновление отдельно.</p>
          <p v-if="bulkRegenerationPreview.audit.maximumSimilarity >= PERSONA_SIMILARITY_WARNING_THRESHOLD" class="notice error">⚠ Предложенные личности слишком похожи: максимальное сходство {{ bulkRegenerationPreview.audit.maximumSimilarity.toFixed(3) }}.</p>
          <div class="audit-grid compact-audit"><article><span>Уникальных личностей</span><strong>{{ bulkRegenerationPreview.audit.uniquePersonaCount }}</strong></article><article><span>Уникальных стилей речи</span><strong>{{ bulkRegenerationPreview.audit.uniqueSpeechFingerprintCount }}</strong></article><article><span>Максимальное сходство</span><strong>{{ bulkRegenerationPreview.audit.maximumSimilarity.toFixed(3) }}</strong></article><article><span>Ошибок связности</span><strong>{{ bulkRegenerationPreview.audit.coherenceErrors.length }}</strong></article></div>
          <div class="bulk-preview-list"><article v-for="item in bulkRegenerationPreview.items" :key="item.personaId"><strong>{{ item.username }}</strong><span>{{ item.current.identity.firstName }} → {{ item.proposed.identity.firstName }}<template v-if="item.proposed.identity.preferredName"> / {{ item.proposed.identity.preferredName }}</template></span><small><template v-if="item.changed">Будет изменена</template><template v-else>Без изменений — будет пропущена</template> · ручных разделов: {{ item.preservedManualOverrides.length }}</small><small>{{ item.reason || 'Причина не указана сервером' }}</small><small v-if="item.requiresIndividualConfirmation" class="notice error">Нужно индивидуальное подтверждение; массово не применяется.</small><button class="text-button" type="button" @click="openBulkPersonaPreview(item)">{{ item.requiresIndividualConfirmation ? 'Открыть и подтвердить отдельно' : 'Открыть полное сравнение' }}</button></article></div>
          <div class="modal-actions"><button class="secondary" type="button" @click="bulkRegenerationPreview = null">Отмена</button><button class="primary" type="button" :disabled="personaBusy || !bulkApplicableItems.length" @click="applyBulkRegeneration">Применить безопасные изменения: {{ bulkApplicableItems.length }}</button></div>
        </template>
      </section>
    </div>
  </div>
</template>
