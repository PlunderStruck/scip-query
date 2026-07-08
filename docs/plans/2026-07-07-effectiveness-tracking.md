# Effectiveness tracking: committed outcome events, directory suppressions, `effectiveness` command

Date: 2026-07-07

## Goal

Make scip-query's caught → fixed / suppressed tracking (a) durable and shareable by committing it to the target repo without merge-conflict risk, (b) queryable via a new `effectiveness` command reporting per-check caught/fixed/suppressed/open counts, precision, and median time-to-fix, and (c) stop growing `.scipquery.json` on every `suppress` — suppressions become one file each under `.scipquery/suppressions/`.

Done looks like: an agent runs under the stop hook for a week, then `scip-query effectiveness --since 7d` prints real per-check numbers from data that survives re-clones and merges cleanly across branches.

## Current State

- The outcome ledger already exists as a **machine-local cache**: `finding_outcome_ledger` table in `evidence.db` (`src/storage/evidence-cache.ts:205-213`), pure transition core `recordFindingOutcomes()` + `detectorPrecision()` in `src/queries/health/finding-outcome-ledger.ts:42-123`.
  - Source: `scip-query plan-context src/queries/health/finding-outcome-ledger.ts`
- `updateFindingOutcomeLedger()` has exactly **one call site**: the diff-gate hook-mode branch, `src/runtime/query-commands/impact.ts:257`.
  - Source: `scip-query refs updateFindingOutcomeLedger`
- Suppressions live in `.scipquery.json` `suppressions[]`; `addFindingSuppression()` (`src/runtime/config.ts:524-541`) rewrites the whole config file; **one call site**: `handleSuppress()` at `src/runtime/commands/command-handlers.ts:818-843`.
  - Source: `scip-query refs addFindingSuppression`
- The gate applies suppressions at exactly one point: `applyStructuredSuppressions(result, db.config.suppressions ?? [])`, `src/queries/impact/diff-gate.ts:326`; matcher `suppressionMatches()` at `diff-gate.ts:440-449`.
  - Source: grep + read of `diff-gate.ts:326,426-449` (verified in session)
- Finding IDs are line-number-free fingerprints `SQ`+sha256(check\0symbol\0file)[0:12] — `findingId()`, `diff-gate.ts:1306-1313`. Durable across edits; NOT durable across file renames (file is an id part).
- Git plumbing exists: `runGit(projectRoot, args)` exported from `src/analysis/git-history.ts:221`, 5 existing consumers.
  - Source: `scip-query refs runGit`

## Reuse Audit

| Proposed new unit | Reuse/extension considered | Decision |
| --- | --- | --- |
| `src/storage/suppression-store.ts` | Extend `addFindingSuppression` in config.ts | New module. config.ts owns `.scipquery.json` I/O; the dir store is a second storage backend with different merge semantics. Reuses `FindingSuppression` type + `validateProjectConfig`'s per-suppression rules (extracted). |
| `src/storage/outcome-events.ts` | Extend evidence-cache ledger | New module. evidence.db is an uncommitted per-machine cache by design (`resolveCacheDir`, config.ts:456); committed events have opposite lifecycle. Pure derivation reuses `FindingOutcomeRecord` from finding-outcome-ledger.ts. |
| `deriveOutcomeEvents()` pure fn | Extend `recordFindingOutcomes` to also return events | Keep `recordFindingOutcomes` untouched (health.ts + cli-support.ts also import this module); derive events from (previous, next) snapshots it already produces. No contract change to existing consumers. |
| `effectiveness` command | Extend `health` output | New command. `health` is repo-quality; effectiveness is tool-precision over time — different question, different data source (committed events vs live analysis). Registration reuses descriptor table pattern (`command-descriptors.ts:214`). |
| Suppression `createdAt` field | — | Extend `FindingSuppression` (`src/domain/config-types.ts:190`) with optional `createdAt`; validation allowlist updated. |

## Testability Design

| Behavior | Test seam | Injected deps | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Suppression file naming + round-trip | `suppressionFileName()`, `readSuppressionDir()` | tmpdir | `suppressionFileName(s): string` | read/write dir fns | filename = id ?? sha256(check\0file)[0:12] |
| Event derivation from ledger snapshots | `deriveOutcomeEvents(prev, next, symbols, commit)` | none (pure) | entire fn | — | emits caught/resolved/suppressed/reopened per transition |
| JSONL append/read/dedupe | `readOutcomeEvents()` on tmpdir | tmpdir, clock via event ts | `dedupeEvents(events)` | append/read fns | dedupe key (check, findingId, event, commit) |
| Union-merge setup | `ensureLedgerGitattributes()` | tmpdir | — | idempotent file write | `.scipquery/ledger/.gitattributes` contains `events.jsonl merge=union` |
| Effectiveness stats | `computeEffectiveness(events, opts, now)` | clock param | entire fn | — | per-check {caught, fixed, suppressed, open, precision, medianDaysToFix}; moved-reclassification by (check,symbol) |
| Gate reads both suppression stores | `diffGate()` over fixture repo | tmp project root | `suppressionMatches` (unchanged) | dir read at `diff-gate.ts:326` call site | union of config + dir suppressions |

## Design Phases

### 1.1 - Add suppression store module

- [ ] **File**: `src/storage/suppression-store.ts` (new)
- **Source**: reuse audit above; type from `src/domain/config-types.ts:190-201`
- **Change**: `suppressionDirPath(root)` = `<root>/.scipquery/suppressions`; `suppressionFileName(s)`; `writeSuppressionFile(root, s)` (adds `createdAt`, validates reason non-empty, mkdir -p, pretty JSON + \n); `readSuppressionDir(root)` (missing dir → [], malformed file → skip + collect warning).
- **Validation**: new unit test `tests/storage/suppression-store.test.ts` round-trips write→read, malformed file skipped, filename stable.
- **Why**: foundation for 1.2/1.3; no behavior change yet (nothing reads it).

### 1.2 - `suppress` writes the dir store

- [ ] **File**: `src/runtime/commands/command-handlers.ts:818-843`
- **Source**: `scip-query refs addFindingSuppression` (sole caller)
- **What**: `handleSuppress` calls `addFindingSuppression` → rewrites `.scipquery.json`.
- **Change**: call `writeSuppressionFile` instead; message: `Suppression written to <path>`. `addFindingSuppression` stays exported (config back-compat reading is untouched; deprecate in docs).
- **Validation**: run `scip-query suppress SQTEST --reason x` in a tmp repo → file exists, config untouched.
- **Why**: kills the JSON-append churn; legacy entries keep working via 1.3.

### 1.3 - Gate merges both suppression sources

- [ ] **File**: `src/queries/impact/diff-gate.ts:326`
- **Source**: read of call site (verified); `db.projectRoot` availability checked in `src/storage/db.ts`
- **Change**: `applyStructuredSuppressions(result, [...(db.config.suppressions ?? []), ...readSuppressionDir(db.projectRoot)])`.
- **Validation**: fixture test: dir-suppressed finding lands in `result.suppressed`, not `result.findings`.
- **Why**: matcher and semantics unchanged; only the source list widens.

### 2.1 - Outcome events module

- [ ] **File**: `src/storage/outcome-events.ts` (new)
- **Source**: `FindingOutcomeRecord` from `finding-outcome-ledger.ts:19-26`; `runGit` from `git-history.ts:221`
- **Change**: `OutcomeEvent { ts, check, findingId, event: 'caught'|'resolved'|'suppressed'|'reopened', commit: string|null, symbol?: string }`; pure `deriveOutcomeEvents(prev, next, symbolByFindingId, commit, now)`; `appendOutcomeEvents(root, events)` (mkdir, `ensureLedgerGitattributes`, append one JSON per line); `readOutcomeEvents(root)` (skip malformed lines, `dedupeEvents` by (check,findingId,event,commit) keeping earliest ts); `headCommit(root)` via `runGit(root, ['rev-parse','HEAD'])` → null on failure.
- **Validation**: unit tests: every transition pair → expected event; dedupe; malformed line tolerance; gitattributes idempotence.
- **Why**: append-only + union merge + read-side dedupe = conflict-free by construction; commit SHA gives branch ancestry semantics for free.

### 2.2 - Emit events from the hook run

- [ ] **File**: `src/runtime/query-commands/impact.ts:250-260`
- **Source**: `scip-query refs updateFindingOutcomeLedger` (sole call site)
- **What**: hook branch builds `observed`, calls `updateFindingOutcomeLedger(db, observed, result.checksRun, now)`.
- **Change**: capture `previous = readLedgerRecords(db)` before the update; after it, `appendOutcomeEvents(db.projectRoot, deriveOutcomeEvents(previous, next, symbolMap, headCommit(db.projectRoot), now))` where `symbolMap` comes from `result.findings`/`result.suppressed` finding `.symbol`. Failures to append are caught and logged to stderr — never block the hook.
- **Validation**: integration test in tmp git repo: run twice (finding present → absent) → events.jsonl holds caught then resolved.
- **Why**: single existing call site keeps ledger and events atomic per run; extra `readLedgerRecords` is one cheap SQLite read.

### 3.1 - Effectiveness computation + command

- [ ] **File**: `src/queries/health/effectiveness.ts` (new), `src/runtime/commands/command-handlers.ts` (+`handleEffectiveness`), `src/runtime/commands/command-descriptors.ts` (+descriptor after `suppress`, id `effectiveness`, options `--since <n>d|iso`, `--check <name>`, `--json`)
- **Source**: descriptor pattern `command-descriptors.ts:205-226`
- **Change**: pure `computeEffectiveness(events, {sinceMs, check}, now)`: per finding take event sequence (deduped, ts-ordered); reclassify `resolved` as `moved` when a `caught` with same (check, symbol) and different findingId exists within the same commit+run window; per check emit `{caught, fixed, suppressed, open, moved, precision: fixed/(fixed+suppressed), medianDaysToFix}`. Handler reads events, prints table or JSON envelope; empty ledger → friendly note that events are recorded by hook-mode diff-gate runs.
- **Validation**: unit tests on `computeEffectiveness` incl. moved-reclassification and median; smoke `scip-query effectiveness --json` in fixture repo.
- **Why**: read-only; all decisions in the pure core.

### 4.1 - Config type + docs

- [ ] **File**: `src/domain/config-types.ts:190-201`, `src/runtime/config.ts:580` region (suppression key validation), README/CHANGELOG
- **Change**: add optional `createdAt` to `FindingSuppression` + validation allowlist; CHANGELOG entry; bump minor version to 0.15.0.
- **Validation**: `npm run typecheck && npm test`, `config-validate` accepts a dir-written file's shape.

## Stress-Test Findings

- **Valid intermediate state**: each phase ships alone (1.1 inert, 1.2 write-only + 1.3 read makes it live; 2.x write-only until 3.1 reads).
- **Failure**: events append wrapped in try/catch (hook must not break commits); malformed JSONL lines skipped on read; missing git → `commit: null` events still counted (dedupe key still works).
- **Concurrency**: two agents appending simultaneously — O_APPEND single-line writes; worst case interleaved lines are still valid JSONL per line; dedupe absorbs duplicates.
- **Data integrity**: `.scipquery.json` untouched by new suppress path; evidence.db schema untouched; new artifacts live only under `.scipquery/`.
- **Renames**: finding id embeds file path → rename shows as resolved+caught; mitigated by query-time `moved` reclassification via (check, symbol) match. Symbol missing on some findings → falls back to counting as resolved (documented).
- **Human experience**: `suppress` output names the new file; `effectiveness` with no data explains how data accrues; `.gitattributes` written scoped inside `.scipquery/ledger/`, not repo root.

## Ship Order

1.1 → 1.2 → 1.3 → 2.1 → 2.2 → 3.1 → 4.1. No one-way doors: dir suppressions can be moved back into config by hand; events file is additive; command is read-only.

## Files

- Create: `src/storage/suppression-store.ts`, `src/storage/outcome-events.ts`, `src/queries/health/effectiveness.ts`, `tests/storage/suppression-store.test.ts`, `tests/storage/outcome-events.test.ts`, `tests/queries/effectiveness.test.ts`
- Edit: `src/runtime/commands/command-handlers.ts`, `src/runtime/commands/command-descriptors.ts`, `src/runtime/query-commands/impact.ts`, `src/queries/impact/diff-gate.ts:326`, `src/domain/config-types.ts`, `src/runtime/config.ts` (validation allowlist), `CHANGELOG.md`, `package.json`
- Verify: `npm run typecheck && npm run lint && npm test`, then `scip-query reindex && scip-query diff-gate`
