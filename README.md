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

## Protect the observation history

Schemas can change, extractors can improve, the claim model can be redesigned — all derived layers are disposable. The one unrecoverable asset is the observation history: never rewrite commits on `main`, never force-push, never "clean up" old snapshots. A missed observation is recorded honestly as missed; a rewritten one is silently lost forever.
