// Playwright-backed YouTube transcript service.
// Deploys to Render free tier. Uses a real Chromium so YouTube's BotGuard
// is satisfied and the transcript panel renders normally.

import express from "express";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SHARED_SECRET = process.env.SHARED_SECRET; // required in prod
const PORT = Number(process.env.PORT ?? 3000);

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
      executablePath: process.env.CHROMIUM_PATH || undefined,
    }).catch((e) => {
      browserPromise = null;
      throw e;
    });
  }
  return browserPromise;
}

function authOk(req) {
  if (!SHARED_SECRET) return true; // dev mode
  return req.get("authorization") === `Bearer ${SHARED_SECRET}`;
}

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post("/transcript", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: "unauthorized" });

  const { videoId } = req.body ?? {};
  if (!/^[\w-]{11}$/.test(videoId ?? "")) {
    return res.status(400).json({ error: "missing or invalid videoId" });
  }

  const t0 = Date.now();
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);

    // Block heavy assets — speeds up first paint dramatically.
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      return route.continue();
    });

    await page.goto(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      waitUntil: "domcontentloaded",
    });

    // Dismiss the EU consent dialog if present.
    await page.locator('button[aria-label*="Accept" i]').first().click({ timeout: 3000 }).catch(() => {});
    await page.locator('form[action*="consent"] button').first().click({ timeout: 3000 }).catch(() => {});

    // Click the description "...more" expander.
    await page
      .locator('tp-yt-paper-button#expand, ytd-text-inline-expander #expand')
      .first()
      .click({ timeout: 8000 });

    // Click "Show transcript" button.
    await page
      .getByRole("button", { name: /show transcript/i })
      .first()
      .click({ timeout: 8000 });

    // Wait for transcript segments to render.
    const segLoc = page.locator("ytd-transcript-segment-renderer .segment-text, ytd-transcript-segment-renderer yt-formatted-string.segment-text");
    await segLoc.first().waitFor({ timeout: 15_000 });

    // Some videos have section headers; just grab segment-text spans.
    const segments = await segLoc.allInnerTexts();
    const text = segments.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");

    if (!text) {
      return res.status(404).json({ error: "transcript empty after extraction" });
    }
    return res.json({ text, ms: Date.now() - t0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  } finally {
    if (context) await context.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`transcript service listening on :${PORT}`);
});
