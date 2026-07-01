# scip-query Health Dossier

Project: .
Setup verdict: partial
Health score: 94 (risk 100, hygiene 94)

## Items That Need Attention

- Dead code: 1 symbols with zero references anywhere -- deletion candidates; confirm with cleanup-plan --verify before deleting (1; impact high, effort low, evidence graph-fact; confirmation unconfirmed; safe to start no). Run scip-cleanup-audit to confirm this signal; use scip-cleanup-improve when the user wants confirmed issues fixed autonomously.
- Duplicate function bodies: 25 exact small-body group(s) across files — consolidate only when the domain concept matches (25; impact medium, effort low, evidence heuristic; confirmation unconfirmed; safe to start no). Run scip-cleanup-audit to confirm this signal; use scip-cleanup-improve when the user wants confirmed issues fixed autonomously.
- Stale abstractions: 7 single-consumer (not in types file) — remove unused abstractions; review single-consumer ownership before moving or inlining (7; impact medium, effort low, evidence heuristic; confirmation unconfirmed; safe to start no). Run scip-cleanup-audit to confirm this signal; use scip-cleanup-improve when the user wants confirmed issues fixed autonomously.
- Similar functions: 1 pairs with real logic overlap (beyond shared imports) — consolidation candidates (1; impact medium, effort medium, evidence heuristic; confirmation unconfirmed; safe to start no). Run scip-cleanup-audit to confirm this signal; use scip-cleanup-improve when the user wants confirmed issues fixed autonomously.
- Extraction candidates: 1 large functions with isolated callee clusters — review same-file or feature-local extraction seams (1; impact medium, effort medium, evidence heuristic; confirmation unconfirmed; safe to start no). Run scip-cleanup-audit to confirm this signal; use scip-cleanup-improve when the user wants confirmed issues fixed autonomously.
- Structural drift: 16 layer violations — remove direct drift; review signal drift against layer ownership (16; impact medium, effort medium, evidence heuristic; confirmation unconfirmed; safe to start no). Run scip-cleanup-audit to confirm this signal; use scip-cleanup-improve when the user wants confirmed issues fixed autonomously.

## Blocked Or Unavailable Checks

- UNAVAILABLE `scip-query setup-hooks`: Skipped by --no-hooks.

## Setup Smoke Tests

- PASS `scip-query reindex`: typescript indexed from cache.
- PASS `scip-query status`: Index freshness is fresh: Index metadata fingerprint matches current source files.
- PASS `scip-query config-validate`: 1 diagnostic(s), 0 error(s).
- PASS `scip-query capabilities`: 1 language capability row(s) available.
- PASS `scip-query capability-matrix --json`: 1 language row(s), 0 with unavailable capability cells.
- PASS `scip-query health`: Health score 94.
- PASS `scip-query diff-impact --json`: Git is available and index freshness is fresh: Index metadata fingerprint matches current source files. Last refresh: reused by setup at 2026-07-01T22:26:28.455Z.
- PASS `scip-query diff-gate --json`: Git is available and index freshness is fresh: Index metadata fingerprint matches current source files. Last refresh: reused by setup at 2026-07-01T22:26:28.455Z.
- PASS `scip-query cleanup-plan --verify`: 1 available, 0 partial, 0 unavailable cleanup-verification row(s).
- UNAVAILABLE `scip-query setup-hooks`: Skipped by --no-hooks.
- PASS `printf %s '{"hook_event_name":"SessionStart"}' | scip-query hook-context`: Project hooks auto-refresh stale indexes; live watch defaults are 30000ms debounce, 60000ms cooldown, and 2000ms Git polling.
- PASS `scip-query setup-agent`: 0 written, 2 already wired, 0 skipped.

## Setup Steps

- OK scip CLI: scip CLI is available.
- OK Agent skills: 9 installed, 51 already linked, 18 pruned, 0 skipped.
- WARN Project config: 1 diagnostic(s), 0 error(s).
- OK Watch refresh policy: Project hooks auto-refresh stale indexes; live watch defaults are 30000ms debounce, 60000ms cooldown, and 2000ms Git polling.
- OK Indexer readiness: Detected languages: typescript
- OK Indexer remediation: All detected indexers are runnable.
- OK Index refresh: Reused typescript in 0.1s.
- OK Capability matrix: 1/1 language(s) have available indexing.
- OK Health audit: Health score 94. 6 prioritized action(s).
- SKIPPED Project agent hooks: Skipped by --no-hooks.
- OK Project agent guidance: 0 written, 2 already wired, 0 skipped.
- WARN Setup smoke tests: 11 passed, 1 unavailable, 0 failed.

## Indexer Remediation

All detected indexers were already runnable.

## JSON

Machine-readable report: `docs/scip-query/health-dossier.json`
