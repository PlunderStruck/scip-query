# Feedback Completion Mission Plan

Date: 2026-06-13

## Goal

The user wants the remaining GPT feedback finished, not merely cataloged. Done means a user or agent can run `scip-query` with clear machine-readable output, suppress accepted findings without losing accountability, reindex large mixed-language projects without paying avoidable full-project costs, and validate the result on both this repo and Vega_2.0.

Stable JSON is a command output contract: the real-world referents are CLI invocations such as `scip-query refs --json`, `scip-query similar --json`, and `scip-query diff-gate --json`; the essential trait is that each returns named fields with stable meaning so agents consume facts directly instead of parsing prose.

A finding is a reported codebase condition that may require action, such as an echo candidate, stale abstraction, missing co-change partner, or new baseline issue; the essential trait is that it combines a claim with its evidence and location so a human or agent can judge and act on it.

A suppression is a recorded acceptance of a finding, such as a `scip-query: ignore ... -- reason` comment or structured config entry; the essential trait is that it preserves a decision with an identity and reason while allowing unrelated future findings to surface.

Incremental reindexing is a reindex workflow that rebuilds only the language index artifacts whose inputs changed; the essential trait is preserving the same final SCIP/SQLite evidence while avoiding rerunning unaffected language indexers.

## Current State

- Generic row/list/report commands are centralized in `src/runtime/command-execution.ts:60-143`, while command-specific handlers live in `src/runtime/command-handlers.ts`. Source: `scip-query plan-context command-execution`.
- `diffGate()` already produces structured findings with stable IDs and suppression hints at `src/queries/diff-gate.ts:99-154`, and structured suppression filtering is already near it at `src/queries/diff-gate.ts:156-183`. Source: `scip-query plan-context diffGate`.
- Health baseline collection still returns plain string identities from `src/queries/health-baseline.ts:62-115`; `diff-gate` consumes those through `runBaselineCheck()`. Source: `scip-query plan-context collectBaselineFindings`.
- Reindexing computes one project fingerprint and routes through `reindex()` at `src/reindex/index.ts:115-178`. Source: `scip-query plan-context reindex`.
- Project fingerprints currently read and SHA-256 hash every project file in `src/reindex/project-files.ts:18-36`. Source: `scip-query plan-context fingerprintProjectFiles`.
- Multi-language index materialization merges SCIP files at `src/reindex/index.ts:493-504`, then conversion sanitizes by rereading/writing the merged file at `src/reindex/index.ts:506-534`. Sources: `scip-query plan-context materializeScipOutput` and `scip-query plan-context convertScipToSqlite`.
- In-memory merge and sanitize helpers already exist at `src/reindex/merge.ts:26-44` and `src/reindex/sanitize.ts:37-87`. Sources: `scip-query plan-context mergeScipIndexes` and `scip-query plan-context sanitizeScipIndex`.
- Evidence persistence is centralized in `src/storage/evidence-cache.ts:17-261`, currently used by source facts, doc path tokens, and semantic callees. Source: `scip-query plan-context evidence-cache`.

Pre-plan checks:

- `scip-query doc-drift docs/COMMAND_REFERENCE.md`: no drifting docs across 119 docs.
- `scip-query recent-duplicates`: no recent re-implementations.
- `scip-query similar-signatures --scope src/runtime --limit 20`: generic command handlers repeat the same handler shapes, so JSON should land in the existing command-execution layer where possible.

## Reuse Audit

- Reuse `command-execution.ts` command builders for stable JSON instead of adding per-command parsers. Source: `scip-query plan-context command-execution`.
- Reuse `DiffGateFinding` as the first complete finding envelope and extract a shared finding contract from it instead of inventing a second schema. Source: `scip-query plan-context diffGate`.
- Reuse existing config suppressions and `applyStructuredSuppressions()` for suppression matching, then add management commands around that model. Source: `scip-query plan-context diffGate`.
- Reuse `fingerprintProjectFiles()` as the fingerprint boundary, but extend its implementation and metadata version. Source: `scip-query plan-context fingerprintProjectFiles`.
- Reuse `mergeScipIndexes()` and `sanitizeScipIndex()` for one-pass merge/sanitize. Sources: `scip-query plan-context mergeScipIndexes`, `scip-query plan-context sanitizeScipIndex`.
- Reuse `evidence-cache.ts` for semantic reference and git-history caches because it already owns versioned sidecar SQLite storage. Source: `scip-query plan-context evidence-cache`.

## Phase 1 - Finish CLI Trust Contracts

### 1.1 - Add JSON output to generic command builders

- [ ] **File**: `src/runtime/command-execution.ts:51-143`
- **Source**: `scip-query plan-context command-execution`
- **What**: `CommandOutputSpec`, `listCommand`, `tableCommand`, and report builders render human output only unless each individual command hand-rolls JSON.
- **Change**: Add optional `toJson` callbacks to row/report command specs. When `--json` is present, emit `{ command, args, options, result }` and suppress heuristic notices already covered by structured evidence.
- **Why**: This closes the largest stable-JSON gap without copying JSON code into every command.

### 1.2 - Descriptor-own `--json` for remaining public commands

- [ ] **File**: `src/runtime/command-descriptors.ts`
- **Source**: `scip-query plan-context command-execution`
- **What**: JSON support is uneven across descriptor-backed commands.
- **Change**: Add `--json` to commands whose handler can now return stable output through the generic builders. Keep process commands such as `watch`, `setup-agent`, and `setup-ci` human-first unless they return a bounded result.
- **Why**: Descriptor ownership keeps help text, command reference, tests, and parser behavior aligned.

### 1.3 - Extract a shared finding envelope

- [ ] **File**: `src/queries/diff-gate.ts:37-62`
- **Source**: `scip-query plan-context diffGate`
- **What**: `DiffGateFinding` is complete but local to diff-gate.
- **Change**: Move the common fields into a shared domain type and adapt detectors with finding-producing JSON modes to return that envelope.
- **Why**: Every finding should carry stable identity, evidence, location, confidence, severity, why, and remediation consistently.

### 1.4 - Stabilize baseline identities

- [ ] **File**: `src/queries/health-baseline.ts:62-115`
- **Source**: `scip-query plan-context collectBaselineFindings`
- **What**: Health baseline returns detector-specific strings like `dead:<file>:<symbol>`.
- **Change**: Store stable IDs plus legacy keys during a migration window. Keep reading existing `.scipquery-baseline.json`, but write the upgraded shape on `health --write-baseline`.
- **Why**: Baselines and suppressions should survive message text changes.

### 1.5 - Add suppression management commands

- [ ] **File**: `src/runtime/command-descriptors.ts`
- **Source**: `scip-query plan-context diffGate`
- **What**: Structured suppressions exist in config and diff-gate, but users cannot inspect or create them through first-class commands.
- **Change**: Add `suppressions --json`, `suppressions --expired`, and `suppress <finding-id> --reason <text>`. First implementation can manage config suppressions; source-comment insertion can follow after the JSON contract is stable.
- **Why**: Suppression must be auditable rather than tribal knowledge.

### 1.6 - Tests and docs for trust contract

- [ ] **File**: `tests/cli-contract.test.ts`
- **Source**: `scip-query plan-context command-execution`
- **Change**: Add tests that descriptor `--json` options match implemented JSON output, legacy commands return parseable JSON, and suppression commands reject missing reasons.
- [ ] **File**: `docs/COMMAND_REFERENCE.md`
- **Source**: `scip-query doc-drift docs/COMMAND_REFERENCE.md`
- **Change**: Regenerate/update command syntax and add a short JSON-contract section.

## Phase 2 - Git-Backed Freshness

### 2.1 - Extend project file fingerprints

- [ ] **File**: `src/reindex/project-files.ts:6-36`
- **Source**: `scip-query plan-context fingerprintProjectFiles`
- **What**: `fingerprintProjectFiles()` hashes every listed file.
- **Change**: Add `source: 'git-blob' | 'hash' | 'unreadable'` and use Git blob IDs for clean tracked files, hashing only dirty tracked, untracked, unreadable, or non-Git fallback files.
- **Why**: This preserves exactness while making no-op status/reindex much cheaper on large Git repos.

### 2.2 - Version freshness metadata

- [ ] **File**: `src/runtime/index-freshness.ts:32-100`
- **Source**: `scip-query plan-context getIndexFreshness`
- **What**: Runtime freshness compares the current fingerprint to `meta.json`.
- **Change**: Accept old metadata as stale/upgrade-needed, compare new Git-backed fingerprint versions exactly, and report whether freshness used Git blobs or file hashes.
- **Why**: Users need exact freshness and a clear reason when old metadata forces a reindex.

### 2.3 - Reindex tests for clean, dirty, untracked, and non-Git files

- [ ] **File**: `tests/index-freshness.test.ts`
- **Source**: `scip-query plan-context getIndexFreshness`
- **Change**: Add Git fixture cases proving clean tracked files avoid content hashing, dirty files hash working-tree content, untracked files are included, and non-Git behavior stays exact.

## Phase 3 - Incremental Reindex and One-Pass SCIP Materialization

### 3.1 - Persist per-language fingerprints and artifacts

- [ ] **File**: `src/reindex/index.ts:78-178`
- **Source**: `scip-query plan-context reindex`
- **What**: Reindex stores one full-project fingerprint and rebuilds all requested languages together.
- **Change**: Add `languageFingerprints` and cached per-language SCIP artifact paths to metadata. Reuse a language artifact when its fingerprint and output file match.
- **Why**: A Python-only change in a mixed repo should not rerun TypeScript, and vice versa.

### 3.2 - Split language input ownership

- [ ] **File**: `src/reindex/project-files.ts:12-36`
- **Source**: `scip-query plan-context fingerprintProjectFiles`
- **What**: The current fingerprint function has one project-wide file set.
- **Change**: Add language-scoped fingerprinting that includes source extensions plus relevant config files for each language.
- **Why**: Incremental correctness depends on invalidating the right language when shared config changes.

### 3.3 - Merge and sanitize in memory once

- [ ] **File**: `src/reindex/index.ts:493-534`
- **Source**: `scip-query plan-context materializeScipOutput`; `scip-query plan-context convertScipToSqlite`
- **What**: Multi-language reindex merges to a file and later sanitizes that file before SQLite conversion.
- **Change**: Materialize merged SCIP by deserializing inputs, calling `mergeScipIndexes()`, calling `sanitizeScipIndex()`, then serializing once. Skip `sanitizeScipFile()` in conversion when materialization already sanitized.
- **Why**: This removes one read/write pass without changing the final sanitized SCIP content.

### 3.4 - Reindex reliability tests

- [ ] **File**: `tests/reindex-reliability.test.ts`
- **Source**: `scip-query plan-context reindex`
- **Change**: Add mixed TS/Python fixture tests for language reuse, missing artifact rebuild, changed shared config invalidation, and one-pass sanitize equivalence.

## Phase 4 - Persist Expensive Evidence

### 4.1 - Add semantic reference cache

- [ ] **File**: `src/storage/evidence-cache.ts:17-261`
- **Source**: `scip-query plan-context evidence-cache`
- **What**: Evidence cache persists file evidence and semantic callees, but semantic reference evidence still requires warm-run TypeScript work.
- **Change**: Add a versioned `semantic_references` table keyed by provider version, tsconfig/project epoch, definition symbol, and source/content hash.
- **Why**: Warm query runs should reuse exact semantic reference facts.

### 4.2 - Add persisted git-history facts

- [ ] **File**: `src/storage/evidence-cache.ts:17-261`
- **Source**: `scip-query plan-context evidence-cache`
- **What**: Git-history derived facts are recomputed by health/diff checks.
- **Change**: Add cached co-change/churn/fix-density facts keyed by Git HEAD and relevant command options.
- **Why**: Health and diff-gate should not repeatedly traverse the same history in a stable worktree.

### 4.3 - Share health corpora per run

- [ ] **File**: `src/queries/health.ts:149-157`
- **Source**: `scip-query plan-context health`
- **What**: Health coordinates multiple detectors but still lets some detectors build overlapping candidate corpora.
- **Change**: Add a per-health-run context object for shared candidate corpora and cached detector inputs.
- **Why**: This keeps output identical while avoiding repeated expensive scans.

## Phase 5 - Validation and Release Gate

### 5.1 - Local validation

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `node dist/cli.js reindex --force`
- [ ] `node dist/cli.js diff-gate --json`

### 5.2 - Vega_2.0 validation

- [ ] `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js reindex --force` in `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- [ ] `status --json`, `capability-matrix --json`, `stats`, `outline`, `diff-impact`, `incomplete-migration`, `cleanup-plan --json`, `cleanup-plan --verify`, `health --json`, and `diff-gate --json`
- [ ] Record whether `diff-gate` findings are real Vega diff findings or tool regressions.

## Execution Order

1. Phase 1: CLI trust contracts. This is user-visible and unlocks agent-safe automation.
2. Phase 2: Git-backed freshness. This is the safest performance architecture slice because it preserves the existing full-reindex model.
3. Phase 3: incremental reindex plus one-pass SCIP materialization. This changes persisted metadata and artifact reuse, so it follows freshness.
4. Phase 4: persisted semantic/git caches and health corpora. This depends on stable invalidation semantics from Phases 2 and 3.
5. Phase 5 after every phase, not only at the end.

## Stress Test

- Understanding: the plan touches the central command execution layer, diff-gate finding schema, reindex metadata, and evidence cache. Each is anchored by `plan-context` output above.
- Blast radius: `command-execution.ts` has nine consumers and `reindex()` flows to `handleReindex()`, so each phase needs focused tests and a full CLI smoke test.
- Valid intermediate states: each phase is independently shippable. Phase 1 does not depend on performance work; Phase 2 does not require per-language artifacts; Phase 3 can ship before persistent semantic/git caches.
- Reversibility: Phase 1 is additive except JSON contract stabilization. Phase 2 and Phase 3 require metadata versioning so old caches can be ignored rather than corrupted.
- Failure design: cache/fingerprint failures must fall back to exact hashing or full reindexing, not silent reuse.
- Concurrency: reindex already uses a lock through `reindex()`; per-language artifact writes must publish atomically like the existing full DB publish.
- Boundaries: CLI inputs must reject invalid suppression reasons and unknown JSON options at the command boundary.
- Data integrity: artifact reuse must verify both fingerprint and file existence before merge.
- Observability: status/doctor should report cache/freshness mode and why a reindex was or was not reused.
- Human experience: commands should keep human output readable while JSON output is parseable and stable.
- Reuse: the plan reuses command builders, `DiffGateFinding`, `fingerprintProjectFiles()`, `mergeScipIndexes()`, `sanitizeScipIndex()`, and `evidence-cache.ts`.

## Summary

This is a four-slice implementation path, not one giant risky patch. The first slice closes trust for agents. The second and third slices make indexing faster without weakening freshness. The fourth slice attacks repeated expensive analysis work after invalidation is trustworthy.
