# Suppression Lifecycle Result

Date: 2026-06-21

Ledger item: AVL-009

## Verdict

Complete. Source suppressions in this repository are concentrated but justified by explicit local reasons, and structured suppressions now validate stale file-scoped entries.

A suppression is a maintainer's recorded acceptance of an analyzer finding. It is not proof that the code is clean; it is evidence that the detector needs human context at that location. The lifecycle obligation is to keep the recorded acceptance tied to a real file, a real detector, a real reason, and, for temporary structured suppressions, a live expiration date.

## Source Suppression Inventory

`node dist/cli.js health --full --json` reported 174 source suppressions:

| Category | Count | Judgment |
| --- | ---: | --- |
| `extract` | 72 | Mostly pipeline and parser routines where splitting would hide shared state or traversal context. |
| `wrapper` | 62 | Mostly public facades, cache boundaries, and evidence projection helpers. |
| `stale` | 17 | Mostly exported contracts whose consumers are structural or external to the local count. |
| `similar` | 15 | Mostly language-specific parser branches or deliberately mirrored cache/doc workflows. |
| `passthrough` | 8 | Mostly stable facade methods or tiny policy names that hide lower-level ownership. |
| `dead`, `drift`, `uncategorized` | 0 | No active source suppressions in these categories. |

A production-regex scan of `src` matched the same 174 directive comments. All 174 had reason text. The top concentration points were:

| File | Count | Interpretation |
| --- | ---: | --- |
| `src/reindex/vue/augment-vue-runtime.ts` | 14 | Vue augmentation contains adapter, mapper, and transaction boundaries that heuristics see as wrappers/extraction opportunities. |
| `src/queries/internal/reference-counts.ts` | 7 | Shared reference evidence mutation/projection helpers are intentionally named. |
| `src/symbols/graph/call-graph-evidence.ts` | 6 | Caller/callee evidence assembly keeps fallback stages explicit. |
| `src/core/project-index.ts` | 5 | The stable facade intentionally hides lower-level services from query modules. |
| `src/resolution/import-path-resolver.ts` | 5 | Path-resolution policies are named because language/package rules differ. |
| `src/semantic/typescript/ts-morph-provider.ts` | 5 | Semantic-provider bootstrap and export walking are stateful analyzer phases. |

Git blame over the suppression lines found the oldest current directives on 2026-05-04 and the newest on 2026-06-20. That does not prove every comment is eternally valid, but it does show the current set is recent enough to treat as deliberate calibration feedback rather than abandoned ignore dust.

## Sample Review

Reviewed source examples:

| Category | Location | Verdict | Reason |
| --- | --- | --- | --- |
| `wrapper` | `src/language-parsers/registry.ts:110` | accepted design | Public parser registry facade hides registry storage and selection details. |
| `wrapper` | `src/resolution/import-path-resolver.ts:94` | accepted design | Names the extension-family concept used across path resolution. |
| `wrapper` | `src/queries/internal/reference-counts.ts:68` | accepted design | Keeps count mutation and provenance paired. |
| `extract` | `src/queries/navigation/by-kind.ts:130` | accepted design | The detected cluster is the tail of one filter pipeline, not an independent concept. |
| `extract` | `src/analysis/framework-patterns.ts:224` | accepted design | Rust dead-code exclusions are one accuracy contract spanning generated files, AST exclusions, suppression comments, and serde modules. |
| `extract` | `src/queries/cleanup/similar.ts:351` | accepted design | Calee-set fingerprinting is one evidence pass whose options interact. |
| `stale` | `src/source/gitignore-filter.ts:45` | accepted design | `PathFilter` is the canonical shape passed through `ScipDatabase`, even when local type consumers are low. |
| `stale` | `src/source/vue/vue-template.ts:47` | accepted design | Vue template facts are a public analyzer envelope consumed by profile/reporting layers. |
| `similar` | `src/language-parsers/languages/dotnet.ts:61` | accepted design | Per-language AST walkers share shape but differ in node and alias semantics. |
| `similar` | `src/storage/per-db-cache.ts:132` | accepted design | The mirrored cache factory differs by source-equality contract; merging would hide the distinction. |
| `passthrough` | `src/core/project-index.ts:111` | accepted design | The facade keeps query modules on `ProjectIndex` instead of importing lower-level classifiers. |
| `passthrough` | `src/reindex/vue/augment-vue-runtime.ts:612` | accepted design | The function owns Vue lexical token filtering; the `Set.has` body is incidental. |

No sampled source suppression looked expired or unjustified. The sample does not prove every one of 174 comments is perfect, but it supports the current trust judgment: these comments are precision feedback for broad candidate detectors, especially `extract` and `wrapper`, rather than direct cleanup tasks.

## Structured Suppression Checks

`.scipquery.json` currently has zero structured suppressions, so there were no current entries to repair.

The code now protects future structured suppressions:

- A blank `suppressions[n].file` is an error.
- A nonblank `suppressions[n].file` that does not exist under `projectRoot` is a warning.
- `addFindingSuppression()` uses root-aware config validation before writing.
- Existing expiration behavior remains: expired structured suppressions warn during config validation and do not match diff-gate findings.

## Verification

Completed checks so far:

```text
npx vitest run tests/runtime/runtime-config.test.ts
node dist/cli.js config-validate --json
node dist/cli.js health --full --json
npm run typecheck
npm run build
npm test
node dist/cli.js recent-duplicates --json
node dist/cli.js unused-params --json
node dist/cli.js reindex
node dist/cli.js diff-gate --json
```

Repository verification passed. The full test suite reported 64 passing test files and 320 passing tests. `recent-duplicates` returned no findings. `unused-params` returned an empty result. Reindexing completed successfully.

`diff-gate` still reports the two accepted warnings already tracked in this validation pass:

- `SQ36D93309ABEA`, `echo`: changed `isCompileTimeContractAssertion()` shares symbol parsing helpers with established `indexedDefinitionFromRow()`, but the semantics are different.
- `SQ30E6CF5F9B38`, `doc-reference`: README configuration examples cite changed cleanup query files; the example target remains intentional.

## Calibration Judgment

Suppression inventory should remain a meta signal, not direct debt. A high count in one detector family means the detector has known false-positive or accepted-design pressure and should receive lower score weight until field validation improves. For this repo, the strongest trust penalty remains on `extract` and `wrapper`, because they account for 134 of 174 source suppressions.

No codebase repair is recommended from the sampled source comments. The programmatic precision action is complete for structured suppression lifecycle: stale file-scoped entries now surface through `config-validate`.

## 2026-06-27 Performance Pass Reference Check

The `src/queries/navigation/by-kind.ts` suppression example remains valid after the `kind-counts` SQL fast path. The accepted suppression still describes the `byKind` filter pipeline near the cited area; this pass changed the histogram implementation without changing that suppression example's target or reason.
