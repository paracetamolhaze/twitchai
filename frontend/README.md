# Twitch AI Viewers Dashboard

The dashboard is a standalone Vue/Vite application intended for Vercel. It never opens Twitch, FFmpeg, or Gemini connections.

```bash
npm ci
VITE_API_URL=http://localhost:3000 npm run dev
```

Configure `VITE_API_URL` in Vercel with the public Railway backend origin. The operator enters `DASHBOARD_TOKEN` at runtime; it is kept in `sessionStorage`, not bundled into the frontend.
