<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  channel: string; live: boolean; paused: boolean; online: boolean; busy: boolean
  activeBots: number; totalBots: number; messages: number; cost: number; duration: string
  pendingFeedback: number
  activities: Array<{ id: string; timestamp: number; title: string; meta: string; tone: string }>
  bots: Array<{ username: string; name: string; status: string; connected: boolean }>
  health: Array<{ label: string; tone: string; status: string; detail: string }>
}>()
const emit = defineEmits<{ navigate: [page: 'bots' | 'brain' | 'chat' | 'rules' | 'settings']; toggle: [] }>()
const filter = ref('all')
const filters = [{ id: 'all', label: 'Всё' }, { id: 'bot', label: 'Ответы ботов' }, { id: 'event', label: 'События' }]
const visible = computed(() => props.activities.filter(item => filter.value === 'all' || (filter.value === 'bot' ? item.tone === 'bot' : item.id.startsWith('event-'))).slice(0, 12))
const status = computed(() => {
  if (!props.online) return { title: 'Нет связи с сервером', text: 'Не удалось обновить данные. Проверьте соединение и попробуйте обновить панель.', label: 'НЕТ СОЕДИНЕНИЯ' }
  if (!props.channel) return { title: 'Подключим ваш канал', text: 'Укажите Twitch-канал, чтобы боты могли следить за эфиром и общаться в чате.', label: 'ПЕРВЫЙ ШАГ' }
  if (props.paused) return { title: 'Боты на паузе', text: 'Сообщения не отправляются. Запустите ботов, когда будете готовы продолжить.', label: 'ВЫ УПРАВЛЯЕТЕ ЭФИРОМ' }
  if (!props.live) return { title: 'Всё готово к следующему эфиру', text: 'Канал сейчас офлайн. Здесь появятся события и ответы, когда начнётся трансляция.', label: 'ОЖИДАНИЕ ЭФИРА' }
  if (props.activeBots === 0) return { title: 'Эфир идёт. Подключите ботов', text: 'Сейчас ни один бот не подключён к чату. Проверьте аккаунты и их авторизацию.', label: 'НУЖНО ВАШЕ ВНИМАНИЕ' }
  return { title: 'Ваш чат живёт в моменте', text: 'Боты следят за эфиром и выбирают, когда вступить в разговор. Все последние события — ниже.', label: 'ЭФИР ИДЁТ' }
})
const actionLabel = computed(() => !props.channel ? 'Настроить канал' : props.paused ? 'Запустить ботов' : props.live && props.activeBots === 0 ? 'Проверить аккаунты' : 'Открыть чат')
function act() {
  if (!props.channel) emit('navigate', 'settings')
  else if (props.paused) emit('toggle')
  else emit('navigate', props.live && props.activeBots === 0 ? 'bots' : 'chat')
}
function time(at: number) { return new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) }
function date(at: number) { return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) }
</script>

<template>
  <div class="dashboard-home">
    <div class="home-heading"><div><p class="eyebrow">ВАША КОМАНДА В ЧАТЕ</p><h1>Обзор эфира</h1><p>Всё, что происходит с вашим AI-чатом.</p></div><span class="home-date">{{ new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) }}</span></div>
    <section class="stream-hero">
      <div class="hero-copy"><span class="hero-kicker"><i :class="{ live }"></i>{{ status.label }}</span><h2>{{ status.title }}</h2><p>{{ status.text }}</p><button class="hero-action" :disabled="busy || !online" @click="act">{{ actionLabel }} <span aria-hidden="true">↗</span></button></div>
      <div class="hero-art" aria-hidden="true"><div class="signal-orbit orbit-one"></div><div class="signal-orbit orbit-two"></div><div class="signal-core"><svg viewBox="0 0 64 64"><path d="M14 17h36v25H34L23 51v-9h-9z"/><path d="M25 26v8m14-8v8"/></svg></div><span class="orbit-dot"></span></div>
    </section>
    <section class="home-stats" aria-label="Показатели эфира">
      <article><span>Боты в чате <b class="stat-symbol">◎</b></span><strong>{{ activeBots }}<small> / {{ totalBots }}</small></strong><p>подключены сейчас</p></article>
      <article><span>Сообщения <b class="stat-symbol">↗</b></span><strong>{{ messages }}</strong><p>подтверждены за эфир</p></article>
      <article><span>Расход на эфир <b class="stat-symbol">$</b></span><strong>${{ cost.toFixed(3) }}</strong><p>оценка стоимости ИИ</p></article>
      <article><span>Время работы <b class="stat-symbol">◷</b></span><strong class="duration-value">{{ duration }}</strong><p>с запуска приложения</p></article>
    </section>
    <div class="home-columns">
      <section class="activity-panel">
        <div class="home-panel-heading"><div><h2>Последняя активность</h2><p>События эфира и сообщения в чате</p></div><span class="count-pill">{{ activities.length }}</span></div>
        <div class="activity-tabs" aria-label="Фильтр активности"><button v-for="tab in filters" :key="tab.id" :aria-pressed="filter === tab.id" :class="{ selected: filter === tab.id }" @click="filter = tab.id">{{ tab.label }}</button></div>
        <div v-if="visible.length" class="activity-list">
          <article v-for="item in visible" :key="item.id" class="activity-row">
            <span :class="['activity-icon', { bot: item.tone === 'bot' }]" aria-hidden="true">{{ item.tone === 'bot' ? '↗' : item.id.startsWith('event-') ? '◇' : '≡' }}</span>
            <div class="activity-body"><div class="activity-meta"><b>{{ item.tone === 'bot' ? 'Ответ бота' : item.id.startsWith('event-') ? 'Событие эфира' : 'Сообщение зрителя' }}</b><span>{{ date(item.timestamp) }} · {{ time(item.timestamp) }}</span></div><details v-if="item.title.length > 180"><summary>{{ item.title.slice(0, 177) }}…<span class="expand-copy">Читать полностью</span></summary><p>{{ item.title }}</p></details><p v-else>{{ item.title }}</p></div>
          </article>
        </div>
        <div v-else class="home-empty"><span aria-hidden="true">◌</span><h3>{{ filter === 'bot' ? 'Ответов ботов пока нет' : 'Здесь появится ваш эфир' }}</h3><p>{{ filter === 'bot' ? 'Когда бот отправит сообщение, оно появится в этой ленте.' : 'После начала трансляции вы увидите, что заметили боты и как они отреагировали.' }}</p></div>
        <button class="panel-footer-link" @click="emit('navigate', 'chat')">Перейти к чату и оценкам <span aria-hidden="true">→</span></button>
      </section>
      <aside class="home-right">
        <section class="roster-panel"><div class="home-panel-heading"><div><h2>Ваша команда</h2><p>{{ totalBots }} ботов · {{ activeBots }} в чате</p></div><button class="text-button" @click="emit('navigate', 'bots')">Все →</button></div><div v-if="bots.length" class="home-roster"><article v-for="(bot, index) in bots.slice(0, 5)" :key="bot.username"><span :class="['roster-avatar', `avatar-${index % 3}`]">{{ bot.username.slice(0, 2).toUpperCase() }}</span><div><strong>{{ bot.username }}</strong><small>{{ bot.name }}</small></div><span :class="['roster-dot', { connected: bot.connected }]" :title="bot.status"><span class="sr-only">{{ bot.status }}</span></span></article></div><p v-else class="muted roster-empty">Подключите первый аккаунт в разделе «Аккаунты».</p></section>
        <section class="feedback-callout"><span class="feedback-icon" aria-hidden="true">✦</span><h2>Лучше с каждым ответом</h2><p>Оценивайте сообщения ботов — ваши замечания станут правилами для следующих ответов.</p><button @click="emit('navigate', 'rules')">{{ pendingFeedback ? `${pendingFeedback} оценок ждут разбора` : 'Как работает обучение' }} <span aria-hidden="true">→</span></button></section>
        <details class="system-disclosure"><summary><span class="system-dot" :class="{ connected: online }"></span>Состояние системы <span class="disclosure-plus">+</span></summary><div v-for="item in health" :key="item.label" class="system-row"><span>{{ item.label }}</span><b :title="item.detail">{{ item.status }}</b></div><button class="text-button" @click="emit('navigate', 'brain')">Открыть диагностику →</button></details>
      </aside>
    </div>
  </div>
</template>
