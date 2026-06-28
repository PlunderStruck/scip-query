# scip-query Health Dossier

Generated: 2026-06-27T18:02:10.196Z
Project: /Users/aydansalois/Documents/GitHub/scip-query
Setup verdict: ready
Health score: 100 (risk 100, hygiene 100)

## Items That Need Attention

- Dead code: 1 symbols with zero references anywhere — safe to delete (1; impact high, effort low, evidence graph-fact; confirmation unconfirmed; safe to start no). Run scip-health-audit to confirm this signal; use scip-health-improve when the user wants confirmed issues fixed autonomously.
- Similar functions: 1 pairs with real logic overlap (beyond shared imports) — consolidation candidates (1; impact medium, effort medium, evidence heuristic; confirmation unconfirmed; safe to start no). Run scip-health-audit to confirm this signal; use scip-health-improve when the user wants confirmed issues fixed autonomously.

## Blocked Or Unavailable Checks

No blocked or unavailable setup checks were reported.

## Setup Smoke Tests

- PASS `scip-query reindex`: typescript indexed.
- PASS `scip-query status`: Index freshness is fresh: Index metadata fingerprint matches current source files.
- PASS `scip-query config-validate`: Config OK.
- PASS `scip-query capabilities`: 1 language capability row(s) available.
- PASS `scip-query capability-matrix --json`: 1 language row(s), 0 with unavailable capability cells.
- PASS `scip-query health`: Health score 100.
- PASS `scip-query diff-impact --json`: Git is available and index freshness is fresh: Index metadata fingerprint matches current source files. Last refresh: rebuilt by setup at 2026-06-27T18:01:52.208Z.
- PASS `scip-query diff-gate --json`: Git is available and index freshness is fresh: Index metadata fingerprint matches current source files. Last refresh: rebuilt by setup at 2026-06-27T18:01:52.208Z.
- PASS `scip-query cleanup-plan --verify`: 1 available, 0 partial, 0 unavailable cleanup-verification row(s).
- PASS `scip-query setup-hooks`: 0 installed, 0 updated, 2 already configured.
- PASS `printf %s '{"hook_event_name":"SessionStart"}' | scip-query hook-context`: Project hooks auto-refresh stale indexes; live watch defaults are 30000ms debounce, 60000ms cooldown, and 2000ms Git polling.
- PASS `scip-query setup-agent`: 0 written, 2 already wired, 0 skipped.

## Setup Steps

- OK scip CLI: scip CLI is available.
- OK Agent skills: 0 installed, 60 already linked, 0 skipped.
- OK Project config: Config OK.
- OK Watch refresh policy: Project hooks auto-refresh stale indexes; live watch defaults are 30000ms debounce, 60000ms cooldown, and 2000ms Git polling.
- OK Indexer readiness: Detected languages: typescript
- OK Indexer remediation: All detected indexers are runnable.
- OK Index refresh: Indexed typescript in 2.8s.
- OK Capability matrix: 1/1 language(s) have available indexing.
- OK Health audit: Health score 100. 2 prioritized action(s).
- OK Project agent hooks: 0 installed, 0 updated, 2 already configured, 0 legacy user hook config(s) cleaned up, 0 skipped.
- OK Project agent guidance: 0 written, 2 already wired, 0 skipped.
- OK Setup smoke tests: 12 passed, 0 unavailable, 0 failed.

## Indexer Remediation

All detected indexers were already runnable.

## JSON

Machine-readable report: `docs/scip-query/health-dossier.json`
