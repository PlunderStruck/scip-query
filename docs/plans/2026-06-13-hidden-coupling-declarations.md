# Hidden Coupling Declarations

## Finding Judgment

Hidden coupling is a repeated maintenance relationship between files where the code graph does not show why the files must move together. In this repo the findings are legitimate as history evidence, but most of the top findings are same-family query analyzers rather than separate architecture bugs. The repair is to let projects declare intentional co-change families so the detector keeps surfacing accidental cross-family drift.

Source: `scip-query co-change --min-together 6 --json` reported 30 top pairs, dominated by cleanup detector files such as `src/queries/stale-abstractions.ts` and `src/queries/wrapper-candidates.ts`, graph summary files such as `src/queries/bottlenecks.ts` and `src/queries/hotspots.ts`, and navigation files such as `src/queries/refs.ts` and `src/queries/trace.ts`.

## Implementation Checklist

- [x] Add a typed declared-coupling config shape.
  - In `src/domain/config-types.ts:69-84`, `ScipQueryConfig` currently carries `entryRoots`, `gitignorePaths`, `semantic`, and `suppressions`; add `declaredCouplings?: DeclaredCouplingConfig[]`.
  - In `src/domain/config-types.ts:88-103`, `ProjectConfig` currently carries project-owned settings; add the same field so `.scipquery.json` can declare intentional maintenance groups.
  - Add `DeclaredCouplingConfig` beside `FindingSuppression` with `name`, `files`, and optional `reason`, where `files` is a list of exact relative file paths.
  - Source: `scip-query code 'src/domain/config-types.ts:1-220'` and `scip-query change-surface src/domain/config-types.ts --json`.

- [x] Load and validate declared couplings.
  - In `src/runtime/cli-context.ts:39-46`, `openDb()` copies selected project config fields into `ScipQueryConfig`; copy `declaredCouplings` too.
  - In `src/runtime/config.ts:63-102`, `validateProjectConfig()` validates languages, watch numbers, and suppressions; add errors for a blank coupling `name`, groups with fewer than two files, blank file paths, and a blank `reason` when present.
  - Source: `scip-query code 'src/runtime/cli-context.ts:31-50'`, `scip-query code 'src/runtime/config.ts:1-260'`, and `scip-query change-surface src/runtime/config.ts --json`.

- [x] Teach `co-change` that declared groups are structural links.
  - In `src/queries/co-change.ts:17-18`, update the `structurallyLinked` comment so it covers dependency edges and declared config groups.
  - In `src/queries/co-change.ts:79-81`, replace direct dependency-only classification with a helper that returns true when a dependency edge exists or when both files are members of the same declared group.
  - Keep `partnersMode` behavior unchanged: file-specific exploration still includes linked pairs, but global health/co-change excludes linked pairs unless `includeLinked` is set.
  - Source: `scip-query code 'src/queries/co-change.ts:1-120'`, `scip-query refs coChange --json`, and `scip-query plan-context src/queries/co-change.ts --json`.

- [x] Add regression tests.
  - In `tests/runtime-config.test.ts`, extend config validation coverage for malformed declared coupling entries.
  - In `tests/git-history.test.ts`, add a `coChange()` regression using the existing temporary git repo: without config the `a.ts`/`b.ts` pair is reported, with `declaredCouplings` it is omitted globally, and with a file argument it is still visible as `structurallyLinked: true`.
  - Source: `rg --files -g '*test*' -g '*spec*'` identified existing test files; `tests/git-history.test.ts` already creates a real git repo and `tests/runtime-config.test.ts` already tests config validation.

- [x] Declare this repo's intentional co-change families.
  - Add `.scipquery.json` with `declaredCouplings` only, so language detection and cache behavior stay unchanged.
  - Declare the cleanup detector family, graph summary family, navigation reference family, and build surface family. Leave unrelated pairs outside those groups so the detector can still report real drift.
  - Source: `scip-query co-change --min-together 6 --json` for the family clusters and `ls -la` showing no existing `.scipquery.json`.

- [x] Document the config option.
  - In `README.md`, add a short `.scipquery.json` example under configuration that explains declared coupling groups.
  - In `docs/COMMAND_REFERENCE.md`, update `config-validate` wording so users know declared coupling declarations are validated.
  - Source: `rg -n "suppressions|entryRoots|scipquery|\\.scipquery" README.md docs src tests package.json`.

- [x] Verify the result.
  - Run targeted tests: `npm test -- tests/git-history.test.ts tests/runtime-config.test.ts`.
  - Build: `npm run build`.
  - Reindex and gate: `node dist/cli.js reindex && node dist/cli.js diff-gate`.
  - Confirm hidden coupling count/health: `node dist/cli.js health --json`.
