# Dashboard Twitch AI Viewers

Отдельное приложение Vue/Vite для Vercel. Оно не подключается к Twitch, FFmpeg или Gemini — все постоянные соединения живут в Railway backend.

```bash
npm ci
VITE_API_URL=http://localhost:3000 npm run dev
```

В Vercel задайте `VITE_API_URL` с публичным адресом Railway backend. Оператор вводит `DASHBOARD_TOKEN` один раз; backend обменивает его на подписанную HttpOnly-сессию. Токен не хранится в JavaScript, `localStorage` или `sessionStorage`.
