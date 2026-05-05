# DIY Poppy Transcript Service

Headless-Chromium microservice that fetches YouTube transcripts on behalf of the main app.

The main app (Vercel) cannot run Chromium and YouTube blocks the unauthenticated transcript API. This service runs a real browser, lets BotGuard run in its native environment, opens the YouTube watch page, clicks "Show transcript", and scrapes the rendered segments.

## Deploy to Render (free tier)

1. Push the contents of this directory to a new GitHub repo (or a subdirectory of an existing repo).
2. Sign in to https://render.com → **New** → **Web Service** → connect the repo.
3. Render auto-detects the `render.yaml` and the Dockerfile. Click **Create Web Service**.
4. Wait ~5 minutes for the first build (downloads the Playwright image).
5. From the service's Settings → Environment, copy the auto-generated `SHARED_SECRET`.
6. Copy the service URL (e.g. `https://diy-poppy-transcript.onrender.com`).

Then in the main DIY Poppy project:

```bash
cd <project root>
echo "https://diy-poppy-transcript.onrender.com" | npx vercel env add TRANSCRIPT_SERVICE_URL production
echo "<SHARED_SECRET>" | npx vercel env add TRANSCRIPT_SERVICE_SECRET production
npx vercel --prod --yes
```

## Free-tier caveats

- Render's free tier sleeps the service after 15 minutes of inactivity. The first transcript request after a sleep takes ~30s (cold start: Chromium launch). Subsequent requests in the same hot window are fast (~5s).
- Each request opens a fresh browser context, so concurrent requests scale linearly with the (limited) free CPU.
- Render free tier doesn't support persistent disk; nothing is cached between restarts.

## Local test

```bash
cd services/transcript
npm install
npx playwright install chromium
node server.js
# in another terminal:
curl -X POST http://localhost:3000/transcript -H 'content-type: application/json' -d '{"videoId":"dQw4w9WgXcQ"}'
```
