# Cache retention and write-I/O repair

Date: 2026-07-24

## Goal

Bound cache growth caused by affected-set telemetry, reclaim abandoned reindex
workspaces without racing a live reindex, and reduce telemetry write volume
without changing the authoritative index or the latest shadow-status contract.

## Definitions & Invariants

An abandoned reindex workspace is a cache directory created as private staging
for one reindex process whose exclusive reindex lock is no longer held by that
process. Its defining trait is that no live publisher can still own it.
Referents: `reindex-*` directories created by `createTempReindexPaths` and
normally removed by `reindex`'s `finally` block.

Affected-set history is an observational sequence of reindex outcomes whose
essential purpose is longitudinal calibration, not reconstruction of the
authoritative index. Referents: `affected-shadow.jsonl` and the complete latest
record in `affected-shadow-latest.json`.

Write amplification is storage traffic beyond the bytes needed for the durable
result. Here its referents are the same large shadow record appended to history
and rewritten as latest, plus temporary index artifacts retained after an
interrupted process.

- I1. A `reindex-*` directory must be deleted iff the current process holds the
  cache's exclusive reindex lock and did not create that directory.
- I2. The latest shadow file must always remain a complete version-1 record
  readable by `readAffectedSetShadowStatus`.
- I3. Shadow history must always contain newline-delimited summary records and
  occupy at most two bounded segments, apart from one record that can exceed a
  segment limit.
- I4. Telemetry or cleanup failure must never change which index generation is
  authoritative.

## Premises

- P1. `reindex` acquires `cache-lifecycle.lock` and the exclusive `index.lock`
  before it calls `createTempReindexPaths`, and its `finally` removes the
  current run directory. — Source: `scip-query plan-context
  createTempReindexPaths --json`.
- P2. `createTempReindexPaths` has one writer and one consumer: the call inside
  `reindex`; no other indexed code creates `reindex-*` staging directories. —
  Source: `scip-query refs createTempReindexPaths --json` + `scip-query
  dataflow createTempReindexPaths --json`.
- P3. `writeAffectedSetShadowRecord` has one production caller,
  `persistAffectedSetShadowRecord`; its runtime writes history first and latest
  second. — Source: `scip-query refs writeAffectedSetShadowRecord --json` +
  `scip-query dataflow writeAffectedSetShadowRecord --json`.
- P4. The only production reader of affected-set telemetry reads the latest
  file; repository search found no reader of `affected-shadow.jsonl`. — Source:
  `scip-query plan-context writeAffectedSetShadowRecord --json` + `rg -n
  "affected-shadow.jsonl" src tests`.
- P5. The measured Vega cache contained 88 `reindex-*` directories (78 older
  than one day) occupying about 5.0 GiB, and its 4,676-line full-record history
  occupied 2,141,266,418 bytes after 13.86 days. — Source:
  `docs/benchmarks/2026-07-24-cache-retention-io-baseline.md`.
- P6. The latest complete record is authoritative only for diagnostics; shadow
  persistence is already caught after index publication. — Source: `scip-query
  code persistAffectedSetShadowRecord --json`.

## Current State

The normal `finally` path removes a staging directory, but process death skips
that path and no later lifecycle sweep inspects staging directories inside a
live project cache (P1, P2, P5). Every shadow observation appends the complete
record and writes the same complete record as latest, while only latest has a
production reader (P3, P4). Telemetry failure is already observational rather
than authoritative (P6).

## Reuse Audit

- Extend `reindex`'s existing lock/cleanup envelope; do not add a cache daemon
  or a second ownership protocol (P1, P2).
- Extend the existing affected-shadow writer and runtime seam; do not add a
  second telemetry store (P3, P4).
- Add one history-summary type because a full shadow record and a longitudinal
  history row have different required information. Reusing the full type is
  the measured source of amplification (P5).

## Testability Design

| Behavior | Test seam | Dependencies | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Compact history | `summarizeAffectedSetShadowRecord` | none | record projection | default telemetry runtime | preserve outcome/count/reason evidence |
| Rotate history | `appendAffectedSetShadowHistory` | filesystem | size decision | append/remove/rename | current + one previous segment |
| Prune staging | `pruneStaleReindexRunDirectories` through `reindex` | filesystem + held lock | name/type filter | recursive remove | only real `reindex-*` directories |

## Design Phases

### 1.1 - Compact and bound affected-set history

- [x] **File**: `src/reindex/affected-shadow.ts`
- **Premises**: P3, P4, P5, P6
- **Deployable**: yes
- **Change**: Project complete records to small versioned summaries, rotate at
  8 MiB with one previous segment, and discard an oversized legacy segment on
  the first post-upgrade append. Keep the latest writer unchanged.
- **Testability**: Pure summary assertions plus temporary-directory tests for
  append, rotation, archive replacement, and immediate legacy reclamation.
- **Validation**: `vitest run tests/reindex/affected-shadow.test.ts`.
- **Why**: It removes duplicated large arrays from history writes while
  preserving the complete latest diagnostic (P4, P5).

### 1.2 - Prune abandoned reindex staging under the existing lock

- [x] **File**: `src/reindex/index.ts`
- **Premises**: P1, P2
- **Deployable**: yes
- **Change**: Immediately after acquiring the exclusive reindex lock, remove
  real sibling directories named `reindex-*`; ignore files, symlinks, and
  unrelated directories. Emit a status only when something was removed.
- **Testability**: Reliability test creates stale, unrelated, file, and symlink
  entries before invoking reindex.
- **Validation**: `vitest run tests/reindex/reindex-reliability.test.ts`.
- **Why**: Lock ownership proves every pre-existing staging directory is
  abandoned without age or PID guesses (P1, P2).

### 1.3 - Document and release

- [x] **Files**: `README.md`, `CHANGELOG.md`, benchmark records, package manifests
- **Premises**: P5
- **Deployable**: yes
- **Change**: Explain bounded cleanup behavior, record before/after storage
  evidence, bump the patch version, and publish the tested commit to `main`.
- **Validation**: focused tests, typecheck, build, format check, `scip-query
  reindex`, and `scip-query diff-gate`.

## Attack Record

### A1. Live publisher loses its staging directory
- **Attack**: watcher A indexes while CLI B starts and prunes A's directory.
- **Outcome**: HELD — the existing exclusive `index.lock` serializes both, and
  pruning runs only after B acquires it (step 1.2; P1, P2).

### A2. Forged symlink escapes the cache
- **Attack**: a local actor creates `reindex-evil` as a symlink to another
  directory before cleanup.
- **Outcome**: HOLE — repaired by step 1.2's real-directory `Dirent` filter and
  explicit no-follow test (P2).

### A3. Upgrade rotates a 2 GiB legacy history into another retained segment
- **Attack**: the first compact append sees a current file already over the new
  limit and archives it.
- **Outcome**: HOLE — repaired by step 1.1: pre-existing oversized current files
  are removed rather than archived (P5).

### A4. Compact history breaks status
- **Attack**: status reads a summary that omits full file arrays.
- **Outcome**: HELD — status continues to read the unchanged latest path and
  latest schema (step 1.1; P3, P4).

### A5. Telemetry rotation fails after index publication
- **Attack**: rename or append fails because the cache becomes read-only.
- **Outcome**: HELD — the caller's existing telemetry failure boundary reports
  degradation after authoritative publication (step 1.1; P6).

### A6. Cleanup removes unrelated cache content
- **Attack**: the cache contains `reindex-notes` as a file, a symlink, and a
  sibling directory named `language-indexes`.
- **Outcome**: HELD — the exact prefix plus real-directory filter preserves all
  but the real staging directory (step 1.2; P2).

| Surface or lens | Attacks |
| --- | --- |
| `createTempReindexPaths` writer | A1, A2, A6 |
| `reindex` staging consumer | A1, A6 |
| history writer | A3, A5 |
| latest writer/reader | A4, A5 |
| concurrency | A1 |
| boundary/data integrity | A2, A4, A6 |
| reversibility/failure | A3, A5 |
| efficiency | A3 |
| observability | A4, A5 |

## Execution and Ship Order

Steps 1.1 and 1.2 are independently deployable but ship together as a patch
because they address the two measured causes. Step 1.3 follows only after all
verification gates pass. The history format change is a one-way internal cache
transition; the complete latest file remains backward compatible.

## Verdict

A plan is `PLANNED-COMPLETE` iff every coverage row names an attack, every
attack is held by cited premises and steps or records a repaired/accepted hole,
and premise reverification succeeds.

Result: **PLANNED-COMPLETE** — 6 attacks, 2 holes repaired, 0 holes accepted;
the source-producing contexts reproduced before implementation.
