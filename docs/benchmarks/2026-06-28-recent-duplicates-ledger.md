# recent-duplicates --full Optimization Ledger

## Output Contract

- Target command: `scip-query recent-duplicates --json --full`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Required behavior: preserve the JSON envelope and ranked duplicate findings,
  including recent/established side selection, similarity evidence, file/line
  metadata, and recommendation semantics.

## Measurements

| Case                                                                 |                                                                           Before |         After |              Delta | Evidence                                                                                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------: | ------------: | -----------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vega_2.0 latest warm `recent-duplicates --json --full`               |                                                                           6.439s | 4.896s median |   -1.543s / -24.0% | Three post-change warm repeats: 4.924s, 4.896s, 4.896s; stdout 3,618 bytes.                                                                                                       |
| Vega_2.0 output hash                                                 | 3,618 bytes / `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b` |          same |          unchanged | `node -e` hash check around `scip-query recent-duplicates --json --full`.                                                                                                         |
| Vega_2.0 component timing `similar --json --full`                    |                                                                           1.504s |       pending |            pending | Callable candidate component.                                                                                                                                                     |
| Vega_2.0 component timing `react-component-duplicates --json --full` |                                                                           3.203s |        3.204s |  no standalone win | Cache helps aggregate commands that call multiple React detectors in one process.                                                                                                 |
| Vega_2.0 component timing `react-hook-candidates --json --full`      |                                                                           2.574s |        2.581s |  no standalone win | Cache helps aggregate commands that call multiple React detectors in one process.                                                                                                 |
| Vega_2.0 component timing `vue-component-duplicates --json --full`   |                                                                           0.199s |       pending |            pending | Vue structure candidate component; negligible on Vega.                                                                                                                            |
| Vega_2.0 component timing `vue-composable-candidates --json --full`  |                                                                           0.197s |       pending |            pending | Vue behavior candidate component; negligible on Vega.                                                                                                                             |
| Vega_2.0 set-kernel smaller-set iteration trial                      |                                                                    4.897s-5.174s | 5.269s median |             slower | Output hash stayed unchanged, but repeats were 5.970s, 5.269s, 4.956s; reverted.                                                                                                  |
| Vega_2.0 stable evidence cache version after `0.10.9` bump           |                                                       multi-minute semantic miss |        5.287s | restores warm path | Existing `0.10.8` semantic callee rows reused by content/digest-compatible reads; stdout 3,618 bytes; SHA-256 `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b`. |

## Current Pipeline

- `recentDuplicates()` loads recent-file add records with
  `getFileAddRecords()`, collects duplicate candidates, then orients each pair
  as an echo or twin using file age. Source: `scip-query code recentDuplicates
-C 12`.
- `collectRecentDuplicateCandidates()` runs callable similarity first, then
  React structure/behavior detectors when React files are applicable, then Vue
  structure/behavior detectors when Vue files are applicable. Source:
  `scip-query code collectRecentDuplicateCandidates -C 10`.
- `callableDuplicateCandidates()` delegates to `similarAll()` with
  `crossFileOnly: true`. Source: `scip-query code callableDuplicateCandidates
-C 10`.
- `frontendDuplicateCandidates()` delegates to each frontend detector, filters
  same-file pairs, then maps frontend result fields into
  `RecentDuplicateCandidate`. Source: `scip-query code
frontendDuplicateCandidates -C 12`.
- `reactComponentDuplicates()` and `reactHookCandidates()` both build React
  behavior profiles with `buildReactComponentBehaviorProfiles()`. Source:
  `scip-query code reactComponentDuplicates -C 10` and `scip-query code
reactHookCandidates -C 10`.
- `buildReactComponentBehaviorProfiles()` scans React source files and filters
  assembled per-file profiles by JSX or behavior token thresholds. Source:
  `scip-query code buildReactComponentBehaviorProfiles -C 12`.

## Current-Pipeline Optimization Candidates

- Accepted: cache raw per-file React behavior profiles in
  `src/source/react-profile.ts` with the existing source-file cache primitive,
  then clone mutable `Set`/array fields before returning them.
- Use the recent-file add records earlier. Today the command computes all top
  duplicate candidates and only afterwards drops pairs where both files are
  established. This remains deferred because changing candidate pruning before
  per-detector limits can alter which findings surface.
- For React-heavy repos, target the shared pairwise frontend helper so the
  expensive structure/behavior comparisons can skip pairs where neither side is
  recent, while preserving the exact recent-duplicate output contract. This is
  deferred until the result-contract question is resolved.
- Rejected: making `intersection()` and `jaccard()` iterate the smaller set.
  The math stayed equivalent, but the Vega `recent-duplicates --json --full`
  workload got slower in repeated runs, so the code/test edit was reverted and
  kept only as a documented negative result.

## Alternative Designs

- Add pair-level filtering to the shared pairwise detector helper and expose it
  only through internal recent-duplicate adapters.
- Add a recent-file-aware candidate stage for `similarAll()` that keeps exact
  scoring but does not build result objects for old-old pairs.

## Decisions

- Accepted: React per-file profile caching. It reuses the existing
  `createSourceFileCache()` design already used by Vue profile builders, caches
  only raw per-file profiles keyed by source text, and leaves `scope`,
  `scanLimit`, `minJsxTokens`, and `minBehaviorTokens` outside the cache. The
  Vega output hash stayed identical while warm runtime dropped from 6.439s to a
  4.896s median.
- Rejected: smaller-set iteration in the shared set kernel. Identical output
  hash, no real workload win.
- Accepted: stable evidence-cache versioning with compatible legacy reads. This
  avoids turning `recent-duplicates --full` into a cold semantic rebuild after a
  package patch bump while keeping the same output hash.
- Deferred: pair-level recent-file pruning in pairwise detectors. It may be a
  larger win, but must prove it does not change the command's ranked output
  contract unless the contract is explicitly widened.

## Verification

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npx eslint src/source/react-profile.ts`: passed.
- `npx prettier --check src/source/react-profile.ts docs/plans/2026-06-28-recent-duplicates-profile-cache.md`:
  passed.
- `npm test -- tests/queries/frontend/frontend-recent-duplicates.test.ts tests/queries/frontend/react-frontend-rich-internals.test.ts tests/queries/cleanup/recent-duplicates-pruning.test.ts`:
  3 files / 4 tests passed.
- `npm test`: 76 files / 416 tests passed.
- `scip-query diff-impact --json`: changed source blast radius matches the
  profile-cache and previously accepted similarity changes.
- `scip-query diff-gate --json`: passed with zero findings after structured
  suppression `SQ58DA50428777`, an accepted cache-declaration echo matching the
  existing Vue source-file cache pattern.
