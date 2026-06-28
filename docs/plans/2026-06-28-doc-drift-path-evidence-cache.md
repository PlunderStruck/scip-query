# Doc Drift Path Evidence Cache Plan

Date: 2026-06-28

## Goal

Make `doc-drift --json --full` faster on doc-heavy repos without changing drift findings, citation contexts, broken-reference detection, doc intent, or diff-gate doc-reference behavior. Done means Vega_2.0 keeps the same 963,953-byte output and SHA-256 `7f8765a247b9e6a0ab2cbd0e99b38b51acf7ce689cd7b7b02165cdb80f97cc8c` while warm median improves from the current 3.472s local-CLI baseline.

## Current State

- Fresh Vega local-CLI baseline: `doc-drift --json --full` repeated at 4.416s, 3.472s, and 3.432s, with stable 963,953-byte stdout and SHA-256 `7f8765a247b9e6a0ab2cbd0e99b38b51acf7ce689cd7b7b02165cdb80f97cc8c`.
- A CPU profile of the same command kept the output hash unchanged and showed `PATH_REFERENCE_PATTERN` regex self-time at about 2.054s, the top cost.
- `docDrift()` builds a scan index, loops docs, filters living docs, classifies doc intent, calls `extractFileReferences()`, evaluates co-change partners, and returns sorted findings. Source: `scip-query plan-context docDrift`.
- `extractFileReferences()` currently calls `docPathCandidates()` and `docCitationContextWindows()` for the same doc. Source: `scip-query code extractFileReferences -C 20`.
- `docPathCandidates()` already reads the doc once, hashes the content, and caches unique path-shaped tokens in `file_evidence` as `doc-path-tokens`. Source: `scip-query code docPathCandidates -C 20`.
- `docCitationContextWindows()` rereads the doc and rescans every line with `PATH_REFERENCE_PATTERN` to produce contexts. Source: `scip-query code docCitationContextWindows -C 25`.
- `docsCitingFiles()` uses the same two helpers for diff-gate doc-reference checks. Source: `scip-query code docsCitingFiles -C 25`.
- `FileEvidenceKind` currently includes `doc-path-tokens` and `react-component-behavior-profiles`, so adding one more per-file content-hash payload matches an established boundary. Source: `scip-query code FileEvidenceKind -C 10`.

## Reuse Audit

- Reuse `fileContentHash()`, `readCachedFileEvidence()`, and `writeCachedFileEvidence()` rather than adding a new cache table. Source: `scip-query similar docPathCandidates --json --full`.
- Reuse the existing `docPathCandidates()` extraction policy and `markdownCitationContext()` window builder; only cache their combined pure content-derived result. Sources: `scip-query code docPathCandidates -C 20`; `scip-query code markdownCitationContext -C 20`.
- Reuse the current `uniqueCitationContexts()` overlap behavior so cached context arrays match fresh context arrays. Source: `scip-query code uniqueCitationContexts -C 15`.
- Do not merge `docDrift()` and `docsCitingFiles()`: the source explicitly suppresses that similarity because the two commands ask different questions. Source: `scip-query code docsCitingFiles -C 25`.

## Design Phases

### 1.1 — Add a path-evidence cache kind

- [x] **File**: `src/storage/evidence-cache.ts:26-32`
- **Source**: `scip-query code FileEvidenceKind -C 10`
- **What**: `FileEvidenceKind` enumerates pure per-file payloads stored by content hash.
- **Change**: Add `'doc-path-evidence'`.
- **Why**: Candidate tokens plus citation contexts are a pure function of the markdown file content; resolution against tracked files remains live outside the payload.

### 1.2 — Introduce a combined doc path evidence payload

- [x] **File**: `src/queries/cleanup/doc-drift.ts:417-548`
- **Source**: `scip-query code extractFileReferences -C 20`; `scip-query code docPathCandidates -C 20`; `scip-query code docCitationContextWindows -C 25`
- **What**: `docPathCandidates()` caches only token strings, while `docCitationContextWindows()` rereads/rescans markdown for contexts.
- **Change**: Add a local `DocPathEvidence` shape containing `candidates: string[]` and `contextsByCandidate: Array<[string, string[]]>`. Add `docPathEvidence(db, docFile)` to read content, check `doc-path-evidence`, deserialize/validate, otherwise scan once to compute both candidates and contexts and write the payload.
- **Why**: The expensive regex scan and markdown context extraction are content-derived and repeat across CLI invocations.

### 1.3 — Route doc-drift and diff-gate callers through the combined payload

- [x] **File**: `src/queries/cleanup/doc-drift.ts:314-350`
- **Source**: `scip-query code docsCitingFiles -C 25`
- **What**: `docsCitingFiles()` gets candidates, resolves cited targets, then asks for contexts for those candidates.
- **Change**: Use `docPathEvidence()` once per doc and filter its cached `contextsByCandidate` map to the candidate subset.
- **Why**: Diff-gate's doc-reference check benefits from the same cached evidence and keeps target resolution live.

- [x] **File**: `src/queries/cleanup/doc-drift.ts:417-460`
- **Source**: `scip-query code extractFileReferences -C 20`
- **What**: `extractFileReferences()` uses candidates and contexts for all path tokens in one doc.
- **Change**: Use `docPathEvidence()` once per doc; resolve candidates exactly as today and read citation contexts from the cached map.
- **Why**: This removes the duplicate read/regex scan in the main `docDrift()` path.

### 1.4 — Add persistent-cache regression coverage

- [x] **File**: `tests/analysis/git-history.test.ts`
- **Source**: `scip-query trace docDrift`; `scip-query code extractFileReferences -C 20`; `scip-query code docPathCandidates -C 20`.
- **What**: Existing git-history tests call `docDrift()` against real temporary git repos and already verify citation/intent behavior.
- **Change**: Add an assertion that `evidence.db` receives `doc-path-evidence` rows after `docDrift()` and that a reopened `ScipDatabase` returns the same result.
- **Why**: Proves the persistent cache path preserves observable output across processes.

## Stress-Test Findings

- **Understand before touching**: The path tokens are only candidates; tracked-file and suffix resolution must remain live because the same doc content can resolve differently as files move. Source: `scip-query code extractFileReferences -C 20`.
- **Blast radius**: `docDrift()` and `docsCitingFiles()` are the only users of the two helpers, and `docsCitingFiles()` feeds diff-gate. Sources: `scip-query refs docCitationContextWindows`; `scip-query refs docPathCandidates`; `scip-query code docsCitingFiles -C 25`.
- **Intermediate validity**: The cache kind and helper route must ship together; a kind without reads is harmless but not useful.
- **Reversibility**: This is a two-way cache change. Removing the new kind/helper returns to live scans. Existing `doc-path-tokens` rows are untouched.
- **Failure design**: Cache read/parse failure falls back to live extraction and overwrites the payload on success, matching existing cache behavior. Source: `scip-query code docPathCandidates -C 20`.
- **Concurrency**: Writes go through the existing evidence cache `INSERT OR REPLACE`; concurrent writers can rebuild the same pure payload without corrupting output. Source: `scip-query code writeCachedFileEvidence -C 25`.
- **Data integrity**: Content hash keys make stale same-file reads structurally impossible; path resolution stays outside the cache. Source: `scip-query code fileContentHash -C 15`.
- **Reuse**: The plan extends the existing doc path cache and evidence-cache boundary instead of adding a new cache mechanism.

## Execution Order

1. Add `doc-path-evidence` to `FileEvidenceKind`.
2. Add `DocPathEvidence` serialization/deserialization and extraction helpers.
3. Update `extractFileReferences()` and `docsCitingFiles()` to consume the combined evidence once per doc.
4. Add regression coverage and benchmark Vega local CLI.

The full slice is internally deployable and has no one-way doors.

## Verification

- `npm test -- tests/analysis/git-history.test.ts tests/storage/evidence-cache.test.ts`
- `npm test`
- `npm run typecheck`
- `npm run build`
- Vega local CLI `doc-drift --json --full` repeats with unchanged SHA-256 `7f8765a247b9e6a0ab2cbd0e99b38b51acf7ce689cd7b7b02165cdb80f97cc8c`
- `scip-query diff-impact --json`
- `scip-query unused-params --json --full`
- `scip-query wrapper-candidates --json --full`
- `scip-query doc-drift --json --full`
- `scip-query reindex && scip-query diff-gate --json`

## Summary

Implemented outcome:

- Vega_2.0 output stayed byte-identical at 963,953 bytes with SHA-256 `7f8765a247b9e6a0ab2cbd0e99b38b51acf7ce689cd7b7b02165cdb80f97cc8c`.
- Warm local-CLI median improved from 3.472s to 1.085s after one 3.760s cache-populate run.
- `extractFileReferences()` and `docsCitingFiles()` now use the combined `doc-path-evidence` payload; the old separate helpers were removed instead of retained as dead wrappers.
- Diff-gate follow-up extracted shared evidence payload validators into `src/storage/evidence-payload.ts`.

Expected files:

- `src/storage/evidence-cache.ts`
- `src/storage/evidence-payload.ts`
- `src/queries/cleanup/doc-drift.ts`
- `tests/analysis/git-history.test.ts`
- `docs/benchmarks/2026-06-28-doc-drift-ledger.md`
- `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`
