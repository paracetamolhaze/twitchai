import { describe, expect, it } from 'vitest';
import { dashboardStatus, DashboardState } from '../frontend/src/dashboard-status';
const connected: DashboardState = { online: true, channel: 'channel', paused: false, live: true, activeBots: 3, health: [] };
describe('honest dashboard status', () => {
  it('surfaces failed hearing even with connected bots', () => {
    const result = dashboardStatus({ ...connected, health: [{ label: 'Слух', tone: 'error', status: 'Не слышит', detail: 'Недостаточно средств' }] });
    expect(result.title).toContain('Слух');
    expect(result.text).toContain('Недостаточно средств');
  });
  it('does not promise readiness merely because the stream is offline', () => {
    expect(dashboardStatus({ ...connected, live: false }).title).not.toContain('Всё готово');
  });
  it('keeps operator pause distinct from disconnected accounts', () => {
    expect(dashboardStatus({ ...connected, paused: true, activeBots: 0 }).title).toBe('Боты на паузе');
  });
  it('does not mistake unavailable backend data for an unconfigured channel', () => {
    expect(dashboardStatus({ ...connected, online: false, channel: '' }).title).toBe('Нет связи с сервером');
  });
});
