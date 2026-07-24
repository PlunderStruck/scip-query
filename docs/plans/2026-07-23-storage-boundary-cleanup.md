# Storage Boundary Cleanup Plan

Date: 2026-07-23

## Goal

Remove all three declared `storage` boundary violations without weakening the
storage rule, changing detector-outcome behavior, or introducing forwarding
abstractions. Completion means the observed storage boundary depends only on
`domain` and `instrumentation`, its three accepted baseline identities are
removed, targeted tests pass, and the architecture-aware diff gate passes.

## Definitions and Invariants

A storage mechanism is code whose real referents are SQLite access, cache
persistence, or repository-file serialization. It is a mechanism distinguished
by preserving and retrieving values without deciding the higher-level workflow
that gives those values meaning. Sources: `scip-query system src/storage`,
`scip-query code 'src/storage/outcome-events.ts:1-293'`.

An outcome model is the dependency-free set of values and transition rules
whose referents are finding records and immutable caught/resolved/suppressed
events. It is a domain contract distinguished by producing the same transition
facts regardless of whether records are stored in SQLite, JSON files, or test
memory. Sources: `scip-query code
'src/queries/health/finding-outcome-ledger.ts:1-235'`, `scip-query code
'src/storage/outcome-events.ts:33-116'`.

A path-exclusion capability is the single operation by which a database reader
asks whether a repository-relative path is excluded. Its referents are
`ScipDatabase.isIgnored()` and `createGitignoreFilter()`. It is a consumer-owned
port distinguished by exposing only `isIgnored`, the sole operation storage
uses. Sources: `scip-query refs PathFilter`, `scip-query code
'src/storage/db.ts:40-62'`.

Invariants:

- I1. `storage -> X` is allowed iff `X` is `domain` or `instrumentation`.
- I2. For identical previous records, next records, symbols, commit, time, and
  evidence, outcome-event derivation must always return identical events.
- I3. Repository event reads and writes must always preserve their current file
  format, idempotence, legacy migration, malformed-record tolerance, and
  evidence-preference behavior.
- I4. Diff-gate outcome reconciliation must always use the same HEAD,
  comparison commit, and cleanliness semantics as before.
- I5. `ScipDatabase.isIgnored(path)` must always delegate to an injected
  capability when present and return false otherwise.
- I6. An architecture baseline identity may be removed iff the corresponding
  forbidden boundary pair is absent from the current graph.

## Premises

- P1. The index is fresh with 341 files and all TypeScript/Rust evidence
  capabilities available. Source: `node dist/cli.js status --capabilities`.
- P2. All 341 files map to 16 boundaries; storage has exactly three forbidden
  pairs: `analysis`, `queries`, and `source`. Source:
  `node dist/cli.js architecture --json`.
- P3. The storage row allows exactly `domain` and `instrumentation`. Source:
  `.scipquery.json:82-87`.
- P4. `src/storage/outcome-events.ts` is the sole storage importer of analysis
  and queries; it imports `runGit`, `ledgerKey`, and
  `FindingOutcomeRecord`. Source: `scip-query deps
src/storage/outcome-events.ts`; `scip-query code
'src/storage/outcome-events.ts:22-140'`.
- P5. Readers of outcome event persistence are
  `queries/health/effectiveness.ts`, `runtime/commands/command-handlers.ts`,
  and `runtime/diff-gate-outcomes.ts`; the runtime orchestrator is the only
  caller of event derivation and Git state helpers. Source: `scip-query rdeps
src/storage/outcome-events.ts`; `scip-query refs deriveOutcomeEvents`;
  `scip-query refs headCommit`; `scip-query refs gitWorktreeIsClean`.
- P6. The complete readers/writers of the finding-outcome identity surface are
  `queries/health/finding-outcome-ledger.ts`,
  `storage/outcome-events.ts`, and `runtime/diff-gate-outcomes.ts`. Source:
  `scip-query refs FindingOutcomeRecord`; `scip-query refs ledgerKey`.
- P7. `runtime/git-worktree.ts` already exposes
  `resolveGitWorktreeContext()` with `headCommit` and `clean`, plus
  `gitOutput()` for arbitrary Git commands. Source: `scip-query code
'src/runtime/git-worktree.ts:26-216'`.
- P8. `PathFilter` has exactly one non-source consumer:
  `src/storage/db.ts`; storage calls only `isIgnored`. Source:
  `scip-query refs PathFilter`; `scip-query code
'src/storage/db.ts:40-62'`.
- P9. Targeted tests cover pure event transitions, JSON round trips,
  idempotence, legacy migration, Git repository state, diff-gate outcome
  reconciliation, and database path exclusions. Tests are not SCIP-indexed.
  Source: `rg -n
"deriveOutcomeEvents|appendOutcomeEvents|gitWorktreeIsClean|recordDiffGateOutcomes|ScipDatabase"
tests/storage tests/runtime tests/analysis`.
- P10. The baseline contains the three stable storage violation identities.
  Source: `.scipquery-baseline.json:4-6`.

## Current State

The closed storage row is correct, but one mixed file crosses upward to query
policy and Git analysis while `ScipDatabase` imports a producer-owned source
interface (P2-P4, P8). The outcome model has three complete consumer groups:
health calculation, JSON persistence, and runtime orchestration (P5-P6).
Existing runtime Git capabilities cover the behavior currently duplicated in
storage (P7).

## Reuse Audit

- Extend `runtime/git-worktree.ts` behavior through its existing
  `resolveGitWorktreeContext()` and `gitOutput()` APIs; do not add another Git
  wrapper (P7).
- Reuse the existing outcome transition implementations by moving them
  unchanged into a dependency-free domain module; do not add a facade (P4-P6).
- Replace the source-owned `PathFilter` dependency with a minimal
  storage-consumer contract because no existing lower-level contract exposes
  only the operation storage needs (P8).
- Keep JSON serialization in `storage/outcome-events.ts`; moving the whole file
  would relabel rather than separate responsibilities (P4-P5).

## Testability Design

| Behavior                     | Test seam                                        | Injected dependencies             | Pure core               | Side-effect shell    | Contract                            |
| ---------------------------- | ------------------------------------------------ | --------------------------------- | ----------------------- | -------------------- | ----------------------------------- |
| Finding-to-event transitions | `deriveOutcomeEvents()`                          | time and commits as values        | domain transition       | none                 | outcome records to immutable events |
| Event persistence            | `appendOutcomeEvents()` / `readOutcomeEvents()`  | temporary project root            | parsing/dedupe          | filesystem           | one immutable JSON file per event   |
| Git state                    | `resolveGitWorktreeContext()` / `gitOutput()`    | existing `GitReader`              | parsing                 | Git subprocess       | optional HEAD, commit, cleanliness  |
| Path exclusion               | `ScipDatabase.isIgnored()`                       | minimal path-exclusion capability | delegation decision     | injected predicate   | relative path to boolean            |
| Architecture                 | `architecture()` / `checkArchitectureBaseline()` | fixture or project config         | boundary classification | database/config load | stable forbidden-pair identities    |

## Implementation

### 1. Consumer-own the path-exclusion port

- [x] **Files**: `src/storage/db.ts`,
      `tests/storage/db-path-exclusions.test.ts`
- **Premises**: P8, P9
- **Deployable**: yes
- **Change**: Replace the source `PathFilter` import with a locally owned
  `PathExclusionPolicy` containing only `isIgnored`. Add a test proving a
  capability without `filter()` can be injected.
- **Validation**: targeted database test and typecheck.

### 2. Separate the outcome model from persistence

- [x] **Files**: create `src/domain/finding-outcomes.ts`; edit
      `src/queries/health/finding-outcome-ledger.ts`,
      `src/storage/outcome-events.ts`, `src/queries/health/effectiveness.ts`,
      `src/runtime/diff-gate-outcomes.ts`, and outcome tests.
- **Premises**: P4-P6, P9
- **Deployable**: yes
- **Change**: Move the outcome record/event value types, `ledgerKey()`, pure
  event derivation, and lifecycle-anchor selection into `domain`. Keep the
  health-ledger calculations/query storage shell and repository-file
  persistence in their current owners. Preserve source-compatible re-exports
  from the health ledger only where existing consumers require them.
- **Validation**: outcome, effectiveness, and runtime reconciliation tests.

### 3. Reuse runtime Git state

- [x] **Files**: `src/runtime/diff-gate-outcomes.ts`,
      `src/storage/outcome-events.ts`, relevant runtime/analysis tests
- **Premises**: P4, P5, P7, P9
- **Deployable**: yes
- **Change**: Remove Git operations from storage. Resolve default HEAD and
  cleanliness through `resolveGitWorktreeContext()` and comparison commits
  through `gitOutput()` in the runtime orchestrator. Keep existing injected
  runtime callbacks unchanged.
- **Validation**: Git-worktree and diff-gate-outcome tests.

### 4. Retire proved-fixed architecture debt

- [x] **Files**: `.scipquery-baseline.json`, this plan
- **Premises**: P2, P3, P10
- **Deployable**: yes, after steps 1-3
- **Change**: Reindex, prove storage has no forbidden edge, then remove exactly
  the three `architecture:forbidden-edge:storage:*` identities.
- **Validation**: `architecture --json`, `drift --architecture`, default
  `diff-gate`.

## Counterexample Attacks

### A1. Partial path-filter implementation

- Attack: a caller injects an object with `isIgnored` but no `filter`; database
  construction and path checks run.
- Outcome: HOLE in the current producer-owned type; repaired by step 1 (P8-P9).

### A2. Event transition changes during relocation

- Attack: previous records contain still-open, suppressed, and resolved
  findings; the next snapshot exercises every transition and verification
  evidence.
- Outcome: HELD by step 2's unchanged pure function and existing transition
  tests (P4, P9).

### A3. Concurrent/replayed event observations

- Attack: independent observations write the same event facts in different
  order, including stronger later verification evidence.
- Outcome: HELD by storage round-trip, idempotence, and dedupe tests in step 2
  (P9).

### A4. Non-repository or dirty repository

- Attack: outcome reconciliation runs outside Git, then in a dirty worktree,
  then in a clean worktree.
- Outcome: HELD by step 3 using the already tested optional worktree context
  and retained runtime injection seam (P7, P9).

### A5. Baseline removed before the dependency is fixed

- Attack: one import remains but its stable baseline identity is deleted.
- Outcome: HELD by step 4 ordering; default diff-gate blocks the new identity
  under I6 (P2-P3, P10).

### A6. Cosmetic move hides mixed responsibility

- Attack: move all outcome code under queries without separating file I/O;
  query code now owns persistence and the graph merely changes labels.
- Outcome: HOLE in the rejected draft; repaired by step 2's domain/storage
  separation (P4-P6).

### A7. New Git wrapper duplicates process behavior

- Attack: add a second exec wrapper with different status flags or object-ID
  validation.
- Outcome: HOLE in the rejected draft; repaired by step 3's reuse of the
  runtime Git worktree APIs (P7).

| Surface or lens                               | Attacks    |
| --------------------------------------------- | ---------- |
| Path-exclusion producer and database reader   | A1         |
| Finding outcome readers/writers               | A2, A5     |
| Repository event persistence                  | A3         |
| Runtime outcome orchestrator                  | A2, A4     |
| Git availability and cleanliness              | A4, A7     |
| Valid intermediate state / enforcement window | A5         |
| Ownership boundaries                          | A6         |
| Reuse                                         | A7         |
| Failure and reversibility                     | A3, A4, A5 |
| Testability                                   | A1-A4      |

## Execution and Ship Order

Steps 1-3 are independently testable but ship together so no compatibility
re-export becomes permanent architecture. Step 4 is last because baseline
removal is valid only after graph proof. Rollback restores imports and baseline
identities; no persisted data format changes.

## Verdict

A plan is PLANNED-COMPLETE iff every invariant has an implementation step,
every state reader/writer and applicable lens appears in the attack matrix,
every attack is held or repaired with cited premises, and premise
reverification succeeds.

Result: **PLANNED-COMPLETE** — 7 attacks, 3 draft holes repaired, 0 accepted
holes.

## Implementation Result

Implemented on 2026-07-23. After a fresh reindex,
`node dist/cli.js architecture --json` mapped 342/342 files and reported:

- storage depends only on `domain` and `instrumentation`;
- both storage relationships are allowed;
- zero forbidden architecture edges;
- 75 undeclared relationships remain intentionally descriptive;
- reciprocal pairs decreased from 11 to 8.

`node dist/cli.js drift --architecture` reported zero declared architecture
violations. The three stable storage baseline identities were removed only
after this graph proof.

## File Summary

- Create: `src/domain/finding-outcomes.ts`,
  `docs/architecture/scip-query-target-architecture.md`.
- Edit: storage database/events, health outcome/effectiveness, runtime outcome
  orchestration, focused tests, `.scipquery-baseline.json`.
- Delete: none.
- Verify: targeted tests, build, typecheck, architecture graph, drift,
  applicable postchecks, reindex, and diff-gate.
