#!/usr/bin/env node
// extract.js — run AFTER diff.js, BEFORE commit.
// Emits claims/YYYY-MM-DD/*.json from today's snapshots vs last-ok, per frozen spec §3.
// Exactly two claim types. Keyword lexicon is deliberately dumb (A.8); each hit carries
// an excerpt window so Mon/Thu review is fast.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(process.cwd());
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "registry.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const outDir = path.join(ROOT, "claims", today);

const LEXICON = ["garmin", "apple health", "health connect", "fitbit", "strava", "google fit", "wear os", "whoop", "oura"];

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function lastOk(productId, source, file) {
  const statusPath = `apps/${productId}/status.json`;
  let commits;
  try { commits = git(["log", "--format=%H", "--", statusPath]).trim().split("\n").filter(Boolean); }
  catch { return null; }
  for (const c of commits) {
    let st;
    try { st = JSON.parse(git(["show", `${c}:${statusPath}`])); } catch { continue; }
    if (st.sources?.[source]?.status === "ok") {
      try { return { commit: c, content: git(["show", `${c}:apps/${productId}/${file}`]) }; }
      catch { return null; }
    }
  }
  return null;
}

function excerpt(text, keyword, win = 120) {
  const i = text.toLowerCase().indexOf(keyword);
  if (i < 0) return null;
  return text.slice(Math.max(0, i - win), i + keyword.length + win).replace(/\s+/g, " ").trim();
}

const claims = [];

for (const app of registry.apps) {
  const dir = path.join(ROOT, "apps", app.product_id);
  const statusFile = path.join(dir, "status.json");
  if (!fs.existsSync(statusFile)) continue;
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));

  for (const [source, file] of [["itunes", "itunes.json"], ["play", "play.json"]]) {
    if (status.sources?.[source]?.status !== "ok") continue;
    const prev = lastOk(app.product_id, source, file);
    if (!prev) continue;
    const oldSnap = JSON.parse(prev.content);
    const newSnap = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const o = oldSnap.result, n = newSnap.result;
    const observed_at = newSnap.fetched_at;

    // --- price_changed ---
    const priceFields = source === "itunes"
      ? [["price", "upfront_price_usd"]]
      : [["price", "upfront_price"], ["priceText", "price_text"], ["IAPRange", "iap_range"]];
    for (const [field, canonical] of priceFields) {
      const ov = o?.[field] ?? null, nv = n?.[field] ?? null;
      if (JSON.stringify(ov) !== JSON.stringify(nv)) {
        claims.push({
          claim_type: "price_changed",
          product: app.product_id,
          field: canonical,
          old_value: ov,
          new_value: nv,
          observed_at,
          evidence: [{ tier: "vendor_asserted", source: source === "itunes" ? "itunes_lookup" : "play_listing", snapshot_commit: "PENDING_COMMIT", prev_ok_commit: prev.commit }],
          source_count: 1,
        });
      }
    }

    // --- integration_changed via lexicon on text-field diffs ---
    const textFields = source === "itunes" ? ["releaseNotes", "description"] : ["recentChanges", "description"];
    for (const f of textFields) {
      const oldT = String(o?.[f] ?? "").toLowerCase();
      const newT = String(n?.[f] ?? "").toLowerCase();
      if (oldT === newT) continue;
      for (const kw of LEXICON) {
        const inOld = oldT.includes(kw), inNew = newT.includes(kw);
        if (inOld === inNew) continue; // pre-existing mention or absent both sides: not a signal
        claims.push({
          claim_type: "integration_changed",
          product: app.product_id,
          integration: kw.replace(/\s+/g, "_"),
          direction: inNew ? "added" : "removed",
          observed_at,
          evidence: [{
            tier: "vendor_asserted",
            source: f === "releaseNotes" || f === "recentChanges" ? "release_notes" : "app_description",
            excerpt: excerpt(inNew ? String(n?.[f]) : String(o?.[f]), kw),
            snapshot_commit: "PENDING_COMMIT",
            prev_ok_commit: prev.commit,
          }],
          source_count: 1,
        });
      }
    }
  }
}

if (claims.length) {
  fs.mkdirSync(outDir, { recursive: true });
  // one file per claim, review-friendly
  claims.forEach((c, i) => {
    const name = `${c.product}.${c.claim_type}.${String(i).padStart(3, "0")}.json`;
    fs.writeFileSync(path.join(outDir, name), JSON.stringify({ ...c, review: { verdict: null, reviewed_at: null } }, null, 2) + "\n");
  });
  console.log(`extract: ${claims.length} claim(s)`);
} else {
  console.log("extract: no claims today");
}
