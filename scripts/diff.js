#!/usr/bin/env node
// diff.js — run AFTER snapshot.js, BEFORE commit.
// Compares the working-tree snapshot against the last *ok* observation of the same
// source in git history (walks back past failed runs). Writes diffs/YYYY-MM-DD/*.md.
// Pricing HTML is diffed as normalized visible text (A.6), never raw HTML.

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

// Find the most recent commit where this app's status.json said `source` was ok,
// then return that commit's version of `file`. Null if none exists yet.
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
      try { return git(["show", `${c}:apps/${productId}/${file}`]); } catch { return null; }
    }
  }
  return null;
}

// A.6: strip tags/scripts/styles, collapse whitespace → visible-text approximation.
function normalizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Fields worth watching per JSON source. Everything else is noise for the spike.
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

function textDiffSummary(oldText, newText) {
  if (oldText === newText) return null;
  const oldWords = new Set(oldText.split(" "));
  const newWords = new Set(newText.split(" "));
  const added = [...newWords].filter((w) => !oldWords.has(w));
  const removed = [...oldWords].filter((w) => !newWords.has(w));
  return { added: added.slice(0, 200), removed: removed.slice(0, 200) };
}

let wroteAny = false;

for (const app of registry.apps) {
  const dir = path.join(ROOT, "apps", app.product_id);
  const statusFile = path.join(dir, "status.json");
  if (!fs.existsSync(statusFile)) continue;
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const sections = [];

  for (const [source, file, fields] of [
    ["itunes", "itunes.json", ITUNES_FIELDS],
    ["play", "play.json", PLAY_FIELDS],
  ]) {
    if (status.sources?.[source]?.status !== "ok") continue; // diff only ok→ok pairs
    const prevRaw = lastOkVersion(app.product_id, source, file);
    if (prevRaw == null) continue; // first ok observation; nothing to diff
    const prev = JSON.parse(prevRaw).result;
    const curr = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).result;
    const changes = jsonFieldDiff(prev, curr, fields);
    if (changes.length) {
      sections.push(`## ${source}\n` + changes.map((c) =>
        `- **${c.field}**\n  - old: \`${JSON.stringify(c.old)?.slice(0, 500)}\`\n  - new: \`${JSON.stringify(c.new)?.slice(0, 500)}\``
      ).join("\n"));
    }
  }

  if (status.sources?.pricing?.status === "ok") {
    const prevHtml = lastOkVersion(app.product_id, "pricing", "pricing.html");
    if (prevHtml != null) {
      const d = textDiffSummary(normalizeHtml(prevHtml), normalizeHtml(fs.readFileSync(path.join(dir, "pricing.html"), "utf8")));
      if (d) {
        sections.push(`## pricing_page (normalized text word-level)\n- added: ${d.added.join(", ") || "(none)"}\n- removed: ${d.removed.join(", ") || "(none)"}`);
      }
    }
  }

  if (sections.length) {
    fs.mkdirSync(outDir, { recursive: true });
    const meta = Object.fromEntries(Object.entries(status.sources).map(([k, v]) => [k, v.fetched_at || v.status]));
    fs.writeFileSync(
      path.join(outDir, `${app.product_id}.md`),
      `# ${app.name} (${app.product_id}) — ${today}\n\nfetched_at: ${JSON.stringify(meta)}\n\n${sections.join("\n\n")}\n`
    );
    wroteAny = true;
    console.log(`diff: ${app.product_id}`);
  }
}

if (!wroteAny) console.log("diff: no changes today");
