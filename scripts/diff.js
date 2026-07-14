#!/usr/bin/env node
// diff.js — run AFTER snapshot.js, BEFORE commit.
// Compares the working-tree snapshot against the last *ok* observation of the same
// source in git history (walks back past failed runs).
// Emits BOTH artifacts per changed app:
//   diffs/YYYY-MM-DD/{product_id}.md    — human review layer (Mon/Thu)
//   diffs/YYYY-MM-DD/{product_id}.json  — machine layer (re-extraction, scorecard)
// Pricing HTML is diffed at SENTENCE level over normalized visible text (A.6):
// word-level sets proved unreadable in review (2026-07-10 Fitbit diff).
// Field comparison is done over NORMALIZED text (whitespace/entities) but diffs
// store RAW values; snapshots are never modified (immutability rule).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(process.cwd());
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "registry.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const outDir = path.join(ROOT, "diffs", today);

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// Most recent commit where this app's status.json said `source` was ok,
// then that commit's version of `file`. Null if none exists yet.
// Optional `accept(parsedFile)` predicate keeps walking until it returns true —
// used to skip past sentinel-version snapshots (2026-07-14 JEFIT VARY bug).
function lastOkVersion(productId, source, file, accept) {
  const statusPath = `apps/${productId}/status.json`;
  let commits;
  try {
    commits = git(["log", "--format=%H", "--", statusPath]).trim().split("\n").filter(Boolean);
  } catch { return null; }
  for (const c of commits) {
    let st;
    try { st = JSON.parse(git(["show", `${c}:${statusPath}`])); } catch { continue; }
    if (st.sources?.[source]?.status === "ok") {
      let content;
      try { content = git(["show", `${c}:apps/${productId}/${file}`]); } catch { return null; }
      if (accept) {
        let parsed;
        try { parsed = JSON.parse(content); } catch { continue; }
        if (!accept(parsed)) continue; // keep walking back
      }
      return { commit: c, content };
    }
  }
  return null;
}

// --- Fix 2026-07-14 (Lose It! whitespace diff): normalize text fields before
// comparison. Collapses whitespace runs, decodes common HTML entities, and
// unifies <br> vs \n (Play vs iTunes encoding skew, observed 2026-07-14 Caliber).
// Applied at DIFF TIME only; raw snapshot values are stored in the diff output.
function normalizeForDiff(v) {
  if (typeof v !== "string") return v;
  return v
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")   // collapse spaces/tabs; preserve newlines
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// --- Fix 2026-07-14 (JEFIT "VARY"): Play reports "Varies with device" (scraper
// surfaces it as "VARY") for some apps. That is "version not reported", not a
// version change. Sentinel-valued versions never emit field_changes; instead the
// source record gets version_unreported: true. When the sentinel later flips back
// to a real version, we compare against the last REAL version in history so
// 17.2.6 -> VARY -> 17.3.0 emits exactly one change.
function isVersionSentinel(v) {
  return typeof v === "string" && /^(vary|varies with device)$/i.test(v.trim());
}

// A.6: strip tags/scripts/styles -> visible-text approximation.
function normalizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n") // block boundaries -> newlines
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Split normalized text into sentence-ish units: sentence punctuation or block newlines.
// Units under 3 chars are noise; drop them.
function toSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 3);
}

// Set-difference at sentence level. Order-insensitive by design: page sections
// move around constantly; we care about appearance/disappearance of statements.
// Deduplicated with occurrence counts: the same sentence often renders 2-5x per
// page (desktop/mobile/footer/accordion DOM copies) and duplicates add review
// noise without information (observed: WHOOP diff 2026-07-11).
function countUnique(arr) {
  const m = new Map();
  for (const s of arr) m.set(s, (m.get(s) || 0) + 1);
  return m;
}
function sentenceDiff(oldText, newText) {
  const oldCounts = countUnique(toSentences(oldText));
  const newCounts = countUnique(toSentences(newText));
  const added = [], removed = [];
  for (const [s, n] of newCounts) if (!oldCounts.has(s)) added.push({ text: s, occurrences: n });
  for (const [s, n] of oldCounts) if (!newCounts.has(s)) removed.push({ text: s, occurrences: n });
  if (!added.length && !removed.length) return null;
  const CAP = 80; // review sanity cap (unique sentences); JSON records truncation explicitly
  return {
    added: added.slice(0, CAP),
    removed: removed.slice(0, CAP),
    truncated: added.length > CAP || removed.length > CAP,
    added_total: added.length,
    removed_total: removed.length,
  };
}

// Fields worth watching per JSON source.
const ITUNES_FIELDS = ["price", "formattedPrice", "version", "releaseNotes", "description"];
const PLAY_FIELDS = ["price", "priceText", "version", "recentChanges", "description", "offersIAP", "IAPRange"];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj?.[f] ?? null;
  return out;
}

// Compare normalized; report raw. Version field gets sentinel handling.
// Returns { changes, versionUnreported }.
function jsonFieldDiff(oldObj, newObj, fields) {
  const a = pick(oldObj, fields), b = pick(newObj, fields);
  const changes = [];
  let versionUnreported = false;
  for (const f of fields) {
    if (f === "version" && (isVersionSentinel(a[f]) || isVersionSentinel(b[f]))) {
      if (isVersionSentinel(b[f])) versionUnreported = true;
      continue; // sentinel comparisons handled by caller against last real version
    }
    const an = normalizeForDiff(a[f]);
    const bn = normalizeForDiff(b[f]);
    if (JSON.stringify(an) !== JSON.stringify(bn)) changes.push({ field: f, old: a[f], new: b[f] });
  }
  return { changes, versionUnreported };
}

const short = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 500 ? s.slice(0, 500) + "…" : s;
};

let wroteAny = false;

for (const app of registry.apps) {
  const dir = path.join(ROOT, "apps", app.product_id);
  const statusFile = path.join(dir, "status.json");
  if (!fs.existsSync(statusFile)) continue;
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));

  const record = { product: app.product_id, name: app.name, date: today, sources: {} };
  const mdSections = [];

  // --- store JSON sources ---
  for (const [source, file, fields] of [
    ["itunes", "itunes.json", ITUNES_FIELDS],
    ["play", "play.json", PLAY_FIELDS],
  ]) {
    if (status.sources?.[source]?.status !== "ok") continue; // diff only ok->ok pairs
    const prev = lastOkVersion(app.product_id, source, file);
    if (prev == null) continue; // first ok observation
    const prevObj = JSON.parse(prev.content);
    const currObj = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const { changes, versionUnreported } = jsonFieldDiff(prevObj.result, currObj.result, fields);

    // Sentinel flip-back: current version is real but previous snapshot's was a
    // sentinel -> compare against last REAL version in history (one event, not two).
    const currVersion = currObj.result?.version ?? null;
    if (!isVersionSentinel(currVersion) && isVersionSentinel(prevObj.result?.version)) {
      const prevReal = lastOkVersion(app.product_id, source, file,
        (p) => p?.result?.version != null && !isVersionSentinel(p.result.version));
      const lastRealVersion = prevReal ? JSON.parse(prevReal.content).result.version : null;
      if (lastRealVersion != null && JSON.stringify(lastRealVersion) !== JSON.stringify(currVersion)) {
        changes.push({ field: "version", old: lastRealVersion, new: currVersion,
          note: `compared against last real version (${prevReal.commit.slice(0, 8)}); intervening snapshots reported a sentinel` });
      }
    }

    if (changes.length || versionUnreported) {
      record.sources[source] = {
        prev_ok_commit: prev.commit,
        prev_fetched_at: prevObj.fetched_at,
        curr_fetched_at: currObj.fetched_at,
        ...(versionUnreported ? { version_unreported: true } : {}),
        ...(changes.length ? { field_changes: changes } : {}),
      };
      if (changes.length) {
        mdSections.push(
          `## ${source}\n` +
          (versionUnreported ? `_version currently unreported by store (sentinel)_\n` : "") +
          changes.map((c) => `- **${c.field}**${c.note ? ` _(${c.note})_` : ""}\n  - old: \`${short(c.old)}\`\n  - new: \`${short(c.new)}\``).join("\n")
        );
      }
    }
  }

  // --- pricing page (sentence-level) ---
  if (status.sources?.pricing?.status === "ok") {
    const prev = lastOkVersion(app.product_id, "pricing", "pricing.html");
    if (prev != null) {
      const currHtml = fs.readFileSync(path.join(dir, "pricing.html"), "utf8");
      const d = sentenceDiff(normalizeHtml(prev.content), normalizeHtml(currHtml));
      if (d) {
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, "pricing.meta.json"), "utf8")); } catch {}
        record.sources.pricing_page = {
          prev_ok_commit: prev.commit,
          curr_fetched_at: meta.fetched_at ?? null,
          granularity: "sentence",
          ...d,
        };
        // Bullets, not blockquotes: consecutive "> " lines merge into one paragraph
        // in GitHub's renderer (observed 2026-07-11 WHOOP md).
        const fmt = (arr) => arr.length
          ? arr.map((e) => `- ${e.text}${e.occurrences > 1 ? ` _(×${e.occurrences})_` : ""}`).join("\n")
          : "- (none)";
        mdSections.push(
          `## pricing_page (sentence-level)\n` +
          `**Added (${d.added_total}):**\n${fmt(d.added)}\n\n` +
          `**Removed (${d.removed_total}):**\n${fmt(d.removed)}` +
          (d.truncated ? `\n\n_(truncated to 80 per side; full counts above; raw HTML in git)_` : "")
        );
      }
    }
  }

  const hasJsonRecord = Object.keys(record.sources).length > 0;
  if (mdSections.length || hasJsonRecord) {
    fs.mkdirSync(outDir, { recursive: true });
    if (mdSections.length) {
      const fmeta = Object.fromEntries(Object.entries(status.sources).map(([k, v]) => [k, v.fetched_at || v.status]));
      fs.writeFileSync(
        path.join(outDir, `${app.product_id}.md`),
        `# ${app.name} (${app.product_id}) — ${today}\n\nfetched_at: ${JSON.stringify(fmeta)}\n\n${mdSections.join("\n\n")}\n`
      );
    }
    fs.writeFileSync(
      path.join(outDir, `${app.product_id}.json`),
      JSON.stringify(record, null, 2) + "\n"
    );
    wroteAny = true;
    console.log(`diff: ${app.product_id} (${mdSections.length ? "md+json" : "json only"})`);
  }
}

if (!wroteAny) console.log("diff: no changes today");
