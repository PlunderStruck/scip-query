# doc-drift --full Optimization Ledger

## Output Contract

- Target command: `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js doc-drift --json --full`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Required behavior: preserve the JSON envelope and ranked drift findings, including `doc`, `docLastChangedAt`, `staleness`, subject ordering, broken references, citation contexts, intent classification, and action tiers.

## Measurements

| Case                                       |        Before |          After |                  Delta | Evidence                                                                                                                                                      |
| ------------------------------------------ | ------------: | -------------: | ---------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vega_2.0 warm local CLI `doc-drift --full` | 3.472s median |  1.085s median |    2.387s faster; 3.2x | Populate run 3.760s; warm repeats 1.085s, 1.087s, 1.053s; stdout 963,953 bytes; SHA-256 `7f8765a247b9e6a0ab2cbd0e99b38b51acf7ce689cd7b7b02165cdb80f97cc8c`.   |
| CPU profile, same command                  |    3.49s wall | not reprofiled | warm wall confirms fix | Output hash unchanged; baseline top self-time was `PATH_REFERENCE_PATTERN` regex at about 2.054s, followed by git child-process and file reads.               |
| Reuse audit for existing path-token cache  |       present |    implemented |                      - | `docPathEvidence()` now persists both path candidates and citation contexts as `doc-path-evidence`; `doc-path-tokens` rows remain harmless legacy cache data. |

## Current Pipeline

- `docDrift()` builds a scan index, loops tracked docs, skips non-living docs in aggregate mode, classifies doc intent, extracts file references with citation contexts, computes code changes after the doc update, merges co-change evidence, sorts findings, and returns the requested limit. Source: `scip-query plan-context docDrift`.
- `buildDocDriftScanIndex()` loads git commit history and tracked files, then builds per-file change timestamps, doc-code co-change counts, the tracked doc list, the ever-seen history set, and suffix index. Source: `scip-query code buildDocDriftScanIndex -C 20`.
- Baseline `extractFileReferences()` called separate candidate and citation-context helpers, then resolved full-path and suffix references against tracked files and history. Source: `scip-query code extractFileReferences -C 20`.
- Implemented `docPathEvidence()` reads a doc once, computes `fileContentHash()`, uses `readCachedFileEvidence()` / `writeCachedFileEvidence()` with kind `doc-path-evidence`, and stores path-shaped candidates plus bounded citation contexts by content hash.
- Implemented `extractFileReferences()` and `docsCitingFiles()` consume the combined evidence while keeping tracked-file and suffix resolution live.

## Current-Pipeline Optimization Candidates

- Accepted next trial: persist combined per-doc path evidence, including candidates and citation contexts, under a new content-hash-keyed file-evidence kind. This keeps resolution against tracked files live while moving the expensive regex/context scan out of repeated CLI runs.
- Deferred: rewrite co-change history counting. The profile shows regex/context scanning is the top current cost; history child-process work is smaller and shared with other git-history commands.

## Alternative Designs

- Replace markdown regex scans with an indexed document-reference table during reindex. This could be faster but widens the index schema and would need a cold-index cost study.
- Use a single combined function for doc-drift and diff-gate doc-reference scans. This risks parameterizing two different questions; the existing source has an explicit suppression saying they intentionally share toolkit helpers without merging behavior.

## Decisions

- Implemented: add a `doc-path-evidence` payload that stores both path candidates and `candidate -> citation contexts` arrays. Existing `doc-path-tokens` rows remain harmless legacy cache data.
- Preserved: resolution against currently tracked files and suffix indexes still happens outside the payload, so cached doc text evidence cannot freeze file-move behavior.
- Extracted shared evidence-payload validators after diff-gate found the local JSON shape guards duplicated React profile cache guards.

## Verification

- Passed: `npm test -- tests/analysis/git-history.test.ts tests/storage/evidence-cache.test.ts`
- Passed: `npm test`
- Passed: `npm run typecheck`
- Passed: `npm run build`
- Passed: Vega local CLI before/after stdout SHA-256 `7f8765a247b9e6a0ab2cbd0e99b38b51acf7ce689cd7b7b02165cdb80f97cc8c`.
- Final local-build Vega probe after helper extraction: 1.755s, 1.112s, 1.076s; same 963,953 bytes and SHA-256.
- Passed: `scip-query diff-impact --json`
- Passed: `scip-query unused-params --json --full`
- Passed: `scip-query wrapper-candidates --json --full`
- Passed: `scip-query doc-drift --json --full`
- Passed: `scip-query recent-duplicates --json --full`
- Passed: `scip-query self-audit --json`
- Passed: `scip-query reindex && scip-query diff-gate --json` with zero findings and zero root-cause groups.
