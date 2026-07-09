# fitgraph-spike

Freshness feasibility spike for a fitness-software knowledge graph. Spec is **frozen at v0** (2026-07-09); this repo is implementation only. Deviations require a documented reason here.

**Question:** Can pricing/feature changes across ~50 fitness apps be detected automatically, turned into evidence-cited claims, and reliably enough to justify building the platform?

## Pipeline

Daily GitHub Actions run: `snapshot.js` → `diff.js` → `extract.js` → commit. The repo's commit history is the temporal database. Observations are append-only; failures are recorded as `failed`, never treated as "no change"; diffs and claims are computed only between consecutive `ok` observations.

## Week-0 checklist (in order)

- [ ] Verify shaky IDs in browser first: Cal AI, WeightWatchers, RP Hypertrophy, FitNotes, Setgraph, Samsung Health, Apple Fitness+, Future — flip `verified: true` in `registry.json`, fill nulls
- [ ] Verify remaining 42 IDs (App Store URL `id<NUMBER>` and Play URL `?id=<package>`), flip `verified`
- [ ] Substitute any dead/unfindable apps; note substitutions in this README
- [ ] Enable the workflow, run once via **workflow_dispatch** (first full snapshot)
- [ ] Per-app static-vs-JS pass on pricing pages: view source in browser; if prices aren't in the raw HTML, set `pricing_render: "js"` in the registry — these become the Playwright decision list
- [ ] Note per-app in the registry where iTunes Lookup structurally cannot see subscription price (A.2) so the scorecard doesn't blame recall

## Review cadence

Mon + Thu, ~30 min, browser only: open each claim JSON in `claims/`, check against the live listing, fill `review.verdict` (`true`/`false`) and `review.reviewed_at` via web-UI edit.

## Scorecard inputs (end of week 4)

- Recall / precision / latency / availability / cost gates per spec §6
- Availability denominator = *scheduled* runs: count expected-vs-actual from the Actions run history (missed crons are misses, not `failed`)
- Failure taxonomy from `status.json` reasons + missed-cron count
