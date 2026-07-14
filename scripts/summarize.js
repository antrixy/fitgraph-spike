#!/usr/bin/env node
// summarize.js — run AFTER diff.js, BEFORE commit.
// Reads today's diffs/YYYY-MM-DD/*.json and every app's status.json, and emits
// ONE triage file: diffs/YYYY-MM-DD/summary.json
// Purpose: Mon/Thu review starts (and usually ends) here — full diffs are only
// opened for rows flagged interesting. Keeps review time flat as app count grows.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "registry.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const dayDir = path.join(ROOT, "diffs", today);

// Price-signal heuristics over diff content. Deliberately dumb (spike rule):
// currency symbols/codes, price-ish fields, promo vocabulary.
const PRICE_TEXT = /[$€£]\s?\d|\bUSD\b|\/\s?(mo|month|yr|year)\b|per (month|year)|lifetime|free trial|intro(ductory)? (price|offer)|% (off|discount)/i;
const PRICE_FIELDS = new Set(["price", "formattedPrice", "priceText", "offersIAP", "IAPRange"]);

// Integration-lexicon heuristic mirrors the extractor's keyword list (A.7).
const INTEGRATION = /\b(garmin|apple health|healthkit|health connect|google fit|fitbit|strava|wear os|apple watch|whoop|oura|withings|samsung health)\b/i;

const rows = [];
let interesting = 0;

for (const app of registry.apps) {
  const row = {
    product_id: app.product_id,
    changed: [],            // e.g. ["itunes:version", "pricing_page"]
    price_signal: false,    // price-ish content or fields in today's diff
    integration_signal: false,
    version_unreported: false,
    failed_sources: [],     // sources whose status != ok today
  };

  // source health from status.json
  const statusFile = path.join(ROOT, "apps", app.product_id, "status.json");
  if (fs.existsSync(statusFile)) {
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    for (const [src, s] of Object.entries(status.sources ?? {})) {
      if (s.status !== "ok") row.failed_sources.push(src);
    }
  } else {
    row.failed_sources.push("no-status-file");
  }

  // today's diff, if any
  const diffFile = path.join(dayDir, `${app.product_id}.json`);
  if (fs.existsSync(diffFile)) {
    const d = JSON.parse(fs.readFileSync(diffFile, "utf8"));
    for (const [src, rec] of Object.entries(d.sources ?? {})) {
      if (rec.version_unreported) row.version_unreported = true;
      if (rec.field_changes) {
        for (const c of rec.field_changes) {
          row.changed.push(`${src}:${c.field}`);
          const blob = `${JSON.stringify(c.old)} ${JSON.stringify(c.new)}`;
          if (PRICE_FIELDS.has(c.field) || PRICE_TEXT.test(blob)) row.price_signal = true;
          if (INTEGRATION.test(blob)) row.integration_signal = true;
        }
      }
      if (src === "pricing_page") {
        row.changed.push("pricing_page");
        const blob = [...(rec.added ?? []), ...(rec.removed ?? [])].map((e) => e.text).join(" ");
        if (PRICE_TEXT.test(blob)) row.price_signal = true;
        if (INTEGRATION.test(blob)) row.integration_signal = true;
      }
    }
  }

  if (row.changed.length || row.failed_sources.length || row.version_unreported) {
    if (row.price_signal || row.integration_signal) interesting++;
    rows.push(row);
  }
}

// Sort: price signals first, then integration, then the rest; failures last section.
rows.sort((a, b) =>
  (b.price_signal - a.price_signal) ||
  (b.integration_signal - a.integration_signal) ||
  (b.changed.length - a.changed.length)
);

const summary = {
  date: today,
  apps_total: registry.apps.length,
  apps_changed: rows.filter((r) => r.changed.length).length,
  apps_with_failures: rows.filter((r) => r.failed_sources.length).length,
  interesting,
  rows,
};

fs.mkdirSync(dayDir, { recursive: true });
fs.writeFileSync(path.join(dayDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  `summary: ${summary.apps_changed} changed, ${interesting} interesting, ${summary.apps_with_failures} with failures -> diffs/${today}/summary.json`
);
