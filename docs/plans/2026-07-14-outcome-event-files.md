# Outcome Event Files

Date: 2026-07-14

## Goal

Store each committed outcome event in its own `.scipquery/events/*.json` file so independent branches add independent paths instead of editing a shared JSONL file. Preserve existing effectiveness history, stop creating the JSONL merge rule, and migrate a legacy ledger on the next outcome write.

## Current State

- `appendOutcomeEvents()` explicitly creates `.scipquery/ledger`, installs an `events.jsonl merge=union` attribute, and appends every event to the same file. Source: `scip-query code appendOutcomeEvents` (`src/storage/outcome-events.ts:115-122`).
- `readOutcomeEvents()` reads only that JSONL file, skips malformed lines, and feeds valid records through the existing deduper. Source: `scip-query code readOutcomeEvents` (`src/storage/outcome-events.ts:147-164`).
- Gate outcome recording has exactly one storage caller, `recordDiffGateOutcomes()`, and effectiveness has exactly one storage reader, `handleEffectiveness()`. Source: `scip-query trace appendOutcomeEvents`, `scip-query trace readOutcomeEvents`, and `scip-query code handleEffectiveness`.
- The storage module has medium change risk and three external consuming files; the event shape also feeds the effectiveness calculation. Source: `scip-query change-surface src/storage/outcome-events.ts --json --full` and `scip-query dataflow OutcomeEvent`.
- Generated agent guidance names the JSONL file and `.gitattributes` as repository records. Source: `scip-query code writeInstructionsBlock` (`src/runtime/agent-setup.ts:117-146`).

## Reuse Audit

- Keep `OutcomeEvent`, `deriveOutcomeEvents()`, `appendOutcomeEvents()`, `readOutcomeEvents()`, and `dedupeEvents()` so the transition contract and both consumers remain unchanged. Source: `scip-query plan-context src/storage/outcome-events.ts`.
- Extend the existing storage module instead of adding a new store: it already owns validation, dedupe, Git identity, and the filesystem boundary. Source: `scip-query outline src/storage/outcome-events.ts`.
- Follow the suppression store's one-record-per-file shape, but do not reuse `suppressionFileName()`: suppressions have one mutable record per finding/check identity, while outcome history can contain multiple transition observations for the same finding. Event filenames therefore need the observation timestamp and a content hash. Source: `scip-query code suppressionFileName` and `scip-query code writeSuppressionFile`.
- Add only private writing/parsing/migration helpers inside the existing module. They isolate deterministic naming and JSON validation from filesystem effects without expanding the package contract.

## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| One file per event | `appendOutcomeEvents()` in a temporary root | Temporary filesystem root | Filename derived from serialized event | Directory creation and exclusive file write | Every valid input event is readable from one `.json` record without a shared append target |
| Legacy migration | `appendOutcomeEvents()` with a seeded JSONL ledger | Temporary filesystem root | Existing validation and dedupe | Write event files, then remove legacy JSONL and its merge attribute | Valid legacy history survives; invalid legacy lines remain ignored; new writes never target JSONL |
| Mixed-version reads | `readOutcomeEvents()` with legacy and file records | Temporary filesystem root | Existing event validator and deduper | Directory enumeration and file reads | Both stores are accepted during migration and duplicate facts collapse to the earliest timestamp |
| User-facing repository guidance | `setupAgent()` and effectiveness command tests | Temporary project root / captured output | Message selection | Managed AGENTS.md write / console output | Guidance names `.scipquery/events/*.json` only |

## Design Phases

### 1.1 - Replace the shared append target

- [x] **File**: `src/storage/outcome-events.ts:1-190`
- **Source**: `scip-query code 'src/storage/outcome-events.ts:1-210'`
- **What**: The module appends JSONL and creates a union merge attribute; the reader accepts only that file.
- **Change**: Write pretty-printed event objects to `.scipquery/events/<timestamp>-<content-hash>.json` with exclusive-create semantics; read and validate all JSON event files; retain a legacy JSONL reader; on any append call, write valid legacy records first and remove the legacy file/merge entry only after writes succeed.
- **Testability**:
  - Test seam: existing exported append/read functions.
  - Injected dependencies: temporary project root; no production dependency injection is needed for filesystem-only integration tests.
  - Pure core: event serialization, filename derivation, validation, and dedupe.
  - Side-effect shell: filesystem enumeration, exclusive writes, and legacy cleanup.
  - Contract: existing callers still pass/receive `OutcomeEvent[]`; append failures still propagate to the caller's non-blocking warning boundary.
- **Validation**: `npx vitest run tests/storage/outcome-events.test.ts` and `npm run typecheck`.
- **Why**: This is the root cause and the smallest boundary that removes shared-file churn without changing outcome semantics.

### 1.2 - Lock the migration and conflict behavior in tests

- [x] **File**: `tests/storage/outcome-events.test.ts`
- **Source**: `scip-query files events`; the test file is not indexed (`scip-query plan-context tests/storage/outcome-events.test.ts` returned no definition), so validation is the authoritative seam.
- **What**: Tests currently require `events.jsonl merge=union`, append malformed JSONL directly, and do not cover independent paths or migration.
- **Change**: Assert one JSON file per distinct event, exact replay idempotence, malformed individual files ignored, mixed legacy/current reads deduped, and append-triggered legacy cleanup with unrelated gitattributes preserved.
- **Testability**:
  - Test seam: temporary directory round trips.
  - Injected dependencies: temporary project root.
  - Pure core: dedupe expectations.
  - Side-effect shell: test-only seeded files.
  - Contract: conflict avoidance is demonstrated by distinct event paths rather than a merge driver.
- **Validation**: `npx vitest run tests/storage/outcome-events.test.ts`.
- **Why**: The regression was an explicit storage contract, so tests must replace rather than merely loosen it.

### 1.3 - Reconcile live guidance and command output

- [x] **Files**: `src/runtime/commands/command-handlers.ts:28,1033-1037`, `src/runtime/agent-setup.ts:117-130`, `tests/runtime/agent-setup.test.ts:20-35`, `README.md`, `skills/_shared/SKILL.md`, `skills/scip-calibrate/SKILL.md`, `AGENTS.md`, `CHANGELOG.md`
- **Source**: `scip-query code handleEffectiveness`, `scip-query code writeInstructionsBlock`, and `scip-query files events`.
- **What**: Live command text, generated setup guidance, and current docs tell users to commit `events.jsonl` and its merge attribute.
- **Change**: Name `.scipquery/events/*.json`, explain one-file-per-event conflict avoidance and legacy read/migration compatibility, and update assertions.
- **Testability**:
  - Test seam: agent setup test and effectiveness command tests.
  - Injected dependencies: temporary project/output capture already provided by tests.
  - Pure core: rendered strings.
  - Side-effect shell: managed guidance file and console output.
  - Contract: generated instructions match actual repository records.
- **Validation**: `npx vitest run tests/runtime/agent-setup.test.ts tests/runtime/effectiveness-command.test.ts` (or the discovered effectiveness command test) and `npm run lint`.
- **Why**: Setup-generated instructions are operational behavior; leaving the legacy path would recreate the user's confusion.

### 1.4 - Convert this repository's committed history

- [x] **Files**: delete `.scipquery/ledger/events.jsonl` and `.scipquery/ledger/.gitattributes`; create `.scipquery/events/*.json`
- **Source**: `scip-query files events` identifies the owner; the storage migration contract is defined in step 1.1.
- **What**: The repository currently contains 87 JSONL records in the shared path.
- **Change**: Run the new migration boundary against this repository, verify all valid deduped events remain readable, and commit the individual records with the implementation.
- **Testability**:
  - Test seam: local `readOutcomeEvents()`/`effectiveness --json` after build.
  - Injected dependencies: repository root.
  - Pure core: validation/dedupe.
  - Side-effect shell: migration writes and legacy cleanup.
  - Contract: no tracked JSONL or ledger merge attribute remains; effectiveness totals are preserved.
- **Validation**: compare pre/post event counts and `node dist/cli.js effectiveness --json` after `npm run build`.
- **Why**: Changing future writes alone would leave the current merge-conflict source in place.

## Stress-Test Findings

- **Concurrency**: exclusive creation prevents partial overwrite; filename hashes include the complete serialized observation, so different observations use different paths and exact duplicates use identical contents.
- **Failure/data integrity**: legacy deletion occurs only after every valid legacy and new event file write succeeds. The gate's existing catch boundary continues to turn storage failures into warnings.
- **Compatibility**: readers accept legacy JSONL and new event files together, so effectiveness works before and during migration.
- **Malformed data**: malformed JSON and unknown shapes remain ignored, matching the current reader contract.
- **Blast radius**: the event object and effectiveness computation do not change; only storage paths, setup text, tests, and live documentation move.
- **Reversibility**: the new reader can reconstruct the same event array; rollback can concatenate individual JSON objects back into JSONL, though doing so reintroduces the shared path.
- **Observability**: storage exceptions retain the existing `outcome event ledger not updated` warning surfaced by `recordDiffGateOutcomes()`.

## Execution Order and Deployable Phases

1. Storage implementation and focused tests form one deployable compatibility phase because the reader supports both formats.
2. Guidance and docs ship with the same phase so newly generated instructions cannot mention the removed write target.
3. Repository data migration runs only after focused tests pass.

## Ship Order

- Ship code, tests, docs, and migrated event records together.
- Deleting the legacy repository file is a one-way repository-layout change, but event content remains reversible because each JSON object is preserved.

## File Summary

- **Create**: `.scipquery/events/*.json`.
- **Edit**: `src/storage/outcome-events.ts`, `src/runtime/commands/command-handlers.ts`, `src/runtime/agent-setup.ts`, storage/setup tests, README, changelog, current skill guidance, and generated `AGENTS.md` guidance.
- **Delete**: `.scipquery/ledger/events.jsonl`, `.scipquery/ledger/.gitattributes`.
- **Verify**: focused tests, typecheck/lint/build, event-count/effectiveness smoke checks, applicable co-change/doc-drift checks, `scip-query reindex`, and local built `diff-gate --json`.
