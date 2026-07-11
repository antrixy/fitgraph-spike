# fitgraph-spike

A four-week experiment to determine whether software changes can be automatically observed and converted into trustworthy, evidence-cited claims — run against ~50 fitness apps as the feasibility spike for a fitness-software knowledge graph.

Spec is **frozen at v0** (2026-07-09); this repo is implementation only. Deviations require a documented reason here.

**Question:** Can pricing/feature changes across ~50 fitness apps be detected automatically, turned into evidence-cited claims, and reliably enough to justify building the platform?

**Success means having enough evidence to decide — including deciding *not* to build the platform.** A spike isn't trying to prove the idea right; it's trying to make the go/no-go decision cheap and honest.

## Pipeline

Daily GitHub Actions run: `snapshot.js` → `diff.js` → `extract.js` → commit. The repo's commit history is the temporal database. Observations are append-only; failures are recorded as `failed`, never treated as "no change"; diffs and claims are computed only between consecutive `ok` observations.

## Design principles

- Raw observations are immutable; derived artifacts (diffs, claims) can always be regenerated from them.
- Missing observations are never interpreted as "no change." `changed`, `unchanged`, and `didn't observe` are three different states.
- Human-readable evidence over opaque scores: evidence tiers and source counts, no decimal confidence values.
- Browser/store reality is authoritative; every registry value is a guess until browser-verified, and same-name lookalikes are assumed until developer identity cross-checks.
- The spike optimizes for learning, not scalability.

## Repository layout

```
registry.json          canonical product list; product_id → platform IDs, pricing URLs, verification notes
apps/{product_id}/     latest raw observations (itunes.json, play.json, pricing.html, status.json)
                       ── history lives in git: every prior day's state is `git show <commit>:apps/...`
                       ── there is deliberately NO dated observations/ tree; commits ARE the date axis
diffs/YYYY-MM-DD/      derived. {product_id}.md for human review, {product_id}.json for machines
claims/YYYY-MM-DD/     derived. one JSON per emitted claim, with review verdict fields
scripts/               snapshot.js → diff.js → extract.js
.github/workflows/     the daily cron (odd-minute schedule, workflow_dispatch backfill, concurrency group)
```

## Week-0 checklist (in order)

- [x] Verify shaky IDs in browser first: Cal AI, WeightWatchers, RP Hypertrophy, FitNotes, Setgraph, Samsung Health, Apple Fitness+, Future — flip `verified: true` in `registry.json`, fill nulls
- [x] Verify remaining 42 IDs (App Store URL `id<NUMBER>` and Play URL `?id=<package>`), flip `verified`
- [x] Substitute any dead/unfindable apps; note substitutions in this README (none needed; 3 structural absences documented in registry notes)
- [x] Enable the workflow, run once via **workflow_dispatch** (first full snapshot 2026-07-09)
- [x] Resolve broken pricing URLs from day-1 census (14 failures, all stale-URL 404s: 8 fixed, 6 null/app-only)
- [ ] Static-vs-JS pass on pricing pages: read from first committed HTML of each `ok` pricing fetch; set `pricing_render` in the registry — these become the Playwright decision list
- [ ] Note per-app in the registry where iTunes Lookup structurally cannot see subscription price (A.2), from day-2+ `price` fields

## Review cadence

Mon + Thu, ~30 min, browser only: open each claim JSON in `claims/`, check against the live listing, fill `review.verdict` (`true`/`false`) and `review.reviewed_at` via web-UI edit.

## Scorecard inputs (end of week 4)

- Recall / precision / latency / availability / cost gates per spec §6
- Availability denominator = *scheduled* runs: count expected-vs-actual from the Actions run history (missed crons are misses, not `failed`)
- Failure taxonomy from `status.json` reasons + missed-cron count
- Known follow-ups: Sleep Cycle pricing-page re-probe post-Aug 2026; Gymaholic/Freeletics campaign-churn diff volume (normalization-tuning candidates)

## Implementation decision log

Spec v0 is frozen; per its freeze note, implementation-level decisions are made here with a documented reason. Log of those decisions:

- **2026-07-09 — `npm install` instead of `npm ci`**: web-UI-only workflow means no lockfile can be generated locally.
- **2026-07-09 — snapshot-commit hash backfilled into claims as a second commit, not an amend**: amending would change the hash being recorded.
- **2026-07-09 — `.gitignore` for node_modules; Mapbox token in Oura's pricing HTML allowlisted in push protection**: vendor pages embed public client-side tokens; secret scanning can't tell. If more vendors trip this, revisit with a redaction pass in snapshot.js (documented deviation from raw-HTML storage).
- **2026-07-10 — pricing URLs resolved from day-1 census**: all 14 failures were stale-URL 404s (3 vendor domain moves, 2 www/bare-host strictness, 0 bot-walls). 8 fixed, 6 null (app-only pricing). Lesson: vendor marketing sites rot far faster than store listings.
- **2026-07-11 — pricing diffs moved from word-level to sentence-level, dual `.md` + `.json` output**: word-set diffs were unreadable in review (2026-07-10 Fitbit diff); JSON artifact lets future extractors and the scorecard consume diffs without reparsing markdown.
- **2026-07-11 — sentence diffs deduplicated with occurrence counts; MD output switched from blockquotes to bullets**: the same sentence renders 2-5× per page (desktop/mobile/footer/accordion DOM copies), and consecutive `>` lines merge into a single paragraph in GitHub's renderer — both made the 2026-07-11 WHOOP diff hard to review.
- **2026-07-11 — extract.js now scans pricing-page sentence diffs for the integration lexicon**: spec §3.2 lists pricing/feature pages as an integration_changed source, but the initial implementation only scanned store text fields — a silent coverage gap found while reviewing the first WHOOP diff JSON. Reads the diff JSON artifact (its first internal consumer), so extract must keep running after diff in the workflow.

Post-spike ideas parked (would violate the two-claim-type freeze or need per-vendor work): `version_changed` claim type; "(beta) removed → feature graduated" extraction rule; per-page `section` context on sentence diffs. Store-field data for the first two is already captured in diff JSONs, so both can be extracted retroactively over the full corpus.

## Protect the observation history

Schemas can change, extractors can improve, the claim model can be redesigned — all derived layers are disposable. The one unrecoverable asset is the observation history: never rewrite commits on `main`, never force-push, never "clean up" old snapshots. A missed observation is recorded honestly as missed; a rewritten one is silently lost forever.
