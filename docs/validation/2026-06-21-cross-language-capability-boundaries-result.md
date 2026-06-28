# Cross-Language Capability Boundaries Result

Date: 2026-06-21

## Verdict

AVL-010 is complete for the current corpus. Rust support is real for graph-backed indexing, source fallback, cleanup detectors, git/diff context, and compiler cleanup verification. Rust support does not include a semantic oracle equivalent to the TypeScript provider, and frontend-specific React/Vue analyzers correctly mean "no matching frontend evidence in this Rust project" when they return empty arrays.

The review found one output-quality bug: `similar` labeled uncategorized Rust callee overlap as `framework-scaffolding` with no reasons. That was not an honest language boundary. The fix adds `structural-overlap`, a neutral similarity evidence class for shared call/source structure that has no recognized domain, access/query, or framework category.

## Corpus

- Repository: `/Users/aydansalois/Documents/GitHub/SynthRunnerRust`
- Revision: `658a52d355e8733d6ce759e77b84735a47ef3048`
- Working tree during review: existing user changes in `src/app.rs` and `src/world_visuals.rs`; this validation read and analyzed the current tree but did not modify it.
- scip-query CLI: `/Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js`, package version `0.10.1`

## Capability Boundary

`status --json` and `capability-matrix --json` reported:

- language: `rust`
- indexing: available through runnable `rust-analyzer`
- source facts: available as Rust source fallback
- semantic provider: unavailable, with explicit reason `No semantic provider is registered for rust; commands use graph and source evidence instead.`
- cleanup verification: available through `cargo check --quiet --manifest-path Cargo.toml`
- diff gate: available through git diff data

This is the right contract. A capability boundary is a line between evidence the tool can actually collect and evidence it cannot collect in the current project. Its practical role is to stop users and agents from interpreting missing TypeScript-only evidence as either success or failure.

## Analyzer Smoke Results

Supported Rust graph/source analyzers:

- `health --full --json`: score 81, risk 81, hygiene 94; reported 2 dead-code findings, 7 real cycles, 3 similar pairs, 2 extraction candidates, 45 wrapper candidates, 2 passthrough candidates, and 1 stale type.
- `dead --only-dead --json`: `counts.deadCode = 2`, `counts.fileInternal = 312`, `shown.deadCode = 2`. Direct Rust findings were `visualizer:reset_visualizer_bars()` and `physics:is_kinematic_sensor()`.
- `cleanup-plan --json`: built one cleanup batch from the two dead-code rows, total 9 LOC.
- `wrapper-candidates --json`: emitted Rust candidates with boundary evidence and `actionTier: signal`.
- `extract-candidates --json`: emitted two Rust `workflow-orchestration` signal rows.
- `unused-params --json`: returned no rows.

Unsupported or stack-specific boundaries:

- `self-audit --samples 40 --json`: returned `{ "available": false, "oracleCoverage": 0 }`, which is correct because the semantic oracle is TypeScript-only.
- `react-hook-candidates --json`: returned `[]`, which is a stack-specific empty result, not a Rust support failure.
- `vue-composable-candidates --json`: returned `[]`, also a stack-specific empty result.

## Precision Fix

Before the fix, `similar --json --limit 5` on SynthRunnerRust returned three Rust gameplay/function pairs with:

- `evidenceClass: "framework-scaffolding"`
- `evidenceClassReasons: []`

After the fix, the same rows return:

- `evidenceClass: "structural-overlap"`
- `actionTier: "signal"`
- `evidenceClassReasons: ["shared callees overlap has no recognized domain or scaffolding category"]`

Examples:

- `app:spawn_segment_contents_pooled()` versus `app:spawn_segment_contents_via_sensor_pool()`
- `app:collect_ring_from_fixed_step()` versus `physics:dispatch_player_ring_pickup()`
- `effects:particle_batch_mesh()` versus `effects:particle_batch_mesh_with_capacity()`

The correction changes the explanation, not the similarity score. The analyzer still reports a contextual reuse lead, but it no longer pretends the evidence is framework scaffolding.

## Code Changes

- `src/queries/cleanup/similar.ts`: adds `structural-overlap` to `SimilarEvidenceClass`, uses it only when no recognized domain/access/framework/generic-source category matched, and adds a tailored recommendation.
- `tests/queries/cleanup/similar-topk.test.ts`: adds a Rust-shaped callee-overlap regression test.
- `docs/plans/2026-06-21-cross-language-capability-boundaries.md`: records the implementation plan and verification route.

2026-06-28 follow-up: `src/queries/cleanup/similar.ts` now reuses the cached callee-fingerprint candidate index and cached weighted magnitudes for performance, and its new focus-file pruning option is only used by `recent-duplicates --full`. The `structural-overlap` classification contract above is unchanged: uncategorized shared call/source structure remains a neutral signal rather than framework scaffolding.

## Verification

Completed:

- `npx vitest run tests/queries/cleanup/similar-topk.test.ts`
- `npm run typecheck`
- `npm run build`
- In SynthRunnerRust:
  - `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js status --json`
  - `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js capability-matrix --json`
  - `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js similar --json --limit 5`
  - `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js self-audit --samples 40 --json`
  - `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js react-hook-candidates --json`
  - `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js vue-composable-candidates --json`
  - `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js dead --only-dead --json`

Standard gates completed after the Rust smoke checks:

- `npm test` passed: 64 files, 322 tests.
- `./dist/cli.js recent-duplicates --json` returned no findings.
- `./dist/cli.js unused-params --json` returned no findings.
- `./dist/cli.js reindex` completed successfully.
- `./dist/cli.js status --json` reported a fresh index.
- `./dist/cli.js diff-gate` reported two known accepted warnings:
  - `echo`: `isCompileTimeContractAssertion()` is similar to `indexedDefinitionFromRow()`. Accepted because both parse symbol leaf/suffix shape, but one detects compile-time contract assertions while the other builds indexed definition rows.
  - `doc-reference`: `README.md` cites changed cleanup files as a configuration example. Accepted because the cited example target remains intentional.

## Next Slice

The next validation slice should be AVL-014, public command surface coverage. It will compare the command registry with the inventory, protocol, and ledger so no public analyzer is being silently omitted from the validation program.

## 2026-06-28 Similar Target Follow-Up

The `similar.ts` capability-boundary notes remain accurate. The follow-up only
short-circuits non-function-like targets before callee evidence setup; source
token fallback, structural-overlap classification, and cross-language evidence
boundaries are unchanged.

## 2026-06-28 Source-Fallback Scan-Limit Follow-Up

The capability-boundary notes remain accurate after bounded source-shape
fallback. The change only lets bounded callers pass their scan-limit budget
into the lexical source-fingerprint corpus; it does not change
`structural-overlap`, source-token evidence classification, or cross-language
support boundaries.

## 2026-06-28 Source-Fingerprint Cache Follow-Up

The capability-boundary notes remain accurate after persisting source-token
fingerprints. The cache stores the same lexical evidence behind content and
callable-range keys; it does not change `structural-overlap`, source-token
classification, or cross-language support boundaries.

## 2026-06-28 Zero-Callee Similarity Follow-Up

The capability-boundary notes remain accurate after the zero-callee targeted
similarity fast path. The change only avoids callee-index work when no callee
features exist and then runs the existing source-token fallback; it does not
change `structural-overlap`, source-token classification, or cross-language
support boundaries.

## 2026-06-28 Bench Profiling Follow-Up

The capability-boundary notes remain accurate after adding `similar.ts` profile
spans. The spans time callee-fingerprint and pair-scan phases when profiling is
enabled; they do not change `structural-overlap`, source-token classification,
or cross-language support boundaries.
