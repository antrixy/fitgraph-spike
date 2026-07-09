#!/usr/bin/env node
// snapshot.js — daily append-only observation pass.
// Writes apps/{product_id}/{itunes.json, play.json, pricing.html, status.json}
// Every artifact embeds fetched_at (A.5). Failures recorded, never treated as "no change".
// Locale pinned: country=us, lang=en (A.3). Small random delays between apps (A.4).

import fs from "node:fs";
import path from "node:path";
import gplay from "google-play-scraper";

const UA = "fitgraph-spike/0.1 (+https://github.com/antrixy; research crawler; contact via GitHub)";
const ROOT = path.resolve(process.cwd());
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "registry.json"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 1500 + Math.floor(Math.random() * 3500);

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

async function fetchItunes(app) {
  const fetched_at = new Date().toISOString();
  const url = `https://itunes.apple.com/lookup?id=${app.itunes_id}&country=us`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const body = await res.json();
  if (!body.resultCount) throw new Error("empty_result");
  return { fetched_at, source: "itunes_lookup", url, result: body.results[0] };
}

async function fetchPlay(app) {
  const fetched_at = new Date().toISOString();
  const result = await gplay.app({ appId: app.play_id, country: "us", lang: "en" });
  return { fetched_at, source: "google_play_scraper", appId: app.play_id, result };
}

async function fetchPricing(app) {
  const fetched_at = new Date().toISOString();
  const res = await fetch(app.pricing_url, {
    headers: { "User-Agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const html = await res.text();
  return { fetched_at, html };
}

function classify(err) {
  const m = String(err && err.message || err);
  if (/http_429|captcha/i.test(m)) return "rate_limited_or_captcha";
  if (/http_\d+/.test(m)) return m.match(/http_\d+/)[0];
  if (/timeout|abort/i.test(m)) return "timeout";
  if (/empty_result/.test(m)) return "empty_result";
  if (/JSON|parse|Unexpected/i.test(m)) return "parse_error";
  return "other";
}

async function main() {
  const runStarted = new Date().toISOString();
  for (const app of registry.apps) {
    const dir = path.join(ROOT, "apps", app.product_id);
    const status = { run_started: runStarted, sources: {} };

    // iTunes
    if (app.itunes_id == null) {
      status.sources.itunes = { status: "absent" }; // structurally absent, not failed
    } else {
      try {
        const snap = await fetchItunes(app);
        writeJSON(path.join(dir, "itunes.json"), snap);
        status.sources.itunes = { status: "ok", fetched_at: snap.fetched_at };
      } catch (e) {
        status.sources.itunes = { status: "failed", reason: classify(e), at: new Date().toISOString() };
      }
    }
    await sleep(jitter());

    // Play
    if (app.play_id == null) {
      status.sources.play = { status: "absent" };
    } else {
      try {
        const snap = await fetchPlay(app);
        writeJSON(path.join(dir, "play.json"), snap);
        status.sources.play = { status: "ok", fetched_at: snap.fetched_at };
      } catch (e) {
        status.sources.play = { status: "failed", reason: classify(e), at: new Date().toISOString() };
      }
    }
    await sleep(jitter());

    // Pricing page
    if (!app.pricing_url) {
      status.sources.pricing = { status: "absent" };
    } else {
      try {
        const snap = await fetchPricing(app);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "pricing.html"), snap.html);
        writeJSON(path.join(dir, "pricing.meta.json"), { fetched_at: snap.fetched_at, url: app.pricing_url });
        status.sources.pricing = { status: "ok", fetched_at: snap.fetched_at };
      } catch (e) {
        status.sources.pricing = { status: "failed", reason: classify(e), at: new Date().toISOString() };
      }
    }

    writeJSON(path.join(dir, "status.json"), status);
    console.log(`${app.product_id}: itunes=${status.sources.itunes.status} play=${status.sources.play.status} pricing=${status.sources.pricing.status}`);
    await sleep(jitter());
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
