export interface DashboardState {
  online: boolean; channel: string; paused: boolean; live: boolean; activeBots: number;
  health: Array<{ label: string; tone: string; status: string; detail: string }>;
}
export type DashboardAction = 'settings' | 'toggle' | 'bots' | 'brain' | 'chat' | 'refresh';
export function dashboardStatus(props: DashboardState): { title: string; text: string; label: string; action: DashboardAction; actionLabel: string; warning?: boolean } {
  if (!props.online) return { title: 'Нет связи с сервером', text: 'Не удалось обновить данные. Проверьте соединение и попробуйте обновить панель.', label: 'НЕТ СОЕДИНЕНИЯ', action: 'refresh', actionLabel: 'Повторить подключение', warning: true }
  if (!props.channel) return { title: 'Подключим ваш канал', text: 'Укажите Twitch-канал, чтобы боты могли следить за эфиром и общаться в чате.', label: 'НАСТРОЙКА КАНАЛА', action: 'settings', actionLabel: 'Настроить канал' }
  if (props.paused) return { title: 'Боты на паузе', text: 'Сообщения не отправляются. Запустите ботов, когда будете готовы продолжить.', label: 'ВЫ УПРАВЛЯЕТЕ ЭФИРОМ', action: 'toggle', actionLabel: 'Запустить ботов' }
  const problem = props.health.find(item => item.tone === 'error' && item.label !== 'Чат Twitch');
  if (problem) return { title: `${problem.label}: ${problem.status}`, text: problem.detail, label: 'НУЖНО ВНИМАНИЕ', action: 'brain', actionLabel: 'Проверить подключение ИИ', warning: true };
  if (!props.live) return { title: 'Канал сейчас офлайн', text: 'Канал сейчас офлайн. Здесь появятся события и ответы, когда начнётся трансляция.', label: 'ОЖИДАНИЕ ЭФИРА', action: 'chat', actionLabel: 'Открыть историю чата' }
  if (props.activeBots === 0) return { title: 'Эфир идёт. Подключите ботов', text: 'Сейчас ни один бот не подключён к чату. Проверьте аккаунты и их авторизацию.', label: 'НУЖНО ВАШЕ ВНИМАНИЕ', action: 'bots', actionLabel: 'Проверить аккаунты', warning: true }
  if (props.health.some(item => item.tone === 'pending')) return { title: 'Подключаемся к эфиру', text: 'Проверяем медиапоток и ждём первые данные. Ответы появятся после обработки.', label: 'ПОДКЛЮЧЕНИЕ', action: 'brain', actionLabel: 'Посмотреть состояние' };
  return { title: 'Боты подключены к эфиру', text: 'Боты следят за эфиром и выбирают, когда вступить в разговор. Все последние события — ниже.', label: 'ЭФИР ИДЁТ', action: 'chat', actionLabel: 'Открыть чат' }
}
