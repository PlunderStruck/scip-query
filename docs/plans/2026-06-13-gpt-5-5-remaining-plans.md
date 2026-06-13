# GPT 5.5 Pro Remaining Trust Work

Date: 2026-06-13

## Goal

The user wants the remaining GPT 5.5 Pro feedback converted into concrete, repo-grounded implementation plans. Done means each remaining item has an execution path with exact files, current behavior, target behavior, verification, and sequencing.

The first follow-through pass already made invalid `.scipquery.json` fail loudly and packaged docs. This plan covers the remaining work: JSON output, finding metadata, cleanup patch/apply, capability reporting, cleanup verification labels, stale-index detection, structured suppressions, CI setup, and a dedicated config validation/doctor command.

A finding is a reported codebase fact or candidate, produced by a detector and shown to a human or agent so they can decide whether to change code. Evidence is the observable basis for a finding, such as a compiler-resolved graph relationship, semantic provider result, source fallback, git co-change record, or checker run. JSON output is the machine-readable form of a command result: the same facts the human output describes, arranged under stable keys so another program can consume them without parsing prose. A stale index is a database whose indexed source snapshot no longer matches the project files it claims to describe. A suppression is a recorded acceptance of a finding: a user says a specific reported condition is intentional, and the tool preserves that decision without hiding unrelated future findings. A checker is a project command or compiler invocation that can reject a cleanup because the edited code no longer builds or typechecks. A capability matrix is a report that says which tool features are supported for each language in the current project and why.

## Current State

Commands are registered through the descriptor array in `src/runtime/command-descriptors.ts:8`, and that descriptor array is consumed by `src/runtime/cli.ts:14`. Source: `scip-query plan-context commandDescriptors`.

Database-backed commands share command execution helpers in `src/runtime/command-execution.ts`; `runCommandOutput` currently queries, checks emptiness, optionally prints the heuristic notice, and then calls a human renderer at `src/runtime/command-execution.ts:224-238`. Source: `scip-query plan-context runCommandOutput`.

Query commands are grouped in `src/runtime/query-command-specs.ts`; `queryCommandDescriptor` returns one descriptor by ID at `src/runtime/query-command-specs.ts:86-90`. Source: `scip-query plan-context queryCommandDescriptor`.

`diff-gate` currently defines `DiffGateFinding` at `src/queries/diff-gate.ts:34-39` and returns findings from `diffGate` at `src/queries/diff-gate.ts:74-126`. The human renderer prints only `check`, `message`, and `remediation` at `src/runtime/query-commands/impact.ts:149-152`. Sources: `scip-query plan-context diff-gate` and `scip-query code src/runtime/query-commands/impact.ts:1-220`.

`health` already has JSON output, but it is special-cased in the custom health handler, while most commands still render human text directly. Source: `scip-query plan-context health`.

`cleanup-plan` already carries per-entry evidence tiers in `CleanupPlanEntry` at `src/queries/cleanup-plan.ts:10-22`, groups deletions into `CleanupBatch` at `src/queries/cleanup-plan.ts:24-31`, and computes plans in `cleanupPlan` at `src/queries/cleanup-plan.ts:53-115`. Source: `scip-query plan-context cleanup-plan`.

Cleanup verification runs through `verifyCleanupPlan` at `src/runtime/cleanup-verify.ts:45-105`; it detects checkers, records uncovered files, dirty overlap, baseline errors, and per-batch status. The current cleanup command prints `Batch N: COMPILER-VERIFIED` for verified batches at `src/runtime/query-commands/cleanup.ts:479-487`. Sources: `scip-query plan-context verifyCleanupPlan` and `scip-query code src/runtime/query-commands/cleanup.ts:430-520`.

The index lifecycle already computes a `ReindexMetadata` value with `status`, `updatedAt`, `fingerprint`, requested languages, indexed languages, and skipped languages at `src/reindex/index.ts:78-86`. `reindex` computes a fingerprint at `src/reindex/index.ts:139-141` and checks whether existing outputs can be reused at `src/reindex/index.ts:145-154`. Source: `scip-query code src/reindex/index.ts:1-220`.

The common database entry point is `openDb` at `src/runtime/cli-context.ts:31-49`; it checks that the database exists but does not compare current source inputs to reindex metadata before opening. Source: `scip-query plan-context openDb`.

Project readiness already reports detected/configured languages, indexer status, and TypeScript semantic status through `getProjectReadiness` at `src/runtime/project-readiness.ts:32-50`, consumed by `handleCheckDeps` and `handleStatus`. Source: `scip-query plan-context getProjectReadiness`.

`status` currently prints project path, DB path, TypeScript semantic state, database existence, symbol/file counts, size, and build age at `src/runtime/command-handlers.ts:309-340`. Source: `scip-query plan-context handleStatus`.

Suppressions exist as source comments. `ProjectIndex.hasSuppressionComment` at `src/core/project-index.ts:168-170` delegates to source text and is used by cleanup and stale abstraction detectors. Source: `scip-query plan-context hasSuppressionComment`.

Agent setup exists through `setup-agent`; `handleSetupAgent` calls `setupAgent` and prints written/unchanged/skipped files at `src/runtime/command-handlers.ts:259-268`. Source: `scip-query plan-context handleSetupAgent`.

Config loading now throws on invalid or unreadable `.scipquery.json` in `loadProjectConfig` at `src/runtime/config.ts:20-37`, but there is still no `config validate` or `doctor` command. Source: `scip-query plan-context loadProjectConfig`.

Command reference docs are descriptor-generated through `commandDocEntries` at `src/runtime/command-docs.ts:13-25`. Source: `scip-query plan-context commandDocEntries`.

## Reuse Audit

Use `commandDescriptors`, `queryCommandDescriptor`, `commandDocEntries`, and the generated docs contract rather than adding a parallel command registry. Sources: `scip-query plan-context commandDescriptors`, `scip-query plan-context queryCommandDescriptor`, and `scip-query plan-context commandDocEntries`.

Use `runCommandOutput` and the existing row/report command specs as the shared JSON-output insertion point for descriptor-backed query commands. Source: `scip-query plan-context runCommandOutput`.

Use `DiffGateFinding`, `HealthReport`, and cleanup-plan result types as the first adopters of a shared finding schema instead of inventing a schema detached from existing detectors. Sources: `scip-query plan-context diff-gate`, `scip-query plan-context health`, and `scip-query plan-context cleanup-plan`.

Use existing reindex fingerprint metadata rather than adding a new freshness database. Source: `scip-query code src/reindex/index.ts:1-220`.

Use `getProjectReadiness` as the seed for capability reporting because it already detects languages, indexer executability, and TypeScript semantic availability. Source: `scip-query plan-context getProjectReadiness`.

Use `verifyCleanupPlan`, `applyBatchDeletions`, and `deleteLineRanges` as the mechanics for cleanup patch/apply; do not duplicate deletion logic in the CLI. Source: `scip-query plan-context verifyCleanupPlan`.

Use the existing comment-suppression path as the compatibility layer, then add stable finding IDs on top; do not edit `ProjectIndex` first because `scip-query plan-context hasSuppressionComment` reports it as high-risk shared infrastructure.

Pre-plan checks: `scip-query doc-drift docs/COMMAND_REFERENCE.md` and `scip-query doc-drift docs/AGENT_GUIDE.md` reported no drift. `scip-query recent-duplicates` reported no recent re-implementations. `scip-query similar-signatures --scope src/runtime` found existing command-handler shape repetition but no reusable implementation that already provides JSON output, structured suppression management, capability matrix, stale-index checks, CI generation, or config validation.

## Phase 1 — Shared Command JSON Output

### 1.1 — Add JSON capability to command descriptors

- [ ] **File**: `src/runtime/command-descriptor-types.ts:27-39`
- **Source**: `scip-query code src/runtime/command-descriptor-types.ts:1-160`
- **What**: `CommandDescriptor` records command identity, arguments, options, render shape, docs, and handler, but not whether a command can serialize structured output.
- **Change**: Add an optional `json?: { stable: boolean; schema: string }` field or a smaller `supportsJson?: boolean` field. Prefer the object form if schemas are added in Phase 2.
- **Why**: JSON support must be visible to command registration, generated docs, tests, and future compatibility checks.

### 1.2 — Preserve commander options and expose `--json` consistently

- [ ] **File**: `src/runtime/command-descriptors.ts:8-195`
- **Source**: `scip-query plan-context commandDescriptors`
- **What**: Custom commands and query commands are descriptors; only `health` currently advertises `--json` at `src/runtime/command-descriptors.ts:123-129`.
- **Change**: Add `--json` through descriptor construction for commands whose handler can return serializable data. For query families, add it in the query-command builder path rather than manually repeating it in every descriptor.
- **Why**: Agents should be able to discover JSON support from `--help` and generated docs, not from hidden convention.

### 1.3 — Extend command output specs with structured serializers

- [ ] **File**: `src/runtime/command-execution.ts:33-58`
- **Source**: `scip-query plan-context runCommandOutput`
- **What**: `ReportCommandSpec` and `SectionedReportCommandSpec` describe `query`, `emptyMessage`, `before`, `render`, and `after`; `CommandOutputSpec` has no `toJson` equivalent.
- **Change**: Add `toJson?: (output, ctx) => unknown` to report/sectioned/row command specs and plumb it into `CommandOutputSpec`.
- **Why**: Commands that already return structured query results should serialize the result directly instead of forcing consumers to parse terminal text.

### 1.4 — Make `runCommandOutput` branch on `opts.json`

- [ ] **File**: `src/runtime/command-execution.ts:224-238`
- **Source**: `scip-query plan-context runCommandOutput`
- **What**: The execution path always renders human output.
- **Change**: If `booleanOptionValue(ctx.opts, 'json')` is true and `toJson` exists, print `JSON.stringify(toJson(output, ctx), null, 2)` and skip human rendering. If JSON is requested but unsupported, throw `error: --json is not supported for <command>`.
- **Why**: One central branch gives most query commands a uniform behavior and failure mode.

### 1.5 — Migrate custom high-value commands first

- [ ] **File**: `src/runtime/query-commands/impact.ts:108-155`
- **Source**: `scip-query code src/runtime/query-commands/impact.ts:1-220`
- **What**: `handleDiffGate` directly prints human text and sets exit codes.
- **Change**: Preserve existing human output, but when `--json` is set, print a stable envelope: `{ command, base, changedFiles, changedSymbols, checksRun, skipped, findings, exitCode }`.
- **Why**: `diff-gate --json` is the highest-value agent contract because agents already run it before finishing.

- [ ] **File**: `src/runtime/query-commands/cleanup.ts:428-490`
- **Source**: `scip-query code src/runtime/query-commands/cleanup.ts:360-430` and `scip-query code src/runtime/query-commands/cleanup.ts:430-520`
- **What**: `cleanup-plan` directly prints batches and verification.
- **Change**: Add `--json` output containing plan batches and optional verification with the exact same fields returned by `cleanupPlan` and `verifyCleanupPlan`.
- **Why**: Cleanup automation needs stable batch IDs, files, line ranges, evidence, checker coverage, and status.

- [ ] **File**: `src/runtime/command-handlers.ts:309-340`
- **Source**: `scip-query plan-context handleStatus`
- **What**: `status` prints only human text.
- **Change**: Add `status --json` with project root, DB path, fallback config path, semantic readiness, existence, stats, and future freshness status from Phase 5.
- **Why**: Agents and CI need a cheap health probe that does not require scraping aligned labels.

### 1.6 — Update docs and contracts

- [ ] **File**: `src/runtime/command-docs.ts:13-25`
- **Source**: `scip-query plan-context commandDocEntries`
- **What**: Generated docs list option flags only; tests compare generated docs to descriptors.
- **Change**: Ensure JSON options flow into `commandDocEntries`, update generated `docs/COMMAND_REFERENCE.md`, and extend `tests/cli-contract.test.ts` so descriptor-backed JSON options stay documented.
- **Why**: The current repo already treats command docs as a contract; JSON support should join that contract.

## Phase 2 — Stable Finding Schema and IDs

### 2.1 — Introduce a shared finding contract

- [ ] **File**: `src/domain/types.ts:1-7`
- **Source**: `scip-query code src/domain/types.ts:1-180`
- **What**: Domain types are re-exported from smaller files; there is no shared finding metadata contract.
- **Change**: Add `src/domain/finding-types.ts` and export it from `src/domain/types.ts`. Define `FindingEvidence`, `FindingSeverity`, `FindingLocation`, and `StructuredFinding`.
- **Why**: Detectors need one vocabulary for evidence, confidence, severity, location, related files, message, why, remediation, and suppression hint.

### 2.2 — Add deterministic finding IDs

- [ ] **File**: `src/queries/diff-gate.ts:34-39`
- **Source**: `scip-query plan-context diff-gate`
- **What**: `DiffGateFinding` only has `check`, `message`, and `remediation`.
- **Change**: Add `id`, `severity`, `evidence`, `confidence`, `location`, `relatedFiles`, and `why`. Compute `id` from detector/check plus stable file/symbol/range fields, not from free-form prose.
- **Why**: Baselines and suppressions should survive message wording changes.

### 2.3 — Enrich each diff-gate detector at the source

- [ ] **File**: `src/queries/diff-gate.ts:128-287`
- **Source**: `scip-query plan-context diff-gate`
- **What**: `runEchoCheck`, `runIncompleteMigrationCheck`, `runCoChangePartnerCheck`, `runDocReferenceCheck`, `runUnusedParamsCheck`, `runNewDeadCheck`, and `runBaselineCheck` produce thin findings.
- **Change**: Populate evidence tiers per detector: `heuristic` for echo/incomplete migration/unused params/new dead candidates, `change-graph` for co-change partner and doc-reference checks, and `baseline` or `policy` for baseline failures. Attach file and symbol locations when available.
- **Why**: The tool should say why a finding exists and how strong the basis is.

### 2.4 — Align health actions with the shared finding shape

- [ ] **File**: `src/queries/health-report.ts`
- **Source**: `scip-query plan-context health`
- **What**: Health has its own report-building path and currently feeds the special `health --json` command.
- **Change**: Map health actions/findings to `StructuredFinding` while preserving the existing `HealthReport` public shape through a compatibility field or versioned JSON envelope.
- **Why**: Health should not be the only structured command with a separate schema.

### 2.5 — Update baselines to key by stable IDs

- [ ] **File**: `src/queries/health-baseline.ts`
- **Source**: `scip-query plan-context health`
- **What**: Baseline helpers are part of the health surface and are used by diff-gate through `checkHealthBaseline`.
- **Change**: Store and compare stable finding IDs, while preserving a migration path for existing baseline files by accepting old keys until a new baseline is written.
- **Why**: Baselines become less string-fragile once messages can improve without invalidating accepted findings.

## Phase 3 — Cleanup Patch and Apply

### 3.1 — Represent verified cleanup sessions

- [ ] **File**: `src/runtime/cleanup-verify.ts:20-40`
- **Source**: `scip-query plan-context verifyCleanupPlan`
- **What**: `CleanupVerification` records checkers, uncovered files, baseline errors, dirty overlap, and batches.
- **Change**: Add `verificationId`, `projectRoot`, `headSha`, `planFingerprint`, `createdAt`, and checker commands. Persist this metadata under the same cache directory as the index.
- **Why**: `cleanup-apply --verified` must refuse stale or unverified plans.

### 3.2 — Generate a patch from the same deletion engine

- [ ] **File**: `src/runtime/cleanup-verify.ts:258-300`
- **Source**: `scip-query plan-context verifyCleanupPlan`
- **What**: `applyBatchDeletions` and `deleteLineRanges` already delete plan ranges inside a throwaway worktree.
- **Change**: Add `buildCleanupPatch(projectRoot, plan, batches)` that creates a temporary copy, applies the same deletion code, and returns a git-compatible patch.
- **Why**: `cleanup-plan --patch` should prove and emit exactly the change the verifier tested.

### 3.3 — Add `cleanup-plan --patch`

- [ ] **File**: `src/runtime/query-commands/cleanup.ts:428-490`
- **Source**: `scip-query code src/runtime/query-commands/cleanup.ts:430-520`
- **What**: `cleanup-plan --verify` verifies but still leaves manual deletion to the user.
- **Change**: Add `--patch` and require `--verify` when `--patch` is present. On success, print the patch to stdout and route verification notes to stderr.
- **Why**: The user should be able to save or pipe the exact verified patch.

### 3.4 — Add `cleanup-apply`

- [ ] **File**: `src/runtime/command-descriptors.ts:157-195`
- **Source**: `scip-query code src/runtime/command-descriptors.ts:147-195`
- **What**: Maintenance commands are explicit descriptors; there is no cleanup apply command.
- **Change**: Add a descriptor for `cleanup-apply` with `--verified`, `--batch <n>`, `--all`, and `--force-dirty`.
- **Why**: Applying verified cleanup is a side-effecting command and should be an explicit CLI action, not a hidden mode.

- [ ] **File**: `src/runtime/command-handlers.ts:208-340`
- **Source**: `scip-query code src/runtime/command-handlers.ts:208-340`
- **What**: Side-effecting handlers such as `handleInit`, `handleSetupAgent`, and `handleWatch` live here.
- **Change**: Add `handleCleanupApply` that loads the persisted verification session, checks HEAD and dirty overlap, writes a backup patch, applies the patch, and prints exact files touched.
- **Why**: The command needs guardrails: verified-only by default, dirty-worktree refusal, and recoverability.

### 3.5 — Test patch/apply safety

- [ ] **File**: `tests/cleanup-plan.test.ts`
- **Source**: `scip-query plan-context verifyCleanupPlan` reports this test as a historical co-change partner.
- **What**: Cleanup verification tests already co-change with `cleanup-verify`.
- **Change**: Add tests for patch generation, refusal without verification, refusal on dirty overlap, batch selection, and backup patch creation.
- **Why**: Cleanup apply is intentionally powerful; tests must prove it refuses unsafe states.

## Phase 4 — Capability Matrix

### 4.1 — Create a capability model

- [x] **File**: `src/runtime/project-readiness.ts:7-30`
- **Source**: `scip-query plan-context getProjectReadiness`
- **What**: Readiness reports languages, indexers, and TypeScript semantic status.
- **Change**: Add capability rows for SCIP graph navigation, source AST fallback, semantic augmentation, detector support, and cleanup verification checker support.
- **Why**: Users need to know what "works with this language" means for the current project.
- **Completed**: `getProjectCapabilities` now returns a `matrix` row for each detected/configured language with indexing, source fallback, semantic provider, detector, and cleanup verification statuses.

### 4.2 — Add `capability-matrix`

- [x] **File**: `src/runtime/command-descriptors.ts:147-195`
- **Source**: `scip-query code src/runtime/command-descriptors.ts:147-195`
- **What**: Maintenance commands include `check-deps`, `init`, `setup-agent`, `watch`, and `status`.
- **Change**: Add `capability-matrix` as a maintenance descriptor with `--json`.
- **Why**: The matrix should be a first-class command, not only extra status text.
- **Completed**: `capability-matrix` is descriptor-backed and uses the same handler as `capabilities`.

- [x] **File**: `src/runtime/command-handlers.ts:208-249`
- **Source**: `scip-query code src/runtime/command-handlers.ts:208-340`
- **What**: `handleCheckDeps` already prints detected languages and readiness.
- **Change**: Add `handleCapabilityMatrix` that uses `getProjectReadiness` and prints a table with one row per capability and one column per detected/configured language.
- **Why**: This keeps capability reporting near existing project readiness behavior.
- **Completed**: The shared capability handler prints the matrix for both `capabilities` and `capability-matrix`, avoiding a second handler that could drift.

### 4.3 — Extend `status --capabilities`

- [x] **File**: `src/runtime/command-handlers.ts:309-340`
- **Source**: `scip-query plan-context handleStatus`
- **What**: `status` prints index and semantic status.
- **Change**: Add `status --capabilities` to embed the same capability matrix below the current status output, and include it in `status --json`.
- **Why**: Humans checking a project should see capability truth without learning another command.
- **Completed**: `status --capabilities` renders the shared report, and `status --json` already embeds the `capabilities` object with the new `matrix` field.

## Phase 5 — Brutally Explicit Cleanup Verification Labels

### 5.1 — Split batch status into covered and uncovered entries

- [ ] **File**: `src/runtime/cleanup-verify.ts:20-40`
- **Source**: `scip-query plan-context verifyCleanupPlan`
- **What**: `BatchVerification` has batch-level status, depth, checker, duration, and errors.
- **Change**: Add per-batch `verifiedEntries`, `unverifiedEntries`, `uncoveredFiles`, and `checkerCommands`.
- **Why**: A batch containing multiple languages must not be labeled as wholly compiler-verified when only some files were covered.

### 5.2 — Change cleanup verification output labels

- [ ] **File**: `src/runtime/query-commands/cleanup.ts:460-488`
- **Source**: `scip-query code src/runtime/query-commands/cleanup.ts:430-520`
- **What**: Verified batches print `Batch N: COMPILER-VERIFIED`.
- **Change**: Print `VERIFIED: <n> entries via <checker command>`, `UNVERIFIED: <n> entries in <files>`, and `DIRTY OVERLAP: <files>` as separate lines.
- **Why**: Strong proof language is correct only for entries actually covered by the checker.

### 5.3 — Make JSON verification labels match human labels

- [ ] **File**: `src/runtime/query-commands/cleanup.ts:428-490`
- **Source**: `scip-query code src/runtime/query-commands/cleanup.ts:430-520`
- **What**: Phase 1 adds cleanup-plan JSON output.
- **Change**: Include the exact covered/uncovered split in JSON and avoid any top-level `compilerVerified: true` unless every entry in every requested batch is covered and verified.
- **Why**: Agents should not infer more proof than the tool actually has.

## Phase 6 — Stale-Index Detection

### 6.1 — Export reindex metadata and fingerprint helpers

- [ ] **File**: `src/reindex/index.ts:78-86`
- **Source**: `scip-query code src/reindex/index.ts:1-220`
- **What**: `ReindexMetadata` and fingerprint helpers are internal.
- **Change**: Export a read-only `readReindexMetadata(metaPath)` and `computeCurrentFingerprint(projectRoot, languages, opts)` helper, keeping mutation inside `reindex`.
- **Why**: Query commands need freshness checks without running a full reindex.

### 6.2 — Add freshness status to CLI context

- [ ] **File**: `src/runtime/cli-context.ts:19-49`
- **Source**: `scip-query plan-context openDb`
- **What**: `resolveCliProjectContext` resolves paths and config, while `openDb` checks only database existence.
- **Change**: Add `resolveIndexFreshness(projectRoot, config, paths)` returning `fresh`, `stale`, `unknown`, changed file count, skipped languages, and remediation.
- **Why**: Every database-backed command can warn consistently before trusting an index.

### 6.3 — Warn by default and enforce on request

- [ ] **File**: `src/runtime/command-execution.ts:60-75`
- **Source**: `scip-query plan-context runCommandOutput`
- **What**: `dbCommand` and `budgetedDbCommand` open the database without freshness policy.
- **Change**: Add shared warning behavior before command execution. Add descriptor option `--ensure-fresh` for high-risk agent commands such as `diff-gate`, `plan-context`, and `cleanup-plan`; when stale, exit 1 with `Run: scip-query reindex`.
- **Why**: Agents should not unknowingly act on stale graph evidence.

### 6.4 — Surface freshness in `status`

- [ ] **File**: `src/runtime/command-handlers.ts:309-340`
- **Source**: `scip-query plan-context handleStatus`
- **What**: `status` reports whether a DB exists and when it was built.
- **Change**: Add `Fresh: yes/no/unknown`, changed tracked source file count, metadata timestamp, indexed languages, skipped languages, and `Run: scip-query reindex` remediation.
- **Why**: Users need one command that explains whether the current index should be trusted.

## Phase 7 — Structured Suppressions

### 7.1 — Add structured suppression parser

- [ ] **File**: `src/source/source-text.ts`
- **Source**: `scip-query plan-context hasSuppressionComment`
- **What**: Suppression checks are currently comment-presence based through `hasSuppressionComment`.
- **Change**: Add parsing for comments shaped like `scip-query: ignore <check> <findingId> -- <reason>` while preserving existing loose suppression comments.
- **Why**: New suppressions need check and reason without breaking old projects.

### 7.2 — Add suppression catalog command

- [ ] **File**: `src/runtime/command-descriptors.ts:147-195`
- **Source**: `scip-query code src/runtime/command-descriptors.ts:147-195`
- **What**: No suppression management command exists.
- **Change**: Add `suppressions` with `--expired`, `--json`, and optional `--check <name>`.
- **Why**: Users need to audit accepted findings as first-class project state.

- [ ] **File**: `src/runtime/command-handlers.ts:208-340`
- **Source**: `scip-query code src/runtime/command-handlers.ts:208-340`
- **What**: Side-effect-free maintenance handlers already live here.
- **Change**: Add `handleSuppressions` that scans indexed source files for structured suppression comments and prints ID, check, file, line, reason, and expiry.
- **Why**: Suppression sprawl should be visible, not silent.

### 7.3 — Add suppression creation command

- [ ] **File**: `src/runtime/command-descriptors.ts:147-195`
- **Source**: `scip-query code src/runtime/command-descriptors.ts:147-195`
- **What**: There is no command that inserts a suppression comment.
- **Change**: Add `suppress <finding-id> --reason <text> [--expires <date>]`.
- **Why**: Agents need a structured way to accept findings without inventing comment formats.

- [ ] **File**: `src/runtime/command-handlers.ts:208-340`
- **Source**: `scip-query code src/runtime/command-handlers.ts:208-340`
- **What**: Existing handlers do not edit source files except setup/init style commands.
- **Change**: Add `handleSuppress` that resolves the finding ID from the latest JSON-capable detector output or baseline, inserts a nearby suppression comment, and refuses missing reasons.
- **Why**: Suppressions should require a reason and attach to a stable finding ID.

### 7.4 — Wire detectors to stable IDs

- [ ] **File**: `src/queries/diff-gate.ts:128-287`
- **Source**: `scip-query plan-context diff-gate`
- **What**: Diff-gate detectors do not currently inspect structured suppressions.
- **Change**: After Phase 2 stable IDs exist, filter findings by structured suppression ID and check, then report suppressed counts in JSON and human output.
- **Why**: Suppression must be precise enough to silence one accepted finding without hiding other findings in the same file.

## Phase 8 — CI Initializer

### 8.1 — Add CI setup generator beside agent setup

- [ ] **File**: `src/runtime/agent-setup.ts`
- **Source**: `scip-query plan-context handleSetupAgent`
- **What**: `setupAgent` writes agent instructions and optionally a git pre-commit hook.
- **Change**: Add `src/runtime/ci-setup.ts` with `setupCi(projectRoot, { provider })`, modeled after setup-agent result reporting but generating CI files instead of agent docs.
- **Why**: CI setup is maintenance-side file generation and should follow the existing setup result pattern.

### 8.2 — Register `setup-ci`

- [ ] **File**: `src/runtime/command-descriptors.ts:165-172`
- **Source**: `scip-query code src/runtime/command-descriptors.ts:147-195`
- **What**: `setup-agent` is a maintenance command with one option and generated docs examples.
- **Change**: Add `setup-ci <provider>` with accepted providers `github` and `generic`, plus `--json`.
- **Why**: Teams should get a repeatable CI ratchet instead of hand-copying docs.

### 8.3 — Implement GitHub Actions output

- [ ] **File**: `src/runtime/command-handlers.ts:259-268`
- **Source**: `scip-query plan-context handleSetupAgent`
- **What**: `handleSetupAgent` delegates setup behavior and prints written/unchanged/skipped targets.
- **Change**: Add `handleSetupCi` with the same result-printing style. For `github`, write `.github/workflows/scip-query.yml` with Node setup, dependency install, cache restore for the scip-query cache directory, `scip-query reindex`, `scip-query diff-gate --base origin/main --json`, `scip-query health --baseline --json`, and artifact upload.
- **Why**: The feedback asked for the local ratchet to become a team ratchet.

### 8.4 — Implement generic CI output

- [ ] **File**: `src/runtime/ci-setup.ts`
- **Source**: `scip-query plan-context handleSetupAgent`
- **What**: New setup generator from Step 8.1 owns CI files.
- **Change**: For `generic`, write `scip-query-ci.sh` with POSIX shell commands and comments describing required cache/artifact wiring.
- **Why**: Non-GitHub teams still need a supported path.

### 8.5 — Test generated files

- [ ] **File**: `tests/agent-setup.test.ts`
- **Source**: `scip-query plan-context handleSetupAgent`
- **What**: Setup-agent already has tests and is the closest file-generation analogue.
- **Change**: Add `tests/ci-setup.test.ts` or extend setup tests to assert no overwrite unless content matches, correct workflow commands, JSON artifact paths, and generic shell output.
- **Why**: CI templates are user-facing integration contracts.

## Phase 9 — Config Validate and Doctor

### 9.1 — Add config validation helper

- [ ] **File**: `src/runtime/config.ts:20-37`
- **Source**: `scip-query plan-context loadProjectConfig`
- **What**: `loadProjectConfig` now throws on invalid JSON but does not validate shape.
- **Change**: Add `validateProjectConfig(projectRoot)` returning `{ ok, path, config, errors, warnings }`. Validate language names, watch numeric fields, `indexer` keys, `dbPath` type, `entryRoots` arrays, and TypeScript semantic tsconfig values.
- **Why**: Syntactically valid but semantically wrong config can still disable intended behavior.

### 9.2 — Register `config validate`

- [ ] **File**: `src/runtime/command-descriptors.ts:157-164`
- **Source**: `scip-query code src/runtime/command-descriptors.ts:147-195`
- **What**: `init` creates `.scipquery.json`, but there is no validation command.
- **Change**: Add a descriptor for `config validate` or `config-validate`. Prefer `config validate` only if commander nested subcommands fit the existing descriptor registry; otherwise use `config-validate` to preserve the flat descriptor model.
- **Why**: Users need a direct command to check config before running heavier analysis.

### 9.3 — Add `doctor`

- [ ] **File**: `src/runtime/command-descriptors.ts:147-195`
- **Source**: `scip-query code src/runtime/command-descriptors.ts:147-195`
- **What**: `check-deps` checks indexer readiness, and `status` checks index existence/stats.
- **Change**: Add `doctor` that composes config validation, project readiness, index freshness from Phase 6, DB existence, and semantic readiness.
- **Why**: `doctor` should be the one command that explains why scip-query may not be trustworthy in a project.

### 9.4 — Keep `check-deps` focused

- [ ] **File**: `src/runtime/command-handlers.ts:208-249`
- **Source**: `scip-query code src/runtime/command-handlers.ts:208-340`
- **What**: `handleCheckDeps` currently prints scip CLI, detected languages, indexers, and semantic provider readiness.
- **Change**: Do not turn `check-deps` into `doctor`; instead, have `doctor` call a shared readiness formatter/helper that `check-deps` can reuse.
- **Why**: Existing command semantics stay stable while `doctor` becomes the broader diagnostic.

## Execution Order

1. Phase 2 stable finding schema before Phase 7 structured suppressions, because suppressions need stable finding IDs.
2. Phase 1 JSON output before Phase 8 CI initializer, because CI artifacts should upload structured output.
3. Phase 6 stale-index detection before Phase 9 doctor, because doctor should include freshness.
4. Phase 5 cleanup labels before Phase 3 cleanup apply, because apply must know exactly what was verified and what was not.
5. Phase 4 capability matrix can ship independently after `getProjectReadiness` is extended.
6. Phase 8 CI initializer should ship after JSON output and stale-index enforcement so CI has reliable artifacts and failures.

## Ship Order

1. Ship Phase 2 limited to `diff-gate` finding IDs and metadata, then update `diff-gate --json` from Phase 1 for that schema.
2. Ship Phase 1 shared JSON support for report/list commands and custom JSON for `diff-gate`, `cleanup-plan`, and `status`.
3. Ship Phase 6 stale-index warnings with `--ensure-fresh` for `diff-gate` and `plan-context`.
4. Ship Phase 5 cleanup verification labeling.
5. Ship Phase 3 `cleanup-plan --patch`; ship `cleanup-apply` only after patch generation is stable.
6. Ship Phase 4 capability matrix and `status --capabilities`.
7. Ship Phase 7 structured suppressions.
8. Ship Phase 8 CI initializer.
9. Ship Phase 9 config validate and doctor.

`cleanup-apply` is the main one-way-door-adjacent phase because it mutates user files. It must remain behind verification, dirty-worktree checks, and backup patch creation. Other phases are mostly additive command/schema work and can be reversed by removing the new options/commands.

## Verification Plan

Run these after each phase:

- `npm run typecheck`
- `npm run lint`
- Focused tests for the phase, then `npm test`
- `scip-query reindex && scip-query diff-gate`

Run these additional checks by phase:

- JSON output: `npm test -- tests/cli-contract.test.ts` and JSON snapshot/shape tests for representative list, report, and custom commands.
- Finding schema: baseline compatibility tests plus `scip-query diff-gate --json` fixture tests.
- Cleanup patch/apply: cleanup-plan tests covering verified, failed, uncovered, dirty, and backup paths.
- Capability matrix: project-readiness tests across TypeScript, Python, Rust, Go, and unsupported/no-checker fixtures.
- Stale index: reindex metadata tests that mutate tracked files and assert warning/enforcement behavior.
- Suppressions: parser tests for legacy and structured comments, plus detector filtering tests.
- CI initializer: file-generation tests for GitHub and generic templates.
- Config validate/doctor: tests for invalid JSON, invalid shape, unknown language, bad watch values, missing index, stale index, and missing semantic provider.

## Summary

This plan intentionally makes the tool more trustworthy before making it more powerful. The highest-value early sequence is: stable finding metadata, JSON output, freshness checks, and clearer cleanup verification. Cleanup apply and CI setup should come after that foundation, because they automate actions that should only run on evidence the tool can explain.
