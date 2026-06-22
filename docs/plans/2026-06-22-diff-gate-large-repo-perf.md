# Diff Gate Large-Repo Performance Plan

Date: 2026-06-22

## Goal

`diff-gate` should stay quick on large repositories when the working-tree diff is small. The concrete repro is Vega 2.0: `scip-query diff-gate --json` against four indexed changed symbols takes about 22 seconds after the evidence cache is warm, with `echo` alone taking about 11 seconds and `co-change-partner` alone taking about 9.5 seconds.

Done means the same Vega diff runs materially faster without dropping the detector evidence that blocks real echoes or historically coupled partner files.

## Current State

- `diffGate()` builds one `diffImpactPlan`, computes changed files and symbols, then runs seven checks in sequence. Source: `scip-query code diffGate -C 8`, `src/queries/impact/diff-gate.ts:158-221`.
- `runEchoCheck()` calls `similar()` once per changed symbol. Source: `scip-query code runEchoCheck -C 8`, `src/queries/impact/diff-gate.ts:319-379`.
- `runEchoCheck()` previously skipped only symbols preexisting in renamed files, so ordinary edits to existing symbols still paid whole-repo echo search. Source: `scip-query code movedSymbolPreexistenceChecker -C 8`, `src/queries/impact/diff-gate.ts:918-937`.
- `similar()` builds/loads all callee fingerprints and `compareAgainstFingerprints()` compares the target with every candidate. Source: `scip-query code similar -C 8`, `src/queries/cleanup/similar.ts:64-81`; `scip-query code compareAgainstFingerprints -C 8`, `src/queries/cleanup/similar.ts:83-109`.
- `similarAll()` already avoids all-pairs comparison with a callee inverted index and a ubiquitous-callee cutoff. Source: `scip-query code similarAll -C 8`, `src/queries/cleanup/similar.ts:154-236`.
- `runCoChangePartnerCheck()` calls `getCoChangePairs()` for the whole repo, then filters down to changed-side pairs. Source: `scip-query code runCoChangePartnerCheck -C 8`, `src/queries/impact/diff-gate.ts:511-595`.
- `getCoChangePairs()` walks up to 2,000 commits and generates every file pair in each commit before filtering. Source: `scip-query code getCoChangePairs -C 8`, `src/analysis/git-history.ts:287-376`.

## Reuse Audit

- Reuse `similarAll()`'s candidate-index idea inside targeted `similar()` rather than inventing a second ranking model. Source: `scip-query code similarAll -C 8`.
- Reuse `getCommitHistory()` and the existing `CoChangePair` shape for focused co-change generation. Source: `scip-query code getCommitHistory -C 8`; `scip-query code 'src/analysis/git-history.ts:1-120'`.
- Reuse existing co-change classification and structural-link code in `diff-gate`; only the pair source should change. Source: `scip-query code runCoChangePartnerCheck -C 8`.

## Implementation Checklist

1. Add targeted candidate pruning in `src/queries/cleanup/similar.ts:83-109`.
   - Source: `scip-query code compareAgainstFingerprints -C 8`.
   - Change: build candidate indexes from the cached fingerprint corpus and compare only candidates sharing a non-ubiquitous callee with the target; keep a fallback to the full corpus if the target only shares ubiquitous callees.

2. Add a focused co-change helper in `src/analysis/git-history.ts:287-376`.
   - Source: `scip-query code getCoChangePairs -C 8`.
   - Change: export a `getCoChangePairsForFiles()` helper that counts all file churn but only creates pair contexts where at least one side is in the changed-file set.

3. Switch `runCoChangePartnerCheck()` in `src/queries/impact/diff-gate.ts:511-595` to the focused helper.
   - Source: `scip-query code runCoChangePartnerCheck -C 8`.
   - Change: pass the changed set to the focused helper and leave classification, suppression, and messaging unchanged.

4. Skip echo and new-dead checks for symbols whose leaf already existed at the base revision.
   - Source: `scip-query code runEchoCheck -C 15`; `scip-query code runNewDeadCheck -C 8`; `scip-query code movedSymbolPreexistenceChecker -C 8`.
   - Change: generalize the moved-symbol preexistence check to same-path files too, so these “new code” gates do not scan every edited existing symbol.

5. Add focused tests.
   - Source: `rg --files tests | rg '(similar|git-history|co-change|diff-gate)'`.
   - Change: extend `tests/queries/cleanup/similar-topk.test.ts` and `tests/analysis/git-history.test.ts` to lock the pruning and focused co-change behavior.

6. Verify.
   - Run targeted tests, `npm run typecheck`, `npm run build`, `scip-query reindex`, and the Vega timing loop.

## Result

Vega 2.0 timing with the patched local CLI:

- Full `diff-gate --json`: 21.8s -> 10.5s.
- `echo` only: 11.2s -> 0.39s.
- `co-change-partner` only: 9.5s -> 0.9s.
