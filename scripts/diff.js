#!/usr/bin/env node
// diff.js — run AFTER snapshot.js, BEFORE commit.
// Compares the working-tree snapshot against the last *ok* observation of the same
// source in git history (walks back past failed runs).
// Emits BOTH artifacts per changed app:
//   diffs/YYYY-MM-DD/{product_id}.md    — human review layer (Mon/Thu)
//   diffs/YYYY-MM-DD/{product_id}.json  — machine layer (re-extraction, scorecard)
// Pricing HTML is diffed at SENTENCE level over normalized visible text (A.6):
// word-level sets proved unreadable in review (2026-07-10 Fitbit diff).

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
function lastOkVersion(productId, source, file) {
  const statusPath = `apps/${productId}/status.json`;
  let commits;
  try {
    commits = git(["log", "--format=%H", "--", statusPath]).trim().split("\n").filter(Boolean);
  } catch { return null; }
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
function sentenceDiff(oldText, newText) {
  const oldS = toSentences(oldText);
  const newS = toSentences(newText);
  const oldSet = new Set(oldS);
  const newSet = new Set(newS);
  const added = newS.filter((s) => !oldSet.has(s));
  const removed = oldS.filter((s) => !newSet.has(s));
  if (!added.length && !removed.length) return null;
  const CAP = 80; // review sanity cap; JSON records truncation explicitly
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

function jsonFieldDiff(oldObj, newObj, fields) {
  const a = pick(oldObj, fields), b = pick(newObj, fields);
  const changes = [];
  for (const f of fields) {
    if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) changes.push({ field: f, old: a[f], new: b[f] });
  }
  return changes;
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
    const changes = jsonFieldDiff(prevObj.result, currObj.result, fields);
    if (changes.length) {
      record.sources[source] = {
        prev_ok_commit: prev.commit,
        prev_fetched_at: prevObj.fetched_at,
        curr_fetched_at: currObj.fetched_at,
        field_changes: changes,
      };
      mdSections.push(
        `## ${source}\n` +
        changes.map((c) => `- **${c.field}**\n  - old: \`${short(c.old)}\`\n  - new: \`${short(c.new)}\``).join("\n")
      );
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
        const fmt = (arr) => arr.length ? arr.map((s) => `> ${s}`).join("\n") : "> (none)";
        mdSections.push(
          `## pricing_page (sentence-level)\n` +
          `**Added (${d.added_total}):**\n${fmt(d.added)}\n\n` +
          `**Removed (${d.removed_total}):**\n${fmt(d.removed)}` +
          (d.truncated ? `\n\n_(truncated to 80 per side; full counts above; raw HTML in git)_` : "")
        );
      }
    }
  }

  if (mdSections.length) {
    fs.mkdirSync(outDir, { recursive: true });
    const fmeta = Object.fromEntries(Object.entries(status.sources).map(([k, v]) => [k, v.fetched_at || v.status]));
    fs.writeFileSync(
      path.join(outDir, `${app.product_id}.md`),
      `# ${app.name} (${app.product_id}) — ${today}\n\nfetched_at: ${JSON.stringify(fmeta)}\n\n${mdSections.join("\n\n")}\n`
    );
    fs.writeFileSync(
      path.join(outDir, `${app.product_id}.json`),
      JSON.stringify(record, null, 2) + "\n"
    );
    wroteAny = true;
    console.log(`diff: ${app.product_id} (md+json)`);
  }
}

if (!wroteAny) console.log("diff: no changes today");
