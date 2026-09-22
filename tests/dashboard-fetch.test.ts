import { describe, expect, it, vi } from 'vitest';
import { dashboardFetch } from '../frontend/src/dashboard-fetch';

describe('dashboard network recovery', () => {
  it('retries a dropped read once', async () => {
    const response = new Response('{}');
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(response);
    expect(await dashboardFetch('/api/overview', {}, fetcher)).toBe(response);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never repeats an ambiguous start command', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(dashboardFetch('/api/settings', { method: 'PATCH' }, fetcher)).rejects.toThrow('Обновите страницу');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds read retries and explains an unavailable server', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(dashboardFetch('/api/overview', {}, fetcher)).rejects.toThrow('Не удалось связаться');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
