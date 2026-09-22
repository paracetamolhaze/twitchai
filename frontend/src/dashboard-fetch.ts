/** Retry only reads: a failed write may already have been accepted by the server. */
export async function dashboardFetch(
  url: string,
  options: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const read = ['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase())
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetcher(url, options)
    } catch (error) {
      if (options.signal?.aborted || !(error instanceof TypeError)) throw error
      if (read && attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 350))
        continue
      }
      throw new Error(read
        ? 'Не удалось связаться с сервером. Проверьте подключение и обновите страницу.'
        : 'Связь с сервером прервалась. Команда могла выполниться. Обновите страницу, чтобы проверить состояние.')
    }
  }
}
