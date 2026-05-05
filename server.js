// Playwright-backed YouTube transcript service.
//
// Strategy: open the watch page in a real Chromium so YouTube's player
// initializes (and mints a session PO token in its own context). Extract
// the captionTracks baseUrl from ytInitialPlayerResponse, then fetch the
// timedtext JSON3 from inside that page so the request reuses YouTube's
// own session cookies/headers — bypassing the unauthenticated lockout.

import express from "express";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SHARED_SECRET = process.env.SHARED_SECRET;
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
    }).catch((e) => {
      browserPromise = null;
      throw e;
    });
  }
  return browserPromise;
}

function authOk(req) {
  if (!SHARED_SECRET) return true;
  return req.get("authorization") === `Bearer ${SHARED_SECRET}`;
}

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post("/transcript", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: "unauthorized" });

  const { videoId, lang = "en" } = req.body ?? {};
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
      if (t === "image" || t === "media" || t === "font" || t === "stylesheet") return route.abort();
      return route.continue();
    });

    await page.goto(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      waitUntil: "domcontentloaded",
    });

    // Dismiss EU consent if present (some regions).
    await page.locator('button[aria-label*="Accept" i]').first().click({ timeout: 2500 }).catch(() => {});
    await page.locator('form[action*="consent"] button').first().click({ timeout: 2500 }).catch(() => {});

    // Resolve ytInitialPlayerResponse: prefer window global, fall back to
    // regex over the rendered HTML (the inline script that sets it).
    let playerResponse = await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      return window.ytInitialPlayerResponse ?? null;
    });

    if (!playerResponse) {
      const html = await page.content();
      const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|<\/script)/s);
      if (m) {
        try { playerResponse = JSON.parse(m[1]); } catch { /* fall through */ }
      }
    }

    if (!playerResponse) {
      // One more retry: wait for the player to initialize then re-check the global.
      await page.waitForFunction(() => "ytInitialPlayerResponse" in window, { timeout: 10_000 }).catch(() => {});
      playerResponse = await page.evaluate(() => {
        // eslint-disable-next-line no-undef
        return window.ytInitialPlayerResponse ?? null;
      });
    }

    if (!playerResponse) {
      return res.status(500).json({ error: "ytInitialPlayerResponse not found in window or HTML" });
    }

    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (!tracks.length) {
      return res.status(404).json({ error: "this video has no captions" });
    }

    // Prefer requested lang, manual over asr; fall back to first.
    const pick =
      tracks.find((t) => t.languageCode === lang && !t.kind) ||
      tracks.find((t) => t.languageCode === lang) ||
      tracks.find((t) => !t.kind) ||
      tracks[0];
    const baseUrl = pick?.baseUrl;
    if (!baseUrl) {
      return res.status(404).json({ error: "no captionTrack baseUrl" });
    }

    // Fetch the timedtext URL from inside the browser context — this carries
    // the page's session cookies and PO token, which the unauthenticated
    // server-side fetch lacks.
    const captionUrl = baseUrl + "&fmt=json3";
    const json = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) return { __status: r.status };
      try {
        return await r.json();
      } catch {
        const text = await r.text();
        return { __body: text };
      }
    }, captionUrl);

    if (json?.__status) {
      return res.status(502).json({ error: `timedtext returned ${json.__status}` });
    }

    const events = json?.events ?? [];
    const text = events
      .flatMap((e) => (e?.segs ?? []).map((s) => s?.utf8 ?? ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) {
      return res.status(404).json({ error: "transcript empty after parsing" });
    }
    return res.json({ text, ms: Date.now() - t0, source: pick.kind === "asr" ? "auto" : "manual" });
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
